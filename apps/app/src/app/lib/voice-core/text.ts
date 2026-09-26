/** Han, Hiragana, Katakana, Hangul, and CJK punctuation: written without spaces between words. */
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;
const CJK_GLOBAL = new RegExp(CJK.source, "gu");
/** Punctuation that attaches to the word before it. */
const CLOSING = /^[.,!?;:%)\]}'"’”…、。，！？：；）」』]/u;
const OPENING = /[([{'"‘“「『]$/u;

export function isCjk(char: string): boolean {
  return CJK.test(char);
}

/** Words the way a person counts them: whitespace-separated, and every CJK character on its own. */
export function countWords(text: string): number {
  const cjk = text.match(CJK_GLOBAL)?.length ?? 0;
  const rest = text.replace(CJK_GLOBAL, " ").trim();
  return cjk + (rest ? rest.split(/\s+/).length : 0);
}

/** Whether a space belongs between `left` and `right` (the text on either side of a join). */
function needsSpace(left: string, right: string): boolean {
  if (!left || !right) return false;
  const last = left.slice(-1);
  const first = right.slice(0, 1);
  if (/\s/.test(last) || /\s/.test(first)) return false;
  if (CLOSING.test(right) || OPENING.test(left)) return false;
  if (isCjk(last) && isCjk(first)) return false;
  return true;
}

/** Segment texts in recording order, joined the way they were spoken. */
export function stitch(parts: readonly string[]): string {
  let out = "";
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    out += needsSpace(out, part) ? ` ${part}` : part;
  }
  return out;
}

/**
 * `text` as it should be inserted between `before` and `after` (the draft
 * around the cursor): a separating space on each side where a word would
 * otherwise run into its neighbour.
 */
export function padInsertion(before: string, text: string, after: string): string {
  const body = text.trim();
  if (!body) return "";
  return `${needsSpace(before, body) ? " " : ""}${body}${needsSpace(body, after) ? " " : ""}`;
}

/**
 * Whisper-style models answer silence and breath with stock phrases. A
 * segment whose whole text is one of these, from quiet or very short audio,
 * is dropped.
 */
const HALLUCINATIONS = new Set([
  "thank you",
  "thank you very much",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "please subscribe",
  "you",
  "bye",
  "bye bye",
  "okay",
  "so",
  "uh",
  "um",
  "hmm",
  "music",
  "applause",
]);

export function isLikelyHallucination(text: string, audio: { peakRms: number; threshold: number; speechMs: number }): boolean {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return true;
  if (!HALLUCINATIONS.has(normalized)) return false;
  return audio.speechMs < 600 || audio.peakRms < audio.threshold * 2;
}
