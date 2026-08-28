import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AskProviderId,
  UpdateAskProviderConfigurationInput,
} from "@ai-sdlc/contracts";

import { AppError } from "../src/domain/errors.ts";
import {
  askAnswerJsonSchema,
  parseAndValidateAskAnswer,
} from "../src/services/ask/ask-answer.ts";
import { ProviderConfigurationService } from "../src/services/llm/provider-configuration-service.ts";
import { AskProviderError } from "../src/services/llm/types.ts";

const SECRET_A = "provider-service-secret-a";
const SECRET_B = "provider-service-secret-b";
const PRIVATE_PATH = "tenant-private-endpoint";
const ASK_RESPONSE_TEXT = JSON.stringify({
  answer: "项目入口由 [S1] 说明。",
  evidence: [{ sourceId: "S1", summary: "README 给出项目入口" }],
  uncertainties: [],
  suggestedQuestions: [],
  workItemDraft: null,
});

async function serviceFixture() {
  const managedRoot = await mkdtemp(path.join(os.tmpdir(), "provider-configuration-service-"));
  const service = await ProviderConfigurationService.create({ managedRoot });
  return {
    managedRoot,
    service,
    dispose: () => rm(managedRoot, { recursive: true, force: true }),
  };
}

function customUpdate(
  expectedVersion: number,
  patch: Partial<UpdateAskProviderConfigurationInput> = {},
): UpdateAskProviderConfigurationInput {
  return {
    expectedVersion,
    label: "Team endpoint",
    protocol: "openai-chat",
    model: "team-model",
    endpoint: { action: "replace", value: `https://llm.example.test/v1/${PRIVATE_PATH}` },
    credential: { action: "replace", value: SECRET_A },
    structuredOutput: false,
    toolCalling: false,
    allowInsecureHttp: false,
    ...patch,
  };
}

function lmStudioUpdate(
  expectedVersion: number,
  endpoint: string,
  patch: Partial<UpdateAskProviderConfigurationInput> = {},
): UpdateAskProviderConfigurationInput {
  return {
    expectedVersion,
    label: "LM Studio",
    protocol: "openai-chat",
    model: "local-model",
    endpoint: { action: "replace", value: endpoint },
    credential: { action: "clear" },
    structuredOutput: true,
    toolCalling: false,
    allowInsecureHttp: false,
    ...patch,
  };
}

function openAiUpdate(
  expectedVersion: number,
  endpoint: string,
): UpdateAskProviderConfigurationInput {
  return {
    expectedVersion,
    label: "OpenAI",
    protocol: "openai-responses",
    model: "gpt-test",
    endpoint: { action: "replace", value: endpoint },
    credential: { action: "replace", value: SECRET_A },
    structuredOutput: true,
    toolCalling: true,
    allowInsecureHttp: false,
  };
}

function hasAppError(error: unknown, code: string): boolean {
  return error instanceof AppError && error.code === code;
}

function publicJson(value: unknown): string {
  return JSON.stringify(value);
}

test("PROV-AC-02/04/05: four fixed slots expose sanitized keep/replace/clear semantics", async () => {
  const fixture = await serviceFixture();
  try {
    assert.deepEqual(
      fixture.service.list().map(({ providerId }) => providerId),
      ["openai", "lmstudio", "ollama", "custom"],
    );
    assert.equal(fixture.service.get("lmstudio").protocol, "openai-chat");

    const replaced = await fixture.service.update("custom", customUpdate(1));
    assert.equal(replaced.version, 2);
    assert.equal(replaced.configVersion, 2);
    assert.equal(replaced.enabled, false);
    assert.equal(replaced.lastCheck, null);
    assert.equal(replaced.hasEndpoint, true);
    assert.equal(replaced.hasCredential, true);
    assert.equal(replaced.endpointLabel, "llm.example.test");
    assert.doesNotMatch(publicJson(replaced), new RegExp(`${SECRET_A}|${PRIVATE_PATH}`, "u"));

    const keptOnSameOrigin = await fixture.service.update("custom", customUpdate(2, {
      endpoint: { action: "replace", value: "https://llm.example.test/v2/another-private-path" },
      credential: { action: "keep" },
      model: "team-model-v2",
    }));
    assert.equal(keptOnSameOrigin.version, 3);
    assert.equal(keptOnSameOrigin.hasCredential, true);

    await assert.rejects(
      () => fixture.service.update("custom", customUpdate(3, {
        endpoint: { action: "replace", value: "https://other-origin.example.test/v1" },
        credential: { action: "keep" },
      })),
      (error: unknown) => hasAppError(error, "PROVIDER_CREDENTIAL_ORIGIN_CHANGED"),
    );
    assert.equal(fixture.service.get("custom").version, 3, "rejected origin change is not persisted");

    const moved = await fixture.service.update("custom", customUpdate(3, {
      endpoint: { action: "replace", value: "https://other-origin.example.test/v1" },
      credential: { action: "replace", value: SECRET_B },
    }));
    assert.equal(moved.version, 4);
    assert.equal(moved.endpointLabel, "other-origin.example.test");
    assert.doesNotMatch(publicJson(moved), new RegExp(`${SECRET_A}|${SECRET_B}`, "u"));

    const cleared = await fixture.service.update("custom", customUpdate(4, {
      endpoint: { action: "clear" },
      credential: { action: "clear" },
      model: null,
    }));
    assert.equal(cleared.version, 5);
    assert.equal(cleared.configured, false);
    assert.equal(cleared.hasEndpoint, false);
    assert.equal(cleared.hasCredential, false);
    assert.equal(cleared.endpointLabel, "未配置");
  } finally {
    await fixture.dispose();
  }
});

test("PROV-AC-06: optimistic version serializes same-slot races without losing different-slot updates", async (t) => {
  await t.test("same slot: exactly one stale-page write wins", async () => {
    const fixture = await serviceFixture();
    try {
      const results = await Promise.allSettled([
        fixture.service.update("custom", customUpdate(1, { label: "Writer A" })),
        fixture.service.update("custom", customUpdate(1, { label: "Writer B" })),
      ]);
      assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
      const rejected = results.find(({ status }) => status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.equal(hasAppError(rejected.reason, "PROVIDER_CONFIGURATION_VERSION_CONFLICT"), true);
      const current = fixture.service.get("custom");
      assert.equal(current.version, 2);
      assert.ok(["Writer A", "Writer B"].includes(current.label));
    } finally {
      await fixture.dispose();
    }
  });

  await t.test("different slots: both serialized updates survive one encrypted document", async () => {
    const fixture = await serviceFixture();
    try {
      await Promise.all([
        fixture.service.update("custom", customUpdate(1)),
        fixture.service.update("lmstudio", lmStudioUpdate(1, "http://127.0.0.1:1234/v1")),
      ]);
      const reopened = await ProviderConfigurationService.create({ managedRoot: fixture.managedRoot });
      assert.equal(reopened.get("custom").version, 2);
      assert.equal(reopened.get("custom").model, "team-model");
      assert.equal(reopened.get("lmstudio").version, 2);
      assert.equal(reopened.get("lmstudio").model, "local-model");
    } finally {
      await fixture.dispose();
    }
  });
});

interface ProbeServer {
  origin: string;
  requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | undefined }>;
  release?: () => void;
  entered?: Promise<void>;
  close(): Promise<void>;
}

async function providerServer(
  responseFor: (
    body: Record<string, unknown>,
    index: number,
  ) => Record<string, unknown> | Promise<Record<string, unknown>> = compatibilityResponse,
): Promise<ProbeServer> {
  const requests: ProbeServer["requests"] = [];
  const originalFetch = globalThis.fetch;
  const origin = "http://127.0.0.1:43210";
  globalThis.fetch = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    assert.equal(typeof init.body, "string");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const headers = new Headers(init.headers);
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      body,
      authorization: headers.get("authorization") ?? undefined,
    });
    return new Response(JSON.stringify(await responseFor(body, requests.length - 1)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    origin,
    requests,
    close: async () => {
      assert.equal(globalThis.fetch === originalFetch, false, "fixture fetch was unexpectedly replaced");
      globalThis.fetch = originalFetch;
    },
  };
}

function compatibilityResponse(body: Record<string, unknown>): Record<string, unknown> {
  return chatCompletionResponse(body, '{"ok":true}');
}

function chatCompletionResponse(
  body: Record<string, unknown>,
  content: string,
): Record<string, unknown> {
  const model = typeof body.model === "string" ? body.model : "local-model";
  return {
    object: "chat.completion",
    model,
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content, tool_calls: [] },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

test("PROV-AC-06/07/08: save, check, enable, and an actual Ask-shaped answer all use LM Studio Chat", async () => {
  const upstream = await providerServer((body, index) => (
    chatCompletionResponse(body, index === 0 ? '{"ok":true}' : ASK_RESPONSE_TEXT)
  ));
  const fixture = await serviceFixture();
  try {
    const saved = await fixture.service.update(
      "lmstudio",
      lmStudioUpdate(1, `${upstream.origin}/v1`),
    );
    assert.equal(saved.version, 2);
    assert.equal(saved.enabled, false);
    assert.equal(saved.lastCheck, null);
    await assert.rejects(
      () => fixture.service.providers.complete("lmstudio", {
        systemPrompt: "test",
        messages: [{ role: "user", content: "test" }],
        maxOutputTokens: 8,
      }),
      (error: unknown) => error instanceof AskProviderError
        && error.code === "ASK_PROVIDER_NOT_CONFIGURED",
    );

    await assert.rejects(
      () => fixture.service.setEnabled("lmstudio", { expectedVersion: 2, enabled: true }),
      (error: unknown) => hasAppError(error, "PROVIDER_CONFIGURATION_NOT_READY"),
    );
    const check = await fixture.service.check("lmstudio", { expectedVersion: 2 });
    assert.equal(check.state, "ready");
    assert.equal(check.version, 3);
    assert.equal(check.configVersion, 2);
    assert.equal(upstream.requests[0]?.url, `${upstream.origin}/v1/chat/completions`);
    assert.equal(
      (upstream.requests[0]?.body.response_format as Record<string, unknown>).type,
      "json_schema",
    );
    assert.equal(fixture.service.get("lmstudio").version, 3, "a check is a CAS-protected record write");
    assert.equal(fixture.service.get("lmstudio").configVersion, 2);
    assert.equal(fixture.service.get("lmstudio").lastCheck?.configVersion, 2);

    const enabled = await fixture.service.setEnabled(
      "lmstudio",
      { expectedVersion: check.version, enabled: true },
    );
    assert.equal(enabled.version, 4, "enable is a CAS-protected record write");
    assert.equal(enabled.configVersion, 2, "enable does not manufacture a config version");
    assert.equal(enabled.enabled, true);

    const askResponse = await fixture.service.providers.complete("lmstudio", {
      systemPrompt: "只根据给定证据回答，并严格返回 Ask JSON。",
      messages: [{ role: "user", content: "项目入口在哪里？" }],
      jsonSchema: askAnswerJsonSchema as unknown as Record<string, unknown>,
      maxOutputTokens: 4_096,
    });
    const answer = parseAndValidateAskAnswer(askResponse.text, [{
      sourceId: "S1",
      path: "README.md",
      startLine: 1,
      endLine: 10,
      sha256: "a".repeat(64),
      revision: "b".repeat(40),
      excerpt: "项目入口说明",
    }]);
    assert.equal(answer.answer, "项目入口由 [S1] 说明。");
    assert.equal(answer.citations.length, 1);
    assert.equal(upstream.requests[1]?.url, `${upstream.origin}/v1/chat/completions`);
    assert.deepEqual(
      (
        upstream.requests[1]?.body.response_format as {
          json_schema?: { schema?: unknown };
        }
      ).json_schema?.schema,
      askAnswerJsonSchema,
    );
    assert.equal("text" in upstream.requests[1]!.body, false);
    assert.equal("input" in upstream.requests[1]!.body, false);
    assert.equal(
      upstream.requests.some(({ url }) => url.endsWith("/responses")),
      false,
      "LM Studio must not silently retry the Responses protocol",
    );

    const changed = await fixture.service.update("lmstudio", lmStudioUpdate(4, `${upstream.origin}/v1`, {
      model: "changed-model",
      endpoint: { action: "keep" },
      credential: { action: "keep" },
    }));
    assert.equal(changed.version, 5);
    assert.equal(changed.configVersion, 3);
    assert.equal(changed.enabled, false);
    assert.equal(changed.lastCheck, null);
    await assert.rejects(
      () => fixture.service.providers.complete("lmstudio", {
        systemPrompt: "test",
        messages: [{ role: "user", content: "test" }],
        maxOutputTokens: 8,
      }),
      (error: unknown) => error instanceof AskProviderError
        && error.code === "ASK_PROVIDER_NOT_CONFIGURED",
    );
  } finally {
    await upstream.close();
    await fixture.dispose();
  }
});

test("PROV-AC-06/07: enable and disable use record CAS so one stale tab cannot overwrite another", async () => {
  const upstream = await providerServer();
  const fixture = await serviceFixture();
  try {
    await fixture.service.update("lmstudio", lmStudioUpdate(1, `${upstream.origin}/v1`));
    const check = await fixture.service.check("lmstudio", { expectedVersion: 2 });
    assert.equal(check.version, 3);

    const results = await Promise.allSettled([
      fixture.service.setEnabled("lmstudio", { expectedVersion: check.version, enabled: true }),
      fixture.service.setEnabled("lmstudio", { expectedVersion: check.version, enabled: false }),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = results.find(({ status }) => status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.equal(hasAppError(rejected.reason, "PROVIDER_CONFIGURATION_VERSION_CONFLICT"), true);
    const current = fixture.service.get("lmstudio");
    assert.equal(current.version, 4);
    assert.equal(current.configVersion, 2);
  } finally {
    await upstream.close();
    await fixture.dispose();
  }
});

test("PROV-AC-02/07/08: an enabled Provider is restored from the Vault after API restart", async () => {
  const upstream = await providerServer();
  const fixture = await serviceFixture();
  try {
    await fixture.service.update("lmstudio", lmStudioUpdate(1, `${upstream.origin}/v1`));
    const check = await fixture.service.check("lmstudio", { expectedVersion: 2 });
    const enabled = await fixture.service.setEnabled("lmstudio", {
      expectedVersion: check.version,
      enabled: true,
    });
    assert.equal(enabled.version, 4);

    const restarted = await ProviderConfigurationService.create({
      managedRoot: fixture.managedRoot,
    });
    assert.equal(restarted.get("lmstudio").enabled, true);
    assert.equal(restarted.get("lmstudio").version, 4);
    assert.equal(restarted.providers.recordVersion("lmstudio"), 4);
    assert.equal(restarted.providers.status("lmstudio").configured, true);
    const completion = await restarted.providers.complete("lmstudio", {
      systemPrompt: "Return one small fixed answer.",
      messages: [{ role: "user", content: "health" }],
      maxOutputTokens: 8,
    });
    assert.equal(completion.model, "local-model");
    assert.equal(upstream.requests.at(-1)?.url, `${upstream.origin}/v1/chat/completions`);
  } finally {
    await upstream.close();
    await fixture.dispose();
  }
});

test("PROV-AC-04/13: the OpenAI slot keeps one platform-managed official API address", async () => {
  const fixture = await serviceFixture();
  try {
    await assert.rejects(
      () => fixture.service.update(
        "openai",
        openAiUpdate(1, "https://openai-proxy.example.test/v1"),
      ),
      (error: unknown) => hasAppError(error, "PROVIDER_OPENAI_ENDPOINT_NOT_OFFICIAL"),
    );
    assert.equal(fixture.service.get("openai").version, 1);

    await assert.rejects(
      () => fixture.service.update("openai", {
        ...openAiUpdate(1, "https://api.openai.com/v1"),
        endpoint: { action: "clear" },
        credential: { action: "clear" },
      }),
      (error: unknown) => hasAppError(error, "PROVIDER_OPENAI_ENDPOINT_MANAGED"),
    );
    assert.equal(fixture.service.get("openai").version, 1);

    const official = await fixture.service.update(
      "openai",
      openAiUpdate(1, "https://api.openai.com/v1"),
    );
    assert.equal(official.dataBoundary, "remote");
    assert.equal(official.endpointLabel, "api.openai.com");

    const compatible = await fixture.service.update("custom", customUpdate(1, {
      endpoint: { action: "replace", value: "https://openai-proxy.example.test/v1" },
    }));
    assert.equal(compatible.dataBoundary, "operator-configured");
  } finally {
    await fixture.dispose();
  }
});

test("PROV-AC-06/07: a delayed ready result cannot attach to or enable a newer saved config", async () => {
  let releaseCheck!: () => void;
  let markEntered!: () => void;
  const checkEntered = new Promise<void>((resolve) => { markEntered = resolve; });
  const checkGate = new Promise<void>((resolve) => { releaseCheck = resolve; });
  const upstream = await providerServer(async (body) => {
    markEntered();
    await checkGate;
    return compatibilityResponse(body);
  });
  const fixture = await serviceFixture();
  try {
    await fixture.service.update("lmstudio", lmStudioUpdate(1, `${upstream.origin}/v1`));
    const pendingCheck = fixture.service.check("lmstudio", { expectedVersion: 2 });
    await checkEntered;
    const changed = await fixture.service.update("lmstudio", lmStudioUpdate(2, `${upstream.origin}/v1`, {
      endpoint: { action: "keep" },
      credential: { action: "keep" },
      model: "newer-model",
    }));
    assert.equal(changed.version, 3);
    releaseCheck();
    await assert.rejects(
      () => pendingCheck,
      (error: unknown) => hasAppError(error, "PROVIDER_CONFIGURATION_VERSION_CONFLICT"),
    );
    const current = fixture.service.get("lmstudio");
    assert.equal(current.version, 3);
    assert.equal(current.lastCheck, null);
    assert.equal(current.enabled, false);
  } finally {
    releaseCheck();
    await upstream.close();
    await fixture.dispose();
  }
});

test("PROV-AC-05/13: literal high-risk endpoints are rejected without blocking trusted local endpoints", async (t) => {
  const rejectedEndpoints = [
    "https://169.254.169.254/latest/meta-data",
    "https://169.254.170.2/v2/credentials",
    "https://0.0.0.0/v1",
    "https://[::]/v1",
    "https://224.0.0.1/v1",
    "https://[ff02::1]/v1",
    "https://[::ffff:169.254.169.254]/latest/meta-data",
    "https://2852039166/latest/meta-data",
    "https://metadata.google.internal/computeMetadata/v1",
    "https://metadata.google.internal./computeMetadata/v1",
    "https://100.100.100.200/latest/meta-data",
    "https://[fd00:ec2::254]/latest/meta-data",
  ];

  for (const endpoint of rejectedEndpoints) {
    await t.test(`reject ${endpoint}`, async () => {
      const fixture = await serviceFixture();
      try {
        await assert.rejects(
          () => fixture.service.update("lmstudio", lmStudioUpdate(1, endpoint)),
          (error: unknown) => hasAppError(error, "PROVIDER_ENDPOINT_INVALID"),
        );
        assert.equal(fixture.service.get("lmstudio").version, 1);
      } finally {
        await fixture.dispose();
      }
    });
  }

  const accepted: Array<{
    name: string;
    endpoint: string;
    allowInsecureHttp: boolean;
  }> = [
    { name: "IPv4 loopback", endpoint: "http://127.0.0.1:1234/v1", allowInsecureHttp: false },
    { name: "localhost", endpoint: "http://localhost:1234/v1", allowInsecureHttp: false },
    { name: "IPv6 loopback", endpoint: "http://[::1]:1234/v1", allowInsecureHttp: false },
    {
      name: "explicit Docker host gateway",
      endpoint: "http://host.docker.internal:1234/v1",
      allowInsecureHttp: true,
    },
  ];
  for (const scenario of accepted) {
    await t.test(`accept ${scenario.name}`, async () => {
      const fixture = await serviceFixture();
      try {
        const saved = await fixture.service.update("lmstudio", lmStudioUpdate(1, scenario.endpoint, {
          allowInsecureHttp: scenario.allowInsecureHttp,
        }));
        assert.equal(saved.version, 2);
        assert.equal(saved.hasEndpoint, true);
      } finally {
        await fixture.dispose();
      }
    });
  }

  await t.test("host gateway still needs explicit insecure-HTTP consent", async () => {
    const fixture = await serviceFixture();
    try {
      await assert.rejects(
        () => fixture.service.update(
          "lmstudio",
          lmStudioUpdate(1, "http://host.docker.internal:1234/v1"),
        ),
        (error: unknown) => hasAppError(error, "PROVIDER_ENDPOINT_INVALID"),
      );
    } finally {
      await fixture.dispose();
    }
  });
});

type ToolProbeMode = "valid" | "wrong-arguments" | "no-call" | "multiple-calls";

function toolProbeResponse(
  body: Record<string, unknown>,
  mode: ToolProbeMode,
): Record<string, unknown> {
  const model = typeof body.model === "string" ? body.model : "local-model";
  if (mode === "no-call") {
    return {
      object: "chat.completion",
      model,
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "probe not called", tool_calls: [] },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
  }
  const oneCall = {
    id: "call_probe_1",
    type: "function",
    function: {
      name: "ai_sdlc_provider_probe",
      arguments: JSON.stringify(
        mode === "wrong-arguments"
          ? { ack: "wrong-value" }
          : { ack: "provider-check-v1" },
      ),
    },
  };
  return {
    object: "chat.completion",
    model,
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: mode === "multiple-calls"
          ? [oneCall, { ...oneCall, id: "call_probe_2" }]
          : [oneCall],
      },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

test("PROV-AC-07/12: toolCalling check requires exactly one fixed native probe and never executes it", async (t) => {
  for (const mode of ["valid", "wrong-arguments", "no-call", "multiple-calls"] as const) {
    await t.test(mode, async () => {
      const upstream = await providerServer((body, index) => (
        index === 0 ? compatibilityResponse(body) : toolProbeResponse(body, mode)
      ));
      const fixture = await serviceFixture();
      try {
        await fixture.service.update("lmstudio", lmStudioUpdate(1, `${upstream.origin}/v1`, {
          toolCalling: true,
        }));
        const check = await fixture.service.check("lmstudio", { expectedVersion: 2 });
        assert.equal(check.state, mode === "valid" ? "ready" : "protocol_error");
        assert.equal(upstream.requests.length, 2, "one JSON check plus exactly one tool-call probe");

        const jsonRequest = upstream.requests[0]!.body;
        assert.equal("tools" in jsonRequest, false);
        assert.equal(upstream.requests[0]!.url, `${upstream.origin}/v1/chat/completions`);
        assert.deepEqual(
          (jsonRequest.messages as Array<Record<string, unknown>>).at(-1),
          { role: "user", content: 'Return {"ok":true} now.' },
        );
        assert.equal(
          (jsonRequest.response_format as Record<string, unknown>).type,
          "json_schema",
        );

        const probeRequest = upstream.requests[1]!.body;
        const tools = probeRequest.tools as Array<{ function: Record<string, unknown> }>;
        assert.equal(tools.length, 1);
        assert.equal(tools[0]?.function.name, "ai_sdlc_provider_probe");
        assert.equal(tools[0]?.function.strict, true);
        assert.equal(probeRequest.tool_choice, "required");
        assert.equal(probeRequest.parallel_tool_calls, false);
        const parameters = tools[0]?.function.parameters as Record<string, unknown>;
        assert.equal(parameters.additionalProperties, false);
        assert.deepEqual(parameters.required, ["ack"]);
        assert.deepEqual(
          (parameters.properties as Record<string, Record<string, unknown>>).ack,
          { type: "string", const: "provider-check-v1" },
        );

        if (mode === "valid") {
          assert.equal(fixture.service.get("lmstudio").lastCheck?.state, "ready");
        } else {
          assert.match(check.message, /普通 Ask 和 DeepWiki 已通过基础检查/u);
          assert.match(check.message, /关闭“Agent 工具调用（可选）”/u);
          assert.equal(fixture.service.get("lmstudio").enabled, false);
          await assert.rejects(
            () => fixture.service.setEnabled("lmstudio", {
              expectedVersion: check.version,
              enabled: true,
            }),
            (error: unknown) => hasAppError(error, "PROVIDER_CONFIGURATION_NOT_READY"),
          );
        }
      } finally {
        await upstream.close();
        await fixture.dispose();
      }
    });
  }
});

// Compile-time guard: these are the only four mutable instance slots.
const _fixedProviderSlots: readonly AskProviderId[] = ["openai", "lmstudio", "ollama", "custom"];
void _fixedProviderSlots;
