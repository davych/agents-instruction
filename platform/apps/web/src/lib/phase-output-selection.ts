const REQUIRED_DESIGN_OUTPUT_KEYS = ["design-baseline", "design-spec"] as const;

export interface PhaseOutputSelectionContext {
  phaseId: string;
  availableOutputKeys: string[];
  hasExistingArtifacts: boolean;
  initialOutputKeys?: string[];
}

export function initialPhaseOutputKeys({
  phaseId,
  availableOutputKeys,
  hasExistingArtifacts,
  initialOutputKeys,
}: PhaseOutputSelectionContext): string[] {
  const available = new Set(availableOutputKeys);
  const requested = unique(
    (initialOutputKeys ?? []).filter((key) => available.has(key)),
  );

  if (hasExistingArtifacts && requested.length > 0) return requested;
  if (phaseId === "design") {
    return REQUIRED_DESIGN_OUTPUT_KEYS.filter((key) => available.has(key));
  }
  return [...availableOutputKeys];
}

export function isPhaseOutputLocked({
  phaseId,
  outputKey,
  hasExistingArtifacts,
}: {
  phaseId: string;
  outputKey: string;
  hasExistingArtifacts: boolean;
}): boolean {
  if (hasExistingArtifacts) return false;
  if (phaseId === "design") {
    return REQUIRED_DESIGN_OUTPUT_KEYS.some((key) => key === outputKey);
  }
  return true;
}

export function isPhaseOutputSelectionComplete({
  phaseId,
  availableOutputKeys,
  selectedOutputKeys,
  hasExistingArtifacts,
}: Omit<PhaseOutputSelectionContext, "initialOutputKeys"> & {
  selectedOutputKeys: string[];
}): boolean {
  if (selectedOutputKeys.length === 0) return false;
  const selected = new Set(selectedOutputKeys);
  if (hasExistingArtifacts) return true;
  if (phaseId === "design") {
    return REQUIRED_DESIGN_OUTPUT_KEYS.every((key) => selected.has(key));
  }
  return availableOutputKeys.every((key) => selected.has(key));
}

export function defaultFigmaFileName(runTitle: string): string {
  const title = runTitle.trim() || "当前任务";
  return `${title} · 设计稿`.slice(0, 160);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
