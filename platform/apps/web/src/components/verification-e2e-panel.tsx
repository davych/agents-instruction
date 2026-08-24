import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSearch,
  FolderGit2,
  MonitorPlay,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Stethoscope,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  E2eWorkspace,
  E2eReadinessItem,
  PhaseStatus,
  VerificationE2eFlow,
  VerificationE2eFlowState,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  verificationE2ePrimaryAction,
  type VerificationE2eActionKind,
} from "@/lib/verification-e2e-workflow";

export { verificationE2ePrimaryAction } from "@/lib/verification-e2e-workflow";

export interface VerificationE2ePanelProps {
  projectId: string;
  runId: string;
  phaseStatus: PhaseStatus;
  workspace: E2eWorkspace | null;
  flow: VerificationE2eFlow | null;
  busy?: boolean;
  error?: string;
  flowLoadError?: string;
  flowStateUncertain?: boolean;
  onConfigureWorkspace?: () => void;
  onPrepareWorkspace?: () => void;
  onPreflight?: () => void;
  onAuthor?: () => void;
  onReviewScript?: () => void;
  onExecute?: () => void;
  onOpenVerificationReview?: () => void;
  onRetryFlow?: () => void;
}

const stageItems = [
  { number: 1, title: "配置测试项目", icon: FolderGit2 },
  { number: 2, title: "环境预检", icon: Stethoscope },
  { number: 3, title: "生成脚本", icon: Sparkles },
  { number: 4, title: "人工审脚本", icon: FileSearch },
  { number: 5, title: "真实 Chromium", icon: MonitorPlay },
] as const;

const stateStage: Record<VerificationE2eFlowState, number> = {
  unconfigured: 0,
  preflight_blocked: 1,
  needs_authoring: 2,
  authoring: 2,
  awaiting_script_review: 3,
  ready_to_execute: 4,
  executing: 4,
  awaiting_verification_review: 5,
  failed: 4,
};

export function VerificationE2ePanel({
  projectId,
  runId,
  phaseStatus,
  workspace,
  flow,
  busy = false,
  error,
  flowLoadError,
  flowStateUncertain = false,
  onConfigureWorkspace,
  onPrepareWorkspace,
  onPreflight,
  onAuthor,
  onReviewScript,
  onExecute,
  onOpenVerificationReview,
  onRetryFlow,
}: VerificationE2ePanelProps) {
  const state = flow?.state ?? (workspace ? "preflight_blocked" : "unconfigured");
  const action = verificationE2ePrimaryAction(state);
  const currentStage = stateStage[state];
  const phaseLocked = phaseStatus === "pending" || phaseStatus === "locked" || phaseStatus === "approved";
  const authoringUnavailable = state === "needs_authoring" && flow?.contractSource === "unavailable";
  const linkedFlowStarted = Boolean(flow?.authoring || flow?.execution);
  const completeBaselineUnavailable = Boolean(flowLoadError)
    && (action.kind === "review_script" || action.kind === "execute");
  const environmentSetupUseful = Boolean(flow?.readiness && [
    flow.readiness.playwright.state,
    flow.readiness.browser.state,
  ].some((itemState) => itemState === "missing" || itemState === "not_checked"));
  const actionHandler = handlerForAction(action.kind, {
    onConfigureWorkspace,
    onPreflight,
    onAuthor,
    onReviewScript,
    onExecute,
    onOpenVerificationReview,
  });
  return (
    <Card
      className="overflow-hidden border-sky-200"
      data-project-id={projectId}
      data-run-id={runId}
      aria-label="独立 E2E 项目流程"
    >
      <CardHeader className="border-b border-sky-100 bg-sky-50/60">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-sky-700" aria-hidden />
              独立 E2E 项目 · 真实 Chromium
            </CardTitle>
            <p className="mt-1.5 max-w-3xl text-xs leading-5 text-slate-600">
              平台在独立项目中维护可复用 Playwright 脚本。MCP 只用于探索，Vitest/jsdom
              通过也不能替代真实浏览器证据；你无需手写特殊评论或 Markdown。
            </p>
          </div>
          <Badge variant={statusBadgeVariant(state)}>{statusLabel(state)}</Badge>
        </div>
      </CardHeader>

      <CardContent className="p-5">
        <ol className="grid gap-2 sm:grid-cols-5" aria-label="E2E 流程进度">
          {stageItems.map((stage, index) => {
            const complete = currentStage > index;
            const active = currentStage === index;
            const Icon = stage.icon;
            return (
              <li
                key={stage.number}
                className={cn(
                  "rounded-xl border px-3 py-2.5",
                  complete
                    ? "border-emerald-200 bg-emerald-50"
                    : active
                      ? "border-sky-300 bg-sky-50"
                      : "border-slate-200 bg-slate-50/60",
                )}
              >
                <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-800">
                  {complete ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                  ) : (
                    <Icon className={cn("h-3.5 w-3.5", active ? "text-sky-700" : "text-slate-400")} aria-hidden />
                  )}
                  {stage.number}. {stage.title}
                </div>
              </li>
            );
          })}
        </ol>

        {workspace ? (
          <div className="mt-4 grid gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-xs sm:grid-cols-2">
            <Fact label="测试项目" value={workspace.rootPath} mono />
            <Fact label="真实浏览器" value="Chromium" />
            <Fact label="应用地址" value={workspace.baseUrl} mono />
            <Fact
              label="固定脚本"
              value={`${workspace.packageManager} · ${workspace.sourceStartScript} / ${workspace.testScript}`}
              mono
            />
            <Fact label="描述文件" value={workspace.descriptorPath} mono />
            <Fact label="描述文件 SHA-256" value={workspace.descriptorHash} mono />
          </div>
        ) : null}

        {flow?.readiness ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5" aria-label="E2E 环境预检结果">
            <ReadinessItem label="独立目录" item={flow.readiness.workspace} />
            <ReadinessItem label="Playwright" item={flow.readiness.playwright} />
            <ReadinessItem label="Chromium 启动" item={flow.readiness.browser} />
            <ReadinessItem label="应用启动脚本" item={flow.readiness.sourceStartScript} />
            <ReadinessItem label="本机目标" item={flow.readiness.target} />
          </div>
        ) : null}

        {flow?.contractSource === "legacy_approved_artifacts" ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900">
            这是旧 Run。平台只会从已批准产物提取测试意图，并在完整可执行脚本基线审核中展示给你确认；
            不会让 Agent 根据任务标题补造验收范围。
          </div>
        ) : null}

        {flow?.authoring?.files.length ? (
          <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-xs text-violet-900">
            <div className="font-semibold">
              {flow.authoring.status === "awaiting_review"
                ? "待审核完整可执行脚本基线"
                : flow.authoring.status === "approved"
                  ? "已批准完整可执行脚本基线"
                  : "完整可执行脚本基线需修改"}
              {" · 整套 "}{flow.authoring.files.length} 个文件
            </div>
            <p className="mt-1 leading-5">
              {flow.authoring.status === "awaiting_review"
                ? "这里是 Playwright 实际会执行的整套 tests/** 与 fixtures/**，不是仅列出本次变更。必须逐一看过全部文件内容和每个 hash，才能允许运行。"
                : "每次生成都会形成新的整套基线 hash；任何内容或 revision 变化后都必须重新审核全部文件。"}
              脚本审核只批准这份完整基线，不批准 Verification、合并或发布。
            </p>
          </div>
        ) : null}

        {flow?.recommendedAction ? (
          <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-xs leading-5 text-sky-900">
            <strong>平台建议：</strong>{flow.recommendedAction}
          </div>
        ) : null}

        {linkedFlowStarted ? (
          <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-950">
            本 Run 已启动 linked E2E：当前 Verification 必须使用成功的 linked E2E 证据完成，
            不能再由普通 Tester 报告覆盖；本版没有取消按钮。
          </div>
        ) : state === "needs_authoring" ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900">
            点击“生成或更新 E2E 脚本”即会为本 Run 启动 linked E2E 流程；启动后必须以成功的 linked E2E
            证据完成当前 Verification，不能切回普通 Tester 报告，本版也没有取消按钮。
          </div>
        ) : null}

        {flow?.blockers.length ? (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900" role="alert">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              真实浏览器流程还不能继续
            </div>
            <ul className="mt-2 space-y-1.5">
              {flow.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {state === "failed" && flow?.execution?.error ? (
          <div className="mt-4 rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-950" role="alert">
            <div className="font-semibold">真实 E2E 执行失败</div>
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
              {flow.execution.error}
            </p>
            {flow.execution.exitCode !== null && flow.execution.exitCode !== undefined ? (
              <p className="mt-1 text-rose-800">退出码：{flow.execution.exitCode}</p>
            ) : null}
          </div>
        ) : null}

        {flowStateUncertain ? (
          <div className="mt-4 flex flex-col gap-3 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2.5 text-xs leading-5 text-rose-900 sm:flex-row sm:items-center sm:justify-between" role="alert">
            <div>
              <strong>无法确认 linked 状态，请重试加载。</strong>
              <span className="block">当前页面不能证明此 Run 尚未启动 linked E2E，因此普通 Tester 与 E2E 审核、执行均暂时停用。</span>
              {flowLoadError ? <span className="mt-1 block font-mono text-[10px]">{flowLoadError}</span> : null}
            </div>
            {onRetryFlow ? (
              <Button variant="outline" loading={busy} onClick={onRetryFlow}>
                重试加载 linked 状态
              </Button>
            ) : null}
          </div>
        ) : flowLoadError ? (
          <div className="mt-4 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-900" role="alert">
            完整可执行脚本基线加载失败；当前页面不保证已展示整套文件，审核和真实浏览器执行已停用。{flowLoadError}
          </div>
        ) : error ? (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800" role="alert">
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <p className="max-w-xl text-[11px] leading-5 text-slate-500">
            平台预检浏览器、启动脚本和测试脚本后才会生成；生成代码必须经人审，运行结果还要经过最终 Verification 人工门禁。
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            {state === "failed" && onAuthor ? (
              <Button variant="outline" disabled={phaseLocked || flowStateUncertain} onClick={onAuthor}>
                重新生成或更新脚本
              </Button>
            ) : null}
            {workspace && state === "preflight_blocked" && environmentSetupUseful && onPrepareWorkspace ? (
              <Button
                variant="outline"
                loading={busy}
                disabled={phaseLocked || flowStateUncertain}
                onClick={onPrepareWorkspace}
              >
                显式准备 Playwright / Chromium
              </Button>
            ) : null}
            <Button
              variant={action.kind === "review_script" ? "outline" : "primary"}
              loading={busy || action.loading}
              disabled={
                phaseLocked
                || flowStateUncertain
                || authoringUnavailable
                || completeBaselineUnavailable
                || !actionHandler
              }
              onClick={actionHandler}
            >
              {action.kind === "preflight" && state === "preflight_blocked" ? (
                <RotateCcw className="h-4 w-4" aria-hidden />
              ) : null}
              {action.label}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function handlerForAction(
  kind: VerificationE2eActionKind,
  handlers: {
    onConfigureWorkspace?: () => void;
    onPreflight?: () => void;
    onAuthor?: () => void;
    onReviewScript?: () => void;
    onExecute?: () => void;
    onOpenVerificationReview?: () => void;
  },
): (() => void) | undefined {
  switch (kind) {
    case "configure":
      return handlers.onConfigureWorkspace;
    case "preflight": return handlers.onPreflight;
    case "author": return handlers.onAuthor;
    case "review_script": return handlers.onReviewScript;
    case "execute": return handlers.onExecute;
    case "review_verification": return handlers.onOpenVerificationReview;
    case "wait": return undefined;
  }
}

function statusLabel(state: VerificationE2eFlowState): string {
  const labels: Record<VerificationE2eFlowState, string> = {
    unconfigured: "待配置",
    preflight_blocked: "环境阻塞",
    needs_authoring: "待生成脚本",
    authoring: "生成中",
    awaiting_script_review: "待审完整基线",
    ready_to_execute: "可运行",
    executing: "浏览器运行中",
    awaiting_verification_review: "待审证据",
    failed: "运行失败",
  };
  return labels[state];
}

function statusBadgeVariant(
  state: VerificationE2eFlowState,
): "muted" | "info" | "warning" | "danger" | "success" {
  if (state === "awaiting_verification_review") return "success";
  if (state === "preflight_blocked" || state === "failed") return "danger";
  if (state === "awaiting_script_review") return "warning";
  if (state === "unconfigured") return "muted";
  return "info";
}

function Fact({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={cn("mt-1 truncate text-slate-700", mono && "font-mono text-[11px]")} title={typeof value === "string" ? value : undefined}>
        {value}
      </div>
    </div>
  );
}

function ReadinessItem({ label, item }: { label: string; item: E2eReadinessItem }) {
  const ready = item.state === "ready";
  const pending = item.state === "not_checked";
  return (
    <div className={cn(
      "rounded-lg border px-3 py-2.5 text-xs",
      ready
        ? "border-emerald-200 bg-emerald-50"
        : pending
          ? "border-slate-200 bg-slate-50"
          : "border-rose-200 bg-rose-50",
    )}>
      <div className={cn(
        "font-semibold",
        ready ? "text-emerald-800" : pending ? "text-slate-700" : "text-rose-800",
      )}>
        {label} · {ready ? "Ready" : pending ? "待执行" : item.state}
      </div>
      <p className={cn(
        "mt-1 leading-4",
        ready ? "text-emerald-700" : pending ? "text-slate-600" : "text-rose-700",
      )}>{item.message}</p>
      {item.detail ? <p className="mt-1 break-words font-mono text-[10px] text-slate-500">{item.detail}</p> : null}
    </div>
  );
}
