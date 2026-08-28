import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AskProviderId,
  AskProviderStatusDto,
} from "@ai-sdlc/contracts";

import { AppError } from "../src/domain/errors.ts";
import {
  ProviderNativeAgentRuntime,
} from "../src/services/agent/provider-native-agent-runtime.ts";
import {
  RootedAgentToolHost,
  type AgentSandboxCheckRunner,
} from "../src/services/agent/rooted-agent-tool-host.ts";
import type {
  AskLlmCompleteRequest,
  AskLlmCompleteResponse,
} from "../src/services/llm/types.ts";

class FakeProviderPort {
  readonly requests: Array<{ providerId: AskProviderId; request: AskLlmCompleteRequest }> = [];

  constructor(
    private readonly responses: AskLlmCompleteResponse[],
    private readonly toolCalling = true,
  ) {}

  runWithProvider<T>(_providerId: AskProviderId, operation: () => T): T {
    return operation();
  }

  status(providerId: AskProviderId): AskProviderStatusDto {
    return {
      id: providerId,
      label: providerId,
      configured: true,
      model: "selected-model",
      protocol: providerId === "ollama" ? "ollama-chat" : "openai-chat",
      dataBoundary: providerId === "ollama" ? "local" : "operator-configured",
      endpointLabel: "configured endpoint",
      capabilities: {
        streaming: false,
        structuredOutput: false,
        toolCalling: this.toolCalling,
      },
      message: "ready",
    };
  }

  async complete(
    providerId: AskProviderId,
    request: AskLlmCompleteRequest,
  ): Promise<AskLlmCompleteResponse> {
    this.requests.push({ providerId, request });
    const response = this.responses.shift();
    if (!response) throw new Error("Fake provider response exhausted");
    return response;
  }
}

test("CHAT-AC-06/07/09: the selected Provider drives a bounded native tool loop and records the actual model", async () => {
  const fixture = await workspaceFixture();
  try {
    await writeFile(path.join(fixture.root, "message.txt"), "hello old\n", "utf8");
    const providers = new FakeProviderPort([
      toolResponse("ollama-call", "apply_patch", {
        path: "message.txt",
        oldText: "hello old",
        newText: "hello provider-native",
        replaceAll: false,
      }),
      finalResponse("修改完成，已按工具结果核对。"),
    ]);
    const runtime = new ProviderNativeAgentRuntime(providers);
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
    });

    const result = await runtime.run({
      providerId: "ollama",
      instruction: "只修改用户点名的文件，然后用白话说明。",
      messages: [{ role: "user", content: "请更新 message.txt" }],
      toolHost: host,
      limits: { maxToolCalls: 2 },
    });

    assert.equal(result.providerId, "ollama");
    assert.equal(result.model, "selected-model");
    assert.equal(result.modelCalls, 2);
    assert.equal(result.toolSteps[0]?.toolName, "apply_patch");
    assert.equal(result.toolSteps[0]?.status, "completed");
    assert.match(await readFile(path.join(fixture.root, "message.txt"), "utf8"), /provider-native/u);
    assert.deepEqual(providers.requests.map(({ providerId }) => providerId), ["ollama", "ollama"]);
    assert.equal(providers.requests[0]?.request.toolChoice, "auto");
    assert.ok(providers.requests[0]?.request.tools?.some(({ name }) => name === "apply_patch"));
    assert.match(
      providers.requests[1]?.request.messages.at(-1)?.content ?? "",
      /"platformToolResult":true/u,
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-04/19: traversal, symlinks, sensitive files and read-only writes fail closed", async (t) => {
  await t.test("parent traversal cannot modify an outside file", async () => {
    const fixture = await workspaceFixture();
    try {
      const outside = path.join(
        path.dirname(fixture.root),
        `${path.basename(fixture.root)}-outside.txt`,
      );
      await writeFile(outside, "unchanged", "utf8");
      const providers = new FakeProviderPort([
        toolResponse("bad-write", "write_file", {
          path: "../outside.txt",
          content: "changed",
          overwrite: true,
        }),
        finalResponse("平台拒绝了越界路径，没有修改。"),
      ]);
      const runtime = new ProviderNativeAgentRuntime(providers);
      const host = await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
      });
      const result = await runtime.run({
        providerId: "custom",
        instruction: "完成用户任务。",
        messages: [{ role: "user", content: "修改文件" }],
        toolHost: host,
      });
      assert.equal(result.toolSteps[0]?.status, "failed");
      assert.equal(await readFile(outside, "utf8"), "unchanged");
      await rm(outside);
    } finally {
      await fixture.dispose();
    }
  });

  await t.test("a repository symlink is never followed", async () => {
    const fixture = await workspaceFixture();
    try {
      const outside = path.join(
        path.dirname(fixture.root),
        `${path.basename(fixture.root)}-symlink-target.txt`,
      );
      await writeFile(outside, "outside secret-ish data", "utf8");
      await symlink(outside, path.join(fixture.root, "linked.txt"));
      const providers = new FakeProviderPort([
        toolResponse("bad-read", "read_file", {
          path: "linked.txt",
          startLine: 1,
          endLine: 10,
        }),
        finalResponse("符号链接被拒绝。"),
      ]);
      const runtime = new ProviderNativeAgentRuntime(providers);
      const host = await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
      });
      const result = await runtime.run({
        providerId: "openai",
        instruction: "读取文件。",
        messages: [{ role: "user", content: "读取 linked.txt" }],
        toolHost: host,
      });
      assert.equal(result.toolSteps[0]?.status, "failed");
      assert.doesNotMatch(
        providers.requests[1]?.request.messages.at(-1)?.content ?? "",
        /outside secret-ish data/u,
      );
      await rm(outside);
    } finally {
      await fixture.dispose();
    }
  });

  await t.test("sensitive paths and writes to a read-only @repo stay unavailable", async () => {
    const fixture = await workspaceFixture();
    try {
      await writeFile(path.join(fixture.root, ".env"), "TOKEN=do-not-send", "utf8");
      const providers = new FakeProviderPort([
        toolResponse("secret-read", "read_file", {
          path: ".env",
          startLine: 1,
          endLine: 2,
        }),
        toolResponse("read-only-write", "write_file", {
          path: "new.txt",
          content: "should not exist",
          overwrite: false,
        }),
        finalResponse("敏感读取和只读写入均被拒绝。"),
      ]);
      const runtime = new ProviderNativeAgentRuntime(providers);
      const host = await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "read-only",
      });
      assert.equal(host.definitions().some(({ name }) => name === "write_file"), false);
      const result = await runtime.run({
        providerId: "openai",
        instruction: "只使用获准工具。",
        messages: [{ role: "user", content: "检查仓库" }],
        toolHost: host,
      });
      assert.deepEqual(result.toolSteps.map(({ status }) => status), ["failed", "failed"]);
      await assert.rejects(readFile(path.join(fixture.root, "new.txt"), "utf8"));
      assert.doesNotMatch(
        providers.requests.map(({ request }) => request.messages.at(-1)?.content ?? "").join("\n"),
        /do-not-send/u,
      );
    } finally {
      await fixture.dispose();
    }
  });
});

test("CHAT-AC-10/20: commands are exposed only by an injected container runner; no host shell fallback exists", async () => {
  const fixture = await workspaceFixture();
  try {
    const withoutRunner = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
    });
    assert.equal(withoutRunner.definitions().some(({ name }) => name === "run_check"), false);

    const executed: string[] = [];
    const runner: AgentSandboxCheckRunner = {
      isolation: "container",
      definitions: () => [{ id: "unit", label: "Unit tests", timeoutMs: 30_000 }],
      run: async ({ checkId, workspaceRoot }) => {
        executed.push(`${checkId}:${workspaceRoot}`);
        return { exitCode: 0, output: "12 tests passed", durationMs: 25 };
      },
    };
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      checkRunner: runner,
    });
    const providers = new FakeProviderPort([
      toolResponse("check", "run_check", { checkId: "unit" }),
      finalResponse("12 项测试通过。"),
    ]);
    const result = await new ProviderNativeAgentRuntime(providers).run({
      providerId: "lmstudio",
      instruction: "运行批准的测试。",
      messages: [{ role: "user", content: "请跑单测" }],
      toolHost: host,
    });
    assert.equal(result.toolSteps[0]?.status, "completed");
    assert.equal(executed.length, 1);
    assert.match(executed[0] ?? "", /^unit:/u);
    const checkTool = providers.requests[0]?.request.tools?.find(({ name }) => name === "run_check");
    assert.deepEqual(
      (checkTool?.parameters.properties as { checkId?: { enum?: string[] } }).checkId?.enum,
      ["unit"],
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-09: tool, time, output and secret limits stop unsafe turns", async (t) => {
  await t.test("a provider cannot keep calling tools after the finalization boundary", async () => {
    const fixture = await workspaceFixture();
    try {
      const providers = new FakeProviderPort([
        toolResponse("one", "list_files", { path: ".", maxDepth: 1, maxEntries: 10 }),
        toolResponse("two", "list_files", { path: ".", maxDepth: 1, maxEntries: 10 }),
      ]);
      const host = await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "read-only",
      });
      await assert.rejects(
        new ProviderNativeAgentRuntime(providers).run({
          providerId: "openai",
          instruction: "查看文件。",
          messages: [{ role: "user", content: "查看仓库" }],
          toolHost: host,
          limits: { maxToolCalls: 1 },
        }),
        (error: unknown) => error instanceof AppError
          && error.code === "AGENT_PROVIDER_IGNORED_TOOL_LIMIT",
      );
      assert.equal(providers.requests[1]?.request.toolChoice, "none");
    } finally {
      await fixture.dispose();
    }
  });

  await t.test("a likely live credential never reaches the selected provider", async () => {
    const fixture = await workspaceFixture();
    try {
      const providers = new FakeProviderPort([finalResponse("unused")]);
      const host = await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "read-only",
      });
      await assert.rejects(
        new ProviderNativeAgentRuntime(providers).run({
          providerId: "openai",
          instruction: "检查源码。",
          messages: [{
            role: "user",
            content: "请使用 sk-proj-1234567890abcdefghijkl 处理任务",
          }],
          toolHost: host,
        }),
        (error: unknown) => error instanceof AppError && error.code === "AGENT_SECRET_IN_PROMPT",
      );
      assert.equal(providers.requests.length, 0);
    } finally {
      await fixture.dispose();
    }
  });

  await t.test("a Provider without truthful tool capability cannot start work", async () => {
    const fixture = await workspaceFixture();
    try {
      const providers = new FakeProviderPort([finalResponse("unused")], false);
      const host = await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "read-only",
      });
      await assert.rejects(
        new ProviderNativeAgentRuntime(providers).run({
          providerId: "custom",
          instruction: "检查源码。",
          messages: [{ role: "user", content: "检查仓库" }],
          toolHost: host,
        }),
        (error: unknown) => error instanceof AppError
          && error.code === "AGENT_PROVIDER_TOOL_CALLING_UNAVAILABLE",
      );
      assert.equal(providers.requests.length, 0);
    } finally {
      await fixture.dispose();
    }
  });
});

function toolResponse(
  id: string,
  name: string,
  argumentsValue: Record<string, unknown>,
): AskLlmCompleteResponse {
  return {
    text: "",
    model: "selected-model",
    usage: { inputTokens: 10, outputTokens: 4 },
    toolCalls: [{ id, type: "function", name, arguments: argumentsValue }],
  };
}

function finalResponse(text: string): AskLlmCompleteResponse {
  return {
    text,
    model: "selected-model",
    usage: { inputTokens: 8, outputTokens: 3 },
  };
}

async function workspaceFixture(): Promise<{ root: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "provider-native-agent-"));
  return {
    root,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
