import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PgWorkflowStore, RunBundle } from "../src/db/store.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

type ImpactInvocation = (service: WorkflowService, runId: string) => Promise<unknown>;

const impactInvocations: ReadonlyArray<[string, ImpactInvocation]> = [
  ["Product impact", (service, runId) => service.assessProductImpact(runId, {
    mode: "direct",
    rationale: "The completed Session history must remain immutable.",
    selectedArtifactIds: [],
    expectedBaselineArtifactIds: [],
    affectedOutputKeys: [],
  })],
  ["Design impact", (service, runId) => service.assessDesignImpact(runId, {
    mode: "skip",
    rationale: "The completed Session history must remain immutable.",
    selectedArtifactIds: [],
    expectedBaselineArtifactIds: [],
    affectedOutputKeys: [],
  })],
  ["Architecture impact", (service, runId) => service.assessArchitectureImpact(runId, {
    mode: "reuse",
    rationale: "The completed Session history must remain immutable.",
    selectedArtifactIds: [],
    expectedBaselineArtifactIds: [],
    affectedOutputKeys: [],
  })],
  ["Architecture waiver", (service, runId) => service.waiveArchitecture(runId, {
    mode: "skip",
    rationale: "The completed Session history must remain immutable.",
    selectedArtifactIds: [],
    expectedBaselineArtifactIds: [],
    affectedOutputKeys: [],
  })],
];

test("completed Session Runs reject every impact and waiver before phase work", async () => {
  const fixture = await serviceFixture((active) => ({ ...active, run: {
    ...active.run,
    status: "completed",
  } }));
  try {
    for (const [label, invoke] of impactInvocations) {
      const before = fixture.getRunCalls();
      await assertImmutable(invoke(fixture.service, fixture.runId), fixture.sessionId, label);
      assert.equal(fixture.getRunCalls(), before + 1, `${label} must fail on the initial read`);
    }
  } finally {
    await fixture.dispose();
  }
});

test("impact and waiver recheck completed Session ownership after taking the workspace lock", async () => {
  for (const [label, invoke] of impactInvocations) {
    const fixture = await serviceFixture((active, call) => call === 1
      ? active
      : { ...active, run: { ...active.run, status: "completed" } });
    try {
      await assertImmutable(invoke(fixture.service, fixture.runId), fixture.sessionId, label);
      assert.equal(fixture.getRunCalls(), 2, `${label} must re-read state inside the workspace lock`);
    } finally {
      await fixture.dispose();
    }
  }
});

async function assertImmutable(
  promise: Promise<unknown>,
  sessionId: string,
  label: string,
): Promise<void> {
  await assert.rejects(
    () => promise,
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AGENT_SESSION_RUN_COMPLETED_IMMUTABLE", label);
      assert.deepEqual((error as { details?: unknown }).details, { sessionId }, label);
      return true;
    },
  );
}

async function serviceFixture(
  bundleForCall: (active: RunBundle, call: number) => RunBundle,
): Promise<{
  runId: string;
  sessionId: string;
  service: WorkflowService;
  getRunCalls(): number;
  dispose(): Promise<void>;
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-completed-impact-"));
  const root = await realpath(parent);
  const runId = randomUUID();
  const sessionId = randomUUID();
  const now = "2026-08-29T08:00:00.000Z";
  const active = {
    run: {
      id: runId,
      projectId: randomUUID(),
      title: "Legacy inconsistent completed Session Run",
      objective: "Keep every completion boundary immutable",
      changeContract: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
    project: {
      id: randomUUID(),
      name: "Completion guard",
      summary: "Completion guard",
      rootPath: root,
      configPath: path.join(root, "ai-native.yaml"),
      runCount: 1,
      createdAt: now,
      updatedAt: now,
    },
    phases: [],
    artifactPaths: {},
    agentSessionRun: {
      sessionId,
      triggerMessageId: randomUUID(),
      workflowRunId: runId,
      createdAt: now,
    },
  } as RunBundle;
  let calls = 0;
  const store = {
    async getRun(candidateRunId: string) {
      assert.equal(candidateRunId, runId);
      calls += 1;
      return bundleForCall(active, calls);
    },
  } as unknown as PgWorkflowStore;
  return {
    runId,
    sessionId,
    service: new WorkflowService(
      store,
      new ProjectPathPolicy([root]),
      new CodexTerminalRunner({ fake: true }),
    ),
    getRunCalls: () => calls,
    async dispose() {
      await rm(parent, { recursive: true, force: true });
    },
  };
}
