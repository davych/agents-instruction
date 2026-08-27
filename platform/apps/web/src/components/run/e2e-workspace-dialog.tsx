import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Field } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { ConfigureE2eWorkspaceInput, E2eWorkspace } from "@/lib/types";
import { cn } from "@/lib/utils";

export function E2eWorkspaceDialog({
  projectId,
  suggestedRootPath,
  open,
  onOpenChange,
  onConfigured,
}: {
  projectId: string;
  suggestedRootPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigured: (workspace: E2eWorkspace) => void | Promise<void>;
}) {
  const [rootPath, setRootPath] = useState(suggestedRootPath);
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:4173");
  const [sourceStartScript, setSourceStartScript] = useState("preview");
  const [playwrightVersion, setPlaywrightVersion] = useState("1.62.1");
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setRootPath(suggestedRootPath);
    setError(undefined);
  }, [open, suggestedRootPath]);
  const mutation = useMutation({
    mutationFn: () => {
      const input: ConfigureE2eWorkspaceInput = {
        rootPath: rootPath.trim(),
        initialize: true,
        baseUrl: baseUrl.trim(),
        packageManager: "npm",
        sourceStartScript: sourceStartScript.trim(),
        testScript: "test:e2e",
        browser: "chromium",
        playwrightVersion: playwrightVersion.trim(),
      };
      return api.configureE2eWorkspace(projectId, input);
    },
    onMutate: () => setError(undefined),
    onSuccess: async (workspace) => {
      await onConfigured(workspace);
      onOpenChange(false);
    },
    onError: (mutationError) => setError(
      mutationError instanceof Error ? mutationError.message : "无法配置独立 E2E workspace",
    ),
  });
  const rootValid = isAbsoluteFilePath(rootPath);
  const baseUrlValid = isLoopbackHttpUrl(baseUrl);
  const scriptValid = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/u.test(sourceStartScript.trim());
  const versionValid = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(playwrightVersion.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => !mutation.isPending && onOpenChange(nextOpen)}
      title="配置独立 E2E workspace"
      description="平台会显式初始化一个只维护 Playwright 脚本的新目录，并在产品项目写入 linked workspace 描述文件；产品源代码不会改变。依赖和 Chromium 下载将在下一步由你单独确认。"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="space-y-4">
          <Field label="独立 E2E 目录" hint="必须是绝对路径，且与产品目录分离" required>
            <Input
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              className="font-mono text-xs"
              aria-invalid={!rootValid}
            />
            {rootPath.trim() && !rootValid ? (
              <p className="mt-1 text-xs text-rose-700">请输入绝对路径，例如 /workspace/product-e2e 或 C:\workspace\product-e2e。</p>
            ) : null}
          </Field>
          <Field label="本机应用地址" hint="仅无凭据、无 #fragment 的 loopback HTTP" required>
            <Input
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              className="font-mono text-xs"
              aria-invalid={Boolean(baseUrl && !baseUrlValid)}
            />
            {baseUrl.trim() && !baseUrlValid ? (
              <p className="mt-1 text-xs text-rose-700">请输入不含用户名、密码或 #fragment 的 http://localhost、127.0.0.1 或 [::1] 地址。</p>
            ) : null}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="产品启动 script" hint="仅字母数字、:、_、-，最多 80 字符" required>
              <Input
                value={sourceStartScript}
                onChange={(event) => setSourceStartScript(event.target.value)}
                placeholder="preview"
                className="font-mono text-xs"
                aria-invalid={Boolean(sourceStartScript && !scriptValid)}
              />
              {sourceStartScript.trim() && !scriptValid ? (
                <p className="mt-1 text-xs text-rose-700">请输入最多 80 字符的固定 npm script key；不允许点号、空格或 shell 语法。</p>
              ) : null}
            </Field>
            <Field label="Playwright 精确版本" hint="禁止 latest / range" required>
              <Input
                value={playwrightVersion}
                onChange={(event) => setPlaywrightVersion(event.target.value)}
                placeholder="1.62.1"
                className="font-mono text-xs"
                aria-invalid={Boolean(playwrightVersion && !versionValid)}
              />
            </Field>
          </div>
          <div className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs sm:grid-cols-3">
            <E2eFact label="包管理器" value="npm（固定）" />
            <E2eFact label="测试 script" value="test:e2e（固定）" mono />
            <E2eFact label="浏览器" value="Chromium（固定）" />
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900">
            此操作只创建 workspace 描述文件、package.json、Playwright 配置和空测试目录；不会提交、推送、合并或发布。
          </div>
          {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</div> : null}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-100 px-6 py-4">
        <Button variant="ghost" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>取消</Button>
        <Button
          variant="primary"
          loading={mutation.isPending}
          disabled={!rootValid || !baseUrlValid || !scriptValid || !versionValid}
          onClick={() => mutation.mutate()}
        >
          初始化独立 E2E workspace
        </Button>
      </div>
    </Dialog>
  );
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const trimmed = value.trim();
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && !parsed.hash
      && !trimmed.includes("#");
  } catch {
    return false;
  }
}

function isAbsoluteFilePath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("/")
    || /^[A-Za-z]:[\\/]/u.test(trimmed);
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
