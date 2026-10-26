// The app's side of a Claude chat: the route the engine's Claude provider calls for each turn
// (opencode-plugins/claude-provider, POST with x-omnirush-usage-key). The same rules as the CLI's
// src/claude-code/chat.js claudeChatRoute:
// - grant: may this chat's turn run on this Claude model? One model per chat: a chat pinned to
//   another model, or one with earlier turns and no Claude transcript, is refused (the window offers
//   a new chat); an account without access gets the "not available" message. Else the chat's
//   short-lived relay token (access.ts), and the chat is pinned to the model.
// - end: a turn finished; its native transcript goes up (onTurnEnd).
import { createHash } from "node:crypto";

import type { ClaudeAccess, ClaudeAuthorization, ClaudeGrant } from "./access.js";

/** The provider's pinned Claude Code (opencode-plugins/claude-provider CLAUDE_CODE_VERSION; claude-chat.test.ts checks both). */
export const CLAUDE_CODE_VERSION = "2.1.306";
/** The contract the relay token is bound to: the provider's CONTRACT. */
export const CLAUDE_CONTRACT = createHash("sha256").update(JSON.stringify({ claude_code: CLAUDE_CODE_VERSION, provider: 1, runtime: "box" })).digest("hex");
export const CLAUDE_PROVIDER_ID = "omnirush-claude";
/** Shown once at a Claude chat's start (phase 1: no permission asks inside the box). */
export const CLAUDE_AUTO_NOTE = "Claude runs in Auto mode inside the sandbox: it doesn't ask before changes yet.";

export function claudeNotAllowedMessage(name: string): string {
  return `${name} isn't available on your account yet.`;
}

export type ClaudeChatInput = { op?: unknown; sessionID?: unknown; model?: unknown; resume?: unknown; earlier?: unknown; uuid?: unknown; ok?: unknown; directory?: unknown };
export type ClaudeChatAnswer = { ok: true; token?: string; baseUrl?: string; client?: string } | { ok: false; message: string };

export function claudeChatRoute(deps: {
  access: () => Promise<ClaudeAccess>;
  authorize: (context: ClaudeAuthorization) => Promise<ClaudeGrant>;
  /** The chat's pinned model (the broker's one-model-per-chat pins), and pinning it. */
  pin: (sessionId: string) => string | null;
  setPin: (sessionId: string, model: string) => void;
  /** A model's display name (the account's catalog). */
  name?: (id: string) => string;
  onClaudeChat?: (info: { sessionID: string; model: string; grant: ClaudeGrant }) => void;
  onTurnEnd?: (info: { sessionID: string; uuid: string; ok: boolean; grant: ClaudeGrant | null }) => Promise<void> | void;
  log?: (level: "info" | "warn", message: string, attributes?: Record<string, unknown>) => void;
}) {
  const grants = new Map<string, ClaudeGrant>();
  const refuse = (message: string): ClaudeChatAnswer => ({ ok: false, message });
  return async function handle(input: ClaudeChatInput): Promise<ClaudeChatAnswer> {
    const sessionID = typeof input?.sessionID === "string" ? input.sessionID : "";
    if (!sessionID) return refuse("A Claude turn needs its chat.");
    if (input.op === "end") {
      try { await deps.onTurnEnd?.({ sessionID, uuid: String(input.uuid || ""), ok: input.ok === true, grant: grants.get(sessionID) ?? null }); } catch { /* best effort */ }
      return { ok: true };
    }
    if (input.op !== "grant") return refuse("Unknown Claude request.");
    const model = typeof input.model === "string" ? input.model : "";
    let account: ClaudeAccess;
    try { account = await deps.access(); } catch (error) { return refuse(error instanceof Error ? error.message : "Claude could not start."); }
    const entry = account.catalog?.find((e) => e.id === model);
    if (!entry) return refuse(`${model || "This model"} isn't offered here.`);
    const pinned = deps.pin(sessionID);
    // A chat keeps its model once it has replies: Claude in a chat that ran on another one is a new chat (the window
    // offers it). A chat with no reply yet is fresh (its only other request was its title, on the title model).
    if (input.earlier === true && input.resume !== true && pinned !== entry.id) {
      deps.log?.("info", "claude: picked in a chat on another model", {});
      return refuse(`This chat runs on ${pinned ? deps.name?.(pinned) ?? pinned : "another model"}. ${entry.name} starts in a new chat.`);
    }
    if (!account.models?.includes(entry.id)) return refuse(claudeNotAllowedMessage(entry.name));
    let grant: ClaudeGrant;
    try {
      const workspaceId = typeof input.directory === "string" && input.directory ? input.directory : sessionID;
      grant = await deps.authorize({ owner: account.owner, sessionId: sessionID, model: entry.id, workspaceId, contractSha256: CLAUDE_CONTRACT });
    } catch (error) {
      deps.log?.("warn", "claude: no relay token", { status: (error as { status?: unknown })?.status ?? null });
      return refuse(error instanceof Error ? error.message : "Claude could not start.");
    }
    if (pinned !== entry.id) deps.setPin(sessionID, entry.id);
    grants.set(sessionID, grant);
    while (grants.size > 256) grants.delete(grants.keys().next().value!);
    try { deps.onClaudeChat?.({ sessionID, model: entry.id, grant }); } catch { /* capture only */ }
    return { ok: true, token: grant.token, baseUrl: grant.baseUrl.replace(/\/+$/, ""), client: grant.client };
  };
}
