/** @jsxImportSource react */
// The built-in browser's surface, shared by the chat side panel and the Work browser page (/work/browser): the native
// page view kept in step with a box in the app, the back, forward and reload buttons, the address field, the agent
// strip, the suspended notice and the approval overlay. Each place lays these out in its own chrome.
import type { BrowserPanelTab } from "@omnirush/browser-tabs";
import { ArrowLeft, ArrowRight, Globe, Loader2, RotateCw } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { computeBounds, getElectronBrowser, hasNativeBrowserOccluder, sameBounds } from "./utils";

export function reportBrowserError(error: unknown) {
  toast.error(error instanceof Error ? error.message : String(error));
}

export type NativeBrowserViewOptions = {
  /**
   * The person's own tabs (the Work browser, the panel beside Work pages): while a menu or dialog covers the page, the
   * page steps aside and this gets a picture of it to show in its place (null once the page is back), so the page
   * never goes blank under a menu. A chat's panel leaves it out and keeps the page hidden as before.
   */
  onStill?: (still: string | null) => void;
};

/**
 * Keeps the native page view on top of `contentRef`: shown for `ownerKey` (the conversation, or the person's own
 * tabs), sized to the box, hidden while a dialog or menu covers it and when `hidden`.
 */
export function useNativeBrowserView(contentRef: React.RefObject<HTMLDivElement | null>, ownerKey: string, hidden = false, options: NativeBrowserViewOptions = {}) {
  const isAvailable = Boolean(getElectronBrowser());
  const shownRef = React.useRef(false);
  const boundsFrameRef = React.useRef<number | null>(null);
  const lastBoundsRef = React.useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const onStillRef = React.useRef(options.onStill);
  onStillRef.current = options.onStill;
  // Taking the page's picture before it steps aside: nothing else moves the view meanwhile.
  const steppingAsideRef = React.useRef(false);
  const stillShownRef = React.useRef(false);
  // The page box's size when its picture was taken: a picture is only true to the page at that size.
  const stillSizeRef = React.useRef<{ width: number; height: number } | null>(null);
  const setStill = React.useCallback((still: string | null) => {
    if (!still) stillSizeRef.current = null;
    if (!still && !stillShownRef.current) return;
    stillShownRef.current = Boolean(still);
    onStillRef.current?.(still);
  }, []);

  React.useLayoutEffect(() => {
    const browser = getElectronBrowser();
    const content = contentRef.current;
    if (!browser || !content || !isAvailable || hidden) {
      return;
    }

    const bounds = computeBounds(content);
    if (bounds.width < 1 || bounds.height < 1) {
      return;
    }

    browser.setBounds?.(bounds);
    lastBoundsRef.current = bounds;
  });

  React.useLayoutEffect(() => {
    const browser = getElectronBrowser();
    const content = contentRef.current;

    if (!browser || !content || !isAvailable || hidden) {
      browser?.hide?.();
      shownRef.current = false;
      lastBoundsRef.current = null;
      setStill(null);

      if (boundsFrameRef.current != null) {
        window.cancelAnimationFrame(boundsFrameRef.current);
        boundsFrameRef.current = null;
      }

      return;
    }

    let disposed = false;

    const resetNativeView = async () => {
      await browser.hide?.();

      if (disposed) {
        return;
      }

      shownRef.current = false;
      lastBoundsRef.current = null;
      boundsFrameRef.current = window.requestAnimationFrame(watchBounds);
    };

    const syncBounds = () => {
      if (steppingAsideRef.current) return;
      const bounds = computeBounds(content);
      const occluded = hasNativeBrowserOccluder();

      if (bounds.width < 1 || bounds.height < 1 || occluded) {
        if (!shownRef.current && stillShownRef.current && stillSizeRef.current && !sameSize(stillSizeRef.current, bounds)) {
          // The page box changed size under a menu: the picture no longer matches the page, so the menu closes (as
          // menus do when a window resizes) and the page comes back at its new size. A cover that stays drops the
          // picture rather than show it stretched or cut.
          stillSizeRef.current = null;
          closeCoveringMenu();
          window.setTimeout(() => { if (!disposed && !shownRef.current && hasNativeBrowserOccluder()) setStill(null); }, STILL_COVER_GRACE_MS);
          return;
        }
        if (shownRef.current) {
          const takeStill = occluded && bounds.width >= 1 && bounds.height >= 1 && onStillRef.current && browser.pageStill;
          if (takeStill) {
            // The page's picture goes in its place first, then the page steps aside for the menu.
            steppingAsideRef.current = true;
            const size = { width: bounds.width, height: bounds.height };
            void browser.pageStill!().catch(() => null).then((still) => {
              if (!disposed && still) {
                setStill(still);
                stillSizeRef.current = size;
              }
              if (!disposed) browser.hide?.();
              shownRef.current = false;
              lastBoundsRef.current = null;
              steppingAsideRef.current = false;
            });
            return;
          }
          browser.hide?.();
          shownRef.current = false;
          lastBoundsRef.current = null;
        }

        return;
      }

      if (!shownRef.current) {
        // Naming the owner lets the native browser put that owner's tabs on
        // screen and keep every other conversation's tabs silently in the background.
        const shown = browser.show?.(bounds, ownerKey);
        void shown?.catch(reportBrowserError);
        shownRef.current = true;
        lastBoundsRef.current = bounds;
        // The picture goes once the page is back on top of it.
        if (stillShownRef.current) {
          void Promise.resolve(shown).catch(() => undefined).then(() => {
            window.requestAnimationFrame(() => { if (!disposed && shownRef.current) setStill(null); });
          });
        }
        return;
      }

      if (!sameBounds(lastBoundsRef.current, bounds)) {
        browser.setBounds?.(bounds);
        lastBoundsRef.current = bounds;
      }
    };

    const watchBounds = () => {
      syncBounds();
      boundsFrameRef.current = window.requestAnimationFrame(watchBounds);
    };

    void resetNativeView();

    const observer = new ResizeObserver(syncBounds);

    observer.observe(content);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);

      if (boundsFrameRef.current != null) {
        window.cancelAnimationFrame(boundsFrameRef.current);
        boundsFrameRef.current = null;
      }

      browser.hide?.();
      shownRef.current = false;
      lastBoundsRef.current = null;
      steppingAsideRef.current = false;
      setStill(null);
    };
  }, [contentRef, hidden, isAvailable, ownerKey, setStill]);

  return isAvailable;
}

// Long enough for a closing menu to finish its exit before a cover that stays loses the picture.
const STILL_COVER_GRACE_MS = 400;

function sameSize(left: { width: number; height: number }, right: { width: number; height: number }) {
  return Math.abs(left.width - right.width) < 1 && Math.abs(left.height - right.height) < 1;
}

/**
 * Closes the menu or dialog over the page the way Escape does, sent from inside it so only that menu hears it. The
 * Work browser's home is a cover too, but it is the page itself and stays.
 */
function closeCoveringMenu() {
  const covers = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [data-browser-occluder]')]
    .filter((element) => element.dataset.testid !== "browser-home" && (element.offsetParent !== null || element.getClientRects().length > 0));
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const target = covers.find((cover) => active && cover.contains(active)) ? active! : covers.at(-1);
  target?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
}

/** The picture of the page shown in its place while a menu covers it (see `NativeBrowserViewOptions.onStill`). */
export function BrowserPageStill({ still }: { still: string | null }) {
  if (!still) return null;
  return (
    <img
      src={still}
      alt=""
      aria-hidden
      draggable={false}
      className="pointer-events-none absolute inset-0 size-full select-none object-cover object-left-top"
      data-testid="browser-page-still"
    />
  );
}

/** Back, forward and reload (reload on a suspended tab loads its saved address again). */
export function BrowserNavButtons({ tab }: { tab: BrowserPanelTab }) {
  const suspended = tab.status === "suspended";
  const busy = tab.status === "suspending" || tab.status === "restoring";
  const back = React.useCallback(() => {
    void getElectronBrowser()?.back?.().catch(reportBrowserError);
  }, []);
  const forward = React.useCallback(() => {
    void getElectronBrowser()?.forward?.().catch(reportBrowserError);
  }, []);
  const reload = useReloadTab(tab);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={back}
              disabled={suspended || busy || !tab.canGoBack}
              aria-label="Go back"
            >
              <ArrowLeft />
            </Button>
          )}
        />
        <TooltipContent>Back</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={forward}
              disabled={suspended || busy || !tab.canGoForward}
              aria-label="Go forward"
            >
              <ArrowRight />
            </Button>
          )}
        />
        <TooltipContent>Forward</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={reload}
              disabled={busy}
              aria-label="Reload page"
            >
              {tab.status === "loading" || busy ? <Loader2 className="animate-spin" /> : <RotateCw />}
            </Button>
          )}
        />
        <TooltipContent>Reload</TooltipContent>
      </Tooltip>
    </>
  );
}

/** Reload the page, or load a suspended tab's saved address again. */
export function useReloadTab(tab: BrowserPanelTab) {
  const suspended = tab.status === "suspended";
  return React.useCallback(() => {
    const browser = getElectronBrowser();
    void (suspended ? browser?.selectTab?.(tab.id) : browser?.reload?.())?.catch(reportBrowserError);
  }, [suspended, tab.id]);
}

type AddressFieldProps = {
  tab: BrowserPanelTab;
  inputRef: React.RefObject<HTMLInputElement | null>;
  placeholder?: string;
  /** A blank tab (the Work browser's home) shows an empty field, ready to type in. */
  blankAsEmpty?: boolean;
  /** Where Enter goes (the Work browser with no tab opens one); the tab's own page otherwise. */
  onNavigate?: (url: string) => void;
  /**
   * The person's own tabs: while the field is not focused it reads host first with no scheme, cut at the end, and the
   * full address is its hover text. Focus shows the full address, selected. A chat's panel leaves it out.
   */
  compact?: boolean;
  className?: string;
  inputClassName?: string;
};

/** A web address as the field shows it at rest: no http(s) scheme and no lone trailing slash. Other addresses as they are. */
export function addressForDisplay(url: string): string {
  const match = /^https?:\/\/(.*)$/i.exec(url.trim());
  if (!match) return url;
  const rest = match[1]!;
  return /^[^/?#]+\/$/.test(rest) ? rest.slice(0, -1) : rest;
}

/** The address field: shows the tab's address, Enter goes to what was typed. */
export function BrowserAddressField({ tab, inputRef, placeholder = "Enter URL...", blankAsEmpty = false, onNavigate, compact = false, className, inputClassName }: AddressFieldProps) {
  const suspended = tab.status === "suspended";
  const busy = tab.status === "suspending" || tab.status === "restoring";
  const shownUrl = blankAsEmpty && tab.url === "about:blank" ? "" : tab.url;
  const [urlInput, setUrlInput] = React.useState(shownUrl);
  const urlFocusedRef = React.useRef(false);
  const [focused, setFocused] = React.useState(false);
  // At rest the compact field reads the tab's own address host first; anything typed and not sent stays as typed.
  const resting = compact && !focused && urlInput === shownUrl;

  React.useEffect(() => {
    if (!urlFocusedRef.current) {
      setUrlInput(shownUrl);
    }
  }, [tab.id, shownUrl]);

  const navigate = React.useCallback(() => {
    if (!urlInput.trim()) return;
    if (onNavigate) onNavigate(urlInput.trim());
    else void getElectronBrowser()?.navigate?.(urlInput).catch(reportBrowserError);
  }, [onNavigate, urlInput]);

  const handleUrlKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      navigate();
      inputRef.current?.blur();
    }
  }, [inputRef, navigate]);

  return (
    <InputGroup className={cn("mx-1 h-7 flex-1 rounded-md", className)}>
      <InputGroupInput
        ref={inputRef}
        type="text"
        className={cn("h-7", compact && "truncate", inputClassName)}
        value={resting ? addressForDisplay(urlInput) : urlInput}
        title={compact && shownUrl ? shownUrl : undefined}
        disabled={suspended || busy}
        onChange={(event) => setUrlInput(event.target.value)}
        onKeyDown={handleUrlKeyDown}
        onFocus={(event) => {
          urlFocusedRef.current = true;
          setFocused(true);
          const input = event.currentTarget;
          if (!compact) {
            input.select();
            return;
          }
          // The full address replaces the short one first, then all of it is selected for editing.
          input.value = urlInput;
          input.select();
          window.requestAnimationFrame(() => { if (document.activeElement === input) input.select(); });
        }}
        onBlur={() => {
          urlFocusedRef.current = false;
          setFocused(false);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      <InputGroupAddon align="inline-start" className="ps-2">
        <Globe />
      </InputGroupAddon>
    </InputGroup>
  );
}

const browserOperationLabels: Record<string, string> = {
  observe: "Reading this page", site_tools: "Finding website tools", site_tool: "Using a website tool",
  navigate: "Opening a page", click: "Clicking a control", fill: "Entering text", key: "Using the keyboard", scroll: "Scrolling",
  "Website access": "Review website access", website_blocked: "This website is blocked", browser_disabled: "Browser control is disabled",
  stale_observation: "A fresh page view is needed", stale_tool: "Website tools have changed", user_denied: "The action was declined",
  needs_attention: "Review this page", sign_in_required: "Sign in directly in this browser", timeout: "Check the page before continuing",
  result_withheld: "Website result was kept private",
};

/** Whether an agent is working in the tab right now (running, handed to the person, or waiting for review). */
export function agentWorkingIn(tab: BrowserPanelTab): boolean {
  const status = tab.browserTask?.status;
  return status === "running" || status === "paused" || status === "needs_attention";
}

/** The strip above a tab an agent can drive: what it is doing, and Take over / Resume. */
export function BrowserAgentStrip({ tab }: { tab: BrowserPanelTab }) {
  return (
    <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
      <span className="shrink-0 font-medium">Built-in browser</span>
      <span role="status" className="min-w-0 flex-1 truncate text-muted-foreground">
        {tab.browserTask?.status === "paused" ? "You have control · resume when finished" : tab.browserTask?.status === "running" ? browserOperationLabels[tab.browserTask.operation ?? ""] ?? "Working on this page" : tab.browserTask?.status === "needs_attention" ? browserOperationLabels[tab.browserTask.operation ?? ""] ?? "Review this page" : "This conversation's tab"}
      </span>
      <Button variant="outline" size="sm" className="h-6 px-2 text-xs"
        onClick={() => { void window.__OMNIRUSH_ELECTRON__?.browser?.taskControl?.(tab.id, tab.browserTask?.status === "paused" ? "resume" : "pause"); }}>
        {tab.browserTask?.status === "paused" ? "Resume browser" : "Take over"}
      </Button>
    </div>
  );
}

/** In place of the page while a tab is suspended. */
export function BrowserSuspendedNotice({ tab }: { tab: BrowserPanelTab }) {
  const reload = useReloadTab(tab);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm font-medium">Tab suspended</p>
      <p className="text-sm text-muted-foreground">Reload opens the saved URL, not the previous page state.</p>
      <Button variant="outline" size="sm" onClick={reload}>Reload</Button>
    </div>
  );
}

/** A website permission an agent asked for, over the page until answered. */
export function BrowserApprovalOverlay({ tab }: { tab: BrowserPanelTab }) {
  if (!tab.browserApproval) return null;
  return (
    <div className="absolute inset-0 z-10 flex flex-col justify-center gap-3 overflow-y-auto bg-background p-5 text-sm" role="region" aria-label="Browser permission request">
      <h3 className="font-semibold">{tab.browserApproval.title}</h3>
      <p className="font-medium">{tab.browserApproval.message}</p>
      <p className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">{tab.browserApproval.detail}</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => { if (tab.browserApproval) void window.__OMNIRUSH_ELECTRON__?.browser?.approve?.(tab.id, tab.browserApproval.id, true); }}>{tab.browserApproval.approveLabel ?? "Allow once"}</Button>
        <Button size="sm" variant="outline" onClick={() => { if (tab.browserApproval) void window.__OMNIRUSH_ELECTRON__?.browser?.approve?.(tab.id, tab.browserApproval.id, false); }}>Deny</Button>
      </div>
    </div>
  );
}
