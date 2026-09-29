import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { SkipError, type Seed } from "@omnirush/env";
import { close, engineBinary, isRecord, listen, readBody, sendJson, sendStream, stopChild } from "./omnirush-server-cli.ts";

export const SUMMARY = "I will add the two numbers.";
export const REPLY = "42.";
export type SummaryRequest = { path: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> };

export async function modelReasoningSummary(seed: Seed) {
  const binary = engineBinary();
  if (!binary) throw new SkipError("set OMNIRUSH_OPENCODE_BIN or install opencode");
  const root = seed.tmpPath("model-reasoning-summary");
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  const requests: SummaryRequest[] = [];
  const witness = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") return sendJson(response, 200, { object: "list", data: [] });
      const body: unknown = JSON.parse(await readBody(request));
      if (!isRecord(body)) return sendJson(response, 400, {});
      if (!request.url?.startsWith("/v1/responses")) return sendJson(response, 200, {});
      requests.push({ path: request.url, body, headers: request.headers });
      if (request.headers.authorization !== "Bearer summary-witness-access") return sendJson(response, 401, {});
      if (body.model === "unavailable-model") return sendJson(response, 400, { detail: "model_unavailable" });
      const id = `resp_summary_${requests.length}`;
      const reason = { id: `${id}_reason`, type: "reasoning", summary: [{ type: "summary_text", text: SUMMARY }] };
      const item = { id: `${id}_message`, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: REPLY, annotations: [] }] };
      const summarized = isRecord(body.reasoning) && typeof body.reasoning.summary === "string";
      const output = summarized ? [reason, item] : [item];
      const final = { id, created_at: 1, model: body.model, status: "completed", output,
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
      if (!body.stream) return sendJson(response, 200, final);
      const chunks: unknown[] = [
        { type: "response.created", response: { ...final, status: "in_progress", output: [] }, sequence_number: 0 },
      ];
      if (summarized) chunks.push(
        { type: "response.output_item.added", output_index: 0, item: { ...reason, summary: [] } },
        { type: "response.reasoning_summary_part.added", item_id: reason.id, output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
        { type: "response.reasoning_summary_text.delta", item_id: reason.id, output_index: 0, summary_index: 0, delta: SUMMARY },
        { type: "response.reasoning_summary_text.done", item_id: reason.id, output_index: 0, summary_index: 0, text: SUMMARY },
        { type: "response.reasoning_summary_part.done", item_id: reason.id, output_index: 0, summary_index: 0, part: reason.summary[0] },
        { type: "response.output_item.done", output_index: 0, item: reason },
      );
      const outputIndex = summarized ? 1 : 0;
      chunks.push(
        { type: "response.output_item.added", output_index: outputIndex, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: outputIndex, content_index: 0, delta: REPLY },
        { type: "response.output_item.done", output_index: outputIndex, item },
        { type: "response.completed", response: final },
      );
      sendStream(response, chunks);
    })().catch((error: unknown) => { if (!response.headersSent) sendJson(response, 500, { error: String(error) }); else response.destroy(); });
  });
  const upstream = await listen(witness);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE") && !key.startsWith("OMNIRUSH_")));
  const script = `
    import { startEmbeddedServer } from "./src/embedded.ts";
    const server = await startEmbeddedServer({
      host: "127.0.0.1", port: 0, token: "summary-client", hostToken: "summary-host",
      workspaces: [process.env.SUMMARY_WORKSPACE], approvalMode: "auto", logRequests: false,
      manageOpencode: true, opencodeBin: process.env.SUMMARY_BINARY,
      omnirushGatewayCredentials: { gatewayUrl: process.env.SUMMARY_UPSTREAM + "/v1",
        accessToken: "summary-witness-access", refreshToken: "summary-witness-refresh" },
    });
    console.log("SUMMARY_SERVER " + JSON.stringify({ base: server.url, workspaceId: server.config.workspaces[0].id, engineToken: server.config.omnirushEngineToken }));
    process.once("SIGTERM", async () => { await server.stop(); process.exit(0); });
    await new Promise(() => {});
  `;
  const child = spawn("bun", ["--conditions=development", "--eval", script], {
    cwd: resolve(import.meta.dirname, "../../apps/server"), stdio: ["ignore", "pipe", "pipe"],
    env: { ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local/state"),
      SUMMARY_WORKSPACE: workspace, SUMMARY_BINARY: binary, SUMMARY_UPSTREAM: upstream },
  });
  const dispose = async () => { await stopChild(child); await close(witness); await rm(root, { recursive: true, force: true }); };
  try {
    const connection = await new Promise<{ base: string; workspaceId: string; engineToken: string }>((ready, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Embedded summary server did not start: " + output.slice(-3000))), 90_000);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Summary server exited ${code}: ${output.slice(-3000)}`)); });
      const receive = (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/SUMMARY_SERVER (.+)\n/);
        if (!match) return;
        const value: unknown = JSON.parse(match[1]);
        if (!isRecord(value) || typeof value.base !== "string" || typeof value.workspaceId !== "string" || typeof value.engineToken !== "string") return reject(new Error("Invalid summary server connection"));
        clearTimeout(timer);
        ready({ base: value.base, workspaceId: value.workspaceId, engineToken: value.engineToken });
      };
      child.stdout?.on("data", receive);
      child.stderr?.on("data", receive);
    });
    const engine = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(`${connection.base}/workspace/${encodeURIComponent(connection.workspaceId)}/opencode${path}`, {
        method, headers: { authorization: "Bearer summary-client", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000),
      });
      const value: unknown = await response.json();
      if (!response.ok) throw new Error(`Engine ${path}: ${response.status}: ${JSON.stringify(value)}`);
      return value;
    };
    return {
      engine, requests,
      gateway: (body: Record<string, unknown>, path = "responses", headers: Record<string, string> = {}) =>
        fetch(`${connection.base}/omnirush-gateway/v1/${path}`, { method: "POST",
          headers: { authorization: `Bearer ${connection.engineToken}`, "content-type": "application/json", ...headers },
          body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }),
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) { await dispose(); throw error; }
}
