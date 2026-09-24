import { useSyncExternalStore } from "react";

import { t } from "../../../i18n";
import type { StartupPreference, WorkspaceDisplay } from "../../../app/types";
import { isDesktopRuntime } from "../../../app/utils";
import {
  omnirushServerInfo,
  omnirushServerRestart,
  type OmniRushServerInfo,
} from "../../../app/lib/desktop";
import {
  getOmniRushGatewayOrigin,
  readOmniRushGatewayDenToken,
} from "../../../app/lib/gateway-runtime";
import {
  clearOmniRushServerSettings,
  createOmniRushServerClient,
  isLoopbackOmniRushServerUrl,
  normalizeOmniRushServerUrl,
  readOmniRushServerSettings,
  writeOmniRushServerSettings,
  type OmniRushAuditEntry,
  type OmniRushServerCapabilities,
  type OmniRushServerClient,
  type OmniRushServerDiagnostics,
  type OmniRushServerError,
  type OmniRushServerSettings,
  type OmniRushServerStatus,
} from "../../../app/lib/omnirush-server";

type SetStateAction<T> = T | ((current: T) => T);

type RemoteWorkspaceInput = {
  omnirushHostUrl: string;
  omnirushToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

export type OmniRushServerStoreSnapshot = {
  omnirushServerSettings: OmniRushServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  omnirushServerUrl: string;
  omnirushServerBaseUrl: string;
  omnirushServerAuth: { token?: string; hostToken?: string };
  omnirushServerClient: OmniRushServerClient | null;
  omnirushServerStatus: OmniRushServerStatus;
  omnirushServerCapabilities: OmniRushServerCapabilities | null;
  omnirushServerReady: boolean;
  omnirushServerWorkspaceReady: boolean;
  resolvedOmniRushCapabilities: OmniRushServerCapabilities | null;
  omnirushServerCanWriteSkills: boolean;
  omnirushServerCanWritePlugins: boolean;
  omnirushServerHostInfo: OmniRushServerInfo | null;
  omnirushServerDiagnostics: OmniRushServerDiagnostics | null;
  omnirushReconnectBusy: boolean;
  omnirushAuditEntries: OmniRushAuditEntry[];
  omnirushAuditStatus: "idle" | "loading" | "error";
  omnirushAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

export type OmniRushServerStore = ReturnType<typeof createOmniRushServerStore>;

type CreateOmniRushServerStoreOptions = {
  startupPreference: () => StartupPreference | null;
  documentVisible: () => boolean;
  developerMode: () => boolean;
  runtimeWorkspaceId: () => string | null;
  activeClient: () => unknown | null;
  selectedWorkspaceDisplay: () => WorkspaceDisplay;
  restartLocalServer: () => Promise<boolean>;
  createRemoteWorkspaceFlow: (input: RemoteWorkspaceInput) => Promise<boolean>;
};

type MutableState = {
  omnirushServerSettings: OmniRushServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  omnirushServerUrl: string;
  omnirushServerStatus: OmniRushServerStatus;
  omnirushServerCapabilities: OmniRushServerCapabilities | null;
  omnirushServerCheckedAt: number | null;
  omnirushServerHostInfo: OmniRushServerInfo | null;
  omnirushServerHostInfoReady: boolean;
  omnirushServerDiagnostics: OmniRushServerDiagnostics | null;
  omnirushReconnectBusy: boolean;
  omnirushAuditEntries: OmniRushAuditEntry[];
  omnirushAuditStatus: "idle" | "loading" | "error";
  omnirushAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

const applyStateAction = <T,>(current: T, next: SetStateAction<T>) =>
  typeof next === "function" ? (next as (value: T) => T)(current) : next;

function sameOmniRushServerSnapshot(
  current: OmniRushServerStoreSnapshot,
  next: OmniRushServerStoreSnapshot,
): boolean {
  return (
    current.omnirushServerSettings === next.omnirushServerSettings &&
    current.shareRemoteAccessBusy === next.shareRemoteAccessBusy &&
    current.shareRemoteAccessError === next.shareRemoteAccessError &&
    current.omnirushServerUrl === next.omnirushServerUrl &&
    current.omnirushServerBaseUrl === next.omnirushServerBaseUrl &&
    current.omnirushServerAuth.token === next.omnirushServerAuth.token &&
    current.omnirushServerAuth.hostToken === next.omnirushServerAuth.hostToken &&
    current.omnirushServerClient === next.omnirushServerClient &&
    current.omnirushServerStatus === next.omnirushServerStatus &&
    current.omnirushServerCapabilities === next.omnirushServerCapabilities &&
    current.omnirushServerReady === next.omnirushServerReady &&
    current.omnirushServerWorkspaceReady === next.omnirushServerWorkspaceReady &&
    current.resolvedOmniRushCapabilities === next.resolvedOmniRushCapabilities &&
    current.omnirushServerCanWriteSkills === next.omnirushServerCanWriteSkills &&
    current.omnirushServerCanWritePlugins === next.omnirushServerCanWritePlugins &&
    current.omnirushServerHostInfo === next.omnirushServerHostInfo &&
    current.omnirushServerDiagnostics === next.omnirushServerDiagnostics &&
    current.omnirushReconnectBusy === next.omnirushReconnectBusy &&
    current.omnirushAuditEntries === next.omnirushAuditEntries &&
    current.omnirushAuditStatus === next.omnirushAuditStatus &&
    current.omnirushAuditError === next.omnirushAuditError &&
    current.devtoolsWorkspaceId === next.devtoolsWorkspaceId
  );
}

export function createOmniRushServerStore(options: CreateOmniRushServerStoreOptions) {
  const bootStartedAt = Date.now();
  const listeners = new Set<() => void>();
  const intervals = new Map<string, number>();

  let clientCacheKey = "";
  let clientCacheValue: OmniRushServerClient | null = null;
  let started = false;
  let disposed = false;
  let healthTimeoutId: number | null = null;
  let healthBusy = false;
  let healthDelayMs = 10_000;
  let consecutiveHealthFailures = 0;
  let visibilityChangeHandler: (() => void) | null = null;
  let snapshot: OmniRushServerStoreSnapshot | undefined;

  let state: MutableState = {
    omnirushServerSettings: readOmniRushServerSettings(),
    shareRemoteAccessBusy: false,
    shareRemoteAccessError: null,
    omnirushServerUrl: "",
    omnirushServerStatus: "disconnected",
    omnirushServerCapabilities: null,
    omnirushServerCheckedAt: null,
    omnirushServerHostInfo: null,
    omnirushServerHostInfoReady: !isDesktopRuntime(),
    omnirushServerDiagnostics: null,
    omnirushReconnectBusy: false,
    omnirushAuditEntries: [],
    omnirushAuditStatus: "idle",
    omnirushAuditError: null,
    devtoolsWorkspaceId: null,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const getBaseUrl = () => {
    const gatewayOrigin = getOmniRushGatewayOrigin();
    if (gatewayOrigin) return normalizeOmniRushServerUrl(gatewayOrigin) ?? "";

    const pref = options.startupPreference();
    const hostInfo = state.omnirushServerHostInfo;
    const settingsUrl = normalizeOmniRushServerUrl(state.omnirushServerSettings.urlOverride ?? "") ?? "";

    if (pref === "local") return hostInfo?.baseUrl ?? "";
    if (pref === "server" && settingsUrl && isLoopbackOmniRushServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return hostInfo.baseUrl;
    }
    if (pref === "server") return settingsUrl;
    return hostInfo?.baseUrl ?? settingsUrl;
  };

  const getAuth = () => {
    const gatewayOrigin = getOmniRushGatewayOrigin();
    if (gatewayOrigin) {
      const token = readOmniRushGatewayDenToken().trim();
      return { token: token || undefined, hostToken: undefined };
    }

    const pref = options.startupPreference();
    const hostInfo = state.omnirushServerHostInfo;
    const settingsUrl = normalizeOmniRushServerUrl(state.omnirushServerSettings.urlOverride ?? "") ?? "";
    const settingsToken = state.omnirushServerSettings.token?.trim() ?? "";
    const settingsHostToken = state.omnirushServerSettings.hostToken?.trim() ?? "";
    const clientToken = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";

    if (pref === "local") {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    if (pref === "server" && settingsUrl && isLoopbackOmniRushServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return {
        token: clientToken || settingsToken || undefined,
        hostToken: hostToken || settingsHostToken || undefined,
      };
    }
    if (pref === "server") {
      return {
        token: settingsToken || undefined,
        hostToken: settingsUrl && isLoopbackOmniRushServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
      };
    }
    if (hostInfo?.baseUrl) {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    return {
      token: settingsToken || undefined,
      hostToken: settingsUrl && isLoopbackOmniRushServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
    };
  };

  const getClient = () => {
    const baseUrl = getBaseUrl().trim();
    if (!baseUrl) {
      clientCacheKey = "";
      clientCacheValue = null;
      return null;
    }

    const auth = getAuth();
    const key = `${baseUrl}::${auth.token ?? ""}::${auth.hostToken ?? ""}`;
    if (key !== clientCacheKey) {
      clientCacheKey = key;
      clientCacheValue = createOmniRushServerClient({
        baseUrl,
        token: auth.token,
        hostToken: auth.hostToken,
      });
    }
    return clientCacheValue;
  };

  const refreshSnapshot = (): boolean => {
    const omnirushServerBaseUrl = getBaseUrl().trim();
    const omnirushServerAuth = getAuth();
    const omnirushServerClient = getClient();
    const omnirushServerReady = state.omnirushServerStatus === "connected";
    const omnirushServerWorkspaceReady = Boolean(options.runtimeWorkspaceId());
    const resolvedOmniRushCapabilities = state.omnirushServerCapabilities;

    const pref = options.startupPreference();
    const info = state.omnirushServerHostInfo;
    const hostUrl = info?.connectUrl ?? info?.lanUrl ?? info?.mdnsUrl ?? info?.baseUrl ?? "";
    const settingsUrl = normalizeOmniRushServerUrl(state.omnirushServerSettings.urlOverride ?? "") ?? "";

    let omnirushServerUrl = hostUrl || settingsUrl;
    if (pref === "local") omnirushServerUrl = hostUrl;
    if (pref === "server") omnirushServerUrl = settingsUrl;
    state.omnirushServerUrl = omnirushServerUrl;

    const nextSnapshot: OmniRushServerStoreSnapshot = {
      omnirushServerSettings: state.omnirushServerSettings,
      shareRemoteAccessBusy: state.shareRemoteAccessBusy,
      shareRemoteAccessError: state.shareRemoteAccessError,
      omnirushServerUrl,
      omnirushServerBaseUrl,
      omnirushServerAuth,
      omnirushServerClient,
      omnirushServerStatus: state.omnirushServerStatus,
      omnirushServerCapabilities: state.omnirushServerCapabilities,
      omnirushServerReady,
      omnirushServerWorkspaceReady,
      resolvedOmniRushCapabilities,
      omnirushServerCanWriteSkills:
        omnirushServerReady &&
        (resolvedOmniRushCapabilities?.skills?.write ?? false),
      omnirushServerCanWritePlugins:
        omnirushServerReady &&
        (resolvedOmniRushCapabilities?.plugins?.write ?? false),
      omnirushServerHostInfo: state.omnirushServerHostInfo,
      omnirushServerDiagnostics: state.omnirushServerDiagnostics,
      omnirushReconnectBusy: state.omnirushReconnectBusy,
      omnirushAuditEntries: state.omnirushAuditEntries,
      omnirushAuditStatus: state.omnirushAuditStatus,
      omnirushAuditError: state.omnirushAuditError,
      devtoolsWorkspaceId: state.devtoolsWorkspaceId,
    };
    if (snapshot && sameOmniRushServerSnapshot(snapshot, nextSnapshot)) return false;
    snapshot = nextSnapshot;
    return true;
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    if (refreshSnapshot()) emitChange();
  };

  const setStateField = <K extends keyof MutableState>(key: K, value: MutableState[K]) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const setOmniRushServerSettings = (next: SetStateAction<OmniRushServerSettings>) => {
    const resolved = applyStateAction(state.omnirushServerSettings, next);
    mutateState((current) => ({ ...current, omnirushServerSettings: resolved }));
    queueHealthCheck(0);
  };

  const updateOmniRushServerSettings = (next: OmniRushServerSettings) => {
    const stored = writeOmniRushServerSettings(next);
    mutateState((current) => ({ ...current, omnirushServerSettings: stored }));
    queueHealthCheck(0);
  };

  const resetOmniRushServerSettings = () => {
    clearOmniRushServerSettings();
    mutateState((current) => ({ ...current, omnirushServerSettings: {} }));
    queueHealthCheck(0);
  };

  const shouldWaitForLocalHostInfo = () =>
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    !state.omnirushServerHostInfoReady;

  const shouldRetryStartupCheck = (status: OmniRushServerStatus) =>
    status !== "connected" &&
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    Date.now() - bootStartedAt < 5_000;

  const checkOmniRushServer = async (url: string, token?: string, hostToken?: string) => {
    const client = createOmniRushServerClient({ baseUrl: url, token, hostToken });
    try {
      await client.health();
    } catch (error) {
      const resolved = error as OmniRushServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as OmniRushServerStatus, capabilities: null };
      }
      return { status: "disconnected" as OmniRushServerStatus, capabilities: null };
    }

    if (!token) {
      return { status: "limited" as OmniRushServerStatus, capabilities: null };
    }

    try {
      const capabilities = await client.capabilities();
      return { status: "connected" as OmniRushServerStatus, capabilities };
    } catch (error) {
      const resolved = error as OmniRushServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as OmniRushServerStatus, capabilities: null };
      }
      return { status: "disconnected" as OmniRushServerStatus, capabilities: null };
    }
  };

  const clearHealthTimeout = () => {
    if (healthTimeoutId !== null) {
      window.clearTimeout(healthTimeoutId);
      healthTimeoutId = null;
    }
  };

  const queueHealthCheck = (delayMs: number) => {
    if (disposed || typeof window === "undefined") return;
    clearHealthTimeout();
    healthTimeoutId = window.setTimeout(() => {
      healthTimeoutId = null;
      void runHealthCheck();
    }, Math.max(0, delayMs));
  };

  const runHealthCheck = async () => {
    if (disposed || typeof window === "undefined") return;
    if (!options.documentVisible()) {
      queueHealthCheck(healthDelayMs);
      return;
    }
    if (shouldWaitForLocalHostInfo()) {
      queueHealthCheck(250);
      return;
    }
    if (healthBusy) return;

    const url = getBaseUrl().trim();
    const auth = getAuth();
    if (!url) {
      consecutiveHealthFailures = 0;
      mutateState((current) => ({
        ...current,
        omnirushServerStatus: "disconnected",
        omnirushServerCapabilities: null,
        omnirushServerCheckedAt: Date.now(),
      }));
      return;
    }

    healthBusy = true;
    try {
      let result = await checkOmniRushServer(url, auth.token, auth.hostToken);

      if (shouldRetryStartupCheck(result.status)) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        if (disposed) return;

        try {
          const info = await omnirushServerInfo() as OmniRushServerInfo;
          if (disposed) return;

          mutateState((current) => ({
            ...current,
            omnirushServerHostInfo: info,
            omnirushServerHostInfoReady: true,
          }));

          const retryUrl = info.baseUrl?.trim() ?? "";
          const retryToken = info.clientToken?.trim() || undefined;
          const retryHostToken = info.hostToken?.trim() || undefined;
          if (retryUrl) {
            result = await checkOmniRushServer(retryUrl, retryToken, retryHostToken);
          }
        } catch {
          // Preserve the original check result when the retry probe fails.
        }
      }

      if (disposed) return;
      const previousStatus = state.omnirushServerStatus;
      const previousCapabilities = state.omnirushServerCapabilities;
      const healthy = result.status === "connected" || result.status === "limited";
      if (healthy) {
        consecutiveHealthFailures = 0;
        healthDelayMs = 10_000;
      } else {
        consecutiveHealthFailures += 1;
        healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      }

      const preservePrevious =
        !healthy &&
        consecutiveHealthFailures < 3 &&
        (previousStatus === "connected" || previousStatus === "limited");

      mutateState((current) => ({
        ...current,
        omnirushServerStatus: preservePrevious ? previousStatus : result.status,
        omnirushServerCapabilities: preservePrevious ? previousCapabilities : result.capabilities,
        omnirushServerCheckedAt: Date.now(),
      }));
    } catch {
      healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      mutateState((current) => ({
        ...current,
        omnirushServerCheckedAt: Date.now(),
      }));
    } finally {
      healthBusy = false;
      if (!disposed) queueHealthCheck(healthDelayMs);
    }
  };

  const syncFromOptions = () => {
    if (refreshSnapshot()) emitChange();

    if (!isDesktopRuntime()) return;
    const port = state.omnirushServerHostInfo?.port;
    if (!port) return;
    if (state.omnirushServerSettings.portOverride === port) return;

    updateOmniRushServerSettings({
      ...state.omnirushServerSettings,
      portOverride: port,
    });
  };

  const startInterval = (key: string, fn: () => void, ms: number) => {
    if (typeof window === "undefined") return;
    if (intervals.has(key)) return;
    intervals.set(key, window.setInterval(fn, ms));
  };

  const stopInterval = (key: string) => {
    const id = intervals.get(key);
    if (id === undefined) return;
    window.clearInterval(id);
    intervals.delete(key);
  };

  const start = () => {
    if (typeof window === "undefined") return;
    if (started) return;
    // Allow restart after a prior dispose() (React 18 StrictMode double-mounts
    // each effect in dev: mount → dispose → re-mount). If we early-return when
    // `disposed` is true, the real mount never arms polling and the UI stays
    // on stale/empty state forever.
    disposed = false;
    started = true;

    syncFromOptions();
    queueHealthCheck(0);
    visibilityChangeHandler = () => {
      if (!options.documentVisible()) return;
      consecutiveHealthFailures = 0;
      queueHealthCheck(0);
    };
    window.addEventListener("visibilitychange", visibilityChangeHandler);

    const refreshHostInfo = () => {
      if (!isDesktopRuntime()) return;
      if (!options.documentVisible()) return;
      void (async () => {
        try {
          const info = await omnirushServerInfo() as OmniRushServerInfo;
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            omnirushServerHostInfo: info,
            omnirushServerHostInfoReady: true,
          }));
        } catch {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            omnirushServerHostInfo: null,
            omnirushServerHostInfoReady: true,
          }));
        }
      })();
    };
    refreshHostInfo();
    startInterval("hostInfo", refreshHostInfo, 10_000);

    const refreshDiagnostics = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("omnirushServerDiagnostics", null);
        return;
      }

      const client = getClient();
      if (!client || state.omnirushServerStatus === "disconnected") {
        setStateField("omnirushServerDiagnostics", null);
        return;
      }

      void (async () => {
        try {
          const status = await client.status();
          if (!disposed) setStateField("omnirushServerDiagnostics", status);
        } catch {
          if (!disposed) setStateField("omnirushServerDiagnostics", null);
        }
      })();
    };
    refreshDiagnostics();
    startInterval("diagnostics", refreshDiagnostics, 10_000);

    const refreshDevtoolsWorkspace = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      const client = getClient();
      if (!client) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      void (async () => {
        try {
          const response = await client.listWorkspaces();
          if (disposed) return;
          const items = Array.isArray(response.items) ? response.items : [];
          const activeMatch = response.activeId
            ? items.find((item) => item.id === response.activeId)
            : null;
          setStateField("devtoolsWorkspaceId", activeMatch?.id ?? items[0]?.id ?? null);
        } catch {
          if (!disposed) setStateField("devtoolsWorkspaceId", null);
        }
      })();
    };
    refreshDevtoolsWorkspace();
    startInterval("devtoolsWorkspace", refreshDevtoolsWorkspace, 20_000);

    const refreshAudit = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        mutateState((current) => ({
          ...current,
          omnirushAuditEntries: [],
          omnirushAuditStatus: "idle",
          omnirushAuditError: null,
        }));
        return;
      }

      const client = getClient();
      const workspaceId = state.devtoolsWorkspaceId;
      if (!client || !workspaceId) {
        mutateState((current) => ({
          ...current,
          omnirushAuditEntries: [],
          omnirushAuditStatus: "idle",
          omnirushAuditError: null,
        }));
        return;
      }

      mutateState((current) => ({
        ...current,
        omnirushAuditStatus: "loading",
        omnirushAuditError: null,
      }));

      void (async () => {
        try {
          const result = await client.listAudit(workspaceId, 50);
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            omnirushAuditEntries: Array.isArray(result.items) ? result.items : [],
            omnirushAuditStatus: "idle",
          }));
        } catch (error) {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            omnirushAuditEntries: [],
            omnirushAuditStatus: "error",
            omnirushAuditError:
              error instanceof Error
                ? error.message
                : t("app.error_audit_load"),
          }));
        }
      })();
    };
    refreshAudit();
    startInterval("audit", refreshAudit, 15_000);
  };

  const dispose = () => {
    disposed = true;
    started = false;
    clearHealthTimeout();
    if (visibilityChangeHandler && typeof window !== "undefined") {
      window.removeEventListener("visibilitychange", visibilityChangeHandler);
      visibilityChangeHandler = null;
    }
    for (const key of [...intervals.keys()]) stopInterval(key);
  };

  const testOmniRushServerConnection = async (next: OmniRushServerSettings) => {
    const derived = normalizeOmniRushServerUrl(next.urlOverride ?? "");
    if (!derived) {
      mutateState((current) => ({
        ...current,
        omnirushServerStatus: "disconnected",
        omnirushServerCapabilities: null,
        omnirushServerCheckedAt: Date.now(),
      }));
      return false;
    }

    const result = await checkOmniRushServer(derived, next.token);
    consecutiveHealthFailures = result.status === "disconnected" ? consecutiveHealthFailures + 1 : 0;
    mutateState((current) => ({
      ...current,
      omnirushServerStatus: result.status,
      omnirushServerCapabilities: result.capabilities,
      omnirushServerCheckedAt: Date.now(),
    }));

    const ok = result.status === "connected" || result.status === "limited";
    if (ok && !isDesktopRuntime()) {
      const active = options.selectedWorkspaceDisplay();
      const shouldAttach =
        !options.activeClient() ||
        active.workspaceType !== "remote" ||
        active.remoteType !== "omnirush";
      if (shouldAttach) {
        await options
          .createRemoteWorkspaceFlow({
            omnirushHostUrl: derived,
            omnirushToken: next.token ?? null,
          })
          .catch(() => undefined);
      }
    }
    return ok;
  };

  const reconnectOmniRushServer = async () => {
    if (state.omnirushReconnectBusy) return false;
    setStateField("omnirushReconnectBusy", true);

    try {
      let hostInfo = state.omnirushServerHostInfo;
      if (isDesktopRuntime()) {
        try {
          hostInfo = await omnirushServerInfo() as OmniRushServerInfo;
          mutateState((current) => ({ ...current, omnirushServerHostInfo: hostInfo }));
        } catch {
          hostInfo = null;
          setStateField("omnirushServerHostInfo", null);
        }
      }

      if (hostInfo?.clientToken?.trim() && options.startupPreference() !== "server") {
        const liveToken = hostInfo.clientToken.trim();
        const liveHostToken = hostInfo.hostToken?.trim() ?? "";
        const settings = state.omnirushServerSettings;
        if (
          (settings.token?.trim() ?? "") !== liveToken ||
          (settings.hostToken?.trim() ?? "") !== liveHostToken
        ) {
          updateOmniRushServerSettings({
            ...settings,
            token: liveToken,
            hostToken: liveHostToken || undefined,
          });
        }
      }

      const url = getBaseUrl().trim();
      const auth = getAuth();
      if (!url) {
        mutateState((current) => ({
          ...current,
          omnirushServerStatus: "disconnected",
          omnirushServerCapabilities: null,
          omnirushServerCheckedAt: Date.now(),
        }));
        return false;
      }

      const result = await checkOmniRushServer(url, auth.token, auth.hostToken);
      mutateState((current) => ({
        ...current,
        omnirushServerStatus: result.status,
        omnirushServerCapabilities: result.capabilities,
        omnirushServerCheckedAt: Date.now(),
      }));
      return result.status === "connected" || result.status === "limited";
    } finally {
      setStateField("omnirushReconnectBusy", false);
    }
  };

  async function ensureLocalOmniRushServerClient(): Promise<OmniRushServerClient | null> {
    const healthyClientFromInfo = async (
      info: OmniRushServerInfo | null,
    ): Promise<OmniRushServerClient | null> => {
      const baseUrl = info?.baseUrl?.trim() ?? "";
      const token = info?.clientToken?.trim() ?? "";
      if (!baseUrl || !token) return null;
      const candidate = createOmniRushServerClient({
        baseUrl,
        token,
        hostToken: info?.hostToken?.trim() || undefined,
      });
      try {
        await candidate.health();
      } catch {
        return null;
      }
      return candidate;
    };

    const cached = await healthyClientFromInfo(state.omnirushServerHostInfo);
    if (cached) {
      if (options.startupPreference() !== "server") {
        await reconnectOmniRushServer();
      }
      return cached;
    }

    if (!isDesktopRuntime()) return null;

    // A store that has not observed the server yet (a fresh route mount)
    // must not treat it as dead: the restart below tears down the embedded
    // server AND its managed engine, killing every live run. Ask the desktop
    // bridge for the live server first and restart only when that running
    // server is genuinely unreachable.
    let hostInfo: OmniRushServerInfo | null = null;
    try {
      hostInfo = await omnirushServerInfo() as OmniRushServerInfo;
      mutateState((current) => ({
        ...current,
        omnirushServerHostInfo: hostInfo,
        omnirushServerHostInfoReady: true,
      }));
    } catch {
      hostInfo = null;
    }
    const live = await healthyClientFromInfo(hostInfo);
    if (live) {
      if (options.startupPreference() !== "server") {
        await reconnectOmniRushServer();
      }
      return live;
    }

    try {
      // Not a user action: the desktop keeps a server that still answers it
      // and only replaces one that is really gone.
      hostInfo = await omnirushServerRestart({
        reason: "renderer_health_check_failed",
        source: "omnirush-server-store",
        remoteAccessEnabled: state.omnirushServerSettings.remoteAccessEnabled === true,
      }) as OmniRushServerInfo;
      mutateState((current) => ({ ...current, omnirushServerHostInfo: hostInfo }));
    } catch {
      return null;
    }

    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";
    if (!baseUrl || !token) return null;

    if (options.startupPreference() !== "server") {
      await reconnectOmniRushServer();
    }

    return createOmniRushServerClient({
      baseUrl,
      token,
      hostToken: hostToken || undefined,
    });
  }

  const saveShareRemoteAccess = async (enabled: boolean) => {
    if (state.shareRemoteAccessBusy) return;
    const previous = state.omnirushServerSettings;
    const next: OmniRushServerSettings = {
      ...previous,
      remoteAccessEnabled: enabled,
    };

    mutateState((current) => ({
      ...current,
      shareRemoteAccessBusy: true,
      shareRemoteAccessError: null,
    }));
    updateOmniRushServerSettings(next);

    try {
      if (isDesktopRuntime() && options.selectedWorkspaceDisplay().workspaceType === "local") {
        const restarted = await options.restartLocalServer();
        if (!restarted) {
          throw new Error(t("app.error_restart_local_worker"));
        }
        await reconnectOmniRushServer();
      }
    } catch (error) {
      updateOmniRushServerSettings(previous);
      mutateState((current) => ({
        ...current,
        shareRemoteAccessError:
          error instanceof Error
            ? error.message
            : t("app.error_remote_access"),
      }));
      return;
    } finally {
      setStateField("shareRemoteAccessBusy", false);
    }
  };

  refreshSnapshot();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = () => {
    if (!snapshot) throw new Error("omnirush.ai server snapshot was not initialized.");
    return snapshot;
  };

  return {
    subscribe,
    getSnapshot,
    start,
    dispose,
    syncFromOptions,
    setOmniRushServerSettings,
    updateOmniRushServerSettings,
    resetOmniRushServerSettings,
    saveShareRemoteAccess,
    checkOmniRushServer,
    testOmniRushServerConnection,
    reconnectOmniRushServer,
    ensureLocalOmniRushServerClient,
  };
}

export function useOmniRushServerStoreSnapshot(store: OmniRushServerStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
