/** @jsxImportSource react */
// The built-in browser follows the OmniRush account. The library belongs to the account that imported it, so every
// account change refreshes it; when the desktop cleared the browser (a company account signed out, or another account
// signed in after one), the conversations' saved browser tabs go too, with what the Work browser keeps on this computer
// about the company's sites: its restore list, where Work links open and the sites set to open in another browser.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { usePanelTabStore } from "../session/panel/panel-tab-store";
import { getElectronBrowser } from "../session/panel/utils";
import { BROWSER_LIBRARY_KEY } from "./use-browser-library";

/** The Work browser's own keys in this app's storage: the restore list, the Work link choices and the sign-in row. */
export const WORK_BROWSER_STORAGE_KEYS = [
  "omnirush:work-browser:tabs:v1",
  "omnirush:work-browser:links:v1",
  "omnirush:work-browser:elsewhere:v1",
  "omnirush:work-browser:sign-in-once:v1",
] as const;

/** Forget them, and tell whatever shows them (as another window's change would). */
export function clearWorkBrowserStorage(storage: Storage = localStorage) {
  for (const key of WORK_BROWSER_STORAGE_KEYS) {
    try {
      if (storage.getItem(key) === null) continue;
      storage.removeItem(key);
      window.dispatchEvent(new StorageEvent("storage", { key, oldValue: null, newValue: null }));
    } catch {
      // Storage unavailable: nothing was kept.
    }
  }
}

export function BrowserAccountChanges() {
  const queryClient = useQueryClient();
  useEffect(() => {
    return getElectronBrowser()?.onAccountChanged?.(({ cleared }) => {
      if (cleared) {
        usePanelTabStore.getState().clearBrowserTabs();
        clearWorkBrowserStorage();
      }
      void queryClient.invalidateQueries({ queryKey: BROWSER_LIBRARY_KEY });
    });
  }, [queryClient]);
  return null;
}
