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
import { api, ApiError } from "@/lib/api";
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
  ENGINEERING_ARTIFACT_GUIDES,
  ENGINEERING_FLOW_STEPS,
  engineeringEvidenceGateGuidance,
  implementationReadinessGuidance,
  type EngineeringGateGuidance,
  type ImplementationStartGuidance,
} from "@/lib/engineering-workflow";
import {
  HUMAN_DECISION_PHASE_LABELS,
  HUMAN_DECISION_ROLE_LABELS,
  actionableHumanDecisionItems,
  deferredHumanDecisionItems,
  dependentHumanDecisionItems,
  humanDecisionGateHeadline,
  humanDecisionKindLabel,
  humanDecisionNextAction,
  humanDecisionPresets,
  isDeferredDesignHandoffCleanupGate,
  nonBlockingHumanDecisionItems,
} from "@/lib/human-decisions";
import {
  TESTER_FLOW_STEPS,
  TEST_REPORT_REVIEW_POINTS,
} from "@/lib/tester-workflow";
import {
  architecturePartialAllowedOutputKeys,
  architectureOptionSummaries,
  architecturePartialOutputKeys,
  architectureOutputKeysRequiringRefresh,
  architectureSelectionFromReviews,
  defaultFigmaFileName,
  initialPhaseOutputKeys,
  isPhaseOutputLocked,
  isPhaseOutputSelectionComplete,
  isArchitectureImpactRationaleValid,
  isArchitectureImpactOutputMutable,
  isArchitecturePartialOutputSelectionComplete,
  isArchitectureReselectionBlockedByImpact,
  parseArchitectureSelectionId,
  REQUIRED_ARCHITECTURE_BOOTSTRAP_OUTPUT_KEYS,
  requiredPhaseApprovalOutputKeys,
  type ArchitectureImpactChoice,
} from "@/lib/phase-output-selection";
import {
  defaultRoutedPartialOutputKeys,
  effectiveRequiredInputKeys,
  impactChoiceRequiresBaseline,
  impactOptionsForPhase,
  isImpactAssessmentComplete,
  isFirstPhaseImpactAttempt,
  isProductDirectAllowed,
  isResolutionOutputMutable,
  phaseImpactActionLabel,
  phaseImpactTitle,
  resolutionIsReadOnly,
  resolutionModeLabel,
  shouldSubmitRoutedImpactAssessment,
  type RoutedImpactChoice,
  type RoutedImpactPhaseId,
} from "@/lib/phase-impact";
import type {
  Artifact,
  ArchitectureBaseline,
  AssessDesignImpactInput,
  AssessProductImpactInput,
  ChangeContract,
  CodexCapabilities,
  CodexReasoningEffort,
  FigmaTarget,
  HumanDecisionPhaseId,
  HumanDecisionSummary,
  PhaseHumanDecisionGate,
  PhaseBaseline,
  PhaseDefinition,
  PhaseRun,
  PhaseStatus,
  ReviewDecision,
  RoleDefinition,
  RunEvent,
  WorkflowRun,
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
const MermaidPreview = lazy(() =>
  import("@/components/mermaid-preview").then((module) => ({ default: module.MermaidPreview })),
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

const ARCHITECTURE_IMPACT_OPTIONS: ReadonlyArray<{
  value: ArchitectureImpactChoice;
  title: string;
  description: string;
}> = [
  {
    value: "skip",
    title: "无需架构工作",
    description: "没有边界、集成、数据、安全或 NFR 变化，记录豁免理由后直接进入实现。",
  },
  {
    value: "reuse",
    title: "复用现有架构",
    description: "本次变更不影响架构，沿用已批准基线，不生成新架构产物并完成本阶段。",
  },
  {
    value: "partial",
    title: "局部更新",
    description: "保留既有选型，只更新架构索引和明确受影响的选型后产物。",
  },
  {
    value: "full",
    title: "完整重跑",
    description: "重新生成 Discovery 与 Options，并进入新一轮人工选型。",
  },
];

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
  const progress = Math.round((approvedCount / Math.max(phases.length, 1)) * 100);
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
      setExecuteTarget({ phaseId });
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
        <Button variant="ghost" size="sm" className="-ml-2 mb-3" onClick={() => onBack(run.projectId)}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          返回 {project.name}
        </Button>
        <div className="flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant={run.status === "completed" ? "success" : "info"}>
                <GitBranch className="h-3 w-3" aria-hidden />
                {run.status === "completed" ? "交付完成" : "交付任务"}
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
            <div className="mt-2 text-[11px] text-slate-400">
              所有阶段均需人工审核且没有未关闭事项后才算完成
              {inconsistentApprovedPhases.size > 0
                ? ` · ${inconsistentApprovedPhases.size} 个旧批准需要修复`
                : ""}
            </div>
          </div>
        </div>
      </section>

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
                outputKeysByPhase={outputKeysByPhase}
                definition={selectedDefinition}
                role={selectedRole}
                decisionGate={selectedDecisionGate}
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
              phases={phases}
              hasChangeContract={Boolean(run.changeContract)}
              outputKeysByPhase={outputKeysByPhase}
              workType={run.changeContract?.workType}
              hasEvidenceRefs={Boolean(run.changeContract?.evidenceRefs.length)}
              productBaseline={productBaseline}
              designBaseline={designBaseline}
              architectureBaseline={architectureBaseline}
              initialOutputKeys={executeTarget?.initialOutputKeys}
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
              open
              onOpenChange={(open) => !open && setReviewTarget(undefined)}
              onRerunArtifact={(artifactKey) => {
                setReviewTarget(undefined);
                setExecuteTarget({
                  phaseId: reviewPhase.phaseId,
                  initialOutputKeys: [artifactKey],
                });
              }}
              onRerunOutputs={(artifactKeys) => {
                setReviewTarget(undefined);
                setExecuteTarget({
                  phaseId: reviewPhase.phaseId,
                  initialOutputKeys: artifactKeys,
                });
              }}
              onNavigateDecisionPhase={openDecisionPhase}
              onDecisionSaved={(phaseId) => {
                setReviewTarget(undefined);
                setSelectedPhaseId(phaseId);
                setExecuteTarget({ phaseId });
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
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
            <span className="text-sm font-semibold text-slate-950">Change Contract</span>
            <Badge variant="info">{WORK_TYPE_LABELS[contract.workType]}</Badge>
            <Badge variant="success">后续角色共同输入</Badge>
          </span>
          <span className="mt-1 block truncate text-xs text-slate-500">{contract.summary}</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition group-open:rotate-90" aria-hidden />
      </summary>
      <div className="grid gap-4 border-t border-slate-100 bg-slate-50/45 px-5 py-5 sm:px-6 lg:grid-cols-2">
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
  onOpenPhase,
}: {
  summary: HumanDecisionSummary;
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
                <CardTitle className="text-base">决定与待办</CardTitle>
                <p className="mt-0.5 text-xs leading-5 text-slate-600">
                  这里才是你需要处理的入口。回答决定或进入来源阶段；底层 Markdown 会由对应角色更新。
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
              已显示为“通过”，但正式产物里仍有未关闭事项。请处理后让对应角色重新生成，不要继续向下游推进。
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
                    {STATUS_LABELS[phase.status] ?? phase.status}
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
  outputKeysByPhase,
  definition,
  role,
  decisionGate,
  architectureImpactAvailable,
  routedImpactCheckAvailable,
  onExecute,
  onReview,
  onOpenTickets,
}: {
  phase: PhaseRun;
  phases: PhaseRun[];
  hasChangeContract: boolean;
  outputKeysByPhase: Partial<Record<string, string[]>>;
  definition: PhaseDefinition;
  role: RoleDefinition;
  decisionGate?: PhaseHumanDecisionGate;
  architectureImpactAvailable?: boolean;
  routedImpactCheckAvailable?: boolean;
  onExecute: (initialOutputKeys?: string[]) => void;
  onReview: (initialArtifactId?: string) => void;
  onOpenTickets: () => void;
}) {
  const Icon = roleIcons[role.id] ?? Bot;
  const style = statusStyle[phase.status] ?? statusStyle.pending;
  const effectiveInputs = effectiveRequiredInputKeys(
    definition.inputs,
    phases,
    { hasChangeContract, outputKeysByPhase },
  );
  const canExecute = ["ready", "changes_requested", "rejected", "failed"].includes(phase.status)
    && !resolutionIsReadOnly(phase.resolution);
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
    && phase.architectureImpact?.mode !== "reuse";
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
                <Badge variant={style.badge}>{STATUS_LABELS[phase.status]}</Badge>
              </div>
              <p className="mt-1 text-sm font-medium text-teal-700">{role.name}</p>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{role.mission}</p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {canExecute ? (
              <Button variant="primary" onClick={() => onExecute()}>
                {showsImpactAction ? (
                  <GitBranch className="h-4 w-4" />
                ) : phase.status === "ready" ? (
                  <Play className="h-4 w-4" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                {showsRoutedImpactAction
                  ? phaseImpactActionLabel(phase.phaseId as RoutedImpactPhaseId)
                  : showsArchitectureImpactAction
                    ? "检查架构影响"
                  : phase.phaseId === "implementation" && phase.status === "ready"
                    ? "检查条件并开始写代码"
                  : phase.phaseId === "implementation"
                    ? "根据反馈重新实施"
                  : phase.phaseId === "verification" && phase.status === "ready"
                    ? "开始 Tester 独立验证"
                  : onlyDeferredDesignVerification || deferredHandoffCleanupRequired
                    ? "整理实现后验证交接"
                  : phase.status === "ready"
                    ? `运行 ${role.name}`
                    : "根据反馈重新运行"}
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
                {phase.phaseId === "implementation" ? "重新实施并刷新全部证据" : "选择产物重跑"}
              </Button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-5 sm:p-6">
        {phase.phaseId === "implementation" ? (
          <div className="mb-5"><EngineeringFlowGuide /></div>
        ) : null}
        {phase.phaseId === "verification" ? (
          <div className="mb-5"><TesterFlowGuide /></div>
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
              <Button variant="outline" className="shrink-0 bg-white" onClick={() => onExecute()}>
                <RotateCcw className="h-4 w-4" aria-hidden />
                整理交接并进入审核
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
                <div className="font-semibold">{humanDecisionGateHeadline(decisionGate)}</div>
                <p className="mt-1 text-xs leading-5">
                  {decisionGate.decisionCount > 0 ? `需要你决定 ${decisionGate.decisionCount} 项。` : ""}
                  {decisionGate.workCount > 0 ? ` ${role.name} 还要补做 ${decisionGate.workCount} 项。` : ""}
                  {decisionGate.dependencyCount > 0 ? ` 另有 ${decisionGate.dependencyCount} 项应回到上游处理。` : ""}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              className="shrink-0 bg-white"
              onClick={() => decisionActionRunsRole ? onExecute() : onReview()}
            >
              {decisionActionRunsRole
                ? <RotateCcw className="h-4 w-4" aria-hidden />
                : <MessageSquare className="h-4 w-4" aria-hidden />}
              {decisionActionRunsRole ? `运行 ${role.name} 处理清单` : "处理决定与待办"}
            </Button>
          </div>
        ) : null}
        {requiresFullRerun ? (
          <div className="mb-5 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              上游变化已使旧处置失效。本版本保留历史审核与执行记录，因此本阶段当前只支持完整重跑；
              如需重新 Skip / Reuse / Partial，请新建 Run 重新评估。
            </span>
          </div>
        ) : null}
        {phase.status === "running" ? (
          <div className="mb-5 flex items-center gap-3 rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-sm text-sky-800">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            {phase.phaseId === "implementation"
              ? "Codex 正在写代码、补测试、运行检查并生成工程证据。页面会自动刷新状态和终端事件。"
              : "Codex 正在项目目录中执行。页面会自动刷新状态和终端事件。"}
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
                      {!isSuperseded && canReviseArtifacts && !isImpactReadOnly ? (
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

function EngineeringFlowGuide({ compact = false }: { compact?: boolean }) {
  return (
    <section className="rounded-xl border border-teal-200 bg-teal-50/50 p-4" aria-label="软件工程四步流程">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">软件工程其实只有四步</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            七份 Markdown 是 Codex 自动生成的实施证据，不是要你手工完成的七个任务。
          </p>
        </div>
        <Badge variant="info">写代码在第 2 步</Badge>
      </div>
      <ol className={cn("mt-3 grid gap-2", compact ? "sm:grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-4")}>
        {ENGINEERING_FLOW_STEPS.map((step) => (
          <li key={step.number} className="rounded-lg bg-white px-3 py-2.5 ring-1 ring-teal-100">
            <div className="text-xs font-semibold text-slate-900">{step.number}. {step.title}</div>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">{step.description}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TesterFlowGuide({ compact = false }: { compact?: boolean }) {
  return (
    <section className="rounded-xl border border-sky-200 bg-sky-50/60 p-4" aria-label="Tester E2E 验证流程">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">Tester：先接收，再完成 E2E 三阶段</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            探索 → 固化 → 独立执行。MCP 跑通不等于通过；可重复证据必须来自当前 revision 的仓库脚本和真实 runner。
          </p>
        </div>
        <Badge variant="info">MCP 只在探索</Badge>
      </div>
      <ol className={cn("mt-3 grid gap-2", compact ? "sm:grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-4")}>
        {TESTER_FLOW_STEPS.map((step) => (
          <li key={step.number} className="rounded-lg bg-white px-3 py-2.5 ring-1 ring-sky-100">
            <div className="text-xs font-semibold text-slate-900">
              {step.number === 0 ? "接收" : `E2E Stage ${step.number}`} · {step.title}
            </div>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">{step.description}</p>
          </li>
        ))}
      </ol>
    </section>
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
  phases,
  hasChangeContract,
  outputKeysByPhase,
  workType,
  hasEvidenceRefs,
  productBaseline,
  designBaseline,
  architectureBaseline,
  definition,
  initialOutputKeys,
  open,
  onOpenChange,
  onNavigatePhase,
}: {
  runId: string;
  runTitle: string;
  phase: PhaseRun;
  phases: PhaseRun[];
  hasChangeContract: boolean;
  outputKeysByPhase: Partial<Record<string, string[]>>;
  workType?: ChangeContract["workType"];
  hasEvidenceRefs: boolean;
  productBaseline?: PhaseBaseline | null;
  designBaseline?: PhaseBaseline | null;
  architectureBaseline?: ArchitectureBaseline | null;
  definition: PhaseDefinition;
  initialOutputKeys?: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigatePhase: (phaseId: "discovery" | "design" | "architecture") => void;
}) {
  const queryClient = useQueryClient();
  const candidates = phase.availableArtifacts ?? [];
  const isDesignPhase = phase.phaseId === "design";
  const isImplementationPhase = phase.phaseId === "implementation";
  const executableOutputKeys = definition.outputs.filter((key) => key !== "change-contract");
  const effectiveInputKeys = effectiveRequiredInputKeys(
    definition.inputs,
    phases,
    { hasChangeContract, outputKeysByPhase },
  );
  const routedImpactPhaseId = phase.phaseId === "discovery" || phase.phaseId === "design"
    ? phase.phaseId
    : undefined;
  const routedImpactBaseline = routedImpactPhaseId === "discovery"
    ? productBaseline
    : routedImpactPhaseId === "design"
      ? designBaseline
      : undefined;
  const productDirectAllowed = isProductDirectAllowed(
    hasChangeContract,
    workType,
    hasEvidenceRefs,
  );
  const existingOutputKeys = [...new Set(
    phase.artifacts
      .filter((artifact) => !artifact.superseded && artifact.reviewStatus !== "superseded")
      .map((artifact) => keyForArtifact(artifact)),
  )].filter((key) => key !== "change-contract");
  const hasExistingArtifacts = existingOutputKeys.length > 0;
  const canAssessRoutedImpact = Boolean(
    routedImpactPhaseId
    && phase.status === "ready"
    && !phase.resolution
    && isFirstPhaseImpactAttempt(phase),
  );
  const canAssessArchitectureImpact = phase.phaseId === "architecture"
    && phase.status === "ready"
    && !phase.resolution
    && !phase.architectureImpact
    && isFirstPhaseImpactAttempt(phase);
  const hasAssessedPartialImpact = phase.phaseId === "architecture"
    && phase.architectureImpact?.mode === "partial";
  const isFirstAssessedPartialExecution = hasAssessedPartialImpact
    && phase.executions.length === 0;
  const currentArchitectureOptions = phase.artifacts.find(
    (artifact) => !artifact.superseded
      && artifact.reviewStatus !== "superseded"
      && keyForArtifact(artifact) === "architecture-options",
  );
  const currentArchitectureDiscovery = phase.artifacts.find(
    (artifact) => !artifact.superseded
      && artifact.reviewStatus !== "superseded"
      && keyForArtifact(artifact) === "architecture-discovery-context",
  );
  const architectureSelectionRecorded = hasAssessedPartialImpact
    || (
      phase.phaseId === "architecture"
      && phase.status !== "ready"
      && Boolean(currentArchitectureOptions)
      && Boolean(currentArchitectureDiscovery)
      && Boolean(architectureSelectionFromReviews(
        phase.reviews,
        currentArchitectureOptions!.id,
        [currentArchitectureOptions!.id, currentArchitectureDiscovery!.id],
      ))
    );
  const outputOptions = executableOutputKeys.map((key) => {
    const designOutput = DESIGN_OUTPUTS.find((output) => output.key === key);
    const engineeringOutput = ENGINEERING_ARTIFACT_GUIDES.find((output) => output.key === key);
    const describedOutput = designOutput ?? engineeringOutput;
    return {
      key,
      description: engineeringOutput?.purpose
        ?? designOutput?.description
        ?? "此阶段注册的可审核交付产物。",
      downstreamRequired: describedOutput?.required ?? false,
      engineeringGuide: engineeringOutput,
    };
  });
  const [selected, setSelected] = useState<string[]>(() => candidates.map((artifact) => artifact.id));
  const [routedImpactChoice, setRoutedImpactChoice] = useState<RoutedImpactChoice | "">(
    () => canAssessRoutedImpact ? "" : "",
  );
  const [routedImpactRationale, setRoutedImpactRationale] = useState("");
  const [architectureImpactChoice, setArchitectureImpactChoice] = useState<
    ArchitectureImpactChoice | ""
  >(() => canAssessArchitectureImpact ? "" : hasAssessedPartialImpact ? "partial" : "full");
  const [architectureImpactRationale, setArchitectureImpactRationale] = useState("");
  const standardInitialOutputKeys = () => initialPhaseOutputKeys({
      phaseId: phase.phaseId,
      availableOutputKeys: executableOutputKeys,
      hasExistingArtifacts,
      existingOutputKeys,
      initialOutputKeys,
      architectureSelectionRecorded,
    });
  const [selectedOutputs, setSelectedOutputs] = useState<string[]>(() => {
    if (canAssessRoutedImpact) return [];
    if (phase.resolution?.mode === "partial") {
      const affected = phase.resolution.affectedOutputKeys;
      if (phase.executions.length === 0 || !initialOutputKeys?.length) return [...affected];
      const requested = initialOutputKeys.filter((key) => affected.includes(key));
      return requested.length > 0 ? requested : [...affected];
    }
    if (canAssessArchitectureImpact) return [];
    if (hasAssessedPartialImpact) {
      const affectedOutputKeys = phase.architectureImpact?.affectedOutputKeys ?? [];
      return architecturePartialOutputKeys({
        availableOutputKeys: executableOutputKeys,
        affectedOutputKeys,
        initialOutputKeys: initialOutputKeys?.length ? initialOutputKeys : affectedOutputKeys,
        requireAllAffectedOutputs: isFirstAssessedPartialExecution,
      });
    }
    return standardInitialOutputKeys();
  });
  const isImplementationEvidenceRepair = isImplementationPhase
    && selectedOutputs.length > 0
    && selectedOutputs.length < executableOutputKeys.length;
  const isArchitecturePartialMode = hasAssessedPartialImpact
    || (canAssessArchitectureImpact && architectureImpactChoice === "partial");
  const partialAffectedOutputKeys = hasAssessedPartialImpact
    ? phase.architectureImpact?.affectedOutputKeys
    : undefined;
  const partialAllowedOutputKeys = architecturePartialAllowedOutputKeys(
    executableOutputKeys,
    partialAffectedOutputKeys,
  );
  const routedPartialOutputKeys = phase.resolution?.mode === "partial"
    ? phase.resolution.affectedOutputKeys
    : undefined;
  const visibleOutputOptions = isArchitecturePartialMode
    ? outputOptions.filter((output) => partialAllowedOutputKeys.includes(output.key))
    : routedPartialOutputKeys
      ? outputOptions.filter((output) => routedPartialOutputKeys.includes(output.key))
      : outputOptions;
  const runsRoutedFullExecution = Boolean(
    canAssessRoutedImpact
    && routedImpactChoice === "full",
  );
  const submitsRoutedImpactAssessment = Boolean(
    canAssessRoutedImpact
    && routedImpactPhaseId
    && shouldSubmitRoutedImpactAssessment(routedImpactChoice),
  );
  const submitsArchitectureImpactAssessment = canAssessArchitectureImpact
    && (
      architectureImpactChoice === "skip"
      || architectureImpactChoice === "reuse"
      || architectureImpactChoice === "partial"
    );
  const showsImpactAssessmentOnly = submitsRoutedImpactAssessment
    || (canAssessRoutedImpact && !routedImpactChoice)
    || (canAssessArchitectureImpact && architectureImpactChoice !== "full");
  const showsArchitectureImpactOnly = canAssessArchitectureImpact
    && architectureImpactChoice !== "full";
  const figmaOutputSelected = !submitsRoutedImpactAssessment && isFigmaRequested(selectedOutputs);
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<CodexReasoningEffort | "">("");
  const [figmaTargetMode, setFigmaTargetMode] = useState<FigmaTarget["mode"]>(
    "new_private_draft",
  );
  const [figmaPlanKey, setFigmaPlanKey] = useState("");
  const [figmaFileName, setFigmaFileName] = useState(() => defaultFigmaFileName(runTitle));
  const [figmaFileUrl, setFigmaFileUrl] = useState("");
  const [error, setError] = useState<string>();
  const [implementationStartHelp, setImplementationStartHelp] = useState<ImplementationStartGuidance>();
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
    enabled: open && runnerMode === "real" && !showsImpactAssessmentOnly,
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
      if (submitsRoutedImpactAssessment && routedImpactPhaseId && routedImpactChoice) {
        const needsBaseline = impactChoiceRequiresBaseline(
          routedImpactPhaseId,
          routedImpactChoice,
        );
        if (needsBaseline && !routedImpactBaseline) {
          throw new Error("已批准基线已变化或不可用，请刷新后重新判断");
        }
        const common = {
          rationale: routedImpactRationale.trim(),
          selectedArtifactIds: selected,
          expectedBaselineArtifactIds: needsBaseline
            ? routedImpactBaseline?.artifacts.map((artifact) => artifact.id) ?? []
            : [],
          affectedOutputKeys: routedImpactChoice === "partial" ? selectedOutputs : [],
        };
        if (routedImpactPhaseId === "discovery") {
          return api.assessProductImpact(runId, {
            ...common,
            mode: routedImpactChoice as AssessProductImpactInput["mode"],
          });
        }
        return api.assessDesignImpact(runId, {
          ...common,
          mode: routedImpactChoice as AssessDesignImpactInput["mode"],
        });
      }
      if (submitsArchitectureImpactAssessment) {
        const requiresBaseline = architectureImpactChoice === "reuse"
          || architectureImpactChoice === "partial";
        if (requiresBaseline && !architectureBaseline) {
          throw new Error("架构基线已变化，请刷新后重试");
        }
        return api.assessArchitectureImpact(runId, {
          mode: architectureImpactChoice as "skip" | "reuse" | "partial",
          rationale: architectureImpactRationale.trim(),
          selectedArtifactIds: selected,
          expectedBaselineArtifactIds: requiresBaseline
            ? architectureBaseline?.artifacts.map((artifact) => artifact.id) ?? []
            : [],
          affectedOutputKeys: architectureImpactChoice === "partial" ? selectedOutputs : [],
        });
      }
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
    onMutate: () => {
      setError(undefined);
      setImplementationStartHelp(undefined);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      onOpenChange(false);
    },
    onError: async (mutationError) => {
      const readinessHelp = implementationReadinessGuidance(mutationError);
      if (readinessHelp) {
        setError(undefined);
        setImplementationStartHelp(readinessHelp);
        return;
      }
      if (mutationError instanceof ApiError && mutationError.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      }
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : submitsRoutedImpactAssessment
            ? "提交阶段影响评估失败"
            : submitsArchitectureImpactAssessment
              ? "提交架构影响评估失败"
            : "无法启动 Codex",
      );
    },
  });
  const requiredKeys = new Set(effectiveInputKeys);
  const selectedKeys = new Set(
    candidates
      .filter((artifact) => selected.includes(artifact.id))
      .map((artifact) => keyForArtifact(artifact)),
  );
  const missingRequiredInputKeys = effectiveInputKeys.filter((key) => !selectedKeys.has(key));
  const hasAllRequiredInputs = missingRequiredInputKeys.length === 0;
  const hasImpactAssessmentInputs = routedImpactPhaseId === "discovery"
    ? true
    : hasAllRequiredInputs;
  const hasInputsForCurrentAction = canAssessRoutedImpact && !runsRoutedFullExecution
    ? hasImpactAssessmentInputs
    : hasAllRequiredInputs;
  const hasAllRequiredOutputs = canAssessRoutedImpact && !runsRoutedFullExecution
    ? routedImpactChoice !== "partial" || selectedOutputs.length > 0
    : phase.resolution?.mode === "partial"
      ? selectedOutputs.length > 0
        && selectedOutputs.every((key) => phase.resolution?.affectedOutputKeys.includes(key))
        && (
          phase.executions.length > 0
          || phase.resolution.affectedOutputKeys.every((key) => selectedOutputs.includes(key))
        )
    : canAssessArchitectureImpact
      ? architectureImpactChoice === "skip"
      || architectureImpactChoice === "reuse"
      || (
        architectureImpactChoice === "partial"
        && isArchitecturePartialOutputSelectionComplete({
          availableOutputKeys: executableOutputKeys,
          selectedOutputKeys: selectedOutputs,
        })
      )
      || (
        architectureImpactChoice === "full"
        && isPhaseOutputSelectionComplete({
          phaseId: phase.phaseId,
          availableOutputKeys: executableOutputKeys,
          selectedOutputKeys: selectedOutputs,
          hasExistingArtifacts,
          existingOutputKeys,
          architectureSelectionRecorded,
        })
      )
    : isArchitecturePartialMode
      ? isArchitecturePartialOutputSelectionComplete({
        availableOutputKeys: executableOutputKeys,
        selectedOutputKeys: selectedOutputs,
        affectedOutputKeys: partialAffectedOutputKeys,
        requireAllAffectedOutputs: isFirstAssessedPartialExecution,
      })
      : isPhaseOutputSelectionComplete({
        phaseId: phase.phaseId,
        availableOutputKeys: executableOutputKeys,
        selectedOutputKeys: selectedOutputs,
        hasExistingArtifacts,
        existingOutputKeys,
        architectureSelectionRecorded,
      });
  const routedImpactAssessmentReady = !canAssessRoutedImpact
    || runsRoutedFullExecution
    || Boolean(
      routedImpactPhaseId
      && isImpactAssessmentComplete({
        phaseId: routedImpactPhaseId,
        choice: routedImpactChoice,
        rationale: routedImpactRationale,
        baseline: routedImpactBaseline,
        affectedOutputKeys: selectedOutputs,
        hasAllRequiredInputs: hasImpactAssessmentInputs,
      }),
    );
  const hasValidArchitectureImpactRationale = !submitsArchitectureImpactAssessment
    || isArchitectureImpactRationaleValid(architectureImpactRationale);
  const hasUnsupportedFigmaOutput = !showsImpactAssessmentOnly
    && !figmaExecutionOptions.valid;
  const canUseSelectedCodexConfiguration =
    showsImpactAssessmentOnly
    || runnerMode !== "real"
    || hasResolvedCodexConfiguration;

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

  const selectArchitectureImpactChoice = (choice: ArchitectureImpactChoice) => {
    if (mutation.isPending) return;
    if (
      choice === "skip"
      && (
        (workType !== "bug" && workType !== "technical")
        || !hasEvidenceRefs
      )
    ) {
      setError("只有在 Change Contract 中带明确证据引用的 Bug 或技术任务可以声明无需架构工作。");
      return;
    }
    if ((choice === "reuse" || choice === "partial") && !architectureBaseline) {
      setError("当前项目还没有可复用的已批准架构基线；请选择跳过或完整重跑。");
      return;
    }
    setArchitectureImpactChoice(choice);
    if (choice === "skip" || choice === "reuse") {
      setSelectedOutputs([]);
    } else if (choice === "partial") {
      setSelectedOutputs(architecturePartialOutputKeys({
        availableOutputKeys: executableOutputKeys,
        initialOutputKeys,
      }));
    } else {
      setSelectedOutputs(standardInitialOutputKeys());
    }
    setError(undefined);
  };

  const selectRoutedImpactChoice = (choice: RoutedImpactChoice) => {
    if (mutation.isPending || !routedImpactPhaseId) return;
    if (
      routedImpactPhaseId === "discovery"
      && choice !== "full"
      && !hasChangeContract
    ) {
      setError("旧 Run 没有 Change Contract，只能选择 Full 运行 PM / BA 补齐产品产物。");
      return;
    }
    if (
      routedImpactPhaseId === "discovery"
      && choice === "direct"
      && !productDirectAllowed
    ) {
      setError("Direct 仅适用于预期行为明确的 Bug 或无行为变化的技术任务；请选择 Partial 或 Full。");
      return;
    }
    if (impactChoiceRequiresBaseline(routedImpactPhaseId, choice) && !routedImpactBaseline) {
      setError("当前项目还没有可复用的已批准基线；请选择直接、跳过或完整执行。");
      return;
    }
    setRoutedImpactChoice(choice);
    setSelectedOutputs(
      choice === "partial"
        ? defaultRoutedPartialOutputKeys(routedImpactPhaseId, executableOutputKeys)
        : choice === "full"
          ? standardInitialOutputKeys()
          : [],
    );
    setError(undefined);
  };

  const toggleOutput = (key: string) => {
    if (mutation.isPending) return;
    if (canAssessRoutedImpact && !runsRoutedFullExecution) {
      if (routedImpactChoice !== "partial") return;
      setSelectedOutputs((current) =>
        current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
      );
      return;
    }
    if (phase.resolution?.mode === "partial") {
      if (
        phase.executions.length === 0
        || !phase.resolution.affectedOutputKeys.includes(key)
      ) return;
      setSelectedOutputs((current) =>
        current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
      );
      return;
    }
    if (isArchitecturePartialMode) {
      if (
        key === "architecture"
        || isFirstAssessedPartialExecution
        || !partialAllowedOutputKeys.includes(key)
      ) return;
      setSelectedOutputs((current) =>
        current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
      );
      return;
    }
    if (isPhaseOutputLocked({
      phaseId: phase.phaseId,
      outputKey: key,
      hasExistingArtifacts,
      architectureSelectionRecorded,
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
      title={isImplementationEvidenceRepair
        ? "检查并修复工程证据"
        : phase.phaseId === "implementation"
          ? "检查条件并开始写代码"
          : phase.phaseId === "verification"
            ? "开始 Tester 独立验证"
            : `运行 · ${getPhaseName(definition)}`}
      description={isImplementationEvidenceRepair
        ? "本次只修复审核页选中的工程记录；平台会把机器校验反馈交给 Codex。代码与测试作为事实基线，若事实不成立则停止并报告。"
        : phase.phaseId === "implementation"
          ? "选择已批准的上游依据后，Codex 会修改源码、补测试、运行检查；七份证据文档会自动生成。"
          : phase.phaseId === "verification"
            ? "先审核当前工程交接，再按探索、固化回流和独立执行边界完成 Verification；Tester 只写 test-report，不绕过 Software Engineer 修改仓库测试。"
            : "选择 Codex 本次可以使用的上游产物，以及需要交付的阶段输出。"}
      className="h-[calc(100dvh-1rem)] max-h-[52rem] max-w-2xl sm:h-[calc(100dvh-3rem)]"
    >
      <fieldset
        disabled={mutation.isPending}
        aria-busy={mutation.isPending}
        className="m-0 flex min-h-0 min-w-0 flex-1 flex-col border-0 p-0"
      >
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">
          {phase.phaseId === "implementation" ? (
            <div className="mb-5"><EngineeringFlowGuide compact /></div>
          ) : null}
          {phase.phaseId === "verification" ? (
            <div className="mb-5"><TesterFlowGuide compact /></div>
          ) : null}
          {canAssessRoutedImpact && routedImpactPhaseId ? (
            <section
              className="mb-5 rounded-2xl border border-teal-200 bg-teal-50/50 p-4"
              aria-labelledby="routed-impact-check-title"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 id="routed-impact-check-title" className="text-sm font-semibold text-slate-950">
                    {phaseImpactTitle(routedImpactPhaseId)}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    先判断本阶段的处理方式；Direct、Reuse、Partial 会留存处置证据，Full 会直接启动当前角色。
                  </p>
                </div>
                <Badge variant={routedImpactBaseline ? "info" : "muted"}>
                  {routedImpactBaseline ? "存在已批准基线" : "暂无可复用基线"}
                </Badge>
              </div>
              {routedImpactBaseline ? (
                <p className="mt-3 rounded-lg bg-white/80 px-3 py-2 text-[11px] leading-5 text-slate-500 ring-1 ring-teal-100">
                  来源：{routedImpactBaseline.sourceRunTitle} · {routedImpactBaseline.artifacts.length} 项产物 ·
                  批准于 {formatDate(routedImpactBaseline.approvedAt)}
                </p>
              ) : (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                  Reuse 与 Partial 需要已批准基线，当前只能选择
                  {routedImpactPhaseId === "discovery" && productDirectAllowed
                    ? " Direct 或 Full"
                    : routedImpactPhaseId === "discovery"
                      ? " Full"
                      : " Skip 或 Full"}。
                </p>
              )}
              {routedImpactPhaseId === "discovery" && !hasChangeContract ? (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                  这是没有 Change Contract 的旧 Run；Direct、Reuse、Partial 不可用，请用 Full 补齐产品产物。
                </p>
              ) : null}

              <fieldset className="mt-3">
                <legend className="sr-only">选择阶段处置方式</legend>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {impactOptionsForPhase(routedImpactPhaseId).map((option) => {
                    const missingBaseline = option.requiresBaseline && !routedImpactBaseline;
                    const legacyProductChoice = routedImpactPhaseId === "discovery"
                      && !hasChangeContract
                      && option.value !== "full";
                    const directNotAllowed = routedImpactPhaseId === "discovery"
                      && option.value === "direct"
                      && !productDirectAllowed;
                    const disabled = missingBaseline || legacyProductChoice || directNotAllowed;
                    return (
                      <label
                        key={option.value}
                        className={cn(disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer")}
                      >
                        <input
                          type="radio"
                          name={`routed-impact-${phase.id ?? phase.phaseId}`}
                          value={option.value}
                          checked={routedImpactChoice === option.value}
                          disabled={disabled}
                          onChange={() => selectRoutedImpactChoice(option.value)}
                          className="peer sr-only"
                        />
                        <span
                          className={cn(
                            "block h-full rounded-xl border bg-white px-3 py-3 transition peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2",
                            routedImpactChoice === option.value
                              ? "border-teal-400 ring-1 ring-teal-200"
                              : "border-slate-200",
                            !disabled && "hover:border-slate-300",
                          )}
                        >
                          <span className="block text-xs font-semibold text-slate-900">{option.title}</span>
                          <span className="mt-1 block text-[11px] leading-4 text-slate-500">
                            {option.description}
                          </span>
                          {directNotAllowed && hasChangeContract ? (
                            <span className="mt-1 block text-[10px] font-semibold text-amber-700">
                              {!hasEvidenceRefs
                                ? "Change Contract 缺少证据引用；请选择 Full 或新建 Run 补充"
                                : "新功能 / 局部变更请选择 Partial 或 Full"}
                            </span>
                          ) : null}
                          {legacyProductChoice ? (
                            <span className="mt-1 block text-[10px] font-semibold text-amber-700">
                              旧 Run 缺少 Change Contract
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {routedImpactChoice && routedImpactChoice !== "full" ? (
                <label className="mt-4 block">
                  <span className="text-xs font-semibold text-slate-700">处置理由</span>
                  <Textarea
                    value={routedImpactRationale}
                    maxLength={2_000}
                    onChange={(event) => setRoutedImpactRationale(event.target.value)}
                    placeholder={routedImpactChoice === "partial"
                      ? "说明哪些输出受影响，以及为什么其他输出仍可继承…"
                      : "说明 Change Contract、现有基线和代码事实如何支持这个判断…"}
                    aria-invalid={Boolean(
                      routedImpactRationale
                      && routedImpactRationale.trim().length < 10
                    )}
                    className="mt-1.5 min-h-24 bg-white"
                  />
                  <span className="mt-1.5 block text-[11px] leading-4 text-slate-500">
                    至少 10 个字符；来源基线、选定输入、理由和受影响输出会一起留痕。
                  </span>
                </label>
              ) : routedImpactChoice === "full" ? (
                <p className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-800">
                  将在当前窗口直接选择输入与输出并启动 Codex；完整执行本身作为 execution 审计证据，
                  不另建 PhaseResolution，也不采集不会持久化的处置理由。
                </p>
              ) : (
                <p className="mt-3 text-xs leading-5 text-teal-800">请选择一种处置方式后继续。</p>
              )}
            </section>
          ) : null}

          {canAssessArchitectureImpact ? (
            <section
              className="mb-5 rounded-2xl border border-teal-200 bg-teal-50/50 p-4"
              aria-labelledby="architecture-impact-check-title"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 id="architecture-impact-check-title" className="text-sm font-semibold text-slate-950">
                    Architecture Impact Check
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    先判断本次需求对已批准架构的影响，再决定是否运行架构师。
                  </p>
                </div>
                <Badge variant={architectureBaseline ? "info" : "muted"}>
                  {architectureBaseline
                    ? `基线 Option ${architectureBaseline.selection.optionId}`
                    : "暂无可复用架构基线"}
                </Badge>
              </div>
              {architectureBaseline ? (
                <p className="mt-3 rounded-lg bg-white/80 px-3 py-2 text-[11px] leading-5 text-slate-500 ring-1 ring-teal-100">
                  来源：{architectureBaseline.sourceRunTitle} · 批准于 {formatDate(architectureBaseline.approvedAt)}
                </p>
              ) : (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                  Reuse 与 Partial 需要已批准架构基线；当前仍可选择无需架构工作或完整重跑。
                </p>
              )}

              <fieldset className="mt-3">
                <legend className="sr-only">选择架构影响范围</legend>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {ARCHITECTURE_IMPACT_OPTIONS.map((option) => {
                    const disabled = (
                      (option.value === "reuse" || option.value === "partial")
                      && !architectureBaseline
                    ) || (
                      option.value === "skip"
                      && workType !== "bug"
                      && workType !== "technical"
                    ) || (
                      option.value === "skip"
                      && !hasEvidenceRefs
                    );
                    return (
                    <label
                      key={option.value}
                      className={cn(disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer")}
                    >
                      <input
                        type="radio"
                        name={`architecture-impact-${phase.id ?? phase.phaseId}`}
                        value={option.value}
                        checked={architectureImpactChoice === option.value}
                        disabled={disabled}
                        onChange={() => selectArchitectureImpactChoice(option.value)}
                        className="peer sr-only"
                      />
                      <span
                        className={cn(
                          "block h-full rounded-xl border bg-white px-3 py-3 transition peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2",
                          architectureImpactChoice === option.value
                            ? "border-teal-400 ring-1 ring-teal-200"
                            : "border-slate-200 hover:border-slate-300",
                        )}
                      >
                        <span className="block text-xs font-semibold text-slate-900">{option.title}</span>
                          <span className="mt-1 block text-[11px] leading-4 text-slate-500">
                            {option.description}
                          </span>
                          {option.value === "skip" && disabled ? (
                            <span className="mt-1 block text-[10px] font-semibold text-amber-700">
                              仅限带证据引用的 Bug / 技术任务
                            </span>
                          ) : null}
                      </span>
                    </label>
                    );
                  })}
                </div>
              </fieldset>

              {architectureImpactChoice === "skip"
                || architectureImpactChoice === "reuse"
                || architectureImpactChoice === "partial" ? (
                <label className="mt-4 block">
                  <span className="text-xs font-semibold text-slate-700">判断依据</span>
                  <Textarea
                    value={architectureImpactRationale}
                    maxLength={2_000}
                    onChange={(event) => setArchitectureImpactRationale(event.target.value)}
                    placeholder={architectureImpactChoice === "skip"
                      ? "说明为什么该工作不影响系统边界、集成、数据、安全或 NFR…"
                      : architectureImpactChoice === "reuse"
                        ? "说明为什么本次需求不会改变边界、选型、NFR 或架构规则…"
                        : "说明受影响的架构范围，以及为什么无需重新选型…"}
                    aria-invalid={Boolean(
                      architectureImpactRationale
                      && !isArchitectureImpactRationaleValid(architectureImpactRationale)
                    )}
                    className="mt-1.5 min-h-24 bg-white"
                  />
                  <span className="mt-1.5 block text-[11px] leading-4 text-slate-500">
                    至少 10 个字符；该判断会随架构基线和上游产物一起留痕。
                  </span>
                </label>
              ) : architectureImpactChoice === "full" ? (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  完整重跑分两步：本次先刷新 Architecture、Discovery 与 Options，随后人工选型并生成完整架构包。
                </p>
              ) : (
                <p className="mt-3 text-xs leading-5 text-teal-800">请选择一种影响范围后继续。</p>
              )}
            </section>
          ) : hasAssessedPartialImpact && phase.architectureImpact ? (
            <section className="mb-5 rounded-xl border border-teal-200 bg-teal-50/50 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-teal-950">已确认局部架构更新</div>
                <Badge variant="info">沿用 Option {phase.architectureImpact.selection.optionId}</Badge>
              </div>
              <p className="mt-1 text-xs leading-5 text-teal-800">
                本次 Codex 只能更新已评估范围：
                {partialAllowedOutputKeys.map(artifactLabel).join("、")}。
              </p>
            </section>
          ) : null}

          <div className="rounded-xl border border-slate-200 bg-slate-950 p-4 text-slate-100">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <TerminalSquare className="h-4 w-4 text-teal-300" aria-hidden />
                {showsImpactAssessmentOnly
                  ? routedImpactPhaseId && canAssessRoutedImpact
                    ? phaseImpactTitle(routedImpactPhaseId)
                    : "Architecture Impact"
                  : "Codex Terminal"}
              </div>
              <Badge variant={showsImpactAssessmentOnly ? "info" : runnerMode === "fake" ? "warning" : runnerMode === "real" ? "success" : "muted"}>
                {showsImpactAssessmentOnly
                  ? routedImpactChoice || architectureImpactChoice ? "仅记录路由判断" : "等待选择"
                  : runnerMode === "fake" ? "模拟执行" : runnerMode === "real" ? "真实执行" : "检测中"}
              </Badge>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-400">
              {canAssessRoutedImpact && routedImpactPhaseId
                ? routedImpactChoice === "direct"
                  ? "平台会采用已确认的 Change Contract，不运行 PM / BA；本次路由判断仍会留痕。"
                  : routedImpactChoice === "skip"
                    ? "平台会记录无需设计工作的理由并完成本阶段，不启动 Designer。"
                    : routedImpactChoice === "reuse"
                      ? "平台会继承已批准基线并完成本阶段，本次不启动 Codex。"
                      : routedImpactChoice === "partial"
                        ? "平台会先记录局部影响范围；确认后再单独启动 Codex 更新这些输出。"
                        : routedImpactChoice === "full"
                          ? "平台会在本窗口直接启动当前角色，生成选定的完整阶段产物。"
                          : "请选择处置方式；选择前不会启动 Codex。"
                : showsArchitectureImpactOnly
                  ? architectureImpactChoice === "skip"
                    ? "平台会记录架构豁免理由并完成本阶段，本次生成 0 项架构产物。"
                    : architectureImpactChoice === "reuse"
                  ? "平台会复用已批准架构基线并完成本阶段，本次生成 0 项架构产物。"
                  : architectureImpactChoice === "partial"
                    ? "平台会继承已批准架构基线并记录局部更新范围；确认后再运行 Codex。"
                    : "请选择复用、局部更新或完整重跑；选择前不会启动 Codex。"
                : runnerMode === "fake"
                ? "当前服务处于 Fake 模式，只会生成模拟产物，不会调用 Codex。"
                : runnerMode === "real"
                  ? "Codex CLI 会在项目根目录真实执行当前角色任务。平台负责阶段边界、输入选择与审核。"
                  : healthQuery.isError
                    ? "无法确认服务运行模式，请检查本地 API 后重试。"
                  : "正在确认本地 API 的 Codex 运行模式…"}
            </p>
          </div>

        {!showsImpactAssessmentOnly ? (
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
        ) : null}

        <div className="mt-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              {isImplementationPhase ? "实施依据（平台自动选择）" : "上游审核产物"}
            </h3>
            {candidates.length && !isImplementationPhase ? (
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
          {isImplementationPhase ? (
            <p className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-800">
              这里没有需要你决定的选项。平台会自动采用当前 Run 已批准的 Product、Design 和 Architecture 输入；启动前还会检查文档内部是否仍写着 Blocked。
            </p>
          ) : null}
          {candidates.length ? (
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {candidates.map((artifact) => {
                const key = keyForArtifact(artifact);
                const checked = selected.includes(artifact.id);
                const required = requiredKeys.has(key);
                return (
                  <div
                    key={artifact.id}
                    onClick={isImplementationPhase ? undefined : () => {
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
                      (mutation.isPending || isImplementationPhase) && "cursor-default",
                    )}
                  >
                    {isImplementationPhase ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" aria-hidden />
                    ) : (
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
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                        {artifactLabel(key)}
                        {required ? <Badge variant="info">自动采用</Badge> : null}
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
              {effectiveInputKeys.length
                ? "暂时没有可用的上游产物。只有审核通过的产物才会出现在这里。"
                : "这是第一个阶段，不需要选择上游产物。"}
            </div>
          )}
          {missingRequiredInputKeys.length > 0 ? (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
              还需选择有效阶段输入：{missingRequiredInputKeys.map(artifactLabel).join("、")}。
            </p>
          ) : null}
        </div>

        <div className="mt-6 border-t border-slate-100 pt-5">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-slate-900">
              {isImplementationPhase ? "工程证据包（平台自动生成）" : "本次预期输出"}
            </h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {isImplementationPhase
                ? selectedOutputs.length === executableOutputKeys.length
                  ? "正常实施会自动生成完整证据包。它们记录同一次代码变更，不是七个需要你选择或手工填写的任务。"
                  : `这是从审核页发起的证据修复，本次只更新已选的 ${selectedOutputs.length} 份记录；只有实现事实未变化时才使用。`
              : canAssessRoutedImpact && !routedImpactChoice
                ? "先选择阶段处置方式；Partial 声明受影响输出，Full 直接选择本次 Codex 交付。"
                : canAssessRoutedImpact && routedImpactChoice === "partial"
                  ? routedImpactPhaseId === "design"
                    ? "Design Partial 必须包含设计规格；可按实际影响追加基线、HTML 原型或 Figma，未选产物保持只读。"
                    : "勾选本次允许 Codex 更新的精确 PRD / Stories 输出；未选择的基线产物保持只读。"
                  : runsRoutedFullExecution
                    ? "选择本次完整执行要生成的产物；Change Contract 是不可变上下文，不会成为可写输出。"
                  : canAssessRoutedImpact
                    ? "本次只记录处置判断，不在这个步骤生成阶段产物。"
                : canAssessArchitectureImpact && !architectureImpactChoice
                ? "请选择复用、局部更新或完整重跑；平台不会替你推断影响范围。"
                : canAssessArchitectureImpact
                  && (architectureImpactChoice === "skip" || architectureImpactChoice === "reuse")
                  ? architectureImpactChoice === "skip"
                    ? "架构豁免不会生成产物；理由和当前输入会作为可审核处置证据。"
                    : "复用不会生成新架构产物；平台将完整继承已批准基线并完成架构阶段。"
                  : isArchitecturePartialMode
                    ? "只允许更新影响评估范围内的选型后产物；Architecture 索引必须同步刷新。"
              : phase.phaseId === "architecture" && !architectureSelectionRecorded
                ? REQUIRED_ARCHITECTURE_BOOTSTRAP_OUTPUT_KEYS.every((key) =>
                    existingOutputKeys.includes(key)
                  )
                  ? "当前停在人工选型检查点；只能重跑索引、发现上下文或 options，选型后产物暂时锁定。"
                  : "先补齐架构索引、发现上下文和 options；选型后产物将在人工记录有效 Option 后解锁。"
                : phase.phaseId === "architecture"
                  ? "已记录有效选型；默认刷新架构索引和全部选型后产物，已有完整包也可局部重跑。"
                : hasExistingArtifacts
                ? "已有阶段产物，可只选择需要调整的局部范围；未选择的产物会保持不变。"
                : isDesignPhase
                  ? "首次设计执行必须包含设计基线和设计规格，HTML 原型与 Figma 可按需追加。"
                  : "首次执行需要生成本阶段的全部注册产物。"}
            </p>
          </div>
          {isImplementationPhase ? (
            <div className="rounded-xl border border-teal-200 bg-teal-50/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-slate-900">
                  {selectedOutputs.length === executableOutputKeys.length
                    ? "1 个工程结果包"
                    : `仅更新：${selectedOutputs.map(artifactLabel).join("、")}`}
                </div>
                <Badge variant="info">自动更新 {selectedOutputs.length} 份记录</Badge>
              </div>
              {selectedOutputs.length === executableOutputKeys.length ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  {(["开工准备", "实现记录", "质量与交付"] as const).map((stage) => (
                    <div key={stage} className="rounded-lg bg-white px-3 py-2.5 ring-1 ring-teal-100">
                      <div className="text-xs font-semibold text-slate-800">{stage}</div>
                      <p className="mt-1 text-[11px] leading-4 text-slate-500">
                        {ENGINEERING_ARTIFACT_GUIDES
                          .filter((guide) => guide.stage === stage && selectedOutputs.includes(guide.key))
                          .map((guide) => artifactLabel(guide.key))
                          .join("、")}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
              <p className="mt-3 text-xs leading-5 text-teal-900">
                {selectedOutputs.length === executableOutputKeys.length
                  ? "你不需要在这里选 Markdown。启动成功表示前置条件已通过；随后 Codex 才会开始改源码、补测试和写这些记录。"
                  : "你不需要手写 Markdown。本次目标是按机器反馈修复已选记录，并以现有代码、测试和命令结果为事实基线；若事实本身不成立，Codex 必须停下并如实报告，不能只改文字冒充通过。"}
              </p>
            </div>
          ) : (canAssessRoutedImpact
              && routedImpactChoice !== "partial"
              && routedImpactChoice !== "full")
            || (canAssessArchitectureImpact
              && (
                architectureImpactChoice === ""
                || architectureImpactChoice === "skip"
                || architectureImpactChoice === "reuse"
              )) ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-xs leading-5 text-slate-500">
              {canAssessRoutedImpact
                ? routedImpactChoice
                  ? "本步骤生成 0 项产物；确认处置后，平台会完成或准备本阶段。"
                  : "选择处置方式后，这里会显示需要更新的产物范围。"
                : architectureImpactChoice === "skip"
                  ? "本次生成 0 项产物；确认后记录架构豁免并完成本阶段。"
                  : architectureImpactChoice === "reuse"
                  ? "本次生成 0 项产物；确认后复用基线中的完整架构包。"
                  : "选择影响范围后，这里会显示需要生成或更新的产物。"}
            </div>
          ) : (
          <div className="grid gap-2 sm:grid-cols-2">
              {visibleOutputOptions.map((output) => {
                const checked = selectedOutputs.includes(output.key);
                const isFigma = output.key === "figma-handoff";
                const locked = canAssessRoutedImpact && !runsRoutedFullExecution
                  ? routedImpactChoice !== "partial"
                  : phase.resolution?.mode === "partial"
                    ? phase.executions.length === 0
                  : isArchitecturePartialMode
                  ? output.key === "architecture" || isFirstAssessedPartialExecution
                  : isPhaseOutputLocked({
                    phaseId: phase.phaseId,
                    outputKey: output.key,
                    hasExistingArtifacts,
                    architectureSelectionRecorded,
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
                        {locked && !output.downstreamRequired ? (
                          <Badge variant="muted">
                            {isArchitecturePartialMode
                              ? isFirstAssessedPartialExecution
                                ? "首次局部更新必需"
                                : "局部更新必需"
                              : "首次执行必需"}
                          </Badge>
                        ) : null}
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
                      {output.engineeringGuide ? (
                        <span className="mt-2 block rounded-md bg-white/80 px-2.5 py-2 text-[11px] leading-4 text-slate-600 ring-1 ring-slate-200/70">
                          <strong>{output.engineeringGuide.stage} · {output.engineeringGuide.timing}</strong>
                          <br />你检查：{output.engineeringGuide.humanCheck}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
          </div>
          )}

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
                  {submitsRoutedImpactAssessment || submitsArchitectureImpactAssessment
                    ? "本次影响处理"
                    : "本次将交付"}
                </h3>
                <Badge variant="muted">
                  {(canAssessRoutedImpact
                      && routedImpactChoice !== "partial"
                      && routedImpactChoice !== "full")
                    || architectureImpactChoice === "skip"
                    || architectureImpactChoice === "reuse"
                    ? "0 项生成"
                    : `${selectedOutputs.length} 项产物`}
                </Badge>
              </div>
              {canAssessRoutedImpact
                && routedImpactChoice !== "partial"
                && routedImpactChoice !== "full" ? (
                <p className="mt-3 text-xs leading-5 text-slate-600">
                  本次只记录 {routedImpactChoice ? "已选择的阶段处置" : "待选择的阶段处置"}；不会启动 Codex。
                </p>
              ) : architectureImpactChoice === "skip" ? (
                <p className="mt-3 text-xs leading-5 text-slate-600">
                  本次不生成架构产物；平台会保存豁免理由和选定输入。
                </p>
              ) : architectureImpactChoice === "reuse" ? (
                <p className="mt-3 text-xs leading-5 text-slate-600">
                  完整复用 {architectureBaseline?.artifacts.length ?? 0} 项已批准架构产物；不会启动 Codex。
                </p>
              ) : selectedOutputs.length > 0 ? (
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
              ) : (
                <p className="mt-3 text-xs leading-5 text-slate-500">尚未选择影响范围或预期输出。</p>
              )}
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
        {implementationStartHelp ? (
          <div role="alert" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <div className="font-semibold">{implementationStartHelp.title}</div>
            <p className="mt-1 text-xs leading-5 text-amber-900">{implementationStartHelp.summary}</p>
            <ol className="mt-3 space-y-2">
              {implementationStartHelp.actions.map((action, index) => (
                <li key={`${action.code}-${index}`} className="rounded-lg bg-white/80 px-3 py-2.5 ring-1 ring-amber-200/80">
                  <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
                    <Badge variant="warning">{action.roleLabel}</Badge>
                    <span>{index + 1}. {action.title}</span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-amber-900">{action.description}</p>
                  {action.blockerIds.length > 0 ? (
                    <p className="mt-1 font-mono text-[10px] text-amber-700">
                      Blockers: {action.blockerIds.join("、")}
                    </p>
                  ) : null}
                  {action.blockers.length > 0 ? (
                    <ul className="mt-2 space-y-1.5 text-xs leading-5 text-amber-900">
                      {action.blockers.map((blocker) => (
                        <li key={`${action.code}-${blocker.id}`} className="rounded-md bg-amber-50/80 px-2.5 py-2">
                          <strong>{blocker.id || "待决定"}：</strong>{blocker.decision || "缺少明确决定"}
                          {blocker.nextAction ? <span className="block text-amber-700">下一步：{blocker.nextAction}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => onNavigatePhase(
                      action.role === "designer"
                        ? "design"
                        : action.role === "architect"
                          ? "architecture"
                          : "discovery",
                    )}
                  >
                    前往 {action.roleLabel}
                  </Button>
                </li>
              ))}
            </ol>
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
                !hasInputsForCurrentAction
                || !hasAllRequiredOutputs
                || !routedImpactAssessmentReady
                || !hasValidArchitectureImpactRationale
                || hasUnsupportedFigmaOutput
                || !canUseSelectedCodexConfiguration
                || (!showsImpactAssessmentOnly && !runnerMode)
              }
            >
              {submitsRoutedImpactAssessment || submitsArchitectureImpactAssessment ? (
                <CheckCircle2 className="h-4 w-4" aria-hidden />
              ) : (
                <Play className="h-4 w-4" aria-hidden />
              )}
              {canAssessRoutedImpact && !routedImpactChoice
                ? "请选择阶段处置方式"
                : canAssessRoutedImpact
                  ? routedImpactChoice === "partial"
                    ? "确认局部影响范围"
                    : routedImpactChoice === "full"
                      ? runnerMode === "fake" ? "启动完整模拟执行" : "启动完整 Codex 执行"
                      : routedImpactChoice === "reuse"
                        ? "确认复用基线"
                        : routedImpactChoice === "skip"
                          ? "确认跳过设计"
                          : "确认直接采用合同"
                : canAssessArchitectureImpact && !architectureImpactChoice
                ? "请选择架构影响范围"
                : architectureImpactChoice === "reuse"
                ? "确认复用架构"
                : architectureImpactChoice === "skip"
                  ? "确认无需架构工作"
                : canAssessArchitectureImpact && architectureImpactChoice === "partial"
                  ? "确认局部更新范围"
                  : hasAssessedPartialImpact
                    ? "启动局部架构更新"
                    : canAssessArchitectureImpact && architectureImpactChoice === "full"
                      ? "开始完整架构重跑"
                      : runnerMode === "fake"
                ? "启动模拟执行"
                : runnerMode === "real"
                  ? isImplementationEvidenceRepair
                    ? "检查并修复工程证据"
                    : phase.phaseId === "implementation" ? "检查条件并开始写代码" : "启动真实 Codex"
                  : "检测运行模式"}
            </Button>
          </div>
        </div>
      </fieldset>
    </Dialog>
  );
}

function ReviewDialog({
  runId,
  phase,
  definition,
  decisionGate,
  initialArtifactId,
  open,
  onOpenChange,
  onRerunArtifact,
  onRerunOutputs,
  onNavigateDecisionPhase,
  onDecisionSaved,
}: {
  runId: string;
  phase: PhaseRun;
  definition: PhaseDefinition;
  decisionGate?: PhaseHumanDecisionGate;
  initialArtifactId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRerunArtifact: (artifactKey: string) => void;
  onRerunOutputs: (artifactKeys: string[]) => void;
  onNavigateDecisionPhase: (phaseId: HumanDecisionPhaseId) => void;
  onDecisionSaved: (phaseId: HumanDecisionPhaseId) => void;
}) {
  const queryClient = useQueryClient();
  const implementationReviewOrder = [
    "implementation-notes",
    "engineering-test-evidence",
    "engineering-review",
    "implementation-plan",
    "implementation-tasks",
    "engineering-session-log",
    "engineering-provenance",
  ];
  const reviewArtifacts = phase.phaseId === "implementation"
    ? [...phase.artifacts].sort((left, right) => {
        const leftIndex = implementationReviewOrder.indexOf(keyForArtifact(left));
        const rightIndex = implementationReviewOrder.indexOf(keyForArtifact(right));
        return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
          - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
      })
    : phase.artifacts;
  const preservedDraftRef = useRef<{
    artifactId: string;
    content: string;
  }>();
  const [selectedArtifactId, setSelectedArtifactId] = useState(
    initialArtifactId ?? reviewArtifacts[0]?.id ?? "",
  );
  const [artifactView, setArtifactView] = useState<"preview" | "edit">("preview");
  const [draftContent, setDraftContent] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string>();
  const [engineeringGateHelp, setEngineeringGateHelp] = useState<EngineeringGateGuidance>();
  const [revisionError, setRevisionError] = useState<string>();
  const [reviewConflict, setReviewConflict] = useState<string>();
  const [decisionResponses, setDecisionResponses] = useState<Record<string, string>>({});
  const actionableDecisionItems = actionableHumanDecisionItems(decisionGate);
  const dependentDecisionItems = dependentHumanDecisionItems(decisionGate);
  const deferredDecisionItems = deferredHumanDecisionItems(decisionGate);
  const nonBlockingDecisionItems = nonBlockingHumanDecisionItems(decisionGate);
  const selectedSummary = phase.artifacts.find((artifact) => artifact.id === selectedArtifactId);
  const artifactQuery = useQuery({
    queryKey: ["artifact", selectedArtifactId],
    queryFn: () => api.getArtifact(selectedArtifactId),
    enabled: Boolean(selectedArtifactId),
  });
  const artifact = artifactQuery.data ?? selectedSummary;
  const content = artifact?.content;
  const artifactKey = artifact ? keyForArtifact(artifact) : "";
  const selectedEngineeringGuide = ENGINEERING_ARTIFACT_GUIDES.find(
    (guide) => guide.key === artifactKey,
  );
  const artifactPath = artifact?.filePath || artifact?.path || "";
  const isHtmlArtifact =
    artifactKey === "design-prototype" || /\.(?:html?|xhtml)$/iu.test(artifactPath);
  const isMermaidArtifact =
    ["architecture-c4-context", "architecture-c4-containers"].includes(artifactKey)
    || /\.(?:mmd|mermaid)$/iu.test(artifactPath);
  const artifactFormat = isHtmlArtifact ? "HTML" : isMermaidArtifact ? "Mermaid" : "Markdown";
  const isSuperseded = artifact?.superseded || artifact?.reviewStatus === "superseded";
  const isImpactReadOnly = artifactKey === "change-contract" || (phase.resolution
    ? !isResolutionOutputMutable(phase.resolution, artifactKey)
    : phase.phaseId === "architecture"
      && !isArchitectureImpactOutputMutable(
        phase.architectureImpact?.mode,
        phase.architectureImpact?.affectedOutputKeys,
        artifactKey,
      ));
  const isDirty = typeof content === "string" && draftContent !== content;
  const revisionByteLength = artifactRevisionByteLength(draftContent);
  const revisionContentInvalid = artifactRevisionContentInvalid(draftContent);
  const canEdit =
    typeof content === "string"
    && Boolean(artifact?.contentHash)
    && !isSuperseded
    && !isImpactReadOnly
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
    && !isImpactReadOnly
    && [
      "ready",
      "awaiting_review",
      "approved",
      "changes_requested",
      "rejected",
      "failed",
    ].includes(phase.status);
  const currentArtifactHeads = phase.artifacts.filter(
    (candidate) => !candidate.superseded && candidate.reviewStatus !== "superseded",
  );
  const currentArtifactKeys = new Set(currentArtifactHeads.map((candidate) => keyForArtifact(candidate)));
  const missingApprovalOutputKeys = requiredPhaseApprovalOutputKeys(
    phase.phaseId,
    definition.outputs,
  ).filter((key) => !currentArtifactKeys.has(key));
  const currentOptionsHead = currentArtifactHeads.find(
    (candidate) => keyForArtifact(candidate) === "architecture-options",
  );
  const currentDiscoveryHead = currentArtifactHeads.find(
    (candidate) => keyForArtifact(candidate) === "architecture-discovery-context",
  );
  const currentOptionsQuery = useQuery({
    queryKey: ["artifact", currentOptionsHead?.id ?? "architecture-options-missing"],
    queryFn: () => api.getArtifact(currentOptionsHead!.id),
    enabled: Boolean(currentOptionsHead?.id),
  });
  const currentOptionsContent = currentOptionsQuery.data?.content
    ?? currentOptionsHead?.content
    ?? "";
  const architectureOptions = useMemo(
    () => architectureOptionSummaries(currentOptionsContent),
    [currentOptionsContent],
  );
  const architectureSelection = phase.phaseId === "architecture"
    ? phase.architectureImpact?.selection
      ?? (
        currentOptionsHead
        && currentDiscoveryHead
        ? architectureSelectionFromReviews(
            phase.reviews,
            currentOptionsHead.id,
            [currentOptionsHead.id, currentDiscoveryHead.id],
          )
        : undefined
      )
    : undefined;
  const isPartialArchitectureImpactReview = phase.phaseId === "architecture"
    && phase.architectureImpact?.mode === "partial";
  const staleArchitectureOutputKeys = architectureSelection
    ? architectureOutputKeysRequiringRefresh({
        impactMode: phase.architectureImpact?.mode,
        affectedOutputKeys: phase.architectureImpact?.affectedOutputKeys,
        availableOutputKeys: definition.outputs,
        artifacts: currentArtifactHeads.map((artifactHead) => ({
          artifactKey: keyForArtifact(artifactHead),
          revision: artifactHead.revision,
          createdAt: artifactHead.createdAt,
        })),
        selectedAt: architectureSelection.selectedAt,
      })
    : [];
  const isArchitectureSelectionCheckpoint =
    phase.phaseId === "architecture" && !architectureSelection;
  const architectureSelectionIdInComment = parseArchitectureSelectionId(comment.trim());
  const architectureReselectionBlocked = isArchitectureReselectionBlockedByImpact(
    phase.architectureImpact?.mode,
    comment.trim(),
  );
  const showsArchitectureSelectionAction = Boolean(architectureSelectionIdInComment)
    && !architectureReselectionBlocked;

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

  useEffect(() => {
    setDecisionResponses(Object.fromEntries(
      actionableDecisionItems.map((item) => [
        item.id,
        item.response
          ?? (item.kind === "work" ? `请完成该待办并更新正式产物：${item.nextAction}` : ""),
      ]),
    ));
  }, [
    decisionGate?.phaseId,
    decisionGate?.items.map(({ id, response, blocking, actionPhaseId }) => (
      `${id}:${response ?? ""}:${blocking}:${actionPhaseId}`
    )).join("|"),
  ]);

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
      architectureSelectionId?: string;
    }) => api.reviewPhase(
      runId,
      phase.phaseId,
      decision,
      comment.trim(),
      expectedArtifactIds,
    ),
    onSuccess: async (_, variables) => {
      setEngineeringGateHelp(undefined);
      await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      if (variables.architectureSelectionId) {
        onDecisionSaved("architecture");
        return;
      }
      onOpenChange(false);
    },
    onError: async (mutationError) => {
      if (mutationError instanceof ApiError && mutationError.code === "PHASE_HUMAN_DECISIONS_REQUIRED") {
        setEngineeringGateHelp(undefined);
        setError("这个阶段还有未关闭的决定或角色待办。请先在上方处理，再让对应角色更新正式产物。");
        await queryClient.invalidateQueries({ queryKey: ["run", runId] });
        return;
      }
      const gateHelp = engineeringEvidenceGateGuidance(mutationError);
      if (gateHelp) {
        setError(undefined);
        setEngineeringGateHelp(gateHelp);
        return;
      }
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
  const decisionCaptureMutation = useMutation({
    mutationFn: (variables: {
      phaseId: HumanDecisionPhaseId;
      responses: Array<{ id: string; response: string }>;
      expectedArtifactIds: string[];
    }) => api.captureHumanDecisions(
      runId,
      variables.phaseId,
      variables.responses,
      variables.expectedArtifactIds,
    ),
    onMutate: () => setError(undefined),
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      onDecisionSaved(variables.phaseId);
    },
    onError: async (mutationError) => {
      setError(
        isArtifactHeadsChangedError(mutationError)
          ? "保存期间正式产物已经变化。页面已刷新，请确认最新内容后再次保存决定。"
          : mutationError instanceof Error
            ? mutationError.message
            : "保存决定失败",
      );
      await queryClient.invalidateQueries({ queryKey: ["run", runId] });
    },
  });
  const isReviewable = phase.status === "awaiting_review";
  const submitDecisionResponses = () => {
    if (!decisionGate || actionableDecisionItems.length === 0) return;
    if (isDirty || revisionMutation.isPending) {
      setError("请先保存或取消当前人工编辑，再提交决定。");
      return;
    }
    const responses = actionableDecisionItems.map((item) => ({
      id: item.id,
      response: (decisionResponses[item.id] ?? "").trim(),
    }));
    const missingDecision = actionableDecisionItems.find(
      (item) => item.kind === "decision" && (decisionResponses[item.id] ?? "").trim().length < 3,
    );
    if (missingDecision) {
      setError(`请回答 ${missingDecision.id}：${missingDecision.title}`);
      return;
    }
    const incompleteMonitoringDecision = actionableDecisionItems.find((item) => {
      const response = (decisionResponses[item.id] ?? "").trim();
      return item.id === "ARCH-OBS-002"
        && /已有监控平台/u.test(response)
        && /【请填写】|平台名称\s*=\s*(?:[；;]|$)|负责人\s*=\s*(?:[；;]|$)/u.test(response);
    });
    if (incompleteMonitoringDecision) {
      setError("选择已有监控平台时，请先把平台名称和负责人补完整；如果目前没有平台，可选择“本地最小诊断（推荐）”。");
      return;
    }
    const expectedArtifactIds = currentArtifactHeadIds(phase.artifacts);
    if (expectedArtifactIds.length === 0) {
      setError("当前阶段没有可用于承接决定的正式产物，请先运行对应角色。");
      return;
    }
    decisionCaptureMutation.mutate({
      phaseId: decisionGate.phaseId,
      responses,
      expectedArtifactIds,
    });
  };
  const submit = (decision: ReviewDecision) => {
    setEngineeringGateHelp(undefined);
    if (isDirty || revisionMutation.isPending) {
      setError("请先保存或取消当前人工编辑，再提交审核结论。");
      return;
    }
    if (!comment.trim()) {
      setError(decision === "approve" ? "请留下简短的审核结论。" : "请说明需要修改的内容。");
      return;
    }
    if (decision === "approve" && decisionGate && decisionGate.blockingCount > 0) {
      setError("还有未关闭的决定、角色待办或上游依赖。请先处理上方清单并让对应角色更新正式产物。");
      return;
    }
    if (decision === "request_changes" && architectureReselectionBlocked) {
      setError("局部更新不能重新选型，请完整重跑。");
      return;
    }
    if (
      decision === "request_changes"
      && architectureSelectionIdInComment
      && decisionGate
      && decisionGate.blockingCount > 0
    ) {
      setError("先完成上方具体架构决定，再让 Architect 刷新 options；刷新后才能选择当前版本的方案。");
      return;
    }
    if (decision === "approve" && isArchitectureSelectionCheckpoint) {
      setError("请先使用 `Selected option: <ID>` 记录一个针对当前 options revision 的人工选型。");
      return;
    }
    if (decision === "approve" && missingApprovalOutputKeys.length > 0) {
      setError(`阶段产物尚未齐全，不能通过：${missingApprovalOutputKeys.join(", ")}`);
      return;
    }
    if (decision === "approve" && staleArchitectureOutputKeys.length > 0) {
      setError(
        isPartialArchitectureImpactReview
          ? `这些产物尚未在本次影响评估后更新：${staleArchitectureOutputKeys.join(", ")}`
          : `这些产物早于人工选型，必须重新生成：${staleArchitectureOutputKeys.join(", ")}`,
      );
      return;
    }
    if (
      decision === "request_changes"
      && architectureSelectionIdInComment
      && !currentOptionsHead
    ) {
      setError("必须先生成 architecture-options 才能记录选型。");
      return;
    }
    const expectedArtifactIds = currentArtifactHeadIds(phase.artifacts);
    if (expectedArtifactIds.length === 0) {
      setError("当前阶段没有可审核的有效产物，请刷新后再试。");
      return;
    }
    setError(undefined);
    reviewMutation.mutate({
      decision,
      expectedArtifactIds,
      architectureSelectionId: decision === "request_changes"
        ? architectureSelectionIdInComment
        : undefined,
    });
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
      description={phase.phaseId === "implementation"
        ? "先看实现说明、独立测试证据和工程七镜；其余四份是可追溯审计明细。通过后会解锁 Tester。"
        : phase.phaseId === "verification"
          ? `先确认 ${TEST_REPORT_REVIEW_POINTS.join("；")}。通过只代表 Verification 证据完整，不代表 PR、合并或发布已批准。`
          : "逐份查看或人工修订阶段产物，也可只重跑当前产物。通过后会解锁下一角色。"}
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
          {reviewArtifacts.length > 1 ? (
            <div className="scrollbar-thin shrink-0 overflow-x-auto border-b border-slate-100 p-3">
              {phase.phaseId === "implementation" ? (
                <div className="mb-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] leading-4 text-sky-800">
                  <strong>建议先看 3 份：</strong>实现说明 → 独立测试证据 → 工程七镜。计划、任务、会话日志和 PR 证据链用于追溯，通常不用逐字阅读；审批门仍会自动检查全部 7 份。
                </div>
              ) : null}
              <Tabs value={selectedArtifactId} onValueChange={changeArtifact}>
                <TabsList className="w-max">
                  {reviewArtifacts.map((item) => (
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
                {artifactPath || `${artifactFormat} preview`}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{artifactFormat}</Badge>
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
                  {isHtmlArtifact
                    ? " HTML 将在保存后继续通过隔离沙箱预览。"
                    : isMermaidArtifact
                      ? " Mermaid 将在保存后直接于浏览器中重新渲染。"
                      : ""}
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
                    正在渲染 {artifactFormat}…
                  </div>
                }
              >
                {isHtmlArtifact ? (
                  <HtmlPreview content={content} />
                ) : isMermaidArtifact ? (
                  <MermaidPreview content={content} />
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
          {deferredDecisionItems.length > 0 ? (
            <section
              className="mb-5 rounded-xl border border-sky-200 bg-sky-50 p-4"
              aria-label="实现后验证交接"
            >
              <div className="flex items-start gap-2.5">
                <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" aria-hidden />
                <div>
                  <div className="text-sm font-semibold text-slate-950">
                    实现后验证 · 当前不阻塞
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-700">
                    这些检查依赖可运行实现。确认设计已经写清行为和通过条件即可；Software Engineer 完成代码后，由 Tester 在 Verification 记录真实证据。
                  </p>
                </div>
              </div>
              <div className="mt-3 space-y-2">
                {deferredDecisionItems.map((item) => (
                  <div key={item.id} className="rounded-lg border border-sky-100 bg-white p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-slate-900">{item.id} · {item.title}</div>
                      <Badge variant="muted">{humanDecisionKindLabel(item)}</Badge>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-4 text-slate-600">{item.prompt}</p>
                    <p className="mt-1.5 text-[10px] leading-4 text-slate-500">
                      验证负责人：{item.owner} · 证据要求：{item.nextAction}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {nonBlockingDecisionItems.length > 0 ? (
            <section className="mb-5 rounded-xl border border-slate-200 bg-white p-4" aria-label="不阻塞的开放问题">
              <div className="text-sm font-semibold text-slate-950">开放问题 · 当前不阻塞</div>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                这些问题不改变当前实现合同，不需要你现在回答；若答案会改变范围或行为，应重新执行 Impact Check。
              </p>
              <ul className="mt-3 space-y-2">
                {nonBlockingDecisionItems.map((item) => (
                  <li key={item.id} className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-4 text-slate-700">
                    <span className="font-semibold">{item.id} · {item.title}</span>
                    <span className="mt-1 block">{item.prompt}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {decisionGate && decisionGate.blockingCount > 0 ? (
            <section
              className={cn(
                "mb-5 rounded-xl border p-4",
                decisionGate.inconsistentApproval
                  ? "border-rose-200 bg-rose-50"
                  : "border-amber-200 bg-amber-50",
              )}
              aria-label="本阶段决定与待办"
            >
              <div className="flex items-start gap-2.5">
                <AlertCircle className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  decisionGate.inconsistentApproval ? "text-rose-700" : "text-amber-700",
                )} aria-hidden />
                <div>
                  <div className="text-sm font-semibold text-slate-950">
                    {humanDecisionGateHeadline(decisionGate)}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-700">
                    {decisionGate.inconsistentApproval
                      ? "这是旧流程留下的不一致：通过状态不代表这些问题已经解决。"
                      : "先完成这里的决定与待办；正式产物更新后，审批门才会放行。"}
                  </p>
                </div>
              </div>

              {dependentDecisionItems.length > 0 ? (
                <div className="mt-4 space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    应回到上游处理
                  </div>
                  {dependentDecisionItems.map((item) => (
                    <div key={item.id} className="rounded-lg border border-slate-200 bg-white p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-xs font-semibold text-slate-900">{item.id} · {item.title}</div>
                          <p className="mt-1 text-[11px] leading-4 text-slate-600">{item.prompt}</p>
                        </div>
                        <Badge variant="muted" className="shrink-0">{humanDecisionKindLabel(item)}</Badge>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2 bg-white"
                        onClick={() => onNavigateDecisionPhase(item.actionPhaseId)}
                      >
                        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                        去 {HUMAN_DECISION_PHASE_LABELS[item.actionPhaseId]} 处理
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}

              {actionableDecisionItems.length > 0 ? (
                <div className="mt-4 space-y-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    在本阶段处理
                  </div>
                  {actionableDecisionItems.map((item) => (
                    <div key={item.id} className="rounded-lg border border-slate-200 bg-white p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-slate-900">{item.id} · {item.title}</div>
                        <Badge variant={item.kind === "decision" ? "warning" : "info"}>
                          {humanDecisionKindLabel(item)}
                        </Badge>
                      </div>
                      <p className="mt-1.5 text-[11px] leading-4 text-slate-600">{item.prompt}</p>
                      <p className="mt-1.5 text-[10px] leading-4 text-slate-500">
                        负责人：{item.owner} · 下一步：{item.nextAction}
                      </p>
                      {item.response ? (
                        <div className="mt-2 rounded-md bg-teal-50 px-2.5 py-2 text-[10px] leading-4 text-teal-800">
                          上次已记录：{item.response}。正式产物仍需由角色更新后才算关闭。
                        </div>
                      ) : null}
                      {item.kind === "decision" ? (
                        <>
                          {humanDecisionPresets(item).length > 0 ? (
                            <div className="mt-2 grid gap-2">
                              {humanDecisionPresets(item).map((preset) => (
                                <button
                                  key={preset.label}
                                  type="button"
                                  className={cn(
                                    "rounded-lg border px-3 py-2 text-left transition",
                                    decisionResponses[item.id] === preset.value
                                      ? "border-teal-500 bg-teal-50 ring-1 ring-teal-500"
                                      : "border-slate-200 bg-slate-50 hover:border-teal-300 hover:bg-teal-50/50",
                                  )}
                                  disabled={decisionCaptureMutation.isPending}
                                  onClick={() => setDecisionResponses((current) => ({
                                    ...current,
                                    [item.id]: preset.value,
                                  }))}
                                >
                                  <span className="block text-xs font-semibold text-slate-900">{preset.label}</span>
                                  <span className="mt-0.5 block text-[10px] leading-4 text-slate-600">{preset.description}</span>
                                </button>
                              ))}
                            </div>
                          ) : null}
                          <Textarea
                            className="mt-2 min-h-24 bg-white text-xs"
                            value={decisionResponses[item.id] ?? ""}
                            disabled={decisionCaptureMutation.isPending}
                            onChange={(event) => setDecisionResponses((current) => ({
                              ...current,
                              [item.id]: event.target.value,
                            }))}
                            placeholder="选择上方建议，或写下明确规则；不要只写“同意”。"
                            aria-label={`回答 ${item.id}`}
                          />
                        </>
                      ) : (
                        <div className="mt-2 rounded-md bg-sky-50 px-2.5 py-2 text-[10px] leading-4 text-sky-800">
                          这不是让你拍板；保存后会退回 {HUMAN_DECISION_ROLE_LABELS[decisionGate.phaseId]} 完成。
                        </div>
                      )}
                    </div>
                  ))}
                  <Button
                    variant="primary"
                    className="w-full"
                    loading={decisionCaptureMutation.isPending}
                    disabled={
                      decisionCaptureMutation.isPending
                      || revisionMutation.isPending
                      || isDirty
                      || dependentDecisionItems.length > 0
                    }
                    onClick={submitDecisionResponses}
                  >
                    <Save className="h-4 w-4" aria-hidden />
                    {actionableDecisionItems.some(({ kind }) => kind === "decision")
                      ? `保存决定并让 ${HUMAN_DECISION_ROLE_LABELS[decisionGate.phaseId]} 更新`
                      : `让 ${HUMAN_DECISION_ROLE_LABELS[decisionGate.phaseId]} 完成待办`}
                  </Button>
                  {dependentDecisionItems.length > 0 ? (
                    <p className="rounded-md bg-amber-100/70 px-2.5 py-2 text-[10px] leading-4 text-amber-900">
                      先处理上游依赖；本阶段变为 Ready 后直接重新运行 {HUMAN_DECISION_ROLE_LABELS[decisionGate.phaseId]}，让它同步最新上游产物并完成自己的待办。
                    </p>
                  ) : null}
                  <p className="text-[10px] leading-4 text-slate-500">
                    保存会记录为“要求修改”，使下游旧结果失效，并立即打开当前角色的重新执行窗口。
                  </p>
                </div>
              ) : null}

              {phase.status === "ready" && (
                dependentDecisionItems.length > 0 || decisionGate.workCount > 0
              ) ? (
                <Button
                  variant="primary"
                  className="mt-4 w-full"
                  onClick={() => onDecisionSaved(decisionGate.phaseId)}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden />
                  运行 {HUMAN_DECISION_ROLE_LABELS[decisionGate.phaseId]} 同步并处理清单
                </Button>
              ) : null}

              {!isReviewable && error ? (
                <div role="alert" className="mt-3 rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs leading-5 text-rose-700">
                  {error}
                </div>
              ) : null}
            </section>
          ) : null}
          {selectedEngineeringGuide ? (
            <div className="mb-4 rounded-xl border border-teal-200 bg-teal-50/60 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="info">{selectedEngineeringGuide.stage}</Badge>
                <span className="text-[11px] font-semibold text-teal-800">{selectedEngineeringGuide.timing}</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-700">{selectedEngineeringGuide.purpose}</p>
              <p className="mt-2 rounded-lg bg-white/80 px-3 py-2 text-xs leading-5 text-slate-700 ring-1 ring-teal-100">
                <strong>你只需检查：</strong>{selectedEngineeringGuide.humanCheck}
              </p>
            </div>
          ) : null}
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
              {isArchitectureSelectionCheckpoint ? (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                  <div className="flex items-center gap-2 font-semibold">
                    <GitBranch className="h-4 w-4" aria-hidden />
                    {decisionGate && decisionGate.blockingCount > 0
                      ? "先做决定，再选方案"
                      : "请选择当前版本的架构方案"}
                  </div>
                  {decisionGate && decisionGate.blockingCount > 0 ? (
                    <p className="mt-1">
                      上方还有具体决定。先保存答案并让 Architect 刷新 options；此时不要继续重跑，也不要提前选方案。
                    </p>
                  ) : (
                    <>
                      <p className="mt-1">
                        选方案不是批准架构。你只是在 A/B/C 中确认方向；保存后 Architect 会生成该方向的正式架构包，再由你做最终审核。
                      </p>
                      <div className="mt-3 grid gap-2">
                        {architectureOptions.map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            className={cn(
                              "rounded-lg border bg-white p-3 text-left transition",
                              architectureSelectionIdInComment === option.id
                                ? "border-teal-500 ring-2 ring-teal-500/20"
                                : "border-amber-200 hover:border-teal-400",
                            )}
                            onClick={() => setComment(`Selected option: ${option.id}`)}
                          >
                            <span className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-slate-950">Option {option.id} · {option.title}</span>
                              {option.recommended ? <Badge variant="success">Architect 推荐</Badge> : null}
                            </span>
                            {option.summary ? <span className="mt-1 block text-slate-700">{option.summary}</span> : null}
                            {option.optimizes ? <span className="mt-1 block text-[11px] text-slate-600">优势：{option.optimizes}</span> : null}
                            {option.givesUp ? <span className="block text-[11px] text-slate-600">代价：{option.givesUp}</span> : null}
                            <span className="mt-2 block font-semibold text-teal-700">选择 Option {option.id}</span>
                          </button>
                        ))}
                        {currentOptionsQuery.isLoading ? (
                          <span className="text-[11px] text-slate-600">正在读取当前 options…</span>
                        ) : architectureOptions.length === 0 ? (
                          <span className="rounded-md bg-white px-2.5 py-2 text-[11px] text-amber-800">
                            当前 options 还不能解析为选项卡；请让 Architect 按标准标题刷新 options。
                          </span>
                        ) : null}
                      </div>
                    </>
                  )}
                  {missingApprovalOutputKeys.length > 0 ? (
                    <p className="mt-1 text-amber-700">
                      待生成：{missingApprovalOutputKeys.map(artifactLabel).join("、")}
                    </p>
                  ) : null}
                </div>
              ) : staleArchitectureOutputKeys.length > 0 ? (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                  {isPartialArchitectureImpactReview
                    ? `以下产物尚未在本次影响评估后更新：${staleArchitectureOutputKeys.map(artifactLabel).join("、")}。请完成本次局部更新后再提交批准。`
                    : `已记录 Option ${architectureSelection?.optionId}，但以下产物仍早于该选型：${staleArchitectureOutputKeys.map(artifactLabel).join("、")}。请执行选型后的默认输出集，再提交批准。`}
                </div>
              ) : null}
              <Field label="审核意见" hint="必填" required>
                <Textarea
                  className="min-h-32 bg-white"
                  placeholder={
                    isArchitectureSelectionCheckpoint
                      ? "Selected option: B\n条件：先验证外部依赖的限流能力。"
                      : "记录你的判断，或者准确描述需要修改的地方…"
                  }
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  required
                  aria-required="true"
                  aria-invalid={Boolean(error || engineeringGateHelp)}
                  aria-describedby={error || engineeringGateHelp ? "review-comment-error" : undefined}
                />
              </Field>
              {architectureReselectionBlocked ? (
                <div
                  role="alert"
                  className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900"
                >
                  局部更新不能重新选型，请完整重跑。请删除 Selected option 标记后提交普通修改意见。
                </div>
              ) : null}
              {error ? (
                <div
                  id="review-comment-error"
                  role="alert"
                  className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs leading-5 text-rose-700"
                >
                  {error}
                </div>
              ) : null}
              {engineeringGateHelp ? (
                <div
                  id="review-comment-error"
                  role="alert"
                  className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs leading-5 text-amber-950"
                >
                  <div className="font-semibold">{engineeringGateHelp.title}</div>
                  <p className="mt-1 text-amber-900">{engineeringGateHelp.summary}</p>
                  <div className="mt-3 rounded-lg border border-amber-300 bg-amber-100/70 px-3 py-2.5">
                    <div className="font-semibold">推荐下一步：{engineeringGateHelp.recommendation.title}</div>
                    <p className="mt-0.5 text-amber-900">{engineeringGateHelp.recommendation.description}</p>
                    <Button
                      type="button"
                      size="sm"
                      className="mt-2"
                      onClick={() => {
                        if (engineeringGateHelp.recommendation.kind === "repair-upstream") {
                          onNavigateDecisionPhase("discovery");
                          return;
                        }
                        onRerunOutputs(engineeringGateHelp.recommendation.outputKeys);
                      }}
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                      {engineeringGateHelp.recommendation.kind === "repair-evidence"
                        ? `让 Software Engineer 只修复这 ${engineeringGateHelp.affectedArtifactKeys.length} 份证据`
                        : engineeringGateHelp.recommendation.title}
                    </Button>
                  </div>
                  <ol className="mt-3 space-y-2">
                    {engineeringGateHelp.actions.map((action, index) => {
                      const targetArtifact = action.artifactKey
                        ? phase.artifacts.find((candidate) => keyForArtifact(candidate) === action.artifactKey)
                        : undefined;
                      return (
                        <li key={action.id} className="rounded-lg bg-white/80 px-3 py-2 ring-1 ring-amber-200/80">
                          <div className="font-semibold">
                            {index + 1}. {action.title} · {action.issueCount} 项
                          </div>
                          <p className="mt-0.5 text-amber-900">{action.description}</p>
                          <ul className="mt-1.5 space-y-1 text-amber-950">
                            {action.reasons.map((reason) => (
                              <li key={reason} className="flex gap-1.5">
                                <span aria-hidden>•</span>
                                <span>{reason}</span>
                              </li>
                            ))}
                          </ul>
                          {targetArtifact || (
                            action.artifactKey
                            && engineeringGateHelp.recommendation.kind === "repair-evidence"
                          ) ? (
                            <div className="mt-2 flex flex-wrap gap-3">
                              {targetArtifact ? (
                                <button
                                  type="button"
                                  className="font-semibold text-teal-700 underline underline-offset-4"
                                  onClick={() => changeArtifact(targetArtifact.id)}
                                >
                                  查看{artifactLabel(action.artifactKey ?? "")}
                                </button>
                              ) : null}
                              {action.artifactKey
                              && engineeringGateHelp.recommendation.kind === "repair-evidence" ? (
                                <button
                                  type="button"
                                  className="font-semibold text-teal-700 underline underline-offset-4"
                                  onClick={() => onRerunOutputs([action.artifactKey!])}
                                >
                                  只重跑这 1 份证据
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ol>
                  {engineeringGateHelp.diagnostics.length > 0 ? (
                    <details className="mt-3">
                      <summary className="cursor-pointer font-semibold">
                        全部 {engineeringGateHelp.issueCount} 条原始校验信息（开发者详情）
                      </summary>
                      <ul className="mt-1.5 space-y-1 font-mono text-[10px] leading-4 text-amber-800">
                        {engineeringGateHelp.diagnostics.map((diagnostic, index) => (
                          <li key={`${index}-${diagnostic}`}>• {diagnostic}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button
                  variant={showsArchitectureSelectionAction ? "primary" : "destructive"}
                  className="px-2"
                  loading={
                    reviewMutation.isPending
                    && reviewMutation.variables?.decision === "request_changes"
                  }
                  disabled={
                    reviewMutation.isPending
                    || revisionMutation.isPending
                    || isDirty
                    || architectureReselectionBlocked
                    || Boolean(
                      architectureSelectionIdInComment
                      && decisionGate
                      && decisionGate.blockingCount > 0
                    )
                  }
                  onClick={() => submit("request_changes")}
                >
                  {showsArchitectureSelectionAction ? (
                    <GitBranch className="h-4 w-4" aria-hidden />
                  ) : (
                    <XCircle className="h-4 w-4" aria-hidden />
                  )}
                  {showsArchitectureSelectionAction ? "记录选型并继续" : "要求修改"}
                </Button>
                <Button
                  variant="success"
                  className="px-2"
                  loading={
                    reviewMutation.isPending
                    && reviewMutation.variables?.decision === "approve"
                  }
                  disabled={
                    reviewMutation.isPending
                    || revisionMutation.isPending
                    || isDirty
                    || missingApprovalOutputKeys.length > 0
                    || isArchitectureSelectionCheckpoint
                    || staleArchitectureOutputKeys.length > 0
                    || Boolean(decisionGate && decisionGate.blockingCount > 0)
                  }
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
