import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  FolderGit2,
  FolderPlus,
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
import type { CreateProjectInput, Project } from "@/lib/types";
import { cn, formatDate, initials, truncate } from "@/lib/utils";

const AGENT_CLIENT_OPTIONS = [
  {
    id: "codex",
    label: "Codex",
    description: "生成适合 Codex CLI 与 IDE 客户端读取的项目入口。",
  },
  {
    id: "claude",
    label: "Claude Code",
    description: "生成适合 Claude Code 读取的项目入口。",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    description: "生成适合 GitHub Copilot 读取的项目入口。",
  },
] as const satisfies ReadonlyArray<{
  id: NonNullable<CreateProjectInput["agentClient"]>;
  label: string;
  description: string;
}>;

export function ProjectsPage({ onSelectProject }: { onSelectProject: (id: string) => void }) {
  const [createOpen, setCreateOpen] = useState(false);
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
  });

  if (projectsQuery.isLoading) return <PageSkeleton />;
  if (projectsQuery.isError) {
    return <ErrorState error={projectsQuery.error} retry={() => void projectsQuery.refetch()} />;
  }

  const projects = projectsQuery.data ?? [];
  const initialized = projects.filter((project) => project.initialized !== false).length;
  const workflows = projects.reduce((total, project) => total + (project.runCount ?? 0), 0);

  return (
    <div className="space-y-9 animate-fade-up">
      <section className="grid items-end gap-6 xl:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <Badge variant="success" className="mb-4">
            <Sparkles className="h-3 w-3" aria-hidden />
            Local-first AI delivery
          </Badge>
          <h1 tabIndex={-1} className="max-w-3xl text-balance text-3xl font-bold tracking-[-0.035em] text-slate-950 focus:outline-none sm:text-4xl">
            把每一次 AI 交付，变成
            <span className="text-teal-600"> 看得见的工作流</span>
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
            创建一个本地项目，从 PM / BA 开始。每个角色执行、每份产物与每次人工审核都会留在同一条交付链路里。
          </p>
        </div>
        <Button size="lg" variant="primary" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          创建项目
        </Button>
      </section>

      <section className="grid gap-3 sm:grid-cols-3" aria-label="项目概览">
        <Metric label="本地项目" value={projects.length} icon={<FolderGit2 />} />
        <Metric label="已初始化" value={initialized} icon={<CheckCircle2 />} />
        <Metric label="故事工作流" value={workflows} icon={<GitBranch />} />
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-slate-950">你的项目</h2>
            <p className="mt-1 text-sm text-slate-500">项目文件保留在所选本地目录；真实 Codex 执行会把完成任务所需的上下文发送给已配置的模型服务。</p>
          </div>
          {projects.length ? (
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
              <FolderPlus className="h-4 w-4" aria-hidden />
              新项目
            </Button>
          ) : null}
        </div>

        {projects.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((project, index) => (
              <ProjectCard
                key={project.id}
                project={project}
                index={index}
                onSelect={() => onSelectProject(project.id)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title="还没有项目"
            description="选择一个已有代码目录，平台会读取现有 AI SDLC 配置；也可以让平台初始化一个新项目。"
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                创建第一个项目
              </Button>
            }
          />
        )}
      </section>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(project) => onSelectProject(project.id)}
      />
    </div>
  );
}

function Metric({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <Card className="border-white/80 bg-white/70 shadow-none backdrop-blur-sm">
      <CardContent className="flex items-center gap-4 p-4">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500 [&>svg]:h-[18px] [&>svg]:w-[18px]">
          {icon}
        </span>
        <div>
          <div className="text-xl font-bold tracking-tight text-slate-950">{value}</div>
          <div className="text-xs font-medium text-slate-500">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function ProjectCard({
  project,
  onSelect,
  index,
}: {
  project: Project;
  onSelect: () => void;
  index: number;
}) {
  const rootPath = project.rootPath || project.workspacePath || "未设置目录";
  return (
    <Card
      className="group overflow-hidden transition duration-300 hover:-translate-y-0.5 hover:border-teal-200 hover:shadow-panel"
      style={{ animationDelay: `${Math.min(index, 5) * 60}ms` }}
    >
      <button type="button" onClick={onSelect} className="w-full text-left">
        <CardHeader className="pb-4">
          <div className="flex items-start justify-between gap-4">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-950 text-sm font-bold text-white shadow-sm">
              {initials(project.name) || <Bot className="h-5 w-5" />}
            </span>
            <Badge variant={project.initialized === false ? "warning" : "success"}>
              {project.initialized === false ? "待初始化" : "已就绪"}
            </Badge>
          </div>
          <h3 className="mt-3 text-lg font-semibold tracking-tight text-slate-950 transition group-hover:text-teal-700">
            {project.name}
          </h3>
          <p className="min-h-12 text-sm leading-6 text-slate-500">
            {truncate(project.summary, 92) || "还没有项目摘要。"}
          </p>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5">
            <div className="truncate font-mono text-[11px] text-slate-500" title={rootPath}>
              {rootPath}
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
            <span>{project.runCount ?? 0} 条工作流</span>
            <span className="flex items-center gap-1 font-medium text-slate-600 transition group-hover:gap-2 group-hover:text-teal-700">
              打开项目 <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </span>
          </div>
          {project.updatedAt || project.createdAt ? (
            <div className="mt-2 text-[11px] text-slate-400">
              更新于 {formatDate(project.updatedAt || project.createdAt)}
            </div>
          ) : null}
        </CardContent>
      </button>
    </Card>
  );
}

function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: Project) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CreateProjectInput>({
    name: "",
    summary: "",
    rootPath: "",
    initialize: false,
    agentClient: "codex",
  });
  const [error, setError] = useState<string>();
  const createControllerRef = useRef<AbortController>();
  useEffect(() => () => {
    createControllerRef.current?.abort(new DOMException("项目创建界面已卸载", "AbortError"));
  }, []);
  const mutation = useMutation({
    mutationFn: async (input: CreateProjectInput) => {
      const controller = new AbortController();
      createControllerRef.current = controller;
      try {
        const project = await api.createProject(input, { signal: controller.signal });
        controller.signal.throwIfAborted();
        return project;
      } finally {
        if (createControllerRef.current === controller) createControllerRef.current = undefined;
      }
    },
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      setForm({
        name: "",
        summary: "",
        rootPath: "",
        initialize: false,
        agentClient: "codex",
      });
      setError(undefined);
      onOpenChange(false);
      onCreated(project);
    },
    onError: (mutationError) => {
      if (mutationError instanceof Error && mutationError.name === "AbortError") return;
      setError(mutationError instanceof Error ? mutationError.message : "创建项目失败");
    },
  });

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && mutation.isPending) {
      createControllerRef.current?.abort(new DOMException("用户取消项目创建", "AbortError"));
      mutation.reset();
    }
    onOpenChange(nextOpen);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    if (!form.name.trim() || !form.rootPath.trim()) {
      setError("请填写项目名称和本地目录。 ");
      return;
    }
    mutation.mutate({
      ...form,
      name: form.name.trim(),
      summary: form.summary.trim(),
      rootPath: form.rootPath.trim(),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title="创建本地项目"
      description="连接已有目录，或选择在该目录中初始化现有 AI SDLC 模板。"
    >
      <form onSubmit={submit} className="overflow-y-auto p-6">
        <div className="space-y-5">
          <Field label="项目名称" required>
            <Input
              autoFocus
              placeholder="例如：Acme 客户门户"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
          </Field>
          <Field label="项目目标">
            <Textarea
              className="min-h-24"
              placeholder="这个项目服务谁，要解决什么问题？"
              value={form.summary}
              onChange={(event) =>
                setForm((current) => ({ ...current, summary: event.target.value }))
              }
            />
          </Field>
          <Field label="本地代码目录" hint="绝对路径" required>
            <Input
              className="font-mono text-xs"
              placeholder="/Users/you/workspace/my-product"
              value={form.rootPath}
              onChange={(event) =>
                setForm((current) => ({ ...current, rootPath: event.target.value }))
              }
            />
          </Field>
          <label
            className="flex w-full cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50/80 p-4 text-left transition hover:border-slate-300 focus-within:ring-2 focus-within:ring-teal-500 focus-within:ring-offset-2"
          >
            <input
              type="checkbox"
              checked={form.initialize}
              className="mt-0.5 h-4 w-4 shrink-0 accent-teal-600"
              onChange={(event) => setForm((current) => ({
                ...current,
                initialize: event.target.checked,
              }))}
            />
            <span>
              <span className="block text-sm font-semibold text-slate-800">初始化 AI SDLC</span>
              <span className="mt-1 block text-xs leading-5 text-slate-500">
                仅在目录尚未安装时启用。已有配置会被直接读取，不会改变原有初始化行为。
              </span>
            </span>
          </label>
          {form.initialize ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-slate-700">智能体客户端</legend>
              <p className="text-xs leading-5 text-slate-500">
                选择初始化时生成的原生入口；标准角色定义与六阶段工作流保持一致。
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                {AGENT_CLIENT_OPTIONS.map((option) => {
                  const selected = (form.agentClient ?? "codex") === option.id;
                  return (
                    <label
                      key={option.id}
                      className={cn(
                        "cursor-pointer rounded-xl border p-3 text-left transition focus-within:ring-2 focus-within:ring-teal-500 focus-within:ring-offset-2",
                        selected
                          ? "border-teal-500 bg-teal-50 text-teal-950"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                      )}
                    >
                      <input
                        type="radio"
                        name="agent-client"
                        value={option.id}
                        checked={selected}
                        className="sr-only"
                        onChange={() => setForm((current) => ({
                          ...current,
                          agentClient: option.id,
                        }))}
                      />
                      <span className="block text-sm font-semibold">{option.label}</span>
                      <span className="mt-1 block text-[11px] leading-4 text-slate-500">
                        {option.description}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}
          {error ? (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-700">
              {error}
            </div>
          ) : null}
          <p className="text-xs leading-5 text-slate-500">
            若取消或断线恰逢文件或数据库提交，已提交结果不会被反向删除；请刷新项目列表确认状态后再重试。
          </p>
        </div>
        <div className="mt-7 flex justify-end gap-3 border-t border-slate-100 pt-5">
          <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            创建并打开
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
