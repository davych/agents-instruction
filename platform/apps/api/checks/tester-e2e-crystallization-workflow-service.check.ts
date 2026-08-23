import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PHASE_IDS,
  PHASE_ROUTE_VERSION,
  type ArtifactDto,
  type ChangeContractDto,
  type ExecutionDto,
  type PhaseId,
  type PhaseResolutionDto,
  type PhaseRunDto,
  type ProjectDto,
  type ReviewDto,
  type WorkflowRunDto,
} from "@ai-sdlc/contracts";

import type {
  ArtifactRecordInput,
  CurrentArtifactSnapshot,
  PgWorkflowStore,
  RunBundle,
  SelectionArtifact,
} from "../src/db/store.ts";
import { TESTER_E2E_CRYSTALLIZATION_MARKER } from "../src/domain/tester-e2e-crystallization-feedback.ts";
import {
  CodexTerminalRunner,
  type CodexRunRequest,
  type CodexRunResult,
} from "../src/services/codex-runner.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

test("Tester E2E crystallization request reaches a later Implementation rerun as read-only feedback", async () => {
  const fixture = await crystallizationFixture({ reviewState: "marked" });
  try {
    await fixture.service.executePhase(fixture.run.id, "implementation", {
      selectedArtifactIds: [fixture.contractArtifact.id],
    });
    await fixture.service.waitForIdle();

    assert.equal(fixture.runner.requests.length, 1);
    const request = fixture.runner.requests[0]!;
    assert.deepEqual(
      request.selectedArtifacts.map((artifact) => artifact.id),
      [fixture.contractArtifact.id],
      "the test-report must not become an authoritative selected upstream input",
    );
    assert.deepEqual(fixture.store.selectionCalls, [[fixture.contractArtifact.id]]);
    assert.deepEqual(fixture.store.snapshotCalls, ["implementation", "verification"]);
    assert.equal(request.revisionFeedback?.length, 1);

    const feedback = request.revisionFeedback?.[0] ?? "";
    assert.match(feedback, /read-only, non-authoritative scope/iu);
    assert.match(feedback, /docs\/ai-native\/testing\/run--test-report\.md/iu);
    assert.match(feedback, /Revision: 3/iu);
    assert.match(feedback, /checkout-coupon/iu);
    assert.match(feedback, /CC-AC-001: A shopper can complete checkout with a valid coupon\./iu);
    assert.doesNotMatch(feedback, /CC-AC-001:\s*CC-AC-001/iu);
    assert.match(feedback, /Frozen intent: valid coupon reduces the payable total before order confirmation\./iu);
    assert.match(feedback, /Excluded from that independent authoring context: implementation source\/diff, exploratory MCP transcript/iu);
    assert.doesNotMatch(feedback, /Raw exploration notes|selector attempt|selector #coupon/iu);
    assert.ok(feedback.length < 5_000, "only parsed bounded request fields may cross the phase boundary");
  } finally {
    await fixture.dispose();
  }
});

test("ordinary Verification reviews do not alter Implementation revision feedback", async () => {
  const fixture = await crystallizationFixture({ reviewState: "ordinary" });
  try {
    await fixture.service.executePhase(fixture.run.id, "implementation", {
      selectedArtifactIds: [fixture.contractArtifact.id],
    });
    await fixture.service.waitForIdle();

    const request = fixture.runner.requests[0]!;
    assert.deepEqual(request.revisionFeedback, []);
    assert.deepEqual(fixture.store.snapshotCalls, ["implementation"]);
    assert.deepEqual(fixture.store.selectionCalls, [[fixture.contractArtifact.id]]);
  } finally {
    await fixture.dispose();
  }
});

test("a stale crystallization request is retired by the later controlling Verification approval", async () => {
  const fixture = await crystallizationFixture({ reviewState: "later-approved" });
  try {
    await fixture.service.executePhase(fixture.run.id, "implementation", {
      selectedArtifactIds: [fixture.contractArtifact.id],
    });
    await fixture.service.waitForIdle();

    const request = fixture.runner.requests[0]!;
    assert.deepEqual(request.revisionFeedback, []);
    assert.deepEqual(fixture.store.snapshotCalls, ["implementation"]);
  } finally {
    await fixture.dispose();
  }
});

test("malformed crystallization markers never reach an Implementation rerun", async (context) => {
  const validFields = [
    "AC: CC-AC-001",
    "Frozen intent: valid coupon reduces the payable total before order confirmation.",
  ];
  const cases = new Map<string, string>([
    [
      "marker on a later line",
      ["Diagnostic preface", `${TESTER_E2E_CRYSTALLIZATION_MARKER} checkout-coupon`, ...validFields].join("\n"),
    ],
    [
      "empty scenario",
      [`${TESTER_E2E_CRYSTALLIZATION_MARKER} `, ...validFields].join("\n"),
    ],
    [
      "missing AC field",
      [
        `${TESTER_E2E_CRYSTALLIZATION_MARKER} checkout-coupon`,
        "Frozen intent: valid coupon reduces the payable total before order confirmation.",
      ].join("\n"),
    ],
    [
      "missing Frozen intent field",
      [`${TESTER_E2E_CRYSTALLIZATION_MARKER} checkout-coupon`, "AC: CC-AC-001"].join("\n"),
    ],
    [
      "unknown Change Contract AC",
      [
        `${TESTER_E2E_CRYSTALLIZATION_MARKER} checkout-coupon`,
        "AC: CC-AC-999",
        "Frozen intent: valid coupon reduces the payable total before order confirmation.",
      ].join("\n"),
    ],
  ]);

  for (const [label, reviewComment] of cases) {
    await context.test(label, async () => {
      const fixture = await crystallizationFixture({ reviewState: "marked", reviewComment });
      try {
        await fixture.service.executePhase(fixture.run.id, "implementation", {
          selectedArtifactIds: [fixture.contractArtifact.id],
        });
        await fixture.service.waitForIdle();

        assert.deepEqual(fixture.runner.requests[0]?.revisionFeedback, []);
        assert.deepEqual(fixture.store.snapshotCalls, ["implementation"]);
      } finally {
        await fixture.dispose();
      }
    });
  }
});

class CapturingRunner extends CodexTerminalRunner {
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

class CrystallizationStore {
  readonly snapshotCalls: PhaseId[] = [];
  readonly selectionCalls: string[][] = [];

  constructor(
    private readonly bundle: RunBundle,
    private readonly contractArtifact: SelectionArtifact,
    private readonly reportArtifact: CurrentArtifactSnapshot,
  ) {}

  async getRun(): Promise<RunBundle> {
    return this.bundle;
  }

  async selectionArtifacts(_runId: string, ids: string[]): Promise<SelectionArtifact[]> {
    this.selectionCalls.push([...ids]);
    assert.deepEqual(ids, [this.contractArtifact.id]);
    return [this.contractArtifact];
  }

  async currentArtifactSnapshotsForPhase(
    _runId: string,
    phaseId: PhaseId,
  ): Promise<CurrentArtifactSnapshot[]> {
    this.snapshotCalls.push(phaseId);
    return phaseId === "verification" ? [this.reportArtifact] : [];
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
      phaseRunId: requiredPhase(this.bundle, "implementation").id,
      status: "running",
      selectedArtifactIds,
      selectedOutputKeys,
      runnerMode: "fake",
      model: null,
      reasoningEffort: null,
      command,
      exitCode: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      createdAt: new Date().toISOString(),
    };
  }

  async appendEvent(): Promise<void> {}

  async completeExecution(
    _executionId: string,
    _exitCode: number,
    _artifacts: ArtifactRecordInput[],
  ): Promise<void> {}

  async failExecution(): Promise<void> {
    assert.fail("capturing runner must not fail");
  }
}

async function crystallizationFixture(options: {
  reviewState: "marked" | "ordinary" | "later-approved";
  reviewComment?: string;
}): Promise<{
  parent: string;
  run: WorkflowRunDto;
  contractArtifact: SelectionArtifact;
  runner: CapturingRunner;
  store: CrystallizationStore;
  service: WorkflowService;
  dispose(): Promise<void>;
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-tester-feedback-"));
  const requestedRoot = path.join(parent, "sample");
  await initializeCodexProject(requestedRoot, "Tester feedback", "Service-level feedback routing test");
  const root = await realpath(requestedRoot);
  const now = "2026-08-20T12:00:00.000Z";
  const runId = randomUUID();
  const project: ProjectDto = {
    id: randomUUID(),
    name: "Tester feedback",
    summary: "Service-level feedback routing test",
    rootPath: root,
    configPath: path.join(root, "ai-native.yaml"),
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const changeContract: ChangeContractDto = {
    workType: "bug",
    summary: "Crystallize coupon checkout coverage",
    currentBehavior: "The path was explored but has no repeatable repository E2E.",
    expectedBehavior: "The approved coupon checkout journey has a standalone E2E.",
    inScope: ["Coupon checkout E2E"],
    outOfScope: ["New coupon behavior"],
    acceptanceCriteria: ["CC-AC-001: A shopper can complete checkout with a valid coupon."],
    regressionScope: ["Checkout without a coupon"],
    riskFlags: ["Browser selector stability"],
    evidenceRefs: ["test-report"],
  };
  const run: WorkflowRunDto = {
    id: runId,
    projectId: project.id,
    title: "Coupon checkout",
    objective: changeContract.expectedBehavior,
    status: "active",
    changeContract,
    createdAt: now,
    updatedAt: now,
  };
  const phases = PHASE_IDS.map((phaseId, position): PhaseRunDto => ({
    id: randomUUID(),
    workflowRunId: runId,
    phaseId,
    position,
    status: phaseId === "release"
      ? "pending"
      : phaseId === "verification" && options.reviewState !== "later-approved"
        ? "changes_requested"
        : "approved",
    artifacts: [],
    reviews: [],
    executions: [],
    events: [],
    availableArtifacts: [],
    resolution: routeResolution(phaseId, now),
    architectureImpact: null,
    createdAt: now,
    updatedAt: now,
  }));
  const contractContent = "# Change Contract\n\nCC-AC-001: A shopper can complete checkout with a valid coupon.\n";
  const contractPath = "docs/ai-native/product/run--change-contract.md";
  await mkdir(path.dirname(path.join(root, contractPath)), { recursive: true });
  await writeFile(path.join(root, contractPath), contractContent, "utf8");
  const discovery = requiredPhase({ project, run, phases, artifactPaths: {} }, "discovery");
  const contractArtifact: SelectionArtifact = {
    id: randomUUID(),
    phaseRunId: discovery.id,
    artifactKey: "change-contract",
    filePath: contractPath,
    content: contractContent,
    contentHash: digest(contractContent),
    reviewStatus: "approved",
    revision: 1,
    revisionSource: "human",
    parentArtifactId: null,
    createdAt: now,
    sourcePosition: discovery.position,
    sourceStatus: "approved",
    workflowRunId: runId,
  };
  discovery.artifacts.push(contractArtifact);

  const verification = requiredPhase({ project, run, phases, artifactPaths: {} }, "verification");
  const reportContent = [
    "# Test report",
    "",
    "Scenario: checkout-coupon",
    "Frozen intent: valid coupon reduces the payable total before order confirmation.",
    "Exploration status: path discovered; no reusable spec exists.",
    `Raw exploration notes: ${"selector attempt; ".repeat(700)}`,
  ].join("\n");
  const reportArtifact: CurrentArtifactSnapshot = {
    id: randomUUID(),
    phaseRunId: verification.id,
    artifactKey: "test-report",
    filePath: "docs/ai-native/testing/run--test-report.md",
    content: reportContent,
    contentHash: digest(reportContent),
    reviewStatus: "changes_requested",
    revision: 3,
    revisionSource: "human",
    parentArtifactId: randomUUID(),
    createdAt: now,
  };
  verification.artifacts.push(reportArtifact);
  const review: ReviewDto = {
    id: randomUUID(),
    phaseRunId: verification.id,
    decision: "request_changes",
    comment: options.reviewComment ?? (options.reviewState !== "ordinary"
      ? [
          `${TESTER_E2E_CRYSTALLIZATION_MARKER} checkout-coupon`,
          "AC: CC-AC-001",
          "Frozen intent: valid coupon reduces the payable total before order confirmation.",
          "Diagnostic: selector #coupon must stay inside Verification and not cross this boundary.",
        ].join("\n")
      : "Please clarify the report wording; no repository test change is requested."),
    artifactIds: [reportArtifact.id],
    createdAt: now,
  };
  verification.reviews.push(review);
  if (options.reviewState === "later-approved") {
    verification.reviews.push({
      id: randomUUID(),
      phaseRunId: verification.id,
      decision: "approve",
      comment: "The current report now has complete standalone execution evidence.",
      artifactIds: [reportArtifact.id],
      createdAt: "2026-08-20T12:05:00.000Z",
    });
  }

  const bundle: RunBundle = {
    project,
    run,
    phases,
    artifactPaths: {},
  };
  const runner = new CapturingRunner();
  const store = new CrystallizationStore(bundle, contractArtifact, reportArtifact);
  const service = new WorkflowService(
    store as unknown as PgWorkflowStore,
    new ProjectPathPolicy([parent]),
    runner,
  );
  return {
    parent,
    run,
    contractArtifact,
    runner,
    store,
    service,
    async dispose() {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

function routeResolution(phaseId: PhaseId, decidedAt: string): PhaseResolutionDto | null {
  if (phaseId === "discovery") {
    return resolution("discovery", "direct", decidedAt);
  }
  if (phaseId === "design" || phaseId === "architecture") {
    return resolution(phaseId, "skip", decidedAt);
  }
  return null;
}

function resolution(
  phaseId: "discovery" | "design" | "architecture",
  mode: "direct" | "skip",
  decidedAt: string,
): PhaseResolutionDto {
  return {
    phaseId,
    mode,
    rationale: "The immutable Change Contract is sufficient for this focused bug fix.",
    inputArtifactIds: [],
    sourceRunId: null,
    sourceRunTitle: null,
    sourcePhaseRunId: null,
    sourceArtifactIds: [],
    affectedOutputKeys: [],
    routeVersion: PHASE_ROUTE_VERSION,
    decidedAt,
  };
}

function requiredPhase(bundle: RunBundle, phaseId: PhaseId): PhaseRunDto {
  const phase = bundle.phases.find((candidate) => candidate.phaseId === phaseId);
  assert.ok(phase, `missing ${phaseId} phase`);
  return phase;
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
