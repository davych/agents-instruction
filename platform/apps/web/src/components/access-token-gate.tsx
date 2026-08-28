import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Cloud, KeyRound, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, setAccessToken } from "@/lib/api";

export function AccessTokenGate({
  onConnected,
  storedTokenRejected = false,
}: {
  onConnected: () => void;
  storedTokenRejected?: boolean;
}) {
  const [token, setToken] = useState("");
  const mutation = useMutation({
    mutationFn: async (candidate: string) => {
      await api.checkAuth(candidate);
      return candidate;
    },
    onSuccess: (candidate) => {
      setAccessToken(candidate);
      setToken("");
      onConnected();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const candidate = token.trim();
    if (!candidate || mutation.isPending) return;
    mutation.mutate(candidate);
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 px-4 py-12">
      <div className="page-grid pointer-events-none absolute inset-0 opacity-20" />
      <div className="relative w-full max-w-md">
        <div className="mb-6 text-center text-white">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-500/15 text-teal-300 ring-1 ring-teal-300/20">
            <Cloud className="h-6 w-6" aria-hidden />
          </span>
          <h1 className="mt-4 text-2xl font-bold tracking-tight">连接 AI SDLC Cloud</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            此部署要求单租户访问令牌。验证通过后才能查看仓库、对话和运行记录。
          </p>
        </div>
        <Card className="border-white/10 bg-white shadow-2xl">
          <CardContent className="p-6">
            <form onSubmit={submit}>
              <label htmlFor="cloud-access-token" className="text-sm font-semibold text-slate-800">
                访问令牌
              </label>
              <div className="relative mt-2">
                <KeyRound className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" aria-hidden />
                <Input
                  id="cloud-access-token"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  className="pl-9 font-mono"
                  value={token}
                  onChange={(event) => {
                    setToken(event.target.value);
                    mutation.reset();
                  }}
                />
              </div>
              {storedTokenRejected || mutation.isError ? (
                <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
                  {mutation.error instanceof Error
                    ? mutation.error.message
                    : "上次保存的访问令牌已失效，请重新输入。"}
                </p>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                className="mt-5 w-full"
                loading={mutation.isPending}
                disabled={!token.trim()}
              >
                <ShieldCheck className="h-4 w-4" aria-hidden />
                验证并连接
              </Button>
            </form>
            <p className="mt-4 text-center text-[11px] leading-5 text-slate-400">
              令牌只保存在当前浏览器标签页所属的 sessionStorage；不会写入项目、URL 或 localStorage。
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
