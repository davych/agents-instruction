import assert from "node:assert/strict";
import test from "node:test";

import {
  architectureOptionSummaries,
  architecturePartialAllowedOutputKeys,
  architecturePartialOutputKeys,
  architectureOutputKeysRequiringRefresh,
  architectureSelectionFromReviews,
  defaultFigmaFileName,
  initialPhaseOutputKeys,
  isPhaseOutputLocked,
  isPhaseOutputSelectionComplete,
  isArchitectureImpactOutputMutable,
  isArchitectureImpactRationaleValid,
  isArchitecturePartialOutputSelectionComplete,
  isArchitectureReselectionBlockedByImpact,
  parseArchitectureSelectionId,
  REQUIRED_ARCHITECTURE_POST_SELECTION_OUTPUT_KEYS,
  requiredPhaseApprovalOutputKeys,
} from "../src/lib/phase-output-selection.ts";
import { FALLBACK_PHASES } from "../src/lib/workflow.ts";

const architectureOutputs = [
  "architecture",
  "architecture-discovery-context",
  "architecture-options",
  "architecture-c4-context",
  "architecture-c4-containers",
  "architecture-adrs",
  "architecture-patterns",
  "architecture-nfrs",
  "architecture-adversarial",
];

const architectureBootstrapOutputs = [
  "architecture",
  "architecture-discovery-context",
  "architecture-options",
];

const engineeringEvidenceOutputs = [
  "implementation-notes",
  "implementation-plan",
  "implementation-tasks",
  "engineering-session-log",
  "engineering-test-evidence",
  "engineering-review",
  "engineering-provenance",
];

test("a first execution keeps the existing required output defaults", () => {
  assert.deepEqual(
    initialPhaseOutputKeys({
      phaseId: "design",
      availableOutputKeys: [
        "design-baseline",
        "design-spec",
        "design-prototype",
        "figma-handoff",
      ],
      hasExistingArtifacts: false,
    }),
    ["design-baseline", "design-spec"],
  );
  assert.deepEqual(
    initialPhaseOutputKeys({
      phaseId: "discovery",
      availableOutputKeys: ["prd", "user-stories"],
      hasExistingArtifacts: false,
    }),
    ["prd", "user-stories"],
  );
  assert.equal(
    isPhaseOutputLocked({
      phaseId: "discovery",
      outputKey: "prd",
      hasExistingArtifacts: false,
    }),
    true,
  );
});

test("AC-ENG-003/006: implementation selects and requires the complete evidence pack", () => {
  const firstExecution = {
    phaseId: "implementation",
    availableOutputKeys: engineeringEvidenceOutputs,
    hasExistingArtifacts: false,
  };
  assert.deepEqual(initialPhaseOutputKeys(firstExecution), engineeringEvidenceOutputs);
  assert.equal(
    isPhaseOutputSelectionComplete({
      ...firstExecution,
      selectedOutputKeys: engineeringEvidenceOutputs,
    }),
    true,
  );
  assert.equal(
    isPhaseOutputSelectionComplete({
      ...firstExecution,
      selectedOutputKeys: engineeringEvidenceOutputs.slice(0, -1),
    }),
    false,
  );
  for (const outputKey of engineeringEvidenceOutputs) {
    assert.equal(isPhaseOutputLocked({
      phaseId: "implementation",
      outputKey,
      hasExistingArtifacts: false,
    }), true, outputKey);
  }
  assert.deepEqual(
    requiredPhaseApprovalOutputKeys("implementation", engineeringEvidenceOutputs),
    engineeringEvidenceOutputs,
  );

  const rerun = {
    phaseId: "implementation",
    availableOutputKeys: engineeringEvidenceOutputs,
    hasExistingArtifacts: true,
    existingOutputKeys: engineeringEvidenceOutputs,
    initialOutputKeys: ["engineering-test-evidence", "engineering-review"],
  };
  assert.deepEqual(initialPhaseOutputKeys(rerun), [
    "engineering-test-evidence",
    "engineering-review",
  ]);
  assert.equal(isPhaseOutputSelectionComplete({
    ...rerun,
    selectedOutputKeys: ["engineering-test-evidence", "engineering-review"],
  }), true);
});

test("AC-ENG-005/006: a legacy implementation selects every missing evidence output and remains submittable", () => {
  const existingOutputKeys = ["implementation-notes"];
  const missingOutputKeys = engineeringEvidenceOutputs.slice(1);
  const legacy = {
    phaseId: "implementation",
    availableOutputKeys: engineeringEvidenceOutputs,
    hasExistingArtifacts: true,
    existingOutputKeys,
  };

  assert.deepEqual(initialPhaseOutputKeys(legacy), missingOutputKeys);
  assert.equal(isPhaseOutputSelectionComplete({
    ...legacy,
    selectedOutputKeys: missingOutputKeys,
  }), true, "the legacy backfill must be enabled for submission without MISSING_REQUIRED_OUTPUTS");
  assert.equal(isPhaseOutputSelectionComplete({
    ...legacy,
    selectedOutputKeys: missingOutputKeys.slice(0, -1),
  }), false, "every missing evidence output remains required");

  const fullPackRerun = {
    phaseId: "implementation",
    availableOutputKeys: engineeringEvidenceOutputs,
    hasExistingArtifacts: true,
    existingOutputKeys: engineeringEvidenceOutputs,
    initialOutputKeys: ["engineering-review"],
  };
  assert.deepEqual(initialPhaseOutputKeys(fullPackRerun), ["engineering-review"]);
  assert.equal(isPhaseOutputSelectionComplete({
    ...fullPackRerun,
    selectedOutputKeys: ["engineering-review"],
  }), true, "a complete legacy pack must retain partial-rerun behavior");
});

test("a full Product execution treats the task Change Contract as immutable context", () => {
  const availableOutputKeys = ["change-contract", "prd", "user-stories"];
  assert.deepEqual(
    initialPhaseOutputKeys({
      phaseId: "discovery",
      availableOutputKeys,
      hasExistingArtifacts: false,
      existingOutputKeys: ["change-contract"],
    }),
    ["prd", "user-stories"],
  );
  assert.equal(
    isPhaseOutputSelectionComplete({
      phaseId: "discovery",
      availableOutputKeys,
      hasExistingArtifacts: false,
      existingOutputKeys: ["change-contract"],
      selectedOutputKeys: ["prd", "user-stories"],
    }),
    true,
  );
  assert.equal(
    isPhaseOutputSelectionComplete({
      phaseId: "discovery",
      availableOutputKeys,
      hasExistingArtifacts: false,
      existingOutputKeys: ["change-contract"],
      selectedOutputKeys: ["change-contract", "prd", "user-stories"],
    }),
    false,
  );
});

test("an existing phase can initialize and submit a local output rerun", () => {
  const context = {
    phaseId: "design",
    availableOutputKeys: ["design-baseline", "design-spec", "design-prototype"],
    hasExistingArtifacts: true,
  };
  assert.deepEqual(
    initialPhaseOutputKeys({ ...context, initialOutputKeys: ["design-spec", "unknown"] }),
    ["design-spec"],
  );
  assert.equal(
    isPhaseOutputLocked({
      phaseId: "design",
      outputKey: "design-spec",
      hasExistingArtifacts: true,
    }),
    false,
  );
  assert.equal(
    isPhaseOutputSelectionComplete({ ...context, selectedOutputKeys: ["design-spec"] }),
    true,
  );
  assert.equal(
    isPhaseOutputSelectionComplete({ ...context, selectedOutputKeys: [] }),
    false,
  );
});

test("a first architecture execution requires only the bootstrap decision artifacts", () => {
  const context = {
    phaseId: "architecture",
    availableOutputKeys: architectureOutputs,
    hasExistingArtifacts: false,
  };

  assert.deepEqual(initialPhaseOutputKeys(context), architectureBootstrapOutputs);
  for (const outputKey of architectureBootstrapOutputs) {
    assert.equal(
      isPhaseOutputLocked({ phaseId: context.phaseId, outputKey, hasExistingArtifacts: false }),
      true,
    );
  }
  assert.equal(
    isPhaseOutputLocked({
      phaseId: context.phaseId,
      outputKey: "architecture-c4-context",
      hasExistingArtifacts: false,
    }),
    true,
  );
  assert.equal(
    isPhaseOutputSelectionComplete({
      ...context,
      selectedOutputKeys: architectureBootstrapOutputs,
    }),
    true,
  );
  assert.equal(
    isPhaseOutputSelectionComplete({
      ...context,
      selectedOutputKeys: architectureBootstrapOutputs.slice(0, -1),
    }),
    false,
  );
  assert.deepEqual(
    requiredPhaseApprovalOutputKeys(context.phaseId, context.availableOutputKeys),
    architectureOutputs,
  );
});

test("an architecture checkpoint cannot enter selected-state work without a recorded selection", () => {
  const context = {
    phaseId: "architecture",
    availableOutputKeys: architectureOutputs,
    hasExistingArtifacts: true,
    existingOutputKeys: architectureBootstrapOutputs,
  };

  assert.deepEqual(
    initialPhaseOutputKeys({
      ...context,
      initialOutputKeys: ["architecture-nfrs", "unknown"],
    }),
    architectureBootstrapOutputs,
  );
  assert.equal(
    isPhaseOutputLocked({
      phaseId: context.phaseId,
      outputKey: "architecture-nfrs",
      hasExistingArtifacts: true,
    }),
    true,
  );
  assert.equal(
    isPhaseOutputSelectionComplete({
      ...context,
      selectedOutputKeys: ["architecture-nfrs"],
    }),
    false,
  );
  assert.equal(
    isPhaseOutputSelectionComplete({
      ...context,
      selectedOutputKeys: ["architecture-options"],
    }),
    true,
  );
  assert.equal(
    isPhaseOutputSelectionComplete({
      ...context,
      selectedOutputKeys: architectureOutputs.slice(architectureBootstrapOutputs.length),
    }),
    false,
  );
});

test("a legacy partial architecture run finishes the three checkpoint artifacts before selection", () => {
  const context = {
    phaseId: "architecture",
    availableOutputKeys: architectureOutputs,
    hasExistingArtifacts: true,
    existingOutputKeys: ["architecture"],
  };
  assert.deepEqual(initialPhaseOutputKeys(context), [
    "architecture-discovery-context",
    "architecture-options",
  ]);
  assert.equal(
    isPhaseOutputSelectionComplete({
      ...context,
      selectedOutputKeys: ["architecture-discovery-context", "architecture-options"],
    }),
    true,
  );
  assert.equal(
    isPhaseOutputLocked({
      phaseId: context.phaseId,
      outputKey: "architecture-c4-context",
      hasExistingArtifacts: true,
    }),
    true,
  );
});

test("a valid architecture selection unlocks the post-selection pack and local reruns", () => {
  const context = {
    phaseId: "architecture",
    availableOutputKeys: architectureOutputs,
    hasExistingArtifacts: true,
    existingOutputKeys: architectureBootstrapOutputs,
    architectureSelectionRecorded: true,
  };

  assert.deepEqual(
    initialPhaseOutputKeys(context),
    [...REQUIRED_ARCHITECTURE_POST_SELECTION_OUTPUT_KEYS],
  );
  assert.deepEqual(
    initialPhaseOutputKeys({ ...context, initialOutputKeys: ["architecture-nfrs"] }),
    ["architecture-nfrs"],
  );
  assert.equal(
    isPhaseOutputLocked({
      phaseId: context.phaseId,
      outputKey: "architecture-nfrs",
      hasExistingArtifacts: true,
      architectureSelectionRecorded: true,
    }),
    false,
  );
  assert.equal(
    isPhaseOutputSelectionComplete({
      ...context,
      selectedOutputKeys: [...REQUIRED_ARCHITECTURE_POST_SELECTION_OUTPUT_KEYS],
    }),
    true,
  );
});

test("a partial architecture impact defaults to the index and ignores bootstrap outputs", () => {
  assert.deepEqual(
    architecturePartialOutputKeys({
      availableOutputKeys: architectureOutputs,
    }),
    ["architecture"],
  );
  assert.deepEqual(
    architecturePartialOutputKeys({
      availableOutputKeys: architectureOutputs,
      initialOutputKeys: ["architecture-options", "architecture-nfrs", "unknown"],
    }),
    ["architecture", "architecture-nfrs"],
  );
  assert.deepEqual(
    architecturePartialAllowedOutputKeys(architectureOutputs),
    [...REQUIRED_ARCHITECTURE_POST_SELECTION_OUTPUT_KEYS],
  );
});

test("an assessed partial impact can only select its affected output boundary", () => {
  const affectedOutputKeys = ["architecture", "architecture-patterns", "architecture-nfrs"];
  assert.deepEqual(
    architecturePartialAllowedOutputKeys(architectureOutputs, affectedOutputKeys),
    affectedOutputKeys,
  );
  assert.deepEqual(
    architecturePartialOutputKeys({
      availableOutputKeys: architectureOutputs,
      initialOutputKeys: ["architecture-patterns", "architecture-adrs"],
      affectedOutputKeys,
    }),
    ["architecture", "architecture-patterns"],
  );
  assert.deepEqual(
    architecturePartialOutputKeys({
      availableOutputKeys: architectureOutputs,
      initialOutputKeys: ["architecture-patterns"],
      affectedOutputKeys,
      requireAllAffectedOutputs: true,
    }),
    affectedOutputKeys,
  );
  assert.equal(
    isArchitecturePartialOutputSelectionComplete({
      availableOutputKeys: architectureOutputs,
      selectedOutputKeys: ["architecture", "architecture-patterns"],
      affectedOutputKeys,
    }),
    true,
  );
  assert.equal(
    isArchitecturePartialOutputSelectionComplete({
      availableOutputKeys: architectureOutputs,
      selectedOutputKeys: ["architecture", "architecture-patterns"],
      affectedOutputKeys,
      requireAllAffectedOutputs: true,
    }),
    false,
  );
  assert.equal(
    isArchitecturePartialOutputSelectionComplete({
      availableOutputKeys: architectureOutputs,
      selectedOutputKeys: affectedOutputKeys,
      affectedOutputKeys,
      requireAllAffectedOutputs: true,
    }),
    true,
  );
  assert.equal(
    isArchitecturePartialOutputSelectionComplete({
      availableOutputKeys: architectureOutputs,
      selectedOutputKeys: ["architecture-patterns"],
      affectedOutputKeys,
    }),
    false,
  );
  assert.equal(
    isArchitecturePartialOutputSelectionComplete({
      availableOutputKeys: architectureOutputs,
      selectedOutputKeys: ["architecture", "architecture-adrs"],
      affectedOutputKeys,
    }),
    false,
  );
});

test("partial freshness checks only assessed heads and requires a post-adoption revision", () => {
  const artifacts = [
    { artifactKey: "architecture", revision: 2, createdAt: "2026-08-18T09:00:00.000Z" },
    { artifactKey: "architecture-patterns", revision: 1, createdAt: "2026-08-18T09:00:00.000Z" },
    { artifactKey: "architecture-nfrs", revision: 3, createdAt: "2026-08-18T07:00:00.000Z" },
    { artifactKey: "architecture-c4-context", revision: 1, createdAt: "2026-08-18T07:00:00.000Z" },
  ];

  assert.deepEqual(
    architectureOutputKeysRequiringRefresh({
      impactMode: "partial",
      affectedOutputKeys: ["architecture", "architecture-patterns", "architecture-nfrs"],
      availableOutputKeys: architectureOutputs,
      artifacts,
      selectedAt: "2026-08-18T08:00:00.000Z",
    }),
    ["architecture-patterns"],
  );
  assert.deepEqual(
    architectureOutputKeysRequiringRefresh({
      availableOutputKeys: architectureOutputs,
      artifacts,
      selectedAt: "2026-08-18T08:00:00.000Z",
    }),
    ["architecture-c4-context", "architecture-nfrs"],
  );
});

test("architecture impact rationale requires ten non-whitespace characters", () => {
  assert.equal(isArchitectureImpactRationaleValid("  123456789  "), false);
  assert.equal(isArchitectureImpactRationaleValid("  1234567890  "), true);
});

test("reuse is immutable and partial impact exposes only its declared outputs", () => {
  assert.equal(isArchitectureImpactOutputMutable("reuse", [], "architecture"), false);
  assert.equal(
    isArchitectureImpactOutputMutable("partial", ["architecture"], "architecture"),
    true,
  );
  assert.equal(
    isArchitectureImpactOutputMutable("partial", ["architecture"], "architecture-options"),
    false,
  );
  assert.equal(isArchitectureImpactOutputMutable(undefined, undefined, "architecture"), true);
});

test("a partial architecture impact cannot smuggle a new option through review comments", () => {
  assert.equal(
    isArchitectureReselectionBlockedByImpact("partial", "Selected option: C"),
    true,
  );
  assert.equal(
    isArchitectureReselectionBlockedByImpact(
      "partial",
      "Selected option: B\nSelected option: C",
    ),
    true,
  );
  assert.equal(
    isArchitectureReselectionBlockedByImpact("partial", "请补充缓存失效证据"),
    false,
  );
  assert.equal(
    isArchitectureReselectionBlockedByImpact("reuse", "Selected option: C"),
    false,
  );
});

test("architecture selection evidence uses a strict marker tied to the reviewed options revision", () => {
  assert.equal(parseArchitectureSelectionId("Compare Option B with A"), undefined);
  assert.equal(parseArchitectureSelectionId("Selected option: B\n条件：验证限流"), "B");
  assert.equal(parseArchitectureSelectionId("选择方案：Option C"), "C");
  assert.equal(
    parseArchitectureSelectionId("Selected option: B\nSelected option: C"),
    undefined,
  );

  const reviews = [{
    id: "review-1",
    decision: "request_changes",
    comment: "Selected option: B\nCondition: validate rate limits",
    artifactIds: ["options-v1"],
    createdAt: "2026-08-18T08:00:00.000Z",
  }];
  assert.deepEqual(architectureSelectionFromReviews(reviews, "options-v1"), {
    optionId: "B",
    reviewId: "review-1",
    selectedAt: "2026-08-18T08:00:00.000Z",
  });
  assert.equal(
    architectureSelectionFromReviews(
      reviews,
      "options-v1",
      ["options-v1", "discovery-v1"],
    ),
    undefined,
  );
  assert.equal(architectureSelectionFromReviews(reviews, "options-v2"), undefined);
});

test("AC-ARCH-LOOP-003/004: architecture options become plain decision cards", () => {
  const options = `# Architecture Options

### Option A — Incremental extension

Keep state in the existing component.

- **Optimizes:** smallest code diff.
- **Gives up:** exact-once behavior is harder to prove.

### Option B — Pure feature-session engine

Use a feature-local reducer and pure selectors.

- **Optimizes:** correctness and table-driven tests.
- **Gives up:** a small domain model to maintain.

## Provisional recommendation

**Recommend Option B.** It best preserves the current boundary.
`;
  assert.deepEqual(architectureOptionSummaries(options), [
    {
      id: "A",
      title: "Incremental extension",
      summary: "Keep state in the existing component.",
      optimizes: "smallest code diff.",
      givesUp: "exact-once behavior is harder to prove.",
      recommended: false,
    },
    {
      id: "B",
      title: "Pure feature-session engine",
      summary: "Use a feature-local reducer and pure selectors.",
      optimizes: "correctness and table-driven tests.",
      givesUp: "a small domain model to maintain.",
      recommended: true,
    },
  ]);
});

test("fallback workflow matches the registered architecture pack and its consumers", () => {
  const byId = new Map(FALLBACK_PHASES.map((phase) => [phase.id, phase]));

  assert.deepEqual(byId.get("architecture")?.outputs, architectureOutputs);
  assert.deepEqual(byId.get("implementation")?.inputs, [
    "change-contract",
    "prd",
    "user-stories",
    "design-baseline",
    "design-spec",
    "architecture",
    "architecture-c4-containers",
    "architecture-adrs",
    "architecture-patterns",
    "architecture-nfrs",
  ]);
  assert.deepEqual(byId.get("implementation")?.outputs, engineeringEvidenceOutputs);
  assert.deepEqual(byId.get("verification")?.inputs, [
    "change-contract",
    "prd",
    "user-stories",
    "design-spec",
    "architecture",
    "architecture-nfrs",
    "implementation-notes",
    "engineering-test-evidence",
    "engineering-review",
  ]);
  assert.deepEqual(byId.get("release")?.inputs, [
    "architecture",
    "architecture-adrs",
    "architecture-nfrs",
    "architecture-adversarial",
    "test-report",
  ]);
});

test("a local rerun ignores an invalid requested scope and falls back safely", () => {
  assert.deepEqual(
    initialPhaseOutputKeys({
      phaseId: "verification",
      availableOutputKeys: ["test-report"],
      hasExistingArtifacts: true,
      initialOutputKeys: ["unknown"],
    }),
    ["test-report"],
  );
});

test("the Figma draft name follows the current run title", () => {
  assert.equal(defaultFigmaFileName("  登录体验优化  "), "登录体验优化 · 设计稿");
  assert.equal(defaultFigmaFileName(""), "当前任务 · 设计稿");
  assert.equal(defaultFigmaFileName("x".repeat(200)).length, 160);
});
