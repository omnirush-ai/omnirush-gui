export const FILE_URL_RE = /^file:\/\//i;
export const HTTP_URL_RE = /^https?:\/\//i;

export type PastedTextSegment =
  | { kind: "text"; text: string }
  | { kind: "line-break" }
  | { kind: "tab" };

export type PastedTextChip = {
  id: string;
  label: string;
  text: string;
  lines: number;
};

const WHITESPACE_RE = /\s/;

export function isStandaloneHttpUrl(text: string) {
  return HTTP_URL_RE.test(text) && !WHITESPACE_RE.test(text);
}

export function shouldCollapsePastedText(text: string, wouldOverflowComposer: boolean) {
  return wouldOverflowComposer && !isStandaloneHttpUrl(text);
}

export function createPastedTextChip(text: string): PastedTextChip {
  const id = `paste-${Math.random().toString(36).slice(2)}`;
  const lines = text.split(/\r?\n/).length;
  return {
    id,
    label: `${id.slice(-4)} · ${lines} lines`,
    text,
    lines,
  };
}

export function resolvePastedTextPlaceholders(text: string, pastedText: readonly Pick<PastedTextChip, "label" | "text">[]) {
  let resolved = text;
  for (const part of pastedText) {
    resolved = resolved.replace(`[pasted text ${part.label}]`, part.text);
  }
  return resolved;
}

/** The labels of `[pasted text …]` placeholders in `text` that no part resolves (lost, e.g. after a reload). */
export function unresolvedPasteLabels(text: string, pastedText: readonly Pick<PastedTextChip, "label">[]): string[] {
  const known = new Set(pastedText.map((part) => part.label));
  return [...text.matchAll(/\[pasted text ([^\]]+)\]/g)].map((match) => match[1] ?? "").filter((label) => !known.has(label));
}

/**
 * Whether a built draft still has a `[pasted text …]` placeholder with no part behind it (its text was lost, e.g. a
 * draft saved by an older version): such a draft is never sent or queued, or the model would get the bare token.
 */
export function draftHasLostPaste(draft: { text: string; parts: readonly { type: string; label?: string }[] } | null | undefined): boolean {
  if (!draft) return false;
  const known = draft.parts.flatMap((part) => (part.type === "paste" && typeof part.label === "string" ? [{ label: part.label }] : []));
  return unresolvedPasteLabels(draft.text, known).length > 0;
}

export const LOST_PASTE_MESSAGE = "A pasted text or quote in this message is no longer available. Remove its chip and paste or quote it again.";

export function splitPastedText(text: string) {
  const segments: PastedTextSegment[] = [];
  for (const part of text.split(/(\r?\n|\t)/)) {
    if (part === "\n" || part === "\r\n") {
      segments.push({ kind: "line-break" });
    } else if (part === "\t") {
      segments.push({ kind: "tab" });
    } else if (part) {
      segments.push({ kind: "text", text: part });
    }
  }
  return segments;
}
