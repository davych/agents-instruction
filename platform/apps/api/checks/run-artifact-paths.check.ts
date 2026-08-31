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

test("Agent Run mapping commits in the same transaction as its Run and six phases", async () => {
  const projectId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const triggerMessageId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const revision = "a".repeat(40);
  const now = new Date();
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql === "SELECT id FROM projects WHERE id = $1 FOR UPDATE") {
        return { rows: [{ id: projectId }] };
      }
      if (sql.includes("SELECT source_kind, repository_state")) {
        return {
          rows: [{
            source_kind: "remote_git",
            repository_state: "ready",
            active_revision: revision,
            definition_version: "control-v1",
          }],
        };
      }
      if (sql.includes("FROM agent_sessions s")) return { rows: [{ id: sessionId }] };
      if (sql.includes("FROM agent_messages") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: triggerMessageId }] };
      }
      if (sql.includes("SELECT workflow_run_id FROM agent_session_runs")) return { rows: [] };
      if (sql.includes("FROM managed_workspaces") && sql.includes("purpose IN")) {
        return { rows: [{ id: workspaceId, revision }] };
      }
      if (sql.includes("UPDATE managed_workspaces") || sql.includes("UPDATE agent_sandboxes")) {
        return { rows: [{ id: workspaceId }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO workflow_runs")) {
        return {
          rows: [{
            id: runId,
            project_id: projectId,
            title: "Atomic Agent Run",
            objective: "Persist all ownership in one commit",
            status: "active",
            artifact_paths: {},
            workspace_id: workspaceId,
            base_revision: revision,
            definition_version: "control-v1",
            created_at: now,
            updated_at: now,
          }],
        };
      }
      return { rows: [], rowCount: sql.includes("INSERT INTO agent_session_runs") ? 1 : 0 };
    },
    release() {},
  };
  const store = new PgWorkflowStore({
    async connect() {
      return client;
    },
  } as unknown as pg.Pool);

  const run = await store.createRun(projectId, "Atomic Agent Run", "Persist all ownership in one commit", {
    runId,
    artifactPaths: {},
    workspaceId,
    baseRevision: revision,
    definitionVersion: "control-v1",
    agentSessionRun: { sessionId, triggerMessageId },
  });

  assert.equal(run.id, runId);
  const begin = queries.findIndex(({ sql }) => sql === "BEGIN");
  const runInsert = queries.findIndex(({ sql }) => sql.includes("INSERT INTO workflow_runs"));
  const phaseInserts = queries
    .map(({ sql }, index) => sql.includes("INSERT INTO phase_runs") ? index : -1)
    .filter((index) => index >= 0);
  const mappingInsert = queries.findIndex(({ sql }) => sql.includes("INSERT INTO agent_session_runs"));
  const workspaceBusy = queries.findIndex(({ sql }) => sql.includes("UPDATE managed_workspaces"));
  const sandboxBusy = queries.findIndex(({ sql }) => sql.includes("UPDATE agent_sandboxes"));
  const commit = queries.findIndex(({ sql }) => sql === "COMMIT");
  assert.ok(begin >= 0 && begin < runInsert);
  assert.equal(phaseInserts.length, 6);
  assert.ok(runInsert < workspaceBusy && workspaceBusy < sandboxBusy);
  assert.ok(sandboxBusy < phaseInserts[0]!);
  assert.ok(phaseInserts.every((index) => runInsert < index && index < mappingInsert));
  assert.ok(mappingInsert < commit, "mapping must be durable before the only COMMIT");
  assert.deepEqual(queries[mappingInsert]?.values, [sessionId, triggerMessageId, runId]);
  assert.equal(queries.filter(({ sql }) => sql === "BEGIN").length, 1);
  assert.equal(queries.filter(({ sql }) => sql === "COMMIT").length, 1);
});

test("createRun marks a COMMIT acknowledgement failure as outcome-unknown", async () => {
  const projectId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const now = new Date();
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql === "SELECT id FROM projects WHERE id = $1 FOR UPDATE") {
        return { rows: [{ id: projectId }] };
      }
      if (sql.includes("INSERT INTO workflow_runs")) {
        return {
          rows: [{
            id: runId,
            project_id: projectId,
            title: "Unknown COMMIT",
            objective: "Preserve state",
            status: "active",
            artifact_paths: {},
            created_at: now,
            updated_at: now,
          }],
        };
      }
      if (sql === "COMMIT") throw new Error("socket closed");
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgWorkflowStore({
    async connect() {
      return client;
    },
  } as unknown as pg.Pool);

  await assert.rejects(
    () => store.createRun(projectId, "Unknown COMMIT", "Preserve state", {
      runId,
      artifactPaths: {},
    }),
    (error: unknown) => (
      (error as { code?: string; details?: { runId?: string } }).code
        === "RUN_COMMIT_OUTCOME_UNKNOWN"
      && (error as { details?: { runId?: string } }).details?.runId === runId
    ),
  );
  assert.ok(statements.includes("COMMIT"));
  assert.ok(statements.includes("ROLLBACK"), "rollback is best-effort after an unknown COMMIT result");
});

test("createRun validates its mapped return value before sending COMMIT", async () => {
  const projectId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql === "SELECT id FROM projects WHERE id = $1 FOR UPDATE") {
        return { rows: [{ id: projectId }] };
      }
      if (sql.includes("INSERT INTO workflow_runs")) {
        return {
          rows: [{
            id: runId,
            project_id: projectId,
            title: "Invalid mapped row",
            objective: "Validate before commit",
            status: "active",
            artifact_paths: {},
            created_at: "not-a-date",
            updated_at: "not-a-date",
          }],
        };
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

  await assert.rejects(
    () => store.createRun(projectId, "Invalid mapped row", "Validate before commit", {
      runId,
      artifactPaths: {},
    }),
    RangeError,
  );
  assert.equal(statements.includes("COMMIT"), false);
  assert.ok(statements.includes("ROLLBACK"));
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
