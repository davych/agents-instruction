import { AsyncLocalStorage } from "node:async_hooks";

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
  private providers: ReadonlyMap<AskProviderId, ProviderSnapshot>;
  private readonly pinned = new AsyncLocalStorage<ReadonlyMap<AskProviderId, ProviderSnapshot>>();

  constructor(providers: readonly AskLlmProvider[]) {
    const entries = new Map<AskProviderId, ProviderSnapshot>();
    for (const provider of providers) {
      if (entries.has(provider.id)) throw new Error(`Ask Provider 重复注册：${provider.id}`);
      entries.set(provider.id, { provider, recordVersion: 1 });
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
    return this.snapshot(providerId).provider;
  }

  recordVersion(providerId: AskProviderId): number {
    return this.snapshot(providerId).recordVersion;
  }

  /**
   * Atomically publishes one immutable Provider implementation for future
   * requests. Async work already running inside runWithProvider keeps the
   * exact endpoint/key snapshot it started with.
   */
  replace(
    providerId: AskProviderId,
    provider: AskLlmProvider,
    recordVersion: number,
  ): void {
    if (provider.id !== providerId) {
      throw new Error("Ask Provider replacement identity mismatch");
    }
    if (!Number.isSafeInteger(recordVersion) || recordVersion < 1) {
      throw new Error("Ask Provider record version 无效");
    }
    const current = this.providers.get(providerId);
    if (current && recordVersion < current.recordVersion) {
      throw new Error("Ask Provider 拒绝发布旧 record version");
    }
    const next = new Map(this.providers);
    next.set(providerId, { provider, recordVersion });
    this.providers = next;
  }

  runWithProvider<T>(
    providerId: AskProviderId,
    operation: () => T,
  ): T {
    const inherited = this.pinned.getStore();
    if (inherited?.has(providerId)) return operation();
    const next = new Map(inherited ?? []);
    next.set(providerId, this.currentSnapshot(providerId));
    return this.pinned.run(next, operation);
  }

  private snapshot(providerId: AskProviderId): ProviderSnapshot {
    return this.pinned.getStore()?.get(providerId) ?? this.currentSnapshot(providerId);
  }

  private currentSnapshot(providerId: AskProviderId): ProviderSnapshot {
    const snapshot = this.providers.get(providerId);
    if (!snapshot) throw new Error(`未知 Ask Provider：${providerId}`);
    return snapshot;
  }
}

interface ProviderSnapshot {
  provider: AskLlmProvider;
  recordVersion: number;
}

export function createAskProviderRegistry(
  configurations: readonly AskProviderRegistration[],
): AskProviderRegistry {
  return new AskProviderRegistry(configurations.map(createAskProvider));
}

export function createAskProviderRegistryFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AskProviderRegistry {
  return createAskProviderRegistry(loadAskProviderConfigurations(environment));
}

export function createAskProvider(registration: AskProviderRegistration): AskLlmProvider {
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
