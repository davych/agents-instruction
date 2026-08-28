import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  askProviderConfigurationCheckSchema,
  askProviderConfigurationSchema,
} from "@ai-sdlc/contracts";
import type pg from "pg";

import { buildApp } from "../src/app.ts";
import { ProviderConfigurationService } from "../src/services/llm/provider-configuration-service.ts";

const ACCESS_TOKEN = "provider-configuration-api-acceptance-token";
const SECRET = "api-provider-secret-must-never-return";
const FULL_ENDPOINT = "http://127.0.0.1:43210/v1/private-tenant-route";

function responsePayload(body: Record<string, unknown>): Record<string, unknown> {
  const model = typeof body.model === "string" ? body.model : "api-model";
  return {
    object: "response",
    status: "completed",
    model,
    output_text: '{"ok":true}',
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: '{"ok":true}' }],
    }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

test("PROV-AC-02..08/12: authenticated three-step Provider API is CAS-safe and never returns endpoint or Secret", async () => {
  const managedRoot = await mkdtemp(path.join(os.tmpdir(), "provider-configuration-api-"));
  const service = await ProviderConfigurationService.create({ managedRoot });
  const app = await buildApp({
    pool: {} as pg.Pool,
    fakeCodex: true,
    accessToken: ACCESS_TOKEN,
    providerConfigurations: service,
  });
  const headers = { authorization: `Bearer ${ACCESS_TOKEN}` };
  const upstreamRequests: Array<{
    url: string;
    body: Record<string, unknown>;
    authorization: string | null;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    assert.equal(typeof init.body, "string");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    upstreamRequests.push({
      url: input instanceof Request ? input.url : input.toString(),
      body,
      authorization: new Headers(init.headers).get("authorization"),
    });
    return new Response(JSON.stringify(responsePayload(body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const configurationInput = {
    expectedVersion: 1,
    label: "API fixture",
    protocol: "openai-responses",
    model: "api-model",
    endpoint: { action: "replace", value: FULL_ENDPOINT },
    credential: { action: "replace", value: SECRET },
    structuredOutput: true,
    toolCalling: false,
    allowInsecureHttp: false,
  } as const;

  try {
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/ask/provider-configurations",
    });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.json().error.code, "AUTHENTICATION_REQUIRED");

    const listed = await app.inject({
      method: "GET",
      url: "/api/ask/provider-configurations",
      headers,
    });
    assert.equal(listed.statusCode, 200);
    const initialProviders = listed.json().providers as unknown[];
    assert.equal(initialProviders.length, 4);
    assert.deepEqual(
      initialProviders.map((value) => askProviderConfigurationSchema.parse(value).providerId),
      ["openai", "lmstudio", "ollama", "custom"],
    );
    assert.equal(
      initialProviders
        .map((value) => askProviderConfigurationSchema.parse(value))
        .find(({ providerId }) => providerId === "lmstudio")?.protocol,
      "openai-chat",
    );

    const unofficialOpenAi = await app.inject({
      method: "PUT",
      url: "/api/ask/provider-configurations/openai",
      headers,
      payload: {
        expectedVersion: 1,
        label: "OpenAI",
        protocol: "openai-responses",
        model: "gpt-test",
        endpoint: { action: "replace", value: "https://openai-proxy.example.test/v1" },
        credential: { action: "replace", value: SECRET },
        structuredOutput: true,
        toolCalling: true,
        allowInsecureHttp: false,
      },
    });
    assert.equal(unofficialOpenAi.statusCode, 422);
    assert.equal(
      unofficialOpenAi.json().error.code,
      "PROVIDER_OPENAI_ENDPOINT_NOT_OFFICIAL",
    );
    assertPublicResponse(unofficialOpenAi.body);

    const saved = await app.inject({
      method: "PUT",
      url: "/api/ask/provider-configurations/custom",
      headers,
      payload: configurationInput,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const savedProvider = askProviderConfigurationSchema.parse(saved.json().provider);
    assert.equal(savedProvider.providerId, "custom");
    assert.equal(savedProvider.version, 2);
    assert.equal(savedProvider.configVersion, 2);
    assert.equal(savedProvider.enabled, false);
    assert.equal(savedProvider.lastCheck, null);
    assert.equal(savedProvider.endpointLabel, "127.0.0.1:43210");
    assert.equal(savedProvider.hasCredential, true);
    assertPublicResponse(saved.body);

    const stale = await app.inject({
      method: "PUT",
      url: "/api/ask/provider-configurations/custom",
      headers,
      payload: { ...configurationInput, label: "stale browser" },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "PROVIDER_CONFIGURATION_VERSION_CONFLICT");
    assertPublicResponse(stale.body);

    const prematureEnable = await app.inject({
      method: "PATCH",
      url: "/api/ask/provider-configurations/custom/enabled",
      headers,
      payload: { expectedVersion: 2, enabled: true },
    });
    assert.equal(prematureEnable.statusCode, 409);
    assert.equal(prematureEnable.json().error.code, "PROVIDER_CONFIGURATION_NOT_READY");

    const checked = await app.inject({
      method: "POST",
      url: "/api/ask/provider-configurations/custom/check",
      headers,
      payload: { expectedVersion: 2 },
    });
    assert.equal(checked.statusCode, 200, checked.body);
    const check = askProviderConfigurationCheckSchema.parse(checked.json().check);
    assert.equal(check.providerId, "custom");
    assert.equal(check.version, 3);
    assert.equal(check.configVersion, 2);
    assert.equal(check.state, "ready");
    assertPublicResponse(checked.body);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0]?.url, `${FULL_ENDPOINT}/responses`);
    assert.equal(upstreamRequests[0]?.authorization, `Bearer ${SECRET}`);
    assert.deepEqual(upstreamRequests[0]?.body.input, [
      { role: "user", content: 'Return {"ok":true} now.' },
    ]);
    assert.doesNotMatch(JSON.stringify(upstreamRequests[0]?.body), /repository|DeepWiki|MCP|history/iu);

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/ask/provider-configurations/custom/enabled",
      headers,
      payload: { expectedVersion: check.version, enabled: true },
    });
    assert.equal(enabled.statusCode, 200, enabled.body);
    const enabledProvider = askProviderConfigurationSchema.parse(enabled.json().provider);
    assert.equal(enabledProvider.enabled, true);
    assert.equal(enabledProvider.version, 4);
    assert.equal(enabledProvider.configVersion, 2);
    assert.equal(enabledProvider.lastCheck?.configVersion, 2);
    assertPublicResponse(enabled.body);

    const staleToggle = await app.inject({
      method: "PATCH",
      url: "/api/ask/provider-configurations/custom/enabled",
      headers,
      payload: { expectedVersion: check.version, enabled: false },
    });
    assert.equal(staleToggle.statusCode, 409);
    assert.equal(staleToggle.json().error.code, "PROVIDER_CONFIGURATION_VERSION_CONFLICT");

    const edited = await app.inject({
      method: "PUT",
      url: "/api/ask/provider-configurations/custom",
      headers,
      payload: {
        ...configurationInput,
        expectedVersion: enabledProvider.version,
        model: "api-model-v2",
        endpoint: { action: "keep" },
        credential: { action: "keep" },
      },
    });
    assert.equal(edited.statusCode, 200, edited.body);
    const editedProvider = askProviderConfigurationSchema.parse(edited.json().provider);
    assert.equal(editedProvider.version, 5);
    assert.equal(editedProvider.configVersion, 3);
    assert.equal(editedProvider.enabled, false);
    assert.equal(editedProvider.lastCheck, null);
    assertPublicResponse(edited.body);

    const staleCheck = await app.inject({
      method: "POST",
      url: "/api/ask/provider-configurations/custom/check",
      headers,
      payload: { expectedVersion: 2 },
    });
    assert.equal(staleCheck.statusCode, 409);
    assert.equal(staleCheck.json().error.code, "PROVIDER_CONFIGURATION_VERSION_CONFLICT");

    const controlCharacterCredential = await app.inject({
      method: "PUT",
      url: "/api/ask/provider-configurations/custom",
      headers,
      payload: {
        ...configurationInput,
        expectedVersion: editedProvider.version,
        endpoint: { action: "keep" },
        credential: { action: "replace", value: "invalid\tcredential" },
      },
    });
    assert.equal(controlCharacterCredential.statusCode, 400);
    assert.equal(controlCharacterCredential.json().error.code, "VALIDATION_ERROR");

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/ask/provider-configurations/custom",
      headers,
      payload: {
        ...configurationInput,
        expectedVersion: editedProvider.version,
        apiKey: "browser-owned-secret",
        ciphertext: "browser-owned-ciphertext",
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "VALIDATION_ERROR");
    assert.doesNotMatch(
      invalid.body,
      new RegExp(`${SECRET}|${FULL_ENDPOINT}|browser-owned-secret|browser-owned-ciphertext`, "u"),
    );
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    await rm(managedRoot, { recursive: true, force: true });
  }
});

function assertPublicResponse(body: string): void {
  assert.equal(body.includes(SECRET), false);
  assert.equal(body.includes(FULL_ENDPOINT), false);
  assert.doesNotMatch(body, /private-tenant-route|authorization|ciphertext|authenticationTag/iu);
}
