import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import YAML from "yaml";

import type { PgWorkflowStore, RunBundle } from "../src/db/store.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { loadDefinition } from "../src/services/definition-loader.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

test("AC1/Tier A: legacy Release approval remains executable without the DevOps v1 semantic pack", async () => {
  const fixture = await releaseFixture(false);
  try {
    const yamlBefore = await readFile(path.join(fixture.rootPath, "ai-native.yaml"), "utf8");
    assert.equal((await loadDefinition(fixture.rootPath)).releaseEvidenceValidationRequired, false);

    await fixture.service.reviewPhase(fixture.bundle.run.id, "release", {
      decision: "approve",
      comment: "Legacy release review remains governed by its original configured gate.",
      expectedArtifactIds: [fixture.artifactId],
    });

    assert.equal(fixture.store.snapshotCalls, 0, "legacy approval must not invoke the v1 validator");
    assert.equal(fixture.store.reviewCalls, 1);
    assert.equal(await readFile(path.join(fixture.rootPath, "ai-native.yaml"), "utf8"), yamlBefore);
  } finally {
    await fixture.cleanup();
  }
});

test("AC1/Tier A: a fresh DevOps v1 pack requires trusted execution bindings before approval", async () => {
  const fixture = await releaseFixture(true);
  try {
    assert.equal((await loadDefinition(fixture.rootPath)).releaseEvidenceValidationRequired, true);
    await assert.rejects(
      () => fixture.service.reviewPhase(fixture.bundle.run.id, "release", {
        decision: "approve",
        comment: "Approve only if the current runbook satisfies the semantic evidence contract.",
        expectedArtifactIds: [fixture.artifactId],
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "RELEASE_EVIDENCE_BINDINGS_REQUIRED");
        return true;
      },
    );
    assert.equal(fixture.store.snapshotCalls, 0);
    assert.equal(fixture.store.reviewCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});

class ReleaseReviewStore {
  snapshotCalls = 0;
  reviewCalls = 0;

  constructor(readonly bundle: RunBundle, readonly artifactId: string) {}

  async getRun(): Promise<RunBundle> {
    return this.bundle;
  }

  async currentArtifactSnapshotsForPhase() {
    this.snapshotCalls += 1;
    return [{
      ...this.bundle.phases[0]!.artifacts[0]!,
      content: "# Legacy release note\n",
    }];
  }

  async reviewPhase(
    _runId: string,
    _phaseId: string,
    decision: "approve" | "request_changes",
    comment: string,
    artifactIds: string[],
  ) {
    this.reviewCalls += 1;
    return {
      id: randomUUID(),
      phaseRunId: this.bundle.phases[0]!.id,
      decision,
      comment,
      artifactIds,
      createdAt: new Date().toISOString(),
    };
  }
}

async function releaseFixture(completeDevOpsPack: boolean) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-release-compat-"));
  const requestedRoot = path.join(parent, "project");
  await initializeCodexProject(requestedRoot, "Release compatibility", "Capability-gated Release review");
  const rootPath = await realpath(requestedRoot);
  if (!completeDevOpsPack) {
    await rm(path.join(rootPath, ".ai-sdlc", "roles", "devops"), {
      recursive: true,
      force: true,
    });
    await rm(path.join(rootPath, ".ai-sdlc", "templates", "release-runbook.md"), {
      force: true,
    });
    await writeFile(
      path.join(rootPath, "ai-native.yaml"),
      YAML.stringify(legacyDefinition()),
      "utf8",
    );
  }
  const now = new Date().toISOString();
  const artifactId = randomUUID();
  const phaseRunId = randomUUID();
  const project = {
    id: randomUUID(),
    name: "Release compatibility",
    summary: "Capability-gated Release review",
    rootPath,
    configPath: path.join(rootPath, "ai-native.yaml"),
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const bundle = {
    project,
    run: {
      id: randomUUID(),
      projectId: project.id,
      title: "Release compatibility",
      objective: "Preserve legacy review while gating the v1 pack",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    },
    phases: [{
      id: phaseRunId,
      workflowRunId: "placeholder",
      phaseId: "release" as const,
      position: 5,
      status: "awaiting_review" as const,
      artifacts: [{
        id: artifactId,
        phaseRunId,
        artifactKey: "release-runbook",
        filePath: "docs/ai-native/operations/release-runbook.md",
        contentHash: "legacy-hash",
        reviewStatus: "pending" as const,
        revision: 1,
        revisionSource: "ai" as const,
        parentArtifactId: null,
        createdAt: now,
      }],
      reviews: [],
      executions: [],
      events: [],
      availableArtifacts: [],
      createdAt: now,
      updatedAt: now,
    }],
    artifactPaths: {},
  } as unknown as RunBundle;
  bundle.phases[0]!.workflowRunId = bundle.run.id;
  const store = new ReleaseReviewStore(bundle, artifactId);
  const service = new WorkflowService(
    store as unknown as PgWorkflowStore,
    new ProjectPathPolicy([parent]),
    new CodexTerminalRunner({ fake: true }),
  );
  return {
    rootPath,
    bundle,
    artifactId,
    store,
    service,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

function legacyDefinition() {
  const roles = [
    "pm-ba",
    "designer",
    "architect",
    "software-engineer",
    "tester",
    "devops",
  ];
  return {
    version: 1,
    project: {
      name: "Legacy Release compatibility",
      summary: "Definition from before the DevOps v1 evidence pack",
    },
    agent: { client: "codex" },
    paths: { agents: ".codex/agents", outputs: "docs" },
    roles: roles.map((id) => ({
      id,
      name: id,
      mission: id,
      responsibilities: [],
    })),
    workflow: {
      phases: [
        { id: "discovery", owner: "pm-ba", inputs: [], outputs: ["prd", "user-stories"], gate: "review" },
        { id: "design", owner: "designer", inputs: ["prd", "user-stories"], outputs: ["design-baseline", "design-spec"], gate: "review" },
        { id: "architecture", owner: "architect", inputs: ["design-spec"], outputs: ["architecture"], gate: "review" },
        { id: "implementation", owner: "software-engineer", inputs: ["design-baseline", "architecture"], outputs: ["implementation-notes"], gate: "review" },
        { id: "verification", owner: "tester", inputs: ["implementation-notes"], outputs: ["test-report"], gate: "review" },
        { id: "release", owner: "devops", inputs: ["test-report"], outputs: ["release-runbook"], gate: "review" },
      ],
    },
    artifacts: [
      { id: "prd", owner: "pm-ba", path: "prd.md" },
      { id: "user-stories", owner: "pm-ba", path: "user-stories" },
      { id: "design-baseline", owner: "designer", path: "DESIGN_BASELINE.md" },
      { id: "design-spec", owner: "designer", path: "design-spec.md" },
      { id: "architecture", owner: "architect", path: "architecture.md" },
      { id: "implementation-notes", owner: "software-engineer", path: "implementation-notes.md" },
      { id: "test-report", owner: "tester", path: "test-report.md" },
      { id: "release-runbook", owner: "devops", path: "release-runbook.md" },
    ],
  };
}
