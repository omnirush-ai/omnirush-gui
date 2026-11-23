// The viewer's keyboard map (design 2.5, shown by ? in the panel) and the list keys Work pages share: J/K or the
// arrows move between items, Enter opens in the panel, Cmd/Ctrl+Enter at the source, Shift+Enter beside the current one.
import { useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { isEditable, isMac } from "./records";

export { isEditable };

export type Shortcut = { id: string; keys: string[]; label: string; views?: string[] };
/** `Mod` is ⌘ on a Mac, Ctrl elsewhere. Each key is one cap. */
export const RECORD_SHORTCUTS: Shortcut[] = [
  { id: "move", keys: ["J", "K"], label: "work.viewer.key_move" },
  { id: "open", keys: ["Enter"], label: "work.viewer.key_open" },
  { id: "source", keys: ["Mod", "Enter"], label: "work.viewer.key_open_source_list" },
  { id: "step", keys: ["[", "]"], label: "work.viewer.key_step" },
  { id: "reply", keys: ["R"], label: "work.viewer.key_reply", views: ["mail"] },
  { id: "reply_all", keys: ["Shift", "R"], label: "work.viewer.key_reply_all", views: ["mail"] },
  { id: "forward", keys: ["F"], label: "work.viewer.key_forward", views: ["mail"] },
  { id: "comment", keys: ["C"], label: "work.viewer.key_comment", views: ["chat", "issue", "doc", "ticket", "crm", "finance"] },
  { id: "send", keys: ["Mod", "Enter"], label: "work.viewer.key_send" },
  { id: "undo", keys: ["Mod", "Z"], label: "work.viewer.key_undo" },
  { id: "format", keys: ["Mod", "B", "I", "K"], label: "work.viewer.key_format" },
  { id: "o", keys: ["O"], label: "work.viewer.key_open_source" },
  { id: "esc", keys: ["Esc"], label: "work.viewer.key_close" },
  { id: "help", keys: ["?"], label: "work.viewer.key_help" },
];

export function shortcutKeys(keys: string[], mac: boolean): string[] {
  return keys.map((key) => (key === "Mod" ? (mac ? "⌘" : "Ctrl") : key === "Shift" ? (mac ? "⇧" : "Shift") : key === "Enter" ? (mac ? "↵" : "Enter") : key));
}

/** Keys for a list of openable rows (`data-record-row` on each focusable row, `data-work-list` on the list). */
export function useListKeys(open: (row: HTMLElement, options: { external: boolean; newTab: boolean }) => void) {
  return useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.altKey || isEditable(event.target)) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-record-row]");
    const list = event.currentTarget;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-record-row]"));
    const at = row ? rows.indexOf(row) : -1;
    const mod = isMac() ? event.metaKey : event.ctrlKey;
    const key = event.key;
    const move = (by: number) => {
      const next = rows[Math.min(rows.length - 1, Math.max(0, at + by))] ?? rows[0];
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    };
    if (!mod && (key === "j" || key === "ArrowDown")) return move(1);
    if (!mod && (key === "k" || key === "ArrowUp")) return move(-1);
    if (key === "Enter" && row && event.target === row) {
      event.preventDefault();
      open(row, { external: mod, newTab: event.shiftKey });
    }
  }, [open]);
}
