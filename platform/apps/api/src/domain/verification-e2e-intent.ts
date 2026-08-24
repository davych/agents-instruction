import type { ChangeContractDto, PhaseStatus } from "@ai-sdlc/contracts";

import { AppError } from "./errors.js";
import { resolveEngineeringAcceptanceCriteria } from "./engineering-acceptance-criteria.js";

interface SelectedArtifactWithContent {
  id: string;
  artifactKey: string;
  sourceStatus: PhaseStatus;
  content: string;
  contentHash: string;
}

export interface FrozenE2eCriterion {
  id: string;
  text: string;
  kind: "acceptance" | "regression";
}

export interface FrozenE2eIntent {
  criteriaSource: "change_contract" | "approved_user_stories";
  criteria: FrozenE2eCriterion[];
  authoritativeArtifacts: Array<{
    id: string;
    artifactKey: string;
    contentHash: string;
    content: string;
  }>;
}

const allowedAuthoringArtifactKeys = new Set([
  "change-contract",
  "prd",
  "user-stories",
  "design-spec",
  "architecture-nfrs",
]);

/**
 * Freezes the only product intent the isolated E2E author may receive. Legacy
 * Runs fail closed unless stable AC IDs can be recovered from approved stories.
 */
export function freezeVerificationE2eIntent(input: {
  changeContract?: ChangeContractDto | null;
  selectedArtifacts: readonly SelectedArtifactWithContent[];
}): FrozenE2eIntent {
  const acceptanceCriteria = resolveEngineeringAcceptanceCriteria({
    changeContractCriteria: input.changeContract?.acceptanceCriteria,
    selectedArtifacts: input.selectedArtifacts,
  });
  if (acceptanceCriteria.length === 0) {
    throw new AppError(
      "无法从 Change Contract 或已批准 user-stories 解析稳定验收标准，不能生成 E2E 脚本",
      409,
      "E2E_AUTHORITATIVE_CRITERIA_MISSING",
    );
  }

  const acceptance = acceptanceCriteria.map((criterion, index) => ({
    id: stableIdentifier(criterion) ?? `CC-AC-${String(index + 1).padStart(3, "0")}`,
    text: criterion,
    kind: "acceptance" as const,
  }));
  const regression = (input.changeContract?.regressionScope ?? []).map((criterion, index) => ({
    id: stableIdentifier(criterion) ?? `REG-${String(index + 1).padStart(3, "0")}`,
    text: criterion.trim(),
    kind: "regression" as const,
  })).filter(({ text }) => Boolean(text));
  const ids = new Set<string>();
  for (const criterion of [...acceptance, ...regression]) {
    if (ids.has(criterion.id)) {
      throw new AppError(
        `E2E test intent contains duplicate criterion id ${criterion.id}`,
        409,
        "E2E_AUTHORITATIVE_CRITERIA_DUPLICATE",
      );
    }
    ids.add(criterion.id);
  }

  return {
    criteriaSource: input.changeContract?.acceptanceCriteria?.length
      ? "change_contract"
      : "approved_user_stories",
    criteria: [...acceptance, ...regression],
    authoritativeArtifacts: input.selectedArtifacts
      .filter((artifact) => (
        artifact.sourceStatus === "approved"
        && allowedAuthoringArtifactKeys.has(artifact.artifactKey)
      ))
      .map((artifact) => ({
        id: artifact.id,
        artifactKey: artifact.artifactKey,
        contentHash: artifact.contentHash,
        content: artifact.content.slice(0, 50_000),
      })),
  };
}

function stableIdentifier(value: string): string | undefined {
  const match = /^\s*(?:[-*]\s*)?(?:[*_`]*)?([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)(?:[*_`]*)?(?:\s*(?::|—|-)\s+\S|\s*$)/u
    .exec(value);
  return match?.[1]?.toUpperCase();
}
