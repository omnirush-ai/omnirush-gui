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

/**
 * Keeps the native page view on top of `contentRef`: shown for `ownerKey` (the conversation, or the person's own
 * tabs), sized to the box, hidden while a dialog or menu covers it and when `hidden`.
 */
export function useNativeBrowserView(contentRef: React.RefObject<HTMLDivElement | null>, ownerKey: string, hidden = false) {
  const isAvailable = Boolean(getElectronBrowser());
  const shownRef = React.useRef(false);
  const boundsFrameRef = React.useRef<number | null>(null);
  const lastBoundsRef = React.useRef<{ x: number; y: number; width: number; height: number } | null>(null);

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
      const bounds = computeBounds(content);

      if (bounds.width < 1 || bounds.height < 1 || hasNativeBrowserOccluder()) {
        if (shownRef.current) {
          browser.hide?.();
          shownRef.current = false;
          lastBoundsRef.current = null;
        }

        return;
      }

      if (!shownRef.current) {
        // Naming the owner lets the native browser put that owner's tabs on
        // screen and keep every other conversation's tabs silently in the background.
        void browser.show?.(bounds, ownerKey).catch(reportBrowserError);
        shownRef.current = true;
        lastBoundsRef.current = bounds;
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
    };
  }, [contentRef, hidden, isAvailable, ownerKey]);

  return isAvailable;
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
  className?: string;
  inputClassName?: string;
};

/** The address field: shows the tab's address, Enter goes to what was typed. */
export function BrowserAddressField({ tab, inputRef, placeholder = "Enter URL...", blankAsEmpty = false, onNavigate, className, inputClassName }: AddressFieldProps) {
  const suspended = tab.status === "suspended";
  const busy = tab.status === "suspending" || tab.status === "restoring";
  const shownUrl = blankAsEmpty && tab.url === "about:blank" ? "" : tab.url;
  const [urlInput, setUrlInput] = React.useState(shownUrl);
  const urlFocusedRef = React.useRef(false);

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
        className={cn("h-7", inputClassName)}
        value={urlInput}
        disabled={suspended || busy}
        onChange={(event) => setUrlInput(event.target.value)}
        onKeyDown={handleUrlKeyDown}
        onFocus={() => {
          urlFocusedRef.current = true;
          inputRef.current?.select();
        }}
        onBlur={() => {
          urlFocusedRef.current = false;
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
