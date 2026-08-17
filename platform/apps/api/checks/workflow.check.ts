import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPhaseExecutable,
  assertPhaseReviewable,
  resolveOutputSelection,
  validateArtifactSelection
} from "../src/domain/workflow.ts";

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
