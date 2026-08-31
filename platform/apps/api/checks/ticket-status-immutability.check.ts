import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type pg from "pg";

import { PgWorkflowStore } from "../src/db/store.ts";

interface CapturedQuery {
  sql: string;
  values?: unknown[];
}

test("completed Agent Session Run rejects Ticket status updates inside the store transaction", async () => {
  const runId = randomUUID();
  const ticketId = randomUUID();
  const sessionId = randomUUID();
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("SELECT status FROM workflow_runs")) {
      return { rows: [{ status: "completed" }] };
    }
    if (sql.includes("FROM agent_session_runs")) {
      return { rows: [{ session_id: sessionId }] };
    }
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  await assert.rejects(
    () => store.updateTicketStatus(runId, ticketId, "done"),
    (error: unknown) => (
      (error as { code?: string }).code === "AGENT_SESSION_RUN_COMPLETED_IMMUTABLE"
      && (error as { details?: unknown }).details !== undefined
      && (error as { details?: { sessionId?: string } }).details?.sessionId === sessionId
    ),
  );

  const runLock = queries.find(({ sql }) => sql.includes("SELECT status FROM workflow_runs"));
  assert.match(runLock?.sql ?? "", /FOR UPDATE/u);
  const associationLock = queries.find(({ sql }) => sql.includes("FROM agent_session_runs"));
  assert.match(associationLock?.sql ?? "", /FOR KEY SHARE/u);
  assert.equal(queries.some(({ sql }) => sql.includes("UPDATE tickets")), false);
  assert.equal(queries.at(-2)?.sql, "ROLLBACK");
});

test("completed standalone Run still permits Ticket status updates", async () => {
  const runId = randomUUID();
  const ticketId = randomUUID();
  const now = new Date("2026-08-29T12:00:00.000Z");
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("SELECT status FROM workflow_runs")) {
      return { rows: [{ status: "completed" }] };
    }
    if (sql.includes("FROM agent_session_runs")) return { rows: [] };
    if (sql.includes("UPDATE tickets")) {
      return { rows: [{
        id: ticketId,
        workflow_run_id: runId,
        source_artifact_id: null,
        story_key: "US-001",
        title: "Standalone maintenance",
        category: "maintenance",
        source_path: "user-stories/US-001/story.md",
        status: "done",
        acceptance_criteria_count: 1,
        source_review_status: "approved",
        created_at: now,
        updated_at: now,
      }] };
    }
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  const updated = await store.updateTicketStatus(runId, ticketId, "done");

  assert.equal(updated.status, "done");
  assert.equal(updated.id, ticketId);
  assert.ok(queries.some(({ sql }) => sql.includes("UPDATE tickets")));
  assert.equal(queries.at(-2)?.sql, "COMMIT");
});

test("completed Agent Session Run rejects lazy Ticket synchronization", async () => {
  const runId = randomUUID();
  const sessionId = randomUUID();
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("SELECT status FROM workflow_runs")) {
      return { rows: [{ status: "completed" }] };
    }
    if (sql.includes("FROM agent_session_runs")) {
      return { rows: [{ session_id: sessionId }] };
    }
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  await assert.rejects(
    () => store.syncTickets(runId, randomUUID(), [ticketRecord()]),
    (error: unknown) => (
      (error as { code?: string }).code === "AGENT_SESSION_RUN_COMPLETED_IMMUTABLE"
      && (error as { details?: { sessionId?: string } }).details?.sessionId === sessionId
    ),
  );

  assert.equal(queries.some(({ sql }) => sql.includes("INSERT INTO tickets")), false);
  assert.equal(queries.some(({ sql }) => sql.includes("UPDATE tickets")), false);
  assert.equal(queries.at(-2)?.sql, "ROLLBACK");
});

test("completed standalone Run keeps lazy Ticket synchronization compatible", async () => {
  const runId = randomUUID();
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("SELECT status FROM workflow_runs")) {
      return { rows: [{ status: "completed" }] };
    }
    if (sql.includes("FROM agent_session_runs")) return { rows: [] };
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  await store.syncTickets(runId, randomUUID(), [ticketRecord()]);

  assert.ok(queries.some(({ sql }) => sql.includes("INSERT INTO tickets")));
  assert.ok(queries.some(({ sql }) => sql.includes("UPDATE tickets")));
  assert.equal(queries.at(-2)?.sql, "COMMIT");
});

function ticketRecord() {
  return {
    storyKey: "US-001",
    title: "Preserve completed Session history",
    category: "audit",
    sourcePath: "user-stories/US-001/story.md",
    content: "# US-001: Preserve completed Session history",
    contentHash: "c".repeat(64),
    acceptanceCriteriaCount: 1,
    position: 1,
  };
}

function mockClient(
  queries: CapturedQuery[],
  responder: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>,
) {
  return {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return responder(sql, values);
    },
    release() {
      queries.push({ sql: "RELEASE" });
    },
  };
}

function mockPool(client: ReturnType<typeof mockClient>): pg.Pool {
  return {
    async connect() {
      return client;
    },
    query: client.query.bind(client),
  } as unknown as pg.Pool;
}
