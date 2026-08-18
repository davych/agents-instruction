import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE_ROUTE_VERSION,
  type PhaseResolutionDto,
} from "@ai-sdlc/contracts";
import type pg from "pg";

import type { TicketRecordInput } from "../src/db/store.ts";
import { PgWorkflowStore } from "../src/db/store.ts";

interface CapturedQuery {
  sql: string;
  values?: unknown[];
}

test("lazy ticket synchronization promotes inherited stories to todo when Discovery is already approved", async () => {
  const runId = crypto.randomUUID();
  const sourceArtifactId = crypto.randomUUID();
  const queries: CapturedQuery[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
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
  const tickets: TicketRecordInput[] = [{
    storyKey: "US-001",
    title: "Reuse the approved story",
    category: "orders",
    sourcePath: "docs/ai-native/product/user-stories/orders/story.md",
    content: "# US-001: Reuse the approved story",
    contentHash: "a".repeat(64),
    acceptanceCriteriaCount: 1,
    position: 1,
  }];

  await store.syncTickets(runId, sourceArtifactId, tickets);

  const promotion = queries.find((query) =>
    query.sql.includes("SET status = 'todo'")
  );
  assert.ok(promotion, "lazy synchronization must include backlog-to-todo promotion");
  assert.deepEqual(promotion.values, [runId]);
  assert.match(promotion.sql, /status = 'backlog'/u);
  assert.match(promotion.sql, /phase_id = 'discovery'/u);
  assert.match(promotion.sql, /status = 'approved'/u);
  assert.ok(
    queries.findIndex((query) => query === promotion)
      > queries.findIndex((query) => query.sql.includes("INSERT INTO tickets")),
    "promotion happens after inherited stories are synchronized",
  );
  assert.equal(queries.at(-2)?.sql, "COMMIT");
});

test("Design partial approval accepts a new AI optional output at revision one", async () => {
  const heads = partialDesignHeads(true);
  const harness = reviewHarness(heads);
  const store = new PgWorkflowStore(harness.pool);

  const review = await store.reviewPhase(
    harness.runId,
    "design",
    "approve",
    "The required spec changed and the optional prototype was newly generated.",
    heads.map((head) => head.id),
    ["design-baseline", "design-spec"],
  );

  assert.equal(review.decision, "approve");
  const prototype = heads.find((head) => head.artifact_key === "design-prototype");
  assert.equal(prototype?.revision, 1);
  assert.equal(prototype?.parent_artifact_id, null);
  assert.ok(prototype?.execution_id);
  assert.ok(harness.queries.some((query) => query.sql.includes("INSERT INTO reviews")));
  assert.equal(harness.queries.at(-2)?.sql, "COMMIT");
});

test("Design partial approval rejects an affected optional output that is still absent", async () => {
  const heads = partialDesignHeads(false);
  const harness = reviewHarness(heads);
  const store = new PgWorkflowStore(harness.pool);

  await assert.rejects(
    () => store.reviewPhase(
      harness.runId,
      "design",
      "approve",
      "This cannot approve while the affected optional prototype is absent.",
      heads.map((head) => head.id),
      ["design-baseline", "design-spec"],
    ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "PHASE_RESOLUTION_OUTPUTS_NOT_UPDATED",
      );
      assert.deepEqual(
        (error as { details?: { stale?: string[] } }).details?.stale,
        ["design-prototype"],
      );
      return true;
    },
  );
  assert.equal(
    harness.queries.some((query) => query.sql.includes("INSERT INTO reviews")),
    false,
  );
  assert.equal(harness.queries.at(-2)?.sql, "ROLLBACK");
});

function partialDesignHeads(includePrototype: boolean) {
  const executionId = crypto.randomUUID();
  const sourceBaselineId = ids.sourceBaseline;
  const sourceSpecId = ids.sourceSpec;
  const inheritedSpecId = crypto.randomUUID();
  const createdAt = new Date("2026-08-18T08:00:00.000Z");
  const heads = [
    {
      id: crypto.randomUUID(),
      artifact_key: "design-baseline",
      created_at: createdAt,
      revision: 1,
      execution_id: null,
      parent_artifact_id: sourceBaselineId,
    },
    {
      id: crypto.randomUUID(),
      artifact_key: "design-spec",
      created_at: createdAt,
      revision: 2,
      execution_id: executionId,
      parent_artifact_id: inheritedSpecId,
    },
  ];
  if (includePrototype) {
    heads.push({
      id: crypto.randomUUID(),
      artifact_key: "design-prototype",
      created_at: createdAt,
      revision: 1,
      execution_id: executionId,
      parent_artifact_id: null,
    });
  }
  return heads;
}

const ids = {
  sourceRun: crypto.randomUUID(),
  sourcePhase: crypto.randomUUID(),
  sourceBaseline: crypto.randomUUID(),
  sourceSpec: crypto.randomUUID(),
  contract: crypto.randomUUID(),
};

function designPartialResolution(): PhaseResolutionDto {
  return {
    phaseId: "design",
    mode: "partial",
    rationale: "Keep the approved design baseline while updating the spec and adding a prototype.",
    inputArtifactIds: [ids.contract],
    sourceRunId: ids.sourceRun,
    sourceRunTitle: "Approved design baseline",
    sourcePhaseRunId: ids.sourcePhase,
    sourceArtifactIds: [ids.sourceBaseline, ids.sourceSpec],
    affectedOutputKeys: ["design-spec", "design-prototype"],
    routeVersion: PHASE_ROUTE_VERSION,
    decidedAt: "2026-08-18T07:00:00.000Z",
  };
}

function reviewHarness(heads: ReturnType<typeof partialDesignHeads>): {
  runId: string;
  pool: pg.Pool;
  queries: CapturedQuery[];
} {
  const runId = crypto.randomUUID();
  const phaseRunId = crypto.randomUUID();
  const nextPhaseRunId = crypto.randomUUID();
  const queries: CapturedQuery[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT * FROM phase_runs")) {
        return {
          rows: [{
            id: phaseRunId,
            workflow_run_id: runId,
            phase_id: "design",
            position: 1,
            status: "awaiting_review",
            phase_resolution: designPartialResolution(),
            architecture_impact: null,
          }],
        };
      }
      if (sql.includes("SELECT a.id, a.artifact_key")) return { rows: heads };
      if (sql.includes("INSERT INTO reviews")) {
        return {
          rows: [{
            id: values?.[0],
            phase_run_id: phaseRunId,
            decision: values?.[2],
            comment: values?.[3],
            reviewed_artifact_ids: heads.map((head) => head.id),
            created_at: new Date("2026-08-18T08:01:00.000Z"),
          }],
        };
      }
      if (sql.includes("SELECT id FROM phase_runs") && sql.includes("position = $2")) {
        return { rows: [{ id: nextPhaseRunId }] };
      }
      return { rows: [] };
    },
    release() {
      queries.push({ sql: "RELEASE" });
    },
  };
  return {
    runId,
    queries,
    pool: {
      async connect() {
        return client;
      },
    } as unknown as pg.Pool,
  };
}
