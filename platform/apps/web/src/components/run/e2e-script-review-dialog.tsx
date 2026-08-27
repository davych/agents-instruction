import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { EmptyState, Field } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { ReviewDecision, VerificationE2eAuthoring } from "@/lib/types";
import { cn } from "@/lib/utils";

export function E2eScriptReviewDialog({
  runId,
  authoring,
  loadError,
  open,
  onOpenChange,
  onReviewed,
}: {
  runId: string;
  authoring: VerificationE2eAuthoring | null;
  loadError?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReviewed: () => void | Promise<void>;
}) {
  const [comment, setComment] = useState("");
  const [completeBaselineReviewed, setCompleteBaselineReviewed] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setComment("");
    setCompleteBaselineReviewed(false);
    setError(undefined);
  }, [open, authoring?.patchHash]);
  const completeBaselineDisplayed = Boolean(
    authoring?.files.length
      && authoring.files.every((file) => typeof file.content === "string"),
  );
  const mutation = useMutation({
    mutationFn: (decision: ReviewDecision) => {
      if (!authoring) throw new Error("当前没有可审核的 E2E 脚本版本");
      if (decision === "approve" && (loadError || !completeBaselineDisplayed)) {
        throw new Error("整套可执行脚本基线没有完整加载，不能批准");
      }
      if (decision === "approve" && !completeBaselineReviewed) {
        throw new Error("请先确认已经看过整套文件的全部内容和每个 hash");
      }
      return api.reviewVerificationE2eScript(runId, {
        decision,
        expectedPatchHash: authoring.patchHash,
        comment: comment.trim(),
      });
    },
    onMutate: () => setError(undefined),
    onSuccess: async () => {
      await onReviewed();
      onOpenChange(false);
    },
    onError: (mutationError) => setError(
      mutationError instanceof Error ? mutationError.message : "无法保存 E2E 脚本审核",
    ),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => !mutation.isPending && onOpenChange(nextOpen)}
      title="人工审核 · 完整 E2E 可执行脚本基线"
      description="这里展示 Playwright 实际会执行的整套 tests/** 与 fixtures/**，不是只展示本次变更。必须核对每个文件的全部内容与 hash；这里不会批准 Verification、合并或发布。"
      className="max-w-4xl"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {loadError ? (
          <div role="alert" className="mb-4 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2.5 text-xs leading-5 text-rose-900">
            完整可执行脚本基线加载失败；当前没有完整展示整套文件，不能批准或执行。{loadError}
          </div>
        ) : null}
        {authoring ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
              <E2eFact label="完整基线 Manifest SHA-256" value={authoring.patchHash} mono />
              <p className="mt-2 text-slate-600">覆盖：{authoring.criterionIds.join("、") || "未解析到稳定 AC ID"}</p>
              <p className="mt-1 text-slate-600">整套文件：{authoring.files.length} 个；全部内容与 hash 都必须人工看过。</p>
            </div>
            <div className="space-y-3">
              {authoring.files.map((file) => (
                <details key={file.path} className="overflow-hidden rounded-xl border border-slate-200 bg-white" open={authoring.files.length === 1}>
                  <summary className="cursor-pointer list-none px-4 py-3 marker:hidden">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-slate-800">{file.path}</span>
                      <Badge variant="muted">{file.bytes} bytes</Badge>
                    </div>
                    <div className="mt-1 truncate font-mono text-[10px] text-slate-400">sha256:{file.sha256}</div>
                  </summary>
                  <pre className="max-h-80 overflow-auto border-t border-slate-100 bg-slate-950 p-4 text-[11px] leading-5 text-slate-100">
                    <code>{file.content ?? "平台未返回完整文件内容；当前页面没有完整展示整套基线，不能仅凭 hash 审核。"}</code>
                  </pre>
                </details>
              ))}
            </div>
            {!completeBaselineDisplayed ? (
              <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-900">
                当前没有完整展示整套可执行脚本基线，批准操作已停用。
              </div>
            ) : (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-3 text-xs leading-5 text-sky-950">
                <Checkbox
                  checked={completeBaselineReviewed}
                  onCheckedChange={setCompleteBaselineReviewed}
                  disabled={mutation.isPending}
                  aria-label="确认已审阅整套可执行脚本基线"
                />
                <span>我已逐一看过整套 tests/** 与 fixtures/** 文件的全部内容和每个 SHA-256，并确认这就是允许 Playwright 实际执行的完整基线。</span>
              </label>
            )}
            <Field label="审核意见" required>
              <Textarea
                value={comment}
                maxLength={5_000}
                onChange={(event) => setComment(event.target.value)}
                placeholder="写下你核对过的测试意图、选择器、数据与运行边界，或具体修改要求。"
                className="min-h-24"
              />
            </Field>
            {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</div> : null}
          </div>
        ) : loadError ? null : (
          <EmptyState title="没有待审完整基线" description="刷新 E2E flow，或先生成独立 Playwright 脚本基线。" />
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 border-t border-slate-100 px-6 py-4 sm:grid-cols-2">
        <Button
          variant="destructive"
          className="h-auto min-h-10 whitespace-normal py-2"
          loading={mutation.isPending && mutation.variables === "request_changes"}
          disabled={!authoring || !comment.trim() || mutation.isPending}
          onClick={() => mutation.mutate("request_changes")}
        >
          要求修改脚本
        </Button>
        <Button
          variant="success"
          className="h-auto min-h-10 whitespace-normal py-2"
          loading={mutation.isPending && mutation.variables === "approve"}
          disabled={
            !authoring
            || !comment.trim()
            || mutation.isPending
            || Boolean(loadError)
            || !completeBaselineDisplayed
            || !completeBaselineReviewed
          }
          onClick={() => mutation.mutate("approve")}
        >
          批准脚本并允许运行
        </Button>
      </div>
    </Dialog>
  );
}

function E2eFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={cn("mt-1 truncate text-xs text-slate-700", mono && "font-mono text-[11px]")} title={value}>
        {value}
      </div>
    </div>
  );
}
