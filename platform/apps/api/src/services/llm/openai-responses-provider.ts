import type {
  AskProviderCheckDto,
  AskProviderStatusDto,
} from "@ai-sdlc/contracts";

import {
  bearerHeaders,
  configuredStatus,
  postProviderJson,
  PROVIDER_CHECK_REQUEST,
  protocolError,
  providerEndpoint,
  responseModel,
  runProviderCheck,
  tokenCount,
} from "./http.js";
import {
  assertCompleteRequest,
  assertToolCallingConfigured,
  normalizedToolArguments,
  normalizedToolCallIdentity,
  type AskConfiguredProviderOptions,
  type AskLlmCompleteRequest,
  type AskLlmCompleteResponse,
  type AskLlmProvider,
  type AskLlmToolCall,
  type AskLlmToolChoice,
} from "./types.js";

type OpenAiResponsesOptions = AskConfiguredProviderOptions & {
  protocol: "openai-responses";
};

export class OpenAiResponsesProvider implements AskLlmProvider {
  readonly id;

  constructor(private readonly options: OpenAiResponsesOptions) {
    this.id = options.id;
  }

  status(): AskProviderStatusDto {
    return configuredStatus(this.options);
  }

  async check(signal?: AbortSignal): Promise<AskProviderCheckDto> {
    return runProviderCheck(
      this.id,
      this.options.model,
      () => this.complete(PROVIDER_CHECK_REQUEST, signal),
    );
  }

  async complete(
    request: AskLlmCompleteRequest,
    signal?: AbortSignal,
  ): Promise<AskLlmCompleteResponse> {
    assertCompleteRequest(this.id, request);
    assertToolCallingConfigured(this.id, this.options.toolCalling, request);
    const body: Record<string, unknown> = {
      model: this.options.model,
      instructions: request.systemPrompt,
      input: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      max_output_tokens: request.maxOutputTokens,
      store: false,
    };
    if (request.jsonSchema) {
      body.text = {
        format: {
          type: "json_schema",
          name: "ask_answer",
          strict: true,
          schema: request.jsonSchema,
        },
      };
    }
    if (request.tools) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: true,
      }));
      if (request.toolChoice !== undefined) {
        body.tool_choice = responsesToolChoice(request.toolChoice);
      }
      // The caller decides whether parallel calls are acceptable. The first
      // agent bridge deliberately requests exactly one call.
      body.parallel_tool_calls = false;
    }

    const raw = await postProviderJson({
      providerId: this.id,
      url: providerEndpoint(this.options.baseUrl, "responses"),
      body,
      headers: bearerHeaders(this.options.apiKey),
      timeoutMs: this.options.timeoutMs,
      maxResponseBytes: this.options.maxResponseBytes,
      signal,
      fetchImpl: this.options.fetchImpl,
    });
    return parseResponsesResult(this.id, raw);
  }
}

function parseResponsesResult(
  providerId: OpenAiResponsesOptions["id"],
  raw: unknown,
): AskLlmCompleteResponse {
  if (!isRecord(raw)) {
    throw protocolError(providerId, "模型服务返回了无法识别的 Responses 结构");
  }
  if (raw.status !== undefined && raw.status !== "completed") {
    throw protocolError(
      providerId,
      raw.status === "incomplete"
        ? "模型回答未完成，请提高输出上限后重试"
        : "模型服务没有返回已完成的回答",
    );
  }

  const text = responsesText(raw);
  const toolCalls = responsesToolCalls(providerId, raw);
  if (!text && toolCalls.length === 0) {
    throw protocolError(providerId, "模型服务没有返回可用文本或原生工具调用");
  }
  const usage = isRecord(raw.usage) ? raw.usage : {};
  const result: AskLlmCompleteResponse = {
    text,
    model: responseModel(providerId, raw.model),
    usage: {
      inputTokens: tokenCount(usage.input_tokens),
      outputTokens: tokenCount(usage.output_tokens),
    },
  };
  if (toolCalls.length > 0) result.toolCalls = toolCalls;
  return result;
}

function responsesToolChoice(choice: AskLlmToolChoice): unknown {
  return typeof choice === "string"
    ? choice
    : { type: "function", name: choice.name };
}

function responsesToolCalls(
  providerId: OpenAiResponsesOptions["id"],
  response: Record<string, unknown>,
): AskLlmToolCall[] {
  if (response.output === undefined) return [];
  if (!Array.isArray(response.output)) {
    throw protocolError(providerId, "模型服务返回了无法识别的 Responses output");
  }
  const calls: AskLlmToolCall[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || item.type !== "function_call") continue;
    const identity = normalizedToolCallIdentity(providerId, {
      id: item.call_id ?? item.id,
      name: item.name,
    });
    calls.push({
      id: identity.id,
      type: "function",
      name: identity.name,
      arguments: normalizedToolArguments(providerId, item.arguments),
    });
  }
  return calls;
}

function responsesText(response: Record<string, unknown>): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  if (!Array.isArray(response.output)) return "";
  const parts: string[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content)) continue;
      if (
        (content.type === "output_text" || content.type === "text")
        && typeof content.text === "string"
        && content.text.trim()
      ) {
        parts.push(content.text.trim());
      } else if (
        content.type === "refusal"
        && typeof content.refusal === "string"
        && content.refusal.trim()
      ) {
        parts.push(content.refusal.trim());
      }
    }
  }
  return parts.join("\n").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
