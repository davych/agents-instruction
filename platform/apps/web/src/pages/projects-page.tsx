import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Bot,
  ChevronDown,
  Cloud,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  Plus,
} from "lucide-react";

import { EmptyState, ErrorState, Field, PageSkeleton } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import {
  parseRemoteRepositoryUrl,
  projectRepositoryLabel,
  projectStatusLabel,
  projectStatusVariant,
  shortRevision,
} from "@/lib/cloud-project";
import type { BindRemoteRepositoryInput, Project, RepositoryBindingResult } from "@/lib/types";
import { formatDate, initials, truncate } from "@/lib/utils";

// The compatibility API still calls this sourceKind: "remote-git". The
// default browser journey sends only the binding contract below.
const EMPTY_PROJECT: BindRemoteRepositoryInput = {
  repositoryUrl: "",
};

export function ProjectsPage({
  onOpenWorkspace,
}: {
  onOpenWorkspace: (projectId: string, sessionId?: string) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
    refetchInterval: (query) => {
      const projects = query.state.data;
      return projects?.some((project) =>
        project.repository?.operation?.state === "queued" ||
        project.repository?.operation?.state === "running" ||
        project.knowledge?.status === "indexing"
      ) ? 1_500 : false;
    },
  });

  if (projectsQuery.isLoading) return <PageSkeleton />;
  if (projectsQuery.isError) {
    return <ErrorState error={projectsQuery.error} retry={() => void projectsQuery.refetch()} />;
  }

  const projects = projectsQuery.data ?? [];
  return (
    <div className="space-y-8 animate-fade-up">
      <section className="grid items-center gap-6 rounded-3xl border border-slate-200/80 bg-white/80 p-6 shadow-sm backdrop-blur-sm sm:p-8 xl:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <Badge variant="success" className="mb-3">Cloud Agent workspace</Badge>
          <h1 tabIndex={-1} className="max-w-3xl text-balance text-3xl font-bold tracking-[-0.035em] text-slate-950 focus:outline-none sm:text-4xl">
            绑定仓库，然后直接和 Agent 对话
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
            仓库通过 <span className="font-mono font-semibold text-teal-700">@repo</span> 加入会话。需要干活时，Agent 会启动隔离沙盒，并在后台串联 SDLC 角色与产物。
          </p>
        </div>
        <Button size="lg" variant="primary" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          绑定仓库
        </Button>
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-slate-950">Repositories</h2>
            <p className="mt-1 text-sm text-slate-500">
              选择一个仓库，继续最近的 Agent Session。
            </p>
          </div>
          {projects.length ? (
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
              <Cloud className="h-4 w-4" aria-hidden />
              绑定另一个仓库
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
                onSelect={() => onOpenWorkspace(project.id)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title="还没有绑定仓库"
            description="提供一个 Git HTTPS 地址。绑定完成后会直接进入对话工作台。"
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                绑定第一个仓库
              </Button>
            }
          />
        )}
      </section>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={({ project, session }) => onOpenWorkspace(project.id, session.id)}
      />
    </div>
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
  const operation = project.repository?.operation;
  const inProgress = operation?.state === "queued" || operation?.state === "running";
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
            <Badge variant={projectStatusVariant(project)}>
              {inProgress ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden /> : null}
              {projectStatusLabel(project)}
            </Badge>
          </div>
          <h3 className="mt-3 text-lg font-semibold tracking-tight text-slate-950 transition group-hover:text-teal-700">
            {project.name}
          </h3>
          <p className="min-h-12 text-sm leading-6 text-slate-500">
            {truncate(project.summary, 92) || "准备好后，可在一个对话里读代码、启动沙盒和发起 SDLC。"}
          </p>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5">
            <div className="truncate text-xs font-medium text-slate-600" title={project.repository?.url}>
              {projectRepositoryLabel(project)}
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-slate-400">
              revision {shortRevision(project.repository?.activeSnapshot?.revision)}
            </div>
          </div>
          {operation ? (
            <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-500" role={inProgress ? "status" : "alert"}>
              {operation.message} · {operation.progress}%
            </p>
          ) : null}
          <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
              Agent Session
            </span>
            <span className="flex items-center gap-1 font-medium text-slate-600 transition group-hover:gap-2 group-hover:text-teal-700">
              打开对话 <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400">
            更新于 {formatDate(project.updatedAt || project.createdAt)}
          </div>
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
  onCreated: (result: RepositoryBindingResult) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<BindRemoteRepositoryInput>(EMPTY_PROJECT);
  const [error, setError] = useState<string>();
  const createControllerRef = useRef<AbortController>();
  const parsedRepository = useMemo(
    () => parseRemoteRepositoryUrl(form.repositoryUrl),
    [form.repositoryUrl],
  );
  const credentialsQuery = useQuery({
    queryKey: ["repository-credentials", parsedRepository?.host],
    queryFn: ({ signal }) => api.listRepositoryCredentials(parsedRepository?.host, { signal }),
    enabled: open && Boolean(parsedRepository?.host),
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => () => {
    createControllerRef.current?.abort(new DOMException("仓库导入界面已卸载", "AbortError"));
  }, []);

  const mutation = useMutation({
    mutationFn: async (input: BindRemoteRepositoryInput) => {
      const controller = new AbortController();
      createControllerRef.current = controller;
      try {
        const result = await api.bindRemoteRepository(input, { signal: controller.signal });
        controller.signal.throwIfAborted();
        return result;
      } finally {
        if (createControllerRef.current === controller) createControllerRef.current = undefined;
      }
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      setForm(EMPTY_PROJECT);
      setError(undefined);
      onOpenChange(false);
      onCreated(result);
    },
    onError: (mutationError) => {
      if (mutationError instanceof Error && mutationError.name === "AbortError") return;
      setError(mutationError instanceof Error ? mutationError.message : "导入仓库失败");
    },
  });

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && mutation.isPending) {
      createControllerRef.current?.abort(new DOMException("用户关闭仓库导入请求", "AbortError"));
      mutation.reset();
    }
    onOpenChange(nextOpen);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    if (!parsedRepository) {
      setError("请填写不含账号、查询参数或锚点的 Git HTTPS 仓库地址。");
      return;
    }
    mutation.mutate({
      repositoryUrl: parsedRepository.url,
      ...(form.requestedRef?.trim() ? { requestedRef: form.requestedRef.trim() } : {}),
      ...(form.credentialProfileId ? { credentialProfileId: form.credentialProfileId } : {}),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title="绑定 Git 仓库"
      description="选择仓库和授权即可。平台会固定源码版本，随后直接进入 Agent 对话。"
    >
      <form onSubmit={submit} className="overflow-y-auto p-6">
        <div className="space-y-5">
          <Field label="Git HTTPS 仓库地址" required>
            <Input
              autoFocus
              className="font-mono text-xs"
              inputMode="url"
              placeholder="https://git.example.com/team/product.git"
              value={form.repositoryUrl}
              onChange={(event) => setForm((current) => ({
                ...current,
                repositoryUrl: event.target.value,
                credentialProfileId: undefined,
              }))}
            />
            {form.repositoryUrl && !parsedRepository ? (
              <p className="mt-1.5 text-xs text-rose-600">
                MVP 只接受安全的 HTTPS 地址；凭据请通过下方 Profile 选择。
              </p>
            ) : null}
          </Field>

          <Field label="仓库授权" hint="公共仓库可留空">
            <select
              aria-label="仓库凭据 Profile"
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 pr-8 text-sm text-slate-800 outline-none focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 disabled:bg-slate-50"
              value={form.credentialProfileId ?? ""}
              disabled={!parsedRepository || credentialsQuery.isLoading}
              onChange={(event) => setForm((current) => ({
                ...current,
                credentialProfileId: event.target.value || undefined,
              }))}
            >
              <option value="">公开仓库，不使用授权</option>
              {(credentialsQuery.data ?? []).filter((profile) => profile.available).map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.label}</option>
              ))}
            </select>
            {credentialsQuery.isError ? (
              <p className="mt-1.5 text-xs text-amber-700">
                暂时无法读取授权 Profile；仍可绑定公开仓库。
              </p>
            ) : null}
          </Field>

          <details className="group rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-slate-700">
              高级设置
              <ChevronDown className="h-4 w-4 transition group-open:rotate-180" aria-hidden />
            </summary>
            <div className="mt-4 border-t border-slate-200 pt-4">
              <Field label="分支、Tag 或 Commit" hint="留空使用远程默认分支">
                <Input
                  className="font-mono text-xs"
                  placeholder="HEAD"
                  value={form.requestedRef ?? ""}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    requestedRef: event.target.value,
                  }))}
                />
              </Field>
            </div>
          </details>

          <div className="rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-xs leading-5 text-sky-800">
            <div className="flex items-center gap-2 font-semibold">
              <KeyRound className="h-3.5 w-3.5" aria-hidden />
              浏览器不会接收 Git 密钥
            </div>
            <p className="mt-1">
              私有仓库只能引用服务端已配置的授权 Profile。浏览器不会得到 Token，绑定也不会推送代码或创建 PR。
            </p>
          </div>

          {error ? (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-700">
              {error}
            </div>
          ) : null}
          <p className="text-xs leading-5 text-slate-500">
            绑定后会直接打开工作台。仓库准备期间可以留在对话页等待。
          </p>
        </div>
        <div className="mt-7 flex justify-end gap-3 border-t border-slate-100 pt-5">
          <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            绑定并打开对话
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
