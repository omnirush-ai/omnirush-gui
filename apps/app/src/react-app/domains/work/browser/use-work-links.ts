// Work links in the renderer: the router every Work page and record viewer opens links through, the person's choices
// (kept on this computer) and the company's setting from the Work state. The company's setting is read from the
// `browser` block of the Work state the app already holds (the `work.browser` capability); no request of its own.
import { USER_TABS_OWNER } from "@omnirush/browser-tabs";
import * as React from "react";

import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { usePlatform } from "@/react-app/kernel/platform";

import { useBrowserLibraryAvailable } from "../../browser-logins/use-browser-library";
import { getElectronBrowser } from "../../session/panel/utils";
import { useEnterpriseFlags } from "../enterprise-mode";
import { useCachedWorkState } from "../work-state-cache";
import {
  type ElsewhereHost,
  linksInApp,
  type OpenWorkLink,
  readElsewhereHosts,
  readLinksChoice,
  WORK_LINKS_CHANGED_EVENT,
  workLinkPolicy,
  type WorkLinkPolicy,
  workLinkTarget,
} from "./work-links";

/** The company's link setting, with its name for "Set by <company>". */
export function useWorkLinkPolicy(): WorkLinkPolicy {
  const enterprise = useEnterpriseFlags();
  const state = useCachedWorkState();
  return React.useMemo(() => {
    const policy = workLinkPolicy(state);
    return { ...policy, orgName: policy.orgName ?? enterprise.orgName ?? null };
  }, [state, enterprise.orgName]);
}

function subscribeChoices(notify: () => void) {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(WORK_LINKS_CHANGED_EVENT, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(WORK_LINKS_CHANGED_EVENT, notify);
    window.removeEventListener("storage", notify);
  };
}

/** The person's "Open links from Work in" (null until they choose). */
export function useLinksChoice(): boolean | null {
  return React.useSyncExternalStore(subscribeChoices, () => readLinksChoice(), () => null);
}

/** Sites set to always open in another browser. */
export function useElsewhereHosts(): ElsewhereHost[] {
  const raw = React.useSyncExternalStore(subscribeChoices, () => JSON.stringify(readElsewhereHosts()), () => "[]");
  return React.useMemo(() => JSON.parse(raw) as ElsewhereHost[], [raw]);
}

/** The person's default browser by name, asked once (null: "your browser"). */
let defaultBrowserName: Promise<string | null> | null = null;
export function useDefaultBrowserName(): string | null {
  const [name, setName] = React.useState<string | null>(null);
  React.useEffect(() => {
    const browser = getElectronBrowser();
    if (!browser?.defaultBrowser) return;
    defaultBrowserName ??= browser.defaultBrowser().then((answer) => answer?.name ?? null).catch(() => null);
    let current = true;
    void defaultBrowserName.then((value) => { if (current) setName(value); });
    return () => { current = false; };
  }, []);
  return name;
}

const isTabLimit = (error: unknown) => /browser tabs open/i.test(error instanceof Error ? error.message : String(error));

/**
 * A tab beside Work: the side panel opens on it (the browser says so when the tab is created). At the live tab limit the
 * person chooses to suspend their oldest tab; nothing is closed or suspended without that choice.
 */
export async function openInWorkPanel(url: string, panelKey: string = USER_TABS_OWNER): Promise<void> {
  const browser = getElectronBrowser();
  if (!browser?.createTab) return;
  try {
    await browser.createTab(url, panelKey);
  } catch (error) {
    if (!isTabLimit(error)) {
      toast.error(error instanceof Error ? error.message : String(error));
      return;
    }
    // The page beside Work is a native view drawn over the app: while this choice shows, it steps aside (an occluder)
    // so the toast is never hidden under it.
    toast(React.createElement("span", { "data-browser-occluder": "" }, t("work_links.limit_title")), {
      description: t("work_links.limit_body"),
      duration: 10_000,
      action: {
        label: t("work_browser.limit_suspend"),
        onClick: () => {
          void (async () => {
            const suspended = await browser.suspendOldest?.(USER_TABS_OWNER).catch(() => null);
            if (suspended) await openInWorkPanel(url, panelKey);
            else toast(t("work_browser.limit_none"));
          })();
        },
      },
    });
  }
}

/**
 * Opens a Work link where it belongs (see work-links.ts). `panelKey`: the side panel that shows the tab (a record
 * viewer passes its own; Work pages use the person's tabs). Outside a Work account in the desktop app every link opens
 * in the person's browser, as before.
 */
export function useOpenWorkLink(panelKey: string = USER_TABS_OWNER): OpenWorkLink {
  const platform = usePlatform();
  const available = useBrowserLibraryAvailable();
  const policy = useWorkLinkPolicy();
  const choice = useLinksChoice();
  const elsewhere = useElsewhereHosts();
  return React.useCallback((url, options) => {
    const target = available ? workLinkTarget(url, { inApp: linksInApp(policy, choice), external: options?.external, elsewhere }) : { kind: "system" as const };
    if (target.kind === "panel") {
      void openInWorkPanel(url, panelKey);
      return;
    }
    const openElsewhere = target.kind === "elsewhere" ? getElectronBrowser()?.openElsewhere : undefined;
    if (target.kind === "elsewhere" && openElsewhere) {
      void openElsewhere(url, target.browserId).catch(() => platform.openLink(url));
      return;
    }
    platform.openLink(url);
  }, [available, choice, elsewhere, panelKey, platform, policy]);
}

/** Tells the desktop browser a Work account is signed in (passkey guard, blocked sign-in bar, site sign-in sheet). */
export function useWorkBrowserFeatures(enabled: boolean) {
  React.useEffect(() => {
    void getElectronBrowser()?.setWorkFeatures?.(enabled)?.catch(() => undefined);
  }, [enabled]);
}
