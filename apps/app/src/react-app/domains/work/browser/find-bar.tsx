/** @jsxImportSource react */
// Find in page for the Work browser: a row under the toolbar with the match count. Enter finds the next match,
// Shift+Enter the previous one, Esc closes and gives the keyboard back to the page.
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { getElectronBrowser } from "../../session/panel/utils";

export type FindBarHandle = { focus: () => void };

type FindBarProps = {
  tabId: string;
  /** The tab's address: a new page is searched again. */
  url: string;
  onClose: () => void;
};

type Result = { matches: number; active: number };

export const FindBar = React.forwardRef<FindBarHandle, FindBarProps>(function FindBar({ tabId, url, onClose }, ref) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [text, setText] = React.useState("");
  const [result, setResult] = React.useState<Result | null>(null);
  const latestRef = React.useRef<number | null>(null);

  React.useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  }), []);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Results for this tab's latest search only.
  React.useEffect(() => getElectronBrowser()?.onFindResult?.((next) => {
    if (next.tabId !== tabId || (latestRef.current !== null && next.requestId < latestRef.current)) return;
    setResult({ matches: next.matches, active: next.active });
  }), [tabId]);

  const find = React.useCallback(async (query: string, options?: { forward?: boolean; next?: boolean }) => {
    const browser = getElectronBrowser();
    if (!query) {
      latestRef.current = null;
      setResult(null);
      await browser?.find?.(tabId, "").catch(() => null);
      return;
    }
    const requestId = await browser?.find?.(tabId, query, options).catch(() => null);
    if (typeof requestId === "number") latestRef.current = requestId;
  }, [tabId]);

  // Searching as the person types, and again on a new page.
  React.useEffect(() => {
    const timer = window.setTimeout(() => void find(text), 80);
    return () => window.clearTimeout(timer);
  }, [find, text, url]);

  const close = React.useCallback(() => {
    const browser = getElectronBrowser();
    void browser?.stopFind?.(tabId)?.catch(() => false);
    void browser?.focusPage?.(tabId)?.catch(() => false);
    onClose();
  }, [onClose, tabId]);

  const step = (forward: boolean) => {
    if (text) void find(text, { forward, next: true });
  };

  const count = !text || !result ? null : result.matches === 0 ? t("work_browser.find_none") : t("work_browser.find_count", { active: result.active, total: result.matches });

  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-background px-3" role="search" data-testid="work-browser-find">
      <div className="flex h-8 w-[min(380px,55%)] min-w-0 items-center gap-2 rounded-lg border border-input bg-background px-2.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              step(!event.shiftKey);
            } else if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          placeholder={t("work_browser.find_placeholder")}
          aria-label={t("work_browser.find_placeholder")}
          spellCheck={false}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          data-testid="work-browser-find-input"
        />
        {count ? (
          <span
            className={cn("shrink-0 text-xs tabular-nums", result?.matches === 0 ? "text-foreground" : "text-muted-foreground")}
            role="status"
            data-testid="work-browser-find-count"
          >
            {count}
          </span>
        ) : null}
      </div>
      <Button variant="ghost" size="icon-sm" onClick={() => step(false)} disabled={!result?.matches} aria-label={t("work_browser.find_previous")} title={t("work_browser.find_previous")} data-testid="work-browser-find-previous">
        <ChevronUp />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={() => step(true)} disabled={!result?.matches} aria-label={t("work_browser.find_next")} title={t("work_browser.find_next")} data-testid="work-browser-find-next">
        <ChevronDown />
      </Button>
      <div className="flex-1" />
      <Button variant="ghost" size="icon-sm" onClick={close} aria-label={t("work_browser.find_close")} title={t("work_browser.find_close")} data-testid="work-browser-find-close">
        <X />
      </Button>
    </div>
  );
});
