import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LOCAL_PREFERENCES_KEY } from "../src/react-app/kernel/local-preferences-storage";
import { notifyDesktopEvent } from "../src/react-app/shell/desktop-notifications";
import { installNotificationSoundUnlock } from "../src/react-app/shell/notification-sounds";

type DesktopCall = { command: string; args: unknown[] };

const storage = new Map<string, string>();
const calls: DesktopCall[] = [];
const audioContexts: FakeAudioContext[] = [];
let audioState: "running" | "suspended" = "running";
let rejectResume = false;
let rejectAudioNodes = false;
let soundCleanup: (() => void) | undefined;

class FakeAudioParam {
  writes: { method: string; value: number; time: number }[] = [];

  setValueAtTime(value: number, time: number) {
    this.writes.push({ method: "set", value, time });
  }

  linearRampToValueAtTime(value: number, time: number) {
    this.writes.push({ method: "linear", value, time });
  }

  exponentialRampToValueAtTime(value: number, time: number) {
    this.writes.push({ method: "exponential", value, time });
  }
}

class FakeOscillator {
  type = "";
  frequency = new FakeAudioParam();
  onended: (() => void) | null = null;
  starts: number[] = [];
  stops: number[] = [];
  disconnected = false;

  connect() {}
  disconnect() { this.disconnected = true; }
  start(time: number) { this.starts.push(time); }
  stop(time: number) { this.stops.push(time); }
}

class FakeGain {
  gain = new FakeAudioParam();
  disconnected = false;

  connect() {}
  disconnect() { this.disconnected = true; }
}

class FakeAudioContext {
  state: "running" | "suspended" | "closed" = audioState;
  currentTime = 0;
  destination = {};
  oscillators: FakeOscillator[] = [];
  gains: FakeGain[] = [];
  resumes = 0;
  closes = 0;

  constructor() { audioContexts.push(this); }

  createOscillator() {
    if (rejectAudioNodes) throw new Error("Audio output unavailable");
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  async resume() {
    this.resumes += 1;
    if (rejectResume) throw new Error("Audio is blocked");
    this.state = "running";
  }

  async close() {
    this.closes += 1;
    this.state = "closed";
  }
}

const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
};

function setPreference(value: "off" | "important" | "all", sounds?: boolean) {
  localStorageStub.setItem(LOCAL_PREFERENCES_KEY, JSON.stringify({
    desktopNotifications: value,
    ...(sounds === undefined ? {} : { notificationSounds: sounds }),
  }));
}

function installRuntime({ focused, visible = focused, audio = "available" }: {
  focused: boolean;
  visible?: boolean;
  audio?: "available" | "unsupported" | "throwing";
}) {
  const events = new EventTarget();
  const AudioContext = audio === "throwing"
    ? class { constructor() { throw new Error("Audio device unavailable"); } }
    : audio === "available" ? FakeAudioContext : undefined;
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: localStorageStub,
      AudioContext,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      __OMNIRUSH_ELECTRON__: {
        invokeDesktop: async (command: string, ...args: unknown[]) => {
          calls.push({ command, args });
          return { ok: true };
        },
      },
    },
    configurable: true,
  });

  Object.defineProperty(globalThis, "document", {
    value: {
      visibilityState: visible ? "visible" : "hidden",
      hasFocus: () => focused,
    },
    configurable: true,
  });
}

describe("desktop notifications", () => {
  beforeEach(() => {
    storage.clear();
    calls.length = 0;
    audioContexts.length = 0;
    audioState = "running";
    rejectResume = false;
    rejectAudioNodes = false;
    installRuntime({ focused: false });
    soundCleanup = installNotificationSoundUnlock();
  });

  afterEach(() => {
    soundCleanup?.();
    soundCleanup = undefined;
  });

  test("off suppresses popups but still plays a soft attention sound", () => {
    setPreference("off");

    notifyDesktopEvent({ type: "task.failed", sessionId: "session-a", errorText: "Boom" });

    expect(calls).toHaveLength(0);
    expect(audioContexts[0]?.oscillators.map((note) => note.frequency.writes[0]?.value))
      .toEqual([523.25, 659.25]);
  });

  test("important sends attention events but not completions", async () => {
    setPreference("important");

    notifyDesktopEvent({ type: "task.completed", sessionId: "session-a" });
    notifyDesktopEvent({ type: "question.asked", sessionId: "session-a", question: "Question: Continue?" });
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "desktopNotificationShow",
      args: [{ title: "Question needs your answer", body: "Question: Continue?", silent: true }],
    });
  });

  test("all sends task completion notifications", async () => {
    setPreference("all");

    notifyDesktopEvent({ type: "task.completed", sessionId: "session-a" });
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "desktopNotificationShow",
      args: [{ title: "Task completed", body: "The session finished running.", silent: true }],
    });
  });

  test("focused app suppresses sounds and native popups", () => {
    setPreference("all");
    installRuntime({ focused: true });

    notifyDesktopEvent({ type: "task.failed", sessionId: "session-a", errorText: "Boom" });

    expect(calls).toHaveLength(0);
    expect(audioContexts).toHaveLength(0);
  });

  test("sounds default on even when no popup preference has been saved", () => {
    notifyDesktopEvent({ type: "task.completed", sessionId: "session-a" });

    expect(calls).toHaveLength(0);
    const audio = audioContexts[0];
    expect(audio?.oscillators.map((note) => note.frequency.writes[0]?.value)).toEqual([659.25, 880]);
    expect(audio?.oscillators.map((note) => note.type)).toEqual(["sine", "sine"]);
    expect(audio?.oscillators.map((note) => note.starts)).toEqual([[0], [0.12]]);
    expect(audio?.oscillators[0]?.stops[0]).toBeCloseTo(0.45);
    expect(audio?.oscillators[1]?.stops[0]).toBeCloseTo(0.57);
    expect(audio?.gains.map((gain) => gain.gain.writes.map((write) => write.value)))
      .toEqual([[0, 0.045, 0.001, 0], [0, 0.045, 0.001, 0]]);
    for (const oscillator of audio?.oscillators ?? []) oscillator.onended?.();
    expect(audio?.oscillators.every((note) => note.disconnected)).toBe(true);
    expect(audio?.gains.every((gain) => gain.disconnected)).toBe(true);
  });

  test.each(["permission.asked", "question.asked"] satisfies ("permission.asked" | "question.asked")[])("%s plays an attention sound", (type) => {
    notifyDesktopEvent({ type, sessionId: "session-a" });

    expect(audioContexts[0]?.oscillators.map((note) => note.frequency.writes[0]?.value))
      .toEqual([523.25, 659.25]);
  });

  test("mute suppresses sound while preserving native popups", () => {
    setPreference("all", false);

    notifyDesktopEvent({ type: "task.completed", sessionId: "session-a" });

    expect(audioContexts).toHaveLength(0);
    expect(calls[0]?.args).toEqual([{ title: "Task completed", body: "The session finished running.", silent: true }]);
  });

  test("a visible but unfocused app plays a sound", () => {
    installRuntime({ focused: false, visible: true });

    notifyDesktopEvent({ type: "permission.asked", sessionId: "session-a" });

    expect(audioContexts[0]?.oscillators).toHaveLength(2);
  });

  test("nearby events coalesce but a later completion still plays", () => {
    notifyDesktopEvent({ type: "permission.asked", sessionId: "session-a" });
    const audio = audioContexts[0];
    if (!audio) throw new Error("Expected an audio context");
    audio.currentTime = 0.5;
    notifyDesktopEvent({ type: "question.asked", sessionId: "session-b" });
    audio.currentTime = 0.999;
    notifyDesktopEvent({ type: "task.completed", sessionId: "session-c" });
    expect(audio.oscillators).toHaveLength(2);

    audio.currentTime = 1;
    notifyDesktopEvent({ type: "task.completed", sessionId: "session-c" });

    expect(audioContexts).toHaveLength(1);
    expect(audio.oscillators).toHaveLength(4);
    expect(audio.oscillators.slice(2).map((note) => note.frequency.writes[0]?.value)).toEqual([659.25, 880]);
  });

  test.each(["unsupported", "throwing"] satisfies ("unsupported" | "throwing")[])("%s audio does not prevent a popup", (audio) => {
    setPreference("all");
    installRuntime({ focused: false, audio });

    expect(() => notifyDesktopEvent({ type: "task.completed", sessionId: "session-a" })).not.toThrow();
    expect(calls).toHaveLength(1);
    expect(audioContexts).toHaveLength(0);
  });

  test("an audio output failure does not prevent a popup", () => {
    setPreference("all");
    rejectAudioNodes = true;

    expect(() => notifyDesktopEvent({ type: "question.asked", sessionId: "session-a" })).not.toThrow();
    expect(calls).toHaveLength(1);
  });

  test.each(["pointerdown", "keydown"])("%s unlocks audio before a background event", async (event) => {
    audioState = "suspended";
    window.dispatchEvent(new Event(event));
    await Promise.resolve();

    expect(audioContexts[0]?.resumes).toBe(1);
    expect(audioContexts[0]?.state).toBe("running");
    notifyDesktopEvent({ type: "task.completed", sessionId: "session-a" });
    expect(audioContexts[0]?.oscillators).toHaveLength(2);
  });

  test("blocked audio skips stale sounds and a rejected unlock is harmless", async () => {
    audioState = "suspended";
    rejectResume = true;
    setPreference("all");

    expect(() => notifyDesktopEvent({ type: "task.completed", sessionId: "session-a" })).not.toThrow();
    expect(audioContexts[0]?.oscillators).toHaveLength(0);
    expect(() => window.dispatchEvent(new Event("keydown"))).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(audioContexts[0]?.state).toBe("suspended");
    expect(calls).toHaveLength(1);
  });

  test("cleanup removes unlock listeners and closes the audio context", () => {
    window.dispatchEvent(new Event("pointerdown"));
    const audio = audioContexts[0];

    soundCleanup?.();
    soundCleanup = undefined;
    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("keydown"));

    expect(audio?.closes).toBe(1);
    expect(audio?.state).toBe("closed");
    expect(audioContexts).toHaveLength(1);
    notifyDesktopEvent({ type: "task.completed", sessionId: "session-a" });
    expect(audioContexts).toHaveLength(2);
    expect(audioContexts[1]?.oscillators).toHaveLength(2);
    soundCleanup = installNotificationSoundUnlock();
  });
});
