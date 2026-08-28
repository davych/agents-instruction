import assert from "node:assert/strict";
import test from "node:test";

import {
  askProjectSchema,
  type AskProviderCheckDto,
  type AskProviderId,
  type AskProviderStatusDto,
} from "@ai-sdlc/contracts";
import type pg from "pg";

import { buildApp } from "../src/app.ts";
import {
  loadAskProviderConfigurations,
  parseAskProviderBaseUrl,
} from "../src/services/llm/config.ts";
import { postProviderJson } from "../src/services/llm/http.ts";
import { OllamaChatProvider } from "../src/services/llm/ollama-chat-provider.ts";
import { OpenAiChatProvider } from "../src/services/llm/openai-chat-provider.ts";
import { OpenAiResponsesProvider } from "../src/services/llm/openai-responses-provider.ts";
import {
  AskProviderRegistry,
  createAskProviderRegistry,
  createAskProviderRegistryFromEnv,
} from "../src/services/llm/provider-registry.ts";
import {
  AskProviderError,
  type AskConfiguredProviderOptions,
  type AskLlmCompleteRequest,
  type AskLlmCompleteResponse,
  type AskLlmProvider,
} from "../src/services/llm/types.ts";

/**
 * Independent acceptance tests (isolation Tier A): these assertions are derived
 * from ASK-AC-01..04/09 and the exported Provider/API contracts only.
 */

const COMPLETE_REQUEST: AskLlmCompleteRequest = {
  systemPrompt: "只根据给定证据回答。",
  messages: [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "继续说明" },
  ],
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" } },
  },
  maxOutputTokens: 321,
};

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function captureJsonFetch(
  responseBody: unknown,
  status = 200,
): { calls: CapturedRequest[]; fetchImpl: typeof fetch } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      init,
    });
    return new Response(
      typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function requestBody(call: CapturedRequest): Record<string, unknown> {
  assert.equal(call.init.method, "POST");
  assert.equal(typeof call.init.body, "string");
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

function headers(call: CapturedRequest): Headers {
  return new Headers(call.init.headers);
}

const responsesResult = (model: string): Record<string, unknown> => ({
  object: "response",
  status: "completed",
  model,
  output_text: "{\"answer\":\"ok\"}",
  output: [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "{\"answer\":\"ok\"}" }],
  }],
  usage: { input_tokens: 11, output_tokens: 7 },
});

const chatResult = (model: string): Record<string, unknown> => ({
  model,
  choices: [{ message: { role: "assistant", content: "{\"answer\":\"ok\"}" } }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
});

const ollamaResult = (model: string): Record<string, unknown> => ({
  model,
  done: true,
  message: { role: "assistant", content: "{\"answer\":\"ok\"}" },
  prompt_eval_count: 11,
  eval_count: 7,
});

test("ASK-AC-02/04: all four Provider registrations use their explicit wire protocol and one neutral result", async (t) => {
  await t.test("OpenAI uses POST /v1/responses with bounded structured output", async () => {
    const capture = captureJsonFetch(responsesResult("openai-model"));
    const provider = new OpenAiResponsesProvider({
      id: "openai",
      label: "OpenAI",
      protocol: "openai-responses",
      dataBoundary: "remote",
      baseUrl: new URL("https://api.example.test/v1"),
      model: "openai-model",
      structuredOutput: true,
      apiKey: "openai-key-marker",
      timeoutMs: 1_000,
      maxResponseBytes: 32_000,
      fetchImpl: capture.fetchImpl,
    });

    const result = await provider.complete(COMPLETE_REQUEST);
    assert.deepEqual(result, {
      text: "{\"answer\":\"ok\"}",
      model: "openai-model",
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0]?.url, "https://api.example.test/v1/responses");
    const body = requestBody(capture.calls[0]!);
    assert.equal(body.model, "openai-model");
    assert.equal(body.instructions, COMPLETE_REQUEST.systemPrompt);
    assert.deepEqual(body.input, COMPLETE_REQUEST.messages);
    assert.equal(body.max_output_tokens, COMPLETE_REQUEST.maxOutputTokens);
    assert.equal(body.store, false);
    assert.equal((body.text as { format?: { type?: string } }).format?.type, "json_schema");
    assert.equal(headers(capture.calls[0]!).get("authorization"), "Bearer openai-key-marker");
    assert.equal("tools" in body, false, "Ask must not grant model tools");
  });

  await t.test("LM Studio uses its OpenAI-compatible POST /v1/responses shape", async () => {
    const capture = captureJsonFetch(responsesResult("lm-model"));
    const provider = new OpenAiResponsesProvider({
      id: "lmstudio",
      label: "LM Studio",
      protocol: "openai-responses",
      dataBoundary: "local",
      baseUrl: new URL("http://127.0.0.1:1234/v1"),
      model: "lm-model",
      structuredOutput: true,
      timeoutMs: 1_000,
      maxResponseBytes: 32_000,
      fetchImpl: capture.fetchImpl,
    });

    const result = await provider.complete(COMPLETE_REQUEST);
    assert.equal(result.text, "{\"answer\":\"ok\"}");
    assert.equal(capture.calls[0]?.url, "http://127.0.0.1:1234/v1/responses");
    const body = requestBody(capture.calls[0]!);
    assert.equal(body.model, "lm-model");
    assert.equal(body.max_output_tokens, 321);
    assert.deepEqual(body.input, COMPLETE_REQUEST.messages);
    assert.equal(headers(capture.calls[0]!).has("authorization"), false);
  });

  await t.test("Ollama uses native POST /api/chat without streaming or model pulls", async () => {
    const capture = captureJsonFetch(ollamaResult("ollama-model"));
    const provider = new OllamaChatProvider({
      id: "ollama",
      label: "Ollama",
      protocol: "ollama-chat",
      dataBoundary: "local",
      baseUrl: new URL("http://127.0.0.1:11434"),
      model: "ollama-model",
      structuredOutput: true,
      timeoutMs: 1_000,
      maxResponseBytes: 32_000,
      fetchImpl: capture.fetchImpl,
    });

    const result = await provider.complete(COMPLETE_REQUEST);
    assert.equal(result.model, "ollama-model");
    assert.equal(capture.calls[0]?.url, "http://127.0.0.1:11434/api/chat");
    const body = requestBody(capture.calls[0]!);
    assert.equal(body.model, "ollama-model");
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [
      { role: "system", content: COMPLETE_REQUEST.systemPrompt },
      ...COMPLETE_REQUEST.messages,
    ]);
    assert.deepEqual(body.format, COMPLETE_REQUEST.jsonSchema);
    assert.equal((body.options as { num_predict?: number }).num_predict, 321);
    assert.equal("tools" in body, false, "Ask must not grant model tools");
  });

  await t.test("Custom openai-chat uses only the operator-selected compatibility shape", async () => {
    const capture = captureJsonFetch(chatResult("custom-model"));
    const provider = new OpenAiChatProvider({
      id: "custom",
      label: "Team endpoint",
      protocol: "openai-chat",
      dataBoundary: "operator-configured",
      baseUrl: new URL("https://llm.example.test/v1"),
      model: "custom-model",
      structuredOutput: false,
      apiKey: "custom-key-marker",
      timeoutMs: 1_000,
      maxResponseBytes: 32_000,
      fetchImpl: capture.fetchImpl,
    });

    const result = await provider.complete(COMPLETE_REQUEST);
    assert.equal(result.text, "{\"answer\":\"ok\"}");
    assert.equal(capture.calls[0]?.url, "https://llm.example.test/v1/chat/completions");
    const body = requestBody(capture.calls[0]!);
    assert.equal(body.model, "custom-model");
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [
      {
        role: "system",
        content: assertPromptIncludesJsonShape(body.messages),
      },
      ...COMPLETE_REQUEST.messages,
    ]);
    assert.equal(body.max_tokens, 321);
    assert.equal("response_format" in body, false, "unsupported JSON Schema must not be assumed");
    assert.equal(headers(capture.calls[0]!).get("authorization"), "Bearer custom-key-marker");
    assert.equal("tools" in body, false, "Ask must not grant model tools");
  });
});

test("ASK-AC-04: Responses accepts only a completed terminal status when status is present", async () => {
  for (const status of ["failed", "cancelled", "queued", "in_progress", "incomplete"]) {
    const response = responsesResult("reported-model");
    response.status = status;
    const provider = new OpenAiResponsesProvider({
      id: "openai",
      label: "OpenAI",
      protocol: "openai-responses",
      dataBoundary: "remote",
      baseUrl: new URL("https://api.example.test/v1"),
      model: "configured-model",
      structuredOutput: true,
      apiKey: "provider-key-secret",
      timeoutMs: 1_000,
      maxResponseBytes: 32_000,
      fetchImpl: captureJsonFetch(response).fetchImpl,
    });
    await assert.rejects(
      () => provider.complete(COMPLETE_REQUEST),
      (error: unknown) => error instanceof AskProviderError
        && error.code === "ASK_PROVIDER_PROTOCOL_ERROR"
        && !/provider-key-secret/u.test(error.message),
      `status ${status} must not be accepted even when output_text is present`,
    );
  }
});

test("ASK-AC-02/03: Provider adapters never present the requested model as an upstream-reported actual model", async (t) => {
  const withoutModel = (value: Record<string, unknown>): Record<string, unknown> => {
    const result = { ...value };
    delete result.model;
    return result;
  };
  const common = {
    label: "Protocol fixture",
    dataBoundary: "local" as const,
    model: "requested-model",
    structuredOutput: true,
    timeoutMs: 1_000,
    maxResponseBytes: 32_000,
  };

  const cases: Array<{ name: string; provider: AskLlmProvider }> = [
    {
      name: "OpenAI Responses",
      provider: new OpenAiResponsesProvider({
        ...common,
        id: "openai",
        protocol: "openai-responses",
        baseUrl: new URL("https://api.example.test/v1"),
        fetchImpl: captureJsonFetch(withoutModel(responsesResult("reported-model"))).fetchImpl,
      }),
    },
    {
      name: "OpenAI Chat compatibility",
      provider: new OpenAiChatProvider({
        ...common,
        id: "custom",
        protocol: "openai-chat",
        baseUrl: new URL("https://chat.example.test/v1"),
        fetchImpl: captureJsonFetch(withoutModel(chatResult("reported-model"))).fetchImpl,
      }),
    },
    {
      name: "Ollama Chat",
      provider: new OllamaChatProvider({
        ...common,
        id: "ollama",
        protocol: "ollama-chat",
        baseUrl: new URL("http://127.0.0.1:11434"),
        fetchImpl: captureJsonFetch(withoutModel(ollamaResult("reported-model"))).fetchImpl,
      }),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await assert.rejects(
        () => scenario.provider.complete(COMPLETE_REQUEST),
        (error: unknown) => error instanceof AskProviderError
          && error.code === "ASK_PROVIDER_PROTOCOL_ERROR"
          && /实际使用的模型/u.test(error.message),
      );
    });
  }

  await t.test("connection check exposes a different upstream-reported model", async () => {
    const checkResponse = responsesResult("served-model");
    checkResponse.output_text = '{"ok":true}';
    checkResponse.output = [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: '{"ok":true}' }],
    }];
    const provider = new OpenAiResponsesProvider({
      ...common,
      id: "openai",
      protocol: "openai-responses",
      baseUrl: new URL("https://api.example.test/v1"),
      fetchImpl: captureJsonFetch(checkResponse).fetchImpl,
    });

    const check = await provider.check();
    assert.equal(check.state, "ready");
    assert.equal(check.model, "served-model");
    assert.match(check.message, /请求模型：requested-model/u);
    assert.match(check.message, /上游报告模型：served-model/u);
  });
});

function assertPromptIncludesJsonShape(messages: unknown): string {
  assert.ok(Array.isArray(messages));
  const systemMessage = messages[0] as { role?: unknown; content?: unknown } | undefined;
  assert.equal(systemMessage?.role, "system");
  assert.equal(typeof systemMessage?.content, "string");
  assert.match(systemMessage.content, /只根据给定证据回答/u);
  assert.match(systemMessage.content, /"answer"/u);
  assert.match(systemMessage.content, /additionalProperties/u);
  return systemMessage.content;
}

class RecordingProvider implements AskLlmProvider {
  completeCalls = 0;

  constructor(
    readonly id: AskProviderId,
    private readonly failure?: AskProviderError,
  ) {}

  status(): AskProviderStatusDto {
    return {
      id: this.id,
      label: this.id,
      configured: true,
      model: `${this.id}-model`,
      protocol: this.id === "ollama" ? "ollama-chat" : "openai-responses",
      dataBoundary: this.id === "openai" ? "remote" : "local",
      endpointLabel: "synthetic.test",
      capabilities: { streaming: false, structuredOutput: true, toolCalling: false },
      message: "ready",
    };
  }

  async check(): Promise<AskProviderCheckDto> {
    return {
      providerId: this.id,
      state: "ready",
      model: `${this.id}-model`,
      message: "ready",
      checkedAt: new Date(0).toISOString(),
    };
  }

  async complete(): Promise<AskLlmCompleteResponse> {
    this.completeCalls += 1;
    if (this.failure) throw this.failure;
    return {
      text: "selected",
      model: `${this.id}-model`,
      usage: { inputTokens: null, outputTokens: null },
    };
  }
}

test("ASK-AC-02: a selected Provider failure never falls back to another Provider or model", async () => {
  const selectedFailure = new AskProviderError(
    "custom",
    "ASK_PROVIDER_UNREACHABLE",
    "所选模型服务不可达",
    "unreachable",
    502,
    true,
  );
  const providers = [
    new RecordingProvider("openai"),
    new RecordingProvider("lmstudio"),
    new RecordingProvider("ollama"),
    new RecordingProvider("custom", selectedFailure),
  ];
  const registry = new AskProviderRegistry(providers);

  await assert.rejects(
    () => registry.complete("custom", COMPLETE_REQUEST),
    (error: unknown) => error === selectedFailure,
  );
  assert.deepEqual(
    providers.map((provider) => provider.completeCalls),
    [0, 0, 0, 1],
  );

  const registryWithOnlyOpenAi = createAskProviderRegistryFromEnv({
    AI_SDLC_ASK_OPENAI_MODEL: "configured-openai-model",
    AI_SDLC_ASK_OPENAI_API_KEY: "configured-openai-key",
  });
  assert.equal(registryWithOnlyOpenAi.status("openai").configured, true);
  assert.equal(registryWithOnlyOpenAi.status("custom").configured, false);
  await assert.rejects(
    () => registryWithOnlyOpenAi.complete("custom", COMPLETE_REQUEST),
    (error: unknown) => error instanceof AskProviderError
      && error.providerId === "custom"
      && error.code === "ASK_PROVIDER_NOT_CONFIGURED",
    "a previously selected but now-unconfigured custom Provider must fail instead of using configured OpenAI",
  );
});

test("ASK-AC-01/04: server configuration exposes four sanitized statuses and rejects unsafe URL/key boundaries", async () => {
  const secretMarkers = [
    "openai-secret-marker",
    "lm-secret-marker",
    "custom-secret-marker",
  ];
  const configurations = loadAskProviderConfigurations({
    AI_SDLC_ASK_OPENAI_MODEL: "openai-model",
    AI_SDLC_ASK_OPENAI_API_KEY: secretMarkers[0],
    AI_SDLC_ASK_OPENAI_BASE_URL: "https://api.example.test/v1",
    AI_SDLC_ASK_LM_STUDIO_MODEL: "lm-model",
    AI_SDLC_ASK_LM_STUDIO_BASE_URL: "http://127.0.0.1:1234/v1",
    AI_SDLC_ASK_LM_STUDIO_API_KEY: secretMarkers[1],
    AI_SDLC_ASK_OLLAMA_MODEL: "ollama-model",
    AI_SDLC_ASK_OLLAMA_BASE_URL: "http://localhost:11434",
    AI_SDLC_ASK_CUSTOM_LABEL: "Team endpoint",
    AI_SDLC_ASK_CUSTOM_PROTOCOL: "openai-chat",
    AI_SDLC_ASK_CUSTOM_MODEL: "custom-model",
    AI_SDLC_ASK_CUSTOM_BASE_URL: "https://llm.example.test/v1",
    AI_SDLC_ASK_CUSTOM_API_KEY: secretMarkers[2],
  });
  const registry = createAskProviderRegistry(configurations);
  const statuses = registry.statuses();
  assert.deepEqual(statuses.map(({ id }) => id), ["openai", "lmstudio", "ollama", "custom"]);
  assert.equal(statuses.every(({ configured }) => configured), true);
  const publicJson = JSON.stringify(statuses);
  for (const secret of secretMarkers) assert.doesNotMatch(publicJson, new RegExp(secret, "u"));
  assert.doesNotMatch(publicJson, /apiKey|authorization/iu);

  assert.equal(parseAskProviderBaseUrl("http://127.0.0.1:1234/v1", "TEST").href, "http://127.0.0.1:1234/v1");
  assert.equal(parseAskProviderBaseUrl("https://llm.example.test/v1", "TEST").href, "https://llm.example.test/v1");
  assert.equal(
    parseAskProviderBaseUrl("http://host.docker.internal:1234/v1", "TEST", true).href,
    "http://host.docker.internal:1234/v1",
  );
  for (const unsafe of [
    "http://llm.example.test/v1",
    "ftp://127.0.0.1/model",
    "https://user:password@llm.example.test/v1",
    "https://llm.example.test/v1?api_key=secret",
    "https://llm.example.test/v1#secret",
  ]) {
    assert.throws(() => parseAskProviderBaseUrl(unsafe, "TEST"), unsafe);
  }

  const containerLocal = loadAskProviderConfigurations({
    AI_SDLC_ASK_LM_STUDIO_MODEL: "local-model",
    AI_SDLC_ASK_LM_STUDIO_BASE_URL: "http://host.docker.internal:1234/v1",
    AI_SDLC_ASK_LM_STUDIO_ALLOW_INSECURE_HTTP: "1",
  }).find(({ id }) => id === "lmstudio");
  assert.equal(containerLocal?.options?.baseUrl.href, "http://host.docker.internal:1234/v1");
  assert.equal(containerLocal?.dataBoundary, "operator-configured");
  assert.throws(() => loadAskProviderConfigurations({
    AI_SDLC_ASK_OLLAMA_MODEL: "local-model",
    AI_SDLC_ASK_OLLAMA_BASE_URL: "http://host.docker.internal:11434",
  }), /ALLOW_INSECURE_HTTP/u);

  const request = {
    providerId: "openai",
    question: "What does this project do?",
    history: [],
    baseUrl: "https://attacker.invalid/v1",
    apiKey: "browser-secret",
    protocol: "ollama-chat",
    model: "substitute-model",
  };
  assert.equal(askProjectSchema.safeParse(request).success, false);

  const app = await buildApp({
    pool: {} as pg.Pool,
    logger: false,
    askProviders: registry,
  });
  try {
    const providerResponse = await app.inject({ method: "GET", url: "/api/ask/providers" });
    assert.equal(providerResponse.statusCode, 200);
    assert.deepEqual(
      (providerResponse.json<{ providers: AskProviderStatusDto[] }>().providers).map(({ id }) => id),
      ["openai", "lmstudio", "ollama", "custom"],
    );
    for (const secret of secretMarkers) assert.doesNotMatch(providerResponse.body, new RegExp(secret, "u"));

    const askResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${crypto.randomUUID()}/ask`,
      payload: request,
    });
    assert.equal(askResponse.statusCode, 400);
    assert.equal(askResponse.json<{ error: { code: string } }>().error.code, "VALIDATION_ERROR");
    assert.doesNotMatch(askResponse.body, /browser-secret|attacker\.invalid|substitute-model/u);
  } finally {
    await app.close();
  }
});

test("ASK-AC-03/09: checks distinguish unavailable states and completion errors stay classified and sanitized", async (t) => {
  const unconfigured = createAskProviderRegistryFromEnv({});
  for (const providerId of ["openai", "lmstudio", "ollama", "custom"] as const) {
    const check = await unconfigured.check(providerId);
    assert.equal(check.state, "not_configured", providerId);
    assert.equal(check.providerId, providerId);
  }

  const cases: Array<{
    name: string;
    status?: number;
    response?: unknown;
    fetchError?: Error;
    checkState: AskProviderCheckDto["state"];
    errorCode: AskProviderError["code"];
  }> = [
    {
      name: "authentication failure",
      status: 401,
      response: { error: { message: "upstream-body-secret" } },
      checkState: "authentication_failed",
      errorCode: "ASK_PROVIDER_AUTHENTICATION_FAILED",
    },
    {
      name: "404 with an explicit model_not_found signal",
      status: 404,
      response: {
        error: {
          code: "model_not_found",
          message: "model configured-model not found upstream-body-secret",
        },
      },
      checkState: "model_unavailable",
      errorCode: "ASK_PROVIDER_MODEL_UNAVAILABLE",
    },
    {
      name: "400 with an explicit unknown_model signal",
      status: 400,
      response: {
        error: {
          code: "unknown_model",
          message: "unknown model configured-model upstream-body-secret",
        },
      },
      checkState: "model_unavailable",
      errorCode: "ASK_PROVIDER_MODEL_UNAVAILABLE",
    },
    {
      name: "generic 404 means a wrong endpoint or base URL, not a missing model",
      status: 404,
      response: {
        error: {
          code: "route_not_found",
          message: "unknown route upstream-body-secret",
        },
      },
      checkState: "protocol_error",
      errorCode: "ASK_PROVIDER_PROTOCOL_ERROR",
    },
    {
      name: "protocol error",
      status: 200,
      response: { unexpected: "upstream-body-secret" },
      checkState: "protocol_error",
      errorCode: "ASK_PROVIDER_PROTOCOL_ERROR",
    },
    {
      name: "unreachable endpoint",
      fetchError: new Error("socket failed with upstream-body-secret"),
      checkState: "unreachable",
      errorCode: "ASK_PROVIDER_UNREACHABLE",
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fetchImpl = scenario.fetchError
        ? (async () => { throw scenario.fetchError; }) as typeof fetch
        : captureJsonFetch(scenario.response, scenario.status).fetchImpl;
      const provider = new OpenAiResponsesProvider({
        id: "openai",
        label: "OpenAI",
        protocol: "openai-responses",
        dataBoundary: "remote",
        baseUrl: new URL("https://api.example.test/v1"),
        model: "configured-model",
        structuredOutput: true,
        apiKey: "provider-key-secret",
        timeoutMs: 1_000,
        maxResponseBytes: 32_000,
        fetchImpl,
      });

      const check = await provider.check();
      assert.equal(check.state, scenario.checkState);
      assert.doesNotMatch(JSON.stringify(check), /provider-key-secret|upstream-body-secret/u);

      await assert.rejects(
        () => provider.complete(COMPLETE_REQUEST),
        (error: unknown) => {
          assert.ok(error instanceof AskProviderError);
          assert.equal(error.code, scenario.errorCode);
          assert.doesNotMatch(`${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`, /provider-key-secret|upstream-body-secret/u);
          return true;
        },
      );
    });
  }

  const limited = captureJsonFetch({ error: { message: "rate-secret" } }, 429);
  const limitedProvider = new OpenAiResponsesProvider({
    id: "openai",
    label: "OpenAI",
    protocol: "openai-responses",
    dataBoundary: "remote",
    baseUrl: new URL("https://api.example.test/v1"),
    model: "configured-model",
    structuredOutput: true,
    apiKey: "provider-key-secret",
    timeoutMs: 1_000,
    maxResponseBytes: 32_000,
    fetchImpl: limited.fetchImpl,
  });
  await assert.rejects(
    () => limitedProvider.complete(COMPLETE_REQUEST),
    (error: unknown) => error instanceof AskProviderError
      && error.code === "ASK_PROVIDER_RATE_LIMITED"
      && !/rate-secret|provider-key-secret/u.test(error.message),
  );
});

function abortAwareNeverFetch(onSignal?: (signal: AbortSignal) => void): typeof fetch {
  return ((_input: string | URL | Request, init: RequestInit = {}) => {
    const signal = init.signal;
    assert.ok(signal);
    onSignal?.(signal);
    return new Promise<Response>((_resolve, reject) => {
      const rejectAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal.aborted) rejectAbort();
      else signal.addEventListener("abort", rejectAbort, { once: true });
    });
  }) as typeof fetch;
}

test("ASK-AC-04/09: Provider HTTP enforces caller cancellation, timeout, and maximum response bytes", async (t) => {
  await t.test("caller cancellation", async () => {
    const controller = new AbortController();
    let downstreamSignal: AbortSignal | undefined;
    const pending = postProviderJson({
      providerId: "openai",
      url: new URL("https://api.example.test/v1/responses"),
      body: {},
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
      signal: controller.signal,
      fetchImpl: abortAwareNeverFetch((signal) => { downstreamSignal = signal; }),
    });
    controller.abort(new Error("browser cancelled"));
    await assert.rejects(
      () => pending,
      (error: unknown) => error instanceof AskProviderError
        && error.code === "ASK_PROVIDER_CANCELLED",
    );
    assert.equal(downstreamSignal?.aborted, true);
  });

  await t.test("server timeout", async () => {
    let downstreamSignal: AbortSignal | undefined;
    await assert.rejects(
      () => postProviderJson({
        providerId: "openai",
        url: new URL("https://api.example.test/v1/responses"),
        body: {},
        timeoutMs: 15,
        maxResponseBytes: 1_024,
        fetchImpl: abortAwareNeverFetch((signal) => { downstreamSignal = signal; }),
      }),
      (error: unknown) => error instanceof AskProviderError
        && error.code === "ASK_PROVIDER_TIMEOUT",
    );
    assert.equal(downstreamSignal?.aborted, true);
  });

  await t.test("response byte ceiling", async () => {
    const oversizedFetch = (async () => new Response(
      JSON.stringify({ text: "x".repeat(2_048) }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
    await assert.rejects(
      () => postProviderJson({
        providerId: "openai",
        url: new URL("https://api.example.test/v1/responses"),
        body: {},
        timeoutMs: 1_000,
        maxResponseBytes: 64,
        fetchImpl: oversizedFetch,
      }),
      (error: unknown) => error instanceof AskProviderError
        && error.code === "ASK_PROVIDER_RESPONSE_TOO_LARGE",
    );
  });
});
