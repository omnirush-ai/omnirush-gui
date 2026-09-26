/** @jsxImportSource react */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRequire } from "node:module";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { OmniRushVoiceStatus } from "../src/app/lib/omnirush-server";
import type { LexicalPromptEditorHandle } from "../src/react-app/domains/session/surface/composer/editor";
import type { VoiceClient } from "../src/react-app/domains/voice/use-voice-dictation";
import { defaultHotkey, formatHotkey, hotkeyDown, hotkeyFromEvent, hotkeyUp, parseHotkey } from "../src/react-app/domains/voice/hotkey";

const RATE = 16_000;

function tone(ms: number): Int16Array {
  const out = new Int16Array(Math.round((RATE * ms) / 1000));
  for (let i = 0; i < out.length; i += 1) out[i] = Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 200 * i) / RATE));
  return out;
}
const quiet = (ms: number) => new Int16Array(Math.round((RATE * ms) / 1000));
function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** What the fake microphone plays next (16 kHz PCM, real time in 20 ms chunks). */
let micAudio = concat(tone(1_200), quiet(800), tone(1_200), quiet(3_000));
const micStarts: string[] = [];

describe("hotkey rules", () => {
  test("defaults: Option+Space on macOS, Ctrl+Space elsewhere", () => {
    expect(defaultHotkey(true)).toBe("Alt+Space");
    expect(defaultHotkey(false)).toBe("Ctrl+Space");
    expect(formatHotkey("Alt+Space", true)).toBe("⌥Space");
    expect(formatHotkey("Ctrl+Space", false)).toBe("Ctrl+Space");
  });

  test("a bare key is refused (it would fire while typing); modifier combos and F-keys are accepted", () => {
    expect(parseHotkey("Space")).toBeNull();
    expect(parseHotkey("KeyM")).toBeNull();
    expect(parseHotkey("F8")).not.toBeNull();
    expect(parseHotkey("Ctrl+Shift+KeyM")).toEqual({ ctrl: true, alt: false, shift: true, meta: false, code: "KeyM" });
    expect(hotkeyFromEvent({ ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, code: "Space" })).toBe("Alt+Space");
    expect(hotkeyFromEvent({ ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, code: "ControlLeft" })).toBeNull();
  });

  test("hold versus tap", () => {
    expect(hotkeyDown("both", false)).toBe("start");
    expect(hotkeyUp("both", true, 600)).toBe("stop"); // held: push-to-talk
    expect(hotkeyUp("both", true, 120)).toBe("none"); // tapped: keeps recording
    expect(hotkeyDown("both", true)).toBe("stop"); // second tap
    expect(hotkeyUp("hold", true, 50)).toBe("stop");
    expect(hotkeyDown("hold", true)).toBe("none");
    expect(hotkeyUp("tap", true, 900)).toBe("none");
    expect(hotkeyDown("tap", true)).toBe("stop");
  });
});

describe("dictation in the composer", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  let status: OmniRushVoiceStatus;
  let uploads: FormData[];
  let answers: (index: number) => Response;
  let sent: string[];
  let Harness: (props: { client: VoiceClient; initial: string }) => React.JSX.Element;

  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    for (const moduleId of [
      "lexical",
      "@lexical/react/LexicalComposer.js",
      "@lexical/react/LexicalPlainTextPlugin.js",
      "@lexical/react/LexicalContentEditable.js",
      "@lexical/react/LexicalErrorBoundary.js",
      "@lexical/react/LexicalOnChangePlugin.js",
      "@lexical/react/LexicalHistoryPlugin.js",
      "@lexical/react/LexicalComposerContext.js",
    ]) {
      const moduleExports = require(moduleId);
      mock.module(moduleId, () => moduleExports);
    }
    if (typeof globalThis.document === "undefined") GlobalRegistrator.register({ url: "http://localhost/" });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    // Recording updates arrive from audio timers, outside act(); the warning is noise here.
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes("not wrapped in act")) return;
      consoleError(...args);
    };
    const core = await import("../src/app/lib/voice-core");
    const actualMic = await import("../src/react-app/domains/voice/mic-source");
    // The microphone: plays `micAudio` through voice-core's file source.
    mock.module("../src/react-app/domains/voice/mic-source", () => ({
      ...actualMic,
      MicrophoneSource: class {
        private inner = new core.WavFileSource(core.encodeWav(micAudio), { realtime: true, chunkMs: 20 });
        constructor(deviceId: string | null) {
          micStarts.push(String(deviceId));
        }
        start(onFrames: (frames: Int16Array) => void, onEnd?: () => void) {
          return this.inner.start(onFrames, onEnd);
        }
        stop() {
          this.inner.stop();
        }
      },
    }));
    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/omnirush/voice/transcribe")) return new Response("{}", { status: 404 });
      const form = init?.body as FormData;
      uploads.push(form);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return answers(Number(form.get("segment_index")));
    };
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchStub });
    const { LexicalPromptEditor } = await import("../src/react-app/domains/session/surface/composer/editor");
    const { useVoiceDictation } = await import("../src/react-app/domains/voice/use-voice-dictation");
    const { VoiceButton, VoicePermissionCard } = await import("../src/react-app/domains/voice/voice-button");
    Harness = function VoiceHarness(props) {
      const [draft, setDraft] = useState(props.initial);
      const editorRef = useRef<LexicalPromptEditorHandle | null>(null);
      const rootRef = useRef<HTMLDivElement | null>(null);
      const voice = useVoiceDictation({
        client: props.client,
        workspaceId: "ws-1",
        recentFiles: ["src/auth.ts"],
        editorRef,
        rootRef,
        disabled: false,
        onAutoSend: (prompt) => sent.push(prompt),
      });
      return (
        <div ref={rootRef}>
          <output data-testid="draft">{draft}</output>
          <VoicePermissionCard voice={voice} />
          <LexicalPromptEditor
            ref={editorRef}
            value={draft}
            mentions={{}}
            submitDisabled={false}
            placeholder="Ask"
            onChange={setDraft}
            onSubmit={() => {}}
          />
          <VoiceButton voice={voice} />
        </div>
      );
    };
  });

  afterAll(() => {
    mock.restore();
  });

  let testClient: VoiceClient;
  function client(): VoiceClient {
    testClient = {
      baseUrl: "http://127.0.0.1:1",
      getVoiceStatus: async () => status,
      voiceTranscriptionEndpoint: () => ({ url: "http://127.0.0.1:1/omnirush/voice/transcribe", headers: { Authorization: "Bearer t" } }),
    };
    return testClient;
  }

  async function mount(initial = "Fix the") {
    status = { signedIn: true, available: true, reason: null, repo: "omnirush-gui", branch: "feat/voice-mode" };
    uploads = [];
    sent = [];
    answers = (index) => Response.json({ text: ["oh auth middleware", "in auth dot ts"][index] ?? "" });
    micStarts.length = 0;
    micAudio = concat(tone(1_200), quiet(800), tone(1_200), quiet(3_000));
    window.localStorage.clear();
    delete (window as { __OMNIRUSH_ELECTRON__?: unknown }).__OMNIRUSH_ELECTRON__;
    queryClient = new QueryClient();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const { useVoiceSettings, DEFAULT_VOICE_SETTINGS } = await import("../src/react-app/domains/voice/voice-settings");
    useVoiceSettings.setState({ ...DEFAULT_VOICE_SETTINGS, disclosureSeen: true });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness client={client()} initial={initial} />
        </QueryClientProvider>,
      );
    });
    const { refreshVoiceStatus } = await import("../src/react-app/domains/voice/voice-status");
    refreshVoiceStatus(testClient, "ws-1");
    await waitFor(() => container.querySelector("[data-testid=voice-mic-button]")?.getAttribute("data-voice-available") === "true", "mic button");

  }

  async function unmount() {
    await act(async () => root.unmount());
    container.remove();
  }

  const $ = (id: string) => container.querySelector<HTMLElement>(`[data-testid=${id}]`);
  const draft = () => $("draft")?.textContent ?? "";

  async function waitFor(predicate: () => boolean, label: string, ms = 6_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      });
    }
    throw new Error(`Timed out waiting for ${label}; draft=${JSON.stringify(draft())}`);
  }

  async function key(type: "keydown" | "keyup", init: KeyboardEventInit) {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
    });
  }

  test("tap the mic: live waveform and dim partial text, then the text lands at the cursor, editable and unsent", async () => {
    await mount("Fix the");
    await act(async () => $("voice-mic-button")!.click());
    await waitFor(() => Boolean($("voice-recording")), "recording pill");
    expect($("voice-waveform")!.children).toHaveLength(16);
    // The first segment's text shows while the user is still talking, dim, in the editor.
    await waitFor(() => container.querySelector("[data-voice-interim]")?.textContent?.includes("OAuth middleware") ?? false, "interim text");
    expect(container.querySelector("[data-voice-interim]")!.className).toContain("italic");
    await waitFor(() => uploads.length >= 2, "the second phrase uploaded");
    await act(async () => $("voice-stop")!.click());
    await waitFor(() => !$("voice-recording"), "recording ended");
    expect(draft()).toBe("Fix the OAuth middleware in auth.ts");
    expect(container.querySelector("[data-voice-interim]")).toBeNull();
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.get("prompt_terms")).toContain("omnirush-gui");
    expect(sent).toEqual([]);
    await unmount();
  });

  test("Esc cancels: uploads stop and the prompt is restored exactly", async () => {
    await mount("Keep my draft");
    answers = () => new Promise<Response>(() => {}) as unknown as Response;
    await act(async () => $("voice-mic-button")!.click());
    await waitFor(() => uploads.length > 0, "first upload");
    await key("keydown", { key: "Escape", code: "Escape" });
    await waitFor(() => !$("voice-recording"), "cancelled");
    expect(draft()).toBe("Keep my draft");
    expect(container.querySelector("[data-voice-interim]")).toBeNull();
    await unmount();
  });

  test("hold the hotkey to talk, release to finish", async () => {
    await mount("");
    const hotkey = parseHotkey(defaultHotkey())!;
    const down = { code: "Space", key: " ", ctrlKey: hotkey.ctrl, altKey: hotkey.alt };
    await key("keydown", down);
    await waitFor(() => Boolean($("voice-recording")), "recording on keydown");
    await waitFor(() => uploads.length >= 1, "a segment uploaded while held");
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await key("keyup", { code: "Space", key: " " });
    await waitFor(() => !$("voice-recording"), "released");
    expect(draft()).toBe("OAuth middleware in auth.ts");
    await unmount();
  });

  test("auto-send (when turned on) sends after three or more words", async () => {
    await mount("");
    const { useVoiceSettings } = await import("../src/react-app/domains/voice/voice-settings");
    useVoiceSettings.getState().update({ autoSend: true });
    await act(async () => $("voice-mic-button")!.click());
    await waitFor(() => uploads.length >= 2, "both segments uploaded");
    await act(async () => $("voice-stop")!.click());
    await waitFor(() => sent.length === 1, "auto-send");
    expect(sent[0]).toBe("OAuth middleware in auth.ts");
    await unmount();
  });

  test("voice unavailable on the account: the mic is disabled with a reason", async () => {
    await mount();
    status = { ...status, available: false, reason: "voice_unavailable" };
    const { refreshVoiceStatus } = await import("../src/react-app/domains/voice/voice-status");
    refreshVoiceStatus(testClient, "ws-1");
    await waitFor(() => $("voice-mic-button")?.getAttribute("data-voice-available") === "false", "disabled mic");
    expect($("voice-mic-button")!.title).toBe("Voice input isn't available on your account yet.");
    await act(async () => $("voice-mic-button")!.click());
    expect($("voice-recording")).toBeNull();
    expect(micStarts).toEqual([]);
    await unmount();
  });

  test("a 503 voice_unavailable mid-dictation ends it without inserting text", async () => {
    await mount("Start");
    answers = () => Response.json({ detail: "voice_unavailable" }, { status: 503 });
    await act(async () => $("voice-mic-button")!.click());
    await waitFor(() => uploads.length >= 1, "upload");
    await act(async () => $("voice-stop")!.click());
    await waitFor(() => !$("voice-recording"), "stopped");
    expect(draft()).toBe("Start");
    await unmount();
  });

  test("microphone permission denied by the OS shows the settings card and never opens the mic", async () => {
    await mount();
    Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", {
      configurable: true,
      value: { system: { getMicrophoneStatus: async () => ({ platform: "darwin", status: "denied" }) } },
    });
    await act(async () => $("voice-mic-button")!.click());
    await waitFor(() => Boolean($("voice-permission-card")), "permission card");
    expect(micStarts).toEqual([]);
    await unmount();
  });

  test("a silent microphone uploads nothing and inserts nothing", async () => {
    await mount("Draft");
    micAudio = quiet(1_500);
    await act(async () => $("voice-mic-button")!.click());
    await waitFor(() => !$("voice-recording"), "the source ran dry and dictation ended", 8_000);
    expect(uploads).toHaveLength(0);
    expect(draft()).toBe("Draft");
    await unmount();
  });
});
