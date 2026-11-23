// The Work browser's basics on the person's own tabs (the tabs no conversation owns): the keyboard shortcuts that act
// while the Work browser has focus, the zoom steps, and the page's right-click menu. Nothing here reads page text or
// leaves this computer; the menu only acts on what the person right-clicked.

/** Zoom steps, as in other browsers. Chromium keeps the chosen zoom per site in the browser's own profile. */
export const ZOOM_FACTORS = Object.freeze([0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]);

/** The zoom after `action` ("in", "out" or "reset") from `current`. */
export function nextZoomFactor(current, action) {
  if (action === "reset") return 1;
  const value = typeof current === "number" && Number.isFinite(current) && current > 0 ? current : 1;
  if (action === "in") return ZOOM_FACTORS.find((step) => step > value + 0.001) ?? ZOOM_FACTORS[ZOOM_FACTORS.length - 1];
  if (action === "out") return [...ZOOM_FACTORS].reverse().find((step) => step < value - 0.001) ?? ZOOM_FACTORS[0];
  return value;
}

/** Actions that take the keyboard back to the app (the address field, the find bar). */
export const APP_FOCUS_ACTIONS = new Set(["address", "find"]);
/** Actions a held key may repeat. */
export const REPEATING_ACTIONS = new Set(["back", "forward", "zoom-in", "zoom-out"]);

const LETTER_ACTIONS = { l: "address", t: "new-tab", w: "close-tab", r: "reload", f: "find", p: "print" };
const CODE_LETTERS = { KeyL: "l", KeyT: "t", KeyW: "w", KeyR: "r", KeyF: "f", KeyP: "p", KeyB: "b" };

/**
 * The browser action a key press asks for while the Work browser has focus, or null, so every other key works as it
 * does anywhere in the app. Cmd on macOS, Ctrl elsewhere (never both, never with Alt): L address, T new tab, W close
 * tab, R reload (Shift too), F find in page, P print, [ back, ] forward, and = + - 0 zoom. Shift+B is the app's "open
 * the Work browser", so it also works while the keyboard is on a page beside Work.
 * @param {{ type?: string, key?: string, code?: string, control?: boolean, meta?: boolean, shift?: boolean, alt?: boolean }} input
 *   Electron's `before-input-event` input.
 * @param {string} [platform]
 * @returns {string | null}
 */
export function browserShortcut(input, platform = process.platform) {
  if (!input || input.type !== "keyDown") return null;
  const mac = platform === "darwin";
  const mod = mac ? input.meta === true && input.control !== true : input.control === true && input.meta !== true;
  if (!mod || input.alt === true) return null;
  const key = String(input.key ?? "").toLowerCase();
  const code = String(input.code ?? "");
  // A letter by what the layout types, or by its key when the layout types no Latin letter there.
  const letter = /^[a-z]$/.test(key) ? key : CODE_LETTERS[code] ?? null;
  if (input.shift === true) {
    if (letter === "r") return "reload";
    if (letter === "b") return "open-browser";
    if (key === "+" || code === "Equal" || code === "NumpadAdd") return "zoom-in";
    return null;
  }
  if (letter && LETTER_ACTIONS[letter]) return LETTER_ACTIONS[letter];
  if (key === "[" || code === "BracketLeft") return "back";
  if (key === "]" || code === "BracketRight") return "forward";
  if (key === "=" || key === "+" || code === "NumpadAdd") return "zoom-in";
  if (key === "-" || code === "Minus" || code === "NumpadSubtract") return "zoom-out";
  if (key === "0" || code === "Digit0" || code === "Numpad0") return "zoom-reset";
  return null;
}

const COPY = {
  en: {
    openLinkTab: "Open link in new tab", openLinkDefault: "Open link in default browser", copyLink: "Copy link address", downloadLink: "Download link",
    openImageTab: "Open image in new tab", copyImage: "Copy image", copyImageAddress: "Copy image address", downloadImage: "Download image",
    undo: "Undo", redo: "Redo", cut: "Cut", copy: "Copy", paste: "Paste", selectAll: "Select all", addWord: "Add to dictionary",
    back: "Back", forward: "Forward", reload: "Reload", find: "Find in page", print: "Print", copyPage: "Copy page address",
  },
  zh: {
    openLinkTab: "在新标签页中打开链接", openLinkDefault: "在默认浏览器中打开链接", copyLink: "复制链接地址", downloadLink: "下载链接",
    openImageTab: "在新标签页中打开图片", copyImage: "复制图片", copyImageAddress: "复制图片地址", downloadImage: "下载图片",
    undo: "撤销", redo: "重做", cut: "剪切", copy: "复制", paste: "粘贴", selectAll: "全选", addWord: "添加到词典",
    back: "后退", forward: "前进", reload: "重新加载", find: "在页面中查找", print: "打印", copyPage: "复制页面地址",
  },
};

const isWebUrl = (value) => typeof value === "string" && /^https?:\/\/\S+$/i.test(value) && value.length <= 32_768;

/**
 * The right-click menu for what was clicked: a link, an image, a text field, selected text, or the page. Items are
 * `{ id, label, enabled?, value? }` or `{ type: "separator" }`; the caller runs `id`. `find` is offered only when the
 * Work browser page is open (its find bar lives there).
 * @param {{ linkURL?: string, srcURL?: string, mediaType?: string, hasImageContents?: boolean, isEditable?: boolean,
 *   selectionText?: string, misspelledWord?: string, dictionarySuggestions?: string[], pageURL?: string,
 *   editFlags?: { canUndo?: boolean, canRedo?: boolean, canCut?: boolean, canCopy?: boolean, canPaste?: boolean, canSelectAll?: boolean } }} params
 * @param {{ canGoBack?: boolean, canGoForward?: boolean, find?: boolean, language?: string | null }} [state]
 */
export function pageMenuItems(params, { canGoBack = false, canGoForward = false, find = false, language = null } = {}) {
  const copy = String(language ?? "").toLowerCase().startsWith("zh") ? COPY.zh : COPY.en;
  /** @type {Array<Array<Record<string, unknown>>>} */
  const groups = [];
  const flags = params?.editFlags ?? {};
  if (isWebUrl(params?.linkURL)) {
    groups.push([
      { id: "open-link-tab", label: copy.openLinkTab, value: params.linkURL },
      { id: "open-link-default", label: copy.openLinkDefault, value: params.linkURL },
      { id: "copy-link", label: copy.copyLink, value: params.linkURL },
      { id: "download-link", label: copy.downloadLink, value: params.linkURL },
    ]);
  }
  if (params?.mediaType === "image" && isWebUrl(params.srcURL)) {
    groups.push([
      { id: "open-image-tab", label: copy.openImageTab, value: params.srcURL },
      { id: "copy-image", label: copy.copyImage, enabled: params.hasImageContents !== false },
      { id: "copy-image-address", label: copy.copyImageAddress, value: params.srcURL },
      { id: "download-image", label: copy.downloadImage, value: params.srcURL },
    ]);
  }
  if (params?.isEditable) {
    const suggestions = (params.misspelledWord ? params.dictionarySuggestions ?? [] : []).slice(0, 5);
    if (suggestions.length) groups.push(suggestions.map((word) => ({ id: "spelling", label: word, value: word })));
    if (params.misspelledWord) groups.push([{ id: "add-word", label: copy.addWord, value: params.misspelledWord }]);
    groups.push([
      { id: "undo", label: copy.undo, enabled: flags.canUndo !== false },
      { id: "redo", label: copy.redo, enabled: flags.canRedo !== false },
    ], [
      { id: "cut", label: copy.cut, enabled: flags.canCut !== false },
      { id: "copy", label: copy.copy, enabled: flags.canCopy !== false },
      { id: "paste", label: copy.paste, enabled: flags.canPaste !== false },
      { id: "select-all", label: copy.selectAll, enabled: flags.canSelectAll !== false },
    ]);
  } else if (String(params?.selectionText ?? "").trim()) {
    groups.push([{ id: "copy", label: copy.copy }]);
  }
  if (groups.length === 0) {
    groups.push([
      { id: "back", label: copy.back, enabled: canGoBack },
      { id: "forward", label: copy.forward, enabled: canGoForward },
      { id: "reload", label: copy.reload },
    ], [
      ...(find ? [{ id: "find", label: copy.find }] : []),
      { id: "print", label: copy.print },
      ...(isWebUrl(params?.pageURL) ? [{ id: "copy-page", label: copy.copyPage, value: params.pageURL }] : []),
    ]);
  }
  return groups.flatMap((group, index) => (index > 0 ? [{ type: "separator" }, ...group] : group));
}
