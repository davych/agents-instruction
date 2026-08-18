import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultRoutedPartialOutputKeys,
  effectiveRequiredInputKeys,
  impactChoiceRequiresBaseline,
  impactOptionsForPhase,
  isResolutionOutputMutable,
  isImpactAssessmentComplete,
  isFirstPhaseImpactAttempt,
  isProductDirectAllowed,
  shouldSubmitRoutedImpactAssessment,
} from "../src/lib/phase-impact.ts";
import type { PhaseRun } from "../src/lib/types.ts";

const baseline = {
  phaseId: "discovery" as const,
  sourceRunId: "run",
  sourceRunTitle: "Baseline",
  sourcePhaseRunId: "phase",
  approvedAt: "2026-08-18T00:00:00.000Z",
  artifacts: [{ id: "artifact", artifactKey: "prd", contentHash: "hash" }],
};

test("product and design impact expose their four auditable choices", () => {
  assert.deepEqual(
    impactOptionsForPhase("discovery").map((option) => option.value),
    ["direct", "reuse", "partial", "full"],
  );
  assert.deepEqual(
    impactOptionsForPhase("design").map((option) => option.value),
    ["skip", "reuse", "partial", "full"],
  );
});

test("Design Partial defaults only to design-spec while Product keeps its delta documents", () => {
  assert.deepEqual(defaultRoutedPartialOutputKeys("design", [
    "design-baseline",
    "design-spec",
    "design-prototype",
    "figma-handoff",
  ]), ["design-spec"]);
  assert.deepEqual(defaultRoutedPartialOutputKeys("discovery", [
    "change-contract",
    "prd",
    "user-stories",
  ]), ["prd", "user-stories"]);
});

test("Full routes straight to Codex while non-Full choices submit an impact decision", () => {
  assert.equal(shouldSubmitRoutedImpactAssessment("full"), false);
  assert.equal(shouldSubmitRoutedImpactAssessment("direct"), true);
  assert.equal(shouldSubmitRoutedImpactAssessment("skip"), true);
  assert.equal(shouldSubmitRoutedImpactAssessment("partial"), true);
  assert.equal(shouldSubmitRoutedImpactAssessment(""), false);
});

test("Product Direct is limited to Change-Contract-backed bug and technical work", () => {
  assert.equal(isProductDirectAllowed(true, "bug", true), true);
  assert.equal(isProductDirectAllowed(true, "technical", true), true);
  assert.equal(isProductDirectAllowed(true, "feature", true), false);
  assert.equal(isProductDirectAllowed(true, "change", true), false);
  assert.equal(isProductDirectAllowed(false, "bug", true), false);
  assert.equal(isProductDirectAllowed(true, "bug", false), false);
});

test("Impact is available only before business artifacts, executions, or reviews exist", () => {
  const empty = { artifacts: [], executions: [], reviews: [] };
  assert.equal(isFirstPhaseImpactAttempt(empty), true);
  assert.equal(isFirstPhaseImpactAttempt({
    ...empty,
    artifacts: [{ id: "contract", artifactKey: "change-contract" }],
  }), true);
  assert.equal(isFirstPhaseImpactAttempt({
    ...empty,
    artifacts: [{ id: "prd", artifactKey: "prd" }],
  }), false);
  assert.equal(isFirstPhaseImpactAttempt({
    ...empty,
    executions: [{ id: "execution", status: "completed" }],
  }), false);
  assert.equal(isFirstPhaseImpactAttempt({
    ...empty,
    reviews: [{ id: "review", decision: "approve" }],
  }), false);
});

test("reuse is immutable and partial exposes only its assessed outputs", () => {
  const common = {
    phaseId: "design" as const,
    rationale: "复用已批准设计基线，不需要生成新设计产物",
    inputArtifactIds: ["input"],
    sourceRunId: "run",
    sourceRunTitle: "Baseline",
    sourcePhaseRunId: "phase",
    sourceArtifactIds: ["artifact"],
    routeVersion: 1 as const,
    decidedAt: "2026-08-18T00:00:00.000Z",
  };
  assert.equal(isResolutionOutputMutable({
    ...common,
    mode: "reuse",
    affectedOutputKeys: [],
  }, "design-spec"), false);
  assert.equal(isResolutionOutputMutable({
    ...common,
    mode: "partial",
    affectedOutputKeys: ["design-spec"],
  }, "design-spec"), true);
  assert.equal(isResolutionOutputMutable({
    ...common,
    mode: "partial",
    affectedOutputKeys: ["design-spec"],
  }, "design-baseline"), false);
});

test("only reuse and partial require an approved baseline", () => {
  assert.equal(impactChoiceRequiresBaseline("discovery", "direct"), false);
  assert.equal(impactChoiceRequiresBaseline("discovery", "reuse"), true);
  assert.equal(impactChoiceRequiresBaseline("design", "partial"), true);
  assert.equal(impactChoiceRequiresBaseline("design", "skip"), false);
});

test("impact assessment requires rationale, design inputs and partial output scope", () => {
  assert.equal(isImpactAssessmentComplete({
    phaseId: "discovery",
    choice: "direct",
    rationale: "合同已经包含可测试的预期行为",
    affectedOutputKeys: [],
    hasAllRequiredInputs: true,
  }), true);
  assert.equal(isImpactAssessmentComplete({
    phaseId: "design",
    choice: "partial",
    rationale: "仅更新受本次变更影响的设计规格",
    baseline: { ...baseline, phaseId: "design" },
    affectedOutputKeys: ["design-prototype"],
    hasAllRequiredInputs: true,
  }), false);
  assert.equal(isImpactAssessmentComplete({
    phaseId: "design",
    choice: "partial",
    rationale: "仅更新受本次变更影响的设计规格",
    baseline: { ...baseline, phaseId: "design" },
    affectedOutputKeys: ["design-spec"],
    hasAllRequiredInputs: true,
  }), true);
  assert.equal(isImpactAssessmentComplete({
    phaseId: "design",
    choice: "skip",
    rationale: "这是后端缺陷且没有任何界面变化",
    affectedOutputKeys: [],
    hasAllRequiredInputs: false,
  }), false);
  assert.equal(isImpactAssessmentComplete({
    phaseId: "discovery",
    choice: "partial",
    rationale: "只需要补充一个已有故事的验收标准",
    baseline,
    affectedOutputKeys: [],
    hasAllRequiredInputs: true,
  }), false);
  assert.equal(isImpactAssessmentComplete({
    phaseId: "discovery",
    choice: "partial",
    rationale: "只需要补充一个已有故事的验收标准",
    baseline,
    affectedOutputKeys: ["user-stories"],
    hasAllRequiredInputs: true,
  }), true);
});

test("route-aware required inputs preserve the Change Contract while waiving skipped outputs", () => {
  const resolution = (
    phaseId: "discovery" | "design" | "architecture",
    mode: "direct" | "skip",
  ): NonNullable<PhaseRun["resolution"]> => ({
    phaseId,
    mode,
    rationale: "该阶段输出对本次任务无影响，使用任务合同继续",
    inputArtifactIds: ["change-contract"],
    sourceRunId: null,
    sourceRunTitle: null,
    sourcePhaseRunId: null,
    sourceArtifactIds: [],
    affectedOutputKeys: [],
    routeVersion: 1,
    decidedAt: "2026-08-18T00:00:00.000Z",
  });
  const phases: Array<Pick<PhaseRun, "phaseId" | "resolution">> = [
    { phaseId: "discovery", resolution: resolution("discovery", "direct") },
    { phaseId: "design", resolution: resolution("design", "skip") },
    { phaseId: "architecture", resolution: resolution("architecture", "skip") },
  ];

  assert.deepEqual(
    effectiveRequiredInputKeys([
      "change-contract",
      "prd",
      "user-stories",
      "design-baseline",
      "design-spec",
      "architecture",
      "architecture-adrs",
      "implementation-notes",
    ], phases),
    ["change-contract", "implementation-notes"],
  );
  assert.deepEqual(
    effectiveRequiredInputKeys(
      ["change-contract", "prd", "implementation-notes"],
      [],
      { hasChangeContract: false },
    ),
    ["prd", "implementation-notes"],
  );
  assert.deepEqual(
    effectiveRequiredInputKeys(
      ["change-contract", "product-delta", "design-tokens", "system-map", "implementation-notes"],
      phases,
      {
        outputKeysByPhase: {
          discovery: ["change-contract", "product-delta"],
          design: ["design-tokens"],
          architecture: ["system-map"],
        },
      },
    ),
    ["change-contract", "implementation-notes"],
  );
});
