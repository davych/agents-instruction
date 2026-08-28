import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AskProviderId,
  AskProviderStatusDto,
} from "@ai-sdlc/contracts";

import { AppError } from "../src/domain/errors.ts";
import { ProviderNativeAgentRuntime } from "../src/services/agent/provider-native-agent-runtime.ts";
import {
  ProviderAgentToolError,
  RootedAgentToolHost,
  type AgentSandboxCheckRunner,
} from "../src/services/agent/rooted-agent-tool-host.ts";
import type {
  AskLlmCompleteRequest,
  AskLlmCompleteResponse,
  AskLlmToolCall,
} from "../src/services/llm/types.ts";

const executionOptions = {
  signal: new AbortController().signal,
  maxOutputCharacters: 48_000,
};

test("CHAT-AC-19: labelled Secret material cannot enter the Sandbox through write or patch tools", async () => {
  const fixture = await workspaceFixture();
  try {
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
    });
    await writeFile(path.join(fixture.root, "config.txt"), "mode=development\n", "utf8");

    await assert.rejects(
      host.execute(toolCall("write_file", {
        path: "new-config.txt",
        content: "password=correct-horse-battery-staple\n",
        overwrite: false,
      }), executionOptions),
      isToolError("AGENT_SECRET_WRITE_FORBIDDEN"),
    );
    await assert.rejects(readFile(path.join(fixture.root, "new-config.txt"), "utf8"));

    await assert.rejects(
      host.execute(toolCall("apply_patch", {
        path: "config.txt",
        oldText: "mode=development",
        newText: "api_key=abcdefghijklmnop123456",
        replaceAll: false,
      }), executionOptions),
      isToolError("AGENT_SECRET_WRITE_FORBIDDEN"),
    );
    assert.equal(
      await readFile(path.join(fixture.root, "config.txt"), "utf8"),
      "mode=development\n",
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-04/10: hard-linked files cannot carry write or patch effects outside the rooted workspace", async () => {
  const fixture = await workspaceFixture();
  try {
    const outside = path.join(fixture.parent, "outside.txt");
    const linked = path.join(fixture.root, "linked.txt");
    await writeFile(outside, "outside remains unchanged\n", "utf8");
    await link(outside, linked);
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
    });

    await assert.rejects(
      host.execute(toolCall("write_file", {
        path: "linked.txt",
        content: "overwritten through hard link\n",
        overwrite: true,
      }), executionOptions),
      isToolError("AGENT_PATH_KIND_INVALID"),
    );
    await assert.rejects(
      host.execute(toolCall("apply_patch", {
        path: "linked.txt",
        oldText: "outside remains unchanged",
        newText: "patched through hard link",
        replaceAll: false,
      }), executionOptions),
      isToolError("AGENT_PATH_KIND_INVALID"),
    );
    assert.equal(await readFile(outside, "utf8"), "outside remains unchanged\n");
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-09: runtime deadline wins even when the selected Provider ignores AbortSignal", async () => {
  const fixture = await workspaceFixture();
  const providers = new IgnoringAbortProviderPort();
  try {
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "read-only",
    });
    await assert.rejects(
      new ProviderNativeAgentRuntime(providers).run({
        providerId: "openai",
        instruction: "只读检查仓库并简要总结。",
        messages: [{ role: "user", content: "请检查仓库" }],
        toolHost: host,
        limits: { maxWallTimeMs: 1_000 },
      }),
      (error: unknown) => error instanceof AppError && error.code === "AGENT_RUNTIME_TIMEOUT",
    );
    assert.equal(providers.settled, false);
  } finally {
    providers.dispose();
    await fixture.dispose();
  }
});

test("CHAT-AC-04: a read-only @repo cannot expose or invoke a workspace-mutating check runner", async () => {
  const fixture = await workspaceFixture();
  let runnerInvoked = false;
  const runner: AgentSandboxCheckRunner = {
    isolation: "container",
    definitions: () => [{ id: "unit", label: "Unit tests", timeoutMs: 30_000 }],
    run: async () => {
      runnerInvoked = true;
      await writeFile(path.join(fixture.root, "runner-write.txt"), "mutated", "utf8");
      return { exitCode: 0, output: "passed", durationMs: 1 };
    },
  };
  try {
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "read-only",
      checkRunner: runner,
    });
    assert.equal(host.definitions().some(({ name }) => name === "run_check"), false);
    await assert.rejects(
      host.execute(toolCall("run_check", { checkId: "unit" }), executionOptions),
      isToolError("AGENT_WORKSPACE_READ_ONLY"),
    );
    assert.equal(runnerInvoked, false);
    await assert.rejects(readFile(path.join(fixture.root, "runner-write.txt"), "utf8"));
  } finally {
    await fixture.dispose();
  }
});

class IgnoringAbortProviderPort {
  settled = false;
  private timer: NodeJS.Timeout | undefined;

  status(providerId: AskProviderId): AskProviderStatusDto {
    return {
      id: providerId,
      label: providerId,
      configured: true,
      model: "selected-model",
      protocol: "openai-chat",
      dataBoundary: "operator-configured",
      endpointLabel: "configured endpoint",
      capabilities: {
        streaming: false,
        structuredOutput: false,
        toolCalling: true,
      },
      message: "ready",
    };
  }

  complete(
    _providerId: AskProviderId,
    _request: AskLlmCompleteRequest,
    _signal?: AbortSignal,
  ): Promise<AskLlmCompleteResponse> {
    return new Promise((resolve) => {
      this.timer = setTimeout(() => {
        this.settled = true;
        resolve({
          text: "late response must not be accepted",
          model: "selected-model",
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      }, 5_000);
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

function toolCall(name: string, argumentsValue: Record<string, unknown>): AskLlmToolCall {
  return {
    id: "adversarial-call",
    type: "function",
    name,
    arguments: argumentsValue,
  };
}

function isToolError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ProviderAgentToolError && error.code === code;
}

async function workspaceFixture(): Promise<{
  parent: string;
  root: string;
  dispose(): Promise<void>;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), "provider-native-agent-adversarial-"));
  const root = path.join(parent, "workspace");
  await mkdir(root);
  return {
    parent,
    root,
    dispose: () => rm(parent, { recursive: true, force: true }),
  };
}
