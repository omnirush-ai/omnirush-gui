import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile, readFile, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { startCaptureService, type CaptureService } from "../../../../apps/server/src/capture-client.js";
import type { TraceCapabilities } from "../../../../apps/server/src/session-uploader.js";
import { NativeCapture } from "../../../../apps/server/src/claude-code/native-capture.js";

const CONTROL_TOKEN = "capture-lab-control";
const UPLOAD_TOKEN = "capture-lab-upload";
const MAX_REQUEST_BYTES = 80 * 1024 * 1024;
type Actor = "actor-a" | "actor-b";
const ACTORS: readonly Actor[] = ["actor-a", "actor-b"];

export type CaptureEfficiencyAttempt = {
  sessionId: string;
  status: number;
  snapshotType: string;
  schemaVersion: number | null;
  workspaceRoot: string | null;
  filePaths: string[];
  traceTypes: string[];
  traceFileEventTypes: string[];
  traceFileCount: number;
  actorMarkers: string[];
};

export type CaptureEfficiencyWitness = {
  attempts: CaptureEfficiencyAttempt[];
  capabilityCalls: Record<Actor, number>;
  modes: Array<"starting" | "worker" | "local" | "down">;
};

export type CaptureEfficiencyLab = {
  readonly baseUrl: string;
  readonly controlToken: string;
  witness(): Promise<CaptureEfficiencyWitness>;
  stop(): Promise<void>;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, key: string): string {
  if (!isRecord(value) || typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`missing string field ${key}`);
  }
  return value[key];
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown, key: string): number | null {
  if (!isRecord(value) || typeof value[key] !== "number" || !Number.isFinite(value[key])) return null;
  return value[key];
}

function actorValue(value: unknown): Actor {
  const actor = stringValue(value, "actor");
  if (actor === "actor-a" || actor === "actor-b") return actor;
  throw new Error(`unsupported synthetic actor ${actor}`);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_REQUEST_BYTES) throw new Error("request body exceeds lab limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  return JSON.parse(body.toString("utf8"));
}

function authorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function traceSummary(value: unknown): { types: string[]; actors: string[] } {
  if (isRecord(value) && Array.isArray(value.events)) return traceSummary(value.events);
  if (!Array.isArray(value)) return { types: [], actors: [] };
  const types: string[] = [];
  const actors: string[] = [];
  for (const event of value) {
    if (!isRecord(event) || typeof event.type !== "string") continue;
    types.push(event.type);
    if (isRecord(event.data) && typeof event.data.actor === "string") actors.push(event.data.actor);
  }
  return { types, actors };
}

function filePaths(value: unknown): Array<{ path: string; content: string | null }> {
  if (!Array.isArray(value)) return [];
  const files: Array<{ path: string; content: string | null }> = [];
  for (const file of value) {
    if (!isRecord(file) || typeof file.path !== "string") continue;
    files.push({ path: file.path, content: typeof file.content === "string" ? file.content : null });
  }
  return files;
}

function summarizeEnvelope(sessionId: string, status: number, envelope: JsonRecord): CaptureEfficiencyAttempt {
  const workspace = isRecord(envelope.workspace) ? envelope.workspace : null;
  const workspaceRoot = workspace ? optionalString(workspace.root_name) : null;
  const files = filePaths(envelope.files);
  const trace = traceSummary(envelope.trace);
  const traceFiles = files.filter((file) => file.path === "__omnirush__/trace.json");
  let traceFileEventTypes: string[] = [];
  for (const traceFile of traceFiles) {
    if (traceFile.content === null) continue;
    try {
      const parsed: unknown = JSON.parse(traceFile.content);
      traceFileEventTypes = traceSummary(parsed).types;
    } catch {
      traceFileEventTypes = [];
    }
  }
  return {
    sessionId,
    status,
    snapshotType: typeof envelope.snapshot_type === "string" ? envelope.snapshot_type : "",
    schemaVersion: numberValue(envelope, "schema_version"),
    workspaceRoot,
    filePaths: files.map((file) => file.path),
    traceTypes: trace.types,
    traceFileEventTypes,
    traceFileCount: traceFiles.length,
    actorMarkers: trace.actors,
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("capture-efficiency lab did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function capability(actor: Actor, calls: Record<Actor, number>): () => Promise<TraceCapabilities> {
  return async () => {
    calls[actor] += 1;
    return { schema_versions: [1, 2, 3], canonical_trace: true };
  };
}

async function startCaptureEfficiencyLabRuntime(): Promise<CaptureEfficiencyLab> {
  const tempRoot = await mkdtemp(join(tmpdir(), "omnirush-capture-efficiency-"));
  const stateRoot = join(tempRoot, "state");
  const workspaceRoot = join(tempRoot, "workspaces");
  await mkdir(workspaceRoot, { recursive: true });

  const attempts: CaptureEfficiencyAttempt[] = [];
  const capabilityCalls: Record<Actor, number> = { "actor-a": 0, "actor-b": 0 };
  const sessions = new Map<string, { actor: Actor; service: CaptureService }>();
  const rejectedSchema3 = new Set(["session-a-0001"]);
  let collectorUrl = "";
  let stopped = false;
  let services: CaptureService[] = [];
  const signedIn: Record<Actor, string | null> = { "actor-a": "actor-a", "actor-b": "actor-b" };
  const nativeContexts = new Map<string, { actor: Actor; configDir: string; source: string; expected: string }>();

  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url?.split("?", 1)[0] ?? "/";
      if (path === "/collector/collect") {
        if (request.method !== "POST" || !authorized(request, UPLOAD_TOKEN)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        const header = request.headers["x-omnirush-session-id"];
        const sessionId = typeof header === "string" ? header : Array.isArray(header) ? header[0] ?? "" : "";
        try {
          const compressed = await readBody(request);
          const json: unknown = JSON.parse(zstdDecompressSync(compressed).toString("utf8"));
          if (!isRecord(json)) throw new Error("collector envelope is not an object");
          const schemaVersion = numberValue(json, "schema_version");
          const summary = summarizeEnvelope(sessionId, 201, json);
          if (summary.snapshotType === "trace" && schemaVersion === 3 && rejectedSchema3.has(sessionId)) {
            rejectedSchema3.delete(sessionId);
            attempts.push({ ...summary, status: 422 });
            sendJson(response, 422, { error: "unsupported_schema" });
            return;
          }
          attempts.push(summary);
          sendJson(response, 201, { ok: true });
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid collector body" });
        }
        return;
      }

      if (path === "/witness") {
        if (request.method !== "GET" || !authorized(request, CONTROL_TOKEN)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        sendJson(response, 200, { attempts, capabilityCalls, modes: services.map(service => service.mode()) });
        return;
      }

      if (!path.startsWith("/control/") || !authorized(request, CONTROL_TOKEN)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      if (services.length === 0) {
        sendJson(response, 503, { error: "capture service is not ready" });
        return;
      }

      const body = await readJson(request);
      const requestedSessionId = stringValue(body, "sessionId");
      if (path.startsWith("/control/native/")) {
        if (!/^[a-f0-9-]{36}$/.test(requestedSessionId)) throw new Error("invalid native session id");
        const actor = actorValue(body), index = ACTORS.indexOf(actor);
        if (path === "/control/native/seed") {
          const configDir = join(tempRoot, "native-sources", actor, requestedSessionId);
          const project = join(configDir, "projects", "-fixture-workspace");
          const source = join(project, `${requestedSessionId}.jsonl`);
          await mkdir(project, { recursive: true });
          const records = [
            { type: "user", uuid: "prompt", parentUuid: null, message: { content: `task for ${actor}` } },
            { type: "assistant", uuid: "tools", parentUuid: "prompt", futureNativeField: actor, message: { content: [{ type: "thinking", thinking: "Visible summary", signature: "opaque-fixture" }, { type: "tool_use", id: "side-call", name: "Read" }, { type: "tool_use", id: "main-call", name: "Read" }] } },
            { type: "user", uuid: "side-result", parentUuid: "tools", message: { content: [{ type: "tool_result", tool_use_id: "side-call", content: "side branch" }] } },
            { type: "user", uuid: "main-result", parentUuid: "tools", message: { content: [{ type: "tool_result", tool_use_id: "main-call", content: "main branch" }] } },
          ];
          const expected = records.map((record) => JSON.stringify(record) + "\n").join("");
          await writeFile(source, expected.slice(0, -3));
          await writeFile(join(configDir, "credentials.json"), "DO_NOT_EXPORT_AUTH");
          await writeFile(join(project, "unrelated.jsonl"), "DO_NOT_EXPORT_OTHER_SESSION");
          const subagents = join(project, requestedSessionId, "subagents"); await mkdir(subagents, { recursive: true });
          for (let child = 0; child < 5; child++) {
            await writeFile(join(subagents, `agent-child${child}.jsonl`), JSON.stringify({ type: "user", uuid: `child${child}`, parentUuid: null, message: { content: `child ${child}` } }) + "\n");
            await writeFile(join(subagents, `agent-child${child}.meta.json`), '{"agentType":"fixture"}');
          }
          nativeContexts.set(requestedSessionId, { actor, configDir, source, expected });
          sendJson(response, 202, { rootSha256: createHash("sha256").update(expected).digest("hex") }); return;
        }
        const context = nativeContexts.get(requestedSessionId);
        if (!context || context.actor !== actor) { sendJson(response, 403, { error: "native owner mismatch" }); return; }
        const captureContext = { sessionId: requestedSessionId, configDir: context.configDir, producerVersion: "native-lab", transport: "sdk" as const };
        if (path === "/control/native/account") {
          signedIn[actor] = isRecord(body) && body.signedIn === null ? null : stringValue(body, "signedIn");
          sendJson(response, 202, { ok: true }); return;
        }
        if (path === "/control/native/repair") {
          await appendFile(context.source, context.expected.slice(-3)); sendJson(response, 202, { ok: true }); return;
        }
        if (path === "/control/native/restart") {
          await services[index].stop({ archiveFinals: false }); services[index] = makeService(actor);
          sendJson(response, 202, { ok: true }); return;
        }
        if (path === "/control/native/stream") {
          const text = stringValue(body, "text"), offset = numberValue(body, "offset");
          if (offset === null) throw new Error("stream offset required");
          const manifest = await services[index].captureClaude(captureContext, { type: "stream", channel: "sdk", offset, bytes: Buffer.from(text) });
          sendJson(response, 202, manifest); return;
        }
        if (path === "/control/native/finish") {
          const manifest = await services[index].captureClaude(captureContext, { type: "finish", processStopped: true, successfulResult: true, expectedAgents: ["child0", "child1", "child2", "child3", "child4"] });
          sendJson(response, 202, manifest); return;
        }
        if (path === "/control/native/export") {
          const capture = new NativeCapture({ ...captureContext, directory: join(stateRoot, actor, "claude-native", requestedSessionId), owner: actor, surface: "gui" });
          const destination = join(tempRoot, "exports", requestedSessionId);
          const manifest = capture.exportTo(destination);
          const files = await Promise.all(manifest.files.map(async (file) => ({ path: file.path, text: await readFile(join(destination, file.path), "utf8") })));
          sendJson(response, 202, { manifest, files }); return;
        }
        throw new Error("unknown native control");
      }
      if (path === "/control/start") {
        const actor = actorValue(body);
        const workspace = stringValue(body, "workspace");
        const expectedWorkspace = actor === "actor-a" ? "workspace-a" : "workspace-b";
        if (workspace !== expectedWorkspace || sessions.has(requestedSessionId)) {
          sendJson(response, 400, { error: "invalid synthetic session" });
          return;
        }
        const service = services[ACTORS.indexOf(actor)];
        const root = join(workspaceRoot, actor, workspace);
        await mkdir(root, { recursive: true });
        await writeFile(join(root, `notes-${actor.slice(-1)}.txt`), `synthetic ${actor}\n`, "utf8");
        sessions.set(requestedSessionId, { actor, service });
        service.startSession(requestedSessionId, workspace, root);
        await service.idle();
        sendJson(response, 202, { ok: true });
        return;
      }

      const session = sessions.get(requestedSessionId);
      if (!session) {
        sendJson(response, 404, { error: "unknown synthetic session" });
        return;
      }
      if (path === "/control/trace") {
        const type = stringValue(body, "type");
        const data = isRecord(body) && Object.hasOwn(body, "data") ? body.data : undefined;
        session.service.recordTrace(requestedSessionId, type, data);
        await session.service.idle();
        sendJson(response, 202, { ok: true });
        return;
      }
      if (path === "/control/flush") {
        const finalTrace = isRecord(body) && Object.hasOwn(body, "finalTrace") ? body.finalTrace : undefined;
        session.service.flushTrace(requestedSessionId, finalTrace);
        await session.service.idle();
        sendJson(response, 202, { ok: true });
        return;
      }
      if (path === "/control/complete") {
        const finalTrace = isRecord(body) && Object.hasOwn(body, "finalTrace") ? body.finalTrace : undefined;
        session.service.finishSession(requestedSessionId, finalTrace);
        await session.service.idle();
        sendJson(response, 202, { ok: true });
        return;
      }
      sendJson(response, 404, { error: "unknown_control" });
    })().catch((error: unknown) => {
      if (!response.writableEnded) sendJson(response, 500, { error: error instanceof Error ? error.message : "lab request failed" });
    });
  });

  const port = await listen(server);
  collectorUrl = `http://127.0.0.1:${port}`;
  const uploadFile = async (sessionId: string, path: string, size: number, signal?: AbortSignal): Promise<Response> => {
    const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
    // Node and DOM stream declarations differ; the runtime accepts this web stream.
    const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
    try {
      const options = {
        method: "POST",
        headers: {
          authorization: "Bearer " + UPLOAD_TOKEN,
          "content-type": "application/zstd",
          "x-omnirush-session-id": sessionId,
        },
        body,
        signal,
        duplex: "half",
      };
      return await fetch(collectorUrl + "/collector/collect", options);
    } finally { stream.destroy(); }
  };

  const makeService = (actor: Actor) => startCaptureService({
      stateDir: join(stateRoot, actor),
      appVersion: "capture-efficiency-lab",
      engineVersion: "capture-efficiency-lab",
      log: () => undefined,
      worker: true,
      accountId: async () => signedIn[actor],
      sessionUploader: {
        uploadFile,
        capabilities: capability(actor, capabilityCalls),
      },
      archive: {
        enabled: false,
        excludedDirs: [],
      },
    });
  try {
    services = ACTORS.map(makeService);
  } catch (error) {
    await close(server);
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await Promise.all(services.map((service) => service.stop({ archiveFinals: false })));
    } finally {
      await close(server);
      await rm(tempRoot, { recursive: true, force: true });
    }
  };

  return {
    baseUrl: collectorUrl,
    controlToken: CONTROL_TOKEN,
    witness: () => readWitness(collectorUrl, CONTROL_TOKEN),
    stop,
  };
}

async function readWitness(baseUrl: string, controlToken: string): Promise<CaptureEfficiencyWitness> {
  const response = await fetch(`${baseUrl}/witness`, {
    headers: { authorization: `Bearer ${controlToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`witness request failed with ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.attempts) || !isRecord(body.capabilityCalls)) {
    throw new Error("invalid capture-efficiency witness");
  }
  const witnessAttempts: CaptureEfficiencyAttempt[] = [];
  for (const attempt of body.attempts) {
    if (!isRecord(attempt)) throw new Error("invalid capture-efficiency attempt");
    witnessAttempts.push({
      sessionId: stringValue(attempt, "sessionId"),
      status: numberValue(attempt, "status") ?? 0,
      snapshotType: stringValue(attempt, "snapshotType"),
      schemaVersion: numberValue(attempt, "schemaVersion"),
      workspaceRoot: optionalString(attempt.workspaceRoot),
      filePaths: Array.isArray(attempt.filePaths) ? attempt.filePaths.filter((path): path is string => typeof path === "string") : [],
      traceTypes: Array.isArray(attempt.traceTypes) ? attempt.traceTypes.filter((type): type is string => typeof type === "string") : [],
      traceFileEventTypes: Array.isArray(attempt.traceFileEventTypes)
        ? attempt.traceFileEventTypes.filter((type): type is string => typeof type === "string")
        : [],
      traceFileCount: numberValue(attempt, "traceFileCount") ?? 0,
      actorMarkers: Array.isArray(attempt.actorMarkers) ? attempt.actorMarkers.filter((actor): actor is string => typeof actor === "string") : [],
    });
  }
  const calls: Record<Actor, number> = {
    "actor-a": numberValue(body.capabilityCalls, "actor-a") ?? 0,
    "actor-b": numberValue(body.capabilityCalls, "actor-b") ?? 0,
  };
  const modes: CaptureEfficiencyWitness["modes"] = [];
  if (!Array.isArray(body.modes)) throw new Error("missing worker modes");
  for (const mode of body.modes) {
    if (mode !== "starting" && mode !== "worker" && mode !== "local" && mode !== "down") throw new Error("invalid worker mode");
    modes.push(mode);
  }
  return { attempts: witnessAttempts, capabilityCalls: calls, modes };

}

/** Boot the real Bun capture worker; Vitest's Node transform is not a worker loader. */
export async function startCaptureEfficiencyLab(): Promise<CaptureEfficiencyLab> {
  if (process.versions.bun) return startCaptureEfficiencyLabRuntime();
  const modulePath = fileURLToPath(import.meta.url);
  const program = [
    "import { startCaptureEfficiencyLab } from " + JSON.stringify(modulePath) + ";",
    "const lab = await startCaptureEfficiencyLab();",
    "console.log(JSON.stringify({ captureLabReady: true, baseUrl: lab.baseUrl, controlToken: lab.controlToken }));",
    "let stopping = false;",
    'process.on("SIGTERM", async () => { if (stopping) return; stopping = true; await lab.stop(); process.exit(0); });',
  ].join("\n");
  const child = spawn("bun", ["--conditions=development", "--eval", program], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-16_384); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<void>(resolve => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 15_000); }),
      ]);
      await exited;
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    const ready = await new Promise<{ baseUrl: string; controlToken: string }>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => reject(new Error("Bun capture lab startup timed out: " + stderr)), 10_000);
      const finish = (error?: Error, value?: { baseUrl: string; controlToken: string }) => {
        clearTimeout(timer);
        if (error) reject(error);
        else if (value) resolve(value);
      };
      child.once("error", error => finish(error));
      child.once("exit", () => finish(new Error("Bun capture lab exited before readiness: " + stderr)));
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        const newline = stdout.indexOf("\n");
        if (newline === -1) return;
        const lines = stdout.slice(0, stdout.lastIndexOf("\n")).split("\n");
        stdout = stdout.slice(stdout.lastIndexOf("\n") + 1);
        for (const line of lines) {
          try {
            const value: unknown = JSON.parse(line);
            if (isRecord(value) && value.captureLabReady === true
                && typeof value.baseUrl === "string" && typeof value.controlToken === "string") {
              finish(undefined, { baseUrl: value.baseUrl, controlToken: value.controlToken });
            }
          } catch {}
        }
      });
    });
    return { ...ready, witness: () => readWitness(ready.baseUrl, ready.controlToken), stop };
  } catch (error) { await stop(); throw error; }
}
