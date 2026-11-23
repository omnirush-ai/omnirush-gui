/** @jsxImportSource react */
// The shared Work chip row (design 4): cap, roving focus, send and fill, the one-click guard, Esc back to the composer,
// Alt+N only from an empty focused composer, and action chips that run and never send.
import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined") {
  GlobalRegistrator.register({ url: "http://localhost/" });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const { SuggestionChipRow, chipShortcutLabel } = await import("../src/react-app/domains/work/ask/suggestion-chips");
type SuggestionChip = import("../src/react-app/domains/work/ask/suggestion-chips").SuggestionChip;

const mounted: { root: Root; container: HTMLElement }[] = [];

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  document.body.innerHTML = "";
});

const replies = (...labels: string[]): SuggestionChip[] => labels.map((label, index) => ({ id: `r${index}`, label }));

async function mount(chips: SuggestionChip[], extra: { busy?: boolean; shortcuts?: boolean; max?: number } = {}) {
  const sent: string[] = [];
  const filled: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const render = async (next: SuggestionChip[], more: typeof extra = extra) => act(async () => root.render(
    <SuggestionChipRow chips={next} label="Suggested replies" onSend={(text) => sent.push(text)} onFill={(text) => filled.push(text)} testId="row" {...more} />,
  ));
  await render(chips);
  const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>("[data-suggestion-chip]"));
  return { container, sent, filled, buttons, render };
}

async function key(target: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}
async function click(target: Element, init: MouseEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
}

test("a toolbar of at most four chips (or max), labels clipped to 40 characters", async () => {
  const long = "Book the Tuesday afternoon slot with Dana and Marco please";
  const { container, buttons } = await mount(replies("One", "Two", "Three", "Four", "Five", long));
  const bar = container.querySelector("[role=toolbar]");
  expect(bar?.getAttribute("aria-label")).toBe("Suggested replies");
  expect(buttons().map((button) => button.textContent)).toEqual(["One", "Two", "Three", "Four"]);
  const { buttons: two } = await mount(replies(long, "B"), { max: 1 });
  expect(two()).toHaveLength(1);
  expect(Array.from(two()[0]!.textContent ?? "").length).toBeLessThanOrEqual(41);
  expect(two()[0]!.getAttribute("aria-label")).toBe(long);
});

test("roving focus: one tab stop, arrows, Home and End move between chips", async () => {
  const { buttons } = await mount(replies("A", "B", "C"));
  expect(buttons().map((button) => button.tabIndex)).toEqual([0, -1, -1]);
  buttons()[0]!.focus();
  await key(buttons()[0]!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(buttons()[1]!);
  expect(buttons().map((button) => button.tabIndex)).toEqual([-1, 0, -1]);
  await key(buttons()[1]!, { key: "End" });
  expect(document.activeElement).toBe(buttons()[2]!);
  await key(buttons()[2]!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(buttons()[2]!);
  await key(buttons()[2]!, { key: "Home" });
  expect(document.activeElement).toBe(buttons()[0]!);
  await key(buttons()[0]!, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(buttons()[0]!);
});

test("Enter or Space sends; Alt+Enter, the pencil and Shift+click fill the composer", async () => {
  const chips: SuggestionChip[] = [{ id: "a", label: "Send it" }, { id: "b", label: "Shorter", text: "Make it shorter" }];
  const { buttons, sent, filled, container } = await mount(chips);
  await key(buttons()[1]!, { key: "Enter", altKey: true });
  await click(container.querySelector("[data-suggestion-edit=a]")!);
  await click(buttons()[0]!, { shiftKey: true });
  expect(filled).toEqual(["Make it shorter", "Send it", "Send it"]);
  expect(sent).toEqual([]);
  await key(buttons()[1]!, { key: "Enter" });
  expect(sent).toEqual(["Make it shorter"]);
});

test("one click sends once until the row shows other chips; busy blocks sending", async () => {
  const { buttons, sent, render } = await mount(replies("Send it", "Make it shorter"));
  await click(buttons()[0]!);
  await click(buttons()[0]!);
  await key(buttons()[1]!, { key: " " });
  expect(sent).toEqual(["Send it"]);
  expect(buttons()[1]!.getAttribute("aria-disabled")).toBe("true");
  await render(replies("Book Tue 3 pm"));
  await click(buttons()[0]!);
  expect(sent).toEqual(["Send it", "Book Tue 3 pm"]);
  await render(replies("Other"), { busy: true });
  await click(buttons()[0]!);
  expect(sent).toEqual(["Send it", "Book Tue 3 pm"]);
});

test("Esc goes back to the composer", async () => {
  const { buttons } = await mount(replies("A"));
  let focused = 0;
  const onFocus = () => { focused += 1; };
  window.addEventListener("omnirush:focusPrompt", onFocus);
  await key(buttons()[0]!, { key: "Escape" });
  window.removeEventListener("omnirush:focusPrompt", onFocus);
  expect(focused).toBe(1);
});

function composer(text = "") {
  const panel = document.createElement("div");
  panel.setAttribute("data-composer-panel", "");
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.tabIndex = 0;
  editor.textContent = text;
  panel.append(editor);
  document.body.append(panel);
  // happy-dom does not derive isContentEditable from the attribute.
  Object.defineProperty(editor, "isContentEditable", { configurable: true, value: true });
  editor.focus();
  return editor;
}

test("Alt+N picks a chip only from an empty, focused composer and only when shortcuts are on", async () => {
  const { sent, buttons, render } = await mount(replies("First", "Second"), { shortcuts: true });
  expect(buttons()[1]!.getAttribute("aria-keyshortcuts")).toBe("Alt+2");
  const editor = composer();
  await key(editor, { key: "¡", code: "Digit2", altKey: true });
  expect(sent).toEqual(["Second"]);
  await render(replies("Third", "Fourth"), { shortcuts: true });
  editor.textContent = "typing";
  await key(editor, { key: "1", code: "Digit1", altKey: true });
  expect(sent).toEqual(["Second"]);
  editor.textContent = "";
  await key(editor, { key: "1", code: "Digit1", altKey: true, ctrlKey: true });
  await key(editor, { key: "9", code: "Digit9", altKey: true });
  expect(sent).toEqual(["Second"]);
  document.body.focus();
  (document.activeElement as HTMLElement | null)?.blur?.();
  await key(document.body, { key: "1", code: "Digit1", altKey: true });
  expect(sent).toEqual(["Second"]);
  await render(replies("Fifth"), { shortcuts: false });
  editor.focus();
  await key(editor, { key: "1", code: "Digit1", altKey: true });
  expect(sent).toEqual(["Second"]);
  expect(buttons()[0]!.hasAttribute("aria-keyshortcuts")).toBe(false);
  expect(chipShortcutLabel(0, true)).toBe("⌥1");
  expect(chipShortcutLabel(2, false)).toBe("Alt+3");
});

test("action chips run their action, never send or fill, and wait while it runs; a disabled chip does nothing", async () => {
  let runs = 0;
  let release: () => void = () => {};
  const chips: SuggestionChip[] = [
    { id: "install", label: "Install on acme", tone: "action", external: true, onRun: () => new Promise<void>((resolve) => { runs += 1; release = resolve; }) },
    { id: "retry", label: "Try again", disabledReason: "Wait 30 s" },
  ];
  const { buttons, sent, filled, container } = await mount(chips);
  expect(container.querySelector("[data-suggestion-edit=install]")).toBeNull();
  await click(buttons()[0]!);
  await click(buttons()[0]!);
  await key(buttons()[0]!, { key: "Enter", altKey: true });
  expect(runs).toBe(1);
  await act(async () => { release(); });
  await click(buttons()[0]!);
  expect(runs).toBe(2);
  await click(buttons()[1]!);
  await key(buttons()[1]!, { key: "Enter" });
  expect(buttons()[1]!.getAttribute("aria-disabled")).toBe("true");
  expect(sent).toEqual([]);
  expect(filled).toEqual([]);
});

test("no chips, no row", async () => {
  const { container } = await mount([]);
  expect(container.querySelector("[role=toolbar]")).toBeNull();
});
