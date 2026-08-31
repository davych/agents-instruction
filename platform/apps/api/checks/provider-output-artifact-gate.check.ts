import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AskProviderId,
  AskProviderStatusDto,
  ProjectDto,
  WorkflowRunDto,
} from "@ai-sdlc/contracts";

import { AppError } from "../src/domain/errors.ts";
import {
  assessUserStoriesQualityEntries,
  userStoriesBlockerDecisionFingerprint,
  userStoriesBlockerDecisionScope,
  renderUserStoriesBlocker,
  USER_STORIES_BLOCKER_SENTINEL,
} from "../src/domain/user-story-quality.ts";
import { ProviderNativeAgentRuntime } from "../src/services/agent/provider-native-agent-runtime.ts";
import { ProviderPhaseExecutor } from "../src/services/agent/provider-phase-executor.ts";
import { RootedAgentToolHost } from "../src/services/agent/rooted-agent-tool-host.ts";
import {
  loadArchitectureRulebookContext,
  validateArchitectureRulebookReview,
} from "../src/services/architecture-rulebook-runtime.ts";
import {
  calculateArchitectureRulebookDigest,
  inspectArchitectureRulebook,
} from "../src/services/architecture-rulebook-validator.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { loadDefinition } from "../src/services/definition-loader.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { resolveTaskArtifactPaths } from "../src/domain/task-artifact-paths.ts";
import type {
  AskLlmCompleteRequest,
  AskLlmCompleteResponse,
} from "../src/services/llm/types.ts";

test("CHAT-AC-29: provider-native output gate continues the same loop with safe platform feedback", async () => {
  const fixture = await workspaceFixture();
  try {
    await mkdir(path.join(fixture.root, "docs"));
    const rawProviderText = "I am done: /srv/private/provider/raw-response.json";
    const providers = new ScriptedProviderPort([
      finalResponse(rawProviderText),
      toolResponse("write-prd", "write_file", {
        path: "docs/prd.md",
        content: "# PRD\n",
        overwrite: false,
      }),
      toolResponse("write-stories", "write_file", {
        path: "docs/user-stories.md",
        content: "# User stories\n",
        overwrite: false,
      }),
      finalResponse("All selected outputs are now present."),
    ]);
    const missingError = new AppError(
      "缺失 artifact key: prd, user-stories；本次选中产物变更已回滚。",
      409,
      "OUTPUT_ARTIFACTS_MISSING",
    );
    let checkCalls = 0;
    const result = await new ProviderNativeAgentRuntime(providers).run({
      providerId: "openai",
      instruction: "生成所有选中的阶段产物。",
      messages: [{ role: "user", content: "继续当前阶段" }],
      toolHost: await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
      }),
      limits: { maxToolCalls: 2 },
      finalizationCheck: async () => {
        checkCalls += 1;
        const missing = await missingFileKeys(fixture.root, {
          prd: "docs/prd.md",
          "user-stories": "docs/user-stories.md",
        });
        return missing.length === 0
          ? { ready: true }
          : {
              ready: false,
              feedback: `平台产物校验未通过；缺失 artifact key: ${missing.join(", ")}。请继续调用文件工具补齐。`,
              error: missingError,
            };
      },
    });

    assert.ok(
      result.stopReason === "completed" || result.stopReason === "tool-limit-finalized",
      "a ready gate may complete normally or at the original tool-limit finalization boundary",
    );
    assert.equal(result.modelCalls, 4);
    assert.equal(result.toolSteps.length, 2);
    assert.equal(checkCalls, 2, "the gate must run before each attempted no-tool completion");
    assert.match(await readFile(path.join(fixture.root, "docs/prd.md"), "utf8"), /# PRD/u);
    assert.match(
      await readFile(path.join(fixture.root, "docs/user-stories.md"), "utf8"),
      /# User stories/u,
    );

    const correctionRequest = providers.requests[1]!.request;
    const platformFeedback = correctionRequest.messages.at(-1)?.content ?? "";
    assert.ok(correctionRequest.tools?.some(({ name }) => name === "write_file"));
    assert.equal(correctionRequest.toolChoice, "required");
    assert.match(platformFeedback, /prd/u);
    assert.match(platformFeedback, /user-stories/u);
    assert.doesNotMatch(platformFeedback, new RegExp(escapeRegExp(fixture.root), "u"));
    assert.doesNotMatch(platformFeedback, new RegExp(escapeRegExp(rawProviderText), "u"));
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-DECISION-REPLAY-07: Provider instruction keeps a full current 5,000-character answer", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const storyPath = `${stories.relativePath}/profile/US-103-lossless-replay/story.md`;
    const longTail = "z".repeat(4_900);
    const providers = new ScriptedProviderPort([
      toolResponse("create-lossless-prd-parent", "create_directory", {
        path: path.dirname(prd.relativePath),
      }),
      toolResponse("write-lossless-prd", "write_file", {
        path: prd.relativePath,
        content: "# PRD\n\nThe exact recorded policy is authoritative.\n",
        overwrite: false,
      }),
      toolResponse("create-lossless-story-directory", "create_directory", {
        path: path.dirname(storyPath),
      }),
      toolResponse("write-lossless-story", "write_file", {
        path: storyPath,
        content: canonicalStory().replaceAll("US-001", "US-103"),
        overwrite: false,
      }),
      finalResponse("The complete answer is materialized."),
    ]);

    await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [prd.id, stories.id],
      revisionFeedback: [
        `PRODUCT-QUESTION-V2-lossless: Preserve every clause exactly.\n${longTail}`,
      ],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "lmstudio",
      messages: [{ role: "user", content: "完成 Discovery" }],
    }, async () => undefined);

    const firstWireRequest = JSON.stringify(providers.requests[0]?.request ?? {});
    assert.match(firstWireRequest, /PRODUCT-QUESTION-V2-lossless/u);
    assert.ok(
      firstWireRequest.includes(longTail),
      "the Provider instruction must not apply the former 5,000-character aggregate truncation",
    );
  } finally {
    await fixture.dispose();
  }
});

test("Implementation must change a real repository file before engineering evidence can finalize", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const phase = fixture.definition.phases.find(({ id }) => id === "implementation");
    const notes = fixture.definition.artifacts.find(({ id }) => id === "implementation-notes");
    assert.ok(phase);
    assert.ok(notes);
    await writeFile(path.join(fixture.root, "PROFILE.md"), "# Old profile\n", "utf8");
    const providers = new ScriptedProviderPort([
      toolResponse("inspect-root", "list_files", { path: ".", maxDepth: 1, maxEntries: 50 }),
      toolResponse("reject-legacy-evidence-path", "write_file", {
        path: "docs/ai-native/engineering/implementation-notes.md",
        content: "# Unregistered legacy evidence\n",
        overwrite: false,
      }),
      finalResponse("The engineering notes are enough."),
      toolResponse("read-profile", "read_file", {
        path: "PROFILE.md",
        startLine: 1,
        endLine: 40,
      }),
      finalResponse("I found the target profile."),
      toolResponse("patch-profile", "apply_patch", {
        path: "PROFILE.md",
        oldText: "# Old profile",
        newText: "# Improved AI SDLC profile",
        replaceAll: false,
      }),
      finalResponse("The real profile is now updated."),
      toolResponse("write-notes", "write_file", {
        path: notes.relativePath,
        content: "# Implementation Notes\n\nPROFILE.md was updated through the bounded patch tool.\n",
        overwrite: false,
      }),
      finalResponse("The implementation and selected evidence are complete."),
    ]);

    const result = await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: {
        ...fixture.run,
        objective: "Improve the profile layout and add AI SDLC experience",
      },
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [notes.id],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "lmstudio",
      messages: [{ role: "user", content: "Improve this profile README." }],
    }, async () => undefined);

    assert.equal(result.exitCode, 0);
    assert.match(await readFile(path.join(fixture.root, "PROFILE.md"), "utf8"), /Improved AI SDLC/u);
    assert.match(await readFile(notes.absolutePath, "utf8"), /bounded patch tool/u);
    await assert.rejects(access(path.join(
      fixture.root,
      "docs/ai-native/engineering/implementation-notes.md",
    )));
    assert.deepEqual(
      [providers.requests[3]?.request.toolChoice, providers.requests[5]?.request.toolChoice],
      [
        { type: "function", name: "read_file" },
        { type: "function", name: "apply_patch" },
      ],
    );
    assert.match(
      providers.requests[0]?.request.systemPrompt ?? "",
      /最后才写 docs\/ai-native 下的工程证据/u,
    );
  } finally {
    await fixture.dispose();
  }
});

test("Implementation repairs a complete missing evidence set through one bound pack tool", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const phase = fixture.definition.phases.find(({ id }) => id === "implementation");
    assert.ok(phase);
    await writeFile(path.join(fixture.root, "PROFILE.md"), "# Old profile\n", "utf8");
    const providers = new ScriptedProviderPort([
      toolResponse("read-profile", "read_file", {
        path: "PROFILE.md",
        startLine: 1,
        endLine: 20,
      }),
      toolResponse("patch-profile", "apply_patch", {
        path: "PROFILE.md",
        oldText: "# Old profile",
        newText: "# Improved profile",
        replaceAll: false,
      }),
      finalResponse("The implementation is ready; generate the evidence pack."),
    ]);

    await assert.rejects(phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [...phase.outputs],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "lmstudio",
      messages: [{ role: "user", content: "Improve this profile README." }],
    }, async () => undefined), /response exhausted/u);

    const repairRequest = providers.requests.at(-1)?.request;
    assert.deepEqual(repairRequest?.toolChoice, {
      type: "function",
      name: "write_engineering_evidence_pack",
    });
    assert.ok(repairRequest?.tools?.some(({ name }) => name === "write_engineering_evidence_pack"));
    assert.match(repairRequest?.systemPrompt ?? "", /一次提交七份完整 Markdown/u);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: a Provider that ignores a named repair tool gets two bounded retries before incompatibility", async () => {
  const fixture = await workspaceFixture();
  try {
    const providers = new ScriptedProviderPort([
      finalResponse("finished too early: raw-provider-attempt-1"),
      finalResponse("finished too early: raw-provider-attempt-2"),
      finalResponse("finished too early: raw-provider-attempt-3"),
      finalResponse("finished too early: raw-provider-attempt-4"),
    ]);
    const missingError = new AppError(
      "缺失 artifact key: user-stories；本次选中产物变更已回滚。",
      409,
      "OUTPUT_ARTIFACTS_MISSING",
    );
    let checkCalls = 0;
    const requiredToolRetries: Array<{
      attempt: number;
      maxAttempts: number;
      requiredToolName: string | null;
    }> = [];

    await assert.rejects(
      new ProviderNativeAgentRuntime(providers).run({
        providerId: "custom",
        instruction: "完成选中的阶段产物。",
        messages: [{ role: "user", content: "继续" }],
        toolHost: await RootedAgentToolHost.create({
          rootPath: fixture.root,
          accessMode: "sandbox-write",
        }),
        limits: { maxToolCalls: 4 },
        finalizationCheck: async () => {
          checkCalls += 1;
          return {
            ready: false,
            feedback: "平台产物校验未通过；缺失 artifact key: user-stories。请继续调用文件工具补齐。",
            error: missingError,
            audit: {
              reasonCode: "OUTPUT_ARTIFACTS_MISSING",
              affectedArtifactKeys: ["user-stories"],
              issueIds: ["STORY_NONCANONICAL_CONTENT_REQUIRES_STORY"],
            },
            repairToolNames: ["write_file"],
          };
        },
        observer: {
          requiredToolRetry: (event) => {
            requiredToolRetries.push(event);
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "AGENT_PROVIDER_REQUIRED_TOOL_MISSING");
        assert.deepEqual(error.details, {
          requiredToolName: "write_file",
          reasonCode: "OUTPUT_ARTIFACTS_MISSING",
          affectedArtifactKeys: ["user-stories"],
          issueIds: ["STORY_NONCANONICAL_CONTENT_REQUIRES_STORY"],
        });
        return true;
      },
    );

    assert.equal(providers.requests.length, 4, "two bounded retries must precede incompatibility");
    assert.equal(checkCalls, 1);
    assert.deepEqual(requiredToolRetries, [
      {
        attempt: 1,
        maxAttempts: 2,
        requiredToolName: "write_file",
        reasonCode: "OUTPUT_ARTIFACTS_MISSING",
        affectedArtifactKeys: ["user-stories"],
        issueIds: ["STORY_NONCANONICAL_CONTENT_REQUIRES_STORY"],
      },
      {
        attempt: 2,
        maxAttempts: 2,
        requiredToolName: "write_file",
        reasonCode: "OUTPUT_ARTIFACTS_MISSING",
        affectedArtifactKeys: ["user-stories"],
        issueIds: ["STORY_NONCANONICAL_CONTENT_REQUIRES_STORY"],
      },
    ]);
    const correction = providers.requests[1]!;
    const retry = providers.requests[2]!;
    const finalRetry = providers.requests[3]!;
    assert.match(correction.request.messages.at(-1)?.content ?? "", /继续调用.*工具/u);
    assert.deepEqual(correction.request.toolChoice, {
      type: "function",
      name: "write_file",
    });
    assert.deepEqual(retry.request.toolChoice, correction.request.toolChoice);
    assert.deepEqual(finalRetry.request.toolChoice, correction.request.toolChoice);
    assert.match(retry.request.messages.at(-1)?.content ?? "", /"platformRequiredToolRetry":true/u);
    assert.match(finalRetry.request.messages.at(-1)?.content ?? "", /"attempt":2/u);
    assert.match(finalRetry.request.messages.at(-1)?.content ?? "", /不要先解释、总结、道歉/u);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: Ollama repair keeps native auto tool choice while retaining the correction", async () => {
  const fixture = await workspaceFixture();
  try {
    const providers = new ScriptedProviderPort([
      finalResponse("finished before writing"),
      toolResponse("write-after-correction", "write_file", {
        path: "prd.md",
        content: "# Corrected PRD\n",
        overwrite: false,
      }),
      finalResponse("The selected output now exists."),
    ]);
    const missingError = new AppError(
      "缺失 artifact key: prd；本次选中产物变更已回滚。",
      409,
      "OUTPUT_ARTIFACTS_MISSING",
    );

    const result = await new ProviderNativeAgentRuntime(providers).run({
      providerId: "ollama",
      instruction: "生成 PRD。",
      messages: [{ role: "user", content: "继续" }],
      toolHost: await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
      }),
      requireInitialTool: true,
      finalizationCheck: async () => {
        try {
          await readFile(path.join(fixture.root, "prd.md"), "utf8");
          return { ready: true };
        } catch {
          return {
            ready: false,
            feedback: "平台产物校验未通过；请继续调用 write_file 补齐 prd。",
            error: missingError,
          };
        }
      },
    });

    assert.equal(result.stopReason, "completed");
    assert.equal(providers.requests[0]?.request.toolChoice, "auto");
    assert.equal(providers.requests[1]?.request.toolChoice, "auto");
    assert.match(
      providers.requests[1]?.request.messages.at(-1)?.content ?? "",
      /继续调用 write_file/u,
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: Ollama prose-only corrections exhaust bounded repair rounds", async () => {
  const fixture = await workspaceFixture();
  try {
    const providers = new ScriptedProviderPort([
      finalResponse("finished before writing"),
      finalResponse("still no native tool call"),
      finalResponse("again no native tool call"),
    ]);
    const missingError = new AppError(
      "缺失 artifact key: prd；本次选中产物变更已回滚。",
      409,
      "OUTPUT_ARTIFACTS_MISSING",
    );
    let checkCalls = 0;

    await assert.rejects(
      new ProviderNativeAgentRuntime(providers).run({
        providerId: "ollama",
        instruction: "生成 PRD。",
        messages: [{ role: "user", content: "继续" }],
        toolHost: await RootedAgentToolHost.create({
          rootPath: fixture.root,
          accessMode: "sandbox-write",
        }),
        requireInitialTool: true,
        limits: {
          maxToolCalls: 4,
          maxFinalizationRepairs: 2,
          reservedFinalizationToolCalls: 2,
        },
        finalizationCheck: async () => {
          checkCalls += 1;
          return {
            ready: false,
            feedback: "缺失 artifact key: prd。请继续调用 write_file 补齐。",
            error: missingError,
          };
        },
      }),
      (error: unknown) => error === missingError,
    );

    assert.equal(providers.requests.length, 3);
    assert.equal(checkCalls, 3);
    assert.deepEqual(
      providers.requests.map(({ request }) => request.toolChoice),
      ["auto", "auto", "auto"],
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: an Ollama wrong repair tool cannot advance the named sequence", async () => {
  const fixture = await workspaceFixture();
  try {
    const storyPath = "artifacts/user-stories/review/US-001/story.md";
    const repairedStory = "# US-001: Repaired Story\n";
    await mkdir(path.dirname(path.join(fixture.root, storyPath)), { recursive: true });
    await writeFile(path.join(fixture.root, storyPath), "# Invalid Story\n", "utf8");
    const providers = new ScriptedProviderPort([
      finalResponse("The Story should already be ready."),
      toolResponse("wrong-repair-tool", "list_files", {
        path: ".",
        maxDepth: 1,
        maxEntries: 10,
      }),
      finalResponse("I listed files instead of reading the Story."),
      toolResponse("inspect-invalid-story", "read_file", {
        path: storyPath,
        startLine: 1,
        endLine: 40,
      }),
      finalResponse("I inspected the invalid Story."),
      toolResponse("rewrite-invalid-story", "write_file", {
        path: storyPath,
        content: repairedStory,
        overwrite: true,
      }),
      finalResponse("The repaired Story is ready."),
    ]);
    const invalidError = new AppError(
      "Story 产物未通过质量检查",
      422,
      "OUTPUT_ARTIFACTS_INVALID",
    );
    const requiredTools: Array<string | null> = [];

    const result = await new ProviderNativeAgentRuntime(providers).run({
      providerId: "ollama",
      instruction: "检查并修复不合格的 Story。",
      messages: [{ role: "user", content: "继续 PM / BA 阶段" }],
      toolHost: await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
        writablePaths: ["artifacts/user-stories"],
        writableDirectoryPaths: ["artifacts/user-stories"],
      }),
      limits: {
        maxToolCalls: 4,
        maxFinalizationRepairs: 1,
        reservedFinalizationToolCalls: 3,
      },
      finalizationCheck: async () => (
        (await readFile(path.join(fixture.root, storyPath), "utf8")) === repairedStory
          ? { ready: true }
          : {
              ready: false,
              feedback: "先读取不合格 Story，再用 write_file 原位修复。",
              error: invalidError,
              repairToolNames: ["read_file", "write_file"],
            }
      ),
      observer: {
        finalizationRejected: ({ requiredToolName }) => {
          requiredTools.push(requiredToolName);
        },
      },
    });

    assert.equal(result.stopReason, "completed");
    assert.deepEqual(result.toolSteps.map(({ toolName }) => toolName), [
      "list_files",
      "read_file",
      "write_file",
    ]);
    assert.deepEqual(requiredTools, ["read_file", "read_file", "write_file"]);
    assert.deepEqual(
      providers.requests.map(({ request }) => request.toolChoice),
      ["auto", "auto", "none", "auto", "none", "auto", "none"],
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: output correction cannot reset an exhausted provider tool budget", async () => {
  const fixture = await workspaceFixture();
  try {
    const providers = new ScriptedProviderPort([
      toolResponse("only-budgeted-call", "list_files", {
        path: ".",
        maxDepth: 1,
        maxEntries: 10,
      }),
      finalResponse("finished without the selected output"),
      toolResponse("must-not-run", "write_file", {
        path: "prd.md",
        content: "# illicit extra-budget write\n",
        overwrite: false,
      }),
    ]);
    const missingError = new AppError(
      "缺失 artifact key: prd；本次选中产物变更已回滚。",
      409,
      "OUTPUT_ARTIFACTS_MISSING",
    );

    await assert.rejects(
      new ProviderNativeAgentRuntime(providers).run({
        providerId: "openai",
        instruction: "生成 PRD。",
        messages: [{ role: "user", content: "继续" }],
        toolHost: await RootedAgentToolHost.create({
          rootPath: fixture.root,
          accessMode: "sandbox-write",
        }),
        limits: { maxToolCalls: 1 },
        finalizationCheck: async () => ({
          ready: false,
          feedback: "缺失 artifact key: prd。请继续调用文件工具补齐。",
          error: missingError,
        }),
      }),
      (error: unknown) => error === missingError,
    );

    assert.equal(providers.requests.length, 2, "a forced final must not start a fresh tool budget");
    assert.equal(providers.requests[1]?.request.toolChoice, "none");
    await assert.rejects(readFile(path.join(fixture.root, "prd.md"), "utf8"));
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: a guarded phase can probe finalization before consuming reserved repair tools", async () => {
  const fixture = await workspaceFixture();
  try {
    const providers = new ScriptedProviderPort([
      toolResponse("inspect-one", "list_files", { path: ".", maxDepth: 1, maxEntries: 10 }),
      toolResponse("inspect-two", "list_files", { path: ".", maxDepth: 1, maxEntries: 10 }),
      finalResponse("The output should be ready."),
      toolResponse("repair-output", "write_file", {
        path: "prd.md",
        content: "# Repaired PRD\n",
        overwrite: false,
      }),
      finalResponse("The deterministic output repair is complete."),
    ]);
    const missingError = new AppError(
      "缺失 artifact key: prd；本次选中产物变更已回滚。",
      409,
      "OUTPUT_ARTIFACTS_MISSING",
    );

    const result = await new ProviderNativeAgentRuntime(providers).run({
      providerId: "openai",
      instruction: "生成 PRD。",
      messages: [{ role: "user", content: "继续" }],
      toolHost: await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
      }),
      limits: {
        maxToolCalls: 4,
        maxFinalizationRepairs: 1,
        reservedFinalizationToolCalls: 2,
      },
      finalizationCheck: async () => {
        try {
          await readFile(path.join(fixture.root, "prd.md"), "utf8");
          return { ready: true };
        } catch {
          return {
            ready: false,
            feedback: "缺失 artifact key: prd。请使用 write_file 修复。",
            error: missingError,
          };
        }
      },
    });

    assert.equal(result.stopReason, "completed");
    assert.equal(result.toolSteps.length, 3);
    assert.deepEqual(
      providers.requests.map(({ request }) => request.toolChoice),
      ["auto", "auto", "none", "required", "none"],
    );
    assert.equal(await readFile(path.join(fixture.root, "prd.md"), "utf8"), "# Repaired PRD\n");
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: ordered Story repair tools are forced exactly with a gate probe after each step", async () => {
  const fixture = await workspaceFixture();
  try {
    const storyPath = "artifacts/user-stories/review/US-001/story.md";
    const repairedStory = "# US-001: Repaired Story\n";
    await mkdir(path.dirname(path.join(fixture.root, storyPath)), { recursive: true });
    await writeFile(path.join(fixture.root, storyPath), "# Invalid Story\n", "utf8");
    const providers = new ScriptedProviderPort([
      finalResponse("The Story should already be ready."),
      toolResponse("inspect-invalid-story", "read_file", {
        path: storyPath,
        startLine: 1,
        endLine: 40,
      }),
      finalResponse("I inspected the invalid Story."),
      toolResponse("rewrite-invalid-story", "write_file", {
        path: storyPath,
        content: repairedStory,
        overwrite: true,
      }),
      finalResponse("The repaired Story is ready."),
    ]);
    const invalidError = new AppError(
      "Story 产物未通过质量检查",
      422,
      "OUTPUT_ARTIFACTS_INVALID",
    );
    const rejectedRequiredTools: Array<string | null> = [];

    const result = await new ProviderNativeAgentRuntime(providers).run({
      providerId: "lmstudio",
      instruction: "检查并修复不合格的 Story。",
      messages: [{ role: "user", content: "继续 PM / BA 阶段" }],
      toolHost: await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
        writablePaths: ["artifacts/user-stories"],
        writableDirectoryPaths: ["artifacts/user-stories"],
      }),
      limits: {
        maxToolCalls: 4,
        maxFinalizationRepairs: 1,
        reservedFinalizationToolCalls: 2,
      },
      finalizationCheck: async () => (
        (await readFile(path.join(fixture.root, storyPath), "utf8")) === repairedStory
          ? { ready: true }
          : {
              ready: false,
              feedback: "先读取不合格 Story，再用 write_file 原位修复。",
              error: invalidError,
              repairToolNames: ["read_file", "write_file"],
            }
      ),
      observer: {
        finalizationRejected: ({ requiredToolName }) => {
          rejectedRequiredTools.push(requiredToolName);
        },
      },
    });

    assert.equal(result.stopReason, "completed");
    assert.deepEqual(result.toolSteps.map(({ toolName }) => toolName), [
      "read_file",
      "write_file",
    ]);
    assert.deepEqual(rejectedRequiredTools, ["read_file", "write_file"]);
    assert.deepEqual(
      providers.requests.map(({ request }) => request.toolChoice),
      [
        "auto",
        { type: "function", name: "read_file" },
        "none",
        { type: "function", name: "write_file" },
        "none",
      ],
    );
    assert.equal(await readFile(path.join(fixture.root, storyPath), "utf8"), repairedStory);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: reserved repair tools remain reachable across repeated gate probes", async () => {
  const fixture = await workspaceFixture();
  try {
    const providers = new ScriptedProviderPort([
      toolResponse("normal-one", "list_files", { path: ".", maxDepth: 1, maxEntries: 10 }),
      toolResponse("normal-two", "list_files", { path: ".", maxDepth: 1, maxEntries: 10 }),
      finalResponse("Probe the selected outputs."),
      toolResponse("repair-one", "list_files", { path: ".", maxDepth: 1, maxEntries: 10 }),
      finalResponse("Probe after repair one."),
      toolResponse("repair-two", "list_files", { path: ".", maxDepth: 1, maxEntries: 10 }),
      finalResponse("Probe after repair two."),
      toolResponse("repair-three", "list_files", { path: ".", maxDepth: 1, maxEntries: 10 }),
      finalResponse("Probe after repair three."),
      toolResponse("repair-four", "list_files", { path: ".", maxDepth: 1, maxEntries: 10 }),
      finalResponse("All deterministic repairs are complete."),
    ]);
    const invalidError = new AppError(
      "产物仍未通过质量检查",
      422,
      "OUTPUT_ARTIFACTS_INVALID",
    );
    let checks = 0;
    const rejectedRounds: number[] = [];

    const result = await new ProviderNativeAgentRuntime(providers).run({
      providerId: "openai",
      instruction: "在有界预算内修复阶段产物。",
      messages: [{ role: "user", content: "继续" }],
      toolHost: await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
      }),
      limits: {
        maxToolCalls: 6,
        maxFinalizationRepairs: 2,
        reservedFinalizationToolCalls: 4,
      },
      finalizationCheck: async () => {
        checks += 1;
        return checks >= 5
          ? { ready: true }
          : {
              ready: false,
              feedback: `第 ${checks} 次质量检查仍需工具修复。`,
              error: invalidError,
            };
      },
      observer: {
        finalizationRejected: ({ repairRound }) => {
          rejectedRounds.push(repairRound);
        },
      },
    });

    assert.equal(result.toolSteps.length, 6);
    assert.equal(result.stopReason, "tool-limit-finalized");
    assert.deepEqual(rejectedRounds, [1, 1, 2, 2]);
    assert.deepEqual(
      providers.requests.map(({ request }) => request.toolChoice),
      ["auto", "auto", "none", "required", "none", "required", "none", "required", "none", "required", "none"],
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: structured Blocker repair uses a named scoped tool and canonical renderer", async () => {
  const fixture = await workspaceFixture();
  try {
    const blockerDirectory = "artifacts/user-stories";
    const providers = new ScriptedProviderPort([
      finalResponse("The Blocker needs platform-owned formatting."),
      toolResponse("write-blocker", "write_user_stories_blocker", {
        status: "Pending",
        missingFact: "The final visual direction has not been approved.",
        openQuestion: "Which layout direction should the Product Owner approve?",
        humanOwner: "Product Owner",
        nextStep: "The Product Owner selects a direction and PM / BA writes canonical Stories.",
      }),
      finalResponse("The canonical Blocker is ready."),
    ]);
    const invalidError = new AppError(
      "Blocker sentinel 不合格",
      422,
      "OUTPUT_ARTIFACTS_INVALID",
    );
    const blockerPath = path.join(fixture.root, blockerDirectory, "README.md");
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      writablePaths: [blockerDirectory],
      writableDirectoryPaths: [blockerDirectory],
      userStoriesBlockerDirectory: blockerDirectory,
    });

    const result = await new ProviderNativeAgentRuntime(providers).run({
      providerId: "openai",
      instruction: "事实不足时写结构化 Blocker。",
      messages: [{ role: "user", content: "继续" }],
      toolHost: host,
      limits: {
        maxToolCalls: 4,
        maxFinalizationRepairs: 1,
        reservedFinalizationToolCalls: 2,
      },
      finalizationCheck: async () => {
        try {
          const content = await readFile(blockerPath, "utf8");
          return assessUserStoriesQualityEntries([{
            relativePath: "README.md",
            content,
          }]).valid
            ? { ready: true }
            : {
                ready: false,
                feedback: "请调用结构化 Blocker 工具修复。",
                error: invalidError,
                repairToolNames: ["write_user_stories_blocker"],
              };
        } catch {
          return {
            ready: false,
            feedback: "请调用结构化 Blocker 工具修复。",
            error: invalidError,
            repairToolNames: ["write_user_stories_blocker"],
          };
        }
      },
    });

    assert.equal(result.toolSteps.length, 1);
    assert.deepEqual(providers.requests[1]?.request.toolChoice, {
      type: "function",
      name: "write_user_stories_blocker",
    });
    assert.ok(host.definitions().some(({ name }) => name === "write_user_stories_blocker"));
    const content = await readFile(blockerPath, "utf8");
    assert.equal(content.split(USER_STORIES_BLOCKER_SENTINEL).length - 1, 1);
    assert.deepEqual(
      assessUserStoriesQualityEntries([{ relativePath: "README.md", content }]),
      { valid: true, kind: "blocker" },
    );
    await assert.rejects(
      RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
        writablePaths: ["artifacts/other"],
        writableDirectoryPaths: ["artifacts/other"],
        userStoriesBlockerDirectory: blockerDirectory,
      }),
      (error: unknown) => (
        (error as { code?: string }).code === "AGENT_WRITE_SCOPE_INVALID"
      ),
      "the structured writer cannot be bound outside the selected directory artifact",
    );
    const unconfiguredHost = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      writablePaths: [blockerDirectory],
      writableDirectoryPaths: [blockerDirectory],
    });
    assert.equal(
      unconfiguredHost.definitions().some(({ name }) => name === "write_user_stories_blocker"),
      false,
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: structured Blocker validation exposes a safe field-level tool error", async () => {
  const fixture = await workspaceFixture();
  try {
    const blockerDirectory = "artifacts/user-stories";
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      writablePaths: [blockerDirectory],
      writableDirectoryPaths: [blockerDirectory],
      userStoriesBlockerDirectory: blockerDirectory,
    });

    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "invalid-structured-blocker",
        name: "write_user_stories_blocker",
        arguments: {
          status: "Pending",
          missingFact: "TODO determine owner",
          openQuestion: "Which product role owns the final acceptance decision?",
          humanOwner: "Product Owner",
          nextStep: "The Product Owner confirms the decision before Story authoring.",
        },
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      }),
      (error: unknown) => {
        const toolError = error as { code?: string; message?: string; safeMessage?: string };
        assert.equal(toolError.code, "AGENT_USER_STORIES_BLOCKER_INVALID");
        assert.equal(toolError.message, toolError.safeMessage);
        assert.match(toolError.safeMessage ?? "", /Missing facts/u);
        assert.doesNotMatch(toolError.safeMessage ?? "", /TODO determine owner|artifacts\//u);
        return true;
      },
    );
    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "self-referential-structured-blocker",
        name: "write_user_stories_blocker",
        arguments: {
          status: "Blocked",
          missingFact: "Existing blocker in user-stories root prevents modifying stories.",
          openQuestion: "Is the blocker resolved or should we proceed with new PRD only?",
          humanOwner: "PM/BA",
          nextStep: "Await human confirmation to remove blocker before editing stories.",
        },
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      }),
      (error: unknown) => {
        const toolError = error as { code?: string; message?: string; safeMessage?: string };
        assert.equal(toolError.code, "AGENT_USER_STORIES_BLOCKER_INVALID");
        assert.equal(toolError.message, toolError.safeMessage);
        assert.match(toolError.safeMessage ?? "", /产品或业务事实/u);
        assert.match(toolError.safeMessage ?? "", /平台迁移顺序/u);
        assert.doesNotMatch(
          toolError.safeMessage ?? "",
          /Existing blocker in user-stories root|artifacts\//u,
        );
        return true;
      },
    );
    await assert.rejects(
      readFile(path.join(fixture.root, blockerDirectory, "README.md"), "utf8"),
      "invalid structured content must not create a Blocker file",
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-DECISION-BATCH-05: the structured Blocker tool writes every fact and question in one call", async () => {
  const fixture = await workspaceFixture();
  try {
    const blockerDirectory = "artifacts/batched-user-stories";
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      writablePaths: [blockerDirectory],
      writableDirectoryPaths: [blockerDirectory],
      userStoriesBlockerDirectory: blockerDirectory,
    });
    const definition = host.definitions().find(({ name }) => name === "write_user_stories_blocker");
    assert.ok(definition);
    const parameters = definition.parameters as {
      required?: string[];
      properties?: Record<string, { type?: string; minItems?: number; maxItems?: number }>;
    };
    assert.deepEqual(parameters.required, [
      "status",
      "missingFacts",
      "openQuestions",
      "humanOwner",
      "nextStep",
    ]);
    assert.deepEqual(parameters.properties?.missingFacts, {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: { type: "string", minLength: 6, maxLength: 800 },
    });
    assert.deepEqual(parameters.properties?.openQuestions, {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: { type: "string", minLength: 6, maxLength: 800 },
    });
    assert.equal(parameters.properties?.missingFact, undefined);
    assert.equal(parameters.properties?.openQuestion, undefined);

    await host.execute({
      type: "function",
      id: "batched-structured-blocker",
      name: "write_user_stories_blocker",
      arguments: {
        status: "Pending",
        missingFacts: [
          "The AI SDLC presentation format has not been selected.",
          "The repository-link policy has not been selected.",
        ],
        openQuestions: [
          "Should AI SDLC experience use cards or a table?",
          "Should project entries include repository links?",
          "Which AI SDLC experiences should be highlighted?",
        ],
        humanOwner: "Product Owner",
        nextStep: "The Product Owner answers every question before Story authoring.",
      },
    }, {
      signal: new AbortController().signal,
      maxOutputCharacters: 10_000,
    });
    const content = await readFile(path.join(fixture.root, blockerDirectory, "README.md"), "utf8");
    assert.match(content, /- The AI SDLC presentation format has not been selected\./u);
    assert.match(content, /- The repository-link policy has not been selected\./u);
    assert.match(content, /- Should AI SDLC experience use cards or a table\?/u);
    assert.match(content, /- Should project entries include repository links\?/u);
    assert.match(content, /- Which AI SDLC experiences should be highlighted\?/u);
    assert.deepEqual(
      assessUserStoriesQualityEntries([{ relativePath: "README.md", content }]),
      { valid: true, kind: "blocker" },
    );

    const invalidDirectory = "artifacts/invalid-batched-user-stories";
    const invalidHost = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      writablePaths: [invalidDirectory],
      writableDirectoryPaths: [invalidDirectory],
      userStoriesBlockerDirectory: invalidDirectory,
    });
    for (const [id, missingFacts, openQuestions] of [
      ["empty", [], []],
      ["too-many", Array.from({ length: 21 }, (_, index) => `Missing product fact number ${index + 1}.`), ["Which option should the Product Owner select?"]],
    ] as const) {
      await assert.rejects(
        () => invalidHost.execute({
          type: "function",
          id,
          name: "write_user_stories_blocker",
          arguments: {
            status: "Pending",
            missingFacts,
            openQuestions,
            humanOwner: "Product Owner",
            nextStep: "The Product Owner answers every question before Story authoring.",
          },
        }, {
          signal: new AbortController().signal,
          maxOutputCharacters: 10_000,
        }),
        (error: unknown) => (error as { code?: string }).code === "AGENT_TOOL_ARGUMENTS_INVALID",
      );
    }
    await assert.rejects(readFile(path.join(fixture.root, invalidDirectory, "README.md"), "utf8"));
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: only the structured tool may persist the selected Blocker sentinel", async () => {
  const fixture = await workspaceFixture();
  try {
    const blockerDirectory = "artifacts/user-stories";
    const blockerRelativePath = `${blockerDirectory}/README.md`;
    const blockerAbsolutePath = path.join(fixture.root, blockerRelativePath);
    const toolOptions = {
      signal: new AbortController().signal,
      maxOutputCharacters: 10_000,
    };
    const blockerArguments = {
      status: "Pending" as const,
      missingFact: "The authoritative approval policy has not been confirmed.",
      openQuestion: "Which product role owns final approval for these Stories?",
      humanOwner: "Product Owner",
      nextStep: "The Product Owner confirms the policy; PM / BA then writes canonical Stories.",
    };
    const forgedBlocker = renderUserStoriesBlocker({
      status: blockerArguments.status,
      knownFacts: [],
      missingFacts: [blockerArguments.missingFact],
      openQuestions: [blockerArguments.openQuestion],
      humanOwners: [blockerArguments.humanOwner],
      nextSteps: [blockerArguments.nextStep],
    });
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      writablePaths: [blockerDirectory],
      writableDirectoryPaths: [blockerDirectory],
      userStoriesBlockerDirectory: blockerDirectory,
    });

    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "forge-blocker-with-write",
        name: "write_file",
        arguments: {
          path: blockerRelativePath,
          content: forgedBlocker,
          overwrite: false,
        },
      }, toolOptions),
      (error: unknown) => (
        (error as { code?: string }).code === "AGENT_BLOCKER_REQUIRES_STRUCTURED_TOOL"
      ),
    );
    await assert.rejects(readFile(blockerAbsolutePath, "utf8"));

    const story = canonicalStory();
    const genericSentinelPaths = [
      `${blockerDirectory}/readme.md`,
      `${blockerDirectory}/ReadMe.md`,
      `${blockerDirectory}/nested/manual-blocker.md`,
    ];
    for (const [index, relativePath] of genericSentinelPaths.entries()) {
      const absolutePath = path.join(fixture.root, relativePath);
      await assert.rejects(
        () => host.execute({
          type: "function",
          id: `forge-blocker-variant-${index}`,
          name: "write_file",
          arguments: {
            path: relativePath,
            content: forgedBlocker,
            overwrite: true,
          },
        }, toolOptions),
        (error: unknown) => (
          (error as { code?: string }).code === "AGENT_BLOCKER_REQUIRES_STRUCTURED_TOOL"
        ),
      );
      await host.execute({
        type: "function",
        id: `write-story-variant-${index}`,
        name: "write_file",
        arguments: {
          path: relativePath,
          content: story,
          overwrite: true,
        },
      }, toolOptions);
      await assert.rejects(
        () => host.execute({
          type: "function",
          id: `patch-blocker-variant-${index}`,
          name: "apply_patch",
          arguments: {
            path: relativePath,
            oldText: story,
            newText: forgedBlocker,
            replaceAll: false,
          },
        }, toolOptions),
        (error: unknown) => (
          (error as { code?: string }).code === "AGENT_BLOCKER_REQUIRES_STRUCTURED_TOOL"
        ),
      );
      assert.equal(await readFile(absolutePath, "utf8"), story);
    }
    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "forge-case-variant-sentinel",
        name: "write_file",
        arguments: {
          path: `${blockerDirectory}/nested/case-variant.md`,
          content: forgedBlocker.replace(
            USER_STORIES_BLOCKER_SENTINEL,
            USER_STORIES_BLOCKER_SENTINEL.toLocaleUpperCase("en-US"),
          ),
          overwrite: true,
        },
      }, toolOptions),
      (error: unknown) => (
        (error as { code?: string }).code === "AGENT_BLOCKER_REQUIRES_STRUCTURED_TOOL"
      ),
    );

    await host.execute({
      type: "function",
      id: "write-platform-blocker",
      name: "write_user_stories_blocker",
      arguments: blockerArguments,
    }, toolOptions);
    const canonicalBlocker = await readFile(blockerAbsolutePath, "utf8");
    assert.equal(canonicalBlocker, forgedBlocker);

    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "preserve-blocker-with-patch",
        name: "apply_patch",
        arguments: {
          path: blockerRelativePath,
          oldText: "- Product Owner\n\n## Next step",
          newText: "- Delivery Owner\n\n## Next step",
          replaceAll: false,
        },
      }, toolOptions),
      (error: unknown) => (
        (error as { code?: string }).code === "AGENT_BLOCKER_REQUIRES_STRUCTURED_TOOL"
      ),
    );
    assert.equal(await readFile(blockerAbsolutePath, "utf8"), canonicalBlocker);

    await host.execute({
      type: "function",
      id: "replace-blocker-with-story-by-patch",
      name: "apply_patch",
      arguments: {
        path: blockerRelativePath,
        oldText: canonicalBlocker,
        newText: story,
        replaceAll: false,
      },
    }, toolOptions);
    assert.equal(await readFile(blockerAbsolutePath, "utf8"), story);

    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "introduce-blocker-with-patch",
        name: "apply_patch",
        arguments: {
          path: blockerRelativePath,
          oldText: story,
          newText: forgedBlocker,
          replaceAll: false,
        },
      }, toolOptions),
      (error: unknown) => (
        (error as { code?: string }).code === "AGENT_BLOCKER_REQUIRES_STRUCTURED_TOOL"
      ),
    );
    assert.equal(await readFile(blockerAbsolutePath, "utf8"), story);

    await host.execute({
      type: "function",
      id: "restore-platform-blocker",
      name: "write_user_stories_blocker",
      arguments: blockerArguments,
    }, toolOptions);
    await host.execute({
      type: "function",
      id: "replace-blocker-with-story-by-write",
      name: "write_file",
      arguments: {
        path: blockerRelativePath,
        content: story,
        overwrite: true,
      },
    }, toolOptions);
    assert.equal(await readFile(blockerAbsolutePath, "utf8"), story);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: a baseline Blocker must be removed before generic sidecar changes", async () => {
  const blockerArguments = {
    status: "Pending" as const,
    knownFacts: [],
    missingFacts: ["The authoritative approval policy has not been confirmed."],
    openQuestions: ["Which product role owns final approval for these Stories?"],
    humanOwners: ["Product Owner"],
    nextSteps: ["The Product Owner confirms the policy; PM / BA then writes canonical Stories."],
  };
  const blocker = renderUserStoriesBlocker(blockerArguments);
  for (const [index, readmeName] of ["README.md", "readme.md", "ReadMe.md"].entries()) {
    const fixture = await workspaceFixture();
    try {
      const storiesDirectory = "artifacts/user-stories";
      const blockerPath = `${storiesDirectory}/${readmeName}`;
      const notesPath = `${storiesDirectory}/notes.md`;
      await mkdir(path.join(fixture.root, storiesDirectory), { recursive: true });
      await writeFile(path.join(fixture.root, blockerPath), blocker, "utf8");
      await writeFile(path.join(fixture.root, notesPath), "# Notes\n\nBaseline notes.\n", "utf8");
      const host = await RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
        writablePaths: [storiesDirectory],
        writableDirectoryPaths: [storiesDirectory],
        userStoriesBlockerDirectory: storiesDirectory,
      });
      const toolOptions = {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      };

      await assert.rejects(
        () => host.execute({
          type: "function",
          id: `write-sidecar-before-migration-${index}`,
          name: "write_file",
          arguments: {
            path: `${storiesDirectory}/new-sidecar.md`,
            content: "# New sidecar\n",
            overwrite: false,
          },
        }, toolOptions),
        (error: unknown) => {
          const toolError = error as { code?: string; safeMessage?: string };
          assert.equal(toolError.code, "AGENT_BLOCKER_MIGRATION_REQUIRED");
          assert.match(toolError.safeMessage ?? "", /平台产物迁移顺序/u);
          assert.match(toolError.safeMessage ?? "", /不是产品或业务缺失事实/u);
          assert.match(toolError.safeMessage ?? "", /不得把本错误/u);
          return true;
        },
      );
      await assert.rejects(
        () => host.execute({
          type: "function",
          id: `patch-sidecar-before-migration-${index}`,
          name: "apply_patch",
          arguments: {
            path: notesPath,
            oldText: "Baseline notes.",
            newText: "Changed notes.",
            replaceAll: false,
          },
        }, toolOptions),
        (error: unknown) => (
          (error as { code?: string }).code === "AGENT_BLOCKER_MIGRATION_REQUIRED"
        ),
      );
      assert.equal(
        await readFile(path.join(fixture.root, notesPath), "utf8"),
        "# Notes\n\nBaseline notes.\n",
      );

      await host.execute({
        type: "function",
        id: `remove-baseline-blocker-${index}`,
        name: "write_file",
        arguments: {
          path: blockerPath,
          content: "# User Stories\n\nThe Blocker is being replaced by canonical Story files.\n",
          overwrite: true,
        },
      }, toolOptions);
      await host.execute({
        type: "function",
        id: `patch-sidecar-after-migration-${index}`,
        name: "apply_patch",
        arguments: {
          path: notesPath,
          oldText: "Baseline notes.",
          newText: "Changed notes.",
          replaceAll: false,
        },
      }, toolOptions);
      const storyPath = `${storiesDirectory}/feature-${index}/US-001-review/story.md`;
      await host.execute({
        type: "function",
        id: `write-story-after-migration-${index}`,
        name: "write_file",
        arguments: {
          path: storyPath,
          content: canonicalStory(),
          overwrite: false,
        },
      }, toolOptions);
      assert.match(await readFile(path.join(fixture.root, notesPath), "utf8"), /Changed notes/u);
      assert.match(await readFile(path.join(fixture.root, storyPath), "utf8"), /# US-001:/u);
      assert.doesNotMatch(
        await readFile(path.join(fixture.root, blockerPath), "utf8"),
        new RegExp(escapeRegExp(USER_STORIES_BLOCKER_SENTINEL), "iu"),
      );
    } finally {
      await fixture.dispose();
    }
  }
});

test("CHAT-AC-29: generic provenance refreshes Blocker state after external workspace changes", async () => {
  const fixture = await workspaceFixture();
  try {
    const storiesDirectory = "artifacts/user-stories";
    const blockerPath = `${storiesDirectory}/README.md`;
    const notesPath = `${storiesDirectory}/notes.md`;
    await mkdir(path.join(fixture.root, storiesDirectory), { recursive: true });
    await writeFile(path.join(fixture.root, notesPath), "# Notes\n\nBaseline notes.\n", "utf8");
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      writablePaths: [storiesDirectory],
      writableDirectoryPaths: [storiesDirectory],
      userStoriesBlockerDirectory: storiesDirectory,
    });
    const toolOptions = {
      signal: new AbortController().signal,
      maxOutputCharacters: 10_000,
    };
    const blocker = renderUserStoriesBlocker({
      status: "Pending",
      knownFacts: [],
      missingFacts: ["The authoritative approval policy has not been confirmed."],
      openQuestions: ["Which product role owns final approval for these Stories?"],
      humanOwners: ["Product Owner"],
      nextSteps: ["The Product Owner confirms the policy; PM / BA then writes canonical Stories."],
    });

    await writeFile(path.join(fixture.root, blockerPath), blocker, "utf8");
    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "write-sidecar-after-external-blocker-add",
        name: "write_file",
        arguments: {
          path: `${storiesDirectory}/new-sidecar.md`,
          content: "# New sidecar\n",
          overwrite: false,
        },
      }, toolOptions),
      (error: unknown) => (
        (error as { code?: string }).code === "AGENT_BLOCKER_MIGRATION_REQUIRED"
      ),
    );
    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "patch-sidecar-after-external-blocker-add",
        name: "apply_patch",
        arguments: {
          path: notesPath,
          oldText: "Baseline notes.",
          newText: "Changed notes.",
          replaceAll: false,
        },
      }, toolOptions),
      (error: unknown) => (
        (error as { code?: string }).code === "AGENT_BLOCKER_MIGRATION_REQUIRED"
      ),
    );

    await writeFile(
      path.join(fixture.root, blockerPath),
      "# User Stories\n\nThe external editor removed the Blocker sentinel.\n",
      "utf8",
    );
    await host.execute({
      type: "function",
      id: "write-sidecar-after-external-blocker-remove",
      name: "write_file",
      arguments: {
        path: `${storiesDirectory}/new-sidecar.md`,
        content: "# New sidecar\n",
        overwrite: false,
      },
    }, toolOptions);
    await host.execute({
      type: "function",
      id: "patch-sidecar-after-external-blocker-remove",
      name: "apply_patch",
      arguments: {
        path: notesPath,
        oldText: "Baseline notes.",
        newText: "Changed notes.",
        replaceAll: false,
      },
    }, toolOptions);
    assert.match(await readFile(path.join(fixture.root, notesPath), "utf8"), /Changed notes/u);
    assert.equal(
      await readFile(path.join(fixture.root, `${storiesDirectory}/new-sidecar.md`), "utf8"),
      "# New sidecar\n",
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: a non-Ollama Provider cannot ignore a required tool choice", async () => {
  const fixture = await workspaceFixture();
  try {
    const providers = new ScriptedProviderPort([
      finalResponse("I will not call the required tool yet."),
      finalResponse("I still will not call the required tool."),
      finalResponse("I will continue explaining instead of calling the tool."),
    ]);
    await assert.rejects(
      new ProviderNativeAgentRuntime(providers).run({
        providerId: "openai",
        instruction: "必须先检查工作区。",
        messages: [{ role: "user", content: "继续" }],
        toolHost: await RootedAgentToolHost.create({
          rootPath: fixture.root,
          accessMode: "sandbox-write",
        }),
        requireInitialTool: true,
      }),
      (error: unknown) => (
        (error as { code?: string }).code === "AGENT_PROVIDER_REQUIRED_TOOL_MISSING"
      ),
    );
    assert.equal(providers.requests.length, 3);
    assert.deepEqual(
      providers.requests.map(({ request }) => request.toolChoice),
      ["required", "required", "required"],
    );
    assert.match(
      providers.requests[1]?.request.messages.at(-1)?.content ?? "",
      /"platformRequiredToolRetry":true/u,
    );
    assert.match(
      providers.requests[2]?.request.messages.at(-1)?.content ?? "",
      /"attempt":2/u,
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: phase executor requires every selected output to be non-empty and rolls back a failed correction", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    await mkdir(path.dirname(prd.absolutePath), { recursive: true });
    await writeFile(prd.absolutePath, "  \n\t", "utf8");
    await rm(stories.absolutePath, { recursive: true, force: true });

    const rawProviderText = "premature success from /srv/private/provider-body.json";
    const successfulProviders = new ScriptedProviderPort([
      toolResponse("replace-empty-prd", "write_file", {
        path: prd.relativePath,
        content: "# Corrected PRD\n\nThe product objective, scope, and review boundary are defined.\n",
        overwrite: true,
      }),
      finalResponse(rawProviderText),
      toolResponse("write-story", "write_file", {
        path: `${stories.relativePath}/review/US-001-review-proposal/story.md`,
        content: canonicalStory(),
        overwrite: false,
      }),
      finalResponse("selected outputs completed"),
    ]);
    const successEvents: string[] = [];
    const successfulResult = await phaseExecutor(fixture.root, successfulProviders).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [prd.id, stories.id],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "openai",
      messages: [{ role: "user", content: "完成发现阶段" }],
    }, async (eventType) => { successEvents.push(eventType); });

    assert.deepEqual(
      successfulResult.artifacts.map(({ artifactKey }) => artifactKey),
      ["prd", "user-stories"],
    );
    assert.ok(successEvents.includes("runner.started"));
    assert.ok(successEvents.includes("runner.completed"));
    const feedback = successfulProviders.requests[2]?.request.messages.at(-1)?.content ?? "";
    assert.ok(
      successfulProviders.requests[2]?.request.tools?.some(({ name }) => name === "write_file"),
    );
    assert.doesNotMatch(feedback, /(?:^|[^a-z])prd(?:[^a-z]|$)/iu, "the repaired PRD is no longer missing");
    assert.match(feedback, /user-stories/u);
    assert.match(feedback, /"repairMode":"story-or-blocker"/u);
    assert.doesNotMatch(feedback, new RegExp(escapeRegExp(fixture.root), "u"));
    assert.doesNotMatch(feedback, new RegExp(escapeRegExp(rawProviderText), "u"));

    const baseline = "# Previously reviewed PRD\n";
    await writeFile(prd.absolutePath, baseline, "utf8");
    await rm(stories.absolutePath, { recursive: true, force: true });
    const leakedProviderText = "RAW_PROVIDER_BODY /opt/service/secrets/provider.json";
    const missingStoryRepairs = Array.from({ length: 4 }, (_, index) => [
      toolResponse(`inspect-missing-story-${index + 1}`, "list_files", {
        path: ".",
        maxDepth: 1,
        maxEntries: 10,
      }),
      finalResponse(leakedProviderText),
    ]).flat();
    const failingProviders = new ScriptedProviderPort([
      toolResponse("replace-prd-before-failure", "write_file", {
        path: prd.relativePath,
        content: "# Replacement that must be rolled back\n",
        overwrite: true,
      }),
      ...Array.from({ length: 7 }, (_, index) => toolResponse(
        `inspect-before-finalization-${index + 1}`,
        "list_files",
        { path: ".", maxDepth: 1, maxEntries: 10 },
      )),
      finalResponse(leakedProviderText),
      ...missingStoryRepairs,
    ]);
    let observedError: unknown;
    try {
      await phaseExecutor(fixture.root, failingProviders).run({
        executionId: randomUUID(),
        project: fixture.project,
        run: fixture.run,
        phase,
        definition: fixture.definition,
        selectedArtifacts: [],
        selectedOutputKeys: [prd.id, stories.id],
        model: "selected-model",
        reasoningEffort: null,
      }, {
        providerId: "custom",
        messages: [{ role: "user", content: "重试发现阶段" }],
      }, async () => undefined);
    } catch (error) {
      observedError = error;
    }

    assert.ok(observedError instanceof AppError);
    assert.equal(observedError.code, "OUTPUT_ARTIFACTS_MISSING");
    assert.match(observedError.message, /user-stories/u);
    assert.doesNotMatch(observedError.message, /(?:^|[^a-z])prd(?:[^a-z]|$)/iu);
    assert.doesNotMatch(observedError.message, new RegExp(escapeRegExp(fixture.root), "u"));
    assert.doesNotMatch(observedError.message, new RegExp(escapeRegExp(leakedProviderText), "u"));
    assert.equal(failingProviders.requests.length, 17);
    assert.equal(await readFile(prd.absolutePath, "utf8"), baseline);
    await assert.rejects(readFile(stories.absolutePath, "utf8"));
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: Discovery repairs a placeholder-only user-stories directory in the same Provider loop", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const placeholder = "# User stories\n\nActual story files should be added before review.\n";
    const providers = new ScriptedProviderPort([
      toolResponse("create-prd-parent", "create_directory", {
        path: path.dirname(prd.relativePath),
      }),
      toolResponse("write-prd", "write_file", {
        path: prd.relativePath,
        content: "# Reviewable PRD\n\nThe product outcome and acceptance boundary are defined.\n",
        overwrite: false,
      }),
      toolResponse("create-stories", "create_directory", {
        path: stories.relativePath,
      }),
      toolResponse("write-placeholder", "write_file", {
        path: `${stories.relativePath}/README.md`,
        content: placeholder,
        overwrite: false,
      }),
      finalResponse("Discovery is complete even though the directory only has a placeholder."),
      toolResponse("write-real-story", "write_file", {
        path: `${stories.relativePath}/review/US-001-review-proposal/story.md`,
        content: canonicalStory(),
        overwrite: false,
      }),
      finalResponse("A reviewable Story now exists."),
    ]);

    const result = await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [prd.id, stories.id],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "openai",
      messages: [{ role: "user", content: "完成 Discovery" }],
    }, async () => undefined);

    assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), [
      "prd",
      "user-stories",
    ]);
    assert.equal(providers.requests.length, 7, "placeholder completion must be corrected in-loop");
    const correctionFeedback = providers.requests[5]?.request.messages.at(-1)?.content ?? "";
    assert.match(correctionFeedback, /user-stories/u);
    assert.match(correctionFeedback, /Story/u);
    assert.match(correctionFeedback, /STORY_NONCANONICAL_CONTENT_REQUIRES_STORY/u);
    assert.match(correctionFeedback, /"repairMode":"story"/u);
    assert.deepEqual(providers.requests[5]?.request.toolChoice, {
      type: "function",
      name: "write_file",
    });
    assert.doesNotMatch(correctionFeedback, new RegExp(escapeRegExp(fixture.root), "u"));
    assert.doesNotMatch(correctionFeedback, new RegExp(escapeRegExp(placeholder.trim()), "u"));
    assert.match(
      await readFile(
        path.join(stories.absolutePath, "review/US-001-review-proposal/story.md"),
        "utf8",
      ),
      /US-001-AC-02/u,
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29 adversarial: a committed Story repair cannot blank its placeholder and reopen Blocker", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const readmePath = `${stories.relativePath}/README.md`;
    const storyPath = `${stories.relativePath}/review/US-001-review-proposal/story.md`;
    const providers = new ScriptedProviderPort([
      toolResponse("create-prd-parent-before-blank", "create_directory", {
        path: path.dirname(prd.relativePath),
      }),
      toolResponse("write-prd-before-blank", "write_file", {
        path: prd.relativePath,
        content: "# Reviewable PRD\n\nThe product outcome and acceptance boundary are defined.\n",
        overwrite: false,
      }),
      toolResponse("create-stories-before-blank", "create_directory", {
        path: stories.relativePath,
      }),
      toolResponse("write-placeholder-before-blank", "write_file", {
        path: readmePath,
        content: "# User stories\n\nActual story files should be added before review.\n",
        overwrite: false,
      }),
      finalResponse("The placeholder is sufficient."),
      toolResponse("blank-placeholder", "write_file", {
        path: readmePath,
        content: "",
        overwrite: true,
      }),
      finalResponse("The empty directory should allow a Blocker now."),
      toolResponse("read-empty-placeholder", "read_file", {
        path: readmePath,
        startLine: 1,
        endLine: 80,
      }),
      finalResponse("The empty placeholder was inspected."),
      toolResponse("write-story-after-blank", "write_file", {
        path: storyPath,
        content: canonicalStory(),
        overwrite: false,
      }),
      finalResponse("The committed Story branch is now reviewable."),
    ]);

    const result = await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [prd.id, stories.id],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "lmstudio",
      messages: [{ role: "user", content: "完成 Discovery" }],
    }, async () => undefined);

    assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), [
      "prd",
      "user-stories",
    ]);
    assert.equal(providers.requests.length, 11);
    const initialStoryFeedback = providers.requests[5]?.request.messages.at(-1)?.content ?? "";
    assert.match(initialStoryFeedback, /STORY_NONCANONICAL_CONTENT_REQUIRES_STORY/u);
    assert.match(initialStoryFeedback, /"repairMode":"story"/u);
    assert.deepEqual(providers.requests[5]?.request.toolChoice, {
      type: "function",
      name: "write_file",
    });

    const lockedStoryFeedback = providers.requests[7]?.request.messages.at(-1)?.content ?? "";
    assert.match(lockedStoryFeedback, /STORY_CANONICAL_FILE_REQUIRED/u);
    assert.match(lockedStoryFeedback, /"repairMode":"story"/u);
    assert.match(lockedStoryFeedback, /Story-only|保持锁定/u);
    assert.doesNotMatch(lockedStoryFeedback, /"repairMode":"story-or-blocker"/u);
    assert.doesNotMatch(lockedStoryFeedback, /事实不足时(?:改写|调用).*Blocker/u);
    assert.deepEqual(providers.requests[7]?.request.toolChoice, {
      type: "function",
      name: "read_file",
    });
    assert.deepEqual(providers.requests[9]?.request.toolChoice, {
      type: "function",
      name: "write_file",
    });
    assert.match(await readFile(path.join(fixture.root, storyPath), "utf8"), /US-001-AC-02/u);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: repeated placeholder-only user-stories fail with OUTPUT_ARTIFACTS_INVALID and roll back", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const placeholder = "# User stories\n\nActual story files should be added before review.\n";
    const rawProviderText = "placeholder is sufficient; source=/srv/private/provider-output.json";
    const invalidRepairs = Array.from({ length: 8 }, (_, index) => [
      toolResponse(`rewrite-invalid-readme-${index + 1}`, "write_file", {
        path: `${stories.relativePath}/README.md`,
        content: placeholder,
        overwrite: true,
      }),
      finalResponse(rawProviderText),
    ]).flat();
    const providers = new ScriptedProviderPort([
      toolResponse("create-prd-parent-before-invalid", "create_directory", {
        path: path.dirname(prd.relativePath),
      }),
      toolResponse("write-prd-before-invalid", "write_file", {
        path: prd.relativePath,
        content: "# PRD that must be rolled back\n",
        overwrite: false,
      }),
      toolResponse("create-invalid-stories", "create_directory", {
        path: stories.relativePath,
      }),
      toolResponse("write-invalid-readme", "write_file", {
        path: `${stories.relativePath}/README.md`,
        content: placeholder,
        overwrite: false,
      }),
      finalResponse(rawProviderText),
      ...invalidRepairs,
    ]);
    let observedError: unknown;
    try {
      await phaseExecutor(fixture.root, providers).run({
        executionId: randomUUID(),
        project: fixture.project,
        run: fixture.run,
        phase,
        definition: fixture.definition,
        selectedArtifacts: [],
        selectedOutputKeys: [prd.id, stories.id],
        model: "selected-model",
        reasoningEffort: null,
      }, {
        providerId: "custom",
        messages: [{ role: "user", content: "完成 Discovery" }],
      }, async () => undefined);
    } catch (error) {
      observedError = error;
    }

    assert.ok(observedError instanceof AppError);
    assert.equal(observedError.code, "OUTPUT_ARTIFACTS_INVALID");
    assert.deepEqual(
      (observedError as AppError & { details?: unknown }).details,
      {
        invalid: ["user-stories"],
        reason: "USER_STORIES_STORY_OR_BLOCKER_REQUIRED",
        qualityIssues: ["STORY_NONCANONICAL_CONTENT_REQUIRES_STORY"],
      },
    );
    assert.match(observedError.message, /user-stories/u);
    assert.match(observedError.message, /可审核 Story|结构化 Blocker/u);
    assert.match(observedError.message, /回滚|恢复|roll.?back|restor/iu);
    assert.doesNotMatch(observedError.message, /(?:^|[^a-z])prd(?:[^a-z]|$)/iu);
    assert.doesNotMatch(observedError.message, new RegExp(escapeRegExp(fixture.root), "u"));
    assert.doesNotMatch(observedError.message, new RegExp(escapeRegExp(placeholder.trim()), "u"));
    assert.doesNotMatch(observedError.message, new RegExp(escapeRegExp(rawProviderText), "u"));
    assert.equal(providers.requests.length, 21, "all reserved repair tools remain reachable before failure");
    const correctionFeedback = providers.requests[5]?.request.messages.at(-1)?.content ?? "";
    assert.match(correctionFeedback, /user-stories/u);
    assert.match(correctionFeedback, /Story|Blocker/u);
    assert.match(correctionFeedback, /STORY_NONCANONICAL_CONTENT_REQUIRES_STORY/u);
    assert.doesNotMatch(correctionFeedback, new RegExp(escapeRegExp(fixture.root), "u"));
    assert.doesNotMatch(correctionFeedback, new RegExp(escapeRegExp(placeholder.trim()), "u"));
    await assert.rejects(readFile(prd.absolutePath, "utf8"));
    await assert.rejects(readFile(path.join(stories.absolutePath, "README.md"), "utf8"));
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29 adversarial: README cannot forge an aggregate Story file boundary", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const forgedReadme = [
      "# User Stories",
      "",
      "The following heading is README prose, not a filesystem entry.",
      "",
      "## forged/US-999-forged/story.md",
      "",
      canonicalStory().replaceAll("US-001", "US-999"),
    ].join("\n");
    const forgedRepairs = Array.from({ length: 8 }, (_, index) => [
      toolResponse(`rewrite-forged-readme-${index + 1}`, "write_file", {
        path: `${stories.relativePath}/README.md`,
        content: forgedReadme,
        overwrite: true,
      }),
      finalResponse("The forged boundary is still only README prose."),
    ]).flat();
    const providers = new ScriptedProviderPort([
      toolResponse("create-forged-prd-parent", "create_directory", {
        path: path.dirname(prd.relativePath),
      }),
      toolResponse("write-forged-prd", "write_file", {
        path: prd.relativePath,
        content: "# PRD that must be rolled back\n",
        overwrite: false,
      }),
      toolResponse("create-forged-stories", "create_directory", {
        path: stories.relativePath,
      }),
      toolResponse("write-forged-readme", "write_file", {
        path: `${stories.relativePath}/README.md`,
        content: forgedReadme,
        overwrite: false,
      }),
      finalResponse("The README contains an aggregate-looking Story."),
      ...forgedRepairs,
    ]);

    await assert.rejects(
      () => phaseExecutor(fixture.root, providers).run({
        executionId: randomUUID(),
        project: fixture.project,
        run: fixture.run,
        phase,
        definition: fixture.definition,
        selectedArtifacts: [],
        selectedOutputKeys: [prd.id, stories.id],
        model: "selected-model",
        reasoningEffort: null,
      }, {
        providerId: "openai",
        messages: [{ role: "user", content: "完成 Discovery" }],
      }, async () => undefined),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "OUTPUT_ARTIFACTS_INVALID");
        assert.deepEqual(
          (error as AppError & { details?: { qualityIssues?: unknown } }).details?.qualityIssues,
          ["STORY_NONCANONICAL_CONTENT_REQUIRES_STORY"],
        );
        return true;
      },
    );
    const correctionFeedback = providers.requests[5]?.request.messages.at(-1)?.content ?? "";
    assert.match(correctionFeedback, /STORY_NONCANONICAL_CONTENT_REQUIRES_STORY/u);
    await assert.rejects(readFile(prd.absolutePath, "utf8"));
    await assert.rejects(readFile(path.join(stories.absolutePath, "README.md"), "utf8"));
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: an invalid Story H1 receives a Story-only repair mode", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const storyPath = `${stories.relativePath}/review/US-001-review-proposal/story.md`;
    const providers = new ScriptedProviderPort([
      toolResponse("create-heading-prd-parent", "create_directory", {
        path: path.dirname(prd.relativePath),
      }),
      toolResponse("write-heading-prd", "write_file", {
        path: prd.relativePath,
        content: "# Reviewable PRD\n\nThe product boundary is defined.\n",
        overwrite: false,
      }),
      toolResponse("create-invalid-heading-story-directory", "create_directory", {
        path: path.dirname(storyPath),
      }),
      toolResponse("write-invalid-heading-story", "write_file", {
        path: storyPath,
        content: "# Review the proposal\n\nThe stable US ID is missing from this H1.\n",
        overwrite: false,
      }),
      finalResponse("The Story body exists."),
      toolResponse("inspect-invalid-heading-story", "read_file", {
        path: storyPath,
        startLine: 1,
        endLine: 120,
      }),
      finalResponse("The invalid Story has been inspected."),
      toolResponse("repair-story-heading", "write_file", {
        path: storyPath,
        content: canonicalStory(),
        overwrite: true,
      }),
      finalResponse("The existing Story has been repaired."),
    ]);

    const result = await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [prd.id, stories.id],
      productDecisionMaterializationRequired: true,
      revisionFeedback: [
        "Use the recorded best-practice layout and project links; do not create another decision.",
      ],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "openai",
      messages: [{ role: "user", content: "完成 Discovery" }],
    }, async () => undefined);

    assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), [
      "prd",
      "user-stories",
    ]);
    const correctionFeedback = providers.requests[5]?.request.messages.at(-1)?.content ?? "";
    assert.match(correctionFeedback, /STORY_HEADING_INVALID/u);
    assert.match(correctionFeedback, /"repairMode":"story"/u);
    assert.doesNotMatch(correctionFeedback, /"repairMode":"story-or-blocker"/u);
    assert.match(correctionFeedback, /write_file/u);
    assert.match(correctionFeedback, /overwrite=true/u);
    assert.match(correctionFeedback, /不要继续猜测 oldText 或重复 apply_patch/u);
    assert.match(await readFile(path.join(fixture.root, storyPath), "utf8"), /# US-001:/u);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: an answered Story Blocker is forced back into Story materialization", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const blockerToolArguments = {
      status: "Pending",
      missingFact: "The profile visual theme has not been confirmed.",
      openQuestion: "Should the profile use the red or blue visual theme?",
      humanOwner: "Product Owner",
      nextStep: "Create the profile redesign Story after the Product Owner answers.",
    };
    const readmePath = `${stories.relativePath}/README.md`;
    const storyPath = `${stories.relativePath}/profile/US-101-profile-redesign/story.md`;
    const providers = new ScriptedProviderPort([
      toolResponse("create-answered-prd-parent", "create_directory", {
        path: path.dirname(prd.relativePath),
      }),
      toolResponse("write-answered-prd", "write_file", {
        path: prd.relativePath,
        content: "# Profile redesign PRD\n\nUse the confirmed red theme and flexible layout.\n",
        overwrite: false,
      }),
      toolResponse("create-answered-stories", "create_directory", {
        path: stories.relativePath,
      }),
      toolResponse(
        "repeat-answered-blocker",
        "write_user_stories_blocker",
        blockerToolArguments,
      ),
      finalResponse("The repeated Blocker is ready for another human answer."),
      toolResponse("read-answered-blocker", "read_file", {
        path: readmePath,
        startLine: 1,
        endLine: 120,
      }),
      finalResponse("The recorded answer has not been materialized yet."),
      toolResponse("remove-answered-blocker", "write_file", {
        path: readmePath,
        content: "# User Stories\n\nThe recorded product decisions are materialized below.\n",
        overwrite: true,
      }),
      finalResponse("The old Blocker has been removed."),
      toolResponse("write-materialized-story", "write_file", {
        path: storyPath,
        content: canonicalStory().replaceAll("US-001", "US-101"),
        overwrite: false,
      }),
      finalResponse("The answered decision is now represented by a reviewable Story."),
    ]);

    const result = await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [prd.id, stories.id],
      answeredUserStoriesBlockerFingerprints: [
        userStoriesBlockerDecisionFingerprint(renderUserStoriesBlocker({
          status: "Pending",
          knownFacts: [],
          missingFacts: [blockerToolArguments.missingFact],
          openQuestions: [blockerToolArguments.openQuestion],
          humanOwners: [blockerToolArguments.humanOwner],
          nextSteps: [blockerToolArguments.nextStep],
        }))!,
      ],
      revisionFeedback: [
        "- PRODUCT-STORIES-BLOCKER-V1: Use a red theme; layout may change freely.",
      ],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "lmstudio",
      messages: [{ role: "user", content: "按已记录决定完成 Discovery" }],
    }, async () => undefined);

    assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), [
      "prd",
      "user-stories",
    ]);
    const firstCorrection = providers.requests[5]?.request;
    const firstFeedback = firstCorrection?.messages.at(-1)?.content ?? "";
    assert.match(firstFeedback, /BLOCKER_ANSWER_NOT_MATERIALIZED/u);
    assert.match(firstFeedback, /"repairMode":"story"/u);
    assert.match(firstFeedback, /不得再次调用 write_user_stories_blocker/u);
    assert.deepEqual(firstCorrection?.toolChoice, {
      type: "function",
      name: "read_file",
    });
    assert.deepEqual(providers.requests[7]?.request.toolChoice, {
      type: "function",
      name: "write_file",
    });
    const lockedCorrection = providers.requests[9]?.request;
    assert.deepEqual(lockedCorrection?.toolChoice, {
      type: "function",
      name: "write_file",
    });
    assert.match(lockedCorrection?.messages.at(-1)?.content ?? "", /Story-only 修复.*保持锁定/u);
    assert.doesNotMatch(
      await readFile(path.join(fixture.root, readmePath), "utf8"),
      new RegExp(escapeRegExp(USER_STORIES_BLOCKER_SENTINEL), "u"),
    );
    assert.match(await readFile(path.join(fixture.root, storyPath), "utf8"), /# US-101:/u);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-DECISION-REPLAY-06: an answered multi-question Blocker cannot escape as an old subset", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const answeredDraft = {
      status: "Pending" as const,
      knownFacts: ["The current profile sections remain available."],
      missingFacts: [
        "The AI SDLC presentation format has not been selected.",
        "The repository-link policy has not been selected.",
      ],
      openQuestions: [
        "Should AI SDLC experience use cards or a table?",
        "Should project entries include repository links?",
        "Which AI SDLC experiences should be highlighted?",
      ],
      humanOwners: ["Product Owner"],
      nextSteps: ["The Product Owner answers every question before Story authoring."],
    };
    const answeredScope = userStoriesBlockerDecisionScope(
      renderUserStoriesBlocker(answeredDraft),
    );
    assert.ok(answeredScope);
    const subsetArguments = {
      status: "Pending",
      missingFacts: [answeredDraft.missingFacts[0]],
      openQuestions: [answeredDraft.openQuestions[1]],
      humanOwner: "Product Owner",
      nextStep: "The Product Owner answers before Story authoring.",
    };
    const readmePath = `${stories.relativePath}/README.md`;
    const storyPath = `${stories.relativePath}/profile/US-102-profile-sdlc/story.md`;
    const providers = new ScriptedProviderPort([
      toolResponse("create-subset-prd-parent", "create_directory", {
        path: path.dirname(prd.relativePath),
      }),
      toolResponse("write-subset-prd", "write_file", {
        path: prd.relativePath,
        content: "# Profile PRD\n\nAll three recorded decisions are authoritative.\n",
        overwrite: false,
      }),
      toolResponse("create-subset-stories", "create_directory", {
        path: stories.relativePath,
      }),
      toolResponse("write-old-subset", "write_user_stories_blocker", subsetArguments),
      finalResponse("Only one prior question remains for review."),
      toolResponse("read-old-subset", "read_file", {
        path: readmePath,
        startLine: 1,
        endLine: 120,
      }),
      finalResponse("The retained question was already answered."),
      toolResponse("remove-old-subset", "write_file", {
        path: readmePath,
        content: "# User Stories\n\nRecorded product decisions are materialized below.\n",
        overwrite: true,
      }),
      finalResponse("The stale Blocker has been removed."),
      toolResponse("write-subset-story", "write_file", {
        path: storyPath,
        content: canonicalStory().replaceAll("US-001", "US-102"),
        overwrite: false,
      }),
      finalResponse("The answered decisions are now in a reviewable Story."),
    ]);

    const result = await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [prd.id, stories.id],
      answeredUserStoriesBlockerScopes: [answeredScope],
      revisionFeedback: [
        "All three current Blocker questions have concrete human answers and must become Stories.",
      ],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "lmstudio",
      messages: [{ role: "user", content: "按已记录决定完成 Discovery" }],
    }, async () => undefined);

    assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), [
      "prd",
      "user-stories",
    ]);
    const firstFeedback = providers.requests[5]?.request.messages.at(-1)?.content ?? "";
    assert.match(firstFeedback, /BLOCKER_ANSWER_NOT_MATERIALIZED/u);
    assert.match(firstFeedback, /"repairMode":"story"/u);
    assert.doesNotMatch(
      await readFile(path.join(fixture.root, readmePath), "utf8"),
      new RegExp(escapeRegExp(USER_STORIES_BLOCKER_SENTINEL), "u"),
    );
    assert.match(await readFile(path.join(fixture.root, storyPath), "utf8"), /# US-102:/u);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-DECISION-MATERIALIZATION-01: an answered decision cycle rejects newly invented PRD questions", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const storyPath = `${stories.relativePath}/profile/US-120-profile-layout/story.md`;
    const providers = new ScriptedProviderPort([
      toolResponse("write-churn-prd", "write_file", {
        path: prd.relativePath,
        content: [
          "# Profile PRD",
          "",
          "The profile layout and AI SDLC project links are in scope.",
          "",
          "## Open Questions",
          "",
          "- Should the profile integrate an external monitoring dashboard?",
          "",
        ].join("\n"),
        overwrite: false,
      }),
      toolResponse("write-churn-story", "write_file", {
        path: storyPath,
        content: canonicalStory().replaceAll("US-001", "US-120"),
        overwrite: false,
      }),
      finalResponse("A new optional integration question remains."),
      toolResponse("materialize-prd", "write_file", {
        path: prd.relativePath,
        content: [
          "# Profile PRD",
          "",
          "The profile uses the repository's existing capabilities, a reversible card layout, and AI SDLC project links. External dashboard integration is out of scope.",
          "",
        ].join("\n"),
        overwrite: true,
      }),
      finalResponse("The recorded decisions are now materialized without a new gate."),
    ]);

    const result = await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [prd.id, stories.id],
      productDecisionMaterializationRequired: true,
      revisionFeedback: [
        "Use product best practices, do not overthink the layout, and include project links.",
      ],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "lmstudio",
      messages: [{ role: "user", content: "物化已记录的产品决定" }],
    }, async () => undefined);

    assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), [
      "prd",
      "user-stories",
    ]);
    const correction = providers.requests[3]?.request;
    assert.deepEqual(correction?.toolChoice, { type: "function", name: "write_file" });
    assert.match(correction?.messages.at(-1)?.content ?? "", /PRODUCT_DECISION_MATERIALIZATION_REQUIRED/u);
    assert.match(correction?.messages.at(-1)?.content ?? "", /不得新增或改写问题/u);
    assert.doesNotMatch(await readFile(prd.absolutePath, "utf8"), /Open Questions/u);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-DECISION-MATERIALIZATION-04: nonstandard pending sections are rejected without treating risk examples as decisions", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const storyPath = `${stories.relativePath}/profile/US-122-materialized-choice/story.md`;
    const providers = new ScriptedProviderPort([
      toolResponse("write-hidden-pending-prd", "write_file", {
        path: prd.relativePath,
        content: [
          "# Profile PRD",
          "",
          "The approved profile layout and project links are in scope.",
          "",
          "## Pending choices",
          "",
          "- Which external service should own profile monitoring?",
          "",
        ].join("\n"),
        overwrite: false,
      }),
      toolResponse("write-materialized-choice-story", "write_file", {
        path: storyPath,
        content: canonicalStory().replaceAll("US-001", "US-122"),
        overwrite: false,
      }),
      finalResponse("The outputs are complete."),
      toolResponse("remove-hidden-pending-prd", "write_file", {
        path: prd.relativePath,
        content: [
          "# Profile PRD",
          "",
          "Use the repository's existing capabilities and a reversible card layout. External monitoring integration is out of scope.",
          "",
          "## Risks and assumptions",
          "",
          "| Type | Description |",
          "| --- | --- |",
          "| Risk | Imported examples may display the literal token `TBD`; this does not represent a pending product choice. |",
          "| Assumption | Documentation may quote `Needs decision` while explaining legacy copy; no product decision is required. |",
          "",
        ].join("\n"),
        overwrite: true,
      }),
      finalResponse("The recorded decisions are materialized and the risk examples remain descriptive."),
    ]);

    const result = await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [prd.id, stories.id],
      productDecisionMaterializationRequired: true,
      revisionFeedback: ["Use the approved best-practice layout and include project links."],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "lmstudio",
      messages: [{ role: "user", content: "物化已记录的产品决定" }],
    }, async () => undefined);

    assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), [
      "prd",
      "user-stories",
    ]);
    const correction = providers.requests[3]?.request;
    assert.deepEqual(correction?.toolChoice, { type: "function", name: "write_file" });
    assert.match(correction?.messages.at(-1)?.content ?? "", /PRODUCT_DECISION_MATERIALIZATION_REQUIRED/u);
    assert.doesNotMatch(await readFile(prd.absolutePath, "utf8"), /Pending choices/u);
    assert.match(await readFile(prd.absolutePath, "utf8"), /literal token `TBD`/u);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-DECISION-MATERIALIZATION-06: empty or explicitly closed pending sections do not reopen Discovery", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const storyPath = `${stories.relativePath}/profile/US-124-closed-decisions/story.md`;
    const providers = new ScriptedProviderPort([
      toolResponse("write-closed-sections-prd", "write_file", {
        path: prd.relativePath,
        content: [
          "# Profile PRD",
          "",
          "The approved reversible layout and project links are materialized.",
          "",
          "## Open Questions",
          "",
          "- None. All recorded product decisions have been resolved.",
          "",
          "## Pending choices",
          "",
          "<!-- intentionally empty: the contract keeps this heading for compatibility -->",
          "",
          "## 待确认问题",
          "",
          "- 已全部解决。",
          "",
          "## Open Questions: None",
          "",
          "This compatibility heading has no open decision.",
          "",
          "## Risks and assumptions",
          "",
          "| Type | Description |",
          "| --- | --- |",
          "| Risk | Imported examples may display the literal token `TBD`; this is descriptive text only. |",
          "| Assumption | Legacy documentation can quote `Needs decision`; no product choice remains. |",
          "",
        ].join("\n"),
        overwrite: false,
      }),
      toolResponse("write-closed-sections-story", "write_file", {
        path: storyPath,
        content: canonicalStory().replaceAll("US-001", "US-124"),
        overwrite: false,
      }),
      finalResponse("All recorded decisions are materialized."),
    ]);

    const result = await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [prd.id, stories.id],
      productDecisionMaterializationRequired: true,
      revisionFeedback: ["Use the approved best-practice layout and include project links."],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "lmstudio",
      messages: [{ role: "user", content: "物化已记录的产品决定" }],
    }, async () => undefined);

    assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), [
      "prd",
      "user-stories",
    ]);
    assert.equal(providers.requests.length, 3, "closed sections must not consume a repair round");
    assert.match(await readFile(prd.absolutePath, "utf8"), /## Pending choices/u);
    assert.match(await readFile(prd.absolutePath, "utf8"), /已全部解决/u);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-DECISION-MATERIALIZATION-05: Host Codex output uses the same lock gate and rolls back a rejected write", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const storyPath = `${stories.relativePath}/profile/US-123-host-lock/story.md`;
    const storyAbsolutePath = path.join(fixture.root, storyPath);
    const originalPrd = "# Approved profile PRD\n\nThe reversible card layout and project links are in scope.\n";
    const originalStory = canonicalStory().replaceAll("US-001", "US-123");
    await mkdir(path.dirname(prd.absolutePath), { recursive: true });
    await mkdir(path.dirname(storyAbsolutePath), { recursive: true });
    await writeFile(prd.absolutePath, originalPrd, "utf8");
    await writeFile(storyAbsolutePath, originalStory, "utf8");

    const stub = path.join(fixture.root, "codex-hidden-pending-stub.mjs");
    const rejectedPrd = [
      "# Rewritten profile PRD",
      "",
      "## Notes",
      "",
      "- Decision status: Pending external-registry selection",
      "",
    ].join("\n");
    const rewrittenStory = originalStory.replace(
      "Review the generated proposal",
      "Review the materialized profile proposal",
    );
    await writeFile(stub, [
      "#!/usr/bin/env node",
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      "for await (const _chunk of process.stdin) {}",
      `mkdirSync(path.dirname(path.join(process.cwd(), ${JSON.stringify(prd.relativePath)})), { recursive: true });`,
      `mkdirSync(path.dirname(path.join(process.cwd(), ${JSON.stringify(storyPath)})), { recursive: true });`,
      `writeFileSync(path.join(process.cwd(), ${JSON.stringify(prd.relativePath)}), ${JSON.stringify(rejectedPrd)}, "utf8");`,
      `writeFileSync(path.join(process.cwd(), ${JSON.stringify(storyPath)}), ${JSON.stringify(rewrittenStory)}, "utf8");`,
      'process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "host-lock" })}\\n`);',
      "",
    ].join("\n"), "utf8");
    await chmod(stub, 0o755);

    await assert.rejects(
      () => new CodexTerminalRunner({ binary: stub, fake: false }).run({
        executionId: randomUUID(),
        project: fixture.project,
        run: fixture.run,
        phase,
        definition: fixture.definition,
        selectedArtifacts: [],
        selectedOutputKeys: [prd.id, stories.id],
        productDecisionMaterializationRequired: true,
        revisionFeedback: ["Use the approved best-practice layout and include project links."],
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      }, async () => undefined),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "OUTPUT_ARTIFACTS_INVALID");
        assert.equal(
          (error as { details?: { reason?: string } }).details?.reason,
          "PRODUCT_DECISION_MATERIALIZATION_REQUIRED",
        );
        assert.deepEqual(
          (error as { details?: { invalid?: string[] } }).details?.invalid,
          ["prd"],
        );
        return true;
      },
    );

    assert.equal(await readFile(prd.absolutePath, "utf8"), originalPrd);
    assert.equal(await readFile(storyAbsolutePath, "utf8"), originalStory);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-DECISION-MATERIALIZATION-02: a differently-worded Blocker cannot serially reopen Discovery", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const readmePath = `${stories.relativePath}/README.md`;
    const storyPath = `${stories.relativePath}/profile/US-121-ai-sdlc-experience/story.md`;
    const providers = new ScriptedProviderPort([
      toolResponse("write-materialization-prd", "write_file", {
        path: prd.relativePath,
        content: "# Profile PRD\n\nUse a reversible best-practice layout and include AI SDLC project links.\n",
        overwrite: false,
      }),
      toolResponse("write-new-churn-blocker", "write_user_stories_blocker", {
        status: "Blocked",
        missingFact: "The AI SDLC experience business domain is not selected.",
        openQuestion: "Should AI SDLC experience belong to onboarding or processes?",
        humanOwner: "Product Owner",
        nextStep: "The Product Owner selects a business domain before Story authoring.",
      }),
      finalResponse("A newly phrased product decision remains."),
      toolResponse("remove-churn-blocker", "write_file", {
        path: readmePath,
        content: "# User Stories\n\nThe recorded product decisions are materialized in canonical Stories.\n",
        overwrite: true,
      }),
      finalResponse("The Blocker has been removed."),
      toolResponse("write-materialized-story", "write_file", {
        path: storyPath,
        content: canonicalStory().replaceAll("US-001", "US-121"),
        overwrite: false,
      }),
      finalResponse("The decision is represented by a reviewable Story."),
    ]);

    const result = await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [prd.id, stories.id],
      productDecisionMaterializationRequired: true,
      revisionFeedback: [
        "Use product best practices, do not overthink the layout, and include project links.",
      ],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "lmstudio",
      messages: [{ role: "user", content: "物化已记录的产品决定" }],
    }, async () => undefined);

    assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), [
      "prd",
      "user-stories",
    ]);
    const firstCorrection = providers.requests[3]?.request;
    assert.deepEqual(firstCorrection?.toolChoice, { type: "function", name: "write_file" });
    assert.match(firstCorrection?.messages.at(-1)?.content ?? "", /PRODUCT_DECISION_MATERIALIZATION_REQUIRED/u);
    assert.match(firstCorrection?.messages.at(-1)?.content ?? "", /不能串行制造新的人工门禁|不得新增或改写问题/u);
    const secondCorrection = providers.requests[5]?.request;
    assert.deepEqual(secondCorrection?.toolChoice, { type: "function", name: "write_file" });
    assert.match(secondCorrection?.messages.at(-1)?.content ?? "", /Story-only 修复|规范 story\.md/u);
    assert.doesNotMatch(
      await readFile(path.join(stories.absolutePath, "README.md"), "utf8"),
      new RegExp(escapeRegExp(USER_STORIES_BLOCKER_SENTINEL), "u"),
    );
    assert.match(await readFile(path.join(stories.absolutePath, "profile/US-121-ai-sdlc-experience/story.md"), "utf8"), /# US-121:/u);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: a new Blocker fingerprint remains reviewable after a different decision was answered", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const blockerToolArguments = {
      status: "Blocked",
      missingFact: "The authoritative target user role and approval policy are not yet known.",
      openQuestion: "Which user role owns final approval?",
      humanOwner: "Product Owner",
      nextStep: "Product Owner answers the question; PM / BA then writes canonical Story files.",
    };
    const providers = new ScriptedProviderPort([
      toolResponse("create-blocked-prd-parent", "create_directory", {
        path: path.dirname(prd.relativePath),
      }),
      toolResponse("write-blocked-prd", "write_file", {
        path: prd.relativePath,
        content: "# Blocked PRD\n\nThe known product boundary and unresolved decision are documented.\n",
        overwrite: false,
      }),
      toolResponse("create-blocked-stories", "create_directory", {
        path: stories.relativePath,
      }),
      toolResponse("write-structured-blocker", "write_user_stories_blocker", blockerToolArguments),
      finalResponse("Discovery is ready for human review of the documented Blocker."),
    ]);

    const result = await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [prd.id, stories.id],
      answeredUserStoriesBlockerFingerprints: [
        userStoriesBlockerDecisionFingerprint(renderUserStoriesBlocker({
          status: "Pending",
          knownFacts: [],
          missingFacts: ["The profile visual theme has not been confirmed."],
          openQuestions: ["Should the profile use the red or blue visual theme?"],
          humanOwners: ["Product Owner"],
          nextSteps: ["The Product Owner selects one visual theme."],
        }))!,
      ],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "openai",
      messages: [{ role: "user", content: "记录阻塞事实并提交审核" }],
    }, async () => undefined);

    assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), [
      "prd",
      "user-stories",
    ]);
    assert.equal(providers.requests.length, 5, "a complete Blocker must not trigger correction");
    const content = await readFile(path.join(stories.absolutePath, "README.md"), "utf8");
    assert.match(content, /Human owner/u);
    assert.equal(content.split(USER_STORIES_BLOCKER_SENTINEL).length - 1, 1);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: an invalid Blocker gets an exact forced-write repair and can recover", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const invalidBlocker = [
      "<!-- ai-sdlc:user-stories-blocker:v1 -->",
      "",
      "# User Stories Blocker",
      "",
      "Status: **Pending**",
      "",
      "## Missing facts",
      "",
      "- The authoritative profile content order has not been confirmed.",
      "",
      "## Open questions",
      "",
      "- Which profile sections must remain above the AI SDLC experience?",
      "",
      "## Human owner",
      "",
      "- Product Owner",
      "",
      "## Next step",
      "",
      "Product Owner confirms the content order.",
      "",
    ].join("\n");
    const blockerDraft = {
      status: "Pending" as const,
      knownFacts: [],
      missingFacts: ["The authoritative profile content order has not been confirmed."],
      openQuestions: ["Which profile sections must remain above the AI SDLC experience?"],
      humanOwners: ["Product Owner"],
      nextSteps: ["The Product Owner confirms the content order; PM / BA then writes canonical Story files."],
    };
    const blockerToolArguments = {
      status: blockerDraft.status,
      missingFact: blockerDraft.missingFacts[0],
      openQuestion: blockerDraft.openQuestions[0],
      humanOwner: blockerDraft.humanOwners[0],
      nextStep: blockerDraft.nextSteps[0],
    };
    const repairedBlocker = renderUserStoriesBlocker(blockerDraft);
    await mkdir(stories.absolutePath, { recursive: true });
    await writeFile(path.join(stories.absolutePath, "README.md"), invalidBlocker, "utf8");
    const providers = new ScriptedProviderPort([
      toolResponse("create-repair-prd-parent", "create_directory", {
        path: path.dirname(prd.relativePath),
      }),
      toolResponse("write-repair-prd", "write_file", {
        path: prd.relativePath,
        content: "# Pending PRD\n\nThe known scope and unresolved product decision are documented.\n",
        overwrite: false,
      }),
      finalResponse("The Blocker is ready."),
      toolResponse("repair-blocker", "write_user_stories_blocker", blockerToolArguments),
      finalResponse("The exact Blocker contract is now ready for human review."),
    ]);

    const result = await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [prd.id, stories.id],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "lmstudio",
      messages: [{ role: "user", content: "记录真实 Blocker 并提交审核" }],
    }, async () => undefined);

    assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), [
      "prd",
      "user-stories",
    ]);
    const correctionRequest = providers.requests[3]?.request;
    const correctionFeedback = correctionRequest?.messages.at(-1)?.content ?? "";
    assert.deepEqual(correctionRequest?.toolChoice, {
      type: "function",
      name: "write_user_stories_blocker",
    });
    assert.equal(providers.requests[0]?.request.toolChoice, "required");
    assert.match(correctionFeedback, /BLOCKER_STATUS_MUST_BE_EXACT/u);
    assert.match(correctionFeedback, /BLOCKER_NEXT_STEP_REQUIRED/u);
    assert.match(correctionFeedback, /write_user_stories_blocker/u);
    assert.match(correctionFeedback, new RegExp(escapeRegExp(USER_STORIES_BLOCKER_SENTINEL), "u"));
    assert.match(correctionFeedback, /Status: Pending/u);
    assert.match(correctionFeedback, /## Next step/u);
    assert.match(correctionFeedback, /标题后的普通段落不算 bullet/u);
    assert.equal(
      await readFile(path.join(stories.absolutePath, "README.md"), "utf8"),
      repairedBlocker,
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29: a self-referential Blocker repairs as story-or-blocker instead of forcing the Blocker tool", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const prd = fixture.definition.artifacts.find(({ id }) => id === "prd");
    const stories = fixture.definition.artifacts.find(({ id }) => id === "user-stories");
    const phase = fixture.definition.phases.find(({ id }) => id === "discovery");
    assert.ok(prd);
    assert.ok(stories);
    assert.ok(phase);
    const selfReferentialBlocker = [
      USER_STORIES_BLOCKER_SENTINEL,
      "",
      "# User Stories Blocker",
      "",
      "Status: Blocked",
      "",
      "## Missing facts",
      "",
      "- Existing blocker in user-stories root prevents modifying stories.",
      "",
      "## Open questions",
      "",
      "- Is the blocker resolved or should we proceed with new PRD only?",
      "",
      "## Human owner",
      "",
      "- PM/BA",
      "",
      "## Next step",
      "",
      "- Await human confirmation to remove blocker before editing stories.",
      "",
    ].join("\n");
    const storyPath = `${stories.relativePath}/profile/US-001-profile/story.md`;
    await mkdir(stories.absolutePath, { recursive: true });
    await writeFile(path.join(stories.absolutePath, "README.md"), selfReferentialBlocker, "utf8");
    const providers = new ScriptedProviderPort([
      toolResponse("create-prd-parent", "create_directory", {
        path: path.dirname(prd.relativePath),
      }),
      toolResponse("write-prd", "write_file", {
        path: prd.relativePath,
        content: "# Profile layout PRD\n\nThe target audience and required profile outcome are confirmed.\n",
        overwrite: false,
      }),
      finalResponse("The existing outputs are ready."),
      toolResponse("replace-mechanism-blocker", "write_file", {
        path: `${stories.relativePath}/README.md`,
        content: "# User Stories\n\nCanonical Story files are maintained below.\n",
        overwrite: true,
      }),
      finalResponse("The platform migration step is complete."),
      toolResponse("write-canonical-story", "write_file", {
        path: storyPath,
        content: canonicalStory(),
        overwrite: false,
      }),
      finalResponse("The product facts are now captured in canonical Stories."),
    ]);

    const result = await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run: fixture.run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [prd.id, stories.id],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "lmstudio",
      messages: [{ role: "user", content: "按已确认事实生成 PRD 和 User Stories" }],
    }, async () => undefined);

    assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), [
      "prd",
      "user-stories",
    ]);
    const firstCorrection = providers.requests[3]?.request;
    const firstFeedback = firstCorrection?.messages.at(-1)?.content ?? "";
    assert.equal(firstCorrection?.toolChoice, "required");
    assert.match(firstFeedback, /BLOCKER_WORKFLOW_MECHANISM_FORBIDDEN/u);
    assert.match(firstFeedback, /"repairMode":"story-or-blocker"/u);
    assert.match(firstFeedback, /平台迁移顺序写成了产品事实/u);
    assert.doesNotMatch(firstFeedback, /"repairMode":"blocker"/u);
    const storyBranchCorrection = providers.requests[5]?.request;
    const storyBranchFeedback = storyBranchCorrection?.messages.at(-1)?.content ?? "";
    assert.deepEqual(storyBranchCorrection?.toolChoice, {
      type: "function",
      name: "write_file",
    });
    assert.match(storyBranchFeedback, /STORY_NONCANONICAL_CONTENT_REQUIRES_STORY/u);
    assert.match(storyBranchFeedback, /"repairMode":"story"/u);
    assert.match(await readFile(path.join(fixture.root, storyPath), "utf8"), /# US-001:/u);
    assert.doesNotMatch(
      await readFile(path.join(stories.absolutePath, "README.md"), "utf8"),
      new RegExp(escapeRegExp(USER_STORIES_BLOCKER_SENTINEL), "u"),
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29/DESIGN: a prose-only Design Spec is repaired in the same Provider execution before review", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const phase = fixture.definition.phases.find(({ id }) => id === "design");
    const baseline = fixture.definition.artifacts.find(({ id }) => id === "design-baseline");
    const spec = fixture.definition.artifacts.find(({ id }) => id === "design-spec");
    assert.ok(phase);
    assert.ok(baseline);
    assert.ok(spec);
    const run = { ...fixture.run, title: "TODO list interaction" };

    const proseOnly = "# Design Specification\n\n## 目标\n\n- 优化整体布局。\n";
    const baselineContent = "# Design Baseline\n\nUse the verified repository layout.\n";
    const repairArguments = validDesignSpecToolArguments();
    await mkdir(path.dirname(spec.absolutePath), { recursive: true });
    await writeFile(spec.absolutePath, proseOnly, "utf8");
    const providers = new ScriptedProviderPort([
      toolResponse("write-design-baseline", "write_file", {
        path: baseline.relativePath,
        content: baselineContent,
        overwrite: false,
      }),
      finalResponse("The design artifacts are complete."),
      toolResponse("repair-design-contract", "write_design_spec", repairArguments),
      finalResponse("The complete Design contract and handoff are ready."),
    ]);

    const result = await phaseExecutor(fixture.root, providers).run({
      executionId: randomUUID(),
      project: fixture.project,
      run,
      phase,
      definition: fixture.definition,
      selectedArtifacts: [],
      selectedOutputKeys: [baseline.id, spec.id],
      model: "selected-model",
      reasoningEffort: null,
    }, {
      providerId: "lmstudio",
      messages: [{ role: "user", content: "完成 Designer 产物" }],
    }, async () => undefined);

    assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), [
      "design-baseline",
      "design-spec",
    ]);
    const persisted = await readFile(spec.absolutePath, "utf8");
    const machineMatch = /^\s*```json\s*([\s\S]*?)```/u.exec(persisted);
    assert.ok(machineMatch?.[1]);
    const contract = JSON.parse(machineMatch[1]) as Record<string, unknown>;
    assert.equal(contract.title, run.title);
    assert.equal(contract.mode, "change");
    assert.equal(contract.extends, "artifact:design-baseline");
    assert.equal(contract.status, "ready-for-engineering");
    assert.deepEqual(contract.blockers, []);
    assert.deepEqual(contract.open_questions, []);
    assert.deepEqual(contract.deferred_validations, []);
    assert.ok((contract.source as string[]).includes("artifact:design-baseline"));
    const persistedCriteria = contract.acceptance_criteria as Array<Record<string, unknown>>;
    assert.equal(persistedCriteria[0]?.requirement, repairArguments.acceptanceCriteria[0]?.requirement);
    assert.equal(persistedCriteria[0]?.design_response, repairArguments.acceptanceCriteria[0]?.designResponse);
    assert.match(persisted, /## Handoff to Software Engineer/u);
    assert.match(persisted, /\*\*Next owner:\*\* Software Engineer/u);
    for (const section of [
      "Build scope",
      "Behavior to preserve",
      "Do not infer",
      "Allowed design flexibility",
      "Validation evidence",
      "Deferred verification",
      "Open decisions and blockers",
    ]) {
      assert.ok(persisted.includes(`### ${section}`), `missing handoff section ${section}`);
    }
    assert.equal(await readFile(baseline.absolutePath, "utf8"), baselineContent);

    const firstRequest = providers.requests[0]?.request;
    assert.match(firstRequest?.systemPrompt ?? "", /design-spec 不能只写设计说明正文/u);
    assert.match(firstRequest?.systemPrompt ?? "", /write_design_spec/u);
    assert.match(firstRequest?.systemPrompt ?? "", /deferredValidations=\[\]/u);
    assert.match(firstRequest?.systemPrompt ?? "", /\.ai-sdlc\/templates\/design-spec\.md/u);
    assert.ok(firstRequest?.tools.some(({ name }) => name === "write_design_spec"));

    const correction = providers.requests.find(({ request }) => (
      request.messages.at(-1)?.content.includes("DESIGN_SPEC_MACHINE_CONTRACT_REQUIRED")
    ))?.request;
    assert.ok(correction, "the deterministic gate must reject prose before persistence");
    assert.deepEqual(correction.toolChoice, { type: "function", name: "write_design_spec" });
    const feedback = correction.messages.at(-1)?.content ?? "";
    assert.match(feedback, /design-spec.*machine contract/iu);
    assert.match(feedback, /DESIGN_SPEC_HANDOFF_REQUIRED/u);
    assert.match(feedback, /write_design_spec/u);
    assert.doesNotMatch(feedback, new RegExp(escapeRegExp(fixture.root), "u"));
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29/DESIGN: the structured Designer writer requires explicit ledgers and is bound to one selected file", async () => {
  const fixture = await workspaceFixture();
  try {
    const specPath = "artifacts/design/design-spec.md";
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      writablePaths: [specPath],
      writableDirectoryPaths: [],
      structuredDesignSpecTarget: {
        filePath: specPath,
        title: "TODO list interaction",
        sourceArtifactKeys: ["change-contract", "prd", "user-stories", "design-baseline"],
      },
    });
    assert.ok(host.definitions().some(({ name }) => name === "write_design_spec"));
    const designTool = host.definitions().find(({ name }) => name === "write_design_spec");
    assert.doesNotMatch(JSON.stringify(designTool), /uniqueItems/u);
    const { deferredValidations: _omittedLedger, ...missingLedger } = validDesignSpecToolArguments();
    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "missing-explicit-ledger",
        name: "write_design_spec",
        arguments: missingLedger,
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      }),
      (error: unknown) => {
        const toolError = error as { code?: string; safeMessage?: string };
        assert.equal(toolError.code, "AGENT_DESIGN_SPEC_ARGUMENTS_INVALID");
        assert.match(toolError.safeMessage ?? "", /deferredValidations/u);
        assert.doesNotMatch(toolError.safeMessage ?? "", /server|\/private|artifacts\/design/iu);
        return true;
      },
    );
    await assert.rejects(readFile(path.join(fixture.root, specPath), "utf8"));

    await host.execute({
      type: "function",
      id: "write-valid-design",
      name: "write_design_spec",
      arguments: validDesignSpecToolArguments(),
    }, {
      signal: new AbortController().signal,
      maxOutputCharacters: 10_000,
    });
    const persisted = await readFile(path.join(fixture.root, specPath), "utf8");
    assert.match(persisted, /"title": "TODO list interaction"/u);
    assert.match(persisted, /"deferred_validations": \[\]/u);
    for (const [id, name, argumentsValue] of [
      ["generic-design-write", "write_file", {
        path: specPath,
        content: "# forged design",
        overwrite: true,
      }],
      ["generic-design-patch", "apply_patch", {
        path: specPath,
        oldText: "TODO list interaction",
        newText: "forged title",
        replaceAll: true,
      }],
    ] as const) {
      await assert.rejects(
        () => host.execute({
          type: "function",
          id,
          name,
          arguments: argumentsValue,
        }, {
          signal: new AbortController().signal,
          maxOutputCharacters: 10_000,
        }),
        (error: unknown) => (
          (error as { code?: string }).code === "AGENT_DESIGN_SPEC_REQUIRES_STRUCTURED_TOOL"
        ),
      );
    }
    assert.equal(await readFile(path.join(fixture.root, specPath), "utf8"), persisted);

    await assert.rejects(
      () => RootedAgentToolHost.create({
        rootPath: fixture.root,
        accessMode: "sandbox-write",
        writablePaths: ["artifacts/design/other.md"],
        writableDirectoryPaths: [],
        structuredDesignSpecTarget: {
          filePath: specPath,
          title: "Bound target",
          sourceArtifactKeys: ["change-contract"],
        },
      }),
      (error: unknown) => (error as { code?: string }).code === "AGENT_WRITE_SCOPE_INVALID",
    );
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-29/ARCHITECT: structured checkpoint writer binds three outputs to the current rulebook", async () => {
  const fixture = await initializedPhaseFixture();
  try {
    const configured = await loadArchitectureRulebookContext(fixture.root);
    assert.equal(configured.validation, "required");
    assert.ok(configured.source);
    const inspection = inspectArchitectureRulebook({
      validation: "required",
      stage: "checkpoint",
      rulebook: configured.source,
    });
    assert.ok(inspection.rules.length > 0);
    const paths = {
      discovery: "artifacts/architecture/discovery.md",
      options: "artifacts/architecture/options.md",
      architecture: "artifacts/architecture/architecture.md",
    };
    const host = await RootedAgentToolHost.create({
      rootPath: fixture.root,
      accessMode: "sandbox-write",
      writablePaths: Object.values(paths),
      writableDirectoryPaths: [],
      structuredArchitectureCheckpointTarget: {
        discoveryPath: paths.discovery,
        optionsPath: paths.options,
        architecturePath: paths.architecture,
        title: "GitHub profile architecture",
        catalogDigest: calculateArchitectureRulebookDigest(configured.source!),
        configuredProjectMode: configured.source!.projectMode,
        rules: inspection.rules.map(({ id, packId }) => ({ id, packId })),
      },
    });
    const tool = host.definitions().find(({ name }) => name === "write_architecture_checkpoint");
    assert.ok(tool);
    assert.doesNotMatch(JSON.stringify(tool), /uniqueItems/u);
    const argumentsValue = {
      contextSummary: "The approved scope updates an existing GitHub profile document without introducing a deployed application runtime.",
      problem: "Choose a maintainable information-architecture direction for the approved profile content while preserving repository-owned behavior.",
      constraints: ["The change remains inside the approved profile scope and must not invent services, APIs, databases, or deployment infrastructure."],
      scopes: [{
        name: "GitHub profile document",
        boundary: "existing",
        evidence: "The approved Change Contract and existing repository README define the profile-only boundary.",
      }],
      applicablePackIds: [],
      options: [
        {
          title: "Single narrative flow",
          coreIdea: "Keep the approved material in one concise top-to-bottom profile narrative with semantic headings.",
          optimizes: "Optimizes scanning speed and keeps the implementation localized to one repository-owned document.",
          givesUp: "Gives up independent module navigation and richer visual separation between experience areas.",
          hardestConstraint: "The longest experience section must remain readable without creating a dense wall of text.",
        },
        {
          title: "Sectioned profile modules",
          coreIdea: "Organize the same approved content into clear modules with stable headings and compact summaries.",
          optimizes: "Optimizes findability and future editing by giving each approved content group an explicit boundary.",
          givesUp: "Gives up some narrative continuity and adds more headings for readers to traverse.",
          hardestConstraint: "Module boundaries must not imply routes, interactive cards, or application behavior outside the contract.",
        },
        {
          title: "Summary with detail links",
          coreIdea: "Keep a short profile summary and link to repository-owned detail sections for the approved experience evidence.",
          optimizes: "Optimizes the first-screen summary and lets interested readers reach detailed evidence deliberately.",
          givesUp: "Gives up immediate visibility of all approved detail and relies on link maintenance.",
          hardestConstraint: "Every link target must be real, stable, descriptive, and within the approved repository scope.",
        },
      ],
      recommendedOptionNumber: 2,
      recommendationReason: "It balances scanning and maintainability while remaining a reversible document-only change.",
    };
    await host.execute({
      type: "function",
      id: "write-architecture-checkpoint",
      name: "write_architecture_checkpoint",
      arguments: argumentsValue,
    }, {
      signal: new AbortController().signal,
      maxOutputCharacters: 10_000,
    });
    const [discovery, options, architecture] = await Promise.all(
      Object.values(paths).map((relativePath) => readFile(path.join(fixture.root, relativePath), "utf8")),
    );
    assert.match(options, /^## Option A: Single narrative flow$/mu);
    assert.match(options, /推荐 Option B 供人工考虑/u);
    assert.equal(options.split("<!-- ai-sdlc:architecture-rulebook:v1 -->").length - 1, 1);
    await validateArchitectureRulebookReview({
      projectRoot: fixture.root,
      stage: "checkpoint",
      artifacts: [
        { artifactKey: "architecture-discovery-context", content: discovery, filePath: paths.discovery, revisionSource: "ai" },
        { artifactKey: "architecture-options", content: options, filePath: paths.options, revisionSource: "ai" },
        { artifactKey: "architecture", content: architecture, filePath: paths.architecture, revisionSource: "ai" },
      ],
      documentedOptionIds: ["A", "B", "C"],
    });
    await assert.rejects(
      () => host.execute({
        type: "function",
        id: "forge-options",
        name: "write_file",
        arguments: { path: paths.options, content: "# forged", overwrite: true },
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      }),
      (error: unknown) => (
        (error as { code?: string }).code === "AGENT_ARCHITECTURE_CHECKPOINT_REQUIRES_STRUCTURED_TOOL"
      ),
    );
  } finally {
    await fixture.dispose();
  }
});

class ScriptedProviderPort {
  readonly requests: Array<{ providerId: AskProviderId; request: AskLlmCompleteRequest }> = [];

  constructor(private readonly responses: AskLlmCompleteResponse[]) {}

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
        toolCalling: true,
      },
      message: "ready",
    };
  }

  async complete(
    providerId: AskProviderId,
    request: AskLlmCompleteRequest,
  ): Promise<AskLlmCompleteResponse> {
    this.requests.push({ providerId, request: structuredClone(request) });
    const response = this.responses.shift();
    if (!response) throw new Error("provider output-gate test response exhausted");
    return response;
  }
}

function canonicalStory(): string {
  return [
    "# US-001: Review the generated proposal",
    "",
    "As a product reviewer, I want to inspect the generated proposal so that I can accept it or request a revision.",
    "",
    "## Acceptance criteria",
    "",
    "### US-001-AC-01: Objective and scope are reviewable",
    "",
    "```gherkin",
    "Given a generated proposal exists",
    "When the product reviewer opens the proposal",
    "Then the product objective and scope are visible",
    "```",
    "",
    "### US-001-AC-02: Revision remains available",
    "",
    "```gherkin",
    "Given the product reviewer finds an incorrect scope statement",
    "When the reviewer requests a revision",
    "Then the proposal remains pending with the requested change recorded",
    "```",
    "",
  ].join("\n");
}

function validDesignSpecToolArguments() {
  return {
    status: "ready-for-engineering" as const,
    framework: "Markdown document",
    screens: [{
      id: "profile-readme",
      layout: "A single readable document flow for the approved profile content.",
      states: ["default"],
    }],
    acceptanceCriteria: [{
      id: "US-001-AC-01",
      requirement: "The approved \"AI SDLC Experience\" content is visible.\nThe hierarchy remains scannable.",
      designResponse: "The profile groups summary and AI SDLC experience in one readable flow.",
    }],
    openQuestions: [],
    blockers: [],
    deferredValidations: [],
    designSummary: "Present the approved profile content as one concise and scannable document flow.",
    responsiveBehavior: "Keep the document in source order and allow text to reflow without horizontal scrolling.",
    accessibilityAndContent: "Use semantic headings, descriptive links, readable source order, and meaningful labels.",
    validationEvidence: "The documented hierarchy traces the approved US-001-AC-01 acceptance criterion.",
    behaviorToPreserve: ["Keep the profile readable in both source and rendered views."],
    allowedDesignFlexibility: ["Spacing and typography may follow verified repository conventions."],
  };
}

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

async function missingFileKeys(
  root: string,
  paths: Record<string, string>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const [key, relativePath] of Object.entries(paths)) {
    try {
      if ((await readFile(path.join(root, relativePath), "utf8")).trim().length === 0) {
        missing.push(key);
      }
    } catch {
      missing.push(key);
    }
  }
  return missing;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function phaseExecutor(root: string, providers: ScriptedProviderPort): ProviderPhaseExecutor {
  return new ProviderPhaseExecutor(
    new ProviderNativeAgentRuntime(providers),
    new CodexTerminalRunner({
      binary: path.join(root, "codex-must-not-be-invoked"),
      fake: false,
    }),
    providers,
  );
}

async function initializedPhaseFixture(): Promise<{
  root: string;
  project: ProjectDto;
  run: WorkflowRunDto;
  definition: Awaited<ReturnType<typeof loadDefinition>>;
  dispose(): Promise<void>;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), "provider-output-phase-gate-"));
  const requestedRoot = path.join(parent, "project");
  await initializeCodexProject(
    requestedRoot,
    "Provider output gate",
    "Verify selected provider outputs before completion",
  );
  const root = await realpath(requestedRoot);
  const now = "2026-08-29T08:00:00.000Z";
  const project: ProjectDto = {
    id: randomUUID(),
    name: "Provider output gate",
    summary: "Verify selected provider outputs before completion",
    rootPath: root,
    configPath: path.join(root, "ai-native.yaml"),
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const run: WorkflowRunDto = {
    id: randomUUID(),
    projectId: project.id,
    title: "Provider output gate",
    objective: "Require every selected output",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const definition = resolveTaskArtifactPaths(await loadDefinition(root), run);
  return {
    root,
    project,
    run,
    definition,
    dispose: () => rm(parent, { recursive: true, force: true }),
  };
}

async function workspaceFixture(): Promise<{ root: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "provider-output-artifact-gate-"));
  return {
    root,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
