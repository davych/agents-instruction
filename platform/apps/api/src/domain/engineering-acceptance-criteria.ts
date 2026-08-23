import type { PhaseStatus } from "@ai-sdlc/contracts";

import { parseUserStoryTickets } from "./user-story-tickets.js";

interface SelectedArtifactWithContent {
  artifactKey: string;
  sourceStatus: PhaseStatus;
  content: string;
}

const stableStoryAcceptanceHeading = /^###[ \t]+(US-\d{3,}-AC-\d+)[ \t]*(?:[:：-][ \t]*(.*))?$/gimu;

export function resolveEngineeringAcceptanceCriteria(input: {
  changeContractCriteria?: readonly string[] | null;
  selectedArtifacts: readonly SelectedArtifactWithContent[];
}): string[] {
  const contractCriteria = normalizedCriteria(input.changeContractCriteria ?? []);
  if (contractCriteria.length > 0) return contractCriteria;

  const byId = new Map<string, string>();
  for (const artifact of input.selectedArtifacts) {
    if (artifact.artifactKey !== "user-stories" || artifact.sourceStatus !== "approved") continue;
    for (const ticket of parseUserStoryTickets(artifact.content)) {
      for (const match of ticket.content.matchAll(stableStoryAcceptanceHeading)) {
        const id = match[1]?.toUpperCase();
        if (!id || byId.has(id)) continue;
        const description = match[2]?.trim();
        byId.set(id, description ? `${id}: ${description}` : id);
      }
    }
  }
  return [...byId.values()];
}

function normalizedCriteria(criteria: readonly string[]): string[] {
  return criteria.map((criterion) => criterion.trim()).filter(Boolean);
}
