import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { SkipError, type Seed } from "@omnirush/env";
import { selectModel } from "@omnirush/behaviors";
import { configureProvider } from "./chat.ts";
import {
  bootManagedOmniRushServer, close, engineBinary, isRecord, listen, readBody, sendJson, sendStream,
} from "./omnirush-server-cli.ts";

const PROVIDER = "openai";
export const GOAL_MODELS = [
  "goal-complete", "goal-budget", "goal-held", "goal-stop-held", "goal-recover-held", "goal-replaced-held",
  "goal-replacement-budget", "goal-steer-held", "goal-queue-budget", "goal-delegate", "goal-stall", "goal-create", "goal-plan", "goal-unrelated",
];

type GoalWitnessRequest = { model: string; number: number; tools: string[]; body: string };
type Reply = { text: string } | { tool: string; arguments: Record<string, unknown> };

function replyFor(model: string, number: number): Reply {
  if (model === "goal-complete") {
    if (number === 1 || number === 3) return {
      tool: "bash", arguments: {
        command: number === 1 ? "printf first > goal-first.txt" : "printf second > goal-second.txt",
        description: number === 1 ? "Save the first checkpoint" : "Save the second checkpoint",
      },
    };
    if (number === 4) return { tool: "update_goal", arguments: { status: "complete" } };
    return { text: number === 2 ? "First checkpoint saved. The goal still needs the second checkpoint." : "Both checkpoints are saved." };
  }
  if (model === "goal-create") {
    if (number === 1) return { tool: "create_goal", arguments: { objective: "Save an explicitly requested goal", token_budget: 500 } };
    if (number === 2) return { tool: "get_goal", arguments: {} };
    if (number === 3) return { tool: "update_goal", arguments: { status: "complete" } };
    return { text: "The requested goal was saved and checked." };
  }
  if (model === "goal-delegate") {
    if (number === 1) return { tool: "task", arguments: { description: "Save a child checkpoint", prompt: "Save a child checkpoint file named goal-child.txt, then finish your assigned task.", subagent_type: "general" } };
    if (number === 2) return { tool: "get_goal", arguments: {} };
    if (number === 3) return { tool: "bash", arguments: { command: "printf child > goal-child.txt", description: "Save the child checkpoint" } };
    if (number === 5) return { tool: "update_goal", arguments: { status: "complete" } };
    return { text: number === 4 ? "The child checkpoint is saved." : "The parent goal is complete." };
  }
  if ((model === "goal-held" || model === "goal-recover-held") && number === 2) return { tool: "update_goal", arguments: { status: "complete" } };
  if (model === "goal-stall") return { text: "" };
  return { text: model === "goal-unrelated" ? "The other chat works." : "One checkpoint is done. The goal still needs work." };
}

function sendReply(response: ServerResponse, request: GoalWitnessRequest): void {
  if (response.destroyed || response.writableEnded) return;
  const reply = replyFor(request.model, request.number);
  const id = `goal_${request.model}_${request.number}`;
  let toolName = "tool" in reply ? reply.tool : "";
  let toolArguments: Record<string, unknown> = "tool" in reply ? reply.arguments : {};
  if (toolName === "bash" && request.tools.includes("shell")) toolName = "shell";
  if (toolName === "task" && request.tools.includes("subagent")) {
    toolName = "subagent";
    toolArguments = { description: toolArguments.description, prompt: toolArguments.prompt, agent: toolArguments.subagent_type, background: false };
  }
  const delta = "text" in reply
    ? { role: "assistant", content: reply.text }
    : { role: "assistant", tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: {
      name: toolName, arguments: JSON.stringify(toolArguments),
    } }] };
  sendStream(response, [
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "text" in reply ? "stop" : "tool_calls" }] },
    { id, object: "chat.completion.chunk", choices: [], usage: {
      prompt_tokens: 130, completion_tokens: 20, total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 5 },
    } },
  ]);
}

async function goalWitness() {
  const requests: GoalWitnessRequest[] = [];
  const held = new Set<() => void>();
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") return sendJson(response, 200, { data: [] });
      const raw = await readBody(request);
      const body: unknown = JSON.parse(raw);
      if (!isRecord(body) || typeof body.model !== "string") return sendJson(response, 400, {});
      if (raw.includes("Generate a title for this conversation")) {
        return sendStream(response, [
          { id: "goal_title", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Goal check" }, finish_reason: "stop" }] },
        ]);
      }
      const tools = Array.isArray(body.tools) ? body.tools.flatMap((tool) => (
        isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string" ? [tool.function.name] : []
      )) : [];
      const item = { model: body.model, number: requests.filter((item) => item.model === body.model).length + 1, tools, body: raw };
      requests.push(item);
      if (item.model.endsWith("held") && item.number === 1) {
        const release = () => { held.delete(release); sendReply(response, item); };
        held.add(release);
        response.on("close", () => held.delete(release));
        return;
      }
      sendReply(response, item);
    })().catch(() => { if (!response.headersSent) sendJson(response, 500, {}); else response.end(); });
  });
  const base = await listen(server);
  const config = {
    permission: { "*": "allow" },
    provider: { [PROVIDER]: {
      npm: "@ai-sdk/openai-compatible", name: "Goal witness",
      options: { baseURL: `${base}/v1`, apiKey: "goal-test-witness" },
      models: Object.fromEntries(GOAL_MODELS.map((id) => [id, {
        name: id, tool_call: true, limit: { context: 128_000, output: 4_096 },
      }])),
    } },
  };
  return {
    config, requests,
    release: () => { for (const release of [...held]) release(); },
    [Symbol.asyncDispose]: async () => { held.clear(); await close(server); },
  };
}

export async function sessionGoals(seed: Seed) {
  const binary = engineBinary();
  if (!binary) throw new SkipError("set OMNIRUSH_OPENCODE_BIN or install opencode");
  const root = seed.tmpPath("session-goals");
  await mkdir(root, { recursive: true });
  const scratch = await realpath(root);
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  const witness = await goalWitness();
  await writeFile(join(workspace, "opencode.json"), JSON.stringify(witness.config));
  const token = "goal-journey-client";
  const diagnostics: string[] = [];
  let managed: Awaited<ReturnType<typeof bootManagedOmniRushServer>> | undefined;
  const boot = async () => {
    managed = await bootManagedOmniRushServer({ scratch, workspace, token, binary, allowUncapturedTestPrompts: true, sink: (text) => diagnostics.push(text) });
  };
  const dispose = async () => {
    await managed?.stop();
    await witness[Symbol.asyncDispose]();
    await rm(scratch, { recursive: true, force: true });
  };
  try {
    await boot();
    const api = async (method: string, path: string, body?: unknown, authenticated = true) => {
      if (!managed) throw new Error("The goal server is not running.");
      const response = await fetch(`${managed.base}${path.replace(":workspace", managed.workspaceId)}`, {
        method, headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    return {
      api,
      engine: (method: string, path: string, body?: unknown) => {
        if (!managed) throw new Error("The goal engine is not running.");
        return managed.engine(method, path, body);
      },
      model: (modelID: string) => ({ providerID: PROVIDER, modelID }),
      proof: (file: string) => readFile(join(workspace, file), "utf8"),
      requests: witness.requests, release: witness.release, diagnostics,
      restart: async () => { await managed?.stop(); managed = undefined; await boot(); },
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function sessionGoalsDesktop(seed: Seed) {
  const witness = await goalWitness();
  try {
    const app = await seed.desktop({ name: "session-goals-ui", env: {
      OMNIRUSH_DEV_MODE: "1", OMNIRUSH_SESSION_UPLOAD_OPTIONAL: "1",
      VITE_OMNIRUSH_ALLOW_OTHER_PROVIDERS: "1",
      ELECTRON_RUN_AS_NODE: "",
      OMNIRUSH_EVAL_DESKTOP_BOOT_TIMEOUT_MS: "300000",
    } });
    const workspace = await seed.workspace(app, seed.tmpPath("session-goals-ui"));
    await configureProvider(seed, app, workspace.workspaceId, PROVIDER, "goal-held", witness.config);
    const session = await seed.session(app, { title: "Goal controls" });
    // Select through the picker after mount so preference hydration cannot replace the test model.
    const selected = await selectModel(app, "goal-held");
    if (!selected.selected) throw new Error("The goal test model was not saved by the picker.");
    return { app, workspace, session, requests: witness.requests, release: witness.release,
      [Symbol.asyncDispose]: witness[Symbol.asyncDispose] };
  } catch (error) {
    await witness[Symbol.asyncDispose]();
    throw error;
  }
}
