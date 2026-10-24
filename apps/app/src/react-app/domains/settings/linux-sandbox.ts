import { useCallback, useEffect, useRef, useState } from "react";

import { captureAnalyticsEvent, type AnalyticsProperties } from "@/app/lib/analytics";
import type { OmniRushServerClient, OmniRushWorkspaceBox, OmniRushWorkspaceBoxProgress, OmniRushWorkspaceBoxSetupAction } from "@/app/lib/omnirush-server";
import { t } from "@/i18n";

export type LinuxSandboxClient = Pick<OmniRushServerClient, "getWorkspaceBox" | "setWorkspaceBox" | "setWorkspaceBoxBackend" | "resetWorkspaceBox" | "retryWorkspaceBox"> & Partial<Pick<OmniRushServerClient, "setupWorkspaceBox">>;

export const LINUX_SANDBOX_HELP = "Commands run in a Linux container for this project. Your files stay in this folder; installs are kept per project.";

/** What the user can do next when no sandbox backend works here: one step, with a command to copy when there is one. */
export type LinuxSandboxNextStep = { title: string; detail: string; command: string | null };

/** Everything the status row shows. `tone` picks its icon and colour. */
export type LinuxSandboxView = {
  tone: "off" | "busy" | "ready" | "attention" | "error";
  title: string;
  detail: string | null;
  /** A bar while the image downloads: `value` 0–100, null when the size is not known yet. */
  progress: { value: number | null; label: string } | null;
  step: LinuxSandboxNextStep | null;
  /** The row's button: try again, look again, or switch the backend back to automatic. */
  action: { kind: "retry" | "check" | "auto-backend"; label: string } | null;
  /** The raw error, behind "Show details". */
  errorDetail: string | null;
};

/** A change the user made that the server has not answered yet (the switch already shows it). */
export type LinuxSandboxPending = "on" | "off" | "backend" | "reset" | "retry" | "setup" | null;

const LOAD_FAILED = "The sandbox status could not be loaded.";

function runtimeLabel(box: OmniRushWorkspaceBox): string | null {
  const backend = box.backend;
  if (backend?.id) return [backend.label ?? backend.id, backend.version].filter(Boolean).join(" ");
  if (box.runtime?.ok && box.runtime.name) return [box.runtime.name, box.runtime.version].filter(Boolean).join(" ");
  return null;
}

function megabytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb >= 100 ? `${Math.round(mb)}` : mb >= 10 ? mb.toFixed(0) : mb.toFixed(1);
}

/** The download bar: bytes when the server knows the layer sizes, else layers, else the image's rough size. */
export function linuxSandboxProgress(progress: OmniRushWorkspaceBoxProgress | null | undefined): { value: number | null; label: string } {
  if (progress?.bytesTotal && progress.bytesDone !== null) {
    const value = Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100));
    return { value, label: t("sandbox.progress_mb", { done: megabytes(progress.bytesDone), total: megabytes(progress.bytesTotal), percent: value }) };
  }
  if (progress && progress.layersTotal > 0) {
    const value = Math.min(100, Math.round((progress.layersDone / progress.layersTotal) * 100));
    return { value, label: t("sandbox.progress_parts", { done: progress.layersDone, total: progress.layersTotal, percent: value }) };
  }
  return { value: null, label: t("sandbox.download_starting") };
}

function commandIn(reason: string | null | undefined): string | null {
  return reason ? /`([^`]+)`/.exec(reason)?.[1] ?? null : null;
}

/** A short title for a reason the backend probe gave (with its command, when it names one). */
function stepFor(reason: string, platform: string | undefined): LinuxSandboxNextStep | null {
  const command = commandIn(reason);
  if (/sandbox enable/.test(reason)) return { title: t("sandbox.step_allow"), detail: t("sandbox.step_allow_detail"), command };
  if (/usermod -aG docker/.test(reason)) return { title: t("sandbox.step_docker_group"), detail: t("sandbox.step_docker_group_detail"), command };
  if (/wsl --install/.test(reason)) return { title: t("sandbox.step_wsl"), detail: t("sandbox.step_wsl_detail"), command: "wsl --install --no-distribution" };
  if (/wsl --update/.test(reason)) return { title: t("sandbox.step_wsl_update"), detail: t("sandbox.step_wsl_update_detail"), command };
  if (/podman machine start/.test(reason)) return { title: t("sandbox.step_podman"), detail: t("sandbox.step_run_terminal"), command };
  if (/apt install bubblewrap/.test(reason)) return { title: t("sandbox.step_bwrap"), detail: t("sandbox.step_run_terminal_pkg"), command };
  if (/Docker Desktop is installed but not running|Docker is installed but not running/.test(reason)) {
    return { title: t("sandbox.step_container_app"), detail: t("sandbox.step_container_app_detail"), command: null };
  }
  if (/another macOS user/.test(reason)) {
    return { title: t("sandbox.step_container_app"), detail: t("sandbox.step_container_other_account"), command: null };
  }
  if (/Docker daemon is not running/.test(reason)) return { title: t("sandbox.step_start_docker"), detail: t("sandbox.step_run_terminal"), command: "sudo systemctl start docker" };
  return null;
}

/**
 * The one next step when no backend works here: the first fix a backend's
 * probe names (in the order they are tried), else the usual setup for this
 * computer's OS.
 */
export function linuxSandboxNextStep(box: OmniRushWorkspaceBox): LinuxSandboxNextStep {
  const platform = box.platform;
  const reasons = [...(box.backend?.alternatives ?? []).map((alt) => alt.reason), box.runtime?.reason ?? null].filter((reason): reason is string => Boolean(reason));
  for (const reason of reasons) {
    const step = stepFor(reason, platform);
    if (step) return step;
  }
  if (platform === "win32") return { title: t("sandbox.step_wsl"), detail: t("sandbox.step_wsl_detail_alt"), command: "wsl --install --no-distribution" };
  if (platform === "darwin") return { title: t("sandbox.step_install_container"), detail: t("sandbox.step_install_container_detail"), command: "brew install colima docker && colima start" };
  if (platform === "linux") return { title: t("sandbox.step_install_podman"), detail: t("sandbox.step_run_terminal_pkg"), command: "sudo apt install podman" };
  return { title: t("sandbox.step_none"), detail: box.runtime?.reason ?? t("sandbox.step_none_detail"), command: null };
}

/** A ready box's detail, then one line per server in it open on this computer (Docker/Podman boxes). */
function withPorts(detail: string, box: OmniRushWorkspaceBox): string {
  const lines = (box.ports ?? []).slice(0, 3).map((item) => item.line);
  return lines.length ? [detail, ...lines].join(" ") : detail;
}

/** The status row: what the sandbox is doing now, or why it is not used and what to do. */
export function linuxSandboxView(box: OmniRushWorkspaceBox, pending: LinuxSandboxPending = null): LinuxSandboxView {
  const base = { progress: null, step: null, action: null, errorDetail: null };
  if (pending === "on") return { ...base, tone: "busy", title: t("sandbox.turning_on"), detail: t("sandbox.runs_here_until_ready") };
  if (pending === "off") return { ...base, tone: "busy", title: t("sandbox.turning_off"), detail: null };
  if (pending === "reset") return { ...base, tone: "busy", title: t("sandbox.resetting"), detail: t("sandbox.resetting_detail") };
  if (pending === "retry") return { ...base, tone: "busy", title: t("sandbox.trying_again"), detail: null };
  if (pending === "setup") return { ...base, tone: "busy", title: t("sandbox.setting_up"), detail: null };
  if (!box.on) {
    if (box.source === "env") return { ...base, tone: "off", title: t("sandbox.off_for_app"), detail: t("sandbox.off_for_app_detail") };
    // Required, but the project only builds on this OS: its chats run here.
    if (box.source === "host-only" && box.hostOnly) return { ...base, tone: "attention", title: t("sandbox.runs_on_computer"), detail: box.hostOnly.notice };
    if (box.hostBuilds?.native) return { ...base, tone: "attention", title: t("sandbox.off_for_project"), detail: box.hostBuilds.notice };
    // A buildathon project: turned off here (less reproducible), or the event offers the sandbox.
    if (box.notice) return { ...base, tone: "attention", title: box.source === "project" ? t("sandbox.off_for_project") : t("common.off"), detail: box.notice };
    return { ...base, tone: "off", title: t("common.off"), detail: t("sandbox.runs_here") };
  }
  const using = runtimeLabel(box);
  switch (box.state) {
    case "downloading":
      return { ...base, tone: "busy", title: t("sandbox.downloading"), detail: t("sandbox.runs_here_until_it_ready"), progress: linuxSandboxProgress(box.progress) };
    case "starting":
      return { ...base, tone: "busy", title: t("sandbox.starting"), detail: using ? t("sandbox.starting_using", { backend: using }) : t("sandbox.starting_detail") };
    case "ready":
      // On by choice in a folder with this computer's builds: the warning; on macOS / Windows: that chats run in Linux.
      if (box.hostBuilds && !box.hostBuilds.native) return { ...base, tone: "attention", title: t("connect.diagnostics_connection_ready"), detail: withPorts(box.hostBuilds.notice, box) };
      return { ...base, tone: "ready", title: t("connect.diagnostics_connection_ready"), detail: withPorts(box.boxNotice ?? (using ? t("sandbox.runs_in_container_using", { backend: using }) : t("sandbox.runs_in_container")), box) };
    case "failed":
      return { ...base, tone: "error", title: t("sandbox.could_not_start"), detail: t("sandbox.runs_here_for_now"), action: { kind: "retry", label: t("sandbox.try_again") }, errorDetail: box.error ?? box.notice };
    case "unavailable": {
      if (box.backendSetting.value === "native") {
        return { ...base, tone: "attention", title: t("sandbox.backend_off"), detail: t("sandbox.backend_off_detail"), action: { kind: "auto-backend", label: t("sandbox.use_automatic") } };
      }
      if (box.runtime?.ok) {
        // A backend works, but this project went on without the box (its helpers, a start that timed out).
        return { ...base, tone: "attention", title: t("sandbox.not_running"), detail: t("sandbox.runs_here_for_now"), action: { kind: "retry", label: t("sandbox.try_again") }, errorDetail: box.notice?.replace(/^Sandbox off for now: /, "").replace(/\.$/, "") ?? box.error };
      }
      const step = linuxSandboxNextStep(box);
      return { ...base, tone: "attention", title: step.title, detail: t("sandbox.runs_here_for_now"), step, action: { kind: "check", label: t("sandbox.check_again") }, errorDetail: box.runtime?.reason ?? null };
    }
    case "off":
      return { ...base, tone: "off", title: t("common.off"), detail: box.notice ?? t("sandbox.runs_here") };
  }
}

/** The backend in use and how it was picked, for the Advanced section. */
export function linuxSandboxBackendSummary(box: OmniRushWorkspaceBox): string {
  if (box.backendSetting.value === "native") return t("sandbox.backend_summary_off");
  const using = runtimeLabel(box);
  if (!using) return t("sandbox.backend_summary_none");
  if (box.backendSetting.source === "env") return t("sandbox.backend_summary_env", { backend: using });
  return box.backendSetting.value === "auto" ? t("sandbox.backend_summary_auto", { backend: using }) : t("sandbox.backend_summary_using", { backend: using });
}

/** The backend choices for the picker: "Automatic (recommended)" first. */
export function linuxSandboxBackendChoices(box: OmniRushWorkspaceBox): Array<{ value: string; label: string }> {
  return box.backendSetting.choices.map((choice) => ({ value: choice.id, label: choice.id === "auto" ? t("sandbox.automatic_recommended") : choice.label }));
}

/** States that change on their own: asked about again quickly while they last. */
const MOVING = new Set<OmniRushWorkspaceBox["state"]>(["downloading", "starting"]);
/** Poll every second while the sandbox moves, slower after a minute (a long download). */
const FAST_POLL_MS = 1_000;
const SLOW_POLL_MS = 3_000;
const FAST_FOR_MS = 60_000;

export function linuxSandboxMoving(box: OmniRushWorkspaceBox | null): boolean {
  return Boolean(box?.on && MOVING.has(box.state));
}

/**
 * Why commands of a project with the sandbox on run on this computer instead
 * (the sandbox fell back to the host), for the `sandbox_fallback` event:
 * coarse labels only (the backend id, never paths or errors). Null while the
 * sandbox runs, moves, or is off by choice.
 */
export function sandboxFallbackProperties(box: OmniRushWorkspaceBox | null): AnalyticsProperties | null {
  if (!box?.on) return null;
  let reason: string | null = null;
  if (box.state === "failed") reason = "start_failed";
  else if (box.state === "unavailable" && box.backendSetting.value !== "native") reason = box.runtime?.ok ? "not_running" : "no_backend";
  if (!reason) return null;
  return {
    reason,
    sandbox_mode: box.mode ?? "default",
    backend: box.backend?.id ?? null,
    backend_setting: box.backendSetting.value === "auto" ? "auto" : "fixed",
  };
}

const fallbackReported = new Set<string>();

/** One `sandbox_fallback` per project and reason while the app runs. */
export function reportSandboxFallback(workspaceId: string | null, box: OmniRushWorkspaceBox | null): boolean {
  const properties = sandboxFallbackProperties(box);
  if (!workspaceId || !properties) return false;
  const key = `${workspaceId}:${properties.reason}`;
  if (fallbackReported.has(key)) return false;
  fallbackReported.add(key);
  captureAnalyticsEvent("sandbox_fallback", properties);
  return true;
}

export type LinuxSandboxProblem = { message: string; retry: (() => void) | null };

/**
 * The selected workspace's sandbox: its status (asked again every second
 * while it moves, and when the window comes back), the switch (shown at
 * once, before the server answers), the backend, Retry and Reset.
 */
export function useLinuxSandbox(client: LinuxSandboxClient | null, workspaceId: string | null, { fresh: freshOnOpen = true, sessionId = null }: { fresh?: boolean; sessionId?: string | null } = {}) {
  const [box, setBox] = useState<OmniRushWorkspaceBox | null>(null);
  const [pending, setPending] = useState<LinuxSandboxPending>(null);
  const [problem, setProblem] = useState<LinuxSandboxProblem | null>(null);
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const movingSince = useRef<number | null>(null);
  // The project the shown status was read for (the fallback event names only that one).
  const boxFor = useRef<string | null>(null);

  const load = useCallback(async (fresh = false) => {
    if (!client || !workspaceId) return;
    const startedAt = sequence.current;
    const value = await client.getWorkspaceBox(workspaceId, sessionId ? { fresh, sessionId } : { fresh }).catch(() => null);
    if (sequence.current !== startedAt) return;
    if (value) {
      boxFor.current = workspaceId;
      setBox(value);
      setProblem((current) => (current?.message === LOAD_FAILED ? null : current));
    } else {
      setProblem({ message: LOAD_FAILED, retry: () => void load(true) });
    }
  }, [client, workspaceId, sessionId]);

  // Another project: start from nothing. The same project with a new client (the engine
  // reloaded after the switch): keep what is shown and ask again, so nothing flickers.
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (shownFor.current !== workspaceId) {
      shownFor.current = workspaceId;
      sequence.current += 1;
      setBox(null);
      setPending(null);
      setProblem(null);
      setNotice("");
    }
    void load(freshOnOpen);
  }, [load, freshOnOpen, workspaceId]);

  useEffect(() => {
    if (boxFor.current === workspaceId) reportSandboxFallback(workspaceId, box);
  }, [box, workspaceId]);

  // While it moves: every second for a minute, then every 3 s.
  const moving = linuxSandboxMoving(box);
  useEffect(() => {
    if (!moving) {
      movingSince.current = null;
      return;
    }
    movingSince.current ??= Date.now();
    const delay = Date.now() - movingSince.current < FAST_FOR_MS ? FAST_POLL_MS : SLOW_POLL_MS;
    const timer = setTimeout(() => void load(), delay);
    return () => clearTimeout(timer);
  }, [box, moving, load]);

  // Back to the window (a runtime started or installed meanwhile): look again.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible" && !pending) void load(freshOnOpen);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [freshOnOpen, load, pending]);

  /** One change at a time; an answer to an older request never overwrites a newer one. */
  const change = useCallback(async (kind: Exclude<LinuxSandboxPending, null>, act: () => Promise<OmniRushWorkspaceBox | null>, failure: string, again: () => void) => {
    if (!client || !workspaceId || pending) return;
    sequence.current += 1;
    const startedAt = sequence.current;
    setPending(kind);
    setProblem(null);
    setNotice("");
    try {
      const result = await act();
      if (sequence.current !== startedAt) return;
      if (result) {
        boxFor.current = workspaceId;
        setBox(result);
      }
    } catch {
      if (sequence.current !== startedAt) return;
      setProblem({ message: failure, retry: again });
    } finally {
      if (sequence.current === startedAt) setPending(null);
    }
  }, [client, pending, workspaceId]);

  const setEnabled = useCallback((enabled: boolean) => {
    if (!client || !workspaceId) return Promise.resolve();
    return change(enabled ? "on" : "off", async () => {
      const result = await client.setWorkspaceBox(workspaceId, enabled ? "on" : "off");
      if (result.engine.status === "failed") setNotice("Saved. The engine did not confirm the change: use Reload in Settings > Advanced.");
      return result;
    }, enabled ? "The sandbox could not be turned on." : "The sandbox could not be turned off.", () => void setEnabled(enabled));
  }, [change, client, workspaceId]);

  const setBackend = useCallback((backend: string) => {
    if (!client || !workspaceId) return Promise.resolve();
    return change("backend", () => client.setWorkspaceBoxBackend(workspaceId, backend), "The backend could not be saved.", () => void setBackend(backend));
  }, [change, client, workspaceId]);

  const retry = useCallback(() => {
    if (!client || !workspaceId) return Promise.resolve();
    return change("retry", () => client.retryWorkspaceBox(workspaceId), "The sandbox could not be asked to try again.", () => void retry());
  }, [change, client, workspaceId]);

  const reset = useCallback(() => {
    if (!client || !workspaceId) return Promise.resolve();
    return change("reset", async () => {
      const result = await client.resetWorkspaceBox(workspaceId);
      setNotice(result.removed ? "Sandbox reset. The next command starts a fresh one." : "There was no sandbox to reset.");
      return client.getWorkspaceBox(workspaceId, { fresh: true }).catch(() => null);
    }, "The sandbox could not be reset.", () => void reset());
  }, [change, client, workspaceId]);

  const refresh = useCallback(() => load(true), [load]);
  /** Look again without the full backend check (a chat's turn started or ended). */
  const reload = useCallback(() => load(false), [load]);

  /** One setup step of the setup screen (Allow, Set up, Restart now, Not now, Check again). */
  const setup = useCallback((action: OmniRushWorkspaceBoxSetupAction) => {
    if (!client?.setupWorkspaceBox || !workspaceId) return Promise.resolve();
    const run = client.setupWorkspaceBox;
    return change("setup", () => run(workspaceId, action), action === "win_restart" ? "Windows could not be restarted from here. Restart it from the Start menu." : "The setup step did not finish.", () => void setup(action));
  }, [change, client, workspaceId]);

  return { box, pending, problem, notice, setEnabled, setBackend, retry, reset, refresh, reload, setup };
}

export type LinuxSandboxState = ReturnType<typeof useLinuxSandbox>;
