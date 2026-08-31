import type { Execution, PhaseRun, RunEvent } from "@/lib/types";

function executionTime(execution: Execution): number | undefined {
  for (const candidate of [execution.createdAt, execution.startedAt]) {
    if (!candidate) continue;
    const timestamp = Date.parse(candidate);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

export function latestPhaseExecution(executions: Execution[]): Execution | undefined {
  if (executions.length === 0) return undefined;
  const ranked = executions.map((execution, index) => ({
    execution,
    index,
    timestamp: executionTime(execution),
  }));
  if (ranked.some(({ timestamp }) => timestamp === undefined)) return executions[0];
  return ranked.sort((left, right) => (
    right.timestamp! - left.timestamp! || left.index - right.index
  ))[0]?.execution;
}

export function latestFailedPhaseExecutionError(phase: PhaseRun | undefined): string | undefined {
  if (phase?.status !== "failed") return undefined;
  const error = latestPhaseExecution(phase.executions ?? [])?.error?.trim();
  return error || undefined;
}

const PROVIDER_TOOL_ACTIVITY_TYPES = new Set([
  "provider.tool.started",
  "provider.tool.finished",
  "provider.tool.retry-required",
  "provider.finalization.rejected",
]);

const TOOL_ACTION_LABELS: Record<string, string> = {
  list_files: "查看目录",
  read_file: "读取文件",
  search_text: "搜索文本",
  create_directory: "准备目录",
  write_file: "写入文件",
  apply_patch: "应用补丁",
  run_check: "运行检查",
  write_user_stories_blocker: "生成结构化 User Stories Blocker",
};

const ARTIFACT_LABELS: Record<string, string> = {
  prd: "PRD",
  "user-stories": "User Stories",
};

function finalizationAuditMessage(payload: Record<string, unknown>): string | undefined {
  const artifactKeys = Array.isArray(payload.affectedArtifactKeys)
    ? payload.affectedArtifactKeys.filter((value): value is string => (
        typeof value === "string" && Object.hasOwn(ARTIFACT_LABELS, value)
      ))
    : [];
  const artifacts = [...new Set(artifactKeys.map((key) => ARTIFACT_LABELS[key]))];
  if (payload.reasonCode === "PRODUCT_DECISION_MATERIALIZATION_REQUIRED") {
    return `${artifacts.length > 0 ? artifacts.join(" / ") : "产品产物"}仍含未物化决定、开放问题或 Blocker`;
  }
  return artifacts.length > 0
    ? `需修复：${artifacts.join(" / ")}`
    : undefined;
}

function eventType(event: RunEvent): string {
  return event.eventType || event.type || "";
}

function eventTimestamp(event: RunEvent): string | undefined {
  return event.createdAt || event.timestamp;
}

/** Safe human-facing summary shared by Session progress and advanced audit. */
export function phaseRunEventMessage(event: RunEvent): string {
  if (event.message) return event.message;
  if (event.payload && typeof event.payload === "object") {
    const payload = event.payload as Record<string, unknown>;
    const candidate = payload.message || payload.text || payload.summary || payload.command;
    if (typeof candidate === "string") return candidate;
    if (eventType(event) === "provider.tool.started") {
      const action = typeof payload.toolName === "string"
        ? TOOL_ACTION_LABELS[payload.toolName]
        : undefined;
      return action ? `开始${action}` : "开始执行受限工具";
    }
    if (eventType(event) === "provider.tool.retry-required") {
      const attempt = typeof payload.attempt === "number"
        ? payload.attempt
        : undefined;
      const maxAttempts = typeof payload.maxAttempts === "number"
        ? payload.maxAttempts
        : undefined;
      const requiredTool = typeof payload.requiredToolName === "string"
        ? TOOL_ACTION_LABELS[payload.requiredToolName]
        : undefined;
      const action = requiredTool
        ? `模型未选择修复必需的“${requiredTool}”，平台正在强制重试`
        : "模型未选择必需工具，平台正在强制重试";
      const auditMessage = finalizationAuditMessage(payload);
      const message = auditMessage ? `${action}；${auditMessage}` : action;
      return attempt !== undefined && maxAttempts !== undefined
        ? `${message}（第 ${attempt}/${maxAttempts} 次）`
        : message;
    }
    if (eventType(event) === "provider.finalization.rejected") {
      const repairRound = typeof payload.repairRound === "number"
        ? payload.repairRound
        : undefined;
      const maxRepairRounds = typeof payload.maxRepairRounds === "number"
        ? payload.maxRepairRounds
        : undefined;
      const action = "产物质量校验未通过，正在自动修复";
      const auditMessage = finalizationAuditMessage(payload);
      const message = auditMessage ? `${action}；${auditMessage}` : action;
      return repairRound !== undefined && maxRepairRounds !== undefined
        ? `${message}（第 ${repairRound}/${maxRepairRounds} 轮）`
        : message;
    }
    if (payload.item && typeof payload.item === "object") {
      const item = payload.item as Record<string, unknown>;
      const itemText = item.text || item.command || item.name;
      if (typeof itemText === "string") return itemText;
      if (typeof item.type === "string") {
        const status = typeof item.status === "string" ? ` · ${item.status}` : "";
        return `${item.type}${status}`;
      }
    }
  }
  return eventType(event) || "执行事件";
}

export interface PhaseExecutionProgress {
  executionId: string;
  finishedToolSteps: number;
  completedToolSteps: number;
  failedToolSteps: number;
  latestMessage: string;
  latestAt?: string;
}

/** Restrict progress to the newest execution so retries never mix timelines. */
export function latestPhaseExecutionProgress(
  phase: PhaseRun | undefined,
): PhaseExecutionProgress | undefined {
  if (!phase) return undefined;
  const execution = latestPhaseExecution(phase.executions ?? []);
  if (!execution) return undefined;
  const activity = (phase.events ?? [])
    .filter((event) => (
      event.executionId === execution.id
      && PROVIDER_TOOL_ACTIVITY_TYPES.has(eventType(event))
    ))
    .sort((left, right) => {
      const byTime = String(eventTimestamp(right) ?? "").localeCompare(
        String(eventTimestamp(left) ?? ""),
      );
      if (byTime !== 0) return byTime;
      return (right.sequence ?? 0) - (left.sequence ?? 0);
    });
  const latest = activity[0];
  if (!latest) return undefined;
  const finishedTools = activity.filter((event) => (
    eventType(event) === "provider.tool.finished"
  ));
  return {
    executionId: execution.id,
    finishedToolSteps: finishedTools.length,
    completedToolSteps: finishedTools.filter((event) => (
      (event.payload as Record<string, unknown> | undefined)?.status === "completed"
    )).length,
    failedToolSteps: finishedTools.filter((event) => (
      (event.payload as Record<string, unknown> | undefined)?.status === "failed"
    )).length,
    latestMessage: phaseRunEventMessage(latest),
    ...(eventTimestamp(latest) ? { latestAt: eventTimestamp(latest) } : {}),
  };
}
