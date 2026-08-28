import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type {
  AgentEventDto,
  AgentMessageDto,
  AgentSandboxDto,
  SendAgentMessageInput,
} from "@ai-sdlc/contracts";

import type { AgentSessionRecord, PgWorkflowStore } from "../src/db/store.ts";
import type { AskService } from "../src/services/ask/ask-service.ts";
import { AgentSessionService } from "../src/services/agent/agent-session-service.ts";
import type { ConversationPlanner } from "../src/services/agent/conversation-planner.ts";
import type { AgentMcpToolRouter } from "../src/services/agent/mcp-tool-router.ts";
import type { SandboxBlueprintRegistry } from "../src/services/agent/sandbox-blueprint-registry.ts";
import type { CloudProjectService } from "../src/services/cloud-project-service.ts";
import type { AskProviderRegistry } from "../src/services/llm/provider-registry.ts";
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
  return { service, request, sessionId, calls };
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
