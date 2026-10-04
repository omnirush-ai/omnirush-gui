// Types for sandbox.js (the single source; see its header).
// SPDX-License-Identifier: MIT

export declare const SANDBOX_SCHEMA: 1;
export declare const DEFAULT_IMAGE: string;
export declare const SANDBOX_HOME: string;
export declare const ENGINE_DIR: string;
export declare const CACHE_VOLUME: string;
export declare const LABEL: string;

export declare class SandboxError extends Error {
  readonly code: "unavailable" | "image" | "engine" | "mount" | "docker" | string;
  constructor(message: string, code?: string);
}

export type SandboxMode = "off" | "docker";
export type SandboxNetwork = "host" | "bridge";

export interface SandboxEngine {
  /** Engine name; also the binary's name inside the sandbox. */
  name: string;
  version: string;
  /** The app's own binary: mounted as is on a Linux host of the same architecture. */
  hostPath?: string;
  /** Where a Linux build comes from elsewhere: an npm package per Docker platform. */
  npm?: {
    registry?: string;
    /** "linux/amd64" | "linux/arm64" -> package name, e.g. "@opencode/cli-linux-arm64". */
    packages: Record<string, string>;
    /** The binary inside the package, relative to package/ (default bin/<name>). */
    bin?: string;
  };
}

export interface SandboxImageRecord {
  ref: string;
  id: string;
  digest: string | null;
  pinned: string | null;
  platform: string;
}

/** What a sandboxed session records (`environment.sandbox`). */
export interface SandboxManifest {
  schema: 1;
  mode: "docker";
  image: SandboxImageRecord;
  engine: { name: string; version: string; source: "host" | "npm"; package: string | null } | null;
  network: SandboxNetwork;
  user: string | null;
  home: string;
  workdir: string;
  workspaces: string[];
  docker: { version: string; os: string };
  app: string | null;
}

export interface SandboxChange {
  kind: "A" | "C" | "D";
  path: string;
}

export interface SandboxSnapshot {
  schema: 1;
  label: string;
  image: SandboxImageRecord;
  changed: number;
  added: number;
  modified: number;
  deleted: string[];
  /** File name of the tar beside the summary, or null when nothing was added or changed. */
  tar: string | null;
  bytes: number;
  sha256: string | null;
}

export interface SandboxFrozen {
  label: string;
  /** Paths changed outside the mounted folders (0: nothing to save but the summary). */
  changed: number;
  save(outDir: string): Promise<SandboxSnapshot>;
  discard(): Promise<null>;
}

export interface SandboxLaunchInput {
  /** The engine command the app would have run (ignored when `engine` is set; the sandbox's build runs instead). */
  command: string;
  args: string[];
  cwd: string;
  /** The environment the app would have given the engine (process env plus its own). */
  env: Record<string, string | undefined>;
  /** Names the app set for the engine; passed in by name, never on a command line. */
  passEnv?: string[];
  /** Folders mounted read-write at the same paths (default [cwd]). */
  workspaces?: string[];
  /** More host paths at the same paths (read-only unless readonly: false). */
  mounts?: { path: string; readonly?: boolean }[];
  /** Host folder for the engine's own data (sessions); mounted read-write. */
  stateDir: string;
  engine: SandboxEngine | null;
  image?: string;
  /** "cli" | "desktop": labels the container and the manifest. */
  app: string;
  interactive?: boolean;
  sandbox?: SandboxOptions;
}

export interface SandboxLaunch {
  /** Spawn these instead of the engine. */
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  container: string;
  network: SandboxNetwork;
  port: number | null;
  manifest: SandboxManifest;
  /** The engine's readiness URL as the host reaches it. */
  mapUrl(url: string): string;
  changes(): Promise<SandboxChange[]>;
  /**
   * Freeze the environment now (when a turn's prompt is sent). save() writes
   * <outDir>/<label>.tar and .json from the frozen copy while the session goes
   * on; call save() or discard() once.
   */
  freeze(label: string, options?: { timeoutMs?: number }): Promise<SandboxFrozen>;
  /** freeze(label) then save(outDir). */
  snapshot(options: { label: string; outDir: string }): Promise<SandboxSnapshot>;
  /** Remove the container (idempotent; call after the engine is closed). */
  dispose(): Promise<void>;
  /** Workspaces left unmounted because they are a home folder or a filesystem root. */
  skippedWorkspaces: string[];
}

export interface SandboxOptions {
  docker?: string;
  env?: Record<string, string | undefined>;
  run?: (command: string, args: string[], options?: { env?: Record<string, string | undefined>; input?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
  spawnImpl?: unknown;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  uid?: number | null;
  gid?: number | null;
  homedir?: string;
  hostname?: string;
  pid?: number;
  freePort?: () => Promise<number>;
}

export interface DockerInfo {
  ok: boolean;
  error?: string;
  version?: string;
  os?: string;
  arch?: string;
  operatingSystem?: string;
  desktop?: boolean;
  remote?: boolean;
}

export interface Sandbox {
  inspect(): Promise<DockerInfo>;
  networkMode(): SandboxNetwork;
  /** How relayed host services are reached: a unix socket per port (Linux daemon) or the VM's host gateway. */
  relayMode(info: DockerInfo): "socket" | "gateway";
  resolveImage(ref: string): Promise<SandboxImageRecord & { schema: string | null }>;
  ensureEngine(engine: SandboxEngine, image: SandboxImageRecord): Promise<{ path: string; mount: unknown; record: SandboxManifest["engine"] }>;
  reapOrphans(): Promise<string[]>;
  prepareEngine(input: SandboxLaunchInput): Promise<SandboxLaunch>;
}

export declare function sandboxMode(env?: Record<string, string | undefined>): SandboxMode;
export declare function dockerPlatform(arch?: string): string | null;
export declare function loopbackPorts(texts: Iterable<string>): number[];
export declare function mapEngineUrl(url: string): string;
export declare function parseDockerDiff(stdout: string): SandboxChange[];
export declare function filterChanges(entries: SandboxChange[], options?: { mounts?: string[] }): SandboxChange[];
export declare function gitIdentity(home?: string, env?: Record<string, string | undefined>): { name?: string; email?: string };
export declare function createSandbox(options?: SandboxOptions): Sandbox;
export declare function prepareSandboxedEngine(input: SandboxLaunchInput): Promise<SandboxLaunch>;
