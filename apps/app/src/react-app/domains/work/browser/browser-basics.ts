// The Work browser's basics in the renderer: find in page, zoom, print, downloads and the browser's keyboard shortcuts.
// Shortcuts act only while the Work browser has focus: on the page itself the desktop app catches them before the page
// and the app menu (browser-page-tools.mjs) and hands them here; in the browser's own toolbar this file catches them
// first. Everywhere else the app's shortcuts (Cmd or Ctrl+T next tab, Shift+T previous tab, P quick open) stay as they
// are. Downloads, zoom and the pages the person opens stay on this computer.
import * as React from "react";

import type { BrowserDownload, BrowserShortcutAction } from "@/app/lib/desktop";
import { currentLocale } from "@/i18n";

import { getElectronBrowser } from "../../session/panel/utils";

/** Keys a held key may repeat. */
export const REPEATING_SHORTCUTS = new Set<BrowserShortcutAction>(["back", "forward", "zoom-in", "zoom-out"]);

const LETTERS: Record<string, BrowserShortcutAction> = { l: "address", t: "new-tab", w: "close-tab", r: "reload", f: "find", p: "print" };
const CODE_LETTERS: Record<string, string> = { KeyL: "l", KeyT: "t", KeyW: "w", KeyR: "r", KeyF: "f", KeyP: "p" };

type KeyPress = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

/**
 * The browser action a key press asks for while the Work browser has focus, or null. Cmd on macOS, Ctrl elsewhere:
 * L address, T new tab, W close tab, R reload, F find, P print, [ back, ] forward, = - 0 zoom. The same map as the
 * desktop app's for the page itself.
 */
export function workBrowserShortcut(event: KeyPress, mac: boolean): BrowserShortcutAction | null {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey) return null;
  const key = (event.key ?? "").toLowerCase();
  const code = event.code ?? "";
  const letter = /^[a-z]$/.test(key) ? key : CODE_LETTERS[code] ?? null;
  if (event.shiftKey) {
    if (letter === "r") return "reload";
    if (key === "+" || code === "Equal" || code === "NumpadAdd") return "zoom-in";
    return null;
  }
  if (letter && LETTERS[letter]) return LETTERS[letter]!;
  if (key === "[" || code === "BracketLeft") return "back";
  if (key === "]" || code === "BracketRight") return "forward";
  if (key === "=" || key === "+" || code === "NumpadAdd") return "zoom-in";
  if (key === "-" || code === "Minus" || code === "NumpadSubtract") return "zoom-out";
  if (key === "0" || code === "Digit0" || code === "Numpad0") return "zoom-reset";
  return null;
}

export function isMacKeyboard(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
}

/** How a shortcut reads in a menu: ⌘F on macOS, Ctrl+F elsewhere. */
export function shortcutHint(letter: string, mac = isMacKeyboard()): string {
  return mac ? `⌘${letter.toUpperCase()}` : `Ctrl+${letter.toUpperCase()}`;
}

/** 38 -> "38 B", 2048 -> "2 KB", 2_400_000 -> "2.3 MB". A small file never reads as 0 KB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 0 to 1 while the size is known, otherwise null. */
export function downloadFraction(download: Pick<BrowserDownload, "receivedBytes" | "totalBytes">): number | null {
  if (download.totalBytes <= 0) return null;
  return Math.min(1, Math.max(0, download.receivedBytes / download.totalBytes));
}

export function zoomPercent(factor: number): number {
  return Math.round(factor * 100);
}

/**
 * Tells the desktop app this is a Work account (`tools`: downloads to the Downloads folder, the page menu and the
 * person's own visits on their tabs). Everyone else keeps the browser as before.
 */
export function useWorkBrowserTools(enabled: boolean) {
  React.useEffect(() => {
    void getElectronBrowser()?.setUserTabTools?.({ tools: enabled, language: currentLocale() })?.catch(() => undefined);
  }, [enabled]);
}

/**
 * The Work browser page's keyboard shortcuts: while focus is in the page (`rootRef`) or nowhere in particular, the
 * browser's keys act on the browser and nothing else sees them; keys caught on the web page arrive from the desktop
 * app. Off as soon as the page closes.
 */
export function useWorkBrowserShortcuts(
  rootRef: React.RefObject<HTMLElement | null>,
  run: (action: BrowserShortcutAction, url?: string) => void,
) {
  const runRef = React.useRef(run);
  runRef.current = run;
  React.useEffect(() => {
    const browser = getElectronBrowser();
    void browser?.setUserTabTools?.({ page: true })?.catch(() => undefined);
    const mac = isMacKeyboard();
    const keydown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      const active = document.activeElement;
      // The page, its menus (marked data-work-browser), or nothing focused; never a dialog or the rest of the app.
      if (!root || (active && active !== document.body && !root.contains(active) && !active.closest("[data-work-browser]"))) return;
      const action = workBrowserShortcut(event, mac);
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat && !REPEATING_SHORTCUTS.has(action)) return;
      runRef.current(action);
    };
    // Capture, first: the app's own shortcuts (and the app menu) never see a key the browser used.
    window.addEventListener("keydown", keydown, true);
    const unsubscribe = browser?.onShortcut?.((payload) => runRef.current(payload.action, payload.url));
    return () => {
      window.removeEventListener("keydown", keydown, true);
      unsubscribe?.();
      void browser?.setUserTabTools?.({ page: false })?.catch(() => undefined);
    };
  }, [rootRef]);
}

/** The person's downloads this session (the last 5), kept in step with the desktop app. Null until it answers. */
export function useBrowserDownloads(): BrowserDownload[] | null {
  const [downloads, setDownloads] = React.useState<BrowserDownload[] | null>(null);
  React.useEffect(() => {
    const browser = getElectronBrowser();
    if (!browser) return;
    let current = true;
    const unsubscribe = browser.onDownloadsChange?.((next) => { if (current) setDownloads(next); });
    void browser.downloads?.().then((next) => { if (current && next) setDownloads(next); }).catch(() => undefined);
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, []);
  return downloads;
}
