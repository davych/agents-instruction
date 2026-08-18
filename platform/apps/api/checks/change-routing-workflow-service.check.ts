import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PHASE_IDS,
  type ArtifactDto,
  type ChangeContractDto,
  type CodexReasoningEffort,
  type CodexRunnerMode,
  type ExecutionDto,
  type ExecutionEventDto,
  type PhaseId,
  type PhaseResolutionDto,
  type PhaseRunDto,
  type ProjectDto,
  type ReviewDecision,
  type ReviewDto,
  type TicketSummaryDto,
  type WorkflowRunDto,
} from "@ai-sdlc/contracts";
import YAML from "yaml";

import type {
  ApplyPhaseResolutionInput,
  ArtifactRecordInput,
  CreateRunPersistence,
  CurrentArtifactSnapshot,
  PhaseBaselineRecord,
  PgWorkflowStore,
  RunBundle,
  SelectionArtifact,
  TicketRecordInput,
} from "../src/db/store.ts";
import { readArtifactContent } from "../src/services/artifact-workspace.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { loadDefinition } from "../src/services/definition-loader.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

test("a Bug Change Contract can approve Product, skip Design and Architecture, then execute Implementation", async () => {
  const fixture = await routingFixture("bug-fast-path");
  try {
    const run = await fixture.service.createRun(fixture.project.id, {
      title: "修复订单总额舍入错误",
      objective: "恢复已经批准的订单总额计算行为",
      changeContract: changeContract("bug"),
    });
    const bundle = fixture.store.requiredBundle();
    const contract = requiredHead(bundle, "discovery", "change-contract");

    assert.equal(run.changeContract?.workType, "bug");
    assert.equal(contract.reviewStatus, "approved");
    assert.match(contract.content ?? "", /^# Change Contract/mu);
    assert.equal(
      await readFile(path.join(fixture.root, contract.filePath), "utf8"),
      contract.content,
    );
    assert.equal(requiredPhase(bundle, "discovery").status, "ready");

    await fixture.service.assessProductImpact(run.id, {
      mode: "direct",
      rationale: "该缺陷的正确行为和验收条件已在本次 Change Contract 中明确记录。",
      selectedArtifactIds: [],
      expectedBaselineArtifactIds: [],
      affectedOutputKeys: [],
    });
    assert.equal(requiredPhase(bundle, "discovery").status, "approved");
    assert.equal(requiredPhase(bundle, "discovery").resolution?.mode, "direct");
    assert.equal(requiredPhase(bundle, "design").status, "ready");

    await fixture.service.assessDesignImpact(run.id, {
      mode: "skip",
      rationale: "本次只修复服务端计算，不改变任何界面、交互、文案或可访问性行为。",
      selectedArtifactIds: [contract.id],
      expectedBaselineArtifactIds: [],
      affectedOutputKeys: [],
    });
    assert.equal(requiredPhase(bundle, "design").status, "approved");
    assert.equal(requiredPhase(bundle, "design").resolution?.mode, "skip");
    assert.equal(requiredPhase(bundle, "architecture").status, "ready");

    await fixture.service.waiveArchitecture(run.id, {
      mode: "skip",
      rationale: "修复不改变 API、数据模型、集成边界、安全边界或任何非功能约束。",
      selectedArtifactIds: [contract.id],
      expectedBaselineArtifactIds: [],
      affectedOutputKeys: [],
    });
    assert.equal(requiredPhase(bundle, "architecture").status, "approved");
    assert.equal(requiredPhase(bundle, "architecture").resolution?.mode, "skip");
    assert.equal(requiredPhase(bundle, "implementation").status, "ready");

    const execution = await fixture.service.executePhase(run.id, "implementation", {
      selectedArtifactIds: [contract.id],
    });
    await fixture.service.waitForIdle();
    assert.equal(fixture.store.execution(execution.id).status, "completed");
    assert.deepEqual(execution.selectedArtifactIds, [contract.id]);
    assert.deepEqual(execution.selectedOutputKeys, ["implementation-notes"]);
    assert.equal(requiredPhase(bundle, "implementation").status, "awaiting_review");
  } finally {
    await fixture.dispose();
  }
});

test("Product partial inherits the approved baseline, limits mutation scope, and can be approved", async () => {
  const fixture = await routingFixture("product-partial");
  try {
    const baseline = await productBaseline(fixture.root);
    fixture.store.setBaselines("discovery", [baseline]);
    const run = await fixture.service.createRun(fixture.project.id, {
      title: "调整订单导出范围",
      objective: "局部更新已经批准的产品范围",
      changeContract: changeContract("change"),
    });

    await fixture.service.assessProductImpact(run.id, {
      mode: "partial",
      rationale: "只调整产品范围说明；现有用户故事和验收条件继续保持有效。",
      selectedArtifactIds: [],
      expectedBaselineArtifactIds: baseline.artifacts.map((artifact) => artifact.id),
      affectedOutputKeys: ["prd"],
    });

    const bundle = fixture.store.requiredBundle();
    const discovery = requiredPhase(bundle, "discovery");
    const inheritedPrd = requiredHead(bundle, "discovery", "prd");
    const inheritedStories = requiredHead(bundle, "discovery", "user-stories");
    assert.equal(discovery.status, "changes_requested");
    assert.equal(discovery.resolution?.mode, "partial");
    assert.equal(inheritedPrd.parentArtifactId, baseline.artifacts[0]?.id);
    assert.equal(inheritedStories.parentArtifactId, baseline.artifacts[1]?.id);

    await assert.rejects(
      () => fixture.service.createArtifactRevision(inheritedStories.id, {
        content: `${inheritedStories.content}\nnot allowed\n`,
        expectedContentHash: inheritedStories.contentHash,
      }),
      (error: unknown) => (error as { code?: string }).code === "PHASE_RESOLUTION_SCOPE_EXCEEDED",
    );

    const revisedPrd = await fixture.service.createArtifactRevision(inheritedPrd.id, {
      content: "# Product baseline\n\nOrder export now covers the explicitly approved date range.\n",
      expectedContentHash: inheritedPrd.contentHash,
    });
    assert.equal(revisedPrd.revision, 2);
    assert.equal(revisedPrd.parentArtifactId, inheritedPrd.id);
    assert.equal(discovery.status, "awaiting_review");

    const heads = discovery.artifacts.map((artifact) => artifact.id);
    await fixture.service.reviewPhase(run.id, "discovery", {
      decision: "approve",
      comment: "局部产品变更已经与 Change Contract 和现有故事核对完成。",
      expectedArtifactIds: heads,
    });
    assert.equal(discovery.status, "approved");
    assert.equal(requiredPhase(bundle, "design").status, "ready");
    assert.equal(requiredHead(bundle, "discovery", "user-stories").revision, 1);
  } finally {
    await fixture.dispose();
  }
});

test("Product reuse and partial migrate approved file and directory snapshots to current configured paths", async (t) => {
  for (const mode of ["reuse", "partial"] as const) {
    await t.test(mode, async () => {
      const fixture = await routingFixture(`product-path-migration-${mode}`);
      try {
        const baseline = await productBaseline(fixture.root);
        await rewriteProductArtifactPaths(fixture.root, {
          prd: `requirements-${mode}.md`,
          "user-stories": `stories-${mode}`,
        });
        const definition = await loadDefinition(fixture.root);
        const targetPrd = requiredDefinitionArtifact(definition, "prd");
        const targetStories = requiredDefinitionArtifact(definition, "user-stories");
        assert.notEqual(targetPrd.relativePath, baseline.artifacts[0]?.filePath);
        assert.notEqual(targetStories.relativePath, baseline.artifacts[1]?.filePath);

        fixture.store.setBaselines("discovery", [baseline]);
        const run = await fixture.service.createRun(fixture.project.id, {
          title: `${mode} an approved product baseline after paths changed`,
          objective: "Carry the approved product evidence into the current artifact layout",
          changeContract: changeContract("change"),
        });

        await fixture.service.assessProductImpact(run.id, {
          mode,
          rationale: mode === "reuse"
            ? "The approved product behavior is unchanged; only the configured artifact paths moved."
            : "The artifact paths moved and only the PRD statement needs a scoped update.",
          selectedArtifactIds: [],
          expectedBaselineArtifactIds: baseline.artifacts.map((artifact) => artifact.id),
          affectedOutputKeys: mode === "partial" ? ["prd"] : [],
        });

        const bundle = fixture.store.requiredBundle();
        const contract = requiredHead(bundle, "discovery", "change-contract");
        const clonedPrd = requiredHead(bundle, "discovery", "prd");
        const clonedStories = requiredHead(bundle, "discovery", "user-stories");
        assert.equal(clonedPrd.filePath, targetPrd.relativePath);
        assert.equal(clonedStories.filePath, targetStories.relativePath);
        assert.equal(
          await readFile(path.join(fixture.root, clonedPrd.filePath), "utf8"),
          clonedPrd.content,
        );
        assert.equal(
          await readArtifactContent(path.join(fixture.root, clonedStories.filePath), 2_000_000),
          clonedStories.content,
        );
        assert.equal(clonedPrd.contentHash, sha256(clonedPrd.content ?? ""));
        assert.equal(clonedStories.contentHash, sha256(clonedStories.content ?? ""));

        if (mode === "partial") {
          await fixture.service.createArtifactRevision(clonedPrd.id, {
            content: "# Product baseline\n\nThe current path now carries the scoped export update.\n",
            expectedContentHash: clonedPrd.contentHash,
          });
          const discovery = requiredPhase(bundle, "discovery");
          await fixture.service.reviewPhase(run.id, "discovery", {
            decision: "approve",
            comment: "The migrated baseline and scoped PRD revision are approved.",
            expectedArtifactIds: discovery.artifacts.map((artifact) => artifact.id),
          });
        }

        assert.equal(requiredPhase(bundle, "discovery").status, "approved");
        const currentPrd = requiredHead(bundle, "discovery", "prd");
        const currentStories = requiredHead(bundle, "discovery", "user-stories");
        await fixture.service.assessDesignImpact(run.id, {
          mode: "skip",
          rationale: "The product path migration and scoped text update do not change UI behavior.",
          selectedArtifactIds: [contract.id, currentPrd.id, currentStories.id],
          expectedBaselineArtifactIds: [],
          affectedOutputKeys: [],
        });
        assert.equal(requiredPhase(bundle, "design").status, "approved");
        assert.equal(requiredPhase(bundle, "architecture").status, "ready");
      } finally {
        await fixture.dispose();
      }
    });
  }
});

test("Product reuse lazily synchronizes inherited stories as todo after Discovery is approved", async () => {
  const fixture = await routingFixture("product-reuse-ticket-sync");
  try {
    const baseline = await productBaseline(fixture.root);
    fixture.store.setBaselines("discovery", [baseline]);
    const run = await fixture.service.createRun(fixture.project.id, {
      title: "Reuse approved order stories",
      objective: "Reuse the existing product definition without rerunning PM/BA",
      changeContract: changeContract("change"),
    });

    await fixture.service.assessProductImpact(run.id, {
      mode: "reuse",
      rationale: "The approved PRD and user stories still describe this change exactly.",
      selectedArtifactIds: [],
      expectedBaselineArtifactIds: baseline.artifacts.map((artifact) => artifact.id),
      affectedOutputKeys: [],
    });
    assert.equal(requiredPhase(fixture.store.requiredBundle(), "discovery").status, "approved");
    assert.equal(fixture.store.ticketSyncCount, 0);

    const tickets = await fixture.service.listTickets(run.id);
    assert.equal(fixture.store.ticketSyncCount, 1);
    assert.deepEqual(
      tickets.map((ticket) => ({ identifier: ticket.identifier, status: ticket.status })),
      [{ identifier: "US-001", status: "todo" }],
    );
    assert.equal(
      tickets[0]?.sourceArtifactId,
      requiredHead(fixture.store.requiredBundle(), "discovery", "user-stories").id,
    );

    await fixture.service.listTickets(run.id);
    assert.equal(fixture.store.ticketSyncCount, 1, "an existing ticket set is not synchronized twice");
  } finally {
    await fixture.dispose();
  }
});

test("Design partial accepts a new optional revision-one output but still rejects an affected output that is absent", async () => {
  const fixture = await routingFixture("design-partial-new-optional");
  try {
    const baseline = await designBaselineWithoutOptionalOutputs(fixture.root);
    fixture.store.setBaselines("design", [baseline]);
    const run = await fixture.service.createRun(fixture.project.id, {
      title: "Add a prototype to an approved design",
      objective: "Keep the approved design baseline while adding an optional prototype",
      changeContract: changeContract("bug"),
    });
    const bundle = fixture.store.requiredBundle();
    const contract = requiredHead(bundle, "discovery", "change-contract");
    await fixture.service.assessProductImpact(run.id, {
      mode: "direct",
      rationale: "The bug behavior and acceptance criteria are complete in the Change Contract.",
      selectedArtifactIds: [],
      expectedBaselineArtifactIds: [],
      affectedOutputKeys: [],
    });

    await fixture.service.assessDesignImpact(run.id, {
      mode: "partial",
      rationale: "Revise the task design specification and add a prototype; keep the baseline unchanged.",
      selectedArtifactIds: [contract.id],
      expectedBaselineArtifactIds: baseline.artifacts.map((artifact) => artifact.id),
      affectedOutputKeys: ["design-spec", "design-prototype"],
    });
    const design = requiredPhase(bundle, "design");
    assert.equal(design.status, "changes_requested");
    assert.equal(requiredHead(bundle, "design", "design-spec").revision, 1);
    assert.equal(
      design.artifacts.some((artifact) => artifact.artifactKey === "design-prototype"),
      false,
    );

    // Revise the inherited required output first so the only missing evidence is
    // the newly affected optional prototype.
    const inheritedSpec = requiredHead(bundle, "design", "design-spec");
    await fixture.service.createArtifactRevision(inheritedSpec.id, {
      content: "# Revised design specification\n\nThe scoped correction behavior is now explicit.\n",
      expectedContentHash: inheritedSpec.contentHash,
    });
    await assert.rejects(
      () => fixture.service.reviewPhase(run.id, "design", {
        decision: "approve",
        comment: "This must not approve without the affected prototype.",
        expectedArtifactIds: design.artifacts.map((artifact) => artifact.id),
      }),
      /missing design\/design-prototype/u,
    );

    const execution = await fixture.service.executePhase(run.id, "design", {
      selectedArtifactIds: [contract.id],
    });
    await fixture.service.waitForIdle();
    assert.equal(fixture.store.execution(execution.id).status, "completed");
    assert.deepEqual(
      new Set(execution.selectedOutputKeys),
      new Set(["design-spec", "design-prototype"]),
    );
    const revisedSpec = requiredHead(bundle, "design", "design-spec");
    const newPrototype = requiredHead(bundle, "design", "design-prototype");
    assert.ok(revisedSpec.revision > 1);
    assert.equal(newPrototype.revision, 1);
    assert.equal(newPrototype.parentArtifactId, null);
    assert.equal(newPrototype.revisionSource, "ai");

    await fixture.service.reviewPhase(run.id, "design", {
      decision: "approve",
      comment: "The inherited spec was revised and the new optional prototype was generated.",
      expectedArtifactIds: design.artifacts.map((artifact) => artifact.id),
    });
    assert.equal(design.status, "approved");
    assert.equal(requiredPhase(bundle, "architecture").status, "ready");
  } finally {
    await fixture.dispose();
  }
});

test("a legacy Run without Change Contract executes and approves Discovery without synthetic CC evidence", async () => {
  const fixture = await routingFixture("legacy-run-without-change-contract");
  try {
    const run = await fixture.service.createRun(fixture.project.id, {
      title: "Legacy imported run",
      objective: "Complete the original full product workflow",
    });
    fixture.store.convertCurrentRunToLegacy();
    const bundle = fixture.store.requiredBundle();
    assert.equal(bundle.run.changeContract, null);
    assert.equal(
      requiredPhase(bundle, "discovery").artifacts.some(
        (artifact) => artifact.artifactKey === "change-contract",
      ),
      false,
    );

    const execution = await fixture.service.executePhase(run.id, "discovery", {
      selectedArtifactIds: [],
    });
    await fixture.service.waitForIdle();
    assert.equal(fixture.store.execution(execution.id).status, "completed");
    assert.deepEqual(execution.selectedOutputKeys, ["prd", "user-stories"]);
    const discovery = requiredPhase(bundle, "discovery");
    assert.equal(discovery.artifacts.some((artifact) => artifact.artifactKey === "change-contract"), false);

    await fixture.service.reviewPhase(run.id, "discovery", {
      decision: "approve",
      comment: "Legacy PRD and user stories are complete without retroactively invented CC evidence.",
      expectedArtifactIds: discovery.artifacts.map((artifact) => artifact.id),
    });
    assert.equal(discovery.status, "approved");
    assert.equal(requiredPhase(bundle, "design").status, "ready");
  } finally {
    await fixture.dispose();
  }
});

test("Product and Design full dispositions leave their phases executable by Codex", async () => {
  const fixture = await routingFixture("full-routing");
  try {
    const run = await fixture.service.createRun(fixture.project.id, {
      title: "新增退款申请旅程",
      objective: "定义并设计一条新的退款申请用户旅程",
      changeContract: changeContract("feature"),
    });
    const bundle = fixture.store.requiredBundle();

    assert.equal(requiredPhase(bundle, "discovery").resolution, null);

    const productExecution = await fixture.service.executePhase(run.id, "discovery", {
      selectedArtifactIds: [],
    });
    await fixture.service.waitForIdle();
    assert.equal(fixture.store.execution(productExecution.id).status, "completed");
    assert.deepEqual(productExecution.selectedOutputKeys, ["prd", "user-stories"]);

    const discovery = requiredPhase(bundle, "discovery");
    await fixture.service.reviewPhase(run.id, "discovery", {
      decision: "approve",
      comment: "完整产品需求和用户故事可进入设计。",
      expectedArtifactIds: discovery.artifacts.map((artifact) => artifact.id),
    });
    assert.equal(requiredPhase(bundle, "design").status, "ready");

    const designInputs = discovery.artifacts.map((artifact) => artifact.id);
    assert.equal(requiredPhase(bundle, "design").resolution, null);

    const designExecution = await fixture.service.executePhase(run.id, "design", {
      selectedArtifactIds: designInputs,
    });
    await fixture.service.waitForIdle();
    assert.equal(fixture.store.execution(designExecution.id).status, "completed");
    assert.deepEqual(designExecution.selectedOutputKeys, ["design-baseline", "design-spec"]);
    assert.equal(requiredPhase(bundle, "design").status, "awaiting_review");
  } finally {
    await fixture.dispose();
  }
});

class RoutingMemoryStore {
  private bundle: RunBundle | null = null;
  private readonly artifacts = new Map<string, ArtifactDto>();
  private readonly executions = new Map<string, ExecutionDto>();
  private readonly baselines = new Map<"discovery" | "design", PhaseBaselineRecord[]>();
  private tickets: TicketSummaryDto[] = [];
  ticketSyncCount = 0;
  private tick = Date.parse("2026-08-18T00:00:00.000Z");

  constructor(readonly project: ProjectDto) {}

  setBaselines(phaseId: "discovery" | "design", baselines: PhaseBaselineRecord[]): void {
    this.baselines.set(phaseId, baselines);
  }

  requiredBundle(): RunBundle {
    assert.ok(this.bundle, "run must be created first");
    return this.bundle;
  }

  convertCurrentRunToLegacy(): void {
    const bundle = this.requiredBundle();
    bundle.run.changeContract = null;
    delete bundle.artifactPaths["change-contract"];
    const discovery = requiredPhase(bundle, "discovery");
    for (const artifact of discovery.artifacts.filter(
      (candidate) => candidate.artifactKey === "change-contract",
    )) {
      this.artifacts.delete(artifact.id);
    }
    discovery.artifacts = discovery.artifacts.filter(
      (candidate) => candidate.artifactKey !== "change-contract",
    );
  }

  async getProject(projectId: string): Promise<ProjectDto> {
    assert.equal(projectId, this.project.id);
    return this.project;
  }

  async createRun(
    projectId: string,
    title: string,
    objective: string,
    persistence: CreateRunPersistence,
  ): Promise<WorkflowRunDto> {
    assert.equal(projectId, this.project.id);
    const createdAt = this.instant();
    const run: WorkflowRunDto = {
      id: persistence.runId,
      projectId,
      title,
      objective,
      changeContract: persistence.changeContract ?? null,
      status: "active",
      createdAt,
      updatedAt: createdAt,
    };
    const phases = PHASE_IDS.map((phaseId, position): PhaseRunDto => ({
      id: randomUUID(),
      workflowRunId: run.id,
      phaseId,
      position,
      status: position === 0 ? "ready" : "pending",
      artifacts: [],
      reviews: [],
      executions: [],
      events: [],
      availableArtifacts: [],
      resolution: null,
      architectureImpact: null,
      createdAt,
      updatedAt: createdAt,
    }));
    this.bundle = {
      project: this.project,
      run,
      phases,
      artifactPaths: { ...persistence.artifactPaths },
    };
    if (persistence.changeContractArtifact) {
      const phase = requiredPhase(this.bundle, "discovery");
      const input = persistence.changeContractArtifact;
      const artifact: ArtifactDto = {
        id: randomUUID(),
        phaseRunId: phase.id,
        artifactKey: input.artifactKey,
        filePath: input.filePath,
        content: input.content,
        contentHash: input.contentHash,
        reviewStatus: "approved",
        revision: 1,
        revisionSource: "human",
        parentArtifactId: null,
        createdAt,
      };
      phase.artifacts.push(artifact);
      this.artifacts.set(artifact.id, artifact);
    }
    return run;
  }

  async getRun(runId: string): Promise<RunBundle> {
    const bundle = this.requiredBundle();
    assert.equal(runId, bundle.run.id);
    return bundle;
  }

  async getPhase(runId: string, phaseId: PhaseId): Promise<PhaseRunDto> {
    const bundle = await this.getRun(runId);
    return requiredPhase(bundle, phaseId);
  }

  async approvedPhaseBaselineCandidates(
    projectId: string,
    phaseId: "discovery" | "design",
    excludeRunId: string,
  ): Promise<PhaseBaselineRecord[]> {
    assert.equal(projectId, this.project.id);
    assert.equal(excludeRunId, this.requiredBundle().run.id);
    return this.baselines.get(phaseId) ?? [];
  }

  async approvedArchitectureBaselineCandidates(): Promise<[]> {
    return [];
  }

  async selectionArtifacts(runId: string, ids: string[]): Promise<SelectionArtifact[]> {
    const bundle = await this.getRun(runId);
    return ids.map((id) => {
      const artifact = this.artifacts.get(id);
      assert.ok(artifact, `unknown artifact ${id}`);
      assert.notEqual(artifact.reviewStatus, "superseded");
      const phase = bundle.phases.find((candidate) => candidate.id === artifact.phaseRunId);
      assert.ok(phase, `unknown source phase for ${id}`);
      return {
        ...artifact,
        content: artifact.content ?? "",
        sourcePosition: phase.position,
        sourceStatus: phase.status,
        workflowRunId: runId,
      };
    });
  }

  async applyPhaseResolution(
    runId: string,
    input: ApplyPhaseResolutionInput,
  ): Promise<ReviewDto> {
    const bundle = await this.getRun(runId);
    const resolution = input.resolution;
    const phase = requiredPhase(bundle, resolution.phaseId);
    assert.equal(phase.status, "ready");
    assert.equal(phase.resolution, null);

    if (resolution.sourcePhaseRunId) {
      const baseline = (this.baselines.get(resolution.phaseId as "discovery" | "design") ?? [])
        .find((candidate) => candidate.sourcePhaseRunId === resolution.sourcePhaseRunId);
      assert.ok(baseline, "source baseline must exist");
      assert.deepEqual(
        new Set(input.expectedBaselineArtifactIds),
        new Set(resolution.sourceArtifactIds),
      );
      for (const sourceId of resolution.sourceArtifactIds) {
        const source = baseline.artifacts.find((artifact) => artifact.id === sourceId);
        assert.ok(source, `missing source artifact ${sourceId}`);
        const inherited: ArtifactDto = {
          ...source,
          id: randomUUID(),
          phaseRunId: phase.id,
          filePath: input.targetArtifactPaths[source.artifactKey] ?? source.filePath,
          reviewStatus: resolution.mode === "partial" ? "changes_requested" : "approved",
          revision: 1,
          parentArtifactId: source.id,
        };
        phase.artifacts.push(inherited);
        this.artifacts.set(inherited.id, inherited);
      }
    } else {
      assert.deepEqual(input.expectedBaselineArtifactIds, []);
    }

    phase.resolution = resolution;
    phase.status = resolution.mode === "partial" ? "changes_requested" : "approved";
    const review = this.addReview(
      phase,
      resolution.mode === "partial" ? "request_changes" : "approve",
      `Phase impact (${resolution.mode}): ${resolution.rationale}`,
    );
    if (phase.status === "approved") this.unlockNext(bundle, phase.position);
    return review;
  }

  async currentArtifactSnapshotsForPhase(
    runId: string,
    phaseId: PhaseId,
  ): Promise<CurrentArtifactSnapshot[]> {
    const phase = requiredPhase(await this.getRun(runId), phaseId);
    return phase.artifacts.map((artifact) => ({
      ...artifact,
      content: artifact.content ?? "",
    }));
  }

  async listTickets(runId: string): Promise<TicketSummaryDto[]> {
    assert.equal(runId, this.requiredBundle().run.id);
    return this.tickets.map((ticket) => ({ ...ticket }));
  }

  async latestUserStoriesArtifact(runId: string) {
    const bundle = await this.getRun(runId);
    const artifact = requiredPhase(bundle, "discovery").artifacts.find(
      (candidate) => candidate.artifactKey === "user-stories",
    );
    return artifact
      ? { id: artifact.id, filePath: artifact.filePath, content: artifact.content ?? "" }
      : null;
  }

  async syncTickets(
    runId: string,
    sourceArtifactId: string,
    tickets: TicketRecordInput[],
  ): Promise<void> {
    const bundle = await this.getRun(runId);
    const source = this.artifacts.get(sourceArtifactId);
    assert.ok(source, "ticket source artifact must exist");
    this.ticketSyncCount += 1;
    const now = this.instant();
    const approved = requiredPhase(bundle, "discovery").status === "approved";
    this.tickets = tickets.map((ticket) => ({
      id: randomUUID(),
      workflowRunId: runId,
      sourceArtifactId,
      identifier: ticket.storyKey,
      title: ticket.title,
      category: ticket.category,
      sourcePath: ticket.sourcePath,
      status: approved ? "todo" : "backlog",
      acceptanceCriteriaCount: ticket.acceptanceCriteriaCount,
      sourceReviewStatus: source.reviewStatus,
      createdAt: now,
      updatedAt: now,
    }));
  }

  async createExecution(
    runId: string,
    phaseId: PhaseId,
    selectedArtifactIds: string[],
    selectedOutputKeys: string[],
    runnerMode: CodexRunnerMode,
    model: string | null,
    reasoningEffort: CodexReasoningEffort | null,
    command: string,
  ): Promise<ExecutionDto> {
    const bundle = await this.getRun(runId);
    const phase = requiredPhase(bundle, phaseId);
    assert.ok(["ready", "changes_requested", "awaiting_review"].includes(phase.status));
    const createdAt = this.instant();
    const execution: ExecutionDto = {
      id: randomUUID(),
      phaseRunId: phase.id,
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
    phase.executions.push(execution);
    phase.status = "running";
    this.executions.set(execution.id, execution);
    return execution;
  }

  async appendEvent(
    executionId: string,
    sequence: number,
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    const execution = this.execution(executionId);
    const phase = this.phaseById(execution.phaseRunId);
    const event: ExecutionEventDto = {
      id: randomUUID(),
      executionId,
      sequence,
      eventType,
      payload,
      createdAt: this.instant(),
    };
    phase.events.push(event);
  }

  async completeExecution(
    executionId: string,
    exitCode: number,
    outputs: ArtifactRecordInput[],
  ): Promise<void> {
    const execution = this.execution(executionId);
    const phase = this.phaseById(execution.phaseRunId);
    assert.deepEqual(
      new Set(outputs.map((artifact) => artifact.artifactKey)),
      new Set(execution.selectedOutputKeys),
    );
    for (const output of outputs) {
      const previous = phase.artifacts.find(
        (artifact) => artifact.artifactKey === output.artifactKey,
      );
      if (previous) {
        previous.reviewStatus = "superseded";
        this.artifacts.set(previous.id, previous);
      }
      const artifact: ArtifactDto = {
        id: randomUUID(),
        phaseRunId: phase.id,
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
      phase.artifacts = phase.artifacts.filter(
        (candidate) => candidate.artifactKey !== output.artifactKey,
      );
      phase.artifacts.push(artifact);
      this.artifacts.set(artifact.id, artifact);
    }
    execution.status = "completed";
    execution.exitCode = exitCode;
    execution.finishedAt = this.instant();
    phase.status = "awaiting_review";
  }

  async failExecution(executionId: string, exitCode: number | null, error: string): Promise<void> {
    const execution = this.execution(executionId);
    execution.status = "failed";
    execution.exitCode = exitCode;
    execution.error = error;
    execution.finishedAt = this.instant();
    this.phaseById(execution.phaseRunId).status = "failed";
  }

  async getArtifact(artifactId: string): Promise<ArtifactDto> {
    const artifact = this.artifacts.get(artifactId);
    assert.ok(artifact, `unknown artifact ${artifactId}`);
    return artifact;
  }

  async artifactWorkspace(artifactId: string) {
    const artifact = await this.getArtifact(artifactId);
    const phase = this.phaseById(artifact.phaseRunId);
    return {
      rootPath: this.project.rootPath,
      workflowRunId: this.requiredBundle().run.id,
      phaseId: phase.phaseId,
    };
  }

  async createHumanArtifactRevision(
    artifactId: string,
    expectedHash: string,
    content: string,
    contentHash: string,
    _tickets?: TicketRecordInput[],
  ): Promise<ArtifactDto> {
    const previous = await this.getArtifact(artifactId);
    assert.equal(previous.contentHash, expectedHash);
    const phase = this.phaseById(previous.phaseRunId);
    previous.reviewStatus = "superseded";
    const artifact: ArtifactDto = {
      ...previous,
      id: randomUUID(),
      content,
      contentHash,
      reviewStatus: "pending",
      revision: previous.revision + 1,
      revisionSource: "human",
      parentArtifactId: previous.id,
      createdAt: this.instant(),
    };
    phase.artifacts = phase.artifacts.filter((candidate) => candidate.id !== previous.id);
    phase.artifacts.push(artifact);
    this.artifacts.set(artifact.id, artifact);
    phase.status = "awaiting_review";
    return artifact;
  }

  async reviewPhase(
    runId: string,
    phaseId: PhaseId,
    decision: ReviewDecision,
    comment: string,
    expectedArtifactIds: string[],
    requiredOutputKeys: string[] = [],
  ): Promise<ReviewDto> {
    const bundle = await this.getRun(runId);
    const phase = requiredPhase(bundle, phaseId);
    assert.equal(phase.status, "awaiting_review");
    assert.deepEqual(
      new Set(expectedArtifactIds),
      new Set(phase.artifacts.map((artifact) => artifact.id)),
    );
    if (decision === "approve") {
      const keys = new Set(phase.artifacts.map((artifact) => artifact.artifactKey));
      assert.deepEqual(requiredOutputKeys.filter((key) => !keys.has(key)), []);
      if (phase.resolution?.mode === "partial") {
        for (const key of phase.resolution.affectedOutputKeys) {
          const artifact = requiredHead(bundle, phaseId, key);
          assert.ok(
            artifact.revision > 1
              || (
                artifact.revision === 1
                && artifact.parentArtifactId === null
                && artifact.revisionSource === "ai"
              ),
            `${key} must be revised or newly produced by AI`,
          );
        }
      }
    }
    const review = this.addReview(phase, decision, comment);
    phase.status = decision === "approve" ? "approved" : "changes_requested";
    for (const artifact of phase.artifacts) {
      artifact.reviewStatus = decision === "approve" ? "approved" : "changes_requested";
    }
    if (decision === "approve") this.unlockNext(bundle, phase.position);
    return review;
  }

  execution(executionId: string): ExecutionDto {
    const execution = this.executions.get(executionId);
    assert.ok(execution, `unknown execution ${executionId}`);
    return execution;
  }

  private phaseById(phaseRunId: string): PhaseRunDto {
    const phase = this.requiredBundle().phases.find((candidate) => candidate.id === phaseRunId);
    assert.ok(phase, `unknown phase ${phaseRunId}`);
    return phase;
  }

  private addReview(
    phase: PhaseRunDto,
    decision: ReviewDecision,
    comment: string,
  ): ReviewDto {
    const review: ReviewDto = {
      id: randomUUID(),
      phaseRunId: phase.id,
      decision,
      comment,
      artifactIds: phase.artifacts.map((artifact) => artifact.id),
      createdAt: this.instant(),
    };
    phase.reviews.push(review);
    return review;
  }

  private unlockNext(bundle: RunBundle, position: number): void {
    const next = bundle.phases.find((phase) => phase.position === position + 1);
    if (next) {
      assert.equal(next.status, "pending");
      next.status = "ready";
    }
  }

  private instant(): string {
    this.tick += 1_000;
    return new Date(this.tick).toISOString();
  }
}

async function routingFixture(label: string): Promise<{
  parent: string;
  root: string;
  project: ProjectDto;
  store: RoutingMemoryStore;
  service: WorkflowService;
  dispose(): Promise<void>;
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), `ai-sdlc-${label}-`));
  const requestedRoot = path.join(parent, "sample");
  await initializeCodexProject(requestedRoot, label, "Change routing service test");
  const root = await realpath(requestedRoot);
  const now = "2026-08-18T00:00:00.000Z";
  const project: ProjectDto = {
    id: randomUUID(),
    name: label,
    summary: "Change routing service test",
    rootPath: root,
    configPath: path.join(root, "ai-native.yaml"),
    runCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const store = new RoutingMemoryStore(project);
  const service = new WorkflowService(
    store as unknown as PgWorkflowStore,
    new ProjectPathPolicy([parent]),
    new CodexTerminalRunner({ fake: true }),
  );
  return {
    parent,
    root,
    project,
    store,
    service,
    async dispose() {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

async function productBaseline(root: string): Promise<PhaseBaselineRecord> {
  const prdPath = "docs/ai-native/product/prd.md";
  const storiesPath = "docs/ai-native/product/user-stories";
  const prdContent = "# Product baseline\n\nExisting order export behavior.\n";
  await mkdir(path.join(root, path.dirname(prdPath)), { recursive: true });
  await writeFile(path.join(root, prdPath), prdContent, "utf8");
  await mkdir(path.join(root, storiesPath, "orders"), { recursive: true });
  await writeFile(
    path.join(root, storiesPath, "orders", "story.md"),
    "# US-001: Export orders\n\n### US-001-AC-1\n\nExisting export remains available.\n",
    "utf8",
  );
  const storiesContent = await readArtifactContent(path.join(root, storiesPath), 2_000_000);
  const sourcePhaseRunId = randomUUID();
  const createdAt = "2026-08-17T00:00:00.000Z";
  const artifacts: CurrentArtifactSnapshot[] = [
    baselineArtifact(sourcePhaseRunId, "prd", prdPath, prdContent, createdAt),
    baselineArtifact(sourcePhaseRunId, "user-stories", storiesPath, storiesContent, createdAt),
  ];
  const approval: ReviewDto = {
    id: randomUUID(),
    phaseRunId: sourcePhaseRunId,
    decision: "approve",
    comment: "Approved product baseline",
    artifactIds: artifacts.map((artifact) => artifact.id),
    createdAt: "2026-08-17T00:01:00.000Z",
  };
  return {
    phaseId: "discovery",
    sourceRunId: randomUUID(),
    sourceRunTitle: "Approved product baseline",
    sourcePhaseRunId,
    approvedAt: approval.createdAt,
    artifacts,
    reviews: [approval],
    resolution: null,
  };
}

async function designBaselineWithoutOptionalOutputs(root: string): Promise<PhaseBaselineRecord> {
  const definition = await loadDefinition(root);
  const designBaselinePath = requiredDefinitionArtifact(
    definition,
    "design-baseline",
  ).relativePath;
  const designSpecPath = "docs/ai-native/design/approved-baseline-design-spec.md";
  const designBaselineContent = [
    "# Approved design baseline",
    "",
    "The existing order correction flow remains the visual baseline.",
    "",
  ].join("\n");
  const designSpecContent = [
    "# Approved design specification",
    "",
    "The correction flow preserves its current interaction and accessibility behavior.",
    "",
  ].join("\n");
  await mkdir(path.join(root, path.dirname(designBaselinePath)), { recursive: true });
  await writeFile(path.join(root, designBaselinePath), designBaselineContent, "utf8");
  await mkdir(path.join(root, path.dirname(designSpecPath)), { recursive: true });
  await writeFile(path.join(root, designSpecPath), designSpecContent, "utf8");

  const sourcePhaseRunId = randomUUID();
  const createdAt = "2026-08-17T00:00:00.000Z";
  const artifacts: CurrentArtifactSnapshot[] = [
    baselineArtifact(
      sourcePhaseRunId,
      "design-baseline",
      designBaselinePath,
      designBaselineContent,
      createdAt,
    ),
    baselineArtifact(
      sourcePhaseRunId,
      "design-spec",
      designSpecPath,
      designSpecContent,
      createdAt,
    ),
  ];
  const approval: ReviewDto = {
    id: randomUUID(),
    phaseRunId: sourcePhaseRunId,
    decision: "approve",
    comment: "Approved required design baseline without optional outputs",
    artifactIds: artifacts.map((artifact) => artifact.id),
    createdAt: "2026-08-17T00:01:00.000Z",
  };
  return {
    phaseId: "design",
    sourceRunId: randomUUID(),
    sourceRunTitle: "Approved required design baseline",
    sourcePhaseRunId,
    approvedAt: approval.createdAt,
    artifacts,
    reviews: [approval],
    resolution: null,
  };
}

async function rewriteProductArtifactPaths(
  root: string,
  paths: { prd: string; "user-stories": string },
): Promise<void> {
  const configPath = path.join(root, "ai-native.yaml");
  const config = YAML.parse(await readFile(configPath, "utf8")) as {
    artifacts?: Array<{ id?: string; path?: string }>;
  };
  assert.ok(Array.isArray(config.artifacts), "test config must register artifacts");
  for (const [artifactKey, artifactPath] of Object.entries(paths)) {
    const artifact = config.artifacts.find((candidate) => candidate.id === artifactKey);
    assert.ok(artifact, `test config must register ${artifactKey}`);
    artifact.path = artifactPath;
  }
  await writeFile(configPath, YAML.stringify(config), "utf8");
}

function requiredDefinitionArtifact(
  definition: Awaited<ReturnType<typeof loadDefinition>>,
  artifactKey: string,
) {
  const artifact = definition.artifacts.find((candidate) => candidate.id === artifactKey);
  assert.ok(artifact, `missing definition artifact ${artifactKey}`);
  return artifact;
}

function baselineArtifact(
  phaseRunId: string,
  artifactKey: string,
  filePath: string,
  content: string,
  createdAt: string,
): CurrentArtifactSnapshot {
  return {
    id: randomUUID(),
    phaseRunId,
    artifactKey,
    filePath,
    content,
    contentHash: sha256(content),
    reviewStatus: "approved",
    revision: 1,
    revisionSource: "ai",
    parentArtifactId: null,
    createdAt,
  };
}

function changeContract(workType: ChangeContractDto["workType"]): ChangeContractDto {
  return {
    workType,
    summary: "Order behavior change",
    currentBehavior: "The current implementation differs from the approved behavior.",
    expectedBehavior: "The implementation follows the explicitly approved behavior.",
    inScope: ["Order behavior"],
    outOfScope: ["Unrelated checkout behavior"],
    acceptanceCriteria: ["The approved order result is returned"],
    regressionScope: ["Order creation and order history"],
    riskFlags: ["order-calculation"],
    evidenceRefs: ["BUG-142"],
  };
}

function requiredPhase(bundle: RunBundle, phaseId: PhaseId): PhaseRunDto {
  const phase = bundle.phases.find((candidate) => candidate.phaseId === phaseId);
  assert.ok(phase, `missing phase ${phaseId}`);
  return phase;
}

function requiredHead(bundle: RunBundle, phaseId: PhaseId, artifactKey: string): ArtifactDto {
  const artifact = requiredPhase(bundle, phaseId).artifacts.find(
    (candidate) => candidate.artifactKey === artifactKey,
  );
  assert.ok(artifact, `missing ${phaseId}/${artifactKey}`);
  return artifact;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
