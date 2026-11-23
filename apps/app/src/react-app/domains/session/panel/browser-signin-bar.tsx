/** @jsxImportSource react */
// A sign-in this browser cannot finish (Work accounts), so a tab is never a dead end: Google refusing sign-in here,
// a Microsoft sign-in that needs a managed device, a passkey that never answered, or a site asking an agent's tab for a
// password. One bar above the page: "Open in <browser>" (the app the person was going to), "Always open <host>
// there" (kept on this computer), and dismiss. Nothing about the sign-in leaves this computer.
import type { BrowserPanelTab } from "@omnirush/browser-tabs";
import { KeyRound, LockKeyhole, X } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";

import { useBrowserLibraryAvailable } from "../../browser-logins/use-browser-library";
import { ConnectorIcon } from "../../work/brand-icon";
import { addElsewhereHost } from "../../work/browser/work-links";
import { reportBrowserError } from "./browser-surface";
import { getElectronBrowser } from "./utils";

type Blocked = NonNullable<BrowserPanelTab["blockedSignIn"]>;

export function blockedSignInMessage(blocked: Blocked, browser: string): string {
  switch (blocked.kind) {
    case "google": return t("work_links.blocked_google", { browser });
    case "microsoft_device": return t("work_links.blocked_microsoft", { browser });
    case "passkey": return t("work_links.blocked_passkey", { browser });
    default: return t("work_links.blocked_site_auth", { browser });
  }
}

function BlockedMark({ kind }: { kind: Blocked["kind"] }) {
  if (kind === "google") return <ConnectorIcon id="google" className="size-4 shrink-0" />;
  if (kind === "microsoft_device") return <ConnectorIcon id="microsoft" className="size-4 shrink-0" />;
  const Icon = kind === "passkey" ? KeyRound : LockKeyhole;
  return <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

export function BrowserSignInBar({ tab }: { tab: BrowserPanelTab }) {
  const work = useBrowserLibraryAvailable();
  const [busy, setBusy] = React.useState(false);
  const blocked = tab.blockedSignIn;
  if (!work || !blocked) return null;
  const browser = blocked.browser.name ?? t("work_links.your_browser");
  const message = blockedSignInMessage(blocked, browser);
  const open = async (always: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (always && blocked.host) addElsewhereHost({ host: blocked.host, browserId: blocked.browser.id, browserName: blocked.browser.name });
      const answer = await getElectronBrowser()?.openBlockedElsewhere?.(tab.id);
      toast(t("work_links.opened_in", { browser: answer?.name ?? browser }));
    } catch (error) {
      reportBrowserError(error);
    } finally {
      setBusy(false);
    }
  };
  // "Always open <host> there" is about Work links; an agent's tab only needs the way out.
  const always = blocked.host && blocked.kind !== "site_auth" ? t("work_links.always_open", { host: blocked.host }) : null;
  // Narrow (the side panel): the words, then the buttons under them. Wide (the Work browser): one row.
  return (
    <div
      role="status"
      className="@container shrink-0 border-b border-border bg-muted/60 py-2 ps-3 pe-2"
      data-testid="browser-signin-bar"
      data-kind={blocked.kind}
    >
      <div className="flex items-start gap-2.5 @2xl:items-center">
        <span className="mt-0.5 flex @2xl:mt-0"><BlockedMark kind={blocked.kind} /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-2 @2xl:flex-row @2xl:items-center @2xl:gap-4">
          <p className="min-w-0 flex-1 text-[13px] leading-5 text-foreground">{message}</p>
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 @2xl:flex-row-reverse @2xl:flex-nowrap">
            <Button size="sm" className="h-7 px-3 text-[13px]" disabled={busy} onClick={() => void open(false)} data-testid="browser-signin-open">
              {t("work_links.open_in", { browser })}
            </Button>
            {always ? (
              <Button variant="ghost" size="sm" className="h-7 min-w-0 max-w-full shrink px-3 text-[13px]" disabled={busy} title={always} onClick={() => void open(true)} data-testid="browser-signin-always">
                <span className="truncate">{always}</span>
              </Button>
            ) : null}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="-my-0.5"
          aria-label={t("work_links.dismiss")}
          title={t("work_links.dismiss")}
          onClick={() => void getElectronBrowser()?.dismissBlocked?.(tab.id)}
          data-testid="browser-signin-dismiss"
        >
          <X />
        </Button>
      </div>
    </div>
  );
}
