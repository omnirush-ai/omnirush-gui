import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { t } from "@/i18n";

/** hold: talk while the hotkey is held. tap: press to start, press again to stop. both: a long press holds, a quick press taps. */
export type VoiceMode = "both" | "hold" | "tap";

export type VoiceSettings = {
  enabled: boolean;
  mode: VoiceMode;
  /** The hotkey as modifiers + KeyboardEvent.code, e.g. "Ctrl+Space" / "Alt+Space"; null for the platform default. */
  hotkey: string | null;
  /** An audio input's deviceId; null follows the system default. */
  deviceId: string | null;
  /** BCP-47 language hint; "auto" lets the service detect it. */
  language: string;
  /** Send the prompt when dictation ends (at least 3 words). */
  autoSend: boolean;
};

type VoiceSettingsStore = VoiceSettings & {
  update: (patch: Partial<VoiceSettings>) => void;
};

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: true,
  mode: "both",
  hotkey: null,
  deviceId: null,
  language: "auto",
  autoSend: false,
};

export const useVoiceSettings = create<VoiceSettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_VOICE_SETTINGS,
      update: (patch) => set(patch),
    }),
    {
      name: "omnirush.voice.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ update: _update, ...settings }) => settings,
    },
  ),
);

/**
 * Shown in Settings → Voice. The provider's
 * retention comes from the backend's voice status (it cannot be turned off
 * upstream today: 30 days); without one the clause is left out.
 */
export function voicePrivacyNote(providerRetentionDays?: number | null): string {
  const provider = providerRetentionDays
    ? t("voice.privacy_retention", { days: providerRetentionDays })
    : t("voice.privacy_no_store");
  return t("voice.privacy_note", { provider });
}

/** Languages offered as a hint; the service detects the language on its own with "auto". */
export const VOICE_LANGUAGES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "auto", label: "Detect automatically" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "pl", label: "Polish" },
  { value: "ru", label: "Russian" },
  { value: "uk", label: "Ukrainian" },
  { value: "tr", label: "Turkish" },
  { value: "hi", label: "Hindi" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
  { value: "vi", label: "Vietnamese" },
  { value: "th", label: "Thai" },
  { value: "id", label: "Indonesian" },
  { value: "ca", label: "Catalan" },
];
