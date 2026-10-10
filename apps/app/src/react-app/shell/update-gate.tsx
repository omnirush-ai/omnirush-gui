/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowUpCircle, Download, Loader2 } from "lucide-react";

import {
  connectUpdateGate,
  refreshUpdateGate,
  requiredUpdateAction,
  shouldStartBackgroundDownload,
  updateBannerText,
  updateButtonLabel,
  useUpdateGateState,
  type UpdateGateState,
} from "../../app/lib/update-gate";
import { useBrandAppName } from "../domains/cloud/brand-theme";
import { useDesktopUpdater } from "../domains/settings/state/desktop-updater-provider";
import { InstallCommand } from "./install-command";

/** Height of the app's top banners; the app below one is shifted by this much. */
export const BANNER_HEIGHT_PX = 36;
export const BANNER_CLASS = "fixed inset-x-0 top-0 z-[70] flex items-center justify-center gap-3 border-b border-amber-700/30 bg-amber-300 px-4 text-[12px] font-medium text-amber-950 mac:titlebar-drag mac:ps-20";

/** The app below a top banner: shifted beneath it (its transform also makes it the containing block of a nested banner, which stacks below this one). */
export function bannerShiftStyle(shifted: boolean): CSSProperties {
  return shifted
    ? { position: "fixed", inset: `${BANNER_HEIGHT_PX}px 0 0 0`, transform: "translateZ(0)", overflow: "hidden" }
    : { display: "contents" };
}

function useNow(active: boolean, intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

function openDownload(url: string) {
  void window.__OMNIRUSH_ELECTRON__?.shell?.openExternal?.(url);
}

/**
 * Starts the update download in the background as soon as an update is
 * required, and runs "Update now": restart into the staged update wherever
 * the app can replace itself (Linux AppImage, Windows, macOS with or without
 * a Developer ID signature), download the package and show its install
 * command for a .deb/.rpm/.pacman install, and open `download_url` only from
 * a button that says so. A failed check or download is shown and retried
 * from the button, never answered by opening a browser.
 */
function useRequiredUpdate(gate: UpdateGateState) {
  const updater = useDesktopUpdater();
  const supported = updater.updateEnv?.supported !== false && Boolean(updater.appVersion);
  const installMode = updater.installMode;
  const packageKind = updater.packageKind;
  const status = updater.updateStatus;
  const updaterState = status?.state ?? null;
  const [installRequested, setInstallRequested] = useState(false);
  const [copied, setCopied] = useState(false);
  const backgroundStarted = useRef(false);
  const downloadRequested = useRef(false);

  useEffect(() => {
    if (gate.status === "none") {
      backgroundStarted.current = false;
      downloadRequested.current = false;
      return;
    }
    if (backgroundStarted.current) return;
    if (!shouldStartBackgroundDownload({ gate, supported, installMode, updaterState })) return;
    backgroundStarted.current = true;
    // A check downloads by itself when automatic downloads are on; the
    // effect below starts the download when they are off.
    void updater.checkForUpdates();
  }, [gate, installMode, supported, updater, updaterState]);

  useEffect(() => {
    if (gate.status === "none" || installMode !== "in-place") return;
    if (updaterState === "available" && !downloadRequested.current) {
      downloadRequested.current = true;
      void updater.downloadUpdate();
    }
  }, [gate.status, installMode, updater, updaterState]);

  // After "Update now": restart once the download is ready. A failure ends
  // the request; the detail line says what went wrong and the button retries.
  const installDownloadStarted = useRef(false);
  useEffect(() => {
    if (!installRequested) return;
    const finish = (next?: () => void) => {
      setInstallRequested(false);
      installDownloadStarted.current = false;
      next?.();
    };
    if (updaterState === "ready") {
      return finish(installMode === "in-place" ? () => void updater.installUpdateAndRestart() : undefined);
    }
    if (updaterState === "available" && !installDownloadStarted.current) {
      installDownloadStarted.current = true;
      void updater.downloadUpdate();
      return;
    }
    if (updaterState === "error" || updaterState === "blocked" || updaterState === "installer-opened") finish();
  }, [installMode, installRequested, updater, updaterState]);

  const action = requiredUpdateAction({ supported, installMode, updaterState, packageKind });

  const updateNow = useCallback(() => {
    switch (action) {
      case "open-download":
        openDownload(gate.downloadUrl);
        return;
      case "install":
        void updater.installUpdateAndRestart();
        return;
      case "copy-command": {
        const command = status?.installCommand;
        if (command) {
          void navigator.clipboard?.writeText(command).then(() => setCopied(true)).catch(() => undefined);
        }
        return;
      }
      case "wait":
        setInstallRequested(true);
        return;
      default:
        installDownloadStarted.current = false;
        setInstallRequested(true);
        if (updaterState === "available") {
          installDownloadStarted.current = true;
          void updater.downloadUpdate();
        } else {
          void updater.checkForUpdates();
        }
    }
  }, [action, gate.downloadUrl, status?.installCommand, updater, updaterState]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const progress = updaterState === "downloading" && status?.totalBytes
    ? Math.min(100, Math.round(((status.downloadedBytes ?? 0) / status.totalBytes) * 100))
    : null;
  const version = status?.version ?? gate.minimum;
  const label = copied
    ? "Copied"
    : updateButtonLabel({ action, version, progress, updaterState, packageKind, restarting: status?.restarting });
  const working = action === "wait" || Boolean(status?.restarting);
  const detail = updaterState === "error" && status?.message
    ? `The update did not finish: ${status.message}`
    : updaterState === "ready" && installMode === "package" && status?.installCommand
      ? "Downloaded. Run the install command in a terminal, then open the app again."
      : updaterState === "ready" && installMode === "in-place" && !status?.restarting
        ? "Downloaded. The app closes and reopens on the new version."
        : updaterState === "installer-opened"
          ? "The installer is open. Replace the app from it, then open it again."
          : null;
  const command = installMode === "package" && updaterState === "ready" ? status?.installCommand ?? null : null;
  // A restart that did not go through: offer the manual download next to the retry.
  const installFailed = updaterState === "error" && status?.failedAction === "install";
  return { updateNow, working, detail, label, command, installFailed, showDownloaded: updater.showDownloadedUpdate };
}

type RequiredUpdate = ReturnType<typeof useRequiredUpdate>;

function UpdateNowButton(props: { update: RequiredUpdate; large?: boolean; testId: string }) {
  const { update } = props;
  return (
    <button
      type="button"
      data-testid={props.testId}
      onClick={update.updateNow}
      disabled={update.working}
      className={props.large
        ? "inline-flex items-center justify-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-emerald-100 disabled:cursor-wait disabled:opacity-80 mac:titlebar-no-drag"
        : "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-black/85 px-2.5 text-[11px] font-semibold text-amber-50 transition hover:bg-black disabled:cursor-wait disabled:opacity-80 mac:titlebar-no-drag"}
    >
      {update.working ? <Loader2 className={props.large ? "size-4 animate-spin" : "size-3 animate-spin"} aria-hidden="true" /> : <Download className={props.large ? "size-4" : "size-3"} aria-hidden="true" />}
      {update.label}
    </button>
  );
}

export function RequiredUpdateBanner(props: { gate: UpdateGateState; appName: string; update: RequiredUpdate }) {
  const now = useNow(true);
  const text = updateBannerText(props.gate, props.appName, now);
  const detail = props.update.command ?? props.update.detail;
  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="update-required-banner"
      data-update-deadline={props.gate.deadline ?? undefined}
      className={BANNER_CLASS}
      style={{ height: BANNER_HEIGHT_PX }}
    >
      <ArrowUpCircle className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate" data-testid="update-required-banner-text">{text}</span>
      {detail ? <span className={props.update.command ? "hidden truncate font-mono text-amber-900/80 select-text md:inline" : "hidden truncate text-amber-900/80 md:inline"}>· {detail}</span> : null}
      <UpdateNowButton update={props.update} testId="update-required-banner-button" />
      {props.update.installFailed ? (
        <button
          type="button"
          data-testid="update-required-banner-download"
          onClick={() => openDownload(props.gate.downloadUrl)}
          className="shrink-0 text-[11px] font-semibold underline underline-offset-2 hover:text-black mac:titlebar-no-drag"
        >
          Download manually
        </button>
      ) : null}
    </div>
  );
}

export function UpdateRequiredView(props: { gate: UpdateGateState; appName: string; update: RequiredUpdate }) {
  const { gate, appName, update } = props;
  return (
    <main
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="update-required-title"
      data-testid="update-required-view"
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-[#05070c] px-6 py-12 text-white mac:titlebar-drag"
    >
      <section className="w-full max-w-xl rounded-[28px] border border-white/10 bg-white/[0.04] p-8 shadow-2xl shadow-black/40 sm:p-10">
        <div className="inline-flex rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-amber-100">
          Update required
        </div>
        <h1 id="update-required-title" className="mt-6 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
          Update {appName} to keep working
        </h1>
        <p className="mt-4 text-base leading-7 text-white/72" data-testid="update-required-message">
          {gate.message ?? `This version of ${appName} is no longer supported. Install ${gate.minimum ? `version ${gate.minimum} or newer` : "the latest version"} to keep using models.`}
        </p>
        <p className="mt-3 text-sm leading-6 text-white/55">
          Your sessions and settings stay on this computer, and sessions you already ran keep uploading in the background. After the update, open the same session and continue where you left off.
        </p>
        <div className="mt-6 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.2em] text-white/40">This version</div>
            <div className="mt-1 font-mono text-lg text-white" data-testid="update-required-current">{gate.current || "unknown"}</div>
          </div>
          <div className="rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-4">
            <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/70">Required</div>
            <div className="mt-1 font-mono text-lg text-emerald-50" data-testid="update-required-minimum">{gate.minimum ?? "latest"}</div>
          </div>
        </div>
        <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <UpdateNowButton update={update} large testId="update-required-button" />
          <button
            type="button"
            onClick={() => openDownload(gate.downloadUrl)}
            className="text-sm font-medium text-white/60 underline-offset-4 hover:text-white hover:underline mac:titlebar-no-drag"
          >
            Open the download page instead
          </button>
        </div>
        {update.command ? <InstallCommand command={update.command} onShowFile={update.showDownloaded} /> : null}
        {update.detail ? <p className="mt-4 text-sm text-white/60" data-testid="update-required-detail">{update.detail}</p> : null}
      </section>
    </main>
  );
}

/**
 * Mandatory client update. Required: a banner that cannot be dismissed, with
 * a countdown to the deadline, above the app (shifted down beneath it).
 * Blocked: a full-screen "Update required" view over the app, which stays
 * mounted underneath; the chat input is disabled (useUpdateGateBlocked).
 * Session uploads run in the Electron main process and are not touched.
 */
export function UpdateGate({ children }: { children: ReactNode }) {
  const gate = useUpdateGateState();
  // The product name as the release names it, unless an organization brands the app.
  const brandName = useBrandAppName();
  const appName = brandName === "omnirush.ai" ? "OmniRush.ai" : brandName;
  const update = useRequiredUpdate(gate);

  useEffect(() => {
    connectUpdateGate();
  }, []);

  // client_update on /device/me is authoritative: look again when the
  // window comes back, so a gate the server lifted goes away.
  useEffect(() => {
    if (gate.status === "none") return;
    window.addEventListener("focus", refreshUpdateGate);
    return () => window.removeEventListener("focus", refreshUpdateGate);
  }, [gate.status]);

  const banner = gate.status === "required";
  return (
    <>
      {banner ? <RequiredUpdateBanner gate={gate} appName={appName} update={update} /> : null}
      <div
        data-update-gate-shifted={banner ? "" : undefined}
        style={bannerShiftStyle(banner)}
      >
        {children}
      </div>
      {gate.status === "blocked" ? <UpdateRequiredView gate={gate} appName={appName} update={update} /> : null}
    </>
  );
}
