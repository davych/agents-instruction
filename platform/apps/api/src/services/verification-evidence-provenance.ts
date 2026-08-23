import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { ExecutionDto, ExecutionEventDto } from "@ai-sdlc/contracts";

import type { CurrentArtifactSnapshot } from "../db/store.js";
import { AppError } from "../domain/errors.js";
import { assertRuntimePath } from "./artifact-workspace.js";
import {
  captureVerificationGitState,
  type VerificationGitState,
} from "./verification-git-state.js";
import { isWithin } from "./project-paths.js";
import {
  type CoverageRow,
  type ExecutionRow,
  parseExactExecutionCommand,
  validateVerificationEvidenceGate,
} from "./verification-evidence-validator.js";
import {
  captureVerificationWorkspaceRevision,
  VERIFICATION_RUNTIME_EVIDENCE_PATHS,
} from "./verification-workspace.js";

const errorCode = "VERIFICATION_EVIDENCE_GATE_FAILED";
const maxEvidenceBytes = 64 * 1024 * 1024;

interface VerificationPhaseEvidence {
  id: string;
  executions: ReadonlyArray<ExecutionDto>;
  events: ReadonlyArray<ExecutionEventDto>;
}

export interface VerificationEvidenceProvenanceInput {
  projectRoot: string;
  artifacts: ReadonlyArray<CurrentArtifactSnapshot>;
  phase: VerificationPhaseEvidence;
  acceptanceCriteria?: ReadonlyArray<string> | null;
  regressionScope?: ReadonlyArray<string> | null;
  riskFlags?: ReadonlyArray<string> | null;
}

export interface VerificationEvidenceProvenanceResult {
  executionId: string;
  currentRevision: string;
  workspaceRevisionToken: string;
  evidenceHashes: Readonly<Record<string, string>>;
}

/**
 * Binds a semantic Test Report to records and bytes the platform can verify.
 * The markdown remains reviewable narrative, but it is not its own authority.
 */
export async function validateVerificationEvidenceProvenance(
  input: VerificationEvidenceProvenanceInput,
): Promise<VerificationEvidenceProvenanceResult> {
  const issues: string[] = [];
  const reports = input.artifacts.filter(({ artifactKey }) => artifactKey === "test-report");
  const report = reports.length === 1 ? reports[0] : undefined;
  const content = report?.content ?? "";
  if (report && sha256(content) !== report.contentHash) {
    issues.push("test-report: current content does not match the persisted artifact head hash");
  }
  const authoritativeE2eReasons = authoritativeE2eSignals({
    content,
    acceptanceCriteria: input.acceptanceCriteria,
    regressionScope: input.regressionScope,
    riskFlags: input.riskFlags,
  });
  const claims = validateVerificationEvidenceGate({
    artifacts: input.artifacts,
    acceptanceCriteria: input.acceptanceCriteria,
    regressionScope: input.regressionScope,
    authoritativeE2eReasons,
  });

  const executionId = report?.executionId;
  if (!executionId || !isUuid(executionId)) {
    issues.push("test-report: current artifact head has no persisted platform execution provenance");
  }
  const execution = executionId
    ? input.phase.executions.find((candidate) => candidate.id === executionId)
    : undefined;
  if (!execution) {
    issues.push("test-report: artifact execution does not exist in the current Verification phase");
  } else {
    validateBoundExecution(execution, input.phase, input.projectRoot, issues);
  }

  const declaredExecutionId = declaredField(content, "Platform execution ID");
  if (!declaredExecutionId || declaredExecutionId !== executionId) {
    issues.push("test-report: Platform execution ID must exactly match the execution that wrote the current report head");
  }

  const reportAbsolutePath = report
    ? path.resolve(input.projectRoot, report.filePath)
    : path.join(input.projectRoot, ".missing-test-report");
  const workspaceRevision = await captureVerificationWorkspaceRevision({
    projectRoot: input.projectRoot,
    selectedOutputPaths: [reportAbsolutePath],
  });
  const started = executionId
    ? boundEvent(input.phase.events, executionId, "runner.started")
    : undefined;
  const startedPayload = record(started?.payload);
  const eventWorkspaceToken = stringValue(startedPayload?.workspaceRevisionToken);
  const declaredWorkspaceToken = workspaceToken(claims.currentRevision);
  if (!eventWorkspaceToken || eventWorkspaceToken !== workspaceRevision.token) {
    issues.push("test-report: persisted Verification workspace revision does not match the current protected worktree");
  }
  if (!declaredWorkspaceToken || declaredWorkspaceToken !== workspaceRevision.token) {
    issues.push("test-report: Current revision must contain the exact verified workspace sha256 token");
  }
  if (declaredExecutionId && !claims.currentRevision.includes(declaredExecutionId)) {
    issues.push("test-report: Current revision must contain the bound platform execution ID");
  }

  await validateGitRevision(
    input.projectRoot,
    claims.currentRevision,
    startedPayload?.verificationGitState,
    issues,
  );

  const commandEvidence = successfulCommandEvidence(input.phase.events, executionId);
  const evidenceHashes = new Map<string, string>();
  for (const [index, row] of claims.executionRows.entries()) {
    if (isRemoteExecution(row)) continue;
    await validateLocalExecutionRow({
      projectRoot: input.projectRoot,
      row,
      index,
      commandEvidence,
      trustedWorkingDirectory: stringValue(startedPayload?.workingDirectory),
      evidenceHashes,
      issues,
    });
  }
  for (const [index, row] of claims.coverageRows.entries()) {
    await validateCoverageEvidence({
      projectRoot: input.projectRoot,
      row,
      index,
      evidenceHashes,
      issues,
    });
  }

  if (issues.length > 0 || !executionId) fail(issues);
  return {
    executionId,
    currentRevision: claims.currentRevision,
    workspaceRevisionToken: workspaceRevision.token,
    evidenceHashes: Object.fromEntries(evidenceHashes),
  };
}

export function authoritativeE2eSignals(input: {
  content: string;
  acceptanceCriteria?: ReadonlyArray<string> | null;
  regressionScope?: ReadonlyArray<string> | null;
  riskFlags?: ReadonlyArray<string> | null;
}): string[] {
  const reasons: string[] = [];
  const explicitE2e = /\b(?:e2e|end[- ]to[- ]end|playwright|browser(?:[- ]based)?\s+(?:journey|flow|test)|cross[- ]page\s+(?:journey|flow))\b|(?:端到端|浏览器(?:旅程|流程|测试)|跨页面(?:旅程|流程))/iu;
  if ((input.riskFlags ?? []).some((value) => explicitE2e.test(value))) {
    reasons.push("Change Contract risk flag");
  }
  if ([...(input.acceptanceCriteria ?? []), ...(input.regressionScope ?? [])]
    .some((value) => explicitE2e.test(value))) {
    reasons.push("Change Contract criterion/regression");
  }
  if (/\bplaywright\s+test\b|(?:^|[\s`(])(?:tests?\/)?e2e\/[^\s|`]+|\.e2e\.spec\.[cm]?[jt]sx?\b|\bplaywright-report\b/imu.test(input.content)) {
    reasons.push("Test Report E2E command/path");
  }
  return reasons;
}

function validateBoundExecution(
  execution: ExecutionDto,
  phase: VerificationPhaseEvidence,
  projectRoot: string,
  issues: string[],
): void {
  if (execution.phaseRunId !== phase.id) {
    issues.push("test-report: bound execution belongs to another phase run");
  }
  if (execution.status !== "completed" || execution.exitCode !== 0 || !execution.finishedAt) {
    issues.push("test-report: bound Verification execution must be completed with persisted exit code 0");
  }
  if (execution.runnerMode !== "real") {
    issues.push("test-report: simulated/fake runner output cannot support Verification approval");
  }
  if (!execution.selectedOutputKeys.includes("test-report")) {
    issues.push("test-report: bound execution did not select the Test Report output");
  }
  if (!execution.command.trim()) {
    issues.push("test-report: bound execution has no persisted runner command label");
  }
  const newestCompletedReportExecution = phase.executions.find((candidate) => (
    candidate.status === "completed"
    && candidate.exitCode === 0
    && candidate.selectedOutputKeys.includes("test-report")
  ));
  if (newestCompletedReportExecution?.id !== execution.id) {
    issues.push("test-report: report is bound to a stale Verification execution");
  }

  const started = boundEvent(phase.events, execution.id, "runner.started");
  const completed = boundEvent(phase.events, execution.id, "runner.completed");
  const startedPayload = record(started?.payload);
  const completedPayload = record(completed?.payload);
  if (
    !startedPayload
    || stringValue(startedPayload.mode) !== "real"
    || stringValue(startedPayload.phaseId) !== "verification"
    || stringValue(startedPayload.command) !== execution.command
    || path.resolve(stringValue(startedPayload.workingDirectory) ?? "") !== path.resolve(projectRoot)
  ) {
    issues.push("test-report: runner.started event does not match the persisted Verification command");
  }
  if (!completedPayload || numberValue(completedPayload.exitCode) !== 0) {
    issues.push("test-report: runner.completed event with exit code 0 is missing");
  }
}

async function validateLocalExecutionRow(input: {
  projectRoot: string;
  row: ExecutionRow;
  index: number;
  commandEvidence: ReadonlySet<string>;
  trustedWorkingDirectory: string | undefined;
  evidenceHashes: Map<string, string>;
  issues: string[];
}): Promise<void> {
  const label = `test-report: execution row ${input.index + 1}`;
  const exactExecution = parseExactExecutionCommand(input.row.command);
  if (!exactExecution) {
    input.issues.push(`${label} has an ambiguous or non-canonical command/working-directory cell`);
  } else {
    const commandHash = sha256(exactExecution.command);
    if (!input.commandEvidence.has(commandHash)) {
      input.issues.push(`${label} command has no matching successful platform command_execution event`);
    }
    await validateWorkingDirectory(
      input.projectRoot,
      exactExecution.workingDirectory,
      input.trustedWorkingDirectory,
      label,
      input.issues,
    );
  }
  const localRefs = localEvidenceRefs(input.row.evidence);
  if (localRefs.length === 0) {
    input.issues.push(`${label} needs at least one local evidence file; a self-declared local run ID is not provenance`);
  }
  await validateLocalRefs(
    input.projectRoot,
    localRefs,
    input.row.evidence,
    label,
    input.evidenceHashes,
    input.issues,
  );
}

async function validateCoverageEvidence(input: {
  projectRoot: string;
  row: CoverageRow;
  index: number;
  evidenceHashes: Map<string, string>;
  issues: string[];
}): Promise<void> {
  if (/https?:\/\/\S+/iu.test(input.row.evidence)) return;
  const refs = localEvidenceRefs(input.row.evidence);
  const label = `test-report: acceptance/regression row ${input.index + 1}`;
  if (refs.length === 0) {
    input.issues.push(`${label} has no verifiable local evidence path or remote URL`);
    return;
  }
  const unseen = refs.filter((ref) => !input.evidenceHashes.has(ref.path));
  if (unseen.length === 0) return;
  await validateLocalRefs(
    input.projectRoot,
    unseen,
    input.row.evidence,
    label,
    input.evidenceHashes,
    input.issues,
  );
}

async function validateLocalRefs(
  projectRoot: string,
  refs: ReadonlyArray<LocalEvidenceRef>,
  evidenceCell: string,
  label: string,
  evidenceHashes: Map<string, string>,
  issues: string[],
): Promise<void> {
  const declaredHashes = [...evidenceCell.matchAll(/sha256\s*[:=]\s*([a-f0-9]{64})\b/giu)]
    .map((match) => match[1]!.toLowerCase());
  if (declaredHashes.length !== refs.length) {
    issues.push(`${label} must declare one sha256 digest for each local evidence file`);
    return;
  }
  for (const [index, ref] of refs.entries()) {
    const expectedHash = declaredHashes[index]!;
    try {
      const actualHash = await hashEvidenceFile(projectRoot, ref.path);
      if (actualHash !== expectedHash) {
        issues.push(`${label} evidence hash does not match ${ref.path}`);
      } else {
        evidenceHashes.set(ref.path, actualHash);
      }
    } catch (error) {
      issues.push(`${label} cannot verify ${ref.path}: ${safeErrorMessage(error)}`);
    }
  }
}

async function validateWorkingDirectory(
  projectRoot: string,
  value: string,
  trustedWorkingDirectory: string | undefined,
  label: string,
  issues: string[],
): Promise<void> {
  const target = path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
  try {
    await assertRuntimePath(projectRoot, target);
    const [rootCanonical, targetCanonical, stats] = await Promise.all([
      realpath(projectRoot),
      realpath(target),
      lstat(target),
    ]);
    const trustedCanonical = trustedWorkingDirectory
      ? await realpath(trustedWorkingDirectory)
      : undefined;
    if (
      !isWithin(rootCanonical, targetCanonical)
      || !stats.isDirectory()
      || stats.isSymbolicLink()
      || targetCanonical !== rootCanonical
      || trustedCanonical !== rootCanonical
    ) {
      throw new Error("working directory is not the exact trusted project root");
    }
  } catch (error) {
    issues.push(`${label} working directory is missing or unsafe: ${safeErrorMessage(error)}`);
  }
}

async function hashEvidenceFile(projectRoot: string, relativePath: string): Promise<string> {
  const normalizedRelative = path.normalize(relativePath);
  if (
    path.isAbsolute(relativePath)
    || !VERIFICATION_RUNTIME_EVIDENCE_PATHS.some((root) => (
      normalizedRelative === root || normalizedRelative.startsWith(`${root}${path.sep}`)
    ))
  ) {
    throw new Error(
      `local evidence must be under ${VERIFICATION_RUNTIME_EVIDENCE_PATHS.join(", ")}`,
    );
  }
  const target = path.resolve(projectRoot, relativePath);
  await assertRuntimePath(projectRoot, target);
  const [rootCanonical, targetCanonical, stats] = await Promise.all([
    realpath(projectRoot),
    realpath(target),
    lstat(target),
  ]);
  if (!isWithin(rootCanonical, targetCanonical) || stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("evidence is not a regular file inside the project root");
  }
  if (stats.size > maxEvidenceBytes) throw new Error(`evidence exceeds ${maxEvidenceBytes} bytes`);
  return sha256(await readFile(target));
}

async function validateGitRevision(
  projectRoot: string,
  currentRevision: string,
  persistedValue: unknown,
  issues: string[],
): Promise<void> {
  const persisted = parseVerificationGitState(persistedValue);
  if (!persisted) {
    issues.push("test-report: runner.started has no valid pre-run Verification Git state");
    return;
  }
  let current: VerificationGitState | undefined;
  try {
    current = await captureVerificationGitState(projectRoot);
  } catch {
    issues.push("test-report: current Git state is unreadable or corrupt and cannot be treated as non-Git");
  }
  if (!current || !sameGitState(persisted, current)) {
    issues.push("test-report: current Git state or HEAD does not match the persisted pre-run Verification state");
  }
  const binding = gitReportBinding(persisted);
  if (!currentRevision.includes(binding)) {
    issues.push(`test-report: Current revision must contain the exact pre-run Git binding ${binding}`);
  }
}

function parseVerificationGitState(value: unknown): VerificationGitState | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  if (candidate.kind === "not_repository") return { kind: "not_repository" };
  const repositoryRoot = stringValue(candidate.repositoryRoot);
  const gitDirectory = stringValue(candidate.gitDirectory);
  const gitCommonDirectory = stringValue(candidate.gitCommonDirectory);
  if (
    !repositoryRoot
    || !gitDirectory
    || !gitCommonDirectory
    || !path.isAbsolute(repositoryRoot)
    || !path.isAbsolute(gitDirectory)
    || !path.isAbsolute(gitCommonDirectory)
  ) return undefined;
  if (candidate.kind === "head") {
    const head = stringValue(candidate.head)?.toLowerCase();
    return head && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)
      ? { kind: "head", repositoryRoot, gitDirectory, gitCommonDirectory, head }
      : undefined;
  }
  if (candidate.kind === "unborn") {
    const symbolicHead = stringValue(candidate.symbolicHead);
    return symbolicHead && /^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(symbolicHead)
      ? { kind: "unborn", repositoryRoot, gitDirectory, gitCommonDirectory, symbolicHead }
      : undefined;
  }
  return undefined;
}

function sameGitState(left: VerificationGitState, right: VerificationGitState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "not_repository" && right.kind === "not_repository") return true;
  if (left.kind === "head" && right.kind === "head") {
    return left.repositoryRoot === right.repositoryRoot
      && left.gitDirectory === right.gitDirectory
      && left.gitCommonDirectory === right.gitCommonDirectory
      && left.head === right.head;
  }
  return left.kind === "unborn"
    && right.kind === "unborn"
    && left.repositoryRoot === right.repositoryRoot
    && left.gitDirectory === right.gitDirectory
    && left.gitCommonDirectory === right.gitCommonDirectory
    && left.symbolicHead === right.symbolicHead;
}

function gitReportBinding(state: VerificationGitState): string {
  if (state.kind === "head") return `git HEAD ${state.head}`;
  if (state.kind === "unborn") return `git unborn ${state.symbolicHead}`;
  return "git state:not-repository";
}

function successfulCommandEvidence(
  events: ReadonlyArray<ExecutionEventDto>,
  executionId: string | null | undefined,
): Set<string> {
  const hashes = new Set<string>();
  if (!executionId) return hashes;
  for (const event of events) {
    if (event.executionId !== executionId || event.eventType !== "item.completed") continue;
    const payload = record(event.payload);
    const item = record(payload?.item);
    const type = stringValue(item?.type);
    const hash = stringValue(item?.commandHash);
    if (
      type === "command_execution"
      && numberValue(item?.exit_code) === 0
      && (!item?.status || stringValue(item.status) === "completed")
      && hash
      && /^[a-f0-9]{64}$/u.test(hash)
    ) {
      hashes.add(hash);
    }
  }
  return hashes;
}

function boundEvent(
  events: ReadonlyArray<ExecutionEventDto>,
  executionId: string,
  eventType: string,
): ExecutionEventDto | undefined {
  const matching = events.filter((event) => (
    event.executionId === executionId && event.eventType === eventType
  ));
  return matching.length === 1 ? matching[0] : undefined;
}

function isRemoteExecution(row: ExecutionRow): boolean {
  return /\b(?:remote\s+ci|ci\s+(?:run|job|check)|github\s+actions|gitlab\s+ci|circleci|buildkite|jenkins)\b|(?:远程\s*CI|CI\s*(?:运行|任务|检查))/iu
    .test(`${row.execution} ${row.evidence}`);
}

interface LocalEvidenceRef {
  path: string;
}

function localEvidenceRefs(value: string): LocalEvidenceRef[] {
  const withoutUrls = value.replace(/https?:\/\/\S+/giu, " ");
  const matches = withoutUrls.matchAll(
    /(?:^|[\s`(;,])((?:\.{0,2}\/)?(?:[\w@.()-]+\/)+[\w@.()-]+\.(?:html?|json|xml|log|txt|tap|junit|zip|png|jpe?g|webp|webm|mp4))(?:#[\w.():/-]+)?/giu,
  );
  const refs = new Map<string, LocalEvidenceRef>();
  for (const match of matches) {
    const candidate = match[1]!.replace(/^\.\//u, "");
    refs.set(candidate, { path: candidate });
  }
  return [...refs.values()];
}

function workspaceToken(value: string): string | undefined {
  return /workspace\s+sha256\s*[:=]\s*([a-f0-9]{64})\b/iu.exec(value)?.[1]?.toLowerCase();
}

function declaredField(content: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  for (const sourceLine of content.split(/\r?\n/u)) {
    const line = sourceLine.replace(/^\s*(?:[-*+]\s+|>\s*)/u, "")
      .replace(/[*_`]/gu, "")
      .trim();
    const match = new RegExp(`^${escaped}\\s*[:：]\\s*(.+)$`, "iu").exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error && error.message) return error.message.slice(0, 300);
  const code = (error as NodeJS.ErrnoException)?.code;
  return code ? String(code) : "unreadable or missing";
}

function fail(issues: string[]): never {
  throw new AppError(
    `测试报告审批校验失败：${issues.slice(0, 3).join("；")}`,
    409,
    errorCode,
    { issues },
  );
}
