import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

function normalizeOmniRushWorkspaceConfig(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseOmniRushWorkspaceConfig(configJson: string): Record<string, unknown> {
  try {
    return normalizeOmniRushWorkspaceConfig(JSON.parse(configJson));
  } catch {
    return {};
  }
}

const omnirushWorkspaceConfigStore = createWorkspaceKvStore<Record<string, unknown>>({
  tableName: "omnirush_workspace_configs",
  valueColumn: "config_json",
  parse: parseOmniRushWorkspaceConfig,
  serialize: (value) => JSON.stringify(value),
});

export async function readOmniRushWorkspaceConfig(config: ServerConfig, workspaceId: string): Promise<Record<string, unknown>> {
  return await omnirushWorkspaceConfigStore.get(config, workspaceId) ?? {};
}

export async function writeOmniRushWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const next = normalizeOmniRushWorkspaceConfig(updater(await readOmniRushWorkspaceConfig(config, workspaceId)));
  await omnirushWorkspaceConfigStore.set(config, workspaceId, next);
  return next;
}

export async function hasOmniRushWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
): Promise<boolean> {
  return omnirushWorkspaceConfigStore.has(config, workspaceId);
}

/**
 * Seed the DB-backed omnirush config for a workspace if no row exists yet.
 * Used at workspace creation and as the migrate-on-read landing spot for
 * legacy `.opencode/omnirush.json` files. No-op when a row is already present,
 * so it never clobbers live provisioning state.
 */
export async function seedOmniRushWorkspaceConfigIfEmpty(
  config: ServerConfig,
  workspaceId: string,
  seed: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (await hasOmniRushWorkspaceConfig(config, workspaceId)) {
    return readOmniRushWorkspaceConfig(config, workspaceId);
  }
  return writeOmniRushWorkspaceConfig(config, workspaceId, () => seed);
}

export function mergeOmniRushWorkspaceConfigs(
  legacy: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  return { ...legacy, ...stored };
}
