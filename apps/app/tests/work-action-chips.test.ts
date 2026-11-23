// Fixes offered under the newest Work answer (design 3.4, judge M5, M10). The 2.x cases run the tool parts the pinned
// 2.x engine stored in the lane B rig (tests/fixtures/work-tool-errors.ts) through the app's own 2.x client and part
// parser; the other read paths (a kept MCP result, a result passed on as output) and the older-server cases are built here.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DynamicToolUIPart, UIMessage } from "ai";
import type { ToolPart } from "@opencode-ai/sdk/v2/client";

import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import type { OmniRushWorkConnector } from "../src/app/lib/omnirush-server";
import { parseDynamicToolUIPart } from "../src/react-app/domains/session/sync/parse-tool-parts";
import {
  actionChipSpecs,
  ACTION_CHIPS_MAX,
  lastTurnSignals,
  NO_SIGNALS,
  toolConnector,
  waitSeconds,
  workToolError,
  type TurnSignals,
} from "../src/react-app/domains/work/ask/action-chips";
import { lastAnswerReplies } from "../src/react-app/domains/work/ask/replies";
import { capturedV2Messages, type CapturedCase } from "./fixtures/work-tool-errors";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** A captured turn as the app shows it: the engine's answer through the 2.x client, its tool part through the parser. */
async function capturedTurn(name: CapturedCase): Promise<UIMessage[]> {
  const items = capturedV2Messages[name];
  // As the engine answered (newest first).
  globalThis.fetch = async () => Response.json({ data: items });
  const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
  const result = await client.session.messages({ sessionID: "ses_captured" });
  const messages = result.data ?? [];
  expect(messages.length).toBeGreaterThan(0);
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Do it" }] },
    ...messages.filter((message) => message.info.role === "assistant").map((message): UIMessage => ({
      id: message.info.id,
      role: "assistant",
      metadata: { opencode: { created: message.info.time.created, ...("completed" in message.info.time ? { completed: message.info.time.completed } : {}) } },
      parts: message.parts.flatMap((part): UIMessage["parts"] => {
        if (part.type === "tool") {
          const ui = parseDynamicToolUIPart(part as ToolPart);
          return ui ? [ui] : [];
        }
        return part.type === "text" ? [{ type: "text", text: part.text }] : [];
      }),
    })),
  ];
}

const connector = (id: string, action: "reconnect" | "retry" | null, label = id): OmniRushWorkConnector => ({
  id, label, status: action === "reconnect" ? "error" : "connected", last_sync_at: null, records: 1, sync_enabled: true,
  attention: action ? { kind: action === "reconnect" ? "reconnect" : "failing", message: "", action, since: null } : null,
});

const errorPart = (toolName: string, body: Record<string, unknown>, via: "errorText" | "mcpResult" | "output" = "errorText"): DynamicToolUIPart => {
  const text = JSON.stringify(body);
  if (via === "errorText") return { type: "dynamic-tool", toolName, toolCallId: `c-${toolName}`, state: "output-error", input: {}, errorText: text };
  if (via === "output") return { type: "dynamic-tool", toolName, toolCallId: `c-${toolName}`, state: "output-available", input: {}, output: text };
  return {
    type: "dynamic-tool", toolName, toolCallId: `c-${toolName}`, state: "output-available", input: {}, output: text,
    callProviderMetadata: { omnirush: { mcpResult: { content: [{ type: "text", text }], structuredContent: body, isError: true } } },
  };
};
const turn = (...parts: DynamicToolUIPart[]): UIMessage[] => [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Do it" }] },
  { id: "a1", role: "assistant", metadata: { opencode: { created: 1_000_000, completed: 1_002_000 } }, parts: [...parts, { type: "text", text: "Done." }] },
];
const specs = (parts: DynamicToolUIPart[], live: Parameters<typeof actionChipSpecs>[1] = {}) => actionChipSpecs(lastTurnSignals(turn(...parts)), live);

describe("captured from the 2.x engine (the error text path)", () => {
  test("needs_install: Install on the owner, with the setup link", async () => {
    const messages = await capturedTurn("needs_install");
    const signals = lastTurnSignals(messages);
    expect(signals.errors.map((error) => [error.code, error.tool, error.connector])).toEqual([["needs_install", "omnirush-work_github_comment", "github"]]);
    expect(actionChipSpecs(signals)).toEqual([{ id: "link:needs_install:https://github.com/apps/wee-work-app/installations/new", kind: "link", code: "needs_install", url: "https://github.com/apps/wee-work-app/installations/new", owner: "openfreight", repo: "openfreight/community" }]);
    // The answer after the refusal, as the engine stored it, ends with the agent's own reply.
    expect(lastAnswerReplies(messages)).toEqual(["Keep it as a draft"]);
  });

  test("writes_paused: Resume actions, then Try again once the live settings say they are on", async () => {
    const signals = lastTurnSignals(await capturedTurn("writes_paused"));
    expect(signals.errors.map((error) => error.code)).toEqual(["writes_paused"]);
    expect(actionChipSpecs(signals).map((chip) => chip.kind)).toEqual(["resume"]);
    expect(actionChipSpecs(signals, { writesPaused: true }).map((chip) => chip.kind)).toEqual(["resume"]);
    expect(actionChipSpecs(signals, { writesPaused: false })).toEqual([{ id: "retry", kind: "retry", readyAt: null }]);
  });

  test("reconnect_required: chips only for connectors the live list says need it; none once it is fixed", async () => {
    const signals = lastTurnSignals(await capturedTurn("reconnect_required"));
    expect(signals.errors.map((error) => [error.code, error.connector])).toEqual([["reconnect_required", "google"]]);
    expect(actionChipSpecs(signals)).toEqual([]);
    expect(actionChipSpecs(signals, { connectors: [connector("slack", "reconnect"), connector("google", "reconnect", "Google (Gmail, Drive, Calendar)")] }).map((chip) => chip.id))
      .toEqual(["reconnect:google", "reconnect:slack"]);
    expect(actionChipSpecs(signals, { connectors: [connector("google", null), connector("notion", "retry")] })).toEqual([]);
  });

  test("rate_limited: Try again once the wait the detail names is over", async () => {
    const messages = await capturedTurn("rate_limited");
    const signals = lastTurnSignals(messages);
    expect(signals.errors.map((error) => [error.code, error.detail])).toEqual([["rate_limited", "retry after 45s"]]);
    const at = signals.errors[0]!.at!;
    expect(at).toBeGreaterThan(1_700_000_000_000);
    expect(actionChipSpecs(signals)).toEqual([{ id: "retry", kind: "retry", readyAt: at + 45_000 }]);
  });

  test("a good result carrying notices: Reconnect from the live list, never from the notice text", async () => {
    const signals = lastTurnSignals(await capturedTurn("notices"));
    expect(signals).toMatchObject({ errors: [], notices: true });
    expect(actionChipSpecs(signals, { connectors: [connector("google", "reconnect")] }).map((chip) => chip.id)).toEqual(["reconnect:google"]);
    expect(actionChipSpecs(signals, { connectors: [connector("google", null)] })).toEqual([]);
  });
});

describe("every read path and every row of the table", () => {
  const install = { owner: "acme", repo: "acme/site", setup_url: "https://github.com/apps/x/installations/new", error: "needs_install", detail: "Not installed" };

  test("the same refusal from a kept MCP result, the output text or the error text", () => {
    for (const via of ["mcpResult", "output", "errorText"] as const) {
      expect(workToolError(errorPart("omnirush-work_github_comment", install, via))).toEqual({ code: "needs_install", detail: "Not installed", extra: { owner: "acme", repo: "acme/site", setup_url: "https://github.com/apps/x/installations/new" } });
    }
    // An engine line around the body.
    expect(workToolError({ ...errorPart("omnirush-work_github_comment", install), errorText: `Error: ${JSON.stringify(install)}` })?.code).toBe("needs_install");
  });

  test("GitHub: install, review access, add the repository; no link, no chip", () => {
    expect(specs([errorPart("omnirush-work_github_comment", install)]).map((chip) => chip.kind)).toEqual(["link"]);
    expect(specs([errorPart("omnirush-work_github_comment", { ...install, error: "needs_permission" })])).toMatchObject([{ kind: "link", code: "needs_permission" }]);
    expect(specs([errorPart("omnirush-work_github_comment", { ...install, error: "repo_not_installed" })])).toMatchObject([{ kind: "link", code: "repo_not_installed", repo: "acme/site" }]);
    // An older server sends no setup_url; a link that is not https is never opened.
    const { setup_url: _drop, ...noLink } = install;
    expect(specs([errorPart("omnirush-work_github_comment", noLink)])).toEqual([]);
    expect(specs([errorPart("omnirush-work_github_comment", { ...install, setup_url: "javascript:alert(1)" })])).toEqual([]);
  });

  test("not connected: Connect that connector (the detail names it)", () => {
    expect(specs([errorPart("omnirush-work_slack_post", { error: "not_connected", detail: "slack" })])).toEqual([{ id: "connect:slack", kind: "connect", connector: "slack" }]);
  });

  test("access refusals from a connector's tool: Open it in Connectors; the app's own tools get none", () => {
    for (const code of ["missing_permission", "permission_denied", "shopify_scope_missing", "bot_no_access", "message_content_off"]) {
      expect(specs([errorPart("omnirush-work_gmail_send", { error: code, detail: "x" })])).toEqual([{ id: "connectors:google", kind: "connectors", connector: "google" }]);
    }
    expect(specs([errorPart("omnirush-work_work_remember", { error: "permission_denied", detail: "x" })])).toEqual([]);
  });

  test("limits: Try again after the named wait, else a minute; a failed tool: Try again now", () => {
    expect(specs([errorPart("omnirush-work_gmail_search", { error: "rate_limited", detail: "retry after 12s" })])).toEqual([{ id: "retry", kind: "retry", readyAt: 1_002_000 + 12_000 }]);
    for (const code of ["too_many_requests", "too_many_searches", "too_soon", "too_many_asks"]) {
      expect(specs([errorPart("omnirush-work_work_search", { error: code, detail: "try again in a minute" })])).toEqual([{ id: "retry", kind: "retry", readyAt: 1_002_000 + 60_000 }]);
    }
    expect(specs([errorPart("omnirush-work_work_search", { error: "tool_failed" })])).toEqual([{ id: "retry", kind: "retry", readyAt: null }]);
  });

  test("the daily ask budget, an unknown code, a provider error and a non-Work tool: no chip, no crash", () => {
    expect(specs([errorPart("omnirush-work_work_count", { error: "ask_budget", detail: "resets at UTC midnight" })])).toEqual([]);
    expect(specs([errorPart("omnirush-work_gmail_send", { error: "something_new", detail: null })])).toEqual([]);
    expect(specs([errorPart("omnirush-work_gmail_send", { error: "provider_error", detail: "500: boom" })])).toEqual([]);
    expect(specs([errorPart("bash", { error: "tool_failed" })])).toEqual([]);
    expect(workToolError({ type: "dynamic-tool", toolName: "omnirush-work_gmail_send", toolCallId: "x", state: "output-error", input: {}, errorText: "MCP error -32602: unknown tool" })).toBeNull();
    expect(workToolError({ type: "dynamic-tool", toolName: "omnirush-work_gmail_send", toolCallId: "x", state: "output-error", input: {}, errorText: "{not json" })).toBeNull();
    // A successful result is never read as a refusal, even with an "error" field among others.
    expect(workToolError({ type: "dynamic-tool", toolName: "omnirush-work_work_search", toolCallId: "x", state: "output-available", input: {}, output: JSON.stringify({ items: [], error: "none_found", total: 0 }) })).toBeNull();
  });

  test("at most two fixes, the most specific first", () => {
    const chips = specs([
      errorPart("omnirush-work_work_search", { error: "tool_failed" }),
      errorPart("omnirush-work_github_comment", { error: "writes_paused", detail: "Actions are paused." }),
      errorPart("omnirush-work_slack_post", { error: "not_connected", detail: "slack" }),
      errorPart("omnirush-work_github_comment", install),
    ]);
    expect(chips.map((chip) => chip.kind)).toEqual(["link", "connect"]);
    expect(chips).toHaveLength(ACTION_CHIPS_MAX);
  });

  test("only the newest turn counts, and only while an answer is the newest message", () => {
    const messages = turn(errorPart("omnirush-work_github_comment", install));
    expect(lastTurnSignals([...messages, { id: "u2", role: "user", parts: [{ type: "text", text: "Ok" }] }])).toBe(NO_SIGNALS);
    const later: UIMessage[] = [...messages, { id: "u2", role: "user", parts: [{ type: "text", text: "Ok" }] }, { id: "a2", role: "assistant", parts: [{ type: "text", text: "Fine." }] }];
    expect(lastTurnSignals(later)).toBe(NO_SIGNALS);
    expect(lastTurnSignals([...messages, { id: "session-error:1", role: "assistant", parts: [{ type: "text", text: "Failed" }] }])).toBe(NO_SIGNALS);
    const empty: TurnSignals = lastTurnSignals([]);
    expect(empty).toBe(NO_SIGNALS);
  });
});

describe("helpers", () => {
  test("a tool's connector from its name", () => {
    expect(toolConnector("omnirush-work_gmail_send")).toBe("google");
    expect(toolConnector("omnirush-work_teams_post")).toBe("microsoft");
    expect(toolConnector("omnirush-work_qbo_query")).toBe("quickbooks");
    expect(toolConnector("omnirush-work_monday_search")).toBe("monday");
    expect(toolConnector("omnirush-work_work_context")).toBeNull();
    expect(toolConnector("bash")).toBeNull();
  });

  test("the wait from a rate limit's detail", () => {
    expect(waitSeconds("retry after 45s")).toBe(45);
    expect(waitSeconds("retry after 2.5 s")).toBe(3);
    expect(waitSeconds("try again in a minute")).toBe(60);
    expect(waitSeconds(null)).toBe(60);
  });

  test("en and zh carry every work.replies key; the English copy has no dashes", () => {
    const en = readFileSync(new URL("../src/i18n/locales/en.ts", import.meta.url), "utf8");
    const zh = readFileSync(new URL("../src/i18n/locales/zh.ts", import.meta.url), "utf8");
    const keys = [...en.matchAll(/"(work\.replies\.[a-z_]+)": "([^"]*)"/g)];
    expect(keys.length).toBeGreaterThanOrEqual(13);
    for (const [, key, value] of keys) {
      expect(zh).toContain(`"${key}"`);
      expect(value).not.toMatch(/[–—]/);
    }
  });
});
