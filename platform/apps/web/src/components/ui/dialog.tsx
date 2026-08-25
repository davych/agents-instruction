import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  closeDisabled?: boolean;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  closeDisabled = false,
}: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-[2px] data-[state=open]:animate-fade-up" />
        <DialogPrimitive.Content
          aria-busy={closeDisabled || undefined}
          onEscapeKeyDown={(event) => {
            if (closeDisabled) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (closeDisabled) event.preventDefault();
          }}
          className={cn(
            "fixed bottom-0 left-1/2 z-50 flex max-h-[94vh] w-full max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-t-3xl border border-white/60 bg-white shadow-panel focus:outline-none sm:bottom-auto sm:top-1/2 sm:w-[calc(100%-3rem)] sm:-translate-y-1/2 sm:rounded-2xl",
            className,
          )}
        >
          <header className="flex shrink-0 items-start justify-between gap-6 border-b border-slate-100 px-6 py-5">
            <div>
              <DialogPrimitive.Title className="text-lg font-semibold tracking-tight text-slate-950">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                disabled={closeDisabled}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                aria-label="关闭"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </DialogPrimitive.Close>
          </header>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
