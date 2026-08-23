import { AppError } from "../domain/errors.js";

interface VerificationArtifact {
  artifactKey: string;
  content: string;
}

export interface VerificationEvidenceGateInput {
  artifacts: ReadonlyArray<VerificationArtifact>;
  acceptanceCriteria?: ReadonlyArray<string> | null;
  regressionScope?: ReadonlyArray<string> | null;
  /** Trusted signals derived outside the report itself. */
  authoritativeE2eReasons?: ReadonlyArray<string>;
}

export interface VerificationEvidenceGateResult {
  currentRevision: string;
  e2eRequired: boolean;
  standaloneExecutionCount: number;
  executionRows: ReadonlyArray<ExecutionRow>;
  coverageRows: ReadonlyArray<CoverageRow>;
}

interface MarkdownSection {
  title: string;
  body: string;
}

export interface ExecutionRow {
  execution: string;
  command: string;
  revisionAndEnvironment: string;
  result: string;
  evidence: string;
}

export interface CoverageRow {
  trace: string;
  testOrObservation: string;
  evidence: string;
  result: string;
}

export interface ExactExecutionCommand {
  command: string;
  workingDirectory: string;
}

const errorCode = "VERIFICATION_EVIDENCE_GATE_FAILED";
const standardHtmlTags = new Set([
  "a", "abbr", "address", "article", "aside", "audio", "b", "bdi", "bdo", "blockquote",
  "body", "br", "button", "canvas", "caption", "cite", "code", "col", "colgroup", "data",
  "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt", "em", "embed",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "head", "header", "hgroup", "hr", "html", "i", "iframe", "img", "input", "ins", "kbd",
  "label", "legend", "li", "link", "main", "map", "mark", "menu", "meta", "meter", "nav",
  "noscript", "object", "ol", "optgroup", "option", "output", "p", "picture", "pre", "progress",
  "q", "rp", "rt", "ruby", "s", "samp", "script", "search", "section", "select", "slot", "small",
  "source", "span", "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "template",
  "textarea", "tfoot", "th", "thead", "time", "title", "tr", "track", "u", "ul", "var", "video",
  "wbr",
]);

/**
 * Validates the ordinary Verification evidence contract independently from the
 * deferred-Design ledger. A human approval is still required, but prose cannot
 * turn an MCP exploration, an unrun command, or an untested criterion into a
 * passing Test Report.
 */
export function validateVerificationEvidenceGate(
  input: VerificationEvidenceGateInput,
): VerificationEvidenceGateResult {
  const issues: string[] = [];
  const reports = input.artifacts.filter(({ artifactKey }) => artifactKey === "test-report");
  if (reports.length !== 1) {
    issues.push(`test-report: expected exactly one current artifact, found ${reports.length}`);
  }
  const content = reports[0]?.content ?? "";
  if (!meaningful(content)) {
    issues.push("test-report: current artifact is missing or empty");
  }
  if (hasTemplatePlaceholder(content)) {
    issues.push("test-report: unresolved template placeholder found");
  }

  const statusSection = namedSection(content, "Status and recommendation");
  const verificationState = statusSection
    ? namedFieldValue(statusSection.body, "Verification state")
    : undefined;
  if (!verificationState || !/^ready for release review[.!]?$/iu.test(verificationState)) {
    issues.push("test-report: Verification state must be exactly Ready for release review");
  }

  const currentRevision = statusSection
    ? namedFieldValue(statusSection.body, "Current revision")
    : undefined;
  if (!isCurrentRevision(currentRevision)) {
    issues.push("test-report: Current revision must identify the exact commit, build, or working revision");
  }

  const crystallization = namedSection(content, "E2E Stage 2: Crystallization");
  const e2eDisposition = crystallization
    ? namedFieldValue(crystallization.body, "E2E script required")
    : undefined;
  const e2eRequired = /^yes\b/iu.test(e2eDisposition ?? "");
  if (!/^(?:yes|no)\b/iu.test(e2eDisposition ?? "")) {
    issues.push("test-report: E2E script required must declare yes or no with a reason");
  }
  if (!e2eRequired && (input.authoritativeE2eReasons?.length ?? 0) > 0) {
    issues.push(
      `test-report: E2E script required cannot be no because authoritative signals require E2E (${input.authoritativeE2eReasons!.join(", ")})`,
    );
  }

  const executionSection = namedSection(content, "E2E Stage 3: Execution");
  const executionRows = executionSection ? parseExecutionRows(executionSection.body) : [];
  if (!executionSection || executionRows.length === 0) {
    issues.push("test-report: E2E Stage 3 must contain a real standalone execution row");
  }
  const parsedCommands = executionRows.map((row) => {
    const exact = parseExactExecutionCommand(row.command);
    return { exact, kind: exact ? classifyStandaloneTestCommand(exact.command) : undefined };
  });
  if (!e2eRequired && parsedCommands.some(({ kind }) => kind === "e2e")) {
    issues.push(
      "test-report: E2E script required cannot be no because the canonical execution command invokes an E2E runner",
    );
  }

  let standaloneExecutionCount = 0;
  for (const [index, row] of executionRows.entries()) {
    const label = `test-report: execution row ${index + 1}`;
    const { exact: exactExecution, kind: commandKind } = parsedCommands[index]!;
    if (hasBlockedOrUntestedResult(row.result)) {
      issues.push(`${label} is blocked or untested and cannot support approval`);
      continue;
    }
    if (!hasPassingResult(row.result) || !hasSuccessfulExit(row.result)) {
      issues.push(`${label} must record pass and exit status 0`);
      continue;
    }
    if (!exactExecution || !commandKind) {
      issues.push(`${label} has no exact autonomous test-runner command; expected exactly one backticked command followed by one backticked working directory`);
      continue;
    }
    if (e2eRequired && commandKind !== "e2e") {
      issues.push(`${label} must invoke the repository Playwright/E2E runner without MCP`);
      continue;
    }
    if (!meaningful(row.revisionAndEnvironment)) {
      issues.push(`${label} is missing revision and environment`);
      continue;
    }
    if (currentRevision && !tracesCurrentRevision(row.revisionAndEnvironment, currentRevision)) {
      issues.push(`${label} does not trace Current revision ${currentRevision}`);
      continue;
    }
    if (!hasDurableEvidenceAnchor(row.evidence)) {
      issues.push(`${label} has no durable report, log, trace, or run reference`);
      continue;
    }
    if (claimsRemoteCiPass(row) && !hasRemoteCiReference(row.evidence)) {
      issues.push(`${label} claims a remote CI pass without a durable CI URL or run/build/job ID`);
      continue;
    }
    standaloneExecutionCount += 1;
  }
  if (executionRows.length > 0 && standaloneExecutionCount === 0) {
    issues.push("test-report: no passing standalone execution remains after evidence validation");
  }

  const requiredTraceIds = [
    ...traceIds(input.acceptanceCriteria ?? [], "CC-AC"),
    ...traceIds(input.regressionScope ?? [], "REG"),
  ];
  const coverageSection = namedSection(content, "Acceptance and regression results");
  const coverageRows = coverageSection ? parseCoverageRows(coverageSection.body) : [];
  if (requiredTraceIds.length > 0 && coverageRows.length === 0) {
    issues.push("test-report: Acceptance and regression results table is required");
  }
  for (const traceId of requiredTraceIds) {
    const matching = coverageRows.filter((row) => containsExactIdentifier(row.trace, traceId));
    if (matching.length === 0) {
      issues.push(`test-report: ${traceId} is missing from Acceptance and regression results`);
      continue;
    }
    const passing = matching.some((row) => (
      meaningful(row.testOrObservation)
      && hasDurableEvidenceAnchor(row.evidence)
      && hasPassingResult(row.result)
      && !hasBlockedOrUntestedResult(`${row.result} ${row.evidence}`)
    ));
    if (!passing) {
      issues.push(`test-report: ${traceId} has no passing test/observation with durable execution evidence`);
    }
  }
  if (coverageRows.some((row) => hasBlockedOrUntestedResult(row.result))) {
    issues.push("test-report: Acceptance and regression results contains blocked or untested coverage");
  }

  const gaps = namedSection(content, "Coverage gaps");
  if (gaps && /\b(?:blocked|untested|not\s+(?:run|tested|executed)|pending)\b|(?:阻塞|未测试|未运行|未执行|待定|待补)/iu.test(gaps.body)) {
    issues.push("test-report: Coverage gaps contains an unresolved verification gap");
  }
  const failures = namedSection(content, "Failure classification and routing");
  if (failures && /\|\s*open\s*\|/iu.test(failures.body)) {
    issues.push("test-report: Failure classification contains an open failure");
  }

  if (issues.length > 0 || !currentRevision) fail(issues);
  return {
    currentRevision,
    e2eRequired,
    standaloneExecutionCount,
    executionRows,
    coverageRows,
  };
}

/**
 * The command cell is a small machine contract, not prose. Parsing it once
 * prevents an unexecuted command elsewhere in the cell from influencing a
 * different semantic or provenance check.
 */
export function parseExactExecutionCommand(value: string): ExactExecutionCommand | undefined {
  const match = /^\s*`([^`\r\n]+)`\s+from\s+`([^`\r\n]+)`\s*$/iu.exec(value);
  const command = match?.[1]?.trim();
  const workingDirectory = match?.[2]?.trim();
  if (!command || !workingDirectory) return undefined;
  return { command, workingDirectory };
}

function parseExecutionRows(body: string): ExecutionRow[] {
  return parseTable<ExecutionRow>(body, {
    execution: "execution",
    command: "exact command and working directory",
    revisionAndEnvironment: "revision and environment",
    result: "result",
    evidence: "durable evidence",
  });
}

function parseCoverageRows(body: string): CoverageRow[] {
  return parseTable<CoverageRow>(body, {
    trace: "criterion or regression obligation",
    testOrObservation: "repository test or observation",
    evidence: "execution evidence",
    result: "result",
  });
}

function parseTable<T extends object>(
  body: string,
  columns: { [K in keyof T]: string },
): T[] {
  const lines = body.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  for (let headerLine = 0; headerLine < lines.length; headerLine += 1) {
    const header = markdownCells(lines[headerLine]!).map(normalizeName);
    const keys = Object.keys(columns) as Array<keyof T>;
    const indexes = Object.fromEntries(
      keys.map((key) => [key, header.indexOf(normalizeName(columns[key]))]),
    ) as { [K in keyof T]: number };
    if (keys.some((key) => indexes[key] < 0)) continue;

    const rows: T[] = [];
    for (const line of lines.slice(headerLine + 1)) {
      const cells = markdownCells(line);
      if (cells.every(isSeparatorCell)) continue;
      const row = Object.fromEntries(
        keys.map((key) => [key, (cells[indexes[key]] ?? "").trim()]),
      ) as T;
      rows.push(row);
    }
    return rows;
  }
  return [];
}

function parseMarkdownSections(content: string): MarkdownSection[] {
  const lines = content.split(/\r?\n/u);
  const headings = lines.flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    return match ? [{ level: match[1]!.length, title: normalizeName(match[2]!), line: index }] : [];
  });
  return headings.map((heading, index) => {
    let end = lines.length;
    for (const candidate of headings.slice(index + 1)) {
      if (candidate.level <= heading.level) {
        end = candidate.line;
        break;
      }
    }
    return { title: heading.title, body: lines.slice(heading.line + 1, end).join("\n").trim() };
  });
}

function namedSection(content: string, title: string): MarkdownSection | undefined {
  const normalized = normalizeName(title);
  return parseMarkdownSections(content).find((section) => section.title === normalized);
}

function namedFieldValue(body: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  for (const sourceLine of body.split(/\r?\n/u)) {
    const line = sourceLine
      .replace(/^\s*(?:[-*+]\s+|>\s*)/u, "")
      .replace(/[*_`]/gu, "")
      .trim();
    const match = new RegExp(`^${escaped}\\s*[:：]\\s*(.+)$`, "iu").exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function traceIds(values: ReadonlyArray<string>, prefix: "CC-AC" | "REG"): string[] {
  return values.map((value, index) => stableTraceId(value)
    ?? `${prefix}-${String(index + 1).padStart(3, "0")}`);
}

function stableTraceId(value: string): string | undefined {
  const match = /^\s*(?:[-*]\s*)?(?:[*_`]*)?([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)(?:[*_`]*)?\s*(?::|—|-)\s+\S/u
    .exec(value);
  return match?.[1];
}

function containsExactIdentifier(content: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^A-Z0-9-])${escaped}(?![A-Z0-9-])`, "u").test(content);
}

function markdownCells(line: string): string[] {
  return line.slice(1, -1).split("|").map((cell) => cell.trim());
}

function normalizeName(value: string): string {
  return value.replace(/[*_`]/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function isSeparatorCell(value: string): boolean {
  return /^:?-{3,}:?$/u.test(value);
}

function meaningful(value: string | undefined): value is string {
  if (!value) return false;
  const text = value.trim();
  return text.length >= 3
    && /[\p{L}\p{N}]/u.test(text)
    && !/^(?:n\/?a|none|unknown|tbd|todo|pending|blocked|untested|not\s+(?:run|tested|executed)|<[^>]*>|\{\{[^}]*\}\})[.!]?$/iu.test(text);
}

function hasTemplatePlaceholder(content: string): boolean {
  const unresolvedAnglePlaceholder = [...content.matchAll(/<([^>\r\n]+)>/gu)]
    .some((match) => !isStandardHtmlTag(match[1] ?? ""));
  return unresolvedAnglePlaceholder
    || /\{\{[^}\r\n]+\}\}|\b(?:tbd|todo|placeholder)\b|Ready for release review\s*\/\s*Failed\s*\/\s*Blocked/iu.test(content);
}

function isStandardHtmlTag(value: string): boolean {
  const tag = /^\/?\s*([a-z][a-z0-9-]*)(?:\s+[^<>]*)?\/?\s*$/u.exec(value)?.[1];
  return Boolean(tag && standardHtmlTags.has(tag));
}

function isCurrentRevision(value: string | undefined): value is string {
  return meaningful(value)
    && value.length >= 7
    && !/^(?:current|latest|head|main|master|working tree|local)$/iu.test(value.trim());
}

function hasPassingResult(value: string): boolean {
  const normalized = value.replace(/[*_`]/gu, "").trim();
  return /^(?:pass(?:ed)?|success(?:ful|fully)?|succeeded)\b/iu.test(normalized)
    || /^通过(?:\s|[;；,.，。()]|$)/u.test(normalized);
}

function hasSuccessfulExit(value: string): boolean {
  return /\bexit(?:\s+(?:code|status))?\s*(?::|=|\||—|-)?\s*0\b|(?:退出码|退出状态)\s*(?::|=|\||—|-)?\s*0\b/iu.test(value);
}

function hasBlockedOrUntestedResult(value: string): boolean {
  return /\b(?:blocked|untested|not\s+(?:run|tested|executed)|skipped|pending)\b|(?:阻塞|未测试|未运行|未执行|跳过|待定|待补)/iu.test(value);
}

type StandaloneTestCommandKind = "test" | "e2e";

/**
 * Classifies only one directly invoked, shell-unambiguous runner. An exit-0
 * command hash proves that exact shell string ran; this grammar prevents a
 * comment, echo/printf, assignment, or compound command from turning an
 * unexecuted runner name into evidence.
 */
function classifyStandaloneTestCommand(value: string): StandaloneTestCommandKind | undefined {
  const command = value.trim().replace(/\s+/gu, " ");
  if (
    !command
    || /\bmcp\b/iu.test(command)
    || /[\r\n#;&|<>'"`\\$(){}\[\]]/u.test(command)
    || /(?:^|\s)--?(?:help|version|list|list-files|collect-only|dry-run|if-present|pass-?with-?no-?tests|allow-?no-?tests)(?:\s|=|$)|(?:^|\s)-(?:h|v)(?:\s|$)/iu.test(command)
  ) return undefined;

  const packageE2e = String.raw`(?:test(?::|-)e2e|e2e(?::|-)test|e2e)(?::[A-Za-z0-9_.-]+)*`;
  const packageTest = String.raw`test(?::[A-Za-z0-9_.-]+)?`;
  const packageRunner = String.raw`(?:npm|pnpm|yarn|bun)`;
  const corepack = String.raw`(?:corepack\s+)?`;
  const safePackage = String.raw`[@A-Za-z0-9_./-]+`;
  const suffix = String.raw`(?:\s+[^\s]+)*`;
  const directPlaywright = new RegExp(
    String.raw`^(?:(?:npx|bunx)\s+|(?:pnpm|yarn)\s+(?:exec\s+)?|npm\s+exec\s+(?:--\s+)?|(?:\./)?node_modules/\.bin/)?playwright\s+test${suffix}$`,
    "iu",
  );
  const packageE2eRunner = new RegExp(
    String.raw`^${corepack}${packageRunner}\s+(?:run\s+)?${packageE2e}${suffix}$`,
    "iu",
  );
  const workspaceE2eRunner = new RegExp(
    String.raw`^(?:yarn\s+workspace\s+${safePackage}\s+${packageE2e}|npm\s+--workspace\s+${safePackage}\s+run\s+${packageE2e}|pnpm\s+--filter\s+${safePackage}\s+(?:run\s+)?${packageE2e})${suffix}$`,
    "iu",
  );
  const e2eScript = new RegExp(
    String.raw`^(?:(?:bash|sh)\s+)?(?:\./)?[A-Za-z0-9_./-]*e2e[A-Za-z0-9_./-]*\.sh${suffix}$`,
    "iu",
  );
  const e2eTask = new RegExp(String.raw`^(?:make|just)\s+${packageE2e}${suffix}$`, "iu");
  if (
    directPlaywright.test(command)
    || packageE2eRunner.test(command)
    || workspaceE2eRunner.test(command)
    || e2eScript.test(command)
    || e2eTask.test(command)
  ) return "e2e";

  const packageTestRunner = new RegExp(
    String.raw`^${corepack}${packageRunner}\s+(?:run\s+)?${packageTest}${suffix}$`,
    "iu",
  );
  const directTestRunner = new RegExp(
    String.raw`^(?:node\s+--test|(?:python3?|py)\s+-m\s+pytest|pytest|cargo\s+test|go\s+test|dotnet\s+test|(?:\./)?mvnw?\s+test|(?:\./)?gradlew?\s+test|bun\s+test)${suffix}$`,
    "iu",
  );
  const testScript = new RegExp(
    String.raw`^(?:(?:bash|sh)\s+)?(?:\./)?[A-Za-z0-9_./-]*(?:test|check)[A-Za-z0-9_./-]*\.sh${suffix}$`,
    "iu",
  );
  const testTask = new RegExp(String.raw`^(?:make|just)\s+[A-Za-z0-9_.:-]*(?:test|check)[A-Za-z0-9_.:-]*${suffix}$`, "iu");
  return packageTestRunner.test(command)
    || directTestRunner.test(command)
    || testScript.test(command)
    || testTask.test(command)
    ? "test"
    : undefined;
}

function tracesCurrentRevision(executionValue: string, currentRevision: string): boolean {
  const normalizedExecution = normalizeTraceValue(executionValue);
  const normalizedCurrent = normalizeTraceValue(currentRevision);
  if (normalizedCurrent.length >= 7 && normalizedExecution.includes(normalizedCurrent)) return true;
  const currentTokens = revisionTokens(currentRevision);
  const executionTokens = new Set(revisionTokens(executionValue));
  return currentTokens.some((token) => executionTokens.has(token));
}

function revisionTokens(value: string): string[] {
  return value.toLowerCase().match(/\b[a-f0-9]{7,40}\b|(?=[a-z0-9_-]*\d)[a-z0-9][a-z0-9._-]{5,}/gu) ?? [];
}

function normalizeTraceValue(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function hasDurableEvidenceAnchor(value: string): boolean {
  return meaningful(value)
    && /https?:\/\/\S+|(?:^|[\s`(])(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.()-]+)+|\b[\w@.-]+\.(?:html?|json|xml|log|txt|tap|junit|zip|png|jpe?g|webp|webm|mp4|md)\b|\b(?:run|session|report|output|artifact|trace|build|job|check|运行|会话|报告|输出|产物)\s*(?:id|#|:)?\s*[A-Za-z0-9][A-Za-z0-9._-]{2,}\b/iu.test(value);
}

function claimsRemoteCiPass(row: ExecutionRow): boolean {
  return /\b(?:remote\s+ci|ci\s+(?:run|job|check)|github\s+actions|gitlab\s+ci|circleci|buildkite|jenkins)\b|(?:远程\s*CI|CI\s*(?:运行|任务|检查))/iu.test(`${row.execution} ${row.evidence}`);
}

function hasRemoteCiReference(value: string): boolean {
  return /https?:\/\/\S+/iu.test(value)
    || /\b(?:ci\s+)?(?:run|build|job|check)\s*(?:id|#|:|=)\s*[A-Za-z0-9][A-Za-z0-9._-]{2,}\b/iu.test(value)
    || /(?:CI\s*)?(?:运行|构建|任务|检查)(?:编号|ID|#|：|:)\s*[A-Za-z0-9][A-Za-z0-9._-]{2,}/iu.test(value);
}

function fail(issues: string[]): never {
  throw new AppError(
    `测试报告审批校验失败：${issues.slice(0, 3).join("；")}`,
    409,
    errorCode,
    { issues },
  );
}
