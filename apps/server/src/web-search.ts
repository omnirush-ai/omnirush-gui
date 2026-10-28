/**
 * The model's own web search (the OpenAI Responses `web_search` tool, run by
 * the provider) for the bundled engine; the same rules as the CLI's
 * src/web-search.js.
 *
 * Off unless something turns it on, in this order:
 *   1. the user's Settings switch (<runtimeStorageDir>/web-search-user.json): off is off; on leaves it to the rest;
 *   2. OMNIRUSH_WEB_SEARCH=1/on or 0/off in the server environment;
 *   3. the server's switch: GET /collect/capabilities `web_search`
 *      ({ enabled, search_context_size, models, clients, rollout_percent }),
 *      as last seen (<runtimeStorageDir>/web-search-server.json). No block (an
 *      older server), or enabled false, is off. The server answers for this
 *      account and app: `clients` and `rollout_percent` are already applied
 *      to `enabled`, so the app reads `enabled` as it is and sends nothing extra.
 * Only models whose catalog entry has capabilities.web_search get the tool;
 * the server's `models` list (the models its gateway lets search), when it
 * gives one, narrows that further.
 *
 * When it is on, the engine config gives those models
 * `options.hostedWebSearch` ({ searchContextSize }), which the engine turns
 * into the provider's web_search tool. Off, the engine config is exactly what
 * it was before (no `options` key on any model).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OmniRushCatalogModel } from "./omnirush-model-catalog.js";

export const WEB_SEARCH_SERVER_FILE = "web-search-server.json";
export const WEB_SEARCH_USER_FILE = "web-search-user.json";
export const SEARCH_CONTEXT_SIZES = ["low", "medium", "high"] as const;
export type SearchContextSize = (typeof SEARCH_CONTEXT_SIZES)[number];
export const DEFAULT_SEARCH_CONTEXT_SIZE: SearchContextSize = "medium";
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type WebSearchSwitch = { enabled: boolean; searchContextSize: SearchContextSize; models: string[] | null };
export type WebSearchSetting = WebSearchSwitch & { source: "env" | "user" | "server" | "default" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contextSize(value: unknown): SearchContextSize {
  return (SEARCH_CONTEXT_SIZES as readonly unknown[]).includes(value) ? (value as SearchContextSize) : DEFAULT_SEARCH_CONTEXT_SIZE;
}

/** The server's switch in a /collect/capabilities answer; a missing or malformed block is off. */
export function webSearchServerSwitch(capabilities: unknown): WebSearchSwitch {
  const block = isRecord(capabilities) ? capabilities.web_search : null;
  if (!isRecord(block)) return { enabled: false, searchContextSize: DEFAULT_SEARCH_CONTEXT_SIZE, models: null };
  const models = Array.isArray(block.models)
    ? block.models.filter((id): id is string => typeof id === "string" && MODEL_ID.test(id)).slice(0, 64)
    : null;
  return { enabled: block.enabled === true, searchContextSize: contextSize(block.search_context_size), models };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function rememberedSwitch(stateDir: string): WebSearchSwitch | null {
  const saved = readJson(join(stateDir, WEB_SEARCH_SERVER_FILE));
  return isRecord(saved) ? webSearchServerSwitch({ web_search: saved }) : null;
}

/**
 * Remembers the switch of a /collect/capabilities answer (every answer: a
 * missing block turns it off; null, no answer, keeps the last). Whether the
 * remembered switch changed.
 */
export function rememberWebSearchSwitch(stateDir: string, capabilities: unknown): boolean {
  if (!stateDir || !isRecord(capabilities)) return false;
  const value = webSearchServerSwitch(capabilities);
  const before = rememberedSwitch(stateDir);
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, WEB_SEARCH_SERVER_FILE),
      JSON.stringify({ enabled: value.enabled, search_context_size: value.searchContextSize, models: value.models, at: Date.now() }),
      { mode: 0o600 },
    );
  } catch {
    /* best effort */
  }
  return JSON.stringify(before ?? webSearchServerSwitch(null)) !== JSON.stringify(value);
}

/** The user's Settings switch: on unless turned off. */
export function userWebSearchEnabled(stateDir: string | undefined): boolean {
  const saved = stateDir ? readJson(join(stateDir, WEB_SEARCH_USER_FILE)) : null;
  return !(isRecord(saved) && saved.enabled === false);
}

/** Saves the user's Settings switch (throws when it cannot be written: the app keeps the previous one). */
export function writeUserWebSearch(stateDir: string, enabled: boolean): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, WEB_SEARCH_USER_FILE), JSON.stringify({ enabled, at: Date.now() }), { mode: 0o600 });
}

/** Whether web search is allowed apart from the user's switch: the environment override, else the server's switch as last seen. */
export function webSearchAllowed({ env = process.env, stateDir }: { env?: NodeJS.ProcessEnv; stateDir?: string } = {}): boolean {
  return webSearchSetting({ env, stateDir, user: true }).enabled;
}

/** Web search for the engine config; `models` (null: every model with the capability) comes from the server. */
export function webSearchSetting({ env = process.env, stateDir, user }: { env?: NodeJS.ProcessEnv; stateDir?: string; user?: boolean } = {}): WebSearchSetting {
  const server = stateDir ? rememberedSwitch(stateDir) : null;
  const size = server?.searchContextSize ?? DEFAULT_SEARCH_CONTEXT_SIZE;
  if (!(user ?? userWebSearchEnabled(stateDir))) return { enabled: false, source: "user", searchContextSize: size, models: null };
  const asked = String(env.OMNIRUSH_WEB_SEARCH ?? "").trim().toLowerCase();
  if (["0", "off", "false", "no"].includes(asked)) return { enabled: false, source: "env", searchContextSize: size, models: null };
  if (["1", "on", "true", "yes"].includes(asked)) return { enabled: true, source: "env", searchContextSize: size, models: null };
  if (server) return { ...server, source: "server" };
  return { enabled: false, source: "default", searchContextSize: size, models: null };
}

/**
 * Whether the engine offers no websearch tool at all: the user turned it off, or (outside stock mode, where stock
 * OpenCode's own tool stays) web search is off for this account, as the Settings switch then shows.
 */
export function webSearchToolOff(setting: WebSearchSetting, stock: boolean): boolean {
  return setting.source === "user" || (!stock && !setting.enabled);
}

/** Whether `model` (a sanitized catalog entry) gets the tool under `setting`. */
export function modelHasWebSearch(model: Pick<OmniRushCatalogModel, "id" | "capabilities"> | undefined, setting: WebSearchSwitch | null | undefined): boolean {
  if (!setting?.enabled || !model?.capabilities?.web_search) return false;
  return !Array.isArray(setting.models) || setting.models.includes(model.id);
}

/**
 * Reads the server's switch again every `everyMs` while the app runs (an app
 * started before the switch was flipped, or kept open for days, follows it
 * without a restart) and calls `apply` when it changed. One read at a time;
 * a failed read (`read` throws) keeps the last answer. Returns the stop.
 */
export function watchWebSearchSwitch({ stateDir, read, apply, everyMs }: { stateDir: string; read: () => Promise<unknown>; apply: () => Promise<unknown>; everyMs: number }): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void read()
      .then((capabilities) => (rememberWebSearchSwitch(stateDir, capabilities) ? apply() : undefined))
      .catch(() => undefined)
      .finally(() => { busy = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
