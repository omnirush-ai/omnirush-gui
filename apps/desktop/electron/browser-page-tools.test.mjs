import assert from "node:assert/strict";
import test from "node:test";

import { browserShortcut, nextZoomFactor, pageMenuItems, ZOOM_FACTORS } from "./browser-page-tools.mjs";

const press = (key, extra = {}) => ({ type: "keyDown", key, code: `Key${key.toUpperCase()}`, ...extra });

test("browser shortcuts: Cmd on macOS, Ctrl elsewhere, never both or with Alt", () => {
  for (const [key, action] of [["l", "address"], ["t", "new-tab"], ["w", "close-tab"], ["r", "reload"], ["f", "find"], ["p", "print"]]) {
    assert.equal(browserShortcut(press(key, { meta: true }), "darwin"), action, `Cmd+${key}`);
    assert.equal(browserShortcut(press(key, { control: true }), "win32"), action, `Ctrl+${key}`);
    assert.equal(browserShortcut(press(key, { control: true }), "linux"), action);
    assert.equal(browserShortcut(press(key, { control: true }), "darwin"), null, "Ctrl on macOS stays the app's (thinking mode)");
    assert.equal(browserShortcut(press(key, { meta: true }), "win32"), null);
    assert.equal(browserShortcut(press(key, { meta: true, alt: true }), "darwin"), null);
    assert.equal(browserShortcut(press(key, { meta: true, control: true }), "darwin"), null);
    assert.equal(browserShortcut({ ...press(key, { meta: true }), type: "keyUp" }, "darwin"), null);
  }
  assert.equal(browserShortcut({ type: "keyDown", key: "[", code: "BracketLeft", meta: true }, "darwin"), "back");
  assert.equal(browserShortcut({ type: "keyDown", key: "]", code: "BracketRight", control: true }, "win32"), "forward");
  assert.equal(browserShortcut({ type: "keyDown", key: "=", code: "Equal", meta: true }, "darwin"), "zoom-in");
  assert.equal(browserShortcut({ type: "keyDown", key: "+", code: "Equal", meta: true, shift: true }, "darwin"), "zoom-in");
  assert.equal(browserShortcut({ type: "keyDown", key: "-", code: "Minus", control: true }, "linux"), "zoom-out");
  assert.equal(browserShortcut({ type: "keyDown", key: "0", code: "Digit0", control: true }, "win32"), "zoom-reset");
  assert.equal(browserShortcut(press("r", { meta: true, shift: true }), "darwin"), "reload");
  // Shift+T stays the app's previous tab, and other letters stay the page's.
  assert.equal(browserShortcut(press("t", { meta: true, shift: true }), "darwin"), null);
  assert.equal(browserShortcut(press("a", { meta: true }), "darwin"), null);
  assert.equal(browserShortcut(press("k", { control: true }), "win32"), null);
  assert.equal(browserShortcut(press("t"), "darwin"), null);
  // A layout that types no Latin letter there still has the key.
  assert.equal(browserShortcut({ type: "keyDown", key: "е", code: "KeyT", control: true }, "linux"), "new-tab");
  assert.equal(browserShortcut(null, "darwin"), null);
});

test("zoom steps like other browsers, from 50% to 300%", () => {
  assert.equal(nextZoomFactor(1, "in"), 1.1);
  assert.equal(nextZoomFactor(1.1, "in"), 1.25);
  assert.equal(nextZoomFactor(1, "out"), 0.9);
  assert.equal(nextZoomFactor(1.33, "out"), 1.25, "an odd zoom goes to the next step down");
  assert.equal(nextZoomFactor(3, "in"), 3);
  assert.equal(nextZoomFactor(0.5, "out"), 0.5);
  assert.equal(nextZoomFactor(2.5, "reset"), 1);
  assert.equal(nextZoomFactor(Number.NaN, "in"), 1.1);
  assert.deepEqual([ZOOM_FACTORS[0], ZOOM_FACTORS.at(-1)], [0.5, 3]);
});

const labels = (items) => items.map((item) => (item.type === "separator" ? "-" : item.label));

test("the page menu offers what was clicked: a link, an image, a text field, a selection, or the page", () => {
  assert.deepEqual(labels(pageMenuItems({ linkURL: "https://linear.app/acme/issue/OPS-482", pageURL: "https://linear.app/acme" })), [
    "Open link in new tab", "Open link in default browser", "Copy link address", "Download link",
  ]);
  const image = pageMenuItems({ mediaType: "image", srcURL: "https://cdn.example.com/chart.png", hasImageContents: true });
  assert.deepEqual(labels(image), ["Open image in new tab", "Copy image", "Copy image address", "Download image"]);
  assert.equal(image[0].value, "https://cdn.example.com/chart.png");
  assert.deepEqual(labels(pageMenuItems({ linkURL: "https://a.example/", mediaType: "image", srcURL: "https://a.example/i.png" })).filter((label) => label === "-").length, 1);
  assert.deepEqual(labels(pageMenuItems({ isEditable: true, misspelledWord: "pallett", dictionarySuggestions: ["pallet", "palette"], editFlags: { canUndo: false, canPaste: true } })), [
    "pallet", "palette", "-", "Add to dictionary", "-", "Undo", "Redo", "-", "Cut", "Copy", "Paste", "Select all",
  ]);
  assert.equal(pageMenuItems({ isEditable: true, editFlags: { canUndo: false } })[0].enabled, false);
  assert.deepEqual(labels(pageMenuItems({ selectionText: "  ETA Friday " })), ["Copy"]);
  assert.deepEqual(labels(pageMenuItems({ pageURL: "https://tms.example.com/s/4471" }, { canGoBack: true, find: true })), [
    "Back", "Forward", "Reload", "-", "Find in page", "Print", "Copy page address",
  ]);
  const page = pageMenuItems({ pageURL: "https://tms.example.com/s/4471" }, { canGoBack: true });
  assert.deepEqual(page.slice(0, 2).map((item) => item.enabled), [true, false]);
  assert.equal(labels(page).includes("Find in page"), false, "find needs the Work browser page");
  // Only web addresses: never javascript:, data: or file: links.
  for (const linkURL of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
    assert.equal(labels(pageMenuItems({ linkURL })).includes("Open link in new tab"), false);
  }
  assert.deepEqual(labels(pageMenuItems({ linkURL: "https://a.example/" }, { language: "zh" })).slice(0, 2), ["在新标签页中打开链接", "在默认浏览器中打开链接"]);
  assert.equal(labels(pageMenuItems({ pageURL: "https://a.example/" }, { language: "ja" }))[0], "Back", "other languages read English");
});
