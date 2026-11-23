/** @jsxImportSource react */
// Long Work lists (members, invites, activity, people, connectors) show a first page, then "Show N more" a page at a
// time, with a search field once they can grow past one screen. Nothing on a Work page grows without bound.
import { Search, X } from "lucide-react";
import { useState } from "react";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/** How many rows a capped list shows now, and the buttons' next steps. */
export function useListCap(total: number, first: number, step = first) {
  const [limit, setLimit] = useState(first);
  const shown = Math.min(total, limit);
  return {
    shown,
    more: total - shown,
    expanded: limit > first,
    showMore: () => setLimit((current) => current + step),
    showLess: () => setLimit(first),
    reset: () => setLimit(first),
    nextStep: Math.min(step, total - shown),
  };
}

/** "Show N more" under a capped list, and "Show less" once it was opened. Nothing when it all fits. */
export function ListMore(props: { cap: ReturnType<typeof useListCap>; testId?: string; className?: string }) {
  const { cap } = props;
  if (cap.more <= 0 && !cap.expanded) return null;
  const button = "rounded-md px-1 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className={cn("flex items-center gap-3", props.className)} data-testid={props.testId}>
      {cap.more > 0 ? (
        <button type="button" className={button} onClick={cap.showMore} data-list-more="">
          {t("work.list.show_more", { count: cap.nextStep, n: cap.nextStep.toLocaleString(), total: cap.more.toLocaleString() })}
        </button>
      ) : null}
      {cap.expanded ? <button type="button" className={button} onClick={cap.showLess} data-list-less="">{t("work.today.show_less")}</button> : null}
    </div>
  );
}

/** A compact search field for a list: a leading icon, Escape or the clear button empties it. */
export function ListSearch(props: { value: string; onChange: (value: string) => void; label: string; placeholder?: string; testId?: string; className?: string }) {
  return (
    <label className={cn("relative flex h-9 min-w-0 items-center", props.className)}>
      <Search aria-hidden className="pointer-events-none absolute start-2.5 size-4 text-muted-foreground" />
      <input
        type="search"
        value={props.value}
        aria-label={props.label}
        placeholder={props.placeholder ?? props.label}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape" && props.value) { event.preventDefault(); props.onChange(""); } }}
        data-testid={props.testId}
        className="h-9 w-full min-w-0 rounded-lg border border-border bg-background ps-8 pe-8 text-[13px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 [&::-webkit-search-cancel-button]:hidden"
      />
      {props.value ? (
        <button type="button" aria-label={t("work.list.clear_search")} onClick={() => props.onChange("")} className="absolute end-1.5 flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <X aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </label>
  );
}

/** Case-insensitive match of a query against any of the given texts. */
export const matchesQuery = (query: string, ...texts: (string | null | undefined)[]) => {
  const needle = query.trim().toLowerCase();
  return !needle || texts.some((text) => (text ?? "").toLowerCase().includes(needle));
};

/** A round initial for a person's e-mail or name: the same neutral tile everywhere. */
export function PersonAvatar(props: { name: string; className?: string }) {
  const letter = (props.name.trim()[0] ?? "?").toUpperCase();
  return (
    <span aria-hidden className={cn("flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[12px] font-semibold text-foreground", props.className)}>
      {letter}
    </span>
  );
}

/** A status pill: words in the foreground colour beside a small dot, so it never relies on colour alone. */
export type PillTone = "ok" | "syncing" | "attention" | "error" | "off" | "neutral";
const PILL_DOT: Record<PillTone, string> = {
  ok: "bg-green-9",
  syncing: "bg-blue-9",
  attention: "bg-amber-9",
  error: "bg-red-9",
  off: "bg-muted-foreground/50",
  neutral: "bg-muted-foreground/50",
};
export function StatusPill(props: { tone: PillTone; label: string; testId?: string; className?: string; title?: string }) {
  return (
    <span
      className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-2 text-[12px] font-medium text-foreground", props.className)}
      data-testid={props.testId}
      data-tone={props.tone}
      title={props.title}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", PILL_DOT[props.tone], props.tone === "syncing" && "motion-safe:animate-pulse")} />
      {props.label}
    </span>
  );
}
