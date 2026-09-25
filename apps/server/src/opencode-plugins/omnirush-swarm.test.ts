import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmniRushSwarm } from "./omnirush-swarm.js";
import {
  OMNIRUSH_SUBAGENT_DEPTH,
  OMNIRUSH_SWARM_MAX_PER_TURN,
  OMNIRUSH_SWARM_MAX_RUNNING,
} from "../omnirush-swarm.js";

type Hooks = Awaited<ReturnType<typeof OmniRushSwarm>>;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(parents: Record<string, string | null> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "omnirush-swarm-"));
  dirs.push(directory);
  const reads: string[] = [];
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        reads.push(path.id);
        if (!(path.id in parents)) throw new Error("not found");
        return { data: { id: path.id, ...(parents[path.id] ? { parentID: parents[path.id] } : {}) } };
      },
    },
  };
  const hooks = await OmniRushSwarm({ client, directory });
  return { hooks, directory, reads };
}

const created = (hooks: Hooks, id: string, parentID?: string) =>
  hooks.event({ event: { type: "session.created", properties: { info: { id, ...(parentID ? { parentID } : {}) } } } });
const task = (hooks: Hooks, sessionID: string, callID: string) =>
  hooks["tool.execute.before"]({ tool: "task", sessionID, callID });
const partDone = (hooks: Hooks, callID: string, status = "completed") =>
  hooks.event({ event: { type: "message.part.updated", properties: { part: { type: "tool", tool: "task", callID, state: { status } } } } });

describe("omnirush swarm plugin", () => {
  test("puts no cap on how many sub-agents run at once or start per turn", async () => {
    const { hooks } = await setup();
    await created(hooks, "ses_main");
    await created(hooks, "ses_child", "ses_main");
    await created(hooks, "ses_grand", "ses_child");
    // Far past the old caps (8 running, 24 per turn), none refused.
    for (let i = 0; i < 200; i += 1) {
      await task(hooks, i % 3 === 0 ? "ses_main" : i % 3 === 1 ? "ses_child" : "ses_grand", `call_${i}`);
    }
    expect(OMNIRUSH_SWARM_MAX_RUNNING).toBe(Number.POSITIVE_INFINITY);
    expect(OMNIRUSH_SWARM_MAX_PER_TURN).toBe(Number.POSITIVE_INFINITY);
  });

  test("other tools and unknown sessions pass; parents are read from the engine once", async () => {
    const { hooks, reads } = await setup({ ses_a: null, ses_b: "ses_a" });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_b", callID: "x" });
    await task(hooks, "ses_b", "c1");
    await task(hooks, "ses_b", "c2");
    await task(hooks, "ses_unknown", "c3");
    expect(reads.filter((id) => id === "ses_b")).toHaveLength(1);
    expect(reads.filter((id) => id === "ses_a")).toHaveLength(1);
  });

  test("reminds sub-agents, not the main session, of swarm.md while it exists", async () => {
    const { hooks, directory } = await setup();
    await created(hooks, "ses_main");
    await created(hooks, "ses_child", "ses_main");
    await created(hooks, "ses_grand", "ses_child");
    await created(hooks, "ses_great", "ses_grand");
    const system = async (sessionID: string) => {
      const output = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID }, output);
      return output.system.slice(1).join("\n");
    };
    expect(await system("ses_child")).toBe("");
    await writeFile(join(directory, "swarm.md"), "# Goal\n");
    expect(await system("ses_main")).toBe("");
    const child = await system("ses_child");
    expect(child).toContain("layer 1 of at most 3");
    expect(child).toContain("Read `swarm.md` before you start");
    expect(child).toContain("you may delegate");
    expect(await system("ses_grand")).toContain("layer 2 of at most 3");
    const great = await system("ses_great");
    expect(great).toContain(`layer ${OMNIRUSH_SUBAGENT_DEPTH} of at most ${OMNIRUSH_SUBAGENT_DEPTH}`);
    expect(great).toContain("You cannot delegate further");
  });
});

describe("omnirush swarm plugin: sub-agent model and effort", () => {
  type Resolve = { body: Record<string, unknown> };
  const saved = { url: process.env.OMNIRUSH_SERVER_URL, token: process.env.OMNIRUSH_POLICY_TOKEN };
  afterEach(() => {
    if (saved.url === undefined) delete process.env.OMNIRUSH_SERVER_URL;
    else process.env.OMNIRUSH_SERVER_URL = saved.url;
    if (saved.token === undefined) delete process.env.OMNIRUSH_POLICY_TOKEN;
    else process.env.OMNIRUSH_POLICY_TOKEN = saved.token;
  });

  async function withServer(answer: (body: Record<string, unknown>) => unknown, fallbacks: unknown[] = []) {
    const resolves: Resolve[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.headers.get("authorization") !== "Bearer policy-token") return new Response("no", { status: 401 });
        const url = new URL(request.url);
        if (url.pathname === "/omnirush/subagent-model/resolve") {
          const body = (await request.json()) as Record<string, unknown>;
          resolves.push({ body });
          return Response.json(answer(body));
        }
        if (url.pathname === "/omnirush/subagent-model/fallbacks") return Response.json({ fallbacks });
        return new Response("not found", { status: 404 });
      },
    });
    cleanupServers.push(() => server.stop(true));
    process.env.OMNIRUSH_SERVER_URL = `http://127.0.0.1:${server.port}`;
    process.env.OMNIRUSH_POLICY_TOKEN = "policy-token";
    const titles: Record<string, string> = { ses_child: "Research (@general subagent)" };
    const directory = await mkdtemp(join(tmpdir(), "omnirush-swarm-model-"));
    dirs.push(directory);
    const parents: Record<string, string | null> = { ses_main: null, ses_child: "ses_main", ses_grand: "ses_child" };
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: parents[path.id] ?? undefined, title: titles[path.id] } }),
        update: async ({ path, body }: { path: { id: string }; body: { title: string } }) => {
          titles[path.id] = body.title;
          return { data: {} };
        },
      },
    };
    const hooks = await OmniRushSwarm({ client, directory });
    return { hooks, resolves, titles };
  }
  const cleanupServers: Array<() => void> = [];
  afterEach(() => {
    for (const stop of cleanupServers.splice(0)) stop();
  });

  const prompt = async (hooks: Hooks, sessionID: string, model: { providerID: string; modelID: string; variant?: string }) => {
    const output = { message: { model: { ...model } } as { model: Record<string, unknown> } };
    await hooks["chat.message"]({ sessionID, model: { providerID: model.providerID, modelID: model.modelID }, variant: model.variant }, output);
    return output.message.model;
  };

  test("the main session keeps its model; sub-agents at every layer get the picked model and effort", async () => {
    const { hooks, resolves } = await withServer((body) => ({
      model: { providerID: "omnirush", modelID: "gpt-6-sol" },
      variant: "high",
      gatewayFallback: { model: (body.main as { modelID: string }).modelID, effort: "max" },
    }));
    expect(await prompt(hooks, "ses_main", { providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" }))
      .toEqual({ providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" });
    expect(resolves).toHaveLength(0);

    expect(await prompt(hooks, "ses_child", { providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" }))
      .toEqual({ providerID: "omnirush", modelID: "gpt-6-sol", variant: "high" });
    expect(await prompt(hooks, "ses_grand", { providerID: "omnirush", modelID: "gpt-6-sol", variant: "high" }))
      .toEqual({ providerID: "omnirush", modelID: "gpt-6-sol", variant: "high" });
    expect(resolves.map((entry) => entry.body)).toEqual([
      {
        sessionId: "ses_child",
        rootSessionId: "ses_main",
        inherited: { providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" },
        main: { providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" },
      },
      {
        sessionId: "ses_grand",
        rootSessionId: "ses_main",
        inherited: { providerID: "omnirush", modelID: "gpt-6-sol", variant: "high" },
        main: { providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" },
      },
    ]);

    // Its model requests name the main model for the broker's fallback; the main session's do not.
    const headers = async (sessionID: string, id: string) => {
      const output = { headers: {} as Record<string, string> };
      await hooks["chat.headers"]({ sessionID, model: { id, providerID: "omnirush" } }, output);
      return output.headers;
    };
    expect(await headers("ses_grand", "gpt-6-sol")).toEqual({
      "x-omnirush-subagent-fallback-model": "gpt-6-astra",
      "x-omnirush-subagent-fallback-effort": "max",
      "x-omnirush-subagent-root": "ses_main",
    });
    expect(await headers("ses_main", "gpt-6-astra")).toEqual({});
    expect(await headers("ses_grand", "gpt-6-astra")).toEqual({});

    // The finished task names the sub-agent's own model.
    const output = { output: "<task>done</task>", metadata: { sessionId: "ses_child", model: { providerID: "omnirush", modelID: "gpt-6-astra" } } as Record<string, unknown> };
    await hooks["tool.execute.after"]({ tool: "task", callID: "call_1" }, output);
    expect(output.metadata.model).toEqual({ providerID: "omnirush", modelID: "gpt-6-sol" });
    expect(output.metadata.variant).toBe("high");
    expect(output.output).toBe("<task>done</task>");
  });

  test("a fallback to the main model is noted on the sub-agent's title and in the task result", async () => {
    const { hooks, titles } = await withServer(() => ({
      model: { providerID: "omnirush", modelID: "gpt-6-astra" },
      variant: "max",
      fallback: { requested: "meta-muse-spark", requestedName: "Meta Muse Spark", used: "gpt-6-astra", usedName: "GPT 6 Astra", reason: "not_in_catalog" },
    }));
    await prompt(hooks, "ses_main", { providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" });
    expect(await prompt(hooks, "ses_child", { providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" }))
      .toEqual({ providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" });
    expect(titles.ses_child).toBe("Research (@general subagent) · ran on GPT 6 Astra: Meta Muse Spark is not available to this account");
    const output = { output: "<task>done</task>", metadata: { sessionId: "ses_child" } as Record<string, unknown> };
    await hooks["tool.execute.after"]({ tool: "task", callID: "call_1" }, output);
    expect(output.output).toBe("<task>done</task>\n\n(omnirush.ai: this sub-agent ran on GPT 6 Astra: Meta Muse Spark is not available to this account.)");
    expect(output.metadata.omnirushModelFallback).toEqual({ requested: "meta-muse-spark", used: "gpt-6-astra", reason: "not_in_catalog" });
  });

  test("a gateway fallback during the task is read back when the task ends", async () => {
    const { hooks, titles } = await withServer(
      () => ({ model: { providerID: "omnirush", modelID: "gpt-6-sol" }, variant: "high", gatewayFallback: { model: "gpt-6-astra", effort: "max" } }),
      [{ requested_model: "gpt-6-sol", requested_name: "GPT 6 Sol", used_model: "gpt-6-astra", used_name: "GPT 6 Astra", reason: "model_unavailable" }],
    );
    await prompt(hooks, "ses_main", { providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" });
    await prompt(hooks, "ses_child", { providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" });
    const output = { output: "<task>done</task>", metadata: { sessionId: "ses_child" } as Record<string, unknown> };
    await hooks["tool.execute.after"]({ tool: "task", callID: "call_1" }, output);
    expect(output.metadata.model).toEqual({ providerID: "omnirush", modelID: "gpt-6-astra" });
    expect(output.metadata.omnirushModelFallback).toEqual({ requested: "gpt-6-sol", used: "gpt-6-astra", reason: "refused" });
    expect(output.output).toContain("ran on GPT 6 Astra: GPT 6 Sol was refused by omnirush.ai");
    expect(titles.ses_child).toContain("· ran on GPT 6 Astra: GPT 6 Sol was refused by omnirush.ai");
  });

  test("with the setting untouched or no server, sub-agent prompts stay exactly as the engine made them", async () => {
    const { hooks } = await withServer(() => ({}));
    await prompt(hooks, "ses_main", { providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" });
    expect(await prompt(hooks, "ses_child", { providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" }))
      .toEqual({ providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" });
    const output = { output: "<task>done</task>", metadata: { sessionId: "ses_child", model: { providerID: "omnirush", modelID: "gpt-6-astra" } } as Record<string, unknown> };
    await hooks["tool.execute.after"]({ tool: "task", callID: "call_1" }, output);
    expect(output).toEqual({ output: "<task>done</task>", metadata: { sessionId: "ses_child", model: { providerID: "omnirush", modelID: "gpt-6-astra" } } });

    process.env.OMNIRUSH_SERVER_URL = "http://127.0.0.1:9";
    expect(await prompt(hooks, "ses_child", { providerID: "omnirush", modelID: "gpt-6-astra", variant: "low" }))
      .toEqual({ providerID: "omnirush", modelID: "gpt-6-astra", variant: "low" });
  });
});
