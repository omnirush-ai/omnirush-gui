import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join, relative } from "node:path";
import type { Seed } from "@omnirush/env";
import {
  bootManagedOmniRushServer,
  bootServer,
  close,
  isRecord,
  isolatedFixtureEnv,
  listen,
  readBody,
  sendJson,
  sendStream,
  stopChild,
  type ManagedOmniRushServer,
} from "./omnirush-server-cli.ts";

export const BEST_PRACTICES_HEADING = "OmniRush Best practices";
export const PRIVATE_CANARY = "PRIVATE_CANARY_BEST_PRACTICES_7f62";
export const USER_SKILL = "journey-user-guide";
export const MOCK_REPLY = "BEST_PRACTICES_MOCK_OK";
export const BUNDLED_SKILLS = [
  "omnirush-setup", "omnirush-feature", "omnirush-debug", "omnirush-test",
  "omnirush-refactor", "omnirush-performance", "omnirush-build", "omnirush-review", "omnirush-handoff",
];

export interface ProviderRequest {
  path: string;
  body: string;
  completed: boolean;
  closedBeforeReply: boolean;
}

/** A real server with an attached loopback engine witness for busy/failure states. */
export async function bestPracticesAttached(seed: Seed) {
  const root = seed.tmpPath("best-practices-attached");
  await mkdir(root, { recursive: true });
  const scratch = await realpath(root);
  const workspace = join(scratch, "workspace");
  const home = join(scratch, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(workspace, "notes.txt"), PRIVATE_CANARY);
  const requests: string[] = [];
  let behavior: "busy" | "idle" | "failed" = "busy";
  const attached = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(`${request.method ?? "GET"} ${path}`);
    if (path === "/session/status") return sendJson(response, 200,
      behavior === "busy" ? { fixture_active_reply: { type: "busy" } } : {});
    if (path === "/instance/dispose") return sendJson(response,
      behavior === "failed" ? 500 : 200, behavior === "failed" ? { error: "fixture reload failed" } : { ok: true });
    if (path === "/config") return sendJson(response, 200, {});
    if (path === "/global/health") return sendJson(response, 200, { healthy: true, version: "fixture-attached" });
    return sendJson(response, 200, []);
  });
  const attachedUrl = await listen(attached);
  const inherited = isolatedFixtureEnv();
  const token = "best-practices-attached-fixture-client";
  const launched = bootServer({
    ...inherited, HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state"),
    OMNIRUSH_DEV_MODE: "1", OMNIRUSH_SESSION_UPLOAD_OPTIONAL: "1",
  }, token, workspace, () => undefined, ["--opencode-base-url", attachedUrl]);
  const dispose = async () => {
    await stopChild(launched.child);
    await close(attached);
    await rm(scratch, { recursive: true, force: true });
  };
  try {
    const base = await launched.listening;
    return {
      requests,
      setBehavior: (value: typeof behavior) => { behavior = value; },
      snapshot: () => projectSnapshot(workspace),
      async config(method: "GET" | "PUT", body?: unknown) {
        const response = await fetch(`${base}/runtime-config/best-practices`, {
          method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
        });
        const parsed: unknown = await response.json();
        return { status: response.status, body: parsed };
      },
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) { await dispose(); throw error; }
}

export interface HeldReply {
  request: ProviderRequest;
  release(): void;
}

async function projectSnapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await visit(path);
      else if (item.isFile()) files[relative(root, path)] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  };
  await visit(root);
  return files;
}

function reply(response: ServerResponse, index: number): void {
  const id = `chatcmpl-best-practices-${index}`;
  sendStream(response, [
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: MOCK_REPLY }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);
}

/** Real local server and native engine; the only model provider is a loopback witness. */
export async function bestPractices(seed: Seed) {
  const root = seed.tmpPath("best-practices");
  await mkdir(root, { recursive: true });
  const scratch = await realpath(root);
  const workspace = join(scratch, "workspace");
  const userSkill = join(workspace, ".opencode", "skills", USER_SKILL);
  await mkdir(userSkill, { recursive: true });
  await mkdir(join(workspace, ".private"), { recursive: true });
  await writeFile(join(workspace, ".private", "meeting.txt"), PRIVATE_CANARY);
  await writeFile(join(workspace, "notes.txt"), "Keep this user's project file unchanged.\n");
  await writeFile(join(userSkill, "SKILL.md"), `---\nname: ${USER_SKILL}\ndescription: User-owned guide for the isolated journey.\n---\n\nFollow the user's request.\n`);

  const requests: ProviderRequest[] = [];
  let holdNext: ((reply: HeldReply) => void) | undefined;
  const held = new Set<() => void>();
  const provider = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method !== "POST" || !path.endsWith("/chat/completions")) return sendJson(response, 200, { data: [] });
      const body = await readBody(request);
      const recorded: ProviderRequest = { path, body, completed: false, closedBeforeReply: false };
      requests.push(recorded);
      response.on("close", () => { if (!recorded.completed) recorded.closedBeforeReply = true; });
      const complete = () => {
        if (recorded.completed) return;
        recorded.completed = true;
        held.delete(complete);
        reply(response, requests.indexOf(recorded) + 1);
      };
      if (holdNext && !body.includes("Generate a title for this conversation")) {
        const started = holdNext;
        holdNext = undefined;
        held.add(complete);
        started({ request: recorded, release: complete });
      } else complete();
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  const providerUrl = await listen(provider);
  await writeFile(join(workspace, "opencode.json"), JSON.stringify({
    provider: {
      "best-practices-mock": {
        npm: "@ai-sdk/openai-compatible",
        name: "Best practices loopback witness",
        options: { baseURL: `${providerUrl}/v1`, apiKey: "fixture-only" },
        models: { mock: {
          name: "mock", tool_call: true, reasoning: false, temperature: true,
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 128_000, output: 4_096 }, cost: { input: 0, output: 0 },
        } },
      },
    },
  }, null, 2));

  const token = "best-practices-fixture-client";
  let managed: ManagedOmniRushServer | undefined;
  let output = "";
  const boot = async () => {
    managed = await bootManagedOmniRushServer({
      scratch, workspace, token, sink: (chunk) => { output += chunk; }, isolatedEnv: true,
      env: { OMNIRUSH_DEV_MODE: "1", OMNIRUSH_SESSION_UPLOAD_OPTIONAL: "1" },
    });
  };
  const server = () => {
    if (!managed) throw new Error("Best practices fixture has no running server.");
    return managed;
  };
  const dispose = async () => {
    for (const release of held) release();
    await managed?.stop();
    await close(provider);
    await rm(scratch, { recursive: true, force: true });
  };
  try {
    await boot();
    return {
      requests, workspace, token,
      get base() { return server().base; },
      get workspaceId() { return server().workspaceId; },
      output: () => output,
      async config(method: "GET" | "PUT", body?: unknown, authenticated = true) {
        const response = await fetch(`${server().base}/runtime-config/best-practices`, {
          method,
          headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        const parsed: unknown = await response.json();
        return { status: response.status, body: parsed };
      },
      engine: (method: string, path: string, body?: unknown) => server().engine(method, path, body),
      async send(text: string) {
        const session = await server().engine("POST", "/session", { title: "Best practices witness" });
        if (!isRecord(session) || typeof session.id !== "string") throw new Error("Engine did not create a session.");
        return server().engine("POST", `/session/${encodeURIComponent(session.id)}/message`, {
          agent: "omnirush", model: { providerID: "best-practices-mock", modelID: "mock" },
          parts: [{ type: "text", text }],
        });
      },
      async restart() {
        await server().stop();
        managed = undefined;
        await boot();
      },
      holdNextReply() {
        if (holdNext) throw new Error("A held reply is already armed.");
        return new Promise<HeldReply>((resolve) => { holdNext = resolve; });
      },
      snapshot: () => projectSnapshot(workspace),
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
