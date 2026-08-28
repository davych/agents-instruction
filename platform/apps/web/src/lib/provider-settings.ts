import type {
  AskProviderConfiguration,
  AskProviderConfigurationCheck,
  AskProviderId,
  AskProviderStatus,
} from "@/lib/types";

export function providerEnabled(provider: AskProviderStatus | AskProviderConfiguration): boolean {
  return provider.configured && (!("providerId" in provider) || provider.enabled);
}

export function providerSelectionState(
  selectedProviderId: AskProviderId | undefined,
  providers: readonly AskProviderStatus[],
) {
  const availableProviders = providers.filter(providerEnabled);
  const selectedProvider = providers.find(({ id }) => id === selectedProviderId);
  const selectedAvailable = Boolean(selectedProvider && providerEnabled(selectedProvider));
  return {
    availableProviders,
    selectedProvider,
    selectedAvailable,
    requiresSelection: Boolean(selectedProviderId) && !selectedAvailable,
  };
}

export function currentProviderCheck(
  provider: AskProviderConfiguration,
  candidate?: AskProviderConfigurationCheck | null,
): AskProviderConfigurationCheck | null {
  return [candidate, provider.lastCheck]
    .filter((check): check is AskProviderConfigurationCheck => Boolean(
      check
      && check.providerId === provider.providerId
      && check.configVersion === provider.configVersion,
    ))
    .reduce<AskProviderConfigurationCheck | null>((latest, check) => (
      !latest || check.version >= latest.version ? check : latest
    ), null);
}

export function providerCardActions(
  provider: AskProviderConfiguration,
  candidate?: AskProviderConfigurationCheck | null,
) {
  const check = currentProviderCheck(provider, candidate);
  const expectedEnableVersion = provider.configured
    && !provider.enabled
    && check?.state === "ready"
    ? Math.max(provider.version, check.version)
    : null;
  return {
    check,
    canCheck: provider.configured,
    canEnable: expectedEnableVersion !== null,
    canDisable: provider.configured && provider.enabled,
    expectedEnableVersion,
  };
}
