import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConnection } from "node:net";
import { TextDecoder } from "node:util";

import { z } from "zod";

import { AppError } from "../domain/errors.js";
import { isWithin } from "./project-paths.js";
import {
  E2E_TEST_SCRIPT,
  E2E_TEST_SCRIPT_COMMAND,
  canonicalPlaywrightConfigSource,
  type BrowserLaunchProbeResult,
  type E2eWorkspaceConfig,
} from "./e2e-workspace-service.js";

const npmScriptIdentifier = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/u;
const executionIdentifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const authorExcludedRoots = new Set([
  ".git",
  ".ai-sdlc",
  "node_modules",
  "test-results",
  "playwright-report",
  "blob-report",
]);
const runtimeEvidenceRoots = ["test-results", "playwright-report", "blob-report"] as const;
const maximumAuthorWorkspaceFileBytes = 4 * 1024 * 1024;
export const MAX_E2E_AUTHORED_REVIEW_BYTES = 200_000;
const DEFAULT_MAX_EVIDENCE_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_EVIDENCE_FILES = 5_000;
const DEFAULT_MAX_EVIDENCE_TOTAL_BYTES = 512 * 1024 * 1024;

const frozenIntentSchema = z.object({
  scenarioId: z.string().trim().min(1).max(240),
  acceptanceCriteria: z.array(z.object({
    id: z.string().regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/u),
    text: z.string().trim().min(1).max(4_000),
  }).strict()).min(1).max(100),
  regressionObligations: z.array(z.object({
    id: z.string().regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/u),
    text: z.string().trim().min(1).max(4_000),
  }).strict()).max(100).default([]),
  preconditions: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
  observableBehavior: z.string().trim().min(1).max(8_000),
  negativePaths: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
  viewports: z.array(z.object({
    width: z.number().int().min(240).max(8_192),
    height: z.number().int().min(240).max(8_192),
  }).strict()).max(20).default([]),
}).strict();

export interface FrozenE2eSpecIntent {
  scenarioId: string;
  acceptanceCriteria: Array<{ id: string; text: string }>;
  regressionObligations?: Array<{ id: string; text: string }>;
  preconditions?: string[];
  observableBehavior: string;
  negativePaths?: string[];
  viewports?: Array<{ width: number; height: number }>;
}

export interface ProcessSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ["pipe" | "ignore", "pipe", "pipe"];
  /** A supervised app/test command owns a process group so timeout cleanup reaches grandchildren. */
  detached?: boolean;
}

export type E2eProcessSpawner = (
  command: string,
  args: readonly string[],
  options: ProcessSpawnOptions,
) => ChildProcess;

export interface E2eTestAuthorInput {
  e2eRoot: string;
  executionId: string;
  frozenIntent: FrozenE2eSpecIntent;
  model?: string;
  reasoningEffort?: string;
}

export interface E2eAuthoredFile {
  path: string;
  change: "added" | "modified" | "unchanged";
  beforeSha256: string | null;
  afterSha256: string;
  bytes: number;
}

export interface E2eTestAuthorResult {
  executionId: string;
  sessionId: string | null;
  specIntentHash: string;
  files: E2eAuthoredFile[];
  patchHash: string;
  manifestPath: string;
  manifestSha256: string;
}

export interface E2eTestAuthorRunnerOptions {
  codexBinary?: string;
  spawnProcess?: E2eProcessSpawner;
  timeoutMs?: number;
  maxOutputBytes?: number;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Runs the independent author in an ephemeral staging copy. Only validated
 * tests/ and fixtures/ files are applied back to the real E2E project.
 */
export class E2eTestAuthorRunner {
  private readonly codexBinary: string;
  private readonly spawnProcess: E2eProcessSpawner;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: E2eTestAuthorRunnerOptions = {}) {
    this.codexBinary = options.codexBinary ?? "codex";
    this.spawnProcess = options.spawnProcess ?? defaultSpawner;
    this.timeoutMs = options.timeoutMs ?? 20 * 60_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
    this.environment = options.environment ?? process.env;
  }

  async run(input: E2eTestAuthorInput): Promise<E2eTestAuthorResult> {
    assertExecutionId(input.executionId);
    const intent = frozenIntentSchema.parse(input.frozenIntent);
    const e2eRoot = await safeExactDirectory(input.e2eRoot, "E2E author root");
    await assertManagedE2eInputTree(e2eRoot);
    await assertNoCopiedSymlinks(e2eRoot);
    const stagingParent = await mkdtemp(path.join(tmpdir(), "ai-sdlc-e2e-author-"));
    const stagingCandidate = path.join(stagingParent, "workspace");
    try {
      await cp(e2eRoot, stagingCandidate, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        filter: (source) => shouldCopyForAuthor(e2eRoot, source),
      });
      const stagingRoot = await realpath(stagingCandidate);
      const before = await snapshotAuthorTree(stagingRoot);
      const prompt = authorPrompt(intent);
      const args = [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "-s", "workspace-write",
        "--skip-git-repo-check",
        "-C", stagingRoot,
        ...(input.model ? ["--model", input.model] : []),
        ...(input.reasoningEffort
          ? ["--config", `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`]
          : []),
        "--json",
        "--color", "never",
        "-",
      ];
      const child = this.spawnProcess(this.codexBinary, args, {
        cwd: stagingRoot,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: authorEnvironment(this.environment),
        detached: process.platform !== "win32",
      });
      child.stdin?.end(prompt);
      const completed = await waitForProcess(child, this.timeoutMs, this.maxOutputBytes, true);
      if (completed.exitCode !== 0) {
        throw new AppError(
          `Independent E2E Test Author failed with exit ${completed.exitCode}`,
          502,
          "E2E_AUTHOR_FAILED",
          { exitCode: completed.exitCode, stderrHash: sha256(completed.stderr) },
        );
      }
      const after = await snapshotAuthorTree(stagingRoot);
      const changes = authorChanges(before, after);
      const unauthorized = changes.filter((change) => !isAllowedAuthorPath(change.path));
      if (unauthorized.length > 0) {
        throw new AppError(
          "Independent E2E Test Author changed files outside tests/ and fixtures/",
          422,
          "E2E_AUTHOR_OUTPUT_SCOPE_VIOLATION",
          { paths: unauthorized.map((change) => change.path) },
        );
      }
      if (changes.some((change) => change.change === "deleted")) {
        throw new AppError(
          "Independent E2E Test Author may add or update tests, but may not delete files",
          422,
          "E2E_AUTHOR_DELETE_FORBIDDEN",
        );
      }
      await assertReviewableAuthoredText(stagingRoot, changes);
      await assertFrozenCriteriaCoveredByTests(stagingRoot, [
        ...intent.acceptanceCriteria.map(({ id }) => id),
        ...intent.regressionObligations.map(({ id }) => id),
      ]);
      if (changes.length === 0) {
        throw new AppError(
          "Independent E2E Test Author did not create or update any test asset",
          422,
          "E2E_AUTHOR_OUTPUT_MISSING",
        );
      }
      const authoredChanges = changes.map((change) => ({
        path: change.path,
        change: change.change as "added" | "modified",
        beforeSha256: change.before?.sha256 ?? null,
        afterSha256: change.after!.sha256,
        bytes: change.after!.bytes,
      }));
      const reviewedSuite = await collectReviewedSuite(stagingRoot, before);
      const applied = await applyAuthoredFiles(e2eRoot, stagingRoot, authoredChanges);
      const specIntentHash = sha256(stableJson(intent));
      const patchHash = sha256(stableJson(reviewedSuite));
      const sessionId = codexSessionId(completed.stdout);
      const manifest = {
        schemaVersion: 1,
        executionId: input.executionId,
        sessionId,
        isolation: "fresh ephemeral spec-only authoring session",
        specIntentHash,
        files: reviewedSuite,
        changes: authoredChanges,
        patchHash,
      };
      const manifestRelativePath = path.posix.join(
        ".ai-sdlc",
        "e2e-author-runs",
        `${input.executionId}.json`,
      );
      const manifestPath = path.join(e2eRoot, ...manifestRelativePath.split("/"));
      try {
        await writePlatformFile(e2eRoot, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      } catch (error) {
        await applied.rollback();
        throw error;
      }
      return {
        executionId: input.executionId,
        sessionId,
        specIntentHash,
        files: reviewedSuite,
        patchHash,
        manifestPath: manifestRelativePath,
        manifestSha256: sha256(await readFile(manifestPath)),
      };
    } finally {
      await rm(stagingParent, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export interface E2eExecutionInput {
  executionId: string;
  productRoot: string;
  config: E2eWorkspaceConfig;
  browser: BrowserLaunchProbeResult;
}

export type E2eTargetPreflightInput = Omit<E2eExecutionInput, "executionId">;

export interface E2eTargetPreflightResult {
  targetProbe: E2eBrowserTargetProbeResult;
  serverExitCode: number | null;
  serverCleanup: "already_exited" | "sigterm" | "sigkill";
}

export interface E2eExecutionEvidenceFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface E2eExecutionFailureEvidence {
  path: string;
  sha256: string;
  bytes: number;
}

export interface E2eExecutionResult {
  executionId: string;
  passed: boolean;
  testExitCode: number;
  serverExitCode: number | null;
  serverCleanup: "already_exited" | "sigterm" | "sigkill";
  sourceCommand: { command: "npm"; args: ["run", string]; cwd: string };
  testCommand: { command: "npm"; args: ["run", string]; cwd: string };
  browser: BrowserLaunchProbeResult;
  targetProbe: E2eBrowserTargetProbeResult;
  stdoutSha256: string;
  stderrSha256: string;
  evidence: E2eExecutionEvidenceFile[];
  manifestPath: string;
  manifestSha256: string;
}

export type E2eUrlReadinessProbe = (
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
) => Promise<void>;

export interface E2eBrowserTargetProbeResult {
  url: string;
  status: number | null;
  browserVersion: string;
}

export type E2eBrowserTargetProbe = (input: {
  e2eRoot: string;
  baseUrl: string;
  browser: BrowserLaunchProbeResult;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
}) => Promise<E2eBrowserTargetProbeResult>;

export type E2eTargetVacancyProbe = (url: string, timeoutMs: number) => Promise<void>;

export interface E2eAutomationRunnerOptions {
  spawnProcess?: E2eProcessSpawner;
  readinessProbe?: E2eUrlReadinessProbe;
  browserTargetProbe?: E2eBrowserTargetProbe;
  targetVacancyProbe?: E2eTargetVacancyProbe;
  httpFetch?: typeof fetch;
  serverReadyTimeoutMs?: number;
  testTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  maxOutputBytes?: number;
  maxEvidenceFileBytes?: number;
  maxEvidenceFiles?: number;
  maxEvidenceTotalBytes?: number;
  environment?: NodeJS.ProcessEnv;
}

/** Runs the repository-owned Playwright script while supervising its server. */
export class E2eAutomationRunner {
  private readonly spawnProcess: E2eProcessSpawner;
  private readonly readinessProbe: E2eUrlReadinessProbe;
  private readonly browserTargetProbe: E2eBrowserTargetProbe;
  private readonly targetVacancyProbe: E2eTargetVacancyProbe;
  private readonly serverReadyTimeoutMs: number;
  private readonly testTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly evidenceLimits: EvidenceCollectionLimits;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: E2eAutomationRunnerOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? defaultSpawner;
    this.readinessProbe = options.readinessProbe
      ?? ((url, timeoutMs, signal) => waitForHttpReady(
        url,
        timeoutMs,
        signal,
        options.httpFetch ?? fetch,
      ));
    this.browserTargetProbe = options.browserTargetProbe
      ?? ((input) => launchBrowserTargetProbe(this.spawnProcess, this.maxOutputBytes, input));
    this.targetVacancyProbe = options.targetVacancyProbe ?? assertTargetVacant;
    this.serverReadyTimeoutMs = options.serverReadyTimeoutMs ?? 60_000;
    this.testTimeoutMs = options.testTimeoutMs ?? 15 * 60_000;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
    this.evidenceLimits = {
      maxFileBytes: options.maxEvidenceFileBytes ?? DEFAULT_MAX_EVIDENCE_FILE_BYTES,
      maxFiles: options.maxEvidenceFiles ?? DEFAULT_MAX_EVIDENCE_FILES,
      maxTotalBytes: options.maxEvidenceTotalBytes ?? DEFAULT_MAX_EVIDENCE_TOTAL_BYTES,
    };
    if (
      this.evidenceLimits.maxFileBytes < 1
      || this.evidenceLimits.maxFiles < 1
      || this.evidenceLimits.maxTotalBytes < 1
    ) {
      throw new Error("E2E evidence limits must be positive");
    }
    this.environment = options.environment ?? process.env;
  }

  async preflight(input: E2eTargetPreflightInput): Promise<E2eTargetPreflightResult> {
    const prepared = await this.prepareTarget(input);
    const supervised = await this.startSupervisedTarget(prepared, input.browser);
    const serverCleanup = await stopSupervisedProcess(
      supervised.server,
      supervised.serverMonitor,
      this.cleanupTimeoutMs,
      true,
      prepared.config.baseUrl,
      this.targetVacancyProbe,
    );
    const serverResult = await supervised.serverMonitor.completed;
    if (serverCleanup === "sigkill") {
      throw new AppError(
        "E2E target preflight required forced SIGKILL cleanup",
        502,
        "E2E_SOURCE_SERVER_CLEANUP_FAILED",
        { serverExitCode: serverResult.exitCode, serverCleanup },
      );
    }
    return {
      targetProbe: supervised.targetProbe,
      serverExitCode: serverResult.exitCode,
      serverCleanup,
    };
  }

  async run(input: E2eExecutionInput): Promise<E2eExecutionResult> {
    assertExecutionId(input.executionId);
    const prepared = await this.prepareTarget(input);
    try {
      return await this.runPrepared(input, prepared);
    } catch (error) {
      throw await persistExecutionFailure(
        prepared.e2eRoot,
        input.executionId,
        error,
        input,
      );
    }
  }

  private async runPrepared(
    input: E2eExecutionInput,
    prepared: PreparedE2eTarget,
  ): Promise<E2eExecutionResult> {
    const { productRoot, e2eRoot, environment } = prepared;
    let stage: E2eFailureStage = "evidence_baseline";
    const diagnostics: E2eFailureDiagnostics = {};
    try {
      const evidenceBaseline = new Map(
        (await collectEvidenceFiles(e2eRoot, this.evidenceLimits))
          .map((file) => [file.path, file.sha256]),
      );
      stage = "target_start_and_probe";
      const supervised = await this.startSupervisedTarget(prepared, input.browser);
    let cleanup: E2eExecutionResult["serverCleanup"] = "already_exited";
    let testCompleted: CompletedProcess | undefined;
    try {
      stage = "playwright_test";
      const test = this.spawnProcess("npm", ["run", input.config.testScript], {
        cwd: e2eRoot,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: environment,
        detached: process.platform !== "win32",
      });
      const testMonitor = monitorProcess(test, this.maxOutputBytes, true);
      try {
        testCompleted = await Promise.race([
          waitForMonitoredProcess(test, testMonitor, this.testTimeoutMs, true),
          supervised.serverMonitor.completed.then((result) => {
            throw new AppError(
              `E2E source server exited while Playwright was running (exit ${result.exitCode})`,
              502,
              "E2E_SOURCE_SERVER_FAILED",
              { stderrHash: sha256(result.stderr) },
            );
          }),
          ]);
      } catch (error) {
        if (!testMonitor.isClosed()) terminateProcess(test, "SIGKILL", true);
        const failedTest = await testMonitor.completed.catch(() => undefined);
        if (failedTest) Object.assign(diagnostics, processDiagnostics("test", failedTest));
        throw error;
      }
    } finally {
      cleanup = await stopSupervisedProcess(
        supervised.server,
        supervised.serverMonitor,
        this.cleanupTimeoutMs,
        true,
        input.config.baseUrl,
        this.targetVacancyProbe,
      );
      diagnostics.serverCleanup = cleanup;
    }
    if (!testCompleted) {
      throw new AppError("E2E test process did not complete", 502, "E2E_TEST_RUNNER_FAILED");
    }
    Object.assign(diagnostics, processDiagnostics("test", testCompleted));

    stage = "evidence_collection";
    const evidenceAfterTest = await collectEvidenceFiles(e2eRoot, this.evidenceLimits);
    const currentEvidence = evidenceAfterTest.filter(
      (file) => evidenceBaseline.get(file.path) !== file.sha256,
    );
    if (testCompleted.exitCode === 0 && currentEvidence.length === 0) {
      throw new AppError(
        "Playwright exited successfully but produced no durable report or result file",
        422,
        "E2E_EXECUTION_EVIDENCE_MISSING",
      );
    }
    const manifestRelativePath = path.posix.join(
      "test-results",
      `ai-sdlc-platform-${input.executionId}.json`,
    );
    const manifestPath = path.join(e2eRoot, ...manifestRelativePath.split("/"));
    const serverResult = await supervised.serverMonitor.completed;
    Object.assign(diagnostics, processDiagnostics("server", serverResult));
    const passed = testCompleted.exitCode === 0 && cleanup !== "sigkill";
    const manifest = {
      schemaVersion: 1,
      executionId: input.executionId,
      passed,
      testExitCode: testCompleted.exitCode,
      serverExitCode: serverResult.exitCode,
      serverCleanup: cleanup,
      sourceCommand: { command: "npm", args: ["run", input.config.sourceStartScript], cwd: productRoot },
      testCommand: { command: "npm", args: ["run", input.config.testScript], cwd: e2eRoot },
      browser: input.browser,
      targetProbe: supervised.targetProbe,
      stdoutSha256: sha256(testCompleted.stdout),
      stderrSha256: sha256(testCompleted.stderr),
      evidence: currentEvidence,
    };
    stage = "manifest_write";
    await writePlatformFile(e2eRoot, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const manifestSha256 = sha256(await readFile(manifestPath));
    return {
      executionId: input.executionId,
      passed,
      testExitCode: testCompleted.exitCode,
      serverExitCode: serverResult.exitCode,
      serverCleanup: cleanup,
      sourceCommand: { command: "npm", args: ["run", input.config.sourceStartScript], cwd: productRoot },
      testCommand: { command: "npm", args: ["run", input.config.testScript], cwd: e2eRoot },
      browser: input.browser,
      targetProbe: supervised.targetProbe,
      stdoutSha256: sha256(testCompleted.stdout),
      stderrSha256: sha256(testCompleted.stderr),
      evidence: [
        ...currentEvidence,
        { path: manifestRelativePath, sha256: manifestSha256, bytes: (await stat(manifestPath)).size },
      ],
      manifestPath: manifestRelativePath,
      manifestSha256,
    };
    } catch (error) {
      throw withExecutionDiagnostics(error, { stage, ...diagnostics });
    }
  }

  private async prepareTarget(input: E2eTargetPreflightInput): Promise<PreparedE2eTarget> {
    assertScript(input.config.sourceStartScript);
    assertScript(input.config.testScript);
    if (input.config.testScript !== E2E_TEST_SCRIPT) {
      throw new AppError("E2E test script identifier changed", 409, "E2E_TEST_SCRIPT_CHANGED");
    }
    const productRoot = await safeExactDirectory(input.productRoot, "product root");
    const e2eRoot = await safeExactDirectory(input.config.e2eRoot, "E2E root");
    assertNonNestedRoots(productRoot, e2eRoot);
    await assertManagedE2eInputTree(e2eRoot);
    await assertPackageScript(productRoot, input.config.sourceStartScript);
    await assertPackageScript(e2eRoot, input.config.testScript, E2E_TEST_SCRIPT_COMMAND);
    await assertCanonicalPlaywrightConfig(e2eRoot);
    const url = new URL(input.config.baseUrl);
    return {
      productRoot,
      e2eRoot,
      config: input.config,
      environment: executionEnvironment(this.environment, url, input.config.baseUrl),
    };
  }

  private async startSupervisedTarget(
    prepared: PreparedE2eTarget,
    browser: BrowserLaunchProbeResult,
  ): Promise<SupervisedE2eTarget> {
    await this.targetVacancyProbe(
      prepared.config.baseUrl,
      Math.min(this.serverReadyTimeoutMs, 2_000),
    );
    const server = this.spawnProcess("npm", ["run", prepared.config.sourceStartScript], {
      cwd: prepared.productRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: prepared.environment,
      detached: process.platform !== "win32",
    });
    const serverMonitor = monitorProcess(server, this.maxOutputBytes, true);
    const readinessAbort = new AbortController();
    let stage: E2eFailureStage = "source_readiness";
    try {
      await Promise.race([
        this.readinessProbe(
          prepared.config.baseUrl,
          this.serverReadyTimeoutMs,
          readinessAbort.signal,
        ),
        serverMonitor.completed.then((result) => {
          throw new AppError(
            `E2E source server exited before readiness (exit ${result.exitCode})`,
            502,
            "E2E_SOURCE_SERVER_FAILED",
            { exitCode: result.exitCode, stderrHash: sha256(result.stderr) },
          );
        }),
      ]);
      readinessAbort.abort();
      stage = "browser_target_probe";
      const targetProbe = await this.browserTargetProbe({
        e2eRoot: prepared.e2eRoot,
        baseUrl: prepared.config.baseUrl,
        browser,
        environment: prepared.environment,
        timeoutMs: this.serverReadyTimeoutMs,
      });
      assertBrowserTargetProbe(prepared.config.baseUrl, browser, targetProbe);
      return { server, serverMonitor, targetProbe };
    } catch (error) {
      readinessAbort.abort();
      const serverCleanup = await stopSupervisedProcess(
        server,
        serverMonitor,
        this.cleanupTimeoutMs,
        true,
        prepared.config.baseUrl,
        this.targetVacancyProbe,
      );
      const serverResult = await serverMonitor.completed.catch(() => undefined);
      const diagnostics: E2eFailureDiagnostics = { stage, serverCleanup };
      if (serverResult) Object.assign(diagnostics, processDiagnostics("server", serverResult));
      throw withExecutionDiagnostics(error, diagnostics);
    }
  }
}

interface PreparedE2eTarget {
  productRoot: string;
  e2eRoot: string;
  config: E2eWorkspaceConfig;
  environment: NodeJS.ProcessEnv;
}

interface SupervisedE2eTarget {
  server: ChildProcess;
  serverMonitor: ProcessMonitor;
  targetProbe: E2eBrowserTargetProbeResult;
}

interface AuthorFileSnapshot {
  sha256: string;
  bytes: number;
}

interface AuthorChange {
  path: string;
  change: "added" | "modified" | "deleted";
  before?: AuthorFileSnapshot;
  after?: AuthorFileSnapshot;
}

async function snapshotAuthorTree(root: string): Promise<Map<string, AuthorFileSnapshot>> {
  const files = new Map<string, AuthorFileSnapshot>();
  await walk(root, async (absolutePath, relativePath, entry) => {
    if (entry.isSymbolicLink()) {
      throw new AppError(
        `E2E author workspace contains a symlink: ${relativePath}`,
        400,
        "E2E_AUTHOR_WORKSPACE_UNSAFE",
      );
    }
    if (!entry.isFile()) return;
    const info = await stat(absolutePath);
    if (info.size > maximumAuthorWorkspaceFileBytes) {
      throw new AppError(
        `E2E author file exceeds ${maximumAuthorWorkspaceFileBytes} bytes: ${relativePath}`,
        413,
        "E2E_AUTHOR_WORKSPACE_TOO_LARGE",
      );
    }
    const content = await readFile(absolutePath);
    files.set(relativePath, { sha256: sha256(content), bytes: content.length });
  });
  return files;
}

function authorChanges(
  before: Map<string, AuthorFileSnapshot>,
  after: Map<string, AuthorFileSnapshot>,
): AuthorChange[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])]
    .sort((left, right) => left.localeCompare(right));
  return paths.flatMap((relativePath) => {
    const previous = before.get(relativePath);
    const current = after.get(relativePath);
    if (previous?.sha256 === current?.sha256) return [];
    return [{
      path: relativePath,
      change: !previous ? "added" as const : !current ? "deleted" as const : "modified" as const,
      ...(previous ? { before: previous } : {}),
      ...(current ? { after: current } : {}),
    }];
  });
}

function isAllowedAuthorPath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  return /^(?:tests|fixtures)\/.+\.(?:ts|js|mts|mjs|json|txt)$/u.test(normalized);
}

async function assertReviewableAuthoredText(
  stagingRoot: string,
  changes: readonly AuthorChange[],
): Promise<void> {
  let totalBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const change of changes) {
    if (!change.after) continue;
    if (change.after.bytes > MAX_E2E_AUTHORED_REVIEW_BYTES) {
      throw new AppError(
        `E2E authored file exceeds the human-review limit: ${change.path}`,
        413,
        "E2E_AUTHOR_OUTPUT_TOO_LARGE",
      );
    }
    totalBytes += change.after.bytes;
    if (totalBytes > MAX_E2E_AUTHORED_REVIEW_BYTES) {
      throw new AppError(
        "E2E authored files exceed the total human-review limit",
        413,
        "E2E_AUTHOR_OUTPUT_TOO_LARGE",
      );
    }
    const content = await readFile(path.join(stagingRoot, ...change.path.split("/")));
    try {
      if (decoder.decode(content).includes("\0")) throw new TypeError("NUL byte");
    } catch {
      throw new AppError(
        `E2E authored file is not reviewable UTF-8 text: ${change.path}`,
        422,
        "E2E_AUTHOR_OUTPUT_NOT_TEXT",
      );
    }
  }
}

async function collectReviewedSuite(
  stagingRoot: string,
  before: ReadonlyMap<string, AuthorFileSnapshot>,
): Promise<E2eAuthoredFile[]> {
  const files: E2eAuthoredFile[] = [];
  let totalBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const rootName of ["tests", "fixtures"] as const) {
    const root = path.join(stagingRoot, rootName);
    await walk(root, async (absolutePath, relativeWithinRoot, entry) => {
      const relativePath = path.posix.join(rootName, ...relativeWithinRoot.split(path.sep));
      if (entry.isSymbolicLink()) {
        throw new AppError(
          `E2E reviewed suite contains a symlink: ${relativePath}`,
          422,
          "E2E_AUTHOR_WORKSPACE_UNSAFE",
        );
      }
      if (!entry.isFile()) return;
      if (!isAllowedAuthorPath(relativePath)) {
        throw new AppError(
          `E2E reviewed suite contains a non-reviewable file: ${relativePath}`,
          422,
          "E2E_AUTHOR_OUTPUT_NOT_TEXT",
        );
      }
      const raw = await readFile(absolutePath);
      totalBytes += raw.length;
      if (
        raw.length > MAX_E2E_AUTHORED_REVIEW_BYTES
        || totalBytes > MAX_E2E_AUTHORED_REVIEW_BYTES
      ) {
        throw new AppError(
          "The complete executable E2E suite exceeds the human-review limit",
          413,
          "E2E_AUTHOR_OUTPUT_TOO_LARGE",
        );
      }
      try {
        if (decoder.decode(raw).includes("\0")) throw new TypeError("NUL byte");
      } catch {
        throw new AppError(
          `E2E reviewed suite file is not UTF-8 text: ${relativePath}`,
          422,
          "E2E_AUTHOR_OUTPUT_NOT_TEXT",
        );
      }
      const afterSha256 = sha256(raw);
      const previous = before.get(relativePath);
      files.push({
        path: relativePath,
        change: !previous ? "added" : previous.sha256 === afterSha256 ? "unchanged" : "modified",
        beforeSha256: previous?.sha256 ?? null,
        afterSha256,
        bytes: raw.length,
      });
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function assertFrozenCriteriaCoveredByTests(
  stagingRoot: string,
  criterionIds: readonly string[],
): Promise<void> {
  const testsRoot = path.join(stagingRoot, "tests");
  const combined: string[] = [];
  let files = 0;
  let bytes = 0;
  await walk(testsRoot, async (absolutePath, relativePath, entry) => {
    if (entry.isSymbolicLink()) {
      throw new AppError("E2E tests contain a symlink", 422, "E2E_AUTHOR_WORKSPACE_UNSAFE");
    }
    if (!entry.isFile() || !/\.(?:ts|js|mts|mjs|json|txt)$/u.test(relativePath)) return;
    files += 1;
    const raw = await readFile(absolutePath);
    bytes += raw.length;
    if (files > 5_000 || bytes > 16 * 1024 * 1024) {
      throw new AppError("E2E test coverage scan exceeds its limit", 413, "E2E_AUTHOR_WORKSPACE_TOO_LARGE");
    }
    try {
      combined.push(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      throw new AppError(
        `E2E test is not reviewable UTF-8 text: ${relativePath}`,
        422,
        "E2E_AUTHOR_OUTPUT_NOT_TEXT",
      );
    }
  });
  const source = combined.join("\n");
  const missing = criterionIds.filter((id) => !new RegExp(
    `(?:^|[^A-Z0-9-])${escapeRegExp(id)}(?:[^A-Z0-9-]|$)`,
    "u",
  ).test(source));
  if (missing.length > 0) {
    throw new AppError(
      `E2E authored tests do not cite every frozen criterion: ${missing.join(", ")}`,
      422,
      "E2E_AUTHOR_CRITERIA_UNCOVERED",
      { missing },
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

interface AppliedAuthoredFiles {
  rollback(): Promise<void>;
}

async function applyAuthoredFiles(
  e2eRoot: string,
  stagingRoot: string,
  files: readonly E2eAuthoredFile[],
): Promise<AppliedAuthoredFiles> {
  const rollback: Array<{ target: string; content?: Buffer; mode?: number }> = [];
  const restore = async () => {
    let restoreError: unknown;
    for (const entry of rollback.reverse()) {
      try {
        if (entry.content) {
          await writeFile(entry.target, entry.content);
          if (entry.mode !== undefined) await chmod(entry.target, entry.mode);
        } else {
          await rm(entry.target, { force: true });
        }
      } catch (error) {
        restoreError ??= error;
      }
    }
    if (restoreError) {
      throw new AppError(
        "Failed to roll back partially applied E2E authored files",
        500,
        "E2E_AUTHOR_ROLLBACK_FAILED",
      );
    }
  };
  try {
    for (const file of files) {
      const source = path.join(stagingRoot, ...file.path.split("/"));
      const target = path.join(e2eRoot, ...file.path.split("/"));
      await assertRegularWithin(stagingRoot, source);
      if (!isWithin(e2eRoot, target) || target === e2eRoot) {
        throw new AppError("Authored E2E path escaped its workspace", 400, "E2E_AUTHOR_OUTPUT_SCOPE_VIOLATION");
      }
      let existing: Buffer | undefined;
      let existingMode: number | undefined;
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new AppError("Authored E2E target is unsafe", 400, "E2E_AUTHOR_WORKSPACE_UNSAFE");
        }
        existing = await readFile(target);
        existingMode = info.mode;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const actualBeforeHash = existing ? sha256(existing) : null;
      if (
        (file.change === "added" && existing)
        || (file.change === "modified" && !existing)
        || actualBeforeHash !== file.beforeSha256
      ) {
        throw new AppError(
          `E2E authored target changed after the staging snapshot: ${file.path}`,
          409,
          "E2E_AUTHOR_TARGET_STALE",
        );
      }
      rollback.push({ target, ...(existing ? { content: existing, mode: existingMode } : {}) });
      await safeParentDirectories(e2eRoot, path.dirname(target));
      await writeFile(target, await readFile(source), existing ? undefined : { flag: "wx" });
      if (existingMode !== undefined) await chmod(target, existingMode);
    }
    return { rollback: restore };
  } catch (error) {
    await restore();
    throw error;
  }
}

function authorPrompt(intent: z.infer<typeof frozenIntentSchema>): string {
  return [
    "You are an independent E2E Test Author in a fresh, ephemeral, spec-only session.",
    "Write only reusable Playwright test assets under tests/ and fixtures/ in the current standalone E2E project.",
    "Do not inspect or search for a product source repository, implementation diff, prior agent session, MCP transcript, DOM dump, or generated exploration code.",
    "Do not edit package.json, lockfiles, Playwright configuration, .ai-sdlc, Git metadata, reports, or dependency directories. Do not install packages or run browsers.",
    "Freeze assertions from this authoritative observable intent. Do not weaken an expectation to match an implementation.",
    "Every test title or adjacent metadata must include its exact AC/regression ID.",
    "",
    "<frozen-e2e-spec-intent>",
    stableJson(intent),
    "</frozen-e2e-spec-intent>",
    "",
    "Create or update the minimum complete tests/fixtures assets, then stop.",
  ].join("\n");
}

function codexSessionId(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/u)) {
    try {
      const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        return event.thread_id;
      }
    } catch {
      // Non-JSON output does not become provenance.
    }
  }
  return null;
}

function shouldCopyForAuthor(root: string, source: string): boolean {
  const relative = path.relative(root, source);
  if (!relative) return true;
  const first = relative.split(path.sep)[0]!;
  return !authorExcludedRoots.has(first);
}

async function assertNoCopiedSymlinks(root: string): Promise<void> {
  await walk(root, async (_absolutePath, relativePath, entry) => {
    const first = relativePath.split(path.sep)[0];
    if (first && authorExcludedRoots.has(first)) return "skip";
    if (entry.isSymbolicLink()) {
      throw new AppError(
        `E2E author source contains a symlink: ${relativePath}`,
        400,
        "E2E_AUTHOR_WORKSPACE_UNSAFE",
      );
    }
  });
}

async function assertManagedE2eInputTree(root: string): Promise<void> {
  const allowedControlFiles = new Set(["package.json", "package-lock.json", "playwright.config.mjs"]);
  const excluded = new Set([...authorExcludedRoots]);
  await walk(root, async (_absolutePath, relativePath, entry) => {
    const normalized = relativePath.split(path.sep).join("/");
    const [first] = normalized.split("/");
    if (first && excluded.has(first)) return entry.isDirectory() ? "skip" : undefined;
    if (!normalized.includes("/") && allowedControlFiles.has(normalized) && entry.isFile()) return;
    if (first === "tests" || first === "fixtures") {
      if (entry.isDirectory()) return;
      if (entry.isFile() && isAllowedAuthorPath(normalized)) return;
    }
    throw new AppError(
      `Unmanaged E2E input is outside the complete human-review surface: ${normalized}`,
      422,
      "E2E_INPUT_TREE_UNMANAGED",
    );
  });
}

type WalkDecision = void | "skip";

async function walk(
  root: string,
  visitor: (
    absolutePath: string,
    relativePath: string,
    entry: import("node:fs").Dirent,
  ) => Promise<WalkDecision>,
): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath);
      const decision = await visitor(absolutePath, relativePath, entry);
      if (entry.isDirectory() && decision !== "skip") await visit(absolutePath);
    }
  };
  await visit(root);
}

interface CompletedProcess {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type E2eFailureStage =
  | "evidence_baseline"
  | "target_start_and_probe"
  | "source_readiness"
  | "browser_target_probe"
  | "playwright_test"
  | "evidence_collection"
  | "manifest_write"
  | "execution";

interface E2eFailureDiagnostics {
  stage?: E2eFailureStage;
  testExitCode?: number;
  testStdoutSha256?: string;
  testStderrSha256?: string;
  serverExitCode?: number;
  serverStdoutSha256?: string;
  serverStderrSha256?: string;
  serverCleanup?: E2eExecutionResult["serverCleanup"];
}

function processDiagnostics(
  kind: "test" | "server",
  completed: CompletedProcess,
): E2eFailureDiagnostics {
  return kind === "test"
    ? {
        testExitCode: completed.exitCode,
        testStdoutSha256: sha256(completed.stdout),
        testStderrSha256: sha256(completed.stderr),
      }
    : {
        serverExitCode: completed.exitCode,
        serverStdoutSha256: sha256(completed.stdout),
        serverStderrSha256: sha256(completed.stderr),
      };
}

function withExecutionDiagnostics(
  error: unknown,
  diagnostics: E2eFailureDiagnostics,
): AppError {
  const previous = error instanceof AppError && isRecord(error.details)
    ? error.details
    : {};
  return new AppError(
    error instanceof Error ? error.message : String(error),
    error instanceof AppError ? error.statusCode : 502,
    error instanceof AppError ? error.code : "E2E_EXECUTION_FAILED",
    { ...diagnostics, ...previous },
  );
}

async function persistExecutionFailure(
  e2eRoot: string,
  executionId: string,
  error: unknown,
  input: E2eExecutionInput,
): Promise<AppError> {
  const normalized = withExecutionDiagnostics(error, { stage: "execution" });
  const details = isRecord(normalized.details) ? normalized.details : {};
  const relativePath = path.posix.join(
    "test-results",
    `ai-sdlc-platform-${executionId}-failure.json`,
  );
  const target = path.join(e2eRoot, ...relativePath.split("/"));
  const manifest = {
    schemaVersion: 1,
    kind: "e2e_execution_failure",
    executionId,
    passed: false,
    stage: failureStage(details.stage),
    code: normalized.code.slice(0, 160),
    message: normalized.message.slice(0, 2_000),
    sourceCommand: {
      command: "npm",
      args: ["run", input.config.sourceStartScript],
      cwd: input.productRoot,
    },
    testCommand: {
      command: "npm",
      args: ["run", input.config.testScript],
      cwd: e2eRoot,
    },
    baseUrl: input.config.baseUrl,
    browser: input.browser,
    ...failureDiagnosticsForManifest(details),
  };
  try {
    await writePlatformFile(e2eRoot, target, `${JSON.stringify(manifest, null, 2)}\n`);
    const content = await readFile(target);
    const failureEvidence: E2eExecutionFailureEvidence = {
      path: relativePath,
      sha256: sha256(content),
      bytes: content.length,
    };
    return new AppError(
      normalized.message,
      normalized.statusCode,
      normalized.code,
      { ...details, failureEvidence },
    );
  } catch (writeError) {
    throw new AppError(
      "E2E execution failed and its durable failure evidence could not be written",
      500,
      "E2E_FAILURE_EVIDENCE_WRITE_FAILED",
      {
        stage: failureStage(details.stage),
        originalCode: normalized.code,
        writeErrorCode: writeError instanceof AppError ? writeError.code : "WRITE_FAILED",
      },
    );
  }
}

function failureStage(value: unknown): E2eFailureStage {
  return typeof value === "string" && [
    "evidence_baseline",
    "target_start_and_probe",
    "source_readiness",
    "browser_target_probe",
    "playwright_test",
    "evidence_collection",
    "manifest_write",
    "execution",
  ].includes(value)
    ? value as E2eFailureStage
    : "execution";
}

function failureDiagnosticsForManifest(details: Record<string, unknown>): E2eFailureDiagnostics {
  const diagnostics: E2eFailureDiagnostics = {};
  for (const key of ["testExitCode", "serverExitCode"] as const) {
    if (Number.isInteger(details[key])) diagnostics[key] = details[key] as number;
  }
  for (const key of [
    "testStdoutSha256",
    "testStderrSha256",
    "serverStdoutSha256",
    "serverStderrSha256",
  ] as const) {
    if (typeof details[key] === "string" && /^[a-f0-9]{64}$/u.test(details[key])) {
      diagnostics[key] = details[key];
    }
  }
  if (["already_exited", "sigterm", "sigkill"].includes(String(details.serverCleanup))) {
    diagnostics.serverCleanup = details.serverCleanup as E2eExecutionResult["serverCleanup"];
  }
  return diagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface ProcessMonitor {
  completed: Promise<CompletedProcess>;
  isClosed(): boolean;
}

function monitorProcess(
  child: ChildProcess,
  maxOutputBytes: number,
  processGroup = false,
): ProcessMonitor {
  let closed = false;
  const completed = collectChild(child, maxOutputBytes, processGroup).finally(() => {
    closed = true;
  });
  return { completed, isClosed: () => closed };
}

async function waitForProcess(
  child: ChildProcess,
  timeoutMs: number,
  maxOutputBytes: number,
  processGroup = false,
): Promise<CompletedProcess> {
  const monitored = monitorProcess(child, maxOutputBytes, processGroup);
  return waitForMonitoredProcess(child, monitored, timeoutMs, processGroup);
}

async function waitForMonitoredProcess(
  child: ChildProcess,
  monitored: ProcessMonitor,
  timeoutMs: number,
  processGroup = false,
): Promise<CompletedProcess> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      monitored.completed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          terminateProcess(child, "SIGKILL", processGroup);
          reject(new AppError("E2E process timed out", 504, "E2E_PROCESS_TIMEOUT"));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function collectChild(
  child: ChildProcess,
  maxOutputBytes: number,
  processGroup = false,
): Promise<CompletedProcess> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdoutBytes < maxOutputBytes) {
        stdout.push(bytes.subarray(0, maxOutputBytes - stdoutBytes));
      }
      stdoutBytes += bytes.length;
      if (stdoutBytes > maxOutputBytes) terminateProcess(child, "SIGKILL", processGroup);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stderrBytes < maxOutputBytes) {
        stderr.push(bytes.subarray(0, maxOutputBytes - stderrBytes));
      }
      stderrBytes += bytes.length;
      if (stderrBytes > maxOutputBytes) terminateProcess(child, "SIGKILL", processGroup);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => {
      if (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes) {
        reject(new AppError("E2E process output exceeded its limit", 502, "E2E_PROCESS_OUTPUT_LIMIT"));
      } else {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }
    }));
  });
}

async function stopSupervisedProcess(
  child: ChildProcess,
  monitor: ProcessMonitor,
  timeoutMs: number,
  processGroup = false,
  baseUrl?: string,
  releaseProbe?: E2eTargetVacancyProbe,
): Promise<E2eExecutionResult["serverCleanup"]> {
  const clean = () => supervisedTargetIsGone(
    child,
    monitor,
    processGroup,
    baseUrl,
    releaseProbe,
  );
  if (await clean()) return "already_exited";
  terminateProcess(child, "SIGTERM", processGroup);
  if (await waitForSupervisedTargetGone(clean, timeoutMs)) return "sigterm";
  terminateProcess(child, "SIGKILL", processGroup);
  await waitForSupervisedTargetGone(clean, Math.max(timeoutMs, 250));
  await monitor.completed.catch(() => undefined);
  return "sigkill";
}

async function supervisedTargetIsGone(
  child: ChildProcess,
  monitor: ProcessMonitor,
  processGroup: boolean,
  baseUrl?: string,
  releaseProbe?: E2eTargetVacancyProbe,
): Promise<boolean> {
  if (!monitor.isClosed() || processGroupIsAlive(child, processGroup)) return false;
  if (!baseUrl || !releaseProbe) return true;
  try {
    await releaseProbe(baseUrl, 250);
    return true;
  } catch {
    return false;
  }
}

async function waitForSupervisedTargetGone(
  probe: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await probe()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  }
  return probe();
}

function processGroupIsAlive(child: ChildProcess, processGroup: boolean): boolean {
  if (!processGroup || process.platform === "win32" || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function terminateProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
  processGroup: boolean,
): void {
  if (processGroup && process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        child.kill(signal);
        return;
      }
    }
  }
  child.kill(signal);
}

export async function waitForHttpReady(
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("E2E readiness probe was aborted");
    const remainingMs = Math.max(1, deadline - Date.now());
    const attemptController = new AbortController();
    const relayAbort = () => attemptController.abort(signal.reason);
    signal.addEventListener("abort", relayAbort, { once: true });
    const attemptTimer = setTimeout(
      () => attemptController.abort(new Error("HTTP readiness attempt timed out")),
      Math.min(1_000, remainingMs),
    );
    attemptTimer.unref();
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: attemptController.signal,
      });
      if (response.status >= 200 && response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = attemptController.signal.aborted
        ? "HTTP readiness attempt timed out"
        : error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(attemptTimer);
      signal.removeEventListener("abort", relayAbort);
    }
    const delayMs = Math.min(100, Math.max(0, deadline - Date.now()));
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
  throw new AppError(
    `E2E source server did not become ready: ${lastError}`,
    504,
    "E2E_SOURCE_SERVER_NOT_READY",
  );
}

const browserTargetProbeProgram = [
  'import { createRequire } from "node:module";',
  'const require = createRequire(process.cwd() + "/package.json");',
  'const { chromium } = require("@playwright/test");',
  'const browser = await chromium.launch({',
  '  headless: true,',
  '  executablePath: process.env.AI_SDLC_E2E_BROWSER_EXECUTABLE,',
  '});',
  'try {',
  '  const page = await browser.newPage();',
  '  const response = await page.goto(process.env.AI_SDLC_E2E_BASE_URL, {',
  '    waitUntil: "domcontentloaded",',
  '    timeout: Number(process.env.AI_SDLC_E2E_TARGET_TIMEOUT_MS),',
  '  });',
  '  if (!response) throw new Error("browser navigation produced no HTTP response");',
  '  process.stdout.write(JSON.stringify({',
  '    url: page.url(), status: response.status(), browserVersion: browser.version()',
  '  }) + "\\n");',
  '} finally {',
  '  await browser.close();',
  '}',
].join("\n");

async function launchBrowserTargetProbe(
  spawnProcess: E2eProcessSpawner,
  maxOutputBytes: number,
  input: Parameters<E2eBrowserTargetProbe>[0],
): Promise<E2eBrowserTargetProbeResult> {
  const child = spawnProcess(process.execPath, ["--input-type=module", "--eval", browserTargetProbeProgram], {
    cwd: input.e2eRoot,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...input.environment,
      AI_SDLC_E2E_BASE_URL: input.baseUrl,
      AI_SDLC_E2E_BROWSER_EXECUTABLE: input.browser.executablePath,
      AI_SDLC_E2E_TARGET_TIMEOUT_MS: String(input.timeoutMs),
    },
    detached: process.platform !== "win32",
  });
  let completed: CompletedProcess;
  try {
    completed = await waitForProcess(child, input.timeoutMs, maxOutputBytes, true);
  } catch (error) {
    throw new AppError(
      `Chromium could not navigate to the configured E2E target: ${error instanceof Error ? error.message : String(error)}`,
      502,
      "E2E_BROWSER_TARGET_FAILED",
    );
  }
  if (completed.exitCode !== 0) {
    throw new AppError(
      "Chromium could not navigate to the configured E2E target",
      502,
      "E2E_BROWSER_TARGET_FAILED",
      { exitCode: completed.exitCode, stderrHash: sha256(completed.stderr) },
    );
  }
  try {
    const parsed = JSON.parse(completed.stdout.trim()) as Partial<E2eBrowserTargetProbeResult>;
    if (
      typeof parsed.url !== "string"
      || (typeof parsed.status !== "number" && parsed.status !== null)
      || typeof parsed.browserVersion !== "string"
      || parsed.browserVersion.length === 0
    ) throw new TypeError("invalid browser target probe output");
    const configured = new URL(input.baseUrl);
    const navigated = new URL(parsed.url);
    if (
      configured.origin !== navigated.origin
      || configured.href !== navigated.href
      || parsed.status === null
      || parsed.status < 200
      || parsed.status >= 500
      || parsed.browserVersion !== input.browser.version
    ) {
      throw new TypeError("browser target origin, status, or locked browser version did not match");
    }
    return parsed as E2eBrowserTargetProbeResult;
  } catch (error) {
    throw new AppError(
      `Chromium target probe produced invalid evidence: ${error instanceof Error ? error.message : String(error)}`,
      502,
      "E2E_BROWSER_TARGET_FAILED",
    );
  }
}

function assertBrowserTargetProbe(
  baseUrl: string,
  browser: BrowserLaunchProbeResult,
  result: E2eBrowserTargetProbeResult,
): void {
  try {
    const configured = new URL(baseUrl);
    const navigated = new URL(result.url);
    if (
      configured.origin !== navigated.origin
      || configured.href !== navigated.href
      || result.status === null
      || !Number.isInteger(result.status)
      || result.status < 200
      || result.status >= 500
      || result.browserVersion !== browser.version
    ) throw new TypeError("origin, HTTP status, or locked browser version did not match");
  } catch (error) {
    throw new AppError(
      `Chromium target evidence is invalid: ${error instanceof Error ? error.message : String(error)}`,
      502,
      "E2E_BROWSER_TARGET_FAILED",
    );
  }
}

async function assertTargetVacant(value: string, timeoutMs: number): Promise<void> {
  const target = new URL(value);
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const hostname = target.hostname.startsWith("[") && target.hostname.endsWith("]")
    ? target.hostname.slice(1, -1)
    : target.hostname;
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AppError(
        "Could not prove that the configured E2E target port was vacant",
        409,
        "E2E_TARGET_VACANCY_UNKNOWN",
      ));
    }, timeoutMs);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new AppError(
        "The configured E2E target is already occupied; refusing to test a stale server",
        409,
        "E2E_TARGET_ALREADY_RUNNING",
      ));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(new AppError(
        `Could not prove that the configured E2E target port was vacant: ${error.message}`,
        409,
        "E2E_TARGET_VACANCY_UNKNOWN",
      ));
    });
  });
}

interface EvidenceCollectionLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
}

async function collectEvidenceFiles(
  e2eRoot: string,
  limits: EvidenceCollectionLimits,
): Promise<E2eExecutionEvidenceFile[]> {
  const files: E2eExecutionEvidenceFile[] = [];
  let totalBytes = 0;
  for (const root of runtimeEvidenceRoots) {
    const absoluteRoot = path.join(e2eRoot, root);
    try {
      const info = await lstat(absoluteRoot);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new AppError("E2E evidence root is unsafe", 400, "E2E_EVIDENCE_PATH_UNSAFE");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await walk(absoluteRoot, async (absolutePath, relativeWithinRoot, entry) => {
      if (entry.isSymbolicLink()) {
        throw new AppError(
          `E2E evidence contains a symlink: ${root}/${relativeWithinRoot}`,
          400,
          "E2E_EVIDENCE_PATH_UNSAFE",
        );
      }
      if (!entry.isFile()) return;
      const info = await stat(absolutePath);
      if (info.size > limits.maxFileBytes) {
        throw new AppError(
          `E2E evidence file exceeds ${limits.maxFileBytes} bytes`,
          413,
          "E2E_EVIDENCE_TOO_LARGE",
        );
      }
      if (files.length + 1 > limits.maxFiles || totalBytes + info.size > limits.maxTotalBytes) {
        throw new AppError(
          "E2E evidence exceeds the file-count or total-byte limit",
          413,
          "E2E_EVIDENCE_TOO_LARGE",
        );
      }
      const content = await readFile(absolutePath);
      totalBytes += content.length;
      files.push({
        path: path.posix.join(root, ...relativeWithinRoot.split(path.sep)),
        sha256: sha256(content),
        bytes: content.length,
      });
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function safeExactDirectory(candidate: string, label: string): Promise<string> {
  const requested = path.resolve(candidate);
  const info = await lstat(requested).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new AppError(`${label} is missing`, 400, "E2E_WORKSPACE_PATH_MISSING");
    }
    throw error;
  });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AppError(`${label} is not a safe directory`, 400, "E2E_WORKSPACE_PATH_UNSAFE");
  }
  const canonical = await realpath(requested);
  if (canonical !== requested) {
    throw new AppError(`${label} is not canonical`, 400, "E2E_WORKSPACE_PATH_UNSAFE");
  }
  return canonical;
}

function assertNonNestedRoots(productRoot: string, e2eRoot: string): void {
  if (isWithin(productRoot, e2eRoot) || isWithin(e2eRoot, productRoot)) {
    throw new AppError(
      "Product and E2E roots must be distinct and non-nested",
      400,
      "E2E_WORKSPACE_ROOTS_OVERLAP",
    );
  }
}

function assertExecutionId(value: string): void {
  if (!executionIdentifier.test(value)) {
    throw new AppError("E2E execution identifier is invalid", 400, "E2E_EXECUTION_ID_INVALID");
  }
}

function assertScript(value: string): void {
  if (!npmScriptIdentifier.test(value)) {
    throw new AppError("E2E command must use a fixed npm script identifier", 400, "E2E_SCRIPT_INVALID");
  }
}

async function assertPackageScript(
  root: string,
  script: string,
  expectedCommand?: string,
): Promise<void> {
  const packagePath = path.join(root, "package.json");
  await assertRegularWithin(root, packagePath);
  let parsed: { scripts?: Record<string, unknown> };
  try {
    parsed = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
  } catch (error) {
    throw new AppError("package.json is invalid", 400, "E2E_PACKAGE_JSON_INVALID", error);
  }
  if (typeof parsed.scripts?.[script] !== "string" || !String(parsed.scripts[script]).trim()) {
    throw new AppError(`npm script ${script} is missing`, 409, "E2E_SCRIPT_MISSING");
  }
  if (expectedCommand !== undefined && parsed.scripts[script] !== expectedCommand) {
    throw new AppError(
      `npm script ${script} no longer matches the fixed Playwright command`,
      409,
      "E2E_TEST_SCRIPT_CHANGED",
    );
  }
  if (expectedCommand !== undefined) {
    const lifecycleHooks = [`pre${script}`, `post${script}`]
      .filter((hook) => Object.prototype.hasOwnProperty.call(parsed.scripts ?? {}, hook));
    if (lifecycleHooks.length > 0) {
      throw new AppError(
        `npm lifecycle hooks may not wrap the fixed Playwright command: ${lifecycleHooks.join(", ")}`,
        409,
        "E2E_TEST_LIFECYCLE_HOOK_FORBIDDEN",
      );
    }
  }
}

async function assertCanonicalPlaywrightConfig(e2eRoot: string): Promise<void> {
  const target = path.join(e2eRoot, "playwright.config.mjs");
  await assertRegularWithin(e2eRoot, target);
  if (await readFile(target, "utf8") !== canonicalPlaywrightConfigSource()) {
    throw new AppError(
      "playwright.config.mjs no longer matches the fixed platform scaffold",
      409,
      "E2E_PLAYWRIGHT_CONFIG_CHANGED",
    );
  }
}

async function assertRegularWithin(root: string, target: string): Promise<void> {
  if (!isWithin(root, target) || target === root) {
    throw new AppError("E2E file path escaped workspace", 400, "E2E_WORKSPACE_PATH_UNSAFE");
  }
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new AppError("E2E file must be regular", 400, "E2E_WORKSPACE_PATH_UNSAFE");
  }
  const canonical = await realpath(target);
  if (!isWithin(root, canonical)) {
    throw new AppError("E2E file resolves outside workspace", 400, "E2E_WORKSPACE_PATH_UNSAFE");
  }
}

async function safeParentDirectories(root: string, target: string): Promise<void> {
  if (!isWithin(root, target)) {
    throw new AppError("E2E parent escaped workspace", 400, "E2E_WORKSPACE_PATH_UNSAFE");
  }
  const relative = path.relative(root, target);
  let cursor = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new AppError("E2E parent is unsafe", 400, "E2E_WORKSPACE_PATH_UNSAFE");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(cursor);
    }
  }
}

async function writePlatformFile(root: string, target: string, content: string): Promise<void> {
  if (!isWithin(root, target) || target === root) {
    throw new AppError("Platform E2E evidence path escaped workspace", 400, "E2E_WORKSPACE_PATH_UNSAFE");
  }
  await safeParentDirectories(root, path.dirname(target));
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await link(temporary, target);
    await rm(temporary, { force: true });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function defaultSpawner(
  command: string,
  args: readonly string[],
  options: ProcessSpawnOptions,
): ChildProcess {
  return spawn(command, [...args], options);
}

function authorEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
    "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
  );
}

function executionEnvironment(
  source: NodeJS.ProcessEnv,
  url: URL,
  baseUrl: string,
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
    "PLAYWRIGHT_BROWSERS_PATH", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  ];
  return {
    ...Object.fromEntries(
      allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
    ),
    CI: "1",
    HOST: url.hostname.replace(/^\[|\]$/gu, ""),
    PORT: url.port || "80",
    AI_SDLC_E2E_BASE_URL: baseUrl,
    npm_config_ignore_scripts: "true",
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
