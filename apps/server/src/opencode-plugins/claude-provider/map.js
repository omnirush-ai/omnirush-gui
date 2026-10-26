// Claude Code's stream-json lines -> AI SDK LanguageModelV3 stream parts, for the
// engine's session loop (assets/claude-provider/index.js). Pure: no I/O.
// Shared by omnirush-cli and omnirush-gui (PARITY.sha256).
//
// - Text and thinking stream live from `stream_event` deltas; a message that
//   came without them (no partial messages) is sent whole from `assistant`.
// - Claude's tools ran inside Claude Code: `tool-call` / `tool-result` with
//   providerExecuted, named and shaped as the 2.0.32 engine's own tools so
//   its cards render them (Bash -> shell, Task/Agent -> subagent, file_path
//   -> path, old_string -> oldString, ...). Any other tool keeps its name.
// - Sub-agent events (parent_tool_use_id) are folded: the parent's tool
//   result carries what the sub-agent answered.
// - Every failure is an APICallError with status 400 and
//   `x-should-retry: false`: the engine never sends the turn again (a
//   status-less error is retried, and the turn would run twice).

export const NOTE_COMPACTED = "Claude compacted the conversation.";
/** A template heading of the engine's compaction summary: without one the engine asks again (and Claude would compact twice). */
export const COMPACTION_HEADING = "## Important Context";

const ERROR_MARK = Symbol.for("vercel.ai.error");
const API_ERROR_MARK = Symbol.for("vercel.ai.error.AI_APICallError");

/** An AI SDK APICallError the engine never retries (AI SDK isInstance reads only the marker symbols). */
export function apiError(message, { url = "omnirush-claude://turn", statusCode = 400 } = {}) {
  const error = new Error(String(message || "Claude Code failed").slice(0, 2000));
  error.name = "AI_APICallError";
  error[ERROR_MARK] = true;
  error[API_ERROR_MARK] = true;
  return Object.assign(error, { url, statusCode, requestBodyValues: {}, responseHeaders: { "x-should-retry": "false" }, responseBody: undefined, data: undefined, isRetryable: false });
}

const pick = (input, map) => {
  const out = {};
  for (const [from, to] of Object.entries(map)) if (input[from] !== undefined) out[to] = input[from];
  return out;
};

const TOOLS = {
  Bash: ["shell", { command: "command", description: "description", timeout: "timeout" }],
  Read: ["read", { file_path: "path", offset: "offset", limit: "limit" }],
  Edit: ["edit", { file_path: "path", old_string: "oldString", new_string: "newString", replace_all: "replaceAll" }],
  Write: ["write", { file_path: "path", content: "content" }],
  Grep: ["grep", { pattern: "pattern", path: "path", glob: "include" }],
  Glob: ["glob", { pattern: "pattern", path: "path" }],
  WebFetch: ["webfetch", { url: "url", prompt: "prompt" }],
  WebSearch: ["websearch", { query: "query" }],
  Task: ["subagent", { description: "description", prompt: "prompt", subagent_type: "agent" }],
  Agent: ["subagent", { description: "description", prompt: "prompt", subagent_type: "agent" }],
};

/** { toolName, input } in the engine's names; an unknown tool as Claude named it. */
export function engineTool(name, input) {
  const known = TOOLS[name];
  const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return known ? { toolName: known[0], input: pick(args, known[1]) } : { toolName: String(name || "tool"), input: args };
}

/** A tool_result's content as the plain string the engine stores. */
export function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((item) => (item?.type === "text" ? item.text : item?.type === "image" ? "[image]" : JSON.stringify(item))).join("\n");
}

/** The V3 usage of a turn: input = the last call's context (what the next call carries), output = the turn's. */
export function turnUsage(last = {}, result = {}) {
  const noCache = Number(last.input_tokens) || 0;
  const cacheRead = Number(last.cache_read_input_tokens) || 0;
  const cacheWrite = Number(last.cache_creation_input_tokens) || 0;
  const output = Number(result.output_tokens ?? last.output_tokens) || 0;
  return { inputTokens: { total: noCache + cacheRead + cacheWrite, noCache, cacheRead, cacheWrite }, outputTokens: { total: output, text: undefined, reasoning: undefined } };
}

/** Why a result line failed, in Claude's own words when it gave some. */
function failure(result) {
  const errors = Array.isArray(result.errors) ? result.errors.filter((e) => typeof e === "string") : [];
  const text = typeof result.result === "string" && result.result.trim() ? result.result.trim() : errors.join("; ");
  return text || `Claude Code stopped (${result.subtype || "error"}).`;
}

export class ClaudeStreamMapper {
  /** `compaction`: the turn is the engine's compaction, run as Claude's /compact; its summary is the turn's text. */
  constructor({ compaction = false } = {}) {
    this.compaction = compaction;
    this.summary = null;
    this.message = null;
    this.blocks = new Map();
    this.streamed = new Set();
    this.tools = new Map();
    this.usage = {};
    this.result = null;
    this.notes = 0;
  }

  /** The parts for one parsed stream-json line. */
  push(event) {
    if (!event || typeof event !== "object" || event.parent_tool_use_id) return [];
    if (event.type === "stream_event") return this.streamEvent(event.event ?? {});
    if (event.type === "assistant") return this.assistant(event.message ?? {});
    if (event.type === "user") return this.compaction ? this.compacted(event.message ?? {}) : this.user(event.message ?? {});
    if (event.type === "system" && event.subtype === "compact_boundary") return this.compaction ? [] : this.note(NOTE_COMPACTED);
    if (event.type === "system" && event.subtype === "status" && typeof event.compact_error === "string") this.compactError = event.compact_error;
    if (event.type === "result") this.result = event;
    return [];
  }

  /** /compact's summary (the synthetic user message after the boundary) as the engine's summary text. */
  compacted(message) {
    const content = typeof message.content === "string" ? message.content : "";
    if (this.summary !== null || !content || content.startsWith("<local-command")) return [];
    const at = content.indexOf("Summary:");
    const summary = at >= 0 ? content.slice(at + "Summary:".length) : content;
    // What follows the summary is Claude's own note to itself (where the transcript is, carry on).
    const tail = summary.search(/\n\s*If you need specific details from before compaction/);
    this.summary = (tail >= 0 ? summary.slice(0, tail) : summary).trim();
    return this.note(`${COMPACTION_HEADING}\n${NOTE_COMPACTED} Its summary:\n\n${this.summary}\n`);
  }

  note(text) {
    const id = `note-${++this.notes}`;
    return [{ type: "text-start", id }, { type: "text-delta", id, delta: text }, { type: "text-end", id }];
  }

  streamEvent(e) {
    if (e.type === "message_start") {
      this.message = e.message?.id ?? `msg-${this.streamed.size}`;
      this.streamed.add(this.message);
      this.blocks.clear();
      this.usage = { ...(e.message?.usage ?? {}) };
      return [];
    }
    if (e.type === "message_delta") {
      if (e.usage) this.usage = { ...this.usage, ...e.usage };
      return [];
    }
    const id = `${this.message}:${e.index}`;
    if (e.type === "content_block_start") {
      const kind = e.content_block?.type === "text" ? "text" : e.content_block?.type === "thinking" ? "reasoning" : null;
      if (!kind) return [];
      this.blocks.set(e.index, kind);
      const first = kind === "text" ? e.content_block.text : e.content_block.thinking;
      return [{ type: `${kind}-start`, id }, ...(first ? [{ type: `${kind}-delta`, id, delta: first }] : [])];
    }
    const kind = this.blocks.get(e.index);
    if (!kind) return [];
    if (e.type === "content_block_delta") {
      const delta = kind === "text" ? (e.delta?.type === "text_delta" ? e.delta.text : null) : e.delta?.type === "thinking_delta" ? e.delta.thinking : null;
      return delta ? [{ type: `${kind}-delta`, id, delta }] : [];
    }
    if (e.type === "content_block_stop") {
      this.blocks.delete(e.index);
      return [{ type: `${kind}-end`, id }];
    }
    return [];
  }

  assistant(message) {
    const parts = [];
    // Claude Code's own error line ("API Error: ...") repeats what the turn's error part says.
    const whole = !this.streamed.has(message.id) && message.model !== "<synthetic>";
    (Array.isArray(message.content) ? message.content : []).forEach((block, index) => {
      if (block?.type === "tool_use") {
        const call = engineTool(block.name, block.input);
        this.tools.set(block.id, call.toolName);
        parts.push({ type: "tool-call", toolCallId: block.id, toolName: call.toolName, input: JSON.stringify(call.input), providerExecuted: true });
        return;
      }
      if (!whole) return;
      const id = `${message.id ?? "msg"}:${index}`;
      if (block?.type === "text" && block.text) parts.push({ type: "text-start", id }, { type: "text-delta", id, delta: block.text }, { type: "text-end", id });
      if (block?.type === "thinking" && block.thinking) parts.push({ type: "reasoning-start", id }, { type: "reasoning-delta", id, delta: block.thinking }, { type: "reasoning-end", id });
    });
    if (whole && message.usage) this.usage = { ...message.usage };
    return parts;
  }

  user(message) {
    if (!Array.isArray(message.content)) return [];
    return message.content.filter((block) => block?.type === "tool_result" && this.tools.has(block.tool_use_id)).map((block) => ({
      type: "tool-result", toolCallId: block.tool_use_id, toolName: this.tools.get(block.tool_use_id), result: resultText(block.content),
      ...(block.is_error ? { isError: true } : {}), providerExecuted: true,
    }));
  }

  /** The end parts of blocks a cut stream left open. */
  close() {
    const parts = [...this.blocks.entries()].map(([index, kind]) => ({ type: `${kind}-end`, id: `${this.message}:${index}` }));
    this.blocks.clear();
    return parts;
  }

  /** The turn's last part: finish, or the error that ended it (no result line: Claude Code stopped). */
  finish(why = "Claude Code stopped before the turn finished.") {
    const result = this.result;
    if (!result) return { type: "error", error: apiError(why) };
    if (result.is_error || result.subtype !== "success") return { type: "error", error: apiError(failure(result)) };
    if (this.compaction && this.summary === null) return { type: "error", error: apiError(`Claude could not compact the conversation${this.compactError ? `: ${this.compactError}` : "."}`) };
    return { type: "finish", finishReason: { unified: "stop", raw: result.stop_reason ?? "end_turn" }, usage: turnUsage(this.usage, result.usage ?? {}) };
  }
}

/** The last user message of a V3 prompt as Claude Code input content: text, images (base64); other files by path or name. */
export function lastUserContent(prompt) {
  const message = (Array.isArray(prompt) ? prompt : []).filter((m) => m?.role === "user").at(-1);
  const out = [];
  for (const part of Array.isArray(message?.content) ? message.content : []) {
    if (part?.type === "text" && part.text) out.push({ type: "text", text: part.text });
    else if (part?.type === "file" && /^image\//.test(part.mediaType || "") && (typeof part.data === "string" || part.data instanceof Uint8Array)) {
      const data = typeof part.data === "string" ? part.data.replace(/^data:[^,]*,/, "") : Buffer.from(part.data).toString("base64");
      out.push({ type: "image", source: { type: "base64", media_type: part.mediaType, data } });
    } else if (part?.type === "file") out.push({ type: "text", text: `[attached file: ${part.filename || (part.data instanceof URL ? part.data.href : "unnamed")}]` });
  }
  return out;
}
