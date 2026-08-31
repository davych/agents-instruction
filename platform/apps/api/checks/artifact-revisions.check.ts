import assert from "node:assert/strict";
import test from "node:test";

import type pg from "pg";

import { schemaSql } from "../src/db/schema.ts";
import { PgWorkflowStore } from "../src/db/store.ts";

interface CapturedQuery {
  sql: string;
  values?: unknown[];
}

test("artifact migration adds append-only revision metadata and a single current head", () => {
  assert.match(schemaSql, /ALTER TABLE artifacts ALTER COLUMN execution_id DROP NOT NULL/u);
  assert.match(schemaSql, /ADD COLUMN IF NOT EXISTS revision integer/u);
  assert.match(schemaSql, /ADD COLUMN IF NOT EXISTS revision_source text/u);
  assert.match(schemaSql, /ADD COLUMN IF NOT EXISTS parent_artifact_id uuid REFERENCES artifacts/u);
  assert.match(schemaSql, /'pending', 'approved', 'changes_requested', 'superseded'/u);
  assert.match(schemaSql, /row_number\(\) OVER[\s\S]*PARTITION BY phase_run_id, artifact_key/u);
  assert.match(schemaSql, /artifacts_phase_key_revision_idx/u);
  assert.match(schemaSql, /artifacts_phase_key_head_idx[\s\S]*review_status <> 'superseded'/u);
  assert.match(
    schemaSql,
    /ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reviewed_artifact_ids jsonb NOT NULL DEFAULT '\[\]'::jsonb/u
  );
});

test("completing a selected output supersedes its old head and inserts the next AI revision", async () => {
  const executionId = crypto.randomUUID();
  const phaseRunId = crypto.randomUUID();
  const workflowRunId = crypto.randomUUID();
  const previousId = crypto.randomUUID();
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("SELECT e.*, pr.id AS phase_id")) {
      return {
        rows: [{
          id: executionId,
          status: "running",
          phase_run_id: phaseRunId,
          workflow_run_id: workflowRunId,
          selected_output_keys: ["prd"]
        }]
      };
    }
    if (sql.includes("SELECT id, revision") && sql.includes("FROM artifacts")) {
      return { rows: [{ id: previousId, revision: 2 }] };
    }
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  await store.completeExecution(executionId, 0, [{
    artifactKey: "prd",
    filePath: "docs/prd.md",
    content: "# revised",
    contentHash: "b".repeat(64)
  }], undefined, "actual-provider-model");

  const supersede = queries.find((query) =>
    query.sql.includes("UPDATE artifacts SET review_status = 'superseded'")
  );
  assert.deepEqual(supersede?.values, [phaseRunId, "prd"]);
  const insert = queries.find((query) => query.sql.includes("INSERT INTO artifacts"));
  assert.match(insert?.sql ?? "", /'pending', \$8, 'ai', \$9/u);
  assert.equal(insert?.values?.[7], 3);
  assert.equal(insert?.values?.[8], previousId);
  const completion = queries.find((query) => (
    query.sql.includes("UPDATE executions") && query.sql.includes("status = 'completed'")
  ));
  assert.match(completion?.sql ?? "", /model = COALESCE\(\$3, model\)/u);
  assert.deepEqual(completion?.values, [executionId, 0, "actual-provider-model"]);
  assert.ok(queries.some((query) => query.sql.includes("SET status = 'awaiting_review'")));
  assert.equal(queries.at(-2)?.sql, "COMMIT");
});

test("a human edit creates a pending child revision and invalidates downstream phases", async () => {
  const artifactId = crypto.randomUUID();
  const phaseRunId = crypto.randomUUID();
  const workflowRunId = crypto.randomUUID();
  const downstreamId = crypto.randomUUID();
  const now = new Date();
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql, values) => {
    if (sql.includes("SELECT a.*, pr.workflow_run_id")) {
      return {
        rows: [{
          id: artifactId,
          phase_run_id: phaseRunId,
          artifact_key: "prd",
          file_path: "docs/prd.md",
          content_snapshot: "old",
          content_hash: "a".repeat(64),
          review_status: "approved",
          revision: 4,
          revision_source: "ai",
          parent_artifact_id: null,
          created_at: now,
          workflow_run_id: workflowRunId,
          position: 0,
          phase_status: "approved"
        }]
      };
    }
    if (sql.includes("SELECT id, revision") && sql.includes("FROM artifacts")) {
      return { rows: [{ id: artifactId, revision: 4 }] };
    }
    if (sql.includes("FROM phase_runs") && sql.includes("position > $2") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: downstreamId, phase_id: "design", status: "approved" }] };
    }
    if (sql.includes("INSERT INTO artifacts") && sql.includes("RETURNING *")) {
      return {
        rows: [{
          id: values?.[0],
          phase_run_id: phaseRunId,
          execution_id: null,
          artifact_key: "prd",
          file_path: "docs/prd.md",
          content_snapshot: "new",
          content_hash: "b".repeat(64),
          review_status: "pending",
          revision: 5,
          revision_source: "human",
          parent_artifact_id: artifactId,
          created_at: now
        }]
      };
    }
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  const revision = await store.createHumanArtifactRevision(
    artifactId,
    "a".repeat(64),
    "new",
    "b".repeat(64)
  );

  assert.equal(revision.revision, 5);
  assert.equal(revision.revisionSource, "human");
  assert.equal(revision.parentArtifactId, artifactId);
  assert.equal(revision.reviewStatus, "pending");
  assert.equal(revision.content, "new");
  assert.ok(queries.some((query) =>
    query.sql.includes("position > $2")
    && query.sql.includes("architecture_impact = CASE")
  ));
  assert.ok(queries.some((query) =>
    query.sql.includes("workflow_runs SET status = 'active'")
  ));
});

test("a completed Agent Session Run rejects human revisions inside the store transaction", async () => {
  const artifactId = crypto.randomUUID();
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("SELECT a.*, pr.workflow_run_id")) {
      return { rows: [{
        id: artifactId,
        agent_session_id: crypto.randomUUID(),
        workflow_run_status: "completed",
      }] };
    }
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  await assert.rejects(
    () => store.createHumanArtifactRevision(
      artifactId,
      "a".repeat(64),
      "attempted edit",
      "b".repeat(64),
    ),
    (error: unknown) => (
      (error as { code?: string }).code === "AGENT_SESSION_RUN_COMPLETED_IMMUTABLE"
    ),
  );
  assert.equal(queries.some(({ sql }) => sql.includes("INSERT INTO artifacts")), false);
  assert.equal(queries.some(({ sql }) => sql.includes("position > $2")), false);
  assert.equal(queries.at(-2)?.sql, "ROLLBACK");
});

test("revision operations reject a running downstream phase before changing state", async () => {
  const runId = crypto.randomUUID();
  const phaseRunId = crypto.randomUUID();
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("FROM phase_runs pr")) {
      return { rows: [{ id: phaseRunId, position: 0, status: "approved" }] };
    }
    if (sql.includes("position > $2") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: crypto.randomUUID(), phase_id: "design", status: "running" }] };
    }
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  await assert.rejects(
    () => store.createExecution(
      runId,
      "discovery",
      [],
      ["prd"],
      "fake",
      null,
      null,
      "AI_SDLC_CODEX_FAKE=1"
    ),
    /下游阶段 design 正在执行/u
  );
  assert.equal(queries.some((query) => query.sql.includes("INSERT INTO executions")), false);
  assert.equal(queries.at(-2)?.sql, "ROLLBACK");
});

test("a stale expected hash is rejected without inserting a human revision", async () => {
  const artifactId = crypto.randomUUID();
  const phaseRunId = crypto.randomUUID();
  const now = new Date();
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("SELECT a.*, pr.workflow_run_id")) {
      return {
        rows: [{
          id: artifactId,
          phase_run_id: phaseRunId,
          artifact_key: "prd",
          file_path: "docs/prd.md",
          content_snapshot: "current",
          content_hash: "a".repeat(64),
          review_status: "approved",
          revision: 2,
          revision_source: "ai",
          parent_artifact_id: null,
          created_at: now,
          workflow_run_id: crypto.randomUUID(),
          position: 0,
          phase_status: "approved"
        }]
      };
    }
    if (sql.includes("SELECT id, revision") && sql.includes("FROM artifacts")) {
      return { rows: [{ id: artifactId, revision: 2 }] };
    }
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  await assert.rejects(
    () => store.createHumanArtifactRevision(
      artifactId,
      "f".repeat(64),
      "stale edit",
      "b".repeat(64)
    ),
    /产物已发生变化/u
  );
  assert.equal(queries.some((query) => query.sql.includes("INSERT INTO artifacts")), false);
  assert.equal(queries.at(-2)?.sql, "ROLLBACK");
});

test("an unchanged human revision is rejected in the store transaction", async () => {
  const artifactId = crypto.randomUUID();
  const phaseRunId = crypto.randomUUID();
  const currentHash = "a".repeat(64);
  const now = new Date();
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("SELECT a.*, pr.workflow_run_id")) {
      return {
        rows: [{
          id: artifactId,
          phase_run_id: phaseRunId,
          artifact_key: "prd",
          file_path: "docs/prd.md",
          content_snapshot: "current",
          content_hash: currentHash,
          review_status: "approved",
          revision: 2,
          revision_source: "ai",
          parent_artifact_id: null,
          created_at: now,
          workflow_run_id: crypto.randomUUID(),
          position: 0,
          phase_status: "approved",
          architecture_impact: null,
        }],
      };
    }
    if (sql.includes("SELECT id, revision") && sql.includes("FROM artifacts")) {
      return { rows: [{ id: artifactId, revision: 2 }] };
    }
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  await assert.rejects(
    () => store.createHumanArtifactRevision(
      artifactId,
      currentHash,
      "current",
      currentHash,
    ),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 409);
      assert.equal((error as { code?: string }).code, "ARTIFACT_REVISION_UNCHANGED");
      return true;
    },
  );
  assert.equal(queries.some((query) => query.sql.includes("position > $2")), false);
  assert.equal(queries.some((query) => query.sql.includes("INSERT INTO artifacts")), false);
  assert.equal(queries.at(-2)?.sql, "ROLLBACK");
});

test("review rejects stale artifact heads before writing a decision", async () => {
  const phaseRunId = crypto.randomUUID();
  const staleArtifactId = crypto.randomUUID();
  const currentArtifactId = crypto.randomUUID();
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("FROM phase_runs pr")) {
      return {
        rows: [{
          id: phaseRunId,
          phase_id: "discovery",
          position: 0,
          status: "awaiting_review"
        }]
      };
    }
    if (sql.includes("SELECT a.id, a.artifact_key")) {
      return { rows: [{ id: currentArtifactId, artifact_key: "prd" }] };
    }
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  await assert.rejects(
    () => store.reviewPhase(
      crypto.randomUUID(),
      "discovery",
      "approve",
      "looks good",
      [staleArtifactId]
    ),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "ARTIFACT_HEADS_CHANGED"
    )
  );
  assert.equal(queries.some((query) => query.sql.includes("INSERT INTO reviews")), false);
  assert.equal(queries.some((query) => query.sql.includes("UPDATE artifacts SET review_status")), false);
  assert.equal(queries.at(-2)?.sql, "ROLLBACK");
});

test("a completed Agent Session Run rejects review-based decision capture transactionally", async () => {
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("FROM phase_runs pr")) {
      return { rows: [{
        id: crypto.randomUUID(),
        phase_id: "discovery",
        position: 0,
        status: "approved",
        agent_session_id: crypto.randomUUID(),
        workflow_run_status: "completed",
      }] };
    }
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  await assert.rejects(
    () => store.reviewPhase(
      crypto.randomUUID(),
      "discovery",
      "request_changes",
      "attempted decision change",
      [crypto.randomUUID()],
      [],
      undefined,
      ["approved"],
    ),
    (error: unknown) => (
      (error as { code?: string }).code === "AGENT_SESSION_RUN_COMPLETED_IMMUTABLE"
    ),
  );
  assert.equal(queries.some(({ sql }) => sql.includes("INSERT INTO reviews")), false);
  assert.equal(queries.at(-2)?.sql, "ROLLBACK");
});

test("approval rejects an architecture selection checkpoint without the full pack", async () => {
  const phaseRunId = crypto.randomUUID();
  const checkpoint = [
    { id: crypto.randomUUID(), artifact_key: "architecture" },
    { id: crypto.randomUUID(), artifact_key: "architecture-discovery-context" },
    { id: crypto.randomUUID(), artifact_key: "architecture-options" },
  ];
  const requiredOutputs = [
    ...checkpoint.map((artifact) => artifact.artifact_key),
    "architecture-c4-context",
    "architecture-c4-containers",
    "architecture-adrs",
    "architecture-patterns",
    "architecture-nfrs",
    "architecture-adversarial",
  ];
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("FROM phase_runs pr")) {
      return {
        rows: [{
          id: phaseRunId,
          phase_id: "architecture",
          position: 2,
          status: "awaiting_review",
        }],
      };
    }
    if (sql.includes("SELECT a.id, a.artifact_key")) return { rows: checkpoint };
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  await assert.rejects(
    () => store.reviewPhase(
      crypto.randomUUID(),
      "architecture",
      "approve",
      "selected option A",
      checkpoint.map((artifact) => artifact.id),
      requiredOutputs,
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PHASE_OUTPUTS_INCOMPLETE");
      assert.deepEqual(
        (error as { details?: { missing?: string[] } }).details?.missing,
        requiredOutputs.slice(checkpoint.length),
      );
      return true;
    },
  );
  assert.equal(queries.some((query) => query.sql.includes("INSERT INTO reviews")), false);
  assert.equal(queries.at(-2)?.sql, "ROLLBACK");
});

test("approval rejects selected-state architecture heads created before the human selection", async () => {
  const phaseRunId = crypto.randomUUID();
  const selectedAt = new Date("2026-08-18T08:00:00.000Z");
  const beforeSelection = new Date("2026-08-18T07:59:00.000Z");
  const afterSelection = new Date("2026-08-18T08:01:00.000Z");
  const requiredOutputs = [
    "architecture",
    "architecture-discovery-context",
    "architecture-options",
    "architecture-c4-context",
    "architecture-c4-containers",
    "architecture-adrs",
    "architecture-patterns",
    "architecture-nfrs",
    "architecture-adversarial",
  ];
  const heads = requiredOutputs.map((artifact_key) => ({
    id: crypto.randomUUID(),
    artifact_key,
    created_at: ["architecture", "architecture-c4-context"].includes(artifact_key)
      ? beforeSelection
      : afterSelection,
  }));
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("FROM phase_runs pr")) {
      return {
        rows: [{
          id: phaseRunId,
          phase_id: "architecture",
          position: 2,
          status: "awaiting_review",
        }],
      };
    }
    if (sql.includes("SELECT a.id, a.artifact_key")) return { rows: heads };
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  await assert.rejects(
    () => store.reviewPhase(
      crypto.randomUUID(),
      "architecture",
      "approve",
      "ready after option B",
      heads.map((artifact) => artifact.id),
      requiredOutputs,
      {
        keys: ["architecture", "architecture-c4-context"],
        after: selectedAt.toISOString(),
      },
    ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "ARCHITECTURE_OUTPUTS_PREDATE_SELECTION",
      );
      assert.deepEqual(
        (error as { details?: { stale?: string[] } }).details?.stale,
        ["architecture", "architecture-c4-context"],
      );
      return true;
    },
  );
  assert.equal(queries.some((query) => query.sql.includes("INSERT INTO reviews")), false);
  assert.equal(queries.at(-2)?.sql, "ROLLBACK");
});

test("partial architecture approval requires real post-adoption revisions", async () => {
  const phaseRunId = crypto.randomUUID();
  const future = new Date("2026-08-18T09:00:00.000Z");
  const heads = [
    {
      id: crypto.randomUUID(),
      artifact_key: "architecture",
      created_at: future,
      revision: 1,
      execution_id: null,
    },
    {
      id: crypto.randomUUID(),
      artifact_key: "architecture-c4-containers",
      created_at: future,
      revision: 1,
      execution_id: null,
    },
  ];
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("FROM phase_runs pr")) {
      return {
        rows: [{
          id: phaseRunId,
          phase_id: "architecture",
          position: 2,
          status: "awaiting_review",
        }],
      };
    }
    if (sql.includes("SELECT a.id, a.artifact_key")) return { rows: heads };
    return { rows: [] };
  });

  await assert.rejects(
    () => new PgWorkflowStore(mockPool(client)).reviewPhase(
      crypto.randomUUID(),
      "architecture",
      "approve",
      "approve scoped update",
      heads.map((artifact) => artifact.id),
      heads.map((artifact) => artifact.artifact_key),
      {
        keys: heads.map((artifact) => artifact.artifact_key),
        after: "2026-08-18T08:00:00.000Z",
        minimumRevision: 2,
        indexKey: "architecture",
      },
    ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "ARCHITECTURE_OUTPUTS_PREDATE_SELECTION",
      );
      assert.deepEqual(
        (error as { details?: { stale?: string[] } }).details?.stale,
        ["architecture", "architecture-c4-containers"],
      );
      return true;
    },
  );
});

test("partial architecture approval rejects an index older than a changed child artifact", async () => {
  const phaseRunId = crypto.randomUUID();
  const heads = [
    {
      id: crypto.randomUUID(),
      artifact_key: "architecture",
      created_at: new Date("2026-08-18T08:01:00.000Z"),
      revision: 2,
      execution_id: null,
    },
    {
      id: crypto.randomUUID(),
      artifact_key: "architecture-c4-containers",
      created_at: new Date("2026-08-18T08:02:00.000Z"),
      revision: 2,
      execution_id: null,
    },
  ];
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.includes("FROM phase_runs pr")) {
      return {
        rows: [{
          id: phaseRunId,
          phase_id: "architecture",
          position: 2,
          status: "awaiting_review",
        }],
      };
    }
    if (sql.includes("SELECT a.id, a.artifact_key")) return { rows: heads };
    return { rows: [] };
  });

  await assert.rejects(
    () => new PgWorkflowStore(mockPool(client)).reviewPhase(
      crypto.randomUUID(),
      "architecture",
      "approve",
      "approve scoped update",
      heads.map((artifact) => artifact.id),
      heads.map((artifact) => artifact.artifact_key),
      {
        keys: heads.map((artifact) => artifact.artifact_key),
        after: "2026-08-18T08:00:00.000Z",
        minimumRevision: 2,
        indexKey: "architecture",
      },
    ),
    (error: unknown) => (
      (error as { code?: string }).code === "ARCHITECTURE_IMPACT_INDEX_STALE"
    ),
  );
});

test("review stores the exact locked artifact head ids", async () => {
  const phaseRunId = crypto.randomUUID();
  const artifactIds = [crypto.randomUUID(), crypto.randomUUID()];
  const now = new Date();
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql, values) => {
    if (sql.includes("FROM phase_runs pr")) {
      return {
        rows: [{
          id: phaseRunId,
          phase_id: "design",
          position: 1,
          status: "awaiting_review"
        }]
      };
    }
    if (sql.includes("SELECT a.id, a.artifact_key")) {
      return {
        rows: [
          { id: artifactIds[0], artifact_key: "design-baseline" },
          { id: artifactIds[1], artifact_key: "design-spec" }
        ]
      };
    }
    if (sql.includes("INSERT INTO reviews")) {
      return {
        rows: [{
          id: values?.[0],
          phase_run_id: phaseRunId,
          decision: "request_changes",
          comment: "adjust copy",
          reviewed_artifact_ids: artifactIds,
          created_at: now
        }]
      };
    }
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  const review = await store.reviewPhase(
    crypto.randomUUID(),
    "design",
    "request_changes",
    "adjust copy",
    [...artifactIds].reverse()
  );

  assert.deepEqual(review.artifactIds, artifactIds);
  const insert = queries.find((query) => query.sql.includes("INSERT INTO reviews"));
  assert.deepEqual(JSON.parse(String(insert?.values?.[4])), artifactIds);
  const artifactUpdate = queries.find((query) =>
    query.sql.includes("UPDATE artifacts SET review_status")
  );
  assert.deepEqual(artifactUpdate?.values?.[2], artifactIds);
});

test("current phase snapshots expose only revision heads with their editable content", async () => {
  const phaseRunId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const now = new Date();
  const queries: CapturedQuery[] = [];
  const client = mockClient(queries, async (sql) => {
    if (sql.startsWith("SELECT id, status FROM phase_runs")) {
      return { rows: [{ id: phaseRunId, status: "approved" }] };
    }
    if (sql.includes("SELECT a.*") && sql.includes("a.review_status <> 'superseded'")) {
      return {
        rows: [{
          id: artifactId,
          phase_run_id: phaseRunId,
          execution_id: null,
          artifact_key: "prd",
          file_path: "docs/prd.md",
          content_snapshot: "edited",
          content_hash: "c".repeat(64),
          review_status: "approved",
          revision: 3,
          revision_source: "human",
          parent_artifact_id: crypto.randomUUID(),
          created_at: now
        }]
      };
    }
    return { rows: [] };
  });
  const store = new PgWorkflowStore(mockPool(client));

  const snapshots = await store.currentArtifactSnapshotsForPhase(
    crypto.randomUUID(),
    "discovery"
  );
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.content, "edited");
  assert.equal(snapshots[0]?.revision, 3);
  assert.equal(snapshots[0]?.revisionSource, "human");
  assert.equal(snapshots[0]?.executionId, null);
});

function mockClient(
  queries: CapturedQuery[],
  responder: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>
) {
  return {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return responder(sql, values);
    },
    release() {
      queries.push({ sql: "RELEASE" });
    }
  };
}

function mockPool(client: ReturnType<typeof mockClient>): pg.Pool {
  return {
    async connect() {
      return client;
    },
    query: client.query.bind(client)
  } as unknown as pg.Pool;
}
