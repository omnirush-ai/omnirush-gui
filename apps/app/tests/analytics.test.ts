import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.has(key) ? this.values.get(key)! : null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { localStorage: storage, addEventListener: () => undefined },
});
type Inspector = { events: (limit?: number) => Array<{ name: string }>; clearEvents: () => void };
const inspector = () => (window as unknown as { __omnirush: Inspector }).__omnirush;
const recordedNames = () => inspector().events(500).map((entry) => entry.name);

const analytics = await import("../src/app/lib/analytics");
const { ensureInspectorInstalled } = await import("../src/app/lib/app-inspector");
const { gatewayRefusalEvent } = await import("../src/app/lib/gateway-refusal");
const { presentOpencodeSessionError } = await import("../src/react-app/domains/session/sync/session-error");
const { reportSandboxFallback, sandboxFallbackProperties } = await import("../src/react-app/domains/settings/linux-sandbox");

const ACCOUNT = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const OTHER = "9b2c1d1e-0000-4000-8000-000000000001";
const NEW_KEY = "phc_uKRzMW7rNe68NKBxCjAwBvqzpxiRj77dGDY7WN3uGoMX";

type Sent = { url: string; body: { api_key: string; batch: Array<{ event: string; distinct_id: string; properties: Record<string, unknown> }> } };
let sent: Sent[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  storage.clear();
  ensureInspectorInstalled();
  inspector().clearEvents();
  sent = [];
  analytics.disposeAnalytics();
  analytics.configureAnalyticsForTests({ key: NEW_KEY, host: "http://127.0.0.1:9/", appVersion: "3.5.8" });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function flushed() {
  await analytics.flushAnalytics();
  return sent.flatMap((request) => request.body.batch);
}

describe("analytics identity", () => {
  test("events before sign-in use the random device id", async () => {
    analytics.captureAnalyticsEvent("app_opened", {});
    const [event] = await flushed();
    expect(event.distinct_id).toBe(analytics.getAnalyticsDistinctId());
    expect(event.properties).toMatchObject({ client: "desktop", app_version: "3.5.8" });
    expect(Object.keys(event.properties)).toEqual(expect.arrayContaining(["client", "app_version", "platform", "os"]));
    expect(sent[0].url).toBe("http://127.0.0.1:9/batch/");
    expect(sent[0].body.api_key).toBe(NEW_KEY);
  });

  test("identify sends $identify once with the account id and links later events", async () => {
    const anonymous = analytics.getAnalyticsDistinctId();
    expect(analytics.identifyAnalyticsAccount(ACCOUNT)).toBe(true);
    expect(analytics.identifyAnalyticsAccount(ACCOUNT)).toBe(false);
    analytics.captureAnalyticsEvent("sign_in_completed", { method: "device_link" });
    const batch = await flushed();
    expect(batch.map((event) => event.event)).toEqual(["$identify", "sign_in_completed"]);
    expect(batch[0].distinct_id).toBe(ACCOUNT);
    expect(batch[0].properties.$anon_distinct_id).toBe(anonymous);
    expect(batch[1].distinct_id).toBe(ACCOUNT);
    expect(JSON.stringify(batch)).not.toContain("@");
  });

  test("identify refuses anything but a UUID (never an e-mail or name)", () => {
    expect(analytics.identifyAnalyticsAccount("person@example.com")).toBe(false);
    expect(analytics.identifyAnalyticsAccount("Person")).toBe(false);
    expect(analytics.identifyAnalyticsAccount(null)).toBe(false);
    expect(analytics.getAnalyticsAccountId()).toBeNull();
  });

  test("reset on sign-out forgets the account and starts a new device id", async () => {
    analytics.identifyAnalyticsAccount(ACCOUNT);
    const before = analytics.getAnalyticsDistinctId();
    expect(analytics.resetAnalyticsAccount()).toBe(true);
    expect(analytics.getAnalyticsAccountId()).toBeNull();
    expect(analytics.getAnalyticsDistinctId()).not.toBe(before);
    analytics.captureAnalyticsEvent("app_opened", {});
    const batch = await flushed();
    expect(batch.at(-1)!.distinct_id).toBe(analytics.getAnalyticsDistinctId());
    expect(recordedNames()).toContain("analytics.$reset");
  });

  test("syncAnalyticsAccount follows the account status", () => {
    analytics.syncAnalyticsAccount({ connected: true, accountId: ACCOUNT });
    expect(analytics.getAnalyticsAccountId()).toBe(ACCOUNT);
    analytics.syncAnalyticsAccount({ connected: true, accountId: null });
    expect(analytics.getAnalyticsAccountId()).toBe(ACCOUNT);
    analytics.syncAnalyticsAccount({ connected: true, accountId: OTHER });
    expect(analytics.getAnalyticsAccountId()).toBe(OTHER);
    analytics.syncAnalyticsAccount({ connected: false });
    expect(analytics.getAnalyticsAccountId()).toBeNull();
  });

  test("a blank key sends nothing, but the inspector still records", async () => {
    analytics.configureAnalyticsForTests({ key: "  " });
    analytics.captureAnalyticsEvent("app_opened", {});
    analytics.identifyAnalyticsAccount(ACCOUNT);
    await analytics.flushAnalytics();
    expect(sent).toEqual([]);
    expect(analytics.isAnalyticsActive()).toBe(false);
    expect(recordedNames()).toContain("analytics.app_opened");
  });

  test("always on when a key is set: the old preference no longer turns it off", async () => {
    storage.setItem("omnirush.preferences", JSON.stringify({ analyticsEnabled: false }));
    analytics.captureAnalyticsEvent("app_opened", {});
    expect((await flushed()).map((event) => event.event)).toEqual(["app_opened"]);
  });
});

describe("first run", () => {
  test("once for a new profile", async () => {
    expect(analytics.captureFirstRunOnce(false)).toBe(true);
    expect(analytics.captureFirstRunOnce(false)).toBe(false);
    expect((await flushed()).map((event) => event.event)).toEqual(["first_run"]);
  });

  test("an upgraded profile is marked without an event", async () => {
    expect(analytics.captureFirstRunOnce(true)).toBe(false);
    expect(analytics.captureFirstRunOnce(false)).toBe(false);
    expect(await flushed()).toEqual([]);
  });
});

describe("onboarding survey", () => {
  test("never sends the free-text answer", () => {
    const properties = analytics.attributionSurveyProperties("ai_assistant", "  best open source agent app  ");
    expect(properties).toEqual({ source: "ai_assistant", ai_prompt_length: 26 });
    expect(JSON.stringify(properties)).not.toContain("open source");
    expect(analytics.attributionSurveyProperties("search")).toEqual({ source: "search", ai_prompt_length: 0 });
  });
});

describe("refusals shown", () => {
  const apiError = (status: number, body: unknown, message = "x") => ({
    name: "APIError",
    data: { message, statusCode: status, isRetryable: false, responseBody: JSON.stringify(body) },
  });

  test("keyed on error.omnirush.code, whatever the words", () => {
    const policy = presentOpencodeSessionError(apiError(403, { error: { type: "invalid_request_error", code: "request_policy_refused", message: "Reworded.", omnirush: { code: "request_policy_refused", retry: false } } }, "Reworded."));
    expect(policy.omnirush).toEqual({ code: "request_policy_refused", retry: false });
    expect(gatewayRefusalEvent(policy)).toEqual({
      event: "policy_refusal_shown",
      properties: { reason: "request_policy", code: "request_policy_refused", source: "code", retry: false },
    });

    const tokens = presentOpencodeSessionError(apiError(429, { error: { code: "daily_grant_exhausted", message: "Anything.", omnirush: { code: "limit_tokens", scope: "week", resets_at: "2026-10-26T00:00:00Z", retry: false, retry_after: 600000 } } }));
    expect(gatewayRefusalEvent(tokens)).toEqual({
      event: "limit_shown",
      properties: { limit_type: "tokens", scope: "week", code: "limit_tokens", source: "code", retry: false },
    });

    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ code: "limit_session_cap", scope: "session", retry: false }, { limit_type: "session_cap", scope: "session" }],
      [{ code: "limit_concurrency", scope: "model", retry: true, retry_after: 5 }, { limit_type: "concurrency", scope: "model", retry: true }],
      [{ code: "limit_rate", scope: "account", retry: true }, { limit_type: "rate", scope: "account" }],
      [{ code: "queue_timeout", retry: true, retry_after: 15 }, { limit_type: "queue_timeout" }],
      [{ code: "limit_tokens", retry: false }, { limit_type: "tokens", scope: "unknown" }],
    ];
    for (const [omnirush, expected] of cases) {
      const shown = gatewayRefusalEvent({ title: "x", technicalDetails: "", omnirush: omnirush as { code: string } });
      expect(shown?.event).toBe("limit_shown");
      expect(shown?.properties).toMatchObject({ ...expected, code: omnirush.code, source: "code" });
    }
    expect(gatewayRefusalEvent({ title: "x", technicalDetails: "", omnirush: { code: "queue_timeout" } })?.properties).not.toHaveProperty("scope");
  });

  test("read from a stream error frame the engine kept, and from the broker's 403", () => {
    const frame = { type: "error", sequence_number: 3, error: { type: "invalid_request_error", code: "invalid_prompt", message: "OmniRush can't help.", param: "request_policy_refused", omnirush: { code: "request_policy_refused", retry: false } } };
    expect(presentOpencodeSessionError(apiError(0, frame)).omnirush?.code).toBe("request_policy_refused");
    expect(presentOpencodeSessionError({ name: "UnknownError", data: { message: JSON.stringify(frame) } }).omnirush?.code).toBe("request_policy_refused");
    // What the engine keeps of a stream frame: type, code, message and param (the broker's carrier).
    const kept = { type: "error", sequence_number: 3, error: { type: "invalid_request_error", code: "omnirush.ai", message: "OmniRush can't help.", param: JSON.stringify({ detail: "request_policy_refused", omnirush: { code: "request_policy_refused", retry: false } }) } };
    const cut = presentOpencodeSessionError(apiError(400, kept, "OmniRush can't help."));
    expect(cut.omnirush).toEqual({ code: "request_policy_refused", retry: false });
    expect(gatewayRefusalEvent(cut)?.properties).toMatchObject({ code: "request_policy_refused", source: "code" });
    // x-should-retry: false in the engine's copy of the response headers.
    expect(presentOpencodeSessionError({ name: "APIError", data: { message: "x", statusCode: 403, responseHeaders: { "X-Should-Retry": "false" } } }).noRetry).toBe(true);
    expect(presentOpencodeSessionError({ name: "APIError", data: { message: "x", statusCode: 429, responseHeaders: { "retry-after": "5" } } }).noRetry).toBeUndefined();
    // Malformed objects are ignored.
    expect(presentOpencodeSessionError(apiError(403, { error: { omnirush: { code: 7 } } })).omnirush).toBeUndefined();
    expect(presentOpencodeSessionError(apiError(403, { error: { omnirush: "limit_tokens" } })).omnirush).toBeUndefined();
  });

  test("an older backend: the words, as before", () => {
    expect(gatewayRefusalEvent({ title: "OmniRush can't help with this request. Free model access isn't for attacking systems.", technicalDetails: "" }))
      .toEqual({ event: "policy_refusal_shown", properties: { reason: "request_policy", source: "text" } });
    expect(gatewayRefusalEvent({ title: "x", technicalDetails: "Code: request_policy_refused" })?.event).toBe("policy_refusal_shown");
    expect(gatewayRefusalEvent({ title: "omnirush.ai: today's tokens are used up. They refill at 5:30 AM (in 3 h).", technicalDetails: "" })?.properties)
      .toEqual({ limit_type: "tokens", scope: "day", source: "text" });
    expect(gatewayRefusalEvent({ title: "omnirush.ai: this week's cap is reached. It resets Monday.", technicalDetails: "" })?.properties.scope).toBe("week");
    expect(gatewayRefusalEvent({ title: "omnirush.ai: you have no tokens left.", technicalDetails: "" })?.properties.scope).toBe("empty");
    expect(gatewayRefusalEvent({ title: "x", technicalDetails: "Code: daily_grant_exhausted" })?.properties.scope).toBe("unknown");
    expect(gatewayRefusalEvent({ title: "x", technicalDetails: "session_quality_cap" })?.properties.limit_type).toBe("session_cap");
    // The same old-shape errors through the real presentation.
    const old = presentOpencodeSessionError(apiError(429, { error: { message: "omnirush.ai: you have used today's model allowance. It refills at 00:00 UTC.", type: "omnirush_error", code: "daily_grant_exhausted" } }, "omnirush.ai: you have used today's model allowance. It refills at 00:00 UTC."));
    expect(old.omnirush).toBeUndefined();
    expect(gatewayRefusalEvent(old)).toEqual({ event: "limit_shown", properties: { limit_type: "tokens", scope: "day", source: "text" } });
  });

  test("an unknown code falls back to the words; other errors are not refusals", () => {
    expect(gatewayRefusalEvent({ title: "Provider did not respond in time", technicalDetails: "Status: 504", omnirush: { code: "something_new" } })).toBeNull();
    expect(gatewayRefusalEvent({ title: "x", technicalDetails: "session_quality_cap", omnirush: { code: "something_new" } })?.properties.source).toBe("text");
    expect(gatewayRefusalEvent({ title: "Provider did not respond in time", technicalDetails: "Status: 504" })).toBeNull();
    expect(gatewayRefusalEvent(null)).toBeNull();
  });
});

describe("sandbox fallback", () => {
  const box = (overrides: Record<string, unknown>) => ({
    mode: "on", on: true, state: "ready", runtime: { ok: true, name: "docker", flavor: null, version: "27", reason: null },
    backend: { id: "docker", label: "Docker", version: "27", flavor: null, why: null, alternatives: [], allowed: null },
    backendSetting: { value: "auto", source: "auto", choices: [] }, notice: null, error: "/home/someone/secret path",
    ...overrides,
  }) as never;

  test("reasons, coarse properties only", () => {
    expect(sandboxFallbackProperties(box({ state: "failed" }))).toEqual({ reason: "start_failed", sandbox_mode: "on", backend: "docker", backend_setting: "auto" });
    expect(sandboxFallbackProperties(box({ state: "unavailable" }))?.reason).toBe("not_running");
    expect(sandboxFallbackProperties(box({ state: "unavailable", runtime: { ok: false }, backend: null }))?.reason).toBe("no_backend");
    expect(sandboxFallbackProperties(box({ state: "ready" }))).toBeNull();
    expect(sandboxFallbackProperties(box({ state: "starting" }))).toBeNull();
    expect(sandboxFallbackProperties(box({ on: false, state: "off" }))).toBeNull();
    expect(sandboxFallbackProperties(box({ state: "unavailable", backendSetting: { value: "native", source: "setting", choices: [] } }))).toBeNull();
    expect(JSON.stringify(sandboxFallbackProperties(box({ state: "failed" })))).not.toContain("/home");
  });

  test("once per project and reason", async () => {
    expect(reportSandboxFallback("ws-1", box({ state: "failed" }))).toBe(true);
    expect(reportSandboxFallback("ws-1", box({ state: "failed" }))).toBe(false);
    expect(reportSandboxFallback("ws-2", box({ state: "failed" }))).toBe(true);
    expect(reportSandboxFallback(null, box({ state: "failed" }))).toBe(false);
    expect((await flushed()).map((event) => event.event)).toEqual(["sandbox_fallback", "sandbox_fallback"]);
  });
});

describe("call sites", () => {
  const src = (file: string) => readFileSync(path.join(import.meta.dir, "../src", file), "utf8");

  test("sign-in, device approval, sign-out", () => {
    const view = src("react-app/domains/settings/pages/general-view.tsx");
    expect(view).toContain('captureAnalyticsEvent("device_approved"');
    expect(view).toContain('captureAnalyticsEvent("sign_in_completed"');
    expect(view).toMatch(/omnirushAccountSignOut\(.*\);\n\s+resetAnalyticsAccount\(\);/);
    expect(src("app/lib/quality.ts")).toContain("syncAnalyticsAccount(status)");
  });

  test("refusals on session errors, sandbox fallback on status reads", () => {
    expect(src("react-app/domains/session/sync/session-sync.ts")).toContain("gatewayRefusalEvent(errorPresentation)");
    expect(src("react-app/domains/settings/linux-sandbox.ts")).toContain("reportSandboxFallback(workspaceId, box)");
  });

  test("the opt-out toggle and preference are gone", () => {
    expect(src("react-app/domains/settings/pages/preferences-view.tsx")).not.toMatch(/analytics_toggle|analyticsEnabled/);
    expect(src("react-app/kernel/local-provider.tsx")).not.toContain("analyticsEnabled");
    expect(src("react-app/shell/settings-route.tsx")).not.toContain("analyticsEnabled");
    expect(src("app/lib/analytics.ts")).not.toContain("isAnalyticsEnabled");
    expect(src("i18n/locales/en.ts")).not.toContain("Share anonymous usage data");
  });

  test("the survey event has no free text", () => {
    const welcome = src("react-app/shell/welcome-route.tsx");
    expect(welcome).not.toMatch(/ai_prompt:/);
    expect(welcome).toContain("attributionSurveyProperties(source, aiPrompt)");
  });
});
