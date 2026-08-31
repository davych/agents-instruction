import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AskProviderId,
  AskProviderStatusDto,
  CodexReasoningEffort,
  CodexRunnerMode,
  ExecutionDto,
  PhaseDefinition,
  PhaseId,
  PhaseRunDto,
  ProjectDto,
  WorkflowRunDto,
} from "@ai-sdlc/contracts";

import { AppError } from "../src/domain/errors.ts";
import { serializeHumanDecisionCapture } from "../src/domain/human-decisions.ts";
import type {
  ArtifactRecordInput,
  PgWorkflowStore,
  RunBundle,
  SelectionArtifact,
} from "../src/db/store.ts";
import {
  ProviderPhaseExecutor,
  type ProviderPhaseExecutionOutcome,
} from "../src/services/agent/provider-phase-executor.ts";
import type {
  ProviderNativeAgentInput,
  ProviderNativeAgentResult,
  ProviderNativeAgentRuntime,
} from "../src/services/agent/provider-native-agent-runtime.ts";
import {
  CodexTerminalRunner,
  type CodexRunRequest,
} from "../src/services/codex-runner.ts";
import type { LoadedDefinition } from "../src/services/definition-loader.ts";
import { loadDefinition } from "../src/services/definition-loader.ts";
import type { AskProviderRegistry } from "../src/services/llm/provider-registry.ts";
import { AskProviderError } from "../src/services/llm/types.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { resolveTaskArtifactPaths } from "../src/domain/task-artifact-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

const temporaryRoots: string[] = [];
test.after(async () => Promise.all(
  temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
));

test("provider-native phase bypasses Codex, persists success, and records safe async Provider failures", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-provider-phase-service-"));
  temporaryRoots.push(parent);
  const requestedRoot = path.join(parent, "project");
  await initializeCodexProject(
    requestedRoot,
    "Provider phase",
    "Execute discovery through the selected chat provider",
  );
  const rootPath = await realpath(requestedRoot);
  const now = "2026-08-29T08:00:00.000Z";
  const project: ProjectDto = {
    id: randomUUID(),
    name: "Provider phase",
    summary: "Execute discovery through the selected chat provider",
    rootPath,
    configPath: path.join(rootPath, "ai-native.yaml"),
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const run: WorkflowRunDto = {
    id: randomUUID(),
    projectId: project.id,
    title: "Provider-native PRD",
    objective: "Write a reviewable PRD without invoking Codex",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const definition = resolveTaskArtifactPaths(await loadDefinition(rootPath), run);
  const prd = definition.artifacts.find(({ id }) => id === "prd");
  const stories = definition.artifacts.find(({ id }) => id === "user-stories");
  assert.ok(prd);
  assert.ok(stories);
  await mkdir(path.dirname(prd.absolutePath), { recursive: true });
  const phaseRunId = randomUUID();
  const phase: PhaseRunDto = {
    id: phaseRunId,
    workflowRunId: run.id,
    phaseId: "discovery",
    position: 0,
    status: "ready",
    artifacts: [],
    reviews: [
      {
        id: randomUUID(),
        phaseRunId,
        decision: "request_changes",
        comment: serializeHumanDecisionCapture({
          phaseId: "discovery",
          responses: [{ id: "PRODUCT-STORIES-BLOCKER-V1", response: "同意同意同意" }],
        }),
        artifactIds: [],
        createdAt: "2026-08-29T08:03:00.000Z",
      },
      {
        id: randomUUID(),
        phaseRunId,
        decision: "request_changes",
        comment: serializeHumanDecisionCapture({
          phaseId: "discovery",
          responses: [{
            id: "PRODUCT-STORIES-BLOCKER-V1",
            response: "直接改成红色主题，layout 可以调整。",
          }],
        }),
        artifactIds: [],
        createdAt: "2026-08-29T08:02:00.000Z",
      },
      {
        id: randomUUID(),
        phaseRunId,
        decision: "request_changes",
        comment: serializeHumanDecisionCapture({
          phaseId: "discovery",
          responses: [{
            id: "PRODUCT-HANDOFF-INCOMPLETE",
            response: "No need to highlight metrics; only redesign the profile page.",
          }],
        }),
        artifactIds: [],
        createdAt: "2026-08-29T08:01:00.000Z",
      },
    ],
    executions: [],
    events: [],
    availableArtifacts: [],
    createdAt: now,
    updatedAt: now,
  };
  const store = new SuccessfulProviderStore({
    project,
    run,
    phases: [phase],
    artifactPaths: {},
    agentSessionRun: {
      sessionId: randomUUID(),
      triggerMessageId: randomUUID(),
      workflowRunId: run.id,
      createdAt: now,
    },
  });
  const providerPort = providerStatusPort("configured-model");
  const settledOutcomes: ProviderPhaseExecutionOutcome[] = [];
  let runtimeFailure: Error | null = null;
  const runtime = {
    async run(input: ProviderNativeAgentInput): Promise<ProviderNativeAgentResult> {
      if (runtimeFailure) throw runtimeFailure;
      assert.equal(input.providerId, "ollama");
      assert.match(input.instruction, new RegExp(escapeRegExp(prd.relativePath), "u"));
      assert.match(input.instruction, /直接改成红色主题，layout 可以调整/u);
      assert.match(input.instruction, /No need to highlight metrics/u);
      assert.doesNotMatch(input.instruction, /同意同意同意|ai-sdlc:human-decisions:v1/u);
      assert.match(input.instruction, /结构化决定是权威产品事实/u);
      assert.match(input.instruction, /先用 write_file \+ overwrite=true.*不含 sentinel/su);
      assert.ok(input.instruction.length <= 31_500);
      assert.ok(input.messages.length <= 8);
      assert.equal(input.messages.at(-1)?.role, "user");
      assert.equal(input.limits?.reservedFinalizationToolCalls, 4);
      assert.equal(input.limits?.maxIdleTimeMs, 4 * 60_000);
      assert.equal(input.limits?.maxWallTimeMs, 30 * 60_000);
      assert.equal(input.toolHost.definitions().some(({ name }) => name === "run_check"), false);
      await input.toolHost.execute({
        type: "function",
        id: "write-prd",
        name: "write_file",
        arguments: {
          path: prd.relativePath,
          content: "# Provider-native PRD\n\nStatus: Awaiting human review.\n",
          overwrite: false,
        },
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      });
      await input.toolHost.execute({
        type: "function",
        id: "create-stories",
        name: "create_directory",
        arguments: { path: `${stories.relativePath}/profile/US-001-review-profile` },
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      });
      await input.toolHost.execute({
        type: "function",
        id: "write-story",
        name: "write_file",
        arguments: {
          path: `${stories.relativePath}/profile/US-001-review-profile/story.md`,
          content: reviewableStory(),
          overwrite: false,
        },
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      });
      return {
        providerId: "ollama",
        model: "actual-provider-model",
        text: "产物已写入，等待人工审核。",
        stopReason: "completed",
        modelCalls: 2,
        toolSteps: [],
        usage: { inputTokens: 100, outputTokens: 40 },
        durationMs: 25,
      };
    },
  } as ProviderNativeAgentRuntime;
  const runner = new CodexTerminalRunner({
    binary: path.join(rootPath, "codex-must-not-be-invoked"),
    fake: false,
  });
  const providerExecutor = new ProviderPhaseExecutor(runtime, runner, providerPort);
  const service = new WorkflowService(
    store as unknown as PgWorkflowStore,
    new ProjectPathPolicy([parent]),
    runner,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    1,
    providerExecutor,
  );

  const execution = await service.executePhase(run.id, "discovery", {
    selectedArtifactIds: [],
    selectedOutputKeys: ["prd", "user-stories"],
  }, {
    providerId: "ollama",
    messages: [{ role: "user", content: "继续当前会话，完成第一阶段产物。" }],
    onExecutionSettled: async (outcome) => { settledOutcomes.push(outcome); },
  });
  await service.waitForIdle();

  assert.equal(execution.runnerMode, "real");
  assert.equal(execution.model, "actual-provider-model");
  assert.equal(execution.reasoningEffort, null);
  assert.equal(execution.command, "provider-native:ollama");
  assert.equal(phase.status, "awaiting_review");
  assert.deepEqual(phase.artifacts.map(({ artifactKey }) => artifactKey), ["prd", "user-stories"]);
  assert.match(await readFile(prd.absolutePath, "utf8"), /Provider-native PRD/u);
  assert.deepEqual(
    phase.events.filter(({ eventType }) => eventType.startsWith("runner."))
      .map(({ eventType }) => eventType),
    ["runner.started", "runner.completed"],
  );
  assert.deepEqual(settledOutcomes.at(-1), {
    executionId: execution.id,
    runId: run.id,
    phaseId: "discovery",
    state: "awaiting_review",
    artifactKeys: ["prd", "user-stories"],
    message: "本阶段产物已完整落盘并进入人工审核。",
  });

  runtimeFailure = new AskProviderError(
    "ollama",
    "ASK_PROVIDER_TIMEOUT",
    "模型服务响应超时，请检查服务状态或稍后重试",
    "unreachable",
    504,
    true,
  );
  Object.assign(runtimeFailure, {
    rawBody: "RAW_PROVIDER_BODY_MUST_NOT_PERSIST",
    requestPath: "/srv/private/provider-endpoint",
    apiKey: "sk-must-not-persist-1234567890",
  });
  const failedExecution = await service.executePhase(run.id, "discovery", {
    selectedArtifactIds: [],
    selectedOutputKeys: ["prd", "user-stories"],
  }, {
    providerId: "ollama",
    messages: [{ role: "user", content: "重试当前阶段" }],
    onExecutionSettled: async (outcome) => { settledOutcomes.push(outcome); },
  });
  await service.waitForIdle();

  assert.equal(failedExecution.status, "failed");
  assert.match(failedExecution.error ?? "", /ASK_PROVIDER_TIMEOUT/u);
  assert.match(failedExecution.error ?? "", /模型服务响应超时/u);
  assert.doesNotMatch(
    failedExecution.error ?? "",
    /RAW_PROVIDER_BODY_MUST_NOT_PERSIST|\/srv\/private|sk-must-not-persist/u,
  );
  const failedEvent = phase.events.filter(({ eventType }) => eventType === "runner.failed").at(-1);
  assert.deepEqual(failedEvent?.payload, { message: failedExecution.error });
  assert.deepEqual(settledOutcomes.at(-1), {
    executionId: failedExecution.id,
    runId: run.id,
    phaseId: "discovery",
    state: "failed",
    artifactKeys: [],
    message: failedExecution.error,
  });

  const missingOutputFailure = new AppError(
    "缺失 artifact key: user-stories；本次选中产物变更已回滚。",
    409,
    "OUTPUT_ARTIFACTS_MISSING",
  );
  Object.assign(missingOutputFailure, {
    rawBody: "RAW_PROVIDER_OUTPUT_MUST_NOT_PERSIST",
    absolutePath: path.join(rootPath, stories.relativePath),
  });
  runtimeFailure = missingOutputFailure;
  const missingOutputExecution = await service.executePhase(run.id, "discovery", {
    selectedArtifactIds: [],
    selectedOutputKeys: ["prd", "user-stories"],
  }, {
    providerId: "ollama",
    messages: [{ role: "user", content: "再次重试当前阶段" }],
    onExecutionSettled: async (outcome) => { settledOutcomes.push(outcome); },
  });
  await service.waitForIdle();

  assert.equal(missingOutputExecution.status, "failed");
  assert.match(missingOutputExecution.error ?? "", /OUTPUT_ARTIFACTS_MISSING/u);
  assert.match(missingOutputExecution.error ?? "", /user-stories/u);
  assert.match(missingOutputExecution.error ?? "", /回滚|恢复|roll.?back|restor/iu);
  assert.doesNotMatch(
    missingOutputExecution.error ?? "",
    /RAW_PROVIDER_OUTPUT_MUST_NOT_PERSIST|provider-output-gate|\/srv\/private/u,
  );
  const missingOutputEvent = phase.events
    .filter(({ eventType }) => eventType === "runner.failed")
    .at(-1);
  assert.deepEqual(missingOutputEvent?.payload, { message: missingOutputExecution.error });
  assert.deepEqual(settledOutcomes.at(-1), {
    executionId: missingOutputExecution.id,
    runId: run.id,
    phaseId: "discovery",
    state: "failed",
    artifactKeys: [],
    message: missingOutputExecution.error,
  });

  const invalidOutputFailure = new AppError(
    "artifact key: user-stories 包含不可审核的 placeholder 正文",
    422,
    "OUTPUT_ARTIFACTS_INVALID",
    {
      invalid: ["user-stories"],
      qualityIssues: [
        "BLOCKER_STATUS_MUST_BE_EXACT",
        "BLOCKER_WORKFLOW_MECHANISM_FORBIDDEN",
      ],
    },
  );
  Object.assign(invalidOutputFailure, {
    rawBody: "RAW_INVALID_STORY_BODY_MUST_NOT_PERSIST",
    absolutePath: path.join(rootPath, stories.relativePath, "README.md"),
  });
  runtimeFailure = invalidOutputFailure;
  const invalidOutputExecution = await service.executePhase(run.id, "discovery", {
    selectedArtifactIds: [],
    selectedOutputKeys: ["prd", "user-stories"],
  }, {
    providerId: "ollama",
    messages: [{ role: "user", content: "修复不可审核的故事产物" }],
    onExecutionSettled: async (outcome) => { settledOutcomes.push(outcome); },
  });
  await service.waitForIdle();

  assert.equal(invalidOutputExecution.status, "failed");
  assert.match(invalidOutputExecution.error ?? "", /OUTPUT_ARTIFACTS_INVALID/u);
  assert.match(invalidOutputExecution.error ?? "", /Status.*Blocked.*Pending/u);
  assert.match(invalidOutputExecution.error ?? "", /产品或业务事实.*平台工作流机制/u);
  assert.match(invalidOutputExecution.error ?? "", /user-stories/u);
  assert.match(invalidOutputExecution.error ?? "", /本次已尝试写入/u);
  assert.match(invalidOutputExecution.error ?? "", /未通过可审核质量检查/u);
  assert.match(invalidOutputExecution.error ?? "", /本轮不合格写入已全部回滚/u);
  assert.doesNotMatch(
    invalidOutputExecution.error ?? "",
    /完全没写|完全没有写入|完全未写入|没有尝试写入/u,
  );
  assert.doesNotMatch(
    invalidOutputExecution.error ?? "",
    /RAW_INVALID_STORY_BODY_MUST_NOT_PERSIST|README\.md|placeholder/u,
  );
  const invalidOutputEvent = phase.events
    .filter(({ eventType }) => eventType === "runner.failed")
    .at(-1);
  assert.deepEqual(invalidOutputEvent?.payload, { message: invalidOutputExecution.error });
  assert.deepEqual(settledOutcomes.at(-1), {
    executionId: invalidOutputExecution.id,
    runId: run.id,
    phaseId: "discovery",
    state: "failed",
    artifactKeys: [],
    message: invalidOutputExecution.error,
  });

  const toolLoopFailure = new AppError(
    "Provider 连续三次给出不可执行的工具调用，本轮已停止",
    422,
    "AGENT_TOOL_FAILURE_LIMIT",
  );
  Object.assign(toolLoopFailure, {
    rawArguments: "PRIVATE_TOOL_ARGUMENTS_MUST_NOT_PERSIST",
    absolutePath: path.join(rootPath, stories.relativePath, "private-story.md"),
  });
  runtimeFailure = toolLoopFailure;
  const toolLoopExecution = await service.executePhase(run.id, "discovery", {
    selectedArtifactIds: [],
    selectedOutputKeys: ["prd", "user-stories"],
  }, {
    providerId: "ollama",
    messages: [{ role: "user", content: "修复工具调用并重试" }],
    onExecutionSettled: async (outcome) => { settledOutcomes.push(outcome); },
  });
  await service.waitForIdle();

  assert.equal(toolLoopExecution.status, "failed");
  assert.match(toolLoopExecution.error ?? "", /AGENT_TOOL_FAILURE_LIMIT/u);
  assert.match(toolLoopExecution.error ?? "", /连续 3 次工具调用未执行/u);
  assert.match(toolLoopExecution.error ?? "", /高级审计/u);
  assert.match(toolLoopExecution.error ?? "", /所选阶段产物未进入审核/u);
  assert.match(toolLoopExecution.error ?? "", /选择产物路径上的未完成写入已回滚/u);
  assert.match(toolLoopExecution.error ?? "", /切换 Provider\/模型/u);
  assert.doesNotMatch(
    toolLoopExecution.error ?? "",
    /PRIVATE_TOOL_ARGUMENTS_MUST_NOT_PERSIST|private-story\.md/u,
  );
  const toolLoopEvent = phase.events
    .filter(({ eventType }) => eventType === "runner.failed")
    .at(-1);
  assert.deepEqual(toolLoopEvent?.payload, { message: toolLoopExecution.error });
  assert.deepEqual(settledOutcomes.at(-1), {
    executionId: toolLoopExecution.id,
    runId: run.id,
    phaseId: "discovery",
    state: "failed",
    artifactKeys: [],
    message: toolLoopExecution.error,
  });

  runtimeFailure = new AppError(
    "PRIVATE_REQUIRED_TOOL_DIAGNOSTIC",
    502,
    "AGENT_PROVIDER_REQUIRED_TOOL_MISSING",
    {
      requiredToolName: "write_file",
      reasonCode: "PRODUCT_DECISION_MATERIALIZATION_REQUIRED",
      affectedArtifactKeys: ["prd"],
      issueIds: ["PRODUCT-MATERIALIZATION-PRD-PENDING-SECTION"],
    },
  );
  const requiredToolExecution = await service.executePhase(run.id, "discovery", {
    selectedArtifactIds: [],
    selectedOutputKeys: ["prd", "user-stories"],
  }, {
    providerId: "ollama",
    messages: [{ role: "user", content: "切换支持严格工具调用的模型后重试" }],
  });
  await service.waitForIdle();

  assert.equal(requiredToolExecution.status, "failed");
  assert.match(requiredToolExecution.error ?? "", /AGENT_PROVIDER_REQUIRED_TOOL_MISSING/u);
  assert.match(requiredToolExecution.error ?? "", /产物自动修复需要模型调用“写入文件”/u);
  assert.match(requiredToolExecution.error ?? "", /文字说明误判为文件修改/u);
  assert.match(requiredToolExecution.error ?? "", /最后一次质量门禁：PRD仍含未物化决定、开放问题或 Blocker/u);
  assert.match(requiredToolExecution.error ?? "", /严格 function calling/u);
  assert.match(requiredToolExecution.error ?? "", /当前 Session 重试当前角色/u);
  assert.doesNotMatch(
    requiredToolExecution.error ?? "",
    /PRIVATE_REQUIRED_TOOL_DIAGNOSTIC/u,
  );

  runtimeFailure = new AppError(
    "PRIVATE_IDLE_TIMEOUT_DIAGNOSTIC",
    408,
    "AGENT_RUNTIME_IDLE_TIMEOUT",
  );
  const idleTimeoutExecution = await service.executePhase(run.id, "discovery", {
    selectedArtifactIds: [],
    selectedOutputKeys: ["prd", "user-stories"],
  }, {
    providerId: "ollama",
    messages: [{ role: "user", content: "模型恢复后重试" }],
  });
  await service.waitForIdle();

  assert.equal(idleTimeoutExecution.status, "failed");
  assert.match(idleTimeoutExecution.error ?? "", /AGENT_RUNTIME_IDLE_TIMEOUT/u);
  assert.match(idleTimeoutExecution.error ?? "", /没有收到新的模型响应或工具结果/u);
  assert.match(idleTimeoutExecution.error ?? "", /模型已经加载且服务没有排队/u);
  assert.match(idleTimeoutExecution.error ?? "", /没有新产物进入审核/u);
  assert.match(idleTimeoutExecution.error ?? "", /已选择产物路径上的未完成写入已回滚/u);
  assert.match(idleTimeoutExecution.error ?? "", /此前持久化版本和审计记录仍保留/u);
  assert.match(idleTimeoutExecution.error ?? "", /仍保留在 Diff 中/u);
  assert.match(idleTimeoutExecution.error ?? "", /切换 Provider\/模型/u);
  assert.doesNotMatch(idleTimeoutExecution.error ?? "", /PRIVATE_IDLE_TIMEOUT_DIAGNOSTIC/u);

  runtimeFailure = new AppError(
    "PRIVATE_WALL_TIMEOUT_DIAGNOSTIC",
    408,
    "AGENT_RUNTIME_TIMEOUT",
  );
  const wallTimeoutExecution = await service.executePhase(run.id, "discovery", {
    selectedArtifactIds: [],
    selectedOutputKeys: ["prd", "user-stories"],
  }, {
    providerId: "ollama",
    messages: [{ role: "user", content: "切换更快的模型后重试" }],
  });
  await service.waitForIdle();

  assert.equal(wallTimeoutExecution.status, "failed");
  assert.match(wallTimeoutExecution.error ?? "", /AGENT_RUNTIME_TIMEOUT/u);
  assert.match(wallTimeoutExecution.error ?? "", /绝对运行上限/u);
  assert.match(wallTimeoutExecution.error ?? "", /避免工具循环无限运行/u);
  assert.match(wallTimeoutExecution.error ?? "", /高级审计.*最后完成的工具步骤/u);
  assert.match(wallTimeoutExecution.error ?? "", /更小的 Change Contract 和新 Run/u);
  assert.doesNotMatch(wallTimeoutExecution.error ?? "", /PRIVATE_WALL_TIMEOUT_DIAGNOSTIC/u);
});

function reviewableStory(): string {
  return `# US-001: Review the improved profile

**Category:** profile

## User story

As a visitor, I want to scan the profile, so that I can understand the owner's experience.

## Acceptance criteria

### US-001-AC-01: Core path

\`\`\`gherkin
Given the visitor opens the profile
When the profile content is displayed
Then the visitor can identify the owner's AI SDLC experience
\`\`\`

### US-001-AC-02: Missing optional details

\`\`\`gherkin
Given an optional metric is not confirmed
When the visitor reads the AI SDLC section
Then the profile marks that metric as awaiting owner confirmation
\`\`\`
`;
}

test("provider-native guard restores selected outputs when a required artifact is missing", async () => {
  const fixture = await runnerFixture(["prd", "user-stories"]);
  const prd = fixture.definition.artifacts[0]!;
  const baseline = "# Existing reviewed PRD\n";
  const events: Array<{ eventType: string; payload: unknown }> = [];
  await writeFile(prd.absolutePath, baseline, "utf8");

  await assert.rejects(
    () => fixture.runner.runProviderNative(
      fixture.request,
      "custom",
      async () => {
        await writeFile(prd.absolutePath, "# Incomplete replacement\n", "utf8");
        return { model: "provider-model", modelCalls: 1, toolCalls: 1, durationMs: 10 };
      },
      async (eventType, payload) => { events.push({ eventType, payload }); },
    ),
    (error: unknown) => (error as { code?: string }).code === "OUTPUT_ARTIFACTS_MISSING",
  );
  assert.equal(await readFile(prd.absolutePath, "utf8"), baseline);
  assert.deepEqual(events.map(({ eventType }) => eventType), ["runner.started"]);
  assert.deepEqual(events[0]?.payload, {
    mode: "real",
    runtime: "provider-native",
    command: "provider-native:custom",
    workingDirectory: "repository://run-workspace",
    phaseId: "discovery",
    selectedOutputKeys: ["prd", "user-stories"],
    model: null,
    requestedModel: "configured-provider-model",
    reasoningEffort: null,
    workspaceRevisionToken: null,
    verificationGitState: null,
  });
});

test("provider Control Pack symlinks and hardlinks fail closed before any model call", async (t) => {
  for (const linkKind of ["symlink", "hardlink"] as const) {
    await t.test(linkKind, async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), `ai-sdlc-provider-control-${linkKind}-`));
      temporaryRoots.push(parent);
      const requestedRoot = path.join(parent, "project");
      await initializeCodexProject(requestedRoot, "Unsafe control", "Reject linked control files");
      const rootPath = await realpath(requestedRoot);
      const outside = path.join(parent, "host-private.txt");
      const privateMarker = "host-private-material-must-not-reach-provider";
      await writeFile(outside, privateMarker, "utf8");
      const workflowPath = path.join(rootPath, ".ai-sdlc", "roles", "pm-ba", "workflow.md");
      await rm(workflowPath);
      if (linkKind === "symlink") await symlink(outside, workflowPath);
      else await link(outside, workflowPath);

      const definition = await loadDefinition(rootPath);
      const phase = definition.phases.find(({ id }) => id === "discovery");
      assert.ok(phase);
      const now = "2026-08-29T08:00:00.000Z";
      const project: ProjectDto = {
        id: randomUUID(),
        name: "Unsafe control",
        summary: "Reject linked control files",
        rootPath,
        configPath: definition.configPath,
        runCount: 1,
        createdAt: now,
        updatedAt: now,
      };
      const run: WorkflowRunDto = {
        id: randomUUID(),
        projectId: project.id,
        title: "Unsafe control",
        objective: "Do not expose host files",
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      let runtimeCalled = false;
      const runtime = {
        async run(): Promise<ProviderNativeAgentResult> {
          runtimeCalled = true;
          throw new Error("provider runtime must not receive an unsafe control pack");
        },
      } as ProviderNativeAgentRuntime;
      const runner = new CodexTerminalRunner({
        binary: path.join(rootPath, "codex-must-not-be-invoked"),
        fake: false,
      });
      const executor = new ProviderPhaseExecutor(
        runtime,
        runner,
        providerStatusPort("configured-model"),
      );
      const selectedOutputKeys = ["prd", "user-stories"];
      await assert.rejects(() => executor.run({
        executionId: randomUUID(),
        project,
        run,
        phase,
        definition,
        selectedArtifacts: [],
        selectedOutputKeys,
        model: "configured-model",
        reasoningEffort: null,
      }, {
        providerId: "openai",
        messages: [{ role: "user", content: "继续当前阶段" }],
      }, async (_eventType, payload) => {
        assert.doesNotMatch(JSON.stringify(payload), new RegExp(privateMarker, "u"));
      }));
      assert.equal(runtimeCalled, false);
    });
  }
});

test("Implementation Provider is wired to protected control and unselected-artifact paths", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-provider-implementation-boundary-"));
  temporaryRoots.push(parent);
  const requestedRoot = path.join(parent, "project");
  await initializeCodexProject(
    requestedRoot,
    "Implementation boundary",
    "Keep source edits possible while protecting workflow control state",
  );
  const rootPath = await realpath(requestedRoot);
  const now = "2026-08-29T08:00:00.000Z";
  const run: WorkflowRunDto = {
    id: randomUUID(),
    projectId: randomUUID(),
    title: "Protected implementation",
    objective: "Edit source without mutating workflow control files",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const project: ProjectDto = {
    id: run.projectId,
    name: "Implementation boundary",
    summary: "Provider-native write boundary",
    rootPath,
    configPath: path.join(rootPath, "ai-native.yaml"),
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const definition = resolveTaskArtifactPaths(await loadDefinition(rootPath), run);
  const phase = definition.phases.find(({ id }) => id === "implementation");
  const selectedOutput = definition.artifacts.find(({ id }) => id === "implementation-notes");
  const unselectedOutput = definition.artifacts.find(({ id }) => id === "implementation-plan");
  assert.ok(phase);
  assert.ok(selectedOutput);
  assert.ok(unselectedOutput);
  const unselectedBaseline = "# Existing protected plan\n";
  await mkdir(path.dirname(unselectedOutput.absolutePath), { recursive: true });
  await writeFile(unselectedOutput.absolutePath, unselectedBaseline, "utf8");

  let runtimeCalled = false;
  const runtime = {
    async run(input: ProviderNativeAgentInput): Promise<ProviderNativeAgentResult> {
      runtimeCalled = true;
      assert.equal(input.limits?.reservedFinalizationToolCalls, 4);
      assert.equal(input.limits?.maxIdleTimeMs, 4 * 60_000);
      assert.equal(input.limits?.maxWallTimeMs, 45 * 60_000);
      const execute = (
        name: "create_directory" | "write_file",
        argumentsValue: Record<string, unknown>,
      ) => input.toolHost.execute({
        type: "function",
        id: `implementation-${name}`,
        name,
        arguments: argumentsValue,
      }, {
        signal: new AbortController().signal,
        maxOutputCharacters: 10_000,
      });
      for (const [target, content, overwrite] of [
        [".ai-sdlc/tasks/injected.md", "injected\n", false],
        [".codex/config.toml", "model = \"forged\"\n", false],
        [unselectedOutput.relativePath, unselectedBaseline, true],
      ] as const) {
        await assert.rejects(
          () => execute("write_file", { path: target, content, overwrite }),
          (error: unknown) => (
            (error as { code?: string }).code === "AGENT_PROTECTED_PATH_FORBIDDEN"
          ),
        );
      }
      await execute("create_directory", { path: path.dirname(selectedOutput.relativePath) });
      await execute("write_file", {
        path: selectedOutput.relativePath,
        content: "# Implementation notes\n\nSelected Provider output.\n",
        overwrite: false,
      });
      await execute("create_directory", { path: "src" });
      await execute("write_file", {
        path: "src/provider-native-boundary.ts",
        content: "export const providerNativeBoundary = true;\n",
        overwrite: false,
      });
      return {
        providerId: "openai",
        model: "actual-provider-model",
        text: "实现和选中证据已写入。",
        stopReason: "completed",
        modelCalls: 1,
        toolSteps: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 10,
      };
    },
  } as ProviderNativeAgentRuntime;
  const result = await new ProviderPhaseExecutor(
    runtime,
    new CodexTerminalRunner({
      binary: path.join(rootPath, "codex-must-not-be-invoked"),
      fake: false,
    }),
    providerStatusPort("configured-model"),
  ).run({
    executionId: randomUUID(),
    project,
    run,
    phase,
    definition,
    selectedArtifacts: [],
    selectedOutputKeys: [selectedOutput.id],
    model: "configured-model",
    reasoningEffort: null,
  }, {
    providerId: "openai",
    messages: [{ role: "user", content: "继续当前 Session 的实现阶段" }],
  }, async () => undefined);

  assert.equal(runtimeCalled, true);
  assert.equal(result.model, "actual-provider-model");
  assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), [selectedOutput.id]);
  assert.equal(await readFile(unselectedOutput.absolutePath, "utf8"), unselectedBaseline);
  assert.match(await readFile(selectedOutput.absolutePath, "utf8"), /Selected Provider output/u);
  assert.match(
    await readFile(path.join(rootPath, "src", "provider-native-boundary.ts"), "utf8"),
    /providerNativeBoundary/u,
  );
  await assert.rejects(readFile(path.join(rootPath, ".ai-sdlc", "tasks", "injected.md"), "utf8"));
  await assert.rejects(readFile(path.join(rootPath, ".codex", "config.toml"), "utf8"));
});

test("provider-native guard rejects and restores out-of-scope mutations", async () => {
  const fixture = await runnerFixture(["prd"], ["protected-notes"]);
  const prd = fixture.definition.artifacts.find(({ id }) => id === "prd")!;
  const protectedArtifact = fixture.definition.artifacts.find(({ id }) => id === "protected-notes")!;
  const selectedBaseline = "# Existing PRD\n";
  const protectedBaseline = "# Protected upstream evidence\n";
  await writeFile(prd.absolutePath, selectedBaseline, "utf8");
  await writeFile(protectedArtifact.absolutePath, protectedBaseline, "utf8");

  await assert.rejects(() => fixture.runner.runProviderNative(
    fixture.request,
    "openai",
    async () => {
      await writeFile(prd.absolutePath, "# Replacement PRD\n", "utf8");
      await writeFile(protectedArtifact.absolutePath, "# Illicit rewrite\n", "utf8");
      return { model: "provider-model", modelCalls: 1, toolCalls: 2, durationMs: 10 };
    },
    async () => undefined,
  ));
  assert.equal(await readFile(prd.absolutePath, "utf8"), selectedBaseline);
  assert.equal(await readFile(protectedArtifact.absolutePath, "utf8"), protectedBaseline);
});

test("legacy Codex runner behavior remains unchanged", async () => {
  const fixture = await runnerFixture(["prd"], [], true);
  const events: string[] = [];
  const result = await fixture.runner.run(fixture.request, async (eventType) => {
    events.push(eventType);
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.artifacts[0]?.content ?? "", /Deterministic fake artifact/u);
  assert.deepEqual(events, ["runner.started", "runner.completed"]);
});

class SuccessfulProviderStore {
  private readonly executions = new Map<string, ExecutionDto>();

  constructor(readonly bundle: RunBundle) {}

  async getRun(runId: string): Promise<RunBundle> {
    assert.equal(runId, this.bundle.run.id);
    return this.bundle;
  }

  async selectionArtifacts(runId: string, ids: string[]): Promise<SelectionArtifact[]> {
    assert.equal(runId, this.bundle.run.id);
    assert.deepEqual(ids, []);
    return [];
  }

  async currentArtifactSnapshotsForPhase(runId: string, phaseId: PhaseId) {
    assert.equal(runId, this.bundle.run.id);
    assert.equal(phaseId, "discovery");
    return this.bundle.phases[0]!.artifacts.map((artifact) => ({
      ...artifact,
      content: artifact.content ?? "",
    }));
  }

  async createExecution(
    runId: string,
    phaseId: PhaseId,
    selectedArtifactIds: string[],
    selectedOutputKeys: string[],
    runnerMode: CodexRunnerMode,
    model: string | null,
    reasoningEffort: CodexReasoningEffort | null,
    command: string,
  ): Promise<ExecutionDto> {
    assert.equal(runId, this.bundle.run.id);
    assert.equal(phaseId, "discovery");
    assert.equal(runnerMode, "real");
    assert.equal(model, null, "configured Provider model must not masquerade as an observed model");
    assert.equal(reasoningEffort, null);
    assert.equal(command, "provider-native:ollama");
    const phase = this.bundle.phases[0]!;
    const execution: ExecutionDto = {
      id: randomUUID(),
      phaseRunId: phase.id,
      status: "running",
      selectedArtifactIds,
      selectedOutputKeys,
      runnerMode,
      model,
      reasoningEffort,
      command,
      exitCode: null,
      error: null,
      startedAt: "2026-08-29T08:01:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-29T08:01:00.000Z",
    };
    phase.executions.push(execution);
    phase.status = "running";
    this.executions.set(execution.id, execution);
    return execution;
  }

  async appendEvent(
    executionId: string,
    sequence: number,
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    this.requiredExecution(executionId);
    this.bundle.phases[0]!.events.push({
      id: randomUUID(),
      executionId,
      sequence,
      eventType,
      payload,
      createdAt: "2026-08-29T08:02:00.000Z",
    });
  }

  async completeExecution(
    executionId: string,
    exitCode: number,
    outputs: ArtifactRecordInput[],
    _ticketSync: unknown,
    actualModel?: string,
  ): Promise<void> {
    const execution = this.requiredExecution(executionId);
    assert.equal(exitCode, 0);
    assert.equal(actualModel, "actual-provider-model");
    assert.deepEqual(outputs.map(({ artifactKey }) => artifactKey), ["prd", "user-stories"]);
    execution.status = "completed";
    execution.model = actualModel ?? execution.model;
    execution.exitCode = exitCode;
    execution.finishedAt = "2026-08-29T08:03:00.000Z";
    const phase = this.bundle.phases[0]!;
    for (const output of outputs) {
      phase.artifacts.push({
        id: randomUUID(),
        phaseRunId: phase.id,
        artifactKey: output.artifactKey,
        filePath: output.filePath,
        content: output.content,
        contentHash: output.contentHash,
        reviewStatus: "pending",
        revision: 1,
        revisionSource: "ai",
        parentArtifactId: null,
        createdAt: "2026-08-29T08:03:00.000Z",
      });
    }
    phase.status = "awaiting_review";
  }

  async failExecution(executionId: string, exitCode: number | null, error: string): Promise<void> {
    const execution = this.requiredExecution(executionId);
    execution.status = "failed";
    execution.exitCode = exitCode;
    execution.error = error;
    this.bundle.phases[0]!.status = "failed";
  }

  private requiredExecution(executionId: string): ExecutionDto {
    const execution = this.executions.get(executionId);
    assert.ok(execution);
    return execution;
  }
}

async function runnerFixture(
  selectedIds: string[],
  protectedIds: string[] = [],
  fake = false,
): Promise<{
  runner: CodexTerminalRunner;
  definition: LoadedDefinition;
  request: CodexRunRequest;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-provider-phase-runner-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  const phase: PhaseDefinition = {
    id: "discovery",
    owner: "pm-ba",
    inputs: [],
    outputs: selectedIds,
    gate: "human review",
  };
  const artifactIds = [...selectedIds, ...protectedIds];
  const definition: LoadedDefinition = {
    version: 1,
    project: { name: "Provider runner", summary: "Guarded phase fixture" },
    roles: [{ id: "pm-ba", name: "PM / BA", mission: "Define scope", responsibilities: [] }],
    phases: [phase],
    agentClient: "codex",
    agentDirectory: ".codex/agents",
    outputRoot: path.join(root, "docs"),
    releaseEvidenceValidationRequired: false,
    artifacts: artifactIds.map((id) => ({
      id,
      owner: "pm-ba",
      relativePath: `docs/${id}.md`,
      absolutePath: path.join(root, "docs", `${id}.md`),
    })),
    configPath: path.join(root, "ai-native.yaml"),
  };
  const now = "2026-08-29T08:00:00.000Z";
  const project: ProjectDto = {
    id: randomUUID(),
    name: "Provider runner",
    summary: "Guarded phase fixture",
    rootPath: root,
    configPath: definition.configPath,
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const run: WorkflowRunDto = {
    id: randomUUID(),
    projectId: project.id,
    title: "Provider runner",
    objective: "Exercise guarded provider execution",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const runner = new CodexTerminalRunner({
    binary: path.join(root, "codex-must-not-be-invoked"),
    fake,
  });
  return {
    runner,
    definition,
    request: {
      executionId: randomUUID(),
      project,
      run,
      phase,
      definition,
      selectedArtifacts: [],
      selectedOutputKeys: selectedIds,
      model: fake ? "legacy-codex-model" : "configured-provider-model",
      reasoningEffort: fake ? "high" : null,
    },
  };
}

function providerStatusPort(model: string): Pick<AskProviderRegistry, "status"> {
  return {
    status(providerId: AskProviderId): AskProviderStatusDto {
      return {
        id: providerId,
        label: providerId,
        configured: true,
        model,
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
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
