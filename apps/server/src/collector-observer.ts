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

/** Turn observers of one server: the sessions being observed, their last seen message, and the stop signal. */
export type SessionObservers = {
  sessions: Set<string>;
  lastMessageIds: Map<string, string>;
  controller: AbortController;
};

export function createSessionObservers(): SessionObservers {
  return { sessions: new Set(), lastMessageIds: new Map(), controller: new AbortController() };
}

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
/** The messages of one turn kept whole for its trace, the newest first. */
const MAX_TURN_MESSAGE_BYTES = 8 * 1024 * 1024;

type EngineFetch = (path: string, query?: Record<string, string>) => Promise<Response>;

/** Requests to the engine a collected request went to, with its headers and query plus `query`, each under a fresh `signal()`. */
function engineFetch(target: EngineTarget, signal: () => AbortSignal): EngineFetch {
  return (path, query = {}) => {
    const url = new URL(buildOpencodeProxyUrl(target.baseUrl, path, target.search));
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return loopbackFetch(url.toString(), { headers: new Headers(target.headers), signal: signal() });
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
 * since that child's checkpoint, recursively for grandchildren.
 */
async function captureChildSessions(input: {
  collector: WorkspaceCollector;
  rootSessionId: string;
  parentSessionId: string;
  depth: number;
  fetchEngine: EngineFetch;
  checkpoints: Record<string, string>;
  known: Set<string>;
  visited: Set<string>;
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
      input.collector.recordChildSession(input.rootSessionId, {
        childSessionId: childId,
        parentSessionId: input.parentSessionId,
        title: isRecord(child) ? optionalTraceString(child.title) : null,
        agent: turnModelFromMessages(history?.outline ?? [])?.agent ?? null,
        messages: newMessages,
        lastMessageId: traceMessageId(history?.outline.at(-1)),
      });
    }
    await captureChildSessions({ ...input, parentSessionId: childId, depth: input.depth + 1 });
  }
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
  /** The messages after the checkpoint, oldest first and whole: the newest of them, up to MAX_TURN_MESSAGE_BYTES. */
  delta: unknown[];
  /** Messages after the checkpoint left out of `delta`: too large to read, or past the turn's budget. */
  omitted: number;
};

/**
 * Reads the whole history a page at a time: the messages after the
 * checkpoint message (all of them without one) whole, every message in
 * outline, so a history of any length keeps its transcript and turn count.
 */
async function readEngineHistory(messages: AsyncIterable<EngineMessage>, checkpoint: string | undefined): Promise<EngineHistory> {
  const outline: unknown[] = [];
  const delta: unknown[] = [];
  let deltaBytes = 0;
  let budgetSpent = false;
  let omitted = 0;
  let afterCheckpoint = true;
  for await (const { message, whole } of messages) {
    if (checkpoint && traceMessageId(message) === checkpoint) afterCheckpoint = false;
    outline.push(messageOutline(message));
    if (!afterCheckpoint) continue;
    const bytes = whole && !budgetSpent ? Buffer.byteLength(JSON.stringify(message)) : 0;
    if (whole && !budgetSpent && deltaBytes + bytes <= MAX_TURN_MESSAGE_BYTES) {
      delta.push(message);
      deltaBytes += bytes;
      continue;
    }
    // Newest first: once the budget is spent, every older message is left out too.
    if (whole) budgetSpent = true;
    omitted += 1;
  }
  return { outline: outline.reverse(), delta: delta.reverse(), omitted };
}

/**
 * The engine reads behind a project archive session start (is it a child
 * session, how many turns has it completed), made like the collector
 * observer's: same engine, headers and query, never from the request path.
 */
export function projectArchiveEngineReads(target: EngineTarget, sessionId: string): ArchiveEngineReads {
  const v2 = target.engine === "v2";
  const fetchEngine = engineFetch(target, () => AbortSignal.timeout(20_000));
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
 * the messages: a turn whose transcript cannot be read still gets them. An
 * observer that stops following (after an hour, or on an error) still takes
 * the turn's snapshot, with its turn.diff, flushes the trace and tells the
 * project archive the turn ended without completing.
 */
export function observeCollectedSession(input: {
  collector: WorkspaceCollector;
  archive: Pick<ProjectArchiveLifecycle, "turnCompleted" | "turnIncomplete">;
  observers: SessionObservers;
  sessionId: string;
  target: EngineTarget;
}) {
  if (!input.collector.enabled) return;
  const observer = input.observers;
  if (observer.sessions.has(input.sessionId)) return;
  observer.sessions.add(input.sessionId);
  const { baseUrl, search } = input.target;
  const v2 = input.target.engine === "v2";
  const headers = new Headers(input.target.headers);
  const statusUrl = buildOpencodeProxyUrl(baseUrl, v2 ? "/api/session/active" : "/session/status", search);
  const fetchEngine = engineFetch(input.target, () => AbortSignal.any([observer.controller.signal, AbortSignal.timeout(20_000)]));
  const messagesPath = v2 ? `/api/session/${encodeURIComponent(input.sessionId)}/context` : `/session/${encodeURIComponent(input.sessionId)}/message`;
  const messages = () => engineMessages(fetchEngine, messagesPath, !v2);
  const enginePayload = (payload: unknown) => (v2 && isRecord(payload) && "data" in payload ? payload.data : payload);
  const falseUnlessStopped = (error: unknown): false => {
    if (observer.controller.signal.aborted) throw error;
    return false;
  };
  // Whether the turn's snapshot was taken, and whether the project archive
  // heard of the turn's end: a failure after either must not repeat it.
  let turnCaptured = false;
  let turnArchived = false;
  void (async () => {
    let observedBusy = false;
    let consecutiveSettled = 0;
    const checkpoint = await input.collector.sessionCheckpoint(input.sessionId);
    if (checkpoint.lastMessageId) observer.lastMessageIds.set(input.sessionId, checkpoint.lastMessageId);
    for (let attempt = 0; attempt < 3_600; attempt += 1) {
      await collectorDelay(1_000, observer.controller.signal);
      const response = await loopbackFetch(statusUrl, {
        headers,
        signal: AbortSignal.any([observer.controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        consecutiveSettled = 0;
        continue;
      }
      const statuses = enginePayload(await readCollectorResponse(response, 1024 * 1024));
      const session = isRecord(statuses) ? statuses[input.sessionId] : undefined;
      const statusType = isRecord(session) && typeof session.type === "string" ? session.type : "idle";
      if (statusType !== "idle") {
        observedBusy = true;
        consecutiveSettled = 0;
        continue;
      }
      consecutiveSettled += 1;
      if (consecutiveSettled < 2 || attempt < 3) continue;
      // Never seen busy: the turn settled only once its answer ended (the prompt may not have started yet).
      if (!observedBusy && !(await newestAssistantFinished(messages()).catch(falseUnlessStopped))) continue;
      let history: EngineHistory | null = null;
      let unavailable: Record<string, unknown> = { unavailable: true };
      try {
        history = await readEngineHistory(messages(), observer.lastMessageIds.get(input.sessionId));
      } catch (error) {
        if (observer.controller.signal.aborted) throw error;
        if (error instanceof EngineReadError) unavailable = { status: error.status, unavailable: true };
        input.collector.recordTrace(input.sessionId, "session.messages_failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
      }
      if (history) {
        const lastId = traceMessageId(history.outline.at(-1));
        if (lastId) {
          observer.lastMessageIds.set(input.sessionId, lastId);
          void input.collector.setSessionCheckpoint(input.sessionId, lastId);
        }
        if (history.omitted > 0) input.collector.recordTrace(input.sessionId, "session.messages_omitted", { count: history.omitted });
        const model = turnModelFromMessages(history.delta);
        if (model) input.collector.recordSessionModel(input.sessionId, model);
      }
      // The v2 daemon has no subagent children route; only its root turn is captured.
      if (!v2) {
        try {
          await captureChildSessions({
            collector: input.collector,
            rootSessionId: input.sessionId,
            parentSessionId: input.sessionId,
            depth: 1,
            fetchEngine,
            checkpoints: await input.collector.childCheckpoints(input.sessionId),
            known: new Set(await input.collector.childSessionIds(input.sessionId)),
            visited: new Set([input.sessionId]),
          });
        } catch (error) {
          if (observer.controller.signal.aborted) throw error;
          input.collector.recordTrace(input.sessionId, "session.children_failed", {
            error: error instanceof Error ? error.message : "unknown",
          });
        }
      }
      input.collector.recordTrace(input.sessionId, "session.idle", { status: statusType });
      // The turn snapshot runs first so the artifacts it discovers are part of
      // the trace flushed right behind it.
      turnCaptured = true;
      input.collector.captureSnapshot(input.sessionId, "turn_completed");
      input.collector.flushTrace(input.sessionId, { messages: history ? history.delta : unavailable });
      // The delta's turn number is the engine's completed-turn count, which
      // survives app restarts; without the messages the archiver numbers it
      // right after the last archived turn.
      turnArchived = true;
      input.archive.turnCompleted(input.sessionId, history ? history.outline : null);
      return;
    }
    input.collector.recordTrace(input.sessionId, "session.observer_timeout");
    // No longer followed, the turn still gets its snapshot and turn.diff: the
    // next prompt would otherwise measure its own turn from past these edits.
    turnCaptured = true;
    input.collector.captureSnapshot(input.sessionId, "turn_completed");
    input.collector.flushTrace(input.sessionId);
    // And the project archive its delta, or a final archive of the folder.
    turnArchived = true;
    input.archive.turnIncomplete(input.sessionId);
  })().catch((error: unknown) => {
    if (!observer.controller.signal.aborted) {
      input.collector.recordTrace(input.sessionId, "session.observer_failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
      if (!turnCaptured) input.collector.captureSnapshot(input.sessionId, "turn_completed");
      input.collector.flushTrace(input.sessionId);
      if (!turnArchived) input.archive.turnIncomplete(input.sessionId);
    }
  }).finally(() => {
    observer.sessions.delete(input.sessionId);
  });
}
