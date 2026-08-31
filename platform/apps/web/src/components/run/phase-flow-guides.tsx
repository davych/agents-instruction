import { Badge } from "@/components/ui/badge";
import { ENGINEERING_FLOW_STEPS } from "@/lib/engineering-workflow";
import { RELEASE_FLOW_STEPS } from "@/lib/release-workflow";
import { TESTER_FLOW_STEPS } from "@/lib/tester-workflow";
import { cn } from "@/lib/utils";

export function EngineeringFlowGuide({
  compact = false,
  executorLabel = "Codex",
}: {
  compact?: boolean;
  executorLabel?: string;
}) {
  return (
    <section className="rounded-xl border border-teal-200 bg-teal-50/50 p-4" aria-label="软件工程四步流程">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">软件工程其实只有四步</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            Engineer 完成后，你只需看实现、测试和风险，再通过并解锁 Tester；七份记录由 {executorLabel} 维护，不要求你编辑 Markdown。
          </p>
        </div>
        <Badge variant="info">写代码在第 2 步</Badge>
      </div>
      <ol className={cn("mt-3 grid gap-2", compact ? "sm:grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-4")}>
        {ENGINEERING_FLOW_STEPS.map((step) => (
          <li key={step.number} className="rounded-lg bg-white px-3 py-2.5 ring-1 ring-teal-100">
            <div className="text-xs font-semibold text-slate-900">{step.number}. {step.title}</div>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">{step.description}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function TesterFlowGuide({ compact = false }: { compact?: boolean }) {
  return (
    <section className="rounded-xl border border-sky-200 bg-sky-50/60 p-4" aria-label="Tester E2E 验证流程">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">Tester：先接收，再完成 E2E 三阶段</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            探索 → 固化 → 独立执行。MCP 跑通不等于通过；可重复证据必须来自当前 revision 的仓库脚本和真实 runner。
          </p>
        </div>
        <Badge variant="info">MCP 只在探索</Badge>
      </div>
      <ol className={cn("mt-3 grid gap-2", compact ? "sm:grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-4")}>
        {TESTER_FLOW_STEPS.map((step) => (
          <li key={step.number} className="rounded-lg bg-white px-3 py-2.5 ring-1 ring-sky-100">
            <div className="text-xs font-semibold text-slate-900">
              {step.number === 0 ? "接收" : `E2E Stage ${step.number}`} · {step.title}
            </div>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">{step.description}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ReleaseFlowGuide({ compact = false }: { compact?: boolean }) {
  return (
    <section className="rounded-xl border border-violet-200 bg-violet-50/60 p-4" aria-label="发布准备与审核流程">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">DevOps：准备、核对、审核、交接</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            目标是形成可执行、可观察、可回滚的发布手册；本阶段不会执行部署、发布、推送、合并或环境变更。
          </p>
        </div>
        <Badge variant="muted">准备就绪 ≠ 已发布</Badge>
      </div>
      <ol className={cn("mt-3 grid gap-2", compact ? "sm:grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-4")}>
        {RELEASE_FLOW_STEPS.map((step) => (
          <li key={step.number} className="rounded-lg bg-white px-3 py-2.5 ring-1 ring-violet-100">
            <div className="text-xs font-semibold text-slate-900">{step.number}. {step.title}</div>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">{step.description}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
