import type { ReactNode } from "react";
import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="flex items-center justify-between gap-2 text-sm font-medium text-slate-700">
        <span>
          {label}
          {required ? <span className="ml-1 text-rose-500">*</span> : null}
        </span>
        {hint ? <span className="text-xs font-normal text-slate-400">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : "发生了未知错误";
  return (
    <Card className="border-rose-200 bg-rose-50/60 p-8 text-center">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-white text-rose-600 shadow-sm">
        <AlertTriangle className="h-5 w-5" aria-hidden />
      </span>
      <h2 className="mt-4 font-semibold text-slate-900">暂时无法加载</h2>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-600">{message}</p>
      {retry ? (
        <Button variant="outline" className="mt-5" onClick={retry}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          重新加载
        </Button>
      ) : null}
    </Card>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-12 text-center">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-400 shadow-sm">
        <Inbox className="h-5 w-5" aria-hidden />
      </span>
      <h3 className="mt-4 text-sm font-semibold text-slate-900">{title}</h3>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-6 text-slate-500">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-10 w-80 max-w-full" />
        <Skeleton className="h-5 w-[32rem] max-w-full" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <Skeleton key={item} className="h-52 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
