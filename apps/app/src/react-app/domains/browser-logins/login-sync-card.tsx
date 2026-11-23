import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";

import type { BrowserLibrarySummary } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";

import { usePersistedBrowserLoginsStore } from "./browser-logins-store";
import { BrowserTile } from "./browser-marks";
import { BrowserImportDialog } from "./import-dialog";
import { LoginSyncDialog } from "./login-sync-dialog";
import { browserLibraryKeys, getBrowserLibraryBridge, offerBrowser, useBrowserImportSources, useWorkUser } from "./use-browser-library";
import { useBrowserLoginSync } from "./use-browser-login-sync";
import { t } from "@/i18n";

type LoginSyncCardProps = {
  /** The Work browser (or the panel beside Work): the offer counts as seen once this visit ends. */
  visit?: boolean;
  /** Another bar is up (a blocked sign-in, a site's question, the tab limit): the offer waits. */
  hidden?: boolean;
};

/**
 * The one quiet row above the built-in browser's page. A Work account is offered to bring its bookmarks and sign-ins
 * from the browser it uses, once: never again after Import or Not now, after an import from anywhere else, or after
 * one visit to the Work browser that showed it. It gives way to any other bar. Everyone else keeps the sign-in sync
 * offer.
 */
export function LoginSyncCard({ visit = false, hidden = false }: LoginSyncCardProps = {}) {
  return getBrowserLibraryBridge() === null ? <LoginSyncOffer /> : <LibraryAwareCard visit={visit} hidden={hidden} />;
}

function LibraryAwareCard({ visit, hidden }: Required<LoginSyncCardProps>) {
  return useWorkUser() ? <BrowserImportOffer visit={visit} hidden={hidden} /> : <LoginSyncOffer />;
}

/** The offer showed during the visit now open (the Work browser page, or the panel beside Work). */
let offerShownThisVisit = false;

/** One visit to the Work browser: when it ends after the offer showed, the offer is resolved as seen. */
export function useImportOfferVisit(active = true) {
  useEffect(() => {
    if (!active) return;
    // The offer marks itself shown (its effect runs before this one); the visit resolves it when it ends.
    return () => {
      const store = usePersistedBrowserLoginsStore.getState();
      if (offerShownThisVisit && store.importOffer === null) store.resolveImportOffer("seen");
      offerShownThisVisit = false;
    };
  }, [active]);
}

function BrowserImportOffer({ visit, hidden }: Required<LoginSyncCardProps>) {
  const outcome = usePersistedBrowserLoginsStore((state) => state.importOffer);
  const resolve = usePersistedBrowserLoginsStore((state) => state.resolveImportOffer);
  // An import from anywhere (Settings, the bookmarks menu, Browser home) ends the offer for good.
  const summary = useQuery<BrowserLibrarySummary>({
    queryKey: browserLibraryKeys.summary,
    queryFn: () => getBrowserLibraryBridge()!.summary(),
    enabled: outcome === null,
    retry: false,
  });
  const imported = (summary.data?.imports.length ?? 0) > 0;
  const sources = useBrowserImportSources(outcome === null && !imported && (summary.isSuccess || summary.isError));
  const [dialogOpen, setDialogOpen] = useState(false);
  const target = offerBrowser(sources.data);
  const visible = outcome === null && !imported && Boolean(target) && !hidden;

  useEffect(() => {
    if (imported && outcome === null) resolve("imported");
  }, [imported, outcome, resolve]);
  useEffect(() => {
    if (visible && visit) offerShownThisVisit = true;
  }, [visible, visit]);

  if (!visible && !dialogOpen) return null;

  return (
    <>
      {visible && target ? (
        <div
          className="flex shrink-0 items-center gap-2.5 border-b border-border bg-muted/40 px-3 py-2"
          role="region"
          aria-label={t("browser_import.title")}
          data-testid="browser-import-offer"
        >
          <BrowserTile browser={target.browser} size="chip" />
          <p className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-[18px] text-foreground">
            {target.signIns.importable
              ? t("browser_import.offer", { browser: target.short })
              : t("browser_import.offer_no_signins", { browser: target.short })}
          </p>
          <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[13px]" onClick={() => resolve("dismissed")} data-testid="browser-import-offer-dismiss">
            {t("browser_import.not_now")}
          </Button>
          <Button size="sm" className="h-7 px-3 text-[13px]" onClick={() => setDialogOpen(true)} data-testid="browser-import-offer-open">
            {t("browser_import.import")}
          </Button>
        </div>
      ) : null}
      <BrowserImportDialog
        open={dialogOpen}
        initialBrowser={target?.browser ?? null}
        onOpenChange={setDialogOpen}
        onImported={() => resolve("imported")}
      />
    </>
  );
}

/** One-time offer shown after browser login sync becomes available. */
function LoginSyncOffer() {
  const loginSync = useBrowserLoginSync();
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    if (loginSync.promptDue) loginSync.markPromptShown();
  }, [loginSync.markPromptShown, loginSync.promptDue]);

  // Keep a completed dialog visible until the user closes its summary.
  if (!loginSync.promptDue && !dialogOpen) return null;

  return (
    <>
      {loginSync.promptDue ? (
        <div
          className="flex shrink-0 items-start gap-3 border-b border-border bg-dls-hover px-3 py-2.5"
          role="status"
          data-testid="login-sync-card"
        >
          <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-dls-text">Optional: use your existing sign-ins</p>
            <p className="text-xs text-muted-foreground">
              The browser works without this. To let the agent open sites you are already signed in to, choose one browser profile and the exact sites whose sign-ins to keep in step. Nothing is copied until you enable sync.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="ghost" onClick={loginSync.dismissPrompt} data-testid="login-sync-not-now">Not now</Button>
            <Button size="sm" onClick={() => setDialogOpen(true)} data-testid="login-sync-open">{t("browser_logins.choose_sites")}</Button>
          </div>
        </div>
      ) : null}
      <LoginSyncDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSyncEnabled={() => loginSync.completePrompt()}
      />
    </>
  );
}
