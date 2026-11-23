// Fixes the app knows about, offered as chips under the newest Work answer (design 3.4, judge M5): what the turn's Work
// tool results said (an error code and its fix link, notices) checked against the live state (the connector list,
// paused actions). A chip never approves anything and never sends on its own, except Try again, which sends those words.
import type { DynamicToolUIPart, UIMessage } from "ai";

import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types";
import type { OmniRushWorkConnector } from "@/app/lib/omnirush-server";
import { getMessageCompleted, getMessageCreated } from "@/components/chat/utils";

import { WORK_TOOL_PREFIX, workToolNotices } from "../work-mode";

/** A Work tool's refusal: the hosted server's `{...extra, error, detail}` with isError. */
export type WorkToolError = { code: string; detail: string | null; extra: Record<string, unknown> };

/** What the newest turn's Work tool results said. `at`: when the turn ended (server time), for a wait. */
export type TurnSignals = {
  errors: (WorkToolError & { tool: string; connector: string | null; at: number | null })[];
  notices: boolean;
};

export type ActionChipSpec =
  | { id: string; kind: "link"; code: string; url: string; owner: string | null; repo: string | null }
  | { id: string; kind: "reconnect"; connector: string; label: string | null }
  | { id: string; kind: "connect" | "connectors"; connector: string }
  | { id: string; kind: "resume" }
  | { id: string; kind: "retry"; readyAt: number | null };

export const NO_SIGNALS: TurnSignals = { errors: [], notices: false };
/** At most this many fixes, ahead of the agent's replies. */
export const ACTION_CHIPS_MAX = 2;
/** The wait before Try again after a limit that names none. */
export const DEFAULT_WAIT_SECONDS = 60;

const CODE = /^[a-z][a-z0-9_]{1,63}$/;
const CONNECTOR_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const INSTALL = new Set(["needs_install", "needs_permission", "repo_not_installed"]);
const LIMITS = new Set(["rate_limited", "too_many_requests", "too_many_searches", "too_soon", "too_many_asks"]);
const ACCESS = new Set(["missing_permission", "permission_denied", "shopify_scope_missing", "bot_no_access", "message_content_off"]);
/** Tool name prefixes that belong to a connector of another id. */
const TOOL_CONNECTORS: Record<string, string> = {
  gmail: "google", calendar: "google", drive: "google", outlook: "microsoft", onedrive: "microsoft", teams: "microsoft", qbo: "quickbooks",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The first JSON object in a text (an engine's error line may wrap the tool's answer). */
function firstObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0 || text.length > 64 * 1024) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      const parsed = parseJson(text.slice(start, index + 1));
      return isObject(parsed) ? parsed : null;
    }
  }
  return null;
}

/** An error body: a code in `error`, and `detail` (every refusal) or nothing else (`tool_failed`). */
function errorBody(value: unknown): WorkToolError | null {
  if (!isObject(value) || typeof value.error !== "string" || !CODE.test(value.error)) return null;
  if (!("detail" in value) && Object.keys(value).length > 1) return null;
  const { error, detail, ...extra } = value;
  return { code: error, detail: typeof detail === "string" && detail.trim() ? detail.trim().slice(0, 400) : null, extra };
}

function fromMcpResult(result: unknown): WorkToolError | null {
  if (!isObject(result)) return null;
  if (result.isError !== true) return null;
  const structured = errorBody(result.structuredContent);
  if (structured) return structured;
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (isObject(item) && typeof item.text === "string") {
      const found = errorBody(firstObject(item.text));
      if (found) return found;
    }
  }
  return null;
}

/**
 * A Work tool's refusal, from the three places the engines keep it: the kept MCP result (with isError), the output
 * text (a result the engine passed on as is) or the part's error text (the 2.x engine turns isError into a failure
 * whose message is the result's text). Null for any other tool, a success, or an error that is not one of these.
 */
export function workToolError(part: Pick<DynamicToolUIPart, "toolName" | "state"> & { output?: unknown; errorText?: string; callProviderMetadata?: unknown }): WorkToolError | null {
  if (!part.toolName.startsWith(WORK_TOOL_PREFIX)) return null;
  if (part.state !== "output-available" && part.state !== "output-error") return null;
  const omnirush = isObject(part.callProviderMetadata) && isObject(part.callProviderMetadata.omnirush) ? part.callProviderMetadata.omnirush : null;
  const kept = omnirush ? fromMcpResult(omnirush.mcpResult) : null;
  if (kept) return kept;
  if (part.state === "output-error") return typeof part.errorText === "string" ? errorBody(firstObject(part.errorText)) : null;
  const output = part.output;
  if (typeof output === "string") return errorBody(firstObject(output.slice(0, 64 * 1024)));
  if (isObject(output)) return fromMcpResult(output) ?? errorBody(output);
  return null;
}

/** The connector a Work tool belongs to (`omnirush-work_gmail_send` → google); null for the app's own `work_*` tools. */
export function toolConnector(toolName: string): string | null {
  if (!toolName.startsWith(WORK_TOOL_PREFIX)) return null;
  const app = toolName.slice(WORK_TOOL_PREFIX.length).split("_")[0] ?? "";
  if (!app || app === "work" || !CONNECTOR_ID.test(app)) return null;
  return TOOL_CONNECTORS[app] ?? app;
}

const isSessionError = (message: UIMessage) => message.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX);

/** The newest turn's Work signals: its tool parts after the last user message, while an answer is the newest message. */
export function lastTurnSignals(messages: UIMessage[]): TurnSignals {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || isSessionError(last)) return NO_SIGNALS;
  const errors: TurnSignals["errors"] = [];
  let notices = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") break;
    if (message.role !== "assistant" || isSessionError(message)) continue;
    const at = getMessageCompleted(message) ?? getMessageCreated(message);
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue;
      if (part.state === "output-available" && workToolNotices(part).length) notices = true;
      const error = workToolError(part);
      if (error) errors.unshift({ ...error, tool: part.toolName, connector: toolConnector(part.toolName), at });
    }
  }
  return errors.length || notices ? { errors, notices } : NO_SIGNALS;
}

/** "retry after 45s" (the server's rate limit detail) in seconds; the default wait otherwise. */
export function waitSeconds(detail: string | null): number {
  const match = /retry after\s+(\d+(?:\.\d+)?)\s*s/i.exec(detail ?? "");
  const seconds = match ? Math.ceil(Number(match[1])) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : DEFAULT_WAIT_SECONDS;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null);
const httpsUrl = (value: unknown) => {
  const url = text(value);
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

/**
 * The fixes to offer, most specific first, checked against the live state:
 * - a GitHub refusal with its link (install on the owner, review access, add the repository);
 * - Reconnect for each connector whose attention says so, when the turn hit `reconnect_required` or carried a notice
 *   (the list is read again; a connector that is fine now gets none);
 * - Connect (`not_connected`) or Open in Connectors (an access refusal from a connector's own tool);
 * - Resume actions while actions are paused, Try again once they are not;
 * - Try again after a limit (ready once its wait is over) or a failed tool.
 * Anything else (`ask_budget`, unknown codes) gets none: the agent explains.
 */
export function actionChipSpecs(
  signals: TurnSignals,
  live: { connectors?: OmniRushWorkConnector[] | null; writesPaused?: boolean | null } = {},
): ActionChipSpec[] {
  const links: ActionChipSpec[] = [];
  const reconnect: ActionChipSpec[] = [];
  const connectors: ActionChipSpec[] = [];
  let paused = false;
  // Try again: undefined for none, null for now, else the time its wait ends.
  let retryAt: number | null | undefined;
  let wantsReconnect = signals.notices;
  const preferred: string[] = [];
  for (const error of signals.errors) {
    if (INSTALL.has(error.code)) {
      const url = httpsUrl(error.extra.setup_url);
      if (url) links.push({ id: `link:${error.code}:${url}`, kind: "link", code: error.code, url, owner: text(error.extra.owner), repo: text(error.extra.repo) });
    } else if (error.code === "reconnect_required") {
      wantsReconnect = true;
      if (error.connector) preferred.push(error.connector);
    } else if (error.code === "not_connected") {
      const id = error.detail && CONNECTOR_ID.test(error.detail) ? error.detail : error.connector;
      if (id) connectors.push({ id: `connect:${id}`, kind: "connect", connector: id });
    } else if (ACCESS.has(error.code)) {
      if (error.connector) connectors.push({ id: `connectors:${error.connector}`, kind: "connectors", connector: error.connector });
    } else if (error.code === "writes_paused") {
      paused = true;
    } else if (LIMITS.has(error.code)) {
      const readyAt = error.at && error.at > 0 ? error.at + waitSeconds(error.detail) * 1000 : 0;
      retryAt = Math.max(retryAt ?? 0, readyAt) || null;
    } else if (error.code === "tool_failed") {
      if (retryAt === undefined) retryAt = null;
    }
  }
  if (wantsReconnect) {
    const rows = (live.connectors ?? []).filter((row) => row.attention?.action === "reconnect");
    rows.sort((a, b) => Number(preferred.includes(b.id)) - Number(preferred.includes(a.id)));
    for (const row of rows) reconnect.push({ id: `reconnect:${row.id}`, kind: "reconnect", connector: row.id, label: row.label?.trim() || null });
  }
  const fixes: ActionChipSpec[] = [...links, ...reconnect, ...connectors];
  if (paused) {
    if (live.writesPaused !== false) fixes.push({ id: "resume", kind: "resume" });
    else if (retryAt === undefined) retryAt = null;
  }
  if (retryAt !== undefined) fixes.push({ id: "retry", kind: "retry", readyAt: retryAt });
  const seen = new Set<string>();
  return fixes.filter((chip) => (seen.has(chip.id) ? false : (seen.add(chip.id), true))).slice(0, ACTION_CHIPS_MAX);
}
