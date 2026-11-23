// The built-in browser's library in the renderer: the desktop bridge, the queries every surface shares, and who sees
// it. Importing from other browsers, the star, the bookmarks menu, address bar suggestions and the new-tab tiles are a
// Work feature: an account with Work on (a company account, or Work turned on for it). Everyone else keeps the
// browser exactly as before.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { BrowserImportSources, BrowserLibraryBridge } from "@/app/lib/desktop";
import { isElectronRuntime } from "@/app/utils";

import { useEnterpriseFlags } from "../work/enterprise-mode";
import { useCachedWorkState } from "../work/work-state-cache";

export function getBrowserLibraryBridge(): BrowserLibraryBridge | null {
  if (!isElectronRuntime()) return null;
  return window.__OMNIRUSH_ELECTRON__?.browserLibrary ?? null;
}

/** Every library query starts with this key, so one invalidation refreshes the star, menus, tiles and Settings. */
export const BROWSER_LIBRARY_KEY = ["browser-library"] as const;
export const browserLibraryKeys = {
  sources: [...BROWSER_LIBRARY_KEY, "sources"] as const,
  summary: [...BROWSER_LIBRARY_KEY, "summary"] as const,
  bookmarks: [...BROWSER_LIBRARY_KEY, "bookmarks"] as const,
  top: [...BROWSER_LIBRARY_KEY, "top"] as const,
  starred: (url: string) => [...BROWSER_LIBRARY_KEY, "starred", url] as const,
  inspect: (sourceId: string) => [...BROWSER_LIBRARY_KEY, "inspect", sourceId] as const,
};

/** Whether this account has Work: a company account, or Work turned on for it (the Work state the app holds). */
export function useWorkUser(): boolean {
  const enterprise = useEnterpriseFlags();
  const workOn = useCachedWorkState() !== null;
  return enterprise.on || workOn;
}

/** The library is here: the desktop app, for a Work account. */
export function useBrowserLibraryAvailable(): boolean {
  const workUser = useWorkUser();
  return workUser && getBrowserLibraryBridge() !== null;
}

/** Browsers on this computer. Listing reads folder names only (and the names the browsers give their profiles). */
export function useBrowserImportSources(enabled: boolean) {
  return useQuery<BrowserImportSources>({
    queryKey: browserLibraryKeys.sources,
    queryFn: () => getBrowserLibraryBridge()!.sources(),
    enabled: enabled && getBrowserLibraryBridge() !== null,
    staleTime: 30_000,
    retry: false,
  });
}

export function useInvalidateBrowserLibrary() {
  const queryClient = useQueryClient();
  return useCallback(() => queryClient.invalidateQueries({ queryKey: BROWSER_LIBRARY_KEY }), [queryClient]);
}

/** Browsers people usually mean first when they say "my browser". */
const OFFER_ORDER = ["chrome", "edge", "arc", "safari", "firefox", "brave", "vivaldi", "chromium"];

/** The browser to name in the one-line offer: the first found that has something to bring. */
export function offerBrowser(sources: BrowserImportSources | undefined) {
  const usable = (sources?.browsers ?? []).filter((browser) => browser.profiles.some((profile) => profile.has.bookmarks || profile.has.history || profile.has.signIns));
  return usable.sort((left, right) => OFFER_ORDER.indexOf(left.browser) - OFFER_ORDER.indexOf(right.browser))[0] ?? null;
}
