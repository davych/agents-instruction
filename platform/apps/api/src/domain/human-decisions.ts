import { createHash } from "node:crypto";

import {
  isGenericHumanDecisionResponse,
  type HumanDecisionItemDto,
  type HumanDecisionPhaseId,
  type HumanDecisionSummaryDto,
  type PhaseHumanDecisionGateDto,
  type PhaseStatus,
  type ReviewDto,
} from "@ai-sdlc/contracts";

import { AppError } from "./errors.js";
import {
  assessUserStoriesQuality,
  parseUserStoriesBlocker,
  userStoriesBlockerDecisionScope,
  userStoriesBlockerQuestionDecisions,
  type UserStoriesBlockerDecisionScope,
} from "./user-story-quality.js";
import {
  assessDeferredDesignValidations,
  isDeferredDesignVerification,
} from "./design-deferred-validation.js";

export const HUMAN_DECISIONS_MARKER = "ai-sdlc:human-decisions:v1";

const providerDecisionReviewLimit = 5;
const providerAuthoritativeDecisionFeedbackLimit = 7_500;
const providerDecisionFeedbackLimit = 8_000;
const providerDecisionResponseLimit = 800;

export interface DecisionArtifact {
  id?: string;
  artifactKey: string;
  content: string;
}

export interface PhaseHumanDecisionInput {
  phaseId: HumanDecisionPhaseId;
  phaseStatus: PhaseStatus;
  artifacts: readonly DecisionArtifact[];
  reviews?: readonly ReviewDto[];
  requiredDeferredValidationIds?: readonly string[];
  enforceUserStoriesQuality?: boolean;
}

const roleByPhase = {
  discovery: "pm-ba",
  design: "designer",
  architecture: "architect",
} as const;

export function assessPhaseHumanDecisionGate(
  input: PhaseHumanDecisionInput,
): PhaseHumanDecisionGateDto {
  const responses = capturedResponses(input.reviews ?? [], input.artifacts);
  const extracted = input.phaseId === "discovery"
    ? productDecisionItems(input.artifacts, input.enforceUserStoriesQuality === true)
    : input.phaseId === "design"
      ? designDecisionItems(input.artifacts, input.requiredDeferredValidationIds ?? [])
      : architectureDecisionItems(input.artifacts);
  const answeredItems = dedupeOrExposeDecisionIdConflicts(extracted).map((item) => ({
    ...item,
    response: responses.get(item.id) ?? null,
  }));
  const items = input.phaseId === "discovery"
    ? projectAnsweredProductDecisions(answeredItems)
    : answeredItems;
  const blockingCount = items.filter(({ blocking }) => blocking).length;
  const decisionCount = items.filter(({ kind, blocking }) => kind === "decision" && blocking).length;
  const workCount = items.filter(({ kind, blocking }) => kind === "work" && blocking).length;
  const dependencyCount = items.filter(({ kind, blocking }) => kind === "dependency" && blocking).length;
  const inconsistentApproval = input.phaseStatus === "approved" && blockingCount > 0;
  return {
    phaseId: input.phaseId,
    roleId: roleByPhase[input.phaseId],
    state: inconsistentApproval
      ? "inconsistent_approval"
      : decisionCount > 0
        ? "awaiting_decision"
        : workCount > 0 || dependencyCount > 0
          ? "awaiting_role_work"
          : "clear",
    items,
    blockingCount,
    decisionCount,
    workCount,
    dependencyCount,
    inconsistentApproval,
  };
}

function projectAnsweredProductDecisions(
  items: readonly HumanDecisionItemDto[],
): HumanDecisionItemDto[] {
  return items.map((item) => {
    if (item.response === null) return item;
    if (item.artifactKey === "user-stories" && item.kind === "decision") {
      return {
        ...item,
        id: item.id.startsWith("PRODUCT-STORIES-BLOCKER-V2-")
          ? "PRODUCT-STORIES-ANSWER-NOT-MATERIALIZED"
          : `${item.id}-ANSWER-NOT-MATERIALIZED`,
        kind: "work",
        title: "已答复的 User Stories 决定尚未落实",
        prompt: `人工答案已经记录，但当前 User Stories 仍保留旧 Blocker：${item.prompt}`,
        owner: "PM / BA",
        nextAction: "PM / BA 必须把已记录答案落实到 PRD 与真实 User Stories，移除旧 Blocker；不得再次要求人工回答同一事项。",
      };
    }
    if (item.artifactKey === "prd" && item.kind === "decision") {
      return {
        ...item,
        kind: "work",
        title: "已答复的产品决定尚未落实",
        prompt: `人工答案已经记录，但当前 PRD 仍保留原开放问题：${item.prompt}`,
        owner: "PM / BA",
        nextAction: "PM / BA 必须把已记录答案落实到 PRD、业务规则和验收标准，并移除已解决的开放问题；不得再次要求人工回答同一事项。",
      };
    }
    return item;
  });
}

export function humanDecisionSummary(
  gates: readonly PhaseHumanDecisionGateDto[],
): HumanDecisionSummaryDto {
  return {
    totalBlocking: gates.reduce((total, gate) => total + gate.blockingCount, 0),
    totalDecisions: gates.reduce((total, gate) => total + gate.decisionCount, 0),
    totalRoleWork: gates.reduce((total, gate) => total + gate.workCount, 0),
    inconsistentPhaseIds: gates
      .filter(({ inconsistentApproval }) => inconsistentApproval)
      .map(({ phaseId }) => phaseId),
    phases: [...gates],
  };
}

/**
 * A closed Discovery decision batch turns any Provider-created follow-up
 * question or incomplete product artifact into PM / BA repair work. This keeps
 * the Session actionable without pretending the human must answer a second
 * serial batch.
 */
export function projectProductDecisionMaterializationGate(
  gate: PhaseHumanDecisionGateDto,
): PhaseHumanDecisionGateDto {
  if (gate.phaseId !== "discovery" || gate.blockingCount === 0) return gate;
  const items = gate.items.map((item) => (
    item.blocking && (item.kind === "decision" || item.kind === "work")
      ? {
          ...item,
          kind: "work" as const,
          title: "PM / BA 尚未物化已完成的人工决定批次",
          prompt: `人工决定批次已经完成，但当前产物仍新增或保留未决内容：${item.prompt}`,
          owner: "PM / BA",
          nextAction: "在同一 Session/Run 重跑 PM / BA，把已记录答案落实为 PRD 与规范 Story；删除新问题、Pending 标记和 Blocker，不要再次要求人工回答。",
        }
      : item
  ));
  const blockingCount = items.filter(({ blocking }) => blocking).length;
  const decisionCount = items.filter(
    ({ blocking, kind }) => blocking && kind === "decision",
  ).length;
  const workCount = items.filter(({ blocking, kind }) => blocking && kind === "work").length;
  const dependencyCount = items.filter(
    ({ blocking, kind }) => blocking && kind === "dependency",
  ).length;
  const inconsistentApproval = gate.inconsistentApproval || (
    gate.state === "inconsistent_approval" && blockingCount > 0
  );
  return {
    ...gate,
    items,
    blockingCount,
    decisionCount,
    workCount,
    dependencyCount,
    inconsistentApproval,
    state: inconsistentApproval
      ? "inconsistent_approval"
      : decisionCount > 0
        ? "awaiting_decision"
        : workCount > 0 || dependencyCount > 0
          ? "awaiting_role_work"
          : "clear",
  };
}

export function assertPhaseHumanDecisionGateReady(
  gate: PhaseHumanDecisionGateDto,
): void {
  if (gate.blockingCount === 0) return;
  throw new AppError(
    `${phaseLabel(gate.phaseId)} 仍有 ${gate.blockingCount} 项未决决定、角色工作或上游依赖，不能通过并解锁`,
    409,
    "PHASE_HUMAN_DECISIONS_REQUIRED",
    { gate },
  );
}

export function serializeHumanDecisionCapture(input: {
  phaseId: HumanDecisionPhaseId;
  responses: ReadonlyArray<{ id: string; response: string }>;
}): string {
  const readable = input.responses
    .map(({ id, response }) => `- ${id}: ${response.trim()}`)
    .join("\n");
  return [
    "Human decisions captured; update the formal phase artifacts and remove only the blockers these answers actually resolve.",
    "",
    readable,
    "",
    `<!-- ${HUMAN_DECISIONS_MARKER} ${Buffer.from(JSON.stringify({
      schemaVersion: 1,
      phaseId: input.phaseId,
      responses: input.responses,
    }), "utf8").toString("base64url")} -->`,
  ].join("\n");
}

export function parseHumanDecisionCapture(
  content: string,
): { phaseId: HumanDecisionPhaseId; responses: Array<{ id: string; response: string }> } | null {
  const encoded = /<!--\s*ai-sdlc:human-decisions:v1\s+([A-Za-z0-9_-]+)\s*-->/u.exec(content)?.[1];
  if (encoded) {
    try {
      return parsedHumanDecisionPayload(
        JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
      );
    } catch {
      return null;
    }
  }
  const marker = content.indexOf(`<!-- ${HUMAN_DECISIONS_MARKER} -->`);
  if (marker < 0) return null;
  const match = /```json\s*([\s\S]*?)```/iu.exec(content.slice(marker));
  if (!match?.[1]) return null;
  try {
    return parsedHumanDecisionPayload(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

export interface HumanDecisionReplayBundle {
  revisionFeedback: string[];
  answeredUserStoriesBlockerFingerprints: string[];
  answeredUserStoriesBlockerScopes: UserStoriesBlockerDecisionScope[];
}

export interface ProductDecisionMaterializationPolicy {
  sourceReviewId: string;
  sourceArtifactIds: string[];
  decisionSetFingerprint: string;
  responses: Array<{ id: string; response: string }>;
}

/**
 * Build Provider feedback and answered-Blocker enforcement from one snapshot.
 * Current artifact decisions are resolved against the complete Review history
 * and rendered first without truncation. Only then can their Blocker identity
 * authorize Story-only repair. Recent unrelated decisions are optional and
 * may use the remaining bounded context.
 */
export function buildHumanDecisionReplay(
  reviews: readonly ReviewDto[],
  artifacts: readonly DecisionArtifact[],
): HumanDecisionReplayBundle {
  const authoritativeEntries = currentDecisionResponseEntries(reviews, artifacts);
  const authoritativeLines = authoritativeEntries.length > 0
    ? [
        "以下人工决定对应当前 PRD / User Stories 的未落实事项，是本阶段的完整权威事实；必须逐项物化，不得截断、弱化或重复提问：",
        ...authoritativeEntries.map(({ id, response }) => `- ${id}: ${response}`),
      ]
    : [];
  const authoritativeFeedback = authoritativeLines.join("\n");
  if (authoritativeFeedback.length > providerAuthoritativeDecisionFeedbackLimit) {
    throw new AppError(
      "当前阶段的人工决定超过 Provider 可完整重放上限；为避免截断答案后编造产物，本次没有启动角色执行",
      422,
      "PROVIDER_HUMAN_DECISION_REPLAY_LIMIT",
      {
        requiredCharacters: authoritativeFeedback.length,
        maximumCharacters: providerAuthoritativeDecisionFeedbackLimit,
      },
    );
  }

  const activeIds = new Set(authoritativeEntries.map(({ id }) => id));
  const seenIds = new Set(activeIds);
  const optionalEntries = recentConcreteHumanDecisionCaptures(reviews).flatMap(({ capture }) => (
    capture.responses.flatMap((item) => {
      // Positional compatibility IDs are meaningful only when they can be
      // rebound to the exact artifact head the human reviewed. If they were
      // not promoted into authoritativeEntries, replaying them as loose
      // history would let a Provider apply an old answer to new content.
      if (artifacts.length > 0 && isArtifactBoundLegacyDecisionId(item.id)) return [];
      if (seenIds.has(item.id)) return [];
      seenIds.add(item.id);
      return [{ id: item.id, response: boundedDecisionResponse(item.response) }];
    })
  ));
  const lines = authoritativeLines.length > 0
    ? [...authoritativeLines]
    : optionalEntries.length > 0
      ? ["以下人工决定来自最近 5 条结构化记录（由新到旧）；仅有确认语的记录已忽略，同一 ID 仅保留最新具体答案："]
      : [];
  let omitted = 0;
  for (const entry of optionalEntries) {
    const line = `- ${entry.id}: ${entry.response}`;
    if (`${lines.join("\n")}\n${line}`.length > providerDecisionFeedbackLimit) {
      omitted += 1;
      continue;
    }
    lines.push(line);
  }
  if (omitted > 0) {
    const note = `- 另有 ${omitted} 条非当前决定因 Provider 上下文上限未展开；当前产物对应的权威答案均已完整保留。`;
    if (`${lines.join("\n")}\n${note}`.length <= providerDecisionFeedbackLimit) lines.push(note);
  }

  const answeredScopes = currentAnsweredUserStoriesBlockerScopes(reviews, artifacts);
  return {
    revisionFeedback: lines.length > 0 ? [lines.join("\n")] : [],
    answeredUserStoriesBlockerFingerprints: answeredScopes.map(
      ({ aggregateFingerprint }) => aggregateFingerprint,
    ),
    answeredUserStoriesBlockerScopes: answeredScopes,
  };
}

/**
 * Upgrade a persisted Discovery decision capture into a cross-revision
 * materialization lock only when its reviewed artifact snapshots prove that
 * the complete decision set has concrete answers. The latest review is the
 * authority epoch: a newer ordinary human review explicitly reopens product
 * work, while Agent executions cannot clear the lock by rewriting artifacts.
 */
export function completeProductDecisionMaterializationPolicy(
  reviews: readonly ReviewDto[],
  reviewedArtifacts: readonly DecisionArtifact[],
): ProductDecisionMaterializationPolicy | null {
  const latest = newestReviews(reviews)[0];
  if (
    !latest
    || latest.decision !== "request_changes"
    || latest.artifactIds.length === 0
  ) return null;
  const capture = parseHumanDecisionCapture(latest.comment);
  if (!capture || capture.phaseId !== "discovery") return null;
  const productArtifacts = reviewedArtifacts.filter(
    ({ artifactKey }) => artifactKey === "prd" || artifactKey === "user-stories",
  );
  const productArtifactKeys = new Set(productArtifacts.map(({ artifactKey }) => artifactKey));
  if (
    !productArtifactKeys.has("prd")
    || !productArtifactKeys.has("user-stories")
    || productArtifacts.some(({ id }) => !id || !latest.artifactIds.includes(id))
  ) return null;

  const openGate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts: reviewedArtifacts,
    reviews: [],
    enforceUserStoriesQuality: true,
  });
  const decisionIds = openGate.items
    .filter(({ blocking, kind }) => blocking && kind === "decision")
    .map(({ id }) => id);
  if (decisionIds.length === 0) return null;

  const answeredEntries = currentDecisionResponseEntries(reviews, reviewedArtifacts);
  const answeredById = new Map(answeredEntries.map((entry) => [entry.id, entry.response]));
  const responses = decisionIds.flatMap((id) => {
    const response = answeredById.get(id)?.trim();
    if (!response) return [];
    const compact = compactDecisionResponse(response);
    return isConcreteHumanDecisionResponse(compact)
      ? [{ id, response }]
      : [];
  });
  if (responses.length !== new Set(decisionIds).size) return null;

  const resolvedGate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: reviewedArtifacts,
    reviews,
    enforceUserStoriesQuality: true,
  });
  if (resolvedGate.decisionCount > 0) return null;

  const sortedIds = [...new Set(decisionIds)].sort((left, right) => left.localeCompare(right));
  return {
    sourceReviewId: latest.id,
    sourceArtifactIds: [...latest.artifactIds],
    decisionSetFingerprint: createHash("sha256")
      .update(JSON.stringify({ namespace: "product-decision-batch-v1", decisionIds: sortedIds }))
      .digest("hex"),
    responses,
  };
}

export function productDecisionMaterializationFeedback(
  policy: ProductDecisionMaterializationPolicy,
): string {
  const feedback = [
    "以下是已完成且绑定审核产物的完整 Discovery 人工决定批次；本轮必须无损物化，不得新增、改写或保留产品问题：",
    ...policy.responses.map(({ id, response }) => `- ${id}: ${response}`),
    `- decision-set sha256:${policy.decisionSetFingerprint}`,
  ].join("\n");
  if (feedback.length > providerAuthoritativeDecisionFeedbackLimit) {
    throw new AppError(
      "Discovery 人工决定批次超过 Provider 可完整重放上限；为避免截断答案后编造产物，本次没有启动角色执行",
      422,
      "PROVIDER_HUMAN_DECISION_REPLAY_LIMIT",
      {
        requiredCharacters: feedback.length,
        maximumCharacters: providerAuthoritativeDecisionFeedbackLimit,
      },
    );
  }
  return feedback;
}

export function humanDecisionRevisionFeedback(
  reviews: readonly ReviewDto[],
  artifacts: readonly DecisionArtifact[] = [],
): string[] {
  return buildHumanDecisionReplay(reviews, artifacts).revisionFeedback;
}

/**
 * Return the current Blocker fingerprint only when the complete Review history
 * proves that this exact decision occurrence has a concrete answer. V2 binds
 * by content identity; legacy V1 binds only to the immutable artifact head the
 * human actually reviewed.
 */
export function answeredCurrentUserStoriesBlockerFingerprints(
  reviews: readonly ReviewDto[],
  artifacts: readonly DecisionArtifact[],
): string[] {
  return buildHumanDecisionReplay(reviews, artifacts).answeredUserStoriesBlockerFingerprints;
}

export function answeredCurrentUserStoriesBlockerScopes(
  reviews: readonly ReviewDto[],
  artifacts: readonly DecisionArtifact[],
): UserStoriesBlockerDecisionScope[] {
  return buildHumanDecisionReplay(reviews, artifacts).answeredUserStoriesBlockerScopes;
}

function currentAnsweredUserStoriesBlockerScopes(
  reviews: readonly ReviewDto[],
  artifacts: readonly DecisionArtifact[],
): UserStoriesBlockerDecisionScope[] {
  const current = currentUserStoriesBlockerDecision(artifacts);
  if (!current) return [];
  const responses = capturedResponses(reviews, artifacts);
  return current.decisionIds.every((decisionId) => responses.has(decisionId))
    ? [current.scope]
    : [];
}

function currentDecisionResponseEntries(
  reviews: readonly ReviewDto[],
  artifacts: readonly DecisionArtifact[],
): Array<{ id: string; response: string }> {
  const responses = capturedResponses(reviews, artifacts);
  const ids = [
    ...productDecisionItems(artifacts, true),
    ...designDecisionItems(artifacts, []),
    ...architectureDecisionItems(artifacts),
  ].filter(({ kind, blocking }) => kind === "decision" && blocking)
    .map(({ id }) => id);
  return [...new Set(ids)].flatMap((id) => {
    const response = responses.get(id);
    return response ? [{ id, response }] : [];
  });
}

function recentConcreteHumanDecisionCaptures(reviews: readonly ReviewDto[]) {
  return concreteHumanDecisionCaptures(reviews).slice(0, providerDecisionReviewLimit);
}

function concreteHumanDecisionCaptures(reviews: readonly ReviewDto[]) {
  const captures = currentHumanDecisionCaptureEpoch(reviews);
  const seenResponseIds = new Set<string>();
  return captures.flatMap(({ review, capture }) => {
    const concreteResponses = capture.responses.flatMap((item) => {
      if (seenResponseIds.has(item.id)) return [];
      const response = item.response.trim();
      const compact = compactDecisionResponse(response);
      // Bare acknowledgements do not carry a new choice and therefore do
      // not supersede the most recent concrete answer.
      if (!compact || isGenericHumanDecisionResponse(compact)) return [];
      // A newer structured response supersedes an older response for the
      // same ID even when the newer response explicitly defers the choice.
      // Otherwise "TBD" could be discarded and an older concrete choice
      // would silently survive as if the decision were still closed.
      seenResponseIds.add(item.id);
      return !isExplicitlyNonClosingHumanDecisionResponse(compact)
        ? [{ ...item, response }]
        : [];
    });
    return concreteResponses.length > 0
      ? [{ review, capture: { ...capture, responses: concreteResponses } }]
      : [];
  });
}

function currentHumanDecisionCaptureEpoch(
  reviews: readonly ReviewDto[],
): Array<{
  review: ReviewDto;
  capture: NonNullable<ReturnType<typeof parseHumanDecisionCapture>>;
}> {
  const epoch: Array<{
    review: ReviewDto;
    capture: NonNullable<ReturnType<typeof parseHumanDecisionCapture>>;
  }> = [];
  for (const review of newestReviews(reviews)) {
    const capture = review.decision === "request_changes"
      ? parseHumanDecisionCapture(review.comment)
      : null;
    // An ordinary Review is an explicit epoch boundary. Nothing before it may
    // answer the current gate or combine with a later capture into a lock.
    if (!capture) break;
    epoch.push({ review, capture });
  }
  return epoch;
}

function parsedHumanDecisionPayload(
  candidate: unknown,
): { phaseId: HumanDecisionPhaseId; responses: Array<{ id: string; response: string }> } | null {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (
    value.schemaVersion !== 1
    || !["discovery", "design", "architecture"].includes(String(value.phaseId))
    || !Array.isArray(value.responses)
  ) return null;
  const responses = value.responses.flatMap((responseCandidate) => {
    if (typeof responseCandidate !== "object" || responseCandidate === null) return [];
    const record = responseCandidate as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const response = typeof record.response === "string" ? record.response.trim() : "";
    return id && response ? [{ id, response }] : [];
  });
  return {
    phaseId: value.phaseId as HumanDecisionPhaseId,
    responses,
  };
}

function productDecisionItems(
  artifacts: readonly DecisionArtifact[],
  enforceUserStoriesQuality: boolean,
): HumanDecisionItemDto[] {
  const prd = artifacts.find(({ artifactKey }) => artifactKey === "prd")?.content;
  const questions: HumanDecisionItemDto[] = [];
  if (prd) {
    questions.push(...productOpenQuestionDecisions(prd).map(({ decisionId, question }) => ({
      id: decisionId,
      phaseId: "discovery" as const,
      actionPhaseId: "discovery" as const,
      artifactKey: "prd",
      kind: "decision" as const,
      title: conciseTitle(question),
      prompt: cleanMarkdown(question),
      owner: "Human product owner",
      nextAction: "回答后让 PM / BA 更新 PRD、业务规则和验收标准。",
      blocking: true,
      response: null,
    })));
    const incompleteFieldRows = prd.split(/\r?\n/u).filter((line) => (
      /\|[^\n]*(?:Needs?\s+decision|TBD(?:\s*[—-]\s*human\s+decision)?)[^\n]*\|/iu.test(line)
    ));
    const explicitIncompleteFields = incompleteFieldRows.length > 0;
    const status = markdownStrongField(prd, "Status") ?? "";
    if (
      questions.length === 0
      && (explicitIncompleteFields || /(?:blocked|pending\s+human|not\s+ready|needs?\s+decision)/iu.test(status))
    ) {
      questions.push({
        id: explicitIncompleteFields
          ? implicitDecisionId(
              "PRODUCT-HANDOFF-V2",
              "product-handoff-incomplete-v2",
              {
                rows: incompleteFieldRows
                  .map(normalizedDecisionIdentityText)
                  .sort((left, right) => left.localeCompare(right)),
              },
            )
          : "PRODUCT-HANDOFF-INCOMPLETE",
        phaseId: "discovery",
        actionPhaseId: "discovery",
        artifactKey: "prd",
        kind: explicitIncompleteFields ? "decision" : "work",
        title: "产品交接仍明确标记为未完成",
        prompt: explicitIncompleteFields
          ? `PRD 以下字段仍标记 Needs decision 或 TBD：${incompleteFieldRows.map(cleanMarkdown).join("；")}`
          : `PRD Status: ${status || "missing"}`,
        owner: explicitIncompleteFields ? "Human product owner" : "PM / BA",
        nextAction: explicitIncompleteFields
          ? "补齐明确答案，再让 PM / BA 更新正式产品合同。"
          : "让 PM / BA 修正交接状态并明确剩余工作。",
        blocking: true,
        response: null,
      });
    }
  }
  if (enforceUserStoriesQuality) {
    const stories = artifacts.find(({ artifactKey }) => artifactKey === "user-stories")?.content;
    if (stories) {
      const blocker = parseUserStoriesBlocker(stories);
      if (blocker) {
        const blockerDecisions = userStoriesBlockerQuestionDecisions(blocker);
        questions.push(...blockerDecisions.map((decision, index) => ({
          id: decision.decisionId,
          phaseId: "discovery" as const,
          actionPhaseId: "discovery" as const,
          artifactKey: "user-stories",
          kind: "decision" as const,
          title: blockerDecisions.length === 1
            ? `User Stories ${blocker.status}：需要人工补充事实`
            : `User Stories ${blocker.status}：决定 ${index + 1} / ${blockerDecisions.length}`,
          prompt: cleanMarkdown(decision.question),
          owner: cleanSectionValue(blocker.humanOwner, 200),
          nextAction: cleanSectionValue(blocker.nextStep, 1_000),
          blocking: true,
          response: null,
        })));
      } else if (!assessUserStoriesQuality(stories).valid) {
        questions.push({
          id: "PRODUCT-STORIES-NOT-REVIEWABLE",
          phaseId: "discovery",
          actionPhaseId: "discovery",
          artifactKey: "user-stories",
          kind: "work",
          title: "User Stories 不是可审核产物",
          prompt: "当前 user-stories 既没有符合 Control Pack 的 Story 与验收场景，也没有有效的 versioned 结构化 Blocker。",
          owner: "PM / BA",
          nextAction: "让 PM / BA 在当前 Session 重试：生成真实 Story，或按 v1 Blocker 合同记录事实、问题、人工负责人和下一步。",
          blocking: true,
          response: null,
        });
      }
    }
  }
  return questions;
}

function designDecisionItems(
  artifacts: readonly DecisionArtifact[],
  requiredDeferredValidationIds: readonly string[],
): HumanDecisionItemDto[] {
  const spec = artifacts.find(({ artifactKey }) => artifactKey === "design-spec")?.content;
  if (!spec) return [];
  const envelope = firstJsonObject(spec);
  if (!envelope) {
    const hasJsonFence = /```json\s*[\s\S]*?```/iu.test(spec);
    return [{
      id: hasJsonFence ? "DESIGN-CONTRACT-INVALID" : "DESIGN-CONTRACT-MISSING",
      phaseId: "design",
      actionPhaseId: "design",
      artifactKey: "design-spec",
      kind: "work",
      title: hasJsonFence ? "设计规格的机器合同无法解析" : "设计规格缺少机器合同",
      prompt: hasJsonFence
        ? "design-spec 的首个 fenced JSON 不是有效对象，无法识别状态、阻塞项、开放问题和延后验证。"
        : "design-spec 缺少完整的 machine-readable JSON 合同；deferred_validations 只是该合同中的一个必填数组，并非新的业务决定。",
      owner: "Designer",
      nextAction: "让 Designer 按 design-spec 模板完整重写：文件以有效 fenced JSON 开始，显式填写 status、blockers、open_questions、deferred_validations 和正式工程交接；没有条目时写 []。",
      blocking: true,
      response: null,
    }];
  }
  const items: HumanDecisionItemDto[] = [];
  const blockersFieldValid = Array.isArray(envelope?.blockers);
  const blockers = blockersFieldValid ? envelope!.blockers as unknown[] : [];
  for (const candidate of blockers) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const blocker = candidate as Record<string, unknown>;
    const explicitId = String(blocker.id ?? "").trim();
    const prompt = String(
      blocker.decision ?? blocker.description ?? explicitId ?? "Unspecified design blocker",
    ).trim();
    const owner = String(blocker.owner ?? "Designer").trim();
    const nextAction = String(blocker.next_action ?? blocker.nextAction ?? "解决后更新 design-spec。");
    const id = explicitId || implicitDecisionId(
      "DESIGN-BLOCKER-V2",
      "design-blocker-v2",
      { prompt, owner, nextAction },
    );
    const productDependency = /^(?:B-0[1-3]|PROD-)/iu.test(id)
      || /product|content|产品|内容/iu.test(owner);
    const designerWork = /^B-04$/iu.test(id) || /designer|设计/iu.test(owner);
    const deferredVerification = !productDependency && designerWork && isDeferredDesignVerification({
      id,
      decision: prompt,
      owner,
      nextAction,
    });
    items.push({
      id,
      phaseId: "design",
      actionPhaseId: productDependency ? "discovery" : "design",
      artifactKey: "design-spec",
      kind: productDependency ? "dependency" : designerWork ? "work" : "decision",
      title: conciseTitle(prompt),
      prompt,
      owner,
      nextAction,
      blocking: !deferredVerification,
      response: null,
    });
  }
  const deferredAssessment = assessDeferredDesignValidations(envelope?.deferred_validations);
  const legacyAllDeferred = blockers.length > 0
    && items.length === blockers.length
    && items.every(({ blocking }) => !blocking);
  for (const validation of deferredAssessment.entries) {
    const prompt = `${validation.checks.join("；")}（${validation.targets.join("、")}）`;
    items.push({
      id: validation.id,
      phaseId: "design",
      actionPhaseId: "design",
      artifactKey: "design-spec",
      kind: "work",
      title: conciseTitle(prompt),
      prompt,
      owner: "Tester",
      nextAction: `${validation.evidenceRequired}；发布影响：${validation.releaseImpact}`,
      blocking: false,
      response: null,
    });
  }
  const missingLedgerOnly = deferredAssessment.errors.length === 1
    && deferredAssessment.errors[0] === "deferred_validations must be an explicit array";
  if (deferredAssessment.errors.length > 0 && !(missingLedgerOnly && legacyAllDeferred)) {
    items.push({
      id: "DESIGN-DEFERRED-VALIDATION-INVALID",
      phaseId: "design",
      actionPhaseId: "design",
      artifactKey: "design-spec",
      kind: "work",
      title: "实现后验证清单格式不完整",
      prompt: deferredAssessment.errors.join("；"),
      owner: "Designer",
      nextAction: "按设计 schema 补齐稳定 ID、Tester / Verification 归属、可运行前置条件、目标、检查、通过标准、证据和发布影响。",
      blocking: true,
      response: null,
    });
  }
  const currentDeferredIds = new Set(deferredAssessment.entries.map(({ id }) => id));
  const lostIds = [...new Set(requiredDeferredValidationIds)]
    .filter((id) => !currentDeferredIds.has(id));
  if (lostIds.length > 0) {
    items.push({
      id: "DESIGN-DEFERRED-VALIDATION-LOST",
      phaseId: "design",
      actionPhaseId: "design",
      artifactKey: "design-spec",
      kind: "work",
      title: "实现后验证义务不能从修订历史中消失",
      prompt: `上一版本已记录但当前 deferred_validations 缺少：${lostIds.join("、")}`,
      owner: "Designer",
      nextAction: "只整理正式交接：恢复这些 stable ID 及完整 Tester / Verification 合同；不要删除义务或在 Design 重跑运行时验证。",
      blocking: true,
      response: null,
    });
  }
  if (envelope && !blockersFieldValid) {
    items.push({
      id: "DESIGN-CONTRACT-INVALID",
      phaseId: "design",
      actionPhaseId: "design",
      artifactKey: "design-spec",
      kind: "work",
      title: "设计合同的 blockers 字段无效",
      prompt: "design-spec JSON 必须包含 blockers 数组；字符串、对象或缺失字段都不能通过。",
      owner: "Designer",
      nextAction: "按 spec-schema 修复 machine-readable JSON，并重新运行 validate-spec.mjs。",
      blocking: true,
      response: null,
    });
  }
  const openQuestions = Array.isArray(envelope?.open_questions) ? envelope.open_questions : [];
  for (const question of openQuestions) {
    const prompt = typeof question === "string" ? question.trim() : "";
    if (!prompt) continue;
    const productDependency = /priority|success|threshold|product|content|优先级|成功|阈值|产品|内容/iu.test(prompt);
    items.push({
      id: implicitDecisionId(
        "DESIGN-QUESTION-V2",
        "design-open-question-v2",
        { prompt },
      ),
      phaseId: "design",
      actionPhaseId: productDependency ? "discovery" : "design",
      artifactKey: "design-spec",
      kind: productDependency ? "dependency" : "decision",
      title: conciseTitle(prompt),
      prompt,
      owner: productDependency ? "Human product owner" : "Human design owner",
      nextAction: productDependency
        ? "回到 Product 记录答案并更新产品合同，再让 Designer 同步设计规格。"
        : "可在后续设计迭代中确认；当前问题不得改变本次已明确的实现合同。",
      blocking: productDependency,
      response: null,
    });
  }
  const status = typeof envelope?.status === "string" ? envelope.status.trim().toLowerCase() : "";
  const formalHandoffReady = status === "ready-for-engineering"
    && blockersFieldValid
    && blockers.length === 0;
  if (!formalHandoffReady && items.every(({ blocking }) => !blocking)) {
    const deferredOnly = items.some(({ blocking }) => !blocking);
    items.push({
      id: "DESIGN-HANDOFF-INCOMPLETE",
      phaseId: "design",
      actionPhaseId: "design",
      artifactKey: "design-spec",
      kind: "work",
      title: deferredOnly ? "需要整理一次正式设计交接" : "设计交接尚未达到 ready-for-engineering",
      prompt: deferredOnly
        ? `Design status: ${status || "missing"}；实现后验证已经识别，但正式合同仍未清空 blockers。`
        : `Design status: ${status || "missing"}`,
      owner: "Designer",
      nextAction: deferredOnly
        ? "只整理一次 design-spec：把实现后验证移入 deferred_validations，设置 blockers=[]、status=ready-for-engineering；不要再次尝试运行该验证。"
        : "完成设计行为、响应式、无障碍和验证证据后更新状态。",
      blocking: true,
      response: null,
    });
  }
  return items;
}

function architectureDecisionItems(artifacts: readonly DecisionArtifact[]): HumanDecisionItemDto[] {
  const items: HumanDecisionItemDto[] = [];
  for (const artifact of artifacts) {
    if (!artifact.artifactKey.startsWith("architecture")) continue;
    const section = markdownSection(artifact.content, [
      "Open Human Decisions",
      "Open decisions",
      "Evidence still missing",
    ]);
    for (const raw of uncheckedItems(section)) {
      const rawPrompt = cleanMarkdown(raw);
      if (isArchitectureSelectionChecklistItem(rawPrompt)) continue;
      const observabilityRuleId = /\bOBS-002\b/iu.test(rawPrompt);
      const prompt = observabilityRuleId
        ? "当前应用是纯浏览器前端。请选择：采用不远程上传的本地最小诊断，或接入已有监控平台；两者都必须明确字段、脱敏规则和负责人，且不得记录儿童输入、答案、自由文本或凭据。"
        : rawPrompt;
      const id = observabilityRuleId
        ? "ARCH-OBS-002"
        : explicitItemId(raw) ?? implicitDecisionId(
            "ARCHITECTURE-QUESTION-V2",
            "architecture-open-question-v2",
            { artifactKey: artifact.artifactKey, prompt },
          );
      const productDependency = /^(?:PROD-|B-0[1-3])/iu.test(id);
      const designDependency = /^(?:DES-|B-04)/iu.test(id);
      const acceptance = /^ARCH-(?:04|ACCEPT)/iu.test(id);
      items.push({
        id,
        phaseId: "architecture",
        actionPhaseId: productDependency ? "discovery" : designDependency ? "design" : "architecture",
        artifactKey: artifact.artifactKey,
        kind: productDependency || designDependency ? "dependency" : acceptance ? "acceptance" : "decision",
        title: observabilityRuleId ? "浏览器错误信息写到哪里？" : conciseTitle(prompt),
        prompt,
        owner: observabilityRuleId
          ? "Human architecture / operations owner"
          : ownerFromPrompt(prompt, acceptance ? "Human architecture owner" : "Human decision owner"),
        nextAction: acceptance
          ? "其余架构决定关闭后，通过本阶段即记录最终人工接受。"
          : observabilityRuleId
            ? "选定一条诊断政策并保存；随后只重跑一次 Architect，让它关闭 OBS-002 并刷新当前 options 检查点。"
          : productDependency
            ? "回到 Product 记录答案并更新产品合同。"
            : designDependency
              ? "回到 Design 完成验证并更新设计交接。"
              : "记录决定后让 Architect 更新 NFR、ADR 和架构索引。",
        blocking: !acceptance,
        response: null,
      });
    }
  }
  const index = artifacts.find(({ artifactKey }) => artifactKey === "architecture")?.content ?? "";
  const status = markdownStrongField(index, "Status") ?? "";
  const awaitingCurrentSelection = /(?:awaiting|等待)[^\n]*(?:platform[- ]verified\s+)?(?:option\s+)?selection|等待[^\n]*选型/iu
    .test(status);
  if (
    items.every(({ blocking }) => !blocking)
    && /\bblocked\b/iu.test(status)
    && !awaitingCurrentSelection
  ) {
    items.push({
      id: "ARCHITECTURE-HANDOFF-INCOMPLETE",
      phaseId: "architecture",
      actionPhaseId: "architecture",
      artifactKey: "architecture",
      kind: "work",
      title: "架构包仍明确标记为 Blocked",
      prompt: `Architecture Status: ${status}`,
      owner: "Architect",
      nextAction: "关闭具体依赖、决定和验证缺口后重新生成架构包。",
      blocking: true,
      response: null,
    });
  }
  return items;
}

function isArchitectureSelectionChecklistItem(prompt: string): boolean {
  return /platform[- ]verified\s+selection|选型(?:对象|记录|证据)|record[^.。；;]{0,80}(?:option\s+)?selection/iu
    .test(prompt);
}

function capturedResponses(
  reviews: readonly ReviewDto[],
  artifacts: readonly DecisionArtifact[],
): Map<string, string> {
  const responses = new Map<string, string>();
  const currentBlocker = currentUserStoriesBlockerDecision(artifacts);
  const currentProductQuestions = currentProductOpenQuestionDecisions(artifacts);
  for (const { review, capture } of concreteHumanDecisionCaptures(reviews)) {
    for (const response of capture.responses) {
      let responseId = response.id;
      if (responseId === "PRODUCT-STORIES-BLOCKER-V1") {
        if (
          !currentBlocker
          || currentBlocker.decisionIds.length !== 1
          || capture.phaseId !== "discovery"
          || currentBlocker.artifactId === null
          || !review.artifactIds.includes(currentBlocker.artifactId)
        ) continue;
        responseId = currentBlocker.decisionIds[0]!;
      } else if (
        (
          responseId.startsWith("PRODUCT-STORIES-BLOCKER-V2-")
          || responseId.startsWith("PRODUCT-STORIES-QUESTION-V3-")
        )
        && capture.phaseId !== "discovery"
      ) {
        continue;
      } else if (responseId.startsWith("PRODUCT-QUESTION-V2-")) {
        if (capture.phaseId !== "discovery") continue;
      } else if (responseId.startsWith("PRODUCT-HANDOFF-V2-")) {
        if (capture.phaseId !== "discovery") continue;
      } else if (
        responseId.startsWith("DESIGN-BLOCKER-V2-")
        || responseId.startsWith("DESIGN-QUESTION-V2-")
      ) {
        if (capture.phaseId !== "design") continue;
      } else if (responseId.startsWith("ARCHITECTURE-QUESTION-V2-")) {
        if (capture.phaseId !== "architecture") continue;
      } else if (/^PROD-Q-\d+$/u.test(responseId)) {
        if (capture.phaseId !== "discovery") continue;
        // A persisted PROD-Q-01 record is ambiguous: older Runs used it as a
        // positional fallback, while a PRD may also declare it explicitly.
        // Bind every numeric compatibility ID to the exact reviewed PRD head
        // so an old positional answer can never attach to a later explicit ID.
        const matchingQuestion = currentProductQuestions.find(({ decisionId, legacyId }) => (
          decisionId === responseId || legacyId === responseId
        ));
        if (
          !matchingQuestion
          || matchingQuestion.artifactId === null
          || !review.artifactIds.includes(matchingQuestion.artifactId)
        ) continue;
        responseId = matchingQuestion.decisionId;
      } else if (isArtifactBoundLegacyDecisionId(responseId)) {
        const target = currentLegacyDecisionTarget(responseId, artifacts);
        if (
          !target
          || capture.phaseId !== target.phaseId
          || (
            target.requiresExactArtifactHead
            && (
              target.artifactId === null
              || !review.artifactIds.includes(target.artifactId)
            )
          )
        ) continue;
        responseId = target.decisionId;
      }
      if (!responses.has(responseId)) responses.set(responseId, response.response);
    }
  }
  return responses;
}

function currentUserStoriesBlockerDecision(
  artifacts: readonly DecisionArtifact[],
): {
  artifactId: string | null;
  decisionIds: string[];
  scope: UserStoriesBlockerDecisionScope;
} | null {
  const artifact = artifacts.find(({ artifactKey }) => artifactKey === "user-stories");
  if (!artifact) return null;
  const blocker = parseUserStoriesBlocker(artifact.content);
  if (!blocker) return null;
  const decisions = userStoriesBlockerQuestionDecisions(blocker);
  const scope = userStoriesBlockerDecisionScope(blocker);
  if (decisions.length === 0 || !scope) return null;
  return {
    artifactId: artifact.id?.trim() || null,
    decisionIds: decisions.map(({ decisionId }) => decisionId),
    scope,
  };
}

interface ProductOpenQuestionDecision {
  artifactId: string | null;
  decisionId: string;
  legacyId: string | null;
  question: string;
}

function currentProductOpenQuestionDecisions(
  artifacts: readonly DecisionArtifact[],
): ProductOpenQuestionDecision[] {
  const artifact = artifacts.find(({ artifactKey }) => artifactKey === "prd");
  if (!artifact) return [];
  return productOpenQuestionDecisions(artifact.content).map((decision) => ({
    ...decision,
    artifactId: artifact.id?.trim() || null,
  }));
}

function productOpenQuestionDecisions(
  prd: string,
): Array<Omit<ProductOpenQuestionDecision, "artifactId">> {
  const section = markdownSection(prd, [
    "Open questions for a human",
    "Open human decisions",
    "Open questions",
    "开放问题",
    "待确认问题",
    "待决策问题",
  ]);
  return unresolvedQuestionItems(section).map((question, index) => {
    const explicitId = explicitItemId(question);
    return {
      question,
      decisionId: explicitId ?? productQuestionDecisionId(question),
      legacyId: explicitId ? null : `PROD-Q-${String(index + 1).padStart(2, "0")}`,
    };
  });
}

function productQuestionDecisionId(question: string): string {
  const normalizedQuestion = cleanMarkdown(question)
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      namespace: "product-open-question-v2",
      phaseId: "discovery",
      artifactKey: "prd",
      question: normalizedQuestion,
    }))
    .digest("hex");
  return `PRODUCT-QUESTION-V2-${fingerprint.slice(0, 24)}`;
}

type ImplicitDecisionIdentity = Readonly<Record<string, string | readonly string[]>>;

function implicitDecisionId(
  prefix: string,
  namespace: string,
  identity: ImplicitDecisionIdentity,
): string {
  const normalizedIdentity = Object.fromEntries(
    Object.entries(identity)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        key,
        Array.isArray(value)
          ? value.map(normalizedDecisionIdentityText)
          : normalizedDecisionIdentityText(value as string),
      ]),
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ namespace, identity: normalizedIdentity }))
    .digest("hex");
  return `${prefix}-${fingerprint.slice(0, 24)}`;
}

function normalizedDecisionIdentityText(value: string): string {
  return cleanMarkdown(value)
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
}

interface LegacyDecisionTarget {
  phaseId: HumanDecisionPhaseId;
  artifactId: string | null;
  decisionId: string;
  requiresExactArtifactHead: boolean;
}

function isArtifactBoundLegacyDecisionId(responseId: string): boolean {
  return responseId === "PRODUCT-STORIES-BLOCKER-V1"
    || responseId === "PRODUCT-HANDOFF-INCOMPLETE"
    || /^PROD-Q-\d+$/u.test(responseId)
    || /^DES-Q-\d+$/u.test(responseId)
    || /^DES-BLOCKER-\d+$/u.test(responseId)
    || /^ARCH-Q-\d+$/u.test(responseId);
}

function currentLegacyDecisionTarget(
  responseId: string,
  artifacts: readonly DecisionArtifact[],
): LegacyDecisionTarget | null {
  if (responseId === "PRODUCT-HANDOFF-INCOMPLETE") {
    const artifact = artifacts.find(({ artifactKey }) => artifactKey === "prd");
    if (!artifact) return null;
    const decision = productDecisionItems([artifact], false).find(({ id }) => (
      id.startsWith("PRODUCT-HANDOFF-V2-")
    ));
    return decision
      ? {
          phaseId: "discovery",
          artifactId: artifact.id?.trim() || null,
          decisionId: decision.id,
          requiresExactArtifactHead: true,
        }
      : null;
  }

  const designArtifact = artifacts.find(({ artifactKey }) => artifactKey === "design-spec");
  if (/^DES-Q-\d+$/u.test(responseId)) {
    if (!designArtifact) return null;
    const envelope = firstJsonObject(designArtifact.content);
    const openQuestions = Array.isArray(envelope?.open_questions) ? envelope.open_questions : [];
    const questionIndex = legacyDecisionIndex(responseId);
    if (questionIndex === null) return null;
    const prompt = typeof openQuestions[questionIndex] === "string"
      ? openQuestions[questionIndex].trim()
      : "";
    return prompt
      ? {
          phaseId: "design",
          artifactId: designArtifact.id?.trim() || null,
          decisionId: implicitDecisionId(
            "DESIGN-QUESTION-V2",
            "design-open-question-v2",
            { prompt },
          ),
          requiresExactArtifactHead: true,
        }
      : null;
  }

  if (/^DES-BLOCKER-\d+$/u.test(responseId)) {
    if (!designArtifact) return null;
    const envelope = firstJsonObject(designArtifact.content);
    const blockers = Array.isArray(envelope?.blockers) ? envelope.blockers : [];
    const blockerIndex = legacyDecisionIndex(responseId);
    if (blockerIndex === null) return null;
    const candidate = blockers[blockerIndex];
    if (typeof candidate !== "object" || candidate === null) return null;
    const blocker = candidate as Record<string, unknown>;
    const explicitId = String(blocker.id ?? "").trim();
    if (explicitId) {
      return explicitId === responseId
        ? {
            phaseId: "design",
            artifactId: designArtifact.id?.trim() || null,
            decisionId: explicitId,
            // DES-BLOCKER-n was historically an implicit position. A stored
            // capture cannot prove whether the old occurrence was explicit,
            // so this reserved shape must remain bound to the reviewed head.
            requiresExactArtifactHead: true,
          }
        : null;
    }
    const prompt = String(
      blocker.decision ?? blocker.description ?? "Unspecified design blocker",
    ).trim();
    const owner = String(blocker.owner ?? "Designer").trim();
    const nextAction = String(blocker.next_action ?? blocker.nextAction ?? "解决后更新 design-spec。");
    return {
      phaseId: "design",
      artifactId: designArtifact.id?.trim() || null,
      decisionId: implicitDecisionId(
        "DESIGN-BLOCKER-V2",
        "design-blocker-v2",
        { prompt, owner, nextAction },
      ),
      requiresExactArtifactHead: true,
    };
  }

  if (/^ARCH-Q-\d+$/u.test(responseId)) {
    const index = legacyDecisionIndex(responseId);
    if (index === null) return null;
    const candidates = artifacts.flatMap((artifact) => {
      if (!artifact.artifactKey.startsWith("architecture")) return [];
      const section = markdownSection(artifact.content, [
        "Open Human Decisions",
        "Open decisions",
        "Evidence still missing",
      ]);
      const raw = uncheckedItems(section)[index];
      if (!raw) return [];
      const explicitId = explicitItemId(raw);
      if (explicitId) {
        return explicitId === responseId
          ? [{
              phaseId: "architecture" as const,
              artifactId: artifact.id?.trim() || null,
              decisionId: explicitId,
              // ARCH-Q-n was historically an implicit position. Treat even a
              // later explicit collision as artifact-bound because the old
              // Review does not carry enough evidence to distinguish them.
              requiresExactArtifactHead: true,
            }]
          : [];
      }
      const prompt = cleanMarkdown(raw);
      if (!prompt || /\bOBS-002\b/iu.test(prompt) || isArchitectureSelectionChecklistItem(prompt)) {
        return [];
      }
      return [{
        phaseId: "architecture" as const,
        artifactId: artifact.id?.trim() || null,
        decisionId: implicitDecisionId(
          "ARCHITECTURE-QUESTION-V2",
          "architecture-open-question-v2",
          { artifactKey: artifact.artifactKey, prompt },
        ),
        requiresExactArtifactHead: true,
      }];
    });
    return candidates.length === 1 ? candidates[0]! : null;
  }

  return null;
}

function legacyDecisionIndex(responseId: string): number | null {
  const parsed = Number.parseInt(/(\d+)$/u.exec(responseId)?.[1] ?? "0", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed - 1 : null;
}

function newestReviews(reviews: readonly ReviewDto[]): ReviewDto[] {
  return [...reviews].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function compactDecisionResponse(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function isConcreteHumanDecisionResponse(value: string): boolean {
  return Boolean(value)
    && !isGenericHumanDecisionResponse(value)
    && !isExplicitlyNonClosingHumanDecisionResponse(value);
}

function isExplicitlyNonClosingHumanDecisionResponse(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/^(?:answer|decision|status|答案|决定|状态)\s*[:：-]\s*/iu, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (
    /^(?:tbd\b|unknown\b|undecided\b|pending\b|defer(?:red)?\b|postpone(?:d)?\b|decide\s+later\b|to\s+be\s+(?:decided|determined|confirmed)\b|not\s+(?:yet\s+)?(?:decided|known)\b|no\s+decision\b|(?:keep|leave|remain|continue)\b.*\bopen\b)/iu.test(normalized)
    || /^(?:待定|未知|不知道|不确定|尚未决定|未决定|待确认|暂不决定|暂缓|延后|推迟|稍后(?:再)?决定|以后(?:再)?决定|以后再说|继续开放|保持开放|留待后续)/u.test(normalized)
  );
}

function boundedDecisionResponse(value: string): string {
  if (value.length <= providerDecisionResponseLimit) return value;
  return `${value.slice(0, providerDecisionResponseLimit - 1)}…`;
}

function dedupeOrExposeDecisionIdConflicts(
  items: readonly HumanDecisionItemDto[],
): HumanDecisionItemDto[] {
  const groups = new Map<string, HumanDecisionItemDto[]>();
  for (const item of items) {
    const key = `${item.artifactKey}\u0000${item.id}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const conflictingKeys = new Set(
    [...groups.entries()].flatMap(([key, group]) => (
      new Set(group.map(decisionItemSemanticFingerprint)).size > 1 ? [key] : []
    )),
  );
  const result = new Map<string, HumanDecisionItemDto>();
  const collisionOrdinals = new Map<string, number>();
  for (const item of items) {
    const groupKey = `${item.artifactKey}\u0000${item.id}`;
    if (conflictingKeys.has(groupKey)) {
      const ordinal = (collisionOrdinals.get(groupKey) ?? 0) + 1;
      collisionOrdinals.set(groupKey, ordinal);
      const collisionId = `DECISION-ID-CONFLICT-${createHash("sha256")
        .update(JSON.stringify({
          namespace: "decision-id-semantic-conflict-v1",
          artifactKey: item.artifactKey,
          originalId: item.id,
          semantic: decisionItemSemanticFingerprint(item),
          ordinal,
        }))
        .digest("hex")
        .slice(0, 24)}`;
      result.set(collisionId, {
        ...item,
        id: collisionId,
        kind: "work",
        title: `重复 Decision ID ${item.id} 存在语义冲突`,
        prompt: `同一 ${item.artifactKey} 中的 Decision ID ${item.id} 被用于不同事项（第 ${ordinal} 项）：${item.prompt}`,
        owner: item.phaseId === "discovery"
          ? "PM / BA"
          : item.phaseId === "design"
            ? "Designer"
            : "Architect",
        nextAction: `修正 ${item.artifactKey}：为不同语义分配唯一稳定 ID，或合并真正相同的事项；冲突修复前任何同名答案都不能关闭这些事项。`,
        blocking: true,
        response: null,
      });
      continue;
    }
    if (!result.has(item.id)) result.set(item.id, item);
  }
  return [...result.values()];
}

function decisionItemSemanticFingerprint(item: HumanDecisionItemDto): string {
  return JSON.stringify({
    phaseId: item.phaseId,
    actionPhaseId: item.actionPhaseId,
    kind: item.kind,
    prompt: normalizedDecisionIdentityText(item.prompt),
    owner: normalizedDecisionIdentityText(item.owner),
    nextAction: normalizedDecisionIdentityText(item.nextAction),
  });
}

function markdownSection(content: string, headings: readonly string[]): string {
  const wanted = new Set(headings.map(normalizeHeading));
  const lines = content.split(/\r?\n/u);
  let start = -1;
  let level = 0;
  for (const [index, line] of lines.entries()) {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    if (start < 0 && wanted.has(normalizeHeading(match[2] ?? ""))) {
      start = index + 1;
      level = match[1]?.length ?? 2;
      continue;
    }
    if (start >= 0 && (match[1]?.length ?? 7) <= level) return lines.slice(start, index).join("\n");
  }
  return start >= 0 ? lines.slice(start).join("\n") : "";
}

function uncheckedItems(content: string): string[] {
  return content.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*[-*]\s+\[\s\]\s+(.+?)\s*$/u.exec(line);
    return match?.[1] ? [match[1].trim()] : [];
  });
}

function unresolvedQuestionItems(content: string): string[] {
  const items = content.split(/\r?\n/u).flatMap((line) => {
    if (/^[ \t]*(?:>[ \t]*)?[-*+][ \t]+\[[xX]\][ \t]+/u.test(line)) return [];
    const match = /^[ \t]*(?:>[ \t]*)?(?:(?:[-*+][ \t]+(?:\[[ \t]\][ \t]+)?)|(?:\d+[.)、][ \t]*))(.+?)[ \t]*$/u
      .exec(line);
    const value = match?.[1]?.trim() ?? "";
    return value && !/^(?:none(?:[ \t]+at[ \t]+this[ \t]+time)?|n\/?a|无|暂无|没有|无待确认事项)[.!。\s-]*$/iu.test(value)
      ? [value]
      : [];
  });
  return [...new Set([
    ...uncheckedItems(content),
    ...items,
  ])];
}

function explicitItemId(content: string): string | null {
  return /^(?:\*\*)?([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)(?:\s*\/\s*[A-Za-z][A-Za-z0-9-]+)?(?:\*\*)?\s*[:：]/u.exec(content)?.[1] ?? null;
}

function cleanMarkdown(content: string): string {
  return content.replace(/\*\*|`/gu, "").trim();
}

function cleanSectionValue(content: string, maxCharacters: number): string {
  return cleanMarkdown(content)
    .replace(/^[ \t]*[-*+][ \t]+/gmu, "")
    .trim()
    .slice(0, maxCharacters);
}

function conciseTitle(content: string): string {
  const cleaned = cleanMarkdown(content).replace(/^(?:[A-Za-z][A-Za-z0-9-]+)\s*[:：]\s*/u, "");
  return (cleaned.split(/[。；;？?]/u)[0] ?? cleaned).trim().slice(0, 120);
}

function normalizeHeading(content: string): string {
  return content
    .trim()
    .replace(/^\d+(?:\.\d+)*[.)、]?[ \t]*/u, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function markdownStrongField(content: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\*\\*${escaped}:\\*\\*[ \\t]*(.+?)[ \\t]*$`, "imu")
    .exec(content)?.[1]?.trim() ?? null;
}

function firstJsonObject(content: string): Record<string, unknown> | null {
  const match = /```json\s*([\s\S]*?)```/iu.exec(content);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function ownerFromPrompt(prompt: string, fallback: string): string {
  const match = /((?:Product|Design|Architecture|Security|Operations|产品|设计|架构|安全|运维)[^。；;]{0,40}(?:owner|负责人))/iu.exec(prompt);
  return match?.[1]?.trim() ?? fallback;
}

function phaseLabel(phaseId: HumanDecisionPhaseId): string {
  return phaseId === "discovery" ? "Product" : phaseId === "design" ? "Design" : "Architecture";
}
