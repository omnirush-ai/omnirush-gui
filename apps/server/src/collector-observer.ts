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
  fetchJson: (path: string, maxBytes: number) => Promise<unknown>;
  checkpoints: Record<string, string>;
  known: Set<string>;
  visited: Set<string>;
}): Promise<void> {
  if (input.depth > MAX_COLLECTOR_CHILD_SESSION_DEPTH) return;
  const children = await input.fetchJson(`/session/${encodeURIComponent(input.parentSessionId)}/children`, 1024 * 1024);
  if (!Array.isArray(children)) return;
  for (const child of children.slice(0, 200)) {
    const childId = isRecord(child) && typeof child.id === "string" && child.id ? child.id : null;
    if (!childId || childId === input.rootSessionId || input.visited.has(childId)) continue;
    input.visited.add(childId);
    const messages = await input.fetchJson(`/session/${encodeURIComponent(childId)}/message`, 8 * 1024 * 1024);
    const list = Array.isArray(messages) ? messages : [];
    const delta = newTraceMessages(list, input.checkpoints[childId]);
    const newMessages = Array.isArray(delta) ? delta : [];
    if (newMessages.length > 0 || !input.known.has(childId)) {
      input.collector.recordChildSession(input.rootSessionId, {
        childSessionId: childId,
        parentSessionId: input.parentSessionId,
        title: isRecord(child) ? optionalTraceString(child.title) : null,
        agent: turnModelFromMessages(list)?.agent ?? null,
        messages: newMessages,
        lastMessageId: traceMessageId(list.at(-1)),
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

async function readCollectorResponse(response: Response, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("trace response exceeded local limit");
      chunks.push(value);
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

function traceHasTerminalAssistant(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    const info = isRecord(message.info) ? message.info : message;
    if ((info.role ?? info.type) !== "assistant") continue;
    return isFinishedAssistantMessage(message);
  }
  return false;
}

function traceMessageId(message: unknown): string | null {
  if (!isRecord(message)) return null;
  const info = isRecord(message.info) ? message.info : message;
  return typeof info.id === "string" && info.id ? info.id : null;
}

function newTraceMessages(messages: unknown, previousId: string | undefined): unknown {
  if (!Array.isArray(messages) || !previousId) return messages;
  const index = messages.findIndex((message) => traceMessageId(message) === previousId);
  return index >= 0 ? messages.slice(index + 1) : messages;
}

/**
 * The engine reads behind a project archive session start (is it a child
 * session, how many turns has it completed), made like the collector
 * observer's: same engine, headers and query, never from the request path.
 */
export function projectArchiveEngineReads(target: EngineTarget, sessionId: string): ArchiveEngineReads {
  const v2 = target.engine === "v2";
  const read = async (path: string, maxBytes: number): Promise<unknown> => {
    const response = await loopbackFetch(buildOpencodeProxyUrl(target.baseUrl, path, target.search), {
      headers: new Headers(target.headers),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const payload = await readCollectorResponse(response, maxBytes);
    return v2 && isRecord(payload) && "data" in payload ? payload.data : payload;
  };
  const session = `${v2 ? "/api/session" : "/session"}/${encodeURIComponent(sessionId)}`;
  return {
    session: () => read(session, 1024 * 1024),
    // The same message list the observer counts turns from at turn end.
    messages: () => read(v2 ? `${session}/context` : `${session}/message`, 8 * 1024 * 1024),
  };
}

/**
 * Follows a collected session until its turn settles, then records the
 * turn's model, subagents and messages, takes the turn's change snapshot,
 * flushes the trace and hands the engine's messages to the project archive.
 */
export function observeCollectedSession(input: {
  collector: WorkspaceCollector;
  archive: Pick<ProjectArchiveLifecycle, "turnCompleted">;
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
  const messagesUrl = buildOpencodeProxyUrl(
    baseUrl,
    v2 ? `/api/session/${encodeURIComponent(input.sessionId)}/context` : `/session/${encodeURIComponent(input.sessionId)}/message`,
    search,
  );
  const enginePayload = (payload: unknown) => (v2 && isRecord(payload) && "data" in payload ? payload.data : payload);
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
      const messagesResponse = await loopbackFetch(messagesUrl, {
        headers,
        signal: AbortSignal.any([observer.controller.signal, AbortSignal.timeout(20_000)]),
      });
      const messages = messagesResponse.ok
        ? enginePayload(await readCollectorResponse(messagesResponse))
        : { status: messagesResponse.status, unavailable: true };
      const terminal = traceHasTerminalAssistant(messages);
      consecutiveSettled += 1;
      if ((!observedBusy && !terminal) || consecutiveSettled < 2 || attempt < 3) continue;
      const delta = newTraceMessages(messages, observer.lastMessageIds.get(input.sessionId));
      if (Array.isArray(messages)) {
        const lastId = traceMessageId(messages.at(-1));
        if (lastId) {
          observer.lastMessageIds.set(input.sessionId, lastId);
          void input.collector.setSessionCheckpoint(input.sessionId, lastId);
        }
      }
      const model = turnModelFromMessages(delta);
      if (model) input.collector.recordSessionModel(input.sessionId, model);
      // The v2 daemon has no subagent children route; only its root turn is captured.
      if (!v2) {
        try {
          await captureChildSessions({
            collector: input.collector,
            rootSessionId: input.sessionId,
            parentSessionId: input.sessionId,
            depth: 1,
            fetchJson: async (path, maxBytes) => {
              const response = await loopbackFetch(buildOpencodeProxyUrl(baseUrl, path, search), {
                headers,
                signal: AbortSignal.any([observer.controller.signal, AbortSignal.timeout(20_000)]),
              });
              if (!response.ok) {
                await response.body?.cancel().catch(() => undefined);
                return null;
              }
              return readCollectorResponse(response, maxBytes);
            },
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
      input.collector.captureSnapshot(input.sessionId, "turn_completed");
      input.collector.flushTrace(input.sessionId, { messages: delta });
      // The delta's turn number is the engine's completed-turn count, which survives app restarts.
      input.archive.turnCompleted(input.sessionId, messages);
      return;
    }
    input.collector.recordTrace(input.sessionId, "session.observer_timeout");
    input.collector.flushTrace(input.sessionId);
  })().catch((error: unknown) => {
    if (!observer.controller.signal.aborted) {
      input.collector.recordTrace(input.sessionId, "session.observer_failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
      input.collector.flushTrace(input.sessionId);
    }
  }).finally(() => {
    observer.sessions.delete(input.sessionId);
  });
}
