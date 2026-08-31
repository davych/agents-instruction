import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type {
  AgentEventDto,
  AgentMessageDto,
  AgentSandboxDto,
  AskProviderId,
  ExecutionDto,
  PhaseRunDto,
  SendAgentMessageInput,
} from "@ai-sdlc/contracts";

import type { AgentSessionRecord, PgWorkflowStore } from "../src/db/store.ts";
import { AppError } from "../src/domain/errors.ts";
import type { AskService } from "../src/services/ask/ask-service.ts";
import { AgentSessionService } from "../src/services/agent/agent-session-service.ts";
import type { ConversationPlanner } from "../src/services/agent/conversation-planner.ts";
import type { AgentMcpToolRouter } from "../src/services/agent/mcp-tool-router.ts";
import type { SandboxBlueprintRegistry } from "../src/services/agent/sandbox-blueprint-registry.ts";
import type { ProviderPhaseExecutionContext } from "../src/services/agent/provider-phase-executor.ts";
import type { CloudProjectService } from "../src/services/cloud-project-service.ts";
import { AskProviderRegistry } from "../src/services/llm/provider-registry.ts";
import type { AskLlmProvider } from "../src/services/llm/types.ts";
import type { WorkflowService } from "../src/services/workflow-service.ts";

const now = "2026-08-28T12:00:00.000Z";
const revision = "b".repeat(40);

test("Agent retry repairs post-COMMIT Sandbox/event bookkeeping without replaying Provider, MCP, planning, or Run creation", async () => {
  const fixture = recoveryFixture({
    messageStatus: "failed",
    sandboxState: "ready",
    includeRunCreatedEvent: false,
  });

  const first = await fixture.service.sendMessage(fixture.sessionId, fixture.request);
  assert.equal(first.session.sandbox?.state, "busy");
  assert.equal(first.messages[0]?.status, "failed", "a failed LLM turn is not silently replayed");
  assert.deepEqual(first.runs, [{
    sessionId: fixture.sessionId,
    triggerMessageId: fixture.messageId,
    workflowRunId: fixture.runId,
    providerId: "openai",
    createdAt: now,
  }]);
  assert.equal(
    first.events.filter(({ kind }) => kind === "sdlc.run-created").length,
    1,
  );
  assert.deepEqual(fixture.calls, { transitions: 1, events: 1, external: 0 });

  const second = await fixture.service.sendMessage(fixture.sessionId, fixture.request);
  assert.equal(second.session.sandbox?.state, "busy");
  assert.equal(second.events.filter(({ kind }) => kind === "sdlc.run-created").length, 1);
  assert.deepEqual(
    fixture.calls,
    { transitions: 1, events: 1, external: 0 },
    "repeated recovery is idempotent and never creates a second Run",
  );
});

test("same clientMessageId after a lost completed response only replays durable state", async () => {
  const fixture = recoveryFixture({
    messageStatus: "completed",
    sandboxState: "busy",
    includeRunCreatedEvent: true,
  });

  const detail = await fixture.service.sendMessage(fixture.sessionId, fixture.request);

  assert.equal(detail.messages[0]?.status, "completed");
  assert.equal(detail.events.filter(({ kind }) => kind === "sdlc.run-created").length, 1);
  assert.deepEqual(fixture.calls, { transitions: 0, events: 0, external: 0 });
});

test("advanceRun persists the selected Session Provider and pins one runtime snapshot", async () => {
  const sessionId = randomUUID();
  const projectId = randomUUID();
  const messageId = randomUUID();
  const runId = randomUUID();
  const phaseRunId = randomUUID();
  const oldRuntimeCalls: string[] = [];
  const newRuntimeCalls: string[] = [];
  const oldProvider = configuredProvider("openai", "Old OpenAI", "old-model", oldRuntimeCalls);
  const newProvider = configuredProvider("openai", "New OpenAI", "new-model", newRuntimeCalls);
  const providers = new AskProviderRegistry([
    oldProvider,
    configuredProvider("lmstudio", "LM Studio", "lm-model", []),
    configuredProvider("ollama", "Ollama", "ollama-model", []),
    configuredProvider("custom", "Custom", "custom-model", []),
  ]);
  const userMessage: AgentMessageDto = {
    id: messageId,
    sessionId,
    sequence: 1,
    role: "user",
    status: "completed",
    content: "继续当前 PM / BA 阶段",
    providerId: "openai",
    model: "old-model",
    clientMessageId: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  const bundle = readyDiscoveryBundle(runId, projectId, phaseRunId);
  const recordedEvents: Array<Omit<AgentEventDto, "id" | "sequence" | "createdAt">> = [];
  const record: AgentSessionRecord = {
    id: sessionId,
    title: "Provider pin fixture",
    status: "active",
    turnState: "idle",
    currentProviderId: "ollama",
    lastMessageSequence: 1,
    lastEventSequence: 0,
    repositories: [{
      sessionId,
      projectId,
      repoAlias: "primary",
      accessMode: "write",
      sourceRevision: revision,
      createdAt: now,
    }],
    sandbox: null,
    messages: [userMessage],
    events: [],
    toolCalls: [],
    humanGates: [],
    sessionRuns: [{ sessionId, triggerMessageId: messageId, workflowRunId: runId, createdAt: now }],
    createdAt: now,
    updatedAt: now,
  };
  const observed = {
    statusBeforeReplace: "",
    statusAfterReplace: "",
    configuredModel: "",
    runtimeModel: "",
    recordVersion: 0,
    sessionProviderAtExecution: "",
  };
  const store = {
    getAgentSession: async () => record,
    updateIdleAgentSessionProvider: async (
      requestedSessionId: string,
      requestedRunId: string,
      providerId: AskProviderId,
    ) => {
      assert.equal(requestedSessionId, sessionId);
      assert.equal(requestedRunId, runId);
      assert.equal(record.status, "active");
      assert.equal(record.turnState, "idle");
      record.currentProviderId = providerId;
      observed.statusBeforeReplace = providers.status("openai").model ?? "";
      providers.replace("openai", newProvider, 2);
      observed.statusAfterReplace = providers.status("openai").model ?? "";
    },
    appendAgentEvent: async (
      event: Omit<AgentEventDto, "id" | "sequence" | "createdAt">,
    ) => {
      recordedEvents.push(event);
      return { ...event, id: randomUUID(), sequence: recordedEvents.length, createdAt: now };
    },
  } as unknown as PgWorkflowStore;
  const execution = completedProviderExecution(phaseRunId, "old-model");
  let executionContext: ProviderPhaseExecutionContext | undefined;
  const workflow = {
    getRun: async () => bundle,
    executePhase: async (
      _runId: string,
      _phaseId: string,
      _input: unknown,
      context: ProviderPhaseExecutionContext | undefined,
    ) => {
      assert.ok(context);
      executionContext = context;
      observed.sessionProviderAtExecution = record.currentProviderId;
      observed.configuredModel = providers.status(context.providerId).model ?? "";
      observed.recordVersion = providers.recordVersion(context.providerId);
      const response = await providers.complete(context.providerId, {
        systemPrompt: "Pinned Provider race check",
        messages: [{ role: "user", content: "continue" }],
        maxOutputTokens: 16,
      });
      observed.runtimeModel = response.model;
      return execution;
    },
  } as unknown as WorkflowService;
  const unused = {} as never;
  const service = new AgentSessionService(
    store,
    unused,
    providers,
    unused,
    unused,
    workflow,
    unused,
    unused,
  );

  const progress = await service.advanceRun(sessionId, runId, {
    expectedPhaseId: "discovery",
    providerId: "openai",
  });

  assert.equal(progress.state, "started");
  assert.deepEqual(observed, {
    statusBeforeReplace: "old-model",
    statusAfterReplace: "old-model",
    configuredModel: "old-model",
    runtimeModel: "old-model",
    recordVersion: 1,
    sessionProviderAtExecution: "openai",
  });
  assert.deepEqual(oldRuntimeCalls, ["old-model"]);
  assert.deepEqual(newRuntimeCalls, []);
  assert.match(recordedEvents[0]?.summary ?? "", /Old OpenAI/u);
  assert.doesNotMatch(recordedEvents[0]?.summary ?? "", /New OpenAI/u);
  assert.equal(providers.status("openai").model, "new-model", "future operations see the replacement");
  assert.equal(providers.recordVersion("openai"), 2);
  assert.equal((await service.get(sessionId)).session.currentProviderId, "openai");
  assert.ok(executionContext?.onExecutionSettled);
  await executionContext.outcomeReady;
  await executionContext.onExecutionSettled({
    executionId: execution.id,
    runId,
    phaseId: "discovery",
    state: "awaiting_review",
    artifactKeys: ["prd", "user-stories"],
    message: "本阶段产物已完整落盘并进入人工审核。",
  });
  assert.deepEqual(recordedEvents.map(({ kind, status }) => ({ kind, status })), [
    { kind: "sdlc.phase-started", status: "started" },
    { kind: "sdlc.phase-completed", status: "completed" },
    { kind: "human-gate.required", status: "waiting" },
  ]);
  assert.match(recordedEvents[1]?.summary ?? "", /prd.*user-stories.*等待人工审核/u);
});

test("advanceRun rejects a completed Session-owned Run before Provider, Session, or event side effects", async () => {
  const sessionId = randomUUID();
  const projectId = randomUUID();
  const messageId = randomUUID();
  const runId = randomUUID();
  const phaseRunId = randomUUID();
  const record: AgentSessionRecord = {
    id: sessionId,
    title: "Completed Run guard fixture",
    status: "archived",
    turnState: "running",
    currentProviderId: "ollama",
    lastMessageSequence: 1,
    lastEventSequence: 0,
    repositories: [{
      sessionId,
      projectId,
      repoAlias: "primary",
      accessMode: "write",
      sourceRevision: revision,
      createdAt: now,
    }],
    sandbox: null,
    messages: [persistedUserMessage(
      sessionId,
      1,
      "不要重新执行已完成的 Session Run",
      "completed",
      messageId,
    )],
    events: [],
    toolCalls: [],
    humanGates: [],
    sessionRuns: [{
      sessionId,
      triggerMessageId: messageId,
      workflowRunId: runId,
      createdAt: now,
    }],
    createdAt: now,
    updatedAt: now,
  };
  const sideEffects = { provider: 0, session: 0, event: 0, execution: 0 };
  const store = {
    getAgentSession: async () => record,
    updateIdleAgentSessionProvider: async () => {
      sideEffects.session += 1;
    },
    appendAgentEvent: async () => {
      sideEffects.event += 1;
      throw new Error("completed guard must not append an event");
    },
  } as unknown as PgWorkflowStore;
  const providers = {
    runWithProvider: <T>(_providerId: AskProviderId, operation: () => T): T => {
      sideEffects.provider += 1;
      return operation();
    },
    status: () => {
      sideEffects.provider += 1;
      throw new Error("completed guard must not inspect or invoke a Provider");
    },
  } as unknown as AskProviderRegistry;
  const activeBundle = readyDiscoveryBundle(runId, projectId, phaseRunId);
  const bundle = {
    ...activeBundle,
    run: { ...activeBundle.run, status: "completed" as const },
  };
  const workflow = {
    getRun: async () => bundle,
    executePhase: async () => {
      sideEffects.execution += 1;
      throw new Error("completed guard must not start phase execution");
    },
  } as unknown as WorkflowService;
  const unused = {} as never;
  const service = new AgentSessionService(
    store,
    unused,
    providers,
    unused,
    unused,
    workflow,
    unused,
    unused,
  );

  await assert.rejects(
    () => service.advanceRun(sessionId, runId, {
      expectedPhaseId: "discovery",
      providerId: "openai",
    }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "AGENT_SESSION_RUN_COMPLETED_IMMUTABLE",
      );
      assert.equal((error as { statusCode?: number }).statusCode, 409);
      assert.deepEqual((error as { details?: unknown }).details, { sessionId });
      return true;
    },
  );
  assert.deepEqual(sideEffects, { provider: 0, session: 0, event: 0, execution: 0 });
});

test("advanceRun inherits a durable failed trigger as the final user goal and excludes unrelated failed turns", async () => {
  const sessionId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const phaseRunId = randomUUID();
  const triggerMessageId = randomUUID();
  const providers = new AskProviderRegistry([
    configuredProvider("openai", "OpenAI", "pinned-model", []),
    configuredProvider("lmstudio", "LM Studio", "lm-model", []),
    configuredProvider("ollama", "Ollama", "ollama-model", []),
    configuredProvider("custom", "Custom", "custom-model", []),
  ]);
  const messages: AgentMessageDto[] = [
    persistedUserMessage(sessionId, 1, "旧对话目标：只解释现状", "completed"),
    persistedUserMessage(sessionId, 2, "不属于当前 Run 的失败请求", "failed"),
    persistedUserMessage(
      sessionId,
      3,
      "当前 Run 的真实触发目标：修复 Provider 阶段执行",
      "failed",
      triggerMessageId,
    ),
  ];
  const record: AgentSessionRecord = {
    id: sessionId,
    title: "Durable trigger recovery fixture",
    status: "active",
    turnState: "idle",
    currentProviderId: "openai",
    lastMessageSequence: 3,
    lastEventSequence: 0,
    repositories: [{
      sessionId,
      projectId,
      repoAlias: "primary",
      accessMode: "write",
      sourceRevision: revision,
      createdAt: now,
    }],
    sandbox: null,
    messages,
    events: [],
    toolCalls: [],
    humanGates: [],
    sessionRuns: [{
      sessionId,
      triggerMessageId,
      workflowRunId: runId,
      createdAt: now,
    }],
    createdAt: now,
    updatedAt: now,
  };
  const store = {
    getAgentSession: async () => record,
    updateIdleAgentSessionProvider: async (
      requestedSessionId: string,
      requestedRunId: string,
      providerId: AskProviderId,
    ) => {
      assert.equal(requestedSessionId, sessionId);
      assert.equal(requestedRunId, runId);
      record.currentProviderId = providerId;
    },
    appendAgentEvent: async (
      event: Omit<AgentEventDto, "id" | "sequence" | "createdAt">,
    ) => ({ ...event, id: randomUUID(), sequence: 1, createdAt: now }),
  } as unknown as PgWorkflowStore;
  let inheritedMessages: ReadonlyArray<{ role: "user" | "assistant"; content: string }> = [];
  const workflow = {
    getRun: async () => readyDiscoveryBundle(runId, projectId, phaseRunId),
    executePhase: async (
      _runId: string,
      _phaseId: string,
      _input: unknown,
      context: {
        providerId: AskProviderId;
        messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
      } | undefined,
    ) => {
      assert.ok(context);
      inheritedMessages = context.messages;
      return completedProviderExecution(phaseRunId, "pinned-model");
    },
  } as unknown as WorkflowService;
  const unused = {} as never;
  const service = new AgentSessionService(
    store,
    unused,
    providers,
    unused,
    unused,
    workflow,
    unused,
    unused,
  );

  const progress = await service.advanceRun(sessionId, runId, {
    expectedPhaseId: "discovery",
    providerId: "openai",
  });

  assert.equal(progress.state, "started");
  assert.deepEqual(inheritedMessages, [
    { role: "user", content: "旧对话目标：只解释现状" },
    { role: "user", content: "当前 Run 的真实触发目标：修复 Provider 阶段执行" },
  ]);
  assert.deepEqual(inheritedMessages.at(-1), {
    role: "user",
    content: "当前 Run 的真实触发目标：修复 Provider 阶段执行",
  });
});

test("advanceRun durably records immediate blocked and failed coordinator outcomes", async (context) => {
  for (const outcome of ["blocked", "failed"] as const) {
    await context.test(outcome, async () => {
      const sessionId = randomUUID();
      const projectId = randomUUID();
      const runId = randomUUID();
      const phaseRunId = randomUUID();
      const messageId = randomUUID();
      const providers = new AskProviderRegistry([
        configuredProvider("openai", "OpenAI", "pinned-model", []),
        configuredProvider("lmstudio", "LM Studio", "lm-model", []),
        configuredProvider("ollama", "Ollama", "ollama-model", []),
        configuredProvider("custom", "Custom", "custom-model", []),
      ]);
      const trigger = persistedUserMessage(
        sessionId,
        1,
        "继续当前 Run 并保留同步失败原因",
        "completed",
        messageId,
      );
      const record: AgentSessionRecord = {
        id: sessionId,
        title: `${outcome} outcome fixture`,
        status: "active",
        turnState: "idle",
        currentProviderId: "openai",
        lastMessageSequence: 1,
        lastEventSequence: 0,
        repositories: [{
          sessionId,
          projectId,
          repoAlias: "primary",
          accessMode: "write",
          sourceRevision: revision,
          createdAt: now,
        }],
        sandbox: null,
        messages: [trigger],
        events: [],
        toolCalls: [],
        humanGates: [],
        sessionRuns: [{
          sessionId,
          triggerMessageId: messageId,
          workflowRunId: runId,
          createdAt: now,
        }],
        createdAt: now,
        updatedAt: now,
      };
      const bundle = readyDiscoveryBundle(runId, projectId, phaseRunId);
      if (outcome === "blocked") bundle.phases[0]!.status = "pending";
      const store = {
        getAgentSession: async () => record,
        updateIdleAgentSessionProvider: async (
          requestedSessionId: string,
          requestedRunId: string,
          providerId: AskProviderId,
        ) => {
          assert.equal(requestedSessionId, sessionId);
          assert.equal(requestedRunId, runId);
          record.currentProviderId = providerId;
        },
        appendAgentEvent: async (
          event: Omit<AgentEventDto, "id" | "sequence" | "createdAt">,
        ) => {
          const persisted: AgentEventDto = {
            ...event,
            id: randomUUID(),
            sequence: record.events.length + 1,
            createdAt: now,
          };
          record.events.push(persisted);
          record.lastEventSequence = persisted.sequence;
          return persisted;
        },
      } as unknown as PgWorkflowStore;
      let executeCalls = 0;
      const workflow = {
        getRun: async () => bundle,
        executePhase: async () => {
          executeCalls += 1;
          throw new AppError(
            "当前 Provider 阶段缺少必需产物",
            409,
            "PHASE_OUTPUT_MISSING",
          );
        },
      } as unknown as WorkflowService;
      const unused = {} as never;
      const service = new AgentSessionService(
        store,
        unused,
        providers,
        unused,
        unused,
        workflow,
        unused,
        unused,
      );

      const progress = await service.advanceRun(sessionId, runId, {
        expectedPhaseId: "discovery",
        providerId: "openai",
      });
      assert.equal(progress.state, outcome);
      assert.equal(executeCalls, outcome === "failed" ? 1 : 0);
      const refreshed = await service.get(sessionId);
      const event = refreshed.events.at(-1);
      assert.ok(event);
      assert.equal(event.summary, "reason" in progress ? progress.reason : "");
      assert.equal(event.kind, outcome === "failed" ? "sdlc.phase-started" : "human-gate.required");
      assert.equal(event.status, outcome === "failed" ? "failed" : "waiting");
      assert.equal(event.sessionId, sessionId);
      assert.equal(event.messageId, messageId);
      assert.equal(event.projectId, projectId);
      assert.equal(event.workflowRunId, runId);
      assert.equal(event.phaseId, "discovery");
    });
  }
});

function recoveryFixture(input: {
  messageStatus: AgentMessageDto["status"];
  sandboxState: AgentSandboxDto["state"];
  includeRunCreatedEvent: boolean;
}) {
  const sessionId = randomUUID();
  const projectId = randomUUID();
  const workspaceId = randomUUID();
  const messageId = randomUUID();
  const clientMessageId = randomUUID();
  const runId = randomUUID();
  const message: AgentMessageDto = {
    id: messageId,
    sessionId,
    sequence: 1,
    role: "user",
    status: input.messageStatus,
    content: "implement the existing work request",
    providerId: "openai",
    model: null,
    clientMessageId,
    createdAt: now,
    updatedAt: now,
  };
  const sandbox: AgentSandboxDto = {
    id: randomUUID(),
    sessionId,
    projectId,
    sourceRevision: revision,
    blueprintId: "default",
    blueprintVersion: "1",
    state: input.sandboxState,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const events: AgentEventDto[] = input.includeRunCreatedEvent
    ? [runCreatedEvent(sessionId, projectId, messageId, runId)]
    : [];
  const record: AgentSessionRecord = {
    id: sessionId,
    title: "Recovery fixture",
    status: "active",
    turnState: "idle",
    currentProviderId: "openai",
    lastMessageSequence: 1,
    lastEventSequence: events.length,
    repositories: [{
      sessionId,
      projectId,
      repoAlias: "primary",
      accessMode: "write",
      sourceRevision: revision,
      createdAt: now,
    }],
    sandbox,
    messages: [message],
    events,
    toolCalls: [],
    humanGates: [],
    sessionRuns: [{
      sessionId,
      triggerMessageId: messageId,
      workflowRunId: runId,
      createdAt: now,
    }],
    createdAt: now,
    updatedAt: now,
  };
  const calls = { transitions: 0, events: 0, external: 0 };
  const store = {
    beginAgentTurn: async () => ({ message, replayed: true }),
    getAgentSession: async () => record,
    transitionAgentSandbox: async () => {
      calls.transitions += 1;
      record.sandbox = { ...sandbox, state: "busy", updatedAt: now };
      return record.sandbox;
    },
    appendAgentEvent: async (event: Omit<AgentEventDto, "id" | "sequence" | "createdAt">) => {
      calls.events += 1;
      const persisted: AgentEventDto = {
        ...event,
        id: randomUUID(),
        sequence: record.events.length + 1,
        createdAt: now,
      };
      record.events.push(persisted);
      record.lastEventSequence = persisted.sequence;
      return persisted;
    },
  } as unknown as PgWorkflowStore;
  const forbidden = new Proxy({}, {
    get() {
      calls.external += 1;
      throw new Error("recovery must not invoke an external or planning dependency");
    },
  });
  const service = new AgentSessionService(
    store,
    forbidden as AskService,
    forbidden as AskProviderRegistry,
    forbidden as ConversationPlanner,
    forbidden as AgentMcpToolRouter,
    forbidden as WorkflowService,
    forbidden as CloudProjectService,
    forbidden as SandboxBlueprintRegistry,
  );
  const request: SendAgentMessageInput = {
    clientMessageId,
    expectedSequence: 0,
    content: message.content,
  };
  return { service, request, sessionId, messageId, runId, calls };
}

function runCreatedEvent(
  sessionId: string,
  projectId: string,
  messageId: string,
  workflowRunId: string,
): AgentEventDto {
  return {
    id: randomUUID(),
    sessionId,
    sequence: 1,
    kind: "sdlc.run-created",
    status: "completed",
    summary: "Run created",
    messageId,
    toolCallId: null,
    projectId,
    workflowRunId,
    phaseId: null,
    createdAt: now,
  };
}

function configuredProvider(
  id: AskProviderId,
  label: string,
  model: string,
  calls: string[],
): AskLlmProvider {
  return {
    id,
    status: () => ({
      id,
      label,
      configured: true,
      model,
      protocol: "openai-chat",
      dataBoundary: "operator-configured",
      endpointLabel: `fixture://${label}`,
      capabilities: { streaming: false, structuredOutput: true, toolCalling: true },
      message: `${label} ready`,
    }),
    check: async () => {
      throw new Error("check is not used in this fixture");
    },
    complete: async () => {
      calls.push(model);
      return {
        text: "done",
        model,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

function readyDiscoveryBundle(runId: string, projectId: string, phaseRunId: string) {
  const phase: PhaseRunDto = {
    id: phaseRunId,
    workflowRunId: runId,
    phaseId: "discovery",
    position: 0,
    status: "ready",
    artifacts: [],
    reviews: [],
    executions: [],
    events: [],
    availableArtifacts: [],
    resolution: null,
    architectureImpact: null,
    createdAt: now,
    updatedAt: now,
  };
  return {
    run: {
      id: runId,
      projectId,
      title: "Provider-native run",
      objective: "Continue the durable Run",
      status: "active" as const,
      changeContract: { summary: "fixed" },
      createdAt: now,
      updatedAt: now,
    },
    project: {},
    phases: [phase],
    definition: {
      version: 1,
      project: { name: "fixture", summary: "fixture", locale: "zh-CN" },
      roles: [],
      phases: [{
        id: "discovery" as const,
        owner: "pm-ba",
        inputs: [],
        outputs: ["change-contract"],
        gate: "fixed gate",
      }],
    },
    productBaseline: null,
    designBaseline: null,
    architectureBaseline: null,
  };
}

function completedProviderExecution(phaseRunId: string, model: string): ExecutionDto {
  return {
    id: randomUUID(),
    phaseRunId,
    status: "completed",
    selectedArtifactIds: [],
    selectedOutputKeys: ["change-contract"],
    runnerMode: "real",
    model,
    reasoningEffort: null,
    command: "provider-native:openai",
    exitCode: 0,
    error: null,
    startedAt: now,
    finishedAt: now,
    createdAt: now,
  };
}

function persistedUserMessage(
  sessionId: string,
  sequence: number,
  content: string,
  status: Extract<AgentMessageDto["status"], "completed" | "failed">,
  id = randomUUID(),
): AgentMessageDto {
  return {
    id,
    sessionId,
    sequence,
    role: "user",
    status,
    content,
    providerId: "openai",
    model: null,
    clientMessageId: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
}
