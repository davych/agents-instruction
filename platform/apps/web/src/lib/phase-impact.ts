import type {
  DesignResolutionMode,
  DiscoveryResolutionMode,
  PhaseBaseline,
  PhaseRun,
  PhaseResolution,
  WorkType,
} from "@/lib/types";

export type RoutedImpactPhaseId = "discovery" | "design";
export type RoutedImpactChoice = DiscoveryResolutionMode | DesignResolutionMode;

export interface ImpactChoiceOption {
  value: RoutedImpactChoice;
  title: string;
  description: string;
  requiresBaseline: boolean;
}

const PRODUCT_IMPACT_OPTIONS: ReadonlyArray<ImpactChoiceOption> = [
  {
    value: "direct",
    title: "直接采用合同",
    description: "Change Contract 已足够明确，不运行 PM / BA，由平台留痕后继续。",
    requiresBaseline: false,
  },
  {
    value: "reuse",
    title: "复用产品基线",
    description: "继承已批准 PRD 与故事，不生成新产品产物。",
    requiresBaseline: true,
  },
  {
    value: "partial",
    title: "局部需求更新",
    description: "继承产品基线，只更新明确受影响的 PRD 或用户故事。",
    requiresBaseline: true,
  },
  {
    value: "full",
    title: "完整需求发现",
    description: "运行 PM / BA，重新建立本次产品范围与验收合同。",
    requiresBaseline: false,
  },
];

const DESIGN_IMPACT_OPTIONS: ReadonlyArray<ImpactChoiceOption> = [
  {
    value: "skip",
    title: "无需设计工作",
    description: "没有界面或交互变化，记录理由后跳过 Designer。",
    requiresBaseline: false,
  },
  {
    value: "reuse",
    title: "复用现有设计",
    description: "本次行为已被批准设计覆盖，继承设计基线且不运行 Designer。",
    requiresBaseline: true,
  },
  {
    value: "partial",
    title: "局部设计更新",
    description: "保留现有设计方向，只更新受影响的设计输出。",
    requiresBaseline: true,
  },
  {
    value: "full",
    title: "完整设计",
    description: "运行 Designer，重新完成本次任务的设计交付。",
    requiresBaseline: false,
  },
];

export function impactOptionsForPhase(
  phaseId: RoutedImpactPhaseId,
): ReadonlyArray<ImpactChoiceOption> {
  return phaseId === "discovery" ? PRODUCT_IMPACT_OPTIONS : DESIGN_IMPACT_OPTIONS;
}

export function phaseImpactTitle(phaseId: RoutedImpactPhaseId): string {
  return phaseId === "discovery" ? "Product Impact Check" : "Design Impact Check";
}

export function phaseImpactActionLabel(phaseId: RoutedImpactPhaseId): string {
  return phaseId === "discovery" ? "检查产品影响" : "检查设计影响";
}

export function defaultRoutedPartialOutputKeys(
  phaseId: RoutedImpactPhaseId,
  availableOutputKeys: string[],
): string[] {
  const defaults = phaseId === "design"
    ? new Set(["design-spec"])
    : new Set(["prd", "user-stories"]);
  return availableOutputKeys.filter((key) => defaults.has(key));
}

export function impactChoiceRequiresBaseline(
  phaseId: RoutedImpactPhaseId,
  choice: RoutedImpactChoice,
): boolean {
  return impactOptionsForPhase(phaseId).some(
    (option) => option.value === choice && option.requiresBaseline,
  );
}

export function isRoutedImpactChoice(
  phaseId: RoutedImpactPhaseId,
  choice: string,
): choice is RoutedImpactChoice {
  return impactOptionsForPhase(phaseId).some((option) => option.value === choice);
}

export function shouldSubmitRoutedImpactAssessment(
  choice: RoutedImpactChoice | "",
): boolean {
  return Boolean(choice && choice !== "full");
}

export function isProductDirectAllowed(
  hasChangeContract: boolean,
  workType?: WorkType,
  hasEvidenceRefs = false,
): boolean {
  return hasChangeContract
    && hasEvidenceRefs
    && (workType === "bug" || workType === "technical");
}

export function isFirstPhaseImpactAttempt(
  phase: Pick<PhaseRun, "artifacts" | "executions" | "reviews">,
): boolean {
  const hasBusinessArtifact = phase.artifacts.some((artifact) => {
    const key = artifact.artifactKey
      || artifact.artifactId
      || artifact.type
      || artifact.name
      || artifact.id;
    return key !== "change-contract";
  });
  return !hasBusinessArtifact
    && phase.executions.length === 0
    && phase.reviews.length === 0;
}

export function isImpactAssessmentComplete({
  phaseId,
  choice,
  rationale,
  baseline,
  affectedOutputKeys,
  hasAllRequiredInputs,
}: {
  phaseId: RoutedImpactPhaseId;
  choice: string;
  rationale: string;
  baseline?: PhaseBaseline | null;
  affectedOutputKeys: string[];
  hasAllRequiredInputs: boolean;
}): boolean {
  if (!isRoutedImpactChoice(phaseId, choice)) return false;
  if (rationale.trim().length < 10) return false;
  if (phaseId === "design" && !hasAllRequiredInputs) return false;
  if (impactChoiceRequiresBaseline(phaseId, choice) && !baseline) return false;
  if (choice !== "partial") return true;
  if (affectedOutputKeys.length === 0) return false;
  return phaseId !== "design" || affectedOutputKeys.includes("design-spec");
}

export function resolutionModeLabel(resolution: PhaseResolution): string {
  const labels: Record<string, string> = {
    direct: "直接采用合同",
    skip: "无需本阶段工作",
    reuse: "复用已批准基线",
    partial: "局部更新",
    full: "完整执行",
  };
  return labels[resolution.mode] ?? resolution.mode;
}

export function resolutionIsReadOnly(resolution?: PhaseResolution | null): boolean {
  return resolution?.mode === "direct"
    || resolution?.mode === "skip"
    || resolution?.mode === "reuse";
}

export function isResolutionOutputMutable(
  resolution: PhaseResolution | null | undefined,
  outputKey: string,
): boolean {
  if (!resolution) return true;
  if (resolutionIsReadOnly(resolution)) return false;
  if (resolution.mode === "partial") {
    return resolution.affectedOutputKeys.includes(outputKey);
  }
  return true;
}

/**
 * Mirrors the API's route-aware input contract so a recorded direct/skip
 * decision does not leave later phases blocked by outputs that intentionally
 * do not exist. The immutable Change Contract is never waived.
 */
export function effectiveRequiredInputKeys(
  configuredInputKeys: string[],
  phases: ReadonlyArray<Pick<PhaseRun, "phaseId" | "resolution">>,
  options: {
    hasChangeContract?: boolean;
    outputKeysByPhase?: Partial<Record<string, string[]>>;
  } = {},
): string[] {
  const discovery = phases.find((phase) => phase.phaseId === "discovery");
  const design = phases.find((phase) => phase.phaseId === "design");
  const architecture = phases.find((phase) => phase.phaseId === "architecture");
  const productOutputs = new Set(
    options.outputKeysByPhase?.discovery ?? ["prd", "user-stories"],
  );
  productOutputs.delete("change-contract");
  const designOutputs = new Set(
    options.outputKeysByPhase?.design
      ?? ["design-baseline", "design-spec", "design-prototype", "figma-handoff"],
  );
  const architectureOutputs = new Set(options.outputKeysByPhase?.architecture ?? []);

  return configuredInputKeys.filter((key) => {
    if (key === "change-contract" && options.hasChangeContract === false) return false;
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
