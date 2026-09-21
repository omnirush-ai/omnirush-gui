import { INFERENCE_MODEL_ALIASES } from "@omnirush/types/den/inference";

import {
  buildDenAuthUrl,
  getDenInferenceUrl,
  isSelfHostedControlPlane,
  HOSTED_DEFAULT_DEN_BASE_URL,
  readDenBootstrapConfig,
  readDenSettings,
} from "../../../app/lib/den";
import { isDefaultControlPlaneUrl } from "../settings/cloud/control-plane-url";
import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import { useSyncExternalStore } from "react";

export const OMNIRUSH_MODELS_PROVIDER_ID = "omnirush";
export const OMNIRUSH_MODELS_PROVIDER_NAME = "OmniRush.ai Models";
export const OMNIRUSH_MODELS_PROMO_HIDDEN_KEY = "omnirush.omnirushModelsPromo.hidden";
export const OMNIRUSH_MODELS_PROMO_LAST_SHOWN_KEY = "omnirush.omnirushModelsPromo.lastShownAt";
export const OMNIRUSH_MODELS_STARTUP_PROMO_SHOWN_KEY = "omnirush.omnirushModelsPromo.startupShown";
export const omniRushModelsPromoChangedEvent = "omnirush-omnirush-models-promo-changed";
export const OMNIRUSH_MODELS_PROMO_SHOW_DELAY_MS = 4_000;
export const OMNIRUSH_MODELS_PROMO_VISIBLE_MS = 14_000;
export const OMNIRUSH_MODELS_PROMO_REPEAT_MS = 6 * 60 * 60 * 1000;

export function areOmniRushModelsPromosDisabled() {
  if (/^(1|true|yes|on)$/i.test(String(import.meta.env.VITE_DISABLE_OMNIRUSH_MODELS ?? "").trim())) {
    return true;
  }
  // OmniRush.ai Models are a hosted OmniRush.ai Cloud offering; self-hosted
  // deployments should never see the upsell surfaces.
  return isSelfHostedControlPlane();
}

export function isOmniRushModelsPromoEligibleForDenBaseUrl(baseUrl: string) {
  return !areOmniRushModelsPromosDisabled() && isDefaultControlPlaneUrl(baseUrl, HOSTED_DEFAULT_DEN_BASE_URL);
}

export function isOmniRushModelsPromoEligible() {
  return isOmniRushModelsPromoEligibleForDenBaseUrl(readDenSettings().baseUrl);
}

export function useOmniRushModelsPromoEligibility() {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined") return () => undefined;
      window.addEventListener(denSettingsChangedEvent, notify);
      return () => window.removeEventListener(denSettingsChangedEvent, notify);
    },
    isOmniRushModelsPromoEligible,
    isOmniRushModelsPromoEligible,
  );
}

export type OmniRushModelPreview = {
  id: string;
  title: string;
  subtitle: string;
};

export const OMNIRUSH_MODEL_PREVIEWS: OmniRushModelPreview[] = Object.entries(
  INFERENCE_MODEL_ALIASES,
)
  .filter(([, model]) => model.enabled)
  .map(([id, model]) => ({
    id,
    title: model.displayName.replace(/^OmniRush.ai:\s*/, ""),
    subtitle: "OmniRush.ai hosted",
  }));

export function hasOmniRushModelsProvider(providerIds: readonly string[]) {
  return providerIds.some((id) => id.trim().toLowerCase() === OMNIRUSH_MODELS_PROVIDER_ID);
}

/** Local engine has OmniRush.ai Models connected with at least one selectable model. */
export function hasOmniRushModelsAvailable(input: {
  providerConnectedIds: readonly string[];
  providers: ReadonlyArray<{ id: string; models?: Record<string, unknown> | null }>;
}) {
  if (!hasOmniRushModelsProvider(input.providerConnectedIds)) return false;
  const omnirush = input.providers.find(
    (provider) => provider.id.trim().toLowerCase() === OMNIRUSH_MODELS_PROVIDER_ID,
  );
  return Object.keys(omnirush?.models ?? {}).length > 0;
}

export function shouldShowOmniRushModelsSyncing(input: {
  entitled: boolean;
  available: boolean;
  workspaceReady: boolean;
  reloadPending: boolean;
}) {
  return input.entitled && !input.available && input.workspaceReady && input.reloadPending;
}

export function getOmniRushModelsActionUrl(
  isSignedIn: boolean,
  authMode: "sign-in" | "sign-up" = "sign-in",
) {
  const settings = readDenSettings();
  const baseUrl = settings.baseUrl || readDenBootstrapConfig().baseUrl;
  // Signed-in users go straight to the OmniRush.ai Models page — the value-prop
  // + subscribe surface — never to a bare auth or billing page.
  return isSignedIn ? getDenInferenceUrl(baseUrl) : buildDenAuthUrl(baseUrl, authMode);
}

export function isOmniRushModelsPromoHidden() {
  if (areOmniRushModelsPromosDisabled()) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(OMNIRUSH_MODELS_PROMO_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function hideOmniRushModelsPromo() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OMNIRUSH_MODELS_PROMO_HIDDEN_KEY, "1");
    window.dispatchEvent(new Event(omniRushModelsPromoChangedEvent));
  } catch {}
}

export function wasOmniRushModelsStartupPromoShown() {
  if (!isOmniRushModelsPromoEligible()) return true;
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(OMNIRUSH_MODELS_STARTUP_PROMO_SHOWN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markOmniRushModelsStartupPromoShown() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OMNIRUSH_MODELS_STARTUP_PROMO_SHOWN_KEY, "1");
  } catch {}
}

export function shouldShowOmniRushModelsPromo(now = Date.now()) {
  if (!isOmniRushModelsPromoEligible() || typeof window === "undefined" || isOmniRushModelsPromoHidden()) return false;
  try {
    const lastShown = Number(window.localStorage.getItem(OMNIRUSH_MODELS_PROMO_LAST_SHOWN_KEY) ?? "0");
    return !Number.isFinite(lastShown) || now - lastShown >= OMNIRUSH_MODELS_PROMO_REPEAT_MS;
  } catch {
    return true;
  }
}

export function markOmniRushModelsPromoShown(now = Date.now()) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OMNIRUSH_MODELS_PROMO_LAST_SHOWN_KEY, String(now));
  } catch {}
}
