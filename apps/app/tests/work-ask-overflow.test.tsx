/** @jsxImportSource react */
// Work chip rows stay on one line (Sam's enterprise follow-up, round 2 UI 1-4): attached chips and sent chips collapse
// into "+N" with a list of the rest, suggestion rows put what does not fit into a More menu that the row's keyboard
// reaches, action chips stay first, and every new chip is 13 px.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const registered = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const { fitCount } = await import("../src/react-app/domains/work/ask/fit-row");
const { WorkRefChips, WorkRefMessageChips } = await import("../src/react-app/domains/work/ask/ref-chip");
const { SuggestionChipRow } = await import("../src/react-app/domains/work/ask/suggestion-chips");
const { refPlaceholder } = await import("../src/react-app/domains/work/ask/refs");
type WorkRef = import("../src/react-app/domains/work/ask/refs").WorkRef;
type SuggestionChip = import("../src/react-app/domains/work/ask/suggestion-chips").SuggestionChip;

// A layout for happy-dom: every element is 8 px per character plus 40 px wide, a row (an element with a test id) has
// `room` px.
let room = 0;
const rect = HTMLElement.prototype.getBoundingClientRect;
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const width = (this.textContent ?? "").length * 8 + 40;
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 28, width, height: 28, toJSON: () => ({}) } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.hasAttribute("data-testid") ? room : 0; } });
});
afterAll(async () => {
  HTMLElement.prototype.getBoundingClientRect = rect;
  if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
  if (registered) await GlobalRegistrator.unregister();
});

const mounted: { root: Root; container: HTMLElement }[] = [];
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  document.body.innerHTML = "";
  room = 0;
});
async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(node));
  return { container, rerender: (next: React.ReactNode) => act(async () => root.render(next)) };
}
async function click(target: Element, init: MouseEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
}
async function key(target: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}
// A menu trigger opens on press (pointer down) or on click, depending on the primitive.
async function openMenu(trigger: HTMLElement) {
  await click(trigger);
  await settle();
  if (document.querySelector("[data-suggestion-menu-item]")) return;
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  });
  await settle();
  if (document.querySelector("[data-suggestion-menu-item]")) return;
  trigger.focus();
  await key(trigger, { key: "ArrowDown" });
  await settle();
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

const LONG: WorkRef[] = [
  { kind: "email", source: "google", sourceId: "gmail:1", title: "Cold chain lanes for Q1: updated rate card, reefer surcharge and new payment terms" },
  { kind: "issue", source: "github", sourceId: "github:o/r#1", title: "Route optimiser ignores reefers when the depot is over capacity" },
  { kind: "deal", source: "hubspot", sourceId: "hubspot:deal:301", title: "ColdChain Q1 lanes renewal with the expanded Rotterdam capacity" },
  { kind: "ticket", source: "hubspot", sourceId: "hubspot:ticket:401", title: "Late delivery claim for order 5521 with two damaged pallets" },
  { kind: "project", entityId: "7f3c2a", source: "github", title: "December lane review with Coldchain operations and finance" },
];
const key_ = (ref: WorkRef) => ref.sourceId ?? `e:${ref.entityId}`;

describe("fitCount", () => {
  test("all when they fit, else as many as fit beside the trailing button, never fewer than pinned or one", () => {
    expect(fitCount({ widths: [100, 100, 100], available: 320, more: 60 })).toBe(3);
    expect(fitCount({ widths: [100, 100, 100], available: 300, more: 60 })).toBe(2);
    expect(fitCount({ widths: [100, 100, 100], available: 120, more: 60 })).toBe(1);
    expect(fitCount({ widths: [100, 100, 100], available: 40, more: 60 })).toBe(1);
    expect(fitCount({ widths: [100, 100, 100], available: 40, more: 60, pinned: 2 })).toBe(2);
    expect(fitCount({ widths: [100, 100, 100], available: 1000, more: 60, max: 2 })).toBe(2);
    expect(fitCount({ widths: [], available: 1000, more: 60 })).toBe(0);
  });
  test("an unmeasured row shows everything up to max", () => {
    expect(fitCount({ widths: [0, 0, 0], available: 0, more: 0 })).toBe(3);
    expect(fitCount({ widths: [0, 0, 0], available: 0, more: 0, max: 2 })).toBe(2);
  });
});

describe("attached chips", () => {
  test("five long chips: one line, the rest behind +N whose list removes each one by keyboard", async () => {
    room = 900;
    let refs = [...LONG];
    const removed: string[] = [];
    const view = () => <WorkRefChips owner="o" refs={refs} onRemove={(k) => { removed.push(k); refs = refs.filter((ref) => key_(ref) !== k); }} />;
    const { container, rerender } = await render(view());
    const row = container.querySelector("[data-testid='work-ref-chips']")!;
    const visible = row.querySelectorAll("[role=list] [data-ref-chip]");
    const more = row.querySelector<HTMLButtonElement>("[data-ref-more]")!;
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(5);
    expect(Number(more.getAttribute("data-ref-more"))).toBe(5 - visible.length);
    expect(more.textContent).toBe(`+${5 - visible.length}`);
    expect(more.getAttribute("aria-label")).toBe(`+${5 - visible.length} more attached items`);
    // Every chip keeps one line with an ellipsis and its full title on hover; 13 px text.
    for (const chip of Array.from(visible)) {
      expect(chip.className).toContain("text-[13px]");
      expect(chip.querySelector(".truncate")).not.toBeNull();
      expect(chip.getAttribute("title")).toContain(chip.querySelector(".truncate")!.textContent!);
    }
    expect(more.className).toContain("text-[13px]");
    expect(row.className).toContain("flex-nowrap");
    // The list of the rest: one remove button per hidden chip, focusable.
    await click(more);
    await settle();
    const list = document.querySelector("[data-testid='work-ref-chips-more-list']")!;
    expect(list).not.toBeNull();
    const removes = Array.from(list.querySelectorAll<HTMLButtonElement>("[data-ref-remove]"));
    expect(removes.length).toBe(5 - visible.length);
    expect(removes.every((button) => button.tabIndex >= 0 && button.getAttribute("aria-label")?.startsWith("Remove "))).toBe(true);
    const last = LONG[4]!;
    await click(list.querySelector(`[data-ref-remove='${key_(last)}']`)!);
    await rerender(view());
    expect(removed).toEqual([key_(last)]);
    // The hidden chips (but no chip twice, no probe copy) are never in the visible list.
    expect(container.querySelectorAll("[data-testid='work-ref-chips'] [data-ref-chip]").length).toBe(visible.length);
  });

  test("everything fits: no +N", async () => {
    room = 4000;
    const { container } = await render(<WorkRefChips owner="o" refs={LONG.slice(0, 2)} onRemove={() => {}} />);
    expect(container.querySelectorAll("[data-ref-chip]").length).toBe(2);
    expect(container.querySelector("[data-ref-more]")).toBeNull();
  });

  test("the sent message: one right-aligned line, +N lists the rest and each opens its item", async () => {
    room = 600;
    const opened: string[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent<{ sourceId: string }>).detail.sourceId);
    window.addEventListener("omnirush-open-work-record", listener);
    const { container } = await render(<WorkRefMessageChips refs={LONG} />);
    const row = container.querySelector("[data-testid='work-ref-message-chips']")!;
    expect(row.className).toContain("flex-nowrap");
    expect(row.className).toContain("justify-end");
    const shown = row.querySelectorAll("[data-ref-chip]").length;
    expect(shown).toBeLessThan(5);
    await click(row.querySelector("[data-ref-more]")!);
    await settle();
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-testid='work-ref-message-chips-more-list'] button"));
    expect(items.length).toBe(5 - shown);
    await click(items[0]!);
    window.removeEventListener("omnirush-open-work-record", listener);
    expect(opened[0]).toBe(LONG[shown]!.sourceId!);
  });

  test("the placeholder clips a long title so it stays on one line", () => {
    const text = refPlaceholder([LONG[0]!]);
    expect(text.startsWith("Ask about Cold chain lanes for Q1")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(70);
  });
});

describe("suggestion rows", () => {
  const replies = (...labels: string[]): SuggestionChip[] => labels.map((label, index) => ({ id: `r${index}`, label }));
  async function mountRow(chips: SuggestionChip[], extra: { max?: number } = {}) {
    const sent: string[] = [];
    const filled: string[] = [];
    const { container } = await render(<SuggestionChipRow chips={chips} label="Suggested replies" onSend={(text) => sent.push(text)} onFill={(text) => filled.push(text)} testId="row" {...extra} />);
    const inline = () => Array.from(container.querySelectorAll<HTMLButtonElement>("[data-suggestion-chip]"));
    const more = () => container.querySelector<HTMLButtonElement>("[data-suggestion-more]");
    return { container, sent, filled, inline, more };
  }

  test("a fix chip and three long replies: one row, the fix first, the rest in More", async () => {
    room = 500;
    const chips: SuggestionChip[] = [
      { id: "fix", label: "Reconnect Google", tone: "action", onRun: () => {} },
      ...replies("Book Rotterdam 4 for Tuesday at 10 am", "Ask Maria to confirm the pallet count", "Draft the week 49 note for the carrier"),
    ];
    const { container, inline, more } = await mountRow(chips);
    expect(container.querySelector("[role=toolbar]")!.className).toContain("flex-nowrap");
    expect(inline()[0]!.getAttribute("data-tone")).toBe("action");
    expect(inline().length).toBeLessThan(4);
    expect(Number(more()!.getAttribute("data-suggestion-more"))).toBe(4 - inline().length);
    expect(more()!.textContent).toContain("More");
    for (const button of [...inline(), more()!]) expect(button.className).toMatch(/text-\[13px\]/);
  });

  test("action chips always show, even past max and room", async () => {
    room = 100;
    const chips: SuggestionChip[] = [
      { id: "a", label: "Install on acme", tone: "action", onRun: () => {} },
      { id: "b", label: "Reconnect Slack", tone: "action", onRun: () => {} },
      ...replies("Keep it as a draft"),
    ];
    const { inline, more } = await mountRow(chips, { max: 1 });
    expect(inline().map((button) => button.getAttribute("data-suggestion-chip"))).toEqual(["a", "b"]);
    expect(more()!.getAttribute("data-suggestion-more")).toBe("1");
  });

  test("More is part of the row's roving focus and its items send, fill (Shift+click, Alt+Enter) like chips", async () => {
    room = 0;
    const { inline, more, sent, filled } = await mountRow(replies("One", "Two", "Three", "Four", "Five", "Six"));
    expect(inline().map((button) => button.textContent)).toEqual(["One", "Two", "Three", "Four"]);
    expect(more()!.tabIndex).toBe(-1);
    inline()[3]!.focus();
    await key(inline()[3]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(more());
    expect(more()!.tabIndex).toBe(0);
    await key(more()!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(inline()[3]!);
    await key(inline()[3]!, { key: "End" });
    expect(document.activeElement).toBe(more());
    await openMenu(more()!);
    const items = () => Array.from(document.querySelectorAll<HTMLElement>("[data-suggestion-menu-item]"));
    expect(items().map((item) => item.textContent)).toEqual(["Five", "Six"]);
    await click(items()[1]!, { shiftKey: true });
    expect(filled).toEqual(["Six"]);
    if (!items().length) await openMenu(more()!);
    await key(items()[0]!, { key: "Enter", altKey: true });
    expect(filled).toEqual(["Six", "Five"]);
    if (!items().length) await openMenu(more()!);
    await click(items()[0]!);
    expect(sent).toEqual(["Five"]);
  });

  test("nothing past max is dropped: it is in More", async () => {
    room = 0;
    const { inline, more } = await mountRow(replies("A", "B", "C"), { max: 1 });
    expect(inline()).toHaveLength(1);
    expect(more()!.getAttribute("data-suggestion-more")).toBe("2");
  });
});
