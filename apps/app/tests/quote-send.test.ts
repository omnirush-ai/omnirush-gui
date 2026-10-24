import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const registered = !globalThis.document;
if (registered) GlobalRegistrator.register();

const { clipGraphemes, quoteIntoComposer, quoteLabel, quoteText } = await import("../src/components/chat/quote");
const { selectionInMessage, transcriptSelection } = await import("../src/components/chat/selection-quote");
const { useComposerStateStore, persistableComposerDraftText } = await import("../src/react-app/domains/session/surface/composer-state-store");
const { resolvePastedTextPlaceholders, unresolvedPasteLabels } = await import("../src/react-app/domains/session/surface/composer/pasted-text");
const { draftToParts } = await import("../src/react-app/domains/session/sync/draft-parts");

const SESSION = "ses-quote";
const composer = () => useComposerStateStore.getState().sessions[SESSION];

/** What the session surface's buildDraft sends: one paste part per placeholder, its text resolved. */
function draftOf(text: string) {
  const pasteParts = composer()?.pasteParts ?? [];
  const parts = [...text.matchAll(/\[pasted text ([^\]]+)\]/g)].map((match) => {
    const part = pasteParts.find((item) => item.label === match[1]);
    if (!part) throw new Error(`unresolved ${match[1]}`);
    return { type: "paste" as const, id: part.id, label: part.label, text: part.text, lines: part.lines };
  });
  return { mode: "prompt" as const, parts, attachments: [], text, resolvedText: resolvePastedTextPlaceholders(text, pasteParts) };
}

beforeAll(() => { useComposerStateStore.getState().clearSession?.(SESSION); });
afterAll(async () => {
  useComposerStateStore.getState().clearSession?.(SESSION);
  // Other test files register the DOM themselves.
  if (registered) await GlobalRegistrator.unregister();
});

describe("quotes in the composer", () => {
  test("two quotes with the same first words stay two chips and both reach the model", async () => {
    const prefix = "The parser keeps the old token table when the grammar changes, ";
    quoteIntoComposer(SESSION, `${prefix}first`);
    quoteIntoComposer(SESSION, `${prefix}second`);
    quoteIntoComposer(SESSION, `${prefix}first`); // the same quote again
    const labels = (composer()?.pasteParts ?? []).map((part) => part.label);
    expect(new Set(labels).size).toBe(3);
    const draft = draftOf(composer()?.draft ?? "");
    expect(draft.resolvedText).toBe([quoteText(`${prefix}first`), quoteText(`${prefix}second`), quoteText(`${prefix}first`)].join("\n"));
    // With an attachment token the parts are built token by token (draft-parts.ts): each chip by its own label.
    const withToken = { ...draft, text: `${draft.text} [attachment a1]` };
    const parts = await draftToParts(withToken, "/w", SESSION, null);
    const texts = parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
    expect(texts.filter((text) => text.startsWith(">"))).toEqual([quoteText(`${prefix}first`), quoteText(`${prefix}second`), quoteText(`${prefix}first`)]);
  });

  test("a reload keeps the quote's words, never the placeholder", () => {
    const text = composer()?.draft ?? "";
    const saved = persistableComposerDraftText(text, composer()?.pasteParts ?? []);
    expect(saved).not.toContain("[pasted text");
    expect(saved).toContain("> The parser keeps the old token table");
    // After the reload the parts are gone: the saved words need none, a bare placeholder is refused at send.
    expect(unresolvedPasteLabels(saved, [])).toEqual([]);
    expect(unresolvedPasteLabels("see [pasted text Quote: lost words]", [])).toEqual(["Quote: lost words"]);
  });

  test("the label never cuts an emoji or accented letter in half", () => {
    const text = `${"a".repeat(47)}👩‍👩‍👧 tail`;
    expect(clipGraphemes(text, 48)).toBe(`${"a".repeat(47)}👩‍👩‍👧…`);
    expect(quoteLabel(`${"é".repeat(60)}`)).toBe(`Quote: ${"é".repeat(48)}…`);
    expect(quoteLabel("😀".repeat(49))).toBe(`Quote: ${"😀".repeat(48)}…`);
  });
});

describe("selection quotes belong to their chat and message", () => {
  const mount = (html: string) => { document.body.innerHTML = html; return document.body.firstElementChild as HTMLElement; };
  const select = (node: Node, start: number, endNode: Node, end: number) => {
    const range = document.createRange();
    range.setStart(node, start); range.setEnd(endNode, end);
    const selection = window.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
    return selection;
  };

  test("a selection in another chat's transcript is not this chat's quote", () => {
    const chatA = mount(`<div id="a"><div data-message-id="m1"><p>alpha text</p></div></div><div id="b"><div data-message-id="m9"><p>bravo</p></div></div>`);
    const chatB = document.getElementById("b") as HTMLElement;
    const textA = chatA.querySelector("p")?.firstChild as Node;
    const selection = select(textA, 0, textA, 5);
    expect(transcriptSelection(selection, chatA)?.text).toBe("alpha");
    expect(transcriptSelection(selection, chatB)).toBeNull();
  });

  test("the context menu quotes only a selection inside the clicked message", () => {
    mount(`<div><div data-message-id="m1"><p>first message</p></div><div data-message-id="m2"><p>second message</p></div></div>`);
    const [p1, p2] = Array.from(document.querySelectorAll("p")).map((p) => p.firstChild as Node);
    const inside = select(p1 as Node, 0, p1 as Node, 5);
    expect(selectionInMessage(inside, "m1")).toBe("first");
    expect(selectionInMessage(inside, "m2")).toBeNull();
    const across = select(p1 as Node, 0, p2 as Node, 6);
    expect(selectionInMessage(across, "m1")).toBeNull();
  });
});
