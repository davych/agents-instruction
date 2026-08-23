import assert from "node:assert/strict";
import test from "node:test";

import {
  architectureImpactSchema,
  architectureImpactToPhaseResolution,
  assessArchitectureDispositionSchema,
  assessArchitectureWaiverSchema,
  assessArchitectureImpactSchema,
  assessDesignImpactSchema,
  assessProductImpactSchema,
  changeContractSchema,
  captureHumanDecisionsSchema,
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
  PHASE_ROUTE_VERSION,
  phaseResolutionSchema,
  reviewPhaseSchema,
  updateTicketStatusSchema
} from "../src/index.ts";

const completeChangeContract = {
  workType: "feature" as const,
  summary: "为客户增加订单导出能力",
  currentBehavior: "客户目前只能逐页查看订单。",
  expectedBehavior: "客户可以按当前筛选条件导出订单。",
  inScope: ["订单列表导出"],
  outOfScope: ["定时发送导出文件"],
  acceptanceCriteria: ["导出内容与当前筛选条件一致"],
  regressionScope: ["订单列表筛选和分页"],
  riskFlags: ["data-export"],
  evidenceRefs: ["TICKET-142"]
};

test("architecture impact decisions distinguish reuse from scoped partial updates", () => {
  const selectedArtifactIds = [crypto.randomUUID(), crypto.randomUUID()];
  const expectedBaselineArtifactIds = Array.from({ length: 9 }, () => crypto.randomUUID());
  assert.equal(assessArchitectureImpactSchema.safeParse({
    mode: "reuse",
    rationale: "当前需求不改变任何系统边界或既有架构约束。",
    selectedArtifactIds,
    expectedBaselineArtifactIds,
    affectedOutputKeys: [],
  }).success, true);
  assert.equal(assessArchitectureImpactSchema.safeParse({
    mode: "partial",
    rationale: "新增外部集成，只需要更新架构索引和容器视图。",
    selectedArtifactIds,
    expectedBaselineArtifactIds,
    affectedOutputKeys: ["architecture", "architecture-c4-containers"],
  }).success, true);
  assert.equal(assessArchitectureImpactSchema.safeParse({
    mode: "partial",
    rationale: "遗漏架构索引的非法局部更新。",
    selectedArtifactIds,
    expectedBaselineArtifactIds,
    affectedOutputKeys: ["architecture-c4-containers"],
  }).success, false);
  assert.equal(assessArchitectureImpactSchema.safeParse({
    mode: "reuse",
    rationale: "复用却声明需要更新产物，应被拒绝。",
    selectedArtifactIds,
    expectedBaselineArtifactIds,
    affectedOutputKeys: ["architecture"],
  }).success, false);
  assert.equal(assessArchitectureImpactSchema.safeParse({
    mode: "reuse",
    rationale: "未知字段不能被静默忽略，否则客户端和服务端合同会漂移。",
    selectedArtifactIds,
    expectedBaselineArtifactIds,
    affectedOutputKeys: [],
    typoField: true,
  }).success, false);
});

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

test("structured human decisions require unique ids, meaningful answers, and locked artifact heads", () => {
  const artifactId = crypto.randomUUID();
  assert.equal(captureHumanDecisionsSchema.safeParse({
    responses: [{ id: "PROD-Q-01", response: "Use the current catalog in its existing order." }],
    expectedArtifactIds: [artifactId],
  }).success, true);
  assert.equal(captureHumanDecisionsSchema.safeParse({
    responses: [{ id: "PROD-Q-01", response: "ok" }],
    expectedArtifactIds: [artifactId],
  }).success, false);
  assert.equal(captureHumanDecisionsSchema.safeParse({
    responses: [
      { id: "PROD-Q-01", response: "First answer" },
      { id: "PROD-Q-01", response: "Conflicting answer" },
    ],
    expectedArtifactIds: [artifactId],
  }).success, false);
  assert.equal(captureHumanDecisionsSchema.safeParse({
    responses: [{ id: "PROD-Q-01", response: "Use the current catalog." }],
    expectedArtifactIds: [],
  }).success, false);
  assert.equal(captureHumanDecisionsSchema.safeParse({
    responses: [
      { id: "PROD-Q-01", response: "x".repeat(5_000) },
      { id: "PROD-Q-02", response: "y".repeat(2_500) },
    ],
    expectedArtifactIds: [artifactId],
  }).success, false);
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

test("run creation accepts a strict structured change contract without breaking old clients", () => {
  assert.equal(createRunSchema.safeParse({
    title: "订单导出",
    objective: "让客户导出订单",
    changeContract: completeChangeContract
  }).success, true);
  assert.equal(createRunSchema.safeParse({
    title: "旧客户端任务",
    objective: "仍然只发送原有字段"
  }).success, true);

  assert.equal(changeContractSchema.safeParse({
    ...completeChangeContract,
    typoField: "不能静默保留"
  }).success, false);
  assert.equal(changeContractSchema.safeParse({
    ...completeChangeContract,
    acceptanceCriteria: []
  }).success, false);
  assert.equal(changeContractSchema.safeParse({
    ...completeChangeContract,
    inScope: ["订单列表导出", "订单列表导出"]
  }).success, false);
  assert.equal(changeContractSchema.safeParse({
    ...completeChangeContract,
    summary: `非法\u0000摘要`
  }).success, false);
});

test("phase resolutions persist auditable and phase-specific dispositions", () => {
  const sourceRunId = crypto.randomUUID();
  const sourcePhaseRunId = crypto.randomUUID();
  const sourceArtifactIds = [crypto.randomUUID(), crypto.randomUUID()];
  const decidedAt = new Date().toISOString();

  const productReuse = {
    phaseId: "discovery",
    mode: "reuse",
    rationale: "本次缺陷的预期行为已由批准的产品基线完整定义。",
    inputArtifactIds: [],
    sourceRunId,
    sourceRunTitle: "订单产品基线",
    sourcePhaseRunId,
    sourceArtifactIds,
    affectedOutputKeys: [],
    routeVersion: PHASE_ROUTE_VERSION,
    decidedAt
  };
  assert.equal(phaseResolutionSchema.safeParse(productReuse).success, true);
  assert.equal(phaseResolutionSchema.safeParse({
    ...productReuse,
    mode: "skip"
  }).success, false);
  assert.equal(phaseResolutionSchema.safeParse({
    ...productReuse,
    sourceArtifactIds: []
  }).success, false);
  assert.equal(phaseResolutionSchema.safeParse({
    ...productReuse,
    unknownAuditField: true
  }).success, false);

  assert.equal(phaseResolutionSchema.safeParse({
    phaseId: "design",
    mode: "skip",
    rationale: "这是服务端计算缺陷，不改变任何用户界面或交互行为。",
    inputArtifactIds: [crypto.randomUUID()],
    sourceRunId: null,
    sourceRunTitle: null,
    sourcePhaseRunId: null,
    sourceArtifactIds: [],
    affectedOutputKeys: [],
    routeVersion: PHASE_ROUTE_VERSION,
    decidedAt
  }).success, true);
  assert.equal(phaseResolutionSchema.safeParse({
    phaseId: "architecture",
    mode: "partial",
    rationale: "接口契约发生局部变化，需要更新架构索引和 API 约束。",
    inputArtifactIds: [crypto.randomUUID()],
    sourceRunId,
    sourceRunTitle: "现有架构基线",
    sourcePhaseRunId,
    sourceArtifactIds,
    affectedOutputKeys: ["architecture", "architecture-patterns"],
    routeVersion: PHASE_ROUTE_VERSION,
    decidedAt
  }).success, true);
  assert.equal(phaseResolutionSchema.safeParse({
    phaseId: "architecture",
    mode: "skip",
    rationale: "已确认本次缺陷不改变系统边界、数据模型或非功能约束。",
    inputArtifactIds: [crypto.randomUUID()],
    sourceRunId: null,
    sourceRunTitle: null,
    sourcePhaseRunId: null,
    sourceArtifactIds: [],
    affectedOutputKeys: [],
    routeVersion: PHASE_ROUTE_VERSION,
    decidedAt
  }).success, true);
});

test("product and design impact assessments pin baselines and affected outputs", () => {
  const baselineIds = [crypto.randomUUID(), crypto.randomUUID()];
  assert.equal(assessProductImpactSchema.safeParse({
    mode: "direct",
    rationale: "技术性修复不改变任何外部可观察的产品行为。",
    selectedArtifactIds: [],
    expectedBaselineArtifactIds: [],
    affectedOutputKeys: []
  }).success, true);
  assert.equal(assessProductImpactSchema.safeParse({
    mode: "partial",
    rationale: "功能新增一个验收场景，需要局部更新用户故事。",
    selectedArtifactIds: [],
    expectedBaselineArtifactIds: baselineIds,
    affectedOutputKeys: ["user-stories"]
  }).success, true);
  assert.equal(assessProductImpactSchema.safeParse({
    mode: "reuse",
    rationale: "试图在没有来源基线时声明复用，应被拒绝。",
    selectedArtifactIds: [],
    expectedBaselineArtifactIds: [],
    affectedOutputKeys: []
  }).success, false);
  assert.equal(assessDesignImpactSchema.safeParse({
    mode: "skip",
    rationale: "本次后端修复没有需要设计的用户界面工作。",
    selectedArtifactIds: [crypto.randomUUID()],
    expectedBaselineArtifactIds: [],
    affectedOutputKeys: []
  }).success, true);
  assert.equal(assessDesignImpactSchema.safeParse({
    mode: "partial",
    rationale: "已有页面增加错误状态，需要局部更新设计规格。",
    selectedArtifactIds: [crypto.randomUUID()],
    expectedBaselineArtifactIds: baselineIds,
    affectedOutputKeys: []
  }).success, false);
  assert.equal(assessDesignImpactSchema.safeParse({
    mode: "full",
    rationale: "完整设计应走正常执行，不应被持久化成阶段处置。",
    selectedArtifactIds: [crypto.randomUUID()],
    expectedBaselineArtifactIds: [],
    affectedOutputKeys: []
  }).success, false);
  assert.equal(phaseResolutionSchema.safeParse({
    phaseId: "design",
    mode: "full",
    rationale: "完整执行的审计记录属于 execution，不属于 PhaseResolution。",
    inputArtifactIds: [crypto.randomUUID()],
    sourceRunId: null,
    sourceRunTitle: null,
    sourcePhaseRunId: null,
    sourceArtifactIds: [],
    affectedOutputKeys: [],
    routeVersion: PHASE_ROUTE_VERSION,
    decidedAt: new Date().toISOString()
  }).success, false);
  assert.equal(assessDesignImpactSchema.safeParse({
    mode: "skip",
    rationale: "设计跳过仍必须绑定当前 Run 的产品证据。",
    selectedArtifactIds: [],
    expectedBaselineArtifactIds: [],
    affectedOutputKeys: []
  }).success, false);
  const architectureWaiver = {
    mode: "skip",
    rationale: "本次修复只纠正实现缺陷，不改变系统边界或架构约束。",
    selectedArtifactIds: [crypto.randomUUID()],
    expectedBaselineArtifactIds: [],
    affectedOutputKeys: []
  } as const;
  assert.equal(assessArchitectureWaiverSchema.safeParse(architectureWaiver).success, true);
  assert.equal(assessArchitectureDispositionSchema.safeParse(architectureWaiver).success, true);
  assert.equal(assessArchitectureWaiverSchema.safeParse({
    mode: "skip",
    rationale: "不能在没有输入证据时直接跳过架构判断。",
    selectedArtifactIds: [],
    expectedBaselineArtifactIds: [],
    affectedOutputKeys: []
  }).success, false);
});

test("existing architecture impact maps to the generic phase resolution", () => {
  const impact = architectureImpactSchema.parse({
    mode: "partial",
    rationale: "接口契约局部变化，需要刷新架构索引和容器视图。",
    sourceRunId: crypto.randomUUID(),
    sourceRunTitle: "已批准架构",
    sourcePhaseRunId: crypto.randomUUID(),
    sourceArtifactIds: [crypto.randomUUID(), crypto.randomUUID()],
    inputArtifactIds: [crypto.randomUUID()],
    affectedOutputKeys: ["architecture", "architecture-c4-containers"],
    assessedAt: new Date().toISOString(),
    selection: {
      optionId: "A",
      reviewId: crypto.randomUUID(),
      optionsArtifactId: crypto.randomUUID(),
      selectedAt: new Date().toISOString()
    }
  });
  const resolution = architectureImpactToPhaseResolution(impact);
  assert.equal(resolution.phaseId, "architecture");
  assert.equal(resolution.mode, "partial");
  assert.equal(resolution.decidedAt, impact.assessedAt);
  assert.deepEqual(resolution.affectedOutputKeys, impact.affectedOutputKeys);
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
