import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type pg from "pg";

import { PgWorkflowStore } from "../src/db/store.ts";

interface CapturedQuery {
  sql: string;
  values?: unknown[];
}

test("completed Agent Session Run rejects E2E manifest review before the file callback", async () => {
  const runId = randomUUID();
  const sessionId = randomUUID();
  const executionId = randomUUID();
  const queries: CapturedQuery[] = [];
  let operationCalled = false;
  const store = new PgWorkflowStore(poolWith(queries, async (sql) => {
    if (sql.includes("FROM workflow_runs wr")) {
      return { rows: [{ workflow_run_status: "completed", agent_session_id: sessionId }] };
    }
    return { rows: [] };
  }));

  await assert.rejects(
    () => store.commitVerificationE2eScriptReview(runId, async () => {
      operationCalled = true;
      return reviewChange(executionId);
    }),
    (error: unknown) => (
      (error as { code?: string }).code === "AGENT_SESSION_RUN_COMPLETED_IMMUTABLE"
      && (error as { details?: { sessionId?: string } }).details?.sessionId === sessionId
    ),
  );

  assert.equal(operationCalled, false, "manifest callback must run only after durable authorization");
  const authority = queries.find(({ sql }) => sql.includes("FROM workflow_runs wr"));
  assert.match(authority?.sql ?? "", /LEFT JOIN agent_session_runs/u);
  assert.match(authority?.sql ?? "", /FOR UPDATE OF wr/u);
  assert.equal(queries.some(({ sql }) => sql.includes("INSERT INTO execution_events")), false);
  assert.equal(queries.at(-2)?.sql, "ROLLBACK");
});

test("standalone completed Run preserves E2E review and event persistence", async () => {
  const runId = randomUUID();
  const executionId = randomUUID();
  const queries: CapturedQuery[] = [];
  let rollbackCalled = false;
  const store = new PgWorkflowStore(poolWith(queries, async (sql) => {
    if (sql.includes("FROM workflow_runs wr")) {
      return { rows: [{ workflow_run_status: "completed", agent_session_id: null }] };
    }
    if (sql.includes("FROM executions e")) return { rows: [{ id: executionId }] };
    if (sql.includes("MAX(sequence)")) return { rows: [{ next_sequence: "7" }] };
    return { rows: [] };
  }));

  const result = await store.commitVerificationE2eScriptReview(runId, async () => ({
    ...reviewChange(executionId),
    rollback: async () => { rollbackCalled = true; },
  }));

  assert.equal(result, "reviewed");
  assert.equal(rollbackCalled, false);
  const eventInsert = queries.find(({ sql }) => sql.includes("INSERT INTO execution_events"));
  assert.equal(eventInsert?.values?.[1], executionId);
  assert.equal(eventInsert?.values?.[2], 7);
  assert.equal(queries.at(-2)?.sql, "COMMIT");
});

test("E2E review restores the prior manifest when its DB event cannot persist", async () => {
  const runId = randomUUID();
  const executionId = randomUUID();
  const queries: CapturedQuery[] = [];
  let rollbackCalled = false;
  const store = new PgWorkflowStore(poolWith(queries, async (sql) => {
    if (sql.includes("FROM workflow_runs wr")) {
      return { rows: [{ workflow_run_status: "active", agent_session_id: randomUUID() }] };
    }
    if (sql.includes("FROM executions e")) return { rows: [{ id: executionId }] };
    if (sql.includes("MAX(sequence)")) return { rows: [{ next_sequence: 3 }] };
    if (sql.includes("INSERT INTO execution_events")) throw new Error("event insert failed");
    return { rows: [] };
  }));

  await assert.rejects(
    () => store.commitVerificationE2eScriptReview(runId, async () => ({
      ...reviewChange(executionId),
      rollback: async () => { rollbackCalled = true; },
    })),
    /event insert failed/u,
  );

  assert.equal(rollbackCalled, true);
  assert.equal(queries.at(-2)?.sql, "ROLLBACK");
});

function reviewChange(executionId: string) {
  return {
    result: "reviewed",
    executionId,
    payload: { decision: "approve" },
    rollback: async () => undefined,
  };
}

function poolWith(
  queries: CapturedQuery[],
  responder: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>,
): pg.Pool {
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return responder(sql, values);
    },
    release() {
      queries.push({ sql: "RELEASE" });
    },
  };
  return {
    async connect() {
      return client;
    },
  } as unknown as pg.Pool;
}
