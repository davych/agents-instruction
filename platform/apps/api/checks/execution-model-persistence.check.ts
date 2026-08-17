import assert from "node:assert/strict";
import test from "node:test";

import type pg from "pg";

import { schemaSql } from "../src/db/schema.ts";
import { PgWorkflowStore } from "../src/db/store.ts";

test("execution rows persist the resolved model and reasoning effort", async () => {
  const phaseRunId = crypto.randomUUID();
  const now = new Date();
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT * FROM phase_runs")) {
        return { rows: [{ id: phaseRunId, status: "ready" }] };
      }
      if (sql.includes("INSERT INTO executions")) {
        return { rows: [{
          id: values?.[0],
          phase_run_id: phaseRunId,
          status: "running",
          selected_artifact_ids: [],
          selected_output_keys: ["prd"],
          runner_mode: values?.[4],
          model: values?.[5],
          reasoning_effort: values?.[6],
          command: values?.[7],
          exit_code: null,
          error: null,
          started_at: now,
          finished_at: null,
          created_at: now
        }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } } as unknown as pg.Pool;
  const store = new PgWorkflowStore(pool);
  const execution = await store.createExecution(
    crypto.randomUUID(),
    "discovery",
    [],
    ["prd"],
    "real",
    "gpt-5.6-sol",
    "ultra",
    'codex exec --model gpt-5.6-sol --config model_reasoning_effort="ultra"'
  );

  assert.equal(execution.runnerMode, "real");
  assert.equal(execution.model, "gpt-5.6-sol");
  assert.equal(execution.reasoningEffort, "ultra");
  const insert = queries.find((query) => query.sql.includes("INSERT INTO executions"));
  assert.match(insert?.sql ?? "", /model, reasoning_effort, command/u);
  assert.deepEqual(insert?.values?.slice(4, 8), [
    "real",
    "gpt-5.6-sol",
    "ultra",
    'codex exec --model gpt-5.6-sol --config model_reasoning_effort="ultra"'
  ]);

  const simulated = await store.createExecution(
    crypto.randomUUID(),
    "discovery",
    [],
    ["prd"],
    "fake",
    null,
    null,
    "AI_SDLC_CODEX_FAKE=1"
  );
  assert.equal(simulated.runnerMode, "fake");
  assert.equal(simulated.model, null);
  assert.equal(simulated.reasoningEffort, null);
});

test("the migration keeps legacy execution rows nullable while adding audit columns", () => {
  assert.match(schemaSql, /ALTER TABLE executions ADD COLUMN IF NOT EXISTS runner_mode text/u);
  assert.match(schemaSql, /ALTER TABLE executions ADD COLUMN IF NOT EXISTS model text/u);
  assert.match(schemaSql, /ALTER TABLE executions ADD COLUMN IF NOT EXISTS reasoning_effort text/u);
  assert.match(
    schemaSql,
    /UPDATE executions[\s\S]*runner_mode = NULL[\s\S]*runner_mode NOT IN \('real', 'fake'\)/u
  );
  assert.match(
    schemaSql,
    /ADD CONSTRAINT executions_runner_mode_check[\s\S]*runner_mode IN \('real', 'fake'\)/u
  );
  assert.match(
    schemaSql,
    /UPDATE executions[\s\S]*reasoning_effort = NULL[\s\S]*reasoning_effort NOT IN \('minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'\)/u
  );
  assert.match(
    schemaSql,
    /ADD CONSTRAINT executions_reasoning_effort_check[\s\S]*'xhigh', 'max', 'ultra'/u
  );
});
