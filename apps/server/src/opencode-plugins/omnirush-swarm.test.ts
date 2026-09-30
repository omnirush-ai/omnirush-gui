import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmniRushSwarm } from "./omnirush-swarm.js";
import {
  compactSwarmBoard,
  OMNIRUSH_SUBAGENT_DEPTH,
  OMNIRUSH_SWARM_ARCHIVES_KEPT,
  OMNIRUSH_SWARM_CELL_MAX_CHARS,
  OMNIRUSH_SWARM_FILE,
  OMNIRUSH_SWARM_FINDINGS_PER_TASK,
  OMNIRUSH_SWARM_LINE_MAX_CHARS,
  OMNIRUSH_SWARM_TOOL_NAME,
  swarmBoardView,
  updateSwarmBoard,
  OMNIRUSH_SWARM_MAX_PER_TURN,
  OMNIRUSH_SWARM_MAX_RUNNING,
  OMNIRUSH_SWARM_SKILL_NAME,
  modelsNamedIn,
  textNamesModel,
  OMNIRUSH_TASK_TOOL_NOTE,
  omnirushSubagentNote,
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
const loadSwarmSkill = (hooks: Hooks, sessionID: string) =>
  hooks["tool.execute.before"]({ tool: "skill", sessionID, callID: `skill_${sessionID}` }, { args: { name: OMNIRUSH_SWARM_SKILL_NAME } });
const idle = (hooks: Hooks, sessionID: string) =>
  hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } });
const writeBoard = async (directory: string, text = "# Goal\n") => {
  await mkdir(join(directory, ".omnirush"), { recursive: true });
  await writeFile(join(directory, OMNIRUSH_SWARM_FILE), text);
};
const systemOf = (hooks: Hooks) => async (sessionID: string) => {
  const output = { system: ["base"] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, output);
  return output.system.slice(1).join("\n");
};
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

  test("reminds sub-agents of a running swarm, not the main session, of the board while it exists", async () => {
    const { hooks, directory } = await setup();
    await created(hooks, "ses_main");
    await created(hooks, "ses_child", "ses_main");
    await created(hooks, "ses_grand", "ses_child");
    await created(hooks, "ses_great", "ses_grand");
    const system = systemOf(hooks);
    await loadSwarmSkill(hooks, "ses_main");
    expect(await system("ses_child")).toBe(omnirushSubagentNote(1));
    await writeBoard(directory);
    expect(await system("ses_main")).toBe("");
    const child = await system("ses_child");
    expect(child).toContain("layer 1 of at most 3");
    expect(child).toContain("Do not read, search or edit the board file");
    expect(child).toContain(`use the \`${OMNIRUSH_SWARM_TOOL_NAME}\` tool`);
    expect(child).toContain("If you implement a delegated part of your task, add sub-task rows");
    expect(await system("ses_grand")).toContain("layer 2 of at most 3");
    const great = await system("ses_great");
    expect(great).toContain(`layer ${OMNIRUSH_SUBAGENT_DEPTH} of at most ${OMNIRUSH_SUBAGENT_DEPTH}`);
    expect(great).toContain("You cannot delegate further");
    expect(great).not.toContain("If you do delegate");
  });

  test("1-2 plain task calls get no board note, whatever board files exist", async () => {
    const { hooks, directory } = await setup();
    await created(hooks, "ses_main");
    await created(hooks, "ses_child", "ses_main");
    await task(hooks, "ses_main", "c1");
    // A root swarm.md from an older version and a board no swarm of this session started.
    await writeFile(join(directory, "swarm.md"), "# Goal\nold\n");
    await writeBoard(directory);
    expect(await systemOf(hooks)("ses_child")).toBe(omnirushSubagentNote(1));
  });

  test("every sub-agent is told to do its own task and to ignore sub-agent instructions meant for the main session", async () => {
    const { hooks } = await setup();
    await created(hooks, "ses_main");
    await created(hooks, "ses_child", "ses_main");
    await created(hooks, "ses_grand", "ses_child");
    await created(hooks, "ses_great", "ses_grand");
    const system = systemOf(hooks);
    // The main session keeps its own prompt: it is the one that delegates.
    expect(await system("ses_main")).toBe("");
    const child = await system("ses_child");
    expect(child).toContain("Do your task yourself.");
    expect(child).toContain("Instructions about sub-agents that the user wrote");
    expect(child).toContain("were meant for the main session, which already carried them out");
    expect(child).toContain("only if your task explicitly tells you to");
    expect(child).toContain("Never re-delegate your whole task");
    expect(await system("ses_grand")).toContain("layer 2 of at most 3");
    const great = await system("ses_great");
    expect(great).toContain("You cannot delegate further");
    expect(great).not.toContain("Start sub-agents with the subagent tool");
    // Same text on every step (prompt cache).
    expect(await system("ses_child")).toBe(child);
  });

  test("the task tool description carries omnirush.ai's delegation rules, once", async () => {
    const { hooks } = await setup();
    const task = { description: "Launch a new agent." };
    await hooks["tool.definition"]({ toolID: "task" }, task);
    await hooks["tool.definition"]({ toolID: "task" }, task);
    expect(task.description).toBe(`Launch a new agent.\n\n${OMNIRUSH_TASK_TOOL_NOTE}`);
    expect(OMNIRUSH_TASK_TOOL_NOTE).toContain("start exactly that many, all in one message");
    expect(OMNIRUSH_TASK_TOOL_NOTE).toContain("in the main session, delegate only implementation work");
    expect(OMNIRUSH_TASK_TOOL_NOTE).toContain("A sub-agent starts its own sub-agents only when its task explicitly tells it to implement a part.");
    expect(OMNIRUSH_TASK_TOOL_NOTE).toContain("never paste the user's whole message");
    // Sub-agents see this tool text too: it must not invite them to split their task.
    expect(OMNIRUSH_TASK_TOOL_NOTE).toMatch(/A sub-agent starts its own sub-agents only when its task explicitly tells it to implement a part\.$/);
    const bash = { description: "Run a command." };
    await hooks["tool.definition"]({ toolID: "bash" }, bash);
    expect(bash.description).toBe("Run a command.");
  });

  test("writing the board marks the swarm too, and keeps the board out of git", async () => {
    const { hooks, directory } = await setup();
    await created(hooks, "ses_main");
    await created(hooks, "ses_child", "ses_main");
    await hooks["tool.execute.before"]({ tool: "write", sessionID: "ses_main", callID: "w1" }, { args: { filePath: join(directory, ".omnirush", "swarm.md"), content: "# Goal\n" } });
    await writeBoard(directory);
    expect(await systemOf(hooks)("ses_child")).toContain("`.omnirush/swarm.md`");
    expect(await readFile(join(directory, ".omnirush", ".gitignore"), "utf8")).toContain("/swarm.md\n/swarms/\n");
    // Both of omnirush.ai's ignore files stay out of git status too.
    expect(await readFile(join(directory, ".omnirush", ".gitignore"), "utf8")).toContain("/.gitignore\n/.ignore\n");
    // ripgrep (the engine's grep and glob) honours .ignore outside git repositories too.
    expect(await readFile(join(directory, ".omnirush", ".ignore"), "utf8")).toContain("/.ignore\n/swarm.md\n/swarms/\n");
  });

  test("a swarm leaves git status clean", async () => {
    const { hooks, directory } = await setup();
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", directory, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
    git("init", "-q");
    await writeFile(join(directory, "README.md"), "# t\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    await created(hooks, "ses_main");
    await loadSwarmSkill(hooks, "ses_main");
    await writeBoard(directory);
    expect(existsSync(join(directory, ".omnirush", ".ignore"))).toBe(true);
    expect(git("status", "--porcelain", "--untracked-files=all").stdout.toString()).toBe("");
  });

  test("a user's own .omnirush/.gitignore only gains the board lines", async () => {
    const { hooks, directory } = await setup();
    await created(hooks, "ses_main");
    await mkdir(join(directory, ".omnirush"), { recursive: true });
    await writeFile(join(directory, ".omnirush", ".gitignore"), "cache/");
    await loadSwarmSkill(hooks, "ses_main");
    expect(await readFile(join(directory, ".omnirush", ".gitignore"), "utf8")).toBe("cache/\n/swarm.md\n/swarms/\n");
    await created(hooks, "ses_other");
    await loadSwarmSkill(hooks, "ses_other");
    expect(await readFile(join(directory, ".omnirush", ".gitignore"), "utf8")).toBe("cache/\n/swarm.md\n/swarms/\n");
  });

  test("a stale board is archived when a swarm starts, and the board is archived when the swarm's main session goes idle", async () => {
    const { hooks, directory } = await setup();
    await created(hooks, "ses_old");
    await created(hooks, "ses_main");
    await created(hooks, "ses_child", "ses_main");
    await writeBoard(directory, "# Goal\nstale\n");
    await loadSwarmSkill(hooks, "ses_main");
    expect(existsSync(join(directory, OMNIRUSH_SWARM_FILE))).toBe(false);
    const archived = await readdir(join(directory, ".omnirush", "swarms"));
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(/^\d{8}-\d{6}\.md$/);
    await writeBoard(directory, "# Goal\nlive\n");
    // Another session going idle leaves the running swarm's board alone.
    await idle(hooks, "ses_old");
    await idle(hooks, "ses_child");
    expect(existsSync(join(directory, OMNIRUSH_SWARM_FILE))).toBe(true);
    await idle(hooks, "ses_main");
    expect(existsSync(join(directory, OMNIRUSH_SWARM_FILE))).toBe(false);
    const after = await readdir(join(directory, ".omnirush", "swarms"));
    expect(after).toHaveLength(2);
    const contents = await Promise.all(after.map((name) => readFile(join(directory, ".omnirush", "swarms", name), "utf8")));
    expect(contents.some((text) => text.includes("live"))).toBe(true);
    // The swarm is over: its sub-agents hear of no board, and a later small request finds none.
    await writeBoard(directory);
    expect(await systemOf(hooks)("ses_child")).toBe(omnirushSubagentNote(1));
  });

  test("the root swarm.md of older versions is never moved", async () => {
    const { hooks, directory } = await setup();
    await created(hooks, "ses_main");
    await writeFile(join(directory, "swarm.md"), "# Goal\nuser file\n");
    await loadSwarmSkill(hooks, "ses_main");
    await idle(hooks, "ses_main");
    expect(await readFile(join(directory, "swarm.md"), "utf8")).toBe("# Goal\nuser file\n");
  });
});

const BOARD = [
  "# Goal",
  "Review the project.",
  "",
  "## Tasks",
  "| id | task | owner | status | result |",
  "|---|---|---|---|---|",
  "| T1 | review math | agent 1 | todo | |",
  "| T2 | review strings | agent 2 | todo | |",
  "| T3 | write tests | agent 3 | todo | |",
  "",
  "## Findings",
  "",
  "## Decisions",
  "- Do not edit source files.",
  "",
].join("\n");

const busyStatus = (hooks: Hooks, sessionID: string) =>
  hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } });
const boardTool = (hooks: Hooks) => hooks.tool[OMNIRUSH_SWARM_TOOL_NAME];

describe("omnirush swarm board: size limits", () => {
  test("compaction cuts cells, findings and decisions to one short line and keeps a few findings per task", () => {
    const long = "x".repeat(1000);
    const board = BOARD
      .replace("| T1 | review math | agent 1 | todo | |", `| T1 | review math | agent 1 | done | ${long} |`)
      .replace("## Findings\n", `## Findings\n- T1: ${long}\n- T1: second\n  - nested detail\n- T1: third\n- T1: fourth\n- T1: fifth\n\`\`\`\ncode dump\n\`\`\`\nA paragraph of prose.\n### T2\n- one\n`)
      .replace("- Do not edit source files.", `- ${long}`);
    const compact = compactSwarmBoard(board);
    const row = compact.split("\n").find((line) => line.startsWith("| T1"))!;
    expect(row.length).toBeLessThan(OMNIRUSH_SWARM_CELL_MAX_CHARS + 60);
    expect(compact).not.toContain("fourth");
    expect(compact).not.toContain("fifth");
    expect(compact).not.toContain("nested detail");
    expect(compact).not.toContain("code dump");
    expect(compact).not.toContain("A paragraph");
    expect(compact).toContain("- T1: third");
    expect(compact).toContain("### T2\n- one");
    for (const line of compact.split("\n")) expect(line.length).toBeLessThanOrEqual(OMNIRUSH_SWARM_LINE_MAX_CHARS + 2);
    expect(compact.length).toBeLessThan(board.length / 2);
    // A board within the limits is left exactly as it is.
    expect(compactSwarmBoard(BOARD)).toBe(BOARD);
    expect(compactSwarmBoard(compact)).toBe(compact);
  });

  test("an update sets the agent's own row, adds sub-task rows and appends capped one-line findings", () => {
    let board = updateSwarmBoard(BOARD, { task: "t2", status: "running" });
    expect(board).toContain("| T2 | review strings | agent 2 | running |  |");
    board = updateSwarmBoard(board, { task: "T2", subtasks: [{ id: "T2.1", task: "check shout" }] });
    expect(board).toContain("| T2.1 | check shout |  | todo |  |");
    board = updateSwarmBoard(board, {
      task: "T2",
      status: "done",
      result: "found 2 issues\nsee report | details",
      findings: ["T2: banner() double-spaces", "whisper drops punctuation", "x".repeat(900), "four", "five"],
    });
    expect(board).toContain("| T2 | review strings | agent 2 | done | found 2 issues see report / details |");
    expect(board).toContain("## Findings\n- T2: banner() double-spaces\n- T2: whisper drops punctuation\n- T2: xxx");
    expect(board).not.toContain("four");
    expect(board.indexOf("## Findings")).toBeLessThan(board.indexOf("## Decisions"));
    // An id without a row gets one.
    expect(updateSwarmBoard(BOARD, { task: "T9", status: "running" })).toContain("| T9 |  |  | running |  |");
  });

  test("an agent's view is its own rows and the Decisions, not the rest of the board", () => {
    const board = updateSwarmBoard(updateSwarmBoard(BOARD, { task: "T1", subtasks: [{ id: "T1.1", task: "sub" }] }), { task: "T3", findings: ["other agent's finding"] });
    const view = swarmBoardView(board, "T1");
    expect(view).toContain("| T1 | review math |");
    expect(view).toContain("| T1.1 | sub |");
    expect(view).not.toContain("T2");
    expect(view).not.toContain("other agent's finding");
    expect(view).toContain("Decisions:\n- Do not edit source files.");
    expect(swarmBoardView(board, "T7")).toContain("(no row for T7 yet)");
  });
});

describe("omnirush swarm plugin: board tool, notes and cleanup", () => {
  test("sub-agents update the board through the tool, one write at a time, and see only their rows", async () => {
    const { hooks, directory } = await setup();
    await created(hooks, "ses_main");
    await loadSwarmSkill(hooks, "ses_main");
    const tool = boardTool(hooks);
    expect(await tool.execute({ task: "T1", status: "running" })).toContain("No swarm board is running");
    await writeBoard(directory, BOARD);
    // Many agents at once: no update is lost.
    await Promise.all(["T1", "T2", "T3"].flatMap((task) => [
      tool.execute({ task, status: "done", result: `${task} ok` }),
      tool.execute({ task, findings: [`fact from ${task}`] }),
    ]));
    const board = await readFile(join(directory, OMNIRUSH_SWARM_FILE), "utf8");
    for (const task of ["T1", "T2", "T3"]) {
      expect(board).toContain(`| ${task} |`);
      expect(board).toContain(`| done | ${task} ok |`);
      expect(board).toContain(`- ${task}: fact from ${task}`);
    }
    const answer = await tool.execute({ task: "T2" });
    expect(answer).toContain("Board unchanged.");
    expect(answer).toContain("| T2 |");
    expect(answer).not.toContain("| T1 |");
    expect(answer.length).toBeLessThan(board.length);
  });

  test("a sub-agent's system note stays the same while the board changes (prompt cache)", async () => {
    const { hooks, directory } = await setup();
    await created(hooks, "ses_main");
    await created(hooks, "ses_child", "ses_main");
    await loadSwarmSkill(hooks, "ses_main");
    await writeBoard(directory, BOARD);
    const first = await systemOf(hooks)("ses_child");
    await boardTool(hooks).execute({ task: "T2", status: "running", findings: ["something"] });
    expect(await systemOf(hooks)("ses_child")).toBe(first);
    expect(first).not.toContain("| T2 |");
  });

  test("a board written with the model's own file tools is cut to the limits", async () => {
    const { hooks, directory } = await setup();
    await created(hooks, "ses_main");
    await writeBoard(directory, BOARD.replace("## Findings\n", `## Findings\n- T1: ${"y".repeat(2000)}\n`));
    await hooks["tool.execute.after"]({ tool: "edit", callID: "e1", args: { filePath: join(directory, OMNIRUSH_SWARM_FILE) } }, { output: "" });
    const board = await readFile(join(directory, OMNIRUSH_SWARM_FILE), "utf8");
    expect(board.length).toBeLessThan(BOARD.length + OMNIRUSH_SWARM_LINE_MAX_CHARS + 20);
    // Other files are never touched.
    await writeFile(join(directory, "notes.md"), `- T1: ${"y".repeat(2000)}\n`);
    await hooks["tool.execute.after"]({ tool: "write", callID: "w1", args: { filePath: join(directory, "notes.md") } }, { output: "" });
    expect((await readFile(join(directory, "notes.md"), "utf8")).length).toBeGreaterThan(2000);
  });

  test("the board is archived only once the main session and every sub-agent are idle", async () => {
    const { hooks, directory } = await setup();
    await created(hooks, "ses_main");
    await created(hooks, "ses_child", "ses_main");
    await loadSwarmSkill(hooks, "ses_main");
    await writeBoard(directory, BOARD);
    await busyStatus(hooks, "ses_main");
    await busyStatus(hooks, "ses_child");
    await idle(hooks, "ses_main");
    // A sub-agent is still running: the board stays.
    expect(existsSync(join(directory, OMNIRUSH_SWARM_FILE))).toBe(true);
    await idle(hooks, "ses_child");
    expect(existsSync(join(directory, OMNIRUSH_SWARM_FILE))).toBe(false);
    expect(await readdir(join(directory, ".omnirush", "swarms"))).toHaveLength(1);
  });

  test("a board left by an earlier engine run is archived when a turn ends, even without a swarm", async () => {
    const { hooks, directory } = await setup();
    await created(hooks, "ses_main");
    await writeBoard(directory, BOARD);
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(join(directory, OMNIRUSH_SWARM_FILE), old, old);
    await busyStatus(hooks, "ses_main");
    await idle(hooks, "ses_main");
    expect(existsSync(join(directory, OMNIRUSH_SWARM_FILE))).toBe(false);
    // A board written during this run by no swarm the plugin knows is left alone.
    await writeBoard(directory, BOARD);
    await idle(hooks, "ses_main");
    expect(existsSync(join(directory, OMNIRUSH_SWARM_FILE))).toBe(true);
  });

  test(`only the newest ${OMNIRUSH_SWARM_ARCHIVES_KEPT} archived boards are kept`, async () => {
    const { hooks, directory } = await setup();
    const archive = join(directory, ".omnirush", "swarms");
    await mkdir(archive, { recursive: true });
    const names = Array.from({ length: OMNIRUSH_SWARM_ARCHIVES_KEPT + 3 }, (_, i) => `20260101-0000${String(i).padStart(2, "0")}.md`);
    for (const name of names) await writeFile(join(archive, name), "# old\n");
    await writeFile(join(archive, "keep-me.txt"), "user file\n");
    await created(hooks, "ses_main");
    await loadSwarmSkill(hooks, "ses_main");
    await writeBoard(directory, BOARD);
    await idle(hooks, "ses_main");
    const left = await readdir(archive);
    expect(left).toContain("keep-me.txt");
    const boards = left.filter((name) => name.endsWith(".md"));
    expect(boards).toHaveLength(OMNIRUSH_SWARM_ARCHIVES_KEPT);
    expect(boards).not.toContain(names[0]);
    expect(boards).not.toContain(names[3]);
    expect(boards).toContain(names.at(-1)!);
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

  /** The account's catalog as the server knows it: ids and display names. */
  const testCatalog = [
    { id: "gpt-6-astra", name: "GPT 6 Astra" },
    { id: "gpt-6-luna", name: "GPT 6 Luna" },
    { id: "gpt-6-luna-mini", name: "GPT 6 Luna Mini" },
    { id: "omni-fast", name: "Omni Turbo" },
  ];
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
        if (url.pathname === "/omnirush/subagent-model/named") {
          const body = (await request.json()) as { text: string; model: string };
          return Response.json({ named: modelsNamedIn(body.text, [...testCatalog, { id: body.model }]).has(body.model) });
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
    const parents: Record<string, string | null> = { ses_main: null, ses_child: "ses_main", ses_grand: "ses_child", ses_other: "ses_main" };
    /** What the user typed last in the main session (the only session with a user). */
    const user = { text: "" };
    /** The model each session's record names (the 2.x engine's `{ id, providerID }`). */
    const sessionModels: Record<string, unknown> = {};
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: parents[path.id] ?? undefined, title: titles[path.id], model: sessionModels[path.id] } }),
        update: async ({ path, body }: { path: { id: string }; body: { title: string } }) => {
          titles[path.id] = body.title;
          return { data: {} };
        },
        messages: async ({ path }: { path: { id: string } }) => ({
          data: path.id === "ses_main"
            ? [
              { info: { role: "user" }, parts: [{ type: "text", text: "earlier: use gpt-6-luna" }] },
              { info: { role: "assistant" }, parts: [{ type: "text", text: "gpt-6-astra is the one" }] },
              { info: { role: "user" }, parts: [{ type: "text", text: user.text }, { type: "text", text: "gpt-6-nova", synthetic: true }] },
            ]
            : [],
        }),
      },
    };
    const hooks = await OmniRushSwarm({ client, directory });
    return { hooks, resolves, titles, user, sessionModels };
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

  test("a task's own model runs only when the user's latest message names it, and resolves in place of the setting", async () => {
    // The server echoes a requested model, else answers with the setting's pick (GPT 6 Sol).
    const { hooks, resolves, user } = await withServer((body) => {
      const requested = body.requested as { modelID: string; variant?: string | null } | undefined;
      return requested
        ? { model: { providerID: "omnirush", modelID: requested.modelID }, variant: requested.variant ?? "high" }
        : { model: { providerID: "omnirush", modelID: "gpt-6-sol" }, variant: "high" };
    });
    const task = async (sessionID: string, model: unknown) => {
      const output = { args: { description: "Research", prompt: "look", subagent_type: "general", ...(model === undefined ? {} : { model }) } as Record<string, unknown> };
      await hooks["tool.execute.before"]({ tool: "task", sessionID, callID: `call_${Math.random()}` }, output);
      return output.args.model;
    };
    const main = { providerID: "omnirush", modelID: "gpt-6-astra", variant: "max" };

    // Not named in the latest user message (an earlier message, the agent's text and synthetic parts do not count): dropped.
    user.text = "please research this with a sub-agent";
    await prompt(hooks, "ses_main", main);
    expect(await task("ses_main", "omnirush/gpt-6-luna")).toBeUndefined();
    expect(await task("ses_main", "omnirush/gpt-6-nova")).toBeUndefined();
    expect(await prompt(hooks, "ses_child", main)).toEqual({ providerID: "omnirush", modelID: "gpt-6-sol", variant: "high" });
    expect(resolves.at(-1)!.body.requested).toBeUndefined();

    // Named: kept (a bare id is an omnirush.ai model), and the sub-agent it starts resolves that model.
    user.text = "Use a sub-agent on GPT-6-Luna#low for this";
    await prompt(hooks, "ses_main", main);
    expect(await task("ses_main", "gpt-6-luna#low")).toBe("omnirush/gpt-6-luna#low");
    const luna = { providerID: "omnirush", modelID: "gpt-6-luna", variant: "low" };
    expect(await prompt(hooks, "ses_other", luna)).toEqual(luna);
    expect(resolves.at(-1)!.body.requested).toEqual(luna);
    // Its later prompts keep it; a sibling that inherited the main model still gets the setting.
    expect(await prompt(hooks, "ses_other", luna)).toEqual(luna);
    expect(resolves.at(-1)!.body.requested).toEqual(luna);
    expect(await prompt(hooks, "ses_child", main)).toEqual({ providerID: "omnirush", modelID: "gpt-6-sol", variant: "high" });

    // The display name the app shows counts too; a longer model's name names only that model.
    user.text = "Launch two reviewers: one on GPT 6 Astra and the other on gpt 6 luna";
    await prompt(hooks, "ses_main", main);
    expect(await task("ses_main", "omnirush/gpt-6-astra")).toBe("omnirush/gpt-6-astra");
    expect(await task("ses_main", "omnirush/gpt-6-luna")).toBe("omnirush/gpt-6-luna");
    user.text = "one reviewer on GPT 6 Luna Mini";
    await prompt(hooks, "ses_main", main);
    expect(await task("ses_main", "omnirush/gpt-6-luna")).toBeUndefined();
    expect(await task("ses_main", "omnirush/gpt-6-luna-mini")).toBe("omnirush/gpt-6-luna-mini");
    // A display name unlike its id counts through the account's catalog.
    user.text = "one reviewer on Omni Turbo";
    await prompt(hooks, "ses_main", main);
    expect(await task("ses_main", "omnirush/omni-fast")).toBe("omnirush/omni-fast");
    // Without the server (no catalog) only the id counts, in any spacing: "GPT 6 Astra" still names
    // gpt-6-astra, but "Omni Turbo" no longer names omni-fast.
    const url = process.env.OMNIRUSH_SERVER_URL;
    process.env.OMNIRUSH_SERVER_URL = "http://127.0.0.1:9";
    user.text = "one on GPT 6 Astra, one on Omni Turbo";
    await prompt(hooks, "ses_main", main);
    expect(await task("ses_main", "omnirush/gpt-6-astra")).toBe("omnirush/gpt-6-astra");
    expect(await task("ses_main", "omnirush/omni-fast")).toBeUndefined();
    process.env.OMNIRUSH_SERVER_URL = url;

    // A sub-agent's own task call never keeps a model (it has no user), nor does a malformed one.
    expect(await task("ses_child", "omnirush/gpt-6-luna")).toBeUndefined();
    expect(await task("ses_main", "not a model id")).toBeUndefined();
    expect(await task("ses_main", 42)).toBeUndefined();
    expect(await task("ses_main", undefined)).toBeUndefined();
  });

  test("a finished task names the model its sub-agent really ran on, not the call's dropped model", async () => {
    const { hooks, user, sessionModels } = await withServer(() => ({}));
    user.text = "research this with a sub-agent";
    await prompt(hooks, "ses_main", { providerID: "omnirush", modelID: "gpt-6-astra" });
    const args: Record<string, unknown> = { description: "Research", prompt: "look", subagent_type: "general", model: "omnirush/gpt-6-sol" };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_main", callID: "call_x" }, { args });
    expect(args.model).toBeUndefined();
    sessionModels.ses_child = { id: "gpt-6-astra", providerID: "omnirush", variant: "default" };
    await prompt(hooks, "ses_child", { providerID: "omnirush", modelID: "gpt-6-astra" });
    // The adapter's guess (the call's own model) is replaced by the session's model.
    const output = { output: "<task>done</task>", metadata: { sessionId: "ses_child", model: { providerID: "omnirush", modelID: "gpt-6-sol" } } as Record<string, unknown> };
    await hooks["tool.execute.after"]({ tool: "task", callID: "call_x" }, output);
    expect(output.metadata.model).toEqual({ providerID: "omnirush", modelID: "gpt-6-astra" });
  });

  test("a message names catalog models by id or display name, as whole words", () => {
    const catalog = [
      { id: "gpt-6-sol", name: "GPT 6 Sol" },
      { id: "gpt-6-sol-mini", name: "GPT 6 Sol Mini" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { id: "gpt-6-astra", name: "GPT 6 Astra" },
    ];
    const named = (text: string) => [...modelsNamedIn(text, catalog)].sort();
    expect(named("one reviewer on GPT 6 Astra and the other on GPT 6 Sol")).toEqual(["gpt-6-astra", "gpt-6-sol"]);
    expect(named("use gpt 6 sol")).toEqual(["gpt-6-sol"]);
    expect(named("use GPT_6_SOL please")).toEqual(["gpt-6-sol"]);
    expect(named("use GPT 6 Sol Mini")).toEqual(["gpt-6-sol-mini"]);
    expect(named("use gpt-6-sol-mini")).toEqual(["gpt-6-sol-mini"]);
    expect(named("try GPT-5.6 Sol, then gpt-5.6-sol")).toEqual(["gpt-5.6-sol"]);
    expect(named("use gpt-6 for this")).toEqual([]);
    expect(named("the solution uses astra-like ideas")).toEqual([]);
    expect(named("")).toEqual([]);
  });

  test("a model id is named only as a word of its own", () => {
    expect(textNamesModel("use gpt-6-astra please", "gpt-6-astra")).toBe(true);
    expect(textNamesModel("Use GPT-6-Astra.", "gpt-6-astra")).toBe(true);
    expect(textNamesModel("(gpt-6-astra)", "gpt-6-astra")).toBe(true);
    expect(textNamesModel("use gpt-6-astra-mini", "gpt-6-astra")).toBe(false);
    expect(textNamesModel("use gpt-6", "gpt-6-astra")).toBe(false);
    expect(textNamesModel("use my-gpt-6-astra", "gpt-6-astra")).toBe(false);
    expect(textNamesModel("use gpt-6-astra.2", "gpt-6-astra")).toBe(false);
    expect(textNamesModel("", "gpt-6-astra")).toBe(false);
    expect(textNamesModel(null, "gpt-6-astra")).toBe(false);
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
