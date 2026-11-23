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
    for (let attached = 1; attached <= 5; attached += 1) showAskAdded(attached, open);
    let shown = askToasts();
    expect(shown.map((item) => item.id)).toEqual([ASK_ADDED_TOAST_ID]);
    expect(text(shown[0]!)).toContain("5 items in your question");
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

  test("the line says how many items the question holds; a new add after the full line replaces it", () => {
    const open = () => {};
    showAskAdded(1, open);
    expect(text(askToasts()[0]!)).toContain("Added to your question");
    showAskAdded(3, open);
    expect(askToasts().length).toBe(1);
    expect(text(askToasts()[0]!)).toContain("3 items in your question");
    close(ASK_ADDED_TOAST_ID, "onAutoClose");
    showAskFull(open);
    showAskAdded(4, open);
    expect(askToasts().map((item) => item.id)).toEqual([ASK_ADDED_TOAST_ID]);
    close(ASK_ADDED_TOAST_ID);
  });

  test("the Claude note has its own fixed id, so repeats do not stack; the added copy stays short", () => {
    showAskClaudeHome();
    showAskClaudeHome();
    expect(askToasts().map((item) => item.id)).toEqual([ASK_CLAUDE_TOAST_ID]);
    sonner.dismiss(ASK_CLAUDE_TOAST_ID);
    expect(askAddedTitle(1)).toBe("Added to your question");
    expect(askAddedTitle(3)).toBe("3 items in your question");
    // Whole beside Open at the toast's width (the 30-character "Added 2 items to your question" was clipped).
    for (let attached = 1; attached <= 5; attached += 1) expect(askAddedTitle(attached).length).toBeLessThanOrEqual(24);
  });
});
