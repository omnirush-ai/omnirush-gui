/** @jsxImportSource react */
// The mark on a tab of the person's own browser: the app's own logo for a known site (brands.ts), else the page's own
// icon from the browser, else a globe, so tabs that share a title can still be told apart. No icon is fetched from
// anywhere else.
import type { BrowserPanelTab } from "@omnirush/browser-tabs";
import { Globe, Loader2 } from "lucide-react";
import * as React from "react";

import { ConnectorIcon } from "../brand-icon";
import { isBrowserHomeTab, siteBrand } from "./work-browser";

/** A tab's mark: the app's own logo for a known site, else the page's icon, else a globe. Never empty. */
export function TabMark({ tab }: { tab: BrowserPanelTab }) {
  const [broken, setBroken] = React.useState<string | null>(null);
  if (tab.status === "loading" || tab.status === "restoring") return <Loader2 className="animate-spin" />;
  if (isBrowserHomeTab(tab)) return <Globe />;
  const brand = siteBrand(tab.url);
  if (brand) return <ConnectorIcon id={brand} className="size-3.5" />;
  // A page icon that does not load (none on the site, or gone) falls back to the globe.
  if (tab.favicon && broken !== tab.favicon) {
    return <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-[2px]" onError={() => setBroken(tab.favicon)} data-testid="work-browser-tab-favicon" />;
  }
  return <Globe data-testid="work-browser-tab-globe" />;
}
