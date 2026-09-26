import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { toast } from "@/components/ui/sonner";
import type { OmniRushServerClient, OmniRushVoiceStatus } from "@/app/lib/omnirush-server";
import {
  CircuitBreaker,
  RemoteTranscriber,
  VoiceSession,
  buildKeyterms,
  isVoiceError,
  type VoiceError,
  type VoiceSnapshot,
} from "@/app/lib/voice-core";
import { defaultHotkey, hotkeyDown, hotkeyUp, matchesHotkeyDown, matchesHotkeyUp, parseHotkey } from "./hotkey";
import { MicrophoneSource, ensureMicrophonePermission, microphoneSettingsUrl, type MicPermission } from "./mic-source";
import { useVoiceSettings, voicePrivacyNote } from "./voice-settings";
import { peekVoiceStatus, refreshVoiceStatus, useVoiceStatus } from "./voice-status";

export type VoiceClient = Pick<OmniRushServerClient, "baseUrl" | "getVoiceStatus" | "voiceTranscriptionEndpoint">;

/** What the composer's editor offers dictation (LexicalPromptEditorHandle's voice methods). */
export type VoiceEditor = {
  voiceBegin: () => void;
  voiceUpdate: (text: string, pending: boolean) => boolean;
  voiceCommit: (text: string) => string;
  voiceCancel: () => void;
};

export type VoiceAvailability =
  | { state: "hidden" }
  | { state: "ready" }
  | { state: "disabled"; reason: string };

/** Shared by every composer: three failures in 10 s pause voice for 30 s. */
const breaker = new CircuitBreaker();
/** Only one composer listens to the hotkey: the one focused last. */
let hotkeyOwner: symbol | null = null;
/** Tap mode (or a tap in "both") stops by itself after this much silence. */
const TAP_SILENCE_STOP_MS = 15_000;
const AUTO_SEND_MIN_WORDS = 3;

function availabilityFrom(enabled: boolean, client: VoiceClient | null, status: OmniRushVoiceStatus | null): VoiceAvailability {
  if (!enabled || !client) return { state: "hidden" };
  if (status && !status.signedIn) return { state: "disabled", reason: "Sign in to omnirush.ai to use voice input." };
  if (status?.available === false) {
    return { state: "disabled", reason: "Voice input isn't available on your account yet." };
  }
  return { state: "ready" };
}

function errorToast(error: VoiceError, partial: boolean): void {
  if (error.kind === "no_speech" || error.kind === "no_signal") {
    toast.info(error.message);
    return;
  }
  toast.error(partial ? `Part of the dictation was lost: ${error.message}` : error.message);
}

export type VoiceDictation = {
  availability: VoiceAvailability;
  snapshot: VoiceSnapshot | null;
  active: boolean;
  permissionDenied: boolean;
  settingsUrl: string | null;
  dismissPermission: () => void;
  toggle: () => void;
  start: (trigger: "button" | "tap" | "hold") => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => void;
  /** Call when the composer gains focus: it becomes the hotkey's target. */
  claimHotkey: () => void;
};

/**
 * Dictation for one composer: availability, capture, the hotkey (hold or
 * tap), Esc to cancel, and the live transcript in the editor.
 */
export function useVoiceDictation(input: {
  client: VoiceClient | null;
  workspaceId: string | null | undefined;
  recentFiles: readonly string[];
  editorRef: RefObject<VoiceEditor | null>;
  rootRef: RefObject<HTMLElement | null>;
  disabled: boolean;
  /** Dictation ended with auto-send on and enough words: `prompt` is the draft to send. */
  onAutoSend: (prompt: string) => void;
}): VoiceDictation {
  const settings = useVoiceSettings();
  const status = useVoiceStatus(input.client, input.workspaceId, settings.enabled);
  const availability = availabilityFrom(settings.enabled, input.client, status);
  const [snapshot, setSnapshot] = useState<VoiceSnapshot | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const sessionRef = useRef<VoiceSession | null>(null);
  const pressRef = useRef<{ at: number; hold: boolean } | null>(null);
  const identity = useMemo(() => Symbol("voice-composer"), []);
  const latest = useRef(input);
  latest.current = input;
  const active = snapshot !== null && ["arming", "recording", "finalizing"].includes(snapshot.phase);

  const finish = useCallback(() => {
    sessionRef.current = null;
    pressRef.current = null;
    setSnapshot(null);
  }, []);

  const start = useCallback(async (trigger: "button" | "tap" | "hold") => {
    const { client, editorRef } = latest.current;
    if (sessionRef.current || latest.current.disabled || !client) return;
    if (availability.state !== "ready") {
      if (availability.state === "disabled") toast.info(availability.reason);
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;
    const current = useVoiceSettings.getState();
    if (!current.disclosureSeen) {
      toast.info(voicePrivacyNote(peekVoiceStatus(client, latest.current.workspaceId)?.providerRetentionDays), { duration: 10_000 });
      current.update({ disclosureSeen: true });
    }
    const permission = await ensureMicrophonePermission().catch((): MicPermission => "unknown");
    if (permission === "denied") {
      setPermissionDenied(true);
      return;
    }
    const endpoint = client.voiceTranscriptionEndpoint();
    const projectStatus = peekVoiceStatus(client, latest.current.workspaceId);
    const session = new VoiceSession({
      source: new MicrophoneSource(current.deviceId),
      transcriber: new RemoteTranscriber({ url: endpoint.url, headers: () => endpoint.headers }),
      language: current.language === "auto" ? null : current.language,
      keyterms: buildKeyterms({ repo: projectStatus?.repo, branch: projectStatus?.branch, files: latest.current.recentFiles.slice(0, 20) }),
      breaker,
      silenceAutoStopMs: current.mode === "hold" ? null : TAP_SILENCE_STOP_MS,
      onAutoStop: () => void stopRef.current(),
      onChange: (next) => {
        if (sessionRef.current !== session) return;
        if (next.phase === "error") {
          // The microphone went away mid-recording.
          latest.current.editorRef.current?.voiceCancel();
          finish();
          if (next.error) toast.error(next.error.message);
          return;
        }
        setSnapshot(next);
        if (next.phase === "recording" || next.phase === "finalizing") {
          const present = latest.current.editorRef.current?.voiceUpdate(next.text, next.phase === "recording" || next.pending > 0);
          if (present === false) latest.current.editorRef.current?.voiceBegin();
        }
      },
    });
    sessionRef.current = session;
    hotkeyOwner = identity;
    editor.voiceBegin();
    try {
      await session.start();
    } catch (error) {
      editor.voiceCancel();
      finish();
      if (isVoiceError(error) && error.kind === "permission_denied") setPermissionDenied(true);
      else if (error instanceof Error && error.message) toast.error(error.message);
    }
  }, [availability, finish, identity]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    const result = await session.stop();
    if (sessionRef.current !== session) return;
    const editor = latest.current.editorRef.current;
    const prompt = editor ? editor.voiceCommit(result.text) : "";
    finish();
    if (result.error) {
      errorToast(result.error, Boolean(result.text));
      if (result.error.kind === "unavailable" || result.error.kind === "signed_out") {
        refreshVoiceStatus(latest.current.client, latest.current.workspaceId);
      }
    }
    if (useVoiceSettings.getState().autoSend && result.words >= AUTO_SEND_MIN_WORDS && !result.error) {
      latest.current.onAutoSend(prompt);
    }
  }, [finish]);

  const stopRef = useRef(stop);
  stopRef.current = stop;

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    session.cancel();
    latest.current.editorRef.current?.voiceCancel();
    finish();
  }, [finish]);

  const toggle = useCallback(() => {
    if (sessionRef.current) void stop();
    else void start("button");
  }, [start, stop]);

  // Esc cancels and restores the prompt; it does nothing else (no agent stop, no menu).
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, cancel]);

  // The hotkey: a long press is push-to-talk, a quick press toggles (per mode).
  useEffect(() => {
    if (availability.state === "hidden") return;
    const hotkey = parseHotkey(settings.hotkey ?? defaultHotkey()) ?? parseHotkey(defaultHotkey());
    if (!hotkey) return;
    hotkeyOwner ??= identity;
    const owns = () => {
      if (hotkeyOwner === identity) return true;
      // The owner went away (unmounted): the first composer still on screen takes over.
      const root = latest.current.rootRef.current;
      if (!root?.isConnected) return false;
      hotkeyOwner = identity;
      return true;
    };
    const onDown = (event: KeyboardEvent) => {
      if (!matchesHotkeyDown(event, hotkey) || !owns()) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const mode = useVoiceSettings.getState().mode;
      const action = hotkeyDown(mode, Boolean(sessionRef.current));
      if (action === "stop") {
        void stop();
      } else if (action === "start") {
        pressRef.current = { at: performance.now(), hold: true };
        void start(mode === "tap" ? "tap" : "hold");
      }
    };
    const onUp = (event: KeyboardEvent) => {
      if (!matchesHotkeyUp(event, hotkey) || !pressRef.current || !owns()) return;
      event.preventDefault();
      const heldMs = performance.now() - pressRef.current.at;
      const mode = useVoiceSettings.getState().mode;
      const action = hotkeyUp(mode, Boolean(sessionRef.current), heldMs);
      pressRef.current = null;
      if (action === "stop") void stop();
    };
    const onBlur = () => {
      // Letting go outside the window: a hold ends like a release.
      if (pressRef.current && sessionRef.current && useVoiceSettings.getState().mode !== "tap") {
        const heldMs = performance.now() - pressRef.current.at;
        pressRef.current = null;
        if (hotkeyUp(useVoiceSettings.getState().mode, true, heldMs) === "stop") void stop();
      }
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
      if (hotkeyOwner === identity) hotkeyOwner = null;
    };
  }, [availability.state, identity, settings.hotkey, start, stop]);

  // Leaving the composer (session switch, unmount) drops a recording in progress.
  useEffect(() => () => {
    sessionRef.current?.cancel();
    sessionRef.current = null;
  }, []);

  return {
    availability,
    snapshot,
    active,
    permissionDenied,
    settingsUrl: microphoneSettingsUrl(),
    dismissPermission: () => setPermissionDenied(false),
    toggle,
    start,
    stop,
    cancel,
    claimHotkey: () => {
      hotkeyOwner = identity;
    },
  };
}
