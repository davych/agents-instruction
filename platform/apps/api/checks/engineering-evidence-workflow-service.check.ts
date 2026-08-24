import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ArtifactDto, ChangeContractDto, ProjectDto } from "@ai-sdlc/contracts";

import type { PgWorkflowStore } from "../src/db/store.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import {
  engineeringEvidenceArtifactKeys,
  engineeringReviewHeadings,
} from "../src/services/engineering-evidence-validator.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

test("AC-ENG-007: implementation approval runs the semantic evidence gate before persistence", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-engineering-gate-"));
  try {
    const requestedRoot = path.join(parent, "sample");
    await initializeCodexProject(requestedRoot, "Evidence gate", "Workflow integration test");
    const root = await realpath(requestedRoot);
    const now = "2026-08-19T09:00:00.000Z";
    const project: ProjectDto = {
      id: randomUUID(),
      name: "Evidence gate",
      summary: "Workflow integration test",
      rootPath: root,
      configPath: path.join(root, "ai-native.yaml"),
      runCount: 1,
      createdAt: now,
      updatedAt: now,
    };
    const changeContract: ChangeContractDto = {
      workType: "change",
      summary: "Add auditable engineering evidence",
      currentBehavior: "Implementation evidence is incomplete.",
      expectedBehavior: "The seven-artifact evidence gate is enforced.",
      inScope: ["Implementation evidence and approval"],
      outOfScope: ["Architecture, merge, and release decisions"],
      acceptanceCriteria: ["AC-ENG-001", "AC-ENG-002"],
      regressionScope: ["Existing six-phase workflow"],
      riskFlags: ["legacy project compatibility"],
      evidenceRefs: ["changes/software-engineer-evidence-pack/delta.md"],
    };
    const run = {
      id: randomUUID(),
      projectId: project.id,
      title: "Engineering gate",
      objective: "Reject incomplete evidence before human approval",
      status: "active" as const,
      changeContract,
      createdAt: now,
      updatedAt: now,
    };
    const phaseRunId = randomUUID();
    let artifacts = serviceArtifacts(phaseRunId, now);
    artifacts = artifacts.map((artifact) => artifact.artifactKey === "engineering-provenance"
      ? { ...artifact, content: artifact.content?.replace("2".repeat(40), "TBD") }
      : artifact);
    const phase = {
      id: phaseRunId,
      workflowRunId: run.id,
      phaseId: "implementation" as const,
      position: 3,
      status: "awaiting_review" as const,
      artifacts,
      reviews: [],
      executions: [],
      events: [],
      availableArtifacts: [],
      createdAt: now,
      updatedAt: now,
    };
    const reviewCalls: unknown[][] = [];
    const fakeStore = {
      getRun: async () => ({ project, run, phases: [phase], artifactPaths: {} }),
      currentArtifactSnapshotsForPhase: async () => phase.artifacts.map((artifact) => ({
        ...artifact,
        content: artifact.content ?? "",
      })),
      reviewPhase: async (...args: unknown[]) => {
        reviewCalls.push(args);
        return {
          id: randomUUID(),
          phaseRunId: phase.id,
          decision: args[2],
          comment: args[3],
          artifactIds: args[4],
          createdAt: now,
        };
      },
    };
    const service = new WorkflowService(
      fakeStore as unknown as PgWorkflowStore,
      new ProjectPathPolicy([parent]),
      new CodexTerminalRunner({ fake: true }),
    );
    const expectedArtifactIds = phase.artifacts.map((artifact) => artifact.id);

    await assert.rejects(
      () => service.reviewPhase(run.id, "implementation", {
        decision: "approve",
        comment: "The evidence pack should not approve with placeholder provenance.",
        expectedArtifactIds,
      }),
      (error: unknown) => {
        const appError = error as { statusCode?: number; code?: string; details?: { issues?: unknown } };
        assert.equal(appError.statusCode, 409);
        assert.equal(appError.code, "ENGINEERING_EVIDENCE_GATE_FAILED");
        assert.ok(Array.isArray(appError.details?.issues));
        return true;
      },
    );
    assert.equal(reviewCalls.length, 0, "invalid evidence must not persist an approval review");

    phase.artifacts = serviceArtifacts(phaseRunId, now);
    await service.reviewPhase(run.id, "implementation", {
      decision: "approve",
      comment: "The complete Tier A evidence pack is ready for human approval.",
      expectedArtifactIds: phase.artifacts.map((artifact) => artifact.id),
    });
    assert.equal(reviewCalls.length, 1);
    assert.deepEqual(reviewCalls[0]?.[5], [...engineeringEvidenceArtifactKeys]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("AC-CLARITY-006: legacy implementation approval uses its approved selected User Story ACs", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-legacy-engineering-ac-"));
  try {
    const requestedRoot = path.join(parent, "sample");
    await initializeCodexProject(requestedRoot, "Legacy AC", "Legacy User Story acceptance criteria");
    const root = await realpath(requestedRoot);
    const now = "2026-08-20T09:00:00.000Z";
    const project: ProjectDto = {
      id: randomUUID(),
      name: "Legacy AC",
      summary: "Legacy User Story acceptance criteria",
      rootPath: root,
      configPath: path.join(root, "ai-native.yaml"),
      runCount: 1,
      createdAt: now,
      updatedAt: now,
    };
    const run = {
      id: randomUUID(),
      projectId: project.id,
      title: "Legacy engineering approval",
      objective: "Approve against selected User Story ACs",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    const phaseRunId = randomUUID();
    const storyArtifactId = randomUUID();
    const artifacts = serviceArtifacts(phaseRunId, now).map((artifact) => ({
      ...artifact,
      content: artifact.content
        ?.replaceAll("CC-AC-001", "US-001-AC-01")
        .replaceAll("CC-AC-002", "US-001-AC-02"),
    }));
    const phase = {
      id: phaseRunId,
      workflowRunId: run.id,
      phaseId: "implementation" as const,
      position: 3,
      status: "awaiting_review" as const,
      artifacts,
      reviews: [],
      executions: [{
        id: randomUUID(),
        phaseRunId,
        status: "completed" as const,
        selectedArtifactIds: [storyArtifactId],
        selectedOutputKeys: [...engineeringEvidenceArtifactKeys],
        runnerMode: "fake" as const,
        model: null,
        reasoningEffort: null,
        command: "codex exec",
        exitCode: 0,
        error: null,
        startedAt: now,
        finishedAt: now,
        createdAt: now,
      }],
      events: [],
      availableArtifacts: [],
      createdAt: now,
      updatedAt: now,
    };
    const reviewCalls: unknown[][] = [];
    const fakeStore = {
      getRun: async () => ({ project, run, phases: [phase], artifactPaths: {} }),
      selectionArtifacts: async () => [{
        id: storyArtifactId,
        phaseRunId: randomUUID(),
        artifactKey: "user-stories",
        filePath: "docs/ai-native/product/user-stories",
        format: "directory" as const,
        revision: 1,
        contentHash: "1".repeat(64),
        revisionSource: "agent" as const,
        sourceArtifactId: null,
        reviewStatus: "approved" as const,
        superseded: false,
        createdAt: now,
        sourcePosition: 0,
        sourceStatus: "approved" as const,
        workflowRunId: run.id,
        content: `## pinyin/US-001-level/story.md

# US-001: Choose a level

## Acceptance criteria

### US-001-AC-01: The learner can choose a level

### US-001-AC-02: The chosen level opens
`,
      }],
      currentArtifactSnapshotsForPhase: async () => phase.artifacts.map((artifact) => ({
        ...artifact,
        content: artifact.content ?? "",
      })),
      reviewPhase: async (...args: unknown[]) => {
        reviewCalls.push(args);
        return {
          id: randomUUID(),
          phaseRunId: phase.id,
          decision: args[2],
          comment: args[3],
          artifactIds: args[4],
          createdAt: now,
        };
      },
    };
    const service = new WorkflowService(
      fakeStore as unknown as PgWorkflowStore,
      new ProjectPathPolicy([parent]),
      new CodexTerminalRunner({ fake: true }),
    );

    await service.reviewPhase(run.id, "implementation", {
      decision: "approve",
      comment: "The selected User Story criteria are fully covered and ready for approval.",
      expectedArtifactIds: artifacts.map((artifact) => artifact.id),
    });
    assert.equal(reviewCalls.length, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function serviceArtifacts(phaseRunId: string, createdAt: string): ArtifactDto[] {
  const review = [
    "# Seven-lens engineering review",
    ...engineeringReviewHeadings.flatMap((heading) => [
      `## ${heading}`,
      "Finding: none found",
    ]),
    "## Adversarial pass",
    "### Pre-mortem",
    "Finding: none found",
    "### Edge-case-hunter",
    "Finding: none found",
    "## Security-sensitive decisions",
    "No security-sensitive decision was made; risk acceptance remains human-owned.",
  ].join("\n\n");
  const contentByKey: Readonly<Record<(typeof engineeringEvidenceArtifactKeys)[number], string>> = {
    "implementation-notes": [
      "# Implementation index",
      "## Status",
      "Ready for verification",
      "## Evidence index",
      ...engineeringEvidenceArtifactKeys.slice(1).map((key) => `- ${key}: ${key}.md`),
      "## Contract and active clearances",
      "CC-AC-001 and CC-AC-002; Product, Design, and Architecture are cleared.",
      "## Implemented scope",
      "Implemented the registered evidence gate in confirmed scope.",
      "## Changes",
      "Added the validation boundary and seven registered outputs.",
      "## Impact-check deviations",
      "No deviation from the approved Product, Design, or Architecture route.",
      "## Verification, regression, and risks",
      "Independent checks passed; the six-phase workflow remains the regression boundary.",
      "## Handoff",
      "Tester receives the index, independent-test evidence, and engineering review.",
    ].join("\n\n"),
    "implementation-plan": [
      "# Implementation plan",
      "## Change classification",
      "Brownfield change to an existing workflow.",
      "## Preserved behaviour",
      "Keep the fixed phases and human approval boundary.",
      "## ADDED",
      "Add seven evidence outputs.",
      "## MODIFIED",
      "Extend implementation validation.",
      "## REMOVED",
      "None",
      "## REMOVED audit",
      "Compared every role, phase, artifact, and gate; no existing behavior is deleted.",
      "## Risk note",
      "Legacy projects need compatible paths.",
      "## Acceptance coverage plan",
      "CC-AC-001 and CC-AC-002 are covered.",
    ].join("\n\n"),
    "implementation-tasks": [
      "# Implementation tasks",
      "## Task ledger",
      "- [x] ENG-TASK-001 — role policy and clearances.",
      "- [x] ENG-TASK-002 — complete scaffold.",
      "## Acceptance coverage",
      "- CC-AC-001 — ENG-TASK-001 and independent role-pack check.",
      "- CC-AC-002 — ENG-TASK-002 and independent scaffold check.",
    ].join("\n"),
    "engineering-session-log": [
      "# Engineering session log",
      "## Task contract",
      "Implement CC-AC-001 and CC-AC-002 without changing phase ownership.",
      "## Context loaded",
      "Approved delta and repository testing conventions.",
      "## Ordered action log",
      "2026-08-19T09:00:00Z — implemented the evidence gate.",
      "## Change inventory",
      "Seven evidence outputs, validator, and checks.",
      "## Rejected alternatives",
      "Rejected a duplicate client-specific Skill.",
      "## Verification gates",
      "Command: npm test",
      "Result: passed with exit code 0.",
      "## Outcome",
      "Ready for independent verification.",
    ].join("\n\n"),
    "engineering-test-evidence": [
      "# Engineering Test Evidence: Workflow approval integration",
      "## Status",
      "**State:** Pass",
      `**Run:** ${phaseRunId}`,
      `**Implementation revision:** ${"2".repeat(40)}`,
      "**Updated:** 2026-08-19",
      "## Isolation",
      "| Field | Evidence |",
      "|---|---|",
      "| Tier | A |",
      "| Test-authoring model/session | Independent human test author Mei Chen; session QA-workflow-2026-08-19-001 |",
      "| Requirements visible while authoring | changes/software-engineer-evidence-pack/delta.md#acceptance-criteria |",
      "| Implementation visible while authoring | No |",
      "| Test intent frozen at | reviews/workflow-service-frozen-intent-2026-08-19.md#revision-1 |",
      "| Later implementation access | None |",
      "| Human waiver | None |",
      "## Acceptance coverage",
      "| Trace ID | Source ID / position | Observable criterion or regression | Test path and test ID/name | Evidence | Result |",
      "|---|---|---|---|---|---|",
      "| CC-AC-001 | Change Contract criterion 1 | Semantic evidence validation runs before approval persistence. | platform/apps/api/checks/engineering-evidence-workflow-service.check.ts :: implementation approval runs the semantic evidence gate before persistence | artifacts/test-results/engineering-evidence-workflow-service.tap | Pass |",
      "| CC-AC-002 | Change Contract criterion 2 | A complete seven-artifact pack persists one approval review. | platform/apps/api/checks/engineering-evidence-workflow-service.check.ts :: implementation approval runs the semantic evidence gate before persistence | artifacts/test-results/engineering-evidence-workflow-service.tap | Pass |",
      "## Test changes",
      "| Test path | Added / Modified / Removed | Trace IDs | Independent intent | Reason |",
      "|---|---|---|---|---|",
      "| platform/apps/api/checks/engineering-evidence-workflow-service.check.ts | Modified | CC-AC-001, CC-AC-002 | exercise validation before persistence | preserve the workflow approval integration contract |",
      "## Commands and results",
      "| Sequence | Working directory | Exact command | Check type | Exit/result | Evidence / notes |",
      "|---|---|---|---|---|---|",
      "| 1 | platform | `yarn exec node --import tsx --test apps/api/checks/engineering-evidence-workflow-service.check.ts` | focused integration | exit code 0; Pass | artifacts/test-results/engineering-evidence-workflow-service.tap |",
      "| Check | Reason not run | Owner | Release / verification impact | Status |",
      "|---|---|---|---|---|",
      "| None | N/A | N/A | N/A | not-applicable |",
      "## Failure classification",
      "| Failure ID | Failing test/check | Classification | Contract evidence | Action and owner | Retest evidence |",
      "|---|---|---|---|---|---|",
      "| None | N/A | N/A | N/A | N/A | N/A |",
      "## Coverage gaps",
      "- None",
      "## Conclusion",
      "- **Isolation gate:** Pass; Tier A metadata is complete.",
      "- **Acceptance gate:** Pass; CC-AC-001 and CC-AC-002 have passing automated evidence.",
      "- **Regression gate:** Pass; the focused workflow integration check passed.",
      "- **Project-check gate:** Pass; the required focused check exited 0.",
      "- **Ready for review:** Yes",
    ].join("\n\n"),
    "engineering-review": review,
    "engineering-provenance": [
      "# PR provenance",
      "## Tool/model",
      "Codex gpt-5.6-sol with high reasoning.",
      "## Context loaded",
      "Approved delta, AGENTS.md, and testing conventions.",
      "## Verification gates",
      "npm test; yarn typecheck; yarn test; yarn build exited 0.",
      "## Human decisions",
      "Human review remains required; no architecture, scope, security, merge, or release decision was made.",
      "## Known limitations",
      "No known verification limitation remains.",
      "## Session duration",
      "42 minutes.",
      "## SDD approach",
      "Delta-driven smallest complete vertical slice with frozen independent tests.",
      "## Evidence links",
      "Spec: changes/software-engineer-evidence-pack/delta.md",
      "Session log: engineering-session-log.md",
      "Tests: engineering-test-evidence.md",
      "Review: engineering-review.md",
      "Repository: create-ai-native-sdlc",
      "Branch: codex/software-engineer-evidence-pack",
      `Base commit: ${"1".repeat(40)}`,
      `Head commit: ${"2".repeat(40)}`,
      "Pull request: https://github.example/create-ai-native-sdlc/pull/42",
      "## Publication boundary",
      "PR created or opened by Software Engineer: No",
      "PR published by Software Engineer: No",
      "Merge decision: Human-owned; not performed.",
      "Release decision: Human-owned; not performed.",
    ].join("\n"),
  };

  return engineeringEvidenceArtifactKeys.map((artifactKey) => {
    const content = contentByKey[artifactKey];
    return {
      id: randomUUID(),
      phaseRunId,
      artifactKey,
      filePath: `docs/ai-native/engineering/${artifactKey}.md`,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      reviewStatus: "pending",
      revision: 1,
      revisionSource: "ai",
      parentArtifactId: null,
      createdAt,
    };
  });
}
