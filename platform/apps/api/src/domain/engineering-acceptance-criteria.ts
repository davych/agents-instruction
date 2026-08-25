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
  const contractCriteria = normalizedCriteria(input.changeContractCriteria ?? [])
    .filter(isExecutableAcceptanceCriterion);
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

/**
 * Legacy intake once manufactured a generic human-confirmation sentence. It is
 * useful as a migration warning, but it is not observable acceptance evidence
 * and must not suppress more specific approved Story criteria.
 */
export function isExecutableAcceptanceCriterion(criterion: string): boolean {
  const value = criterion.trim();
  if (!value) return false;
  return ![
    /^A human reviewer confirms the stated objective is met\.?$/iu,
    /^(?:A\s+)?human(?:\s+reviewer)?\s+confirms?\s+(?:the\s+)?(?:objective|request|change|work|requirements?)\s+(?:is|are|was|were)\s+(?:met|complete|correct)\.?$/iu,
    /^(?:(?:the\s+)?(?:feature|change|system|product|it)\s+)?(?:works?|behaves?)\s+(?:as\s+expected|correctly)\.?$/iu,
    /^(?:the\s+)?(?:objective|requirements?)\s+(?:is|are)\s+met\.?$/iu,
    /^(?:ensure|verify|confirm|make\s+sure)(?:\s+that)?\s+(?:the\s+)?(?:page|feature|change|system|product|behavior|request)\s+(?:is\s+)?(?:correct|right|proper|valid|working|works?|behaves?\s+correctly)\.?$/iu,
    /^(?:support|implement|provide|handle)\s+(?:the\s+)?(?:(?:requested|expected)\s+)?(?:behavior|behaviour|functionality|feature|request|requirements?|errors?|edge\s+cases?)\.?$/iu,
    /^(?:looks?|appears?)\s+(?:good|correct|right|proper)\.?$/iu,
    /^(?:由)?人工(?:审核者)?确认(?:所述)?(?:目标|需求|变更|工作)(?:已经|已)?(?:满足|完成|正确)[。.]?$/u,
    /^(?:功能|系统|产品)?(?:符合预期|正常工作)[。.]?$/u,
    /^(?:确保|确认|验证)(?:该|这个)?(?:页面|功能|变更|系统|产品|行为|请求)(?:是|能够)?(?:正确|正常|符合预期)[。.]?$/u,
    /^(?:支持|实现|提供|处理)(?:所请求的|预期的)?(?:行为|功能|需求|请求|错误|异常|边界情况)[。.]?$/u,
    /^(?:看起来|显示得?)(?:正确|正常|没问题)[。.]?$/u,
  ].some((pattern) => pattern.test(value));
}

function normalizedCriteria(criteria: readonly string[]): string[] {
  return criteria.map((criterion) => criterion.trim()).filter(Boolean);
}
