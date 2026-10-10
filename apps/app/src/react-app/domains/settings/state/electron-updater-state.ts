/** @jsxImportSource react */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { isDenControlPlaneConfigured, type DenDesktopConfig } from "../../../../app/lib/den";
import type { UpdaterInstallMode, UpdaterPackageKind } from "../../../../app/lib/desktop";
import { useUpdateGateStore } from "../../../../app/lib/update-gate";
import {
  isAlphaChannelAllowedByDesktopConfig,
  isAlphaUpdateAllowed,
  isUpdateAllowed,
  isUpdateAllowedByDesktopConfig,
  resolveAutomaticStableDesktopUpdate,
  resolveDesktopUpdateChannel,
  resolveFreshStableDesktopUpdate,
} from "../../../../app/lib/version-gate";
import type { ReleaseChannel } from "../../../../app/types";
import { isElectronRuntime, safeStringify } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { useUpdateCheckRequestStore } from "./update-check-request";

export type SettingsUpdateStatus = {
  state: "idle" | "checking" | "available" | "blocked" | "downloading" | "ready" | "installer-opened" | "error";
  lastCheckedAt?: number | null;
  version?: string;
  date?: string;
  notes?: string;
  totalBytes?: number | null;
  downloadedBytes?: number;
  message?: string;
  failedAction?: "check" | "download" | "install";
  /** "package" installs: the downloaded package and the command that installs it. */
  installerPath?: string | null;
  installCommand?: string | null;
  /** The app is quitting to install the update. */
  restarting?: boolean;
} | null;

type ElectronUpdaterBridge = NonNullable<Window["__OMNIRUSH_ELECTRON__"]>["updater"] & {
  onDownloadProgress?: (callback: (data: { transferred: number; total: number; percent: number; bytesPerSecond: number }) => void) => (() => void);
};

declare global {
  interface Window {
    __omnirushUpdaterEvalBridge?: ElectronUpdaterBridge;
  }
}

type UseElectronUpdaterStateOptions = {
  releaseChannel: ReleaseChannel;
  onReleaseChannelChange: (next: ReleaseChannel) => void;
  updateAutoCheck: boolean;
  updateAutoDownload: boolean;
  desktopConfig: DenDesktopConfig | null | undefined;
  refreshDesktopConfig: () => Promise<DenDesktopConfig>;
  setError: (message: string | null) => void;
};

export type ElectronUpdaterEnvState = {
  appVersion: string | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
  /** How the shell applies updates; null until the bridge reports it. */
  installMode: UpdaterInstallMode | null;
  /** "package" installs: which package the feed offers (null: none, e.g. a tar.gz install). */
  packageKind: UpdaterPackageKind | null;
  /**
   * Whether this distribution ships an Alpha feed. null until the bridge
   * reports it so a stored Alpha preference is not rewritten before we know.
   */
  alphaChannelSupported: boolean | null;
};

export const ELECTRON_UPDATER_UNSUPPORTED_REASON = "Electron updater bridge is unavailable.";

export function unsupportedElectronUpdaterEnvState(): ElectronUpdaterEnvState {
  return {
    appVersion: null,
    updateEnv: { supported: false, reason: ELECTRON_UPDATER_UNSUPPORTED_REASON },
    installMode: null,
    packageKind: null,
    alphaChannelSupported: null,
  };
}

/**
 * Whether a check may start the download by itself. A package lands in the
 * user's Downloads folder, so that one waits for a click.
 */
export function downloadsAutomatically(input: {
  updateAutoDownload: boolean;
  installMode: UpdaterInstallMode | null;
}): boolean {
  return input.updateAutoDownload && input.installMode !== "package";
}

export function shouldScheduleElectronUpdateAutoCheck(input: {
  updateAutoCheck: boolean;
  updateEnv: ElectronUpdaterEnvState["updateEnv"];
  autoCheckKey: string | null;
  nextAutoCheckKey: string;
}) {
  return input.updateAutoCheck &&
    input.updateEnv?.supported !== false &&
    input.autoCheckKey !== input.nextAutoCheckKey;
}

export function resolveCheckedUpdateState(input: {
  available: boolean;
  allowed: boolean;
}): "idle" | "available" | "blocked" {
  if (!input.available) return "idle";
  return input.allowed ? "available" : "blocked";
}

/**
 * A staged update stays "ready" while the feed still offers that version. A
 * newer release (or a failed check) must not be hidden behind it: the newer
 * version replaces the staged one, a failed check keeps it.
 */
export function keepsReadyUpdate(input: {
  readyVersion: string | undefined;
  checkFailed: boolean;
  available: boolean;
  latestVersion: string | null | undefined;
}): boolean {
  if (!input.readyVersion) return false;
  if (input.checkFailed) return true;
  return input.available && input.latestVersion === input.readyVersion;
}

type ElectronUpdaterEnvAction =
  | { type: "app-version"; appVersion: string | null }
  | { type: "capabilities"; installMode?: UpdaterInstallMode | null; packageKind?: UpdaterPackageKind | null; alphaChannelSupported?: boolean | null }
  | { type: "unsupported"; reason: string };

function electronUpdaterEnvReducer(
  state: ElectronUpdaterEnvState,
  action: ElectronUpdaterEnvAction,
): ElectronUpdaterEnvState {
  switch (action.type) {
    case "app-version":
      return { ...state, appVersion: action.appVersion };
    case "capabilities": {
      const installMode = action.installMode ?? state.installMode;
      const packageKind = action.packageKind !== undefined ? action.packageKind : state.packageKind;
      const alphaChannelSupported = action.alphaChannelSupported ?? state.alphaChannelSupported;
      if (
        installMode === state.installMode
        && packageKind === state.packageKind
        && alphaChannelSupported === state.alphaChannelSupported
      ) return state;
      return { ...state, installMode, packageKind, alphaChannelSupported };
    }
    case "unsupported":
      return {
        ...state,
        updateEnv: { supported: false, reason: action.reason },
      };
  }
}

const INSTALL_MODES: readonly UpdaterInstallMode[] = ["in-place", "manual-dmg", "package"];
const PACKAGE_KINDS: readonly UpdaterPackageKind[] = ["deb", "rpm", "pacman", "appimage"];

function capabilitiesFromBridge(state: {
  installMode?: UpdaterInstallMode;
  packageKind?: UpdaterPackageKind | null;
  alphaChannelSupported?: boolean;
} | null | undefined): ElectronUpdaterEnvAction {
  const installMode = state?.installMode && INSTALL_MODES.includes(state.installMode) ? state.installMode : null;
  return {
    type: "capabilities",
    installMode,
    // Only a package install reports a kind; leave it alone otherwise.
    ...(installMode === "package"
      ? { packageKind: state?.packageKind && PACKAGE_KINDS.includes(state.packageKind) ? state.packageKind : null }
      : {}),
    alphaChannelSupported: typeof state?.alphaChannelSupported === "boolean" ? state.alphaChannelSupported : null,
  };
}

// The main process gives an install 2 minutes to start; the renderer waits a
// little longer for its answer, and as long again for the app to go away.
const RESTART_ANSWER_MS = 150_000;
const RESTART_STALLED_MS = 90_000;
const RESTART_STALLED_MESSAGE =
  "The app did not restart. Quit it fully and open it again to finish the update, or download the new version from the download page.";

type InstallAndRestartResult = Awaited<ReturnType<NonNullable<ElectronUpdaterBridge["installAndRestart"]>>>;

function withRestartWatchdog(pending: Promise<InstallAndRestartResult>): Promise<InstallAndRestartResult> {
  let timer: number | undefined;
  return Promise.race([
    pending,
    new Promise<InstallAndRestartResult>((resolve) => {
      timer = window.setTimeout(
        () => resolve({ ok: false, reason: RESTART_STALLED_MESSAGE } as InstallAndRestartResult),
        RESTART_ANSWER_MS,
      );
    }),
  ]).finally(() => window.clearTimeout(timer));
}

/** Where "Open download page" goes: the server's download_url while an update is required. */
function downloadPageUrl(): string {
  return useUpdateGateStore.getState().state.downloadUrl;
}

function electronUpdaterBridge(): ElectronUpdaterBridge | null {
  if (typeof window === "undefined") return null;
  if (import.meta.env.DEV && window.__omnirushUpdaterEvalBridge) {
    return window.__omnirushUpdaterEvalBridge;
  }
  return window.__OMNIRUSH_ELECTRON__?.updater ?? null;
}

// Electron wraps every rejected ipcRenderer.invoke as
// "Error invoking remote method '<channel>': Error: <message>", sometimes
// nested when a bridge call fails inside another. Only the innermost message
// means anything to the person reading the Updates page.
const REMOTE_METHOD_ERROR_PREFIX = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;

export function stripRemoteMethodErrorPrefix(message: string): string {
  let current = message.trim();
  for (;;) {
    const next = current.replace(REMOTE_METHOD_ERROR_PREFIX, "").trim();
    if (next === current || !next) return current;
    current = next;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return stripRemoteMethodErrorPrefix(error.message);
  const serialized = safeStringify(error);
  return stripRemoteMethodErrorPrefix(serialized && serialized !== "{}" ? serialized : String(error));
}

function releaseNotesToText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && "note" in entry) {
          const note = String((entry as { note?: unknown }).note ?? "");
          return note ? [note] : [];
        }
        return [];
      })
      .join("\n\n") || undefined;
  }
  return undefined;
}

function updateProgress(event: unknown): { downloaded?: number; total?: number } | null {
  if (!event || typeof event !== "object") return null;
  const data = event as { data?: unknown };
  if (!data.data || typeof data.data !== "object") return null;
  const payload = data.data as { chunkLength?: unknown; contentLength?: unknown };
  return {
    downloaded: typeof payload.chunkLength === "number" ? payload.chunkLength : undefined,
    total: typeof payload.contentLength === "number" ? payload.contentLength : undefined,
  };
}

export function useElectronUpdaterState(options: UseElectronUpdaterStateOptions) {
  const {
    releaseChannel,
    onReleaseChannelChange,
    updateAutoCheck,
    updateAutoDownload,
    desktopConfig,
    refreshDesktopConfig,
    setError,
  } = options;
  const [updateStatus, setUpdateStatus] = useState<SettingsUpdateStatus>(null);
  const [envState, dispatchEnvState] = useReducer(electronUpdaterEnvReducer, {
    appVersion: null,
    updateEnv: isElectronRuntime()
      ? null
      : { supported: false, reason: ELECTRON_UPDATER_UNSUPPORTED_REASON },
    installMode: null,
    packageKind: null,
    alphaChannelSupported: null,
  });
  const { appVersion, updateEnv, installMode, packageKind, alphaChannelSupported } = envState;
  const installModeRef = useRef(installMode);
  installModeRef.current = installMode;
  const updateStatusRef = useRef(updateStatus);
  updateStatusRef.current = updateStatus;
  const lastAutoCheckAtRef = useRef(0);
  const autoCheckInFlightRef = useRef(false);
  const autoCheckKeyRef = useRef<string | null>(null);
  const checkRequestRef = useRef(0);
  const releaseChannelRequestRef = useRef(0);
  const availableReleaseChannelRef = useRef<ReleaseChannel | null>(null);
  const downloadedReleaseChannelRef = useRef<ReleaseChannel | null>(null);
  const desktopConfigRef = useRef(desktopConfig);
  desktopConfigRef.current = desktopConfig;
  // Until the shell reports whether this distribution ships an Alpha feed,
  // the stored preference is left alone; once it says no, Alpha collapses to
  // Stable everywhere (the public build has no Alpha feed).
  const policyReleaseChannel = alphaChannelSupported === false
    ? "stable"
    : resolveDesktopUpdateChannel(releaseChannel, desktopConfig);

  const resolvePolicyReleaseChannel = useCallback(
    async (channel: ReleaseChannel) => {
      if (channel === "alpha" && alphaChannelSupported === false) {
        return { channel: "stable" as const, desktopConfig };
      }
      if (
        channel !== "alpha" ||
        !isAlphaChannelAllowedByDesktopConfig(desktopConfig)
      ) {
        return {
          channel: resolveDesktopUpdateChannel(channel, desktopConfig),
          desktopConfig,
        };
      }

      const freshDesktopConfig = await refreshDesktopConfig();
      return {
        channel: resolveDesktopUpdateChannel(channel, freshDesktopConfig),
        desktopConfig: freshDesktopConfig,
      };
    },
    [alphaChannelSupported, desktopConfig, refreshDesktopConfig],
  );

  useEffect(() => {
    if (policyReleaseChannel !== releaseChannel) {
      onReleaseChannelChange(policyReleaseChannel);
    }
    if (isAlphaChannelAllowedByDesktopConfig(desktopConfig)) return;
    if (
      availableReleaseChannelRef.current === "alpha" ||
      downloadedReleaseChannelRef.current === "alpha"
    ) {
      availableReleaseChannelRef.current = null;
      downloadedReleaseChannelRef.current = null;
      setUpdateStatus(null);
    }
  }, [
    desktopConfig,
    onReleaseChannelChange,
    policyReleaseChannel,
    releaseChannel,
  ]);

  useEffect(() => {
    if (!isElectronRuntime()) {
      dispatchEnvState({ type: "unsupported", reason: ELECTRON_UPDATER_UNSUPPORTED_REASON });
      return;
    }
    const bridge = electronUpdaterBridge();
    if (!bridge?.getChannel) {
      dispatchEnvState({ type: "unsupported", reason: ELECTRON_UPDATER_UNSUPPORTED_REASON });
      return;
    }
    let cancelled = false;
    void bridge
      .getChannel()
      .then(async (state) => {
        if (cancelled) return;
        dispatchEnvState({ type: "app-version", appVersion: state.currentVersion ?? null });
        dispatchEnvState(capabilitiesFromBridge(state));
        // The shell already normalized an unsupported Alpha selection to
        // Stable; mirror that instead of asking it to switch again.
        const shellChannel = state.channel ?? null;
        if (shellChannel && shellChannel !== policyReleaseChannel && bridge.setChannel) {
          if (state.alphaChannelSupported === false && policyReleaseChannel === "alpha") {
            onReleaseChannelChange(shellChannel);
            return;
          }
          const nextState = await bridge.setChannel(policyReleaseChannel);
          if (cancelled) return;
          dispatchEnvState({ type: "app-version", appVersion: nextState.currentVersion ?? null });
          dispatchEnvState(capabilitiesFromBridge(nextState));
          if (nextState.channel && nextState.channel !== policyReleaseChannel) {
            onReleaseChannelChange(nextState.channel);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          dispatchEnvState({ type: "unsupported", reason: ELECTRON_UPDATER_UNSUPPORTED_REASON });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onReleaseChannelChange, policyReleaseChannel]);

  const downloadUpdate = useCallback(async (channelOverride?: ReleaseChannel) => {
    const releaseChannelRequestId = releaseChannelRequestRef.current;
    const isCurrentReleaseChannel = () =>
      releaseChannelRequestRef.current === releaseChannelRequestId;
    const bridge = electronUpdaterBridge();
    if (!bridge?.download) {
      const message = "Electron updater downloads are available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message, failedAction: "download" });
      setError(message);
      return;
    }

    const requestedReleaseChannel =
      channelOverride ??
      availableReleaseChannelRef.current ??
      releaseChannel;
    const releaseChannelResolution = await resolvePolicyReleaseChannel(
      requestedReleaseChannel,
    ).catch((error: unknown) => {
      if (isCurrentReleaseChannel()) {
        setUpdateStatus({
          state: "error",
          message: describeError(error),
          failedAction: "download",
        });
      }
      return null;
    });
    if (!releaseChannelResolution || !isCurrentReleaseChannel()) return;
    if (releaseChannelResolution.channel !== requestedReleaseChannel) {
      onReleaseChannelChange(releaseChannelResolution.channel);
      await bridge.setChannel?.(releaseChannelResolution.channel);
      if (!isCurrentReleaseChannel()) return;
      availableReleaseChannelRef.current = null;
      downloadedReleaseChannelRef.current = null;
      setUpdateStatus(null);
      return;
    }

    // Subscribe to incremental progress events from the main process so
    // the UI updates in real time instead of staying stuck at 0 bytes.
    let unsubProgress: (() => void) | null = null;
    if (bridge.onDownloadProgress) {
      unsubProgress = bridge.onDownloadProgress((data) => {
        if (!isCurrentReleaseChannel()) return;
        setUpdateStatus((current) => ({
          ...(current ?? {}),
          state: "downloading",
          downloadedBytes: data.transferred ?? 0,
          totalBytes: data.total ?? current?.totalBytes ?? null,
        }));
      });
    }

    if (!isCurrentReleaseChannel()) return;
    setUpdateStatus((current) => ({
      ...(current ?? {}),
      state: "downloading",
      downloadedBytes: current?.downloadedBytes ?? 0,
      totalBytes: current?.totalBytes ?? null,
    }));
    try {
      const result = await bridge.download();
      if (!isCurrentReleaseChannel()) return;
      if (!result?.ok) {
        setUpdateStatus({
          state: "error",
          message: result?.reason ? stripRemoteMethodErrorPrefix(result.reason) : "Update download failed.",
          failedAction: "download",
        });
        return;
      }
      dispatchEnvState(capabilitiesFromBridge({ installMode: result.mode, packageKind: result.packageKind }));
      if (
        releaseChannelResolution.channel === "alpha" &&
        !isAlphaChannelAllowedByDesktopConfig(desktopConfigRef.current)
      ) {
        onReleaseChannelChange("stable");
        await bridge.setChannel?.("stable");
        availableReleaseChannelRef.current = null;
        downloadedReleaseChannelRef.current = null;
        setUpdateStatus(null);
        return;
      }
      availableReleaseChannelRef.current = null;
      downloadedReleaseChannelRef.current = releaseChannelResolution.channel;
      setUpdateStatus((current) => ({
        ...(current ?? {}),
        state: "ready",
        installerPath: result.mode === "package" ? result.path ?? null : null,
        installCommand: result.mode === "package" ? result.command ?? null : null,
      }));
    } catch (error) {
      if (!isCurrentReleaseChannel()) return;
      setUpdateStatus({
        state: "error",
        message: describeError(error),
        failedAction: "download",
      });
    } finally {
      unsubProgress?.();
    }
  }, [
    onReleaseChannelChange,
    releaseChannel,
    resolvePolicyReleaseChannel,
    setError,
  ]);

  const runCheckForUpdates = useCallback(async (
    channelOverride?: ReleaseChannel,
    manual = false,
  ) => {
    if (!isElectronRuntime()) return;
    const requestId = checkRequestRef.current + 1;
    checkRequestRef.current = requestId;
    const isCurrentRequest = () => checkRequestRef.current === requestId;
    const requestedReleaseChannel = channelOverride ?? releaseChannel;
    const bridge = electronUpdaterBridge();
    if (!bridge?.check) {
      const message = "Electron update checks are available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message, failedAction: "check" });
      setError(message);
      return;
    }

    // Keep a staged update on screen while the feed is re-checked; the check
    // replaces it only when a newer release is published.
    const current = updateStatusRef.current;
    const readyVersion = current?.state === "ready" ? current.version : undefined;
    const keepReady = (checkFailed: boolean, result?: { available: boolean; latestVersion?: string | null }) =>
      keepsReadyUpdate({
        readyVersion,
        checkFailed,
        available: result?.available ?? false,
        latestVersion: result?.latestVersion,
      });
    if (!readyVersion) setUpdateStatus({ state: "checking" });
    try {
      let targetVersion: string | undefined;
      const releaseChannelResolution = await resolvePolicyReleaseChannel(
        requestedReleaseChannel,
      );
      if (!isCurrentRequest()) return;
      const activeReleaseChannel = releaseChannelResolution.channel;
      const freshDesktopConfig = releaseChannelResolution.desktopConfig;
      if (activeReleaseChannel !== requestedReleaseChannel) {
        onReleaseChannelChange(activeReleaseChannel);
        await bridge.setChannel?.(activeReleaseChannel);
        if (!isCurrentRequest()) return;
      }
      // Den's release inventory only exists when a control plane is
      // configured. omnirush.ai ships without one: the GitHub feed the shell
      // reads is then the only authority, and no other host is contacted.
      if (manual && activeReleaseChannel === "stable" && isDenControlPlaneConfigured()) {
        const channelState = await bridge.getChannel?.();
        if (!isCurrentRequest()) return;
        dispatchEnvState(capabilitiesFromBridge(channelState));
        const currentVersion = channelState?.currentVersion ?? appVersion;
        if (!currentVersion) {
          throw new Error("Could not determine the installed omnirush.ai version.");
        }

        const selection = await resolveFreshStableDesktopUpdate({
          currentVersion,
          refreshDesktopConfig,
        });
        if (!isCurrentRequest()) return;
        if (!selection) {
          throw new Error("Den returned an invalid desktop release inventory.");
        }
        if (selection.kind === "blocked") {
          setUpdateStatus({
            state: "blocked",
            lastCheckedAt: Date.now(),
            version: selection.latestPublishedVersion,
            message: t("settings.update_blocked_org", undefined, {
              version: selection.latestPublishedVersion,
            }),
          });
          return;
        }
        if (selection.kind === "current") {
          setUpdateStatus({
            state: "idle",
            lastCheckedAt: Date.now(),
            version: selection.latestPublishedVersion,
          });
          return;
        }
        targetVersion = selection.targetVersion;
      }

      let result = await bridge.check(activeReleaseChannel, targetVersion);
      if (!isCurrentRequest()) return;
      dispatchEnvState({ type: "app-version", appVersion: result.currentVersion ?? null });
      dispatchEnvState(capabilitiesFromBridge(result));
      let checkedReleaseChannel = result.channel ?? activeReleaseChannel;
      if (
        !result.reason &&
        !manual &&
        checkedReleaseChannel === "stable" &&
        result.available &&
        result.latestVersion &&
        !targetVersion &&
        !isUpdateAllowedByDesktopConfig(result.latestVersion, freshDesktopConfig)
      ) {
        const currentVersion = result.currentVersion ?? appVersion;
        const fallbackTargetVersion = currentVersion
          ? await resolveAutomaticStableDesktopUpdate({
              currentVersion,
              latestVersion: result.latestVersion,
              desktopConfig: freshDesktopConfig,
            })
          : null;
        if (!isCurrentRequest()) return;
        if (fallbackTargetVersion) {
          targetVersion = fallbackTargetVersion;
          result = await bridge.check(checkedReleaseChannel, targetVersion);
          if (!isCurrentRequest()) return;
          dispatchEnvState({ type: "app-version", appVersion: result.currentVersion ?? null });
          checkedReleaseChannel = result.channel ?? checkedReleaseChannel;
        }
      }
      if (result.reason === "unavailable") {
        setUpdateStatus({
          state: "idle",
          message: "Auto-updates are available in packaged builds only.",
        });
        return;
      }
      if (keepReady(Boolean(result.reason), result)) return;
      if (result.reason) {
        setUpdateStatus({
          state: "error",
          message: stripRemoteMethodErrorPrefix(result.reason),
          failedAction: "check",
        });
        return;
      }
      const latestDesktopConfig = checkedReleaseChannel === "alpha"
        ? desktopConfigRef.current
        : freshDesktopConfig;
      const availableAllowed = result.available && result.latestVersion
        ? targetVersion
          ? result.latestVersion === targetVersion
          : checkedReleaseChannel === "alpha"
            ? await isAlphaUpdateAllowed(
                result.latestVersion,
                latestDesktopConfig,
                result.currentVersion ?? appVersion,
              )
            : await isUpdateAllowed(result.latestVersion, latestDesktopConfig)
        : result.available;
      if (!isCurrentRequest()) return;
      if (readyVersion && result.available && !availableAllowed && checkedReleaseChannel === "stable") {
        // Policy blocks the newer release: pin the shell to the staged version
        // so installing it does not jump past what the organization allows.
        await bridge.check(checkedReleaseChannel, readyVersion);
        return;
      }
      const checkedUpdateState = resolveCheckedUpdateState({
        available: result.available,
        allowed: Boolean(availableAllowed),
      });
      const nextStatus: Exclude<SettingsUpdateStatus, null> = {
        state: checkedUpdateState,
        lastCheckedAt: Date.now(),
        version: result.latestVersion ?? undefined,
        date: result.releaseDate ?? undefined,
        notes: releaseNotesToText(result.releaseNotes),
        ...(checkedUpdateState === "blocked"
          ? {
              message: t("settings.update_blocked_policy", undefined, {
                version: result.latestVersion ?? "",
              }),
            }
          : {}),
      };
      availableReleaseChannelRef.current = availableAllowed
        ? checkedReleaseChannel
        : null;
      downloadedReleaseChannelRef.current = null;
      setUpdateStatus(nextStatus);
      if (availableAllowed && downloadsAutomatically({ updateAutoDownload, installMode: result.installMode ?? installModeRef.current })) {
        await downloadUpdate(checkedReleaseChannel);
      }
    } catch (error) {
      if (!isCurrentRequest()) return;
      if (keepReady(true)) return;
      setUpdateStatus({
        state: "error",
        message: describeError(error),
        failedAction: "check",
      });
    }
  }, [appVersion, downloadUpdate, onReleaseChannelChange, refreshDesktopConfig, releaseChannel, resolvePolicyReleaseChannel, setError, updateAutoDownload]);

  const checkForUpdates = useCallback(
    (channelOverride?: ReleaseChannel) => {
      const state = updateStatusRef.current?.state;
      if (!channelOverride && state === "downloading") return Promise.resolve();
      return runCheckForUpdates(channelOverride, true);
    },
    [runCheckForUpdates],
  );

  useEffect(() => {
    if (!updateAutoCheck || updateEnv?.supported === false || !appVersion) return;
    const key = `${policyReleaseChannel}:${appVersion}`;
    const interval = 15 * 60 * 1000;
    const check = () => {
      const state = updateStatusRef.current?.state;
      // A "ready" update keeps being re-checked so a newer release replaces it.
      if (autoCheckInFlightRef.current || state === "checking" || state === "downloading") return;
      if (autoCheckKeyRef.current === key && Date.now() - lastAutoCheckAtRef.current < interval) return;
      autoCheckKeyRef.current = key;
      lastAutoCheckAtRef.current = Date.now();
      autoCheckInFlightRef.current = true;
      void runCheckForUpdates(undefined, false).finally(() => {
        autoCheckInFlightRef.current = false;
      });
    };
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    check();
    const timer = window.setInterval(check, interval);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [appVersion, policyReleaseChannel, runCheckForUpdates, updateAutoCheck, updateEnv?.supported]);

  // Run a check when the native "Check for Updates..." menu item was used.
  const updateCheckRequestedAt = useUpdateCheckRequestStore((state) => state.requestedAt);
  useEffect(() => {
    if (updateCheckRequestedAt == null || updateEnv?.supported === false) return;
    useUpdateCheckRequestStore.getState().clearUpdateCheckRequest();
    void checkForUpdates();
  }, [checkForUpdates, updateCheckRequestedAt, updateEnv?.supported]);

  const installUpdateAndRestart = useCallback(async () => {
    const releaseChannelRequestId = releaseChannelRequestRef.current;
    const isCurrentReleaseChannel = () =>
      releaseChannelRequestRef.current === releaseChannelRequestId;
    const bridge = electronUpdaterBridge();
    if (!bridge?.installAndRestart) {
      const message = "Electron update install is available only in the Electron desktop app.";
      setUpdateStatus({ state: "error", message, failedAction: "install" });
      setError(message);
      return;
    }
    try {
      if (downloadedReleaseChannelRef.current === "alpha") {
        const releaseChannelResolution = await resolvePolicyReleaseChannel("alpha");
        if (!isCurrentReleaseChannel()) return;
        if (releaseChannelResolution.channel !== "alpha") {
          onReleaseChannelChange(releaseChannelResolution.channel);
          await bridge.setChannel?.(releaseChannelResolution.channel);
          if (!isCurrentReleaseChannel()) return;
          downloadedReleaseChannelRef.current = null;
          setUpdateStatus(null);
          return;
        }
      }
      // The main process answers once the install is under way (the app
      // starts quitting) or has failed, so show "Restarting…" meanwhile.
      setUpdateStatus((current) => ({ ...(current ?? {}), state: "ready", restarting: true }));
      const result = await withRestartWatchdog(bridge.installAndRestart());
      if (!isCurrentReleaseChannel()) return;
      if (!result?.ok) {
        if (result?.reason === "update-not-downloaded") {
          // The main-side staged download was invalidated; re-check so the UI
          // returns to a working stable-targeted download/install flow.
          downloadedReleaseChannelRef.current = null;
          availableReleaseChannelRef.current = null;
          await runCheckForUpdates(undefined, true);
          return;
        }
        const reason = result?.reason ? stripRemoteMethodErrorPrefix(result.reason) : "Update install failed.";
        if (result?.fallback === "move-to-applications") {
          // macOS app on the DMG or in Downloads: the message says to move it.
          setUpdateStatus((current) => ({
            ...(current ?? {}),
            state: "error",
            restarting: false,
            message: reason,
            failedAction: "install",
          }));
          return;
        }
        if (result?.fallback === "download-page") {
          // The app could not replace itself (the administrator prompt was
          // cancelled): this is the one place the download page opens, and
          // the message says so.
          void window.__OMNIRUSH_ELECTRON__?.shell?.openExternal?.(downloadPageUrl());
          setUpdateStatus((current) => ({
            ...(current ?? {}),
            state: "error",
            message: `${reason} The download page is open in your browser.`,
            failedAction: "install",
          }));
          return;
        }
        setUpdateStatus({
          state: "error",
          message: reason,
          failedAction: "install",
        });
        return;
      }
      if (result.mode === "in-place" || result.mode === "moving") {
        setUpdateStatus((current) => ({ ...(current ?? {}), state: "ready", restarting: true }));
        // The app is quitting now. Still here much later: something held it open.
        window.setTimeout(() => {
          setUpdateStatus((current) => current?.restarting
            ? { ...current, state: "error", restarting: false, message: RESTART_STALLED_MESSAGE, failedAction: "install" }
            : current);
        }, RESTART_STALLED_MS);
      } else {
        setUpdateStatus((current) => (current?.restarting ? { ...current, restarting: false } : current));
      }
      if (result.mode === "manual-dmg") {
        // The shell opened the DMG and quits shortly; leave the instructions
        // on screen instead of a stale "Ready to install" button.
        dispatchEnvState(capabilitiesFromBridge({ installMode: "manual-dmg" }));
        setUpdateStatus((current) => ({
          ...(current ?? {}),
          state: "installer-opened",
        }));
      }
    } catch (error) {
      if (!isCurrentReleaseChannel()) return;
      setUpdateStatus({
        state: "error",
        message: describeError(error),
        failedAction: "install",
      });
    }
  }, [onReleaseChannelChange, resolvePolicyReleaseChannel, runCheckForUpdates, setError]);

  const setReleaseChannel = useCallback(
    async (next: ReleaseChannel) => {
      const requestId = releaseChannelRequestRef.current + 1;
      releaseChannelRequestRef.current = requestId;
      checkRequestRef.current += 1;
      const bridge = electronUpdaterBridge();
      try {
        const releaseChannelResolution = await resolvePolicyReleaseChannel(next);
        if (releaseChannelRequestRef.current !== requestId) return;
        const allowedReleaseChannel = releaseChannelResolution.channel;
        onReleaseChannelChange(allowedReleaseChannel);
        if (!bridge?.setChannel) return;
        const state = await bridge.setChannel(allowedReleaseChannel);
        if (releaseChannelRequestRef.current !== requestId) return;
        dispatchEnvState({ type: "app-version", appVersion: state.currentVersion ?? null });
        dispatchEnvState(capabilitiesFromBridge(state));
        if (state.channel && state.channel !== allowedReleaseChannel) {
          onReleaseChannelChange(state.channel);
        }
        await checkForUpdates(state.channel ?? allowedReleaseChannel);
      } catch (error) {
        if (releaseChannelRequestRef.current !== requestId) return;
        setUpdateStatus({
          state: "error",
          message: describeError(error),
          failedAction: "check",
        });
      }
    },
    [checkForUpdates, onReleaseChannelChange, resolvePolicyReleaseChannel],
  );

  const showDownloadedUpdate = useCallback(() => {
    void electronUpdaterBridge()?.showDownloaded?.();
  }, []);

  return {
    appVersion,
    updateEnv,
    installMode,
    packageKind,
    showDownloadedUpdate,
    alphaChannelSupported: alphaChannelSupported === true,
    updateStatus,
    checkForUpdates,
    downloadUpdate,
    installUpdateAndRestart,
    setReleaseChannel,
  };
}
