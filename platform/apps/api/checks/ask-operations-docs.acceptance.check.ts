import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** ASK-AC-13 / PROV-AC-02..13: operator-facing setup and safety stay documented. */
test("ASK-AC-13: Provider operations use the Web control plane, encrypted Vault, and three-step API", async () => {
  const platformRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const [environment, cloudEnvironment, readme, security, runtime] = await Promise.all([
    readFile(new URL("../../../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../../../.env.cloud.example", import.meta.url), "utf8"),
    readFile(new URL("../../../README.md", import.meta.url), "utf8"),
    readFile(new URL("../../../docs/security-model.md", import.meta.url), "utf8"),
    readFile(new URL("../../../docs/runtime-contract.md", import.meta.url), "utf8"),
  ]);
  assert.ok(platformRoot.endsWith("platform/"));

  assert.doesNotMatch(environment, /AI_SDLC_ASK_/u);
  assert.doesNotMatch(cloudEnvironment, /AI_SDLC_ASK_/u);

  for (const provider of ["OpenAI", "LM Studio", "Ollama", "Custom"]) {
    assert.match(readme, new RegExp(provider.replace(" ", "\\s+"), "iu"), provider);
  }
  for (const protocol of ["OpenAI Responses", "OpenAI Chat", "Ollama Chat"]) {
    assert.match(readme, new RegExp(protocol, "iu"), protocol);
  }
  assert.match(readme, /yarn dev/u);
  assert.match(readme, /模型设置/u);
  assert.match(readme, /保存、测试并启用/u);
  assert.match(readme, /连接检查|connection check/iu);
  assert.match(readme, /认证|authentication/iu);
  assert.match(readme, /不可达|unreachable/iu);
  assert.match(readme, /模型.*不存在|missing models?/iu);
  assert.match(readme, /协议|protocol/iu);
  assert.match(readme, /不需要重启\s*API/iu);
  assert.match(readme, /加密\s*Vault/iu);
  assert.match(readme, /主密钥与密文分文件/u);
  for (const state of [
    "not_configured",
    "authentication_failed",
    "unreachable",
    "model_unavailable",
    "protocol_error",
  ]) {
    assert.match(readme, new RegExp(`\\b${state}\\b`, "u"), state);
  }
  assert.match(readme, /`GET \/api\/ask\/provider-configurations`/u);
  assert.match(readme, /`PUT \/api\/ask\/provider-configurations\/:providerId`/u);
  assert.match(readme, /`POST \/api\/ask\/provider-configurations\/:providerId\/check`/u);
  assert.match(readme, /`PATCH \/api\/ask\/provider-configurations\/:providerId\/enabled`/u);

  assert.match(security, /cannot override its endpoint, key or protocol|不能.*覆盖.*endpoint/iu);
  assert.match(security, /API keys?.*never|API keys?.*不会|密钥.*(?:永不|不会)/iu);
  assert.match(security, /Plain HTTP.*explicitly allowed|HTTP.*明确允许/iu);
  assert.match(security, /remote Provider endpoints require HTTPS|远程.*HTTPS/iu);
  assert.match(security, /authenticated encryption|认证加密/iu);
  assert.match(security, /fails closed|fail closed/iu);
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
