/**
 * The engine reads behind collection: the turn observer that waits for a
 * captured session to settle and hands its messages, model, subagents and
 * turn milestone to the session uploader and the project archive, and the reads a
 * project archive session start makes. They run beside the session uploader (on
 * the capture worker when there is one, see capture-host.ts), so parsing a
 * long transcript never holds the server's main event loop. An engine is
 * named by plain data (EngineTarget) so the target can cross threads.
 */
import { loopbackFetch } from "./server-fetch.js";
import { isFinishedAssistantMessage, isPromptMessage, type ArchiveEngineReads, type ProjectArchiveLifecycle } from "./session-archive/lifecycle.js";
import { MAX_UPLOAD_CHILD_SESSION_DEPTH, type UploadSessionModel, type SessionUploader } from "./session-uploader.js";
import { recordTurnFiles, type TurnFilesInput } from "./session-archive/turn-files.js";
import { watchToolCallEnds } from "./session-archive/files-used.js";
import { watchToolStarts } from "./session-archive/tool-start.js";
import { watchToolEvents } from "./context/tool-events.js";
import type { ContextCapture } from "./context/index.js";

/** The engine a captured request went to: base URL, request headers (the engine's auth), query and API generation. */
export type EngineTarget = {
  baseUrl: string;
  headers: Array<[string, string]>;
  search: string;
  /** The v2 daemon reports activity and context through its own routes, wrapped in `data`. */
  engine: "v1" | "v2";
};

/**
 * The turn being followed: whether its turn_completed snapshot was taken
 * already, and when the next prompt of the session was dispatched while it
 * had not settled (null until then). Such a turn ends at that prompt: its
 * snapshot is taken right as the prompt goes out, and its messages stop
 * before the prompt's own.
 */
type FollowedTurn = { snapshotTaken: boolean; cutAt: number | null; settled?: boolean };

/**
 * A session being observed: the engine its latest captured request went to
 * (an engine that restarted may answer on another port), how many requests
 * asked for it while it was, the turn being followed, and the observation itself.
 */
type ObservedSession = {
  target: EngineTarget;
  requests: number;
  turn: FollowedTurn | null;
  done: Promise<void>;
  /** Settles the turn being followed now, as the engine has it (an app quit); nothing when none is open. */
  settleNow?: () => Promise<void>;
};

/** The engine that took over from a closed one: its base URL and its Authorization header. */
export type EngineReplacement = { baseUrl: string; authorization: string | null };

/** How many replaced engines are remembered (a request's target may still name one of them). */
const MAX_REPLACED_ENGINES = 16;

/**
 * Turn observers of one server: the sessions being observed, their last seen
 * message, the engines that took over from closed ones (by the closed one's
 * origin), and the stop signal.
 */
export type SessionObservers = {
  sessions: Map<string, ObservedSession>;
  lastMessageIds: Map<string, string>;
  replacedEngines: Map<string, EngineReplacement>;
  controller: AbortController;
};

export function createSessionObservers(): SessionObservers {
  return { sessions: new Map(), lastMessageIds: new Map(), replacedEngines: new Map(), controller: new AbortController() };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function replaceTarget(target: EngineTarget, replacement: EngineReplacement): EngineTarget {
  const headers = target.headers.filter(([name]) => name.toLowerCase() !== "authorization");
  if (replacement.authorization) headers.push(["authorization", replacement.authorization]);
  return { ...target, baseUrl: replacement.baseUrl, headers };
}

/** `target`, moved onto the engine that took over when the one it names was closed (following a chain of takeovers). */
export function currentEngineTarget(observers: SessionObservers, target: EngineTarget): EngineTarget {
  let current = target;
  for (let hops = 0; hops < MAX_REPLACED_ENGINES; hops += 1) {
    const replacement = observers.replacedEngines.get(originOf(current.baseUrl));
    if (!replacement || originOf(replacement.baseUrl) === originOf(current.baseUrl)) return current;
    current = replaceTarget(current, replacement);
  }
  return current;
}

/**
 * An engine was closed and another took over its sessions (an engine pool
 * rollover retiring a drained engine, or a dead engine replaced): every
 * observation reading the closed engine reads the new one from now on. The
 * sessions live in the engines' shared database, so a turn that ran on the
 * closed engine settles, with its messages, from the one that took over.
 */
export function engineReplaced(observers: SessionObservers, closedBaseUrl: string, replacement: EngineReplacement): void {
  const closed = originOf(closedBaseUrl);
  if (closed === originOf(replacement.baseUrl)) return;
  observers.replacedEngines.delete(closed);
  observers.replacedEngines.set(closed, replacement);
  while (observers.replacedEngines.size > MAX_REPLACED_ENGINES) {
    const oldest = observers.replacedEngines.keys().next().value;
    if (oldest === undefined) break;
    observers.replacedEngines.delete(oldest);
  }
  for (const session of observers.sessions.values()) session.target = currentEngineTarget(observers, session.target);
}

/**
 * A prompt of a followed session was dispatched (at `at`, the dispatching
 * thread's clock) while the turn before it has not settled: a queued prompt
 * sent right as that turn went idle, or a prompt sent into a running turn.
 * That turn ends here. Its turn_completed snapshot is taken now, ahead of
 * the new prompt's own snapshot, so both turns keep their turn.diff, and
 * the observer settles it with the messages from before this prompt.
 */
export function promptDispatched(observers: SessionObservers, sessionUploader: Pick<ObservedUploader, "captureSnapshot">, sessionId: string, at: number): void {
  const turn = observers.sessions.get(sessionId)?.turn;
  if (!turn || turn.cutAt !== null) return;
  turn.cutAt = at;
  if (turn.snapshotTaken) return;
  turn.snapshotTaken = true;
  sessionUploader.captureSnapshot(sessionId, "turn_completed");
}

/** What the observer asks of the session uploader. */
export type ObservedUploader = Pick<
  SessionUploader,
  | "enabled"
  | "sessionCheckpoint"
  | "setSessionCheckpoint"
  | "recordTrace"
  | "recordSessionModel"
  | "childCheckpoints"
  | "childSessionIds"
  | "recordChildSession"
  | "noteChildSessionIds"
  | "captureSnapshot"
  | "flushTrace"
>;

/** An engine target from a proxied request's headers, without the body headers of that request. */
export function engineTarget(baseUrl: string, headers: Headers, search: string, engine: "v1" | "v2" = "v1"): EngineTarget {
  const copy = new Headers(headers);
  copy.delete("content-length");
  copy.delete("content-type");
  return { baseUrl, headers: [...copy], search, engine };
}

export function buildOpencodeProxyUrl(baseUrl: string, path: string, search: string) {
  const target = new URL(baseUrl);
  const trimmedPath = path.replace(/^\/opencode/, "");
  target.pathname = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  target.search = search;
  return target.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalTraceString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The model the turn ran on, read from the turn's first assistant message
 * (providerID / modelID / mode or agent). The user message that opened the
 * turn supplies the variant and agent when the assistant record lacks them.
 */
function turnModelFromMessages(messages: unknown): UploadSessionModel | null {
  if (!Array.isArray(messages)) return null;
  let userVariant: string | null = null;
  let userAgent: string | null = null;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const info = isRecord(message.info) ? message.info : message;
    const model = isRecord(info.model) ? info.model : {};
    // v2 context messages carry the role as `type` and the model as a ModelRef.
    const role = info.role ?? info.type;
    if (role === "user") {
      userVariant = optionalTraceString(info.variant) ?? optionalTraceString(model.variant) ?? userVariant;
      userAgent = optionalTraceString(info.agent) ?? userAgent;
      continue;
    }
    if (role !== "assistant") continue;
    const providerId = optionalTraceString(info.providerID) ?? optionalTraceString(model.providerID);
    const modelId = optionalTraceString(info.modelID) ?? optionalTraceString(model.modelID) ?? optionalTraceString(model.id);
    if (!providerId && !modelId) continue;
    // The 2.x engine's own model record says "default" when no variant was picked (1.x wrote none).
    const nativeVariant = optionalTraceString(model.variant);
    return {
      provider_id: providerId,
      model_id: modelId,
      variant: optionalTraceString(info.variant) ?? (nativeVariant === "default" ? null : nativeVariant) ?? userVariant,
      agent: optionalTraceString(info.agent) ?? optionalTraceString(info.mode) ?? userAgent,
    };
  }
  return null;
}

/** Messages asked of the engine per page, as many as opencode's own message stream reads at a time. */
const MESSAGE_PAGE_SIZE = 50;
/** One engine response (a page of messages, a session record, a status map) is parsed only up to this size. */
const MAX_ENGINE_READ_BYTES = 8 * 1024 * 1024;
/** The messages one trace flush carries at most (a trace document holds 16 MiB in all). */
const MAX_TURN_MESSAGE_BYTES = 8 * 1024 * 1024;
/**
 * The messages after the checkpoint kept whole when a settled turn is read,
 * the newest first: a turn longer than one flush's share, or one that follows
 * turns the observer never saw settle, goes out over several flushes.
 */
const MAX_BACKLOG_MESSAGE_BYTES = 4 * MAX_TURN_MESSAGE_BYTES;
/** The longest an observer follows one turn: a safety bound far past any real turn. */
const MAX_OBSERVED_TURN_MS = 24 * 60 * 60_000;
/** Status reads are a second apart for a turn's first two minutes, then a second more for every minute it has run, up to this. */
const MAX_STATUS_POLL_MS = 10_000;
/** Failed status reads back off, doubling from a second, up to this. */
const MAX_STATUS_RETRY_MS = 30_000;
/** An engine that has not answered for this long is recorded in the trace; the observer keeps waiting for it. */
const ENGINE_UNAVAILABLE_TRACE_MS = 60_000;
/** A session never seen busy that stays idle this long settles without a finished answer (its prompt never ran). */
const NEVER_BUSY_SETTLE_MS = 10 * 60_000;
/** A turn ended by the next prompt waits at most this long for that prompt's message to show up in the engine before it settles as it is. */
const CUT_PROMPT_WAIT_MS = 15_000;
/** While a turn runs, the subagent sessions below it are listed (ids only) about this often. */
const CHILD_IDS_INTERVAL_MS = 60_000;
/** A settled turn whose messages the engine did not answer for (a timeout, a dropped connection) is read again after these waits. */
const HISTORY_RETRY_DELAYS_MS = [2_000, 5_000];

/** The observer's clock and timeouts; tests pass their own so that hours of a turn pass without real waiting. */
export type ObserverTiming = {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** One status read. */
  statusTimeoutMs: number;
  /** One other engine read (a page of messages, a children list). */
  readTimeoutMs: number;
  /** How long one turn is followed at most. */
  maxTurnMs: number;
};

type EngineFetch = (path: string, query?: Record<string, string>) => Promise<Response>;

/** Requests to the engine a captured request went to (the current `target()`), with its headers and query plus `query`, each under a fresh `signal()`. */
function engineFetch(target: () => EngineTarget, signal: () => AbortSignal): EngineFetch {
  return (path, query = {}) => {
    const { baseUrl, headers, search } = target();
    const url = new URL(buildOpencodeProxyUrl(baseUrl, path, search));
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return loopbackFetch(url.toString(), { headers: new Headers(headers), signal: signal() });
  };
}

/** An engine response over its read cap, with the bytes read before it was cut off. */
class OversizedEngineResponse extends Error {
  readonly chunks: Uint8Array[];

  constructor(chunks: Uint8Array[]) {
    super("trace response exceeded local limit");
    this.chunks = chunks;
  }
}

/** The engine answered a read with an error status. */
class EngineReadError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`the engine answered ${status}`);
    this.status = status;
  }
}

/** Null for an error status, as a missing record reads; anything else is thrown on. */
function nullOnErrorStatus(error: unknown): null {
  if (error instanceof EngineReadError) return null;
  throw error;
}

/**
 * Walks the task-tool subagent tree below a settled root session: one
 * "session.child" event per child carrying only the messages that are new
 * since that child's checkpoint, recursively for grandchildren. `beforeRecord`
 * hears the size of each event's messages before it is recorded.
 */
async function captureChildSessions(input: {
  sessionUploader: ObservedUploader;
  rootSessionId: string;
  parentSessionId: string;
  depth: number;
  fetchEngine: EngineFetch;
  checkpoints: Record<string, string>;
  known: Set<string>;
  visited: Set<string>;
  beforeRecord: (bytes: number) => void;
}): Promise<void> {
  if (input.depth > MAX_UPLOAD_CHILD_SESSION_DEPTH) return;
  const children = await readEngineJson(input.fetchEngine, `/session/${encodeURIComponent(input.parentSessionId)}/children`, 1024 * 1024)
    .catch(nullOnErrorStatus);
  if (!Array.isArray(children)) return;
  for (const child of children.slice(0, 200)) {
    const childId = isRecord(child) && typeof child.id === "string" && child.id ? child.id : null;
    if (!childId || childId === input.rootSessionId || input.visited.has(childId)) continue;
    input.visited.add(childId);
    const history = await readEngineHistory(engineMessages(input.fetchEngine, `/session/${encodeURIComponent(childId)}/message`, true), input.checkpoints[childId])
      .catch(nullOnErrorStatus);
    const newMessages = history?.delta ?? [];
    if (history && history.omitted > 0) {
      input.sessionUploader.recordTrace(input.rootSessionId, "session.messages_omitted", { child_session_id: childId, count: history.omitted });
    }
    if (newMessages.length > 0 || !input.known.has(childId)) {
      input.beforeRecord(history ? sum(history.sizes) : 0);
      input.sessionUploader.recordChildSession(input.rootSessionId, {
        childSessionId: childId,
        parentSessionId: input.parentSessionId,
        depth: input.depth,
        title: isRecord(child) ? optionalTraceString(child.title) : null,
        agent: turnModelFromMessages(history?.outline ?? [])?.agent ?? null,
        messages: newMessages,
        lastMessageId: traceMessageId(history?.outline.at(-1)),
      });
    }
    await captureChildSessions({ ...input, parentSessionId: childId, depth: input.depth + 1 });
  }
}

/**
 * The ids of the subagent sessions below `rootSessionId`, children first,
 * at most MAX_UPLOAD_CHILD_SESSION_DEPTH layers down. A layer the engine
 * cannot list (an error status) is left out.
 */
async function childSessionIdsBelow(fetchEngine: EngineFetch, rootSessionId: string): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set([rootSessionId]);
  let layer = [rootSessionId];
  for (let depth = 1; depth <= MAX_UPLOAD_CHILD_SESSION_DEPTH && layer.length > 0; depth += 1) {
    const next: string[] = [];
    for (const parent of layer) {
      const children = await readEngineJson(fetchEngine, `/session/${encodeURIComponent(parent)}/children`, 1024 * 1024)
        .catch(nullOnErrorStatus);
      if (!Array.isArray(children)) continue;
      for (const child of children.slice(0, 200)) {
        const id = isRecord(child) && typeof child.id === "string" && child.id ? child.id : null;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        next.push(id);
      }
    }
    layer = next;
  }
  return ids;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

function uploadDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolvePromise, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

async function readObservedResponse(response: Response, maxBytes = MAX_ENGINE_READ_BYTES): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new OversizedEngineResponse(chunks);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** One engine read under the cap; an error status throws EngineReadError. */
async function readEngineJson(fetchEngine: EngineFetch, path: string, maxBytes?: number): Promise<unknown> {
  const response = await fetchEngine(path);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new EngineReadError(response.status);
  }
  return readObservedResponse(response, maxBytes);
}

/**
 * The info of a message too large to read whole, from the start of its
 * one-message page (`[{"info":{...},"parts":[...]}]`): its id, role and
 * whether it ended are all there. Null when the info does not end within
 * the bytes read.
 */
function leadingMessageInfo(chunks: Uint8Array[]): Record<string, unknown> | null {
  const text = Buffer.concat(chunks).toString("utf8");
  const start = /^\s*\[\s*\{\s*"info"\s*:\s*(?=\{)/.exec(text)?.[0].length;
  if (start === undefined) return null;
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === "\"") inString = false;
    } else if (char === "\"") {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if ((char === "}" || char === "]") && --depth === 0) {
      try {
        const info: unknown = JSON.parse(text.slice(start, index + 1));
        return isRecord(info) ? info : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** A message read from the engine; `whole` is false for one known only by its info (too large to read). */
type EngineMessage = { message: unknown; whole: boolean };

/**
 * A session's messages, newest first. A v1 engine is read a page at a
 * time, each page parsed under the read cap: after a page over it, the
 * newest message is asked for alone and later pages are at most half that
 * size, and a message over the cap on its own is known by the info that
 * leads it. The v2 daemon has no pages; its list is read whole under the
 * cap. Throws when the engine cannot be read.
 */
async function* engineMessages(fetchEngine: EngineFetch, path: string, paged: boolean): AsyncGenerator<EngineMessage> {
  if (!paged) {
    const payload = await readEngineJson(fetchEngine, path);
    const list = isRecord(payload) && "data" in payload ? payload.data : payload;
    if (!Array.isArray(list)) throw new Error("the engine messages could not be read");
    for (const message of list.reverse()) yield { message, whole: true };
    return;
  }
  let ceiling = MESSAGE_PAGE_SIZE;
  let limit = MESSAGE_PAGE_SIZE;
  let before: string | null = null;
  while (true) {
    const response = await fetchEngine(path, { limit: String(limit), ...(before ? { before } : {}) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new EngineReadError(response.status);
    }
    const cursor = response.headers.get("x-next-cursor");
    let page: EngineMessage[];
    try {
      const items = await readObservedResponse(response);
      if (!Array.isArray(items)) throw new Error("the engine messages could not be read");
      page = items.map((message) => ({ message, whole: true }));
    } catch (error) {
      if (!(error instanceof OversizedEngineResponse)) throw error;
      if (limit > 1) {
        ceiling = Math.max(1, limit >> 1);
        limit = 1;
        continue;
      }
      page = [{ message: { info: leadingMessageInfo(error.chunks) ?? {}, parts: [] }, whole: false }];
    }
    for (const entry of page.reverse()) yield entry;
    if (!cursor || cursor === before) return;
    before = cursor;
    limit = Math.min(ceiling, limit * 2);
  }
}

/** What of a user message's part turn counting reads: its type, and whether it is synthetic (never its text). */
const OUTLINED_USER_PARTS = new Set(["text", "file", "agent", "subtask", "compaction"]);

/**
 * What turn counting, the model and the checkpoint read of a message: its
 * info, less a user message's diff summary (whole-file patches), its finish
 * parts and, for a user message, the type of each content part and whether
 * it is synthetic (a compaction's request or a synthetic notice is no
 * prompt, see isPromptMessage). Other shapes (v2 context entries) are kept
 * as they are.
 */
export function messageOutline(message: unknown): unknown {
  if (!isRecord(message) || !isRecord(message.info)) return message;
  const { summary, ...info } = message.info;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const user = message.info.role === "user";
  return {
    info: isRecord(summary) ? info : message.info,
    parts: parts.flatMap((part) => {
      if (!isRecord(part)) return [];
      const type = String(part.type);
      if (["step-finish", "finish", "error"].includes(type)) return [part];
      if (user && OUTLINED_USER_PARTS.has(type)) return [part.synthetic === true ? { type, synthetic: true } : { type }];
      return [];
    }),
  };
}

export type TurnOutcome = "completed" | "stopped" | "error" | "no_reply" | "incomplete";

/**
 * How the session's latest turn ended, from its messages in outline: its
 * last assistant message ended normally ("completed"), was stopped (Esc,
 * the engine's MessageAbortedError: "stopped") or failed ("error"), had not
 * ended ("incomplete"), or the prompt got no answer at all ("no_reply").
 * Null without a prompt.
 */
export function turnOutcome(outline: readonly unknown[]): TurnOutcome | null {
  let prompt = -1;
  for (let index = outline.length - 1; index >= 0; index -= 1) {
    const message = outline[index];
    if (isRecord(message) && isPromptMessage(message)) {
      prompt = index;
      break;
    }
  }
  if (prompt < 0) return null;
  let last: Record<string, unknown> | null = null;
  for (const message of outline.slice(prompt + 1)) {
    if (!isRecord(message)) continue;
    const info = isRecord(message.info) ? message.info : message;
    // A compaction's summary is the engine's, not the turn's answer.
    if (info.summary === true || info.agent === "compaction" || info.mode === "compaction") continue;
    if ((info.role ?? info.type) === "assistant") last = message;
  }
  if (!last) return "no_reply";
  const info = isRecord(last.info) ? last.info : last;
  const error = info.error;
  if (error != null) {
    const name = isRecord(error) ? error.name ?? error.type : error;
    return name === "MessageAbortedError" || name === "aborted" ? "stopped" : "error";
  }
  return isFinishedAssistantMessage(last) ? "completed" : "incomplete";
}

async function messageOutlines(messages: AsyncIterable<EngineMessage>): Promise<unknown[]> {
  const outline: unknown[] = [];
  for await (const { message } of messages) outline.push(messageOutline(message));
  return outline.reverse();
}

/** Whether the newest assistant message ended (read from the newest page on). */
async function newestAssistantFinished(messages: AsyncIterable<EngineMessage>): Promise<boolean> {
  for await (const { message } of messages) {
    if (!isRecord(message)) continue;
    const info = isRecord(message.info) ? message.info : message;
    if ((info.role ?? info.type) === "assistant") return isFinishedAssistantMessage(message);
  }
  return false;
}

function traceMessageId(message: unknown): string | null {
  if (!isRecord(message)) return null;
  const info = isRecord(message.info) ? message.info : message;
  return typeof info.id === "string" && info.id ? info.id : null;
}

/** A session's messages as one settled turn reads them. */
type EngineHistory = {
  /** Every message in outline, oldest first. */
  outline: unknown[];
  /** The messages after the checkpoint, oldest first and whole: the newest of them, up to the read's budget. */
  delta: unknown[];
  /** The JSON size of each message in `delta`. */
  sizes: number[];
  /** Messages after the checkpoint left out of `delta`: too large to read, or past the budget. */
  omitted: number;
  /**
   * The checkpoint, when the history no longer holds it: the messages it
   * ended were removed (a revert made final by the next prompt), and the
   * whole kept history is the delta.
   */
  checkpointMissing?: string;
};

/**
 * Reads the whole history a page at a time: the messages after the
 * checkpoint message (all of them without one) whole, up to `budget` bytes of
 * them, and every message in outline, so a history of any length keeps its
 * transcript and turn count.
 */
/** Whether an engine message is the user's (a prompt), by its info.role or role. */
function isUserMessage(message: unknown): boolean {
  if (!isRecord(message)) return false;
  const info = isRecord(message.info) ? message.info : message;
  return info.role === "user";
}

async function readEngineHistory(
  messages: AsyncIterable<EngineMessage>,
  checkpoint: string | undefined,
  budget = MAX_TURN_MESSAGE_BYTES,
): Promise<EngineHistory> {
  const outline: unknown[] = [];
  const delta: unknown[] = [];
  const sizes: number[] = [];
  let deltaBytes = 0;
  let budgetSpent = false;
  let omitted = 0;
  let afterCheckpoint = true;
  for await (const { message, whole } of messages) {
    if (checkpoint && traceMessageId(message) === checkpoint) afterCheckpoint = false;
    outline.push(messageOutline(message));
    if (!afterCheckpoint) continue;
    const user = whole && isUserMessage(message);
    const bytes = whole && (!budgetSpent || user) ? Buffer.byteLength(JSON.stringify(message)) : 0;
    if (whole && !budgetSpent && deltaBytes + bytes <= budget) {
      delta.push(message);
      sizes.push(bytes);
      deltaBytes += bytes;
      continue;
    }
    // Newest first: once the budget is spent, every older message is left
    // out too, except the user's own prompts: a long turn's first message
    // is its prompt, and a turn without it has no question to its answers.
    if (whole) budgetSpent = true;
    if (user && bytes <= budget) {
      delta.push(message);
      sizes.push(bytes);
      continue;
    }
    omitted += 1;
  }
  const checkpointMissing = checkpoint && afterCheckpoint && outline.length > 0 ? checkpoint : undefined;
  return { outline: outline.reverse(), delta: delta.reverse(), sizes: sizes.reverse(), omitted, ...(checkpointMissing ? { checkpointMissing } : {}) };
}

/** When the engine created a message (info.time.created, epoch milliseconds), if it says. */
function messageCreatedAt(message: unknown): number | null {
  if (!isRecord(message)) return null;
  const info = isRecord(message.info) ? message.info : message;
  const time = isRecord(info.time) ? info.time : null;
  const created = time?.created;
  if (typeof created === "number" && Number.isFinite(created)) return created;
  if (typeof created === "string") {
    const parsed = Date.parse(created);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function messageRole(message: unknown): unknown {
  if (!isRecord(message)) return undefined;
  const info = isRecord(message.info) ? message.info : message;
  return info.role ?? info.type;
}

/**
 * The history of a turn the next prompt ended (that prompt dispatched at
 * `cutAt`): everything before the first user message the engine created
 * from then on. `found` says whether that message is there yet, and
 * `answered` whether the newest assistant message before it finished.
 */
function historyBefore(history: EngineHistory, cutAt: number): { history: EngineHistory; found: boolean; answered: boolean } {
  const cut = history.outline.findIndex((message) => messageRole(message) === "user" && (messageCreatedAt(message) ?? -Infinity) >= cutAt);
  const kept = cut < 0 ? history.outline : history.outline.slice(0, cut);
  const newestAssistant = [...kept].reverse().find((message) => messageRole(message) === "assistant");
  const newestUser = [...kept].reverse().find((message) => messageRole(message) === "user");
  // An answer that ended its step on tool calls goes on with another step.
  const answered = isRecord(newestAssistant) && isFinishedAssistantMessage(newestAssistant)
    && (isRecord(newestAssistant.info) ? newestAssistant.info.finish : newestAssistant.finish) !== "tool-calls"
    && kept.indexOf(newestAssistant) > (newestUser === undefined ? -1 : kept.indexOf(newestUser));
  if (cut < 0) return { history, found: false, answered };
  const later = new Set(history.outline.slice(cut).map(traceMessageId).filter((id): id is string => id !== null));
  const keep = history.delta.map((message) => !later.has(traceMessageId(message) ?? ""));
  return {
    history: {
      outline: kept,
      delta: history.delta.filter((_, index) => keep[index]),
      sizes: history.sizes.filter((_, index) => keep[index]),
      omitted: history.omitted,
      ...(history.checkpointMissing ? { checkpointMissing: history.checkpointMissing } : {}),
    },
    found: true,
    answered,
  };
}

/** Messages one trace flush carries, oldest first, and their JSON size. */
type MessagePart = { messages: unknown[]; bytes: number };

/**
 * A chat's whole transcript as the engine has it now (oldest first, cut into
 * trace-sized parts), for re-sending what the server is missing; null when
 * the engine cannot be read.
 */
export async function readSessionTranscript(target: EngineTarget, sessionId: string, signal: AbortSignal): Promise<unknown[][] | null> {
  const fetchEngine = engineFetch(() => target, () => AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
  const v2 = target.engine === "v2";
  const path = v2 ? `/api/session/${encodeURIComponent(sessionId)}/context` : `/session/${encodeURIComponent(sessionId)}/message`;
  try {
    const history = await readEngineHistory(engineMessages(fetchEngine, path, !v2), undefined, MAX_BACKLOG_MESSAGE_BYTES);
    return messageParts(history.delta, history.sizes).map((part) => part.messages);
  } catch {
    return null;
  }
}

/**
 * A settled turn's messages (oldest first) cut into the parts its trace
 * flushes carry, oldest part first: the newest messages up to `maxBytes` make
 * the last part, and each earlier part takes the next older ones. One part,
 * empty, when there are no messages.
 */
function messageParts(messages: readonly unknown[], sizes: readonly number[], maxBytes = MAX_TURN_MESSAGE_BYTES): MessagePart[] {
  const parts: MessagePart[] = [];
  let part: MessagePart = { messages: [], bytes: 0 };
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const bytes = sizes[index] ?? 0;
    if (part.messages.length > 0 && part.bytes + bytes > maxBytes) {
      parts.push(part);
      part = { messages: [], bytes: 0 };
    }
    part.messages.push(messages[index]);
    part.bytes += bytes;
  }
  parts.push(part);
  for (const each of parts) each.messages.reverse();
  return parts.reverse();
}

/** The wait before a status read: a second for a turn's first two minutes, then a second more per minute it has run, at most MAX_STATUS_POLL_MS. */
function statusPollDelay(elapsedMs: number): number {
  return Math.min(MAX_STATUS_POLL_MS, Math.max(1_000, Math.floor(elapsedMs / 60_000) * 1_000));
}

/**
 * The engine reads behind a project archive session start (is it a child
 * session, how many turns has it completed), made like the session uploader
 * observer's: same engine, headers and query, never from the request path.
 */
export function projectArchiveEngineReads(target: EngineTarget | (() => EngineTarget), sessionId: string): ArchiveEngineReads {
  const current = typeof target === "function" ? target : () => target;
  const v2 = current().engine === "v2";
  const fetchEngine = engineFetch(current, () => AbortSignal.timeout(20_000));
  const session = `${v2 ? "/api/session" : "/session"}/${encodeURIComponent(sessionId)}`;
  return {
    session: async () => {
      const payload = await readEngineJson(fetchEngine, session, 1024 * 1024).catch(nullOnErrorStatus);
      return v2 && isRecord(payload) && "data" in payload ? payload.data : payload;
    },
    // The same messages the observer counts turns from at turn end, in outline.
    messages: () => messageOutlines(engineMessages(fetchEngine, v2 ? `${session}/context` : `${session}/message`, !v2)),
  };
}

/**
 * Follows a captured session until its turn settles, then records the
 * turn's model, subagents and messages, takes the turn's change snapshot,
 * flushes the trace and hands the engine's messages to the project archive.
 * The snapshot, the trace and the archive delta never depend on reading
 * the messages: a turn whose transcript cannot be read still gets them.
 *
 * A turn is followed for as long as it runs, reading the engine's status
 * less often as the turn grows long. The engine failing to answer (a
 * timeout, a dropped connection, an error status, a restart) is waited out
 * with backoff, and a request that finds the session already followed points
 * the observer at that request's engine. Nothing but the server stopping,
 * the safety bound (MAX_OBSERVED_TURN_MS) or an unexpected error ends an
 * observation before its turn settles; the last two still take the turn's
 * snapshot, with its turn.diff, flush the trace and tell the project archive
 * the turn ended without completing (turnIncomplete: its delta, or a final
 * archive of the folder). A server stop tells it nothing: the archive's own
 * stop() packs the final archives of a quit. The messages of a turn
 * that did not settle stay after the checkpoint, so the session's next
 * settled turn (after an app restart too) carries them, over several flushes
 * when they are more than one holds. A request that came in while a turn
 * settled starts the next observation. Every turn followed tells the project
 * archive first (turnFollowed), so the idle final archive that the previous
 * turn's end armed never runs while this one does. Resolves once the
 * observation ended.
 */
export function observeUploadedSession(input: {
  sessionUploader: ObservedUploader;
  archive: Pick<ProjectArchiveLifecycle, "turnFollowed" | "turnCompleted" | "turnIncomplete"> & Partial<Pick<ProjectArchiveLifecycle, "turnMessages" | "turnFilesUsed">>;
  /**
   * The session's workspace: each settled turn reports the files outside it
   * that the turn touched to the archive, and records the files it read
   * (session-archive/turn-files.ts). Without it, neither.
   */
  turnFiles?: Omit<TurnFilesInput, "sessionId" | "messages" | "collector">;
  observers: SessionObservers;
  sessionId: string;
  target: EngineTarget;
  timing?: Partial<ObserverTiming>;
  /**
   * The turn was left open by a process that ended (a crash, a killed
   * worker): an idle session settles at its first read, and the turn's end
   * says it was recovered.
   */
  recovered?: boolean;
}): Promise<void> {
  if (!input.sessionUploader.enabled) return Promise.resolve();
  const observer = input.observers;
  const { sessionUploader, sessionId } = input;
  // A request that reached an engine since closed names it: its sessions are read from the one that took over.
  const requestTarget = currentEngineTarget(observer, input.target);
  const observed = observer.sessions.get(sessionId);
  if (observed) {
    observed.target = requestTarget;
    observed.requests += 1;
    return observed.done;
  }
  const session: ObservedSession = { target: requestTarget, requests: 0, turn: null, done: Promise.resolve() };
  observer.sessions.set(sessionId, session);
  const timing: ObserverTiming = {
    now: () => Date.now(),
    sleep: uploadDelay,
    statusTimeoutMs: 10_000,
    readTimeoutMs: 20_000,
    maxTurnMs: MAX_OBSERVED_TURN_MS,
    ...input.timing,
  };
  const stopped = observer.controller.signal;
  const v2 = input.target.engine === "v2";
  const target = () => session.target;
  const fetchStatus = engineFetch(target, () => AbortSignal.any([stopped, AbortSignal.timeout(timing.statusTimeoutMs)]));
  const fetchEngine = engineFetch(target, () => AbortSignal.any([stopped, AbortSignal.timeout(timing.readTimeoutMs)]));
  const messagesPath = v2 ? `/api/session/${encodeURIComponent(sessionId)}/context` : `/session/${encodeURIComponent(sessionId)}/message`;
  const messages = () => engineMessages(fetchEngine, messagesPath, !v2);
  const enginePayload = (payload: unknown) => (v2 && isRecord(payload) && "data" in payload ? payload.data : payload);
  const falseUnlessStopped = (error: unknown): false => {
    if (stopped.aborted) throw error;
    return false;
  };
  // Whether the project archive heard of the turn's end: a failure after it
  // must not repeat it. Whether the turn's snapshot was taken is the
  // followed turn's own (a prompt dispatched before it settled takes it).
  let turnArchived = false;
  const turnState = (): FollowedTurn => (session.turn ??= { snapshotTaken: false, cutAt: null });
  /** The followed turn's turn_completed snapshot, unless it was taken already ("aborted": the user stopped it). */
  const captureTurnSnapshot = (outcome?: "aborted"): void => {
    const turn = turnState();
    if (turn.snapshotTaken) return;
    turn.snapshotTaken = true;
    if (outcome) sessionUploader.captureSnapshot(sessionId, "turn_completed", outcome);
    else sessionUploader.captureSnapshot(sessionId, "turn_completed");
  };

  /** The session's status ("idle" when the engine does not list it); throws when the engine does not answer. */
  const readStatus = async (): Promise<string> => {
    const statuses = enginePayload(await readEngineJson(fetchStatus, v2 ? "/api/session/active" : "/session/status", 1024 * 1024));
    const status = isRecord(statuses) ? statuses[sessionId] : undefined;
    return isRecord(status) && typeof status.type === "string" ? status.type : "idle";
  };

  /** The history as the settled turn left it; a read the engine did not answer is tried again. */
  const readHistory = async (): Promise<EngineHistory> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await readEngineHistory(messages(), observer.lastMessageIds.get(sessionId), MAX_BACKLOG_MESSAGE_BYTES);
      } catch (error) {
        // An error status is the engine's answer; a timeout or a dropped connection is worth another read.
        const delay = HISTORY_RETRY_DELAYS_MS[attempt];
        if (stopped.aborted || error instanceof EngineReadError || delay === undefined) throw error;
        await timing.sleep(delay, stopped);
      }
    }
  };

  /**
   * Everything a settled turn records, in order: messages, subagents, the
   * idle event, the snapshot, the trace and the archive delta. `read` is the
   * history when it was read already; a turn ended by the next prompt keeps
   * only the messages from before that prompt.
   */
  let recovering = input.recovered === true;
  const settle = async (status: string, read?: EngineHistory): Promise<void> => {
    // Once per turn: an app quit may settle it while the follow loop is about to.
    const turn = turnState();
    if (turn.settled) return;
    turn.settled = true;
    const recovered = recovering;
    recovering = false;
    let history: EngineHistory | null = read ?? null;
    let unavailable: Record<string, unknown> = { unavailable: true };
    try {
      history ??= await readHistory();
      const cutAt = session.turn?.cutAt ?? null;
      if (cutAt !== null) history = historyBefore(history, cutAt).history;
    } catch (error) {
      if (stopped.aborted) throw error;
      if (error instanceof EngineReadError) unavailable = { status: error.status, unavailable: true };
      sessionUploader.recordTrace(sessionId, "session.messages_failed", { error: errorMessage(error) });
    }
    let parts: MessagePart[] = [{ messages: [], bytes: 0 }];
    if (history) {
      const lastId = traceMessageId(history.outline.at(-1));
      if (lastId) {
        observer.lastMessageIds.set(sessionId, lastId);
        void sessionUploader.setSessionCheckpoint(sessionId, lastId);
      }
      if (history.checkpointMissing && !v2) {
        // The messages the last upload ended with are gone: a revert was made
        // final. Earlier uploads still hold the reverted turns, so the trace
        // says which messages the session kept (every one, oldest first); any
        // other message an earlier upload carried was reverted. (The v2
        // daemon's context read drops compacted messages, so it is not asked.)
        sessionUploader.recordTrace(sessionId, "session.reverted", {
          missing_message_id: history.checkpointMissing,
          kept_message_ids: history.outline.map(traceMessageId).filter((id): id is string => id !== null),
        });
      }
      if (history.omitted > 0) sessionUploader.recordTrace(sessionId, "session.messages_omitted", { count: history.omitted });
      const model = turnModelFromMessages(history.delta);
      if (model) sessionUploader.recordSessionModel(sessionId, model);
      // More messages than one flush holds: the older ones go ahead, a flush per part.
      parts = messageParts(history.delta, history.sizes);
      for (const [index, part] of parts.slice(0, -1).entries()) {
        sessionUploader.recordTrace(sessionId, "turn.messages", { messages: part.messages, part: index + 1, parts: parts.length });
        sessionUploader.flushTrace(sessionId);
      }
    }
    const newest = parts.at(-1)!;
    // Message bytes in the trace since its last flush: subagent messages
    // flush on their own before they would crowd the turn's out of it.
    let pending = 0;
    const room = (bytes: number) => {
      if (pending > 0 && pending + bytes > MAX_TURN_MESSAGE_BYTES) {
        sessionUploader.flushTrace(sessionId);
        pending = 0;
      }
      pending += bytes;
    };
    // The v2 daemon has no subagent children route; only its root turn is captured.
    if (!v2) {
      try {
        await captureChildSessions({
          sessionUploader,
          rootSessionId: sessionId,
          parentSessionId: sessionId,
          depth: 1,
          fetchEngine,
          checkpoints: await sessionUploader.childCheckpoints(sessionId),
          known: new Set(await sessionUploader.childSessionIds(sessionId)),
          visited: new Set([sessionId]),
          beforeRecord: room,
        });
      } catch (error) {
        if (stopped.aborted) throw error;
        sessionUploader.recordTrace(sessionId, "session.children_failed", { error: errorMessage(error) });
      }
    }
    room(newest.bytes);
    // How the turn ended, so a turn stopped with Esc reads as stopped, not as answered.
    const outcome = history ? turnOutcome(history.outline) : null;
    sessionUploader.recordTrace(sessionId, "session.idle", outcome ? { status, outcome } : { status });
    // The files the turn read, and those outside the workspace it touched, before the snapshot and the flush.
    if (history && input.turnFiles) await recordTurnFiles({ ...input.turnFiles, sessionId, messages: history.delta, collector: sessionUploader });
    // The turn snapshot runs first so the artifacts it discovers are part of
    // the trace flushed right behind it.
    // A turn the user stopped (Esc, Stop) says so on its trigger and its turn.completed event too.
    const aborted = outcome === "stopped" ? ("aborted" as const) : undefined;
    captureTurnSnapshot(aborted);
    sessionUploader.flushTrace(sessionId, {
      messages: history ? newest.messages : unavailable,
      ...(aborted ? { outcome: aborted } : {}),
      ...(recovered ? { recovered: true } : {}),
      ...(status === "quit" ? { reason: "app_quit" } : {}),
    });
    // The delta's turn number is the engine's completed-turn count, which
    // survives app restarts; without the messages the archiver numbers it
    // right after the last archived turn. It also arms the idle final archive.
    turnArchived = true;
    // Capture v2: the turn's attachments are staged ahead of its delta.
    if (history) input.archive.turnMessages?.(sessionId, history.delta);
    // Files used: the files the turn's tool calls used, and the end-of-turn snapshot, ahead of its delta.
    if (history) input.archive.turnFilesUsed?.(sessionId, history.delta);
    input.archive.turnCompleted(sessionId, history ? history.outline : null);
  };

  /**
   * Follows one turn until it settles: resolves with the requests counted
   * when the session was first seen idle, "cut" when the next prompt ended
   * it, or null past the safety bound.
   */
  const followTurn = async (): Promise<number | "cut" | null> => {
    // A turn is running: the previous turn's idle final archive, if armed, is off.
    input.archive.turnFollowed(sessionId);
    const startedAt = timing.now();
    let observedBusy = false;
    let reads = 0;
    let idleReads = 0;
    let idleSince = startedAt;
    let requestsWhenIdle = session.requests;
    let failures = 0;
    let unavailableSince: number | null = null;
    let unavailableTraced = false;
    let readTarget = session.target;
    // When the observer first saw that the next prompt ended this turn.
    let cutSeenAt: number | null = null;
    // When the subagent sessions below were last listed.
    let childIdsAt = startedAt;
    while (timing.now() - startedAt < timing.maxTurnMs) {
      // An engine that took over from a closed one is read at once, without the closed one's backoff.
      if (session.target !== readTarget) {
        readTarget = session.target;
        failures = 0;
      }
      const elapsed = timing.now() - startedAt;
      const delay = failures > 0
        ? Math.max(statusPollDelay(elapsed), Math.min(MAX_STATUS_RETRY_MS, 1_000 * 2 ** (failures - 1)))
        : idleReads === 1 ? 1_000 : statusPollDelay(elapsed);
      await timing.sleep(delay, stopped);
      reads += 1;
      let status: string;
      try {
        status = await readStatus();
      } catch (error) {
        if (stopped.aborted) throw error;
        failures += 1;
        idleReads = 0;
        unavailableSince ??= timing.now();
        if (!unavailableTraced && timing.now() - unavailableSince >= ENGINE_UNAVAILABLE_TRACE_MS) {
          unavailableTraced = true;
          sessionUploader.recordTrace(sessionId, "session.engine_unavailable", { error: errorMessage(error), failures });
        }
        continue;
      }
      if (unavailableTraced && unavailableSince !== null) {
        sessionUploader.recordTrace(sessionId, "session.engine_recovered", { failures, unavailable_ms: timing.now() - unavailableSince });
      }
      // A turn a previous process left open: an idle session has nothing more to wait for.
      if (recovering && status === "idle") {
        await settle(status);
        return session.requests;
      }
      failures = 0;
      unavailableSince = null;
      unavailableTraced = false;
      const cutAt = session.turn?.cutAt ?? null;
      if (cutAt !== null) {
        // The next prompt went out before this turn settled. The turn ends
        // with the messages from before that prompt once they are all there:
        // its answer finished (the session may be busy with the next turn),
        // or the session is idle. A prompt the engine never recorded is not
        // waited for long: the turn then settles as the engine left it.
        cutSeenAt ??= timing.now();
        let history: EngineHistory;
        try {
          history = await readHistory();
        } catch (error) {
          if (stopped.aborted) throw error;
          continue;
        }
        const before = historyBefore(history, cutAt);
        const waited = timing.now() - cutSeenAt;
        if (before.found ? status === "idle" || before.answered : waited >= CUT_PROMPT_WAIT_MS) {
          await settle(status, history);
          return "cut";
        }
        continue;
      }
      if (status !== "idle") {
        observedBusy = true;
        idleReads = 0;
        // The v2 daemon has no children route: nothing to list there.
        if (!v2 && timing.now() - childIdsAt >= CHILD_IDS_INTERVAL_MS) {
          childIdsAt = timing.now();
          try {
            sessionUploader.noteChildSessionIds(sessionId, await childSessionIdsBelow(fetchEngine, sessionId));
          } catch (error) {
            if (stopped.aborted) throw error;
          }
        }
        continue;
      }
      if (idleReads === 0) {
        idleSince = timing.now();
        requestsWhenIdle = session.requests;
      }
      idleReads += 1;
      if (idleReads < 2 || reads < 4) continue;
      // Never seen busy: the turn settled only once its answer ended (the prompt may not have started yet).
      if (!observedBusy && timing.now() - idleSince < NEVER_BUSY_SETTLE_MS && !(await newestAssistantFinished(messages()).catch(falseUnlessStopped))) {
        continue;
      }
      await settle(status);
      return requestsWhenIdle;
    }
    // The server stopping is no timeout: it ends the observation quietly, and
    // the project archive's own stop() packs the final archives of a quit.
    stopped.throwIfAborted();
    sessionUploader.recordTrace(sessionId, "session.observer_timeout", { waited_ms: timing.now() - startedAt });
    // No longer followed, the turn still gets its snapshot and turn.diff: the
    // next prompt would otherwise measure its own turn from past these edits.
    // Its messages are left after the checkpoint for the next settled turn.
    captureTurnSnapshot();
    sessionUploader.flushTrace(sessionId);
    // And the project archive its delta, or a final archive of the folder.
    turnArchived = true;
    input.archive.turnIncomplete(sessionId);
    return null;
  };

  session.settleNow = async () => {
    if (!session.turn || session.turn.settled) return;
    sessionUploader.recordTrace(sessionId, "session.quit_settled", {});
    await settle("quit");
  };
  session.done = (async () => {
    const checkpoint = await sessionUploader.sessionCheckpoint(sessionId);
    if (checkpoint.lastMessageId) observer.lastMessageIds.set(sessionId, checkpoint.lastMessageId);
    while (true) {
      session.turn = { snapshotTaken: false, cutAt: null };
      turnArchived = false;
      const requests = await followTurn();
      session.turn = null;
      // A turn ended by the next prompt is followed by that prompt's turn.
      if (requests === "cut") continue;
      // A request that came in once the session was idle (the next prompt) started a turn of its own.
      if (requests === null || session.requests === requests) return;
    }
  })().catch((error: unknown) => {
    if (!stopped.aborted) {
      sessionUploader.recordTrace(sessionId, "session.observer_failed", { error: errorMessage(error) });
      if (!session.turn?.snapshotTaken) sessionUploader.captureSnapshot(sessionId, "turn_completed");
      sessionUploader.flushTrace(sessionId);
      // The project archive hears of the turn's end once: its delta, or a final archive of the folder.
      if (!turnArchived) input.archive.turnIncomplete(sessionId);
    }
  }).finally(() => {
    observer.sessions.delete(sessionId);
  });
  return session.done;
}

/** Capture v2: the tool-start listener of each session's current turn (followToolStart). */
const TOOL_WATCHES = new WeakMap<SessionObservers, Map<string, AbortController>>();
/** A turn's listener stops after this long at most (the observer's own bound). */
const MAX_TOOL_WATCH_MS = MAX_OBSERVED_TURN_MS;

/**
 * Capture v2, #9: call when a prompt of the session goes to the engine.
 * Listens to the engine's event stream until the turn's first tool call
 * starts and tells the project archive (toolStarted), which captures the
 * folder's state in the background when it changed. A newer prompt of the
 * session replaces the listener; the observers' stop ends it.
 */
export function followToolStart(input: {
  observers: SessionObservers;
  archive: Pick<ProjectArchiveLifecycle, "toolStarted">;
  sessionId: string;
  target: EngineTarget;
}): void {
  let watches = TOOL_WATCHES.get(input.observers);
  if (!watches) {
    watches = new Map();
    TOOL_WATCHES.set(input.observers, watches);
  }
  watches.get(input.sessionId)?.abort();
  const controller = new AbortController();
  watches.set(input.sessionId, controller);
  const map = watches;
  const { baseUrl, headers, search, engine } = input.target;
  const url = buildOpencodeProxyUrl(baseUrl, engine === "v2" ? "/api/event" : "/event", search);
  const signal = AbortSignal.any([controller.signal, input.observers.controller.signal, AbortSignal.timeout(MAX_TOOL_WATCH_MS)]);
  void watchToolStarts({
    url,
    headers: new Headers(headers),
    sessionId: input.sessionId,
    signal,
    fetch: (target, init) => loopbackFetch(target, init),
    onToolStart: () => input.archive.toolStarted(input.sessionId),
  }).finally(() => {
    if (map.get(input.sessionId) === controller) map.delete(input.sessionId);
  });
}

const FILES_USED_WATCHES = new WeakMap<SessionObservers, Map<string, AbortController>>();

/**
 * Files used: every tool call of the session as it ends, from the engine's
 * event stream (files-used.ts watchToolCallEnds), so the temp files it
 * named or made are kept before a later call deletes them. Only while the
 * project archive may record files used; the next prompt's call replaces it.
 */
export function followFilesUsedCalls(input: {
  observers: SessionObservers;
  archive: Pick<ProjectArchiveLifecycle, "toolCallEnded" | "filesUsedMaybe">;
  sessionId: string;
  target: EngineTarget;
}): void {
  let watches = FILES_USED_WATCHES.get(input.observers);
  if (!watches) {
    watches = new Map();
    FILES_USED_WATCHES.set(input.observers, watches);
  }
  watches.get(input.sessionId)?.abort();
  if (!input.archive.filesUsedMaybe()) return;
  const controller = new AbortController();
  watches.set(input.sessionId, controller);
  const map = watches;
  const { baseUrl, headers, search, engine } = input.target;
  const url = buildOpencodeProxyUrl(baseUrl, engine === "v2" ? "/api/event" : "/event", search);
  const signal = AbortSignal.any([controller.signal, input.observers.controller.signal, AbortSignal.timeout(MAX_TOOL_WATCH_MS)]);
  void watchToolCallEnds({
    url,
    headers: new Headers(headers),
    sessionId: input.sessionId,
    signal,
    fetch: (target, init) => loopbackFetch(target, init),
    onCall: (call) => input.archive.toolCallEnded(input.sessionId, call),
  }).finally(() => {
    if (map.get(input.sessionId) === controller) map.delete(input.sessionId);
  });
}

const CONTEXT_WATCHES = new WeakMap<SessionObservers, Map<string, AbortController>>();

/**
 * Capture context (#20): every tool call of this turn as it starts and
 * ends, from the engine's event stream, for the network observer (a shell
 * call's start comes before its process is spawned). Runs until the turn's
 * observation stops; the next turn's call replaces it.
 */
export function followContextToolEvents(input: {
  observers: SessionObservers;
  context: Pick<ContextCapture, "toolEvent"> | null | undefined;
  sessionId: string;
  target: EngineTarget;
}): void {
  const context = input.context;
  if (!context) return;
  let watches = CONTEXT_WATCHES.get(input.observers);
  if (!watches) {
    watches = new Map();
    CONTEXT_WATCHES.set(input.observers, watches);
  }
  watches.get(input.sessionId)?.abort();
  const controller = new AbortController();
  watches.set(input.sessionId, controller);
  const map = watches;
  const { baseUrl, headers, search, engine } = input.target;
  const url = buildOpencodeProxyUrl(baseUrl, engine === "v2" ? "/api/event" : "/event", search);
  const signal = AbortSignal.any([controller.signal, input.observers.controller.signal, AbortSignal.timeout(MAX_TOOL_WATCH_MS)]);
  void watchToolEvents({
    url,
    headers: new Headers(headers),
    sessionId: input.sessionId,
    signal,
    fetch: (target, init) => loopbackFetch(target, init),
    onEvent: (event) => context.toolEvent(input.sessionId, event),
  }).finally(() => {
    if (map.get(input.sessionId) === controller) map.delete(input.sessionId);
  });
}
