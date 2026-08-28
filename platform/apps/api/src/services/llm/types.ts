import type {
  AskProviderAvailability,
  AskProviderCheckDto,
  AskProviderId,
  AskProviderProtocol,
  AskProviderStatusDto,
} from "@ai-sdlc/contracts";

export interface AskLlmMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * The provider-neutral subset of strict function tools used by the agent.
 *
 * `strict: true` is intentional: callers must provide a closed JSON Schema
 * and must still validate the returned arguments before executing anything.
 */
export interface AskLlmFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
}

export type AskLlmToolChoice = "auto" | "none" | "required" | {
  type: "function";
  name: string;
};

export interface AskLlmCompleteRequest {
  systemPrompt: string;
  messages: readonly AskLlmMessage[];
  jsonSchema?: Record<string, unknown>;
  tools?: readonly AskLlmFunctionTool[];
  toolChoice?: AskLlmToolChoice;
  /** Optional reasoning budget for model families that expose this control. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Optional sampling temperature for generation tasks; omitted for provider defaults. */
  temperature?: number;
  /** Server-owned operation deadline; bounded before any upstream request. */
  timeoutMs?: number;
  maxOutputTokens: number;
}

export interface AskLlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AskLlmCompleteResponse {
  text: string;
  model: string;
  usage: AskLlmUsage;
  /** Present only when the upstream returned native, normalized tool calls. */
  toolCalls?: readonly AskLlmToolCall[];
}

export interface AskLlmToolCall {
  /** Some compatible providers (notably Ollama) do not return a call id. */
  id: string | null;
  type: "function";
  name: string;
  arguments: Record<string, unknown>;
}

export interface AskLlmProvider {
  readonly id: AskProviderId;
  status(): AskProviderStatusDto;
  check(signal?: AbortSignal): Promise<AskProviderCheckDto>;
  complete(
    request: AskLlmCompleteRequest,
    signal?: AbortSignal,
  ): Promise<AskLlmCompleteResponse>;
}

interface AskConfiguredProviderBaseOptions {
  id: AskProviderId;
  label: string;
  dataBoundary: AskProviderStatusDto["dataBoundary"];
  baseUrl: URL;
  model: string;
  structuredOutput: boolean;
  /**
   * Explicit for compatibility/local endpoints because support depends on the
   * selected server and model, not just the wire protocol.
   */
  toolCalling?: boolean;
  apiKey?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImpl?: typeof fetch;
}

export type AskConfiguredProviderOptions = AskConfiguredProviderBaseOptions & (
  | { protocol: Extract<AskProviderProtocol, "openai-responses"> }
  | { protocol: Extract<AskProviderProtocol, "openai-chat"> }
  | { protocol: Extract<AskProviderProtocol, "ollama-chat"> }
);

export type AskProviderErrorCode =
  | "ASK_PROVIDER_NOT_CONFIGURED"
  | "ASK_PROVIDER_REQUEST_INVALID"
  | "ASK_PROVIDER_CANCELLED"
  | "ASK_PROVIDER_TIMEOUT"
  | "ASK_PROVIDER_UNREACHABLE"
  | "ASK_PROVIDER_AUTHENTICATION_FAILED"
  | "ASK_PROVIDER_RATE_LIMITED"
  | "ASK_PROVIDER_MODEL_UNAVAILABLE"
  | "ASK_PROVIDER_REQUEST_REJECTED"
  | "ASK_PROVIDER_RESPONSE_TOO_LARGE"
  | "ASK_PROVIDER_PROTOCOL_ERROR";

/**
 * A deliberately sanitized upstream error. Never attach an upstream response
 * body, request headers, API key, or full request URL to this object.
 */
export class AskProviderError extends Error {
  constructor(
    readonly providerId: AskProviderId,
    readonly code: AskProviderErrorCode,
    message: string,
    readonly availability: AskProviderAvailability,
    readonly statusCode: number,
    readonly retryable: boolean,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "AskProviderError";
  }
}

export function assertCompleteRequest(
  providerId: AskProviderId,
  request: AskLlmCompleteRequest,
): void {
  if (
    typeof request.systemPrompt !== "string"
    || request.systemPrompt.trim().length === 0
    || request.systemPrompt.length > 64_000
  ) {
    throw invalidRequest(providerId, "Ask system prompt 无效");
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > 32) {
    throw invalidRequest(providerId, "Ask messages 数量无效");
  }
  let totalMessageCharacters = 0;
  for (const message of request.messages) {
    if (
      (message.role !== "user" && message.role !== "assistant")
      || typeof message.content !== "string"
      || message.content.trim().length === 0
      || message.content.length > 500_000
    ) {
      throw invalidRequest(providerId, "Ask message 无效");
    }
    totalMessageCharacters += message.content.length;
  }
  if (totalMessageCharacters > 1_000_000) {
    throw invalidRequest(providerId, "Ask messages 超过内部上下文上限");
  }
  if (
    !Number.isSafeInteger(request.maxOutputTokens)
    || request.maxOutputTokens < 1
    || request.maxOutputTokens > 65_536
  ) {
    throw invalidRequest(providerId, "Ask maxOutputTokens 无效");
  }
  if (
    request.timeoutMs !== undefined
    && (
      !Number.isSafeInteger(request.timeoutMs)
      || request.timeoutMs < 1_000
      || request.timeoutMs > 300_000
    )
  ) {
    throw invalidRequest(providerId, "Ask timeoutMs 无效");
  }
  if (
    request.reasoningEffort !== undefined
    && !["low", "medium", "high"].includes(request.reasoningEffort)
  ) {
    throw invalidRequest(providerId, "Ask reasoningEffort 无效");
  }
  if (
    request.temperature !== undefined
    && (
      !Number.isFinite(request.temperature)
      || request.temperature < 0
      || request.temperature > 2
    )
  ) {
    throw invalidRequest(providerId, "Ask temperature 无效");
  }
  if (
    request.jsonSchema !== undefined
    && (
      request.jsonSchema === null
      || typeof request.jsonSchema !== "object"
      || Array.isArray(request.jsonSchema)
    )
  ) {
    throw invalidRequest(providerId, "Ask jsonSchema 无效");
  }
  assertFunctionTools(providerId, request);
}

export function assertToolCallingConfigured(
  providerId: AskProviderId,
  configured: boolean | undefined,
  request: AskLlmCompleteRequest,
): void {
  if (request.tools !== undefined && configured !== true) {
    throw invalidRequest(providerId, "当前 Provider/模型未配置原生工具调用能力");
  }
}

function assertFunctionTools(
  providerId: AskProviderId,
  request: AskLlmCompleteRequest,
): void {
  if (request.tools === undefined) {
    if (request.toolChoice !== undefined) {
      throw invalidRequest(providerId, "Ask toolChoice 必须与 tools 一起使用");
    }
    return;
  }
  if (!Array.isArray(request.tools) || request.tools.length < 1 || request.tools.length > 32) {
    throw invalidRequest(providerId, "Ask tools 数量无效");
  }
  const names = new Set<string>();
  let serializedCharacters = 0;
  for (const tool of request.tools) {
    const parameterProperties = tool?.parameters?.properties;
    const requiredParameters = tool?.parameters?.required;
    if (
      tool?.type !== "function"
      || tool.strict !== true
      || typeof tool.name !== "string"
      || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(tool.name)
      || names.has(tool.name)
      || typeof tool.description !== "string"
      || tool.description.trim().length === 0
      || tool.description.length > 4_000
      || tool.parameters === null
      || typeof tool.parameters !== "object"
      || Array.isArray(tool.parameters)
      || tool.parameters.type !== "object"
      || tool.parameters.additionalProperties !== false
      || parameterProperties === null
      || typeof parameterProperties !== "object"
      || Array.isArray(parameterProperties)
      || !Array.isArray(requiredParameters)
      || requiredParameters.some((name) => typeof name !== "string")
      || new Set(requiredParameters).size !== requiredParameters.length
      || requiredParameters.length !== Object.keys(parameterProperties).length
      || requiredParameters.some((name) => !Object.hasOwn(parameterProperties, name))
    ) {
      throw invalidRequest(providerId, "Ask function tool 无效");
    }
    names.add(tool.name);
    try {
      serializedCharacters += JSON.stringify(tool.parameters).length;
    } catch {
      throw invalidRequest(providerId, "Ask function tool schema 无法序列化");
    }
  }
  if (serializedCharacters > 128_000) {
    throw invalidRequest(providerId, "Ask function tool schemas 超过内部安全上限");
  }
  if (
    request.toolChoice === undefined
    || request.toolChoice === "auto"
    || request.toolChoice === "none"
    || request.toolChoice === "required"
  ) {
    return;
  }
  if (
    request.toolChoice === null
    || typeof request.toolChoice !== "object"
    || request.toolChoice.type !== "function"
    || !names.has(request.toolChoice.name)
  ) {
    throw invalidRequest(providerId, "Ask toolChoice 无效");
  }
}

export function normalizedToolArguments(
  providerId: AskProviderId,
  value: unknown,
): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    if (value.length > 64_000) {
      throw protocolToolCallError(providerId);
    }
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw protocolToolCallError(providerId);
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw protocolToolCallError(providerId);
  }
  return parsed as Record<string, unknown>;
}

export function normalizedToolCallIdentity(
  providerId: AskProviderId,
  input: { id: unknown; name: unknown },
): { id: string | null; name: string } {
  const name = input.name;
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(name)) {
    throw protocolToolCallError(providerId);
  }
  if (input.id === undefined || input.id === null) return { id: null, name };
  if (
    typeof input.id !== "string"
    || input.id.trim().length === 0
    || input.id.length > 256
    || /[\u0000-\u001f\u007f]/u.test(input.id)
  ) {
    throw protocolToolCallError(providerId);
  }
  return { id: input.id, name };
}

function protocolToolCallError(providerId: AskProviderId): AskProviderError {
  return new AskProviderError(
    providerId,
    "ASK_PROVIDER_PROTOCOL_ERROR",
    "模型服务返回了无法验证的原生工具调用",
    "protocol_error",
    502,
    false,
  );
}

export function unavailableCheck(
  providerId: AskProviderId,
  model: string | null,
  message: string,
): AskProviderCheckDto {
  return {
    providerId,
    state: "not_configured",
    model,
    message,
    checkedAt: new Date().toISOString(),
  };
}

function invalidRequest(providerId: AskProviderId, message: string): AskProviderError {
  return new AskProviderError(
    providerId,
    "ASK_PROVIDER_REQUEST_INVALID",
    message,
    "protocol_error",
    500,
    false,
  );
}
