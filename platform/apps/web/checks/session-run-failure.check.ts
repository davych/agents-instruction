import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  latestFailedPhaseExecutionError,
  latestPhaseExecution,
  latestPhaseExecutionProgress,
  phaseRunEventMessage,
} from "../src/lib/session-run-failure.ts";
import type { Execution, PhaseRun } from "../src/lib/types.ts";

const execution = (id: string, patch: Partial<Execution> = {}): Execution => ({
  id,
  status: "failed",
  ...patch,
});

const failedPhase = (executions: Execution[]): PhaseRun => ({
  phaseId: "implementation",
  status: "failed",
  artifacts: [],
  reviews: [],
  executions,
  events: [],
});

test("the failed Session card selects the newest comparable execution timestamp", () => {
  const older = execution("older", {
    error: "旧错误",
    createdAt: "2026-08-29T08:00:00.000Z",
  });
  const newer = execution("newer", {
    error: "新错误",
    startedAt: "2026-08-29T09:00:00.000Z",
  });

  assert.equal(latestPhaseExecution([older, newer])?.id, "newer");
  assert.equal(latestFailedPhaseExecutionError(failedPhase([older, newer])), "新错误");
});

test("incomplete timestamp data preserves the API array's newest-first semantics", () => {
  const newest = execution("newest", { error: "数组首项", createdAt: undefined });
  const older = execution("older", {
    error: "不应选中",
    createdAt: "2026-08-29T08:00:00.000Z",
  });

  assert.equal(latestPhaseExecution([newest, older])?.id, "newest");
  assert.equal(latestFailedPhaseExecutionError(failedPhase([newest, older])), "数组首项");
});

test("an empty latest error never reveals an older error or renders outside failed state", () => {
  const latestWithoutError = execution("latest", {
    error: "   ",
    createdAt: "2026-08-29T10:00:00.000Z",
  });
  const older = execution("older", {
    error: "旧错误",
    createdAt: "2026-08-29T08:00:00.000Z",
  });
  assert.equal(
    latestFailedPhaseExecutionError(failedPhase([older, latestWithoutError])),
    undefined,
  );
  assert.equal(
    latestFailedPhaseExecutionError({ ...failedPhase([older]), status: "ready" }),
    undefined,
  );
});

test("Session progress is scoped to the newest execution and renders safe tool activity", () => {
  const older = execution("older", {
    createdAt: "2026-08-29T08:00:00.000Z",
  });
  const current = execution("current", {
    status: "running",
    createdAt: "2026-08-29T09:00:00.000Z",
  });
  const phase: PhaseRun = {
    ...failedPhase([older, current]),
    status: "running",
    events: [
      {
        id: "old-finished",
        executionId: older.id,
        sequence: 1,
        eventType: "provider.tool.finished",
        payload: { summary: "旧 execution 不应计入" },
        createdAt: "2026-08-29T08:00:10.000Z",
      },
      {
        id: "current-finished",
        executionId: current.id,
        sequence: 2,
        eventType: "provider.tool.finished",
        payload: { summary: "读取完成", status: "completed" },
        createdAt: "2026-08-29T09:00:10.000Z",
      },
      {
        id: "current-started",
        executionId: current.id,
        sequence: 3,
        eventType: "provider.tool.started",
        payload: { toolName: "write_file" },
        createdAt: "2026-08-29T09:00:20.000Z",
      },
      {
        id: "current-required-tool-retry",
        executionId: current.id,
        sequence: 4,
        eventType: "provider.tool.retry-required",
        payload: { attempt: 1, maxAttempts: 1 },
        createdAt: "2026-08-29T09:00:30.000Z",
      },
    ],
  };

  assert.deepEqual(latestPhaseExecutionProgress(phase), {
    executionId: "current",
    finishedToolSteps: 1,
    completedToolSteps: 1,
    failedToolSteps: 0,
    latestMessage: "模型未选择必需工具，平台正在强制重试（第 1/1 次）",
    latestAt: "2026-08-29T09:00:30.000Z",
  });
  assert.equal(phaseRunEventMessage({
    id: "unknown-started",
    eventType: "provider.tool.started",
    payload: { toolName: "untrusted-private-tool" },
  }), "开始执行受限工具");
  assert.equal(phaseRunEventMessage({
    id: "repair-progress",
    eventType: "provider.finalization.rejected",
    payload: { repairRound: 1, maxRepairRounds: 2 },
  }), "产物质量校验未通过，正在自动修复（第 1/2 轮）");
  assert.equal(phaseRunEventMessage({
    id: "materialization-repair-progress",
    eventType: "provider.finalization.rejected",
    payload: {
      repairRound: 1,
      maxRepairRounds: 2,
      reasonCode: "PRODUCT_DECISION_MATERIALIZATION_REQUIRED",
      affectedArtifactKeys: ["prd", "user-stories"],
      issueIds: ["PRODUCT-MATERIALIZATION-PRD-PENDING-SECTION"],
    },
  }), "产物质量校验未通过，正在自动修复；PRD / User Stories仍含未物化决定、开放问题或 Blocker（第 1/2 轮）");
  assert.equal(phaseRunEventMessage({
    id: "required-tool-retry",
    eventType: "provider.tool.retry-required",
    payload: { attempt: 1, maxAttempts: 2 },
  }), "模型未选择必需工具，平台正在强制重试（第 1/2 次）");
  assert.equal(phaseRunEventMessage({
    id: "required-write-retry",
    eventType: "provider.tool.retry-required",
    payload: { attempt: 1, maxAttempts: 1, requiredToolName: "write_file" },
  }), "模型未选择修复必需的“写入文件”，平台正在强制重试（第 1/1 次）");
  assert.equal(phaseRunEventMessage({
    id: "materialization-write-retry",
    eventType: "provider.tool.retry-required",
    payload: {
      attempt: 2,
      maxAttempts: 2,
      requiredToolName: "write_file",
      reasonCode: "PRODUCT_DECISION_MATERIALIZATION_REQUIRED",
      affectedArtifactKeys: ["prd"],
    },
  }), "模型未选择修复必需的“写入文件”，平台正在强制重试；PRD仍含未物化决定、开放问题或 Blocker（第 2/2 次）");
  assert.equal(phaseRunEventMessage({
    id: "blocker-started",
    eventType: "provider.tool.started",
    payload: { toolName: "write_user_stories_blocker" },
  }), "开始生成结构化 User Stories Blocker");
});

test("SessionRunStatusCard renders a safely wrapping error with retry and model settings actions", async () => {
  const workspace = await readFile(
    fileURLToPath(new URL("../src/pages/agent-workspace-page.tsx", import.meta.url)),
    "utf8",
  );

  assert.match(workspace, /latestFailedPhaseExecutionError\(phase\)/u);
  assert.match(workspace, /latestPhaseExecutionProgress\(phase\)/u);
  assert.match(workspace, /本轮执行进度/u);
  assert.match(workspace, /已返回 \{executionProgress\.finishedToolSteps\} 个工具结果/u);
  assert.match(workspace, /completedToolSteps/u);
  assert.match(workspace, /failedToolSteps/u);
  assert.match(workspace, /最近动作：\{executionProgress\.latestMessage\}/u);
  assert.match(workspace, /最近一次执行错误/u);
  assert.match(workspace, /whitespace-pre-wrap break-words[^"\n]*overflow-wrap:anywhere/u);
  assert.match(workspace, /canContinue \|\| phase\.status === "failed"[\s\S]{0,240}disabled=\{!canContinue \|\| conversationBusy \|\| continuing\}/u);
  assert.match(workspace, /phase\.status === "failed"[\s\S]{0,100}"重试当前角色"/u);
  assert.match(workspace, /!canContinue \|\| phase\.status === "failed"[\s\S]{0,300}模型设置/u);
  assert.match(workspace, /isCurrentRoleRepairGate\(decisionGate\)/u);
  assert.match(workspace, /让 \{role\} 补做并重跑/u);
  assert.match(workspace, /查看补做原因/u);
});

test("a failed Session keeps prior artifact heads visible read-only and exposes structured blockers", async () => {
  const workspace = await readFile(
    fileURLToPath(new URL("../src/pages/agent-workspace-page.tsx", import.meta.url)),
    "utf8",
  );

  assert.match(
    workspace,
    /phase\.status === "failed" && currentArtifactHeads\(phase\.artifacts\)\.length > 0[\s\S]{0,180}<FailedPhaseArtifactsCard/u,
    "failed phases with persisted heads must keep a Session-local artifact viewer",
  );
  assert.match(workspace, /查看失败后保留的产物/u);
  assert.match(workspace, /只读 · 不能批准/u);
  assert.match(workspace, /所选产物路径上未完成或未通过门禁的写入已回滚/u);
  assert.match(workspace, /其他允许变更（如有）仍可在 Diff 中复核/u);

  assert.match(
    workspace,
    /const decisionAwarePhase = Boolean\([\s\S]{0,180}\["awaiting_review", "failed"\]\.includes\(phase\.status\)[\s\S]{0,180}\["discovery", "design", "architecture"\]\.includes\(phase\.phaseId\)/u,
    "failed discovery/design/architecture phases must participate in the human-decision gate",
  );
  assert.match(
    workspace,
    /const decisionsBlocking = Boolean\(decisionAwarePhase && decisionGate && decisionGate\.blockingCount > 0\)/u,
  );
  assert.match(
    workspace,
    /phase\?\.status === "failed"[\s\S]{0,180}本次不能批准；仍有 \$\{decisionGate\.blockingCount\} 项结构化决定或待办/u,
  );
  assert.match(
    workspace,
    /你决定 \{decisionGate\.decisionCount\} 项 · 角色补做 \{decisionGate\.workCount\} 项 · 上游依赖 \{decisionGate\.dependencyCount\} 项/u,
    "the failed Session must show each blocker category count instead of only a generic error",
  );
});
