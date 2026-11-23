/** @jsxImportSource react */
// Browser home: what a new tab shows for a Work account, in the Work browser and in the side panel. Three groups, each
// hidden when empty: "From <company>" (the apps an owner or admin set for everyone), "Your apps" (the sites the person
// uses most, from the imported library and their own bookmarks) and "Recent". Tiles stop at 8 and Recent at 5 rows,
// then "Show all (n)" (Recent past 50 pages: "Show more", 50 rows, and a filter that searches all 30 days); a filter
// appears once a group passes 12. Marks are the app's own brand logos or the site's letter: no icon is fetched from
// anywhere. Everything here is read on this computer.
import { useQuery } from "@tanstack/react-query";
import { Clock, Download, Search } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { BrowserImportDialog } from "../../browser-logins/import-dialog";
import { BROWSER_LIBRARY_KEY, browserLibraryKeys, getBrowserLibraryBridge, useBrowserLibraryAvailable } from "../../browser-logins/use-browser-library";
import { BrandTile } from "../brand-icon";
import { relativeTime } from "../work-mode";
import { type CompanyApp, HOME_RECENT_LIMIT, HOME_RECENT_SHOWN, HOME_SEARCH_FROM, HOME_TILES_SHOWN, siteBrand, siteHost } from "./work-browser";

export type BrowserHomeProps = {
  /** The company's name for "From <company>"; null for an account without one. */
  companyName: string | null;
  /** The company's apps (Work state `browser.apps`); empty hides the group. */
  apps: CompanyApp[];
  /** Open in this tab; with `newTab` (Cmd or Ctrl click) in a new one. */
  onOpen: (url: string, options?: { newTab?: boolean }) => void;
  /** The side panel: tighter spacing and smaller tiles. */
  compact?: boolean;
};

type Tile = { url: string; name: string; host: string };

export function BrowserHome(props: BrowserHomeProps) {
  const library = useBrowserLibraryAvailable();
  const [importOpen, setImportOpen] = React.useState(false);
  const top = useQuery({
    queryKey: [...browserLibraryKeys.top, 24],
    queryFn: () => getBrowserLibraryBridge()!.topBookmarks(24),
    enabled: library,
    retry: false,
  });
  const recent = useQuery({
    queryKey: [...BROWSER_LIBRARY_KEY, "recent"],
    queryFn: () => getBrowserLibraryBridge()!.recent!({ limit: HOME_RECENT_LIMIT }),
    enabled: library && typeof getBrowserLibraryBridge()?.recent === "function",
    retry: false,
  });
  const companyTiles = React.useMemo<Tile[]>(() => props.apps.map((app) => ({ url: app.url, name: app.name, host: siteHost(app.url) })), [props.apps]);
  const yourTiles = React.useMemo<Tile[]>(() => {
    const company = new Set(props.apps.map((app) => siteHost(app.url)));
    return (top.data ?? [])
      .map((mark) => ({ url: mark.url, name: mark.title.trim() || siteHost(mark.url), host: siteHost(mark.url) }))
      .filter((tile) => !company.has(tile.host));
  }, [props.apps, top.data]);
  const pages = recent.data?.pages ?? [];
  const settled = !library || (!top.isLoading && !recent.isLoading);
  const empty = companyTiles.length === 0 && yourTiles.length === 0 && pages.length === 0;

  return (
    <div className="h-full overflow-y-auto bg-background" data-testid="browser-home" data-browser-occluder="">
      <div className={cn("mx-auto flex w-full flex-col", props.compact ? "gap-6 px-4 py-5" : "max-w-[1000px] gap-9 px-8 py-10")}>
        {companyTiles.length ? (
          <TileGroup
            id="company"
            title={props.companyName ? t("work_browser.from_company", { company: props.companyName }) : t("work_browser.from_company_fallback")}
            tiles={companyTiles}
            compact={props.compact}
            onOpen={props.onOpen}
          />
        ) : null}
        {yourTiles.length ? <TileGroup id="yours" title={t("work_browser.your_apps")} tiles={yourTiles} compact={props.compact} onOpen={props.onOpen} /> : null}
        {pages.length ? <RecentGroup pages={pages} total={recent.data?.total ?? pages.length} onOpen={props.onOpen} /> : null}
        {empty && settled ? (
          <div className={cn("mx-auto flex max-w-md flex-col items-center text-center", props.compact ? "pt-6" : "pt-[12vh]")} data-testid="browser-home-empty">
            <h2 className="text-balance text-[17px] font-semibold leading-6 tracking-[-0.01em] text-foreground">{t("work_browser.empty_title")}</h2>
            <p className="mt-2 text-[13px] leading-5 text-dls-secondary">{library ? t("work_browser.empty_body") : t("work_browser.empty_body_no_import")}</p>
            {library ? (
              <Button variant="outline" size="sm" className="mt-5" onClick={() => setImportOpen(true)} data-testid="browser-home-import">
                <Download />
                {t("browser_library.import")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {library ? <BrowserImportDialog open={importOpen} onOpenChange={setImportOpen} /> : null}
    </div>
  );
}

function useFilter<T>(items: T[], expanded: boolean, text: (item: T) => string) {
  const [query, setQuery] = React.useState("");
  const searchable = expanded && items.length > HOME_SEARCH_FROM;
  const needle = searchable ? query.trim().toLowerCase() : "";
  const filtered = needle ? items.filter((item) => text(item).toLowerCase().includes(needle)) : items;
  return { query, setQuery, searchable, filtered };
}

function GroupHeader(props: {
  id: string;
  title: string;
  total: number;
  shown: number;
  expanded: boolean;
  onToggle: () => void;
  filter?: { query: string; setQuery: (value: string) => void } | null;
  /** In place of "Show all (n)" when not all n can be listed. */
  moreLabel?: string;
}) {
  return (
    <div className="flex min-h-7 items-center gap-3">
      <h3 id={`browser-home-${props.id}`} className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{props.title}</h3>
      {props.filter ? (
        <label className="flex h-7 w-44 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-dls-secondary focus-within:ring-2 focus-within:ring-ring">
          <Search aria-hidden className="size-3.5 shrink-0" />
          <input
            value={props.filter.query}
            onChange={(event) => props.filter?.setQuery(event.target.value)}
            placeholder={t("work_browser.filter")}
            aria-label={t("work_browser.filter_in", { section: props.title })}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-dls-secondary"
            data-testid={`browser-home-filter-${props.id}`}
          />
        </label>
      ) : null}
      {props.total > props.shown || props.expanded ? (
        <button
          type="button"
          onClick={props.onToggle}
          aria-expanded={props.expanded}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[13px] text-dls-secondary outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={`browser-home-more-${props.id}`}
        >
          {props.expanded ? t("work_browser.show_less") : props.moreLabel ?? t("work_browser.show_all", { n: props.total })}
        </button>
      ) : null}
    </div>
  );
}

function openFrom(event: React.MouseEvent, url: string, onOpen: BrowserHomeProps["onOpen"]) {
  onOpen(url, event.metaKey || event.ctrlKey ? { newTab: true } : undefined);
}

/** Columns the tile grid has at its width (auto-fill at `min` px), so the group shows two full rows. */
function useColumns(ref: React.RefObject<HTMLDivElement | null>, min: number, gap: number, max: number): number {
  const [columns, setColumns] = React.useState(max);
  React.useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = grid.clientWidth;
      if (width > 0) setColumns(Math.max(1, Math.min(max, Math.floor((width + gap) / (min + gap)))));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    measure();
    return () => observer.disconnect();
  }, [gap, max, min, ref]);
  return columns;
}

function TileGroup(props: { id: string; title: string; tiles: Tile[]; compact?: boolean; onOpen: BrowserHomeProps["onOpen"] }) {
  const [expanded, setExpanded] = React.useState(false);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const columns = useColumns(gridRef, props.compact ? 150 : 196, 8, 4);
  // Two full rows, never more than eight tiles.
  const limit = Math.min(HOME_TILES_SHOWN, columns * 2);
  const filter = useFilter(props.tiles, expanded, (tile) => `${tile.name} ${tile.host}`);
  const shown = expanded ? filter.filtered : props.tiles.slice(0, limit);
  return (
    <section aria-labelledby={`browser-home-${props.id}`} data-testid={`browser-home-${props.id}`}>
      <GroupHeader
        id={props.id}
        title={props.title}
        total={props.tiles.length}
        shown={Math.min(props.tiles.length, limit)}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        filter={filter.searchable ? filter : null}
      />
      <div ref={gridRef} className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {shown.map((tile) => (
          <button
            key={tile.url}
            type="button"
            title={`${tile.name}\n${tile.url}`}
            onClick={(event) => openFrom(event, tile.url, props.onOpen)}
            className={cn(
              "flex min-w-0 items-center gap-3 rounded-xl border border-border bg-background px-3 text-left transition-colors",
              "hover:border-foreground/20 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              props.compact ? "h-14" : "h-16",
            )}
            data-testid="browser-home-tile"
          >
            <BrandTile id={siteBrand(tile.url)} name={tile.name} className="size-8 rounded-[9px]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium leading-5 text-foreground">{tile.name}</span>
              <span className="block truncate text-xs leading-4 text-dls-secondary">{tile.host}</span>
            </span>
          </button>
        ))}
      </div>
      {expanded && filter.filtered.length === 0 ? <p className="mt-3 text-[13px] text-dls-secondary">{t("work_browser.no_match")}</p> : null}
    </section>
  );
}

/** `value`, once it has stayed the same for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [ms, value]);
  return settled;
}

/**
 * The newest pages: 5 rows, then the 50 newest. The count is the true one; past 50 the header says "Show more" (the
 * list never claims to be all of them) and the filter asks the library, so any page of the last 30 days can be found.
 */
function RecentGroup(props: { pages: Array<{ url: string; title: string; lastVisitAt: number }>; total: number; onOpen: BrowserHomeProps["onOpen"] }) {
  const [expanded, setExpanded] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const searchable = expanded && props.total > HOME_SEARCH_FROM;
  const needle = useSettled(searchable ? query.trim() : "", 200);
  const found = useQuery({
    queryKey: [...BROWSER_LIBRARY_KEY, "recent", needle],
    queryFn: () => getBrowserLibraryBridge()!.recent!({ limit: HOME_RECENT_LIMIT, query: needle }),
    enabled: Boolean(needle) && typeof getBrowserLibraryBridge()?.recent === "function",
    retry: false,
  });
  const listed = needle ? found.data?.pages ?? [] : props.pages;
  const shown = expanded ? listed.slice(0, HOME_RECENT_LIMIT) : props.pages.slice(0, HOME_RECENT_SHOWN);
  const allListed = props.total <= props.pages.length;
  const filter = { query, setQuery };
  return (
    <section aria-labelledby="browser-home-recent" data-testid="browser-home-recent">
      <GroupHeader
        id="recent"
        title={t("work_browser.recent")}
        total={props.total}
        shown={Math.min(props.pages.length, HOME_RECENT_SHOWN)}
        expanded={expanded}
        onToggle={() => {
          setExpanded(!expanded);
          setQuery("");
        }}
        filter={searchable ? filter : null}
        moreLabel={allListed ? undefined : t("work_browser.show_more")}
      />
      <div className="mt-2 flex flex-col">
        {shown.map((page) => (
          <button
            key={page.url}
            type="button"
            title={`${page.title || siteHost(page.url)}\n${page.url}`}
            onClick={(event) => openFrom(event, page.url, props.onOpen)}
            className="group flex h-9 min-w-0 items-center gap-3 rounded-lg px-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="browser-home-recent-row"
          >
            <Clock aria-hidden className="size-4 shrink-0 text-dls-secondary" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
              {page.title || siteHost(page.url)}
              <span className="text-dls-secondary">{`  ·  ${siteHost(page.url)}`}</span>
            </span>
            <span className="shrink-0 text-xs tabular-nums text-dls-secondary">{relativeTime(new Date(page.lastVisitAt).toISOString())}</span>
          </button>
        ))}
      </div>
      {expanded && needle && found.isSuccess && listed.length === 0 ? <p className="mt-2 px-2 text-[13px] text-dls-secondary">{t("work_browser.no_match")}</p> : null}
      {expanded && !needle && !allListed ? (
        <p className="mt-2 px-2 text-[13px] text-dls-secondary" data-testid="browser-home-recent-note">{t("work_browser.recent_more_note", { n: HOME_RECENT_LIMIT })}</p>
      ) : null}
    </section>
  );
}
