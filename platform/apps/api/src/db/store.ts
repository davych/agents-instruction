import { randomUUID } from "node:crypto";

import {
  PHASE_IDS,
  architectureImpactToPhaseResolution,
  architectureImpactSchema,
  changeContractSchema,
  phaseResolutionSchema,
  type ArchitectureImpactDto,
  type ArtifactDto,
  type ChangeContractDto,
  type CodexReasoningEffort,
  type CodexRunnerMode,
  type ExecutionDto,
  type ExecutionEventDto,
  type PhaseId,
  type PhaseStatus,
  type PhaseResolutionDto,
  type PhaseRunDto,
  type ProjectDto,
  type ReviewDecision,
  type ReviewDto,
  type TicketDto,
  type TicketStatus,
  type TicketSummaryDto,
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
  project: ProjectDto;
  phases: PhaseRunDto[];
  artifactPaths: Record<string, string>;
}

export interface CreateRunPersistence {
  runId: string;
  artifactPaths: Record<string, string>;
  changeContract?: ChangeContractDto;
  changeContractArtifact?: ArtifactRecordInput;
}

export interface ArchitectureBaselineRecord {
  sourceRunId: string;
  sourceRunTitle: string;
  sourcePhaseRunId: string;
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

  async listProjects(): Promise<ProjectDto[]> {
    const { rows } = await this.pool.query(
      `SELECT p.*, count(wr.id)::integer AS run_count
       FROM projects p
       LEFT JOIN workflow_runs wr ON wr.project_id = p.id
       GROUP BY p.id
       ORDER BY p.created_at DESC`
    );
    return rows.map(mapProject);
  }

  async createProject(input: { name: string; summary: string; rootPath: string; configPath: string }): Promise<ProjectDto> {
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

  async getProject(id: string): Promise<ProjectDto> {
    const { rows } = await this.pool.query("SELECT * FROM projects WHERE id = $1", [id]);
    if (!rows[0]) throw notFound("项目");
    return mapProject(rows[0]);
  }

  async listRuns(projectId: string): Promise<WorkflowRunDto[]> {
    await this.getProject(projectId);
    const { rows } = await this.pool.query(
      "SELECT * FROM workflow_runs WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    return rows.map(mapRun);
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
      const project = await client.query("SELECT id FROM projects WHERE id = $1", [projectId]);
      if (!project.rows[0]) throw notFound("项目");
      const runId = persistence.runId;
      const runResult = await client.query(
        `INSERT INTO workflow_runs
           (id, project_id, title, objective, artifact_paths, change_contract, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'active') RETURNING *`,
        [
          runId,
          projectId,
          title,
          objective,
          JSON.stringify(persistence.artifactPaths),
          persistence.changeContract ? JSON.stringify(persistence.changeContract) : null,
        ]
      );
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
      await client.query("COMMIT");
      return mapRun(runResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getRun(runId: string): Promise<RunBundle> {
    const runResult = await this.pool.query(
      `SELECT wr.*, p.id AS p_id, p.name AS p_name, p.summary AS p_summary,
              p.root_path AS p_root_path, p.config_path AS p_config_path,
              p.created_at AS p_created_at, p.updated_at AS p_updated_at
       FROM workflow_runs wr JOIN projects p ON p.id = wr.project_id WHERE wr.id = $1`,
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
        root_path: row.p_root_path,
        config_path: row.p_config_path,
        created_at: row.p_created_at,
        updated_at: row.p_updated_at
      }),
      phases,
      artifactPaths: mapArtifactPaths(row.artifact_paths)
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
      `SELECT pr.*, wr.id AS source_run_id, wr.title AS source_run_title
       FROM phase_runs pr
       JOIN workflow_runs wr ON wr.id = pr.workflow_run_id
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

      const [targetArtifactsResult, targetExecutions, targetReviews] = await Promise.all([
        client.query(
          `SELECT * FROM artifacts
           WHERE phase_run_id = $1 AND review_status <> 'superseded'
           FOR UPDATE`,
          [target.id],
        ),
        client.query("SELECT id FROM executions WHERE phase_run_id = $1 FOR UPDATE", [target.id]),
        client.query("SELECT id FROM reviews WHERE phase_run_id = $1 FOR UPDATE", [target.id]),
      ]);
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
      `SELECT pr.*, wr.id AS source_run_id, wr.title AS source_run_title
       FROM phase_runs pr
       JOIN workflow_runs wr ON wr.id = pr.workflow_run_id
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

      const [currentArtifacts, currentExecutions, currentReviews] = await Promise.all([
        client.query("SELECT id FROM artifacts WHERE phase_run_id = $1 FOR UPDATE", [current.id]),
        client.query("SELECT id FROM executions WHERE phase_run_id = $1 FOR UPDATE", [current.id]),
        client.query("SELECT id FROM reviews WHERE phase_run_id = $1 FOR UPDATE", [current.id]),
      ]);
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
      `SELECT p.root_path, pr.workflow_run_id, pr.phase_id
       FROM artifacts a
       JOIN phase_runs pr ON pr.id = a.phase_run_id
       JOIN workflow_runs wr ON wr.id = pr.workflow_run_id
       JOIN projects p ON p.id = wr.project_id
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

function mapProject(row: any): ProjectDto {
  return { id: row.id, name: row.name, summary: row.summary, rootPath: row.root_path, configPath: row.config_path, runCount: Number(row.run_count ?? 0), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function mapRun(row: any): WorkflowRunDto {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    objective: row.objective,
    changeContract: mapChangeContract(row.change_contract),
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
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
