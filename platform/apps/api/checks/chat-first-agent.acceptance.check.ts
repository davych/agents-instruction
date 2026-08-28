import assert from "node:assert/strict";
import test from "node:test";

import {
  agentEventSchema,
  agentHumanGateSchema,
  agentMessageSchema,
  agentSessionSchema,
  agentToolCallSchema,
  deepWikiGenerationSchema,
  mcpActivationSchema,
  mcpInstallationSummarySchema,
  projectAgentSettingsSchema,
  publicProjectSchema,
  sandboxBlueprintSummarySchema,
  type BindRemoteRepositoryInput,
  type CreateAgentSessionInput,
  type GenerateDeepWikiInput,
  type SendAgentMessageInput,
  type UpdateProjectAgentSettingsInput,
} from "@ai-sdlc/contracts";

import { buildApp } from "../src/app.ts";

/**
 * HTTP acceptance checks derived only from the public contracts and
 * docs/chat-first-cloud-agent-spec.md. Business ports are injected so these
 * checks exercise the real Fastify routing/validation/presentation layer
 * without depending on private SQL or a networked Git/LLM/MCP service.
 */

const projectId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const sandboxId = "33333333-3333-4333-8333-333333333333";
const userMessageId = "44444444-4444-4444-8444-444444444444";
const assistantMessageId = "55555555-5555-4555-8555-555555555555";
const eventId = "66666666-6666-4666-8666-666666666666";
const toolCallId = "77777777-7777-4777-8777-777777777777";
const gateId = "88888888-8888-4888-8888-888888888888";
const generationId = "99999999-9999-4999-8999-999999999999";
const clientMessageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const revision = "a".repeat(40);
const now = "2026-08-28T10:00:00.000Z";

const blueprint = {
  id: "node-approved",
  label: "Node.js approved sandbox",
  version: "2026.08.28-1",
  description: "受限的 Node.js 工作环境",
  capabilities: {
    persistentWorkspace: true,
    testExecution: true,
    servicePorts: false,
    restrictedNetwork: true,
  },
  configured: true,
  installHint: null,
};

const settings = {
  projectId,
  repoAlias: "backend",
  defaultProviderId: "openai",
  sandboxBlueprintId: blueprint.id,
  sandboxBlueprintVersion: blueprint.version,
  enabledMcpServerIds: ["linear-readonly"],
  version: 1,
  createdAt: now,
  updatedAt: now,
};

const installation = {
  id: "linear-readonly",
  label: "Linear",
  description: "读取已授权的 Linear 工作项",
  kind: "mcp-http",
  installed: true,
  authorization: "ready",
  permissionClasses: ["read"],
  installHint: null,
};

const activation = {
  projectId,
  mcpServerId: installation.id,
  enabled: true,
  permissionClasses: ["read"],
  updatedAt: now,
};

const sandbox = {
  id: sandboxId,
  sessionId,
  projectId,
  sourceRevision: revision,
  blueprintId: blueprint.id,
  blueprintVersion: blueprint.version,
  state: "ready",
  expiresAt: null,
  createdAt: now,
  updatedAt: now,
};

const session = {
  id: sessionId,
  title: "Backend Agent Session",
  status: "active",
  turnState: "idle",
  currentProviderId: "ollama",
  lastMessageSequence: 2,
  lastEventSequence: 8,
  repositories: [{
    sessionId,
    projectId,
    repoAlias: "backend",
    accessMode: "write",
    sourceRevision: revision,
    createdAt: now,
  }],
  sandbox,
  createdAt: now,
  updatedAt: now,
};

const messages = [
  {
    id: userMessageId,
    sessionId,
    sequence: 1,
    role: "user",
    status: "completed",
    content: "@backend 处理 Linear ENG-123，修好并跑测试",
    providerId: "ollama",
    model: null,
    clientMessageId,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: assistantMessageId,
    sessionId,
    sequence: 2,
    role: "assistant",
    status: "completed",
    content: "我会在隔离沙盒中处理，并在需要外部写入时询问你。",
    providerId: "ollama",
    model: "qwen-example",
    clientMessageId: null,
    createdAt: now,
    updatedAt: now,
  },
];

const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const phaseIds = [
  "discovery",
  "design",
  "architecture",
  "implementation",
  "verification",
  "release",
] as const;
const events = [
  {
    id: eventId,
    sessionId,
    sequence: 1,
    kind: "sandbox.ready",
    status: "completed",
    summary: "@backend 沙盒已按批准的蓝图启动。",
    messageId: assistantMessageId,
    toolCallId: null,
    projectId,
    workflowRunId: null,
    phaseId: null,
    createdAt: now,
  },
  {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    sessionId,
    sequence: 2,
    kind: "sdlc.run-created",
    status: "completed",
    summary: "Agent 已从清晰请求整理 Change Contract，并创建后台 Run。",
    messageId: assistantMessageId,
    toolCallId: null,
    projectId,
    workflowRunId: runId,
    phaseId: null,
    createdAt: now,
  },
  ...phaseIds.map((phaseId, index) => ({
    id: `${index + 1}eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`,
    sessionId,
    sequence: index + 3,
    kind: "sdlc.phase-completed",
    status: "completed",
    summary: `${phaseId} 角色产物已固定，可在高级审计打开。`,
    messageId: assistantMessageId,
    toolCallId: null,
    projectId,
    workflowRunId: runId,
    phaseId,
    createdAt: now,
  })),
];

const toolCalls = [{
  id: toolCallId,
  sessionId,
  messageId: assistantMessageId,
  mcpServerId: "linear-readonly",
  toolName: "get_issue",
  permissionClass: "read",
  approval: "not-required",
  status: "completed",
  argumentsSha256: "b".repeat(64),
  outputSha256: "c".repeat(64),
  summary: "读取了 ENG-123。",
  errorMessage: null,
  startedAt: now,
  finishedAt: now,
  createdAt: now,
}];

const humanGates = [{
  id: gateId,
  sessionId,
  messageId: assistantMessageId,
  category: "external_write",
  status: "pending",
  question: "是否允许向 Linear 写回处理结果？",
  choices: [{
    id: "allow-once",
    label: "仅允许这一次",
    description: "只批准当前明确的 Linear 写入。",
    recommended: true,
  }],
  selectedChoiceId: null,
  responseComment: null,
  createdAt: now,
  resolvedAt: null,
}];

const generation = {
  id: generationId,
  projectId,
  revision,
  providerId: "openai",
  model: "gpt-example",
  promptVersion: "deepwiki-v1",
  status: "ready",
  manifestHash: "d".repeat(64),
  content: "# 系统概览\n\nAPI 从 `src/server.ts` 启动。",
  citations: [{
    path: "src/server.ts",
    startLine: 1,
    endLine: 12,
    sha256: "e".repeat(64),
    summary: "服务端入口",
  }],
  usage: { inputTokens: 123, outputTokens: 45 },
  errorMessage: null,
  generatedAt: now,
  staleAt: null,
  createdAt: now,
  updatedAt: now,
};

const project = {
  id: projectId,
  name: "backend",
  summary: "由远端仓库自动推断",
  sourceKind: "remote-git",
  repository: {
    url: "https://git.example.test/team/backend.git",
    host: "git.example.test",
    requestedRef: "HEAD",
    credentialProfile: null,
    activeSnapshot: { revision, resolvedRef: "refs/heads/main", indexedAt: now },
    operation: null,
  },
  knowledge: null,
  availableActions: { ask: true, createRun: true, sync: true },
  runCount: 0,
  createdAt: now,
  updatedAt: now,
};

interface AcceptanceCalls {
  bindings: BindRemoteRepositoryInput[];
  createSessions: CreateAgentSessionInput[];
  sendMessages: Array<{ sessionId: string; input: SendAgentMessageInput }>;
  updateSettings: Array<{ projectId: string; input: UpdateProjectAgentSettingsInput }>;
  activations: Array<{ projectId: string; serverId: string; enabled: boolean }>;
  deepWiki: Array<{ projectId: string; input: GenerateDeepWikiInput }>;
}

async function acceptanceApp() {
  const calls: AcceptanceCalls = {
    bindings: [],
    createSessions: [],
    sendMessages: [],
    updateSettings: [],
    activations: [],
    deepWiki: [],
  };
  const detail = { session, messages, events, toolCalls, humanGates };
  const marker = "SECRET_PATH_IMAGE_COMMAND_MARKER /srv/private image=private/worker command=evil";
  const app = await buildApp({
    pool: {
      query: async () => {
        throw new Error("injected Chat-first routes must not guess private SQL");
      },
    },
    fakeCodex: true,
    repositoryBindings: {
      bind: async (input: BindRemoteRepositoryInput) => {
        calls.bindings.push(input);
        return { project, session: { ...session, sandbox: null, lastMessageSequence: 0 } };
      },
    },
    agentSessions: {
      list: async () => [session],
      get: async () => detail,
      create: async (input: CreateAgentSessionInput) => {
        calls.createSessions.push(input);
        return { ...session, currentProviderId: input.providerId ?? session.currentProviderId };
      },
      sendMessage: async (requestedSessionId: string, input: SendAgentMessageInput) => {
        calls.sendMessages.push({ sessionId: requestedSessionId, input });
        if (input.content === "trigger-safe-error") throw new Error(marker);
        return detail;
      },
    },
    projectAgentSettings: {
      get: async () => settings,
      update: async (requestedProjectId: string, input: UpdateProjectAgentSettingsInput) => {
        calls.updateSettings.push({ projectId: requestedProjectId, input });
        const { expectedVersion, ...patch } = input;
        return { ...settings, ...patch, version: expectedVersion + 1 };
      },
    },
    sandboxBlueprints: { list: async () => [blueprint] },
    mcpCatalog: {
      list: async () => [installation],
      activate: async (requestedProjectId: string, serverId: string, enabled: boolean) => {
        calls.activations.push({ projectId: requestedProjectId, serverId, enabled });
        return { ...activation, projectId: requestedProjectId, mcpServerId: serverId, enabled };
      },
    },
    deepWikiGenerations: {
      getLatest: async () => generation,
      generate: async (requestedProjectId: string, input: GenerateDeepWikiInput) => {
        calls.deepWiki.push({ projectId: requestedProjectId, input });
        return generation;
      },
    },
  } as never);
  return { app, calls, marker };
}

function jsonRecord(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as unknown;
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function assertNoPrivateRuntimeData(body: string, marker?: string): void {
  assert.doesNotMatch(body, /\/srv\/private|private\/worker|command=evil|docker\.sock/u);
  assert.doesNotMatch(body, /(?:apiKey|secretEnv|rootPath|hostPath|image|command)"\s*:/u);
  if (marker) assert.equal(body.includes(marker), false);
}

test("CHAT-AC-01/02/03/15/18: binding is one strict action, returns a ready Chat Session, and never auto-generates DeepWiki", async () => {
  const { app, calls } = await acceptanceApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/repository-bindings",
      payload: {
        repositoryUrl: "https://git.example.test/team/backend.git",
        credentialProfileId: null,
      },
    });
    assert.equal(response.statusCode, 201);
    const body = jsonRecord(response.body);
    assert.equal(publicProjectSchema.safeParse(body.project).success, true);
    assert.equal(agentSessionSchema.safeParse(body.session).success, true);
    assert.equal(calls.bindings.length, 1);
    assert.equal(calls.deepWiki.length, 0, "binding cannot spend LLM quota on DeepWiki");
    assert.equal((body.project as typeof project).knowledge, null);
    assert.equal((body.session as typeof session).sandbox, null, "binding does not eagerly start a Sandbox");
    assertNoPrivateRuntimeData(response.body);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/repository-bindings",
      payload: {
        repositoryUrl: "https://git.example.test/team/backend.git",
        name: "browser-owned",
        token: "must-not-reach-service",
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(calls.bindings.length, 1);
    assertNoPrivateRuntimeData(invalid.body);
  } finally {
    await app.close();
  }
});

test("CHAT-AC-03/04/06/09/10: Session HTTP surface restores context and accepts only ordered idempotent messages with a next-turn Provider", async () => {
  const { app, calls } = await acceptanceApp();
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { primaryProjectId: projectId, providerId: "openai" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(agentSessionSchema.safeParse(jsonRecord(created.body).session).success, true);

    const listed = await app.inject({ method: "GET", url: "/api/agent-sessions" });
    assert.equal(listed.statusCode, 200);
    const listedSessions = jsonRecord(listed.body).sessions;
    assert.ok(Array.isArray(listedSessions));
    assert.equal(listedSessions.every((item) => agentSessionSchema.safeParse(item).success), true);

    const restored = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` });
    assert.equal(restored.statusCode, 200);
    const restoredBody = jsonRecord(restored.body);
    assert.equal(agentSessionSchema.safeParse(restoredBody.session).success, true);
    assert.equal((restoredBody.messages as unknown[]).every((item) => agentMessageSchema.safeParse(item).success), true);
    assert.equal((restoredBody.events as unknown[]).every((item) => agentEventSchema.safeParse(item).success), true);
    assert.equal((restoredBody.toolCalls as unknown[]).every((item) => agentToolCallSchema.safeParse(item).success), true);
    assert.equal((restoredBody.humanGates as unknown[]).every((item) => agentHumanGateSchema.safeParse(item).success), true);
    assert.deepEqual(
      (restoredBody.events as typeof events)
        .filter(({ kind }) => kind === "sdlc.phase-completed")
        .map(({ phaseId }) => phaseId),
      phaseIds,
      "CHAT-AC-11/12: a clear task creates one background Run and preserves all six phases in order",
    );

    const sent = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/messages`,
      payload: {
        clientMessageId,
        expectedSequence: 0,
        content: "@backend 处理 Linear ENG-123，修好并跑测试",
        providerId: "ollama",
      },
    });
    assert.equal(sent.statusCode, 202);
    assert.deepEqual(calls.sendMessages.at(-1), {
      sessionId,
      input: {
        clientMessageId,
        expectedSequence: 0,
        content: "@backend 处理 Linear ENG-123，修好并跑测试",
        providerId: "ollama",
      },
    });
    assert.equal(jsonRecord(sent.body).session !== undefined, true);
    assertNoPrivateRuntimeData(sent.body);

    for (const forbidden of [
      { projectId },
      { writableProjectIds: [projectId] },
      { repositoryPath: "/srv/private/repository" },
      { apiKey: "secret" },
      { endpoint: "https://attacker.invalid/v1" },
      { tools: [{ name: "shell" }] },
      { image: "private/worker:latest" },
      { command: "sh -c evil" },
      { maxToolRounds: 999 },
      { autoPush: true },
    ]) {
      const before = calls.sendMessages.length;
      const response = await app.inject({
        method: "POST",
        url: `/api/agent-sessions/${sessionId}/messages`,
        payload: {
          clientMessageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          expectedSequence: 2,
          content: "@backend 继续",
          ...forbidden,
        },
      });
      assert.equal(response.statusCode, 400, JSON.stringify(forbidden));
      assert.equal(calls.sendMessages.length, before, "invalid input must not reach the Agent");
      assertNoPrivateRuntimeData(response.body);
    }
  } finally {
    await app.close();
  }
});

test("CHAT-AC-05/07/08/13/19: settings, approved Blueprints, and MCP activation expose references only", async () => {
  const { app, calls } = await acceptanceApp();
  try {
    const gotSettings = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/agent-settings`,
    });
    assert.equal(gotSettings.statusCode, 200);
    assert.equal(projectAgentSettingsSchema.safeParse(jsonRecord(gotSettings.body).settings).success, true);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/agent-settings`,
      payload: { expectedVersion: 1, defaultProviderId: "ollama" },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(projectAgentSettingsSchema.safeParse(jsonRecord(updated.body).settings).success, true);
    assert.equal(calls.updateSettings.length, 1);

    const blueprints = await app.inject({ method: "GET", url: "/api/sandbox-blueprints" });
    assert.equal(blueprints.statusCode, 200);
    const blueprintItems = jsonRecord(blueprints.body).blueprints as unknown[];
    assert.equal(blueprintItems.every((item) => sandboxBlueprintSummarySchema.safeParse(item).success), true);

    const installations = await app.inject({ method: "GET", url: "/api/mcp/installations" });
    assert.equal(installations.statusCode, 200);
    const installationItems = jsonRecord(installations.body).installations as unknown[];
    assert.equal(installationItems.every((item) => mcpInstallationSummarySchema.safeParse(item).success), true);

    const activated = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/mcp-activations/${installation.id}`,
      payload: { enabled: true },
    });
    assert.equal(activated.statusCode, 200);
    assert.equal(mcpActivationSchema.safeParse(jsonRecord(activated.body).activation).success, true);
    assert.deepEqual(calls.activations.at(-1), {
      projectId,
      serverId: installation.id,
      enabled: true,
    });

    for (const payload of [
      { expectedVersion: 1, image: "private/worker:latest" },
      { expectedVersion: 1, command: "sh -c evil" },
      { expectedVersion: 1, hostPath: "/srv/private" },
      { expectedVersion: 1, apiKey: "secret" },
    ]) {
      const before = calls.updateSettings.length;
      const response = await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}/agent-settings`,
        payload,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(calls.updateSettings.length, before);
      assertNoPrivateRuntimeData(response.body);
    }

    const elevated = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/mcp-activations/${installation.id}`,
      payload: { enabled: true, permissionClasses: ["release"], secret: "marker" },
    });
    assert.equal(elevated.statusCode, 400);
    assert.equal(calls.activations.length, 1);

    for (const response of [gotSettings, updated, blueprints, installations, activated]) {
      assertNoPrivateRuntimeData(response.body);
    }
  } finally {
    await app.close();
  }
});

test("CHAT-AC-15/16: DeepWiki is manually generated for one revision and Provider and old generations remain visibly stale", async () => {
  const { app, calls } = await acceptanceApp();
  try {
    const latest = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/deepwiki/generations/latest`,
    });
    assert.equal(latest.statusCode, 200);
    assert.equal(deepWikiGenerationSchema.safeParse(jsonRecord(latest.body).generation).success, true);

    const started = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/deepwiki/generations`,
      payload: { expectedRevision: revision, providerId: "openai", clientRequestId: clientMessageId },
    });
    assert.equal(started.statusCode, 202);
    assert.equal(deepWikiGenerationSchema.safeParse(jsonRecord(started.body).generation).success, true);
    assert.deepEqual(calls.deepWiki.at(-1), {
      projectId,
      input: { expectedRevision: revision, providerId: "openai", clientRequestId: clientMessageId },
    });
    assertNoPrivateRuntimeData(started.body);

    for (const payload of [
      { providerId: "openai" },
      { expectedRevision: revision, providerId: "openai", prompt: "browser prompt" },
      { expectedRevision: revision, providerId: "openai", apiKey: "secret" },
      { expectedRevision: revision, providerId: "openai", repositoryPath: "/srv/private" },
    ]) {
      const before = calls.deepWiki.length;
      const response = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/deepwiki/generations`,
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal(calls.deepWiki.length, before);
      assertNoPrivateRuntimeData(response.body);
    }
  } finally {
    await app.close();
  }
});

test("CHAT-AC-08/09/13/20: Agent route errors are fail-closed and never echo private runtime details or imply automatic delivery", async () => {
  const { app, marker } = await acceptanceApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/messages`,
      payload: {
        clientMessageId,
        expectedSequence: 0,
        content: "trigger-safe-error",
        providerId: "openai",
      },
    });
    assert.ok(response.statusCode >= 400);
    assert.notEqual(response.statusCode, 404, "the Agent message route must exist before its safe-error policy can pass");
    assertNoPrivateRuntimeData(response.body, marker);
    assert.doesNotMatch(response.body, /auto(?:Push|Merge|Deploy|Release)|自动(?:推送|合并|部署|发布)/u);
  } finally {
    await app.close();
  }
});
