import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  Circle,
  FolderGit2,
  GitBranch,
  Link2,
  Plus,
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
  EMPTY_CHANGE_CONTRACT_DRAFT,
  isLinkedWorkType,
  linkedChangeMissingFields,
  WORK_TYPE_OPTIONS,
  type ChangeContractDraft,
} from "@/lib/change-contract";
import type { CreateRunInput, WorkflowRun } from "@/lib/types";
import { cn, formatDate, initials, truncate } from "@/lib/utils";
import { FALLBACK_PHASES, FALLBACK_ROLES, getPhaseName } from "@/lib/workflow";

export function ProjectPage({
  projectId,
  onBack,
  onOpenRun,
}: {
  projectId: string;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const [createRunOpen, setCreateRunOpen] = useState(false);
  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
  });
  const runsQuery = useQuery({
    queryKey: ["runs", projectId],
    queryFn: () => api.listRuns(projectId),
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
                <h1 className="truncate text-3xl font-bold tracking-[-0.03em] text-slate-950">
                  {project.name}
                </h1>
                <Badge variant="success">工作流已就绪</Badge>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                {project.summary || "从一个清晰的故事目标开始，让六个角色依次完成交付。"}
              </p>
              <div className="mt-3 flex max-w-2xl items-center gap-2 rounded-lg bg-white/70 px-2.5 py-1.5 font-mono text-[11px] text-slate-400">
                <FolderGit2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{project.rootPath}</span>
              </div>
            </div>
          </div>
          <Button size="lg" variant="primary" onClick={() => setCreateRunOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            创建交付任务
          </Button>
        </div>
      </section>

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
            action={
              <Button variant="primary" onClick={() => setCreateRunOpen(true)}>
                <GitBranch className="h-4 w-4" aria-hidden />
                创建交付任务
              </Button>
            }
          />
        )}
      </section>

      <CreateRunDialog
        projectId={projectId}
        runs={runs}
        open={createRunOpen}
        onOpenChange={setCreateRunOpen}
        onCreated={(run) => onOpenRun(run.id)}
      />
    </div>
  );
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
  runs,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  runs: WorkflowRun[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (run: WorkflowRun) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState<ChangeContractDraft>({ ...EMPTY_CHANGE_CONTRACT_DRAFT });
  const [error, setError] = useState<string>();
  const resetForm = () => {
    setTitle("");
    setDraft({ ...EMPTY_CHANGE_CONTRACT_DRAFT, sourceRunIds: [] });
    setError(undefined);
  };
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
    setDraft((current) => ({ ...current, [field]: value }));
    setError(undefined);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setError("请填写任务名称。");
      return;
    }
    if (isLinkedWorkType(draft.workType)) {
      const missing = linkedChangeMissingFields(draft);
      if (missing.length > 0) {
        setError(`请完成：${missing.join("、")}。`);
        return;
      }
      mutation.mutate({
        title: title.trim(),
        workType: draft.workType,
        sourceRunIds: draft.sourceRunIds,
        expectedBehavior: draft.expectedBehavior.trim(),
      });
      return;
    }
    mutation.mutate({
      title: title.trim(),
      objective: title.trim(),
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
      description="新功能只需填写任务名称；局部变更、功能缺陷和技术变更需关联原始任务并填写期望行为。"
      className="h-[calc(100dvh-2rem)] max-h-[58rem] max-w-4xl"
    >
      <form onSubmit={submit} className="min-h-0 overflow-y-auto p-6">
        <div className="space-y-5">
          <Field label="任务名称" required>
            <Input
              autoFocus
              maxLength={200}
              placeholder="例如：修复订单重复提交"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
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

          {isLinkedWorkType(draft.workType) ? (
            <>
              <OriginalTaskSelector
                runs={runs}
                selectedIds={draft.sourceRunIds}
                onChange={(sourceRunIds) => updateDraft("sourceRunIds", sourceRunIds)}
              />
              <Field
                label="期望行为"
                hint="原始任务已提供其余上下文"
                required
              >
                <Textarea
                  maxLength={2_000}
                  className="min-h-32"
                  placeholder="完成后可观察、可验证的目标行为，不写技术实现方案。"
                  value={draft.expectedBehavior}
                  onChange={(event) => updateDraft("expectedBehavior", event.target.value)}
                />
              </Field>
            </>
          ) : null}

          <div className="rounded-xl border border-teal-100 bg-teal-50/70 p-4">
            <div className="flex gap-3">
              <Bot className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" aria-hidden />
              <p className="text-xs leading-5 text-teal-800">
                创建后先做 Product Impact Check。功能缺陷或纯技术工作在合同足够清晰时，可以不运行 PM / BA；平台仍会保存本合同作为后续实现与测试依据。
              </p>
            </div>
          </div>
          {error ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-700">
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
    <Field label="原始任务" hint={`已选 ${selectedIds.length}/20，可多选`} required>
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
