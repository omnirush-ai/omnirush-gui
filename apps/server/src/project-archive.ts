/**
 * The embedded server's project archiver (session-archive/README.md,
 * "Wiring"): one per server, authenticated like the workspace collector
 * (through the gateway broker's device session, or the collector's
 * environment token when there is no broker), with its files in
 * `<collector state dir>/omnirush-archive/`.
 */
import { dirname } from "node:path";
import { omnirushConfigDir, omnirushServerDataDir, opencodeCacheDirs, opencodeDataDirs } from "@omnirush/paths";

import type { OmniRushGatewayBroker } from "./omnirush-gateway-broker.js";
import { runtimeStorageDir } from "./runtime-db.js";
import { SessionArchiver, type SessionArchiverOptions } from "./session-archive/index.js";
import { ProjectArchiveLifecycle, projectArchiveEnabled, type ArchiveLifecycleLog } from "./session-archive/lifecycle.js";
import type { ServerConfig } from "./types.js";

/**
 * A base archive is packed once no prompt has been dispatched on any session
 * for this long, and at the latest PROJECT_ARCHIVE_BASE_MAX_DEFER_MS after
 * its own prompt: chats opened and prompted one after another are packed once
 * the burst is over, and a lone chat's base still shows the folder as its
 * first turn began (session-archive/lifecycle.ts).
 */
export const PROJECT_ARCHIVE_BASE_IDLE_MS = 2_000;
export const PROJECT_ARCHIVE_BASE_MAX_DEFER_MS = 10_000;

/** App data, config and cache directories: pruned when they sit under a project root, and never archived as a root. */
function appDirectories(config: ServerConfig): string[] {
  return [
    ...(config.configPath ? [dirname(config.configPath)] : []),
    omnirushConfigDir(),
    omnirushServerDataDir(),
    ...opencodeDataDirs(),
    ...opencodeCacheDirs(),
  ];
}

type ProjectArchiveInput = {
  config: ServerConfig;
  gatewayBroker: Pick<OmniRushGatewayBroker, "enabled" | "archiveRequest" | "refreshAccessToken">;
  /** The workspace collector has an account to upload to. */
  collectorEnabled: boolean;
  env?: NodeJS.ProcessEnv;
};

/**
 * Where and how a server's archiver works: its state dir, the directories it
 * prunes, whether it is on, and how it authenticates. Disabled (signed out,
 * or turned off on this device) it gets no bearer, so clearing what a
 * previous run left never reaches the network.
 */
export function projectArchiveSettings(input: ProjectArchiveInput): {
  stateDir: string;
  excludedDirs: string[];
  enabled: boolean;
  auth: "broker" | "environment" | "none";
  gatewayUrl?: string;
  accessToken?: string;
} {
  const env = input.env ?? process.env;
  const enabled = projectArchiveEnabled(env) && input.collectorEnabled;
  const base = { stateDir: runtimeStorageDir(input.config), excludedDirs: appDirectories(input.config), enabled };
  if (!enabled) return { ...base, auth: "none" };
  if (input.gatewayBroker.enabled) return { ...base, auth: "broker" };
  return {
    ...base,
    auth: "environment",
    ...(env.OMNIRUSH_GATEWAY_URL !== undefined ? { gatewayUrl: env.OMNIRUSH_GATEWAY_URL } : {}),
    ...(env.OMNIRUSH_ACCESS_TOKEN !== undefined ? { accessToken: env.OMNIRUSH_ACCESS_TOKEN } : {}),
  };
}

/** The archive lifecycle in this thread (the server itself runs it on its capture worker, see capture-host.ts). */
export function createProjectArchive(input: ProjectArchiveInput & {
  log: ArchiveLifecycleLog;
  /** Tests: S3 part uploads (and API calls in the environment-token mode). */
  fetch?: SessionArchiverOptions["fetch"];
}): ProjectArchiveLifecycle {
  const settings = projectArchiveSettings(input);
  const auth: Partial<SessionArchiverOptions> = settings.auth === "broker"
    ? {
        request: (path, init) => input.gatewayBroker.archiveRequest(path, init),
        refreshAccessToken: () => input.gatewayBroker.refreshAccessToken(),
      }
    : settings.auth === "environment"
      ? { gatewayUrl: settings.gatewayUrl, accessToken: settings.accessToken }
      : {};
  return new ProjectArchiveLifecycle({
    archiver: new SessionArchiver({
      stateDir: settings.stateDir,
      excludedDirs: settings.excludedDirs,
      log: input.log,
      ...auth,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    }),
    enabled: settings.enabled,
    log: input.log,
  });
}
