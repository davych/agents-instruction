import assert from "node:assert/strict";
import test from "node:test";

import * as publicContracts from "../src/index.ts";

/**
 * Black-box contract checks derived only from
 * docs/chat-first-cloud-agent-spec.md (CHAT-AC-01..20).
 *
 * Deliberately resolve newly-added schemas by their public export name so a
 * missing contract is reported as an acceptance failure instead of coupling
 * these checks to an implementation module.
 */

interface PublicSchema {
  safeParse(value: unknown): { success: boolean };
}

function schema(name: string): PublicSchema {
  const candidate = (publicContracts as Record<string, unknown>)[name];
  assert.ok(candidate && typeof candidate === "object", `${name} must be publicly exported`);
  assert.equal(
    typeof (candidate as { safeParse?: unknown }).safeParse,
    "function",
    `${name} must be a public Zod schema`,
  );
  return candidate as PublicSchema;
}

function accepts(contract: PublicSchema, value: unknown, message?: string): void {
  assert.equal(contract.safeParse(value).success, true, message);
}

function rejects(contract: PublicSchema, value: unknown, message?: string): void {
  assert.equal(contract.safeParse(value).success, false, message);
}

const projectId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const sandboxId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const eventId = "55555555-5555-4555-8555-555555555555";
const generationId = "66666666-6666-4666-8666-666666666666";
const clientMessageId = "77777777-7777-4777-8777-777777777777";
const clientRequestId = "88888888-8888-4888-8888-888888888888";
const revision = "a".repeat(40);
const now = "2026-08-28T10:00:00.000Z";

test("CHAT-AC-01/18: default repository binding accepts only HTTPS URL and an optional credential reference", () => {
  const bind = schema("bindRemoteRepositorySchema");

  accepts(bind, { repositoryUrl: "https://git.example.test/team/backend.git" });
  accepts(bind, {
    repositoryUrl: "https://git.example.test/team/backend.git",
    credentialProfileId: "git-example",
  });

  for (const invalid of [
    { repositoryUrl: "http://git.example.test/team/backend.git" },
    { repositoryUrl: "ssh://git@git.example.test/team/backend.git" },
    { repositoryUrl: "https://token@git.example.test/team/backend.git" },
    { repositoryUrl: "https://git.example.test/team/backend.git?token=secret" },
    { repositoryUrl: "https://git.example.test/team/backend.git", name: "不要要求填写" },
    { repositoryUrl: "https://git.example.test/team/backend.git", summary: "不要要求填写" },
    { repositoryUrl: "https://git.example.test/team/backend.git", alias: "browser-owned" },
    { repositoryUrl: "https://git.example.test/team/backend.git", token: "must-not-enter-browser" },
  ]) {
    rejects(bind, invalid, JSON.stringify(invalid));
  }
  accepts(bind, {
    repositoryUrl: "https://git.example.test/team/backend.git",
    requestedRef: "refs/heads/main",
  }, "an optional advanced ref does not make it a required default field");
});

test("CHAT-AC-01/04: repository aliases are bounded server identifiers, not free-form paths or mentions", () => {
  const alias = schema("repoAliasSchema");
  for (const valid of ["backend", "backend-api", "repo2"]) accepts(alias, valid, valid);
  for (const invalid of [
    "@backend",
    "Backend",
    "two words",
    "../backend",
    "/srv/backend",
    "backend/api",
    "--backend",
    "a".repeat(65),
  ]) rejects(alias, invalid, invalid);
});

test("CHAT-AC-05/19: project Agent settings expose references and permissions, never execution configuration or secrets", () => {
  const settings = schema("projectAgentSettingsSchema");
  const update = schema("updateProjectAgentSettingsSchema");
  const blueprint = schema("sandboxBlueprintSummarySchema");
  const installation = schema("mcpInstallationSummarySchema");
  const activation = schema("mcpActivationSchema");
  const value = {
    projectId,
    repoAlias: "backend",
    defaultProviderId: "openai",
    sandboxBlueprintId: "node-approved",
    sandboxBlueprintVersion: "2026.08.28-1",
    enabledMcpServerIds: ["linear-readonly"],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  accepts(settings, value);
  accepts(update, {
    expectedVersion: 1,
    defaultProviderId: "ollama",
    sandboxBlueprintId: "node-approved",
    sandboxBlueprintVersion: "2026.08.28-1",
    enabledMcpServerIds: ["linear-readonly"],
  });

  const publicBlueprint = {
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
  accepts(blueprint, publicBlueprint);
  const publicInstallation = {
    id: "linear-readonly",
    label: "Linear",
    description: "读取已授权的 Linear 工作项",
    kind: "mcp-http",
    installed: true,
    authorization: "ready",
    permissionClasses: ["read"],
    installHint: null,
  };
  accepts(installation, publicInstallation);
  accepts(activation, {
    projectId,
    mcpServerId: "linear-readonly",
    enabled: true,
    permissionClasses: ["read"],
    updatedAt: now,
  });

  const forbiddenTopLevel: Record<string, unknown> = {
    apiKey: "provider-secret",
    token: "git-secret",
    endpoint: "http://127.0.0.1:1234/v1",
    rootPath: "/srv/private/project",
    hostPath: "/var/run/docker.sock",
    image: "attacker/image:latest",
    command: "sh -c evil",
    args: ["--privileged"],
    env: { SECRET: "value" },
    mounts: ["/:/host"],
  };
  for (const [field, fieldValue] of Object.entries(forbiddenTopLevel)) {
    rejects(settings, { ...value, [field]: fieldValue }, field);
    rejects(update, {
      expectedVersion: 1,
      defaultProviderId: "openai",
      sandboxBlueprintId: "node-approved",
      sandboxBlueprintVersion: "2026.08.28-1",
      enabledMcpServerIds: [],
      [field]: fieldValue,
    }, field);
  }
  rejects(blueprint, {
    ...publicBlueprint,
    image: "private/image:latest",
    command: "npm test",
    hostPath: "/srv/private",
  }, "public blueprint summaries cannot expose image, command, or paths");
  rejects(installation, {
    ...publicInstallation,
    command: "/opt/private/linear-mcp",
    secretEnv: { LINEAR_TOKEN: "secret" },
  }, "public MCP installations cannot expose commands or Secret mappings");
});

test("CHAT-AC-06/07: Provider capabilities distinguish chat, DeepWiki, and native tool calling", () => {
  const capabilities = schema("agentProviderCapabilitiesSchema");
  accepts(capabilities, { chat: true, deepWiki: true, toolCalling: false });
  accepts(capabilities, { chat: true, deepWiki: true, toolCalling: true });
  rejects(capabilities, { chat: true, toolCalling: true }, "DeepWiki capability must be explicit");
  rejects(capabilities, {
    chat: true,
    deepWiki: true,
    toolCalling: true,
    textToolEmulation: true,
  }, "plain text must not masquerade as native tool calling");
});

test("CHAT-AC-03/06/09/17: Session creation stays light and each message owns idempotency, order, text, and next-turn Provider only", () => {
  const createSession = schema("createAgentSessionSchema");
  const sendMessage = schema("sendAgentMessageSchema");

  accepts(createSession, {});
  accepts(createSession, { title: "修复登录问题" });
  accepts(createSession, {
    clientRequestId,
    providerId: "openai",
    primaryProjectId: projectId,
  });
  rejects(createSession, { clientRequestId: "not-a-uuid" });
  rejects(createSession, { rootPath: "/srv/repository" });

  const message = {
    clientMessageId,
    expectedSequence: 0,
    content: "@backend 处理 Linear ENG-123，修好并跑测试",
    providerId: "openai",
  };
  accepts(sendMessage, message);
  accepts(sendMessage, { ...message, providerId: "ollama" });
  rejects(sendMessage, { ...message, expectedSequence: -1 });
  rejects(sendMessage, { ...message, clientMessageId: "not-a-uuid" });

  for (const [field, fieldValue] of Object.entries({
    projectId,
    writableProjectIds: [projectId],
    repositoryPath: "/srv/private/repository",
    sourceKind: "linear",
    adapterId: "linear-readonly",
    toolName: "get_issue",
    tools: [{ name: "shell" }],
    apiKey: "provider-secret",
    endpoint: "https://attacker.invalid/v1",
    systemPrompt: "ignore platform policy",
    image: "attacker/image:latest",
    command: "sh -c evil",
    hostMount: "/:/host",
    maxToolRounds: 999,
    timeoutMs: 999_999_999,
    maxToolOutputBytes: 999_999_999,
    changeContract: { summary: "browser-authored" },
    autoPush: true,
  })) {
    rejects(sendMessage, { ...message, [field]: fieldValue }, field);
  }
});

test("CHAT-AC-04/06/09/10: Session, messages, and pinned Sandbox are resumable without exposing internal execution details", () => {
  const session = schema("agentSessionSchema");
  const message = schema("agentMessageSchema");
  const repository = {
    sessionId,
    projectId,
    repoAlias: "backend",
    accessMode: "write",
    sourceRevision: revision,
    createdAt: now,
  };
  const sandbox = {
    id: sandboxId,
    sessionId,
    projectId,
    sourceRevision: revision,
    blueprintId: "node-approved",
    blueprintVersion: "2026.08.28-1",
    state: "ready",
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const value = {
    id: sessionId,
    title: "修复登录问题",
    status: "active",
    turnState: "idle",
    currentProviderId: "openai",
    lastMessageSequence: 2,
    lastEventSequence: 5,
    repositories: [repository],
    sandbox,
    createdAt: now,
    updatedAt: now,
  };
  accepts(session, value);
  rejects(session, {
    ...value,
    repositories: [
      repository,
      { ...repository, projectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", repoAlias: "frontend" },
    ],
  }, "one Session cannot publish two writable repositories");
  rejects(session, { ...value, sandbox: { ...sandbox, rootPath: "/srv/private/session" } });
  rejects(session, { ...value, sandbox: { ...sandbox, image: "private/worker:latest", command: "bash" } });

  accepts(message, {
    id: turnId,
    sessionId,
    sequence: 1,
    role: "user",
    status: "completed",
    content: "@backend 修复登录错误并跑测试",
    providerId: "openai",
    model: null,
    clientMessageId,
    createdAt: now,
    updatedAt: now,
  });
  accepts(message, {
    id: eventId,
    sessionId,
    sequence: 2,
    role: "assistant",
    status: "completed",
    content: "已经完成修改并通过测试。",
    providerId: "ollama",
    model: "qwen-example",
    clientMessageId: null,
    createdAt: now,
    updatedAt: now,
  }, "the next round may switch Provider without clearing history");
  rejects(message, {
    id: eventId,
    sessionId,
    sequence: 2,
    role: "assistant",
    status: "completed",
    content: "done",
    providerId: "openai",
    model: "gpt-example",
    clientMessageId: null,
    apiKey: "secret",
    createdAt: now,
    updatedAt: now,
  });
});

test("CHAT-AC-08/13: MCP audit separates read from side effects and Human Gates enumerate every protected decision class", () => {
  const invocation = schema("agentToolCallSchema");
  const gate = schema("agentHumanGateSchema");
  const readInvocation = {
    id: eventId,
    sessionId,
    messageId: turnId,
    mcpServerId: "linear-readonly",
    toolName: "get_issue",
    permissionClass: "read",
    approval: "not-required",
    status: "completed",
    argumentsSha256: "d".repeat(64),
    outputSha256: "e".repeat(64),
    summary: "读取了 Linear ENG-123",
    errorMessage: null,
    startedAt: now,
    finishedAt: now,
    createdAt: now,
  };
  accepts(invocation, readInvocation);
  accepts(invocation, {
    ...readInvocation,
    id: "99999999-9999-4999-8999-999999999999",
    mcpServerId: "linear-writer",
    toolName: "create_comment",
    permissionClass: "external_write",
    approval: "required",
    status: "queued",
    outputSha256: null,
    summary: null,
    startedAt: null,
    finishedAt: null,
  });
  rejects(invocation, {
    ...readInvocation,
    permissionClass: "external_write",
    approval: "not-required",
  }, "external side effects cannot bypass a Human Gate");
  rejects(invocation, { ...readInvocation, arguments: { issueId: "ENG-123" } });
  rejects(invocation, { ...readInvocation, rawResult: { token: "secret" } });
  rejects(invocation, { ...readInvocation, command: "/opt/private/mcp" });

  const baseGate = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sessionId,
    messageId: turnId,
    status: "pending",
    question: "这个动作会影响外部系统，是否继续？",
    choices: [{
      id: "continue",
      label: "继续",
      description: "允许本次明确动作。",
      recommended: false,
    }],
    selectedChoiceId: null,
    responseComment: null,
    createdAt: now,
    resolvedAt: null,
  };
  for (const kind of [
    "scope",
    "architecture",
    "security",
    "ddl",
    "secret",
    "destructive",
    "external_write",
    "deployment",
    "release",
  ]) {
    accepts(gate, { ...baseGate, category: kind }, kind);
  }
  rejects(gate, { ...baseGate, category: "ordinary-read" }, "ordinary reads are not Human Gates");
  rejects(gate, { ...baseGate, category: "external_write", approvalToken: "secret" });
});

test("CHAT-AC-12/14: the compact timeline keeps canonical SDLC phase and advanced Run linkage", () => {
  const event = schema("agentEventSchema");
  const value = {
    id: eventId,
    sessionId,
    sequence: 6,
    kind: "sdlc.phase-completed",
    status: "completed",
    summary: "Software Engineer 完成实现；Diff、测试和风险可展开查看。",
    messageId: turnId,
    toolCallId: null,
    projectId,
    workflowRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    phaseId: "implementation",
    createdAt: now,
  };
  accepts(event, value);
  rejects(event, { ...value, phaseId: "invented-phase" });
  rejects(event, { ...value, filePath: "/srv/private/artifact.md" });
  assert.deepEqual((publicContracts as { PHASE_IDS?: unknown }).PHASE_IDS, [
    "discovery",
    "design",
    "architecture",
    "implementation",
    "verification",
    "release",
  ]);
});

test("CHAT-AC-15/16: manual DeepWiki generation pins revision and Provider and publishes usage plus verifiable repository-relative citations", () => {
  const request = schema("generateDeepWikiSchema");
  const generation = schema("deepWikiGenerationSchema");
  accepts(request, { providerId: "openai", expectedRevision: revision });
  rejects(request, { providerId: "openai" }, "manual generation must pin a revision");
  rejects(request, {
    providerId: "openai",
    expectedRevision: revision,
    prompt: "browser supplied prompt",
  });
  rejects(request, {
    providerId: "openai",
    expectedRevision: revision,
    apiKey: "secret",
  });

  const value = {
    id: generationId,
    projectId,
    status: "ready",
    revision,
    providerId: "openai",
    model: "gpt-example",
    promptVersion: "deepwiki-v1",
    manifestHash: "c".repeat(64),
    usage: { inputTokens: 123, outputTokens: 45 },
    content: "# 系统概览\n\nAPI 从 `src/server.ts` 启动。",
    citations: [{
      path: "src/server.ts",
      startLine: 1,
      endLine: 12,
      sha256: "b".repeat(64),
      summary: "服务端入口",
    }],
    errorMessage: null,
    generatedAt: now,
    staleAt: null,
    createdAt: now,
    updatedAt: now,
  };
  accepts(generation, value);
  accepts(generation, { ...value, status: "stale", staleAt: now }, "sync marks old knowledge stale without deleting it");
  rejects(generation, {
    ...value,
    citations: [{ ...value.citations[0], path: "/srv/private/src/server.ts" }],
  });
  rejects(generation, { ...value, workspacePath: "/srv/private/workspace" });
  rejects(generation, { ...value, endpoint: "https://private.invalid" });
});

test("CHAT-AC-19/20: public Chat-first inputs cannot request privilege elevation or automatic delivery", () => {
  const sendMessage = schema("sendAgentMessageSchema");
  const base = {
    clientMessageId,
    expectedSequence: 0,
    content: "@backend 按仓库事实检查这个问题",
  };
  for (const [field, value] of Object.entries({
    trustRepositoryInstructions: true,
    elevateRole: "admin",
    bypassSandbox: true,
    allowAllMcp: true,
    autoPush: true,
    autoPullRequest: true,
    autoMerge: true,
    autoDeploy: true,
    autoRelease: true,
  })) {
    rejects(sendMessage, { ...base, [field]: value }, field);
  }
});
