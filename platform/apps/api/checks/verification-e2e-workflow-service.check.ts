import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PHASE_IDS,
  type E2eAuthoringDto,
  type E2eWorkspaceDto,
  type E2eWorkspaceReadinessDto,
  type ExecutionDto,
  type ExecutionEventDto,
  type PhaseId,
  type PhaseRunDto,
  type ProjectDto,
  type ReviewVerificationE2eScriptsInput,
  type WorkflowRunDto,
} from "@ai-sdlc/contracts";

import type {
  ArtifactRecordInput,
  CurrentArtifactSnapshot,
  PgWorkflowStore,
  RunBundle,
  SelectionArtifact,
} from "../src/db/store.ts";
import type { FrozenE2eIntent } from "../src/domain/verification-e2e-intent.ts";
import { AppError } from "../src/domain/errors.ts";
import {
  CodexTerminalRunner,
  type CodexRunRequest,
  type CodexRunResult,
} from "../src/services/codex-runner.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import type { VerificationE2eCoordinator } from "../src/services/verification-e2e-coordinator.ts";
import {
  WorkflowService,
  assertLinkedE2eApprovalObligation,
} from "../src/services/workflow-service.ts";

test("Linked E2E authoring freezes approved intent and stops for exact-hash human review", async () => {
  const fixture = await workflowFixture();
  try {
    await fixture.service.preflightVerificationE2e(fixture.run.id);
    assert.equal(fixture.coordinator.readinessCalls, 1);
    const execution = await fixture.service.authorVerificationE2e(fixture.run.id, {
      selectedArtifactIds: fixture.selected.map(({ id }) => id),
    });
    assert.equal(execution.status, "running");
    await fixture.service.waitForIdle();

    assert.equal(fixture.coordinator.authorInputs.length, 1);
    const frozen = fixture.coordinator.authorInputs[0]!.intent;
    assert.deepEqual(frozen.criteria.map(({ id }) => id), ["CC-AC-001", "REG-001"]);
    assert.ok(frozen.authoritativeArtifacts.some(({ artifactKey }) => artifactKey === "user-stories"));
    assert.ok(!frozen.authoritativeArtifacts.some(({ artifactKey }) => artifactKey === "implementation-notes"));
    assert.equal(fixture.store.reviewCalls, 0, "script review must not approve the Verification phase");

    const report = fixture.store.current("verification").find(({ artifactKey }) => artifactKey === "test-report");
    assert.match(report?.content ?? "", /Pending human script review/u);
    const flow = await fixture.service.getVerificationE2eFlow(fixture.run.id);
    assert.equal(fixture.coordinator.readinessCalls, 1, "GET must reuse preflight and not relaunch Chromium");
    assert.equal(flow.state, "awaiting_script_review");
    assert.equal(flow.authoring?.patchHash, fixture.coordinator.authoring?.patchHash);
  } finally {
    await fixture.dispose();
  }
});

test("an approved script hash enables supervised E2E, then returns to normal Verification review", async () => {
  const fixture = await workflowFixture();
  try {
    await fixture.service.preflightVerificationE2e(fixture.run.id);
    const upstreamIds = fixture.selected
      .filter(({ sourcePosition }) => sourcePosition < PHASE_IDS.indexOf("verification"))
      .map(({ id }) => id);
    await fixture.service.authorVerificationE2e(fixture.run.id, {
      selectedArtifactIds: upstreamIds,
    });
    await fixture.service.waitForIdle();
    const patchHash = fixture.coordinator.authoring?.patchHash;
    assert.ok(patchHash);

    const reviewed = await fixture.service.reviewVerificationE2eScripts(fixture.run.id, {
      decision: "approve",
      expectedPatchHash: patchHash,
      comment: "I reviewed the exact generated files and manifest hash.",
    });
    assert.equal(reviewed.state, "ready_to_execute");
    assert.equal(fixture.store.reviewCalls, 0, "script approval remains separate from phase approval");

    await fixture.service.executeVerificationE2e(fixture.run.id, {
      selectedArtifactIds: upstreamIds,
    });
    await fixture.service.waitForIdle();

    assert.equal(fixture.coordinator.executeCalls, 1);
    assert.equal(fixture.runner.requests.length, 1);
    assert.match(fixture.runner.requests[0]?.revisionFeedback?.[0] ?? "", /machine-owned linked E2E evidence/u);
    assert.equal(fixture.store.completed.at(-1)?.exitCode, 0);
    const flow = await fixture.service.getVerificationE2eFlow(fixture.run.id);
    assert.equal(flow.state, "awaiting_verification_review");
    assert.equal(fixture.store.reviewCalls, 0);
  } finally {
    await fixture.dispose();
  }
});

test("Verification approval rejects incomplete or tampered linked E2E completion fields", async () => {
  const fixture = await workflowFixture();
  try {
    await fixture.service.preflightVerificationE2e(fixture.run.id);
    const selectedArtifactIds = fixture.selected
      .filter(({ sourcePosition }) => sourcePosition < PHASE_IDS.indexOf("verification"))
      .map(({ id }) => id);
    await fixture.service.authorVerificationE2e(fixture.run.id, { selectedArtifactIds });
    await fixture.service.waitForIdle();
    await fixture.service.reviewVerificationE2eScripts(fixture.run.id, {
      decision: "approve",
      expectedPatchHash: fixture.coordinator.authoring!.patchHash,
      comment: "approved",
    });
    await fixture.service.executeVerificationE2e(fixture.run.id, { selectedArtifactIds });
    await fixture.service.waitForIdle();

    const phase = requiredPhase(fixture.store.bundle, "verification");
    const artifacts = fixture.store.current("verification");
    assert.doesNotThrow(() => assertLinkedE2eApprovalObligation(phase, artifacts));
    const mutations: Array<[string, (payload: Record<string, unknown>) => void]> = [
      ["missing raw test exit", (payload) => { delete payload.testExitCode; }],
      ["missing cleanup", (payload) => { delete payload.serverCleanup; }],
      ["forced cleanup", (payload) => { payload.serverCleanup = "sigkill"; }],
      ["redirected target URL", (payload) => {
        (payload.targetProbe as Record<string, unknown>).url = `${payload.baseUrl}redirected`;
      }],
      ["server error status", (payload) => {
        (payload.targetProbe as Record<string, unknown>).status = 500;
      }],
      ["browser version mismatch", (payload) => {
        (payload.targetProbe as Record<string, unknown>).browserVersion = "Chromium tampered";
      }],
      ["missing locked browser version", (payload) => {
        (payload.browser as Record<string, unknown>).version = "";
      }],
    ];
    for (const [label, mutate] of mutations) {
      const changed = structuredClone(phase);
      const event = changed.events.find(({ eventType }) => eventType === "e2e.execution.completed");
      assert.ok(event && event.payload && typeof event.payload === "object");
      mutate(event.payload as Record<string, unknown>);
      assert.throws(
        () => assertLinkedE2eApprovalObligation(changed, artifacts),
        { code: "E2E_LINKED_EXECUTION_REQUIRED" },
        label,
      );
    }
  } finally {
    await fixture.dispose();
  }
});

test("executePhase rejects every verificationAction outside Verification", async () => {
  const fixture = await workflowFixture();
  try {
    await assert.rejects(
      fixture.service.executePhase(fixture.run.id, "implementation", {
        selectedArtifactIds: [],
        verificationAction: "standard",
      }),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "VERIFICATION_ACTION_PHASE_MISMATCH"
      ),
    );
    assert.equal(fixture.store.executionCreates, 0);
  } finally {
    await fixture.dispose();
  }
});

test("a forged local approved status cannot replace the DB human-review event", async () => {
  const fixture = await workflowFixture();
  try {
    await fixture.service.preflightVerificationE2e(fixture.run.id);
    const selectedArtifactIds = fixture.selected
      .filter(({ sourcePosition }) => sourcePosition < PHASE_IDS.indexOf("verification"))
      .map(({ id }) => id);
    await fixture.service.authorVerificationE2e(fixture.run.id, { selectedArtifactIds });
    await fixture.service.waitForIdle();
    assert.ok(fixture.coordinator.authoring);
    fixture.coordinator.authoring = { ...fixture.coordinator.authoring, status: "approved" };

    await fixture.service.executeVerificationE2e(fixture.run.id, { selectedArtifactIds });
    await fixture.service.waitForIdle();
    assert.equal(fixture.coordinator.executeCalls, 0);
    const failed = requiredPhase(fixture.store.bundle, "verification").executions[0];
    assert.equal(failed?.status, "failed");
    assert.match(failed?.error ?? "", /E2E_SCRIPT_REVIEW_REQUIRED/u);
  } finally {
    await fixture.dispose();
  }
});

test("DB script reviews are latest-wins and hash mismatches fail closed", async () => {
  const fixture = await workflowFixture();
  try {
    await fixture.service.preflightVerificationE2e(fixture.run.id);
    const selectedArtifactIds = fixture.selected
      .filter(({ sourcePosition }) => sourcePosition < PHASE_IDS.indexOf("verification"))
      .map(({ id }) => id);
    await fixture.service.authorVerificationE2e(fixture.run.id, { selectedArtifactIds });
    await fixture.service.waitForIdle();
    const patchHash = fixture.coordinator.authoring!.patchHash;
    await fixture.service.reviewVerificationE2eScripts(fixture.run.id, {
      decision: "approve",
      expectedPatchHash: patchHash,
      comment: "approved exact bytes",
    });
    const requested = await fixture.service.reviewVerificationE2eScripts(fixture.run.id, {
      decision: "request_changes",
      expectedPatchHash: patchHash,
      comment: "newer review withdraws approval",
    });
    assert.equal(requested.state, "needs_authoring");

    const phase = requiredPhase(fixture.store.bundle, "verification");
    const latestReview = phase.events.filter(({ eventType }) => eventType === "e2e.script.reviewed").at(-1)!;
    latestReview.payload = { ...(latestReview.payload as object), decision: "approve", patchHash: "0".repeat(64) };
    fixture.coordinator.authoring = { ...fixture.coordinator.authoring!, status: "approved" };
    const mismatched = await fixture.service.getVerificationE2eFlow(fixture.run.id);
    assert.equal(mismatched.state, "awaiting_script_review");
    assert.ok(mismatched.blockers.some((blocker) => blocker.includes("hash/revision")));
  } finally {
    await fixture.dispose();
  }
});

test("script review rejects an author record copied from another run/execution", async () => {
  const fixture = await workflowFixture();
  try {
    await fixture.service.preflightVerificationE2e(fixture.run.id);
    const selectedArtifactIds = fixture.selected
      .filter(({ sourcePosition }) => sourcePosition < PHASE_IDS.indexOf("verification"))
      .map(({ id }) => id);
    await fixture.service.authorVerificationE2e(fixture.run.id, { selectedArtifactIds });
    await fixture.service.waitForIdle();
    fixture.coordinator.authoring = {
      ...fixture.coordinator.authoring!,
      executionId: randomUUID(),
    };
    await assert.rejects(
      () => fixture.service.reviewVerificationE2eScripts(fixture.run.id, {
        decision: "approve",
        expectedPatchHash: fixture.coordinator.authoring!.patchHash,
        comment: "must not approve a foreign execution",
      }),
      { code: "E2E_AUTHORING_EXECUTION_UNTRUSTED" },
    );
    assert.equal(
      requiredPhase(fixture.store.bundle, "verification").events
        .filter(({ eventType }) => eventType === "e2e.script.reviewed").length,
      0,
    );
  } finally {
    await fixture.dispose();
  }
});

test("stale authored bytes degrade flow to recoverable authoring instead of a page error", async () => {
  const fixture = await workflowFixture();
  try {
    await fixture.service.preflightVerificationE2e(fixture.run.id);
    fixture.coordinator.latestError = new AppError(
      "manifest bytes changed",
      409,
      "E2E_AUTHORING_RECORD_INVALID",
    );
    const flow = await fixture.service.getVerificationE2eFlow(fixture.run.id);
    assert.equal(flow.state, "needs_authoring");
    assert.ok(flow.blockers.some((blocker) => blocker.includes("重新生成")));
  } finally {
    await fixture.dispose();
  }
});

test("the outer E2E guard restores reporter mutations and fails the linked execution", async () => {
  const fixture = await workflowFixture();
  try {
    await fixture.service.preflightVerificationE2e(fixture.run.id);
    const selectedArtifactIds = fixture.selected
      .filter(({ sourcePosition }) => sourcePosition < PHASE_IDS.indexOf("verification"))
      .map(({ id }) => id);
    await fixture.service.authorVerificationE2e(fixture.run.id, { selectedArtifactIds });
    await fixture.service.waitForIdle();
    const patchHash = fixture.coordinator.authoring!.patchHash;
    await fixture.service.reviewVerificationE2eScripts(fixture.run.id, {
      decision: "approve",
      expectedPatchHash: patchHash,
      comment: "approved",
    });
    const testFile = path.join(fixture.e2eRoot, "tests", "guarded.spec.ts");
    await mkdir(path.dirname(testFile), { recursive: true });
    await writeFile(testFile, "original\n", "utf8");
    fixture.runner.mutateE2eFile = testFile;
    await fixture.service.executeVerificationE2e(fixture.run.id, { selectedArtifactIds });
    await fixture.service.waitForIdle();

    assert.equal(await readFile(testFile, "utf8"), "original\n");
    assert.equal(requiredPhase(fixture.store.bundle, "verification").executions[0]?.status, "failed");
  } finally {
    await fixture.dispose();
  }
});

test("cleanup failure uses an effective nonzero exit and stale test-report heads require rerun", async () => {
  const fixture = await workflowFixture();
  try {
    await fixture.service.preflightVerificationE2e(fixture.run.id);
    const selectedArtifactIds = fixture.selected
      .filter(({ sourcePosition }) => sourcePosition < PHASE_IDS.indexOf("verification"))
      .map(({ id }) => id);
    await fixture.service.authorVerificationE2e(fixture.run.id, { selectedArtifactIds });
    await fixture.service.waitForIdle();
    await fixture.service.reviewVerificationE2eScripts(fixture.run.id, {
      decision: "approve",
      expectedPatchHash: fixture.coordinator.authoring!.patchHash,
      comment: "approved",
    });
    fixture.coordinator.executionPassed = false;
    fixture.coordinator.serverCleanup = "sigkill";
    await fixture.service.executeVerificationE2e(fixture.run.id, { selectedArtifactIds });
    await fixture.service.waitForIdle();
    assert.equal(fixture.store.completed.at(-1)?.exitCode, 1);
    assert.equal((await fixture.service.getVerificationE2eFlow(fixture.run.id)).state, "failed");

    fixture.store.setArtifactExecutionHead("test-report", "later-standard-tester");
    const stale = await fixture.service.getVerificationE2eFlow(fixture.run.id);
    assert.equal(stale.state, "ready_to_execute");
    assert.ok(stale.blockers.some((blocker) => blocker.includes("不是当前 test-report head")));
    assert.throws(
      () => assertLinkedE2eApprovalObligation(
        requiredPhase(fixture.store.bundle, "verification"),
        fixture.store.current("verification"),
      ),
      { code: "E2E_LINKED_EXECUTION_REQUIRED" },
      "a later standard Tester head cannot bypass a selected but failed Linked E2E obligation",
    );
  } finally {
    await fixture.dispose();
  }
});

class CapturingVerificationRunner extends CodexTerminalRunner {
  readonly requests: CodexRunRequest[] = [];
  mutateE2eFile: string | null = null;

  constructor() {
    super({ fake: true });
  }

  override async run(
    request: CodexRunRequest,
    onEvent: (eventType: string, payload: unknown) => Promise<void>,
  ): Promise<CodexRunResult> {
    this.requests.push(request);
    const artifact = request.definition.artifacts.find(({ id }) => id === "test-report");
    assert.ok(artifact);
    const content = [
      "# Test Report",
      "",
      "Verification state: Awaiting review",
      "machine-owned linked E2E evidence was incorporated.",
      "",
    ].join("\n");
    await mkdir(path.dirname(artifact.absolutePath), { recursive: true });
    await writeFile(artifact.absolutePath, content, "utf8");
    if (this.mutateE2eFile) await writeFile(this.mutateE2eFile, "tampered by reporter\n", "utf8");
    await onEvent("runner.completed", { exitCode: 0 });
    return {
      exitCode: 0,
      artifacts: [{
        artifactKey: "test-report",
        filePath: artifact.relativePath,
        content,
        contentHash: digest(content),
      }],
    };
  }
}

class FakeVerificationE2eCoordinator {
  authoring: E2eAuthoringDto | null = null;
  readonly authorInputs: Array<{ intent: FrozenE2eIntent }> = [];
  executeCalls = 0;
  readinessCalls = 0;
  executionPassed = true;
  serverCleanup: "already_exited" | "sigterm" | "sigkill" = "sigterm";
  latestError: Error | null = null;

  constructor(private readonly workspaceDto: E2eWorkspaceDto) {}

  async optionalWorkspace(): Promise<E2eWorkspaceDto> {
    return this.workspaceDto;
  }

  async workspace(): Promise<E2eWorkspaceDto> {
    return this.workspaceDto;
  }

  async readiness(): Promise<E2eWorkspaceReadinessDto> {
    this.readinessCalls += 1;
    return readyWorkspace();
  }

  async latestAuthoring(): Promise<E2eAuthoringDto | null> {
    if (this.latestError) throw this.latestError;
    return this.authoring;
  }

  async author(input: {
    runId: string;
    executionId: string;
    intent: FrozenE2eIntent;
  }): Promise<{ authoring: E2eAuthoringDto; reportContent: string }> {
    this.authorInputs.push({ intent: input.intent });
    const now = new Date().toISOString();
    this.authoring = {
      runId: input.runId,
      executionId: input.executionId,
      status: "awaiting_review",
      patchHash: "a".repeat(64),
      productRevisionToken: "b".repeat(64),
      e2eRevisionToken: "c".repeat(64),
      criterionIds: input.intent.criteria.map(({ id }) => id),
      files: [{ path: "tests/checkout.spec.ts", sha256: "d".repeat(64), bytes: 120 }],
      reviewComment: null,
      reviewedAt: null,
      createdAt: now,
    };
    return {
      authoring: this.authoring,
      reportContent: "# Test Report\n\nPending human script review.\n",
    };
  }

  async review(
    _project: ProjectDto,
    _runId: string,
    input: ReviewVerificationE2eScriptsInput,
  ): Promise<E2eAuthoringDto> {
    assert.ok(this.authoring);
    assert.equal(input.expectedPatchHash, this.authoring.patchHash);
    this.authoring = {
      ...this.authoring,
      status: input.decision === "approve" ? "approved" : "changes_requested",
      reviewComment: input.comment,
      reviewedAt: new Date().toISOString(),
    };
    return this.authoring;
  }

  async execute(input: {
    executionId: string;
    onEvent: (eventType: string, payload: unknown) => Promise<void>;
  }) {
    assert.equal(this.authoring?.status, "approved");
    this.executeCalls += 1;
    await input.onEvent("e2e.execution.started", { e2eRoot: this.workspaceDto.rootPath });
    await input.onEvent("e2e.execution.completed", {
      workingDirectory: this.workspaceDto.rootPath,
      baseUrl: this.workspaceDto.baseUrl,
      command: "npm run test:e2e",
      exitCode: this.executionPassed ? 0 : 1,
      testExitCode: 0,
      passed: this.executionPassed,
      serverCleanup: this.serverCleanup,
      browser: { executablePath: "/browser/chromium", version: "Chromium 140" },
      targetProbe: {
        url: this.workspaceDto.baseUrl,
        status: 200,
        browserVersion: "Chromium 140",
      },
    });
    return {
      result: {
        executionId: input.executionId,
        passed: this.executionPassed,
        testExitCode: 0,
        serverExitCode: 0,
        serverCleanup: this.serverCleanup,
        sourceCommand: { command: "npm", args: ["run", "dev"], cwd: "product" },
        testCommand: { command: "npm", args: ["run", "test:e2e"], cwd: this.workspaceDto.rootPath },
        browser: { executablePath: "/browser/chromium", version: "Chromium 140" },
        targetProbe: {
          url: this.workspaceDto.baseUrl,
          status: 200,
          browserVersion: "Chromium 140",
        },
        stdoutSha256: "1".repeat(64),
        stderrSha256: "2".repeat(64),
        evidence: [],
        manifestPath: "test-results/run.json",
        manifestSha256: "3".repeat(64),
      },
      authoring: this.authoring!,
      prompt: "machine-owned linked E2E evidence",
      e2eWorkspaceRevisionToken: "c".repeat(64),
      e2eGitState: { kind: "not_repository" as const },
      copiedEvidence: [],
      command: "npm run test:e2e",
      commandHash: "4".repeat(64),
    };
  }
}

class E2eWorkflowStore {
  executionCreates = 0;
  reviewCalls = 0;
  readonly completed: Array<{ executionId: string; exitCode: number }> = [];
  private readonly artifactExecutionHeads = new Map<string, string | null>();

  constructor(
    readonly bundle: RunBundle,
    private readonly selected: SelectionArtifact[],
  ) {}

  async getRun(): Promise<RunBundle> {
    return this.bundle;
  }

  async selectionArtifacts(_runId: string, ids: string[]): Promise<SelectionArtifact[]> {
    const byId = new Map(this.selected.map((artifact) => [artifact.id, artifact]));
    return ids.map((id) => {
      const artifact = byId.get(id);
      assert.ok(artifact);
      return artifact;
    });
  }

  async currentArtifactSnapshotsForPhase(
    _runId: string,
    phaseId: PhaseId,
  ): Promise<CurrentArtifactSnapshot[]> {
    return this.current(phaseId);
  }

  current(phaseId: PhaseId): CurrentArtifactSnapshot[] {
    return requiredPhase(this.bundle, phaseId).artifacts.map((artifact) => {
      const selected = this.selected.find(({ id }) => id === artifact.id);
      return {
        ...artifact,
        content: selected?.content ?? "",
        executionId: this.artifactExecutionHeads.get(artifact.artifactKey) ?? null,
      };
    });
  }

  async createExecution(
    _runId: string,
    phaseId: PhaseId,
    selectedArtifactIds: string[],
    selectedOutputKeys: string[],
    _runnerMode: string,
    _model: string | null,
    _reasoningEffort: string | null,
    command: string,
  ): Promise<ExecutionDto> {
    this.executionCreates += 1;
    const phase = requiredPhase(this.bundle, phaseId);
    const now = new Date().toISOString();
    const execution: ExecutionDto = {
      id: randomUUID(),
      phaseRunId: phase.id,
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
    phase.executions.unshift(execution);
    phase.status = "running";
    return execution;
  }

  async appendEvent(
    executionId: string,
    sequence: number,
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    const phase = requiredPhase(this.bundle, "verification");
    const event: ExecutionEventDto = {
      id: randomUUID(),
      executionId,
      sequence,
      eventType,
      payload,
      createdAt: new Date().toISOString(),
    };
    phase.events.push(event);
  }

  async completeExecution(
    executionId: string,
    exitCode: number,
    artifacts: ArtifactRecordInput[],
  ): Promise<void> {
    const phase = requiredPhase(this.bundle, "verification");
    const execution = phase.executions.find(({ id }) => id === executionId);
    assert.ok(execution);
    execution.status = "completed";
    execution.exitCode = exitCode;
    execution.finishedAt = new Date().toISOString();
    phase.status = "awaiting_review";
    for (const artifact of artifacts) {
      phase.artifacts = phase.artifacts.filter(({ artifactKey }) => artifact.artifactKey !== artifactKey);
      phase.artifacts.push({
        id: randomUUID(),
        phaseRunId: phase.id,
        artifactKey: artifact.artifactKey,
        filePath: artifact.filePath,
        contentHash: artifact.contentHash,
        reviewStatus: "pending",
        revision: 1,
        revisionSource: "ai",
        parentArtifactId: null,
        createdAt: new Date().toISOString(),
      });
      this.artifactExecutionHeads.set(artifact.artifactKey, executionId);
      const prior = this.selected.find(({ artifactKey: key }) => key === artifact.artifactKey);
      if (prior) prior.content = artifact.content;
      else this.selected.push({
        ...phase.artifacts.at(-1)!,
        sourcePosition: phase.position,
        sourceStatus: phase.status,
        workflowRunId: this.bundle.run.id,
        content: artifact.content,
      });
    }
    this.completed.push({ executionId, exitCode });
  }

  setArtifactExecutionHead(artifactKey: string, executionId: string | null): void {
    this.artifactExecutionHeads.set(artifactKey, executionId);
  }

  async failExecution(executionId: string, exitCode: number | null, error: string): Promise<void> {
    const phase = requiredPhase(this.bundle, "verification");
    const execution = phase.executions.find(({ id }) => id === executionId);
    assert.ok(execution);
    execution.status = "failed";
    execution.exitCode = exitCode;
    execution.error = error;
    phase.status = "failed";
  }
}

async function workflowFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-linked-e2e-flow-"));
  const requestedProductRoot = path.join(parent, "product");
  const requestedE2eRoot = path.join(parent, "product-e2e");
  await initializeCodexProject(requestedProductRoot, "Linked E2E", "Focused service check");
  await mkdir(requestedE2eRoot);
  const [productRoot, e2eRoot] = await Promise.all([
    realpath(requestedProductRoot),
    realpath(requestedE2eRoot),
  ]);
  const now = "2026-08-24T00:00:00.000Z";
  const project: ProjectDto = {
    id: randomUUID(),
    name: "Linked E2E",
    summary: "Focused service check",
    rootPath: productRoot,
    configPath: path.join(productRoot, "ai-native.yaml"),
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const run: WorkflowRunDto = {
    id: randomUUID(),
    projectId: project.id,
    title: "Checkout",
    objective: "Verify checkout in a real browser",
    status: "active",
    changeContract: {
      workType: "feature",
      summary: "Checkout",
      currentBehavior: "No durable browser proof exists.",
      expectedBehavior: "Checkout completes in Chromium.",
      inScope: ["Checkout browser flow"],
      outOfScope: [],
      acceptanceCriteria: ["CC-AC-001: Checkout completes after valid payment."],
      regressionScope: ["REG-001: Invalid payment remains rejected."],
      riskFlags: [],
      evidenceRefs: [],
    },
    createdAt: now,
    updatedAt: now,
  };
  const phases = PHASE_IDS.map((phaseId, position): PhaseRunDto => ({
    id: randomUUID(),
    workflowRunId: run.id,
    phaseId,
    position,
    status: phaseId === "verification" ? "ready" : phaseId === "release" ? "pending" : "approved",
    artifacts: [],
    reviews: [],
    executions: [],
    events: [],
    availableArtifacts: [],
    resolution: null,
    architectureImpact: null,
    createdAt: now,
    updatedAt: now,
  }));
  const artifactPhases: Record<string, PhaseId> = {
    "change-contract": "discovery",
    prd: "discovery",
    "user-stories": "discovery",
    "design-spec": "design",
    architecture: "architecture",
    "architecture-nfrs": "architecture",
    "implementation-notes": "implementation",
    "engineering-test-evidence": "implementation",
    "engineering-review": "implementation",
  };
  const selected: SelectionArtifact[] = [];
  for (const [artifactKey, phaseId] of Object.entries(artifactPhases)) {
    const phase = requiredPhase({ project, run, phases, artifactPaths: {} }, phaseId);
    const content = artifactKey === "user-stories"
      ? "# US-001 Checkout\n\n### US-001-AC-01: Checkout completes after valid payment.\n"
      : `# ${artifactKey}\n\nApproved observable specification.\n`;
    const filePath = path.posix.join("docs", "fixture", `${artifactKey}.md`);
    await mkdir(path.dirname(path.join(productRoot, filePath)), { recursive: true });
    await writeFile(path.join(productRoot, filePath), content, "utf8");
    const artifact: SelectionArtifact = {
      id: randomUUID(),
      phaseRunId: phase.id,
      artifactKey,
      filePath,
      content,
      contentHash: digest(content),
      reviewStatus: "approved",
      revision: 1,
      revisionSource: "ai",
      parentArtifactId: null,
      createdAt: now,
      sourcePosition: phase.position,
      sourceStatus: "approved",
      workflowRunId: run.id,
    };
    selected.push(artifact);
    phase.artifacts.push(artifact);
  }
  const bundle: RunBundle = { project, run, phases, artifactPaths: {} };
  const workspace: E2eWorkspaceDto = {
    version: 1,
    productProjectId: project.id,
    rootPath: e2eRoot,
    descriptorPath: ".ai-sdlc/e2e-workspace.json",
    baseUrl: "http://127.0.0.1:4173",
    packageManager: "npm",
    sourceStartScript: "dev",
    testScript: "test:e2e",
    browser: "chromium",
    playwrightVersion: "1.62.1",
    descriptorHash: "f".repeat(64),
    updatedAt: now,
  };
  const coordinator = new FakeVerificationE2eCoordinator(workspace);
  const store = new E2eWorkflowStore(bundle, selected);
  const runner = new CapturingVerificationRunner();
  const service = new WorkflowService(
    store as unknown as PgWorkflowStore,
    new ProjectPathPolicy([parent]),
    runner,
    undefined,
    undefined,
    undefined,
    coordinator as unknown as VerificationE2eCoordinator,
  );
  return {
    parent,
    e2eRoot,
    run,
    selected,
    coordinator,
    store,
    runner,
    service,
    async dispose() {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

function readyWorkspace(): E2eWorkspaceReadinessDto {
  const ready = { state: "ready" as const, message: "READY" };
  return {
    ready: true,
    workspace: ready,
    playwright: ready,
    browser: ready,
    sourceStartScript: ready,
    target: { state: "not_checked", message: "PROBED_DURING_EXECUTION" },
    checkedAt: new Date().toISOString(),
  };
}

function requiredPhase(bundle: RunBundle, phaseId: PhaseId): PhaseRunDto {
  const phase = bundle.phases.find((candidate) => candidate.phaseId === phaseId);
  assert.ok(phase);
  return phase;
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
