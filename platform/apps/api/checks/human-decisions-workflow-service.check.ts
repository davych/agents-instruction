import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ArtifactDto,
  ExecutionDto,
  HumanDecisionPhaseId,
  PhaseId,
  PhaseRunDto,
  ProjectDto,
  ReviewDto,
  WorkflowRunDto,
} from "@ai-sdlc/contracts";

import type {
  ArtifactRecordInput,
  CurrentArtifactSnapshot,
  PgWorkflowStore,
  RunBundle,
  SelectionArtifact,
} from "../src/db/store.ts";
import { AppError } from "../src/domain/errors.ts";
import {
  assessPhaseHumanDecisionGate,
  parseHumanDecisionCapture,
  serializeHumanDecisionCapture,
} from "../src/domain/human-decisions.ts";
import {
  CodexTerminalRunner,
  type CodexRunRequest,
  type CodexRunResult,
} from "../src/services/codex-runner.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

const now = "2026-08-20T08:00:00.000Z";

test("CHAT-DECISION-REPLAY-02: Workflow atomically attaches decision feedback and answered Blocker scopes", async () => {
  const source = await readFile(
    new URL("../src/services/workflow-service.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const humanDecisionReplay = buildHumanDecisionReplay\(\s*currentPhase\.reviews,\s*currentArtifacts,\s*\);/su,
  );
  assert.match(
    source,
    /currentArtifacts,\s+revisionFeedback,\s+answeredUserStoriesBlockerFingerprints:\s+humanDecisionReplay\.answeredUserStoriesBlockerFingerprints,\s+answeredUserStoriesBlockerScopes:\s+humanDecisionReplay\.answeredUserStoriesBlockerScopes,\s+productDecisionMaterializationRequired:\s+productDecisionMaterialization !== null,\s+selectedOutputKeys,/su,
  );
  assert.match(
    source,
    /completeProductDecisionMaterializationPolicy\(\s*reviews,\s*reviewedArtifacts\.map/su,
    "the workflow must prove the reviewed historical decision set before enabling the lock",
  );
});

test("CHAT-DECISION-REPLAY-04: executePhase re-reads Reviews under the workspace lock", async (context) => {
  for (const reviewKind of ["decision-capture", "ordinary-review"] as const) {
    await context.test(reviewKind, async () => {
      const fixture = await executionReviewRaceFixture(reviewKind);
      try {
        await fixture.service.executePhase(fixture.run.id, "discovery", {
          selectedArtifactIds: [],
        });
        await fixture.service.waitForIdle();

        assert.equal(fixture.store.lockedReadObserved, true,
          "the authoritative Run read must happen only after the workspace mutation lock is held");
        assert.ok(fixture.store.getRunCalls >= 2,
          "executePhase must not reuse the pre-lock Run bundle");
        assert.equal(fixture.runner.requests.length, 1);
        const request = fixture.runner.requests[0]!;

        if (reviewKind === "decision-capture") {
          assert.equal(request.productDecisionMaterializationRequired, true,
            "a decision capture committed before lock acquisition must enable materialization");
          assert.match(request.revisionFeedback?.join("\n") ?? "", /Use a compact table in the existing section order\./u);
          assert.match(request.revisionFeedback?.join("\n") ?? "", /完整 Discovery 人工决定批次/u);
        } else {
          assert.equal(request.productDecisionMaterializationRequired, false);
          assert.deepEqual(request.revisionFeedback, [fixture.review.comment],
            "an ordinary Review committed before lock acquisition must be routed to this execution");
        }
      } finally {
        await fixture.dispose();
      }
    });
  }
});

test("AC-CLARITY-015: Product, Design, and Architecture approval fail closed before persistence", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-human-gates-"));
  try {
    const fixture = await serviceFixture(parent, {
      discovery: "# PRD\n\n## Open questions for a human\n\n- [ ] Decide the product rule.\n",
      design: '\`\`\`json\n{"status":"blocked","blockers":[{"id":"B-04","decision":"Validate responsive design","owner":"Designer"}],"open_questions":[]}\n\`\`\`',
      architecture: "# Architecture\n\n## Open Human Decisions\n\n- [ ] **ARCH-02:** Decide measurable NFR targets.\n",
    });

    for (const phaseId of ["discovery", "design", "architecture"] as const) {
      fixture.setOnlyPhaseAwaitingReview(phaseId);
      await assert.rejects(
        () => fixture.service.reviewPhase(fixture.runId, phaseId, {
          decision: "approve",
          comment: "Approve despite the unresolved decision.",
          expectedArtifactIds: [fixture.artifacts[phaseId].id],
        }),
        (error: unknown) => {
          const appError = error as { statusCode?: number; code?: string };
          assert.equal(appError.statusCode, 409);
          assert.equal(appError.code, "PHASE_HUMAN_DECISIONS_REQUIRED");
          return true;
        },
      );
    }
    assert.equal(fixture.reviewCalls.length, 0, "semantic failures must not persist approvals");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("AC-CLARITY-019: Design approval accepts B-04 deferred until runnable browser verification", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-deferred-design-verification-"));
  try {
    const fixture = await serviceFixture(parent, {
      discovery: "# PRD\n\n**Status:** Ready for human review\n\n## Open questions for a human\n\nNone.\n",
      design: `
\`\`\`json
{
  "status": "ready-for-engineering",
  "open_questions": [],
  "blockers": [],
  "deferred_validations": [
    {
      "id": "B-04",
      "owner": "tester",
      "phase": "verification",
      "prerequisite": "实现完成且页面可运行、浏览器环境可用",
      "targets": ["320x568", "1280x800"],
      "checks": ["键盘与焦点", "responsive layout"],
      "pass_criteria": "关键操作无裁切且键盘顺序与焦点恢复正确",
      "evidence_required": "Tester 在 test-report 记录 viewport、步骤和结果",
      "evidence_types": ["browser-run", "screenshot"],
      "on_fail": "block_verification",
      "on_missing": "block_verification",
      "status": "deferred",
      "release_impact": "缺失或失败会阻止 Verification 通过"
    }
  ]
}
\`\`\`
`,
      architecture: "# Architecture\n\n**Status:** Ready for human acceptance\n",
    });
    fixture.setOnlyPhaseAwaitingReview("design");

    await fixture.service.reviewPhase(fixture.runId, "design", {
      decision: "approve",
      comment: "Approve the implementable design and retain B-04 for post-implementation browser verification.",
      expectedArtifactIds: [fixture.artifacts.design.id],
    });

    assert.equal(fixture.reviewCalls.length, 1, "approval persists without another Designer execution");
    assert.equal(fixture.reviewCalls[0]?.[2], "approve");
    assert.equal(fixture.phases.design.status, "approved");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("AC-CLARITY-014/017/018: legacy inconsistency is visible and captured answers reopen the owning phase", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-human-capture-"));
  try {
    const fixture = await serviceFixture(parent, {
      discovery: "# PRD\n\n**Status:** Pending human decision\n\n## Open questions for a human\n\n- [ ] Decide the product rule.\n",
      design: '\`\`\`json\n{"status":"ready-for-engineering","blockers":[],"open_questions":[]}\n\`\`\`',
      architecture: "# Architecture\n\n**Status:** Ready for human acceptance\n",
    });
    fixture.setOnlyPhaseAwaitingReview("discovery", "approved");

    const before = await fixture.service.getHumanDecisions(fixture.runId);
    const productGate = before.phases.find(({ phaseId }) => phaseId === "discovery");
    assert.equal(productGate?.inconsistentApproval, true);
    const decisionId = productGate?.items[0]?.id;
    assert.match(decisionId ?? "", /^PRODUCT-QUESTION-V2-[a-f0-9]{24}$/u);

    const result = await fixture.service.captureHumanDecisions(fixture.runId, "discovery", {
      responses: [{ id: decisionId!, response: "Use the current catalog and preserve its order." }],
      expectedArtifactIds: fixture.discoveryArtifactIds,
    });

    assert.equal(result.run.id, fixture.runId);
    assert.equal(fixture.reviewCalls.length, 1);
    assert.equal(fixture.reviewCalls[0]?.[2], "request_changes");
    assert.deepEqual(fixture.reviewCalls[0]?.[7], ["ready", "awaiting_review", "approved", "changes_requested"]);
    assert.deepEqual(parseHumanDecisionCapture(String(fixture.reviewCalls[0]?.[3])), {
      phaseId: "discovery",
      responses: [{ id: decisionId!, response: "Use the current catalog and preserve its order." }],
    });
    assert.equal(fixture.phases.discovery.status, "changes_requested");

    const after = await fixture.service.getHumanDecisions(fixture.runId);
    assert.equal(after.phases.find(({ phaseId }) => phaseId === "discovery")?.items[0]?.response,
      "Use the current catalog and preserve its order.");
    assert.equal(after.phases.find(({ phaseId }) => phaseId === "discovery")?.items[0]?.kind, "work");
    assert.equal(after.phases.find(({ phaseId }) => phaseId === "discovery")?.decisionCount, 0);
    assert.equal(after.phases.find(({ phaseId }) => phaseId === "discovery")?.workCount, 1);
    assert.equal(after.phases.find(({ phaseId }) => phaseId === "discovery")?.blockingCount, 1,
      "the formal PRD must still be updated before approval");

    fixture.phases.discovery.status = "ready";
    await assert.rejects(
      () => fixture.service.captureHumanDecisions(fixture.runId, "discovery", {
        responses: [{ id: decisionId!, response: "Use the current catalog and preserve its order." }],
        expectedArtifactIds: fixture.discoveryArtifactIds,
      }),
      (error: unknown) => (
        error instanceof AppError && error.code === "PRODUCT_DECISION_MATERIALIZATION_REQUIRED"
      ),
    );
    assert.equal(fixture.reviewCalls.length, 1, "an answered decision cannot be submitted again before PM / BA materializes it");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("CHAT-DECISION-BATCH-03: the API rejects a partial decision batch without writing a Review", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-human-batch-"));
  try {
    const fixture = await serviceFixture(parent, {
      discovery: [
        "# PRD",
        "",
        "## Open questions",
        "",
        "- Use cards or a table?",
        "- Include repository links?",
        "",
      ].join("\n"),
      design: '\`\`\`json\n{"status":"ready-for-engineering","blockers":[],"open_questions":[]}\n\`\`\`',
      architecture: "# Architecture\n\n**Status:** Ready for human acceptance\n",
    });
    fixture.setOnlyPhaseAwaitingReview("discovery");
    const summary = await fixture.service.getHumanDecisions(fixture.runId);
    const items = summary.phases
      .find(({ phaseId }) => phaseId === "discovery")
      ?.items.filter(({ kind }) => kind === "decision") ?? [];
    assert.equal(items.length, 2);

    await assert.rejects(
      () => fixture.service.captureHumanDecisions(fixture.runId, "discovery", {
        responses: [{ id: items[0]!.id, response: "Use cards in the existing section order." }],
        expectedArtifactIds: [fixture.artifacts.discovery.id],
      }),
      (error: unknown) => {
        if (!(error instanceof AppError) || error.code !== "HUMAN_DECISION_BATCH_INCOMPLETE") {
          return false;
        }
        const details = error.details as { missingIds?: unknown } | undefined;
        return Array.isArray(details?.missingIds) && details.missingIds.includes(items[1]!.id);
      },
    );
    assert.equal(fixture.reviewCalls.length, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function serviceFixture(
  parent: string,
  contentByPhase: Record<HumanDecisionPhaseId, string>,
) {
  const requestedRoot = path.join(parent, "sample");
  await initializeCodexProject(requestedRoot, "Human decision flow", "Structured decision workflow");
  const rootPath = await realpath(requestedRoot);
  const project: ProjectDto = {
    id: randomUUID(),
    name: "Human decision flow",
    summary: "Structured decision workflow",
    rootPath,
    configPath: path.join(rootPath, "ai-native.yaml"),
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const run = {
    id: randomUUID(),
    projectId: project.id,
    title: "Human decisions",
    objective: "Make the missing human decisions explicit",
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
  const artifactKeys = {
    discovery: "prd",
    design: "design-spec",
    architecture: "architecture",
  } as const;
  const artifacts = Object.fromEntries(
    (Object.keys(artifactKeys) as HumanDecisionPhaseId[]).map((phaseId) => {
      const artifact: ArtifactDto = {
        id: randomUUID(),
        phaseRunId: "",
        artifactKey: artifactKeys[phaseId],
        filePath: `docs/${artifactKeys[phaseId]}.md`,
        contentHash: phaseId.repeat(16).slice(0, 64).padEnd(64, "0"),
        content: contentByPhase[phaseId],
        reviewStatus: "pending",
        revision: 1,
        revisionSource: "ai",
        parentArtifactId: null,
        superseded: false,
        createdAt: now,
      };
      return [phaseId, artifact];
    }),
  ) as Record<HumanDecisionPhaseId, ArtifactDto>;
  const discoveryStoryArtifact: ArtifactDto = {
    id: randomUUID(),
    phaseRunId: "",
    artifactKey: "user-stories",
    filePath: "docs/user-stories.md",
    contentHash: createHash("sha256").update(reviewableStoriesSnapshot()).digest("hex"),
    content: reviewableStoriesSnapshot(),
    reviewStatus: "pending",
    revision: 1,
    revisionSource: "ai",
    parentArtifactId: null,
    superseded: false,
    createdAt: now,
  };
  const phases = Object.fromEntries(
    (["discovery", "design", "architecture"] as HumanDecisionPhaseId[]).map((phaseId, position) => {
      const phase: PhaseRunDto = {
        id: randomUUID(),
        workflowRunId: run.id,
        phaseId,
        position,
        status: "pending",
        artifacts: phaseId === "discovery"
          ? [artifacts[phaseId], discoveryStoryArtifact]
          : [artifacts[phaseId]],
        reviews: [],
        executions: [],
        events: [],
        availableArtifacts: [],
        createdAt: now,
        updatedAt: now,
      };
      artifacts[phaseId].phaseRunId = phase.id;
      if (phaseId === "discovery") discoveryStoryArtifact.phaseRunId = phase.id;
      return [phaseId, phase];
    }),
  ) as Record<HumanDecisionPhaseId, PhaseRunDto>;
  const reviewCalls: unknown[][] = [];
  const bundle = { project, run, phases: Object.values(phases), artifactPaths: {} };
  const fakeStore = {
    getRun: async () => bundle,
    getArtifact: async (artifactId: string) => {
      const artifact = [...Object.values(artifacts), discoveryStoryArtifact]
        .find(({ id }) => id === artifactId);
      if (!artifact) throw new AppError("产物不存在", 404, "ARTIFACT_NOT_FOUND");
      return artifact;
    },
    currentArtifactSnapshotsForPhase: async (_runId: string, phaseId: HumanDecisionPhaseId) => (
      phaseId === "discovery"
        ? [artifacts.discovery, discoveryStoryArtifact]
        : [artifacts[phaseId]]
    ),
    reviewPhase: async (...args: unknown[]) => {
      reviewCalls.push(args);
      const phaseId = args[1] as HumanDecisionPhaseId;
      const phase = phases[phaseId];
      const review: ReviewDto = {
        id: randomUUID(),
        phaseRunId: phase.id,
        decision: args[2] as "approve" | "request_changes",
        comment: String(args[3]),
        artifactIds: args[4] as string[],
        createdAt: now,
      };
      phase.reviews.unshift(review);
      phase.status = review.decision === "approve" ? "approved" : "changes_requested";
      return review;
    },
  };
  const service = new WorkflowService(
    fakeStore as unknown as PgWorkflowStore,
    new ProjectPathPolicy([parent]),
    new CodexTerminalRunner({ fake: true }),
  );
  return {
    service,
    runId: run.id,
    artifacts,
    discoveryArtifactIds: [artifacts.discovery.id, discoveryStoryArtifact.id],
    phases,
    reviewCalls,
    setOnlyPhaseAwaitingReview(phaseId: HumanDecisionPhaseId, status: PhaseRunDto["status"] = "awaiting_review") {
      for (const phase of Object.values(phases)) phase.status = "pending";
      phases[phaseId].status = status;
    },
  };
}

class RaceCapturingRunner extends CodexTerminalRunner {
  readonly requests: CodexRunRequest[] = [];

  constructor() {
    super({ fake: true });
  }

  override async run(
    request: CodexRunRequest,
    _onEvent: (eventType: string, payload: unknown) => Promise<void>,
  ): Promise<CodexRunResult> {
    this.requests.push(request);
    return { exitCode: 0, artifacts: [] };
  }
}

class ExecutionReviewRaceStore {
  getRunCalls = 0;
  lockedReadObserved = false;
  private service: WorkflowService | null = null;

  constructor(
    private readonly initialBundle: RunBundle,
    private readonly latestBundle: RunBundle,
    private readonly artifacts: ArtifactDto[],
  ) {}

  attach(service: WorkflowService): void {
    this.service = service;
  }

  async getRun(): Promise<RunBundle> {
    this.getRunCalls += 1;
    if (this.getRunCalls === 1) return this.initialBundle;
    const locks = (this.service as unknown as {
      activeWorkspaceMutations: Set<string>;
    } | null)?.activeWorkspaceMutations;
    this.lockedReadObserved = locks?.has(this.latestBundle.project.rootPath) === true;
    return this.latestBundle;
  }

  async getArtifact(artifactId: string): Promise<ArtifactDto> {
    const artifact = this.artifacts.find(({ id }) => id === artifactId);
    assert.ok(artifact, `missing race artifact ${artifactId}`);
    return artifact;
  }

  async selectionArtifacts(_runId: string, ids: string[]): Promise<SelectionArtifact[]> {
    assert.deepEqual(ids, []);
    return [];
  }

  async currentArtifactSnapshotsForPhase(
    _runId: string,
    phaseId: PhaseId,
  ): Promise<CurrentArtifactSnapshot[]> {
    return phaseId === "discovery"
      ? this.artifacts as CurrentArtifactSnapshot[]
      : [];
  }

  async createExecution(
    _runId: string,
    _phaseId: PhaseId,
    selectedArtifactIds: string[],
    selectedOutputKeys: string[],
    _runnerMode: string,
    _model: string | null,
    _reasoningEffort: string | null,
    command: string,
  ): Promise<ExecutionDto> {
    return {
      id: randomUUID(),
      phaseRunId: this.latestBundle.phases[0]!.id,
      status: "running",
      selectedArtifactIds,
      selectedOutputKeys,
      runnerMode: "fake",
      model: null,
      reasoningEffort: null,
      command,
      exitCode: null,
      error: null,
      startedAt: now,
      finishedAt: null,
      createdAt: now,
    };
  }

  async appendEvent(): Promise<void> {}

  async completeExecution(
    _executionId: string,
    _exitCode: number,
    _artifacts: ArtifactRecordInput[],
  ): Promise<void> {}

  async failExecution(): Promise<void> {
    assert.fail("the stale-review execution fixture must not fail");
  }
}

async function executionReviewRaceFixture(reviewKind: "decision-capture" | "ordinary-review") {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-review-race-"));
  const requestedRoot = path.join(parent, "sample");
  await initializeCodexProject(
    requestedRoot,
    "Review race",
    "Use the authoritative Review snapshot when execution starts",
  );
  const rootPath = await realpath(requestedRoot);
  const project: ProjectDto = {
    id: randomUUID(),
    name: "Review race",
    summary: "Use the authoritative Review snapshot when execution starts",
    rootPath,
    configPath: path.join(rootPath, "ai-native.yaml"),
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const run: WorkflowRunDto = {
    id: randomUUID(),
    projectId: project.id,
    title: "Review race",
    objective: "Materialize the latest human direction",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const artifactContent = [
    "# PRD",
    "",
    "**Status:** Pending human decision",
    "",
    "## Open questions for a human",
    "",
    "- [ ] Which layout should the AI SDLC experience use?",
    "",
  ].join("\n");
  const artifact: ArtifactDto = {
    id: randomUUID(),
    phaseRunId: "",
    artifactKey: "prd",
    filePath: "docs/review-race-prd.md",
    contentHash: createHash("sha256").update(artifactContent).digest("hex"),
    content: artifactContent,
    reviewStatus: "changes_requested",
    revision: 1,
    revisionSource: "ai",
    parentArtifactId: null,
    superseded: false,
    createdAt: now,
  };
  const storyContent = reviewableStoriesSnapshot();
  const storyArtifact: ArtifactDto = {
    id: randomUUID(),
    phaseRunId: "",
    artifactKey: "user-stories",
    filePath: "docs/review-race-user-stories.md",
    contentHash: createHash("sha256").update(storyContent).digest("hex"),
    content: storyContent,
    reviewStatus: "changes_requested",
    revision: 1,
    revisionSource: "ai",
    parentArtifactId: null,
    superseded: false,
    createdAt: now,
  };
  const phaseId = randomUUID();
  artifact.phaseRunId = phaseId;
  storyArtifact.phaseRunId = phaseId;
  const decisionGate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts: [artifact, storyArtifact],
    reviews: [],
    enforceUserStoriesQuality: true,
  });
  const decisionId = decisionGate.items.find(({ kind }) => kind === "decision")?.id;
  assert.ok(decisionId, "the race fixture must contain one product decision");
  const review: ReviewDto = {
    id: randomUUID(),
    phaseRunId: phaseId,
    decision: "request_changes",
    comment: reviewKind === "decision-capture"
      ? serializeHumanDecisionCapture({
          phaseId: "discovery",
          responses: [{
            id: decisionId,
            response: "Use a compact table in the existing section order.",
          }],
        })
      : "Keep the existing scope, but make every acceptance criterion independently testable.",
    artifactIds: [artifact.id, storyArtifact.id],
    createdAt: "2026-08-20T08:01:00.000Z",
  };
  const initialPhase: PhaseRunDto = {
    id: phaseId,
    workflowRunId: run.id,
    phaseId: "discovery",
    position: 0,
    status: "ready",
    artifacts: [artifact, storyArtifact],
    reviews: [],
    executions: [],
    events: [],
    availableArtifacts: [],
    createdAt: now,
    updatedAt: now,
  };
  const latestPhase: PhaseRunDto = {
    ...initialPhase,
    status: "changes_requested",
    reviews: [review],
    updatedAt: review.createdAt,
  };
  const initialBundle: RunBundle = {
    project,
    run,
    phases: [initialPhase],
    artifactPaths: { prd: artifact.filePath, "user-stories": storyArtifact.filePath },
  };
  const latestBundle: RunBundle = {
    project,
    run: { ...run, updatedAt: review.createdAt },
    phases: [latestPhase],
    artifactPaths: { prd: artifact.filePath, "user-stories": storyArtifact.filePath },
  };
  const runner = new RaceCapturingRunner();
  const store = new ExecutionReviewRaceStore(
    initialBundle,
    latestBundle,
    [artifact, storyArtifact],
  );
  const service = new WorkflowService(
    store as unknown as PgWorkflowStore,
    new ProjectPathPolicy([parent]),
    runner,
  );
  store.attach(service);
  return {
    service,
    store,
    runner,
    run,
    review,
    async dispose() {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

function reviewableStoriesSnapshot(): string {
  return `## experience/US-001-review-ai-sdlc/story.md

# US-001: Review the AI SDLC experience

## User story

As a reviewer, I want a compact delivery summary, so that I can verify the result efficiently.

## Acceptance criteria

### US-001-AC-01: Review the primary result

\`\`\`gherkin
Given an AI SDLC result exists
When the reviewer opens its summary
Then the primary result is visible in a compact table
\`\`\`

### US-001-AC-02: Review supporting evidence

\`\`\`gherkin
Given supporting evidence exists
When the reviewer inspects the result
Then the evidence remains available in the documented section order
\`\`\`
`;
}
