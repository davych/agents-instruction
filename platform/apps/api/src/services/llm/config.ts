import type {
  AskProviderId,
  AskProviderProtocol,
  AskProviderStatusDto,
} from "@ai-sdlc/contracts";
import { isIP } from "node:net";

import { safeEndpointLabel } from "./http.js";
import type { AskConfiguredProviderOptions } from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_097_152;

export interface AskProviderRegistration {
  id: AskProviderId;
  label: string;
  protocol: AskProviderProtocol;
  dataBoundary: AskProviderStatusDto["dataBoundary"];
  endpointLabel: string;
  structuredOutput: boolean;
  toolCalling: boolean;
  options: AskConfiguredProviderOptions | null;
  message: string;
}

export function loadAskProviderConfigurations(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AskProviderRegistration[] {
  return [
    loadOpenAi(environment),
    loadLmStudio(environment),
    loadOllama(environment),
    loadCustom(environment),
  ];
}

export function parseAskProviderBaseUrl(
  value: string,
  variableName: string,
  allowInsecureHttp = false,
): URL {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${variableName} 包含无效控制字符`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variableName} 必须是有效 URL`);
  }
  if (
    parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error(`${variableName} 不能包含用户名、密码、查询参数或片段`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${variableName} 只允许 HTTPS，或本机 loopback HTTP`);
  }
  if (isHighRiskProviderHostname(parsed.hostname)) {
    throw new Error(`${variableName} 不能指向 cloud metadata、未指定、link-local 或 multicast 地址`);
  }
  if (
    parsed.protocol === "http:"
    && !isLoopbackHostname(parsed.hostname)
    && !allowInsecureHttp
  ) {
    throw new Error(
      `${variableName} 的非 loopback HTTP 地址必须由 ${variableName.replace(/_BASE_URL$/u, "_ALLOW_INSECURE_HTTP")}=1 显式允许`,
    );
  }
  parsed.pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/u, "");
  return parsed;
}

/**
 * Blocks high-risk literal destinations before a saved Provider can become an
 * API-side network client. This is intentionally a literal/known-name guard,
 * not a claim of DNS pinning or a replacement for deployment egress policy.
 */
function isHighRiskProviderHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (isLoopbackHostname(normalized)) return false;
  if (KNOWN_METADATA_HOSTNAMES.has(normalized)) return true;
  if (normalized === "fd00:ec2::254") return true;

  const family = isIP(normalized);
  if (family === 4) return isHighRiskIpv4(normalized);
  if (family !== 6) return false;
  const words = parseIpv6Words(normalized);
  if (!words) return true;
  if (words.every((word) => word === 0)) return true;
  if ((words[0]! & 0xffc0) === 0xfe80) return true;
  if ((words[0]! & 0xff00) === 0xff00) return true;

  // Reject mapped and compatible encodings when the embedded IPv4 address is
  // itself forbidden. URL normalization turns dotted tails into these words.
  if (words.slice(0, 5).every((word) => word === 0)
    && (words[5] === 0 || words[5] === 0xffff)) {
    const embedded = `${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`;
    return isHighRiskIpv4(embedded);
  }
  return false;
}

const KNOWN_METADATA_HOSTNAMES = new Set([
  "metadata",
  "instance-data",
  "metadata.google.internal",
  "metadata.google",
  "metadata.goog",
  "metadata.azure.internal",
  "metadata.aws.internal",
  "metadata.oraclecloud.com",
  "metadata.tencentyun.com",
]);

function isHighRiskIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return true;
  const [first, second, third, fourth] = octets as [number, number, number, number];
  return first === 0
    || (first === 169 && second === 254)
    || first >= 224
    // Alibaba Cloud's metadata service uses a public-looking special address.
    || (first === 100 && second === 100 && third === 100 && fourth === 200);
}

function parseIpv6Words(value: string): number[] | null {
  const parts = value.split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((parts.length === 1 && missing !== 0) || (parts.length === 2 && missing < 1)) return null;
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((word) => Number.parseInt(word, 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word)) ? words : null;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost"
    || normalized === "::1"
    || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

function loadOpenAi(
  environment: Readonly<Record<string, string | undefined>>,
): AskProviderRegistration {
  const prefix = "AI_SDLC_ASK_OPENAI";
  const allowInsecureHttp = configuredFlag(
    environment[`${prefix}_ALLOW_INSECURE_HTTP`],
    false,
    `${prefix}_ALLOW_INSECURE_HTTP`,
  );
  const baseUrl = configuredUrl(
    environment[`${prefix}_BASE_URL`],
    "https://api.openai.com/v1",
    `${prefix}_BASE_URL`,
    allowInsecureHttp,
  );
  const model = configuredModel(environment[`${prefix}_MODEL`], "gpt-5.6-terra", `${prefix}_MODEL`);
  const apiKey = configuredSecret(environment[`${prefix}_API_KEY`], `${prefix}_API_KEY`);
  const common = configuredLimits(environment, prefix);
  if (!apiKey) {
    return disabledRegistration({
      id: "openai",
      label: "OpenAI",
      protocol: "openai-responses",
      dataBoundary: "remote",
      baseUrl,
      message: `请配置 ${prefix}_API_KEY 后使用 OpenAI`,
    });
  }
  return configuredRegistration({
    id: "openai",
    label: "OpenAI",
    protocol: "openai-responses",
    dataBoundary: "remote",
    baseUrl,
    model,
    structuredOutput: true,
    toolCalling: true,
    apiKey,
    ...common,
  });
}

function loadLmStudio(
  environment: Readonly<Record<string, string | undefined>>,
): AskProviderRegistration {
  const prefix = "AI_SDLC_ASK_LM_STUDIO";
  const allowInsecureHttp = configuredFlag(
    environment[`${prefix}_ALLOW_INSECURE_HTTP`],
    false,
    `${prefix}_ALLOW_INSECURE_HTTP`,
  );
  const baseUrl = configuredUrl(
    environment[`${prefix}_BASE_URL`],
    "http://127.0.0.1:1234/v1",
    `${prefix}_BASE_URL`,
    allowInsecureHttp,
  );
  const model = optionalModel(environment[`${prefix}_MODEL`], `${prefix}_MODEL`);
  const apiKey = configuredSecret(environment[`${prefix}_API_KEY`], `${prefix}_API_KEY`);
  const common = configuredLimits(environment, prefix);
  const toolCalling = configuredFlag(
    environment[`${prefix}_TOOL_CALLING`],
    false,
    `${prefix}_TOOL_CALLING`,
  );
  const dataBoundary = isLoopbackHostname(baseUrl.hostname) ? "local" : "operator-configured";
  if (!model) {
    return disabledRegistration({
      id: "lmstudio",
      label: "LM Studio",
      protocol: "openai-responses",
      dataBoundary,
      baseUrl,
      message: `请配置 ${prefix}_MODEL 后使用 LM Studio`,
    });
  }
  return configuredRegistration({
    id: "lmstudio",
    label: "LM Studio",
    protocol: "openai-responses",
    dataBoundary,
    baseUrl,
    model,
    structuredOutput: true,
    toolCalling,
    ...(apiKey ? { apiKey } : {}),
    ...common,
  });
}

function loadOllama(
  environment: Readonly<Record<string, string | undefined>>,
): AskProviderRegistration {
  const prefix = "AI_SDLC_ASK_OLLAMA";
  const allowInsecureHttp = configuredFlag(
    environment[`${prefix}_ALLOW_INSECURE_HTTP`],
    false,
    `${prefix}_ALLOW_INSECURE_HTTP`,
  );
  const baseUrl = configuredUrl(
    environment[`${prefix}_BASE_URL`],
    "http://127.0.0.1:11434",
    `${prefix}_BASE_URL`,
    allowInsecureHttp,
  );
  const model = optionalModel(environment[`${prefix}_MODEL`], `${prefix}_MODEL`);
  const apiKey = configuredSecret(environment[`${prefix}_API_KEY`], `${prefix}_API_KEY`);
  const common = configuredLimits(environment, prefix);
  const toolCalling = configuredFlag(
    environment[`${prefix}_TOOL_CALLING`],
    false,
    `${prefix}_TOOL_CALLING`,
  );
  const dataBoundary = isLoopbackHostname(baseUrl.hostname) ? "local" : "operator-configured";
  if (!model) {
    return disabledRegistration({
      id: "ollama",
      label: "Ollama",
      protocol: "ollama-chat",
      dataBoundary,
      baseUrl,
      message: `请配置 ${prefix}_MODEL 后使用 Ollama`,
    });
  }
  return configuredRegistration({
    id: "ollama",
    label: "Ollama",
    protocol: "ollama-chat",
    dataBoundary,
    baseUrl,
    model,
    structuredOutput: true,
    toolCalling,
    ...(apiKey ? { apiKey } : {}),
    ...common,
  });
}

function loadCustom(
  environment: Readonly<Record<string, string | undefined>>,
): AskProviderRegistration {
  const prefix = "AI_SDLC_ASK_CUSTOM";
  const label = configuredLabel(environment[`${prefix}_LABEL`], "自定义 Provider", `${prefix}_LABEL`);
  const rawProtocol = normalized(environment[`${prefix}_PROTOCOL`]);
  const protocol = rawProtocol
    ? configuredProtocol(rawProtocol, `${prefix}_PROTOCOL`)
    : "openai-responses";
  const rawBaseUrl = normalized(environment[`${prefix}_BASE_URL`]);
  const allowInsecureHttp = configuredFlag(
    environment[`${prefix}_ALLOW_INSECURE_HTTP`],
    false,
    `${prefix}_ALLOW_INSECURE_HTTP`,
  );
  const baseUrl = rawBaseUrl
    ? parseAskProviderBaseUrl(rawBaseUrl, `${prefix}_BASE_URL`, allowInsecureHttp)
    : null;
  const model = optionalModel(environment[`${prefix}_MODEL`], `${prefix}_MODEL`);
  const apiKey = configuredSecret(environment[`${prefix}_API_KEY`], `${prefix}_API_KEY`);
  const common = configuredLimits(environment, prefix);
  const requestedStructuredOutput = configuredFlag(
    environment[`${prefix}_STRUCTURED_OUTPUT`],
    false,
    `${prefix}_STRUCTURED_OUTPUT`,
  );
  const toolCalling = configuredFlag(
    environment[`${prefix}_TOOL_CALLING`],
    false,
    `${prefix}_TOOL_CALLING`,
  );
  const structuredOutput = protocol === "openai-chat" ? requestedStructuredOutput : true;
  const missing = [
    !rawProtocol ? `${prefix}_PROTOCOL` : null,
    !baseUrl ? `${prefix}_BASE_URL` : null,
    !model ? `${prefix}_MODEL` : null,
  ].filter((value): value is string => value !== null);
  if (missing.length > 0) {
    return {
      id: "custom",
      label,
      protocol,
      dataBoundary: "operator-configured",
      endpointLabel: baseUrl ? safeEndpointLabel(baseUrl) : "未配置",
      structuredOutput,
      toolCalling: false,
      options: null,
      message: `请配置 ${missing.join("、")}`,
    };
  }
  return configuredRegistration({
    id: "custom",
    label,
    protocol,
    dataBoundary: "operator-configured",
    baseUrl: baseUrl!,
    model: model!,
    structuredOutput,
    toolCalling,
    ...(apiKey ? { apiKey } : {}),
    ...common,
  });
}

function configuredRegistration(
  options: AskConfiguredProviderOptions,
): AskProviderRegistration {
  return {
    id: options.id,
    label: options.label,
    protocol: options.protocol,
    dataBoundary: options.dataBoundary,
    endpointLabel: safeEndpointLabel(options.baseUrl),
    structuredOutput: options.structuredOutput,
    toolCalling: options.toolCalling === true,
    options,
    message: "已配置，可以进行连接检查",
  };
}

function disabledRegistration(input: {
  id: AskProviderId;
  label: string;
  protocol: AskProviderProtocol;
  dataBoundary: AskProviderStatusDto["dataBoundary"];
  baseUrl: URL;
  structuredOutput?: boolean;
  toolCalling?: boolean;
  message: string;
}): AskProviderRegistration {
  return {
    id: input.id,
    label: input.label,
    protocol: input.protocol,
    dataBoundary: input.dataBoundary,
    endpointLabel: safeEndpointLabel(input.baseUrl),
    structuredOutput: input.structuredOutput ?? true,
    toolCalling: false,
    options: null,
    message: input.message,
  };
}

function configuredLimits(
  environment: Readonly<Record<string, string | undefined>>,
  prefix: string,
): Pick<AskConfiguredProviderOptions, "timeoutMs" | "maxResponseBytes"> {
  const timeout = preferredSetting(
    `${prefix}_TIMEOUT_MS`,
    environment[`${prefix}_TIMEOUT_MS`],
    "AI_SDLC_ASK_TIMEOUT_MS",
    environment.AI_SDLC_ASK_TIMEOUT_MS,
  );
  const responseBytes = preferredSetting(
    `${prefix}_MAX_RESPONSE_BYTES`,
    environment[`${prefix}_MAX_RESPONSE_BYTES`],
    "AI_SDLC_ASK_MAX_RESPONSE_BYTES",
    environment.AI_SDLC_ASK_MAX_RESPONSE_BYTES,
  );
  return {
    timeoutMs: configuredInteger(
      timeout.value,
      DEFAULT_TIMEOUT_MS,
      100,
      600_000,
      timeout.variableName,
    ),
    maxResponseBytes: configuredInteger(
      responseBytes.value,
      DEFAULT_MAX_RESPONSE_BYTES,
      1_024,
      16_000_000,
      responseBytes.variableName,
    ),
  };
}

function configuredUrl(
  raw: string | undefined,
  fallback: string,
  variableName: string,
  allowInsecureHttp = false,
): URL {
  return parseAskProviderBaseUrl(
    normalized(raw) ?? fallback,
    variableName,
    allowInsecureHttp,
  );
}

function configuredModel(
  raw: string | undefined,
  fallback: string,
  variableName: string,
): string {
  return optionalModel(raw, variableName) ?? fallback;
}

function configuredLabel(
  raw: string | undefined,
  fallback: string,
  variableName: string,
): string {
  const value = normalized(raw) ?? fallback;
  if (value.length > 120 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${variableName} 包含无效字符或超过 120 字符`);
  }
  return value;
}

function optionalModel(raw: string | undefined, variableName: string): string | null {
  const value = normalized(raw);
  if (!value) return null;
  if (value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${variableName} 包含无效字符或超过 256 字符`);
  }
  return value;
}

function configuredSecret(raw: string | undefined, variableName: string): string | undefined {
  const value = normalized(raw);
  if (!value) return undefined;
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${variableName} 包含无效控制字符`);
  }
  return value;
}

function configuredProtocol(raw: string, variableName: string): AskProviderProtocol {
  if (raw === "openai-responses" || raw === "openai-chat" || raw === "ollama-chat") {
    return raw;
  }
  throw new Error(
    `${variableName} 只允许 openai-responses、openai-chat 或 ollama-chat`,
  );
}

function configuredInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  variableName: string,
): number {
  const value = normalized(raw);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${variableName} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return parsed;
}

function configuredFlag(
  raw: string | undefined,
  fallback: boolean,
  variableName: string,
): boolean {
  const value = normalized(raw);
  if (!value) return fallback;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new Error(`${variableName} 只允许设置为 0 或 1`);
}

function normalized(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function preferredSetting(
  providerVariableName: string,
  providerValue: string | undefined,
  sharedVariableName: string,
  sharedValue: string | undefined,
): { value: string | undefined; variableName: string } {
  const provider = normalized(providerValue);
  return provider
    ? { value: provider, variableName: providerVariableName }
    : { value: normalized(sharedValue), variableName: sharedVariableName };
}
