import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FileText,
  ListChecks,
  LoaderCircle,
  PlayCircle,
} from "lucide-react";

import { MarkdownPreview } from "@/components/markdown-preview";
import { EmptyState, ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { TicketDetail, TicketStatus, TicketSummary } from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";

const ticketQueryKey = (runId: string) => ["tickets", runId] as const;
const ticketDetailQueryKey = (runId: string, ticketId: string) =>
  ["ticket", runId, ticketId] as const;

const statusColumns: ReadonlyArray<{
  status: TicketStatus;
  label: string;
  description: string;
  icon: typeof Archive;
  dot: string;
  header: string;
}> = [
  {
    status: "backlog",
    label: "待整理",
    description: "尚未进入交付队列",
    icon: Archive,
    dot: "bg-slate-400",
    header: "border-slate-200 bg-slate-50/70",
  },
  {
    status: "todo",
    label: "待开始",
    description: "已经明确，可以开始",
    icon: CircleDashed,
    dot: "bg-sky-500",
    header: "border-sky-200 bg-sky-50/70",
  },
  {
    status: "in_progress",
    label: "进行中",
    description: "当前正在实现",
    icon: PlayCircle,
    dot: "bg-amber-500",
    header: "border-amber-200 bg-amber-50/70",
  },
  {
    status: "done",
    label: "已完成",
    description: "故事价值已经交付",
    icon: CheckCircle2,
    dot: "bg-emerald-500",
    header: "border-emerald-200 bg-emerald-50/70",
  },
];

export function TicketBoard({
  runId,
  ticketId,
  onOpenTicket,
  onCloseTicket,
}: {
  runId: string;
  ticketId?: string;
  onOpenTicket: (id: string) => void;
  onCloseTicket: () => void;
}) {
  const queryClient = useQueryClient();
  const [statusError, setStatusError] = useState<string>();
  const ticketsQuery = useQuery({
    queryKey: ticketQueryKey(runId),
    queryFn: () => api.listTickets(runId),
  });
  const ticketQuery = useQuery({
    queryKey: ticketDetailQueryKey(runId, ticketId ?? ""),
    queryFn: () => api.getTicket(runId, ticketId ?? ""),
    enabled: Boolean(ticketId),
  });
  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TicketStatus }) =>
      api.updateTicketStatus(runId, id, status),
    onMutate: async ({ id, status }) => {
      setStatusError(undefined);
      await queryClient.cancelQueries({ queryKey: ticketQueryKey(runId) });
      await queryClient.cancelQueries({ queryKey: ticketDetailQueryKey(runId, id) });

      const previousTickets = queryClient.getQueryData<TicketSummary[]>(ticketQueryKey(runId));
      const previousTicket = queryClient.getQueryData<TicketDetail>(
        ticketDetailQueryKey(runId, id),
      );

      queryClient.setQueryData<TicketSummary[]>(ticketQueryKey(runId), (current) =>
        current?.map((ticket) =>
          ticket.id === id ? { ...ticket, status, updatedAt: new Date().toISOString() } : ticket,
        ),
      );
      queryClient.setQueryData<TicketDetail>(ticketDetailQueryKey(runId, id), (current) =>
        current ? { ...current, status, updatedAt: new Date().toISOString() } : current,
      );

      return { id, previousTicket, previousTickets };
    },
    onError: (mutationError, _variables, context) => {
      if (context?.previousTickets) {
        queryClient.setQueryData(ticketQueryKey(runId), context.previousTickets);
      }
      if (context?.previousTicket) {
        queryClient.setQueryData(
          ticketDetailQueryKey(runId, context.id),
          context.previousTicket,
        );
      }
      setStatusError(
        mutationError instanceof Error ? mutationError.message : "Ticket 状态更新失败，请重试。",
      );
    },
    onSettled: async (_data, _error, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ticketQueryKey(runId) }),
        queryClient.invalidateQueries({
          queryKey: ticketDetailQueryKey(runId, variables.id),
        }),
      ]);
    },
  });

  const updateStatus = (id: string, status: TicketStatus) => {
    const ticket = ticketsQuery.data?.find((item) => item.id === id);
    if (ticket?.status === status || statusMutation.isPending) return;
    statusMutation.mutate({ id, status });
  };

  if (ticketsQuery.isLoading) return <TicketBoardSkeleton />;
  if (ticketsQuery.isError) {
    return <ErrorState error={ticketsQuery.error} retry={() => void ticketsQuery.refetch()} />;
  }

  const tickets = ticketsQuery.data ?? [];

  return (
    <section className="space-y-4" aria-label="用户故事 Ticket 看板">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <div className="flex items-center gap-2">
            <ListChecks className="h-5 w-5 text-teal-600" aria-hidden />
            <h2 className="text-lg font-semibold tracking-tight text-slate-950">用户故事 Tickets</h2>
            <Badge variant="muted">{tickets.length}</Badge>
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-500">
            每张卡片对应 PM / BA 产出的一条用户故事，可独立推进和跟踪。
          </p>
        </div>
        <div className="text-xs text-slate-400">点击卡片查看完整故事与验收标准</div>
      </div>

      {statusError ? (
        <div
          className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-700"
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{statusError}</span>
        </div>
      ) : null}

      {tickets.length ? (
        <div className="scrollbar-thin overflow-x-auto pb-3">
          <div className="grid min-w-max auto-cols-[minmax(280px,85vw)] grid-flow-col items-start gap-3 sm:auto-cols-[320px] xl:min-w-0 xl:grid-flow-row xl:grid-cols-4">
            {statusColumns.map((column) => {
              const columnTickets = tickets.filter((ticket) => ticket.status === column.status);
              const Icon = column.icon;
              return (
                <section
                  key={column.status}
                  className="min-w-0 overflow-hidden rounded-2xl border border-slate-200/80 bg-slate-100/55"
                  aria-labelledby={`ticket-column-${column.status}`}
                >
                  <header className={cn("border-b px-3.5 py-3", column.header)}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <Icon className="h-4 w-4 shrink-0 text-slate-600" aria-hidden />
                        <h3
                          id={`ticket-column-${column.status}`}
                          className="truncate text-sm font-semibold text-slate-800"
                        >
                          {column.label}
                        </h3>
                      </div>
                      <Badge variant="outline" className="bg-white/80">
                        {columnTickets.length}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">{column.description}</p>
                  </header>
                  <div className="min-h-40 space-y-2.5 p-2.5">
                    {columnTickets.length ? (
                      columnTickets.map((ticket) => (
                        <TicketCard
                          key={ticket.id}
                          ticket={ticket}
                          pending={
                            statusMutation.isPending && statusMutation.variables?.id === ticket.id
                          }
                          mutationPending={statusMutation.isPending}
                          onOpen={() => onOpenTicket(ticket.id)}
                          onStatusChange={(status) => updateStatus(ticket.id, status)}
                        />
                      ))
                    ) : (
                      <div className="flex min-h-28 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white/50 px-4 text-center text-xs leading-5 text-slate-400">
                        暂无 Ticket
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <EmptyState
          title="还没有用户故事 Ticket"
          description="运行 PM / BA 并生成用户故事后，每个 story.md 会作为独立 Ticket 出现在这里。"
        />
      )}

      <TicketDetailDialog
        ticketId={ticketId}
        ticket={ticketQuery.data}
        loading={ticketQuery.isLoading}
        error={ticketQuery.error}
        statusError={statusError}
        mutationPending={statusMutation.isPending}
        onRetry={() => void ticketQuery.refetch()}
        onClose={onCloseTicket}
        onStatusChange={(status) => ticketId && updateStatus(ticketId, status)}
      />
    </section>
  );
}

function TicketCard({
  ticket,
  pending,
  mutationPending,
  onOpen,
  onStatusChange,
}: {
  ticket: TicketSummary;
  pending: boolean;
  mutationPending: boolean;
  onOpen: () => void;
  onStatusChange: (status: TicketStatus) => void;
}) {
  const status = statusColumns.find((item) => item.status === ticket.status) ?? statusColumns[0];
  return (
    <article className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-teal-200 hover:shadow-md">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full p-3.5 pb-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
        aria-label={`查看 ${ticket.identifier} ${ticket.title}`}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[11px] font-semibold text-slate-500">
            {ticket.identifier}
          </span>
          {ticket.sourceReviewStatus && ticket.sourceReviewStatus !== "approved" ? (
            <Badge variant="warning" className="px-2 py-0.5 text-[10px]">
              来源待审核
            </Badge>
          ) : null}
        </div>
        <h4 className="mt-2 line-clamp-3 text-sm font-semibold leading-5 text-slate-900">
          {ticket.title}
        </h4>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-slate-400">
          <span className="max-w-36 truncate rounded-md bg-slate-50 px-1.5 py-1 text-slate-500">
            {ticket.category || "未分类"}
          </span>
          <span className="flex items-center gap-1">
            <FileText className="h-3 w-3" aria-hidden />
            {ticket.acceptanceCriteriaCount} 条验收标准
          </span>
        </div>
      </button>
      <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-3 py-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">更新 {ticket.identifier} 状态</span>
          <span
            className={cn(
              "pointer-events-none absolute left-2.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full",
              status.dot,
            )}
          />
          <select
            value={ticket.status}
            disabled={mutationPending}
            onChange={(event) => onStatusChange(event.target.value as TicketStatus)}
            className="h-8 w-full appearance-none rounded-lg border border-transparent bg-slate-50 pl-6 pr-7 text-[11px] font-medium text-slate-600 outline-none transition hover:border-slate-200 hover:bg-white focus:border-teal-400 focus:ring-2 focus:ring-teal-100 disabled:cursor-wait disabled:opacity-60"
          >
            {statusColumns.map((item) => (
              <option key={item.status} value={item.status}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <span className="flex shrink-0 items-center gap-1 text-[10px] text-slate-400">
          {pending ? (
            <LoaderCircle className="h-3 w-3 animate-spin" aria-label="正在更新" />
          ) : (
            <Clock3 className="h-3 w-3" aria-hidden />
          )}
          {pending ? "更新中" : formatDate(ticket.updatedAt)}
        </span>
      </div>
    </article>
  );
}

function TicketDetailDialog({
  ticketId,
  ticket,
  loading,
  error,
  statusError,
  mutationPending,
  onRetry,
  onClose,
  onStatusChange,
}: {
  ticketId?: string;
  ticket?: TicketDetail;
  loading: boolean;
  error: unknown;
  statusError?: string;
  mutationPending: boolean;
  onRetry: () => void;
  onClose: () => void;
  onStatusChange: (status: TicketStatus) => void;
}) {
  return (
    <Dialog
      open={Boolean(ticketId)}
      onOpenChange={(open) => !open && onClose()}
      title={ticket ? `${ticket.identifier} · ${ticket.title}` : "Ticket 详情"}
      description={ticket ? `${ticket.category || "未分类"} · ${ticket.sourcePath}` : "查看独立用户故事"}
      className="max-w-6xl"
    >
      {loading ? (
        <div className="flex min-h-96 items-center justify-center gap-2 text-sm text-slate-400">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          正在读取 Ticket…
        </div>
      ) : error ? (
        <div className="overflow-y-auto p-6">
          <ErrorState error={error} retry={onRetry} />
        </div>
      ) : ticket ? (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="scrollbar-thin min-h-[360px] overflow-y-auto border-b border-slate-200 bg-white p-5 sm:p-7 lg:max-h-[72vh] lg:border-b-0 lg:border-r">
            <MarkdownPreview content={ticket.content} />
          </div>
          <aside className="scrollbar-thin overflow-y-auto bg-slate-50/70 p-5 lg:max-h-[72vh]">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  当前状态
                </span>
                <select
                  value={ticket.status}
                  disabled={mutationPending}
                  onChange={(event) => onStatusChange(event.target.value as TicketStatus)}
                  className="mt-2 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-teal-400 focus:ring-2 focus:ring-teal-100 disabled:cursor-wait disabled:opacity-60"
                >
                  {statusColumns.map((item) => (
                    <option key={item.status} value={item.status}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              {statusError ? (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs leading-5 text-rose-700" role="alert">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  {statusError}
                </div>
              ) : null}
            </div>

            <dl className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-xs">
              <TicketMeta label="标识" value={ticket.identifier} mono />
              <TicketMeta label="分类" value={ticket.category || "未分类"} />
              <TicketMeta label="验收标准" value={`${ticket.acceptanceCriteriaCount} 条`} />
              <TicketMeta
                label="来源状态"
                value={ticket.sourceReviewStatus === "approved" ? "已审核" : "待审核"}
              />
              <TicketMeta label="更新时间" value={formatDate(ticket.updatedAt)} />
              <TicketMeta label="来源文件" value={ticket.sourcePath} mono />
            </dl>
          </aside>
        </div>
      ) : (
        <div className="p-6">
          <EmptyState title="没有找到 Ticket" description="该 Ticket 可能已经被重新同步或归档。" />
        </div>
      )}
    </Dialog>
  );
}

function TicketMeta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className={cn("mt-1 break-words leading-5 text-slate-700", mono && "font-mono text-[11px]")}>
        {value}
      </dd>
    </div>
  );
}

function TicketBoardSkeleton() {
  return (
    <div className="space-y-4" aria-label="正在加载 Ticket 看板">
      <div className="h-7 w-48 animate-pulse rounded-lg bg-slate-200" />
      <div className="scrollbar-thin overflow-x-auto pb-3">
        <div className="grid min-w-max auto-cols-[minmax(280px,85vw)] grid-flow-col gap-3 sm:auto-cols-[320px] xl:min-w-0 xl:grid-flow-row xl:grid-cols-4">
          {statusColumns.map((column) => (
            <div key={column.status} className="h-80 animate-pulse rounded-2xl border border-slate-200 bg-slate-100" />
          ))}
        </div>
      </div>
    </div>
  );
}
