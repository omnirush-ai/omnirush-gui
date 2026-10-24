/** The shared CLI/desktop Claude runtime. The SDK and every tool run in the
 * container. There are no host workspace, home, credential or socket mounts.
 * Stopped-container images are the checkpoint authority, not a guessed list of
 * changed files. The host only brokers inference, copies evidence and seals it.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { NativeCapture } from "./native-capture.js";
import { CAPTURE_POLICY_VERSION, CLAUDE_VERSION, CONTROLLER, DOCKERFILE, IMAGE, MANAGED_SETTINGS, MODEL, SDK_VERSION } from "./sandbox-assets.js";
import { PACKAGE_JSON, LOCKFILE } from "./sandbox-lock.js";
import { zipDirectory } from "./zip.js";
import { REPLAY_ADAPTER } from "./replay-adapter.js";
import { writeBundleManifest } from "./bundle-manifest.js";
import { ClaudeAccessError, claudeResponseHeaders } from "./access.js";

export type ClaudeBudgetSnapshot = {
  status: "known" | "unknown"; model: string; revision?: string;
  asOf?: string; limitTokens?: number | null; remainingTokens?: number | null; resetAt?: string | null;
  sessionLimitTokens?: number | null; sessionUsedTokens?: number; sessionRemainingTokens?: number | null;
  accountLimitTokens?: number; accountRemainingTokens?: number; accountScope?: "day" | "week"; accountResetAt?: string;
};
export type ClaudeAccess = { owner: string; capabilities?: string[]; budget?: ClaudeBudgetSnapshot };
export type ClaudeAuthorization = { sessionId: string; owner: string; model: string; workspaceId: string; contractSha256: string; refresh?: boolean };
export type ClaudeGrant = {
  owner: string; baseUrl: string; token: string; sessionId: string; model: string;
  upstreamModel: string; client: string;
  bindingId?: string; contractSha256?: string; policyVersion?: string; budget?: ClaudeBudgetSnapshot;
};
export type RuntimeOptions = {
  directory: string; surface: "cli" | "gui";
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  access: () => Promise<ClaudeAccess>;
  authorize: (session: ClaudeAuthorization) => Promise<ClaudeGrant>;
  revoke?: (session: ClaudeAuthorization) => Promise<void>;
  docker?: string;
};
export type ClaudeSessionContract = {
  schema: 1; sessionId: string; owner: string; workspaceId: string; model: string;
  harness: {name: "claude-code"; sdkVersion: string; claudeVersion: string; controllerSha256: string; lockSha256: string; managedSettingsSha256: string; dockerfileSha256: string};
  execution: {kind: "docker"; os: "linux"; architecture: string; workingDirectory: "/workspace"; shell: "/bin/bash"; runtimeImage: string; baseImage: string; workspace: "session-copy"};
  capture: {policyVersion: string; originals: "private"; modelIsolation: "exact"; scope: "managed-inference"; network: "development-network-enabled"; initialWorkspaceProvenance: "user-supplied-unattested"};
};
export type ClaudeModelIsolation = {
  status: "pending" | "observed" | "unknown" | "invalid" | "legacy_unverified";
  expectedModel: string; resolvedModel?: string; observedModels: string[]; inferenceRequests: number; completedRequests: number;
  missingIdentityRequests: number; interruptedRequests: number; rejectedRequests: number;
  issues: string[]; evidenceSha256?: string; evidenceBytes?: number;
};
type Checkpoint = { image: string; file: string; sha256: string; bytes: number };
type Turn = { number: number; prompt: string; startedAt: string; finishedAt?: string; sdkStart: number; sdkEnd?: number;
  status: "running" | "complete" | "interrupted" | "failed"; before: Checkpoint;
  after?: Checkpoint; error?: string };
export type ClaudeSession = {
  schema: 1; id: string; owner: string; workspaceId: string; surface: "cli" | "gui";
  model: string; sdkVersion: string; claudeVersion: string; createdAt: string;
  container: string; base: Checkpoint; turns: Turn[];
  capture: "capturing" | "complete" | "incomplete";
  replay: "unverified" | "restored"; issues: string[];
  contract?: ClaudeSessionContract; contractSha256?: string;
  compatibility?: "current" | "legacy_unverified" | "contract_invalid" | "runtime_upgrade_required";
  modelIsolation?: ClaudeModelIsolation;
  authorization?: {binding: "session-model" | "session-model-contract"; bindingId?: string; upstreamModel: string; policyVersion: string | null; budget: ClaudeBudgetSnapshot | null};
};
export type DisplayEvent = { type: "user" | "assistant" | "thinking" | "tool" | "result"; text: string; turn: number };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function interrupted(signal?: AbortSignal) { signal?.throwIfAborted(); }
async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  interrupted(signal);
  if (!signal) return work;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, {once: true}); });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
// A PID alone cannot distinguish a live owner from a reused PID. Linux exposes
// an exact birth identity; elsewhere a live/uninspectable PID stays locked.
function processIdentity(pid: number) {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"), start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), namespace = fs.readlinkSync("/proc/self/ns/pid");
    if (!/^\d+$/.test(start) || !UUID.test(boot)) return undefined;
    return {host: os.hostname(), boot, namespace, start};
  } catch { return undefined; }
}
function deadLockOwner(prior: unknown): boolean {
  if (!isRecord(prior) || typeof prior.pid !== "number" || !Number.isSafeInteger(prior.pid) || prior.pid < 1 || typeof prior.nonce !== "string") return false;
  const identity = prior.identity, current = processIdentity(prior.pid);
  if (identity !== undefined) {
    // An unfamiliar host/namespace or malformed birth record is not proof.
    const self = processIdentity(process.pid);
    if (!isRecord(identity) || !self || identity.host !== self.host || identity.namespace !== self.namespace ||
        typeof identity.boot !== "string" || !UUID.test(identity.boot) || typeof identity.start !== "string" || !/^\d+$/.test(identity.start)) return false;
    if (identity.boot !== self.boot) return true;
    if (current && identity.start !== current.start) return true;
  }
  try { process.kill(prior.pid, 0); return false; }
  catch (error) { return isRecord(error) && error.code === "ESRCH"; }
}
function privateDir(dir: string) { fs.mkdirSync(dir, {recursive: true, mode: 0o700}); fs.chmodSync(dir, 0o700); }
function syncDirectory(dir: string) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function save(file: string, data: unknown) {
  privateDir(path.dirname(file));
  const tmp = `${file}.${randomUUID()}.tmp`, fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  if (process.platform !== "win32") { const dir = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
}
async function fileHash(file: string) {
  const hash = createHash("sha256");
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
function validateGrant(grant: ClaudeGrant, session: ClaudeAuthorization): ClaudeGrant {
  const url = new URL(grant.baseUrl);
  if (!grant.owner || !grant.token || /\s/.test(grant.token) || /^sk-ant-/.test(grant.token) || url.username || url.password || url.search || url.hash ||
      /(^|\.)(anthropic\.com|claude\.ai)$/.test(url.hostname) ||
      !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("An active internal Claude grant is required");
  if (grant.owner !== session.owner || grant.sessionId !== session.sessionId || grant.model !== session.model ||
      grant.contractSha256 !== undefined && grant.contractSha256 !== session.contractSha256) throw new Error("Claude authorization does not match this session's fixed model and contract");
  if (!identityLabel(grant.upstreamModel) || grant.upstreamModel !== session.model || !/^(cli|desktop|gui)\/[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(grant.client)) throw new Error("Claude authorization does not match the exact upstream model and client binding");
  return {...grant, baseUrl: grant.baseUrl.replace(/\/$/, "")};
}

function initialModelIsolation(model: string, legacy = false): ClaudeModelIsolation {
  return {status: legacy ? "legacy_unverified" : "pending", expectedModel: model, observedModels: [], inferenceRequests: 0, completedRequests: 0, missingIdentityRequests: 0, interruptedRequests: 0, rejectedRequests: 0, issues: legacy ? ["capture_predates_model_enforcement"] : []};
}
function identityLabel(value: unknown): string | null {
  return typeof value === "string" && /^claude-[a-z0-9._-]{1,128}$/.test(value) ? value : null;
}

/** Observes identity without changing a single response byte. Only a provider's
 * actual message envelope is identity evidence; a requested model is not. */
class ResponseIdentity {
  readonly models = new Set<string>();
  malformed = false;
  complete = false;
  private readonly decoder = new TextDecoder();
  private pending = "";
  constructor(private readonly stream: boolean, private readonly observed: (model: string) => void) {}
  private event(value: unknown) {
    if (!isRecord(value)) return;
    const message = value.type === "message_start" && isRecord(value.message) ? value.message : value.type === "message" ? value : null;
    if (message) {
      const model = identityLabel(message.model);
      if (!model) { this.malformed = true; return; }
      this.models.add(model); this.observed(model);
    }
    if (value.type === "message_stop" || value.type === "message" && value.stop_reason !== null && value.stop_reason !== undefined) this.complete = true;
  }
  private parse(text: string) {
    if (!text.trim() || text.trim() === "[DONE]") return;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { this.malformed = true; return; }
    this.event(parsed);
  }
  push(bytes: Uint8Array) {
    this.pending += this.decoder.decode(bytes, {stream: true});
    if (this.stream) {
      for (;;) {
        const match = /\r?\n\r?\n/.exec(this.pending);
        if (!match || match.index === undefined) break;
        const frame = this.pending.slice(0, match.index); this.pending = this.pending.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        this.parse(data);
      }
    }
    if (this.pending.length > (this.stream ? 4 : 32) * 1024 * 1024) { this.pending = ""; this.malformed = true; }
  }
  finish() {
    this.pending += this.decoder.decode();
    if (this.stream) { if (this.pending.trim()) this.malformed = true; }
    else this.parse(this.pending);
    this.pending = "";
  }
}

export class ClaudeRuntime {
  private readonly running = new Map<string, { stop: AbortController; done: Promise<void> }>();
  private preparing?: Promise<void>;
  private closed = false;
  private readonly root: string;
  constructor(private readonly options: RuntimeOptions) { privateDir(options.directory); this.root = fs.realpathSync(options.directory); }
  private reserve(id: string, signal?: AbortSignal) {
    interrupted(signal);
    if (this.closed) throw new Error("Claude runtime is shutting down");
    if (this.running.has(id)) throw new Error("This session already has an active operation");
    const stop = new AbortController(), abort = () => stop.abort(signal?.reason);
    signal?.addEventListener("abort", abort, {once: true});
    let complete!: () => void;
    const done = new Promise<void>(resolve => { complete = resolve; });
    this.running.set(id, {stop, done});
    return {signal: stop.signal, finish: () => { signal?.removeEventListener("abort", abort); this.running.delete(id); complete(); }};
  }
  private async access(owner?: string, signal?: AbortSignal) {
    interrupted(signal);
    const access = await abortable(this.options.access(), signal);
    interrupted(signal);
    if (!access.owner || owner && access.owner !== owner) throw new Error("This Claude session belongs to another account");
    return access;
  }
  private authorizationContext(session: ClaudeSession): ClaudeAuthorization {
    if (!session.contractSha256 || !session.contract) throw new Error("This legacy capture has no immutable model contract; export it and start a new session");
    return {sessionId: session.id, owner: session.owner, model: session.model, workspaceId: session.workspaceId, contractSha256: session.contractSha256};
  }
  private async grant(session: ClaudeSession, refresh = false, signal?: AbortSignal) {
    await this.access(session.owner, signal);
    interrupted(signal);
    const context = {...this.authorizationContext(session), refresh};
    const grant = validateGrant(await this.options.authorize(context), context);
    interrupted(signal);
    const isolation = session.modelIsolation ??= initialModelIsolation(session.model);
    if (isolation.resolvedModel && isolation.resolvedModel !== grant.upstreamModel || session.authorization?.upstreamModel && session.authorization.upstreamModel !== grant.upstreamModel) {
      isolation.status = "invalid"; isolation.issues.push("upstream_binding_changed");
      this.modelEvidence(session, {type: "rejected_authorization", reason: "upstream_binding_changed"});
      throw new Error("The backend changed this session's upstream model binding");
    }
    isolation.resolvedModel = grant.upstreamModel;
    if (session.authorization?.bindingId && grant.bindingId !== session.authorization.bindingId) throw new Error("The backend changed this session's immutable binding");
    session.authorization = {binding: grant.contractSha256 ? "session-model-contract" : "session-model", bindingId: grant.bindingId, upstreamModel: grant.upstreamModel, policyVersion: grant.policyVersion ?? null, budget: grant.budget ?? null};
    return grant;
  }
  private dir(owner: string, id: string) {
    if (!UUID.test(id)) throw new Error("Invalid Claude session ID");
    return path.join(this.root, digest(owner), id);
  }
  private async docker(args: string[], options: { input?: string; signal?: AbortSignal; stdout?: (bytes: Buffer) => void; timeout?: number } = {}): Promise<string> {
    interrupted(options.signal);
    return await new Promise((resolve, reject) => {
      const child = spawn(this.options.docker ?? "docker", args, {stdio: ["pipe", "pipe", "pipe"], windowsHide: true});
      const output: Buffer[] = []; let bytes = 0, error = "", failed: Error | undefined;
      const abort = () => { failed = new Error("Claude sandbox operation interrupted"); child.kill("SIGKILL"); };
      const timer = setTimeout(abort, options.timeout ?? 120_000);
      options.signal?.addEventListener("abort", abort, {once: true});
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          if (options.stdout) options.stdout(chunk);
          else { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw new Error("Sandbox output exceeds limit"); output.push(chunk); }
        } catch (e) { failed = e instanceof Error ? e : new Error(String(e)); child.kill("SIGKILL"); }
      });
      child.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString("utf8")).slice(-8192); });
      child.on("error", (e) => { failed = e; });
      child.on("close", (code) => {
        clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
        if (failed) reject(failed);
        else if (code !== 0) reject(new Error(`Sandbox ${args[0]} failed (${code}): ${error.trim()}`));
        else resolve(Buffer.concat(output).toString("utf8").trim());
      });
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
      if (options.signal?.aborted) abort();
    });
  }
  async available() {
    const access = await this.access();
    if (!access.capabilities?.includes("claude-code")) return {allowed: false, sandboxReady: false, model: MODEL, sdkVersion: SDK_VERSION};
    try { await this.docker(["info", "--format", "{{.ServerVersion}}"], {timeout: 10_000}); return {allowed: true, sandboxReady: true, model: MODEL, sdkVersion: SDK_VERSION}; }
    catch { return {allowed: true, sandboxReady: false, model: MODEL, sdkVersion: SDK_VERSION}; }
  }
  async prepare(signal?: AbortSignal) {
    const job = this.reserve(`prepare:${randomUUID()}`, signal);
    try {
      if (!(await this.access(undefined, job.signal)).capabilities?.includes("claude-code")) throw new Error("Claude Code capture is not enabled for this account");
      interrupted(job.signal);
      if (this.preparing) return await abortable(this.preparing, job.signal);
      const preparing = this.prepareImage(job.signal); this.preparing = preparing;
      try { await preparing; } finally { if (this.preparing === preparing) this.preparing = undefined; }
    } finally { job.finish(); }
  }
  private async prepareImage(signal: AbortSignal) {
    const fingerprint = digest(JSON.stringify(this.harnessContract()));
    try {
      const inspected = JSON.parse(await this.docker(["image", "inspect", IMAGE], {signal}));
      interrupted(signal);
      if (inspected?.[0]?.Config?.Labels?.["org.omnirush.claude.runtime"] === fingerprint) return;
    } catch { interrupted(signal); /* build the pinned runtime */ }
    const build = path.join(this.root, "build", fingerprint); privateDir(build);
    fs.writeFileSync(path.join(build, "Dockerfile"), DOCKERFILE);
    fs.writeFileSync(path.join(build, "controller.mjs"), CONTROLLER);
    fs.writeFileSync(path.join(build, "managed-settings.json"), MANAGED_SETTINGS);
    fs.writeFileSync(path.join(build, "package.json"), PACKAGE_JSON);
    fs.writeFileSync(path.join(build, "pnpm-lock.yaml"), LOCKFILE);
    await this.docker(["build", "--label", `org.omnirush.claude.runtime=${fingerprint}`, "--tag", IMAGE, build], {signal, timeout: 15 * 60_000, stdout: () => {}});
    interrupted(signal);
  }
  private async checkpoint(container: string, dir: string, prior: Checkpoint[] = [], signal?: AbortSignal): Promise<Checkpoint> {
    // Container is stopped: no tool or background child can race the checkpoint.
    const image = await this.docker(["commit", container], {signal});
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Invalid sandbox checkpoint identity");
    const file = `images/${image.slice(7)}.tar.gz`, target = path.join(dir, file);
    privateDir(path.dirname(target));
    const tar = `${target}.tar.tmp`, tmp = `${target}.tmp`;
    try {
      const loaded = new Set<string>();
      for (const cp of prior) {
        try { await this.docker(["image", "inspect", cp.image], {signal}); }
        catch { interrupted(signal); if (!loaded.has(cp.file)) { await this.loadCheckpoint(cp, dir, signal); loaded.add(cp.file); } }
      }
      // Docker's multi-image archive stores common layers once while retaining
      // the exact config/image digest of every before/after environment.
      await this.docker(["save", "--output", tar, ...new Set([...prior.map(cp => cp.image), image])], {signal, timeout: 5 * 60_000});
      await pipeline(fs.createReadStream(tar), createGzip({level: 1}), fs.createWriteStream(tmp, {mode: 0o600}), {signal});
      interrupted(signal);
      const fd = fs.openSync(tmp, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, target);
      if (process.platform !== "win32") { const parent = fs.openSync(path.dirname(target), "r"); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); } }
      return {image, file, sha256: await fileHash(target), bytes: fs.statSync(target).size};
    } finally { await fsp.rm(tar, {force: true}); await fsp.rm(tmp, {force: true}); }
  }
  private checkpoints(session: ClaudeSession) { return [session.base, ...session.turns.flatMap(turn => turn.after ? [turn.after] : [])]; }
  private repointArchive(session: ClaudeSession, current: Checkpoint) {
    for (const cp of [session.base, ...session.turns.flatMap(turn => turn.after ? [turn.before, turn.after] : [turn.before])]) Object.assign(cp, {file: current.file, sha256: current.sha256, bytes: current.bytes});
  }
  private async pruneArchives(session: ClaudeSession) {
    const dir = this.dir(session.owner, session.id), keep = new Set(this.checkpoints(session).map(cp => path.basename(cp.file)));
    for (const name of await fsp.readdir(path.join(dir, "images"))) if (/^[a-f0-9]{64}\.tar\.gz$/.test(name) && !keep.has(name)) await fsp.rm(path.join(dir, "images", name));
  }
  private async loadCheckpoint(checkpoint: Checkpoint, dir: string, signal?: AbortSignal) {
    if (await fileHash(path.join(dir, checkpoint.file)) !== checkpoint.sha256) throw new Error("Environment archive integrity failure");
    const tar = path.join(dir, `restore-${randomUUID()}.tar.tmp`);
    try {
      await pipeline(fs.createReadStream(path.join(dir, checkpoint.file)), createGunzip(), fs.createWriteStream(tar, {mode: 0o600}), {signal});
      await this.docker(["load", "--input", tar], {signal, timeout: 5 * 60_000});
    } finally { await fsp.rm(tar, {force: true}); }
  }
  private createContainer(name: string, image: string, bootstrap = false, signal?: AbortSignal, ownership?: string) {
    return this.docker(["create", "--name", name, "--label", "omnirush.claude=true", ...(ownership ? ["--label", `org.omnirush.claude.operation=${ownership}`] : []), "--init", "--cap-drop=ALL", ...(bootstrap ? ["--cap-add=CHOWN"] : []), "--security-opt=no-new-privileges", "--pids-limit=512", "--memory=4g", "--cpus=2", "--add-host=host.docker.internal:host-gateway", image], {signal});
  }
  private async restoreContainerIfMissing(session: ClaudeSession, signal?: AbortSignal) {
    try { await this.docker(["container", "inspect", session.container], {signal}); interrupted(signal); return; } catch { interrupted(signal); /* validate the saved image before reconstructing */ }
    const turn = session.turns.at(-1);
    if (turn && (turn.status !== "complete" || !turn.after)) throw new Error("The interrupted container is missing; retain its partial evidence for review");
    const checkpoint = turn?.after ?? session.base;
    await this.loadCheckpoint(checkpoint, this.dir(session.owner, session.id), signal);
    const ownership = randomUUID();
    try { await this.createContainer(session.container, checkpoint.image, false, signal, ownership); interrupted(signal); }
    catch (error) { await this.cleanupStartup(ownership); throw error; }
  }
  async create(workspace: string, workspaceId: string, signal?: AbortSignal): Promise<ClaudeSession> {
    const id = randomUUID(), job = this.reserve(id, signal), ownership = randomUUID();
    const container = `omnirush-claude-${id}`;
    let attempted = false;
    try {
      const {owner} = await this.access(undefined, job.signal); await this.prepare(job.signal);
      interrupted(job.signal);
      const root = await fsp.realpath(workspace);
      if (!(await fsp.stat(root)).isDirectory() || root === path.parse(root).root) throw new Error("Choose a project directory");
      interrupted(job.signal);
      if (!workspaceId.trim()) throw new Error("Workspace identity is required");
      const dir = this.dir(owner, id); privateDir(dir);
      const inspected = JSON.parse(await this.docker(["image", "inspect", IMAGE], {signal: job.signal}));
      const image = inspected?.[0];
      if (!isRecord(image) || typeof image.Id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(image.Id) || image.Os !== "linux" || typeof image.Architecture !== "string") throw new Error("The Claude runtime image must have an exact Linux identity");
      attempted = true;
      await this.createContainer(container, image.Id, true, job.signal, ownership);
      // Copy, never bind-mount: tools cannot reach the host through a symlink.
      await this.docker(["cp", `${root}${path.sep}.`, `${container}:/workspace/`], {signal: job.signal, timeout: 5 * 60_000});
      await this.docker(["start", container], {signal: job.signal});
      await this.docker(["exec", "--user", "root", container, "chown", "-R", "node:node", "/workspace"], {signal: job.signal});
      await this.docker(["stop", "--time", "2", container], {signal: job.signal});
      const base = await this.checkpoint(container, dir, [], job.signal);
      await this.docker(["rm", container], {signal: job.signal});
      await this.createContainer(container, base.image, false, job.signal, ownership);
      interrupted(job.signal);
      const contract: ClaudeSessionContract = {
        schema: 1, sessionId: id, owner, workspaceId, model: MODEL,
        harness: this.harnessContract(),
        execution: {kind: "docker", os: "linux", architecture: image.Architecture, workingDirectory: "/workspace", shell: "/bin/bash", runtimeImage: image.Id, baseImage: base.image, workspace: "session-copy"},
        capture: {policyVersion: CAPTURE_POLICY_VERSION, originals: "private", modelIsolation: "exact", scope: "managed-inference", network: "development-network-enabled", initialWorkspaceProvenance: "user-supplied-unattested"},
      };
      const contractSha256 = digest(JSON.stringify(contract));
      const session: ClaudeSession = {schema: 1, id, owner, workspaceId, surface: this.options.surface, model: MODEL, sdkVersion: SDK_VERSION, claudeVersion: CLAUDE_VERSION, createdAt: new Date().toISOString(), container, base, turns: [], capture: "capturing", replay: "unverified", issues: [], contract, contractSha256, compatibility: "current", modelIsolation: initialModelIsolation(MODEL)};
      save(path.join(dir, "policy", "contract.json"), {contract, sha256: contractSha256});
      save(path.join(dir, "session.json"), session); return session;
    } catch (e) {
      if (attempted) await this.cleanupStartup(ownership);
      throw e;
    } finally { job.finish(); }
  }
  private async cleanupStartup(ownership: string) {
    // The operation label is minted before create and inherited by checkpoints.
    // Never remove a container by an unverified name or a shared runtime image.
    for (const kind of ["container", "image"] as const) {
      try {
        const ids = await this.docker([kind, "ls", "--all", "--quiet", "--no-trunc", "--filter", `label=org.omnirush.claude.operation=${ownership}`], {timeout: 10_000});
        for (const id of new Set(ids.split(/\s+/).filter(value => /^(sha256:)?[a-f0-9]{64}$/.test(value)))) {
          const inspected = JSON.parse(await this.docker([kind, "inspect", id], {timeout: 10_000}));
          if (inspected?.[0]?.Config?.Labels?.["org.omnirush.claude.operation"] === ownership) await this.docker([kind, "rm", "--force", id], {timeout: 10_000});
        }
      } catch { /* Docker may be unavailable; keep the operation-labelled resources for recovery. */ }
    }
  }
  private localPath(file: string, directory: boolean) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
        typeof process.getuid === "function" && stat.uid !== process.getuid() || fs.realpathSync(file) !== file) throw new Error("Claude evidence path is not a private local path");
  }
  private ownerDirectories() {
    this.localPath(this.root, true);
    return fs.readdirSync(this.root).filter(name => /^[a-f0-9]{64}$/.test(name));
  }
  async list(workspaceId: string): Promise<ClaudeSession[]> {
    const sessions: ClaudeSession[] = [];
    for (const owner of this.ownerDirectories()) {
      const root = path.join(this.root, owner); this.localPath(root, true);
      for (const id of fs.readdirSync(root).filter(id => UUID.test(id))) {
        try { const session = await this.get(id); if (session.workspaceId === workspaceId) sessions.push(session); }
        catch (error) { if (!isRecord(error) || error.code !== "ENOENT") throw error; }
      }
    }
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async get(id: string): Promise<ClaudeSession> {
    if (!UUID.test(id)) throw new Error("Invalid Claude session ID");
    let found: ClaudeSession | undefined;
    for (const owner of this.ownerDirectories()) {
      const root = path.join(this.root, owner); this.localPath(root, true);
      const dir = path.join(root, id);
      try { this.localPath(dir, true); } catch (error) { if (isRecord(error) && error.code === "ENOENT") continue; throw error; }
      const file = path.join(dir, "session.json"); this.localPath(file, false);
      const session: ClaudeSession = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!session || typeof session.owner !== "string" || !session.owner || digest(session.owner) !== owner || session.id !== id ||
          typeof session.workspaceId !== "string" || !session.workspaceId.trim() || session.container !== `omnirush-claude-${id}` ||
          session.contract && (session.contract.owner !== session.owner || session.contract.sessionId !== id || session.contract.workspaceId !== session.workspaceId)) throw new Error("Claude session identity mismatch");
      if (found) throw new Error("Ambiguous local Claude session identity");
      found = session;
    }
    if (!found) throw Object.assign(new Error("Claude session not found"), {code: "ENOENT"});
    if (found.contract) {
      const policy = path.join(this.dir(found.owner, id), "policy");
      try { this.localPath(policy, true); this.localPath(path.join(policy, "contract.json"), false); }
      catch (error) { if (!isRecord(error) || error.code !== "ENOENT") throw error; }
    }
    found.compatibility = this.compatibility(found);
    found.modelIsolation ??= initialModelIsolation(found.model, true);
    return found;
  }
  private harnessContract(): ClaudeSessionContract["harness"] {
    return {name: "claude-code", sdkVersion: SDK_VERSION, claudeVersion: CLAUDE_VERSION, controllerSha256: digest(CONTROLLER), lockSha256: digest(PACKAGE_JSON + "\n" + LOCKFILE), managedSettingsSha256: digest(MANAGED_SETTINGS), dockerfileSha256: digest(DOCKERFILE)};
  }
  private compatibility(session: ClaudeSession): NonNullable<ClaudeSession["compatibility"]> {
    if (!session.contract || !session.contractSha256) return "legacy_unverified";
    const c = session.contract;
    let saved: unknown;
    try { saved = JSON.parse(fs.readFileSync(path.join(this.dir(session.owner, session.id), "policy", "contract.json"), "utf8")); } catch { return "contract_invalid"; }
    if (!isRecord(saved) || !isRecord(saved.contract) || saved.sha256 !== session.contractSha256 || digest(JSON.stringify(saved.contract)) !== session.contractSha256 || digest(JSON.stringify(c)) !== session.contractSha256 ||
      c.schema !== 1 || c.sessionId !== session.id || c.owner !== session.owner || c.workspaceId !== session.workspaceId || c.model !== session.model || c.model !== MODEL || c.execution?.baseImage !== session.base.image || c.execution?.kind !== "docker" || c.execution.os !== "linux" || c.execution.shell !== "/bin/bash" || c.execution.workingDirectory !== "/workspace") return "contract_invalid";
    if (session.sdkVersion !== SDK_VERSION || session.claudeVersion !== CLAUDE_VERSION || JSON.stringify(c.harness) !== JSON.stringify(this.harnessContract()) || c.capture?.policyVersion !== CAPTURE_POLICY_VERSION) return "runtime_upgrade_required";
    return "current";
  }
  private assertResumable(session: ClaudeSession) {
    const compatibility = this.compatibility(session);
    if (compatibility !== "current") throw new Error(compatibility === "legacy_unverified" ? "This legacy capture has no immutable model contract; export it and start a new session" : compatibility === "runtime_upgrade_required" ? "This session requires its recorded Claude runtime; start a new session for this runtime version" : "This Claude session's immutable model or environment contract changed");
    if (session.modelIsolation?.status === "invalid") throw new Error("This session failed model isolation; retain its evidence and start a new session");
    if (session.modelIsolation?.status === "unknown") throw new Error("This session has incomplete provider model identity; retain its evidence and start a new session");
    if (session.modelIsolation?.status === "legacy_unverified") throw new Error("This session has no trustworthy model evidence; start a new session");
    const evidence = path.join(this.dir(session.owner, session.id), "policy", "model-requests.jsonl");
    const isolation = session.modelIsolation;
    if (isolation?.expectedModel !== session.model || (fs.existsSync(evidence) || isolation.inferenceRequests > 0) && !isolation.evidenceSha256) throw new Error("The session's model evidence is incomplete; retain it for review");
    if (isolation.evidenceSha256) {
      if (!fs.existsSync(evidence)) throw new Error("The model evidence journal is missing; retain this session for review");
      const bytes = fs.readFileSync(evidence);
      if (createHash("sha256").update(bytes).digest("hex") !== isolation.evidenceSha256 || bytes.length !== isolation.evidenceBytes) throw new Error("The model evidence journal changed; retain this session for review");
      const pending = new Map<string, boolean>(), seen = new Set<string>();
      try {
        for (const line of bytes.toString("utf8").split("\n").filter(Boolean)) {
          const event: unknown = JSON.parse(line);
          if (!isRecord(event)) throw new Error();
          if (event.type === "request") {
            if (typeof event.requestId !== "string" || seen.has(event.requestId)) throw new Error();
            seen.add(event.requestId); pending.set(event.requestId, event.route === "messages");
          } else if (event.type === "response") {
            if (typeof event.requestId !== "string" || !pending.delete(event.requestId)) throw new Error();
          }
        }
      } catch { throw new Error("The model evidence journal is invalid; retain this session for review"); }
      if ([...pending.values()].some(inference => inference)) throw new Error("A previous model request has no terminal evidence; retain this session and start a new one");
    }
  }
  private modelEvidence(session: ClaudeSession, event: Record<string, unknown>) {
    const dir = this.dir(session.owner, session.id), file = path.join(dir, "policy", "model-requests.jsonl");
    privateDir(path.dirname(file));
    const fd = fs.openSync(file, "a", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({schema: 1, time: new Date().toISOString(), sessionId: session.id, turn: session.turns.at(-1)?.number ?? 0, ...event}) + "\n"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const isolation = session.modelIsolation ??= initialModelIsolation(session.model);
    const bytes = fs.readFileSync(file);
    isolation.evidenceSha256 = createHash("sha256").update(bytes).digest("hex"); isolation.evidenceBytes = bytes.length;
    save(path.join(dir, "session.json"), session);
  }
  private collector(session: ClaudeSession, savedOnly = false) {
    const dir = this.dir(session.owner, session.id);
    if (savedOnly) this.localPath(path.join(dir, "native", "manifest.json"), false);
    else privateDir(path.join(dir, "config"));
    return new NativeCapture({directory: path.join(dir, "native"), configDir: path.join(dir, "config"), sessionId: session.id, owner: session.owner, producerVersion: savedOnly ? session.claudeVersion : CLAUDE_VERSION, surface: session.surface, transport: "sdk"});
  }
  private async collect(session: ClaudeSession, stopped: boolean, success: boolean) {
    const dir = this.dir(session.owner, session.id), config = path.join(dir, "config"); privateDir(config);
    const staging = path.join(dir, `capture-${randomUUID()}`); privateDir(staging);
    try {
      await this.docker(["cp", `${session.container}:/home/node/.claude/projects`, staging]);
      await fsp.rm(path.join(config, "projects"), {recursive: true, force: true});
      await fsp.rename(path.join(staging, "projects"), path.join(config, "projects"));
    } finally { await fsp.rm(staging, {recursive: true, force: true}); }
    const evidence = path.join(dir, "transport"); privateDir(evidence);
    await this.docker(["cp", `${session.container}:/home/node/evidence/.`, evidence]);
    const collector = this.collector(session);
    for (const channel of ["sdk", "hooks"] as const) {
      const file = path.join(evidence, `${channel}.jsonl`);
      if (!fs.existsSync(file)) continue;
      const bytes = fs.readFileSync(file), offset = collector.verify().streams[channel];
      if (bytes.length < offset) throw new Error("Sandbox evidence was truncated");
      // Compare the acknowledged prefix too: a tool cannot silently rewrite
      // events already persisted outside the sandbox.
      for (let position = 0; position < bytes.length; position += 8 * 1024 * 1024) collector.recordStream(channel, bytes.subarray(position, position + 8 * 1024 * 1024), position);
    }
    const starts = new Set<string>(), stops = new Set<string>();
    const hooks = await fsp.readFile(path.join(evidence, "hooks.jsonl"), "utf8").catch(() => "");
    for (const line of hooks.split("\n")) {
      if (!line) continue;
      const record = JSON.parse(line), input = record.input;
      if (typeof input?.agent_id !== "string") continue;
      if (input.hook_event_name === "SubagentStart") starts.add(input.agent_id);
      if (input.hook_event_name === "SubagentStop") stops.add(input.agent_id);
    }
    const childrenStopped = [...starts].every(id => stops.has(id));
    const manifest = stopped ? collector.finish({type: "finish", processStopped: true, successfulResult: success && childrenStopped, expectedAgents: [...starts]}) : collector.scan();
    session.capture = manifest.status; session.issues = manifest.issues;
    return manifest;
  }
  private async broker(session: ClaudeSession, onInvalid: () => void, signal?: AbortSignal) {
    interrupted(signal);
    const token = randomUUID();
    const active = new Set<AbortController>(), pending = new Set<Promise<void>>();
    const isolation = session.modelIsolation ??= initialModelIsolation(session.model);
    const invalid = () => isolation.status === "invalid";
    const unidentified = () => {
      if (!invalid()) isolation.status = "unknown";
      if (!isolation.issues.includes("provider_identity_missing_or_malformed")) isolation.issues.push("provider_identity_missing_or_malformed");
      for (const request of active) request.abort();
      onInvalid();
      throw new Error("The provider did not establish this session's model identity");
    };
    const invalidate = (reason: string) => {
      isolation.status = "invalid";
      if (!isolation.issues.includes(reason)) isolation.issues.push(reason);
      for (const request of active) request.abort();
      onInvalid();
    };
    const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      const supplied = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403).end(); return; }
      if (req.method !== "POST" || !/^\/v1\/messages(?:\/count_tokens)?(?:\?[^#]*)?$/.test(req.url ?? "")) { res.writeHead(404).end(); return; }
      const url = new URL(req.url ?? "", "http://claude-session-broker");
      if ([...url.searchParams].some(([name, value]) => name !== "beta" || value !== "true")) { res.writeHead(400, {"content-type": "application/json"}).end(JSON.stringify({type: "error", error: {type: "invalid_request_error", message: "Unsupported session routing parameter"}})); return; }
      if (invalid() || isolation.status === "unknown") { res.writeHead(409, {"content-type": "application/json", "x-should-retry": "false"}).end(JSON.stringify({type: "error", error: {type: "invalid_request_error", message: "Session model isolation failed"}})); return; }
      const abort = new AbortController(), cancel = () => abort.abort(signal?.reason); active.add(abort);
      signal?.addEventListener("abort", cancel, {once: true});
      if (signal?.aborted) cancel();
      res.on("close", () => { if (!res.writableFinished) abort.abort(); });
      const requestId = randomUUID(), inference = !req.url?.startsWith("/v1/messages/count_tokens");
      const authorizationFailures: number[] = [];
      let observer: ResponseIdentity | undefined, admitted = false, responseStatus: number | null = null, finished = false;
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new Error("Request too large"); chunks.push(chunk); }
        const originalBody = Buffer.concat(chunks), body = JSON.parse(originalBody.toString("utf8"));
        if (!isRecord(body) || body.model !== session.model) {
          isolation.rejectedRequests++; invalidate("request_model_mismatch");
          this.modelEvidence(session, {type: "rejected", requestId, route: inference ? "messages" : "count_tokens", requestedModel: identityLabel(body?.model), resolvedModel: session.model, reason: "request_model_mismatch"});
          res.writeHead(400, {"content-type": "application/json"}).end(JSON.stringify({type: "error", error: {type: "invalid_request_error", message: "This session accepts only its fixed model"}})); return;
        }
        let grant = await this.grant(session, false, abort.signal);
        if (isolation.status === "invalid" || abort.signal.aborted) throw new Error("Model isolation failed");
        // Routing/model override headers never cross this boundary. SDK version
        // and beta negotiation are explicitly listed rather than prefix-trusted.
        const headers: Record<string, string> = {"content-type": "application/json", "x-api-key": grant.token, "x-omnirush-session-id": session.id, "x-omnirush-request-id": requestId, "x-omnirush-client": grant.client, "x-omnirush-box": "1"};
        for (const name of ["anthropic-version", "anthropic-beta", "user-agent", "x-app"]) { const value = req.headers[name]; if (typeof value === "string") headers[name] = value; }
        // Ask for the provider-exposed summary; never fabricate hidden reasoning.
        const transformations: string[] = [];
        if (isRecord(body.thinking) && body.thinking.type === "adaptive" && body.thinking.display !== "summarized") { body.thinking.display = "summarized"; transformations.push("thinking.display=summarized"); }
        const forwardedBody = JSON.stringify(body);
        if (inference) isolation.inferenceRequests++;
        admitted = true;
        this.modelEvidence(session, {type: "request", requestId, route: inference ? "messages" : "count_tokens", requestedModel: body.model, resolvedModel: grant.upstreamModel, binding: session.authorization?.binding, contractSha256: session.contractSha256, policyVersion: grant.policyVersion ?? null, budget: grant.budget ?? null, transformations, originalBodySha256: createHash("sha256").update(originalBody).digest("hex"), forwardedBodySha256: digest(forwardedBody)});
        let upstream = await this.options.fetch(grant.baseUrl + req.url, {method: "POST", headers, body: forwardedBody, redirect: "error", signal: abort.signal});
        if (upstream.status === 401 && !abort.signal.aborted) {
          // A rejected token has not admitted inference. Re-mint exactly once;
          // never replay a started stream, a quota refusal, or a provider error.
          await upstream.body?.cancel();
          authorizationFailures.push(401);
          grant = await this.grant(session, true, abort.signal);
          interrupted(abort.signal);
          headers["x-api-key"] = grant.token;
          upstream = await this.options.fetch(grant.baseUrl + req.url, {method: "POST", headers, body: forwardedBody, redirect: "error", signal: abort.signal});
        }
        responseStatus = upstream.status; res.statusCode = upstream.status;
        for (const [name, value] of Object.entries(claudeResponseHeaders(upstream.headers))) res.setHeader(name, value);
        const streaming = upstream.headers.get("content-type")?.includes("text/event-stream") === true;
        if (inference && upstream.ok) observer = new ResponseIdentity(streaming, model => {
          if (!isolation.observedModels.includes(model)) isolation.observedModels.push(model);
          this.modelEvidence(session, {type: "provider_identity", requestId, requestedModel: session.model, resolvedModel: grant.upstreamModel, providerModel: model, source: "response-body"});
          if (model !== grant.upstreamModel) { invalidate("provider_model_mismatch"); throw new Error("The provider served another model"); }
        });
        const buffered: Uint8Array[] = []; let responseBytes = 0;
        if (upstream.body) for await (const bytes of upstream.body) {
          observer?.push(bytes);
          if (observer?.malformed) unidentified();
          if (observer) {
            responseBytes += bytes.length;
            if (responseBytes > 32 * 1024 * 1024) throw new Error("Non-streaming model response exceeded the evidence bound");
            buffered.push(bytes);
            // No provider text or tool call reaches the SDK until the actual
            // message envelope identifies the pinned model. Preserve bytes.
            if (streaming && observer.models.size) {
              for (const chunk of buffered) if (!res.write(chunk)) await once(res, "drain", {signal: abort.signal});
              buffered.length = 0; responseBytes = 0;
            }
          } else if (!res.write(bytes)) await once(res, "drain", {signal: abort.signal});
        }
        observer?.finish();
        if (observer && (!observer.models.size || observer.malformed)) unidentified();
        for (const bytes of buffered) if (!res.write(bytes)) await once(res, "drain", {signal: abort.signal});
        finished = true;
        res.end();
      } catch (error) {
        if (invalid()) onInvalid();
        if (!res.headersSent) {
          const status = error instanceof ClaudeAccessError ? error.status : 502;
          const headers: Record<string, string> = {...(error instanceof ClaudeAccessError ? error.responseHeaders : {}), "content-type": "application/json"};
          if (status < 500 && status !== 429) headers["x-should-retry"] = "false";
          if (error instanceof ClaudeAccessError && error.retryAfter) headers["retry-after"] = error.retryAfter;
          res.writeHead(status, headers).end(JSON.stringify({type: "error", error: {type: status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status < 500 ? "invalid_request_error" : "api_error", message: error instanceof ClaudeAccessError ? error.message : "Internal Claude access is unavailable"}}));
        } else res.destroy();
      }
      finally {
        active.delete(abort); signal?.removeEventListener("abort", cancel);
        if (admitted) {
          if (inference && observer) {
            if (observer.complete && finished) isolation.completedRequests++;
            else isolation.interruptedRequests++;
            if (!observer.models.size || observer.malformed) isolation.missingIdentityRequests++;
          } else if (inference && responseStatus === null) { isolation.interruptedRequests++; isolation.missingIdentityRequests++; }
          if (isolation.status !== "invalid") isolation.status = isolation.missingIdentityRequests ? "unknown" : isolation.observedModels.length ? "observed" : "pending";
          this.modelEvidence(session, {type: "response", requestId, status: responseStatus, ...(authorizationFailures.length ? {authorizationFailures} : {}), completed: finished && observer?.complete === true, providerModels: observer ? [...observer.models] : [], identity: observer?.models.size && !observer.malformed ? "reported" : "unknown", streamComplete: observer?.complete ?? false});
        }
      }
    };
    const server = http.createServer((req, res) => {
      const work = handle(req, res); pending.add(work);
      void work.catch(() => { invalidate("model_evidence_persistence_failed"); res.destroy(); }).finally(() => pending.delete(work));
    });
    server.listen(0, "0.0.0.0"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Inference broker did not start");
    return {token, baseUrl: `http://host.docker.internal:${address.port}`, close: async () => { for (const request of active) request.abort(); server.closeAllConnections(); server.close(); await Promise.allSettled([...pending]); }};
  }
  async start(id: string, prompt: string, signal?: AbortSignal): Promise<void> {
    if (!prompt.trim() || prompt.length > 100_000) throw new Error("Enter a prompt of at most 100,000 characters");
    const job = this.reserve(id, signal);
    let release: (() => void) | undefined;
    try {
      let session = await this.get(id);
      await this.access(session.owner, job.signal);
      interrupted(job.signal);
      release = this.lock(session);
      session = await this.get(id);
      if (session.turns.at(-1)?.status === "running") throw new Error("Recover the interrupted session before continuing");
      if (session.turns.length && !session.turns.at(-1)?.after) throw new Error("Recover the missing environment checkpoint before continuing");
      this.assertResumable(session);
      await this.restoreContainerIfMissing(session, job.signal);
      interrupted(job.signal);
      const unlock = release;
      void this.run(session, prompt, job.signal).catch(() => {}).finally(() => { try { unlock(); } finally { job.finish(); } }).catch(() => {});
    } catch (e) { try { release?.(); } finally { job.finish(); } throw e; }
  }
  async wait(id: string) { await this.running.get(id)?.done; return this.get(id); }
  async stop(id: string) {
    // Abort first, including startup before session.json exists or access resolves.
    this.running.get(id)?.stop.abort();
    return this.wait(id);
  }
  private async run(session: ClaudeSession, prompt: string, signal: AbortSignal) {
    const dir = this.dir(session.owner, session.id), state = path.join(dir, "session.json");
    const collector = this.collector(session); let offset = collector.verify().streams.sdk;
    const turn: Turn = {number: session.turns.length + 1, prompt, startedAt: new Date().toISOString(), sdkStart: offset, status: "running", before: session.turns.at(-1)?.after ?? session.base};
    session.turns.push(turn); session.capture = "capturing"; session.replay = "unverified"; save(state, session);
    let broker: Awaited<ReturnType<ClaudeRuntime["broker"]>> | undefined;
    let outcome: Turn["status"] = "failed";
    const isolationStop = new AbortController();
    const executionSignal = AbortSignal.any([signal, isolationStop.signal]);
    try {
      interrupted(executionSignal);
      await this.grant(session, false, executionSignal);
      interrupted(executionSignal);
      await this.docker(["start", session.container], {signal: executionSignal});
      interrupted(executionSignal);
      broker = await this.broker(session, () => isolationStop.abort(), executionSignal);
      interrupted(executionSignal);
      const actual = await this.docker(["exec", session.container, "sha256sum", "/opt/claude/controller.mjs", "/etc/claude-code/managed-settings.json"], {signal: executionSignal});
      if (actual.split("\n").map(line => line.split(/\s+/)[0]).join(":") !== `${digest(CONTROLLER)}:${digest(MANAGED_SETTINGS)}`) throw new Error("The sandbox controller or managed model policy changed");
      await this.docker(["exec", "-i", session.container, "node", "/opt/claude/controller.mjs"], {
        input: JSON.stringify({sessionId: session.id, resume: turn.number > 1, turn: turn.number, prompt, model: session.model, baseUrl: broker.baseUrl, token: broker.token}), signal: executionSignal, timeout: 60 * 60_000,
        stdout: bytes => { collector.recordStream("sdk", bytes, offset); offset += bytes.length; },
      });
      if (session.modelIsolation?.status === "invalid") throw new Error("Session model isolation failed");
      outcome = "complete";
    } catch { outcome = signal.aborted ? "interrupted" : "failed"; turn.error = signal.aborted ? "Turn stopped; partial evidence retained" : "Claude turn failed; inspect the private diagnostic bundle"; }
    finally {
      await broker?.close();
      if (this.options.revoke) {
        try { await this.options.revoke(this.authorizationContext(session)); }
        catch { this.modelEvidence(session, {type: "authorization_revocation", status: "failed"}); }
      }
      try {
        await this.docker(["stop", "--time", "3", session.container]);
        turn.after = await this.checkpoint(session.container, dir, this.checkpoints(session));
        this.repointArchive(session, turn.after);
        const manifest = await this.collect(session, true, outcome === "complete");
        if (manifest.status !== "complete" && outcome === "complete") { outcome = "failed"; turn.error = "Native capture is incomplete"; }
      } catch (e) { session.capture = "incomplete"; session.issues = ["checkpoint_or_capture_failed"]; outcome = "failed"; turn.error = "Evidence could not be finalized; recover before continuing"; }
      turn.sdkEnd = fs.existsSync(path.join(dir, "native/events/sdk.jsonl")) ? fs.statSync(path.join(dir, "native/events/sdk.jsonl")).size : offset;
      // Persist replacement checkpoint references before pruning their old files.
      // Keep the turn running until cleanup ends: a terminal status enables the
      // next prompt/export, which must not race this operation's lock.
      save(state, session);
      await this.pruneArchives(session).catch(() => {});
      turn.status = outcome; turn.finishedAt = new Date().toISOString(); save(state, session);
    }
  }
  private recoveryGuard(dir: string) {
    const guard = path.join(dir, "recovery.lock"), staging = path.join(dir, `.recovery-stage-${randomUUID()}`);
    const owner = JSON.stringify({pid: process.pid, nonce: randomUUID(), identity: processIdentity(process.pid)});
    fs.mkdirSync(staging, {mode: 0o700});
    try {
      const fd = fs.openSync(path.join(staging, "owner.json"), "wx", 0o600);
      try { fs.writeFileSync(fd, owner); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      syncDirectory(staging);
      // Publish a complete, nonempty directory. A legacy empty file/directory
      // has no trustworthy owner and is deliberately never reclaimed.
      for (let attempt = 0; attempt < 3; attempt++) {
        let present = true;
        try { this.localPath(guard, true); }
        catch (error) { if (!isRecord(error) || error.code !== "ENOENT") throw error; present = false; }
        if (present) {
          const record = path.join(guard, "owner.json"); this.localPath(record, false);
          const bytes = fs.readFileSync(record, "utf8"), prior: unknown = JSON.parse(bytes);
          if (!deadLockOwner(prior)) throw new Error("Another process is recovering this session or its recovery owner is unknown");
          // Keep this nonempty tombstone permanently. If two reclaimers read
          // the same dead owner, only one rename can succeed: the loser cannot
          // overwrite the tombstone with a newer live guard (the ABA race).
          const tombstone = path.join(dir, `.recovery-dead-${digest(bytes)}`);
          if (fs.existsSync(tombstone)) throw new Error("The recovery guard generation already changed; retry the operation");
          try { fs.renameSync(guard, tombstone); syncDirectory(dir); }
          catch (error) { if (!isRecord(error) || !["ENOENT", "EEXIST", "ENOTEMPTY"].includes(String(error.code))) throw error; }
          continue;
        }
        try { fs.renameSync(staging, guard); }
        catch (error) { if (!isRecord(error) || !["EEXIST", "ENOTEMPTY"].includes(String(error.code))) throw error; continue; }
        syncDirectory(dir);
        return () => {
          this.localPath(guard, true); this.localPath(path.join(guard, "owner.json"), false);
          if (fs.readFileSync(path.join(guard, "owner.json"), "utf8") !== owner) throw new Error("The recovery guard owner changed");
          // Remove only our uniquely named directory after unpublishing it.
          // A crash on either side leaves a recoverable guard or harmless stage.
          fs.renameSync(guard, staging); syncDirectory(dir);
          fs.rmSync(staging, {recursive: true});
        };
      }
      throw new Error("Another process is recovering this session; retry the operation");
    } finally { fs.rmSync(staging, {recursive: true, force: true}); }
  }
  private lock(session: ClaudeSession, recover = false) {
    const dir = this.dir(session.owner, session.id), file = path.join(dir, "operation.lock"), nonce = randomUUID();
    const staged = path.join(dir, `.operation-${nonce}.tmp`);
    let releaseGuard: (() => void) | undefined;
    try {
      const fd = fs.openSync(staged, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({pid: process.pid, nonce, identity: processIdentity(process.pid)})); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (recover) {
        releaseGuard = this.recoveryGuard(dir);
        if (fs.existsSync(file)) {
          this.localPath(file, false);
          const bytes = fs.readFileSync(file, "utf8"), prior: unknown = JSON.parse(bytes);
          if (!deadLockOwner(prior)) throw new Error("Another process is using this session or its operation owner is unknown");
          fs.unlinkSync(file);
        }
      }
      // Atomic no-replace publication also prevents an ownerless operation
      // lock if the process crashes between opening and writing its record.
      try { fs.linkSync(staged, file); } catch { throw new Error("This session is in use or needs recovery after a process exit"); }
      syncDirectory(dir);
    } finally { try { releaseGuard?.(); } finally { fs.rmSync(staged, {force: true}); } }
    return () => { if (JSON.parse(fs.readFileSync(file, "utf8")).nonce === nonce) fs.unlinkSync(file); };
  }
  private async exclusive<T>(id: string, work: (signal: AbortSignal) => Promise<T>, recover = false): Promise<T> {
    const job = this.reserve(id);
    let release: (() => void) | undefined;
    try { const session = await this.get(id); interrupted(job.signal); release = this.lock(session, recover); return await work(job.signal); }
    finally { try { release?.(); } finally { job.finish(); } }
  }
  async recover(id: string) { return this.exclusive(id, signal => this.recoverStopped(id, signal), true); }
  private async recoverStopped(id: string, signal: AbortSignal) {
    const session = await this.get(id), dir = this.dir(session.owner, id), turn = session.turns.at(-1);
    if (!turn) return session;
    await this.access(session.owner, signal);
    await this.restoreContainerIfMissing(session, signal);
    await this.docker(["stop", "--time", "3", session.container]);
    turn.after = await this.checkpoint(session.container, dir, this.checkpoints(session));
    this.repointArchive(session, turn.after);
    if (turn.status === "running") turn.status = "interrupted";
    const recovered = await this.collect(session, true, turn.status === "complete");
    turn.sdkEnd = recovered.streams.sdk;
    turn.finishedAt ??= new Date().toISOString();
    save(path.join(dir, "session.json"), session); await this.pruneArchives(session); return session;
  }
  async events(id: string): Promise<DisplayEvent[]> {
    const session = await this.get(id), dir = this.dir(session.owner, id), output: DisplayEvent[] = [];
    const stream = path.join(dir, "native", "events", "sdk.jsonl");
    const bytes = await fsp.readFile(stream).catch(() => Buffer.alloc(0));
    // SDK init/result batches also occur for background-agent notifications.
    // Only the host's submitted-turn byte boundaries define a user's turn.
    for (const submitted of session.turns) {
      const turn = submitted.number;
      output.push({type: "user", text: submitted.prompt, turn});
      if (!Number.isSafeInteger(submitted.sdkStart)) continue; // pre-pilot captures have no reliable SDK boundary
      const text = bytes.subarray(submitted.sdkStart, submitted.sdkEnd ?? bytes.length).toString("utf8");
      for (const line of text.split("\n")) {
      let event: unknown; try { event = JSON.parse(line); } catch { continue; }
      if (!isRecord(event)) continue;
      if (event.type === "assistant" && isRecord(event.message) && Array.isArray(event.message.content)) for (const block of event.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") output.push({type: "assistant", text: block.text, turn});
        if (block.type === "thinking" && typeof block.thinking === "string") output.push({type: "thinking", text: block.thinking, turn});
        if (block.type === "tool_use" && typeof block.name === "string") output.push({type: "tool", text: block.name, turn});
      }
      }
      if (submitted.status !== "running") output.push({type: "result", text: submitted.status === "complete" ? "Turn finished" : submitted.status === "interrupted" ? "Turn interrupted" : "Turn failed", turn});
    }
    return output;
  }
  async verify(id: string, command = "node -e \"require('fs').accessSync('/workspace')\"") { return this.exclusive(id, () => this.verifyStopped(id, command)); }
  private async verifyStopped(id: string, command: string) {
    const session = await this.get(id), dir = this.dir(session.owner, id), checkpoint = session.turns.at(-1)?.after ?? session.base;
    await this.access(session.owner);
    this.collector(session).verify();
    const checked = new Set<string>();
    for (const cp of this.checkpoints(session)) {
      if (checked.has(cp.file)) continue;
      if (await fileHash(path.join(dir, cp.file)) !== cp.sha256) throw new Error("Environment archive integrity failure");
      checked.add(cp.file);
    }
    await this.loadCheckpoint(checkpoint, dir);
    const name = `omnirush-verify-${randomUUID()}`;
    try {
      const output = await this.docker(["run", "--name", name, "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=2g", checkpoint.image, "bash", "-lc", command]);
      const report = {schema: 1, sessionId: id, checkpoint: checkpoint.image, verifiedAt: new Date().toISOString(), command, output, status: "restored", meaning: "Exact environment restored and verification command passed; model re-execution is not claimed"};
      save(path.join(dir, "replay.json"), report); session.replay = "restored"; save(path.join(dir, "session.json"), session); return report;
    } finally { await this.docker(["rm", "-f", name]).catch(() => {}); }
  }
  async export(id: string) { return this.exclusive(id, () => this.exportStopped(id), true); }
  async prepareUpload(id: string, checkpoint: boolean) {
    return this.exclusive(id, async () => {
      const session = await this.get(id), stateDirectory = this.dir(session.owner, id);
      const bindingId = session.authorization?.bindingId, contractHash = session.contractSha256;
      if (!bindingId || !contractHash) throw new Error("This capture has no backend session binding; retain its local ZIP");
      const nativeDirectory = path.join(stateDirectory, `native-upload-${randomUUID()}`);
      this.collector(session).exportTo(nativeDirectory);
      save(path.join(nativeDirectory, "session.json"), session);
      await fsp.cp(path.join(stateDirectory, "policy"), path.join(nativeDirectory, "policy"), {recursive: true});
      const diagnostics = path.join(stateDirectory, "transport", "stderr.jsonl");
      if (fs.existsSync(diagnostics)) {
        privateDir(path.join(nativeDirectory, "diagnostics"));
        await fsp.copyFile(diagnostics, path.join(nativeDirectory, "diagnostics", "stderr.jsonl"));
      }
      const manifestSha256 = await writeBundleManifest(nativeDirectory, {sessionId: id, bindingId, contractHash, engineVersion: session.claudeVersion}, "claude_native");
      let checkpointFile: string | undefined, checkpointManifestSha256: string | undefined;
      if (checkpoint) {
        const file = await this.exportStopped(id, hash => { checkpointManifestSha256 = hash; });
        const sha = await fileHash(file);
        checkpointFile = path.join(stateDirectory, `checkpoint-${sha}.zip`);
        try { await fsp.link(file, checkpointFile); }
        catch (error) {
          if (!(isRecord(error) && error.code === "EEXIST") || await fileHash(checkpointFile) !== sha) throw error;
        }
      }
      return {session, stateDirectory, nativeDirectory, manifestSha256, checkpointFile, checkpointManifestSha256};
    });
  }
  private async exportStopped(id: string, onManifest?: (hash: string) => void) {
    const session = await this.get(id), dir = this.dir(session.owner, id);
    const validateTree = (file: string) => {
      const stat = fs.lstatSync(file); this.localPath(file, stat.isDirectory());
      if (stat.isDirectory()) for (const name of fs.readdirSync(file)) validateTree(path.join(file, name));
    };
    for (const name of ["native", "policy", "images", "transport", "replay.json"]) {
      const file = path.join(dir, name);
      try { validateTree(file); } catch (error) { if (!isRecord(error) || error.code !== "ENOENT") throw error; }
    }
    for (const name of [`${id}.zip`, `${id}.zip.tmp`]) {
      try { this.localPath(path.join(dir, name), false); } catch (error) { if (!isRecord(error) || error.code !== "ENOENT") throw error; }
    }
    try { this.localPath(path.join(dir, "config"), true); } catch (error) { if (!isRecord(error) || error.code !== "ENOENT") throw error; }
    const bundle = path.join(dir, `export-${randomUUID()}`); this.collector(session, true).exportTo(bundle);
    try {
      // Legacy/invalid classification is a derived observation, never a claim
      // that old evidence was captured under today's model policy.
      save(path.join(bundle, "session.json"), session);
      if (fs.existsSync(path.join(dir, "policy"))) await fsp.cp(path.join(dir, "policy"), path.join(bundle, "policy"), {recursive: true});
      if (fs.existsSync(path.join(dir, "replay.json"))) fs.copyFileSync(path.join(dir, "replay.json"), path.join(bundle, "replay.json"));
      await fsp.cp(path.join(dir, "images"), path.join(bundle, "images"), {recursive: true});
      // Diagnostics are private evidence too; they must not disappear from the
      // downloadable bundle when an SDK turn or tool fails.
      const diagnostics = path.join(dir, "transport", "stderr.jsonl");
      if (fs.existsSync(diagnostics)) {
        privateDir(path.join(bundle, "diagnostics"));
        fs.copyFileSync(diagnostics, path.join(bundle, "diagnostics", "stderr.jsonl"));
      }
      fs.writeFileSync(path.join(bundle, "verify.py"), REPLAY_ADAPTER, {mode: 0o600});
      // Saved evidence is sufficient for export, even if the process crashed
      // while the container was running. Never contact Docker or copy mutable
      // container state into this local snapshot; the saved images are authority.
      save(path.join(bundle, "diagnostics", "export.json"), {schema: 1, workspaceCopy: "not-requested", source: "saved-evidence", savedImagesRetained: true});
      fs.writeFileSync(path.join(bundle, "README.txt"), "Private Claude Code evidence. Contains original transcripts, provider-exposed thinking summaries and opaque signatures, SDK/hook events, complete environment images, and project files. Do not publish. Restore: gunzip -c images/<hash>.tar.gz | docker load; run the image digest recorded in session.json with --network=none. replay.json records environment restoration, not deterministic model re-execution. Recorded-tool replay: on an isolated worker with the reviewed omniconv verifier installed, run python3 verify.py <this-session.zip> --out <new-private-report-directory>. The adapter checks native evidence hashes, loads each exact before image, replays all root and child tool calls with networking disabled, and compares project files and modes with the captured after image. Add --check-path /absolute/path to compare additional filesystem scopes. Unsupported calls remain unverified. Reports and raw bundles require a separate masking/delivery review before distribution.\n", {mode: 0o600});
      if (session.authorization?.bindingId && session.contractSha256) {
        const hash = await writeBundleManifest(bundle, {sessionId: id, bindingId: session.authorization.bindingId, contractHash: session.contractSha256, engineVersion: session.claudeVersion}, "claude_checkpoint");
        onManifest?.(hash);
      }
      const zip = path.join(dir, `${id}.zip`); await zipDirectory(bundle, zip); return zip;
    } finally { await fsp.rm(bundle, {recursive: true, force: true}); }
  }
  async shutdown() { this.closed = true; for (const job of this.running.values()) job.stop.abort(); await Promise.all([...this.running.values()].map(job => job.done)); }
}
