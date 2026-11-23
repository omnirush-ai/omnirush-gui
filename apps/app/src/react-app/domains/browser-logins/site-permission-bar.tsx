/** @jsxImportSource react */
// Calls and alerts in the built-in browser (Work): the one-line question above the page ("meet.google.com wants to
// use your camera and microphone. Block / Allow"), the screen picker that covers the page while someone shares, and
// the switch that turns both on for Work accounts. The questions only ever come for the person's own tabs.
import type { BrowserPanelTab } from "@omnirush/browser-tabs";
import { useQuery } from "@tanstack/react-query";
import { AppWindow, Bell, Mic, Monitor, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { BrowserScreenSource } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { getBrowserSitesBridge, sitePromptMessage, sitePromptParts, siteHost, useSitePromptsGate } from "./site-permissions";

/** Mounted once for the app: Work accounts get the per-site questions, everyone else keeps them denied. */
export function BrowserSitePrompts() {
  useSitePromptsGate();
  return null;
}

type SitePrompt = NonNullable<BrowserPanelTab["sitePrompt"]>;

function report(error: unknown) {
  toast.error(error instanceof Error ? error.message : String(error));
}

/** The question above the page. Renders nothing without one (and for a screen, which gets the picker). */
export function SitePermissionBar({ tab }: { tab: BrowserPanelTab }) {
  const prompt = tab.sitePrompt;
  const bridge = getBrowserSitesBridge();
  if (!prompt || !bridge || prompt.kinds[0] === "screen") return null;
  const Icon = prompt.kinds.includes("notifications") ? Bell : prompt.kinds.includes("camera") ? Video : Mic;
  const answer = (choice: "allow" | "block" | "dismiss") => {
    void bridge.answer(tab.id, prompt.id, choice).catch(report);
  };
  const message = sitePromptMessage(prompt);
  const parts = sitePromptParts(prompt);
  return (
    <div
      role="region"
      aria-label={t("site_permissions.prompt_label")}
      aria-live="polite"
      data-testid="site-permission-bar"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-muted/50 px-3 py-2"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
        <Icon aria-hidden className="size-4 text-foreground" />
      </span>
      <p className="line-clamp-2 min-w-48 flex-1 text-[13px] leading-5 text-foreground" title={`${message} (${prompt.origin})`}>
        {parts.before}
        {parts.host ? <span className="inline-block max-w-[16rem] truncate align-bottom font-medium" data-testid="site-permission-host">{parts.host}</span> : null}
        {parts.after}
      </p>
      <div className="ms-auto flex shrink-0 items-center gap-2">
        {prompt.system ? (
          <>
            <Button variant="ghost" size="sm" className="h-7 px-3 text-[13px]" onClick={() => answer("dismiss")}>
              {t("site_permissions.dismiss")}
            </Button>
            <Button
              size="sm"
              className="h-7 px-3 text-[13px]"
              onClick={() => {
                void bridge.openSystemSettings(prompt.kinds.includes("camera") ? "camera" : "microphone").catch(report);
                answer("dismiss");
              }}
            >
              {t("site_permissions.open_settings")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" className="h-7 px-3 text-[13px]" onClick={() => answer("block")} data-testid="site-permission-block">
              {t("site_permissions.block")}
            </Button>
            <Button size="sm" className="h-7 px-3 text-[13px]" onClick={() => answer("allow")} data-testid="site-permission-allow">
              {t("site_permissions.allow")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Screens first, then this many windows until the person asks for all of them (8 tiles in all). */
const PICKER_TILES = 8;

/** Covers the page (the native view is hidden meanwhile) while a site asks to see a screen or a window. */
export function ScreenSharePicker({ tab }: { tab: BrowserPanelTab }) {
  const prompt = tab.sitePrompt;
  if (!prompt || prompt.kinds[0] !== "screen" || !getBrowserSitesBridge()) return null;
  return <Picker key={prompt.id} tabId={tab.id} prompt={prompt} />;
}

function Picker({ tabId, prompt }: { tabId: string; prompt: SitePrompt }) {
  const bridge = getBrowserSitesBridge()!;
  const host = siteHost(prompt.origin);
  const sources = useQuery({
    queryKey: ["browser-screen-sources", prompt.id],
    queryFn: () => bridge.screenSources(tabId, prompt.id),
    staleTime: Infinity,
    retry: false,
  });
  const [selected, setSelected] = useState<BrowserScreenSource | null>(null);
  const [showAll, setShowAll] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const answer = (choice: "dismiss" | { share: { id: string; name: string } }) => {
    void bridge.answer(tabId, prompt.id, choice).catch(report);
  };
  const share = (source: BrowserScreenSource | null) => {
    if (source) answer({ share: { id: source.id, name: source.name } });
  };

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const all = sources.data?.sources ?? [];
  const screens = all.filter((source) => source.kind === "screen");
  const windows = all.filter((source) => source.kind === "window");
  const windowRoom = Math.max(PICKER_TILES - screens.length, 2);
  const shownWindows = showAll ? windows : windows.slice(0, windowRoom);
  const denied = sources.data?.access === "denied";

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="screen-share-title"
      data-testid="screen-share-picker"
      className="absolute inset-0 z-10 flex flex-col bg-background outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          answer("dismiss");
        }
      }}
    >
      <div className="border-b border-border px-5 py-4">
        <h3 id="screen-share-title" className="line-clamp-2 break-words text-[15px] font-semibold leading-6 text-foreground" title={prompt.origin}>
          {t("site_permissions.screen_title", { host })}
        </h3>
        <p className="mt-0.5 text-[13px] leading-5 text-dls-secondary">{t("site_permissions.screen_desc", { host })}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {sources.isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(9rem,100%),1fr))] gap-3" aria-label={t("site_permissions.screen_loading")}>
            {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="aspect-[16/10] w-full rounded-lg" />)}
          </div>
        ) : denied || sources.isError ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-[13px] leading-5 text-foreground">{t("site_permissions.screen_denied")}</p>
            {denied ? (
              <Button size="sm" className="h-8 px-3 text-[13px]" onClick={() => { void bridge.openSystemSettings("screen").catch(report); }}>
                {t("site_permissions.open_settings")}
              </Button>
            ) : null}
          </div>
        ) : all.length === 0 ? (
          <p className="text-[13px] leading-5 text-dls-secondary">{t("site_permissions.screen_none")}</p>
        ) : (
          <div className="flex flex-col gap-5">
            {screens.length > 0 ? (
              <SourceGroup label={t("site_permissions.screen_screens")} sources={screens} selected={selected} onSelect={setSelected} onShare={share} />
            ) : null}
            {windows.length > 0 ? (
              <SourceGroup label={t("site_permissions.screen_windows")} sources={shownWindows} selected={selected} onSelect={setSelected} onShare={share} />
            ) : null}
            {!showAll && windows.length > shownWindows.length ? (
              <Button variant="ghost" size="sm" className="h-7 self-start px-2 text-[13px] text-dls-secondary" onClick={() => setShowAll(true)}>
                {t("site_permissions.show_all", { count: windows.length })}
              </Button>
            ) : null}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="ghost" size="sm" className="h-8 px-3 text-[13px]" onClick={() => answer("dismiss")} data-testid="screen-share-cancel">
          {t("site_permissions.cancel")}
        </Button>
        {all.length > 0 && !denied ? (
          <Button size="sm" className="h-8 px-4 text-[13px]" disabled={!selected} onClick={() => share(selected)} data-testid="screen-share-share">
            {t("site_permissions.share")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SourceGroup(props: {
  label: string;
  sources: BrowserScreenSource[];
  selected: BrowserScreenSource | null;
  onSelect: (source: BrowserScreenSource) => void;
  onShare: (source: BrowserScreenSource) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-[13px] font-medium leading-5 text-dls-secondary">{props.label}</h4>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(9rem,100%),1fr))] gap-3">
        {props.sources.map((source) => {
          const active = props.selected?.id === source.id;
          const Icon = source.kind === "screen" ? Monitor : AppWindow;
          return (
            <button
              key={source.id}
              type="button"
              aria-pressed={active}
              title={source.name}
              data-testid="screen-share-source"
              onClick={() => props.onSelect(source)}
              onDoubleClick={() => props.onShare(source)}
              className={cn(
                "group flex w-full min-w-0 flex-col gap-2 overflow-hidden rounded-xl border p-2 text-start outline-none transition-colors",
                "focus-visible:ring-3 focus-visible:ring-ring/40",
                active ? "border-primary bg-primary/5 ring-2 ring-primary/30" : "border-border hover:border-foreground/25 hover:bg-muted/50",
              )}
            >
              <span className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-lg bg-muted">
                {source.thumbnail ? (
                  <img src={source.thumbnail} alt="" className="size-full object-contain" draggable={false} />
                ) : (
                  <Icon aria-hidden className="size-6 text-dls-secondary" />
                )}
              </span>
              <span className="flex w-full min-w-0 items-center gap-1.5 px-0.5">
                <Icon aria-hidden className="size-3.5 shrink-0 text-dls-secondary" />
                <span className="min-w-0 truncate text-[13px] leading-5 text-foreground">{source.name}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
