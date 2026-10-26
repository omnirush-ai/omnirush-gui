import { describe, expect, test } from "bun:test";

import { CLAUDE_CODE_VERSION, CLAUDE_CONTRACT, claudeChatRoute } from "./chat.js";
import type { ClaudeAccess, ClaudeAuthorization, ClaudeGrant } from "./access.js";
// @ts-expect-error The shared provider is plain JavaScript (opencode-plugins/claude-provider, PARITY with the CLI).
import { CLAUDE_CODE_VERSION as PROVIDER_VERSION, CONTRACT as PROVIDER_CONTRACT } from "../opencode-plugins/claude-provider/index.js";

const catalog = [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }];
const account = (models: string[]): ClaudeAccess => ({ owner: "u1", models, catalog, reason: models.length ? null : "not_allowed" });

function route(models: string[], pins = new Map<string, string>()) {
  const asked: ClaudeAuthorization[] = [];
  const marked: string[] = [];
  const handle = claudeChatRoute({
    access: async () => account(models),
    authorize: async (context) => {
      asked.push(context);
      return { owner: context.owner, sessionId: context.sessionId, model: context.model, token: "orc_x", baseUrl: "https://omnirush.ai/claude/", client: "desktop/3.8.0", bindingId: "b", contractSha256: context.contractSha256, upstreamModel: context.model, budget: { status: "unknown", model: context.model } } as ClaudeGrant;
    },
    pin: (id) => pins.get(id) ?? null,
    setPin: (id, model) => pins.set(id, model),
    onClaudeChat: ({ sessionID }) => marked.push(sessionID),
  });
  return { handle, asked, marked, pins };
}

describe("Claude turn route", () => {
  test("the contract is the provider's own", () => {
    expect(CLAUDE_CODE_VERSION).toBe(PROVIDER_VERSION);
    expect(CLAUDE_CONTRACT).toBe(PROVIDER_CONTRACT);
  });

  test("a new chat gets its relay token, bound to the chat, and is pinned to Claude", async () => {
    const r = route(["claude-opus-5-5"]);
    expect(await r.handle({ op: "grant", sessionID: "ses_a", model: "claude-opus-5-5", resume: false, earlier: false, directory: "/p" }))
      .toEqual({ ok: true, token: "orc_x", baseUrl: "https://omnirush.ai/claude", client: "desktop/3.8.0" });
    expect(r.asked).toEqual([{ owner: "u1", sessionId: "ses_a", model: "claude-opus-5-5", workspaceId: "/p", contractSha256: CLAUDE_CONTRACT }]);
    expect(r.pins.get("ses_a")).toBe("claude-opus-5-5");
    expect(r.marked).toEqual(["ses_a"]);
  });

  test("an account without access is told plainly, and no token is asked", async () => {
    const r = route([]);
    expect(await r.handle({ op: "grant", sessionID: "ses_a", model: "claude-opus-5-5" })).toEqual({ ok: false, message: "Claude Opus 5.5 isn't available on your account yet." });
    expect(r.asked).toEqual([]);
  });

  test("one model per chat: a chat on another model, or with earlier turns and no transcript, starts Claude in a new chat", async () => {
    const r = route(["claude-opus-5-5"], new Map([["ses_astra", "gpt-6-astra"], ["ses_titled", "gpt-6-astra"]]));
    expect(await r.handle({ op: "grant", sessionID: "ses_astra", model: "claude-opus-5-5", earlier: true })).toMatchObject({ ok: false, message: "This chat runs on gpt-6-astra. Claude Opus 5.5 starts in a new chat." });
    // No reply yet (its title ran on the title model first): still a fresh chat, now pinned to Claude.
    expect(await r.handle({ op: "grant", sessionID: "ses_titled", model: "claude-opus-5-5", earlier: false })).toMatchObject({ ok: true });
    expect(r.pins.get("ses_titled")).toBe("claude-opus-5-5");
    expect(await r.handle({ op: "grant", sessionID: "ses_old", model: "claude-opus-5-5", earlier: true, resume: false })).toMatchObject({ ok: false });
    // A resumed Claude chat (its transcript is there) goes on.
    expect(await r.handle({ op: "grant", sessionID: "ses_old", model: "claude-opus-5-5", earlier: true, resume: true })).toMatchObject({ ok: true });
    expect(r.asked.map((a) => a.sessionId)).toEqual(["ses_titled", "ses_old"]);
  });

  test("end reports the turn with the chat's grant; unknown ops and models are refused", async () => {
    const ends: unknown[] = [];
    const handle = claudeChatRoute({
      access: async () => account(["claude-opus-5-5"]),
      authorize: async (c) => ({ owner: c.owner, sessionId: c.sessionId, model: c.model, token: "t", baseUrl: "https://x", client: "c", bindingId: "b", contractSha256: c.contractSha256, upstreamModel: c.model, budget: { status: "unknown", model: c.model } }),
      pin: () => null, setPin: () => undefined,
      onTurnEnd: (info) => { ends.push({ ...info, grant: info.grant?.token ?? null }); },
    });
    await handle({ op: "grant", sessionID: "ses_a", model: "claude-opus-5-5" });
    expect(await handle({ op: "end", sessionID: "ses_a", uuid: "u", ok: true })).toEqual({ ok: true });
    expect(ends).toEqual([{ sessionID: "ses_a", uuid: "u", ok: true, grant: "t" }]);
    expect(await handle({ op: "nope", sessionID: "ses_a" })).toMatchObject({ ok: false });
    expect(await handle({ op: "grant", sessionID: "ses_a", model: "gpt-6-astra" })).toMatchObject({ ok: false });
    expect(await handle({ op: "grant", model: "claude-opus-5-5" })).toMatchObject({ ok: false });
  });
});
