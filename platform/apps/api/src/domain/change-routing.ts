import type {
  ChangeContractDto,
  PhaseId,
  PhaseResolutionDto,
  PhaseRunDto,
} from "@ai-sdlc/contracts";

import { AppError } from "./errors.js";

export const CHANGE_CONTRACT_ARTIFACT_KEY = "change-contract";

export function renderChangeContract(contract: ChangeContractDto): string {
  const section = (title: string, values: string[]) => [
    `## ${title}`,
    "",
    ...(values.length > 0 ? values.map((value) => `- ${value}`) : ["- 无"]),
    "",
  ];
  return [
    "# Change Contract",
    "",
    `- Work type: ${contract.workType}`,
    `- Summary: ${contract.summary}`,
    "",
    "## Current behavior",
    "",
    contract.currentBehavior,
    "",
    "## Expected behavior",
    "",
    contract.expectedBehavior,
    "",
    ...section("In scope", contract.inScope),
    ...section("Out of scope", contract.outOfScope),
    ...section("Acceptance criteria", contract.acceptanceCriteria),
    ...section("Regression scope", contract.regressionScope),
    ...section("Risk flags", contract.riskFlags),
    ...section("Evidence references", contract.evidenceRefs),
  ].join("\n").trimEnd() + "\n";
}

export function legacyChangeContract(title: string, objective: string): ChangeContractDto {
  return {
    workType: "feature",
    summary: title,
    currentBehavior: "Legacy intake did not record current behavior; PM/BA must verify it before approval.",
    expectedBehavior: objective,
    inScope: [objective],
    outOfScope: [],
    acceptanceCriteria: ["A human reviewer confirms the stated objective is met."],
    regressionScope: ["Existing behavior outside the stated objective must remain unchanged."],
    riskFlags: ["legacy-intake-incomplete"],
    evidenceRefs: ["workflow-run-objective"],
  };
}

export function validatePhaseResolutionExecution(
  resolution: PhaseResolutionDto | null | undefined,
  phaseId: PhaseId,
  selectedOutputKeys: string[],
  hasPriorResolutionExecution: boolean,
): void {
  if (!resolution || resolution.phaseId !== phaseId) return;
  if (["skip", "direct", "reuse"].includes(resolution.mode)) {
    throw new AppError(
      `阶段 ${phaseId} 已通过 ${resolution.mode} 处置，不允许运行 Codex`,
      409,
      "PHASE_RESOLUTION_IMMUTABLE",
      { phaseId, mode: resolution.mode },
    );
  }
  if (resolution.mode !== "partial") return;
  const allowed = new Set(resolution.affectedOutputKeys);
  const unexpected = selectedOutputKeys.filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new AppError(
      `本次局部执行超出处置范围：${unexpected.join(", ")}`,
      409,
      "PHASE_RESOLUTION_SCOPE_EXCEEDED",
      { phaseId, unexpected, affectedOutputKeys: resolution.affectedOutputKeys },
    );
  }
  if (
    !hasPriorResolutionExecution
    && !sameStringSet(selectedOutputKeys, resolution.affectedOutputKeys)
  ) {
    throw new AppError(
      "首次局部执行必须完整覆盖处置中声明的全部输出",
      409,
      "PHASE_RESOLUTION_OUTPUTS_INCOMPLETE",
      { phaseId, selectedOutputKeys, affectedOutputKeys: resolution.affectedOutputKeys },
    );
  }
}

export function validatePhaseResolutionArtifactMutation(
  resolution: PhaseResolutionDto | null | undefined,
  phaseId: PhaseId,
  artifactKey: string,
): void {
  if (!resolution || resolution.phaseId !== phaseId) return;
  if (["skip", "direct", "reuse"].includes(resolution.mode)) {
    throw new AppError(
      `阶段 ${phaseId} 的 ${resolution.mode} 处置是不可变快照`,
      409,
      "PHASE_RESOLUTION_IMMUTABLE",
      { phaseId, mode: resolution.mode, artifactKey },
    );
  }
  if (resolution.mode === "partial" && !resolution.affectedOutputKeys.includes(artifactKey)) {
    throw new AppError(
      `产物 ${artifactKey} 不在本次局部处置范围内`,
      409,
      "PHASE_RESOLUTION_SCOPE_EXCEEDED",
      { phaseId, artifactKey, affectedOutputKeys: resolution.affectedOutputKeys },
    );
  }
}

export function effectiveRequiredInputKeys(
  phaseId: PhaseId,
  configuredInputKeys: string[],
  phases: PhaseRunDto[],
  hasChangeContract = true,
  outputKeysByPhase: Partial<Record<PhaseId, string[]>> = {},
): string[] {
  const discovery = phases.find((phase) => phase.phaseId === "discovery");
  const design = phases.find((phase) => phase.phaseId === "design");
  const architecture = phases.find((phase) => phase.phaseId === "architecture");
  const productOutputs = new Set(
    outputKeysByPhase.discovery ?? ["prd", "user-stories"],
  );
  productOutputs.delete(CHANGE_CONTRACT_ARTIFACT_KEY);
  const designOutputs = new Set(
    outputKeysByPhase.design
      ?? ["design-baseline", "design-spec", "design-prototype", "figma-handoff"],
  );
  const architectureOutputs = new Set(
    outputKeysByPhase.architecture ?? [],
  );
  return configuredInputKeys.filter((key) => {
    // Runs created before Change Contract support remain executable. New Runs
    // always materialize this artifact, so only legacy rows take this branch.
    if (key === CHANGE_CONTRACT_ARTIFACT_KEY && !hasChangeContract) return false;
    if (productOutputs.has(key) && discovery?.resolution?.mode === "direct") {
      return false;
    }
    if (designOutputs.has(key) && design?.resolution?.mode === "skip") {
      return false;
    }
    if (
      (architectureOutputs.size > 0
        ? architectureOutputs.has(key)
        : key.startsWith("architecture"))
      && architecture?.resolution?.mode === "skip"
    ) {
      return false;
    }
    return true;
  });
}

export function phaseResolutionFor(
  phase: PhaseRunDto,
): PhaseResolutionDto | null | undefined {
  return phase.resolution;
}

function sameStringSet(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.length === rightSet.size && left.every((value) => rightSet.has(value));
}
