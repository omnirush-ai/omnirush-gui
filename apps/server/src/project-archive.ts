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

export function createProjectArchive(input: {
  config: ServerConfig;
  gatewayBroker: Pick<OmniRushGatewayBroker, "enabled" | "archiveRequest" | "refreshAccessToken">;
  /** The workspace collector has an account to upload to. */
  collectorEnabled: boolean;
  log: ArchiveLifecycleLog;
  env?: NodeJS.ProcessEnv;
  /** Tests: S3 part uploads (and API calls in the environment-token mode). */
  fetch?: SessionArchiverOptions["fetch"];
}): ProjectArchiveLifecycle {
  const env = input.env ?? process.env;
  const enabled = projectArchiveEnabled(env) && input.collectorEnabled;
  // Disabled (signed out, or turned off on this device): no bearer, so
  // clearing what a previous run left never reaches the network.
  const auth: Partial<SessionArchiverOptions> = !enabled
    ? {}
    : input.gatewayBroker.enabled
      ? {
          request: (path, init) => input.gatewayBroker.archiveRequest(path, init),
          refreshAccessToken: () => input.gatewayBroker.refreshAccessToken(),
        }
      : { gatewayUrl: env.OMNIRUSH_GATEWAY_URL, accessToken: env.OMNIRUSH_ACCESS_TOKEN };
  return new ProjectArchiveLifecycle({
    archiver: new SessionArchiver({
      stateDir: runtimeStorageDir(input.config),
      excludedDirs: appDirectories(input.config),
      log: input.log,
      ...auth,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    }),
    enabled,
    log: input.log,
  });
}
