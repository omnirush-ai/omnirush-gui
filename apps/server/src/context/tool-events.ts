// The engine's tool-call events for capture context (#20): every tool part
// of a session as it starts running and as it ends, from the opencode event
// stream (v1 `/event` `message.part.updated`; v2 `/api/event`
// `session.tool.*`). A shell call's start reaches ContextCapture.toolEvent
// before its process is spawned, so the network observer can sample it from
// its first milliseconds. A 2.x event is timed by its envelope's `created`;
// only `session.tool.input.started` names the tool, so a later event of the
// call (called, success, failed) gets its name from that one
// (watchToolEvents). Identical in the CLI and the desktop app.

import { sseFrames } from "../session-archive/tool-start.js";
import type { ToolEvent } from "./index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** A session the engine created or updated, with its parent (sub-agents' sessions), or null when `payload` is not one. */
export function sessionInfoOf(payload: unknown): { id: string; parentId: string | null } | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.payload) && typeof payload.payload.type === "string") return sessionInfoOf(payload.payload);
  if (payload.type !== "session.created" && payload.type !== "session.updated") return null;
  const properties = isRecord(payload.properties) ? payload.properties : null;
  const info = properties && isRecord(properties.info) ? properties.info : null;
  const id = info ? text(info.id) : null;
  return id ? { id, parentId: text(info!.parentID) } : null;
}

/** A tool start or end of one session, or null when `payload` is not one. */
export function toolEventOf(payload: unknown): { sessionId: string; event: ToolEvent } | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.payload) && typeof payload.payload.type === "string") return toolEventOf(payload.payload);
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type === "message.part.updated") {
    const properties = isRecord(payload.properties) ? payload.properties : null;
    const part = properties && isRecord(properties.part) ? properties.part : null;
    if (!part || part.type !== "tool") return null;
    const state = isRecord(part.state) ? part.state : {};
    const status = state.status === "running" || state.status === "pending" ? "running" : state.status === "completed" ? "completed" : state.status === "error" ? "error" : null;
    const sessionId = text(part.sessionID);
    const callId = text(part.callID) ?? text(part.id);
    const tool = text(part.tool);
    if (!status || !sessionId || !callId || !tool) return null;
    const input = isRecord(state.input) ? state.input : {};
    const time = isRecord(state.time) ? state.time : {};
    const at = status === "running" ? (typeof time.start === "number" ? time.start : undefined) : typeof time.end === "number" ? time.end : undefined;
    return { sessionId, event: { callId, tool, status, command: text(input.command), workdir: text(input.workdir) ?? text(input.cwd), ...(at !== undefined ? { at } : {}) } };
  }
  const v2 = /^session\.(?:next\.)?tool\.(input\.started|called|success|completed|failed|error|result)$/.exec(type);
  if (v2) {
    const data = isRecord(payload.data) ? payload.data : isRecord(payload.properties) ? payload.properties : null;
    if (!data) return null;
    const sessionId = text(data.sessionID);
    const callId = text(data.callID) ?? text(data.toolCallID) ?? text(data.id);
    // "": not named in this event (watchToolEvents fills it in from the call's input.started).
    const tool = text(data.tool) ?? text(data.name) ?? "";
    if (!sessionId || !callId) return null;
    const input = isRecord(data.input) ? data.input : {};
    const status = v2[1] === "input.started" || v2[1] === "called" ? "running" : v2[1] === "success" || v2[1] === "completed" || v2[1] === "result" ? "completed" : "error";
    const at = typeof payload.created === "number" ? payload.created : undefined;
    return { sessionId, event: { callId, tool, status, command: text(input.command), workdir: text(input.workdir) ?? text(input.cwd), ...(at !== undefined ? { at } : {}) } };
  }
  return null;
}

export type ToolEventFetch = (url: string, init: { headers: Headers; signal: AbortSignal }) => Promise<Response>;

const MAX_FRAME_CHARS = 4 * 1024 * 1024;
/** Sessions followed at most per stream (the root and its sub-agents). */
const MAX_FAMILY = 512;
/** Running calls whose tool name is kept for their later events. */
const MAX_NAMED_CALLS = 4096;

/**
 * Follows the event stream until `signal` aborts, handing each tool event of
 * `sessionId` and of the sub-agent sessions it starts (their parent chain
 * leads to it; `known`: ones started before) to `onEvent`. Never throws.
 */
export async function watchToolEvents(input: {
  url: string;
  headers: Headers;
  sessionId: string;
  signal: AbortSignal;
  fetch: ToolEventFetch;
  onEvent: (event: ToolEvent) => void;
  /** Sub-agent sessions of `sessionId` started before the stream was followed. */
  known?: Iterable<string>;
}): Promise<void> {
  if (input.signal.aborted) return;
  const family = new Set([input.sessionId, ...(input.known ?? [])]);
  const names = new Map<string, string>();
  try {
    const headers = new Headers(input.headers);
    headers.set("accept", "text/event-stream");
    const response = await input.fetch(input.url, { headers, signal: input.signal });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const { payloads, rest } = sseFrames(buffer);
      buffer = rest.length > MAX_FRAME_CHARS ? "" : rest;
      for (const raw of payloads) {
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          continue;
        }
        const session = sessionInfoOf(payload);
        if (session?.parentId && family.has(session.parentId) && family.size < MAX_FAMILY) family.add(session.id);
        const found = toolEventOf(payload);
        if (found && family.has(found.sessionId)) {
          const { callId } = found.event;
          const tool = found.event.tool || names.get(callId);
          if (found.event.status !== "running") names.delete(callId);
          else if (found.event.tool && names.size < MAX_NAMED_CALLS) names.set(callId, found.event.tool);
          if (!tool) continue;
          try {
            input.onEvent({ ...found.event, tool });
          } catch {
            // Capture never stops the stream.
          }
        }
      }
    }
  } catch {
    // Aborted, or the engine went away.
  }
}
