import { PHASE_IDS, type PhaseId, type PhaseStatus } from "@ai-sdlc/contracts";

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

export function resolveOutputSelection(
  phaseId: PhaseId,
  availableOutputKeys: string[],
  requestedOutputKeys?: string[],
  existingOutputKeys: string[] = []
): string[] {
  const selected = requestedOutputKeys === undefined
    ? phaseId === "design"
      ? requiredDesignOutputs.filter((key) => availableOutputKeys.includes(key))
      : [...availableOutputKeys]
    : [...requestedOutputKeys];
  if (selected.length === 0) {
    throw new AppError("本次执行至少选择一个预期输出", 400, "MISSING_OUTPUT_SELECTION");
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
  const requiredOutputs = phaseId === "design"
    ? requiredDesignOutputs.filter((key) => availableOutputKeys.includes(key))
    : availableOutputKeys;
  const coveredKeys = new Set([...existingOutputKeys, ...selected]);
  const missing = requiredOutputs.filter((key) => !coveredKeys.has(key));
  if (missing.length > 0) {
    throw new AppError(
      phaseId === "design"
        ? `设计阶段首次执行必须生成后续阶段依赖的输出：${missing.join(", ")}`
        : `阶段 ${phaseId} 首次执行必须生成全部注册输出：${missing.join(", ")}`,
      400,
      phaseId === "design" ? "MISSING_REQUIRED_DESIGN_OUTPUTS" : "MISSING_REQUIRED_OUTPUTS",
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
