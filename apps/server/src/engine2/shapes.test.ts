import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EventTranslator } from "./events.js";
import { partId, v1Messages, v1PermissionRequest, v1QuestionRequest, v1Session, v1ToolInput, v1ToolName, v2FormAnswer, v2ToolInput, type V1Message } from "./shapes.js";

/**
 * Fixtures: the same scripted conversations run on the 1.x engine (1.18.32)
 * and on the 2.x engine (2.0.18), read back with each engine's own API
 * (`v1-*.json`: `/session/:id/message`, `v2-*.json`: `/api/session/:id/message`),
 * machine paths replaced by /work. p1: shell, write, edit and a text answer;
 * sub: two parallel sub-agents; nest: sub-agents three layers deep; patch: a GPT-style
 * apply_patch (2.x `patch`) that updates one file and adds another; tools: glob and grep.
 */
type Tree = { session: Record<string, unknown>; messages: unknown[]; children: Tree[] };
const fixture = (name: string): Tree => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8"));

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/** Part types only the 2.x engine records (context records carried as parts, engine2/native.ts). */
const NATIVE_PART_TYPES = new Set(["agent-switched", "model-switched", "location-switched", "system", "idle"]);

/**
 * Every 1.x key path the adapter's record lacks or writes with another value
 * type ("only in 1.x" / type mismatches), and the key paths it adds (the 2.x
 * engine's own fields, "only in adapter"). Parts are paired after leaving out
 * the 2.x-only part types.
 */
function shapeDiff(a: unknown, b: unknown, path = "$", out: string[] = []): string[] {
  if (typeOf(a) !== typeOf(b)) {
    out.push(`${path}: ${typeOf(a)} != ${typeOf(b)}`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    let right = b;
    if (path.endsWith(".parts")) {
      const native = b.filter((part) => NATIVE_PART_TYPES.has(String((part as { type?: string }).type)));
      for (const part of native) out.push(`${path}[type=${(part as { type: string }).type}]: only in adapter`);
      right = b.filter((part) => !native.includes(part));
      const ta = a.map((part) => (part as { type?: string }).type).join(",");
      const tb = right.map((part) => (part as { type?: string }).type).join(",");
      if (ta !== tb) out.push(`${path}: part types [${ta}] != [${tb}]`);
    }
    if (a.length !== right.length) out.push(`${path}: length ${a.length} != ${right.length}`);
    for (let index = 0; index < Math.min(a.length, right.length); index++) shapeDiff(a[index], right[index], `${path}[${index}]`, out);
    return out;
  }
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    for (const key of ka) if (!kb.includes(key)) out.push(`${path}.${key}: only in 1.x`);
    for (const key of kb) if (!ka.includes(key)) out.push(`${path}.${key}: only in adapter`);
    for (const key of ka) if (kb.includes(key)) shapeDiff((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`, out);
  }
  return out;
}

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
}

/** The 1.x problems of a diff: whatever is not an addition. */
const regressions = (diff: string[]) => diff.filter((line) => !line.endsWith(": only in adapter"));

function mapTree(tree: Tree, parentModel?: { providerID: string; modelID: string }): { messages: V1Message[]; children: Array<ReturnType<typeof mapTree>> } {
  const session = tree.session as { id: string; parentID?: string; location?: { directory?: string } };
  const messages = v1Messages(tree.messages, {
    sessionID: session.id,
    directory: session.location?.directory,
    root: "/",
    model: parentModel,
    child: Boolean(session.parentID),
  });
  return { messages, children: tree.children.map((child) => mapTree(child, parentModel)) };
}

type Mapped = ReturnType<typeof mapTree>;
/** Sub-agents start concurrently: children are paired by the task they were given. */
const taskOf = (messages: unknown[]): string => {
  const first = messages[0] as { parts?: Array<{ text?: string }> } | undefined;
  return String(first?.parts?.[0]?.text ?? "");
};

function compareTrees(v1: Tree, mapped: Mapped, path: string, out: string[]): void {
  shapeDiff(v1.messages, mapped.messages, `${path}.messages`, out);
  if (v1.children.length !== mapped.children.length) out.push(`${path}: children ${v1.children.length} != ${mapped.children.length}`);
  const left = [...v1.children].sort((a, b) => taskOf(a.messages).localeCompare(taskOf(b.messages)));
  const right = [...mapped.children].sort((a, b) => taskOf(a.messages).localeCompare(taskOf(b.messages)));
  left.forEach((child, index) => {
    if (right[index]) compareTrees(child, right[index]!, `${path}.child[${index}]`, out);
  });
}

describe("2.x messages in the 1.x shape (uploaded trace parity)", () => {
  for (const scenario of ["p1", "sub", "nest", "patch", "tools"]) {
    test(`${scenario}: every message, part and field the 1.x engine wrote, in its place and shape`, () => {
      const out: string[] = [];
      compareTrees(fixture(`v1-${scenario}`), mapTree(fixture(`v2-${scenario}`)), "root", out);
      expect(regressions(out)).toEqual([]);
    });
  }

  test("p1: the uploaded messages, field for field", () => {
    const [user, first, second, third, answer] = mapTree(fixture("v2-p1")).messages;
    // 1.x fields, exactly; the 2.x engine's own fields sit next to them (next test).
    expect(pick(user!.info, ["id", "sessionID", "role", "time", "summary", "agent", "model"])).toEqual({
      id: "msg_0e0eb02300010Ie6K3lQAqUici",
      sessionID: "ses_f1f14fdf6ffe32y5eLxrDN6MFs",
      role: "user",
      time: { created: 1790479893113 },
      summary: { diffs: [] },
      agent: "build",
      model: { providerID: "mock", modelID: "mock-model" },
    });
    expect(user!.parts.map((part) => pick(part, ["id", "sessionID", "messageID", "type", "text"]))).toEqual([{
      id: "prt_0e0eb02300010Ie6K3lQAqUici_u0",
      sessionID: "ses_f1f14fdf6ffe32y5eLxrDN6MFs",
      messageID: "msg_0e0eb02300010Ie6K3lQAqUici",
      type: "text",
      text: "PARITY-1 create the notes file",
    }]);
    expect(pick(first!.info, ["id", "sessionID", "role", "time", "parentID", "modelID", "providerID", "mode", "agent", "path", "cost", "tokens", "finish"])).toEqual({
      id: "msg_0e0eb029c001Gb432955hHZq2J",
      sessionID: "ses_f1f14fdf6ffe32y5eLxrDN6MFs",
      role: "assistant",
      time: { created: 1790479893170, completed: 1790479893443, streamed: 1790479893305 },
      parentID: "msg_0e0eb02300010Ie6K3lQAqUici",
      modelID: "mock-model",
      providerID: "mock",
      mode: "build",
      agent: "build",
      path: { cwd: "/work/proj", root: "/" },
      cost: 0,
      tokens: { total: 1242, input: 202, output: 28, reasoning: 12, cache: { read: 1000, write: 0 } },
      finish: "tool-calls",
    });
    expect(first!.parts.map((part) => part.type)).toEqual(["step-start", "reasoning", "tool", "step-finish"]);
    expect(pick(first!.parts[2]!, ["id", "sessionID", "messageID", "type", "callID", "tool", "state"])).toEqual({
      id: "prt_0e0eb029c001Gb432955hHZq2J_c_call_2_0",
      sessionID: "ses_f1f14fdf6ffe32y5eLxrDN6MFs",
      messageID: "msg_0e0eb029c001Gb432955hHZq2J",
      type: "tool",
      callID: "call_2_0",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "ls -a", description: "List files" },
        output: ".\n..\n",
        title: "List files",
        metadata: { output: ".\n..\n", truncated: false, exit: 0, status: "completed" },
        time: { start: 1790479893299, end: 1790479893435 },
        content: [{ type: "text", text: ".\n..\n" }],
      },
    });
    expect(first!.parts[3]).toEqual({
      id: "prt_0e0eb029c001Gb432955hHZq2J_f0",
      sessionID: "ses_f1f14fdf6ffe32y5eLxrDN6MFs",
      messageID: "msg_0e0eb029c001Gb432955hHZq2J",
      type: "step-finish",
      reason: "tool-calls",
      cost: 0,
      tokens: { total: 1242, input: 202, output: 28, reasoning: 12, cache: { read: 1000, write: 0 } },
    });
    const write = second!.parts.find((part) => part.type === "tool") as { tool: string; state: { input: unknown; metadata: unknown; title: string } };
    expect(write.tool).toBe("write");
    expect(write.state.input).toEqual({ filePath: "/work/proj/notes.md", content: "# Notes\nline one\n" });
    expect(pick(write.state.metadata as Record<string, unknown>, ["diagnostics", "filepath", "exists", "truncated"])).toEqual({ diagnostics: {}, filepath: "/work/proj/notes.md", exists: false, truncated: false });
    expect(write.state.title).toBe("work/proj/notes.md");
    const edit = third!.parts.find((part) => part.type === "tool") as { tool: string; state: { input: unknown; metadata: Record<string, unknown> } };
    expect(edit.tool).toBe("edit");
    expect(edit.state.input).toEqual({ filePath: "/work/proj/notes.md", oldString: "line one", newString: "line one\nline two" });
    expect(Object.keys(edit.state.metadata)).toEqual(["diagnostics", "diff", "filediff", "truncated", "files"]);
    expect(edit.state.metadata.filediff).toMatchObject({ file: "/work/proj/notes.md", additions: 1, deletions: 0 });
    // The turn's 2.x idle marker (its outcome) closes the last reply as a part of its own type.
    expect(answer!.parts.map((part) => part.type)).toEqual(["step-start", "reasoning", "text", "step-finish", "idle"]);
    expect(answer!.info.finish).toBe("stop");
  });

  test("sub: task calls name their child sessions the way the 1.x engine did", () => {
    const tree = fixture("v2-sub");
    const mapped = mapTree(tree, { providerID: "mock", modelID: "mock-model" });
    const tasks = mapped.messages.flatMap((message) => message.parts).filter((part) => part.type === "tool") as Array<{ tool: string; state: { input: Record<string, unknown>; output: string; metadata: Record<string, unknown> } }>;
    expect(tasks.map((task) => task.tool)).toEqual(["task", "task"]);
    expect(tasks[0]!.state.input).toEqual({ subagent_type: "general", description: "Read notes", prompt: "CHILD-A: read notes.md and summarise it" });
    const children = tree.children.map((child) => (child.session as { id: string }).id);
    expect(tasks.map((task) => task.state.metadata.sessionId).sort()).toEqual([...children].sort());
    expect(tasks[0]!.state.metadata).toMatchObject({ parentSessionId: (tree.session as { id: string }).id, model: { modelID: "mock-model", providerID: "mock" }, truncated: false });
    expect(tasks[0]!.state.output).toMatch(/^<task id="ses_[^"]+" state="completed">\n<task_result>\n[\s\S]+\n<\/task_result>\n<\/task>$/);
    // A child's first message is the task the parent wrote, without the 2.x preamble.
    const firstChildUser = mapped.children[0]!.messages[0]!;
    expect(firstChildUser.info.role).toBe("user");
    expect((firstChildUser.parts[0] as { text: string }).text).toMatch(/^CHILD-/);
  });

  test("sessions carry the 1.x fields (child titles name their sub-agent)", () => {
    const tree = fixture("v2-sub");
    const child = v1Session(tree.children[0]!.session, { version: "2.0.18" })!;
    expect(child.title).toMatch(/ \(@general subagent\)$/);
    expect(child.parentID).toBe((tree.session as { id: string }).id);
    expect(child.permission).toEqual([]);
    expect(Object.keys(child).sort()).toEqual(
      ["agent", "cost", "directory", "id", "parentID", "path", "permission", "projectID", "slug", "summary", "time", "title", "tokens", "version"].sort(),
    );
  });
});

describe("the 2.x engine's own fields ride along (additive)", () => {
  test("p1: step, tool and turn records keep what 2.x recorded", () => {
    const [user, first, , third, answer] = mapTree(fixture("v2-p1")).messages;
    expect(user!.info).toMatchObject({ type: "user", text: "PARITY-1 create the notes file" });
    expect(first!.info).toMatchObject({
      type: "assistant",
      model: { id: "mock-model", providerID: "mock" },
      rawFinish: "tool_calls",
      time: { created: 1790479893170, streamed: 1790479893305, completed: 1790479893443 },
    });
    const shell = first!.parts[2] as Record<string, any>;
    expect(shell).toMatchObject({
      tool: "bash",
      name: "shell",
      executed: false,
      time: { created: 1790479893236, ran: 1790479893299, completed: 1790479893435 },
      state: { content: [{ type: "text", text: ".\n..\n" }], metadata: { status: "completed" } },
    });
    const reasoning = first!.parts[1] as Record<string, any>;
    expect(reasoning).toMatchObject({ state: { reasoningField: "reasoning_content" }, time: { created: 1790479893188, completed: 1790479893285 } });
    const edit = third!.parts.find((part) => part.type === "tool") as Record<string, any>;
    // Native input keys the 1.x input names differently, and the native file list.
    expect(edit.state.v2).toEqual({ input: { path: "/work/proj/notes.md" } });
    expect(edit.state.metadata.files[0]).toMatchObject({ file: "notes.md", status: "modified", additions: 1, deletions: 0 });
    // The turn's idle marker, with its outcome.
    expect(answer!.parts.at(-1)).toEqual({
      id: "msg_0e0eb0600001Z6P4VHgDiDmR03",
      time: { created: 1790479894016 },
      type: "idle",
      outcome: "succeeded",
      sessionID: "ses_f1f14fdf6ffe32y5eLxrDN6MFs",
      messageID: answer!.info.id,
    });
  });

  test("patch: the model switch before the prompt and the native patch file list", () => {
    const [user, reply] = mapTree(fixture("v2-patch")).messages;
    expect(user!.parts[0]).toMatchObject({ type: "model-switched", model: { id: "gpt-5.1-mock", providerID: "mock" }, messageID: user!.info.id });
    const patch = reply!.parts.find((part) => part.type === "tool") as Record<string, any>;
    expect(patch.name).toBe("patch");
    expect(patch.state.metadata.files.map((file: Record<string, unknown>) => file.relativePath)).toEqual(["work/proj/notes.md", "work/proj/extra.md"]);
    expect(patch.state.metadata.v2.files.map((file: Record<string, unknown>) => [file.file, file.status])).toEqual([["notes.md", "modified"], ["extra.md", "added"]]);
    expect(reply!.info).toMatchObject({ model: { id: "gpt-5.1-mock", providerID: "mock", variant: "default" } });
    expect(reply!.info.variant).toBeUndefined();
  });

  test("provider state, snapshots and errors: 1.x values in place, 2.x values next to them", () => {
    const [message] = v1Messages([{
      id: "msg_x",
      type: "assistant",
      agent: "build",
      model: { id: "gpt-6-astra", providerID: "omnirush", variant: "default" },
      snapshot: { start: "aaa", end: "bbb", files: ["math.js"] },
      providerState: { responseId: "resp_1", serviceTier: "default" },
      error: { type: "provider.rate-limit", message: "slow down", status: 429 },
      retry: { attempt: 1, at: 5, error: { type: "provider.rate-limit", message: "slow down" } },
      content: [
        { type: "text", text: "hi", state: { itemId: "msg_item", phase: "final_answer" } },
        {
          type: "tool", id: "call_1", name: "browser_observe", executed: true, providerState: { itemId: "fc_1" }, providerResultState: { ok: 1 },
          state: { status: "completed", input: {}, content: [{ type: "text", text: "seen" }, { type: "file", uri: "data:image/png;base64,QUJD", mime: "image/png" }], metadata: {} },
          time: { created: 1, ran: 2, completed: 3 },
        },
      ],
      finish: "stop",
      time: { created: 1, completed: 4 },
    }], { sessionID: "ses_1", directory: "/work", root: "/work" });
    expect(message!.info).toMatchObject({
      error: { name: "APIError", data: { message: "slow down", statusCode: 429, isRetryable: true }, type: "provider.rate-limit", message: "slow down", status: 429 },
      snapshot: { start: "aaa", end: "bbb", files: ["math.js"] },
      providerState: { responseId: "resp_1", serviceTier: "default" },
      retry: { attempt: 1 },
    });
    const text = message!.parts.find((part) => part.type === "text")!;
    expect(text).toMatchObject({ metadata: { openai: { itemId: "msg_item", phase: "final_answer" } }, state: { itemId: "msg_item", phase: "final_answer" } });
    const tool = message!.parts.find((part) => part.type === "tool") as Record<string, any>;
    expect(tool).toMatchObject({ metadata: { openai: { itemId: "fc_1" } }, providerState: { itemId: "fc_1" }, providerResultState: { ok: 1 }, executed: true });
    // The screenshot's bytes are in state.attachments once; the native content points at them.
    expect(tool.state.attachments[0].url).toBe("data:image/png;base64,QUJD");
    expect(tool.state.content[1]).toEqual({ type: "file", uri: "sameAs:state.attachments[0].url", mime: "image/png" });
    expect(message!.parts.map((part) => part.type)).toEqual(["step-start", "text", "tool", "step-finish", "patch"]);
  });

  test("a prompt's image is written once; the native file entry keeps its other fields", () => {
    const [message] = v1Messages([{
      id: "msg_u", type: "user", text: "look", time: { created: 1 },
      files: [{ uri: "data:image/png;base64,QUJD", name: "a.png", mention: { start: 0, end: 4 } }],
    }], { sessionID: "ses_1" });
    const file = message!.parts.find((part) => part.type === "file")!;
    expect(file).toMatchObject({ url: "data:image/png;base64,QUJD", filename: "a.png", name: "a.png", mention: { start: 0, end: 4 } });
    expect(file.uri).toBeUndefined();
    expect(message!.info).toMatchObject({ type: "user", text: "look", files: [{ uri: "sameAs:parts[1].url", name: "a.png" }] });
  });
});

describe("prompts with synthetic notes", () => {
  const note = "Attached files were copied into this worker workspace for tool access:\n- image.png: .opencode/omnirush/inbox/chat-attachments/s/1-image.png (file:///home/u/p/.opencode/omnirush/inbox/chat-attachments/s/1-image.png)";
  const metadata = { omnirushAttachments: [] };
  const payload = {
    id: "msg_note",
    text: `${note}\n\nhi`,
    files: [{ uri: "data:image/png;base64,AAAA", name: "image.png", mime: "image/png" }],
    metadata: { omnirush: { agent: "build", textParts: [{ length: note.length, synthetic: true, metadata }, { length: 2 }] } },
  };
  const expected = [
    { id: partId("msg_note", "u0"), type: "text", text: note, synthetic: true, metadata },
    { id: partId("msg_note", "u1"), type: "text", text: "hi" },
    { id: partId("msg_note", "f0"), type: "file", filename: "image.png", url: "data:image/png;base64,AAAA" },
  ];

  test("read back: the typed prompt is its own text part, the note a synthetic part", () => {
    const [message] = v1Messages([{ type: "user", time: { created: 1 }, ...payload }], { sessionID: "ses_n", directory: "/w", root: "/" });
    expect(message!.parts).toMatchObject(expected);
    expect(message!.parts[1]!.synthetic).toBeUndefined();
    expect(message!.parts).toHaveLength(3);
  });

  test("live: the enqueued prompt shows the same parts", async () => {
    const translator = new EventTranslator({ version: "2.0.18" });
    const out = await translator.translate({ type: "session.inbox.enqueued", data: { sessionID: "ses_n", inboxID: "msg_note", item: { type: "user", payload } } });
    const parts = out.filter((item) => item.event.type === "message.part.updated").map((item) => item.event.properties.part);
    expect(parts).toMatchObject(expected);
  });

  test("an image the engine keeps inline reads back as its data: URL, bytes not repeated", () => {
    const inline = { data: "AAAA", mime: "image/png", source: { type: "inline" }, name: "image.png" };
    const tree = { type: "user", time: { created: 1 }, ...payload, files: [inline] };
    const [message] = v1Messages([tree], { sessionID: "ses_n", directory: "/w", root: "/" });
    expect(message!.parts).toMatchObject(expected);
    expect(JSON.stringify(message).match(/AAAA/g)).toHaveLength(1);
    // The engine's inline source is not a 1.x file source (the UI would render it as a document).
    expect(message!.parts[2]!.source).toBeUndefined();
    expect(message!.parts[2]!.data).toBeUndefined();
  });

  test("a text that no longer matches the layout stays one part", () => {
    const [message] = v1Messages([{ type: "user", time: { created: 1 }, ...payload, text: "edited" }], { sessionID: "ses_n", directory: "/w", root: "/" });
    expect(message!.parts.filter((part) => part.type === "text")).toMatchObject([{ text: "edited" }]);
    expect(message!.parts[0]!.synthetic).toBeUndefined();
  });
});

describe("live events and read-back agree", () => {
  test("parts built from the 2.x stream carry the ids and fields of the same parts read back", async () => {
    const tree = fixture("v2-sub");
    const translator = new EventTranslator({ version: "2.0.18" });
    const events = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "v2-sub-events.json"), "utf8")) as unknown[];
    const live = new Map<string, Record<string, unknown>>();
    const types = new Set<string>();
    for (const event of events) {
      for (const item of await translator.translate(event)) {
        types.add(item.event.type);
        if (item.event.type === "message.part.updated") {
          const part = item.event.properties.part as Record<string, unknown>;
          live.set(String(part.id), part);
        }
      }
    }
    for (const type of ["session.created", "message.updated", "message.part.updated", "message.part.delta", "session.status", "session.idle"]) {
      expect(types.has(type)).toBe(true);
    }
    const read = mapTree(tree, { providerID: "mock", modelID: "mock-model" });
    const all = [read, ...read.children].flatMap((node) => node.messages.flatMap((message) => message.parts));
    const assistantParts = all.filter((part) => String(part.id).startsWith("prt_") && (part.type !== "text" || !String(part.id).endsWith("_u0")));
    expect(assistantParts.length).toBeGreaterThan(10);
    for (const part of assistantParts) {
      const seen = live.get(String(part.id));
      expect(seen).toBeDefined();
      expect(seen!.type).toBe(part.type);
      if (part.type === "tool") {
        expect((seen!.state as { status: string }).status).toBe("completed");
        expect(seen!.tool).toBe(part.tool);
      }
    }
  });

  test("a read of running sub-agent calls names their child sessions, as their progress did", async () => {
    // The 2.x engine's read of a running subagent call leaves out the child session; only the
    // call's progress events name it. A re-read (the app reloads the session's messages) used to
    // drop the child from the task card until the call ended.
    const tree = fixture("v2-sub");
    const parent = (tree.session as { id: string }).id;
    const running = JSON.parse(JSON.stringify(tree.messages)) as Array<Record<string, unknown>>;
    for (const message of running) {
      for (const entry of (Array.isArray(message.content) ? message.content : []) as Array<Record<string, any>>) {
        if (entry.type === "tool" && entry.name === "subagent") entry.state = { status: "running", input: entry.state.input, metadata: {} };
      }
    }
    const translator = new EventTranslator({ version: "2.0.18" });
    const events = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "v2-sub-events.json"), "utf8")) as Array<{ type: string; data: Record<string, any> }>;
    const progressed = new Map<string, string>();
    for (const event of events) {
      await translator.translate(event);
      if (event.type === "session.tool.progress" && event.data.sessionID === parent && typeof event.data.metadata?.sessionID === "string") {
        progressed.set(String(event.data.id), event.data.metadata.sessionID);
      }
      if (event.type === "session.tool.success") break;
    }
    expect(progressed.size).toBe(2);
    const read = (childSessionOf?: (callID: string) => string | undefined) =>
      (v1Messages(running, { sessionID: parent, directory: "/work/proj", root: "/", model: { providerID: "mock", modelID: "mock-model" }, childSessionOf })
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool") as Array<{ callID: string; tool: string; state: { status: string; metadata: Record<string, unknown> } }>);

    const tasks = read((callID) => translator.childSessionOf(parent, callID));
    expect(tasks.map((task) => [task.tool, task.state.status])).toEqual([["task", "running"], ["task", "running"]]);
    for (const task of tasks) expect(task.state.metadata.sessionId).toBe(progressed.get(task.callID));
    // Without the progress it was read with no child (the bug), and a stored child is never replaced.
    expect(read().map((task) => task.state.metadata.sessionId)).toEqual([undefined, undefined]);
    const stored = JSON.parse(JSON.stringify(running)) as Array<Record<string, any>>;
    for (const message of stored) for (const entry of message.content ?? []) if (entry.type === "tool") entry.state.metadata = { sessionID: "ses_stored" };
    const kept = v1Messages(stored, { sessionID: parent, childSessionOf: () => "ses_from_progress" }).flatMap((message) => message.parts).filter((part) => part.type === "tool") as Array<{ state: { metadata: Record<string, unknown> } }>;
    expect(kept.map((task) => task.state.metadata.sessionId)).toEqual(["ses_stored", "ses_stored"]);
    // Only this session's calls: another session's call of the same id names no child.
    expect(translator.childSessionOf("ses_other", tasks[0]!.callID)).toBeUndefined();
  });

  test("a sub-agent call's child is remembered only until the engine's own record names it", async () => {
    const translator = new EventTranslator({ version: "2.0.18" });
    const progress = (sessionID: string, id: string, child: string) =>
      translator.translate({ type: "session.tool.progress", data: { sessionID, id, metadata: { sessionID: child, status: "running" } } });
    await progress("ses_p", "call_ok", "ses_c1");
    await progress("ses_p", "call_bad", "ses_c2");
    await progress("ses_p", "call_bad_named", "ses_c3");
    await progress("ses_q", "call_other", "ses_c4");

    // Success names the child (the engine stores it from then on): forgotten.
    await translator.translate({ type: "session.tool.success", data: { sessionID: "ses_p", id: "call_ok", metadata: { sessionID: "ses_c1", status: "completed" } } });
    expect(translator.childSessionOf("ses_p", "call_ok")).toBeUndefined();
    // A failure that does not name the child keeps it, so its card stays linked.
    await translator.translate({ type: "session.tool.failed", data: { sessionID: "ses_p", id: "call_bad", error: "aborted" } });
    expect(translator.childSessionOf("ses_p", "call_bad")).toBe("ses_c2");
    // A failure that names it is forgotten like a success.
    await translator.translate({ type: "session.tool.failed", data: { sessionID: "ses_p", id: "call_bad_named", error: "boom", metadata: { sessionID: "ses_c3" } } });
    expect(translator.childSessionOf("ses_p", "call_bad_named")).toBeUndefined();

    // Deleting the parent session forgets its calls, and only its calls.
    await translator.translate({ type: "session.deleted", data: { sessionID: "ses_p" } });
    expect(translator.childSessionOf("ses_p", "call_bad")).toBeUndefined();
    expect(translator.childSessionOf("ses_q", "call_other")).toBe("ses_c4");
  });

  test("busy and idle come from the execution lifecycle", async () => {
    const translator = new EventTranslator({ version: "2.0.18" });
    const started = await translator.translate({ type: "session.execution.started", data: { sessionID: "ses_a" } });
    expect(started.map((item) => item.event)).toEqual([{ type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } }]);
    expect(translator.statuses()).toEqual({ ses_a: { type: "busy" } });
    const done = await translator.translate({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } });
    expect(done.map((item) => item.event.type)).toEqual(["session.status", "session.idle"]);
    expect(translator.statuses()).toEqual({});
  });
});

describe("tool names, inputs, permissions and questions", () => {
  test("names and inputs map both ways", () => {
    expect(v1ToolName("shell")).toBe("bash");
    expect(v1ToolName("subagent")).toBe("task");
    expect(v1ToolName("patch")).toBe("apply_patch");
    expect(v1ToolName("webfetch")).toBe("webfetch");
    expect(v1ToolInput("read", { path: "/a", offset: 2 })).toEqual({ filePath: "/a", offset: 2 });
    expect(v1ToolInput("subagent", { agent: "general", prompt: "x", description: "d" })).toEqual({ subagent_type: "general", prompt: "x", description: "d" });
    expect(v1ToolInput("edit", '{"path":"/a","oldString":"x","newString":"y"}')).toEqual({ filePath: "/a", oldString: "x", newString: "y" });
    expect(v2ToolInput("task", { subagent_type: "general", prompt: "x" })).toEqual({ agent: "general", prompt: "x" });
    expect(v2ToolInput("write", { filePath: "/a", content: "c" })).toEqual({ path: "/a", content: "c" });
  });

  test("a 2.x permission request becomes the 1.x request", () => {
    expect(v1PermissionRequest({
      id: "per_1", sessionID: "ses_1", action: "shell", resources: ["git push"], save: ["git push *"],
      metadata: { command: "git push" }, source: { type: "tool", messageID: "msg_1", id: "call_1" },
    })).toEqual({
      id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["git push"], metadata: { command: "git push" },
      always: ["git push *"], tool: { messageID: "msg_1", callID: "call_1" },
    });
  });

  test("question forms map to 1.x questions and answers map back", () => {
    const mapping = v1QuestionRequest({
      id: "frm_1", sessionID: "ses_1",
      fields: [{ key: "color", type: "multiselect", title: "Color", description: "Pick colors", options: [{ value: "r", label: "Red", description: "" }, { value: "g", label: "Green", description: "" }] }],
    })!;
    expect(mapping.request).toEqual({
      id: "frm_1", sessionID: "ses_1",
      questions: [{ question: "Pick colors", header: "Color", options: [{ label: "Red", description: "" }, { label: "Green", description: "" }], multiple: true }],
    });
    expect(v2FormAnswer(mapping.fields, [["Green"]])).toEqual({ color: ["g"] });
  });

  test("part ids are stable per message slot", () => {
    expect(partId("msg_abc", "t0")).toBe("prt_abc_t0");
    expect(partId("msg_abc", "c", "call_9")).toBe("prt_abc_c_call_9");
  });
});
