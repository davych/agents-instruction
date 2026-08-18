import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ArchitectureImpactDto,
  ArtifactDto,
  PhaseRunDto,
  ProjectDto,
  WorkflowRunDto,
} from "@ai-sdlc/contracts";
import type pg from "pg";

import type {
  CurrentArtifactSnapshot,
  PgWorkflowStore,
  RunBundle,
  SelectionArtifact,
} from "../src/db/store.ts";
import { PgWorkflowStore as WorkflowStore } from "../src/db/store.ts";
import { AppError } from "../src/domain/errors.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

const sourceCreatedAt = "2026-08-18T07:00:00.000Z";
const assessedAt = "2026-08-18T08:00:00.000Z";
const changedAt = "2026-08-18T08:10:00.000Z";

const architectureFiles: Record<string, { filePath: string; content: string }> = {
  architecture: {
    filePath: "docs/ai-native/architecture/architecture.md",
    content: "# Architecture\n\nApproved baseline.\n",
  },
  "architecture-discovery-context": {
    filePath: "docs/ai-native/architecture/00-discovery-context.md",
    content: "# Discovery Context\n\nApproved scope.\n",
  },
  "architecture-options": {
    filePath: "docs/ai-native/architecture/00-options.md",
    content: "# Architecture Options\n\n## Option A: Existing direction\n\nApproved.\n",
  },
  "architecture-c4-context": {
    filePath: "docs/ai-native/architecture/01-context.mmd",
    content: "flowchart LR\n  User --> System\n",
  },
  "architecture-c4-containers": {
    filePath: "docs/ai-native/architecture/02-containers.mmd",
    content: "flowchart LR\n  Web --> API\n",
  },
  "architecture-adrs": {
    filePath: "docs/ai-native/architecture/04-adrs",
    content: "## README.md\n\n# Architecture decisions\n",
  },
  "architecture-patterns": {
    filePath: "docs/ai-native/architecture/05-patterns.md",
    content: "# Patterns\n\nApproved patterns.\n",
  },
  "architecture-nfrs": {
    filePath: "docs/ai-native/architecture/06-nfrs.md",
    content: "# NFRs\n\nApproved budgets.\n",
  },
  "architecture-adversarial": {
    filePath: "docs/ai-native/architecture/07-adversarial.md",
    content: "# Adversarial review\n\nNo open blockers.\n",
  },
};

test("partial architecture blocks an out-of-scope human revision before touching the file", async () => {
  const fixture = await impactProject();
  try {
    const entities = workflowEntities(fixture.root);
    const sourceIds = sourceArtifactIds();
    const artifacts = adoptedArchitectureArtifacts(entities.architecturePhaseId, sourceIds);
    const options = artifacts.find(
      (artifact) => artifact.artifactKey === "architecture-options",
    )!;
    const impact = architectureImpact("partial", sourceIds, ["architecture"]);
    const architecturePhase = phaseRun(
      entities.run.id,
      entities.architecturePhaseId,
      "architecture",
      2,
      "changes_requested",
      artifacts,
      impact,
    );
    const bundle: RunBundle = {
      project: entities.project,
      run: entities.run,
      phases: [architecturePhase],
      artifactPaths: {},
    };
    await materializeSnapshot(fixture.root, options);
    let persisted = false;
    const store = {
      artifactWorkspace: async () => ({
        rootPath: fixture.root,
        workflowRunId: entities.run.id,
        phaseId: "architecture" as const,
      }),
      getRun: async () => bundle,
      getPhase: async () => architecturePhase,
      getArtifact: async () => options,
      createHumanArtifactRevision: async () => {
        persisted = true;
        throw new AppError("should not persist", 500, "UNEXPECTED_REVISION_PERSISTED");
      },
    };
    const service = workflowService(store, fixture);
    const nextContent = `${options.content}Out-of-scope edit.\n`;

    await assert.rejects(
      () => service.createArtifactRevision(options.id, {
        expectedContentHash: options.contentHash,
        content: nextContent,
      }),
      hasCode("ARCHITECTURE_IMPACT_SCOPE_EXCEEDED"),
    );
    assert.equal(persisted, false);
    assert.equal(
      await readFile(path.join(fixture.root, options.filePath), "utf8"),
      options.content,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("store transaction independently blocks an out-of-scope partial revision", async () => {
  const artifactId = randomUUID();
  const phaseRunId = randomUUID();
  const sourceIds = sourceArtifactIds();
  const impact = architectureImpact("partial", sourceIds, ["architecture"]);
  const queries: string[] = [];
  const row = {
    id: artifactId,
    phase_run_id: phaseRunId,
    execution_id: null,
    artifact_key: "architecture-nfrs",
    file_path: architectureFiles["architecture-nfrs"]!.filePath,
    content_snapshot: architectureFiles["architecture-nfrs"]!.content,
    content_hash: sha256(architectureFiles["architecture-nfrs"]!.content),
    review_status: "changes_requested",
    revision: 1,
    revision_source: "human",
    parent_artifact_id: sourceIds["architecture-nfrs"],
    created_at: new Date(sourceCreatedAt),
    workflow_run_id: randomUUID(),
    position: 2,
    phase_status: "changes_requested",
    architecture_impact: impact,
  };
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("FOR UPDATE OF a, pr")) return { rows: [row] };
      if (sql.includes("ORDER BY revision DESC")) {
        return { rows: [{ id: artifactId, revision: 1 }] };
      }
      if (sql.includes("INSERT INTO artifacts")) {
        return {
          rows: [{
            ...row,
            id: randomUUID(),
            content_snapshot: "tampered",
            content_hash: sha256("tampered"),
            revision: 2,
            parent_artifact_id: artifactId,
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new WorkflowStore({
    async connect() { return client; },
  } as unknown as pg.Pool);

  await assert.rejects(
    () => store.createHumanArtifactRevision(
      artifactId,
      row.content_hash,
      "tampered",
      sha256("tampered"),
    ),
    hasCode("ARCHITECTURE_IMPACT_SCOPE_EXCEEDED"),
  );
  assert.ok(queries.includes("ROLLBACK"));
  assert.equal(queries.some((sql) => sql.includes("INSERT INTO artifacts")), false);
});

test("inherited architecture selection stays bound to the current options clone and content", async () => {
  const fixture = await impactProject();
  try {
    const entities = workflowEntities(fixture.root);
    const sourceIds = sourceArtifactIds();
    const base = adoptedArchitectureArtifacts(entities.architecturePhaseId, sourceIds);
    const optionsIndex = base.findIndex(
      (artifact) => artifact.artifactKey === "architecture-options",
    );
    const impact = architectureImpact("partial", sourceIds, ["architecture"]);
    let reviewPersisted = false;
    let currentArtifacts: CurrentArtifactSnapshot[] = [];
    const architecturePhase = phaseRun(
      entities.run.id,
      entities.architecturePhaseId,
      "architecture",
      2,
      "awaiting_review",
      [],
      impact,
    );
    const bundle: RunBundle = {
      project: entities.project,
      run: entities.run,
      phases: [architecturePhase],
      artifactPaths: {},
    };
    const store = {
      getRun: async () => bundle,
      getArtifact: async (id: string) => {
        const artifact = currentArtifacts.find((candidate) => candidate.id === id);
        assert.ok(artifact);
        return artifact;
      },
      reviewPhase: async () => {
        reviewPersisted = true;
        throw new AppError("should not review", 500, "UNEXPECTED_REVIEW_PERSISTED");
      },
    };
    const service = workflowService(store, fixture);
    const cases: Array<{
      name: string;
      expectedCode: string;
      options: CurrentArtifactSnapshot;
    }> = [
      {
        name: "replacement revision",
        expectedCode: "ARCHITECTURE_IMPACT_BASELINE_DIVERGED",
        options: {
          ...base[optionsIndex]!,
          id: randomUUID(),
          revision: 2,
          parentArtifactId: base[optionsIndex]!.id,
          createdAt: changedAt,
        },
      },
      {
        name: "content no longer documents the inherited option",
        expectedCode: "ARCHITECTURE_SELECTION_REQUIRED",
        options: withContent(
          base[optionsIndex]!,
          "# Architecture Options\n\n## Option B: Changed direction\n",
        ),
      },
    ];

    for (const scenario of cases) {
      reviewPersisted = false;
      currentArtifacts = base.map((candidate, index) =>
        index === optionsIndex ? scenario.options : candidate
      );
      architecturePhase.artifacts = currentArtifacts;
      await assert.rejects(
        () => service.reviewPhase(entities.run.id, "architecture", {
          decision: "approve",
          comment: `Must reject ${scenario.name}`,
          expectedArtifactIds: currentArtifacts.map((artifact) => artifact.id),
        }),
        hasCode(scenario.expectedCode),
        scenario.name,
      );
      assert.equal(reviewPersisted, false, scenario.name);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("partial approval rejects a mutated head outside affectedOutputKeys", async () => {
  const fixture = await impactProject();
  try {
    const entities = workflowEntities(fixture.root);
    const sourceIds = sourceArtifactIds();
    const artifacts = adoptedArchitectureArtifacts(entities.architecturePhaseId, sourceIds);
    const architecture = artifacts.find((artifact) => artifact.artifactKey === "architecture")!;
    Object.assign(architecture, {
      id: randomUUID(),
      revision: 2,
      parentArtifactId: randomUUID(),
      createdAt: changedAt,
    });
    const nfrs = artifacts.find((artifact) => artifact.artifactKey === "architecture-nfrs")!;
    Object.assign(nfrs, {
      id: randomUUID(),
      revision: 2,
      parentArtifactId: randomUUID(),
      createdAt: changedAt,
    });
    const architecturePhase = phaseRun(
      entities.run.id,
      entities.architecturePhaseId,
      "architecture",
      2,
      "awaiting_review",
      artifacts,
      architectureImpact("partial", sourceIds, ["architecture"]),
    );
    const bundle: RunBundle = {
      project: entities.project,
      run: entities.run,
      phases: [architecturePhase],
      artifactPaths: {},
    };
    await materializeSnapshots(fixture.root, artifacts);
    let reviewPersisted = false;
    const store = {
      getRun: async () => bundle,
      getArtifact: async (id: string) => {
        const artifact = artifacts.find((candidate) => candidate.id === id);
        assert.ok(artifact);
        return artifact;
      },
      currentArtifactSnapshotsForPhase: async () => artifacts,
      reviewPhase: async () => {
        reviewPersisted = true;
        throw new AppError("should not review", 500, "UNEXPECTED_REVIEW_PERSISTED");
      },
    };
    const service = workflowService(store, fixture);

    await assert.rejects(
      () => service.reviewPhase(entities.run.id, "architecture", {
        decision: "approve",
        comment: "Reject an out-of-scope inherited head mutation",
        expectedArtifactIds: artifacts.map((artifact) => artifact.id),
      }),
      hasCode("ARCHITECTURE_IMPACT_BASELINE_DIVERGED"),
    );
    assert.equal(reviewPersisted, false);
  } finally {
    await fixture.cleanup();
  }
});

test("downstream execution rejects a reused architecture snapshot that diverged on disk", async () => {
  const fixture = await impactProject();
  try {
    const entities = workflowEntities(fixture.root);
    const sourceIds = sourceArtifactIds();
    const architectureArtifacts = adoptedArchitectureArtifacts(
      entities.architecturePhaseId,
      sourceIds,
      "approved",
    );
    const architecturePhase = phaseRun(
      entities.run.id,
      entities.architecturePhaseId,
      "architecture",
      2,
      "approved",
      architectureArtifacts,
      architectureImpact("reuse", sourceIds, []),
    );
    const implementationPhase = phaseRun(
      entities.run.id,
      randomUUID(),
      "implementation",
      3,
      "ready",
      [],
      null,
    );
    const bundle: RunBundle = {
      project: entities.project,
      run: entities.run,
      phases: [architecturePhase, implementationPhase],
      artifactPaths: {},
    };
    const selected = implementationInputs(entities.run.id, architectureArtifacts);
    const architecture = selected.find((artifact) => artifact.artifactKey === "architecture")!;
    await materializeText(
      fixture.root,
      architecture.filePath,
      "# Architecture\n\nAnother run changed this shared path.\n",
    );
    const store = {
      getRun: async () => bundle,
      selectionArtifacts: async (_runId: string, ids: string[]) => ids.map((id) => {
        const artifact = selected.find((candidate) => candidate.id === id);
        assert.ok(artifact);
        return artifact;
      }),
      currentArtifactSnapshotsForPhase: async (_runId: string, phaseId: string) =>
        phaseId === "architecture" ? architectureArtifacts : [],
      createExecution: async () => {
        throw new AppError("should not execute", 500, "UNEXPECTED_EXECUTION_CREATED");
      },
    };
    const service = workflowService(store, fixture);
    const orderedIds = [
      architecture.id,
      ...selected.filter((artifact) => artifact.id !== architecture.id).map((artifact) => artifact.id),
    ];

    await assert.rejects(
      () => service.executePhase(entities.run.id, "implementation", {
        selectedArtifactIds: orderedIds,
      }),
      hasCode("ARTIFACT_WORKSPACE_SNAPSHOT_MISMATCH"),
    );
    await rm(path.join(fixture.root, architecture.filePath));
    await assert.rejects(
      () => service.executePhase(entities.run.id, "implementation", {
        selectedArtifactIds: orderedIds,
      }),
      hasCode("ARTIFACT_WORKSPACE_SNAPSHOT_MISMATCH"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("downstream review rejects a reused architecture snapshot that diverged on disk", async () => {
  const fixture = await impactProject();
  try {
    const entities = workflowEntities(fixture.root);
    const sourceIds = sourceArtifactIds();
    const architectureArtifacts = adoptedArchitectureArtifacts(
      entities.architecturePhaseId,
      sourceIds,
      "approved",
    );
    const architecturePhase = phaseRun(
      entities.run.id,
      entities.architecturePhaseId,
      "architecture",
      2,
      "approved",
      architectureArtifacts,
      architectureImpact("reuse", sourceIds, []),
    );
    const noteContent = "# Implementation notes\n";
    const implementationArtifact = artifact({
      phaseRunId: randomUUID(),
      artifactKey: "implementation-notes",
      filePath: "docs/ai-native/engineering/implementation-notes.md",
      content: noteContent,
      reviewStatus: "pending",
      revision: 1,
      parentArtifactId: null,
      createdAt: changedAt,
    });
    const implementationPhase = phaseRun(
      entities.run.id,
      implementationArtifact.phaseRunId,
      "implementation",
      3,
      "awaiting_review",
      [implementationArtifact],
      null,
    );
    const bundle: RunBundle = {
      project: entities.project,
      run: entities.run,
      phases: [architecturePhase, implementationPhase],
      artifactPaths: {},
    };
    await materializeText(
      fixture.root,
      architectureFiles.architecture!.filePath,
      "# Architecture\n\nAnother run changed this shared path.\n",
    );
    let reviewPersisted = false;
    const store = {
      getRun: async () => bundle,
      currentArtifactSnapshotsForPhase: async (_runId: string, phaseId: string) =>
        phaseId === "architecture" ? architectureArtifacts : [implementationArtifact],
      reviewPhase: async () => {
        reviewPersisted = true;
        throw new AppError("should not review", 500, "UNEXPECTED_REVIEW_PERSISTED");
      },
    };
    const service = workflowService(store, fixture);

    await assert.rejects(
      () => service.reviewPhase(entities.run.id, "implementation", {
        decision: "approve",
        comment: "Implementation is ready",
        expectedArtifactIds: [implementationArtifact.id],
      }),
      hasCode("ARTIFACT_WORKSPACE_SNAPSHOT_MISMATCH"),
    );
    assert.equal(reviewPersisted, false);
  } finally {
    await fixture.cleanup();
  }
});

function workflowService(store: object, fixture: ImpactProject): WorkflowService {
  return new WorkflowService(
    store as PgWorkflowStore,
    new ProjectPathPolicy([fixture.parent]),
    new CodexTerminalRunner({ fake: true }),
  );
}

function workflowEntities(root: string): {
  project: ProjectDto;
  run: WorkflowRunDto;
  architecturePhaseId: string;
} {
  const now = changedAt;
  const project: ProjectDto = {
    id: randomUUID(),
    name: "Impact adversarial",
    summary: "Verify architecture baseline isolation",
    rootPath: root,
    configPath: path.join(root, "ai-native.yaml"),
    runCount: 2,
    createdAt: now,
    updatedAt: now,
  };
  return {
    project,
    run: {
      id: randomUUID(),
      projectId: project.id,
      title: "Small requirement",
      objective: "Reuse the existing architecture safely",
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
    architecturePhaseId: randomUUID(),
  };
}

function phaseRun(
  workflowRunId: string,
  id: string,
  phaseId: PhaseRunDto["phaseId"],
  position: number,
  status: PhaseRunDto["status"],
  artifacts: ArtifactDto[],
  architectureImpact: ArchitectureImpactDto | null,
): PhaseRunDto {
  return {
    id,
    workflowRunId,
    phaseId,
    position,
    status,
    artifacts,
    reviews: [],
    executions: [],
    events: [],
    availableArtifacts: [],
    architectureImpact,
    createdAt: sourceCreatedAt,
    updatedAt: changedAt,
  };
}

function sourceArtifactIds(): Record<string, string> {
  return Object.fromEntries(
    Object.keys(architectureFiles).map((artifactKey) => [artifactKey, randomUUID()]),
  );
}

function architectureImpact(
  mode: "reuse" | "partial",
  sourceIds: Record<string, string>,
  affectedOutputKeys: string[],
): ArchitectureImpactDto {
  return {
    mode,
    rationale: "The approved architecture remains compatible with the current requirement.",
    sourceRunId: randomUUID(),
    sourceRunTitle: "Approved architecture baseline",
    sourcePhaseRunId: randomUUID(),
    sourceArtifactIds: Object.keys(architectureFiles).map((key) => sourceIds[key]!),
    inputArtifactIds: [randomUUID()],
    affectedOutputKeys,
    assessedAt,
    selection: {
      optionId: "A",
      reviewId: randomUUID(),
      optionsArtifactId: sourceIds["architecture-options"]!,
      selectedAt: sourceCreatedAt,
    },
  };
}

function adoptedArchitectureArtifacts(
  phaseRunId: string,
  sourceIds: Record<string, string>,
  reviewStatus: ArtifactDto["reviewStatus"] = "changes_requested",
): CurrentArtifactSnapshot[] {
  return Object.entries(architectureFiles).map(([artifactKey, file]) => artifact({
    phaseRunId,
    artifactKey,
    filePath: file.filePath,
    content: file.content,
    reviewStatus,
    revision: 1,
    parentArtifactId: sourceIds[artifactKey]!,
    createdAt: sourceCreatedAt,
  }));
}

function artifact(input: {
  phaseRunId: string;
  artifactKey: string;
  filePath: string;
  content: string;
  reviewStatus: ArtifactDto["reviewStatus"];
  revision: number;
  parentArtifactId: string | null;
  createdAt: string;
}): CurrentArtifactSnapshot {
  return {
    id: randomUUID(),
    phaseRunId: input.phaseRunId,
    artifactKey: input.artifactKey,
    filePath: input.filePath,
    content: input.content,
    contentHash: sha256(input.content),
    reviewStatus: input.reviewStatus,
    revision: input.revision,
    revisionSource: "human",
    parentArtifactId: input.parentArtifactId,
    createdAt: input.createdAt,
  };
}

function withContent(
  artifactSnapshot: CurrentArtifactSnapshot,
  content: string,
): CurrentArtifactSnapshot {
  return {
    ...artifactSnapshot,
    content,
    contentHash: sha256(content),
  };
}

function implementationInputs(
  workflowRunId: string,
  architectureArtifacts: CurrentArtifactSnapshot[],
): SelectionArtifact[] {
  const required: Array<[string, number]> = [
    ["prd", 0],
    ["user-stories", 0],
    ["design-baseline", 1],
    ["design-spec", 1],
    ["architecture", 2],
    ["architecture-c4-containers", 2],
    ["architecture-adrs", 2],
    ["architecture-patterns", 2],
    ["architecture-nfrs", 2],
  ];
  return required.map(([artifactKey, sourcePosition]) => {
    const architectureArtifact = architectureArtifacts.find(
      (candidate) => candidate.artifactKey === artifactKey,
    );
    const snapshot = architectureArtifact ?? artifact({
      phaseRunId: randomUUID(),
      artifactKey,
      filePath: `docs/inputs/${artifactKey}.md`,
      content: `# ${artifactKey}\n`,
      reviewStatus: "approved",
      revision: 1,
      parentArtifactId: null,
      createdAt: sourceCreatedAt,
    });
    return {
      ...snapshot,
      sourcePosition,
      sourceStatus: "approved" as const,
      workflowRunId,
    };
  });
}

async function materializeSnapshots(
  root: string,
  artifacts: CurrentArtifactSnapshot[],
): Promise<void> {
  for (const artifactSnapshot of artifacts) {
    await materializeSnapshot(root, artifactSnapshot);
  }
}

async function materializeSnapshot(
  root: string,
  artifactSnapshot: CurrentArtifactSnapshot,
): Promise<void> {
  if (artifactSnapshot.artifactKey === "architecture-adrs") {
    const directory = path.join(root, artifactSnapshot.filePath);
    await mkdir(directory, { recursive: true });
    const readme = artifactSnapshot.content.replace(/^## README\.md\n\n/u, "");
    await writeFile(path.join(directory, "README.md"), readme, "utf8");
    return;
  }
  await materializeText(root, artifactSnapshot.filePath, artifactSnapshot.content);
}

async function materializeText(root: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

interface ImpactProject {
  parent: string;
  root: string;
  cleanup: () => Promise<void>;
}

async function impactProject(): Promise<ImpactProject> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-impact-adversarial-"));
  const requestedRoot = path.join(parent, "project");
  await initializeCodexProject(requestedRoot, "Impact adversarial", "Validate safe reuse");
  const root = await realpath(requestedRoot);
  const configPath = path.join(root, ".ai-sdlc", "roles", "architect", "config.yaml");
  const config = await readFile(configPath, "utf8");
  await writeFile(configPath, config.replace("validation: required", "validation: advisory"));
  return {
    parent,
    root,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error: unknown) => (error as { code?: string }).code === expected;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
