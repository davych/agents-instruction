import type { ReactNode } from "react";
import { Boxes, ChevronRight, Github, Radio, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Crumb {
  label: string;
  onClick?: () => void;
}

export function AppShell({
  children,
  crumbs = [],
  onHome,
}: {
  children: ReactNode;
  crumbs?: Crumb[];
  onHome: () => void;
}) {
  return (
    <div className="relative min-h-screen overflow-x-hidden bg-slate-50">
      <div className="page-grid pointer-events-none absolute inset-x-0 top-0 h-[560px] opacity-80" />
      <div className="pointer-events-none absolute left-[-8rem] top-[-10rem] h-80 w-80 rounded-full bg-teal-200/20 blur-3xl" />
      <div className="pointer-events-none absolute right-[-5rem] top-8 h-72 w-72 rounded-full bg-sky-200/20 blur-3xl" />

      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1480px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={onHome}
            className="group flex items-center gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-4"
          >
            <span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-slate-950 text-white shadow-sm transition group-hover:-rotate-3 group-hover:scale-105">
              <Boxes className="h-[18px] w-[18px]" aria-hidden />
              <Sparkles className="absolute -right-1 -top-1 h-3 w-3 text-teal-300" aria-hidden />
            </span>
            <span>
              <span className="block text-sm font-bold tracking-tight text-slate-950">AI SDLC</span>
              <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Control Room
              </span>
            </span>
          </button>

          {crumbs.length ? (
            <nav className="hidden min-w-0 flex-1 items-center gap-1 pl-4 text-sm md:flex" aria-label="面包屑">
              {crumbs.map((crumb, index) => (
                <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1">
                  {index > 0 ? <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" /> : null}
                  {crumb.onClick ? (
                    <button
                      type="button"
                      className="max-w-48 truncate rounded px-1.5 py-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                      onClick={crumb.onClick}
                    >
                      {crumb.label}
                    </button>
                  ) : (
                    <span
                      aria-current={index === crumbs.length - 1 ? "page" : undefined}
                      className="max-w-64 truncate px-1.5 font-medium text-slate-800"
                    >
                      {crumb.label}
                    </span>
                  )}
                </span>
              ))}
            </nav>
          ) : (
            <div className="flex-1" />
          )}

          <div className="flex items-center gap-2">
            <Badge variant="outline" className="hidden gap-2 py-1.5 sm:inline-flex">
              <Radio className="h-3 w-3 text-emerald-500" aria-hidden />
              Local runtime
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              className="hidden text-slate-400 sm:inline-flex"
              aria-label="项目仓库"
              title="项目仓库"
              onClick={() => window.open("https://github.com", "_blank", "noopener,noreferrer")}
            >
              <Github className="h-[18px] w-[18px]" aria-hidden />
            </Button>
          </div>
        </div>
      </header>

      <main className={cn("relative z-10 mx-auto w-full max-w-[1480px] px-4 py-8 sm:px-6 lg:px-8 lg:py-10")}>
        {children}
      </main>
    </div>
  );
}
