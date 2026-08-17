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
  Plus,
  Sparkles,
} from "lucide-react";

import { EmptyState, ErrorState, Field, PageSkeleton } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { CreateRunInput, WorkflowRun } from "@/lib/types";
import { formatDate, initials, truncate } from "@/lib/utils";
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
            创建故事工作流
          </Button>
        </div>
      </section>

      <Card className="overflow-hidden bg-slate-950 text-white shadow-panel">
        <CardContent className="p-5 sm:p-6">
          <div className="mb-5 flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="h-4 w-4 text-teal-300" aria-hidden />
                固定交付链路
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                每个阶段都需要人工确认，审核通过后才会解锁下一个角色。
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
            <h2 className="text-lg font-semibold tracking-tight text-slate-950">故事工作流</h2>
            <p className="mt-1 text-sm text-slate-500">每条工作流是一项可以从需求一直推进到发布的工作。</p>
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
            title="从第一个故事开始"
            description="写下希望交付的用户价值。PM / BA 会先运行并产出 PRD 与用户故事，等待你审核。"
            action={
              <Button variant="primary" onClick={() => setCreateRunOpen(true)}>
                <GitBranch className="h-4 w-4" aria-hidden />
                创建故事工作流
              </Button>
            }
          />
        )}
      </section>

      <CreateRunDialog
        projectId={projectId}
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
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (run: WorkflowRun) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CreateRunInput>({ title: "", objective: "" });
  const [error, setError] = useState<string>();
  const mutation = useMutation({
    mutationFn: (input: CreateRunInput) => api.createRun(projectId, input),
    onSuccess: async (run) => {
      await queryClient.invalidateQueries({ queryKey: ["runs", projectId] });
      setForm({ title: "", objective: "" });
      setError(undefined);
      onOpenChange(false);
      onCreated(run);
    },
    onError: (mutationError) =>
      setError(mutationError instanceof Error ? mutationError.message : "创建故事失败"),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim() || !form.objective.trim()) {
      setError("请填写故事名称和目标。 ");
      return;
    }
    mutation.mutate({ title: form.title.trim(), objective: form.objective.trim() });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="创建故事工作流"
      description="先说清楚想交付的结果，PM / BA 会把它整理成第一批可审核产物。"
    >
      <form onSubmit={submit} className="overflow-y-auto p-6">
        <div className="space-y-5">
          <Field label="故事名称" required>
            <Input
              autoFocus
              placeholder="例如：用户可以使用邮箱登录"
              value={form.title}
              onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
            />
          </Field>
          <Field label="目标与背景" hint="告诉 AI 为什么做" required>
            <Textarea
              className="min-h-40"
              placeholder="目标用户是谁？遇到了什么问题？希望得到什么结果？已知的范围或约束是什么？"
              value={form.objective}
              onChange={(event) =>
                setForm((current) => ({ ...current, objective: event.target.value }))
              }
            />
          </Field>
          <div className="rounded-xl border border-teal-100 bg-teal-50/70 p-4">
            <div className="flex gap-3">
              <Bot className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" aria-hidden />
              <p className="text-xs leading-5 text-teal-800">
                创建后只会解锁第一个角色。你仍需点击“运行 PM / BA”，Codex 才会在本地项目中开始工作。
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
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
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
