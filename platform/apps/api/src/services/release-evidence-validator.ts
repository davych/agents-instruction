import { AppError } from "../domain/errors.js";

export interface ReleaseEvidenceArtifact {
  artifactKey: string;
  content: string;
}

export interface ReleaseEvidenceValidationInput {
  artifacts: ReadonlyArray<ReleaseEvidenceArtifact>;
  expectedRunId?: string;
  expectedInputs?: ReadonlyArray<{
    artifactKey: string;
    filePath: string;
    contentHash: string;
  }>;
}

const requiredHeadings = [
  "Status and immutable bindings",
  "Evidence and supply-chain applicability",
  "Release preconditions",
  "Ordered rollout",
  "Health and smoke checks",
  "Monitoring and response",
  "Rollback and recovery",
  "Incident and escalation",
  "Risks, exceptions, and open decisions",
  "Human go/no-go and execution boundary",
] as const;

const requiredBindingFields = [
  "Run / Change Contract",
  "Release scope",
  "Target environment",
  "Source/product revision",
  "Implementation Notes",
  "Engineering Provenance",
  "Test Report",
  "Release artifact",
  "Artifact digest",
  "Human release owner",
  "Prepared at / by",
] as const;

/**
 * Release approval is a readiness-evidence gate, never a deployment command.
 * It deliberately validates a small stable machine contract while leaving
 * project-specific rollout content to the runbook and its human owner.
 */
export function validateReleaseEvidence(
  input: ReleaseEvidenceValidationInput,
): void {
  const issues: string[] = [];
  const runbooks = input.artifacts.filter(
    ({ artifactKey }) => artifactKey === "release-runbook",
  );
  if (runbooks.length !== 1) {
    issues.push(`release-runbook: expected exactly one current artifact, found ${runbooks.length}`);
    fail(issues);
  }

  const content = runbooks[0]!.content;
  if (content.trim().length < 800) {
    issues.push("release-runbook: content is too short to carry release evidence");
  }
  if (hasUnresolvedPlaceholder(content)) {
    issues.push("release-runbook: unresolved placeholder or unfinished marker found");
  }
  for (const heading of requiredHeadings) {
    if (!sectionBody(content, heading)) {
      issues.push(`release-runbook: required section \"${heading}\" is missing or empty`);
    }
  }

  const readiness = namedField(content, "Release readiness");
  if (readiness !== "Ready for human go/no-go") {
    issues.push("release-runbook: Release readiness must be exactly Ready for human go/no-go");
  }
  const conclusion = namedField(content, "Runbook conclusion");
  if (conclusion !== "Ready for human go/no-go") {
    issues.push("release-runbook: Runbook conclusion must be exactly Ready for human go/no-go");
  }
  const execution = namedField(content, "Deployment execution");
  if (execution !== "Not executed by preparing this runbook.") {
    issues.push("release-runbook: Deployment execution must state that preparation executed nothing");
  }

  for (const field of requiredBindingFields) {
    const value = namedField(content, field);
    if (!isEvidenceValue(value)) {
      issues.push(`release-runbook: ${field} is missing or lacks evidence`);
    }
  }
  const humanOwner = namedField(content, "Human release owner");
  if (!isExplicitHumanOwner(humanOwner)) {
    issues.push(
      "release-runbook: Human release owner must use Human: <role/name reference> and must not name an Agent, model, assistant, automation, bot, or system",
    );
  }
  validateExplicitHumanOwnerFields(content, issues);

  validateTrustedBindings(content, input, issues);
  validateHumanAuthorityBoundary(content, issues);

  validateRevisionAndDigest(content, issues);
  validateTable(content, "Evidence and supply-chain applicability", 4, issues);
  validateTable(content, "Release preconditions", 6, issues);
  validateTable(content, "Ordered rollout", 6, issues);
  validateTable(content, "Health and smoke checks", 7, issues);
  validateTable(content, "Monitoring and response", 6, issues);
  validateTable(content, "Rollback and recovery", 6, issues);
  validateTable(content, "Incident and escalation", 5, issues);
  validateTable(content, "Risks, exceptions, and open decisions", 6, issues);
  for (const contract of [
    { heading: "Release preconditions", ownerColumn: "Owner" },
    { heading: "Ordered rollout", ownerColumn: "Authorized owner" },
    { heading: "Health and smoke checks", ownerColumn: "Owner" },
    { heading: "Monitoring and response", ownerColumn: "Owner" },
    { heading: "Rollback and recovery", ownerColumn: "Authorized owner" },
    { heading: "Incident and escalation", ownerColumn: "Incident/release owner reference" },
    { heading: "Risks, exceptions, and open decisions", ownerColumn: "Human owner" },
  ]) {
    validateHumanOwnerColumn(content, contract.heading, contract.ownerColumn, issues);
  }

  for (const field of [
    "Rollback decision owner",
    "Target recovery time (RTO)",
    "Rollback triggers",
    "Data/schema/config compatibility",
    "Backup/restore prerequisites",
    "Expected recovered state",
    "Go/no-go owner and decision record location",
    "Required revalidation triggers",
  ]) {
    if (!isEvidenceValue(namedField(content, field))) {
      issues.push(`release-runbook: ${field} is missing or lacks evidence`);
    }
  }

  const blockers = namedField(content, "Unresolved blockers");
  if (!blockers || !/^None(?:\b|\s*[-—:(])/iu.test(blockers)) {
    issues.push("release-runbook: Unresolved blockers must be None before approval");
  }
  if (!/Preparing this runbook does not approve or perform deployment/iu.test(content)) {
    issues.push("release-runbook: the human execution boundary is missing");
  }

  if (issues.length > 0) fail(issues);
}

function validateTrustedBindings(
  content: string,
  input: ReleaseEvidenceValidationInput,
  issues: string[],
): void {
  if (input.expectedRunId) {
    const runBinding = namedField(content, "Run / Change Contract") ?? "";
    const boundRunIds = runBinding.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
    ) ?? [];
    const uniqueRunIds = new Set(
      boundRunIds.map((runId) => runId.toLocaleLowerCase("en-US")),
    );
    if (
      uniqueRunIds.size !== 1
      || !uniqueRunIds.has(input.expectedRunId.toLocaleLowerCase("en-US"))
    ) {
      issues.push("release-runbook: Run / Change Contract does not bind the current trusted Run ID");
    }
  }

  const expectedInputs = input.expectedInputs ?? [];
  if (expectedInputs.length === 0) return;
  const manifest = sectionBody(content, "Trusted upstream input bindings");
  if (!manifest) {
    issues.push("release-runbook: Trusted upstream input bindings is missing or empty");
    return;
  }
  const rows = markdownTableRows(manifest);
  const headerIndex = rows.findIndex((row) => (
    row.length === 3
    && normalizeTableCell(row[0] ?? "").toLocaleLowerCase("en-US") === "artifact id"
    && normalizeTableCell(row[1] ?? "").toLocaleLowerCase("en-US") === "current artifact path"
    && normalizeTableCell(row[2] ?? "").toLocaleLowerCase("en-US") === "content hash"
  ));
  if (headerIndex < 0) {
    issues.push("release-runbook: Trusted upstream input bindings needs the canonical three-column table");
    return;
  }
  const dataRows = rows
    .slice(headerIndex + 1)
    .filter((row) => !row.every(isSeparatorCell));
  const parsedRows = dataRows.map((row) => {
    if (row.length !== 3) return undefined;
    const contentHash = exactSha256Cell(row[2] ?? "");
    if (!contentHash) return undefined;
    return {
      artifactKey: normalizeTableCell(row[0] ?? ""),
      filePath: normalizeTableCell(row[1] ?? ""),
      contentHash,
    };
  });
  if (parsedRows.some((row) => !row) || dataRows.length !== expectedInputs.length) {
    issues.push(
      "release-runbook: Trusted upstream input bindings must contain exactly one well-formed row per selected input",
    );
  }
  for (const binding of expectedInputs) {
    const matches = parsedRows.filter((row) => row
      && row.artifactKey === binding.artifactKey
      && row.filePath === binding.filePath
      && row.contentHash === binding.contentHash.toLocaleLowerCase("en-US"));
    if (matches.length !== 1) {
      issues.push(
        `release-runbook: trusted input ${binding.artifactKey} must bind its exact current path and SHA-256 content hash once`,
      );
    }
  }
}

function validateExplicitHumanOwnerFields(content: string, issues: string[]): void {
  for (const { field, value } of namedFieldEntries(content)) {
    if (!/(?:\bowner\b|负责人|所有者|决策人)/iu.test(field)) continue;
    if (isExplicitHumanOwner(value)) continue;
    issues.push(
      `release-runbook: ${field} must use Human: <role/name reference> and must not assign authority to an Agent, model, assistant, automation, bot, or system`,
    );
  }
}

function validateHumanAuthorityBoundary(content: string, issues: string[]): void {
  if (
    hasAffirmativeReleaseOrDeploymentClaim(content)
    || hasAutomatedReleaseAuthorityAssignment(content)
  ) {
    issues.push(
      "release-runbook: readiness guidance must not claim deployment execution or final release approval",
    );
  }
}

function hasAutomatedReleaseAuthorityAssignment(content: string): boolean {
  const automatedActor = /(?:\b(?:ai|codex|claude|copilot|chatgpt|gpt[-\s]?\d+(?:\.\d+)*|openai|gemini|llm|language\s+model|large\s+language\s+model|automation|assistant|agent|bot|system)\b|人工智能|语言模型|大模型|模型助手|智能体|自动化|机器人|系统(?:账号|代理)?)/iu;
  const delegatedAction = /(?:\b(?:deploy|deployment|roll[ -]?out|production\s+go-live|release\s+(?:approval|decision)|approve\s+(?:the\s+)?release|final\s+go[\/-]no-go|decide\s+(?:the\s+)?(?:final\s+)?go[\/-]no-go|execute\s+(?:the\s+)?production|perform\s+(?:the\s+)?deployment)\b|部署|上线|投产|发布(?:审批|决定|决策)?|最终(?:发布|上线|投产)|go[\/-]no-go)/iu;
  const assignment = /(?:\b(?:will|shall|must|may|can|owns?|acts?\s+as|is\s+(?:the\s+)?(?:authorized|responsible))\b|将|会|应|必须|可以|负责|担任|作为)/iu;
  const authorityOwner = /(?:\b(?:deployment|release|go[\/-]no-go)[^\n]{0,48}\bowner\b|(?:部署|发布|上线|投产|go[\/-]no-go)[^\n]{0,32}(?:负责人|所有者|决策人))/iu;
  const explicitNegation = /(?:\b(?:does?|will|shall|must|may|can|is|are)\s+not\b|\bnever\b|\bcannot\b|\bcan't\b|\bisn't\s+authorized\b|不得|不能|不会|不负责|禁止)/iu;
  for (const statement of content.split(/\r?\n|[.;。；]+/u)) {
    if (!automatedActor.test(statement)) continue;
    const assignsAuthority = authorityOwner.test(statement)
      || (assignment.test(statement) && delegatedAction.test(statement));
    if (!assignsAuthority) continue;
    const adversative = /\b(?:but|however|nevertheless)\b|但(?:是)?|然而/iu.exec(statement);
    if (!explicitNegation.test(statement)) return true;
    if (adversative && delegatedAction.test(statement.slice(adversative.index + adversative[0].length))) {
      return true;
    }
  }
  return false;
}

function isExplicitHumanOwner(value: string | undefined): boolean {
  if (!value) return false;
  const match = /^Human:[ \t]*(.+)$/iu.exec(value.trim());
  const identity = match?.[1]?.trim();
  if (!identity || !isEvidenceValue(identity)) return false;
  return !/(?:\b(?:ai|codex|claude|copilot|chatgpt|gpt[-\s]?\d+(?:\.\d+)*|openai|gemini|llm|language\s+model|large\s+language\s+model|automation|assistant|agent|robot|bot|system)\b|人工智能|语言模型|大模型|模型助手|智能体|自动化|机器人|系统(?:账号|代理)?)/iu.test(identity);
}

function hasAffirmativeReleaseOrDeploymentClaim(content: string): boolean {
  const patterns = [
    /\b(?:final\s+)?release\s+(?:is\s+|was\s+|has\s+been\s+)?approved\b/iu,
    /\bdeployment\s+(?:is\s+|was\s+|has\s+been\s+)?(?:completed|executed|performed|approved)\b/iu,
    /\b(?:codex|claude|copilot|chatgpt|gpt[-\s]?\d+(?:\.\d+)*|openai|ai\s+agent|automation|assistant|bot)\b[^\n]{0,100}\b(?:approved|deployed|executed|performed|completed|released)\b/iu,
    /\b(?:approved|deployed|executed|performed|completed|released)\b[^\n]{0,100}\bby\s+(?:codex|claude|copilot|chatgpt|gpt[-\s]?\d+(?:\.\d+)*|openai|an?\s+ai|an?\s+agent|automation|assistant|bot)\b/iu,
    /\b(?:production\s+)?(?:deployment|rollout)\s+(?:is|was|has\s+been)\s+(?:complete|completed|successful|live)\b/iu,
    /\b(?:the\s+)?release\s+(?:is|was|has\s+been)\s+(?:live|complete|completed|successful)\b/iu,
    /\b(?:the\s+)?release\s+went\s+live\b/iu,
    /(?:已|已经|现已)(?:成功)?(?:完成)?(?:生产)?(?:部署|发布|上线|投产)/u,
    /(?:生产)?(?:部署|发布|上线|投产)(?:已|已经)(?:完成|批准|通过|成功|上线)/u,
    /(?:最终)?发布(?:已|已经)(?:批准|通过|完成)/u,
  ];
  for (const statement of content.split(/\r?\n|[.;。；]+/u)) {
    for (const pattern of patterns) {
      const match = pattern.exec(statement);
      if (!match) continue;
      const prefix = statement.slice(Math.max(0, match.index - 24), match.index);
      if (/(?:\b(?:not|never|neither|without)\b|不代表|不表示|并未|尚未|未|不得|不能)[ \t]*$/iu.test(prefix)) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function markdownTableRows(content: string): string[][] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
}

function normalizeTableCell(value: string): string {
  const trimmed = value.trim();
  const inlineCode = /^`([^`\r\n]+)`$/u.exec(trimmed);
  return (inlineCode?.[1] ?? trimmed).trim();
}

function exactSha256Cell(value: string): string | undefined {
  const normalized = normalizeTableCell(value);
  const match = /^(?:sha256:)?([0-9a-f]{64})$/iu.exec(normalized);
  return match?.[1]?.toLocaleLowerCase("en-US");
}

function validateRevisionAndDigest(content: string, issues: string[]): void {
  const sourceRevision = namedField(content, "Source/product revision") ?? "";
  if (!/(?:\b[0-9a-f]{7,64}\b|\b(?:commit|revision|workspace|tag|sha(?:-?256)?)\b[^\n]{2,})/iu.test(sourceRevision)) {
    issues.push("release-runbook: Source/product revision needs an exact revision identifier");
  }

  const artifact = namedField(content, "Release artifact") ?? "";
  const digest = namedField(content, "Artifact digest") ?? "";
  const artifactNotApplicable = evidenceBackedNotApplicable(artifact);
  if (artifactNotApplicable) {
    if (!evidenceBackedNotApplicable(digest)) {
      issues.push("release-runbook: an inapplicable release artifact needs an evidence-backed digest applicability conclusion");
    }
  } else if (!/\b(?:sha(?:-?256|-?384|-?512)?|blake\w*)\s*:\s*[0-9a-f]{16,}\b/iu.test(digest)) {
    issues.push("release-runbook: an applicable release artifact needs an algorithm-bound digest");
  }

  const testReport = namedField(content, "Test Report") ?? "";
  if (!/(?:test-report|test report|\.md\b)/iu.test(testReport)
    || !/(?:approved|pass(?:ed)?|verification\s+(?:approved|pass(?:ed)?))/iu.test(testReport)) {
    issues.push("release-runbook: Test Report must bind a current passing Verification artifact");
  }
  const provenance = namedField(content, "Engineering Provenance") ?? "";
  if (!/(?:engineering-provenance|provenance|pr-provenance|\.md\b)/iu.test(provenance)) {
    issues.push("release-runbook: Engineering Provenance must have a durable artifact reference");
  }
}

function validateTable(
  content: string,
  heading: string,
  minimumColumns: number,
  issues: string[],
): void {
  const body = sectionBody(content, heading);
  if (!body) return;
  const rows = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
  const dataRows = rows.slice(1).filter((row) => !row.every(isSeparatorCell));
  if (dataRows.length === 0) {
    issues.push(`release-runbook: ${heading} needs at least one evidence row`);
    return;
  }
  for (const [index, row] of dataRows.entries()) {
    if (row.length < minimumColumns || row.some((cell) => !isEvidenceValue(cell))) {
      issues.push(`release-runbook: ${heading} row ${index + 1} is incomplete`);
      break;
    }
  }
}

function validateHumanOwnerColumn(
  content: string,
  heading: string,
  ownerColumn: string,
  issues: string[],
): void {
  const body = sectionBody(content, heading);
  if (!body) return;
  const rows = markdownTableRows(body);
  const headerIndex = rows.findIndex((row) => row.some((cell) => (
    normalizeTableCell(cell).toLocaleLowerCase("en-US")
      === ownerColumn.toLocaleLowerCase("en-US")
  )));
  if (headerIndex < 0) {
    issues.push(`release-runbook: ${heading} is missing its ${ownerColumn} authority column`);
    return;
  }
  const header = rows[headerIndex] ?? [];
  const ownerIndex = header.findIndex((cell) => (
    normalizeTableCell(cell).toLocaleLowerCase("en-US")
      === ownerColumn.toLocaleLowerCase("en-US")
  ));
  const dataRows = rows.slice(headerIndex + 1).filter((row) => !row.every(isSeparatorCell));
  for (const [index, row] of dataRows.entries()) {
    if (!isExplicitHumanOwner(normalizeTableCell(row[ownerIndex] ?? ""))) {
      issues.push(
        `release-runbook: ${heading} row ${index + 1} ${ownerColumn} must use Human: <role/name reference>`,
      );
      break;
    }
  }
}

function sectionBody(content: string, heading: string): string | undefined {
  const lines = content.split(/\r?\n/u);
  const normalizedHeading = normalize(heading);
  const start = lines.findIndex((line) => {
    const match = /^##\s+(.+?)\s*$/u.exec(line);
    return match ? normalize(match[1] ?? "") === normalizedHeading : false;
  });
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/u.test(line)) break;
    body.push(line);
  }
  const value = body.join("\n").trim();
  return value || undefined;
}

function namedField(content: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `^[ \\t]*[-*][ \\t]+\\*\\*${escaped}:\\*\\*[ \\t]*(.+?)[ \\t]*$`,
    "imu",
  )
    .exec(content);
  return match?.[1]?.trim();
}

function namedFieldEntries(content: string): Array<{ field: string; value: string }> {
  const pattern = /^[ \t]*[-*][ \t]+\*\*([^*\r\n]+?):\*\*[ \t]*(.+?)[ \t]*$/gimu;
  return [...content.matchAll(pattern)].map((match) => ({
    field: (match[1] ?? "").trim(),
    value: (match[2] ?? "").trim(),
  }));
}

function isEvidenceValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim();
  if (
    (!/^\d+$/u.test(normalized) && normalized.length < 3)
    || hasUnresolvedPlaceholder(normalized)
  ) return false;
  if (/^(?:unknown|none|n\/?a|not applicable|pending|blocked|not run|unverified)[.!]?$/iu.test(normalized)) {
    return false;
  }
  return /[\p{L}\p{N}]/u.test(normalized);
}

function evidenceBackedNotApplicable(value: string): boolean {
  return /\bnot applicable\b/iu.test(value)
    && /(?:because|reason|evidence|contract|scope|docs?|no\s+(?:artifact|package|binary|image)|由于|依据|范围)/iu.test(value);
}

function hasUnresolvedPlaceholder(value: string): boolean {
  const withoutCapabilityMarker = value.replace(
    /<!--\s*ai-sdlc:release-evidence-v1\s*-->/giu,
    "",
  );
  return /<[^>\n]+>|\{\{[^}\n]+\}\}|\b(?:TODO|TBD|FIXME|XXX)\b/iu.test(
    withoutCapabilityMarker,
  );
}

function isSeparatorCell(value: string): boolean {
  return /^:?-{3,}:?$/u.test(value);
}

function normalize(value: string): string {
  return value.replace(/[*_`]/gu, "").trim().toLocaleLowerCase("en-US");
}

function fail(issues: string[]): never {
  throw new AppError(
    `发布证据审批校验失败：${issues.slice(0, 3).join("；")}`,
    409,
    "RELEASE_EVIDENCE_GATE_FAILED",
    { issues },
  );
}
