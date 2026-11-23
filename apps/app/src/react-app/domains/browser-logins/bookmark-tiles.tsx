/** @jsxImportSource react */
// Top bookmarks on the panel's start page (the most visited, then the user's own), one click to open in the browser.
// Work accounts with a library only; nothing shows until there are bookmarks.
import { useQuery } from "@tanstack/react-query";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { browserLibraryKeys, getBrowserLibraryBridge, useBrowserLibraryAvailable } from "./use-browser-library";

const TILE_COUNT = 8;

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function BookmarkTiles({ onOpen }: { onOpen?: (url: string) => void }) {
  // Outside the desktop app (and in markup tests) there is no library: render nothing before touching queries.
  if (!onOpen || getBrowserLibraryBridge() === null) return null;
  return <Tiles onOpen={onOpen} />;
}

function Tiles({ onOpen }: { onOpen: (url: string) => void }) {
  const available = useBrowserLibraryAvailable();
  const top = useQuery({
    queryKey: browserLibraryKeys.top,
    queryFn: () => getBrowserLibraryBridge()!.topBookmarks(TILE_COUNT),
    enabled: available,
    retry: false,
  });
  const tiles = top.data ?? [];
  if (!available || tiles.length === 0) return null;
  return (
    <section className="mt-8" aria-label={t("browser_library.bookmarks")} data-testid="browser-bookmark-tiles">
      <h3 className="text-xs font-medium text-muted-foreground">{t("browser_library.bookmarks")}</h3>
      <div className="mt-2.5 grid grid-cols-2 gap-2">
        {tiles.map((tile) => {
          const name = host(tile.url);
          return (
            <button
              key={tile.url}
              type="button"
              title={tile.url}
              onClick={() => onOpen(tile.url)}
              className={cn(
                "flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-background p-2.5 text-left transition-colors",
                "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-[13px] font-semibold uppercase text-muted-foreground">
                {name.slice(0, 1)}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium leading-5 text-foreground">{tile.title || name}</span>
                <span className="block truncate text-xs leading-4 text-muted-foreground">{name}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
