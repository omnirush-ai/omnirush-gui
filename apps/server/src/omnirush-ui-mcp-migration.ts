import { isOmniRushUiMcpRegistryCommand } from "./omnirush-ui-mcp-command.js";
import {
  listRuntimeOpencodeConfigRows,
  runtimeMcpMap,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { isRecord } from "./workspace-kv-store.js";

/*
 * Desktop 1.0.0 to 1.0.8 persisted `npx -y omnirush-ui-mcp` as the launch
 * command of the built-in UI-control MCP. `omnirush-ui-mcp` is not a package
 * OmniRush.ai publishes on npm, so whoever registers that name would get code
 * execution through `npx`. Entries launching it from a registry (that command
 * and every variant isOmniRushUiMcpRegistryCommand matches) are rewritten on
 * load and never launched as-is.
 */

/** How the embedding desktop launches its bundled UI-control MCP. */
export type OmniRushUiMcpLaunch = {
  command: string[];
  environment?: Record<string, string>;
};

export type OmniRushUiMcpMigrationResult = {
  changed: boolean;
  /** Legacy npx entries moved to the bundled launch. */
  rewritten: Array<{ workspaceId: string; name: string }>;
  /** Earlier bundled launches whose app path moved (app relocated, AppImage remount, update). */
  refreshed: Array<{ workspaceId: string; name: string }>;
  /** Legacy npx entries removed because no bundled launch was available. */
  removed: Array<{ workspaceId: string; name: string }>;
};

const PACKAGE_RUNNERS = new Set(["npx", "bunx", "pnpx"]);

function runsPackageRunner(executable: string): boolean {
  const base = executable.split(/[\\/]/).pop()?.toLowerCase().replace(/\.(?:cmd|exe|ps1|bat)$/, "") ?? "";
  return PACKAGE_RUNNERS.has(base);
}

const BUNDLED_ENTRY_SUFFIXES = ["/omnirush-ui-mcp/index.mjs", "\\omnirush-ui-mcp\\index.mjs"];

/** `[<runtime>, <...>/omnirush-ui-mcp/index.mjs]` as written by an earlier desktop launch. */
export function isBundledOmniRushUiMcpCommand(value: unknown): boolean {
  return Array.isArray(value)
    && value.length === 2
    && value.every((part) => typeof part === "string" && part.length > 0)
    && BUNDLED_ENTRY_SUFFIXES.some((suffix) => (value[1] as string).endsWith(suffix));
}

function sameCommand(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left) && left.length === right.length && left.every((part, index) => part === right[index]);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/** Accepts only a concrete, non-npx launch; anything else is treated as "no bundled MCP". */
export function normalizeOmniRushUiMcpLaunch(value: unknown): OmniRushUiMcpLaunch | null {
  if (!isRecord(value)) return null;
  const command = value.command;
  if (!Array.isArray(command) || command.length === 0) return null;
  if (!command.every((part) => typeof part === "string" && part.length > 0)) return null;
  if (runsPackageRunner(command[0]) || isOmniRushUiMcpRegistryCommand(command)) return null;
  const environment = stringRecord(value.environment);
  return {
    command: [...command],
    ...(Object.keys(environment).length ? { environment } : {}),
  };
}

function withLaunch(entry: Record<string, unknown>, launch: OmniRushUiMcpLaunch): Record<string, unknown> {
  const environment = { ...stringRecord(entry.environment), ...(launch.environment ?? {}) };
  const { environment: _previousEnvironment, ...rest } = entry;
  return {
    ...rest,
    command: [...launch.command],
    ...(Object.keys(environment).length ? { environment } : {}),
  };
}

function launchIsCurrent(entry: Record<string, unknown>, launch: OmniRushUiMcpLaunch): boolean {
  const environment = stringRecord(entry.environment);
  return sameCommand(entry.command, launch.command)
    && Object.entries(launch.environment ?? {}).every(([key, value]) => environment[key] === value);
}

/**
 * Rewrites every MCP entry that launches `omnirush-ui-mcp` from a registry.
 * With a bundled launch the entry keeps its name, enablement, and other
 * fields and gets the bundled command plus its environment. Without one (a
 * standalone server, or a desktop build missing the bundle) the entry is
 * removed: disabling alone would leave a command the MCP toggle could turn
 * back on. UI control is reconnected from the desktop app, which writes the
 * bundled launch.
 *
 * Entries that already use an earlier bundled launch are refreshed to the
 * current one: the launch carries absolute app paths, which change when the
 * app is moved or an AppImage is remounted.
 */
export function rewriteLegacyOmniRushUiMcpEntries(
  mcp: Record<string, Record<string, unknown>>,
  launch: OmniRushUiMcpLaunch | null,
): { mcp: Record<string, Record<string, unknown>>; rewritten: string[]; refreshed: string[]; removed: string[] } {
  const next: Record<string, Record<string, unknown>> = {};
  const rewritten: string[] = [];
  const refreshed: string[] = [];
  const removed: string[] = [];
  for (const [name, entry] of Object.entries(mcp)) {
    if (isRecord(entry) && isOmniRushUiMcpRegistryCommand(entry.command)) {
      if (launch) {
        next[name] = withLaunch(entry, launch);
        rewritten.push(name);
      } else {
        removed.push(name);
      }
      continue;
    }
    if (launch && isRecord(entry) && isBundledOmniRushUiMcpCommand(entry.command) && !launchIsCurrent(entry, launch)) {
      next[name] = withLaunch(entry, launch);
      refreshed.push(name);
      continue;
    }
    next[name] = entry;
  }
  return { mcp: next, rewritten, refreshed, removed };
}

/**
 * Idempotent startup migration of persisted runtime MCP entries that still
 * launch the UI-control MCP through `npx -y omnirush-ui-mcp` (and refresh of
 * stale bundled launches). Runs before the engine starts, and before any
 * other startup writer: the runtime store drops leftover registry launches on
 * any write, which would lose the entry this migration can still rewrite.
 */
export async function migrateLegacyOmniRushUiMcpCommand(
  config: ServerConfig,
  launchInput: unknown,
): Promise<OmniRushUiMcpMigrationResult> {
  const result: OmniRushUiMcpMigrationResult = { changed: false, rewritten: [], refreshed: [], removed: [] };
  if (config.readOnly) return result;
  const launch = normalizeOmniRushUiMcpLaunch(launchInput);
  const rows = await listRuntimeOpencodeConfigRows(config);
  for (const row of rows) {
    const pending = rewriteLegacyOmniRushUiMcpEntries(runtimeMcpMap(row.value), launch);
    if (!pending.rewritten.length && !pending.refreshed.length && !pending.removed.length) continue;
    let migrated = pending;
    const write = await writeRuntimeOpencodeConfig(config, row.workspaceId, (current) => {
      migrated = rewriteLegacyOmniRushUiMcpEntries(runtimeMcpMap(current), launch);
      return { ...current, mcp: migrated.mcp };
    });
    result.changed = write.changed || result.changed;
    result.rewritten.push(...migrated.rewritten.map((name) => ({ workspaceId: row.workspaceId, name })));
    result.refreshed.push(...migrated.refreshed.map((name) => ({ workspaceId: row.workspaceId, name })));
    result.removed.push(...migrated.removed.map((name) => ({ workspaceId: row.workspaceId, name })));
  }
  return result;
}
