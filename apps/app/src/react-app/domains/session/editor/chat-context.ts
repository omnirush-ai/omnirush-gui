/**
 * The editor's hand-off to the chat ("Ask about selection", "Explain",
 * "Refactor", "Write tests", "Fix with agent"): the code or the problem goes
 * into the chat's composer as a removable chip with its file and lines, and
 * an instruction is prefilled. Nothing is sent: the user reads, edits and
 * sends it (a busy chat queues it as usual).
 */
import { useComposerStateStore } from "../surface/composer-state-store";
import { useEditorStore } from "./editor-store";

/** Fired with the text for the new-task composer; the composer calls preventDefault() when it took it. */
export const NEW_TASK_PREFILL_EVENT = "omnirush:new-task-prefill";

export type ChatContextChip = {
  /** What the chip shows: `src/orders.ts L5–6 · selection` (no square brackets). */
  label: string;
  /** What the agent receives in place of the chip. */
  text: string;
};

export type ChatHandoffResult = { ok: true } | { ok: false; reason: string };

export function sendToChat(sessionId: string | null, instruction: string, chips: ChatContextChip[]): ChatHandoffResult {
  if (!sessionId) {
    // No chat yet: the new-task composer takes it as plain text (it has no chips). Unhandled = no composer on screen.
    const text = [instruction, ...chips.map((chip) => chip.text)].filter(Boolean).join("\n\n");
    const event = new CustomEvent(NEW_TASK_PREFILL_EVENT, { detail: text, cancelable: true });
    if (!window.dispatchEvent(event)) {
      useEditorStore.getState().setIdeChatCollapsed(false);
      return { ok: true };
    }
    return { ok: false, reason: "Open or start a chat first." };
  }
  const store = useComposerStateStore.getState();
  const state = store.sessions[sessionId];
  const draft = state?.draft ?? "";
  const parts = state?.pasteParts ?? [];
  // The label is the chip's key in the draft ([pasted text <label>]): never two chips with one label.
  const taken = new Set(parts.map((part) => part.label));
  const made = chips.map((chip) => {
    const base = Array.from(chip.label.replace(/[[\]]/g, "")).slice(0, 120).join("");
    let label = base;
    for (let n = 2; taken.has(label); n += 1) label = `${base} (${n})`;
    taken.add(label);
    return { id: `editor-${Math.random().toString(36).slice(2)}`, label, text: chip.text, lines: chip.text.split(/\r?\n/).length };
  });
  const placeholders = made.map((part) => `[pasted text ${part.label}]`).join(" ");
  const lead = draft.trim() ? `${draft.replace(/\s+$/, "")}\n` : "";
  store.setPasteParts(sessionId, [...parts, ...made]);
  store.replaceDraft(sessionId, `${lead}${instruction}${instruction && placeholders ? "\n" : ""}${placeholders}`);
  // The chat panel opens if it was folded away, and the composer takes the focus.
  useEditorStore.getState().setIdeChatCollapsed(false);
  window.setTimeout(() => window.dispatchEvent(new Event("omnirush:focusPrompt")), 50);
  return { ok: true };
}

/** A fenced code block for the agent: the file, its lines, and the code. */
export function codeChipText(path: string, startLine: number, endLine: number, language: string, code: string): string {
  const fence = code.includes("```") ? "````" : "```";
  return `${path} lines ${startLine}-${endLine}:\n${fence}${language}\n${code.replace(/\s+$/, "")}\n${fence}`;
}

export function lineLabel(path: string, startLine: number, endLine: number, column?: number): string {
  const name = path.split("/").pop() ?? path;
  if (column !== undefined && startLine === endLine) return `${name} L${startLine}:C${column}`;
  return startLine === endLine ? `${name} L${startLine}` : `${name} L${startLine}–${endLine}`;
}
