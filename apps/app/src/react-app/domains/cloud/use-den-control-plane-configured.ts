import { useSyncExternalStore } from "react";

import { isDenControlPlaneConfigured } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";

function subscribeToDenSettings(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(denSettingsChangedEvent, onStoreChange);
  return () => window.removeEventListener(denSettingsChangedEvent, onStoreChange);
}

/**
 * True while some source (build env, desktop-bootstrap.json, a connect link,
 * the local gateway, or the user's settings) provides a Den control plane.
 * omnirush.ai ships without a hosted Den, so browser sign-in entry points
 * hide themselves until a server URL exists; `buildDenAuthUrl` throws
 * otherwise.
 */
export function useDenControlPlaneConfigured(): boolean {
  return useSyncExternalStore(
    subscribeToDenSettings,
    isDenControlPlaneConfigured,
    isDenControlPlaneConfigured,
  );
}
