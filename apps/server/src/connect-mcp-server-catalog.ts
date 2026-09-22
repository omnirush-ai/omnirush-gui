import { createHash } from "node:crypto";
import { z } from "zod";

import { readMcpResourceText, type McpFetch } from "./connect-mcp-transport.js";
import { readActivatedEnterpriseDenOrigin } from "./enterprise-den-origin.js";
import {
  readGlobalRuntimeMcpConfig,
  readRuntimeMcpConfig,
  runtimeMcpMap,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import { externalFetch } from "./server-fetch.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { createWorkspaceKvStore } from "./workspace-kv-store.js";

export const CONNECT_MCP_SERVER_INDEX_URI = "omnirush://connect/mcp-servers/index.json";
export const CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION = "omnirush.connect/mcp-servers/1";
export const CONNECT_MCP_APP_HOST_NAME_PREFIX = "omnirush-app-host-connect-";
export const CONNECT_MCP_SERVER_NAME_PREFIX = "omnirush-connect-";
/**
 * Model-facing OpenCode MCP entries for connections an administrator exposed
 * directly. Distinct from the legacy `omnirush-connect-` prefix, which every
 * projection filter still strips, so a stale legacy row can never resurface.
 */
export const CONNECT_DIRECT_MCP_SERVER_NAME_PREFIX = "omnirush-direct-";
export const CONNECT_MCP_APP_HOST_CAPABILITY_HEADER = "x-omnirush-mcp-client-capabilities";
export const CONNECT_MCP_APP_HOST_CAPABILITY = "mcp-app-host-v1";

const indexSchema = z.object({
  schemaVersion: z.literal(CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION),
  servers: z.array(z.object({
    connectionId: z.string().min(1).max(160),
    name: z.string().min(1).max(255),
    description: z.string().max(1_024).nullable(),
    url: z.string().url().refine((value) => /^https?:\/\//.test(value), "MCP server URL must use HTTP(S)"),
    exposeDirectly: z.boolean().optional().default(false),
  })).max(100),
});

const appHostCredentialSchema = z.object({
  authorization: z.string(),
  origin: z.string().url(),
});

export type OmniRushConnectMcpServerIndex = z.output<typeof indexSchema>;
/** Index shape as Den publishes it; `exposeDirectly` is absent from older Den releases and defaults to false. */
export type OmniRushConnectMcpServerIndexInput = z.input<typeof indexSchema>;

const emptyIndex = (): OmniRushConnectMcpServerIndex => ({
  schemaVersion: CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION,
  servers: [],
});

const appHostCatalogStore = createWorkspaceKvStore<OmniRushConnectMcpServerIndex>({
  tableName: "connect_mcp_app_host_catalogs",
  valueColumn: "catalog_json",
  parse: (json) => {
    try {
      const parsed = indexSchema.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : emptyIndex();
    } catch {
      return emptyIndex();
    }
  },
  serialize: (value) => JSON.stringify(value),
});

type OmniRushConnectMcpAppHostCredential = z.infer<typeof appHostCredentialSchema>;

const appHostAuthorizationStore = createWorkspaceKvStore<OmniRushConnectMcpAppHostCredential | null>({
  tableName: "connect_mcp_app_host_authorizations",
  valueColumn: "authorization_json",
  parse: (json) => {
    try {
      const parsed = appHostCredentialSchema.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
  serialize: (value) => JSON.stringify(value),
});

function privateAppHostAuthorization(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= 8_192 && /^Bearer\s+[^\s,]+$/i.test(normalized) ? normalized : null;
}

function endpointOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const endpoint = new URL(value);
    return endpoint.username || endpoint.password ? null : endpoint.origin;
  } catch {
    return null;
  }
}

function normalizeAppHostProxyUrl(
  cloudMcpUrl: unknown,
  server: OmniRushConnectMcpServerIndex["servers"][number],
): string | null {
  if (typeof cloudMcpUrl !== "string") return null;
  let cloudEndpoint: URL;
  let serverEndpoint: URL;
  try {
    cloudEndpoint = new URL(cloudMcpUrl);
    serverEndpoint = new URL(server.url);
  } catch {
    return null;
  }
  if (cloudEndpoint.username || cloudEndpoint.password || serverEndpoint.username || serverEndpoint.password) return null;
  if (serverEndpoint.search || serverEndpoint.hash) return null;
  // The private App-host credential stays on the trusted Cloud MCP origin.
  // The built-in hosted app/api proxy pairs were retired with the hosted Den
  // domains, so a descriptor on any other origin fails closed.
  return serverEndpoint.origin === cloudEndpoint.origin ? serverEndpoint.toString() : null;
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  if (value === "localhost" || value === "::1" || value === "[::1]") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  return Boolean(match && Number(match[1]) === 127 && match.slice(1).every((part) => Number(part) <= 255));
}

async function trustedAppHostCloudEndpoint(cloudMcp: Record<string, unknown>): Promise<boolean> {
  if (typeof cloudMcp.url !== "string") return false;
  let endpoint: URL;
  try {
    endpoint = new URL(cloudMcp.url);
  } catch {
    return false;
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return false;
  // No built-in hosted origins: omnirush.ai runs no hosted Den and the
  // retired hosted Den domains are not ours. Only loopback (development) and
  // the administrator-activated Den origin may receive the private App-host
  // credential.
  if (process.env.OMNIRUSH_DEV_MODE === "1" && isLoopbackHostname(endpoint.hostname)) return true;
  const activatedEnterpriseOrigin = await readActivatedEnterpriseDenOrigin();
  return activatedEnterpriseOrigin !== null && endpoint.origin === activatedEnterpriseOrigin;
}

/** Stable private App-host identifier. This must never become an OpenCode MCP key. */
export function connectMcpAppHostName(connectionId: string): string {
  const digest = createHash("sha256").update(connectionId).digest("hex").slice(0, 12);
  return `${CONNECT_MCP_APP_HOST_NAME_PREFIX}${digest}`;
}

/**
 * OpenCode MCP key for a directly exposed connection. The readable slug tells
 * the model which service it is talking to; the digest keeps two connections
 * with the same display name apart.
 */
export function connectDirectMcpRuntimeName(server: { connectionId: string; name: string }): string {
  const slug = server.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const digest = createHash("sha256").update(server.connectionId).digest("hex").slice(0, 6);
  return `${CONNECT_DIRECT_MCP_SERVER_NAME_PREFIX}${slug ? `${slug}-` : ""}${digest}`;
}

function modelFacingHeaders(cloudMcp: Record<string, unknown>): Record<string, string> | null {
  const headers = cloudMcp.headers;
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return null;
  const entries = Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * Model-facing runtime entries for the directly exposed connections in an
 * index. They reuse the ordinary member credential already carried by the
 * `omnirush-cloud` entry; the private App-host credential never leaves the
 * App host. `oauth: false` matches the `omnirush-cloud` entry so an expired
 * bearer token during rotation yields a plain 401 instead of the engine
 * starting an interactive OAuth flow. Without a member credential there is
 * nothing to project.
 */
export function directConnectMcpRuntimeEntries(
  cloudMcp: Record<string, unknown>,
  index: OmniRushConnectMcpServerIndex,
): Record<string, Record<string, unknown>> {
  const headers = modelFacingHeaders(cloudMcp);
  if (!headers) return {};
  return Object.fromEntries(index.servers
    .filter((server) => server.exposeDirectly)
    .map((server) => [connectDirectMcpRuntimeName(server), {
      type: "remote",
      url: server.url,
      enabled: cloudMcp.enabled !== false,
      headers,
      oauth: false,
    }]));
}

export async function readOmniRushConnectMcpAppHostCatalog(
  config: ServerConfig,
  workspaceId: string,
): Promise<OmniRushConnectMcpServerIndex> {
  return await appHostCatalogStore.get(config, workspaceId) ?? emptyIndex();
}

export async function writeOmniRushConnectMcpAppHostCatalog(
  config: ServerConfig,
  workspaceId: string,
  catalog: OmniRushConnectMcpServerIndexInput,
): Promise<void> {
  const parsed = indexSchema.safeParse(catalog);
  await appHostCatalogStore.set(config, workspaceId, parsed.success ? parsed.data : emptyIndex());
}

export async function readOmniRushConnectMcpAppHostAuthorization(
  config: ServerConfig,
  workspaceId: string,
  endpointUrl: string,
): Promise<string | null> {
  const credential = await appHostAuthorizationStore.get(config, workspaceId);
  const expectedOrigin = endpointOrigin(endpointUrl);
  if (!credential || !expectedOrigin || credential.origin !== expectedOrigin) return null;
  return privateAppHostAuthorization(credential.authorization);
}

export async function writeOmniRushConnectMcpAppHostAuthorization(
  config: ServerConfig,
  workspaceId: string,
  value: string,
  sourceUrl: string,
): Promise<void> {
  const authorization = privateAppHostAuthorization(value);
  const origin = endpointOrigin(sourceUrl);
  await appHostAuthorizationStore.set(
    config,
    workspaceId,
    authorization && origin ? { authorization, origin } : null,
  );
}

export async function findOmniRushConnectMcpAppHostServer(
  config: ServerConfig,
  workspaceId: string,
  reference: { connectionId?: string; serverName?: string },
): Promise<OmniRushConnectMcpServerIndex["servers"][number] | null> {
  const catalog = await readOmniRushConnectMcpAppHostCatalog(config, workspaceId);
  return catalog.servers.find((server) => (
    (reference.connectionId !== undefined && server.connectionId === reference.connectionId)
    || (reference.serverName !== undefined && connectMcpAppHostName(server.connectionId) === reference.serverName)
  )) ?? null;
}

export async function readOmniRushConnectMcpServerIndex(
  cloudMcp: Record<string, unknown>,
  appHostAuthorization: string,
  fetcher: McpFetch = externalFetch,
): Promise<OmniRushConnectMcpServerIndex | null> {
  if (!await trustedAppHostCloudEndpoint(cloudMcp)) return null;
  const text = await readMcpResourceText({
    config: {
      ...cloudMcp,
      headers: {
        Authorization: appHostAuthorization,
        [CONNECT_MCP_APP_HOST_CAPABILITY_HEADER]: CONNECT_MCP_APP_HOST_CAPABILITY,
      },
    },
    uri: CONNECT_MCP_SERVER_INDEX_URI,
    fetcher,
    clientName: "omnirush-server-connect-mcp-catalog",
  });
  if (text === null) return null;
  const parsed = indexSchema.safeParse(JSON.parse(text));
  if (!parsed.success) return null;
  const servers: OmniRushConnectMcpServerIndex["servers"] = [];
  for (const server of parsed.data.servers) {
    const url = normalizeAppHostProxyUrl(cloudMcp.url, server);
    if (!url) return null;
    servers.push({ ...server, url });
  }
  return { ...parsed.data, servers };
}

/**
 * Refreshes the private App-host catalog when a gateway launch proves the
 * cached catalog may be stale. Unlike startup reconciliation, an unavailable
 * opportunistic refresh preserves the last known-good catalog.
 */
export async function refreshOmniRushConnectMcpAppHostCatalog(
  config: ServerConfig,
  workspaceId: string,
  fetcher?: McpFetch,
): Promise<{ status: "synced" | "unavailable"; appHostNames: string[] }> {
  const cloudMcp = await readGlobalRuntimeMcpConfig(config, "omnirush-cloud")
    ?? await readRuntimeMcpConfig(config, workspaceId, "omnirush-cloud");
  if (!cloudMcp || !await trustedAppHostCloudEndpoint(cloudMcp)) {
    return { status: "unavailable", appHostNames: [] };
  }
  const appHostAuthorization = await readOmniRushConnectMcpAppHostAuthorization(
    config,
    workspaceId,
    String(cloudMcp.url),
  );
  if (!appHostAuthorization) return { status: "unavailable", appHostNames: [] };

  const index = await readOmniRushConnectMcpServerIndex(cloudMcp, appHostAuthorization, fetcher).catch(() => null);
  if (!index) return { status: "unavailable", appHostNames: [] };

  await writeOmniRushConnectMcpAppHostCatalog(config, workspaceId, index);
  return {
    status: "synced",
    appHostNames: index.servers.map((server) => connectMcpAppHostName(server.connectionId)).sort(),
  };
}

/**
 * Keeps provider descriptors private to the Desktop App host, projects only the
 * connections an administrator exposed directly into the model-facing runtime,
 * and removes any legacy OmniRush.ai-owned provider endpoints. User-authored MCP
 * configurations and durable provider records are untouched.
 */
export async function reconcileOmniRushConnectMcpServers(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  cloudMcp: Record<string, unknown>;
  appHostAuthorization?: string;
  fetcher?: McpFetch;
}): Promise<{ status: "synced" | "unavailable"; appHostNames: string[]; directNames: string[]; removedNames: string[] }> {
  const trustedCloudEndpoint = await trustedAppHostCloudEndpoint(input.cloudMcp);
  if (trustedCloudEndpoint && input.appHostAuthorization !== undefined) {
    await writeOmniRushConnectMcpAppHostAuthorization(
      input.config,
      input.workspace.id,
      input.appHostAuthorization,
      String(input.cloudMcp.url),
    );
  }
  const appHostAuthorization = trustedCloudEndpoint
    ? await readOmniRushConnectMcpAppHostAuthorization(
      input.config,
      input.workspace.id,
      String(input.cloudMcp.url),
    )
    : null;
  const index = trustedCloudEndpoint && appHostAuthorization
    ? await readOmniRushConnectMcpServerIndex(input.cloudMcp, appHostAuthorization, input.fetcher).catch(() => null)
    : null;
  const privateCatalog = index ?? emptyIndex();
  await writeOmniRushConnectMcpAppHostCatalog(input.config, input.workspace.id, privateCatalog);

  // Without a fresh index, fail closed: a connection whose direct exposure was
  // revoked must not linger in the model-facing runtime on a stale catalog.
  const directEntries = directConnectMcpRuntimeEntries(input.cloudMcp, privateCatalog);
  let removedNames: string[] = [];
  await writeRuntimeOpencodeConfig(input.config, input.workspace.id, (current) => {
    const currentMcp = runtimeMcpMap(current);
    removedNames = Object.keys(currentMcp)
      .filter((name) => name.startsWith(CONNECT_MCP_SERVER_NAME_PREFIX)
        || (name.startsWith(CONNECT_DIRECT_MCP_SERVER_NAME_PREFIX) && !Object.hasOwn(directEntries, name)))
      .sort();
    return {
      ...current,
      mcp: {
        ...Object.fromEntries(Object.entries(currentMcp)
          .filter(([name]) => !name.startsWith(CONNECT_MCP_SERVER_NAME_PREFIX)
            && !name.startsWith(CONNECT_DIRECT_MCP_SERVER_NAME_PREFIX))),
        ...directEntries,
      },
    };
  });
  return {
    status: index ? "synced" : "unavailable",
    appHostNames: privateCatalog.servers.map((server) => connectMcpAppHostName(server.connectionId)).sort(),
    directNames: Object.keys(directEntries).sort(),
    removedNames,
  };
}
