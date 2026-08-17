import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  Eye,
  ExternalLink,
  FileCheck2,
  FileText,
  FlaskConical,
  GitBranch,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  Network,
  Palette,
  Pencil,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  Save,
  TerminalSquare,
  XCircle,
} from "lucide-react";

import { EmptyState, ErrorState, Field, PageSkeleton } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import {
  artifactRevisionByteLength,
  artifactRevisionContentInvalid,
  currentArtifactHeadIds,
  isArtifactHeadsChangedError,
  isArtifactRevisionRefreshError,
} from "@/lib/artifact-review";
import {
  buildFigmaExecutionOptions,
  isCapabilityConfirmed,
  isFigmaRequested,
  reconcileFigmaPlanSelection,
  setFigmaRequested,
} from "@/lib/design-execution-selection";
import {
  defaultFigmaFileName,
  initialPhaseOutputKeys,
  isPhaseOutputLocked,
  isPhaseOutputSelectionComplete,
} from "@/lib/phase-output-selection";
import type {
  Artifact,
  CodexCapabilities,
  CodexReasoningEffort,
  FigmaTarget,
  PhaseDefinition,
  PhaseRun,
  PhaseStatus,
  ReviewDecision,
  RoleDefinition,
  RunEvent,
} from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";
import {
  FALLBACK_PHASES,
  FALLBACK_ROLES,
  STATUS_LABELS,
  artifactLabel,
  getPhaseName,
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
const MarkdownPreview = lazy(() =>
  import("@/components/markdown-preview").then((module) => ({ default: module.MarkdownPreview })),
);
const HtmlPreview = lazy(() =>
  import("@/components/html-preview").then((module) => ({ default: module.HtmlPreview })),
);

const FIGMA_SETUP_URL =
  "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/#codex";
const DESIGN_OUTPUTS = [
  {
    key: "design-baseline",
    description: "项目级设计规则、组件与视觉基准。",
    required: true,
  },
  {
    key: "design-spec",
    description: "可追溯用户故事的交互与工程交付规格。",
    required: true,
  },
  {
    key: "design-prototype",
    description: "用于验证流程与交互的非生产自包含 HTML 原型。",
    required: false,
  },
  {
    key: "figma-handoff",
    description: "在已授权的 Figma 中创建设计，并记录真实文件与节点证据。",
    required: false,
  },
] as const;

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
}

interface ReviewTarget {
  phaseId: string;
  initialArtifactId?: string;
}

export function RunPage({
  runId,
  onBack,
  view,
  ticketId,
  onViewChange,
  onOpenTicket,
  onCloseTicket,
}: {
  runId: string;
  onBack: (projectId?: string) => void;
  view: "workflow" | "tickets";
  ticketId?: string;
  onViewChange: (view: "workflow" | "tickets") => void;
  onOpenTicket: (ticketId: string) => void;
  onCloseTicket: () => void;
}) {
  const [selectedPhaseId, setSelectedPhaseId] = useState<string>();
  const [executeTarget, setExecuteTarget] = useState<ExecuteTarget>();
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget>();
  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.getRun(runId),
    refetchInterval: (query) =>
      query.state.data?.phases?.some((phase) => phase.status === "running") ? 1_500 : false,
  });

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

  const { run, project, definition } = runQuery.data;
  const phases = normalizePhases(runQuery.data.phases, definition?.phases);
  const phaseDefinitions = definition?.phases?.length ? definition.phases : FALLBACK_PHASES;
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
  const approvedCount = phases.filter((phase) => phase.status === "approved").length;
  const progress = Math.round((approvedCount / Math.max(phases.length, 1)) * 100);

  return (
    <div className="space-y-6 animate-fade-up">
      <section>
        <Button variant="ghost" size="sm" className="-ml-2 mb-3" onClick={() => onBack(run.projectId)}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          返回 {project.name}
        </Button>
        <div className="flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant={run.status === "completed" ? "success" : "info"}>
                <GitBranch className="h-3 w-3" aria-hidden />
                {run.status === "completed" ? "交付完成" : "故事工作流"}
              </Badge>
              <span className="text-xs text-slate-400">创建于 {formatDate(run.createdAt)}</span>
            </div>
            <h1 className="text-balance text-2xl font-bold tracking-[-0.025em] text-slate-950 sm:text-3xl">
              {run.title}
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              {run.objective || run.brief || "尚未填写故事目标。"}
            </p>
          </div>
          <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white/80 p-4 shadow-sm backdrop-blur xl:w-80">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-700">整体进度</span>
              <span className="font-bold text-teal-700">{approvedCount} / {phases.length}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-teal-500 to-emerald-500 transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="mt-2 text-[11px] text-slate-400">所有阶段均需人工审核后才算完成</div>
          </div>
        </div>
      </section>

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
            <div className="flex min-h-72 items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white text-sm text-slate-400">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
              正在加载 Ticket 看板…
            </div>
          }
        >
          <TicketBoard
            runId={runId}
            ticketId={ticketId}
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
            selectedPhaseId={selectedPhase?.phaseId}
            onSelect={setSelectedPhaseId}
          />

          {selectedPhase && selectedDefinition && selectedRole ? (
            <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(330px,0.75fr)]">
              <PhasePanel
                phase={selectedPhase}
                definition={selectedDefinition}
                role={selectedRole}
                onExecute={(initialOutputKeys) =>
                  setExecuteTarget({ phaseId: selectedPhase.phaseId, initialOutputKeys })
                }
                onReview={(initialArtifactId) =>
                  setReviewTarget({ phaseId: selectedPhase.phaseId, initialArtifactId })
                }
                onOpenTickets={() => onViewChange("tickets")}
              />
              <EventTimeline phase={selectedPhase} />
            </div>
          ) : null}

          {executePhase ? (
            <ExecuteDialog
              runId={runId}
              runTitle={run.title}
              phase={executePhase}
              initialOutputKeys={executeTarget?.initialOutputKeys}
              definition={
                phaseDefinitions.find((definitionItem) => definitionItem.id === executePhase.phaseId) ??
                FALLBACK_PHASES[0]
              }
              open
              onOpenChange={(open) => !open && setExecuteTarget(undefined)}
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
              open
              onOpenChange={(open) => !open && setReviewTarget(undefined)}
              onRerunArtifact={(artifactKey) => {
                setReviewTarget(undefined);
                setExecuteTarget({
                  phaseId: reviewPhase.phaseId,
                  initialOutputKeys: [artifactKey],
                });
              }}
            />
          ) : null}
        </>
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

function WorkflowBoard({
  phases,
  definitions,
  roles,
  selectedPhaseId,
  onSelect,
}: {
  phases: PhaseRun[];
  definitions: PhaseDefinition[];
  roles: RoleDefinition[];
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
                    {STATUS_LABELS[phase.status] ?? phase.status}
                  </div>
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
  definition,
  role,
  onExecute,
  onReview,
  onOpenTickets,
}: {
  phase: PhaseRun;
  definition: PhaseDefinition;
  role: RoleDefinition;
  onExecute: (initialOutputKeys?: string[]) => void;
  onReview: (initialArtifactId?: string) => void;
  onOpenTickets: () => void;
}) {
  const Icon = roleIcons[role.id] ?? Bot;
  const style = statusStyle[phase.status] ?? statusStyle.pending;
  const canExecute = ["ready", "changes_requested", "rejected", "failed"].includes(phase.status);
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
    && canReviseArtifacts;
  const executionError = phase.executions?.[0]?.error || phase.error;
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
                <Badge variant={style.badge}>{STATUS_LABELS[phase.status]}</Badge>
              </div>
              <p className="mt-1 text-sm font-medium text-teal-700">{role.name}</p>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{role.mission}</p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {canExecute ? (
              <Button variant="primary" onClick={() => onExecute()}>
                {phase.status === "ready" ? <Play className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                {phase.status === "ready" ? `运行 ${role.name}` : "根据反馈重新运行"}
              </Button>
            ) : null}
            {canReview ? (
              <Button variant="default" className="animate-pulse-ring" onClick={() => onReview()}>
                <Eye className="h-4 w-4" aria-hidden />
                审核 AI 产物
              </Button>
            ) : phase.status === "approved" ? (
              <Button variant="outline" onClick={() => onReview()}>
                <FileCheck2 className="h-4 w-4" aria-hidden />
                查看审核记录
              </Button>
            ) : null}
            {canRerun && !canExecute ? (
              <Button variant="outline" onClick={() => onExecute()}>
                <RotateCcw className="h-4 w-4" aria-hidden />
                选择产物重跑
              </Button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-5 sm:p-6">
        {phase.status === "running" ? (
          <div className="mb-5 flex items-center gap-3 rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-sm text-sky-800">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            Codex 正在项目目录中执行。页面会自动刷新状态和终端事件。
          </div>
        ) : null}
        {phase.status === "changes_requested" || phase.status === "rejected" ? (
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
          <ContractBlock title="阶段输入" icon={<ArrowRight />} items={definition.inputs} empty="这是起点，不需要上游产物" />
          <ContractBlock title="预期输出" icon={<FileText />} items={definition.outputs} empty="未注册输出" />
        </div>
        <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            <CheckCircle2 className="h-4 w-4 text-teal-600" aria-hidden />
            人工审核 Gate
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-700">{definition.gate || "人工确认本阶段产物满足交付要求。"}</p>
        </div>

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
                      {!isSuperseded && canReviseArtifacts ? (
                        <Button size="sm" variant="ghost" onClick={() => onExecute([artifactKey])}>
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                          仅重跑此产物
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-xs text-slate-400">
              {phase.status === "running" ? "产物生成后会出现在这里" : "本阶段还没有生成产物"}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
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

function EventTimeline({ phase }: { phase: PhaseRun }) {
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
          <p className="mt-1 text-[11px] text-slate-400">Codex Terminal · 本地事件</p>
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
                    <div className="text-xs leading-5 text-slate-700">{eventMessage(event)}</div>
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
              description="运行这个角色后，Codex 的命令与阶段事件会显示在这里。"
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ExecuteDialog({
  runId,
  runTitle,
  phase,
  definition,
  initialOutputKeys,
  open,
  onOpenChange,
}: {
  runId: string;
  runTitle: string;
  phase: PhaseRun;
  definition: PhaseDefinition;
  initialOutputKeys?: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const candidates = phase.availableArtifacts ?? [];
  const isDesignPhase = phase.phaseId === "design";
  const hasExistingArtifacts = phase.artifacts.some(
    (artifact) => !artifact.superseded && artifact.reviewStatus !== "superseded",
  );
  const outputOptions = definition.outputs.map((key) => {
    const designOutput = DESIGN_OUTPUTS.find((output) => output.key === key);
    return {
      key,
      description: designOutput?.description ?? "此阶段注册的可审核交付产物。",
      downstreamRequired: designOutput?.required ?? false,
    };
  });
  const [selected, setSelected] = useState<string[]>(() => candidates.map((artifact) => artifact.id));
  const [selectedOutputs, setSelectedOutputs] = useState<string[]>(() =>
    initialPhaseOutputKeys({
      phaseId: phase.phaseId,
      availableOutputKeys: definition.outputs,
      hasExistingArtifacts,
      initialOutputKeys,
    }),
  );
  const figmaOutputSelected = isFigmaRequested(selectedOutputs);
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<CodexReasoningEffort | "">("");
  const [figmaTargetMode, setFigmaTargetMode] = useState<FigmaTarget["mode"]>(
    "new_private_draft",
  );
  const [figmaPlanKey, setFigmaPlanKey] = useState("");
  const [figmaFileName, setFigmaFileName] = useState(() => defaultFigmaFileName(runTitle));
  const [figmaFileUrl, setFigmaFileUrl] = useState("");
  const [error, setError] = useState<string>();
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: api.getHealth,
    enabled: open,
    staleTime: 10_000,
  });
  const runnerMode = healthQuery.data?.runner.mode;
  const capabilitiesQuery = useQuery({
    queryKey: ["codex", "capabilities", runId],
    queryFn: () => api.getCodexCapabilities(runId),
    enabled: open && runnerMode === "real",
    staleTime: 10_000,
    retry: 1,
  });
  const figmaQueryKey = ["integration", "figma", runId] as const;
  const figmaQuery = useQuery({
    queryKey: figmaQueryKey,
    queryFn: () => api.getFigmaIntegration(runId),
    enabled: open && isDesignPhase && figmaOutputSelected,
    staleTime: 10_000,
    retry: 1,
  });
  const figmaRefreshMutation = useMutation({
    mutationFn: () => api.getFigmaIntegration(runId, { force: true }),
    onSuccess: (status) => queryClient.setQueryData(figmaQueryKey, status),
  });
  const figmaReady = isCapabilityConfirmed({
    dataReady: runnerMode === "real" && figmaQuery.data?.state === "ready",
    isFetching: figmaQuery.isFetching,
    isError: figmaQuery.isError,
    refreshPending: figmaRefreshMutation.isPending,
    refreshError: figmaRefreshMutation.isError,
  });
  const figmaPlansQueryKey = ["integration", "figma", "plans", runId] as const;
  const figmaPlansQuery = useQuery({
    queryKey: figmaPlansQueryKey,
    queryFn: () => api.getFigmaPlans(runId),
    enabled:
      open
      && isDesignPhase
      && figmaOutputSelected
      && runnerMode === "real"
      && figmaTargetMode === "new_private_draft"
      && figmaReady,
    staleTime: 10_000,
    retry: 1,
  });
  const figmaPlansRefreshMutation = useMutation({
    mutationFn: () => api.getFigmaPlans(runId, { force: true }),
    onSuccess: (plans) => queryClient.setQueryData(figmaPlansQueryKey, plans),
  });
  const isFigmaDetecting = figmaQuery.isFetching || figmaRefreshMutation.isPending;
  const hasFigmaDetectionError = figmaQuery.isError || figmaRefreshMutation.isError;
  const figmaPlans = useMemo(
    () => figmaPlansQuery.data?.plans ?? [],
    [figmaPlansQuery.data?.plans],
  );
  const writableFigmaPlans = useMemo(
    () => figmaPlans.filter((plan) => plan.writable),
    [figmaPlans],
  );
  const figmaPlansConfirmed = isCapabilityConfirmed({
    dataReady: figmaPlansQuery.isSuccess,
    isFetching: figmaPlansQuery.isFetching,
    isError: figmaPlansQuery.isError,
    refreshPending: figmaPlansRefreshMutation.isPending,
    refreshError: figmaPlansRefreshMutation.isError,
  });
  const trimmedFigmaFileName = figmaFileName.trim();
  const trimmedFigmaFileUrl = figmaFileUrl.trim();
  const selectedFigmaPlan = figmaPlans.find((plan) => plan.key === figmaPlanKey);
  const hasWritableFigmaPlan = selectedFigmaPlan?.writable === true;
  const hasValidExistingFigmaUrl = isOfficialFigmaFileUrl(trimmedFigmaFileUrl);
  const figmaTarget: FigmaTarget | undefined =
    figmaTargetMode === "new_private_draft"
      ? hasWritableFigmaPlan && trimmedFigmaFileName
        ? {
            mode: "new_private_draft",
            planKey: figmaPlanKey,
            fileName: trimmedFigmaFileName,
          }
        : undefined
      : hasValidExistingFigmaUrl
        ? { mode: "existing_file", fileUrl: trimmedFigmaFileUrl }
        : undefined;
  const figmaExecutionOptions = buildFigmaExecutionOptions({
    selectedOutputKeys: selectedOutputs,
    figmaIntegrationReady:
      figmaReady
      && (figmaTargetMode === "existing_file" || figmaPlansConfirmed),
    figmaTarget,
  });
  const figmaExecutionReady = figmaOutputSelected && figmaExecutionOptions.valid;
  const isFigmaPlanLoading =
    figmaTargetMode === "new_private_draft"
    && (figmaPlansQuery.isFetching || figmaPlansRefreshMutation.isPending);
  const hasFigmaPlanError =
    figmaTargetMode === "new_private_draft"
    && (figmaPlansQuery.isError || figmaPlansRefreshMutation.isError);
  const figmaAuthorizationUrl = safeHttpUrl(figmaQuery.data?.authorizationUrl) ?? FIGMA_SETUP_URL;
  const capabilities = capabilitiesQuery.data;
  const selectedModel =
    capabilities?.models.some((item) => item.id === model) === true
      ? model
      : capabilities?.defaultModel ?? "";
  const selectedModelCapability = capabilities?.models.find((item) => item.id === selectedModel);
  const defaultReasoningEffort = defaultEffortForModel(capabilities, selectedModel);
  const selectedReasoningEffort =
    reasoningEffort && selectedModelCapability?.reasoningEfforts.includes(reasoningEffort)
      ? reasoningEffort
      : defaultReasoningEffort;
  const usesDefaultCodexConfiguration = Boolean(
    capabilities
      && selectedModel === capabilities.defaultModel
      && selectedReasoningEffort === capabilities.defaultReasoningEffort,
  );
  const hasResolvedCodexConfiguration = Boolean(selectedModel && selectedReasoningEffort);
  useEffect(() => {
    setFigmaPlanKey((current) =>
      reconcileFigmaPlanSelection(current, figmaPlans, figmaPlansConfirmed),
    );
  }, [figmaPlans, figmaPlansConfirmed]);
  const mutation = useMutation({
    mutationFn: () => {
      if (!figmaExecutionOptions.valid) {
        throw new Error(
          figmaExecutionOptions.reason === "FIGMA_INTEGRATION_NOT_READY"
            ? "Figma 授权或连接尚未就绪"
            : "请先完整配置 Figma 写入目标",
        );
      }
      return api.executePhase(runId, phase.phaseId, selected, selectedOutputs, {
        ...(selectedModel && selectedReasoningEffort
          ? { model: selectedModel, reasoningEffort: selectedReasoningEffort }
          : {}),
        ...figmaExecutionOptions.options,
      });
    },
    onMutate: () => setError(undefined),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      onOpenChange(false);
    },
    onError: (mutationError) =>
      setError(mutationError instanceof Error ? mutationError.message : "无法启动 Codex"),
  });
  const requiredKeys = new Set(definition.inputs);
  const selectedKeys = new Set(
    candidates
      .filter((artifact) => selected.includes(artifact.id))
      .map((artifact) => keyForArtifact(artifact)),
  );
  const hasAllRequiredInputs = definition.inputs.every((key) => selectedKeys.has(key));
  const hasAllRequiredOutputs = isPhaseOutputSelectionComplete({
    phaseId: phase.phaseId,
    availableOutputKeys: definition.outputs,
    selectedOutputKeys: selectedOutputs,
    hasExistingArtifacts,
  });
  const hasUnsupportedFigmaOutput = !figmaExecutionOptions.valid;
  const canUseSelectedCodexConfiguration =
    runnerMode !== "real" || hasResolvedCodexConfiguration;

  const selectModel = (nextModel: string) => {
    setModel(nextModel);
    const nextCapability = capabilities?.models.find((item) => item.id === nextModel);
    if (!nextCapability) return;
    setReasoningEffort((current) =>
      current && nextCapability.reasoningEfforts.includes(current)
        ? current
        : defaultEffortForModel(capabilities, nextModel),
    );
  };

  const toggleOutput = (key: string) => {
    if (mutation.isPending) return;
    if (isPhaseOutputLocked({
      phaseId: phase.phaseId,
      outputKey: key,
      hasExistingArtifacts,
    })) return;
    if (key === "figma-handoff") {
      setSelectedOutputs((current) =>
        setFigmaRequested(current, !isFigmaRequested(current)),
      );
      return;
    }
    setSelectedOutputs((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (mutation.isPending && !nextOpen) return;
        onOpenChange(nextOpen);
      }}
      title={`运行 · ${getPhaseName(definition)}`}
      description="选择 Codex 本次可以使用的上游产物，以及需要交付的阶段输出。"
      className="max-w-2xl"
    >
      <fieldset
        disabled={mutation.isPending}
        aria-busy={mutation.isPending}
        className="m-0 min-w-0 overflow-y-auto border-0 p-6"
      >
        <div className="rounded-xl border border-slate-200 bg-slate-950 p-4 text-slate-100">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <TerminalSquare className="h-4 w-4 text-teal-300" aria-hidden />
              Codex Terminal
            </div>
            <Badge variant={runnerMode === "fake" ? "warning" : runnerMode === "real" ? "success" : "muted"}>
              {runnerMode === "fake" ? "模拟执行" : runnerMode === "real" ? "真实执行" : "检测中"}
            </Badge>
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-400">
            {runnerMode === "fake"
              ? "当前服务处于 Fake 模式，只会生成模拟产物，不会调用 Codex。"
              : runnerMode === "real"
                ? "Codex CLI 会在项目根目录真实执行当前角色任务。平台负责阶段边界、输入选择与审核。"
                : healthQuery.isError
                  ? "无法确认服务运行模式，请检查本地 API 后重试。"
                  : "正在确认本地 API 的 Codex 运行模式…"}
          </p>
        </div>

        <section className="mt-5" aria-labelledby="codex-execution-settings-title">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 id="codex-execution-settings-title" className="text-sm font-semibold text-slate-900">
                本次 Codex 配置
              </h3>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                默认选中当前 Run 的有效配置；你可以只为这一次执行调整它。
              </p>
            </div>
            <Badge variant={usesDefaultCodexConfiguration ? "muted" : capabilities ? "info" : "muted"}>
              {runnerMode === "fake"
                ? "模拟模式不适用"
                : !capabilities
                  ? "读取中"
                  : usesDefaultCodexConfiguration
                    ? "当前默认"
                    : "本次自定义"}
            </Badge>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block min-w-0">
              <span className="text-xs font-semibold text-slate-700">模型</span>
              <select
                value={selectedModel}
                disabled={runnerMode !== "real" || !capabilities}
                onChange={(event) => selectModel(event.target.value)}
                aria-describedby="codex-model-help"
                className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-teal-400 focus:ring-2 focus:ring-teal-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
              >
                {!capabilities ? <option value="">等待读取可用模型</option> : null}
                {(capabilities?.models ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name === item.id ? item.id : `${item.name}（${item.id}）`}
                  </option>
                ))}
              </select>
              <span id="codex-model-help" className="mt-1.5 block text-[11px] leading-4 text-slate-400">
                {capabilities ? `当前 Run 默认：${capabilities.defaultModel}` : "由服务端读取 Codex 可用模型"}
              </span>
            </label>

            <label className="block min-w-0">
              <span className="text-xs font-semibold text-slate-700">Reasoning effort</span>
              <select
                value={selectedReasoningEffort}
                disabled={runnerMode !== "real" || !selectedModelCapability}
                onChange={(event) =>
                  setReasoningEffort(event.target.value as CodexReasoningEffort)
                }
                aria-describedby="codex-reasoning-help"
                className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-teal-400 focus:ring-2 focus:ring-teal-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
              >
                {!selectedModelCapability ? <option value="">等待读取推理强度</option> : null}
                {(selectedModelCapability?.reasoningEfforts ?? []).map((item) => (
                  <option key={item} value={item}>
                    {reasoningEffortLabel(item)}
                  </option>
                ))}
              </select>
              <span id="codex-reasoning-help" className="mt-1.5 block text-[11px] leading-4 text-slate-400">
                {selectedModelCapability
                  ? `该模型默认：${reasoningEffortLabel(selectedModelCapability.defaultReasoningEffort)}`
                  : "切换模型时会自动校正为它支持的强度"}
              </span>
            </label>
          </div>

          <div
            className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-xs leading-5 text-slate-600"
            aria-live="polite"
          >
            {runnerMode === "fake" ? (
              "模拟执行不会调用模型，因此本次不能覆盖模型或推理强度。"
            ) : runnerMode !== "real" ? (
              "正在确认 Runner 与 Codex 配置…"
            ) : capabilitiesQuery.isLoading ? (
              <span className="inline-flex items-center gap-2">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
                正在读取可用模型与默认配置…
              </span>
            ) : capabilitiesQuery.isError ? (
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span>暂时无法读取当前 Run 的模型能力，真实 Codex 执行已暂停。</span>
                <button
                  type="button"
                  disabled={capabilitiesQuery.isFetching}
                  onClick={() => void capabilitiesQuery.refetch()}
                  className="inline-flex items-center gap-1 font-semibold text-teal-700 hover:text-teal-800 disabled:opacity-50"
                >
                  <RefreshCw
                    className={cn("h-3.5 w-3.5", capabilitiesQuery.isFetching && "animate-spin")}
                    aria-hidden
                  />
                  重新读取
                </button>
              </span>
            ) : (
              <>
                本次将使用模型
                <strong className="mx-1 font-mono text-slate-800">
                  {selectedModel}
                </strong>
                ，推理强度
                <strong className="mx-1 text-slate-800">
                  {selectedReasoningEffort
                    ? reasoningEffortLabel(selectedReasoningEffort)
                    : "等待解析"}
                </strong>
                。执行时会显式传入并记录这组实际配置。
              </>
            )}
          </div>
        </section>

        <div className="mt-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">上游审核产物</h3>
            {candidates.length ? (
              <button
                type="button"
                className="text-xs font-medium text-teal-700 hover:text-teal-800"
                onClick={() =>
                  setSelected((current) =>
                    current.length === candidates.length ? [] : candidates.map((artifact) => artifact.id),
                  )
                }
              >
                {selected.length === candidates.length ? "取消全选" : "全选"}
              </button>
            ) : null}
          </div>
          {candidates.length ? (
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {candidates.map((artifact) => {
                const key = keyForArtifact(artifact);
                const checked = selected.includes(artifact.id);
                const required = requiredKeys.has(key);
                return (
                  <div
                    key={artifact.id}
                    onClick={() => {
                      if (mutation.isPending) return;
                      setSelected((current) =>
                        current.includes(artifact.id)
                          ? current.filter((id) => id !== artifact.id)
                          : [...current, artifact.id],
                      );
                    }}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition",
                      checked ? "border-teal-200 bg-teal-50/60" : "border-slate-200 bg-white hover:bg-slate-50",
                      mutation.isPending && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={mutation.isPending}
                      onCheckedChange={() => {
                        if (mutation.isPending) return;
                        setSelected((current) =>
                          current.includes(artifact.id)
                            ? current.filter((id) => id !== artifact.id)
                            : [...current, artifact.id],
                        );
                      }}
                      aria-label={`选择 ${artifactLabel(key)}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                        {artifactLabel(key)}
                        {required ? <Badge variant="info">阶段输入</Badge> : null}
                      </span>
                      <span className="mt-1 block truncate font-mono text-[10px] text-slate-400">
                        {artifact.filePath || artifact.path || key}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-7 text-center text-xs leading-5 text-slate-500">
              {definition.inputs.length
                ? "暂时没有可用的上游产物。只有审核通过的产物才会出现在这里。"
                : "这是第一个阶段，不需要选择上游产物。"}
            </div>
          )}
        </div>

        <div className="mt-6 border-t border-slate-100 pt-5">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-slate-900">本次预期输出</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {hasExistingArtifacts
                ? "已有阶段产物，可只选择需要调整的局部范围；未选择的产物会保持不变。"
                : isDesignPhase
                  ? "首次设计执行必须包含设计基线和设计规格，HTML 原型与 Figma 可按需追加。"
                  : "首次执行需要生成本阶段的全部注册产物。"}
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
              {outputOptions.map((output) => {
                const checked = selectedOutputs.includes(output.key);
                const isFigma = output.key === "figma-handoff";
                const locked = isPhaseOutputLocked({
                  phaseId: phase.phaseId,
                  outputKey: output.key,
                  hasExistingArtifacts,
                });
                const disabled = locked || mutation.isPending;
                return (
                  <div
                    key={output.key}
                    onClick={() => !disabled && toggleOutput(output.key)}
                    className={cn(
                      "flex items-start gap-3 rounded-xl border p-3.5 text-left transition",
                      checked ? "border-teal-200 bg-teal-50/60" : "border-slate-200 bg-white",
                      disabled ? "cursor-default" : "cursor-pointer hover:bg-slate-50",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={disabled}
                      onCheckedChange={() => toggleOutput(output.key)}
                      aria-label={locked
                        ? `${artifactLabel(output.key)}（必选，已锁定）`
                        : `${checked ? "取消" : "选择"} ${artifactLabel(output.key)}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                        {artifactLabel(output.key)}
                        {output.downstreamRequired ? <Badge variant="info">后续阶段必需</Badge> : null}
                        {locked && !output.downstreamRequired ? <Badge variant="muted">首次执行必需</Badge> : null}
                        {isFigma && figmaOutputSelected && figmaReady ? (
                          <Badge variant="success">连接已授权</Badge>
                        ) : null}
                        {isFigma && figmaOutputSelected && figmaExecutionReady ? (
                          <Badge variant="info">写入目标已就绪</Badge>
                        ) : null}
                        {isFigma && figmaOutputSelected && figmaReady && !figmaExecutionReady ? (
                          <Badge variant="warning">待选择写入目标</Badge>
                        ) : null}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-slate-500">
                        {output.description}
                      </span>
                    </span>
                  </div>
                );
              })}
          </div>

            {isDesignPhase && figmaOutputSelected ? (
              figmaReady ? (
                <div
                  className="mt-3 rounded-xl border border-teal-200 bg-teal-50/50 px-4 py-4"
                  aria-labelledby="figma-target-title"
                >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h4 id="figma-target-title" className="text-xs font-semibold text-slate-900">
                      Figma 写入目标
                    </h4>
                    <p className="mt-1 text-xs leading-5 text-slate-600">
                      已选择交付 Figma 设计。请指定真实写入目标；目标完整前不会启动执行。
                    </p>
                  </div>
                  <Badge variant={figmaExecutionReady ? "success" : "warning"}>
                    {figmaExecutionReady ? "目标完整" : "需要配置"}
                  </Badge>
                </div>

                <fieldset className="mt-3">
                  <legend className="sr-only">选择 Figma 写入方式</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="cursor-pointer">
                      <input
                        type="radio"
                        name={`figma-target-${phase.phaseId}`}
                        value="new_private_draft"
                        checked={figmaTargetMode === "new_private_draft"}
                        onChange={() => setFigmaTargetMode("new_private_draft")}
                        className="peer sr-only"
                      />
                      <span
                        className={cn(
                          "block rounded-xl border bg-white px-3.5 py-3 transition peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2",
                          figmaTargetMode === "new_private_draft"
                            ? "border-teal-400 ring-1 ring-teal-200"
                            : "border-slate-200 hover:border-slate-300",
                        )}
                      >
                        <span className="block text-xs font-semibold text-slate-900">
                          新建私人 Draft
                        </span>
                        <span className="mt-1 block text-[11px] leading-4 text-slate-500">
                          在所选账号计划下创建新的私人草稿
                        </span>
                      </span>
                    </label>
                    <label className="cursor-pointer">
                      <input
                        type="radio"
                        name={`figma-target-${phase.phaseId}`}
                        value="existing_file"
                        checked={figmaTargetMode === "existing_file"}
                        onChange={() => setFigmaTargetMode("existing_file")}
                        className="peer sr-only"
                      />
                      <span
                        className={cn(
                          "block rounded-xl border bg-white px-3.5 py-3 transition peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2",
                          figmaTargetMode === "existing_file"
                            ? "border-teal-400 ring-1 ring-teal-200"
                            : "border-slate-200 hover:border-slate-300",
                        )}
                      >
                        <span className="block text-xs font-semibold text-slate-900">
                          更新已有文件
                        </span>
                        <span className="mt-1 block text-[11px] leading-4 text-slate-500">
                          使用你有编辑权限的官方 Figma 文件 URL
                        </span>
                      </span>
                    </label>
                  </div>
                </fieldset>

                {figmaTargetMode === "new_private_draft" ? (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="block min-w-0">
                      <span className="text-xs font-semibold text-slate-700">账号计划</span>
                      <select
                        value={figmaPlanKey}
                        disabled={
                          figmaPlansQuery.isFetching
                          || figmaPlansRefreshMutation.isPending
                          || figmaPlans.length === 0
                        }
                        required
                        aria-required="true"
                        onChange={(event) => setFigmaPlanKey(event.target.value)}
                        aria-describedby="figma-plan-help"
                        className="mt-1.5 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
                      >
                        <option value="">
                          {isFigmaPlanLoading ? "正在读取账号计划…" : "请选择可写计划"}
                        </option>
                        {figmaPlans.map((plan) => (
                          <option key={plan.key} value={plan.key} disabled={!plan.writable}>
                            {plan.name} · {plan.tier} · {plan.seat}
                            {plan.writable ? "" : "（只读）"}
                          </option>
                        ))}
                      </select>
                      <span id="figma-plan-help" className="mt-1.5 block text-[11px] leading-4 text-slate-500">
                        {writableFigmaPlans.length > 1 && !figmaPlanKey
                          ? `检测到 ${writableFigmaPlans.length} 个可写计划，请明确选择；平台不会替你猜。`
                          : selectedFigmaPlan
                            ? `${selectedFigmaPlan.name} · ${selectedFigmaPlan.tier} · ${selectedFigmaPlan.seat}`
                            : "View 等只读席位会显示但不能选择。"}
                      </span>
                    </label>

                    <label className="block min-w-0">
                      <span className="text-xs font-semibold text-slate-700">新文件名称</span>
                      <Input
                        value={figmaFileName}
                        maxLength={160}
                        required
                        aria-required="true"
                        autoComplete="off"
                        onChange={(event) => setFigmaFileName(event.target.value)}
                        aria-describedby="figma-file-name-help"
                        aria-invalid={!trimmedFigmaFileName}
                        className="mt-1.5"
                      />
                      <span id="figma-file-name-help" className="mt-1.5 block text-[11px] leading-4 text-slate-500">
                        文件会创建到私人 Draft，不会自动加入团队项目。
                      </span>
                    </label>
                </div>
              ) : (
                  <label className="mt-4 block">
                    <span className="text-xs font-semibold text-slate-700">Figma 文件 URL</span>
                    <Input
                      type="url"
                      inputMode="url"
                      value={figmaFileUrl}
                      maxLength={2_048}
                      required
                      aria-required="true"
                      placeholder="https://www.figma.com/design/FILE_KEY/文件名"
                      autoComplete="off"
                      onChange={(event) => setFigmaFileUrl(event.target.value)}
                      aria-describedby="figma-file-url-help"
                      aria-invalid={Boolean(trimmedFigmaFileUrl && !hasValidExistingFigmaUrl)}
                      className="mt-1.5 font-mono text-xs"
                    />
                    <span
                      id="figma-file-url-help"
                      className={cn(
                        "mt-1.5 block text-[11px] leading-4",
                        trimmedFigmaFileUrl && !hasValidExistingFigmaUrl
                          ? "text-rose-600"
                          : "text-slate-500",
                      )}
                    >
                      {trimmedFigmaFileUrl && !hasValidExistingFigmaUrl
                        ? "请输入官方 https://figma.com/design/... 或 /file/... 文件地址。"
                        : "Codex 只会更新这个文件；仍会在执行后校验真实写入证据。"}
                    </span>
                  </label>
                )}

                <div
                  className={cn(
                    "mt-3 rounded-lg border px-3 py-2.5 text-xs leading-5",
                    figmaExecutionReady
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : hasFigmaPlanError
                        ? "border-rose-200 bg-rose-50 text-rose-700"
                        : "border-amber-200 bg-amber-50 text-amber-800",
                  )}
                  aria-live="polite"
                >
                  {isFigmaPlanLoading ? (
                    <span className="inline-flex items-center gap-2">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      正在读取 Figma 账号和计划…
                    </span>
                  ) : hasFigmaPlanError ? (
                    "未能读取 Figma 账号计划；在验证成功前不会启动 Figma 写入。"
                  ) : !writableFigmaPlans.length && figmaTargetMode === "new_private_draft" ? (
                    "当前账号没有可写计划。可以切换到“更新已有文件”，或检查 Figma 席位权限。"
                  ) : figmaExecutionReady ? (
                    <span className="inline-flex items-center gap-2 font-semibold">
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                      真实写入目标已就绪，本次会交付 Figma 设计。
                    </span>
                  ) : figmaTargetMode === "new_private_draft" ? (
                    "请选择可写计划并填写文件名。"
                  ) : (
                    "请粘贴有效的官方 Figma 文件 URL。"
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  {figmaTargetMode === "new_private_draft" ? (
                    <button
                      type="button"
                      disabled={figmaPlansQuery.isFetching || figmaPlansRefreshMutation.isPending}
                      onClick={() => figmaPlansRefreshMutation.mutate()}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-teal-800 hover:text-teal-600 disabled:opacity-50"
                    >
                      <RefreshCw
                        className={cn(
                          "h-3.5 w-3.5",
                          (figmaPlansQuery.isFetching || figmaPlansRefreshMutation.isPending)
                            && "animate-spin",
                        )}
                        aria-hidden
                      />
                      重新读取账号计划
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedOutputs((current) =>
                        current.includes("design-prototype")
                          ? current
                          : [...current, "design-prototype"],
                      )
                    }
                    className="text-xs font-semibold text-teal-800 underline decoration-teal-300 underline-offset-4 hover:text-teal-600"
                  >
                    同时交付 HTML 原型
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold">
                      {isFigmaDetecting
                        ? "正在检测 Figma 授权…"
                        : runnerMode === "fake"
                          ? "Figma 需要真实 Codex Runner"
                        : hasFigmaDetectionError
                          ? "无法确认 Figma 是否已授权"
                          : figmaQuery.data?.state === "authorization_required"
                            ? "Figma MCP 尚未授权"
                            : figmaQuery.data?.state === "unavailable"
                              ? "Figma MCP 当前不可用"
                              : "尚未配置 Figma MCP"}
                    </p>
                    {!figmaReady && !isFigmaDetecting && !hasFigmaDetectionError && figmaQuery.data?.message ? (
                      <p className="mt-1 text-xs leading-5 text-amber-800">
                        {figmaQuery.data.message}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs leading-5 text-amber-800">
                      {runnerMode === "fake"
                        ? "Figma 已加入本次交付；请先将服务切换到 Real 模式，完成前不会启动执行。"
                        : "Figma 已加入本次交付；完成授权或重新检测前不会启动执行。"}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedOutputs((current) =>
                            setFigmaRequested(
                              current.includes("design-prototype")
                                ? current
                                : [...current, "design-prototype"],
                              false,
                            ),
                          )
                        }
                        className="inline-flex items-center gap-1 text-xs font-semibold text-amber-900 underline decoration-amber-400 underline-offset-4 hover:text-amber-700"
                      >
                        改为只交付 HTML 原型
                      </button>
                      {runnerMode !== "fake" && !figmaReady ? (
                        <a
                          href={figmaAuthorizationUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-amber-900 underline decoration-amber-400 underline-offset-4 hover:text-amber-700"
                        >
                          查看授权指引
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                        </a>
                      ) : null}
                      {!figmaReady ? (
                        <button
                          type="button"
                          disabled={figmaQuery.isFetching || figmaRefreshMutation.isPending}
                          onClick={() => figmaRefreshMutation.mutate()}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-amber-900 hover:text-amber-700 disabled:opacity-50"
                        >
                          <RefreshCw
                            className={cn(
                              "h-3.5 w-3.5",
                              (figmaQuery.isFetching || figmaRefreshMutation.isPending) && "animate-spin",
                            )}
                            aria-hidden
                          />
                          重新检测
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
                </div>
              )
            ) : null}

          <div
              className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3.5"
              aria-labelledby="delivery-summary-title"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="delivery-summary-title" className="text-sm font-semibold text-slate-900">
                  本次将交付
                </h3>
                <Badge variant="muted">{selectedOutputs.length} 项产物</Badge>
              </div>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {selectedOutputs.map((key) => (
                  <li
                    key={key}
                    className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-xs text-slate-700 ring-1 ring-slate-200"
                  >
                    <span className="inline-flex min-w-0 items-center gap-2 font-semibold">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-teal-600" aria-hidden />
                      <span className="truncate">{artifactLabel(key)}</span>
                    </span>
                    {key === "figma-handoff" ? (
                      <Badge variant={figmaExecutionReady ? "success" : "warning"}>
                        {figmaExecutionReady ? "目标已就绪" : "目标未就绪"}
                      </Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
              {isDesignPhase && figmaOutputSelected ? (
                <p
                  className={cn(
                    "mt-3 text-xs leading-5",
                    figmaExecutionReady ? "text-emerald-700" : "text-amber-700",
                  )}
                  aria-live="polite"
                >
                  {figmaExecutionReady
                    ? figmaTargetMode === "new_private_draft"
                      ? `Figma：新建私人 Draft · ${selectedFigmaPlan?.name ?? "已选计划"} · ${trimmedFigmaFileName}`
                      : "Figma：更新已指定文件 · 写入目标已验证"
                    : isFigmaDetecting
                      ? "Figma：正在检测授权，检测完成且目标完整后才能启动。"
                      : !figmaReady
                        ? "Figma：授权或连接尚未就绪，当前不能启动。"
                        : "Figma：写入目标尚未完整，当前不能启动。"}
                </p>
              ) : null}
          </div>
        </div>
        {error ? (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-700">
            {error}
          </div>
        ) : null}
        <div className="mt-6 flex justify-end gap-3 border-t border-slate-100 pt-5">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
            disabled={
              !hasAllRequiredInputs
              || !hasAllRequiredOutputs
              || hasUnsupportedFigmaOutput
              || !canUseSelectedCodexConfiguration
              || !runnerMode
            }
          >
            <Play className="h-4 w-4" aria-hidden />
            {runnerMode === "fake"
              ? "启动模拟执行"
              : runnerMode === "real"
                ? "启动真实 Codex"
                : "检测运行模式"}
          </Button>
        </div>
      </fieldset>
    </Dialog>
  );
}

function ReviewDialog({
  runId,
  phase,
  definition,
  initialArtifactId,
  open,
  onOpenChange,
  onRerunArtifact,
}: {
  runId: string;
  phase: PhaseRun;
  definition: PhaseDefinition;
  initialArtifactId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRerunArtifact: (artifactKey: string) => void;
}) {
  const queryClient = useQueryClient();
  const preservedDraftRef = useRef<{
    artifactId: string;
    content: string;
  }>();
  const [selectedArtifactId, setSelectedArtifactId] = useState(
    initialArtifactId ?? phase.artifacts[0]?.id ?? "",
  );
  const [artifactView, setArtifactView] = useState<"preview" | "edit">("preview");
  const [draftContent, setDraftContent] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string>();
  const [revisionError, setRevisionError] = useState<string>();
  const [reviewConflict, setReviewConflict] = useState<string>();
  const selectedSummary = phase.artifacts.find((artifact) => artifact.id === selectedArtifactId);
  const artifactQuery = useQuery({
    queryKey: ["artifact", selectedArtifactId],
    queryFn: () => api.getArtifact(selectedArtifactId),
    enabled: Boolean(selectedArtifactId),
  });
  const artifact = artifactQuery.data ?? selectedSummary;
  const content = artifact?.content;
  const artifactKey = artifact ? keyForArtifact(artifact) : "";
  const artifactPath = artifact?.filePath || artifact?.path || "";
  const isHtmlArtifact =
    artifactKey === "design-prototype" || /\.(?:html?|xhtml)$/iu.test(artifactPath);
  const isSuperseded = artifact?.superseded || artifact?.reviewStatus === "superseded";
  const isDirty = typeof content === "string" && draftContent !== content;
  const revisionByteLength = artifactRevisionByteLength(draftContent);
  const revisionContentInvalid = artifactRevisionContentInvalid(draftContent);
  const canEdit =
    typeof content === "string"
    && Boolean(artifact?.contentHash)
    && !isSuperseded
    && [
      "ready",
      "awaiting_review",
      "approved",
      "changes_requested",
      "rejected",
      "failed",
    ].includes(phase.status);
  const canRerunArtifact =
    Boolean(artifactKey)
    && !isSuperseded
    && [
      "ready",
      "awaiting_review",
      "approved",
      "changes_requested",
      "rejected",
      "failed",
    ].includes(phase.status);

  useEffect(() => {
    const preservedDraft = preservedDraftRef.current;
    if (preservedDraft?.artifactId === selectedArtifactId) {
      setDraftContent(preservedDraft.content);
      setArtifactView("edit");
      setRevisionError(undefined);
      if (
        artifactQuery.data?.id === selectedArtifactId
        && typeof artifactQuery.data.content === "string"
      ) {
        preservedDraftRef.current = undefined;
      }
      return;
    }
    setDraftContent(content ?? "");
    setArtifactView("preview");
    setRevisionError(undefined);
  }, [selectedArtifactId, artifact?.contentHash, artifactQuery.data, content]);

  const revisionMutation = useMutation({
    mutationFn: (variables: {
      artifactId: string;
      nextContent: string;
      expectedContentHash: string;
      artifactKey: string;
    }) => api.createArtifactRevision(variables.artifactId, {
      content: variables.nextContent,
      expectedContentHash: variables.expectedContentHash,
    }),
    onMutate: () => setRevisionError(undefined),
    onSuccess: async (revision, variables) => {
      const hydratedRevision = {
        ...revision,
        content: revision.content ?? variables.nextContent,
      };
      queryClient.setQueryData(["artifact", revision.id], hydratedRevision);
      setSelectedArtifactId(revision.id);
      setDraftContent(hydratedRevision.content);
      setArtifactView("preview");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["artifact", variables.artifactId] }),
        queryClient.invalidateQueries({ queryKey: ["run", runId] }),
      ]);
    },
    onError: async (mutationError, variables) => {
      if (!isArtifactRevisionRefreshError(mutationError)) {
        setRevisionError(
          mutationError instanceof Error ? mutationError.message : "保存人工修订失败",
        );
        return;
      }

      const conflictCode = (mutationError as { code?: string }).code;
      const preservedDraft = variables.nextContent;
      try {
        const refreshedRun = await api.getRun(runId);
        queryClient.setQueryData(["run", runId], refreshedRun);
        const refreshedPhase = refreshedRun.phases.find(
          (candidate) => candidate.phaseId === phase.phaseId,
        );
        const refreshedArtifact = refreshedPhase?.artifacts.find(
          (candidate) =>
            !candidate.superseded
            && candidate.reviewStatus !== "superseded"
            && keyForArtifact(candidate) === variables.artifactKey,
        );

        if (!refreshedArtifact) {
          setRevisionError(
            "检测到产物冲突，但未找到同类型的最新 head。你的编辑草稿仍已保留，请刷新后比较。",
          );
          return;
        }

        preservedDraftRef.current = {
          artifactId: refreshedArtifact.id,
          content: preservedDraft,
        };
        setSelectedArtifactId(refreshedArtifact.id);
        await queryClient.fetchQuery({
          queryKey: ["artifact", refreshedArtifact.id],
          queryFn: () => api.getArtifact(refreshedArtifact.id),
        });
        setRevisionError(
          conflictCode === "ARTIFACT_WORKSPACE_DIVERGED"
            ? "工作区文件与当前审核快照已经分叉。已刷新最新 head 和内容，且未覆盖你的草稿；请比较后再保存。"
            : "产物已产生更新的 revision。已刷新最新 head 和内容，且未覆盖你的草稿；请比较后再保存。",
        );
      } catch (refreshError) {
        setRevisionError(
          `检测到产物冲突，但自动刷新失败：${
            refreshError instanceof Error ? refreshError.message : "请稍后重试"
          }。你的编辑草稿仍已保留。`,
        );
        await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      }
    },
  });
  const reviewMutation = useMutation({
    mutationFn: ({
      decision,
      expectedArtifactIds,
    }: {
      decision: ReviewDecision;
      expectedArtifactIds: string[];
    }) => api.reviewPhase(
      runId,
      phase.phaseId,
      decision,
      comment.trim(),
      expectedArtifactIds,
    ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      onOpenChange(false);
    },
    onError: async (mutationError) => {
      if (!isArtifactHeadsChangedError(mutationError)) {
        setError(mutationError instanceof Error ? mutationError.message : "提交审核失败");
        return;
      }

      setError(undefined);
      setReviewConflict(
        "审核期间产物已更新。已刷新到最新 revision，请重新审阅后再次提交；你的审核意见和编辑草稿已保留。",
      );
      const currentArtifactKey = artifactKey;
      const draftToPreserve = artifactView === "edit" ? draftContent : undefined;

      try {
        const refreshedRun = await api.getRun(runId);
        queryClient.setQueryData(["run", runId], refreshedRun);
        const refreshedPhase = refreshedRun.phases.find(
          (candidate) => candidate.phaseId === phase.phaseId,
        );
        const refreshedHeads = refreshedPhase?.artifacts.filter(
          (candidate) => !candidate.superseded && candidate.reviewStatus !== "superseded",
        ) ?? [];
        const refreshedArtifact =
          refreshedHeads.find((candidate) => keyForArtifact(candidate) === currentArtifactKey)
          ?? refreshedHeads[0];

        if (refreshedArtifact) {
          if (draftToPreserve !== undefined) {
            preservedDraftRef.current = {
              artifactId: refreshedArtifact.id,
              content: draftToPreserve,
            };
          }
          setSelectedArtifactId(refreshedArtifact.id);
          await queryClient.fetchQuery({
            queryKey: ["artifact", refreshedArtifact.id],
            queryFn: () => api.getArtifact(refreshedArtifact.id),
          });
        }
      } catch (refreshError) {
        setReviewConflict(
          `产物已变化，但自动刷新失败：${
            refreshError instanceof Error ? refreshError.message : "请稍后手动重试"
          }。审核意见和编辑草稿仍已保留。`,
        );
        await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      }
    },
  });
  const isReviewable = phase.status === "awaiting_review";
  const submit = (decision: ReviewDecision) => {
    if (isDirty || revisionMutation.isPending) {
      setError("请先保存或取消当前人工编辑，再提交审核结论。");
      return;
    }
    if (!comment.trim()) {
      setError(decision === "approve" ? "请留下简短的审核结论。" : "请说明需要修改的内容。");
      return;
    }
    const expectedArtifactIds = currentArtifactHeadIds(phase.artifacts);
    if (expectedArtifactIds.length === 0) {
      setError("当前阶段没有可审核的有效产物，请刷新后再试。");
      return;
    }
    setError(undefined);
    reviewMutation.mutate({ decision, expectedArtifactIds });
  };
  const saveRevision = () => {
    if (!artifact?.id || !artifact.contentHash) {
      setRevisionError("当前产物缺少可用于并发校验的内容哈希，请重新读取后再试。");
      return;
    }
    if (revisionContentInvalid) {
      setRevisionError("修订内容不能为空，且不能超过 2,000,000 字节。");
      return;
    }
    if (!isDirty) {
      setArtifactView("preview");
      return;
    }
    revisionMutation.mutate({
      artifactId: artifact.id,
      nextContent: draftContent,
      expectedContentHash: artifact.contentHash,
      artifactKey,
    });
  };
  const changeArtifact = (artifactId: string) => {
    if (isDirty || revisionMutation.isPending) {
      setRevisionError("请先保存或取消当前人工编辑，再切换产物。");
      return;
    }
    setSelectedArtifactId(artifactId);
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (isDirty || revisionMutation.isPending)) {
      setRevisionError("请先保存或取消当前人工编辑，再关闭窗口。");
      return;
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={`人工审核 · ${getPhaseName(definition)}`}
      description="逐份查看或人工修订阶段产物，也可只重跑当前产物。通过后会解锁下一角色。"
      className="max-w-6xl"
    >
      {reviewConflict ? (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2.5 border-b border-amber-200 bg-amber-50 px-5 py-3 text-xs leading-5 text-amber-900"
        >
          <RefreshCw className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{reviewConflict}</span>
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_340px] lg:overflow-hidden">
        <div className="flex min-h-0 flex-col border-b border-slate-200 lg:border-b-0 lg:border-r">
          {phase.artifacts.length > 1 ? (
            <div className="scrollbar-thin shrink-0 overflow-x-auto border-b border-slate-100 p-3">
              <Tabs value={selectedArtifactId} onValueChange={changeArtifact}>
                <TabsList className="w-max">
                  {phase.artifacts.map((item) => (
                    <TabsTrigger key={item.id} value={item.id}>
                      {artifactLabel(keyForArtifact(item))}
                      {item.revision ? ` · v${item.revision}` : ""}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-700">
                <span className="truncate">{artifact ? artifactLabel(artifactKey) : "阶段产物"}</span>
                {artifact?.revision ? <Badge variant="muted">v{artifact.revision}</Badge> : null}
                {artifact?.revisionSource === "human" ? <Badge variant="info">人工修订</Badge> : null}
                {isSuperseded ? <Badge variant="muted">已被替代</Badge> : null}
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-slate-400">
                {artifactPath || (isHtmlArtifact ? "HTML preview" : "Markdown preview")}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{isHtmlArtifact ? "HTML" : "Markdown"}</Badge>
              {canEdit && artifactView === "preview" ? (
                <Button size="sm" variant="outline" onClick={() => setArtifactView("edit")}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  人工编辑
                </Button>
              ) : null}
              {canRerunArtifact ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isDirty || revisionMutation.isPending}
                  onClick={() => onRerunArtifact(artifactKey)}
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  仅重跑当前产物
                </Button>
              ) : null}
            </div>
          </div>
          <div className="min-h-[280px] flex-1 bg-white p-5 sm:p-7 lg:max-h-[65vh] lg:min-h-[340px] lg:overflow-y-auto">
            {artifactQuery.isLoading ? (
              <div className="flex h-52 items-center justify-center gap-2 text-sm text-slate-400">
                <LoaderCircle className="h-4 w-4 animate-spin" /> 读取产物…
              </div>
            ) : artifactQuery.isError ? (
              <ErrorState error={artifactQuery.error} retry={() => void artifactQuery.refetch()} />
            ) : artifactView === "edit" && typeof content === "string" ? (
              <div>
                <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  保存会创建新的人工 revision，不会覆盖当前历史版本。
                  {isHtmlArtifact ? " HTML 将在保存后继续通过隔离沙箱预览。" : ""}
                </div>
                <Textarea
                  autoFocus
                  value={draftContent}
                  onChange={(event) => setDraftContent(event.target.value)}
                  disabled={revisionMutation.isPending}
                  spellCheck={false}
                  aria-label={`编辑 ${artifactLabel(artifactKey)}`}
                  className="min-h-[48vh] resize-y font-mono text-xs leading-6"
                />
                <div className="mt-1.5 text-right text-[10px] text-slate-400">
                  {revisionByteLength.toLocaleString()} / 2,000,000 字节
                </div>
                {revisionError ? (
                  <div role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-700">
                    {revisionError}
                  </div>
                ) : null}
                <div className="mt-3 flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    disabled={revisionMutation.isPending}
                    onClick={() => {
                      setDraftContent(content);
                      setArtifactView("preview");
                      setRevisionError(undefined);
                    }}
                  >
                    取消编辑
                  </Button>
                  <Button
                    variant="primary"
                    loading={revisionMutation.isPending}
                    disabled={!isDirty || revisionContentInvalid}
                    onClick={saveRevision}
                  >
                    <Save className="h-4 w-4" aria-hidden />
                    保存新修订
                  </Button>
                </div>
              </div>
            ) : typeof content === "string" && content.length > 0 ? (
              <Suspense
                fallback={
                  <div className="flex h-52 items-center justify-center gap-2 text-sm text-slate-400">
                    <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                    正在渲染{isHtmlArtifact ? " HTML 原型" : " Markdown"}…
                  </div>
                }
              >
                {isHtmlArtifact ? (
                  <HtmlPreview content={content} />
                ) : (
                  <MarkdownPreview content={content} />
                )}
              </Suspense>
            ) : (
              <EmptyState
                title="没有可预览的内容"
                description="该产物可能是目录、尚未写入，或后端只返回了文件引用。"
              />
            )}
            {artifactView === "preview" && revisionError ? (
              <div role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-700">
                {revisionError}
              </div>
            ) : null}
          </div>
        </div>

        <aside className="bg-slate-50/60 p-5 lg:max-h-[75vh] lg:overflow-y-auto">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              <CheckCircle2 className="h-4 w-4 text-teal-600" aria-hidden />
              审核标准
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-600">
              {definition.gate || "确认产物准确、完整，且足以支持下一角色继续工作。"}
            </p>
          </div>

          {phase.reviews.length ? (
            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">审核记录</div>
              <div className="space-y-3">
                {phase.reviews.map((review) => (
                  <div key={review.id} className="border-l-2 border-slate-200 pl-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={review.decision === "approve" ? "success" : "danger"}>
                        {review.decision === "approve" ? "已通过" : "要求修改"}
                      </Badge>
                      <span className="text-[10px] text-slate-400">{formatDate(review.createdAt)}</span>
                    </div>
                    <p className="mt-1.5 text-xs leading-5 text-slate-600">{review.comment}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {isReviewable ? (
            <div className="mt-5">
              <Field label="审核意见" hint="必填" required>
                <Textarea
                  className="min-h-32 bg-white"
                  placeholder="记录你的判断，或者准确描述需要修改的地方…"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  required
                  aria-required="true"
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "review-comment-error" : undefined}
                />
              </Field>
              {error ? (
                <div
                  id="review-comment-error"
                  role="alert"
                  className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs leading-5 text-rose-700"
                >
                  {error}
                </div>
              ) : null}
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button
                  variant="destructive"
                  className="px-2"
                  loading={
                    reviewMutation.isPending
                    && reviewMutation.variables?.decision === "request_changes"
                  }
                  disabled={reviewMutation.isPending || revisionMutation.isPending || isDirty}
                  onClick={() => submit("request_changes")}
                >
                  <XCircle className="h-4 w-4" aria-hidden />
                  要求修改
                </Button>
                <Button
                  variant="success"
                  className="px-2"
                  loading={
                    reviewMutation.isPending
                    && reviewMutation.variables?.decision === "approve"
                  }
                  disabled={reviewMutation.isPending || revisionMutation.isPending || isDirty}
                  onClick={() => submit("approve")}
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  通过并解锁
                </Button>
              </div>
            </div>
          ) : phase.status === "approved" ? (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs leading-5 text-emerald-800">
              <div className="flex items-center gap-2 font-semibold">
                <FileCheck2 className="h-4 w-4" aria-hidden />
                本阶段已完成审核
              </div>
              <p className="mt-1">可以继续创建人工修订，或只重跑需要调整的当前产物。</p>
            </div>
          ) : phase.status === "changes_requested" || phase.status === "rejected" ? (
            <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs leading-5 text-rose-800">
              <div className="flex items-center gap-2 font-semibold">
                <RotateCcw className="h-4 w-4" aria-hidden />
                本阶段已要求修改
              </div>
              <p className="mt-1">可以直接人工修订，或根据审核意见仅重跑当前产物。</p>
            </div>
          ) : phase.status === "failed" ? (
            <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs leading-5 text-rose-800">
              <div className="flex items-center gap-2 font-semibold">
                <AlertCircle className="h-4 w-4" aria-hidden />
                上次执行失败
              </div>
              <p className="mt-1">现有产物仍可人工修订，或只重跑需要恢复的当前产物。</p>
            </div>
          ) : (
            <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4 text-xs leading-5 text-slate-600">
              <div className="flex items-center gap-2 font-semibold text-slate-700">
                <FileText className="h-4 w-4" aria-hidden />
                当前状态：{STATUS_LABELS[phase.status] ?? phase.status}
              </div>
              <p className="mt-1">
                {phase.status === "ready"
                  ? "阶段已就绪；可以人工修订现有产物，或选择局部范围重新执行。"
                  : "当前状态仅支持查看，阶段解锁后才能编辑或重跑产物。"}
              </p>
            </div>
          )}
        </aside>
      </div>
    </Dialog>
  );
}

function keyForArtifact(artifact: Artifact) {
  return artifact.artifactKey || artifact.artifactId || artifact.type || artifact.name || artifact.id;
}

function safeHttpUrl(candidate?: string | null) {
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isOfficialFigmaFileUrl(candidate: string) {
  if (!candidate || candidate.length > 2_048) return false;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:"
      || (url.hostname !== "figma.com" && url.hostname !== "www.figma.com")
      || url.port !== ""
      || url.username !== ""
      || url.password !== ""
      || /%2f|%5c/iu.test(url.pathname)
    ) {
      return false;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const kind = segments[0];
    const fileKey = segments[1];
    if (
      (kind !== "design" && kind !== "file")
      || typeof fileKey !== "string"
      || !/^[a-zA-Z0-9_-]{2,256}$/u.test(fileKey)
      || segments.slice(2).some((segment) => {
        try {
          return decodeURIComponent(segment).toLowerCase() === "branch";
        } catch {
          return true;
        }
      })
    ) {
      return false;
    }
    const nodeIds = url.searchParams.getAll("node-id");
    return (
      nodeIds.length <= 1
      && (nodeIds[0] === undefined || /^\d+(?:-|:)\d+$/u.test(nodeIds[0]))
    );
  } catch {
    return false;
  }
}

function defaultEffortForModel(
  capabilities: CodexCapabilities | undefined,
  modelId: string,
): CodexReasoningEffort | "" {
  const model = capabilities?.models.find((item) => item.id === modelId);
  if (!capabilities || !model) return "";
  if (
    modelId === capabilities.defaultModel
    && model.reasoningEfforts.includes(capabilities.defaultReasoningEffort)
  ) {
    return capabilities.defaultReasoningEffort;
  }
  return model.reasoningEfforts.includes(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort
    : model.reasoningEfforts[0] ?? "";
}

function reasoningEffortLabel(effort: string) {
  const labels: Record<string, string> = {
    none: "无（none）",
    minimal: "最小（minimal）",
    low: "低（low）",
    medium: "中（medium）",
    high: "高（high）",
    xhigh: "很高（xhigh）",
    max: "最大（max）",
    ultra: "极致（ultra）",
  };
  return labels[effort] ?? effort;
}

function eventMessage(event: RunEvent) {
  if (event.message) return event.message;
  if (event.payload && typeof event.payload === "object") {
    const payload = event.payload as Record<string, unknown>;
    const candidate = payload.message || payload.text || payload.summary || payload.command;
    if (typeof candidate === "string") return candidate;
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
  return event.eventType || event.type || "执行事件";
}
