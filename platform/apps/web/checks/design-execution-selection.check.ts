import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFigmaExecutionOptions,
  FIGMA_HANDOFF_OUTPUT_KEY,
  INITIAL_DESIGN_OUTPUT_KEYS,
  isCapabilityConfirmed,
  isFigmaRequested,
  reconcileFigmaPlanSelection,
  setFigmaRequested,
} from "../src/lib/design-execution-selection.ts";
import type { FigmaTarget } from "../src/lib/types.ts";

const privateDraftTarget: FigmaTarget = {
  mode: "new_private_draft",
  planKey: "plan::full-seat",
  fileName: "拼音分级练习",
};

test("initial design outputs do not request Figma", () => {
  const selectedOutputKeys = [...INITIAL_DESIGN_OUTPUT_KEYS];

  assert.equal(isFigmaRequested(selectedOutputKeys), false);
  assert.deepEqual(
    buildFigmaExecutionOptions({
      selectedOutputKeys,
      figmaIntegrationReady: false,
    }),
    { valid: true, options: {} },
  );
});

test("requesting Figma preserves intent while an execution target is incomplete", () => {
  const selectedOutputKeys = setFigmaRequested(INITIAL_DESIGN_OUTPUT_KEYS, true);

  assert.equal(isFigmaRequested(selectedOutputKeys), true);
  assert.deepEqual(
    buildFigmaExecutionOptions({
      selectedOutputKeys,
      figmaIntegrationReady: true,
    }),
    { valid: false, reason: "FIGMA_TARGET_REQUIRED" },
  );
  assert.equal(selectedOutputKeys.includes(FIGMA_HANDOFF_OUTPUT_KEY), true);
});

test("readiness loss disables submission without silently cancelling Figma", () => {
  const selectedOutputKeys = setFigmaRequested(INITIAL_DESIGN_OUTPUT_KEYS, true);
  const readyResult = buildFigmaExecutionOptions({
    selectedOutputKeys,
    figmaIntegrationReady: true,
    figmaTarget: privateDraftTarget,
  });
  const unavailableResult = buildFigmaExecutionOptions({
    selectedOutputKeys,
    figmaIntegrationReady: false,
    figmaTarget: privateDraftTarget,
  });

  assert.equal(readyResult.valid, true);
  assert.deepEqual(unavailableResult, {
    valid: false,
    reason: "FIGMA_INTEGRATION_NOT_READY",
  });
  assert.equal(selectedOutputKeys.includes(FIGMA_HANDOFF_OUTPUT_KEY), true);
});

test("explicit cancellation omits both Figma output and a stale target from API options", () => {
  const requested = setFigmaRequested(INITIAL_DESIGN_OUTPUT_KEYS, true);
  const selectedOutputKeys = setFigmaRequested(requested, false);
  const result = buildFigmaExecutionOptions({
    selectedOutputKeys,
    figmaIntegrationReady: true,
    figmaTarget: privateDraftTarget,
  });

  assert.equal(isFigmaRequested(selectedOutputKeys), false);
  assert.deepEqual(result, { valid: true, options: {} });
});

test("a complete target produces API options alongside the selected Figma output", () => {
  const selectedOutputKeys = setFigmaRequested(INITIAL_DESIGN_OUTPUT_KEYS, true);
  const result = buildFigmaExecutionOptions({
    selectedOutputKeys,
    figmaIntegrationReady: true,
    figmaTarget: privateDraftTarget,
  });

  assert.equal(selectedOutputKeys.includes(FIGMA_HANDOFF_OUTPUT_KEY), true);
  assert.deepEqual(result, {
    valid: true,
    options: { figmaTarget: privateDraftTarget },
  });
});

test("an existing-file target is supported and repeated selection stays deduplicated", () => {
  const selectedOutputKeys = setFigmaRequested(
    setFigmaRequested(
      [...INITIAL_DESIGN_OUTPUT_KEYS, FIGMA_HANDOFF_OUTPUT_KEY],
      true,
    ),
    true,
  );
  const figmaTarget: FigmaTarget = {
    mode: "existing_file",
    fileUrl: "https://www.figma.com/design/FileKey123/Practice",
  };

  assert.equal(
    selectedOutputKeys.filter((key) => key === FIGMA_HANDOFF_OUTPUT_KEY).length,
    1,
  );
  assert.deepEqual(
    buildFigmaExecutionOptions({
      selectedOutputKeys,
      figmaIntegrationReady: true,
      figmaTarget,
    }),
    { valid: true, options: { figmaTarget } },
  );
});

test("stale successful capability data is not confirmed while refresh is pending or failed", () => {
  const base = {
    dataReady: true,
    isFetching: false,
    isError: false,
    refreshPending: false,
    refreshError: false,
  };

  assert.equal(isCapabilityConfirmed(base), true);
  assert.equal(isCapabilityConfirmed({ ...base, isFetching: true }), false);
  assert.equal(isCapabilityConfirmed({ ...base, isError: true }), false);
  assert.equal(isCapabilityConfirmed({ ...base, refreshPending: true }), false);
  assert.equal(isCapabilityConfirmed({ ...base, refreshError: true }), false);
});

test("transient plan states preserve the user's plan and confirmed data reconciles it", () => {
  const plans = [
    { key: "plan-a", writable: true },
    { key: "plan-view", writable: false },
  ];

  assert.equal(reconcileFigmaPlanSelection("plan-a", [], false), "plan-a");
  assert.equal(reconcileFigmaPlanSelection("missing", plans, true), "plan-a");
  assert.equal(
    reconcileFigmaPlanSelection(
      "missing",
      [...plans, { key: "plan-b", writable: true }],
      true,
    ),
    "",
  );
});
