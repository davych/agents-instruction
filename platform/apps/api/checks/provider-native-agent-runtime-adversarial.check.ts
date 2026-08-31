import assert from "node:assert/strict";
import {
  access,
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
  type ProviderAgentToolHost,
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

test("CHAT-AC-09: accepted progress renews the idle lease without extending the absolute cap", async (t) => {
  await t.test("a slow but progressing local Provider can finish past one idle window", async () => {
    const fixture = await workspaceFixture();
    const providers = new ProgressingProviderPort(400, 3);
    try {
      const result = await new ProviderNativeAgentRuntime(providers).run({
        providerId: "openai",
        instruction: "逐步检查仓库，然后总结。",
        messages: [{ role: "user", content: "请检查仓库" }],
        toolHost: await RootedAgentToolHost.create({
          rootPath: fixture.root,
          accessMode: "read-only",
        }),
        limits: {
          maxToolCalls: 3,
          maxIdleTimeMs: 1_000,
          maxWallTimeMs: 4_000,
        },
      });

      assert.equal(result.stopReason, "tool-limit-finalized");
      assert.equal(result.modelCalls, 4);
      assert.equal(result.toolSteps.length, 3);
      assert.ok(result.durationMs > 1_000, "the run must outlive its renewable idle window");
    } finally {
      providers.dispose();
      await fixture.dispose();
    }
  });

  await t.test("continuous progress still cannot extend the absolute wall deadline", async () => {
    const fixture = await workspaceFixture();
    const providers = new ProgressingProviderPort(350, 8);
    try {
      await assert.rejects(
        new ProviderNativeAgentRuntime(providers).run({
          providerId: "openai",
          instruction: "逐步检查仓库，然后总结。",
          messages: [{ role: "user", content: "请检查仓库" }],
          toolHost: await RootedAgentToolHost.create({
            rootPath: fixture.root,
            accessMode: "read-only",
          }),
          limits: {
            maxToolCalls: 8,
            maxIdleTimeMs: 1_000,
            maxWallTimeMs: 1_200,
          },
        }),
        (error: unknown) => error instanceof AppError && error.code === "AGENT_RUNTIME_TIMEOUT",
      );
      assert.ok(providers.calls >= 3, "the Provider must make progress before the wall cap wins");
    } finally {
      providers.dispose();
      await fixture.dispose();
    }
  });

  await t.test("no accepted progress expires the idle lease", async () => {
    const fixture = await workspaceFixture();
    const providers = new IgnoringAbortProviderPort();
    try {
      await assert.rejects(
        new ProviderNativeAgentRuntime(providers).run({
          providerId: "openai",
          instruction: "只读检查仓库并简要总结。",
          messages: [{ role: "user", content: "请检查仓库" }],
          toolHost: await RootedAgentToolHost.create({
            rootPath: fixture.root,
            accessMode: "read-only",
          }),
          limits: {
            maxIdleTimeMs: 1_000,
            maxWallTimeMs: 5_000,
          },
        }),
        (error: unknown) => (
          error instanceof AppError && error.code === "AGENT_RUNTIME_IDLE_TIMEOUT"
        ),
      );
    } finally {
      providers.dispose();
      await fixture.dispose();
    }
  });

  await t.test("an event-loop-blocked Provider cannot return success after the wall clock expired", async () => {
    const fixture = await workspaceFixture();
    const providers = new BlockingProviderPort(1_200);
    try {
      await assert.rejects(
        new ProviderNativeAgentRuntime(providers).run({
          providerId: "openai",
          instruction: "只读检查仓库并简要总结。",
          messages: [{ role: "user", content: "请检查仓库" }],
          toolHost: await RootedAgentToolHost.create({
            rootPath: fixture.root,
            accessMode: "read-only",
          }),
          limits: {
            maxIdleTimeMs: 5_000,
            maxWallTimeMs: 1_000,
          },
        }),
        (error: unknown) => error instanceof AppError && error.code === "AGENT_RUNTIME_TIMEOUT",
      );
    } finally {
      await fixture.dispose();
    }
  });

  await t.test("a timed-out mutating tool becomes quiescent before rollback can run", async () => {
    const fixture = await workspaceFixture();
    const providers = new ImmediateWriteProviderPort();
    const latePath = path.join(fixture.root, "late-write.txt");
    const host: ProviderAgentToolHost = {
      accessMode: "sandbox-write",
      definitions: () => [{
        type: "function",
        name: "write_file",
        description: "test-only bounded write",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path", "content", "overwrite"],
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            overwrite: { type: "boolean" },
          },
        },
      }],
      execute: async (_call, { signal }) => {
        await new Promise<void>((resolve) => {
          const finishAfterAbort = () => setTimeout(resolve, 150);
          if (signal.aborted) finishAfterAbort();
          else signal.addEventListener("abort", finishAfterAbort, { once: true });
        });
        await writeFile(latePath, "late mutation\n", "utf8");
        return {
          summary: "test write settled after cancellation",
          content: "settled",
          changedPaths: ["late-write.txt"],
        };
      },
    };
    try {
      await assert.rejects(
        new ProviderNativeAgentRuntime(providers).run({
          providerId: "openai",
          instruction: "更新允许的测试文件。",
          messages: [{ role: "user", content: "请更新文件" }],
          toolHost: host,
          limits: {
            maxIdleTimeMs: 1_000,
            maxWallTimeMs: 5_000,
          },
        }),
        (error: unknown) => (
          error instanceof AppError && error.code === "AGENT_RUNTIME_IDLE_TIMEOUT"
        ),
      );
      assert.equal(await readFile(latePath, "utf8"), "late mutation\n");

      // Model the guarded runner's rollback after runtime rejection. If the
      // runtime had abandoned the tool Promise, the delayed write would
      // recreate this file after the rollback point.
      await rm(latePath);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await assert.rejects(access(latePath));
    } finally {
      await fixture.dispose();
    }
  });
});

test("CHAT-AC-09: upstream cancellation and invalid deadline limits fail deterministically", async (t) => {
  await t.test("upstream AbortSignal remains a cancellation, not a timeout", async () => {
    const fixture = await workspaceFixture();
    const providers = new IgnoringAbortProviderPort();
    const controller = new AbortController();
    const cancel = setTimeout(() => controller.abort(new Error("cancelled by caller")), 50);
    try {
      await assert.rejects(
        new ProviderNativeAgentRuntime(providers).run({
          providerId: "openai",
          instruction: "只读检查仓库并简要总结。",
          messages: [{ role: "user", content: "请检查仓库" }],
          toolHost: await RootedAgentToolHost.create({
            rootPath: fixture.root,
            accessMode: "read-only",
          }),
          signal: controller.signal,
          limits: { maxIdleTimeMs: 5_000, maxWallTimeMs: 5_000 },
        }),
        (error: unknown) => (
          error instanceof AppError && error.code === "AGENT_RUNTIME_CANCELLED"
        ),
      );
    } finally {
      clearTimeout(cancel);
      providers.dispose();
      await fixture.dispose();
    }
  });

  await t.test("idle and wall limits cannot exceed their runtime safety bounds", async () => {
    const fixture = await workspaceFixture();
    const providers = new IgnoringAbortProviderPort();
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "read-only",
    });
    try {
      for (const limits of [
        { maxIdleTimeMs: 999 },
        { maxIdleTimeMs: 15 * 60_000 + 1 },
        { maxWallTimeMs: 999 },
        { maxWallTimeMs: 60 * 60_000 + 1 },
      ]) {
        await assert.rejects(
          new ProviderNativeAgentRuntime(providers).run({
            providerId: "openai",
            instruction: "只读检查仓库并简要总结。",
            messages: [{ role: "user", content: "请检查仓库" }],
            toolHost: host,
            limits,
          }),
          (error: unknown) => error instanceof AppError && error.code === "AGENT_LIMIT_INVALID",
        );
      }
    } finally {
      providers.dispose();
      await fixture.dispose();
    }
  });
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

  runWithProvider<T>(_providerId: AskProviderId, operation: () => T): T {
    return operation();
  }

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

class ProgressingProviderPort {
  calls = 0;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly delayMs: number,
    private readonly toolResponsesBeforeFinal: number,
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

  complete(): Promise<AskLlmCompleteResponse> {
    this.calls += 1;
    const position = this.calls;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve(position <= this.toolResponsesBeforeFinal
          ? {
              text: "继续检查。",
              model: "selected-model",
              usage: { inputTokens: 1, outputTokens: 1 },
              toolCalls: [{
                id: `progress-${position}`,
                type: "function",
                name: "list_files",
                arguments: { path: ".", maxDepth: 1, maxEntries: 10 },
              }],
            }
          : {
              text: "检查完成。",
              model: "selected-model",
              usage: { inputTokens: 1, outputTokens: 1 },
            });
      }, this.delayMs);
      this.timers.add(timer);
    });
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

class BlockingProviderPort extends ProgressingProviderPort {
  constructor(private readonly blockedForMs: number) {
    super(0, 0);
  }

  override complete(): Promise<AskLlmCompleteResponse> {
    const stopAt = Date.now() + this.blockedForMs;
    while (Date.now() < stopAt) {
      // Deliberately block the event loop to prove synchronous deadline checks
      // cannot be bypassed by timer callback ordering.
    }
    return Promise.resolve({
      text: "late success must be rejected",
      model: "selected-model",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }
}

class ImmediateWriteProviderPort extends ProgressingProviderPort {
  constructor() {
    super(0, 0);
  }

  override complete(): Promise<AskLlmCompleteResponse> {
    return Promise.resolve({
      text: "write requested",
      model: "selected-model",
      usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [{
        id: "late-write",
        type: "function",
        name: "write_file",
        arguments: {
          path: "late-write.txt",
          content: "late mutation\n",
          overwrite: false,
        },
      }],
    });
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
