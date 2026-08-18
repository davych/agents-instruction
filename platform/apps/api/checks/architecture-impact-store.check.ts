import assert from "node:assert/strict";
import test from "node:test";

import type { ArchitectureImpactDto } from "@ai-sdlc/contracts";
import type pg from "pg";

import { schemaSql } from "../src/db/schema.ts";
import { PgWorkflowStore } from "../src/db/store.ts";

interface CapturedQuery {
  sql: string;
  values?: unknown[];
}

const ids = {
  targetRun: crypto.randomUUID(),
  targetPhase: crypto.randomUUID(),
  inputArtifact: crypto.randomUUID(),
  sourceRun: crypto.randomUUID(),
  sourcePhase: crypto.randomUUID(),
  sourceOptions: crypto.randomUUID(),
  sourceArchitecture: crypto.randomUUID(),
  selectionReview: crypto.randomUUID(),
  approvalReview: crypto.randomUUID(),
  project: crypto.randomUUID(),
  nextPhase: crypto.randomUUID(),
};

const selectionAt = "2026-07-01T08:00:00.000Z";
const assessedAt = "2026-08-01T08:00:00.000Z";

test("phase schema persists and strictly maps architecture impact metadata", async () => {
  assert.match(schemaSql, /phase_runs[\s\S]*architecture_impact jsonb/u);
  assert.match(
    schemaSql,
    /ALTER TABLE phase_runs ADD COLUMN IF NOT EXISTS architecture_impact jsonb/u,
  );

  const impact = makeImpact("reuse");
  let architectureImpact: unknown = JSON.stringify(impact);
  const pool = {
    async query() {
      return {
        rows: [{
          id: ids.targetPhase,
          workflow_run_id: ids.targetRun,
          phase_id: "architecture",
          position: 1,
          status: "ready",
          architecture_impact: architectureImpact,
          created_at: new Date("2026-08-01T00:00:00.000Z"),
          updated_at: new Date("2026-08-01T00:00:00.000Z"),
        }],
      };
    },
  } as unknown as pg.Pool;
  const store = new PgWorkflowStore(pool);

  assert.deepEqual((await store.getPhase(ids.targetRun, "architecture")).architectureImpact, impact);

  architectureImpact = { ...impact, mode: "unsupported" };
  await assert.rejects(
    () => store.getPhase(ids.targetRun, "architecture"),
    (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_IMPACT_CORRUPT",
  );
});

test("architecture baseline candidates return current snapshots, reviews, and inherited impact", async () => {
  const impact = makeImpact("reuse");
  const sourceArtifacts = makeSourceArtifacts();
  const sourceReviews = makeSourceReviews();
  const pool = {
    async query(sql: string) {
      if (sql.includes("FROM phase_runs pr") && sql.includes("pr.status = 'approved'")) {
        return {
          rows: [{
            id: ids.sourcePhase,
            workflow_run_id: ids.sourceRun,
            phase_id: "architecture",
            position: 1,
            status: "approved",
            source_run_id: ids.sourceRun,
            source_run_title: "Approved baseline",
            architecture_impact: impact,
            created_at: new Date("2026-06-01T00:00:00.000Z"),
            updated_at: new Date("2026-07-02T00:00:00.000Z"),
          }],
        };
      }
      if (sql.includes("SELECT a.*") && sql.includes("NOT EXISTS")) {
        return { rows: sourceArtifacts };
      }
      if (sql.includes("SELECT * FROM reviews")) return { rows: sourceReviews };
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const store = new PgWorkflowStore(pool);

  const baselines = await store.approvedArchitectureBaselineCandidates(
    ids.project,
    ids.targetRun,
  );
  const baseline = baselines[0];

  assert.equal(baselines.length, 1);
  assert.equal(baseline?.sourceRunId, ids.sourceRun);
  assert.equal(baseline?.approvedAt, "2026-07-02T08:00:00.000Z");
  assert.deepEqual(baseline?.architectureImpact, impact);
  assert.deepEqual(
    baseline?.artifacts.map((artifact) => [artifact.id, artifact.content]),
    sourceArtifacts.map((artifact) => [artifact.id, artifact.content_snapshot]),
  );
  assert.equal(baseline?.reviews.length, 2);
});

test("architecture baseline candidates preserve newest-to-oldest database order", async () => {
  const olderPhase = crypto.randomUUID();
  const olderRun = crypto.randomUUID();
  const sourceArtifacts = makeSourceArtifacts();
  const sourceReviews = makeSourceReviews();
  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("FROM phase_runs pr") && sql.includes("pr.status = 'approved'")) {
        assert.doesNotMatch(sql, /LIMIT\s+1/u);
        return {
          rows: [
            {
              id: ids.sourcePhase,
              status: "approved",
              source_run_id: ids.sourceRun,
              source_run_title: "Newest approved candidate",
              architecture_impact: null,
            },
            {
              id: olderPhase,
              status: "approved",
              source_run_id: olderRun,
              source_run_title: "Older approved candidate",
              architecture_impact: null,
            },
          ],
        };
      }
      if (sql.includes("SELECT a.*") && sql.includes("NOT EXISTS")) {
        return { rows: sourceArtifacts };
      }
      if (sql.includes("SELECT * FROM reviews")) return { rows: sourceReviews };
      return { rows: [] };
    },
  } as unknown as pg.Pool;

  const baselines = await new PgWorkflowStore(pool).approvedArchitectureBaselineCandidates(
    ids.project,
    ids.targetRun,
  );

  assert.deepEqual(
    baselines.map((baseline) => baseline.sourceRunTitle),
    ["Newest approved candidate", "Older approved candidate"],
  );
});

test("reuse adoption is atomic, preserves source timestamps, and unlocks the next phase", async () => {
  const harness = adoptionHarness("reuse");
  const store = new PgWorkflowStore(harness.pool);

  const review = await store.adoptArchitectureBaseline(ids.targetRun, harness.input);

  assert.equal(review.decision, "approve");
  assert.equal(review.comment, `Architecture impact (reuse):\n${harness.input.impact.rationale}`);
  const cloneQueries = harness.queries.filter((query) =>
    query.sql.includes("INSERT INTO artifacts")
  );
  assert.equal(cloneQueries.length, 2);
  assert.deepEqual(cloneQueries.map((query) => query.values?.[6]), ["approved", "approved"]);
  assert.deepEqual(
    cloneQueries.map((query) => query.values?.[9]),
    makeSourceArtifacts().map((artifact) => artifact.created_at),
  );
  assert.deepEqual(
    cloneQueries.map((query) => query.values?.[8]),
    [ids.sourceOptions, ids.sourceArchitecture],
  );
  const impactUpdate = harness.queries.find((query) =>
    query.sql.includes("SET status = $2, architecture_impact")
  );
  assert.equal(impactUpdate?.values?.[1], "approved");
  assert.deepEqual(JSON.parse(String(impactUpdate?.values?.[2])), harness.input.impact);
  assert.ok(harness.queries.some((query) =>
    query.sql.includes("SET status = 'ready'")
  ));
  assert.equal(harness.queries.at(-2)?.sql, "COMMIT");
});

test("partial adoption keeps inherited heads stale and does not unlock downstream", async () => {
  const harness = adoptionHarness("partial");
  const store = new PgWorkflowStore(harness.pool);

  const review = await store.adoptArchitectureBaseline(ids.targetRun, harness.input);

  assert.equal(review.decision, "request_changes");
  const cloneQueries = harness.queries.filter((query) =>
    query.sql.includes("INSERT INTO artifacts")
  );
  assert.deepEqual(
    cloneQueries.map((query) => query.values?.[6]),
    ["changes_requested", "changes_requested"],
  );
  assert.deepEqual(
    cloneQueries.map((query) => query.values?.[9]),
    makeSourceArtifacts().map((artifact) => artifact.created_at),
  );
  const impactUpdate = harness.queries.find((query) =>
    query.sql.includes("SET status = $2, architecture_impact")
  );
  assert.equal(impactUpdate?.values?.[1], "changes_requested");
  assert.equal(harness.queries.some((query) =>
    query.sql.includes("SELECT id, status") && query.sql.includes("position = $2")
  ), false);
});

test("adoption rolls back when an assessed upstream input is no longer an approved current head", async () => {
  const harness = adoptionHarness("reuse", []);
  const store = new PgWorkflowStore(harness.pool);

  await assert.rejects(
    () => store.adoptArchitectureBaseline(ids.targetRun, harness.input),
    (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_IMPACT_INPUTS_CHANGED",
  );
  const inputCheck = harness.queries.find((query) =>
    query.sql.includes("JOIN phase_runs input_phase")
  );
  assert.deepEqual(inputCheck?.values, [ids.targetRun, 1, [ids.inputArtifact]]);
  assert.match(inputCheck?.sql ?? "", /input_phase\.status = 'approved'/u);
  assert.match(inputCheck?.sql ?? "", /a\.review_status = 'approved'/u);
  assert.match(inputCheck?.sql ?? "", /NOT EXISTS/u);
  assert.match(inputCheck?.sql ?? "", /FOR UPDATE OF a, input_phase/u);
  assert.equal(harness.queries.at(-2)?.sql, "ROLLBACK");
  assert.equal(harness.queries.some((query) => query.sql.includes("INSERT INTO artifacts")), false);
});

test("partial architecture impact rejects a human revision outside the assessed scope", async () => {
  const artifactId = crypto.randomUUID();
  const phaseRunId = crypto.randomUUID();
  const queries: CapturedQuery[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT a.*, pr.workflow_run_id")) {
        return {
          rows: [{
            id: artifactId,
            phase_run_id: phaseRunId,
            execution_id: null,
            artifact_key: "architecture-nfrs",
            file_path: "docs/ai-native/architecture/06-nfrs.md",
            content_snapshot: "# NFRs",
            content_hash: "c".repeat(64),
            review_status: "changes_requested",
            revision: 1,
            revision_source: "inherited",
            parent_artifact_id: ids.sourceArchitecture,
            created_at: new Date("2026-08-01T08:00:00.000Z"),
            workflow_run_id: ids.targetRun,
            position: 2,
            phase_status: "changes_requested",
            architecture_impact: makeImpact("partial"),
          }],
        };
      }
      return { rows: [] };
    },
    release() {
      queries.push({ sql: "RELEASE" });
    },
  };
  const store = new PgWorkflowStore({
    async connect() {
      return client;
    },
  } as unknown as pg.Pool);

  await assert.rejects(
    () => store.createHumanArtifactRevision(
      artifactId,
      "c".repeat(64),
      "# Changed NFRs",
      "d".repeat(64),
    ),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 409);
      assert.equal(
        (error as { code?: string }).code,
        "ARCHITECTURE_IMPACT_SCOPE_EXCEEDED",
      );
      assert.deepEqual(
        (error as { details?: { affectedOutputKeys?: string[] } }).details?.affectedOutputKeys,
        ["architecture"],
      );
      return true;
    },
  );
  const lockedArtifactQuery = queries.find((query) =>
    query.sql.includes("SELECT a.*, pr.workflow_run_id")
  );
  assert.match(lockedArtifactQuery?.sql ?? "", /pr\.architecture_impact/u);
  assert.equal(queries.some((query) => query.sql.includes("SELECT id, revision")), false);
  assert.equal(queries.some((query) => query.sql.includes("INSERT INTO artifacts")), false);
  assert.equal(queries.at(-2)?.sql, "ROLLBACK");
});

test("upstream revision atomically clears stale architecture impact while resetting downstream", async () => {
  const artifactId = crypto.randomUUID();
  const phaseRunId = crypto.randomUUID();
  const architecturePhaseRunId = crypto.randomUUID();
  const now = new Date("2026-08-18T08:00:00.000Z");
  const queries: CapturedQuery[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT a.*, pr.workflow_run_id")) {
        return {
          rows: [{
            id: artifactId,
            phase_run_id: phaseRunId,
            execution_id: crypto.randomUUID(),
            artifact_key: "prd",
            file_path: "docs/ai-native/prd.md",
            content_snapshot: "# Old PRD",
            content_hash: "e".repeat(64),
            review_status: "approved",
            revision: 1,
            revision_source: "ai",
            parent_artifact_id: null,
            created_at: now,
            workflow_run_id: ids.targetRun,
            position: 0,
            phase_status: "approved",
            architecture_impact: null,
          }],
        };
      }
      if (sql.includes("SELECT id, revision") && sql.includes("FROM artifacts")) {
        return { rows: [{ id: artifactId, revision: 1 }] };
      }
      if (sql.includes("FROM phase_runs") && sql.includes("position > $2") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: architecturePhaseRunId,
            phase_id: "architecture",
            status: "pending",
          }],
        };
      }
      if (sql.includes("INSERT INTO artifacts") && sql.includes("RETURNING *")) {
        return {
          rows: [{
            id: values?.[0],
            phase_run_id: phaseRunId,
            execution_id: null,
            artifact_key: "prd",
            file_path: "docs/ai-native/prd.md",
            content_snapshot: "# New PRD",
            content_hash: "f".repeat(64),
            review_status: "pending",
            revision: 2,
            revision_source: "human",
            parent_artifact_id: artifactId,
            created_at: now,
          }],
        };
      }
      return { rows: [] };
    },
    release() {
      queries.push({ sql: "RELEASE" });
    },
  };
  const store = new PgWorkflowStore({
    async connect() {
      return client;
    },
  } as unknown as pg.Pool);

  await store.createHumanArtifactRevision(
    artifactId,
    "e".repeat(64),
    "# New PRD",
    "f".repeat(64),
  );

  const reset = queries.find((query) =>
    query.sql.includes("UPDATE phase_runs")
    && query.sql.includes("position > $2")
  );
  assert.match(
    reset?.sql ?? "",
    /architecture_impact = CASE[\s\S]*WHEN phase_id = 'architecture' THEN NULL/u,
  );
  assert.match(
    reset?.sql ?? "",
    /status <> 'pending'[\s\S]*phase_id = 'architecture' AND architecture_impact IS NOT NULL/u,
  );
  assert.deepEqual(reset?.values, [ids.targetRun, 0]);
  assert.ok(queries.some((query) => query.sql === "COMMIT"));
});

test("the locked phase row blocks stale concurrent executions from bypassing impact scope", async () => {
  for (const scenario of [
    {
      impact: makeImpact("reuse"),
      status: "approved",
      selectedArtifactIds: [ids.inputArtifact],
      selectedOutputKeys: ["architecture"],
      expectedCode: "ARCHITECTURE_IMPACT_REUSE_IMMUTABLE",
    },
    {
      impact: makeImpact("partial"),
      status: "changes_requested",
      selectedArtifactIds: [ids.inputArtifact],
      selectedOutputKeys: ["architecture-options"],
      expectedCode: "ARCHITECTURE_IMPACT_SCOPE_EXCEEDED",
    },
  ] as const) {
    const queries: CapturedQuery[] = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        queries.push({ sql, values });
        if (sql.includes("SELECT * FROM phase_runs")) {
          return {
            rows: [{
              id: ids.targetPhase,
              workflow_run_id: ids.targetRun,
              phase_id: "architecture",
              position: 2,
              status: scenario.status,
              architecture_impact: scenario.impact,
            }],
          };
        }
        return { rows: [] };
      },
      release() {
        queries.push({ sql: "RELEASE" });
      },
    };
    const store = new PgWorkflowStore({
      async connect() { return client; },
    } as unknown as pg.Pool);

    await assert.rejects(
      () => store.createExecution(
        ids.targetRun,
        "architecture",
        [...scenario.selectedArtifactIds],
        [...scenario.selectedOutputKeys],
        "fake",
        null,
        null,
        "fake",
      ),
      (error: unknown) => (error as { code?: string }).code === scenario.expectedCode,
    );
    assert.ok(queries.some((query) => query.sql === "ROLLBACK"));
    assert.equal(queries.some((query) => query.sql.includes("INSERT INTO executions")), false);
  }
});

function makeImpact(mode: "reuse" | "partial"): ArchitectureImpactDto {
  return {
    mode,
    rationale: "The approved architecture remains compatible with all current inputs.",
    sourceRunId: ids.sourceRun,
    sourceRunTitle: "Approved baseline",
    sourcePhaseRunId: ids.sourcePhase,
    sourceArtifactIds: [ids.sourceOptions, ids.sourceArchitecture],
    inputArtifactIds: [ids.inputArtifact],
    affectedOutputKeys: mode === "partial" ? ["architecture"] : [],
    assessedAt,
    selection: {
      optionId: "option-a",
      reviewId: ids.selectionReview,
      optionsArtifactId: ids.sourceOptions,
      selectedAt: selectionAt,
    },
  };
}

function makeSourceArtifacts() {
  return [
    {
      id: ids.sourceOptions,
      phase_run_id: ids.sourcePhase,
      execution_id: crypto.randomUUID(),
      artifact_key: "architecture-options",
      file_path: "docs/ai-native/architecture/03-options.md",
      content_snapshot: "# Options\n\n## option-a",
      content_hash: "a".repeat(64),
      review_status: "approved",
      revision: 2,
      revision_source: "ai",
      parent_artifact_id: crypto.randomUUID(),
      created_at: new Date("2026-07-01T07:00:00.000Z"),
    },
    {
      id: ids.sourceArchitecture,
      phase_run_id: ids.sourcePhase,
      execution_id: crypto.randomUUID(),
      artifact_key: "architecture",
      file_path: "docs/ai-native/architecture.md",
      content_snapshot: "# Architecture",
      content_hash: "b".repeat(64),
      review_status: "approved",
      revision: 3,
      revision_source: "human",
      parent_artifact_id: crypto.randomUUID(),
      created_at: new Date("2026-07-02T07:00:00.000Z"),
    },
  ];
}

function makeSourceReviews() {
  return [
    {
      id: ids.approvalReview,
      phase_run_id: ids.sourcePhase,
      decision: "approve",
      comment: "Approved",
      reviewed_artifact_ids: [ids.sourceOptions, ids.sourceArchitecture],
      created_at: new Date("2026-07-02T08:00:00.000Z"),
    },
    {
      id: ids.selectionReview,
      phase_run_id: ids.sourcePhase,
      decision: "request_changes",
      comment: "Selected option: option-a",
      reviewed_artifact_ids: [ids.sourceOptions],
      created_at: new Date(selectionAt),
    },
  ];
}

function adoptionHarness(
  mode: "reuse" | "partial",
  inputRows: Array<{ id: string }> = [{ id: ids.inputArtifact }],
) {
  const queries: CapturedQuery[] = [];
  const sourceArtifacts = makeSourceArtifacts();
  const sourceReviews = makeSourceReviews();
  const input = {
    impact: makeImpact(mode),
    expectedBaselineArtifactIds: [ids.sourceOptions, ids.sourceArchitecture],
    requiredArtifactKeys: ["architecture-options", "architecture"],
  };
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("WHERE wr.id = $1 AND pr.phase_id = 'architecture'")) {
        return {
          rows: [{
            id: ids.targetPhase,
            workflow_run_id: ids.targetRun,
            phase_id: "architecture",
            position: 1,
            status: "ready",
            project_id: ids.project,
            architecture_impact: null,
          }],
        };
      }
      if (sql.includes("AND pr.id = $2") && sql.includes("source_project_id")) {
        return {
          rows: [{
            id: ids.sourcePhase,
            workflow_run_id: ids.sourceRun,
            phase_id: "architecture",
            position: 1,
            status: "approved",
            source_run_id: ids.sourceRun,
            source_run_title: "Approved baseline",
            source_project_id: ids.project,
            architecture_impact: null,
          }],
        };
      }
      if (sql.includes("JOIN phase_runs input_phase")) return { rows: inputRows };
      if (sql.includes("SELECT a.*") && sql.includes("ORDER BY a.artifact_key")) {
        return { rows: sourceArtifacts };
      }
      if (sql.includes("SELECT * FROM reviews") && sql.includes("ORDER BY created_at DESC")) {
        return { rows: sourceReviews };
      }
      if (sql.includes("INSERT INTO reviews")) {
        return {
          rows: [{
            id: values?.[0],
            phase_run_id: values?.[1],
            decision: values?.[2],
            comment: values?.[3],
            reviewed_artifact_ids: JSON.parse(String(values?.[4])),
            created_at: new Date("2026-08-01T08:01:00.000Z"),
          }],
        };
      }
      if (sql.includes("SELECT id, status") && sql.includes("position = $2")) {
        return { rows: [{ id: ids.nextPhase, status: "pending" }] };
      }
      return { rows: [] };
    },
    release() {
      queries.push({ sql: "RELEASE" });
    },
  };
  return {
    input,
    queries,
    pool: { async connect() { return client; } } as unknown as pg.Pool,
  };
}
