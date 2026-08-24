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
import { captureE2eInputRevisionToken } from "./verification-e2e-coordinator.js";
import { E2E_WORKSPACE_SIDECAR_PATH } from "./e2e-workspace-service.js";
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

interface LinkedE2eFileBinding {
  path: string;
  sha256: string;
  bytes: number;
}

interface LinkedE2eExecutionBinding {
  workingDirectory: string;
  command: string;
  commandHash: string;
  descriptorHash: string;
  authoringExecutionId: string;
  authoringPatchHash: string;
  productRevisionToken: string;
  e2eWorkspaceRevisionToken: string;
  e2eGitState: VerificationGitState;
  browser: { executablePath: string; version: string };
  testExitCode: 0;
  serverCleanup: "already_exited" | "sigterm";
  targetProbe: { url: string; status: number; browserVersion: string };
  scripts: ReadonlyArray<LinkedE2eFileBinding>;
  evidence: ReadonlyArray<LinkedE2eFileBinding>;
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
  const legacyCurrentRevision = declaredField(content, "Current revision");
  if (
    declaredExecutionId
    && legacyCurrentRevision
    && !legacyCurrentRevision.includes(declaredExecutionId)
  ) {
    issues.push("test-report: Current revision must contain the bound platform execution ID");
  }

  await validateGitRevision(
    input.projectRoot,
    claims.currentRevision,
    startedPayload?.verificationGitState,
    issues,
  );

  const linkedE2e = executionId
    ? await validateLinkedE2eExecution({
      projectRoot: input.projectRoot,
      executionId,
      phase: input.phase,
      content,
      currentProductRevisionToken: workspaceRevision.token,
      issues,
    })
    : undefined;

  const commandEvidence = successfulCommandEvidence(input.phase.events, executionId);
  const evidenceHashes = new Map<string, string>();
  const linkedEvidence = new Map(
    (linkedE2e?.evidence ?? []).map((file) => [file.path, file] as const),
  );
  if (linkedE2e) {
    await validateLinkedE2eFiles({
      projectRoot: input.projectRoot,
      binding: linkedE2e,
      evidenceHashes,
      issues,
    });
    const exactLinkedRow = claims.executionRows.some((row) => {
      if (isRemoteExecution(row)) return false;
      const exact = parseExactExecutionCommand(row.command);
      return exact?.command === linkedE2e.command
        && resolveWorkingDirectory(input.projectRoot, exact.workingDirectory)
          === path.resolve(linkedE2e.workingDirectory);
    });
    if (!exactLinkedRow) {
      issues.push("test-report: no execution row exactly binds the platform Linked E2E command and working directory");
    }
  }
  for (const [index, row] of claims.executionRows.entries()) {
    if (isRemoteExecution(row)) continue;
    const exact = parseExactExecutionCommand(row.command);
    const isLinkedE2eRow = Boolean(
      linkedE2e
      && exact?.command === linkedE2e.command
      && resolveWorkingDirectory(input.projectRoot, exact.workingDirectory)
        === path.resolve(linkedE2e.workingDirectory),
    );
    await validateLocalExecutionRow({
      projectRoot: input.projectRoot,
      row,
      index,
      commandEvidence,
      trustedWorkingDirectory: isLinkedE2eRow
        ? linkedE2e!.workingDirectory
        : stringValue(startedPayload?.workingDirectory),
      trustedEvidence: isLinkedE2eRow ? linkedEvidence : undefined,
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

async function validateLinkedE2eExecution(input: {
  projectRoot: string;
  executionId: string;
  phase: VerificationPhaseEvidence;
  content: string;
  currentProductRevisionToken: string;
  issues: string[];
}): Promise<LinkedE2eExecutionBinding | undefined> {
  const events = input.phase.events.filter((event) => (
    event.executionId === input.executionId
    && event.eventType === "e2e.execution.completed"
  ));
  if (events.length === 0) {
    if (declaresLinkedE2e(input.content)) {
      input.issues.push(
        "test-report: Linked E2E claims require a bound platform e2e.execution.completed event",
      );
    }
    return undefined;
  }
  if (events.length !== 1) {
    input.issues.push("test-report: expected exactly one bound e2e.execution.completed event");
    return undefined;
  }

  const payload = record(events[0]!.payload);
  const workingDirectory = stringValue(payload?.workingDirectory);
  const command = stringValue(payload?.command);
  const commandHash = sha256Value(payload?.commandHash);
  const descriptorHash = sha256Value(payload?.descriptorHash);
  const authoringExecutionId = stringValue(payload?.authoringExecutionId);
  const authoringPatchHash = sha256Value(payload?.authoringPatchHash);
  const productRevisionToken = sha256Value(payload?.productRevisionToken);
  const e2eWorkspaceRevisionToken = sha256Value(payload?.e2eWorkspaceRevisionToken);
  const e2eGitState = parseVerificationGitState(payload?.e2eGitState);
  const browserPayload = record(payload?.browser);
  const browserExecutablePath = stringValue(browserPayload?.executablePath);
  const browserVersion = stringValue(browserPayload?.version);
  const testExitCode = numberValue(payload?.testExitCode);
  const serverCleanup = stringValue(payload?.serverCleanup);
  const targetProbePayload = record(payload?.targetProbe);
  const targetProbeUrl = stringValue(targetProbePayload?.url);
  const targetProbeStatus = numberValue(targetProbePayload?.status);
  const targetProbeBrowserVersion = stringValue(targetProbePayload?.browserVersion);
  const scripts = parseLinkedE2eFiles(
    payload?.scripts,
    "script",
    input.executionId,
    input.issues,
  );
  const evidence = parseLinkedE2eFiles(
    payload?.evidence,
    "evidence",
    input.executionId,
    input.issues,
  );
  if (
    !workingDirectory
    || !command
    || !commandHash
    || !descriptorHash
    || !authoringExecutionId
    || !isUuid(authoringExecutionId)
    || !authoringPatchHash
    || !productRevisionToken
    || !e2eWorkspaceRevisionToken
    || !e2eGitState
    || !browserExecutablePath
    || !path.isAbsolute(browserExecutablePath)
    || !browserVersion?.trim()
    || testExitCode === undefined
    || !serverCleanup
    || !targetProbeUrl
    || targetProbeStatus === undefined
    || !targetProbeBrowserVersion?.trim()
    || !scripts
    || !evidence
  ) {
    input.issues.push("test-report: platform e2e.execution.completed event is malformed");
    return undefined;
  }
  if (
    numberValue(payload?.exitCode) !== 0
    || payload?.passed !== true
    || testExitCode !== 0
  ) {
    input.issues.push(
      "test-report: e2e.execution.completed must record effective and raw test exit code 0",
    );
  }
  if (serverCleanup !== "already_exited" && serverCleanup !== "sigterm") {
    input.issues.push(
      "test-report: e2e.execution.completed must record a successful supervised server cleanup",
    );
  }
  if (
    !Number.isInteger(targetProbeStatus)
    || targetProbeStatus < 200
    || targetProbeStatus >= 500
  ) {
    input.issues.push(
      "test-report: e2e.execution.completed target probe must record HTTP status 200-499",
    );
  }
  if (targetProbeBrowserVersion !== browserVersion) {
    input.issues.push(
      "test-report: e2e.execution.completed target probe browser version does not match the launched browser",
    );
  }
  if (!/^npm run [A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/u.test(command)) {
    input.issues.push("test-report: e2e.execution.completed command is not the fixed npm script form");
  }
  if (sha256(command) !== commandHash) {
    input.issues.push("test-report: e2e.execution.completed command hash is invalid");
  }
  const successfulCommands = successfulCommandEvidence(input.phase.events, input.executionId);
  if (!successfulCommands.has(commandHash)) {
    input.issues.push(
      "test-report: e2e.execution.completed has no matching successful command_execution event",
    );
  }
  if (productRevisionToken !== input.currentProductRevisionToken) {
    input.issues.push(
      "test-report: Linked E2E product revision token is stale for the current protected worktree",
    );
  }
  const declaredProductRevision = declaredAnyField(input.content, [
    "Product revision binding",
    "Current revision",
  ]);
  if (!declaredProductRevision?.includes(productRevisionToken)) {
    input.issues.push(
      "test-report: Product revision binding must contain the exact e2e.execution.completed token",
    );
  }
  const declaredE2eRevision = declaredAnyField(input.content, [
    "E2E suite revision binding",
    "E2E before/after revision",
  ]);
  if (!declaredE2eRevision?.includes(e2eWorkspaceRevisionToken)) {
    input.issues.push(
      "test-report: E2E suite revision binding must contain the exact e2e.execution.completed token",
    );
  }
  const declaredManifest = declaredAnyField(input.content, [
    "Approved script manifest",
    "Approved script manifest SHA-256",
    "Aggregate manifest hash",
    "Script manifest SHA-256",
  ]);
  if (!declaredManifest?.includes(authoringPatchHash)) {
    input.issues.push(
      "test-report: Approved script manifest must contain the exact e2e.execution.completed hash",
    );
  }
  for (const script of scripts) {
    if (!hasSameLineBinding(input.content, script.path, script.sha256)) {
      input.issues.push(
        `test-report: approved script ${script.path} is not bound to its platform content hash`,
      );
    }
  }
  const gitBinding = linkedE2eGitReportBinding(e2eGitState);
  if (!input.content.includes(gitBinding)) {
    input.issues.push(`test-report: E2E suite revision must contain the exact Git binding ${gitBinding}`);
  }

  const safeRoot = await validateLinkedE2eRoot(
    input.projectRoot,
    workingDirectory,
    input.issues,
  );
  if (!safeRoot) return undefined;
  const boundBaseUrl = await validateLinkedE2eDescriptor({
    projectRoot: input.projectRoot,
    workingDirectory,
    descriptorHash,
    issues: input.issues,
  });
  if (boundBaseUrl) {
    try {
      const configured = new URL(boundBaseUrl);
      const probed = new URL(targetProbeUrl);
      if (
        configured.origin !== probed.origin
        || configured.href !== probed.href
        || probed.username !== ""
        || probed.password !== ""
      ) {
        throw new Error("target probe URL is not on the configured baseUrl origin");
      }
    } catch (error) {
      input.issues.push(
        `test-report: e2e.execution.completed target probe URL is not bound to the configured baseUrl: ${safeErrorMessage(error)}`,
      );
    }
  }
  try {
    const currentToken = await captureE2eInputRevisionToken(safeRoot);
    if (currentToken !== e2eWorkspaceRevisionToken) {
      input.issues.push(
        "test-report: current Linked E2E suite revision token is stale or has been modified",
      );
    }
  } catch (error) {
    input.issues.push(
      `test-report: current Linked E2E suite revision cannot be verified: ${safeErrorMessage(error)}`,
    );
  }
  try {
    const currentGitState = await captureVerificationGitState(safeRoot);
    if (!sameGitState(e2eGitState, currentGitState)) {
      input.issues.push(
        "test-report: current Linked E2E Git state does not match e2e.execution.completed",
      );
    }
  } catch (error) {
    input.issues.push(
      `test-report: current Linked E2E Git state cannot be verified: ${safeErrorMessage(error)}`,
    );
  }

  const startedEvents = input.phase.events.filter((event) => (
    event.executionId === input.executionId
    && event.eventType === "e2e.execution.started"
  ));
  if (startedEvents.length > 1) {
    input.issues.push("test-report: duplicate e2e.execution.started events are not valid provenance");
  } else if (startedEvents.length === 1) {
    const started = record(startedEvents[0]!.payload);
    const startedGitState = parseVerificationGitState(started?.e2eGitState);
    if (
      stringValue(started?.e2eRoot) !== workingDirectory
      || sha256Value(started?.descriptorHash) !== descriptorHash
      || sha256Value(started?.patchHash) !== authoringPatchHash
      || sha256Value(started?.e2eWorkspaceRevisionToken) !== e2eWorkspaceRevisionToken
      || !startedGitState
      || !sameGitState(e2eGitState, startedGitState)
    ) {
      input.issues.push(
        "test-report: e2e.execution.started conflicts with the completed Linked E2E binding",
      );
    }
  }

  return {
    workingDirectory,
    command,
    commandHash,
    descriptorHash,
    authoringExecutionId,
    authoringPatchHash,
    productRevisionToken,
    e2eWorkspaceRevisionToken,
    e2eGitState,
    browser: { executablePath: browserExecutablePath, version: browserVersion },
    testExitCode: 0,
    serverCleanup: serverCleanup as "already_exited" | "sigterm",
    targetProbe: {
      url: targetProbeUrl,
      status: targetProbeStatus,
      browserVersion: targetProbeBrowserVersion,
    },
    scripts,
    evidence,
  };
}

async function validateLinkedE2eDescriptor(input: {
  projectRoot: string;
  workingDirectory: string;
  descriptorHash: string;
  issues: string[];
}): Promise<string | undefined> {
  const target = path.join(
    input.projectRoot,
    ...E2E_WORKSPACE_SIDECAR_PATH.split("/"),
  );
  try {
    await assertRuntimePath(input.projectRoot, target);
    const [info, content] = await Promise.all([lstat(target), readFile(target)]);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Linked E2E descriptor is not a regular file");
    }
    if (sha256(content) !== input.descriptorHash) {
      throw new Error("Linked E2E descriptor hash does not match the completed event");
    }
    const descriptor = record(JSON.parse(content.toString("utf8")));
    const e2eRoot = stringValue(descriptor?.e2eRoot);
    const baseUrl = stringValue(descriptor?.baseUrl);
    if (e2eRoot !== input.workingDirectory || !baseUrl) {
      throw new Error("Linked E2E descriptor root or baseUrl does not match the completed event");
    }
    const parsedBaseUrl = new URL(baseUrl);
    if (parsedBaseUrl.protocol !== "http:") {
      throw new Error("Linked E2E descriptor baseUrl is not HTTP");
    }
    return baseUrl;
  } catch (error) {
    input.issues.push(
      `test-report: current Linked E2E descriptor cannot authorize target evidence: ${safeErrorMessage(error)}`,
    );
    return undefined;
  }
}

function parseLinkedE2eFiles(
  value: unknown,
  kind: "script" | "evidence",
  executionId: string,
  issues: string[],
): LinkedE2eFileBinding[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5_000) return undefined;
  const files: LinkedE2eFileBinding[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const item = record(candidate);
    const relativePath = stringValue(item?.path);
    const digest = sha256Value(item?.sha256);
    const bytes = numberValue(item?.bytes);
    const components = relativePath?.split("/") ?? [];
    const safeRelative = Boolean(
      relativePath
      && !path.isAbsolute(relativePath)
      && !relativePath.includes("\\")
      && components.every((component) => component && component !== "." && component !== ".."),
    );
    const allowed = kind === "script"
      ? /^(?:tests|fixtures)\//u.test(relativePath ?? "")
      : (relativePath ?? "").startsWith(`test-results/ai-sdlc/${executionId}/`);
    const byteLimit = kind === "script" ? 4 * 1024 * 1024 : maxEvidenceBytes;
    if (
      !safeRelative
      || !allowed
      || !digest
      || bytes === undefined
      || !Number.isInteger(bytes)
      || bytes < 0
      || bytes > byteLimit
      || seen.has(relativePath!)
    ) {
      issues.push(`test-report: e2e.execution.completed contains an unsafe ${kind} binding`);
      return undefined;
    }
    seen.add(relativePath!);
    files.push({ path: relativePath!, sha256: digest, bytes });
  }
  return files;
}

async function validateLinkedE2eRoot(
  projectRoot: string,
  candidate: string,
  issues: string[],
): Promise<string | undefined> {
  try {
    if (!path.isAbsolute(candidate) || path.resolve(candidate) !== candidate) {
      throw new Error("root is not an absolute canonical path");
    }
    const [productCanonical, e2eCanonical, info] = await Promise.all([
      realpath(projectRoot),
      realpath(candidate),
      lstat(candidate),
    ]);
    if (
      candidate !== e2eCanonical
      || info.isSymbolicLink()
      || !info.isDirectory()
      || isWithin(productCanonical, e2eCanonical)
      || isWithin(e2eCanonical, productCanonical)
    ) {
      throw new Error("product and E2E roots must be canonical, separate, and non-nested");
    }
    return e2eCanonical;
  } catch (error) {
    issues.push(
      `test-report: e2e.execution.completed working directory is missing or unsafe: ${safeErrorMessage(error)}`,
    );
    return undefined;
  }
}

async function validateLinkedE2eFiles(input: {
  projectRoot: string;
  binding: LinkedE2eExecutionBinding;
  evidenceHashes: Map<string, string>;
  issues: string[];
}): Promise<void> {
  for (const file of input.binding.scripts) {
    try {
      const actual = await hashLinkedE2eScript(input.binding.workingDirectory, file.path);
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) {
        input.issues.push(
          `test-report: Linked E2E script hash or size does not match ${file.path}`,
        );
      }
    } catch (error) {
      input.issues.push(
        `test-report: cannot verify Linked E2E script ${file.path}: ${safeErrorMessage(error)}`,
      );
    }
  }
  for (const file of input.binding.evidence) {
    try {
      const target = path.resolve(input.projectRoot, ...file.path.split("/"));
      const info = await lstat(target);
      const actualHash = await hashEvidenceFile(input.projectRoot, file.path);
      if (actualHash !== file.sha256 || info.size !== file.bytes) {
        input.issues.push(
          `test-report: Linked E2E evidence hash or size does not match ${file.path}`,
        );
      } else {
        input.evidenceHashes.set(file.path, actualHash);
      }
    } catch (error) {
      input.issues.push(
        `test-report: cannot verify Linked E2E evidence ${file.path}: ${safeErrorMessage(error)}`,
      );
    }
  }
}

async function hashLinkedE2eScript(
  e2eRoot: string,
  relativePath: string,
): Promise<{ sha256: string; bytes: number }> {
  const target = path.join(e2eRoot, ...relativePath.split("/"));
  await assertRuntimePath(e2eRoot, target);
  const [rootCanonical, targetCanonical, info] = await Promise.all([
    realpath(e2eRoot),
    realpath(target),
    lstat(target),
  ]);
  if (
    !isWithin(rootCanonical, targetCanonical)
    || info.isSymbolicLink()
    || !info.isFile()
    || info.size > 4 * 1024 * 1024
  ) throw new Error("script is not a safe regular file inside the Linked E2E root");
  const content = await readFile(target);
  return { sha256: sha256(content), bytes: content.length };
}

async function validateLocalExecutionRow(input: {
  projectRoot: string;
  row: ExecutionRow;
  index: number;
  commandEvidence: ReadonlySet<string>;
  trustedWorkingDirectory: string | undefined;
  trustedEvidence?: ReadonlyMap<string, LinkedE2eFileBinding>;
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
    input.trustedEvidence,
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
  trustedEvidence?: ReadonlyMap<string, LinkedE2eFileBinding>,
): Promise<void> {
  const declaredHashes = [...evidenceCell.matchAll(/sha256\s*[:=]\s*([a-f0-9]{64})\b/giu)]
    .map((match) => match[1]!.toLowerCase());
  if (declaredHashes.length !== refs.length) {
    issues.push(`${label} must declare one sha256 digest for each local evidence file`);
    return;
  }
  for (const [index, ref] of refs.entries()) {
    const expectedHash = declaredHashes[index]!;
    const trusted = trustedEvidence?.get(ref.path);
    if (trustedEvidence && !trusted) {
      issues.push(`${label} evidence ${ref.path} is not present in the platform e2e.execution.completed event`);
      continue;
    }
    if (trusted && trusted.sha256 !== expectedHash) {
      issues.push(`${label} evidence hash does not match the platform e2e.execution.completed event for ${ref.path}`);
      continue;
    }
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
    const trusted = trustedWorkingDirectory
      ? path.resolve(trustedWorkingDirectory)
      : undefined;
    if (!trusted) throw new Error("trusted platform working directory is missing");
    await assertRuntimePath(trusted, target);
    const [trustedCanonical, targetCanonical, stats] = await Promise.all([
      realpath(trusted),
      realpath(target),
      lstat(target),
    ]);
    if (
      !stats.isDirectory()
      || stats.isSymbolicLink()
      || targetCanonical !== trustedCanonical
      || target !== trusted
    ) {
      throw new Error("working directory is not the exact trusted platform root");
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

function declaredAnyField(content: string, names: ReadonlyArray<string>): string | undefined {
  for (const name of names) {
    const value = declaredField(content, name);
    if (value) return value;
  }
  return undefined;
}

function declaresLinkedE2e(content: string): boolean {
  return [
    declaredField(content, "Linked E2E Workspace binding"),
    declaredField(content, "E2E suite revision binding"),
    declaredField(content, "Approved script manifest"),
  ].some((value) => value && !/^(?:not applicable|n\/?a|none)\b/iu.test(value));
}

function hasSameLineBinding(content: string, left: string, right: string): boolean {
  return content.split(/\r?\n/u).some((line) => line.includes(left) && line.includes(right));
}

function linkedE2eGitReportBinding(state: VerificationGitState): string {
  if (state.kind === "head") return `e2e git HEAD ${state.head}`;
  if (state.kind === "unborn") return `e2e git unborn ${state.symbolicHead}`;
  return "e2e git state:not-repository";
}

function resolveWorkingDirectory(projectRoot: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
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

function sha256Value(value: unknown): string | undefined {
  const candidate = stringValue(value)?.toLowerCase();
  return candidate && /^[a-f0-9]{64}$/u.test(candidate) ? candidate : undefined;
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
