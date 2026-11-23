/** @jsxImportSource react */
// One row of suggestion chips for Work (design 4): questions to ask about attached items, replies to the agent and
// fixes the app knows about. A reply chip sends its text; its pencil, Alt+Enter or Shift+click puts the text in the
// composer instead. An action chip runs its action and never sends. The row is always one line: what does not fit
// (or is past `max`) goes into a More menu at its end. Action chips stay first and always show. Keyboard: a toolbar
// with roving focus that includes More.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { ChevronDown, ExternalLink, Pencil } from "lucide-react";

import { clipGraphemes } from "@/components/chat/quote";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { isMac } from "../viewer/records";
import { PROBE_CLASS, PROBE_ROW_CLASS, useFitCount } from "./fit-row";

export type SuggestionChip = {
  id: string;
  /** Shown on the chip, clipped to 40 characters. */
  label: string;
  /** Sent or filled; the label when unset. */
  text?: string;
  /** "action" chips run `onRun` and never send. */
  tone?: "reply" | "action";
  /** A leading icon (action chips). */
  icon?: ReactNode;
  /** The action opens a link: an external mark after the label. */
  external?: boolean;
  onRun?: () => void | Promise<void>;
  /** Shown as the tooltip while the chip cannot be used (for example the wait before Try again). */
  disabledReason?: string;
};

export const SUGGESTION_LABEL_MAX = 40;
const FOCUS_PROMPT_EVENT = "omnirush:focusPrompt";
/** Tooltips wait a moment, so a click or a pass of the pointer does not cover the answer. */
const TOOLTIP_DELAY = 500;

const chipText = (chip: SuggestionChip) => chip.text ?? chip.label;
const chipLabel = (chip: SuggestionChip) => clipGraphemes(chip.label.replace(/\s+/g, " ").trim(), SUGGESTION_LABEL_MAX);

/** "⌥1" on a Mac, "Alt+1" elsewhere. */
export function chipShortcutLabel(index: number, mac = isMac()): string {
  return mac ? `⌥${index + 1}` : `Alt+${index + 1}`;
}

/** The composer's editor, focused and empty, in the same chat as `root` (or anywhere when the row is not in a chat). */
function emptyComposerFocused(root: HTMLElement | null): boolean {
  const active = typeof document === "undefined" ? null : document.activeElement;
  if (!(active instanceof HTMLElement) || !active.isContentEditable) return false;
  if (!active.closest("[data-composer-panel]")) return false;
  if ((active.textContent ?? "").trim()) return false;
  const scope = root?.closest("[data-session-surface-id]");
  return !scope || scope.contains(active);
}

// Chips: 32 px tall, 13 px text, the source-chip look. Focus is a 3:1 ring on the chip.
const CHIP_SHELL = "group/chip relative inline-flex h-8 min-w-0 max-w-[280px] shrink-0 items-center rounded-full border border-border bg-background transition-colors has-focus-visible:ring-2 has-focus-visible:ring-foreground/60";
const CHIP_BUTTON = "flex h-full min-w-0 items-center gap-1.5 rounded-full text-[13px] leading-none text-foreground outline-none";
const MORE_BUTTON = "inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-border bg-background ps-3 pe-2.5 text-[13px] leading-none text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-foreground/60 data-popup-open:bg-muted/60";
const MENU_POPUP = "z-50 min-w-48 max-w-[min(22rem,calc(100vw-2rem))] origin-(--transform-origin) rounded-xl border border-border bg-popover p-1 text-popover-foreground outline-none";
const MENU_ITEM = "flex h-8 min-w-0 cursor-default select-none items-center gap-2 rounded-lg px-2.5 text-[13px] text-foreground outline-none data-highlighted:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/60 data-disabled:opacity-60";

function ChipFace(props: { chip: SuggestionChip; label: string }) {
  const action = props.chip.tone === "action";
  return (
    <>
      {action && props.chip.icon ? <span className="flex shrink-0 items-center [&_svg]:size-3.5" aria-hidden>{props.chip.icon}</span> : null}
      <span className="min-w-0 truncate">{props.label}</span>
      {action && props.chip.external ? <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
    </>
  );
}

export function SuggestionChipRow(props: {
  chips: SuggestionChip[];
  /** At most this many chips on the row (default 4); the rest are in More. */
  max?: number;
  /** The toolbar's name for screen readers ("Questions to ask", "Suggested replies"). */
  label: string;
  onSend: (text: string) => void;
  onFill: (text: string) => void;
  busy?: boolean;
  /** Alt+1..N pick a chip while the composer is focused and empty. */
  shortcuts?: boolean;
  /** Where tooltips open: below the chips (default) keeps the answer above readable. */
  tooltipSide?: "top" | "bottom";
  testId?: string;
  className?: string;
}) {
  const chips = props.chips;
  const signature = chips.map((chip) => `${chip.id}\u0000${chipText(chip)}\u0000${chip.disabledReason ?? ""}`).join("\u0001");
  // Action chips lead the row and always show.
  const pinned = useMemo(() => {
    let count = 0;
    while (count < chips.length && chips[count]!.tone === "action") count += 1;
    return count;
  }, [chips]);
  const { fit, row, probe } = useFitCount({ count: chips.length, signature, pinned, max: Math.max(props.max ?? 4, pinned) });
  const shown = chips.slice(0, fit);
  const rest = chips.slice(fit);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [active, setActive] = useState(0);
  // One click sends once: the row stays used until it shows other chips. An action is held only while it runs.
  const [used, setUsed] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  // One tooltip at a time.
  const [tip, setTip] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const skipMenuClick = useRef(false);
  useEffect(() => {
    setUsed(false);
    setRunning(null);
    setActive(0);
    setTip(null);
  }, [signature]);
  const stops = shown.length + (rest.length ? 1 : 0);
  const at = Math.min(active, Math.max(0, stops - 1));
  const blocked = Boolean(props.busy) || used || running !== null;

  const latest = useRef({ shown, props, blocked });
  latest.current = { shown, props, blocked };

  const activate = (chip: SuggestionChip, mode: "send" | "fill") => {
    const current = latest.current;
    if (chip.disabledReason) return;
    if (chip.tone === "action") {
      if (current.blocked || !chip.onRun) return;
      setRunning(chip.id);
      void Promise.resolve()
        .then(() => chip.onRun?.())
        .catch(() => undefined)
        .finally(() => setRunning((id) => (id === chip.id ? null : id)));
      return;
    }
    if (mode === "fill") {
      current.props.onFill(chipText(chip));
      return;
    }
    if (current.blocked) return;
    setUsed(true);
    setTip(null);
    current.props.onSend(chipText(chip));
  };
  const activateRef = useRef(activate);
  activateRef.current = activate;

  // Alt+1..N from an empty, focused composer. Matched on `code`, so Option+digit works on a Mac keyboard layout.
  useEffect(() => {
    if (!props.shortcuts || shown.length === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (!digit) return;
      const chip = latest.current.shown[Number(digit) - 1];
      if (!chip || !emptyComposerFocused(rootRef.current)) return;
      event.preventDefault();
      event.stopPropagation();
      activateRef.current(chip, "send");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props.shortcuts, shown.length]);

  if (chips.length === 0) return null;

  const focusAt = (index: number) => {
    const next = Math.max(0, Math.min(stops - 1, index));
    setActive(next);
    buttons.current[next]?.focus();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = buttons.current.slice(0, stops).findIndex((button) => button === event.target);
    if (index < 0) return;
    switch (event.key) {
      case "ArrowRight": event.preventDefault(); focusAt(index + 1); return;
      case "ArrowLeft": event.preventDefault(); focusAt(index - 1); return;
      case "Home": event.preventDefault(); focusAt(0); return;
      case "End": event.preventDefault(); focusAt(stops - 1); return;
    }
    const chip = shown[index];
    // More opens its menu itself (Enter, Space, Arrow down).
    if (!chip) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(chip, event.key === "Enter" && event.altKey ? "fill" : "send");
    }
  };
  // Esc goes back to the composer, ahead of the chip's tooltip (which would take the key to close itself).
  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !buttons.current.slice(0, stops).some((button) => button === event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    setTip(null);
    window.dispatchEvent(new Event(FOCUS_PROMPT_EVENT));
  };
  const onClick = (chip: SuggestionChip) => (event: ReactMouseEvent) => activate(chip, event.shiftKey ? "fill" : "send");
  const mac = isMac();
  const tipSide = props.tooltipSide ?? "bottom";
  const tipProps = (id: string) => ({
    open: tip === id,
    onOpenChange: (open: boolean) => setTip((current) => (open ? id : current === id ? null : current)),
  });

  return (
    <TooltipProvider delay={TOOLTIP_DELAY}>
      <div
        ref={(element) => { rootRef.current = element; row.current = element; }}
        role="toolbar"
        aria-label={props.label}
        aria-orientation="horizontal"
        className={cn("relative flex w-full min-w-0 flex-nowrap items-center gap-1.5", props.className)}
        data-testid={props.testId}
        onKeyDown={onKeyDown}
        onKeyDownCapture={onKeyDownCapture}
      >
        {shown.map((chip, index) => {
          const action = chip.tone === "action";
          const unavailable = Boolean(chip.disabledReason) || (action ? blocked || !chip.onRun : blocked);
          const keys = props.shortcuts ? chipShortcutLabel(index, mac) : null;
          const label = chipLabel(chip);
          const tipText = chip.disabledReason ?? (keys ? (label === chip.label ? keys : `${chip.label} (${keys})`) : label === chip.label ? null : chip.label);
          const button = (
            <button
              ref={(element) => { buttons.current[index] = element; }}
              type="button"
              tabIndex={index === at ? 0 : -1}
              aria-disabled={unavailable || undefined}
              aria-keyshortcuts={keys ? `Alt+${index + 1}` : undefined}
              aria-label={label === chip.label ? undefined : chip.label}
              onFocus={() => setActive(index)}
              onClick={onClick(chip)}
              className={cn(CHIP_BUTTON, action ? "ps-2.5 pe-3" : "px-3", unavailable && "cursor-default")}
              data-suggestion-chip={chip.id}
              data-tone={action ? "action" : "reply"}
            >
              <ChipFace chip={chip} label={label} />
            </button>
          );
          return (
            <span key={chip.id} className={cn(CHIP_SHELL, unavailable ? "opacity-60" : "hover:bg-muted/60")}>
              {tipText ? (
                <Tooltip {...tipProps(chip.id)}>
                  <TooltipTrigger render={button} />
                  <TooltipContent side={tipSide} sideOffset={6}>{tipText}</TooltipContent>
                </Tooltip>
              ) : button}
              {action ? null : (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t("work.ask.edit_before_sending")}
                  title={t("work.ask.edit_before_sending")}
                  onClick={() => activate(chip, "fill")}
                  // On the chip's top corner while it is hovered or focused, so the label keeps even padding.
                  className="pointer-events-none absolute -end-1.5 -top-2 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-muted hover:text-foreground group-hover/chip:pointer-events-auto group-hover/chip:opacity-100 group-has-focus-visible/chip:pointer-events-auto group-has-focus-visible/chip:opacity-100"
                  data-suggestion-edit={chip.id}
                >
                  <Pencil className="size-3" aria-hidden />
                </button>
              )}
            </span>
          );
        })}
        {rest.length ? (
          <Menu.Root open={menuOpen} onOpenChange={(open: boolean) => { setMenuOpen(open); if (open) setTip(null); }}>
            <Menu.Trigger
              render={(
                <button
                  ref={(element) => { buttons.current[shown.length] = element; }}
                  type="button"
                  tabIndex={at === shown.length ? 0 : -1}
                  onFocus={() => setActive(shown.length)}
                  aria-label={t("work.suggest.more_label", { count: rest.length })}
                  className={MORE_BUTTON}
                  data-suggestion-more={rest.length}
                >
                  {t("work.suggest.more")}
                  <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
                </button>
              )}
            />
            <Menu.Portal>
              <Menu.Positioner side="top" align="start" sideOffset={6} className="isolate z-50 outline-none">
                <Menu.Popup className={MENU_POPUP} data-testid={props.testId ? `${props.testId}-more` : undefined}>
                  {rest.map((chip) => {
                    const action = chip.tone === "action";
                    const unavailable = Boolean(chip.disabledReason) || (action ? blocked || !chip.onRun : blocked);
                    const label = chipLabel(chip);
                    return (
                      <Menu.Item
                        key={chip.id}
                        disabled={unavailable}
                        title={chip.disabledReason ?? (label === chip.label ? undefined : chip.label)}
                        className={MENU_ITEM}
                        data-suggestion-menu-item={chip.id}
                        data-tone={action ? "action" : "reply"}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" || !event.altKey || action) return;
                          event.preventDefault();
                          (event as unknown as { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
                          skipMenuClick.current = true;
                          window.setTimeout(() => { skipMenuClick.current = false; }, 0);
                          setMenuOpen(false);
                          activate(chip, "fill");
                        }}
                        onClick={(event) => {
                          if (skipMenuClick.current) return;
                          activate(chip, event.shiftKey ? "fill" : "send");
                        }}
                      >
                        <ChipFace chip={chip} label={label} />
                      </Menu.Item>
                    );
                  })}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        ) : null}
        <div className={PROBE_CLASS} aria-hidden inert>
          <div ref={probe} className={PROBE_ROW_CLASS}>
            {chips.map((chip) => (
              <span key={chip.id} className={CHIP_SHELL}>
                <span className={cn(CHIP_BUTTON, chip.tone === "action" ? "ps-2.5 pe-3" : "px-3")}><ChipFace chip={chip} label={chipLabel(chip)} /></span>
              </span>
            ))}
            <span className={MORE_BUTTON}>{t("work.suggest.more")}<ChevronDown className="size-3.5" aria-hidden /></span>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
