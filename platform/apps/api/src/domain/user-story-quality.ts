import { createHash } from "node:crypto";

import { AppError } from "./errors.js";
import {
  hasValidUserStoryHeading,
  parseUserStoryTicketEntries,
  type UserStoryFileEntry,
} from "./user-story-tickets.js";

export const USER_STORIES_BLOCKER_SENTINEL = "<!-- ai-sdlc:user-stories-blocker:v1 -->";

export type UserStoriesQuality =
  | { valid: true; kind: "stories" | "blocker" }
  | {
      valid: false;
      reason: "invalid-stories" | "missing-story-or-blocker";
      issues: UserStoriesQualityIssue[];
    };

export type UserStoriesQualityIssue =
  | "STORY_CANONICAL_FILE_REQUIRED"
  | "STORY_HEADING_INVALID"
  | "STORY_IDS_MUST_BE_UNIQUE"
  | "STORY_TEMPLATE_TOKEN_PRESENT"
  | "STORY_TWO_AC_SCENARIOS_REQUIRED"
  | "STORY_NONCANONICAL_CONTENT_REQUIRES_STORY"
  | "BLOCKER_ROOT_README_REQUIRED"
  | "BLOCKER_SENTINEL_MUST_BE_UNIQUE"
  | "BLOCKER_STATUS_MUST_BE_EXACT"
  | "BLOCKER_MISSING_FACTS_REQUIRED"
  | "BLOCKER_OPEN_QUESTIONS_REQUIRED"
  | "BLOCKER_HUMAN_OWNER_REQUIRED"
  | "BLOCKER_NEXT_STEP_REQUIRED"
  | "BLOCKER_KNOWN_FACTS_INVALID"
  | "BLOCKER_OPEN_QUESTION_NOT_SPECIFIC"
  | "BLOCKER_ANSWER_NOT_MATERIALIZED"
  | "BLOCKER_WORKFLOW_MECHANISM_FORBIDDEN";

export interface UserStoriesBlocker {
  status: "Blocked" | "Pending";
  facts: string;
  missingFacts: string;
  missingFactItems: string[];
  openQuestions: string;
  openQuestionItems: string[];
  humanOwner: string;
  humanOwners: string[];
  nextStep: string;
  nextSteps: string[];
}

export interface UserStoriesBlockerQuestionDecision {
  decisionId: string;
  fingerprint: string;
  question: string;
}

/**
 * Immutable content scope for one answered Blocker. The aggregate fingerprint
 * preserves the existing exact-match contract, while the item fingerprints
 * let the runner recognize a Provider output that merely deletes or reorders
 * already answered facts/questions to manufacture a new aggregate identity.
 */
export interface UserStoriesBlockerDecisionScope {
  aggregateFingerprint: string;
  missingFactFingerprints: string[];
  openQuestionFingerprints: string[];
}

export interface UserStoriesBlockerDraft {
  status: "Blocked" | "Pending";
  knownFacts: readonly string[];
  missingFacts: readonly string[];
  openQuestions: readonly string[];
  humanOwners: readonly string[];
  nextSteps: readonly string[];
}

type BlockerContentKind =
  | "known-fact"
  | "missing-fact"
  | "open-question"
  | "human-owner"
  | "next-step";

/**
 * Render the versioned Blocker contract from structured facts. The Provider
 * chooses the facts, while the platform owns syntax that must be byte-stable
 * for the deterministic review gate (sentinel, headings, status and bullets).
 */
export function renderUserStoriesBlocker(draft: UserStoriesBlockerDraft): string {
  const knownFacts = normalizedBlockerItems(
    draft.knownFacts,
    "Known facts",
    false,
    "known-fact",
  );
  const missingFacts = normalizedBlockerItems(
    draft.missingFacts,
    "Missing facts",
    true,
    "missing-fact",
  );
  const openQuestions = normalizedBlockerItems(
    draft.openQuestions,
    "Open questions",
    true,
    "open-question",
  );
  const humanOwners = normalizedBlockerItems(
    draft.humanOwners,
    "Human owner",
    true,
    "human-owner",
  );
  const nextSteps = normalizedBlockerItems(
    draft.nextSteps,
    "Next step",
    true,
    "next-step",
  );
  const markdown = [
    USER_STORIES_BLOCKER_SENTINEL,
    "",
    "# User Stories Blocker",
    "",
    `Status: ${draft.status}`,
    ...(knownFacts.length > 0 ? ["", "## Known facts", "", ...bullets(knownFacts)] : []),
    "",
    "## Missing facts",
    "",
    ...bullets(missingFacts),
    "",
    "## Open questions",
    "",
    ...bullets(openQuestions),
    "",
    "## Human owner",
    "",
    ...bullets(humanOwners),
    "",
    "## Next step",
    "",
    ...bullets(nextSteps),
    "",
  ].join("\n");
  const assessment = assessUserStoriesQualityEntries([{
    relativePath: "README.md",
    content: markdown,
  }]);
  if (!assessment.valid || assessment.kind !== "blocker") {
    throw new AppError(
      "User Stories Blocker 结构化内容未通过平台质量检查",
      422,
      "INVALID_USER_STORIES_BLOCKER_DRAFT",
      { issues: assessment.valid ? [] : assessment.issues },
    );
  }
  return markdown;
}

/**
 * Compatibility entry point for persisted aggregate snapshots. Runtime gates
 * must prefer assessUserStoriesQualityEntries so Markdown in one file cannot
 * manufacture another file boundary.
 */
export function assessUserStoriesQuality(snapshot: string): UserStoriesQuality {
  return assessUserStoriesQualityEntries(snapshotEntries(snapshot));
}

export function assessUserStoriesQualityEntries(
  entries: readonly UserStoryFileEntry[],
): UserStoriesQuality {
  const readmes = rootReadmes(entries);
  const blockerIntent = entries.some(({ content }) => (
    content.toLocaleLowerCase("en-US").includes(USER_STORIES_BLOCKER_SENTINEL)
  ))
    || readmes.some((readme) => /^#[ \t]+User Stories Blocker[ \t]*$/imu.test(readme));
  if (blockerIntent) {
    const assessment = assessBlocker(entries, readmes);
    return assessment.blocker
      ? { valid: true, kind: "blocker" }
      : {
          valid: false,
          reason: "missing-story-or-blocker",
          issues: assessment.issues,
        };
  }
  const storyFiles = entries.filter(({ relativePath }) => isStoryFile(relativePath));
  const ticketAssessment = parseTicketAssessment(entries);
  if (reviewableStorySet(ticketAssessment.tickets)) return { valid: true, kind: "stories" };
  const issues: UserStoriesQualityIssue[] = [];
  if (ticketAssessment.duplicateIds) issues.push("STORY_IDS_MUST_BE_UNIQUE");
  if (storyFiles.length === 0) {
    issues.push(entries.some(({ content }) => content.trim().length > 0)
      ? "STORY_NONCANONICAL_CONTENT_REQUIRES_STORY"
      : "STORY_CANONICAL_FILE_REQUIRED");
  } else if (storyFiles.some(({ content }) => !hasValidUserStoryHeading(content))) {
    issues.push("STORY_HEADING_INVALID");
  }
  if (ticketAssessment.tickets.length > 0) {
    if (ticketAssessment.tickets.some(({ content }) => hasCanonicalTemplateToken(content))) {
      issues.push("STORY_TEMPLATE_TOKEN_PRESENT");
    }
    if (!ticketAssessment.tickets.some(({ content, storyKey }) => (
      !hasCanonicalTemplateToken(content)
      && hasReviewableAcceptanceCriteria(content, storyKey)
    ))) {
      issues.push("STORY_TWO_AC_SCENARIOS_REQUIRED");
    }
  }
  return {
    valid: false,
    reason: storyFiles.length > 0 || ticketAssessment.duplicateIds
      ? "invalid-stories"
      : "missing-story-or-blocker",
    issues: [...new Set(issues)],
  };
}

export function parseUserStoriesBlocker(snapshot: string): UserStoriesBlocker | null {
  return parseUserStoriesBlockerEntries(snapshotEntries(snapshot));
}

export function parseUserStoriesBlockerEntries(
  entries: readonly UserStoryFileEntry[],
): UserStoriesBlocker | null {
  return assessBlocker(entries, rootReadmes(entries)).blocker;
}

/**
 * Content identity for one concrete product-decision occurrence. It is not a
 * semantic similarity score: a materially reworded question intentionally
 * receives a new identity so the platform never treats an old answer as proof
 * for a potentially new business decision.
 */
export function userStoriesBlockerDecisionFingerprint(
  input: string | UserStoriesBlocker,
): string | null {
  const blocker = resolvedUserStoriesBlocker(input);
  if (!blocker) return null;
  const decisionIdentity = JSON.stringify({
    namespace: "ai-sdlc:user-stories-blocker-decision:v2",
    phaseId: "discovery",
    artifactKey: "user-stories",
    missingFacts: normalizedFingerprintBullets(blocker.missingFacts),
    openQuestions: normalizedFingerprintBullets(blocker.openQuestions),
  });
  return createHash("sha256").update(decisionIdentity).digest("hex");
}

export function userStoriesBlockerDecisionId(
  input: string | UserStoriesBlocker,
): string | null {
  const fingerprint = userStoriesBlockerDecisionFingerprint(input);
  return fingerprint ? `PRODUCT-STORIES-BLOCKER-V2-${fingerprint.slice(0, 24)}` : null;
}

export function userStoriesBlockerDecisionScope(
  input: string | UserStoriesBlocker,
): UserStoriesBlockerDecisionScope | null {
  const blocker = resolvedUserStoriesBlocker(input);
  if (!blocker) return null;
  const aggregateFingerprint = userStoriesBlockerDecisionFingerprint(blocker);
  if (!aggregateFingerprint) return null;
  return {
    aggregateFingerprint,
    missingFactFingerprints: blockerScopeItemFingerprints(
      "missing-fact",
      blocker.missingFactItems,
    ),
    openQuestionFingerprints: blockerScopeItemFingerprints(
      "open-question",
      blocker.openQuestionItems,
    ),
  };
}

/**
 * True when a candidate contains only facts and questions from an answered
 * scope. Both parsed collections are non-empty, so a Provider cannot pass by
 * erasing the Blocker body. New or materially reworded context remains a new
 * human decision and is deliberately not covered.
 */
export function isUserStoriesBlockerDecisionScopeCovered(
  candidate: UserStoriesBlockerDecisionScope,
  answered: UserStoriesBlockerDecisionScope,
): boolean {
  if (
    candidate.missingFactFingerprints.length === 0
    || candidate.openQuestionFingerprints.length === 0
  ) return false;
  const answeredFacts = new Set(answered.missingFactFingerprints);
  const answeredQuestions = new Set(answered.openQuestionFingerprints);
  return candidate.missingFactFingerprints.every((fingerprint) => answeredFacts.has(fingerprint))
    && candidate.openQuestionFingerprints.every((fingerprint) => answeredQuestions.has(fingerprint));
}

/**
 * A multi-question Blocker exposes one decision card per concrete question.
 * The single-question case intentionally retains its V2 identity so existing
 * reviewed decisions remain compatible. Multi-question identities bind the
 * complete missing-fact context plus one normalized question; reordering does
 * not change them, while changed context safely creates a new decision.
 */
export function userStoriesBlockerQuestionDecisions(
  input: string | UserStoriesBlocker,
): UserStoriesBlockerQuestionDecision[] {
  const blocker = resolvedUserStoriesBlocker(input);
  if (!blocker) return [];
  if (blocker.openQuestionItems.length === 1) {
    const fingerprint = userStoriesBlockerDecisionFingerprint(blocker);
    const decisionId = userStoriesBlockerDecisionId(blocker);
    return fingerprint && decisionId ? [{
      fingerprint,
      decisionId,
      question: blocker.openQuestionItems[0]!,
    }] : [];
  }
  const missingFacts = normalizedFingerprintBullets(blocker.missingFacts);
  return blocker.openQuestionItems.map((question) => {
    const fingerprint = createHash("sha256").update(JSON.stringify({
      namespace: "ai-sdlc:user-stories-blocker-question:v3",
      phaseId: "discovery",
      artifactKey: "user-stories",
      missingFacts,
      openQuestion: normalizedBlockerText(question).toLocaleLowerCase("en-US"),
    })).digest("hex");
    return {
      fingerprint,
      decisionId: `PRODUCT-STORIES-QUESTION-V3-${fingerprint.slice(0, 24)}`,
      question,
    };
  });
}

function blockerScopeItemFingerprints(
  kind: "missing-fact" | "open-question",
  items: readonly string[],
): string[] {
  return [...new Set(items.map((item) => createHash("sha256").update(JSON.stringify({
    namespace: "ai-sdlc:user-stories-blocker-scope-item:v1",
    phaseId: "discovery",
    artifactKey: "user-stories",
    kind,
    value: normalizedBlockerText(item).toLocaleLowerCase("en-US"),
  })).digest("hex")))].sort((left, right) => left.localeCompare(right, "en"));
}

function resolvedUserStoriesBlocker(
  input: string | UserStoriesBlocker,
): UserStoriesBlocker | null {
  return typeof input === "string"
    ? parseUserStoriesBlocker(input) ?? parseUserStoriesBlockerEntries([{
        relativePath: "README.md",
        content: input,
      }])
    : input;
}

function assessBlocker(
  entries: readonly UserStoryFileEntry[],
  readmes: readonly string[],
): { blocker: UserStoriesBlocker | null; issues: UserStoriesQualityIssue[] } {
  if (readmes.length !== 1) {
    return { blocker: null, issues: ["BLOCKER_ROOT_README_REQUIRED"] };
  }
  const readme = readmes[0]!;
  const issues: UserStoriesQualityIssue[] = [];
  const sentinelCount = entries.reduce(
    (count, { content }) => count + occurrencesCaseInsensitive(
      content,
      USER_STORIES_BLOCKER_SENTINEL,
    ),
    0,
  );
  const sentinelLines = readme.split(/\r?\n/u).filter(
    // A casing variant is blocker intent and counts toward uniqueness, but only
    // the platform-owned byte-exact marker is a valid canonical root line.
    (line) => line.trim() === USER_STORIES_BLOCKER_SENTINEL,
  );
  if (sentinelCount !== 1 || sentinelLines.length !== 1) {
    issues.push("BLOCKER_SENTINEL_MUST_BE_UNIQUE");
  }

  const statusMatches = [...readme.matchAll(
    /^[ \t]*(?:Status[ \t]*[:：]|\*\*Status[ \t]*[:：]\*\*)[ \t]*(Blocked|Pending)[ \t]*$/gimu,
  )];
  if (statusMatches.length !== 1) issues.push("BLOCKER_STATUS_MUST_BE_EXACT");
  const statusValue = statusMatches[0]?.[1];
  const status = statusValue?.toLocaleLowerCase("en-US") === "blocked"
    ? "Blocked" as const
    : statusValue?.toLocaleLowerCase("en-US") === "pending"
      ? "Pending" as const
      : null;
  const sections = h2Sections(readme);
  const knownFacts = uniqueSection(sections, ["Known facts", "已知事实"], false);
  const missingFacts = uniqueSection(sections, ["Missing facts", "缺失事实"], true);
  const openQuestions = uniqueSection(sections, [
    "Open questions",
    "Questions requiring human answer",
    "待回答问题",
    "待确认问题",
  ], true);
  const humanOwner = uniqueSection(sections, [
    "Human owner",
    "Decision owner",
    "人工负责人",
    "决策负责人",
  ], true);
  const nextStep = uniqueSection(
    sections,
    ["Next step", "Next action", "下一步", "后续动作"],
    true,
  );
  if ([knownFacts, missingFacts, openQuestions, nextStep].some(
    (section) => typeof section === "string" && hasWorkflowMechanismBullet(section),
  )) {
    issues.push("BLOCKER_WORKFLOW_MECHANISM_FORBIDDEN");
  }
  if (
    typeof missingFacts !== "string"
    || !hasSubstantiveBullets(missingFacts, "missing-fact")
  ) {
    issues.push("BLOCKER_MISSING_FACTS_REQUIRED");
  }
  if (
    typeof openQuestions !== "string"
    || !hasSubstantiveBullets(openQuestions, "open-question")
  ) {
    issues.push("BLOCKER_OPEN_QUESTIONS_REQUIRED");
  } else if (hasNonSpecificOpenQuestion(openQuestions)) {
    issues.push("BLOCKER_OPEN_QUESTION_NOT_SPECIFIC");
  }
  if (typeof humanOwner !== "string" || !hasSubstantiveBullets(humanOwner, "human-owner")) {
    issues.push("BLOCKER_HUMAN_OWNER_REQUIRED");
  }
  if (typeof nextStep !== "string" || !hasSubstantiveBullets(nextStep, "next-step")) {
    issues.push("BLOCKER_NEXT_STEP_REQUIRED");
  }
  if (
    knownFacts === null
    || (knownFacts !== undefined && !hasSubstantiveBullets(knownFacts, "known-fact"))
  ) {
    issues.push("BLOCKER_KNOWN_FACTS_INVALID");
  }
  if (
    issues.length > 0
    || !status
    || typeof missingFacts !== "string"
    || typeof openQuestions !== "string"
    || typeof humanOwner !== "string"
    || typeof nextStep !== "string"
  ) return { blocker: null, issues: [...new Set(issues)] };
  return {
    blocker: {
      status,
      facts: [knownFacts, missingFacts].filter((value): value is string => Boolean(value)).join("\n\n"),
      missingFacts,
      missingFactItems: blockerBulletTexts(missingFacts),
      openQuestions,
      openQuestionItems: blockerBulletTexts(openQuestions),
      humanOwner,
      humanOwners: blockerBulletTexts(humanOwner),
      nextStep,
      nextSteps: blockerBulletTexts(nextStep),
    },
    issues: [],
  };
}

function reviewableStorySet(
  tickets: ReturnType<typeof parseUserStoryTicketEntries>,
): boolean {
  // This gate proves the directory is more than a placeholder. Requiring every
  // historical Story to match the newest template would break partial updates,
  // so at least one genuinely reviewable canonical Story is sufficient here.
  return tickets.some((ticket) => (
    !hasCanonicalTemplateToken(ticket.content)
    && hasReviewableAcceptanceCriteria(ticket.content, ticket.storyKey)
  ));
}

function parseTicketAssessment(entries: readonly UserStoryFileEntry[]): {
  tickets: ReturnType<typeof parseUserStoryTicketEntries>;
  duplicateIds: boolean;
} {
  try {
    return { tickets: parseUserStoryTicketEntries(entries), duplicateIds: false };
  } catch (error) {
    if (error instanceof AppError && error.code === "INVALID_USER_STORIES") {
      return { tickets: [], duplicateIds: true };
    }
    throw error;
  }
}

function hasCanonicalTemplateToken(content: string): boolean {
  const lowerContent = content.toLocaleLowerCase("en-US");
  return canonicalStoryTemplateTokens.some((token) => lowerContent.includes(token))
    || /\{\{[^}\r\n]+\}\}/u.test(content);
}

function hasReviewableAcceptanceCriteria(content: string, storyKey: string): boolean {
  const escapedStoryKey = storyKey.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const acceptanceHeading = new RegExp(
    `^###[ \\t]+${escapedStoryKey}-AC-(\\d{2,})[ \\t]*(?:[:：—-][^\\r\\n]*)?$`,
    "gimu",
  );
  const acceptanceMatches = [...content.matchAll(acceptanceHeading)];
  const ids = acceptanceMatches.map((match) => match[1] ?? "");
  if (ids.length < 2 || new Set(ids).size !== ids.length) return false;

  const h3Matches = [...content.matchAll(/^###[ \t]+.+$/gmu)];
  const completeIds = new Set<string>();
  for (const match of acceptanceMatches) {
    const start = (match.index ?? 0) + match[0].length;
    const nextHeading = h3Matches.find((candidate) => (candidate.index ?? 0) > (match.index ?? 0));
    const section = content.slice(start, nextHeading?.index ?? content.length);
    if ([...section.matchAll(/```gherkin[ \t]*\r?\n([\s\S]*?)```/giu)]
      .some((scenario) => completeGherkin(scenario[1] ?? ""))) {
      completeIds.add(match[1] ?? "");
    }
  }
  return completeIds.size >= 2;
}

function completeGherkin(scenario: string): boolean {
  return /^[ \t]*Given[ \t]+\S.*$/imu.test(scenario)
    && /^[ \t]*When[ \t]+\S.*$/imu.test(scenario)
    && /^[ \t]*Then[ \t]+\S.*$/imu.test(scenario);
}

interface MarkdownSection {
  heading: string;
  content: string;
}

function h2Sections(markdown: string): MarkdownSection[] {
  const matches = [...markdown.matchAll(/^##[ \t]+(.+?)[ \t]*#*[ \t]*\r?$/gimu)];
  return matches.map((match, index) => ({
    heading: normalizedHeading(match[1] ?? ""),
    content: markdown.slice(
      (match.index ?? 0) + match[0].length,
      matches[index + 1]?.index ?? markdown.length,
    ).trim(),
  }));
}

function uniqueSection(
  sections: readonly MarkdownSection[],
  headings: readonly string[],
  required: boolean,
): string | null | undefined {
  const accepted = new Set(headings.map(normalizedHeading));
  const matches = sections.filter(({ heading }) => accepted.has(heading));
  if (matches.length > 1 || (required && matches.length !== 1)) return null;
  if (matches.length === 0) return undefined;
  return matches[0]!.content;
}

function rootReadmes(entries: readonly UserStoryFileEntry[]): string[] {
  return entries.flatMap(({ relativePath, content }) => (
    normalizedSourcePath(relativePath).toLocaleLowerCase("en-US") === "readme.md"
      ? [content.trim()]
      : []
  ));
}

function snapshotEntries(snapshot: string): UserStoryFileEntry[] {
  const headings = [...snapshot.matchAll(
    /^##[ \t]+((?:[^/\\\r\n]+[/\\])*[^/\\\r\n]+\.md)[ \t]*\r?$/gimu,
  )];
  return headings.map((match, index) => ({
    relativePath: normalizedSourcePath(match[1] ?? ""),
    content: snapshot.slice(
      (match.index ?? 0) + match[0].length,
      headings[index + 1]?.index ?? snapshot.length,
    ).trim(),
  }));
}

function isStoryFile(relativePath: string): boolean {
  return /(?:^|\/)story\.md$/iu.test(normalizedSourcePath(relativePath));
}

function normalizedSourcePath(sourcePath: string): string {
  return sourcePath.replace(/\\/gu, "/").replace(/^\.\//u, "").trim();
}

function normalizedHeading(value: string): string {
  return value.trim().replace(/[ \t]+/gu, " ").toLocaleLowerCase("en-US");
}

function hasSubstantiveBullets(value: string, kind: BlockerContentKind): boolean {
  const bullets = blockerBulletTexts(value);
  return bullets.length > 0
    && bullets.every((bullet) => substantiveBlockerText(bullet, kind));
}

function blockerBulletTexts(value: string): string[] {
  return [...value.matchAll(
    /^[ \t]*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?(.+?)[ \t]*$/gmu,
  )].map((match) => match[1] ?? "");
}

function normalizedFingerprintBullets(value: string): string[] {
  return blockerBulletTexts(value)
    .map((item) => normalizedBlockerText(item).toLocaleLowerCase("en-US"))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function hasNonSpecificOpenQuestion(value: string): boolean {
  return blockerBulletTexts(value).some((question) => {
    const normalized = normalizedBlockerText(question);
    return /^(?:is|are)[ \t]+there[ \t]+(?:(?:any|a|an|some|specific)[ \t]+)*(?:priorit(?:y|ies)|business[ \t]+rules?|requirements?|preferences?|constraints?)\b/iu
      .test(normalized)
      || /^(?:do|does)[ \t]+(?:the[ \t]+)?(?:user|product[ \t]+owner|stakeholder)[ \t]+have[ \t]+(?:(?:any|a|an|some|specific)[ \t]+)*(?:priorit(?:y|ies)|business[ \t]+rules?|requirements?|preferences?|constraints?)\b/iu
        .test(normalized)
      || /^(?:是否|有没有|有无)(?:任何|什么|具体的?)?(?:优先级|业务规则|要求|偏好|约束)/u
        .test(normalized);
  });
}

function hasWorkflowMechanismBullet(value: string): boolean {
  return blockerBulletTexts(value).some(hasWorkflowMechanismReference);
}

function meaningfulText(value: string): boolean {
  const normalized = normalizedBlockerText(value);
  return normalized.length >= 2
    && !/^[-—–_=\s]+$/u.test(normalized)
    && !hasBlockerPlaceholderToken(normalized)
    && !hasCanonicalTemplateToken(normalized);
}

function hasBlockerPlaceholderToken(value: string): boolean {
  if (
    /^(?:none|n\/?a|not provided|unknown|tbd|todo|placeholder|无|未知|待定|待补充)[.!。\s-]*$/iu
      .test(value)
  ) {
    return true;
  }
  // Marker-shaped text is unfinished only when it is the whole field, uses a
  // marker delimiter, or sits next to a placeholder intent. Literal status and
  // business terms such as "T.B.D. is imported" and "TODO-list" remain valid.
  if (
    /^(?:n[./-]?a|not[ \t]+applicable|t[.]?b[.]?d[.]?|todo|to-do)[.!。\s-]*$/iu
      .test(value)
  ) {
    return true;
  }
  if (
    /(?:^|[^\p{L}\p{N}_-])(?:n[./-]?a|not[ \t]+applicable|t[.]?b[.]?d[.]?|todo|to-do)[ \t]*[:：—–][ \t]*/iu
      .test(value)
  ) {
    return true;
  }
  const placeholderIntent = "determine|assign|clarify|confirm|identify|provide|define|select|choose|complete|fill|replace|approval|owner|assignee|approver|question|fact|action|next[ \\t]+step|awaiting|pending";
  const marker = "n[./-]?a|not[ \\t]+applicable|t[.]?b[.]?d[.]?|todo|to-do";
  const markerCount = isolatedMarkerCount(value, marker);
  if (
    markerCount > 0
    && !(
      markerCount === 1
      && (
        hasExplicitLiteralMarkerContext(value, marker)
        || hasExplicitMarkerBusinessContext(value)
      )
    )
  ) {
    return true;
  }
  const chineseBridge = "(?:仍然?[为是]|为|是|设(?:置)?为|标(?:记)?为|保持(?:为)?|保留(?:为)?)";
  const chinesePending = "(?:(?:尚)?待|等待)(?:确认|确定|补充|提供|指派|分配|决定)?";
  const markerAssignment = new RegExp(
    `(?:\\b(?:is|are|was|were|remains?|stays?|be|being|set[ \\t]+to|marked(?:[ \\t]+as)?|left(?:[ \\t]+as)?)[ \\t]+(?:still[ \\t]+)?(?:marked(?:[ \\t]+as)?[ \\t]+)?(?:${marker})(?=$|[^\\p{L}\\p{N}_-])|(?:^|[^\\p{L}\\p{N}_-])(?:${marker})[ \\t]+(?:is|are|was|were|remains?|stays?|marks?|means?|represents?)(?=$|[^\\p{L}\\p{N}_-])|(?:${chineseBridge}|${chinesePending})[ \\t]*(?:${marker})(?=$|[^\\p{L}\\p{N}_-])|(?:^|[^\\p{L}\\p{N}_-])(?:${marker})[ \\t]*(?:${chineseBridge}|${chinesePending}))`,
    "iu",
  );
  if (markerAssignment.test(value) && !hasExplicitLiteralMarkerContext(value, marker)) {
    return true;
  }
  if (new RegExp(
    `(?:^|[^\\p{L}\\p{N}_-])(?:${marker})[ \\t]+(?:${placeholderIntent})\\b`,
    "iu",
  ).test(value)) {
    return true;
  }
  if (new RegExp(
    `\\b(?:${placeholderIntent})[ \\t]+(?:${marker})(?=$|[^\\p{L}\\p{N}_-])`,
    "iu",
  ).test(value)) {
    return true;
  }
  if (
    /^placeholder(?:[ \t]*[:：—–-][ \t]*|[ \t]+(?:known[ \t]+fact|missing[ \t]+fact|fact|question|owner|assignee|next[ \t]+action|next[ \t]+step|action|content|text|value)\b)/iu
      .test(value)
  ) {
    return true;
  }
  return false;
}

function isolatedMarkerCount(value: string, marker: string): number {
  return value.match(new RegExp(
    `(?:^|[^\\p{L}\\p{N}_-])(?:${marker})(?=$|[^\\p{L}\\p{N}_-])`,
    "giu",
  ))?.length ?? 0;
}

function hasExplicitMarkerBusinessContext(value: string): boolean {
  return /(?:^|[^\p{L}\p{N}_-])(?:n[./-]?a|not[ \t]+applicable)[ \t]+(?:handling|mapping|format|display|behaviou?r)\b/iu
    .test(value)
    || /(?:^|[^\p{L}\p{N}_-])(?:todo|to-do)[ \t]+(?:labels?|filters?)\b/iu.test(value);
}

function hasExplicitLiteralMarkerContext(value: string, marker: string): boolean {
  let markerCount = 0;
  const protectedValue = value.replace(
    new RegExp(
      `(^|[^\\p{L}\\p{N}_-])(?:${marker})(?=$|[^\\p{L}\\p{N}_-])`,
      "giu",
    ),
    (_match, prefix: string) => {
      markerCount += 1;
      return `${prefix}BLOCKER_MARKER_TOKEN`;
    },
  );
  if (markerCount !== 1) return false;

  const bridge = "(?:is|are|was|were|remains?|stays?|means?|represents?|仍然?[为是]|为|是|设(?:置)?为|标(?:记)?为|保持(?:为)?|保留(?:为)?)";
  const englishLiteral = "(?:literal(?:[ \\t]+[\\p{L}\\p{N}_-]+){0,3}[ \\t]+(?:status|value|label|text|code)|(?:status|value|label|text|code)(?:[ \\t]+[\\p{L}\\p{N}_-]+){0,3}[ \\t]+literal)";
  const chineseLiteral = "(?:(?:字面|原样)(?:状态|值|标签|文本|代码)|(?:状态|值|标签|文本|代码)(?:字面|原样))";
  const literalContext = `(?:${englishLiteral}|${chineseLiteral})`;
  const localBoundary = "(?:\\b(?:after|although|and|as|because|before|but|however|if|since|so|therefore|though|unless|when|whereas|while|is|are|was|were|remains?|stays?|means?|represents?|owner|assignee|approver|approval|question|action)\\b|(?:但是|不过|以及|并且|同时|而|因为|所以|由于|因此|故|仍然?[为是]|为|是|负责人|责任人|审批人|决策人|问题|行动))";
  const localPhrase = `(?:(?!${localBoundary})[^,.!?;，。！？；]){0,80}`;
  const quotedMarker = "[“”\"'‘’]?BLOCKER_MARKER_TOKEN[“”\"'‘’]?";
  const literalUse = "(?:\\b(?:displays?|emits?|imports?|keeps?|preserves?|renders?|retains?|shows?|stores?)\\b|(?:保留|显示|展示|呈现|导入|存储|记录))";
  if (new RegExp(
    `${literalUse}${localPhrase}${quotedMarker}[ \\t]+as[ \\t]+(?:the[ \\t]+)?${literalContext}`,
    "iu",
  ).test(protectedValue)) {
    return true;
  }
  const markerClause = protectedValue.split(
    /(?:[,.;!?，。；！？]+|\b(?:after|although|and|as|because|before|but|however|if|since|so|therefore|though|unless|when|whereas|while)\b|(?:但是|不过|以及|并且|同时|而|因为|所以|由于|因此|故))/iu,
  ).find((clause) => clause.includes("BLOCKER_MARKER_TOKEN"));
  if (!markerClause) return false;
  return new RegExp(
    `(?:${literalContext}${localPhrase}${bridge}[ \\t]*${quotedMarker}|${quotedMarker}[ \\t]+${bridge}${localPhrase}${literalContext}|${literalUse}${localPhrase}${literalContext}${localPhrase}${quotedMarker}|${quotedMarker}${localPhrase}${literalUse}${localPhrase}${literalContext})`,
    "iu",
  ).test(markerClause);
}

function substantiveBlockerText(value: string, kind: BlockerContentKind): boolean {
  if (!meaningfulText(value)) return false;
  const normalized = normalizedBlockerText(value);
  if (kind === "human-owner") {
    return !contradictsHumanOwner(normalized) && substantiveHumanOwner(normalized);
  }
  if (hasWorkflowMechanismReference(normalized)) return false;

  if (!hasSubstantiveNarrativeShape(normalized, 6)) return false;
  switch (kind) {
    case "known-fact":
      return true;
    case "missing-fact":
      return !contradictsMissingFact(normalized);
    case "open-question":
      return !contradictsOpenQuestion(normalized);
    case "next-step":
      return !contradictsNextStep(normalized);
  }
}

function substantiveHumanOwner(value: string): boolean {
  if (mechanismOnlyHumanOwnerPattern.test(value)) return false;
  const ownerParts = value.split(/[\/&,;+]+/u).map((part) => part.trim()).filter(Boolean);
  if (
    ownerParts.length > 0
    && ownerParts.every((part) => blockerOwnerAbbreviations.has(part.toLocaleUpperCase("en-US")))
  ) {
    return true;
  }

  const cjkCharacters = value.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
  ) ?? [];
  if (cjkCharacters.length >= 2) return true;

  const letterParts = value.match(/\p{L}+/gu) ?? [];
  const letterCount = letterParts.join("").length;
  const normalizedRole = letterParts.join(" ").toLocaleLowerCase("en-US");
  if (blockerOwnerRoleNames.has(normalizedRole)) return true;

  return letterCount >= 2
    && letterParts.length > 0
    && letterParts.every((part) => (
      /^\p{Lu}[\p{Ll}\p{M}]*$/u.test(part)
      || /^\p{Lu}{2,}$/u.test(part)
    ));
}

function contradictsHumanOwner(value: string): boolean {
  return matchesAny(value, humanOwnerContradictionPatterns, "human-owner");
}

function contradictsMissingFact(value: string): boolean {
  return matchesAny(value, missingFactContradictionPatterns, "missing-fact");
}

function contradictsOpenQuestion(value: string): boolean {
  return matchesAny(value, openQuestionContradictionPatterns, "open-question");
}

function contradictsNextStep(value: string): boolean {
  return matchesAny(value, nextStepContradictionPatterns, "next-step");
}

function matchesAny(
  value: string,
  patterns: readonly RegExp[],
  kind: Exclude<BlockerContentKind, "known-fact">,
): boolean {
  if (!patterns.some((pattern) => pattern.test(value))) return false;
  // A negative phrase can introduce a real exception ("all known except X").
  // The exception only cancels the contradiction when its tail independently
  // satisfies this same field's contract. This prevents "but unknown" or a
  // second, differently worded contradiction from becoming a fail-open.
  return !hasSubstantiveExceptionClause(value, kind, patterns);
}

function hasSubstantiveExceptionClause(
  value: string,
  kind: Exclude<BlockerContentKind, "known-fact">,
  patterns: readonly RegExp[],
): boolean {
  const english = value.match(/\b(?:except|excluding|other[ \t]+than|but)\b([\s\S]*)$/iu);
  if (english && substantiveExceptionText(english[1] ?? "", kind, patterns)) return true;
  const chineseExclusion = value.match(/除([^，。；]{2,})外/u);
  if (
    chineseExclusion
    && substantiveExceptionText(chineseExclusion[1] ?? "", kind, patterns)
  ) return true;
  const chineseContrast = value.match(/(?:但是|但|不过)([^，。；]+)$/u);
  return Boolean(
    chineseContrast
    && substantiveExceptionText(chineseContrast[1] ?? "", kind, patterns)
  );
}

function substantiveExceptionText(
  value: string,
  kind: Exclude<BlockerContentKind, "known-fact">,
  patterns: readonly RegExp[],
): boolean {
  const normalized = normalizedBlockerText(value);
  if (
    /^(?:none|nothing|unknown)\b/iu.test(normalized)
    || /^(?:无|没有|未知|无人|不存在)(?:内容|事项|结果)?[.!。\s]*$/u.test(normalized)
  ) {
    return false;
  }
  if (!meaningfulText(normalized) || patterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  if (hasResolvedExceptionSemantics(normalized)) return false;
  if (kind === "human-owner") return substantiveHumanOwner(normalized);
  if (!hasSubstantiveNarrativeShape(normalized, 4)) return false;
  if (kind === "next-step") return hasActionableExceptionSemantics(normalized);
  return hasUnresolvedOrNominalExceptionSemantics(normalized, kind);
}

function hasResolvedExceptionSemantics(value: string): boolean {
  return /\b(?:(?:is|are|was|were)[ \t]+|(?:has|have|had)[ \t]+been[ \t]+|already[ \t]+)(?:already[ \t]+)?(?:agreed|approved|answered|available|closed|complete|completed|confirmed|decided|done|finalized|identified|known|provided|resolved|selected|settled)\b/iu
    .test(value)
    || /\b(?:i|we|they|the[ \t]+team|the[ \t]+owner|the[ \t]+stakeholder)[ \t]+(?:already[ \t]+)?(?:know|knows|knew|identified|selected|settled|agreed)\b/iu.test(value)
    || /(?:已|已经|均已|都已)(?:获批|批准|回答|关闭|完成|确认|决定|定稿|明确|提供|解决|选定|商定|识别|知晓|知道|确定)/u.test(value)
    || /我们(?:已|已经)?(?:知晓|知道|选定|商定|识别|确定)/u.test(value);
}

function hasUnresolvedOrNominalExceptionSemantics(
  value: string,
  kind: "missing-fact" | "open-question",
): boolean {
  if (
    /\b(?:ambiguous|missing|open|outstanding|pending|unclear|unanswered|unavailable|unconfirmed|undecided|unidentified|unknown|unresolved)\b/iu.test(value)
    || /\b(?:not|never)[ \t]+(?:yet[ \t]+)?(?:agreed|approved|answered|available|confirmed|decided|defined|identified|known|provided|resolved|selected|settled)\b/iu.test(value)
    || /\b(?:needs?|requires?)[ \t]+(?:an?[ \t]+)?(?:answer|approval|clarification|confirmation|decision|definition|identification|input|owner)\b/iu.test(value)
    || /(?:缺失|未知|不明|未决|待(?:回答|补充|澄清|确认|决定|定义|分配|提供|选定)|(?:尚|还|仍)未(?:回答|补充|澄清|确认|决定|定义|分配|提供|选定))/u.test(value)
  ) return true;

  if (
    kind === "open-question"
    && (
      /^(?:can|could|do|does|how|should|what|when|where|which|who|why|will|would)\b/iu.test(value)
      || /[?？][.!。\s]*$/u.test(value)
      || /(?:谁|什么|哪个|哪一|何时|哪里|为何|为什么|如何|是否)/u.test(value)
    )
  ) return true;

  return !/\b(?:am|are|be|been|being|can|could|did|do|does|had|has|have|is|knows?|may|might|must|needs?|owns?|remains?|requires?|shall|should|stays?|was|were|will|would)\b/iu.test(value)
    && !/(?:已经|仍然|尚在|继续)?(?:是|为|有|保持|知道|知晓|确认|选定|商定|决定|需要|要求|负责|完成|提供|解决)/u.test(value);
}

function hasActionableExceptionSemantics(value: string): boolean {
  const action = "approve|answer|assign|clarify|collect|confirm|contact|decide|define|document|implement|obtain|provide|review|run|schedule|select|test|update|write";
  return new RegExp(
    `(?:^(?:${action})\\b|\\b(?:must|shall|should|will|needs?[ \\t]+to|is[ \\t]+expected[ \\t]+to|is[ \\t]+responsible[ \\t]+for)[ \\t]+(?:${action})\\b|\\b(?:owner|lead|manager|team|pm|po|ba|qa|reviewer|stakeholder)[ \\t]+(?:${action})s?\\b)`,
    "iu",
  ).test(value)
    || /(?:应|需|需要|必须|将|负责|下一步|请)(?:[^，。；]{0,24})(?:批准|回答|分配|澄清|收集|确认|联系|决定|定义|记录|实施|获取|提供|审核|运行|安排|选择|测试|更新|编写|跟进)/u
      .test(value)
    || /^(?:批准|回答|分配|澄清|收集|确认|联系|决定|定义|记录|实施|获取|提供|审核|运行|安排|选择|测试|更新|编写|跟进)/u
      .test(value)
    || /(?:负责人|责任人|审批人|决策人|产品经理|项目经理|团队)(?:应|将|需|需要|负责)?(?:[^，。；]{0,12})(?:批准|回答|分配|澄清|收集|确认|联系|决定|定义|记录|实施|获取|提供|审核|运行|安排|选择|测试|更新|编写|跟进)/u
      .test(value);
}

function hasSubstantiveNarrativeShape(value: string, minimumCjkCharacters: number): boolean {
  const lettersAndNumbers = value.match(/[\p{L}\p{N}]/gu) ?? [];
  const lexicalParts = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  const cjkCharacters = value.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
  ) ?? [];
  return cjkCharacters.length >= minimumCjkCharacters
    || (lettersAndNumbers.length >= 12 && lexicalParts.length >= 2);
}

function normalizedBlockerText(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/[`*_>#]/gu, "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedBlockerItems(
  values: readonly string[],
  field: string,
  required: boolean,
  kind: BlockerContentKind,
): string[] {
  const normalized = values.map((value) => value.replace(/\s+/gu, " ").trim());
  if (
    kind !== "human-owner"
    && normalized.some(hasWorkflowMechanismReference)
  ) {
    throw new AppError(
      `${field} 必须描述产品或业务事实，不能引用平台工作流机制`,
      422,
      "INVALID_USER_STORIES_BLOCKER_DRAFT",
      { field, reason: "BLOCKER_WORKFLOW_MECHANISM_FORBIDDEN" },
    );
  }
  if (
    (required && normalized.length === 0)
    || normalized.length > 20
    || normalized.some((value) => (
      value.length > 800
      || value.toLocaleLowerCase("en-US").includes(USER_STORIES_BLOCKER_SENTINEL)
      || !substantiveBlockerText(value, kind)
    ))
  ) {
    throw new AppError(
      `${field} 必须包含 1-20 条完整、具体的实质内容且不能嵌入 Blocker sentinel`,
      422,
      "INVALID_USER_STORIES_BLOCKER_DRAFT",
      { field },
    );
  }
  return normalized;
}

/**
 * A Blocker records missing product or business facts. It must never turn a
 * tool-host migration error into the fact that keeps the same Blocker alive.
 *
 * Keep this deliberately narrower than a word deny-list: "file", "platform",
 * "README.md", and even a business "blocker" can all be real product-domain
 * terms. They become workflow mechanics only in a platform-reserved token or a
 * migration loop such as "remove the old Blocker, then edit Story files".
 */
function hasWorkflowMechanismReference(value: string): boolean {
  const source = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const normalized = normalizedBlockerText(source)
    .replace(/[‐‑‒–—―]/gu, "-");
  if (workflowMechanismReservedPatterns.some(
    (pattern) => pattern.test(source) || pattern.test(normalized),
  )) {
    return true;
  }
  if (workflowMigrationLoopPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const blockerLifecycle = /\b(?:(?:existing|current|previous|old)[^\r\n]{0,40}blocker|(?:remove|delete|clear|overwrite|resolve)[^\r\n]{0,50}(?:(?:existing|current|previous|old)[^\r\n]{0,20})?blocker|blocker[^\r\n]{0,50}(?:remove|removed|delete|deleted|clear|cleared|overwrite|overwritten|resolve|resolved))\b|(?:(?:已有|现有|当前|既存|原有)[^\r\n]{0,30}(?:Blocker|阻塞)|(?:删除|移除|清除|覆盖|解决|解除)[^\r\n]{0,40}(?:Blocker|阻塞)|(?:Blocker|阻塞)[^\r\n]{0,40}(?:删除|移除|清除|覆盖|解决|解除))/iu
    .test(normalized);
  const storyOrPrdOperation = /\b(?:user[-_ /]*stories?|stories?|story(?:[ \t]+files?)?)\b[^\r\n]{0,60}\b(?:creat(?:e|es|ed|ing|ion)|generat(?:e|es|ed|ing|ion)|materializ(?:e|es|ed|ing|ation)|author(?:s|ed|ing)?|edit(?:s|ed|ing)?|modif(?:y|ies|ied|ying|ication)|writ(?:e|es|ing|ten)|chang(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|retry|retrying|proceed|proceeding)\b|\b(?:creat(?:e|es|ed|ing|ion)|generat(?:e|es|ed|ing|ion)|materializ(?:e|es|ed|ing|ation)|author(?:s|ed|ing)?|edit(?:s|ed|ing)?|modif(?:y|ies|ied|ying|ication)|writ(?:e|es|ing|ten)|chang(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|retry|retrying|proceed|proceeding)\b[^\r\n]{0,60}\b(?:user[-_ /]*stories?|stories?|story(?:[ \t]+files?)?)\b|\b(?:proceed|retry|continue)\b[^\r\n]{0,60}\b(?:new[ \t]+)?prd\b|(?:用户故事|故事)[^\r\n]{0,40}(?:创建|生成|物化|编写|写入|编辑|修改|变更|更新|重试|继续)|(?:创建|生成|物化|编写|写入|编辑|修改|变更|更新|重试|继续)[^\r\n]{0,40}(?:用户故事|故事)|(?:继续|重试)[^\r\n]{0,40}(?:PRD|需求文档)/iu
    .test(normalized);
  return blockerLifecycle && storyOrPrdOperation;
}

const workflowMechanismReservedPatterns: readonly RegExp[] = [
  /\b(?:write_user_stories_blocker|write_file|apply_patch|read_file)\b/iu,
  /\b(?:ai-sdlc:user-stories-blocker|sentinel|artifact[ \t]+key|finalization[ \t]+check)\b/iu,
  /\b(?:AGENT|OUTPUT_ARTIFACTS)_[A-Z0-9_]{3,}\b/u,
];

const workflowMigrationLoopPatterns: readonly RegExp[] = [
  /\buser[-_ /]*stories?[ \t]+(?:root|directory|folder|artifact|files?)\b/iu,
  /\b(?:existing|current|previous|old)\b[^\r\n]{0,60}\bblocker\b[^\r\n]{0,100}\b(?:prevents?|preventing|blocks?|blocking|cannot|unable)\b[^\r\n]{0,80}\b(?:modify|modifies|modifying|modification|edit|edits|editing|write|writes|writing|retry|retrying|proceed|proceeding)\b/iu,
  /\b(?:existing|current|previous|old)\b[^\r\n]{0,60}\buser[-_ /]*stories?\b[^\r\n]{0,60}\bblocker\b[^\r\n]{0,100}\b(?:modify|modifies|modifying|modification|edit|edits|editing|write|writes|writing|retry|retrying|proceed|proceeding)\b/iu,
  /\bblocker\b[^\r\n]{0,80}\b(?:resolve|resolved|remove|delete|clear|overwrite)\b[^\r\n]{0,100}\b(?:proceed|proceeding|retry|retrying|edit|edits|editing|modify|modifies|modifying|write|writes|writing)\b[^\r\n]{0,80}\b(?:prd|user[-_ /]*stories?|stories?|story[ \t]+files?)\b/iu,
  /\b(?:remove|delete|clear|overwrite)\b[^\r\n]{0,60}\bblocker\b[^\r\n]{0,100}\b(?:edit|edits|editing|modify|modifies|modifying|write|writes|writing|retry|retrying|proceed|proceeding)\b[^\r\n]{0,80}\b(?:prd|user[-_ /]*stories?|stories?|story[ \t]+files?)\b/iu,
  /\b(?:root|blocker)[ \t]+readme(?:\.md)?\b[^\r\n]{0,100}\b(?:remove|delete|clear|overwrite|edit|modify|retry)\b|\b(?:remove|delete|clear|overwrite|edit|modify)\b[^\r\n]{0,100}\b(?:root|blocker)[ \t]+readme(?:\.md)?\b/iu,
  /\b(?:platform[ \t]+(?:tool|gate|validator|runtime)|quality[ \t]+gate|tool[ \t]+(?:call|error)|provider[ \t]+runtime)\b[^\r\n]{0,100}\b(?:blocker|user[-_ /]*stories?[ \t]+artifact|root[ \t]+readme)\b/iu,
  /(?:已有|现有|当前|既存|原有)[^\r\n]{0,40}(?:Blocker|阻塞(?:项|说明|文件)?)[^\r\n]{0,100}(?:阻止|导致|无法|不能)[^\r\n]{0,80}(?:修改|编辑|写入|重试|继续)/iu,
  /(?:删除|移除|清除|覆盖|改写)[^\r\n]{0,60}(?:Blocker|阻塞(?:项|说明|文件)?)[^\r\n]{0,100}(?:修改|编辑|写入|重试|继续)[^\r\n]{0,80}(?:用户故事|故事|PRD|需求文档|README)/iu,
  /(?:平台|Provider)(?:工具|门禁|校验器|运行时)[^\r\n]{0,100}(?:Blocker|阻塞|用户故事产物|根[ \t]*README)/iu,
];

const mechanismOnlyHumanOwnerPattern = /^(?:(?:platform|provider|agent|model|tool|runtime|validator|quality[ -]?gate|平台|模型|工具|运行时|校验器|门禁)[ /、，,&+；;]*)+$/iu;

const blockerOwnerAbbreviations = new Set([
  "BA",
  "CEO",
  "CIO",
  "CISO",
  "COO",
  "CPO",
  "CTO",
  "EM",
  "HR",
  "PM",
  "PO",
  "QA",
  "SM",
  "SME",
  "SRE",
  "TL",
  "UI",
  "UX",
]);

const blockerOwnerRoleNames = new Set([
  "architect",
  "business analyst",
  "delivery manager",
  "design lead",
  "designer",
  "developer",
  "engineering lead",
  "engineering manager",
  "engineer",
  "product lead",
  "product manager",
  "product owner",
  "project manager",
  "quality assurance",
  "release manager",
  "reviewer",
  "stakeholder",
  "tech lead",
  "technical lead",
  "tester",
]);

// These rules reject statements whose semantics contradict the field contract.
// They intentionally match phrase shapes (assignment, completeness, decisions,
// or actionability) instead of maintaining a list of one-off rejected strings.
const humanOwnerContradictionPatterns: readonly RegExp[] = [
  /\b(?:no|without)(?:[ \t]+an?)?[ \t]+(?:(?:named|assigned|human|decision)[ \t]+)*(?:owner|assignee|approver|responsible[ \t]+person)\b/iu,
  /\b(?:not[ \t]+(?:yet[ \t]+)?assigned|unassigned|unallocated|undesignated)\b/iu,
  /\b(?:to[ \t]+be[ \t]+(?:determined|assigned|confirmed)|pending[ \t]+(?:assignment|determination|confirmation))\b/iu,
  /\b(?:unknown|unassigned|unspecified|pending)[ \t]+(?:(?:human|decision)[ \t]+)?(?:owner|assignee|approver)\b/iu,
  /\b(?:(?:human|decision)[ \t]+)?(?:owner|assignee|approver)[ \t]+(?:is[ \t]+)?(?:pending|unknown|unassigned|not[ \t]+assigned|to[ \t]+be[ \t]+determined)\b/iu,
  /\b(?:(?:human|decision)[ \t]+)?(?:owner|assignee|approver)[ \t]+(?:assignment|determination|confirmation)[ \t]+(?:is[ \t]+)?pending\b/iu,
  /\b(?:assignment|determination|confirmation)[ \t]+(?:is[ \t]+)?pending\b/iu,
  /\bnobody[ \t]+(?:is[ \t]+)?assigned\b/iu,
  /(?:无|没有|尚无|暂无)(?:明确|指定|已分配)?(?:负责人|责任人|审批人|决策人|所有者)/u,
  /无人(?:负责|承担)/u,
  /(?:负责人|责任人|审批人|决策人)?(?:尚未|未|没有)(?:被)?(?:分配|指定|确定|明确)(?:负责人|责任人|审批人|决策人)?/u,
  /(?:(?:负责人|责任人|审批人|决策人)(?:(?:仍|尚)?待(?:分配|指定|确定|确认)|待定)|待(?:分配|指定|确定|确认|定)|未知)/u,
];

const missingFactContradictionPatterns: readonly RegExp[] = [
  /\b(?:nothing|no[ \t]+thing)(?:[ \t]+else)?[ \t]+(?:is[ \t]+|remains?[ \t]+|needs?[ \t]+(?:to[ \t]+be[ \t]+)?)?(?:missing|absent|omitted|needed|required|outstanding|provided)\b/iu,
  /\bno[ \t]+(?:(?:additional|further|material)[ \t]+)?(?:missing|outstanding|absent|omitted)[ \t]+(?:fact|information|detail|input|context|requirement)s?\b/iu,
  /\bno[ \t]+(?:fact|information|detail|input|context|requirement)s?[ \t]+(?:is|are|remains?)[ \t]+(?:missing|needed|required|outstanding)\b/iu,
  /\b(?:all|every)[ \t]+(?:(?:required|relevant|requested)[ \t]+)?(?:fact|information|detail|input|context|requirement)s?\b.*\b(?:known|provided|available|complete|confirmed)\b/iu,
  /(?:无|没有|不存在)(?:任何|其他|进一步)?(?:缺失|遗漏|待补充)(?:的)?(?:事实|信息|内容|上下文|需求|输入)?/u,
  /(?:无需|不需要)(?:再|另行|进一步)?(?:补充|提供|确认)(?:任何)?(?:事实|信息|内容|上下文|需求|输入)?/u,
  /(?:所有|全部|所需)(?:事实|信息|内容|上下文|需求|输入)(?:已|已经|均|都)*(?:完整|齐全|提供|确认)/u,
];

const openQuestionContradictionPatterns: readonly RegExp[] = [
  /\b(?:none|nothing)\b.*\b(?:identified|found|raised|open|outstanding|pending|unanswered|unresolved)\b/iu,
  /\bno[ \t]+(?:(?:open|outstanding|pending|unanswered|unresolved)[ \t]+)?(?:question|issue)s?\b/iu,
  /\bno[ \t]+(?:open|outstanding|pending|unanswered|unresolved)[ \t]+decisions?\b/iu,
  /\bno[ \t]+decisions?[ \t]+(?:is|are)?[ \t]*(?:needed|required|outstanding|pending)\b/iu,
  /\bno[ \t]+(?:further[ \t]+)?answers?[ \t]+(?:is|are)?[ \t]*(?:needed|required|outstanding|pending)\b/iu,
  /\b(?:nothing|no[ \t]+thing)\b.*\b(?:clarify|clarification|confirm|confirmation|decide|decision|answer)\b/iu,
  /\b(?:all|every)[ \t]+(?:question|issue)s?\b.*\b(?:answered|resolved|closed|confirmed)\b/iu,
  /(?:无|没有|不存在)(?:任何)?(?:待确认|开放|未决|待回答|待解决)?(?:问题|疑问|决策)/u,
  /(?:无需|不需要)(?:再|进一步)?(?:确认|澄清|回答|决策)/u,
  /(?:所有|全部)(?:问题|疑问|决策)(?:均|都|已|已经)*(?:解决|回答|关闭|确认)/u,
];

const nextStepContradictionPatterns: readonly RegExp[] = [
  /\bno[ \t]+(?:(?:further|next|follow-up)[ \t]+)?(?:action|step|follow-up|work|change)s?\b/iu,
  /\b(?:nothing|no[ \t]+thing)\b.*\b(?:to[ \t]+do|action|step|needed|required|necessary|remaining)\b/iu,
  /\b(?:all|every)[ \t]+(?:(?:required|planned)[ \t]+)?(?:action|step|task)s?\b.*\b(?:complete|completed|done|closed)\b/iu,
  /(?:无|没有|不存在)(?:任何|其他|进一步)?(?:后续动作|下一步|待办|行动|操作)/u,
  /(?:无需|不需要)(?:再|另行|进一步)?(?:行动|处理|操作|跟进|采取(?:任何)?行动)/u,
  /(?:所有|全部)(?:行动|步骤|任务|待办)(?:均|都|已|已经)*(?:完成|关闭|结束)/u,
];

function bullets(values: readonly string[]): string[] {
  return values.map((value) => `- ${value}`);
}

function occurrencesCaseInsensitive(value: string, needle: string): number {
  return value.toLocaleLowerCase("en-US").split(needle.toLocaleLowerCase("en-US")).length - 1;
}

const canonicalStoryTemplateTokens = [
  "<us-id>",
  "<story title>",
  "<business-category>",
  "{relative-path-from-story-to-prd.md}",
  "<source paths or not provided>",
  "<user>",
  "<capability>",
  "<user or business value>",
  "<observable value>",
  "<confirmed behavior this story covers>",
  "<confirmed behavior this story does not cover, or none confirmed>",
  "<user situation or action>",
  "<observable product behavior>",
  "<completed outcome>",
  "<named situation>",
  "<business condition>",
  "<observable response>",
  "<br-id>",
  "<rule used by this story>",
  "<core path>",
  "<starting business context>",
  "<user action or business event>",
  "<observable outcome>",
  "<other observable outcome, if needed>",
  "<relevant failure path>",
  "<failure condition supported by the evidence>",
  "<observable handling or recovery>",
  "<real boundary, if needed>",
  "<assumption or none>",
  "<question or none>",
] as const;
