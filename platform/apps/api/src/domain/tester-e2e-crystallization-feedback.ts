import {
  TESTER_E2E_CRYSTALLIZATION_REVIEW_PREFIX,
  type ChangeContractDto,
  type ReviewDto,
} from "@ai-sdlc/contracts";

import type { CurrentArtifactSnapshot } from "../db/store.js";

const scenarioMaximumCharacters = 240;
const frozenIntentMaximumCharacters = 1_200;
const acceptanceCriterionIdPattern = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/u;

export const TESTER_E2E_CRYSTALLIZATION_MARKER = TESTER_E2E_CRYSTALLIZATION_REVIEW_PREFIX;

export function findTesterE2eCrystallizationReview(
  reviews: readonly ReviewDto[],
  changeContract: ChangeContractDto | null | undefined,
): ReviewDto | undefined {
  const controllingReview = [...reviews]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return controllingReview?.decision === "request_changes"
    && parseTesterE2eCrystallizationRequest(controllingReview.comment, changeContract)
    ? controllingReview
    : undefined;
}

export function testerE2eCrystallizationRevisionFeedback(input: {
  review: ReviewDto;
  artifacts: readonly CurrentArtifactSnapshot[];
  changeContract: ChangeContractDto | null | undefined;
}): string | undefined {
  if (
    input.review.decision !== "request_changes"
  ) return undefined;

  const request = parseTesterE2eCrystallizationRequest(
    input.review.comment,
    input.changeContract,
  );
  if (!request) return undefined;

  const report = input.artifacts.find((artifact) =>
    artifact.artifactKey === "test-report"
    && input.review.artifactIds.includes(artifact.id)
  );
  if (!report) return undefined;

  return [
    "[Tester E2E crystallization feedback — read-only, non-authoritative scope]",
    "",
    "This is bounded revision feedback from a later Verification review. It identifies a reusable E2E coverage gap; it does not add or redefine product scope. The approved Change Contract and explicitly selected upstream artifacts remain authoritative.",
    "",
    "## Source test-report head",
    `- Artifact id: ${report.id}`,
    `- Path: ${report.filePath}`,
    `- Revision: ${report.revision}`,
    `- SHA-256: ${report.contentHash}`,
    `- Review id: ${input.review.id}`,
    `- Review created at: ${input.review.createdAt}`,
    "",
    "## Parsed crystallization request",
    `- Scenario: ${request.scenario}`,
    ...request.acceptanceCriteria.map((criterion) => `- AC: ${criterion.id}`),
    `- Frozen intent: ${request.frozenIntent}`,
    "",
    "## Matched authoritative Change Contract acceptance criteria",
    ...request.acceptanceCriteria.map((criterion) => `- ${criterion.line}`),
    "",
    "## Crystallization boundary",
    "- Use the feedback only to locate the scenario and coverage gap. If it conflicts with the approved contract/spec, stop and request a human scope decision.",
    "- Freeze the scenario's preconditions, observable action, and expected outcome in a fresh Tier A/B test-authoring session using only the approved contract/spec intent.",
    "- Excluded from that independent authoring context: implementation source/diff, exploratory MCP transcript, selector experiments, and code generated during exploration.",
    "- Software Engineer owns integrating the resulting repository `*.spec.ts`, running the real checks, refreshing all engineering evidence, and returning Implementation for approval.",
  ].join("\n");
}

interface ParsedCrystallizationRequest {
  scenario: string;
  acceptanceCriteria: Array<{ id: string; line: string }>;
  frozenIntent: string;
}

function parseTesterE2eCrystallizationRequest(
  comment: string,
  changeContract: ChangeContractDto | null | undefined,
): ParsedCrystallizationRequest | undefined {
  const lines = comment.split(/\r?\n/u);
  const firstLinePrefix = `${TESTER_E2E_CRYSTALLIZATION_REVIEW_PREFIX} `;
  const firstLine = lines[0] ?? "";
  if (!firstLine.startsWith(firstLinePrefix)) return undefined;

  const scenario = firstLine.slice(firstLinePrefix.length);
  if (!validRequestField(scenario, scenarioMaximumCharacters)) return undefined;

  const availableCriteria = new Map(
    (changeContract?.acceptanceCriteria ?? []).map((criterion, index) => {
      const explicitId = /^\s*(?:[-*]\s*)?((?:CC-)?AC-[A-Za-z0-9][A-Za-z0-9._-]*)/iu
        .exec(criterion)?.[1];
      const id = explicitId ?? `CC-AC-${String(index + 1).padStart(3, "0")}`;
      const line = explicitId ? criterion.trim() : `${id}: ${criterion.trim()}`;
      return [id.toUpperCase(), { id, line }] as const;
    }),
  );

  const requestedIds: string[] = [];
  let frozenIntent: string | undefined;
  for (const line of lines.slice(1)) {
    const acMatch = /^AC: ([^\r\n]+)$/u.exec(line);
    if (acMatch) {
      const id = acMatch[1]!;
      if (!acceptanceCriterionIdPattern.test(id)) return undefined;
      requestedIds.push(id);
      continue;
    }
    const frozenIntentMatch = /^Frozen intent: ([^\r\n]+)$/u.exec(line);
    if (frozenIntentMatch) {
      if (frozenIntent !== undefined) return undefined;
      frozenIntent = frozenIntentMatch[1]!;
    }
  }
  if (requestedIds.length === 0 || !validRequestField(frozenIntent, frozenIntentMaximumCharacters)) {
    return undefined;
  }

  const acceptanceCriteria = [...new Set(requestedIds)].map((requestedId) =>
    availableCriteria.get(requestedId.toUpperCase())
  );
  if (acceptanceCriteria.some((criterion) => !criterion)) return undefined;

  return {
    scenario,
    acceptanceCriteria: acceptanceCriteria as Array<{ id: string; line: string }>,
    frozenIntent,
  };
}

function validRequestField(value: string | undefined, maximumCharacters: number): value is string {
  return Boolean(
    value
    && value === value.trim()
    && value.length <= maximumCharacters
    && /[\p{L}\p{N}]/u.test(value)
    && !/^(?:<[^>]*>|\{\{[^}]*\}\}|tbd|todo|pending|unknown|none)$/iu.test(value),
  );
}
