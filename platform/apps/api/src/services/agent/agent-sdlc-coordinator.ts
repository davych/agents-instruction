import {
  PHASE_IDS,
  type ArtifactDto,
  type ExecutionDto,
  type PhaseId,
  type PhaseRunDto,
} from "@ai-sdlc/contracts";

import { effectiveRequiredInputKeys } from "../../domain/change-routing.js";
import { AppError } from "../../domain/errors.js";
import type { WorkflowService } from "../workflow-service.js";
import { SDLC_ROLE_IDS } from "./conversation-planner.js";

export type SdlcRoleId = (typeof SDLC_ROLE_IDS)[number];

type WorkflowCoordinatorPort = Pick<WorkflowService, "getRun" | "executePhase">;

export type AgentSdlcAdvanceResult =
  | {
      state: "started";
      runId: string;
      phaseId: PhaseId;
      roleId: SdlcRoleId;
      execution: ExecutionDto;
      selectedArtifactIds: string[];
    }
  | {
      state: "running" | "awaiting_review" | "blocked" | "failed";
      runId: string;
      phaseId: PhaseId;
      roleId: SdlcRoleId;
      artifactKeys: string[];
      reason: string;
    }
  | {
      state: "completed";
      runId: string;
      artifactKeys: string[];
      reason: string;
    };

/**
 * A deliberately conservative bridge from a Chat turn into the canonical
 * WorkflowService. It never changes phase order, approves an Artifact, records
 * a human decision, or claims a role completed before the persisted Run says
 * so. Its only mutation is starting the one currently executable role.
 */
export class AgentSdlcCoordinator {
  constructor(private readonly workflow: WorkflowCoordinatorPort) {}

  async advance(input: {
    runId: string;
    /**
     * Compatibility name: these roles are focus labels only. They never
     * control scheduling, ownership, or whether any of the six roles runs.
     */
    requestedRoles: readonly SdlcRoleId[];
    startCurrentRole: boolean;
  }): Promise<AgentSdlcAdvanceResult> {
    const bundle = await this.workflow.getRun(input.runId);
    const artifactKeys = currentArtifactKeys(bundle.phases);
    if (bundle.run.status === "completed") {
      return {
        state: "completed",
        runId: input.runId,
        artifactKeys,
        reason: "六个阶段都已通过现有 Workflow 的审阅门禁；这条 Run 已完成。",
      };
    }

    const phase = firstIncompletePhase(bundle.phases);
    if (!phase) {
      return {
        state: "completed",
        runId: input.runId,
        artifactKeys,
        reason: "没有尚待处理的 SDLC 阶段。",
      };
    }
    const definition = bundle.definition.phases.find(({ id }) => id === phase.phaseId);
    if (!definition) {
      throw new AppError(
        `Run 缺少 ${phase.phaseId} 阶段定义`,
        500,
        "AGENT_SDLC_PHASE_DEFINITION_MISSING",
      );
    }
    const roleId = roleForPhase(phase.phaseId);
    if (definition.owner !== roleId) {
      throw new AppError(
        `${phase.phaseId} 的 owner 必须是 ${roleId}，当前 Control Pack 已偏离固定角色模型`,
        409,
        "AGENT_SDLC_ROLE_OWNERSHIP_MISMATCH",
      );
    }
    const phaseArtifactKeys = currentArtifactKeys([phase]);

    if (phase.status === "running") {
      return {
        state: "running",
        runId: input.runId,
        phaseId: phase.phaseId,
        roleId,
        artifactKeys: phaseArtifactKeys,
        reason: `${roleLabel(roleId)} 正在真实执行；不会并发启动同一阶段。`,
      };
    }
    if (phase.status === "awaiting_review") {
      return {
        state: "awaiting_review",
        runId: input.runId,
        phaseId: phase.phaseId,
        roleId,
        artifactKeys: phaseArtifactKeys,
        reason: `${roleLabel(roleId)} 已生成当前 Artifact，正在等待既有 Workflow 的审阅或人工决定；Agent 不会替人批准。`,
      };
    }
    if (phase.status === "pending") {
      return {
        state: "blocked",
        runId: input.runId,
        phaseId: phase.phaseId,
        roleId,
        artifactKeys: phaseArtifactKeys,
        reason: `${roleLabel(roleId)} 仍在等待前一阶段通过，不能越级执行。`,
      };
    }

    if (!input.startCurrentRole) {
      return {
        state: "blocked",
        runId: input.runId,
        phaseId: phase.phaseId,
        roleId,
        artifactKeys: phaseArtifactKeys,
        reason: `当前轮到 ${roleLabel(roleId)}；需要明确继续后才会启动真实执行。`,
      };
    }

    const configuredInputs = effectiveRequiredInputKeys(
      phase.phaseId,
      definition.inputs,
      bundle.phases,
      Boolean(bundle.run.changeContract),
      Object.fromEntries(bundle.definition.phases.map(({ id, outputs }) => [id, outputs])),
    );
    const selectedArtifacts = selectApprovedInputs(
      bundle.phases,
      phase.phaseId,
      configuredInputs,
    );
    let execution: ExecutionDto;
    try {
      execution = await this.workflow.executePhase(input.runId, phase.phaseId, {
        selectedArtifactIds: selectedArtifacts.map(({ id }) => id),
      });
    } catch (error) {
      if (error instanceof AppError) {
        return {
          state: "failed",
          runId: input.runId,
          phaseId: phase.phaseId,
          roleId,
          artifactKeys: phaseArtifactKeys,
          reason: `${roleLabel(roleId)} 尚未启动：${error.message}（${error.code}）。Run 已保留，可以修正配置后继续。`,
        };
      }
      throw error;
    }
    return {
      state: "started",
      runId: input.runId,
      phaseId: phase.phaseId,
      roleId,
      execution,
      selectedArtifactIds: selectedArtifacts.map(({ id }) => id),
    };
  }
}

export interface ExplicitRoleContinuation {
  explicit: boolean;
  roles: SdlcRoleId[];
}

/**
 * Deterministic syntax is intentionally small. The LLM still plans the task,
 * while this parser only decides whether a message may reuse the latest Run.
 * That prevents an ordinary new task from being silently attached to old work.
 */
export function explicitRoleContinuation(content: string): ExplicitRoleContinuation {
  const roles = SDLC_ROLE_IDS.filter((roleId) => rolePatterns[roleId].test(content));
  const explicit = /(?:\b(?:continue|resume|involve)\b|继续|接着|推进|恢复|串起来)/iu.test(content)
    || /(?:让|请|叫).{0,16}(?:产品经理|需求分析|设计师|架构师|软件工程师|开发工程师|测试工程师|DevOps|运维)/iu.test(content);
  return { explicit, roles };
}

export function latestSessionRunId(sessionRuns: ReadonlyArray<{
  workflowRunId: string;
  createdAt: string;
}>): string | null {
  for (let index = sessionRuns.length - 1; index >= 0; index -= 1) {
    const association = sessionRuns[index];
    if (association?.workflowRunId) return association.workflowRunId;
  }
  return null;
}

const rolePatterns: Record<SdlcRoleId, RegExp> = {
  "pm-ba": /(?:\b(?:pm|ba|product manager|business analyst)\b|产品经理|需求分析)/iu,
  designer: /(?:\b(?:designer|design)\b|设计师|交互设计|体验设计)/iu,
  architect: /(?:\b(?:architect|architecture)\b|架构师|架构设计)/iu,
  "software-engineer": /(?:\b(?:software engineer|engineer|developer|implementation)\b|软件工程师|开发工程师|实现)/iu,
  tester: /(?:\b(?:tester|qa|verification)\b|测试工程师|测试角色|验证)/iu,
  devops: /(?:\b(?:devops|release engineer)\b|运维|发布工程师)/iu,
};

const phaseRole: Record<PhaseId, SdlcRoleId> = {
  discovery: "pm-ba",
  design: "designer",
  architecture: "architect",
  implementation: "software-engineer",
  verification: "tester",
  release: "devops",
};

function roleForPhase(phaseId: PhaseId): SdlcRoleId {
  return phaseRole[phaseId];
}

function roleLabel(roleId: SdlcRoleId): string {
  return {
    "pm-ba": "PM / BA",
    designer: "Designer",
    architect: "Architect",
    "software-engineer": "Software Engineer",
    tester: "Tester",
    devops: "DevOps",
  }[roleId];
}

function firstIncompletePhase(phases: readonly PhaseRunDto[]): PhaseRunDto | undefined {
  const byId = new Map(phases.map((phase) => [phase.phaseId, phase]));
  return PHASE_IDS.map((phaseId) => byId.get(phaseId))
    .find((phase): phase is PhaseRunDto => Boolean(phase && phase.status !== "approved"));
}

function currentArtifactKeys(phases: readonly PhaseRunDto[]): string[] {
  return [...new Set(phases.flatMap((phase) => phase.artifacts)
    .filter(({ reviewStatus }) => reviewStatus !== "superseded")
    .map(({ artifactKey }) => artifactKey))];
}

function selectApprovedInputs(
  phases: readonly PhaseRunDto[],
  targetPhaseId: PhaseId,
  requiredKeys: readonly string[],
): ArtifactDto[] {
  if (targetPhaseId === "discovery") return [];
  const targetPosition = PHASE_IDS.indexOf(targetPhaseId);
  const byKey = new Map<string, ArtifactDto>();
  for (const phase of phases) {
    if (phase.position >= targetPosition || phase.status !== "approved") continue;
    for (const artifact of phase.artifacts) {
      if (artifact.reviewStatus !== "approved") continue;
      const previous = byKey.get(artifact.artifactKey);
      if (!previous || artifact.revision > previous.revision) byKey.set(artifact.artifactKey, artifact);
    }
  }
  const missing = requiredKeys.filter((key) => !byKey.has(key));
  if (missing.length > 0) {
    throw new AppError(
      `当前角色缺少已批准的上游产物：${missing.join(", ")}`,
      409,
      "AGENT_SDLC_APPROVED_INPUTS_MISSING",
      { phaseId: targetPhaseId, missing },
    );
  }
  return requiredKeys.map((key) => byKey.get(key)!);
}
