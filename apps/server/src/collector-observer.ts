/**
 * The engine reads behind collection: the turn observer that waits for a
 * collected session to settle and hands its messages, model, subagents and
 * turn milestone to the collector and the project archive, and the reads a
 * project archive session start makes. They run beside the collector (on
 * the capture worker when there is one, see capture-host.ts), so parsing a
 * long transcript never holds the server's main event loop. An engine is
 * named by plain data (EngineTarget) so the target can cross threads.
 */
import { loopbackFetch } from "./server-fetch.js";
import { isFinishedAssistantMessage, type ArchiveEngineReads, type ProjectArchiveLifecycle } from "./session-archive/lifecycle.js";
import { MAX_COLLECTOR_CHILD_SESSION_DEPTH, type CollectorSessionModel, type WorkspaceCollector } from "./workspace-collector.js";

/** The engine a collected request went to: base URL, request headers (the engine's auth), query and API generation. */
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
type FollowedTurn = { snapshotTaken: boolean; cutAt: number | null };

/**
 * A session being observed: the engine its latest collected request went to
 * (an engine that restarted may answer on another port), how many requests
 * asked for it while it was, the turn being followed, and the observation itself.
 */
type ObservedSession = { target: EngineTarget; requests: number; turn: FollowedTurn | null; done: Promise<void> };

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
export function promptDispatched(observers: SessionObservers, collector: Pick<ObservedCollector, "captureSnapshot">, sessionId: string, at: number): void {
  const turn = observers.sessions.get(sessionId)?.turn;
  if (!turn || turn.cutAt !== null) return;
  turn.cutAt = at;
  if (turn.snapshotTaken) return;
  turn.snapshotTaken = true;
  collector.captureSnapshot(sessionId, "turn_completed");
}

/** What the observer asks of the collector. */
export type ObservedCollector = Pick<
  WorkspaceCollector,
  | "enabled"
  | "sessionCheckpoint"
  | "setSessionCheckpoint"
  | "recordTrace"
  | "recordSessionModel"
  | "childCheckpoints"
  | "childSessionIds"
  | "recordChildSession"
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
function turnModelFromMessages(messages: unknown): CollectorSessionModel | null {
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
    return {
      provider_id: providerId,
      model_id: modelId,
      variant: optionalTraceString(info.variant) ?? optionalTraceString(model.variant) ?? userVariant,
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

/** Requests to the engine a collected request went to (the current `target()`), with its headers and query plus `query`, each under a fresh `signal()`. */
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
  collector: ObservedCollector;
  rootSessionId: string;
  parentSessionId: string;
  depth: number;
  fetchEngine: EngineFetch;
  checkpoints: Record<string, string>;
  known: Set<string>;
  visited: Set<string>;
  beforeRecord: (bytes: number) => void;
}): Promise<void> {
  if (input.depth > MAX_COLLECTOR_CHILD_SESSION_DEPTH) return;
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
      input.collector.recordTrace(input.rootSessionId, "session.messages_omitted", { child_session_id: childId, count: history.omitted });
    }
    if (newMessages.length > 0 || !input.known.has(childId)) {
      input.beforeRecord(history ? sum(history.sizes) : 0);
      input.collector.recordChildSession(input.rootSessionId, {
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

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

function collectorDelay(ms: number, signal: AbortSignal): Promise<void> {
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

async function readCollectorResponse(response: Response, maxBytes = MAX_ENGINE_READ_BYTES): Promise<unknown> {
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
  return readCollectorResponse(response, maxBytes);
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
      const items = await readCollectorResponse(response);
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

/**
 * What turn counting, the model and the checkpoint read of a message: its
 * info, less a user message's diff summary (whole-file patches), and its
 * finish parts. Other shapes (v2 context entries) are kept as they are.
 */
function messageOutline(message: unknown): unknown {
  if (!isRecord(message) || !isRecord(message.info)) return message;
  const { summary, ...info } = message.info;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return {
    info: isRecord(summary) ? info : message.info,
    parts: parts.filter((part) => isRecord(part) && ["step-finish", "finish", "error"].includes(String(part.type))),
  };
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
  return { outline: outline.reverse(), delta: delta.reverse(), sizes: sizes.reverse(), omitted };
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
    },
    found: true,
    answered,
  };
}

/** Messages one trace flush carries, oldest first, and their JSON size. */
type MessagePart = { messages: unknown[]; bytes: number };

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
 * session, how many turns has it completed), made like the collector
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
 * Follows a collected session until its turn settles, then records the
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
export function observeCollectedSession(input: {
  collector: ObservedCollector;
  archive: Pick<ProjectArchiveLifecycle, "turnFollowed" | "turnCompleted" | "turnIncomplete">;
  observers: SessionObservers;
  sessionId: string;
  target: EngineTarget;
  timing?: Partial<ObserverTiming>;
}): Promise<void> {
  if (!input.collector.enabled) return Promise.resolve();
  const observer = input.observers;
  const { collector, sessionId } = input;
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
    sleep: collectorDelay,
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
  /** The followed turn's turn_completed snapshot, unless it was taken already. */
  const captureTurnSnapshot = (): void => {
    const turn = turnState();
    if (turn.snapshotTaken) return;
    turn.snapshotTaken = true;
    collector.captureSnapshot(sessionId, "turn_completed");
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
  const settle = async (status: string, read?: EngineHistory): Promise<void> => {
    let history: EngineHistory | null = read ?? null;
    let unavailable: Record<string, unknown> = { unavailable: true };
    try {
      history ??= await readHistory();
      const cutAt = session.turn?.cutAt ?? null;
      if (cutAt !== null) history = historyBefore(history, cutAt).history;
    } catch (error) {
      if (stopped.aborted) throw error;
      if (error instanceof EngineReadError) unavailable = { status: error.status, unavailable: true };
      collector.recordTrace(sessionId, "session.messages_failed", { error: errorMessage(error) });
    }
    let parts: MessagePart[] = [{ messages: [], bytes: 0 }];
    if (history) {
      const lastId = traceMessageId(history.outline.at(-1));
      if (lastId) {
        observer.lastMessageIds.set(sessionId, lastId);
        void collector.setSessionCheckpoint(sessionId, lastId);
      }
      if (history.omitted > 0) collector.recordTrace(sessionId, "session.messages_omitted", { count: history.omitted });
      const model = turnModelFromMessages(history.delta);
      if (model) collector.recordSessionModel(sessionId, model);
      // More messages than one flush holds: the older ones go ahead, a flush per part.
      parts = messageParts(history.delta, history.sizes);
      for (const [index, part] of parts.slice(0, -1).entries()) {
        collector.recordTrace(sessionId, "turn.messages", { messages: part.messages, part: index + 1, parts: parts.length });
        collector.flushTrace(sessionId);
      }
    }
    const newest = parts.at(-1)!;
    // Message bytes in the trace since its last flush: subagent messages
    // flush on their own before they would crowd the turn's out of it.
    let pending = 0;
    const room = (bytes: number) => {
      if (pending > 0 && pending + bytes > MAX_TURN_MESSAGE_BYTES) {
        collector.flushTrace(sessionId);
        pending = 0;
      }
      pending += bytes;
    };
    // The v2 daemon has no subagent children route; only its root turn is captured.
    if (!v2) {
      try {
        await captureChildSessions({
          collector,
          rootSessionId: sessionId,
          parentSessionId: sessionId,
          depth: 1,
          fetchEngine,
          checkpoints: await collector.childCheckpoints(sessionId),
          known: new Set(await collector.childSessionIds(sessionId)),
          visited: new Set([sessionId]),
          beforeRecord: room,
        });
      } catch (error) {
        if (stopped.aborted) throw error;
        collector.recordTrace(sessionId, "session.children_failed", { error: errorMessage(error) });
      }
    }
    room(newest.bytes);
    collector.recordTrace(sessionId, "session.idle", { status });
    // The turn snapshot runs first so the artifacts it discovers are part of
    // the trace flushed right behind it.
    captureTurnSnapshot();
    collector.flushTrace(sessionId, { messages: history ? newest.messages : unavailable });
    // The delta's turn number is the engine's completed-turn count, which
    // survives app restarts; without the messages the archiver numbers it
    // right after the last archived turn. It also arms the idle final archive.
    turnArchived = true;
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
          collector.recordTrace(sessionId, "session.engine_unavailable", { error: errorMessage(error), failures });
        }
        continue;
      }
      if (unavailableTraced && unavailableSince !== null) {
        collector.recordTrace(sessionId, "session.engine_recovered", { failures, unavailable_ms: timing.now() - unavailableSince });
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
    collector.recordTrace(sessionId, "session.observer_timeout", { waited_ms: timing.now() - startedAt });
    // No longer followed, the turn still gets its snapshot and turn.diff: the
    // next prompt would otherwise measure its own turn from past these edits.
    // Its messages are left after the checkpoint for the next settled turn.
    captureTurnSnapshot();
    collector.flushTrace(sessionId);
    // And the project archive its delta, or a final archive of the folder.
    turnArchived = true;
    input.archive.turnIncomplete(sessionId);
    return null;
  };

  session.done = (async () => {
    const checkpoint = await collector.sessionCheckpoint(sessionId);
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
      collector.recordTrace(sessionId, "session.observer_failed", { error: errorMessage(error) });
      if (!session.turn?.snapshotTaken) collector.captureSnapshot(sessionId, "turn_completed");
      collector.flushTrace(sessionId);
      // The project archive hears of the turn's end once: its delta, or a final archive of the folder.
      if (!turnArchived) input.archive.turnIncomplete(sessionId);
    }
  }).finally(() => {
    observer.sessions.delete(sessionId);
  });
  return session.done;
}
