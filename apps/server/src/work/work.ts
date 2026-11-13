/**
 * Work mode (e2e/work-mode-contract-2026-11-09.md): business chats in an app-managed folder with the hosted
 * connector MCP server, no shell or code tools, and the Work prompt.
 *
 * The server's switch is GET /collect/capabilities `work` ({enabled, allow_users, sources, message}),
 * remembered like computer use; absent or malformed is off. Files under <appData>/work/ (OMNIRUSH_WORK_DIR in
 * the engine's environment):
 *   server.json        the switch as last seen
 *   connectors.json    the account's connectors as last listed (for the upload's environment.work)
 *   <accountId>/       the Work chats' folder (the Work workspace)
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const WORK_DIR_ENV = "OMNIRUSH_WORK_DIR";
export const WORK_PRESET = "work";
/** A connector id as the server names it (google, jira, …): new ids the app does not know yet still work. */
export const WORK_SOURCE_ID = /^[a-z][a-z0-9_-]{0,31}$/;

/** The `/omnirush/work/` paths the app calls (the contract's): connectors, entities, facts, health, the MCP server, and
 *  the tryout and company setup (enable, onboarding, demo, org invites and members). */
export const WORK_PATH = /^(?:connectors(?:\/[a-z][a-z0-9_-]{0,31}(?:\/(?:start|disconnect))?)?|entities(?:\/[A-Za-z0-9_.:-]{1,128})?|facts(?:\/[A-Za-z0-9_.:-]{1,128})?|health|mcp|enable|onboarding|demo|org\/(?:invites|members))$/;

/** The hosted server's tools that only read (the contract's table): every other tool asks first, in every mode. */
export const WORK_READ_TOOLS = [
  "gmail_search", "gmail_read_thread", "drive_search", "drive_read", "calendar_list",
  "outlook_search", "outlook_read", "onedrive_search", "onedrive_read", "teams_search", "teams_read",
  "slack_search", "slack_read_channel", "slack_read_thread", "hubspot_search", "hubspot_read",
  "qbo_query", "qbo_read", "notion_search", "notion_read", "work_search", "mock_search", "mock_read",
  "jira_search", "jira_read", "confluence_search", "confluence_read", "linear_search", "linear_read", "github_search", "github_read",
  // The context graph: briefing and lookup only; work_remember and work_forget ask like every write.
  "work_context", "work_entity",
];

/** The engine's own tools a Work chat does not get (no shell, no code editing). */
export const WORK_DISABLED_TOOLS = ["bash", "edit", "write", "patch", "multiedit", "apply_patch", "task", "lsp", "codesearch"];

/** `available`: Work is off for the account but it can turn it on itself (POST /omnirush/work/enable, the "Try Work" offer). */
export type WorkSwitch = { enabled: boolean; available: boolean; sources: string[]; message: string | null };
export type WorkConnectorUse = { id: string; enabled: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
}

/** <appData>/work: the desktop profile folder when known, else the server's state folder. */
export function workDir(stateDir: string, env: Record<string, string | undefined> = process.env): string {
  return join(env.OMNIRUSH_DESKTOP_USER_DATA_DIR?.trim() || stateDir, "work");
}

/** The Work chats' folder of an account (ids are the server's: kept to safe characters). */
export function workHome(dir: string, accountId: string): string | null {
  return /^[A-Za-z0-9_-]{1,128}$/.test(accountId) ? join(dir, accountId) : null;
}

/** Whether `root` is an account's Work folder under `dir`. */
export function isWorkRoot(dir: string | null | undefined, root: string | null | undefined): boolean {
  if (!dir || !root) return false;
  const parent = dirname(resolve(root));
  return parent === resolve(dir) && /^[A-Za-z0-9_-]{1,128}$/.test(resolve(root).slice(parent.length + 1));
}

/** The `work` block of a capabilities answer; a missing or malformed block is off. */
export function workServerSwitch(capabilities: unknown): WorkSwitch {
  const block = isRecord(capabilities) ? capabilities.work : null;
  if (!isRecord(block)) return { enabled: false, available: false, sources: [], message: null };
  const sources = Array.isArray(block.sources)
    ? block.sources.filter((id): id is string => typeof id === "string" && WORK_SOURCE_ID.test(id))
    : [];
  const message = typeof block.message === "string" && block.message.trim() ? block.message.trim().slice(0, 400) : null;
  const enabled = block.enabled === true;
  return { enabled, available: !enabled && block.available === true, sources, message };
}

/** The switch as last seen (off when never seen). */
export function rememberedWorkSwitch(dir: string): WorkSwitch {
  const saved = readJson(join(dir, "server.json"));
  return workServerSwitch(isRecord(saved) ? { work: saved.block } : null);
}

/** Remembers the `work` block of an answer (null, no answer, keeps the last). Whether it changed. */
export function rememberWorkSwitch(dir: string, capabilities: unknown): boolean {
  if (!dir || !isRecord(capabilities)) return false;
  const before = rememberedWorkSwitch(dir);
  const block = isRecord(capabilities.work) ? capabilities.work : null;
  try {
    writeJson(join(dir, "server.json"), { block, at: Date.now() });
  } catch {
    return false;
  }
  return JSON.stringify(before) !== JSON.stringify(workServerSwitch(capabilities));
}

/** Remembers the account's connectors from a GET /omnirush/work/connectors answer: the connected ones and their sync switch. */
export function rememberWorkConnectors(dir: string, listed: unknown): WorkConnectorUse[] {
  const rows = Array.isArray(listed) ? listed : isRecord(listed) && Array.isArray(listed.connectors) ? listed.connectors : [];
  const used = rows
    .filter((row): row is Record<string, unknown> => isRecord(row) && typeof row.id === "string" && WORK_SOURCE_ID.test(row.id))
    .filter((row) => row.status === "connected" || row.status === "syncing" || row.status === "error")
    .map((row) => ({ id: String(row.id), enabled: row.sync_enabled === true }));
  try {
    writeJson(join(dir, "connectors.json"), { connectors: used, at: Date.now() });
  } catch {
    // Only the upload's field reads it.
  }
  return used;
}

/**
 * The upload envelope's additive Work fields for a chat in `root`: `{mode: "work", work: {connectors}}`, or null
 * for every other chat (whose environment stays exactly as before).
 */
export function workEnvironment(dir: string | null | undefined, root: string): { mode: "work"; work: { connectors: WorkConnectorUse[] } } | null {
  if (!dir || !isWorkRoot(dir, root)) return null;
  return { mode: "work", work: { connectors: rememberedWorkConnectors(dir) } };
}

/** The account's connectors as last listed (rememberWorkConnectors). */
export function rememberedWorkConnectors(dir: string): WorkConnectorUse[] {
  const saved = readJson(join(dir, "connectors.json"));
  return isRecord(saved) && Array.isArray(saved.connectors)
    ? saved.connectors.filter((row): row is WorkConnectorUse => isRecord(row) && typeof row.id === "string" && typeof row.enabled === "boolean").map((row) => ({ id: row.id, enabled: row.enabled }))
    : [];
}
