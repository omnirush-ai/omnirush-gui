/**
 * The 2.x engine's event stream (`GET /api/event`) as the 1.x bus events the
 * app and the server consume (`message.updated`, `message.part.updated`,
 * `message.part.delta`, `session.status`, `session.idle`, `permission.asked`,
 * `question.asked`, …).
 *
 * 2.x streams a step as fine-grained events (step started, text/reasoning
 * deltas, tool input/call/progress/result, step ended). The translator keeps
 * each in-flight assistant message in its 2.x shape, applies every event to it
 * and re-derives the 1.x parts with engine2/shapes.ts, so a part seen live and
 * the same part read back from the message list carry the same id and fields.
 * 2.x has no busy/idle status events: they are synthesized from the
 * execution lifecycle (`session.execution.started` → busy, `.succeeded` /
 * `.failed` / `.interrupted` → idle + `session.idle`).
 */
import { randomUUID } from "node:crypto";
import {
  partId,
  v1AssistantMessage,
  v1Error,
  v1UserTextParts,
  v1PermissionRequest,
  v1QuestionRequest,
  v1Session,
  type QuestionMapping,
} from "./shapes.js";
import { arr, isRecord, num, omitUndefined, promptFileUrl, record, str, type JsonRecord } from "./util.js";

export type V1Event = { type: string; properties: JsonRecord };
/** A translated event and the directory it belongs to (null: every directory). */
export type ScopedV1Event = { directory: string | null; event: V1Event };

type ModelRef = { providerID: string; modelID: string; variant?: string };

type LiveAssistant = {
  sessionID: string;
  message: JsonRecord;
  parentID: string;
  /** Tool input text streamed so far, per call id. */
  raw: Map<string, string>;
};

type SessionState = {
  directory: string | null;
  parentID?: string;
  agent?: string;
  model?: ModelRef;
  lastUserID: string;
  status: JsonRecord;
  info?: JsonRecord;
  /** The 1.x ids of the messages a staged revert hides (removed when it is committed). */
  reverted?: string[];
};

export type EventTranslatorOptions = {
  version: string;
  /** The worktree root reported in `path.root` for a directory (defaults to "/"). */
  rootFor?: (directory: string) => string | undefined;
  /** Looks up a session the stream has not described yet (its directory and parent). */
  lookupSession?: (sessionID: string) => Promise<unknown>;
  /** The 1.x ids of a session's messages, oldest first (what a staged revert hides). */
  messageIDs?: (sessionID: string) => Promise<string[]>;
  now?: () => number;
};

function eventId(): string {
  return `evt_${randomUUID().replace(/-/g, "").slice(0, 26)}`;
}

function modelRef(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const providerID = str(value, "providerID");
  const modelID = str(value, "id") ?? str(value, "modelID");
  if (!providerID || !modelID) return undefined;
  // 2.x records "default" when no variant was picked; 1.x left the field out.
  const variant = str(value, "variant");
  return variant && variant !== "default" ? { providerID, modelID, variant } : { providerID, modelID };
}

/** The child session a sub-agent call's progress or end metadata names. */
function childSessionIn(metadata: unknown): string | undefined {
  return isRecord(metadata) && typeof metadata.sessionID === "string" && metadata.sessionID ? metadata.sessionID : undefined;
}

/**
 * A backstop on the remembered child sessions: an entry normally goes when its
 * call ends, so this only bounds calls that never report an end (engine crash).
 */
const MAX_CHILD_SESSIONS = 2000;

export class EventTranslator {
  private readonly sessions = new Map<string, SessionState>();
  private readonly live = new Map<string, LiveAssistant>();
  private readonly questions = new Map<string, QuestionMapping>();
  /**
   * `<session>\0<call>` → the child session a sub-agent call runs in. The 2.x
   * engine names the child only in the call's progress events; its message
   * list leaves a running call's metadata without it until the call ends.
   */
  private readonly childSessions = new Map<string, string>();
  private readonly options: EventTranslatorOptions;

  constructor(options: EventTranslatorOptions) {
    this.options = options;
  }

  /** The child session of a sub-agent call, when its progress named one. */
  childSessionOf(sessionID: string, callID: string): string | undefined {
    return this.childSessions.get(`${sessionID}\u0000${callID}`);
  }

  private noteChildSession(sessionID: string, callID: string, metadata: unknown): void {
    const child = childSessionIn(metadata);
    if (!child) return;
    const key = `${sessionID}\u0000${callID}`;
    this.childSessions.delete(key);
    this.childSessions.set(key, child);
    if (this.childSessions.size > MAX_CHILD_SESSIONS) this.childSessions.delete(this.childSessions.keys().next().value as string);
  }

  /**
   * Forgets a call's child once its end event names it: the engine's own record
   * of the call carries it from then on. An end that does not name it (a failure
   * the engine may store without it) keeps the entry, so the card stays linked.
   */
  private settleChildSession(sessionID: string, callID: string, metadata: unknown): void {
    if (childSessionIn(metadata)) this.childSessions.delete(`${sessionID}\u0000${callID}`);
  }

  private forgetChildSessionsOf(sessionID: string): void {
    const prefix = `${sessionID}\u0000`;
    for (const key of this.childSessions.keys()) if (key.startsWith(prefix)) this.childSessions.delete(key);
  }

  /** The 1.x status of every session the stream saw busy or retrying. */
  statuses(): Record<string, JsonRecord> {
    const out: Record<string, JsonRecord> = {};
    for (const [id, state] of this.sessions) if (state.status.type !== "idle") out[id] = state.status;
    return out;
  }

  statusOf(sessionID: string): JsonRecord | undefined {
    return this.sessions.get(sessionID)?.status;
  }

  questionMapping(requestID: string): QuestionMapping | undefined {
    return this.questions.get(requestID);
  }

  rememberQuestion(requestID: string, mapping: QuestionMapping): void {
    this.questions.set(requestID, mapping);
  }

  /** Records what a read learned about a session (directory, parent, agent, model). */
  noteSession(sessionID: string, patch: { directory?: string | null; parentID?: string; agent?: string; model?: ModelRef; info?: JsonRecord }): void {
    const state = this.session(sessionID);
    if (patch.directory !== undefined && patch.directory !== null) state.directory = patch.directory;
    if (patch.parentID) state.parentID = patch.parentID;
    if (patch.agent) state.agent = patch.agent;
    if (patch.model) state.model = patch.model;
    if (patch.info) state.info = patch.info;
  }

  directoryOf(sessionID: string): string | null {
    return this.sessions.get(sessionID)?.directory ?? null;
  }

  isChild(sessionID: string): boolean {
    return Boolean(this.sessions.get(sessionID)?.parentID);
  }

  /** The session's 1.x info, read fresh when possible (else the last one seen). */
  private async currentInfo(sessionID: string): Promise<JsonRecord | null> {
    if (this.options.lookupSession) {
      try {
        const info = v1Session(await this.options.lookupSession(sessionID), { version: this.options.version });
        if (info) return info;
      } catch {
        // fall back to the last info seen
      }
    }
    return this.session(sessionID).info ?? null;
  }

  private session(sessionID: string): SessionState {
    let state = this.sessions.get(sessionID);
    if (!state) {
      state = { directory: null, lastUserID: "", status: { type: "idle" } };
      this.sessions.set(sessionID, state);
    }
    return state;
  }

  private ctx(sessionID: string) {
    const state = this.session(sessionID);
    const directory = state.directory ?? undefined;
    return {
      sessionID,
      directory,
      root: directory ? this.options.rootFor?.(directory) : undefined,
      agent: state.agent,
      model: state.model,
      child: Boolean(state.parentID),
      childSessionOf: (callID: string) => this.childSessionOf(sessionID, callID),
    };
  }

  private scoped(sessionID: string | undefined, type: string, properties: JsonRecord, directory?: string | null): ScopedV1Event {
    const dir = directory !== undefined ? directory : sessionID ? this.directoryOf(sessionID) : null;
    return { directory: dir, event: { type, properties } };
  }

  private assistantEvents(live: LiveAssistant, changedPart: string | null, includeInfo: boolean): ScopedV1Event[] {
    const mapped = v1AssistantMessage(live.message, this.ctx(live.sessionID), live.parentID);
    const out: ScopedV1Event[] = [];
    if (includeInfo) out.push(this.scoped(live.sessionID, "message.updated", { sessionID: live.sessionID, info: mapped.info }));
    for (const part of mapped.parts) {
      if (changedPart !== null && part.id !== changedPart) continue;
      out.push(this.scoped(live.sessionID, "message.part.updated", { sessionID: live.sessionID, part, time: this.now() }));
    }
    return out;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private liveFor(data: JsonRecord): LiveAssistant | undefined {
    const id = str(data, "assistantMessageID") ?? str(data, "messageID");
    return id ? this.live.get(id) : undefined;
  }

  private contentEntry(live: LiveAssistant, kind: "text" | "reasoning", ordinal: number): JsonRecord {
    const content = live.message.content as JsonRecord[];
    let seen = 0;
    for (const entry of content) {
      if (entry.type !== kind) continue;
      if (seen === ordinal) return entry;
      seen++;
    }
    const entry: JsonRecord = { type: kind, text: "" };
    content.push(entry);
    return entry;
  }

  private toolEntry(live: LiveAssistant, callID: string, name?: string): JsonRecord {
    const content = live.message.content as JsonRecord[];
    const found = content.find((entry) => entry.type === "tool" && entry.id === callID);
    if (found) return found;
    const entry: JsonRecord = { type: "tool", id: callID, name: name ?? "tool", state: { status: "streaming", input: "" }, time: { created: this.now() } };
    content.push(entry);
    return entry;
  }

  /** Translates one 2.x event; the result may be empty. Session lookups for unknown sessions are awaited. */
  async translate(raw: unknown): Promise<ScopedV1Event[]> {
    if (!isRecord(raw)) return [];
    const type = str(raw, "type") ?? "";
    const data = record(raw, "data") ?? record(raw, "properties") ?? {};
    const location = str(record(raw, "location"), "directory");
    const sessionID = str(data, "sessionID");
    if (sessionID && location) this.session(sessionID).directory = location;
    if (sessionID && this.directoryOf(sessionID) === null && this.options.lookupSession) {
      try {
        const found = await this.options.lookupSession(sessionID);
        const info = v1Session(found, { version: this.options.version });
        if (info) this.noteSession(sessionID, { directory: String(info.directory || "") || null, parentID: str(info, "parentID") });
      } catch {
        // An unknown session stays unscoped; its events reach every subscriber.
      }
    }
    switch (type) {
      case "server.connected":
        return [{ directory: null, event: { type: "server.connected", properties: {} } }];
      case "session.created": {
        if (!sessionID) return [];
        const info = v1Session({ ...data, id: sessionID, time: { created: num(raw, "created") ?? this.now(), updated: num(raw, "created") ?? this.now() } }, { version: this.options.version });
        if (!info) return [];
        this.noteSession(sessionID, { directory: String(info.directory || "") || null, parentID: str(info, "parentID"), agent: str(data, "agent"), model: modelRef(data.model), info });
        return [this.scoped(sessionID, "session.created", { sessionID, info })];
      }
      case "session.renamed":
      case "session.metadata.updated":
      case "session.moved": {
        if (!sessionID) return [];
        let info: JsonRecord | null = null;
        if (this.options.lookupSession) {
          try {
            info = v1Session(await this.options.lookupSession(sessionID), { version: this.options.version });
          } catch {
            info = null;
          }
        }
        if (!info) {
          const known = this.session(sessionID).info;
          if (!known) return [];
          info = { ...known, ...(typeof data.title === "string" ? { title: data.title } : {}), time: { ...(record(known, "time") ?? {}), updated: this.now() } };
        }
        this.noteSession(sessionID, { info, directory: String(info.directory || "") || null });
        return [this.scoped(sessionID, "session.updated", { sessionID, info })];
      }
      case "session.revert.staged":
      case "session.revert.cleared":
      case "session.revert.committed": {
        // 2.x stages a revert (files restored, later messages kept), clears it
        // (files back) or commits it (the later messages are deleted, which a
        // prompt does first). 1.x showed the same through session.revert.
        if (!sessionID) return [];
        const state = this.session(sessionID);
        const out: ScopedV1Event[] = [];
        let revert: JsonRecord | undefined;
        if (type === "session.revert.staged") {
          const staged = record(data, "revert");
          const boundary = str(staged, "messageID");
          if (boundary) {
            revert = omitUndefined({ messageID: boundary, partID: str(staged, "partID"), snapshot: str(staged, "snapshot") });
            const ids = this.options.messageIDs ? await this.options.messageIDs(sessionID).catch(() => []) : [];
            const index = ids.indexOf(boundary);
            state.reverted = index >= 0 ? ids.slice(index) : [boundary];
          }
        } else if (type === "session.revert.committed") {
          const boundary = str(data, "to");
          const removed = state.reverted ?? (boundary ? [boundary] : []);
          for (const messageID of removed) out.push(this.scoped(sessionID, "message.removed", { sessionID, messageID }));
          state.reverted = undefined;
        } else {
          state.reverted = undefined;
        }
        const info = await this.currentInfo(sessionID);
        if (info) {
          const next = { ...info, time: { ...(record(info, "time") ?? {}), updated: num(raw, "created") ?? this.now() } } as JsonRecord;
          if (revert) next.revert = revert;
          else delete next.revert;
          this.noteSession(sessionID, { info: next });
          out.push(this.scoped(sessionID, "session.updated", { sessionID, info: next }));
        }
        return out;
      }
      case "session.deleted": {
        if (!sessionID) return [];
        const info = this.session(sessionID).info ?? { id: sessionID };
        const out = [this.scoped(sessionID, "session.deleted", { sessionID, info })];
        this.sessions.delete(sessionID);
        this.forgetChildSessionsOf(sessionID);
        return out;
      }
      case "session.agent.selected": {
        if (sessionID && typeof data.agent === "string") this.session(sessionID).agent = data.agent;
        return [];
      }
      case "session.model.selected": {
        if (sessionID) this.session(sessionID).model = modelRef(data.model) ?? this.session(sessionID).model;
        return [];
      }
      case "session.inbox.enqueued": {
        if (!sessionID) return [];
        const item = record(data, "item");
        if (str(item, "type") !== "user") return [];
        const payload = record(item, "payload") ?? {};
        const id = str(data, "inboxID") ?? str(payload, "id");
        if (!id) return [];
        const state = this.session(sessionID);
        state.lastUserID = id;
        const created = num(raw, "created") ?? this.now();
        const info = omitUndefined({
          id,
          sessionID,
          role: "user",
          time: { created },
          agent: state.agent ?? "build",
          model: state.model ? omitUndefined({ providerID: state.model.providerID, modelID: state.model.modelID, variant: state.model.variant }) : { providerID: "", modelID: "" },
        });
        const out: ScopedV1Event[] = [this.scoped(sessionID, "message.updated", { sessionID, info })];
        const text = str(payload, "text") ?? "";
        const files = arr(payload, "files");
        if (text || files.length === 0) {
          const layout = record(record(payload, "metadata"), "omnirush")?.textParts;
          for (const part of v1UserTextParts({ messageID: id, sessionID }, text, layout, false)) {
            out.push(this.scoped(sessionID, "message.part.updated", { sessionID, part, time: created }));
          }
        }
        files.forEach((file, index) => {
          const url = promptFileUrl(file);
          if (!isRecord(file) || !url) return;
          out.push(this.scoped(sessionID, "message.part.updated", {
            sessionID,
            part: omitUndefined({ id: partId(id, `f${index}`), sessionID, messageID: id, type: "file", mime: str(file, "mime") ?? "application/octet-stream", filename: str(file, "name"), url }),
            time: created,
          }));
        });
        return out;
      }
      case "session.inbox.cancelled": {
        const id = str(data, "inboxID");
        if (!sessionID || !id) return [];
        return [this.scoped(sessionID, "message.removed", { sessionID, messageID: id })];
      }
      case "session.execution.started": {
        if (!sessionID) return [];
        const state = this.session(sessionID);
        state.status = { type: "busy" };
        return [this.scoped(sessionID, "session.status", { sessionID, status: { type: "busy" } })];
      }
      case "session.retry.scheduled": {
        if (!sessionID) return [];
        const state = this.session(sessionID);
        const error = record(data, "error");
        state.status = omitUndefined({
          type: "retry",
          attempt: num(data, "attempt") ?? 1,
          message: str(error, "message") ?? str(data, "message") ?? "Retrying",
          next: num(data, "at") ?? num(data, "next") ?? this.now(),
        });
        return [this.scoped(sessionID, "session.status", { sessionID, status: state.status })];
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        if (!sessionID) return [];
        const out: ScopedV1Event[] = [];
        for (const [id, live] of this.live) {
          if (live.sessionID !== sessionID) continue;
          const time = record(live.message, "time") ?? {};
          if (num(time, "completed") === undefined) {
            live.message.time = { ...time, completed: this.now() };
            if (type === "session.execution.interrupted" && !live.message.error) live.message.error = { type: "aborted", message: "The operation was aborted." };
            out.push(...this.assistantEvents(live, null, true));
          }
          this.live.delete(id);
        }
        if (type === "session.execution.failed") {
          const error = v1Error(record(data, "error"), this.session(sessionID).model?.providerID);
          if (error) out.push(this.scoped(sessionID, "session.error", { sessionID, error }));
        }
        this.session(sessionID).status = { type: "idle" };
        out.push(this.scoped(sessionID, "session.status", { sessionID, status: { type: "idle" } }));
        out.push(this.scoped(sessionID, "session.idle", { sessionID }));
        return out;
      }
      case "session.step.started": {
        if (!sessionID) return [];
        const id = str(data, "assistantMessageID");
        if (!id) return [];
        const state = this.session(sessionID);
        const agent = str(data, "agent") ?? state.agent;
        const model = modelRef(data.model) ?? state.model;
        if (agent) state.agent = agent;
        if (model) state.model = { ...model, ...(state.model?.variant && !model.variant ? { variant: state.model.variant } : {}) };
        const live: LiveAssistant = {
          sessionID,
          parentID: state.lastUserID,
          raw: new Map(),
          message: omitUndefined({
            id,
            type: "assistant",
            snapshot: str(data, "snapshot") ? { start: str(data, "snapshot") } : undefined,
            agent,
            model: model ? { id: model.modelID, providerID: model.providerID, variant: state.model?.variant } : undefined,
            content: [],
            time: { created: num(data, "started") ?? num(raw, "created") ?? this.now() },
          }),
        };
        this.live.set(id, live);
        if (state.status.type !== "busy") state.status = { type: "busy" };
        return this.assistantEvents(live, null, true);
      }
      case "session.step.ended": {
        const live = this.liveFor(data);
        if (!live) return [];
        live.message.finish = str(data, "finish") ?? "stop";
        live.message.cost = num(data, "cost") ?? 0;
        live.message.tokens = record(data, "tokens") ?? live.message.tokens;
        const snapshot = str(data, "snapshot");
        const files = arr(data, "files").filter((file) => typeof file === "string");
        const previous = record(live.message, "snapshot") ?? {};
        if (snapshot || files.length) live.message.snapshot = omitUndefined({ ...previous, end: snapshot ?? str(previous, "end"), files: files.length ? files : undefined });
        live.message.time = { ...(record(live.message, "time") ?? {}), completed: num(raw, "created") ?? this.now() };
        this.live.delete(str(live.message, "id") ?? "");
        const out = this.assistantEvents(live, partId(String(live.message.id), "f0"), false);
        out.push(...this.assistantEvents(live, partId(String(live.message.id), "p0"), false));
        out.push(...this.assistantEvents(live, "", true).filter((item) => item.event.type === "message.updated"));
        return out;
      }
      case "session.step.failed": {
        const live = this.liveFor(data);
        if (!live) return [];
        live.message.error = record(data, "error") ?? { type: "unknown", message: "Step failed" };
        live.message.time = { ...(record(live.message, "time") ?? {}), completed: num(raw, "created") ?? this.now() };
        this.live.delete(str(live.message, "id") ?? "");
        return this.assistantEvents(live, "", true).filter((item) => item.event.type === "message.updated");
      }
      case "session.text.started":
      case "session.reasoning.started":
      case "session.next.text.started":
      case "session.next.reasoning.started": {
        const live = this.liveFor(data);
        if (!live) return [];
        const kind = type.includes("reasoning") ? "reasoning" : "text";
        const ordinal = num(data, "ordinal") ?? 0;
        const entry = this.contentEntry(live, kind, ordinal);
        entry.time = { created: num(raw, "created") ?? this.now() };
        if (isRecord(data.state)) entry.state = data.state;
        return this.assistantEvents(live, partId(String(live.message.id), `${kind === "text" ? "t" : "r"}${ordinal}`), false);
      }
      case "session.text.delta":
      case "session.reasoning.delta":
      case "session.next.text.delta":
      case "session.next.reasoning.delta": {
        const live = this.liveFor(data);
        if (!live) return [];
        const kind = type.includes("reasoning") ? "reasoning" : "text";
        const ordinal = num(data, "ordinal") ?? 0;
        const delta = str(data, "delta") ?? "";
        const entry = this.contentEntry(live, kind, ordinal);
        entry.text = `${typeof entry.text === "string" ? entry.text : ""}${delta}`;
        const messageID = String(live.message.id);
        return [this.scoped(live.sessionID, "message.part.delta", {
          sessionID: live.sessionID,
          messageID,
          partID: partId(messageID, `${kind === "text" ? "t" : "r"}${ordinal}`),
          field: "text",
          delta,
        })];
      }
      case "session.text.ended":
      case "session.reasoning.ended":
      case "session.next.text.ended":
      case "session.next.reasoning.ended": {
        const live = this.liveFor(data);
        if (!live) return [];
        const kind = type.includes("reasoning") ? "reasoning" : "text";
        const ordinal = num(data, "ordinal") ?? 0;
        const entry = this.contentEntry(live, kind, ordinal);
        if (typeof data.text === "string") entry.text = data.text;
        if (isRecord(data.state)) entry.state = data.state;
        entry.time = { ...(record(entry, "time") ?? {}), completed: num(raw, "created") ?? this.now() };
        return this.assistantEvents(live, partId(String(live.message.id), `${kind === "text" ? "t" : "r"}${ordinal}`), false);
      }
      case "session.tool.input.started": {
        const live = this.liveFor(data);
        const callID = str(data, "id");
        if (!live || !callID) return [];
        this.toolEntry(live, callID, str(data, "name"));
        return this.assistantEvents(live, partId(String(live.message.id), "c", callID), false);
      }
      case "session.tool.input.delta": {
        const live = this.liveFor(data);
        const callID = str(data, "id");
        if (!live || !callID) return [];
        const raw = `${live.raw.get(callID) ?? ""}${str(data, "delta") ?? ""}`;
        live.raw.set(callID, raw);
        const entry = this.toolEntry(live, callID);
        entry.state = { status: "streaming", input: raw };
        return this.assistantEvents(live, partId(String(live.message.id), "c", callID), false);
      }
      case "session.tool.input.ended": {
        const live = this.liveFor(data);
        const callID = str(data, "id");
        if (!live || !callID) return [];
        const entry = this.toolEntry(live, callID);
        entry.state = { status: "streaming", input: str(data, "text") ?? live.raw.get(callID) ?? "" };
        return this.assistantEvents(live, partId(String(live.message.id), "c", callID), false);
      }
      case "session.tool.called": {
        const live = this.liveFor(data);
        const callID = str(data, "id");
        if (!live || !callID) return [];
        const entry = this.toolEntry(live, callID, str(data, "name"));
        entry.state = { status: "running", input: data.input ?? {}, metadata: {} };
        if (isRecord(data.providerState)) entry.providerState = data.providerState;
        entry.time = { ...(record(entry, "time") ?? {}), ran: num(raw, "created") ?? this.now() };
        return this.assistantEvents(live, partId(String(live.message.id), "c", callID), false);
      }
      case "session.tool.progress": {
        const callID = str(data, "id");
        // Remembered even without a live message: a later read of the session fills it in.
        if (sessionID && callID) this.noteChildSession(sessionID, callID, data.metadata);
        const live = this.liveFor(data);
        if (!live || !callID) return [];
        const entry = this.toolEntry(live, callID);
        const state = record(entry, "state") ?? {};
        entry.state = { ...state, status: "running", metadata: { ...(record(state, "metadata") ?? {}), ...(record(data, "metadata") ?? {}) } };
        return this.assistantEvents(live, partId(String(live.message.id), "c", callID), false);
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const callID = str(data, "id");
        if (sessionID && callID) this.settleChildSession(sessionID, callID, data.metadata);
        const live = this.liveFor(data);
        if (!live || !callID) return [];
        const entry = this.toolEntry(live, callID);
        const state = record(entry, "state") ?? {};
        entry.time = { ...(record(entry, "time") ?? {}), completed: num(raw, "created") ?? this.now() };
        entry.state = type === "session.tool.success"
          ? omitUndefined({ status: "completed", input: state.input ?? {}, content: data.content ?? [], metadata: record(data, "metadata") ?? record(state, "metadata") })
          : omitUndefined({ status: "error", input: state.input ?? {}, error: data.error ?? "Tool failed", content: data.content, metadata: record(data, "metadata") ?? record(state, "metadata") });
        return this.assistantEvents(live, partId(String(live.message.id), "c", callID), false);
      }
      case "session.compaction.ended":
        return sessionID ? [this.scoped(sessionID, "session.compacted", { sessionID })] : [];
      case "permission.asked": {
        const request = v1PermissionRequest(data);
        if (!request) return [];
        return [this.scoped(String(request.sessionID), "permission.asked", request)];
      }
      case "permission.replied": {
        const requestID = str(data, "requestID") ?? str(data, "id");
        if (!sessionID || !requestID) return [];
        return [this.scoped(sessionID, "permission.replied", { sessionID, requestID, reply: str(data, "reply") ?? str(data, "decision") ?? "once" })];
      }
      case "form.created": {
        const form = record(data, "form") ?? data;
        const mapping = v1QuestionRequest(form);
        if (!mapping) return [];
        this.questions.set(String(mapping.request.id), mapping);
        return [this.scoped(String(mapping.request.sessionID), "question.asked", mapping.request)];
      }
      case "form.replied": {
        const requestID = str(data, "id") ?? str(data, "formID");
        if (!sessionID || !requestID) return [];
        const mapping = this.questions.get(requestID);
        const answer = record(data, "answer") ?? {};
        const answers = mapping
          ? mapping.fields.map((field) => {
              const value = answer[field.key];
              const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
              return values.map((item) => field.options.find((option) => option.value === item)?.label ?? String(item));
            })
          : [];
        this.questions.delete(requestID);
        return [this.scoped(sessionID, "question.replied", { sessionID, requestID, answers })];
      }
      case "form.cancelled": {
        const requestID = str(data, "id") ?? str(data, "formID");
        if (!sessionID || !requestID) return [];
        this.questions.delete(requestID);
        return [this.scoped(sessionID, "question.rejected", { sessionID, requestID })];
      }
      case "mcp.status.changed":
        return [{ directory: location ?? null, event: { type: "mcp.tools.changed", properties: { server: str(data, "server") ?? str(data, "name") ?? "" } } }];
      default:
        return [];
    }
  }
}

export function v1EventEnvelope(event: V1Event): JsonRecord {
  return { id: eventId(), type: event.type, properties: event.properties };
}
