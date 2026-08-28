import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  Circle,
  Database,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  Link2,
  LoaderCircle,
  MessageSquare,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";

import { EmptyState, ErrorState, Field, PageSkeleton } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import {
  projectRepositoryLabel,
  projectStatusLabel,
  projectStatusVariant,
  shortRevision,
} from "@/lib/cloud-project";
import {
  EMPTY_CHANGE_CONTRACT_DRAFT,
  changeContractMissingFields,
  changeContractObjective,
  isLinkedWorkType,
  materializeChangeContract,
  WORK_TYPE_OPTIONS,
  type ChangeContractDraft,
} from "@/lib/change-contract";
import type {
  CreateRunInput,
  ResolveWorkItemInput,
  WorkItemDraft,
  WorkflowRun,
} from "@/lib/types";
import { cn, formatDate, initials, truncate } from "@/lib/utils";
import { FALLBACK_PHASES, FALLBACK_ROLES, getPhaseName } from "@/lib/workflow";

export function ProjectPage({
  projectId,
  onBack,
  onOpenAsk,
  onOpenRun,
}: {
  projectId: string;
  onBack: () => void;
  onOpenAsk: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const [createRunOpen, setCreateRunOpen] = useState(false);
  const queryClient = useQueryClient();
  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
    refetchInterval: (query) => {
      const project = query.state.data?.project;
      return project?.repository?.operation?.state === "queued" ||
        project?.repository?.operation?.state === "running" ||
        project?.knowledge?.status === "indexing"
        ? 1_500
        : false;
    },
  });
  const runsQuery = useQuery({
    queryKey: ["runs", projectId],
    queryFn: () => api.listRuns(projectId),
  });
  const knowledgeQuery = useQuery({
    queryKey: ["project", projectId, "knowledge"],
    queryFn: ({ signal }) => api.getProjectKnowledge(projectId, { signal }),
    enabled: projectQuery.data?.project.sourceKind === "remote-git",
    refetchInterval: (query) => query.state.data?.status === "indexing" ? 1_500 : false,
    retry: false,
  });
  const syncMutation = useMutation({
    mutationFn: () => api.syncProjectRepository(
      projectId,
      projectQuery.data?.project.repository?.activeSnapshot?.revision,
    ),
    onSuccess: async (project) => {
      queryClient.setQueryData(
        ["project", projectId],
        (current: typeof projectQuery.data) => current ? { ...current, project } : current,
      );
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  if (projectQuery.isLoading || runsQuery.isLoading) return <PageSkeleton />;
  if (projectQuery.isError) {
    return <ErrorState error={projectQuery.error} retry={() => void projectQuery.refetch()} />;
  }
  if (runsQuery.isError) {
    return <ErrorState error={runsQuery.error} retry={() => void runsQuery.refetch()} />;
  }
  if (!projectQuery.data || !runsQuery.data) return <PageSkeleton />;

  const { project, definition } = projectQuery.data;
  const knowledge = knowledgeQuery.data ?? project.knowledge;
  const operation = project.repository?.operation;
  const operationRunning = operation?.state === "queued" || operation?.state === "running";
  const runs = runsQuery.data ?? [];
  const roles = definition?.roles?.length ? definition.roles : FALLBACK_ROLES;
  const phases = definition?.phases?.length ? definition.phases : FALLBACK_PHASES;

  return (
    <div className="space-y-8 animate-fade-up">
      <section>
        <Button variant="ghost" size="sm" className="-ml-2 mb-4" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          所有项目
        </Button>
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div className="flex min-w-0 items-start gap-4">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-lg font-bold text-white shadow-md">
              {initials(project.name) || <FolderGit2 className="h-6 w-6" />}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 tabIndex={-1} className="truncate text-3xl font-bold tracking-[-0.03em] text-slate-950 focus:outline-none">
                  {project.name}
                </h1>
                <Badge variant={projectStatusVariant(project)}>
                  {operationRunning ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden /> : null}
                  {projectStatusLabel(project)}
                </Badge>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                {project.summary || "从一个清晰的故事目标开始，让六个角色依次完成交付。"}
              </p>
              <div className="mt-3 flex max-w-2xl items-center gap-2 rounded-lg bg-white/70 px-2.5 py-1.5 text-[11px] text-slate-500">
                <FolderGit2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate" title={project.repository?.url}>
                  {projectRepositoryLabel(project)}
                </span>
                {project.repository?.activeSnapshot ? (
                  <span className="shrink-0 font-mono text-slate-400">
                    @{shortRevision(project.repository.activeSnapshot.revision)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {project.sourceKind === "remote-git" ? (
              <Button
                size="lg"
                variant="outline"
                disabled={!project.availableActions.sync || syncMutation.isPending || operationRunning}
                loading={syncMutation.isPending}
                onClick={() => syncMutation.mutate()}
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                同步仓库
              </Button>
            ) : null}
            <Button size="lg" variant="outline" disabled={!project.availableActions.ask} onClick={onOpenAsk}>
              <MessageSquare className="h-4 w-4" aria-hidden />
              问项目
            </Button>
            <Button size="lg" variant="primary" disabled={!project.availableActions.createRun} onClick={() => setCreateRunOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              创建交付任务
            </Button>
          </div>
        </div>
      </section>

      {project.repository ? (
        <section className="grid gap-3 md:grid-cols-3" aria-label="云端仓库状态">
          <RepositoryFact
            icon={<FolderGit2 />}
            label="目标仓库"
            value={project.repository.url}
            detail={project.repository.requestedRef || "远程默认分支"}
          />
          <RepositoryFact
            icon={<GitCommitHorizontal />}
            label="当前快照"
            value={shortRevision(project.repository.activeSnapshot?.revision)}
            detail={project.repository.activeSnapshot?.resolvedRef || "导入完成后生成"}
            mono
          />
          <RepositoryFact
            icon={<Database />}
            label="项目知识"
            value={knowledgeStatusLabel(knowledge?.status)}
            detail={knowledge?.indexedAt ? `索引于 ${formatDate(knowledge.indexedAt)}` : "绑定当前仓库 revision"}
          />
        </section>
      ) : null}

      {operation ? (
        <div
          role={operation.state === "failed" ? "alert" : "status"}
          aria-live="polite"
          className={`rounded-xl border px-4 py-3 text-sm ${
            operation.state === "failed"
              ? "border-rose-200 bg-rose-50 text-rose-800"
              : "border-sky-200 bg-sky-50 text-sky-800"
          }`}
        >
          <div className="flex items-center justify-between gap-4">
            <span className="font-semibold">
              {operation.kind === "import" ? "云端导入" : "仓库同步"} · {operationStageLabel(operation.stage)}
            </span>
            <span className="font-mono text-xs">{operation.progress}%</span>
          </div>
          <p className="mt-1 text-xs leading-5">{operation.message}</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/70" aria-hidden>
            <div className="h-full rounded-full bg-current transition-all" style={{ width: `${operation.progress}%` }} />
          </div>
        </div>
      ) : null}

      {syncMutation.isError ? (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {syncMutation.error instanceof Error ? syncMutation.error.message : "仓库同步失败，请重试。"}
        </div>
      ) : null}

      <Card className="overflow-hidden bg-slate-950 text-white shadow-panel">
        <CardContent className="p-5 sm:p-6">
          <div className="mb-5 flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="h-4 w-4 text-teal-300" aria-hidden />
                可审计交付链路
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                每个阶段都由人工选择完整执行、局部更新、复用或有依据地跳过。
              </p>
            </div>
            <Badge className="border-white/10 bg-white/10 text-slate-200">6 roles</Badge>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
            {phases.map((phase, index) => {
              const role = roles.find((item) => item.id === phase.owner);
              return (
                <div
                  key={phase.id}
                  className="relative rounded-xl border border-white/10 bg-white/[0.055] p-3.5"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10 text-xs font-bold text-teal-200">
                      {index + 1}
                    </span>
                    {index < phases.length - 1 ? (
                      <ArrowRight className="hidden h-3.5 w-3.5 text-slate-600 xl:block" aria-hidden />
                    ) : (
                      <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                    )}
                  </div>
                  <div className="text-xs font-semibold text-white">{getPhaseName(phase)}</div>
                  <div className="mt-1 truncate text-[11px] text-slate-400">{role?.name ?? phase.owner}</div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <section>
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-slate-950">交付任务</h2>
            <p className="mt-1 text-sm text-slate-500">新功能、局部变更、缺陷与技术工作都从一份 Change Contract 开始。</p>
          </div>
          <span className="text-xs font-medium text-slate-400">共 {runs.length} 条</span>
        </div>
        {runs.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} onOpen={() => onOpenRun(run.id)} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="创建第一项交付任务"
            description="先确认当前与期望行为、范围、验收标准和回归面，再判断哪些角色确实需要运行。"
            action={project.availableActions.createRun ? (
              <Button variant="primary" onClick={() => setCreateRunOpen(true)}>
                <GitBranch className="h-4 w-4" aria-hidden />
                创建交付任务
              </Button>
            ) : null}
          />
        )}
      </section>

      <CreateRunDialog
        projectId={projectId}
        baseRevision={project.repository?.activeSnapshot?.revision}
        runs={runs}
        open={createRunOpen}
        onOpenChange={setCreateRunOpen}
        onCreated={(run) => onOpenRun(run.id)}
      />
    </div>
  );
}

function RepositoryFact({
  icon,
  label,
  value,
  detail,
  mono = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  mono?: boolean;
}) {
  return (
    <Card className="border-white/80 bg-white/70 shadow-none">
      <CardContent className="flex min-w-0 gap-3 p-4">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 [&>svg]:h-4 [&>svg]:w-4">
          {icon}
        </span>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
          <div className={`mt-1 truncate text-sm font-semibold text-slate-800 ${mono ? "font-mono" : ""}`} title={value}>
            {value}
          </div>
          <div className="mt-1 truncate text-xs text-slate-500" title={detail}>{detail}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function knowledgeStatusLabel(status?: "indexing" | "ready" | "failed"): string {
  if (status === "ready") return "已完成索引";
  if (status === "failed") return "索引失败";
  return "正在建立知识";
}

function operationStageLabel(stage: NonNullable<WorkflowRun["workspaceState"]> | string): string {
  const labels: Record<string, string> = {
    validating: "校验仓库",
    fetching: "拉取代码",
    resolving: "锁定版本",
    materializing: "准备快照",
    indexing: "建立项目知识",
    publishing: "发布新快照",
  };
  return labels[stage] ?? stage;
}

function RunCard({ run, onOpen }: { run: WorkflowRun; onOpen: () => void }) {
  const completed = run.status === "completed";
  return (
    <Card className="group transition duration-200 hover:border-teal-200 hover:shadow-md">
      <button type="button" onClick={onOpen} className="w-full p-5 text-left">
        <div className="flex items-start gap-4">
          <span
            className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
              completed ? "bg-emerald-50 text-emerald-600" : "bg-teal-50 text-teal-600"
            }`}
          >
            {completed ? <CheckCircle2 className="h-5 w-5" /> : <Bot className="h-5 w-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-4">
              <h3 className="truncate text-sm font-semibold text-slate-900 group-hover:text-teal-700">
                {run.title}
              </h3>
              <Badge variant={completed ? "success" : "info"}>{completed ? "已完成" : "进行中"}</Badge>
            </div>
            <p className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-slate-500">
              {truncate(run.objective || run.brief, 130)}
            </p>
            {run.baseRevision ? (
              <p className="mt-2 font-mono text-[11px] text-slate-400">
                base {shortRevision(run.baseRevision)}
              </p>
            ) : null}
            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-400">
              <span className="flex items-center gap-1.5">
                <Circle className="h-2.5 w-2.5 fill-current text-teal-500" aria-hidden />
                {formatDate(run.updatedAt || run.createdAt)}
              </span>
              <span className="flex items-center gap-1 font-medium text-slate-600 group-hover:text-teal-700">
                打开看板 <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </span>
            </div>
          </div>
        </div>
      </button>
    </Card>
  );
}

function CreateRunDialog({
  projectId,
  baseRevision,
  runs,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  baseRevision?: string;
  runs: WorkflowRun[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (run: WorkflowRun) => void;
}) {
  const queryClient = useQueryClient();
  const [intakeMode, setIntakeMode] = useState<"manual" | "mcp">("manual");
  const [adapterId, setAdapterId] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [resolvedWorkItem, setResolvedWorkItem] = useState<WorkItemDraft>();
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState<ChangeContractDraft>({ ...EMPTY_CHANGE_CONTRACT_DRAFT });
  const [error, setError] = useState<string>();
  const adaptersQuery = useQuery({
    queryKey: ["work-item-adapters"],
    queryFn: ({ signal }) => api.listWorkItemAdapters({ signal }),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  const resetForm = () => {
    setIntakeMode("manual");
    setAdapterId("");
    setExternalReference("");
    setResolvedWorkItem(undefined);
    setTitle("");
    setDraft({ ...EMPTY_CHANGE_CONTRACT_DRAFT, sourceRunIds: [] });
    setError(undefined);
    resolveMutation.reset();
  };
  const resolveMutation = useMutation({
    mutationFn: (input: ResolveWorkItemInput) => api.resolveWorkItem(input),
    onSuccess: (workItem, requested) => {
      if (
        adapterId !== requested.adapterId
        || externalReference.trim() !== requested.reference
      ) return;
      setResolvedWorkItem(workItem);
      setTitle(workItem.title);
      setDraft((current) => ({
        ...current,
        workType: workItem.suggestedWorkType,
        sourceRunIds: workItem.suggestedWorkType === "feature" ? [] : current.sourceRunIds,
        workItem: workItem.source,
        summary: workItem.title,
        currentBehavior: workItem.description.slice(0, 5_000),
        inScope: workItem.title,
        acceptanceCriteria: workItem.acceptanceCriteria.join("\n"),
        evidenceRefs: [
          workItem.source.url,
          `${workItem.source.adapterLabel}: ${workItem.source.externalId}`,
        ].filter((value): value is string => Boolean(value)).join("\n"),
      }));
      setError(undefined);
    },
    onError: (resolveError, requested) => {
      if (
        adapterId !== requested.adapterId
        || externalReference.trim() !== requested.reference
      ) return;
      setResolvedWorkItem(undefined);
      setDraft((current) => ({ ...current, workItem: undefined }));
      setError(resolveError instanceof Error ? resolveError.message : "读取外部工作项失败");
    },
  });
  const mutation = useMutation({
    mutationFn: (input: CreateRunInput) => api.createRun(projectId, input),
    onSuccess: async (run) => {
      await queryClient.invalidateQueries({ queryKey: ["runs", projectId] });
      resetForm();
      onOpenChange(false);
      onCreated(run);
    },
    onError: (mutationError) =>
      setError(mutationError instanceof Error ? mutationError.message : "创建交付任务失败"),
  });
  const updateDraft = <K extends keyof ChangeContractDraft>(
    field: K,
    value: ChangeContractDraft[K],
  ) => {
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...(field === "workType" && value === "feature" ? { sourceRunIds: [] } : {}),
    }));
    setError(undefined);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setError("请填写任务名称。");
      return;
    }
    if (intakeMode === "mcp" && !draft.workItem) {
      setError("请先从已配置的来源读取工作项，再确认内容。");
      return;
    }
    const contract = materializeChangeContract({
      ...draft,
      summary: title.trim(),
    });
    const missing = changeContractMissingFields(contract);
    if (missing.length > 0) {
      setError(`还需要填写：${missing.join("、")}。`);
      return;
    }
    mutation.mutate({
      title: title.trim(),
      objective: changeContractObjective(contract),
      changeContract: contract,
      ...(baseRevision ? { baseRevision } : {}),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) resetForm();
        onOpenChange(nextOpen);
      }}
      title="创建交付任务"
      description="手工写一个工作项，或从管理员配置的 Jira / Linear MCP 来源读取；确认清楚后再进入固定六阶段。"
      className="h-[calc(100dvh-2rem)] max-h-[58rem] max-w-4xl"
    >
      <form onSubmit={submit} className="min-h-0 overflow-y-auto p-6">
        <div className="space-y-5">
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">工作项从哪里来</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {([
                ["manual", "手工描述", "直接写清楚要解决的问题。"],
                ["mcp", "Jira / Linear 等 MCP", "由服务端读取，浏览器不接收密钥。"],
              ] as const).map(([value, label, description]) => (
                <label key={value} className="cursor-pointer">
                  <input
                    type="radio"
                    name="work-item-intake-mode"
                    value={value}
                    checked={intakeMode === value}
                    disabled={resolveMutation.isPending}
                    onChange={() => {
                      setIntakeMode(value);
                      setResolvedWorkItem(undefined);
                      setDraft((current) => ({ ...current, workItem: undefined }));
                      setError(undefined);
                    }}
                    className="peer sr-only"
                  />
                  <span className={cn(
                    "block rounded-xl border px-4 py-3 transition peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2",
                    intakeMode === value
                      ? "border-teal-400 bg-teal-50/60 ring-1 ring-teal-100"
                      : "border-slate-200 bg-white hover:border-slate-300",
                  )}>
                    <span className="block text-sm font-semibold text-slate-900">{label}</span>
                    <span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {intakeMode === "mcp" ? (
            <div className="rounded-xl border border-sky-100 bg-sky-50/60 p-4">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] sm:items-end">
                <Field label="工作项来源" required>
                  <select
                    aria-label="工作项 MCP 来源"
                    className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 pr-8 text-sm text-slate-800 outline-none focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10"
                    value={adapterId}
                    disabled={adaptersQuery.isLoading || resolveMutation.isPending}
                    onChange={(event) => {
                      setAdapterId(event.target.value);
                      setResolvedWorkItem(undefined);
                      setDraft((current) => ({ ...current, workItem: undefined }));
                    }}
                  >
                    <option value="">选择管理员已配置的来源</option>
                    {(adaptersQuery.data ?? []).map((adapter) => (
                      <option key={adapter.id} value={adapter.id} disabled={!adapter.configured}>
                        {adapter.label}{adapter.configured ? "" : "（未就绪）"}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Issue 编号或链接" required>
                  <Input
                    placeholder="例如：ENG-123 或工作项链接"
                    value={externalReference}
                    disabled={resolveMutation.isPending}
                    onChange={(event) => {
                      setExternalReference(event.target.value);
                      setResolvedWorkItem(undefined);
                      setDraft((current) => ({ ...current, workItem: undefined }));
                    }}
                  />
                </Field>
                <Button
                  type="button"
                  variant="outline"
                  loading={resolveMutation.isPending}
                  disabled={!adapterId || !externalReference.trim()}
                  onClick={() => resolveMutation.mutate({
                    adapterId,
                    reference: externalReference.trim(),
                  })}
                >
                  读取工作项
                </Button>
              </div>
              {adaptersQuery.isError ? (
                <p className="mt-3 text-xs text-amber-700">暂时无法读取 MCP 来源；可以切回手工描述。</p>
              ) : adaptersQuery.data?.length === 0 ? (
                <p className="mt-3 text-xs text-slate-600">
                  管理员还没有配置 Work Item MCP Adapter；平台不会伪装成已连接 Jira 或 Linear。
                </p>
              ) : null}
              {resolvedWorkItem ? (
                <div className="mt-3 rounded-lg border border-emerald-200 bg-white px-3 py-2.5 text-xs leading-5 text-emerald-800">
                  已读取 {resolvedWorkItem.source.adapterLabel} · {resolvedWorkItem.source.externalId}
                  {resolvedWorkItem.labels.length ? ` · 标签：${resolvedWorkItem.labels.join("、")}` : ""}
                  <div className="font-mono text-[10px] text-slate-400">
                    evidence {resolvedWorkItem.source.fingerprint.slice(0, 12)}
                  </div>
                  {resolvedWorkItem.description.length > 5_000 ? (
                    <div className="mt-1 text-amber-700">
                      原描述超过 Run 合同上限，表单已保留前 5000 字；请按本次目标重新整理，而不是直接照搬。
                    </div>
                  ) : null}
                </div>
              ) : null}
              <p className="mt-3 text-xs leading-5 text-sky-800">
                外部标题和描述只是待确认资料，不能改变阶段顺序、权限或发布边界。读取后请继续检查下面每一项。
              </p>
            </div>
          ) : null}

          <Field label="任务名称" required>
            <Input
              autoFocus
              maxLength={200}
              placeholder="例如：修复订单重复提交"
              value={title}
              onChange={(event) => {
                const nextTitle = event.target.value;
                setTitle(nextTitle);
                setDraft((current) => ({ ...current, summary: nextTitle }));
                setError(undefined);
              }}
            />
          </Field>

          <fieldset>
            <legend className="text-sm font-medium text-slate-700">
              工作类型<span className="ml-1 text-rose-500">*</span>
            </legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {WORK_TYPE_OPTIONS.map((option) => (
                <label key={option.value} className="cursor-pointer">
                  <input
                    type="radio"
                    name="change-contract-work-type"
                    value={option.value}
                    checked={draft.workType === option.value}
                    onChange={() => updateDraft("workType", option.value)}
                    className="peer sr-only"
                  />
                  <span
                    className={cn(
                      "block h-full rounded-xl border bg-white px-3.5 py-3 transition peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2",
                      draft.workType === option.value
                        ? "border-teal-400 bg-teal-50/60 ring-1 ring-teal-100"
                        : "border-slate-200 hover:border-slate-300",
                    )}
                  >
                    <span className="block text-xs font-semibold text-slate-900">{option.label}</span>
                    <span className="mt-1 block text-[11px] leading-4 text-slate-500">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {isLinkedWorkType(draft.workType) && runs.length > 0 ? (
            <div>
              <OriginalTaskSelector
                runs={runs}
                selectedIds={draft.sourceRunIds}
                onChange={(sourceRunIds) => updateDraft("sourceRunIds", sourceRunIds)}
              />
              <p className="mt-1 text-xs text-slate-500">可选。只有确实基于旧任务继续修改时才关联。</p>
            </div>
          ) : null}

          <div className="grid gap-5 lg:grid-cols-2">
            <Field label="现在是什么情况" hint="新能力可以写“目前还没有这项能力”" required>
              <Textarea
                maxLength={5_000}
                className="min-h-32"
                placeholder="谁遇到了什么问题？现在会发生什么？"
                value={draft.currentBehavior}
                onChange={(event) => updateDraft("currentBehavior", event.target.value)}
              />
            </Field>
            <Field label="完成后应该怎样" required>
              <Textarea
                maxLength={5_000}
                className="min-h-32"
                placeholder="写用户能看到、测试能验证的结果，不先规定代码怎么写。"
                value={draft.expectedBehavior}
                onChange={(event) => updateDraft("expectedBehavior", event.target.value)}
              />
            </Field>
            <Field label="这次具体要做什么" hint="每行一项" required>
              <Textarea
                maxLength={8_000}
                className="min-h-28"
                placeholder={"支持订单重试\n失败时给出清楚提示"}
                value={draft.inScope}
                onChange={(event) => updateDraft("inScope", event.target.value)}
              />
            </Field>
            <Field label="怎样才算完成" hint="每行一条，可直接验证" required>
              <Textarea
                maxLength={8_000}
                className="min-h-28"
                placeholder={"重复点击只创建一笔订单\n失败提示说明下一步怎么做"}
                value={draft.acceptanceCriteria}
                onChange={(event) => updateDraft("acceptanceCriteria", event.target.value)}
              />
            </Field>
          </div>

          <Field label="至少要回头检查哪些地方" hint="每行一项" required>
            <Textarea
              maxLength={8_000}
              className="min-h-24"
              placeholder={"正常下单流程\n支付失败后的再次提交\n旧订单查询"}
              value={draft.regressionScope}
              onChange={(event) => updateDraft("regressionScope", event.target.value)}
            />
          </Field>

          <details className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <summary className="cursor-pointer text-sm font-semibold text-slate-700">
              可选：不做什么、风险和参考资料
            </summary>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Field label="这次明确不做" hint="每行一项">
                <Textarea
                  className="min-h-24"
                  placeholder="避免任务越做越大。"
                  value={draft.outOfScope}
                  onChange={(event) => updateDraft("outOfScope", event.target.value)}
                />
              </Field>
              <Field label="需要特别小心的风险" hint="每行一项">
                <Textarea
                  className="min-h-24"
                  placeholder="例如：可能影响支付幂等。"
                  value={draft.riskFlags}
                  onChange={(event) => updateDraft("riskFlags", event.target.value)}
                />
              </Field>
              <Field label="参考资料" hint="链接、文档或证据，每行一项">
                <Textarea
                  className="min-h-24 lg:col-span-2"
                  value={draft.evidenceRefs}
                  onChange={(event) => updateDraft("evidenceRefs", event.target.value)}
                />
              </Field>
            </div>
          </details>

          <div className="rounded-xl border border-teal-100 bg-teal-50/70 p-4">
            <div className="flex gap-3">
              <Bot className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" aria-hidden />
              <p className="text-xs leading-5 text-teal-800">
                点击创建就是人工确认：平台会把这些内容和外部来源指纹一起冻结到 Run。后续角色先说结论、用短段落和白话解释，再给需要审核的产物。
              </p>
            </div>
          </div>
          {error ? (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-700">
              {error}
            </div>
          ) : null}
        </div>
        <div className="mt-7 flex justify-end gap-3 border-t border-slate-100 pt-5">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              resetForm();
              onOpenChange(false);
            }}
          >
            取消
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            创建工作流
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function OriginalTaskSelector({
  runs,
  selectedIds,
  onChange,
}: {
  runs: WorkflowRun[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const selected = new Set(selectedIds);
  return (
    <Field label="相关旧任务" hint={`可选，已选 ${selectedIds.length}/20`}>
      {runs.length > 0 ? (
        <div className="max-h-64 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/60 p-2">
          {runs.map((run) => (
            <label
              key={run.id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition",
                selected.has(run.id)
                  ? "border-teal-300 bg-white shadow-sm"
                  : "border-transparent hover:border-slate-200 hover:bg-white",
              )}
            >
              <Checkbox
                checked={selected.has(run.id)}
                disabled={!selected.has(run.id) && selectedIds.length >= 20}
                onCheckedChange={(checked) => onChange(
                  checked
                    ? [...selectedIds, run.id]
                    : selectedIds.filter((id) => id !== run.id),
                )}
                aria-label={`选择原始任务 ${run.title}`}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium text-slate-800">
                  <Link2 className="h-3.5 w-3.5 shrink-0 text-teal-600" aria-hidden />
                  <span className="truncate">{run.title}</span>
                </span>
                <span className="mt-1 block truncate text-xs text-slate-500">
                  {run.changeContract?.expectedBehavior || run.objective || "未记录期望行为"}
                </span>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">
          当前项目还没有可关联的原始任务，请先创建一个新功能任务。
        </div>
      )}
    </Field>
  );
}
