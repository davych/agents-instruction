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

type OpenAiChatOptions = AskConfiguredProviderOptions & {
  protocol: "openai-chat";
};

export class OpenAiChatProvider implements AskLlmProvider {
  readonly id;

  constructor(private readonly options: OpenAiChatOptions) {
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
    const systemPrompt = request.jsonSchema && !this.options.structuredOutput
      ? promptWithJsonSchema(this.id, request.systemPrompt, request.jsonSchema)
      : request.systemPrompt;
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: [
        { role: "system", content: systemPrompt },
        ...request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
      max_tokens: request.maxOutputTokens,
      stream: false,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    // LM Studio's MLX runtime can let unbounded GPT-OSS reasoning escape a
    // constrained JSON answer even when response_format is valid. Default
    // short machine contracts to low, while callers may explicitly give a
    // real task contract a bounded medium budget. Limit the compatibility hint
    // to the known model family so unrelated endpoints never receive it.
    if (
      this.id === "lmstudio"
      && this.options.model.toLowerCase().includes("gpt-oss")
      && (request.jsonSchema !== undefined || request.reasoningEffort !== undefined)
    ) {
      body.reasoning_effort = request.reasoningEffort ?? "low";
    }
    if (request.jsonSchema && this.options.structuredOutput) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "ask_answer",
          strict: true,
          schema: request.jsonSchema,
        },
      };
    }
    if (request.tools) {
      // LM Studio supports the string tool-choice modes but currently rejects
      // OpenAI's named-function object. Preserve the provider-neutral named
      // intent by exposing only that function and requiring a tool call. The
      // agent runtime independently verifies the returned function name before
      // executing it.
      const lmStudioNamedTool = this.id === "lmstudio"
        && typeof request.toolChoice === "object"
        ? request.toolChoice.name
        : null;
      const wireTools = lmStudioNamedTool
        ? request.tools.filter(({ name }) => name === lmStudioNamedTool)
        : request.tools;
      body.tools = wireTools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: true,
        },
      }));
      if (request.toolChoice !== undefined) {
        body.tool_choice = lmStudioNamedTool
          ? "required"
          : chatToolChoice(request.toolChoice);
      }
      body.parallel_tool_calls = false;
    }

    const raw = await postProviderJson({
      providerId: this.id,
      url: providerEndpoint(this.options.baseUrl, "chat/completions"),
      body,
      headers: bearerHeaders(this.options.apiKey),
      timeoutMs: request.timeoutMs ?? this.options.timeoutMs,
      maxResponseBytes: this.options.maxResponseBytes,
      signal,
      fetchImpl: this.options.fetchImpl,
    });
    return parseChatResult(this.id, raw);
  }
}

function promptWithJsonSchema(
  providerId: OpenAiChatOptions["id"],
  systemPrompt: string,
  jsonSchema: Record<string, unknown>,
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(jsonSchema);
  } catch {
    throw protocolError(providerId, "Ask JSON Schema 无法序列化");
  }
  if (serialized.length > 64_000) {
    throw protocolError(providerId, "Ask JSON Schema 超过内部安全上限");
  }
  return [
    systemPrompt,
    "The endpoint has no native JSON Schema mode. Return only one JSON object that matches this schema exactly:",
    serialized,
  ].join("\n\n");
}

function parseChatResult(
  providerId: OpenAiChatOptions["id"],
  raw: unknown,
): AskLlmCompleteResponse {
  if (!isRecord(raw) || !Array.isArray(raw.choices) || raw.choices.length === 0) {
    throw protocolError(providerId, "模型服务返回了无法识别的 Chat Completions 结构");
  }
  const choice = raw.choices[0];
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
  const text = message ? chatContentText(message.content) : "";
  const toolCalls = message ? chatToolCalls(providerId, message) : [];
  if (!text && toolCalls.length === 0) {
    throw protocolError(providerId, "模型服务没有返回可用文本或原生工具调用");
  }
  const usage = isRecord(raw.usage) ? raw.usage : {};
  const result: AskLlmCompleteResponse = {
    text,
    model: responseModel(providerId, raw.model),
    usage: {
      inputTokens: tokenCount(usage.prompt_tokens),
      outputTokens: tokenCount(usage.completion_tokens),
    },
  };
  if (toolCalls.length > 0) result.toolCalls = toolCalls;
  return result;
}

function chatToolChoice(choice: AskLlmToolChoice): unknown {
  return typeof choice === "string"
    ? choice
    : { type: "function", function: { name: choice.name } };
}

function chatToolCalls(
  providerId: OpenAiChatOptions["id"],
  message: Record<string, unknown>,
): AskLlmToolCall[] {
  if (message.tool_calls === undefined) return [];
  if (!Array.isArray(message.tool_calls)) {
    throw protocolError(providerId, "模型服务返回了无法识别的 Chat tool_calls");
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

function chatContentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return [];
    return part.text.trim() ? [part.text.trim()] : [];
  }).join("\n").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
