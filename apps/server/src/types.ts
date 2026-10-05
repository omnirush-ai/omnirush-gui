import type { WorkspaceWire } from "@omnirush/types/workspace";

export type WorkspaceType = "local" | "remote";

export type RemoteType = "opencode" | "omnirush";

export type ApprovalMode = "manual" | "auto";

export type TokenScope = "owner" | "collaborator" | "viewer";

export type SandboxBackend = "none" | "docker" | "container";

export type ProviderPlacement = "in-sandbox" | "host-machine" | "client-machine" | "external";

export type LogFormat = "pretty" | "json";

export type McpPolicyMode = "disabled";

export interface WorkspaceConfig {
  id?: string;
  path: string;
  name?: string;
  preset?: string;
  workspaceType?: WorkspaceType;
  remoteType?: RemoteType;
  baseUrl?: string;
  directory?: string;
  displayName?: string;
  omnirushHostUrl?: string;
  omnirushToken?: string;
  omnirushWorkspaceId?: string;
  omnirushWorkspaceName?: string;
  sandboxBackend?: string;
  sandboxRunId?: string;
  sandboxContainerName?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  preset: string;
  workspaceType: WorkspaceType;
  remoteType?: RemoteType;
  baseUrl?: string;
  directory?: string;
  displayName?: string;
  omnirushHostUrl?: string;
  omnirushToken?: string;
  omnirushWorkspaceId?: string;
  omnirushWorkspaceName?: string;
  sandboxBackend?: string;
  sandboxRunId?: string;
  sandboxContainerName?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  opencode?: {
    baseUrl?: string;
    directory?: string;
    username?: string;
    password?: string;
  };
}

// Compile-time contract tripwires against the shared wire shape consumed by
// apps/app (packages/types/src/workspace.ts). The first check rejects fields
// whose values no longer fit the wire contract; the second rejects fields the
// contract does not know about. Both are erased at build time.
type Extends<A extends B, B> = A;
type _WorkspaceInfoFitsWire = Extends<WorkspaceInfo, WorkspaceWire>;
type _WorkspaceInfoKeysKnown = Extends<keyof WorkspaceInfo, keyof WorkspaceWire>;

export interface OpencodeConfigFile {
  path: string;
  exists: boolean;
  content: string | null;
}

export interface ApprovalConfig {
  mode: ApprovalMode;
  timeoutMs: number;
}

export type LocalManagedMcpVaultKeyProvider = () => Promise<Uint8Array>;

export type CaptureFileUpload = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  path: string;
  size: number;
  signal?: AbortSignal;
}) => Promise<Response>;

export type OmniRushGatewayCredentialBundle = {
  gatewayUrl: string;
  accessToken: string;
  refreshToken: string;
  /**
   * How many times the desktop account store has rotated this device session;
   * it never saves a bundle with a lower count over a higher one. Missing
   * means 0 (bundles persisted before the counter existed, or read from the
   * environment).
   */
  rotation?: number;
};

export type OmniRushGatewayCredentials = OmniRushGatewayCredentialBundle & {
  invalidate?: () => Promise<void>;
  /**
   * The one owner of the device session's refresh token (the desktop account
   * store). With it the broker never sends a refresh token: after a 401 it
   * passes the refused access token here and uses the pair it gets back,
   * either one the owner already rotated to or a new rotation (the owner runs
   * one at a time and saves it before answering). Null means the session is
   * gone; a rejection means no rotation was possible right now. The server
   * treats a superseded refresh token as a sign-in copied to another device,
   * so two holders must never both spend one.
   */
  refresh?: (rejectedAccessToken: string) => Promise<OmniRushGatewayCredentialBundle | null>;
  /** The credentials as currently stored; null after a sign-out. */
  latest?: () => Promise<OmniRushGatewayCredentialBundle | null>;
  /** Connected account's profile (name and email for the git commit identity default); null when signed out or offline. */
  profile?: () => Promise<{ email: string | null; displayName: string | null } | null>;
  /**
   * Hears the gateway's mandatory-update signals: the
   * `x-omnirush-update-required` header and 426 `update_required` refusals
   * of model requests (the desktop shows its update banner or blocked view).
   */
  onUpdateSignal?: (signal: { kind: "header"; value: string } | { kind: "rejection"; message: string | null }) => void;
};

export interface ServerConfig {
  host: string;
  port: number;
  token: string;
  hostToken: string;
  configPath?: string;
  opencodeBaseUrl?: string;
  opencodeDirectory?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  approval: ApprovalConfig;
  corsOrigins: string[];
  workspaces: WorkspaceInfo[];
  authorizedRoots: string[];
  readOnly: boolean;
  startedAt: number;
  tokenSource: "cli" | "env" | "file" | "generated";
  hostTokenSource: "cli" | "env" | "file" | "generated";
  logFormat: LogFormat;
  logRequests: boolean;
  /** Server-owned MCP execution policy. */
  mcpPolicy?: McpPolicyMode;
  /** In-memory secure key custody supplied by an embedding host such as OmniRush.ai Desktop. */
  localManagedMcpVaultKey?: LocalManagedMcpVaultKeyProvider;
  /** Desktop-owned account credentials. They remain in the embedding process and are never serialized. */
  omnirushGatewayCredentials?: OmniRushGatewayCredentials;
  /** Ephemeral bearer accepted only by the loopback gateway broker. */
  omnirushEngineToken?: string;
  /** Desktop-owned managed engines only; never enabled by remote clients. */
  resumeInterruptedTasks?: boolean;
  /** Version of the embedding desktop app (Electron app.getVersion()), reported in session uploader envelopes. */
  appVersion?: string;
  /** Embedding-owned transport for immutable session upload files. */
  captureFileUpload?: CaptureFileUpload;
}

export interface Capabilities {
  schemaVersion: number;
  serverVersion: string;
  opencodeVersion: string;
  providerSync: true;
  skills: { read: boolean; write: boolean; source: "omnirush" | "opencode" };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };
  engine: { rollover: boolean };

  approvals: { mode: ApprovalMode; timeoutMs: number };
  sandbox: { enabled: boolean; backend: SandboxBackend };
  tokens: { scoped: boolean; scopes: TokenScope[] };
  proxy: {
    opencode: boolean;
  };
  toolProviders: {
    browser: {
      enabled: boolean;
      placement: ProviderPlacement;
      mode: "none" | "headless" | "interactive";
    };
    files: {
      injection: boolean;
      outbox: boolean;
      inboxPath: string;
      outboxPath: string;
      maxBytes: number;
    };
  };
}

export type ReloadReason = "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";

export type ReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp" | "agent" | "command";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};

export interface ReloadEvent {
  id: string;
  seq: number;
  workspaceId: string;
  reason: ReloadReason;
  trigger?: ReloadTrigger;
  timestamp: number;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface PluginItem {
  spec: string;
  source: "config" | "dir.project" | "dir.global";
  scope: "project" | "global";
  path?: string;
}

export interface McpItem {
  name: string;
  config: Record<string, unknown>;
  source: "config.project" | "config.global" | "config.remote";
  disabledByTools?: boolean;
  toolDenies?: Array<{
    source: "config.project" | "config.global";
    style: "tools.deny" | "tools" | "permission" | "permissions";
    pattern: string;
    matched: string;
  }>;
}

export interface SkillItem {
  name: string;
  path: string;
  description: string;
  scope: "project" | "global";
  trigger?: string;
  error?: string;
}

export interface CommandItem {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string | null;
  subtask?: boolean;
  scope: "workspace" | "global";
}

export interface Actor {
  type: "remote" | "host";
  clientId?: string;
  tokenHash?: string;
  scope?: TokenScope;
}

export interface ApprovalRequest {
  id: string;
  workspaceId: string;
  action: string;
  summary: string;
  paths: string[];
  createdAt: number;
  actor: Actor;
}

export type UiControlKind = "context" | "query" | "command";

export interface UiControlRequest {
  id: string;
  kind: UiControlKind;
  input?: unknown;
  createdAt: number;
}

export interface AuditEntry {
  id: string;
  workspaceId: string;
  actor: Actor;
  action: string;
  target: string;
  summary: string;
  timestamp: number;
  details?: Record<string, unknown>;
}
