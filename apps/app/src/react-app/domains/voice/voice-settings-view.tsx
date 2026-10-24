/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { levelFromRms, rms } from "@/app/lib/voice-core";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "@/react-app/domains/settings/settings-layout";
import { defaultHotkey, formatHotkey, hotkeyFromEvent } from "./hotkey";
import { MicrophoneSource, listMicrophones, microphoneSettingsUrl, openMicrophoneSettings, releaseMicrophone, type MicrophoneDevice } from "./mic-source";
import type { VoiceClient } from "./use-voice-dictation";
import { useVoiceStatus } from "./voice-status";
import { VOICE_LANGUAGES, useVoiceSettings, voicePrivacyNote, type VoiceMode } from "./voice-settings";
import { t } from "@/i18n";

const voiceModes = (): ReadonlyArray<{ value: VoiceMode; label: string }> => [
  { value: "both", label: t("voice.mode_both") },
  { value: "hold", label: t("voice.mode_hold") },
  { value: "tap", label: t("voice.mode_tap") },
];
const SYSTEM_DEFAULT = "system-default";

function MicTest(props: { deviceId: string | null }) {
  const [level, setLevel] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<MicrophoneSource | null>(null);
  const stop = () => {
    sourceRef.current?.stop();
    sourceRef.current = null;
    setLevel(null);
  };
  useEffect(() => stop, []);
  const start = async () => {
    setError(null);
    const source = new MicrophoneSource(props.deviceId);
    sourceRef.current = source;
    try {
      // Levels only: the test audio is measured in memory and dropped.
      await source.start((frames) => setLevel(levelFromRms(rms(frames))));
      setTimeout(() => {
        if (sourceRef.current === source) stop();
      }, 6_000);
    } catch (caught) {
      sourceRef.current = null;
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 w-32 overflow-hidden rounded-full bg-gray-4" aria-label={t("voice.mic_level")} data-testid="voice-settings-meter">
        <div className="h-full rounded-full bg-green-9 transition-[width] duration-75" style={{ width: `${Math.round((level ?? 0) * 100)}%` }} />
      </div>
      <Button variant="outline" size="sm" onClick={() => (level === null ? void start() : stop())}>
        {level === null ? t("voice.test") : t("composer.stop")}
      </Button>
      {error ? <span className="text-xs text-red-11">{error}</span> : null}
    </div>
  );
}

export function VoiceSettingsView(props: { client: VoiceClient | null }) {
  const settings = useVoiceSettings();
  const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
  const [recording, setRecording] = useState(false);
  const status = useVoiceStatus(props.client, null);

  useEffect(() => {
    void listMicrophones().then(setDevices);
    const refresh = () => void listMicrophones().then(setDevices);
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        return;
      }
      const value = hotkeyFromEvent(event);
      if (!value) return;
      settings.update({ hotkey: value });
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, settings]);

  const hotkey = settings.hotkey ?? defaultHotkey();
  const availability = !props.client
    ? null
    : status && !status.signedIn
      ? t("voice.sign_in_required")
      : status?.available === false
        ? t("voice.not_available")
        : null;
  const deviceKnown = settings.deviceId === null || devices.some((device) => device.deviceId === settings.deviceId);

  return (
    <LayoutStack>
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("voice.title")}</LayoutSectionTitle>
          <LayoutSectionDescription>
            {t("voice.desc")}
          </LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("voice.dictation")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {availability ?? t("voice.dictation_desc")}
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label="Dictation"
                data-testid="voice-settings-enabled"
                checked={settings.enabled}
                onCheckedChange={(enabled) => {
                  settings.update({ enabled });
                  if (!enabled) releaseMicrophone();
                }}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("voice.hotkey")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("voice.hotkey_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" data-testid="voice-settings-hotkey" onClick={() => setRecording(true)}>
                  {recording ? t("voice.press_shortcut") : formatHotkey(hotkey)}
                </Button>
                {settings.hotkey ? (
                  <Button variant="ghost" size="sm" onClick={() => settings.update({ hotkey: null })}>
                    Reset
                  </Button>
                ) : null}
              </div>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("voice.mode_both")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {t("voice.mode_desc")}
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <div className="w-56 max-w-full">
                <Select value={settings.mode} items={voiceModes()} onValueChange={(value) => value && settings.update({ mode: value })}>
                  <SelectTrigger className="w-full" aria-label={t("voice.mode_both")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {voiceModes().map((mode) => (
                        <SelectItem key={mode.value} value={mode.value}>{mode.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("voice.input_device")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {deviceKnown ? t("voice.input_device_desc") : t("voice.input_device_missing")}
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <div className="flex flex-wrap items-center gap-3">
                <div className="w-56 max-w-full">
                  <Select
                    value={settings.deviceId ?? SYSTEM_DEFAULT}
                    items={[{ value: SYSTEM_DEFAULT, label: t("voice.system_default") }, ...devices.map((device) => ({ value: device.deviceId, label: device.label }))]}
                    onValueChange={(value) => {
                      settings.update({ deviceId: !value || value === SYSTEM_DEFAULT ? null : value });
                      releaseMicrophone();
                    }}
                  >
                    <SelectTrigger className="w-full" aria-label={t("voice.input_device")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={SYSTEM_DEFAULT}>{t("voice.system_default")}</SelectItem>
                        {devices.map((device) => (
                          <SelectItem key={device.deviceId} value={device.deviceId}>{device.label}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <MicTest deviceId={deviceKnown ? settings.deviceId : null} />
              </div>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.language")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("voice.language_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <div className="w-56 max-w-full">
                <Select value={settings.language} items={VOICE_LANGUAGES.map((language) => (language.value === "auto" ? { ...language, label: t("voice.detect_automatically") } : language))} onValueChange={(value) => value && settings.update({ language: value })}>
                  <SelectTrigger className="w-full" aria-label={t("voice.dictation_language")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {VOICE_LANGUAGES.map((language) => (
                        <SelectItem key={language.value} value={language.value}>{language.value === "auto" ? t("voice.detect_automatically") : language.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("voice.auto_send")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("voice.auto_send_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch aria-label={t("voice.auto_send")} checked={settings.autoSend} onCheckedChange={(autoSend) => settings.update({ autoSend })} />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>

      <Separator />

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("voice.privacy")}</LayoutSectionTitle>
          <LayoutSectionDescription data-testid="voice-privacy-note">{voicePrivacyNote(status?.providerRetentionDays)}</LayoutSectionDescription>
        </LayoutSectionHeader>
        {microphoneSettingsUrl() ? <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("voice.mic_permission")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("voice.mic_permission_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Button variant="outline" size="sm" onClick={() => void openMicrophoneSettings()}>
                {t("voice.open_privacy")}
              </Button>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem> : null}
      </LayoutSection>
    </LayoutStack>
  );
}
