import assert from "node:assert/strict";
import test from "node:test";

import type {
  AskProviderId,
  AskProviderStatusDto,
  WorkItemAdapterSummaryDto,
  WorkItemDraftDto,
} from "@ai-sdlc/contracts";

import { AppError } from "../src/domain/errors.ts";
import { AgentMcpToolRouter } from "../src/services/agent/mcp-tool-router.ts";
import { loadAskProviderConfigurations } from "../src/services/llm/config.ts";
import { OllamaChatProvider } from "../src/services/llm/ollama-chat-provider.ts";
import { OpenAiChatProvider } from "../src/services/llm/openai-chat-provider.ts";
import { OpenAiResponsesProvider } from "../src/services/llm/openai-responses-provider.ts";
import {
  createAskProviderRegistry,
  type AskProviderRegistry,
} from "../src/services/llm/provider-registry.ts";
import {
  AskProviderError,
  type AskLlmCompleteRequest,
  type AskLlmCompleteResponse,
} from "../src/services/llm/types.ts";
import type { WorkItemMcpRegistry } from "../src/services/work-item/work-item-mcp-registry.ts";

const TOOL_REQUEST: AskLlmCompleteRequest = {
  systemPrompt: "Only call the tool when the user supplied an issue reference.",
  messages: [{ role: "user", content: "Read ENG-142" }],
  tools: [{
    type: "function",
    name: "resolve_work_item",
    description: "Read one work item.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["adapterId", "reference", "reason"],
      properties: {
        adapterId: { type: "string" },
        reference: { type: "string" },
        reason: { type: "string" },
      },
    },
  }],
  toolChoice: "auto",
  maxOutputTokens: 256,
};

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function captureJsonFetch(responseBody: unknown): {
  calls: CapturedRequest[];
  fetchImpl: typeof fetch;
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    assert.equal(typeof init.body, "string");
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("native tool calls use each provider's documented wire shape and one normalized result", async (t) => {
  await t.test("OpenAI Responses", async () => {
    const capture = captureJsonFetch({
      status: "completed",
      model: "openai-model",
      output: [{
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "resolve_work_item",
        arguments: '{"adapterId":"jira","reference":"ENG-142","reason":"explicit"}',
      }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new OpenAiResponsesProvider({
      id: "openai",
      label: "OpenAI",
      protocol: "openai-responses",
      dataBoundary: "remote",
      baseUrl: new URL("https://api.example.test/v1"),
      model: "openai-model",
      structuredOutput: true,
      toolCalling: true,
      timeoutMs: 1_000,
      maxResponseBytes: 32_000,
      fetchImpl: capture.fetchImpl,
    });

    const response = await provider.complete({
      ...TOOL_REQUEST,
      toolChoice: { type: "function", name: "resolve_work_item" },
    });
    assert.equal(response.text, "");
    assert.deepEqual(response.toolCalls, [{
      id: "call_1",
      type: "function",
      name: "resolve_work_item",
      arguments: { adapterId: "jira", reference: "ENG-142", reason: "explicit" },
    }]);
    const body = capture.calls[0]!.body;
    assert.equal(capture.calls[0]!.url, "https://api.example.test/v1/responses");
    assert.equal((body.tools as Array<{ strict?: unknown }>)[0]?.strict, true);
    assert.deepEqual(body.tool_choice, { type: "function", name: "resolve_work_item" });
    assert.equal(body.parallel_tool_calls, false);
  });

  await t.test("OpenAI Chat compatibility", async () => {
    const capture = captureJsonFetch({
      model: "local-model",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "chat_call_1",
            type: "function",
            function: {
              name: "resolve_work_item",
              arguments: '{"adapterId":"linear","reference":"LIN-9","reason":"explicit"}',
            },
          }],
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
    const provider = new OpenAiChatProvider({
      id: "custom",
      label: "Compatible",
      protocol: "openai-chat",
      dataBoundary: "operator-configured",
      baseUrl: new URL("https://llm.example.test/v1"),
      model: "local-model",
      structuredOutput: false,
      toolCalling: true,
      timeoutMs: 1_000,
      maxResponseBytes: 32_000,
      fetchImpl: capture.fetchImpl,
    });

    const response = await provider.complete({
      ...TOOL_REQUEST,
      toolChoice: { type: "function", name: "resolve_work_item" },
    });
    assert.deepEqual(response.toolCalls?.[0], {
      id: "chat_call_1",
      type: "function",
      name: "resolve_work_item",
      arguments: { adapterId: "linear", reference: "LIN-9", reason: "explicit" },
    });
    const body = capture.calls[0]!.body;
    const tools = body.tools as Array<{ function?: { strict?: unknown } }>;
    assert.equal(tools[0]?.function?.strict, true);
    assert.deepEqual(body.tool_choice, {
      type: "function",
      function: { name: "resolve_work_item" },
    });
    assert.equal(body.parallel_tool_calls, false);
  });

  await t.test("LM Studio scopes a named tool intent to its supported required wire shape", async () => {
    const capture = captureJsonFetch({
      model: "openai/gpt-oss-20b",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "lmstudio_call_1",
            type: "function",
            function: {
              name: "resolve_work_item",
              arguments: '{"adapterId":"jira","reference":"ENG-142","reason":"explicit"}',
            },
          }],
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
    const provider = new OpenAiChatProvider({
      id: "lmstudio",
      label: "LM Studio",
      protocol: "openai-chat",
      dataBoundary: "local",
      baseUrl: new URL("http://127.0.0.1:1234/v1"),
      model: "openai/gpt-oss-20b",
      structuredOutput: false,
      toolCalling: true,
      timeoutMs: 1_000,
      maxResponseBytes: 32_000,
      fetchImpl: capture.fetchImpl,
    });

    const response = await provider.complete({
      ...TOOL_REQUEST,
      tools: [
        ...TOOL_REQUEST.tools!,
        {
          type: "function",
          name: "list_files",
          description: "List files.",
          strict: true,
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: { path: { type: "string" } },
          },
        },
      ],
      toolChoice: { type: "function", name: "resolve_work_item" },
    });

    assert.equal(response.toolCalls?.[0]?.name, "resolve_work_item");
    const body = capture.calls[0]!.body;
    assert.equal(body.tool_choice, "required");
    assert.deepEqual(
      (body.tools as Array<{ function?: { name?: unknown } }>).map(
        ({ function: definition }) => definition?.name,
      ),
      ["resolve_work_item"],
    );
    assert.equal(body.parallel_tool_calls, false);
  });

  await t.test("Ollama Chat", async () => {
    const capture = captureJsonFetch({
      model: "qwen3",
      done: true,
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          type: "function",
          function: {
            name: "resolve_work_item",
            arguments: { adapterId: "jira", reference: "ENG-142", reason: "explicit" },
          },
        }],
      },
      prompt_eval_count: 8,
      eval_count: 3,
    });
    const provider = new OllamaChatProvider({
      id: "ollama",
      label: "Ollama",
      protocol: "ollama-chat",
      dataBoundary: "local",
      baseUrl: new URL("http://127.0.0.1:11434"),
      model: "qwen3",
      structuredOutput: true,
      toolCalling: true,
      timeoutMs: 1_000,
      maxResponseBytes: 32_000,
      fetchImpl: capture.fetchImpl,
    });

    const response = await provider.complete(TOOL_REQUEST);
    assert.deepEqual(response.toolCalls?.[0], {
      id: null,
      type: "function",
      name: "resolve_work_item",
      arguments: { adapterId: "jira", reference: "ENG-142", reason: "explicit" },
    });
    const body = capture.calls[0]!.body;
    assert.equal(capture.calls[0]!.url, "http://127.0.0.1:11434/api/chat");
    assert.ok(Array.isArray(body.tools));
    assert.equal("tool_choice" in body, false, "Ollama does not document OpenAI tool_choice");
    assert.equal("strict" in ((body.tools as Array<{ function: object }>)[0]!.function), false);
  });
});

test("tool capability is truthful: OpenAI is native; local/compatible models require an opt-in", () => {
  const defaults = loadAskProviderConfigurations({
    AI_SDLC_ASK_OPENAI_API_KEY: "server-key",
    AI_SDLC_ASK_LM_STUDIO_MODEL: "local-model",
    AI_SDLC_ASK_OLLAMA_MODEL: "qwen3",
    AI_SDLC_ASK_CUSTOM_PROTOCOL: "openai-chat",
    AI_SDLC_ASK_CUSTOM_BASE_URL: "https://llm.example.test/v1",
    AI_SDLC_ASK_CUSTOM_MODEL: "custom-model",
  });
  assert.deepEqual(defaults.map(({ id, toolCalling }) => [id, toolCalling]), [
    ["openai", true],
    ["lmstudio", false],
    ["ollama", false],
    ["custom", false],
  ]);
  assert.deepEqual(
    createAskProviderRegistry(defaults).statuses()
      .map(({ id, capabilities }) => [id, capabilities.toolCalling]),
    [
      ["openai", true],
      ["lmstudio", false],
      ["ollama", false],
      ["custom", false],
    ],
  );

  const optedIn = loadAskProviderConfigurations({
    AI_SDLC_ASK_LM_STUDIO_MODEL: "local-model",
    AI_SDLC_ASK_LM_STUDIO_TOOL_CALLING: "1",
    AI_SDLC_ASK_OLLAMA_MODEL: "qwen3",
    AI_SDLC_ASK_OLLAMA_TOOL_CALLING: "1",
    AI_SDLC_ASK_CUSTOM_PROTOCOL: "openai-chat",
    AI_SDLC_ASK_CUSTOM_BASE_URL: "https://llm.example.test/v1",
    AI_SDLC_ASK_CUSTOM_MODEL: "custom-model",
    AI_SDLC_ASK_CUSTOM_TOOL_CALLING: "1",
  });
  assert.equal(optedIn.find(({ id }) => id === "lmstudio")?.options?.toolCalling, true);
  assert.equal(optedIn.find(({ id }) => id === "ollama")?.options?.toolCalling, true);
  assert.equal(optedIn.find(({ id }) => id === "custom")?.options?.toolCalling, true);
});

test("providers reject tools unless that concrete endpoint/model was configured for them", async () => {
  const provider = new OpenAiChatProvider({
    id: "custom",
    label: "Compatible",
    protocol: "openai-chat",
    dataBoundary: "operator-configured",
    baseUrl: new URL("https://llm.example.test/v1"),
    model: "local-model",
    structuredOutput: false,
    toolCalling: false,
    timeoutMs: 1_000,
    maxResponseBytes: 32_000,
    fetchImpl: captureJsonFetch({}).fetchImpl,
  });
  await assert.rejects(
    provider.complete(TOOL_REQUEST),
    (error: unknown) => error instanceof AskProviderError
      && error.code === "ASK_PROVIDER_REQUEST_INVALID",
  );
});

test("Ollama rejects required tool choice instead of pretending to enforce it", async () => {
  const provider = new OllamaChatProvider({
    id: "ollama",
    label: "Ollama",
    protocol: "ollama-chat",
    dataBoundary: "local",
    baseUrl: new URL("http://127.0.0.1:11434"),
    model: "qwen3",
    structuredOutput: true,
    toolCalling: true,
    timeoutMs: 1_000,
    maxResponseBytes: 32_000,
    fetchImpl: captureJsonFetch({}).fetchImpl,
  });
  await assert.rejects(
    provider.complete({ ...TOOL_REQUEST, toolChoice: "required" }),
    (error: unknown) => error instanceof AskProviderError
      && error.code === "ASK_PROVIDER_REQUEST_INVALID",
  );
});

test("malformed native arguments fail at the provider boundary before any router can execute them", async () => {
  const capture = captureJsonFetch({
    status: "completed",
    model: "openai-model",
    output: [{
      type: "function_call",
      call_id: "call_bad",
      name: "resolve_work_item",
      arguments: "{not-json",
    }],
    usage: {},
  });
  const provider = new OpenAiResponsesProvider({
    id: "openai",
    label: "OpenAI",
    protocol: "openai-responses",
    dataBoundary: "remote",
    baseUrl: new URL("https://api.example.test/v1"),
    model: "openai-model",
    structuredOutput: true,
    toolCalling: true,
    timeoutMs: 1_000,
    maxResponseBytes: 32_000,
    fetchImpl: capture.fetchImpl,
  });
  await assert.rejects(
    provider.complete(TOOL_REQUEST),
    (error: unknown) => error instanceof AskProviderError
      && error.code === "ASK_PROVIDER_PROTOCOL_ERROR",
  );
});

interface RouterProviderFixture {
  response: AskLlmCompleteResponse;
  capability?: boolean;
  calls: AskLlmCompleteRequest[];
}

function routerProvider(fixture: RouterProviderFixture): AskProviderRegistry {
  return {
    status(providerId: AskProviderId): AskProviderStatusDto {
      return {
        id: providerId,
        label: "fixture",
        configured: true,
        model: "fixture-model",
        protocol: providerId === "ollama"
          ? "ollama-chat"
          : providerId === "lmstudio"
            ? "openai-chat"
            : "openai-responses",
        dataBoundary: "local",
        endpointLabel: "fixture.test",
        capabilities: {
          streaming: false,
          structuredOutput: true,
          toolCalling: fixture.capability ?? true,
        },
        message: "ready",
      };
    },
    async complete(
      _providerId: AskProviderId,
      request: AskLlmCompleteRequest,
    ): Promise<AskLlmCompleteResponse> {
      fixture.calls.push(request);
      return fixture.response;
    },
  } as unknown as AskProviderRegistry;
}

const adapterSummaries: WorkItemAdapterSummaryDto[] = [
  { id: "jira", label: "Jira", kind: "mcp-stdio", configured: true, message: null },
  { id: "linear", label: "Linear", kind: "mcp-stdio", configured: true, message: null },
];

function routerAdapters(resolveCalls: Array<{ adapterId: string; reference: string }>): WorkItemMcpRegistry {
  return {
    summaries: () => adapterSummaries,
    async resolve(input: { adapterId: string; reference: string }): Promise<WorkItemDraftDto> {
      resolveCalls.push(input);
      return { title: "fixture" } as WorkItemDraftDto;
    },
  } as unknown as WorkItemMcpRegistry;
}

function toolResponse(calls: AskLlmCompleteResponse["toolCalls"]): AskLlmCompleteResponse {
  return {
    text: "",
    model: "fixture-model",
    usage: { inputTokens: null, outputTokens: null },
    ...(calls ? { toolCalls: calls } : {}),
  };
}

test("MCP router executes exactly one activated normalized call and never parses model text as a call", async () => {
  const providerCalls: AskLlmCompleteRequest[] = [];
  const resolveCalls: Array<{ adapterId: string; reference: string }> = [];
  const fixture: RouterProviderFixture = {
    calls: providerCalls,
    response: toolResponse([{
      id: "call_1",
      type: "function",
      name: "resolve_work_item",
      arguments: { adapterId: "jira", reference: "ENG-142", reason: "explicit reference" },
    }]),
  };
  const router = new AgentMcpToolRouter(routerProvider(fixture), routerAdapters(resolveCalls));

  const result = await router.resolveForTurn({
    providerId: "openai",
    content: "Read ENG-142",
    enabledAdapterIds: ["jira"],
  });
  assert.equal(result?.reference, "ENG-142");
  assert.deepEqual(resolveCalls, [{ adapterId: "jira", reference: "ENG-142" }]);
  assert.equal(providerCalls[0]?.jsonSchema, undefined);
  assert.equal(providerCalls[0]?.tools?.[0]?.name, "resolve_work_item");

  fixture.response = {
    text: '{"name":"resolve_work_item","arguments":{"adapterId":"jira"}}',
    model: "fixture-model",
    usage: { inputTokens: null, outputTokens: null },
  };
  const ignored = await router.resolveForTurn({
    providerId: "openai",
    content: "ordinary chat",
    enabledAdapterIds: ["jira"],
  });
  assert.equal(ignored, null, "model-authored text is never promoted into a tool call");
  assert.equal(resolveCalls.length, 1);
});

test("MCP router fails closed on multiple, malformed, unknown, or unactivated native calls", async (t) => {
  const validCall = {
    id: "call_1",
    type: "function" as const,
    name: "resolve_work_item",
    arguments: { adapterId: "jira", reference: "ENG-142", reason: "explicit" },
  };
  const cases: Array<{
    name: string;
    response: AskLlmCompleteResponse;
    code: string;
  }> = [
    {
      name: "multiple calls",
      response: toolResponse([validCall, { ...validCall, id: "call_2" }]),
      code: "AGENT_MCP_CHOICE_INVALID",
    },
    {
      name: "malformed arguments",
      response: toolResponse([{ ...validCall, arguments: { ...validCall.arguments, extra: true } }]),
      code: "AGENT_MCP_CHOICE_INVALID",
    },
    {
      name: "unknown function",
      response: toolResponse([{ ...validCall, name: "write_work_item" }]),
      code: "AGENT_MCP_CHOICE_INVALID",
    },
    {
      name: "unactivated adapter",
      response: toolResponse([{
        ...validCall,
        arguments: { adapterId: "linear", reference: "LIN-9", reason: "explicit" },
      }]),
      code: "AGENT_MCP_NOT_ACTIVATED",
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const resolveCalls: Array<{ adapterId: string; reference: string }> = [];
      const router = new AgentMcpToolRouter(routerProvider({
        calls: [],
        response: scenario.response,
      }), routerAdapters(resolveCalls));
      await assert.rejects(
        router.resolveForTurn({
          providerId: "openai",
          content: "Read a work item",
          enabledAdapterIds: ["jira"],
        }),
        (error: unknown) => error instanceof AppError && error.code === scenario.code,
      );
      assert.equal(resolveCalls.length, 0);
    });
  }
});

test("MCP router rejects a model-selected reference that is absent or only a prefix in the current message", async (t) => {
  for (const scenario of [
    {
      name: "hallucinated reference",
      content: "Read ENG-142",
      reference: "ENG-999",
    },
    {
      name: "prefix reference",
      content: "Read ENG-1420",
      reference: "ENG-142",
    },
    {
      name: "URL path prefix",
      content: "Read https://tracker.example.test/issues/123",
      reference: "https://tracker.example.test/issues",
    },
    {
      name: "URL query prefix",
      content: "Read https://tracker.example.test/issues/123?view=full",
      reference: "https://tracker.example.test/issues/123",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const resolveCalls: Array<{ adapterId: string; reference: string }> = [];
      const router = new AgentMcpToolRouter(routerProvider({
        calls: [],
        response: toolResponse([{
          id: "call_1",
          type: "function",
          name: "resolve_work_item",
          arguments: {
            adapterId: "jira",
            reference: scenario.reference,
            reason: "model-selected",
          },
        }]),
      }), routerAdapters(resolveCalls));

      await assert.rejects(
        router.resolveForTurn({
          providerId: "openai",
          content: scenario.content,
          enabledAdapterIds: ["jira"],
        }),
        (error: unknown) => error instanceof AppError
          && error.code === "AGENT_MCP_REFERENCE_NOT_IN_MESSAGE",
      );
      assert.equal(resolveCalls.length, 0, "the adapter must not execute after a reference mismatch");
    });
  }
});

test("MCP router accepts an exact URL followed by English or Chinese sentence punctuation", async (t) => {
  const reference = "https://tracker.example.test/issues/123";
  for (const scenario of [
    { name: "English period", content: `Read ${reference}.` },
    { name: "Chinese period", content: `请处理 ${reference}。随后跑测试` },
  ]) {
    await t.test(scenario.name, async () => {
      const resolveCalls: Array<{ adapterId: string; reference: string }> = [];
      const router = new AgentMcpToolRouter(routerProvider({
        calls: [],
        response: toolResponse([{
          id: "call_1",
          type: "function",
          name: "resolve_work_item",
          arguments: { adapterId: "jira", reference, reason: "explicit URL" },
        }]),
      }), routerAdapters(resolveCalls));

      const result = await router.resolveForTurn({
        providerId: "openai",
        content: scenario.content,
        enabledAdapterIds: ["jira"],
      });
      assert.equal(result?.reference, reference);
      assert.deepEqual(resolveCalls, [{ adapterId: "jira", reference }]);
    });
  }
});

test("MCP router does not offer tools when the selected provider has no advertised capability", async () => {
  const fixture: RouterProviderFixture = {
    calls: [],
    capability: false,
    response: toolResponse([]),
  };
  const router = new AgentMcpToolRouter(routerProvider(fixture), routerAdapters([]));
  assert.equal(await router.resolveForTurn({
    providerId: "custom",
    content: "Read ENG-142",
    enabledAdapterIds: ["jira"],
  }), null);
  assert.equal(fixture.calls.length, 0);
});
