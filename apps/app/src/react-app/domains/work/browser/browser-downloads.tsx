/** @jsxImportSource react */
// Downloads in the Work browser's ".." menu: the last 5 of this session with their progress, Show in Finder or
// Explorer, and the Downloads folder. Files are saved to the Downloads folder and marked as from the internet, so the
// computer checks them before they open.
import { ArrowLeft, File, FolderOpen, X } from "lucide-react";
import * as React from "react";

import type { BrowserDownload } from "@/app/lib/desktop";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { reportBrowserError } from "../../session/panel/browser-surface";
import { getElectronBrowser } from "../../session/panel/utils";
import { downloadFraction, formatBytes, isMacKeyboard } from "./browser-basics";

function action(downloadId: string, kind: "show" | "cancel" | "folder") {
  void getElectronBrowser()?.downloadAction?.(downloadId, kind)?.catch(reportBrowserError);
}

/** The line under a download's name: how far it got, or how it ended. */
export function downloadStatus(download: BrowserDownload): string {
  if (download.state === "completed") return t("work_browser.download_done", { size: formatBytes(download.totalBytes || download.receivedBytes) });
  if (download.state === "cancelled") return t("work_browser.download_cancelled");
  if (download.state === "failed") return t("work_browser.download_failed");
  const fraction = downloadFraction(download);
  return fraction === null
    ? t("work_browser.download_progress_unknown", { size: formatBytes(download.receivedBytes) })
    : t("work_browser.download_progress", { percent: Math.floor(fraction * 100), size: formatBytes(download.totalBytes) });
}

export function DownloadsView({ downloads, onBack, onDone }: { downloads: BrowserDownload[]; onBack: () => void; onDone: () => void }) {
  const showLabel = isMacKeyboard() ? t("work_browser.show_in_finder") : t("work_browser.show_in_folder");
  return (
    <div data-testid="work-browser-downloads">
      <div className="flex h-10 items-center gap-1 border-b border-border px-2">
        <Button variant="ghost" size="icon-sm" aria-label={t("browser_library.back")} onClick={onBack}>
          <ArrowLeft />
        </Button>
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{t("work_browser.downloads")}</p>
      </div>
      {downloads.length === 0 ? (
        <p className="px-4 py-5 text-center text-[13px] text-dls-secondary" data-testid="work-browser-downloads-empty">{t("work_browser.downloads_empty")}</p>
      ) : (
        <ul className="flex flex-col p-1">
          {downloads.map((download) => {
            const fraction = download.state === "progressing" ? downloadFraction(download) : null;
            const done = download.state === "completed";
            return (
              <li key={download.id} className="group flex min-h-12 items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-muted/60" data-testid="work-browser-download">
                <File aria-hidden className={cn("size-4 shrink-0", done ? "text-foreground" : "text-dls-secondary")} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-foreground" title={download.filename}>{download.filename}</p>
                  <p className={cn("truncate text-xs", download.state === "failed" ? "font-medium text-foreground" : "text-dls-secondary")}>{downloadStatus(download)}</p>
                  {download.state === "progressing" ? (
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div className={cn("h-full rounded-full bg-primary", fraction === null && "w-1/3 animate-pulse")} style={fraction === null ? undefined : { width: `${Math.max(4, fraction * 100)}%` }} />
                    </div>
                  ) : null}
                </div>
                {done ? (
                  <Button variant="ghost" size="icon-sm" onClick={() => action(download.id, "show")} aria-label={`${showLabel}: ${download.filename}`} title={showLabel} data-testid="work-browser-download-show">
                    <FolderOpen />
                  </Button>
                ) : download.state === "progressing" ? (
                  <Button variant="ghost" size="icon-sm" onClick={() => action(download.id, "cancel")} aria-label={`${t("work_browser.download_cancel")}: ${download.filename}`} title={t("work_browser.download_cancel")} data-testid="work-browser-download-cancel">
                    <X />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="border-t border-border p-1">
        <button
          type="button"
          onClick={() => {
            onDone();
            action("", "folder");
          }}
          className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none [&_svg]:size-4 [&_svg]:text-dls-secondary"
          data-testid="work-browser-downloads-folder"
        >
          <FolderOpen />
          {t("work_browser.downloads_folder")}
        </button>
      </div>
    </div>
  );
}

/** Downloads whose end was told (or had ended before the page saw them): never told again, this launch. */
const endsTold = new Set<string>();

/**
 * A quiet note when a download starts, or ends while the page is open (the page itself covers the rest of the window).
 * Each end is told once: what had ended before the page opened is not news, even after it opens again. The notes go
 * out once React has finished this update: the toaster listens again after each of its own updates, and a note sent
 * from inside the same update could be dropped (a small file that ends right after it starts).
 */
export function useDownloadNotices(downloads: BrowserDownload[] | null) {
  const seen = React.useRef<Map<string, BrowserDownload["state"]> | null>(null);
  const openedAt = React.useRef(Date.now());
  React.useEffect(() => {
    // Nothing from the desktop app yet: no list to compare with.
    if (!downloads) return;
    const previous = seen.current;
    seen.current = new Map(downloads.map((download) => [download.id, download.state] as const));
    const notes: Array<() => void> = [];
    for (const download of downloads) {
      const before = previous ? previous.get(download.id) : undefined;
      if (previous && before === download.state) continue;
      // The first list: only a download started since the page opened can be news.
      if (!previous && download.startedAt < openedAt.current) {
        if (download.state !== "progressing") endsTold.add(download.id);
        continue;
      }
      if (download.state === "progressing") {
        if (before === undefined) notes.push(() => toast(t("work_browser.downloading", { name: download.filename })));
        continue;
      }
      if (endsTold.has(download.id)) continue;
      endsTold.add(download.id);
      if (download.state === "completed") notes.push(() => toast.success(t("work_browser.downloaded", { name: download.filename })));
      else if (download.state === "failed") notes.push(() => toast.error(t("work_browser.download_failed_toast", { name: download.filename })));
    }
    if (notes.length) window.setTimeout(() => { for (const note of notes) note(); }, 0);
  }, [downloads]);
}
