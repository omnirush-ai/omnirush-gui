/** @jsxImportSource react */
import { LoaderCircle, Mic, MicOff, Square, X } from "lucide-react";

import { defaultHotkey, formatHotkey } from "./hotkey";
import { openMicrophoneSettings } from "./mic-source";
import type { VoiceDictation } from "./use-voice-dictation";
import { useVoiceSettings } from "./voice-settings";

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The mic beside the paperclip; while dictating, a pill with the live waveform, a timer, stop and cancel. */
export function VoiceButton(props: { voice: VoiceDictation; disabled?: boolean }) {
  const { voice } = props;
  const hotkey = useVoiceSettings((state) => state.hotkey) ?? defaultHotkey();
  if (voice.availability.state === "hidden") return null;

  if (voice.active && voice.snapshot) {
    const { snapshot } = voice;
    const finalizing = snapshot.phase === "finalizing";
    return (
      <div
        data-testid="voice-recording"
        data-voice-phase={snapshot.phase}
        className="inline-flex h-9 max-h-9 shrink-0 items-center gap-1.5 rounded-full border border-red-6/50 bg-red-3/40 pl-2.5 pr-1 text-[12px] font-medium text-red-11"
        role="status"
        aria-live="polite"
      >
        {finalizing ? (
          <LoaderCircle size={13} className="animate-spin" aria-hidden />
        ) : (
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-9" aria-hidden />
        )}
        <span className="flex h-5 items-center gap-[2px]" data-testid="voice-waveform" aria-hidden>
          {snapshot.levels.map((level, index) => (
            <span
              // Fixed 16 bars, so the index is a stable key.
              key={index}
              className="w-[2px] rounded-full bg-red-9 transition-[height] duration-75"
              style={{ height: `${Math.max(2, Math.round(level * 20))}px` }}
            />
          ))}
        </span>
        <span className="min-w-[2.2rem] tabular-nums" data-testid="voice-timer">
          {finalizing ? "…" : clock(snapshot.elapsedMs)}
        </span>
        <span className="sr-only">{finalizing ? "Transcribing" : "Recording"}</span>
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-red-4"
          onClick={() => void voice.stop()}
          disabled={finalizing}
          aria-label="Stop dictation"
          title="Stop dictation"
          data-testid="voice-stop"
        >
          <Square size={11} fill="currentColor" />
        </button>
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-red-4"
          onClick={voice.cancel}
          aria-label="Cancel dictation (Esc)"
          title="Cancel dictation (Esc)"
          data-testid="voice-cancel"
        >
          <X size={13} />
        </button>
      </div>
    );
  }

  const unavailable = voice.availability.state === "disabled";
  const title = unavailable && voice.availability.state === "disabled"
    ? voice.availability.reason
    : `Dictate: hold or tap ${formatHotkey(hotkey)}`;
  return (
    <button
      type="button"
      data-testid="voice-mic-button"
      data-voice-available={unavailable ? "false" : "true"}
      className={`inline-flex h-9 max-h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 ${
        unavailable || props.disabled ? "cursor-not-allowed opacity-60" : ""
      }`}
      onClick={() => {
        if (unavailable || props.disabled) return;
        voice.toggle();
      }}
      aria-disabled={unavailable || props.disabled}
      aria-label={title}
      title={title}
    >
      {unavailable ? <MicOff size={16} /> : <Mic size={16} />}
    </button>
  );
}

/** Shown when the OS or the user blocked the microphone. */
export function VoicePermissionCard(props: { voice: VoiceDictation }) {
  if (!props.voice.permissionDenied) return null;
  const url = props.voice.settingsUrl;
  return (
    <div
      className="mx-4 mt-3 flex items-center gap-3 rounded-xl border border-amber-7/40 bg-amber-2/40 px-3 py-2 text-xs text-amber-11"
      data-testid="voice-permission-card"
      role="alert"
    >
      <span className="min-w-0 flex-1">
        Microphone access is off for OmniRush.ai.{" "}
        {url ? "Turn it on in your system's privacy settings, then try again." : "Check that a microphone is connected and allowed, then try again."}
      </span>
      {url ? (
        <button type="button" className="shrink-0 font-medium hover:underline" onClick={() => void openMicrophoneSettings()}>
          Open settings
        </button>
      ) : null}
      <button type="button" className="shrink-0 font-medium hover:underline" onClick={props.voice.dismissPermission}>
        Dismiss
      </button>
    </div>
  );
}
