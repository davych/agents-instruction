import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type {
  AgentSandboxDto,
  GitRevision,
  KnowledgeSnapshotDto,
  PublicProjectDto,
  RemoteGitCreateProjectInput,
} from "@ai-sdlc/contracts";

import {
  type ManagedWorkspaceRecord,
  PgWorkflowStore,
  type RepositoryOperationInput,
  type RuntimeProject,
  publicKnowledgeSnapshotFromRecord,
  publicProjectFromRuntime,
} from "../db/store.js";
import { AppError } from "../domain/errors.js";
import { DeepWikiLiteIndexer } from "./deepwiki-lite.js";
import { type LoadedDefinition, loadDefinition } from "./definition-loader.js";
import { verifyManagedWorkspaceRoot } from "./cloud-startup-preflight.js";
import { GitBroker } from "./git-broker.js";
import { GitCredentialRegistry } from "./git-credential-registry.js";
import { initializeCodexProject } from "./project-initializer.js";
import { RepositoryPolicy } from "./repository-policy.js";

const operationMessages = Object.freeze({
  validating: "正在检查仓库地址、ref 和访问方式",
  fetching: "正在安全拉取仓库",
  resolving: "正在固定源码 revision",
  materializing: "正在建立不可变项目快照",
  indexing: "正在建立 DeepWiki Lite 项目知识",
  publishing: "正在发布新的项目快照",
});

export interface CloudProjectServiceOptions {
  store: PgWorkflowStore;
  managedRoot: string;
  repositoryPolicy: RepositoryPolicy;
  credentials: GitCredentialRegistry;
  gitBroker: GitBroker;
  deepWiki?: DeepWikiLiteIndexer;
  cliPath?: string;
}

export interface PreparedRunWorkspace {
  workspace: ManagedWorkspaceRecord;
  project: RuntimeProject;
  baseRevision: GitRevision;
  definitionVersion: string;
}

export interface PreparedAgentSandbox extends PreparedRunWorkspace {
  sandbox: AgentSandboxDto;
}

export interface WorkspacePruneResult {
  dryRun: boolean;
  candidates: number;
  removed: number;
  retained: number;
  failed: number;
  moreAvailable: boolean;
}

/**
 * Trusted coordinator for the Cloud boundary. Git credentials are consumed here
 * and never cross into the phase Worker. All returned browser DTOs are produced
 * by presentProject(), which intentionally cannot serialize host paths.
 */
export class CloudProjectService {
  private readonly tasks = new Set<Promise<void>>();
  private readonly repositoryTasks = new Map<string, Promise<void>>();
  private readonly activeOperations = new Set<string>();
  private readonly activeRunPreparations = new Set<string>();
  private readonly activeSandboxPreparations = new Set<string>();
  private readonly activeSandboxWorkspaceIds = new Set<string>();
  private readonly store: PgWorkflowStore;
  private readonly policy: RepositoryPolicy;
  private readonly credentials: GitCredentialRegistry;
  private readonly git: GitBroker;
  private readonly deepWiki: DeepWikiLiteIndexer;
  private readonly layout: ManagedWorkspaceLayout;
  private readonly cliPath?: string;

  private constructor(options: CloudProjectServiceOptions, layout: ManagedWorkspaceLayout) {
    this.store = options.store;
    this.policy = options.repositoryPolicy;
    this.credentials = options.credentials;
    this.git = options.gitBroker;
    this.deepWiki = options.deepWiki ?? new DeepWikiLiteIndexer();
    this.layout = layout;
    this.cliPath = options.cliPath;
  }

  static async create(options: CloudProjectServiceOptions): Promise<CloudProjectService> {
    const layout = await ManagedWorkspaceLayout.create(options.managedRoot);
    return new CloudProjectService(options, layout);
  }

  managedRoot(): string {
    return this.layout.root;
  }

  credentialSummaries(host?: string) {
    return this.credentials.summaries(host);
  }

  async createRemoteProject(
    input: RemoteGitCreateProjectInput,
    signal?: AbortSignal,
  ): Promise<{ project: PublicProjectDto; definition: LoadedDefinition }> {
    const validated = await this.policy.validate(
      input.repositoryUrl,
      input.requestedRef,
      signal,
    );
    // Resolve once before committing the Project so an unknown, unavailable, or
    // cross-origin credential profile fails as a request error, not a background task.
    this.credentials.resolve(input.credentialProfileId, validated);

    const projectId = randomUUID();
    const operation = operationState("import", "queued", "validating", 0);
    const controlRoot = this.layout.controlRoot(projectId);
    const pendingSourceRoot = this.layout.pendingSourceRoot(projectId);
    const configPath = path.join(controlRoot, "ai-native.yaml");
    let persisted = false;
    try {
      await mkdir(pendingSourceRoot, { recursive: true, mode: 0o700 });
      await initializeCodexProject(
        controlRoot,
        input.name,
        input.summary || "由 AI SDLC Cloud 管理的项目",
        { agentClient: "codex", cliPath: this.cliPath, signal },
      );
      const definition = await loadDefinition({
        sourceRoot: pendingSourceRoot,
        controlRoot,
        configPath,
      });
      const definitionVersion = await computeControlPackVersion(controlRoot);
      const runtime = await this.store.createRemoteProject({
        id: projectId,
        name: input.name,
        summary: input.summary || definition.project.summary,
        rootPath: pendingSourceRoot,
        configPath,
        repositoryUrl: validated.url,
        repositoryHost: validated.host,
        requestedRef: validated.requestedRef,
        credentialProfileId: input.credentialProfileId,
        definitionVersion,
        operation,
      });
      persisted = true;
      this.enqueueRepositoryOperation(runtime.id, operation);
      return { project: await this.presentProject(runtime), definition };
    } catch (error) {
      if (!persisted) {
        await this.layout.removeProject(projectId).catch(() => undefined);
        // Initializer/import failures can contain CLI paths, environment values
        // or raw tool output. Repository policy and Credential errors happen
        // before this block; everything here crosses the browser boundary only
        // through one fixed public failure.
        throw new AppError(
          "平台无法准备项目 Control Pack，请检查服务端配置后重试",
          500,
          "CONTROL_PACK_INITIALIZATION_FAILED",
        );
      }
      throw error;
    }
  }

  async syncProject(
    projectId: string,
    expectedRevision?: GitRevision,
    signal?: AbortSignal,
  ): Promise<PublicProjectDto> {
    const project = await this.store.getProject(projectId);
    this.assertRemoteProject(project);
    if (project.operation && project.operation.state !== "failed") {
      throw new AppError(
        "仓库导入或同步已经在进行中",
        409,
        "REPOSITORY_OPERATION_IN_PROGRESS",
      );
    }
    if (expectedRevision && expectedRevision !== project.currentRevision) {
      throw new AppError(
        "项目 revision 已变化，请刷新后重试",
        409,
        "REPOSITORY_REVISION_MISMATCH",
      );
    }
    const validated = await this.policy.validate(
      project.repositoryUrl!,
      project.requestedRef ?? "HEAD",
      signal,
    );
    this.credentials.resolve(project.credentialProfileId, validated);
    const kind = project.currentRevision ? "sync" : "import";
    const operation = operationState(kind, "queued", "validating", 0);
    const queued = await this.store.updateRepositoryOperation(projectId, operation);
    this.enqueueRepositoryOperation(projectId, operation);
    return this.presentProject(queued);
  }

  async resumeInterruptedOperations(): Promise<void> {
    const projects = await this.store.listProjects();
    for (const project of projects) {
      if (project.sourceKind !== "remote-git" || !project.operation) continue;
      if (project.operation.state === "failed") continue;
      this.enqueueRepositoryOperation(project.id, project.operation);
    }
  }

  async waitForProjectReady(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<PublicProjectDto> {
    const task = this.repositoryTasks.get(projectId);
    if (task) await waitForOperation(task, signal);
    const project = await this.store.getProject(projectId);
    if (project.repositoryState !== "ready" || !project.currentRevision) {
      throw new AppError(
        project.repositoryErrorMessage || "仓库绑定失败，请检查地址、ref 与授权后重试",
        422,
        "REPOSITORY_BINDING_FAILED",
      );
    }
    return this.presentProject(project);
  }

  async listProjects(): Promise<PublicProjectDto[]> {
    const remoteProjects = (await this.store.listProjects()).filter(
      (project) => project.sourceKind === "remote-git",
    );
    return Promise.all(remoteProjects.map((project) => this.presentProject(project)));
  }

  async presentProject(project: RuntimeProject): Promise<PublicProjectDto> {
    const knowledge = project.sourceKind === "remote-git"
      ? await this.store.getActiveKnowledgeSnapshot(project.id)
      : null;
    const credentialProfile = project.credentialProfileId
      ? this.credentials.summary(project.credentialProfileId)
      : null;
    return publicProjectFromRuntime(project, { credentialProfile, knowledge });
  }

  async getKnowledge(projectId: string): Promise<KnowledgeSnapshotDto | null> {
    const project = await this.store.getProject(projectId);
    if (project.sourceKind !== "remote-git") return null;
    const knowledge = await this.store.getActiveKnowledgeSnapshot(projectId);
    return knowledge ? publicKnowledgeSnapshotFromRecord(knowledge) : null;
  }

  async prepareRunWorkspace(
    project: RuntimeProject,
    requestedRevision?: GitRevision,
    signal?: AbortSignal,
  ): Promise<PreparedRunWorkspace> {
    this.assertRemoteProject(project);
    if (
      project.repositoryState !== "ready"
      || !project.currentRevision
      || !project.definitionVersion
    ) {
      throw new AppError(
        "项目源码与知识索引尚未就绪",
        409,
        "PROJECT_NOT_READY",
      );
    }
    const revision = requestedRevision ?? project.currentRevision;
    // Use the same physical snapshot that the deterministic DeepWiki row owns.
    // A revision can have multiple historical workspaces after A→B→A; choosing
    // merely the newest matching SHA would escape the Ask/knowledge retention
    // boundary and could race cleanup during handoff.
    const source = await this.store.getKnowledgeWorkspaceByRevision(project.id, revision);
    if (!source || source.state !== "ready") {
      throw new AppError(
        requestedRevision
          ? "这次交接固定的旧源码版本已不在服务端，请回到当前版本重新 Ask"
          : "项目源码快照不可用，请重新同步仓库",
        requestedRevision ? 410 : 409,
        "PROJECT_SNAPSHOT_UNAVAILABLE",
      );
    }
    const knowledge = await this.store.getKnowledgeSnapshotByRevision(project.id, revision);
    if (!knowledge) {
      throw new AppError(
        requestedRevision
          ? "这次交接固定的旧 DeepWiki 知识已不在服务端，请回到当前版本重新 Ask"
          : "项目 DeepWiki 知识尚未就绪，请重新同步仓库",
        requestedRevision ? 410 : 409,
        "PROJECT_KNOWLEDGE_UNAVAILABLE",
      );
    }

    const workspaceId = randomUUID();
    const destination = this.layout.runWorkspace(project.id, workspaceId);
    const workspace = await this.store.createManagedWorkspace({
      id: workspaceId,
      projectId: project.id,
      purpose: "run",
      rootPath: destination,
    });
    this.activeRunPreparations.add(workspace.id);
    try {
      const materialized = await this.git.materializeFromSnapshot({
        sourceRoot: source.rootPath,
        revision,
        destination,
        signal,
      });
      const ready = await this.store.markManagedWorkspaceReady(workspace.id, revision);
      return {
        workspace: ready,
        project: { ...project, rootPath: materialized.rootPath },
        baseRevision: revision,
        definitionVersion: project.definitionVersion,
      };
    } catch (error) {
      this.activeRunPreparations.delete(workspace.id);
      await this.failAndCleanWorkspace(workspace, "Run Workspace 创建失败");
      throw error;
    }
  }

  /**
   * Materializes the Session's fixed primary revision into a persistent,
   * server-owned workspace. A later Worker may mount this workspace, but no
   * browser-controlled image, command, mount, or host path crosses this API.
   */
  async prepareAgentSandbox(input: {
    sessionId: string;
    projectId: string;
    sourceRevision: GitRevision;
  }, signal?: AbortSignal): Promise<PreparedAgentSandbox> {
    const existing = await this.store.getAgentSandbox(input.sessionId);
    if (existing) {
      if (existing.state === "ready" || existing.state === "busy") {
        const [project, workspace] = await Promise.all([
          this.store.getProject(input.projectId),
          this.store.getAgentSandboxWorkspace(input.sessionId),
        ]);
        this.assertRemoteProject(project);
        if (
          !workspace
          || workspace.projectId !== input.projectId
          || workspace.revision !== input.sourceRevision
          || (workspace.state !== "ready" && workspace.state !== "busy")
          || !project.definitionVersion
        ) {
          throw new AppError(
            "当前 Session 的 Sandbox 记录与受管工作区不一致",
            409,
            "AGENT_SANDBOX_WORKSPACE_MISMATCH",
          );
        }
        return {
          sandbox: existing,
          workspace,
          project: { ...project, rootPath: workspace.rootPath },
          baseRevision: input.sourceRevision,
          definitionVersion: project.definitionVersion,
        };
      }
      throw new AppError(
        existing.state === "starting"
          ? "Sandbox 正在启动"
          : "当前 Session 的 Sandbox 不可用，请新建会话后重试",
        409,
        existing.state === "starting" ? "AGENT_SANDBOX_STARTING" : "AGENT_SANDBOX_UNAVAILABLE",
      );
    }
    if (this.activeSandboxPreparations.has(input.sessionId)) {
      throw new AppError("Sandbox 正在启动", 409, "AGENT_SANDBOX_STARTING");
    }
    const project = await this.store.getProject(input.projectId);
    this.assertRemoteProject(project);
    if (
      project.repositoryState !== "ready"
      || !project.currentRevision
      || !project.definitionVersion
    ) {
      throw new AppError("项目源码快照尚未就绪", 409, "PROJECT_NOT_READY");
    }
    const source = await this.store.getKnowledgeWorkspaceByRevision(
      input.projectId,
      input.sourceRevision,
    );
    if (!source || source.state !== "ready") {
      throw new AppError("Session 固定的源码快照已不可用", 410, "AGENT_SANDBOX_SOURCE_GONE");
    }
    const workspaceId = randomUUID();
    const destination = this.layout.agentSandbox(input.projectId, workspaceId);
    let workspace = await this.store.createManagedWorkspace({
      id: workspaceId,
      projectId: input.projectId,
      purpose: "sandbox",
      rootPath: destination,
    });
    this.activeSandboxPreparations.add(input.sessionId);
    this.activeSandboxWorkspaceIds.add(workspace.id);
    try {
      await this.git.materializeFromSnapshot({
        sourceRoot: source.rootPath,
        revision: input.sourceRevision,
        destination,
        signal,
      });
      workspace = await this.store.markManagedWorkspaceReady(workspace.id, input.sourceRevision);
      const sandbox = await this.store.createAgentSandbox({
        sessionId: input.sessionId,
        projectId: input.projectId,
        workspaceId: workspace.id,
        sourceRevision: input.sourceRevision,
      });
      return {
        sandbox,
        workspace,
        project: { ...project, rootPath: workspace.rootPath },
        baseRevision: input.sourceRevision,
        definitionVersion: project.definitionVersion,
      };
    } catch (error) {
      await this.failAndCleanWorkspace(workspace, "Agent Sandbox 创建失败");
      throw error;
    } finally {
      this.activeSandboxPreparations.delete(input.sessionId);
      this.activeSandboxWorkspaceIds.delete(workspace.id);
    }
  }

  commitPreparedRun(workspace: ManagedWorkspaceRecord): void {
    this.activeRunPreparations.delete(workspace.id);
  }

  async discardPreparedRun(workspace: ManagedWorkspaceRecord): Promise<void> {
    // Transition first. If the workspace became referenced/active unexpectedly,
    // the database refusal prevents deleting material data underneath a Run.
    this.activeRunPreparations.delete(workspace.id);
    await this.store.markManagedWorkspaceDestroyed(workspace.id);
    await this.layout.removeWorkspace(workspace.rootPath);
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
  }

  async pruneUnusedWorkspaces(input: {
    dryRun: boolean;
    olderThanHours: number;
    limit: number;
  }): Promise<WorkspacePruneResult> {
    const candidates = await this.store.listPrunableManagedWorkspaces({
      olderThanHours: input.olderThanHours,
      limit: input.limit + 1,
    });
    const selected = candidates.slice(0, input.limit);
    if (input.dryRun) {
      return {
        dryRun: true,
        candidates: selected.length,
        removed: 0,
        retained: 0,
        failed: 0,
        moreAvailable: candidates.length > input.limit,
      };
    }
    let removed = 0;
    let retained = 0;
    let failed = 0;
    for (const workspace of selected) {
      try {
        if (
          this.activeRunPreparations.has(workspace.id)
          || this.activeSandboxWorkspaceIds.has(workspace.id)
        ) {
          retained += 1;
          continue;
        }
        // A repository operation owns its newest project snapshot from the
        // first materialization write through DeepWiki completion and atomic
        // activation. In particular, a ready workspace is still live while
        // DeepWiki is indexing it and must not be pruned at olderThanHours=0.
        if (workspace.purpose === "project_snapshot" && this.activeOperations.has(workspace.projectId)) {
          retained += 1;
          continue;
        }
        if (await this.store.isManagedWorkspaceInUse(workspace.id)) {
          retained += 1;
          continue;
        }
        await this.store.markManagedWorkspaceDestroyed(workspace.id);
        await this.layout.removeWorkspace(workspace.rootPath);
        removed += 1;
      } catch (error) {
        if (error instanceof AppError && error.code === "WORKSPACE_DESTROY_FORBIDDEN") {
          retained += 1;
        } else {
          failed += 1;
        }
      }
    }
    return {
      dryRun: false,
      candidates: selected.length,
      removed,
      retained,
      failed,
      moreAvailable: candidates.length > input.limit,
    };
  }

  private enqueueRepositoryOperation(
    projectId: string,
    operation: RepositoryOperationInput,
  ): void {
    if (this.activeOperations.has(projectId)) return;
    this.activeOperations.add(projectId);
    const task = this.runRepositoryOperation(projectId, operation)
      .catch(() => undefined)
      .finally(() => {
        this.activeOperations.delete(projectId);
        if (this.repositoryTasks.get(projectId) === task) {
          this.repositoryTasks.delete(projectId);
        }
        this.tasks.delete(task);
      });
    this.tasks.add(task);
    this.repositoryTasks.set(projectId, task);
  }

  private async runRepositoryOperation(
    projectId: string,
    operation: RepositoryOperationInput,
  ): Promise<void> {
    let workspace: ManagedWorkspaceRecord | null = null;
    let knowledgeId: string | null = null;
    try {
      const project = await this.store.getProject(projectId);
      this.assertRemoteProject(project);
      if (!project.definitionVersion) {
        throw new AppError(
          "远程项目缺少 Control Pack 版本",
          500,
          "CONTROL_PACK_VERSION_MISSING",
        );
      }
      const definitionVersion = project.definitionVersion;
      await this.ensureControlPack(project);
      await this.updateOperation(projectId, operation, "fetching", 15);
      const workspaceId = randomUUID();
      const destination = this.layout.projectSnapshot(projectId, workspaceId);
      workspace = await this.store.createManagedWorkspace({
        id: workspaceId,
        projectId,
        purpose: "project_snapshot",
        rootPath: destination,
      });
      const materialized = await this.git.materialize({
        repositoryUrl: project.repositoryUrl!,
        requestedRef: project.requestedRef ?? "HEAD",
        credentialProfileId: project.credentialProfileId,
        destination,
      });
      await this.updateOperation(projectId, operation, "resolving", 40);
      workspace = await this.store.markManagedWorkspaceReady(
        workspace.id,
        materialized.revision,
      );
      await this.updateOperation(projectId, operation, "materializing", 55);
      const reusableKnowledge = await this.store.getKnowledgeSnapshotByRevision(
        projectId,
        materialized.revision,
      );
      if (reusableKnowledge?.status === "ready") {
        const activeWorkspace = materialized.revision === project.currentRevision
          ? await this.store.getActiveProjectWorkspace(projectId)
          : null;
        if (
          activeWorkspace?.state === "ready"
          && activeWorkspace.revision === materialized.revision
        ) {
          await this.failAndCleanWorkspace(workspace, "仓库 revision 未变化，快照未采用");
          workspace = null;
          await this.updateOperation(projectId, operation, "publishing", 95);
          await this.store.activateRemoteProjectSnapshot({
            projectId,
            workspaceId: activeWorkspace.id,
            knowledgeSnapshotId: reusableKnowledge.id,
            revision: materialized.revision,
            configPath: project.configPath,
            definitionVersion,
          });
          return;
        }
        // A ready index may belong to a historical A→B→A revision, or to a
        // process that crashed after completing DeepWiki but before publish.
        // Exact Git SHA makes the deterministic index reusable with this new
        // ready workspace. Activation atomically rebinds the index row.
        await loadDefinition({
          sourceRoot: materialized.rootPath,
          controlRoot: path.dirname(project.configPath),
          configPath: project.configPath,
        });
        await this.updateOperation(projectId, operation, "publishing", 95);
        await this.store.activateRemoteProjectSnapshot({
          projectId,
          workspaceId: workspace.id,
          knowledgeSnapshotId: reusableKnowledge.id,
          revision: materialized.revision,
          configPath: project.configPath,
          definitionVersion,
        });
        return;
      }
      await loadDefinition({
        sourceRoot: materialized.rootPath,
        controlRoot: path.dirname(project.configPath),
        configPath: project.configPath,
      });
      const knowledge = await this.store.startKnowledgeSnapshot({
        projectId,
        workspaceId: workspace.id,
        revision: materialized.revision,
      });
      knowledgeId = knowledge.id;
      await this.updateOperation(projectId, operation, "indexing", 65);
      const index = await this.deepWiki.build({
        workspaceRoot: materialized.rootPath,
        revision: materialized.revision,
      });
      await this.store.completeKnowledgeSnapshot({
        id: knowledge.id,
        manifestHash: index.manifestHash,
        summary: index.summary,
        indexData: index,
      });
      await this.updateOperation(projectId, operation, "publishing", 95);
      await this.store.activateRemoteProjectSnapshot({
        projectId,
        workspaceId: workspace.id,
        knowledgeSnapshotId: knowledge.id,
        revision: materialized.revision,
        configPath: project.configPath,
        definitionVersion,
      });
    } catch (error) {
      if (knowledgeId) {
        await this.store.failKnowledgeSnapshot(
          knowledgeId,
          "DeepWiki Lite 索引未完成",
        ).catch(() => undefined);
      }
      if (workspace) {
        await this.failAndCleanWorkspace(workspace, "仓库快照创建失败");
      }
      await this.store.markRemoteProjectImportFailed(
        projectId,
        {
          id: operation.id,
          kind: operation.kind,
          stage: operation.stage,
          progress: operation.progress,
          message: operation.message,
        },
        publicRepositoryFailure(error),
      ).catch(() => undefined);
      throw error;
    }
  }

  private async ensureControlPack(project: RuntimeProject): Promise<void> {
    const configPresent = await lstat(project.configPath)
      .then((stats) => stats.isFile())
      .catch(() => false);
    if (configPresent) return;
    throw new AppError(
      "项目 Control Pack 已丢失，拒绝用不确定版本继续执行",
      500,
      "CONTROL_PACK_MISSING",
    );
  }

  private async updateOperation(
    projectId: string,
    original: RepositoryOperationInput,
    stage: RepositoryOperationInput["stage"],
    progress: number,
  ): Promise<void> {
    const next = {
      ...original,
      state: "running" as const,
      stage,
      progress,
      message: operationMessages[stage],
    };
    await this.store.updateRepositoryOperation(projectId, next);
    Object.assign(original, next);
  }

  private async failAndCleanWorkspace(
    workspace: ManagedWorkspaceRecord,
    message: string,
  ): Promise<void> {
    await this.store.markManagedWorkspaceFailed(workspace.id, message).catch(() => undefined);
    await this.layout.removeWorkspace(workspace.rootPath).catch(() => undefined);
  }

  private assertRemoteProject(project: RuntimeProject): asserts project is RuntimeProject & {
    repositoryUrl: string;
    repositoryHost: string;
  } {
    if (project.sourceKind !== "remote-git" || !project.repositoryUrl || !project.repositoryHost) {
      throw new AppError("该操作只支持远程 Git 项目", 409, "REMOTE_PROJECT_REQUIRED");
    }
  }
}

class ManagedWorkspaceLayout {
  private constructor(readonly root: string) {}

  static async create(requestedRoot: string): Promise<ManagedWorkspaceLayout> {
    return new ManagedWorkspaceLayout(await verifyManagedWorkspaceRoot(requestedRoot));
  }

  controlRoot(projectId: string): string {
    return this.child(projectId, "control");
  }

  pendingSourceRoot(projectId: string): string {
    return this.child(projectId, "pending-source");
  }

  projectSnapshot(projectId: string, workspaceId: string): string {
    return this.child(projectId, "snapshots", workspaceId);
  }

  runWorkspace(projectId: string, workspaceId: string): string {
    return this.child(projectId, "runs", workspaceId);
  }

  agentSandbox(projectId: string, workspaceId: string): string {
    return this.child(projectId, "sandboxes", workspaceId);
  }

  async removeProject(projectId: string): Promise<void> {
    await rm(this.child(projectId), { recursive: true, force: true });
  }

  async removeWorkspace(workspaceRoot: string): Promise<void> {
    const resolved = path.resolve(workspaceRoot);
    if (!isWithin(this.root, resolved) || resolved === this.root) {
      throw new Error("拒绝清理 Managed Root 之外的 Workspace");
    }
    await rm(resolved, { recursive: true, force: true });
  }

  private child(projectId: string, ...parts: string[]): string {
    assertUuid(projectId, "Project ID");
    for (const part of parts) {
      if (
        part !== "control"
        && part !== "pending-source"
        && part !== "snapshots"
        && part !== "runs"
        && part !== "sandboxes"
      ) {
        assertUuid(part, "Workspace ID");
      }
    }
    const resolved = path.resolve(this.root, "projects", projectId, ...parts);
    if (!isWithin(this.root, resolved)) throw new Error("Managed Workspace 路径越界");
    return resolved;
  }
}

function operationState(
  kind: RepositoryOperationInput["kind"],
  state: RepositoryOperationInput["state"],
  stage: RepositoryOperationInput["stage"],
  progress: number,
): RepositoryOperationInput {
  return {
    id: randomUUID(),
    kind,
    state,
    stage,
    progress,
    message: operationMessages[stage],
  };
}

function publicRepositoryFailure(_error: unknown): string {
  // The raw Git/initializer error remains outside browser-visible persistence.
  return "仓库处理失败，请检查仓库地址、ref、Credential Profile 和平台限制后重试";
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`${label} 格式无效`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function waitForOperation(task: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return task;
  if (signal.aborted) {
    throw new AppError("仓库绑定请求已取消", 499, "REPOSITORY_BINDING_CANCELLED");
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(
      new AppError("仓库绑定请求已取消", 499, "REPOSITORY_BINDING_CANCELLED"),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    void task.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function computeControlPackVersion(controlRoot: string): Promise<string> {
  const hash = createHash("sha256");
  let consumed = 0;
  const visit = async (directory: string, relativeDirectory = ""): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolute = path.join(directory, entry.name);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        throw new AppError(
          "Control Pack 不能包含符号链接",
          500,
          "CONTROL_PACK_INVALID",
        );
      }
      if (stats.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        await visit(absolute, relative);
        continue;
      }
      if (!stats.isFile()) {
        throw new AppError("Control Pack 只能包含普通文件", 500, "CONTROL_PACK_INVALID");
      }
      consumed += stats.size;
      if (consumed > 32 * 1024 * 1024) {
        throw new AppError("Control Pack 超过 32 MiB", 500, "CONTROL_PACK_INVALID");
      }
      hash.update(`f\0${relative}\0${stats.size}\0`);
      hash.update(await readFile(absolute));
      hash.update("\0");
    }
  };
  await visit(controlRoot);
  return `sha256:${hash.digest("hex")}`;
}
