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
  test("limits the sub-agents of one main-session tree running at once, across every layer", async () => {
    const { hooks } = await setup();
    await created(hooks, "ses_main");
    await created(hooks, "ses_child", "ses_main");
    await created(hooks, "ses_grand", "ses_child");
    for (let i = 0; i < OMNIRUSH_SWARM_MAX_RUNNING; i += 1) {
      await task(hooks, i % 3 === 0 ? "ses_main" : i % 3 === 1 ? "ses_child" : "ses_grand", `call_${i}`);
    }
    await expect(task(hooks, "ses_grand", "call_over")).rejects.toThrow(/already running/);
    // Another main session has its own budget.
    await created(hooks, "ses_other");
    await task(hooks, "ses_other", "other_1");
    // One finished (event) and one failed call free two slots.
    await partDone(hooks, "call_0");
    await partDone(hooks, "call_1", "error");
    await task(hooks, "ses_child", "call_again_1");
    await task(hooks, "ses_main", "call_again_2");
    await expect(task(hooks, "ses_main", "call_again_3")).rejects.toThrow(/already running/);
    // tool.execute.after frees a slot too; the main session going idle frees all.
    await hooks["tool.execute.after"]({ tool: "task", callID: "call_2" });
    await task(hooks, "ses_main", "call_again_3");
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_main", status: { type: "idle" } } } });
    await task(hooks, "ses_grand", "after_idle");
  });

  test("limits sub-agents started per main-session turn; a new prompt to the main session refills it", async () => {
    const { hooks } = await setup();
    await created(hooks, "ses_main");
    await created(hooks, "ses_child", "ses_main");
    for (let i = 0; i < OMNIRUSH_SWARM_MAX_PER_TURN; i += 1) {
      const callID = `call_${i}`;
      await task(hooks, i % 2 ? "ses_child" : "ses_main", callID);
      await partDone(hooks, callID);
    }
    await expect(task(hooks, "ses_child", "call_over")).rejects.toThrow(`started ${OMNIRUSH_SWARM_MAX_PER_TURN} sub-agents`);
    // A sub-agent's own prompt is not a new turn.
    await hooks["chat.message"]({ sessionID: "ses_child" });
    await expect(task(hooks, "ses_main", "call_over")).rejects.toThrow(/Do not retry/);
    await hooks["chat.message"]({ sessionID: "ses_main" });
    await task(hooks, "ses_child", "next_turn");
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
