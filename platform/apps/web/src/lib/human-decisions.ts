import type {
  HumanDecisionItem,
  HumanDecisionPhaseId,
  PhaseHumanDecisionGate,
  PhaseStatus,
} from "@/lib/types";

export interface HumanDecisionPreset {
  label: string;
  description: string;
  value: string;
}

export function visibleHumanReviewComment(value: string): string {
  return value
    .replace(
      /<!--\s*ai-sdlc:human-decisions:v1\s*-->\s*```json[\s\S]*?```/giu,
      "",
    )
    .replace(
      /<!--\s*ai-sdlc:human-decisions:v1\s+[A-Za-z0-9_-]+\s*-->/gu,
      "",
    )
    .replace(
      "Human decisions captured; update the formal phase artifacts and remove only the blockers these answers actually resolve.",
      "已记录人工决定；请由当前角色更新正式产物，并只关闭这些答案实际解决的事项。",
    )
    .trim();
}

export const HUMAN_DECISION_PHASE_LABELS: Record<HumanDecisionPhaseId, string> = {
  discovery: "Product",
  design: "Design",
  architecture: "Architecture",
};

export const HUMAN_DECISION_ROLE_LABELS: Record<HumanDecisionPhaseId, string> = {
  discovery: "PM / BA",
  design: "Designer",
  architecture: "Architect",
};

export function humanDecisionKindLabel(item: HumanDecisionItem): string {
  if (item.kind === "decision") return item.blocking ? "需要你决定" : "开放问题 · 当前不阻塞";
  if (item.kind === "work") {
    if (item.id === "DESIGN-HANDOFF-INCOMPLETE") return "整理一次正式交接";
    if (item.id === "DESIGN-DEFERRED-VALIDATION-LOST") return "恢复遗漏的实现后验证";
    return item.blocking ? "角色需要补做" : "实现后验证 · 当前不阻塞";
  }
  if (item.kind === "dependency") {
    return `先处理 ${HUMAN_DECISION_PHASE_LABELS[item.actionPhaseId]}`;
  }
  return "通过即视为接受";
}

export function humanDecisionPresets(item: HumanDecisionItem): HumanDecisionPreset[] {
  if (item.id !== "ARCH-OBS-002") return [];
  return [
    {
      label: "本地最小诊断（推荐）",
      description: "适合当前纯前端、无既有监控平台的范围；只在浏览器开发者控制台留下可检索的技术错误事件。",
      value: "采用本地最小诊断：浏览器仅输出结构化技术错误事件，字段限定为 timestamp、severity、component、environment、version、eventCode 和非身份用途的 correlationId；用 eventCode 在开发者控制台检索。不远程上传，不记录儿童输入、答案、自由文本、凭据、秘密或其他敏感数据；由前端维护者负责，Tester 验证事件字段与脱敏。",
    },
    {
      label: "接入已有监控平台",
      description: "仅当团队已经有获批平台时选择；保存前请补齐平台名称与负责人。",
      value: "采用已有监控平台：平台名称=【请填写】；负责人=【请填写】；仅发送 timestamp、severity、component、environment、version、eventCode 和非身份用途的 correlationId；禁止儿童输入、答案、自由文本、凭据、秘密或其他敏感数据；Tester 验证字段、脱敏和可检索性。",
    },
  ];
}

export function humanDecisionGateHeadline(gate: PhaseHumanDecisionGate): string {
  if (gate.inconsistentApproval) return `已批准，但仍有 ${gate.blockingCount} 项未关闭`;
  const deferredCount = deferredHumanDecisionItems(gate).length;
  const blockingItems = gate.items.filter(({ blocking }) => blocking);
  if (isDeferredDesignHandoffCleanupGate(gate)) {
    return "只需整理 1 次正式交接 · 不重跑验证";
  }
  if (gate.decisionCount > 0) return `等待你完成 ${gate.decisionCount} 项决定`;
  if (gate.workCount > 0) return `等待角色补做 ${gate.workCount} 项工作`;
  if (gate.dependencyCount > 0) return `有 ${gate.dependencyCount} 项上游依赖`;
  if (deferredCount > 0) return `实现后验证 ${deferredCount} 项 · 当前不阻塞`;
  const openQuestionCount = nonBlockingHumanDecisionItems(gate).length;
  if (openQuestionCount > 0) return `开放问题 ${openQuestionCount} 项 · 当前不阻塞`;
  return "没有待决定事项";
}

export function actionableHumanDecisionItems(gate?: PhaseHumanDecisionGate) {
  return gate?.items.filter(
    (item) => item.blocking && item.actionPhaseId === gate.phaseId,
  ) ?? [];
}

export function dependentHumanDecisionItems(gate?: PhaseHumanDecisionGate) {
  return gate?.items.filter(
    (item) => item.blocking && item.actionPhaseId !== gate.phaseId,
  ) ?? [];
}

export function deferredHumanDecisionItems(gate?: PhaseHumanDecisionGate) {
  return gate?.items.filter(
    (item) => item.kind === "work" && !item.blocking,
  ) ?? [];
}

export function nonBlockingHumanDecisionItems(gate?: PhaseHumanDecisionGate) {
  return gate?.items.filter(
    (item) => item.kind === "decision" && !item.blocking,
  ) ?? [];
}

/**
 * A Session may safely rerun the current role without inventing a human
 * decision only when every remaining blocker is work owned by that same
 * phase. Decisions and upstream dependencies must continue to stop here.
 */
export function isCurrentRoleRepairGate(
  gate?: PhaseHumanDecisionGate,
): boolean {
  if (!gate || gate.blockingCount === 0) return false;
  const blockers = gate.items.filter(({ blocking }) => blocking);
  return blockers.length === gate.blockingCount
    && blockers.every((item) => (
      item.kind === "work" && item.actionPhaseId === gate.phaseId
    ));
}

export function isGenericHumanDecisionResponse(value: string): boolean {
  const compact = value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  return compact.length === 0
    || /^(?:(?:同意|确认|可以|好的|yes|agree|approved|ok))+$/iu.test(compact);
}

export function isDeferredDesignHandoffCleanupGate(
  gate?: PhaseHumanDecisionGate,
): boolean {
  if (gate?.phaseId !== "design" || deferredHumanDecisionItems(gate).length === 0) {
    return false;
  }
  const cleanupIds = new Set([
    "DESIGN-HANDOFF-INCOMPLETE",
    "DESIGN-DEFERRED-VALIDATION-INVALID",
    "DESIGN-DEFERRED-VALIDATION-LOST",
  ]);
  const blockers = gate.items.filter(({ blocking }) => blocking);
  return blockers.length > 0 && blockers.every(({ id }) => cleanupIds.has(id));
}

export function humanDecisionNextAction(
  phaseStatus: PhaseStatus,
  gate: PhaseHumanDecisionGate,
): "review" | "execute" | "select" {
  if (["changes_requested", "rejected", "failed"].includes(phaseStatus)) return "execute";
  if (
    phaseStatus === "ready"
    && (gate.dependencyCount > 0 || gate.workCount > 0)
  ) return "execute";
  if (["approved", "awaiting_review", "ready"].includes(phaseStatus)) return "review";
  return "select";
}
