import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourcePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

const paths = {
  app: sourcePath("../src/App.tsx"),
  shell: sourcePath("../src/components/app-shell.tsx"),
  dialog: sourcePath("../src/components/provider-settings-dialog.tsx"),
  agent: sourcePath("../src/pages/agent-workspace-page.tsx"),
  ask: sourcePath("../src/pages/ask-page.tsx"),
  api: sourcePath("../src/lib/api.ts"),
  providerSettings: sourcePath("../src/lib/provider-settings.ts"),
};

test("Provider settings is one global dialog with lightweight entry points", async () => {
  const [app, shell, dialog, agent, ask] = await Promise.all([
    readFile(paths.app, "utf8"),
    readFile(paths.shell, "utf8"),
    readFile(paths.dialog, "utf8"),
    readFile(paths.agent, "utf8"),
    readFile(paths.ask, "utf8"),
  ]);

  assert.match(app, /<ProviderSettingsDialog/u);
  assert.match(shell, />模型设置</u);
  assert.match(dialog, /\["openai", "lmstudio", "ollama", "custom"\]/u);
  for (const action of ["配置", "编辑", "测试", "启用", "停用", "保存、测试并启用"]) {
    assert.match(dialog, new RegExp(action, "u"));
  }
  assert.match(agent, /配置 Provider/u);
  assert.match(agent, /aria-label="管理模型 Provider"/u);
  assert.match(ask, /配置 Provider/u);
  assert.match(ask, /onOpenProviderSettings/u);
  assert.match(dialog, /lmstudio:[\s\S]{0,260}protocol: "openai-chat"/u);
  assert.match(dialog, /平台会自动使用兼容的 JSON 接口，无需选择协议/u);
  assert.match(dialog, /Agent 工具调用（可选）/u);
  assert.match(dialog, /只在 Agent 或 MCP 需要调用工具时开启/u);
  assert.match(dialog, /structuredOutput: provider\.providerId === "custom" \? provider\.structuredOutput : true/u);
  assert.match(dialog, /支持原生结构化输出/u);
});

test("Provider secrets and endpoints are write-only drafts with explicit keep or clear", async () => {
  const [dialog, providerSettings] = await Promise.all([
    readFile(paths.dialog, "utf8"),
    readFile(paths.providerSettings, "utf8"),
  ]);

  assert.match(dialog, /const \[credentialDraft, setCredentialDraft\] = useState\(""\)/u);
  assert.match(dialog, /type="password"[\s\S]{0,160}value=\{credentialDraft\}[\s\S]{0,160}autoComplete="new-password"/u);
  assert.match(dialog, /setCredentialDraft\(""\)[\s\S]{0,500}api\.saveAskProviderConfiguration/u);
  assert.match(dialog, /providerWriteOnlyUpdates\(editingProvider/u);
  assert.match(dialog, /credential: sensitiveUpdates\.credential/u);
  assert.match(providerSettings, /credential: input\.clearCredential[\s\S]{0,180}action: "clear"[\s\S]{0,180}action: "replace"[\s\S]{0,100}action: "keep"/u);
  assert.doesNotMatch(dialog, /defaultValue=.*credential|localStorage|sessionStorage/u);

  assert.match(dialog, /const \[endpointDraft, setEndpointDraft\] = useState\(""\)/u);
  assert.match(dialog, /value=\{endpointDraft\}/u);
  assert.match(dialog, /endpoint: sensitiveUpdates\.endpoint/u);
  assert.match(providerSettings, /endpoint: provider\.providerId === "openai"[\s\S]{0,100}action: "keep"[\s\S]{0,240}action: "clear"[\s\S]{0,180}action: "replace"/u);
  assert.doesNotMatch(dialog, /value=\{editingProvider\.endpointLabel\}|defaultValue=\{editingProvider\.endpointLabel\}/u);
  assert.match(dialog, /已保存：\$\{editingProvider\.endpointLabel\}/u);
  assert.match(dialog, /OpenAI 卡固定使用官方服务；代理或 OpenAI-compatible 服务请使用 Custom/u);
  assert.match(dialog, /allowInsecureHttp: editingProvider\.providerId === "openai" \? false : form\.allowInsecureHttp/u);
  assert.match(dialog, /editingProvider\.providerId !== "openai" \? \([\s\S]{0,700}允许 HTTP（仅可信内网）/u);
  assert.match(dialog, /官方服务地址固定；密钥不会回显。密钥留空就是保留/u);
});

test("save, versioned check, and ready-only enable use the control-plane API in order", async () => {
  const [dialog, api] = await Promise.all([
    readFile(paths.dialog, "utf8"),
    readFile(paths.api, "utf8"),
  ]);

  const saveAt = dialog.indexOf("api.saveAskProviderConfiguration");
  const checkAt = dialog.indexOf("api.checkAskProviderConfiguration", saveAt);
  const readyAt = dialog.indexOf('check.state === "ready"', checkAt);
  const enableAt = dialog.indexOf("api.setAskProviderEnabled", readyAt);
  assert.ok(saveAt >= 0 && saveAt < checkAt && checkAt < readyAt && readyAt < enableAt);
  assert.match(dialog, /expectedVersion: saved\.version/u);
  assert.match(dialog, /api\.setAskProviderEnabled\(editingProvider\.providerId, \{[\s\S]{0,100}expectedVersion: check\.version/u);
  assert.match(dialog, /check\.configVersion === saved\.configVersion/u);
  assert.match(dialog, /checkAskProviderConfiguration\(provider\.providerId[\s\S]{0,700}provider-configurations[\s\S]{0,300}"providers"/u);

  assert.match(api, /"\/api\/ask\/provider-configurations"/u);
  assert.match(api, /!\("credential" in value\)[\s\S]{0,80}!\("endpoint" in value\)/u);
  assert.match(api, /provider-configurations\/\$\{encodeURIComponent\(providerId\)\}`[\s\S]{0,100}method: "PUT"/u);
  assert.match(api, /provider-configurations\/\$\{encodeURIComponent\(providerId\)\}\/check`[\s\S]{0,100}method: "POST"/u);
  assert.match(api, /provider-configurations\/\$\{encodeURIComponent\(providerId\)\}\/enabled`[\s\S]{0,100}method: "PATCH"/u);
});

test("disabled Agent and DeepWiki selections are explicit and link back to model settings", async () => {
  const agent = await readFile(paths.agent, "utf8");

  assert.match(agent, /当前 Provider（[\s\S]{0,180}已停用或不可用/u);
  assert.match(agent, /请选择一个已启用的 Provider 后再发送/u);
  assert.match(agent, /当前 Provider · 已停用 \/ 不可用/u);
  assert.match(agent, /providerSelection\.selectedAvailable/u);
  assert.match(agent, /所选 Provider 已停用或不可用。先启用它[\s\S]{0,120}生成 DeepWiki/u);
  assert.match(agent, /disabled=\{!revision \|\| providerStatusLoading \|\| !providerAvailable\}/u);
  assert.match(agent, /onOpenProviderSettings/u);
});
