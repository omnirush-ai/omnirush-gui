// "Ask" anywhere in Work (design 2.1): the item goes to a composer as a reference chip and nothing is sent. The page
// asking does not know where the composer is; the session route listens and picks it with `askTarget`.
import { ASK_WORK_RECORD_EVENT } from "../viewer/records";
import type { WorkRef } from "./refs";

export type AskOptions = {
  /** Shift+click or Shift+A: add the chip and stay on this page. */
  stay?: boolean;
};
export type AskRequest = AskOptions & { ref: WorkRef };

export function requestAsk(ref: WorkRef, options: AskOptions = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AskRequest>(ASK_WORK_RECORD_EVENT, { detail: { ref, stay: Boolean(options.stay) } }));
}

/** An Ask added a chip to this chat's composer: a narrow window that shows the chat and the viewer as tabs brings the
 *  Chat tab forward (session-page listens). */
export const WORK_ASK_SHOW_CHAT_EVENT = "omnirush-work-ask-show-chat";

export function showAskChat(sessionId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<{ sessionId: string }>(WORK_ASK_SHOW_CHAT_EVENT, { detail: { sessionId } }));
}

export function onAskRequest(handler: (request: AskRequest) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== "object" || !("ref" in detail)) return;
    const request = detail as AskRequest;
    if (request.ref && typeof request.ref.title === "string") handler(request);
  };
  window.addEventListener(ASK_WORK_RECORD_EVENT, listener);
  return () => window.removeEventListener(ASK_WORK_RECORD_EVENT, listener);
}

/** Where an Ask's chip goes. */
export type AskTarget =
  | { kind: "chat"; sessionId: string }
  /** The Work home composer; `navigate` when the user is on another page (a history push, so Back returns). */
  | { kind: "home"; navigate: boolean; reason?: "claude" }
  /** No Work workspace yet. */
  | { kind: "none" };

export function askTarget(input: {
  /** The Work chat on screen (a Work workspace session, not a Work page). */
  workChatSessionId: string | null;
  /** That chat runs on a Claude model: it has no Work tools, so it cannot read the item. */
  claudeChat?: boolean;
  /** "home" on Work home (Today included), "page" on any other Work page, null elsewhere. */
  workRoute: "home" | "page" | null;
  hasWorkHome: boolean;
}): AskTarget {
  if (input.workChatSessionId && !input.claudeChat) return { kind: "chat", sessionId: input.workChatSessionId };
  if (!input.hasWorkHome) return { kind: "none" };
  if (input.workChatSessionId && input.claudeChat) return { kind: "home", navigate: true, reason: "claude" };
  return { kind: "home", navigate: input.workRoute !== "home" };
}
