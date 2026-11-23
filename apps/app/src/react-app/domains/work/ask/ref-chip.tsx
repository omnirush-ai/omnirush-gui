/** @jsxImportSource react */
// A Work item attached to a question (design 2.1): its mark and title, removable in the composer, read only in the sent
// message (a click opens it: records and deals in the side panel, entities in Knowledge).
import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { BrandTile } from "../brand-icon";
import { requestOpenRecord } from "../viewer/records";
import { useAskStore } from "./ask-store";
import { refKey, refMark, refSourceName, type WorkRef } from "./refs";

/** Knowledge opens at an entity (the session route listens). */
export const OPEN_WORK_ENTITY_EVENT = "omnirush-open-work-entity";

/** Whether a sent chip can open its item. */
export const canOpenRef = (ref: WorkRef) => Boolean(ref.sourceId || ref.entityId);

export function openRef(ref: WorkRef) {
  if (typeof window === "undefined") return;
  if (ref.sourceId) {
    requestOpenRecord({ sourceId: ref.sourceId, source: ref.source ?? null, kind: ref.rawKind ?? null, title: ref.title, url: ref.url ?? null });
    return;
  }
  if (ref.entityId) window.dispatchEvent(new CustomEvent<{ entityId: string }>(OPEN_WORK_ENTITY_EVENT, { detail: { entityId: ref.entityId } }));
}

/** The message parts a sent draft's chips show as (the optimistic user message, before the engine answers). */
export function refUIParts(refs: readonly WorkRef[], id: string): { type: "data-ref"; id: string; data: { refs: WorkRef[] } }[] {
  return refs.length ? [{ type: "data-ref", id, data: { refs: [...refs] } }] : [];
}

const CHIP = "inline-flex h-7 min-w-0 max-w-[260px] items-center gap-1.5 rounded-full border border-border bg-background ps-1 text-[12px] text-foreground";

function chipTitle(ref: WorkRef): string {
  return [ref.title, refSourceName(ref)].filter(Boolean).join(" · ");
}

export function WorkRefChip(props: { refItem: WorkRef; onRemove?: () => void; flash?: number }) {
  const ref = props.refItem;
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!props.flash) return;
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), 700);
    return () => clearTimeout(timer);
  }, [props.flash]);
  return (
    <span
      className={cn(CHIP, "pe-1 transition-[background-color,box-shadow] duration-300", flashing && "bg-muted ring-2 ring-ring/40")}
      title={chipTitle(ref)}
      data-ref-chip={refKey(ref)}
      role="listitem"
    >
      <BrandTile id={refMark(ref)} name={ref.title} size="chip" className="rounded-full" />
      <span className="min-w-0 truncate">{ref.title}</span>
      {props.onRemove ? (
        <button
          type="button"
          aria-label={t("work.ask.remove", { title: ref.title })}
          onClick={props.onRemove}
          className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          data-ref-remove={refKey(ref)}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : <span className="w-1.5" />}
    </span>
  );
}

/** The chips at the top of a Work composer. */
export function WorkRefChips(props: { owner: string; refs: readonly WorkRef[]; onRemove: (key: string) => void; className?: string }) {
  const flash = useAskStore((state) => (state.flash?.owner === props.owner ? state.flash : null));
  if (!props.refs.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", props.className)} role="list" aria-label={t("work.ask.attached")} data-testid="work-ref-chips">
      {props.refs.map((ref) => {
        const key = refKey(ref);
        return <WorkRefChip key={key} refItem={ref} onRemove={() => props.onRemove(key)} flash={flash?.key === key ? flash.nonce : undefined} />;
      })}
    </div>
  );
}

/** "Added {title} to your question", for screen readers (one live region, always mounted while Work is on). */
export function AskAnnouncer() {
  const announce = useAskStore((state) => state.announce);
  return <span className="sr-only" aria-live="polite" data-testid="work-ask-announcer">{announce}</span>;
}

/** The chips above a sent question (rebuilt from the message after a reload). */
export function WorkRefMessageChips(props: { refs: readonly WorkRef[] }) {
  if (!props.refs.length) return null;
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5 sm:max-w-[75%]" role="list" aria-label={t("work.ask.attached")} data-testid="work-ref-message-chips">
      {props.refs.map((ref) => (
        canOpenRef(ref) ? (
          <button
            key={refKey(ref)}
            type="button"
            role="listitem"
            onClick={() => openRef(ref)}
            title={chipTitle(ref)}
            className={cn(CHIP, "pe-2.5 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring")}
            data-ref-chip={refKey(ref)}
          >
            <BrandTile id={refMark(ref)} name={ref.title} size="chip" className="rounded-full" />
            <span className="min-w-0 truncate">{ref.title}</span>
          </button>
        ) : <WorkRefChip key={refKey(ref)} refItem={ref} />
      ))}
    </div>
  );
}
