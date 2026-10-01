import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createManagedOpencodeServer, type ManagedOpencodeServer } from "../managed-opencode.js";
import { OMNIRUSH_AGENT_PROMPT } from "../omnirush-agent-prompt.js";
import { OMNIRUSH_TASK_TOOL_NOTE, omnirushSubagentNote } from "../omnirush-swarm.js";

/**
 * omnirush.ai's delegation rules reach the model on the real 2.x engine (the
 * bundled sidecar with the plugin bridge) against a mock provider:
 *
 *   - the main session's request carries the restraint wording of the agent
 *     prompt and the subagent tool's description ends with omnirush.ai's note,
 *     and it gets no sub-agent note;
 *   - a sub-agent session's request carries the sub-agent note (system).
 *
 * Skipped when the sidecar binary is not present (prepare:sidecar not run).
 */

const repoRoot = resolve(import.meta.dir, "../../../..");
const sidecarDir = join(repoRoot, "apps/desktop/resources/sidecars");
function findSidecar(): string | null {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const name = process.platform === "darwin" ? `opencode-${arch}-apple-darwin` : process.platform === "linux" ? `opencode-${arch}-unknown-linux-gnu` : "";
  const candidate = join(sidecarDir, name);
  return name && existsSync(candidate) ? candidate : null;
}
const enginePath = findSidecar();
const describeMaybe = enginePath ? describe : describe.skip;

type Body = { messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ type: string; function: { name: string; description?: string } }>; stream?: boolean };

const CHILD_MARK = "CHILD-TASK-7f3a";
const SUB_NOTE_MARK = "You are a sub-agent (layer";

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n");
}
const systemOf = (body: Body) => (body.messages ?? []).filter((message) => message.role === "system").map((message) => text(message.content)).join("\n");
const allText = (body: Body) => (body.messages ?? []).map((message) => text(message.content)).join("\n");
const hasToolResult = (body: Body) => (body.messages ?? []).some((message) => message.role === "tool");
/** A sub-agent's request: its user message is the task the main session wrote. */
const isChild = (body: Body) => (body.messages ?? []).some((message) => message.role === "user" && text(message.content).includes(CHILD_MARK));

function sse(chunks: object[]): Response {
  const frame = (payload: object) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", ...payload })}\n\n`;
  const body = chunks.map((choice) => frame({ choices: [choice] })).join("")
    + frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })
    + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
const say = (content: string) => sse([{ index: 0, delta: { role: "assistant", content } }, { index: 0, delta: {}, finish_reason: "stop" }]);
const callSubagent = () => sse([
  { index: 0, delta: { role: "assistant", content: "" } },
  { index: 0, delta: { tool_calls: [{ index: 0, id: "call_sub_1", type: "function", function: { name: "subagent", arguments: JSON.stringify({ agent: "general", description: "Child part", prompt: `${CHILD_MARK}: reply with one word.` }) } }] } },
  { index: 0, delta: {}, finish_reason: "tool_calls" },
]);

describeMaybe("delegation rules on the 2.x engine (mock provider)", () => {
  let engine: ManagedOpencodeServer;
  let provider: ReturnType<typeof Bun.serve>;
  let work = "";
  let data = "";
  const seen: Body[] = [];

  const engineFetch = async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`);
    headers.set("x-opencode-directory", encodeURIComponent(work));
    return fetch(`${engine.url}${path}`, { ...init, headers });
  };
  const waitFor = async <T>(read: () => T | null | undefined | false, label: string, ms = 90_000): Promise<T> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value as T;
      await Bun.sleep(250);
    }
    throw new Error(`timed out waiting for ${label}; seen ${seen.length} requests`);
  };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "restraint-ws-"));
    data = mkdtempSync(join(tmpdir(), "restraint-data-"));
    provider = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Body) : {};
        if (url.pathname.startsWith("/managed-policy")) return Response.json({ allowed: true, approvalMode: "full" });
        if (!url.pathname.startsWith("/v1/")) return Response.json({});
        const withTools = Array.isArray(body.tools) && body.tools.length > 0;
        if (!withTools) return say("Restraint title");
        seen.push(body);
        if (isChild(body)) return say("Done.");
        if (hasToolResult(body)) return say("All done.");
        return callSubagent();
      },
    });
    const base = `http://127.0.0.1:${provider.port}`;
    const configPath = join(data, "runtime-opencode-config.json");
    writeFileSync(configPath, JSON.stringify({
      model: "mock/mock-model",
      default_agent: "omnirush",
      agent: { omnirush: { mode: "primary", prompt: OMNIRUSH_AGENT_PROMPT } },
      permission: { "*": "allow" },
      provider: {
        mock: { name: "Mock", npm: "@ai-sdk/openai-compatible", options: { baseURL: `${base}/v1`, apiKey: "mock-key" }, models: { "mock-model": { name: "Mock", tool_call: true, limit: { context: 100_000, output: 4_000 } } } },
      },
    }));
    engine = await createManagedOpencodeServer({
      bin: enginePath!,
      cwd: work,
      env: {
        OPENCODE_CONFIG: configPath,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OMNIRUSH_ENGINE2_CONFIG_DIR: join(data, "engine2"),
        OMNIRUSH_SERVER_URL: base,
        OMNIRUSH_POLICY_TOKEN: "policy",
        OMNIRUSH_SERVER_TOKEN: "server",
        HOME: join(data, "home"),
        OPENCODE_TEST_HOME: join(data, "home"),
        XDG_DATA_HOME: join(data, "xdg-data"),
        XDG_CONFIG_HOME: join(data, "xdg-config"),
        XDG_STATE_HOME: join(data, "xdg-state"),
        XDG_CACHE_HOME: join(data, "xdg-cache"),
      },
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(await engineFetch("/session").then((response) => response.ok).catch(() => false))) await Bun.sleep(250);
  }, 120_000);

  afterAll(async () => {
    await engine?.close();
    provider?.stop(true);
    rmSync(work, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }, 30_000);

  test("the main request carries the prompt rules and the subagent tool note; the sub-agent's carries the sub-agent note", async () => {
    const session = (await (await engineFetch("/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { id: string };
    const sent = await engineFetch(`/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: { providerID: "mock", modelID: "mock-model" }, parts: [{ type: "text", text: "Use 1 sub-agent to say hi." }] }),
    });
    expect(sent.status).toBe(204);

    const main = await waitFor(() => seen.find((body) => !isChild(body)), "the main session's request");
    const mainSystem = systemOf(main);
    expect(mainSystem).toContain("Do the work yourself by default. Use sub-agents only when the user explicitly asks for them.");
    expect(mainSystem).not.toContain("Split real work");
    expect(mainSystem).toContain("make exactly that many subagent calls, no more and no fewer, and start them all in one message");
    expect(mainSystem).toContain("Tell a sub-agent to start its own sub-agents only when the user explicitly asked for nested sub-agents.");
    expect(mainSystem).not.toContain(SUB_NOTE_MARK);
    const mainTool = main.tools!.find((tool) => tool.function.name === "subagent");
    expect(mainTool).toBeDefined();
    expect(mainTool!.function.description!.endsWith(OMNIRUSH_TASK_TOOL_NOTE)).toBe(true);
    expect(mainTool!.function.description!.split(OMNIRUSH_TASK_TOOL_NOTE)).toHaveLength(2);

    const child = await waitFor(() => seen.find(isChild), "the sub-agent's request");
    expect(systemOf(child)).toContain(omnirushSubagentNote(1));
    const childTool = child.tools!.find((tool) => tool.function.name === "subagent");
    if (childTool) expect(childTool.function.description!.endsWith(OMNIRUSH_TASK_TOOL_NOTE)).toBe(true);
  }, 150_000);
});
