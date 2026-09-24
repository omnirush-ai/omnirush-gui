import { useCallback, useState } from "react";

import { omnirushServerRestart, type OmniRushServerInfo } from "../../../app/lib/desktop";
import {
  readOmniRushServerSettings,
  writeOmniRushServerSettings,
} from "../../../app/lib/omnirush-server";
import { t } from "../../../i18n";

export type RemoteAccessRestartPhase =
  | "idle"
  | "restarting"
  | "reconnecting"
  | "failed";

type UseRemoteAccessRestartOptions = {
  isEnabled: () => boolean;
  onHostInfo: (info: OmniRushServerInfo) => void;
  onSettingsChanged: () => void;
};

export function useRemoteAccessRestart(options: UseRemoteAccessRestartOptions) {
  const [phase, setPhase] = useState<RemoteAccessRestartPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    async (enabled: boolean) => {
      if (phase === "restarting" || phase === "reconnecting") return;

      const previous = readOmniRushServerSettings();
      const next = { ...previous, remoteAccessEnabled: enabled };

      setPhase("restarting");
      setError(null);
      writeOmniRushServerSettings(next);
      options.onSettingsChanged();

      try {
        const info = await omnirushServerRestart({
          reason: "remote_access_toggled",
          userInitiated: true,
          remoteAccessEnabled: enabled,
        }) as OmniRushServerInfo;
        writeOmniRushServerSettings({
          urlOverride: info.baseUrl?.trim() || undefined,
          token:
            info.ownerToken?.trim() ||
            info.clientToken?.trim() ||
            undefined,
          hostToken: info.hostToken?.trim() || undefined,
          portOverride: info.port ?? undefined,
          remoteAccessEnabled: info.remoteAccessEnabled === true,
        });
        options.onHostInfo(info);
        options.onSettingsChanged();
        setPhase("idle");
      } catch (caught) {
        writeOmniRushServerSettings(previous);
        options.onSettingsChanged();
        setError(caught instanceof Error ? caught.message : t("app.error_remote_access"));
        setPhase("failed");
      }
    },
    [options, phase],
  );

  const reset = useCallback(() => {
    if (phase === "failed") {
      setPhase("idle");
      setError(null);
    }
  }, [phase]);

  return {
    busy: phase === "restarting" || phase === "reconnecting",
    error,
    phase,
    reset,
    save,
    status: statusForPhase(phase, options.isEnabled()),
  };
}

function statusForPhase(phase: RemoteAccessRestartPhase, enabled: boolean) {
  switch (phase) {
    case "restarting":
      return "Restarting worker…";
    case "reconnecting":
      return "Reconnecting to worker…";
    case "failed":
      return enabled
        ? "Remote access may still be on. Check connection details or retry."
        : "Remote access is still off. You can retry when ready.";
    default:
      return enabled
        ? "Remote access is currently enabled."
        : "Remote access is currently disabled.";
  }
}
