/** @jsxImportSource react */
// Settings > Browser: import from another browser. Lists the browsers found on this computer with their logos and
// profile names, what was imported and when, and clears imported data. Work accounts only (see use-browser-library).
import type { ImportBrowser } from "@omnirush/browser-logins";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useState } from "react";

import type { BrowserLibrarySummary } from "@/app/lib/desktop";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";

import {
  LayoutSectionItem,
  LayoutSectionItemContent,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
} from "../settings/settings-layout";
import { getElectronBrowser } from "../session/panel/utils";
import { SettingsSection } from "../settings/settings-section";
import { BrowserTile } from "./browser-marks";
import { BrowserImportDialog } from "./import-dialog";
import {
  browserLibraryKeys,
  getBrowserLibraryBridge,
  useBrowserImportSources,
  useBrowserLibraryAvailable,
  useInvalidateBrowserLibrary,
} from "./use-browser-library";

const fmt = (count: number) => count.toLocaleString();

/** "312 bookmarks · 4,210 pages · 31 sign-ins" for one import; parts never imported are left out. */
export function importedLine(entry: BrowserLibrarySummary["imports"][number]): string {
  const parts: string[] = [];
  if (entry.bookmarks !== null) parts.push(t("browser_import.count_bookmarks", { count: entry.bookmarks, n: fmt(entry.bookmarks) }));
  if (entry.history !== null) parts.push(t("browser_import.count_pages", { count: entry.history, n: fmt(entry.history) }));
  if (entry.signIns !== null) parts.push(t("browser_import.count_signins", { count: entry.signIns, n: fmt(entry.signIns) }));
  return parts.join(" · ");
}

export function BrowserImportSection() {
  // Outside the desktop app there is nothing to import into; render nothing before touching queries.
  return getBrowserLibraryBridge() === null ? null : <ImportSection />;
}

function ImportSection() {
  const available = useBrowserLibraryAvailable();
  const sources = useBrowserImportSources(available);
  const summary = useQuery<BrowserLibrarySummary>({
    queryKey: browserLibraryKeys.summary,
    queryFn: () => getBrowserLibraryBridge()!.summary(),
    enabled: available,
    retry: false,
  });
  const invalidate = useInvalidateBrowserLibrary();
  const [dialog, setDialog] = useState<{ open: boolean; browser: ImportBrowser | null }>({ open: false, browser: null });
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  if (!available) return null;

  const browsers = sources.data?.browsers ?? [];
  const imports = summary.data?.imports ?? [];
  const open = (browser: ImportBrowser | null) => setDialog({ open: true, browser });

  return (
    <SettingsSection>
      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("browser_import.section_title")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{t("browser_import.section_desc")}</LayoutSectionItemDescription>
        </LayoutSectionItemHeader>
        <LayoutSectionItemContent className="gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">{t("browser_import.found")}</p>
            {sources.isLoading ? (
              <Skeleton className="h-28 w-full rounded-xl" />
            ) : browsers.length === 0 ? (
              <p className="rounded-xl border border-border px-4 py-3 text-xs text-muted-foreground" data-testid="browser-import-section-none">
                {t("browser_import.none_body")}
              </p>
            ) : (
              <ul className="overflow-hidden rounded-xl border border-border" data-testid="browser-import-found">
                {browsers.map((entry) => (
                  <li key={entry.browser} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0" data-testid={`browser-import-found-${entry.browser}`}>
                    <BrowserTile browser={entry.browser} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium leading-5 text-foreground">{entry.label}</p>
                      <p className="truncate text-xs leading-4 text-muted-foreground">
                        {entry.access === "full_disk_access"
                          ? t("browser_import.needs_access")
                          : entry.profiles.map((profile) => profile.name).join(", ")}
                      </p>
                    </div>
                    {entry.access === "full_disk_access" ? (
                      <Button size="sm" variant="outline" onClick={() => open(entry.browser)}>{t("browser_import.allow_access")}</Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => open(entry.browser)} aria-label={t("browser_import.import_from", { browser: entry.short })}>
                        {t("browser_import.import")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {imports.length > 0 ? (
            <div className="flex flex-col gap-2" data-testid="browser-import-imported">
              <p className="text-xs font-medium text-muted-foreground">{t("browser_import.imported")}</p>
              <ul className="flex flex-col gap-1.5">
                {imports.map((entry) => (
                  <li key={entry.sourceId} className="flex items-center gap-2.5 text-xs">
                    <BrowserTile browser={entry.browser} size="chip" />
                    <span className="shrink-0 font-medium text-foreground">
                      {imports.filter((other) => other.browser === entry.browser).length > 1 || entry.name !== "Default"
                        ? `${entry.label} · ${entry.name}`
                        : entry.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{importedLine(entry)}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{new Date(entry.importedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Lock aria-hidden className="size-3.5 shrink-0" />
              {t("browser_import.section_privacy")}
            </p>
            {imports.length > 0 || (summary.data?.bookmarks ?? 0) > 0 || (summary.data?.history ?? 0) > 0 ? (
              <Button size="sm" variant="ghost" className="text-dls-secondary" onClick={() => setConfirmClear(true)} data-testid="browser-import-clear">
                {t("browser_import.clear")}
              </Button>
            ) : null}
          </div>
        </LayoutSectionItemContent>
      </LayoutSectionItem>

      <BrowserImportDialog
        open={dialog.open}
        initialBrowser={dialog.browser}
        onOpenChange={(next) => setDialog((current) => ({ ...current, open: next }))}
      />

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("browser_import.clear_title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("browser_import.clear_body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("browser_import.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={clearing}
              onClick={async () => {
                setClearing(true);
                try {
                  await getBrowserLibraryBridge()?.clear();
                  // The Work browser's downloads list goes too (the files stay in the Downloads folder).
                  await getElectronBrowser()?.clearDownloads?.()?.catch(() => undefined);
                  await invalidate();
                } finally {
                  setClearing(false);
                  setConfirmClear(false);
                }
              }}
              data-testid="browser-import-clear-confirm"
            >
              {t("browser_import.clear_confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
