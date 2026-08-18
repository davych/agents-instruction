import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  PhaseRunDto,
  ProjectDto,
  ReviewDto,
  WorkflowRunDto,
} from "@ai-sdlc/contracts";

import type {
  AdoptArchitectureBaselineInput,
  ArchitectureBaselineRecord,
  PgWorkflowStore,
  RunBundle,
  SelectionArtifact,
} from "../src/db/store.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

const architectureFiles: Record<string, { filePath: string; content: string }> = {
  architecture: {
    filePath: "docs/ai-native/architecture/architecture.md",
    content: "# Architecture\n\nApproved project baseline.\n",
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

test("architecture impact exposes an approved baseline and adopts reuse or a scoped partial update", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-architecture-impact-"));
  const requestedRoot = path.join(parent, "sample");
  try {
    await initializeCodexProject(requestedRoot, "Impact service", "Reuse a project architecture baseline");
    const root = await realpath(requestedRoot);
    const configPath = path.join(root, ".ai-sdlc", "roles", "architect", "config.yaml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, config.replace("validation: required", "validation: advisory"));
    await materializeArchitectureFiles(root);

    const fixture = impactFixture(root);
    await materializeInputFiles(root, fixture.inputs);
    const store = new ImpactMemoryStore(fixture.bundle, fixture.inputs, fixture.baseline);
    const service = new WorkflowService(
      store as unknown as PgWorkflowStore,
      new ProjectPathPolicy([parent]),
      new CodexTerminalRunner({ fake: true }),
    );

    const detail = await service.getRun(fixture.bundle.run.id);
    assert.equal(detail.architectureBaseline?.sourceRunId, fixture.baseline.sourceRunId);
    assert.equal(detail.architectureBaseline?.selection.optionId, "A");
    assert.equal(detail.architectureBaseline?.artifacts.length, 9);

    const selectedArtifactIds = fixture.inputs.map((artifact) => artifact.id);
    const expectedBaselineArtifactIds = fixture.baseline.artifacts.map((artifact) => artifact.id);
    const firstInput = fixture.inputs[0]!;
    await writeFile(path.join(root, firstInput.filePath), "# externally changed input\n");
    await assert.rejects(
      () => service.assessArchitectureImpact(fixture.bundle.run.id, {
        mode: "reuse",
        rationale: "工作区输入与已批准快照不一致时不能复用架构。",
        selectedArtifactIds,
        expectedBaselineArtifactIds,
        affectedOutputKeys: [],
      }),
      (error: unknown) => (
        (error as { code?: string }).code === "ARTIFACT_WORKSPACE_SNAPSHOT_MISMATCH"
      ),
    );
    await writeFile(path.join(root, firstInput.filePath), firstInput.content);
    await service.assessArchitectureImpact(fixture.bundle.run.id, {
      mode: "reuse",
      rationale: "本次只调整文案，不改变系统边界、数据流或质量属性。",
      selectedArtifactIds,
      expectedBaselineArtifactIds,
      affectedOutputKeys: [],
    });
    assert.equal(store.adoptions.length, 1);
    assert.equal(store.adoptions[0]?.impact.mode, "reuse");
    assert.deepEqual(store.adoptions[0]?.impact.inputArtifactIds, selectedArtifactIds);

    const partialFixture = impactFixture(root);
    const partialStore = new ImpactMemoryStore(
      partialFixture.bundle,
      partialFixture.inputs,
      partialFixture.baseline,
    );
    const partialService = new WorkflowService(
      partialStore as unknown as PgWorkflowStore,
      new ProjectPathPolicy([parent]),
      new CodexTerminalRunner({ fake: true }),
    );
    await partialService.assessArchitectureImpact(partialFixture.bundle.run.id, {
      mode: "partial",
      rationale: "新增内部 API，仅更新架构索引和容器边界，其余决策继续适用。",
      selectedArtifactIds: partialFixture.inputs.map((artifact) => artifact.id),
      expectedBaselineArtifactIds: partialFixture.baseline.artifacts.map((artifact) => artifact.id),
      affectedOutputKeys: ["architecture", "architecture-c4-containers"],
    });
    assert.deepEqual(partialStore.adoptions[0]?.impact.affectedOutputKeys, [
      "architecture",
      "architecture-c4-containers",
    ]);

    await assert.rejects(
      () => partialService.assessArchitectureImpact(partialFixture.bundle.run.id, {
        mode: "reuse",
        rationale: "尝试使用已经失效的客户端基线版本，必须被拒绝。",
        selectedArtifactIds: partialFixture.inputs.map((artifact) => artifact.id),
        expectedBaselineArtifactIds: [randomUUID()],
        affectedOutputKeys: [],
      }),
      (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_BASELINE_CHANGED",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("architecture impact skips a newer ineligible baseline and reuses the older valid candidate", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-architecture-fallback-"));
  const requestedRoot = path.join(parent, "sample");
  try {
    await initializeCodexProject(requestedRoot, "Impact fallback", "Use the newest valid baseline");
    const root = await realpath(requestedRoot);
    const configPath = path.join(root, ".ai-sdlc", "roles", "architect", "config.yaml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, config.replace("validation: required", "validation: advisory"));
    await materializeArchitectureFiles(root);

    const fixture = impactFixture(root);
    await materializeInputFiles(root, fixture.inputs);
    const staleArchitecture = fixture.baseline.artifacts.find(
      (artifact) => artifact.artifactKey === "architecture-c4-containers",
    );
    assert.ok(staleArchitecture);
    const newerInvalid: ArchitectureBaselineRecord = {
      ...fixture.baseline,
      sourceRunId: randomUUID(),
      sourceRunTitle: "Newer but stale architecture",
      sourcePhaseRunId: randomUUID(),
      artifacts: fixture.baseline.artifacts.map((artifact) =>
        artifact.id === staleArchitecture.id
          ? { ...artifact, createdAt: "2026-08-18T07:00:00.000Z" }
          : artifact
      ),
    };
    const store = new ImpactMemoryStore(
      fixture.bundle,
      fixture.inputs,
      fixture.baseline,
      [newerInvalid, fixture.baseline],
    );
    const service = new WorkflowService(
      store as unknown as PgWorkflowStore,
      new ProjectPathPolicy([parent]),
      new CodexTerminalRunner({ fake: true }),
    );

    const detail = await service.getRun(fixture.bundle.run.id);
    assert.equal(detail.architectureBaseline?.sourceRunId, fixture.baseline.sourceRunId);

    await service.assessArchitectureImpact(fixture.bundle.run.id, {
      mode: "reuse",
      rationale: "最新候选时间线无效，因此采用更旧但仍完整有效的架构基线。",
      selectedArtifactIds: fixture.inputs.map((artifact) => artifact.id),
      expectedBaselineArtifactIds: fixture.baseline.artifacts.map((artifact) => artifact.id),
      affectedOutputKeys: [],
    });
    assert.equal(store.adoptions[0]?.impact.sourceRunId, fixture.baseline.sourceRunId);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

class ImpactMemoryStore {
  readonly adoptions: AdoptArchitectureBaselineInput[] = [];

  constructor(
    private readonly bundle: RunBundle,
    private readonly inputs: SelectionArtifact[],
    private readonly baseline: ArchitectureBaselineRecord,
    private readonly candidates: ArchitectureBaselineRecord[] = [baseline],
  ) {}

  async getRun(runId: string): Promise<RunBundle> {
    assert.equal(runId, this.bundle.run.id);
    return this.bundle;
  }

  async selectionArtifacts(runId: string, ids: string[]): Promise<SelectionArtifact[]> {
    assert.equal(runId, this.bundle.run.id);
    return ids.map((id) => {
      const artifact = this.inputs.find((candidate) => candidate.id === id);
      assert.ok(artifact);
      return artifact;
    });
  }

  async latestApprovedArchitectureBaseline(
    projectId: string,
    excludeRunId: string,
  ): Promise<ArchitectureBaselineRecord> {
    assert.equal(projectId, this.bundle.project.id);
    assert.equal(excludeRunId, this.bundle.run.id);
    return this.baseline;
  }

  async approvedArchitectureBaselineCandidates(
    projectId: string,
    excludeRunId: string,
  ): Promise<ArchitectureBaselineRecord[]> {
    assert.equal(projectId, this.bundle.project.id);
    assert.equal(excludeRunId, this.bundle.run.id);
    return this.candidates;
  }

  async adoptArchitectureBaseline(
    runId: string,
    input: AdoptArchitectureBaselineInput,
  ): Promise<ReviewDto> {
    assert.equal(runId, this.bundle.run.id);
    assert.deepEqual(
      new Set(input.expectedBaselineArtifactIds),
      new Set(this.baseline.artifacts.map((artifact) => artifact.id)),
    );
    assert.deepEqual(new Set(input.requiredArtifactKeys), new Set(Object.keys(architectureFiles)));
    this.adoptions.push(input);
    return {
      id: randomUUID(),
      phaseRunId: this.bundle.phases[0]!.id,
      decision: input.impact.mode === "reuse" ? "approve" : "request_changes",
      comment: input.impact.rationale,
      artifactIds: input.impact.sourceArtifactIds,
      createdAt: input.impact.assessedAt,
    };
  }
}

function impactFixture(root: string): {
  bundle: RunBundle;
  inputs: SelectionArtifact[];
  baseline: ArchitectureBaselineRecord;
} {
  const now = "2026-08-18T08:00:00.000Z";
  const project: ProjectDto = {
    id: randomUUID(),
    name: "Impact service",
    summary: "Reuse a project architecture baseline",
    rootPath: root,
    configPath: path.join(root, "ai-native.yaml"),
    runCount: 2,
    createdAt: now,
    updatedAt: now,
  };
  const run: WorkflowRunDto = {
    id: randomUUID(),
    projectId: project.id,
    title: "Small requirement",
    objective: "Change copy without repeating the project architecture",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const phase: PhaseRunDto = {
    id: randomUUID(),
    workflowRunId: run.id,
    phaseId: "architecture",
    position: 2,
    status: "ready",
    artifacts: [],
    reviews: [],
    executions: [],
    events: [],
    availableArtifacts: [],
    architectureImpact: null,
    createdAt: now,
    updatedAt: now,
  };
  const inputs = [
    selectedInput("prd", 0, run.id),
    selectedInput("user-stories", 0, run.id),
    selectedInput("design-spec", 1, run.id),
  ];
  const sourcePhaseRunId = randomUUID();
  const artifacts = Object.entries(architectureFiles).map(([artifactKey, file]) => ({
    id: randomUUID(),
    phaseRunId: sourcePhaseRunId,
    artifactKey,
    filePath: file.filePath,
    content: file.content,
    contentHash: sha256(file.content),
    reviewStatus: "approved" as const,
    revision: 1,
    revisionSource: "ai" as const,
    parentArtifactId: null,
    createdAt: "2026-08-18T07:10:00.000Z",
  }));
  const options = artifacts.find((artifact) => artifact.artifactKey === "architecture-options")!;
  const discovery = artifacts.find(
    (artifact) => artifact.artifactKey === "architecture-discovery-context",
  )!;
  const selectionReview: ReviewDto = {
    id: randomUUID(),
    phaseRunId: sourcePhaseRunId,
    decision: "request_changes",
    comment: "Selected option: A",
    artifactIds: [options.id, discovery.id],
    createdAt: "2026-08-18T07:00:00.000Z",
  };
  const approval: ReviewDto = {
    id: randomUUID(),
    phaseRunId: sourcePhaseRunId,
    decision: "approve",
    comment: "Approved architecture baseline",
    artifactIds: artifacts.map((artifact) => artifact.id),
    createdAt: "2026-08-18T07:20:00.000Z",
  };
  return {
    bundle: { project, run, phases: [phase], artifactPaths: {} },
    inputs,
    baseline: {
      sourceRunId: randomUUID(),
      sourceRunTitle: "Initial architecture",
      sourcePhaseRunId,
      approvedAt: approval.createdAt,
      artifacts,
      reviews: [approval, selectionReview],
      architectureImpact: null,
    },
  };
}

function selectedInput(
  artifactKey: string,
  sourcePosition: number,
  workflowRunId: string,
): SelectionArtifact {
  const content = `# ${artifactKey}\n`;
  return {
    id: randomUUID(),
    phaseRunId: randomUUID(),
    artifactKey,
    filePath: `docs/${artifactKey}.md`,
    content,
    contentHash: sha256(content),
    reviewStatus: "approved",
    revision: 1,
    revisionSource: "human",
    parentArtifactId: null,
    createdAt: "2026-08-18T07:30:00.000Z",
    sourcePosition,
    sourceStatus: "approved",
    workflowRunId,
  };
}

async function materializeArchitectureFiles(root: string): Promise<void> {
  for (const file of Object.values(architectureFiles)) {
    const absolutePath = path.join(root, file.filePath);
    if (file.filePath.endsWith("04-adrs")) {
      await mkdir(absolutePath, { recursive: true });
      await writeFile(path.join(absolutePath, "README.md"), "# Architecture decisions\n");
    } else {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, file.content);
    }
  }
}

async function materializeInputFiles(
  root: string,
  inputs: SelectionArtifact[],
): Promise<void> {
  for (const input of inputs) {
    const absolutePath = path.join(root, input.filePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.content);
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
