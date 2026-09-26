/**
 * The dictation hotkey: modifiers plus a KeyboardEvent.code ("Ctrl+Space",
 * "Alt+Space", "Ctrl+Shift+KeyM"). Codes are layout-independent, and macOS
 * Option+Space still reports code "Space" even though it types a
 * non-breaking space.
 */
export type Hotkey = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; code: string };

const MODIFIER_CODES = new Set(["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"]);

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Macintosh|Mac OS X|iPhone|iPad/.test(navigator.userAgent);
}

/** Option+Space on macOS (Cmd+Space is Spotlight, Ctrl+Space switches input source); Ctrl+Space elsewhere (Alt+Space opens the window menu on Windows). */
export function defaultHotkey(mac = isMacPlatform()): string {
  return mac ? "Alt+Space" : "Ctrl+Space";
}

export function parseHotkey(value: string): Hotkey | null {
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  const code = parts.pop();
  if (!code || MODIFIER_CODES.has(code)) return null;
  const hotkey: Hotkey = { ctrl: false, alt: false, shift: false, meta: false, code };
  for (const part of parts) {
    const name = part.toLowerCase();
    if (name === "ctrl" || name === "control") hotkey.ctrl = true;
    else if (name === "alt" || name === "option") hotkey.alt = true;
    else if (name === "shift") hotkey.shift = true;
    else if (name === "meta" || name === "cmd" || name === "command" || name === "super") hotkey.meta = true;
    else return null;
  }
  // A bare letter or digit would fire while typing.
  if (!hotkey.ctrl && !hotkey.alt && !hotkey.meta && !/^F\d{1,2}$/.test(code)) return null;
  return hotkey;
}

export function hotkeyFromEvent(event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "code">): string | null {
  if (MODIFIER_CODES.has(event.code) || !event.code) return null;
  const parts = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta", event.code].filter(
    (part): part is string => typeof part === "string",
  );
  const value = parts.join("+");
  return parseHotkey(value) ? value : null;
}

export function matchesHotkeyDown(event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "code">, hotkey: Hotkey): boolean {
  return event.code === hotkey.code
    && event.ctrlKey === hotkey.ctrl
    && event.altKey === hotkey.alt
    && event.shiftKey === hotkey.shift
    && event.metaKey === hotkey.meta;
}

/** Releasing the hotkey's key ends a hold, whichever modifier was let go first. */
export function matchesHotkeyUp(event: Pick<KeyboardEvent, "code">, hotkey: Hotkey): boolean {
  return event.code === hotkey.code;
}

export function formatHotkey(value: string, mac = isMacPlatform()): string {
  const hotkey = parseHotkey(value);
  if (!hotkey) return value;
  const key = hotkey.code.replace(/^Key/, "").replace(/^Digit/, "");
  const names = mac
    ? [hotkey.ctrl && "⌃", hotkey.alt && "⌥", hotkey.shift && "⇧", hotkey.meta && "⌘"]
    : [hotkey.ctrl && "Ctrl", hotkey.alt && "Alt", hotkey.shift && "Shift", hotkey.meta && "Win"];
  const modifiers = names.filter((part): part is string => typeof part === "string");
  return mac ? `${modifiers.join("")}${key}` : [...modifiers, key].join("+");
}

/** A press shorter than this is a tap (toggle); longer is push-to-talk. */
export const HOLD_THRESHOLD_MS = 250;

export type HotkeyAction = "start" | "stop" | "none";

/**
 * The hold/tap decision, kept pure for tests. `recording` is whether a
 * dictation is running; `pressedAt` the time of the keydown that started it
 * (null when it was started by a tap or the mic button).
 */
export function hotkeyDown(mode: "both" | "hold" | "tap", recording: boolean): HotkeyAction {
  if (!recording) return "start";
  return mode === "hold" ? "none" : "stop";
}

export function hotkeyUp(mode: "both" | "hold" | "tap", recording: boolean, heldMs: number | null): HotkeyAction {
  if (!recording || heldMs === null) return "none";
  if (mode === "tap") return "none";
  if (mode === "hold") return "stop";
  return heldMs >= HOLD_THRESHOLD_MS ? "stop" : "none";
}
