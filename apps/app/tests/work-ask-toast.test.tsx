/** @jsxImportSource react */
// Ask toasts never stack up: a run of Shift+click adds updates one line in place with a count, a refused add takes
// its place, and each kind has one fixed id.
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const registered = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });

const { toast: sonner } = await import("sonner");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ASK_ADDED_TOAST_ID, ASK_CLAUDE_TOAST_ID, ASK_FULL_TOAST_ID, askAddedTitle, showAskAdded, showAskClaudeHome, showAskFull } = await import("../src/react-app/domains/work/ask/ask-toast");

type Shown = { id: string | number; jsx?: unknown; onDismiss?: (toast: unknown) => void; onAutoClose?: (toast: unknown) => void };
const ASK_IDS = new Set<string | number>([ASK_ADDED_TOAST_ID, ASK_FULL_TOAST_ID, ASK_CLAUDE_TOAST_ID]);
const askToasts = () => (sonner.getToasts() as Shown[]).filter((item) => ASK_IDS.has(item.id));
const text = (item: Shown) => renderToStaticMarkup(item.jsx as never).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** What the toaster does when a toast goes (closed, chosen or timed out). */
const close = (id: string, how: "onDismiss" | "onAutoClose" = "onDismiss") => {
  const item = (sonner.getHistory() as Shown[]).find((entry) => entry.id === id);
  item?.[how]?.(item);
  sonner.dismiss(id);
};

describe("Ask toasts", () => {
  test("5 quick adds and 2 refused adds leave one Ask line", () => {
    const open = () => {};
    for (let i = 0; i < 5; i += 1) showAskAdded("home", open);
    let shown = askToasts();
    expect(shown.map((item) => item.id)).toEqual([ASK_ADDED_TOAST_ID]);
    expect(text(shown[0]!)).toContain("Added 5 items to your question");
    expect(text(shown[0]!)).toContain("Open");
    showAskFull(open);
    showAskFull(open);
    shown = askToasts();
    expect(shown.map((item) => item.id)).toEqual([ASK_FULL_TOAST_ID]);
    expect(text(shown[0]!)).toContain("You can attach up to 5 items");
    expect(text(shown[0]!)).toContain("Open");
    close(ASK_FULL_TOAST_ID);
    expect(askToasts()).toEqual([]);
  });

  test("the count starts again once the line has gone or the adds go to another composer", () => {
    const open = () => {};
    showAskAdded("home", open);
    expect(text(askToasts()[0]!)).toContain("Added to your question");
    showAskAdded("home", open);
    expect(text(askToasts()[0]!)).toContain("Added 2 items to your question");
    close(ASK_ADDED_TOAST_ID, "onAutoClose");
    showAskAdded("home", open);
    expect(askToasts().length).toBe(1);
    expect(text(askToasts()[0]!)).toContain("Added to your question");
    showAskAdded("ses_1", open);
    expect(askToasts().length).toBe(1);
    expect(text(askToasts()[0]!)).toContain("Added to your question");
    close(ASK_ADDED_TOAST_ID);
  });

  test("the Claude note has its own fixed id, so repeats do not stack", () => {
    showAskClaudeHome();
    showAskClaudeHome();
    expect(askToasts().map((item) => item.id)).toEqual([ASK_CLAUDE_TOAST_ID]);
    sonner.dismiss(ASK_CLAUDE_TOAST_ID);
    expect(askAddedTitle(1)).toBe("Added to your question");
    expect(askAddedTitle(3)).toBe("Added 3 items to your question");
  });
});
