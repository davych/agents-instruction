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
  AskProviderError,
  assertCompleteRequest,
  assertToolCallingConfigured,
  normalizedToolArguments,
  normalizedToolCallIdentity,
  type AskConfiguredProviderOptions,
  type AskLlmCompleteRequest,
  type AskLlmCompleteResponse,
  type AskLlmProvider,
  type AskLlmToolCall,
} from "./types.js";

type OllamaChatOptions = AskConfiguredProviderOptions & {
  protocol: "ollama-chat";
};

export class OllamaChatProvider implements AskLlmProvider {
  readonly id;

  constructor(private readonly options: OllamaChatOptions) {
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
    if (
      request.tools
      && (typeof request.toolChoice === "object" || request.toolChoice === "required")
    ) {
      throw new AskProviderError(
        this.id,
        "ASK_PROVIDER_REQUEST_INVALID",
        "Ollama Chat API 不支持强制 tool_choice",
        "protocol_error",
        500,
        false,
      );
    }
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: [
        { role: "system", content: request.systemPrompt },
        ...request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
      stream: false,
      options: { num_predict: request.maxOutputTokens },
    };
    if (request.jsonSchema) body.format = request.jsonSchema;
    // Ollama documents native `tools`, but not OpenAI's `tool_choice` field.
    // `none` is implemented safely by withholding all tool definitions.
    if (request.tools && request.toolChoice !== "none") {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    const raw = await postProviderJson({
      providerId: this.id,
      url: providerEndpoint(this.options.baseUrl, "api/chat"),
      body,
      headers: bearerHeaders(this.options.apiKey),
      timeoutMs: this.options.timeoutMs,
      maxResponseBytes: this.options.maxResponseBytes,
      signal,
      fetchImpl: this.options.fetchImpl,
    });
    return parseOllamaResult(this.id, raw);
  }
}

function parseOllamaResult(
  providerId: OllamaChatOptions["id"],
  raw: unknown,
): AskLlmCompleteResponse {
  if (!isRecord(raw) || !isRecord(raw.message)) {
    throw protocolError(providerId, "模型服务返回了无法识别的 Ollama Chat 结构");
  }
  const text = typeof raw.message.content === "string" ? raw.message.content.trim() : "";
  const toolCalls = ollamaToolCalls(providerId, raw.message);
  if (!text && toolCalls.length === 0) {
    throw protocolError(providerId, "模型服务没有返回可用文本或原生工具调用");
  }
  const result: AskLlmCompleteResponse = {
    text,
    model: responseModel(providerId, raw.model),
    usage: {
      inputTokens: tokenCount(raw.prompt_eval_count),
      outputTokens: tokenCount(raw.eval_count),
    },
  };
  if (toolCalls.length > 0) result.toolCalls = toolCalls;
  return result;
}

function ollamaToolCalls(
  providerId: OllamaChatOptions["id"],
  message: Record<string, unknown>,
): AskLlmToolCall[] {
  if (message.tool_calls === undefined) return [];
  if (!Array.isArray(message.tool_calls)) {
    throw protocolError(providerId, "模型服务返回了无法识别的 Ollama tool_calls");
  }
  return message.tool_calls.map((candidate) => {
    if (!isRecord(candidate) || candidate.type !== "function" || !isRecord(candidate.function)) {
      throw protocolError(providerId, "模型服务返回了无法验证的原生工具调用");
    }
    const identity = normalizedToolCallIdentity(providerId, {
      id: candidate.id,
      name: candidate.function.name,
    });
    return {
      id: identity.id,
      type: "function" as const,
      name: identity.name,
      arguments: normalizedToolArguments(providerId, candidate.function.arguments),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
