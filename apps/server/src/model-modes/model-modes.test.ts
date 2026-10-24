// Per-model modes on the desktop: the shared rules (PARITY.sha256, the same
// files in omnirush-cli src/model-modes/), the catalog keeping `modes`, and
// the gateway broker's X-OmniRush-Box, local refusal, plain message and
// sub-agent fallback for model_not_in_mode.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { OmniRushGatewayBroker } from "../omnirush-gateway-broker.js";
import { sanitizeOmniRushModelCatalog } from "../omnirush-model-catalog.js";
import { modelAllowedIn, modelForMode, modelModes, notInModeMessage, projectMode } from "./model-modes.mjs";

const CATALOG = sanitizeOmniRushModelCatalog({
  data: [
    { id: "gpt-6-astra", display_name: "GPT 6 Astra", default: true },
    { id: "kimi-k3.1-pro", display_name: "Kimi K3.1 Pro", family: "Kimi", modes: ["native"] },
  ],
})!;
const REFUSAL = { detail: "model_not_in_mode", error: { type: "invalid_request_error", code: "model_not_in_mode", message: "This model isn't available in sandbox projects.", omnirush: { code: "model_not_in_mode", retry: false } } };

type Call = { model: unknown; box: string | null; path: string };

function broker(calls: Call[], answer: (call: Call) => Response = () => Response.json({ output: [] }), modeCheck = true) {
  return new OmniRushGatewayBroker({
    credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
    engineToken: "local-engine-token",
    ...(modeCheck ? { modelInMode: (model: string, box: boolean) => { const entry = CATALOG.find((m) => m.id === model); return !entry || modelAllowedIn(entry, projectMode(box)); } } : {}),
    subagentRetryDelayMs: 1,
    fetch: async (input, init) => {
      const raw = init?.body;
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
      const call = { model: JSON.parse(text).model, box: new Headers(init?.headers).get("x-omnirush-box"), path: new URL(String(input)).pathname };
      calls.push(call);
      return answer(call);
    },
  });
}

const request = (body: Record<string, unknown>, headers: Record<string, string> = {}, route = "responses") => new Request(`http://127.0.0.1/omnirush-gateway/v1/${route}`, {
  method: "POST",
  headers: { Authorization: "Bearer local-engine-token", "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("model modes", () => {
  test("CLI/desktop parity: model-modes/PARITY.sha256 matches its files", () => {
    const rows = readFileSync(path.join(import.meta.dir, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
    expect(rows.map((row) => row.split(/\s+/)[1])).toEqual(["model-modes.mjs", "model-modes.d.mts", "strict-sessions.mjs", "strict-sessions.d.mts"]);
    for (const row of rows) {
      const [hash, name] = row.split(/\s+/);
      const actual = createHash("sha256").update(readFileSync(path.join(import.meta.dir, name ?? ""))).digest("hex");
      expect(`${name} ${actual}`).toBe(`${name} ${hash}`);
    }
  });

  test("rules: absent means both; a list names what it allows; a refused pick moves to the allowed default", () => {
    expect(modelModes({ id: "a" })).toEqual(["native", "box"]);
    expect(modelModes({ id: "a", modes: ["native"] })).toEqual(["native"]);
    expect(modelForMode(CATALOG, "box", "kimi-k3.1-pro")).toMatchObject({ model: "gpt-6-astra", note: "Kimi K3.1 Pro isn't available in sandbox projects. Using GPT 6 Astra here." });
    expect(modelForMode(CATALOG, "native", "kimi-k3.1-pro")).toMatchObject({ model: "kimi-k3.1-pro", note: null });
  });

  test("the catalog keeps modes only when the backend lists them", () => {
    expect("modes" in CATALOG[0]!).toBe(false);
    expect(CATALOG[1]!.modes).toEqual(["native"]);
  });

  test("broker: a box chat's requests say so, its later unmarked ones too; native ones never", async () => {
    const calls: Call[] = [];
    const b = broker(calls);
    await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_box", "x-omnirush-box": "1" }), "responses");
    // The same chat's compaction without the mark (and a sub-agent naming it as its main chat).
    await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_box" }, "responses/compact"), "responses/compact");
    await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_child", "x-parent-session-id": "ses_box" }), "responses");
    await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_native" }), "responses");
    expect(calls.map((c) => [c.path, c.box])).toEqual([
      ["/omnirush/v1/responses", "1"],
      ["/omnirush/v1/responses/compact", "1"],
      ["/omnirush/v1/responses", "1"],
      ["/omnirush/v1/responses", null],
    ]);
  });

  test("broker: a model outside the chat's mode is refused here, never sent, in plain words", async () => {
    const calls: Call[] = [];
    const response = await broker(calls).handle(request({ model: "kimi-k3.1-pro" }, { "x-omnirush-session-id": "ses_box", "x-omnirush-box": "1" }), "responses");
    expect(calls).toEqual([]);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("model_not_in_mode");
    expect(body.error.message).toBe(notInModeMessage("box"));
    // Native: Kimi goes out.
    expect((await broker(calls).handle(request({ model: "kimi-k3.1-pro" }, { "x-omnirush-session-id": "ses_n" }), "responses")).status).toBe(200);
  });

  test("broker: the gateway's model_not_in_mode keeps its words", async () => {
    const calls: Call[] = [];
    const response = await broker(calls, () => Response.json(REFUSAL, { status: 400, headers: { "x-should-retry": "false" } }), false)
      .handle(request({ model: "kimi-k3.1-pro" }, { "x-omnirush-box": "1" }), "responses");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe("This model isn't available in sandbox projects.");
  });

  test("broker: all context-bearing requests and children inherit the chat model", async () => {
    const calls: Call[] = [];
    const b = broker(calls, undefined, false);
    const tools = [{ type: "function", name: "bash" }];
    expect((await b.handle(request({ model: "kimi-k3.1-pro", tools }, { "x-omnirush-session-id": "ses_one" }), "responses")).status).toBe(200);
    const refused = await b.handle(request({ model: "gpt-6-astra", tools }, { "x-omnirush-session-id": "ses_one" }), "responses");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "session_model_fixed", message: "This chat runs on kimi-k3.1-pro. Start a new chat to use gpt-6-astra." });
    expect((await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_one" }), "responses")).status).toBe(400);
    expect((await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_one" }, "responses/compact"), "responses/compact")).status).toBe(400);
    expect((await b.handle(request({}, { "x-omnirush-session-id": "ses_one" }, "responses/compact"), "responses/compact")).status).toBe(400);
    expect((await b.handle(request({ model: "gpt-6-astra", tools }, { "x-omnirush-session-id": "ses_child", "x-parent-session-id": "ses_one" }), "responses")).status).toBe(400);
    expect((await b.handle(request({ model: "kimi-k3.1-pro" }, { "x-omnirush-session-id": "ses_child", "x-parent-session-id": "ses_one" }), "responses")).status).toBe(200);
    expect((await b.handle(request({ model: "gpt-6-astra", tools }, { "x-omnirush-session-id": "unknown_child", "x-parent-session-id": "unseen" }), "responses")).status).toBe(400);
    expect((await b.handle(request({ model: "kimi-k3.1-pro" }, { "x-omnirush-session-id": "ses_one" }, "responses/compact"), "responses/compact")).status).toBe(200);
    expect((await b.handle(request({ model: "gpt-6-astra", tools }, { "x-omnirush-session-id": "ses_two" }), "responses")).status).toBe(200);
    expect(calls.map((c) => c.model)).toEqual(["kimi-k3.1-pro", "kimi-k3.1-pro", "kimi-k3.1-pro", "gpt-6-astra"]);
  });

  test("broker: a new process keeps saved model pins and refuses corrupt pins", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "model-pins-"));
    const file = path.join(dir, "chat-models.json");
    const calls: string[] = [];
    const make = () => new OmniRushGatewayBroker({sessionModelsFile: file, credentials: {gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "fixture", refreshToken: "fixture"}, engineToken: "local-engine-token", fetch: async () => {calls.push("upstream"); return Response.json({output: []});}});
    try {
      expect((await make().handle(request({model: "gpt-6-astra"}, {"x-omnirush-session-id": "persisted"}), "responses")).status).toBe(200);
      const resumed = make();
      expect((await resumed.handle(request({model: "gpt-6-sol"}, {"x-omnirush-session-id": "persisted"}), "responses")).status).toBe(400);
      expect((await resumed.handle(request({model: "gpt-6-astra"}, {"x-omnirush-session-id": "child", "x-parent-session-id": "persisted"}), "responses")).status).toBe(200);
      expect(calls).toHaveLength(2);
      writeFileSync(file, "not-json");
      expect(make).toThrow();
    } finally {rmSync(dir, {recursive: true, force: true});}
  });

  test("broker: a fallback cannot change a session that has already requested another model", async () => {
    const calls: Call[] = [];
    const response = await broker(calls, (call) => call.model === "kimi-k3.1-pro" ? Response.json(REFUSAL, { status: 400, headers: { "x-should-retry": "false" } }) : Response.json({ output: [] }), false)
      .handle(request({ model: "kimi-k3.1-pro" }, { "x-omnirush-box": "1", "x-omnirush-session-id": "ses_sub", "x-omnirush-subagent-fallback-model": "gpt-6-astra" }), "responses");
    expect(response.status).toBe(400);
    expect(calls.map((c) => c.model)).toEqual(["kimi-k3.1-pro"]);
  });

  test("broker: cooldown cannot rewrite a pinned child's requested model before validation", async () => {
    const calls: string[] = [];
    const b = new OmniRushGatewayBroker({credentials: {gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "fixture", refreshToken: "fixture"}, engineToken: "local-engine-token", subagentModelRefused: () => true, fetch: async (_input, init) => {calls.push(JSON.parse(typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as ArrayBuffer)).model); return Response.json({output: []});}});
    expect((await b.handle(request({model: "gpt-6-astra"}, {"x-omnirush-session-id": "root"}), "responses")).status).toBe(200);
    expect((await b.handle(request({model: "gpt-6-sol"}, {"x-omnirush-session-id": "child", "x-parent-session-id": "root", "x-omnirush-subagent-fallback-model": "gpt-6-astra"}), "responses")).status).toBe(400);
    expect(calls).toEqual(["gpt-6-astra"]);
  });

  test("broker: a chat's title goes on the chat's model, whatever small model the engine picked", async () => {
    const calls: Call[] = [];
    const b = broker(calls, undefined, false);
    const tools = [{ type: "function", name: "bash" }];
    const title = { "x-omnirush-title": "1", "x-omnirush-chat-model": "kimi-k3.1-pro" };
    // A new chat's title first: it takes the model the chat's prompt names, and pins it.
    expect((await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_t", ...title }), "responses")).status).toBe(200);
    expect((await b.handle(request({ model: "kimi-k3.1-pro", tools }, { "x-omnirush-session-id": "ses_t" }), "responses")).status).toBe(200);
    expect((await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_t", ...title }), "responses")).status).toBe(200);
    // Unmarked, another model is still refused.
    expect((await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_t" }), "responses")).status).toBe(400);
    expect(calls.map((c) => c.model)).toEqual(["kimi-k3.1-pro", "kimi-k3.1-pro", "kimi-k3.1-pro"]);
  });

  test("broker: strict sessions (observe) bind once before a chat's first agent request; conflicts and verification stop here; failures never block", async () => {
    type Bind = Record<string, unknown>;
    const binds: Bind[] = [];
    const sent: { session: string | null; strict: string | null }[] = [];
    const bound = new Map<string, { model: string; mode: string }>([["ses_other", { model: "kimi-k3.1-pro", mode: "native" }]]);
    let strictOn = false;
    const tools = [{ type: "function", name: "bash" }];
    const pins = path.join(mkdtempSync(path.join(tmpdir(), "strict-pins-")), "chat-models.json");
    writeFileSync(pins, JSON.stringify({ ses_lost: "gpt-6-astra" }));
    const b = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
      engineToken: "local-engine-token",
      chatPin: (id) => (id === "ses_lost" ? { box: true, revision: "lb1:0123456789ab" } : null),
      // A chat pinned here in an earlier run that the server never bound (its child meets session_unknown_parent).
      sessionModelsFile: pins,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        if (url.pathname === "/omnirush/collect/capabilities") return Response.json({ schema_versions: [1, 2, 3], ...(strictOn ? { strict_sessions: { mode: "observe", bind: true, path: "/omnirush/device/session-binding", header: "X-OmniRush-Strict-Session", implicit: true } } : {}) });
        if (url.pathname === "/omnirush/device/session-binding") {
          const body = JSON.parse(String(init?.body)) as Bind & { session_id: string; parent_session_id?: string; model: string; mode: string };
          binds.push(body);
          if (body.session_id === "ses_down") throw new TypeError("fetch failed");
          if (body.session_id === "ses_verify") return Response.json({ detail: "verification_required" }, { status: 403 });
          if (body.session_id === "ses_claude") return Response.json({ detail: "use_claude_token" }, { status: 400 });
          if (body.session_id === "ses_used400") return Response.json({ detail: "session_model_used", models_used: ["kimi-k3.1-pro"] }, { status: 400 });
          if (body.session_id === "ses_used") return Response.json({ detail: "session_model_used", models_used: ["kimi-k3.1-pro"] }, { status: 409 });
          const root = body.parent_session_id ? bound.get(body.parent_session_id) : null;
          if (body.parent_session_id && !root) return Response.json({ detail: "session_unknown_parent" }, { status: 409 });
          const binding = bound.get(body.session_id) ?? root ?? { model: body.model, mode: body.mode };
          if (binding.model !== body.model || binding.mode !== body.mode) return Response.json({ detail: "session_binding_conflict", binding }, { status: 409 });
          bound.set(body.session_id, binding);
          return Response.json({ binding: { ...binding, session_id: body.session_id }, enforcement: "enforce", kept: [], ...(body.session_id === "ses_late" ? { bound_late: true } : {}) });
        }
        sent.push({ session: headers.get("x-omnirush-session-id"), strict: headers.get("x-omnirush-strict-session") });
        if (headers.get("x-omnirush-session-id") === "ses_gwused") return Response.json({ models_used: ["gpt-6.1-sol"], detail: "session_model_used", error: { type: "invalid_request_error", code: "session_model_used", message: "This chat already ran on another model. Start a new chat to use this one.", omnirush: { code: "session_model_used", retry: false } } }, { status: 400, headers: { "x-should-retry": "false" } });
        if (headers.get("x-omnirush-session-id") === "ses_gw") return Response.json({ detail: "mode_not_bound", error: { type: "invalid_request_error", code: "mode_not_bound", message: "This chat runs in a normal project. Start a new chat to change the project mode.", omnirush: { code: "mode_not_bound", retry: false } } }, { status: 400, headers: { "x-should-retry": "false" } });
        return Response.json({ output: [] });
      },
    });
    const post = (session: string, extra: Record<string, string> = {}, body: Record<string, unknown> = { model: "omnirush/gpt-6-astra", tools }) => b.handle(request(body, { "x-omnirush-session-id": session, ...extra }), "responses");
    // An older server (no strict_sessions): no bind, no header.
    await b.sessionUploadCapabilities();
    expect((await post("ses_off")).status).toBe(200);
    expect(binds).toEqual([]);
    expect(sent).toEqual([{ session: "ses_off", strict: null }]);
    strictOn = true;
    b.resetCapabilities();
    await b.sessionUploadCapabilities();
    // A root binds once; every request of the chat says it is strict, titles and compactions too.
    expect((await post("ses_root")).status).toBe(200);
    expect((await post("ses_root")).status).toBe(200);
    expect((await post("ses_root", {}, { model: "gpt-6-astra" })).status).toBe(200);
    expect((await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_root" }, "responses/compact"), "responses/compact")).status).toBe(200);
    expect(binds).toEqual([{ session_id: "ses_root", model: "gpt-6-astra", mode: "native" }]);
    expect(sent.slice(1).map((s) => s.strict)).toEqual(["1", "1", "1", "1"]);
    // A sub-agent names its root.
    expect((await post("ses_child", { "x-parent-session-id": "ses_root" })).status).toBe(200);
    expect(binds.at(-1)).toMatchObject({ session_id: "ses_child", parent_session_id: "ses_root" });
    // A root the server does not know: bound first, then the child once more.
    binds.length = 0;
    expect((await post("ses_kid2", { "x-parent-session-id": "ses_lost", "x-omnirush-box": "1" })).status).toBe(200);
    expect(binds.map((x) => [x.session_id, x.parent_session_id ?? null, x.mode, x.revision ?? null])).toEqual([["ses_kid2", "ses_lost", "box", "lb1:0123456789ab"], ["ses_lost", null, "box", "lb1:0123456789ab"], ["ses_kid2", "ses_lost", "box", "lb1:0123456789ab"]]);
    // Conflicts and verification: refused here, never sent.
    const before = sent.length;
    const conflict = await post("ses_other");
    expect(conflict.status).toBe(400);
    expect(conflict.headers.get("x-should-retry")).toBe("false");
    expect(((await conflict.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "session_binding_conflict", message: "This chat runs on kimi-k3.1-pro. Start a new chat to use gpt-6-astra." });
    const used = await post("ses_used");
    expect(((await used.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "session_model_used", message: "This chat already ran on kimi-k3.1-pro. Start a new chat to use gpt-6-astra." });
    expect(((await (await post("ses_used400")).json()) as { error: { code: string } }).error.code).toBe("session_model_used");
    const verify = await post("ses_verify");
    expect(verify.status).toBe(403);
    expect(((await verify.json()) as { error: { code: string } }).error.code).toBe("verification_required");
    expect(sent.length).toBe(before);
    // A late bind and a Claude chat are settled; a network failure never blocks and is tried again.
    binds.length = 0;
    for (const id of ["ses_late", "ses_late", "ses_claude", "ses_claude"]) expect((await post(id)).status).toBe(200);
    expect(binds.map((x) => x.session_id)).toEqual(["ses_late", "ses_claude"]);
    binds.length = 0;
    expect((await post("ses_down")).status).toBe(200);
    expect((await post("ses_down")).status).toBe(200);
    expect(binds.length).toBe(2);
    // The gateway's mode_not_bound: final, its words kept.
    const held = await post("ses_gw");
    expect(held.status).toBe(400);
    expect(held.headers.get("x-should-retry")).toBe("false");
    expect(((await held.json()) as { error: { message: string } }).error.message).toBe("This chat runs in a normal project. Start a new chat to change the project mode.");
    const gwUsed = await post("ses_gwused");
    expect(gwUsed.status).toBe(400);
    expect(gwUsed.headers.get("x-should-retry")).toBe("false");
    expect(((await gwUsed.json()) as { error: { message: string } }).error.message).toBe("This chat already ran on another model. Start a new chat to use this one.");
  });

  test("broker: strict sessions under enforce fail closed: a capabilities outage, a bind timeout or a 5xx sends nothing upstream", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "strict-enforce-"));
    const strictStateFile = path.join(dir, "strict-sessions.json");
    const upstream: string[] = [];
    const binds: Record<string, unknown>[] = [];
    let caps: "enforce" | "down" = "enforce";
    let bindAnswer: "timeout" | "5xx" | "ok" = "timeout";
    const pins = new Map<string, { box: boolean; revision: string | null; capturePolicy?: string }>();
    const stored: [string, string][] = [];
    const noted: [string, { verified: boolean; lateReason?: string }][] = [];
    const make = () => new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
      engineToken: "local-engine-token",
      strictStateFile,
      bindTimeoutMs: 100,
      chatPin: (id) => pins.get(id) ?? null,
      onCapturePolicy: (id, policy) => stored.push([id, policy]),
      onBinding: (id, binding) => noted.push([id, binding]),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/omnirush/collect/capabilities") {
          if (caps === "down") throw new TypeError("fetch failed");
          return Response.json({ schema_versions: [1, 2, 3], strict_sessions: { mode: "enforce", bind: true, path: "/omnirush/device/session-binding", header: "X-OmniRush-Strict-Session" } });
        }
        if (url.pathname === "/omnirush/device/session-binding") {
          binds.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          if (bindAnswer === "timeout") return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))));
          if (bindAnswer === "5xx") return Response.json({ detail: "unavailable" }, { status: 503 });
          return Response.json({ binding: { model: "gpt-6-astra", mode: "native", capture_policy: "client-raw", bound_late: true, late_reason: "history_incomplete", verified: false }, enforcement: "enforce", kept: ["capture_policy"] });
        }
        upstream.push(new Headers(init?.headers).get("x-omnirush-strict-session") ?? "none");
        return Response.json({ output: [] });
      },
    });
    const tools = [{ type: "function", name: "bash" }];
    // The first run learns enforce and keeps it on disk.
    await make().sessionUploadCapabilities();
    // The next start: capabilities cannot be fetched; the kept enforce stands.
    caps = "down";
    const b = make();
    await b.sessionUploadCapabilities();
    const post = (session: string) => b.handle(request({ model: "gpt-6-astra", tools }, { "x-omnirush-session-id": session }), "responses");
    pins.set("ses_timeout", { box: false, revision: null, capturePolicy: "legacy" });
    pins.set("ses_5xx", { box: false, revision: null, capturePolicy: "legacy" });
    const timedOut = await post("ses_timeout");
    // 503: the engine sends it again by itself.
    expect(timedOut.status).toBe(503);
    expect(((await timedOut.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "session_bind_unconfirmed", message: "Couldn't confirm this chat with the server. Try again." });
    bindAnswer = "5xx";
    expect((await post("ses_5xx")).status).toBe(503);
    // No capture policy pinned yet: not bound, not sent.
    const before = binds.length;
    expect((await post("ses_unpinned")).status).toBe(503);
    expect(binds.length).toBe(before);
    expect(upstream).toEqual([]);
    // The bind comes through: sent with the chat's capture policy, the server's stored one goes to the pin.
    bindAnswer = "ok";
    expect((await post("ses_timeout")).status).toBe(200);
    expect(binds.at(-1)).toMatchObject({ session_id: "ses_timeout", capture_policy: "legacy" });
    expect(stored).toEqual([["ses_timeout", "client-raw"]]);
    // A late binding is kept with its reason, never verified.
    expect(noted).toEqual([["ses_timeout", { verified: false, lateReason: "history_incomplete" }]]);
    expect(upstream).toEqual(["1"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("broker: a box chat's unmarked requests (title, compaction, after a restart) stay box requests by its durable pin", async () => {
    const calls: Call[] = [];
    const b = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
      engineToken: "local-engine-token",
      chatPin: (id) => (id === "ses_boxed" ? { box: true, revision: null } : null),
      fetch: async (input, init) => {
        const raw = init?.body;
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
        calls.push({ model: JSON.parse(text).model, box: new Headers(init?.headers).get("x-omnirush-box"), path: new URL(String(input)).pathname });
        return Response.json({ output: [] });
      },
    });
    expect((await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_boxed" }, "responses/compact"), "responses/compact")).status).toBe(200);
    expect((await b.handle(request({ model: "gpt-6-astra" }, { "x-omnirush-session-id": "ses_plain" }), "responses")).status).toBe(200);
    expect(calls.map((c) => c.box)).toEqual(["1", null]);
  });

  test("broker: strict_session_unavailable is sent again after Retry-After, bounded; the engine sees one answer", async () => {
    let refuse = 1;
    let hits = 0;
    let inferences = 0;
    const b = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
      engineToken: "local-engine-token",
      fetch: async () => {
        hits += 1;
        if (refuse > 0) {
          refuse -= 1;
          return Response.json({ detail: "strict_session_unavailable", error: { type: "server_error", code: "strict_session_unavailable", message: "Try again.", omnirush: { code: "strict_session_unavailable", retry: true } } }, { status: 503, headers: { "x-should-retry": "true", "retry-after": hits === 1 ? "1" : "0" } });
        }
        inferences += 1;
        return Response.json({ output: [] });
      },
    });
    const post = () => b.handle(request({ model: "gpt-6-astra", tools: [{ type: "function", name: "bash" }] }, { "x-omnirush-session-id": "ses_retry" }), "responses");
    const started = Date.now();
    expect((await post()).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect([hits, inferences]).toEqual([2, 1]);
    // Still unavailable after the retries: retryable for the engine, never a final refusal.
    refuse = 10;
    hits = 0;
    const still = await post();
    expect(still.status).toBe(503);
    expect(still.headers.get("x-should-retry")).not.toBe("false");
    expect(hits).toBe(4);
  });
});
