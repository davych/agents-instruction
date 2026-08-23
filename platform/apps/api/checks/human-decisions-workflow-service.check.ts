import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ArtifactDto,
  HumanDecisionPhaseId,
  PhaseRunDto,
  ProjectDto,
  ReviewDto,
} from "@ai-sdlc/contracts";

import type { PgWorkflowStore } from "../src/db/store.ts";
import { parseHumanDecisionCapture } from "../src/domain/human-decisions.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

const now = "2026-08-20T08:00:00.000Z";

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
    assert.equal(productGate?.items[0]?.id, "PROD-Q-01");

    const result = await fixture.service.captureHumanDecisions(fixture.runId, "discovery", {
      responses: [{ id: "PROD-Q-01", response: "Use the current catalog and preserve its order." }],
      expectedArtifactIds: [fixture.artifacts.discovery.id],
    });

    assert.equal(result.run.id, fixture.runId);
    assert.equal(fixture.reviewCalls.length, 1);
    assert.equal(fixture.reviewCalls[0]?.[2], "request_changes");
    assert.deepEqual(fixture.reviewCalls[0]?.[7], ["ready", "awaiting_review", "approved", "changes_requested"]);
    assert.deepEqual(parseHumanDecisionCapture(String(fixture.reviewCalls[0]?.[3])), {
      phaseId: "discovery",
      responses: [{ id: "PROD-Q-01", response: "Use the current catalog and preserve its order." }],
    });
    assert.equal(fixture.phases.discovery.status, "changes_requested");

    const after = await fixture.service.getHumanDecisions(fixture.runId);
    assert.equal(after.phases.find(({ phaseId }) => phaseId === "discovery")?.items[0]?.response,
      "Use the current catalog and preserve its order.");
    assert.equal(after.phases.find(({ phaseId }) => phaseId === "discovery")?.blockingCount, 1,
      "the formal PRD must still be updated before approval");

    fixture.phases.discovery.status = "ready";
    await fixture.service.captureHumanDecisions(fixture.runId, "discovery", {
      responses: [{ id: "PROD-Q-01", response: "Use the current catalog and preserve its order." }],
      expectedArtifactIds: [fixture.artifacts.discovery.id],
    });
    assert.equal(fixture.reviewCalls.length, 2, "a ready stale phase can capture a true human decision before rerun");
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
  const phases = Object.fromEntries(
    (["discovery", "design", "architecture"] as HumanDecisionPhaseId[]).map((phaseId, position) => {
      const phase: PhaseRunDto = {
        id: randomUUID(),
        workflowRunId: run.id,
        phaseId,
        position,
        status: "pending",
        artifacts: [artifacts[phaseId]],
        reviews: [],
        executions: [],
        events: [],
        availableArtifacts: [],
        createdAt: now,
        updatedAt: now,
      };
      artifacts[phaseId].phaseRunId = phase.id;
      return [phaseId, phase];
    }),
  ) as Record<HumanDecisionPhaseId, PhaseRunDto>;
  const reviewCalls: unknown[][] = [];
  const bundle = { project, run, phases: Object.values(phases), artifactPaths: {} };
  const fakeStore = {
    getRun: async () => bundle,
    currentArtifactSnapshotsForPhase: async (_runId: string, phaseId: HumanDecisionPhaseId) => [{
      artifactKey: artifacts[phaseId].artifactKey,
      content: artifacts[phaseId].content ?? "",
    }],
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
    phases,
    reviewCalls,
    setOnlyPhaseAwaitingReview(phaseId: HumanDecisionPhaseId, status: PhaseRunDto["status"] = "awaiting_review") {
      for (const phase of Object.values(phases)) phase.status = "pending";
      phases[phaseId].status = status;
    },
  };
}
