import { useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CheckCircle2,
  KeyRound,
  Pencil,
  Power,
  RefreshCw,
  ShieldCheck,
  WifiOff,
} from "lucide-react";

import { ErrorState, Field, PageSkeleton } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type {
  AskProviderConfiguration,
  AskProviderConfigurationCheck,
  AskProviderId,
  AskProviderProtocol,
} from "@/lib/types";
import {
  currentProviderCheck,
  providerCardActions,
  providerWriteOnlyUpdates,
} from "@/lib/provider-settings";

const PROVIDER_IDS: readonly AskProviderId[] = ["openai", "lmstudio", "ollama", "custom"];

const PROVIDER_META: Record<AskProviderId, {
  label: string;
  description: string;
  defaultModel: string;
  protocol: AskProviderProtocol;
  endpointHint: string;
}> = {
  openai: {
    label: "OpenAI",
    description: "远程 Responses API；支持完整 Agent 工具回合。",
    defaultModel: "gpt-5.6-terra",
    protocol: "openai-responses",
    endpointHint: "默认使用 OpenAI 官方地址",
  },
  lmstudio: {
    label: "LM Studio",
    description: "平台自动选择兼容方式，你只需填写服务地址和模型。",
    defaultModel: "",
    protocol: "openai-chat",
    endpointHint: "例如 http://host.docker.internal:1234/v1",
  },
  ollama: {
    label: "Ollama",
    description: "连接 Cloud API 所在网络能够访问的 Ollama 服务。",
    defaultModel: "",
    protocol: "ollama-chat",
    endpointHint: "例如 http://host.docker.internal:11434",
  },
  custom: {
    label: "Custom",
    description: "连接你明确配置的 OpenAI-compatible 或 Ollama endpoint。",
    defaultModel: "",
    protocol: "openai-responses",
    endpointHint: "填写 Cloud API 能访问的服务地址",
  },
};

interface ProviderFormState {
  label: string;
  model: string;
  protocol: AskProviderProtocol;
  structuredOutput: boolean;
  toolCalling: boolean;
  allowInsecureHttp: boolean;
}

export function ProviderSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const providersQuery = useQuery({
    queryKey: ["ask", "provider-configurations"],
    queryFn: ({ signal }) => api.listAskProviderConfigurations({ signal }),
    enabled: open,
    staleTime: 10_000,
  });
  const providers = useMemo(() => PROVIDER_IDS.map((id) => (
    providersQuery.data?.find((provider) => provider.providerId === id) ?? emptyProvider(id)
  )), [providersQuery.data]);
  const [editingId, setEditingId] = useState<AskProviderId>();
  const [form, setForm] = useState<ProviderFormState>();
  const [endpointDraft, setEndpointDraft] = useState("");
  const [credentialDraft, setCredentialDraft] = useState("");
  const [clearCredential, setClearCredential] = useState(false);
  const [clearEndpoint, setClearEndpoint] = useState(false);
  const [pendingAction, setPendingAction] = useState<string>();
  const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string }>();
  const [checks, setChecks] = useState<Partial<Record<AskProviderId, AskProviderConfigurationCheck>>>({});

  const editingProvider = editingId
    ? providers.find((provider) => provider.providerId === editingId)
    : undefined;

  const resetSensitiveDrafts = () => {
    setEndpointDraft("");
    setCredentialDraft("");
    setClearCredential(false);
    setClearEndpoint(false);
  };

  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetSensitiveDrafts();
      setEditingId(undefined);
      setForm(undefined);
      setNotice(undefined);
      setChecks({});
    }
    onOpenChange(nextOpen);
  };

  const beginEdit = (provider: AskProviderConfiguration) => {
    const meta = PROVIDER_META[provider.providerId];
    resetSensitiveDrafts();
    setForm({
      label: provider.label || meta.label,
      model: provider.model ?? meta.defaultModel,
      protocol: provider.providerId === "custom" ? provider.protocol : meta.protocol,
      structuredOutput: provider.providerId === "custom" ? provider.structuredOutput : true,
      toolCalling: provider.providerId === "openai" ? true : provider.toolCalling,
      allowInsecureHttp: provider.providerId === "openai" ? false : provider.allowInsecureHttp,
    });
    setEditingId(provider.providerId);
    setNotice(undefined);
  };

  const replaceProvider = (provider: AskProviderConfiguration) => {
    queryClient.setQueryData<AskProviderConfiguration[]>(["ask", "provider-configurations"], (current = []) => (
      PROVIDER_IDS.map((id) => id === provider.providerId
        ? provider
        : current.find((candidate) => candidate.providerId === id) ?? emptyProvider(id))
    ));
  };

  const checkProvider = async (provider: AskProviderConfiguration) => {
    setPendingAction(`check:${provider.providerId}`);
    setNotice(undefined);
    try {
      const check = await api.checkAskProviderConfiguration(provider.providerId, {
        expectedVersion: provider.version,
      });
      setChecks((current) => ({ ...current, [provider.providerId]: check }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["ask", "provider-configurations"] }),
        queryClient.invalidateQueries({ queryKey: ["ask", "providers"] }),
      ]);
      setNotice({
        kind: check.state === "ready" ? "success" : "error",
        message: check.message,
      });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "连接检查失败。" });
    } finally {
      setPendingAction(undefined);
    }
  };

  const setEnabled = async (provider: AskProviderConfiguration, enabled: boolean) => {
    setPendingAction(`state:${provider.providerId}`);
    setNotice(undefined);
    try {
      const actions = providerCardActions(provider, checks[provider.providerId]);
      const expectedVersion = enabled
        ? actions.expectedEnableVersion ?? provider.version
        : provider.version;
      const updated = await api.setAskProviderEnabled(provider.providerId, {
        expectedVersion,
        enabled,
      });
      replaceProvider(updated);
      await queryClient.invalidateQueries({ queryKey: ["ask", "providers"] });
      setNotice({ kind: "success", message: `${updated.label} 已${enabled ? "启用" : "停用"}。` });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "Provider 状态没有更新。" });
    } finally {
      setPendingAction(undefined);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingProvider || !form) return;
    const model = form.model.trim();
    const credential = credentialDraft;
    if (!model) {
      setNotice({ kind: "error", message: "请填写模型名称。" });
      return;
    }
    if (editingProvider.providerId === "custom" && !editingProvider.hasEndpoint && !endpointDraft.trim()) {
      setNotice({ kind: "error", message: "首次配置 Custom Provider 时需要填写服务地址。" });
      return;
    }
    if (
      editingProvider.providerId === "openai"
      && !editingProvider.hasCredential
      && !credential
    ) {
      setNotice({ kind: "error", message: "首次配置 OpenAI 时需要填写 API Key。" });
      return;
    }

    setPendingAction(`save:${editingProvider.providerId}`);
    setNotice(undefined);
    // The credential leaves component state before the request begins. It is
    // never copied into a query key, browser storage, response object or edit
    // form default value.
    setCredentialDraft("");
    let configurationSaved = false;
    try {
      const sensitiveUpdates = providerWriteOnlyUpdates(editingProvider, {
        endpointDraft,
        credentialDraft: credential,
        clearEndpoint,
        clearCredential,
      });
      const saved = await api.saveAskProviderConfiguration(editingProvider.providerId, {
        expectedVersion: editingProvider.version,
        label: form.label.trim() || PROVIDER_META[editingProvider.providerId].label,
        protocol: form.protocol,
        model,
        endpoint: sensitiveUpdates.endpoint,
        credential: sensitiveUpdates.credential,
        structuredOutput: form.structuredOutput,
        toolCalling: form.toolCalling,
        allowInsecureHttp: editingProvider.providerId === "openai" ? false : form.allowInsecureHttp,
      });
      configurationSaved = true;
      replaceProvider(saved);
      const check = await api.checkAskProviderConfiguration(editingProvider.providerId, {
        expectedVersion: saved.version,
      });
      setChecks((current) => ({ ...current, [editingProvider.providerId]: check }));
      replaceProvider({ ...saved, version: check.version, lastCheck: check });
      setClearCredential(false);
      setClearEndpoint(false);
      setEndpointDraft("");
      if (check.state === "ready" && check.configVersion === saved.configVersion) {
        const enabled = await api.setAskProviderEnabled(editingProvider.providerId, {
          expectedVersion: check.version,
          enabled: true,
        });
        replaceProvider(enabled);
        await queryClient.invalidateQueries({ queryKey: ["ask", "providers"] });
        setEditingId(undefined);
        setForm(undefined);
        setNotice({ kind: "success", message: `${enabled.label} 已保存、检查并启用。` });
      } else {
        await queryClient.invalidateQueries({ queryKey: ["ask", "providers"] });
        setNotice({
          kind: "error",
          message: `${check.message} 配置已保存，但保持停用。`,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "请重试。";
      if (configurationSaved) {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: ["ask", "provider-configurations"] }),
          queryClient.invalidateQueries({ queryKey: ["ask", "providers"] }),
        ]);
      }
      setNotice({
        kind: "error",
        message: configurationSaved
          ? `配置已保存并保持停用，但测试或启用失败：${detail}`
          : `Provider 配置没有保存：${detail}`,
      });
    } finally {
      setPendingAction(undefined);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={changeOpen}
      title="模型设置"
      description="在一个地方配置 OpenAI、LM Studio、Ollama 和 Custom。配置属于 Cloud 服务；项目只选择默认 Provider，对话可随时切换下一条消息使用的模型。"
      className="max-w-4xl"
      closeDisabled={Boolean(pendingAction)}
    >
      <div className="overflow-y-auto p-6">
        {providersQuery.isLoading ? <PageSkeleton /> : providersQuery.isError ? (
          <ErrorState error={providersQuery.error} retry={() => void providersQuery.refetch()} />
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2" aria-label="Provider 列表">
              {providers.map((provider) => (
                <ProviderCard
                  key={provider.providerId}
                  provider={provider}
                  check={currentProviderCheck(provider, checks[provider.providerId])}
                  busy={Boolean(pendingAction)}
                  onEdit={() => beginEdit(provider)}
                  onCheck={() => void checkProvider(provider)}
                  onEnabledChange={(enabled) => void setEnabled(provider, enabled)}
                />
              ))}
            </div>

            {editingProvider && form ? (
              <form onSubmit={(event) => void save(event)} className="rounded-2xl border border-teal-200 bg-teal-50/40 p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-950">
                      {editingProvider.configured ? "编辑" : "配置"} {PROVIDER_META[editingProvider.providerId].label}
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {editingProvider.providerId === "openai"
                        ? "官方服务地址固定；密钥不会回显。密钥留空就是保留，只有“明确清除”才会删除。"
                        : "服务地址和密钥都不会回显。留空表示保留服务端已有值；两个“明确清除”开关只删除各自对应的值。"}
                    </p>
                    {editingProvider.providerId === "lmstudio" ? (
                      <p className="mt-1 text-xs font-medium leading-5 text-teal-700">
                        平台会自动使用兼容的 JSON 接口，无需选择协议。
                      </p>
                    ) : null}
                  </div>
                  <Button type="button" variant="ghost" size="sm" disabled={Boolean(pendingAction)} onClick={() => {
                    resetSensitiveDrafts();
                    setEditingId(undefined);
                    setForm(undefined);
                  }}>
                    取消编辑
                  </Button>
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {editingProvider.providerId === "custom" ? (
                    <Field label="显示名称" required>
                      <Input
                        value={form.label}
                        maxLength={120}
                        onChange={(event) => setForm((current) => current ? { ...current, label: event.target.value } : current)}
                      />
                    </Field>
                  ) : null}
                  <Field label="模型名称" required>
                    <Input
                      value={form.model}
                      maxLength={256}
                      placeholder={PROVIDER_META[editingProvider.providerId].defaultModel || "例如你在服务端加载的模型 ID"}
                      onChange={(event) => setForm((current) => current ? { ...current, model: event.target.value } : current)}
                    />
                  </Field>
                  {editingProvider.providerId === "custom" ? (
                    <Field label="协议" required>
                      <select
                        className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-teal-500"
                        value={form.protocol}
                        onChange={(event) => setForm((current) => current ? {
                          ...current,
                          protocol: event.target.value as AskProviderProtocol,
                          structuredOutput: event.target.value === "openai-chat"
                            ? current.structuredOutput
                            : true,
                        } : current)}
                      >
                        <option value="openai-responses">OpenAI Responses</option>
                        <option value="openai-chat">OpenAI Chat Completions</option>
                        <option value="ollama-chat">Ollama Chat</option>
                      </select>
                    </Field>
                  ) : null}
                  {editingProvider.providerId === "openai" ? (
                    <Field label="服务地址" hint="固定官方地址">
                      <div className="rounded-lg border border-slate-200 bg-slate-100 px-3 py-2.5 text-sm text-slate-600">
                        api.openai.com
                        <p className="mt-1 text-[11px] leading-4 text-slate-500">
                          OpenAI 卡固定使用官方服务；代理或 OpenAI-compatible 服务请使用 Custom。
                        </p>
                      </div>
                    </Field>
                  ) : (
                    <Field
                      label="新的服务地址"
                      hint={editingProvider.endpointLabel && editingProvider.endpointLabel !== "未配置"
                        ? `已保存：${editingProvider.endpointLabel}`
                        : "尚未保存"}
                    >
                      <div className="space-y-2">
                        <Input
                          type="url"
                          value={endpointDraft}
                          autoComplete="off"
                          disabled={clearEndpoint}
                          placeholder={`${PROVIDER_META[editingProvider.providerId].endpointHint}；留空保持不变`}
                          onChange={(event) => setEndpointDraft(event.target.value)}
                        />
                        <label className="flex items-center gap-2 text-[11px] font-normal text-slate-500">
                          <input
                            type="checkbox"
                            checked={clearEndpoint}
                            disabled={!editingProvider.hasEndpoint}
                            onChange={(event) => {
                              setClearEndpoint(event.target.checked);
                              if (event.target.checked) setEndpointDraft("");
                            }}
                          />
                          明确清除已保存地址
                        </label>
                        {editingProvider.hasCredential ? (
                          <p className="text-[11px] leading-4 text-amber-700">
                            如果新地址更换了 host，请同时重新填写或明确清除密钥；服务端不会把旧密钥静默发给新 host。
                          </p>
                        ) : null}
                      </div>
                    </Field>
                  )}
                  <Field
                    label="新的 API Key"
                    hint={editingProvider.hasCredential
                      ? "服务端已有密钥"
                      : "尚未保存密钥"}
                  >
                    <Input
                      type="password"
                      value={credentialDraft}
                      autoComplete="new-password"
                      disabled={clearCredential}
                      placeholder="永不回显；留空保持不变"
                      onChange={(event) => setCredentialDraft(event.target.value)}
                    />
                  </Field>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={form.toolCalling}
                      disabled={editingProvider.providerId === "openai"}
                      onChange={(event) => setForm((current) => current ? { ...current, toolCalling: event.target.checked } : current)}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                    />
                    <span>
                      <span className="block font-semibold text-slate-800">Agent 工具调用（可选）</span>
                      <span className="mt-0.5 block">只在 Agent 或 MCP 需要调用工具时开启；连接检查会验证无副作用 tool-call。</span>
                    </span>
                  </label>
                  {editingProvider.providerId === "custom" ? (
                    <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={form.structuredOutput}
                        disabled={form.protocol !== "openai-chat"}
                        onChange={(event) => setForm((current) => current ? { ...current, structuredOutput: event.target.checked } : current)}
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                      />
                      <span>
                        <span className="block font-semibold text-slate-800">支持原生结构化输出</span>
                        <span className="mt-0.5 block">OpenAI Chat 兼容服务可按真实能力关闭；Responses 与 Ollama 协议需要保持开启。</span>
                      </span>
                    </label>
                  ) : null}
                  <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={clearCredential}
                      disabled={!editingProvider.hasCredential}
                      onChange={(event) => {
                        setClearCredential(event.target.checked);
                        if (event.target.checked) setCredentialDraft("");
                      }}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500"
                    />
                    <span>
                      <span className="block font-semibold text-slate-800">明确清除已保存密钥</span>
                      <span className="mt-0.5 block">这是唯一会删除密钥的操作；不勾选且留空就是保留。</span>
                    </span>
                  </label>
                  {editingProvider.providerId !== "openai" ? (
                    <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={form.allowInsecureHttp}
                        onChange={(event) => setForm((current) => current ? { ...current, allowInsecureHttp: event.target.checked } : current)}
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                      />
                      <span>
                        <span className="block font-semibold text-slate-800">允许 HTTP（仅可信内网）</span>
                        <span className="mt-0.5 block">公网服务应保持关闭；服务端仍会拒绝格式错误和明显高风险的字面量地址。</span>
                      </span>
                    </label>
                  ) : null}
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-teal-100 pt-4">
                  <p className="max-w-xl text-[11px] leading-5 text-slate-500">
                    测试只发送固定的小型兼容性请求，不发送仓库、Issue 或聊天内容。服务端会校验 URL 形状与高风险字面量地址；生产环境还应配置独立的网络出口策略。
                  </p>
                  <Button type="submit" variant="primary" loading={pendingAction === `save:${editingProvider.providerId}`}>
                    <ShieldCheck className="h-4 w-4" aria-hidden /> 保存、测试并启用
                  </Button>
                </div>
              </form>
            ) : null}

            {notice ? (
              <div
                role="status"
                aria-live="polite"
                className={notice.kind === "success"
                  ? "rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
                  : "rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"}
              >
                {notice.message}
              </div>
            ) : null}

            <div className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-500">
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              密钥只通过当前已认证请求写入服务端；远程部署必须使用 HTTPS。它不会进入消息、项目仓库、Sandbox、URL 或浏览器存储，页面也永远不会把已保存密钥填回输入框。
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ProviderCard({
  provider,
  check,
  busy,
  onEdit,
  onCheck,
  onEnabledChange,
}: {
  provider: AskProviderConfiguration;
  check?: AskProviderConfigurationCheck | null;
  busy: boolean;
  onEdit: () => void;
  onCheck: () => void;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const actions = providerCardActions(provider, check);
  const enabled = provider.enabled;
  const ready = actions.check?.state === "ready";
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-teal-200">
            <Bot className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-slate-950">{PROVIDER_META[provider.providerId].label}</h3>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">{PROVIDER_META[provider.providerId].description}</p>
          </div>
        </div>
        <Badge variant={!provider.configured ? "muted" : enabled ? "success" : "warning"}>
          {!provider.configured ? "未配置" : enabled ? "已启用" : "已停用"}
        </Badge>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-slate-50 px-3 py-2 text-[11px]">
        <div className="min-w-0">
          <dt className="text-slate-400">模型</dt>
          <dd className="mt-0.5 truncate font-mono text-slate-700" title={provider.model ?? undefined}>{provider.model ?? "未设置"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-slate-400">服务</dt>
          <dd className="mt-0.5 truncate text-slate-700" title={provider.endpointLabel}>{provider.endpointLabel}</dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        {ready ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden /> : <WifiOff className="h-3.5 w-3.5 text-slate-400" aria-hidden />}
        <span>{actions.check?.message ?? (provider.configured ? "等待当前版本连接测试" : "尚未配置")}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" aria-hidden /> {provider.configured ? "编辑" : "配置"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy || !actions.canCheck} onClick={onCheck}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> 测试
        </Button>
        <Button
          type="button"
          size="sm"
          variant={enabled ? "ghost" : "secondary"}
          disabled={busy || (enabled ? !actions.canDisable : !actions.canEnable)}
          onClick={() => onEnabledChange(!enabled)}
        >
          <Power className="h-3.5 w-3.5" aria-hidden /> {enabled ? "停用" : "启用"}
        </Button>
      </div>
    </article>
  );
}

function emptyProvider(id: AskProviderId): AskProviderConfiguration {
  const meta = PROVIDER_META[id];
  return {
    providerId: id,
    label: meta.label,
    configured: false,
    enabled: false,
    model: null,
    protocol: meta.protocol,
    dataBoundary: id === "openai" ? "remote" : id === "custom" ? "operator-configured" : "local",
    endpointLabel: "未配置",
    hasEndpoint: false,
    hasCredential: false,
    structuredOutput: true,
    toolCalling: id === "openai",
    allowInsecureHttp: false,
    version: 1,
    configVersion: 1,
    lastCheck: null,
    createdAt: null,
    updatedAt: null,
  };
}
