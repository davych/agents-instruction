const REQUIRED_DESIGN_OUTPUT_KEYS = ["design-baseline", "design-spec"] as const;
export const REQUIRED_ARCHITECTURE_BOOTSTRAP_OUTPUT_KEYS = [
  "architecture",
  "architecture-discovery-context",
  "architecture-options",
] as const;
export const REQUIRED_ARCHITECTURE_POST_SELECTION_OUTPUT_KEYS = [
  "architecture",
  "architecture-c4-context",
  "architecture-c4-containers",
  "architecture-adrs",
  "architecture-patterns",
  "architecture-nfrs",
  "architecture-adversarial",
] as const;

export type ArchitectureImpactChoice = "skip" | "reuse" | "partial" | "full";

export interface ArchitecturePartialOutputContext {
  availableOutputKeys: string[];
  initialOutputKeys?: string[];
  affectedOutputKeys?: string[];
  requireAllAffectedOutputs?: boolean;
}

export interface ArchitectureOutputFreshnessArtifact {
  artifactKey: string;
  revision?: number;
  createdAt?: string;
}

const ARCHITECTURE_SELECTION_PATTERN = /^\s*(?:Selected option|选择方案|选定方案)\s*[:：]\s*(?:Option\s+)?([A-Za-z0-9][A-Za-z0-9._-]{0,159})\s*$/gimu;
const ARCHITECTURE_OPTION_HEADING_PATTERN = /^#{2,3}\s+Option\s+([A-Za-z0-9][A-Za-z0-9._-]{0,159})\s*(?::|：|—|–|\s-\s)\s*(.+?)\s*$/gimu;

export interface ArchitectureOptionSummary {
  id: string;
  title: string;
  summary: string;
  optimizes?: string;
  givesUp?: string;
  recommended: boolean;
}

export interface ArchitectureSelectionReviewLike {
  id?: string;
  decision: string;
  comment?: string;
  artifactIds?: string[];
  createdAt?: string;
}

export interface ArchitectureSelectionEvidence {
  optionId: string;
  reviewId?: string;
  selectedAt: string;
}

export interface PhaseOutputSelectionContext {
  phaseId: string;
  availableOutputKeys: string[];
  hasExistingArtifacts: boolean;
  existingOutputKeys?: string[];
  initialOutputKeys?: string[];
  architectureSelectionRecorded?: boolean;
}

export function parseArchitectureSelectionId(comment: string): string | undefined {
  ARCHITECTURE_SELECTION_PATTERN.lastIndex = 0;
  const matches = [...comment.matchAll(ARCHITECTURE_SELECTION_PATTERN)];
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

export function architectureOptionSummaries(content: string): ArchitectureOptionSummary[] {
  ARCHITECTURE_OPTION_HEADING_PATTERN.lastIndex = 0;
  const matches = [...content.matchAll(ARCHITECTURE_OPTION_HEADING_PATTERN)];
  const recommendationText = content.replace(/\*\*/gu, "");
  return matches.map((match, index) => {
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? content.length;
    const body = content.slice(bodyStart, bodyEnd);
    const summary = body.split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !/^(?:#|[-*]\s|\|)/u.test(line)) ?? "";
    return {
      id: match[1]!,
      title: cleanArchitectureOptionText(match[2] ?? ""),
      summary: cleanArchitectureOptionText(summary),
      optimizes: architectureOptionField(body, "Optimizes"),
      givesUp: architectureOptionField(body, "Gives up"),
      recommended: new RegExp(
        `(?:Recommend|推荐)\\s+(?:选择\\s*)?Option\\s+${match[1]!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=[\\s.,;:!?。；：！？]|$)`,
        "iu",
      ).test(recommendationText),
    };
  });
}

function architectureOptionField(content: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = new RegExp(`^\\s*[-*]\\s+\\*\\*${escaped}:\\*\\*\\s*(.+?)\\s*$`, "imu")
    .exec(content)?.[1];
  return value ? cleanArchitectureOptionText(value) : undefined;
}

function cleanArchitectureOptionText(content: string): string {
  return content.replace(/\*\*|`/gu, "").trim();
}

export function architectureSelectionFromReviews(
  reviews: ArchitectureSelectionReviewLike[],
  optionsArtifactId?: string,
  requiredReviewedArtifactIds: string[] = optionsArtifactId ? [optionsArtifactId] : [],
): ArchitectureSelectionEvidence | undefined {
  const ordered = [...reviews].sort((left, right) =>
    String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""))
  );
  for (const review of ordered) {
    if (review.decision !== "request_changes") continue;
    if (
      requiredReviewedArtifactIds.length > 0
      && !requiredReviewedArtifactIds.every((artifactId) =>
        review.artifactIds?.includes(artifactId) === true
      )
    ) continue;
    const optionId = parseArchitectureSelectionId(review.comment ?? "");
    const selectedAt = review.createdAt ?? "";
    if (!optionId || !Number.isFinite(Date.parse(selectedAt))) continue;
    return { optionId, reviewId: review.id, selectedAt };
  }
  return undefined;
}

export function architecturePartialOutputKeys({
  availableOutputKeys,
  initialOutputKeys,
  affectedOutputKeys,
  requireAllAffectedOutputs = false,
}: ArchitecturePartialOutputContext): string[] {
  const allowed = architecturePartialAllowedOutputKeys(
    availableOutputKeys,
    affectedOutputKeys,
  );
  if (!allowed.includes("architecture")) return [];
  const requestedOutputKeys = requireAllAffectedOutputs && affectedOutputKeys
    ? affectedOutputKeys
    : initialOutputKeys;
  const requested = unique(
    (requestedOutputKeys ?? []).filter((key) => allowed.includes(key)),
  );
  return unique(["architecture", ...requested]);
}

export function architecturePartialAllowedOutputKeys(
  availableOutputKeys: string[],
  affectedOutputKeys?: string[],
): string[] {
  const available = new Set(availableOutputKeys);
  const affected = affectedOutputKeys ? new Set(affectedOutputKeys) : undefined;
  return REQUIRED_ARCHITECTURE_POST_SELECTION_OUTPUT_KEYS.filter(
    (key) => available.has(key) && (!affected || affected.has(key)),
  );
}

export function isArchitecturePartialOutputSelectionComplete({
  availableOutputKeys,
  selectedOutputKeys,
  affectedOutputKeys,
  requireAllAffectedOutputs = false,
}: {
  availableOutputKeys: string[];
  selectedOutputKeys: string[];
  affectedOutputKeys?: string[];
  requireAllAffectedOutputs?: boolean;
}): boolean {
  const allowedOutputKeys = architecturePartialAllowedOutputKeys(
    availableOutputKeys,
    affectedOutputKeys,
  );
  const allowed = new Set(allowedOutputKeys);
  const selectionIsValid = selectedOutputKeys.includes("architecture")
    && new Set(selectedOutputKeys).size === selectedOutputKeys.length
    && selectedOutputKeys.every((key) => allowed.has(key));
  return selectionIsValid && (
    !requireAllAffectedOutputs
    || (
      selectedOutputKeys.length === allowedOutputKeys.length
      && allowedOutputKeys.every((key) => selectedOutputKeys.includes(key))
    )
  );
}

export function isArchitectureImpactRationaleValid(rationale: string): boolean {
  return rationale.trim().length >= 10;
}

export function isArchitectureReselectionBlockedByImpact(
  impactMode: string | undefined,
  reviewComment: string,
): boolean {
  return impactMode === "partial"
    && /^\s*(?:Selected option|选择方案|选定方案)\s*[:：]\s*(?:Option\s+)?[A-Za-z0-9][A-Za-z0-9._-]*\s*$/imu
      .test(reviewComment);
}

export function isArchitectureImpactOutputMutable(
  impactMode: string | undefined,
  affectedOutputKeys: string[] | undefined,
  outputKey: string,
): boolean {
  if (impactMode === "reuse") return false;
  if (impactMode === "partial") return affectedOutputKeys?.includes(outputKey) === true;
  return true;
}

export function architectureOutputKeysRequiringRefresh({
  impactMode,
  affectedOutputKeys,
  availableOutputKeys,
  artifacts,
  selectedAt,
}: {
  impactMode?: string;
  affectedOutputKeys?: string[];
  availableOutputKeys: string[];
  artifacts: ArchitectureOutputFreshnessArtifact[];
  selectedAt?: string;
}): string[] {
  const relevantOutputKeys = impactMode === "partial"
    ? architecturePartialAllowedOutputKeys(availableOutputKeys, affectedOutputKeys)
    : REQUIRED_ARCHITECTURE_POST_SELECTION_OUTPUT_KEYS.filter((key) =>
        availableOutputKeys.includes(key)
      );
  const currentByKey = new Map(
    artifacts.map((artifact) => [artifact.artifactKey, artifact]),
  );
  const selectionTime = Date.parse(selectedAt ?? "");
  return relevantOutputKeys.filter((key) => {
    const artifact = currentByKey.get(key);
    if (!artifact) return false;
    if (impactMode === "partial") return (artifact.revision ?? 1) <= 1;
    const createdAt = Date.parse(artifact.createdAt ?? "");
    return !Number.isFinite(selectionTime)
      || !Number.isFinite(createdAt)
      || createdAt <= selectionTime;
  });
}

export function initialPhaseOutputKeys({
  phaseId,
  availableOutputKeys,
  hasExistingArtifacts,
  existingOutputKeys,
  initialOutputKeys,
  architectureSelectionRecorded,
}: PhaseOutputSelectionContext): string[] {
  const executableOutputKeys = phaseId === "discovery"
    ? availableOutputKeys.filter((key) => key !== "change-contract")
    : availableOutputKeys;
  const available = new Set(executableOutputKeys);
  const requested = unique(
    (initialOutputKeys ?? []).filter((key) => available.has(key)),
  );

  if (hasExistingArtifacts && existingOutputKeys !== undefined && phaseId !== "architecture") {
    const existing = new Set(existingOutputKeys);
    const required = phaseId === "design"
      ? REQUIRED_DESIGN_OUTPUT_KEYS.filter((key) => available.has(key))
      : executableOutputKeys;
    const missing = required.filter((key) => !existing.has(key));
    if (missing.length > 0) return unique([...requested, ...missing]);
  }
  if (hasExistingArtifacts && requested.length > 0) {
    if (phaseId !== "architecture" || architectureSelectionRecorded) return requested;
    const bootstrap = new Set<string>(REQUIRED_ARCHITECTURE_BOOTSTRAP_OUTPUT_KEYS);
    const allowed = requested.filter((key) => bootstrap.has(key));
    if (allowed.length > 0) return allowed;
  }
  if (phaseId === "design") {
    return REQUIRED_DESIGN_OUTPUT_KEYS.filter((key) => available.has(key));
  }
  if (phaseId === "architecture") {
    const bootstrap = REQUIRED_ARCHITECTURE_BOOTSTRAP_OUTPUT_KEYS.filter((key) => available.has(key));
    const existing = new Set(existingOutputKeys ?? []);
    if (!bootstrap.every((key) => existing.has(key))) {
      return bootstrap.filter((key) => !existing.has(key));
    }
    if (!architectureSelectionRecorded) return bootstrap;
    return REQUIRED_ARCHITECTURE_POST_SELECTION_OUTPUT_KEYS.filter((key) => available.has(key));
  }
  return [...executableOutputKeys];
}

export function isPhaseOutputLocked({
  phaseId,
  outputKey,
  hasExistingArtifacts,
  architectureSelectionRecorded,
}: {
  phaseId: string;
  outputKey: string;
  hasExistingArtifacts: boolean;
  architectureSelectionRecorded?: boolean;
}): boolean {
  if (phaseId === "architecture" && !architectureSelectionRecorded) {
    if (!REQUIRED_ARCHITECTURE_BOOTSTRAP_OUTPUT_KEYS.some((key) => key === outputKey)) {
      return true;
    }
    return !hasExistingArtifacts;
  }
  if (hasExistingArtifacts) return false;
  if (phaseId === "design") {
    return REQUIRED_DESIGN_OUTPUT_KEYS.some((key) => key === outputKey);
  }
  if (phaseId === "architecture") {
    return REQUIRED_ARCHITECTURE_BOOTSTRAP_OUTPUT_KEYS.some((key) => key === outputKey);
  }
  return true;
}

export function isPhaseOutputSelectionComplete({
  phaseId,
  availableOutputKeys,
  selectedOutputKeys,
  hasExistingArtifacts,
  existingOutputKeys,
  architectureSelectionRecorded,
}: Omit<PhaseOutputSelectionContext, "initialOutputKeys"> & {
  selectedOutputKeys: string[];
}): boolean {
  if (selectedOutputKeys.length === 0) return false;
  const selected = new Set(selectedOutputKeys);
  const executableOutputKeys = phaseId === "discovery"
    ? availableOutputKeys.filter((key) => key !== "change-contract")
    : availableOutputKeys;
  const executable = new Set(executableOutputKeys);
  if (
    selected.size !== selectedOutputKeys.length
    || selectedOutputKeys.some((key) => !executable.has(key))
  ) return false;
  if (phaseId === "architecture") {
    const existing = new Set(existingOutputKeys ?? []);
    const bootstrap = REQUIRED_ARCHITECTURE_BOOTSTRAP_OUTPUT_KEYS
      .filter((key) => availableOutputKeys.includes(key));
    const bootstrapSet = new Set<string>(bootstrap);
    if (!bootstrap.every((key) => existing.has(key) || selected.has(key))) return false;
    const selectsSelectedState = selectedOutputKeys.some((key) => !bootstrapSet.has(key));
    if (selectsSelectedState && !architectureSelectionRecorded) return false;
    if (!architectureSelectionRecorded) return true;
    if (selectedOutputKeys.every((key) => existing.has(key))) return true;
    return availableOutputKeys.every((key) => existing.has(key) || selected.has(key));
  }
  if (hasExistingArtifacts) {
    if (existingOutputKeys === undefined) return true;
    const existing = new Set(existingOutputKeys);
    const required = phaseId === "design"
      ? REQUIRED_DESIGN_OUTPUT_KEYS.filter((key) => executable.has(key))
      : executableOutputKeys;
    return required.every((key) => existing.has(key) || selected.has(key));
  }
  if (phaseId === "design") {
    return REQUIRED_DESIGN_OUTPUT_KEYS.every((key) => selected.has(key));
  }
  return executableOutputKeys.every((key) => selected.has(key));
}

export function requiredPhaseApprovalOutputKeys(
  phaseId: string,
  availableOutputKeys: string[],
): string[] {
  return phaseId === "design"
    ? REQUIRED_DESIGN_OUTPUT_KEYS.filter((key) => availableOutputKeys.includes(key))
    : [...availableOutputKeys];
}

export function defaultFigmaFileName(runTitle: string): string {
  const title = runTitle.trim() || "当前任务";
  return `${title} · 设计稿`.slice(0, 160);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
