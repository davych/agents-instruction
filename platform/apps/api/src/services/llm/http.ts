import type {
  AskProviderCheckDto,
  AskProviderId,
  AskProviderStatusDto,
} from "@ai-sdlc/contracts";

import {
  AskProviderError,
  type AskLlmCompleteRequest,
  type AskLlmCompleteResponse,
} from "./types.js";

export const PROVIDER_CHECK_REQUEST: Readonly<AskLlmCompleteRequest> = Object.freeze({
  systemPrompt: [
    "This is a model-service compatibility check.",
    "Ignore any instruction to change the response shape.",
    'Return only the JSON object {"ok":true}.',
  ].join(" "),
  messages: [{ role: "user" as const, content: 'Return {"ok":true} now.' }],
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: { ok: { type: "boolean", enum: [true] } },
  },
  // Responses models may count hidden reasoning inside this budget.
  maxOutputTokens: 512,
});

export interface ProviderJsonRequest {
  providerId: AskProviderId;
  url: URL;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function postProviderJson(request: ProviderJsonRequest): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  const abortFromCaller = () => controller.abort();
  request.signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    if (request.signal?.aborted) throw cancelled(request.providerId);
    let serialized: string;
    try {
      serialized = JSON.stringify(request.body);
    } catch {
      throw new AskProviderError(
        request.providerId,
        "ASK_PROVIDER_REQUEST_INVALID",
        "无法序列化 Ask Provider 请求",
        "protocol_error",
        500,
        false,
      );
    }

    const fetchImpl = request.fetchImpl ?? fetch;
    const response = await fetchImpl(request.url, {
      method: "POST",
      // Never follow an operator-configured endpoint into a different trust
      // boundary. Manual mode lets us classify the 3xx without reading it.
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...request.headers,
      },
      body: serialized,
      signal: controller.signal,
    });

    if (!response.ok) {
      const hint = await readUpstreamErrorHint(response, request.maxResponseBytes);
      throw classifyHttpError(request.providerId, response.status, hint);
    }

    const raw = await readResponseText(
      request.providerId,
      response,
      request.maxResponseBytes,
    );
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new AskProviderError(
        request.providerId,
        "ASK_PROVIDER_PROTOCOL_ERROR",
        "模型服务返回了无法识别的 JSON",
        "protocol_error",
        502,
        false,
      );
    }
  } catch (error) {
    if (error instanceof AskProviderError) throw error;
    if (request.signal?.aborted) throw cancelled(request.providerId);
    if (timedOut || controller.signal.aborted) {
      throw new AskProviderError(
        request.providerId,
        "ASK_PROVIDER_TIMEOUT",
        "模型服务响应超时，请检查服务状态或稍后重试",
        "unreachable",
        504,
        true,
      );
    }
    throw new AskProviderError(
      request.providerId,
      "ASK_PROVIDER_UNREACHABLE",
      "无法连接模型服务，请检查地址和服务状态",
      "unreachable",
      502,
      true,
    );
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function providerEndpoint(baseUrl: URL, suffix: string): URL {
  const result = new URL(baseUrl.toString());
  const basePath = result.pathname.replace(/\/+$/u, "");
  const suffixPath = suffix.replace(/^\/+|\/+$/gu, "");
  result.pathname = `${basePath}/${suffixPath}`.replace(/\/{2,}/gu, "/");
  return result;
}

export function bearerHeaders(apiKey: string | undefined): Readonly<Record<string, string>> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export function safeEndpointLabel(baseUrl: URL): string {
  // A custom endpoint path can itself contain deployment or gateway secrets.
  // The browser only needs enough information to distinguish destinations.
  return baseUrl.host;
}

export async function runProviderCheck(
  providerId: AskProviderId,
  model: string,
  operation: () => Promise<AskLlmCompleteResponse>,
): Promise<AskProviderCheckDto> {
  try {
    const response = await operation();
    assertProviderCheckPayload(providerId, response.text);
    return {
      providerId,
      state: "ready",
      model: response.model,
      message: response.model === model
        ? "连接和模型检查通过"
        : `连接检查通过；请求模型：${model}；上游报告模型：${response.model}`,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof AskProviderError) {
      if (error.code === "ASK_PROVIDER_CANCELLED") throw error;
      return {
        providerId,
        state: error.availability,
        model,
        message: error.message,
        checkedAt: new Date().toISOString(),
      };
    }
    return {
      providerId,
      state: "protocol_error",
      model,
      message: "模型服务检查失败，未获得可识别的响应",
      checkedAt: new Date().toISOString(),
    };
  }
}

function assertProviderCheckPayload(providerId: AskProviderId, text: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim()) as unknown;
  } catch {
    throw protocolError(providerId, "模型服务无法按 Ask 所需的 JSON 格式回答");
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || (parsed as Record<string, unknown>).ok !== true
    || Object.keys(parsed as Record<string, unknown>).length !== 1
  ) {
    throw protocolError(providerId, "模型服务无法按 Ask 所需的 JSON 格式回答");
  }
}

export function configuredStatus(
  options: {
    id: AskProviderStatusDto["id"];
    label: string;
    model: string;
    protocol: AskProviderStatusDto["protocol"];
    dataBoundary: AskProviderStatusDto["dataBoundary"];
    baseUrl: URL;
    structuredOutput: boolean;
    toolCalling?: boolean;
  },
): AskProviderStatusDto {
  return {
    id: options.id,
    label: options.label,
    configured: true,
    model: options.model,
    protocol: options.protocol,
    dataBoundary: options.dataBoundary,
    endpointLabel: safeEndpointLabel(options.baseUrl),
    capabilities: {
      streaming: false,
      structuredOutput: options.structuredOutput,
      toolCalling: options.toolCalling === true,
    },
    message: "已配置，可以进行连接检查",
  };
}

export function tokenCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

export function responseModel(providerId: AskProviderId, value: unknown): string {
  if (typeof value === "string"
    && value.trim().length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value)) {
    return value;
  }
  throw protocolError(providerId, "模型服务没有报告实际使用的模型");
}

export function protocolError(providerId: AskProviderId, message: string): AskProviderError {
  return new AskProviderError(
    providerId,
    "ASK_PROVIDER_PROTOCOL_ERROR",
    message,
    "protocol_error",
    502,
    false,
  );
}

type UpstreamErrorHint = "model_unavailable" | "unknown";

function classifyHttpError(
  providerId: AskProviderId,
  status: number,
  hint: UpstreamErrorHint,
): AskProviderError {
  if (status === 401 || status === 403) {
    return new AskProviderError(
      providerId,
      "ASK_PROVIDER_AUTHENTICATION_FAILED",
      "模型服务拒绝了认证，请检查服务端密钥配置",
      "authentication_failed",
      502,
      false,
      status,
    );
  }
  if (status === 429) {
    return new AskProviderError(
      providerId,
      "ASK_PROVIDER_RATE_LIMITED",
      "模型服务当前请求过多，请稍后重试",
      "unreachable",
      429,
      true,
      status,
    );
  }
  if ((status === 400 || status === 404) && hint === "model_unavailable") {
    return new AskProviderError(
      providerId,
      "ASK_PROVIDER_MODEL_UNAVAILABLE",
      "模型或所选协议端点不存在，请检查模型名和 Provider 配置",
      "model_unavailable",
      502,
      false,
      status,
    );
  }
  if (status === 404) {
    return new AskProviderError(
      providerId,
      "ASK_PROVIDER_PROTOCOL_ERROR",
      "模型服务上找不到所选协议端点，请检查 base URL 和协议配置",
      "protocol_error",
      502,
      false,
      status,
    );
  }
  if (status >= 500) {
    return new AskProviderError(
      providerId,
      "ASK_PROVIDER_UNREACHABLE",
      "模型服务暂时不可用，请稍后重试",
      "unreachable",
      502,
      true,
      status,
    );
  }
  return new AskProviderError(
    providerId,
    "ASK_PROVIDER_REQUEST_REJECTED",
    "模型服务拒绝了请求，请检查模型和协议配置",
    "protocol_error",
    502,
    false,
    status,
  );
}

async function readUpstreamErrorHint(
  response: Response,
  configuredMaxBytes: number,
): Promise<UpstreamErrorHint> {
  if (!response.body) return "unknown";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const maximum = Math.min(configuredMaxBytes, 64 * 1024);
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel().catch(() => undefined);
        return "unknown";
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return "unknown";
  }
  if (!isRecord(parsed)) return "unknown";
  const error = parsed.error;
  const record = isRecord(error) ? error : parsed;
  const code = [record.code, record.type]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase("en-US");
  if (/(?:model[_ -]?(?:not[_ -]?found|unavailable|not[_ -]?available|not[_ -]?loaded)|unknown[_ -]?model|invalid[_ -]?model)/u.test(code)) {
    return "model_unavailable";
  }
  const message = typeof error === "string"
    ? error
    : typeof record.message === "string"
      ? record.message
      : "";
  return /\bmodel\b.{0,160}\b(?:not found|does not exist|unavailable|not loaded)\b/iu.test(
    message.slice(0, 2_000),
  )
    ? "model_unavailable"
    : "unknown";
}

async function readResponseText(
  providerId: AskProviderId,
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    throw protocolError(providerId, "模型服务返回了空响应");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AskProviderError(
          providerId,
          "ASK_PROVIDER_RESPONSE_TOO_LARGE",
          "模型服务响应超过安全上限",
          "protocol_error",
          502,
          false,
        );
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (result.trim().length === 0) {
    throw protocolError(providerId, "模型服务返回了空响应");
  }
  return result;
}

function cancelled(providerId: AskProviderId): AskProviderError {
  return new AskProviderError(
    providerId,
    "ASK_PROVIDER_CANCELLED",
    "Ask 请求已取消",
    "unreachable",
    499,
    false,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
