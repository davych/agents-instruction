import type {
  AskCitationDto,
  AskWorkItemDraftDto,
} from "@ai-sdlc/contracts";
import { z } from "zod";

export interface AskEvidenceSource {
  sourceId: string;
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
  revision: string;
  excerpt: string;
}

const modelEvidenceSchema = z.object({
  sourceId: z.string().regex(/^S[1-9][0-9]*$/u),
  summary: z.string().trim().min(1).max(1_000),
}).strict();

const workItemDraftSchema = z.object({
  title: z.string().trim().min(1).max(200)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  objective: z.string().trim().min(1).max(5_000)
    .regex(/^[^\u0000]*$/u),
  acceptanceCriteria: z.array(
    z.string().trim().min(1).max(1_000).regex(/^[^\u0000]*$/u),
  ).max(20),
}).strict();

const modelAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(20_000),
  evidence: z.array(modelEvidenceSchema).max(20),
  uncertainties: z.array(z.string().trim().min(1).max(1_000)).max(20),
  suggestedQuestions: z.array(z.string().trim().min(1).max(500)).max(8),
  workItemDraft: workItemDraftSchema.nullable(),
}).strict();

export type ModelAskAnswer = z.infer<typeof modelAnswerSchema>;

export const askAnswerJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "answer",
    "evidence",
    "uncertainties",
    "suggestedQuestions",
    "workItemDraft",
  ],
  properties: {
    answer: { type: "string" },
    evidence: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sourceId", "summary"],
        properties: {
          sourceId: { type: "string", pattern: "^S[1-9][0-9]*$" },
          summary: { type: "string" },
        },
      },
    },
    uncertainties: { type: "array", maxItems: 20, items: { type: "string" } },
    suggestedQuestions: { type: "array", maxItems: 8, items: { type: "string" } },
    workItemDraft: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["title", "objective", "acceptanceCriteria"],
          properties: {
            title: { type: "string", pattern: "^[^\\u0000-\\u001f\\u007f]+$" },
            objective: { type: "string", pattern: "^[^\\u0000]*$" },
            acceptanceCriteria: {
              type: "array",
              maxItems: 20,
              items: { type: "string", pattern: "^[^\\u0000]*$" },
            },
          },
        },
      ],
    },
  },
} as const;

export class InvalidAskModelResponseError extends Error {
  readonly code = "ASK_MODEL_RESPONSE_INVALID";

  constructor(message = "模型没有返回可验证的项目问答格式") {
    super(message);
    this.name = "InvalidAskModelResponseError";
  }
}

export interface ValidatedAskModelAnswer {
  answer: string;
  citations: AskCitationDto[];
  invalidCitationIds: string[];
  uncertainties: string[];
  suggestedQuestions: string[];
  workItemDraft: AskWorkItemDraftDto | null;
}

export const ASK_TRUNCATED_CONTEXT_UNCERTAINTY =
  "本轮源码检索达到安全上限，只覆盖了部分仓库内容；回答不能证明未展示的文件中不存在相关实现。";

export function parseAndValidateAskAnswer(
  rawText: string,
  sources: readonly AskEvidenceSource[],
  options: { contextTruncated?: boolean } = {},
): ValidatedAskModelAnswer {
  const parsed = parseJson(rawText);
  const result = modelAnswerSchema.safeParse(parsed);
  if (!result.success) throw new InvalidAskModelResponseError();

  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  const evidenceById = new Map<string, string>();
  for (const evidence of result.data.evidence) {
    if (!evidenceById.has(evidence.sourceId)) {
      evidenceById.set(evidence.sourceId, evidence.summary);
    }
  }

  const mentionedIds = [...result.data.answer.matchAll(/\bS[1-9][0-9]*\b/gu)]
    .map((match) => match[0]);
  const requestedIds = [...new Set([...evidenceById.keys(), ...mentionedIds])];
  const allInvalidCitationIds = requestedIds.filter((sourceId) => !sourceById.has(sourceId));
  const invalidCitationIds = allInvalidCitationIds.slice(0, 50);
  const validIds = requestedIds.filter((sourceId) => sourceById.has(sourceId));
  const citations = validIds.map((sourceId) => {
    const source = sourceById.get(sourceId);
    if (!source) throw new InvalidAskModelResponseError();
    return {
      sourceId,
      path: source.path,
      startLine: source.startLine,
      endLine: source.endLine,
      sha256: source.sha256,
      revision: source.revision,
      excerpt: source.excerpt,
      summary: evidenceById.get(sourceId) ?? "回答正文引用了这段仓库内容。",
    };
  });

  const uncertainties = uniqueStrings(result.data.uncertainties);
  if (options.contextTruncated) {
    uncertainties.unshift(ASK_TRUNCATED_CONTEXT_UNCERTAINTY);
  }
  if (allInvalidCitationIds.length > 0) {
    const visibleIds = allInvalidCitationIds.slice(0, 8);
    const remainder = allInvalidCitationIds.length - visibleIds.length;
    uncertainties.unshift(
      `模型引用了无法验证的来源 ${visibleIds.join("、")}${remainder > 0 ? ` 等 ${allInvalidCitationIds.length} 条` : ""}；这些引用没有作为源码依据展示。`,
    );
  }
  if (citations.length === 0) {
    uncertainties.unshift("这次回答没有可验证的仓库引用，请把它当作说明或推测。 ".trim());
  }

  return {
    answer: replaceInvalidCitationMarkers(result.data.answer, allInvalidCitationIds),
    citations,
    invalidCitationIds,
    uncertainties: uniqueStrings(uncertainties),
    suggestedQuestions: uniqueStrings(result.data.suggestedQuestions),
    workItemDraft: result.data.workItemDraft,
  };
}

function parseJson(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (!trimmed) throw new InvalidAskModelResponseError("模型返回了空答案");
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end < start) throw new InvalidAskModelResponseError();
  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    throw new InvalidAskModelResponseError();
  }
}

function replaceInvalidCitationMarkers(answer: string, invalidIds: readonly string[]): string {
  const invalid = new Set(invalidIds);
  return answer.replace(/\[(S[1-9][0-9]*)\]/gu, (marker, sourceId: string) =>
    invalid.has(sourceId) ? "[未验证来源]" : marker);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
