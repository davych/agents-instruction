import assert from "node:assert/strict";
import test from "node:test";

import { api, ApiError } from "../src/lib/api.ts";

const session = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "优化交付流程",
  status: "active",
  turnState: "idle",
  currentProviderId: "openai",
  lastMessageSequence: 1,
  lastEventSequence: 2,
  repositories: [],
  sandbox: null,
  createdAt: "2026-08-29T08:00:00.000Z",
  updatedAt: "2026-08-29T08:01:00.000Z",
};

const association = {
  sessionId: session.id,
  triggerMessageId: "22222222-2222-4222-8222-222222222222",
  workflowRunId: "33333333-3333-4333-8333-333333333333",
  providerId: "openai",
  createdAt: "2026-08-29T08:01:00.000Z",
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("Agent Session detail preserves persisted Run associations and accepts legacy omission", async (t) => {
  const originalFetch = globalThis.fetch;
  let payload: unknown = { session };
  globalThis.fetch = (async () => jsonResponse(payload)) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual((await api.getAgentSession(session.id)).runs, []);

  payload = {
    session,
    messages: [],
    events: [],
    toolCalls: [],
    humanGates: [],
    runs: [association],
  };
  const detail = await api.getAgentSession(session.id);
  assert.deepEqual(detail.runs, [association]);

  payload = {
    session,
    runs: [{ ...association, sessionId: "99999999-9999-4999-8999-999999999999" }],
  };
  await assert.rejects(
    api.getAgentSession(session.id),
    (error: unknown) => error instanceof ApiError && error.code === "INVALID_API_RESPONSE",
  );
});

test("Run detail requires and preserves the server-authoritative Agent Session origin", async (t) => {
  const originalFetch = globalThis.fetch;
  const runDetail = {
    run: {
      id: association.workflowRunId,
      projectId: "44444444-4444-4444-8444-444444444444",
      title: "对话式交付",
    },
    project: {
      id: "44444444-4444-4444-8444-444444444444",
      name: "示例项目",
      summary: "",
      sourceKind: "legacy-local",
      rootPath: "/workspace/example",
      runCount: 1,
      availableActions: { ask: true, createRun: true, sync: false },
      repository: null,
      knowledge: null,
      createdAt: "2026-08-29T08:00:00.000Z",
      updatedAt: "2026-08-29T08:00:00.000Z",
    },
    definition: { roles: [], phases: [] },
    phases: [],
    agentSession: { sessionId: session.id },
  };
  let payload: unknown = runDetail;
  globalThis.fetch = (async () => jsonResponse(payload)) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual((await api.getRun(association.workflowRunId)).agentSession, {
    sessionId: session.id,
  });

  payload = { ...runDetail, agentSession: null };
  assert.equal((await api.getRun(association.workflowRunId)).agentSession, null);

  payload = { ...runDetail };
  delete (payload as { agentSession?: unknown }).agentSession;
  await assert.rejects(
    api.getRun(association.workflowRunId),
    (error: unknown) => error instanceof ApiError && error.code === "INVALID_API_RESPONSE",
  );

  payload = { ...runDetail, agentSession: { sessionId: 42 } };
  await assert.rejects(
    api.getRun(association.workflowRunId),
    (error: unknown) => error instanceof ApiError && error.code === "INVALID_API_RESPONSE",
  );
});

test("advanceAgentRun posts the optimistic phase and Provider and parses a direct result", async (t) => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  let payload: unknown = {
    state: "started",
    runId: association.workflowRunId,
    phaseId: "discovery",
    roleId: "pm-ba",
    selectedArtifactIds: [],
  };
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return jsonResponse(payload);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await api.advanceAgentRun(
    "session/with slash",
    "run with space",
    { expectedPhaseId: "discovery", providerId: "ollama" },
  );
  assert.equal(result.state, "started");
  assert.match(requestUrl, /\/api\/agent-sessions\/session%2Fwith%20slash\/runs\/run%20with%20space\/advance$/u);
  assert.equal(requestInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    expectedPhaseId: "discovery",
    providerId: "ollama",
  });

  payload = {
    state: "awaiting_review",
    runId: association.workflowRunId,
    phaseId: "discovery",
    roleId: "pm-ba",
    artifactKeys: ["change-contract"],
    reason: "等待人工审阅。",
  };
  assert.equal((await api.advanceAgentRun(
    session.id,
    association.workflowRunId,
    { expectedPhaseId: "discovery", providerId: "openai" },
  )).state, "awaiting_review");

  payload = {
    state: "failed",
    runId: association.workflowRunId,
    phaseId: "design",
    roleId: "designer",
    artifactKeys: ["design-spec"],
    reason: "当前 Provider 不支持此阶段所需能力。",
  };
  const failed = await api.advanceAgentRun(
    session.id,
    association.workflowRunId,
    { expectedPhaseId: "design", providerId: "openai" },
  );
  assert.equal(failed.state, "failed");
  if (failed.state === "failed") {
    assert.equal(failed.reason, "当前 Provider 不支持此阶段所需能力。");
  }

  payload = { result: {
    state: "completed",
    runId: association.workflowRunId,
    artifactKeys: [],
    reason: "done",
  } };
  await assert.rejects(
    api.advanceAgentRun(
      session.id,
      association.workflowRunId,
      { expectedPhaseId: "release", providerId: "openai" },
    ),
    (error: unknown) => error instanceof ApiError && error.code === "INVALID_API_RESPONSE",
  );

  payload = {
    state: "blocked",
    runId: association.workflowRunId,
    phaseId: "discovery",
    roleId: "pm-ba",
    artifactKeys: [],
    reason: "需要继续确认。",
    hiddenState: true,
  };
  await assert.rejects(
    api.advanceAgentRun(
      session.id,
      association.workflowRunId,
      { expectedPhaseId: "discovery", providerId: "openai" },
    ),
    (error: unknown) => error instanceof ApiError && error.code === "INVALID_API_RESPONSE",
  );
});

test("getHumanDecisions validates the runtime response before the Session renders it", async (t) => {
  const originalFetch = globalThis.fetch;
  let payload: unknown = {
    totalBlocking: 1,
    totalDecisions: 1,
    totalRoleWork: 0,
    inconsistentPhaseIds: [],
    phases: [{
      phaseId: "architecture",
      roleId: "architect",
      state: "awaiting_decision",
      items: [{
        id: "ARCH-OPTION",
        phaseId: "architecture",
        actionPhaseId: "architecture",
        artifactKey: "architecture-options",
        kind: "decision",
        title: "选择架构方案",
        prompt: "请选择一个当前 Option。",
        owner: "human",
        nextAction: "记录选型后继续 Architect。",
        blocking: true,
        response: null,
      }],
      blockingCount: 1,
      decisionCount: 1,
      workCount: 0,
      dependencyCount: 0,
      inconsistentApproval: false,
    }],
  };
  globalThis.fetch = (async () => jsonResponse(payload)) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  assert.equal((await api.getHumanDecisions(association.workflowRunId)).totalBlocking, 1);

  payload = {
    totalBlocking: -1,
    totalDecisions: 0,
    totalRoleWork: 0,
    inconsistentPhaseIds: [],
    phases: [],
  };
  await assert.rejects(
    api.getHumanDecisions(association.workflowRunId),
    (error: unknown) => error instanceof ApiError && error.code === "INVALID_API_RESPONSE",
  );

  payload = {
    totalBlocking: 0,
    totalDecisions: 0,
    totalRoleWork: 0,
    inconsistentPhaseIds: [],
    phases: [],
    hiddenDecision: true,
  };
  await assert.rejects(
    api.getHumanDecisions(association.workflowRunId),
    (error: unknown) => error instanceof ApiError && error.code === "INVALID_API_RESPONSE",
  );
});
