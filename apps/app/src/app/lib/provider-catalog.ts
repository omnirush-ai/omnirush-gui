import { isProviderAllowedByLock, isProviderLocked } from "./provider-lock";

const DIRECT_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
] as const;

const directProviderSet = new Set<string>(DIRECT_PROVIDER_IDS);

export function isInternalModelProvider(providerID: string) {
  const normalized = providerID.trim().toLowerCase();
  return normalized === "omnirush" || normalized === "omnirush-claude" || /^lpr_/.test(normalized);
}

export function isDirectModelProvider(providerID: string) {
  return directProviderSet.has(providerID.trim().toLowerCase());
}

// Model pickers list only omnirush.ai (and org-assigned) models, which come
// from the account's catalog. Providers from the user's own engine config
// (their OpenAI, Anthropic, … keys) come back with
// VITE_OMNIRUSH_ALLOW_OTHER_PROVIDERS=1 at build time.
const OTHER_PROVIDERS_ALLOWED = import.meta.env.VITE_OMNIRUSH_ALLOW_OTHER_PROVIDERS === "1";

export function isSupportedModelProvider(providerID: string, allowOtherProviders = OTHER_PROVIDERS_ALLOWED) {
  // While the server locks model providers (provider-lock.ts), only the ones it allows, whatever the build says.
  if (isProviderLocked()) return isProviderAllowedByLock(providerID);
  return isInternalModelProvider(providerID) || (allowOtherProviders && isDirectModelProvider(providerID));
}

/** The provider whose group lists a model: Claude's are shown under omnirush.ai (display only; a pick keeps `omnirush-claude`, which routes it). */
export function providerDisplayGroup(providerID: string) {
  return providerID.trim().toLowerCase() === "omnirush-claude" ? "omnirush" : providerID;
}

/** Order within a group: the gateway's own models (GPT, Kimi) first, Claude's after them, then by title. */
export function compareGroupModels(a: { providerID: string; title: string }, b: { providerID: string; title: string }) {
  const claude = (option: { providerID: string }) => (providerDisplayGroup(option.providerID) === option.providerID ? 0 : 1);
  return claude(a) - claude(b) || a.title.localeCompare(b.title);
}

export function providerCatalogRank(providerID: string) {
  const normalized = providerID.trim().toLowerCase();
  if (isInternalModelProvider(normalized)) return 0;
  const directIndex = DIRECT_PROVIDER_IDS.findIndex((providerID) => providerID === normalized);
  return directIndex < 0 ? Number.MAX_SAFE_INTEGER : directIndex + 1;
}
