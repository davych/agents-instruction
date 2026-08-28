import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  PHASE_IDS,
  type ArtifactDto,
  type ExecutionDto,
  type PhaseId,
  type PhaseRunDto,
} from "@ai-sdlc/contracts";

import {
  AgentSdlcCoordinator,
  explicitRoleContinuation,
  latestSessionRunId,
  type SdlcRoleId,
} from "../src/services/agent/agent-sdlc-coordinator.ts";
import { AGENT_WORK_BOUNDARY_MESSAGE } from "../src/services/agent/agent-session-service.ts";
import { ConversationPlanner } from "../src/services/agent/conversation-planner.ts";
import { AppError } from "../src/domain/errors.ts";
import type { AskProviderRegistry } from "../src/services/llm/provider-registry.ts";
import type { AskLlmCompleteRequest } from "../src/services/llm/types.ts";
import type { WorkflowService } from "../src/services/workflow-service.ts";

const now = "2026-08-28T10:00:00.000Z";

const definitions = [
  { id: "discovery", owner: "pm-ba", inputs: [], outputs: ["change-contract", "prd", "user-stories"] },
  { id: "design", owner: "designer", inputs: ["change-contract", "prd", "user-stories"], outputs: ["design-baseline", "design-spec", "design-prototype", "figma-handoff"] },
  { id: "architecture", owner: "architect", inputs: ["change-contract", "prd", "user-stories", "design-spec"], outputs: ["architecture", "architecture-discovery-context", "architecture-options", "architecture-c4-containers", "architecture-adrs", "architecture-patterns", "architecture-nfrs", "architecture-adversarial"] },
  { id: "implementation", owner: "software-engineer", inputs: ["change-contract", "prd", "user-stories", "design-baseline", "design-spec", "architecture", "architecture-c4-containers", "architecture-adrs", "architecture-patterns", "architecture-nfrs"], outputs: ["implementation-notes", "implementation-plan", "implementation-tasks", "engineering-session-log", "engineering-test-evidence", "engineering-review", "engineering-provenance"] },
  { id: "verification", owner: "tester", inputs: ["change-contract", "prd", "user-stories", "design-spec", "architecture", "architecture-nfrs", "implementation-notes", "engineering-test-evidence", "engineering-review"], outputs: ["test-report"] },
  { id: "release", owner: "devops", inputs: ["change-contract", "architecture", "architecture-adrs", "architecture-nfrs", "architecture-adversarial", "implementation-notes", "engineering-provenance", "test-report"], outputs: ["release-runbook"] },
] as const;

test("CHAT-SDLC-01: a future involve role is only a focus label and PM / BA still starts", async () => {
  const fixture = coordinatorFixture(0, "ready");
  const result = await fixture.coordinator.advance({
    runId: fixture.runId,
    requestedRoles: [],
    startCurrentRole: true,
  });

  assert.equal(result.state, "started");
  if (result.state !== "started") return;
  assert.equal(result.phaseId, "discovery");
  assert.equal(result.roleId, "pm-ba");
  assert.deepEqual(result.selectedArtifactIds, []);
  assert.deepEqual(fixture.executions.map(({ phaseId }) => phaseId), ["discovery"]);

  const focused = coordinatorFixture(0, "ready");
  const withFutureFocus = await focused.coordinator.advance({
    runId: focused.runId,
    requestedRoles: ["architect"],
    startCurrentRole: true,
  });
  assert.equal(withFutureFocus.state, "started");
  assert.equal("roleId" in withFutureFocus ? withFutureFocus.roleId : null, "pm-ba");
  assert.deepEqual(focused.executions.map(({ phaseId }) => phaseId), ["discovery"]);
});

test("CHAT-SDLC-02: all six roles run in order even when only DevOps is involved", async () => {
  for (const [position, phaseId] of PHASE_IDS.entries()) {
    const fixture = coordinatorFixture(position, "ready");
    const result = await fixture.coordinator.advance({
      runId: fixture.runId,
      requestedRoles: ["devops"],
      startCurrentRole: true,
    });

    assert.equal(result.state, "started", `${phaseId} should start when its predecessors are approved`);
    assert.equal("roleId" in result ? result.roleId : null, roleForPhaseForTest(phaseId));
    const call = fixture.executions[0];
    assert.equal(call?.phaseId, phaseId);
    const expectedKeys = definitions[position]!.inputs;
    assert.deepEqual(
      (call?.selectedArtifactIds ?? []).map((id) => fixture.artifactKeyById.get(id)),
      [...expectedKeys],
      `${phaseId} must receive its configured inputs in order`,
    );
  }
});

function roleForPhaseForTest(phaseId: PhaseId): SdlcRoleId {
  return {
    discovery: "pm-ba",
    design: "designer",
    architecture: "architect",
    implementation: "software-engineer",
    verification: "tester",
    release: "devops",
  }[phaseId];
}

test("CHAT-SDLC-03: generated artifacts wait for review and are never auto-approved", async () => {
  const fixture = coordinatorFixture(1, "awaiting_review");
  const result = await fixture.coordinator.advance({
    runId: fixture.runId,
    requestedRoles: ["designer"],
    startCurrentRole: true,
  });

  assert.equal(result.state, "awaiting_review");
  assert.equal(fixture.executions.length, 0);
  assert.deepEqual("artifactKeys" in result ? result.artifactKeys : [], definitions[1].outputs);
  assert.match("reason" in result ? result.reason : "", /不会替人批准/u);
});

test("CHAT-SDLC-04: only explicit continue/involve language reuses an existing Run", () => {
  assert.deepEqual(explicitRoleContinuation("@repo 实现另一个独立功能"), {
    explicit: false,
    roles: ["software-engineer"],
  });
  assert.deepEqual(explicitRoleContinuation("继续这个 Run，并 involve Architect"), {
    explicit: true,
    roles: ["architect"],
  });
  assert.deepEqual(explicitRoleContinuation("请测试工程师继续验证现有产物"), {
    explicit: true,
    roles: ["tester"],
  });
  assert.equal(latestSessionRunId([
    { workflowRunId: "first", createdAt: "2026-08-28T00:00:00.000Z" },
    { workflowRunId: "latest", createdAt: "2026-08-28T00:01:00.000Z" },
  ]), "latest");
});

test("CHAT-SDLC-05: an unavailable role worker keeps the Run resumable instead of faking a start", async () => {
  const fixture = coordinatorFixture(0, "ready", new Error("operator worker unavailable"));
  const result = await fixture.coordinator.advance({
    runId: fixture.runId,
    requestedRoles: [],
    startCurrentRole: true,
  });
  assert.equal(result.state, "failed");
  assert.equal(fixture.executions.length, 0);
  assert.match("reason" in result ? result.reason : "", /Run 已保留/u);
});

test("CHAT-SDLC-06: Planner treats involveRoles as optional focus labels, not the execution set", async () => {
  let captured: AskLlmCompleteRequest | undefined;
  const providers = {
    complete: async (_providerId: string, request: AskLlmCompleteRequest) => {
      captured = request;
      return {
        text: JSON.stringify({
          intent: "work",
          reason: "需要修复一个明确问题",
          involveRoles: [],
          clarification: null,
          task: {
            title: "修复问题",
            workType: "bug",
            summary: "修复问题",
            currentBehavior: "当前失败",
            expectedBehavior: "恢复正常",
            inScope: ["修复"],
            outOfScope: [],
            acceptanceCriteria: ["测试通过"],
            regressionScope: ["相关路径"],
            riskFlags: [],
          },
        }),
        model: "planner-model",
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  } as unknown as AskProviderRegistry;
  const result = await new ConversationPlanner(providers).plan({
    providerId: "openai",
    content: "@repo 修复问题",
    repoAlias: "repo",
  });

  assert.equal(result.intent, "work");
  assert.deepEqual(result.involveRoles, []);
  assert.match(captured?.systemPrompt ?? "", /六个角色始终全部运行/u);
  assert.match(captured?.systemPrompt ?? "", /只是.*关注.*标签/u);
});

test("CHAT-SDLC-07: chat copy does not promise unimplemented external-write gates", () => {
  assert.match(AGENT_WORK_BOUNDARY_MESSAGE, /当前 MVP 不开放 DDL、Secret、外部写入/u);
  assert.match(AGENT_WORK_BOUNDARY_MESSAGE, /真正的人工门禁是每个阶段的 Artifact 审阅/u);
  assert.doesNotMatch(AGENT_WORK_BOUNDARY_MESSAGE, /外部写入会在这里暂停/u);
});

function coordinatorFixture(
  activePosition: number,
  activeStatus: PhaseRunDto["status"],
  executionFailure?: Error,
) {
  const runId = randomUUID();
  const artifactKeyById = new Map<string, string>();
  const phases = definitions.map((definition, position): PhaseRunDto => {
    const status = position < activePosition
      ? "approved"
      : position === activePosition
        ? activeStatus
        : "pending";
    const artifacts = position < activePosition || activeStatus === "awaiting_review" && position === activePosition
      ? definition.outputs.map((artifactKey) => artifact(runId, position, artifactKey, status === "approved"))
      : [];
    for (const item of artifacts) artifactKeyById.set(item.id, item.artifactKey);
    return {
      id: randomUUID(),
      workflowRunId: runId,
      phaseId: definition.id,
      position,
      status,
      artifacts,
      reviews: [],
      executions: [],
      events: [],
      availableArtifacts: [],
      resolution: null,
      architectureImpact: null,
      createdAt: now,
      updatedAt: now,
    };
  });
  const executions: Array<{ phaseId: PhaseId; selectedArtifactIds: string[] }> = [];
  const execution: ExecutionDto = {
    id: randomUUID(),
    phaseRunId: phases[activePosition]!.id,
    status: "running",
    selectedArtifactIds: [],
    selectedOutputKeys: [],
    runnerMode: "fake",
    model: null,
    reasoningEffort: null,
    command: "fake-role-worker",
    exitCode: null,
    error: null,
    startedAt: now,
    finishedAt: null,
    createdAt: now,
  };
  const bundle = {
    run: {
      id: runId,
      projectId: randomUUID(),
      title: "Chat task",
      objective: "Exercise the fixed role chain",
      status: "active" as const,
      changeContract: { summary: "fixed" },
      createdAt: now,
      updatedAt: now,
    },
    project: {},
    phases,
    definition: {
      version: 1,
      project: { name: "fixture", summary: "fixture", locale: "zh-CN" },
      roles: [],
      phases: definitions.map((definition) => ({ ...definition, gate: "fixed gate" })),
    },
    productBaseline: null,
    designBaseline: null,
    architectureBaseline: null,
  };
  const workflow = {
    getRun: async () => bundle,
    executePhase: async (_runId: string, phaseId: PhaseId, input: { selectedArtifactIds: string[] }) => {
      if (executionFailure) {
        throw new AppError(executionFailure.message, 503, "ROLE_WORKER_UNAVAILABLE");
      }
      executions.push({ phaseId, selectedArtifactIds: input.selectedArtifactIds });
      return { ...execution, selectedArtifactIds: input.selectedArtifactIds };
    },
  } as unknown as Pick<WorkflowService, "getRun" | "executePhase">;
  return {
    runId,
    artifactKeyById,
    executions,
    coordinator: new AgentSdlcCoordinator(workflow),
  };
}

function artifact(runId: string, position: number, artifactKey: string, approved: boolean): ArtifactDto {
  return {
    id: randomUUID(),
    phaseRunId: `${runId}:${position}`,
    artifactKey,
    filePath: `docs/${artifactKey}.md`,
    contentHash: "a".repeat(64),
    reviewStatus: approved ? "approved" : "pending",
    revision: 1,
    revisionSource: "ai",
    parentArtifactId: null,
    createdAt: now,
  };
}
