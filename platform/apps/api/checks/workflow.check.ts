import assert from "node:assert/strict";
import test from "node:test";

import {
  architectureOptionIds,
  assertPhaseExecutable,
  assertPhaseReviewable,
  findArchitectureSelectionEvidence,
  parseArchitectureSelectionId,
  requiredArchitecturePostSelectionOutputs,
  requiredApprovalOutputKeys,
  resolveOutputSelection,
  validateArchitectureSelectionComment,
  validateArchitectureImpactArtifactMutation,
  validateArchitectureImpactOutputs,
  validateArchitecturePartialInheritance,
  validateArchitecturePartialExecution,
  validateArtifactSelection
} from "../src/domain/workflow.ts";

test("architecture impact keeps partial execution inside the declared output scope", () => {
  const outputs = [
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
  const affected = ["architecture", "architecture-c4-containers"];
  assert.doesNotThrow(() => validateArchitectureImpactOutputs(outputs, affected));
  assert.throws(
    () => validateArchitectureImpactOutputs(outputs, ["architecture-c4-containers"]),
    (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_IMPACT_INDEX_REQUIRED",
  );
  assert.throws(
    () => validateArchitectureImpactOutputs(outputs, ["architecture", "architecture-options"]),
    (error: unknown) => (error as { code?: string }).code === "INVALID_ARCHITECTURE_IMPACT_OUTPUTS",
  );
  assert.doesNotThrow(() => validateArchitecturePartialExecution(affected, affected, false));
  assert.throws(
    () => validateArchitecturePartialExecution(affected, ["architecture"], false),
    (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_IMPACT_OUTPUTS_INCOMPLETE",
  );
  assert.doesNotThrow(() => validateArchitecturePartialExecution(affected, ["architecture"], true));
  assert.throws(
    () => validateArchitecturePartialExecution(affected, ["architecture-c4-containers"], true),
    (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_IMPACT_INDEX_REQUIRED",
  );
  assert.throws(
    () => validateArchitecturePartialExecution(affected, ["architecture-adrs"], true),
    (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_IMPACT_SCOPE_EXCEEDED",
  );
});

test("partial architecture impact protects inherited artifacts from every mutation path", () => {
  const sourceArchitectureId = "00000000-0000-4000-8000-000000000001";
  const sourceOptionsId = "00000000-0000-4000-8000-000000000002";
  const impact = {
    mode: "partial" as const,
    rationale: "Only the architecture index changes for this requirement.",
    sourceRunId: "00000000-0000-4000-8000-000000000003",
    sourceRunTitle: "Approved baseline",
    sourcePhaseRunId: "00000000-0000-4000-8000-000000000004",
    sourceArtifactIds: [sourceArchitectureId, sourceOptionsId],
    inputArtifactIds: ["00000000-0000-4000-8000-000000000005"],
    affectedOutputKeys: ["architecture"],
    assessedAt: "2026-08-18T08:00:00.000Z",
    selection: {
      optionId: "A",
      reviewId: "00000000-0000-4000-8000-000000000006",
      optionsArtifactId: sourceOptionsId,
      selectedAt: "2026-08-18T07:00:00.000Z",
    },
  };
  assert.doesNotThrow(() => validateArchitectureImpactArtifactMutation(impact, "architecture"));
  assert.throws(
    () => validateArchitectureImpactArtifactMutation(impact, "architecture-options"),
    (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_IMPACT_SCOPE_EXCEEDED",
  );
  assert.throws(
    () => validateArchitectureImpactArtifactMutation(
      { ...impact, mode: "reuse", affectedOutputKeys: [] },
      "architecture",
    ),
    (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_IMPACT_REUSE_IMMUTABLE",
  );
  assert.doesNotThrow(() => validateArchitecturePartialInheritance(
    impact,
    ["architecture", "architecture-options"],
    [
      { artifactKey: "architecture", revision: 2, parentArtifactId: sourceArchitectureId },
      { artifactKey: "architecture-options", revision: 1, parentArtifactId: sourceOptionsId },
    ],
  ));
  assert.throws(
    () => validateArchitecturePartialInheritance(
      impact,
      ["architecture", "architecture-options"],
      [
        { artifactKey: "architecture", revision: 2, parentArtifactId: sourceArchitectureId },
        { artifactKey: "architecture-options", revision: 2, parentArtifactId: sourceOptionsId },
      ],
    ),
    (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_IMPACT_BASELINE_DIVERGED",
  );
});

test("a phase can rerun from review or approved state but never while pending", () => {
  assert.doesNotThrow(() => assertPhaseExecutable("ready"));
  assert.doesNotThrow(() => assertPhaseExecutable("changes_requested"));
  assert.doesNotThrow(() => assertPhaseExecutable("awaiting_review"));
  assert.doesNotThrow(() => assertPhaseExecutable("approved"));
  assert.throws(() => assertPhaseExecutable("pending"), /不允许执行/u);
  assert.throws(() => assertPhaseExecutable("running"), /不允许执行/u);
});

test("every review is a human gate", () => {
  assert.doesNotThrow(() => assertPhaseReviewable("awaiting_review"));
  assert.throws(() => assertPhaseReviewable("running"), /只有 awaiting_review/u);
  assert.throws(() => assertPhaseReviewable("approved"), /只有 awaiting_review/u);
});

test("design output selection keeps required deliverables and validates optional outputs", () => {
  const outputs = ["design-baseline", "design-spec", "design-prototype", "figma-handoff"];
  assert.deepEqual(resolveOutputSelection("design", outputs), ["design-baseline", "design-spec"]);
  assert.deepEqual(
    resolveOutputSelection("design", outputs, ["design-baseline", "design-spec", "design-prototype"]),
    ["design-baseline", "design-spec", "design-prototype"]
  );
  assert.throws(
    () => resolveOutputSelection("design", outputs, ["design-spec"]),
    /首次执行必须生成后续阶段依赖/u
  );
  assert.deepEqual(
    resolveOutputSelection("design", outputs, ["design-spec"], ["design-baseline", "design-spec"]),
    ["design-spec"]
  );
  assert.throws(
    () => resolveOutputSelection("design", outputs, ["design-baseline", "design-spec", "unknown"]),
    /未注册/u
  );
  assert.throws(
    () => resolveOutputSelection("design", outputs, ["design-baseline", "design-spec", "design-spec"]),
    /不能重复/u
  );
  assert.deepEqual(resolveOutputSelection("discovery", ["prd", "user-stories"]), ["prd", "user-stories"]);
  assert.throws(
    () => resolveOutputSelection("discovery", ["prd", "user-stories"], ["prd"]),
    /首次执行必须生成全部注册输出/u
  );
  assert.deepEqual(
    resolveOutputSelection("discovery", ["prd", "user-stories"], ["prd"], ["prd", "user-stories"]),
    ["prd"]
  );
});

test("AC-ENG-003/007: implementation requires the full evidence pack before first approval", () => {
  const outputs = [
    "implementation-notes",
    "implementation-plan",
    "implementation-tasks",
    "engineering-session-log",
    "engineering-test-evidence",
    "engineering-review",
    "engineering-provenance",
  ];

  assert.deepEqual(resolveOutputSelection("implementation", outputs), outputs);
  assert.throws(
    () => resolveOutputSelection("implementation", outputs, outputs.slice(0, -1)),
    /首次执行必须生成全部注册输出/u,
  );
  assert.deepEqual(
    resolveOutputSelection(
      "implementation",
      outputs,
      ["engineering-test-evidence", "engineering-review"],
      outputs,
    ),
    ["engineering-test-evidence", "engineering-review"],
  );
  assert.deepEqual(requiredApprovalOutputKeys("implementation", outputs), outputs);
});

test("architecture uses a three-artifact selection checkpoint before the full pack", () => {
  const outputs = [
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
  const checkpoint = [
    "architecture",
    "architecture-discovery-context",
    "architecture-options",
  ];
  const selectedState = outputs.slice(checkpoint.length);

  assert.deepEqual(resolveOutputSelection("architecture", outputs), checkpoint);
  assert.deepEqual(
    resolveOutputSelection("architecture", outputs, checkpoint),
    checkpoint,
  );
  assert.throws(
    () => resolveOutputSelection("architecture", outputs, ["architecture-options"]),
    /首次执行必须生成选型检查点输出/u,
  );
  assert.throws(
    () => resolveOutputSelection("architecture", outputs, selectedState, checkpoint),
    (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_SELECTION_REQUIRED",
  );
  assert.deepEqual(
    resolveOutputSelection(
      "architecture",
      outputs,
      selectedState,
      checkpoint,
      { architectureSelectionRecorded: true },
    ),
    selectedState,
  );
  assert.deepEqual(
    resolveOutputSelection(
      "architecture",
      outputs,
      undefined,
      checkpoint,
      { architectureSelectionRecorded: true },
    ),
    requiredArchitecturePostSelectionOutputs,
  );
  assert.deepEqual(
    resolveOutputSelection(
      "architecture",
      outputs,
      ["architecture-options"],
      checkpoint,
    ),
    ["architecture-options"],
  );
  assert.throws(
    () => resolveOutputSelection(
      "architecture",
      outputs,
      ["architecture-c4-context"],
      checkpoint,
    ),
    (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_SELECTION_REQUIRED",
  );
  assert.deepEqual(
    resolveOutputSelection("architecture", outputs, undefined, ["architecture"]),
    ["architecture-discovery-context", "architecture-options"],
  );
  assert.deepEqual(
    resolveOutputSelection("architecture", outputs, undefined, outputs),
    checkpoint,
  );
  assert.deepEqual(requiredApprovalOutputKeys("architecture", outputs), outputs);
  assert.deepEqual(
    requiredApprovalOutputKeys("design", [
      "design-baseline",
      "design-spec",
      "design-prototype",
      "figma-handoff",
    ]),
    ["design-baseline", "design-spec"],
  );
});

test("architecture selection markers are strict and must name a documented option", () => {
  const options = [
    "# Architecture Options",
    "",
    "## Option A: Modular monolith",
    "",
    "## Option B-2: Event driven",
  ].join("\n");

  assert.deepEqual(architectureOptionIds(options), ["A", "B-2"]);
  assert.deepEqual(
    architectureOptionIds("### Option A — Existing view\n\n### Option B - Feature session\n"),
    ["A", "B"],
    "initialized projects may contain Architect-authored H3/dash headings",
  );
  assert.equal(
    validateArchitectureSelectionComment(
      "Selected option: B",
      "### Option A — Existing view\n\n### Option B — Feature session\n",
    ),
    "B",
  );
  assert.equal(parseArchitectureSelectionId("We should compare Option A and B-2"), undefined);
  assert.equal(parseArchitectureSelectionId("Selected option: B-2\nCondition: load test"), "B-2");
  assert.equal(parseArchitectureSelectionId("选择方案：Option A"), "A");
  assert.equal(
    parseArchitectureSelectionId("Selected option: A\nSelected option: B-2"),
    undefined,
  );
  assert.equal(validateArchitectureSelectionComment("ordinary change request", options), undefined);
  assert.equal(validateArchitectureSelectionComment("Selected option: b-2", options), "B-2");
  const oversizedOptionId = "A".repeat(161);
  assert.deepEqual(architectureOptionIds(`## Option ${oversizedOptionId}: invalid`), []);
  assert.equal(parseArchitectureSelectionId(`Selected option: ${oversizedOptionId}`), undefined);
  assert.throws(
    () => validateArchitectureSelectionComment("Selected option: C", options),
    (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_OPTION_NOT_FOUND",
  );
  assert.throws(
    () => validateArchitectureSelectionComment(
      "Selected option: A",
      `${options}\n## Option a: Duplicate identifier`,
    ),
    (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_OPTION_AMBIGUOUS",
  );
  const evidence = findArchitectureSelectionEvidence("options-v2", options, [
    {
      id: "older",
      decision: "request_changes",
      comment: "Selected option: A",
      artifactIds: ["discovery-v1", "options-v2"],
      createdAt: "2026-08-18T07:00:00.000Z",
    },
    {
      id: "current",
      decision: "request_changes",
      comment: "Selected option: B-2\nCondition: load test",
      artifactIds: ["architecture", "discovery-v1", "options-v2"],
      createdAt: "2026-08-18T08:00:00.000Z",
    },
  ], ["options-v2", "discovery-v1"]);
  assert.deepEqual(evidence, {
    optionId: "B-2",
    reviewId: "current",
    optionsArtifactId: "options-v2",
    selectedAt: "2026-08-18T08:00:00.000Z",
  });
  assert.equal(
    findArchitectureSelectionEvidence(
      "options-v2",
      options,
      [{
        id: "stale-context",
        decision: "request_changes",
        comment: "Selected option: B-2",
        artifactIds: ["options-v2", "discovery-v1"],
        createdAt: "2026-08-18T08:00:00.000Z",
      }],
      ["options-v2", "discovery-v2"],
    ),
    undefined,
  );
  assert.equal(findArchitectureSelectionEvidence("options-v3", options, []), undefined);
});

test("downstream phases require approved, matching upstream artifacts", () => {
  assert.doesNotThrow(() => validateArtifactSelection("design", ["prd", "user-stories"], [
    {
      id: "prd",
      artifactKey: "prd",
      sourcePosition: 0,
      sourceStatus: "approved",
      reviewStatus: "approved"
    },
    {
      id: "stories",
      artifactKey: "user-stories",
      sourcePosition: 0,
      sourceStatus: "approved",
      reviewStatus: "approved"
    }
  ]));
  assert.throws(
    () => validateArtifactSelection("design", ["prd", "user-stories"], [{
      id: "prd",
      artifactKey: "prd",
      sourcePosition: 0,
      sourceStatus: "approved",
      reviewStatus: "approved"
    }]),
    /缺少已批准/u
  );
  assert.throws(
    () => validateArtifactSelection("design", ["prd"], [{
      id: "prd",
      artifactKey: "prd",
      sourcePosition: 0,
      sourceStatus: "approved",
      reviewStatus: "changes_requested"
    }]),
    /只能选择/u
  );
  assert.throws(
    () => validateArtifactSelection("design", ["prd"], [
      { id: "one", artifactKey: "prd", sourcePosition: 0, sourceStatus: "approved", reviewStatus: "approved" },
      { id: "two", artifactKey: "prd", sourcePosition: 0, sourceStatus: "approved", reviewStatus: "approved" }
    ]),
    /只能选择一个/u
  );
});
