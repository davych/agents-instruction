import assert from "node:assert/strict";
import test from "node:test";

import type pg from "pg";

import { schemaSql } from "../src/db/schema.ts";
import { PgWorkflowStore } from "../src/db/store.ts";

interface CapturedQuery {
  sql: string;
  values?: unknown[];
}

test("CHAT-AC-05/06/09/10/15/16: chat-agent DDL is revision-bound and preserves concurrency invariants", () => {
  for (const table of [
    "project_agent_settings",
    "agent_sessions",
    "agent_session_repositories",
    "agent_messages",
    "agent_events",
    "agent_tool_calls",
    "agent_human_gates",
    "agent_sandboxes",
    "deepwiki_generations",
  ]) {
    assert.match(schemaSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"), table);
  }

  assert.match(
    schemaSql,
    /managed_workspace_purpose_upgrade[\s\S]*purpose IN \('project_snapshot', 'run', 'sandbox'\)/u,
    "managed workspaces must distinguish a resumable Session Sandbox from snapshots and Run workspaces",
  );
  assert.match(schemaSql, /agent_sessions[\s\S]*last_message_sequence integer[\s\S]*CHECK \(last_message_sequence >= 0\)/u);
  assert.match(schemaSql, /agent_sessions[\s\S]*last_event_sequence integer[\s\S]*CHECK \(last_event_sequence >= 0\)/u);
  assert.match(schemaSql, /agent_messages[\s\S]*client_message_id[\s\S]*request_fingerprint/u);
  assert.match(schemaSql, /UNIQUE \(session_id, client_message_id\)/u);
  assert.match(schemaSql, /UNIQUE \(session_id, sequence\)/u);
  assert.match(schemaSql, /agent_messages[\s\S]*provider_id[\s\S]*model/u);
  assert.match(schemaSql, /agent_sandboxes[\s\S]*workspace_id uuid[\s\S]*managed_workspaces/u);
  assert.match(schemaSql, /agent_sandboxes[\s\S]*source_revision text[\s\S]*blueprint_version text/u);
  assert.match(schemaSql, /deepwiki_generations[\s\S]*revision text[\s\S]*provider_id text[\s\S]*model text/u);
  assert.match(schemaSql, /deepwiki_generations[\s\S]*citations jsonb[\s\S]*input_tokens integer[\s\S]*output_tokens integer/u);
  assert.match(schemaSql, /deepwiki_generations[\s\S]*status IN \([\s\S]*'ready'[\s\S]*'stale'[\s\S]*stale_at timestamptz/u);
});

test("CHAT-AC-05/06/09/10/15/16: the store exposes persistence operations without requiring app or service layers", () => {
  const prototype = PgWorkflowStore.prototype as unknown as Record<string, unknown>;
  for (const method of [
    "getProjectAgentSettings",
    "upsertProjectAgentSettings",
    "createAgentSession",
    "getAgentSession",
    "bindAgentSessionRepository",
    "createAgentSandbox",
    "transitionAgentSandbox",
    "beginAgentTurn",
    "completeAgentTurn",
    "appendAgentEvent",
    "createAgentToolCall",
    "updateAgentToolCall",
    "createDeepWikiGeneration",
    "transitionDeepWikiGeneration",
    "completeDeepWikiGeneration",
    "failDeepWikiGeneration",
    "markDeepWikiGenerationsStale",
  ]) {
    assert.equal(typeof prototype[method], "function", method);
  }
});

test("CHAT-AC-01: default Agent settings keep one PostgreSQL parameter typed as uuid", async () => {
  const projectId = crypto.randomUUID();
  const now = new Date("2026-08-28T08:00:00.000Z");
  const queries: CapturedQuery[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT id FROM projects")) return { rows: [{ id: projectId }] };
      if (sql.includes("SELECT * FROM project_agent_settings")) {
        return {
          rows: [{
            project_id: projectId,
            repo_alias: `repo-${projectId.replaceAll("-", "")}`,
            default_provider_id: "openai",
            sandbox_blueprint_id: "default",
            sandbox_blueprint_version: "1",
            enabled_mcp_server_ids: [],
            version: 1,
            created_at: now,
            updated_at: now,
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgWorkflowStore({
    connect: async () => client,
  } as unknown as pg.Pool);

  const settings = await store.getProjectAgentSettings(projectId);
  assert.equal(settings.projectId, projectId);
  const insert = queries.find(({ sql }) => sql.includes("INSERT INTO project_agent_settings"));
  assert.ok(insert);
  assert.match(insert.sql, /VALUES \(\$1::uuid,[\s\S]*\(\$1::uuid\)::text/u);
  assert.deepEqual(insert.values, [projectId]);
});

test("CHAT-AC-10/15/16: workspace prune treats Session Sandboxes and DeepWiki generations as live references", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const store = new PgWorkflowStore(pool);

  await store.listPrunableManagedWorkspaces({ olderThanHours: 24, limit: 10 });
  await store.isManagedWorkspaceInUse(crypto.randomUUID());
  await assert.rejects(
    () => store.markManagedWorkspaceDestroyed(crypto.randomUUID()),
    /Workspace/u,
  );

  assert.equal(queries.length, 3);
  for (const sql of queries) {
    assert.match(sql, /agent_sandboxes/u, "every prune gate must preserve a Session Sandbox reference");
    assert.match(sql, /deepwiki_generations/u, "every prune gate must preserve a DeepWiki generation reference");
    assert.match(sql, /workspace_id/u);
  }
});

test("CHAT-AC-06/09: beginAgentTurn serializes sequence checks and replays an identical client message before state validation", async () => {
  const sessionId = crypto.randomUUID();
  const clientMessageId = crypto.randomUUID();
  const now = new Date("2026-08-28T02:00:00.000Z");
  const queries: CapturedQuery[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const session: Record<string, unknown> = {
    id: sessionId,
    title: "Persistence check",
    status: "active",
    turn_state: "idle",
    current_provider_id: "openai",
    last_message_sequence: 0,
    last_event_sequence: 0,
    created_at: now,
    updated_at: now,
  };
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT * FROM agent_sessions") && sql.includes("FOR UPDATE")) {
        return { rows: [session] };
      }
      if (sql.includes("FROM agent_messages") && sql.includes("client_message_id = $2")) {
        return {
          rows: messages.filter((message) => (
            message.session_id === values?.[0] && message.client_message_id === values?.[1]
          )),
        };
      }
      if (sql.includes("INSERT INTO agent_messages")) {
        const row = {
          id: values?.[0],
          session_id: values?.[1],
          sequence: values?.[2],
          role: "user",
          status: "running",
          content: values?.[3],
          provider_id: values?.[4],
          model: null,
          client_message_id: values?.[5],
          request_fingerprint: values?.[6],
          created_at: now,
          updated_at: now,
        };
        messages.push(row);
        return { rows: [row] };
      }
      if (sql.includes("UPDATE agent_sessions") && sql.includes("turn_state = 'running'")) {
        session.turn_state = "running";
        session.current_provider_id = values?.[0];
        session.last_message_sequence = values?.[1];
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgWorkflowStore({
    async connect() {
      return client;
    },
  } as unknown as pg.Pool);
  const request = {
    sessionId,
    clientMessageId,
    expectedSequence: 0,
    content: "@backend fix the retry race",
    providerId: "ollama" as const,
  };

  const accepted = await store.beginAgentTurn(request);
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.message.sequence, 1);
  assert.equal(accepted.message.providerId, "ollama");
  assert.equal("requestFingerprint" in accepted.message, false);

  const replayed = await store.beginAgentTurn(request);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.message, accepted.message);
  assert.equal(
    queries.filter(({ sql }) => sql.includes("INSERT INTO agent_messages")).length,
    1,
    "a retry must not insert or execute a second turn",
  );
  assert.ok(queries.some(({ sql }) => /agent_sessions[\s\S]*FOR UPDATE/u.test(sql)));

  await assert.rejects(
    () => store.beginAgentTurn({ ...request, content: "same id, different work" }),
    (error: unknown) => (error as { code?: string }).code === "AGENT_MESSAGE_IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    () => store.beginAgentTurn({
      ...request,
      clientMessageId: crypto.randomUUID(),
      expectedSequence: 0,
    }),
    (error: unknown) => (error as { code?: string }).code === "AGENT_MESSAGE_SEQUENCE_CONFLICT",
  );
  assert.equal(
    queries.filter(({ sql }) => sql.includes("INSERT INTO agent_messages")).length,
    1,
  );
});

test("CHAT-AC-06/09: completeAgentTurn records the actual Provider/model and advances the same locked Session", async () => {
  const sessionId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const now = new Date("2026-08-28T03:00:00.000Z");
  const queries: CapturedQuery[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT * FROM agent_sessions") && sql.includes("FOR UPDATE")) {
        return { rows: [{
          id: sessionId,
          status: "active",
          turn_state: "running",
          current_provider_id: "ollama",
          last_message_sequence: 1,
        }] };
      }
      if (sql.includes("FROM agent_messages") && sql.includes("role = 'user'")) {
        return { rows: [{
          id: userMessageId,
          session_id: sessionId,
          sequence: 1,
          role: "user",
          status: "running",
          content: "Fix it",
          provider_id: "ollama",
          model: null,
          client_message_id: crypto.randomUUID(),
          request_fingerprint: "a".repeat(64),
          created_at: now,
          updated_at: now,
        }] };
      }
      if (sql.includes("INSERT INTO agent_messages")) {
        return { rows: [{
          id: values?.[0],
          session_id: values?.[1],
          sequence: values?.[2],
          role: "assistant",
          status: "completed",
          content: values?.[3],
          provider_id: values?.[4],
          model: values?.[5],
          client_message_id: null,
          request_fingerprint: null,
          created_at: now,
          updated_at: now,
        }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgWorkflowStore({
    async connect() {
      return client;
    },
  } as unknown as pg.Pool);

  const message = await store.completeAgentTurn({
    sessionId,
    userMessageId,
    content: "Fixed and verified.",
    providerId: "ollama",
    model: "qwen3-coder",
  });

  assert.equal(message.sequence, 2);
  assert.equal(message.providerId, "ollama");
  assert.equal(message.model, "qwen3-coder");
  const insert = queries.find(({ sql }) => sql.includes("INSERT INTO agent_messages"));
  assert.deepEqual(insert?.values?.slice(3, 6), ["Fixed and verified.", "ollama", "qwen3-coder"]);
  assert.ok(queries.some(({ sql }) => (
    sql.includes("UPDATE agent_sessions")
    && sql.includes("turn_state = 'idle'")
    && sql.includes("last_message_sequence = $1")
  )));
  assert.equal(queries.at(-1)?.sql, "COMMIT");
});

test("CHAT-AC-15/16: DeepWiki completion persists verified references/usage and sync stales only old ready revisions", async () => {
  const id = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const oldRevision = "a".repeat(40);
  const currentRevision = "b".repeat(40);
  const now = new Date("2026-08-28T04:00:00.000Z");
  const queries: CapturedQuery[] = [];
  const baseRow = {
    id,
    project_id: projectId,
    workspace_id: workspaceId,
    revision: oldRevision,
    provider_id: "openai",
    prompt_version: "deepwiki-v1",
    client_request_id: null,
    created_at: now,
    updated_at: now,
  };
  const pool = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SET status = 'ready'")) {
        return { rows: [{
          ...baseRow,
          status: "ready",
          model: values?.[0],
          content: values?.[1],
          citations: JSON.parse(String(values?.[2])),
          input_tokens: values?.[3],
          output_tokens: values?.[4],
          manifest_hash: values?.[5],
          error_message: null,
          generated_at: now,
          stale_at: null,
        }] };
      }
      if (sql.includes("SET status = 'stale'")) {
        return { rows: [{
          ...baseRow,
          status: "stale",
          model: "gpt-example",
          content: "# Repository",
          citations: [],
          input_tokens: 12,
          output_tokens: 7,
          manifest_hash: "c".repeat(64),
          error_message: null,
          generated_at: now,
          stale_at: now,
        }] };
      }
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const store = new PgWorkflowStore(pool);

  const ready = await store.completeDeepWikiGeneration({
    id,
    model: "gpt-example",
    content: "# Repository",
    citations: [{
      path: "src/index.ts",
      startLine: 1,
      endLine: 2,
      sha256: "d".repeat(64),
      summary: "Public entry point",
    }],
    usage: { inputTokens: 12, outputTokens: 7 },
    manifestHash: "c".repeat(64),
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.generatedAt, now.toISOString());
  assert.deepEqual(ready.usage, { inputTokens: 12, outputTokens: 7 });
  assert.equal(ready.citations[0]?.path, "src/index.ts");
  assert.equal("workspaceId" in ready, false);

  const stale = await store.markDeepWikiGenerationsStale(projectId, currentRevision);
  assert.equal(stale[0]?.status, "stale");
  assert.equal(stale[0]?.staleAt, now.toISOString());
  const staleQuery = queries.find(({ sql }) => sql.includes("SET status = 'stale'"));
  assert.match(staleQuery?.sql ?? "", /status = 'ready' AND revision <> \$2/u);
  assert.deepEqual(staleQuery?.values, [projectId, currentRevision]);
});
