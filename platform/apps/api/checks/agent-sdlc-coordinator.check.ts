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
import {
  AGENT_WORK_BOUNDARY_MESSAGE,
  agentPlatformHelp,
  agentTurnFailureSummary,
} from "../src/services/agent/agent-session-service.ts";
import {
  ConversationPlanner,
  isClearlyReadOnlyQuestion,
} from "../src/services/agent/conversation-planner.ts";
import { AppError } from "../src/domain/errors.ts";
import type { AskProviderRegistry } from "../src/services/llm/provider-registry.ts";
import {
  AskProviderError,
  type AskLlmCompleteRequest,
} from "../src/services/llm/types.ts";
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
  const captured: AskLlmCompleteRequest[] = [];
  const providers = {
    complete: async (_providerId: string, request: AskLlmCompleteRequest) => {
      captured.push(request);
      return {
        text: JSON.stringify(captured.length === 1
          ? { intent: "work", involveRoles: [] }
          : {
              title: "修复问题",
              workType: "bug",
              clarification: null,
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
  assert.equal(captured.length, 2);
  assert.match(captured[0]?.systemPrompt ?? "", /六个角色始终全部运行/u);
  assert.match(captured[0]?.systemPrompt ?? "", /只是.*关注.*标签/u);
  assert.match(captured[1]?.systemPrompt ?? "", /任务元数据整理器/u);
});

test("CHAT-SDLC-07: chat copy does not promise unimplemented external-write gates", () => {
  assert.match(AGENT_WORK_BOUNDARY_MESSAGE, /当前 MVP 不开放 DDL、Secret、外部写入/u);
  assert.match(AGENT_WORK_BOUNDARY_MESSAGE, /真正的人工门禁是每个阶段的 Artifact 审阅/u);
  assert.doesNotMatch(AGENT_WORK_BOUNDARY_MESSAGE, /外部写入会在这里暂停/u);
});

test("CHAT-SDLC-08: chat routing is light and work contracts preserve the user's objective", async () => {
  const chatProviders = {
    complete: async () => ({
      text: '{"intent":"chat","involveRoles":[]}',
      model: "openai/gpt-oss-20b",
      usage: { inputTokens: 10, outputTokens: 10 },
    }),
  } as unknown as AskProviderRegistry;
  const chat = await new ConversationPlanner(chatProviders).plan({
    providerId: "lmstudio",
    content: "hi 你能做什么",
    repoAlias: "repo",
  });
  assert.equal(chat.intent, "chat");
  assert.match(chat.reason, /普通咨询/u);

  let workCall = 0;
  const invalidWorkProviders = {
    complete: async () => {
      workCall += 1;
      return {
        text: JSON.stringify(workCall === 1
          ? { intent: "work", involveRoles: [] }
          : {
              title: "",
              workType: "bug",
              clarification: null,
            }),
        model: "planner-model",
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  } as unknown as AskProviderRegistry;
  await assert.rejects(
    () => new ConversationPlanner(invalidWorkProviders).plan({
      providerId: "lmstudio",
      content: "修复问题",
      repoAlias: "repo",
    }),
    (error: unknown) => error instanceof AppError && error.code === "AGENT_PLAN_INVALID",
  );
});

test("CHAT-SDLC-09: turn failures preserve safe stage-specific reasons", () => {
  assert.equal(
    agentTurnFailureSummary(new AppError(
      "模型没有返回可验证的会话计划，本轮没有启动沙盒或 SDLC",
      502,
      "AGENT_PLAN_INVALID",
    )),
    "模型没有返回可验证的会话计划，本轮没有启动沙盒或 SDLC",
  );
  const timeout = agentTurnFailureSummary(new AskProviderError(
    "lmstudio",
    "ASK_PROVIDER_TIMEOUT",
    "模型服务响应超时，请检查服务状态或稍后重试",
    "unreachable",
    504,
    true,
  ));
  assert.match(timeout, /Provider 阶段失败/u);
  assert.match(timeout, /响应超时/u);
  assert.doesNotMatch(timeout, /检查 Provider、仓库和 Sandbox/u);
  assert.equal(
    agentTurnFailureSummary(new AppError(
      "database password=should-not-be-public",
      500,
      "INTERNAL_DATABASE_FAILURE",
    )),
    "本轮因未识别的服务端错误而中止；没有继续启动 Sandbox 或 SDLC。",
  );
  assert.equal(
    agentTurnFailureSummary(new AppError(
      "ASK internals password=should-not-be-public",
      500,
      "ASK_INTERNAL_DATABASE_FAILURE",
    )),
    "本轮因未识别的服务端错误而中止；没有继续启动 Sandbox 或 SDLC。",
  );
});

test("CHAT-SDLC-10: greetings get platform help but real work still reaches the planner", () => {
  const help = agentPlatformHelp("hi 你能做什么", "repo");
  assert.match(help ?? "", /Cloud SDLC Agent/u);
  assert.match(help ?? "", /不需要逐个角色开聊天/u);
  assert.match(help ?? "", /PM \/ BA.*Designer.*Architect.*Software Engineer.*Tester.*DevOps/u);
  assert.equal(
    agentPlatformHelp("请实现一个帮助中心功能", "repo"),
    null,
  );
});

test("CHAT-SDLC-11: a model cannot upgrade an obvious read-only question into a Run", async () => {
  let calls = 0;
  const providers = {
    complete: async () => {
      calls += 1;
      return {
        text: JSON.stringify({ intent: "work", involveRoles: [] }),
        model: "over-eager-router",
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  } as unknown as AskProviderRegistry;
  const plan = await new ConversationPlanner(providers).plan({
    providerId: "lmstudio",
    content: "这个仓库是做什么的？请根据 README 回答。",
    repoAlias: "repo",
  });
  assert.equal(plan.intent, "chat");
  assert.equal(calls, 1, "read-only questions must not request work metadata");
  assert.equal(isClearlyReadOnlyQuestion("请修复登录按钮，完成后告诉我结果？"), false);
  assert.equal(isClearlyReadOnlyQuestion("如何修复登录按钮？"), true);
  assert.equal(isClearlyReadOnlyQuestion("可以帮我修复登录按钮吗？"), false);
  assert.equal(isClearlyReadOnlyQuestion("How do I fix the login button?"), true);
  assert.equal(isClearlyReadOnlyQuestion("Could you fix the login button?"), false);
  assert.equal(isClearlyReadOnlyQuestion("Why would you change this?"), true);
  assert.equal(isClearlyReadOnlyQuestion("Why can you fix this?"), true);
  assert.equal(isClearlyReadOnlyQuestion("为什么你可以帮我修复这个问题？"), true);
  assert.equal(isClearlyReadOnlyQuestion("如果用户说‘请修复登录按钮’，系统会怎么处理？"), true);
  assert.equal(isClearlyReadOnlyQuestion("当我输入“可以帮我修复登录吗”时，会启动 Run 吗？"), true);
  assert.equal(isClearlyReadOnlyQuestion("Does the phrase 'please fix login' start a Run?"), true);
  assert.equal(isClearlyReadOnlyQuestion("@repo 可以帮我修复登录按钮吗？"), false);
  assert.equal(isClearlyReadOnlyQuestion("@repo Could you fix the login button?"), false);
});

test("CHAT-SDLC-12: a title-only MCP work item still creates a valid task contract", async () => {
  let calls = 0;
  const providers = {
    complete: async () => ({
      text: JSON.stringify(++calls === 1
        ? { intent: "work", involveRoles: [] }
        : { title: "处理登录故障", workType: "bug", clarification: null }),
      model: "planner-model",
      usage: { inputTokens: 10, outputTokens: 10 },
    }),
  } as unknown as AskProviderRegistry;
  const plan = await new ConversationPlanner(providers).plan({
    providerId: "lmstudio",
    content: "读取 Jira OPS-42 并开始处理",
    repoAlias: "repo",
    workItem: {
      source: {
        kind: "mcp",
        adapterId: "jira",
        adapterLabel: "Jira",
        reference: "OPS-42",
        externalId: "OPS-42",
        url: null,
        fetchedAt: now,
        fingerprint: "a".repeat(64),
      },
      title: "登录按钮无响应",
      description: "",
      suggestedWorkType: "bug",
      acceptanceCriteria: [],
      labels: [],
    },
  });

  assert.equal(plan.intent, "work");
  if (plan.intent !== "work") return;
  assert.equal(plan.task.summary, "登录按钮无响应");
  assert.match(plan.task.acceptanceCriteria[0]!, /登录按钮无响应/u);
});

test("CHAT-SDLC-13: LM Studio planning bounds the full long-session payload", async () => {
  const captured: AskLlmCompleteRequest[] = [];
  const providers = {
    complete: async (_providerId: string, request: AskLlmCompleteRequest) => {
      captured.push(request);
      return {
        text: JSON.stringify(captured.length === 1
          ? { intent: "work", involveRoles: ["tester"] }
          : { title: "修复长会话问题", workType: "bug", clarification: null }),
        model: "planner-model",
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  } as unknown as AskProviderRegistry;
  const escapeHeavy = "\\\"\u0001\n".repeat(3_000);
  await new ConversationPlanner(providers).plan({
    providerId: "lmstudio",
    content: `请修复长会话问题 ${escapeHeavy}`,
    repoAlias: "repo",
    recentMessages: Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: escapeHeavy,
    })),
    readOnlyRepositories: Array.from({ length: 4 }, (_, index) => ({
      repoAlias: `shared-${index}`,
      sourceRevision: "b".repeat(40),
      manifestHash: "c".repeat(64),
      summary: escapeHeavy,
    })),
    workItem: {
      source: {
        kind: "mcp",
        adapterId: "jira",
        adapterLabel: "Jira",
        reference: "OPS-99",
        externalId: "OPS-99",
        url: null,
        fetchedAt: now,
        fingerprint: "d".repeat(64),
      },
      title: "长会话问题",
      description: escapeHeavy,
      suggestedWorkType: "bug",
      acceptanceCriteria: [escapeHeavy],
      labels: [],
    },
  });

  assert.equal(captured.length, 2);
  for (const request of captured) {
    assert.ok(request.messages[0]!.content.length <= 10_000);
    assert.doesNotThrow(() => JSON.parse(request.messages[0]!.content));
  }
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
