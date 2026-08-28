import type { ChangeContract, WorkItemProvenance, WorkType } from "@/lib/types";

export const WORK_TYPE_OPTIONS: ReadonlyArray<{
  value: WorkType;
  label: string;
  description: string;
}> = [
  {
    value: "feature",
    label: "新功能",
    description: "新增用户能力或业务结果。",
  },
  {
    value: "change",
    label: "局部变更",
    description: "调整已有流程、规则或体验。",
  },
  {
    value: "bug",
    label: "功能缺陷",
    description: "实际行为偏离已经确认的预期。",
  },
  {
    value: "technical",
    label: "技术变更",
    description: "重构、依赖升级或不改变产品行为的工程工作。",
  },
];

export interface ChangeContractDraft {
  workType: WorkType;
  sourceRunIds: string[];
  workItem?: WorkItemProvenance;
  summary: string;
  currentBehavior: string;
  expectedBehavior: string;
  inScope: string;
  outOfScope: string;
  acceptanceCriteria: string;
  regressionScope: string;
  riskFlags: string;
  evidenceRefs: string;
}

export const EMPTY_CHANGE_CONTRACT_DRAFT: ChangeContractDraft = {
  workType: "feature",
  sourceRunIds: [],
  summary: "",
  currentBehavior: "",
  expectedBehavior: "",
  inScope: "",
  outOfScope: "",
  acceptanceCriteria: "",
  regressionScope: "",
  riskFlags: "",
  evidenceRefs: "",
};

export function isLinkedWorkType(
  workType: WorkType,
): workType is Exclude<WorkType, "feature"> {
  return workType !== "feature";
}

export function linkedChangeMissingFields(draft: ChangeContractDraft): string[] {
  const missing: string[] = [];
  if (draft.sourceRunIds.length === 0) missing.push("原始任务");
  if (draft.sourceRunIds.length > 20) missing.push("原始任务（最多 20 个）");
  if (!draft.expectedBehavior.trim()) missing.push("期望行为");
  return missing;
}

export function parseChangeContractLines(value: string): string[] {
  return [...new Set(
    value
      .split(/\r?\n/u)
      .map((item) => item.trim().replace(/^[-*]\s+/u, ""))
      .filter(Boolean),
  )];
}

export function materializeChangeContract(draft: ChangeContractDraft): ChangeContract {
  return {
    workType: draft.workType,
    ...(draft.workType !== "feature" && draft.sourceRunIds.length > 0
      ? { sourceRunIds: [...draft.sourceRunIds] }
      : {}),
    ...(draft.workItem ? { workItem: draft.workItem } : {}),
    summary: draft.summary.trim(),
    currentBehavior: draft.currentBehavior.trim(),
    expectedBehavior: draft.expectedBehavior.trim(),
    inScope: parseChangeContractLines(draft.inScope),
    outOfScope: parseChangeContractLines(draft.outOfScope),
    acceptanceCriteria: parseChangeContractLines(draft.acceptanceCriteria),
    regressionScope: parseChangeContractLines(draft.regressionScope),
    riskFlags: parseChangeContractLines(draft.riskFlags),
    evidenceRefs: parseChangeContractLines(draft.evidenceRefs),
  };
}

export function changeContractMissingFields(contract: ChangeContract): string[] {
  const missing: string[] = [];
  if (!contract.summary) missing.push("变更摘要");
  if (!contract.currentBehavior) missing.push("当前行为");
  if (!contract.expectedBehavior) missing.push("期望行为");
  if (contract.inScope.length === 0) missing.push("范围内事项");
  if (contract.acceptanceCriteria.length === 0) missing.push("验收标准");
  if (contract.regressionScope.length === 0) missing.push("回归范围");
  return missing;
}

export function changeContractObjective(contract: ChangeContract): string {
  return contract.summary;
}
