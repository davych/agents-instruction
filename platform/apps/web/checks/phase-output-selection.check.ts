import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultFigmaFileName,
  initialPhaseOutputKeys,
  isPhaseOutputLocked,
  isPhaseOutputSelectionComplete,
} from "../src/lib/phase-output-selection.ts";

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
