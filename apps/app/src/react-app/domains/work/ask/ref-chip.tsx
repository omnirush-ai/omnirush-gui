/** @jsxImportSource react */
// A Work item attached to a question (design 2.1): its mark and title, removable in the composer, read only in the sent
// message (a click opens it: records and deals in the side panel, entities in Knowledge). Both rows stay on one line:
// the chips that do not fit go behind a "+N" chip that lists them.
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { BrandTile } from "../brand-icon";
import { requestOpenRecord } from "../viewer/records";
import { useAskStore } from "./ask-store";
import { PROBE_CLASS, PROBE_ROW_CLASS, useFitCount } from "./fit-row";
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

/** Visible keyboard focus at 3:1 or more on the page (the ring token alone is fainter). */
export const FOCUS_RING = "outline-none focus-visible:ring-2 focus-visible:ring-foreground/60";
const CHIP = "inline-flex h-7 min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-border bg-background ps-1 text-[13px] leading-none text-foreground";
const MORE_CHIP = cn("inline-flex h-7 shrink-0 items-center rounded-full border border-border bg-background px-2.5 text-[13px] font-medium leading-none text-foreground transition-colors hover:bg-muted/60 data-popup-open:bg-muted/60", FOCUS_RING);
const LIST = "w-80 max-w-[calc(100vw-2rem)] gap-0 rounded-2xl p-1.5";
const LIST_ROW = "flex h-9 min-w-0 items-center gap-2 rounded-xl px-2 text-[13px] text-foreground";

function chipTitle(ref: WorkRef): string {
  return [ref.title, refSourceName(ref)].filter(Boolean).join(" · ");
}

export function WorkRefChip(props: { refItem: WorkRef; onRemove?: () => void; flash?: number; probe?: boolean }) {
  const ref = props.refItem;
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!props.flash) return;
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), 700);
    return () => clearTimeout(timer);
  }, [props.flash]);
  if (props.probe) {
    return (
      <span className={cn(CHIP, props.onRemove ? "pe-1" : "pe-2.5")}>
        <BrandTile id={refMark(ref)} name={ref.title} size="chip" className="rounded-full" />
        <span className="min-w-0 truncate">{ref.title}</span>
        {props.onRemove ? <span className="size-5 shrink-0" /> : null}
      </span>
    );
  }
  return (
    <span
      className={cn(CHIP, props.onRemove ? "pe-1" : "pe-2.5", "transition-[background-color,box-shadow] duration-300", flashing && "bg-muted ring-2 ring-ring/40")}
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
          className={cn("flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", FOCUS_RING)}
          data-ref-remove={refKey(ref)}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/** "+N": the chips that did not fit, as a list (removable in the composer, opening in the sent message). */
function MoreRefs(props: {
  refs: readonly WorkRef[];
  hiddenFrom: number;
  /** A hidden chip was asked about again: the "+N" chip flashes once. */
  flash?: number;
  onRemove?: (key: string) => void;
  onOpen?: (ref: WorkRef) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!props.flash) return;
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), 700);
    return () => clearTimeout(timer);
  }, [props.flash]);
  const listRef = useRef<HTMLUListElement>(null);
  const rest = props.refs.slice(props.hiddenFrom);
  const count = rest.length;
  // The list closes once nothing is left behind the chip.
  useEffect(() => {
    if (open && count === 0) setOpen(false);
  }, [count, open]);
  if (count === 0) return null;
  const remove = (key: string, index: number) => {
    props.onRemove?.(key);
    // Focus stays in the list: the next item's remove button, else the previous one; the composer once it empties.
    window.requestAnimationFrame(() => {
      const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-ref-remove]") ?? []);
      const next = buttons[Math.min(index, buttons.length - 1)];
      if (next) next.focus();
      else window.dispatchEvent(new Event("omnirush:focusPrompt"));
    });
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(
          <button
            type="button"
            className={cn(MORE_CHIP, "transition-[background-color,box-shadow] duration-300", flashing && "bg-muted ring-2 ring-ring/40")}
            aria-label={t("work.ask.more_label", { count })}
            title={rest.map((ref) => ref.title).join("\n")}
            data-ref-more={count}
            data-testid={`${props.testId}-more`}
          >
            {t("work.ask.more_count", { count })}
          </button>
        )}
      />
      <PopoverContent align="end" side="top" sideOffset={6} className={LIST} data-testid={`${props.testId}-more-list`}>
        <ul ref={listRef} className="flex max-h-72 flex-col overflow-y-auto" aria-label={t("work.ask.more_list")}>
          {rest.map((ref, index) => {
            const key = refKey(ref);
            const face = (
              <>
                <BrandTile id={refMark(ref)} name={ref.title} size="chip" className="rounded-full" />
                <span className="min-w-0 flex-1 truncate text-start">{ref.title}</span>
              </>
            );
            return (
              <li key={key} className="min-w-0" data-ref-more-item={key}>
                {props.onRemove ? (
                  <div className={LIST_ROW} title={chipTitle(ref)}>
                    {face}
                    <button
                      type="button"
                      aria-label={t("work.ask.remove", { title: ref.title })}
                      onClick={() => remove(key, index)}
                      className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", FOCUS_RING)}
                      data-ref-remove={key}
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </div>
                ) : props.onOpen && canOpenRef(ref) ? (
                  <button
                    type="button"
                    title={chipTitle(ref)}
                    onClick={() => { setOpen(false); props.onOpen?.(ref); }}
                    className={cn(LIST_ROW, "w-full transition-colors hover:bg-muted/60", FOCUS_RING)}
                  >
                    {face}
                  </button>
                ) : (
                  <div className={LIST_ROW} title={chipTitle(ref)}>{face}</div>
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** The chips at the top of a Work composer: one line, the rest behind "+N". */
export function WorkRefChips(props: { owner: string; refs: readonly WorkRef[]; onRemove: (key: string) => void; className?: string }) {
  const flash = useAskStore((state) => (state.flash?.owner === props.owner ? state.flash : null));
  const signature = props.refs.map(refKey).join("\u0001");
  const { fit, row, probe } = useFitCount({ count: props.refs.length, signature });
  if (!props.refs.length) return null;
  const shown = props.refs.slice(0, fit);
  const hiddenFlash = flash && props.refs.slice(fit).some((ref) => refKey(ref) === flash.key) ? flash.nonce : undefined;
  return (
    <div ref={row} className={cn("relative flex w-full min-w-0 flex-nowrap items-center gap-1.5", props.className)} data-testid="work-ref-chips">
      <div className="flex min-w-0 flex-nowrap items-center gap-1.5" role="list" aria-label={t("work.ask.attached")}>
        {shown.map((ref) => {
          const key = refKey(ref);
          return <WorkRefChip key={key} refItem={ref} onRemove={() => props.onRemove(key)} flash={flash?.key === key ? flash.nonce : undefined} />;
        })}
      </div>
      <MoreRefs refs={props.refs} hiddenFrom={fit} flash={hiddenFlash} onRemove={props.onRemove} testId="work-ref-chips" />
      <div className={PROBE_CLASS} aria-hidden inert>
        <div ref={probe} className={PROBE_ROW_CLASS}>
          {props.refs.map((ref) => <WorkRefChip key={refKey(ref)} refItem={ref} onRemove={() => {}} probe />)}
          <span className={MORE_CHIP}>{t("work.ask.more_count", { count: props.refs.length })}</span>
        </div>
      </div>
    </div>
  );
}

/** "Added {title} to your question", for screen readers (one live region, always mounted while Work is on). */
export function AskAnnouncer() {
  const announce = useAskStore((state) => state.announce);
  return <span className="sr-only" aria-live="polite" data-testid="work-ask-announcer">{announce}</span>;
}

function SentChip(props: { refItem: WorkRef; probe?: boolean }) {
  const ref = props.refItem;
  if (props.probe) return <WorkRefChip refItem={ref} probe />;
  if (!canOpenRef(ref)) return <WorkRefChip refItem={ref} />;
  return (
    <button
      type="button"
      role="listitem"
      onClick={() => openRef(ref)}
      title={chipTitle(ref)}
      className={cn(CHIP, "pe-2.5 transition-colors hover:bg-muted/60", FOCUS_RING)}
      data-ref-chip={refKey(ref)}
    >
      <BrandTile id={refMark(ref)} name={ref.title} size="chip" className="rounded-full" />
      <span className="min-w-0 truncate">{ref.title}</span>
    </button>
  );
}

/** The chips above a sent question (rebuilt from the message after a reload): one right-aligned line, then "+N". */
export function WorkRefMessageChips(props: { refs: readonly WorkRef[] }) {
  const signature = props.refs.map(refKey).join("\u0001");
  const { fit, row, probe } = useFitCount({ count: props.refs.length, signature });
  if (!props.refs.length) return null;
  return (
    <div
      ref={row}
      className="relative flex w-full max-w-[85%] min-w-0 flex-nowrap items-center justify-end gap-1.5 sm:max-w-[75%]"
      data-testid="work-ref-message-chips"
    >
      <div className="flex min-w-0 flex-nowrap items-center justify-end gap-1.5" role="list" aria-label={t("work.ask.attached")}>
        {props.refs.slice(0, fit).map((ref) => <SentChip key={refKey(ref)} refItem={ref} />)}
      </div>
      <MoreRefs refs={props.refs} hiddenFrom={fit} onOpen={openRef} testId="work-ref-message-chips" />
      <div className={PROBE_CLASS} aria-hidden inert>
        <div ref={probe} className={PROBE_ROW_CLASS}>
          {props.refs.map((ref) => <SentChip key={refKey(ref)} refItem={ref} probe />)}
          <span className={MORE_CHIP}>{t("work.ask.more_count", { count: props.refs.length })}</span>
        </div>
      </div>
    </div>
  );
}
