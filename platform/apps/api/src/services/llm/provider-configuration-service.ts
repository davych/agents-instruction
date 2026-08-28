import {
  askProviderConfigurationCheckSchema,
  askProviderConfigurationSchema,
  checkAskProviderConfigurationSchema,
  setAskProviderEnabledSchema,
  updateAskProviderConfigurationSchema,
  type AskProviderConfigurationCheckDto,
  type AskProviderConfigurationDto,
  type AskProviderId,
  type CheckAskProviderConfigurationInput,
  type SetAskProviderEnabledInput,
  type UpdateAskProviderConfigurationInput,
} from "@ai-sdlc/contracts";

import { AppError } from "../../domain/errors.js";
import {
  isLoopbackHostname,
  parseAskProviderBaseUrl,
  type AskProviderRegistration,
} from "./config.js";
import { safeEndpointLabel } from "./http.js";
import {
  ProviderConfigurationVault,
  ProviderConfigurationVaultError,
  type ProviderVaultDocument,
  type StoredProviderConfiguration,
} from "./provider-configuration-vault.js";
import {
  AskProviderRegistry,
  createAskProvider,
} from "./provider-registry.js";
import {
  AskProviderError,
  type AskLlmCompleteRequest,
  type AskLlmProvider,
} from "./types.js";

const PROVIDER_TIMEOUT_MS = 60_000;
const PROVIDER_MAX_RESPONSE_BYTES = 2_097_152;
const PROVIDER_PROBE_TOOL_NAME = "ai_sdlc_provider_probe";
const PROVIDER_PROBE_ACK = "provider-check-v1";
const OPENAI_OFFICIAL_BASE_URL = "https://api.openai.com/v1";

export interface ProviderConfigurationServiceOptions {
  managedRoot: string;
}

/**
 * Owns the single-API Provider configuration authority. Public methods return
 * strict sanitized DTOs; complete endpoints and credentials remain inside the
 * encrypted Vault and immutable in-memory Provider instances.
 */
export class ProviderConfigurationService {
  readonly providers: AskProviderRegistry;
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(private readonly vault: ProviderConfigurationVault) {
    const stored = orderedProviders(vault.snapshot());
    for (const configuration of stored) assertStoredConfiguration(configuration);
    this.providers = new AskProviderRegistry(
      stored.map((configuration) => createAskProvider(
        registrationFor(configuration, "active"),
      )),
    );
    for (const configuration of stored) {
      this.providers.replace(
        configuration.providerId,
        createAskProvider(registrationFor(configuration, "active")),
        configuration.version,
      );
    }
  }

  static async create(
    options: ProviderConfigurationServiceOptions,
  ): Promise<ProviderConfigurationService> {
    return new ProviderConfigurationService(
      await ProviderConfigurationVault.open(options.managedRoot),
    );
  }

  list(): AskProviderConfigurationDto[] {
    return orderedProviders(this.vault.snapshot()).map(publicConfiguration);
  }

  get(providerId: AskProviderId): AskProviderConfigurationDto {
    return publicConfiguration(findProvider(this.vault.snapshot(), providerId));
  }

  async update(
    providerId: AskProviderId,
    unparsedInput: UpdateAskProviderConfigurationInput,
  ): Promise<AskProviderConfigurationDto> {
    const input = updateAskProviderConfigurationSchema.parse(unparsedInput);
    const updated = await this.commit((document) => {
      const current = findProvider(document, providerId);
      assertExpectedVersion(current, input.expectedVersion);
      const next = applyUpdate(current, input);
      Object.assign(current, next);
      return structuredClone(current);
    });
    return publicConfiguration(updated);
  }

  async check(
    providerId: AskProviderId,
    unparsedInput: CheckAskProviderConfigurationInput,
    signal?: AbortSignal,
  ): Promise<AskProviderConfigurationCheckDto> {
    const input = checkAskProviderConfigurationSchema.parse(unparsedInput);
    const before = findProvider(this.vault.snapshot(), providerId);
    assertExpectedVersion(before, input.expectedVersion);
    const provider = createAskProvider(registrationFor(before, "check"));
    const rawCheck = await checkSavedProvider(provider, before, signal);
    const updated = await this.commit((document) => {
      const current = findProvider(document, providerId);
      assertExpectedVersion(current, input.expectedVersion);
      if (current.configVersion !== before.configVersion) {
        throw versionConflict();
      }
      current.version += 1;
      const check = askProviderConfigurationCheckSchema.parse({
        ...rawCheck,
        version: current.version,
        configVersion: current.configVersion,
      });
      current.lastCheck = check;
      current.updatedAt = new Date().toISOString();
      if (check.state !== "ready") current.enabled = false;
      return structuredClone(current);
    });
    return askProviderConfigurationCheckSchema.parse(updated.lastCheck);
  }

  async setEnabled(
    providerId: AskProviderId,
    unparsedInput: SetAskProviderEnabledInput,
  ): Promise<AskProviderConfigurationDto> {
    const input = setAskProviderEnabledSchema.parse(unparsedInput);
    const updated = await this.commit((document) => {
      const current = findProvider(document, providerId);
      assertExpectedVersion(current, input.expectedVersion);
      assertStoredConfiguration(current);
      if (
        input.enabled
        && (
          !isComplete(current)
          || current.lastCheck?.state !== "ready"
          || current.lastCheck.configVersion !== current.configVersion
        )
      ) {
        throw new AppError(
          "当前 Provider 配置尚未通过本版本连接检查，不能启用",
          409,
          "PROVIDER_CONFIGURATION_NOT_READY",
        );
      }
      current.enabled = input.enabled;
      current.version += 1;
      current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
    return publicConfiguration(updated);
  }

  private commit(
    operation: (document: ProviderVaultDocument) => StoredProviderConfiguration,
  ): Promise<StoredProviderConfiguration> {
    const queued = this.mutationTail.then(async () => {
      const updated = await this.vault.update(operation);
      // Publish while still holding the service mutation order. The Registry's
      // record-version guard is defense in depth against any future caller
      // attempting to publish an older enabled/disabled/check state.
      this.publish(updated);
      return updated;
    });
    this.mutationTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private publish(configuration: StoredProviderConfiguration): void {
    this.providers.replace(
      configuration.providerId,
      createAskProvider(registrationFor(configuration, "active")),
      configuration.version,
    );
  }
}

async function checkSavedProvider(
  provider: AskLlmProvider,
  configuration: StoredProviderConfiguration,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<AskLlmProvider["check"]>>> {
  const basic = await provider.check(signal);
  if (basic.state !== "ready" || !configuration.toolCalling) return basic;

  const request: AskLlmCompleteRequest = {
    systemPrompt: [
      "This is a fixed model-service native tool-call compatibility check.",
      "Do not answer with prose or imitate a tool call in text.",
      `Call ${PROVIDER_PROBE_TOOL_NAME} exactly once with the required fixed argument.`,
    ].join(" "),
    messages: [{
      role: "user",
      content: `Call ${PROVIDER_PROBE_TOOL_NAME} with ack=${PROVIDER_PROBE_ACK}.`,
    }],
    tools: [{
      type: "function",
      name: PROVIDER_PROBE_TOOL_NAME,
      description: "A no-side-effect compatibility probe. The API validates this call but never executes it.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["ack"],
        properties: {
          ack: { type: "string", const: PROVIDER_PROBE_ACK },
        },
      },
      strict: true,
    }],
    toolChoice: configuration.providerId === "lmstudio"
      ? "required"
      : configuration.protocol === "ollama-chat"
        ? "auto"
        : { type: "function", name: PROVIDER_PROBE_TOOL_NAME },
    maxOutputTokens: 512,
  };
  try {
    const response = await provider.complete(request, signal);
    const calls = response.toolCalls ?? [];
    const call = calls[0];
    if (
      calls.length !== 1
      || !call
      || call.name !== PROVIDER_PROBE_TOOL_NAME
      || Object.keys(call.arguments).length !== 1
      || call.arguments.ack !== PROVIDER_PROBE_ACK
    ) {
      return failedToolProbe(configuration, "模型服务未返回严格匹配的原生工具调用");
    }
    return {
      providerId: configuration.providerId,
      state: "ready",
      model: response.model,
      message: "连接、模型和原生工具调用检查通过",
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof AskProviderError) {
      if (error.code === "ASK_PROVIDER_CANCELLED") throw error;
      return {
        providerId: configuration.providerId,
        state: error.availability,
        model: configuration.model,
        message: toolProbeFailureMessage(configuration, error.message),
        checkedAt: new Date().toISOString(),
      };
    }
    return failedToolProbe(configuration, "原生工具调用检查失败，未获得可识别的响应");
  }
}

function failedToolProbe(
  configuration: StoredProviderConfiguration,
  message: string,
): Awaited<ReturnType<AskLlmProvider["check"]>> {
  return {
    providerId: configuration.providerId,
    state: "protocol_error",
    model: configuration.model,
    message: toolProbeFailureMessage(configuration, message),
    checkedAt: new Date().toISOString(),
  };
}

function toolProbeFailureMessage(
  configuration: StoredProviderConfiguration,
  message: string,
): string {
  if (configuration.providerId === "openai") return message;
  return [
    message,
    "普通 Ask 和 DeepWiki 已通过基础检查；如果不需要 Agent 或 MCP，请关闭“Agent 工具调用（可选）”后重新保存、测试并启用",
  ].join("。");
}

function applyUpdate(
  current: StoredProviderConfiguration,
  input: UpdateAskProviderConfigurationInput,
): StoredProviderConfiguration {
  const endpoint = current.providerId === "openai"
    ? resolveOfficialOpenAiEndpoint(input.endpoint, input.allowInsecureHttp)
    : applySecretAction(current.endpoint, input.endpoint);
  const credential = applySecretAction(current.credential, input.credential);
  const oldOrigin = parsedOrigin(current.endpoint, current.allowInsecureHttp);
  const newOrigin = parsedOrigin(endpoint, input.allowInsecureHttp);
  if (
    current.credential
    && input.credential.action === "keep"
    && oldOrigin !== newOrigin
  ) {
    throw new AppError(
      "Provider 地址 origin 已变化；请重新填写或明确清除 Credential",
      422,
      "PROVIDER_CREDENTIAL_ORIGIN_CHANGED",
    );
  }
  if (!endpoint && credential) {
    throw new AppError(
      "没有 Provider 地址时不能保留 Credential",
      422,
      "PROVIDER_CONFIGURATION_INVALID",
    );
  }
  const now = new Date().toISOString();
  const candidate: StoredProviderConfiguration = {
    ...current,
    label: input.label,
    protocol: input.protocol,
    model: input.model,
    endpoint,
    credential,
    structuredOutput: input.structuredOutput,
    toolCalling: input.toolCalling,
    allowInsecureHttp: input.allowInsecureHttp,
    enabled: false,
    version: current.version + 1,
    configVersion: current.configVersion + 1,
    lastCheck: null,
    createdAt: current.createdAt ?? now,
    updatedAt: now,
  };
  assertEditableConfiguration(candidate);
  return candidate;
}

function resolveOfficialOpenAiEndpoint(
  action: UpdateAskProviderConfigurationInput["endpoint"],
  allowInsecureHttp: boolean,
): string {
  if (action.action === "clear") {
    throw new AppError(
      "OpenAI 官方服务地址由平台固定，不能清除；代理或兼容端点请使用 Custom",
      422,
      "PROVIDER_OPENAI_ENDPOINT_MANAGED",
    );
  }
  if (action.action === "replace") {
    let replacement: URL;
    try {
      replacement = parseAskProviderBaseUrl(
        action.value,
        "OpenAI endpoint",
        allowInsecureHttp,
      );
    } catch {
      throw new AppError(
        "OpenAI 固定槽只允许官方 https://api.openai.com/v1；代理或兼容端点请使用 Custom",
        422,
        "PROVIDER_OPENAI_ENDPOINT_NOT_OFFICIAL",
      );
    }
    if (replacement.href !== OPENAI_OFFICIAL_BASE_URL) {
      throw new AppError(
        "OpenAI 固定槽只允许官方 https://api.openai.com/v1；代理或兼容端点请使用 Custom",
        422,
        "PROVIDER_OPENAI_ENDPOINT_NOT_OFFICIAL",
      );
    }
  }
  // `keep` resolves back to the platform-owned value, so no caller-selected
  // endpoint can enter the fixed OpenAI slot.
  return OPENAI_OFFICIAL_BASE_URL;
}

function applySecretAction(
  current: string | null,
  action: UpdateAskProviderConfigurationInput["endpoint"]
    | UpdateAskProviderConfigurationInput["credential"],
): string | null {
  switch (action.action) {
    case "keep":
      return current;
    case "clear":
      return null;
    case "replace":
      return action.value;
  }
}

function assertEditableConfiguration(configuration: StoredProviderConfiguration): void {
  const fixed: Record<Exclude<AskProviderId, "custom">, {
    label: string;
    protocol: StoredProviderConfiguration["protocol"];
    structuredOutput: boolean;
  }> = {
    openai: { label: "OpenAI", protocol: "openai-responses", structuredOutput: true },
    lmstudio: { label: "LM Studio", protocol: "openai-chat", structuredOutput: true },
    ollama: { label: "Ollama", protocol: "ollama-chat", structuredOutput: true },
  };
  if (configuration.providerId !== "custom") {
    const expected = fixed[configuration.providerId];
    if (
      configuration.label !== expected.label
      || configuration.protocol !== expected.protocol
      || configuration.structuredOutput !== expected.structuredOutput
    ) {
      throw invalidConfiguration();
    }
    if (
      configuration.providerId === "openai"
      && (
        configuration.endpoint !== OPENAI_OFFICIAL_BASE_URL
        || configuration.allowInsecureHttp
        || !configuration.toolCalling
      )
    ) {
      throw invalidConfiguration();
    }
  } else if (
    configuration.protocol !== "openai-chat"
    && !configuration.structuredOutput
  ) {
    throw invalidConfiguration();
  }
  if (configuration.endpoint) {
    let baseUrl: URL;
    try {
      baseUrl = parseAskProviderBaseUrl(
        configuration.endpoint,
        "Provider endpoint",
        configuration.allowInsecureHttp,
      );
    } catch {
      throw new AppError(
        "Provider 地址无效，或 HTTP 地址没有得到明确允许",
        422,
        "PROVIDER_ENDPOINT_INVALID",
      );
    }
  }
}

function assertStoredConfiguration(configuration: StoredProviderConfiguration): void {
  try {
    assertEditableConfiguration(configuration);
    if (
      configuration.version < configuration.configVersion
      || (
        configuration.lastCheck !== null
        && configuration.lastCheck.version > configuration.version
      )
      || (
        configuration.enabled
        && (
          !isComplete(configuration)
          || configuration.lastCheck?.state !== "ready"
          || configuration.lastCheck.configVersion !== configuration.configVersion
        )
      )
    ) {
      throw new Error("invalid Provider state");
    }
  } catch {
    throw new ProviderConfigurationVaultError();
  }
}

function registrationFor(
  configuration: StoredProviderConfiguration,
  use: "active" | "check",
): AskProviderRegistration {
  assertStoredConfiguration(configuration);
  const complete = isComplete(configuration);
  const available = use === "check"
    ? complete
    : complete
      && configuration.enabled
      && configuration.lastCheck?.state === "ready"
      && configuration.lastCheck.configVersion === configuration.configVersion;
  const baseUrl = configuration.endpoint
    ? parseAskProviderBaseUrl(
      configuration.endpoint,
      "Provider endpoint",
      configuration.allowInsecureHttp,
    )
    : null;
  const dataBoundary = providerDataBoundary(configuration.providerId, baseUrl);
  const registration: AskProviderRegistration = {
    id: configuration.providerId,
    label: configuration.label,
    protocol: configuration.protocol,
    dataBoundary,
    endpointLabel: baseUrl ? safeEndpointLabel(baseUrl) : "未配置",
    structuredOutput: configuration.structuredOutput,
    toolCalling: available && configuration.toolCalling,
    options: null,
    message: providerMessage(configuration, complete, use),
  };
  if (available && baseUrl && configuration.model) {
    registration.options = {
      id: configuration.providerId,
      label: configuration.label,
      protocol: configuration.protocol,
      dataBoundary,
      baseUrl,
      model: configuration.model,
      structuredOutput: configuration.structuredOutput,
      toolCalling: configuration.toolCalling,
      ...(configuration.credential ? { apiKey: configuration.credential } : {}),
      timeoutMs: PROVIDER_TIMEOUT_MS,
      maxResponseBytes: PROVIDER_MAX_RESPONSE_BYTES,
    };
  }
  return registration;
}

function providerMessage(
  configuration: StoredProviderConfiguration,
  complete: boolean,
  use: "active" | "check",
): string {
  if (!complete) return "请先在页面补全 Provider 地址、模型和所需 Credential";
  if (use === "check") return "已保存，可以进行连接检查";
  if (!configuration.enabled) return "配置已保存但尚未启用";
  if (configuration.lastCheck?.state !== "ready") return "当前配置版本尚未通过连接检查";
  return "已配置并启用";
}

function publicConfiguration(
  configuration: StoredProviderConfiguration,
): AskProviderConfigurationDto {
  assertStoredConfiguration(configuration);
  const baseUrl = configuration.endpoint
    ? parseAskProviderBaseUrl(
      configuration.endpoint,
      "Provider endpoint",
      configuration.allowInsecureHttp,
    )
    : null;
  return askProviderConfigurationSchema.parse({
    providerId: configuration.providerId,
    label: configuration.label,
    enabled: configuration.enabled,
    configured: isComplete(configuration),
    model: configuration.model,
    protocol: configuration.protocol,
    dataBoundary: providerDataBoundary(configuration.providerId, baseUrl),
    endpointLabel: baseUrl ? safeEndpointLabel(baseUrl) : "未配置",
    hasEndpoint: Boolean(baseUrl),
    hasCredential: Boolean(configuration.credential),
    structuredOutput: configuration.structuredOutput,
    toolCalling: configuration.toolCalling,
    allowInsecureHttp: configuration.allowInsecureHttp,
    version: configuration.version,
    configVersion: configuration.configVersion,
    lastCheck: configuration.lastCheck,
    createdAt: configuration.createdAt,
    updatedAt: configuration.updatedAt,
  });
}

function providerDataBoundary(
  providerId: AskProviderId,
  baseUrl: URL | null,
): AskProviderRegistration["dataBoundary"] {
  if (!baseUrl) return "operator-configured";
  if (isLoopbackHostname(baseUrl.hostname)) return "local";
  if (providerId === "openai" && baseUrl.origin === "https://api.openai.com") {
    return "remote";
  }
  return "operator-configured";
}

function isComplete(configuration: StoredProviderConfiguration): boolean {
  return Boolean(
    configuration.endpoint
    && configuration.model
    && (configuration.providerId !== "openai" || configuration.credential),
  );
}

function parsedOrigin(endpoint: string | null, allowInsecureHttp: boolean): string | null {
  if (!endpoint) return null;
  try {
    return parseAskProviderBaseUrl(endpoint, "Provider endpoint", allowInsecureHttp).origin;
  } catch {
    throw new AppError(
      "Provider 地址无效，或 HTTP 地址没有得到明确允许",
      422,
      "PROVIDER_ENDPOINT_INVALID",
    );
  }
}

function orderedProviders(document: ProviderVaultDocument): StoredProviderConfiguration[] {
  return ["openai", "lmstudio", "ollama", "custom"].map(
    (providerId) => findProvider(document, providerId as AskProviderId),
  );
}

function findProvider(
  document: ProviderVaultDocument,
  providerId: AskProviderId,
): StoredProviderConfiguration {
  const provider = document.providers.find((candidate) => candidate.providerId === providerId);
  if (!provider) throw new ProviderConfigurationVaultError();
  return provider;
}

function assertExpectedVersion(
  configuration: StoredProviderConfiguration,
  expectedVersion: number,
): void {
  if (configuration.version !== expectedVersion) throw versionConflict();
}

function versionConflict(): AppError {
  return new AppError(
    "Provider 配置已被其他请求修改，请刷新后重试",
    409,
    "PROVIDER_CONFIGURATION_VERSION_CONFLICT",
  );
}

function invalidConfiguration(): AppError {
  return new AppError(
    "Provider 类型、协议或能力配置不匹配",
    422,
    "PROVIDER_CONFIGURATION_INVALID",
  );
}
