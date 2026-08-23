import { AppError } from "./errors.js";
import { resolveEngineeringAcceptanceCriteria } from "./engineering-acceptance-criteria.js";
import {
  assessDeferredDesignValidations,
  isDeferredDesignVerification,
} from "./design-deferred-validation.js";

interface SelectedImplementationInput {
  artifactKey: string;
  sourceStatus: "pending" | "ready" | "running" | "awaiting_review" | "approved" | "changes_requested" | "failed";
  content: string;
}

export type ImplementationReadinessRole = "pm-ba" | "designer" | "architect";

export interface ImplementationReadinessIssue {
  code: "ACCEPTANCE_CRITERIA_MISSING" | "PRODUCT_BLOCKED" | "DESIGN_BLOCKED" | "ARCHITECTURE_BLOCKED";
  role: ImplementationReadinessRole;
  artifactKey: "user-stories" | "prd" | "design-spec" | "architecture";
  title: string;
  detail: string;
  blockerIds: string[];
  blockers: Array<{ id: string; decision: string; owner: string; nextAction: string }>;
}

export interface ImplementationReadinessResult {
  ready: boolean;
  acceptanceCriteria: string[];
  issues: ImplementationReadinessIssue[];
}

export function assessImplementationReadiness(input: {
  changeContractCriteria?: readonly string[] | null;
  selectedArtifacts: readonly SelectedImplementationInput[];
}): ImplementationReadinessResult {
  const acceptanceCriteria = resolveEngineeringAcceptanceCriteria(input);
  const issues: ImplementationReadinessIssue[] = [];
  if (acceptanceCriteria.length === 0) {
    issues.push({
      code: "ACCEPTANCE_CRITERIA_MISSING",
      role: "pm-ba",
      artifactKey: "user-stories",
      title: "缺少可执行的验收标准",
      detail: "Change Contract 没有 AC，且已批准、已选中的 User Stories 中没有稳定 AC 标题。",
      blockerIds: [],
      blockers: [],
    });
  }

  for (const artifact of input.selectedArtifacts) {
    if (artifact.artifactKey === "prd") {
      const status = markdownStrongField(artifact.content, "Status");
      if (status && /(?:blocked|pending\s+human|not\s+ready|needs?\s+decision)/iu.test(status)) {
        issues.push({
          code: "PRODUCT_BLOCKED",
          role: "pm-ba",
          artifactKey: "prd",
          title: "产品定义仍有人工决定未完成",
          detail: `PRD 状态为“${status}”。请先完成产品决策并重新审核 Product。`,
          blockerIds: stableBlockerIds(artifact.content),
          blockers: [],
        });
      }
    }

    if (artifact.artifactKey === "design-spec") {
      const design = parseDesignEnvelope(artifact.content);
      if (!design) {
        issues.push({
          code: "DESIGN_BLOCKED",
          role: "designer",
          artifactKey: "design-spec",
          title: "设计合同无法解析",
          detail: "design-spec 缺少有效的首个 JSON 合同，不能证明 ready-for-engineering。",
          blockerIds: [],
          blockers: [],
        });
      } else {
        const deferredAssessment = assessDeferredDesignValidations(design.deferredValidations);
        const blockers = design.blockers.flatMap((blocker) => {
          if (typeof blocker !== "object" || blocker === null) return [];
          const record = blocker as Record<string, unknown>;
          const id = String(record.id ?? "").trim();
          const decision = String(record.decision ?? "").trim();
          if (!id && !decision) return [];
          return [{
            id,
            decision,
            owner: String(record.owner ?? "").trim(),
            nextAction: String(record.next_action ?? record.nextAction ?? "").trim(),
          }];
        });
        if (
          design.status !== "ready-for-engineering"
          || design.blockers.length > 0
          || design.contractErrors.length > 0
          || deferredAssessment.errors.length > 0
        ) {
          const activeBlockers = blockers.filter((blocker) => !isDeferredDesignVerification(blocker));
          const blockerIds = activeBlockers.map(({ id }) => id).filter(Boolean);
          issues.push({
            code: "DESIGN_BLOCKED",
            role: "designer",
            artifactKey: "design-spec",
            title: "设计还不能交给工程实现",
            detail: `Design status=${design.status || "missing"}，blockers=${design.blockers.length}，contract errors=${design.contractErrors.length}，deferred validation errors=${deferredAssessment.errors.length}。请先解决会改变实现合同的设计 blocker；仅依赖可运行实现的验证也必须先移入有效的 deferred_validations，并提交 status=ready-for-engineering、blockers=[] 的正式交接。`,
            blockerIds,
            blockers: activeBlockers,
          });
        }
      }
    }

    if (artifact.artifactKey === "architecture") {
      const status = markdownStrongField(artifact.content, "Status");
      if (
        (status && /\bblocked\b/iu.test(status))
        || /"state"\s*:\s*"blocked"/iu.test(artifact.content)
      ) {
        issues.push({
          code: "ARCHITECTURE_BLOCKED",
          role: "architect",
          artifactKey: "architecture",
          title: "架构包仍明确标记为 Blocked",
          detail: `Architecture 状态为“${status || "blocked"}”。请先完成架构决定、NFR 与人工验收，再进入实现。`,
          blockerIds: stableBlockerIds(artifact.content),
          blockers: [],
        });
      }
    }
  }

  return { ready: issues.length === 0, acceptanceCriteria, issues };
}

export function assertImplementationReady(input: {
  changeContractCriteria?: readonly string[] | null;
  selectedArtifacts: readonly SelectedImplementationInput[];
}): ImplementationReadinessResult {
  const result = assessImplementationReadiness(input);
  if (!result.ready) {
    throw new AppError(
      `当前输入还不能开始写代码：${result.issues.map((issue) => issue.title).join("；")}`,
      409,
      "IMPLEMENTATION_NOT_READY",
      { issues: result.issues, acceptanceCriteriaCount: result.acceptanceCriteria.length },
    );
  }
  return result;
}

function markdownStrongField(content: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\*\\*${escaped}:\\*\\*[ \\t]*(.+?)[ \\t]*$`, "imu")
    .exec(content)?.[1]?.trim() ?? null;
}

function parseDesignEnvelope(content: string): {
  status: string;
  blockers: unknown[];
  deferredValidations: unknown;
  contractErrors: string[];
} | null {
  const match = /```json\s*([\s\S]*?)```/iu.exec(content);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]) as Record<string, unknown>;
    const blockersValid = Array.isArray(value.blockers);
    return {
      status: typeof value.status === "string" ? value.status.trim().toLocaleLowerCase("en-US") : "",
      blockers: blockersValid ? value.blockers as unknown[] : [],
      deferredValidations: value.deferred_validations,
      contractErrors: blockersValid ? [] : ["blockers must be an array"],
    };
  } catch {
    return null;
  }
}

function stableBlockerIds(content: string): string[] {
  return [...new Set([...content.matchAll(/\b(?:B|PROD|DES|ARCH)-\d{2,}\b/giu)]
    .map((match) => match[0]?.toUpperCase())
    .filter((value): value is string => Boolean(value)))]
    .slice(0, 20);
}
