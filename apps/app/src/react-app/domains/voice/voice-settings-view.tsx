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

const MODES: ReadonlyArray<{ value: VoiceMode; label: string }> = [
  { value: "both", label: "Hold or tap" },
  { value: "hold", label: "Hold to talk" },
  { value: "tap", label: "Tap to start and stop" },
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
      <div className="h-2 w-32 overflow-hidden rounded-full bg-gray-4" aria-label="Microphone level" data-testid="voice-settings-meter">
        <div className="h-full rounded-full bg-green-9 transition-[width] duration-75" style={{ width: `${Math.round((level ?? 0) * 100)}%` }} />
      </div>
      <Button variant="outline" size="sm" onClick={() => (level === null ? void start() : stop())}>
        {level === null ? "Test" : "Stop"}
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
      ? "Sign in to omnirush.ai to use voice input."
      : status?.available === false
        ? "Voice input isn't available on your account yet."
        : null;
  const deviceKnown = settings.deviceId === null || devices.some((device) => device.deviceId === settings.deviceId);

  return (
    <LayoutStack>
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>Voice input</LayoutSectionTitle>
          <LayoutSectionDescription>
            Dictate prompts instead of typing. Your words appear in the composer, where you can edit them before sending.
          </LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>Dictation</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {availability ?? "Show the microphone button in the composer and listen for the hotkey."}
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
            <LayoutSectionItemTitle>Hotkey</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>Works whenever the OmniRush.ai window is focused.</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" data-testid="voice-settings-hotkey" onClick={() => setRecording(true)}>
                  {recording ? "Press a shortcut…" : formatHotkey(hotkey)}
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
            <LayoutSectionItemTitle>Hold or tap</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              Hold the hotkey while you talk, or tap it to start and tap again to stop. Esc cancels and restores your prompt.
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <div className="w-56 max-w-full">
                <Select value={settings.mode} items={MODES} onValueChange={(value) => value && settings.update({ mode: value })}>
                  <SelectTrigger className="w-full" aria-label="Hold or tap">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {MODES.map((mode) => (
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
            <LayoutSectionItemTitle>Input device</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {deviceKnown ? "The microphone used for dictation." : "The chosen microphone is not connected; the system default is used."}
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <div className="flex flex-wrap items-center gap-3">
                <div className="w-56 max-w-full">
                  <Select
                    value={settings.deviceId ?? SYSTEM_DEFAULT}
                    items={[{ value: SYSTEM_DEFAULT, label: "System default" }, ...devices.map((device) => ({ value: device.deviceId, label: device.label }))]}
                    onValueChange={(value) => {
                      settings.update({ deviceId: !value || value === SYSTEM_DEFAULT ? null : value });
                      releaseMicrophone();
                    }}
                  >
                    <SelectTrigger className="w-full" aria-label="Input device">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value={SYSTEM_DEFAULT}>System default</SelectItem>
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
            <LayoutSectionItemTitle>Language</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>The language you speak. Automatic detection works for most people.</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <div className="w-56 max-w-full">
                <Select value={settings.language} items={VOICE_LANGUAGES} onValueChange={(value) => value && settings.update({ language: value })}>
                  <SelectTrigger className="w-full" aria-label="Dictation language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {VOICE_LANGUAGES.map((language) => (
                        <SelectItem key={language.value} value={language.value}>{language.label}</SelectItem>
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
            <LayoutSectionItemTitle>Send after dictation</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>Send the prompt as soon as you stop talking (at least three words). Off: review and edit first.</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch aria-label="Send after dictation" checked={settings.autoSend} onCheckedChange={(autoSend) => settings.update({ autoSend })} />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>

      <Separator />

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>Privacy</LayoutSectionTitle>
          <LayoutSectionDescription data-testid="voice-privacy-note">{voicePrivacyNote(status?.providerRetentionDays)}</LayoutSectionDescription>
        </LayoutSectionHeader>
        {microphoneSettingsUrl() ? <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>Microphone permission</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>If dictation says the microphone is off, allow OmniRush.ai in your system's privacy settings.</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Button variant="outline" size="sm" onClick={() => void openMicrophoneSettings()}>
                Open privacy settings
              </Button>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem> : null}
      </LayoutSection>
    </LayoutStack>
  );
}
