import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clock3,
  FileCode2,
  FolderGit2,
  GitCommitHorizontal,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  WandSparkles,
  Wifi,
  WifiOff,
} from "lucide-react";

import { ErrorState, Field, PageSkeleton } from "@/components/states";
import { MarkdownPreview } from "@/components/markdown-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import {
  appendAskExchange,
  askAnswerToCreateRunInput,
  askHistory,
  clearAskSession,
  confirmedWorkItemDraftMissingFields,
  emptyAskSession,
  isAskThreadIdentityLoaded,
  loadAskSession,
  pendingAskThreadSession,
  safeAskThreadTitle,
  saveAskSession,
  type AskConfirmedWorkItemDraft,
  type AskSessionMessage,
  type AskSessionState,
} from "@/lib/ask-session";
import {
  isAskNewThreadRequiredError,
  isAskRevisionConflictError,
} from "@/lib/ask-error";
import type {
  AskAnswer,
  AskCitation,
  AskProviderAvailability,
  AskProviderId,
  AskProviderStatus,
  AskThread,
  AskWorkItemDraft,
  WorkflowRun,
} from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";
import { WORK_TYPE_OPTIONS } from "@/lib/change-contract";

const SUGGESTED_QUESTIONS = [
  "这个项目从哪里启动？",
  "一次请求通常会经过哪些主要模块？",
  "如果修改核心数据结构，可能影响哪些地方？",
];

const PROVIDER_ORDER: readonly AskProviderId[] = [
  "openai",
  "lmstudio",
  "ollama",
  "custom",
];

const PROVIDER_DISPLAY_NAME: Record<AskProviderId, string> = {
  openai: "OpenAI",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  custom: "Custom",
};

const PROVIDER_SERVER_HINT: Record<AskProviderId, string> = {
  openai: "服务端配置 AI_SDLC_ASK_OPENAI_*；Web 不接收凭据。",
  lmstudio: "服务端配置 AI_SDLC_ASK_LM_STUDIO_MODEL 与 AI_SDLC_ASK_LM_STUDIO_BASE_URL。",
  ollama: "服务端配置 AI_SDLC_ASK_OLLAMA_MODEL 与 AI_SDLC_ASK_OLLAMA_BASE_URL。",
  custom: "服务端配置 AI_SDLC_ASK_CUSTOM_PROTOCOL、AI_SDLC_ASK_CUSTOM_BASE_URL 与 AI_SDLC_ASK_CUSTOM_MODEL。",
};

const DATA_BOUNDARY_COPY: Record<AskProviderStatus["dataBoundary"], string> = {
  remote: "相关项目片段会发送到远程模型服务。",
  local: "相关项目片段只发送到平台部署内的模型服务。",
  "operator-configured": "数据发送到你配置的服务地址，请自行确认它的数据边界。",
};

interface AskFailure {
  message: string;
  revisionChanged: boolean;
  newThreadRequired?: boolean;
}

export function AskPage({
  projectId,
  onBack,
  onOpenRun,
}: {
  projectId: string;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<AskSessionState>(() => loadAskSession(projectId));
  const [activeThreadId, setActiveThreadId] = useState<string>();
  const [startingNewThread, setStartingNewThread] = useState(false);
  const [question, setQuestion] = useState("");
  const [failure, setFailure] = useState<AskFailure>();
  const [draftAnswer, setDraftAnswer] = useState<AskAnswer>();
  const [draftSourceRevision, setDraftSourceRevision] = useState<string>();
  const askControllerRef = useRef<AbortController>();
  const remoteSessionResetRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const conversationEndRef = useRef<HTMLDivElement>(null);

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
  });
  const remoteProject = projectQuery.data?.project.sourceKind === "remote-git";
  const threadsQuery = useQuery({
    queryKey: ["ask", "threads", projectId],
    queryFn: ({ signal }) => api.listAskThreads(projectId, { signal }),
    enabled: remoteProject,
    staleTime: 5_000,
    retry: false,
  });
  const threadQuery = useQuery({
    queryKey: ["ask", "thread", activeThreadId],
    queryFn: ({ signal }) => api.getAskThread(activeThreadId!, { signal }),
    enabled: remoteProject && Boolean(activeThreadId),
    staleTime: 5_000,
    retry: false,
  });
  const providersQuery = useQuery({
    queryKey: ["ask", "providers"],
    queryFn: ({ signal }) => api.listAskProviders({ signal }),
    staleTime: 10_000,
  });

  const configuredProviders = useMemo(
    () => (providersQuery.data ?? []).filter((provider) => provider.configured),
    [providersQuery.data],
  );
  // Once a user/session has selected a Provider, keep that identity even when
  // its server configuration disappears. Silently choosing another configured
  // Provider could move repository context across a different data boundary.
  const selectedProviderId = session.providerId ?? configuredProviders[0]?.id;
  const selectedProvider = (providersQuery.data ?? []).find(
    (provider) => provider.id === selectedProviderId,
  );
  const threadIdentityReady = !remoteProject || isAskThreadIdentityLoaded(
    activeThreadId,
    selectedProviderId,
    session.revision,
    threadQuery.data,
  );

  useEffect(() => {
    if (!remoteProject || remoteSessionResetRef.current) return;
    remoteSessionResetRef.current = true;
    setSession((current) => emptyAskSession(current.providerId));
  }, [remoteProject]);

  useEffect(() => {
    if (!providersQuery.isSuccess) return;
    if (session.providerId || !selectedProviderId) return;
    setSession((current) => ({
      ...current,
      providerId: selectedProviderId,
    }));
  }, [providersQuery.isSuccess, selectedProviderId, session.providerId]);

  useEffect(() => {
    if (!remoteProject || !threadsQuery.isSuccess || activeThreadId || startingNewThread) return;
    const latest = threadsQuery.data.find((thread) => thread.status === "active");
    if (latest) {
      setActiveThreadId(latest.id);
      setSession(pendingAskThreadSession(latest));
      return;
    }
    setSession(emptyAskSession(selectedProviderId));
  }, [activeThreadId, remoteProject, selectedProviderId, startingNewThread, threadsQuery.data, threadsQuery.isSuccess]);

  useEffect(() => {
    if (!remoteProject || !threadQuery.data) return;
    if (threadQuery.data.projectId !== projectId) return;
    setSession(askThreadToSession(threadQuery.data));
  }, [projectId, remoteProject, threadQuery.data]);

  useEffect(() => {
    if (remoteProject) return;
    saveAskSession(projectId, session);
  }, [projectId, remoteProject, session]);

  useEffect(() => () => askControllerRef.current?.abort(), []);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [session.messages.length]);

  const providerCheckQuery = useQuery({
    queryKey: ["ask", "provider-check", selectedProviderId],
    queryFn: ({ signal }) => api.checkAskProvider(selectedProviderId!, { signal }),
    enabled: Boolean(selectedProviderId && selectedProvider?.configured),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const providerReady = selectedProvider?.configured === true
    && providerCheckQuery.data?.state === "ready";

  const askMutation = useMutation({
    mutationFn: async ({
      providerId,
      nextQuestion,
      expectedRevision,
    }: {
      providerId: AskProviderId;
      nextQuestion: string;
      expectedRevision?: string;
    }) => {
      const controller = new AbortController();
      askControllerRef.current = controller;
      if (remoteProject) {
        const revision = expectedRevision
          ?? projectQuery.data?.project.repository?.activeSnapshot?.revision;
        if (!revision) {
          throw new ApiError("仓库快照尚未就绪，暂时不能开始云端对话。", 409, "REPOSITORY_NOT_READY");
        }
        let threadId = activeThreadId;
        let threadRevision = revision;
        if (threadId) {
          const loadedThread = threadQuery.data;
          if (!isAskThreadIdentityLoaded(
            threadId,
            providerId,
            expectedRevision,
            loadedThread,
          )) {
            throw new ApiError(
              "选中的云端对话仍在读取，确认模型和版本后再发送。",
              409,
              "ASK_THREAD_IDENTITY_PENDING",
            );
          }
          threadRevision = loadedThread!.revision;
        } else {
          const created = await api.createAskThread(
            projectId,
            {
              providerId,
              revision,
              ...safeAskThreadTitle(nextQuestion),
            },
            { signal: controller.signal },
          );
          threadId = created.id;
          threadRevision = created.revision;
          // Keep the server-created thread even if the first model request is
          // later cancelled or fails, so retrying cannot create empty copies.
          setActiveThreadId(created.id);
          setStartingNewThread(false);
          setSession(askThreadToSession(created));
          queryClient.setQueryData(["ask", "thread", created.id], created);
          void queryClient.invalidateQueries({ queryKey: ["ask", "threads", projectId] });
        }
        const thread = await api.askThread(
          threadId,
          { question: nextQuestion, expectedRevision: threadRevision },
          { signal: controller.signal },
        );
        const answer = [...thread.messages]
          .reverse()
          .find((message) => message.role === "assistant")?.answer;
        if (!answer) {
          throw new ApiError("云端对话没有返回可验证的回答。", 502, "INVALID_API_RESPONSE");
        }
        return { answer, thread };
      }
      const answer = await api.askProject(
        projectId,
        {
          providerId,
          question: nextQuestion,
          history: askHistory(session.messages),
          ...(expectedRevision ? { expectedRevision } : {}),
        },
        { signal: controller.signal },
      );
      return { answer };
    },
    onSuccess: ({ answer, thread }, variables) => {
      askControllerRef.current = undefined;
      if (variables.expectedRevision && answer.revision !== variables.expectedRevision) {
        setFailure({
          revisionChanged: true,
          message: "项目版本已经变化。为避免把两个版本的源码混在同一个回答里，本次结果没有加入对话。",
        });
        return;
      }
      if (thread) {
        setActiveThreadId(thread.id);
        setStartingNewThread(false);
        setSession(askThreadToSession(thread));
        queryClient.setQueryData(["ask", "thread", thread.id], thread);
        void queryClient.invalidateQueries({ queryKey: ["ask", "threads", projectId] });
      } else {
        setSession((current) => appendAskExchange(current, variables.nextQuestion, answer));
      }
      setQuestion("");
      setFailure(undefined);
    },
    onError: (error) => {
      askControllerRef.current = undefined;
      if (isAskRevisionConflictError(error)) {
        setFailure({
          revisionChanged: true,
          message: "项目代码版本变了。旧对话仍保留，但不能继续混用；请从当前版本开始一个新对话。",
        });
        return;
      }
      if (isAskNewThreadRequiredError(error)) {
        setFailure({
          revisionChanged: false,
          newThreadRequired: true,
          message: error instanceof Error ? error.message : "这条云端对话不能继续，请新建对话。",
        });
        return;
      }
      if (error instanceof Error && error.name === "AbortError") {
        setFailure({
          revisionChanged: false,
          message: "已取消这次回答。问题仍保留，可以稍后重试。",
        });
        return;
      }
      setFailure({
        revisionChanged: false,
        message: error instanceof Error ? error.message : "暂时没有拿到回答，请重试。",
      });
    },
  });

  const submitQuestion = (event?: FormEvent) => {
    event?.preventDefault();
    if (askMutation.isPending) return;
    const nextQuestion = question.trim();
    setFailure(undefined);
    if (!nextQuestion) {
      setFailure({ revisionChanged: false, message: "先写下你想了解的问题。" });
      composerRef.current?.focus();
      return;
    }
    if (remoteProject && !projectQuery.data?.project.availableActions.ask) {
      setFailure({
        revisionChanged: false,
        message: "仓库快照和项目知识还没有准备好，请回到项目页查看导入进度。",
      });
      return;
    }
    if (!threadIdentityReady) {
      setFailure({
        revisionChanged: false,
        message: "选中的云端对话仍在读取，确认回答模型和代码版本后再发送。",
      });
      return;
    }
    if (!selectedProviderId || !providerReady) {
      setFailure({
        revisionChanged: false,
        message: "模型服务还没有通过连接检查，确认连接后再发送。",
      });
      return;
    }
    askMutation.mutate({
      providerId: selectedProviderId,
      nextQuestion,
      expectedRevision: session.revision,
    });
  };

  const chooseQuestion = (value: string) => {
    setQuestion(value);
    setFailure(undefined);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const clearConversation = (confirmFirst = true) => {
    if (remoteProject) {
      setActiveThreadId(undefined);
      setStartingNewThread(true);
      setSession(emptyAskSession(selectedProviderId));
      setFailure(undefined);
      setDraftAnswer(undefined);
      setDraftSourceRevision(undefined);
      return;
    }
    if (confirmFirst && session.messages.length > 0 && !window.confirm(
      "要清空这个项目保存在当前浏览器里的 Ask 对话吗？此操作无法撤销。",
    )) return;
    clearAskSession(projectId);
    setSession(emptyAskSession(selectedProviderId));
    setFailure(undefined);
    setDraftAnswer(undefined);
    setDraftSourceRevision(undefined);
  };

  const switchToCurrentRevision = () => {
    if (remoteProject) {
      clearConversation(false);
      return;
    }
    if (session.messages.length > 0 && !window.confirm(
      "开始新版本对话会清空当前浏览器保存的旧对话。是否继续？",
    )) return;
    clearConversation(false);
  };

  if (projectQuery.isLoading || providersQuery.isLoading) return <PageSkeleton />;
  if (projectQuery.isError) {
    return <ErrorState error={projectQuery.error} retry={() => void projectQuery.refetch()} />;
  }
  if (providersQuery.isError) {
    return <ErrorState error={providersQuery.error} retry={() => void providersQuery.refetch()} />;
  }
  if (remoteProject && threadsQuery.isError) {
    return <ErrorState error={threadsQuery.error} retry={() => void threadsQuery.refetch()} />;
  }
  if (remoteProject && threadQuery.isError) {
    return <ErrorState error={threadQuery.error} retry={() => void threadQuery.refetch()} />;
  }
  if (!projectQuery.data) return <PageSkeleton />;

  const { project } = projectQuery.data;
  const lastAnswer = [...session.messages]
    .reverse()
    .find((message) => message.role === "assistant")?.answer;

  return (
    <div className="space-y-6 animate-fade-up">
      <section>
        <Button variant="ghost" size="sm" className="-ml-2 mb-4" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          返回项目
        </Button>
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="success">
                <ShieldCheck className="h-3 w-3" aria-hidden />
                只读问答
              </Badge>
              {lastAnswer?.dirty ? <Badge variant="warning">包含未提交修改</Badge> : null}
            </div>
            <h1 tabIndex={-1} className="mt-3 text-3xl font-bold tracking-[-0.03em] text-slate-950 focus:outline-none">
              问 {project.name}
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              问代码在哪里、怎么运行、改动可能影响什么。回答会附源码依据，不会修改项目。
            </p>
          </div>
          <Button
            variant="outline"
            disabled={askMutation.isPending || session.messages.length === 0}
            onClick={() => clearConversation()}
          >
            {remoteProject ? <RefreshCw className="h-4 w-4" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
            {remoteProject ? "新建对话" : "清空对话"}
          </Button>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Ask 当前上下文">
        <ContextCard
          icon={<FolderGit2 />}
          label="当前项目"
          value={project.name}
          detail={project.repository
            ? `${project.repository.host} · ${project.repository.requestedRef || "默认分支"}`
            : "兼容本地项目"}
        />
        <ContextCard
          icon={<GitCommitHorizontal />}
          label="源码版本"
          value={session.revision ?? project.repository?.activeSnapshot?.revision ?? "快照准备中"}
          detail={session.revision ? "这条云端对话不会静默切换版本" : "新对话会锁定当前 revision"}
          mono={Boolean(session.revision)}
        />
        <ContextCard
          icon={providerReady ? <Wifi /> : <WifiOff />}
          label="模型服务"
          value={selectedProvider?.label ?? "尚未配置"}
          detail={selectedProvider?.model ?? "请先在 API 服务中配置 Provider"}
        />
        <ContextCard
          icon={<ShieldCheck />}
          label="数据边界"
          value={boundaryLabel(selectedProvider?.dataBoundary)}
          detail={selectedProvider ? DATA_BOUNDARY_COPY[selectedProvider.dataBoundary] : "没有已配置的模型服务"}
        />
      </section>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[290px_minmax(0,1fr)]">
        <aside className="space-y-4">
          {remoteProject ? (
            <Card>
              <CardContent className="p-5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-slate-950">云端对话</h2>
                  <Badge variant="muted">{threadsQuery.data?.length ?? 0} 条</Badge>
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  对话和引用保存在服务端，并固定在创建时的仓库 revision。
                </p>
                {(threadsQuery.data?.length ?? 0) > 0 ? (
                  <select
                    aria-label="选择云端 Ask 对话"
                    className="mt-3 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-700 outline-none focus:border-teal-500"
                    value={activeThreadId ?? ""}
                    disabled={askMutation.isPending}
                    onChange={(event) => {
                      const nextId = event.target.value || undefined;
                      const nextThread = (threadsQuery.data ?? []).find(({ id }) => id === nextId);
                      setActiveThreadId(nextId);
                      setStartingNewThread(!nextId);
                      setSession(nextThread
                        ? pendingAskThreadSession(nextThread)
                        : emptyAskSession(selectedProviderId));
                      setDraftAnswer(undefined);
                      setDraftSourceRevision(undefined);
                      setFailure(undefined);
                    }}
                  >
                    <option value="">开始新对话</option>
                    {(threadsQuery.data ?? []).map((thread) => (
                      <option key={thread.id} value={thread.id}>
                        {thread.title} · {thread.messageCount} 条
                      </option>
                    ))}
                  </select>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-teal-600" aria-hidden />
                <h2 className="text-sm font-semibold text-slate-950">回答模型</h2>
              </div>
              {configuredProviders.length > 0 ? (
                <>
                  <label htmlFor="ask-provider" className="mt-4 block text-xs font-medium text-slate-600">
                    已配置的 Provider
                  </label>
                  <div className="relative mt-1.5">
                    <select
                      id="ask-provider"
                      value={selectedProviderId ?? ""}
                      disabled={askMutation.isPending}
                      onChange={(event) => {
                        const providerId = event.target.value as AskProviderId;
                        if (remoteProject) {
                          setActiveThreadId(undefined);
                          setStartingNewThread(true);
                          setSession(emptyAskSession(providerId));
                        } else {
                          setSession((current) => ({ ...current, providerId }));
                        }
                        setFailure(undefined);
                      }}
                      className="h-11 w-full appearance-none rounded-xl border border-slate-200 bg-white px-3.5 pr-9 text-sm font-semibold text-slate-900 shadow-sm outline-none transition focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 disabled:bg-slate-50"
                    >
                      {(providersQuery.data ?? []).map((provider) => (
                        <option key={provider.id} value={provider.id} disabled={!provider.configured}>
                          {provider.label} · {provider.configured ? provider.model ?? "未指定模型" : "未配置"}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-3.5 h-4 w-4 text-slate-400" aria-hidden />
                  </div>
                  <ProviderCheckStatus
                    provider={selectedProvider}
                    state={selectedProvider?.configured ? providerCheckQuery.data?.state : "not_configured"}
                    message={selectedProvider?.configured
                      ? providerCheckQuery.data?.message
                      : selectedProvider?.message}
                    reportedModel={selectedProvider?.configured
                      ? providerCheckQuery.data?.model
                      : null}
                    loading={providerCheckQuery.isFetching}
                    error={providerCheckQuery.isError}
                    onRetry={() => void providerCheckQuery.refetch()}
                  />
                </>
              ) : (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                  还没有配置可用的模型服务。可以在 API 环境中配置 OpenAI、LM Studio、Ollama 或自定义服务，然后重新加载。
                </div>
              )}
              <ProviderInventory providers={providersQuery.data ?? []} />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-950">
                  {remoteProject ? "当前云端会话" : "当前浏览器会话"}
                </h2>
                <Badge variant="muted">{Math.floor(session.messages.length / 2)} 轮</Badge>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                {remoteProject
                  ? "历史由服务端保存和组装，浏览器不会重新提交或改写旧消息。"
                  : "只在当前浏览器中按项目保存。发给模型时最多带最近 12 条消息。"}
              </p>
              {lastAnswer ? (
                <div className="mt-3 border-t border-slate-100 pt-3 text-[11px] leading-5 text-slate-500">
                  最近回答：{formatDate(lastAnswer.answeredAt)}
                  <br />
                  {lastAnswer.provider.label} · {lastAnswer.provider.model}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </aside>

        <Card className="min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                <MessageSquare className="h-4 w-4 text-teal-600" aria-hidden />
                项目问答
              </h2>
              <p className="mt-1 text-xs text-slate-500">源码是依据；找不到证据时，回答应该直接说明不知道。</p>
            </div>
            <Badge variant={providerReady ? "success" : "warning"}>
              {providerReady ? "连接已确认" : "等待连接检查"}
            </Badge>
          </div>

          <div
            role="log"
            aria-label="项目问答记录"
            aria-live="polite"
            aria-relevant="additions text"
            aria-busy={askMutation.isPending || undefined}
            className="scrollbar-thin max-h-[58vh] min-h-[360px] overflow-y-auto bg-slate-50/50 px-4 py-5 sm:px-6"
          >
            {session.messages.length === 0 ? (
              <AskEmptyState onChoose={chooseQuestion} />
            ) : (
              <div className="space-y-5">
                {session.messages.map((message) => (
                  <AskMessage
                    key={message.id}
                    message={message}
                    onChooseQuestion={chooseQuestion}
                    onCreateWorkItem={(answer) => {
                      setDraftAnswer(answer);
                      setDraftSourceRevision(remoteProject ? session.sourceRevision : undefined);
                    }}
                  />
                ))}
              </div>
            )}

            {askMutation.isPending ? (
              <div
                role="status"
                aria-live="polite"
                className="mt-5 flex items-start gap-3 rounded-2xl border border-sky-100 bg-white p-4 text-sm text-sky-800 shadow-sm"
              >
                <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden />
                <div>
                  <p className="font-semibold">正在查源码并整理回答…</p>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-sky-700">{question.trim()}</p>
                </div>
              </div>
            ) : null}
            <div ref={conversationEndRef} />
          </div>

          <form onSubmit={submitQuestion} className="border-t border-slate-100 bg-white p-4 sm:p-5">
            {failure ? (
              <div
                role="alert"
                className={cn(
                  "mb-3 flex flex-col gap-3 rounded-xl border px-3.5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between",
                  failure.revisionChanged
                    ? "border-amber-200 bg-amber-50 text-amber-900"
                    : "border-rose-200 bg-rose-50 text-rose-800",
                )}
              >
                <span className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {failure.message}
                </span>
                {failure.revisionChanged ? (
                  <Button type="button" size="sm" variant="outline" onClick={switchToCurrentRevision}>
                    开始新版本对话
                  </Button>
                ) : failure.newThreadRequired ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => clearConversation(false)}>
                    新建对话
                  </Button>
                ) : question.trim() ? (
                  <Button type="submit" size="sm" variant="outline" disabled={!providerReady || !threadIdentityReady}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                    重试
                  </Button>
                ) : null}
              </div>
            ) : null}
            <label htmlFor="ask-question" className="sr-only">向项目提问</label>
            <Textarea
              ref={composerRef}
              id="ask-question"
              value={question}
              maxLength={8_000}
              disabled={askMutation.isPending || !selectedProviderId || !threadIdentityReady || (remoteProject && !project.availableActions.ask)}
              placeholder={selectedProviderId ? "例如：登录请求失败时会经过哪些模块？" : "先配置一个模型服务后再提问"}
              className="min-h-28 resize-y"
              onChange={(event) => {
                setQuestion(event.target.value);
                setFailure(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-[11px] leading-5 text-slate-400">
                Ctrl / ⌘ + Enter 发送 · Ask 只有只读能力
              </span>
              {askMutation.isPending ? (
                <Button type="button" variant="outline" onClick={() => askControllerRef.current?.abort()}>
                  <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
                  取消回答
                </Button>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!providerReady || !threadIdentityReady || !question.trim() || (remoteProject && !project.availableActions.ask)}
                >
                  <Send className="h-4 w-4" aria-hidden />
                  发送问题
                </Button>
              )}
            </div>
          </form>
        </Card>
      </div>

      {draftAnswer?.workItemDraft ? (
        <WorkItemDraftDialog
          key={`${draftAnswer.answeredAt}-${draftAnswer.revision}`}
          projectId={projectId}
          answer={draftAnswer}
          sourceRevision={draftSourceRevision}
          initialDraft={draftAnswer.workItemDraft}
          onClose={() => setDraftAnswer(undefined)}
          onCreated={onOpenRun}
        />
      ) : null}
    </div>
  );
}

function askThreadToSession(thread: AskThread): AskSessionState {
  return {
    version: emptyAskSession(thread.providerId).version,
    providerId: thread.providerId,
    revision: thread.revision,
    sourceRevision: thread.sourceRevision,
    messages: thread.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      ...(message.answer ? { answer: message.answer } : {}),
    })),
  };
}

function ContextCard({
  icon,
  label,
  value,
  detail,
  mono = false,
}: {
  icon: ReactElement;
  label: string;
  value: string;
  detail: string;
  mono?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex min-w-0 items-start gap-3 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700 [&>svg]:h-4 [&>svg]:w-4">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{label}</p>
          <p className={cn("mt-1 truncate text-sm font-semibold text-slate-900", mono && "font-mono text-xs")} title={value}>
            {value}
          </p>
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-slate-500" title={detail}>{detail}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function ProviderCheckStatus({
  provider,
  state,
  message,
  reportedModel,
  loading,
  error,
  onRetry,
}: {
  provider?: AskProviderStatus;
  state?: AskProviderAvailability;
  message?: string;
  reportedModel?: string | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const ready = state === "ready";
  return (
    <div
      className={cn(
        "mt-3 rounded-xl border p-3 text-xs leading-5",
        ready
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : error || Boolean(state)
            ? "border-amber-200 bg-amber-50 text-amber-900"
            : "border-slate-200 bg-slate-50 text-slate-600",
      )}
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        {loading ? (
          <LoaderCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
        ) : ready ? (
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <div className="min-w-0">
          <p className="font-semibold">
            {loading ? "正在检查连接…" : ready ? "连接可用" : "连接还不能使用"}
          </p>
          <p className="mt-0.5 break-words">
            {loading
              ? `正在联系 ${provider?.endpointLabel ?? "模型服务"}`
              : error
                ? "没有完成连接检查。"
                : message ?? provider?.message ?? "等待检查。"}
          </p>
          {!loading && ready && reportedModel ? (
            <p className="mt-1 break-all" title={reportedModel}>
              上游报告模型：{reportedModel}
            </p>
          ) : null}
          {!loading && !ready ? (
            <button
              type="button"
              className="mt-1.5 inline-flex items-center gap-1 font-semibold underline decoration-current/40 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
              onClick={onRetry}
            >
              <RefreshCw className="h-3 w-3" aria-hidden />
              重新检查
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ProviderInventory({ providers }: { providers: AskProviderStatus[] }) {
  return (
    <section className="mt-4 border-t border-slate-100 pt-4" aria-labelledby="ask-provider-inventory-title">
      <h3 id="ask-provider-inventory-title" className="text-xs font-semibold text-slate-700">
        支持的 Provider
      </h3>
      <ul className="mt-2 space-y-2">
        {PROVIDER_ORDER.map((providerId) => {
          const provider = providers.find((item) => item.id === providerId);
          const configured = provider?.configured === true;
          return (
            <li key={providerId} className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-800">
                  {PROVIDER_DISPLAY_NAME[providerId]}
                </span>
                <Badge variant={configured ? "success" : "muted"}>
                  {configured ? "已配置" : "未配置"}
                </Badge>
              </div>
              <p className="mt-1 break-words text-[11px] leading-4 text-slate-500">
                {configured
                  ? `${provider?.model ?? "未指定模型"} · ${boundaryLabel(provider?.dataBoundary)}`
                  : PROVIDER_SERVER_HINT[providerId]}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AskEmptyState({ onChoose }: { onChoose: (question: string) => void }) {
  return (
    <div className="mx-auto flex min-h-[320px] max-w-2xl flex-col items-center justify-center text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-950 text-teal-200 shadow-sm">
        <Sparkles className="h-5 w-5" aria-hidden />
      </span>
      <h2 className="mt-4 text-lg font-semibold text-slate-950">从一个具体问题开始</h2>
      <p className="mt-2 max-w-lg text-sm leading-6 text-slate-500">
        Ask 会先找项目证据，再用白话回答。它不会写文件、执行命令或启动交付流程。
      </p>
      <div className="mt-5 grid w-full gap-2 sm:grid-cols-3">
        {SUGGESTED_QUESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onChoose(suggestion)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-left text-xs font-medium leading-5 text-slate-700 shadow-sm transition hover:border-teal-300 hover:text-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function AskMessage({
  message,
  onChooseQuestion,
  onCreateWorkItem,
}: {
  message: AskSessionMessage;
  onChooseQuestion: (question: string) => void;
  onCreateWorkItem: (answer: AskAnswer) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-slate-950 px-4 py-3 text-sm leading-6 text-white shadow-sm sm:max-w-[78%]">
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    );
  }

  const answer = message.answer;
  if (!answer) return null;
  return (
    <div className="flex items-start gap-3">
      <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-teal-100 text-teal-700">
        <Bot className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        {answer.dirty ? (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
            这份回答基于包含未提交修改的工作树；引用仍绑定下方显示的 revision。
          </div>
        ) : null}
        <MarkdownPreview content={answer.answer} className="text-sm" mode="untrusted" />

        {answer.uncertainties.length > 0 ? (
          <section className="mt-5 rounded-xl border border-amber-100 bg-amber-50/70 p-3">
            <h3 className="text-xs font-semibold text-amber-900">还不能完全确定</h3>
            <ul className="mt-1.5 space-y-1 text-xs leading-5 text-amber-800">
              {answer.uncertainties.map((uncertainty, index) => (
                <li key={`${uncertainty}-${index}`}>• {uncertainty}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <CitationList
          citations={answer.citations}
          invalidCitationCount={answer.invalidCitationIds.length}
        />

        {answer.suggestedQuestions.length > 0 ? (
          <section className="mt-5 border-t border-slate-100 pt-4">
            <h3 className="text-xs font-semibold text-slate-700">可以继续问</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {answer.suggestedQuestions.map((suggestion, index) => (
                <button
                  key={`${suggestion}-${index}`}
                  type="button"
                  onClick={() => onChooseQuestion(suggestion)}
                  className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-left text-xs text-slate-600 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <footer className="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-4 text-[11px] text-slate-400 sm:flex-row sm:items-center sm:justify-between">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{answer.provider.label} · {answer.provider.model}</span>
            <span className="break-all font-mono">{answer.revision}</span>
            <span className="inline-flex items-center gap-1">
              <Clock3 className="h-3 w-3" aria-hidden />
              {(answer.durationMs / 1_000).toFixed(1)} 秒
            </span>
          </span>
          {answer.workItemDraft ? (
            <Button type="button" size="sm" variant="outline" onClick={() => onCreateWorkItem(answer)}>
              <WandSparkles className="h-3.5 w-3.5" aria-hidden />
              整理成工作项
            </Button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

function CitationList({
  citations,
  invalidCitationCount,
}: {
  citations: AskCitation[];
  invalidCitationCount: number;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  if (citations.length === 0 && invalidCitationCount === 0) return null;
  return (
    <section className="mt-5">
      <h3 className="flex items-center gap-2 text-xs font-semibold text-slate-700">
        <FileCode2 className="h-3.5 w-3.5 text-teal-600" aria-hidden />
        源码依据
      </h3>
      {citations.length > 0 ? (
        <div className="mt-2 space-y-2">
          {citations.map((citation) => {
            const open = expanded.has(citation.sourceId);
            return (
              <div key={`${citation.sourceId}-${citation.sha256}`} className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50/70">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setExpanded((current) => {
                    const next = new Set(current);
                    if (open) next.delete(citation.sourceId);
                    else next.add(citation.sourceId);
                    return next;
                  })}
                  className="flex w-full min-w-0 items-start justify-between gap-3 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[11px] font-semibold text-teal-800">
                      [{citation.sourceId}] {citation.path}:{citation.startLine}-{citation.endLine}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">{citation.summary}</span>
                  </span>
                  <ChevronDown className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400 transition", open && "rotate-180")} aria-hidden />
                </button>
                {open ? (
                  <div className="border-t border-slate-200 bg-slate-950 p-3">
                    <p className="mb-2 break-all font-mono text-[10px] text-slate-400">
                      revision {citation.revision} · sha256 {citation.sha256}
                    </p>
                    <pre className="scrollbar-thin max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-slate-200">
                      {citation.excerpt || "这条依据没有附带源码片段。"}
                    </pre>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 text-xs leading-5 text-slate-500">这次回答没有可展示的源码引用。</p>
      )}
      {invalidCitationCount > 0 ? (
        <p className="mt-2 text-xs leading-5 text-amber-700">
          有 {invalidCitationCount} 条模型引用没有通过服务端校验，已从源码依据中排除。
        </p>
      ) : null}
    </section>
  );
}

function WorkItemDraftDialog({
  projectId,
  answer,
  sourceRevision,
  initialDraft,
  onClose,
  onCreated,
}: {
  projectId: string;
  answer: AskAnswer;
  sourceRevision?: string;
  initialDraft: AskWorkItemDraft;
  onClose: () => void;
  onCreated: (runId: string) => void;
}) {
  const [draft, setDraft] = useState<AskConfirmedWorkItemDraft>(() => ({
    ...initialDraft,
    workType: "feature",
    acceptanceCriteria: [...initialDraft.acceptanceCriteria],
    currentBehavior: "",
    inScope: [],
    outOfScope: [],
    regressionScope: [],
    riskFlags: [],
  }));
  const [criteriaText, setCriteriaText] = useState(() => initialDraft.acceptanceCriteria.join("\n"));
  const [inScopeText, setInScopeText] = useState("");
  const [outOfScopeText, setOutOfScopeText] = useState("");
  const [regressionScopeText, setRegressionScopeText] = useState("");
  const [riskFlagsText, setRiskFlagsText] = useState("");
  const [error, setError] = useState<string>();
  const mutation = useMutation({
    mutationFn: (confirmedDraft: AskConfirmedWorkItemDraft) =>
      api.createRun(
        projectId,
        askAnswerToCreateRunInput(confirmedDraft, answer, sourceRevision),
      ),
    onSuccess: (run: WorkflowRun) => onCreated(run.id),
    onError: (mutationError) => setError(
      mutationError instanceof Error ? mutationError.message : "创建交付任务失败，请重试。",
    ),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mutation.isPending) return;
    const nextDraft = {
      ...draft,
      title: draft.title.trim(),
      objective: draft.objective.trim(),
      acceptanceCriteria: criteriaText
        .split(/\r?\n/u).map(cleanWorkItemLine).filter(Boolean),
      inScope: inScopeText.split(/\r?\n/u).map(cleanWorkItemLine).filter(Boolean),
      outOfScope: outOfScopeText.split(/\r?\n/u).map(cleanWorkItemLine).filter(Boolean),
      regressionScope: regressionScopeText.split(/\r?\n/u).map(cleanWorkItemLine).filter(Boolean),
      riskFlags: riskFlagsText.split(/\r?\n/u).map(cleanWorkItemLine).filter(Boolean),
    };
    const missing = confirmedWorkItemDraftMissingFields(nextDraft);
    if (missing.length > 0) {
      setError(`请补充：${missing.join("、")}。`);
      return;
    }
    setDraft(nextDraft);
    setError(undefined);
    mutation.mutate(nextDraft);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
      title="补全并确认任务合同"
      description="Ask 只帮你起草名称、目标和验收标准。请用白话补全当前情况、范围与回归范围；确认后只创建交付任务，不会自动执行任何阶段。"
      closeDisabled={mutation.isPending}
      className="h-[calc(100dvh-2rem)] max-h-[50rem] max-w-3xl"
    >
      <form onSubmit={submit} className="min-h-0 overflow-y-auto p-6">
        <div className="space-y-5">
          <Field label="任务名称" required>
            <Input
              autoFocus
              value={draft.title}
              maxLength={200}
              onChange={(event) => {
                setDraft((current) => ({ ...current, title: event.target.value }));
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
                    name="ask-work-type"
                    value={option.value}
                    checked={draft.workType === option.value}
                    onChange={() => {
                      setDraft((current) => ({ ...current, workType: option.value }));
                      setError(undefined);
                    }}
                    className="peer sr-only"
                  />
                  <span className={cn(
                    "block h-full rounded-xl border bg-white px-3.5 py-3 transition peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2",
                    draft.workType === option.value
                      ? "border-teal-400 bg-teal-50/60 ring-1 ring-teal-100"
                      : "border-slate-200 hover:border-slate-300",
                  )}>
                    <span className="block text-xs font-semibold text-slate-900">{option.label}</span>
                    <span className="mt-1 block text-[11px] leading-4 text-slate-500">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="期望结果" hint="用可观察、可验证的话描述" required>
            <Textarea
              value={draft.objective}
              maxLength={5_000}
              className="min-h-32"
              onChange={(event) => {
                setDraft((current) => ({ ...current, objective: event.target.value }));
                setError(undefined);
              }}
            />
          </Field>
          <Field label="现在是什么情况" hint="不要写“稍后补全”；请写清楚当前可观察行为" required>
            <Textarea
              value={draft.currentBehavior}
              maxLength={5_000}
              className="min-h-28"
              placeholder="谁遇到了什么问题？现在会发生什么？"
              onChange={(event) => {
                setDraft((current) => ({ ...current, currentBehavior: event.target.value }));
                setError(undefined);
              }}
            />
          </Field>
          <Field label="这次具体要做什么" hint="每行一项" required>
            <Textarea
              value={inScopeText}
              maxLength={8_000}
              className="min-h-28"
              placeholder={"支持订单重试\n失败时给出清楚提示"}
              onChange={(event) => {
                setInScopeText(event.target.value);
                setError(undefined);
              }}
            />
          </Field>
          <Field label="验收标准" hint="每行一条" required>
            <Textarea
              value={criteriaText}
              maxLength={20_000}
              className="min-h-36"
              onChange={(event) => {
                setCriteriaText(event.target.value);
                setError(undefined);
              }}
            />
          </Field>
          <Field label="至少要回头检查哪些地方" hint="每行一项" required>
            <Textarea
              value={regressionScopeText}
              maxLength={8_000}
              className="min-h-28"
              placeholder={"原有正常流程\n失败与重试流程\n相关查询页面"}
              onChange={(event) => {
                setRegressionScopeText(event.target.value);
                setError(undefined);
              }}
            />
          </Field>
          <details className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <summary className="cursor-pointer text-sm font-semibold text-slate-700">
              可选：明确不做什么和需要小心的风险
            </summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="这次明确不做" hint="每行一项">
                <Textarea
                  value={outOfScopeText}
                  className="min-h-24"
                  onChange={(event) => setOutOfScopeText(event.target.value)}
                />
              </Field>
              <Field label="风险" hint="每行一项">
                <Textarea
                  value={riskFlagsText}
                  className="min-h-24"
                  onChange={(event) => setRiskFlagsText(event.target.value)}
                />
              </Field>
            </div>
          </details>
          <div className="rounded-xl border border-teal-100 bg-teal-50/70 p-4 text-xs leading-5 text-teal-900">
            <p className="font-semibold">会一起保存的依据</p>
            <p className="mt-1">
              源码版本 {sourceRevision ?? answer.revision}，共 {answer.citations.length} 条已校验引用。
              它们会写入 Change Contract，方便需求确认阶段复核。
            </p>
          </div>
          {error ? (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-800">
              {error}
            </div>
          ) : null}
        </div>
        <div className="mt-7 flex flex-col-reverse gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={onClose}>
            继续留在 Ask
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            <WandSparkles className="h-4 w-4" aria-hidden />
            确认并创建交付任务
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function cleanWorkItemLine(value: string): string {
  return value.trim().replace(/^[-*]\s+/u, "");
}

function boundaryLabel(boundary?: AskProviderStatus["dataBoundary"]): string {
  if (boundary === "local") return "部署内服务";
  if (boundary === "remote") return "远程服务";
  if (boundary === "operator-configured") return "由配置决定";
  return "尚未确认";
}
