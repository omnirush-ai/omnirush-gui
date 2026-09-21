const DIRECT_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
] as const;

const directProviderSet = new Set<string>(DIRECT_PROVIDER_IDS);

export function isInternalModelProvider(providerID: string) {
  const normalized = providerID.trim().toLowerCase();
  return normalized === "omnirush" || /^lpr_/.test(normalized);
}

export function isDirectModelProvider(providerID: string) {
  return directProviderSet.has(providerID.trim().toLowerCase());
}

export function isSupportedModelProvider(providerID: string) {
  return isInternalModelProvider(providerID) || isDirectModelProvider(providerID);
}

export function providerCatalogRank(providerID: string) {
  const normalized = providerID.trim().toLowerCase();
  if (isInternalModelProvider(normalized)) return 0;
  const directIndex = DIRECT_PROVIDER_IDS.findIndex((providerID) => providerID === normalized);
  return directIndex < 0 ? Number.MAX_SAFE_INTEGER : directIndex + 1;
}
