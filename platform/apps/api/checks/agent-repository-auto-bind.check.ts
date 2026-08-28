import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type pg from "pg";

import type { AgentSessionRecord } from "../src/db/store.ts";
import { PgWorkflowStore } from "../src/db/store.ts";
import { AgentSessionService } from "../src/services/agent/agent-session-service.ts";
import type { ConversationPlanner } from "../src/services/agent/conversation-planner.ts";
import type { AgentMcpToolRouter } from "../src/services/agent/mcp-tool-router.ts";
import type { SandboxBlueprintRegistry } from "../src/services/agent/sandbox-blueprint-registry.ts";
import type { AskService } from "../src/services/ask/ask-service.ts";
import type { CloudProjectService } from "../src/services/cloud-project-service.ts";
import type { AskProviderRegistry } from "../src/services/llm/provider-registry.ts";
import type { WorkflowService } from "../src/services/workflow-service.ts";

const now = new Date("2026-08-28T10:00:00.000Z");
const revision = "a".repeat(40);

test("CHAT-AC-04: a unique ready @repo alias is transactionally added as read-only", async () => {
  const sessionId = randomUUID();
  const primaryProjectId = randomUUID();
  const secondaryProjectId = randomUUID();
  const secondaryWorkspaceId = randomUUID();
  const inserted: unknown[][] = [];
  const statements: string[] = [];
  const sessionRow = agentSessionRow(sessionId, "idle");
  const primary = repositoryRow(sessionId, primaryProjectId, "primary", "write");
  const secondary = repositoryRow(sessionId, secondaryProjectId, "shared-lib", "read");
  const client = {
    async query(sql: string, values?: unknown[]) {
      statements.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM agent_sessions") && sql.includes("FOR UPDATE")) return { rows: [sessionRow] };
      if (sql.includes("SELECT repo_alias") && sql.includes("agent_session_repositories")) {
        return { rows: [{ repo_alias: "primary" }] };
      }
      if (sql.includes("FROM project_agent_settings pas")) {
        return {
          rows: [{
            repo_alias: "shared-lib",
            project_id: secondaryProjectId,
            workspace_id: secondaryWorkspaceId,
            source_revision: revision,
          }],
        };
      }
      if (sql.includes("INSERT INTO agent_session_repositories")) {
        inserted.push(values ?? []);
        return { rows: [] };
      }
      if (sql.includes("SELECT * FROM agent_sessions WHERE id")) return { rows: [sessionRow] };
      if (sql.includes("SELECT * FROM agent_session_repositories")) return { rows: [primary, secondary] };
      if (sql.includes("SELECT * FROM agent_sandboxes")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  const store = new PgWorkflowStore(pool);

  const result = await store.bindReadyAgentSessionReadRepositoriesByAlias(
    sessionId,
    ["primary", "shared-lib", "shared-lib"],
  );

  assert.deepEqual(result.repositories.map(({ repoAlias, accessMode }) => [repoAlias, accessMode]), [
    ["primary", "write"],
    ["shared-lib", "read"],
  ]);
  assert.equal(inserted.length, 1);
  assert.deepEqual(inserted[0], [
    sessionId,
    secondaryProjectId,
    secondaryWorkspaceId,
    "shared-lib",
    revision,
  ]);
  assert.equal(statements.at(-1), "COMMIT");
});

test("CHAT-AC-04: unknown or unready aliases roll back before any repository is bound", async () => {
  const sessionId = randomUUID();
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM agent_sessions") && sql.includes("FOR UPDATE")) {
        return { rows: [agentSessionRow(sessionId, "idle")] };
      }
      if (sql.includes("SELECT repo_alias") && sql.includes("agent_session_repositories")) {
        return { rows: [] };
      }
      if (sql.includes("FROM project_agent_settings pas")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const store = new PgWorkflowStore({ connect: async () => client } as unknown as pg.Pool);

  await assert.rejects(
    () => store.bindReadyAgentSessionReadRepositoriesByAlias(sessionId, ["missing"]),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AGENT_REPOSITORY_MENTION_UNKNOWN");
      return true;
    },
  );
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO agent_session_repositories")), false);
});

test("CHAT-AC-04: AgentSessionService binds mentioned aliases before beginAgentTurn", async () => {
  const sessionId = randomUUID();
  const projectId = randomUUID();
  const calls: string[] = [];
  const session = agentSessionRecord(sessionId, projectId);
  const expected = new Error("begin reached");
  const store = {
    getAgentSession: async () => {
      calls.push("get");
      return session;
    },
    bindReadyAgentSessionReadRepositoriesByAlias: async (_id: string, aliases: string[]) => {
      calls.push(`bind:${aliases.join(",")}`);
      return session;
    },
    beginAgentTurn: async () => {
      calls.push("begin");
      throw expected;
    },
  } as unknown as PgWorkflowStore;
  const service = new AgentSessionService(
    store,
    {} as AskService,
    {} as AskProviderRegistry,
    {} as ConversationPlanner,
    {} as AgentMcpToolRouter,
    {} as WorkflowService,
    {} as CloudProjectService,
    {} as SandboxBlueprintRegistry,
  );

  await assert.rejects(
    () => service.sendMessage(sessionId, {
      clientMessageId: randomUUID(),
      expectedSequence: 0,
      content: "请参考 @shared-lib 后修改 @primary",
    }),
    expected,
  );
  assert.deepEqual(calls, ["get", "bind:shared-lib", "begin"]);
});

function agentSessionRow(id: string, turnState: "idle" | "running") {
  return {
    id,
    title: "Agent Session",
    status: "active",
    turn_state: turnState,
    current_provider_id: "openai",
    last_message_sequence: 0,
    last_event_sequence: 0,
    created_at: now,
    updated_at: now,
  };
}

function repositoryRow(
  sessionId: string,
  projectId: string,
  repoAlias: string,
  accessMode: "write" | "read",
) {
  return {
    session_id: sessionId,
    project_id: projectId,
    workspace_id: randomUUID(),
    repo_alias: repoAlias,
    access_mode: accessMode,
    source_revision: revision,
    created_at: now,
  };
}

function agentSessionRecord(sessionId: string, projectId: string): AgentSessionRecord {
  const timestamp = now.toISOString();
  return {
    id: sessionId,
    title: "Agent Session",
    status: "active",
    turnState: "idle",
    currentProviderId: "openai",
    lastMessageSequence: 0,
    lastEventSequence: 0,
    repositories: [{
      sessionId,
      projectId,
      repoAlias: "primary",
      accessMode: "write",
      sourceRevision: revision,
      createdAt: timestamp,
    }],
    sandbox: null,
    messages: [],
    events: [],
    toolCalls: [],
    humanGates: [],
    sessionRuns: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
