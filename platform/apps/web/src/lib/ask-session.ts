import type {
  AskAnswer,
  AskCitation,
  AskHistoryMessage,
  AskProviderId,
  AskThread,
  AskThreadSummary,
  AskWorkItemDraft,
  CreateRunInput,
  WorkType,
} from "@/lib/types";

export const ASK_SESSION_VERSION = 1 as const;
export const ASK_SESSION_MAX_MESSAGES = 24;
export const ASK_HISTORY_MAX_MESSAGES = 12;
export const ASK_HISTORY_MAX_CHARACTERS = 48_000;

const MAX_STORED_CHARACTERS = 512_000;
const MAX_STORED_MESSAGE_CHARACTERS = 20_000;
const MAX_HISTORY_MESSAGE_CHARACTERS = 12_000;
const MAX_CITATION_EXCERPT_CHARACTERS = 32_768;
const PROVIDER_IDS: readonly AskProviderId[] = [
  "openai",
  "lmstudio",
  "ollama",
  "custom",
];

export interface AskSessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  answer?: AskAnswer;
}

export interface AskSessionState {
  version: typeof ASK_SESSION_VERSION;
  providerId?: AskProviderId;
  revision?: string;
  sourceRevision?: string;
  messages: AskSessionMessage[];
}

export interface AskStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AskConfirmedWorkItemDraft extends AskWorkItemDraft {
  workType: WorkType;
  currentBehavior: string;
  inScope: string[];
  outOfScope: string[];
  regressionScope: string[];
  riskFlags: string[];
}

export function safeAskThreadTitle(question: string): { title?: string } {
  const title = question
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200)
    .trimEnd();
  return title ? { title } : {};
}

export function pendingAskThreadSession(thread: AskThreadSummary): AskSessionState {
  return {
    version: ASK_SESSION_VERSION,
    providerId: thread.providerId,
    revision: thread.revision,
    sourceRevision: thread.sourceRevision,
    messages: [],
  };
}

export function isAskThreadIdentityLoaded(
  activeThreadId: string | undefined,
  providerId: AskProviderId | undefined,
  revision: string | undefined,
  loadedThread: Pick<AskThread, "id" | "providerId" | "revision"> | undefined,
): boolean {
  if (!activeThreadId) return true;
  return Boolean(
    loadedThread
    && loadedThread.id === activeThreadId
    && loadedThread.providerId === providerId
    && loadedThread.revision === revision,
  );
}

export function emptyAskSession(providerId?: AskProviderId): AskSessionState {
  return {
    version: ASK_SESSION_VERSION,
    ...(providerId ? { providerId } : {}),
    messages: [],
  };
}

export function loadAskSession(
  projectId: string,
  storage: AskStorage | undefined = browserStorage(),
): AskSessionState {
  if (!storage) return emptyAskSession();
  try {
    const raw = storage.getItem(storageKey(projectId));
    if (!raw || raw.length > MAX_STORED_CHARACTERS) return emptyAskSession();
    return normalizeSession(JSON.parse(raw));
  } catch {
    return emptyAskSession();
  }
}

export function saveAskSession(
  projectId: string,
  session: AskSessionState,
  storage: AskStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    let normalized = normalizeSession(session);
    let serialized = JSON.stringify(normalized);
    while (serialized.length > MAX_STORED_CHARACTERS && normalized.messages.length >= 2) {
      normalized = {
        ...normalized,
        messages: normalized.messages.slice(2),
      };
      serialized = JSON.stringify(normalized);
    }
    storage.setItem(storageKey(projectId), serialized);
  } catch {
    // Storage can be disabled or full. Ask remains usable in memory.
  }
}

export function clearAskSession(
  projectId: string,
  storage: AskStorage | undefined = browserStorage(),
): void {
  try {
    storage?.removeItem(storageKey(projectId));
  } catch {
    // Clearing browser persistence must not break the in-memory conversation.
  }
}

export function askHistory(messages: AskSessionMessage[]): AskHistoryMessage[] {
  const history: AskHistoryMessage[] = [];
  let characters = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || !message.content.trim()) continue;
    const content = message.content.trim().slice(0, MAX_HISTORY_MESSAGE_CHARACTERS);
    if (history.length >= ASK_HISTORY_MAX_MESSAGES) break;
    if (characters + content.length > ASK_HISTORY_MAX_CHARACTERS) break;
    history.push({ role: message.role, content });
    characters += content.length;
  }
  return history.reverse();
}

export function appendAskExchange(
  session: AskSessionState,
  question: string,
  answer: AskAnswer,
): AskSessionState {
  const now = new Date().toISOString();
  const messages = [
    ...session.messages,
    {
      id: messageId("question"),
      role: "user" as const,
      content: question.trim(),
      createdAt: now,
    },
    {
      id: messageId("answer"),
      role: "assistant" as const,
      content: answer.answer,
      createdAt: answer.answeredAt || now,
      answer,
    },
  ].slice(-ASK_SESSION_MAX_MESSAGES);

  return {
    version: ASK_SESSION_VERSION,
    providerId: answer.provider.id,
    revision: answer.revision,
    messages,
  };
}

export function workItemDraftMissingFields(draft: AskWorkItemDraft): string[] {
  const missing: string[] = [];
  if (!draft.title.trim()) missing.push("任务名称");
  if (!draft.objective.trim()) missing.push("期望结果");
  if (draft.acceptanceCriteria.every((criterion) => !criterion.trim())) {
    missing.push("验收标准");
  }
  return missing;
}

export function confirmedWorkItemDraftMissingFields(
  draft: AskConfirmedWorkItemDraft,
): string[] {
  const missing = workItemDraftMissingFields(draft);
  if (!draft.currentBehavior.trim()) missing.push("当前情况");
  if (draft.inScope.every((item) => !item.trim())) missing.push("本次范围");
  if (draft.regressionScope.every((item) => !item.trim())) missing.push("回归范围");
  return missing;
}

export function askAnswerToCreateRunInput(
  draft: AskConfirmedWorkItemDraft,
  answer: AskAnswer,
  sourceRevision?: string,
): CreateRunInput {
  const title = draft.title.trim().slice(0, 200);
  const objective = draft.objective.trim().slice(0, 5_000);
  const acceptanceCriteria = uniqueNonEmpty(draft.acceptanceCriteria, 100, 2_000);
  const evidenceRefs = uniqueNonEmpty(
    answer.citations
      .filter((citation) => citation.revision === answer.revision)
      .map(citationEvidenceRef),
    100,
    2_000,
  );

  return {
    title,
    objective,
    ...(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceRevision ?? answer.revision)
      ? { baseRevision: sourceRevision ?? answer.revision }
      : {}),
    changeContract: {
      workType: draft.workType,
      summary: title,
      currentBehavior: draft.currentBehavior.trim().slice(0, 5_000),
      expectedBehavior: objective,
      inScope: uniqueNonEmpty(draft.inScope, 100, 2_000),
      outOfScope: uniqueNonEmpty(draft.outOfScope, 100, 2_000),
      acceptanceCriteria,
      regressionScope: uniqueNonEmpty(draft.regressionScope, 100, 2_000),
      riskFlags: uniqueNonEmpty([
        ...draft.riskFlags,
        ...(answer.dirty
          ? ["本次回答基于含有未提交修改的项目版本，开始开发前需要确认工作树状态。"]
          : []),
      ], 50, 2_000),
      evidenceRefs,
    },
  };
}

export function citationEvidenceRef(citation: AskCitation): string {
  const revision = evidenceSegment(citation.revision, true);
  const path = evidenceSegment(citation.path, false);
  return `repo://${revision}/${path}#L${citation.startLine}-L${citation.endLine}`;
}

function normalizeSession(value: unknown): AskSessionState {
  if (!isRecord(value) || value.version !== ASK_SESSION_VERSION) return emptyAskSession();
  const providerId = isProviderId(value.providerId) ? value.providerId : undefined;
  const storedRevision = boundedString(value.revision, 200);
  const storedSourceRevision = gitRevision(value.sourceRevision);
  const candidates = Array.isArray(value.messages)
    ? value.messages.map(normalizeMessage).filter(isDefined)
    : [];

  const messages: AskSessionMessage[] = [];
  let revision = storedRevision;
  for (let index = 0; index < candidates.length - 1; index += 1) {
    const user = candidates[index];
    const assistant = candidates[index + 1];
    if (user?.role !== "user" || assistant?.role !== "assistant" || !assistant.answer) continue;
    revision ??= assistant.answer.revision;
    if (assistant.answer.revision !== revision) continue;
    messages.push(user, assistant);
    index += 1;
  }

  const limitedMessages = messages.slice(-ASK_SESSION_MAX_MESSAGES);
  return {
    version: ASK_SESSION_VERSION,
    ...(providerId ? { providerId } : {}),
    ...(limitedMessages.length > 0 && revision ? { revision } : {}),
    ...(limitedMessages.length > 0 && storedSourceRevision
      ? { sourceRevision: storedSourceRevision }
      : {}),
    messages: limitedMessages,
  };
}

function normalizeMessage(value: unknown): AskSessionMessage | undefined {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) return undefined;
  const id = boundedString(value.id, 200);
  const content = boundedString(value.content, MAX_STORED_MESSAGE_CHARACTERS);
  const createdAt = boundedString(value.createdAt, 80);
  if (!id || !content?.trim() || !createdAt) return undefined;
  if (value.role === "user") return { id, role: "user", content, createdAt };
  const answer = normalizeAnswer(value.answer);
  return answer ? { id, role: "assistant", content, createdAt, answer } : undefined;
}

function normalizeAnswer(value: unknown): AskAnswer | undefined {
  if (!isRecord(value)) return undefined;
  const answer = exactBoundedString(value.answer, MAX_STORED_MESSAGE_CHARACTERS);
  const revision = boundedString(value.revision, 200);
  const answeredAt = boundedString(value.answeredAt, 80);
  if (!answer?.trim() || !revision || !answeredAt || typeof value.dirty !== "boolean") {
    return undefined;
  }
  if (!isRecord(value.provider) || !isProviderId(value.provider.id)) return undefined;
  const providerLabel = boundedString(value.provider.label, 200);
  const providerModel = boundedString(value.provider.model, 200);
  if (!providerLabel || !providerModel) return undefined;

  const citations = Array.isArray(value.citations)
    ? value.citations
        .map(normalizeCitation)
        .filter(isDefined)
        .filter((citation) => citation.revision === revision)
        .slice(0, 20)
    : [];
  const usage = isRecord(value.usage) ? value.usage : {};
  const durationMs = typeof value.durationMs === "number" && Number.isFinite(value.durationMs)
    ? Math.max(0, value.durationMs)
    : 0;

  return {
    answer,
    citations,
    invalidCitationIds: boundedStringArray(value.invalidCitationIds, 50, 200),
    uncertainties: boundedStringArray(value.uncertainties, 20, 2_000),
    suggestedQuestions: boundedStringArray(value.suggestedQuestions, 12, 1_000),
    workItemDraft: normalizeWorkItemDraft(value.workItemDraft),
    provider: {
      id: value.provider.id,
      label: providerLabel,
      model: providerModel,
    },
    revision,
    dirty: value.dirty,
    usage: {
      inputTokens: tokenCount(usage.inputTokens),
      outputTokens: tokenCount(usage.outputTokens),
    },
    durationMs,
    answeredAt,
  };
}

function normalizeCitation(value: unknown): AskCitation | undefined {
  if (!isRecord(value)) return undefined;
  const sourceId = boundedString(value.sourceId, 200);
  const path = boundedString(value.path, 4_096);
  const sha256 = boundedString(value.sha256, 128);
  const revision = boundedString(value.revision, 200);
  const excerpt = exactBoundedString(value.excerpt, MAX_CITATION_EXCERPT_CHARACTERS);
  const summary = boundedString(value.summary, 1_000);
  const startLine = positiveInteger(value.startLine);
  const endLine = positiveInteger(value.endLine);
  if (!sourceId || !path || !sha256 || !revision || excerpt === undefined || !summary) {
    return undefined;
  }
  if (!startLine || !endLine || endLine < startLine) return undefined;
  return { sourceId, path, sha256, revision, excerpt, summary, startLine, endLine };
}

function normalizeWorkItemDraft(value: unknown): AskWorkItemDraft | null {
  if (value === null || !isRecord(value)) return null;
  const title = boundedString(value.title, 200);
  const objective = boundedString(value.objective, 5_000);
  if (!title || !objective) return null;
  return {
    title,
    objective,
    acceptanceCriteria: boundedStringArray(value.acceptanceCriteria, 100, 2_000),
  };
}

function boundedStringArray(value: unknown, maximum: number, itemLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => boundedString(item, itemLength))
    .filter((item): item is string => Boolean(item))
    .slice(0, maximum);
}

function uniqueNonEmpty(values: string[], maximum: number, itemLength: number): string[] {
  return [...new Set(
    values
      .map((value) => value.trim().slice(0, itemLength))
      .filter(Boolean),
  )].slice(0, maximum);
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maximum) : undefined;
}

function exactBoundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length <= maximum ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined;
}

function gitRevision(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
    ? value
    : undefined;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function evidenceSegment(value: string, encodeSlash: boolean): string {
  const withoutControls = value.replace(/[\u0000-\u001f\u007f#]/gu, "-").trim();
  return encodeSlash ? withoutControls.replaceAll("/", "%2F") : withoutControls;
}

function isProviderId(value: unknown): value is AskProviderId {
  return typeof value === "string" && PROVIDER_IDS.includes(value as AskProviderId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function messageId(prefix: string): string {
  const uuid = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

function storageKey(projectId: string): string {
  return `ai-sdlc:ask:v1:${encodeURIComponent(projectId).slice(0, 500)}`;
}

function browserStorage(): AskStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
