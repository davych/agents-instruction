import { AppError } from "../domain/errors.js";
import {
  assessDeferredDesignValidations,
  type DeferredDesignEvidenceType,
  type DeferredDesignValidation,
} from "../domain/design-deferred-validation.js";

interface ArtifactContent {
  artifactKey: string;
  content: string;
}

export interface DeferredDesignVerificationGateInput {
  designArtifacts: ReadonlyArray<ArtifactContent>;
  verificationArtifacts: ReadonlyArray<ArtifactContent>;
}

export interface DeferredDesignVerificationGateResult {
  obligationIds: string[];
}

const errorCode = "DEFERRED_DESIGN_VERIFICATION_GATE_FAILED";

/**
 * Prevents a post-implementation Design obligation from disappearing between
 * Design and Release. The Design Spec remains the source of obligations and
 * the Test Report is the source of their real-environment result.
 */
export function validateDeferredDesignVerificationGate(
  input: DeferredDesignVerificationGateInput,
): DeferredDesignVerificationGateResult {
  const designSpec = input.designArtifacts.find(
    (artifact) => artifact.artifactKey === "design-spec",
  );
  if (!designSpec) return { obligationIds: [] };

  const envelope = parseDesignEnvelope(designSpec.content);
  if (envelope.kind === "invalid") {
    fail(["design-spec: deferred verification contract JSON is invalid"]);
  }
  if (envelope.kind === "absent") {
    fail(["design-spec: machine-readable contract JSON is missing"]);
  }

  const assessment = assessDeferredDesignValidations(
    envelope.value.deferred_validations,
  );
  if (assessment.errors.length > 0) {
    fail(assessment.errors.map((issue) => `design-spec: ${issue}`));
  }
  if (assessment.entries.length === 0) return { obligationIds: [] };

  const report = input.verificationArtifacts.find(
    (artifact) => artifact.artifactKey === "test-report",
  );
  if (!report || !meaningful(report.content)) {
    fail(["test-report: required for deferred Design verification"]);
  }

  const rows = deferredVerificationRows(report!.content);
  if (!rows) {
    fail(["test-report: missing ## Deferred design verification result table"]);
  }

  const issues = assessment.entries.flatMap((entry) => validateEntry(entry, rows!));
  if (issues.length > 0) fail(issues);
  return { obligationIds: assessment.entries.map((entry) => entry.id) };
}

type DesignEnvelope =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; value: Record<string, unknown> };

function parseDesignEnvelope(content: string): DesignEnvelope {
  const match = /```json\s*([\s\S]*?)```/iu.exec(content);
  if (!match) return { kind: "absent" };
  try {
    const parsed = JSON.parse(match[1] ?? "") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "invalid" };
    }
    return { kind: "valid", value: parsed as Record<string, unknown> };
  } catch {
    return { kind: "invalid" };
  }
}

interface VerificationRow {
  id: string;
  targetsAndChecks: string;
  evidence: string;
  result: string;
}

function deferredVerificationRows(content: string): VerificationRow[] | null {
  const sectionMatch = /^##\s+Deferred design verification\s*$([\s\S]*?)(?=^##\s+|(?![\s\S]))/imu.exec(content);
  if (!sectionMatch) return null;
  const table = (sectionMatch[1] ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map(markdownCells)
    .filter((cells) => cells.length >= 4);
  if (table.length < 2) return [];

  const header = table[0]!.map(normalizeHeader);
  const idIndex = header.findIndex((cell) => cell === "obligation id");
  const targetsIndex = header.findIndex((cell) => cell === "targets and checks");
  const evidenceIndex = header.findIndex((cell) => cell === "real evidence");
  const resultIndex = header.findIndex((cell) => cell === "result");
  if ([idIndex, targetsIndex, evidenceIndex, resultIndex].some((index) => index < 0)) {
    return [];
  }

  return table.slice(1)
    .filter((cells) => !cells.every(isSeparatorCell))
    .map((cells) => ({
      id: (cells[idIndex] ?? "").trim().toUpperCase(),
      targetsAndChecks: (cells[targetsIndex] ?? "").trim(),
      evidence: (cells[evidenceIndex] ?? "").trim(),
      result: (cells[resultIndex] ?? "").trim(),
    }));
}

function validateEntry(
  entry: DeferredDesignValidation,
  rows: ReadonlyArray<VerificationRow>,
): string[] {
  const matching = rows.filter((row) => row.id === entry.id);
  if (matching.length === 0) {
    return [`test-report: ${entry.id} is missing`];
  }
  if (matching.length > 1) {
    return [`test-report: ${entry.id} must appear exactly once`];
  }
  const row = matching[0]!;
  const issues: string[] = [];
  if (!meaningful(row.targetsAndChecks) || hasNegativeExecutionStatement(row.targetsAndChecks)) {
    issues.push(`test-report: ${entry.id} has no executed targets and checks`);
  } else {
    const missingDeclarations = [...entry.targets, ...entry.checks].filter(
      (declared) => !tracesDeclaration(row.targetsAndChecks, declared),
    );
    if (missingDeclarations.length > 0) {
      issues.push(
        `test-report: ${entry.id} does not trace declared targets/checks: ${missingDeclarations.join(", ")}`,
      );
    }
  }
  if (!realEvidence(row.evidence)) {
    issues.push(`test-report: ${entry.id} has no real evidence`);
  } else {
    const missingEvidenceTypes = entry.evidenceTypes.filter(
      (type) => !satisfiesEvidenceType(row.evidence, type),
    );
    if (missingEvidenceTypes.length > 0) {
      issues.push(
        `test-report: ${entry.id} is missing required evidence types: ${missingEvidenceTypes.join(", ")}`,
      );
    }
    if (hasUnresolvedEvidenceFailure(row.evidence, entry)) {
      issues.push(`test-report: ${entry.id} evidence contains an unresolved failure`);
    }
  }
  if (!/^(?:pass|通过)$/iu.test(row.result)) {
    issues.push(`test-report: ${entry.id} result must be pass before approval`);
  }
  return issues;
}

function markdownCells(line: string): string[] {
  return line.slice(1, -1).split("|").map((cell) => cell.trim());
}

function normalizeHeader(value: string): string {
  return value.replace(/[*_`]/gu, "").trim().toLowerCase();
}

function isSeparatorCell(value: string): boolean {
  return /^:?-{3,}:?$/u.test(value.trim());
}

function meaningful(value: string): boolean {
  const text = value.trim();
  return text.length >= 3
    && /[\p{L}\p{N}]/u.test(text)
    && !/^(?:n\/?a|none|unknown|tbd|todo|not run|untested|blocked|<[^>]*>|\{\{[^}]*\}\})[.!]?$/iu.test(text)
    && !/<[^>]+>|\{\{[^}]+\}\}/u.test(text)
    && !/\b(?:tbd|todo|placeholder|pending|not\s+run|not\s+executed|untested|skipped|blocked|evidence\s+(?:missing|pending)|screenshot\s+later|no\s+(?:browser|runtime|evidence|result)[^.;\n]{0,20}(?:available|present)?)\b|(?:未运行|未执行|待补|稍后|不可用|没有[^。；;\n]{0,16}(?:浏览器|运行时|证据|结果))/iu.test(text);
}

function realEvidence(value: string): boolean {
  return meaningful(value)
    && value.trim().length >= 8
    && !/^(?:pass|passed|works?|verified|done|通过|已验证)[.!]?$/iu.test(value.trim())
    && hasDurableEvidenceAnchor(value);
}

function tracesDeclaration(reportValue: string, declaredValue: string): boolean {
  const normalizedReport = normalizeTraceValue(reportValue);
  const normalizedDeclaration = normalizeTraceValue(declaredValue);
  if (normalizedDeclaration.length < 2) return false;
  const escaped = normalizedDeclaration.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu")
    .test(normalizedReport);
}

function normalizeTraceValue(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[×✕]/gu, "x")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function hasUnresolvedEvidenceFailure(
  value: string,
  entry: DeferredDesignValidation,
): boolean {
  const failureCandidate = value
    .replace(/\b(?:zero|no|0)\s+(?:(?:critical|high)\s+)?(?:errors?|violations?)\b/giu, " successful-result ")
    .replace(/\bcompleted\s+with\s+no\s+errors?\b/giu, " completed-successfully ")
    .replace(/(?:无|零|0)\s*(?:项)?\s*(?:严重|高危)?\s*(?:错误|违规)/gu, " 成功结果 ")
    .replace(/未发现[^。；;\n]{0,16}(?:错误|违规)/gu, " 成功结果 ");
  const failure = /\b(?:unavailable|failed?|failure|crash(?:ed)?|errors?|blocked|untested|skipped|pending|zero\s+checks?|no\s+checks?)[^.;\n]{0,32}\b(?:executed|available|completed)?\b|\b(?:(?:was|were|is|are|could|can|did|does|do|would)\s+not|(?:was|were|is|are|could|can|did|does|do|would)n['’]?t)\s+(?:be\s+)?(?:run|start(?:ed)?|execute(?:d)?|launch(?:ed)?|complete(?:d)?)\b|\b(?:execution|run|browser|playwright|chrome)\b[^.;\n]{0,32}\b(?:impossible|absent|unavailable)\b|\bexit(?:ed)?\s*(?:code\s*)?[1-9]\d*\b|\b(?:critical|high)\b[^.;\n]{0,24}\bviolations?\b|(?:不可用|失败|崩溃|错误|阻塞|未测试|跳过|待定|零项?检查|没有执行检查|严重[^。；;\n]{0,12}违规)/iu;
  const match = failure.exec(failureCandidate);
  if (!match) return false;
  const afterFailure = failureCandidate.slice((match.index ?? 0) + match[0].length);
  const explicitRerun = /(?:rerun|retest|after\s+(?:the\s+)?fix|resolved|fixed|随后|修复后|重新运行)[\s\S]{0,240}(?:\bpass(?:ed)?\b|\bexit(?:ed)?\s*(?:code\s*)?0\b|\b(?:zero|no)\s+violations?\b|通过)/iu.test(afterFailure);
  return !explicitRerun
    || !tracesDeclaration(afterFailure, entry.id)
    || !hasDurableEvidenceAnchor(afterFailure)
    || entry.evidenceTypes.some((type) => !satisfiesEvidenceType(afterFailure, type));
}

function hasNegativeExecutionStatement(value: string): boolean {
  return /\b(?:not\s+(?:tested|run|executed)|untested|failed?|failure|blocked|skipped|unavailable|pending)\b|(?:未测试|未运行|未执行|失败|阻塞|跳过|不可用|待定)/iu.test(value);
}

function hasDurableEvidenceAnchor(value: string): boolean {
  return /https?:\/\/\S+|(?:^|[\s`(])(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.()-]+)+|\b[\w@.-]+\.(?:png|jpe?g|webp|json|html?|xml|log|txt|tap|webm|mp4|md)\b|\b(?:run|session|report|output|artifact|screenshot|截图|运行|会话|报告|输出|产物)\s*(?:id|#|:)?\s*[A-Za-z0-9][A-Za-z0-9._-]{2,}\b/iu.test(value);
}

function satisfiesEvidenceType(value: string, type: DeferredDesignEvidenceType): boolean {
  const checks: Record<DeferredDesignEvidenceType, RegExp> = {
    "browser-run": /\b(?:playwright|cypress|webdriver|browser)\b|(?:浏览器运行|浏览器会话)/iu,
    screenshot: /\b(?:screenshot|screen\s*capture)\b|\.(?:png|jpe?g|webp)\b|截图/iu,
    "keyboard-log": /\bkeyboard\b[^.;\n]{0,80}(?:\blog\b|\breport\b|\boutput\b|\.[a-z0-9]{2,5}\b)|键盘[^。；;\n]{0,40}(?:日志|报告|输出|证据)/iu,
    "accessibility-report": /\b(?:axe|a11y|accessibility)\b[^.;\n]{0,80}(?:\breport\b|\boutput\b|\.(?:json|html?|log)\b)|(?:无障碍|辅助技术)[^。；;\n]{0,40}(?:报告|输出|证据)/iu,
    "contrast-report": /\bcontrast\b[^.;\n]{0,80}(?:\bratio\b|\breport\b|\boutput\b|\d(?:\.\d+)?:1)|对比度[^。；;\n]{0,40}(?:比例|报告|输出|证据)/iu,
    "motion-evidence": /\b(?:reduced[- ]motion|motion)\b[^.;\n]{0,80}(?:\breport\b|\bvideo\b|\boutput\b|\.(?:webm|mp4|json|log)\b)|(?:动态|动效|减少动画)[^。；;\n]{0,40}(?:报告|录屏|输出|证据)/iu,
  };
  return checks[type].test(value);
}

function fail(issues: string[]): never {
  throw new AppError(
    `延期设计验证审批失败：${issues.join("；")}`,
    409,
    errorCode,
  );
}
