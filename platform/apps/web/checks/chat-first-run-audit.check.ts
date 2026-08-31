import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifiedAgentSessionRun } from "../src/lib/agent-session-run-context.ts";
import type { AgentSession } from "../src/lib/types.ts";
import { phaseRunEventMessage } from "../src/lib/session-run-failure.ts";
import { phaseStatusLabel } from "../src/lib/workflow.ts";

const source = (relative: string) => readFile(
  fileURLToPath(new URL(`../src/${relative}`, import.meta.url)),
  "utf8",
);

test("CHAT-AC-24: a Session-linked Run stays an advanced audit view and preserves Session routing", async () => {
  const app = await source("App.tsx");
  const runPageStart = app.indexOf("<RunPage");
  const runPageEnd = app.indexOf("/>", runPageStart);
  assert.ok(runPageStart >= 0 && runPageEnd > runPageStart, "App must render RunPage");
  const binding = app.slice(runPageStart, runPageEnd + 2);

  assert.match(binding, /sessionId=\{route\.sessionId\}/u);
  assert.match(binding, /onReturnToSession=\{\(projectId, verifiedSessionId\) => navigate\(\{[\s\S]*?sessionId: verifiedSessionId \|\| route\.sessionId[\s\S]*?projectView: "workspace"/u);
  assert.ok(
    (binding.match(/sessionId: route\.sessionId/gu)?.length ?? 0) >= 3,
    "workflow/ticket navigation must not drop the originating Session",
  );
  assert.match(app, /label: "Agent 工作台",[\s\S]{0,100}navigate\(\{ projectId: route\.projectId \}\)/u);
  assert.doesNotMatch(app, /label: route\.sessionId \? "Agent Session"/u);
  assert.match(binding, /onBack=\{\(projectId\) => navigate\(\{ projectId: projectId \|\| route\.projectId \}\)\}/u);
});

test("CHAT-AC-24: execution intents return to the original Session while audit-only review remains here", async () => {
  const [run, review] = await Promise.all([
    source("pages/run-page.tsx"),
    source("components/run/review-dialog.tsx"),
  ]);

  assert.match(run, /const authoritativeSessionId = runQuery\.data\?\.agentSession\?\.sessionId/u);
  assert.match(run, /api\.getAgentSession\(authoritativeSessionId!, \{ signal \}\)/u);
  assert.match(run, /const sessionAssociation = authoritativeSessionId && agentSessionDetailQuery\.isSuccess[\s\S]{0,180}verifiedAgentSessionRun\(authoritativeSessionId, runId, agentSessionDetailQuery\.data\)/u);
  assert.match(run, /const sessionAudit = Boolean\(sessionAssociation\)/u);
  assert.match(
    run,
    /const sessionRouteUnverified = Boolean\(authoritativeSessionId && !sessionAudit\)/u,
  );
  assert.match(
    run,
    /const requestPhaseExecution = \(target: ExecuteTarget\) => \{[\s\S]{0,160}if \(sessionRouteUnverified \|\| sessionRunCompleted \|\| sessionArchived\) return;[\s\S]{0,240}if \(sessionAudit\)[\s\S]{0,240}onReturnToSession\(run\.projectId, sessionAssociation\?\.sessionId\)[\s\S]{0,160}setExecuteTarget\(target\)/u,
  );
  assert.doesNotMatch(
    run,
    /setExecuteTarget\(\s*\{/u,
    "every execution/retry continuation must use the Session-aware dispatcher",
  );
  assert.ok(
    (run.match(/requestPhaseExecution\(/gu)?.length ?? 0) >= 7,
    "phase actions, E2E actions, reruns and saved decisions must share one dispatcher",
  );
  assert.match(run, /\{!sessionRouteUnverified && !sessionAudit && executePhase \? \([\s\S]{0,100}<ExecuteDialog/u);
  assert.ok(
    (run.match(/disabled=\{sessionRoutePending/gu)?.length ?? 0) >= 4,
    "pending association validation must disable every PhasePanel execution/rerun family",
  );
  assert.match(run, /sessionRoutePending=\{sessionRouteUnverified\}/u);
  assert.match(run, /正在验证 Session 归属/u);

  assert.match(run, /\{reviewPhase \? \([\s\S]{0,100}<ReviewDialog/u);
  assert.match(run, /decisionGate=\{reviewDecisionGate\}/u);
  assert.match(run, /onNavigateDecisionPhase=\{openDecisionPhase\}/u);
  assert.match(run, /onDecisionSaved=\{\(phaseId\) => \{[\s\S]{0,180}requestPhaseExecution\(\{ phaseId \}\)/u);
  assert.match(review, /api\.captureHumanDecisions/u);
  assert.match(review, /architectureOptions\.map/u);
});

test("route spoof regression: only the strictly parsed Session-to-Run association enables chat-first audit", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const runId = "33333333-3333-4333-8333-333333333333";
  const detail = {
    id: sessionId,
    title: "真实 Session",
    status: "active",
    turnState: "idle",
    currentProviderId: "openai",
    lastMessageSequence: 1,
    lastEventSequence: 1,
    repositories: [],
    sandbox: null,
    runs: [{
      sessionId,
      triggerMessageId: "22222222-2222-4222-8222-222222222222",
      workflowRunId: runId,
      providerId: "openai",
      createdAt: "2026-08-29T08:01:00.000Z",
    }],
    createdAt: "2026-08-29T08:00:00.000Z",
    updatedAt: "2026-08-29T08:01:00.000Z",
  } satisfies AgentSession;

  assert.equal(verifiedAgentSessionRun(sessionId, runId, detail)?.workflowRunId, runId);
  assert.equal(
    verifiedAgentSessionRun("99999999-9999-4999-8999-999999999999", runId, detail),
    undefined,
  );
  assert.equal(
    verifiedAgentSessionRun(sessionId, "44444444-4444-4444-8444-444444444444", detail),
    undefined,
  );
  assert.equal(verifiedAgentSessionRun(sessionId, runId, { ...detail, runs: [] }), undefined);
});

test("advanced audit translates Provider tool starts into human-facing activity", () => {
  assert.equal(phaseRunEventMessage({
    id: "write-started",
    eventType: "provider.tool.started",
    payload: { toolName: "write_file" },
  }), "开始写入文件");
  assert.equal(phaseRunEventMessage({
    id: "write-finished",
    eventType: "provider.tool.finished",
    payload: { summary: "写入 docs/example.md（120 bytes）" },
  }), "写入 docs/example.md（120 bytes）");
  assert.equal(phaseRunEventMessage({
    id: "repair-rejected",
    eventType: "provider.finalization.rejected",
    payload: { repairRound: 2, maxRepairRounds: 2 },
  }), "产物质量校验未通过，正在自动修复（第 2/2 轮）");
  assert.equal(phaseRunEventMessage({
    id: "materialization-repair-rejected",
    eventType: "provider.finalization.rejected",
    payload: {
      repairRound: 2,
      maxRepairRounds: 2,
      reasonCode: "PRODUCT_DECISION_MATERIALIZATION_REQUIRED",
      affectedArtifactKeys: ["prd"],
    },
  }), "产物质量校验未通过，正在自动修复；PRD仍含未物化决定、开放问题或 Blocker（第 2/2 轮）");
  assert.equal(phaseRunEventMessage({
    id: "required-tool-retry",
    eventType: "provider.tool.retry-required",
    payload: { attempt: 1, maxAttempts: 1 },
  }), "模型未选择必需工具，平台正在强制重试（第 1/1 次）");
  assert.equal(phaseRunEventMessage({
    id: "required-read-retry",
    eventType: "provider.tool.retry-required",
    payload: { attempt: 1, maxAttempts: 1, requiredToolName: "read_file" },
  }), "模型未选择修复必需的“读取文件”，平台正在强制重试（第 1/1 次）");
});

test("Session audit copy points back to Provider-native continuation without changing standalone Codex Runs", async () => {
  const [run, review, guides] = await Promise.all([
    source("pages/run-page.tsx"),
    source("components/run/review-dialog.tsx"),
    source("components/run/phase-flow-guides.tsx"),
  ]);

  assert.match(run, /aria-label="Agent Session 高级审计"/u);
  assert.match(run, /产物审核、结构化决定与架构选型/u);
  assert.match(run, /沿用当前所选 Provider 与有界会话历史/u);
  assert.ok(
    (run.match(/返回 Session 继续/gu)?.length ?? 0) >= 5,
    "all PhasePanel execution and rerun CTAs must point back to the Session",
  );
  assert.match(run, /sessionAudit[\s\S]{0,100}"当前 Agent Session 正沿用所选 Provider 与有界会话历史推进/u);
  assert.match(
    run,
    /EngineeringFlowGuide[\s\S]{0,160}executorLabel=\{sessionAudit[\s\S]{0,100}"当前 Session Agent"[\s\S]{0,120}sessionRoutePending \? "归属验证后的执行器" : undefined/u,
  );
  assert.match(
    run,
    /<EventTimeline[\s\S]{0,140}phase=\{selectedPhase\}[\s\S]{0,100}sessionAudit=\{sessionAudit\}[\s\S]{0,100}sessionRoutePending=\{sessionRouteUnverified\}/u,
  );
  assert.match(run, /Provider-native 阶段事件会显示在这里/u);
  assert.match(run, /const sessionRouteState = authoritativeSessionId[\s\S]{0,260}"verified" : "conflict"[\s\S]{0,100}sessionId \? "mismatch" : "standalone"/u);
  assert.match(run, /这个 Agent Session 未关联当前 Run/u);
  assert.match(run, /返回操作不会进入无关 Session/u);
  assert.match(run, /系统不会降级为 Codex 独立执行/u);
  assert.match(run, /重试归属验证/u);
  assert.match(run, /const sessionHeaderNavigationLocked = sessionRouteUnverified \|\| sessionArchived/u);
  assert.match(run, /disabled=\{sessionHeaderNavigationLocked\}/u);
  assert.match(run, /sessionRouteUnverified[\s\S]{0,100}"所属 Session 暂不可返回"/u);
  assert.doesNotMatch(run, />\s*返回所属 Session\s*</u);
  assert.doesNotMatch(run, /作为独立 Run 打开/u);

  assert.match(run, /!sessionRouteUnverified && !sessionAudit && executePhase/u);
  assert.ok(
    (run.match(/phaseStatusLabel\(phase\.status, phase\.executions\[0\]\?\.command\)/gu)?.length ?? 0) >= 2,
    "the workflow board and selected phase badge must use execution-aware labels",
  );
  assert.ok(
    (review.match(/phaseStatusLabel\(phase\.status, phase\.executions\[0\]\?\.command\)/gu)?.length ?? 0) >= 2,
    "review status copy must use the same execution-aware label",
  );
  assert.doesNotMatch(run, /STATUS_LABELS\[phase\.status\]/u);
  assert.doesNotMatch(review, /STATUS_LABELS\[phase\.status\]/u);
  assert.match(run, /Codex 正在写代码/u);
  assert.match(run, /运行这个角色后，Codex 的命令与阶段事件会显示在这里/u);
  assert.match(guides, /executorLabel = "Codex"/u);
});

test("running phase labels use persisted executor evidence", () => {
  assert.equal(phaseStatusLabel("running", "provider-native:lmstudio"), "LM Studio 执行中");
  assert.equal(phaseStatusLabel("running", "provider-native:openai"), "OpenAI 执行中");
  assert.equal(phaseStatusLabel("running", "provider-native:future"), "Provider 执行中");
  assert.equal(phaseStatusLabel("running", "codex exec --model gpt-5"), "Codex 执行中");
  assert.equal(phaseStatusLabel("running"), "执行中");
  assert.equal(phaseStatusLabel("awaiting_review", "provider-native:lmstudio"), "等待人工审核");
});

test("completed Session Runs keep audit history without fake continuation or mutation actions", async () => {
  const [run, review, tickets] = await Promise.all([
    source("pages/run-page.tsx"),
    source("components/run/review-dialog.tsx"),
    source("pages/ticket-board.tsx"),
  ]);

  assert.match(run, /const sessionRunCompleted = Boolean\(authoritativeSessionId && run\.status === "completed"\)/u);
  assert.match(run, /const sessionArchived = Boolean\([\s\S]{0,140}sessionAssociation && agentSessionDetailQuery\.data\?\.status === "archived"/u);
  assert.doesNotMatch(run, /sessionRunCompleted = sessionAudit/u);
  assert.match(run, /sessionRunCompleted=\{sessionRunCompleted\}/u);
  assert.match(run, /readOnly=\{sessionRunCompleted\}/u);
  assert.match(run, /<HumanDecisionOverview[\s\S]{0,180}readOnly=\{sessionRunCompleted\}/u);
  assert.match(run, /readOnly \? "未关闭的决定与待办历史" : "决定与待办"/u);
  assert.match(run, /sessionRunCompleted[\s\S]{0,160}"查看未关闭历史"/u);
  assert.match(run, /这些条目只保留用于审计，不能再处理、重新运行角色或改写完成态历史/u);
  assert.match(run, /!sessionRunCompleted && !isSuperseded && canReviseArtifacts/u);
  assert.match(run, /此 Session Run 已完成，不再提供执行或重跑入口/u);
  assert.ok(
    (run.match(/"所属 Session 已归档"/gu)?.length ?? 0) >= 2,
    "an archived Session must replace both navigation CTAs with a truthful locked state",
  );
  assert.ok(
    (run.match(/disabled=\{sessionArchived\}/gu)?.length ?? 0) >= 1
      && (run.match(/disabled=\{sessionHeaderNavigationLocked\}/gu)?.length ?? 0) >= 1,
    "an archived Session must not navigate from either verified audit card or Run header",
  );
  assert.match(run, /if \(sessionRouteUnverified \|\| sessionRunCompleted \|\| sessionArchived\) return/u);
  assert.match(review, /!readOnly[\s\S]{0,80}typeof content === "string"/u);
  assert.match(review, /此 Session Run 已完成；这里仅保留产物与审核历史/u);
  assert.match(
    review,
    /\{!readOnly && isReviewable \? \([\s\S]{0,500}当前版本已查看/u,
    "completed Session audit must hide review progress",
  );
  assert.match(
    review,
    /\{readOnly \? \([\s\S]{0,700}完成态只读审计[\s\S]{0,400}\) : isReviewable \? \(/u,
    "completed Session audit must replace review mutations with the read-only footer",
  );
  assert.match(review, /完成态只读审计/u);
  assert.match(review, /不能再提交审核、选择方案、要求修改或重新打开流程/u);
  assert.match(review, /完成态记录中没有已保存回答；该条目仅作为历史审计展示/u);
  assert.match(run, /<TicketBoard[\s\S]{0,120}readOnly=\{sessionRunCompleted\}/u);
  assert.match(tickets, /if \(readOnly\) return;/u);
  assert.match(tickets, /if \(readOnly\) \{[\s\S]{0,160}Ticket 状态仅供审计查看/u);
  assert.ok(
    (tickets.match(/disabled=\{readOnly \|\| mutationPending\}/gu)?.length ?? 0) >= 2,
    "completed Session audit must disable Ticket status changes in both board and detail views",
  );
  assert.match(tickets, /完成态只读/u);
});
