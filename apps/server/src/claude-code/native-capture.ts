/** Private, lossless Claude Code evidence. Never send this through the display scrubber.
 * The native files are the authority, including branches omitted by SDK readers.
 * Only transcript paths for this root session are eligible; never copy the config tree.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const CHUNK_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 256 * CHUNK_BYTES;
const MAX_TOTAL_BYTES = 1024 * CHUNK_BYTES;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHILD_FILE = /^agent-[a-zA-Z0-9_-]+\.(jsonl|meta\.json)$/;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export type NativeCaptureOptions = {
  directory: string;
  configDir: string;
  sessionId: string;
  producerVersion: string;
  surface: "cli" | "gui";
  transport: "cli" | "sdk";
  owner: string;
};
type Chunk = { sha256: string; bytes: number };
/** Observation only: these counts never delete, merge or rewrite native records.
 * Human prompt candidates are not billable turns; the runtime's durable ingress
 * journal is the authority for user submissions (a harness can synthesize users).
 */
export type NativeQuality = {
  schema: 1;
  nativeRecords: number;
  recordTypes: Record<string, number>;
  blockTypes: Record<string, number>;
  humanPromptCandidates: number;
  syntheticUserRecords: number;
  childPromptRecords: number;
  compactionRecords: number;
  exposedThinkingBlocks: number;
  opaqueThinkingBlocks: number;
  unknownRecordTypes: string[];
  unknownBlockTypes: string[];
  preservedRevisions: number;
  reviewRequired: boolean;
};
export type NativeFile = {
  path: string;
  generation: number;
  bytes: number;
  sha256: string;
  chunks: Chunk[];
  completeLines: number;
  tailBytes: number;
  invalidLines: number;
  thinkingBlocks: number;
  toolCalls: number;
  toolResults: number;
  pendingTools: string[];
  referencedAgents: string[];
  orphanResults?: string[];
  conflictingToolIds?: string[];
  quality?: NativeQuality;
};
export type NativeCaptureManifest = {
  schema: 1;
  format: "claude-code";
  sessionId: string;
  producerVersion: string;
  surface: "cli" | "gui";
  transport: "cli" | "sdk";
  owner: string;
  source: string;
  revision: number;
  status: "capturing" | "complete" | "incomplete";
  replay: "unverified";
  confidential: true;
  redacted: false;
  files: NativeFile[];
  history: NativeFile[];
  issues: string[];
  streams: { cli: number; sdk: number; hooks: number };
  qc?: NativeQuality;
};
export type NativeCaptureAction =
  | { type: "scan" }
  | { type: "stream"; channel: "cli" | "sdk" | "hooks"; offset: number; bytes: Uint8Array }
  | { type: "finish"; processStopped: boolean; successfulResult: boolean; expectedAgents?: string[] };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function mkdir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== path.resolve(dir)) throw new Error("Capture directory must not traverse symlinks");
  fs.chmodSync(dir, 0o700);
}
function syncDir(dir: string): void {
  // Directory fsync is unsupported on Windows. File fsync is still required.
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function atomic(file: string, bytes: Uint8Array | string): void {
  mkdir(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); syncDir(path.dirname(file)); }
  finally { fs.rmSync(temp, { force: true }); }
}
function readRegular(file: string): Buffer {
  // Check ancestors as well as O_NOFOLLOW on the leaf; config is a session-owned volume.
  if (fs.realpathSync(file) !== path.resolve(file)) throw new Error("Native transcript must not traverse symlinks");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error("Invalid or oversized native transcript");
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Native transcript changed while capturing; retry scan");
    return bytes;
  } finally { fs.closeSync(fd); }
}

function emptyQuality(): NativeQuality {
  return { schema: 1, nativeRecords: 0, recordTypes: {}, blockTypes: {}, humanPromptCandidates: 0, syntheticUserRecords: 0, childPromptRecords: 0, compactionRecords: 0, exposedThinkingBlocks: 0, opaqueThinkingBlocks: 0, unknownRecordTypes: [], unknownBlockTypes: [], preservedRevisions: 0, reviewRequired: false };
}
const RECORD_TYPES = new Set(["user", "assistant", "system", "attachment", "progress", "queue-operation", "last-prompt", "atis-latch", "cost-state", "mode", "summary", "file-history-snapshot", "custom-title", "agent-name", "agent-color", "tag", "pr-link", "api-request", "api-request-blob", "api-request-shape"]);
const BLOCK_TYPES = new Set(["text", "image", "document", "tool_use", "tool_result", "thinking", "redacted_thinking"]);
function increment(counts: Record<string, number>, key: string): void { counts[key] = (counts[key] ?? 0) + 1; }
function inspect(bytes: Buffer, jsonl: boolean, native = false): Pick<NativeFile, "completeLines" | "tailBytes" | "invalidLines" | "thinkingBlocks" | "toolCalls" | "toolResults" | "pendingTools" | "referencedAgents" | "orphanResults" | "conflictingToolIds" | "quality"> {
  const quality = emptyQuality();
  const result = { completeLines: 0, tailBytes: 0, invalidLines: 0, thinkingBlocks: 0, toolCalls: 0, toolResults: 0, pendingTools: [] as string[], referencedAgents: [] as string[], orphanResults: [] as string[], conflictingToolIds: [] as string[], ...(native ? { quality } : {}) };
  if (!jsonl) {
    try { JSON.parse(bytes.toString("utf8")); } catch { result.invalidLines = 1; }
    return result;
  }
  const end = bytes.lastIndexOf(10) + 1;
  result.tailBytes = bytes.length - end;
  const calls = new Set<string>(), results = new Set<string>(), thinking = new Set<string>();
  const toolIdentities = new Map<string, string>(), promptIds = new Set<string>();
  const agents = new Set<string>();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); }
  catch { result.invalidLines = 1; return result; }
  // Inspect every record, not just the selected parentUuid chain. Keep bytes unchanged.
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    result.completeLines++;
    let record: unknown;
    try { record = JSON.parse(line); } catch { result.invalidLines++; continue; }
    if (!object(record)) { result.invalidLines++; continue; }
    if (native) {
      const type = typeof record.type === "string" ? record.type : "<missing>";
      quality.nativeRecords++; increment(quality.recordTypes, type);
      if (!RECORD_TYPES.has(type) && !quality.unknownRecordTypes.includes(type)) quality.unknownRecordTypes.push(type);
      if (type === "summary" || record.isCompactSummary === true || (type === "system" && typeof record.subtype === "string" && /compact/i.test(record.subtype))) quality.compactionRecords++;
    }
    const toolResult = record.toolUseResult ?? record.tool_use_result;
    if (object(toolResult) && typeof toolResult.agentId === "string") agents.add(toolResult.agentId);
    if (record.type === "system" && record.subtype === "task_started" && typeof record.agent_id === "string") agents.add(record.agent_id);
    // Native request-cache blobs repeat older messages. Preserve every byte,
    // but do not count cached context as a new execution or reasoning block.
    if (record.type !== "assistant" && record.type !== "user") continue;
    if (!object(record.message)) { result.invalidLines++; continue; }
    const content = record.message.content;
    const blocks = Array.isArray(content) ? content.filter(object) : [];
    if (record.type === "user" && native && !blocks.some((block) => block.type === "tool_result")) {
      const text = typeof content === "string" ? content : blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
      const synthetic = record.isMeta === true || record.isCompactSummary === true || /^\s*<(task-notification|local-command|command-name|system-reminder)[\s>]/.test(text);
      if (synthetic) quality.syntheticUserRecords++;
      else if (record.isSidechain === true || typeof record.agentId === "string") quality.childPromptRecords++;
      else if (text.trim()) {
        const id = typeof record.uuid === "string" ? record.uuid : `line:${result.completeLines}`;
        if (!promptIds.has(id)) { promptIds.add(id); quality.humanPromptCandidates++; }
      }
    }
    if (!Array.isArray(content)) continue;
    for (const [index, block] of content.entries()) {
      if (!object(block)) { result.invalidLines++; continue; }
      if (native) {
        const type = typeof block.type === "string" ? block.type : "<missing>";
        increment(quality.blockTypes, type);
        if (!BLOCK_TYPES.has(type) && !quality.unknownBlockTypes.includes(type)) quality.unknownBlockTypes.push(type);
      }
      if (block.type === "tool_use" && typeof block.id === "string") calls.add(block.id);
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") results.add(block.tool_use_id);
      if (block.type === "tool_use" || block.type === "tool_result") {
        const id = block.type === "tool_use" ? block.id : block.tool_use_id;
        if (typeof id !== "string" || !id) result.invalidLines++;
        else {
          const identity = `${block.type}:${id}`, fingerprint = JSON.stringify(block);
          if (toolIdentities.has(identity) && toolIdentities.get(identity) !== fingerprint) result.conflictingToolIds.push(id);
          toolIdentities.set(identity, fingerprint);
        }
      }
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        const identity = `${String(record.uuid ?? result.completeLines)}:${index}`;
        if (!thinking.has(identity)) {
          thinking.add(identity);
          if (native && block.type === "thinking") quality.exposedThinkingBlocks++;
          if (native && block.type === "redacted_thinking") quality.opaqueThinkingBlocks++;
        }
      }
    }
  }
  result.thinkingBlocks = thinking.size; result.toolCalls = calls.size; result.toolResults = results.size;
  result.pendingTools = [...calls].filter((id) => !results.has(id));
  result.orphanResults = [...results].filter((id) => !calls.has(id));
  result.referencedAgents = [...agents];
  quality.reviewRequired = quality.unknownRecordTypes.length > 0 || quality.unknownBlockTypes.length > 0;
  return result;
}

/** One writer per session. The runner must await acknowledgements before progressing.
 * Every acknowledgement follows file fsync and atomic manifest replacement. Recovery
 * reuses persisted chunks; a missing/corrupt chunk is an error, never an empty trace.
 */
export class NativeCapture {
  private manifest: NativeCaptureManifest;
  private readonly scanned = new Map<string, string>();
  constructor(private readonly options: NativeCaptureOptions) {
    if (!SESSION_ID.test(options.sessionId) || !options.owner || !options.producerVersion) throw new Error("Native capture identity is required");
    mkdir(options.directory);
    const file = path.join(options.directory, "manifest.json");
    if (fs.existsSync(file)) {
      // State is private to this writer, but validate identity before reading any evidence.
      const saved: NativeCaptureManifest = JSON.parse(readRegular(file).toString("utf8"));
      if (saved.schema !== 1 || saved.format !== "claude-code" || saved.sessionId !== options.sessionId || saved.owner !== options.owner || saved.source !== sha(path.resolve(options.configDir)) || saved.producerVersion !== options.producerVersion || saved.surface !== options.surface || saved.transport !== options.transport) throw new Error("Native capture identity mismatch");
      this.manifest = saved;
      this.verify();
    } else {
      this.manifest = { schema: 1, format: "claude-code", sessionId: options.sessionId, producerVersion: options.producerVersion, surface: options.surface, transport: options.transport, owner: options.owner, source: sha(path.resolve(options.configDir)), revision: 0, status: "capturing", replay: "unverified", confidential: true, redacted: false, files: [], history: [], issues: [], streams: { cli: 0, sdk: 0, hooks: 0 } };
      this.persist();
    }
  }

  private persist(): NativeCaptureManifest {
    this.manifest.revision++;
    atomic(path.join(this.options.directory, "manifest.json"), JSON.stringify(this.manifest, null, 2) + "\n");
    return structuredClone(this.manifest);
  }

  private content(file: NativeFile): Buffer {
    const chunks = file.chunks.map((chunk) => {
      if (!/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new Error("Invalid native chunk reference");
      const bytes = readRegular(path.join(this.options.directory, "chunks", chunk.sha256));
      if (bytes.length !== chunk.bytes || sha(bytes) !== chunk.sha256) throw new Error("Native chunk integrity failure");
      return bytes;
    });
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error("Native file integrity failure");
    return bytes;
  }

  verify(): NativeCaptureManifest {
    for (const file of [...this.manifest.files, ...this.manifest.history]) this.content(file);
    return structuredClone(this.manifest);
  }

  private capture(name: string, bytes: Buffer): void {
    const previous = this.manifest.files.find((file) => file.path === name);
    const digest = sha(bytes);
    if (previous?.sha256 === digest) return;
    let generation = previous?.generation ?? 0;
    if (previous) {
      if (bytes.length < previous.bytes || sha(bytes.subarray(0, previous.bytes)) !== previous.sha256) {
        this.manifest.history.push(previous);
        generation++;
      }
    }
    const chunks: Chunk[] = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const part = bytes.subarray(offset, offset + CHUNK_BYTES), digest = sha(part);
      const target = path.join(this.options.directory, "chunks", digest);
      if (!fs.existsSync(target)) atomic(target, part);
      else if (sha(readRegular(target)) !== digest) throw new Error("Native chunk integrity failure");
      chunks.push({ sha256: digest, bytes: part.length });
    }
    this.manifest.files = this.manifest.files.filter((file) => file.path !== name);
    this.manifest.files.push({ path: name, generation, bytes: bytes.length, sha256: digest, chunks, ...inspect(bytes, name.endsWith(".jsonl"), name.startsWith("claude/projects/") && name.endsWith(".jsonl")) });
  }

  scan(): NativeCaptureManifest {
    this.manifest.status = "capturing";
    this.manifest.issues = [];
    const projects = path.join(this.options.configDir, "projects");
    const found = new Set<string>();
    let total = 0;
    const take = (file: string, name: string) => {
      try {
        const stat = fs.lstatSync(file, { bigint: true });
        if (!stat.isFile()) throw new Error("Native transcript must be a regular file without symlinks");
        total += Number(stat.size);
        if (total > MAX_TOTAL_BYTES) throw new Error("Native session exceeds capture budget");
        const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        if (this.scanned.get(name) !== fingerprint) {
          this.capture(name, readRegular(file));
          this.scanned.set(name, fingerprint);
        }
        found.add(name);
      } catch (error) {
        // Keep every already captured byte and record the gap before failing.
        this.manifest.status = "incomplete";
        this.manifest.issues.push(`source_capture_failed:${name}`);
        this.persist();
        throw error;
      }
    };
    if (fs.existsSync(projects)) {
      if (fs.realpathSync(projects) !== path.resolve(projects)) throw new Error("Native projects directory must not traverse symlinks");
      for (const project of fs.readdirSync(projects, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        const base = path.join(projects, project.name), prefix = `claude/projects/${project.name}`;
        const root = path.join(base, `${this.options.sessionId}.jsonl`);
        if (fs.existsSync(root)) take(root, `${prefix}/${this.options.sessionId}.jsonl`);
        const children = path.join(base, this.options.sessionId, "subagents");
        if (!fs.existsSync(children)) continue;
        if (fs.realpathSync(children) !== children) throw new Error("Native subagents directory must not traverse symlinks");
        for (const child of fs.readdirSync(children, { withFileTypes: true })) {
          if (!CHILD_FILE.test(child.name)) continue;
          take(path.join(children, child.name), `${prefix}/${this.options.sessionId}/subagents/${child.name}`);
        }
      }
    }
    for (const channel of ["cli", "sdk", "hooks"] as const) {
      const file = path.join(this.options.directory, "events", `${channel}.jsonl`);
      if (fs.existsSync(file)) {
        take(file, `events/${channel}.jsonl`);
        this.manifest.streams[channel] = fs.statSync(file).size;
      }
    }
    this.manifest.issues = this.manifest.files.filter((file) => !found.has(file.path)).map((file) => `source_missing:${file.path}`);
    this.manifest.files.sort((a, b) => a.path.localeCompare(b.path));
    const qc = emptyQuality();
    for (const file of this.manifest.files) {
      if (!file.path.startsWith("claude/projects/") || !file.path.endsWith(".jsonl")) continue;
      // Older manifests are upgraded from original bytes, never assumed empty.
      if (!file.quality) Object.assign(file, inspect(this.content(file), true, true));
      const quality = file.quality;
      if (!quality) continue;
      for (const key of ["nativeRecords", "syntheticUserRecords", "childPromptRecords", "compactionRecords", "exposedThinkingBlocks", "opaqueThinkingBlocks"] as const) qc[key] += quality[key];
      if (file.path.includes("/subagents/")) qc.childPromptRecords += quality.humanPromptCandidates;
      else qc.humanPromptCandidates += quality.humanPromptCandidates;
      for (const key of ["recordTypes", "blockTypes"] as const) for (const [type, count] of Object.entries(quality[key])) qc[key][type] = (qc[key][type] ?? 0) + count;
      for (const key of ["unknownRecordTypes", "unknownBlockTypes"] as const) qc[key] = [...new Set([...qc[key], ...quality[key]])].sort();
    }
    qc.preservedRevisions = this.manifest.history.length;
    qc.reviewRequired = qc.unknownRecordTypes.length > 0 || qc.unknownBlockTypes.length > 0 || qc.preservedRevisions > 0;
    this.manifest.qc = qc;
    const manifest = this.persist();
    // A growing final chunk supersedes its previous prefix. Prune only after
    // the new manifest is durable; retain every referenced rewrite generation.
    const referenced = new Set([...this.manifest.files, ...this.manifest.history].flatMap((file) => file.chunks.map((chunk) => chunk.sha256)));
    const chunks = path.join(this.options.directory, "chunks");
    if (fs.existsSync(chunks)) for (const name of fs.readdirSync(chunks)) {
      if (/^[a-f0-9]{64}$/.test(name) && !referenced.has(name)) fs.unlinkSync(path.join(chunks, name));
    }
    return manifest;
  }

  recordStream(channel: "cli" | "sdk" | "hooks", bytes: Uint8Array, offset: number): NativeCaptureManifest {
    if (!["cli", "sdk", "hooks"].includes(channel) || bytes.length > 8 * CHUNK_BYTES) throw new Error("Invalid native stream chunk");
    const file = path.join(this.options.directory, "events", `${channel}.jsonl`);
    mkdir(path.dirname(file));
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("Native event stream must not be a symlink");
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const existing = fs.fstatSync(fd);
      if (!existing.isFile() || !Number.isSafeInteger(offset) || offset < 0 || offset > existing.size) throw new Error("Native stream offset gap");
      const overlap = Math.min(bytes.length, existing.size - offset);
      const prefix = Buffer.alloc(overlap);
      if (overlap && (fs.readSync(fd, prefix, 0, overlap, offset) !== overlap || !prefix.equals(bytes.subarray(0, overlap)))) throw new Error("Conflicting native stream retry");
      const remaining = bytes.subarray(overlap);
      if (existing.size + remaining.length > MAX_FILE_BYTES) throw new Error("Native event stream exceeds capture budget");
      fs.writeFileSync(fd, remaining); fs.fsyncSync(fd);
      this.manifest.streams[channel] = existing.size + remaining.length;
    } finally { fs.closeSync(fd); }
    syncDir(path.dirname(file));
    // The stream itself is the durable journal; chunk it at scan/turn barriers.
    this.manifest.status = "capturing";
    return this.persist();
  }

  finish(input: Extract<NativeCaptureAction, { type: "finish" }>): NativeCaptureManifest {
    this.scan();
    const issues = this.manifest.issues;
    if (!input.processStopped) issues.push("producer_still_running");
    if (!input.successfulResult) issues.push("successful_result_missing");
    const roots = this.manifest.files.filter((file) => file.path.endsWith(`/${this.options.sessionId}.jsonl`));
    if (roots.length !== 1 || roots[0].completeLines === 0) issues.push("root_transcript_missing_or_ambiguous");
    for (const file of this.manifest.files) {
      if (file.tailBytes) issues.push(`partial_line:${file.path}`);
      if (file.invalidLines) issues.push(`invalid_json:${file.path}`);
      if (file.pendingTools.length) issues.push(`pending_tools:${file.path}`);
      if (file.orphanResults?.length && file.path.startsWith("claude/")) issues.push(`orphan_results:${file.path}`);
      if (file.conflictingToolIds?.length) issues.push(`conflicting_tool_identity:${file.path}`);
    }
    const expectedAgents = new Set([...(input.expectedAgents ?? []), ...this.manifest.files.flatMap((file) => file.referencedAgents)]);
    for (const agent of expectedAgents) {
      if (!/^[a-zA-Z0-9_-]+$/.test(agent) || !this.manifest.files.some((file) => file.path.endsWith(`/subagents/agent-${agent}.jsonl`) && file.completeLines > 0)) issues.push(`child_transcript_missing:${agent}`);
    }
    this.manifest.status = issues.length ? "incomplete" : "complete";
    this.verify();
    return this.persist();
  }

  /** Private byte-exact export only. A public export needs a separately audited
   * redacted derivative and must not claim these hashes or resumability.
   */
  exportTo(destination: string): NativeCaptureManifest {
    if (fs.existsSync(destination)) throw new Error("Native export destination already exists");
    this.verify();
    mkdir(destination);
    for (const file of [...this.manifest.files, ...this.manifest.history]) {
      if (!/^(claude\/projects\/|events\/)/.test(file.path) || file.path.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\"))) throw new Error("Invalid native export path");
      const historic = this.manifest.history.includes(file);
      const target = historic ? `history/${file.generation}/${file.path}` : file.path;
      atomic(path.join(destination, target), this.content(file));
    }
    atomic(path.join(destination, "native-manifest.json"), JSON.stringify(this.manifest, null, 2) + "\n");
    return structuredClone(this.manifest);
  }
}
