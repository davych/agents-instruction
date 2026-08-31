import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type pg from "pg";

import { PgWorkflowStore } from "../src/db/store.ts";

test("AC-CLARITY-017/018: an approved legacy phase can record a decision and invalidate downstream phases", async () => {
  const runId = randomUUID();
  const phaseRunId = randomUUID();
  const artifactId = randomUUID();
  const reviewId = randomUUID();
  const now = new Date("2026-08-20T08:00:00.000Z");
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("FROM phase_runs pr")) {
        return { rows: [{ id: phaseRunId, phase_id: "discovery", position: 0, status: "approved" }] };
      }
      if (sql.includes("SELECT a.id, a.artifact_key")) {
        return { rows: [{ id: artifactId, artifact_key: "prd", created_at: now, revision: 1 }] };
      }
      if (sql.includes("INSERT INTO reviews")) {
        return { rows: [{
          id: reviewId,
          phase_run_id: phaseRunId,
          decision: "request_changes",
          comment: "Captured a product decision.",
          reviewed_artifact_ids: [artifactId],
          created_at: now,
        }] };
      }
      if (sql.includes("SELECT id, phase_id, status") && sql.includes("position >")) {
        return { rows: [
          { id: randomUUID(), phase_id: "design", status: "approved" },
          { id: randomUUID(), phase_id: "architecture", status: "awaiting_review" },
        ] };
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

  const review = await store.reviewPhase(
    runId,
    "discovery",
    "request_changes",
    "Captured a product decision.",
    [artifactId],
    [],
    undefined,
    ["awaiting_review", "approved", "changes_requested"],
  );

  assert.equal(review.id, reviewId);
  assert.ok(queries.some(({ sql }) => sql.includes("SET status = 'pending'") && sql.includes("position > $2")));
  assert.deepEqual(
    queries.find(({ sql }) => sql.includes("SET status = 'pending'") && sql.includes("position > $2"))?.values,
    [runId, 0],
  );
  assert.equal(queries.at(-1)?.sql, "COMMIT");
});
