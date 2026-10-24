/**
 * The desktop's computer use routes, for Electron main only (client scope,
 * loopback): the switch and permission mode it applies, the host file it
 * writes when its host listens, and the `computer.session` events it reports.
 *
 *   GET  /computer-use/state     { enabled, unavailable, setting, mode, dir, spool, chat }
 *   POST /computer-use/refresh   reads /collect/capabilities again (≤ 60 s old), then the state; with `read`
 *                                true, `setting` is the answer just read (held in memory, never re-read from the
 *                                state folder, which the agent's shell can write), so the person's real screen
 *                                (`real_screen` and `real_screen_opt_in`, the account's server-held opt-in) can
 *                                only come from the server
 *   POST /computer-use/host      { command, environment } | { host: null }
 *   POST /computer-use/event     a computer.session event → the chat's trace
 */
import { addRoute, type Route } from "../routes/registry.js";
import { computerUseSetting, unavailableMessage } from "./shared/policy.mjs";
import {
  computerUseDir,
  computerUseSettingFor,
  type createChatTracker,
  expectedHostCommand,
  hostSecretMatches,
  sameHostCommand,
  mediaSpoolDir,
  permissionModeName,
  readHostFile,
  rememberComputerUseSwitch,
  sessionEventOf,
  writeHostFile,
} from "./desktop.js";

export type ComputerUseRouteDeps = {
  routes: Route[];
  stateDir: () => string;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  /** The desktop approval mode ("careful" | "guarded" | "full"), or null. */
  approvalMode: () => Promise<string | null>;
  /** Fresh capabilities (strict), or throws. */
  readCapabilities: (maxAgeMs: number) => Promise<unknown>;
  /** Restart the engine's projects so they pick up the built-in server. */
  applyEngine: () => Promise<unknown>;
  chats: ReturnType<typeof createChatTracker>;
  /** The engine's running sessions, or null when unknown. */
  runningSessions: () => Promise<string[] | null>;
  /** Records a trace event on a chat the uploader has open. */
  recordTrace: (sessionId: string, type: string, data: Record<string, unknown>) => void;
};

const REFRESH_FLOOR_MS = 2_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registerComputerUseRoutes(deps: ComputerUseRouteDeps): void {
  const { routes, jsonResponse } = deps;
  const state = async (read?: boolean, fresh?: unknown) => {
    const dir = computerUseDir(deps.stateDir());
    // A fresh answer: the block it carries (an answer without one is off); else the block as last remembered.
    const setting = fresh !== undefined
      ? computerUseSetting({ env: process.env, block: isObject(fresh) && isObject(fresh.computer_use) ? fresh.computer_use : undefined, client: "desktop" })
      : computerUseSettingFor(dir);
    const mode = permissionModeName(await deps.approvalMode().catch(() => null));
    // The chat "Allow for this chat" is kept for: the one prompted chat that runs, else none (asked every time).
    const chat = deps.chats.only(await deps.runningSessions().catch(() => null));
    return {
      enabled: setting.enabled,
      // Why it is off here, in plain words (macOS, this app, the account), for the app to show.
      unavailable: unavailableMessage(setting),
      setting: { enabled: setting.enabled, real_screen: setting.real_screen, real_screen_opt_in: setting.real_screen_opt_in, virtual_display: setting.virtual_display, limits: setting.limits, deny_apps: setting.deny_apps, models: setting.models, message: setting.message, ask_send_delete: setting.ask_send_delete === true, reason: setting.reason, source: setting.source },
      mode,
      dir,
      spool: mediaSpoolDir(deps.stateDir()),
      host: readHostFile(dir) !== null,
      chat,
      ...(read === undefined ? {} : { read }),
    };
  };

  addRoute(routes, "GET", "/computer-use/state", "client", async () => jsonResponse(await state()));

  // `max_age_ms` (2000..60000, default 60000): how old a cached answer may be; the host asks with 0 before each
  // open, so a stricter server value applies at once. `read`: whether the server answered.
  addRoute(routes, "POST", "/computer-use/refresh", "client", async (ctx) => {
    const body = await deps.readJsonBody(ctx.request).catch(() => ({} as Record<string, unknown>));
    // At most one real read per REFRESH_FLOOR_MS (a loop on this route cannot flood the server): an answer
    // that recent counts as read now.
    const maxAge = typeof body.max_age_ms === "number" && Number.isFinite(body.max_age_ms) ? Math.min(60_000, Math.max(REFRESH_FLOOR_MS, Math.round(body.max_age_ms))) : 60_000;
    let read = false;
    let fresh: unknown;
    try {
      const capabilities = await deps.readCapabilities(maxAge);
      if (rememberComputerUseSwitch(deps.stateDir(), capabilities)) void deps.applyEngine().catch(() => undefined);
      read = true;
      fresh = capabilities;
    } catch {
      // A failed read keeps the last answer (`read` false: never enough for the person's real screen).
    }
    return jsonResponse(await state(read, fresh));
  });

  // Host and event: only Electron main (its per-launch secret, held in this process); the client token is
  // readable by the agent's shell, so it is not enough to replace the server's command or forge events.
  const fromMain = (request: Request) => hostSecretMatches(request.headers.get("x-omnirush-computer-use-secret"));

  addRoute(routes, "POST", "/computer-use/host", "client", async (ctx) => {
    if (!fromMain(ctx.request)) return jsonResponse({ ok: false, error: "forbidden" }, 403);
    const body = await deps.readJsonBody(ctx.request);
    const command = Array.isArray(body.command) && body.command.every((part) => typeof part === "string") ? (body.command as string[]) : null;
    const environment = typeof body.environment === "object" && body.environment !== null && !Array.isArray(body.environment)
      ? Object.fromEntries(Object.entries(body.environment as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    const host = command && command.length ? { command, environment } : null;
    // Only the app's own relay command (expectedHostCommand), or none.
    if (host && !sameHostCommand(host, expectedHostCommand())) return jsonResponse({ ok: false, error: "unexpected_command" }, 400);
    const changed = writeHostFile(computerUseDir(deps.stateDir()), host);
    if (changed) void deps.applyEngine().catch(() => undefined);
    return jsonResponse({ ok: true, changed });
  });

  addRoute(routes, "POST", "/computer-use/event", "client", async (ctx) => {
    if (!fromMain(ctx.request)) return jsonResponse({ ok: false, error: "forbidden" }, 403);
    const body = await deps.readJsonBody(ctx.request);
    const event = sessionEventOf(body.event);
    if (!event) return jsonResponse({ ok: false, error: "invalid_event" }, 400);
    const chat = typeof body.chat === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(body.chat) ? body.chat : deps.chats.resolve(await deps.runningSessions().catch(() => null));
    if (chat) deps.recordTrace(chat, "computer.session", event);
    return jsonResponse({ ok: true, chat });
  });
}
