import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock3,
  Code2,
  Download,
  Eye,
  ExternalLink,
  FileCheck2,
  FileText,
  FlaskConical,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  Network,
  Palette,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";

import { ExecuteDialog } from "@/components/run/execute-dialog";
import { E2eScriptReviewDialog } from "@/components/run/e2e-script-review-dialog";
import { E2eWorkspaceDialog } from "@/components/run/e2e-workspace-dialog";
import {
  EngineeringFlowGuide,
  ReleaseFlowGuide,
  TesterFlowGuide,
} from "@/components/run/phase-flow-guides";
import { keyForArtifact, reasoningEffortLabel } from "@/components/run/run-page-helpers";
import { ReviewDialog } from "@/components/run/review-dialog";
import { EmptyState, ErrorState, PageSkeleton } from "@/components/states";
import { VerificationE2ePanel } from "@/components/verification-e2e-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { verifiedAgentSessionRun } from "@/lib/agent-session-run-context";
import { api } from "@/lib/api";
import { phaseRunEventMessage } from "@/lib/session-run-failure";
import {
  HUMAN_DECISION_PHASE_LABELS,
  HUMAN_DECISION_ROLE_LABELS,
  deferredHumanDecisionItems,
  humanDecisionGateHeadline,
  humanDecisionNextAction,
  isDeferredDesignHandoffCleanupGate,
  nonBlockingHumanDecisionItems,
} from "@/lib/human-decisions";
import { RELEASE_COMPLETION_BOUNDARY } from "@/lib/release-workflow";
import { verificationE2eStandardGate } from "@/lib/verification-e2e-workflow";
import { isArchitectureImpactOutputMutable } from "@/lib/phase-output-selection";
import {
  effectiveRequiredInputKeys,
  isFirstPhaseImpactAttempt,
  isResolutionOutputMutable,
  phaseImpactActionLabel,
  resolutionIsReadOnly,
  resolutionModeLabel,
  type RoutedImpactPhaseId,
} from "@/lib/phase-impact";
import type {
  ChangeContract,
  HumanDecisionPhaseId,
  HumanDecisionSummary,
  PhaseHumanDecisionGate,
  PhaseDefinition,
  PhaseRun,
  PhaseStatus,
  RoleDefinition,
  RunResultReceipt,
  VerificationE2eAction,
  WorkflowRun,
} from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";
import {
  FALLBACK_PHASES,
  FALLBACK_ROLES,
  artifactLabel,
  getPhaseName,
  phaseStatusLabel,
} from "@/lib/workflow";

const roleIcons: Record<string, typeof Bot> = {
  "pm-ba": ClipboardList,
  designer: Palette,
  architect: Network,
  "software-engineer": Code2,
  tester: FlaskConical,
  devops: Rocket,
};

const TicketBoard = lazy(() =>
  import("@/pages/ticket-board").then((module) => ({ default: module.TicketBoard })),
);
const statusStyle: Record<
  PhaseStatus,
  { badge: "muted" | "info" | "warning" | "success" | "danger"; card: string; dot: string }
> = {
  pending: { badge: "muted", card: "border-slate-200 bg-slate-50/70", dot: "bg-slate-300" },
  locked: { badge: "muted", card: "border-slate-200 bg-slate-50/70", dot: "bg-slate-300" },
  ready: { badge: "info", card: "border-teal-300 bg-white shadow-sm", dot: "bg-teal-500" },
  running: { badge: "info", card: "border-sky-300 bg-sky-50/40", dot: "bg-sky-500" },
  awaiting_review: {
    badge: "warning",
    card: "border-amber-300 bg-amber-50/40",
    dot: "bg-amber-500",
  },
  approved: {
    badge: "success",
    card: "border-emerald-200 bg-emerald-50/35",
    dot: "bg-emerald-500",
  },
  changes_requested: {
    badge: "danger",
    card: "border-rose-300 bg-rose-50/40",
    dot: "bg-rose-500",
  },
  rejected: {
    badge: "danger",
    card: "border-rose-300 bg-rose-50/40",
    dot: "bg-rose-500",
  },
  failed: { badge: "danger", card: "border-rose-300 bg-rose-50/40", dot: "bg-rose-500" },
};

interface ExecuteTarget {
  phaseId: string;
  initialOutputKeys?: string[];
  verificationAction?: VerificationE2eAction;
}

interface ReviewTarget {
  phaseId: string;
  initialArtifactId?: string;
}

export function RunPage({
  runId,
  sessionId,
  onBack,
  onReturnToSession,
  view,
  ticketId,
  onViewChange,
  onOpenTicket,
  onCloseTicket,
}: {
  runId: string;
  sessionId?: string;
  onBack: (projectId?: string) => void;
  onReturnToSession: (projectId?: string, sessionId?: string) => void;
  view: "workflow" | "tickets";
  ticketId?: string;
  onViewChange: (view: "workflow" | "tickets") => void;
  onOpenTicket: (ticketId: string) => void;
  onCloseTicket: () => void;
}) {
  const [selectedPhaseId, setSelectedPhaseId] = useState<string>();
  const [executeTarget, setExecuteTarget] = useState<ExecuteTarget>();
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget>();
  const [e2eWorkspaceOpen, setE2eWorkspaceOpen] = useState(false);
  const [e2eScriptReviewOpen, setE2eScriptReviewOpen] = useState(false);
  const queryClient = useQueryClient();
  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.getRun(runId),
    refetchInterval: (query) =>
      query.state.data?.phases?.some((phase) => phase.status === "running") ? 1_500 : false,
  });
  const authoritativeSessionId = runQuery.data?.agentSession?.sessionId;
  const agentSessionDetailQuery = useQuery({
    queryKey: ["agent-session", authoritativeSessionId],
    queryFn: ({ signal }) => api.getAgentSession(authoritativeSessionId!, { signal }),
    enabled: Boolean(authoritativeSessionId),
    retry: false,
  });
  const changesetQuery = useQuery({
    queryKey: ["run", runId, "changeset"],
    queryFn: ({ signal }) => api.getRunChangeset(runId, { signal }),
    enabled: runQuery.data?.project.sourceKind === "remote-git"
      && !runQuery.data.phases.some((phase) => phase.status === "running"),
    retry: false,
  });
  const resultQuery = useQuery({
    queryKey: [
      "run",
      runId,
      "result",
      runQuery.data?.run.updatedAt,
      changesetQuery.data?.generatedAt,
    ],
    queryFn: () => api.getRunResult(runId),
    enabled: Boolean(runQuery.data),
    retry: false,
    refetchInterval: runQuery.data?.phases?.some((phase) => phase.status === "running")
      ? 1_500
      : false,
  });
  const patchDownloadMutation = useMutation({
    mutationFn: () => api.downloadRunPatch(runId),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${runId}.patch`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  });
  const humanDecisionsQuery = useQuery({
    queryKey: ["run", runId, "human-decisions"],
    queryFn: () => api.getHumanDecisions(runId),
    enabled: Boolean(runQuery.data),
    refetchInterval: runQuery.data?.phases?.some((phase) => phase.status === "running")
      ? 1_500
      : false,
  });
  const sourceRunsQuery = useQuery({
    queryKey: ["runs", runQuery.data?.run.projectId],
    queryFn: () => api.listRuns(runQuery.data!.run.projectId),
    enabled: Boolean(runQuery.data?.run.changeContract?.sourceRunIds?.length),
  });
  const e2eFlowQueryKey = ["run", runId, "verification", "e2e-flow"] as const;
  const e2eFlowQuery = useQuery({
    queryKey: e2eFlowQueryKey,
    queryFn: () => api.getVerificationE2eFlow(runId),
    enabled: runQuery.data?.project.sourceKind === "legacy-local",
    retry: 1,
    refetchInterval: (query) => (
      query.state.data?.state === "authoring" || query.state.data?.state === "executing"
        ? 1_500
        : false
    ),
  });
  const e2eWorkspaceQueryKey = [
    "project",
    runQuery.data?.run.projectId,
    "e2e-workspace",
  ] as const;
  const e2eWorkspaceQuery = useQuery({
    queryKey: e2eWorkspaceQueryKey,
    queryFn: () => api.getE2eWorkspace(runQuery.data!.run.projectId),
    enabled: runQuery.data?.project.sourceKind === "legacy-local",
    retry: 1,
  });
  const e2eFlowLoadError = e2eFlowErrorMessage(e2eFlowQuery.error);
  const preflightE2eMutation = useMutation({
    mutationFn: () => api.preflightVerificationE2e(runId),
    onSuccess: (flow) => {
      queryClient.setQueryData(e2eFlowQueryKey, flow);
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: e2eFlowQueryKey });
    },
  });
  const prepareE2eMutation = useMutation({
    mutationFn: () => {
      const projectId = runQuery.data?.project.id;
      if (!projectId) throw new Error("当前项目尚未加载，无法准备 E2E 环境");
      return api.prepareE2eWorkspace(projectId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: e2eFlowQueryKey });
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: e2eFlowQueryKey });
    },
  });
  const linkedWorkspace = e2eFlowQuery.data?.workspace ?? e2eWorkspaceQuery.data ?? null;
  const linkedGate = runQuery.data?.project.sourceKind === "remote-git"
    ? {
      explicitlyUnconfigured: true,
      stateUncertain: false,
      standardTesterLocked: false,
    }
    : verificationE2eStandardGate({
      flowLoaded: e2eFlowQuery.isSuccess,
      flowState: e2eFlowQuery.data?.state,
      flowHasWorkspace: Boolean(e2eFlowQuery.data?.workspace),
      workspaceLoaded: e2eWorkspaceQuery.isSuccess,
      workspaceConfigured: Boolean(e2eWorkspaceQuery.data),
    });
  const linkedStateUncertain = linkedGate.stateUncertain;
  const standardVerificationLocked = linkedGate.standardTesterLocked;

  useEffect(() => {
    if (selectedPhaseId || !runQuery.data?.phases?.length) return;
    const active = runQuery.data.phases.find((phase) =>
      ["ready", "running", "awaiting_review", "changes_requested", "failed"].includes(phase.status),
    );
    setSelectedPhaseId(active?.phaseId ?? runQuery.data.phases[0]?.phaseId);
  }, [runQuery.data, selectedPhaseId]);

  if (runQuery.isLoading) return <PageSkeleton />;
  if (runQuery.isError) {
    return <ErrorState error={runQuery.error} retry={() => void runQuery.refetch()} />;
  }
  if (!runQuery.data) return <PageSkeleton />;

  const {
    run,
    project,
    definition,
    productBaseline,
    designBaseline,
    architectureBaseline,
  } = runQuery.data;
  const sessionAssociation = authoritativeSessionId && agentSessionDetailQuery.isSuccess
    ? verifiedAgentSessionRun(authoritativeSessionId, runId, agentSessionDetailQuery.data)
    : undefined;
  const sessionAudit = Boolean(sessionAssociation);
  const sessionArchived = Boolean(
    sessionAssociation && agentSessionDetailQuery.data?.status === "archived",
  );
  const sessionRouteUnverified = Boolean(authoritativeSessionId && !sessionAudit);
  const sessionRouteState = authoritativeSessionId
    ? agentSessionDetailQuery.isPending
      ? "loading"
      : agentSessionDetailQuery.isError
        ? "error"
        : sessionAudit ? "verified" : "conflict"
    : sessionId ? "mismatch" : "standalone";
  const sessionHeaderNavigationLocked = sessionRouteUnverified || sessionArchived;
  // Run detail is the authority for ownership. Keep completed Session Runs
  // read-only even when the secondary Session detail request is unavailable or
  // temporarily inconsistent; never let that read failure reopen mutations.
  const sessionRunCompleted = Boolean(authoritativeSessionId && run.status === "completed");
  const requestPhaseExecution = (target: ExecuteTarget) => {
    if (sessionRouteUnverified || sessionRunCompleted || sessionArchived) return;
    if (sessionAudit) {
      setExecuteTarget(undefined);
      setReviewTarget(undefined);
      onReturnToSession(run.projectId, sessionAssociation?.sessionId);
      return;
    }
    setExecuteTarget(target);
  };
  const phases = normalizePhases(runQuery.data.phases, definition?.phases);
  const phaseDefinitions = definition?.phases?.length ? definition.phases : FALLBACK_PHASES;
  const outputKeysByPhase = Object.fromEntries(
    phaseDefinitions.map((phase) => [phase.id, phase.outputs]),
  );
  const roles = definition?.roles?.length ? definition.roles : FALLBACK_ROLES;
  const selectedPhase =
    phases.find((phase) => phase.phaseId === selectedPhaseId) ?? phases[0];
  const selectedDefinition =
    phaseDefinitions.find((phase) => phase.id === selectedPhase?.phaseId) ?? FALLBACK_PHASES[0];
  const selectedRole =
    roles.find((role) => role.id === selectedDefinition?.owner) ?? FALLBACK_ROLES[0];
  const executePhase = executeTarget
    ? phases.find((phase) => phase.phaseId === executeTarget.phaseId)
    : undefined;
  const reviewPhase = reviewTarget
    ? phases.find((phase) => phase.phaseId === reviewTarget.phaseId)
    : undefined;
  const humanDecisions = humanDecisionsQuery.data;
  const inconsistentApprovedPhases = new Set(humanDecisions?.inconsistentPhaseIds ?? []);
  const approvedCount = phases.filter(
    (phase) => phase.status === "approved" && !inconsistentApprovedPhases.has(phase.phaseId as HumanDecisionPhaseId),
  ).length;
  const flexibleTargetPhase = run.executionModel === "flexible"
    ? phases.find((phase) => phase.phaseId === run.targetPhaseId)
    : undefined;
  const progressCompleted = flexibleTargetPhase
    ? flexibleTargetPhase.status === "approved" || run.status === "completed" ? 1 : 0
    : approvedCount;
  const progressTotal = flexibleTargetPhase ? 1 : Math.max(phases.length, 1);
  const progress = Math.round((progressCompleted / progressTotal) * 100);
  const targetPhaseDefinition = phaseDefinitions.find((phase) => phase.id === run.targetPhaseId);
  const selectedDecisionGate = humanDecisions?.phases.find(
    ({ phaseId }) => phaseId === selectedPhase?.phaseId,
  );
  const reviewDecisionGate = humanDecisions?.phases.find(
    ({ phaseId }) => phaseId === reviewPhase?.phaseId,
  );
  const openDecisionPhase = (phaseId: HumanDecisionPhaseId) => {
    setSelectedPhaseId(phaseId);
    const targetPhase = phases.find((phase) => phase.phaseId === phaseId);
    const targetGate = humanDecisions?.phases.find((gate) => gate.phaseId === phaseId);
    const nextAction = targetPhase && targetGate
      ? humanDecisionNextAction(targetPhase.status, targetGate)
      : "select";
    if (nextAction === "execute") {
      setReviewTarget(undefined);
      requestPhaseExecution({ phaseId });
    } else if (nextAction === "review") {
      setReviewTarget({ phaseId });
    } else {
      setReviewTarget(undefined);
      setExecuteTarget(undefined);
    }
  };

  return (
    <div className="space-y-6 animate-fade-up">
      <section>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-3"
          disabled={sessionHeaderNavigationLocked}
          onClick={sessionHeaderNavigationLocked
            ? undefined
            : authoritativeSessionId
            ? () => onReturnToSession(run.projectId, authoritativeSessionId)
            : () => onBack(run.projectId)}
        >
          {sessionRouteState === "loading"
            ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            : sessionHeaderNavigationLocked
            ? <LockKeyhole className="h-4 w-4" aria-hidden />
            : <ArrowLeft className="h-4 w-4" aria-hidden />}
          {sessionArchived
            ? "所属 Session 已归档"
            : sessionRouteState === "loading"
              ? "正在验证所属 Session"
              : sessionRouteUnverified
                ? "所属 Session 暂不可返回"
            : `返回 ${authoritativeSessionId ? "Agent Session" : project.name}`}
        </Button>
        <div className="flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant={run.status === "completed" ? "success" : "info"}>
                <GitBranch className="h-3 w-3" aria-hidden />
                {run.status === "completed" ? "工作流审核完成" : "交付任务"}
              </Badge>
              {run.baseRevision ? (
                <Badge variant="outline">
                  <GitCommitHorizontal className="h-3 w-3" aria-hidden />
                  base {run.baseRevision.slice(0, 12)}
                </Badge>
              ) : null}
              {run.executionModel === "flexible" && targetPhaseDefinition ? (
                <Badge variant="info">
                  <ArrowRight className="h-3 w-3" aria-hidden />
                  目标 · {getPhaseName(targetPhaseDefinition)}
                </Badge>
              ) : null}
              {project.sourceKind === "remote-git" && run.workspaceState ? (
                <Badge variant={run.workspaceState === "failed" ? "danger" : run.workspaceState === "busy" ? "info" : "muted"}>
                  云端工作区 · {workspaceStateLabel(run.workspaceState)}
                </Badge>
              ) : null}
              <span className="text-xs text-slate-400">创建于 {formatDate(run.createdAt)}</span>
            </div>
            <h1 tabIndex={-1} className="text-balance text-2xl font-bold tracking-[-0.025em] text-slate-950 focus:outline-none sm:text-3xl">
              {run.title}
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              {run.objective || run.brief || "尚未填写故事目标。"}
            </p>
          </div>
          <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white/80 p-4 shadow-sm backdrop-blur xl:w-80">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-700">整体进度</span>
              <span className="font-bold text-teal-700">{progressCompleted} / {progressTotal}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-teal-500 to-emerald-500 transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="mt-2 text-[11px] text-slate-400">
              {flexibleTargetPhase
                ? "目标阶段审核通过后，本 Run 即完成"
                : "所有阶段均需人工审核且没有未关闭事项后才算完成"}
              {inconsistentApprovedPhases.size > 0
                ? ` · ${inconsistentApprovedPhases.size} 个旧批准需要修复`
                : ""}
            </div>
          </div>
        </div>
      </section>

      {sessionAudit ? (
        <Card className="border-teal-200 bg-teal-50/55 shadow-none" aria-label="Agent Session 高级审计">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-teal-950">
                <Badge variant="info">高级审计</Badge>
                此 Run 隶属于当前 Agent Session
              </div>
              <p className="mt-1 text-xs leading-5 text-teal-900">
                {sessionRunCompleted
                  ? "在这里查看完整状态、产物与历史审核记录。此 Session Run 已完成，不再提供执行或重跑入口。"
                  : "在这里查看完整状态、产物审核、结构化决定与架构选型；执行、重跑和保存决定后的继续动作会返回原 Session，沿用当前所选 Provider 与有界会话历史。"}
              </p>
            </div>
            <Button
              variant="outline"
              className="shrink-0 bg-white"
              disabled={sessionArchived}
              onClick={sessionArchived
                ? undefined
                : () => onReturnToSession(run.projectId, sessionAssociation?.sessionId)}
            >
              {sessionArchived
                ? <LockKeyhole className="h-4 w-4" aria-hidden />
                : <ArrowLeft className="h-4 w-4" aria-hidden />}
              {sessionArchived
                ? "所属 Session 已归档"
                : sessionRunCompleted ? "返回 Session" : "返回 Session 继续"}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {sessionRouteState !== "standalone" && sessionRouteState !== "verified" ? (
        <Card
          className={sessionRouteState === "loading"
            ? "border-slate-200 bg-slate-50 shadow-none"
            : "border-amber-200 bg-amber-50/70 shadow-none"}
          aria-label="Agent Session 归属验证"
        >
          <CardContent
            className="flex flex-col gap-3 p-4 text-sm sm:flex-row sm:items-start"
            role={sessionRouteState === "loading" ? "status" : "alert"}
          >
            {sessionRouteState === "loading"
              ? <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-slate-500" aria-hidden />
              : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />}
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-slate-900">
                {sessionRouteState === "loading"
                  ? "正在验证 Agent Session 归属"
                  : sessionRouteState === "error"
                    ? "无法验证 Agent Session 归属"
                    : sessionRouteState === "conflict"
                      ? "Run 归属记录暂时不一致"
                      : "这个 Agent Session 未关联当前 Run"}
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-700">
                {sessionRouteState === "loading"
                  ? "确认持久化 Run 关联前，执行与重跑保持锁定，不会切换到 Codex 或绑定 URL 中的 Session。"
                  : sessionRouteState === "error"
                    ? "服务端已确认此 Run 属于一个 Agent Session，但 Session 详情暂时读取失败。执行与重跑保持锁定。"
                    : sessionRouteState === "conflict"
                      ? "Run 详情与 Session 关联清单不一致。执行与重跑保持锁定，请重试；系统不会降级为 Codex 独立执行。"
                      : "服务端已确认当前 Run 不属于 URL 中的 Session。页面按独立 Run 展示，返回操作不会进入无关 Session。"}
              </p>
            </div>
            {sessionRouteState === "error" || sessionRouteState === "conflict" ? (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 bg-white"
                onClick={() => void agentSessionDetailQuery.refetch()}
              >
                重试归属验证
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {project.sourceKind === "remote-git" ? (
        <Card className="border-sky-100 bg-sky-50/45 shadow-none">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <GitBranch className="h-4 w-4 text-sky-700" aria-hidden />
                云端代码变更
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                {changesetQuery.data
                  ? `${changesetQuery.data.files.length} 个文件 · ${changesetQuery.data.patchBytes.toLocaleString()} bytes · ${changesetQuery.data.dirty ? "有未提交变更" : "工作区干净"}`
                  : changesetQuery.isError
                    ? "暂时无法读取变更摘要；这不会改变已有交付记录。"
                    : "平台正在检查此 Run 相对 base revision 的变更。"}
              </p>
              {patchDownloadMutation.isError ? (
                <p role="alert" className="mt-1 text-xs text-rose-700">
                  {patchDownloadMutation.error instanceof Error ? patchDownloadMutation.error.message : "Patch 下载失败。"}
                </p>
              ) : null}
            </div>
            <Button
              variant="outline"
              className="shrink-0 bg-white"
              loading={patchDownloadMutation.isPending}
              disabled={!changesetQuery.data?.downloadAvailable}
              onClick={() => patchDownloadMutation.mutate()}
            >
              <Download className="h-4 w-4" aria-hidden />
              下载 Patch
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {resultQuery.data ? (
        <RunResultReceiptCard receipt={resultQuery.data} />
      ) : resultQuery.isError ? (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
          <span>Result Receipt 暂时不可用；现有阶段与产物记录不受影响。</span>
          <Button variant="outline" className="shrink-0 bg-white" onClick={() => void resultQuery.refetch()}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            重新加载
          </Button>
        </div>
      ) : (
        <Card className="border-slate-200 bg-white shadow-none">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-slate-500">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            正在汇总 Result Receipt…
          </CardContent>
        </Card>
      )}

      {run.changeContract ? (
        <ChangeContractSummary
          contract={run.changeContract}
          projectId={project.id}
          projectRuns={sourceRunsQuery.data ?? []}
        />
      ) : null}

      {humanDecisionsQuery.isError ? (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>暂时无法读取“决定与待办”。审批门仍会在服务端拦截未决事项，请先重新加载清单。</span>
          </div>
          <Button variant="outline" className="shrink-0 bg-white" onClick={() => void humanDecisionsQuery.refetch()}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            重新加载
          </Button>
        </div>
      ) : null}

      {humanDecisions && (
        humanDecisions.totalBlocking > 0
        || humanDecisions.inconsistentPhaseIds.length > 0
        || humanDecisions.phases.some((gate) => deferredHumanDecisionItems(gate).length > 0)
      ) ? (
        <HumanDecisionOverview
          summary={humanDecisions}
          readOnly={sessionRunCompleted}
          onOpenPhase={openDecisionPhase}
        />
      ) : null}

      <div className="flex w-fit items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        <button
          type="button"
          onClick={() => onViewChange("workflow")}
          className={cn(
            "flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition",
            view === "workflow" ? "bg-slate-950 text-white shadow-sm" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900",
          )}
        >
          <Activity className="h-4 w-4" aria-hidden />
          交付流程
        </button>
        <button
          type="button"
          onClick={() => onViewChange("tickets")}
          className={cn(
            "flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition",
            view === "tickets" ? "bg-slate-950 text-white shadow-sm" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900",
          )}
        >
          <ClipboardList className="h-4 w-4" aria-hidden />
          用户故事 Tickets
        </button>
      </div>

      {view === "tickets" ? (
        <Suspense
          fallback={
            <div role="status" aria-live="polite" className="flex min-h-72 items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white text-sm text-slate-500">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
              正在加载 Ticket 看板…
            </div>
          }
        >
          <TicketBoard
            runId={runId}
            ticketId={ticketId}
            readOnly={sessionRunCompleted}
            onOpenTicket={onOpenTicket}
            onCloseTicket={onCloseTicket}
          />
        </Suspense>
      ) : (
        <>
          <WorkflowBoard
            phases={phases}
            definitions={phaseDefinitions}
            roles={roles}
            decisionSummary={humanDecisions}
            selectedPhaseId={selectedPhase?.phaseId}
            onSelect={setSelectedPhaseId}
          />

          {selectedPhase && selectedDefinition && selectedRole ? (
            <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(330px,0.75fr)]">
              <PhasePanel
                phase={selectedPhase}
                phases={phases}
                hasChangeContract={Boolean(run.changeContract)}
                allowMissingUpstreamInputs={run.executionModel === "flexible" && run.targetPhaseId === selectedPhase.phaseId}
                outputKeysByPhase={outputKeysByPhase}
                definition={selectedDefinition}
                role={selectedRole}
                decisionGate={selectedDecisionGate}
                sessionAudit={sessionAudit}
                sessionRoutePending={sessionRouteUnverified}
                sessionRunCompleted={sessionRunCompleted}
                architectureImpactAvailable={
                  selectedPhase.phaseId === "architecture"
                  && selectedPhase.status === "ready"
                  && !selectedPhase.resolution
                  && !selectedPhase.architectureImpact
                  && isFirstPhaseImpactAttempt(selectedPhase)
                }
                routedImpactCheckAvailable={
                  (selectedPhase.phaseId === "discovery" || selectedPhase.phaseId === "design")
                  && selectedPhase.status === "ready"
                  && !selectedPhase.resolution
                  && isFirstPhaseImpactAttempt(selectedPhase)
                }
                onExecute={(initialOutputKeys) => requestPhaseExecution({
                  phaseId: selectedPhase.phaseId,
                  initialOutputKeys,
                })}
                onReview={(initialArtifactId) =>
                  setReviewTarget({ phaseId: selectedPhase.phaseId, initialArtifactId })
                }
                onOpenTickets={() => onViewChange("tickets")}
                standardVerificationLocked={standardVerificationLocked}
                verificationE2eStarted={Boolean(
                  e2eFlowQuery.data?.authoring || e2eFlowQuery.data?.execution
                )}
                verificationE2eStateUncertain={linkedStateUncertain}
                verificationE2eReviewReady={
                  e2eFlowQuery.data?.state === "awaiting_verification_review"
                  && !e2eFlowLoadError
                }
                verificationE2ePanel={sessionRunCompleted ? undefined : selectedPhase.phaseId === "verification" && project.sourceKind === "remote-git" ? (
                  <CloudVerificationBoundary />
                ) : selectedPhase.phaseId === "verification" ? (
                  <VerificationE2ePanel
                    projectId={project.id}
                    runId={runId}
                    phaseStatus={selectedPhase.status}
                    workspace={linkedWorkspace}
                    flow={e2eFlowQuery.data ?? null}
                    busy={
                      e2eFlowQuery.isFetching
                      || e2eWorkspaceQuery.isFetching
                      || preflightE2eMutation.isPending
                      || prepareE2eMutation.isPending
                      || sessionRouteUnverified
                    }
                    error={e2eFlowErrorMessage(
                      e2eFlowQuery.error,
                      preflightE2eMutation.error,
                      prepareE2eMutation.error,
                    )}
                    flowLoadError={e2eFlowLoadError}
                    flowStateUncertain={linkedStateUncertain}
                    onRetryFlow={() => {
                      void Promise.all([
                        e2eFlowQuery.refetch(),
                        e2eWorkspaceQuery.refetch(),
                      ]);
                    }}
                    onConfigureWorkspace={() => {
                      setE2eWorkspaceOpen(true);
                    }}
                    onPrepareWorkspace={() => prepareE2eMutation.mutate()}
                    onPreflight={() => preflightE2eMutation.mutate()}
                    onAuthor={() => requestPhaseExecution({
                      phaseId: "verification",
                      verificationAction: "author_e2e",
                    })}
                    onReviewScript={() => setE2eScriptReviewOpen(true)}
                    onExecute={() => requestPhaseExecution({
                      phaseId: "verification",
                      verificationAction: "run_e2e",
                    })}
                    onOpenVerificationReview={() => setReviewTarget({ phaseId: "verification" })}
                  />
                ) : undefined}
              />
              <EventTimeline
                phase={selectedPhase}
                sessionAudit={sessionAudit}
                sessionRoutePending={sessionRouteUnverified}
              />
            </div>
          ) : null}

          {!sessionRouteUnverified && !sessionAudit && executePhase ? (
            <ExecuteDialog
              runId={runId}
              runTitle={run.title}
              phase={executePhase}
              phases={phases}
              hasChangeContract={Boolean(run.changeContract)}
              allowMissingUpstreamInputs={run.executionModel === "flexible" && run.targetPhaseId === executePhase.phaseId}
              outputKeysByPhase={outputKeysByPhase}
              workType={run.changeContract?.workType}
              hasEvidenceRefs={Boolean(run.changeContract?.evidenceRefs.length)}
              productBaseline={productBaseline}
              designBaseline={designBaseline}
              architectureBaseline={architectureBaseline}
              figmaEnabled={project.sourceKind === "legacy-local"}
              initialOutputKeys={executeTarget?.initialOutputKeys}
              verificationAction={executeTarget?.verificationAction}
              definition={
                phaseDefinitions.find((definitionItem) => definitionItem.id === executePhase.phaseId) ??
                FALLBACK_PHASES[0]
              }
              open
              onOpenChange={(open) => !open && setExecuteTarget(undefined)}
              onNavigatePhase={(phaseId) => {
                setExecuteTarget(undefined);
                setSelectedPhaseId(phaseId);
              }}
            />
          ) : null}
          {reviewPhase ? (
            <ReviewDialog
              runId={runId}
              phase={reviewPhase}
              initialArtifactId={reviewTarget?.initialArtifactId}
              definition={
                phaseDefinitions.find((definitionItem) => definitionItem.id === reviewPhase.phaseId) ??
                FALLBACK_PHASES[0]
              }
              decisionGate={reviewDecisionGate}
              readOnly={sessionRunCompleted}
              open
              onOpenChange={(open) => !open && setReviewTarget(undefined)}
              onRerunArtifact={(artifactKey) => {
                setReviewTarget(undefined);
                requestPhaseExecution({
                  phaseId: reviewPhase.phaseId,
                  initialOutputKeys: [artifactKey],
                });
              }}
              onRerunOutputs={(artifactKeys) => {
                setReviewTarget(undefined);
                requestPhaseExecution({
                  phaseId: reviewPhase.phaseId,
                  initialOutputKeys: artifactKeys,
                });
              }}
              onNavigateDecisionPhase={openDecisionPhase}
              onDecisionSaved={(phaseId) => {
                setReviewTarget(undefined);
                setSelectedPhaseId(phaseId);
                requestPhaseExecution({ phaseId });
              }}
            />
          ) : null}
          {project.sourceKind === "legacy-local" ? (
            <E2eWorkspaceDialog
              projectId={project.id}
              suggestedRootPath=""
              open={e2eWorkspaceOpen}
              onOpenChange={setE2eWorkspaceOpen}
              onConfigured={async (workspace) => {
                queryClient.setQueryData(e2eWorkspaceQueryKey, workspace);
                await queryClient.invalidateQueries({ queryKey: e2eFlowQueryKey });
              }}
            />
          ) : null}
          {project.sourceKind === "legacy-local" ? (
            <E2eScriptReviewDialog
              runId={runId}
              authoring={e2eFlowLoadError ? null : e2eFlowQuery.data?.authoring ?? null}
              loadError={e2eFlowLoadError}
              open={e2eScriptReviewOpen}
              onOpenChange={setE2eScriptReviewOpen}
              onReviewed={async () => {
                await queryClient.invalidateQueries({ queryKey: e2eFlowQueryKey });
                await queryClient.invalidateQueries({ queryKey: ["run", runId] });
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function workspaceStateLabel(state: NonNullable<WorkflowRun["workspaceState"]>): string {
  const labels: Record<NonNullable<WorkflowRun["workspaceState"]>, string> = {
    provisioning: "准备中",
    ready: "已就绪",
    busy: "运行中",
    failed: "失败",
    destroyed: "已回收",
  };
  return labels[state];
}

function RunResultReceiptCard({ receipt }: { receipt: RunResultReceipt }) {
  const outcomeLabels: Record<RunResultReceipt["outcome"], string> = {
    pending: "已就绪",
    running: "执行中",
    blocked: "等待复核",
    failed: "执行失败",
    completed: "已完成",
  };
  const outcomeVariants: Record<
    RunResultReceipt["outcome"],
    "muted" | "info" | "warning" | "danger" | "success"
  > = {
    pending: "muted",
    running: "info",
    blocked: "warning",
    failed: "danger",
    completed: "success",
  };
  const changedPathCount = receipt.files.created.length
    + receipt.files.modified.length
    + receipt.files.deleted.length;
  const pathGroups = [
    ["新增", receipt.files.created],
    ["修改", receipt.files.modified],
    ["删除", receipt.files.deleted],
  ] as const;
  const receiptMetrics = [
    { label: "项目路径", value: changedPathCount, icon: GitBranch },
    { label: "阶段产物", value: receipt.artifacts.length, icon: FileText },
    { label: "执行记录", value: receipt.executions.length, icon: TerminalSquare },
    { label: "验证执行", value: receipt.tests.totalExecutions, icon: FlaskConical },
  ];

  return (
    <Card className="overflow-hidden border-teal-100 bg-gradient-to-br from-white via-white to-teal-50/60 shadow-sm">
      <CardHeader className="flex-row items-start justify-between gap-4 border-b border-teal-100/80 p-5 sm:p-6">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileCheck2 className="h-4 w-4 text-teal-700" aria-hidden />
            Result Receipt
          </CardTitle>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{receipt.summary}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge variant={outcomeVariants[receipt.outcome]}>{outcomeLabels[receipt.outcome]}</Badge>
          <span className="text-[10px] text-slate-400">v{receipt.resultReceiptVersion}</span>
        </div>
      </CardHeader>
      <CardContent className="p-5 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {receiptMetrics.map(({ label, value, icon: Icon }) => (
            <div key={label} className="rounded-xl border border-slate-200 bg-white/85 p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                <Icon className="h-3.5 w-3.5 text-teal-700" aria-hidden />
                {label}
              </div>
              <div className="mt-2 text-xl font-bold text-slate-950">{value}</div>
            </div>
          ))}
        </div>

        {changedPathCount > 0 ? (
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            {pathGroups.map(([label, paths]) => (
              <div key={label} className="rounded-xl border border-slate-200 bg-white/75 p-3">
                <div className="text-xs font-semibold text-slate-700">{label} · {paths.length}</div>
                <div className="mt-2 space-y-1">
                  {paths.slice(0, 5).map((filePath) => (
                    <div key={filePath} className="truncate font-mono text-[10px] text-slate-500" title={filePath}>
                      {filePath}
                    </div>
                  ))}
                  {paths.length > 5 ? (
                    <div className="text-[10px] text-slate-400">另有 {paths.length - 5} 项</div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white/75 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
              <ShieldCheck className="h-4 w-4 text-teal-700" aria-hidden />
              风险与环境
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Workspace：{receipt.environment.workspaceState
                ? workspaceStateLabel(receipt.environment.workspaceState)
                : "未请求独立环境"}
            </p>
            {receipt.risks.length > 0 ? (
              <div className="mt-2 space-y-1 text-xs leading-5 text-amber-800">
                {receipt.risks.map((risk) => <div key={risk}>• {risk}</div>)}
              </div>
            ) : (
              <p className="mt-2 text-xs text-emerald-700">当前没有已记录风险。</p>
            )}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/75 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
              <ArrowRight className="h-4 w-4 text-teal-700" aria-hidden />
              后续建议
            </div>
            <div className="mt-2 space-y-1 text-xs leading-5 text-slate-600">
              {receipt.recommendations.map((recommendation) => (
                <div key={recommendation}>• {recommendation}</div>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function e2eFlowErrorMessage(...errors: unknown[]): string | undefined {
  const messages = errors.flatMap((error) => (
    error instanceof Error && error.message ? [error.message] : []
  ));
  return [...new Set(messages)].join("；") || undefined;
}

const WORK_TYPE_LABELS: Record<ChangeContract["workType"], string> = {
  feature: "新功能",
  change: "局部变更",
  bug: "功能缺陷",
  technical: "技术变更",
};

function ChangeContractSummary({
  contract,
  projectId,
  projectRuns,
}: {
  contract: ChangeContract;
  projectId: string;
  projectRuns: WorkflowRun[];
}) {
  return (
    <details className="group overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 marker:hidden sm:px-6">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-950">任务合同（Change Contract）</span>
            <Badge variant="info">{WORK_TYPE_LABELS[contract.workType]}</Badge>
            <Badge variant="success">后续角色共同输入</Badge>
          </span>
          <span className="mt-1 block truncate text-xs text-slate-500">{contract.summary}</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition group-open:rotate-90" aria-hidden />
      </summary>
      <div className="grid gap-4 border-t border-slate-100 bg-slate-50/45 px-5 py-5 sm:px-6 lg:grid-cols-2">
        {contract.workItem ? <ContractWorkItem source={contract.workItem} /> : null}
        {contract.sourceRunIds?.length ? (
          <ContractSourceRuns
            ids={contract.sourceRunIds}
            projectId={projectId}
            projectRuns={projectRuns}
          />
        ) : null}
        <ContractNarrative title="当前行为" content={contract.currentBehavior} />
        <ContractNarrative title="期望行为" content={contract.expectedBehavior} />
        <ContractList title="范围内" items={contract.inScope} />
        <ContractList title="范围外" items={contract.outOfScope} empty="未声明额外排除项" />
        <ContractList title="验收标准" items={contract.acceptanceCriteria} />
        <ContractList title="回归范围" items={contract.regressionScope} />
        <ContractList title="风险标记" items={contract.riskFlags} empty="未声明风险标记" />
        <ContractList title="证据引用" items={contract.evidenceRefs} empty="未提供额外证据引用" />
      </div>
    </details>
  );
}

function CloudVerificationBoundary() {
  return (
    <Card className="overflow-hidden border-sky-200" aria-label="云端 Verification 说明">
      <CardHeader className="border-b border-sky-100 bg-sky-50/60">
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-sky-700" aria-hidden />
          云端 Verification
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-5 text-xs leading-5 text-slate-700">
        <p>
          Tester 会在当前 Run 的隔离 Worker 中检查代码、测试和交付证据；不需要绑定本地项目或第二个目录。
        </p>
        <p>
          本 MVP 尚未提供独立、可复用的云端真实浏览器 Linked E2E。若验收必须包含浏览器证据，请在受控 CI
          或后续专用浏览器 Worker 中运行，并在证据缺失时保持人工 Gate 不通过。
        </p>
      </CardContent>
    </Card>
  );
}

function ContractWorkItem({ source }: { source: NonNullable<ChangeContract["workItem"]> }) {
  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/60 px-4 py-3 lg:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-sky-900">工作项来源</div>
          <p className="mt-1 text-xs text-slate-700">
            {source.adapterLabel} · {source.externalId}
          </p>
        </div>
        <Badge variant="info">已由人工确认后冻结</Badge>
      </div>
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <ContractSourceFact label="原始引用" value={source.reference} />
        <ContractSourceFact label="读取时间" value={formatDate(source.fetchedAt)} />
        <ContractSourceFact label="Adapter" value={source.adapterId} />
        <ContractSourceFact label="证据指纹" value={source.fingerprint} mono />
      </dl>
      {source.url ? (
        <a
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-sky-800 hover:text-sky-950"
          href={source.url}
          target="_blank"
          rel="noreferrer"
        >
          打开原工作项
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      ) : null}
    </div>
  );
}

function ContractSourceFact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="font-semibold text-slate-500">{label}</dt>
      <dd className={cn("mt-0.5 break-all text-slate-800", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

function ContractSourceRuns({
  ids,
  projectId,
  projectRuns,
}: {
  ids: string[];
  projectId: string;
  projectRuns: WorkflowRun[];
}) {
  const runsById = new Map(projectRuns.map((run) => [run.id, run]));
  return (
    <div className="rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3 lg:col-span-2">
      <div className="text-xs font-semibold text-teal-800">原始任务</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {ids.map((id) => (
          <a
            key={id}
            href={`?project=${encodeURIComponent(projectId)}&run=${encodeURIComponent(id)}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-teal-200 bg-white px-2.5 py-1.5 text-xs font-medium text-teal-700 transition hover:border-teal-300 hover:text-teal-900"
          >
            {runsById.get(id)?.title ?? `任务 ${id.slice(0, 8)}`}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        ))}
      </div>
    </div>
  );
}

function ContractNarrative({ title, content }: { title: string; content: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="text-xs font-semibold text-slate-700">{title}</div>
      <p className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-slate-600">{content}</p>
    </div>
  );
}

function ContractList({
  title,
  items,
  empty = "未填写",
}: {
  title: string;
  items: string[];
  empty?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="text-xs font-semibold text-slate-700">{title}</div>
      {items.length > 0 ? (
        <ul className="mt-1.5 space-y-1 text-xs leading-5 text-slate-600">
          {items.map((item) => <li key={item}>• {item}</li>)}
        </ul>
      ) : (
        <p className="mt-1.5 text-xs text-slate-400">{empty}</p>
      )}
    </div>
  );
}

function normalizePhases(phases: PhaseRun[], definitions?: PhaseDefinition[]): PhaseRun[] {
  const source = definitions?.length ? definitions : FALLBACK_PHASES;
  return source.map((definition, position) => {
    const phase = phases.find((item) => item.phaseId === definition.id);
    return (
      phase ?? ({
        phaseId: definition.id,
        position,
        status: position === 0 ? "ready" : "pending",
        artifacts: [],
        reviews: [],
        executions: [],
        events: [],
        availableArtifacts: [],
      } satisfies PhaseRun)
    );
  });
}

function HumanDecisionOverview({
  summary,
  readOnly = false,
  onOpenPhase,
}: {
  summary: HumanDecisionSummary;
  readOnly?: boolean;
  onOpenPhase: (phaseId: HumanDecisionPhaseId) => void;
}) {
  const visibleGates = summary.phases.filter(
    (gate) => gate.blockingCount > 0 || deferredHumanDecisionItems(gate).length > 0,
  );
  const productDecisions = summary.phases.find(({ phaseId }) => phaseId === "discovery")?.decisionCount ?? 0;
  const designWork = summary.phases.find(({ phaseId }) => phaseId === "design")?.workCount ?? 0;
  const deferredDesignChecks = deferredHumanDecisionItems(
    summary.phases.find(({ phaseId }) => phaseId === "design"),
  ).length;
  const architectureDecisions = summary.phases.find(({ phaseId }) => phaseId === "architecture")?.decisionCount ?? 0;
  return (
    <Card className="overflow-hidden border-amber-200 bg-amber-50/45 shadow-sm">
      <CardHeader className="border-b border-amber-100 bg-white/65 p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-100 text-amber-800">
                <MessageSquare className="h-4 w-4" aria-hidden />
              </span>
              <div>
                <CardTitle className="text-base">
                  {readOnly ? "未关闭的决定与待办历史" : "决定与待办"}
                </CardTitle>
                <p className="mt-0.5 text-xs leading-5 text-slate-600">
                  {readOnly
                    ? "这条 Session Run 已完成；以下遗留项只用于审计查看，不能再处理、改写产物或重新打开流程。"
                    : "这里才是你需要处理的入口。回答决定或进入来源阶段；底层 Markdown 会由对应角色更新。"}
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {productDecisions > 0 ? <Badge variant="warning">产品决定 {productDecisions}</Badge> : null}
            {designWork > 0 ? <Badge variant="info">设计待办 {designWork}</Badge> : null}
            {deferredDesignChecks > 0 ? <Badge variant="muted">实现后验证 {deferredDesignChecks}</Badge> : null}
            {architectureDecisions > 0 ? <Badge variant="warning">架构决定 {architectureDecisions}</Badge> : null}
          </div>
        </div>
        {summary.inconsistentPhaseIds.length > 0 ? (
          <div role="alert" className="mt-4 flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs leading-5 text-rose-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              发现旧流程不一致：{summary.inconsistentPhaseIds.map((phaseId) => HUMAN_DECISION_PHASE_LABELS[phaseId]).join("、")}
              已显示为“通过”，但正式产物里仍有未关闭事项。
              {readOnly
                ? " 这条记录现仅保留为完成态审计历史。"
                : " 请处理后让对应角色重新生成，不要继续向下游推进。"}
            </span>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-3 p-4 sm:grid-cols-3 sm:p-5">
        {visibleGates.map((gate) => {
          const onlyDeferred = gate.blockingCount === 0
            && deferredHumanDecisionItems(gate).length > 0;
          return (
          <button
            key={gate.phaseId}
            type="button"
            aria-label={`${readOnly ? "查看未关闭历史" : "处理决定与待办"} · ${HUMAN_DECISION_PHASE_LABELS[gate.phaseId]}`}
            onClick={() => onOpenPhase(gate.phaseId)}
            className={cn(
              "rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500",
              gate.inconsistentApproval
                ? "border-rose-200"
                : onlyDeferred
                  ? "border-sky-200"
                  : "border-amber-200",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-slate-950">
                  {HUMAN_DECISION_PHASE_LABELS[gate.phaseId]}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  对应角色：{HUMAN_DECISION_ROLE_LABELS[gate.phaseId]}
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-300" aria-hidden />
            </div>
            <p className={cn(
              "mt-3 text-xs font-semibold",
              gate.inconsistentApproval
                ? "text-rose-700"
                : onlyDeferred
                  ? "text-sky-800"
                  : "text-amber-800",
            )}>
              {humanDecisionGateHeadline(gate)}
            </p>
            {readOnly ? (
              <div className="mt-2 text-[10px] font-semibold text-slate-500">
                查看未关闭历史 · 只读
              </div>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
              {gate.decisionCount > 0 ? <Badge variant="warning">你决定 {gate.decisionCount}</Badge> : null}
              {gate.workCount > 0 ? <Badge variant="info">角色补做 {gate.workCount}</Badge> : null}
              {gate.dependencyCount > 0 ? <Badge variant="muted">上游依赖 {gate.dependencyCount}</Badge> : null}
              {deferredHumanDecisionItems(gate).length > 0 ? (
                <Badge variant="muted">Tester 验证 {deferredHumanDecisionItems(gate).length}</Badge>
              ) : null}
            </div>
          </button>
          );
        })}
      </CardContent>
    </Card>
  );
}

function WorkflowBoard({
  phases,
  definitions,
  roles,
  decisionSummary,
  selectedPhaseId,
  onSelect,
}: {
  phases: PhaseRun[];
  definitions: PhaseDefinition[];
  roles: RoleDefinition[];
  decisionSummary?: HumanDecisionSummary;
  selectedPhaseId?: string;
  onSelect: (phaseId: string) => void;
}) {
  return (
    <Card className="overflow-hidden shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-5 py-3.5">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          <Activity className="h-4 w-4 text-teal-600" aria-hidden />
          交付看板
        </div>
        <span className="text-[11px] text-slate-400">点击阶段查看详情</span>
      </div>
      <div className="scrollbar-thin overflow-x-auto p-4 sm:p-5">
        <div className="grid min-w-[1060px] grid-cols-6 gap-3">
          {phases.map((phase, index) => {
            const definition = definitions.find((item) => item.id === phase.phaseId) ?? FALLBACK_PHASES[index];
            const role = roles.find((item) => item.id === definition.owner);
            const Icon = roleIcons[definition.owner] ?? Bot;
            const style = statusStyle[phase.status] ?? statusStyle.pending;
            const selected = phase.phaseId === selectedPhaseId;
            const decisionGate = decisionSummary?.phases.find(
              ({ phaseId }) => phaseId === phase.phaseId,
            );
            return (
              <div key={phase.phaseId} className="relative min-w-0">
                {index < phases.length - 1 ? (
                  <div className="absolute -right-3 top-10 z-0 h-px w-3 bg-slate-300" />
                ) : null}
                <button
                  type="button"
                  onClick={() => onSelect(phase.phaseId)}
                  className={cn(
                    "relative z-10 h-full min-h-40 w-full rounded-xl border p-3.5 text-left transition duration-200 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2",
                    style.card,
                    selected && "ring-2 ring-slate-900 ring-offset-2",
                    ["pending", "locked"].includes(phase.status) && "opacity-70",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white bg-white text-slate-700 shadow-sm">
                      {phase.status === "running" ? (
                        <LoaderCircle className="h-[18px] w-[18px] animate-spin text-sky-600" />
                      ) : phase.status === "approved" ? (
                        <Check className="h-[18px] w-[18px] text-emerald-600" />
                      ) : ["pending", "locked"].includes(phase.status) ? (
                        <LockKeyhole className="h-4 w-4 text-slate-400" />
                      ) : (
                        <Icon className="h-[18px] w-[18px]" />
                      )}
                    </span>
                    <span className="text-[10px] font-bold text-slate-300">0{index + 1}</span>
                  </div>
                  <div className="mt-3 text-sm font-semibold tracking-tight text-slate-900">
                    {getPhaseName(definition)}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-slate-500">{role?.name ?? definition.owner}</div>
                  <div className="mt-3 flex items-center gap-1.5 text-[10px] font-semibold text-slate-600">
                    <span className={cn("h-1.5 w-1.5 rounded-full", style.dot, phase.status === "running" && "animate-pulse")} />
                    {phaseStatusLabel(phase.status, phase.executions[0]?.command)}
                  </div>
                  {phase.resolution ? (
                    <div className="mt-2 truncate rounded-md bg-white/75 px-2 py-1 text-[10px] font-semibold text-teal-700 ring-1 ring-slate-200/80">
                      {resolutionModeLabel(phase.resolution)}
                    </div>
                  ) : null}
                  {decisionGate && decisionGate.blockingCount > 0 ? (
                    <div className={cn(
                      "mt-2 rounded-md px-2 py-1 text-[10px] font-semibold ring-1",
                      decisionGate.inconsistentApproval
                        ? "bg-rose-50 text-rose-700 ring-rose-200"
                        : "bg-amber-50 text-amber-800 ring-amber-200",
                    )}>
                      {decisionGate.inconsistentApproval
                        ? `通过状态不一致 · ${decisionGate.blockingCount} 项`
                        : humanDecisionGateHeadline(decisionGate)}
                    </div>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function PhasePanel({
  phase,
  phases,
  hasChangeContract,
  allowMissingUpstreamInputs = false,
  outputKeysByPhase,
  definition,
  role,
  decisionGate,
  sessionAudit = false,
  sessionRoutePending = false,
  sessionRunCompleted = false,
  architectureImpactAvailable,
  routedImpactCheckAvailable,
  onExecute,
  onReview,
  onOpenTickets,
  standardVerificationLocked = false,
  verificationE2eStarted = false,
  verificationE2eStateUncertain = false,
  verificationE2eReviewReady = false,
  verificationE2ePanel,
}: {
  phase: PhaseRun;
  phases: PhaseRun[];
  hasChangeContract: boolean;
  allowMissingUpstreamInputs?: boolean;
  outputKeysByPhase: Partial<Record<string, string[]>>;
  definition: PhaseDefinition;
  role: RoleDefinition;
  decisionGate?: PhaseHumanDecisionGate;
  sessionAudit?: boolean;
  sessionRoutePending?: boolean;
  sessionRunCompleted?: boolean;
  architectureImpactAvailable?: boolean;
  routedImpactCheckAvailable?: boolean;
  onExecute: (initialOutputKeys?: string[]) => void;
  onReview: (initialArtifactId?: string) => void;
  onOpenTickets: () => void;
  standardVerificationLocked?: boolean;
  verificationE2eStarted?: boolean;
  verificationE2eStateUncertain?: boolean;
  verificationE2eReviewReady?: boolean;
  verificationE2ePanel?: ReactNode;
}) {
  const Icon = roleIcons[role.id] ?? Bot;
  const style = statusStyle[phase.status] ?? statusStyle.pending;
  const effectiveInputs = allowMissingUpstreamInputs
    ? []
    : effectiveRequiredInputKeys(
      definition.inputs,
      phases,
      { hasChangeContract, outputKeysByPhase },
    );
  const canExecute = ["ready", "changes_requested", "rejected", "failed"].includes(phase.status)
    && !resolutionIsReadOnly(phase.resolution)
    && !sessionRunCompleted;
  const canReview = phase.status === "awaiting_review";
  const canReviseArtifacts = [
    "ready",
    "awaiting_review",
    "approved",
    "changes_requested",
    "rejected",
    "failed",
  ].includes(phase.status);
  const canRerun =
    phase.artifacts.length > 0
    && canReviseArtifacts
    && !resolutionIsReadOnly(phase.resolution)
    && phase.architectureImpact?.mode !== "reuse"
    && !sessionRunCompleted;
  const standardVerificationExecutionLocked = phase.phaseId === "verification"
    && standardVerificationLocked;
  const linkedVerificationReviewLocked = phase.phaseId === "verification"
    && standardVerificationLocked
    && !verificationE2eReviewReady;
  const showsArchitectureImpactAction = Boolean(
    architectureImpactAvailable
    && phase.phaseId === "architecture"
    && phase.status === "ready",
  );
  const showsRoutedImpactAction = Boolean(
    routedImpactCheckAvailable
    && (phase.phaseId === "discovery" || phase.phaseId === "design")
    && phase.status === "ready",
  );
  const showsImpactAction = showsArchitectureImpactAction || showsRoutedImpactAction;
  const requiresFullRerun = phase.status === "ready"
    && !phase.resolution
    && ["discovery", "design", "architecture"].includes(phase.phaseId)
    && !isFirstPhaseImpactAttempt(phase);
  const executionError = phase.executions?.[0]?.error || phase.error;
  const deferredDecisionItems = deferredHumanDecisionItems(decisionGate);
  const nonBlockingDecisionItems = nonBlockingHumanDecisionItems(decisionGate);
  const deferredHandoffCleanupRequired = isDeferredDesignHandoffCleanupGate(decisionGate);
  const onlyDeferredDesignVerification = phase.phaseId === "design"
    && Boolean(decisionGate)
    && decisionGate!.blockingCount === 0
    && deferredDecisionItems.length > 0;
  const decisionActionRunsRole = Boolean(
    decisionGate
    && canExecute
    && (decisionGate.dependencyCount > 0 || decisionGate.workCount > 0),
  );
  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b border-slate-100 bg-slate-50/40 p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white shadow-sm">
              <Icon className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-lg">{getPhaseName(definition)}</CardTitle>
                <Badge variant={style.badge}>
                  {phaseStatusLabel(phase.status, phase.executions[0]?.command)}
                </Badge>
              </div>
              <p className="mt-1 text-sm font-medium text-teal-700">{role.name}</p>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{role.mission}</p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {canExecute && !standardVerificationExecutionLocked ? (
              <Button
                variant="primary"
                disabled={sessionRoutePending}
                onClick={() => onExecute()}
              >
                {sessionRoutePending ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                ) : sessionAudit ? (
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                ) : showsImpactAction ? (
                  <GitBranch className="h-4 w-4" />
                ) : phase.status === "ready" ? (
                  <Play className="h-4 w-4" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                {sessionRoutePending
                  ? "正在验证 Session 归属"
                  : sessionAudit
                  ? "返回 Session 继续"
                  : showsRoutedImpactAction
                  ? phaseImpactActionLabel(phase.phaseId as RoutedImpactPhaseId)
                  : showsArchitectureImpactAction
                    ? "检查架构影响"
                  : phase.phaseId === "implementation" && phase.status === "ready"
                    ? "检查条件并开始写代码"
                  : phase.phaseId === "implementation"
                    ? "根据反馈重新实施"
                  : phase.phaseId === "verification" && phase.status === "ready"
                    ? "普通验证（无需真实浏览器 E2E）"
                  : phase.phaseId === "release" && phase.status === "ready"
                    ? "生成发布准备手册"
                  : phase.phaseId === "release"
                    ? "根据反馈更新发布手册"
                  : onlyDeferredDesignVerification || deferredHandoffCleanupRequired
                    ? "整理实现后验证交接"
                  : phase.status === "ready"
                    ? `运行 ${role.name}`
                    : "根据反馈重新运行"}
              </Button>
            ) : null}
            {canReview && !linkedVerificationReviewLocked ? (
              <Button variant="default" className="animate-pulse-ring" onClick={() => onReview()}>
                <Eye className="h-4 w-4" aria-hidden />
                {phase.phaseId === "release" ? "审核发布准备材料" : "审核 AI 产物"}
              </Button>
            ) : phase.status === "approved" ? (
              <Button variant="outline" onClick={() => onReview()}>
                <FileCheck2 className="h-4 w-4" aria-hidden />
                查看审核记录
              </Button>
            ) : null}
            {canRerun && !canExecute && !standardVerificationExecutionLocked ? (
              <Button
                variant="outline"
                disabled={sessionRoutePending}
                onClick={() => onExecute()}
              >
                {sessionRoutePending
                  ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                  : sessionAudit
                  ? <ArrowLeft className="h-4 w-4" aria-hidden />
                  : <RotateCcw className="h-4 w-4" aria-hidden />}
                {sessionRoutePending
                  ? "正在验证 Session 归属"
                  : sessionAudit
                  ? "返回 Session 继续"
                  : phase.phaseId === "implementation"
                  ? "重新实施并刷新全部证据"
                  : phase.phaseId === "verification"
                    ? "普通重跑（无需真实浏览器 E2E）"
                    : "选择产物重跑"}
              </Button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-5 sm:p-6">
        {phase.phaseId === "implementation" ? (
          <div className="mb-5">
            <EngineeringFlowGuide
              executorLabel={sessionAudit
                ? "当前 Session Agent"
                : sessionRoutePending ? "归属验证后的执行器" : undefined}
            />
          </div>
        ) : null}
        {phase.phaseId === "verification" ? (
          <div className="mb-5"><TesterFlowGuide /></div>
        ) : null}
        {phase.phaseId === "release" ? (
          <div className="mb-5"><ReleaseFlowGuide /></div>
        ) : null}
        {phase.phaseId === "release" && phase.status === "approved" ? (
          <div role="status" className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950">
            <div className="font-semibold">发布准备材料已通过人工审核</div>
            <p className="mt-1 text-xs leading-5 text-emerald-900">{RELEASE_COMPLETION_BOUNDARY}</p>
          </div>
        ) : null}
        {phase.phaseId === "verification" && verificationE2ePanel ? (
          <div className="mb-5 space-y-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-700">
              两条验证路径并列：只有平台已明确确认未配置 linked workspace，且验收标准确实无需真实浏览器 E2E 时，才使用上方“普通验证”；
              一旦配置 workspace，就必须使用下方独立 E2E 流程。真正未配置的既有非 E2E Run 不必配置 workspace，
              最终 test-report 仍会按验收标准校验，缺少必需证据时不会放行。
            </div>
            {verificationE2eStateUncertain ? (
              <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-950">
                无法确认 linked 状态，请重试加载。为防止覆盖可能已经存在的 linked E2E 证据，
                普通 Tester 执行、重跑和审核暂时停用。
              </div>
            ) : null}
            {verificationE2eStarted ? (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-950">
                本 Run 已启动 linked E2E 流程：当前 Verification 必须使用成功的 linked E2E 证据完成，
                不能再用普通 Tester 报告覆盖。本版不提供取消或退回普通路径的按钮。
              </div>
            ) : null}
            {verificationE2ePanel}
          </div>
        ) : null}
        {onlyDeferredDesignVerification || deferredHandoffCleanupRequired ? (
          <div className="mb-5 flex flex-col gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <Clock3 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div>
                <div className="font-semibold">
                  {deferredHandoffCleanupRequired
                    ? "实现后验证本身不阻塞 · 还需整理 1 次正式交接"
                    : `实现后验证 ${deferredDecisionItems.length} 项 · 当前不阻塞 Design`}
                </div>
                <p className="mt-1 text-xs leading-5">
                  这类检查需要可运行实现，Designer 现在只负责写清目标与通过条件；
                  Design 和 Architecture 通过后才由 Software Engineer 写代码，Tester 在 Verification 执行浏览器与无障碍验证。
                </p>
                {phase.status === "changes_requested" || phase.status === "rejected" ? (
                  <p className="mt-1 text-xs font-semibold leading-5">
                    当前仍是旧的“要求修改”状态：只需整理一次正式 design-spec 交接，不要再次尝试在 Design 阶段完成运行时验证。
                  </p>
                ) : null}
              </div>
            </div>
            {canReview ? (
              <Button variant="outline" className="shrink-0 bg-white" onClick={() => onReview()}>
                <Eye className="h-4 w-4" aria-hidden />
                审核设计并继续
              </Button>
            ) : canExecute ? (
              <Button
                variant="outline"
                className="shrink-0 bg-white"
                disabled={sessionRoutePending}
                onClick={() => onExecute()}
              >
                {sessionRoutePending
                  ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                  : sessionAudit
                  ? <ArrowLeft className="h-4 w-4" aria-hidden />
                  : <RotateCcw className="h-4 w-4" aria-hidden />}
                {sessionRoutePending
                  ? "正在验证 Session 归属"
                  : sessionAudit ? "返回 Session 继续" : "整理交接并进入审核"}
              </Button>
            ) : null}
          </div>
        ) : null}
        {nonBlockingDecisionItems.length > 0 ? (
          <div className="mb-5 flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-800">
            <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
            <span>
              开放问题 {nonBlockingDecisionItems.length} 项 · 当前不阻塞，也不要求你现在决定。
              如果后续答案会改变范围或行为，应新建/重新评估对应 Impact Check。
            </span>
          </div>
        ) : null}
        {decisionGate && decisionGate.blockingCount > 0 ? (
          <div className={cn(
            "mb-5 flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between",
            decisionGate.inconsistentApproval
              ? "border-rose-200 bg-rose-50 text-rose-900"
              : "border-amber-200 bg-amber-50 text-amber-900",
          )}>
            <div className="flex min-w-0 items-start gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div>
                <div className="font-semibold">
                  {sessionRunCompleted
                    ? "已完成 Run 中仍有未关闭历史"
                    : humanDecisionGateHeadline(decisionGate)}
                </div>
                <p className="mt-1 text-xs leading-5">
                  {sessionRunCompleted ? (
                    "这些条目只保留用于审计，不能再处理、重新运行角色或改写完成态历史。"
                  ) : (
                    <>
                      {decisionGate.decisionCount > 0 ? `需要你决定 ${decisionGate.decisionCount} 项。` : ""}
                      {decisionGate.workCount > 0 ? ` ${role.name} 还要补做 ${decisionGate.workCount} 项。` : ""}
                      {decisionGate.dependencyCount > 0 ? ` 另有 ${decisionGate.dependencyCount} 项应回到上游处理。` : ""}
                    </>
                  )}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              className="shrink-0 bg-white"
              disabled={sessionRoutePending && decisionActionRunsRole}
              onClick={() => sessionRunCompleted
                ? onReview()
                : decisionActionRunsRole ? onExecute() : onReview()}
            >
              {sessionRunCompleted
                ? <Eye className="h-4 w-4" aria-hidden />
                : decisionActionRunsRole
                ? sessionRoutePending
                  ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                  : sessionAudit
                  ? <ArrowLeft className="h-4 w-4" aria-hidden />
                  : <RotateCcw className="h-4 w-4" aria-hidden />
                : <MessageSquare className="h-4 w-4" aria-hidden />}
              {sessionRunCompleted
                ? "查看未关闭历史"
                : decisionActionRunsRole
                ? sessionRoutePending
                  ? "正在验证 Session 归属"
                  : sessionAudit ? "返回 Session 继续" : `运行 ${role.name} 处理清单`
                : "处理决定与待办"}
            </Button>
          </div>
        ) : null}
        {requiresFullRerun ? (
          <div className="mb-5 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              {sessionAudit
                ? "上游变化已使旧处置失效。历史审核与执行记录仍会保留；请返回原 Session，让当前 Agent 完整更新本阶段。"
                : "上游变化已使旧处置失效。本版本保留历史审核与执行记录，因此本阶段当前只支持完整重跑；如需重新 Skip / Reuse / Partial，请新建 Run 重新评估。"}
            </span>
          </div>
        ) : null}
        {phase.status === "running" ? (
          <div role="status" aria-live="polite" className="mb-5 flex items-center gap-3 rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-sm text-sky-800">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            {sessionRoutePending
              ? "正在验证 URL 中的 Agent Session 归属；确认完成前不会启用任何 Session 或独立执行入口。"
              : sessionAudit
              ? "当前 Agent Session 正沿用所选 Provider 与有界会话历史推进。页面会自动刷新状态和运行事件。"
              : phase.phaseId === "implementation"
                ? "Codex 正在写代码、补测试、运行检查并生成工程证据。页面会自动刷新状态和终端事件。"
                : "Agent 正在隔离工作区中执行。页面会自动刷新状态和运行事件。"}
          </div>
        ) : null}
        {(phase.status === "changes_requested" || phase.status === "rejected")
          && !onlyDeferredDesignVerification
          && !deferredHandoffCleanupRequired ? (
          <div className="mb-5 flex items-start gap-3 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            <MessageSquare className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              最近反馈：{phase.reviews.at(0)?.comment || phase.reviews.at(-1)?.comment || "请修改产物后重新执行。"}
            </span>
          </div>
        ) : null}
        {executionError ? (
          <div className="mb-5 flex items-start gap-3 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {executionError}
          </div>
        ) : null}

        <div className="grid gap-5 md:grid-cols-2">
          <ContractBlock title="有效阶段输入" icon={<ArrowRight />} items={effectiveInputs} empty="路由处置后，本阶段不需要上游产物" />
          <ContractBlock title="预期输出" icon={<FileText />} items={definition.outputs} empty="未注册输出" />
        </div>
        <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <CheckCircle2 className="h-4 w-4 text-teal-600" aria-hidden />
            人工审核 Gate
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-700">{definition.gate || "人工确认本阶段产物满足交付要求。"}</p>
        </div>

        {phase.resolution ? <PhaseResolutionSummary resolution={phase.resolution} /> : null}

        <div className="mt-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-slate-900">本阶段产物</h3>
            <Badge variant="muted">{phase.artifacts.length}</Badge>
          </div>
          {phase.artifacts.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {phase.artifacts.map((artifact) => {
                const artifactKey = keyForArtifact(artifact);
                const isSuperseded = artifact.superseded || artifact.reviewStatus === "superseded";
                const isImpactReadOnly = artifactKey === "change-contract" || (phase.resolution
                  ? !isResolutionOutputMutable(phase.resolution, artifactKey)
                  : phase.phaseId === "architecture"
                    && !isArchitectureImpactOutputMutable(
                      phase.architectureImpact?.mode,
                      phase.architectureImpact?.affectedOutputKeys,
                      artifactKey,
                    ));
                return (
                  <div
                    key={artifact.id}
                    className={cn(
                      "overflow-hidden rounded-xl border border-slate-200 bg-white",
                      isSuperseded && "opacity-65",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onReview(artifact.id)}
                      className="flex w-full items-center gap-3 p-3 text-left transition hover:bg-teal-50/40"
                    >
                      <FileText className="h-4 w-4 shrink-0 text-teal-600" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-800">
                          <span className="truncate">{artifactLabel(artifactKey)}</span>
                          {artifact.revision ? <Badge variant="muted">v{artifact.revision}</Badge> : null}
                          {artifact.revisionSource === "human" ? <Badge variant="info">人工修订</Badge> : null}
                          {isImpactReadOnly ? (
                            <Badge variant="muted">
                              {artifactKey === "change-contract" ? "任务合同只读" : "继承只读"}
                            </Badge>
                          ) : null}
                          {isSuperseded ? <Badge variant="muted">已被替代</Badge> : null}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[10px] text-slate-400">
                          {artifact.filePath || artifact.path || artifactKey}
                        </span>
                      </span>
                      <ChevronRight className="h-3.5 w-3.5 text-slate-300" aria-hidden />
                    </button>
                    <div className="flex flex-wrap items-center justify-end gap-1 border-t border-slate-100 px-2 py-1.5">
                      {artifactKey === "user-stories" ? (
                        <Button size="sm" variant="ghost" onClick={onOpenTickets}>
                          <ClipboardList className="h-3.5 w-3.5" aria-hidden />
                          Tickets
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => onReview(artifact.id)}>
                        <Eye className="h-3.5 w-3.5" aria-hidden />
                        查看
                      </Button>
                      {!sessionRunCompleted && !isSuperseded && canReviseArtifacts && !isImpactReadOnly ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={sessionRoutePending}
                          onClick={() => onExecute([artifactKey])}
                        >
                          {sessionRoutePending
                            ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
                            : sessionAudit
                            ? <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                            : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
                          {sessionRoutePending
                            ? "正在验证 Session 归属"
                            : sessionAudit ? "返回 Session 继续" : "仅重跑此产物"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-xs text-slate-400">
              {phase.status === "running"
                ? "产物生成后会出现在这里"
                : phase.resolution && resolutionIsReadOnly(phase.resolution)
                  ? "本阶段已通过可审核处置完成，没有生成新产物"
                  : "本阶段还没有生成产物"}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PhaseResolutionSummary({ resolution }: { resolution: NonNullable<PhaseRun["resolution"]> }) {
  const inherited = resolution.sourceRunTitle && resolution.sourceRunId;
  return (
    <div className="mt-5 rounded-xl border border-teal-200 bg-teal-50/55 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-teal-950">
          <GitBranch className="h-4 w-4" aria-hidden />
          阶段处置
        </div>
        <Badge variant="info">{resolutionModeLabel(resolution)}</Badge>
      </div>
      <p className="mt-2 text-xs leading-5 text-teal-900">{resolution.rationale}</p>
      <div className="mt-3 grid gap-2 text-[11px] leading-5 text-teal-800 sm:grid-cols-2">
        <div className="rounded-lg bg-white/75 px-3 py-2 ring-1 ring-teal-100">
          <span className="font-semibold">来源：</span>
          {inherited
            ? `${resolution.sourceRunTitle}（${resolution.sourceArtifactIds.length} 项基线产物）`
            : "当前 Change Contract / 人工路由判断"}
        </div>
        <div className="rounded-lg bg-white/75 px-3 py-2 ring-1 ring-teal-100">
          <span className="font-semibold">决定时间：</span>{formatDate(resolution.decidedAt)}
        </div>
      </div>
      {resolution.affectedOutputKeys.length > 0 ? (
        <div className="mt-3">
          <div className="text-[11px] font-semibold text-teal-900">受影响输出</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {resolution.affectedOutputKeys.map((key) => (
              <Badge key={key} variant="outline" className="border-teal-200 bg-white/80 text-teal-800">
                {artifactLabel(key)}
              </Badge>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-[11px] text-teal-700">本处置不生成或修改本阶段产物。</p>
      )}
    </div>
  );
}

function ContractBlock({
  title,
  icon,
  items,
  empty,
}: {
  title: string;
  icon: ReactNode;
  items: string[];
  empty: string;
}) {
  return (
    <div>
      <div className="mb-2.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 [&>svg]:h-3.5 [&>svg]:w-3.5">
        {icon}
        {title}
      </div>
      {items.length ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <span key={item} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600">
              {artifactLabel(item)}
            </span>
          ))}
        </div>
      ) : (
        <div className="text-xs text-slate-400">{empty}</div>
      )}
    </div>
  );
}

function EventTimeline({
  phase,
  sessionAudit = false,
  sessionRoutePending = false,
}: {
  phase: PhaseRun;
  sessionAudit?: boolean;
  sessionRoutePending?: boolean;
}) {
  const events = [...(phase.events ?? [])].sort((a, b) => {
    const byTime = String(b.createdAt ?? b.timestamp ?? "").localeCompare(
      String(a.createdAt ?? a.timestamp ?? ""),
    );
    if (byTime !== 0) return byTime;
    return (b.sequence ?? 0) - (a.sequence ?? 0);
  });
  const latestExecution = phase.executions?.[0];
  const hasExecutionConfiguration = Boolean(
    latestExecution?.model || latestExecution?.reasoningEffort,
  );
  return (
    <Card className="overflow-hidden shadow-sm xl:sticky xl:top-24">
      <CardHeader className="flex-row items-center justify-between border-b border-slate-100 bg-slate-950 p-4 text-white">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <TerminalSquare className="h-4 w-4 text-teal-300" aria-hidden />
            执行时间线
          </CardTitle>
          <p className="mt-1 text-[11px] text-slate-400">Agent event stream · 服务端事件</p>
        </div>
        {phase.status === "running" ? (
          <Badge className="border-sky-400/20 bg-sky-400/10 text-sky-200">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300" /> Live
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        {latestExecution?.command || hasExecutionConfiguration ? (
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
            {latestExecution.command ? (
              <>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Command
                </div>
                <div className="truncate font-mono text-[11px] text-slate-600" title={latestExecution.command}>
                  {latestExecution.command}
                </div>
              </>
            ) : null}
            {hasExecutionConfiguration ? (
              <dl className={cn("flex flex-wrap gap-x-4 gap-y-2", latestExecution.command && "mt-3")}>
                {latestExecution.model ? (
                  <div className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                      实际模型
                    </dt>
                    <dd className="mt-0.5 max-w-48 truncate font-mono text-[11px] text-slate-700" title={latestExecution.model}>
                      {latestExecution.model}
                    </dd>
                  </div>
                ) : null}
                {latestExecution.reasoningEffort ? (
                  <div>
                    <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                      推理强度
                    </dt>
                    <dd className="mt-0.5 text-[11px] font-medium text-slate-700">
                      {reasoningEffortLabel(latestExecution.reasoningEffort)}
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
          </div>
        ) : null}
        <div className="scrollbar-thin max-h-[510px] min-h-72 overflow-y-auto p-4">
          {events.length ? (
            <ol className="space-y-0">
              {events.map((event, index) => (
                <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
                  {index < events.length - 1 ? (
                    <span className="absolute left-[5px] top-4 h-[calc(100%-8px)] w-px bg-slate-200" />
                  ) : null}
                  <span className="relative z-10 mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full border-2 border-white bg-teal-500 ring-1 ring-slate-200" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs leading-5 text-slate-700">{phaseRunEventMessage(event)}</div>
                    <div className="mt-1 flex items-center gap-1 text-[10px] text-slate-400">
                      <Clock3 className="h-3 w-3" aria-hidden />
                      {formatDate(event.createdAt || event.timestamp)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState
              title="等待执行事件"
              description={sessionRoutePending
                ? "正在验证 Agent Session 归属；确认后再显示对应执行上下文。"
                : sessionAudit
                ? "返回 Agent Session 继续后，Provider-native 阶段事件会显示在这里。"
                : "运行这个角色后，Codex 的命令与阶段事件会显示在这里。"}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
