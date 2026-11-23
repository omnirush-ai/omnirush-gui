// Suggested replies in Work chats (design 3.5): the agent ends a message with a short block the app hides and shows
// as chips under the newest answer. The Work prompt (apps/server/src/work/prompt.ts SUGGESTED_REPLIES) asks for exactly
// this form:
//   <replies>
//   Send it
//   Make it shorter
//   </replies>
// Only Work chats are transformed; Code chats render their text as it is.
import type { UIMessage } from "ai";

export const REPLIES_MAX = 3;
/** A longer line is not a reply (the prompt asks for 2 to 6 words). */
export const REPLY_CHARS_MAX = 60;

const OPEN = /<replies\s*>/i;
const CLOSE = /<\/replies\s*>/i;
const FENCE = /^\s{0,3}(```|~~~)/;
const LINK = /(?:https?:\/\/|www\.)\S/i;
const BULLET = /^(?:[-*+\u2022\u00b7](?:\s+|$)|\d{1,2}[.)](?:\s+|$))/;
const QUOTES: [string, string][] = [['"', '"'], ["'", "'"], ["\u201c", "\u201d"], ["\u2018", "\u2019"], ["\u300c", "\u300d"], ["`", "`"]];
const TRAILING = /[\s.\u3002!\uff01,\uff0c;\uff1b:\uff1a]+$/u;

export type SplitReplies = {
  /** The text without any replies block (and, while streaming, without a block or tag still coming in). */
  body: string;
  /** The replies of a block at the very end; none for a block elsewhere, an empty block or none at all. */
  replies: string[];
};

/** One reply as shown: bullets, numbers and quotes off, no ending punctuation; null when it is not a usable reply. */
export function cleanReply(line: string): string | null {
  let text = line.replace(/\s+/g, " ").trim().replace(BULLET, "").trim();
  for (const [open, close] of QUOTES) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim();
      break;
    }
  }
  text = text.replace(TRAILING, "").trim();
  if (!text || [...text].length > REPLY_CHARS_MAX || LINK.test(text) || /[<>]/.test(text)) return null;
  return text;
}

function replyLines(lines: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const reply = cleanReply(line);
    if (!reply) continue;
    const key = reply.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reply);
    if (out.length === REPLIES_MAX) break;
  }
  return out;
}

/** Where the opening tag starts on a line (outside inline code), or -1. */
function openTagAt(line: string): { at: number; length: number } | null {
  const match = OPEN.exec(line);
  if (!match) return null;
  const ticks = (line.slice(0, match.index).match(/`/g) ?? []).length;
  return ticks % 2 === 0 ? { at: match.index, length: match[0].length } : null;
}

/** The line without a trailing "<", "<re", "<replies" that may still become the opening tag while the text streams. */
function withoutTagStart(line: string): string {
  const at = line.lastIndexOf("<");
  if (at < 0) return line;
  const tail = line.slice(at).toLowerCase();
  return "<replies>".startsWith(tail) && tail.length < "<replies>".length ? line.slice(0, at).replace(/\s+$/, "") : line;
}

/**
 * The text without its replies block, and the replies when the block is the last thing in it.
 * - A block counts only at the end; one elsewhere is hidden but gives no replies. Blocks inside code fences or inline
 *   code are text.
 * - A block that is never closed runs to the end of the text (a model that forgot the closing tag).
 * - `streaming`: a trailing "<", "<re" or "<replies" that may still become the tag is hidden too, so the raw block never
 *   flickers in while it arrives.
 */
export function splitReplies(text: string, options: { streaming?: boolean } = {}): SplitReplies {
  if (!text.includes("<")) return { body: text, replies: [] };
  const lines = text.split("\n");
  const kept: string[] = [];
  let replies: string[] = [];
  let fenced = false;
  let found = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (FENCE.test(line)) {
      fenced = !fenced;
      kept.push(line);
      continue;
    }
    const open = fenced ? null : openTagAt(line);
    if (!open) {
      kept.push(line);
      continue;
    }
    found = true;
    const before = line.slice(0, open.at).replace(/\s+$/, "");
    if (before.trim()) kept.push(before);
    // The block's lines: what follows the opening tag, up to the closing tag or the end of the text.
    const inner: string[] = [];
    let rest = line.slice(open.at + open.length);
    let closedAt = -1;
    for (let at = index; at < lines.length; at += 1) {
      const current = at === index ? rest : lines[at]!;
      const close = CLOSE.exec(current);
      if (close) {
        inner.push(current.slice(0, close.index));
        rest = current.slice(close.index + close[0].length);
        closedAt = at;
        break;
      }
      inner.push(current);
    }
    if (closedAt < 0) {
      replies = replyLines(inner);
      break;
    }
    const after = [rest, ...lines.slice(closedAt + 1)].join("\n");
    replies = after.trim() ? [] : replyLines(inner);
    // Text after the closing tag on its line stays.
    if (rest.trim()) kept.push(rest.replace(/^\s+/, ""));
    index = closedAt;
  }
  if (options.streaming && !found && kept.length) {
    const tail = withoutTagStart(kept[kept.length - 1]!);
    if (tail !== kept[kept.length - 1]) {
      if (tail.trim()) kept[kept.length - 1] = tail;
      else kept.pop();
      return { body: kept.join("\n").replace(/\s+$/, ""), replies: [] };
    }
  }
  if (!found) return { body: text, replies: [] };
  return { body: kept.join("\n").replace(/\s+$/, ""), replies };
}

const isAssistant = (message: UIMessage) => message.role === "assistant";

/** A message with every text part's block hidden; the same object when nothing changes. */
export function hideRepliesBlock(message: UIMessage, streaming = false): UIMessage {
  if (!isAssistant(message)) return message;
  let changed = false;
  const parts = message.parts.map((part) => {
    if (part.type !== "text" || !part.text.includes("<")) return part;
    const { body } = splitReplies(part.text, { streaming });
    if (body === part.text) return part;
    changed = true;
    return { ...part, text: body };
  });
  return changed ? { ...message, parts } : message;
}

/**
 * The transcript as a Work chat shows it, memoized per message object: a message that did not change keeps its
 * transformed object, so the transcript's memoized groups do not re-render while the newest one streams.
 */
export function createRepliesDisplay() {
  const cache = new WeakMap<UIMessage, { streaming: boolean; out: UIMessage }>();
  return (messages: UIMessage[], streaming: boolean): UIMessage[] => {
    const last = messages.length - 1;
    return messages.map((message, index) => {
      const live = streaming && index === last;
      const hit = cache.get(message);
      if (hit && hit.streaming === live) return hit.out;
      const out = hideRepliesBlock(message, live);
      cache.set(message, { streaming: live, out });
      return out;
    });
  };
}

/** The replies the newest answer ends with: its last text part, with no tool call after it. None while it streams. */
export function lastAnswerReplies(messages: UIMessage[]): string[] {
  const last = messages[messages.length - 1];
  if (!last || !isAssistant(last)) return [];
  const textAt = last.parts.findLastIndex((part) => part.type === "text" && part.text.trim().length > 0);
  if (textAt < 0) return [];
  if (last.parts.slice(textAt + 1).some((part) => part.type === "dynamic-tool" || part.type.startsWith("tool-"))) return [];
  const part = last.parts[textAt];
  return part?.type === "text" ? splitReplies(part.text).replies : [];
}
