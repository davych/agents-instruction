import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checksDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(checksDirectory, "../src");

test("PROV-AC-02/09: production uses the Managed Root Vault and pins Ask, DeepWiki, and Agent turns", async () => {
  const [server, app, ask, deepWiki, agent, providerConfiguration] = await Promise.all([
    readFile(path.join(sourceRoot, "server.ts"), "utf8"),
    readFile(path.join(sourceRoot, "app.ts"), "utf8"),
    readFile(path.join(sourceRoot, "services/ask/ask-service.ts"), "utf8"),
    readFile(path.join(sourceRoot, "services/agent/deepwiki-generation-service.ts"), "utf8"),
    readFile(path.join(sourceRoot, "services/agent/agent-session-service.ts"), "utf8"),
    readFile(path.join(sourceRoot, "services/llm/provider-configuration-service.ts"), "utf8"),
  ]);

  assert.match(server, /ProviderConfigurationService\.create\(\{\s*managedRoot:/su);
  assert.match(server, /providerConfigurations,/u);
  assert.doesNotMatch(server, /createAskProviderRegistryFromEnv/u);
  assert.doesNotMatch(server, /AI_SDLC_ASK_/u);
  assert.match(
    app,
    /const providers = providerConfigurations\?\.providers\s*\?\?\s*options\.askProviders/u,
  );

  // These source assertions complement the behavioral AsyncLocalStorage test:
  // they make omission at any production entry point visible without needing a
  // real repository, PostgreSQL, or model endpoint.
  assert.match(ask, /runWithProvider\(\s*input\.providerId,/su);
  assert.match(deepWiki, /runWithProvider\(\s*providerId,/su);
  assert.match(agent, /runWithProvider\(\s*userMessage\.providerId,/su);
  assert.match(providerConfiguration, /PROVIDER_CHECK_TIMEOUT_MS\s*=\s*60_000/u);
  assert.match(providerConfiguration, /PROVIDER_ACTIVE_TIMEOUT_MS\s*=\s*180_000/u);
  assert.match(
    providerConfiguration,
    /timeoutMs:\s*use\s*===\s*"active"\s*\?\s*PROVIDER_ACTIVE_TIMEOUT_MS\s*:\s*PROVIDER_CHECK_TIMEOUT_MS/su,
    "real Agent turns must not inherit the shorter compatibility-probe timeout",
  );
});
