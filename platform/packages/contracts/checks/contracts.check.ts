import assert from "node:assert/strict";
import test from "node:test";

import {
  codexExecutionCapabilitiesSchema,
  codexReasoningEffortSchema,
  codexRunnerModeSchema,
  createArtifactRevisionSchema,
  createProjectSchema,
  createRunSchema,
  executePhaseSchema,
  figmaIntegrationStatusSchema,
  figmaPlanCapabilitiesSchema,
  PHASE_IDS,
  reviewPhaseSchema,
  updateTicketStatusSchema
} from "../src/index.ts";

test("the public workflow has the six fixed phases in order", () => {
  assert.deepEqual(PHASE_IDS, [
    "discovery", "design", "architecture", "implementation", "verification", "release"
  ]);
});

test("request contracts reject incomplete reviews and invalid artifact ids", () => {
  assert.equal(reviewPhaseSchema.safeParse({ decision: "approve", comment: "" }).success, false);
  assert.equal(reviewPhaseSchema.safeParse({
    decision: "approve",
    comment: "looks good",
    expectedArtifactIds: [crypto.randomUUID()]
  }).success, true);
  const duplicateHead = crypto.randomUUID();
  assert.equal(reviewPhaseSchema.safeParse({
    decision: "approve",
    comment: "looks good",
    expectedArtifactIds: [duplicateHead, duplicateHead]
  }).success, false);
  assert.equal(executePhaseSchema.safeParse({ selectedArtifactIds: ["not-a-uuid"] }).success, false);
  assert.equal(createProjectSchema.safeParse({ name: "demo", rootPath: "/tmp/demo" }).success, true);
});

test("manual artifact revisions require non-empty content and an optimistic-lock hash", () => {
  assert.equal(createArtifactRevisionSchema.safeParse({
    content: "# Human-adjusted artifact\n",
    expectedContentHash: "a".repeat(64)
  }).success, true);
  assert.equal(createArtifactRevisionSchema.safeParse({
    content: "",
    expectedContentHash: "a".repeat(64)
  }).success, false);
  assert.equal(createArtifactRevisionSchema.safeParse({
    content: "updated",
    expectedContentHash: "stale-or-invalid"
  }).success, false);
});

test("task titles reject control characters used to construct scoped artifact names", () => {
  assert.equal(createRunSchema.safeParse({ title: "登录体验改版", objective: "Improve login" }).success, true);
  assert.equal(createRunSchema.safeParse({ title: "bad\nname", objective: "Improve login" }).success, false);
});

test("phase output selection is optional for old clients and validates artifact keys when supplied", () => {
  const legacy = executePhaseSchema.parse({ selectedArtifactIds: [] });
  assert.equal(legacy.selectedOutputKeys, undefined);
  assert.equal(legacy.model, undefined);
  assert.equal(legacy.reasoningEffort, undefined);
  assert.deepEqual(
    executePhaseSchema.parse({
      selectedArtifactIds: [],
      selectedOutputKeys: ["design-spec", "design-prototype", "figma-handoff"]
    }).selectedOutputKeys,
    ["design-spec", "design-prototype", "figma-handoff"]
  );
  assert.equal(executePhaseSchema.safeParse({ selectedOutputKeys: [] }).success, false);
  assert.equal(executePhaseSchema.safeParse({ selectedOutputKeys: ["../prototype.html"] }).success, false);
});

test("Codex execution selection is optional and rejects unsafe or unknown values", () => {
  assert.deepEqual(
    executePhaseSchema.parse({ model: "gpt-5.6-sol", reasoningEffort: "high" }),
    { selectedArtifactIds: [], model: "gpt-5.6-sol", reasoningEffort: "high" }
  );
  assert.equal(executePhaseSchema.safeParse({ model: "gpt-5.6-sol --yolo" }).success, false);
  assert.equal(executePhaseSchema.safeParse({ reasoningEffort: "extreme" }).success, false);
  assert.equal(codexReasoningEffortSchema.safeParse("ultra").success, true);
  assert.equal(codexRunnerModeSchema.safeParse("fake").success, true);
  assert.equal(codexRunnerModeSchema.safeParse("unknown").success, false);
});

test("Codex capabilities expose installed model and reasoning combinations", () => {
  assert.equal(codexExecutionCapabilitiesSchema.safeParse({
    models: [{
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      defaultReasoningEffort: "low",
      reasoningEfforts: ["low", "high", "ultra"]
    }],
    defaultModel: "gpt-5.6-sol",
    defaultReasoningEffort: "ultra"
  }).success, true);
  assert.equal(codexExecutionCapabilitiesSchema.safeParse({
    models: [{
      id: "gpt-5.6-sol --yolo",
      name: "unsafe",
      defaultReasoningEffort: "high",
      reasoningEfforts: ["high"]
    }],
    defaultModel: "gpt-5.6-sol --yolo",
    defaultReasoningEffort: "high"
  }).success, false);
});

test("Figma integration status carries a safe authorization handoff", () => {
  assert.equal(figmaIntegrationStatusSchema.safeParse({
    provider: "figma",
    state: "authorization_required",
    serverName: "figma",
    message: "请先授权 Figma",
    authorizationUrl: "https://example.test/oauth/figma"
  }).success, true);
  assert.equal(figmaIntegrationStatusSchema.safeParse({
    provider: "figma",
    state: "connected",
    serverName: "figma",
    message: "ready",
    authorizationUrl: null
  }).success, false);
});

test("Figma execution target and sanitized plan capabilities are explicit", () => {
  assert.deepEqual(executePhaseSchema.parse({
    selectedOutputKeys: ["design-baseline", "design-spec", "figma-handoff"],
    figmaTarget: {
      mode: "new_private_draft",
      planKey: "team::123456",
      fileName: "Checkout design"
    }
  }).figmaTarget, {
    mode: "new_private_draft",
    planKey: "team::123456",
    fileName: "Checkout design"
  });
  assert.equal(executePhaseSchema.safeParse({
    figmaTarget: { mode: "new_private_draft", planKey: "team::123", fileName: "bad\nname" }
  }).success, false);
  assert.equal(executePhaseSchema.safeParse({
    figmaTarget: { mode: "new_private_draft", planKey: " team::123 ", fileName: "Demo" }
  }).success, false);
  assert.equal(executePhaseSchema.safeParse({
    figmaTarget: { mode: "existing_file", fileUrl: "https://www.figma.com/design/abc/Demo" }
  }).success, true);
  assert.equal(figmaPlanCapabilitiesSchema.safeParse({
    provider: "figma",
    plans: [{ key: "team::123", name: "Personal", seat: "Full", tier: "starter", writable: true }]
  }).success, true);
});

test("ticket status updates only accept supported board columns", () => {
  assert.equal(updateTicketStatusSchema.safeParse({ status: "in_progress" }).success, true);
  assert.equal(updateTicketStatusSchema.safeParse({ status: "blocked" }).success, false);
});
