import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Box,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CloudCog,
  Code2,
  DatabaseZap,
  FileCheck2,
  FileText,
  GitBranch,
  LoaderCircle,
  Eye,
  MessageSquarePlus,
  PackageCheck,
  Play,
  Send,
  Settings2,
  ShieldAlert,
  Sparkles,
  TestTube2,
  Wrench,
} from "lucide-react";

import { MarkdownPreview } from "@/components/markdown-preview";
import { ErrorState, PageSkeleton } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { artifactReviewHeadKey, currentArtifactHeadIds } from "@/lib/artifact-review";
import type {
  AgentEvent,
  AgentHumanGate,
  AgentSession,
  Artifact,
  AskProviderId,
  AskProviderStatus,
  DeepWikiGeneration,
  McpInstallationSummary,
  Project,
  ProjectAgentSettings,
  PhaseRun,
  RunDetail,
  SandboxBlueprintSummary,
} from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";

const SDLC_ROLES = [
  { phaseId: "discovery", role: "PM / BA", label: "需求确认", artifacts: "Change Contract、PRD、Stories", icon: FileText },
  { phaseId: "design", role: "Designer", label: "体验设计", artifacts: "Design Spec / 设计基线", icon: Sparkles },
  { phaseId: "architecture", role: "Architect", label: "架构方案", artifacts: "Options、ADR、Architecture、NFR", icon: Boxes },
  { phaseId: "implementation", role: "Software Engineer", label: "工程实现", artifacts: "实施计划、代码、单元测试、自审", icon: Code2 },
  { phaseId: "verification", role: "Tester", label: "独立验证", artifacts: "Test Report、验收证据、风险", icon: TestTube2 },
  { phaseId: "release", role: "DevOps", label: "发布准备", artifacts: "Release Runbook、回滚条件", icon: PackageCheck },
] as const;

const PROVIDER_NAMES: Record<AskProviderId, string> = {
  openai: "OpenAI",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  custom: "Custom",
};

export function AgentWorkspacePage({
  projectId,
  sessionId,
  onSessionChange,
  onBack,
  onOpenRun,
}: {
  projectId: string;
  sessionId?: string;
  onSessionChange: (sessionId: string) => void;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");
  const [providerId, setProviderId] = useState<AskProviderId>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [inlineReviewBusy, setInlineReviewBusy] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const creationRequestedRef = useRef(false);

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
    refetchInterval: (query) => {
      const operation = query.state.data?.project.repository?.operation;
      return operation?.state === "queued" || operation?.state === "running" ? 1_500 : false;
    },
  });
  const sessionsQuery = useQuery({
    queryKey: ["agent-sessions", projectId],
    queryFn: ({ signal }) => api.listAgentSessions(projectId, { signal }),
    staleTime: 3_000,
  });
  const sessionQuery = useQuery({
    queryKey: ["agent-session", sessionId],
    queryFn: ({ signal }) => api.getAgentSession(sessionId!, { signal }),
    enabled: Boolean(sessionId),
    refetchInterval: (query) => query.state.data?.turnState === "running" ? 1_000 : false,
    retry: false,
  });
  const providersQuery = useQuery({
    queryKey: ["ask", "providers"],
    queryFn: ({ signal }) => api.listAskProviders({ signal }),
    staleTime: 15_000,
  });

  const project = projectQuery.data?.project;
  const session = sessionQuery.data;
  const configuredProviders = (providersQuery.data ?? []).filter(({ configured }) => configured);
  const selectedProviderId = providerId ?? session?.currentProviderId ?? configuredProviders[0]?.id;
  const selectedProvider = (providersQuery.data ?? []).find(({ id }) => id === selectedProviderId);
  const repo = session?.repositories.find(({ projectId: id }) => id === projectId)
    ?? session?.repositories.find(({ accessMode }) => accessMode === "write");

  const createSessionMutation = useMutation({
    mutationFn: () => api.createAgentSession({
      primaryProjectId: projectId,
      ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
    }),
    onSuccess: (created) => {
      queryClient.setQueryData(["agent-session", created.id], created);
      void queryClient.invalidateQueries({ queryKey: ["agent-sessions", projectId] });
      onSessionChange(created.id);
    },
  });

  useEffect(() => {
    if (sessionId || !sessionsQuery.isSuccess) return;
    const existing = sessionsQuery.data.find(({ status }) => status === "active");
    if (existing) {
      onSessionChange(existing.id);
      return;
    }
    const ready = project?.repository?.activeSnapshot?.revision;
    if (!ready || creationRequestedRef.current || createSessionMutation.isPending) return;
    creationRequestedRef.current = true;
    createSessionMutation.mutate();
  }, [createSessionMutation, onSessionChange, project?.repository?.activeSnapshot?.revision, sessionId, sessionsQuery.data, sessionsQuery.isSuccess]);

  useEffect(() => {
    if (!session || providerId) return;
    setProviderId(session.currentProviderId);
  }, [providerId, session]);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [session?.lastMessageSequence, session?.lastEventSequence]);

  const sendMutation = useMutation({
    mutationFn: async (message: string) => {
      if (!session) throw new Error("Agent Session 仍在准备中。");
      return api.sendAgentMessage(session.id, {
        clientMessageId: crypto.randomUUID(),
        expectedSequence: session.lastMessageSequence,
        content: message,
        ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["agent-session", updated.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["agent-sessions", projectId] });
      setContent("");
      setSendError(undefined);
      composerRef.current?.focus();
    },
    onError: (error) => {
      setSendError(error instanceof Error ? error.message : "这条消息没有执行，请重试。");
      void sessionQuery.refetch();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = content.trim();
    if (!message || sendMutation.isPending || inlineReviewBusy) return;
    setSendError(undefined);
    sendMutation.mutate(message);
  };

  const runId = [...(session?.events ?? [])]
    .reverse()
    .find(({ workflowRunId }) => workflowRunId)?.workflowRunId ?? undefined;
  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.getRun(runId!),
    enabled: Boolean(runId),
    refetchInterval: (query) => query.state.data?.run.status === "active" ? 2_000 : false,
  });
  const awaitingReviewPhase = runQuery.data?.phases.find(
    ({ status }) => status === "awaiting_review",
  );

  const continueApprovedRun = async (approvedPhaseId: string) => {
    if (!session || !runId) throw new Error("当前会话或 Run 已变化，请刷新后继续。");
    const latestSession = await api.getAgentSession(session.id);
    queryClient.setQueryData(["agent-session", latestSession.id], latestSession);
    if (latestSession.turnState !== "idle") {
      throw new Error("会话正在处理另一条消息；阶段已经批准，请稍后发送“继续当前 Run”。");
    }
    const updated = await api.sendAgentMessage(latestSession.id, {
      clientMessageId: crypto.randomUUID(),
      expectedSequence: latestSession.lastMessageSequence,
      content: `继续当前 Run。${approvedPhaseId} 已批准，请按固定顺序启动下一角色并沿用已批准产物，不要创建新 Run。`,
      ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
    });
    queryClient.setQueryData(["agent-session", updated.id], updated);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["agent-sessions", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["run", runId] }),
    ]);
  };

  if (projectQuery.isLoading || sessionsQuery.isLoading || (sessionId && sessionQuery.isLoading)) {
    return <PageSkeleton />;
  }
  if (projectQuery.isError) {
    return <ErrorState error={projectQuery.error} retry={() => void projectQuery.refetch()} />;
  }
  if (sessionQuery.isError) {
    return <ErrorState error={sessionQuery.error} retry={() => void sessionQuery.refetch()} />;
  }

  const repositoryReady = Boolean(project?.repository?.activeSnapshot?.revision);
  const waitingForSession = !session;
  return (
    <div className="-mx-4 -my-8 min-h-[calc(100vh-4rem)] sm:-mx-6 lg:-mx-8 lg:-my-10">
      <div className="grid min-h-[calc(100vh-4rem)] bg-white/80 xl:grid-cols-[260px_minmax(0,1fr)_320px]">
        <aside className="hidden border-r border-slate-200 bg-slate-50/80 xl:flex xl:flex-col">
          <div className="border-b border-slate-200 p-4">
            <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" aria-hidden /> 所有仓库
            </Button>
            <div className="mt-4 flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white">
                <GitBranch className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-950">{project?.name}</div>
                <div className="mt-1 truncate font-mono text-xs text-teal-700">
                  @{repo?.repoAlias ?? "repo"}
                </div>
              </div>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <div className="mb-2 flex items-center justify-between px-2">
              <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-slate-400">Agent Sessions</span>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label="新建 Agent Session"
                disabled={!repositoryReady || createSessionMutation.isPending}
                onClick={() => createSessionMutation.mutate()}
              >
                <MessageSquarePlus className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <div className="space-y-1">
              {(sessionsQuery.data ?? []).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSessionChange(item.id)}
                  className={cn(
                    "w-full rounded-xl px-3 py-2.5 text-left transition",
                    item.id === sessionId ? "bg-white shadow-sm ring-1 ring-slate-200" : "hover:bg-white/80",
                  )}
                >
                  <div className="truncate text-sm font-medium text-slate-800">{item.title}</div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                    <span>{PROVIDER_NAMES[item.currentProviderId]}</span>
                    <span>·</span>
                    <span>{item.lastMessageSequence} 条消息</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="border-t border-slate-200 p-3">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-600 transition hover:bg-white hover:text-slate-950"
            >
              <Settings2 className="h-4 w-4" aria-hidden /> 仓库能力设置
            </button>
          </div>
        </aside>

        <section className="flex min-w-0 flex-col">
          <header className="flex min-h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white/90 px-4 py-3 sm:px-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <button type="button" className="xl:hidden" onClick={onBack} aria-label="返回仓库列表">
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <h1 tabIndex={-1} className="truncate text-base font-semibold text-slate-950 focus:outline-none">
                  {session?.title ?? "正在准备 Agent Session"}
                </h1>
                {session?.turnState === "running" ? <Badge variant="info">运行中</Badge> : null}
                {session?.turnState === "waiting_human" ? <Badge variant="warning">等待决定</Badge> : null}
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                <span className="font-mono text-teal-700">@{repo?.repoAlias ?? "repo"}</span>
                <span>·</span>
                <span>{repo?.accessMode === "read" ? "只读" : "可写主仓库"}</span>
                <span>·</span>
                <span className="font-mono">revision {repo?.sourceRevision.slice(0, 10) ?? "准备中"}</span>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="h-4 w-4" aria-hidden /> 设置
            </Button>
          </header>

          <div className="flex-1 overflow-y-auto bg-slate-50/40 px-4 py-6 sm:px-6">
            <div className="mx-auto max-w-3xl space-y-5">
              {!repositoryReady ? (
                <StatusNotice
                  icon={<LoaderCircle className="h-5 w-5 animate-spin" />}
                  title="正在固定仓库版本"
                  description={project?.repository?.operation?.message ?? "源码快照准备好后即可发送消息；DeepWiki 不会自动生成。"}
                />
              ) : null}
              {waitingForSession && repositoryReady ? (
                <StatusNotice
                  icon={<LoaderCircle className="h-5 w-5 animate-spin" />}
                  title="正在创建长期会话"
                  description="消息、Provider、工具调用、Sandbox 和 SDLC 产物都会保存在服务端。"
                />
              ) : null}
              {session && (session.messages?.length ?? 0) === 0 ? (
                <WelcomeMessage alias={repo?.repoAlias ?? "repo"} />
              ) : null}
              {(session?.messages ?? []).map((message) => (
                <div
                  key={message.id}
                  className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
                >
                  <div className={cn(
                    "max-w-[90%] rounded-2xl px-4 py-3 shadow-sm",
                    message.role === "user"
                      ? "rounded-br-md bg-slate-950 text-white"
                      : "rounded-bl-md border border-slate-200 bg-white text-slate-800",
                  )}>
                    {message.role === "assistant" ? (
                      <MarkdownPreview content={message.content} mode="untrusted" className="text-sm" />
                    ) : (
                      <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>
                    )}
                    <div className={cn(
                      "mt-2 flex items-center gap-2 text-[10px]",
                      message.role === "user" ? "text-slate-400" : "text-slate-400",
                    )}>
                      <span>{PROVIDER_NAMES[message.providerId]}</span>
                      {message.model ? <span>· {message.model}</span> : null}
                      <span>· {formatDate(message.createdAt)}</span>
                    </div>
                  </div>
                </div>
              ))}
              <ConversationActivity events={session?.events ?? []} />
              {runId && awaitingReviewPhase ? (
                <InlinePhaseReviewCard
                  key={`${awaitingReviewPhase.id ?? awaitingReviewPhase.phaseId}:${artifactHeadsSignature(awaitingReviewPhase.artifacts)}`}
                  runId={runId}
                  phase={awaitingReviewPhase}
                  canContinue={Boolean(selectedProvider?.configured && selectedProvider.capabilities.toolCalling)}
                  conversationBusy={session?.turnState !== "idle" || sendMutation.isPending}
                  onBusyChange={setInlineReviewBusy}
                  onContinue={() => continueApprovedRun(awaitingReviewPhase.phaseId)}
                  onOpenRun={() => onOpenRun(runId)}
                />
              ) : null}
              {(session?.humanGates ?? []).filter(({ status }) => status === "pending").map((gate) => (
                <UnavailableCapabilityCard key={gate.id} gate={gate} />
              ))}
              <div ref={conversationEndRef} />
            </div>
          </div>

          <div className="border-t border-slate-200 bg-white px-4 py-4 sm:px-6">
            <form onSubmit={submit} className="mx-auto max-w-3xl">
              {sendError ? (
                <div role="alert" className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {sendError}
                </div>
              ) : null}
              <div className="rounded-2xl border border-slate-200 bg-white p-2 shadow-lg shadow-slate-900/5 focus-within:border-teal-400 focus-within:ring-4 focus-within:ring-teal-500/10">
                <Textarea
                  ref={composerRef}
                  aria-label="消息输入框"
                  rows={3}
                  className="min-h-20 resize-none border-0 px-3 py-2 shadow-none focus:ring-0"
                  placeholder={`告诉 Agent 要做什么，例如：@${repo?.repoAlias ?? "repo"} 修好登录问题，involve Tester 并跑测试`}
                  value={content}
                  disabled={!session || !repositoryReady || sendMutation.isPending || inlineReviewBusy}
                  onChange={(event) => setContent(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-2 pt-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="hidden text-xs text-slate-400 sm:inline">本轮模型</span>
                    <select
                      aria-label="切换 Provider"
                      className="h-8 max-w-52 rounded-lg border border-slate-200 bg-slate-50 px-2 text-xs font-medium text-slate-700 outline-none focus:border-teal-500"
                      value={selectedProviderId ?? ""}
                      onChange={(event) => setProviderId(event.target.value as AskProviderId)}
                    >
                      {configuredProviders.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.label} · {provider.model}
                        </option>
                      ))}
                    </select>
                    <ProviderCapability provider={selectedProvider} />
                  </div>
                  <Button
                    type="submit"
                    size="sm"
                    variant="primary"
                    loading={sendMutation.isPending}
                    disabled={!content.trim() || !session || !selectedProvider?.configured || !repositoryReady || inlineReviewBusy}
                  >
                    <Send className="h-4 w-4" aria-hidden /> 发送
                  </Button>
                </div>
              </div>
              <p className="mt-2 px-2 text-[11px] leading-5 text-slate-400">
                当前只开放只读 Work Item MCP。外部写入、DDL、Secret 操作、部署与发布尚未开放；这里真正需要你决定的是各角色的阶段产物审阅。
              </p>
            </form>
          </div>
        </section>

        <RoleTimeline
          session={session}
          run={runQuery.data}
          onOpenRun={onOpenRun}
        />
      </div>

      {project ? (
        <RepositorySettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          project={project}
          session={session}
          selectedProviderId={selectedProviderId}
        />
      ) : null}
    </div>
  );
}

function WelcomeMessage({ alias }: { alias: string }) {
  return (
    <div className="rounded-2xl border border-teal-100 bg-gradient-to-br from-white to-teal-50/70 p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-600 text-white">
          <Bot className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h2 className="text-base font-semibold text-slate-950">仓库已加入对话</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            直接说目标即可。我会解析 <span className="font-mono font-semibold text-teal-700">@{alias}</span>、按需读取已激活 MCP、懒启动 Sandbox，并把六个 SDLC 角色的产物串起来。
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
            <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">“解释登录流程”</span>
            <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">“修好问题并跑测试”</span>
            <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">“involve Architect 评估方案”</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusNotice({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-sky-100 bg-sky-50 px-4 py-3 text-sky-800">
      <span className="mt-0.5">{icon}</span>
      <div>
        <div className="text-sm font-semibold">{title}</div>
        <p className="mt-1 text-xs leading-5">{description}</p>
      </div>
    </div>
  );
}

function ProviderCapability({ provider }: { provider?: AskProviderStatus }) {
  if (!provider) return null;
  return provider.capabilities.toolCalling ? (
    <Badge variant="success" className="hidden sm:inline-flex">工具调用已启用</Badge>
  ) : (
    <Badge variant="warning" className="hidden sm:inline-flex" title="这个 Provider 只能对话和生成 DeepWiki，不能启动 Agent 工具回合">
      只能对话 / DeepWiki
    </Badge>
  );
}

function ConversationActivity({ events }: { events: AgentEvent[] }) {
  const visible = events.filter(({ kind }) => [
    "tool.completed", "tool.failed", "sandbox.starting", "sandbox.ready", "sandbox.failed",
    "sdlc.run-created", "turn.failed",
  ].includes(kind));
  if (!visible.length) return null;
  return (
    <div className="space-y-2" aria-label="Agent 事件 timeline">
      {visible.slice(-8).map((event) => (
        <div key={event.id} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-600">
          {event.status === "failed" ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-hidden />
          ) : event.kind.startsWith("sandbox") ? (
            <Box className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" aria-hidden />
          ) : event.kind.startsWith("tool") ? (
            <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" aria-hidden />
          ) : (
            <Play className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <div className="leading-5">{event.summary}</div>
            <div className="mt-1 text-[10px] uppercase tracking-wide text-slate-400">{event.kind}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function InlinePhaseReviewCard({
  runId,
  phase,
  canContinue,
  conversationBusy,
  onBusyChange,
  onContinue,
  onOpenRun,
}: {
  runId: string;
  phase: PhaseRun;
  canContinue: boolean;
  conversationBusy: boolean;
  onBusyChange: (busy: boolean) => void;
  onContinue: () => Promise<void>;
  onOpenRun: () => void;
}) {
  const queryClient = useQueryClient();
  const heads = currentArtifactHeads(phase.artifacts);
  const [expandedHeads, setExpandedHeads] = useState<Set<string>>(() => new Set());
  const [viewedHeads, setViewedHeads] = useState<Set<string>>(() => new Set());
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string>();
  const allViewed = heads.length > 0 && heads.every((artifact) => (
    viewedHeads.has(inlineArtifactHeadKey(artifact))
  ));

  const reviewMutation = useMutation({
    mutationFn: async (decision: "approve" | "request_changes") => {
      const expectedArtifactIds = currentArtifactHeadIds(heads);
      if (expectedArtifactIds.length !== heads.length || !allViewed) {
        throw new Error("产物列表已经变化，请重新展开并查看当前全部产物。");
      }
      const reviewComment = decision === "approve"
        ? "已在 Agent 工作台逐项查看当前全部产物，同意按固定顺序进入下一阶段。"
        : comment.trim();
      await api.reviewPhase(runId, phase.phaseId, decision, reviewComment, expectedArtifactIds);
      if (decision === "approve") {
        try {
          await onContinue();
        } catch (continuationError) {
          const message = continuationError instanceof Error
            ? continuationError.message
            : "下一角色未能启动";
          throw new Error(`产物已经批准，但自动继续失败：${message}`);
        }
      } else {
        await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      }
      return decision;
    },
    onMutate: () => {
      setError(undefined);
      onBusyChange(true);
    },
    onSuccess: () => setError(undefined),
    onError: async (reviewError) => {
      setError(reviewError instanceof Error ? reviewError.message : "这次决定没有保存，请重试。");
      await queryClient.invalidateQueries({ queryKey: ["run", runId] });
    },
    onSettled: () => onBusyChange(false),
  });

  const unviewedCount = heads.length - viewedHeads.size;
  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4 shadow-sm" aria-label="查看产物并决定">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-800">
            <Eye className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-amber-950">查看产物并决定</h3>
              <Badge variant="warning">{phaseRoleName(phase.phaseId)} · 等待审阅</Badge>
            </div>
            <p className="mt-1 text-xs leading-5 text-amber-900">
              这个角色已经交出 {heads.length} 份当前产物。全部展开并成功读取后，才能批准或要求修改。
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onOpenRun}>
          高级审计 <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      {heads.length > 0 ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center justify-between gap-3 text-[11px] text-amber-800">
            <span>已查看 {heads.length - unviewedCount} / {heads.length}</span>
            <button
              type="button"
              className="font-semibold underline decoration-amber-400 underline-offset-2"
              onClick={() => setExpandedHeads(new Set(heads.map(inlineArtifactHeadKey)))}
            >
              展开全部产物
            </button>
          </div>
          {heads.map((artifact) => {
            const headKey = inlineArtifactHeadKey(artifact);
            return (
              <InlineArtifactViewer
                key={headKey}
                artifact={artifact}
                expanded={expandedHeads.has(headKey)}
                viewed={viewedHeads.has(headKey)}
                onToggle={() => setExpandedHeads((current) => toggleSetValue(current, headKey))}
                onViewed={() => setViewedHeads((current) => addSetValue(current, headKey))}
              />
            );
          })}
        </div>
      ) : (
        <div role="alert" className="mt-3 rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs text-rose-700">
          后端说阶段正在等待审阅，但没有返回当前产物。为安全起见不能批准，请打开高级审计检查。
        </div>
      )}

      <label className="mt-4 block text-xs font-semibold text-slate-700">
        修改意见
        <Textarea
          className="mt-1.5 min-h-20 bg-white text-sm"
          value={comment}
          maxLength={5_000}
          placeholder="只有要求修改时必填：请直接说明哪里不对、希望怎么改。"
          onChange={(event) => setComment(event.target.value)}
          disabled={reviewMutation.isPending}
        />
      </label>

      {!canContinue ? (
        <p className="mt-2 text-xs text-amber-800">
          “批准并继续”需要先在输入框旁切换到支持工具调用的 Provider；这不会影响查看或要求修改。
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-700">
          {error}
          <div className="mt-1 text-xs text-rose-600">
            后端门禁没有被绕过。你可以修改意见后重试，或打开高级审计处理完整决定。
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          loading={reviewMutation.isPending && reviewMutation.variables === "request_changes"}
          disabled={!allViewed || !comment.trim() || conversationBusy || reviewMutation.isPending}
          onClick={() => reviewMutation.mutate("request_changes")}
        >
          要求修改
        </Button>
        <Button
          variant="success"
          size="sm"
          loading={reviewMutation.isPending && reviewMutation.variables === "approve"}
          disabled={!allViewed || !canContinue || conversationBusy || reviewMutation.isPending}
          onClick={() => reviewMutation.mutate("approve")}
        >
          <Check className="h-4 w-4" aria-hidden /> 批准并继续
        </Button>
      </div>
    </section>
  );
}

function InlineArtifactViewer({
  artifact,
  expanded,
  viewed,
  onToggle,
  onViewed,
}: {
  artifact: Artifact;
  expanded: boolean;
  viewed: boolean;
  onToggle: () => void;
  onViewed: () => void;
}) {
  const artifactQuery = useQuery({
    queryKey: ["artifact", artifact.id],
    queryFn: () => api.getArtifact(artifact.id),
    enabled: expanded,
    staleTime: 30_000,
  });
  const content = artifactQuery.data?.content;
  useEffect(() => {
    if (expanded && artifactQuery.isSuccess && typeof content === "string") onViewed();
  }, [artifactQuery.isSuccess, content, expanded, onViewed]);

  return (
    <div className="overflow-hidden rounded-xl border border-amber-200 bg-white">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {expanded ? <ChevronUp className="h-4 w-4 shrink-0 text-amber-700" /> : <ChevronDown className="h-4 w-4 shrink-0 text-amber-700" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-slate-800">{artifactPlainName(artifact)}</span>
          <span className="mt-0.5 block truncate font-mono text-[10px] text-slate-400">
            {artifact.artifactKey ?? artifact.filePath ?? artifact.id} · revision {artifact.revision ?? 1}
          </span>
        </span>
        {viewed ? <Badge variant="success">已查看</Badge> : <Badge>未查看</Badge>}
      </button>
      {expanded ? (
        <div className="border-t border-slate-100 px-3 py-3">
          {artifactQuery.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> 正在安全读取当前版本…
            </div>
          ) : artifactQuery.isError ? (
            <div role="alert" className="text-xs leading-5 text-rose-700">
              这份产物读取失败，暂时不能算作已查看：{artifactQuery.error instanceof Error ? artifactQuery.error.message : "请重试"}
            </div>
          ) : typeof content === "string" ? (
            <div className="max-h-80 overflow-y-auto rounded-lg bg-slate-50 px-3 py-2">
              <MarkdownPreview content={content} mode="untrusted" className="text-xs leading-5" />
            </div>
          ) : (
            <div role="alert" className="text-xs text-rose-700">这份产物没有可审阅内容，因此不能批准。</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function currentArtifactHeads(artifacts: Artifact[]): Artifact[] {
  return artifacts.filter(({ superseded, reviewStatus }) => (
    !superseded && reviewStatus !== "superseded"
  ));
}

function artifactHeadsSignature(artifacts: Artifact[]): string {
  return currentArtifactHeads(artifacts).map(inlineArtifactHeadKey).sort().join("|");
}

function inlineArtifactHeadKey(artifact: Artifact): string {
  return artifactReviewHeadKey(artifact) ?? `${artifact.id}:${artifact.contentHash ?? "missing-hash"}`;
}

function toggleSetValue(values: Set<string>, value: string): Set<string> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function addSetValue(values: Set<string>, value: string): Set<string> {
  if (values.has(value)) return values;
  const next = new Set(values);
  next.add(value);
  return next;
}

function artifactPlainName(artifact: Artifact): string {
  const key = artifact.artifactKey ?? artifact.name ?? artifact.type ?? artifact.id;
  return ({
    "change-contract": "这次任务约定",
    prd: "需求说明",
    "user-stories": "用户故事与验收条件",
    "design-baseline": "设计基线",
    "design-spec": "界面与交互说明",
    "architecture-options": "架构备选方案",
    architecture: "架构说明",
    "implementation-plan": "实施计划",
    "implementation-notes": "实现结果",
    "engineering-test-evidence": "工程测试证据",
    "engineering-review": "工程自审",
    "test-report": "独立测试报告",
    "release-runbook": "发布与回滚说明",
  } as Record<string, string>)[key] ?? key.replaceAll("-", " ");
}

function phaseRoleName(phaseId: string): string {
  return SDLC_ROLES.find((item) => item.phaseId === phaseId)?.role ?? phaseId;
}

function UnavailableCapabilityCard({ gate }: { gate: AgentHumanGate }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4" role="alert">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-amber-950">这类操作尚未开放</h3>
            <Badge variant="warning">不会执行</Badge>
          </div>
          <p className="mt-2 text-sm leading-6 text-amber-900">{gate.question}</p>
          <p className="mt-3 text-[11px] leading-5 text-amber-800">
            当前 Web 没有通用外部副作用批准入口，也不会把这条记录当作授权。可操作的人类门禁只有当前阶段的角色产物审阅。
          </p>
        </div>
      </div>
    </div>
  );
}

function RoleTimeline({
  session,
  run,
  onOpenRun,
}: {
  session?: AgentSession;
  run?: RunDetail;
  onOpenRun: (runId: string) => void;
}) {
  const events = session?.events ?? [];
  const runEvent = [...events].reverse().find(({ kind }) => kind === "sdlc.run-created");
  return (
    <aside className="hidden border-l border-slate-200 bg-white xl:block">
      <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-950">SDLC 角色进度</h2>
            <p className="mt-1 text-xs text-slate-500">产物按固定顺序传给下一角色</p>
          </div>
          {runEvent?.workflowRunId ? (
            <Button variant="ghost" size="sm" onClick={() => onOpenRun(runEvent.workflowRunId!)}>
              高级审计 <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        <div className="mt-5 space-y-0">
          {SDLC_ROLES.map((item, index) => {
            const phase = run?.phases.find(({ phaseId }) => phaseId === item.phaseId);
            const completed = events.some(({ kind, phaseId, status }) => (
              kind === "sdlc.phase-completed" && phaseId === item.phaseId && status === "completed"
            )) || phase?.status === "approved";
            const running = events.some(({ kind, phaseId, status }) => (
              kind === "sdlc.phase-started" && phaseId === item.phaseId && status === "started"
            )) || phase?.status === "running" || phase?.status === "awaiting_review";
            const Icon = item.icon;
            return (
              <div key={item.phaseId} className="relative flex gap-3 pb-5">
                {index < SDLC_ROLES.length - 1 ? (
                  <span className={cn("absolute left-[15px] top-8 h-[calc(100%-1.25rem)] w-px", completed ? "bg-emerald-300" : "bg-slate-200")} />
                ) : null}
                <span className={cn(
                  "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                  completed ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : running ? "border-sky-200 bg-sky-50 text-sky-700"
                    : "border-slate-200 bg-white text-slate-400",
                )}>
                  {completed ? <Check className="h-4 w-4" /> : running ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
                </span>
                <div className="min-w-0 pt-0.5">
                  <div className="text-xs font-semibold text-slate-900">{item.role}</div>
                  <div className="mt-0.5 text-[11px] text-slate-500">{item.label}</div>
                  <div className="mt-1.5 text-[10px] leading-4 text-slate-400">产物：{item.artifacts}</div>
                  {(phase?.artifacts ?? []).length ? (
                    <div className="mt-2 space-y-1">
                      {phase!.artifacts.slice(0, 3).map((artifact) => (
                        <div key={artifact.id} className="truncate rounded-md bg-slate-50 px-2 py-1 font-mono text-[10px] text-slate-500">
                          {artifact.artifactKey ?? artifact.filePath ?? "artifact"}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
            <FileCheck2 className="h-4 w-4 text-teal-600" /> 交付证据
          </div>
          <p className="mt-2 text-[11px] leading-5 text-slate-500">
            对话里显示产物摘要、Diff、测试和风险；完整 Artifact、Review、Patch 与 Run 日志保留在高级审计。
          </p>
        </div>
      </div>
    </aside>
  );
}

function RepositorySettingsDialog({
  open,
  onOpenChange,
  project,
  session,
  selectedProviderId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  session?: AgentSession;
  selectedProviderId?: AskProviderId;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const [repoAliasDraft, setRepoAliasDraft] = useState("");
  const settingsQuery = useQuery({
    queryKey: ["agent-settings", project.id],
    queryFn: ({ signal }) => api.getProjectAgentSettings(project.id, { signal }),
    enabled: open,
  });
  const blueprintsQuery = useQuery({
    queryKey: ["sandbox-blueprints"],
    queryFn: ({ signal }) => api.listSandboxBlueprints({ signal }),
    enabled: open,
  });
  const mcpQuery = useQuery({
    queryKey: ["mcp-installations"],
    queryFn: ({ signal }) => api.listMcpInstallations({ signal }),
    enabled: open,
  });
  const providersQuery = useQuery({
    queryKey: ["ask", "providers"],
    queryFn: ({ signal }) => api.listAskProviders({ signal }),
    enabled: open,
  });
  const deepWikiQuery = useQuery({
    queryKey: ["deepwiki", project.id],
    queryFn: ({ signal }) => api.getLatestDeepWiki(project.id, { signal }),
    enabled: open && Boolean(project.repository?.activeSnapshot),
    retry: false,
  });

  const updateMutation = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateProjectAgentSettings>[1]) => (
      api.updateProjectAgentSettings(project.id, patch)
    ),
    onSuccess: (updated) => {
      queryClient.setQueryData(["agent-settings", project.id], updated);
      setError(undefined);
    },
    onError: (mutationError) => setError(mutationError instanceof Error ? mutationError.message : "设置没有保存"),
  });
  const mcpMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.activateMcp(project.id, id, enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-settings", project.id] });
      setError(undefined);
    },
    onError: (mutationError) => setError(mutationError instanceof Error ? mutationError.message : "MCP 激活失败"),
  });
  const deepWikiMutation = useMutation({
    mutationFn: () => {
      const revision = project.repository?.activeSnapshot?.revision;
      if (!revision) throw new Error("仓库版本尚未固定。");
      return api.generateDeepWiki(project.id, {
        expectedRevision: revision,
        providerId: selectedProviderId ?? settingsQuery.data?.defaultProviderId,
        clientRequestId: crypto.randomUUID(),
      });
    },
    onSuccess: (generation) => {
      queryClient.setQueryData(["deepwiki", project.id], generation);
      setError(undefined);
    },
    onError: (mutationError) => setError(mutationError instanceof Error ? mutationError.message : "DeepWiki 生成失败"),
  });

  const settings = settingsQuery.data;
  useEffect(() => {
    if (settings) setRepoAliasDraft(settings.repoAlias);
  }, [settings]);
  const save = (patch: Omit<Parameters<typeof api.updateProjectAgentSettings>[1], "expectedVersion">) => {
    if (!settings) return;
    updateMutation.mutate({ expectedVersion: settings.version, ...patch });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`@${settings?.repoAlias ?? "repo"} 能力设置`}
      description="Provider、Sandbox 蓝图和只读 Work Item MCP 在仓库绑定后配置；浏览器不接收 Secret 或任意执行参数。"
      className="max-w-2xl"
    >
      <div className="overflow-y-auto p-6">
        {settingsQuery.isLoading ? <PageSkeleton /> : settingsQuery.isError ? (
          <ErrorState error={settingsQuery.error} retry={() => void settingsQuery.refetch()} />
        ) : settings ? (
          <div className="space-y-6">
            <section>
              <h3 className="text-sm font-semibold text-slate-900">项目开始时的默认能力</h3>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <label className="text-xs font-medium text-slate-600">
                  Repo alias
                  <Input
                    className="mt-1.5 font-mono"
                    value={repoAliasDraft}
                    onChange={(event) => setRepoAliasDraft(event.target.value)}
                    onBlur={(event) => {
                      const repoAlias = event.currentTarget.value.trim();
                      if (repoAlias && repoAlias !== settings.repoAlias) save({ repoAlias });
                    }}
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  默认 Provider
                  <select
                    className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-teal-500"
                    value={settings.defaultProviderId}
                    onChange={(event) => save({ defaultProviderId: event.target.value as AskProviderId })}
                  >
                    {(providersQuery.data ?? []).map((provider) => (
                      <option key={provider.id} value={provider.id} disabled={!provider.configured}>
                        {provider.label} {provider.configured ? `· ${provider.model}` : "· 未配置"}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="mt-2 text-[11px] leading-5 text-slate-500">
                对话时仍可切换 Provider，只影响下一条消息，不会清空 Agent Session。
              </p>
              <p className="mt-1 text-[11px] leading-5 text-slate-500">
                项目聊天 Provider 的凭据只留在服务端，不会进入消息、仓库、Sandbox，也不会传给阶段 Codex Worker；阶段 Worker 使用独立的低权限运行密钥。
              </p>
            </section>

            <section className="border-t border-slate-100 pt-5">
              <div className="flex items-center gap-2">
                <CloudCog className="h-4 w-4 text-sky-600" />
                <h3 className="text-sm font-semibold text-slate-900">Sandbox 蓝图</h3>
              </div>
              <select
                aria-label="Sandbox blueprint"
                className="mt-3 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-teal-500"
                value={`${settings.sandboxBlueprintId}@${settings.sandboxBlueprintVersion}`}
                onChange={(event) => {
                  const blueprint = blueprintsQuery.data?.find((candidate) => `${candidate.id}@${candidate.version}` === event.target.value);
                  if (blueprint) save({ sandboxBlueprintId: blueprint.id, sandboxBlueprintVersion: blueprint.version });
                }}
              >
                {(blueprintsQuery.data ?? []).map((blueprint) => (
                  <option key={`${blueprint.id}@${blueprint.version}`} value={`${blueprint.id}@${blueprint.version}`} disabled={!blueprint.configured}>
                    {blueprint.label} · {blueprint.version}{blueprint.configured ? "" : " · 未配置"}
                  </option>
                ))}
              </select>
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-600">
                状态：{sandboxLabel(session)}。首次明确写代码时懒启动；固定 revision 与蓝图版本。主仓库可写，额外 @repo 只读。
              </div>
            </section>

            <section className="border-t border-slate-100 pt-5">
              <div className="flex items-center gap-2">
                <Wrench className="h-4 w-4 text-violet-600" />
                <h3 className="text-sm font-semibold text-slate-900">已安装的 MCP</h3>
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                当前 MVP 只开放已安装、已授权且已激活的只读 Work Item MCP。非只读 MCP 与通用外部写入批准入口尚未开放。
              </p>
              <div className="mt-3 space-y-2">
                {(mcpQuery.data ?? []).map((installation) => (
                  <McpToggle
                    key={installation.id}
                    installation={installation}
                    enabled={settings.enabledMcpServerIds.includes(installation.id)}
                    busy={mcpMutation.isPending}
                    onChange={(enabled) => mcpMutation.mutate({ id: installation.id, enabled })}
                  />
                ))}
                {mcpQuery.isSuccess && !mcpQuery.data.length ? (
                  <p className="rounded-xl bg-slate-50 px-3 py-3 text-xs text-slate-500">管理员尚未安装 MCP；仍可用手工描述开始任务。</p>
                ) : null}
              </div>
            </section>

            <DeepWikiPanel
              generation={deepWikiQuery.data}
              revision={project.repository?.activeSnapshot?.revision}
              providerId={selectedProviderId ?? settings.defaultProviderId}
              pending={deepWikiMutation.isPending}
              onGenerate={() => deepWikiMutation.mutate()}
            />

            {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function McpToggle({
  installation,
  enabled,
  busy,
  onChange,
}: {
  installation: McpInstallationSummary;
  enabled: boolean;
  busy: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const readOnly = installation.permissionClasses.length > 0
    && installation.permissionClasses.every((item) => item === "read");
  const available = readOnly && installation.installed && installation.authorization !== "missing";
  return (
    <label className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 px-3 py-3">
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-800">
          {installation.label}
          <Badge variant={readOnly ? "success" : "warning"}>
            {readOnly ? "只读 Work Item" : "尚未开放 · 非只读"}
          </Badge>
        </span>
        <span className="mt-1 block text-xs leading-5 text-slate-500">{installation.description}</span>
        {!readOnly ? (
          <span className="mt-1 block text-[11px] text-amber-700">当前不能启用或调用包含外部副作用的 MCP。</span>
        ) : !available ? (
          <span className="mt-1 block text-[11px] text-amber-700">{installation.installHint ?? "需要管理员完成授权"}</span>
        ) : null}
      </span>
      <input
        type="checkbox"
        aria-label={`${installation.label} 已启用`}
        checked={enabled}
        disabled={!available || busy}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
      />
    </label>
  );
}

function DeepWikiPanel({
  generation,
  revision,
  providerId,
  pending,
  onGenerate,
}: {
  generation?: DeepWikiGeneration | null;
  revision?: string;
  providerId: AskProviderId;
  pending: boolean;
  onGenerate: () => void;
}) {
  const stale = generation?.status === "stale" || Boolean(generation && revision && generation.revision !== revision);
  return (
    <section className="border-t border-slate-100 pt-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <DatabaseZap className="h-4 w-4 text-teal-600" />
            <h3 className="text-sm font-semibold text-slate-900">DeepWiki</h3>
            {stale ? <Badge variant="warning">stale · 已过期</Badge> : generation?.status === "ready" ? <Badge variant="success">已生成</Badge> : null}
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            当前只在这个设置弹窗通过 Project API 手动生成。使用 {PROVIDER_NAMES[providerId]}，固定版本 {revision?.slice(0, 10) ?? "尚未就绪"}；绑定仓库时不会自动花费模型额度，会话命令和 @repo 菜单暂未提供。
          </p>
        </div>
        <Button size="sm" variant="outline" loading={pending} disabled={!revision} onClick={onGenerate}>
          <Sparkles className="h-4 w-4" /> 生成 DeepWiki
        </Button>
      </div>
      {generation?.content ? (
        <details className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-700">查看项目知识 · {generation.model}</summary>
          <MarkdownPreview content={generation.content} mode="untrusted" className="mt-4 text-xs" />
        </details>
      ) : null}
    </section>
  );
}

function sandboxLabel(session?: AgentSession): string {
  const state = session?.sandbox?.state;
  if (!state) return "尚未启动";
  if (state === "starting") return "启动中";
  if (state === "ready") return "已就绪";
  if (state === "busy") return "正在工作";
  if (state === "stopped") return "已停止";
  return "启动失败";
}
