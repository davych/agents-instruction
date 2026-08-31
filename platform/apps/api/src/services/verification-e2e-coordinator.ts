import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import type {
  ConfigureE2eWorkspaceInput,
  E2eAuthoringDto,
  E2eWorkspaceDto,
  E2eWorkspaceReadinessDto,
  ProjectDto,
  ReviewVerificationE2eScriptsInput,
} from "@ai-sdlc/contracts";
import { z } from "zod";

import type { FrozenE2eIntent } from "../domain/verification-e2e-intent.js";
import { AppError } from "../domain/errors.js";
import { assertRuntimePath } from "./artifact-workspace.js";
import {
  E2eAutomationRunner,
  E2eTestAuthorRunner,
  MAX_E2E_AUTHORED_REVIEW_BYTES,
  collectE2eReviewBaseline,
  type E2eExecutionFailureEvidence,
  type E2eExecutionResult,
  type FrozenE2eSpecIntent,
} from "./e2e-automation-runner.js";
import {
  DEFAULT_E2E_PLAYWRIGHT_VERSION,
  E2E_TEST_SCRIPT,
  E2E_WORKSPACE_SIDECAR_PATH,
  E2eWorkspaceService,
  type E2eWorkspaceConfig,
  type E2eWorkspaceReadiness,
} from "./e2e-workspace-service.js";
import {
  captureVerificationGitState,
  type VerificationGitState,
} from "./verification-git-state.js";
import {
  captureVerificationWorkspaceRevision,
  withVerificationWorkspaceProtected,
} from "./verification-workspace.js";
import { isWithin } from "./project-paths.js";

const authoringRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  executionId: z.string().uuid(),
  status: z.enum(["awaiting_review", "approved", "changes_requested"]),
  patchHash: z.string().regex(/^[a-f0-9]{64}$/u),
  productRevisionToken: z.string().regex(/^[a-f0-9]{64}$/u),
  e2eRevisionToken: z.string().regex(/^[a-f0-9]{64}$/u),
  productGitState: z.unknown(),
  e2eGitState: z.unknown(),
  criterionIds: z.array(z.string().min(1)).min(1),
  files: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().nonnegative(),
  }).strict()).min(1),
  reviewComment: z.string().nullable(),
  reviewedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

type AuthoringRecord = z.infer<typeof authoringRecordSchema>;

export interface VerificationE2eCoordinatorOptions {
  workspaceService: E2eWorkspaceService;
  authorRunner: E2eTestAuthorRunner;
  automationRunner: E2eAutomationRunner;
}

export interface VerificationE2eExecutionEvidence {
  result: E2eExecutionResult;
  authoring: E2eAuthoringDto;
  prompt: string;
  e2eWorkspaceRevisionToken: string;
  e2eGitState: VerificationGitState;
  copiedEvidence: Array<{ path: string; sha256: string; bytes: number }>;
  command: string;
  commandHash: string;
}

export interface VerificationE2eScriptReviewAuthority {
  decision: "approve" | "request_changes";
  authorExecutionId: string;
  patchHash: string;
  productRevisionToken: string;
  e2eRevisionToken: string;
  commentHash: string;
  reviewedAt: string;
}

export interface PreparedVerificationE2eScriptReview {
  authoring: E2eAuthoringDto;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export class VerificationE2eCoordinator {
  private readonly workspaceService: E2eWorkspaceService;
  private readonly authorRunner: E2eTestAuthorRunner;
  private readonly automationRunner: E2eAutomationRunner;

  constructor(options: VerificationE2eCoordinatorOptions) {
    this.workspaceService = options.workspaceService;
    this.authorRunner = options.authorRunner;
    this.automationRunner = options.automationRunner;
  }

  async configure(
    project: ProjectDto,
    input: ConfigureE2eWorkspaceInput,
  ): Promise<E2eWorkspaceDto> {
    if (!input.initialize) {
      throw new AppError(
        "首版 Linked E2E Workspace 只支持显式初始化一个新的空目录",
        400,
        "E2E_WORKSPACE_INITIALIZE_REQUIRED",
      );
    }
    if (
      input.packageManager !== "npm"
      || input.browser !== "chromium"
      || input.testScript !== E2E_TEST_SCRIPT
    ) {
      throw new AppError(
        "当前只支持 npm、Chromium 和固定 test:e2e 脚本",
        400,
        "E2E_WORKSPACE_CONFIG_INVALID",
      );
    }
    await this.workspaceService.initialize({
      productRoot: project.rootPath,
      e2eRoot: input.rootPath,
      sourceStartScript: input.sourceStartScript,
      baseUrl: input.baseUrl,
      playwrightVersion: input.playwrightVersion ?? DEFAULT_E2E_PLAYWRIGHT_VERSION,
    });
    return this.workspace(project);
  }

  async workspace(project: ProjectDto): Promise<E2eWorkspaceDto> {
    const config = await this.workspaceService.load(project.rootPath);
    return workspaceDto(project, config);
  }

  async optionalWorkspace(project: ProjectDto): Promise<E2eWorkspaceDto | null> {
    try {
      return await this.workspace(project);
    } catch (error) {
      if (error instanceof AppError && error.code === "E2E_WORKSPACE_NOT_CONFIGURED") return null;
      throw error;
    }
  }

  async prepare(project: ProjectDto) {
    const result = await this.workspaceService.prepare(project.rootPath);
    return { result, readiness: await this.readiness(project) };
  }

  async readiness(project: ProjectDto): Promise<E2eWorkspaceReadinessDto> {
    const readiness = await this.workspaceService.readiness(project.rootPath);
    if (!readiness.ready) return readinessDto(readiness);
    const config = await this.workspaceService.load(project.rootPath);
    const browser = readiness.browser.executablePath && readiness.browser.version
      ? { executablePath: readiness.browser.executablePath, version: readiness.browser.version }
      : null;
    if (!browser) return readinessDto(readiness, {
      state: "failed",
      message: "Chromium 启动信息缺失",
      detail: "E2E_BROWSER_NOT_READY",
    });
    try {
      const [productGitState, e2eGitState] = await Promise.all([
        captureVerificationGitState(project.rootPath),
        captureVerificationGitState(config.e2eRoot),
      ]);
      const target = await withVerificationWorkspaceProtected(
        {
          projectRoot: project.rootPath,
          selectedOutputPaths: [],
          protectedGitMetadataPaths: gitMetadataPaths(productGitState),
        },
        () => withVerificationWorkspaceProtected(
          {
            projectRoot: config.e2eRoot,
            selectedOutputPaths: [],
            protectedGitMetadataPaths: gitMetadataPaths(e2eGitState),
          },
          () => this.automationRunner.preflight({
            productRoot: project.rootPath,
            config,
            browser,
          }),
        ),
      );
      return readinessDto(readiness, {
        state: "ready",
        message: "真实 Chromium 已访问目标",
        detail: `url=${target.targetProbe.url}; status=${target.targetProbe.status}; cleanup=${target.serverCleanup}`,
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : "E2E_TARGET_PREFLIGHT_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      return readinessDto(readiness, {
        state: "failed",
        message: "产品目标预检失败",
        detail: `${code}: ${message.slice(0, 1_000)}`,
      });
    }
  }

  async author(input: {
    project: ProjectDto;
    runId: string;
    executionId: string;
    intent: FrozenE2eIntent;
    model: string | null;
    reasoningEffort: string | null;
    testReportPath: string;
  }): Promise<{ authoring: E2eAuthoringDto; reportContent: string }> {
    const config = await this.workspaceService.load(input.project.rootPath);
    const readiness = await this.readiness(input.project);
    assertReadyDto(readiness);
    const productRevisionToken = await productRevision(input.project.rootPath, input.testReportPath);
    const productGitState = await captureVerificationGitState(input.project.rootPath);
    const result = await this.authorRunner.run({
      e2eRoot: config.e2eRoot,
      executionId: input.executionId,
      frozenIntent: authorIntent(input.runId, input.intent),
      model: input.model ?? undefined,
      reasoningEffort: input.reasoningEffort ?? undefined,
    });
    try {
      const e2eRevision = await captureE2eInputRevisionToken(config.e2eRoot);
      const e2eGitState = await captureVerificationGitState(config.e2eRoot);
      const now = new Date().toISOString();
      const record: AuthoringRecord = {
        schemaVersion: 1,
        runId: input.runId,
        executionId: input.executionId,
        status: "awaiting_review",
        patchHash: result.patchHash,
        productRevisionToken,
        e2eRevisionToken: e2eRevision,
        productGitState,
        e2eGitState,
        criterionIds: input.intent.criteria.map(({ id }) => id),
        files: result.files.map((file) => ({
          path: file.path,
          sha256: file.afterSha256,
          bytes: file.bytes,
        })),
        reviewComment: null,
        reviewedAt: null,
        createdAt: now,
      };
      const authoring = await authoringDto(config.e2eRoot, record);
      await writeAuthoringRecord(config.e2eRoot, record);
      return {
        authoring,
        reportContent: authoringReport(input.executionId, record),
      };
    } catch (error) {
      try {
        await result.rollbackPromotion();
      } catch (rollbackError) {
        throw new AppError(
          "E2E authoring record failed and promoted files could not be fully rolled back",
          500,
          "E2E_AUTHOR_ROLLBACK_FAILED",
          {
            cause: error instanceof Error ? error.message : String(error),
            rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          },
        );
      }
      throw error;
    }
  }

  async latestAuthoring(project: ProjectDto, runId: string): Promise<E2eAuthoringDto | null> {
    const config = await this.workspaceService.load(project.rootPath);
    const record = await readAuthoringRecord(config.e2eRoot, runId);
    return record ? authoringDto(config.e2eRoot, record) : null;
  }

  async review(
    project: ProjectDto,
    runId: string,
    input: ReviewVerificationE2eScriptsInput,
    testReportPath: string,
  ): Promise<E2eAuthoringDto> {
    const prepared = await this.prepareReview(project, runId, input, testReportPath);
    await prepared.commit();
    return prepared.authoring;
  }

  async prepareReview(
    project: ProjectDto,
    runId: string,
    input: ReviewVerificationE2eScriptsInput,
    testReportPath: string,
  ): Promise<PreparedVerificationE2eScriptReview> {
    const config = await this.workspaceService.load(project.rootPath);
    const record = await requireAuthoringRecord(config.e2eRoot, runId);
    if (record.patchHash !== input.expectedPatchHash) {
      throw stale("E2E 脚本 manifest 已变化，请刷新后重审");
    }
    await assertAuthoringCurrent(project.rootPath, config.e2eRoot, testReportPath, record);
    const updated: AuthoringRecord = {
      ...record,
      status: input.decision === "approve" ? "approved" : "changes_requested",
      reviewComment: input.comment,
      reviewedAt: new Date().toISOString(),
    };
    const authoring = await authoringDto(config.e2eRoot, updated);
    let committed = false;
    return {
      authoring,
      async commit() {
        if (committed) return;
        await writeAuthoringRecord(config.e2eRoot, updated);
        committed = true;
      },
      async rollback() {
        if (!committed) return;
        await writeAuthoringRecord(config.e2eRoot, record);
        committed = false;
      },
    };
  }

  async execute(input: {
    project: ProjectDto;
    runId: string;
    executionId: string;
    testReportPath: string;
    reviewAuthority: VerificationE2eScriptReviewAuthority;
    onEvent: (eventType: string, payload: unknown) => Promise<void>;
  }): Promise<VerificationE2eExecutionEvidence> {
    const config = await this.workspaceService.load(input.project.rootPath);
    const readiness = await this.workspaceService.readiness(input.project.rootPath);
    assertReady(readiness);
    const record = await requireAuthoringRecord(config.e2eRoot, input.runId);
    if (
      record.status !== "approved"
      || input.reviewAuthority.decision !== "approve"
      || input.reviewAuthority.authorExecutionId !== record.executionId
      || input.reviewAuthority.patchHash !== record.patchHash
      || input.reviewAuthority.productRevisionToken !== record.productRevisionToken
      || input.reviewAuthority.e2eRevisionToken !== record.e2eRevisionToken
    ) {
      throw new AppError(
        "当前生成的 E2E 脚本没有匹配的数据库人工审核授权",
        409,
        "E2E_SCRIPT_REVIEW_REQUIRED",
      );
    }
    await assertAuthoringCurrent(
      input.project.rootPath,
      config.e2eRoot,
      input.testReportPath,
      record,
    );
    const e2eGitState = await captureVerificationGitState(config.e2eRoot);
    const browser = readiness.browser.executablePath && readiness.browser.version
      ? { executablePath: readiness.browser.executablePath, version: readiness.browser.version }
      : undefined;
    if (!browser) throw new AppError("Chromium launch probe is missing", 409, "E2E_BROWSER_NOT_READY");

    const descriptor = await workspaceDto(input.project, config);
    const command = `npm run ${config.testScript}`;
    const commandHash = sha256(command);
    await input.onEvent("e2e.execution.started", {
      e2eRoot: config.e2eRoot,
      baseUrl: config.baseUrl,
      descriptorHash: descriptor.descriptorHash,
      patchHash: record.patchHash,
      e2eWorkspaceRevisionToken: record.e2eRevisionToken,
      e2eGitState,
      browser,
    });
    let result: E2eExecutionResult;
    try {
      result = await withVerificationWorkspaceProtected(
        {
          projectRoot: config.e2eRoot,
          // Runtime evidence roots are the only built-in writable paths. The
          // reviewed suite and platform metadata remain protected during launch.
          selectedOutputPaths: [],
          protectedGitMetadataPaths: gitMetadataPaths(e2eGitState),
        },
        async () => {
          if (await captureE2eInputRevisionToken(config.e2eRoot) !== record.e2eRevisionToken) {
            throw stale("E2E 工作区在脚本审核后发生变化");
          }
          return this.automationRunner.run({
            executionId: input.executionId,
            productRoot: input.project.rootPath,
            config,
            browser,
          });
        },
      );
    } catch (error) {
      const failure = automationFailure(error);
      const copiedFailureEvidence = failure.evidence
        ? await copyExecutionEvidence(
          input.project.rootPath,
          config.e2eRoot,
          input.executionId,
          [failure.evidence],
        )
        : [];
      const effectiveExitCode = failure.testExitCode && failure.testExitCode !== 0
        ? failure.testExitCode
        : 1;
      await input.onEvent("item.completed", {
        item: {
          type: "command_execution",
          status: "failed",
          command,
          commandHash,
          exit_code: effectiveExitCode,
        },
      });
      await input.onEvent("e2e.execution.failed", {
        workingDirectory: config.e2eRoot,
        baseUrl: config.baseUrl,
        command,
        commandHash,
        exitCode: effectiveExitCode,
        testExitCode: failure.testExitCode,
        serverExitCode: failure.serverExitCode,
        serverCleanup: failure.serverCleanup,
        code: failure.code,
        stage: failure.stage,
        message: failure.message,
        descriptorHash: descriptor.descriptorHash,
        authoringExecutionId: record.executionId,
        authoringPatchHash: record.patchHash,
        productRevisionToken: record.productRevisionToken,
        e2eWorkspaceRevisionToken: record.e2eRevisionToken,
        e2eGitState,
        browser,
        scripts: record.files,
        sourceFailureEvidence: failure.evidence,
        evidence: copiedFailureEvidence,
      });
      throw error;
    }
    const copiedEvidence = await copyExecutionEvidence(
      input.project.rootPath,
      config.e2eRoot,
      input.executionId,
      result.evidence,
    );
    const effectiveExitCode = result.passed ? 0 : (result.testExitCode || 1);
    await input.onEvent("item.completed", {
      item: {
        type: "command_execution",
        status: result.passed ? "completed" : "failed",
        command,
        commandHash,
        exit_code: effectiveExitCode,
      },
    });
    await input.onEvent("e2e.execution.completed", {
      workingDirectory: config.e2eRoot,
      baseUrl: config.baseUrl,
      command,
      commandHash,
      exitCode: effectiveExitCode,
      testExitCode: result.testExitCode,
      passed: result.passed,
      serverCleanup: result.serverCleanup,
      descriptorHash: descriptor.descriptorHash,
      authoringExecutionId: record.executionId,
      authoringPatchHash: record.patchHash,
      productRevisionToken: record.productRevisionToken,
      e2eWorkspaceRevisionToken: record.e2eRevisionToken,
      e2eGitState,
      browser,
      targetProbe: result.targetProbe,
      scripts: record.files,
      evidence: copiedEvidence,
    });
    const authoring = await authoringDto(config.e2eRoot, record);
    return {
      result,
      authoring,
      e2eWorkspaceRevisionToken: record.e2eRevisionToken,
      e2eGitState,
      copiedEvidence,
      command,
      commandHash,
      prompt: executionPrompt({
        executionId: input.executionId,
        config,
        result,
        record,
        copiedEvidence,
        e2eGitState,
        command,
      }),
    };
  }
}

function authorIntent(runId: string, intent: FrozenE2eIntent): FrozenE2eSpecIntent {
  const acceptanceCriteria = intent.criteria
    .filter(({ kind }) => kind === "acceptance")
    .map(({ id, text }) => ({ id, text }));
  const regressionObligations = intent.criteria
    .filter(({ kind }) => kind === "regression")
    .map(({ id, text }) => ({ id, text }));
  const observableArtifacts = intent.authoritativeArtifacts
    .filter(({ artifactKey }) => ["prd", "user-stories", "design-spec", "architecture-nfrs"].includes(artifactKey))
    .map(({ artifactKey, id, contentHash, content }) => (
      `[${artifactKey} ${id} sha256:${contentHash}]\n${content}`
    ));
  return {
    scenarioId: `run-${runId}`,
    acceptanceCriteria,
    regressionObligations,
    observableBehavior: [
      "Author assertions from the exact criteria above and these approved observable inputs:",
      ...observableArtifacts,
    ].join("\n\n").slice(0, 8_000),
  };
}

async function assertAuthoringCurrent(
  productRoot: string,
  e2eRoot: string,
  testReportPath: string,
  record: AuthoringRecord,
): Promise<void> {
  const [productToken, e2eToken, productGitState, e2eGitState] = await Promise.all([
    productRevision(productRoot, testReportPath),
    captureE2eInputRevisionToken(e2eRoot),
    captureVerificationGitState(productRoot),
    captureVerificationGitState(e2eRoot),
  ]);
  if (
    productToken !== record.productRevisionToken
    || e2eToken !== record.e2eRevisionToken
    || stableJson(productGitState) !== stableJson(record.productGitState)
    || stableJson(e2eGitState) !== stableJson(record.e2eGitState)
  ) throw stale("产品或 E2E revision 在脚本生成后发生变化");
  await assertExactAuthoringFileSet(e2eRoot, record.files, "stale");
  for (const file of record.files) {
    const target = safeE2eAssetPath(e2eRoot, file.path);
    const content = await readFile(target).catch(() => undefined);
    if (!content || sha256(content) !== file.sha256 || content.length !== file.bytes) {
      throw stale(`E2E 脚本 ${file.path} 与待审 manifest 不一致`);
    }
  }
}

async function workspaceDto(
  project: ProjectDto,
  config: E2eWorkspaceConfig,
): Promise<E2eWorkspaceDto> {
  const descriptorPath = E2E_WORKSPACE_SIDECAR_PATH;
  const absolute = path.join(project.rootPath, ...descriptorPath.split("/"));
  await assertRuntimePath(project.rootPath, absolute);
  const [content, info] = await Promise.all([readFile(absolute), stat(absolute)]);
  return {
    version: 1,
    productProjectId: project.id,
    rootPath: config.e2eRoot,
    descriptorPath,
    baseUrl: config.baseUrl,
    packageManager: config.packageManager,
    sourceStartScript: config.sourceStartScript,
    testScript: config.testScript,
    browser: config.browser,
    playwrightVersion: config.playwrightVersion,
    descriptorHash: sha256(content),
    updatedAt: info.mtime.toISOString(),
  };
}

type TargetReadiness = E2eWorkspaceReadinessDto["target"];

function readinessDto(
  readiness: E2eWorkspaceReadiness,
  target?: TargetReadiness,
): E2eWorkspaceReadinessDto {
  const item = (component: E2eWorkspaceReadiness["workspace"]) => ({
    state: component.state === "not_checked" ? "not_checked" as const : component.state,
    message: readinessMessage(component.code),
    detail: component.detail,
  });
  return {
    ready: readiness.ready && target?.state === "ready",
    workspace: item(readiness.workspace),
    playwright: item(readiness.package),
    browser: item(readiness.browser),
    sourceStartScript: item(readiness.startScript),
    target: target ?? {
      state: "not_checked",
      message: "将在真实执行时检查应用地址",
      detail: "平台会受监督地启动产品服务，再探测 loopback 地址；预检不会留下后台服务。",
    },
    checkedAt: new Date().toISOString(),
  };
}

function assertReadyDto(readiness: E2eWorkspaceReadinessDto): void {
  if (readiness.ready) return;
  const blockers = [
    readiness.workspace,
    readiness.playwright,
    readiness.browser,
    readiness.sourceStartScript,
    readiness.target,
  ].filter(({ state }) => state !== "ready");
  throw new AppError(
    `E2E 环境预检未通过：${blockers.map(({ message }) => message).join(", ")}`,
    409,
    "E2E_PREFLIGHT_BLOCKED",
    { blockers },
  );
}

function readinessMessage(code: string): string {
  const labels: Record<string, string> = {
    E2E_WORKSPACE_READY: "独立 E2E 目录已连接",
    E2E_WORKSPACE_NOT_READY: "请先配置独立 E2E 目录",
    E2E_PACKAGE_READY: "锁定的 Playwright 已安装",
    E2E_PACKAGE_JSON_MISSING: "独立项目缺少有效 package.json",
    E2E_PACKAGE_LOCK_MISSING: "尚未生成 package-lock.json",
    E2E_PLAYWRIGHT_VERSION_UNPINNED: "Playwright 版本未按配置精确锁定",
    E2E_PLAYWRIGHT_NOT_INSTALLED: "尚未安装锁定的 Playwright",
    E2E_BROWSER_READY: "headless Chromium 启动探针通过",
    E2E_BROWSER_MISSING: "尚未安装匹配的 Chromium",
    E2E_BROWSER_LAUNCH_FAILED: "Chromium 启动失败",
    E2E_BROWSER_NOT_CHECKED: "安装 Playwright 后才能检查 Chromium",
    E2E_SOURCE_START_SCRIPT_READY: "产品启动脚本已声明",
    E2E_SOURCE_START_SCRIPT_MISSING: "产品项目缺少配置的启动脚本",
    E2E_TEST_SCRIPT_READY: "独立项目测试脚本已声明",
    E2E_TEST_SCRIPT_MISSING: "独立项目缺少 test:e2e 脚本",
    E2E_TEST_LIFECYCLE_HOOK_FORBIDDEN: "test:e2e 不允许 pre/post 生命周期钩子",
  };
  return labels[code] ?? code;
}

function assertReady(readiness: E2eWorkspaceReadiness): void {
  if (readiness.ready) return;
  const blockers = [
    readiness.workspace,
    readiness.package,
    readiness.startScript,
    readiness.testScript,
    readiness.browser,
  ].filter(({ state }) => state !== "ready");
  throw new AppError(
    `E2E 环境预检未通过：${blockers.map(({ code }) => code).join(", ")}`,
    409,
    "E2E_PREFLIGHT_BLOCKED",
    { blockers },
  );
}

async function productRevision(productRoot: string, testReportPath: string): Promise<string> {
  return (await captureVerificationWorkspaceRevision({
    projectRoot: productRoot,
    selectedOutputPaths: [path.resolve(productRoot, testReportPath)],
  })).token;
}

export async function captureE2eInputRevisionToken(e2eRoot: string): Promise<string> {
  const canonicalRoot = await realpath(e2eRoot);
  const excludedRoots = new Set([
    ".git",
    ".ai-sdlc",
    "node_modules",
    "test-results",
    "playwright-report",
    "blob-report",
    ".cache",
    "coverage",
  ]);
  const entries: Array<{
    path: string;
    kind: "directory" | "file";
    mode: number;
    bytes: number;
    sha256?: string;
  }> = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(canonicalRoot, absolute).split(path.sep).join("/");
      const topLevel = relative.split("/")[0]!;
      if (excludedRoots.has(topLevel)) continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new AppError(
          `E2E suite revision contains a symlink: ${relative}`,
          409,
          "E2E_WORKSPACE_PATH_UNSAFE",
        );
      }
      if (info.isDirectory()) {
        entries.push({ path: relative, kind: "directory", mode: info.mode, bytes: 0 });
        if (entries.length > 100_000) {
          throw new AppError("E2E suite revision exceeds its snapshot limit", 413, "E2E_WORKSPACE_TOO_LARGE");
        }
        await visit(absolute);
      } else if (info.isFile()) {
        totalBytes += info.size;
        if (totalBytes > 256 * 1024 * 1024 || entries.length >= 100_000) {
          throw new AppError("E2E suite revision exceeds its snapshot limit", 413, "E2E_WORKSPACE_TOO_LARGE");
        }
        const content = await readFile(absolute);
        entries.push({
          path: relative,
          kind: "file",
          mode: info.mode,
          bytes: content.length,
          sha256: sha256(content),
        });
      } else {
        throw new AppError(
          `E2E suite revision contains an unsupported entry: ${relative}`,
          409,
          "E2E_WORKSPACE_PATH_UNSAFE",
        );
      }
    }
  };
  await visit(canonicalRoot);
  return sha256(stableJson({ schemaVersion: 1, entries }));
}

function gitMetadataPaths(state: VerificationGitState): string[] {
  return state.kind === "not_repository" ? [] : [state.gitDirectory, state.gitCommonDirectory];
}

function authoringRecordPath(e2eRoot: string, runId: string): string {
  return path.join(e2eRoot, ".ai-sdlc", "e2e-author-reviews", `${runId}.json`);
}

async function readAuthoringRecord(e2eRoot: string, runId: string): Promise<AuthoringRecord | null> {
  const target = authoringRecordPath(e2eRoot, runId);
  try {
    await assertRuntimePath(e2eRoot, target);
    const record = authoringRecordSchema.parse(JSON.parse(await readFile(target, "utf8")));
    if (record.runId !== runId) {
      throw new AppError(
        "E2E script review record belongs to a different run",
        409,
        "E2E_AUTHORING_RECORD_INVALID",
      );
    }
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new AppError("E2E script review record is invalid", 409, "E2E_AUTHORING_RECORD_INVALID");
    }
    throw error;
  }
}

async function requireAuthoringRecord(e2eRoot: string, runId: string): Promise<AuthoringRecord> {
  const record = await readAuthoringRecord(e2eRoot, runId);
  if (!record) throw new AppError("尚未生成 E2E 脚本", 409, "E2E_AUTHORING_REQUIRED");
  return record;
}

async function writeAuthoringRecord(e2eRoot: string, record: AuthoringRecord): Promise<void> {
  const target = authoringRecordPath(e2eRoot, record.runId);
  await safeWriteJson(e2eRoot, target, record);
}

async function assertExactAuthoringFileSet(
  e2eRoot: string,
  expected: AuthoringRecord["files"],
  failureMode: "stale" | "invalid",
): Promise<void> {
  let actual: Array<{ path: string; sha256: string; bytes: number }>;
  try {
    actual = await collectE2eReviewBaseline(e2eRoot);
  } catch (error) {
    if (failureMode === "stale") {
      throw stale("E2E 完整脚本集合无法安全枚举，请重新生成并审核");
    }
    throw new AppError(
      "E2E authored assets cannot be enumerated as the complete human-review manifest",
      409,
      "E2E_AUTHORING_RECORD_INVALID",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const normalize = (files: ReadonlyArray<{ path: string; sha256: string; bytes: number }>) => (
    files
      .map(({ path: relativePath, sha256: contentHash, bytes }) => ({
        path: relativePath,
        sha256: contentHash,
        bytes,
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
  );
  if (stableJson(normalize(expected)) === stableJson(normalize(actual))) return;
  if (failureMode === "stale") {
    throw stale("E2E 完整脚本文件集合与待审 manifest 不一致");
  }
  throw new AppError(
    "E2E authored assets contradict the complete human-review manifest",
    409,
    "E2E_AUTHORING_RECORD_INVALID",
  );
}

async function authoringDto(e2eRoot: string, record: AuthoringRecord): Promise<E2eAuthoringDto> {
  await assertExactAuthoringFileSet(e2eRoot, record.files, "invalid");
  let totalBytes = 0;
  const files = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const file of record.files) {
    const target = safeE2eAssetPath(e2eRoot, file.path);
    await assertRuntimePath(e2eRoot, target);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new AppError("E2E authored asset is unsafe", 409, "E2E_AUTHORING_RECORD_INVALID");
    }
    const raw = await readFile(target);
    totalBytes += raw.length;
    if (
      raw.length !== file.bytes
      || sha256(raw) !== file.sha256
      || raw.length > MAX_E2E_AUTHORED_REVIEW_BYTES
      || totalBytes > MAX_E2E_AUTHORED_REVIEW_BYTES
      || !/^(?:tests|fixtures)\/.+\.(?:ts|js|mts|mjs|json|txt)$/u.test(file.path)
    ) {
      throw new AppError(
        "E2E authored assets exceed or contradict the complete human-review manifest",
        409,
        "E2E_AUTHORING_RECORD_INVALID",
      );
    }
    let content: string;
    try {
      content = decoder.decode(raw);
      if (content.includes("\0")) throw new TypeError("NUL byte");
    } catch {
      throw new AppError(
        "E2E authored asset is not reviewable UTF-8 text",
        409,
        "E2E_AUTHORING_RECORD_INVALID",
      );
    }
    files.push({ ...file, content });
  }
  return {
    runId: record.runId,
    executionId: record.executionId,
    status: record.status,
    patchHash: record.patchHash,
    productRevisionToken: record.productRevisionToken,
    e2eRevisionToken: record.e2eRevisionToken,
    criterionIds: record.criterionIds,
    files,
    reviewComment: record.reviewComment,
    reviewedAt: record.reviewedAt,
    createdAt: record.createdAt,
  };
}

function safeE2eAssetPath(e2eRoot: string, relativePath: string): string {
  if (
    path.isAbsolute(relativePath)
    || relativePath.includes("\\")
    || relativePath.split("/").some((component) => !component || component === "." || component === "..")
    || !/^(?:tests|fixtures)\//u.test(relativePath)
  ) throw new AppError("E2E asset path is unsafe", 409, "E2E_AUTHORING_RECORD_INVALID");
  return path.join(e2eRoot, ...relativePath.split("/"));
}

function automationFailure(error: unknown): {
  code: string;
  stage: string;
  message: string;
  testExitCode: number | null;
  serverExitCode: number | null;
  serverCleanup: "already_exited" | "sigterm" | "sigkill" | null;
  evidence: E2eExecutionFailureEvidence | null;
} {
  const details = error instanceof AppError
    && error.details !== null
    && typeof error.details === "object"
    && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : {};
  const candidate = details.failureEvidence;
  const evidence = candidate !== null
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && typeof (candidate as Record<string, unknown>).path === "string"
    && /^(?:test-results|playwright-report|blob-report)\//u.test(
      (candidate as Record<string, unknown>).path as string,
    )
    && typeof (candidate as Record<string, unknown>).sha256 === "string"
    && /^[a-f0-9]{64}$/u.test((candidate as Record<string, unknown>).sha256 as string)
    && Number.isInteger((candidate as Record<string, unknown>).bytes)
    && ((candidate as Record<string, unknown>).bytes as number) >= 0
    ? candidate as E2eExecutionFailureEvidence
    : null;
  return {
    code: (error instanceof AppError ? error.code : "E2E_EXECUTION_FAILED").slice(0, 160),
    stage: (typeof details.stage === "string" ? details.stage : "execution").slice(0, 160),
    message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
    testExitCode: Number.isInteger(details.testExitCode) ? details.testExitCode as number : null,
    serverExitCode: Number.isInteger(details.serverExitCode) ? details.serverExitCode as number : null,
    serverCleanup: ["already_exited", "sigterm", "sigkill"].includes(String(details.serverCleanup))
      ? details.serverCleanup as "already_exited" | "sigterm" | "sigkill"
      : null,
    evidence,
  };
}

async function copyExecutionEvidence(
  productRoot: string,
  e2eRoot: string,
  executionId: string,
  evidence: ReadonlyArray<{ path: string; sha256: string; bytes: number }>,
): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  const copied = [];
  for (const item of evidence) {
    if (
      path.isAbsolute(item.path)
      || item.path.includes("\\")
      || item.path.split("/").some((component) => !component || component === "." || component === "..")
      || !/^(?:test-results|playwright-report|blob-report)\//u.test(item.path)
    ) throw new AppError("E2E evidence path is unsafe", 409, "E2E_EVIDENCE_PATH_UNSAFE");
    const source = path.join(e2eRoot, ...item.path.split("/"));
    const sourceInfo = await lstat(source);
    const sourceCanonical = await realpath(source);
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile() || !isWithin(e2eRoot, sourceCanonical)) {
      throw new AppError("E2E evidence source is unsafe", 409, "E2E_EVIDENCE_PATH_UNSAFE");
    }
    const content = await readFile(source);
    if (sha256(content) !== item.sha256 || content.length !== item.bytes) {
      throw new AppError("E2E evidence changed before collection", 409, "E2E_EVIDENCE_STALE");
    }
    const relative = path.posix.join("test-results", "ai-sdlc", executionId, item.path);
    const target = path.join(productRoot, ...relative.split("/"));
    await assertRuntimePath(productRoot, path.dirname(target));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: "wx", mode: 0o600 });
    copied.push({ path: relative, sha256: item.sha256, bytes: item.bytes });
  }
  return copied;
}

async function safeWriteJson(root: string, target: string, value: unknown): Promise<void> {
  if (!isWithin(root, target) || target === root) {
    throw new AppError("E2E metadata path escaped root", 400, "E2E_WORKSPACE_PATH_UNSAFE");
  }
  await assertRuntimePath(root, target);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function authoringReport(executionId: string, record: AuthoringRecord): string {
  return [
    "# Test Report",
    "",
    "## Status and recommendation",
    "",
    "- Verification state: Blocked",
    `- Platform execution ID: ${executionId}`,
    `- Current revision: workspace sha256:${record.productRevisionToken}; platform execution ${executionId}`,
    "- Recommendation: Review the generated E2E scripts before any browser execution.",
    "",
    "## E2E Stage 2: Crystallization",
    "",
    "- E2E script required: yes — linked-workspace script was generated from approved intent.",
    "- Isolation tier: B — fresh ephemeral spec-only Test Author subprocess; host-level source unreadability is not claimed.",
    `- Script manifest SHA-256: ${record.patchHash}`,
    "- Script review: Pending human review; generated executable code has not run.",
    ...record.files.map((file) => `- ${file.path} — sha256:${file.sha256}`),
    "",
    "## E2E Stage 3: Execution",
    "",
    "| Execution | Exact command and working directory | Revision and environment | Result | Durable evidence |",
    "|---|---|---|---|---|",
    "| Linked E2E | N/A | N/A | Blocked — script review pending | N/A |",
    "",
    "## Coverage gaps",
    "",
    "- Blocked: generated E2E scripts require exact manifest-hash approval before execution.",
    "",
    "## Failure classification and routing",
    "",
    "| ID | Classification | Evidence | Owner | Action | Status |",
    "|---|---|---|---|---|---|",
    "| E2E-SCRIPT-REVIEW | environment/CI issue | linked script manifest | Human reviewer | Review exact generated files | open |",
    "",
  ].join("\n");
}

function executionPrompt(input: {
  executionId: string;
  config: E2eWorkspaceConfig;
  result: E2eExecutionResult;
  record: AuthoringRecord;
  copiedEvidence: Array<{ path: string; sha256: string; bytes: number }>;
  e2eGitState: VerificationGitState;
  command: string;
}): string {
  const gitBinding = input.e2eGitState.kind === "head"
    ? `e2e git HEAD ${input.e2eGitState.head}`
    : input.e2eGitState.kind === "unborn"
      ? `e2e git unborn ${input.e2eGitState.symbolicHead}`
      : "e2e git state:not-repository";
  return [
    "[Platform Linked E2E execution evidence — machine-owned]",
    `- Platform execution ID: ${input.executionId}`,
    `- Approved script manifest SHA-256: ${input.record.patchHash}`,
    `- Product workspace sha256: ${input.record.productRevisionToken}`,
    `- E2E workspace sha256: ${input.record.e2eRevisionToken}`,
    `- E2E Git binding: ${gitBinding}`,
    `- Browser: Chromium ${input.result.browser.version} at ${input.result.browser.executablePath}`,
    `- Browser target probe: ${input.result.targetProbe.url}; HTTP ${input.result.targetProbe.status}; ${input.result.targetProbe.browserVersion}`,
    `- Source server cleanup: ${input.result.serverCleanup}`,
    `- Exact command cell: \`${input.command}\` from \`${input.config.e2eRoot}\``,
    `- Result: ${input.result.passed ? "Pass" : "Fail"}; effective exit ${input.result.passed ? 0 : (input.result.testExitCode || 1)}; raw Playwright exit ${input.result.testExitCode}`,
    "- Durable copied evidence:",
    ...input.copiedEvidence.map((file) => `  - ${file.path} sha256:${file.sha256}`),
    "- Approved scripts:",
    ...input.record.files.map((file) => `  - ${file.path} sha256:${file.sha256}`),
    "",
    "Use these exact machine facts in test-report. Do not rerun Playwright, substitute MCP, invent a pass, or rewrite scripts. Current revision must include both the product workspace token/platform execution binding already supplied by the Verification envelope and the exact E2E workspace/Git bindings above. A nonzero E2E exit remains Failed/Blocked.",
  ].join("\n");
}

function stale(message: string): AppError {
  return new AppError(message, 409, "E2E_SCRIPT_APPROVAL_STALE");
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
