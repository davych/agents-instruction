import type {
  AskProviderCheckDto,
  AskProviderId,
  AskProviderStatusDto,
} from "@ai-sdlc/contracts";

import {
  loadAskProviderConfigurations,
  type AskProviderRegistration,
} from "./config.js";
import { OpenAiChatProvider } from "./openai-chat-provider.js";
import { OpenAiResponsesProvider } from "./openai-responses-provider.js";
import { OllamaChatProvider } from "./ollama-chat-provider.js";
import {
  AskProviderError,
  unavailableCheck,
  type AskLlmCompleteRequest,
  type AskLlmCompleteResponse,
  type AskLlmProvider,
} from "./types.js";

const PROVIDER_ORDER: readonly AskProviderId[] = [
  "openai",
  "lmstudio",
  "ollama",
  "custom",
];

export class AskProviderRegistry {
  private readonly providers: ReadonlyMap<AskProviderId, AskLlmProvider>;

  constructor(providers: readonly AskLlmProvider[]) {
    const entries = new Map<AskProviderId, AskLlmProvider>();
    for (const provider of providers) {
      if (entries.has(provider.id)) throw new Error(`Ask Provider 重复注册：${provider.id}`);
      entries.set(provider.id, provider);
    }
    for (const id of PROVIDER_ORDER) {
      if (!entries.has(id)) throw new Error(`Ask Provider 未注册：${id}`);
    }
    this.providers = entries;
  }

  statuses(): AskProviderStatusDto[] {
    return PROVIDER_ORDER.map((id) => this.get(id).status());
  }

  status(providerId: AskProviderId): AskProviderStatusDto {
    return this.get(providerId).status();
  }

  check(providerId: AskProviderId, signal?: AbortSignal): Promise<AskProviderCheckDto> {
    return this.get(providerId).check(signal);
  }

  complete(
    providerId: AskProviderId,
    request: AskLlmCompleteRequest,
    signal?: AbortSignal,
  ): Promise<AskLlmCompleteResponse> {
    return this.get(providerId).complete(request, signal);
  }

  get(providerId: AskProviderId): AskLlmProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`未知 Ask Provider：${providerId}`);
    return provider;
  }
}

export function createAskProviderRegistry(
  configurations: readonly AskProviderRegistration[],
): AskProviderRegistry {
  return new AskProviderRegistry(configurations.map(createProvider));
}

export function createAskProviderRegistryFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AskProviderRegistry {
  return createAskProviderRegistry(loadAskProviderConfigurations(environment));
}

function createProvider(registration: AskProviderRegistration): AskLlmProvider {
  if (!registration.options) return new UnconfiguredProvider(registration);
  switch (registration.options.protocol) {
    case "openai-responses":
      return new OpenAiResponsesProvider(registration.options);
    case "openai-chat":
      return new OpenAiChatProvider(registration.options);
    case "ollama-chat":
      return new OllamaChatProvider(registration.options);
  }
}

class UnconfiguredProvider implements AskLlmProvider {
  readonly id;

  constructor(private readonly registration: AskProviderRegistration) {
    this.id = registration.id;
  }

  status(): AskProviderStatusDto {
    return {
      id: this.id,
      label: this.registration.label,
      configured: false,
      model: null,
      protocol: this.registration.protocol,
      dataBoundary: this.registration.dataBoundary,
      endpointLabel: this.registration.endpointLabel,
      capabilities: {
        streaming: false,
        structuredOutput: this.registration.structuredOutput,
        toolCalling: false,
      },
      message: this.registration.message,
    };
  }

  async check(): Promise<AskProviderCheckDto> {
    return unavailableCheck(this.id, null, this.registration.message);
  }

  async complete(): Promise<AskLlmCompleteResponse> {
    throw new AskProviderError(
      this.id,
      "ASK_PROVIDER_NOT_CONFIGURED",
      this.registration.message,
      "not_configured",
      503,
      false,
    );
  }
}
