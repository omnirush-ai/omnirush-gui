/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { resolveProviderDisplayName } from "@/app/utils";
import { isSupportedModelProvider } from "@/app/lib/provider-catalog";
import {
  newProvidersEvent,
  readSeenProviderIds,
  markProvidersSeen,
  type NewProviderInfo,
  type NewProvidersEventDetail,
} from "@/app/lib/provider-events";
import { t } from "@/i18n";
import { NEW_PROVIDERS_DEDUPE_KEY, useNotificationStore } from "@/react-app/kernel/notification-store";
import { notifyEvent } from "./notifications";
import { orgOnboardingVisibilityEvent } from "./reload-coordinator";

const PENDING_MODEL_PICKER_KEY = "omnirush.pendingModelPickerProviderIds";

/** Custom event to request the model picker to open. */
export const openModelPickerEvent = "omnirush-open-model-picker";
/** Custom event to request the provider auth (connect API keys) modal to open. */
export const openProviderAuthEvent = "omnirush-open-provider-auth";
export const pendingModelPickerProviderIdsKey = PENDING_MODEL_PICKER_KEY;


/**
 * Open the model picker focused on the given new providers. If no session
 * surface picks the event up, fall back to navigating to preferences.
 */
export function requestOpenModelPicker(providerIds: string[]): void {
  try {
    window.localStorage.setItem(
      PENDING_MODEL_PICKER_KEY,
      JSON.stringify({ newProviderIds: providerIds, initialTab: "available" }),
    );
  } catch {}
  window.dispatchEvent(
    new CustomEvent(openModelPickerEvent, {
      detail: { newProviderIds: providerIds, initialTab: "available" },
    }),
  );
  window.setTimeout(() => {
    try {
      if (window.localStorage.getItem(PENDING_MODEL_PICKER_KEY)) {
        const path = window.location.hash.replace(/^#/, "") || "/settings/preferences";
        const match = path.match(/^\/workspace\/([^/]+)/);
        window.location.hash = match?.[1]
          ? `/workspace/${match[1]}/settings/preferences`
          : "/settings/preferences";
      }
    } catch {}
  }, 0);
}

type ListenerState = {
  active: boolean;
  providers: NewProviderInfo[];
  newProviderCount: number;
  newModelCount: number;
};

const EMPTY_STATE: ListenerState = {
  active: false,
  providers: [],
  newProviderCount: 0,
  newModelCount: 0,
};

/**
 * Headless listener: converts "new providers available" events (cloud sync,
 * sign-in, local config changes) into a single coalesced notification center
 * entry instead of a popup. Accumulates until the entry is read, so repeated
 * syncs update one entry with the full summary.
 */
export function NewProvidersListener() {
  const [state, setState] = useState<ListenerState>(EMPTY_STATE);
  const [orgOnboardingVisible, setOrgOnboardingVisible] = useState(false);
  const [pendingProviders, setPendingProviders] = useState<NewProviderInfo[]>([]);

  const showProviders = useCallback((detail: NewProvidersEventDetail) => {
    const seen = readSeenProviderIds();
    const genuinelyNew = detail.providers.filter((p) => !seen.has(p.id));
    const newProviderCount = Math.min(
      detail.newProviderCount ?? genuinelyNew.length,
      genuinelyNew.length,
    );
    const newModelCount = detail.newModelCount ?? 0;
    if (newProviderCount === 0 && newModelCount === 0) return;

    // Remember synchronously so duplicate sync sources cannot both announce
    // a provider before React writes the notification. Onboarding owns sign-in.
    markProvidersSeen(detail.providers.map((provider) => provider.id));
    if (detail.source === "sign_in") return;

    setState((prev) => ({
      active: true,
      providers: prev.active
        ? [...prev.providers, ...detail.providers.filter((p) => !prev.providers.some((e) => e.id === p.id))]
        : detail.providers,
      newProviderCount: prev.active
        ? prev.newProviderCount + newProviderCount
        : newProviderCount,
      newModelCount: prev.active
        ? prev.newModelCount + newModelCount
        : newModelCount,
    }));
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<NewProvidersEventDetail>).detail;
      // Cloud sync uses Den IDs; its imports become supported lpr_* providers.
      // Local catalog sources use engine IDs and must obey the picker allowlist.
      const providers = detail.source === "cloud_sync" || detail.source === "sign_in"
        ? detail.providers
        : detail.providers.filter((provider) => isSupportedModelProvider(provider.id));
      if (detail.providers.length > 0 && providers.length === 0) return;
      if (providers.length === 0 && !detail.newModelCount) return;
      if (orgOnboardingVisible) {
        setPendingProviders((current) => [
          ...current,
          ...providers.filter((p) => !current.some((existing) => existing.id === p.id)),
        ]);
        return;
      }
      showProviders({ ...detail, providers });
    };
    window.addEventListener(newProvidersEvent, handler);
    return () => window.removeEventListener(newProvidersEvent, handler);
  }, [orgOnboardingVisible, showProviders]);

  useEffect(() => {
    const handler = (event: Event) => {
      setOrgOnboardingVisible(Boolean((event as CustomEvent<{ visible?: boolean }>).detail?.visible));
    };
    window.addEventListener(orgOnboardingVisibilityEvent, handler);
    return () => window.removeEventListener(orgOnboardingVisibilityEvent, handler);
  }, []);

  useEffect(() => {
    if (orgOnboardingVisible || pendingProviders.length === 0) return;
    showProviders({ providers: pendingProviders, source: "cloud_sync" });
    setPendingProviders([]);
  }, [orgOnboardingVisible, pendingProviders, showProviders]);

  // Write the accumulated summary into the notification center. The dedupe
  // key keeps one unread entry that absorbs repeated provider syncs.
  useEffect(() => {
    if (!state.active || (state.providers.length === 0 && state.newModelCount === 0)) {
      return;
    }

    const parts: string[] = [];
    if (state.newProviderCount > 0) {
      parts.push(`${state.newProviderCount} new ${state.newProviderCount === 1 ? "provider" : "providers"}`);
    }
    if (state.newModelCount > 0) {
      parts.push(`${state.newModelCount} new ${state.newModelCount === 1 ? "model" : "models"}`);
    }
    const summary =
      parts.join(" & ") ||
      resolveProviderDisplayName(
        state.providers[0]?.name || state.providers[0]?.providerId || "Models",
      );

    notifyEvent({
      kind: "providers",
      severity: "info",
      dedupeKey: NEW_PROVIDERS_DEDUPE_KEY,
      title: `${summary} available`,
      action: {
        type: "open-model-picker",
        providerIds: state.providers.map((p) => p.id),
      },
      actionLabel: t("notifications.select_model"),
    });
  }, [state]);

  // Once the entry is read (or cleared), restart accumulation so the next
  // sync produces a fresh unread entry.
  useEffect(
    () =>
      useNotificationStore.subscribe((store) => {
        const unread = store.notifications.some(
          (notification) =>
            notification.dedupeKey === NEW_PROVIDERS_DEDUPE_KEY && notification.readAt === null,
        );
        if (!unread) {
          setState((prev) => (prev.active ? EMPTY_STATE : prev));
        }
      }),
    [],
  );

  return null;
}
