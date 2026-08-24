import { AppError } from "../domain/errors.js";

export const engineeringEvidenceArtifactKeys = [
  "implementation-notes",
  "implementation-plan",
  "implementation-tasks",
  "engineering-session-log",
  "engineering-test-evidence",
  "engineering-review",
  "engineering-provenance",
] as const;

export const engineeringReviewHeadings = [
  "Behaviour preservation",
  "Hidden assumptions",
  "Spec/architecture drift",
  "Confirmation without evidence",
  "Test independence",
  "Security surface",
  "Over-engineering",
] as const;

export const engineeringVerificationTiers = ["A", "B", "C", "Limited"] as const;
export const passingEngineeringVerificationTiers = ["A", "B"] as const;

export type EngineeringEvidenceArtifactKey = typeof engineeringEvidenceArtifactKeys[number];
export type EngineeringReviewHeading = typeof engineeringReviewHeadings[number];
export type EngineeringVerificationTier = typeof engineeringVerificationTiers[number];

export interface EngineeringEvidenceArtifact {
  artifactKey: string;
  content: string;
}

export interface EngineeringEvidenceValidationInput {
  artifacts: ReadonlyArray<EngineeringEvidenceArtifact>;
  acceptanceCriteria: ReadonlyArray<string>;
  reviewComment: string;
}

export interface EngineeringEvidenceValidationResult {
  verificationTier: EngineeringVerificationTier;
}

export interface EngineeringEvidenceRepairFeedbackInput {
  artifacts: ReadonlyArray<EngineeringEvidenceArtifact>;
  acceptanceCriteria: ReadonlyArray<string>;
  selectedArtifactKeys: ReadonlyArray<string>;
}

interface MarkdownSection {
  title: string;
  level: number;
  parentTitle?: string;
  body: string;
}

const requiredParts: Readonly<Record<EngineeringEvidenceArtifactKey, ReadonlyArray<string>>> = {
  "implementation-notes": [
    "Status",
    "Evidence index",
    "Contract and active clearances",
    "Implemented scope",
    "Changes",
    "Impact-check deviations",
    "Verification, regression, and risks",
    "Handoff",
  ],
  "implementation-plan": [
    "Change classification",
    "Preserved behaviour",
    "ADDED",
    "MODIFIED",
    "REMOVED",
    "REMOVED audit",
    "Risk note",
    "Acceptance coverage plan",
  ],
  "implementation-tasks": [
    "Task ledger",
    "Acceptance coverage",
  ],
  "engineering-session-log": [
    "Task contract",
    "Context loaded",
    "Ordered action log",
    "Change inventory",
    "Rejected alternatives",
    "Verification gates",
    "Outcome",
  ],
  "engineering-test-evidence": [
    "Isolation",
    "Acceptance coverage",
    "Commands and results",
    "Failure classification",
  ],
  "engineering-review": [],
  "engineering-provenance": [
    "Tool/model",
    "Context loaded",
    "Verification gates",
    "Human decisions",
    "Known limitations",
    "Session duration",
    "SDD approach",
    "Evidence links",
    "Spec",
    "Session log",
    "Tests",
    "Review",
    "Publication boundary",
  ],
};

const htmlTagNames = new Set([
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "code",
  "details",
  "div",
  "em",
  "figcaption",
  "figure",
  "footer",
  "header",
  "hr",
  "i",
  "img",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

export function validateEngineeringEvidencePack(
  input: EngineeringEvidenceValidationInput,
): EngineeringEvidenceValidationResult {
  const issues: string[] = [];
  const artifacts = indexArtifacts(input.artifacts, issues);

  if (input.acceptanceCriteria.length === 0) {
    issues.push("engineering evidence: at least one authoritative acceptance criterion is required");
  }

  for (const artifactKey of engineeringEvidenceArtifactKeys) {
    const content = artifacts.get(artifactKey);
    if (content === undefined) {
      issues.push(`${artifactKey}: required artifact is missing`);
      continue;
    }
    if (content.trim().length === 0) {
      issues.push(`${artifactKey}: artifact must not be empty`);
      continue;
    }
    if (hasObviousPlaceholder(content)) {
      issues.push(`${artifactKey}: unresolved <...> or {{...}} placeholder found`);
    }
    validateNoExplicitFailureState(content, artifactKey, issues);
    for (const part of requiredParts[artifactKey]) {
      if (!hasNamedPart(content, part)) {
        issues.push(`${artifactKey}: required section or field "${part}" is missing`);
      } else if (!namedPartHasEvidence(content, part)) {
        issues.push(`${artifactKey}: required section or field "${part}" has no substantive evidence`);
      }
    }
  }

  const notes = artifacts.get("implementation-notes");
  if (isSubstantive(notes) && !hasReadyForVerificationStatus(notes)) {
    issues.push("implementation-notes: Status must be exactly Ready for verification");
  }
  if (isSubstantive(notes)) validateEvidenceIndex(notes, issues);

  const acceptanceIds = input.acceptanceCriteria.map((criterion, index) => (
    stableAcceptanceCriterionId(criterion)
    ?? `CC-AC-${String(index + 1).padStart(3, "0")}`
  ));
  for (const artifactKey of [
    "implementation-plan",
    "implementation-tasks",
    "engineering-test-evidence",
  ] as const) {
    const content = artifacts.get(artifactKey);
    if (!isSubstantive(content)) continue;
    for (const acceptanceId of acceptanceIds) {
      if (!containsExactIdentifier(content, acceptanceId)) {
        issues.push(`${artifactKey}: acceptance criterion ${acceptanceId} is not covered`);
      }
    }
  }

  const plan = artifacts.get("implementation-plan");
  if (isSubstantive(plan)) validateRemovedAudit(plan, issues);

  const tasks = artifacts.get("implementation-tasks");
  if (isSubstantive(tasks)) validateTaskCompletion(tasks, issues);

  const sessionLog = artifacts.get("engineering-session-log");
  if (isSubstantive(sessionLog)) {
    validateSessionOutcome(sessionLog, issues);
    validateNoBlockedGateSection(sessionLog, "engineering-session-log", "Verification gates", issues);
  }

  const testEvidence = artifacts.get("engineering-test-evidence");
  const verificationTier = isSubstantive(testEvidence)
    ? parseVerificationTier(testEvidence)
    : undefined;
  if (isSubstantive(testEvidence) && verificationTier === undefined) {
    issues.push("engineering-test-evidence: Isolation must declare exactly one Tier A, B, C, or Limited");
  } else if (
    verificationTier === "C"
    || verificationTier === "Limited"
  ) {
    issues.push(...humanVerificationExceptionIssues(
      input.reviewComment,
      verificationTier,
      acceptanceIds,
    ));
  }
  if (isSubstantive(testEvidence)) {
    if (verificationTier !== undefined) {
      validateIsolationConsistency(testEvidence, verificationTier, issues);
    }
    validateIndependentTestEvidence(testEvidence, acceptanceIds, issues);
    validateNoBlockedGateSection(testEvidence, "engineering-test-evidence", "Conclusion", issues);
    validateNoBlockedDisposition(testEvidence, "engineering-test-evidence", "Status", issues);
  }

  const review = artifacts.get("engineering-review");
  if (isSubstantive(review)) {
    validateEngineeringReview(review, input.reviewComment, issues);
    validateNoBlockedDisposition(review, "engineering-review", "Verdict", issues);
  }

  const provenance = artifacts.get("engineering-provenance");
  if (isSubstantive(provenance)) {
    validateEngineeringProvenance(provenance, issues);
    validateNoBlockedGateSection(provenance, "engineering-provenance", "Verification gates", issues);
    validateNoBlockedDisposition(provenance, "engineering-provenance", "Status", issues);
  }

  if (issues.length > 0 || verificationTier === undefined) {
    const summary = issues.slice(0, 3).join("；");
    throw new AppError(
      summary ? `工程证据包审批校验失败：${summary}` : "工程证据包审批校验失败",
      409,
      "ENGINEERING_EVIDENCE_GATE_FAILED",
      { issues },
    );
  }

  return { verificationTier };
}

export function engineeringEvidenceRepairFeedback(
  input: EngineeringEvidenceRepairFeedbackInput,
): string | undefined {
  try {
    validateEngineeringEvidencePack({
      artifacts: input.artifacts,
      acceptanceCriteria: input.acceptanceCriteria,
      reviewComment: "",
    });
    return undefined;
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "ENGINEERING_EVIDENCE_GATE_FAILED") {
      throw error;
    }
    const details = error.details as { issues?: unknown } | undefined;
    const issues = Array.isArray(details?.issues)
      ? details.issues.filter((issue): issue is string => typeof issue === "string")
      : [];
    const selected = new Set(input.selectedArtifactKeys);
    const relevant = issues.filter((issue) => {
      if (issue.startsWith("engineering evidence:")) return true;
      const artifactKey = issue.split(":", 1)[0];
      return artifactKey !== undefined && selected.has(artifactKey);
    });
    if (relevant.length === 0) return undefined;
    return [
      "Machine evidence-gate repair feedback:",
      ...relevant.map((issue) => `- ${issue}`),
      ...engineeringEvidenceCanonicalRepairInstructions(relevant),
      "Repair only the selected registered outputs. Reopen each canonical .ai-sdlc/templates file and preserve its exact template headings and table columns.",
      "Keep every factual code, test, command, and human-boundary claim honest. Do not edit source or tests merely to make Markdown pass; if a diagnostic reveals a real implementation failure, leave the evidence Blocked and report the owner and next action.",
    ].join("\n");
  }
}

function engineeringEvidenceCanonicalRepairInstructions(issues: readonly string[]): string[] {
  const instructions: string[] = [];
  if (issues.some((issue) => /engineering-test-evidence: acceptance criterion .* has no passing automated-test row/iu.test(issue))) {
    instructions.push(
      "Canonical acceptance-row repair: keep the stable AC ID in Trace ID; put the real executable test path and test name in Test path and test ID/name; put a durable artifact, path, URL, or command reference in Evidence; use Result: Pass only when that exact execution passed.",
    );
  }
  if (issues.some((issue) => /engineering-review: section .* none found row contains contradictory finding data/iu.test(issue))) {
    instructions.push(
      "Canonical none-found repair: standard lens `| none found | N/A | <durable evidence reference> | N/A | N/A | not-applicable |`; Pre-mortem/Edge-case-hunter `| none found | N/A | N/A | <durable evidence reference> | N/A | N/A | not-applicable |`. Every non-Evidence contract cell must be exactly `N/A`, and Status must be exactly `not-applicable`. If any severity, impact, action, owner, open state, or actionable finding exists, use a complete ENG-REV/ENG-ADV finding row instead.",
    );
  }
  if (issues.some((issue) => /engineering-session-log: Verification gates contains a downstream Tester deferral that must move to Outcome or limitations/iu.test(issue))) {
    instructions.push(
      "Canonical Tester deferral repair: remove the downstream Tester row from `Verification gates`; preserve its true `Blocked / deferred`, `Owner: Tester`, and Verification/Release impact under `Outcome`, `Known limitations`, or `Next owner`. Do not change it to Pass and do not hide a real Implementation blocker.",
    );
  }
  if (issues.some((issue) => /engineering-provenance:.*(?:human-owned|Publication boundary|creation|opening)/iu.test(issue))) {
    instructions.push(
      "Canonical PR-boundary repair: record `PR created or opened by Software Engineer: No`, `PR published by Software Engineer: No`, and `Merge/deploy/release performed by Software Engineer: No`. Do not claim Software Engineer approval or execution of scope, architecture, security risk, PR, merge, deploy, or release decisions.",
    );
  }
  return instructions;
}

function validateNoBlockedGateSection(
  content: string,
  artifactKey: EngineeringEvidenceArtifactKey,
  heading: string,
  issues: string[],
): void {
  const body = namedSections(content, heading)[0]?.body;
  if (body === undefined) return;
  const lines = body.split(/\r?\n/u);
  let resultColumn: number | undefined;
  let blocked = false;
  let downstreamTesterDeferral = false;
  for (const sourceLine of lines) {
    if (sourceLine.includes("|")) {
      const cells = sourceLine.trim()
        .replace(/^\|/u, "")
        .replace(/\|$/u, "")
        .split("|")
        .map((cell) => normalizeName(cell));
      const headerIndex = cells.findIndex((cell) => cell === "result" || cell === "gate result");
      if (headerIndex >= 0) {
        resultColumn = headerIndex;
        continue;
      }
      if (resultColumn !== undefined && cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) continue;
      if (resultColumn !== undefined && cells[resultColumn]) {
        const result = cells[resultColumn] ?? "";
        if (!/^(?:pass(?:ed)?|success(?:ful)?|approved|human waiver)\b/iu.test(result)) {
          if (
            artifactKey === "engineering-session-log"
            && isDownstreamTesterDeferralRow(cells, resultColumn)
          ) {
            downstreamTesterDeferral = true;
          } else {
            blocked = true;
          }
        }
      }
    }

    const line = cleanStructuralLine(sourceLine);
    const field = /^(?:(?:isolation|acceptance|regression|project-check)\s+gate|result|state|status)\s*(?::|=|\||—|-)\s*(.+)$/iu
      .exec(line);
    if (field?.[1] && !/^(?:pass(?:ed)?|success(?:ful)?|approved|human waiver)\b/iu.test(field[1].trim())) {
      blocked = true;
    }
    const ready = /^ready\s+for\s+review\s*(?::|=|\||—|-)\s*(.+)$/iu.exec(line);
    if (ready?.[1] && !/^(?:yes|ready)\b/iu.test(ready[1].trim())) blocked = true;
  }
  if (downstreamTesterDeferral) {
    issues.push(
      `${artifactKey}: ${heading} contains a downstream Tester deferral that must move to Outcome or limitations`,
    );
  }
  if (blocked) {
    issues.push(`${artifactKey}: ${heading} contains an explicit blocked or failed gate result`);
  }
}

function isDownstreamTesterDeferralRow(
  cells: readonly string[],
  resultColumn: number,
): boolean {
  const result = cells[resultColumn] ?? "";
  if (!/^(?:blocked\s*\/\s*deferred|deferred)$/iu.test(result.trim())) return false;

  const row = cells.join(" | ");
  const testerOwned = /\bowner\s*:\s*tester\b/iu.test(row);
  const downstreamOnly = /\bblocks?\s+verification(?:\s*\/\s*release|\s+and\s+release)?\s+only\b/iu.test(row)
    || /\bonly\s+blocks?\s+verification(?:\s*\/\s*release|\s+and\s+release)?\b/iu.test(row);
  const excludesImplementation = /\b(?:does\s+not\s+block|not)\b.{0,60}\bimplementation\b/iu.test(row);
  return testerOwned && downstreamOnly && excludesImplementation;
}

function stableAcceptanceCriterionId(criterion: string): string | undefined {
  const match = /^\s*(?:[-*]\s*)?(?:[*_`]*)?([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)(?:[*_`]*)?\s*(?::|—|-)\s+\S/u
    .exec(criterion);
  return match?.[1];
}

function indexArtifacts(
  input: ReadonlyArray<EngineeringEvidenceArtifact>,
  issues: string[],
): Map<EngineeringEvidenceArtifactKey, string> {
  const requiredKeys = new Set<string>(engineeringEvidenceArtifactKeys);
  const indexed = new Map<EngineeringEvidenceArtifactKey, string>();
  const duplicates = new Set<EngineeringEvidenceArtifactKey>();

  for (const artifact of input) {
    if (!requiredKeys.has(artifact.artifactKey)) continue;
    const artifactKey = artifact.artifactKey as EngineeringEvidenceArtifactKey;
    if (indexed.has(artifactKey)) {
      duplicates.add(artifactKey);
      continue;
    }
    indexed.set(artifactKey, typeof artifact.content === "string" ? artifact.content : "");
  }

  for (const artifactKey of duplicates) {
    issues.push(`${artifactKey}: artifact key must not be duplicated`);
  }
  return indexed;
}

function isSubstantive(content: string | undefined): content is string {
  return typeof content === "string" && content.trim().length > 0;
}

function hasObviousPlaceholder(content: string): boolean {
  const prose = content
    .replace(/```[\s\S]*?```/gu, "");
  if (/\{\{[\s\S]{1,200}?\}\}/u.test(prose)) return true;
  if (/\b(?:TBD|TBC|TODO|FIXME)\b/iu.test(prose)) return true;

  const angleValues = prose.matchAll(/<\s*([^<>\r\n]{1,200}?)\s*>/gu);
  for (const match of angleValues) {
    const value = match[1]?.trim() ?? "";
    if (value.length === 0) continue;
    if (/^(?:https?:\/\/|mailto:)/iu.test(value) || value.startsWith("!--")) continue;
    if (/^[A-Z](?:\s*,\s*[A-Z])*$/u.test(value)) continue;

    const tag = /^\/?([a-z][a-z0-9-]*)(?:\s+[^<>]*)?\/?$/iu.exec(value)?.[1]?.toLowerCase();
    if (tag !== undefined && htmlTagNames.has(tag)) continue;
    return true;
  }
  return false;
}

function validateNoExplicitFailureState(
  content: string,
  artifactKey: EngineeringEvidenceArtifactKey,
  issues: string[],
): void {
  const lines = content.split(/\r?\n/u);
  const firstLevelTwoHeading = lines.findIndex((line) => /^ {0,3}##[\t ]+/u.test(line));
  const documentMetadata = lines.slice(0, firstLevelTwoHeading < 0 ? lines.length : firstLevelTwoHeading);
  const dispositionSections = parseMarkdownSections(content)
    .filter((section) => section.title === normalizeName("Status")
      || section.title === normalizeName("Verdict"))
    .flatMap((section) => section.body.split(/\r?\n/u));
  const hasFailure = [...documentMetadata, ...dispositionSections]
    .map(cleanStructuralLine)
    .some((line) => {
      const match = /^(?:state|status|verdict)\s*(?::|=|\||—|-)\s*(.+)$/iu.exec(line);
      if (match === null) return false;
      return /\b(?:blocked|fail(?:ed|ure)?|cancel(?:led|ed)?|incomplete|not\s+(?:complete|ready|successful))\b/iu
        .test(match[1] ?? "");
    });
  if (hasFailure) {
    issues.push(`${artifactKey}: explicit Failed or Blocked disposition prevents approval`);
  }
}

function validateEvidenceIndex(content: string, issues: string[]): void {
  const index = namedSections(content, "Evidence index")[0]?.body ?? "";
  for (const artifactKey of engineeringEvidenceArtifactKeys) {
    if (artifactKey === "implementation-notes") continue;
    if (!containsExactIdentifier(index, artifactKey)) {
      issues.push(`implementation-notes: Evidence index does not link ${artifactKey}`);
    }
  }
}

function hasReadyForVerificationStatus(content: string): boolean {
  for (const sourceLine of content.split(/\r?\n/u)) {
    const line = cleanStructuralLine(sourceLine);
    if (/^status\s*(?::|\||—)\s*ready for verification$/iu.test(line)) return true;
  }
  return parseMarkdownSections(content)
    .filter((section) => section.title === normalizeName("Status"))
    .some((section) => {
      const value = section.body
        .split(/\r?\n/u)
        .map(cleanStructuralLine)
        .find((line) => line.length > 0);
      return value !== undefined
        && /^(?:(?:state|status)\s*(?::|\||—)\s*)?ready for verification$/iu.test(value);
    });
}

function hasNamedPart(content: string, expected: string): boolean {
  const expectedName = normalizeName(expected);
  if (parseMarkdownSections(content).some((section) => section.title === expectedName)) return true;

  return content.split(/\r?\n/u).some((sourceLine) => {
    const line = cleanStructuralLine(sourceLine);
    if (normalizeName(line) === expectedName) return true;
    const fieldMatch = /^(.+?)(?::|\||—)(?:\s|$)/u.exec(line);
    return fieldMatch !== null && normalizeName(fieldMatch[1] ?? "") === expectedName;
  });
}

function namedPartHasEvidence(content: string, expected: string): boolean {
  const expectedName = normalizeName(expected);
  const sections = parseMarkdownSections(content)
    .filter((section) => section.title === expectedName);
  if (sections.length > 0) {
    return sections.some((section) => sectionBodyHasEvidence(section.body));
  }

  return content.split(/\r?\n/u).some((sourceLine) => {
    const line = cleanStructuralLine(sourceLine);
    const fieldMatch = /^(.+?)(?::|\||—)([\s\S]*)$/u.exec(line);
    if (fieldMatch === null || normalizeName(fieldMatch[1] ?? "") !== expectedName) return false;
    return (fieldMatch[2] ?? "").replace(/[|*_`]/gu, "").trim().length > 0;
  });
}

function sectionBodyHasEvidence(body: string): boolean {
  const withoutComments = body.replace(/<!--[\s\S]*?-->/gu, "").trim();
  if (withoutComments.length === 0) return false;
  const lines = withoutComments.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const separatorIndex = lines.findIndex((sourceLine) => {
    const cells = sourceLine.trim().replace(/^\||\|$/gu, "").split("|");
    return cells.length > 1 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell));
  });
  if (separatorIndex < 0) {
    return lines.some((line) => !/^\s*[-:|]+\s*$/u.test(line));
  }
  const proseBeforeTable = lines.slice(0, Math.max(0, separatorIndex - 1));
  if (proseBeforeTable.some((line) => !/^\s*[-:|]+\s*$/u.test(line))) return true;
  return lines.slice(separatorIndex + 1).some((line) => {
    const value = line.replace(/[|*_`]/gu, "").trim();
    return value.length > 0 && !/^[-:\s]+$/u.test(value);
  });
}

function cleanStructuralLine(sourceLine: string): string {
  return sourceLine
    .trim()
    .replace(/^>\s*/u, "")
    .replace(/^[-+*]\s+/u, "")
    .replace(/^\|\s*/u, "")
    .replace(/\s*\|$/u, "")
    .replace(/[*_`]/gu, "")
    .trim();
}

function normalizeName(value: string): string {
  return value
    .replace(/[*_`]/gu, "")
    .replace(/^\d+[.)]\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function parseMarkdownSections(content: string): MarkdownSection[] {
  const lines = content.split(/\r?\n/u);
  const headings: Array<{ line: number; level: number; title: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^ {0,3}(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/u.exec(lines[index] ?? "");
    if (!match) continue;
    headings.push({
      line: index,
      level: match[1]?.length ?? 1,
      title: normalizeName(match[2] ?? ""),
    });
  }

  return headings.map((heading, headingIndex) => {
    let end = lines.length;
    for (let index = headingIndex + 1; index < headings.length; index += 1) {
      const candidate = headings[index];
      if (candidate !== undefined && candidate.level <= heading.level) {
        end = candidate.line;
        break;
      }
    }
    let parentTitle: string | undefined;
    for (let index = headingIndex - 1; index >= 0; index -= 1) {
      const candidate = headings[index];
      if (candidate !== undefined && candidate.level < heading.level) {
        parentTitle = candidate.title;
        break;
      }
    }
    return {
      title: heading.title,
      level: heading.level,
      parentTitle,
      body: lines.slice(heading.line + 1, end).join("\n").trim(),
    };
  });
}

function namedSections(content: string, title: string): MarkdownSection[] {
  const normalized = normalizeName(title);
  return parseMarkdownSections(content).filter((section) => section.title === normalized);
}

function containsExactIdentifier(content: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^A-Z0-9-])${escaped}(?![A-Z0-9-])`, "u").test(content);
}

function parseVerificationTier(content: string): EngineeringVerificationTier | undefined {
  const isolationSections = parseMarkdownSections(content)
    .filter((section) => section.title === normalizeName("Isolation"));
  const searchAreas = isolationSections.length > 0
    ? isolationSections.map((section) => section.body)
    : [content];
  const tiers = new Set<EngineeringVerificationTier>();

  for (const area of searchAreas) {
    for (const sourceLine of area.split(/\r?\n/u)) {
      const line = cleanStructuralLine(sourceLine);
      // Match a dedicated field/table row, not prose such as
      // "Tier A and B pass; Tier C and Limited require a waiver" retained
      // from the template guidance.
      const match = /^(?:isolation\s+)?tier\s*(?:(?::|=|\||—|-)\s*)?(?:tier\s+)?(limited|[abc])(?:\s*\|.*)?$/iu.exec(line);
      const tier = normalizeVerificationTier(match?.[1]);
      if (tier !== undefined) tiers.add(tier);
    }
  }

  return tiers.size === 1 ? [...tiers][0] : undefined;
}

function normalizeVerificationTier(value: string | undefined): EngineeringVerificationTier | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLocaleLowerCase("en-US");
  if (normalized === "limited") return "Limited";
  if (normalized === "a" || normalized === "b" || normalized === "c") {
    return normalized.toUpperCase() as EngineeringVerificationTier;
  }
  return undefined;
}

function validateIsolationConsistency(
  content: string,
  tier: EngineeringVerificationTier,
  issues: string[],
): void {
  if (tier !== "A" && tier !== "B") return;
  const isolation = namedSections(content, "Isolation")[0]?.body ?? content;
  const authoringSession = namedFieldValue(isolation, "Test-authoring model/session");
  if (
    authoringSession === undefined
    || authoringSession.length < 8
    || /^(?:unknown|none|n\/a|not applicable)$/iu.test(authoringSession)
    || hasObviousPlaceholder(authoringSession)
  ) {
    issues.push(`engineering-test-evidence: Tier ${tier} requires a concrete test-authoring model/session`);
  }
  const requirementsVisible = namedFieldValue(isolation, "Requirements visible while authoring");
  if (
    requirementsVisible === undefined
    || !hasDurableEvidenceReference(requirementsVisible)
    || hasObviousPlaceholder(requirementsVisible)
  ) {
    issues.push(`engineering-test-evidence: Tier ${tier} requires durable requirements-visible evidence`);
  }
  const implementationVisible = namedFieldValue(isolation, "Implementation visible while authoring");
  if (
    implementationVisible === undefined
    || !/^(?:no|none|not visible|unseen)\b/iu.test(implementationVisible.trim())
  ) {
    issues.push(`engineering-test-evidence: Tier ${tier} requires Implementation visible while authoring: No`);
  }
  const frozenIntent = namedFieldValue(isolation, "Test intent frozen at");
  if (
    frozenIntent === undefined
    || !hasDurableEvidenceReference(frozenIntent)
    || hasObviousPlaceholder(frozenIntent)
  ) {
    issues.push(`engineering-test-evidence: Tier ${tier} requires a durable frozen test-intent reference`);
  }
  const contradictory = isolation.split(/\r?\n/u)
    .map(cleanStructuralLine)
    .some((line) => {
      if (/\bsame\s+(?:implementation\s+)?session\b/iu.test(line)) return true;
      if (/\btest\s+author\b.{0,100}\bread\b.{0,100}\b(?:implementation|source|diff)\b/iu.test(line)) {
        return true;
      }
      const visibility = /^(?:implementation\s+visible(?:\s+while\s+authoring)?|implementation\s+visibility)\s*(?::|=|\||—|-)\s*(.+)$/iu
        .exec(line)?.[1];
      return visibility !== undefined
        && !/^(?:no|none|not\s+visible|unseen)\b/iu.test(visibility.trim());
    });
  if (contradictory) {
    issues.push(
      `engineering-test-evidence: Tier ${tier} contradicts same-session or implementation-visible test authoring evidence`,
    );
  }
}

function humanVerificationExceptionIssues(
  reviewComment: string,
  tier: "C" | "Limited",
  acceptanceIds: readonly string[],
): string[] {
  const issues: string[] = [];
  if (typeof reviewComment !== "string") {
    return [`engineering-test-evidence: Tier ${tier} requires a complete human Verification gate exception`];
  }
  let validHeader = false;
  for (const sourceLine of reviewComment.split(/\r?\n/u)) {
    const match = /^Verification gate exception: Tier (C|Limited) - (.+)$/u.exec(sourceLine.trim());
    if (match?.[1] !== tier) continue;
    const reason = match[2]?.trim() ?? "";
    if (Array.from(reason).length >= 10 && !hasObviousPlaceholder(reason)) validHeader = true;
  }
  if (!validHeader) {
    issues.push(
      `engineering-test-evidence: Tier ${tier} requires "Verification gate exception: Tier ${tier} - <why A/B is unavailable>"`,
    );
  }

  const owner = exactReviewCommentField(reviewComment, "owner");
  if (
    owner === undefined
    || owner.length < 3
    || /\b(?:agent|AI|model|codex|software engineer|chatgpt|LLM|claude|gemini|copilot|bot|assistant|anthropic|openai)\b/iu.test(owner)
    || hasObviousPlaceholder(owner)
  ) {
    issues.push(`engineering-test-evidence: Tier ${tier} exception owner must name a non-Agent human`);
  }

  const reference = exactReviewCommentField(reviewComment, "reference");
  if (
    reference === undefined
    || reference.length < 5
    || hasObviousPlaceholder(reference)
  ) {
    issues.push(`engineering-test-evidence: Tier ${tier} exception reference is missing or unresolved`);
  }

  const scope = exactReviewCommentField(reviewComment, "scope");
  if (
    scope === undefined
    || scope.length < 10
    || acceptanceIds.some((acceptanceId) => !containsExactIdentifier(scope, acceptanceId))
    || hasObviousPlaceholder(scope)
  ) {
    issues.push(
      `engineering-test-evidence: Tier ${tier} exception scope must name every affected acceptance criterion`,
    );
  }

  const compensatingEvidence = exactReviewCommentField(reviewComment, "compensating evidence");
  if (
    compensatingEvidence === undefined
    || compensatingEvidence.length < 10
    || !/(?:artifact:|https?:\/\/|(?:[\p{Letter}\p{Number}_.-]+\/)+[\p{Letter}\p{Number}_.\/-]+|[\p{Letter}\p{Number}_.-]+\.(?:md|log|txt|json|xml)\b)/iu.test(compensatingEvidence)
    || hasObviousPlaceholder(compensatingEvidence)
  ) {
    issues.push(
      `engineering-test-evidence: Tier ${tier} exception compensating evidence needs a durable reference`,
    );
  }

  const residualRisk = exactReviewCommentField(reviewComment, "residual risk");
  if (
    residualRisk === undefined
    || residualRisk.length < 10
    || /^(?:none|n\/a|not applicable)[.!]?$/iu.test(residualRisk)
    || hasObviousPlaceholder(residualRisk)
  ) {
    issues.push(`engineering-test-evidence: Tier ${tier} exception residual risk is missing`);
  }

  const revisit = exactReviewCommentField(reviewComment, "revisit");
  if (
    revisit === undefined
    || revisit.length < 10
    || !/(?:\d{4}-\d{2}-\d{2}|expir|revisit|before|when|immediately|release)/iu.test(revisit)
    || hasObviousPlaceholder(revisit)
  ) {
    issues.push(`engineering-test-evidence: Tier ${tier} exception revisit or expiry is missing`);
  }
  return issues;
}

function exactReviewCommentField(reviewComment: string, field: string): string | undefined {
  const prefix = `Verification exception ${field}:`;
  const lines = reviewComment.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) return undefined;
  const value = lines[0]?.slice(prefix.length).trim();
  return value && value.length > 0 ? value : undefined;
}

function validateRemovedAudit(content: string, issues: string[]): void {
  const removed = namedSections(content, "REMOVED")[0]?.body ?? "";
  if (!/^\s*(?:[-*]\s*)?(?:none|n\/a|not applicable)\b/iu.test(removed)) return;
  const audit = namedSections(content, "REMOVED audit")[0]?.body ?? "";
  const normalized = audit.replace(/[*_`|#-]/gu, " ").replace(/\s+/gu, " ").trim();
  if (
    normalized.length < 24
    || /^(?:none|n\/a|not applicable)(?:[.!])?$/iu.test(normalized)
  ) {
    issues.push(
      "implementation-plan: REMOVED is None, but REMOVED audit lacks concrete repository evidence",
    );
  }
}

function validateTaskCompletion(content: string, issues: string[]): void {
  const ledger = namedSections(content, "Task ledger")[0]?.body ?? "";
  const taskLines = ledger.split(/\r?\n/u).filter((line) => /\bENG-TASK-\d{3}\b/u.test(line));
  if (taskLines.length === 0) {
    issues.push("implementation-tasks: Task ledger must contain at least one ENG-TASK entry");
    return;
  }
  const incomplete = taskLines.filter((line) => {
    const completed = /(?:\|\s*(?:done|complete|completed)\s*\||\[[xX]\]|\bstatus\s*(?::|=)\s*(?:done|complete|completed)\b)/iu.test(line);
    const explicitlyIncomplete = /(?:\|\s*(?:todo|in-progress|blocked|pending|waiting|failed|cancelled|incomplete)\s*\||\[\s\]|\bstatus\s*(?::|=)\s*(?:todo|in-progress|blocked|pending|waiting|failed|cancelled|incomplete)\b)/iu.test(line);
    return !completed || explicitlyIncomplete;
  });
  if (incomplete.length > 0) {
    const taskIds = incomplete.flatMap((line) => line.match(/\bENG-TASK-\d{3}\b/gu) ?? []);
    issues.push(
      `implementation-tasks: every task must be complete; unfinished: ${taskIds.join(", ") || "unknown task"}`,
    );
  }
}

function validateSessionOutcome(content: string, issues: string[]): void {
  const outcome = namedSections(content, "Outcome")[0]?.body ?? "";
  const outcomeLines = outcome.split(/\r?\n/u).map(cleanStructuralLine);
  const resultLine = outcomeLines
    .find((line) => /^(?:result|outcome|state)\s*(?::|\||—|-)/iu.test(line));
  const disposition = resultLine ?? outcome;
  const contradictoryDisposition = outcomeLines.some((line) =>
    /^(?:result|outcome|state)\s*(?::|\||—|-)\s*(?:blocked|failed|partial|incomplete|not\s+(?:complete|completed|ready|successful))\b/iu.test(line)
  );
  if (!/\b(?:complete|completed|success|successful|passed|ready\s+for\s+(?:independent\s+)?verification)\b/iu.test(disposition)
    || contradictoryDisposition
    || /\b(?:blocked|failed|partial|incomplete|not\s+(?:complete|completed|ready|successful)|never\s+completed)\b/iu.test(disposition)) {
    issues.push("engineering-session-log: Outcome must record a complete, non-blocked result");
  }
}

function validateIndependentTestEvidence(
  content: string,
  acceptanceIds: readonly string[],
  issues: string[],
): void {
  const coverage = namedSections(content, "Acceptance coverage")[0]?.body ?? "";
  for (const acceptanceId of acceptanceIds) {
    const lines = coverage.split(/\r?\n/u)
      .filter((line) => containsExactIdentifier(line, acceptanceId));
    const passingLines = lines.filter((line) => {
      const result = acceptanceCoverageResult(line);
      return hasPassingResult(result) && !hasNonPassingResult(result)
        && hasAcceptanceTestAndEvidence(line, acceptanceId);
    });
    if (passingLines.length === 0) {
      issues.push(
        `engineering-test-evidence: acceptance criterion ${acceptanceId} has no passing automated-test row`,
      );
    }
  }

  const commands = namedSections(content, "Commands and results")[0]?.body ?? "";
  const commandLines = commands.split(/\r?\n/u).filter((line) =>
    /(?:`[^`]+`|\b(?:npm|npx|pnpm|yarn|node|bun|deno|pytest|python|cargo|go|mvn|gradle|make|dotnet)\b)/iu.test(line)
  );
  const hasSuccessfulCommand = commandLines.some((line) =>
    hasPassingResult(line)
    && !hasNonPassingResult(line)
  );
  if (!hasSuccessfulCommand) {
    issues.push(
      "engineering-test-evidence: Commands and results has no real successful command execution",
    );
  }
  const hasUnresolvedCommandFailure = commandLines.some((line, index) => {
    if (!hasNonPassingResult(line)) return false;
    const identity = commandIdentity(line);
    if (identity === undefined) return true;
    return !commandLines.slice(index + 1).some((candidate) =>
      commandIdentity(candidate) === identity
      && hasPassingResult(candidate)
      && !hasNonPassingResult(candidate)
    );
  });
  if (hasUnresolvedCommandFailure) {
    issues.push(
      "engineering-test-evidence: Commands and results contains a failed, skipped, blocked, or unrun command",
    );
  }
}

function acceptanceCoverageResult(line: string): string {
  if (!line.includes("|")) return line;
  const cells = line.trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.replace(/[*_`]/gu, "").trim());
  return cells[cells.length - 1] ?? "";
}

function commandIdentity(line: string): string | undefined {
  const fenced = /`([^`\r\n]+)`/u.exec(line)?.[1]?.trim();
  if (fenced) return fenced.replace(/\s+/gu, " ");
  const match = /\b((?:npm|npx|pnpm|yarn|node|bun|deno|pytest|python|cargo|go|mvn|gradle|make|dotnet)\b[^|—\r\n]*)/iu
    .exec(line)?.[1]
    ?.replace(/\s+(?:passed|pass|failed|failure|blocked|skipped|none\s+run|not\s+run|exit\s+code).*$/iu, "")
    .replace(/[\s,;:-]+$/gu, "")
    .trim();
  return match ? match.replace(/\s+/gu, " ") : undefined;
}

function hasAcceptanceTestAndEvidence(line: string, acceptanceId: string): boolean {
  if (line.includes("|")) {
    const cells = line.trim()
      .replace(/^\|/u, "")
      .replace(/\|$/u, "")
      .split("|")
      .map((cell) => cell.replace(/[*_`]/gu, "").trim());
    const idIndex = cells.findIndex((cell) => containsExactIdentifier(cell, acceptanceId));
    if (idIndex < 0) return false;
    const canonicalTestReference = cells.length - idIndex >= 6 ? cells[idIndex + 3] : cells[idIndex + 1];
    const canonicalEvidence = cells.length - idIndex >= 6 ? cells[idIndex + 4] : undefined;
    return hasExecutableTestReference(canonicalTestReference ?? "")
      && canonicalEvidence !== undefined
      && hasDurableEvidenceReference(canonicalEvidence);
  }
  return hasExecutableTestReference(line) && hasDurableEvidenceReference(line);
}

function hasExecutableTestReference(value: string): boolean {
  return /(?:[\p{Letter}\p{Number}_.-]+\/)+[\p{Letter}\p{Number}_.\/-]+\.(?:test|spec|check)\.(?:ts|tsx|js|jsx|py|go|rs|java)\b/iu.test(value)
    || /[\p{Letter}\p{Number}_.\/-]+\.(?:test|spec|check)\.(?:ts|tsx|js|jsx|py|go|rs|java)\b/iu.test(value)
    || /(?:[\p{Letter}\p{Number}_.-]+\/)+[\p{Letter}\p{Number}_.\/-]+\.(?:ts|tsx|js|jsx|py|go|rs|java)\s*(?:::|#)\s*\S/iu.test(value);
}

function hasPassingResult(line: string): boolean {
  return /(?:^|[|:—-])\s*(?:pass(?:ed)?|success(?:ful|fully)?|succeeded)\b/iu.test(line)
    || /\bexit(?:\s+code)?\s*(?::|=|\||—|-)?\s*0\b/iu.test(line)
    || /✓/u.test(line);
}

function hasNonPassingResult(line: string): boolean {
  return /\b(?:fail(?:ed|ure)?|blocked|untested|skip(?:ped)?|cancel(?:led|ed)?|(?:not|none)\s+run|pending|incomplete)\b/iu.test(line)
    || /\b(?:did\s+not|does\s+not|not|should|expected\s+to|would|could|may|might)\s+(?:pass|succeed|successful)\b/iu.test(line)
    || /\bexit(?:\s+code)?\s*(?::|=|\||—|-)?\s*[1-9]\d*\b/iu.test(line);
}

function validateNoBlockedDisposition(
  content: string,
  artifactKey: string,
  heading: "Status" | "Verdict",
  issues: string[],
): void {
  const sections = namedSections(content, heading);
  const blocked = sections.some((section) =>
    section.body.split(/\r?\n/u).some((line) =>
      /^(?:\s*[-*]\s*)?(?:[*_`]*)(?:state|status|verdict)(?:[*_`]*)\s*(?::|\||—|-)\s*(?:[*_`]*)blocked\b/iu.test(line.trim())
      || /^\s*(?:[*_`]*)blocked(?:[*_`]*)\s*$/iu.test(line)
    )
  );
  if (blocked) {
    issues.push(`${artifactKey}: ${heading} explicitly declares State: Blocked`);
  }
}

function validateEngineeringReview(
  content: string,
  reviewComment: string,
  issues: string[],
): void {
  const sections = parseMarkdownSections(content);

  for (const heading of [...engineeringReviewHeadings, "Adversarial pass"] as const) {
    const matching = sections.filter((section) => section.title === normalizeName(heading));
    if (matching.length === 0) {
      issues.push(`engineering-review: required heading "${heading}" is missing`);
      continue;
    }
    if (!matching.some(sectionHasFindingDisposition)) {
      issues.push(
        `engineering-review: section "${heading}" must be non-empty and contain Finding, Findings, or none found`,
      );
    }
    for (const section of matching) {
      if (heading !== "Adversarial pass") {
        validateActionableFindingContract(section, "ENG-REV", issues);
      }
      if (heading === "Security surface") {
        validateSecurityFindingClosure(section, issues);
      }
    }
  }

  for (const adversarialMethod of ["Pre-mortem", "Edge-case-hunter"] as const) {
    const matching = sections.filter(
      (section) => section.title === normalizeName(adversarialMethod)
        && section.parentTitle === normalizeName("Adversarial pass"),
    );
    if (matching.length === 0) {
      issues.push(`engineering-review: required adversarial method "${adversarialMethod}" is missing`);
      continue;
    }
    if (!matching.some(sectionHasFindingDisposition)) {
      issues.push(
        `engineering-review: adversarial method "${adversarialMethod}" must contain a finding or none found`,
      );
    }
    for (const section of matching) {
      validateActionableFindingContract(section, "ENG-ADV", issues);
    }
  }

  if (claimsSoftwareEngineerAuthority(`${content}\n${reviewComment}`)) {
    issues.push(
      "engineering-review: Software Engineer cannot approve security risk, scope, architecture, merge, or release decisions",
    );
  }
}

function validateActionableFindingContract(
  section: MarkdownSection,
  idPrefix: "ENG-REV" | "ENG-ADV",
  issues: string[],
): void {
  const tableRows = actionableFindingTableRows(section.body, idPrefix);
  if (tableRows.invalidRows > 0) {
    issues.push(
      `engineering-review: section "${displaySectionTitle(section)}" contains a malformed canonical finding row`,
    );
  }
  if (tableRows.invalidNoneFound) {
    issues.push(
      `engineering-review: section "${displaySectionTitle(section)}" none found row contains contradictory finding data`,
    );
  }
  if (tableRows.noneFound && tableRows.findings.length > 0) {
    issues.push(
      `engineering-review: section "${displaySectionTitle(section)}" mixes none found with actionable findings`,
    );
  }
  if (tableRows.noneFound && tableRows.findings.length === 0) return;
  if (tableRows.findings.length > 0) {
    for (const cells of tableRows.findings) {
      const failures = validateActionableFindingTableRow(cells, idPrefix);
      if (failures.length === 0) continue;
      issues.push(
        `engineering-review: section "${displaySectionTitle(section)}" actionable finding lacks ${failures.join(", ")}`,
      );
    }
    return;
  }

  const finding = namedFieldValue(section.body, "Finding");
  const noneFound = finding !== undefined
    && /^none\s+found(?:\s+after\b[^;\r\n]*)?[.!]?$/iu.test(finding.trim());
  if (noneFound) return;

  const failures: string[] = [];
  const id = namedFieldValue(section.body, "ID");
  if (id === undefined || !new RegExp(`^${idPrefix}-\\d{3}$`, "u").test(id.trim())) {
    failures.push(`stable ${idPrefix}-<three-digits> ID`);
  }
  const severity = namedFieldValue(section.body, "Severity");
  if (severity === undefined || !/^(?:critical|high|medium|low)$/iu.test(severity.trim())) {
    failures.push("severity");
  }
  if (finding === undefined || finding.length < 8 || hasObviousPlaceholder(finding)) {
    failures.push("finding");
  }
  const evidence = namedFieldValue(section.body, "Evidence");
  if (evidence === undefined || !hasDurableEvidenceReference(evidence)) {
    failures.push("durable evidence");
  }
  const impact = namedFieldValue(section.body, "Impact");
  if (impact === undefined || impact.length < 8 || hasObviousPlaceholder(impact)) {
    failures.push("impact");
  }
  const action = namedFieldValue(section.body, "Action");
  if (action === undefined || action.length < 8 || hasObviousPlaceholder(action)) {
    failures.push("required action");
  }
  const owner = namedFieldValue(section.body, "Owner");
  if (
    owner === undefined
    || owner.length < 3
    || /\b(?:agent|AI|model|codex|chatgpt|LLM|claude|gemini|copilot|bot|assistant)\b/iu.test(owner)
    || hasObviousPlaceholder(owner)
  ) {
    failures.push("non-Agent owner");
  }
  const status = namedFieldValue(section.body, "Status");
  if (
    status === undefined
    || !/^(?:resolved|closed|remediated|fixed|accepted-by-human|not-applicable)\b/iu.test(status.trim())
    || /\b(?:not|never|open|pending|blocked|unresolved)\b/iu.test(status)
  ) {
    failures.push("terminal status");
  }
  const resolution = namedFieldValue(section.body, "Resolution");
  if (resolution === undefined || resolution.length < 8 || !hasDurableEvidenceReference(resolution)) {
    failures.push("resolution evidence");
  }
  if (failures.length > 0) {
    issues.push(
      `engineering-review: section "${displaySectionTitle(section)}" actionable finding lacks ${failures.join(", ")}`,
    );
  }
}

function actionableFindingTableRows(
  body: string,
  idPrefix: "ENG-REV" | "ENG-ADV",
): { noneFound: boolean; invalidNoneFound: boolean; invalidRows: number; findings: string[][] } {
  let noneFound = false;
  let noneFoundCount = 0;
  let invalidNoneFound = false;
  let invalidRows = 0;
  const findings: string[][] = [];
  for (const sourceLine of body.split(/\r?\n/u)) {
    if (!sourceLine.includes("|")) continue;
    const cells = sourceLine.trim()
      .replace(/^\|/u, "")
      .replace(/\|$/u, "")
      .split("|")
      .map((cell) => cell.replace(/[*_`]/gu, "").trim());
    const first = cells[0] ?? "";
    if (/^finding\s+id$/iu.test(first) || cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
      continue;
    }
    if (/^none\s+found$/iu.test(first)) {
      noneFound = true;
      noneFoundCount += 1;
      if (noneFoundRowContainsContradiction(cells, idPrefix)) invalidNoneFound = true;
      continue;
    }
    if (new RegExp(`^${idPrefix}-\\d{3}$`, "u").test(first)) {
      findings.push(cells);
      continue;
    }
    invalidRows += 1;
  }
  return {
    noneFound,
    invalidNoneFound: invalidNoneFound || noneFoundCount > 1,
    invalidRows,
    findings,
  };
}

function noneFoundRowContainsContradiction(
  cells: readonly string[],
  idPrefix: "ENG-REV" | "ENG-ADV",
): boolean {
  const isAdversarial = idPrefix === "ENG-ADV";
  const expectedCells = isAdversarial ? 7 : 6;
  if (cells.length !== expectedCells) return true;

  const severity = cells[1] ?? "";
  const adversarialContract = isAdversarial ? cells[2] ?? "" : undefined;
  const evidence = cells[isAdversarial ? 3 : 2] ?? "";
  const impact = cells[isAdversarial ? 4 : 3] ?? "";
  const actionAndOwner = cells[isAdversarial ? 5 : 4] ?? "";
  const statusAndResolution = cells[isAdversarial ? 6 : 5] ?? "";

  return !isCanonicalNoneContractCell(severity)
    || (adversarialContract !== undefined && !isCanonicalNoneContractCell(adversarialContract))
    || !hasDurableEvidenceReference(evidence)
    || !isCanonicalNoneContractCell(impact)
    || !isCanonicalNoneContractCell(actionAndOwner)
    || !/^not-applicable$/iu.test(statusAndResolution.trim());
}

function isCanonicalNoneContractCell(value: string): boolean {
  return /^n\/a$/iu.test(value.trim());
}

function validateActionableFindingTableRow(
  cells: string[],
  idPrefix: "ENG-REV" | "ENG-ADV",
): string[] {
  const failures: string[] = [];
  const isAdversarial = idPrefix === "ENG-ADV";
  const expectedCells = isAdversarial ? 7 : 6;
  if (cells.length < expectedCells) return ["complete canonical finding row"];
  if (!new RegExp(`^${idPrefix}-\\d{3}$`, "u").test(cells[0] ?? "")) {
    failures.push(`stable ${idPrefix}-<three-digits> ID`);
  }
  if (!/^(?:critical|high|medium|low)$/iu.test(cells[1] ?? "")) failures.push("severity");
  const adversarialContract = isAdversarial ? cells[2] ?? "" : undefined;
  const evidence = cells[isAdversarial ? 3 : 2] ?? "";
  const impact = cells[isAdversarial ? 4 : 3] ?? "";
  const actionAndOwner = cells[isAdversarial ? 5 : 4] ?? "";
  const statusAndResolution = cells[isAdversarial ? 6 : 5] ?? "";
  if (
    adversarialContract !== undefined
    && (
      adversarialContract.length < 8
      || /^(?:none|n\/a|not applicable)$/iu.test(adversarialContract)
      || hasObviousPlaceholder(adversarialContract)
    )
  ) failures.push("adversarial failure or edge-condition contract");
  if (!hasDurableEvidenceReference(evidence)) failures.push("durable evidence");
  if (impact.length < 8 || hasObviousPlaceholder(impact)) failures.push("impact");
  if (
    actionAndOwner.length < 8
    || /^(?:none|n\/a|not applicable)$/iu.test(actionAndOwner)
    || hasObviousPlaceholder(actionAndOwner)
    || !hasExplicitFindingOwner(actionAndOwner)
  ) failures.push("required action and owner");
  if (
    !/\b(?:resolved|closed|remediated|fixed|accepted-by-human|not-applicable)\b/iu.test(statusAndResolution)
    || /\b(?:not|never|open|pending|blocked|unresolved)\b/iu.test(statusAndResolution)
  ) failures.push("terminal status");
  if (!hasDurableEvidenceReference(statusAndResolution)) failures.push("resolution evidence");
  return failures;
}

function hasExplicitFindingOwner(value: string): boolean {
  const labelledOwner = /\b(?:human\s+)?owner\s*[:=]\s*([^;|]+)/iu.exec(value)?.[1]?.trim();
  if (labelledOwner !== undefined) {
    return labelledOwner.length >= 3 && !hasObviousPlaceholder(labelledOwner);
  }
  const ownedBy = /\bowned\s+by\s+([^;|]+)/iu.exec(value)?.[1]?.trim();
  return ownedBy !== undefined && ownedBy.length >= 3 && !hasObviousPlaceholder(ownedBy);
}

function hasDurableEvidenceReference(value: string): boolean {
  if (/\bartifact:[\p{Letter}\p{Number}][\p{Letter}\p{Number}_.\/@:#-]*/iu.test(value)) return true;
  if (/https?:\/\/[^\s|)]+/iu.test(value)) return true;
  if (/\bgit:[0-9a-f]{7,64}\b/iu.test(value)) return true;

  const knownFileExtension = "(?:md|markdown|log|txt|tap|json|jsonl|xml|trx|lcov|html?|ya?ml|toml|csv|tsv|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|swift|rb|php|cs|fs|fsx|c|h|cc|cpp|cxx|hpp|sh|bash|zsh|ps1|sql|feature|snap|lock)";
  if (new RegExp(
    `(?:[\\p{Letter}\\p{Number}_@.+-]+/)*[\\p{Letter}\\p{Number}_@+-][\\p{Letter}\\p{Number}_.@+-]*\\.${knownFileExtension}\\b`,
    "iu",
  ).test(value)) return true;

  const simpleExactToolCommand = /^(?:\$\s*)?(?:npm|npx|pnpm|yarn|node|bun|deno|pytest|python3?|cargo|go|mvn|gradle|make|dotnet)\s+[\p{Letter}\p{Number}_@.\/:=+-]+$/iu;
  if (simpleExactToolCommand.test(value.trim())) return true;
  const fencedExactToolCommand = /^(?:\$\s*)?(?:npm|npx|pnpm|yarn|node|bun|deno|pytest|python3?|cargo|go|mvn|gradle|make|dotnet)\s+\S+(?:\s+\S+)*$/iu;
  const commandProse = /\b(?:and|assert(?:ed|ion)?|because|but|evidence|fail(?:ed|ure)?|passed|result|was|were|without)\b/iu;
  const isExactToolCommand = (candidate: string) =>
    fencedExactToolCommand.test(candidate) && !commandProse.test(candidate);
  if (isExactToolCommand(value.trim())) return true;
  return [...value.matchAll(/`([^`\r\n]+)`/gu)]
    .some((match) => isExactToolCommand((match[1] ?? "").trim()));
}

function validateSecurityFindingClosure(
  section: MarkdownSection,
  issues: string[],
): void {
  const body = section.body;
  const tableRows = actionableFindingTableRows(body, "ENG-REV");
  const hasNoneFound = /\bnone\s+found\b/iu.test(body);
  const hasContradictoryOpenFinding = hasNoneFound
    && /\bnone\s+found\b[^\n]{0,200}\bhowever\b[^\n]{0,200}\b(?:open|pending|blocked|unresolved|remains?)\b/iu.test(body);
  if (hasContradictoryOpenFinding) {
    issues.push("engineering-review: Security surface contradicts none found with an open critical/high finding");
  }

  const hasFinding = tableRows.findings.length > 0 || hasContradictoryOpenFinding || body.split(/\r?\n/u)
    .map(cleanStructuralLine)
    .some((line) => (
      (/^ENG-REV-\d{3}\b/u.test(line) || /^findings?\s*(?::|—|-)/iu.test(line))
      && !/\bnone\s+found\b/iu.test(line)
    ));
  if (!hasFinding) return;

  const statusValues = body.split(/\r?\n/u)
    .map(cleanStructuralLine)
    .flatMap((line) => {
      const match = /^status\s*(?::|=|\||—|-)\s*(.+)$/iu.exec(line);
      return match?.[1] ? [match[1].trim()] : [];
    });
  statusValues.push(...tableRows.findings.flatMap((cells) => cells[5] ? [cells[5]] : []));
  const hasTerminalStatus = statusValues.length > 0 && statusValues.every((value) =>
    /^(?:resolved|closed|remediated|fixed)\b/iu.test(value)
    && !/\b(?:not|never|open|pending|blocked|unresolved)\b/iu.test(value)
  );
  if (!hasTerminalStatus) {
    issues.push("engineering-review: Security surface finding must have an explicit Resolved or Closed status");
  }

  const ownerValues = namedFieldValue(body, "Human decision owner") !== undefined
    ? [namedFieldValue(body, "Human decision owner")!]
    : tableRows.findings.flatMap((cells) => cells[4] ? [cells[4]] : []);
  if (ownerValues.length === 0 || ownerValues.some((owner) =>
    owner.length < 5
    || /\b(?:agent|AI|model|codex|software engineer|chatgpt|LLM|claude|gemini|copilot|bot|assistant)\b/iu.test(owner)
  )) {
    issues.push("engineering-review: Security surface finding needs a non-Agent human decision owner");
  }

  const fieldReference = namedFieldValue(body, "Human decision reference");
  const referenceValues = fieldReference !== undefined
    ? [fieldReference]
    : tableRows.findings.flatMap((cells) => {
      const value = /\bhuman(?:[-\s]+)decision(?:\s+reference)?\s*(?::|=|—|-)\s*(.+)$/iu
        .exec(cells[5] ?? "")?.[1];
      return value ? [value] : [];
    });
  if (referenceValues.length === 0 || referenceValues.some((reference) =>
    reference.length < 8
    || !/(?:artifact:|https?:\/\/|(?:[\p{Letter}\p{Number}_.-]+\/)+[\p{Letter}\p{Number}_.\/-]+|[\p{Letter}\p{Number}_.-]+\.(?:md|log|txt|json)\b|(?:decision|review|SEC)-[\p{Letter}\p{Number}_.-]+)/iu.test(reference)
  )) {
    issues.push("engineering-review: Security surface finding needs a durable human decision reference");
  }
}

function displaySectionTitle(section: MarkdownSection): string {
  return section.title.replace(/(^|\s)\p{Letter}/gu, (value) => value.toLocaleUpperCase("en-US"));
}

function validateEngineeringProvenance(content: string, issues: string[]): void {
  if (claimsSoftwareEngineerAuthority(content)) {
    issues.push(
      "engineering-provenance: merge, release, security risk, scope, and architecture decisions must remain human-owned",
    );
  }


  for (const heading of [
    "Tool/model",
    "Context loaded",
    "Verification gates",
    "Human decisions",
    "Known limitations",
    "Session duration",
    "SDD approach",
  ] as const) {
    const body = namedSections(content, heading)[0]?.body ?? "";
    const value = body.replace(/[*_`|#-]/gu, " ").replace(/\s+/gu, " ").trim();
    if (value.length < 3 || /^[xX?]+$/u.test(value)) {
      issues.push(`engineering-provenance: section "${heading}" lacks substantive provenance`);
    }
  }

  const expectedEvidenceArtifacts = {
    Spec: "change-contract",
    "Session log": "engineering-session-log",
    Tests: "engineering-test-evidence",
    Review: "engineering-review",
  } as const;
  for (const field of ["Spec", "Session log", "Tests", "Review"] as const) {
    const value = namedFieldValue(content, field);
    if (
      value === undefined
      || value.length < 5
      || !(
        containsExactIdentifier(value, expectedEvidenceArtifacts[field])
        || /(?:https?:\/\/|(?:^|[\s`])(?:[\w.-]+\/)+[\w./-]+|[\w.-]+\.md\b)/iu.test(value)
      )
    ) {
      issues.push(
        `engineering-provenance: evidence field "${field}" must contain a durable artifact, path, or URL reference`,
      );
    }
  }

  const provenanceLines = content.split(/\r?\n/u).map(cleanStructuralLine);
  const prCreationBoundary = provenanceLines.some((line) =>
    /(?:PR created(?:\s+or\s+|\s*\/\s*)opened by Software Engineer|PR creation\/opening|Pull request creation\/opening)/iu.test(line)
    && /(?:\bNo\b|not performed|human-owned)/iu.test(line)
  );
  const prBoundary = provenanceLines.some((line) =>
    /(?:PR published by Software Engineer|PR publication|Pull request publication)/iu.test(line)
    && /(?:\bNo\b|not performed|human-owned)/iu.test(line)
  );
  const mergeBoundary = provenanceLines.some((line) =>
    /(?:Merge\/deploy\/release performed by Software Engineer|Merge decision)/iu.test(line)
    && /(?:\bNo\b|not performed|human-owned)/iu.test(line)
  );
  const releaseBoundary = provenanceLines.some((line) =>
    /(?:Merge\/deploy\/release performed by Software Engineer|Release decision)/iu.test(line)
    && /(?:\bNo\b|not performed|human-owned)/iu.test(line)
  );
  if (!prCreationBoundary) {
    issues.push(
      "engineering-provenance: Publication boundary must state that PR creation/opening was not performed by Software Engineer",
    );
  }
  if (!prBoundary || !mergeBoundary || !releaseBoundary) {
    issues.push(
      "engineering-provenance: Publication boundary must state that PR publication, merge, and release were not performed by Software Engineer",
    );
  }
}

function namedFieldValue(content: string, expected: string): string | undefined {
  const expectedName = normalizeName(expected);
  for (const sourceLine of content.split(/\r?\n/u)) {
    const line = cleanStructuralLine(sourceLine);
    const match = /^(.+?)(?::|\||—)([\s\S]*)$/u.exec(line);
    if (match === null || normalizeName(match[1] ?? "") !== expectedName) continue;
    const value = (match[2] ?? "").replace(/^\s*\|/u, "").trim();
    if (value.length > 0) return value;
  }
  return undefined;
}

function claimsSoftwareEngineerAuthority(content: string): boolean {
  const action = "(?:approv(?:e|ed|al)|accept(?:ed|ance)?|authori[sz](?:e|ed|ation)|decid(?:e|ed))";
  const boundary = "(?:security|risk|exception|scope|architecture|ADR|DDL|merge|release|deploy|publication|pull request|PR)";
  return content.split(/\r?\n/u).some((sourceLine) => {
    const line = cleanStructuralLine(sourceLine);
    if (
      /^(?:PR published by Software Engineer|(?:Merge|Deploy|Release|Merge\/deploy\/release) performed by Software Engineer)\s*:\s*Yes\b/iu.test(line.trim())
    ) return true;
    if (
      /\bsoftware engineer\b.{0,100}\b(?:published|opened|created|merged|deployed|released|performed)\b/iu.test(line)
      && !/(?:\b(?:did\s+not|never|not\s+performed)\b|:\s*No\b)/iu.test(line)
    ) return true;
    if (
      /\b(?:published|opened|created|merged|deployed|released|performed)\b.{0,100}\bby\s+(?:the\s+)?software engineer\b/iu.test(line)
      && !/(?:\b(?:not|never)\b|:\s*No\b)/iu.test(line)
    ) return true;
    const actorFirst = new RegExp(`software engineer(.{0,120}?)${action}.{0,120}${boundary}`, "iu")
      .exec(line);
    if (actorFirst !== null && !hasAuthorityNegation(actorFirst[1] ?? "")) return true;
    const boundaryFirst = new RegExp(`${boundary}(.{0,120}?)${action}.{0,120}(?:by\\s+)?software engineer`, "iu")
      .exec(line);
    return boundaryFirst !== null && !hasAuthorityNegation(boundaryFirst[1] ?? "");
  });
}

function hasAuthorityNegation(context: string): boolean {
  return /\b(?:did|does|do|has|have|had|is|are|was|were|will|would|can|could|may|must|shall)\s+not\b/iu.test(context)
    || /\b(?:never|cannot|can't|won't|no)\b/iu.test(context);
}

function sectionHasFindingDisposition(section: MarkdownSection): boolean {
  const body = section.body
    .replace(/<!--[\s\S]*?-->/gu, "")
    .trim();
  if (body.length === 0) return false;
  if (/\bnone\s+found\b/iu.test(body)) return true;

  // A Markdown table header called "Finding ID" is structure, not a
  // disposition. Require a non-header finding line or data row.
  return body.split(/\r?\n/u).some((sourceLine) => {
    const line = cleanStructuralLine(sourceLine);
    if (/^finding(?:s|\s+id)?(?:\s*\|.*)?$/iu.test(line)) return false;
    if (/^[-:|\s]+$/u.test(line)) return false;
    return /^findings?\s*(?::|—|-)\s*\S/iu.test(line)
      || /^ENG-(?:REV|ADV)-\d{3}\b/iu.test(line);
  });
}
