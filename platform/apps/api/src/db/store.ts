import { createHash, randomUUID } from "node:crypto";

import {
  PHASE_IDS,
  agentEventSchema,
  agentHumanGateSchema,
  agentMessageSchema,
  agentSandboxSchema,
  agentSessionRepositorySchema,
  agentSessionSchema,
  agentToolCallSchema,
  askAnswerSchema,
  architectureImpactToPhaseResolution,
  architectureImpactSchema,
  changeContractSchema,
  changesetSchema,
  deepWikiCitationSchema,
  deepWikiGenerationSchema,
  knowledgeSnapshotSchema,
  knowledgeSummarySchema,
  phaseResolutionSchema,
  projectAgentSettingsSchema,
  publicProjectSchema,
  repoAliasSchema,
  sendAgentMessageSchema,
  updateProjectAgentSettingsSchema,
  type AgentEventDto,
  type AgentEventKind,
  type AgentHumanGateCategory,
  type AgentHumanGateDto,
  type AgentMessageDto,
  type AgentSandboxDto,
  type AgentSandboxState,
  type AgentSessionDto,
  type AgentSessionRepositoryDto,
  type AgentToolCallDto,
  type AskAnswerDto,
  type AskProviderId,
  type AskRevision,
  type AskThreadDto,
  type AskThreadMessageDto,
  type AskThreadSummaryDto,
  type ArchitectureImpactDto,
  type ArtifactDto,
  type ChangeContractDto,
  type ChangesetDto,
  type CodexReasoningEffort,
  type CodexRunnerMode,
  type CredentialProfileSummaryDto,
  type DeepWikiCitationDto,
  type DeepWikiGenerationDto,
  type DeepWikiGenerationStatus,
  type ExecutionDto,
  type ExecutionEventDto,
  type GitRevision,
  type KnowledgeSnapshotDto,
  type KnowledgeSummaryDto,
  type McpToolPermissionClass,
  type PhaseId,
  type PhaseStatus,
  type PhaseResolutionDto,
  type PhaseRunDto,
  type PublicProjectDto,
  type ProjectAgentSettingsDto,
  type ProjectDto,
  type ReviewDecision,
  type ReviewDto,
  type RepoAlias,
  type TicketDto,
  type TicketStatus,
  type TicketSummaryDto,
  type UpdateProjectAgentSettingsInput,
  type WorkflowRunDto
} from "@ai-sdlc/contracts";
import type pg from "pg";

import { AppError, notFound } from "../domain/errors.js";
import {
  validatePhaseResolutionArtifactMutation,
  validatePhaseResolutionExecution,
} from "../domain/change-routing.js";
import {
  assertPhaseExecutable,
  assertPhaseReviewable,
  validateArchitectureImpactArtifactMutation,
  validateArchitecturePartialExecution,
} from "../domain/workflow.js";

export interface ArtifactRecordInput {
  artifactKey: string;
  filePath: string;
  content: string;
  contentHash: string;
}

export interface TicketRecordInput {
  storyKey: string;
  title: string;
  category: string;
  sourcePath: string;
  content: string;
  contentHash: string;
  acceptanceCriteriaCount: number;
  position: number;
}

export interface TicketSyncInput {
  artifactKey: string;
  tickets: TicketRecordInput[];
}

export interface ArtifactSnapshotRecord {
  id: string;
  filePath: string;
  content: string;
}

/**
 * The current snapshot keeps the execution that materialized this exact head.
 * Human revisions intentionally have a null execution id.  The field is
 * optional only for backward-compatible store doubles in existing checks;
 * security-sensitive gates must fail closed when it is absent.
 */
export type CurrentArtifactSnapshot = ArtifactDto & {
  content: string;
  executionId?: string | null;
};

export interface ArtifactWorkspace {
  rootPath: string;
  workflowRunId: string;
  phaseId: PhaseId;
}

export interface SelectionArtifact extends ArtifactDto {
  sourcePosition: number;
  sourceStatus: PhaseRunDto["status"];
  workflowRunId: string;
  content: string;
}

export interface RunBundle {
  run: WorkflowRunDto;
  project: RuntimeProject;
  phases: PhaseRunDto[];
  artifactPaths: Record<string, string>;
  workspace?: ManagedWorkspaceRecord | null;
}

export interface CreateRunPersistence {
  runId: string;
  artifactPaths: Record<string, string>;
  changeContract?: ChangeContractDto;
  changeContractArtifact?: ArtifactRecordInput;
  workspaceId?: string;
  baseRevision?: GitRevision;
  definitionVersion?: string;
  /**
   * When a Run originates from an Agent message, this association is written
   * in the same PostgreSQL transaction as the Run, phases, Artifact, and
   * Workspace busy transition. It must never be attached as a best-effort
   * follow-up write.
   */
  agentSessionRun?: {
    sessionId: string;
    triggerMessageId: string;
  };
}

export interface RunPersistenceSnapshot {
  run: WorkflowRunDto;
  artifactPaths: Record<string, string>;
  workspaceId: string | null;
  agentSessionRun: AgentSessionRunRecord | null;
}

export type RepositoryState = "importing" | "ready" | "syncing" | "failed";
export type RepositoryOperationStage =
  | "validating"
  | "fetching"
  | "resolving"
  | "materializing"
  | "indexing"
  | "publishing";

export interface RuntimeProject extends ProjectDto {
  sourceKind: "legacy-local" | "remote-git";
  repositoryUrl: string | null;
  repositoryHost: string | null;
  requestedRef: string | null;
  credentialProfileId: string | null;
  repositoryState: RepositoryState;
  currentRevision: GitRevision | null;
  definitionMode: "repository" | "managed";
  definitionVersion: string | null;
  operation: {
    id: string;
    kind: "import" | "sync";
    state: "queued" | "running" | "failed";
    stage: RepositoryOperationStage;
    progress: number;
    message: string;
  } | null;
  lastSyncedAt: string | null;
  repositoryErrorMessage: string | null;
}

export interface ManagedWorkspaceRecord {
  id: string;
  projectId: string;
  purpose: "project_snapshot" | "run" | "sandbox";
  rootPath: string;
  state: "provisioning" | "ready" | "busy" | "failed" | "destroyed";
  revision: GitRevision | null;
  active: boolean;
  generation: number;
  errorMessage: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSessionRecord extends AgentSessionDto {
  messages: AgentMessageDto[];
  events: AgentEventDto[];
  toolCalls: AgentToolCallDto[];
  humanGates: AgentHumanGateDto[];
  sessionRuns: AgentSessionRunRecord[];
}

export interface AgentSessionRunRecord {
  sessionId: string;
  triggerMessageId: string;
  workflowRunId: string;
  createdAt: string;
}

export interface BeginAgentTurnResult {
  message: AgentMessageDto;
  replayed: boolean;
}

export interface AppendAgentTurnResult {
  userMessage: AgentMessageDto;
  assistantMessage: AgentMessageDto;
  replayed: boolean;
}

export interface CreateAgentToolCallResult {
  toolCall: AgentToolCallDto;
  replayed: boolean;
}

export interface KnowledgeSnapshotRecord extends KnowledgeSnapshotDto {
  projectId: string;
  workspaceId: string | null;
  manifestHash: string | null;
  indexData: unknown | null;
}

export interface AskThreadRecord extends AskThreadDto {
  /** Raw Git object id used to resolve an inactive historical Project Snapshot. */
  sourceRevision: GitRevision;
}

export interface RepositoryOperationInput {
  id: string;
  kind: "import" | "sync";
  state: "queued" | "running" | "failed";
  stage: RepositoryOperationStage;
  progress: number;
  message: string;
}

export interface CreateRemoteProjectPersistence {
  id?: string;
  name: string;
  summary: string;
  rootPath: string;
  configPath: string;
  repositoryUrl: string;
  repositoryHost: string;
  requestedRef: string;
  credentialProfileId: string | null;
  definitionVersion: string;
  operation: RepositoryOperationInput;
}

export interface ArchitectureBaselineRecord {
  sourceRunId: string;
  sourceRunTitle: string;
  sourcePhaseRunId: string;
  /** Internal source Run workspace; never serialize in public DTOs. */
  sourceRootPath: string;
  approvedAt: string;
  artifacts: CurrentArtifactSnapshot[];
  reviews: ReviewDto[];
  architectureImpact: ArchitectureImpactDto | null;
}

export interface PhaseBaselineRecord {
  phaseId: "discovery" | "design";
  sourceRunId: string;
  sourceRunTitle: string;
  sourcePhaseRunId: string;
  /** Internal source Run workspace; never serialize in public DTOs. */
  sourceRootPath: string;
  approvedAt: string;
  artifacts: CurrentArtifactSnapshot[];
  reviews: ReviewDto[];
  resolution: PhaseResolutionDto | null;
}

export interface ApplyPhaseResolutionInput {
  resolution: PhaseResolutionDto;
  expectedBaselineArtifactIds: string[];
  targetArtifactPaths: Record<string, string>;
}

export interface AdoptArchitectureBaselineInput {
  impact: ArchitectureImpactDto;
  expectedBaselineArtifactIds: string[];
  requiredArtifactKeys: string[];
}

export class PgWorkflowStore {
  constructor(private readonly pool: pg.Pool) {}

  async listProjects(): Promise<RuntimeProject[]> {
    const { rows } = await this.pool.query(
      `SELECT p.*, count(wr.id)::integer AS run_count
       FROM projects p
       LEFT JOIN workflow_runs wr ON wr.project_id = p.id
       GROUP BY p.id
       ORDER BY p.created_at DESC`
    );
    return rows.map(mapProject);
  }

  async createProject(input: { name: string; summary: string; rootPath: string; configPath: string }): Promise<RuntimeProject> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO projects (id, name, summary, root_path, config_path)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [randomUUID(), input.name, input.summary, input.rootPath, input.configPath]
      );
      return mapProject(rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new AppError("该项目目录已经注册", 409, "PROJECT_EXISTS");
      }
      throw error;
    }
  }

  async createRemoteProject(input: CreateRemoteProjectPersistence): Promise<RuntimeProject> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO projects (
           id, name, summary, root_path, config_path, source_kind,
           repository_url, repository_host, requested_ref, credential_profile_id,
           repository_state, definition_mode, definition_version,
           operation_id, operation_kind, operation_state, operation_stage,
           operation_progress, operation_message
         ) VALUES (
           $1, $2, $3, $4, $5, 'remote_git',
           $6, $7, $8, $9,
           'importing', 'managed', $10,
           $11, $12, $13, $14, $15, $16
         ) RETURNING *`,
        [
          input.id ?? randomUUID(),
          input.name,
          input.summary,
          input.rootPath,
          input.configPath,
          input.repositoryUrl,
          input.repositoryHost,
          input.requestedRef,
          input.credentialProfileId,
          input.definitionVersion,
          input.operation.id,
          input.operation.kind,
          input.operation.state,
          input.operation.stage,
          input.operation.progress,
          input.operation.message,
        ],
      );
      return mapProject(rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new AppError("该服务端项目 Workspace 已经注册", 409, "PROJECT_EXISTS");
      }
      throw error;
    }
  }

  async getProject(id: string): Promise<RuntimeProject> {
    const { rows } = await this.pool.query("SELECT * FROM projects WHERE id = $1", [id]);
    if (!rows[0]) throw notFound("项目");
    return mapProject(rows[0]);
  }

  async getProjectAgentSettings(projectId: string): Promise<ProjectAgentSettingsDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await ensureProjectAgentSettings(client, projectId);
      await client.query("COMMIT");
      return mapProjectAgentSettings(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateProjectAgentSettings(
    projectId: string,
    input: UpdateProjectAgentSettingsInput,
  ): Promise<ProjectAgentSettingsDto> {
    const update = updateProjectAgentSettingsSchema.parse(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentRow = await ensureProjectAgentSettings(client, projectId);
      const current = mapProjectAgentSettings(currentRow);
      if (current.version !== update.expectedVersion) {
        throw new AppError(
          "项目 Agent 设置已被其他请求修改，请刷新后重试",
          409,
          "PROJECT_AGENT_SETTINGS_VERSION_CONFLICT",
        );
      }
      const { rows } = await client.query(
        `UPDATE project_agent_settings
         SET repo_alias = $1,
             default_provider_id = $2,
             sandbox_blueprint_id = $3,
             sandbox_blueprint_version = $4,
             enabled_mcp_server_ids = $5::jsonb,
             version = version + 1,
             updated_at = now()
         WHERE project_id = $6 AND version = $7
         RETURNING *`,
        [
          update.repoAlias ?? current.repoAlias,
          update.defaultProviderId ?? current.defaultProviderId,
          update.sandboxBlueprintId ?? current.sandboxBlueprintId,
          update.sandboxBlueprintVersion ?? current.sandboxBlueprintVersion,
          JSON.stringify(update.enabledMcpServerIds ?? current.enabledMcpServerIds),
          projectId,
          update.expectedVersion,
        ],
      );
      if (!rows[0]) {
        throw new AppError(
          "项目 Agent 设置已被其他请求修改，请刷新后重试",
          409,
          "PROJECT_AGENT_SETTINGS_VERSION_CONFLICT",
        );
      }
      await client.query("COMMIT");
      return mapProjectAgentSettings(rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new AppError("Repo alias 已被其他项目使用", 409, "REPO_ALIAS_EXISTS");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Compatibility alias for services that describe versioned updates as upserts. */
  async upsertProjectAgentSettings(
    projectId: string,
    input: UpdateProjectAgentSettingsInput,
  ): Promise<ProjectAgentSettingsDto> {
    return this.updateProjectAgentSettings(projectId, input);
  }

  async updateRepositoryOperation(
    projectId: string,
    operation: RepositoryOperationInput,
  ): Promise<RuntimeProject> {
    const { rows } = await this.pool.query(
      `UPDATE projects
       SET repository_state = CASE
             WHEN $3 = 'failed' AND active_revision IS NOT NULL THEN 'ready'
             WHEN $3 = 'failed' THEN 'failed'
             WHEN $2 = 'sync' THEN 'syncing'
             ELSE 'importing'
           END,
           operation_id = $1,
           operation_kind = $2,
           operation_state = $3,
           operation_stage = $4,
           operation_progress = $5,
           operation_message = $6,
           repository_error_message = CASE WHEN $3 = 'failed' THEN $6 ELSE NULL END,
           updated_at = now()
       WHERE id = $7 AND source_kind = 'remote_git'
         AND (operation_id IS NULL OR operation_id = $1 OR operation_state = 'failed')
       RETURNING *`,
      [
        operation.id,
        operation.kind,
        operation.state,
        operation.stage,
        operation.progress,
        operation.message,
        projectId,
      ],
    );
    if (!rows[0]) {
      const project = await this.pool.query(
        "SELECT id FROM projects WHERE id = $1 AND source_kind = 'remote_git'",
        [projectId],
      );
      if (!project.rows[0]) throw notFound("远程项目");
      throw new AppError("另一个仓库操作正在进行", 409, "REPOSITORY_OPERATION_CONFLICT");
    }
    return mapProject(rows[0]);
  }

  async markRemoteProjectImportFailed(
    projectId: string,
    operation: Omit<RepositoryOperationInput, "state">,
    message: string,
  ): Promise<RuntimeProject> {
    return this.updateRepositoryOperation(projectId, {
      ...operation,
      state: "failed",
      message,
    });
  }

  async activateRemoteProjectSnapshot(input: {
    projectId: string;
    workspaceId: string;
    knowledgeSnapshotId: string;
    revision: GitRevision;
    configPath: string;
    definitionVersion: string;
  }): Promise<RuntimeProject> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const projectResult = await client.query(
        "SELECT * FROM projects WHERE id = $1 AND source_kind = 'remote_git' FOR UPDATE",
        [input.projectId],
      );
      if (!projectResult.rows[0]) throw notFound("远程项目");
      const workspaceResult = await client.query(
        `SELECT * FROM managed_workspaces
         WHERE id = $1 AND project_id = $2 AND purpose = 'project_snapshot'
           AND state = 'ready' AND revision = $3`,
        [input.workspaceId, input.projectId, input.revision],
      );
      if (!workspaceResult.rows[0]) {
        throw new AppError(
          "待发布的 Project Snapshot 不存在、未就绪或 revision 不一致",
          409,
          "PROJECT_SNAPSHOT_NOT_READY",
        );
      }
      const knowledgeResult = await client.query(
        `SELECT id FROM knowledge_snapshots
         WHERE id = $1 AND project_id = $2
           AND revision = $3 AND status = 'ready'`,
        [input.knowledgeSnapshotId, input.projectId, input.revision],
      );
      if (!knowledgeResult.rows[0]) {
        throw new AppError(
          "待发布的 DeepWiki Lite 索引不存在、未就绪或 revision 不一致",
          409,
          "KNOWLEDGE_SNAPSHOT_NOT_READY",
        );
      }
      await client.query(
        `UPDATE managed_workspaces
         SET active = false, updated_at = now()
         WHERE project_id = $1 AND purpose = 'project_snapshot' AND active`,
        [input.projectId],
      );
      await client.query(
        "UPDATE managed_workspaces SET active = true, updated_at = now() WHERE id = $1",
        [input.workspaceId],
      );
      await client.query(
        "UPDATE knowledge_snapshots SET workspace_id = $1, updated_at = now() WHERE id = $2",
        [input.workspaceId, input.knowledgeSnapshotId],
      );
      const { rows } = await client.query(
        `UPDATE projects
         SET root_path = $1,
             config_path = $2,
             repository_state = 'ready',
             active_revision = $3,
             definition_mode = 'managed',
             definition_version = $4,
             operation_id = NULL,
             operation_kind = NULL,
             operation_state = NULL,
             operation_stage = NULL,
             operation_progress = NULL,
             operation_message = NULL,
             repository_error_message = NULL,
             last_synced_at = now(),
             updated_at = now()
         WHERE id = $5
         RETURNING *`,
        [
          workspaceResult.rows[0].root_path,
          input.configPath,
          input.revision,
          input.definitionVersion,
          input.projectId,
        ],
      );
      // Publish the source snapshot and invalidate LLM wiki views in the same
      // transaction. A browser must never observe a new active revision while
      // an older ready DeepWiki is still presented as current.
      await client.query(
        `UPDATE deepwiki_generations
         SET status = 'stale', stale_at = now(), updated_at = now()
         WHERE project_id = $1 AND status = 'ready' AND revision <> $2`,
        [input.projectId, input.revision],
      );
      await client.query("COMMIT");
      return mapProject(rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createManagedWorkspace(input: {
    id?: string;
    projectId: string;
    purpose: ManagedWorkspaceRecord["purpose"];
    rootPath: string;
    expiresAt?: string | null;
  }): Promise<ManagedWorkspaceRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query(
        "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
        [input.projectId],
      );
      if (!project.rows[0]) throw notFound("项目");
      const generation = await client.query(
        `SELECT COALESCE(max(generation), 0)::integer + 1 AS next_generation
         FROM managed_workspaces WHERE project_id = $1 AND purpose = $2`,
        [input.projectId, input.purpose],
      );
      const { rows } = await client.query(
        `INSERT INTO managed_workspaces
           (id, project_id, purpose, root_path, state, active, generation, expires_at)
         VALUES ($1, $2, $3, $4, 'provisioning', false, $5, $6)
         RETURNING *`,
        [
          input.id ?? randomUUID(),
          input.projectId,
          input.purpose,
          input.rootPath,
          generation.rows[0].next_generation,
          input.expiresAt ?? null,
        ],
      );
      await client.query("COMMIT");
      return mapWorkspace(rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new AppError("Managed Workspace 路径已被占用", 409, "WORKSPACE_EXISTS");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getManagedWorkspace(id: string): Promise<ManagedWorkspaceRecord> {
    const { rows } = await this.pool.query(
      "SELECT * FROM managed_workspaces WHERE id = $1",
      [id],
    );
    if (!rows[0]) throw notFound("Managed Workspace");
    return mapWorkspace(rows[0]);
  }

  async getActiveProjectWorkspace(projectId: string): Promise<ManagedWorkspaceRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM managed_workspaces
       WHERE project_id = $1 AND purpose = 'project_snapshot' AND active
       ORDER BY generation DESC LIMIT 1`,
      [projectId],
    );
    return rows[0] ? mapWorkspace(rows[0]) : null;
  }

  async getProjectSnapshotByRevision(
    projectId: string,
    revision: GitRevision,
  ): Promise<ManagedWorkspaceRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM managed_workspaces
       WHERE project_id = $1 AND purpose = 'project_snapshot'
         AND state = 'ready' AND revision = $2
       ORDER BY generation DESC LIMIT 1`,
      [projectId, revision],
    );
    return rows[0] ? mapWorkspace(rows[0]) : null;
  }

  /**
   * Resolves the one physical snapshot currently bound to the persisted
   * DeepWiki row for a revision. Ask Threads intentionally use this instead of
   * choosing an arbitrary/newest workspace that happens to share the Git SHA.
   * The workspace identity remains an internal retention boundary and is never
   * added to the public Ask DTO.
   */
  async getKnowledgeWorkspaceByRevision(
    projectId: string,
    revision: GitRevision,
  ): Promise<ManagedWorkspaceRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT mw.*
       FROM knowledge_snapshots ks
       JOIN managed_workspaces mw ON mw.id = ks.workspace_id
       WHERE ks.project_id = $1 AND ks.revision = $2 AND ks.status = 'ready'
         AND mw.project_id = ks.project_id
         AND mw.purpose = 'project_snapshot'
         AND mw.state = 'ready'
         AND mw.revision = ks.revision
       LIMIT 1`,
      [projectId, revision],
    );
    return rows[0] ? mapWorkspace(rows[0]) : null;
  }

  async getRunWorkspace(runId: string): Promise<ManagedWorkspaceRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT mw.* FROM workflow_runs wr
       JOIN managed_workspaces mw ON mw.id = wr.workspace_id
       WHERE wr.id = $1`,
      [runId],
    );
    return rows[0] ? mapWorkspace(rows[0]) : null;
  }

  async markManagedWorkspaceReady(
    workspaceId: string,
    revision: GitRevision,
  ): Promise<ManagedWorkspaceRecord> {
    const { rows } = await this.pool.query(
      `UPDATE managed_workspaces
       SET state = 'ready', revision = $1, error_message = NULL, updated_at = now()
       WHERE id = $2 AND state = 'provisioning'
       RETURNING *`,
      [revision, workspaceId],
    );
    if (!rows[0]) {
      throw new AppError(
        "Managed Workspace 不存在或状态已变化",
        409,
        "WORKSPACE_STATE_CHANGED",
      );
    }
    return mapWorkspace(rows[0]);
  }

  async markManagedWorkspaceFailed(
    workspaceId: string,
    message: string,
  ): Promise<ManagedWorkspaceRecord> {
    const { rows } = await this.pool.query(
      `UPDATE managed_workspaces
       SET state = 'failed', active = false, error_message = $1, updated_at = now()
       WHERE id = $2 AND state <> 'destroyed'
       RETURNING *`,
      [message, workspaceId],
    );
    if (!rows[0]) throw notFound("Managed Workspace");
    return mapWorkspace(rows[0]);
  }

  async markManagedWorkspaceDestroyed(workspaceId: string): Promise<ManagedWorkspaceRecord> {
    const { rows } = await this.pool.query(
      `UPDATE managed_workspaces AS mw
       SET state = 'destroyed', active = false, updated_at = now()
       WHERE mw.id = $1 AND mw.active = false
         AND NOT EXISTS (
           SELECT 1 FROM workflow_runs wr WHERE wr.workspace_id = mw.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM agent_session_repositories sr WHERE sr.workspace_id = mw.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM agent_sandboxes sb WHERE sb.workspace_id = mw.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM deepwiki_generations dg
           WHERE dg.workspace_id = mw.id AND dg.status <> 'failed'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM knowledge_snapshots ks
           WHERE ks.workspace_id = mw.id
             AND (
               ks.status = 'indexing'
               OR (
                 ks.status = 'ready'
                 AND EXISTS (
                   SELECT 1 FROM ask_threads at
                   WHERE at.project_id = ks.project_id
                     AND at.source_revision = ks.revision
                 )
               )
             )
         )
         AND NOT (
           mw.purpose = 'project_snapshot'
           AND EXISTS (
             SELECT 1 FROM projects p
             WHERE p.id = mw.project_id
               AND p.operation_state IN ('queued', 'running')
           )
           AND mw.generation = (
             SELECT max(latest.generation)
             FROM managed_workspaces latest
             WHERE latest.project_id = mw.project_id
               AND latest.purpose = 'project_snapshot'
               AND latest.state <> 'destroyed'
           )
         )
       RETURNING *`,
      [workspaceId],
    );
    if (!rows[0]) {
      throw new AppError(
        "Active Workspace 不能销毁，或 Workspace 不存在",
        409,
        "WORKSPACE_DESTROY_FORBIDDEN",
      );
    }
    return mapWorkspace(rows[0]);
  }

  async isManagedWorkspaceInUse(workspaceId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM managed_workspaces mw
         WHERE mw.id = $1 AND (
           mw.active
           OR EXISTS (SELECT 1 FROM workflow_runs wr WHERE wr.workspace_id = mw.id)
           OR EXISTS (
             SELECT 1 FROM agent_session_repositories sr WHERE sr.workspace_id = mw.id
           )
           OR EXISTS (
             SELECT 1 FROM agent_sandboxes sb WHERE sb.workspace_id = mw.id
           )
           OR EXISTS (
             SELECT 1 FROM deepwiki_generations dg
             WHERE dg.workspace_id = mw.id AND dg.status <> 'failed'
           )
           OR EXISTS (
             SELECT 1
             FROM knowledge_snapshots ks
             WHERE ks.workspace_id = mw.id
               AND (
                 ks.status = 'indexing'
                 OR (
                   ks.status = 'ready'
                   AND EXISTS (
                     SELECT 1 FROM ask_threads at
                     WHERE at.project_id = ks.project_id
                       AND at.source_revision = ks.revision
                   )
                 )
               )
           )
           OR (
             mw.purpose = 'project_snapshot'
             AND EXISTS (
               SELECT 1 FROM projects p
               WHERE p.id = mw.project_id
                 AND p.operation_state IN ('queued', 'running')
             )
             AND mw.generation = (
               SELECT max(latest.generation)
               FROM managed_workspaces latest
               WHERE latest.project_id = mw.project_id
                 AND latest.purpose = 'project_snapshot'
                 AND latest.state <> 'destroyed'
             )
           )
         )
       ) AS in_use`,
      [workspaceId],
    );
    return Boolean(rows[0]?.in_use);
  }

  async listPrunableManagedWorkspaces(input: {
    olderThanHours: number;
    limit: number;
  }): Promise<ManagedWorkspaceRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT mw.*
       FROM managed_workspaces mw
       WHERE mw.active = false
         AND mw.updated_at <= now() - ($1::double precision * interval '1 hour')
         AND (
           (mw.purpose = 'project_snapshot' AND mw.state IN ('provisioning', 'ready', 'failed', 'destroyed'))
           OR (mw.purpose = 'run' AND mw.state IN ('provisioning', 'ready', 'failed', 'destroyed'))
           OR (mw.purpose = 'sandbox' AND mw.state IN ('provisioning', 'ready', 'failed', 'destroyed'))
         )
         AND NOT EXISTS (
           SELECT 1 FROM workflow_runs wr WHERE wr.workspace_id = mw.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM agent_session_repositories sr WHERE sr.workspace_id = mw.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM agent_sandboxes sb WHERE sb.workspace_id = mw.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM deepwiki_generations dg
           WHERE dg.workspace_id = mw.id AND dg.status <> 'failed'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM knowledge_snapshots ks
           WHERE ks.workspace_id = mw.id
             AND (
               ks.status = 'indexing'
               OR (
                 ks.status = 'ready'
                 AND EXISTS (
                   SELECT 1 FROM ask_threads at
                   WHERE at.project_id = ks.project_id
                     AND at.source_revision = ks.revision
                 )
               )
             )
         )
         AND NOT (
           mw.purpose = 'project_snapshot'
           AND EXISTS (
             SELECT 1 FROM projects p
             WHERE p.id = mw.project_id
               AND p.operation_state IN ('queued', 'running')
           )
           AND mw.generation = (
             SELECT max(latest.generation)
             FROM managed_workspaces latest
             WHERE latest.project_id = mw.project_id
               AND latest.purpose = 'project_snapshot'
               AND latest.state <> 'destroyed'
           )
         )
       ORDER BY mw.updated_at ASC, mw.id ASC
       LIMIT $2`,
      [input.olderThanHours, input.limit],
    );
    return rows.map(mapWorkspace);
  }

  async startKnowledgeSnapshot(input: {
    id?: string;
    projectId: string;
    workspaceId: string;
    revision: GitRevision;
  }): Promise<KnowledgeSnapshotRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO knowledge_snapshots
         (id, project_id, workspace_id, revision, status)
       SELECT $1, $2, mw.id, $4, 'indexing'
       FROM managed_workspaces mw
       WHERE mw.id = $3 AND mw.project_id = $2
         AND mw.purpose = 'project_snapshot' AND mw.state = 'ready' AND mw.revision = $4
       ON CONFLICT (project_id, revision) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id,
         status = 'indexing',
         manifest_hash = NULL,
         summary = NULL,
         index_data = NULL,
         error_message = NULL,
         indexed_at = NULL,
         updated_at = now()
       WHERE knowledge_snapshots.status <> 'ready'
       RETURNING *`,
      [input.id ?? randomUUID(), input.projectId, input.workspaceId, input.revision],
    );
    if (!rows[0]) {
      throw new AppError(
        "Knowledge Snapshot 已就绪，或 Project Workspace 不存在、未就绪、revision 不一致",
        409,
        "KNOWLEDGE_WORKSPACE_MISMATCH",
      );
    }
    return mapKnowledgeSnapshot(rows[0]);
  }

  async completeKnowledgeSnapshot(input: {
    id: string;
    manifestHash: string;
    summary: KnowledgeSummaryDto;
    indexData: unknown;
  }): Promise<KnowledgeSnapshotRecord> {
    const summary = knowledgeSummarySchema.parse(input.summary);
    const { rows } = await this.pool.query(
      `UPDATE knowledge_snapshots
       SET status = 'ready', manifest_hash = $1, summary = $2::jsonb,
           index_data = $3::jsonb, error_message = NULL,
           indexed_at = now(), updated_at = now()
       WHERE id = $4 AND status = 'indexing'
       RETURNING *`,
      [
        input.manifestHash,
        JSON.stringify(summary),
        JSON.stringify(input.indexData),
        input.id,
      ],
    );
    if (!rows[0]) {
      throw new AppError(
        "Knowledge Snapshot 不存在或状态已变化",
        409,
        "KNOWLEDGE_STATE_CHANGED",
      );
    }
    return mapKnowledgeSnapshot(rows[0]);
  }

  async failKnowledgeSnapshot(id: string, message: string): Promise<KnowledgeSnapshotRecord> {
    const { rows } = await this.pool.query(
      `UPDATE knowledge_snapshots
       SET status = 'failed', manifest_hash = NULL, summary = NULL,
           index_data = NULL, error_message = $1, indexed_at = NULL, updated_at = now()
       WHERE id = $2 AND status = 'indexing'
       RETURNING *`,
      [message, id],
    );
    if (!rows[0]) {
      throw new AppError(
        "Knowledge Snapshot 不存在或状态已变化",
        409,
        "KNOWLEDGE_STATE_CHANGED",
      );
    }
    return mapKnowledgeSnapshot(rows[0]);
  }

  async getKnowledgeSnapshot(id: string): Promise<KnowledgeSnapshotRecord> {
    const { rows } = await this.pool.query(
      "SELECT * FROM knowledge_snapshots WHERE id = $1",
      [id],
    );
    if (!rows[0]) throw notFound("Knowledge Snapshot");
    return mapKnowledgeSnapshot(rows[0]);
  }

  async getActiveKnowledgeSnapshot(projectId: string): Promise<KnowledgeSnapshotRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT ks.* FROM projects p
       JOIN knowledge_snapshots ks
         ON ks.project_id = p.id AND ks.revision = p.active_revision
       WHERE p.id = $1 AND ks.status = 'ready'
       ORDER BY ks.indexed_at DESC LIMIT 1`,
      [projectId],
    );
    return rows[0] ? mapKnowledgeSnapshot(rows[0]) : null;
  }

  async getKnowledgeSnapshotByRevision(
    projectId: string,
    revision: GitRevision,
  ): Promise<KnowledgeSnapshotRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM knowledge_snapshots
       WHERE project_id = $1 AND revision = $2 AND status = 'ready'
       ORDER BY indexed_at DESC LIMIT 1`,
      [projectId, revision],
    );
    return rows[0] ? mapKnowledgeSnapshot(rows[0]) : null;
  }

  async createAskThread(input: {
    id?: string;
    projectId: string;
    providerId: AskProviderId;
    revision: AskRevision;
    sourceRevision: GitRevision;
    title: string;
  }): Promise<AskThreadRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO ask_threads
         (id, project_id, provider_id, revision, source_revision, title, status)
       SELECT $1, p.id, $3, $4, $5, $6, 'active'
       FROM projects p
       WHERE p.id = $2 AND p.repository_state = 'ready'
         AND (
           (p.source_kind = 'remote_git' AND p.active_revision = $5)
           OR p.source_kind = 'legacy_local'
         )
       RETURNING *`,
      [
        input.id ?? randomUUID(),
        input.projectId,
        input.providerId,
        input.revision,
        input.sourceRevision,
        input.title,
      ],
    );
    if (!rows[0]) {
      throw new AppError(
        "项目源码与知识快照尚未就绪，不能创建 Ask Thread",
        409,
        "ASK_PROJECT_NOT_READY",
      );
    }
    return {
      ...mapAskThreadSummary({ ...rows[0], message_count: 0 }),
      messages: [],
    };
  }

  async listAskThreads(projectId: string): Promise<AskThreadSummaryDto[]> {
    await this.getProject(projectId);
    const { rows } = await this.pool.query(
      `SELECT at.*, count(am.id)::integer AS message_count
       FROM ask_threads at
       LEFT JOIN ask_messages am ON am.thread_id = at.id
       WHERE at.project_id = $1 AND at.source_revision IS NOT NULL
       GROUP BY at.id
       ORDER BY at.updated_at DESC`,
      [projectId],
    );
    return rows.map(mapAskThreadSummary);
  }

  async getAskThread(id: string): Promise<AskThreadRecord> {
    const [threadResult, messageResult] = await Promise.all([
      this.pool.query(
        `SELECT at.*, count(am.id)::integer AS message_count
         FROM ask_threads at
         LEFT JOIN ask_messages am ON am.thread_id = at.id
         WHERE at.id = $1 GROUP BY at.id`,
        [id],
      ),
      this.pool.query(
        "SELECT * FROM ask_messages WHERE thread_id = $1 ORDER BY sequence",
        [id],
      ),
    ]);
    if (!threadResult.rows[0]) throw notFound("Ask Thread");
    return {
      ...mapAskThreadSummary(threadResult.rows[0]),
      messages: messageResult.rows.map(mapAskThreadMessage),
    };
  }

  /**
   * Rejects a full or no-longer-writable Thread before an expensive Provider
   * call. The row lock makes the status/revision/capacity check one consistent
   * database observation; appendAskThreadTurn repeats the checks because this
   * transaction intentionally does not stay open while the model is running.
   */
  async assertAskThreadTurnCapacity(
    threadId: string,
    expectedRevision: AskRevision,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const threadResult = await client.query(
        "SELECT * FROM ask_threads WHERE id = $1 FOR UPDATE",
        [threadId],
      );
      const thread = threadResult.rows[0];
      if (!thread) throw notFound("Ask Thread");
      if (thread.status !== "active") {
        throw new AppError("Ask Thread 已归档", 409, "ASK_THREAD_ARCHIVED");
      }
      if (thread.revision !== expectedRevision) {
        throw new AppError(
          "页面中的 Ask revision 已过期，请刷新对话后重试",
          409,
          "ASK_THREAD_REVISION_MISMATCH",
        );
      }
      const sequenceResult = await client.query(
        "SELECT COALESCE(max(sequence), 0)::integer + 1 AS next_sequence FROM ask_messages WHERE thread_id = $1",
        [threadId],
      );
      assertAskThreadTurnCapacity(Number(sequenceResult.rows[0].next_sequence));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async appendAskThreadMessage(input: {
    threadId: string;
    role: AskThreadMessageDto["role"];
    content: string;
    answer?: AskAnswerDto | null;
  }): Promise<AskThreadRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const threadResult = await client.query(
        "SELECT * FROM ask_threads WHERE id = $1 FOR UPDATE",
        [input.threadId],
      );
      if (!threadResult.rows[0]) throw notFound("Ask Thread");
      if (threadResult.rows[0].status !== "active") {
        throw new AppError("Ask Thread 已归档", 409, "ASK_THREAD_ARCHIVED");
      }
      const answer = input.role === "assistant"
        ? askAnswerSchema.parse(input.answer)
        : null;
      if (answer && answer.revision !== threadResult.rows[0].revision) {
        throw new AppError(
          "Ask 回答 revision 与 Thread 固定 revision 不一致",
          409,
          "ASK_THREAD_REVISION_MISMATCH",
        );
      }
      if (input.role === "user" && input.answer != null) {
        throw new AppError("用户消息不能携带模型回答", 400, "ASK_MESSAGE_INVALID");
      }
      const sequenceResult = await client.query(
        "SELECT COALESCE(max(sequence), 0)::integer + 1 AS next_sequence FROM ask_messages WHERE thread_id = $1",
        [input.threadId],
      );
      const sequence = Number(sequenceResult.rows[0].next_sequence);
      if (sequence > 200) {
        throw askThreadLimitError();
      }
      await client.query(
        `INSERT INTO ask_messages (id, thread_id, sequence, role, content, answer)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          randomUUID(),
          input.threadId,
          sequence,
          input.role,
          input.content,
          answer ? JSON.stringify(answer) : null,
        ],
      );
      await client.query("UPDATE ask_threads SET updated_at = now() WHERE id = $1", [input.threadId]);
      await client.query("COMMIT");
      return await readAskThread(client, input.threadId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async appendAskThreadTurn(input: {
    threadId: string;
    question: string;
    answer: AskAnswerDto;
  }): Promise<AskThreadRecord> {
    const answer = askAnswerSchema.parse(input.answer);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const threadResult = await client.query(
        "SELECT * FROM ask_threads WHERE id = $1 FOR UPDATE",
        [input.threadId],
      );
      const thread = threadResult.rows[0];
      if (!thread) throw notFound("Ask Thread");
      if (thread.status !== "active") {
        throw new AppError("Ask Thread 已归档", 409, "ASK_THREAD_ARCHIVED");
      }
      if (thread.revision !== answer.revision) {
        throw new AppError(
          "Ask 回答 revision 与 Thread 固定 revision 不一致",
          409,
          "ASK_THREAD_REVISION_MISMATCH",
        );
      }
      const sequenceResult = await client.query(
        "SELECT COALESCE(max(sequence), 0)::integer + 1 AS next_sequence FROM ask_messages WHERE thread_id = $1",
        [input.threadId],
      );
      const sequence = Number(sequenceResult.rows[0].next_sequence);
      assertAskThreadTurnCapacity(sequence);
      await client.query(
        `INSERT INTO ask_messages (id, thread_id, sequence, role, content, answer)
         VALUES
           ($1, $2, $3, 'user', $4, NULL),
           ($5, $2, $6, 'assistant', $7, $8::jsonb)`,
        [
          randomUUID(),
          input.threadId,
          sequence,
          input.question,
          randomUUID(),
          sequence + 1,
          answer.answer,
          JSON.stringify(answer),
        ],
      );
      await client.query("UPDATE ask_threads SET updated_at = now() WHERE id = $1", [input.threadId]);
      await client.query("COMMIT");
      return await readAskThread(client, input.threadId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createAgentSession(input: {
    id?: string;
    title?: string;
    providerId?: AskProviderId;
    primaryRepository?: {
      projectId: string;
      workspaceId: string;
      sourceRevision: GitRevision;
    };
  }): Promise<AgentSessionDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionId = input.id ?? randomUUID();
      let providerId = input.providerId;
      let repositorySettings: ProjectAgentSettingsDto | null = null;
      if (input.primaryRepository) {
        repositorySettings = mapProjectAgentSettings(
          await ensureProjectAgentSettings(client, input.primaryRepository.projectId),
        );
        providerId ??= repositorySettings.defaultProviderId;
        await assertReadyProjectSnapshot(client, input.primaryRepository);
      }
      const { rows } = await client.query(
        `INSERT INTO agent_sessions
           (id, title, status, turn_state, current_provider_id)
         VALUES ($1, $2, 'active', 'idle', $3)
         RETURNING *`,
        [sessionId, input.title?.trim() || "新对话", providerId ?? "openai"],
      );
      if (input.primaryRepository && repositorySettings) {
        await client.query(
          `INSERT INTO agent_session_repositories
             (session_id, project_id, workspace_id, repo_alias, access_mode, source_revision)
           VALUES ($1, $2, $3, $4, 'write', $5)`,
          [
            sessionId,
            input.primaryRepository.projectId,
            input.primaryRepository.workspaceId,
            repositorySettings.repoAlias,
            input.primaryRepository.sourceRevision,
          ],
        );
      }
      const session = await readAgentSessionSummary(client, String(rows[0].id));
      await client.query("COMMIT");
      return session;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new AppError("Agent Session 或 Repo alias 已存在", 409, "AGENT_SESSION_EXISTS");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listAgentSessions(input: { projectId?: string } = {}): Promise<AgentSessionDto[]> {
    const { rows } = await this.pool.query(
      input.projectId
        ? `SELECT DISTINCT s.*
           FROM agent_sessions s
           JOIN agent_session_repositories sr ON sr.session_id = s.id
           WHERE sr.project_id = $1
           ORDER BY s.updated_at DESC`
        : "SELECT * FROM agent_sessions ORDER BY updated_at DESC",
      input.projectId ? [input.projectId] : [],
    );
    return Promise.all(rows.map((row) => readAgentSessionSummary(this.pool, String(row.id))));
  }

  async getAgentSession(id: string): Promise<AgentSessionRecord> {
    const summary = await readAgentSessionSummary(this.pool, id);
    const [messages, events, toolCalls, humanGates, sessionRuns] = await Promise.all([
      this.listAgentMessages(id),
      this.listAgentEvents(id),
      this.listAgentToolCalls(id),
      this.listAgentHumanGates(id),
      this.listAgentSessionRuns(id),
    ]);
    return { ...summary, messages, events, toolCalls, humanGates, sessionRuns };
  }

  async bindAgentSessionRepository(input: {
    sessionId: string;
    projectId: string;
    workspaceId: string;
    sourceRevision: GitRevision;
    accessMode: "write" | "read";
  }): Promise<AgentSessionDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionResult = await client.query(
        "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE",
        [input.sessionId],
      );
      const session = sessionResult.rows[0];
      if (!session) throw notFound("Agent Session");
      if (session.status !== "active" || session.turn_state !== "idle") {
        throw new AppError(
          "Agent Session 只有在空闲时才能修改仓库上下文",
          409,
          "AGENT_SESSION_CONTEXT_BUSY",
        );
      }
      const existing = await client.query(
        `SELECT * FROM agent_session_repositories
         WHERE session_id = $1 AND project_id = $2`,
        [input.sessionId, input.projectId],
      );
      if (existing.rows[0]) {
        const sameBinding = existing.rows[0].workspace_id === input.workspaceId
          && existing.rows[0].source_revision === input.sourceRevision
          && existing.rows[0].access_mode === input.accessMode;
        if (!sameBinding) {
          throw new AppError(
            "该仓库已经用不同 revision 或权限绑定到当前对话",
            409,
            "AGENT_REPOSITORY_BINDING_CONFLICT",
          );
        }
        const result = await readAgentSessionSummary(client, input.sessionId);
        await client.query("COMMIT");
        return result;
      }
      const repositoryCount = await client.query(
        "SELECT count(*)::integer AS count FROM agent_session_repositories WHERE session_id = $1",
        [input.sessionId],
      );
      if (Number(repositoryCount.rows[0]?.count ?? 0) >= 16) {
        throw new AppError(
          "一个 Agent Session 最多绑定 16 个仓库",
          409,
          "AGENT_REPOSITORY_LIMIT_REACHED",
        );
      }
      await assertReadyProjectSnapshot(client, input);
      const settings = mapProjectAgentSettings(
        await ensureProjectAgentSettings(client, input.projectId),
      );
      await client.query(
        `INSERT INTO agent_session_repositories
           (session_id, project_id, workspace_id, repo_alias, access_mode, source_revision)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.sessionId,
          input.projectId,
          input.workspaceId,
          settings.repoAlias,
          input.accessMode,
          input.sourceRevision,
        ],
      );
      const result = await readAgentSessionSummary(client, input.sessionId);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new AppError(
          "当前对话已存在可写主仓库或重复 Repo alias",
          409,
          "AGENT_REPOSITORY_BINDING_CONFLICT",
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Resolves globally unique Project aliases and binds their current immutable
   * snapshots as read-only context in one transaction. This is intentionally
   * callable only while the Session is idle, before beginAgentTurn persists a
   * user message, so an unknown or unready alias has no partial side effect.
   */
  async bindReadyAgentSessionReadRepositoriesByAlias(
    sessionId: string,
    aliases: readonly RepoAlias[],
  ): Promise<AgentSessionDto> {
    const requested = [...new Set(aliases.map((alias) => repoAliasSchema.parse(alias)))];
    if (requested.length === 0) return readAgentSessionSummary(this.pool, sessionId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionResult = await client.query(
        "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE",
        [sessionId],
      );
      const session = sessionResult.rows[0];
      if (!session) throw notFound("Agent Session");
      if (session.status !== "active") {
        throw new AppError(
          "Agent Session 已归档",
          409,
          "AGENT_SESSION_ARCHIVED",
        );
      }
      const existing = await client.query(
        `SELECT repo_alias
         FROM agent_session_repositories
         WHERE session_id = $1`,
        [sessionId],
      );
      const existingAliases = new Set(existing.rows.map((row) => String(row.repo_alias)));
      const missingAliases = requested.filter((alias) => !existingAliases.has(alias));
      if (missingAliases.length > 0 && session.turn_state !== "idle") {
        throw new AppError(
          "Agent Session 只有在空闲时才能自动加入新的 @repo",
          409,
          "AGENT_SESSION_CONTEXT_BUSY",
        );
      }
      if (existing.rows.length + missingAliases.length > 16) {
        throw new AppError(
          "一个 Agent Session 最多绑定 16 个仓库",
          409,
          "AGENT_REPOSITORY_LIMIT_REACHED",
        );
      }
      if (missingAliases.length > 0) {
        const resolved = await client.query(
          `SELECT pas.repo_alias, p.id AS project_id,
                  p.active_revision AS source_revision, mw.id AS workspace_id
           FROM project_agent_settings pas
           JOIN projects p ON p.id = pas.project_id
           JOIN managed_workspaces mw
             ON mw.project_id = p.id
            AND mw.purpose = 'project_snapshot'
            AND mw.active = true
            AND mw.state = 'ready'
            AND mw.revision = p.active_revision
           JOIN knowledge_snapshots ks
             ON ks.project_id = p.id
            AND ks.workspace_id = mw.id
            AND ks.revision = p.active_revision
            AND ks.status = 'ready'
           WHERE pas.repo_alias = ANY($1::text[])
             AND p.source_kind = 'remote_git'
             AND p.repository_state = 'ready'
             AND p.active_revision IS NOT NULL`,
          [missingAliases],
        );
        const byAlias = new Map(resolved.rows.map((row) => [String(row.repo_alias), row]));
        const unavailable = missingAliases.filter((alias) => !byAlias.has(alias));
        if (unavailable.length > 0) {
          throw new AppError(
            `这些 @repo 不存在或源码快照尚未 ready：${unavailable.map((alias) => `@${alias}`).join("、")}`,
            400,
            "AGENT_REPOSITORY_MENTION_UNKNOWN",
          );
        }
        for (const alias of missingAliases) {
          const repository = byAlias.get(alias)!;
          await client.query(
            `INSERT INTO agent_session_repositories
               (session_id, project_id, workspace_id, repo_alias, access_mode, source_revision)
             VALUES ($1, $2, $3, $4, 'read', $5)`,
            [
              sessionId,
              repository.project_id,
              repository.workspace_id,
              alias,
              repository.source_revision,
            ],
          );
        }
      }
      const result = await readAgentSessionSummary(client, sessionId);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new AppError(
          "@repo 已被当前会话以不同项目或权限绑定",
          409,
          "AGENT_REPOSITORY_BINDING_CONFLICT",
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async createAgentSandbox(input: {
    id?: string;
    sessionId: string;
    projectId: string;
    workspaceId: string;
    sourceRevision: GitRevision;
    expiresAt?: string | null;
  }): Promise<AgentSandboxDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await client.query(
        "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE",
        [input.sessionId],
      );
      if (!session.rows[0]) throw notFound("Agent Session");
      if (session.rows[0].status !== "active") {
        throw new AppError("已归档对话不能启动 Sandbox", 409, "AGENT_SESSION_ARCHIVED");
      }
      const binding = await client.query(
        `SELECT 1 FROM agent_session_repositories
         WHERE session_id = $1 AND project_id = $2 AND access_mode = 'write'
           AND source_revision = $3`,
        [input.sessionId, input.projectId, input.sourceRevision],
      );
      if (!binding.rows[0]) {
        throw new AppError(
          "Sandbox 必须属于对话的可写主仓库及其固定 revision",
          409,
          "AGENT_SANDBOX_REPOSITORY_MISMATCH",
        );
      }
      const workspace = await client.query(
        `SELECT * FROM managed_workspaces
         WHERE id = $1 AND project_id = $2 AND purpose = 'sandbox'
           AND state IN ('provisioning', 'ready')
           AND (revision IS NULL OR revision = $3)`,
        [input.workspaceId, input.projectId, input.sourceRevision],
      );
      if (!workspace.rows[0]) {
        throw new AppError(
          "Sandbox Workspace 不存在、状态不正确或 revision 不一致",
          409,
          "AGENT_SANDBOX_WORKSPACE_MISMATCH",
        );
      }
      const settings = mapProjectAgentSettings(
        await ensureProjectAgentSettings(client, input.projectId),
      );
      const { rows } = await client.query(
        `INSERT INTO agent_sandboxes
           (id, session_id, project_id, workspace_id, source_revision,
            blueprint_id, blueprint_version, state, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          input.id ?? randomUUID(),
          input.sessionId,
          input.projectId,
          input.workspaceId,
          input.sourceRevision,
          settings.sandboxBlueprintId,
          settings.sandboxBlueprintVersion,
          workspace.rows[0].state === "ready" ? "ready" : "starting",
          input.expiresAt ?? workspace.rows[0].expires_at ?? null,
        ],
      );
      await client.query("COMMIT");
      return mapAgentSandbox(rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new AppError(
          "当前对话已经绑定 Sandbox",
          409,
          "AGENT_SANDBOX_EXISTS",
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getAgentSandbox(sessionId: string): Promise<AgentSandboxDto | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM agent_sandboxes WHERE session_id = $1",
      [sessionId],
    );
    return rows[0] ? mapAgentSandbox(rows[0]) : null;
  }

  async getAgentSandboxWorkspace(sessionId: string): Promise<ManagedWorkspaceRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT mw.*
       FROM agent_sandboxes sandbox
       JOIN managed_workspaces mw ON mw.id = sandbox.workspace_id
       WHERE sandbox.session_id = $1`,
      [sessionId],
    );
    return rows[0] ? mapWorkspace(rows[0]) : null;
  }

  async transitionAgentSandbox(input: {
    id: string;
    expectedState: AgentSandboxState;
    state: AgentSandboxState;
    expiresAt?: string | null;
  }): Promise<AgentSandboxDto> {
    assertAgentSandboxTransition(input.expectedState, input.state);
    const { rows } = await this.pool.query(
      `UPDATE agent_sandboxes
       SET state = $1,
           expires_at = CASE WHEN $2::boolean THEN $3::timestamptz ELSE expires_at END,
           updated_at = now()
       WHERE id = $4 AND state = $5
       RETURNING *`,
      [input.state, input.expiresAt !== undefined, input.expiresAt ?? null, input.id, input.expectedState],
    );
    if (!rows[0]) {
      throw new AppError(
        "Sandbox 不存在或状态已变化",
        409,
        "AGENT_SANDBOX_STATE_CHANGED",
      );
    }
    return mapAgentSandbox(rows[0]);
  }

  async beginAgentTurn(input: {
    sessionId: string;
    clientMessageId: string;
    expectedSequence: number;
    content: string;
    providerId?: AskProviderId;
  }): Promise<BeginAgentTurnResult> {
    const request = sendAgentMessageSchema.parse({
      clientMessageId: input.clientMessageId,
      expectedSequence: input.expectedSequence,
      content: input.content,
      ...(input.providerId ? { providerId: input.providerId } : {}),
    });
    const fingerprint = agentMessageRequestFingerprint(request.content, request.providerId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionResult = await client.query(
        "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE",
        [input.sessionId],
      );
      const session = sessionResult.rows[0];
      if (!session) throw notFound("Agent Session");

      // Idempotency is checked before optimistic sequence/state validation so a
      // network retry can safely replay after the original turn has progressed.
      const duplicate = await client.query(
        `SELECT * FROM agent_messages
         WHERE session_id = $1 AND client_message_id = $2`,
        [input.sessionId, request.clientMessageId],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].request_fingerprint !== fingerprint) {
          throw new AppError(
            "clientMessageId 已用于另一条消息",
            409,
            "AGENT_MESSAGE_IDEMPOTENCY_CONFLICT",
          );
        }
        const message = mapAgentMessage(duplicate.rows[0]);
        await client.query("COMMIT");
        return { message, replayed: true };
      }
      if (session.status !== "active") {
        throw new AppError("Agent Session 已归档", 409, "AGENT_SESSION_ARCHIVED");
      }
      if (Number(session.last_message_sequence) !== request.expectedSequence) {
        throw new AppError(
          "对话序号已变化，请同步最新消息后重试",
          409,
          "AGENT_MESSAGE_SEQUENCE_CONFLICT",
          { expectedSequence: Number(session.last_message_sequence) },
        );
      }
      if (session.turn_state !== "idle") {
        throw new AppError(
          "上一轮对话尚未结束",
          409,
          "AGENT_TURN_IN_PROGRESS",
        );
      }
      const providerId = request.providerId ?? session.current_provider_id;
      const sequence = request.expectedSequence + 1;
      const messageResult = await client.query(
        `INSERT INTO agent_messages
           (id, session_id, sequence, role, status, content, provider_id,
            model, client_message_id, request_fingerprint)
         VALUES ($1, $2, $3, 'user', 'running', $4, $5, NULL, $6, $7)
         RETURNING *`,
        [
          randomUUID(),
          input.sessionId,
          sequence,
          request.content,
          providerId,
          request.clientMessageId,
          fingerprint,
        ],
      );
      await client.query(
        `UPDATE agent_sessions
         SET turn_state = 'running', current_provider_id = $1,
             last_message_sequence = $2, updated_at = now()
         WHERE id = $3`,
        [providerId, sequence, input.sessionId],
      );
      const message = mapAgentMessage(messageResult.rows[0]);
      await client.query("COMMIT");
      return { message, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async appendAgentMessage(input: {
    sessionId: string;
    clientMessageId: string;
    expectedSequence: number;
    content: string;
    providerId?: AskProviderId;
  }): Promise<BeginAgentTurnResult> {
    return this.beginAgentTurn(input);
  }

  async completeAgentTurn(input: {
    sessionId: string;
    userMessageId: string;
    content: string;
    providerId: AskProviderId;
    model: string;
  }): Promise<AgentMessageDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionResult = await client.query(
        "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE",
        [input.sessionId],
      );
      const session = sessionResult.rows[0];
      if (!session) throw notFound("Agent Session");
      const userResult = await client.query(
        `SELECT * FROM agent_messages
         WHERE id = $1 AND session_id = $2 AND role = 'user'
         FOR UPDATE`,
        [input.userMessageId, input.sessionId],
      );
      const userMessage = userResult.rows[0];
      if (!userMessage) throw notFound("Agent 用户消息");

      if (userMessage.status === "completed") {
        const replay = await client.query(
          `SELECT * FROM agent_messages
           WHERE session_id = $1 AND sequence = $2 AND role = 'assistant'`,
          [input.sessionId, Number(userMessage.sequence) + 1],
        );
        if (
          replay.rows[0]
          && replay.rows[0].content === input.content.trim()
          && replay.rows[0].provider_id === input.providerId
          && replay.rows[0].model === input.model.trim()
        ) {
          const message = mapAgentMessage(replay.rows[0]);
          await client.query("COMMIT");
          return message;
        }
        throw new AppError(
          "这一轮已经用不同回答完成",
          409,
          "AGENT_TURN_COMPLETION_CONFLICT",
        );
      }
      if (
        userMessage.status !== "running"
        || session.turn_state !== "running"
        || Number(session.last_message_sequence) !== Number(userMessage.sequence)
      ) {
        throw new AppError(
          "Agent Turn 状态已变化",
          409,
          "AGENT_TURN_STATE_CHANGED",
        );
      }
      if (userMessage.provider_id !== input.providerId) {
        throw new AppError(
          "回答 Provider 与本轮选择不一致",
          409,
          "AGENT_TURN_PROVIDER_MISMATCH",
        );
      }
      const assistantId = randomUUID();
      const sequence = Number(userMessage.sequence) + 1;
      const candidate = agentMessageSchema.parse({
        id: assistantId,
        sessionId: input.sessionId,
        sequence,
        role: "assistant",
        status: "completed",
        content: input.content,
        providerId: input.providerId,
        model: input.model,
        clientMessageId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const assistantResult = await client.query(
        `INSERT INTO agent_messages
           (id, session_id, sequence, role, status, content, provider_id, model,
            client_message_id, request_fingerprint)
         VALUES ($1, $2, $3, 'assistant', 'completed', $4, $5, $6, NULL, NULL)
         RETURNING *`,
        [assistantId, input.sessionId, sequence, candidate.content, input.providerId, candidate.model],
      );
      await client.query(
        "UPDATE agent_messages SET status = 'completed', updated_at = now() WHERE id = $1",
        [input.userMessageId],
      );
      await client.query(
        `UPDATE agent_sessions
         SET turn_state = 'idle', last_message_sequence = $1, updated_at = now()
         WHERE id = $2`,
        [sequence, input.sessionId],
      );
      const message = mapAgentMessage(assistantResult.rows[0]);
      await client.query("COMMIT");
      return message;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failAgentTurn(input: {
    sessionId: string;
    userMessageId: string;
  }): Promise<AgentMessageDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await client.query(
        "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE",
        [input.sessionId],
      );
      if (!session.rows[0]) throw notFound("Agent Session");
      const { rows } = await client.query(
        `UPDATE agent_messages
         SET status = 'failed', updated_at = now()
         WHERE id = $1 AND session_id = $2 AND role = 'user' AND status = 'running'
         RETURNING *`,
        [input.userMessageId, input.sessionId],
      );
      if (!rows[0]) {
        throw new AppError(
          "Agent Turn 不存在或状态已变化",
          409,
          "AGENT_TURN_STATE_CHANGED",
        );
      }
      await client.query(
        `UPDATE agent_sessions
         SET turn_state = 'interrupted', updated_at = now()
         WHERE id = $1`,
        [input.sessionId],
      );
      const message = mapAgentMessage(rows[0]);
      await client.query("COMMIT");
      return message;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resetInterruptedAgentSession(sessionId: string): Promise<AgentSessionDto> {
    const { rows } = await this.pool.query(
      `UPDATE agent_sessions
       SET turn_state = 'idle', updated_at = now()
       WHERE id = $1 AND status = 'active' AND turn_state = 'interrupted'
       RETURNING *`,
      [sessionId],
    );
    if (!rows[0]) {
      throw new AppError(
        "Agent Session 不存在或无需恢复",
        409,
        "AGENT_SESSION_NOT_INTERRUPTED",
      );
    }
    return readAgentSessionSummary(this.pool, sessionId);
  }

  /**
   * Fail closed after a process restart. In-memory turn workers and DeepWiki
   * generators cannot be resumed safely, so their durable rows are finalized
   * with a public reason and Sessions become usable again. No queued external
   * side effect is replayed.
   */
  async recoverChatAgentRuntimeAfterRestart(): Promise<{
    sessions: number;
    messages: number;
    toolCalls: number;
    humanGates: number;
    sandboxes: number;
    deepWikiGenerations: number;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const messages = await client.query(
        `UPDATE agent_messages
         SET status = 'failed', updated_at = now()
         WHERE status = 'running'
           AND session_id IN (
             SELECT id FROM agent_sessions
             WHERE status = 'active' AND turn_state IN ('running', 'waiting_human')
           )`,
      );
      const toolCalls = await client.query(
        `UPDATE agent_tool_calls
         SET status = 'failed', approval = CASE
               WHEN approval = 'required' THEN 'denied' ELSE approval END,
             error_message = '服务重启前工具没有完成；平台没有自动重放',
             finished_at = now()
         WHERE status IN ('queued', 'running')`,
      );
      const humanGates = await client.query(
        `UPDATE agent_human_gates
         SET status = 'cancelled', response_comment = '服务重启后已安全取消，请重新发起',
             resolved_at = now()
         WHERE status = 'pending'`,
      );
      const sessions = await client.query(
        `UPDATE agent_sessions
         SET turn_state = 'idle', updated_at = now()
         WHERE status = 'active' AND turn_state IN ('running', 'waiting_human', 'interrupted')`,
      );
      const sandboxes = await client.query(
        `UPDATE agent_sandboxes
         SET state = 'failed', updated_at = now()
         WHERE state = 'starting'`,
      );
      const deepWikiGenerations = await client.query(
        `UPDATE deepwiki_generations
         SET status = 'failed', content = NULL,
             error_message = '服务重启前生成没有完成，请手工重试',
             generated_at = now(), updated_at = now()
         WHERE status IN ('queued', 'scanning', 'generating', 'validating')`,
      );
      await client.query("COMMIT");
      return {
        sessions: sessions.rowCount ?? 0,
        messages: messages.rowCount ?? 0,
        toolCalls: toolCalls.rowCount ?? 0,
        humanGates: humanGates.rowCount ?? 0,
        sandboxes: sandboxes.rowCount ?? 0,
        deepWikiGenerations: deepWikiGenerations.rowCount ?? 0,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async appendAgentTurn(input: {
    sessionId: string;
    clientMessageId: string;
    expectedSequence: number;
    content: string;
    providerId?: AskProviderId;
    assistantContent: string;
    model: string;
  }): Promise<AppendAgentTurnResult> {
    const request = sendAgentMessageSchema.parse({
      clientMessageId: input.clientMessageId,
      expectedSequence: input.expectedSequence,
      content: input.content,
      ...(input.providerId ? { providerId: input.providerId } : {}),
    });
    const fingerprint = agentMessageRequestFingerprint(request.content, request.providerId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionResult = await client.query(
        "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE",
        [input.sessionId],
      );
      const session = sessionResult.rows[0];
      if (!session) throw notFound("Agent Session");
      const duplicate = await client.query(
        `SELECT * FROM agent_messages
         WHERE session_id = $1 AND client_message_id = $2`,
        [input.sessionId, request.clientMessageId],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].request_fingerprint !== fingerprint) {
          throw new AppError(
            "clientMessageId 已用于另一条消息",
            409,
            "AGENT_MESSAGE_IDEMPOTENCY_CONFLICT",
          );
        }
        const assistant = await client.query(
          `SELECT * FROM agent_messages
           WHERE session_id = $1 AND sequence = $2 AND role = 'assistant'`,
          [input.sessionId, Number(duplicate.rows[0].sequence) + 1],
        );
        if (!assistant.rows[0]) {
          throw new AppError("这一轮仍在处理中", 409, "AGENT_TURN_IN_PROGRESS");
        }
        const result = {
          userMessage: mapAgentMessage(duplicate.rows[0]),
          assistantMessage: mapAgentMessage(assistant.rows[0]),
          replayed: true,
        };
        await client.query("COMMIT");
        return result;
      }
      if (session.status !== "active") {
        throw new AppError("Agent Session 已归档", 409, "AGENT_SESSION_ARCHIVED");
      }
      if (Number(session.last_message_sequence) !== request.expectedSequence) {
        throw new AppError(
          "对话序号已变化，请同步最新消息后重试",
          409,
          "AGENT_MESSAGE_SEQUENCE_CONFLICT",
          { expectedSequence: Number(session.last_message_sequence) },
        );
      }
      if (session.turn_state !== "idle") {
        throw new AppError("上一轮对话尚未结束", 409, "AGENT_TURN_IN_PROGRESS");
      }
      const providerId = request.providerId ?? session.current_provider_id;
      const userSequence = request.expectedSequence + 1;
      const assistantSequence = userSequence + 1;
      const userId = randomUUID();
      const assistantId = randomUUID();
      const now = new Date().toISOString();
      const assistant = agentMessageSchema.parse({
        id: assistantId,
        sessionId: input.sessionId,
        sequence: assistantSequence,
        role: "assistant",
        status: "completed",
        content: input.assistantContent,
        providerId,
        model: input.model,
        clientMessageId: null,
        createdAt: now,
        updatedAt: now,
      });
      const inserted = await client.query(
        `INSERT INTO agent_messages
           (id, session_id, sequence, role, status, content, provider_id, model,
            client_message_id, request_fingerprint)
         VALUES
           ($1, $2, $3, 'user', 'completed', $4, $5, NULL, $6, $7),
           ($8, $2, $9, 'assistant', 'completed', $10, $5, $11, NULL, NULL)
         RETURNING *`,
        [
          userId,
          input.sessionId,
          userSequence,
          request.content,
          providerId,
          request.clientMessageId,
          fingerprint,
          assistantId,
          assistantSequence,
          assistant.content,
          assistant.model,
        ],
      );
      await client.query(
        `UPDATE agent_sessions
         SET turn_state = 'idle', current_provider_id = $1,
             last_message_sequence = $2, updated_at = now()
         WHERE id = $3`,
        [providerId, assistantSequence, input.sessionId],
      );
      const userRow = inserted.rows.find((row) => row.role === "user");
      const assistantRow = inserted.rows.find((row) => row.role === "assistant");
      if (!userRow || !assistantRow) {
        throw new AppError("Agent Turn 持久化结果不完整", 500, "AGENT_TURN_PERSISTENCE_FAILED");
      }
      const result = {
        userMessage: mapAgentMessage(userRow),
        assistantMessage: mapAgentMessage(assistantRow),
        replayed: false,
      };
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listAgentMessages(sessionId: string): Promise<AgentMessageDto[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM agent_messages WHERE session_id = $1 ORDER BY sequence",
      [sessionId],
    );
    return rows.map(mapAgentMessage);
  }

  async appendAgentEvent(input: {
    id?: string;
    sessionId: string;
    kind: AgentEventKind;
    status: AgentEventDto["status"];
    summary: string;
    messageId?: string | null;
    toolCallId?: string | null;
    projectId?: string | null;
    workflowRunId?: string | null;
    phaseId?: PhaseId | null;
  }): Promise<AgentEventDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionResult = await client.query(
        "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE",
        [input.sessionId],
      );
      const session = sessionResult.rows[0];
      if (!session) throw notFound("Agent Session");
      await assertAgentEventReferences(client, input);
      const sequence = Number(session.last_event_sequence) + 1;
      const eventId = input.id ?? randomUUID();
      const now = new Date().toISOString();
      const event = agentEventSchema.parse({
        id: eventId,
        sessionId: input.sessionId,
        sequence,
        kind: input.kind,
        status: input.status,
        summary: input.summary,
        messageId: input.messageId ?? null,
        toolCallId: input.toolCallId ?? null,
        projectId: input.projectId ?? null,
        workflowRunId: input.workflowRunId ?? null,
        phaseId: input.phaseId ?? null,
        createdAt: now,
      });
      const { rows } = await client.query(
        `INSERT INTO agent_events
           (id, session_id, sequence, kind, status, summary, message_id,
            tool_call_id, project_id, workflow_run_id, phase_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          event.id,
          event.sessionId,
          event.sequence,
          event.kind,
          event.status,
          event.summary,
          event.messageId,
          event.toolCallId,
          event.projectId,
          event.workflowRunId,
          event.phaseId,
        ],
      );
      await client.query(
        `UPDATE agent_sessions
         SET last_event_sequence = $1, updated_at = now()
         WHERE id = $2`,
        [sequence, input.sessionId],
      );
      const persisted = mapAgentEvent(rows[0]);
      await client.query("COMMIT");
      return persisted;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listAgentEvents(sessionId: string): Promise<AgentEventDto[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM agent_events WHERE session_id = $1 ORDER BY sequence",
      [sessionId],
    );
    return rows.map(mapAgentEvent);
  }

  async createAgentToolCall(input: {
    id?: string;
    sessionId: string;
    messageId: string;
    callKey: string;
    mcpServerId: string;
    toolName: string;
    permissionClass: McpToolPermissionClass;
    approval?: AgentToolCallDto["approval"];
    argumentsSha256: string;
  }): Promise<CreateAgentToolCallResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionResult = await client.query(
        "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE",
        [input.sessionId],
      );
      const session = sessionResult.rows[0];
      if (!session) throw notFound("Agent Session");
      if (session.status !== "active" || !["running", "waiting_human"].includes(session.turn_state)) {
        throw new AppError(
          "当前 Agent Turn 不能创建 Tool Call",
          409,
          "AGENT_TOOL_TURN_INACTIVE",
        );
      }
      const message = await client.query(
        `SELECT 1 FROM agent_messages
         WHERE id = $1 AND session_id = $2 AND role = 'user' AND status = 'running'`,
        [input.messageId, input.sessionId],
      );
      if (!message.rows[0]) {
        throw new AppError(
          "Tool Call 必须属于当前正在运行的用户消息",
          409,
          "AGENT_TOOL_MESSAGE_MISMATCH",
        );
      }
      const enabled = await client.query(
        `SELECT 1
         FROM agent_session_repositories sr
         JOIN project_agent_settings ps ON ps.project_id = sr.project_id
         WHERE sr.session_id = $1 AND sr.access_mode = 'write'
           AND ps.enabled_mcp_server_ids ? $2
         LIMIT 1`,
        [input.sessionId, input.mcpServerId],
      );
      if (!enabled.rows[0]) {
        throw new AppError(
          "这个 MCP 尚未在主仓库项目中启用",
          403,
          "AGENT_MCP_NOT_ENABLED",
        );
      }
      const existing = await client.query(
        `SELECT * FROM agent_tool_calls
         WHERE message_id = $1 AND call_key = $2`,
        [input.messageId, input.callKey],
      );
      if (existing.rows[0]) {
        const sameCall = existing.rows[0].session_id === input.sessionId
          && existing.rows[0].mcp_server_id === input.mcpServerId
          && existing.rows[0].tool_name === input.toolName
          && existing.rows[0].permission_class === input.permissionClass
          && existing.rows[0].arguments_sha256 === input.argumentsSha256;
        if (!sameCall) {
          throw new AppError(
            "Tool callKey 已用于不同调用",
            409,
            "AGENT_TOOL_IDEMPOTENCY_CONFLICT",
          );
        }
        const toolCall = mapAgentToolCall(existing.rows[0]);
        await client.query("COMMIT");
        return { toolCall, replayed: true };
      }
      const externalSideEffect = isHighRiskToolPermission(input.permissionClass);
      const approval = externalSideEffect ? "required" : "not-required";
      if (input.approval !== undefined && input.approval !== approval) {
        throw new AppError(
          "Tool Call approval 由平台权限策略决定，调用方不能覆盖",
          403,
          "AGENT_TOOL_APPROVAL_OVERRIDE_FORBIDDEN",
        );
      }
      const toolCallId = input.id ?? randomUUID();
      const now = new Date().toISOString();
      const toolCall = agentToolCallSchema.parse({
        id: toolCallId,
        sessionId: input.sessionId,
        messageId: input.messageId,
        mcpServerId: input.mcpServerId,
        toolName: input.toolName,
        permissionClass: input.permissionClass,
        approval,
        status: "queued",
        argumentsSha256: input.argumentsSha256,
        outputSha256: null,
        summary: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
      });
      const { rows } = await client.query(
        `INSERT INTO agent_tool_calls
           (id, session_id, message_id, call_key, mcp_server_id, tool_name,
            permission_class, approval, status, arguments_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9)
         RETURNING *`,
        [
          toolCall.id,
          toolCall.sessionId,
          toolCall.messageId,
          input.callKey,
          toolCall.mcpServerId,
          toolCall.toolName,
          toolCall.permissionClass,
          toolCall.approval,
          toolCall.argumentsSha256,
        ],
      );
      const persisted = mapAgentToolCall(rows[0]);
      await client.query("COMMIT");
      return { toolCall: persisted, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateAgentToolCall(input: {
    id: string;
    expectedStatus: AgentToolCallDto["status"];
    status: AgentToolCallDto["status"];
    outputSha256?: string | null;
    summary?: string | null;
    errorMessage?: string | null;
  }): Promise<AgentToolCallDto> {
    const existingResult = await this.pool.query(
      "SELECT * FROM agent_tool_calls WHERE id = $1",
      [input.id],
    );
    const existing = existingResult.rows[0];
    if (!existing) throw notFound("Agent Tool Call");
    assertAgentToolCallTransition(existing.status, input.status);
    const approval = existing.approval;
    if (
      isHighRiskToolPermission(existing.permission_class)
      && ["running", "completed"].includes(input.status)
      && approval !== "approved"
    ) {
      throw new AppError(
        "高风险 Tool Call 未经批准不能执行",
        409,
        "AGENT_TOOL_APPROVAL_REQUIRED",
      );
    }
    const startedAt = input.status === "running"
      ? new Date().toISOString()
      : existing.started_at;
    const finishedAt = ["completed", "failed", "cancelled"].includes(input.status)
      ? new Date().toISOString()
      : null;
    const candidate = agentToolCallSchema.parse({
      ...mapAgentToolCall(existing),
      status: input.status,
      approval,
      outputSha256: input.outputSha256 ?? existing.output_sha256 ?? null,
      summary: input.summary ?? existing.summary ?? null,
      errorMessage: input.errorMessage ?? existing.error_message ?? null,
      startedAt: startedAt ? iso(startedAt) : null,
      finishedAt,
    });
    const { rows } = await this.pool.query(
      `UPDATE agent_tool_calls
       SET status = $1, approval = $2, output_sha256 = $3,
           summary = $4, error_message = $5,
           started_at = $6, finished_at = $7
       WHERE id = $8 AND status = $9
       RETURNING *`,
      [
        candidate.status,
        candidate.approval,
        candidate.outputSha256,
        candidate.summary,
        candidate.errorMessage,
        candidate.startedAt,
        candidate.finishedAt,
        input.id,
        input.expectedStatus,
      ],
    );
    if (!rows[0]) {
      throw new AppError(
        "Tool Call 状态已变化",
        409,
        "AGENT_TOOL_STATE_CHANGED",
      );
    }
    return mapAgentToolCall(rows[0]);
  }

  async listAgentToolCalls(sessionId: string): Promise<AgentToolCallDto[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM agent_tool_calls WHERE session_id = $1 ORDER BY created_at, id",
      [sessionId],
    );
    return rows.map(mapAgentToolCall);
  }

  async createAgentHumanGate(input: {
    id?: string;
    sessionId: string;
    messageId: string;
    toolCallId?: string | null;
    category: AgentHumanGateCategory;
    question: string;
    choices: AgentHumanGateDto["choices"];
  }): Promise<AgentHumanGateDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await client.query(
        "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE",
        [input.sessionId],
      );
      if (!session.rows[0]) throw notFound("Agent Session");
      if (session.rows[0].status !== "active" || session.rows[0].turn_state !== "running") {
        throw new AppError(
          "只有运行中的 Agent Turn 可以请求人工决定",
          409,
          "AGENT_HUMAN_GATE_TURN_INACTIVE",
        );
      }
      const message = await client.query(
        `SELECT 1 FROM agent_messages
         WHERE id = $1 AND session_id = $2 AND role = 'user' AND status = 'running'`,
        [input.messageId, input.sessionId],
      );
      if (!message.rows[0]) {
        throw new AppError("Human Gate 消息不属于当前 Turn", 409, "AGENT_HUMAN_GATE_MESSAGE_MISMATCH");
      }
      if (input.toolCallId) {
        const tool = await client.query(
          `SELECT permission_class FROM agent_tool_calls
           WHERE id = $1 AND session_id = $2 AND message_id = $3
             AND approval = 'required' AND status = 'queued'`,
          [input.toolCallId, input.sessionId, input.messageId],
        );
        if (!tool.rows[0]) {
          throw new AppError(
            "Human Gate 对应的 Tool Call 不存在或不需要批准",
            409,
            "AGENT_HUMAN_GATE_TOOL_MISMATCH",
          );
        }
        const expectedCategory = toolPermissionHumanGateCategory(tool.rows[0].permission_class);
        if (input.category !== expectedCategory) {
          throw new AppError(
            `这个 Tool Call 必须使用 ${expectedCategory} Human Gate`,
            409,
            "AGENT_HUMAN_GATE_CATEGORY_MISMATCH",
          );
        }
      }
      const gateId = input.id ?? randomUUID();
      const now = new Date().toISOString();
      const gate = agentHumanGateSchema.parse({
        id: gateId,
        sessionId: input.sessionId,
        messageId: input.messageId,
        category: input.category,
        status: "pending",
        question: input.question,
        choices: input.choices,
        selectedChoiceId: null,
        responseComment: null,
        createdAt: now,
        resolvedAt: null,
      });
      const { rows } = await client.query(
        `INSERT INTO agent_human_gates
           (id, session_id, message_id, tool_call_id, category, status,
            question, choices)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7::jsonb)
         RETURNING *`,
        [
          gate.id,
          gate.sessionId,
          gate.messageId,
          input.toolCallId ?? null,
          gate.category,
          gate.question,
          JSON.stringify(gate.choices),
        ],
      );
      await client.query(
        "UPDATE agent_sessions SET turn_state = 'waiting_human', updated_at = now() WHERE id = $1",
        [input.sessionId],
      );
      const persisted = mapAgentHumanGate(rows[0]);
      await client.query("COMMIT");
      return persisted;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new AppError("该 Tool Call 已有 Human Gate", 409, "AGENT_HUMAN_GATE_EXISTS");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveAgentHumanGate(input: {
    id: string;
    status: "approved" | "rejected" | "cancelled";
    selectedChoiceId?: string | null;
    responseComment?: string | null;
  }): Promise<AgentHumanGateDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const gateResult = await client.query(
        "SELECT * FROM agent_human_gates WHERE id = $1 FOR UPDATE",
        [input.id],
      );
      const gate = gateResult.rows[0];
      if (!gate) throw notFound("Agent Human Gate");
      const session = await client.query(
        "SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE",
        [gate.session_id],
      );
      if (!session.rows[0]) throw notFound("Agent Session");
      if (gate.status !== "pending" || session.rows[0].turn_state !== "waiting_human") {
        throw new AppError("Human Gate 已处理或 Turn 状态已变化", 409, "AGENT_HUMAN_GATE_STATE_CHANGED");
      }
      const resolvedAt = new Date().toISOString();
      const candidate = agentHumanGateSchema.parse({
        ...mapAgentHumanGate(gate),
        status: input.status,
        selectedChoiceId: input.selectedChoiceId ?? null,
        responseComment: input.responseComment?.trim() || null,
        resolvedAt,
      });
      const { rows } = await client.query(
        `UPDATE agent_human_gates
         SET status = $1, selected_choice_id = $2, response_comment = $3,
             resolved_at = $4
         WHERE id = $5 AND status = 'pending'
         RETURNING *`,
        [
          candidate.status,
          candidate.selectedChoiceId,
          candidate.responseComment,
          candidate.resolvedAt,
          input.id,
        ],
      );
      if (!rows[0]) {
        throw new AppError("Human Gate 状态已变化", 409, "AGENT_HUMAN_GATE_STATE_CHANGED");
      }
      if (gate.tool_call_id) {
        const tool = await client.query(
          `UPDATE agent_tool_calls
           SET approval = $1
           WHERE id = $2 AND approval = 'required' AND status = 'queued'`,
          [input.status === "approved" ? "approved" : "denied", gate.tool_call_id],
        );
        if (tool.rowCount !== 1) {
          throw new AppError(
            "Human Gate 对应的 Tool Call 状态已变化",
            409,
            "AGENT_HUMAN_GATE_TOOL_STATE_CHANGED",
          );
        }
      }
      await client.query(
        `UPDATE agent_sessions
         SET turn_state = $1, updated_at = now()
         WHERE id = $2`,
        [input.status === "approved" ? "running" : "interrupted", gate.session_id],
      );
      const persisted = mapAgentHumanGate(rows[0]);
      await client.query("COMMIT");
      return persisted;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listAgentHumanGates(sessionId: string): Promise<AgentHumanGateDto[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM agent_human_gates WHERE session_id = $1 ORDER BY created_at, id",
      [sessionId],
    );
    return rows.map(mapAgentHumanGate);
  }

  async attachAgentSessionRun(input: {
    sessionId: string;
    triggerMessageId: string;
    workflowRunId: string;
  }): Promise<{ sessionId: string; triggerMessageId: string; workflowRunId: string; createdAt: string }> {
    const { rows } = await this.pool.query(
      `INSERT INTO agent_session_runs
         (session_id, trigger_message_id, workflow_run_id)
       SELECT $1, am.id, wr.id
       FROM agent_messages am
       JOIN agent_sessions s ON s.id = am.session_id
       JOIN workflow_runs wr ON wr.id = $3
       JOIN agent_session_repositories sr
         ON sr.session_id = s.id AND sr.project_id = wr.project_id AND sr.access_mode = 'write'
       WHERE am.id = $2 AND am.session_id = $1 AND am.role = 'user'
       ON CONFLICT (workflow_run_id) DO UPDATE
         SET trigger_message_id = agent_session_runs.trigger_message_id
       RETURNING *`,
      [input.sessionId, input.triggerMessageId, input.workflowRunId],
    );
    if (!rows[0]) {
      throw new AppError(
        "SDLC Run 必须属于当前对话的可写主仓库并由当前消息触发",
        409,
        "AGENT_SESSION_RUN_MISMATCH",
      );
    }
    if (rows[0].trigger_message_id !== input.triggerMessageId) {
      throw new AppError(
        "SDLC Run 已由另一条消息触发",
        409,
        "AGENT_SESSION_RUN_IDEMPOTENCY_CONFLICT",
      );
    }
    return {
      sessionId: String(rows[0].session_id),
      triggerMessageId: String(rows[0].trigger_message_id),
      workflowRunId: String(rows[0].workflow_run_id),
      createdAt: iso(rows[0].created_at),
    };
  }

  async listAgentSessionRuns(sessionId: string): Promise<AgentSessionRunRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT session_id, trigger_message_id, workflow_run_id, created_at
       FROM agent_session_runs
       WHERE session_id = $1
       ORDER BY created_at, workflow_run_id`,
      [sessionId],
    );
    return rows.map(mapAgentSessionRun);
  }

  async createDeepWikiGeneration(input: {
    id?: string;
    projectId: string;
    workspaceId: string;
    revision: GitRevision;
    providerId: AskProviderId;
    clientRequestId?: string;
    promptVersion?: string;
  }): Promise<DeepWikiGenerationDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query(
        "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
        [input.projectId],
      );
      if (!project.rows[0]) throw notFound("项目");
      if (input.clientRequestId) {
        const replay = await client.query(
          `SELECT * FROM deepwiki_generations
           WHERE project_id = $1 AND client_request_id = $2`,
          [input.projectId, input.clientRequestId],
        );
        if (replay.rows[0]) {
          const sameRequest = replay.rows[0].workspace_id === input.workspaceId
            && replay.rows[0].revision === input.revision
            && replay.rows[0].provider_id === input.providerId
            && replay.rows[0].prompt_version === (input.promptVersion ?? "deepwiki-v1");
          if (!sameRequest) {
            throw new AppError(
              "clientRequestId 已用于另一项 DeepWiki 生成",
              409,
              "DEEPWIKI_IDEMPOTENCY_CONFLICT",
            );
          }
          const generation = mapDeepWikiGeneration(replay.rows[0]);
          await client.query("COMMIT");
          return generation;
        }
      }
      await assertReadyProjectSnapshot(client, input);
      const active = await client.query(
        `SELECT * FROM deepwiki_generations
         WHERE project_id = $1 AND revision = $2
           AND status IN ('queued', 'scanning', 'generating', 'validating')
         FOR UPDATE`,
        [input.projectId, input.revision],
      );
      if (active.rows[0]) {
        throw new AppError(
          "这个 revision 的 DeepWiki 正在生成",
          409,
          "DEEPWIKI_GENERATION_IN_PROGRESS",
          { generationId: String(active.rows[0].id) },
        );
      }
      const { rows } = await client.query(
        `INSERT INTO deepwiki_generations
           (id, project_id, workspace_id, revision, provider_id, prompt_version,
            status, client_request_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7)
         RETURNING *`,
        [
          input.id ?? randomUUID(),
          input.projectId,
          input.workspaceId,
          input.revision,
          input.providerId,
          input.promptVersion ?? "deepwiki-v1",
          input.clientRequestId ?? null,
        ],
      );
      const generation = mapDeepWikiGeneration(rows[0]);
      await client.query("COMMIT");
      return generation;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new AppError(
          "这个 revision 的 DeepWiki 正在生成",
          409,
          "DEEPWIKI_GENERATION_IN_PROGRESS",
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async transitionDeepWikiGeneration(input: {
    id: string;
    expectedStatus: DeepWikiGenerationStatus;
    status: DeepWikiGenerationStatus;
  }): Promise<DeepWikiGenerationDto> {
    assertDeepWikiTransition(input.expectedStatus, input.status);
    const { rows } = await this.pool.query(
      `UPDATE deepwiki_generations
       SET status = $1, updated_at = now()
       WHERE id = $2 AND status = $3
       RETURNING *`,
      [input.status, input.id, input.expectedStatus],
    );
    if (!rows[0]) {
      throw new AppError(
        "DeepWiki 生成不存在或状态已变化",
        409,
        "DEEPWIKI_STATE_CHANGED",
      );
    }
    return mapDeepWikiGeneration(rows[0]);
  }

  async completeDeepWikiGeneration(input: {
    id: string;
    model: string;
    content: string;
    citations: DeepWikiCitationDto[];
    usage: DeepWikiGenerationDto["usage"];
    manifestHash?: string;
  }): Promise<DeepWikiGenerationDto> {
    const citations = input.citations.map((citation) => deepWikiCitationSchema.parse(citation));
    if (citations.length > 500) {
      throw new AppError("DeepWiki 引用不能超过 500 条", 400, "DEEPWIKI_CITATION_LIMIT");
    }
    const content = assertSafeStoredText(input.content, 500_000, "DeepWiki content");
    const model = assertSafeStoredText(input.model, 256, "DeepWiki model");
    const manifestHash = input.manifestHash
      ?? createHash("sha256").update(JSON.stringify({ content, citations })).digest("hex");
    if (!/^[a-f0-9]{64}$/u.test(manifestHash)) {
      throw new AppError("DeepWiki manifest hash 格式无效", 400, "DEEPWIKI_MANIFEST_INVALID");
    }
    const usage = {
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
    };
    for (const value of [usage.inputTokens, usage.outputTokens]) {
      if (value !== null && (!Number.isInteger(value) || value < 0)) {
        throw new AppError("DeepWiki token usage 格式无效", 400, "DEEPWIKI_USAGE_INVALID");
      }
    }
    const { rows } = await this.pool.query(
      `UPDATE deepwiki_generations
       SET status = 'ready', model = $1, content = $2, citations = $3::jsonb,
           input_tokens = $4, output_tokens = $5, manifest_hash = $6,
           error_message = NULL, generated_at = now(), stale_at = NULL,
           updated_at = now()
       WHERE id = $7 AND status IN ('queued', 'scanning', 'generating', 'validating')
       RETURNING *`,
      [
        model,
        content,
        JSON.stringify(citations),
        usage.inputTokens,
        usage.outputTokens,
        manifestHash,
        input.id,
      ],
    );
    if (!rows[0]) {
      throw new AppError(
        "DeepWiki 生成不存在或状态已变化",
        409,
        "DEEPWIKI_STATE_CHANGED",
      );
    }
    return mapDeepWikiGeneration(rows[0]);
  }

  async failDeepWikiGeneration(id: string, message: string): Promise<DeepWikiGenerationDto> {
    const safeMessage = assertSafeStoredText(message, 1_000, "DeepWiki error");
    const { rows } = await this.pool.query(
      `UPDATE deepwiki_generations
       SET status = 'failed', model = NULL, manifest_hash = NULL,
           content = NULL, citations = '[]'::jsonb,
           input_tokens = NULL, output_tokens = NULL,
           error_message = $1, generated_at = now(), stale_at = NULL,
           updated_at = now()
       WHERE id = $2 AND status IN ('queued', 'scanning', 'generating', 'validating')
       RETURNING *`,
      [safeMessage, id],
    );
    if (!rows[0]) {
      throw new AppError(
        "DeepWiki 生成不存在或状态已变化",
        409,
        "DEEPWIKI_STATE_CHANGED",
      );
    }
    return mapDeepWikiGeneration(rows[0]);
  }

  async getDeepWikiGeneration(id: string): Promise<DeepWikiGenerationDto> {
    const { rows } = await this.pool.query(
      "SELECT * FROM deepwiki_generations WHERE id = $1",
      [id],
    );
    if (!rows[0]) throw notFound("DeepWiki Generation");
    return mapDeepWikiGeneration(rows[0]);
  }

  async getLatestDeepWikiGeneration(projectId: string): Promise<DeepWikiGenerationDto | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM deepwiki_generations
       WHERE project_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [projectId],
    );
    return rows[0] ? mapDeepWikiGeneration(rows[0]) : null;
  }

  async markDeepWikiGenerationsStale(
    projectId: string,
    currentRevision: GitRevision,
  ): Promise<DeepWikiGenerationDto[]> {
    const { rows } = await this.pool.query(
      `UPDATE deepwiki_generations
       SET status = 'stale', stale_at = now(), updated_at = now()
       WHERE project_id = $1 AND status = 'ready' AND revision <> $2
       RETURNING *`,
      [projectId, currentRevision],
    );
    return rows.map(mapDeepWikiGeneration);
  }

  async saveRunChangeset(input: ChangesetDto & { patch: Buffer }): Promise<ChangesetDto> {
    const { patch: _patch, ...manifest } = input;
    const changeset = changesetSchema.parse(manifest);
    const actualHash = createHash("sha256").update(input.patch).digest("hex");
    if (input.patch.length !== changeset.patchBytes || actualHash !== changeset.patchSha256) {
      throw new AppError(
        "Changeset patch bytes/hash 与 manifest 不一致",
        400,
        "CHANGESET_INTEGRITY_INVALID",
      );
    }
    const { rows } = await this.pool.query(
      `INSERT INTO run_changesets
         (id, workflow_run_id, base_revision, head_revision, dirty, files,
          patch, patch_bytes, patch_sha256, download_available, generated_at)
       SELECT $1, wr.id, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11
       FROM workflow_runs wr
       WHERE wr.id = $2 AND wr.base_revision = $3
       ON CONFLICT (workflow_run_id) DO UPDATE SET
         head_revision = EXCLUDED.head_revision,
         dirty = EXCLUDED.dirty,
         files = EXCLUDED.files,
         patch = EXCLUDED.patch,
         patch_bytes = EXCLUDED.patch_bytes,
         patch_sha256 = EXCLUDED.patch_sha256,
         download_available = EXCLUDED.download_available,
         generated_at = EXCLUDED.generated_at
       RETURNING *`,
      [
        randomUUID(),
        changeset.runId,
        changeset.baseRevision,
        changeset.headRevision,
        changeset.dirty,
        JSON.stringify(changeset.files),
        input.patch,
        changeset.patchBytes,
        changeset.patchSha256,
        changeset.downloadAvailable,
        changeset.generatedAt,
      ],
    );
    if (!rows[0]) {
      throw new AppError(
        "Changeset baseRevision 与 Run 固定 revision 不一致",
        409,
        "CHANGESET_BASE_REVISION_MISMATCH",
      );
    }
    return mapChangeset(rows[0]);
  }

  async getRunChangeset(runId: string): Promise<{ changeset: ChangesetDto; patch: Buffer } | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM run_changesets WHERE workflow_run_id = $1",
      [runId],
    );
    if (!rows[0]) return null;
    return {
      changeset: mapChangeset(rows[0]),
      patch: Buffer.from(rows[0].patch),
    };
  }

  async listRuns(projectId: string): Promise<WorkflowRunDto[]> {
    await this.getProject(projectId);
    const { rows } = await this.pool.query(
      "SELECT * FROM workflow_runs WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    return rows.map(mapRun);
  }

  /**
   * Small, side-effect-free read used only to resolve an indeterminate COMMIT
   * result. Unlike getRun it does not touch runtime definitions or files.
   */
  async findRunPersistence(runId: string): Promise<RunPersistenceSnapshot | null> {
    const { rows } = await this.pool.query(
      `SELECT wr.*, mw.state AS w_state,
              asr.session_id AS asr_session_id,
              asr.trigger_message_id AS asr_trigger_message_id,
              asr.workflow_run_id AS asr_workflow_run_id,
              asr.created_at AS asr_created_at
       FROM workflow_runs wr
       LEFT JOIN managed_workspaces mw ON mw.id = wr.workspace_id
       LEFT JOIN agent_session_runs asr ON asr.workflow_run_id = wr.id
       WHERE wr.id = $1`,
      [runId],
    );
    if (!rows[0]) return null;
    return {
      run: mapRun(rows[0]),
      artifactPaths: mapArtifactPaths(rows[0].artifact_paths),
      workspaceId: rows[0].workspace_id ? String(rows[0].workspace_id) : null,
      agentSessionRun: rows[0].asr_session_id
        ? mapAgentSessionRun({
            session_id: rows[0].asr_session_id,
            trigger_message_id: rows[0].asr_trigger_message_id,
            workflow_run_id: rows[0].asr_workflow_run_id,
            created_at: rows[0].asr_created_at,
          })
        : null,
    };
  }

  async createRun(
    projectId: string,
    title: string,
    objective: string,
    persistence: CreateRunPersistence = { runId: randomUUID(), artifactPaths: {} }
  ): Promise<WorkflowRunDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query(
        "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
        [projectId],
      );
      if (!project.rows[0]) throw notFound("项目");
      if (persistence.agentSessionRun) {
        const association = persistence.agentSessionRun;
        const session = await client.query(
          `SELECT s.id
           FROM agent_sessions s
           JOIN agent_session_repositories sr
             ON sr.session_id = s.id AND sr.project_id = $2 AND sr.access_mode = 'write'
           WHERE s.id = $1 AND s.status = 'active' AND s.turn_state = 'running'
           FOR UPDATE OF s`,
          [association.sessionId, projectId],
        );
        const trigger = await client.query(
          `SELECT id FROM agent_messages
           WHERE id = $1 AND session_id = $2 AND role = 'user' AND status = 'running'
           FOR UPDATE`,
          [association.triggerMessageId, association.sessionId],
        );
        if (!session.rows[0] || !trigger.rows[0]) {
          throw new AppError(
            "Agent Run 必须由当前 Session 的运行中用户消息触发",
            409,
            "AGENT_SESSION_RUN_TRIGGER_INVALID",
          );
        }
        const existing = await client.query(
          `SELECT workflow_run_id FROM agent_session_runs
           WHERE session_id = $1 AND trigger_message_id = $2`,
          [association.sessionId, association.triggerMessageId],
        );
        if (existing.rows[0]) {
          throw new AppError(
            "这条 Agent 消息已经创建了 SDLC Run",
            409,
            "AGENT_SESSION_RUN_IDEMPOTENCY_CONFLICT",
            { workflowRunId: String(existing.rows[0].workflow_run_id) },
          );
        }
      }
      const cloudProject = await client.query(
        `SELECT source_kind, repository_state, active_revision, definition_version
         FROM projects WHERE id = $1`,
        [projectId],
      );
      // Existing store doubles predate Cloud columns and return no row here.
      // Real PostgreSQL always returns the locked Project row.
      const cloudMetadata = cloudProject.rows[0] ?? { source_kind: "legacy_local" };
      const remoteProject = cloudMetadata.source_kind === "remote_git";
      if (remoteProject && (
        cloudMetadata.repository_state !== "ready"
        || !cloudMetadata.active_revision
      )) {
        throw new AppError(
          "远程项目源码与知识快照尚未就绪",
          409,
          "RUN_PROJECT_NOT_READY",
        );
      }
      if (remoteProject && (
        !persistence.workspaceId
        || !persistence.baseRevision
        || !persistence.definitionVersion
      )) {
        throw new AppError(
          "远程 Run 必须固定受管 Workspace、baseRevision 和 Definition 版本",
          409,
          "RUN_CLOUD_SNAPSHOT_REQUIRED",
        );
      }
      if (
        remoteProject
        && cloudMetadata.definition_version !== persistence.definitionVersion
      ) {
        throw new AppError(
          "Run Definition 版本与项目当前 Control Pack 不一致",
          409,
          "RUN_DEFINITION_VERSION_MISMATCH",
        );
      }
      if (persistence.workspaceId) {
        const workspace = await client.query(
          `SELECT id, revision FROM managed_workspaces
           WHERE id = $1 AND project_id = $2
             AND purpose IN ('run', 'sandbox') AND state = 'ready'`,
          [persistence.workspaceId, projectId],
        );
        if (!workspace.rows[0]) {
          throw new AppError(
            "Run Workspace 不存在、未就绪或不属于当前项目",
            409,
            "RUN_WORKSPACE_NOT_READY",
          );
        }
        if (!persistence.baseRevision || workspace.rows[0].revision !== persistence.baseRevision) {
          throw new AppError(
            "Run Workspace revision 与 baseRevision 不一致",
            409,
            "RUN_REVISION_MISMATCH",
          );
        }
      } else if (persistence.baseRevision) {
        throw new AppError(
          "远程 Run 固定 baseRevision 时必须绑定独立 Workspace",
          409,
          "RUN_WORKSPACE_REQUIRED",
        );
      }
      const runId = persistence.runId;
      const runResult = await client.query(
        `INSERT INTO workflow_runs
           (id, project_id, title, objective, artifact_paths, change_contract,
            workspace_id, base_revision, definition_version, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, 'active') RETURNING *`,
        [
          runId,
          projectId,
          title,
          objective,
          JSON.stringify(persistence.artifactPaths),
          persistence.changeContract ? JSON.stringify(persistence.changeContract) : null,
          persistence.workspaceId ?? null,
          persistence.baseRevision ?? null,
          persistence.definitionVersion ?? null,
        ]
      );
      if (persistence.workspaceId) {
        const transitioned = await client.query(
          `UPDATE managed_workspaces
           SET state = 'busy', updated_at = now()
           WHERE id = $1 AND state = 'ready'`,
          [persistence.workspaceId],
        );
        if (transitioned.rowCount !== 1) {
          throw new AppError(
            "Run Workspace 状态已变化",
            409,
            "RUN_WORKSPACE_STATE_CHANGED",
          );
        }
      }
      if (persistence.agentSessionRun && persistence.workspaceId) {
        const sandbox = await client.query(
          `UPDATE agent_sandboxes
           SET state = 'busy', updated_at = now()
           WHERE session_id = $1 AND workspace_id = $2 AND state = 'ready'
           RETURNING id`,
          [persistence.agentSessionRun.sessionId, persistence.workspaceId],
        );
        if (sandbox.rowCount !== 1) {
          throw new AppError(
            "Agent Sandbox 状态已变化或与 Run Workspace 不一致",
            409,
            "AGENT_SANDBOX_STATE_CHANGED",
          );
        }
      }
      let discoveryPhaseRunId: string | undefined;
      for (const [position, phaseId] of PHASE_IDS.entries()) {
        const phaseRunId = randomUUID();
        await client.query(
          `INSERT INTO phase_runs (id, workflow_run_id, phase_id, position, status)
           VALUES ($1, $2, $3, $4, $5)`,
          [phaseRunId, runId, phaseId, position, position === 0 ? "ready" : "pending"]
        );
        if (phaseId === "discovery") discoveryPhaseRunId = phaseRunId;
      }
      if (persistence.changeContractArtifact) {
        if (!discoveryPhaseRunId) throw new AppError("Discovery 阶段缺失", 500, "PHASE_NOT_FOUND");
        const artifact = persistence.changeContractArtifact;
        await client.query(
          `INSERT INTO artifacts
            (id, phase_run_id, execution_id, artifact_key, file_path, content_snapshot,
             content_hash, review_status, revision, revision_source, parent_artifact_id)
           VALUES ($1, $2, NULL, $3, $4, $5, $6, 'approved', 1, 'human', NULL)`,
          [
            randomUUID(),
            discoveryPhaseRunId,
            artifact.artifactKey,
            artifact.filePath,
            artifact.content,
            artifact.contentHash,
          ],
        );
      }
      if (persistence.agentSessionRun) {
        await client.query(
          `INSERT INTO agent_session_runs
             (session_id, trigger_message_id, workflow_run_id)
           VALUES ($1, $2, $3)`,
          [
            persistence.agentSessionRun.sessionId,
            persistence.agentSessionRun.triggerMessageId,
            runId,
          ],
        );
      }
      // Validate the public result before COMMIT. A mapper/schema failure after
      // a successful COMMIT would otherwise look like a pre-COMMIT error to the
      // caller and could trigger destructive cleanup of committed files.
      const created = mapRun(runResult.rows[0]);
      try {
        await client.query("COMMIT");
      } catch {
        // Once COMMIT has been sent, an I/O failure cannot prove whether the
        // backend committed. Callers must preserve materialized state until a
        // later read confirms the outcome.
        throw new AppError(
          "Run COMMIT 结果无法确认",
          503,
          "RUN_COMMIT_OUTCOME_UNKNOWN",
          { runId },
        );
      }
      return created;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getRun(runId: string): Promise<RunBundle> {
    const runResult = await this.pool.query(
      `SELECT wr.*, p.id AS p_id, p.name AS p_name, p.summary AS p_summary,
              p.root_path AS p_root_path, p.config_path AS p_config_path,
              p.source_kind AS p_source_kind, p.repository_url AS p_repository_url,
              p.repository_host AS p_repository_host, p.requested_ref AS p_requested_ref,
              p.credential_profile_id AS p_credential_profile_id,
              p.repository_state AS p_repository_state, p.active_revision AS p_active_revision,
              p.definition_mode AS p_definition_mode, p.definition_version AS p_definition_version,
              p.operation_id AS p_operation_id, p.operation_kind AS p_operation_kind,
              p.operation_state AS p_operation_state, p.operation_stage AS p_operation_stage,
              p.operation_progress AS p_operation_progress, p.operation_message AS p_operation_message,
              p.last_synced_at AS p_last_synced_at,
              p.repository_error_message AS p_repository_error_message,
              p.created_at AS p_created_at, p.updated_at AS p_updated_at,
              mw.id AS w_id, mw.project_id AS w_project_id, mw.purpose AS w_purpose,
              mw.root_path AS w_root_path, mw.state AS w_state, mw.revision AS w_revision,
              mw.active AS w_active, mw.generation AS w_generation,
              mw.error_message AS w_error_message, mw.expires_at AS w_expires_at,
              mw.created_at AS w_created_at, mw.updated_at AS w_updated_at
       FROM workflow_runs wr JOIN projects p ON p.id = wr.project_id
       LEFT JOIN managed_workspaces mw ON mw.id = wr.workspace_id
       WHERE wr.id = $1`,
      [runId]
    );
    const row = runResult.rows[0];
    if (!row) throw notFound("工作流运行");
    const phaseResult = await this.pool.query(
      "SELECT * FROM phase_runs WHERE workflow_run_id = $1 ORDER BY position",
      [runId]
    );
    const phases = await Promise.all(phaseResult.rows.map(async (phaseRow) => {
      const [artifacts, reviews, executions] = await Promise.all([
        this.artifactsForPhase(phaseRow.id),
        this.reviewsForPhase(phaseRow.id),
        this.executionsForPhase(phaseRow.id)
      ]);
      const events = (await Promise.all(executions.map((execution) => this.eventsForExecution(execution.id)))).flat();
      return {
        ...mapPhase(phaseRow),
        artifacts,
        reviews,
        executions,
        events,
        availableArtifacts: []
      } satisfies PhaseRunDto;
    }));
    return {
      run: mapRun(row),
      project: mapProject({
        id: row.p_id,
        name: row.p_name,
        summary: row.p_summary,
        root_path: row.w_root_path ?? row.p_root_path,
        config_path: row.p_config_path,
        source_kind: row.p_source_kind,
        repository_url: row.p_repository_url,
        repository_host: row.p_repository_host,
        requested_ref: row.p_requested_ref,
        credential_profile_id: row.p_credential_profile_id,
        repository_state: row.p_repository_state,
        active_revision: row.p_active_revision,
        definition_mode: row.p_definition_mode,
        // Run-scoped version wins so an older Run never follows a later Project pack.
        definition_version: row.definition_version ?? row.p_definition_version,
        operation_id: row.p_operation_id,
        operation_kind: row.p_operation_kind,
        operation_state: row.p_operation_state,
        operation_stage: row.p_operation_stage,
        operation_progress: row.p_operation_progress,
        operation_message: row.p_operation_message,
        last_synced_at: row.p_last_synced_at,
        repository_error_message: row.p_repository_error_message,
        created_at: row.p_created_at,
        updated_at: row.p_updated_at
      }),
      phases,
      artifactPaths: mapArtifactPaths(row.artifact_paths),
      workspace: row.w_id ? mapWorkspace({
        id: row.w_id,
        project_id: row.w_project_id,
        purpose: row.w_purpose,
        root_path: row.w_root_path,
        state: row.w_state,
        revision: row.w_revision,
        active: row.w_active,
        generation: row.w_generation,
        error_message: row.w_error_message,
        expires_at: row.w_expires_at,
        created_at: row.w_created_at,
        updated_at: row.w_updated_at,
      }) : null,
    };
  }

  async getPhase(runId: string, phaseId: PhaseId): Promise<PhaseRunDto> {
    const { rows } = await this.pool.query(
      "SELECT * FROM phase_runs WHERE workflow_run_id = $1 AND phase_id = $2",
      [runId, phaseId]
    );
    if (!rows[0]) throw notFound("阶段");
    return { ...mapPhase(rows[0]), artifacts: [], reviews: [], executions: [], events: [], availableArtifacts: [] };
  }

  async approvedPhaseBaselineCandidates(
    projectId: string,
    phaseId: "discovery" | "design",
    excludeRunId: string,
  ): Promise<PhaseBaselineRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT pr.*, wr.id AS source_run_id, wr.title AS source_run_title,
              COALESCE(mw.root_path, p.root_path) AS source_root_path
       FROM phase_runs pr
       JOIN workflow_runs wr ON wr.id = pr.workflow_run_id
       JOIN projects p ON p.id = wr.project_id
       LEFT JOIN managed_workspaces mw ON mw.id = wr.workspace_id
       WHERE wr.project_id = $1
         AND wr.id <> $2
         AND pr.phase_id = $3
         AND pr.status = 'approved'
       ORDER BY pr.updated_at DESC, pr.id DESC
       LIMIT 50`,
      [projectId, excludeRunId, phaseId],
    );
    const candidates = await Promise.all(rows.map(async (phase) => {
      let resolution: PhaseResolutionDto | null;
      try {
        resolution = mapPhaseResolution(phase.phase_resolution, null);
      } catch {
        return null;
      }
      const [artifacts, reviews] = await Promise.all([
        this.currentArtifactSnapshotsForPhase(String(phase.source_run_id), phaseId),
        this.reviewsForPhase(String(phase.id)),
      ]);
      const exactApproval = reviews.find((review) =>
        review.decision === "approve"
        && sameStringSet(review.artifactIds, artifacts.map((artifact) => artifact.id))
      );
      if (!exactApproval) return null;
      return {
        phaseId,
        sourceRunId: String(phase.source_run_id),
        sourceRunTitle: String(phase.source_run_title),
        sourcePhaseRunId: String(phase.id),
        sourceRootPath: String(phase.source_root_path),
        approvedAt: exactApproval.createdAt,
        artifacts,
        reviews,
        resolution,
      } satisfies PhaseBaselineRecord;
    }));
    return candidates.filter(
      (candidate): candidate is PhaseBaselineRecord => candidate !== null,
    );
  }

  async applyPhaseResolution(
    runId: string,
    input: ApplyPhaseResolutionInput,
  ): Promise<ReviewDto> {
    const parsed = phaseResolutionSchema.safeParse(input.resolution);
    if (!parsed.success) {
      throw new AppError(
        "阶段处置不符合持久化合同",
        400,
        "PHASE_RESOLUTION_INVALID",
        { issues: parsed.error.issues },
      );
    }
    const resolution = parsed.data;
    if (!["discovery", "design", "architecture"].includes(resolution.phaseId)) {
      throw new AppError("当前阶段不支持影响处置", 400, "PHASE_RESOLUTION_UNSUPPORTED");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const targetResult = await client.query(
        `SELECT pr.*, wr.project_id
         FROM phase_runs pr
         JOIN workflow_runs wr ON wr.id = pr.workflow_run_id
         WHERE wr.id = $1 AND pr.phase_id = $2
         FOR UPDATE OF pr, wr`,
        [runId, resolution.phaseId],
      );
      const target = targetResult.rows[0];
      if (!target) throw notFound("阶段");
      if (target.status !== "ready" || target.phase_resolution != null) {
        throw new AppError(
          "阶段已经开始或已有处置，不能重复执行 Impact Check",
          409,
          "PHASE_RESOLUTION_NOT_AVAILABLE",
        );
      }

      // A transaction owns one PoolClient. Keep its queries sequential so newer
      // pg releases never have to serialize overlapping work on one connection.
      const targetArtifactsResult = await client.query(
        `SELECT * FROM artifacts
         WHERE phase_run_id = $1 AND review_status <> 'superseded'
         FOR UPDATE`,
        [target.id],
      );
      const targetExecutions = await client.query(
        "SELECT id FROM executions WHERE phase_run_id = $1 FOR UPDATE",
        [target.id],
      );
      const targetReviews = await client.query(
        "SELECT id FROM reviews WHERE phase_run_id = $1 FOR UPDATE",
        [target.id],
      );
      const allowedExistingTargetKeys = resolution.phaseId === "discovery"
        ? new Set(["change-contract"])
        : new Set<string>();
      const unexpectedTargetArtifacts = targetArtifactsResult.rows.filter(
        (artifact) => !allowedExistingTargetKeys.has(String(artifact.artifact_key)),
      );
      if (
        unexpectedTargetArtifacts.length > 0
        || targetExecutions.rows.length > 0
        || targetReviews.rows.length > 0
      ) {
        throw new AppError(
          "阶段已经产生执行、审核或业务产物，不能再改变处置",
          409,
          "PHASE_RESOLUTION_ALREADY_STARTED",
        );
      }

      if (resolution.inputArtifactIds.length > 0) {
        const inputArtifacts = await client.query(
          `SELECT a.id
           FROM artifacts a
           JOIN phase_runs input_phase ON input_phase.id = a.phase_run_id
           WHERE input_phase.workflow_run_id = $1
             AND input_phase.position < $2
             AND input_phase.status = 'approved'
             AND a.id = ANY($3::uuid[])
             AND a.review_status = 'approved'
             AND NOT EXISTS (
               SELECT 1 FROM artifacts newer
               WHERE newer.phase_run_id = a.phase_run_id
                 AND newer.artifact_key = a.artifact_key
                 AND newer.revision > a.revision
             )
           ORDER BY a.id
           FOR UPDATE OF a, input_phase`,
          [runId, Number(target.position), resolution.inputArtifactIds],
        );
        const currentInputIds = inputArtifacts.rows.map((artifact) => String(artifact.id));
        if (!sameStringSet(currentInputIds, resolution.inputArtifactIds)) {
          throw new AppError(
            "阶段处置所依据的上游输入已经变化",
            409,
            "PHASE_RESOLUTION_INPUTS_CHANGED",
            { expected: resolution.inputArtifactIds, current: currentInputIds },
          );
        }
      }

      const inheritedArtifactIds: string[] = [];
      if (resolution.sourcePhaseRunId) {
        const sourceResult = await client.query(
          `SELECT pr.*, wr.id AS source_run_id, wr.title AS source_run_title,
                  wr.project_id AS source_project_id
           FROM phase_runs pr
           JOIN workflow_runs wr ON wr.id = pr.workflow_run_id
           WHERE pr.id = $1 AND wr.id = $2 AND pr.phase_id = $3
           FOR UPDATE OF pr, wr`,
          [resolution.sourcePhaseRunId, resolution.sourceRunId, resolution.phaseId],
        );
        const source = sourceResult.rows[0];
        if (
          !source
          || source.status !== "approved"
          || source.source_project_id !== target.project_id
          || source.source_run_title !== resolution.sourceRunTitle
        ) {
          throw new AppError(
            "阶段基线来源已经变化或不再可用",
            409,
            "PHASE_BASELINE_CONFLICT",
          );
        }
        const sourceArtifactsResult = await client.query(
          `SELECT a.* FROM artifacts a
           WHERE a.phase_run_id = $1
             AND a.review_status <> 'superseded'
             AND NOT EXISTS (
               SELECT 1 FROM artifacts newer
               WHERE newer.phase_run_id = a.phase_run_id
                 AND newer.artifact_key = a.artifact_key
                 AND newer.revision > a.revision
             )
           ORDER BY a.artifact_key
           FOR UPDATE OF a`,
          [source.id],
        );
        const selectedSourceArtifacts = sourceArtifactsResult.rows.filter((artifact) =>
          resolution.sourceArtifactIds.includes(String(artifact.id))
        );
        const selectedSourceIds = selectedSourceArtifacts.map((artifact) => String(artifact.id));
        if (
          !sameStringSet(selectedSourceIds, resolution.sourceArtifactIds)
          || !sameStringSet(selectedSourceIds, input.expectedBaselineArtifactIds)
        ) {
          throw new AppError(
            "阶段基线 Head 已变化，请刷新后重新评估",
            409,
            "PHASE_BASELINE_HEADS_CHANGED",
            { expected: input.expectedBaselineArtifactIds, current: selectedSourceIds },
          );
        }
        const sourceReviews = await client.query(
          "SELECT * FROM reviews WHERE phase_run_id = $1 ORDER BY created_at DESC FOR UPDATE",
          [source.id],
        );
        const hasCoveringApproval = sourceReviews.rows.some((review) => {
          const reviewed = new Set(jsonStringArray(review.reviewed_artifact_ids));
          return review.decision === "approve"
            && selectedSourceIds.every((artifactId) => reviewed.has(artifactId));
        });
        if (!hasCoveringApproval) {
          throw new AppError(
            "阶段基线没有覆盖所选产物的批准记录",
            409,
            "PHASE_BASELINE_APPROVAL_MISSING",
          );
        }
        const inheritedStatus = resolution.mode === "partial" ? "changes_requested" : "approved";
        for (const sourceArtifact of selectedSourceArtifacts) {
          const artifactId = randomUUID();
          inheritedArtifactIds.push(artifactId);
          const artifactKey = String(sourceArtifact.artifact_key);
          const targetFilePath = input.targetArtifactPaths[artifactKey]
            ?? String(sourceArtifact.file_path);
          await client.query(
            `INSERT INTO artifacts
              (id, phase_run_id, execution_id, artifact_key, file_path, content_snapshot,
               content_hash, review_status, revision, revision_source, parent_artifact_id, created_at)
             VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, 1, $8, $9, $10)`,
            [
              artifactId,
              target.id,
              artifactKey,
              targetFilePath,
              sourceArtifact.content_snapshot,
              sourceArtifact.content_hash,
              inheritedStatus,
              sourceArtifact.revision_source,
              sourceArtifact.id,
              sourceArtifact.created_at,
            ],
          );
        }
      } else if (input.expectedBaselineArtifactIds.length > 0) {
        throw new AppError(
          "无基线处置不能携带基线产物",
          400,
          "PHASE_RESOLUTION_INVALID",
        );
      }

      const currentTargetArtifactIds = targetArtifactsResult.rows.map((artifact) => String(artifact.id));
      const reviewedArtifactIds = [...currentTargetArtifactIds, ...inheritedArtifactIds];
      const reviewDecision: ReviewDecision = resolution.mode === "partial"
        ? "request_changes"
        : "approve";
      const reviewResult = await client.query(
        `INSERT INTO reviews (id, phase_run_id, decision, comment, reviewed_artifact_ids)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
        [
          randomUUID(),
          target.id,
          reviewDecision,
          `Phase impact (${resolution.mode}):\n${resolution.rationale}`,
          JSON.stringify(reviewedArtifactIds),
        ],
      );
      const nextStatus = resolution.mode === "partial" ? "changes_requested" : "approved";
      await client.query(
        `UPDATE phase_runs
         SET status = $2, phase_resolution = $3::jsonb, updated_at = now()
         WHERE id = $1`,
        [target.id, nextStatus, JSON.stringify(resolution)],
      );
      if (nextStatus === "approved") {
        const nextResult = await client.query(
          `SELECT id, status FROM phase_runs
           WHERE workflow_run_id = $1 AND position = $2 FOR UPDATE`,
          [runId, Number(target.position) + 1],
        );
        const next = nextResult.rows[0];
        if (next) {
          if (next.status !== "pending") {
            throw new AppError(
              "下游阶段状态已变化，无法安全应用处置",
              409,
              "PHASE_RESOLUTION_DOWNSTREAM_CONFLICT",
            );
          }
          await client.query(
            "UPDATE phase_runs SET status = 'ready', updated_at = now() WHERE id = $1",
            [next.id],
          );
        }
      }
      await client.query(
        "UPDATE workflow_runs SET status = 'active', updated_at = now() WHERE id = $1",
        [runId],
      );
      await client.query("COMMIT");
      return mapReview(reviewResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async latestApprovedArchitectureBaseline(
    projectId: string,
    excludeRunId: string,
  ): Promise<ArchitectureBaselineRecord | null> {
    const candidates = await this.approvedArchitectureBaselineCandidates(
      projectId,
      excludeRunId,
    );
    return candidates[0] ?? null;
  }

  async approvedArchitectureBaselineCandidates(
    projectId: string,
    excludeRunId: string,
  ): Promise<ArchitectureBaselineRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT pr.*, wr.id AS source_run_id, wr.title AS source_run_title,
              COALESCE(mw.root_path, p.root_path) AS source_root_path
       FROM phase_runs pr
       JOIN workflow_runs wr ON wr.id = pr.workflow_run_id
       JOIN projects p ON p.id = wr.project_id
       LEFT JOIN managed_workspaces mw ON mw.id = wr.workspace_id
       WHERE wr.project_id = $1
         AND wr.id <> $2
         AND pr.phase_id = 'architecture'
         AND pr.status = 'approved'
       ORDER BY pr.updated_at DESC, wr.updated_at DESC, pr.id DESC`,
      [projectId, excludeRunId],
    );
    const candidates = await Promise.all(rows.map(async (source) => {
      const [artifactResult, reviews] = await Promise.all([
        this.pool.query(
          `SELECT a.*
           FROM artifacts a
           WHERE a.phase_run_id = $1
             AND a.review_status <> 'superseded'
             AND NOT EXISTS (
               SELECT 1 FROM artifacts newer
               WHERE newer.phase_run_id = a.phase_run_id
                 AND newer.artifact_key = a.artifact_key
                 AND newer.revision > a.revision
             )
           ORDER BY a.artifact_key`,
          [source.id],
        ),
        this.reviewsForPhase(source.id),
      ]);
      const approval = reviews.find((review) => review.decision === "approve");
      if (!approval) return null;
      const artifacts = artifactResult.rows.map((row) => ({
        ...mapArtifact(row, source.status),
        content: row.content_snapshot,
      }));
      let architectureImpact: ArchitectureImpactDto | null;
      try {
        architectureImpact = mapArchitectureImpact(source.architecture_impact);
      } catch {
        return null;
      }
      return {
        sourceRunId: source.source_run_id,
        sourceRunTitle: source.source_run_title,
        sourcePhaseRunId: source.id,
        sourceRootPath: source.source_root_path,
        approvedAt: approval.createdAt,
        artifacts,
        reviews,
        architectureImpact,
      } satisfies ArchitectureBaselineRecord;
    }));
    return candidates.filter(
      (candidate): candidate is ArchitectureBaselineRecord => candidate !== null,
    );
  }

  async adoptArchitectureBaseline(
    runId: string,
    input: AdoptArchitectureBaselineInput,
  ): Promise<ReviewDto> {
    const parsedImpact = architectureImpactSchema.safeParse(input.impact);
    if (!parsedImpact.success) {
      throw new AppError(
        "架构影响记录不符合持久化合同",
        400,
        "ARCHITECTURE_IMPACT_INVALID",
        { issues: parsedImpact.error.issues },
      );
    }
    const impact = parsedImpact.data;
    const { expectedBaselineArtifactIds, requiredArtifactKeys } = input;
    assertUniqueNonEmptyStrings(
      expectedBaselineArtifactIds,
      "expectedBaselineArtifactIds",
      "ARCHITECTURE_BASELINE_INVALID",
    );
    assertUniqueNonEmptyStrings(
      requiredArtifactKeys,
      "requiredArtifactKeys",
      "ARCHITECTURE_BASELINE_INVALID",
    );
    assertUniqueNonEmptyStrings(
      impact.sourceArtifactIds,
      "impact.sourceArtifactIds",
      "ARCHITECTURE_IMPACT_INVALID",
    );
    assertUniqueNonEmptyStrings(
      impact.inputArtifactIds,
      "impact.inputArtifactIds",
      "ARCHITECTURE_IMPACT_INVALID",
    );
    if (impact.sourceRunId === runId) {
      throw new AppError(
        "不能从当前 Run 继承架构基线",
        409,
        "ARCHITECTURE_BASELINE_SELF_REFERENCE",
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query(
        `SELECT pr.*, wr.project_id
         FROM phase_runs pr
         JOIN workflow_runs wr ON wr.id = pr.workflow_run_id
         WHERE wr.id = $1 AND pr.phase_id = 'architecture'
         FOR UPDATE OF pr, wr`,
        [runId],
      );
      const current = currentResult.rows[0];
      if (!current) throw notFound("架构阶段");
      if (current.status !== "ready") {
        throw new AppError(
          `当前架构阶段状态 ${current.status} 不能继承基线`,
          409,
          "ARCHITECTURE_IMPACT_PHASE_NOT_READY",
        );
      }

      const sourceResult = await client.query(
        `SELECT pr.*, wr.id AS source_run_id, wr.title AS source_run_title,
                wr.project_id AS source_project_id
         FROM phase_runs pr
         JOIN workflow_runs wr ON wr.id = pr.workflow_run_id
         WHERE wr.id = $1
           AND pr.id = $2
           AND pr.phase_id = 'architecture'
         FOR UPDATE OF pr, wr`,
        [impact.sourceRunId, impact.sourcePhaseRunId],
      );
      const source = sourceResult.rows[0];
      if (!source) {
        throw new AppError(
          "架构基线来源已经不存在或不匹配",
          409,
          "ARCHITECTURE_BASELINE_CONFLICT",
        );
      }
      if (source.source_project_id !== current.project_id) {
        throw new AppError(
          "不能跨项目继承架构基线",
          409,
          "ARCHITECTURE_BASELINE_PROJECT_MISMATCH",
        );
      }
      if (source.status !== "approved") {
        throw new AppError(
          "架构基线来源已不再处于 approved 状态",
          409,
          "ARCHITECTURE_BASELINE_NOT_APPROVED",
        );
      }
      if (source.source_run_title !== impact.sourceRunTitle) {
        throw new AppError(
          "架构基线来源标题已经变化，请刷新后重试",
          409,
          "ARCHITECTURE_BASELINE_CONFLICT",
        );
      }

      // These locks share the transaction's single PoolClient and must not overlap.
      const currentArtifacts = await client.query(
        "SELECT id FROM artifacts WHERE phase_run_id = $1 FOR UPDATE",
        [current.id],
      );
      const currentExecutions = await client.query(
        "SELECT id FROM executions WHERE phase_run_id = $1 FOR UPDATE",
        [current.id],
      );
      const currentReviews = await client.query(
        "SELECT id FROM reviews WHERE phase_run_id = $1 FOR UPDATE",
        [current.id],
      );
      if (
        currentArtifacts.rows.length > 0
        || currentExecutions.rows.length > 0
        || currentReviews.rows.length > 0
        || current.architecture_impact != null
      ) {
        throw new AppError(
          "当前架构阶段已经开始，不能再继承其他 Run 的基线",
          409,
          "ARCHITECTURE_IMPACT_ALREADY_STARTED",
        );
      }

      const inputArtifactResult = await client.query(
        `SELECT a.id
         FROM artifacts a
         JOIN phase_runs input_phase ON input_phase.id = a.phase_run_id
         WHERE input_phase.workflow_run_id = $1
           AND input_phase.position < $2
           AND input_phase.status = 'approved'
           AND a.id = ANY($3::uuid[])
           AND a.review_status = 'approved'
           AND NOT EXISTS (
             SELECT 1 FROM artifacts newer
             WHERE newer.phase_run_id = a.phase_run_id
               AND newer.artifact_key = a.artifact_key
               AND newer.revision > a.revision
           )
         ORDER BY a.id
         FOR UPDATE OF a, input_phase`,
        [runId, Number(current.position), impact.inputArtifactIds],
      );
      const currentInputArtifactIds = inputArtifactResult.rows.map(
        (artifact) => String(artifact.id),
      );
      if (!sameStringSet(currentInputArtifactIds, impact.inputArtifactIds)) {
        throw new AppError(
          "架构影响评估所依据的上游输入已经变化，请刷新后重试",
          409,
          "ARCHITECTURE_IMPACT_INPUTS_CHANGED",
          {
            expectedArtifactIds: impact.inputArtifactIds,
            currentArtifactIds: currentInputArtifactIds,
          },
        );
      }

      const sourceArtifactResult = await client.query(
        `SELECT a.*
         FROM artifacts a
         WHERE a.phase_run_id = $1
           AND a.review_status <> 'superseded'
           AND NOT EXISTS (
             SELECT 1 FROM artifacts newer
             WHERE newer.phase_run_id = a.phase_run_id
               AND newer.artifact_key = a.artifact_key
               AND newer.revision > a.revision
           )
         ORDER BY a.artifact_key
         FOR UPDATE OF a`,
        [source.id],
      );
      const sourceArtifacts = sourceArtifactResult.rows;
      const sourceArtifactIds = sourceArtifacts.map((artifact) => String(artifact.id));
      if (!sameStringSet(sourceArtifactIds, expectedBaselineArtifactIds)) {
        throw new AppError(
          "架构基线产物版本已经变化，请刷新后重试",
          409,
          "ARCHITECTURE_BASELINE_HEADS_CHANGED",
          { expectedArtifactIds: expectedBaselineArtifactIds, currentArtifactIds: sourceArtifactIds },
        );
      }
      if (!sameStringSet(sourceArtifactIds, impact.sourceArtifactIds)) {
        throw new AppError(
          "架构影响记录与当前基线产物不一致",
          409,
          "ARCHITECTURE_IMPACT_SOURCE_MISMATCH",
          { impactArtifactIds: impact.sourceArtifactIds, currentArtifactIds: sourceArtifactIds },
        );
      }
      const sourceArtifactKeys = sourceArtifacts.map(
        (artifact) => String(artifact.artifact_key),
      );
      const missingArtifactKeys = requiredArtifactKeys.filter(
        (artifactKey) => !sourceArtifactKeys.includes(artifactKey),
      );
      const unexpectedArtifactKeys = sourceArtifactKeys.filter(
        (artifactKey) => !requiredArtifactKeys.includes(artifactKey),
      );
      if (!sameStringSet(sourceArtifactKeys, requiredArtifactKeys)) {
        throw new AppError(
          "架构基线产物集合与当前工作流定义不一致",
          409,
          "ARCHITECTURE_BASELINE_INCOMPLETE",
          { missing: missingArtifactKeys, unexpected: unexpectedArtifactKeys },
        );
      }
      const unapprovedArtifactIds = sourceArtifacts
        .filter((artifact) => artifact.review_status !== "approved")
        .map((artifact) => String(artifact.id));
      if (unapprovedArtifactIds.length > 0) {
        throw new AppError(
          "架构基线包含未批准的当前产物",
          409,
          "ARCHITECTURE_BASELINE_NOT_APPROVED",
          { artifactIds: unapprovedArtifactIds },
        );
      }

      const sourceReviewResult = await client.query(
        "SELECT * FROM reviews WHERE phase_run_id = $1 ORDER BY created_at DESC, id DESC FOR UPDATE",
        [source.id],
      );
      const exactApproval = sourceReviewResult.rows.find((review) =>
        review.decision === "approve"
        && sameStringSet(jsonStringArray(review.reviewed_artifact_ids), sourceArtifactIds)
      );
      if (!exactApproval) {
        throw new AppError(
          "架构基线没有覆盖当前全部产物的精确批准记录",
          409,
          "ARCHITECTURE_BASELINE_APPROVAL_MISSING",
        );
      }
      assertArchitectureSelectionProvenance(
        impact,
        sourceArtifacts,
        sourceReviewResult.rows,
        mapArchitectureImpact(source.architecture_impact),
      );

      const inheritedReviewStatus = impact.mode === "reuse" ? "approved" : "changes_requested";
      const inheritedArtifactIds: string[] = [];
      for (const sourceArtifact of sourceArtifacts) {
        const artifactId = randomUUID();
        inheritedArtifactIds.push(artifactId);
        await client.query(
          `INSERT INTO artifacts
            (id, phase_run_id, execution_id, artifact_key, file_path, content_snapshot,
             content_hash, review_status, revision, revision_source, parent_artifact_id, created_at)
           VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, 1, $8, $9, $10)`,
          [
            artifactId,
            current.id,
            sourceArtifact.artifact_key,
            sourceArtifact.file_path,
            sourceArtifact.content_snapshot,
            sourceArtifact.content_hash,
            inheritedReviewStatus,
            sourceArtifact.revision_source,
            sourceArtifact.id,
            sourceArtifact.created_at,
          ],
        );
      }

      const reviewDecision: ReviewDecision = impact.mode === "reuse"
        ? "approve"
        : "request_changes";
      const reviewResult = await client.query(
        `INSERT INTO reviews (id, phase_run_id, decision, comment, reviewed_artifact_ids)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
        [
          randomUUID(),
          current.id,
          reviewDecision,
          `Architecture impact (${impact.mode}):\n${impact.rationale}`,
          JSON.stringify(inheritedArtifactIds),
        ],
      );
      const nextStatus = impact.mode === "reuse" ? "approved" : "changes_requested";
      const phaseResolution = architectureImpactToPhaseResolution(impact);
      await client.query(
        `UPDATE phase_runs
         SET status = $2, architecture_impact = $3::jsonb,
             phase_resolution = $4::jsonb, updated_at = now()
         WHERE id = $1`,
        [current.id, nextStatus, JSON.stringify(impact), JSON.stringify(phaseResolution)],
      );

      if (impact.mode === "reuse") {
        const nextResult = await client.query(
          `SELECT id, status
           FROM phase_runs
           WHERE workflow_run_id = $1 AND position = $2
           FOR UPDATE`,
          [runId, Number(current.position) + 1],
        );
        const next = nextResult.rows[0];
        if (!next || next.status !== "pending") {
          throw new AppError(
            "架构复用无法安全解锁下一阶段",
            409,
            "ARCHITECTURE_IMPACT_DOWNSTREAM_CONFLICT",
          );
        }
        await client.query(
          "UPDATE phase_runs SET status = 'ready', updated_at = now() WHERE id = $1",
          [next.id],
        );
      }
      await client.query(
        "UPDATE workflow_runs SET status = 'active', updated_at = now() WHERE id = $1",
        [runId],
      );
      await client.query("COMMIT");
      return mapReview(reviewResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async currentArtifactSnapshotsForPhase(runId: string, phaseId: PhaseId): Promise<CurrentArtifactSnapshot[]> {
    const phaseResult = await this.pool.query(
      "SELECT id, status FROM phase_runs WHERE workflow_run_id = $1 AND phase_id = $2",
      [runId, phaseId]
    );
    const phase = phaseResult.rows[0];
    if (!phase) throw notFound("阶段");
    const { rows } = await this.pool.query(
      `SELECT a.*
       FROM artifacts a
       WHERE a.phase_run_id = $1
         AND a.review_status <> 'superseded'
         AND NOT EXISTS (
           SELECT 1 FROM artifacts newer
           WHERE newer.phase_run_id = a.phase_run_id
             AND newer.artifact_key = a.artifact_key
             AND newer.revision > a.revision
         )
       ORDER BY a.artifact_key`,
      [phase.id]
    );
    return rows.map((row) => ({
      ...mapArtifact(row, phase.status),
      content: row.content_snapshot,
      executionId: row.execution_id ?? null,
    }));
  }

  async selectionArtifacts(runId: string, ids: string[]): Promise<SelectionArtifact[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT a.*, pr.position AS source_position, pr.status AS source_status,
              pr.workflow_run_id
       FROM artifacts a JOIN phase_runs pr ON pr.id = a.phase_run_id
       WHERE pr.workflow_run_id = $1
         AND a.id = ANY($2::uuid[])
         AND a.review_status <> 'superseded'
         AND NOT EXISTS (
           SELECT 1 FROM artifacts newer
           WHERE newer.phase_run_id = a.phase_run_id
             AND newer.artifact_key = a.artifact_key
             AND newer.revision > a.revision
         )`,
      [runId, ids]
    );
    if (rows.length !== new Set(ids).size) {
      throw new AppError(
        "选择中包含不存在、已被新版本替代或不属于当前 run 的产物",
        400,
        "INVALID_ARTIFACT_SELECTION"
      );
    }
    return rows.map((row) => ({
      ...mapArtifact(row, row.source_status),
      sourcePosition: row.source_position,
      sourceStatus: row.source_status,
      workflowRunId: row.workflow_run_id,
      content: row.content_snapshot
    }));
  }

  async createExecution(
    runId: string,
    phaseId: PhaseId,
    selectedArtifactIds: string[],
    selectedOutputKeys: string[],
    runnerMode: CodexRunnerMode,
    model: string | null,
    reasoningEffort: CodexReasoningEffort | null,
    command: string
  ): Promise<ExecutionDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const phaseResult = await client.query(
        "SELECT * FROM phase_runs WHERE workflow_run_id = $1 AND phase_id = $2 FOR UPDATE",
        [runId, phaseId]
      );
      const phase = phaseResult.rows[0];
      if (!phase) throw notFound("阶段");
      assertPhaseExecutable(phase.status);
      const architectureImpact = mapArchitectureImpact(phase.architecture_impact);
      const phaseResolution = mapPhaseResolution(phase.phase_resolution, architectureImpact);
      if (phase.phase_id === "architecture" && architectureImpact?.mode === "reuse") {
        throw new AppError(
          "已复用的架构基线是不可变快照；如需修改，请让上游变更使 Impact Check 失效后重新评估",
          409,
          "ARCHITECTURE_IMPACT_REUSE_IMMUTABLE",
        );
      }
      if (phase.phase_id === "architecture" && architectureImpact?.mode === "partial") {
        if (
          new Set(selectedArtifactIds).size !== selectedArtifactIds.length
          || !sameStringSet(selectedArtifactIds, architectureImpact.inputArtifactIds)
        ) {
          throw new AppError(
            "局部架构更新所依据的上游输入已变化，请重新执行 Impact Check",
            409,
            "ARCHITECTURE_IMPACT_INPUTS_CHANGED",
          );
        }
        const priorExecutionResult = await client.query(
          "SELECT id FROM executions WHERE phase_run_id = $1 LIMIT 1 FOR UPDATE",
          [phase.id],
        );
        validateArchitecturePartialExecution(
          architectureImpact.affectedOutputKeys,
          selectedOutputKeys,
          priorExecutionResult.rows.length > 0,
        );
      }
      if (phaseResolution) {
        if (
          phaseResolution.mode === "partial"
          && !sameStringSet(selectedArtifactIds, phaseResolution.inputArtifactIds)
        ) {
          throw new AppError(
            "局部执行所依据的上游输入已经变化",
            409,
            "PHASE_RESOLUTION_INPUTS_CHANGED",
          );
        }
        const priorResolutionExecution = await client.query(
          "SELECT id FROM executions WHERE phase_run_id = $1 LIMIT 1 FOR UPDATE",
          [phase.id],
        );
        validatePhaseResolutionExecution(
          phaseResolution,
          phase.phase_id,
          selectedOutputKeys,
          priorResolutionExecution.rows.length > 0,
        );
      }
      await this.resetDownstreamPhases(client, runId, phase.position);
      const executionResult = await client.query(
        `INSERT INTO executions
           (id, phase_run_id, status, selected_artifact_ids, selected_output_keys,
            runner_mode, model, reasoning_effort, command, started_at)
         VALUES ($1, $2, 'running', $3::jsonb, $4::jsonb, $5, $6, $7, $8, now()) RETURNING *`,
        [
          randomUUID(),
          phase.id,
          JSON.stringify(selectedArtifactIds),
          JSON.stringify(selectedOutputKeys),
          runnerMode,
          model,
          reasoningEffort,
          command
        ]
      );
      await client.query("UPDATE phase_runs SET status = 'running', updated_at = now() WHERE id = $1", [phase.id]);
      await client.query(
        "UPDATE workflow_runs SET status = 'active', updated_at = now() WHERE id = $1",
        [runId]
      );
      await client.query("COMMIT");
      return mapExecution(executionResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async appendEvent(executionId: string, sequence: number, eventType: string, payload: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO execution_events (id, execution_id, sequence, event_type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [randomUUID(), executionId, sequence, eventType, JSON.stringify(payload ?? null)]
    );
  }

  async completeExecution(
    executionId: string,
    exitCode: number,
    artifacts: ArtifactRecordInput[],
    ticketSync?: TicketSyncInput
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT e.*, pr.id AS phase_id, pr.workflow_run_id FROM executions e
         JOIN phase_runs pr ON pr.id = e.phase_run_id WHERE e.id = $1 FOR UPDATE`,
        [executionId]
      );
      const execution = result.rows[0];
      if (!execution) throw notFound("执行");
      if (execution.status !== "running") throw new AppError("执行已经结束", 409, "EXECUTION_FINISHED");
      const selectedOutputKeys = new Set<string>(execution.selected_output_keys ?? []);
      const receivedOutputKeys = new Set<string>();
      for (const artifact of artifacts) {
        if (receivedOutputKeys.has(artifact.artifactKey)) {
          throw new AppError("执行返回了重复的产物 key", 422, "DUPLICATE_OUTPUT_ARTIFACT", {
            artifactKey: artifact.artifactKey
          });
        }
        if (!selectedOutputKeys.has(artifact.artifactKey)) {
          throw new AppError("执行返回了未选择的产物", 422, "UNEXPECTED_OUTPUT_ARTIFACT", {
            artifactKey: artifact.artifactKey
          });
        }
        receivedOutputKeys.add(artifact.artifactKey);
      }
      const missingOutputKeys = [...selectedOutputKeys].filter((key) => !receivedOutputKeys.has(key));
      if (missingOutputKeys.length > 0) {
        throw new AppError("执行缺少已选择的产物", 422, "OUTPUT_ARTIFACTS_MISSING", {
          missing: missingOutputKeys
        });
      }
      const artifactIds = new Map<string, string>();
      for (const artifact of artifacts) {
        const headResult = await client.query(
          `SELECT id, revision
           FROM artifacts
           WHERE phase_run_id = $1 AND artifact_key = $2
           ORDER BY revision DESC, created_at DESC, id DESC
           LIMIT 1
           FOR UPDATE`,
          [execution.phase_run_id, artifact.artifactKey]
        );
        const previous = headResult.rows[0];
        await client.query(
          `UPDATE artifacts SET review_status = 'superseded'
           WHERE phase_run_id = $1 AND artifact_key = $2
             AND review_status <> 'superseded'`,
          [execution.phase_run_id, artifact.artifactKey]
        );
        const artifactId = randomUUID();
        artifactIds.set(artifact.artifactKey, artifactId);
        await client.query(
          `INSERT INTO artifacts
            (id, phase_run_id, execution_id, artifact_key, file_path, content_snapshot,
             content_hash, review_status, revision, revision_source, parent_artifact_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, 'ai', $9)`,
          [
            artifactId,
            execution.phase_run_id,
            executionId,
            artifact.artifactKey,
            artifact.filePath,
            artifact.content,
            artifact.contentHash,
            Number(previous?.revision ?? 0) + 1,
            previous?.id ?? null
          ]
        );
      }
      if (ticketSync) {
        const sourceArtifactId = artifactIds.get(ticketSync.artifactKey);
        if (!sourceArtifactId) {
          throw new AppError("Ticket 来源产物不在本次执行结果中", 422, "TICKET_SOURCE_MISSING");
        }
        await this.syncTicketsWithClient(
          client,
          execution.workflow_run_id,
          sourceArtifactId,
          ticketSync.tickets
        );
      }
      await client.query(
        `UPDATE executions SET status = 'completed', exit_code = $2, finished_at = now() WHERE id = $1`,
        [executionId, exitCode]
      );
      await client.query(
        "UPDATE phase_runs SET status = 'awaiting_review', updated_at = now() WHERE id = $1",
        [execution.phase_run_id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failExecution(executionId: string, exitCode: number | null, error: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE executions SET status = 'failed', exit_code = $2, error = $3, finished_at = now()
         WHERE id = $1 AND status = 'running' RETURNING phase_run_id`,
        [executionId, exitCode, error]
      );
      if (result.rows[0]) {
        await client.query(
          "UPDATE phase_runs SET status = 'failed', updated_at = now() WHERE id = $1",
          [result.rows[0].phase_run_id]
        );
      }
      await client.query("COMMIT");
    } catch (caught) {
      await client.query("ROLLBACK");
      throw caught;
    } finally {
      client.release();
    }
  }

  async reviewPhase(
    runId: string,
    phaseId: PhaseId,
    decision: ReviewDecision,
    comment: string,
    expectedArtifactIds: string[],
    requiredOutputKeys: string[] = [],
    requiredOutputFreshness?: {
      keys: string[];
      after: string;
      minimumRevision?: number;
      indexKey?: string;
    },
    allowedPhaseStatuses: PhaseStatus[] = ["awaiting_review"],
  ): Promise<ReviewDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const phaseResult = await client.query(
        "SELECT * FROM phase_runs WHERE workflow_run_id = $1 AND phase_id = $2 FOR UPDATE",
        [runId, phaseId]
      );
      const phase = phaseResult.rows[0];
      if (!phase) throw notFound("阶段");
      if (allowedPhaseStatuses.length === 1 && allowedPhaseStatuses[0] === "awaiting_review") {
        assertPhaseReviewable(phase.status);
      } else if (!allowedPhaseStatuses.includes(phase.status)) {
        throw new AppError(
          `当前阶段状态 ${phase.status} 不允许记录这次审核`,
          409,
          "PHASE_NOT_REVIEWABLE",
          { allowedStatuses: allowedPhaseStatuses },
        );
      }
      const headResult = await client.query(
        `SELECT a.id, a.artifact_key, a.created_at, a.revision, a.execution_id,
                a.parent_artifact_id
         FROM artifacts a
         WHERE a.phase_run_id = $1
           AND a.review_status <> 'superseded'
           AND NOT EXISTS (
             SELECT 1 FROM artifacts newer
             WHERE newer.phase_run_id = a.phase_run_id
               AND newer.artifact_key = a.artifact_key
               AND newer.revision > a.revision
           )
         ORDER BY a.artifact_key
         FOR UPDATE OF a`,
        [phase.id]
      );
      const currentArtifactIds = headResult.rows.map((artifact) => String(artifact.id));
      if (!sameStringSet(currentArtifactIds, expectedArtifactIds)) {
        throw new AppError(
          "审核期间产物版本已变化，请刷新后重新确认",
          409,
          "ARTIFACT_HEADS_CHANGED",
          { expectedArtifactIds, currentArtifactIds }
        );
      }
      if (decision === "approve") {
        const phaseResolution = mapPhaseResolution(
          phase.phase_resolution,
          mapArchitectureImpact(phase.architecture_impact),
        );
        if (phaseResolution?.mode === "partial") {
          const affected = new Set(phaseResolution.affectedOutputKeys);
          const sourceIds = new Set(phaseResolution.sourceArtifactIds);
          const affectedHeads = new Map(
            headResult.rows
              .filter((artifact) => affected.has(String(artifact.artifact_key)))
              .map((artifact) => [String(artifact.artifact_key), artifact]),
          );
          const staleAffected = [...affected].filter((artifactKey) => {
              const artifact = affectedHeads.get(artifactKey);
              if (!artifact) return true;
              // Inherited heads must be revised beyond their adoption clone.
              // A newly introduced optional output has no source parent, so its
              // first AI-produced revision is valid evidence for this attempt.
              if (Number(artifact.revision) > 1) return false;
              return artifact.parent_artifact_id !== null
                || artifact.execution_id === null;
            });
          if (staleAffected.length > 0) {
            throw new AppError(
              `局部处置产物尚未实际更新：${staleAffected.join(", ")}`,
              409,
              "PHASE_RESOLUTION_OUTPUTS_NOT_UPDATED",
              { stale: staleAffected },
            );
          }
          const changedOutsideScope = headResult.rows
            .filter((artifact) => String(artifact.artifact_key) !== "change-contract")
            .filter((artifact) => !affected.has(String(artifact.artifact_key)))
            .filter((artifact) =>
              Number(artifact.revision) !== 1
              || artifact.parent_artifact_id === null
              || !sourceIds.has(String(artifact.parent_artifact_id))
            )
            .map((artifact) => String(artifact.artifact_key));
          if (changedOutsideScope.length > 0) {
            throw new AppError(
              `局部处置范围外产物已经变化：${changedOutsideScope.join(", ")}`,
              409,
              "PHASE_RESOLUTION_BASELINE_DIVERGED",
              { changed: changedOutsideScope },
            );
          }
        }
        const currentArtifactKeys = new Set(
          headResult.rows.map((artifact) => String(artifact.artifact_key)),
        );
        const missingOutputKeys = requiredOutputKeys.filter(
          (key) => !currentArtifactKeys.has(key),
        );
        if (missingOutputKeys.length > 0) {
          throw new AppError(
            `阶段产物尚未齐全，不能批准：${missingOutputKeys.join(", ")}`,
            409,
            "PHASE_OUTPUTS_INCOMPLETE",
            { missing: missingOutputKeys },
          );
        }
        if (requiredOutputFreshness) {
          const selectedAt = Date.parse(requiredOutputFreshness.after);
          const staleOutputKeys = headResult.rows
            .filter((artifact) => requiredOutputFreshness.keys.includes(String(artifact.artifact_key)))
            .filter((artifact) => {
              if (requiredOutputFreshness.minimumRevision !== undefined) {
                return Number(artifact.revision) < requiredOutputFreshness.minimumRevision;
              }
              const createdAt = new Date(artifact.created_at).getTime();
              return !Number.isFinite(selectedAt)
                || !Number.isFinite(createdAt)
                || createdAt <= selectedAt;
            })
            .map((artifact) => String(artifact.artifact_key));
          if (staleOutputKeys.length > 0) {
            throw new AppError(
              requiredOutputFreshness.minimumRevision !== undefined
                ? `局部架构产物尚未在本次影响评估后更新：${staleOutputKeys.join(", ")}`
                : `架构产物早于本次人工选型，必须在选型后重新生成：${staleOutputKeys.join(", ")}`,
              409,
              "ARCHITECTURE_OUTPUTS_PREDATE_SELECTION",
              { stale: staleOutputKeys, selectedAt: requiredOutputFreshness.after },
            );
          }
          if (requiredOutputFreshness.indexKey) {
            const indexHead = headResult.rows.find(
              (artifact) => String(artifact.artifact_key) === requiredOutputFreshness.indexKey,
            );
            const indexCreatedAt = new Date(indexHead?.created_at).getTime();
            const staleIndexFor = headResult.rows
              .filter((artifact) =>
                requiredOutputFreshness.keys.includes(String(artifact.artifact_key))
                && String(artifact.artifact_key) !== requiredOutputFreshness.indexKey
              )
              .filter((artifact) => {
                if (
                  indexHead?.execution_id
                  && artifact.execution_id
                  && String(indexHead.execution_id) === String(artifact.execution_id)
                ) {
                  return false;
                }
                const artifactCreatedAt = new Date(artifact.created_at).getTime();
                return !Number.isFinite(indexCreatedAt)
                  || !Number.isFinite(artifactCreatedAt)
                  || indexCreatedAt < artifactCreatedAt;
              })
              .map((artifact) => String(artifact.artifact_key));
            if (staleIndexFor.length > 0) {
              throw new AppError(
                `architecture 索引未反映这些较新的局部产物：${staleIndexFor.join(", ")}`,
                409,
                "ARCHITECTURE_IMPACT_INDEX_STALE",
                { staleIndexFor, indexKey: requiredOutputFreshness.indexKey },
              );
            }
          }
        }
      }
      const reviewResult = await client.query(
        `INSERT INTO reviews (id, phase_run_id, decision, comment, reviewed_artifact_ids)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
        [randomUUID(), phase.id, decision, comment, JSON.stringify(currentArtifactIds)]
      );
      const nextStatus = decision === "approve" ? "approved" : "changes_requested";
      await client.query("UPDATE phase_runs SET status = $2, updated_at = now() WHERE id = $1", [phase.id, nextStatus]);
      await client.query(
        `UPDATE artifacts SET review_status = $2
         WHERE phase_run_id = $1 AND id = ANY($3::uuid[])`,
        [
          phase.id,
          decision === "approve" ? "approved" : "changes_requested",
          currentArtifactIds
        ]
      );
      if (decision === "request_changes") {
        await this.resetDownstreamPhases(client, runId, Number(phase.position));
      }
      if (decision === "approve") {
        if (phase.phase_id === "discovery") {
          await client.query(
            `UPDATE tickets SET status = 'todo', updated_at = now()
             WHERE workflow_run_id = $1 AND active = true AND status = 'backlog'`,
            [runId]
          );
        }
        const next = await client.query(
          "SELECT id FROM phase_runs WHERE workflow_run_id = $1 AND position = $2 FOR UPDATE",
          [runId, phase.position + 1]
        );
        if (next.rows[0]) {
          await client.query(
            "UPDATE phase_runs SET status = 'ready', updated_at = now() WHERE id = $1 AND status = 'pending'",
            [next.rows[0].id]
          );
        } else {
          await client.query(
            "UPDATE workflow_runs SET status = 'completed', updated_at = now() WHERE id = $1",
            [runId]
          );
        }
      }
      await client.query("UPDATE workflow_runs SET updated_at = now() WHERE id = $1", [runId]);
      await client.query("COMMIT");
      return mapReview(reviewResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getArtifact(id: string): Promise<ArtifactDto> {
    const { rows } = await this.pool.query(
      `SELECT a.*, pr.status AS phase_status FROM artifacts a
       JOIN phase_runs pr ON pr.id = a.phase_run_id WHERE a.id = $1`,
      [id]
    );
    if (!rows[0]) throw notFound("产物");
    return { ...mapArtifact(rows[0], rows[0].phase_status), content: rows[0].content_snapshot };
  }

  async artifactWorkspace(artifactId: string): Promise<ArtifactWorkspace> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(mw.root_path, p.root_path) AS root_path,
              pr.workflow_run_id, pr.phase_id
       FROM artifacts a
       JOIN phase_runs pr ON pr.id = a.phase_run_id
       JOIN workflow_runs wr ON wr.id = pr.workflow_run_id
       JOIN projects p ON p.id = wr.project_id
       LEFT JOIN managed_workspaces mw ON mw.id = wr.workspace_id
       WHERE a.id = $1`,
      [artifactId]
    );
    if (!rows[0]) throw notFound("产物");
    return {
      rootPath: rows[0].root_path,
      workflowRunId: rows[0].workflow_run_id,
      phaseId: rows[0].phase_id
    };
  }

  async createHumanArtifactRevision(
    artifactId: string,
    expectedHash: string,
    content: string,
    contentHash: string,
    ticketRecords?: TicketRecordInput[]
  ): Promise<ArtifactDto> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const artifactResult = await client.query(
        `SELECT a.*, pr.workflow_run_id, pr.phase_id, pr.position, pr.status AS phase_status,
           pr.architecture_impact, pr.phase_resolution
         FROM artifacts a
         JOIN phase_runs pr ON pr.id = a.phase_run_id
         WHERE a.id = $1
         FOR UPDATE OF a, pr`,
        [artifactId]
      );
      const artifact = artifactResult.rows[0];
      if (!artifact) throw notFound("产物");
      if (["pending", "running"].includes(artifact.phase_status)) {
        throw new AppError(
          `当前阶段状态 ${artifact.phase_status} 不允许人工编辑产物`,
          409,
          "ARTIFACT_NOT_EDITABLE",
          { phaseStatus: artifact.phase_status }
        );
      }
      if (String(artifact.artifact_key) === "change-contract") {
        throw new AppError(
          "Change Contract 在 Run 创建后不可修改",
          409,
          "CHANGE_CONTRACT_IMMUTABLE",
        );
      }
      const architectureImpact = mapArchitectureImpact(artifact.architecture_impact);
      validateArchitectureImpactArtifactMutation(
        architectureImpact,
        String(artifact.artifact_key),
      );
      const phaseResolution = mapPhaseResolution(
        artifact.phase_resolution,
        architectureImpact,
      );
      if (phaseResolution) {
        validatePhaseResolutionArtifactMutation(
          phaseResolution,
          phaseResolution.phaseId,
          String(artifact.artifact_key),
        );
      }
      const latestResult = await client.query(
        `SELECT id, revision
         FROM artifacts
         WHERE phase_run_id = $1 AND artifact_key = $2
         ORDER BY revision DESC, created_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [artifact.phase_run_id, artifact.artifact_key]
      );
      const latest = latestResult.rows[0];
      if (
        artifact.review_status === "superseded"
        || !latest
        || latest.id !== artifact.id
      ) {
        throw new AppError(
          "该产物版本已被新版本替代，请刷新后重试",
          409,
          "ARTIFACT_REVISION_CONFLICT",
          { artifactId }
        );
      }
      if (artifact.content_hash !== expectedHash) {
        throw new AppError(
          "产物已发生变化，请刷新后再编辑",
          409,
          "ARTIFACT_REVISION_CONFLICT",
          { artifactId, currentContentHash: artifact.content_hash }
        );
      }
      if (contentHash === artifact.content_hash) {
        throw new AppError(
          "人工修订内容与当前产物完全相同",
          409,
          "ARTIFACT_REVISION_UNCHANGED",
          { artifactId, currentContentHash: artifact.content_hash }
        );
      }
      if (ticketRecords && artifact.artifact_key !== "user-stories") {
        throw new AppError(
          "只有 user-stories 产物可以同步 Ticket",
          400,
          "TICKET_SOURCE_MISMATCH"
        );
      }

      await this.resetDownstreamPhases(
        client,
        artifact.workflow_run_id,
        Number(artifact.position)
      );
      await client.query(
        "UPDATE artifacts SET review_status = 'superseded' WHERE id = $1",
        [artifact.id]
      );
      const nextId = randomUUID();
      const nextResult = await client.query(
        `INSERT INTO artifacts
          (id, phase_run_id, execution_id, artifact_key, file_path, content_snapshot,
           content_hash, review_status, revision, revision_source, parent_artifact_id)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, 'pending', $7, 'human', $8)
         RETURNING *`,
        [
          nextId,
          artifact.phase_run_id,
          artifact.artifact_key,
          artifact.file_path,
          content,
          contentHash,
          Number(latest.revision) + 1,
          artifact.id
        ]
      );
      if (ticketRecords) {
        await this.syncTicketsWithClient(
          client,
          artifact.workflow_run_id,
          nextId,
          ticketRecords
        );
      }
      await client.query(
        "UPDATE phase_runs SET status = 'awaiting_review', updated_at = now() WHERE id = $1",
        [artifact.phase_run_id]
      );
      await client.query(
        "UPDATE workflow_runs SET status = 'active', updated_at = now() WHERE id = $1",
        [artifact.workflow_run_id]
      );
      await client.query("COMMIT");
      return {
        ...mapArtifact(nextResult.rows[0], "awaiting_review"),
        content: nextResult.rows[0].content_snapshot
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async latestUserStoriesArtifact(runId: string): Promise<ArtifactSnapshotRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.file_path, a.content_snapshot
       FROM artifacts a
       JOIN phase_runs pr ON pr.id = a.phase_run_id
       WHERE pr.workflow_run_id = $1
         AND a.artifact_key = 'user-stories'
         AND a.review_status <> 'superseded'
         AND NOT EXISTS (
           SELECT 1 FROM artifacts newer
           WHERE newer.phase_run_id = a.phase_run_id
             AND newer.artifact_key = a.artifact_key
             AND newer.revision > a.revision
         )
       ORDER BY a.revision DESC, a.created_at DESC, a.id DESC
       LIMIT 1`,
      [runId]
    );
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      filePath: rows[0].file_path,
      content: rows[0].content_snapshot
    };
  }

  async syncTickets(runId: string, sourceArtifactId: string, tickets: TicketRecordInput[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.syncTicketsWithClient(client, runId, sourceArtifactId, tickets);
      await client.query(
        `UPDATE tickets
         SET status = 'todo', updated_at = now()
         WHERE workflow_run_id = $1
           AND active = true
           AND status = 'backlog'
           AND EXISTS (
             SELECT 1 FROM phase_runs
             WHERE workflow_run_id = $1
               AND phase_id = 'discovery'
               AND status = 'approved'
           )`,
        [runId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listTickets(runId: string): Promise<TicketSummaryDto[]> {
    const { rows } = await this.pool.query(
      `SELECT t.*, a.review_status AS source_review_status
       FROM tickets t
       LEFT JOIN artifacts a ON a.id = t.source_artifact_id
       WHERE t.workflow_run_id = $1 AND t.active = true
       ORDER BY t.position, t.story_key`,
      [runId]
    );
    return rows.map(mapTicketSummary);
  }

  async getTicket(runId: string, ticketId: string): Promise<TicketDto> {
    const { rows } = await this.pool.query(
      `SELECT t.*, a.review_status AS source_review_status
       FROM tickets t
       LEFT JOIN artifacts a ON a.id = t.source_artifact_id
       WHERE t.workflow_run_id = $1 AND t.id = $2 AND t.active = true`,
      [runId, ticketId]
    );
    if (!rows[0]) throw notFound("Ticket");
    return mapTicket(rows[0]);
  }

  async updateTicketStatus(runId: string, ticketId: string, status: TicketStatus): Promise<TicketSummaryDto> {
    const { rows } = await this.pool.query(
      `WITH updated AS (
         UPDATE tickets SET status = $3, updated_at = now()
         WHERE workflow_run_id = $1 AND id = $2 AND active = true
         RETURNING *
       )
       SELECT updated.*, a.review_status AS source_review_status
       FROM updated LEFT JOIN artifacts a ON a.id = updated.source_artifact_id`,
      [runId, ticketId, status]
    );
    if (!rows[0]) throw notFound("Ticket");
    return mapTicketSummary(rows[0]);
  }

  async eventsForExecution(executionId: string): Promise<ExecutionEventDto[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM execution_events WHERE execution_id = $1 ORDER BY sequence",
      [executionId]
    );
    return rows.map(mapEvent);
  }

  async projectSourceKindForArtifact(
    artifactId: string,
  ): Promise<RuntimeProject["sourceKind"]> {
    const { rows } = await this.pool.query(
      `SELECT p.source_kind
       FROM artifacts a
       JOIN phase_runs pr ON pr.id = a.phase_run_id
       JOIN workflow_runs wr ON wr.id = pr.workflow_run_id
       JOIN projects p ON p.id = wr.project_id
       WHERE a.id = $1`,
      [artifactId],
    );
    if (!rows[0]) throw notFound("产物");
    return rows[0].source_kind === "remote_git" ? "remote-git" : "legacy-local";
  }

  async projectSourceKindForExecution(
    executionId: string,
  ): Promise<RuntimeProject["sourceKind"]> {
    const { rows } = await this.pool.query(
      `SELECT p.source_kind
       FROM executions e
       JOIN phase_runs pr ON pr.id = e.phase_run_id
       JOIN workflow_runs wr ON wr.id = pr.workflow_run_id
       JOIN projects p ON p.id = wr.project_id
       WHERE e.id = $1`,
      [executionId],
    );
    if (!rows[0]) throw notFound("执行");
    return rows[0].source_kind === "remote_git" ? "remote-git" : "legacy-local";
  }

  async projectSourceKindForAskThread(
    threadId: string,
  ): Promise<RuntimeProject["sourceKind"]> {
    const { rows } = await this.pool.query(
      `SELECT p.source_kind
       FROM ask_threads at
       JOIN projects p ON p.id = at.project_id
       WHERE at.id = $1`,
      [threadId],
    );
    if (!rows[0]) throw notFound("Ask Thread");
    return rows[0].source_kind === "remote_git" ? "remote-git" : "legacy-local";
  }

  private async resetDownstreamPhases(
    client: pg.PoolClient,
    runId: string,
    sourcePosition: number
  ): Promise<void> {
    const downstream = await client.query(
      `SELECT id, phase_id, status
       FROM phase_runs
       WHERE workflow_run_id = $1 AND position > $2
       ORDER BY position
       FOR UPDATE`,
      [runId, sourcePosition]
    );
    const running = downstream.rows.find((phase) => phase.status === "running");
    if (running) {
      throw new AppError(
        `下游阶段 ${running.phase_id} 正在执行，当前操作不能使其失效`,
        409,
        "DOWNSTREAM_PHASE_RUNNING",
        { phaseId: running.phase_id }
      );
    }
    await client.query(
      `UPDATE phase_runs
       SET status = 'pending',
           phase_resolution = NULL,
           architecture_impact = CASE
             WHEN phase_id = 'architecture' THEN NULL
             ELSE architecture_impact
           END,
           updated_at = now()
       WHERE workflow_run_id = $1
         AND position > $2
         AND (
           status <> 'pending'
           OR phase_resolution IS NOT NULL
           OR (phase_id = 'architecture' AND architecture_impact IS NOT NULL)
         )`,
      [runId, sourcePosition]
    );
  }

  private async artifactsForPhase(phaseRunId: string): Promise<ArtifactDto[]> {
    const { rows } = await this.pool.query(
      `SELECT a.*, pr.status AS phase_status FROM artifacts a
       JOIN phase_runs pr ON pr.id = a.phase_run_id
       WHERE a.phase_run_id = $1
         AND a.review_status <> 'superseded'
         AND NOT EXISTS (
           SELECT 1 FROM artifacts newer
           WHERE newer.phase_run_id = a.phase_run_id
             AND newer.artifact_key = a.artifact_key
             AND newer.revision > a.revision
         )
       ORDER BY a.created_at DESC, a.id DESC`,
      [phaseRunId]
    );
    return rows.map((row) => mapArtifact(row, row.phase_status));
  }

  private async reviewsForPhase(phaseRunId: string): Promise<ReviewDto[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM reviews WHERE phase_run_id = $1 ORDER BY created_at DESC",
      [phaseRunId]
    );
    return rows.map(mapReview);
  }

  private async executionsForPhase(phaseRunId: string): Promise<ExecutionDto[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM executions WHERE phase_run_id = $1 ORDER BY created_at DESC",
      [phaseRunId]
    );
    return rows.map(mapExecution);
  }

  private async syncTicketsWithClient(
    client: pg.PoolClient,
    runId: string,
    sourceArtifactId: string,
    tickets: TicketRecordInput[]
  ): Promise<void> {
    for (const ticket of tickets) {
      await client.query(
        `INSERT INTO tickets AS current
          (id, workflow_run_id, source_artifact_id, story_key, title, category, source_path,
           content_snapshot, content_hash, acceptance_criteria_count, position, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
         ON CONFLICT (workflow_run_id, story_key) DO UPDATE SET
           source_artifact_id = EXCLUDED.source_artifact_id,
           title = EXCLUDED.title,
           category = EXCLUDED.category,
           source_path = EXCLUDED.source_path,
           content_snapshot = EXCLUDED.content_snapshot,
           content_hash = EXCLUDED.content_hash,
           acceptance_criteria_count = EXCLUDED.acceptance_criteria_count,
           position = EXCLUDED.position,
           active = true,
           updated_at = CASE
             WHEN current.content_hash IS DISTINCT FROM EXCLUDED.content_hash
               OR current.source_artifact_id IS DISTINCT FROM EXCLUDED.source_artifact_id
               OR current.active = false
             THEN now()
             ELSE current.updated_at
           END`,
        [
          randomUUID(), runId, sourceArtifactId, ticket.storyKey, ticket.title, ticket.category,
          ticket.sourcePath, ticket.content, ticket.contentHash, ticket.acceptanceCriteriaCount,
          ticket.position
        ]
      );
    }
    const storyKeys = tickets.map((ticket) => ticket.storyKey);
    await client.query(
      `UPDATE tickets SET active = false, updated_at = now()
       WHERE workflow_run_id = $1 AND active = true
         AND NOT (story_key = ANY($2::text[]))`,
      [runId, storyKeys]
    );
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function ensureProjectAgentSettings(
  client: Pick<pg.PoolClient, "query">,
  projectId: string,
): Promise<any> {
  const project = await client.query(
    "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
    [projectId],
  );
  if (!project.rows[0]) throw notFound("项目");
  await client.query(
    `INSERT INTO project_agent_settings
       (project_id, repo_alias, default_provider_id, sandbox_blueprint_id,
        sandbox_blueprint_version, enabled_mcp_server_ids)
     VALUES ($1::uuid, 'repo-' || replace(($1::uuid)::text, '-', ''), 'openai', 'default', '1', '[]'::jsonb)
     ON CONFLICT (project_id) DO NOTHING`,
    [projectId],
  );
  const settings = await client.query(
    "SELECT * FROM project_agent_settings WHERE project_id = $1 FOR UPDATE",
    [projectId],
  );
  if (!settings.rows[0]) {
    throw new AppError(
      "项目 Agent 设置初始化失败",
      500,
      "PROJECT_AGENT_SETTINGS_INITIALIZATION_FAILED",
    );
  }
  return settings.rows[0];
}

function mapProjectAgentSettings(row: any): ProjectAgentSettingsDto {
  return projectAgentSettingsSchema.parse({
    projectId: String(row.project_id),
    repoAlias: row.repo_alias,
    defaultProviderId: row.default_provider_id,
    sandboxBlueprintId: row.sandbox_blueprint_id,
    sandboxBlueprintVersion: row.sandbox_blueprint_version,
    enabledMcpServerIds: parseJsonValue(row.enabled_mcp_server_ids, "enabled MCP server IDs"),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

async function assertReadyProjectSnapshot(
  client: Pick<pg.PoolClient, "query">,
  input: { projectId: string; workspaceId: string; sourceRevision?: GitRevision; revision?: GitRevision },
): Promise<void> {
  const revision = input.sourceRevision ?? input.revision;
  if (!revision) {
    throw new AppError("缺少固定的源码 revision", 400, "PROJECT_REVISION_REQUIRED");
  }
  const result = await client.query(
    `SELECT 1
     FROM managed_workspaces mw
     JOIN projects p ON p.id = mw.project_id
     WHERE mw.id = $1 AND mw.project_id = $2
       AND mw.purpose = 'project_snapshot' AND mw.state = 'ready'
       AND mw.revision = $3
       AND p.repository_state = 'ready' AND p.active_revision = $3`,
    [input.workspaceId, input.projectId, revision],
  );
  if (!result.rows[0]) {
    throw new AppError(
      "Project Snapshot 不存在、未就绪或不是项目当前 revision",
      409,
      "PROJECT_SNAPSHOT_MISMATCH",
    );
  }
}

async function readAgentSessionSummary(
  client: Pick<pg.PoolClient, "query"> | Pick<pg.Pool, "query">,
  id: string,
): Promise<AgentSessionDto> {
  // This helper also runs inside write transactions. pg currently queues
  // overlapping PoolClient queries, but that behaviour is deprecated; keep
  // transactional reads explicitly ordered so a future pg upgrade cannot
  // make Session creation flaky.
  const sessionResult = await client.query("SELECT * FROM agent_sessions WHERE id = $1", [id]);
  const repositoryResult = await client.query(
    `SELECT * FROM agent_session_repositories
     WHERE session_id = $1 ORDER BY CASE access_mode WHEN 'write' THEN 0 ELSE 1 END, repo_alias`,
    [id],
  );
  const sandboxResult = await client.query(
    "SELECT * FROM agent_sandboxes WHERE session_id = $1",
    [id],
  );
  const session = sessionResult.rows[0];
  if (!session) throw notFound("Agent Session");
  return agentSessionSchema.parse({
    id: String(session.id),
    title: session.title,
    status: session.status,
    turnState: session.turn_state,
    currentProviderId: session.current_provider_id,
    lastMessageSequence: Number(session.last_message_sequence),
    lastEventSequence: Number(session.last_event_sequence),
    repositories: repositoryResult.rows.map(mapAgentSessionRepository),
    sandbox: sandboxResult.rows[0] ? mapAgentSandbox(sandboxResult.rows[0]) : null,
    createdAt: iso(session.created_at),
    updatedAt: iso(session.updated_at),
  });
}

function mapAgentSessionRepository(row: any): AgentSessionRepositoryDto {
  return agentSessionRepositorySchema.parse({
    sessionId: String(row.session_id),
    projectId: String(row.project_id),
    repoAlias: row.repo_alias,
    accessMode: row.access_mode,
    sourceRevision: row.source_revision,
    createdAt: iso(row.created_at),
  });
}

function mapAgentSandbox(row: any): AgentSandboxDto {
  return agentSandboxSchema.parse({
    id: String(row.id),
    sessionId: String(row.session_id),
    projectId: String(row.project_id),
    sourceRevision: row.source_revision,
    blueprintId: row.blueprint_id,
    blueprintVersion: row.blueprint_version,
    state: row.state,
    expiresAt: row.expires_at ? iso(row.expires_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapAgentSessionRun(row: any): AgentSessionRunRecord {
  return {
    sessionId: String(row.session_id),
    triggerMessageId: String(row.trigger_message_id),
    workflowRunId: String(row.workflow_run_id),
    createdAt: iso(row.created_at),
  };
}

function mapAgentMessage(row: any): AgentMessageDto {
  return agentMessageSchema.parse({
    id: String(row.id),
    sessionId: String(row.session_id),
    sequence: Number(row.sequence),
    role: row.role,
    status: row.status,
    content: row.content,
    providerId: row.provider_id,
    model: row.model ?? null,
    clientMessageId: row.client_message_id ? String(row.client_message_id) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapAgentEvent(row: any): AgentEventDto {
  return agentEventSchema.parse({
    id: String(row.id),
    sessionId: String(row.session_id),
    sequence: Number(row.sequence),
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    messageId: row.message_id ? String(row.message_id) : null,
    toolCallId: row.tool_call_id ? String(row.tool_call_id) : null,
    projectId: row.project_id ? String(row.project_id) : null,
    workflowRunId: row.workflow_run_id ? String(row.workflow_run_id) : null,
    phaseId: row.phase_id ?? null,
    createdAt: iso(row.created_at),
  });
}

function mapAgentToolCall(row: any): AgentToolCallDto {
  return agentToolCallSchema.parse({
    id: String(row.id),
    sessionId: String(row.session_id),
    messageId: String(row.message_id),
    mcpServerId: row.mcp_server_id,
    toolName: row.tool_name,
    permissionClass: row.permission_class,
    approval: row.approval,
    status: row.status,
    argumentsSha256: row.arguments_sha256,
    outputSha256: row.output_sha256 ?? null,
    summary: row.summary ?? null,
    errorMessage: row.error_message ?? null,
    startedAt: row.started_at ? iso(row.started_at) : null,
    finishedAt: row.finished_at ? iso(row.finished_at) : null,
    createdAt: iso(row.created_at),
  });
}

function mapAgentHumanGate(row: any): AgentHumanGateDto {
  return agentHumanGateSchema.parse({
    id: String(row.id),
    sessionId: String(row.session_id),
    messageId: String(row.message_id),
    category: row.category,
    status: row.status,
    question: row.question,
    choices: parseJsonValue(row.choices, "Agent Human Gate choices"),
    selectedChoiceId: row.selected_choice_id ?? null,
    responseComment: row.response_comment ?? null,
    createdAt: iso(row.created_at),
    resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
  });
}

function mapDeepWikiGeneration(row: any): DeepWikiGenerationDto {
  return deepWikiGenerationSchema.parse({
    id: String(row.id),
    projectId: String(row.project_id),
    revision: row.revision,
    providerId: row.provider_id,
    model: row.model ?? null,
    promptVersion: row.prompt_version,
    status: row.status,
    manifestHash: row.manifest_hash ?? null,
    content: row.content ?? null,
    citations: parseJsonValue(row.citations, "DeepWiki citations"),
    usage: {
      inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
    },
    errorMessage: row.error_message ?? null,
    generatedAt: row.generated_at ? iso(row.generated_at) : null,
    staleAt: row.stale_at ? iso(row.stale_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function agentMessageRequestFingerprint(content: string, providerId?: AskProviderId): string {
  // Fingerprint the normalized wire request, not the resolved provider. A retry
  // that omitted providerId remains idempotent even after a later turn switches it.
  return createHash("sha256")
    .update(JSON.stringify({ content, providerId: providerId ?? null }))
    .digest("hex");
}

function assertSafeStoredText(value: string, maxLength: number, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes("\u0000")) {
    throw new AppError(`${label} 格式无效`, 400, "PERSISTED_TEXT_INVALID");
  }
  return normalized;
}

function isHighRiskToolPermission(permissionClass: McpToolPermissionClass): boolean {
  return ["external_write", "destructive", "release"].includes(permissionClass);
}

function toolPermissionHumanGateCategory(
  permissionClass: McpToolPermissionClass,
): AgentHumanGateCategory {
  if (permissionClass === "external_write") return "external_write";
  if (permissionClass === "destructive") return "destructive";
  if (permissionClass === "release") return "release";
  throw new AppError(
    "只有高风险 Tool Call 可以绑定权限 Human Gate",
    409,
    "AGENT_HUMAN_GATE_TOOL_PERMISSION_INVALID",
  );
}

function assertAgentSandboxTransition(
  current: AgentSandboxState,
  next: AgentSandboxState,
): void {
  const allowed: Record<AgentSandboxState, AgentSandboxState[]> = {
    starting: ["ready", "failed", "stopped"],
    ready: ["busy", "failed", "stopped"],
    busy: ["ready", "failed", "stopped"],
    failed: ["starting", "stopped"],
    stopped: [],
  };
  if (!allowed[current].includes(next)) {
    throw new AppError(
      `Sandbox 不能从 ${current} 变为 ${next}`,
      409,
      "AGENT_SANDBOX_TRANSITION_INVALID",
    );
  }
}

function assertAgentToolCallTransition(
  current: AgentToolCallDto["status"],
  next: AgentToolCallDto["status"],
): void {
  const allowed: Record<AgentToolCallDto["status"], AgentToolCallDto["status"][]> = {
    queued: ["running", "cancelled"],
    running: ["completed", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  };
  if (!allowed[current].includes(next)) {
    throw new AppError(
      `Tool Call 不能从 ${current} 变为 ${next}`,
      409,
      "AGENT_TOOL_TRANSITION_INVALID",
    );
  }
}

function assertDeepWikiTransition(
  current: DeepWikiGenerationStatus,
  next: DeepWikiGenerationStatus,
): void {
  const allowed: Record<DeepWikiGenerationStatus, DeepWikiGenerationStatus[]> = {
    queued: ["scanning"],
    scanning: ["generating"],
    generating: ["validating"],
    validating: [],
    ready: [],
    failed: [],
    stale: [],
  };
  if (!allowed[current].includes(next)) {
    throw new AppError(
      `DeepWiki 不能从 ${current} 变为 ${next}`,
      409,
      "DEEPWIKI_TRANSITION_INVALID",
    );
  }
}

async function assertAgentEventReferences(
  client: Pick<pg.PoolClient, "query">,
  input: {
    sessionId: string;
    messageId?: string | null;
    toolCallId?: string | null;
    projectId?: string | null;
    workflowRunId?: string | null;
    phaseId?: PhaseId | null;
  },
): Promise<void> {
  if (input.messageId) {
    const result = await client.query(
      "SELECT 1 FROM agent_messages WHERE id = $1 AND session_id = $2",
      [input.messageId, input.sessionId],
    );
    if (!result.rows[0]) {
      throw new AppError("Event message 不属于当前 Session", 409, "AGENT_EVENT_REFERENCE_MISMATCH");
    }
  }
  if (input.toolCallId) {
    const result = await client.query(
      `SELECT message_id FROM agent_tool_calls
       WHERE id = $1 AND session_id = $2`,
      [input.toolCallId, input.sessionId],
    );
    if (!result.rows[0] || (
      input.messageId && result.rows[0].message_id !== input.messageId
    )) {
      throw new AppError("Event Tool Call 不属于当前消息", 409, "AGENT_EVENT_REFERENCE_MISMATCH");
    }
  }
  if (input.projectId) {
    const result = await client.query(
      `SELECT 1 FROM agent_session_repositories
       WHERE session_id = $1 AND project_id = $2`,
      [input.sessionId, input.projectId],
    );
    if (!result.rows[0]) {
      throw new AppError("Event Project 未绑定到当前 Session", 409, "AGENT_EVENT_REFERENCE_MISMATCH");
    }
  }
  if (input.workflowRunId) {
    const result = await client.query(
      `SELECT 1 FROM agent_session_runs
       WHERE session_id = $1 AND workflow_run_id = $2`,
      [input.sessionId, input.workflowRunId],
    );
    if (!result.rows[0]) {
      throw new AppError("Event Run 未绑定到当前 Session", 409, "AGENT_EVENT_REFERENCE_MISMATCH");
    }
  }
  if (input.phaseId) {
    if (!input.workflowRunId) {
      throw new AppError("Phase Event 必须包含 workflowRunId", 400, "AGENT_EVENT_REFERENCE_MISMATCH");
    }
    const result = await client.query(
      `SELECT 1 FROM phase_runs
       WHERE workflow_run_id = $1 AND phase_id = $2`,
      [input.workflowRunId, input.phaseId],
    );
    if (!result.rows[0]) {
      throw new AppError("Event Phase 不属于对应 Run", 409, "AGENT_EVENT_REFERENCE_MISMATCH");
    }
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size
    && [...leftSet].every((value) => rightSet.has(value));
}

function assertUniqueNonEmptyStrings(
  values: string[],
  field: string,
  code: string,
): void {
  if (
    values.length === 0
    || values.some((value) => typeof value !== "string" || value.length === 0)
    || new Set(values).size !== values.length
  ) {
    throw new AppError(
      `${field} 必须是非空且不重复的字符串列表`,
      400,
      code,
      { field },
    );
  }
}

function jsonStringArray(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function mapArchitectureImpact(value: unknown): ArchitectureImpactDto | null {
  if (value === null || value === undefined) return null;
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new AppError(
        "持久化的 Architecture Impact JSON 已损坏",
        500,
        "ARCHITECTURE_IMPACT_CORRUPT",
      );
    }
  }
  const result = architectureImpactSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError(
      "持久化的 Architecture Impact 不符合当前合同",
      500,
      "ARCHITECTURE_IMPACT_CORRUPT",
      { issues: result.error.issues },
    );
  }
  return result.data;
}

function assertArchitectureSelectionProvenance(
  impact: ArchitectureImpactDto,
  sourceArtifacts: any[],
  sourceReviews: any[],
  sourceImpact: ArchitectureImpactDto | null,
): void {
  const currentSourceIds = sourceArtifacts.map((artifact) => String(artifact.id));
  const provenanceIds = new Set([
    ...currentSourceIds,
    ...(sourceImpact?.sourceArtifactIds ?? []),
    ...(sourceImpact ? [sourceImpact.selection.optionsArtifactId] : []),
  ]);
  if (!provenanceIds.has(impact.selection.optionsArtifactId)) {
    throw new AppError(
      "架构选型证据不属于当前基线或其来源链",
      409,
      "ARCHITECTURE_SELECTION_PROVENANCE_MISMATCH",
    );
  }

  if (sourceImpact) {
    if (!sameArchitectureSelection(sourceImpact.selection, impact.selection)) {
      throw new AppError(
        "架构选型证据与来源基线记录不一致",
        409,
        "ARCHITECTURE_SELECTION_PROVENANCE_MISMATCH",
      );
    }
    return;
  }

  const selectionReview = sourceReviews.find(
    (review) => String(review.id) === impact.selection.reviewId,
  );
  if (
    !selectionReview
    || selectionReview.decision !== "request_changes"
    || iso(selectionReview.created_at) !== impact.selection.selectedAt
    || !jsonStringArray(selectionReview.reviewed_artifact_ids)
      .includes(impact.selection.optionsArtifactId)
  ) {
    throw new AppError(
      "架构选型证据无法在来源基线的审核记录中验证",
      409,
      "ARCHITECTURE_SELECTION_PROVENANCE_MISMATCH",
    );
  }
}

function sameArchitectureSelection(
  left: ArchitectureImpactDto["selection"],
  right: ArchitectureImpactDto["selection"],
): boolean {
  return left.optionId === right.optionId
    && left.reviewId === right.reviewId
    && left.optionsArtifactId === right.optionsArtifactId
    && left.selectedAt === right.selectedAt;
}

function mapArtifactPaths(value: unknown): Record<string, string> {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function mapProject(row: any): RuntimeProject {
  const sourceKind = row.source_kind === "remote_git" ? "remote-git" : "legacy-local";
  const operation = row.operation_id
    ? {
        id: String(row.operation_id),
        kind: row.operation_kind as "import" | "sync",
        state: row.operation_state as "queued" | "running" | "failed",
        stage: row.operation_stage as RepositoryOperationStage,
        progress: Number(row.operation_progress),
        message: String(row.operation_message),
      }
    : null;
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    rootPath: row.root_path,
    configPath: row.config_path,
    sourceKind,
    repositoryUrl: row.repository_url ?? null,
    repositoryHost: row.repository_host ?? null,
    requestedRef: row.requested_ref ?? null,
    credentialProfileId: row.credential_profile_id ?? null,
    repositoryState: row.repository_state ?? "ready",
    currentRevision: row.active_revision ?? null,
    definitionMode: row.definition_mode === "managed" ? "managed" : "repository",
    definitionVersion: row.definition_version ?? null,
    operation,
    lastSyncedAt: row.last_synced_at ? iso(row.last_synced_at) : null,
    repositoryErrorMessage: row.repository_error_message ?? null,
    runCount: Number(row.run_count ?? 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapRun(row: any): WorkflowRunDto {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    objective: row.objective,
    changeContract: mapChangeContract(row.change_contract),
    status: row.status,
    baseRevision: row.base_revision ?? null,
    definitionVersion: row.definition_version ?? null,
    workspaceState: row.w_state ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapWorkspace(row: any): ManagedWorkspaceRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    purpose: row.purpose,
    rootPath: String(row.root_path),
    state: row.state,
    revision: row.revision ?? null,
    active: Boolean(row.active),
    generation: Number(row.generation),
    errorMessage: row.error_message ?? null,
    expiresAt: row.expires_at ? iso(row.expires_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapKnowledgeSnapshot(row: any): KnowledgeSnapshotRecord {
  const summary = row.summary == null
    ? null
    : knowledgeSummarySchema.parse(parseJsonValue(row.summary, "Knowledge summary"));
  const snapshot = {
    id: String(row.id),
    status: row.status,
    revision: row.revision,
    indexedAt: row.indexed_at ? iso(row.indexed_at) : null,
    summary,
    errorMessage: row.error_message ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  } satisfies KnowledgeSnapshotDto;
  return {
    ...snapshot,
    projectId: String(row.project_id),
    workspaceId: row.workspace_id ? String(row.workspace_id) : null,
    manifestHash: row.manifest_hash ?? null,
    indexData: row.index_data == null
      ? null
      : parseJsonValue(row.index_data, "Knowledge index"),
  };
}

function mapAskThreadSummary(row: any): AskThreadSummaryDto {
  if (row.source_revision == null) {
    throw new AppError(
      "旧 Ask Thread 缺少固定的源码 revision，不能安全继续",
      409,
      "ASK_THREAD_REVISION_UNAVAILABLE",
    );
  }
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    providerId: row.provider_id,
    revision: String(row.revision),
    sourceRevision: String(row.source_revision),
    title: String(row.title),
    status: row.status,
    messageCount: Number(row.message_count ?? 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapAskThreadMessage(row: any): AskThreadMessageDto {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    role: row.role,
    content: String(row.content),
    answer: row.answer == null
      ? null
      : askAnswerSchema.parse(parseJsonValue(row.answer, "Ask answer")),
    createdAt: iso(row.created_at),
  };
}

async function readAskThread(
  client: Pick<pg.PoolClient, "query">,
  id: string,
): Promise<AskThreadRecord> {
  const threadResult = await client.query(
    `SELECT at.*, count(am.id)::integer AS message_count
     FROM ask_threads at
     LEFT JOIN ask_messages am ON am.thread_id = at.id
     WHERE at.id = $1 GROUP BY at.id`,
    [id],
  );
  if (!threadResult.rows[0]) throw notFound("Ask Thread");
  const messageResult = await client.query(
    "SELECT * FROM ask_messages WHERE thread_id = $1 ORDER BY sequence",
    [id],
  );
  return {
    ...mapAskThreadSummary(threadResult.rows[0]),
    messages: messageResult.rows.map(mapAskThreadMessage),
  };
}

function assertAskThreadTurnCapacity(nextSequence: number): void {
  // A persisted turn is always one user message followed by one assistant
  // message, so both sequence numbers must fit inside the 200-message budget.
  if (Number.isSafeInteger(nextSequence) && nextSequence >= 1 && nextSequence <= 199) return;
  throw askThreadLimitError();
}

function askThreadLimitError(): AppError {
  return new AppError(
    "这个 Ask 对话已达到 200 条消息上限，请新建对话后继续。",
    409,
    "ASK_THREAD_LIMIT",
  );
}

function mapChangeset(row: any): ChangesetDto {
  return changesetSchema.parse({
    runId: String(row.workflow_run_id),
    baseRevision: row.base_revision,
    headRevision: row.head_revision ?? null,
    dirty: Boolean(row.dirty),
    files: parseJsonValue(row.files, "Changeset files"),
    patchBytes: Number(row.patch_bytes),
    patchSha256: row.patch_sha256,
    generatedAt: iso(row.generated_at),
    downloadAvailable: Boolean(row.download_available),
  });
}

function parseJsonValue(value: unknown, label: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new AppError(`${label} 持久化数据损坏`, 500, "PERSISTED_JSON_CORRUPT");
  }
}

export function publicProjectFromRuntime(
  project: RuntimeProject,
  context: {
    credentialProfile?: CredentialProfileSummaryDto | null;
    knowledge?: KnowledgeSnapshotDto | null;
  } = {},
): PublicProjectDto {
  if (project.sourceKind === "legacy-local") {
    return publicProjectSchema.parse({
      id: project.id,
      name: project.name,
      summary: project.summary,
      sourceKind: "legacy-local",
      repository: null,
      knowledge: null,
      availableActions: { ask: true, createRun: true, sync: false },
      runCount: project.runCount,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
  }
  if (!project.repositoryUrl || !project.repositoryHost) {
    throw new AppError(
      "远程 Project 持久化数据缺少仓库身份",
      500,
      "REMOTE_PROJECT_CORRUPT",
    );
  }
  const knowledge = context.knowledge
    ? publicKnowledgeSnapshotFromRecord(context.knowledge)
    : null;
  const revisionReady = Boolean(
    project.currentRevision
    && knowledge?.status === "ready"
    && knowledge.revision === project.currentRevision,
  );
  const credentialProfile = project.credentialProfileId
    ? context.credentialProfile ?? {
        id: project.credentialProfileId,
        label: project.credentialProfileId,
        host: project.repositoryHost,
        available: false,
      }
    : null;
  const operationRunning = project.operation?.state === "queued"
    || project.operation?.state === "running";
  return publicProjectSchema.parse({
    id: project.id,
    name: project.name,
    summary: project.summary,
    sourceKind: "remote-git",
    repository: {
      url: project.repositoryUrl,
      host: project.repositoryHost,
      requestedRef: project.requestedRef,
      credentialProfile,
      activeSnapshot: revisionReady && project.currentRevision && knowledge?.indexedAt
        ? {
            revision: project.currentRevision,
            resolvedRef: project.requestedRef ?? project.currentRevision,
            indexedAt: knowledge.indexedAt,
          }
        : null,
      operation: project.operation,
    },
    knowledge,
    availableActions: {
      ask: revisionReady,
      createRun: revisionReady,
      sync: revisionReady && !operationRunning,
    },
    runCount: project.runCount,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
}

export function publicKnowledgeSnapshotFromRecord(
  snapshot: KnowledgeSnapshotDto,
): KnowledgeSnapshotDto {
  return knowledgeSnapshotSchema.parse({
    id: snapshot.id,
    status: snapshot.status,
    revision: snapshot.revision,
    indexedAt: snapshot.indexedAt,
    summary: snapshot.summary,
    errorMessage: snapshot.errorMessage,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  });
}

function mapPhase(row: any): Omit<PhaseRunDto, "artifacts" | "reviews" | "executions" | "events" | "availableArtifacts"> {
  const architectureImpact = mapArchitectureImpact(row.architecture_impact);
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    phaseId: row.phase_id,
    position: row.position,
    status: row.status,
    resolution: mapPhaseResolution(row.phase_resolution, architectureImpact),
    architectureImpact,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapChangeContract(value: unknown): ChangeContractDto | null {
  if (value === null || value === undefined) return null;
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new AppError("Change Contract 持久化数据损坏", 500, "CHANGE_CONTRACT_CORRUPT");
    }
  }
  const result = changeContractSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError(
      "Change Contract 持久化数据损坏",
      500,
      "CHANGE_CONTRACT_CORRUPT",
      { issues: result.error.issues },
    );
  }
  return result.data;
}

function mapPhaseResolution(
  value: unknown,
  architectureImpact: ArchitectureImpactDto | null,
): PhaseResolutionDto | null {
  if (value === null || value === undefined) {
    return architectureImpact ? architectureImpactToPhaseResolution(architectureImpact) : null;
  }
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new AppError("阶段处置持久化数据损坏", 500, "PHASE_RESOLUTION_CORRUPT");
    }
  }
  const result = phaseResolutionSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError(
      "阶段处置持久化数据损坏",
      500,
      "PHASE_RESOLUTION_CORRUPT",
      { issues: result.error.issues },
    );
  }
  return result.data;
}

function mapArtifact(row: any, phaseStatus: string): ArtifactDto {
  const reviewStatus = row.review_status
    ?? (phaseStatus === "approved" ? "approved" : phaseStatus === "changes_requested" ? "changes_requested" : "pending");
  return {
    id: row.id,
    phaseRunId: row.phase_run_id,
    artifactKey: row.artifact_key,
    filePath: row.file_path,
    contentHash: row.content_hash,
    reviewStatus,
    revision: Number(row.revision ?? 1),
    revisionSource: row.revision_source ?? (row.execution_id === null ? "human" : "ai"),
    parentArtifactId: row.parent_artifact_id ?? null,
    createdAt: iso(row.created_at)
  };
}

function mapReview(row: any): ReviewDto {
  return {
    id: row.id,
    phaseRunId: row.phase_run_id,
    decision: row.decision,
    comment: row.comment,
    artifactIds: row.reviewed_artifact_ids ?? [],
    createdAt: iso(row.created_at)
  };
}

function mapExecution(row: any): ExecutionDto {
  return { id: row.id, phaseRunId: row.phase_run_id, status: row.status, selectedArtifactIds: row.selected_artifact_ids ?? [], selectedOutputKeys: row.selected_output_keys ?? [], runnerMode: row.runner_mode ?? null, model: row.model ?? null, reasoningEffort: row.reasoning_effort ?? null, command: row.command, exitCode: row.exit_code, error: row.error, startedAt: row.started_at ? iso(row.started_at) : null, finishedAt: row.finished_at ? iso(row.finished_at) : null, createdAt: iso(row.created_at) };
}

function mapEvent(row: any): ExecutionEventDto {
  return { id: row.id, executionId: row.execution_id, sequence: row.sequence, eventType: row.event_type, payload: row.payload, createdAt: iso(row.created_at) };
}

function mapTicketSummary(row: any): TicketSummaryDto {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    sourceArtifactId: row.source_artifact_id ?? null,
    identifier: row.story_key,
    title: row.title,
    category: row.category,
    sourcePath: row.source_path,
    status: row.status,
    acceptanceCriteriaCount: Number(row.acceptance_criteria_count ?? 0),
    sourceReviewStatus: row.source_review_status ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapTicket(row: any): TicketDto {
  return { ...mapTicketSummary(row), content: row.content_snapshot };
}
