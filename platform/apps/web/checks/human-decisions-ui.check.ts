import assert from "node:assert/strict";
import test from "node:test";

import {
  actionableHumanDecisionItems,
  dependentHumanDecisionItems,
  humanDecisionGateHeadline,
  humanDecisionKindLabel,
  humanDecisionNextAction,
  isGenericHumanDecisionResponse,
  isCurrentRoleRepairGate,
  isDeferredDesignHandoffCleanupGate,
  humanDecisionPresets,
  visibleHumanReviewComment,
} from "../src/lib/human-decisions.js";
import type { PhaseHumanDecisionGate } from "../src/lib/types.js";
import { readRunUiSource } from "./support/run-ui-source.ts";

function gate(overrides: Partial<PhaseHumanDecisionGate> = {}): PhaseHumanDecisionGate {
  return {
    phaseId: "design",
    roleId: "designer",
    state: "awaiting_role_work",
    items: [
      {
        id: "B-01",
        phaseId: "design",
        actionPhaseId: "discovery",
        artifactKey: "design-spec",
        kind: "dependency",
        title: "Confirm product rules",
        prompt: "Confirm the final product rules.",
        owner: "Human product owner",
        nextAction: "Update PRD.",
        blocking: true,
        response: null,
      },
      {
        id: "B-04",
        phaseId: "design",
        actionPhaseId: "design",
        artifactKey: "design-spec",
        kind: "work",
        title: "Validate responsive behavior",
        prompt: "Validate 320px and accessibility.",
        owner: "Designer",
        nextAction: "Attach rendered evidence.",
        blocking: true,
        response: null,
      },
    ],
    blockingCount: 2,
    decisionCount: 0,
    workCount: 1,
    dependencyCount: 1,
    inconsistentApproval: false,
    ...overrides,
  };
}

test("AC-CLARITY-014/016: the UI separates decisions, role work, and upstream dependencies", () => {
  const current = gate();
  assert.deepEqual(actionableHumanDecisionItems(current).map(({ id }) => id), ["B-04"]);
  assert.deepEqual(dependentHumanDecisionItems(current).map(({ id }) => id), ["B-01"]);
  assert.equal(humanDecisionKindLabel(current.items[0]!), "先处理 Product");
  assert.equal(humanDecisionKindLabel(current.items[1]!), "角色需要补做");
  assert.match(humanDecisionGateHeadline(current), /角色补做 1 项/u);
});

test("AC-CLARITY-019: deferred B-04 is shown as post-implementation and never reruns Designer", async () => {
  const deferredItem = {
    ...gate().items[1]!,
    title: "实现后验证响应式与可访问性",
    prompt: "实现可运行且浏览器环境可用后验证 320px 布局与键盘操作。",
    nextAction: "实现完成后执行浏览器验证；当前不阻塞 Design 审批。",
    blocking: false,
  };
  const deferred = gate({
    state: "clear",
    items: [deferredItem],
    blockingCount: 0,
    decisionCount: 0,
    workCount: 0,
    dependencyCount: 0,
  });

  assert.deepEqual(actionableHumanDecisionItems(deferred), []);
  assert.match(humanDecisionKindLabel(deferredItem), /实现后验证.*当前不阻塞/u);
  assert.match(humanDecisionGateHeadline(deferred), /实现后验证.*当前不阻塞/u);
  assert.equal(humanDecisionNextAction("awaiting_review", deferred), "review");
  assert.notEqual(humanDecisionNextAction("awaiting_review", deferred), "execute");

  const source = await readRunUiSource();
  assert.match(source, /实现后验证/u);
  assert.match(source, /当前不阻塞/u);
});

test("AC-DES-LOOP-004: a legacy B-04 plus formal cleanup blockers gets the one-time handoff CTA", async () => {
  const deferredItem = {
    ...gate().items[1]!,
    owner: "Tester",
    nextAction: "实现完成后由 Tester 执行浏览器验证。",
    blocking: false,
  };
  const cleanup = gate({
    items: [
      deferredItem,
      {
        ...gate().items[1]!,
        id: "DESIGN-DEFERRED-VALIDATION-LOST",
        title: "恢复 B-04 正式交接",
        blocking: true,
      },
    ],
    blockingCount: 1,
    workCount: 1,
    dependencyCount: 0,
  });
  assert.equal(isDeferredDesignHandoffCleanupGate(cleanup), true);
  assert.match(humanDecisionGateHeadline(cleanup), /整理 1 次正式交接.*不重跑验证/u);
  assert.match(humanDecisionKindLabel(cleanup.items[1]!), /恢复遗漏的实现后验证/u);

  const realBlocker = gate({
    items: [deferredItem, { ...gate().items[1]!, id: "DESIGN-BEHAVIOR-MISSING", blocking: true }],
    blockingCount: 1,
    workCount: 1,
    dependencyCount: 0,
  });
  assert.equal(isDeferredDesignHandoffCleanupGate(realBlocker), false);

  const source = await readRunUiSource();
  assert.match(source, /整理实现后验证交接/u);
  assert.match(source, /整理交接并进入审核/u);
});

test("AC-CLARITY-018: legacy approved blockers are described as an inconsistency", () => {
  const current = gate({
    state: "inconsistent_approval",
    inconsistentApproval: true,
  });
  assert.match(humanDecisionGateHeadline(current), /已批准.*仍有 2 项未关闭/u);
});

test("AC-CLARITY-017: the next action asks only for real decisions and reruns stale role work", () => {
  const design = gate();
  const product = gate({
    phaseId: "discovery",
    roleId: "pm-ba",
    state: "awaiting_decision",
    items: [{
      ...gate().items[0]!,
      id: "PROD-Q-01",
      phaseId: "discovery",
      actionPhaseId: "discovery",
      kind: "decision",
    }],
    blockingCount: 1,
    decisionCount: 1,
    workCount: 0,
    dependencyCount: 0,
  });
  assert.equal(humanDecisionNextAction("ready", design), "execute");
  assert.equal(humanDecisionNextAction("ready", product), "review");
  assert.equal(humanDecisionNextAction("approved", product), "review");
  assert.equal(humanDecisionNextAction("changes_requested", product), "execute");
  assert.equal(humanDecisionNextAction("pending", design), "select");
});

test("Session rerun is limited to blocking work owned by the current role", () => {
  const repair = gate({
    items: [{
      ...gate().items[1]!,
      actionPhaseId: "design",
      kind: "work",
      blocking: true,
    }],
    blockingCount: 1,
    decisionCount: 0,
    workCount: 1,
    dependencyCount: 0,
  });
  assert.equal(isCurrentRoleRepairGate(repair), true);
  assert.equal(isCurrentRoleRepairGate(gate()), false, "an upstream dependency cannot auto-rerun");
});

test("decision input rejects acknowledgement-only text but keeps concrete choices", async () => {
  for (const response of ["同意同意同意", "yes, OK!!!", "Approved approved"]) {
    assert.equal(isGenericHumanDecisionResponse(response), true, response);
  }
  assert.equal(
    isGenericHumanDecisionResponse("同意使用红色主题，layout 可以调整。"),
    false,
  );

  const source = await readRunUiSource();
  assert.match(source, /只写“同意、确认、可以、好的、yes、agree、approved、ok”无法让角色更新正式产物/u);
});

test("decision audit comments keep readable answers but hide transport markers", () => {
  const encoded = visibleHumanReviewComment([
    "Human decisions captured; update the formal phase artifacts and remove only the blockers these answers actually resolve.",
    "",
    "- PRODUCT-QUESTION-V2-abc: Use cards.",
    "",
    "<!-- ai-sdlc:human-decisions:v1 eyJzY2hlbWFWZXJzaW9uIjoxfQ -->",
  ].join("\n"));
  assert.match(encoded, /已记录人工决定/u);
  assert.match(encoded, /Use cards/u);
  assert.doesNotMatch(encoded, /ai-sdlc:human-decisions|eyJzY2hlbWFWZXJzaW9u/u);

  const legacy = visibleHumanReviewComment([
    "Legacy readable decision.",
    "<!-- ai-sdlc:human-decisions:v1 -->",
    "```json",
    '{"schemaVersion":1,"phaseId":"discovery","responses":[]}',
    "```",
  ].join("\n"));
  assert.equal(legacy, "Legacy readable decision.");
});

test("AC-CLARITY-014/017: Run page exposes one decision inbox and a save-rerun handoff", async () => {
  const source = await readRunUiSource();
  assert.match(source, /决定与待办/u);
  assert.match(source, /这里才是你需要处理的入口/u);
  assert.match(source, /通过状态不一致|已显示为“通过”/u);
  assert.match(source, /应回到上游处理/u);
  assert.match(source, /在本阶段处理/u);
  assert.match(source, /一次保存 \$\{requiredDecisionItems\.length\} 项决定，返回 Session 继续/u);
  assert.match(source, /下一步在后台 Run 卡片点击/u);
  assert.match(source, /const responses = requiredDecisionItems\.map/u);
  assert.match(source, /让 \$\{HUMAN_DECISION_ROLE_LABELS\[decisionGate\.phaseId\]\} 补做并重跑/u);
  assert.match(source, /返回原 Session[\s\S]{0,240}沿用已选 Provider 和同一个 Run，不会另行调用 Codex 或新建 Run/u);
  assert.match(source, /api\.captureHumanDecisions/u);
  assert.match(source, /PHASE_HUMAN_DECISIONS_REQUIRED/u);
});

test("AC-ARCH-LOOP-001/004/005: OBS-002 and option selection use concrete one-click actions", async () => {
  const observability = {
    ...gate().items[1]!,
    id: "ARCH-OBS-002",
    phaseId: "architecture" as const,
    actionPhaseId: "architecture" as const,
    kind: "decision" as const,
    title: "浏览器错误信息写到哪里？",
    prompt: "请选择本地最小诊断或已有监控平台。",
    owner: "Human architecture / operations owner",
  };
  const presets = humanDecisionPresets(observability);
  assert.equal(presets.length, 2);
  assert.match(presets[0]?.label ?? "", /本地最小诊断.*推荐/u);
  assert.match(presets[0]?.value ?? "", /不远程上传.*不记录儿童输入/u);
  assert.match(presets[1]?.label ?? "", /已有监控平台/u);

  const source = await readRunUiSource();
  assert.match(source, /先做决定，再选方案/u);
  assert.match(source, /选择 Option \{option\.id\}/u);
  assert.match(source, /选方案不是批准架构/u);
  assert.match(source, /onDecisionSaved\("architecture"\)/u);
  assert.match(source, /decisionGate\.blockingCount > 0/u);
});
