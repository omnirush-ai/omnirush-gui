import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cloudSchedule, cloudStartUrl, cloudTaskFields, liveUrlAllowed, orgCloudFields, signinFields } from "./cloud-routes.js";
import { registerWorkRoutes, type WorkBroker } from "./routes.js";
import { rememberedWorkActions, rememberWorkSwitch, WORK_PATH, WORK_READ_TOOLS, workCloud, type WorkCloud } from "./work.js";
import type { Route } from "../routes/registry.js";
import type { ServerConfig } from "../types.js";

const temp = () => mkdtempSync(join(tmpdir(), "work-cloud-"));
const json = (data: unknown, status = 200) => Response.json(data, { status });
const CLOUD: WorkCloud = { on: true, create: true, admin: false, live: true, vault: false, limits: { desktops: 2, minutes_left: 412 } };
const TICKET = `#t=${"a".repeat(40)}.${"b".repeat(43)}`;

type Answer = (path: string, init: { method: string; body?: unknown; headers?: Record<string, string> }) => Response;

function setup(answer: Answer, options: { capabilities?: WorkBroker["capabilities"]; origin?: string } = {}) {
  const dir = temp();
  const calls: string[] = [];
  const routes: Route[] = [];
  const asked: unknown[] = [];
  const broker: WorkBroker = {
    workRequest: async (path, init) => { calls.push(`${init.method} ${path} ${typeof init.body === "string" ? init.body : ""}`); return answer(path, init); },
    accountId: async () => "user_1",
    gatewayOrigin: () => options.origin ?? "https://omnirush.ai",
    capabilities: options.capabilities ?? (async (opts) => { asked.push(opts); return { work: { enabled: true, sources: ["mock"] } }; }),
  };
  const refreshed: number[] = [];
  registerWorkRoutes({
    routes, config: { workspaces: [] } as unknown as ServerConfig, workDir: () => dir, broker: () => broker, jsonResponse: json,
    readJsonBody: (r) => r.json(), addWorkspace: async () => { throw new Error("unused"); }, applyEngine: async () => undefined, refreshMcp: () => refreshed.push(1),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const pathname = path.split("?")[0] ?? "";
    const route = routes.find((r) => r.method === method && r.regex.test(pathname));
    if (!route) throw new Error(`no route ${method} ${path}`);
    const params: Record<string, string> = {};
    const match = pathname.match(route.regex);
    route.keys.forEach((key, i) => { params[key] = decodeURIComponent(match?.[i + 1] ?? ""); });
    const request = new Request(`http://x${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return route.handler({ request, url: new URL(request.url), params } as never);
  };
  return { dir, calls, call, refreshed, asked };
}

describe("cloud tasks: paths, tools and the state's block", () => {
  test("only the contract's cloud paths reach the server", () => {
    for (const path of ["cloud/tasks", "cloud/tasks/t_1", "cloud/tasks/t_1/run", "cloud/runs", "cloud/runs/r_1", "cloud/runs/r_1/steps", "cloud/runs/r_1/steps/12/shot",
      "cloud/runs/r_1/files/INV-4471.pdf", "cloud/runs/r_1/cancel", "cloud/runs/r_1/takeover", "cloud/runs/r_1/handback", "cloud/runs/r_1/input", "cloud/runs/r_1/approve",
      "cloud/runs/r_1/deny", "cloud/runs/r_1/live", "org/cloud", "org/cloud/signins", "org/cloud/signins/s_1"]) {
      expect(WORK_PATH.test(path)).toBe(true);
    }
    for (const path of ["cloud", "cloud/tasks/t_1/delete", "cloud/runs/r_1/steps/x/shot", "cloud/runs/r_1/files/a/b", "cloud/runs/r_1/exec", "cloud/runs/../admin", "org/cloud/signins/s_1/value", "cloud/desktops"]) {
      expect(WORK_PATH.test(path)).toBe(false);
    }
    // Reads run without asking; making or running a task asks like every write.
    expect(WORK_READ_TOOLS).toContain("work_cloud_runs");
    expect(WORK_READ_TOOLS).toContain("work_cloud_result");
    expect(WORK_READ_TOOLS).toContain("work_cloud_signins");
    expect(WORK_READ_TOOLS).not.toContain("work_cloud_task");
    expect(WORK_READ_TOOLS).not.toContain("work_cloud_run");
  });

  test("the block is read field by field, absent unless on; the state carries it only then", async () => {
    expect(workCloud({})).toBeNull();
    expect(workCloud({ cloud: { on: false } })).toBeNull();
    expect(workCloud({ cloud: "on" })).toBeNull();
    expect(workCloud({ cloud: { on: true, create: "yes", limits: { desktops: -1, minutes_left: 9.7 } } })).toEqual({ on: true, create: false, admin: false, live: false, vault: false, limits: { desktops: 0, minutes_left: 9 } });
    const dir = temp();
    rememberWorkSwitch(dir, { work: { enabled: true, sources: [], cloud: CLOUD } });
    expect(rememberedWorkActions(dir).cloud).toEqual(CLOUD);
    // Work off: no cloud, whatever the block says.
    rememberWorkSwitch(dir, { work: { enabled: false, sources: [], cloud: CLOUD } });
    expect(rememberedWorkActions(dir)).toEqual({ autopilot: false, full_access: false, writes_paused: false, meetings: false });
  });

  test("everyone without the block gets the state exactly as before; coming or going lists the tools again", async () => {
    let block: Record<string, unknown> = { enabled: true, sources: ["mock"] };
    const { call, refreshed } = setup(() => json({}), { capabilities: async () => ({ work: block }) });
    expect(await (await call("GET", "/work/state")).json()).toEqual({ enabled: true, available: false, sources: ["mock"], message: null, autopilot: false, full_access: false, writes_paused: false, meetings: false, workspaceId: null });
    expect(refreshed).toEqual([]);
    block = { ...block, cloud: CLOUD };
    expect((await (await call("GET", "/work/state")).json()).cloud).toEqual(CLOUD);
    expect(refreshed).toEqual([1]);
    await call("GET", "/work/state");
    expect(refreshed).toEqual([1]);
    block = { enabled: true, sources: ["mock"] };
    expect("cloud" in (await (await call("GET", "/work/state")).json())).toBe(false);
    expect(refreshed).toEqual([1, 1]);
  });
});

describe("cloud tasks: field checks", () => {
  test("a task's fields: required on create, any subset on a change, unknown ones dropped", () => {
    const task = { title: " Pull invoices ", instructions: "Open Invoices.", start_url: "https://portal.example.com/login", signin_mode: "none", output: { kind: "invoice" }, write_mode: "read", schedule: { every: "week", at: "08:00", weekday: 0, tz: "Europe/Berlin" }, evil: 1, run_now: true };
    expect(cloudTaskFields(task, true)).toEqual({ ok: true, value: { title: "Pull invoices", instructions: "Open Invoices.", start_url: "https://portal.example.com/login", signin_mode: "none", output: { kind: "invoice" }, write_mode: "read", schedule: { every: "week", at: "08:00", weekday: 0, tz: "Europe/Berlin" } } });
    expect(cloudTaskFields({ ...task, start_url: "http://portal.example.com" }, true).ok).toBe(false);
    expect(cloudTaskFields({ ...task, start_url: "https://user:pw@portal.example.com" }, true).ok).toBe(false);
    expect(cloudTaskFields({ ...task, signin_mode: "saved" }, true).ok).toBe(false);
    expect(cloudTaskFields({ ...task, signin_mode: "saved", signin_id: "s_1" }, true).ok).toBe(true);
    expect(cloudTaskFields({ ...task, output: { kind: "shell" } }, true).ok).toBe(false);
    expect(cloudTaskFields({ ...task, instructions: "x".repeat(4001) }, true).ok).toBe(false);
    expect(cloudTaskFields({}, false).ok).toBe(false);
    expect(cloudTaskFields({ owner: "me" }, false)).toEqual({ ok: true, value: { owner: "me" } });
    expect(cloudTaskFields({ owner: "u_2" }, false).ok).toBe(false);
    expect(cloudTaskFields({ paused: true, title: "New" }, false)).toEqual({ ok: true, value: { title: "New", paused: true } });
  });

  test("schedules: null runs when asked; week needs a weekday 0 to 6, month a day 1 to 28; a time and a zone always", () => {
    expect(cloudSchedule(null)).toEqual({ ok: true, value: null });
    expect(cloudSchedule({ every: "day", at: "07:30", tz: "UTC" })).toEqual({ ok: true, value: { every: "day", at: "07:30", tz: "UTC" } });
    expect(cloudSchedule({ every: "week", at: "07:30", tz: "UTC" }).ok).toBe(false);
    expect(cloudSchedule({ every: "week", at: "07:30", weekday: 7, tz: "UTC" }).ok).toBe(false);
    expect(cloudSchedule({ every: "month", at: "07:30", day: 29, tz: "UTC" }).ok).toBe(false);
    expect(cloudSchedule({ every: "month", at: "24:00", day: 1, tz: "UTC" }).ok).toBe(false);
    expect(cloudSchedule({ every: "hour", at: "07:30", tz: "UTC" }).ok).toBe(false);
    expect(cloudSchedule({ every: "day", at: "07:30", tz: "Europe/Berlin; DROP" }).ok).toBe(false);
    expect(cloudStartUrl("https://portal.example.com")).toBe("https://portal.example.com/");
    expect(cloudStartUrl("javascript:alert(1)")).toBeNull();
  });

  test("company settings and sign-ins: only their own fields, checked", () => {
    expect(orgCloudFields({ hosts: ["Portal.Example.com", "*.acme.com", "portal.example.com"], retention_days: 30, vault: true })).toEqual({ ok: true, value: { hosts: ["portal.example.com", "*.acme.com"], retention_days: 30 } });
    expect(orgCloudFields({ hosts: ["10.0.0.1"] }).ok).toBe(false);
    expect(orgCloudFields({ hosts: ["https://portal.example.com"] }).ok).toBe(false);
    expect(orgCloudFields({ hosts: Array.from({ length: 21 }, (_, i) => `s${i}.example.com`) }).ok).toBe(false);
    expect(orgCloudFields({ retention_days: 14 }).ok).toBe(false);
    expect(orgCloudFields({ creators: "members" }).ok).toBe(false);
    expect(orgCloudFields({ cloud_enabled: true, cloud_limits: { desktops: 20 } }).ok).toBe(false);
    // A password goes on as typed; only its size is checked here.
    expect(signinFields({ label: "Northbeam (ops)", hosts: ["portal.northbeam.example"], username: "ops@acme.example", password: " p w ", use: "everyone", extra: 1 }, true)).toEqual({ ok: true, value: { label: "Northbeam (ops)", hosts: ["portal.northbeam.example"], username: "ops@acme.example", password: " p w ", use: "everyone" } });
    expect(signinFields({ label: "x", hosts: [], username: "u", password: "p" }, true).ok).toBe(false);
    expect(signinFields({ password: "new" }, false)).toEqual({ ok: true, value: { password: "new" } });
  });

  test("a live page only on the account's server (or a host under it), its ticket in the fragment, never a query", () => {
    expect(liveUrlAllowed(`https://omnirush.ai/omnirush/work/live/v/${TICKET}`, "https://omnirush.ai")).toBe(true);
    expect(liveUrlAllowed(`https://live.omnirush.ai/omnirush/work/live/v/${TICKET}`, "https://omnirush.ai")).toBe(true);
    expect(liveUrlAllowed(`https://evil.example/omnirush/work/live/v/${TICKET}`, "https://omnirush.ai")).toBe(false);
    expect(liveUrlAllowed(`https://omnirush.ai.evil.example/omnirush/work/live/v/${TICKET}`, "https://omnirush.ai")).toBe(false);
    expect(liveUrlAllowed(`http://omnirush.ai/omnirush/work/live/v/${TICKET}`, "https://omnirush.ai")).toBe(false);
    expect(liveUrlAllowed(`https://omnirush.ai/omnirush/work/live/v/?t=${"a".repeat(40)}`, "https://omnirush.ai")).toBe(false);
    expect(liveUrlAllowed(`https://omnirush.ai/omnirush/work/live/other/${TICKET}`, "https://omnirush.ai")).toBe(false);
    expect(liveUrlAllowed(`https://omnirush.ai/omnirush/work/live/v/#t=short`, "https://omnirush.ai")).toBe(false);
    expect(liveUrlAllowed(`https://omnirush.ai/omnirush/work/live/v/${TICKET}`, null)).toBe(false);
    // A loopback test server may serve its live page over http, nothing else may.
    expect(liveUrlAllowed(`http://127.0.0.1:18990/omnirush/work/live/v/${TICKET}`, "http://127.0.0.1:18990")).toBe(true);
    expect(liveUrlAllowed(`http://127.0.0.1:18991/omnirush/work/live/v/${TICKET}`, "http://127.0.0.1:18990")).toBe(false);
  });
});

describe("cloud tasks: routes", () => {
  test("tasks and runs go to /omnirush/work/cloud with only the contract's fields and query", async () => {
    const { calls, call } = setup((path) => (path.startsWith("cloud/tasks/t_1/run") ? json({ run_id: "r_1", status: "queued" }, 202) : json({ items: [], next: null })));
    expect((await call("GET", "/work/cloud/tasks?q=invoices&filter=needs_you&limit=50&cursor=c_1&evil=1")).status).toBe(200);
    expect((await call("GET", "/work/cloud/tasks?filter=everything&limit=500")).status).toBe(200);
    expect((await call("POST", "/work/cloud/tasks", { title: "Pull", instructions: "Do it", start_url: "https://portal.example.com", signin_mode: "none", output: { kind: "row" }, write_mode: "ask", schedule: null, owner_id: "u_9" })).status).toBe(200);
    expect((await call("POST", "/work/cloud/tasks", { title: "Pull" })).status).toBe(400);
    expect((await call("PATCH", "/work/cloud/tasks/t_1", { owner: "me" })).status).toBe(200);
    expect((await call("POST", "/work/cloud/tasks/t_1/run")).status).toBe(202);
    expect((await call("GET", "/work/cloud/runs?task_id=t_1&status=waiting&status=x")).status).toBe(200);
    expect((await call("GET", "/work/cloud/runs/r_1/steps?from=0&limit=200")).status).toBe(200);
    expect((await call("GET", "/work/cloud/tasks/bad%20id")).status).toBe(404);
    expect(calls).toEqual([
      "GET cloud/tasks?q=invoices&filter=needs_you&limit=50&cursor=c_1 ",
      "GET cloud/tasks ",
      `POST cloud/tasks {"title":"Pull","instructions":"Do it","start_url":"https://portal.example.com/","signin_mode":"none","output":{"kind":"row"},"write_mode":"ask","schedule":null}`,
      `PATCH cloud/tasks/t_1 {"owner":"me"}`,
      "POST cloud/tasks/t_1/run {}",
      "GET cloud/runs?task_id=t_1&status=waiting ",
      "GET cloud/runs/r_1/steps?from=0&limit=200 ",
    ]);
  });

  test("controls: a code is checked for shape and sent once; a note is short; a 204 reads as ok", async () => {
    const { calls, call } = setup((path, init) => (init.method === "DELETE" ? new Response(null, { status: 204 }) : json({ id: "r_1", status: "running" })));
    expect((await call("POST", "/work/cloud/runs/r_1/input", { code: " 482913 " })).status).toBe(200);
    expect((await call("POST", "/work/cloud/runs/r_1/input", { code: "48 29 13; rm" })).status).toBe(400);
    expect((await call("POST", "/work/cloud/runs/r_1/input", { code: 482913 })).status).toBe(400);
    expect((await call("POST", "/work/cloud/runs/r_1/handback", { note: "Signed in, carry on" })).status).toBe(200);
    expect((await call("POST", "/work/cloud/runs/r_1/handback", { note: "x".repeat(501) })).status).toBe(400);
    for (const action of ["cancel", "takeover", "approve", "deny"]) expect((await call("POST", `/work/cloud/runs/r_1/${action}`)).status).toBe(200);
    const removed = await call("DELETE", "/work/cloud/tasks/t_1");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect(calls).toEqual([
      `POST cloud/runs/r_1/input {"code":"482913"}`,
      `POST cloud/runs/r_1/handback {"note":"Signed in, carry on"}`,
      "POST cloud/runs/r_1/cancel {}", "POST cloud/runs/r_1/takeover {}", "POST cloud/runs/r_1/approve {}", "POST cloud/runs/r_1/deny {}",
      "DELETE cloud/tasks/t_1 ",
    ]);
  });

  test("the live page goes to the app only when it is on the account's server", async () => {
    let url = `https://omnirush.ai/omnirush/work/live/v/${TICKET}`;
    const { call } = setup(() => json({ url, expires_at: "2026-11-23T19:00:00Z", ticket: "x" }));
    expect((await call("POST", "/work/cloud/runs/r_1/live", { mode: "shell" })).status).toBe(400);
    const good = await call("POST", "/work/cloud/runs/r_1/live", { mode: "view" });
    expect(await good.json()).toEqual({ url, expires_at: "2026-11-23T19:00:00Z" });
    url = `https://evil.example/omnirush/work/live/v/${TICKET}`;
    const bad = await call("POST", "/work/cloud/runs/r_1/live", { mode: "control" });
    expect(bad.status).toBe(502);
    expect((await bad.json()).code).toBe("live_unavailable");
  });

  test("Cloud tasks' refusals are worded for them, not for connectors", async () => {
    const { call } = setup(() => json({ detail: "not_allowed", reason: "Only the owner" }, 403));
    const answer = await call("POST", "/work/cloud/tasks/t_1/run");
    expect(answer.status).toBe(403);
    expect(await answer.json()).toMatchObject({ code: "not_allowed", message: "Only the task's owner or a company admin can do that.", details: { reason: "Only the owner" } });
    const off = setup(() => json({ detail: "cloud_off" }, 403));
    expect((await (await off.call("GET", "/work/cloud/tasks")).json()).message).toBe("Cloud tasks are turned off for your company.");
  });

  test("screenshots are images only; a run's file is always a download, never a page", async () => {
    let type = "image/webp";
    const { call } = setup((path) => new Response("bytes", { headers: { "content-type": type, ...(path.includes("files/") ? { "content-disposition": "inline" } : {}) } }));
    const shot = await call("GET", "/work/cloud/runs/r_1/steps/3/shot");
    expect(shot.status).toBe(200);
    expect(shot.headers.get("x-content-type-options")).toBe("nosniff");
    expect(shot.headers.get("content-disposition")).toBeNull();
    type = "text/html";
    expect((await call("GET", "/work/cloud/runs/r_1/steps/3/shot")).status).toBe(404);
    expect((await call("GET", "/work/cloud/runs/r_1/files/INV-1.pdf")).status).toBe(404);
    type = "application/pdf";
    const file = await call("GET", "/work/cloud/runs/r_1/files/INV-4471%20Northbeam.pdf");
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toBe("attachment");
    expect(file.headers.get("content-security-policy")).toBe("sandbox");
    expect((await call("GET", "/work/cloud/runs/r_1/steps/x/shot")).status).toBe(404);
  });

  test("company settings: checked, and a change reads the capabilities fresh next time; sign-in values go on once", async () => {
    const { calls, call, asked } = setup((path, init) => (init.method === "DELETE" ? new Response(null, { status: 204 }) : json({ enabled: true, hosts: [] })));
    await call("GET", "/work/state");
    expect((await call("PATCH", "/work/org/cloud", { enabled: false, cloud_enabled: true })).status).toBe(200);
    await call("GET", "/work/state");
    expect(asked).toEqual([undefined, { maxAgeMs: 0 }]);
    expect((await call("PATCH", "/work/org/cloud", { hosts: ["127.0.0.1"] })).status).toBe(400);
    expect((await call("POST", "/work/org/cloud/signins", { label: "Ops", hosts: ["portal.example.com"], username: "ops", password: "secret-1" })).status).toBe(200);
    expect((await call("PUT", "/work/org/cloud/signins/s_1", { password: "secret-2" })).status).toBe(200);
    expect((await call("DELETE", "/work/org/cloud/signins/s_1")).status).toBe(200);
    expect(calls.filter((line) => line.includes("org/cloud"))).toEqual([
      `PATCH org/cloud {"enabled":false}`,
      `POST org/cloud/signins {"label":"Ops","hosts":["portal.example.com"],"username":"ops","password":"secret-1"}`,
      `PUT org/cloud/signins/s_1 {"password":"secret-2"}`,
      "DELETE org/cloud/signins/s_1 ",
    ]);
  });
});
