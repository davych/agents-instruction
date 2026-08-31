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
    "updateIdleAgentSessionProvider",
    "archiveAgentSession",
    "bindAgentSessionRepository",
    "createAgentSandbox",
    "transitionAgentSandbox",
    "beginAgentTurn",
    "completeAgentTurn",
    "appendAgentEvent",
    "createAgentToolCall",
    "updateAgentToolCall",
    "createDeepWikiGeneration",
    "claimDeepWikiGeneration",
    "transitionDeepWikiGeneration",
    "completeDeepWikiGeneration",
    "failDeepWikiGeneration",
    "getLatestPublishedDeepWikiGeneration",
    "markDeepWikiGenerationsStale",
    "projectSourceKindForAgentSession",
  ]) {
    assert.equal(typeof prototype[method], "function", method);
  }
});

test("direct Run continuation row-locks and persists the selected Session Provider", async () => {
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const queries: CapturedQuery[] = [];
  const session = {
    id: sessionId,
    status: "active",
    turn_state: "idle",
    current_provider_id: "ollama",
  };
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql === "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE") {
        return { rows: [session] };
      }
      if (sql === "SELECT status FROM workflow_runs WHERE id = $1 FOR UPDATE") {
        return { rows: [{ status: "active" }] };
      }
      if (sql.includes("FROM agent_session_runs")) {
        return { rows: [{ session_id: sessionId }] };
      }
      if (sql.includes("SET current_provider_id = $1")) {
        session.current_provider_id = String(values?.[0]);
        return { rows: [{ id: sessionId }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgWorkflowStore({
    async connect() { return client; },
  } as unknown as pg.Pool);

  await store.updateIdleAgentSessionProvider(sessionId, runId, "openai");

  assert.equal(session.current_provider_id, "openai");
  assert.equal(queries.length, 6);
  assert.equal(queries[0]!.sql, "BEGIN");
  assert.equal(queries[1]!.sql, "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE");
  assert.match(queries[2]!.sql, /SELECT status FROM workflow_runs[\s\S]*FOR UPDATE/u);
  assert.deepEqual(queries[2]!.values, [runId]);
  assert.match(queries[3]!.sql, /FROM agent_session_runs[\s\S]*FOR UPDATE/u);
  assert.deepEqual(queries[3]!.values, [runId]);
  assert.equal(queries[5]!.sql, "COMMIT");
  assert.match(queries[4]!.sql, /WHERE id = \$2 AND status = 'active' AND turn_state = 'idle'/u);
  assert.deepEqual(queries[4]!.values, ["openai", sessionId]);
});

test("direct Run Provider persistence rejects a completed Session Run inside the transaction", async () => {
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const queries: CapturedQuery[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql === "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE") {
        return { rows: [{ id: sessionId, status: "archived", turn_state: "running" }] };
      }
      if (sql === "SELECT status FROM workflow_runs WHERE id = $1 FOR UPDATE") {
        return { rows: [{ status: "completed" }] };
      }
      if (sql.includes("FROM agent_session_runs")) {
        return { rows: [{ session_id: sessionId }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgWorkflowStore({
    async connect() { return client; },
  } as unknown as pg.Pool);

  await assert.rejects(
    () => store.updateIdleAgentSessionProvider(sessionId, runId, "openai"),
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

  assert.match(
    queries.find(({ sql }) => sql.includes("SELECT status FROM workflow_runs"))?.sql ?? "",
    /FOR UPDATE/u,
  );
  assert.match(
    queries.find(({ sql }) => sql.includes("FROM agent_session_runs"))?.sql ?? "",
    /FOR UPDATE/u,
  );
  assert.equal(queries.some(({ sql }) => sql.includes("SET current_provider_id")), false);
  assert.equal(queries.at(-1)?.sql, "ROLLBACK");
});

test("direct Run Provider persistence keeps standalone and other-Session ownership errors", async (context) => {
  for (const ownership of ["standalone", "other-session"] as const) {
    await context.test(ownership, async () => {
      const sessionId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const otherSessionId = crypto.randomUUID();
      const queries: CapturedQuery[] = [];
      const client = {
        async query(sql: string, values?: unknown[]) {
          queries.push({ sql, values });
          if (sql === "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE") {
            return { rows: [{ id: sessionId, status: "active", turn_state: "idle" }] };
          }
          if (sql === "SELECT status FROM workflow_runs WHERE id = $1 FOR UPDATE") {
            return { rows: [{ status: "active" }] };
          }
          if (sql.includes("FROM agent_session_runs")) {
            return { rows: ownership === "standalone" ? [] : [{ session_id: otherSessionId }] };
          }
          return { rows: [] };
        },
        release() {},
      };
      const store = new PgWorkflowStore({
        async connect() { return client; },
      } as unknown as pg.Pool);

      await assert.rejects(
        () => store.updateIdleAgentSessionProvider(sessionId, runId, "openai"),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "AGENT_SESSION_RUN_NOT_FOUND");
          assert.equal((error as { statusCode?: number }).statusCode, 404);
          return true;
        },
      );
      assert.equal(queries.some(({ sql }) => sql.includes("SET current_provider_id")), false);
      assert.equal(queries.at(-1)?.sql, "ROLLBACK");
    });
  }
});

test("Agent Session lists expose only active rows for global and Project-scoped reads", async () => {
  const projectId = crypto.randomUUID();
  const queries: CapturedQuery[] = [];
  const store = new PgWorkflowStore({
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as pg.Pool);

  await store.listAgentSessions();
  await store.listAgentSessions({ projectId });

  assert.equal(queries.length, 2);
  assert.match(queries[0]!.sql, /FROM agent_sessions WHERE status = 'active'/u);
  assert.deepEqual(queries[0]!.values, []);
  assert.match(queries[1]!.sql, /WHERE sr\.project_id = \$1 AND s\.status = 'active'/u);
  assert.deepEqual(queries[1]!.values, [projectId]);
  for (const query of queries) assert.match(query.sql, /ORDER BY (?:s\.)?updated_at DESC/u);
});

test("Agent Session active lists drop a row archived between selection and summary hydration", async () => {
  const sessionId = crypto.randomUUID();
  const now = new Date("2026-08-28T08:15:00.000Z");
  const baseRow = {
    id: sessionId,
    title: "Archived concurrently",
    status: "active",
    turn_state: "idle",
    current_provider_id: "openai",
    last_message_sequence: 0,
    last_event_sequence: 0,
    created_at: now,
    updated_at: now,
  };
  const store = new PgWorkflowStore({
    async query(sql: string) {
      if (sql.includes("WHERE status = 'active'")) return { rows: [baseRow] };
      if (sql === "SELECT * FROM agent_sessions WHERE id = $1") {
        return { rows: [{ ...baseRow, status: "archived" }] };
      }
      return { rows: [] };
    },
  } as unknown as pg.Pool);

  assert.deepEqual(await store.listAgentSessions(), []);
});

test("Agent Session creation replays one client-owned UUID only for the same effective request", async () => {
  const sessionId = crypto.randomUUID();
  const originalProjectId = crypto.randomUUID();
  const otherProjectId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const revision = "f".repeat(40);
  const now = new Date("2026-08-28T08:20:00.000Z");
  const sessionRow = {
    id: sessionId,
    title: "Backend Agent Session",
    status: "active",
    turn_state: "idle",
    current_provider_id: "openai",
    last_message_sequence: 0,
    last_event_sequence: 1,
    created_at: now,
    updated_at: now,
  };
  const repositoryRow = {
    session_id: sessionId,
    project_id: originalProjectId,
    workspace_id: workspaceId,
    repo_alias: "backend",
    access_mode: "write",
    source_revision: revision,
    created_at: now,
  };
  const makeStore = () => {
    const queries: CapturedQuery[] = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        queries.push({ sql, values });
        if (sql.includes("SELECT id FROM projects") && sql.includes("FOR UPDATE")) {
          return { rows: [{ id: values?.[0] }] };
        }
        if (sql.includes("INSERT INTO project_agent_settings")) return { rows: [] };
        if (sql.includes("SELECT * FROM project_agent_settings")) {
          return { rows: [{
            project_id: values?.[0],
            repo_alias: "backend",
            default_provider_id: "openai",
            sandbox_blueprint_id: "default",
            sandbox_blueprint_version: "1",
            enabled_mcp_server_ids: [],
            version: 1,
            created_at: now,
            updated_at: now,
          }] };
        }
        if (sql === "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE") {
          return { rows: [sessionRow] };
        }
        if (sql === "SELECT * FROM agent_sessions WHERE id = $1") return { rows: [sessionRow] };
        if (sql.includes("FROM agent_session_repositories")) return { rows: [repositoryRow] };
        if (sql.includes("FROM agent_sandboxes")) return { rows: [] };
        return { rows: [] };
      },
      release() {},
    };
    return {
      queries,
      store: new PgWorkflowStore({ async connect() { return client; } } as unknown as pg.Pool),
    };
  };
  const request = {
    id: sessionId,
    title: "Backend Agent Session",
    providerId: "openai" as const,
    primaryRepository: {
      projectId: originalProjectId,
      workspaceId,
      sourceRevision: revision,
    },
  };

  const matching = makeStore();
  const replay = await matching.store.createAgentSession(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.session.id, sessionId);
  assert.equal(replay.session.repositories[0]?.projectId, originalProjectId);
  assert.equal(matching.queries.at(-1)?.sql, "COMMIT");
  assert.equal(
    matching.queries.some(({ sql }) => sql.includes("INSERT INTO agent_sessions")),
    false,
    "an exact replay must not create another row",
  );
  assert.equal(
    matching.queries.some(({ sql }) => sql.includes("FROM managed_workspaces mw")),
    false,
    "an exact replay remains valid after the Project advances to another Workspace",
  );

  const differentProject = makeStore();
  await assert.rejects(
    differentProject.store.createAgentSession({
      ...request,
      primaryRepository: { ...request.primaryRepository, projectId: otherProjectId },
    }),
    (error: unknown) => (
      (error as { code?: string }).code === "AGENT_SESSION_IDEMPOTENCY_CONFLICT"
    ),
  );
  assert.equal(differentProject.queries.at(-1)?.sql, "ROLLBACK");

  const differentInput = makeStore();
  await assert.rejects(
    differentInput.store.createAgentSession({ ...request, title: "Different Session" }),
    (error: unknown) => (
      (error as { code?: string }).code === "AGENT_SESSION_IDEMPOTENCY_CONFLICT"
    ),
  );
  assert.equal(differentInput.queries.at(-1)?.sql, "ROLLBACK");
});

test("Agent Session archive is locked, server-persisted, and idempotent without touching related rows", async () => {
  const sessionId = crypto.randomUUID();
  const now = new Date("2026-08-28T08:30:00.000Z");
  const queries: CapturedQuery[] = [];
  const session: Record<string, unknown> = {
    id: sessionId,
    title: "Archive me",
    status: "active",
    turn_state: "idle",
    current_provider_id: "openai",
    last_message_sequence: 4,
    last_event_sequence: 7,
    created_at: now,
    updated_at: now,
  };
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT * FROM agent_sessions") && sql.includes("FOR UPDATE")) {
        return { rows: [session] };
      }
      if (sql.includes("UPDATE agent_sessions") && sql.includes("status = 'archived'")) {
        if (session.status !== "active" || session.turn_state !== "idle") return { rows: [] };
        session.status = "archived";
        return { rows: [session] };
      }
      if (sql === "SELECT * FROM agent_sessions WHERE id = $1") return { rows: [session] };
      if (sql.includes("FROM agent_session_repositories")) return { rows: [] };
      if (sql.includes("FROM agent_sandboxes")) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgWorkflowStore({
    connect: async () => client,
  } as unknown as pg.Pool);

  const archived = await store.archiveAgentSession(sessionId);
  const replayed = await store.archiveAgentSession(sessionId);

  assert.equal(archived.status, "archived");
  assert.deepEqual(replayed, archived);
  assert.equal(
    queries.filter(({ sql }) => sql.includes("UPDATE agent_sessions") && sql.includes("status = 'archived'")).length,
    1,
  );
  assert.equal(queries.filter(({ sql }) => sql === "COMMIT").length, 2);
  assert.equal(queries.some(({ sql }) => /\bDELETE\b/iu.test(sql)), false);
  const mutations = queries.filter(({ sql }) => /^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql));
  assert.equal(mutations.length, 1);
  assert.match(mutations[0]!.sql, /^\s*UPDATE agent_sessions\b/iu);
  assert.match(mutations[0]!.sql, /status = 'active' AND turn_state = 'idle'/u);
  assert.ok(queries.some(({ sql }) => /agent_sessions[\s\S]*FOR UPDATE/u.test(sql)));
});

test("Agent Session archive rejects every non-idle active turn without mutation", async (context) => {
  for (const turnState of ["running", "waiting_human", "interrupted"] as const) {
    await context.test(turnState, async () => {
      const sessionId = crypto.randomUUID();
      const queries: CapturedQuery[] = [];
      const client = {
        async query(sql: string, values?: unknown[]) {
          queries.push({ sql, values });
          if (sql.includes("SELECT * FROM agent_sessions") && sql.includes("FOR UPDATE")) {
            return { rows: [{ id: sessionId, status: "active", turn_state: turnState }] };
          }
          return { rows: [] };
        },
        release() {},
      };
      const store = new PgWorkflowStore({
        connect: async () => client,
      } as unknown as pg.Pool);

      await assert.rejects(
        () => store.archiveAgentSession(sessionId),
        (error: unknown) => (
          (error as { statusCode?: number; code?: string }).statusCode === 409
          && (error as { code?: string }).code === "AGENT_SESSION_ARCHIVE_BUSY"
        ),
      );
      assert.equal(queries.some(({ sql }) => /UPDATE agent_sessions/iu.test(sql)), false);
      assert.equal(queries.some(({ sql }) => /\bDELETE\b/iu.test(sql)), false);
      assert.equal(queries.at(-1)?.sql, "ROLLBACK");
    });
  }
});

test("Agent Session archive locks and rejects an associated active SDLC Run", async () => {
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const queries: CapturedQuery[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT * FROM agent_sessions") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: sessionId, status: "active", turn_state: "idle" }] };
      }
      if (sql.includes("FROM agent_session_runs asr")) return { rows: [{ id: runId }] };
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgWorkflowStore({
    async connect() { return client; },
  } as unknown as pg.Pool);

  await assert.rejects(
    () => store.archiveAgentSession(sessionId),
    (error: unknown) => (
      (error as { statusCode?: number; code?: string }).statusCode === 409
      && (error as { code?: string }).code === "AGENT_SESSION_ARCHIVE_ACTIVE_RUN"
    ),
  );
  assert.equal(queries.at(-1)?.sql, "ROLLBACK");
  assert.equal(
    queries.some(({ sql }) => sql.includes("UPDATE agent_sessions") && sql.includes("status = 'archived'")),
    false,
  );
  const activeRunQuery = queries.find(({ sql }) => sql.includes("FROM agent_session_runs asr"));
  assert.ok(activeRunQuery);
  assert.match(activeRunQuery.sql, /wr\.status = 'active'/u);
  assert.match(activeRunQuery.sql, /FOR UPDATE OF wr/u);
  assert.deepEqual(activeRunQuery.values, [sessionId]);
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

test("DeepWiki creation reclaims a stale same-project job before checking the active-generation gate", async () => {
  const projectId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const generationId = crypto.randomUUID();
  const revision = "e".repeat(40);
  const now = new Date("2026-08-28T03:30:00.000Z");
  const queries: CapturedQuery[] = [];
  let staleStatus = "generating";
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT id FROM projects") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: projectId }] };
      }
      if (sql.startsWith("UPDATE deepwiki_generations")) {
        staleStatus = "failed";
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM managed_workspaces mw")) return { rows: [{ exists: true }] };
      if (sql.includes("SELECT * FROM deepwiki_generations") && sql.includes("FOR UPDATE")) {
        return { rows: staleStatus === "failed" ? [] : [{ id: "stale-job" }] };
      }
      if (sql.includes("INSERT INTO deepwiki_generations")) {
        return { rows: [{
          id: generationId,
          project_id: projectId,
          workspace_id: workspaceId,
          revision,
          provider_id: "openai",
          model: null,
          prompt_version: "deepwiki-v2",
          status: "queued",
          manifest_hash: null,
          content: null,
          citations: [],
          input_tokens: null,
          output_tokens: null,
          error_message: null,
          client_request_id: null,
          generated_at: null,
          stale_at: null,
          created_at: now,
          updated_at: now,
        }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgWorkflowStore({
    async connect() { return client; },
  } as unknown as pg.Pool);

  const created = await store.createDeepWikiGeneration({
    projectId,
    workspaceId,
    revision,
    providerId: "openai",
    promptVersion: "deepwiki-v2",
  });

  assert.equal(created.id, generationId);
  assert.equal(created.status, "queued");
  assert.equal(staleStatus, "failed");
  const reclaimIndex = queries.findIndex(({ sql }) => (
    sql.startsWith("UPDATE deepwiki_generations") && sql.includes("make_interval")
  ));
  const activeGateIndex = queries.findIndex(({ sql }) => (
    sql.includes("SELECT * FROM deepwiki_generations") && sql.includes("FOR UPDATE")
  ));
  const insertIndex = queries.findIndex(({ sql }) => sql.includes("INSERT INTO deepwiki_generations"));
  assert.ok(reclaimIndex > 0 && activeGateIndex > reclaimIndex && insertIndex > activeGateIndex);
  assert.match(queries[reclaimIndex]!.sql, /WHERE project_id = \$2/u);
  assert.match(queries[reclaimIndex]!.sql, /updated_at < now\(\) - make_interval/u);
  assert.deepEqual(queries[reclaimIndex]!.values?.slice(1), [projectId, 600]);
  assert.equal(queries.at(-1)?.sql, "COMMIT");
});

test("CHAT-AC-15/16: DeepWiki completion atomically publishes current work and stales a superseded revision", async () => {
  const currentId = crypto.randomUUID();
  const oldId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const currentWorkspaceId = crypto.randomUUID();
  const oldWorkspaceId = crypto.randomUUID();
  const oldRevision = "a".repeat(40);
  const currentRevision = "b".repeat(40);
  const now = new Date("2026-08-28T04:00:00.000Z");
  const queries: CapturedQuery[] = [];
  const baseRow = (id: string, workspaceId: string, revision: string) => ({
    id,
    project_id: projectId,
    workspace_id: workspaceId,
    revision,
    provider_id: "openai",
    prompt_version: "deepwiki-v1",
    client_request_id: null,
    created_at: now,
    updated_at: now,
  });
  const generations = new Map([
    [currentId, baseRow(currentId, currentWorkspaceId, currentRevision)],
    [oldId, baseRow(oldId, oldWorkspaceId, oldRevision)],
  ]);
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT project_id, workspace_id, revision")) {
        return { rows: [generations.get(String(values?.[0]))].filter(Boolean) };
      }
      if (sql.includes("SELECT active_revision FROM projects")) {
        return { rows: [{ active_revision: currentRevision }] };
      }
      if (sql.includes("FROM managed_workspaces")) {
        const workspaceId = String(values?.[0]);
        const current = workspaceId === currentWorkspaceId;
        return { rows: [{
          project_id: projectId,
          revision: current ? currentRevision : oldRevision,
          state: "ready",
          active: current,
        }] };
      }
      if (sql.includes("SET status = $1")) {
        const status = String(values?.[0]);
        const row = generations.get(String(values?.[7]))!;
        return { rows: [{
          ...row,
          status,
          model: values?.[1],
          content: values?.[2],
          citations: JSON.parse(String(values?.[3])),
          input_tokens: values?.[4],
          output_tokens: values?.[5],
          manifest_hash: values?.[6],
          error_message: null,
          generated_at: now,
          stale_at: status === "stale" ? now : null,
        }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SET status = 'stale'")) {
        return { rows: [{
          ...generations.get(oldId),
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

  const completion = {
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
  };
  const ready = await store.completeDeepWikiGeneration({ id: currentId, ...completion });
  assert.equal(ready.status, "ready");
  assert.equal(ready.generatedAt, now.toISOString());
  assert.deepEqual(ready.usage, { inputTokens: 12, outputTokens: 7 });
  assert.equal(ready.citations[0]?.path, "src/index.ts");
  assert.equal("workspaceId" in ready, false);

  const completedAfterSync = await store.completeDeepWikiGeneration({ id: oldId, ...completion });
  assert.equal(completedAfterSync.status, "stale");
  assert.equal(completedAfterSync.staleAt, now.toISOString());
  assert.equal(
    queries.filter(({ sql }) => sql.includes("SELECT active_revision") && sql.includes("FOR UPDATE")).length,
    2,
  );
  assert.equal(queries.filter(({ sql }) => sql === "COMMIT").length, 2);

  const stale = await store.markDeepWikiGenerationsStale(projectId, currentRevision);
  assert.equal(stale[0]?.status, "stale");
  assert.equal(stale[0]?.staleAt, now.toISOString());
  const staleQuery = queries.find(({ sql }) => sql.includes("SET status = 'stale'"));
  assert.match(staleQuery?.sql ?? "", /status = 'ready' AND revision <> \$2/u);
  assert.deepEqual(staleQuery?.values, [projectId, currentRevision]);
});

test("DeepWiki queued work has exactly one durable scanning claimant", async () => {
  const id = crypto.randomUUID();
  const now = new Date("2026-08-28T05:00:00.000Z");
  const queries: CapturedQuery[] = [];
  let unclaimed = true;
  const row = {
    id,
    project_id: crypto.randomUUID(),
    workspace_id: crypto.randomUUID(),
    revision: "a".repeat(40),
    provider_id: "openai",
    model: null,
    prompt_version: "deepwiki-v2",
    status: "scanning",
    manifest_hash: null,
    content: null,
    citations: [],
    input_tokens: null,
    output_tokens: null,
    error_message: null,
    client_request_id: null,
    generated_at: null,
    stale_at: null,
    created_at: now,
    updated_at: now,
  };
  const store = new PgWorkflowStore({
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (!unclaimed) return { rows: [] };
      unclaimed = false;
      return { rows: [row] };
    },
  } as unknown as pg.Pool);

  assert.equal((await store.claimDeepWikiGeneration(id))?.status, "scanning");
  assert.equal(await store.claimDeepWikiGeneration(id), null);
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.match(query.sql, /SET status = 'scanning'/u);
    assert.match(query.sql, /WHERE id = \$1 AND status = 'queued'/u);
    assert.deepEqual(query.values, [id]);
  }
});

test("DeepWiki latest polling finalizes an orphan after the conservative stale window", async () => {
  const projectId = crypto.randomUUID();
  const generationId = crypto.randomUUID();
  const now = new Date("2026-08-28T05:30:00.000Z");
  const queries: CapturedQuery[] = [];
  let status = "generating";
  let errorMessage: string | null = null;
  let generatedAt: Date | null = null;
  const store = new PgWorkflowStore({
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.startsWith("UPDATE deepwiki_generations")) {
        status = "failed";
        errorMessage = String(values?.[0]);
        generatedAt = now;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT * FROM deepwiki_generations")) {
        return { rows: [{
          id: generationId,
          project_id: projectId,
          workspace_id: crypto.randomUUID(),
          revision: "a".repeat(40),
          provider_id: "lmstudio",
          model: null,
          prompt_version: "deepwiki-v2",
          status,
          manifest_hash: null,
          content: null,
          citations: [],
          input_tokens: null,
          output_tokens: null,
          error_message: errorMessage,
          client_request_id: null,
          generated_at: generatedAt,
          stale_at: null,
          created_at: now,
          updated_at: now,
        }] };
      }
      return { rows: [] };
    },
  } as unknown as pg.Pool);

  const generation = await store.getLatestDeepWikiGeneration(projectId);

  assert.equal(generation?.status, "failed");
  assert.match(generation?.errorMessage ?? "", /超过安全执行窗口/u);
  assert.equal(queries.length, 2);
  assert.match(queries[0]!.sql, /WHERE project_id = \$2/u);
  assert.match(
    queries[0]!.sql,
    /status IN \('queued', 'scanning', 'generating', 'validating'\)/u,
  );
  assert.match(queries[0]!.sql, /updated_at < now\(\) - make_interval/u);
  assert.deepEqual(queries[0]!.values?.slice(1), [projectId, 600]);
  assert.match(queries[1]!.sql, /ORDER BY created_at DESC, id DESC/u);
  assert.deepEqual(queries[1]!.values, [projectId]);
});

test("DeepWiki published lookup keeps current ready or previously-ready stale content ahead of never-current results", async () => {
  const projectId = crypto.randomUUID();
  const queries: CapturedQuery[] = [];
  const store = new PgWorkflowStore({
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as pg.Pool);

  assert.equal(await store.getLatestPublishedDeepWikiGeneration(projectId), null);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.sql, /JOIN projects p ON p\.id = dg\.project_id/u);
  assert.match(
    queries[0]!.sql,
    /ORDER BY \(dg\.status = 'ready' AND dg\.revision = p\.active_revision\) DESC/u,
  );
  assert.match(
    queries[0]!.sql,
    /dg\.status = 'stale'[\s\S]*dg\.stale_at IS DISTINCT FROM dg\.generated_at/u,
  );
  assert.match(queries[0]!.sql, /dg\.stale_at DESC NULLS LAST/u);
  assert.match(queries[0]!.sql, /dg\.generated_at DESC/u);
  assert.deepEqual(queries[0]!.values, [projectId]);
});
