/** @jsxImportSource react */
// The built-in browser follows the OmniRush account. The library belongs to the account that imported it, so every
// account change refreshes it; when the desktop cleared the browser (a company account signed out, or another account
// signed in after one), the conversations' saved browser tabs go too.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { usePanelTabStore } from "../session/panel/panel-tab-store";
import { getElectronBrowser } from "../session/panel/utils";
import { BROWSER_LIBRARY_KEY } from "./use-browser-library";

export function BrowserAccountChanges() {
  const queryClient = useQueryClient();
  useEffect(() => {
    return getElectronBrowser()?.onAccountChanged?.(({ cleared }) => {
      if (cleared) usePanelTabStore.getState().clearBrowserTabs();
      void queryClient.invalidateQueries({ queryKey: BROWSER_LIBRARY_KEY });
    });
  }, [queryClient]);
  return null;
}
