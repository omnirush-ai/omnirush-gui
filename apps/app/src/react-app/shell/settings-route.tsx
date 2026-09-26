/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { toast } from "@/components/ui/sonner";
import { closeWorkspaceTerminals } from "../domains/session/terminal/terminal-runtime";

import {
  SUGGESTED_PLUGINS,
  filterOmniRushExtensionCatalogForPlatform,
  resolveOmniRushExtensionCatalogPlatform,
} from "@/app/constants";
import type { EnablementContext } from "@/app/enablement";
import { createClient, unwrap } from "@/app/lib/opencode";
import {
  createOmniRushServerClient,
  isLoopbackOmniRushServerUrl,
  readOmniRushServerSettings,
  type OmniRushCloudMcpHealth,
  type OmniRushCloudMcpProviderModelContext,
  type OmniRushServerCapabilities,
  type OmniRushServerClient,
  type OmniRushWorkspaceInfo,
} from "@/app/lib/omnirush-server";
import { buildOmniRushEnvRuntimeKey } from "@/app/lib/omnirush-env-runtime";
import {
  collectAgentContextDiagnosticObservations,
  isAgentContextDiagnosticsWorkspaceAllowed,
  resolveOrganizationConnectionsProbe,
} from "@/app/lib/agent-context-diagnostics";
import {
  getInitialThemeMode,
  setThemeMode as setAppThemeMode,
  type ThemeMode,
} from "@/app/theme";
import type {
  Client,
  ProviderListItem,
  SettingsTab,
  WorkspaceConnectionState,
  WorkspaceDisplay,
  WorkspaceSessionGroup,
} from "@/app/types";
import { getWorkspaceTaskLoadErrorDisplay } from "@/app/utils";
import { isSupportedModelProvider } from "@/app/lib/provider-catalog";
import { currentLocale, t, setLocale, type Language } from "@/i18n";
import { useModelPicker } from "@/react-app/domains/session/modals/use-model-picker";
import {
  type RouteWorkspace,
  type RouteSession,
  createRouteSession,
  describeRouteError,
  removeRouteWorkspace,
  downloadWorkspaceJson,
  getSessionStatus,
  isActiveSessionStatus,
  listRouteSessions,
  mapDesktopWorkspace,
  mergeRouteWorkspaces,
  orderRouteWorkspaces,
  readRouteSessionsWithRetry,
  toSessionGroups,
  workspaceExportFilename,
  workspaceLabel,
} from "@/react-app/shell/route-workspaces";
import {
  commitRouteWorkspaceSelection,
  createRouteRefreshLifecycle,
  mapRouteWorkspaceLoads,
  routeWorkspaceSelectionCommitter,
} from "@/react-app/shell/route-refresh-control";
import { createConnectionsStore, useConnectionsStoreSnapshot } from "@/react-app/domains/connections/store";
import { cleanupOmniRushCloudMcpAfterSignOut } from "@/react-app/domains/connections/cloud-mcp-reconciler";
import { useOrgMcpConnections } from "@/react-app/domains/connections/use-org-mcp-connections";
import { createOmniRushServerStore, useOmniRushServerStoreSnapshot } from "@/react-app/domains/connections/omnirush-server-store";
import { createProviderAuthStore, useProviderAuthStoreSnapshot } from "@/react-app/domains/connections/provider-auth/store";
import ProviderAuthModal from "@/react-app/domains/connections/provider-auth/provider-auth-modal";
import ConnectionsModals from "@/react-app/domains/connections/modals";
import { AiSettingsView } from "@/react-app/domains/settings/pages/ai-view";
// Side-effect imports: register extension config components into the registry.
import "@/react-app/domains/settings/ollama-config";
import "@/react-app/domains/settings/computer-use-config";
import "@/react-app/domains/settings/browser-extension-config";
import { useSettingsExtensionController } from "@/react-app/domains/settings/settings-extension-controller";
import { buildExtensionItems } from "@/react-app/domains/settings/extension-items";
import { isOmniRushExtensionEnabled, OMNIRUSH_EXTENSION_STATE_CHANGED } from "@/react-app/domains/settings/extension-state";
import { PreferencesView } from "@/react-app/domains/settings/pages/preferences-view";
import { GeneralSettingsView } from "@/react-app/domains/settings/pages/general-view";
import { AuthorizedFoldersPanel } from "@/react-app/domains/settings/panels/authorized-folders-panel";
import { BrowserLoginsPanel } from "../domains/browser-logins/browser-logins-panel";
import { EffectivePermissionsPanel } from "@/react-app/domains/settings/panels/effective-permissions-panel";
import { SettingsStack } from "@/react-app/domains/settings/settings-section";
import { AdvancedView } from "@/react-app/domains/settings/pages/advanced-view";
import { AppearanceView } from "@/react-app/domains/settings/pages/appearance-view";
import { VoiceSettingsView } from "@/react-app/domains/voice/voice-settings-view";
import {
  connectPluginsForComposer,
  EMPTY_CONNECT_CAPABILITY_INVENTORY,
  type ConnectCapabilityInventory,
} from "@/react-app/domains/session/surface/connect-capability-inventory";
import {
  loadConnectCapabilities,
  readCachedConnectCapabilities,
} from "@/react-app/domains/connections/cloud-inventory-cache";
import { buildDiagnosticsBundleJson } from "@/app/lib/diagnostics-bundle";
import { createOpaqueDiagnosticsScopeKey } from "@/react-app/domains/settings/pages/agent-context-diagnostics-section";
import { CloudProvidersView } from "@/react-app/domains/settings/pages/cloud-providers-view";
import { DebugView } from "@/react-app/domains/settings/pages/debug-view";
import { EnvironmentView } from "@/react-app/domains/settings/pages/environment-view";
import { ExtensionsView, type ExtensionsSection } from "@/react-app/domains/settings/pages/extensions-view";
import { McpView } from "@/react-app/domains/settings/pages/mcp-view";
import { RecoveryView } from "@/react-app/domains/settings/pages/recovery-view";
import { UpdatesView } from "@/react-app/domains/settings/pages/updates-view";
import { useDebugViewModel } from "@/react-app/domains/settings/state/debug-view-model";
import { useDesktopUpdater } from "@/react-app/domains/settings/state/desktop-updater-provider";
import { CloudSessionProvider, useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { useDenSession } from "@/react-app/domains/settings/cloud/use-den-session";
import { useControlAction, type OmniRushControlAction } from "./control/control-provider";
import { useBootState } from "./boot-state";
import { SettingsShell } from "@/react-app/domains/settings/shell/settings-shell";
import { SettingsContent } from "@/react-app/domains/settings/shell/panel";
import { createExtensionsStore, useExtensionsStoreSnapshot } from "@/react-app/domains/settings/state/extensions-store";
import { usePlatform } from "@/react-app/kernel/platform";
import { useLocal } from "@/react-app/kernel/local-provider";
import {
  omnirushServerInfo,
  omnirushServerRestart,
  engineStart,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  workspaceForget,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  desktopBridge,
  type WorkspaceInfo,
  type WorkspaceList,
  revealDesktopItemInDir,
} from "@/app/lib/desktop";
import {
  SETTINGS_TAB_WITHOUT_CONTROL,
  desktopRestrictionNotice,
  isDesktopProviderBlocked,
  isSettingsTabAllowed,
} from "@/app/cloud/desktop-app-restrictions";
import { useCheckDesktopRestriction, useDesktopConfig } from "@/react-app/domains/cloud/desktop-config-provider";
import { useRestrictionNotice } from "@/react-app/domains/cloud/restriction-notice-provider";
import { useCloudProviderAutoSync } from "@/react-app/domains/cloud/use-cloud-provider-auto-sync";
import {
  isDesktopRuntime,
  isElectronRuntime,
  isMacPlatform,
  normalizeDirectoryPath,
  resolveModelDisplayName,
  resolveModelProviderDisplayName,
  resolveProviderDisplayName,
  safeStringify,
} from "@/app/utils";
import { CreateRemoteWorkspaceModal } from "@/react-app/domains/workspace/create-remote-workspace-modal";
import { RenameWorkspaceModal } from "@/react-app/domains/workspace/rename-workspace-modal";
import { ShareWorkspaceModal } from "@/react-app/domains/workspace/share-workspace-modal";
import { useShareWorkspaceState } from "@/react-app/domains/workspace/share-workspace-state";
import { useRemoteWorkspaceConnectionEditor } from "@/react-app/domains/workspace/use-remote-workspace-connection-editor";
import {
  diagnoseRemoteWorkspaceTaskLoadFailure,
  getRemoteWorkspaceConnectionKey,
  testRemoteWorkspaceConnection,
} from "@/react-app/domains/workspace/remote-workspace-diagnostics";
import { ModelPickerModal } from "@/react-app/domains/session/modals/model-picker-modal";
import type { ModelRef } from "@/app/types";
import { workspaceSwatchColor } from "@/react-app/domains/session/sidebar/utils";
import { recordInspectorEvent } from "../../app/lib/app-inspector";
import {
  ensureDesktopLocalOmniRushConnection,
  shouldAttemptDesktopLocalReconnect,
} from "./desktop-local-omnirush";
import { reloadEngineWithDesktopFallback } from "./engine-reload-escalation";
import { resolveOmniRushConnection } from "./omnirush-connection";
import { abortSessionSafe, listCommands } from "@/app/lib/opencode-session";
import { notifyAlert } from "./notifications";
import { useReloadCoordinator } from "./reload-coordinator";
import { CommandPalette, type PaletteItem } from "./command-palette";
import { buildCommandPaletteSessions } from "./command-palette-sessions";
import { useCommandPaletteShortcut } from "./use-shell-shortcuts";
import type { DenSettings } from "@/app/lib/den";
import { readActiveWorkspaceId, writeActiveWorkspaceId } from "./session-memory";
import { useUiStateStore } from "./ui-state-store";
import {
  automationsRoute,
  globalExtensionsRoute,
  settingsReturnRoute,
  workspaceExtensionsRoute,
  workspaceSessionRoute,
  workspaceSettingsRoute,
} from "./workspace-routes";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { refreshProviderListQueries } from "@/react-app/infra/provider-list-query";
import {
  createWorkspaceServerClientResolver,
  useWorkspaceServerClient,
} from "@/react-app/infra/workspace-server-client";
import {
  buildLocalProviderConfig,
  OPENAI_IMAGE_EXTENSION_ID,
  OPENAI_IMAGE_MODEL,
  type LocalProviderInstallInput,
} from "@/react-app/domains/settings/openai-image-extension";
import {
  libraryAgentsFromOpencode,
  libraryCommandsFromSlashOptions,
  type LibraryAgentItem,
  type LibraryCommandItem,
} from "@/react-app/domains/settings/library";

const ROUTE_OMNIRUSH_CAPABILITIES: OmniRushServerCapabilities = {
  skills: { read: true, write: true, source: "omnirush" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
};

async function reloadEngineOrRestartDesktop(
  client: Pick<OmniRushServerClient, "reloadEngine">,
  workspaceId: string,
  afterRestart?: () => Promise<void>,
): Promise<void> {
  const { restartedEngine } = await reloadEngineWithDesktopFallback(client, workspaceId);
  if (restartedEngine) {
    await afterRestart?.();
  }
}

function isOmniRushCloudProvider(provider: {
  providerId?: string | null;
  source?: string | null;
  sourceProviderId?: string | null;
}) {
  return [provider.providerId, provider.source, provider.sourceProviderId].some(
    (value) => value?.trim().toLowerCase() === "omnirush",
  );
}

function normalizeComputerUsePermissions(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  return {
    accessibility: "accessibility" in value && value.accessibility === true,
    screenRecording: "screenRecording" in value && value.screenRecording === true,
  };
}

function reconcileSelectedWorkspaceId(
  currentId: string,
  serverList: { activeId?: string | null },
  desktopList: WorkspaceList | null,
  workspaces: RouteWorkspace[],
) {
  const current = currentId.trim();
  const serverIds = new Set(workspaces.map((workspace) => workspace.id));
  if (current && serverIds.has(current)) return current;

  const desktopSelectedId = resolveWorkspaceListSelectedId(desktopList);
  const desktopSelected = desktopSelectedId
    ? desktopList?.workspaces?.find((workspace) => workspace.id === desktopSelectedId)
    : null;
  const currentDesktop = current
    ? desktopList?.workspaces?.find((workspace) => workspace.id === current)
    : null;
  const selectedPath = normalizeDirectoryPath((currentDesktop ?? desktopSelected)?.path ?? "");

  if (selectedPath) {
    const pathMatch = workspaces.find(
      (workspace) => normalizeDirectoryPath(workspace.path ?? "") === selectedPath,
    );
    if (pathMatch) return pathMatch.id;
  }

  return serverList.activeId?.trim() || desktopSelectedId || workspaces[0]?.id || "";
}

const SETTINGS_HIDE_TITLEBAR_KEY = "omnirush.react.settings.hide-titlebar";

export function parseSettingsPath(pathname: string): {
  tab: SettingsTab;
  redirectPath: string | null;
  advancedSection?: string;
  extensionsSection?: ExtensionsSection;
  extensionDetailId?: string;
} {
  const trimmed = pathname
    .replace(/^\/workspace\/[^/]+\/settings\/?/, "")
    .replace(/^\/settings\/?/, "")
    .replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return { tab: "general", redirectPath: "general" };
  }

  const [head, tail] = trimmed.split("/");
  switch (head) {
    case "general":
    case "ai":
    case "preferences":
    case "permissions":
    case "appearance":
    case "voice":
    case "environment":
    case "updates":
    case "debug":
      return { tab: head, redirectPath: null };
    case "advanced":
      return { tab: "advanced", redirectPath: null, advancedSection: tail };
    case "cloud-account":
      return { tab: "general", redirectPath: "general" };
    case "cloud-providers":
      return { tab: head, redirectPath: null };
    case "connect":
      return { tab: "extensions", redirectPath: "extensions", extensionsSection: "all" };
    case "recovery":
      return { tab: "advanced", redirectPath: "advanced" };
    case "skills":
      return { tab: "extensions", redirectPath: "extensions/skills", extensionsSection: "skills" };
    case "mcp":
      return { tab: "extensions", redirectPath: "extensions/mcps", extensionsSection: "mcps" };
    case "cloud-marketplaces":
      return { tab: "extensions", redirectPath: "extensions", extensionsSection: "all" };
    case "den":
    case "cloud-workers":
      return { tab: "cloud-account", redirectPath: "cloud-account" };
    case "extensions":
      if (tail === "mcp") return { tab: "extensions", redirectPath: "extensions/mcps", extensionsSection: "mcps" };
      if (
        tail === "apps"
        || tail === "connections"
        || tail === "mcps"
        || tail === "skills"
        || tail === "commands"
        || tail === "agents"
        || tail === "plugins"
        || tail === "needs-sign-in"
        || tail === "needs-admin-setup"
        || tail === "ready"
      ) {
        return { tab: "extensions", redirectPath: null, extensionsSection: tail };
      }
      if (tail) {
        return {
          tab: "extensions",
          redirectPath: null,
          extensionsSection: "all",
          extensionDetailId: decodeURIComponent(tail),
        };
      }
      return { tab: "extensions", redirectPath: null, extensionsSection: "all" };
    default:
      return { tab: "general", redirectPath: "general" };
  }
}

export function parseExtensionsPath(pathname: string): ReturnType<typeof parseSettingsPath> {
  const extensionPath = pathname
    .replace(/^\/workspace\/[^/]+\/extensions\/?/, "")
    .replace(/^\/extensions\/?/, "")
    .replace(/^\/+|\/+$/g, "");
  return parseSettingsPath(`/settings/extensions${extensionPath ? `/${extensionPath}` : ""}`);
}

function readStoredBoolean(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

function writeStoredBoolean(key: string, value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore persistence failures
  }
}

function readNavigationWorkspaceId(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as { workspaceId?: unknown }).workspaceId;
  return typeof value === "string" ? value.trim() || null : null;
}

function readNavigationSessionId(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as { sessionId?: unknown }).sessionId;
  return typeof value === "string" ? value.trim() || null : null;
}

export function settingsDeveloperModePaletteItem(
  developerMode: boolean,
  action: () => void,
): PaletteItem {
  return {
    id: "developer-mode.toggle",
    title: developerMode ? t("settings.disable_developer_mode") : t("settings.enable_developer_mode"),
    detail: t("settings.developer_mode_desc"),
    meta: developerMode ? "On" : "Off",
    searchText: "developer dev mode debug diagnostics toggle enable disable",
    action,
  };
}

function findSessionWorkspaceId(
  sessionId: string | null,
  entries: Array<{ workspaceId: string; sessions: any[] }>,
) {
  const id = sessionId?.trim();
  if (!id) return null;
  return entries.find((entry) => entry.sessions.some((session) => session?.id === id))?.workspaceId ?? null;
}

export function settingsPathForRoute(route: ReturnType<typeof parseSettingsPath>) {
  if (route.tab === "advanced" && route.advancedSection) return `advanced/${route.advancedSection}`;
  if (route.tab === "extensions" && route.extensionDetailId) {
    return `extensions/${encodeURIComponent(route.extensionDetailId)}`;
  }
  if (route.tab === "extensions" && route.extensionsSection && route.extensionsSection !== "all") {
    return `extensions/${route.extensionsSection}`;
  }
  return route.tab;
}

export function extensionsPathForRoute(route: ReturnType<typeof parseSettingsPath>) {
  if (route.extensionDetailId) {
    return encodeURIComponent(route.extensionDetailId);
  }
  if (route.extensionsSection && route.extensionsSection !== "all") {
    return route.extensionsSection;
  }
  return "";
}

export type SettingsSurfaceProps = {
  embedded?: boolean;
  standaloneExtensions?: boolean;
  initialPath?: string;
  workspaceId?: string;
  onClose?: () => void;
};

function SettingsRouteContent(props: SettingsSurfaceProps = {}) {
  const navigate = useNavigate();
  const toggleSidebar = useUiStateStore((state) => state.toggleSidebar);
  const location = useLocation();
  const params = useParams<{ workspaceId?: string }>();
  const routeWorkspaceId = props.workspaceId?.trim() || params.workspaceId?.trim() || "";
  const routeWorkspaceIdRef = useRef(routeWorkspaceId);
  routeWorkspaceIdRef.current = routeWorkspaceId;
  const local = useLocal();
  const platform = usePlatform();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const restrictionNotice = useRestrictionNotice();
  const desktopConfig = useDesktopConfig();
  const reloadCoordinator = useReloadCoordinator();
  const [embeddedPath, setEmbeddedPath] = useState(props.initialPath ?? "general");
  const route = props.embedded
    ? parseSettingsPath(`/settings/${embeddedPath}`)
    : props.standaloneExtensions
      ? parseExtensionsPath(location.pathname)
      : parseSettingsPath(location.pathname);
  const navigationWorkspaceId = readNavigationWorkspaceId(location.state);
  const navigationSessionId = readNavigationSessionId(location.state);

  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<RouteWorkspace[]>([]);
  const [sessionsByWorkspaceId, setSessionsByWorkspaceId] = useState<Record<string, RouteSession[]>>({});
  const [errorsByWorkspaceId, setErrorsByWorkspaceId] = useState<Record<string, string | null>>({});
  const [workspaceConnectionOverrides, setWorkspaceConnectionOverrides] = useState<Record<string, WorkspaceConnectionState>>({});
  const [legacySelectedWorkspaceId, setLegacySelectedWorkspaceId] = useState(() => navigationWorkspaceId ?? readActiveWorkspaceId() ?? "");
  const selectedWorkspaceId = routeWorkspaceId || legacySelectedWorkspaceId;
  // The standalone Library takeover is not a settings surface; the
  // `allowControlSettings` policy only governs the settings shell.
  const settingsTabBlocked = !props.standaloneExtensions
    && !isSettingsTabAllowed({ tab: route.tab, checkRestriction: checkDesktopRestriction });

  useEffect(() => {
    if (!props.embedded) return;
    if (route.redirectPath) {
      setEmbeddedPath(route.redirectPath);
      return;
    }
    if (settingsTabBlocked) setEmbeddedPath(SETTINGS_TAB_WITHOUT_CONTROL);
  }, [props.embedded, route.redirectPath, settingsTabBlocked]);

  const navigateSettingsPath = useCallback((path: string) => {
    if (props.embedded) {
      setEmbeddedPath(path);
      return;
    }
    if (props.standaloneExtensions) {
      const extensionPath = path.replace(/^extensions\/?/, "");
      navigate(
        selectedWorkspaceId
          ? workspaceExtensionsRoute(selectedWorkspaceId, extensionPath)
          : globalExtensionsRoute(extensionPath),
        { state: location.state },
      );
      return;
    }
    navigate(
      selectedWorkspaceId ? workspaceSettingsRoute(selectedWorkspaceId, path) : `/settings/${path}`,
      { state: location.state },
    );
  }, [location.state, navigate, props.embedded, props.standaloneExtensions, selectedWorkspaceId]);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [omnirushClient, setOmniRushClient] = useState<OmniRushServerClient | null>(null);
  const [activeClient, setActiveClient] = useState<Client | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const workspacesRef = useRef<RouteWorkspace[]>([]);
  const lastRequestedRouteWorkspaceIdRef = useRef("");
  const refreshLifecycleRef = useRef(createRouteRefreshLifecycle());
  const serverActiveWorkspaceIdRef = useRef("");
  const reconnectAttemptedWorkspaceIdRef = useRef("");
  const refreshMcpServersRef = useRef<(() => void | Promise<void>) | null>(null);
  const notifyMcpReloadingRef = useRef<(() => void) | null>(null);
  const pollMcpServersAfterReloadRef = useRef<(() => void | Promise<void>) | null>(null);
  const remoteWorkspaceCheckRunRef = useRef<Record<string, string>>({});
  const remoteWorkspaceCheckRunCounterRef = useRef(0);
  const [providers, setProviders] = useState<ProviderListItem[]>([]);
  const [providerDefaults, setProviderDefaults] = useState<Record<string, string>>({});
  const [providerConnectedIds, setProviderConnectedIds] = useState<string[]>([]);
  const [disabledProviders, setDisabledProviders] = useState<string[]>([]);
  const [developerMode, setDeveloperMode] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("omnirush.developerMode") === "1";
  });
  const toggleDeveloperMode = useCallback(() => {
    setDeveloperMode((current) => {
      const next = !current;
      try { window.localStorage.setItem("omnirush.developerMode", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
  const [themeMode, setThemeModeState] = useState<ThemeMode>(getInitialThemeMode);
  const [hideTitlebar, setHideTitlebar] = useState(() => readStoredBoolean(SETTINGS_HIDE_TITLEBAR_KEY, false));
  const [configActionStatus, setConfigActionStatus] = useState<string | null>(null);
  const [permissionsRefreshToken, setPermissionsRefreshToken] = useState(0);
  const [revealConfigBusy, setRevealConfigBusy] = useState(false);
  const [resetConfigBusy, setResetConfigBusy] = useState(false);
  const [renameWorkspaceId, setRenameWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceTitle, setRenameWorkspaceTitle] = useState("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = useState(false);
  const [exportWorkspaceBusy, setExportWorkspaceBusy] = useState(false);
  const [autoCompactContext, setAutoCompactContext] = useState(true);
  const [autoCompactContextBusy, setAutoCompactContextBusy] = useState(false);
  const [autoCompactContextLoaded, setAutoCompactContextLoaded] = useState(false);
  const [localProviderBusy, setLocalProviderBusy] = useState(false);
  const [localProviderStatus, setLocalProviderStatus] = useState<string | null>(null);
  const [localProviderError, setLocalProviderError] = useState<string | null>(null);
  const [imageExtensionBusy, setImageExtensionBusy] = useState(false);
  const [imageExtensionStatus, setImageExtensionStatus] = useState<string | null>(null);
  const [imageExtensionError, setImageExtensionError] = useState<string | null>(null);
  const [computerUsePermissions, setComputerUsePermissions] = useState<{ accessibility: boolean; screenRecording: boolean } | null>(null);
  const [extensionStateVersion, setExtensionStateVersion] = useState(0);
  const [imageGenerationBusy, setImageGenerationBusy] = useState(false);
  const [imageGenerationStatus, setImageGenerationStatus] = useState<string | null>(null);
  const [imageGenerationError, setImageGenerationError] = useState<string | null>(null);
  const [userEnvKeys, setUserEnvKeys] = useState<string[]>([]);
  const [cloudMcpHealthResult, setCloudMcpHealthResult] = useState<{
    workspaceId: string;
    health: OmniRushCloudMcpHealth;
  } | null>(null);
  const emptyWorkspaceDisplay = useMemo<WorkspaceDisplay>(
    () => ({
      id: "",
      name: t("session.workspace_fallback"),
      path: "",
      preset: "starter",
      workspaceType: "local",
    }),
    [],
  );

  const routeStateRef = useRef({
    checkDesktopRestriction,
    activeClient: null as Client | null,
    providerBaseUrl: "",
    selectedWorkspaceId: "",
    selectedWorkspaceRoot: "",
    selectedWorkspaceType: "local" as "local" | "remote",
    runtimeWorkspaceId: null as string | null,
    omnirushServerClient: null as OmniRushServerClient | null,
    selectedWorkspaceOmniRushClient: null as OmniRushServerClient | null,
    omnirushServerStatus: "disconnected" as "connected" | "disconnected",
    omnirushServerCapabilities: null as OmniRushServerCapabilities | null,
    selectedWorkspaceDisplay: emptyWorkspaceDisplay as WorkspaceDisplay,
    providerItems: [] as ProviderListItem[],
    providerDefaults: {} as Record<string, string>,
    providerConnectedIds: [] as string[],
    disabledProviders: [] as string[],
    developerMode: false,
  });

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? (selectedWorkspaceId ? null : workspaces[0] ?? null),
    [selectedWorkspaceId, workspaces],
  );
  const workspaceConnectionStateById = useMemo(() => {
    const next: Record<string, WorkspaceConnectionState> = { ...workspaceConnectionOverrides };
    for (const workspace of workspaces) {
      if (workspace.workspaceType !== "remote") continue;
      const error = errorsByWorkspaceId[workspace.id]?.trim();
      if (!error || next[workspace.id]?.status === "connecting") continue;
      next[workspace.id] ??= {
        status: "error",
        message: getWorkspaceTaskLoadErrorDisplay(workspace, error).message || error,
        checkedAt: null,
      };
    }
    return next;
  }, [errorsByWorkspaceId, workspaceConnectionOverrides, workspaces]);
  const selectedWorkspaceRoot = selectedWorkspace?.path?.trim() || "";
  const selectedWorkspaceDisplay = useMemo<WorkspaceDisplay>(
    () =>
      selectedWorkspace
        ? {
            id: selectedWorkspace.id,
            name: selectedWorkspace.name ?? selectedWorkspace.displayNameResolved,
            path: selectedWorkspace.path ?? "",
            preset: "starter",
            workspaceType: selectedWorkspace.workspaceType ?? "local",
            displayName: selectedWorkspace.displayNameResolved,
            omnirushWorkspaceName: selectedWorkspace.omnirushWorkspaceName,
          }
        : emptyWorkspaceDisplay,
    [emptyWorkspaceDisplay, selectedWorkspace],
  );
  const workspaceServerClientResolver = useMemo(
    () => createWorkspaceServerClientResolver({ baseUrl, token }),
    [baseUrl, token],
  );
  const workspaceSelectionCommitRef = useRef<(workspaceId: string) => Promise<void>>(async () => undefined);
  workspaceSelectionCommitRef.current = async (workspaceId) => {
    await commitRouteWorkspaceSelection({
      workspaceId,
      desktopRuntime: isDesktopRuntime(),
      setDesktopSelected: workspaceSetSelected,
      setDesktopRuntimeActive: workspaceSetRuntimeActive,
      activateWorkspace: async (selectedId) => {
        const workspace = workspacesRef.current.find((item) => item.id === selectedId) ?? null;
        const endpoint = workspaceServerClientResolver(workspace);
        if (!endpoint) throw new Error(`Workspace endpoint unavailable for ${selectedId}.`);
        if (workspace?.workspaceType === "local" && serverActiveWorkspaceIdRef.current === selectedId) return;
        await endpoint.client.activateWorkspace(endpoint.workspaceId, { persist: true });
        if (workspace?.workspaceType === "local") serverActiveWorkspaceIdRef.current = selectedId;
      },
    });
  };
  const selectedWorkspaceEndpoint = useWorkspaceServerClient(selectedWorkspace, { baseUrl, token });
  const opencodeBaseUrl = selectedWorkspaceEndpoint?.opencodeBaseUrl ?? "";

  routeStateRef.current = {
    checkDesktopRestriction,
    activeClient,
    providerBaseUrl: opencodeBaseUrl,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    selectedWorkspaceType: selectedWorkspace?.workspaceType ?? "local",
    runtimeWorkspaceId: selectedWorkspace?.id ?? null,
    omnirushServerClient: omnirushClient,
    selectedWorkspaceOmniRushClient: omnirushClient,
    omnirushServerStatus: omnirushClient ? "connected" : "disconnected",
    omnirushServerCapabilities: omnirushClient ? ROUTE_OMNIRUSH_CAPABILITIES : null,
    selectedWorkspaceDisplay,
    providerItems: providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviders,
    developerMode,
  };

  const activeReloadBlockingSessions = useMemo(
    () =>
      Object.values(sessionsByWorkspaceId)
        .flat()
        .flatMap((session) => {
          if (!isActiveSessionStatus(getSessionStatus(session))) return [];
          const id = String(session?.id ?? "");
          if (!id) return [];
          return [{
            id,
            title:
              String(session?.title ?? session?.slug ?? session?.id ?? "").trim() ||
              t("session.untitled"),
          }];
        }),
    [sessionsByWorkspaceId],
  );

  const omnirushServerStore = useMemo(
    () =>
      createOmniRushServerStore({
        startupPreference: () => {
          // In desktop mode, loopback URLs are ephemeral local runtime details.
          // Only non-loopback stored URLs indicate an explicit remote/manual
          // server connection preference.
          if (!isDesktopRuntime()) return "server";
          const stored = readOmniRushServerSettings();
          const storedUrl = stored.urlOverride?.trim() ?? "";
          return storedUrl && !isLoopbackOmniRushServerUrl(storedUrl) ? "server" : "local";
        },
        documentVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
        developerMode: () => routeStateRef.current.developerMode,
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        activeClient: () => routeStateRef.current.activeClient,
        selectedWorkspaceDisplay: () => routeStateRef.current.selectedWorkspaceDisplay,
        restartLocalServer: async () => {
          if (!isDesktopRuntime()) return false;
          try {
            await omnirushServerRestart({
              reason: "share_remote_access_changed",
              userInitiated: true,
              remoteAccessEnabled:
                readOmniRushServerSettings().remoteAccessEnabled === true,
            });
            return true;
          } catch {
            return false;
          }
        },
        createRemoteWorkspaceFlow: async () => false,
      }),
    [],
  );
  const connectionsStore = useMemo(
    () =>
      createConnectionsStore({
        checkDesktopAppRestriction: (input) => routeStateRef.current.checkDesktopRestriction(input),
        client: () => routeStateRef.current.activeClient,
        setClient: setActiveClient,
        projectDir: () => routeStateRef.current.selectedWorkspaceRoot,
        selectedWorkspaceId: () => routeStateRef.current.selectedWorkspaceId,
        selectedWorkspaceRoot: () => routeStateRef.current.selectedWorkspaceRoot,
        workspaceType: () => routeStateRef.current.selectedWorkspaceType,
        omnirushServer: omnirushServerStore,
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        ensureRuntimeWorkspaceId: async () =>
          routeStateRef.current.runtimeWorkspaceId?.trim() ||
          routeStateRef.current.selectedWorkspaceId.trim() ||
          null,
        developerMode: () => routeStateRef.current.developerMode,
        markReloadRequired: reloadCoordinator.markReloadRequired,
      }),
    [omnirushServerStore, reloadCoordinator.markReloadRequired],
  );
  refreshMcpServersRef.current = connectionsStore.refreshMcpServers;
  notifyMcpReloadingRef.current = connectionsStore.notifyMcpReloading;
  pollMcpServersAfterReloadRef.current = connectionsStore.pollMcpServersAfterReload;
  // Stable identity: McpView reloads opencode.json whenever this prop changes,
  // so an inline lambda would refetch the config on every settings re-render
  // (store snapshots tick every few seconds while idle on the Library page).
  const readMcpConfigFile = useCallback(
    (scope: "project" | "global") => connectionsStore.readMcpConfigFile(scope),
    [connectionsStore],
  );
  const providerAuthStore = useMemo(
    () =>
      createProviderAuthStore({
        client: () => routeStateRef.current.activeClient,
        providers: () => routeStateRef.current.providerItems,
        providerDefaults: () => routeStateRef.current.providerDefaults,
        providerConnectedIds: () => routeStateRef.current.providerConnectedIds,
        disabledProviders: () => routeStateRef.current.disabledProviders,
        checkDesktopAppRestriction: checkDesktopRestriction,
        providerBaseUrl: () => routeStateRef.current.providerBaseUrl,
        selectedWorkspaceDisplay: () => routeStateRef.current.selectedWorkspaceDisplay,
        selectedWorkspaceRoot: () => routeStateRef.current.selectedWorkspaceRoot,
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        ensureRuntimeWorkspaceId: async () =>
          routeStateRef.current.runtimeWorkspaceId?.trim() ||
          routeStateRef.current.selectedWorkspaceId.trim() ||
          null,
        omnirushServer: omnirushServerStore,
        setProviders,
        setProviderDefaults,
        setProviderConnectedIds,
        setDisabledProviders,
        markOpencodeConfigReloadRequired: () => {
          setConfigActionStatus(t("settings.config_updated"));
          reloadCoordinator.markReloadRequired("config", {
            type: "config",
            name: "opencode.json",
            action: "updated",
          });
        },
      }),
    [checkDesktopRestriction, omnirushServerStore, reloadCoordinator.markReloadRequired],
  );
  const extensionsStore = useMemo(
    () =>
      createExtensionsStore({
        checkDesktopAppRestriction: (input) => routeStateRef.current.checkDesktopRestriction(input),
        client: () => routeStateRef.current.activeClient,
        projectDir: () => routeStateRef.current.selectedWorkspaceRoot,
        selectedWorkspaceId: () => routeStateRef.current.selectedWorkspaceId,
        selectedWorkspaceRoot: () => routeStateRef.current.selectedWorkspaceRoot,
        workspaceType: () => routeStateRef.current.selectedWorkspaceType,
        omnirushServer: omnirushServerStore,
        omnirushServerConnection: () => ({
          omnirushServerClient: routeStateRef.current.omnirushServerClient,
          omnirushServerStatus: routeStateRef.current.omnirushServerStatus,
          omnirushServerCapabilities: routeStateRef.current.omnirushServerCapabilities,
        }),
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        ensureRuntimeWorkspaceId: async () =>
          routeStateRef.current.runtimeWorkspaceId?.trim() ||
          routeStateRef.current.selectedWorkspaceId.trim() ||
          null,
        setBusy,
        setBusyLabel,
        setBusyStartedAt: () => {},
        setError: (message) => {
          if (message) {
            toast.error(message);
          }
        },
        markReloadRequired: reloadCoordinator.markReloadRequired,
      }),
    [omnirushServerStore, reloadCoordinator.markReloadRequired],
  );
  const omnirushServerSnapshot = useOmniRushServerStoreSnapshot(omnirushServerStore);
  const connectionsSnapshot = useConnectionsStoreSnapshot(connectionsStore);
  const providerAuthSnapshot = useProviderAuthStoreSnapshot(providerAuthStore);
  const extensionsSnapshot = useExtensionsStoreSnapshot(extensionsStore);
  const orgMcpConnections = useOrgMcpConnections();

  const omnirushServerStatusForMcp = omnirushServerSnapshot.omnirushServerStatus;
  useEffect(() => {
    if (omnirushServerStatusForMcp !== "connected") return;
    // The first MCP read races the omnirush-server store's initial health
    // check (a fresh store always starts "disconnected"), so it falls back
    // to config files where server-runtime (config.remote) entries — notably
    // the cloud control MCP — don't exist. Without this re-read the built-in
    // cards show "Tap to connect" until the next full remount even though
    // the entries are configured and healthy.
    void connectionsStore.refreshMcpServers();
  }, [connectionsStore, omnirushServerStatusForMcp]);

  useEffect(() => {
    if (omnirushServerStatusForMcp !== "connected") return;
    // Same race for the Cloud Providers rows: the provider-auth store's
    // start() read fires while this store still reports "disconnected", so
    // it takes the legacy (empty) config read and the rows sit on "Syncing"
    // even though the server's /cloud-provider-sync/status already lists the
    // providers as synced. Re-derive from the server once it is reachable.
    void providerAuthStore.refreshImportedCloudProviders();
  }, [omnirushServerStatusForMcp, providerAuthStore]);

  const cleanupCloudMcpForSignOut = useCallback(async (settings: DenSettings) => {
    const client = routeStateRef.current.selectedWorkspaceOmniRushClient;
    const workspaceId = routeStateRef.current.runtimeWorkspaceId?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!client || !workspaceId || !orgId) return;
    // Settings only has a safe, exact OpenCode client/directory for the active
    // workspace here, so sign-out cleanup is intentionally scoped to that
    // workspace instead of guessing across every configured worker.
    await cleanupOmniRushCloudMcpAfterSignOut({
      context: {
        denBaseUrl: settings.baseUrl,
        serverBaseUrl: client.baseUrl,
        workspaceId,
        orgId,
      },
      omnirushClient: client,
      opencodeClient: routeStateRef.current.activeClient,
      directory: routeStateRef.current.selectedWorkspaceRoot,
    });
    setCloudMcpHealthResult(null);
    await refreshMcpServersRef.current?.();
  }, []);
  const denSession = useDenSession({
    developerMode,
    onBeforeSignedOut: cleanupCloudMcpForSignOut,
    openLink: (url) => platform.openLink(url),
  });
  const cloudSession = useCloudSession();
  const connectScope = useMemo(
    () => ({
      baseUrl: cloudSession.baseUrl,
      organizationId: cloudSession.activeOrganization?.id?.trim() ?? "",
    }),
    [cloudSession.activeOrganization?.id, cloudSession.baseUrl],
  );
  const [connectCapabilities, setConnectCapabilities] = useState<ConnectCapabilityInventory>(
    () => readCachedConnectCapabilities(connectScope) ?? EMPTY_CONNECT_CAPABILITY_INVENTORY,
  );
  const [connectCapabilitiesLoading, setConnectCapabilitiesLoading] = useState(false);
  const connectCapabilitiesRequestRef = useRef(0);
  const refreshConnectCapabilities = useCallback(async (options?: { force?: boolean }) => {
    const requestId = connectCapabilitiesRequestRef.current + 1;
    connectCapabilitiesRequestRef.current = requestId;
    if (!cloudSession.isSignedIn || !connectScope.organizationId) {
      setConnectCapabilities(EMPTY_CONNECT_CAPABILITY_INVENTORY);
      setConnectCapabilitiesLoading(false);
      return;
    }
    // Paint what the app already fetched, then revalidate behind it.
    const cached = readCachedConnectCapabilities(connectScope);
    if (cached) setConnectCapabilities(cached);
    setConnectCapabilitiesLoading(!cached);
    try {
      const inventory = await loadConnectCapabilities({
        client: cloudSession.client,
        scope: connectScope,
        maxAgeMs: options?.force ? 0 : undefined,
      });
      if (connectCapabilitiesRequestRef.current === requestId) {
        setConnectCapabilities(inventory);
      }
    } catch {
      if (connectCapabilitiesRequestRef.current === requestId && !cached) {
        setConnectCapabilities(EMPTY_CONNECT_CAPABILITY_INVENTORY);
      }
    } finally {
      if (connectCapabilitiesRequestRef.current === requestId) setConnectCapabilitiesLoading(false);
    }
  }, [cloudSession.client, cloudSession.isSignedIn, connectScope]);

  // Not gated on the Extensions tab: the inventory should be warm before the
  // user gets there, and the fetch is deduped by the shared cloud cache.
  useEffect(() => {
    void refreshConnectCapabilities({ force: true });
  }, [refreshConnectCapabilities]);

  const handleOpenProviderAuth = useCallback(() => {
    if (providerAuthStore.isProviderAddRestricted()) {
      restrictionNotice.show({
        title: t("restrictions.add_custom_providers_disabled_title"),
        message: t("restrictions.add_custom_providers_disabled_message"),
      });
      return;
    }

    void providerAuthStore.openProviderAuthModal();
  }, [providerAuthStore, restrictionNotice]);

  useEffect(() => {
    if (!activeClient || !selectedWorkspaceId) return;
    // Org policy may force Zen off. Never force it back on — that races user Disconnect.
    if (!checkDesktopRestriction({ restriction: "allowZenModel" })) return;

    void providerAuthStore
      .ensureProjectProviderDisabledState("opencode", true)
      .catch((error) => {
        console.warn("[desktop-app-restrictions] failed to sync Zen restriction", error);
      });
  }, [activeClient, checkDesktopRestriction, providerAuthStore, selectedWorkspaceId, selectedWorkspaceRoot]);

  const shareWorkspaceState = useShareWorkspaceState({
    workspaces,
    omnirushServerHostInfo: omnirushServerSnapshot.omnirushServerHostInfo,
    omnirushServerSettings: omnirushServerSnapshot.omnirushServerSettings,
    engineInfo: null,
    exportWorkspaceBusy,
    openLink: (url) => platform.openLink(url),
    workspaceLabel,
  });

  const debugViewProps = useDebugViewModel({
    developerMode,
    omnirushServerStore,
    omnirushServerSnapshot,
    runtimeWorkspaceId: selectedWorkspace?.id ?? null,
    selectedWorkspaceRoot,
    setRouteError: (message) => {
      if (message) {
        toast.error(message);
      }
    },
  });
  const electronUpdaterState = useDesktopUpdater();
  const { updateAutoCheck, setUpdateAutoCheck, updateAutoDownload, setUpdateAutoDownload } = electronUpdaterState;

  const workspaceSessionGroups = useMemo(
    // Settings has no per-workspace loading state; the empty set keeps the
    // previous behavior (error -> "error", otherwise "ready").
    () => toSessionGroups(workspaces, sessionsByWorkspaceId, errorsByWorkspaceId, new Set()),
    [errorsByWorkspaceId, sessionsByWorkspaceId, workspaces],
  );

  const runtimeWorkspaceId = selectedWorkspaceEndpoint?.workspaceId ?? selectedWorkspace?.id ?? null;
  routeStateRef.current.runtimeWorkspaceId = runtimeWorkspaceId;
  routeStateRef.current.selectedWorkspaceOmniRushClient = selectedWorkspaceEndpoint?.client ?? omnirushClient;
  const cloudMcpHealth = cloudMcpHealthResult?.workspaceId === runtimeWorkspaceId
    ? cloudMcpHealthResult.health
    : null;
  const handleCloudMcpHealthChange = useCallback((health: OmniRushCloudMcpHealth | null) => {
    const workspaceId = runtimeWorkspaceId?.trim() ?? "";
    if ((routeStateRef.current.runtimeWorkspaceId?.trim() ?? "") !== workspaceId) return;
    setCloudMcpHealthResult(health && workspaceId ? { workspaceId, health } : null);
  }, [runtimeWorkspaceId]);

  const opencodeClient = useMemo(() => {
    if (!selectedWorkspaceEndpoint || !selectedWorkspaceEndpoint.token) return null;
    return createClient(
      selectedWorkspaceEndpoint.opencodeBaseUrl,
      selectedWorkspaceRoot || undefined,
      {
        token: selectedWorkspaceEndpoint.token,
        mode: "omnirush",
      },
    );
  }, [selectedWorkspaceEndpoint, selectedWorkspaceRoot]);

  useEffect(() => {
    setActiveClient(opencodeClient);
  }, [opencodeClient]);

  const [libraryCommands, setLibraryCommands] = useState<LibraryCommandItem[]>([]);
  const [libraryAgents, setLibraryAgents] = useState<LibraryAgentItem[]>([]);
  const loadLibraryLists = useCallback(async () => {
    if (opencodeClient) {
      try {
        const [commands, agents] = await Promise.all([
          listCommands(opencodeClient, selectedWorkspaceRoot || undefined),
          opencodeClient.app.agents()
            .then((result) => unwrap(result))
            .catch(() => []),
        ]);
        setLibraryCommands(libraryCommandsFromSlashOptions(commands));
        setLibraryAgents(libraryAgentsFromOpencode(Array.isArray(agents) ? agents : []));
      } catch {
        setLibraryCommands([]);
        setLibraryAgents([]);
      }
    } else {
      setLibraryCommands([]);
      setLibraryAgents([]);
    }
    await refreshConnectCapabilities({ force: true });
  }, [opencodeClient, refreshConnectCapabilities, selectedWorkspaceRoot]);
  useEffect(() => {
    void loadLibraryLists();
  }, [loadLibraryLists]);

  const handleModelPickerLoadError = useCallback((error: unknown) => {
    toast.error(error instanceof Error ? error.message : t("app.unknown_error"));
  }, []);
  const handleModelPickerOpen = useCallback(() => {
    void providerAuthStore.runCloudProviderSync("model_picker_open");
  }, [providerAuthStore]);
  const modelPicker = useModelPicker({
    client: opencodeClient,
    baseUrl: opencodeBaseUrl,
    workspaceRoot: selectedWorkspaceRoot,
    onOpen: handleModelPickerOpen,
    onLoadError: handleModelPickerLoadError,
    cloudProvidersEnabled: cloudSession.isSignedIn,
  });
  const currentCloudMcpModel = useMemo<OmniRushCloudMcpProviderModelContext | null>(() => {
    const provider = local.prefs.defaultModel?.providerID.trim() ?? "";
    const model = local.prefs.defaultModel?.modelID.trim() ?? "";
    return provider && model ? { provider, model } : null;
  }, [local.prefs.defaultModel]);
  const refreshCloudMcpHealth = useCallback(async () => {
    const client = selectedWorkspaceEndpoint?.client ?? omnirushClient;
    const workspaceId = runtimeWorkspaceId?.trim() ?? "";
    if (!client || !workspaceId) {
      setCloudMcpHealthResult(null);
      return null;
    }
    // probe: the Advanced page refresh should verify the Cloud endpoint
    // directly (outside the engine), not just report the engine's cached state.
    const health = await client.getOmniRushCloudMcpHealth(workspaceId, currentCloudMcpModel ?? undefined, { probe: true });
    if (routeStateRef.current.runtimeWorkspaceId?.trim() !== workspaceId) return null;
    setCloudMcpHealthResult({ workspaceId, health });
    return health;
  }, [currentCloudMcpModel, omnirushClient, runtimeWorkspaceId, selectedWorkspaceEndpoint]);
  const { commandPaletteOpen, setCommandPaletteOpen } = useCommandPaletteShortcut(!props.embedded);
  const developerModePaletteItem = useMemo(
    () => settingsDeveloperModePaletteItem(developerMode, () => {
      setCommandPaletteOpen(false);
      toggleDeveloperMode();
    }),
    [developerMode, setCommandPaletteOpen, toggleDeveloperMode],
  );
  const paletteSessionOptions = useMemo(
    () => buildCommandPaletteSessions(workspaces, sessionsByWorkspaceId, selectedWorkspaceId),
    [sessionsByWorkspaceId, selectedWorkspaceId, workspaces],
  );
  const handleCreatePaletteSession = useCallback(async () => {
    if (!selectedWorkspaceEndpoint?.token || !selectedWorkspaceId) {
      navigate(selectedWorkspaceId ? workspaceSessionRoute(selectedWorkspaceId) : "/session");
      return;
    }
    try {
      const session = await createRouteSession(selectedWorkspaceEndpoint, selectedWorkspaceRoot || undefined);
      navigate(workspaceSessionRoute(selectedWorkspaceId, session.id));
    } catch (error) {
      toast.error(describeRouteError(error));
    }
  }, [navigate, selectedWorkspaceEndpoint, selectedWorkspaceId, selectedWorkspaceRoot]);
  // Settings refreshes provider auth whenever the picker opens (the session
  // route does not need this; its provider state is kept fresh elsewhere).
  useEffect(() => {
    if (!modelPicker.open) return;
    void providerAuthStore.refreshProviders();
  }, [modelPicker.open, providerAuthStore]);

  useEffect(() => {
    const refresh = () => setExtensionStateVersion((value) => value + 1);
    window.addEventListener(OMNIRUSH_EXTENSION_STATE_CHANGED, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(OMNIRUSH_EXTENSION_STATE_CHANGED, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime() || !isMacPlatform()) return;
    let cancelled = false;
    void desktopBridge.checkComputerUsePermissions()
      .then((result) => {
        if (cancelled) return;
        const permissions = normalizeComputerUsePermissions(result);
        if (permissions) setComputerUsePermissions(permissions);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!omnirushClient) {
      setUserEnvKeys([]);
      return;
    }
    let cancelled = false;
    void omnirushClient.listUserEnvKeys()
      .then((response) => { if (!cancelled) setUserEnvKeys(response.keys); })
      .catch(() => { if (!cancelled) setUserEnvKeys([]); });
    return () => { cancelled = true; };
  }, [omnirushClient]);

  const installOpenAiImageExtension = useCallback(async (apiKey: string) => {
    const resolvedApiKey = apiKey.trim();
    if (!omnirushClient) {
      setImageExtensionError("omnirush.ai server is not connected.");
      return;
    }
    if (!resolvedApiKey) {
      setImageExtensionError("OpenAI API key is required.");
      return;
    }

    setImageExtensionBusy(true);
    setImageExtensionStatus(null);
    setImageExtensionError(null);
    try {
      await omnirushClient.upsertUserEnv([{ key: "OPENAI_API_KEY", value: resolvedApiKey }]);
      setUserEnvKeys((current) => Array.from(new Set([...current, "OPENAI_API_KEY"])));
      setImageExtensionStatus("Saved OPENAI_API_KEY. Agents can use omnirush.ai extension actions for image generation.");
    } catch (error) {
      setImageExtensionError(describeRouteError(error));
    } finally {
      setImageExtensionBusy(false);
    }
  }, [omnirushClient]);

  const generateOpenAiTestImage = useCallback(async (input: { apiKey: string; prompt: string }) => {
    const client = selectedWorkspaceEndpoint?.client ?? omnirushClient;
    const workspaceId = runtimeWorkspaceId?.trim() ?? "";
    const apiKey = input.apiKey.trim();
    const prompt = input.prompt.trim();
    if (!client || !workspaceId) {
      setImageGenerationError("omnirush.ai server is not connected for this workspace.");
      return;
    }
    if (!apiKey) {
      setImageGenerationError("OpenAI API key is required.");
      return;
    }
    if (!prompt) {
      setImageGenerationError("Prompt is required.");
      return;
    }

    setImageGenerationBusy(true);
    setImageGenerationStatus(null);
    setImageGenerationError(null);
    try {
      if (omnirushClient) {
        await omnirushClient.upsertUserEnv([{ key: "OPENAI_API_KEY", value: apiKey }]);
        setUserEnvKeys((current) => Array.from(new Set([...current, "OPENAI_API_KEY"])));
      }
      const response = await client.callExtensionAction({
        extensionId: OPENAI_IMAGE_EXTENSION_ID,
        action: "image_generate",
        args: { prompt },
        context: { directory: selectedWorkspaceRoot || undefined },
      });
      if (!response.ok) {
        setImageGenerationError(response.message);
        return;
      }
      const result = response.result;
      const path = typeof result === "object" && result !== null && "path" in result && typeof result.path === "string"
        ? result.path
        : "an artifact";
      setImageGenerationStatus(`Generated ${path} with ${OPENAI_IMAGE_MODEL}.`);
    } catch (error) {
      setImageGenerationError(describeRouteError(error));
    } finally {
      setImageGenerationBusy(false);
    }
  }, [omnirushClient, runtimeWorkspaceId, selectedWorkspaceEndpoint, selectedWorkspaceRoot]);

  const installLocalProvider = useCallback(async (input: LocalProviderInstallInput) => {
    const client = selectedWorkspaceEndpoint?.client ?? omnirushClient;
    const workspaceId = runtimeWorkspaceId?.trim() ?? "";
    const modelId = input.modelId.trim();
    if (!client || !workspaceId) {
      setLocalProviderError("omnirush.ai server is not connected for this workspace.");
      return;
    }
    if (!modelId) {
      setLocalProviderError("Model ID is required.");
      return;
    }

    setLocalProviderBusy(true);
    setLocalProviderStatus(null);
    setLocalProviderError(null);
    try {
      await client.patchConfig(workspaceId, {
        opencode: {
          provider: {
            [input.providerId]: buildLocalProviderConfig({ ...input, modelId }),
          },
        },
      });
      if (input.setDefault) {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: { providerID: input.providerId, modelID: modelId },
          modelVariant: null,
        }));
      }
      reloadCoordinator.markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
      try {
        await reloadEngineOrRestartDesktop(client, workspaceId);
      } catch {
        // The reload toast still lets the user retry if the immediate reload fails.
      }
      await refreshProviderListQueries(getReactQueryClient());
      try {
        window.dispatchEvent(new CustomEvent("omnirush-server-settings-changed"));
      } catch {
        // ignore browser event dispatch failures
      }
      setLocalProviderStatus(`Added ${input.name} with ${modelId}.`);
    } catch (error) {
      setLocalProviderError(describeRouteError(error));
    } finally {
      setLocalProviderBusy(false);
    }
  }, [local, omnirushClient, reloadCoordinator, runtimeWorkspaceId, selectedWorkspaceEndpoint]);

  useEffect(() => {
    local.setUi((previous) => ({ ...previous, view: "settings", tab: route.tab }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- local is stable via context
  }, [route.tab]);

  useEffect(() => {
    setAppThemeMode(themeMode);
  }, [themeMode]);

  useEffect(() => {
    writeStoredBoolean(SETTINGS_HIDE_TITLEBAR_KEY, hideTitlebar);
  }, [hideTitlebar]);

  const {
    markRouteReady: markBootRouteReady,
    phase: bootPhase,
    routeReady: bootRouteReady,
  } = useBootState();
  const refreshRouteState = useMemo(() => async (options?: { supersede?: boolean }) => {
    const attempt = refreshLifecycleRef.current.begin(options);
    if (!attempt) return;
    setLoading(true);
    let desktopList: WorkspaceList | null = null;
    let desktopWorkspaces = workspacesRef.current;
    try {
      if (isDesktopRuntime()) {
        try {
          desktopList = await workspaceBootstrap() as WorkspaceList;
          desktopWorkspaces = (desktopList.workspaces ?? []).map(mapDesktopWorkspace);
        } catch (error) {
          const message = describeRouteError(error);
          console.error("[settings-route] workspaceBootstrap failed", error);
          recordInspectorEvent("route.workspace_bootstrap.error", {
            route: "settings",
            message,
            preservedWorkspaceCount: workspacesRef.current.length,
          });
          desktopWorkspaces = workspacesRef.current;
        }
      }
      if (!attempt.isCurrent()) return;

      const { normalizedBaseUrl, resolvedToken, resolvedHostToken } = await resolveOmniRushConnection();
      if (!attempt.isCurrent()) return;

      if (!normalizedBaseUrl || !resolvedToken) {
        setOmniRushClient(null);
        setBaseUrl("");
        setToken("");
        setWorkspaces(desktopWorkspaces);
        setSessionsByWorkspaceId({});
        setErrorsByWorkspaceId({});
        setLegacySelectedWorkspaceId((current) => {
          const next = current || readActiveWorkspaceId() || resolveWorkspaceListSelectedId(desktopList) || desktopWorkspaces[0]?.id || "";
          writeActiveWorkspaceId(next || null);
          return next;
        });
        return;
      }

      const client = createOmniRushServerClient({
        baseUrl: normalizedBaseUrl,
        token: resolvedToken,
        hostToken: resolvedHostToken || undefined,
      });
      const list = await client.listWorkspaces();
      if (!attempt.isCurrent()) return;
      serverActiveWorkspaceIdRef.current = list.activeId ?? "";
      const serverWorkspaceIds = new Set(list.items.map((workspace) => workspace.id));
      const nextWorkspaces = mergeRouteWorkspaces(list.items, desktopWorkspaces);
      const routeWorkspaceServerClientResolver = createWorkspaceServerClientResolver({
        baseUrl: normalizedBaseUrl,
        token: resolvedToken,
      });
      const routedWorkspaceId = routeWorkspaceIdRef.current;
      if (routedWorkspaceId && nextWorkspaces.some((workspace) => workspace.id === routedWorkspaceId)) {
        // Opening Settings unmounts the session route. Join its shared
        // selection queue and commit the routed workspace before Settings
        // performs any runtime-backed reads, so an older session switch
        // cannot retake the desktop/runtime/server state underneath them.
        setLegacySelectedWorkspaceId(routedWorkspaceId);
        writeActiveWorkspaceId(routedWorkspaceId);
        lastRequestedRouteWorkspaceIdRef.current = routedWorkspaceId;
        routeWorkspaceSelectionCommitter.request(routedWorkspaceId, async (workspaceId) => {
          await commitRouteWorkspaceSelection({
            workspaceId,
            desktopRuntime: isDesktopRuntime(),
            setDesktopSelected: workspaceSetSelected,
            setDesktopRuntimeActive: workspaceSetRuntimeActive,
            activateWorkspace: async (selectedId) => {
              const workspace = nextWorkspaces.find((item) => item.id === selectedId) ?? null;
              const endpoint = routeWorkspaceServerClientResolver(workspace);
              if (!endpoint) throw new Error(`Workspace endpoint unavailable for ${selectedId}.`);
              if (workspace?.workspaceType === "local" && serverActiveWorkspaceIdRef.current === selectedId) return;
              await endpoint.client.activateWorkspace(endpoint.workspaceId, { persist: true });
              if (workspace?.workspaceType === "local") serverActiveWorkspaceIdRef.current = selectedId;
            },
          });
        });
        await routeWorkspaceSelectionCommitter.settled();
        if (!attempt.isCurrent()) return;
      }
      const sessionEntries = await mapRouteWorkspaceLoads(
        nextWorkspaces,
        async (workspace) => {
          const endpoint = routeWorkspaceServerClientResolver(workspace);
          if (!endpoint) {
            return { workspaceId: workspace.id, sessions: [], error: null as string | null };
          }
          if (!endpoint.isRemote && !serverWorkspaceIds.has(workspace.id)) {
            return { workspaceId: workspace.id, sessions: [], error: null as string | null };
          }
          try {
            const response = await readRouteSessionsWithRetry({
              load: () => listRouteSessions(endpoint),
              retryDelaysMs: [250, 750, 1_500],
            });
            const workspaceRoot = normalizeDirectoryPath(workspace.path ?? "");
            const items = workspaceRoot && !endpoint.isRemote
              ? response.filter((session) =>
                  normalizeDirectoryPath(session?.directory ?? "") === workspaceRoot,
                )
              : response;
            return {
              workspaceId: workspace.id,
              sessions: items,
              error: null as string | null,
              connectionState: null as WorkspaceConnectionState | null,
            };
          } catch (error) {
            const fallback = error instanceof Error ? error.message : t("app.unknown_error");
            if (workspace.workspaceType === "remote") {
              const connectionState = await diagnoseRemoteWorkspaceTaskLoadFailure(workspace, fallback);
              return {
                workspaceId: workspace.id,
                sessions: [],
                error: connectionState.message ?? "Remote worker connection failed.",
                connectionState,
              };
            }
            return {
              workspaceId: workspace.id,
              sessions: [],
              error: fallback,
              connectionState: null,
            };
          }
        },
      );
      if (!attempt.isCurrent()) return;

      setOmniRushClient(client);
      setBaseUrl(normalizedBaseUrl);
      setToken(resolvedToken);
      setWorkspaces(nextWorkspaces);
      setSessionsByWorkspaceId(Object.fromEntries(sessionEntries.map((entry) => [entry.workspaceId, entry.sessions])));
      setErrorsByWorkspaceId(Object.fromEntries(sessionEntries.map((entry) => [entry.workspaceId, entry.error])));
      setWorkspaceConnectionOverrides((current) => {
        const next = { ...current };
        for (const entry of sessionEntries) {
          if (entry.connectionState) {
            next[entry.workspaceId] = entry.connectionState;
          } else if (next[entry.workspaceId]?.status === "error") {
            delete next[entry.workspaceId];
          }
        }
        return next;
      });
      setLegacySelectedWorkspaceId((current) => {
        const sessionWorkspaceId = findSessionWorkspaceId(navigationSessionId, sessionEntries);
        const preferred = routeWorkspaceIdRef.current || sessionWorkspaceId || navigationWorkspaceId || current || readActiveWorkspaceId() || "";
        const next = reconcileSelectedWorkspaceId(preferred, list, desktopList, nextWorkspaces);
        writeActiveWorkspaceId(next || null);
        return next;
      });
    } catch (error) {
      if (!attempt.isCurrent()) return;
      const message = describeRouteError(error);
      console.error("[settings-route] refreshRouteState failed", error);
      recordInspectorEvent("route.refresh.error", {
        route: "settings",
        message,
        preservedWorkspaceCount: desktopWorkspaces.length,
      });
      // Fires on mount/auto-refresh too, not just user actions.
      notifyAlert({
        kind: "system",
        title: t("notifications.refresh_failed"),
        body: message,
        dedupeKey: "settings-route-refresh",
      });
      if (desktopWorkspaces.length > 0) {
        setWorkspaces(desktopWorkspaces);
        setLegacySelectedWorkspaceId((current) => {
          const next = current || readActiveWorkspaceId() || resolveWorkspaceListSelectedId(desktopList) || desktopWorkspaces[0]?.id || "";
          writeActiveWorkspaceId(next || null);
          return next;
        });
      }
    } finally {
      attempt.finish();
      if (attempt.isCurrent()) {
        setLoading(false);
        // Settings can be the first route a user lands on (direct link, deep
        // link, or after reload). Let the boot overlay dismiss once we've
        // completed our first data load.
        markBootRouteReady();
      }
    }
  }, [markBootRouteReady, navigationSessionId, navigationWorkspaceId, routeWorkspaceId]);

  const reloadWorkspaceEngineFromUi = useCallback(async () => {
    const workspaceId = routeStateRef.current.runtimeWorkspaceId?.trim() || selectedWorkspaceId.trim();
    if (!omnirushClient || !workspaceId) {
      toast.error(t("app.error_connect_first"));
      return false;
    }

    await reloadEngineOrRestartDesktop(omnirushClient, workspaceId, refreshRouteState);
    await refreshProviderListQueries(getReactQueryClient());

    try {
      window.dispatchEvent(new CustomEvent("omnirush-server-settings-changed"));
    } catch {
      // ignore browser event dispatch failures
    }

    // OpenCode reconnects MCPs async after dispose — the store polls until
    // statuses settle so users don't have to collapse/expand the card.
    void pollMcpServersAfterReloadRef.current?.();

    return true;
  }, [omnirushClient, refreshRouteState, selectedWorkspaceId]);

  useEffect(() => {
    return reloadCoordinator.registerWorkspaceReloadControls({
      canReloadWorkspaceEngine: () => Boolean(omnirushClient && (selectedWorkspace?.id || selectedWorkspaceId)),
      reloadWorkspaceEngine: reloadWorkspaceEngineFromUi,
      activeSessions: () => activeReloadBlockingSessions,
      stopSession: async (sessionId) => {
        if (!activeClient) return;
        await abortSessionSafe(activeClient, sessionId, undefined, {
          source: "settings.reload_workspace.stop_session",
          initiator: "user",
          reason: "stop active session before workspace engine reload",
        });
      },
    });
  }, [
    activeClient,
    activeReloadBlockingSessions,
    omnirushClient,
    reloadCoordinator,
    reloadWorkspaceEngineFromUi,
    selectedWorkspace?.id,
    selectedWorkspaceId,
  ]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    if (!routeWorkspaceId || lastRequestedRouteWorkspaceIdRef.current === routeWorkspaceId) return;
    if (!workspaces.some((workspace) => workspace.id === routeWorkspaceId)) return;
    setLegacySelectedWorkspaceId(routeWorkspaceId);
    writeActiveWorkspaceId(routeWorkspaceId);
    lastRequestedRouteWorkspaceIdRef.current = routeWorkspaceId;
    routeWorkspaceSelectionCommitter.request(
      routeWorkspaceId,
      (workspaceId) => workspaceSelectionCommitRef.current(workspaceId),
    );
  }, [routeWorkspaceId, workspaces]);

  useEffect(() => {
    const activeWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    setWorkspaceConnectionOverrides((current) => {
      let changed = false;
      const next: Record<string, WorkspaceConnectionState> = {};
      for (const [workspaceId, state] of Object.entries(current)) {
        if (activeWorkspaceIds.has(workspaceId)) {
          next[workspaceId] = state;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [workspaces]);

  const handleRemoteWorkspaceConnectionSaved = useCallback(
    async (workspaceId: string) => {
      delete remoteWorkspaceCheckRunRef.current[workspaceId];
      setWorkspaceConnectionOverrides((current) => {
        const next = { ...current };
        delete next[workspaceId];
        return next;
      });
      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      await refreshRouteState();
    },
    [refreshRouteState],
  );

  const remoteWorkspaceConnectionEditor = useRemoteWorkspaceConnectionEditor({
    workspaces,
    client: omnirushClient,
    onSaved: handleRemoteWorkspaceConnectionSaved,
  });

  const runRemoteWorkspaceConnectionCheck = useCallback(
    async (workspaceId: string, mode: "test" | "recover") => {
      const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
      if (!workspace || workspace.workspaceType !== "remote") return false;
      const connectionKey = getRemoteWorkspaceConnectionKey(workspace);
      remoteWorkspaceCheckRunCounterRef.current += 1;
      const runId = String(remoteWorkspaceCheckRunCounterRef.current);
      remoteWorkspaceCheckRunRef.current[workspaceId] = runId;

      setWorkspaceConnectionOverrides((current) => ({
        ...current,
        [workspaceId]: {
          status: "connecting",
          message: t("config.testing_connection"),
          checkedAt: null,
        },
      }));

      const result = await testRemoteWorkspaceConnection(workspace);
      const currentWorkspace = workspacesRef.current.find((item) => item.id === workspaceId);
      if (
        remoteWorkspaceCheckRunRef.current[workspaceId] !== runId ||
        !currentWorkspace ||
        getRemoteWorkspaceConnectionKey(currentWorkspace) !== connectionKey
      ) {
        if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
          delete remoteWorkspaceCheckRunRef.current[workspaceId];
        }
        return false;
      }
      setWorkspaceConnectionOverrides((current) => ({
        ...current,
        [workspaceId]: result.state,
      }));

      if (!result.ok) {
        setErrorsByWorkspaceId((current) => ({
          ...current,
          [workspaceId]: result.state.message ?? "Remote worker connection failed.",
        }));
        if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
          delete remoteWorkspaceCheckRunRef.current[workspaceId];
        }
        return false;
      }

      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      if (mode === "recover") {
        await refreshRouteState();
      }
      if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
        delete remoteWorkspaceCheckRunRef.current[workspaceId];
      }
      return true;
    },
    [refreshRouteState],
  );

  useEffect(() => {
    if (omnirushClient) {
      reconnectAttemptedWorkspaceIdRef.current = "";
    }
    // Same gate as the session route: reconnect must not probe the local
    // server while desktop runtime bootstrap is still starting it.
    if (
      !shouldAttemptDesktopLocalReconnect({
        desktopRuntime: isDesktopRuntime(),
        bootPhase,
        bootRouteReady,
        routeLoading: loading,
        hasClient: Boolean(omnirushClient),
        connectionPending: false,
        workspaceType: selectedWorkspace?.workspaceType ?? null,
      })
    ) {
      return;
    }
    if (!selectedWorkspace) return;
    const workspaceId = selectedWorkspace.id?.trim() ?? "";
    if (!workspaceId || reconnectAttemptedWorkspaceIdRef.current === workspaceId) return;
    reconnectAttemptedWorkspaceIdRef.current = workspaceId;

    void ensureDesktopLocalOmniRushConnection({
      route: "settings",
      workspace: selectedWorkspace,
      allWorkspaces: workspaces,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : describeRouteError(error);
      // Background auto-reconnect: alert + persistent center entry.
      notifyAlert({
        kind: "system",
        title: t("notifications.reconnect_failed"),
        body: message,
        dedupeKey: "server-reconnect",
      });
    });
  }, [bootPhase, bootRouteReady, loading, omnirushClient, selectedWorkspace, workspaces]);

  useEffect(() => {
    // A workspace-route change must invalidate the previous refresh even if
    // it is still waiting on that workspace's runtime. The superseded attempt
    // can finish its network calls, but it can no longer write Settings state.
    void refreshRouteState({ supersede: true });
    const handleSettingsChange = () => {
      void refreshRouteState({ supersede: true });
    };
    window.addEventListener("omnirush-server-settings-changed", handleSettingsChange);
    return () => {
      window.removeEventListener("omnirush-server-settings-changed", handleSettingsChange);
    };
  }, [refreshRouteState]);

  // Load auto-compaction state from OpenCode config on workspace change.
  useEffect(() => {
    if (!omnirushClient || !selectedWorkspaceId) return;
    const workspaceId = routeStateRef.current.runtimeWorkspaceId?.trim() || selectedWorkspaceId;
    let cancelled = false;
    (async () => {
      try {
        const config = await omnirushClient.getConfig(workspaceId);
        if (cancelled) return;
        const compaction = config.opencode?.compaction;
        const auto = compaction && typeof compaction === "object" && "auto" in compaction
          ? (compaction as { auto?: boolean }).auto
          : undefined;
        setAutoCompactContext(auto !== false);
        setAutoCompactContextLoaded(true);
      } catch {
        if (!cancelled) setAutoCompactContextLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [omnirushClient, selectedWorkspaceId]);

  const toggleAutoCompactContext = useCallback(async () => {
    if (autoCompactContextBusy) return;
    const workspaceId = routeStateRef.current.runtimeWorkspaceId?.trim() || selectedWorkspaceId;
    if (!omnirushClient || !workspaceId) return;
    const next = !autoCompactContext;
    setAutoCompactContext(next);
    setAutoCompactContextBusy(true);
    try {
      await omnirushClient.patchConfig(workspaceId, {
        opencode: { compaction: { auto: next } },
      });
      reloadCoordinator.markReloadRequired("config", {
        type: "config",
        name: "opencode.json",
        action: "updated",
      });
    } catch {
      setAutoCompactContext(!next);
    } finally {
      setAutoCompactContextBusy(false);
    }
  }, [autoCompactContext, autoCompactContextBusy, omnirushClient, reloadCoordinator, selectedWorkspaceId]);

  useEffect(() => {
    omnirushServerStore.start();
    connectionsStore.start();
    providerAuthStore.start();
    extensionsStore.start();

    return () => {
      extensionsStore.dispose();
      providerAuthStore.dispose();
      connectionsStore.dispose();
      omnirushServerStore.dispose();
    };
  }, [connectionsStore, extensionsStore, omnirushServerStore, providerAuthStore]);

  const refreshMarketplaceAction = useMemo<OmniRushControlAction>(() => ({
    id: "extensions.refresh-marketplace",
    label: "Refresh marketplace extensions",
    description: "Force a fresh sync of organization marketplace plugins from the cloud.",
    sideEffect: "mutation",
    execute: async () => {
      await extensionsStore.refreshCloudOrgMarketplaces({ force: true });
      return { marketplaceCount: extensionsStore.cloudOrgMarketplaces().length };
    },
  }), [extensionsStore]);
  useControlAction(refreshMarketplaceAction);

  // Periodically reconcile workspace-imported cloud providers from Den while
  // signed in (dev #1509 "auto-sync cloud providers"). Mounted here because
  // the settings route owns the provider-auth store.
  useCloudProviderAutoSync(providerAuthStore.runCloudProviderSync);

  // Keep the Den cloud MCP configured with a fresh first-party token while
  // signed in: connects on sign-in, re-mints on org switch and before expiry.
  useCloudProviderAutoSync(() => connectionsStore.syncCloudControlMcp());

  useEffect(() => {
    if (route.tab !== "cloud-providers" && route.tab !== "ai") return;
    void providerAuthStore.runCloudProviderSync("settings_cloud_opened");
  }, [providerAuthStore, route.tab]);

  useEffect(() => {
    omnirushServerStore.syncFromOptions();
    connectionsStore.syncFromOptions();
    providerAuthStore.syncFromOptions();
    extensionsStore.syncFromOptions();
  }, [
    activeClient,
    connectionsStore,
    extensionsStore,
    omnirushServerStore,
    providerAuthStore,
    selectedWorkspace?.id,
    selectedWorkspace?.workspaceType,
    selectedWorkspaceRoot,
  ]);

  useEffect(() => {
    if (!activeClient) {
      setProviders([]);
      setProviderDefaults({});
      setProviderConnectedIds([]);
      setDisabledProviders([]);
      return;
    }
    void providerAuthStore.refreshProviders();
    void connectionsStore.refreshMcpServers();
  }, [activeClient, connectionsStore, providerAuthStore, selectedWorkspace?.id]);

  const selectedWorkspaceName = selectedWorkspace
    ? workspaceLabel(selectedWorkspace)
    : t("session.workspace_fallback");
  const workspaceOptions = workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspaceLabel(workspace),
    color: workspaceSwatchColor(workspace.id),
  }));
  const selectedWorkspaceColor = workspaceSwatchColor(selectedWorkspaceId);
  const workspaceType = selectedWorkspace?.workspaceType ?? "local";
  const isRemoteWorkspace = workspaceType === "remote";
  const canWriteWorkspacePlugins =
    !isRemoteWorkspace || omnirushServerSnapshot.omnirushServerCanWritePlugins;
  const pluginsAccessHint =
    isRemoteWorkspace && !canWriteWorkspacePlugins ? t("app.plugins_hint_readonly") : null;
  const defaultModelLabel = local.prefs.defaultModel
    ? (() => {
        const provider = providers.find((item) => item.id === local.prefs.defaultModel?.providerID);
        const model = provider?.models?.[local.prefs.defaultModel.modelID];
        const providerLabel = resolveModelProviderDisplayName(
          local.prefs.defaultModel.providerID,
          local.prefs.defaultModel.modelID,
          provider?.name,
          model?.name,
        );
        const modelLabel = resolveModelDisplayName(local.prefs.defaultModel.modelID, model?.name);
        return `${providerLabel} - ${modelLabel}`;
      })()
    : t("session.default_model");
  const defaultModelRef = local.prefs.defaultModel
    ? `${local.prefs.defaultModel.providerID}/${local.prefs.defaultModel.modelID}`
    : t("settings.default_label");
  const defaultModelVariantLabel = local.prefs.modelVariant ?? t("settings.default_label");
  const visibleProviderConnectedIds = providerConnectedIds.filter(
    isSupportedModelProvider,
  );
  const providerStatusLabel = visibleProviderConnectedIds.length > 0 ? t("status.connected") : t("status.disconnected_label");
  const providerStatusStyle = visibleProviderConnectedIds.length > 0
    ? "bg-green-7/10 text-green-11 border-green-7/20"
    : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  const providerSummary = visibleProviderConnectedIds.length > 0
    ? t("status.providers_connected", { count: visibleProviderConnectedIds.length })
    : t("settings.no_providers_connected");
  const providerConnectedIdSet = new Set(visibleProviderConnectedIds);
  const disabledProviderIdSet = new Set(
    disabledProviders.map((id) => id.trim().toLowerCase()).filter(Boolean),
  );
  const connectedProviders = providers.flatMap((provider) =>
    providerConnectedIdSet.has(provider.id) &&
    !disabledProviderIdSet.has(provider.id.trim().toLowerCase())
      ? [{
          id: provider.id,
          name: provider.name ?? provider.id,
          source: provider.source,
        }]
      : [],
  );
  const omnirushCloudMcpUrl = connectionsSnapshot.mcpServers.find(
    (server) => server.name === "omnirush-cloud",
  )?.config.url ?? null;

  // Build enablement context from all available runtime state.
  const enablementContext = useMemo<EnablementContext>(() => {
    const mcpConfigured = new Set(connectionsSnapshot.mcpServers.map((s) => s.name));
    const connectedProviders = new Set(providerConnectedIds);
    const configuredEnvKeys = new Set(userEnvKeys);
    const loadedPlugins = new Set<string>();
    // Browser plugin detection: check if any configured plugin matches the chrome-devtools name.
    // For now, treat it as loaded if the plugin is in the MCP/plugin list — this will
    // be refined when we add a real plugin-loaded signal from the engine.
    const browserPluginConfigured = connectionsSnapshot.mcpServers.some(
      (s) => s.name === "opencode-chrome-devtools" || s.config.command?.some((c: string) => c.includes("chrome-devtools")),
    );
    if (browserPluginConfigured) loadedPlugins.add("opencode-chrome-devtools");

    return {
      mcpStatuses: connectionsSnapshot.mcpStatuses,
      mcpConfigured,
      loadedPlugins,
      connectedProviders,
      configuredEnvKeys,
      permissions: computerUsePermissions ?? undefined,
      // Toggle state reader for extensions with defaultEnabled / explicit toggle.
      isToggleEnabled: (ref: string) => {
        const catalog = connectionsStore.quickConnect;
        const match = catalog.find((e: { id?: string; serverName?: string }) => (e.id ?? e.serverName) === ref);
        return match ? isOmniRushExtensionEnabled(match) : false;
      },
    };
  }, [computerUsePermissions, connectionsSnapshot, extensionStateVersion, providerConnectedIds, userEnvKeys]);
  const allowManageExtensions = !checkDesktopRestriction({ restriction: "allowManageExtensions" });
  const builtInExtensionsDisabled = checkDesktopRestriction({ restriction: "allowBuiltInExtensions" });
  const restartExtensionLocalServer = useCallback(async () => {
    if (!isDesktopRuntime()) return false;
    try {
      await omnirushServerRestart({
        reason: "extension_settings_restart",
        userInitiated: true,
        remoteAccessEnabled:
          readOmniRushServerSettings().remoteAccessEnabled === true,
      });
      await omnirushServerStore.reconnectOmniRushServer();
      await refreshRouteState();
      return true;
    } catch {
      return false;
    }
  }, [omnirushServerStore, refreshRouteState]);
  const extensionController = useSettingsExtensionController({
    omnirushServerClient: selectedWorkspaceEndpoint?.client ?? omnirushClient,
    hostOmniRushServerClient: omnirushClient,
    enablementContext,
    mcpServers: connectionsSnapshot.mcpServers,
    mcpConnectingName: connectionsSnapshot.mcpConnectingName,
    onComputerUsePermissionsChange: setComputerUsePermissions,
    restartLocalServer: restartExtensionLocalServer,
    connectMcp: async (entry) => {
      const result = await connectionsStore.connectMcp(entry);
      if (!result.ok) throw new Error(result.error);
    },
    refreshMcpServers: () => connectionsStore.refreshMcpServers(),
    providers,
    providerConnectedIds,
    userEnvKeys,
    imageExtension: {
      busy: imageExtensionBusy || imageGenerationBusy,
      status: imageExtensionStatus ?? imageGenerationStatus,
      error: imageExtensionError ?? imageGenerationError,
      onInstall: installOpenAiImageExtension,
      onTestGenerate: generateOpenAiTestImage,
    },
    localProvider: {
      busy: localProviderBusy,
      status: localProviderStatus,
      error: localProviderError,
      onInstall: installLocalProvider,
    },
  });
  const extensionCatalogPlatform = resolveOmniRushExtensionCatalogPlatform(platform.platform, platform.os);
  const quickConnectCatalog = useMemo(
    () => filterOmniRushExtensionCatalogForPlatform(connectionsStore.quickConnect, extensionCatalogPlatform),
    [connectionsStore.quickConnect, extensionCatalogPlatform],
  );
  const extensionItems = useMemo(
    () => buildExtensionItems({
      quickConnect: quickConnectCatalog,
      mcpServers: connectionsSnapshot.mcpServers,
      installedSkills: extensionsStore.skills(),
      importedCloudPlugins: extensionsSnapshot.importedCloudPlugins,
      pendingCloudPluginChanges: extensionsSnapshot.pendingCloudPluginChanges,
      cloudMarketplaces: extensionsSnapshot.cloudOrgMarketplaces,
      orgMcpConnections: orgMcpConnections.connections,
      enablementContext,
      isBuiltInConnected: extensionController.isConnected,
    }),
    [connectionsSnapshot.mcpServers, enablementContext, extensionController.isConnected, extensionsSnapshot, extensionsStore, orgMcpConnections.connections, quickConnectCatalog],
  );
  // Every connection the organization provisioned for this member, connected
  // or not: one that still needs the member's sign-in is the whole reason the
  // "Needs your attention" group exists, so it must not be filtered out here.
  const orgMcpConnectionItems = extensionItems.orgMcpConnectionItems;
  const librarySkills = useMemo(
    () => [
      ...extensionItems.installedSkills,
      ...connectCapabilities.skills.filter(
        (skill) => !extensionItems.installedSkills.some(
          (installed) => installed.name.toLowerCase() === skill.name.toLowerCase(),
        ),
      ),
    ],
    [connectCapabilities.skills, extensionItems.installedSkills],
  );
  const libraryConnectMcpServers = useMemo(
    () => connectCapabilities.mcpServers.filter(
      (entry) => !orgMcpConnectionItems.some((item) =>
        item.name.localeCompare(entry.name, undefined, { sensitivity: "accent" }) === 0
      ),
    ),
    [connectCapabilities.mcpServers, orgMcpConnectionItems],
  );
  const libraryConnectPlugins = useMemo(
    () => connectPluginsForComposer(connectCapabilities.plugins),
    [connectCapabilities.plugins],
  );
  const readLibrarySkill = useCallback(
    (name: string) => extensionsStore.readSkill(name),
    [extensionsStore],
  );
  const organizationConnectionsProbe = resolveOrganizationConnectionsProbe({
    signedIn: cloudSession.isSignedIn,
    activeOrganizationId: cloudSession.activeOrganization?.id,
    loading: orgMcpConnections.loading,
    loaded: orgMcpConnections.loaded,
    error: orgMcpConnections.error,
  });
  const diagnosticsClient = selectedWorkspaceEndpoint?.client ?? omnirushClient;
  const diagnosticsWorkspaceAllowed = isAgentContextDiagnosticsWorkspaceAllowed(selectedWorkspace);
  const diagnosticsAvailable = Boolean(
    diagnosticsClient
    && runtimeWorkspaceId?.trim()
    && diagnosticsWorkspaceAllowed,
  );
  const diagnosticsUnavailableReason = selectedWorkspace?.workspaceType === "remote"
    && selectedWorkspace.remoteType !== "omnirush"
    ? "direct-remote-opencode" as const
    : null;
  const diagnosticsWorkspaceType = selectedWorkspace?.workspaceType === "remote"
    ? selectedWorkspace.remoteType ?? "legacy-opencode"
    : "local";
  const diagnosticsScopeKey = useMemo(() => createOpaqueDiagnosticsScopeKey({
    client: diagnosticsClient,
    workspaceCredential: selectedWorkspaceEndpoint?.token ?? token,
    workspaceId: runtimeWorkspaceId?.trim() ?? "",
    workspaceType: diagnosticsWorkspaceType,
    denBaseUrl: cloudSession.baseUrl,
    denCredential: cloudSession.authToken,
    denSignedIn: cloudSession.isSignedIn,
    organizationId: cloudSession.activeOrganization?.id ?? "signed-out",
    principalId: cloudSession.user?.id ?? "signed-out",
  }), [
    cloudSession.activeOrganization?.id,
    cloudSession.authToken,
    cloudSession.baseUrl,
    cloudSession.isSignedIn,
    cloudSession.user?.id,
    diagnosticsClient,
    diagnosticsWorkspaceType,
    runtimeWorkspaceId,
    selectedWorkspaceEndpoint?.token,
    token,
  ]);
  const runAgentContextDiagnostics = useCallback(async () => {
    const client = selectedWorkspaceEndpoint?.client ?? omnirushClient;
    const workspaceId = runtimeWorkspaceId?.trim() ?? "";
    if (
      !client
      || !workspaceId
      || !selectedWorkspace
      || !isAgentContextDiagnosticsWorkspaceAllowed(selectedWorkspace)
    ) {
      throw new Error("Agent diagnostics require a connected workspace.");
    }
    const observations = await collectAgentContextDiagnosticObservations({
      organizationConnections: orgMcpConnections.connections,
      organizationConnectionsProbe,
      workspaceType: selectedWorkspace.workspaceType,
    });
    return client.runAgentContextDiagnostics(workspaceId, observations);
  }, [
    omnirushClient,
    organizationConnectionsProbe,
    orgMcpConnections.connections,
    runtimeWorkspaceId,
    selectedWorkspace,
    selectedWorkspaceEndpoint,
  ]);
  const routeOmniRushStatus = omnirushClient ? "connected" : "disconnected";
  const notFoundRouteError = !loading && routeWorkspaceId && !selectedWorkspace
    ? "Workspace was not found. Select a new workspace from the sidebar."
    : null;
  useEffect(() => {
    if (notFoundRouteError) {
      notifyAlert({
        kind: "system",
        title: notFoundRouteError,
        dedupeKey: "workspace-not-found",
      });
    }
  }, [notFoundRouteError]);
  const routeOmniRushCapabilities: OmniRushServerCapabilities | null = omnirushClient
    ? ROUTE_OMNIRUSH_CAPABILITIES
    : null;
  const environmentRuntimeKey = buildOmniRushEnvRuntimeKey({
    baseUrl: omnirushServerSnapshot.omnirushServerBaseUrl || omnirushServerSnapshot.omnirushServerUrl,
    pid: omnirushServerSnapshot.omnirushServerHostInfo?.pid ?? null,
    port: omnirushServerSnapshot.omnirushServerHostInfo?.port ?? null,
  });

  const handleApplyEnvironmentChanges = async () => {
    if (!isDesktopRuntime()) {
      throw new Error(t("settings.environment.apply_unavailable"));
    }
    if (activeReloadBlockingSessions.length > 0) {
      throw new Error(t("settings.environment.apply_blocked_active_tasks"));
    }
    if (!selectedWorkspaceRoot) {
      throw new Error(t("settings.environment.apply_no_local_workspace"));
    }
    const workspacePaths = Array.from(
      new Set(
        workspaces.flatMap((workspace) => {
          const path = workspace.workspaceType !== "remote" ? workspace.path?.trim() ?? "" : "";
          return path ? [path] : [];
        }),
      ),
    );
    const workspacePathSet = new Set(workspacePaths);
    if (!workspacePathSet.has(selectedWorkspaceRoot)) {
      workspacePaths.unshift(selectedWorkspaceRoot);
    }
    await engineStart(selectedWorkspaceRoot, {
      reason: "environment_applied",
      userInitiated: true,
      preferSidecar: true,
      runtime: "direct",
      workspacePaths,
      omnirushRemoteAccess: omnirushServerSnapshot.omnirushServerSettings.remoteAccessEnabled === true,
    });
    const reconnected = await omnirushServerStore.reconnectOmniRushServer();
    if (!reconnected) {
      await refreshRouteState().catch(() => {});
      return { statusMessage: t("settings.environment.apply_refresh_failed") };
    }
    await refreshRouteState();
  };

  const handleSelectSettingsWorkspace = useCallback((workspaceId: string) => {
    if (workspaceId === selectedWorkspaceId) return;
    setLegacySelectedWorkspaceId(workspaceId);
    writeActiveWorkspaceId(workspaceId);
    lastRequestedRouteWorkspaceIdRef.current = workspaceId;
    routeWorkspaceSelectionCommitter.request(
      workspaceId,
      (selectedId) => workspaceSelectionCommitRef.current(selectedId),
    );
    navigate(
      props.standaloneExtensions
        ? workspaceExtensionsRoute(workspaceId, extensionsPathForRoute(route))
        : workspaceSettingsRoute(workspaceId, settingsPathForRoute(route)),
      { state: location.state },
    );
  }, [location, navigate, props.standaloneExtensions, route, selectedWorkspaceId]);

  const handleOpenRenameWorkspace = useCallback((workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    setRenameWorkspaceId(workspaceId);
    setRenameWorkspaceTitle(workspaceLabel(workspace));
  }, [workspaces]);

  const handleSaveRenameWorkspace = useCallback(async () => {
    if (!renameWorkspaceId) return;
    const trimmed = renameWorkspaceTitle.trim();
    if (!trimmed) return;
    setRenameWorkspaceBusy(true);
    try {
      if (!omnirushClient) {
        toast.error("omnirush.ai server is unavailable. Reconnect the server before renaming workspaces.");
        return;
      }
      await omnirushClient.updateWorkspaceDisplayName(renameWorkspaceId, trimmed);
      setRenameWorkspaceId(null);
      setRenameWorkspaceTitle("");
      await refreshRouteState();
    } catch (error) {
      toast.error("Workspace rename failed", {
        description: describeRouteError(error),
      });
    } finally {
      setRenameWorkspaceBusy(false);
    }
  }, [omnirushClient, refreshRouteState, renameWorkspaceId, renameWorkspaceTitle]);

  const handleRevealWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const path = workspace?.path?.trim();
    if (!path || !isDesktopRuntime()) return;
    await revealDesktopItemInDir(path).catch(() => undefined);
  }, [workspaces]);

  const handleExportWorkspaceConfig = useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
    if (!workspace) return;
    const endpoint = workspaceServerClientResolver(workspace);
    if (endpoint) {
      setExportWorkspaceBusy(true);
      try {
        const payload = await endpoint.client.exportWorkspace(endpoint.workspaceId);
        downloadWorkspaceJson(workspaceExportFilename(workspace), payload);
      } finally {
        setExportWorkspaceBusy(false);
      }
      return;
    }
    throw new Error("omnirush.ai server is unavailable. Reconnect the server before exporting workspace config.");
  }, [workspaceServerClientResolver, workspaces]);

  const removeWorkspaceConfirmed = useCallback(async (workspaceId: string): Promise<void> => {
    try {
      await removeRouteWorkspace({
        workspaceId,
        deleteFromServer: omnirushClient ? (id) => omnirushClient.deleteWorkspace(id) : null,
        forgetOnDesktop: isDesktopRuntime() ? workspaceForget : null,
        closeTerminals: closeWorkspaceTerminals,
      });
    } catch (error) {
      console.error("[settings-route] remove workspace failed", error);
      toast.error(t("workspace_list.remove_failed"), {
        id: `workspace-remove:${workspaceId}`,
        duration: 30_000,
        description: describeRouteError(error),
        action: { label: t("common.retry"), onClick: () => void removeWorkspaceConfirmed(workspaceId) },
      });
      await refreshRouteState();
      return;
    }
    if (selectedWorkspaceId === workspaceId) {
      const nextWorkspace = workspaces.find((workspace) => workspace.id !== workspaceId);
      const nextId = nextWorkspace?.id ?? "";
      setLegacySelectedWorkspaceId(nextId);
      if (nextId) {
        await workspaceSetSelected(nextId).catch(() => undefined);
      }
    }
    await refreshRouteState();
  }, [omnirushClient, refreshRouteState, selectedWorkspaceId, workspaces]);

  const handleForgetWorkspace = useCallback(async (workspaceId: string) => {
    if (typeof window !== "undefined") {
      const message = t("workspace_list.remove_confirm") || "Remove this workspace from the sidebar?";
      if (!window.confirm(message)) return;
    }
    await removeWorkspaceConfirmed(workspaceId);
  }, [removeWorkspaceConfirmed]);

  if (route.redirectPath && !props.embedded) {
    const target = props.standaloneExtensions
      ? selectedWorkspaceId
        ? workspaceExtensionsRoute(selectedWorkspaceId, extensionsPathForRoute(route))
        : globalExtensionsRoute(extensionsPathForRoute(route))
      : selectedWorkspaceId
        ? workspaceSettingsRoute(selectedWorkspaceId, route.redirectPath)
        : `/settings/${route.redirectPath}`;
    return <Navigate to={target} replace state={location.state} />;
  }

  if (!props.embedded && !routeWorkspaceId && selectedWorkspaceId) {
    const target = props.standaloneExtensions
      ? workspaceExtensionsRoute(selectedWorkspaceId, extensionsPathForRoute(route))
      : workspaceSettingsRoute(selectedWorkspaceId, settingsPathForRoute(route));
    return <Navigate to={target} replace state={location.state} />;
  }

  if (!props.embedded && settingsTabBlocked) {
    // Organization policy hides desktop settings. Library deep links keep
    // working through the standalone Library surface; everything else lands on
    // the Cloud account tab, which explains the active policy.
    const target = route.tab === "extensions"
      ? selectedWorkspaceId
        ? workspaceExtensionsRoute(selectedWorkspaceId, extensionsPathForRoute(route))
        : globalExtensionsRoute(extensionsPathForRoute(route))
      : selectedWorkspaceId
        ? workspaceSettingsRoute(selectedWorkspaceId, SETTINGS_TAB_WITHOUT_CONTROL)
        : `/settings/${SETTINGS_TAB_WITHOUT_CONTROL}`;
    return <Navigate to={target} replace state={location.state} />;
  }

  const openCloudAccountSettings = () => {
    navigateSettingsPath("general");
  };

  const settingsView = (() => {
    switch (route.tab) {
      case "general":
        return (
          <GeneralSettingsView
            onNavigateTab={(tab) => navigateSettingsPath(tab)}
            developerMode={developerMode}
            omnirushClient={omnirushClient}
            runtimeWorkspaceId={runtimeWorkspaceId}
            buildDiagnosticsBundle={() => buildDiagnosticsBundleJson({
              developerMode,
              omnirushServerStatus: routeOmniRushStatus,
              runtimeWorkspaceId,
              selectedWorkspaceId,
            })}
          />
        );
      case "permissions":
        return (
          <SettingsStack>
            <AuthorizedFoldersPanel
              omnirushServerClient={omnirushClient}
              omnirushServerStatus={routeOmniRushStatus}
              omnirushServerCapabilities={routeOmniRushCapabilities}
              runtimeWorkspaceId={runtimeWorkspaceId}
              selectedWorkspaceRoot={selectedWorkspaceRoot}
              activeWorkspaceType={workspaceType}
              onConfigUpdated={() => {
                setConfigActionStatus(t("settings.config_updated"));
                setPermissionsRefreshToken((token) => token + 1);
                void providerAuthStore.refreshProviders();
                void connectionsStore.refreshMcpServers();
              }}
            />
            <BrowserLoginsPanel />
          </SettingsStack>
        );
      case "ai":
        return (
          <AiSettingsView
            busy={busy}
            providerAuthBusy={providerAuthSnapshot.providerAuthBusy}
            providerStatusLabel={providerStatusLabel}
            providerStatusStyle={providerStatusStyle}
            providerSummary={providerSummary}
            connectedProviders={connectedProviders}
            disconnectingProviderId={null}
            providerConnectError={providerAuthSnapshot.providerAuthError}
            providerDisconnectStatus={configActionStatus}
            providerDisconnectError={null}
            onOpenProviderAuth={handleOpenProviderAuth}
            onDisconnectProvider={async (providerId) => {
              const message = await providerAuthStore.disconnectProvider(providerId);
              if (typeof message === "string" && message.trim()) {
                setConfigActionStatus(message);
              }
            }}
            canDisconnectProvider={(provider) =>
              provider.id.trim().toLowerCase() === "opencode" || provider.source !== "env"
            }
            canAddProviders={!providerAuthStore.isProviderAddRestricted()}
            organizationName={cloudSession.activeOrgName}
            cloudProviderIds={new Set([
              ...Object.values(providerAuthSnapshot.importedCloudProviders ?? {})
                .filter((provider) => !isOmniRushCloudProvider(provider))
                .map((provider) => provider.providerId),
            ])}
          />
        );
      case "preferences":
        return (
          <PreferencesView
            busy={busy}
            showThinking={local.prefs.showThinking}
            onToggleShowThinking={() => {
              local.setPrefs((previous) => ({ ...previous, showThinking: !previous.showThinking }));
            }}
            autoCompactContext={autoCompactContext}
            autoCompactContextBusy={autoCompactContextBusy}
            onToggleAutoCompactContext={toggleAutoCompactContext}
            analyticsEnabled={local.prefs.analyticsEnabled}
            onToggleAnalytics={() => {
              local.setPrefs((previous) => ({ ...previous, analyticsEnabled: !previous.analyticsEnabled }));
            }}
            desktopNotifications={local.prefs.desktopNotifications}
            onDesktopNotificationsChange={(desktopNotifications) => {
              local.setPrefs((previous) => ({ ...previous, desktopNotifications }));
            }}
            subagentModelClient={omnirushClient}
          />
        );
      case "extensions":
        return (
          <ExtensionsView
            busy={busy}
            hideDescription={props.standaloneExtensions !== true}
            selectedWorkspaceRoot={selectedWorkspaceRoot}
            isRemoteWorkspace={isRemoteWorkspace}
            canEditPlugins={canWriteWorkspacePlugins && allowManageExtensions}
            canUseGlobalScope={!isRemoteWorkspace}
            accessHint={allowManageExtensions ? pluginsAccessHint : desktopRestrictionNotice("allowManageExtensions")}
            suggestedPlugins={SUGGESTED_PLUGINS}
            extensions={extensionsStore}
            initialSection={route.extensionsSection}
            detailId={route.extensionDetailId ?? null}
            onDetailIdChange={(id) => {
              navigateSettingsPath(id ? `extensions/${encodeURIComponent(id)}` : "extensions");
            }}
            setSectionRoute={(section) => {
              const path = section === "all" ? "extensions" : `extensions/${section}`;
              navigateSettingsPath(path);
            }}
            onRefresh={() => {
              // Force-sync the cloud MCP first (re-mint token + rewrite
              // config, bypassing the freshness marker) so Refresh really
              // means "make everything current now", then refresh the rest.
              void connectionsStore.syncCloudControlMcp({ force: true }).then(() => {
                void connectionsStore.refreshMcpServers();
              });
              void extensionsStore.refreshPlugins();
              void extensionsStore.refreshCloudOrgMarketplaces({ force: true });
              void orgMcpConnections.refresh();
              void refreshConnectCapabilities({ force: true });
            }}
            mcpView={({ initialFilter, onFilterChange, initialState, onStateChange, detailId, onDetailIdChange, onRefresh }) => (
              <McpView
                busy={busy}
                selectedWorkspaceRoot={selectedWorkspaceRoot}
                isRemoteWorkspace={isRemoteWorkspace}
                mcpServers={connectionsSnapshot.mcpServers}
                mcpStatus={connectionsSnapshot.mcpStatus}
                mcpLastUpdatedAt={connectionsSnapshot.mcpLastUpdatedAt}
                mcpStatuses={connectionsSnapshot.mcpStatuses}
                managedOAuthAvailable={connectionsSnapshot.managedOAuthAvailable}
                mcpConnectingName={connectionsSnapshot.mcpConnectingName}
                allowManageExtensions={allowManageExtensions}
                selectedMcp={connectionsSnapshot.selectedMcp}
                setSelectedMcp={(name) => connectionsStore.setSelectedMcp(name)}
                quickConnect={extensionItems.quickConnectEntries}
                enablementContext={enablementContext}
                builtInExtensionsDisabled={builtInExtensionsDisabled}
                connectMcp={(entry) => {
                  return connectionsStore.connectMcp(entry);
                }}
                configSlotForEntry={extensionController.configSlotForEntry}
                isExtensionConnected={extensionController.isConnected}
                authorizeMcp={(entry) => {
                  void connectionsStore.authorizeMcp(entry);
                }}
                logoutMcpAuth={(name) => connectionsStore.logoutMcpAuth(name)}
                removeMcp={(name) => {
                  void connectionsStore.removeMcp(name);
                }}
                setMcpEnabled={
                  routeOmniRushStatus === "connected" && routeOmniRushCapabilities?.mcp?.write
                    ? (name, enabled) => connectionsStore.setMcpEnabled(name, enabled)
                    : undefined
                }
                readConfigFile={readMcpConfigFile}
                installedSkills={librarySkills}
                installedCommands={libraryCommands}
                installedAgents={libraryAgents}
                availableConnectMcpServers={libraryConnectMcpServers}
                availableConnectMcpStatuses={connectCapabilities.mcpStatuses}
                inventoryLoading={connectCapabilitiesLoading || (orgMcpConnections.loading && !orgMcpConnections.loaded)}
                installedPlugins={libraryConnectPlugins}
                orgMcpItems={orgMcpConnectionItems}
                organizationName={cloudSession.activeOrgName}
                orgMcpError={orgMcpConnections.error}
                uninstallSkill={(name) => { void extensionsStore.uninstallSkill(name); }}
                removeCloudPlugin={(pluginId) => { void extensionsStore.removeCloudOrgPlugin(pluginId); }}
                orgMcpConnectingId={orgMcpConnections.connectingId}
                connectOrgMcp={(connectionId) => { void orgMcpConnections.connect(connectionId); }}
                reconnectOrgMcp={(connectionId) => { void orgMcpConnections.connect(connectionId, { forceFreshAuthorization: true }); }}
                orgMcpDisconnectingId={orgMcpConnections.disconnectingId}
                disconnectOrgMcp={(connectionId) => { void orgMcpConnections.disconnect(connectionId); }}
                readSkill={readLibrarySkill}
                createWorkspaceSkill={async (input) => { await extensionsStore.saveSkill(input); }}
                previewSkillBundle={extensionsStore.previewSkillBundle}
                installSkillBundle={extensionsStore.installSkillBundle}
                listSkillFiles={extensionsStore.listSkillFiles}
                updateSkillFiles={extensionsStore.updateSkillFiles}
                saveSkillContent={extensionsStore.saveSkillContent}
                previewClaudePlugin={(url) => extensionsStore.previewClaudePlugin(url)}
                installClaudePlugin={(url) => extensionsStore.installClaudePlugin(url)}
                createLibraryItem={(kind, input) => extensionsStore.createLibraryItem(kind, input)}
                onLibraryListsRefresh={loadLibraryLists}
                initialFilter={initialFilter}
                onFilterChange={onFilterChange}
                initialState={initialState}
                onStateChange={onStateChange}
                detailId={detailId}
                onDetailIdChange={onDetailIdChange}
                onRefresh={onRefresh}
              />
            )}

          />
        );
      case "cloud-providers":
        return (
          <CloudProvidersView
            checkDesktopAppRestriction={checkDesktopRestriction}
            cloudOrgProviders={providerAuthSnapshot.cloudOrgProviders}
            connectCloudProvider={providerAuthStore.connectCloudProvider}
            importedCloudProviders={providerAuthSnapshot.importedCloudProviders}
            importsUnavailable={
              omnirushServerSnapshot.omnirushServerCapabilities?.config?.read === false ||
              omnirushServerSnapshot.omnirushServerCapabilities?.config?.write === false
            }
            lastSyncError={providerAuthSnapshot.lastSyncError}
            omnirushServerAvailable={Boolean(omnirushServerSnapshot.omnirushServerClient)}
            onOpenAccount={openCloudAccountSettings}
            refreshCloudOrgProviders={providerAuthStore.refreshCloudOrgProviders}
            runCloudProviderSync={providerAuthStore.runCloudProviderSync}
            serverSync={providerAuthSnapshot.cloudProviderServerSync}
          />
        );
      case "advanced":
        return (
          <SettingsStack>
            <AdvancedView
              sectionId={route.advancedSection}
              key={runtimeWorkspaceId ?? selectedWorkspaceId}
              busy={busy}
              clientConnected={Boolean(opencodeClient)}
              opencodeConnectStatus={null}
              omnirushServerStatus={omnirushServerSnapshot.omnirushServerStatus}
              developerMode={developerMode}
              toggleDeveloperMode={toggleDeveloperMode}
              opencodeDevModeEnabled={false}
              openDebugDeepLink={async () => ({ ok: false, message: "Debug deep links are not wired into the React settings route yet." })}
              cloudMcpUrl={omnirushCloudMcpUrl}
              canInspectRuntimeConfig={Boolean(omnirushClient && selectedWorkspaceId)}
              getRuntimeConfigStatus={async () => {
                if (!omnirushClient || !selectedWorkspaceId) {
                  throw new Error("Select a workspace to inspect runtime config.");
                }
                return omnirushClient.getRuntimeConfigStatus(selectedWorkspaceId);
              }}
              cloudMcpHealth={cloudMcpHealth}
              refreshCloudMcpHealth={refreshCloudMcpHealth}
              getEngineV2PreviewStatus={async () => {
                if (!omnirushClient) throw new Error("omnirush.ai server is not connected.");
                return omnirushClient.getEngineV2PreviewStatus();
              }}
              setEngineV2PreviewEnabled={async (enabled) => {
                if (!omnirushClient) throw new Error("omnirush.ai server is not connected.");
                return omnirushClient.setEngineV2PreviewEnabled(enabled);
              }}
              setEngineV2PreviewChatRouting={async (enabled) => {
                if (!omnirushClient) throw new Error("omnirush.ai server is not connected.");
                return omnirushClient.setEngineV2PreviewChatRouting(enabled);
              }}
              organizationServer={denSession}
            />
            {platform.capabilities.localRuntimeControl ? (
              <RecoveryView
                anyActiveRuns={false}
                workspaceConfigPath={selectedWorkspaceRoot ? `${selectedWorkspaceRoot}/.opencode/omnirush.json` : ""}
                resetConfigBusy={resetConfigBusy}
                onResetAppConfigDefaults={() => {}}
                configActionStatus={configActionStatus}
                cacheRepairBusy={false}
                cacheRepairResult={null}
                onRepairOpencodeCache={() => {}}
                dockerCleanupBusy={false}
                dockerCleanupResult={null}
                onCleanupOmniRushDockerContainers={() => {}}
              />
            ) : null}
            <EffectivePermissionsPanel
              omnirushServerClient={omnirushClient}
              omnirushServerStatus={routeOmniRushStatus}
              omnirushServerCapabilities={routeOmniRushCapabilities}
              runtimeWorkspaceId={runtimeWorkspaceId}
              refreshToken={permissionsRefreshToken}
            />
          </SettingsStack>
        );
      case "appearance":
        return (
          <AppearanceView
            busy={busy}
            themeMode={themeMode}
            setThemeMode={setThemeModeState}
            language={currentLocale() as Language}
            setLanguage={setLocale}
            hideTitlebar={hideTitlebar}
            toggleHideTitlebar={() => setHideTitlebar((current) => !current)}
          />
        );
      case "voice":
        return <VoiceSettingsView client={omnirushClient} />;
      case "updates":
        return (
          <UpdatesView
            busy={busy}
            webDeployment={platform.platform === "web"}
            appVersion={electronUpdaterState.appVersion}
            updateEnv={electronUpdaterState.updateEnv}
            updateAutoCheck={updateAutoCheck}
            toggleUpdateAutoCheck={() => setUpdateAutoCheck((current) => !current)}
            updateAutoDownload={updateAutoDownload}
            toggleUpdateAutoDownload={() => setUpdateAutoDownload((current) => !current)}
            updateStatus={electronUpdaterState.updateStatus}
            anyActiveRuns={activeReloadBlockingSessions.length > 0}
            checkForUpdates={electronUpdaterState.checkForUpdates}
            downloadUpdate={electronUpdaterState.downloadUpdate}
            installUpdateAndRestart={electronUpdaterState.installUpdateAndRestart}
            releaseChannel={local.prefs.releaseChannel ?? "stable"}
            onReleaseChannelChange={electronUpdaterState.setReleaseChannel}
            // The shell reports an Alpha feed only for distributions that
            // ship one; the public build never does.
            alphaChannelSupported={
              isElectronRuntime() &&
              electronUpdaterState.alphaChannelSupported &&
              desktopConfig.config.allowAlphaUpdates !== false
            }
            installMode={electronUpdaterState.installMode}
          />
        );
      case "environment":
        return (
          <EnvironmentView
            client={omnirushServerSnapshot.omnirushServerClient}
            isRemoteWorkspace={isRemoteWorkspace}
            onApplyChanges={isDesktopRuntime() && !isRemoteWorkspace ? handleApplyEnvironmentChanges : undefined}
            applyBlocked={activeReloadBlockingSessions.length > 0}
            applyBlockedReason={
              activeReloadBlockingSessions.length > 0
                ? t("settings.environment.apply_blocked_active_tasks")
                : null
            }
            runtimeKey={environmentRuntimeKey}
          />
        );
      case "debug":
        return (
          <DebugView
            key={runtimeWorkspaceId ?? selectedWorkspaceId}
            {...debugViewProps}
            agentAccess={{
              client: selectedWorkspaceEndpoint?.client ?? omnirushClient,
              workspaceId: runtimeWorkspaceId,
              currentModel: currentCloudMcpModel,
              onHealthChange: handleCloudMcpHealthChange,
            }}
            agentContextDiagnostics={{
              scopeKey: diagnosticsScopeKey,
              available: diagnosticsAvailable,
              unavailableReason: diagnosticsUnavailableReason,
              onRun: runAgentContextDiagnostics,
            }}
          />
        );
      default:
        return null;
    }
  })();

  return (
    <>
      {props.standaloneExtensions ? (
        <div data-extensions-main-surface className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
          <SettingsContent>{settingsView}</SettingsContent>
        </div>
      ) : (
        <SettingsShell
          activeTab={route.tab}
          onSelectTab={(tab) => navigateSettingsPath(tab)}
          developerMode={developerMode}
          selectedWorkspaceId={selectedWorkspaceId}
          selectedWorkspaceName={selectedWorkspaceName}
          selectedWorkspaceColor={selectedWorkspaceColor}
          workspaces={workspaceOptions}
          onSelectWorkspace={handleSelectSettingsWorkspace}
          headerStatus={routeOmniRushStatus}
          busyHint={loading ? t("session.loading_detail") : busyLabel}
          onClose={props.onClose ?? (() => navigate(settingsReturnRoute(
            selectedWorkspaceId,
            navigationWorkspaceId,
            navigationSessionId,
          )))}
          compact={props.embedded}
        >
          {settingsView}
        </SettingsShell>
      )}

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        developerMode={developerMode}
        onToggleSidebar={toggleSidebar}
        onOpenAutomations={() => navigate(automationsRoute())}
        onCreateNewSession={() => void handleCreatePaletteSession()}
        onOpenSession={(workspaceId, sessionId) => {
          navigate(workspaceSessionRoute(workspaceId, sessionId));
        }}
        onOpenSettings={(path = "/settings/general") => {
          const settingsPath = path.replace(/^\/settings\//, "");
          if (props.standaloneExtensions) {
            navigate(
              selectedWorkspaceId
                ? workspaceSettingsRoute(selectedWorkspaceId, settingsPath)
                : `/settings/${settingsPath}`,
            );
            return;
          }
          navigateSettingsPath(settingsPath);
        }}
        onOpenExtensions={(section) => {
          const target = selectedWorkspaceId
            ? workspaceExtensionsRoute(selectedWorkspaceId, section)
            : globalExtensionsRoute(section);
          navigate(target);
        }}
        onOpenModelPicker={() => {
          modelPicker.setQuery("");
          modelPicker.setRecentProviderIds(new Set());
          window.requestAnimationFrame(() => modelPicker.setOpen(true));
        }}
        selectedModelLabel={defaultModelLabel}
        sessions={paletteSessionOptions}
        extraItems={checkDesktopRestriction({ restriction: "allowControlSettings" }) ? [] : [developerModePaletteItem]}
      />

      <ProviderAuthModal
        open={providerAuthSnapshot.providerAuthModalOpen}
        loading={false}
        submitting={providerAuthSnapshot.providerAuthBusy}
        error={providerAuthSnapshot.providerAuthError}
        preferredProviderId={providerAuthSnapshot.providerAuthPreferredProviderId}
        workerType={providerAuthSnapshot.providerAuthWorkerType}
        // Hide any provider the org blocks at the desktop layer so users
        // can't connect a forbidden one (dev #1505). Same helper covers
        // opencode-provider gating via the `allowZenModel` restriction.
        // We also strip the matching key from `authMethods` because the
        // modal builds its entry list from `Object.keys(authMethods)`,
        // not from `providers`.
        providers={providerAuthSnapshot.providerAuthProviders.filter(
          (provider) =>
            isSupportedModelProvider(provider.id) &&
            !isDesktopProviderBlocked({
              providerId: provider.id,
              checkRestriction: checkDesktopRestriction,
            }),
        )}
        connectedProviderIds={visibleProviderConnectedIds}
        authMethods={Object.fromEntries(
          Object.entries(providerAuthSnapshot.providerAuthMethods).filter(
            ([providerId]) =>
              isSupportedModelProvider(providerId) &&
              !isDesktopProviderBlocked({
                providerId,
                checkRestriction: checkDesktopRestriction,
              }),
          ),
        )}
        onSelect={providerAuthStore.startProviderAuth}
        onSubmitApiKey={providerAuthStore.submitProviderApiKey}
        onSubmitOAuth={providerAuthStore.completeProviderAuthOAuth}
        onRefreshProviders={providerAuthStore.refreshProviders}
        onClose={() => providerAuthStore.closeProviderAuthModal()}
      />
      <RenameWorkspaceModal
        open={renameWorkspaceId !== null}
        title={renameWorkspaceTitle}
        busy={renameWorkspaceBusy}
        canSave={!renameWorkspaceBusy && renameWorkspaceTitle.trim().length > 0}
        onClose={() => {
          if (renameWorkspaceBusy) return;
          setRenameWorkspaceId(null);
          setRenameWorkspaceTitle("");
        }}
        onSave={() => void handleSaveRenameWorkspace()}
        onTitleChange={setRenameWorkspaceTitle}
      />
      {shareWorkspaceState.shareWorkspaceOpen ? (
        <ShareWorkspaceModal
          open
          onClose={shareWorkspaceState.closeShareWorkspace}
          workspaceName={shareWorkspaceState.shareWorkspaceName}
          workspaceDetail={shareWorkspaceState.shareWorkspaceDetail}
          fields={shareWorkspaceState.shareFields}
          note={shareWorkspaceState.shareNote}
          onExportConfig={
            shareWorkspaceState.exportDisabledReason === null
              ? () => {
                  const id = shareWorkspaceState.shareWorkspaceId;
                  if (!id) return;
                  void handleExportWorkspaceConfig(id);
                }
              : undefined
          }
          exportDisabledReason={shareWorkspaceState.exportDisabledReason}
        />
      ) : null}
      <CreateRemoteWorkspaceModal
        open={remoteWorkspaceConnectionEditor.workspace !== null}
        onClose={remoteWorkspaceConnectionEditor.close}
        onConfirm={(input) => void remoteWorkspaceConnectionEditor.save(input)}
        initialValues={remoteWorkspaceConnectionEditor.initialValues}
        submitting={remoteWorkspaceConnectionEditor.busy}
        error={remoteWorkspaceConnectionEditor.error}
        title={t("dashboard.edit_remote_workspace_title")}
        subtitle={t("dashboard.edit_remote_workspace_subtitle")}
        confirmLabel={t("dashboard.edit_remote_workspace_confirm")}
      />
      <ConnectionsModals
        client={activeClient}
        projectDir={selectedWorkspaceRoot}
        reloadBlocked={activeReloadBlockingSessions.length > 0}
        activeSessions={activeReloadBlockingSessions}
        isRemoteWorkspace={selectedWorkspace?.workspaceType === "remote"}
        onForceStopSession={async (sessionId) => {
          if (!activeClient) return;
          await abortSessionSafe(activeClient, sessionId, undefined, {
            source: "settings.connections.force_stop_session",
            initiator: "user",
            reason: "force stop active session from connections modal",
          });
        }}
        onReloadEngine={reloadCoordinator.reloadWorkspaceEngine}
        modalState={{
          mcpAuthModalOpen: connectionsSnapshot.mcpAuthModalOpen,
          mcpAuthEntry: connectionsSnapshot.mcpAuthEntry,
          mcpAuthNeedsReload: connectionsSnapshot.mcpAuthNeedsReload,
        }}
        onCloseMcpAuthModal={() => connectionsStore.closeMcpAuthModal()}
        onMcpAuthenticated={(name) => connectionsStore.recordMcpAuthenticated(name)}
        onCompleteMcpAuthModal={() => connectionsStore.completeMcpAuthModal()}
      />
      <ModelPickerModal
        open={modelPicker.open}
        options={modelPicker.options}
        query={modelPicker.query}
        setQuery={modelPicker.setQuery}
        target="default"
        current={
          local.prefs.defaultModel ?? { providerID: "", modelID: "" }
        }
        onSelect={(next: ModelRef) => {
          local.setPrefs((prev) => ({
            ...prev,
            defaultModel: next,
            modelVariant: prev.defaultModel?.providerID === next.providerID && prev.defaultModel.modelID === next.modelID
              ? prev.modelVariant
              : null,
          }));
          modelPicker.setOpen(false);
        }}
        onBehaviorChange={() => {}}
        onOpenSettings={() => {}}
        onClose={() => modelPicker.setOpen(false)}
      />
    </>
  );
}

export function SettingsRoute() {
  return <SettingsSurface />;
}

export function SettingsSurface(props: SettingsSurfaceProps) {
  return (
    <CloudSessionProvider>
      <SettingsRouteContent {...props} />
    </CloudSessionProvider>
  );
}
