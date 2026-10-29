/** @jsxImportSource react */
// Hackathon events (the account status's `events`, apps/desktop/electron/events/app-events.mjs): a badge in
// the sidebar above the account while an event runs, and "Events you joined" in Settings. Display only;
// nothing shows without the block.
import * as React from "react";
import { Flag, RotateCw, X } from "lucide-react";
import type { OmniRushAccountEvents } from "@omnirush/types/desktop-ipc";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { relaunchDesktopApp } from "../../../app/lib/desktop";
import { t } from "../../../i18n";

const DISMISSED_KEY = "omnirush.events.dismissed";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The running event, until it ends by this machine's clock. */
export function activeEvent(events: OmniRushAccountEvents | null | undefined, now = Date.now()) {
  const event = events?.active?.[0];
  return event && Date.parse(event.endsAt) > now ? event : null;
}

/** Hidden with × until the next day (per event); the flag next to the account tools brings it back. */
export function useEventDismissed(name: string | null) {
  const key = name ? `${name}|${today()}` : null;
  const [dismissed, setDismissed] = React.useState(() => Boolean(key) && storage()?.getItem(DISMISSED_KEY) === key);
  React.useEffect(() => setDismissed(Boolean(key) && storage()?.getItem(DISMISSED_KEY) === key), [key]);
  const set = React.useCallback((value: boolean) => {
    if (!key) return;
    if (value) storage()?.setItem(DISMISSED_KEY, key);
    else storage()?.removeItem(DISMISSED_KEY);
    setDismissed(value);
  }, [key]);
  return [dismissed, set] as const;
}

function EventMark({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("flex size-6 shrink-0 items-center justify-center rounded-md bg-highlight text-neutral-900 shadow-sm", className)}>
      <Flag className="size-3.5" strokeWidth={2.25} />
    </span>
  );
}

/** The sidebar's event card (above the account), or nothing. */
export function EventBadge({ events, dismissed, onDismiss }: { events: OmniRushAccountEvents | null | undefined; dismissed: boolean; onDismiss: () => void }) {
  const event = activeEvent(events);
  if (!event || dismissed) return null;
  return (
    <div
      role="status"
      data-testid="event-badge"
      className="mx-0.5 mb-1.5 me-1.5 animate-in fade-in slide-in-from-bottom-1 rounded-lg border border-highlight/35 bg-highlight/10 p-2 duration-500 group-data-[collapsible=icon]:hidden"
    >
      <div className="flex items-start gap-2">
        <EventMark />
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="min-w-0 flex-1 cursor-default" tabIndex={0}>
                <div className="truncate text-xs font-medium leading-5 text-sidebar-foreground" data-testid="event-badge-title">{event.title}</div>
                {/* Two short lines in the narrow sidebar rather than one that breaks at its dot. */}
                <div className="text-[10.5px] leading-snug text-muted-foreground" data-testid="event-badge-detail">
                  <div>{t("events.participating")}</div>
                  <div className="first-letter:uppercase">{event.ends}</div>
                </div>
              </div>
            }
          />
          <TooltipContent side="top" className="max-w-64">{t("events.counting", { name: event.name })}</TooltipContent>
        </Tooltip>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("events.hide")}
          title={t("events.hide")}
          data-testid="event-badge-dismiss"
          className="-me-0.5 -mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <X className="size-3" />
        </button>
      </div>
      {events?.restart ? (
        <button
          type="button"
          onClick={() => void relaunchDesktopApp()}
          data-testid="event-badge-restart"
          className="mt-1.5 ms-8 flex items-start gap-1 text-start text-[10.5px] font-medium leading-snug text-link hover:underline"
        >
          <RotateCw className="mt-px size-3 shrink-0" />
          {t("events.restart")}
        </button>
      ) : null}
    </div>
  );
}

/** "Events you joined" for Settings: name and date, newest first, or an empty state. */
export function EventsJoinedList({ events }: { events: OmniRushAccountEvents }) {
  const running = activeEvent(events);
  return (
    <div className="space-y-3" data-testid="events-joined">
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">{t("events.joined_title")}</div>
      <div className="overflow-hidden rounded-2xl border border-dls-border bg-dls-surface">
        {events.joined.length ? (
          <ul className="divide-y divide-dls-border">
            {events.joined.map((event) => {
              const live = running?.name === event.name;
              return (
                <li key={`${event.name}|${event.joinedAt}`} className="flex items-center gap-3 px-4 py-3">
                  {live ? <EventMark /> : (
                    <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dls-border bg-dls-hover text-dls-secondary">
                      <Flag className="size-3.5" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-dls-text">{event.name}</div>
                    <div className="truncate text-[11px] text-dls-secondary">
                      {live && running ? running.detail : t("events.joined_on", { date: event.date })}
                    </div>
                  </div>
                  {live ? (
                    <span className="shrink-0 rounded-full bg-highlight/15 px-2 py-0.5 text-[10.5px] font-medium text-dls-text ring-1 ring-highlight/40">{t("events.live")}</span>
                  ) : (
                    <time dateTime={event.joinedAt} className="shrink-0 text-[11px] tabular-nums text-dls-secondary">{event.date}</time>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="flex items-center gap-3 px-4 py-4" data-testid="events-joined-empty">
            <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-dashed border-dls-border text-dls-secondary">
              <Flag className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-dls-text">{t("events.empty_title")}</div>
              <div className="text-[11px] text-dls-secondary">{t("events.empty_detail")}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
