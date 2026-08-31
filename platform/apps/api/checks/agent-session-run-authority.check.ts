import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type pg from "pg";

import { buildApp } from "../src/app.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";

test("Agent Session Run origin is public while generic and E2E execution fail closed", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-session-run-authority-"));
  const requestedRoot = path.join(parent, "project");
  await initializeCodexProject(
    requestedRoot,
    "Session Run authority",
    "Keep Provider-native execution attached to its Session",
  );
  const rootPath = await realpath(requestedRoot);
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const triggerMessageId = randomUUID();
  const associatedRunId = randomUUID();
  const completedRunId = randomUUID();
  const completedArtifactId = randomUUID();
  const standaloneRunId = randomUUID();
  const now = new Date("2026-08-29T12:00:00.000Z");
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT COALESCE(mw.root_path, p.root_path) AS root_path")) {
        if (String(values?.[0]) !== completedArtifactId) return { rows: [] };
        return { rows: [{
          root_path: rootPath,
          workflow_run_id: completedRunId,
          phase_id: "release",
        }] };
      }
      if (sql.includes("FROM workflow_runs wr JOIN projects")) {
        const runId = String(values?.[0]);
        if (![associatedRunId, completedRunId, standaloneRunId].includes(runId)) return { rows: [] };
        const associated = runId !== standaloneRunId;
        const completed = runId === completedRunId;
        return {
          rows: [{
            id: runId,
            project_id: projectId,
            title: associated ? "Session Run" : "Standalone Run",
            objective: "Validate server-owned execution authority",
            change_contract: null,
            status: completed ? "completed" : "active",
            artifact_paths: {},
            base_revision: null,
            definition_version: null,
            created_at: now,
            updated_at: now,
            p_id: projectId,
            p_name: "Session Run authority",
            p_summary: "Keep Provider-native execution attached to its Session",
            p_root_path: rootPath,
            p_config_path: path.join(rootPath, "ai-native.yaml"),
            p_source_kind: "legacy_local",
            p_repository_state: "ready",
            p_definition_mode: "repository",
            p_created_at: now,
            p_updated_at: now,
            asr_session_id: associated ? sessionId : null,
            asr_trigger_message_id: associated ? triggerMessageId : null,
            asr_workflow_run_id: associated ? runId : null,
            asr_created_at: associated ? now : null,
          }],
        };
      }
      if (sql.includes("FROM phase_runs WHERE workflow_run_id")) return { rows: [] };
      if (sql.includes("FROM tickets t")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as pg.Pool;
  const app = await buildApp({
    pool,
    logger: false,
    fakeCodex: true,
    allowedProjectRoots: [parent],
    recoverChatAgentRuntimeOnStart: false,
  });
  try {
    const associatedDetail = await app.inject({
      method: "GET",
      url: `/api/runs/${associatedRunId}`,
    });
    assert.equal(associatedDetail.statusCode, 200);
    assert.deepEqual(associatedDetail.json().agentSession, { sessionId });
    assert.equal("agentSessionRun" in associatedDetail.json(), false);

    const standaloneDetail = await app.inject({
      method: "GET",
      url: `/api/runs/${standaloneRunId}`,
    });
    assert.equal(standaloneDetail.statusCode, 200);
    assert.equal(standaloneDetail.json().agentSession, null);

    const completedTickets = await app.inject({
      method: "GET",
      url: `/api/runs/${completedRunId}/tickets`,
    });
    assert.equal(completedTickets.statusCode, 200);
    assert.deepEqual(completedTickets.json(), { tickets: [] });
    const completedTicketDetail = await app.inject({
      method: "GET",
      url: `/api/runs/${completedRunId}/tickets/${randomUUID()}`,
    });
    assert.equal(completedTicketDetail.statusCode, 404);
    assert.equal(completedTicketDetail.json().error.code, "NOT_FOUND");
    assert.equal(
      queries.some(({ sql }) => sql.includes("a.artifact_key = 'user-stories'")),
      false,
      "completed Session Ticket reads must not attempt lazy backfill from artifacts",
    );

    const immutableMutations = [
      await app.inject({
        method: "PATCH",
        url: `/api/runs/${completedRunId}/tickets/${randomUUID()}/status`,
        payload: { status: "done" },
      }),
      await app.inject({
        method: "POST",
        url: `/api/artifacts/${completedArtifactId}/revisions`,
        payload: {
          content: "# completed history must remain immutable",
          expectedContentHash: "a".repeat(64),
        },
      }),
      await app.inject({
        method: "POST",
        url: `/api/runs/${completedRunId}/phases/discovery/human-decisions`,
        payload: {
          responses: [{ id: "DECISION-1", response: "Keep the completed decision." }],
          expectedArtifactIds: [completedArtifactId],
        },
      }),
      await app.inject({
        method: "POST",
        url: `/api/runs/${completedRunId}/verification/e2e-flow/script-review`,
        payload: {
          decision: "approve",
          expectedPatchHash: "b".repeat(64),
          comment: "Completed review history must remain immutable.",
        },
      }),
    ];
    for (const response of immutableMutations) {
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json().error, {
        code: "AGENT_SESSION_RUN_COMPLETED_IMMUTABLE",
        message: "这条 Agent Session Run 已完成；产物、审核和决定历史保持只读",
        details: { sessionId },
      });
    }
    assert.equal(
      queries.some(({ sql }) => /(?:INTO|UPDATE) tickets\b/u.test(sql)),
      false,
      "completed Session Ticket reads and mutations must not synchronize Ticket state",
    );

    const executionRequests = [
      {
        url: `/api/runs/${associatedRunId}/phases/discovery/execute`,
        payload: { selectedArtifactIds: [] },
      },
      {
        url: `/api/runs/${associatedRunId}/phases/verification/execute`,
        payload: { selectedArtifactIds: [], verificationAction: "author_e2e" },
      },
      {
        url: `/api/runs/${associatedRunId}/phases/verification/execute`,
        payload: { selectedArtifactIds: [], verificationAction: "run_e2e" },
      },
      {
        url: `/api/runs/${associatedRunId}/verification/e2e-flow/author`,
        payload: { selectedArtifactIds: [randomUUID()] },
      },
      {
        url: `/api/runs/${associatedRunId}/verification/e2e-flow`,
        payload: { action: "execute", selectedArtifactIds: [randomUUID()] },
      },
    ];
    for (const request of executionRequests) {
      const response = await app.inject({ method: "POST", ...request });
      assert.equal(response.statusCode, 409, request.url);
      assert.deepEqual(response.json().error, {
        code: "AGENT_SESSION_RUN_REQUIRES_SESSION_ADVANCE",
        message: "这条 Run 属于 Agent Session；请回到对应 Session 使用继续操作，以继承所选 Provider 和对话上下文",
        details: { sessionId },
      });
    }

    const standalone = await app.inject({
      method: "POST",
      url: `/api/runs/${standaloneRunId}/phases/discovery/execute`,
      payload: { selectedArtifactIds: [triggerMessageId, triggerMessageId] },
    });
    assert.equal(standalone.statusCode, 400);
    assert.equal(standalone.json().error.code, "DUPLICATE_ARTIFACT_SELECTION");

    const review = await app.inject({
      method: "POST",
      url: `/api/runs/${associatedRunId}/phases/discovery/review`,
      payload: {
        decision: "request_changes",
        comment: "Review remains available for Session-owned Runs.",
        expectedArtifactIds: [randomUUID()],
      },
    });
    assert.equal(review.statusCode, 404);
    assert.equal(review.json().error.code, "PHASE_NOT_FOUND");
    assert.notEqual(review.json().error.code, "AGENT_SESSION_RUN_REQUIRES_SESSION_ADVANCE");

    assert.ok(
      queries.some(({ sql }) => sql.includes("LEFT JOIN agent_session_runs asr")),
      "Run origin must be resolved by the durable server-side association",
    );
  } finally {
    await app.close();
    await rm(parent, { recursive: true, force: true });
  }
});
