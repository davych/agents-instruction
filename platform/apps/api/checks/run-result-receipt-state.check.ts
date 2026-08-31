import assert from "node:assert/strict";
import test from "node:test";

import { deriveRunResultState } from "../src/services/workflow-service.ts";

const oldFailure = {
  status: "failed" as const,
  error: "old provider failure",
  createdAt: "2026-08-31T06:05:44.000Z",
  startedAt: "2026-08-31T06:05:44.000Z",
};
const latestSuccess = {
  status: "completed" as const,
  error: null,
  createdAt: "2026-08-31T08:07:36.000Z",
  startedAt: "2026-08-31T08:07:36.000Z",
};

test("Result Receipt treats a recovered historical failure as audit history, not current risk", () => {
  const state = deriveRunResultState({
    runStatus: "active",
    targetPhaseId: null,
    phases: [
      { phaseId: "discovery", status: "approved", executions: [oldFailure] },
      { phaseId: "design", status: "approved", executions: [] },
      { phaseId: "architecture", status: "approved", executions: [] },
      {
        phaseId: "implementation",
        status: "awaiting_review",
        executions: [oldFailure, latestSuccess],
      },
      { phaseId: "verification", status: "pending", executions: [] },
      { phaseId: "release", status: "pending", executions: [] },
    ],
  });

  assert.deepEqual(state, {
    outcome: "blocked",
    currentPhaseId: "implementation",
    unresolvedExecutionErrors: [],
  });
});

test("Result Receipt exposes only the current phase latest unresolved failure", () => {
  const state = deriveRunResultState({
    runStatus: "active",
    phases: [{
      phaseId: "implementation",
      status: "failed",
      executions: [latestSuccess, {
        ...oldFailure,
        error: "current safe failure",
        createdAt: "2026-08-31T09:00:00.000Z",
      }],
    }],
  });

  assert.deepEqual(state, {
    outcome: "failed",
    currentPhaseId: "implementation",
    unresolvedExecutionErrors: ["current safe failure"],
  });
});

test("a completed Run is never downgraded by historical failed executions", () => {
  const state = deriveRunResultState({
    runStatus: "completed",
    targetPhaseId: "implementation",
    phases: [{
      phaseId: "implementation",
      status: "approved",
      executions: [oldFailure, latestSuccess],
    }],
  });

  assert.deepEqual(state, {
    outcome: "completed",
    currentPhaseId: "implementation",
    unresolvedExecutionErrors: [],
  });
});
