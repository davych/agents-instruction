import assert from "node:assert/strict";
import test from "node:test";

import type pg from "pg";

import { schemaSql } from "../src/db/schema.ts";
import { PgWorkflowStore } from "../src/db/store.ts";

test("workflow run migration adds a non-null empty artifact path map", () => {
  assert.match(
    schemaSql,
    /artifact_paths jsonb NOT NULL DEFAULT '\{\}'::jsonb/u
  );
  assert.match(
    schemaSql,
    /ALTER TABLE workflow_runs[\s\S]*ADD COLUMN IF NOT EXISTS artifact_paths jsonb NOT NULL DEFAULT '\{\}'::jsonb/u
  );
});

test("createRun persists the caller-generated run id and artifact path pins atomically", async () => {
  const projectId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const now = new Date();
  const artifactPaths = {
    "design-spec": "docs/ai-native/design/登录改版/design-spec.md",
    prd: "docs/ai-native/product/prd.md"
  };
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT id FROM projects")) return { rows: [{ id: projectId }] };
      if (sql.includes("INSERT INTO workflow_runs")) {
        return {
          rows: [{
            id: runId,
            project_id: projectId,
            title: "登录改版",
            objective: "调整登录体验",
            status: "active",
            artifact_paths: artifactPaths,
            created_at: now,
            updated_at: now
          }]
        };
      }
      return { rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } } as unknown as pg.Pool;
  const store = new PgWorkflowStore(pool);

  const run = await store.createRun(
    projectId,
    "登录改版",
    "调整登录体验",
    { runId, artifactPaths }
  );

  assert.equal(run.id, runId);
  assert.equal("artifactPaths" in run, false);
  const insert = queries.find((query) => query.sql.includes("INSERT INTO workflow_runs"));
  assert.match(insert?.sql ?? "", /artifact_paths/u);
  assert.equal(insert?.values?.[0], runId);
  assert.deepEqual(JSON.parse(String(insert?.values?.[4])), artifactPaths);
  assert.equal(queries.filter((query) => query.sql.includes("INSERT INTO phase_runs")).length, 6);
  assert.ok(queries.some((query) => query.sql === "COMMIT"));
});

test("getRun exposes pinned paths only through the internal RunBundle", async () => {
  const projectId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const now = new Date();
  const artifactPaths = {
    "design-spec": "docs/ai-native/design/任务-a1b2/design-spec.md"
  };
  const pool = {
    async query(sql: string) {
      if (sql.includes("FROM workflow_runs wr JOIN projects")) {
        return {
          rows: [{
            id: runId,
            project_id: projectId,
            title: "任务",
            objective: "目标",
            status: "active",
            artifact_paths: artifactPaths,
            created_at: now,
            updated_at: now,
            p_id: projectId,
            p_name: "Demo",
            p_summary: "Demo summary",
            p_root_path: "/tmp/demo",
            p_config_path: "/tmp/demo/ai-native.yaml",
            p_created_at: now,
            p_updated_at: now
          }]
        };
      }
      if (sql.includes("FROM phase_runs WHERE workflow_run_id")) return { rows: [] };
      return { rows: [] };
    }
  } as unknown as pg.Pool;
  const store = new PgWorkflowStore(pool);

  const bundle = await store.getRun(runId);
  assert.deepEqual(bundle.artifactPaths, artifactPaths);
  assert.equal("artifactPaths" in bundle.run, false);
});
