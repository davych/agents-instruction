import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type BadgeVariant =
  | "default"
  | "muted"
  | "outline"
  | "success"
  | "warning"
  | "danger"
  | "info";

const variants: Record<BadgeVariant, string> = {
  default: "border-transparent bg-slate-900 text-white",
  muted: "border-transparent bg-slate-100 text-slate-600",
  outline: "border-slate-200 bg-white text-slate-600",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  danger: "border-rose-200 bg-rose-50 text-rose-700",
  info: "border-sky-200 bg-sky-50 text-sky-700",
};

export function Badge({
  className,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold leading-none",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
