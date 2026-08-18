import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ArtifactDto,
  CodexReasoningEffort,
  CodexRunnerMode,
  ExecutionDto,
  ExecutionEventDto,
  PhaseRunDto,
  ProjectDto,
  ReviewDecision,
  ReviewDto,
  WorkflowRunDto,
} from "@ai-sdlc/contracts";

import type {
  ArtifactRecordInput,
  PgWorkflowStore,
  SelectionArtifact,
} from "../src/db/store.ts";
import { requiredArchitecturePostSelectionOutputs } from "../src/domain/workflow.ts";
import {
  loadArchitectureRulebookContext,
} from "../src/services/architecture-rulebook-runtime.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

test("required rulebook accepts a fresh fake checkpoint selection and selected-state approval", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-rulebook-service-"));
  const requestedRoot = path.join(parent, "sample");
  try {
    await initializeCodexProject(requestedRoot, "Rulebook service", "Exercise the required architecture gate");
    const root = await realpath(requestedRoot);
    const rulebook = await loadArchitectureRulebookContext(root);
    assert.equal(rulebook.validation, "required");
    assert.ok(rulebook.source, "the initialized project must contain the real rule catalog");

    const now = "2026-08-18T00:00:00.000Z";
    const project: ProjectDto = {
      id: randomUUID(),
      name: "Rulebook service",
      summary: "Exercise the required architecture gate",
      rootPath: root,
      configPath: path.join(root, "ai-native.yaml"),
      runCount: 1,
      createdAt: now,
      updatedAt: now,
    };
    const run: WorkflowRunDto = {
      id: randomUUID(),
      projectId: project.id,
      title: "Architecture integration",
      objective: "Select option B and approve its complete rulebook evidence",
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
      createdAt: now,
      updatedAt: now,
    };
    const inputs = [
      selectedInput("prd", 0, "docs/ai-native/product/prd.md", run.id),
      selectedInput("user-stories", 0, "docs/ai-native/product/user-stories", run.id),
      selectedInput("design-spec", 1, "docs/ai-native/design/design-spec.md", run.id),
    ];
    for (const artifact of inputs) {
      const absolutePath = path.resolve(root, artifact.filePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, artifact.content, "utf8");
    }
    const store = new ArchitectureMemoryStore(project, run, phase, inputs);
    const service = new WorkflowService(
      store as unknown as PgWorkflowStore,
      new ProjectPathPolicy([parent]),
      new CodexTerminalRunner({ fake: true }),
    );

    const first = await service.executePhase(run.id, "architecture", {
      selectedArtifactIds: inputs.map((artifact) => artifact.id),
    });
    await service.waitForIdle();
    assert.equal(store.execution(first.id).status, "completed");
    assert.deepEqual(first.selectedOutputKeys, [
      "architecture",
      "architecture-discovery-context",
      "architecture-options",
    ]);
    assert.equal(phase.status, "awaiting_review");

    const checkpointOptions = requiredHead(phase, "architecture-options");
    const checkpointDiscovery = requiredHead(phase, "architecture-discovery-context");
    assert.match(checkpointDiscovery.content ?? "", /"id": "api"[\s\S]*"status": "applicable"/u);
    assert.match(checkpointDiscovery.content ?? "", /"id": "frontend"[\s\S]*"status": "applicable"/u);
    assert.match(checkpointOptions.content ?? "", /"ruleId": "API-001"[\s\S]*"ruleId": "FE-004"/u);

    const checkpointIds = phase.artifacts.map((artifact) => artifact.id);
    const selectionResult = await service.reviewPhase(run.id, "architecture", {
      decision: "request_changes",
      comment: "Selected option: B",
      expectedArtifactIds: checkpointIds,
    });
    assert.equal(selectionResult.review.decision, "request_changes");
    assert.equal(phase.status, "changes_requested");
    assert.deepEqual(new Set(selectionResult.review.artifactIds), new Set(checkpointIds));
    assert.ok(selectionResult.review.artifactIds.includes(checkpointOptions.id));
    assert.ok(selectionResult.review.artifactIds.includes(checkpointDiscovery.id));

    const second = await service.executePhase(run.id, "architecture", {
      selectedArtifactIds: inputs.map((artifact) => artifact.id),
    });
    await service.waitForIdle();
    assert.equal(store.execution(second.id).status, "completed");
    assert.deepEqual(second.selectedOutputKeys, requiredArchitecturePostSelectionOutputs);
    assert.equal(phase.status, "awaiting_review");

    const currentOptions = requiredHead(phase, "architecture-options");
    assert.equal(currentOptions.id, checkpointOptions.id, "selected-state execution must retain the reviewed options head");
    assert.equal(currentOptions.revision, checkpointOptions.revision);
    const selectedArchitecture = requiredHead(phase, "architecture");
    assert.match(selectedArchitecture.content ?? "", /"optionId": "B"/u);
    assert.match(
      selectedArchitecture.content ?? "",
      new RegExp(`"optionsArtifactId": "${checkpointOptions.id}"`, "u"),
      "the selected-state contract must bind to the current reviewed options revision",
    );
    const patterns = requiredHead(phase, "architecture-patterns");
    assert.match(patterns.content ?? "", /"optionId": "B"[\s\S]*"ruleId": "API-001"[\s\S]*"ruleId": "FE-004"/u);

    const finalIds = phase.artifacts.map((artifact) => artifact.id);
    const approvalResult = await service.reviewPhase(run.id, "architecture", {
      decision: "approve",
      comment: "Architecture evidence is complete",
      expectedArtifactIds: finalIds,
    });
    assert.equal(approvalResult.review.decision, "approve");
    assert.equal(phase.status, "approved");
    assert.equal(store.reviewCalls.length, 2);
    assert.deepEqual(store.reviewCalls[1]?.freshness, {
      keys: requiredArchitecturePostSelectionOutputs,
      after: selectionResult.review.createdAt,
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

interface ReviewCall {
  decision: ReviewDecision;
  expectedArtifactIds: string[];
  requiredOutputKeys: string[];
  freshness?: { keys: string[]; after: string };
}

class ArchitectureMemoryStore {
  readonly reviewCalls: ReviewCall[] = [];
  private readonly artifacts = new Map<string, ArtifactDto>();
  private readonly executions = new Map<string, ExecutionDto>();
  private tick = Date.parse("2026-08-18T00:00:00.000Z");

  constructor(
    private readonly project: ProjectDto,
    private readonly run: WorkflowRunDto,
    private readonly phase: PhaseRunDto,
    private readonly inputs: SelectionArtifact[],
  ) {
    for (const artifact of inputs) this.artifacts.set(artifact.id, artifact);
  }

  async getRun(runId: string) {
    assert.equal(runId, this.run.id);
    return {
      project: this.project,
      run: this.run,
      phases: [this.phase],
      artifactPaths: {},
    };
  }

  async selectionArtifacts(runId: string, ids: string[]): Promise<SelectionArtifact[]> {
    assert.equal(runId, this.run.id);
    const requested = new Set(ids);
    assert.equal(requested.size, ids.length);
    const selected = this.inputs.filter((artifact) => requested.has(artifact.id));
    assert.equal(selected.length, ids.length);
    return selected;
  }

  async currentArtifactSnapshotsForPhase(runId: string, phaseId: string) {
    assert.equal(runId, this.run.id);
    assert.equal(phaseId, "architecture");
    return this.phase.artifacts.map((artifact) => ({
      ...artifact,
      content: artifact.content ?? "",
    }));
  }

  async createExecution(
    runId: string,
    phaseId: string,
    selectedArtifactIds: string[],
    selectedOutputKeys: string[],
    runnerMode: CodexRunnerMode,
    model: string | null,
    reasoningEffort: CodexReasoningEffort | null,
    command: string,
  ): Promise<ExecutionDto> {
    assert.equal(runId, this.run.id);
    assert.equal(phaseId, "architecture");
    const createdAt = this.instant();
    const execution: ExecutionDto = {
      id: randomUUID(),
      phaseRunId: this.phase.id,
      status: "running",
      selectedArtifactIds,
      selectedOutputKeys,
      runnerMode,
      model,
      reasoningEffort,
      command,
      exitCode: null,
      error: null,
      startedAt: createdAt,
      finishedAt: null,
      createdAt,
    };
    this.executions.set(execution.id, execution);
    this.phase.executions.push(execution);
    this.phase.status = "running";
    return execution;
  }

  async appendEvent(
    executionId: string,
    sequence: number,
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    this.execution(executionId);
    const event: ExecutionEventDto = {
      id: randomUUID(),
      executionId,
      sequence,
      eventType,
      payload,
      createdAt: this.instant(),
    };
    this.phase.events.push(event);
  }

  async completeExecution(
    executionId: string,
    exitCode: number,
    outputs: ArtifactRecordInput[],
  ): Promise<void> {
    const execution = this.execution(executionId);
    assert.deepEqual(
      new Set(outputs.map((artifact) => artifact.artifactKey)),
      new Set(execution.selectedOutputKeys),
    );
    for (const output of outputs) {
      const previous = this.phase.artifacts.find(
        (artifact) => artifact.artifactKey === output.artifactKey,
      );
      if (previous) {
        previous.reviewStatus = "superseded";
        this.artifacts.set(previous.id, previous);
      }
      const artifact: ArtifactDto = {
        id: randomUUID(),
        phaseRunId: this.phase.id,
        artifactKey: output.artifactKey,
        filePath: output.filePath,
        content: output.content,
        contentHash: output.contentHash,
        reviewStatus: "pending",
        revision: (previous?.revision ?? 0) + 1,
        revisionSource: "ai",
        parentArtifactId: previous?.id ?? null,
        createdAt: this.instant(),
      };
      this.phase.artifacts = this.phase.artifacts.filter(
        (candidate) => candidate.artifactKey !== output.artifactKey,
      );
      this.phase.artifacts.push(artifact);
      this.artifacts.set(artifact.id, artifact);
    }
    execution.status = "completed";
    execution.exitCode = exitCode;
    execution.finishedAt = this.instant();
    this.phase.status = "awaiting_review";
  }

  async failExecution(executionId: string, exitCode: number | null, error: string): Promise<void> {
    const execution = this.execution(executionId);
    execution.status = "failed";
    execution.exitCode = exitCode;
    execution.error = error;
    execution.finishedAt = this.instant();
    this.phase.status = "failed";
  }

  async getArtifact(id: string): Promise<ArtifactDto> {
    const artifact = this.artifacts.get(id);
    assert.ok(artifact, `unknown artifact ${id}`);
    return artifact;
  }

  async reviewPhase(
    runId: string,
    phaseId: string,
    decision: ReviewDecision,
    comment: string,
    expectedArtifactIds: string[],
    requiredOutputKeys: string[] = [],
    freshness?: { keys: string[]; after: string },
  ): Promise<ReviewDto> {
    assert.equal(runId, this.run.id);
    assert.equal(phaseId, "architecture");
    assert.equal(this.phase.status, "awaiting_review");
    assert.deepEqual(
      new Set(expectedArtifactIds),
      new Set(this.phase.artifacts.map((artifact) => artifact.id)),
    );
    if (decision === "approve") {
      const heads = new Map(this.phase.artifacts.map((artifact) => [artifact.artifactKey, artifact]));
      assert.deepEqual(requiredOutputKeys.filter((key) => !heads.has(key)), []);
      if (freshness) {
        for (const key of freshness.keys) {
          assert.ok(
            Date.parse(requiredHead(this.phase, key).createdAt) > Date.parse(freshness.after),
            `${key} must be newer than the selection review`,
          );
        }
      }
    }
    this.reviewCalls.push({
      decision,
      expectedArtifactIds: [...expectedArtifactIds],
      requiredOutputKeys: [...requiredOutputKeys],
      ...(freshness ? { freshness: { keys: [...freshness.keys], after: freshness.after } } : {}),
    });
    const review: ReviewDto = {
      id: randomUUID(),
      phaseRunId: this.phase.id,
      decision,
      comment,
      artifactIds: this.phase.artifacts.map((artifact) => artifact.id),
      createdAt: this.instant(),
    };
    this.phase.reviews.push(review);
    this.phase.status = decision === "approve" ? "approved" : "changes_requested";
    for (const artifact of this.phase.artifacts) {
      artifact.reviewStatus = decision === "approve" ? "approved" : "changes_requested";
    }
    return review;
  }

  execution(id: string): ExecutionDto {
    const execution = this.executions.get(id);
    assert.ok(execution, `unknown execution ${id}`);
    return execution;
  }

  private instant(): string {
    this.tick += 1_000;
    return new Date(this.tick).toISOString();
  }
}

function selectedInput(
  artifactKey: string,
  sourcePosition: number,
  filePath: string,
  workflowRunId: string,
): SelectionArtifact {
  const content = `# ${artifactKey}\n`;
  return {
    id: randomUUID(),
    phaseRunId: randomUUID(),
    artifactKey,
    filePath,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    reviewStatus: "approved",
    revision: 1,
    revisionSource: "ai",
    parentArtifactId: null,
    createdAt: "2026-08-17T00:00:00.000Z",
    sourcePosition,
    sourceStatus: "approved",
    workflowRunId,
  };
}

function requiredHead(phase: PhaseRunDto, artifactKey: string): ArtifactDto {
  const artifact = phase.artifacts.find((candidate) => candidate.artifactKey === artifactKey);
  assert.ok(artifact, `missing ${artifactKey}`);
  return artifact;
}
