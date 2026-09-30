import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionGoalService, goalChargedTokens, resolveNativeGoalClient, type GoalContext } from "./session-goals.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { setSystemTime(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const tokens = { input: 30, output: 15, reasoning: 5, cache: { read: 100, write: 0 } };

test("a failed native daemon falls back only to a verified owned managed session", async () => {
  const client = createOpencodeClient({ baseUrl: "http://native.invalid", fetch: Object.assign(async () =>
    Response.json({ message: "native unavailable" }, { status: 503 }), { preconnect: globalThis.fetch.preconnect }) });
  let checked = 0;
  expect(await resolveNativeGoalClient(client, "ses_managed", async () => { checked += 1; })).toBeNull();
  expect(checked).toBe(1);
  await expect(resolveNativeGoalClient(client, "ses_foreign", async () => { throw new Error("wrong workspace"); }))
    .rejects.toThrow("The native engine session is unavailable");
});

test("two hung native probes leave time for a managed goal command's ten-second deadline", async () => {
  const client = createOpencodeClient({ baseUrl: "http://native.invalid", fetch: Object.assign(async (
    input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1],
  ) => {
    const request = new Request(input, init);
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
  }, { preconnect: globalThis.fetch.preconnect }) });
  let ownedChecks = 0;
  const started = Date.now();
  for (let probe = 0; probe < 2; probe += 1) {
    expect(await resolveNativeGoalClient(client, "ses_managed", async () => { ownedChecks += 1; })).toBeNull();
  }
  expect(ownedChecks).toBe(2);
  expect(Date.now() - started).toBeLessThan(8_000);
}, 15_000);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnirush-goals-"));
  const previousDb = process.env.OMNIRUSH_RUNTIME_DB;
  process.env.OMNIRUSH_RUNTIME_DB = join(root, "runtime.sqlite");
  const workspace: WorkspaceInfo = { id: "ws", name: "Test", path: root, preset: "starter", workspaceType: "local" };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test-token", hostToken: "test-host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [root],
    readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  const dispatches: unknown[] = [];
  let engineMessages: unknown[] = [];
  const engineFetch = Object.assign(async (request: Parameters<typeof fetch>[0]) => {
    const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
    if (path === "/session/status") return Response.json({});
    if (path === "/permission" || path === "/question" || path.endsWith("/children")) return Response.json([]);
    if (path.endsWith("/message")) return Response.json(engineMessages);
    if (path.endsWith("/message/assistant")) return Response.json({ info: {}, parts: [{ type: "step-finish", id: "pre-creation", messageID: "assistant", tokens }] });
    return Response.json({ id: "ses_main", directory: root });
  }, globalThis.fetch);
  const engineFactory = () => createOpencodeClient({ baseUrl: "http://engine.invalid", fetch: engineFetch });
  const services: SessionGoalService[] = [];
  const make = () => {
    const service = new SessionGoalService(config, engineFactory, async (_workspace, _sessionId, body) => {
      dispatches.push(body); return new Response(null, { status: 204 });
    });
    services.push(service); return service;
  };
  const service = make();
  cleanups.push(async () => {
    for (const item of services) await item.stop();
    if (previousDb === undefined) delete process.env.OMNIRUSH_RUNTIME_DB; else process.env.OMNIRUSH_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  });
  const finish = (context: GoalContext, partId: string, messageId = "assistant", used = tokens) => {
    if (!context.goalId) throw new Error("Fixture has no goal");
    return service.event(workspace, "ses_main", "ses_main", context.goalId, context.turnId, {
      type: "message.part.updated", properties: { part: { id: partId, messageID: messageId, type: "step-finish", tokens: used } },
    }, context.chargeable);
  };
  const start = async (budget?: number) => {
    await service.command(workspace, "ses_main", { action: "set", objective: "Finish the work", agent: "plan", tokenBudget: budget });
    return service.prompt(workspace, "ses_main", "user", { agent: "build" });
  };
  return { service, workspace, finish, start, make, dispatches, messages(value: unknown[]) { engineMessages = value; } };
}

test("goal usage excludes cached reads and includes visible output, reasoning and cache writes once", () => {
  expect(goalChargedTokens(tokens)).toBe(50);
  expect(goalChargedTokens({ ...tokens, cache: { read: 10_000, write: 7 } })).toBe(57);
});

test("each provider step counts once even in one assistant message; a summary never doubles it", async () => {
  const f = await fixture(); const context = await f.start(150);
  await Promise.all([f.finish(context, "step1"), f.finish(context, "step2"), f.finish(context, "step3")]);
  await f.finish(context, "step2");
  if (!context.goalId) throw new Error("Fixture has no goal");
  await f.service.event(f.workspace, "ses_main", "ses_main", context.goalId, context.turnId, {
    type: "message.updated", properties: { info: { id: "assistant", role: "assistant", time: { completed: Date.now() }, tokens } },
  });
  expect(await f.service.read(f.workspace, "ses_main")).toMatchObject({ tokensUsed: 150, status: "budget_limited" });
  expect(await f.service.updateFromTool(f.workspace, "ses_main", context.goalId, "paused")).toMatchObject({ status: "budget_limited" });
});

test("creating a goal starts at the next provider step, including later steps of the same message", async () => {
  const f = await fixture();
  await f.service.createFromTool(f.workspace, "ses_main", "Finish the work", undefined, "assistant");
  const context = await f.service.context(f.workspace, "ses_main", []);
  await f.finish(context, "pre-creation"); await f.finish(context, "creation");
  expect(await f.service.read(f.workspace, "ses_main")).toMatchObject({ tokensUsed: 0 });
  await f.finish(context, "after-creation"); await f.finish(context, "after-creation");
  expect(await f.service.read(f.workspace, "ses_main")).toMatchObject({ tokensUsed: 50 });
});

test("pause leaves the current turn running; replacement ignores late accounting and clear removes it", async () => {
  const f = await fixture(); const before = await f.start();
  await f.service.command(f.workspace, "ses_main", { action: "pause" });
  expect((await f.service.context(f.workspace, "ses_main", [])).turnId).toBe(before.turnId);
  await f.finish(before, "finishing-paused-turn");
  expect(await f.service.read(f.workspace, "ses_main")).toMatchObject({ status: "paused", tokensUsed: 50 });
  await f.service.command(f.workspace, "ses_main", { action: "set", objective: "New work", agent: "plan" });
  await f.finish(before, "late-old-step");
  expect(await f.service.read(f.workspace, "ses_main")).toMatchObject({ tokensUsed: 0, objective: "New work" });
  await f.service.command(f.workspace, "ses_main", { action: "clear" });
  expect(await f.service.read(f.workspace, "ses_main")).toBeNull();
});

test("explicit Plan work uses no goal tokens or active work time", async () => {
  const f = await fixture(); await f.start();
  const context = await f.service.prompt(f.workspace, "ses_main", "plan-user", { agent: "plan" });
  const before = await f.service.read(f.workspace, "ses_main");
  setSystemTime(Date.now() + 10_000);
  await f.finish(context, "planning-step");
  const after = await f.service.read(f.workspace, "ses_main");
  expect(after?.tokensUsed).toBe(0);
  expect(after?.timeUsedSeconds).toBe(before?.timeUsedSeconds);
});

test("a held old turn still charges the same goal after steering into Plan", async () => {
  const f = await fixture(); const work = await f.start();
  await f.service.prompt(f.workspace, "ses_main", "plan-user", { agent: "plan" });
  await f.finish(work, "held-old-step"); await f.finish(work, "held-old-step");
  expect(await f.service.read(f.workspace, "ses_main")).toMatchObject({ tokensUsed: 50, status: "active" });
  const planned = await f.service.context(f.workspace, "ses_main", []);
  await f.finish(planned, "plan-step");
  expect(await f.service.read(f.workspace, "ses_main")).toMatchObject({ tokensUsed: 50 });
});

test("a queue hold changes no goal state and release admits pending work once", async () => {
  const f = await fixture();
  const goal = await f.service.command(f.workspace, "ses_main", { action: "set", objective: "Finish", agent: "build" });
  expect(await f.service.command(f.workspace, "ses_main", { action: "hold", holding: true })).toEqual(goal);
  await new Promise((resolve) => setTimeout(resolve, 550));
  expect(f.dispatches).toHaveLength(0);
  await f.service.command(f.workspace, "ses_main", { action: "hold", holding: false });
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(f.dispatches).toHaveLength(1);
});

test("an expired queue hold permits pending admission without an explicit release", async () => {
  const f = await fixture();
  await f.service.command(f.workspace, "ses_main", { action: "hold", holding: true });
  await f.service.command(f.workspace, "ses_main", { action: "set", objective: "Finish", agent: "build" });
  setSystemTime(Date.now() + 30_001);
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(f.dispatches).toHaveLength(1);
});

test("blocked needs three different consecutive turns and resume starts a fresh audit", async () => {
  const f = await fixture(); let context = await f.start();
  if (!context.goalId) throw new Error("Fixture has no goal");
  const goalId = context.goalId;
  await expect(f.service.updateFromTool(f.workspace, "ses_main", goalId, "blocked")).rejects.toThrow("three goal turns");
  await expect(f.service.updateFromTool(f.workspace, "ses_main", goalId, "blocked")).rejects.toThrow("three goal turns");
  context = await f.service.prompt(f.workspace, "ses_main", "user2", { agent: "build" });
  await expect(f.service.updateFromTool(f.workspace, "ses_main", goalId, "blocked")).rejects.toThrow("three goal turns");
  context = await f.service.prompt(f.workspace, "ses_main", "user3", { agent: "build" });
  expect(await f.service.updateFromTool(f.workspace, "ses_main", goalId, "blocked")).toMatchObject({ status: "blocked" });
  await f.service.command(f.workspace, "ses_main", { action: "resume" });
  await f.service.prompt(f.workspace, "ses_main", "user4", { agent: "build" });
  await expect(f.service.updateFromTool(f.workspace, "ses_main", goalId, "blocked")).rejects.toThrow("three goal turns");
});

test("an active goal recovers once after restart, while a paused goal stays paused", async () => {
  const f = await fixture(); await f.start();
  f.messages([
    { info: { id: "user", role: "user", agent: "build", model: { providerID: "test", modelID: "test" }, time: { created: Date.now() } }, parts: [] },
    { info: { id: "shutdown", parentID: "user", role: "assistant", time: { created: Date.now(), completed: Date.now() }, error: { name: "MessageAbortedError", data: { message: "Aborted" } } }, parts: [] },
  ]);
  await f.service.stop();
  const recovered = f.make();
  await Promise.all([recovered.recover(f.workspace, "ses_main"), recovered.recover(f.workspace, "ses_main")]);
  await new Promise((resolve) => setTimeout(resolve, 650));
  expect(await recovered.read(f.workspace, "ses_main")).toMatchObject({ status: "active" });
  expect(f.dispatches).toHaveLength(1);
  await recovered.command(f.workspace, "ses_main", { action: "pause" }); await recovered.stop();
  const paused = f.make(); await paused.recover(f.workspace, "ses_main");
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(f.dispatches).toHaveLength(1);
});
