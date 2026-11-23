/** @jsxImportSource react */
// The built-in browser's library in its toolbar: a star to bookmark the page, a bookmarks menu (folders as imported,
// and "Import from another browser"), and suggestions under the address field from bookmarks and imported history.
// Mounted beside the address field; a Work account only (use-browser-library). The page is a native view drawn over
// the app, so every menu here marks itself as an occluder and the page steps aside while it is open.
import type { BrowserPanelTab } from "@omnirush/browser-tabs";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowLeft, BookMarked, ChevronRight, Clock, Download, Folder, Star } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";

import type { BrowserBookmarkNode, BrowserSuggestion } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { SiteMonogram } from "../../browser-logins/bookmark-tiles";
import { BrowserTile, isImportBrowser } from "../../browser-logins/browser-marks";
import { BrowserImportDialog } from "../../browser-logins/import-dialog";
import {
  BROWSER_LIBRARY_KEY,
  browserLibraryKeys,
  getBrowserLibraryBridge,
  useBrowserLibraryAvailable,
  useInvalidateBrowserLibrary,
} from "../../browser-logins/use-browser-library";
import { getElectronBrowser } from "./utils";

const isWebPage = (url: string) => /^https?:\/\//i.test(url);

/** `www.example.com/path` without the scheme, for a compact second line. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
}

function openUrl(url: string) {
  void getElectronBrowser()?.navigate?.(url).catch((error: unknown) => {
    toast.error(error instanceof Error ? error.message : String(error));
  });
}

type BarProps = {
  sessionId: string;
  tab: BrowserPanelTab;
  inputRef: React.RefObject<HTMLInputElement | null>;
};

export function BrowserLibraryBar(props: BarProps) {
  return getBrowserLibraryBridge() === null ? null : <WorkGate {...props} />;
}

function WorkGate(props: BarProps) {
  return useBrowserLibraryAvailable() ? <LibraryBar {...props} /> : null;
}

/** Address field width under which the star moves into the bookmarks menu, so the field keeps room to read. */
const COMPACT_BELOW = 200;
const STAR_WIDTH = 32;

/** Whether the address field is too narrow to also show the star (with hysteresis, so it never flickers). */
function useCompact(inputRef: React.RefObject<HTMLInputElement | null>): boolean {
  const [compact, setCompact] = React.useState(false);
  React.useEffect(() => {
    const field = inputRef.current?.parentElement;
    if (!field || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const width = field.getBoundingClientRect().width;
      setCompact((current) => (current ? width - STAR_WIDTH < COMPACT_BELOW : width < COMPACT_BELOW));
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [inputRef]);
  return compact;
}

function LibraryBar({ sessionId, tab, inputRef }: BarProps) {
  const anchorRef = React.useRef<HTMLSpanElement>(null);
  const [importOpen, setImportOpen] = React.useState(false);
  const compact = useCompact(inputRef);
  return (
    <span ref={anchorRef} className="contents">
      {compact ? null : <StarButton tab={tab} />}
      <BookmarksMenu sessionId={sessionId} tab={compact ? tab : null} onImport={() => setImportOpen(true)} />
      <AddressSuggestions inputRef={inputRef} anchorRef={anchorRef} currentUrl={tab.url} />
      <BrowserImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </span>
  );
}

/** Whether the tab's page is bookmarked, and the toggle. */
function useStar(tab: BrowserPanelTab) {
  const invalidate = useInvalidateBrowserLibrary();
  const page = isWebPage(tab.url);
  const starred = useQuery({
    queryKey: browserLibraryKeys.starred(tab.url),
    queryFn: () => getBrowserLibraryBridge()!.isBookmarked(tab.url),
    enabled: page,
    retry: false,
  });
  const on = starred.data === true;
  const toggle = React.useCallback(async () => {
    try {
      await getBrowserLibraryBridge()?.toggleBookmark({ url: tab.url, title: tab.label });
      await invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [invalidate, tab.label, tab.url]);
  return { on, toggle, available: page && tab.status !== "suspended", label: on ? t("browser_library.unstar") : t("browser_library.star") };
}

function StarButton({ tab }: { tab: BrowserPanelTab }) {
  const { on, toggle, available, label } = useStar(tab);
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-pressed={on}
            disabled={!available}
            data-testid="browser-star"
            onClick={() => void toggle()}
          >
            <Star className={cn(on && "fill-amber-9 text-amber-9")} />
          </Button>
        )}
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function findFolder(nodes: BrowserBookmarkNode[], id: number): Extract<BrowserBookmarkNode, { children: BrowserBookmarkNode[] }> | null {
  for (const node of nodes) {
    if (!("children" in node)) continue;
    if (node.id === id) return node;
    const inner = findFolder(node.children, id);
    if (inner) return inner;
  }
  return null;
}

/** The star as the menu's first row, when the address field is too narrow for the star button. */
function StarRow({ tab }: { tab: BrowserPanelTab }) {
  const { on, toggle, available, label } = useStar(tab);
  return (
    <div className="border-b border-border p-1">
      <button
        type="button"
        disabled={!available}
        aria-pressed={on}
        className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:opacity-50"
        onClick={() => void toggle()}
        data-testid="browser-star-row"
      >
        <Star aria-hidden className={cn("size-4 shrink-0", on ? "fill-amber-9 text-amber-9" : "text-muted-foreground")} />
        {label}
      </button>
    </div>
  );
}

function BookmarksMenu({ sessionId, tab, onImport }: { sessionId: string; tab: BrowserPanelTab | null; onImport: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [path, setPath] = React.useState<number[]>([]);
  const tree = useQuery({
    queryKey: browserLibraryKeys.bookmarks,
    queryFn: () => getBrowserLibraryBridge()!.bookmarks(),
    enabled: open,
    retry: false,
  });
  const nodes = tree.data ?? [];
  const folder = path.length > 0 ? findFolder(nodes, path[path.length - 1]!) : null;
  const list = folder ? folder.children : nodes;
  const choose = (node: BrowserBookmarkNode, event: React.MouseEvent | React.KeyboardEvent) => {
    if ("children" in node) {
      setPath((current) => [...current, node.id]);
      return;
    }
    setOpen(false);
    setPath([]);
    if (event.metaKey || event.ctrlKey) void getElectronBrowser()?.createTab?.(node.url, sessionId);
    else openUrl(node.url);
  };

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setPath([]); }}>
      <Tooltip>
        <TooltipTrigger
          render={(
            <PopoverTrigger
              render={(
                <Button variant="ghost" size="icon-sm" aria-label={t("browser_library.bookmarks")} data-testid="browser-bookmarks">
                  <BookMarked />
                </Button>
              )}
            />
          )}
        />
        <TooltipContent>{t("browser_library.bookmarks")}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" sideOffset={6} className="w-80 max-w-[calc(100vw-2rem)] gap-0 rounded-2xl p-0" data-browser-occluder="" data-testid="browser-bookmarks-menu">
        {tab && !folder ? <StarRow tab={tab} /> : null}
        <div className="flex h-10 items-center gap-1 border-b border-border px-2">
          {folder ? (
            <Button variant="ghost" size="icon-sm" aria-label={t("browser_library.back")} onClick={() => setPath((current) => current.slice(0, -1))}>
              <ArrowLeft />
            </Button>
          ) : null}
          <p className={cn("min-w-0 flex-1 truncate text-[13px] font-medium", !folder && "ps-2")}>{folder ? folder.title : t("browser_library.bookmarks")}</p>
        </div>
        <div className="max-h-80 overflow-y-auto p-1" role="list">
          {tree.isLoading ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t("browser_library.loading")}</p>
          ) : list.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-[13px] font-medium">{t("browser_library.empty_title")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("browser_library.empty_body")}</p>
            </div>
          ) : (
            list.map((node) => (
              <button
                key={node.id}
                type="button"
                role="listitem"
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                onClick={(event) => choose(node, event)}
                title={"url" in node ? node.url : node.title}
              >
                {"children" in node ? (
                  node.browser && isImportBrowser(node.browser)
                    ? <BrowserTile browser={node.browser} size="chip" />
                    : <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <SiteMonogram url={node.url} />
                )}
                <span className="min-w-0 flex-1 truncate">{node.title}</span>
                {"children" in node ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
                    {node.children.length}
                    <ChevronRight aria-hidden className="size-3.5" />
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
        <div className="border-t border-border p-1">
          <button
            type="button"
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-none"
            onClick={() => {
              setOpen(false);
              onImport();
            }}
            data-testid="browser-bookmarks-import"
          >
            <Download aria-hidden className="size-4 shrink-0" />
            {t("browser_library.import")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AddressSuggestions({ inputRef, anchorRef, currentUrl }: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  anchorRef: React.RefObject<HTMLSpanElement | null>;
  currentUrl: string;
}) {
  const [query, setQuery] = React.useState("");
  const [typed, setTyped] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const [rect, setRect] = React.useState<{ left: number; top: number; width: number } | null>(null);
  const listId = React.useId();

  const suggestions = useQuery<BrowserSuggestion[]>({
    queryKey: [...BROWSER_LIBRARY_KEY, "suggest", query.trim().toLowerCase()],
    queryFn: () => getBrowserLibraryBridge()!.suggest(query),
    enabled: typed && query.trim().length > 0 && query.trim() !== currentUrl,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const items = typed && query.trim().length > 0 ? suggestions.data ?? [] : [];
  const shown = focused && items.length > 0;

  // The address field belongs to the panel; listen to it rather than own it.
  React.useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onInput = () => {
      setQuery(input.value);
      setTyped(true);
      setActive(-1);
    };
    const onFocus = () => setFocused(true);
    const onBlur = () => {
      setFocused(false);
      setTyped(false);
      setActive(-1);
    };
    input.addEventListener("input", onInput);
    input.addEventListener("focus", onFocus);
    input.addEventListener("blur", onBlur);
    return () => {
      input.removeEventListener("input", onInput);
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("blur", onBlur);
    };
  }, [inputRef]);

  const go = React.useCallback((suggestion: BrowserSuggestion) => {
    openUrl(suggestion.url);
    setTyped(false);
    inputRef.current?.blur();
  }, [inputRef]);

  // Keys first, before the panel's own handlers (Escape there closes the panel; Enter navigates to what was typed).
  React.useEffect(() => {
    if (!shown) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== inputRef.current) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((current) => {
          const next = current + step;
          if (next < -1) return items.length - 1;
          if (next >= items.length) return -1;
          return next;
        });
      } else if (event.key === "Enter" && active >= 0 && items[active]) {
        event.preventDefault();
        event.stopPropagation();
        go(items[active]!);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setTyped(false);
        setActive(-1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, go, inputRef, items, shown]);

  // Screen readers: the address field controls the list and names the highlighted option.
  React.useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", shown ? "true" : "false");
    if (shown) input.setAttribute("aria-controls", listId);
    else input.removeAttribute("aria-controls");
    if (shown && active >= 0) input.setAttribute("aria-activedescendant", `${listId}-${active}`);
    else input.removeAttribute("aria-activedescendant");
  }, [active, inputRef, listId, shown]);

  React.useLayoutEffect(() => {
    if (!shown) return;
    const measure = () => {
      const row = anchorRef.current?.parentElement;
      const input = inputRef.current;
      if (!row || !input) return;
      const bar = row.getBoundingClientRect();
      const field = input.getBoundingClientRect();
      setRect({ left: bar.left + 6, top: field.bottom + 6, width: Math.max(240, bar.width - 12) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchorRef, inputRef, shown]);

  if (!shown || !rect) return null;
  return createPortal(
    <div
      id={listId}
      role="listbox"
      aria-label={t("browser_library.suggestions")}
      data-browser-occluder=""
      data-testid="browser-suggestions"
      className="fixed z-50 overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left: rect.left, top: rect.top, width: rect.width }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (
        <div
          key={item.url}
          id={`${listId}-${index}`}
          role="option"
          aria-selected={index === active}
          className={cn("flex h-11 cursor-default items-center gap-2.5 rounded-lg px-2.5", index === active ? "bg-muted" : "hover:bg-muted/60")}
          onMouseEnter={() => setActive(index)}
          onClick={() => go(item)}
        >
          {item.kind === "bookmark"
            ? <Star aria-hidden className="size-3.5 shrink-0 fill-amber-9 text-amber-9" />
            : <Clock aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] leading-5 text-foreground">{item.title || displayUrl(item.url)}</span>
            <span className="block truncate text-xs leading-4 text-muted-foreground">{displayUrl(item.url)}</span>
          </span>
        </div>
      ))}
    </div>,
    document.body,
  );
}
