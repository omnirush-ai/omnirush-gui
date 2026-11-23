/** @jsxImportSource react */
// One row of suggestion chips for Work (design 4): questions to ask about attached items, replies to the agent and
// fixes the app knows about. A reply chip sends its text; its pencil, Alt+Enter or Shift+click puts the text in the
// composer instead. An action chip runs its action and never sends. Keyboard: a toolbar with roving focus.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ExternalLink, Pencil } from "lucide-react";

import { clipGraphemes } from "@/components/chat/quote";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { isMac } from "../viewer/records";

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

const chipText = (chip: SuggestionChip) => chip.text ?? chip.label;

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

export function SuggestionChipRow(props: {
  chips: SuggestionChip[];
  /** At most this many chips (default 4). */
  max?: number;
  /** The toolbar's name for screen readers ("Questions to ask", "Suggested replies"). */
  label: string;
  onSend: (text: string) => void;
  onFill: (text: string) => void;
  busy?: boolean;
  /** Alt+1..N pick a chip while the composer is focused and empty. */
  shortcuts?: boolean;
  testId?: string;
  className?: string;
}) {
  const shown = useMemo(() => props.chips.slice(0, props.max ?? 4), [props.chips, props.max]);
  const signature = shown.map((chip) => `${chip.id}\u0000${chipText(chip)}`).join("\u0001");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [active, setActive] = useState(0);
  // One click sends once: the row stays used until it shows other chips. An action is held only while it runs.
  const [used, setUsed] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  useEffect(() => {
    setUsed(false);
    setRunning(null);
    setActive(0);
  }, [signature]);
  const at = Math.min(active, Math.max(0, shown.length - 1));
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

  if (shown.length === 0) return null;

  const focusAt = (index: number) => {
    const next = Math.max(0, Math.min(shown.length - 1, index));
    setActive(next);
    buttons.current[next]?.focus();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = buttons.current.findIndex((button) => button === event.target);
    if (index < 0) return;
    const chip = shown[index];
    if (!chip) return;
    switch (event.key) {
      case "ArrowRight": event.preventDefault(); focusAt(index + 1); return;
      case "ArrowLeft": event.preventDefault(); focusAt(index - 1); return;
      case "Home": event.preventDefault(); focusAt(0); return;
      case "End": event.preventDefault(); focusAt(shown.length - 1); return;
      case "Enter":
      case " ":
        event.preventDefault();
        activate(chip, event.key === "Enter" && event.altKey ? "fill" : "send");
        return;
    }
  };
  // Esc goes back to the composer, ahead of the chip's tooltip (which would take the key to close itself).
  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !buttons.current.some((button) => button === event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    window.dispatchEvent(new Event(FOCUS_PROMPT_EVENT));
  };
  const onClick = (chip: SuggestionChip) => (event: ReactMouseEvent) => activate(chip, event.shiftKey ? "fill" : "send");
  const mac = isMac();

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label={props.label}
      aria-orientation="horizontal"
      className={cn("flex flex-wrap items-center gap-1.5", props.className)}
      data-testid={props.testId}
      onKeyDown={onKeyDown}
      onKeyDownCapture={onKeyDownCapture}
    >
      {shown.map((chip, index) => {
        const action = chip.tone === "action";
        const unavailable = Boolean(chip.disabledReason) || (action ? blocked || !chip.onRun : blocked);
        const keys = props.shortcuts ? chipShortcutLabel(index, mac) : null;
        const label = clipGraphemes(chip.label.replace(/\s+/g, " ").trim(), SUGGESTION_LABEL_MAX);
        const tip = chip.disabledReason ?? (keys ? (label === chip.label ? keys : `${chip.label} (${keys})`) : label === chip.label ? null : chip.label);
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
            className={cn(
              "flex h-full min-w-0 items-center gap-1.5 rounded-full text-[12px] text-foreground outline-none",
              action ? "ps-2 pe-3" : "px-3",
              unavailable && "cursor-default",
            )}
            data-suggestion-chip={chip.id}
            data-tone={action ? "action" : "reply"}
          >
            {action && chip.icon ? <span className="flex shrink-0 items-center [&_svg]:size-3.5" aria-hidden>{chip.icon}</span> : null}
            <span className="min-w-0 truncate">{label}</span>
            {action && chip.external ? <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
          </button>
        );
        return (
          <span
            key={chip.id}
            className={cn(
              "group/chip relative inline-flex h-7 max-w-[280px] items-center rounded-full border border-border bg-background transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring",
              unavailable ? "opacity-60" : "hover:bg-muted/60",
            )}
          >
            {tip ? (
              <Tooltip>
                <TooltipTrigger render={button} />
                <TooltipContent>{tip}</TooltipContent>
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
    </div>
  );
}
