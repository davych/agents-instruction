import assert from "node:assert/strict";
import test from "node:test";

import {
  currentProviderCheck,
  providerCardActions,
  providerSelectionState,
  providerWriteOnlyUpdates,
} from "../src/lib/provider-settings.ts";
import type {
  AskProviderConfiguration,
  AskProviderConfigurationCheck,
  AskProviderStatus,
} from "../src/lib/types.ts";

const runtimeProvider = (id: AskProviderStatus["id"], configured: boolean): AskProviderStatus => ({
  id,
  label: id,
  configured,
  model: configured ? `${id}-model` : null,
  protocol: id === "ollama"
    ? "ollama-chat"
    : id === "lmstudio"
      ? "openai-chat"
      : "openai-responses",
  dataBoundary: id === "openai" ? "remote" : "local",
  endpointLabel: configured ? `${id}.example` : "未配置",
  capabilities: { streaming: configured, structuredOutput: configured, toolCalling: configured },
  message: configured ? "已配置并启用" : "已停用",
});

const check = (overrides: Partial<AskProviderConfigurationCheck> = {}): AskProviderConfigurationCheck => ({
  providerId: "custom",
  state: "ready",
  model: "custom-model",
  message: "连接可用",
  checkedAt: "2026-08-28T10:00:00.000Z",
  version: 8,
  configVersion: 4,
  ...overrides,
});

const configuration = (overrides: Partial<AskProviderConfiguration> = {}): AskProviderConfiguration => ({
  providerId: "custom",
  label: "Custom",
  enabled: false,
  configured: true,
  model: "custom-model",
  protocol: "openai-responses",
  dataBoundary: "operator-configured",
  endpointLabel: "models.example",
  hasEndpoint: true,
  hasCredential: true,
  structuredOutput: true,
  toolCalling: true,
  allowInsecureHttp: false,
  version: 8,
  configVersion: 4,
  lastCheck: null,
  createdAt: "2026-08-28T09:00:00.000Z",
  updatedAt: "2026-08-28T10:00:00.000Z",
  ...overrides,
});

test("LM Studio runtime fixtures use its fixed Chat Completions protocol", () => {
  assert.equal(runtimeProvider("lmstudio", true).protocol, "openai-chat");
});

test("a migrated LM Studio configuration keeps its write-only endpoint and credential", () => {
  const migrated = configuration({
    providerId: "lmstudio",
    label: "LM Studio",
    protocol: "openai-chat",
    enabled: false,
    hasEndpoint: true,
    hasCredential: true,
  });

  assert.deepEqual(providerWriteOnlyUpdates(migrated, {
    endpointDraft: "",
    credentialDraft: "",
    clearEndpoint: false,
    clearCredential: false,
  }), {
    endpoint: { action: "keep" },
    credential: { action: "keep" },
  });
});

test("a persisted disabled Provider stays selected but requires an explicit replacement", () => {
  const state = providerSelectionState("custom", [
    runtimeProvider("openai", true),
    runtimeProvider("custom", false),
  ]);

  assert.equal(state.selectedProvider?.id, "custom");
  assert.equal(state.selectedAvailable, false);
  assert.equal(state.requiresSelection, true);
  assert.deepEqual(state.availableProviders.map(({ id }) => id), ["openai"]);

  const replaced = providerSelectionState("openai", [
    runtimeProvider("openai", true),
    runtimeProvider("custom", false),
  ]);
  assert.equal(replaced.selectedAvailable, true);
  assert.equal(replaced.requiresSelection, false);
});

test("only a ready check for the current configVersion can enable a Provider", () => {
  const provider = configuration();
  const current = check();
  assert.equal(currentProviderCheck(provider, current), current);
  assert.deepEqual(providerCardActions(provider, current), {
    check: current,
    canCheck: true,
    canEnable: true,
    canDisable: false,
    expectedEnableVersion: 8,
  });

  const stale = check({ configVersion: 3, version: 7 });
  assert.equal(currentProviderCheck(provider, stale), null);
  assert.equal(providerCardActions(provider, stale).canEnable, false);

  const unavailable = check({ state: "unreachable", message: "连接失败" });
  assert.equal(providerCardActions(provider, unavailable).canEnable, false);
});

test("an enabled Provider can be disabled but cannot be redundantly enabled", () => {
  const provider = configuration({ enabled: true, lastCheck: check() });
  const actions = providerCardActions(provider);
  assert.equal(actions.canEnable, false);
  assert.equal(actions.canDisable, true);
  assert.equal(actions.expectedEnableVersion, null);
});

test("enable uses the newest version known by either the refreshed card or its check", () => {
  assert.equal(
    providerCardActions(configuration({ version: 7 }), check({ version: 8 })).expectedEnableVersion,
    8,
  );
  assert.equal(
    providerCardActions(configuration({ version: 9 }), check({ version: 8 })).expectedEnableVersion,
    9,
  );
});

test("a newer persisted failed check overrides an older local ready result", () => {
  const oldReady = check({ version: 8, state: "ready" });
  const newerFailure = check({ version: 9, state: "authentication_failed", message: "认证失败" });
  const refreshed = configuration({ version: 9, lastCheck: newerFailure });

  assert.equal(currentProviderCheck(refreshed, oldReady), newerFailure);
  assert.equal(providerCardActions(refreshed, oldReady).canEnable, false);

  const justReturned = check({ version: 10, state: "ready" });
  assert.equal(currentProviderCheck(refreshed, justReturned), justReturned);
  assert.equal(providerCardActions(refreshed, justReturned).expectedEnableVersion, 10);
});
