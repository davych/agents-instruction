import assert from "node:assert/strict";
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  containsLikelySecret,
  ProviderAgentToolError,
  redactLikelySecrets,
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
    private readonly structuredOutput = false,
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
        structuredOutput: this.structuredOutput,
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

test("a required named repair can use a strict structured action envelope after native tool retries", async () => {
  const fixture = await workspaceFixture();
  try {
    await writeFile(path.join(fixture.root, "message.txt"), "hello old\n", "utf8");
    const providers = new FakeProviderPort([
      toolResponse("inspect-root", "list_files", { path: ".", maxDepth: 1, maxEntries: 20 }),
      finalResponse("I am finished."),
      finalResponse("I will explain the patch first."),
      finalResponse("The patch should update the greeting."),
      finalResponse("No native function call was emitted."),
      finalResponse(JSON.stringify({
        arguments: {
          path: "message.txt",
          oldText: "hello old",
          newText: "hello structured fallback",
          replaceAll: false,
        },
      })),
      finalResponse("The validated action completed."),
    ], true, true);
    let fallbackCount = 0;
    const result = await new ProviderNativeAgentRuntime(providers).run({
      providerId: "lmstudio",
      instruction: "Inspect and update message.txt through the bounded tools.",
      messages: [{ role: "user", content: "Update the greeting." }],
      toolHost: await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
      }),
      limits: { maxToolCalls: 6, reservedFinalizationToolCalls: 2 },
      finalizationCheck: async () => (
        (await readFile(path.join(fixture.root, "message.txt"), "utf8")).includes("structured fallback")
          ? { ready: true }
          : {
              ready: false,
              feedback: "The implementation file is unchanged; read it and apply the required patch.",
              error: new AppError(
                "implementation source change required",
                422,
                "IMPLEMENTATION_SOURCE_CHANGE_REQUIRED",
              ),
              audit: {
                reasonCode: "IMPLEMENTATION_SOURCE_CHANGE_REQUIRED",
                affectedArtifactKeys: [],
                issueIds: ["IMPLEMENTATION_SOURCE_CHANGE_REQUIRED"],
              },
              repairToolName: "apply_patch",
            }
      ),
      observer: {
        structuredToolFallback: () => { fallbackCount += 1; },
      },
    });

    assert.equal(fallbackCount, 1);
    assert.equal(result.toolSteps.length, 2);
    assert.equal(result.toolSteps[1]?.toolName, "apply_patch");
    assert.match(await readFile(path.join(fixture.root, "message.txt"), "utf8"), /structured fallback/u);
    const fallbackRequest = providers.requests[5]?.request;
    assert.equal(fallbackRequest?.tools, undefined);
    assert.equal(fallbackRequest?.toolChoice, undefined);
    assert.deepEqual(fallbackRequest?.jsonSchema, {
      type: "object",
      additionalProperties: false,
      required: ["arguments"],
      properties: {
        arguments: providers.requests[4]?.request.tools?.find(({ name }) => name === "apply_patch")?.parameters,
      },
    });
  } finally {
    await fixture.dispose();
  }
});

test("a wrong named repair tool is discarded before the strict structured fallback executes", async () => {
  const fixture = await workspaceFixture();
  try {
    await writeFile(path.join(fixture.root, "message.txt"), "hello old\n", "utf8");
    const providers = new FakeProviderPort([
      toolResponse("inspect-root", "list_files", { path: ".", maxDepth: 1, maxEntries: 20 }),
      finalResponse("I am finished."),
      toolResponse("wrong-one", "list_files", { path: ".", maxDepth: 1, maxEntries: 20 }),
      toolResponse("wrong-two", "read_file", { path: "message.txt", startLine: 1, endLine: 10 }),
      toolResponse("wrong-three", "write_file", {
        path: "message.txt",
        content: "this wrong tool must never execute\n",
        overwrite: true,
      }),
      finalResponse(JSON.stringify({
        arguments: {
          path: "message.txt",
          oldText: "hello old",
          newText: "hello mismatch fallback",
          replaceAll: false,
        },
      })),
      finalResponse("The validated action completed."),
    ], true, true);
    const retries: Array<number> = [];
    let fallbackCount = 0;

    const result = await new ProviderNativeAgentRuntime(providers).run({
      providerId: "lmstudio",
      instruction: "Inspect and update message.txt through the bounded tools.",
      messages: [{ role: "user", content: "Update the greeting." }],
      toolHost: await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
      }),
      limits: { maxToolCalls: 6, reservedFinalizationToolCalls: 2 },
      finalizationCheck: async () => (
        (await readFile(path.join(fixture.root, "message.txt"), "utf8")).includes("mismatch fallback")
          ? { ready: true }
          : {
              ready: false,
              feedback: "The implementation file is unchanged; apply the required patch.",
              error: new AppError(
                "implementation source change required",
                422,
                "IMPLEMENTATION_SOURCE_CHANGE_REQUIRED",
              ),
              audit: {
                reasonCode: "IMPLEMENTATION_SOURCE_CHANGE_REQUIRED",
                affectedArtifactKeys: [],
                issueIds: ["IMPLEMENTATION_SOURCE_CHANGE_REQUIRED"],
              },
              repairToolName: "apply_patch",
            }
      ),
      observer: {
        requiredToolRetry: ({ attempt }) => { retries.push(attempt); },
        structuredToolFallback: () => { fallbackCount += 1; },
      },
    });

    assert.deepEqual(retries, [1, 2]);
    assert.equal(fallbackCount, 1);
    assert.deepEqual(result.toolSteps.map(({ toolName }) => toolName), ["list_files", "apply_patch"]);
    assert.equal(await readFile(path.join(fixture.root, "message.txt"), "utf8"), "hello mismatch fallback\n");
    assert.equal(providers.requests[5]?.request.toolChoice, undefined);
    assert.equal(providers.requests[5]?.request.tools, undefined);
    assert.ok(
      providers.requests[3]?.request.messages.some(({ content }) => /错误的工具/u.test(content)),
      "the bounded retry must explain that the wrong tool was not executed",
    );
  } finally {
    await fixture.dispose();
  }
});

test("the structured engineering evidence tool writes all seven bound artifacts in one call", async () => {
  const fixture = await workspaceFixture();
  try {
    const root = "docs/ai-native/engineering";
    const target = {
      implementationNotesPath: `${root}/notes.md`,
      implementationPlanPath: `${root}/plan.md`,
      implementationTasksPath: `${root}/tasks.md`,
      sessionLogPath: `${root}/session.md`,
      independentTestEvidencePath: `${root}/tests.md`,
      reviewPath: `${root}/review.md`,
      provenancePath: `${root}/provenance.md`,
    };
    const selectedPaths = Object.values(target);
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      protectedWritePaths: ["docs/ai-native"],
      protectedWriteExceptionPaths: selectedPaths,
      structuredEngineeringEvidenceTarget: target,
    });
    assert.ok(host.definitions().some(({ name }) => name === "write_engineering_evidence_pack"));

    const contents = {
      implementationNotes: "# Implementation Notes\n\nSubstantive notes.\n",
      implementationPlan: "# Implementation Plan\n\nSubstantive plan.\n",
      implementationTasks: "# Implementation Tasks\n\nSubstantive tasks.\n",
      sessionLog: "# Engineering Session Log\n\nSubstantive log.\n",
      independentTestEvidence: "# Independent Test Evidence\n\nHonest evidence.\n",
      review: "# Engineering Review\n\nSubstantive review.\n",
      provenance: "# PR Provenance\n\nSubstantive provenance.\n",
    };
    const result = await host.execute({
      id: null,
      type: "function",
      name: "write_engineering_evidence_pack",
      arguments: contents,
    }, {
      signal: new AbortController().signal,
      maxOutputCharacters: 48_000,
    });

    assert.match(result.summary, /7 份/u);
    assert.deepEqual(
      selectedPaths.map((targetPath) => result.changedPaths.includes(targetPath)),
      Array.from({ length: 7 }, () => true),
    );
    for (const [targetPath, content] of selectedPaths.map((targetPath, index) => (
      [targetPath, Object.values(contents)[index]!] as const
    ))) {
      assert.equal(await readFile(path.join(fixture.root, targetPath), "utf8"), content);
    }
  } finally {
    await fixture.dispose();
  }
});

test("search_text safely defaults omitted local-model controls without weakening its strict tool schema", async () => {
  const fixture = await workspaceFixture();
  try {
    await writeFile(path.join(fixture.root, "profile.md"), "Profile layout\n", "utf8");
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
    });
    const definition = host.definitions().find(({ name }) => name === "search_text");
    assert.deepEqual(
      definition?.parameters.required,
      ["path", "query", "caseSensitive", "maxResults"],
      "strict Providers still receive the fully required function schema",
    );

    const result = await host.execute({
      id: null,
      type: "function",
      name: "search_text",
      arguments: { path: ".", query: "Profile" },
    }, {
      signal: new AbortController().signal,
      maxOutputCharacters: 48_000,
    });
    assert.match(result.content, /profile\.md/u);

    await assert.rejects(
      host.execute({
        id: null,
        type: "function",
        name: "search_text",
        arguments: {
          path: ".",
          query: "Profile",
          caseSensitive: "false",
          maxResults: 50,
        },
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 48_000,
      }),
      (error: unknown) => error instanceof ProviderAgentToolError
        && error.code === "AGENT_TOOL_ARGUMENTS_INVALID"
        && /caseSensitive/u.test(error.safeMessage),
    );
  } finally {
    await fixture.dispose();
  }
});

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

    const observedCallIds: string[] = [];
    const result = await runtime.run({
      providerId: "ollama",
      instruction: "只修改用户点名的文件，然后用白话说明。",
      messages: [{ role: "user", content: "请更新 message.txt" }],
      toolHost: host,
      limits: { maxToolCalls: 2 },
      observer: {
        toolStarted: ({ callId }) => { observedCallIds.push(callId); },
        toolFinished: ({ callId }) => { observedCallIds.push(callId); },
      },
    });

    assert.equal(result.providerId, "ollama");
    assert.equal(result.model, "selected-model");
    assert.equal(result.modelCalls, 2);
    assert.equal(result.toolSteps[0]?.toolName, "apply_patch");
    assert.equal(result.toolSteps[0]?.status, "completed");
    assert.equal(result.toolSteps[0]?.callId, "provider-call-1");
    assert.deepEqual(observedCallIds, ["provider-call-1", "provider-call-1"]);
    assert.match(await readFile(path.join(fixture.root, "message.txt"), "utf8"), /provider-native/u);
    assert.deepEqual(providers.requests.map(({ providerId }) => providerId), ["ollama", "ollama"]);
    assert.equal(providers.requests[0]?.request.toolChoice, "auto");
    assert.ok(providers.requests[0]?.request.tools?.some(({ name }) => name === "apply_patch"));
    assert.match(
      providers.requests[1]?.request.messages.at(-1)?.content ?? "",
      /"platformToolResult":true/u,
    );
    assert.doesNotMatch(
      providers.requests[1]?.request.messages.at(-1)?.content ?? "",
      /ollama-call/u,
    );
  } finally {
    await fixture.dispose();
  }
});

test("guarded workflow phases can reach their explicit bounded tool budgets", async (t) => {
  await t.test("eight inherited messages still permit all 16 Architecture tool calls", async () => {
    const fixture = await workspaceFixture();
    try {
      const providers = new FakeProviderPort([
        ...Array.from({ length: 16 }, (_, index) => toolResponse(
          `architecture-list-${index + 1}`,
          "list_files",
          { path: ".", maxDepth: 1, maxEntries: 10 },
        )),
        finalResponse("架构阶段产物处理完成。"),
      ]);
      const host = await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
      });
      const messages = Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? "assistant" as const : "user" as const,
        content: `有界会话消息 ${index + 1}`,
      }));
      const result = await new ProviderNativeAgentRuntime(providers).run({
        providerId: "openai",
        instruction: "执行多产物阶段，但仍受平台显式工具预算约束。",
        messages,
        toolHost: host,
        limits: { maxToolCalls: 16 },
      });
      assert.equal(result.toolSteps.length, 16);
      assert.equal(result.modelCalls, 17);
      assert.equal(providers.requests.at(-1)?.request.messages.length, 40);
    } finally {
      await fixture.dispose();
    }
  });

  await t.test("Implementation can use all 32 calls before the forced final response", async () => {
    const fixture = await workspaceFixture();
    try {
      const providers = new FakeProviderPort([
        ...Array.from({ length: 32 }, (_, index) => toolResponse(
          `implementation-list-${index + 1}`,
          "list_files",
          { path: ".", maxDepth: 1, maxEntries: 10 },
        )),
        finalResponse("实现阶段产物处理完成。"),
      ]);
      const result = await new ProviderNativeAgentRuntime(providers).run({
        providerId: "openai",
        instruction: "执行实现阶段，但不能越过平台的 32 次工具上限。",
        messages: [{ role: "user", content: "继续实现阶段" }],
        toolHost: await RootedAgentToolHost.create({
          rootPath: fixture.root,
          accessMode: "sandbox-write",
        }),
        limits: { maxToolCalls: 32 },
      });
      assert.equal(result.toolSteps.length, 32);
      assert.equal(result.modelCalls, 33);
      assert.equal(providers.requests.at(-1)?.request.messages.length, 65);
    } finally {
      await fixture.dispose();
    }
  });
});

test("CHAT-AC-04/19: traversal, symlinks, sensitive files and read-only writes fail closed", async (t) => {
  await t.test("browse-only root aliases normalize without allowing absolute child paths", async () => {
    const fixture = await workspaceFixture();
    try {
      await writeFile(path.join(fixture.root, "README.md"), "# Safe root\n", "utf8");
      const host = await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "read-only",
      });
      const rootListing = await host.execute({
        type: "function",
        id: "browse-root-alias",
        name: "list_files",
        arguments: { path: "/", maxDepth: 1, maxEntries: 20 },
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      });
      assert.match(rootListing.content, /README\.md/u);
      await assert.rejects(
        () => host.execute({
          type: "function",
          id: "reject-absolute-child",
          name: "list_files",
          arguments: { path: "/etc", maxDepth: 1, maxEntries: 20 },
        }, {
          signal: new AbortController().signal,
          maxOutputCharacters: 10_000,
        }),
        (error: unknown) => (error as { code?: string }).code === "AGENT_PATH_INVALID",
      );
    } finally {
      await fixture.dispose();
    }
  });

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

  await t.test("workspace hardlinks cannot expose an outside file through read, search or list", async () => {
    const fixture = await workspaceFixture();
    const outside = path.join(
      path.dirname(fixture.root),
      `${path.basename(fixture.root)}-hardlink-target.txt`,
    );
    try {
      const privateMarker = "host-hardlink-private-material";
      await writeFile(outside, privateMarker, "utf8");
      await link(outside, path.join(fixture.root, "linked-hard.txt"));
      const providers = new FakeProviderPort([
        toolResponse("hardlink-read", "read_file", {
          path: "linked-hard.txt",
          startLine: 1,
          endLine: 10,
        }),
        toolResponse("hardlink-search", "search_text", {
          path: ".",
          query: privateMarker,
          caseSensitive: true,
          maxResults: 10,
        }),
        toolResponse("hardlink-list", "list_files", {
          path: ".",
          maxDepth: 2,
          maxEntries: 20,
        }),
        finalResponse("平台没有暴露硬链接内容。"),
      ]);
      const result = await new ProviderNativeAgentRuntime(providers).run({
        providerId: "openai",
        instruction: "安全检查仓库，不得越过工作区边界。",
        messages: [{ role: "user", content: "检查工作区中的普通源码" }],
        toolHost: await RootedAgentToolHost.create({
          rootPath: fixture.root,
          accessMode: "read-only",
        }),
      });
      assert.deepEqual(result.toolSteps.map(({ status }) => status), [
        "failed",
        "completed",
        "completed",
      ]);
      const providerContext = providers.requests
        .flatMap(({ request }) => request.messages.map(({ content }) => content))
        .join("\n");
      assert.doesNotMatch(providerContext, new RegExp(privateMarker, "u"));
      assert.doesNotMatch(providerContext, /linked-hard\.txt/u);
    } finally {
      await rm(outside, { force: true });
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

  await t.test("cloud credential directories and common token formats stay hidden", async () => {
    const fixture = await workspaceFixture();
    try {
      const dockerAuth = "dXNlcjpwYXNzd29yZA==";
      await mkdir(path.join(fixture.root, ".docker"));
      await writeFile(
        path.join(fixture.root, ".docker", "config.json"),
        JSON.stringify({ auths: { registry: { auth: dockerAuth } } }),
        "utf8",
      );
      const providers = new FakeProviderPort([
        toolResponse("docker-read", "read_file", {
          path: ".docker/config.json",
          startLine: 1,
          endLine: 10,
        }),
        toolResponse("docker-search", "search_text", {
          path: ".",
          query: dockerAuth,
          caseSensitive: true,
          maxResults: 10,
        }),
        toolResponse("docker-list", "list_files", {
          path: ".",
          maxDepth: 3,
          maxEntries: 20,
        }),
        finalResponse("敏感目录未暴露。"),
      ]);
      const result = await new ProviderNativeAgentRuntime(providers).run({
        providerId: "openai",
        instruction: "只检查非敏感源码。",
        messages: [{ role: "user", content: "列出并搜索公开源码" }],
        toolHost: await RootedAgentToolHost.create({
          rootPath: fixture.root,
          accessMode: "read-only",
        }),
      });
      assert.deepEqual(result.toolSteps.map(({ status }) => status), [
        "failed",
        "completed",
        "completed",
      ]);
      const providerContext = providers.requests
        .flatMap(({ request }) => request.messages.map(({ content }) => content))
        .join("\n");
      assert.doesNotMatch(providerContext, new RegExp(dockerAuth, "u"));
      assert.doesNotMatch(providerContext, /\.docker\/config\.json/u);

      const bearer = "Bearer abcdefghijklmnopqrstuvwxyz123456";
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345678";
      assert.equal(containsLikelySecret(`authorization: ${bearer}`), true);
      assert.equal(containsLikelySecret(jwt), true);
      assert.equal(containsLikelySecret(`{\"auth\":\"${dockerAuth}\"}`), true);
      assert.equal(containsLikelySecret("const auth = createAuthClient();"), false);
      assert.equal(
        containsLikelySecret("authorization = request.headers.authorization;"),
        false,
      );
      assert.doesNotMatch(redactLikelySecrets(`${bearer}\n${jwt}\n${dockerAuth}`).text, /abcdefghijklmnopqrstuvwxyz|eyJhbGci/u);
      assert.doesNotMatch(
        redactLikelySecrets(`{\"auth\":\"${dockerAuth}\"}`).text,
        new RegExp(dockerAuth, "u"),
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

test("write_file safely creates missing parents inside a selected directory artifact", async () => {
  const fixture = await workspaceFixture();
  try {
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      writablePaths: ["artifacts/user-stories"],
      writableDirectoryPaths: ["artifacts/user-stories"],
    });
    const storyPath = "artifacts/user-stories/onboarding/US-001-profile/story.md";

    const result = await host.execute({
      type: "function",
      id: "write-nested-story",
      name: "write_file",
      arguments: {
        path: storyPath,
        content: "# US-001: Improve the profile\n",
        overwrite: false,
      },
    }, {
      signal: new AbortController().signal,
      maxOutputCharacters: 10_000,
    });

    assert.deepEqual(result.changedPaths, [
      "artifacts/user-stories/onboarding/US-001-profile",
      storyPath,
    ]);
    assert.match(result.summary, /安全创建缺失父目录/u);
    assert.equal(
      await readFile(path.join(fixture.root, storyPath), "utf8"),
      "# US-001: Improve the profile\n",
    );

    const exactFileHost = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      writablePaths: ["docs/prd.md"],
      writableDirectoryPaths: [],
    });
    const exactFileResult = await exactFileHost.execute({
      type: "function",
      id: "write-exact-file-with-missing-parent",
      name: "write_file",
      arguments: {
        path: "docs/prd.md",
        content: "# Product requirements\n",
        overwrite: false,
      },
    }, {
      signal: new AbortController().signal,
      maxOutputCharacters: 10_000,
    });
    assert.deepEqual(exactFileResult.changedPaths, ["docs", "docs/prd.md"]);
    assert.equal(
      await readFile(path.join(fixture.root, "docs", "prd.md"), "utf8"),
      "# Product requirements\n",
    );
    const unchangedResult = await exactFileHost.execute({
      type: "function",
      id: "rewrite-identical-exact-file",
      name: "write_file",
      arguments: {
        path: "docs/prd.md",
        content: "# Product requirements\n",
        overwrite: true,
      },
    }, {
      signal: new AbortController().signal,
      maxOutputCharacters: 10_000,
    });
    assert.deepEqual(unchangedResult.changedPaths, []);
    assert.match(unchangedResult.summary, /内容未变化/u);
  } finally {
    await fixture.dispose();
  }
});

test("automatic parent creation fails closed without partial directories", async (t) => {
  await t.test("secret content is rejected before an allowed parent is created", async () => {
    const fixture = await workspaceFixture();
    try {
      const host = await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
        writablePaths: ["private-output"],
        writableDirectoryPaths: ["private-output"],
      });
      await assert.rejects(
        () => host.execute({
          type: "function",
          id: "reject-secret-before-mkdir",
          name: "write_file",
          arguments: {
            path: "private-output/nested/secret.md",
            content: "api_key = \"sk-proj-1234567890abcdefghijkl\"\n",
            overwrite: false,
          },
        }, {
          signal: new AbortController().signal,
          maxOutputCharacters: 10_000,
        }),
        (error: unknown) => (
          (error as { code?: string }).code === "AGENT_SECRET_WRITE_FORBIDDEN"
        ),
      );
      await assert.rejects(access(path.join(fixture.root, "private-output")));
    } finally {
      await fixture.dispose();
    }
  });

  await t.test("a symlink or ordinary file in the parent chain is never followed or replaced", async () => {
    const fixture = await workspaceFixture();
    try {
      await mkdir(path.join(fixture.root, "artifacts", "user-stories"), { recursive: true });
      await mkdir(path.join(fixture.root, "outside"));
      await symlink(
        path.join(fixture.root, "outside"),
        path.join(fixture.root, "artifacts", "user-stories", "linked"),
      );
      await writeFile(
        path.join(fixture.root, "artifacts", "user-stories", "not-a-directory"),
        "ordinary file\n",
        "utf8",
      );
      const host = await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
        writablePaths: ["artifacts/user-stories"],
        writableDirectoryPaths: ["artifacts/user-stories"],
      });
      for (const target of [
        "artifacts/user-stories/linked/US-001/story.md",
        "artifacts/user-stories/not-a-directory/US-002/story.md",
      ]) {
        await assert.rejects(
          () => host.execute({
            type: "function",
            id: `reject-parent-${target}`,
            name: "write_file",
            arguments: {
              path: target,
              content: "# Must not be written\n",
              overwrite: false,
            },
          }, {
            signal: new AbortController().signal,
            maxOutputCharacters: 10_000,
          }),
          (error: unknown) => (
            (error as { code?: string }).code === "AGENT_PATH_KIND_INVALID"
          ),
        );
      }
      await assert.rejects(access(path.join(fixture.root, "outside", "US-001")));
      assert.equal(
        await readFile(
          path.join(fixture.root, "artifacts", "user-stories", "not-a-directory"),
          "utf8",
        ),
        "ordinary file\n",
      );
    } finally {
      await fixture.dispose();
    }
  });

  await t.test("an out-of-scope target cannot create any parent", async () => {
    const fixture = await workspaceFixture();
    try {
      const host = await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
        writablePaths: ["artifacts/user-stories"],
        writableDirectoryPaths: ["artifacts/user-stories"],
      });
      await assert.rejects(
        () => host.execute({
          type: "function",
          id: "reject-out-of-scope-before-mkdir",
          name: "write_file",
          arguments: {
            path: "artifacts/other/new/file.md",
            content: "# Must not be written\n",
            overwrite: false,
          },
        }, {
          signal: new AbortController().signal,
          maxOutputCharacters: 10_000,
        }),
        (error: unknown) => (
          (error as { code?: string }).code === "AGENT_WRITE_SCOPE_FORBIDDEN"
        ),
      );
      await assert.rejects(access(path.join(fixture.root, "artifacts")));
    } finally {
      await fixture.dispose();
    }
  });
});

test("one invalid tool call can recover with a direct nested Story write", async () => {
  const fixture = await workspaceFixture();
  try {
    const storyPath = "artifacts/user-stories/onboarding/US-001-profile/story.md";
    const providers = new FakeProviderPort([
      toolResponse("invalid-write", "write_file", {
        path: storyPath,
        content: "# Invalid arguments must not run\n",
        overwrite: "false",
      }),
      toolResponse("valid-write", "write_file", {
        path: storyPath,
        content: "# US-001: Improve the profile\n",
        overwrite: false,
      }),
      finalResponse("Story 已创建并通过平台检查。"),
    ]);
    let finalizationChecks = 0;
    const result = await new ProviderNativeAgentRuntime(providers).run({
      providerId: "openai",
      instruction: "创建可审核的 Story，然后完成本阶段。",
      messages: [{ role: "user", content: "继续 PM / BA 阶段" }],
      toolHost: await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
        writablePaths: ["artifacts/user-stories"],
        writableDirectoryPaths: ["artifacts/user-stories"],
      }),
      limits: { maxToolCalls: 4 },
      finalizationCheck: async () => {
        finalizationChecks += 1;
        return { ready: true };
      },
    });

    assert.deepEqual(result.toolSteps.map(({ status }) => status), ["failed", "completed"]);
    assert.equal(result.stopReason, "completed");
    assert.equal(finalizationChecks, 1);
    assert.equal(
      await readFile(path.join(fixture.root, storyPath), "utf8"),
      "# US-001: Improve the profile\n",
    );
    const finalProviderContext = providers.requests.at(-1)?.request.messages
      .map(({ content }) => content)
      .join("\n") ?? "";
    assert.match(finalProviderContext, /工具参数不符合平台约束/u);
    assert.match(finalProviderContext, /文件已在当前 Session Sandbox 内更新/u);
  } finally {
    await fixture.dispose();
  }
});

test("workflow write allowlists support directory artifacts and reject files outside selected outputs", async () => {
  const fixture = await workspaceFixture();
  try {
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      writablePaths: ["artifacts/report.md", "artifacts/adrs"],
      writableDirectoryPaths: ["artifacts/adrs"],
    });
    assert.equal(host.definitions().some(({ name }) => name === "create_directory"), true);
    await host.execute({
      type: "function",
      id: "mkdir-adrs",
      name: "create_directory",
      arguments: { path: "artifacts/adrs" },
    }, {
      signal: new AbortController().signal,
      maxOutputCharacters: 10_000,
    });
    await host.execute({
      type: "function",
      id: "write-adr",
      name: "write_file",
      arguments: {
        path: "artifacts/adrs/README.md",
        content: "# Pending ADRs\n",
        overwrite: false,
      },
    }, {
      signal: new AbortController().signal,
      maxOutputCharacters: 10_000,
    });
    assert.match(
      await readFile(path.join(fixture.root, "artifacts", "adrs", "README.md"), "utf8"),
      /Pending ADRs/u,
    );
    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "mkdir-file-output",
        name: "create_directory",
        arguments: { path: "artifacts/report.md" },
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      }),
      (error: unknown) => (
        (error as { code?: string }).code === "AGENT_WRITE_SCOPE_FORBIDDEN"
      ),
    );
    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "write-below-file-output",
        name: "write_file",
        arguments: {
          path: "artifacts/report.md/forged-child.md",
          content: "must not turn a file artifact into a directory\n",
          overwrite: false,
        },
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      }),
      (error: unknown) => (
        (error as { code?: string }).code === "AGENT_WRITE_SCOPE_FORBIDDEN"
      ),
    );
    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "write-over-directory-output",
        name: "write_file",
        arguments: {
          path: "artifacts/adrs",
          content: "must not turn a directory artifact into a file\n",
          overwrite: true,
        },
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      }),
      (error: unknown) => (
        (error as { code?: string }).code === "AGENT_WRITE_SCOPE_FORBIDDEN"
      ),
    );
    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "write-source",
        name: "write_file",
        arguments: {
          path: "src/out-of-scope.ts",
          content: "export const changed = true;\n",
          overwrite: false,
        },
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      }),
      (error: unknown) => (
        (error as { code?: string }).code === "AGENT_WRITE_SCOPE_FORBIDDEN"
      ),
    );
    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "forge-runtime-evidence",
        name: "write_file",
        arguments: {
          path: "test-results/provider-claim.json",
          content: "{\"passed\":true}\n",
          overwrite: false,
        },
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      }),
      (error: unknown) => (
        (error as { code?: string }).code === "AGENT_WRITE_SCOPE_FORBIDDEN"
      ),
    );
  } finally {
    await fixture.dispose();
  }
});

test("implementation writes keep control paths and unselected artifacts immutable before I/O", async () => {
  const fixture = await workspaceFixture();
  try {
    await mkdir(path.join(fixture.root, ".ai-sdlc", "tasks"), { recursive: true });
    await mkdir(path.join(fixture.root, ".codex"));
    await mkdir(path.join(fixture.root, "artifacts"));
    await writeFile(path.join(fixture.root, "artifacts", "unselected.md"), "same bytes\n", "utf8");
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      protectedWritePaths: [".ai-sdlc", ".codex", "artifacts/unselected.md"],
      protectedWriteExceptionPaths: [
        ".ai-sdlc/runs/current/implementation-notes.md",
        ".ai-sdlc/runs/current/evidence",
      ],
      protectedWriteExceptionDirectoryPaths: [".ai-sdlc/runs/current/evidence"],
    });
    const execute = (name: "create_directory" | "write_file", argumentsValue: Record<string, unknown>) => (
      host.execute({
        type: "function",
        id: `implementation-${name}`,
        name,
        arguments: argumentsValue,
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      })
    );
    await execute("create_directory", { path: ".ai-sdlc/runs/current" });
    await execute("write_file", {
      path: ".ai-sdlc/runs/current/implementation-notes.md",
      content: "# Selected output\n",
      overwrite: false,
    });
    await execute("create_directory", { path: ".ai-sdlc/runs/current/evidence" });
    await execute("write_file", {
      path: ".ai-sdlc/runs/current/evidence/result.md",
      content: "# Selected directory output\n",
      overwrite: false,
    });
    await execute("create_directory", { path: "src" });
    await execute("write_file", {
      path: "src/change.ts",
      content: "export const providerNative = true;\n",
      overwrite: false,
    });

    for (const [target, content, overwrite] of [
      [".ai-sdlc/tasks/injected.md", "injected\n", false],
      [".codex/config.toml", "model = \"forged\"\n", false],
      ["artifacts/unselected.md", "same bytes\n", true],
    ] as const) {
      await assert.rejects(
        () => execute("write_file", { path: target, content, overwrite }),
        (error: unknown) => (
          (error as { code?: string }).code === "AGENT_PROTECTED_PATH_FORBIDDEN"
        ),
      );
    }
    assert.equal(
      await readFile(path.join(fixture.root, "artifacts", "unselected.md"), "utf8"),
      "same bytes\n",
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

  await t.test("a secret-like upstream model identifier is rejected before audit persistence", async () => {
    const fixture = await workspaceFixture();
    try {
      const response = finalResponse("不应持久化这次响应。");
      response.model = "sk-proj-1234567890abcdefghijkl";
      const providers = new FakeProviderPort([response]);
      await assert.rejects(
        new ProviderNativeAgentRuntime(providers).run({
          providerId: "openai",
          instruction: "检查源码。",
          messages: [{ role: "user", content: "检查仓库" }],
          toolHost: await RootedAgentToolHost.create({
            rootPath: fixture.root,
            accessMode: "read-only",
          }),
        }),
        (error: unknown) => error instanceof AppError
          && error.code === "AGENT_PROVIDER_MODEL_INVALID"
          && !error.message.includes(response.model),
      );
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
