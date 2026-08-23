import {
  PHASE_IDS,
  type ArchitectureImpactDto,
  type PhaseId,
  type PhaseStatus,
} from "@ai-sdlc/contracts";

import { AppError } from "./errors.js";

const executableStatuses: PhaseStatus[] = [
  "ready",
  "awaiting_review",
  "approved",
  "changes_requested",
  "failed"
];

export function phasePosition(phaseId: PhaseId): number {
  return PHASE_IDS.indexOf(phaseId);
}

export function assertPhaseExecutable(status: PhaseStatus): void {
  if (!executableStatuses.includes(status)) {
    throw new AppError(
      `当前阶段状态 ${status} 不允许执行`,
      409,
      "PHASE_NOT_EXECUTABLE",
      { allowedStatuses: executableStatuses }
    );
  }
}

export function assertPhaseReviewable(status: PhaseStatus): void {
  if (status !== "awaiting_review") {
    throw new AppError("只有 awaiting_review 阶段可以人工审核", 409, "PHASE_NOT_REVIEWABLE");
  }
}

export function requiredSelectionKeys(phaseId: PhaseId, inputs: string[]): string[] {
  return phaseId === "discovery" ? [] : [...inputs];
}

const requiredDesignOutputs = ["design-baseline", "design-spec"];
export const requiredArchitectureBootstrapOutputs = [
  "architecture",
  "architecture-discovery-context",
  "architecture-options",
];
export const requiredArchitecturePostSelectionOutputs = [
  "architecture",
  "architecture-c4-context",
  "architecture-c4-containers",
  "architecture-adrs",
  "architecture-patterns",
  "architecture-nfrs",
  "architecture-adversarial",
];

export function validateArchitectureImpactOutputs(
  availableOutputKeys: string[],
  affectedOutputKeys: string[],
): void {
  if (new Set(affectedOutputKeys).size !== affectedOutputKeys.length) {
    throw new AppError(
      "局部架构更新的 affectedOutputKeys 不能重复",
      400,
      "DUPLICATE_ARCHITECTURE_IMPACT_OUTPUTS",
    );
  }
  const allowed = new Set(
    requiredArchitecturePostSelectionOutputs.filter((key) => availableOutputKeys.includes(key)),
  );
  const unexpected = affectedOutputKeys.filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new AppError(
      `局部架构更新包含不允许的产物：${unexpected.join(", ")}`,
      400,
      "INVALID_ARCHITECTURE_IMPACT_OUTPUTS",
      { unexpected },
    );
  }
  if (!affectedOutputKeys.includes("architecture")) {
    throw new AppError(
      "局部架构更新必须包含 architecture 索引",
      400,
      "ARCHITECTURE_IMPACT_INDEX_REQUIRED",
    );
  }
}

export function validateArchitecturePartialExecution(
  affectedOutputKeys: string[],
  selectedOutputKeys: string[],
  hasPriorImpactExecution: boolean,
): void {
  const affected = new Set(affectedOutputKeys);
  const unexpected = selectedOutputKeys.filter((key) => !affected.has(key));
  if (unexpected.length > 0) {
    throw new AppError(
      `本次局部架构执行超出 Impact Check 范围：${unexpected.join(", ")}`,
      409,
      "ARCHITECTURE_IMPACT_SCOPE_EXCEEDED",
      { unexpected, affectedOutputKeys },
    );
  }
  if (!selectedOutputKeys.includes("architecture")) {
    throw new AppError(
      "每次局部架构执行都必须同步刷新 architecture 索引",
      409,
      "ARCHITECTURE_IMPACT_INDEX_REQUIRED",
      { affectedOutputKeys, selectedOutputKeys },
    );
  }
  if (!hasPriorImpactExecution && !sameStringSet(affectedOutputKeys, selectedOutputKeys)) {
    throw new AppError(
      "首次局部架构执行必须完整覆盖 Impact Check 声明的产物",
      409,
      "ARCHITECTURE_IMPACT_OUTPUTS_INCOMPLETE",
      { affectedOutputKeys, selectedOutputKeys },
    );
  }
}

export function validateArchitectureImpactArtifactMutation(
  impact: ArchitectureImpactDto | null | undefined,
  artifactKey: string,
): void {
  if (!impact) return;
  if (impact.mode === "reuse") {
    throw new AppError(
      "已复用的架构基线是不可变快照；如需修改，请让上游变更使 Impact Check 失效后重新评估",
      409,
      "ARCHITECTURE_IMPACT_REUSE_IMMUTABLE",
      { artifactKey },
    );
  }
  if (impact.affectedOutputKeys.includes(artifactKey)) return;
  throw new AppError(
    `产物 ${artifactKey} 不在本次 Architecture Impact 局部更新范围内`,
    409,
    "ARCHITECTURE_IMPACT_SCOPE_EXCEEDED",
    { artifactKey, affectedOutputKeys: impact.affectedOutputKeys },
  );
}

export function validateArchitecturePartialInheritance(
  impact: ArchitectureImpactDto | null | undefined,
  availableOutputKeys: string[],
  artifacts: Array<{
    artifactKey: string;
    revision: number;
    parentArtifactId: string | null;
  }>,
): void {
  if (impact?.mode !== "partial") return;
  const affected = new Set(impact.affectedOutputKeys);
  const sourceArtifactIds = new Set(impact.sourceArtifactIds);
  const currentByKey = new Map(artifacts.map((artifact) => [artifact.artifactKey, artifact]));
  const diverged = availableOutputKeys
    .filter((artifactKey) => !affected.has(artifactKey))
    .filter((artifactKey) => {
      const artifact = currentByKey.get(artifactKey);
      return !artifact
        || artifact.revision !== 1
        || !artifact.parentArtifactId
        || !sourceArtifactIds.has(artifact.parentArtifactId);
    });
  if (diverged.length > 0) {
    throw new AppError(
      `未声明受影响的架构产物已偏离继承基线：${diverged.join(", ")}`,
      409,
      "ARCHITECTURE_IMPACT_BASELINE_DIVERGED",
      { diverged, affectedOutputKeys: impact.affectedOutputKeys },
    );
  }
}

export interface OutputSelectionContext {
  architectureSelectionRecorded?: boolean;
}

export interface ArchitectureSelectionEvidence {
  optionId: string;
  reviewId: string;
  optionsArtifactId: string;
  selectedAt: string;
}

export interface ArchitectureSelectionReviewLike {
  id: string;
  decision: string;
  comment: string;
  artifactIds: string[];
  createdAt: string;
}

const architectureSelectionPattern = /^\s*(?:Selected option|选择方案|选定方案)\s*[:：]\s*(?:Option\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,159})\s*$/gimu;
const anyArchitectureSelectionMarkerPattern = /^\s*(?:Selected option|选择方案|选定方案)\s*[:：]\s*(?:Option\s+)?[A-Za-z0-9][A-Za-z0-9._-]*\s*$/gimu;
const architectureOptionHeadingPattern = /^#{2,3}\s+Option\s+([A-Za-z0-9][A-Za-z0-9._-]{0,159})\s*(?::|：|—|–|\s-\s)/gimu;

export function hasArchitectureSelectionMarker(comment: string): boolean {
  anyArchitectureSelectionMarkerPattern.lastIndex = 0;
  return [...comment.matchAll(anyArchitectureSelectionMarkerPattern)].length > 0;
}

export function parseArchitectureSelectionId(comment: string): string | undefined {
  architectureSelectionPattern.lastIndex = 0;
  const matches = [...comment.matchAll(architectureSelectionPattern)];
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

export function architectureOptionIds(content: string): string[] {
  architectureOptionHeadingPattern.lastIndex = 0;
  return [...content.matchAll(architectureOptionHeadingPattern)].map((match) => match[1]!);
}

export function validateArchitectureSelectionComment(
  comment: string,
  optionsContent: string,
): string | undefined {
  const selected = parseArchitectureSelectionId(comment);
  if (!selected) return undefined;
  const documented = architectureOptionIds(optionsContent);
  const matching = documented.filter(
    (optionId) => optionId.toLocaleLowerCase("en-US") === selected.toLocaleLowerCase("en-US"),
  );
  if (matching.length !== 1) {
    throw new AppError(
      matching.length === 0
        ? `架构选型 ${selected} 不在当前 options 文档中`
        : `架构选型 ${selected} 在当前 options 文档中不唯一`,
      400,
      matching.length === 0
        ? "ARCHITECTURE_OPTION_NOT_FOUND"
        : "ARCHITECTURE_OPTION_AMBIGUOUS",
      { selected, documented },
    );
  }
  return matching[0];
}

export function findArchitectureSelectionEvidence(
  optionsArtifactId: string,
  optionsContent: string,
  reviews: ArchitectureSelectionReviewLike[],
  requiredReviewedArtifactIds: string[] = [optionsArtifactId],
): ArchitectureSelectionEvidence | undefined {
  const documented = architectureOptionIds(optionsContent);
  const ordered = [...reviews].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const review of ordered) {
    if (
      review.decision !== "request_changes"
      || !requiredReviewedArtifactIds.every((artifactId) => review.artifactIds.includes(artifactId))
    ) continue;
    const selected = parseArchitectureSelectionId(review.comment);
    if (!selected) continue;
    const matching = documented.filter(
      (candidate) => candidate.toLocaleLowerCase("en-US")
        === selected.toLocaleLowerCase("en-US"),
    );
    if (matching.length !== 1 || !Number.isFinite(Date.parse(review.createdAt))) continue;
    return {
      optionId: matching[0]!,
      reviewId: review.id,
      optionsArtifactId,
      selectedAt: review.createdAt,
    };
  }
  return undefined;
}

export function hasCompleteArchitectureBootstrap(
  availableOutputKeys: string[],
  existingOutputKeys: string[],
): boolean {
  const existing = new Set(existingOutputKeys);
  return requiredArchitectureBootstrapOutputs
    .filter((key) => availableOutputKeys.includes(key))
    .every((key) => existing.has(key));
}

export function requiredApprovalOutputKeys(
  phaseId: PhaseId,
  availableOutputKeys: string[],
): string[] {
  return phaseId === "design"
    ? requiredDesignOutputs.filter((key) => availableOutputKeys.includes(key))
    : [...availableOutputKeys];
}

function defaultExecutionOutputKeys(
  phaseId: PhaseId,
  availableOutputKeys: string[],
  existingOutputKeys: string[],
  context: OutputSelectionContext,
): string[] {
  if (phaseId === "discovery") {
    return availableOutputKeys.filter((key) => key !== "change-contract");
  }
  if (phaseId === "design") {
    return requiredDesignOutputs.filter((key) => availableOutputKeys.includes(key));
  }
  if (phaseId === "architecture") {
    const bootstrap = requiredArchitectureBootstrapOutputs.filter((key) =>
      availableOutputKeys.includes(key)
    );
    const existing = new Set(existingOutputKeys);
    if (!hasCompleteArchitectureBootstrap(availableOutputKeys, existingOutputKeys)) {
      return bootstrap.filter((key) => !existing.has(key));
    }
    if (!context.architectureSelectionRecorded) return bootstrap;
    return requiredArchitecturePostSelectionOutputs.filter((key) =>
      availableOutputKeys.includes(key)
    );
  }
  return [...availableOutputKeys];
}

function requiredExecutionOutputKeys(
  phaseId: PhaseId,
  availableOutputKeys: string[],
  existingOutputKeys: string[],
  selectedOutputKeys: string[],
  context: OutputSelectionContext,
): string[] {
  if (phaseId === "design") {
    return requiredDesignOutputs.filter((key) => availableOutputKeys.includes(key));
  }
  if (phaseId === "architecture") {
    const bootstrap = requiredArchitectureBootstrapOutputs.filter((key) =>
      availableOutputKeys.includes(key)
    );
    const existing = new Set(existingOutputKeys);
    const selected = new Set(selectedOutputKeys);
    const coversBootstrap = bootstrap.every((key) => existing.has(key) || selected.has(key));
    if (!coversBootstrap) return bootstrap;
    const selectsSelectedState = selectedOutputKeys.some((key) => !bootstrap.includes(key));
    if (selectsSelectedState && !context.architectureSelectionRecorded) {
      throw new AppError(
        "架构选型后产物必须先由人工通过结构化审核意见选定一个已记录的 Option",
        409,
        "ARCHITECTURE_SELECTION_REQUIRED",
      );
    }
    if (!context.architectureSelectionRecorded) return bootstrap;
    if (selectedOutputKeys.every((key) => existing.has(key))) return bootstrap;
  }
  return [...availableOutputKeys];
}

export function resolveOutputSelection(
  phaseId: PhaseId,
  availableOutputKeys: string[],
  requestedOutputKeys?: string[],
  existingOutputKeys: string[] = [],
  context: OutputSelectionContext = {},
): string[] {
  const defaultOutputs = defaultExecutionOutputKeys(
    phaseId,
    availableOutputKeys,
    existingOutputKeys,
    context,
  );
  const selected = requestedOutputKeys === undefined
    ? defaultOutputs
    : [...requestedOutputKeys];
  if (selected.length === 0) {
    throw new AppError("本次执行至少选择一个预期输出", 400, "MISSING_OUTPUT_SELECTION");
  }
  if (phaseId === "discovery" && selected.includes("change-contract")) {
    throw new AppError(
      "Change Contract 是 Run 创建时确认的不可变输入，PM/BA 不能重写",
      409,
      "CHANGE_CONTRACT_IMMUTABLE",
    );
  }
  if (new Set(selected).size !== selected.length) {
    throw new AppError("selectedOutputKeys 不能重复", 400, "DUPLICATE_OUTPUT_SELECTION");
  }
  const available = new Set(availableOutputKeys);
  const unexpected = selected.filter((key) => !available.has(key));
  if (unexpected.length > 0) {
    throw new AppError(
      `包含当前阶段未注册的输出：${unexpected.join(", ")}`,
      400,
      "INVALID_OUTPUT_SELECTION",
      { unexpected }
    );
  }
  const requiredOutputs = requiredExecutionOutputKeys(
    phaseId,
    availableOutputKeys,
    existingOutputKeys,
    selected,
    context,
  );
  const coveredKeys = new Set([...existingOutputKeys, ...selected]);
  const missing = requiredOutputs.filter((key) => !coveredKeys.has(key));
  if (missing.length > 0) {
    const isArchitectureBootstrap = phaseId === "architecture"
      && !hasCompleteArchitectureBootstrap(availableOutputKeys, existingOutputKeys);
    throw new AppError(
      phaseId === "design"
        ? `设计阶段首次执行必须生成后续阶段依赖的输出：${missing.join(", ")}`
        : isArchitectureBootstrap
          ? `架构阶段首次执行必须生成选型检查点输出：${missing.join(", ")}`
          : existingOutputKeys.length === 0
            ? `阶段 ${phaseId} 首次执行必须生成全部注册输出：${missing.join(", ")}`
            : `阶段 ${phaseId} 尚未覆盖全部注册输出：${missing.join(", ")}`,
      400,
      phaseId === "design"
        ? "MISSING_REQUIRED_DESIGN_OUTPUTS"
        : isArchitectureBootstrap
          ? "MISSING_REQUIRED_ARCHITECTURE_BOOTSTRAP_OUTPUTS"
          : "MISSING_REQUIRED_OUTPUTS",
      { missing }
    );
  }
  return selected;
}

export function validateArtifactSelection(
  phaseId: PhaseId,
  requiredKeys: string[],
  selected: Array<{
    id: string;
    artifactKey: string;
    sourcePosition: number;
    sourceStatus: PhaseStatus;
    reviewStatus: "pending" | "approved" | "changes_requested" | "superseded";
  }>
): void {
  if (phaseId === "discovery" && selected.length > 0) {
    throw new AppError("discovery 阶段不能选择上游产物", 400, "INVALID_ARTIFACT_SELECTION");
  }

  const currentPosition = phasePosition(phaseId);
  for (const artifact of selected) {
    if (
      artifact.sourcePosition >= currentPosition
      || artifact.sourceStatus !== "approved"
      || artifact.reviewStatus !== "approved"
    ) {
      throw new AppError(
        "只能选择当前 run 中已经人工批准的上游产物",
        409,
        "UNAPPROVED_ARTIFACT",
        { artifactId: artifact.id }
      );
    }
    if (!requiredKeys.includes(artifact.artifactKey)) {
      throw new AppError(
        `产物 ${artifact.artifactKey} 不是 ${phaseId} 阶段的输入`,
        400,
        "UNEXPECTED_ARTIFACT"
      );
    }
  }

  const selectedKeys = new Set(selected.map((artifact) => artifact.artifactKey));
  if (selectedKeys.size !== selected.length) {
    throw new AppError(
      "每种输入产物只能选择一个已批准版本",
      400,
      "DUPLICATE_ARTIFACT_KEY"
    );
  }
  const missing = requiredKeys.filter((key) => !selectedKeys.has(key));
  if (missing.length > 0) {
    throw new AppError(
      `缺少已批准的必需输入：${missing.join(", ")}`,
      409,
      "MISSING_ARTIFACTS",
      { missing }
    );
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size
    && [...leftSet].every((value) => rightSet.has(value));
}
