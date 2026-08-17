import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  type CreateArtifactRevisionInput,
  type CreateProjectInput,
  type CreateRunInput,
  type ExecutePhaseInput,
  type FigmaIntegrationStatusDto,
  type FigmaPlanCapabilitiesDto,
  type FigmaTarget,
  type PhaseId,
  type ReviewPhaseInput,
  type WorkflowDefinition
} from "@ai-sdlc/contracts";

import type { PgWorkflowStore, RunBundle } from "../db/store.js";
import { AppError } from "../domain/errors.js";
import {
  pinExistingTaskArtifactPaths,
  resolveTaskArtifactPaths,
} from "../domain/task-artifact-paths.js";
import { parseUserStoryTickets } from "../domain/user-story-tickets.js";
import { requiredSelectionKeys, resolveOutputSelection, validateArtifactSelection } from "../domain/workflow.js";
import { CodexTerminalRunner, type ResolvedFigmaTarget } from "./codex-runner.js";
import { CodexExecutionCapabilities } from "./codex-execution-capabilities.js";
import { prepareArtifactRevision } from "./artifact-workspace.js";
import { loadDefinition, type LoadedDefinition } from "./definition-loader.js";
import type { FigmaMcpIntegration } from "./figma-mcp-integration.js";
import { initializeCodexProject } from "./project-initializer.js";
import { ProjectPathPolicy } from "./project-paths.js";

export class WorkflowService {
  private readonly tasks = new Set<Promise<void>>();
  private readonly artifactRevisionLocks = new Map<string, Promise<void>>();
  private readonly activeWorkspaceMutations = new Set<string>();

  constructor(
    private readonly store: PgWorkflowStore,
    private readonly paths: ProjectPathPolicy,
    private readonly runner: CodexTerminalRunner,
    private readonly cliPath?: string,
    private readonly figmaIntegration?: FigmaMcpIntegration,
    private readonly codexCapabilities?: CodexExecutionCapabilities
  ) {}

  async listProjects() {
    return this.store.listProjects();
  }

  async createProject(input: CreateProjectInput) {
    const summary = input.summary || "由 AI SDLC 平台管理的项目";
    let rootPath = await this.paths.resolveProjectPath(input.rootPath, input.initialize);
    if (input.initialize) {
      await initializeCodexProject(rootPath, input.name, summary, {
        cliPath: this.cliPath
      });
      rootPath = await this.paths.resolveProjectPath(rootPath);
    }
    const definition = await loadDefinition(rootPath);
    const project = await this.store.createProject({
      name: input.name,
      summary: summary || definition.project.summary,
      rootPath,
      configPath: definition.configPath
    });
    return { project, definition: publicDefinition(definition) };
  }

  async getProject(projectId: string) {
    const project = await this.store.getProject(projectId);
    await this.assertProjectPath(project.rootPath);
    const definition = await loadDefinition(project.rootPath);
    return { project, definition: publicDefinition(definition) };
  }

  async listRuns(projectId: string) {
    return this.store.listRuns(projectId);
  }

  async createRun(projectId: string, input: CreateRunInput) {
    const project = await this.store.getProject(projectId);
    await this.assertProjectPath(project.rootPath);
    const definition = await loadDefinition(project.rootPath);
    const runId = randomUUID();
    const resolved = resolveTaskArtifactPaths(definition, { id: runId, title: input.title });
    const designSpec = resolved.artifacts.find((artifact) => artifact.id === "design-spec");
    if (!designSpec) {
      throw new AppError("项目没有注册 design-spec 产物", 400, "CONFIG_INVALID");
    }
    return this.store.createRun(projectId, input.title, input.objective, {
      runId,
      artifactPaths: { "design-spec": designSpec.relativePath },
    });
  }

  async getRun(runId: string) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    const definition = taskDefinition(bundle, await loadDefinition(bundle.project.rootPath));
    attachAvailableArtifacts(bundle, definition);
    const { artifactPaths: _internalArtifactPaths, ...publicBundle } = bundle;
    return { ...publicBundle, definition: publicDefinition(definition) };
  }

  async executePhase(runId: string, phaseId: PhaseId, input: ExecutePhaseInput) {
    if (new Set(input.selectedArtifactIds).size !== input.selectedArtifactIds.length) {
      throw new AppError("selectedArtifactIds 不能重复", 400, "DUPLICATE_ARTIFACT_SELECTION");
    }
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    const releaseWorkspace = this.acquireWorkspaceMutation(bundle.project.rootPath);
    try {
    const definition = taskDefinition(bundle, await loadDefinition(bundle.project.rootPath));
    const phaseDefinition = definition.phases.find((phase) => phase.id === phaseId);
    if (!phaseDefinition) throw new AppError("阶段不在工作流定义中", 404, "PHASE_NOT_FOUND");
    const currentPhase = bundle.phases.find((phase) => phase.phaseId === phaseId);
    if (!currentPhase) throw new AppError("阶段运行不存在", 404, "PHASE_NOT_FOUND");
    const selectedOutputKeys = resolveOutputSelection(
      phaseId,
      phaseDefinition.outputs,
      input.selectedOutputKeys,
      currentPhase.artifacts.map((artifact) => artifact.artifactKey),
    );
    let figmaTarget: ResolvedFigmaTarget | undefined;
    if (selectedOutputKeys.includes("figma-handoff")) {
      const requestedFigmaTarget = requireFigmaTarget(input.figmaTarget);
      if (this.runner.mode() !== "real") {
        throw new AppError(
          "Figma 产物只能使用真实 Codex Runner 执行",
          409,
          "FIGMA_REQUIRES_REAL_RUNNER"
        );
      }
      if (requestedFigmaTarget.mode === "new_private_draft") {
        const capabilities = await this.resolveFigmaPlans(bundle.project.rootPath, { force: true });
        figmaTarget = resolveNewPrivateDraftTarget(requestedFigmaTarget, capabilities);
      } else {
        figmaTarget = resolveExistingFigmaTarget(requestedFigmaTarget);
        await this.assertFigmaReady(bundle.project.rootPath, { force: true });
      }
    } else if (input.figmaTarget) {
      throw new AppError(
        "只有选择 figma-handoff 产物时才能指定 Figma 目标",
        400,
        "FIGMA_TARGET_WITHOUT_OUTPUT"
      );
    }
    if (this.runner.mode() === "real" && !this.codexCapabilities) {
      throw new AppError("Codex 执行能力服务未配置", 503, "CODEX_CAPABILITIES_UNAVAILABLE");
    }
    const executionConfig = this.runner.mode() === "real"
      ? await this.codexCapabilities!.resolve(bundle.project.rootPath, input)
      : null;
    const selected = await this.store.selectionArtifacts(runId, input.selectedArtifactIds);
    validateArtifactSelection(
      phaseId,
      requiredSelectionKeys(phaseId, phaseDefinition.inputs),
      selected.map((artifact) => ({
        id: artifact.id,
        artifactKey: artifact.artifactKey,
        sourcePosition: artifact.sourcePosition,
        sourceStatus: artifact.sourceStatus,
        reviewStatus: artifact.reviewStatus
      }))
    );
    const currentArtifacts = await this.store.currentArtifactSnapshotsForPhase(runId, phaseId);
    const execution = await this.store.createExecution(
      runId,
      phaseId,
      input.selectedArtifactIds,
      selectedOutputKeys,
      this.runner.mode(),
      executionConfig?.model ?? null,
      executionConfig?.reasoningEffort ?? null,
      this.runner.commandLabel(executionConfig ?? undefined)
    );

    const task = this.performExecution({
      executionId: execution.id,
      project: bundle.project,
      run: bundle.run,
      phase: phaseDefinition,
      definition,
      selectedArtifacts: selected,
      currentArtifacts,
      revisionFeedback: currentPhase.reviews
        .filter((review) => review.decision === "request_changes")
        .slice(0, 5)
        .map((review) => review.comment),
      selectedOutputKeys,
      model: executionConfig?.model ?? null,
      reasoningEffort: executionConfig?.reasoningEffort ?? null,
      figmaTarget
    }).finally(releaseWorkspace);
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return execution;
    } catch (error) {
      releaseWorkspace();
      throw error;
    }
  }

  async reviewPhase(runId: string, phaseId: PhaseId, input: ReviewPhaseInput) {
    const current = await this.store.getRun(runId);
    await this.assertProjectPath(current.project.rootPath);
    const review = await this.store.reviewPhase(
      runId,
      phaseId,
      input.decision,
      input.comment,
      input.expectedArtifactIds,
    );
    const detail = await this.getRun(runId);
    return { review, run: detail.run, phases: detail.phases };
  }

  async getArtifact(artifactId: string) {
    return this.store.getArtifact(artifactId);
  }

  async createArtifactRevision(artifactId: string, input: CreateArtifactRevisionInput) {
    if (Buffer.byteLength(input.content, "utf8") > 2_000_000) {
      throw new AppError("产物超过 2000000 字节限制", 413, "ARTIFACT_TOO_LARGE");
    }
    const workspace = await this.store.artifactWorkspace(artifactId);
    await this.assertProjectPath(workspace.rootPath);
    const releaseWorkspace = this.acquireWorkspaceMutation(workspace.rootPath);
    try {
    const initial = await this.store.getArtifact(artifactId);
    const absolutePath = path.resolve(workspace.rootPath, initial.filePath);
    const lockKey = `${workspace.rootPath}\0${absolutePath}`;
    return await this.withArtifactRevisionLock(lockKey, async () => {
      const current = await this.store.getArtifact(artifactId);
      if (
        current.reviewStatus === "superseded"
        || current.contentHash !== input.expectedContentHash
      ) {
        throw new AppError(
          "该产物版本已发生变化，请刷新后重试",
          409,
          "ARTIFACT_REVISION_CONFLICT",
          { artifactId, currentContentHash: current.contentHash },
        );
      }
      const prepared = await prepareArtifactRevision({
        projectRoot: workspace.rootPath,
        absolutePath,
        previousContentHash: current.contentHash,
        nextContent: input.content,
        maxBytes: 2_000_000,
      });
      try {
        const tickets = current.artifactKey === "user-stories"
          ? ticketRecords(current.filePath, prepared.content)
          : undefined;
        const artifact = await this.store.createHumanArtifactRevision(
          artifactId,
          input.expectedContentHash,
          prepared.content,
          prepared.contentHash,
          tickets,
        );
        await prepared.commit();
        return artifact;
      } catch (error) {
        try {
          await prepared.rollback();
        } catch (rollbackError) {
          throw new AppError(
            "人工版本未能保存，且项目文件回滚失败",
            500,
            "ARTIFACT_WORKSPACE_ROLLBACK_FAILED",
            {
              saveError: error instanceof Error ? error.message : String(error),
              rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            },
          );
        }
        throw error;
      }
    });
    } finally {
      releaseWorkspace();
    }
  }

  async getFigmaIntegration(runId: string, options: { force?: boolean } = {}) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    return this.figmaIntegration?.status(bundle.project.rootPath, options);
  }

  async getFigmaPlans(runId: string, options: { force?: boolean } = {}) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    return this.resolveFigmaPlans(bundle.project.rootPath, options);
  }

  async getCodexCapabilities(runId: string) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    if (!this.codexCapabilities) {
      throw new AppError("Codex 执行能力服务未配置", 503, "CODEX_CAPABILITIES_UNAVAILABLE");
    }
    return this.codexCapabilities.status(bundle.project.rootPath);
  }

  async listTickets(runId: string) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    return this.ensureTicketsFromLatestArtifact(runId);
  }

  async getTicket(runId: string, ticketId: string) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    await this.ensureTicketsFromLatestArtifact(runId);
    return this.store.getTicket(runId, ticketId);
  }

  async updateTicketStatus(runId: string, ticketId: string, status: Parameters<PgWorkflowStore["updateTicketStatus"]>[2]) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    await this.ensureTicketsFromLatestArtifact(runId);
    return this.store.updateTicketStatus(runId, ticketId, status);
  }

  async getExecutionEvents(executionId: string) {
    return this.store.eventsForExecution(executionId);
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
  }

  private async withArtifactRevisionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.artifactRevisionLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.artifactRevisionLocks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.artifactRevisionLocks.get(key) === tail) {
        this.artifactRevisionLocks.delete(key);
      }
    }
  }

  private acquireWorkspaceMutation(projectRoot: string): () => void {
    if (this.activeWorkspaceMutations.has(projectRoot)) {
      throw new AppError(
        "该项目工作区正在执行或保存另一项产物变更，请稍后重试",
        409,
        "PROJECT_WORKSPACE_BUSY",
      );
    }
    this.activeWorkspaceMutations.add(projectRoot);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeWorkspaceMutations.delete(projectRoot);
    };
  }

  private async assertFigmaReady(
    projectRoot: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (!this.figmaIntegration) {
      throw new AppError(
        "Figma 集成服务未配置",
        503,
        "FIGMA_UNAVAILABLE"
      );
    }
    let status;
    try {
      status = await this.figmaIntegration.status(projectRoot, options);
    } catch {
      throw new AppError(
        "暂时无法检测 Figma 授权，请稍后重试",
        503,
        "FIGMA_UNAVAILABLE"
      );
    }
    if (status.state !== "ready") throw figmaStatusError(status);
  }

  private async resolveFigmaPlans(
    projectRoot: string,
    options: { force?: boolean } = {},
  ): Promise<FigmaPlanCapabilitiesDto> {
    if (!this.figmaIntegration) {
      throw new AppError("Figma 集成服务未配置", 503, "FIGMA_UNAVAILABLE");
    }
    let status;
    try {
      status = await this.figmaIntegration.status(projectRoot, options);
    } catch {
      throw new AppError(
        "暂时无法检测 Figma 授权，请稍后重试",
        503,
        "FIGMA_UNAVAILABLE"
      );
    }
    if (status.state !== "ready") throw figmaStatusError(status);
    try {
      return await this.figmaIntegration.plans(projectRoot, options);
    } catch {
      throw new AppError(
        "Figma 已授权，但暂时无法读取可用计划，请重新检测",
        503,
        "FIGMA_PLAN_DISCOVERY_FAILED"
      );
    }
  }

  private async assertProjectPath(storedRootPath: string): Promise<void> {
    const canonical = await this.paths.resolveProjectPath(storedRootPath);
    if (canonical !== storedRootPath) {
      throw new AppError("项目目录的真实路径已变化，请重新注册", 409, "PROJECT_PATH_CHANGED");
    }
  }

  private async performExecution(request: Parameters<CodexTerminalRunner["run"]>[0]): Promise<void> {
    let sequence = 0;
    const event = async (eventType: string, payload: unknown) => {
      sequence += 1;
      await this.store.appendEvent(request.executionId, sequence, eventType, payload);
    };
    try {
      const result = await this.runner.run(request, event);
      const storyArtifact = result.artifacts.find((artifact) => artifact.artifactKey === "user-stories");
      const ticketSync = storyArtifact
        ? {
            artifactKey: storyArtifact.artifactKey,
            tickets: ticketRecords(storyArtifact.filePath, storyArtifact.content)
          }
        : undefined;
      await this.store.completeExecution(
        request.executionId,
        result.exitCode,
        result.artifacts,
        ticketSync
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await event("runner.failed", { message });
      } finally {
        await this.store.failExecution(
          request.executionId,
          error instanceof AppError && typeof (error.details as { exitCode?: unknown })?.exitCode === "number"
            ? (error.details as { exitCode: number }).exitCode
            : null,
          message
        );
      }
    }
  }

  private async ensureTicketsFromLatestArtifact(runId: string) {
    const existing = await this.store.listTickets(runId);
    if (existing.length > 0) return existing;
    const artifact = await this.store.latestUserStoriesArtifact(runId);
    if (!artifact) return existing;
    const tickets = ticketRecords(artifact.filePath, artifact.content);
    await this.store.syncTickets(runId, artifact.id, tickets);
    return this.store.listTickets(runId);
  }
}

function ticketRecords(artifactPath: string, content: string) {
  const basePath = artifactPath.replaceAll("\\", "/").replace(/\/+$/u, "");
  return parseUserStoryTickets(content).map((ticket) => ({
    ...ticket,
    sourcePath: [basePath, ticket.sourcePath].filter(Boolean).join("/")
  }));
}

function publicDefinition(definition: LoadedDefinition): WorkflowDefinition {
  return {
    version: definition.version,
    project: definition.project,
    roles: definition.roles,
    phases: definition.phases
  };
}

function taskDefinition(bundle: RunBundle, definition: LoadedDefinition): LoadedDefinition {
  const persistedDesignSpecPath = bundle.artifactPaths["design-spec"];
  const persistedDesignSpec = persistedDesignSpecPath
    ? [{ artifactKey: "design-spec", filePath: persistedDesignSpecPath }]
    : [];
  const existingHeads = bundle.phases.flatMap((phase) => phase.artifacts);
  return pinExistingTaskArtifactPaths(
    resolveTaskArtifactPaths(definition, bundle.run),
    bundle.project.rootPath,
    persistedDesignSpec.length > 0 ? persistedDesignSpec : existingHeads,
  );
}

function attachAvailableArtifacts(bundle: RunBundle, definition: LoadedDefinition): void {
  for (const phase of bundle.phases) {
    const acceptedKeys = new Set(definition.phases.find((item) => item.id === phase.phaseId)?.inputs ?? []);
    phase.availableArtifacts = bundle.phases
      .filter((candidate) => candidate.position < phase.position && candidate.status === "approved")
      .flatMap((candidate) => candidate.artifacts)
      .filter((artifact) => artifact.reviewStatus === "approved" && acceptedKeys.has(artifact.artifactKey));
  }
}

function figmaStatusError(status: FigmaIntegrationStatusDto): AppError {
  const code = status.state === "not_configured"
    ? "FIGMA_NOT_CONFIGURED"
    : status.state === "authorization_required"
      ? "FIGMA_AUTH_REQUIRED"
      : "FIGMA_UNAVAILABLE";
  return new AppError(status.message, 409, code, status);
}

export function requireFigmaTarget(target: FigmaTarget | undefined): FigmaTarget {
  if (!target) {
    throw new AppError(
      "请先选择新建私人 Draft 或指定已有 Figma 文件",
      400,
      "FIGMA_TARGET_REQUIRED"
    );
  }
  return target;
}

export function resolveNewPrivateDraftTarget(
  target: Extract<FigmaTarget, { mode: "new_private_draft" }>,
  capabilities: FigmaPlanCapabilitiesDto,
): ResolvedFigmaTarget {
  const selectedPlan = capabilities.plans.find((plan) => plan.key === target.planKey);
  if (!selectedPlan) {
    throw new AppError(
      "选择的 Figma 计划已不存在或已变更，请重新选择",
      409,
      "FIGMA_PLAN_NOT_AVAILABLE"
    );
  }
  if (!selectedPlan.writable) {
    throw new AppError(
      "选择的 Figma 计划是只读 seat，不能创建私人 Draft",
      409,
      "FIGMA_PLAN_READ_ONLY"
    );
  }
  return {
    mode: "new_private_draft",
    planKey: selectedPlan.key,
    fileName: target.fileName,
  };
}

export function resolveExistingFigmaTarget(
  target: Extract<FigmaTarget, { mode: "existing_file" }>,
): ResolvedFigmaTarget {
  let parsed: URL;
  try {
    parsed = new URL(target.fileUrl);
  } catch {
    throw invalidFigmaFileUrl();
  }
  if (
    parsed.protocol !== "https:" ||
    !["figma.com", "www.figma.com"].includes(parsed.hostname) ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    /%2f|%5c/iu.test(parsed.pathname)
  ) {
    throw invalidFigmaFileUrl();
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const kind = segments[0];
  const fileKey = segments[1];
  if (
    !["design", "file"].includes(kind ?? "") ||
    typeof fileKey !== "string" ||
    !/^[a-zA-Z0-9_-]{2,256}$/u.test(fileKey) ||
    segments.slice(2).some((segment) => {
      try {
        return decodeURIComponent(segment).toLowerCase() === "branch";
      } catch {
        return true;
      }
    })
  ) {
    throw invalidFigmaFileUrl();
  }
  const nodeIds = parsed.searchParams.getAll("node-id");
  if (
    nodeIds.length > 1 ||
    (nodeIds[0] !== undefined && !/^\d+(?:-|:)\d+$/u.test(nodeIds[0]))
  ) {
    throw invalidFigmaFileUrl();
  }
  const canonical = new URL(`https://www.figma.com/${kind}/${fileKey}`);
  if (nodeIds[0]) canonical.searchParams.set("node-id", nodeIds[0]);
  return {
    mode: "existing_file",
    fileUrl: canonical.toString(),
    fileKey,
    ...(nodeIds[0] ? { nodeId: nodeIds[0].replace("-", ":") } : {}),
  };
}

function invalidFigmaFileUrl(): AppError {
  return new AppError(
    "请输入官方 Figma Design 文件链接（https://figma.com/design/... 或 /file/...）",
    400,
    "FIGMA_FILE_URL_INVALID"
  );
}
