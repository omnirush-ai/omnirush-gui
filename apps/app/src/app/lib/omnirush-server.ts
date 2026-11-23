import type {
  SkillBundleInstallResult,
  SkillBundlePreview,
  SkillFileTree,
  SkillUploadFile,
} from "./skill-upload";
import { v2McpStatusMap } from "./opencode-v2-adapter";
import type { McpStatusMap } from "../types";
import type { Message, Part, Session, Todo } from "@opencode-ai/sdk/v2/client";
import {
  agentContextDiagnosticsReportSchema,
  agentContextDiagnosticsRequestSchema,
  type AgentContextDiagnosticsReport,
  type AgentContextDiagnosticsRequest,
} from "@omnirush/types/agent-context-diagnostics";
import { normalizeBaseUrl } from "@omnirush/types/url";
import {
  AGENT_CONTEXT_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
  requestAgentContextDiagnosticsPayload,
} from "./agent-context-diagnostics-transport";
import { desktopFetch, desktopFetchAgentContextDiagnostics, desktopUploadMultipart, electronLocalPathForFile } from "./desktop";
import { isOmniRushGatewayRuntime } from "./gateway-runtime";
import { isDesktopRuntime } from "./runtime-env";
import type { ExecResult, OpencodeConfigFile, WorkspaceInfo, WorkspaceList } from "./desktop";
import type { DenOrgMarketplace, DenOrgPluginResolved, DenResourceSnapshot } from "./den-types";
import type { CloudImportedMarketplace, CloudImportedPlugin, CloudImportedProvider } from "../cloud/import-state";
import type {
  LocalModelRef,
  LocalRouteCategory,
  LocalRouteDecision,
  LocalRoutingSettings,
  LocalWorkflow,
  LocalWorkflowInput,
  LocalWorkflowRun,
  LocalWorkflowsSnapshot,
} from "@omnirush/types/local-workflows";

export type OmniRushServerCapabilities = {
  skills: { read: boolean; write: boolean; source: "omnirush" | "opencode" };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };
  engine?: { rollover: boolean };
  providerSync?: boolean;
  sandbox?: { enabled: boolean; backend: "none" | "docker" | "container" };
  proxy?: { opencode: boolean };
  toolProviders?: {
    browser?: {
      enabled: boolean;
      placement: "in-sandbox" | "host-machine" | "client-machine" | "external";
      mode: "none" | "headless" | "interactive";
    };
    files?: {
      injection: boolean;
      outbox: boolean;
      inboxPath: string;
      outboxPath: string;
      maxBytes: number;
    };
  };
};

export type OmniRushCloudProviderSyncRun = {
  status: "applied" | "noop" | "failed" | "no_session";
  message?: string;
};

export type OmniRushCloudProviderSyncSkippedProvider = {
  cloudProviderId: string;
  providerId: string;
  name: string;
  /** Machine-readable skip reason, e.g. "missing_credentials". */
  reason: string;
};

export type OmniRushCloudProviderSyncStatus = {
  hasSession: boolean;
  lastRun: { at: string | number; status: OmniRushCloudProviderSyncRun["status"]; message?: string } | null;
  providers: CloudImportedProvider[];
  /** A managed engine reload is still owed: materialized providers are not served yet. */
  reloadPending: boolean;
  /** Den-granted providers the server sync skipped, each with a reason. */
  skippedProviders: OmniRushCloudProviderSyncSkippedProvider[];
};

export interface EngineV2PreviewStatus {
  enabled: boolean;
  running: boolean;
  chatRouting: boolean;
  version?: string;
  pid?: number;
  binSource?: string;
  mirroredProviderIds: string[];
  skippedProviderIds: string[];
  catalogModelIds: string[];
  lastMirroredAt?: string;
  lastError?: string;
}

function parseEngineV2PreviewStatus(value: unknown): EngineV2PreviewStatus {
  if (
    !value || typeof value !== "object" ||
    !("enabled" in value) || typeof value.enabled !== "boolean" ||
    !("running" in value) || typeof value.running !== "boolean" ||
    !("mirroredProviderIds" in value) || !Array.isArray(value.mirroredProviderIds) || !value.mirroredProviderIds.every((item) => typeof item === "string") ||
    !("skippedProviderIds" in value) || !Array.isArray(value.skippedProviderIds) || !value.skippedProviderIds.every((item) => typeof item === "string") ||
    !("catalogModelIds" in value) || !Array.isArray(value.catalogModelIds) || !value.catalogModelIds.every((item) => typeof item === "string")
  ) {
    throw new Error("Invalid OmniRush v2 engine preview status response.");
  }
  return {
    enabled: value.enabled,
    running: value.running,
    chatRouting: "chatRouting" in value && typeof value.chatRouting === "boolean" ? value.chatRouting : false,
    version: "version" in value && typeof value.version === "string" ? value.version : undefined,
    pid: "pid" in value && typeof value.pid === "number" ? value.pid : undefined,
    binSource: "binSource" in value && typeof value.binSource === "string" ? value.binSource : undefined,
    mirroredProviderIds: value.mirroredProviderIds,
    skippedProviderIds: value.skippedProviderIds,
    catalogModelIds: value.catalogModelIds,
    lastMirroredAt: "lastMirroredAt" in value && typeof value.lastMirroredAt === "string" ? value.lastMirroredAt : undefined,
    lastError: "lastError" in value && typeof value.lastError === "string" ? value.lastError : undefined,
  };
}

function parseCloudProviderSyncRun(value: unknown): OmniRushCloudProviderSyncRun {
  if (!value || typeof value !== "object" || !("status" in value)) throw new Error("Invalid cloud provider sync response.");
  const status = value.status;
  if (status !== "applied" && status !== "noop" && status !== "failed" && status !== "no_session") {
    throw new Error("Invalid cloud provider sync status.");
  }
  const message = "message" in value && typeof value.message === "string" ? value.message : undefined;
  return { status, message };
}

function parseCloudImportedProvider(value: unknown): CloudImportedProvider | null {
  if (!value || typeof value !== "object") return null;
  if (
    !("cloudProviderId" in value) || typeof value.cloudProviderId !== "string" ||
    !("providerId" in value) || typeof value.providerId !== "string" ||
    !("sourceProviderId" in value) || typeof value.sourceProviderId !== "string" ||
    !("name" in value) || typeof value.name !== "string" ||
    !("modelIds" in value) || !Array.isArray(value.modelIds) || !value.modelIds.every((item) => typeof item === "string")
  ) return null;
  return {
    cloudProviderId: value.cloudProviderId,
    providerId: value.providerId,
    sourceProviderId: value.sourceProviderId,
    name: value.name,
    source: "source" in value && typeof value.source === "string" ? value.source : null,
    updatedAt: "updatedAt" in value && typeof value.updatedAt === "string" ? value.updatedAt : null,
    modelIds: value.modelIds,
    importedAt: "importedAt" in value && typeof value.importedAt === "number" ? value.importedAt : null,
  };
}

function parseCloudProviderSyncStatus(value: unknown): OmniRushCloudProviderSyncStatus {
  if (!value || typeof value !== "object" || !("hasSession" in value) || typeof value.hasSession !== "boolean" || !("providers" in value) || !Array.isArray(value.providers)) {
    throw new Error("Invalid cloud provider sync status response.");
  }
  const providers: CloudImportedProvider[] = [];
  for (const rawProvider of value.providers) {
    const provider = parseCloudImportedProvider(rawProvider);
    if (!provider) throw new Error("Invalid cloud provider sync provider response.");
    providers.push(provider);
  }
  let lastRun: OmniRushCloudProviderSyncStatus["lastRun"] = null;
  if ("lastRun" in value && value.lastRun !== null) {
    if (!value.lastRun || typeof value.lastRun !== "object" || !("at" in value.lastRun) || (typeof value.lastRun.at !== "string" && typeof value.lastRun.at !== "number")) {
      throw new Error("Invalid cloud provider sync last-run response.");
    }
    const run = parseCloudProviderSyncRun(value.lastRun);
    lastRun = { at: value.lastRun.at, status: run.status, message: run.message };
  }
  // Additive fields (older servers omit them): tolerate absence and malformed
  // entries instead of failing the whole status read.
  const reloadPending = "reloadPending" in value && value.reloadPending === true;
  const skippedProviders: OmniRushCloudProviderSyncSkippedProvider[] = [];
  if ("skippedProviders" in value && Array.isArray(value.skippedProviders)) {
    for (const raw of value.skippedProviders) {
      if (!raw || typeof raw !== "object") continue;
      if (
        !("cloudProviderId" in raw) || typeof raw.cloudProviderId !== "string" ||
        !("providerId" in raw) || typeof raw.providerId !== "string" ||
        !("name" in raw) || typeof raw.name !== "string" ||
        !("reason" in raw) || typeof raw.reason !== "string"
      ) continue;
      skippedProviders.push({
        cloudProviderId: raw.cloudProviderId,
        providerId: raw.providerId,
        name: raw.name,
        reason: raw.reason,
      });
    }
  }
  return { hasSession: value.hasSession, lastRun, providers, reloadPending, skippedProviders };
}

export type OmniRushServerStatus = "connected" | "disconnected" | "limited";

export type OmniRushServerDiagnostics = {
  ok: boolean;
  version: string;
  uptimeMs: number;
  readOnly: boolean;
  approval: { mode: "manual" | "auto"; timeoutMs: number };
  corsOrigins: string[];
  workspaceCount: number;
  activeWorkspaceId?: string | null;
  selectedWorkspaceId?: string | null;
  workspace: OmniRushWorkspaceInfo | null;
  authorizedRoots: string[];
  server: { host: string; port: number; configPath?: string | null };
  tokenSource: { client: string; host: string };
};

export type OmniRushRuntimeServiceName = "omnirush-server" | "opencode";

export type OmniRushRuntimeServiceSnapshot = {
  name: OmniRushRuntimeServiceName;
  enabled: boolean;
  running: boolean;
  targetVersion: string | null;
  actualVersion: string | null;
  upgradeAvailable: boolean;
};

export type OmniRushRuntimeSnapshot = {
  ok: boolean;
  worker?: {
    workspace: string;
    sandboxMode: string;
  };
  upgrade?: {
    status: "idle" | "running" | "failed";
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
    operationId: string | null;
    services: OmniRushRuntimeServiceName[];
  };
  services: OmniRushRuntimeServiceSnapshot[];
};

export type OmniRushServerSettings = {
  urlOverride?: string;
  portOverride?: number;
  token?: string;
  hostToken?: string;
  remoteAccessEnabled?: boolean;
};

// The shared WorkspaceWire contract now carries the opencode block; keep the
// historical name as an alias for the many existing imports.
export type OmniRushWorkspaceInfo = WorkspaceInfo;

export type OmniRushWorkspaceList = {
  items: OmniRushWorkspaceInfo[];
  workspaces?: WorkspaceInfo[];
  activeId?: string | null;
};

/** One parallel task (apps/server routes/workspace-tasks.ts TaskView). */
export type OmniRushWorkspaceTask = {
  id: string;
  title: string;
  prompt: string;
  state: "created" | "running" | "done" | "failed" | "stopped" | "applied" | "merged" | "missing";
  label: string;
  branch: string;
  baseBranch: string | null;
  baseCommit: string;
  /** The main checkout had uncommitted changes when the task started: they are not in it. */
  startedDirty: boolean;
  name: string;
  path: string;
  workspaceId: string | null;
  sessionId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  age: string;
  files: number | null;
  finished: boolean;
  result: { mode: "apply" | "merge"; files: number; at: string } | null;
};

export type OmniRushWorkspaceTaskList = {
  git: boolean;
  repo: string | null;
  branch: string | null;
  hasCommit: boolean;
  tasks: OmniRushWorkspaceTask[];
};

export type OmniRushSessionMessage = {
  info: Message;
  parts: Part[];
};

export type OmniRushSessionSnapshot = {
  session: Session;
  messages: OmniRushSessionMessage[];
  todos: Todo[];
  status:
    | { type: "idle" }
    | { type: "busy" }
    | { type: "retry"; attempt: number; message: string; next: number };
};

export type OmniRushPluginItem = {
  spec: string;
  source: "config" | "dir.project" | "dir.global";
  scope: "project" | "global";
  path?: string;
};

export type OmniRushSkillItem = {
  name: string;
  path: string;
  description: string;
  scope: "project" | "global";
  trigger?: string;
  error?: string;
};

export type OmniRushSkillContent = {
  item: OmniRushSkillItem;
  content: string;
};

export type OmniRushWorkspaceFileContent = {
  path: string;
  content: string;
  bytes: number;
  updatedAt: number;
};

export type OmniRushWorkspaceFileWriteResult = {
  ok: boolean;
  path: string;
  bytes: number;
  updatedAt: number;
  revision?: string;
};

export type OmniRushWorkspaceFileDeleteResult = {
  ok: boolean;
  path: string;
  code?: string;
};

export type OmniRushWorkspaceCatalogEntry = {
  path: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  revision: string;
};

export type OmniRushWorkspaceCatalog = {
  incomplete?: boolean;
  skippedDirectories?: string[];
  items: OmniRushWorkspaceCatalogEntry[];
  total: number;
  truncated: boolean;
};

export type OmniRushAuthorizedFoldersResponse = {
  folders: string[];
  hiddenCount: number;
  workspaceRoot: string;
};

export type OmniRushPermissionAction = "allow" | "ask" | "deny";
export type OmniRushPermissionSource = "engine" | "global" | "omnirush" | "workspace";
export type OmniRushEffectivePermissionKey =
  | "shell"
  | "edit"
  | "web"
  | "mcp"
  | "outside_folders"
  | "env_files"
  | "doom_loop";

export type OmniRushEffectivePermissionRow = {
  key: OmniRushEffectivePermissionKey;
  permission: string;
  action: OmniRushPermissionAction;
  rule: { permission: string; pattern: string; action: OmniRushPermissionAction } | null;
  source: OmniRushPermissionSource | null;
  exceptions: number;
};

export type OmniRushEffectivePermissionsResponse = {
  agent: string;
  rows: OmniRushEffectivePermissionRow[];
  files: { workspace: string; global: string };
};

export type OmniRushAuthorizedFoldersUpdateResponse = {
  folders: string[];
  hiddenCount: number;
  updatedAt: number;
};

export type OmniRushRuntimeDisabledProvidersResult = {
  ok: true;
  disabledProviders: string[];
};

export type OmniRushRuntimeConfigStatus = {
  runtime: Record<string, unknown>;
  runtimeKeys: string[];
  effectiveRuntime: Record<string, unknown>;
  managedFilePath: string;
  managedFileRebuiltAt: number | null;
  managedFileContentRedacted: string | null;
  sources?: {
    projectOpencode: { path: string; exists: boolean; keys: string[]; config: Record<string, unknown> };
    globalOpencode: { path: string; exists: boolean; keys: string[]; config: Record<string, unknown> };
    runtimeDatabase: { keys: string[]; config: Record<string, unknown> };
    injected: { keys: string[]; config: Record<string, unknown> };
  };
  userOpencode: {
    path: string;
    exists: boolean;
    keys: string[];
  };
};

/** Stored engine approval mode: careful ("Careful"), guarded ("Normal", the default), full ("Auto"). */
export type OmniRushApprovalMode = "careful" | "guarded" | "full";
export type OmniRushRuntimeApprovals = {
  /** Effective mode: the environment override, else the setting, else guarded. */
  mode: OmniRushApprovalMode;
  source: "environment" | "settings" | "default";
  /** The persisted user setting, even while the environment overrides it. */
  setting: OmniRushApprovalMode | null;
};

/** Saved only on this server/device, independent of account and workspace. */
export type OmniRushBestPractices = { enabled: boolean };
/**
 * Session files (files used): whether omnirush.ai records them for this
 * account now, whether its setting is on, and the line it asks the app to
 * show once (null when it could not be asked).
 */
export type OmniRushFilesUsed = { active: boolean | null; available: boolean | null; consentText: string | null };
/** GET /omnirush/capture/pending: uploads and project archives still queued (a sign-out first sends what it can). */
export type OmniRushPendingUploads = { uploads: number; archives: number };
/** The server waits at most 10 s for queued uploads at a sign-out; a little more for the answer. */
const SIGN_OUT_FLUSH_TIMEOUT_MS = 15_000;
/** GET /omnirush/provider-lock: the model providers the engine may use (app/lib/provider-lock.ts). */
export type OmniRushProviderLock = { locked: boolean; allow: string[]; message: string };
/** GET /omnirush/capture/status: whether session capture runs; "off" when signed out (nothing to capture). */
export type OmniRushCaptureStatus = {
  running: boolean;
  mode: "off" | "starting" | "worker" | "local" | "restarting" | "down";
  since: string | null;
  restarts: number;
};
/** Agent assist (apps/server/src/agent-assist-config.ts): what the agent does on its own; all on by default. */
export type OmniRushAgentAssistFeature = "selfCheck" | "projectNotes" | "diagnostics" | "compaction";
export type OmniRushAgentAssist = {
  features: Record<OmniRushAgentAssistFeature, boolean>;
  /** Decided by an environment switch of the server (shown, not changeable). */
  forced: OmniRushAgentAssistFeature[];
};
export type OmniRushAgentAssistChange = OmniRushAgentAssist & {
  ok: boolean;
  changed: boolean;
  engine: { status: "applied" | "deferred" | "failed" | "unconfigured" };
};
export type OmniRushBestPracticesChange = OmniRushBestPractices & {
  ok: boolean;
  changed: boolean;
  /** Applying a choice must not interrupt a live reply. */
  engine: { status: "applied" | "deferred" | "failed" | "unconfigured" };
};

/** The box status query: a fresh backend check, and the chat it is asked for. */
function boxQuery(options?: { fresh?: boolean; sessionId?: string | null }): string {
  const query = new URLSearchParams();
  if (options?.fresh) query.set("fresh", "1");
  if (options?.sessionId) query.set("session", options.sessionId);
  const text = query.toString();
  return text ? `?${text}` : "";
}

/**
 * GET /workspace/:id/box: the workspace's Linux sandbox (commands run in a
 * per-project container on this computer). `mode` null: the server's default.
 */
export type OmniRushWorkspaceBox = {
  mode: "on" | "off" | null;
  serverDefault: "off" | "offer" | "on";
  on: boolean;
  /**
   * "host-builds": the server's default would put it in the sandbox, but the folder has this computer's builds.
   * "required": the account requires the sandbox for new chats; "host-only": required, but the project only builds on this OS.
   */
  source: "env" | "project" | "server" | "default" | "host-builds" | "buildathon" | "required" | "host-only";
  offer: boolean;
  state: "off" | "unavailable" | "downloading" | "starting" | "ready" | "failed";
  runtime: { ok: boolean; name: string | null; flavor: string | null; version: string | null; reason: string | null } | null;
  /** What runs the sandbox on this computer: the chosen backend, why, and the others (each with why not). */
  backend: {
    id: string | null;
    label: string | null;
    version: string | null;
    flavor: string | null;
    why: string | null;
    alternatives: Array<{ id: string; label: string; ok: boolean; reason: string | null }>;
    allowed: string[] | null;
  } | null;
  /** The computer's backend setting: "auto", one backend id, or "native"; and the values it takes here. */
  backendSetting: { value: string; source: "env" | "setting" | "auto"; choices: Array<{ id: string; label: string }> };
  image: { ref: string; stack: string; present: boolean | null; downloading: boolean } | null;
  /** The image download's progress while it downloads (bytes when the server knows the layer sizes). Older servers: absent. */
  progress?: OmniRushWorkspaceBoxProgress | null;
  container: { name: string; exists: boolean; running: boolean } | null;
  /** The server's OS. Older servers: absent. */
  platform?: string;
  notice: string | null;
  error: string | null;
  /**
   * macOS / Windows: the folder has this computer's builds (node_modules, a venv, programs). `native`: its
   * chats stay on this computer; else the sandbox is on by choice and `notice` warns. Older servers: absent.
   */
  hostBuilds?: { native: boolean; things: string; notice: string } | null;
  /** macOS / Windows, while chats run in the sandbox: one line that says so. Older servers: absent. */
  boxNotice?: string | null;
  /** The account requires the sandbox for new chats: the switch and "Off (this computer)" are disabled. Older servers: absent. */
  required?: boolean;
  requiredText?: { line: string; optOut: string; keptOldChat: string } | null;
  /** Required, but the project only builds on this OS (an Xcode project, a WPF app): its chats run on this computer. */
  hostOnly?: { things: string[]; notice: string } | null;
  /** Required and not ready: what the sandbox needs on this computer (the setup screen). */
  setup?: OmniRushWorkspaceBoxSetup | null;
  /** Asked for one chat: it started on this computer before the sandbox was required and stays here. */
  chatKept?: boolean;
  /** How a new chat on each model starts (the server's local_box.model_start). Older servers: absent or null. */
  modelStart?: Record<string, { start: "native" | "box"; switchable: boolean }> | null;
  /** The local_box policy revision new chats pin. Older servers: absent. */
  revision?: string | null;
  /** Asked for one chat: its pin (where it runs, the revision it started under); null before its first prompt. */
  chatPin?: { box: boolean; revision: string | null } | null;
  /** Servers in the sandbox open at the same port on this computer's 127.0.0.1 (Docker/Podman). Older servers: absent. */
  ports?: Array<{ port: number; url: string; line: string }>;
};
export type OmniRushWorkspaceBoxSetup = {
  need: "none" | "linux_allow" | "win_install" | "win_restart" | "win_update" | "mac_vm" | "runtime" | "cannot_run";
  why: "firmware_off" | "nested_vm" | "s_mode" | "old_windows" | "old_macos" | "policy" | "declined" | null;
  whyText: string | null;
  declined: boolean;
  result: { ok: boolean; message: string; at: number } | null;
  fallback: "native" | "native_uncounted";
  /** cannot_run: the one line ("The sandbox can't run on this computer: …."). */
  line?: string | null;
};
export type OmniRushWorkspaceBoxSetupAction = "linux_allow" | "win_install" | "win_restart" | "win_update" | "decline" | "check";
export type OmniRushWorkspaceBoxProgress = {
  bytesDone: number | null;
  bytesTotal: number | null;
  layersDone: number;
  layersTotal: number;
  startedAt: number | null;
  /** macOS, the OmniRush VM's first setup: its step ("lima", "vm_image", "vm_boot", "image") and that step's bytes. Older servers: absent. */
  setup?: { step: string; bytesDone: number | null; bytesTotal: number | null; seen?: string[] } | null;
};
export type OmniRushWorkspaceBoxChange = OmniRushWorkspaceBox & {
  engine: { status: "unchanged" | "applied" | "deferred" | "failed" | "unmanaged" };
};

/** The sub-agent model and effort (Settings > Preferences and the composer's Sub-agents menu). */
export type OmniRushSubagentModelSetting = {
  /** An omnirush.ai catalog model id; null runs sub-agents on the main agent's model. */
  model: string | null;
  /** An effort; null uses the main agent's effort (the nearest level the model offers). */
  effort: string | null;
};

/** GET /omnirush/voice/status: whether dictation can be used, and hint words for the project. */
export type OmniRushVoiceStatus = {
  signedIn: boolean;
  /** Null: the account's catalog does not say; the first upload decides. */
  available: boolean | null;
  reason: string | null;
  /** Days the speech provider keeps uploaded audio, when the backend says (for the privacy note). */
  providerRetentionDays?: number | null;
  /** Seconds of dictation left today, when the account has a daily cap. */
  remainingSecondsToday?: number | null;
  repo: string | null;
  branch: string | null;
};

/** GET /omnirush/integrity/:sessionId: the server's "Good session ★" for one chat ("pending" until it confirms). */
export type OmniRushGoodSession = {
  good_session: true | false | "pending";
  reasons: string[];
  good_session_reasons: string[];
  integrity: string | null;
  checked_at: string | null;
  /** The server's human message per quality reason code, when it sends them. */
  messages?: Record<string, string>;
};

/** The user's web search switch (GET/PUT /omnirush/web-search): `enabled` = on and allowed by the server. */
export type OmniRushWebSearchState = { enabled: boolean; user: boolean; serverAllows: boolean };

/** Work mode (the server's `work` switch, as the local server last read it). */
/** `available`: Work is off but the account can try it (POST /work/enable). */
/** `autopilot`/`writes_paused`/`full_access`: F action-layer capabilities, carried by /work/state (contract Work Addendum F). */
/** `meetings`: the server transcribes meeting audio (capabilities.work.meetings); everything about meetings stays hidden without it. */
export type OmniRushWorkState = { enabled: boolean; available?: boolean; sources: string[]; message: string | null; workspaceId: string | null; autopilot?: boolean; writes_paused?: boolean; full_access?: boolean; meetings?: boolean; enterprise?: OmniRushWorkEnterprise | null };
/** A company account (`work.enterprise` in the capabilities; absent for everyone else): the company's state and the
 *  person's role, whether staff turned Code on, what uploads, and the admin portal. */
export type OmniRushWorkEnterprise = {
  status: "pending" | "active" | "denied" | "suspended";
  org: { id: string; name: string; domain: string | null } | null;
  role: "owner" | "admin" | "member" | null;
  code: boolean;
  capture: { code: boolean; chat: boolean };
  portal_url: string | null;
};
/** F action-layer: the user's automation settings (GET/PATCH /omnirush/work/settings). `full_access` implies `autopilot`. */
export type OmniRushWorkSettings = { autopilot: boolean; full_access: boolean; writes_paused: boolean };
/** One row of the Work activity log (GET /omnirush/work/actions): a write the agent made in a connected app. */
export type OmniRushWorkActionResult = "done" | "failed" | "undone";
export type OmniRushWorkAction = {
  id: string;
  source: string;
  tool: string;
  /** Null on older rows and on writes that failed before a target was known. */
  target: string | null;
  summary: string;
  result: OmniRushWorkActionResult;
  undoable: boolean;
  created_at: string;
  undone_at: string | null;
};
/** GET /omnirush/work/org/insights (owner only): aggregate team activity + smart alerts, never message content. */
export type OmniRushWorkInsightsAlert = { kind: string; level: "warn" | "serious"; text: string };
export type OmniRushWorkInsightsMember = {
  user_id: string;
  email: string;
  role: string | null;
  job_role: string | null;
  activity: number;
  prev_activity: number;
  /** Signed percent change vs the previous window. */
  trend: number;
  active_days: number;
  last_active: string | null;
  meetings: number;
  /** Already sorted desc by the server. */
  by_source: Record<string, number>;
  by_kind: Record<string, number>;
  /** Top work areas as [label, count], highest first. */
  focus: [string, number][];
  /** One point per day in the window, chronological (length === range.days). */
  daily: { d: string; n: number }[];
  alerts: OmniRushWorkInsightsAlert[];
};
export type OmniRushWorkInsights = {
  org: { id: string; name: string };
  range: { days: number; from: string; to: string };
  team: { members: number; active_members: number; total_activity: number; meetings: number; alerts: number };
  members: OmniRushWorkInsightsMember[];
};
/** The company profile and first-run steps (contract Addendum B2: GET/POST /omnirush/work/onboarding). */
export type OmniRushWorkOrg = { id: string; name: string; domain?: string | null; size?: string | null; industry?: string | null; tools?: string[] | null; custom_tools?: string[] | null; enterprise?: boolean; status?: "pending" | "active" | "denied" | "suspended" | string | null };
export type OmniRushWorkStarter = { title: string; prompt: string };
/** `next`: the step a company account resumes at (an older server has none). `sample_data` is always false now. */
export type OmniRushWorkOnboarding = { done: boolean; org?: OmniRushWorkOrg | null; steps?: Partial<Record<"company" | "connected" | "first_chat", boolean>>; sample_data?: boolean; next?: "company" | "tools" | "connect" | "invite" | "done" | string | null };
export type OmniRushWorkOnboardingInput = { company: string; domain?: string; size?: string; industry?: string; role?: string; tools: string[]; custom_tools?: string[] };
export type OmniRushWorkOnboardingResult = { org: OmniRushWorkOrg; recommended_sources?: string[]; starters?: OmniRushWorkStarter[] };
/** GET /omnirush/work/org/members (contract Addendum B2, C1 adds `you_role` and `org.tools`). */
export type OmniRushWorkMember = { user_id: string; email: string; role: "owner" | "admin" | "member" | string; job_role?: string | null; tools?: string[] | null; you?: boolean };
export type OmniRushWorkInvite = { id: string; email: string; created_at?: string | null; expires_at?: string | null; link?: string | null };
export type OmniRushWorkMembers = { org: OmniRushWorkOrg | null; members: OmniRushWorkMember[]; invites: OmniRushWorkInvite[]; you_role?: "owner" | "admin" | "member" | string };
/** GET /omnirush/work/org/connectors: the connectors the company shows its members. Owners and admins (`can_manage`) also
 *  get every connector the company may use (`allowed`), whether it is shown and how many members connected it; `shown`
 *  null shows them all. */
export type OmniRushWorkOrgConnector = { id: string; label: string; shown: boolean; members_connected: number };
export type OmniRushWorkOrgConnectors = {
  org: { id: string; name: string } | null;
  role: string | null;
  can_manage: boolean;
  connectors: { id: string; label: string }[];
  shown?: string[] | null;
  staff_limited?: boolean;
  members?: number;
  allowed?: OmniRushWorkOrgConnector[];
};
export type OmniRushWorkOrgPatch = { name?: string; domain?: string; size?: string; industry?: string; tools?: string[]; custom_tools?: string[] };
/** A connected source's problem (contract Addendum C1): what to show and which button fixes it. */
export type OmniRushWorkAttention = {
  kind: "reconnect" | "failing" | "stale" | "coverage" | string;
  message: string;
  action: "reconnect" | "retry" | "setup" | null;
  since: string | null;
};
/** GET /omnirush/work/feed (contract Addendum C1). */
export type OmniRushWorkFeedItem = { id: string; source: string; kind: string; title: string; who?: string | null; at?: string | null; url?: string | null; reason?: string | null; due_at?: string | null; starts_at?: string | null };
export type OmniRushWorkFeed = {
  generated_at: string;
  sources: { id: string; label: string; status: OmniRushWorkConnectorStatus; attention?: OmniRushWorkAttention | null }[];
  groups: { needs_you: OmniRushWorkFeedItem[]; today: OmniRushWorkFeedItem[]; fyi: OmniRushWorkFeedItem[] };
};
/** Whether the Work chat's engine has the hosted Work tools (the app's own check, GET /work/chat-tools). */
export type OmniRushWorkChatTools = { attached: boolean; reason: string | null };
/** `paused_by_admin`: the company (or OmniRush) turned the connector off; the connection is kept and can only be disconnected. */
export type OmniRushWorkConnectorStatus = "disconnected" | "connected" | "error" | "syncing" | "unavailable" | "paused_by_admin";
/** One source of GET /omnirush/work/connectors (e2e/work-mode-contract-2026-11-09.md). */
export type OmniRushWorkConnector = {
  id: string;
  label: string;
  status: OmniRushWorkConnectorStatus;
  account?: string;
  error?: string;
  scopes?: string[];
  last_sync_at: string | null;
  records: number;
  sync_enabled: boolean;
  /** A page to finish setup on after consent (GitHub: choose the repositories the App sees). */
  setup_url?: string;
  attention?: OmniRushWorkAttention | null;
  coverage?: { records: number; by_kind?: Record<string, number> } | null;
  skipped_records?: number;
  /** "import": no sign-in, the data comes from an uploaded export (WhatsApp); "credentials": a server and a password
   *  (other email over IMAP, other calendar over CalDAV or a link), connected with `connectWorkCredentials`; "key": a pasted
   *  API key (Stripe, Freshdesk, Pipedrive, ClickUp, monday.com, GitLab, Shopify; Trello: a key and a token), also `connectWorkCredentials`; "hook": the account's inbound URL for Zapier,
   *  Make or n8n (`createWorkHook`); absent for OAuth sources. */
  mode?: "import" | "credentials" | "key" | "hook" | string;
  last_import_at?: string | null;
  /** What a source that picks could read (Asana's workspaces), once its first sync has seen them; `picked` is true for all
   *  until the user picks (`setWorkConnectorPicked`). */
  choices?: { id: string; name: string; picked: boolean }[];
  /** What a sign-in source asks before its sign-in page (Zendesk: "host", the account's address; Intercom: "region"),
   *  sent with `startWorkConnector`. */
  start_fields?: string[];
  /** With `paused_by_admin`: who turned it off ("org": the company's owner or an admin, "staff": OmniRush). */
  paused_by?: "org" | "staff" | string;
  /** The sync's pass (null for pushed and imported sources and before a first run; absent from older servers). */
  progress?: OmniRushWorkSyncProgress | null;
};
/** A server-side source's sync pass: `phase` idle when no run reads now; `done` records read this pass; `total` when the
 *  provider says (Gmail); `steps_done`/`steps_total` for a list read one item at a time (GitHub repositories, channels). */
export type OmniRushWorkSyncProgress = {
  phase: "backfill" | "incremental" | "idle" | string;
  done: number;
  total: number | null;
  steps_done: number | null;
  steps_total: number | null;
  started_at?: string | null;
  updated_at?: string | null;
};
/** What `startWorkConnector` sends for a source with `start_fields`. A reconnect may send nothing: the server keeps the
 *  address or region the source has. */
export type OmniRushWorkStart = { host?: string; region?: "us" | "eu" | "au" };
/** The connect form of a "credentials" or "key" source (POST /omnirush/work/connectors/{id}/connect). */
export type OmniRushWorkCredentials = {
  preset?: string; host?: string; port?: number; security?: "tls" | "starttls"; url?: string; username?: string; password?: string; api_key?: string;
  /** Shopify: the Client ID of the store's Dev Dashboard app (`api_key` is then its secret). */
  client_id?: string;
  /** Trello: the user token (`api_key` is the app's key). */
  token?: string;
};
/** One chat-per-day record the desktop reads from the Mac's local chat.db
 *  and pushes to POST /omnirush/work/imessage (contract Addendum D5). */
export type OmniRushIMessageRecord = {
  chat_key: string;
  chat_name: string | null;
  is_group: boolean;
  day: string;
  occurred_at: string;
  text: string;
  participants: { name: string | null; handle: string; service: string | null }[];
};
export type OmniRushIMessageImport = { imported: number; skipped: number; total: number };
/** One source of GET /omnirush/work/health (contract Addendum A1). */
export type OmniRushWorkHealth = {
  id: string;
  status?: string;
  token_ok?: boolean;
  scopes_ok?: boolean;
  missing_scopes?: string[];
  last_sync_at?: string | null;
  last_error?: string | null;
  backlog_estimate?: number | null;
  checks?: { name: string; ok: boolean; detail?: string | null }[];
};
export type OmniRushWorkEntityKind = "person" | "company" | "deal" | "project" | "product" | "other";
export type OmniRushWorkEntitySummary = {
  id: string;
  kind: OmniRushWorkEntityKind | string;
  name: string;
  keys: string[];
  record_count: number;
  sources: string[];
  last_activity_at: string | null;
};
export type OmniRushWorkFactKind = "decision" | "preference" | "policy" | "fact" | "contact_note";
export type OmniRushWorkFact = {
  id: string;
  entity_id?: string | null;
  kind: OmniRushWorkFactKind | string;
  text: string;
  source_record_ids?: string[];
  created_by?: "agent" | "user" | string;
  status: "active" | "retired" | string;
  created_at?: string;
  updated_at?: string;
};
export type OmniRushWorkEntityRecord = {
  source_id: string;
  source: string;
  kind: string;
  subject?: string | null;
  text_preview?: string | null;
  occurred_at?: string | null;
  actors?: unknown;
  /** A link to the record at its source, when the server has one. */
  url?: string | null;
};
export type OmniRushWorkEntityDetail = {
  entity: OmniRushWorkEntitySummary & { attrs?: Record<string, unknown> };
  records: OmniRushWorkEntityRecord[];
  facts: OmniRushWorkFact[];
  related: { id: string; kind: string; name: string; reason?: string | null }[];
};

/** GET /omnirush/work/graph and /timeline (contract Addendum B1). Node ids are `e:<id>`, `r:<id>` and `f:<id>`. */
export type OmniRushWorkGraphNode = {
  id: string;
  type: "entity" | "record" | "fact" | string;
  kind: string;
  label: string;
  sub?: string | null;
  source?: string | null;
  occurred_at?: string | null;
  degree: number;
  url?: string | null;
};
export type OmniRushWorkGraphEdge = { a: string; b: string; kind: "mentions" | "link" | "related" | "about" | string; reason?: string | null };
export type OmniRushWorkGraph = { nodes: OmniRushWorkGraphNode[]; edges: OmniRushWorkGraphEdge[]; counts: Record<string, number>; truncated: boolean };
export type OmniRushWorkTimelineItem = Omit<OmniRushWorkGraphNode, "degree">;
export type OmniRushWorkAnswerStyle = "brief" | "detailed";
/** GET /omnirush/work/search (contract D1): hits grouped by channel, groups in the order of their best hit. */
export type OmniRushWorkSearchItem = {
  source_id: string;
  channel: string;
  kind: string;
  subject?: string | null;
  /** The best matching sentence, query words wrapped in `**`. */
  snippet?: string | null;
  who?: string | null;
  occurred_at?: string | null;
  url?: string | null;
  match?: "keyword" | "meaning" | "both" | string;
};
export type OmniRushWorkSearchGroup = { channel: string; group?: string; label: string; count: number; items: OmniRushWorkSearchItem[] };
export type OmniRushWorkSearch = {
  query: string;
  semantic: boolean;
  /** Present while the account's chunks are still being embedded. */
  indexing?: { embedded: number; total: number } | null;
  total: number;
  groups: OmniRushWorkSearchGroup[];
  coverage_note?: string | null;
};
export type OmniRushWorkSearchQuery = { q: string; channels?: string; from?: string; to?: string; limit?: number };
/** GET /omnirush/work/coverage (contract D6): which channel groups Ask sees. */
export type OmniRushWorkCoverageGroup = { group: string; label: string; state: "connected" | "missing" | "attention" | string; sources: string[]; said_you_use?: boolean };
export type OmniRushWorkCoverage = { groups: OmniRushWorkCoverageGroup[]; connected: number; total: number; missing_used: string[] };
/** GET /omnirush/work/deals (contract D3). */
export type OmniRushWorkDealFilter = "open" | "at_risk" | "closing_soon";
export type OmniRushWorkDeal = {
  source_id: string;
  url?: string | null;
  name?: string | null;
  company?: string | null;
  amount?: number | null;
  stage?: string | null;
  close_date?: string | null;
  owner?: string | null;
  last_touch?: { at: string | null; channel: string; direction?: "in" | "out" | string } | null;
  risk: string[];
};
export type OmniRushWorkDealRecord = { source_id: string; kind: string; channel: string; subject?: string | null; at?: string | null; direction?: string; url?: string | null };
export type OmniRushWorkDealDetail = OmniRushWorkDeal & {
  contacts?: { id: string; name: string }[];
  activity?: { channel: string; items: OmniRushWorkDealRecord[] }[];
  awaiting_us?: OmniRushWorkDealRecord[];
  meetings?: OmniRushWorkDealRecord[];
  facts?: OmniRushWorkFact[];
};
/** One chat-export import (contract D5: GET/POST /omnirush/work/imports). */
export type OmniRushWorkImportKind = "whatsapp" | "telegram";
export type OmniRushWorkImport = { id: string; source?: string; file_name?: string | null; status: "parsing" | "done" | "failed" | string; records: number; error?: string | null; created_at?: string | null };
/** A meeting (contract D4: /omnirush/work/meetings). Segments come with GET /meetings/{id}. */
export type OmniRushWorkMeetingSegment = { start_ms: number; end_ms: number; text: string; speaker: "me" | "them" | string };
export type OmniRushWorkMeeting = {
  id: string;
  title: string;
  status: "created" | "processing" | "done" | "failed" | string;
  started_at: string;
  ended_at: string | null;
  audio_seconds?: number | null;
  segments?: OmniRushWorkMeetingSegment[];
};
/** One audio part's answer: its segments, or `duplicate` when the server already has it. */
export type OmniRushWorkMeetingPartAnswer = { status: "done" | "duplicate"; speaker: string; part: number; seconds?: number; segments?: OmniRushWorkMeetingSegment[] };
/** GET /omnirush/work/catalog: the connectors the pickers show, grouped, with the team sizes (an older server: 404, the
 *  app's built-in copy is used). */
export type OmniRushWorkCatalogConnector = {
  id: string;
  label: string;
  short?: string | null;
  category: string;
  mode?: string | null;
  includes?: string[];
  offered: boolean;
  local_only?: boolean;
};
export type OmniRushWorkCatalog = {
  version: string | number;
  sizes: string[];
  categories: { id: string; label: string }[];
  connectors: OmniRushWorkCatalogConnector[];
};
/** GET /omnirush/work/records/detail: one record for the viewer (an older server: 404, the item opens its URL). */
export type OmniRushWorkRecordView = "mail" | "chat" | "issue" | "doc" | "event" | "crm" | "ticket" | "finance" | "meeting" | "code" | "generic";
export type OmniRushWorkRecordActor = { name?: string | null; email?: string | null; role?: string | null };
export type OmniRushWorkRecordBody = { format: "html" | "markdown" | "text" | string; content: string; truncated?: boolean; origin?: "stored" | "live" | string };
export type OmniRushWorkRecordAttachment = { n: number; name: string; size?: number | null; content_type?: string | null; available?: boolean };
export type OmniRushWorkRecordDetail = {
  source_id: string;
  source: string;
  channel?: string | null;
  kind: string;
  view: OmniRushWorkRecordView | string;
  subject?: string | null;
  url?: string | null;
  occurred_at?: string | null;
  state?: Record<string, unknown> | null;
  actors?: OmniRushWorkRecordActor[];
  body?: OmniRushWorkRecordBody | null;
  attachments?: OmniRushWorkRecordAttachment[];
  thread?: Record<string, unknown>[];
  comments?: Record<string, unknown>[];
  fields?: Record<string, unknown>[];
  event?: Record<string, unknown> | null;
  links?: { source_id: string; kind: string; subject?: string | null }[];
  actions?: { id: string }[];
  writes_paused?: boolean;
  can_live?: boolean;
  live_error?: string | null;
};
/** POST /omnirush/work/records/action and /compose: the write tool's result, and whether it can be undone. */
export type OmniRushWorkRecordActionInput = { source_id: string; action: string; args?: Record<string, unknown>; client_action_id?: string };
export type OmniRushWorkComposeInput = { kind: "mail" | "meeting"; connector: string } & Record<string, unknown>;
export type OmniRushWorkRecordActionResult = { ok: boolean; action_id?: string | null; result?: unknown; undo?: { available: boolean } | null };

export type OmniRushSubagentModelState = {
  setting: OmniRushSubagentModelSetting;
  /** Whether an omnirush.ai account is signed in (its models can run). */
  signedIn: boolean;
  /** The account's model catalog, in the backend's order. */
  models: Array<{ id: string; name: string; family: string | null; default: boolean; efforts: string[]; modes?: Array<"native" | "box">; switch_group?: string }>;
};

export type OmniRushDesktopCloudSyncChange = {
  id: string;
  kind: "new" | "modified" | "removed";
  resourceKind: "llmProvider" | "marketplace" | "plugin" | "configItem";
  marketplaceId?: string;
  pluginId?: string;
  previousLastUpdatedAt: string | null;
  nextLastUpdatedAt: string | null;
  queuedAt: number;
};

export type OmniRushDesktopCloudSyncState = {
  entries: Record<string, unknown>;
  updatedAt: number;
  version: 1;
};

export type OmniRushDesktopCloudSyncResult = {
  changes: OmniRushDesktopCloudSyncChange[];
  state: OmniRushDesktopCloudSyncState;
};

export type OmniRushCloudPluginInstallResult = {
  item: CloudImportedPlugin;
  warnings: string[];
};

export type OmniRushCloudPluginsResult = {
  marketplaces: Record<string, CloudImportedMarketplace>;
  plugins: Record<string, CloudImportedPlugin>;
};

export type OmniRushClaudePluginComponent = {
  type: "mcp" | "skill" | "command" | "agent";
  name: string;
  description: string | null;
};

export type OmniRushClaudePluginPreview = {
  pluginId: string;
  name: string;
  description: string | null;
  version: string | null;
  source: { owner: string; repo: string; ref: string; dir: string | null };
  components: OmniRushClaudePluginComponent[];
  warnings: string[];
};

function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export type OmniRushCommandItem = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string | null;
  subtask?: boolean;
  scope: "workspace" | "global";
};

export type OmniRushMcpItem = {
  name: string;
  config: Record<string, unknown>;
  source: "config.project" | "config.global" | "config.remote";
  disabledByTools?: boolean;
  managedOAuth?: OmniRushManagedMcpConnection | null;
  /** The engine plugin's decision for this entry (null until the project's engine read it). */
  decision?: OmniRushMcpDecision | null;
};

/** What the engine's MCP plugin decided for one configured server (the server's list). */
export type OmniRushMcpDecision = {
  name: string;
  status: "allowed" | "blocked";
  code: string;
  reason?: string;
  id?: string;
  package?: string;
  runtime?: "npm" | "pypi" | "remote";
  title?: string;
  version?: string;
  /** runtime "remote": the address it reaches, and whether it signs in with OAuth. */
  url?: string;
  oauth?: boolean;
  sandbox?: boolean;
  renamed_to?: string;
  notes?: string[];
};

/** A server the list supports, as a one-click preset. */
export type OmniRushMcpPreset = {
  id: string;
  title: string;
  why: string | null;
  runtime: "npm" | "pypi" | "remote";
  package: string;
  version: string | null;
  versions: string;
  command: string[];
  localPagesOnly: boolean;
  /** A remote server's exact address (runtime "remote"), and whether it signs in with OAuth. */
  url?: string | null;
  oauth?: boolean;
  /** How to set it up (account servers such as Figma). */
  setup?: string | null;
  /** Uses the person's own account: its sessions cannot be repeated. */
  account?: boolean;
};

/** The MCP list as the desktop last saw it (GET /workspace/:id/mcp). */
export type OmniRushMcpPolicyView = {
  mode: "allowlist" | "disabled";
  enabled: boolean;
  message: string | null;
  supported: OmniRushMcpPreset[];
  decisions: OmniRushMcpDecision[];
  reportAt: number | null;
  /** What of the project's own config the engine left out (plugins, language server and formatter commands). */
  ignored?: Array<{ kind: "plugin" | "lsp" | "formatter" | "provider"; name: string; source: string | null }>;
  /** One line about it, or null. */
  ignoredNotice?: string | null;
  /** The engine's MCP filter is missing, so no MCP server starts (fails closed); the warning, or null. */
  filterMissing?: string | null;
};

export type OmniRushMcpAppResource = {
  serverName: string;
  toolName: string;
  resourceUri: string;
  html: string;
  csp: {
    connectDomains: string[];
    resourceDomains: string[];
    frameDomains: string[];
    baseUriDomains: string[];
  };
  prefersBorder: boolean;
};

export type OmniRushMcpAppLaunchReference = {
  connectionId?: string;
  toolName: string;
  resourceUri: string;
  arguments: Record<string, unknown>;
};

export type OmniRushMcpAppCatalogApp = {
  serverName: string;
  /** Present for Connect app-host apps: launch them through this connection reference. */
  connectionId?: string;
  toolName: string;
  projectedToolName: string;
  resourceUri: string;
  title: string | null;
  description: string | null;
  /** True when the launch tool declares required input, so a host cannot start it with empty arguments. */
  requiresInput: boolean;
  /** True when calling the launch tool needs user approval (not explicitly read-only, or destructive). */
  requiresApproval: boolean;
};

export type OmniRushMcpAppCatalogServer = {
  serverName: string;
  /** Human-readable provider name for Connect app-host servers. */
  displayName?: string;
  connectionId?: string;
  reachable: boolean;
  error?: string;
  apps: OmniRushMcpAppCatalogApp[];
};

export type OmniRushMcpAppToolResult = {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

export type OmniRushMcpAppSandbox = {
  url: string;
  expectedOrigin: string;
};

export function normalizeMcpAppHostOrigin(hostOrigin: string): string {
  return hostOrigin === "file://" ? "null" : hostOrigin;
}

export type OmniRushManagedMcpConnection = {
  name: string;
  serverUrl: string;
  enabled: boolean;
  status: "needs_auth" | "connecting" | "connected" | "reconnect_required";
  lastError: string | null;
  hasCredential: boolean;
  updatedAt: number;
};

export type OmniRushManagedOAuthState = {
  available: boolean;
  recovery: { at: number; reason: string; quarantinedTo: string } | null;
};

export type OmniRushManagedMcpStartResult =
  | { status: "connected" }
  | { status: "needs_auth"; authorizeUrl: string };

export type OmniRushMcpEngineSync = {
  status: "ok" | "failed";
  at: number;
  failures: Array<{ name: string; status?: number; message?: string }>;
};

export type OmniRushCloudMcpProviderModelContext = {
  provider: string;
  model: string;
};

export type OmniRushCloudMcpFailureStage =
  | "prerequisites"
  | "token_mint"
  | "desired_config"
  | "engine_delivery"
  | "transport_auth"
  | "tool_registration"
  | "provider_projection"
  | "plugin_load"
  | "steering"
  | "desired"
  | "workspace"
  | "configuration"
  | "registration"
  | "engine_status"
  | "tool_ids"
  | "plugin_canary";

export type OmniRushCloudMcpFailureCode =
  | "cloud_desired_missing"
  | "cloud_mcp_missing"
  | "cloud_mcp_disabled"
  | "cloud_endpoint_invalid"
  | "cloud_token_org_mismatch"
  | "cloud_mcp_needs_auth"
  | "invalid_mcp_token"
  | "mcp_session_revoked"
  | "mcp_membership_revoked"
  | "insufficient_mcp_scope"
  | "wrong_mcp_resource"
  | "workspace_directory_ambiguous"
  | "opencode_unconfigured"
  | "opencode_engine_unreachable"
  | "opencode_unreachable"
  | "cloud_status_missing"
  | "cloud_disabled"
  | "omnirush_cloud_auth_required"
  | "omnirush_cloud_auth_invalid"
  | "omnirush_cloud_token_expired"
  | "omnirush_cloud_membership_required"
  | "omnirush_cloud_scope_missing"
  | "omnirush_cloud_resource_forbidden"
  | "omnirush_cloud_resource_not_found"
  | "omnirush_cloud_client_registration_required"
  | "cloud_connection_failed"
  | "cloud_registration_failed"
  | "cloud_tools_denied"
  | "opencode_tool_ids_unsupported"
  | "opencode_tool_ids_unavailable"
  | "cloud_tools_missing"
  | "provider_projection_unavailable"
  | "provider_projection_missing"
  | "extensions_plugin_missing"
  | string;

export type OmniRushCloudMcpFailure = {
  code: OmniRushCloudMcpFailureCode;
  stage: OmniRushCloudMcpFailureStage | string;
  retryable: boolean;
  recommendedAction: string;
  message: string;
  aliases?: string[];
  requestId?: string;
  referenceId?: string;
  details?: unknown;
};

export type OmniRushCloudMcpCompatibility = {
  omnirush: {
    serverVersion: string | null;
    app: Record<string, string | number | boolean | null> | null;
  };
  opencode: {
    expectedVersion: string | null;
    actualVersion: string | null;
    probe: "ok" | "unavailable" | "not_checked" | string;
    error?: unknown;
  };
  pluginFileHashes: Array<{
    name: string;
    sha256: string | null;
    error?: string;
  }>;
  supportedFeatures: {
    dynamicMcp: boolean;
    directoryScoping: boolean;
    toolIds: boolean;
    providerToolProjection: boolean;
    pluginCanaries: boolean;
  };
  experimentalToolIds: {
    checked: boolean;
    expected: string[];
    present: string[];
    missing: string[];
    includesMcpTools: boolean | null;
    limitation?: string;
    error?: unknown;
  };
  experimentalProviderTools: {
    checked: boolean;
    provider?: string;
    model?: string;
    expected: string[];
    present: string[];
    missing: string[];
    includesMcpTools: boolean | null;
    limitation?: string;
    error?: unknown;
  };
};

export type OmniRushCloudMcpHealthPhase =
  | "missing_desired"
  | "workspace_ambiguous"
  | "engine_unconfigured"
  | "engine_unreachable"
  | "engine_missing"
  | "engine_disabled"
  | "engine_needs_auth"
  | "engine_needs_client_registration"
  | "engine_failed"
  | "registration_failed"
  | "denied_by_tools"
  | "tool_ids_unsupported"
  | "cloud_tools_missing"
  | "provider_projection_missing"
  | "extensions_plugin_missing"
  | "ready"
  | string;

export type OmniRushCloudMcpDeliverySnapshot = {
  state: "not_desired" | "pending" | "registering" | "ready" | "failed" | "stale" | string;
  desiredRevision: string | null;
  appliedRevision: string | null;
  updatedAt: number | null;
  appliedAt: number | null;
  lastAttemptAt: number | null;
  trigger?: string;
  failure?: OmniRushCloudMcpFailure;
};

export type OmniRushCloudMcpProbeStep = {
  step: "initialize" | "initialized_notice" | "tools_list" | string;
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  error?: unknown;
};

export type OmniRushCloudMcpProbeTrace = {
  endpoint: string | null;
  startedAt: string;
  latencyMs: number;
  protocolVersion: string | null;
  serverInfo: { name: string | null; version: string | null } | null;
  steps: OmniRushCloudMcpProbeStep[];
};

export type OmniRushCloudMcpEngineRefreshStep = {
  step: "engine_disconnect" | "reapply" | string;
  ok: boolean;
  latencyMs: number;
  detail?: unknown;
};

export type OmniRushCloudMcpEngineRefresh = {
  performed: boolean;
  reason?: "desired_missing" | string;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  steps: OmniRushCloudMcpEngineRefreshStep[];
};

export type OmniRushCloudMcpEngineRefreshResult = {
  refresh: OmniRushCloudMcpEngineRefresh;
  health: OmniRushCloudMcpHealth;
};

export type OmniRushCloudMcpHealth = {
  schemaVersion: 1;
  phase: OmniRushCloudMcpHealthPhase;
  usable: boolean;
  usableByCurrentModel: boolean | null;
  connectCatalogEnabled: boolean;
  workspace: {
    id: string;
    type: string;
    directory: string | null;
    path: string;
  };
  desired: {
    present: boolean;
    name: "omnirush-cloud";
    revision: string | null;
    config: Record<string, unknown> | null;
    token: {
      present: boolean;
      metadata: Record<string, string | number | boolean | null>;
    };
    org?: Record<string, string | number | boolean | null>;
    app?: Record<string, string | number | boolean | null>;
    updatedAt?: number;
  };
  delivery: OmniRushCloudMcpDeliverySnapshot;
  engine: {
    status: "not_checked" | "missing" | "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration" | "unreachable" | "unknown" | string;
    error?: unknown;
  };
  /** The engine's own view of every MCP server it tracks (older servers omit this). */
  engineInspection?: {
    checked: boolean;
    cloudPresent?: boolean;
    serverCount?: number;
    servers?: Array<{ name: string; status: string; error?: string }>;
  };
  tools: {
    expected: string[];
    present: string[];
    missing: string[];
    direct: {
      checked: boolean;
      source: "mcp_tools_list" | string;
      expected: string[];
      present: string[];
      missing: string[];
      trace?: OmniRushCloudMcpProbeTrace;
      error?: unknown;
      failure?: OmniRushCloudMcpFailure;
    };
    providerProjection: {
      checked: boolean;
      provider?: string;
      model?: string;
      source?: "experimental_tool" | "provider_capability" | string;
      limitation?: string;
      modelExists?: boolean;
      toolCalling?: boolean | null;
      present: string[];
      missing: string[];
      error?: unknown;
    };
  };
  pluginCanaries: {
    expected: string[];
    present: string[];
    missing: string[];
  };
  compatibility: OmniRushCloudMcpCompatibility;
  toolDenies: unknown[];
  firstFailure: OmniRushCloudMcpFailure | null;
  checkedAt: string;
  durationMs?: number;
};

export type OmniRushCloudMcpReconcilePayload = {
  workspaceId: string;
  name: "omnirush-cloud";
  config: Record<string, unknown>;
  /** Desktop-private credential; the local server must never project it into OpenCode. */
  appHostAuthorization?: string;
  tokenMetadata?: Record<string, string | number | boolean | null>;
  org?: Record<string, string | number | boolean | null>;
  app?: Record<string, string | number | boolean | null>;
  appVersion?: string;
  buildSha?: string;
  connectCatalogEnabled?: boolean;
  trigger?: string;
  provider?: string;
  model?: string;
};

export type OmniRushWorkspaceExport = {
  workspaceId: string;
  exportedAt: number;
  opencode?: Record<string, unknown>;
  omnirush?: Record<string, unknown>;
  skills?: Array<{ name: string; description?: string; trigger?: string; content: string }>;
  commands?: Array<{ name: string; description?: string; template?: string }>;
  files?: Array<{ path: string; content: string }>;
};

export type OmniRushWorkspaceExportSensitiveMode = "auto" | "include" | "exclude";

export type OmniRushWorkspaceExportWarning = {
  id: string;
  label: string;
  detail: string;
};

export type OmniRushArtifactItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  createdAt?: number;
  updatedAt?: number;
  mime?: string;
};

export type OmniRushArtifactList = {
  items: OmniRushArtifactItem[];
};

export type OmniRushConnectState = {
  ok: true;
  schemaVersion: 1;
  status: "available" | "missing" | "invalid" | "unreadable";
  connectEnabled: boolean;
  cloudMcpPresent: boolean;
  googleWorkspace: { legacyConfigured: boolean };
};

export type OmniRushExtensionActionCall = {
  extensionId: string;
  action: string;
  args?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

export type OmniRushExtensionActionResult =
  | {
    ok: true;
    extensionId: string;
    action: string;
    result: unknown;
    context?: Record<string, unknown>;
  }
  | {
    ok: false;
    error: string;
    message: string;
  };

export type OmniRushResolvedArtifactTarget = {
  id: string;
  kind: "file" | "url";
  value: string;
  name: string;
  preview: "browser" | "markdown" | "code" | "sheet" | "slides" | "document" | "image" | "pdf" | "html" | "text" | "external";
  confidence: number;
  reason: string;
  exists?: boolean;
  size?: number;
  updatedAt?: number;
  contentType?: string;
};

export type OmniRushWorkspaceFileStat = {
  ok: boolean;
  path: string;
  exists: boolean;
  kind?: "file" | "dir" | "other";
  size?: number;
  updatedAt?: number;
};

export type OmniRushInboxItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  updatedAt?: number;
};

export type OmniRushInboxList = {
  items: OmniRushInboxItem[];
};

export type OmniRushInboxUploadResult = {
  ok: boolean;
  path: string;
  bytes: number;
};

export type OmniRushUserEnvItem = {
  key: string;
  updatedAt: number;
  hasValue: boolean;
  value?: string;
};

export type OmniRushActor = {
  type: "remote" | "host";
  clientId?: string;
  tokenHash?: string;
};

export type OmniRushAuditEntry = {
  id: string;
  workspaceId: string;
  actor: OmniRushActor;
  action: string;
  target: string;
  summary: string;
  timestamp: number;
  details?: Record<string, unknown>;
};

export type OmniRushReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp" | "agent" | "command";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};

export type OmniRushReloadEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  reason: "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";
  trigger?: OmniRushReloadTrigger;
  timestamp: number;
};

export type OmniRushUiControlRequest = {
  id: string;
  kind: "context" | "query" | "command";
  input: unknown;
  createdAt: number;
};

export type OmniRushSessionGroupDefinition = {
  id: string;
  label: string;
};

export type OmniRushSessionGroupState = {
  groups: OmniRushSessionGroupDefinition[];
  assignments: Record<string, string>;
};

export type OmniRushSessionGroupEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  type: "session_groups.updated";
  action: "created" | "updated" | "deleted" | "assigned" | "reordered" | "imported";
  groupId?: string;
  sessionId?: string;
  timestamp: number;
};

// Fallback for explicit server-mode URL derivation. Desktop local workers replace this
// with the persisted runtime-discovered port once the host reports it.
export const DEFAULT_OMNIRUSH_SERVER_PORT = 8787;

const STORAGE_URL_OVERRIDE = "omnirush.server.urlOverride";
const STORAGE_PORT_OVERRIDE = "omnirush.server.port";
const STORAGE_TOKEN = "omnirush.server.token";
const STORAGE_HOST_AUTH_KEY = "omnirush.server.hostToken";
const STORAGE_REMOTE_ACCESS = "omnirush.server.remoteAccessEnabled";

type OmniRushBootstrap = {
  token?: string;
};

declare global {
  interface Window {
    __OMNIRUSH_BOOTSTRAP__?: OmniRushBootstrap;
  }
}

export function normalizeOmniRushServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return normalizeBaseUrl(withProtocol);
}

export function isLoopbackOmniRushServerUrl(input: string) {
  const normalized = normalizeOmniRushServerUrl(input) ?? "";
  if (!normalized) return false;
  try {
    const hostname = new URL(normalized).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function parseOmniRushWorkspaceIdFromUrl(input: string) {
  const normalized = normalizeOmniRushServerUrl(input) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const legacyIndex = segments.indexOf("w");
    if (legacyIndex >= 0 && segments[legacyIndex + 1]) {
      return decodeURIComponent(segments[legacyIndex + 1]);
    }
    const workspaceIndex = segments.indexOf("workspace");
    if (workspaceIndex >= 0 && segments[workspaceIndex + 1]) {
      return decodeURIComponent(segments[workspaceIndex + 1]);
    }
    return null;
  } catch {
    const match = normalized.match(/\/(?:w|workspace)\/([^/?#]+)/);
    if (!match?.[1]) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
}

export function buildOmniRushWorkspaceBaseUrl(hostUrl: string, workspaceId?: string | null) {
  const normalized = normalizeOmniRushServerUrl(hostUrl) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const workspaceIndex = segments.indexOf("workspace");
    const legacyIndex = segments.indexOf("w");
    const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
    if (mountIndex >= 0 && segments[mountIndex + 1]) {
      const prefix = segments.slice(0, mountIndex).join("/");
      url.pathname = `${prefix ? `/${prefix}` : ""}/workspace/${encodeURIComponent(
        decodeURIComponent(segments[mountIndex + 1]),
      )}`;
      return url.toString().replace(/\/+$/, "");
    }

    const id = (workspaceId ?? "").trim();
    if (!id) return url.toString().replace(/\/+$/, "");

    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/workspace/${encodeURIComponent(id)}`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    const id = (workspaceId ?? "").trim();
    if (!id) return normalized;
    return `${normalized.replace(/\/+$/, "")}/workspace/${encodeURIComponent(id)}`;
  }
}

const OMNIRUSH_INVITE_PARAM_URL = "ow_url";
const OMNIRUSH_INVITE_PARAM_TOKEN = "ow_token";
const OMNIRUSH_INVITE_PARAM_STARTUP = "ow_startup";
const OMNIRUSH_INVITE_PARAM_AUTO_CONNECT = "ow_auto_connect";

export type OmniRushConnectInvite = {
  url: string;
  token?: string;
  startup?: "server";
  autoConnect?: boolean;
};

export function readOmniRushConnectInviteFromSearch(input: string | URLSearchParams) {
  const search =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;

  const rawUrl = search.get(OMNIRUSH_INVITE_PARAM_URL)?.trim() ?? "";
  const url = normalizeOmniRushServerUrl(rawUrl);
  if (!url) return null;

  const token = search.get(OMNIRUSH_INVITE_PARAM_TOKEN)?.trim() ?? "";
  const startupRaw = search.get(OMNIRUSH_INVITE_PARAM_STARTUP)?.trim() ?? "";
  const startup = startupRaw === "server" ? "server" : undefined;
  const autoConnect = search.get(OMNIRUSH_INVITE_PARAM_AUTO_CONNECT)?.trim() === "1";

  return {
    url,
    token: token || undefined,
    startup,
    autoConnect: autoConnect || undefined,
  } satisfies OmniRushConnectInvite;
}

export function stripOmniRushConnectInviteFromUrl(input: string) {
  try {
    const url = new URL(input);
    url.searchParams.delete(OMNIRUSH_INVITE_PARAM_URL);
    url.searchParams.delete(OMNIRUSH_INVITE_PARAM_TOKEN);
    url.searchParams.delete(OMNIRUSH_INVITE_PARAM_STARTUP);
    url.searchParams.delete(OMNIRUSH_INVITE_PARAM_AUTO_CONNECT);
    return url.toString();
  } catch {
    return input;
  }
}

export function readOmniRushServerSettings(): OmniRushServerSettings {
  if (typeof window === "undefined") return {};
  try {
    const urlOverride = normalizeOmniRushServerUrl(
      window.localStorage.getItem(STORAGE_URL_OVERRIDE) ?? "",
    );
    const portRaw = window.localStorage.getItem(STORAGE_PORT_OVERRIDE) ?? "";
    const portOverride = portRaw ? Number(portRaw) : undefined;
    const token = window.localStorage.getItem(STORAGE_TOKEN) ?? undefined;
    const hostToken = window.localStorage.getItem(STORAGE_HOST_AUTH_KEY) ?? undefined;
    const remoteAccessRaw = window.localStorage.getItem(STORAGE_REMOTE_ACCESS) ?? "";
    return {
      urlOverride: urlOverride ?? undefined,
      portOverride: Number.isNaN(portOverride) ? undefined : portOverride,
      token: token?.trim() || undefined,
      hostToken: hostToken?.trim() || undefined,
      remoteAccessEnabled: remoteAccessRaw === "1",
    };
  } catch {
    return {};
  }
}

export function writeOmniRushServerSettings(next: OmniRushServerSettings): OmniRushServerSettings {
  if (typeof window === "undefined") return next;
  try {
    const urlOverride = normalizeOmniRushServerUrl(next.urlOverride ?? "");
    const portOverride = typeof next.portOverride === "number" ? next.portOverride : undefined;
    const token = next.token?.trim() || undefined;
    const hostToken = next.hostToken?.trim() || undefined;
    const remoteAccessEnabled = next.remoteAccessEnabled === true;

    if (urlOverride) {
      window.localStorage.setItem(STORAGE_URL_OVERRIDE, urlOverride);
    } else {
      window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    }

    if (typeof portOverride === "number" && !Number.isNaN(portOverride)) {
      window.localStorage.setItem(STORAGE_PORT_OVERRIDE, String(portOverride));
    } else {
      window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    }

    if (token) {
      window.localStorage.setItem(STORAGE_TOKEN, token);
    } else {
      window.localStorage.removeItem(STORAGE_TOKEN);
    }

    if (hostToken) {
      window.localStorage.setItem(STORAGE_HOST_AUTH_KEY, hostToken);
    } else {
      window.localStorage.removeItem(STORAGE_HOST_AUTH_KEY);
    }

    if (remoteAccessEnabled) {
      window.localStorage.setItem(STORAGE_REMOTE_ACCESS, "1");
    } else {
      window.localStorage.removeItem(STORAGE_REMOTE_ACCESS);
    }

    return readOmniRushServerSettings();
  } catch {
    return next;
  }
}

function readForceEnvSettingsFlag(): boolean {
  const raw =
    typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_OMNIRUSH_FORCE_ENV_SETTINGS === "string"
      ? import.meta.env.VITE_OMNIRUSH_FORCE_ENV_SETTINGS.trim()
      : "";
  return /^(1|true|yes|on)$/i.test(raw);
}

export function hydrateOmniRushServerSettingsFromEnv() {
  if (typeof window === "undefined") return;
  if (isOmniRushGatewayRuntime()) return;

  const envUrl = typeof import.meta.env?.VITE_OMNIRUSH_URL === "string"
    ? import.meta.env.VITE_OMNIRUSH_URL.trim()
    : "";
  const envPort = typeof import.meta.env?.VITE_OMNIRUSH_PORT === "string"
    ? import.meta.env.VITE_OMNIRUSH_PORT.trim()
    : "";
  const envToken = typeof import.meta.env?.VITE_OMNIRUSH_TOKEN === "string"
    ? import.meta.env.VITE_OMNIRUSH_TOKEN.trim()
    : "";
  const envHostToken = typeof import.meta.env?.VITE_OMNIRUSH_HOST_TOKEN === "string"
    ? import.meta.env.VITE_OMNIRUSH_HOST_TOKEN.trim()
    : "";
  const bootstrapToken = typeof window.__OMNIRUSH_BOOTSTRAP__?.token === "string"
    ? window.__OMNIRUSH_BOOTSTRAP__.token.trim()
    : "";
  const forceEnvSettings = readForceEnvSettingsFlag();

  if (!envUrl && !envPort && !envToken && !envHostToken && !bootstrapToken) return;

  try {
    const current = readOmniRushServerSettings();
    const next: OmniRushServerSettings = { ...current };
    let changed = false;

    if (envUrl && (forceEnvSettings || !current.urlOverride)) {
      const normalized = normalizeOmniRushServerUrl(envUrl);
      if (normalized && normalized !== current.urlOverride) {
        next.urlOverride = normalized;
        changed = true;
      }
    }

    if (envPort && (forceEnvSettings || !current.portOverride)) {
      const parsed = Number(envPort);
      if (Number.isFinite(parsed) && parsed > 0 && parsed !== current.portOverride) {
        next.portOverride = parsed;
        changed = true;
      }
    }

    if (bootstrapToken && current.token !== bootstrapToken) {
      next.token = bootstrapToken;
      changed = true;
    } else if (envToken && (forceEnvSettings || !current.token) && current.token !== envToken) {
      next.token = envToken;
      changed = true;
    }

    if (envHostToken && (forceEnvSettings || !current.hostToken) && current.hostToken !== envHostToken) {
      next.hostToken = envHostToken;
      changed = true;
    } else if (forceEnvSettings && !envHostToken && current.hostToken) {
      // Headless web does not inject the host token into the Vite bundle.
      // Drop a leftover value from an earlier desktop/dev session so it
      // cannot keep authorizing host-token routes from the browser.
      next.hostToken = undefined;
      changed = true;
    }

    if (changed) {
      writeOmniRushServerSettings(next);
    }
  } catch {
    // ignore
  }
}

export function clearOmniRushServerSettings() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    window.localStorage.removeItem(STORAGE_TOKEN);
    window.localStorage.removeItem(STORAGE_HOST_AUTH_KEY);
    window.localStorage.removeItem(STORAGE_REMOTE_ACCESS);
  } catch {
    // ignore
  }
}

export class OmniRushServerError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function buildHeaders(
  token?: string,
  hostToken?: string,
  extra?: Record<string, string>,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-OmniRush-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

function buildAuthHeaders(token?: string, hostToken?: string, extra?: Record<string, string>) {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-OmniRush-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

// Use Tauri's fetch when running in the desktop app to avoid CORS issues.
// Stream URLs (SSE) bypass the plugin because its `fetch_read_body` IPC call
// blocks until the body closes — that freezes the webview for infinite bodies.
const OMNIRUSH_STREAM_URL_RE = /\/events(\b|\?)|\/event-stream\b|\/stream\b/;

function isStreamUrl(url: string): boolean {
  return OMNIRUSH_STREAM_URL_RE.test(url);
}

function isLoopbackUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

const resolveFetch = (url?: string) => {
  if (!isDesktopRuntime()) return globalThis.fetch;
  if (url && isStreamUrl(url)) {
    return typeof window !== "undefined" ? window.fetch.bind(window) : globalThis.fetch;
  }
  return desktopFetch;
};

const DEFAULT_OMNIRUSH_SERVER_TIMEOUT_MS = 10_000;
const ENGINE_RELOAD_TIMEOUT_MS = 60_000;
/** The session files status waits for omnirush.ai (10 s at most on the server side). */
const FILES_USED_TIMEOUT_MS = 15_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal = signal
    ? { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal }
    : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fetchImpl(url, initWithSignal), timeoutPromise]);
  } catch (error) {
    const name = (error && typeof error === "object" && "name" in error ? (error as any).name : "") as string;
    if (name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export type OmniRushEditorSearchMatch = { line: number; text: string; start: number; end: number; textOffset: number };
export type OmniRushEditorSearchResult = {
  engine: "ripgrep" | "git" | "none";
  files: Array<{ path: string; matches: OmniRushEditorSearchMatch[] }>;
  matchCount: number;
  truncated: boolean;
  timedOut: boolean;
};
export type OmniRushEditorTree = { git: boolean; files: string[]; truncated: boolean; generatedAt: number };
export type OmniRushEditorFile = {
  path: string;
  content: string | null;
  bytes: number;
  updatedAt: number;
  binary?: boolean;
  tooLarge?: boolean;
};
export type OmniRushEditorGitFile = { path: string; from?: string; index: string; worktree: string };
export type OmniRushEditorGitStatus = {
  repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: OmniRushEditorGitFile[];
};

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: unknown; raw?: { bytes: Uint8Array<ArrayBuffer>; contentType: string }; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch(url);
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      signal: options.signal,
      // Raw bytes (meeting audio) go as they are, never through a Blob: a Blob may be paged to disk.
      headers: buildHeaders(options.token, options.hostToken, options.raw ? { "Content-Type": options.raw.contentType } : undefined),
      body: options.raw ? options.raw.bytes : options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? DEFAULT_OMNIRUSH_SERVER_TIMEOUT_MS,
  );

  const text = await response.text();

  if (!response.ok) {
    // The server's readable message when it sent one; a non-JSON error page
    // (a proxy, a crash) still rejects with the status, not a parse error.
    let json: { code?: unknown; message?: unknown; details?: unknown } | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" && json.message
      ? json.message
      : response.statusText || `Request failed (${response.status})`;
    throw new OmniRushServerError(response.status, code, message, json?.details);
  }

  return (text ? JSON.parse(text) : null) as T;
}

async function requestAgentContextDiagnosticsJson(
  baseUrl: string,
  path: string,
  options: {
    token?: string;
    hostToken?: string;
    body: AgentContextDiagnosticsRequest;
    timeoutMs: number;
  },
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const result = await requestAgentContextDiagnosticsPayload({
    url,
    init: {
      method: "POST",
      headers: buildHeaders(options.token, options.hostToken),
      body: JSON.stringify(options.body),
    },
    timeoutMs: options.timeoutMs,
    fetchImpl: (input, init, deadlineAtMs) => isDesktopRuntime()
      ? desktopFetchAgentContextDiagnostics(input, init, deadlineAtMs)
      : globalThis.fetch(input, init),
  });

  if (!result.response.ok) {
    const payload = result.payload;
    const code = payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string"
      ? payload.code
      : "request_failed";
    const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
      ? payload.message
      : result.response.statusText;
    const details = payload && typeof payload === "object" && "details" in payload
      ? payload.details
      : undefined;
    throw new OmniRushServerError(result.response.status, code, message, details);
  }

  return result.payload;
}

async function requestMultipartRaw(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: FormData; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch(url);
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "POST",
      headers: buildAuthHeaders(options.token, options.hostToken),
      body: options.body,
    },
    options.timeoutMs ?? DEFAULT_OMNIRUSH_SERVER_TIMEOUT_MS,
  );
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function requestBinary(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; timeoutMs?: number } = {},
): Promise<{ data: ArrayBuffer; contentType: string | null; filename: string | null }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch(url);
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildAuthHeaders(options.token, options.hostToken),
    },
    options.timeoutMs ?? DEFAULT_OMNIRUSH_SERVER_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new OmniRushServerError(response.status, code, message, json?.details);
  }

  const contentType = response.headers.get("content-type");
  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const filenameRaw = filenameMatch?.[1] ?? filenameMatch?.[2] ?? null;
  const filename = filenameRaw ? decodeURIComponent(filenameRaw) : null;
  const data = await response.arrayBuffer();
  return { data, contentType, filename };
}

export type WorkspaceRunMode = "default" | "approve" | "run-everything";
export type WorkspaceRunModeResponse = {
  mode: WorkspaceRunMode | null;
  catchAll: "ask" | "allow" | "deny" | null;
  path: string;
  supported: boolean;
  reason?: string;
  refreshPending: boolean;
};
export type WorkspaceRunModeUpdate = WorkspaceRunModeResponse & {
  changed: boolean;
  refresh: "reloaded" | "deferred" | "skipped";
};

export function createOmniRushServerClient(options: { baseUrl: string; token?: string; hostToken?: string }) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const token = options.token;
  const hostToken = options.hostToken;

  const timeouts = {
    health: 3_000,
    capabilities: 6_000,
    listWorkspaces: 8_000,
    activateWorkspace: 10_000,
    // The server first stops the workspace's running sessions and releases its engine instance.
    deleteWorkspace: 30_000,
    sessionRead: 12_000,
    status: 6_000,
    diagnostics: AGENT_CONTEXT_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    config: 10_000,
    cloudMcpHealth: 12_000,
    cloudMcpProbeHealth: 30_000,
    cloudMcpReconcile: 60_000,
    workspaceExport: 30_000,
    binary: 60_000,
  };

  return {
    baseUrl,
    token,
    claude: {
      request: <T,>(workspaceId: string, route: string, body?: unknown, signal?: AbortSignal) => requestJson<T>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/claude/${route}`, {token, hostToken, method: body === undefined ? "GET" : "POST", body, signal, timeoutMs: 15_000}),
    },
    health: () =>
      requestJson<{ ok: boolean; version: string; uptimeMs: number }>(baseUrl, "/health", { token, hostToken, timeoutMs: timeouts.health }),
    runtimeVersions: () =>
      requestJson<OmniRushRuntimeSnapshot>(baseUrl, "/runtime/versions", { token, hostToken, timeoutMs: timeouts.status }),
    status: () => requestJson<OmniRushServerDiagnostics>(baseUrl, "/status", { token, hostToken, timeoutMs: timeouts.status }),
    capabilities: () => requestJson<OmniRushServerCapabilities>(baseUrl, "/capabilities", { token, hostToken, timeoutMs: timeouts.capabilities }),
    getConnectState: (workspaceId?: string | null) => {
      const query = new URLSearchParams();
      if (workspaceId?.trim()) query.set("workspaceId", workspaceId.trim());
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<OmniRushConnectState>(baseUrl, `/experimental/connect/state${suffix}`, { token, hostToken, timeoutMs: timeouts.config });
    },
    putDenSession: async (body: { baseUrl: string; token: string; orgId: string }) => {
      await requestJson<unknown>(baseUrl, "/den-session", { hostToken, method: "PUT", body, timeoutMs: timeouts.config });
    },
    deleteDenSession: async () => {
      await requestJson<unknown>(baseUrl, "/den-session", { hostToken, method: "DELETE", timeoutMs: timeouts.config });
    },
    runCloudProviderSyncNow: async (reason?: string) =>
      parseCloudProviderSyncRun(await requestJson<unknown>(baseUrl, "/cloud-provider-sync/run", {
        hostToken,
        method: "POST",
        body: reason ? { reason } : {},
        timeoutMs: timeouts.cloudMcpReconcile,
      })),
    getCloudProviderSyncStatus: async () =>
      parseCloudProviderSyncStatus(await requestJson<unknown>(baseUrl, "/cloud-provider-sync/status", {
        token,
        timeoutMs: timeouts.config,
      })),
    getEngineV2PreviewStatus: async (): Promise<EngineV2PreviewStatus> =>
      parseEngineV2PreviewStatus(await requestJson<unknown>(baseUrl, "/experimental/engine-v2-preview/status", {
        token,
        timeoutMs: timeouts.config,
      })),
    setEngineV2PreviewEnabled: async (enabled: boolean): Promise<EngineV2PreviewStatus> =>
      parseEngineV2PreviewStatus(await requestJson<unknown>(baseUrl, "/experimental/engine-v2-preview", {
        token,
        method: "PUT",
        body: { enabled },
        timeoutMs: timeouts.config,
      })),
    setEngineV2PreviewChatRouting: async (chatRouting: boolean): Promise<EngineV2PreviewStatus> =>
      parseEngineV2PreviewStatus(await requestJson<unknown>(baseUrl, "/experimental/engine-v2-preview", {
        token,
        method: "PUT",
        body: { chatRouting },
        timeoutMs: timeouts.config,
      })),
    setConnectState: (connectEnabled: boolean) => requestJson<OmniRushConnectState>(baseUrl, "/experimental/connect/state", { token, hostToken, method: "PUT", body: { connectEnabled }, timeoutMs: timeouts.config }),
    callExtensionAction: (payload: OmniRushExtensionActionCall) =>
      requestJson<OmniRushExtensionActionResult>(baseUrl, "/experimental/extensions/call", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.binary,
      }),
    listWorkspaces: () => requestJson<OmniRushWorkspaceList>(baseUrl, "/workspaces", { token, hostToken, timeoutMs: timeouts.listWorkspaces }),
    listWorkspaceTasks: (workspaceId: string) =>
      requestJson<OmniRushWorkspaceTaskList>(baseUrl, `/workspaces/${encodeURIComponent(workspaceId)}/tasks`, { token, hostToken, timeoutMs: timeouts.status }),
    createWorkspaceTask: (workspaceId: string, payload: { prompt: string; title?: string; parentSessionId?: string | null }) =>
      requestJson<{ task: OmniRushWorkspaceTask; workspace: WorkspaceInfo }>(baseUrl, `/workspaces/${encodeURIComponent(workspaceId)}/tasks`, {
        token, hostToken, method: "POST", body: payload, timeoutMs: timeouts.activateWorkspace * 3,
      }),
    showWorkspaceTask: (workspaceId: string, taskId: string) =>
      requestJson<{ task: OmniRushWorkspaceTask; stat: string; reply: string }>(baseUrl, `/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}`, { token, hostToken, timeoutMs: timeouts.config }),
    bringBackWorkspaceTask: (workspaceId: string, taskId: string, mode: "apply" | "merge") =>
      requestJson<{ mode: "apply" | "merge"; files: Array<{ status: string; file: string }>; task: OmniRushWorkspaceTask }>(baseUrl, `/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}/${mode}`, {
        token, hostToken, method: "POST", timeoutMs: timeouts.binary,
      }),
    stopWorkspaceTask: (workspaceId: string, taskId: string) =>
      requestJson<{ stopped: boolean; task: OmniRushWorkspaceTask }>(baseUrl, `/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}/stop`, {
        token, hostToken, method: "POST", timeoutMs: timeouts.config,
      }),
    removeWorkspaceTask: (workspaceId: string, taskId: string) =>
      requestJson<{ ok: boolean; removed: string }>(baseUrl, `/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}`, {
        token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteWorkspace,
      }),
    createLocalWorkspace: (payload: { folderPath: string; name: string; preset: string }) =>
      requestJson<WorkspaceList>(baseUrl, "/workspaces/local", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.activateWorkspace,
      }),
    createRemoteWorkspace: (payload: {
      baseUrl: string;
      omnirushHostUrl?: string | null;
      omnirushToken?: string | null;
      omnirushWorkspaceId?: string | null;
      omnirushWorkspaceName?: string | null;
      displayName?: string | null;
      directory?: string | null;
      remoteType?: "omnirush" | "opencode";
      sandboxBackend?: string | null;
      sandboxRunId?: string | null;
      sandboxContainerName?: string | null;
    }) =>
      requestJson<WorkspaceList>(baseUrl, "/workspaces/remote", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.activateWorkspace,
      }),
    updateWorkspaceDisplayName: (workspaceId: string, displayName: string | null) =>
      requestJson<WorkspaceList>(baseUrl, `/workspaces/${encodeURIComponent(workspaceId)}/display-name`, {
        token,
        hostToken,
        method: "PATCH",
        body: { displayName },
        timeoutMs: timeouts.activateWorkspace,
      }),
    activateWorkspace: (workspaceId: string, options?: { persist?: boolean }) => {
      const query = options?.persist ? "?persist=true" : "";
      return requestJson<{ activeId: string; workspace: OmniRushWorkspaceInfo; persisted: boolean }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}/activate${query}`,
        { token, hostToken, method: "POST", timeoutMs: timeouts.activateWorkspace },
      );
    },
    deleteWorkspace: (workspaceId: string) =>
      requestJson<{ ok: boolean; deleted: boolean; persisted: boolean; activeId: string | null; items: OmniRushWorkspaceInfo[]; workspaces?: WorkspaceInfo[] }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteWorkspace },
      ),
    getSessionGroups: (workspaceId: string) =>
      requestJson<{ state: OmniRushSessionGroupState; updatedAt: number | null }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      ),
    putSessionGroups: (workspaceId: string, state: OmniRushSessionGroupState) =>
      requestJson<{ state: OmniRushSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, method: "PUT", body: { state }, timeoutMs: timeouts.config },
      ),
    createSessionGroup: (workspaceId: string, input: { id?: string; label: string }) =>
      requestJson<{ state: OmniRushSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, method: "POST", body: input, timeoutMs: timeouts.config },
      ),
    reorderSessionGroups: (workspaceId: string, groupIds: string[]) =>
      requestJson<{ state: OmniRushSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/reorder`,
        { token, hostToken, method: "PATCH", body: { groupIds }, timeoutMs: timeouts.config },
      ),
    assignSessionGroup: (workspaceId: string, sessionId: string, groupId: string | null) =>
      requestJson<{ state: OmniRushSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/assignments/${encodeURIComponent(sessionId)}`,
        { token, hostToken, method: "PATCH", body: { groupId }, timeoutMs: timeouts.config },
      ),
    renameSessionGroup: (workspaceId: string, groupId: string, label: string) =>
      requestJson<{ state: OmniRushSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/${encodeURIComponent(groupId)}`,
        { token, hostToken, method: "PATCH", body: { label }, timeoutMs: timeouts.config },
      ),
    removeSessionGroup: (workspaceId: string, groupId: string, destinationGroupId: string | null = null) =>
      requestJson<{ state: OmniRushSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/${encodeURIComponent(groupId)}${destinationGroupId ? `?destinationGroupId=${encodeURIComponent(destinationGroupId)}` : ""}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.config },
      ),
    listSessionGroupEvents: (workspaceId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${options.since}` : "";
      return requestJson<{ items: OmniRushSessionGroupEvent[]; cursor?: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/events${query}`,
        { token, hostToken },
      );
    },
    exportWorkspace: (
      workspaceId: string,
      options?: { sensitiveMode?: OmniRushWorkspaceExportSensitiveMode },
    ) => {
      const query = new URLSearchParams();
      if (options?.sensitiveMode) {
        query.set("sensitive", options.sensitiveMode);
      }
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<OmniRushWorkspaceExport>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/export${suffix}`, {
        token,
        hostToken,
        timeoutMs: timeouts.workspaceExport,
      });
    },
    getConfig: (workspaceId: string) =>
      requestJson<{ opencode: Record<string, unknown>; omnirush: Record<string, unknown>; updatedAt?: number | null }>(
        baseUrl,
        `/workspace/${workspaceId}/config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    getWorkspaceRunMode: (workspaceId: string) =>
      requestJson<WorkspaceRunModeResponse>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/permissions/mode`, {
        token, hostToken, timeoutMs: timeouts.config,
      }),
    setWorkspaceRunMode: (workspaceId: string, mode: WorkspaceRunMode) =>
      requestJson<WorkspaceRunModeUpdate>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/permissions/mode`, {
        token, hostToken, method: "PUT", body: { mode }, timeoutMs: 60_000,
      }),
    getEffectivePermissions: (workspaceId: string) =>
      requestJson<OmniRushEffectivePermissionsResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/permissions/effective`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    listAuthorizedFolders: (workspaceId: string) =>
      requestJson<OmniRushAuthorizedFoldersResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/authorized-folders`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    setAuthorizedFolders: (workspaceId: string, folders: string[]) =>
      requestJson<OmniRushAuthorizedFoldersUpdateResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/authorized-folders`,
        {
          token,
          hostToken,
          method: "PUT",
          body: { folders },
          timeoutMs: timeouts.config,
        },
      ),
    setRuntimeDisabledProviders: (workspaceId: string, providers: string[]) =>
      requestJson<OmniRushRuntimeDisabledProvidersResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/runtime-config/disabled-providers`,
        {
          token,
          hostToken,
          method: "POST",
          body: { providers },
          timeoutMs: timeouts.config,
        },
      ),
    getRuntimeConfigStatus: (workspaceId: string) =>
      requestJson<OmniRushRuntimeConfigStatus>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/runtime-config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    getRuntimeApprovals: () =>
      requestJson<OmniRushRuntimeApprovals>(baseUrl, "/runtime-config/approvals", { token, hostToken, timeoutMs: timeouts.config }),
    setRuntimeApprovals: (mode: OmniRushApprovalMode) =>
      requestJson<OmniRushRuntimeApprovals & { ok: boolean; changed: boolean }>(baseUrl, "/runtime-config/approvals", {
        token,
        hostToken,
        method: "PUT",
        body: { mode },
        timeoutMs: timeouts.config,
      }),
    getFilesUsed: () =>
      requestJson<OmniRushFilesUsed>(baseUrl, "/runtime-config/files-used", { token, hostToken, timeoutMs: FILES_USED_TIMEOUT_MS }),
    getCaptureStatus: () =>
      requestJson<OmniRushCaptureStatus>(baseUrl, "/omnirush/capture/status", { token, hostToken, timeoutMs: timeouts.config }),
    getProviderLock: () =>
      requestJson<OmniRushProviderLock>(baseUrl, "/omnirush/provider-lock", { token, hostToken, timeoutMs: timeouts.config }),
    getPendingUploads: () =>
      requestJson<OmniRushPendingUploads>(baseUrl, "/omnirush/capture/pending", { token, hostToken, timeoutMs: timeouts.config }),
    flushPendingUploads: () =>
      requestJson<{ before: number; after: number }>(baseUrl, "/omnirush/capture/flush", { token, hostToken, method: "POST", body: {}, timeoutMs: SIGN_OUT_FLUSH_TIMEOUT_MS }),
    getWorkspaceBox: (workspaceId: string, options?: { fresh?: boolean; sessionId?: string | null }) =>
      requestJson<OmniRushWorkspaceBox>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/box${boxQuery(options)}`, {
        token, hostToken, timeoutMs: timeouts.config,
      }),
    setWorkspaceBox: (workspaceId: string, mode: "on" | "off" | null) =>
      requestJson<OmniRushWorkspaceBoxChange>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/box`, {
        token, hostToken, method: "PUT", body: { mode }, timeoutMs: ENGINE_RELOAD_TIMEOUT_MS,
      }),
    setWorkspaceBoxBackend: (workspaceId: string, backend: string) =>
      requestJson<OmniRushWorkspaceBoxChange>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/box`, {
        token, hostToken, method: "PUT", body: { backend }, timeoutMs: ENGINE_RELOAD_TIMEOUT_MS,
      }),
    retryWorkspaceBox: (workspaceId: string) =>
      // A fresh backend check, then the status (each bounded at 10 s on the server).
      requestJson<OmniRushWorkspaceBox>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/box/retry`, {
        token, hostToken, method: "POST", body: {}, timeoutMs: 30_000,
      }),
    /** One sandbox setup step (the setup screen): the elevated ones wait for the admin prompt, so the limit is long. */
    setupWorkspaceBox: (workspaceId: string, action: OmniRushWorkspaceBoxSetupAction) =>
      requestJson<OmniRushWorkspaceBox>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/box/setup`, {
        token, hostToken, method: "POST", body: { action }, timeoutMs: 35 * 60_000,
      }),
    resetWorkspaceBox: (workspaceId: string) =>
      requestJson<{ removed: boolean }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/box/reset`, {
        token, hostToken, method: "POST", body: {}, timeoutMs: 90_000,
      }),
    /** Buildathon projects (folders) and the event's `repro` block: their chats get its rules and box. */
    setBuildathon: (body: { repro: { box: string; agent_rules: string } | null; projects: string[]; deadline_at: string | null }) =>
      requestJson<{ ok: boolean; projects: number; box: string }>(baseUrl, "/runtime-config/buildathon", {
        token, hostToken, method: "PUT", body, timeoutMs: ENGINE_RELOAD_TIMEOUT_MS,
      }),
    getAgentAssist: () =>
      requestJson<OmniRushAgentAssist>(baseUrl, "/runtime-config/agent-assist", { token, hostToken, timeoutMs: timeouts.config }),
    setAgentAssist: (change: Partial<Record<OmniRushAgentAssistFeature, boolean>>) =>
      requestJson<OmniRushAgentAssistChange>(baseUrl, "/runtime-config/agent-assist", {
        token,
        hostToken,
        method: "PUT",
        body: change,
        timeoutMs: ENGINE_RELOAD_TIMEOUT_MS,
      }),
    getBestPractices: () =>
      requestJson<OmniRushBestPractices>(baseUrl, "/runtime-config/best-practices", { token, hostToken, timeoutMs: timeouts.config }),
    setBestPractices: (enabled: boolean) =>
      requestJson<OmniRushBestPracticesChange>(baseUrl, "/runtime-config/best-practices", {
        token,
        hostToken,
        method: "PUT",
        body: { enabled },
        timeoutMs: ENGINE_RELOAD_TIMEOUT_MS,
      }),
    getVoiceStatus: (workspaceId?: string | null) =>
      requestJson<OmniRushVoiceStatus>(
        baseUrl,
        `/omnirush/voice/status${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ""}`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    getGoodSession: (sessionId: string) =>
      requestJson<OmniRushGoodSession>(baseUrl, `/omnirush/integrity/${encodeURIComponent(sessionId)}`, { token, hostToken, timeoutMs: timeouts.sessionRead }),
    /** Where the renderer POSTs one voice segment (multipart), and its headers; the local server adds the device bearer. */
    voiceTranscriptionEndpoint: () => ({
      url: `${baseUrl}/omnirush/voice/transcribe`,
      headers: buildAuthHeaders(token, hostToken),
    }),
    getSubagentModel: () =>
      requestJson<OmniRushSubagentModelState>(baseUrl, "/omnirush/subagent-model", { token, hostToken, timeoutMs: timeouts.config }),
    setSubagentModel: (setting: OmniRushSubagentModelSetting) =>
      requestJson<{ ok: boolean; setting: OmniRushSubagentModelSetting }>(baseUrl, "/omnirush/subagent-model", {
        token,
        hostToken,
        method: "PUT",
        body: setting,
        timeoutMs: timeouts.config,
      }),
    /** `fresh`: the switch read again from the server when the cached one is over half a minute old. */
    getWorkState: (options?: { fresh?: boolean }) =>
      requestJson<OmniRushWorkState>(baseUrl, options?.fresh ? "/work/state?fresh=1" : "/work/state", { token, hostToken, timeoutMs: timeouts.config }),
    getWorkOrgInsights: (days?: number) =>
      requestJson<OmniRushWorkInsights>(baseUrl, `/work/org/insights${days ? `?days=${days}` : ""}`, { token, hostToken, timeoutMs: timeouts.config }),
    ensureWorkWorkspace: () =>
      requestJson<{ workspaceId: string; path: string }>(baseUrl, "/work/workspace", { token, hostToken, method: "POST", timeoutMs: timeouts.activateWorkspace }),
    listWorkConnectors: () =>
      requestJson<OmniRushWorkConnector[]>(baseUrl, "/work/connectors", { token, hostToken, timeoutMs: timeouts.config }),
    startWorkConnector: (id: string, form?: OmniRushWorkStart) =>
      requestJson<{ auth_url: string }>(baseUrl, `/work/connectors/${encodeURIComponent(id)}/start`, { token, hostToken, method: "POST", ...(form ? { body: form } : {}), timeoutMs: timeouts.config }),
    connectWorkCredentials: (id: string, form: OmniRushWorkCredentials) =>
      requestJson<{ ok: boolean; account: string | null }>(baseUrl, `/work/connectors/${encodeURIComponent(id)}/connect`, { token, hostToken, method: "POST", body: form, timeoutMs: 60_000 }),
    /** A new inbound URL for "hook" / "hook_org" (the one before stops working); the URL is shown this once. */
    createWorkHook: (id: string) =>
      requestJson<{ url: string }>(baseUrl, `/work/connectors/${encodeURIComponent(id)}/hook`, { token, hostToken, method: "POST", timeoutMs: timeouts.config }),
    disconnectWorkConnector: (id: string) =>
      requestJson<unknown>(baseUrl, `/work/connectors/${encodeURIComponent(id)}/disconnect`, { token, hostToken, method: "POST", timeoutMs: timeouts.config }),
    setWorkConnectorSync: (id: string, syncEnabled: boolean) =>
      requestJson<{ ok: boolean; sync_enabled: boolean }>(baseUrl, `/work/connectors/${encodeURIComponent(id)}`, { token, hostToken, method: "PATCH", body: { sync_enabled: syncEnabled }, timeoutMs: timeouts.config }),
    /** What a picking source reads from its next sync (Asana: workspace ids; [] is all). */
    setWorkConnectorPicked: (id: string, picked: string[]) =>
      requestJson<{ ok: boolean; picked: string[] }>(baseUrl, `/work/connectors/${encodeURIComponent(id)}`, { token, hostToken, method: "PATCH", body: { picked }, timeoutMs: timeouts.config }),
    getWorkHealth: (source?: string) =>
      requestJson<unknown>(baseUrl, `/work/health${source ? `?source=${encodeURIComponent(source)}` : ""}`, { token, hostToken, timeoutMs: timeouts.config }),
    /** Push iMessage records the desktop read from the Mac's local chat.db. */
    importIMessage: (records: OmniRushIMessageRecord[]) =>
      requestJson<OmniRushIMessageImport>(baseUrl, "/work/imessage", { token, hostToken, method: "POST", body: { records }, timeoutMs: timeouts.activateWorkspace }),
    getIMessageCount: () =>
      requestJson<{ records: number }>(baseUrl, "/work/imessage", { token, hostToken, timeoutMs: timeouts.config }),
    /** WhatsApp chat-days in Work (the Mac app sync and chat-export imports; the desktop's main process pushes them). */
    getWhatsAppLocalCount: () =>
      requestJson<{ records: number }>(baseUrl, "/work/whatsapp-local", { token, hostToken, timeoutMs: timeouts.config }),
    /** Telegram chat-days in Work (the desktop's sync from the user's own login and result.json imports). */
    getTelegramCount: () =>
      requestJson<{ records: number }>(baseUrl, "/work/telegram", { token, hostToken, timeoutMs: timeouts.config }),
    listWorkEntities: (query: { q?: string; kind?: string; limit?: number; cursor?: string } = {}) => {
      const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
      return requestJson<{ items: OmniRushWorkEntitySummary[]; next_cursor: string | null }>(baseUrl, `/work/entities${params.size ? `?${params}` : ""}`, { token, hostToken, timeoutMs: timeouts.config });
    },
    getWorkEntity: (id: string) =>
      requestJson<OmniRushWorkEntityDetail>(baseUrl, `/work/entities/${encodeURIComponent(id)}`, { token, hostToken, timeoutMs: timeouts.config }),
    addWorkFact: (fact: { text: string; kind: string; entity_id?: string }) =>
      requestJson<OmniRushWorkFact>(baseUrl, "/work/facts", { token, hostToken, method: "POST", body: fact, timeoutMs: timeouts.config }),
    updateWorkFact: (id: string, patch: { text?: string; status?: "active" | "retired" }) =>
      requestJson<OmniRushWorkFact>(baseUrl, `/work/facts/${encodeURIComponent(id)}`, { token, hostToken, method: "PATCH", body: patch, timeoutMs: timeouts.config }),
    enableWork: () =>
      requestJson<unknown>(baseUrl, "/work/enable", { token, hostToken, method: "POST", timeoutMs: timeouts.config }),
    getWorkOnboarding: () =>
      requestJson<OmniRushWorkOnboarding>(baseUrl, "/work/onboarding", { token, hostToken, timeoutMs: timeouts.config }),
    saveWorkOnboarding: (input: OmniRushWorkOnboardingInput) =>
      requestJson<OmniRushWorkOnboardingResult>(baseUrl, "/work/onboarding", { token, hostToken, method: "POST", body: input, timeoutMs: timeouts.config }),
    /** `role` and `send_email` (the server mails the invite) go only when given: an older server takes the e-mail alone. */
    inviteWorkMember: (email: string, options?: { role?: "member" | "admin"; sendEmail?: boolean }) =>
      requestJson<{ id?: string; email?: string; link: string; expires_at?: string }>(baseUrl, "/work/org/invites", {
        token, hostToken, method: "POST", timeoutMs: timeouts.config,
        body: { email, ...(options?.role ? { role: options.role } : {}), ...(options?.sendEmail ? { send_email: true } : {}) },
      }),
    acceptWorkInvite: (link: string) =>
      requestJson<{ ok: boolean; org?: OmniRushWorkOrg }>(baseUrl, "/work/org/invites/accept", { token, hostToken, method: "POST", body: { token: link }, timeoutMs: timeouts.config }),
    listWorkMembers: () =>
      requestJson<OmniRushWorkMembers>(baseUrl, "/work/org/members", { token, hostToken, timeoutMs: timeouts.config }),
    updateWorkOrg: (patch: OmniRushWorkOrgPatch) =>
      requestJson<{ org: OmniRushWorkOrg }>(baseUrl, "/work/org", { token, hostToken, method: "PATCH", body: patch, timeoutMs: timeouts.config }),
    updateWorkOrgMe: (patch: { job_role?: string; tools?: string[] }) =>
      requestJson<{ ok: boolean }>(baseUrl, "/work/org/me", { token, hostToken, method: "PATCH", body: patch, timeoutMs: timeouts.config }),
    cancelWorkInvite: (id: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/work/org/invites/${encodeURIComponent(id)}`, { token, hostToken, method: "DELETE", timeoutMs: timeouts.config }),
    removeWorkMember: (userId: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/work/org/members/${encodeURIComponent(userId)}`, { token, hostToken, method: "DELETE", timeoutMs: timeouts.config }),
    transferWorkOrg: (userId: string) =>
      requestJson<{ ok: boolean }>(baseUrl, "/work/org/transfer", { token, hostToken, method: "POST", body: { user_id: userId }, timeoutMs: timeouts.config }),
    leaveWorkOrg: () =>
      requestJson<{ ok: boolean }>(baseUrl, "/work/org/leave", { token, hostToken, method: "POST", timeoutMs: timeouts.config }),
    /** The company's connectors; an older server answers 404 (nothing to show). */
    getWorkOrgConnectors: () =>
      requestJson<OmniRushWorkOrgConnectors>(baseUrl, "/work/org/connectors", { token, hostToken, timeoutMs: timeouts.config }),
    /** What members see (owner or admin): the ids shown, or null for every connector the company may use. */
    setWorkOrgConnectors: (shown: string[] | null) =>
      requestJson<OmniRushWorkOrgConnectors>(baseUrl, "/work/org/connectors", { token, hostToken, method: "PATCH", body: { shown }, timeoutMs: timeouts.config }),
    /** A member's role (owner only): an admin also manages which connectors members see. */
    setWorkMemberRole: (userId: string, role: "admin" | "member") =>
      requestJson<{ ok: boolean; role: string }>(baseUrl, `/work/org/members/${encodeURIComponent(userId)}`, { token, hostToken, method: "PATCH", body: { role }, timeoutMs: timeouts.config }),
    getWorkFeed: (query: { source?: string; tz?: string; limit?: number } = {}) => {
      const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
      return requestJson<OmniRushWorkFeed>(baseUrl, `/work/feed${params.size ? `?${params}` : ""}`, { token, hostToken, timeoutMs: timeouts.config });
    },
    syncWorkConnector: (id: string) =>
      requestJson<{ ok: boolean; queued: boolean }>(baseUrl, `/work/connectors/${encodeURIComponent(id)}/sync`, { token, hostToken, method: "POST", timeoutMs: timeouts.config }),
    getWorkChatTools: () =>
      requestJson<OmniRushWorkChatTools>(baseUrl, "/work/chat-tools", { token, hostToken, timeoutMs: timeouts.config }),
    fixWorkChatTools: () =>
      requestJson<OmniRushWorkChatTools>(baseUrl, "/work/chat-tools/fix", { token, hostToken, method: "POST", timeoutMs: timeouts.activateWorkspace * 3 }),
    getWorkGraph: (query: { focus?: string; depth?: 1 | 2; kinds?: string; limit?: number } = {}) => {
      const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
      return requestJson<OmniRushWorkGraph>(baseUrl, `/work/graph${params.size ? `?${params}` : ""}`, { token, hostToken, timeoutMs: timeouts.config });
    },
    getWorkTimeline: (query: { focus?: string; cursor?: string; limit?: number } = {}) => {
      const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
      return requestJson<{ items: OmniRushWorkTimelineItem[]; next_cursor: string | null }>(baseUrl, `/work/timeline${params.size ? `?${params}` : ""}`, { token, hostToken, timeoutMs: timeouts.config });
    },
    getWorkSettings: () =>
      requestJson<OmniRushWorkSettings>(baseUrl, "/work/settings", { token, hostToken, timeoutMs: timeouts.config }),
    setWorkSettings: (patch: Partial<OmniRushWorkSettings>) =>
      requestJson<OmniRushWorkSettings>(baseUrl, "/work/settings", { token, hostToken, method: "PATCH", body: patch, timeoutMs: timeouts.config }),
    listWorkActions: (limit = 50) =>
      requestJson<{ actions: OmniRushWorkAction[] }>(baseUrl, `/work/actions?limit=${limit}`, { token, hostToken, timeoutMs: timeouts.config }),
    undoWorkAction: (id: string) =>
      requestJson<{ ok: true }>(baseUrl, `/work/actions/${encodeURIComponent(id)}/undo`, { token, hostToken, method: "POST", timeoutMs: timeouts.config }),
    searchWork: (query: OmniRushWorkSearchQuery) => {
      const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
      return requestJson<OmniRushWorkSearch>(baseUrl, `/work/search?${params}`, { token, hostToken, timeoutMs: timeouts.config });
    },
    getWorkCoverage: () =>
      requestJson<OmniRushWorkCoverage>(baseUrl, "/work/coverage", { token, hostToken, timeoutMs: timeouts.config }),
    createWorkMeeting: (body: { title?: string; started_at?: string }) =>
      requestJson<{ id: string }>(baseUrl, "/work/meetings", { token, hostToken, method: "POST", body, timeoutMs: timeouts.config }),
    getWorkMeeting: (id: string) =>
      requestJson<OmniRushWorkMeeting>(baseUrl, `/work/meetings/${encodeURIComponent(id)}`, { token, hostToken, timeoutMs: timeouts.config }),
    updateWorkMeeting: (id: string, patch: { title?: string; ended_at?: string }) =>
      requestJson<OmniRushWorkMeeting>(baseUrl, `/work/meetings/${encodeURIComponent(id)}`, { token, hostToken, method: "PATCH", body: patch, timeoutMs: timeouts.config }),
    /** One audio part (16 kHz mono 16-bit WAV, at most 2 MiB), transcribed while the request waits (up to about 2 min on the server). */
    uploadWorkMeetingAudio: (id: string, part: { speaker: "me" | "them"; part: number; offsetMs: number }, wav: Uint8Array<ArrayBuffer>) =>
      requestJson<OmniRushWorkMeetingPartAnswer>(baseUrl, `/work/meetings/${encodeURIComponent(id)}/audio?speaker=${part.speaker}&part=${part.part}&offset_ms=${part.offsetMs}`, {
        token, hostToken, method: "POST", raw: { bytes: wav, contentType: "audio/wav" }, timeoutMs: 150_000,
      }),
    listWorkDeals: (filter?: OmniRushWorkDealFilter) =>
      requestJson<{ items: OmniRushWorkDeal[] }>(baseUrl, `/work/deals${filter ? `?filter=${filter}` : ""}`, { token, hostToken, timeoutMs: timeouts.config }),
    getWorkDeal: (id: string) =>
      requestJson<OmniRushWorkDealDetail>(baseUrl, `/work/deals/${encodeURIComponent(id)}`, { token, hostToken, timeoutMs: timeouts.config }),
    listWorkImports: () =>
      requestJson<OmniRushWorkImport[]>(baseUrl, "/work/imports", { token, hostToken, timeoutMs: timeouts.config }),
    /** A WhatsApp (`.txt`/`.zip`) or Telegram (`result.json`) chat export, uploaded as it is. */
    importWorkChat: async (kind: OmniRushWorkImportKind, file: File) => {
      const form = new FormData();
      form.set("kind", kind);
      form.set("file", file);
      const result = await requestMultipartRaw(baseUrl, "/work/imports", { token, hostToken, method: "POST", body: form, timeoutMs: 300_000 });
      let json: { code?: unknown; message?: unknown } | null = null;
      try { json = result.text ? JSON.parse(result.text) : null; } catch { json = null; }
      if (!result.ok) {
        throw new OmniRushServerError(result.status, typeof json?.code === "string" ? json.code : "request_failed", typeof json?.message === "string" ? json.message : `Request failed (${result.status})`);
      }
      return json as unknown as { id: string; status: string; records: number };
    },
    getWorkAnswerStyle: () =>
      requestJson<{ style: OmniRushWorkAnswerStyle }>(baseUrl, "/work/answer-style", { token, hostToken, timeoutMs: timeouts.config }),
    setWorkAnswerStyle: (style: OmniRushWorkAnswerStyle) =>
      requestJson<{ style: OmniRushWorkAnswerStyle }>(baseUrl, "/work/answer-style", { token, hostToken, method: "PUT", body: { style }, timeoutMs: timeouts.config }),
    /** The connector catalog; an older server answers 404 (use the built-in copy). */
    getWorkCatalog: () =>
      requestJson<OmniRushWorkCatalog>(baseUrl, "/work/catalog", { token, hostToken, timeoutMs: timeouts.config }),
    /** One record for the viewer; `live` reads it from the source again ("auto": when the saved copy is short). */
    getWorkRecord: (id: string, live?: "auto" | "1" | "0") =>
      requestJson<OmniRushWorkRecordDetail>(baseUrl, `/work/records/detail?${new URLSearchParams({ id, ...(live ? { live } : {}) })}`, { token, hostToken, timeoutMs: 60_000 }),
    getWorkRecordAttachment: (id: string, n: number) =>
      requestBinary(baseUrl, `/work/records/attachment?${new URLSearchParams({ id, n: String(n) })}`, { token, hostToken, timeoutMs: 120_000 }),
    runWorkRecordAction: (input: OmniRushWorkRecordActionInput) =>
      requestJson<OmniRushWorkRecordActionResult>(baseUrl, "/work/records/action", { token, hostToken, method: "POST", body: input, timeoutMs: 60_000 }),
    composeWork: (input: OmniRushWorkComposeInput) =>
      requestJson<OmniRushWorkRecordActionResult>(baseUrl, "/work/compose", { token, hostToken, method: "POST", body: input, timeoutMs: 60_000 }),
    getWebSearch: () =>
      requestJson<OmniRushWebSearchState>(baseUrl, "/omnirush/web-search", { token, hostToken, timeoutMs: timeouts.config }),
    setWebSearch: (enabled: boolean) =>
      requestJson<OmniRushWebSearchState & { ok: boolean }>(baseUrl, "/omnirush/web-search", {
        token,
        hostToken,
        method: "PUT",
        body: { enabled },
        timeoutMs: timeouts.config,
      }),
    patchConfig: (workspaceId: string, payload: { opencode?: Record<string, unknown>; omnirush?: Record<string, unknown> }) =>
      requestJson<{ updatedAt?: number | null }>(baseUrl, `/workspace/${workspaceId}/config`, {
        token,
        hostToken,
        method: "PATCH",
        body: payload,
      }),
    getDesktopCloudSync: (workspaceId: string) =>
      requestJson<OmniRushDesktopCloudSyncState>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/desktop-cloud-sync`, {
        token,
        hostToken,
        timeoutMs: timeouts.config,
      }),
    syncDesktopCloud: (workspaceId: string, snapshot: DenResourceSnapshot) =>
      requestJson<OmniRushDesktopCloudSyncResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/desktop-cloud-sync`, {
        token,
        hostToken,
        method: "POST",
        body: { snapshot },
        timeoutMs: timeouts.config,
      }),
    listCloudPlugins: (workspaceId: string) =>
      requestJson<OmniRushCloudPluginsResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins`, {
        token,
        hostToken,
        timeoutMs: timeouts.config,
      }),
    installCloudPlugin: (workspaceId: string, payload: { marketplaceId: string | null; marketplace?: DenOrgMarketplace | null; resolved: DenOrgPluginResolved }) =>
      requestJson<OmniRushCloudPluginInstallResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.config,
      }),
    removeCloudPlugin: (workspaceId: string, pluginId: string) =>
      requestJson<OmniRushCloudPluginInstallResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins/${encodeURIComponent(pluginId)}`, {
        token,
        hostToken,
        method: "DELETE",
        timeoutMs: timeouts.config,
      }),
    previewClaudePlugin: (workspaceId: string, payload: { url: string; ref?: string }) =>
      requestJson<{ preview: OmniRushClaudePluginPreview }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/claude-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: { ...payload, dryRun: true },
        timeoutMs: timeouts.config,
      }),
    installClaudePlugin: (workspaceId: string, payload: { url: string; ref?: string }) =>
      requestJson<OmniRushCloudPluginInstallResult & { preview: OmniRushClaudePluginPreview }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/claude-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.config,
      }),
    listWorkspaceSessionsByFolder: (workspaceId: string, limit: number, engine?: "v2") =>
      requestJson<unknown[]>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/sessions/by-folder?limit=${limit}${engine ? `&engine=${engine}` : ""}`, {
        token,
        hostToken,
        timeoutMs: 45_000,
      }),
    readOpencodeConfigFile: (workspaceId: string, scope: "project" | "global" = "project") => {
      const query = `?scope=${scope}`;
      return requestJson<OpencodeConfigFile>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/opencode-config${query}`, {
        token,
        hostToken,
      });
    },
    writeOpencodeConfigFile: (workspaceId: string, scope: "project" | "global", content: string) =>
      requestJson<ExecResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/opencode-config`, {
        token,
        hostToken,
        method: "POST",
        body: { scope, content },
      }),
    listReloadEvents: (workspaceId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${options.since}` : "";
      return requestJson<{ items: OmniRushReloadEvent[]; cursor?: number }>(
        baseUrl,
        `/workspace/${workspaceId}/events${query}`,
        { token, hostToken },
      );
    },
    listUiControlPending: (options?: { wait?: boolean; signal?: AbortSignal }) =>
      requestJson<{ items: OmniRushUiControlRequest[] }>(
        baseUrl,
        `/experimental/ui-control/pending${options?.wait ? "?wait=1" : ""}`,
        { token, hostToken, timeoutMs: 15_000, signal: options?.signal },
      ),
    replyUiControl: (id: string, result: unknown) =>
      requestJson<{ ok: boolean }>(baseUrl, `/experimental/ui-control/${encodeURIComponent(id)}/reply`, {
        token,
        hostToken,
        method: "POST",
        body: { result },
      }),
    reloadEngine: (workspaceId: string) =>
      requestJson<{ ok: boolean; reloadedAt?: number }>(baseUrl, `/workspace/${workspaceId}/engine/reload`, {
        token,
        hostToken,
        method: "POST",
        timeoutMs: ENGINE_RELOAD_TIMEOUT_MS,
      }),
    listPlugins: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: OmniRushPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins${query}`,
        { token, hostToken },
      );
    },
    addPlugin: (workspaceId: string, spec: string) =>
      requestJson<{ items: OmniRushPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins`,
        { token, hostToken, method: "POST", body: { spec } },
      ),
    removePlugin: (workspaceId: string, name: string) =>
      requestJson<{ items: OmniRushPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),
    listSkills: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: OmniRushSkillItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/skills${query}`,
        { token, hostToken },
      );
    },
    getSkill: (workspaceId: string, name: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<OmniRushSkillContent>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}${query}`,
        { token, hostToken },
      );
    },
    upsertSkill: (workspaceId: string, payload: { name: string; content: string; description?: string }) =>
      requestJson<OmniRushSkillItem>(baseUrl, `/workspace/${workspaceId}/skills`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    /** Validates a skill folder/zip upload without writing it (and reports a name collision). */
    previewSkillBundle: (workspaceId: string, payload: { files: SkillUploadFile[]; name?: string }) =>
      requestJson<SkillBundlePreview>(baseUrl, `/workspace/${workspaceId}/skills/bundle/preview`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: 120_000,
      }),
    installSkillBundle: (
      workspaceId: string,
      payload: { files: SkillUploadFile[]; name?: string; onConflict?: "fail" | "replace" },
    ) =>
      requestJson<SkillBundleInstallResult>(baseUrl, `/workspace/${workspaceId}/skills/bundle`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: 120_000,
      }),
    listSkillFiles: (workspaceId: string, name: string) =>
      requestJson<SkillFileTree>(baseUrl, `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}/files`, {
        token,
        hostToken,
      }),
    updateSkillFiles: (workspaceId: string, name: string, payload: { add?: SkillUploadFile[]; remove?: string[] }) =>
      requestJson<SkillFileTree & { added: string[]; removed: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}/files`,
        { token, hostToken, method: "POST", body: payload, timeoutMs: 120_000 },
      ),
    deleteSkill: (workspaceId: string, name: string) =>
      requestJson<{ path: string }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "DELETE",
        },
      ),
    listMcp: (workspaceId: string) =>
      requestJson<{
        items: OmniRushMcpItem[];
        engineSync?: OmniRushMcpEngineSync | null;
        managedOAuthState?: OmniRushManagedOAuthState | null;
        mcpPolicy?: OmniRushMcpPolicyView | null;
      }>(
        baseUrl,
        `/workspace/${workspaceId}/mcp`,
        { token, hostToken },
      ),
    // The 2.x engine runs every chat: its MCP status, as the 1.x status map.
    getMcpStatus: async (workspaceId: string) =>
      v2McpStatusMap(await requestJson<unknown>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/opencode2/api/mcp`, { token, hostToken })) as McpStatusMap,
    listMcpApps: (workspaceId: string) =>
      requestJson<{ servers: OmniRushMcpAppCatalogServer[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp-apps/list`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),
    resolveMcpApp: (
      workspaceId: string,
      projectedToolName: string,
      launch?: OmniRushMcpAppLaunchReference,
    ) =>
      requestJson<{ app: OmniRushMcpAppResource | null }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp-apps/resolve`,
        {
          token,
          hostToken,
          method: "POST",
          body: { projectedToolName, ...(launch ? { launch } : {}) },
          timeoutMs: timeouts.config,
        },
      ),
    mcpAppSandbox: (app: OmniRushMcpAppResource, hostOrigin: string): OmniRushMcpAppSandbox => {
      const messageOrigin = normalizeMcpAppHostOrigin(hostOrigin);
      const url = new URL(`${baseUrl}/mcp-apps/sandbox.html`);
      if (url.origin === hostOrigin && url.hostname === "localhost") url.hostname = "127.0.0.1";
      else if (url.origin === hostOrigin && url.hostname === "127.0.0.1") url.hostname = "localhost";
      url.searchParams.set("csp", JSON.stringify(app.csp));
      url.searchParams.set("hostOrigin", messageOrigin);
      return { url: url.toString(), expectedOrigin: url.origin };
    },
    callMcpAppTool: (
      workspaceId: string,
      payload: {
        serverName: string;
        name: string;
        resourceUri: string;
        arguments?: Record<string, unknown>;
        approved?: boolean;
      },
    ) => requestJson<OmniRushMcpAppToolResult>(
      baseUrl,
      `/workspace/${encodeURIComponent(workspaceId)}/mcp-apps/call`,
      {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.binary,
      },
    ),
    getOmniRushCloudMcpHealth: (
      workspaceId: string,
      providerModel?: OmniRushCloudMcpProviderModelContext,
      options?: { probe?: boolean },
    ) => {
      const query = new URLSearchParams();
      if (providerModel?.provider.trim() && providerModel.model.trim()) {
        query.set("provider", providerModel.provider.trim());
        query.set("model", providerModel.model.trim());
      }
      // probe=1 verifies the Cloud endpoint directly from the omnirush.ai server
      // (initialize + tools/list), independent of the engine's own connection.
      if (options?.probe) query.set("probe", "1");
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<OmniRushCloudMcpHealth>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp/omnirush-cloud/health${suffix}`,
        { token, hostToken, timeoutMs: options?.probe ? timeouts.cloudMcpProbeHealth : timeouts.cloudMcpHealth },
      );
    },
    reconcileOmniRushCloudMcp: (workspaceId: string, payload: OmniRushCloudMcpReconcilePayload) =>
      requestJson<OmniRushCloudMcpHealth>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp/omnirush-cloud/reconcile`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
          timeoutMs: timeouts.cloudMcpReconcile,
        },
      ),
    refreshOmniRushCloudMcpEngine: (
      workspaceId: string,
      payload?: { provider?: string; model?: string; trigger?: string },
    ) =>
      requestJson<OmniRushCloudMcpEngineRefreshResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp/omnirush-cloud/engine-refresh`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload ?? {},
          timeoutMs: timeouts.cloudMcpReconcile,
        },
      ),
    runAgentContextDiagnostics: async (
      workspaceId: string,
      input: AgentContextDiagnosticsRequest,
    ): Promise<AgentContextDiagnosticsReport> => {
      const body = agentContextDiagnosticsRequestSchema.parse(input);
      const payload = await requestAgentContextDiagnosticsJson(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/diagnostics/agent-context`,
        {
          token,
          hostToken,
          body,
          timeoutMs: timeouts.diagnostics,
        },
      );
      return agentContextDiagnosticsReportSchema.parse(payload);
    },
    addMcp: (workspaceId: string, payload: { name: string; config: Record<string, unknown> }) =>
      requestJson<{ items: OmniRushMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    addManagedMcp: (
      workspaceId: string,
      payload: {
        name: string;
        url: string;
        oauth?: {
          applicationType?: "native" | "web";
          requestedScopes?: string[];
          authorizationServerIssuer?: string;
          clientId?: string;
          clientSecret?: string;
        };
      },
    ) =>
      requestJson<OmniRushManagedMcpStartResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/mcp/managed`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    getManagedMcp: (workspaceId: string, name: string) =>
      requestJson<OmniRushManagedMcpConnection>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}/managed`,
        { token, hostToken },
      ),
    connectManagedMcp: (workspaceId: string, name: string) =>
      requestJson<OmniRushManagedMcpStartResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}/managed/connect`,
        { token, hostToken, method: "POST" },
      ),
    removeMcp: (workspaceId: string, name: string) =>
      requestJson<{ items: OmniRushMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),
    setMcpEnabled: (workspaceId: string, name: string, enabled: boolean) =>
      requestJson<{ items: OmniRushMcpItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}/enabled`,
        {
          token,
          hostToken,
          method: "POST",
          body: { enabled },
        },
      ),

    logoutMcpAuth: (workspaceId: string, name: string) =>
      requestJson<{ ok: true }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}/auth`, {
        token,
        hostToken,
        method: "DELETE",
      }),

    listCommands: (workspaceId: string, scope: "workspace" | "global" = "workspace") =>
      requestJson<{ items: OmniRushCommandItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/commands?scope=${scope}`,
        { token, hostToken },
      ),
    listAudit: (workspaceId: string, limit = 50) =>
      requestJson<{ items: OmniRushAuditEntry[] }>(
        baseUrl,
        `/workspace/${workspaceId}/audit?limit=${limit}`,
        { token, hostToken },
      ),
    getLocalWorkflows: (workspaceId: string) =>
      requestJson<LocalWorkflowsSnapshot>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/local-workflows`, {
        token, hostToken, timeoutMs: timeouts.config,
      }),
    saveLocalWorkflowRouting: (workspaceId: string, body: LocalRoutingSettings) =>
      requestJson<LocalRoutingSettings>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/local-workflows/routing`, {
        token, hostToken, method: "PUT", body, timeoutMs: timeouts.config,
      }),
    previewLocalWorkflowRoute: (workspaceId: string, body: { prompt: string; category?: LocalRouteCategory | "auto"; model?: LocalModelRef | null }) =>
      requestJson<LocalRouteDecision>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/local-workflows/route`, {
        token, hostToken, method: "POST", body, timeoutMs: timeouts.config,
      }),
    createLocalWorkflow: (workspaceId: string, body: LocalWorkflowInput) =>
      requestJson<LocalWorkflow>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/local-workflows`, {
        token, hostToken, method: "POST", body, timeoutMs: timeouts.config,
      }),
    updateLocalWorkflow: (workspaceId: string, workflowId: string, body: Partial<LocalWorkflowInput>) =>
      requestJson<LocalWorkflow>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/local-workflows/${encodeURIComponent(workflowId)}`, {
        token, hostToken, method: "PATCH", body, timeoutMs: timeouts.config,
      }),
    deleteLocalWorkflow: (workspaceId: string, workflowId: string) =>
      requestJson<{ ok: true }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/local-workflows/${encodeURIComponent(workflowId)}`, {
        token, hostToken, method: "DELETE", timeoutMs: timeouts.config,
      }),
    runLocalWorkflow: (workspaceId: string, workflowId: string) =>
      requestJson<LocalWorkflowRun>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/local-workflows/${encodeURIComponent(workflowId)}/run`, {
        token, hostToken, method: "POST", body: {}, timeoutMs: timeouts.config,
      }),
    cancelLocalWorkflowRun: (workspaceId: string, runId: string) =>
      requestJson<LocalWorkflowRun>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/local-workflows/runs/${encodeURIComponent(runId)}/cancel`, {
        token, hostToken, method: "POST", body: {}, timeoutMs: timeouts.config,
      }),
    upsertCommand: (
      workspaceId: string,
      payload: { name: string; description?: string; template: string; agent?: string; model?: string | null; subtask?: boolean },
    ) =>
      requestJson<{ items: OmniRushCommandItem[] }>(baseUrl, `/workspace/${workspaceId}/commands`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    deleteCommand: (workspaceId: string, name: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/workspace/${workspaceId}/commands/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),
    uploadInboxPrefersOriginalFile: (file: File) =>
      isDesktopRuntime() && !isLoopbackUrl(baseUrl) && electronLocalPathForFile(file) !== null,
    uploadInbox: async (workspaceId: string, file: File, options?: { path?: string }) => {
      const id = workspaceId.trim();
      if (!id) throw new Error("workspaceId is required");
      if (!file) throw new Error("file is required");
      const uploadPath = `/workspace/${encodeURIComponent(id)}/inbox`;
      let result: { ok: boolean; status: number; text: string };
      if (isDesktopRuntime() && !isLoopbackUrl(baseUrl) && electronLocalPathForFile(file) !== null) {
        const response = await desktopUploadMultipart(file, {
          url: `${baseUrl}${uploadPath}`,
          method: "POST",
          headers: buildAuthHeaders(token, hostToken),
          fields: options?.path?.trim() ? { path: options.path.trim() } : undefined,
          timeoutMs: timeouts.binary,
        });
        result = {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          text: response.body,
        };
      } else {
        const form = new FormData();
        form.append("file", file);
        if (options?.path?.trim()) form.append("path", options.path.trim());
        result = await requestMultipartRaw(baseUrl, uploadPath, {
          token,
          hostToken,
          method: "POST",
          body: form,
          timeoutMs: timeouts.binary,
        });
      }

      if (!result.ok) {
        let message = result.text.trim();
        try {
          const json = message ? JSON.parse(message) : null;
          if (json && typeof json.message === "string") {
            message = json.message;
          }
        } catch {
          // ignore
        }
        throw new OmniRushServerError(
          result.status,
          "request_failed",
          message || "Shared folder upload failed",
        );
      }

      const body = result.text.trim();
      if (body) {
        try {
          const parsed = JSON.parse(body) as Partial<OmniRushInboxUploadResult>;
          if (typeof parsed.path === "string" && parsed.path.trim()) {
            return {
              ok: parsed.ok ?? true,
              path: parsed.path.trim(),
              bytes: typeof parsed.bytes === "number" ? parsed.bytes : file.size,
            } satisfies OmniRushInboxUploadResult;
          }
        } catch {
          // ignore invalid JSON and fall back
        }
      }

      return {
        ok: true,
        path: options?.path?.trim() || file.name,
        bytes: file.size,
      } satisfies OmniRushInboxUploadResult;
    },

    listInbox: (workspaceId: string) =>
      requestJson<OmniRushInboxList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/inbox`, {
        token,
        hostToken,
      }),

    downloadInboxItem: (workspaceId: string, inboxId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/inbox/${encodeURIComponent(inboxId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    readWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<OmniRushWorkspaceFileContent>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),

    statWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<OmniRushWorkspaceFileStat>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/stat?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),

    listWorkspaceFiles: async (workspaceId: string) => {
      const created = await requestJson<{ session: { id: string } }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/sessions`,
        { token, hostToken, method: "POST", body: { write: false } },
      );
      const sessionId = created.session.id;
      try {
        return await requestJson<OmniRushWorkspaceCatalog>(
          baseUrl,
          `/files/sessions/${encodeURIComponent(sessionId)}/catalog/snapshot?includeDirs=true&limit=10000&excludeHeavyDirectories=true`,
          { token, hostToken },
        );
      } finally {
        await requestJson<{ ok: boolean }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}`, {
          token,
          hostToken,
          method: "DELETE",
        }).catch(() => undefined);
      }
    },

    writeWorkspaceFile: (
      workspaceId: string,
      payload: { path: string; content: string; baseUpdatedAt?: number | null; force?: boolean },
    ) =>
      requestJson<OmniRushWorkspaceFileWriteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
        },
      ),

    // The desktop editor (server routes/editor.ts).
    editorTree: (workspaceId: string) =>
      requestJson<OmniRushEditorTree>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/editor/tree`, { token, hostToken, timeoutMs: 60_000 }),

    editorReadFile: (workspaceId: string, path: string) =>
      requestJson<OmniRushEditorFile>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/editor/file?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),

    editorWriteFile: (
      workspaceId: string,
      payload: { path: string; content?: string; delete?: boolean; baseUpdatedAt?: number | null; force?: boolean; sessionId?: string | null; source?: "editor" | "review" },
    ) =>
      requestJson<{ ok: true; path: string; bytes: number; deleted: boolean; updatedAt: number | null }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/editor/file`,
        { token, hostToken, method: "PUT", body: payload },
      ),

    /** /btw: a side question about a chat, answered without touching it (apps/server/src/side-question.ts). */
    askSideQuestion: (workspaceId: string, payload: { sessionId: string; question: string }) =>
      requestJson<{ ok: boolean; answer?: string; sources?: string[]; busy?: boolean; error?: string | null }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/btw`,
        { token, hostToken, method: "POST", body: payload, timeoutMs: 200_000 },
      ),

    editorReview: (
      workspaceId: string,
      payload: { sessionId: string; path: string; decision: "accept" | "reject"; added: number; removed: number; scope: "hunk" | "file" },
    ) =>
      requestJson<{ ok: true }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/editor/review`, { token, hostToken, method: "POST", body: payload }),

    editorSearch: (
      workspaceId: string,
      payload: { query: string; regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; include?: string[]; exclude?: string[]; maxMatches?: number },
      signal?: AbortSignal,
    ) =>
      requestJson<OmniRushEditorSearchResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/editor/search`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: 30_000,
        signal,
      }),

    /** The editor's language features (the app server's language-server host, editor-lsp.ts). */
    editorLsp: <T = unknown>(
      workspaceId: string,
      op: "diagnostics" | "hover" | "definition" | "references" | "symbols" | "rename",
      payload: { path?: string; line?: number; character?: number; newName?: string; text?: string },
      signal?: AbortSignal,
    ) =>
      requestJson<T>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/editor/lsp/${op}`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: op === "diagnostics" ? 45_000 : 20_000,
        signal,
      }),

    /** The formatters the project sets up itself (Prettier, gofmt, Ruff, Black, rustfmt), for Settings → Editor. */
    editorFormatters: (workspaceId: string) =>
      requestJson<{ formatters: string[] }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/editor/formatters`, {
        token,
        hostToken,
        timeoutMs: 10_000,
      }),

    /**
     * The project's formatter on the editor's text (a user action). It runs only once trusted for the project:
     * without `trust` the answer may be a prompt (`trust: "ask"`, the exact command and a configuration hash).
     */
    editorFormat: (
      workspaceId: string,
      path: string,
      text: string,
      options: { trust?: "once" | "always" | "never"; hash?: string; timeoutMs?: number } = {},
    ) =>
      requestJson<
        | { formatter: null; text: null }
        | { formatter: string; trust: "ask"; command: string; hash: string; sandbox: boolean }
        | { formatter: string; trust: "denied" }
        | { formatter: string; text: string; sandbox: boolean }
      >(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/editor/format`, {
        token,
        hostToken,
        method: "POST",
        body: { path, text, ...(options.trust ? { trust: options.trust, hash: options.hash } : {}) },
        timeoutMs: options.timeoutMs ?? 3_000,
      }),

    /** An image file's bytes for the editor's image preview (image types only, capped by the server). */
    editorRaw: (workspaceId: string, path: string) =>
      requestBinary(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/editor/raw?path=${encodeURIComponent(path)}`, {
        token,
        hostToken,
        timeoutMs: 30_000,
      }),

    editorGitStatus: (workspaceId: string) =>
      requestJson<OmniRushEditorGitStatus>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/editor/git/status`, { token, hostToken, timeoutMs: 30_000 }),

    editorGitOriginal: (workspaceId: string, path: string, ref: "HEAD" | "index") =>
      requestJson<{ path: string; ref: string; content: string | null; exists: boolean; binary?: boolean; tooLarge?: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/editor/git/original?path=${encodeURIComponent(path)}&ref=${ref}`,
        { token, hostToken },
      ),

    editorGitStage: (workspaceId: string, paths: string[], stage: boolean) =>
      requestJson<OmniRushEditorGitStatus>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/editor/git/${stage ? "stage" : "unstage"}`,
        { token, hostToken, method: "POST", body: { paths }, timeoutMs: 60_000 },
      ),

    editorGitCommit: (workspaceId: string, message: string) =>
      requestJson<{ ok: true; commit: string; status: OmniRushEditorGitStatus }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/editor/git/commit`,
        { token, hostToken, method: "POST", body: { message }, timeoutMs: 130_000 },
      ),

    deleteWorkspaceFiles: async (
      workspaceId: string,
      files: Array<{ path: string; recursive?: boolean }>,
    ): Promise<OmniRushWorkspaceFileDeleteResult[]> => {
      if (files.length === 0) return [];
      const created = await requestJson<{ session: { id: string } }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/sessions`,
        { token, hostToken, method: "POST", body: { write: true } },
      );
      const sessionId = created.session.id;
      try {
        const result = await requestJson<{ items: Array<{ ok?: boolean; path?: string; code?: string }> }>(
          baseUrl,
          `/files/sessions/${encodeURIComponent(sessionId)}/ops`,
          {
            token,
            hostToken,
            method: "POST",
            body: {
              operations: files.map((file) => ({
                type: "delete",
                path: file.path,
                recursive: file.recursive === true,
              })),
            },
          },
        );
        return result.items.map((item, index) => ({
          ok: item.ok === true,
          path: typeof item.path === "string" ? item.path : files[index]?.path ?? "",
          ...(typeof item.code === "string" ? { code: item.code } : {}),
        }));
      } finally {
        await requestJson<{ ok: boolean }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}`, {
          token,
          hostToken,
          method: "DELETE",
        }).catch(() => undefined);
      }
    },

    writeWorkspaceBinaryFile: (
      workspaceId: string,
      payload: { path: string; data: ArrayBuffer; baseUpdatedAt?: number | null; force?: boolean },
    ) =>
      requestJson<OmniRushWorkspaceFileWriteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/raw`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            path: payload.path,
            dataBase64: arrayBufferToBase64(payload.data),
            baseUpdatedAt: payload.baseUpdatedAt,
            force: payload.force,
          },
        },
      ),

    downloadWorkspaceFile: (workspaceId: string, path: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/raw?path=${encodeURIComponent(path)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    listArtifacts: (workspaceId: string) =>
      requestJson<OmniRushArtifactList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/artifacts`, {
        token,
        hostToken,
      }),

    resolveArtifacts: (
      workspaceId: string,
      targets: Array<{
        kind: "file" | "url";
        value: string;
        name?: string;
        preview?: string;
        confidence?: number;
        reason?: string;
      }>,
    ) =>
      requestJson<{ items: OmniRushResolvedArtifactTarget[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/resolve`,
        { token, hostToken, method: "POST", body: { targets } },
      ),

    downloadArtifact: (workspaceId: string, artifactId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    // User-level env vars (host-auth only — desktop shell is the sole caller).
    // See apps/server/src/env-file.ts and apps/app/pr/environment-variables.md.
    listUserEnvKeys: () =>
      requestJson<{ keys: string[] }>(
        baseUrl,
        "/env/keys",
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    getUserEnvStatus: (runtimeKey?: string | null) => {
      const params = new URLSearchParams();
      if (runtimeKey?.trim()) params.set("runtimeKey", runtimeKey.trim());
      const query = params.size ? `?${params.toString()}` : "";
      return requestJson<{ runtimeKey: string; pendingChanges: boolean }>(
        baseUrl,
        `/env/status${query}`,
        { token, hostToken, timeoutMs: timeouts.config },
      );
    },

    setUserEnvPendingChanges: (pendingChanges: boolean, runtimeKey?: string | null) =>
      requestJson<{ runtimeKey: string; pendingChanges: boolean }>(baseUrl, "/env/status", {
        token,
        hostToken,
        method: "PUT",
        body: { pendingChanges, runtimeKey: runtimeKey?.trim() || undefined },
        timeoutMs: timeouts.config,
      }),

    listUserEnv: () =>
      requestJson<{ items: OmniRushUserEnvItem[] }>(
        baseUrl,
        "/env?includeValues=false",
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    getUserEnv: (key: string) =>
      requestJson<{ item: OmniRushUserEnvItem & { value: string } }>(
        baseUrl,
        `/env/${encodeURIComponent(key)}`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    upsertUserEnv: (entries: Array<{ key: string; value: string }>) =>
      requestJson<{ ok: true; count: number }>(baseUrl, "/env", {
        token,
        hostToken,
        method: "PUT",
        body: { entries },
        timeoutMs: timeouts.config,
      }),

    deleteUserEnv: (key: string) =>
      requestJson<{ ok: true }>(baseUrl, `/env/${encodeURIComponent(key)}`, {
        token,
        hostToken,
        method: "DELETE",
        timeoutMs: timeouts.config,
      }),

  };
}

export type OmniRushServerClient = ReturnType<typeof createOmniRushServerClient>;
