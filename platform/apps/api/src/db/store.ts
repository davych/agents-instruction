import { randomUUID } from "node:crypto";

import {
  PHASE_IDS,
  type ArtifactDto,
  type CodexReasoningEffort,
  type CodexRunnerMode,
  type ExecutionDto,
  type ExecutionEventDto,
  type PhaseId,
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
import { assertPhaseExecutable, assertPhaseReviewable } from "../domain/workflow.js";

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

export type CurrentArtifactSnapshot = ArtifactDto & { content: string };

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
        `INSERT INTO workflow_runs (id, project_id, title, objective, status, artifact_paths)
         VALUES ($1, $2, $3, $4, 'active', $5::jsonb) RETURNING *`,
        [runId, projectId, title, objective, JSON.stringify(persistence.artifactPaths)]
      );
      for (const [position, phaseId] of PHASE_IDS.entries()) {
        await client.query(
          `INSERT INTO phase_runs (id, workflow_run_id, phase_id, position, status)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), runId, phaseId, position, position === 0 ? "ready" : "pending"]
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
      content: row.content_snapshot
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
    expectedArtifactIds: string[]
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
      assertPhaseReviewable(phase.status);
      const headResult = await client.query(
        `SELECT a.id, a.artifact_key
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
        `SELECT a.*, pr.workflow_run_id, pr.position, pr.status AS phase_status
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
       SET status = 'pending', updated_at = now()
       WHERE workflow_run_id = $1 AND position > $2 AND status <> 'pending'`,
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
  return { id: row.id, projectId: row.project_id, title: row.title, objective: row.objective, status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function mapPhase(row: any): Omit<PhaseRunDto, "artifacts" | "reviews" | "executions" | "events" | "availableArtifacts"> {
  return { id: row.id, workflowRunId: row.workflow_run_id, phaseId: row.phase_id, position: row.position, status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
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
