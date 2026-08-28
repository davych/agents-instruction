import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** ASK-AC-13: operator-facing configuration and safety boundaries stay documented. */
test("ASK-AC-13: operations docs cover all Provider variables, startup/checks, troubleshooting, and secret boundaries", async () => {
  const platformRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const [environment, readme, security, runtime] = await Promise.all([
    readFile(new URL("../../../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../../../README.md", import.meta.url), "utf8"),
    readFile(new URL("../../../docs/security-model.md", import.meta.url), "utf8"),
    readFile(new URL("../../../docs/runtime-contract.md", import.meta.url), "utf8"),
  ]);
  assert.ok(platformRoot.endsWith("platform/"));

  for (const variable of [
    "AI_SDLC_ASK_OPENAI_MODEL",
    "AI_SDLC_ASK_OPENAI_API_KEY",
    "AI_SDLC_ASK_OPENAI_BASE_URL",
    "AI_SDLC_ASK_LM_STUDIO_MODEL",
    "AI_SDLC_ASK_LM_STUDIO_BASE_URL",
    "AI_SDLC_ASK_LM_STUDIO_API_KEY",
    "AI_SDLC_ASK_LM_STUDIO_TOOL_CALLING",
    "AI_SDLC_ASK_OLLAMA_MODEL",
    "AI_SDLC_ASK_OLLAMA_BASE_URL",
    "AI_SDLC_ASK_OLLAMA_TOOL_CALLING",
    "AI_SDLC_ASK_CUSTOM_LABEL",
    "AI_SDLC_ASK_CUSTOM_PROTOCOL",
    "AI_SDLC_ASK_CUSTOM_MODEL",
    "AI_SDLC_ASK_CUSTOM_BASE_URL",
    "AI_SDLC_ASK_CUSTOM_API_KEY",
    "AI_SDLC_ASK_CUSTOM_STRUCTURED_OUTPUT",
    "AI_SDLC_ASK_CUSTOM_TOOL_CALLING",
    "AI_SDLC_ASK_TIMEOUT_MS",
    "AI_SDLC_ASK_MAX_RESPONSE_BYTES",
  ]) {
    assert.match(environment, new RegExp(`\\b${variable}=`, "u"), variable);
  }

  for (const provider of ["OpenAI", "LM Studio", "Ollama", "Custom"]) {
    assert.match(readme, new RegExp(provider.replace(" ", "\\s+"), "iu"), provider);
  }
  for (const protocol of ["openai-responses", "openai-chat", "ollama-chat"]) {
    assert.match(`${environment}\n${readme}`, new RegExp(protocol, "u"), protocol);
  }
  assert.match(readme, /yarn dev/u);
  assert.match(readme, /连接检查|connection check/iu);
  assert.match(readme, /认证|authentication/iu);
  assert.match(readme, /不可达|unreachable/iu);
  assert.match(readme, /模型.*不存在|missing models?/iu);
  assert.match(readme, /协议|protocol/iu);
  assert.match(readme, /重启.*API|restart.*API/iu);
  for (const state of [
    "not_configured",
    "authentication_failed",
    "unreachable",
    "model_unavailable",
    "protocol_error",
  ]) {
    assert.match(readme, new RegExp(`\\b${state}\\b`, "u"), state);
  }
  assert.match(readme, /\/api\/ask\/providers\/openai\/check/u);

  assert.match(security, /Ask requests cannot override them|Ask 请求.*不能.*覆盖/iu);
  assert.match(security, /API keys?.*never|密钥.*(?:永不|不会)/iu);
  assert.match(security, /HTTP.*loopback|HTTP.*回环/iu);
  assert.match(security, /remote endpoints require HTTPS|远程.*HTTPS/iu);
  assert.match(security, /skip.*symlink|跳过.*符号链接/iu);
  assert.match(runtime, /Ask.*read-only|Ask.*只读/iu);
  assert.match(runtime, /six-phase|六阶段/iu);
  assert.match(runtime, /does not automatically execute|不自动执行/iu);
  assert.match(runtime, /complete source-file SHA-256|完整.*文件.*SHA-256/iu);
  assert.doesNotMatch(runtime, /exact excerpt hash/iu);
});

test("ASK-AC-14: repository verification entry points remain wired to the required suites", async () => {
  const [rootPackage, platformPackage] = await Promise.all([
    readFile(new URL("../../../../package.json", import.meta.url), "utf8"),
    readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ]);
  const root = JSON.parse(rootPackage) as { scripts?: Record<string, string> };
  const platform = JSON.parse(platformPackage) as { scripts?: Record<string, string> };
  assert.equal(root.scripts?.test, "node --test");
  assert.match(platform.scripts?.typecheck ?? "", /workspaces foreach[\s\S]*typecheck/u);
  assert.match(platform.scripts?.test ?? "", /contracts build[\s\S]*workspaces foreach[\s\S]*test/u);
  assert.match(platform.scripts?.build ?? "", /workspaces foreach[\s\S]*build/u);
});
