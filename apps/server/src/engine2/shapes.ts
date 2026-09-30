/**
 * The 2.x engine's records in the 1.x shapes the app, the session uploader and the
 * uploaded traces are written against.
 *
 * OmniRush.ai bundles the opencode 2.x engine but keeps talking the 1.x
 * dialect everywhere above the engine: the renderer's SDK client, the
 * server's own engine reads, the turn observer and the trace upload
 * ("omnirush.trace.v1", shared with the CLI and read by the admin
 * converter). This module is the single place where a 2.x session,
 * message, tool call, permission, question, agent, command or catalog entry
 * becomes its 1.x counterpart, field for field:
 *
 *   - a 2.x `user` message becomes `{info:{role:"user", agent, model}, parts:[text, file…]}`;
 *   - a 2.x `assistant` message (one model step) becomes `{info:{role:"assistant", parentID,
 *     modelID, providerID, mode, agent, path, cost, tokens{total,…}, finish}, parts:[step-start,
 *     reasoning/text/tool…, step-finish]}`;
 *   - 2.x tool names and inputs take their 1.x names (`shell`→`bash`, `subagent`→`task`,
 *     `path`→`filePath`, `agent`→`subagent_type`, `patch`→`apply_patch`), results become
 *     `output`/`title`/`metadata` with the 1.x metadata keys (`sessionId`, `filediff`, …);
 *   - context-only records (system, instruction, agent/model switches, idle markers) are left out,
 *     as the 1.x engine never listed them.
 *
 * Part ids are derived from the message id and the part's place (`prt_<msg>_r0`, `_t1`,
 * `_c<callID>`, …) so a part read from a message list and the same part built from live events
 * (engine2/events.ts) agree.
 */
import { withNativeFields } from "./native.js";
import { arr, isRecord, num, omitUndefined, promptFileUrl, record, str, unwrap, type JsonRecord } from "./util.js";

export type V1Message = { info: JsonRecord; parts: JsonRecord[] };

/** The prefix the 2.x subagent tool puts before a child session's task (core/src/tool/plugin/subagent.ts). */
export const SUBAGENT_PROMPT_PREFIX = "You are a subagent spawned by another session.\n";

const TOOL_NAMES_V1: Record<string, string> = {
  shell: "bash",
  subagent: "task",
  patch: "apply_patch",
};

/** A 2.x tool name in its 1.x spelling. */
export function v1ToolName(name: string): string {
  return TOOL_NAMES_V1[name] ?? name;
}

/** A 1.x tool name in its 2.x spelling (permission actions, plugin tool filters). */
export function v2ToolName(name: string): string {
  if (name === "bash") return "shell";
  if (name === "task") return "subagent";
  if (name === "apply_patch") return "patch";
  return name;
}

function parseInput(value: unknown): JsonRecord {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value === "") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A 2.x tool input with the 1.x key names of the same tool. */
export function v1ToolInput(name: string, raw: unknown): JsonRecord {
  const input = parseInput(raw);
  switch (name) {
    case "read":
    case "write":
    case "edit": {
      if (typeof input.path !== "string" || "filePath" in input) return input;
      const { path, ...rest } = input;
      return { filePath: path, ...rest };
    }
    case "subagent": {
      // Sub-agents always run in the foreground here (the plugin bridge keeps `background` off),
      // as the 1.x task tool did; the flag is not part of the 1.x input.
      const { background: _background, ...withoutBackground } = input;
      if (typeof withoutBackground.agent !== "string" || "subagent_type" in withoutBackground) return withoutBackground;
      const { agent, ...rest } = withoutBackground;
      return { subagent_type: agent, ...rest };
    }
    default:
      return input;
  }
}

/** A 1.x tool input with the 2.x key names (used where a plugin or the swarm rewrites a call). */
export function v2ToolInput(name: string, input: JsonRecord): JsonRecord {
  switch (name) {
    case "read":
    case "write":
    case "edit": {
      if (typeof input.filePath !== "string" || "path" in input) return input;
      const { filePath, ...rest } = input;
      return { path: filePath, ...rest };
    }
    case "task": {
      if (typeof input.subagent_type !== "string" || "agent" in input) return input;
      const { subagent_type, ...rest } = input;
      return { agent: subagent_type, ...rest };
    }
    default:
      return input;
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []))
    .join("\n");
}

function relativeTo(root: string | undefined, file: string): string {
  if (!root || !file.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(file)) return file;
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  if (file === normalizedRoot) return ".";
  if (file.startsWith(`${normalizedRoot}/`) || file.startsWith(`${normalizedRoot}\\`)) return file.slice(normalizedRoot.length + 1);
  return file.replace(/^\/+/, "");
}

function absoluteFrom(directory: string | undefined, file: string): string {
  if (!directory || file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)) return file;
  const sep = directory.includes("\\") && !directory.includes("/") ? "\\" : "/";
  return `${directory.replace(/[\\/]+$/, "")}${sep}${file}`;
}

/** The 2.x subagent result `<subagent sessionID="…" state="…">…</subagent>` in the 1.x task tool's form. */
function v1TaskOutput(text: string): string {
  const match = text.match(/^<subagent sessionID="([^"]+)" state="([^"]+)">\n?([\s\S]*?)\n?<\/subagent>\s*$/);
  if (!match) return text;
  return `<task id="${match[1]}" state="${match[2]}">\n<task_result>\n${match[3]}\n</task_result>\n</task>`;
}

type ToolContext = {
  sessionID: string;
  directory?: string;
  root?: string;
  parentModel?: { providerID: string; modelID: string };
  /** The child session a sub-agent call's progress named (MessageContext.childSessionOf). */
  childSessionOf?: (callID: string) => string | undefined;
};

function v1ToolTitle(name: string, input: JsonRecord, ctx: ToolContext): string {
  switch (name) {
    case "shell":
      return typeof input.description === "string" && input.description ? input.description : String(input.command ?? "");
    case "subagent":
      return String(input.description ?? "");
    case "read":
    case "write":
    case "edit": {
      const file = typeof input.path === "string" ? input.path : typeof input.filePath === "string" ? input.filePath : "";
      return relativeTo(ctx.root ?? ctx.directory, absoluteFrom(ctx.directory, file));
    }
    case "glob":
    case "grep":
      return String(input.pattern ?? "");
    case "webfetch":
      return String(input.url ?? "");
    case "websearch":
      return String(input.query ?? "");
    case "skill":
      return String(input.id ?? input.name ?? "");
    case "todowrite": {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      return `${todos.filter((todo) => !isRecord(todo) || todo.status !== "completed").length} todos`;
    }
    default:
      return v1ToolName(name);
  }
}

/** A 2.x patch file entry (`{file, patch, status, additions, deletions}`) as the 1.x apply_patch one. */
function v1PatchFile(entry: JsonRecord, ctx: ToolContext): JsonRecord {
  const file = absoluteFrom(ctx.directory, String(entry.file ?? entry.filePath ?? ""));
  const status = str(entry, "status");
  return omitUndefined({
    filePath: file,
    relativePath: relativeTo(ctx.root && ctx.root !== "/" ? ctx.root : "/", file),
    type: status === "added" ? "add" : status === "deleted" ? "delete" : status === "moved" || status === "renamed" ? "move" : "update",
    patch: typeof entry.patch === "string" ? entry.patch : str(entry, "diff") ?? "",
    additions: typeof entry.additions === "number" ? entry.additions : 0,
    deletions: typeof entry.deletions === "number" ? entry.deletions : 0,
    movePath: str(entry, "movePath") ?? str(entry, "target"),
  });
}

/** A completed 2.x tool call's metadata with the 1.x keys the app, swarm board and converter read. */
function v1ToolMetadata(name: string, input: JsonRecord, metadata: JsonRecord, output: string, ctx: ToolContext): JsonRecord {
  switch (name) {
    case "shell": {
      const { status: _status, ...rest } = metadata;
      return { output, ...rest };
    }
    case "subagent": {
      const { sessionID, status: _status, ...rest } = metadata;
      // The model the sub-agent ran on: the call's `model` ("provider/model[#variant]"), else the caller's.
      const requested = typeof input.model === "string" ? input.model.match(/^([^/#]+)\/([^#]+)/) : null;
      const model = requested ? { modelID: requested[2]!, providerID: requested[1]! } : ctx.parentModel;
      return omitUndefined({
        parentSessionId: ctx.sessionID,
        sessionId: typeof sessionID === "string" ? sessionID : undefined,
        model: model ? { modelID: model.modelID, providerID: model.providerID } : undefined,
        ...rest,
      });
    }
    case "read": {
      const file = absoluteFrom(ctx.directory, String(input.path ?? input.filePath ?? ""));
      // 2.x prints numbered lines ("12: text"); 1.x kept the plain text as preview and display.
      const numbered = output.split("\n").map((line) => line.match(/^(\d+): ?(.*)$/)).filter((match): match is RegExpMatchArray => Boolean(match));
      if (numbered.length === 0) return { truncated: false, loaded: [], ...metadata };
      const lines = numbered.map((match) => match[2] ?? "");
      const lineStart = Number(numbered[0]![1]);
      const lineEnd = Number(numbered[numbered.length - 1]![1]);
      const truncated = metadata.truncated === true;
      const text = lines.join("\n");
      return {
        preview: lines.slice(0, 20).join("\n"),
        truncated,
        loaded: [],
        display: { type: "file", path: file, text, lineStart, lineEnd, totalLines: truncated ? lineEnd : lineEnd, truncated },
        ...metadata,
      };
    }
    case "write": {
      const file = absoluteFrom(ctx.directory, String(input.path ?? input.filePath ?? ""));
      // 2.x reports whether the file existed in its text result ("Created file…" / "Updated file…").
      const exists = typeof metadata.existed === "boolean" ? metadata.existed : !/^Created\b/i.test(output);
      const { existed: _existed, ...rest } = metadata;
      return { diagnostics: {}, filepath: file, exists, ...rest };
    }
    case "edit": {
      const files = Array.isArray(metadata.files) ? metadata.files.filter(isRecord) : [];
      const first = files[0];
      const { files: _files, ...rest } = metadata;
      if (!first) return { diagnostics: {}, ...rest };
      const file = absoluteFrom(ctx.directory, String(first.file ?? ""));
      const patch = typeof first.patch === "string" ? first.patch : "";
      return omitUndefined({
        diagnostics: {},
        diff: patch,
        filediff: omitUndefined({
          file,
          patch,
          additions: typeof first.additions === "number" ? first.additions : 0,
          deletions: typeof first.deletions === "number" ? first.deletions : 0,
        }),
        ...rest,
      });
    }
    case "patch": {
      // 1.x apply_patch: one combined diff and a file list keyed filePath / relativePath.
      const files = (Array.isArray(metadata.files) ? metadata.files.filter(isRecord) : []).map((entry) => v1PatchFile(entry, ctx));
      const { files: _files, ...rest } = metadata;
      return {
        diff: files.map((entry) => String(entry.patch ?? "")).filter(Boolean).join("\n"),
        files,
        diagnostics: {},
        ...rest,
      };
    }
    default:
      return metadata;
  }
}

function fileAttachments(content: unknown, ids: { messageID: string; sessionID: string; callID: string }): JsonRecord[] {
  if (!Array.isArray(content)) return [];
  const files: JsonRecord[] = [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== "file") continue;
    const url = str(item, "uri");
    const mime = str(item, "mime");
    if (!url || !mime) continue;
    files.push(omitUndefined({
      id: partId(ids.messageID, `a${files.length}`, ids.callID),
      sessionID: ids.sessionID,
      messageID: ids.messageID,
      type: "file",
      mime,
      filename: str(item, "name"),
      url,
    }));
  }
  return files;
}

function errorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) return str(value, "message") ?? str(value, "type") ?? JSON.stringify(value);
  return value === undefined ? "" : String(value);
}

/**
 * 2.x keeps a content entry's provider state bare (`{itemId, …}`); 1.x kept the same values as
 * part metadata under the provider's namespace (`{openai: {itemId, …}}`). The namespace follows
 * from the state's keys (OpenAI Responses item ids, Anthropic signatures, Google thought
 * signatures); the reasoning-field hint of chat-completions providers is not provider metadata.
 */
export function v1ProviderMetadata(state: unknown): JsonRecord | undefined {
  if (!isRecord(state)) return undefined;
  const { reasoningField: _reasoningField, ...rest } = state;
  if (Object.keys(rest).length === 0) return undefined;
  if ("itemId" in rest || "responseId" in rest) return { openai: rest };
  if ("signature" in rest || "redactedData" in rest) return { anthropic: rest };
  if ("thoughtSignature" in rest) return { google: rest };
  return undefined;
}

/** Part ids: `prt_<message id sans prefix>_<slot>[_<call id>]`, the same from a read and from events. */
export function partId(messageID: string, slot: string, callID?: string): string {
  const core = messageID.startsWith("msg_") ? messageID.slice(4) : messageID;
  return callID ? `prt_${core}_${slot}_${callID}` : `prt_${core}_${slot}`;
}

/** A 2.x tool content entry as a 1.x tool part (null for a shape it does not know). */
export function v1ToolPart(
  entry: JsonRecord,
  ids: { messageID: string; sessionID: string },
  ctx: ToolContext,
  messageCreated: number,
): JsonRecord | null {
  const callID = str(entry, "id") ?? str(entry, "callID");
  const name = str(entry, "name") ?? str(entry, "tool");
  const state = record(entry, "state");
  if (!callID || !name || !state) return null;
  const status = str(state, "status");
  const time = record(entry, "time");
  const created = num(time, "created") ?? messageCreated;
  const start = num(time, "ran") ?? created;
  const end = num(time, "completed") ?? start;
  const input = v1ToolInput(name, state.input);
  const rawInput = parseInput(state.input);
  const providerMetadata = v1ProviderMetadata(entry.providerState);
  const base = {
    id: partId(ids.messageID, "c", callID),
    sessionID: ids.sessionID,
    messageID: ids.messageID,
    type: "tool",
    callID,
    tool: v1ToolName(name),
    ...(providerMetadata ? { metadata: providerMetadata } : {}),
  };
  if (status === "streaming" || status === "pending") {
    return { ...base, state: { status: "pending", input, raw: typeof state.input === "string" ? state.input : JSON.stringify(state.input ?? {}) } };
  }
  const { __title: pluginTitle, ...stored } = record(state, "metadata") ?? {};
  // The engine's read of a running sub-agent call leaves out its child session (only the
  // call's progress events name it): the child the progress named, so the card can open it.
  const child = name === "subagent" && typeof stored.sessionID !== "string" ? ctx.childSessionOf?.(callID) : undefined;
  const metadata: JsonRecord = child ? { ...stored, sessionID: child } : stored;
  const title = (fallback: string) => (typeof pluginTitle === "string" && pluginTitle ? pluginTitle : fallback);
  if (status === "running") {
    const runningTitle = title(v1ToolTitle(name, rawInput, ctx));
    const running = name === "subagent" ? v1ToolMetadata(name, rawInput, metadata, "", ctx) : metadata;
    return { ...base, state: omitUndefined({ status: "running", input, title: runningTitle || undefined, metadata: running, time: { start } }) };
  }
  if (status === "completed") {
    const text = contentText(state.content);
    const output = name === "subagent" ? v1TaskOutput(text) : text;
    const attachments = fileAttachments(state.content, { ...ids, callID });
    return {
      ...base,
      state: omitUndefined({
        status: "completed",
        input,
        output,
        title: title(v1ToolTitle(name, rawInput, ctx)),
        metadata: v1ToolMetadata(name, rawInput, metadata, output, ctx),
        time: { start, end },
        attachments: attachments.length > 0 ? attachments : undefined,
      }),
    };
  }
  if (status === "error") {
    return {
      ...base,
      state: omitUndefined({
        status: "error",
        input,
        error: errorMessage(state.error),
        metadata: Object.keys(metadata).length > 0 ? v1ToolMetadata(name, rawInput, metadata, contentText(state.content), ctx) : undefined,
        time: { start, end },
      }),
    };
  }
  return null;
}

function v1Tokens(value: unknown): JsonRecord {
  const tokens = isRecord(value) ? value : {};
  const cache = record(tokens, "cache") ?? {};
  const input = num(tokens, "input") ?? 0;
  const output = num(tokens, "output") ?? 0;
  const reasoning = num(tokens, "reasoning") ?? 0;
  const read = num(cache, "read") ?? 0;
  const write = num(cache, "write") ?? 0;
  return { total: input + output + reasoning + read + write, input, output, reasoning, cache: { read, write } };
}

/** A 2.x session error `{type, message, status?}` as the 1.x named error. */
export function v1Error(value: unknown, providerID?: string): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const type = str(value, "type") ?? "unknown";
  const message = str(value, "message") ?? type;
  const status = num(value, "status");
  if (type === "aborted") return { name: "MessageAbortedError", data: { message } };
  if (type === "provider.auth") return { name: "ProviderAuthError", data: { providerID: providerID ?? "", message } };
  if (type === "provider.content-filter") return { name: "ContentFilterError", data: { message } };
  if (/context|overflow/i.test(type)) return { name: "ContextOverflowError", data: { message } };
  if (type.startsWith("provider.")) {
    return {
      name: "APIError",
      data: omitUndefined({
        message,
        statusCode: status,
        isRetryable: ["provider.rate-limit", "provider.transport", "provider.internal", "provider.timeout"].includes(type),
      }),
    };
  }
  return { name: "UnknownError", data: { message } };
}

function userFileParts(files: unknown[], ids: { messageID: string; sessionID: string }): JsonRecord[] {
  const parts: JsonRecord[] = [];
  files.forEach((file, index) => {
    if (!isRecord(file)) return;
    const url = promptFileUrl(file);
    if (!url) return;
    parts.push(omitUndefined({
      id: partId(ids.messageID, `f${index}`),
      sessionID: ids.sessionID,
      messageID: ids.messageID,
      type: "file",
      mime: str(file, "mime") ?? mimeFromUri(url, str(file, "name")),
      filename: str(file, "name"),
      url,
    }));
  });
  return parts;
}

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeFromUri(uri: string, name?: string): string {
  const data = uri.match(/^data:([^;,]+)[;,]/);
  if (data?.[1]) return data[1];
  const source = name ?? uri.split(/[?#]/)[0] ?? "";
  const ext = source.split(".").pop()?.toLowerCase() ?? "";
  if (uri.startsWith("file:") && !source.includes(".")) return "application/x-directory";
  return EXTENSION_MIME[ext] ?? "text/plain";
}

export type MessageContext = {
  sessionID: string;
  directory?: string;
  /** The project's worktree root (a git root) for `path.root`; "/" when there is none, as 1.x reported. */
  root?: string;
  /** The session's selected agent/model, for user messages that precede any assistant reply. */
  agent?: string;
  model?: { providerID: string; modelID: string; variant?: string };
  /** Whether the session is a sub-agent's (its first user message then has the 2.x task preamble). */
  child?: boolean;
  /**
   * The child session of one of this session's sub-agent calls, as its progress events named it
   * (EventTranslator.childSessionOf): a read of a running call does not carry it.
   */
  childSessionOf?: (callID: string) => string | undefined;
};

type ModelRef = { providerID: string; modelID: string; variant?: string };

function modelRef(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const providerID = str(value, "providerID");
  const modelID = str(value, "id") ?? str(value, "modelID");
  if (!providerID || !modelID) return undefined;
  // 2.x records "default" when no variant was picked; 1.x left the field out.
  const variant = str(value, "variant");
  return variant && variant !== "default" ? { providerID, modelID, variant } : { providerID, modelID };
}

/** One 2.x assistant message (one step) as a 1.x assistant message. */
export function v1AssistantMessage(message: JsonRecord, ctx: MessageContext, parentID: string, completedOverride?: boolean): V1Message {
  const id = str(message, "id") ?? "";
  const time = record(message, "time") ?? {};
  const created = num(time, "created") ?? 0;
  const completed = num(time, "completed");
  const model = modelRef(message.model) ?? ctx.model;
  const agent = str(message, "agent") ?? ctx.agent ?? "build";
  const ids = { messageID: id, sessionID: ctx.sessionID };
  const toolCtx: ToolContext = { sessionID: ctx.sessionID, directory: ctx.directory, root: ctx.root, parentModel: model, childSessionOf: ctx.childSessionOf };
  const tokens = v1Tokens(message.tokens);
  const cost = num(message, "cost") ?? 0;
  const finish = str(message, "finish");
  // 2.x keeps the step's snapshots together (`{start, end, files}`); 1.x put the start on
  // step-start, the end on step-finish, and the changed files in a `patch` part.
  const snapshots = record(message, "snapshot") ?? {};
  const snapshotStart = str(snapshots, "start") ?? str(message, "snapshot");
  const snapshotEnd = str(snapshots, "end") ?? snapshotStart;
  const changed = arr(snapshots, "files").filter((file): file is string => typeof file === "string");
  const parts: JsonRecord[] = [omitUndefined({ id: partId(id, "s0"), sessionID: ctx.sessionID, messageID: id, type: "step-start", snapshot: snapshotStart })];
  const ordinals = { text: 0, reasoning: 0 };
  for (const entry of arr(message, "content")) {
    if (!isRecord(entry)) continue;
    const type = str(entry, "type");
    if (type === "text" || type === "reasoning") {
      const ordinal = ordinals[type]++;
      const text = str(entry, "text") ?? "";
      const entryTime = record(entry, "time");
      const start = num(entryTime, "created");
      const end = num(entryTime, "completed");
      const metadata = v1ProviderMetadata(entry.state);
      if (type === "reasoning") {
        parts.push(omitUndefined({
          id: partId(id, `r${ordinal}`),
          sessionID: ctx.sessionID,
          messageID: id,
          type: "reasoning",
          text,
          metadata,
          time: omitUndefined({ start: start ?? created, end: end ?? (completed !== undefined ? completed : undefined) }),
        }));
      } else {
        parts.push(omitUndefined({
          id: partId(id, `t${ordinal}`),
          sessionID: ctx.sessionID,
          messageID: id,
          type: "text",
          text,
          time: start !== undefined || completed !== undefined ? omitUndefined({ start: start ?? created, end: end ?? completed }) : undefined,
          metadata,
        }));
      }
      continue;
    }
    if (type === "tool") {
      const part = v1ToolPart(entry, ids, toolCtx, created);
      if (part) parts.push(part);
    }
  }
  const done = completedOverride ?? completed !== undefined;
  if (done && finish !== undefined) {
    parts.push(omitUndefined({
      id: partId(id, "f0"),
      sessionID: ctx.sessionID,
      messageID: id,
      type: "step-finish",
      reason: finish,
      snapshot: snapshotEnd,
      cost,
      tokens,
    }));
    if (changed.length > 0 && snapshotStart) {
      const base = ctx.root && ctx.root !== "/" ? ctx.root : ctx.directory;
      parts.push({
        id: partId(id, "p0"),
        sessionID: ctx.sessionID,
        messageID: id,
        type: "patch",
        hash: snapshotStart,
        files: changed.map((file) => absoluteFrom(base, file)),
      });
    }
  }
  const error = v1Error(message.error, model?.providerID);
  const info = omitUndefined({
    id,
    sessionID: ctx.sessionID,
    role: "assistant",
    time: omitUndefined({ created, completed }),
    error,
    parentID,
    modelID: model?.modelID ?? "",
    providerID: model?.providerID ?? "",
    mode: agent,
    agent,
    path: { cwd: ctx.directory ?? "", root: ctx.root ?? "/" },
    cost,
    tokens,
    variant: model?.variant,
    finish,
  });
  return { info, parts };
}

/** The separator the facade joins a prompt's 1.x text parts with into the one 2.x text. */
const PROMPT_TEXT_SEPARATOR = "\n\n";

/**
 * A prompt's 1.x text parts. The facade records the layout of the text parts
 * it joined (`metadata.omnirush.textParts`: length, synthetic flag, metadata
 * per part); when the stored text still matches that layout it is split back,
 * so a synthetic note stays its own synthetic part. Otherwise one text part.
 */
export function v1UserTextParts(
  ids: { messageID: string; sessionID: string },
  text: string,
  layout: unknown,
  synthetic: boolean,
): JsonRecord[] {
  const base = { sessionID: ids.sessionID, messageID: ids.messageID, type: "text" };
  const single = [omitUndefined({ id: partId(ids.messageID, "u0"), ...base, text, synthetic: synthetic || undefined })];
  if (!Array.isArray(layout) || layout.length === 0) return single;
  const parts: JsonRecord[] = [];
  let offset = 0;
  for (const [index, entry] of layout.entries()) {
    const length = isRecord(entry) ? num(entry, "length") : undefined;
    if (!isRecord(entry) || length === undefined || !Number.isInteger(length) || length < 0) return single;
    if (index > 0) {
      if (text.slice(offset, offset + PROMPT_TEXT_SEPARATOR.length) !== PROMPT_TEXT_SEPARATOR) return single;
      offset += PROMPT_TEXT_SEPARATOR.length;
    }
    if (offset + length > text.length) return single;
    parts.push(omitUndefined({
      id: partId(ids.messageID, `u${index}`),
      ...base,
      text: text.slice(offset, offset + length),
      synthetic: synthetic || entry.synthetic === true || undefined,
      metadata: isRecord(entry.metadata) ? entry.metadata : undefined,
    }));
    offset += length;
  }
  return offset === text.length ? parts : single;
}

function v1UserMessage(
  message: JsonRecord,
  ctx: MessageContext,
  text: string,
  files: unknown[],
  synthetic: boolean,
  agent: string,
  model: ModelRef | undefined,
  extra: { system?: string; tools?: JsonRecord; textParts?: unknown } = {},
): V1Message {
  const id = str(message, "id") ?? "";
  const created = num(record(message, "time"), "created") ?? 0;
  const ids = { messageID: id, sessionID: ctx.sessionID };
  const parts: JsonRecord[] = [];
  if (text || files.length === 0) {
    parts.push(...v1UserTextParts(ids, text, extra.textParts, synthetic));
  }
  parts.push(...userFileParts(files, ids));
  const info = omitUndefined({
    id,
    sessionID: ctx.sessionID,
    role: "user",
    time: { created },
    summary: { diffs: [] },
    agent,
    model: model ? omitUndefined({ providerID: model.providerID, modelID: model.modelID, variant: model.variant }) : { providerID: "", modelID: "" },
    system: extra.system,
    tools: extra.tools,
  });
  return { info, parts };
}

/** A 2.x user-run shell command (`shell` message) as the 1.x shell pair: a synthetic user message and an assistant bash call. */
function v1ShellMessages(message: JsonRecord, ctx: MessageContext, agent: string, model: ModelRef | undefined): V1Message[] {
  const id = str(message, "id") ?? "";
  const created = num(record(message, "time"), "created") ?? 0;
  const completed = num(record(message, "time"), "completed");
  const command = str(message, "command") ?? "";
  const status = str(message, "status");
  const output = str(message, "output") ?? "";
  const userId = `${id}u`;
  const user = v1UserMessage({ id: userId, time: { created } }, ctx, "The following tool was executed by the user", [], true, agent, model);
  const callID = str(message, "shellID") ?? `${id}_shell`;
  const tool = {
    id: partId(id, "c", callID),
    sessionID: ctx.sessionID,
    messageID: id,
    type: "tool",
    callID,
    tool: "bash",
    state: status === "running"
      ? { status: "running", input: { command }, title: command, metadata: {}, time: { start: created } }
      : { status: "completed", input: { command }, output, title: command, metadata: omitUndefined({ output, exit: num(message, "exit") }), time: { start: created, end: completed ?? created } },
  };
  const assistant: V1Message = {
    info: omitUndefined({
      id,
      sessionID: ctx.sessionID,
      role: "assistant",
      time: omitUndefined({ created, completed }),
      parentID: userId,
      modelID: model?.modelID ?? "",
      providerID: model?.providerID ?? "",
      mode: agent,
      agent,
      path: { cwd: ctx.directory ?? "", root: ctx.root ?? "/" },
      cost: 0,
      tokens: v1Tokens(undefined),
    }),
    parts: [tool],
  };
  return [user, assistant];
}

/** A 2.x compaction record as the 1.x pair: a user message with a compaction part and the summary reply. */
function v1CompactionMessages(message: JsonRecord, ctx: MessageContext, model: ModelRef | undefined): V1Message[] {
  const id = str(message, "id") ?? "";
  const created = num(record(message, "time"), "created") ?? 0;
  const completed = num(record(message, "time"), "completed");
  const userId = `${id}u`;
  const user: V1Message = {
    info: omitUndefined({
      id: userId,
      sessionID: ctx.sessionID,
      role: "user",
      time: { created },
      agent: "compaction",
      model: model ? { providerID: model.providerID, modelID: model.modelID } : { providerID: "", modelID: "" },
    }),
    parts: [{ id: partId(userId, "k0"), sessionID: ctx.sessionID, messageID: userId, type: "compaction", auto: str(message, "reason") !== "manual" }],
  };
  const summary = str(message, "summary");
  if (summary === undefined && str(message, "status") === "running") return [user];
  const assistant: V1Message = {
    info: omitUndefined({
      id,
      sessionID: ctx.sessionID,
      role: "assistant",
      time: omitUndefined({ created, completed }),
      parentID: userId,
      modelID: model?.modelID ?? "",
      providerID: model?.providerID ?? "",
      mode: "compaction",
      agent: "compaction",
      path: { cwd: ctx.directory ?? "", root: ctx.root ?? "/" },
      summary: true,
      cost: num(message, "cost") ?? 0,
      tokens: v1Tokens(message.tokens),
      finish: str(message, "status") === "failed" ? undefined : "stop",
      error: str(message, "status") === "failed" ? { name: "UnknownError", data: { message: "Compaction failed" } } : undefined,
    }),
    parts: summary ? [{ id: partId(id, "t0"), sessionID: ctx.sessionID, messageID: id, type: "text", text: summary }] : [],
  };
  return [user, assistant];
}

/**
 * A session's 2.x messages (oldest first) as its 1.x messages. The model and
 * agent of a user message come from the reply that follows it (2.x records
 * them on the step), else from the latest switch record or the session.
 */
export function v1Messages(messages: unknown[], ctx: MessageContext): V1Message[] {
  const list = messages.filter(isRecord);
  const out: V1Message[] = [];
  const mappedFrom = new Map<JsonRecord, V1Message[]>();
  const emit = (message: JsonRecord, mapped: V1Message[]) => {
    mappedFrom.set(message, mapped);
    out.push(...mapped);
  };
  let agent = ctx.agent ?? "build";
  let model = ctx.model;
  let lastUserId = "";
  let firstUser = true;
  // The reply's agent/model decide the user message's: look ahead once.
  const nextAssistant = (index: number): JsonRecord | undefined => {
    for (let i = index + 1; i < list.length; i++) {
      const candidate = list[i]!;
      const type = str(candidate, "type");
      if (type === "assistant") return candidate;
      if (type === "user" || type === "synthetic") return undefined;
    }
    return undefined;
  };
  list.forEach((message, index) => {
    const type = str(message, "type") ?? str(message, "role");
    switch (type) {
      case "agent-switched":
        agent = str(message, "agent") ?? agent;
        return;
      case "model-switched":
        model = modelRef(message.model) ?? model;
        return;
      case "user":
      case "synthetic": {
        const reply = nextAssistant(index);
        const replyAgent = reply ? str(reply, "agent") : undefined;
        const replyModel = reply ? modelRef(reply.model) : undefined;
        let text = str(message, "text") ?? "";
        if (ctx.child && firstUser && type === "user" && text.startsWith(SUBAGENT_PROMPT_PREFIX)) text = text.slice(SUBAGENT_PROMPT_PREFIX.length);
        if (type === "user") firstUser = false;
        const sent = record(record(message, "metadata"), "omnirush");
        const sentModel = record(sent, "model");
        const mapped = v1UserMessage(
          message, ctx, text, arr(message, "files"), type === "synthetic",
          str(sent, "agent") ?? replyAgent ?? agent,
          sentModel && str(sentModel, "providerID") && str(sentModel, "modelID")
            ? { providerID: str(sentModel, "providerID")!, modelID: str(sentModel, "modelID")!, ...(str(sentModel, "variant") ? { variant: str(sentModel, "variant")! } : {}) }
            : replyModel ?? model,
          { system: str(sent, "system"), tools: record(sent, "tools"), textParts: sent?.textParts },
        );
        lastUserId = String(mapped.info.id);
        emit(message, [mapped]);
        return;
      }
      case "skill": {
        const mapped = v1UserMessage(message, ctx, str(message, "text") ?? "", [], true, agent, model);
        emit(message, [mapped]);
        return;
      }
      case "assistant": {
        const mapped = v1AssistantMessage(message, ctx, lastUserId);
        agent = String(mapped.info.agent ?? agent);
        const stepModel = modelRef(message.model);
        if (stepModel) model = { ...stepModel, ...(model?.variant && !stepModel.variant ? { variant: model.variant } : {}) };
        emit(message, [mapped]);
        return;
      }
      case "shell":
        emit(message, v1ShellMessages(message, ctx, agent, model));
        return;
      case "compaction":
        emit(message, v1CompactionMessages(message, ctx, model));
        return;
      default:
        // system, location-switched, idle: context records the 1.x engine never listed
        // (withNativeFields adds them as parts of the nearest message).
        return;
    }
  });
  return withNativeFields(out, list, mappedFrom, ctx.sessionID);
}

export type SessionShapeOptions = {
  version: string;
  /** The directory a session with no location record is reported under. */
  directory?: string;
};

function permissionRules(value: unknown): JsonRecord[] {
  return (Array.isArray(value) ? value : []).filter(isRecord).map((rule) => ({
    permission: v1ToolName(str(rule, "action") ?? "*"),
    pattern: str(rule, "resource") ?? "*",
    action: str(rule, "effect") ?? "ask",
  }));
}

/** A 2.x session as a 1.x session record. */
export function v1Session(value: unknown, options: SessionShapeOptions): JsonRecord | null {
  const data = unwrap(value);
  if (!isRecord(data)) return null;
  const source = record(data, "info") ?? data;
  const id = str(source, "id") ?? str(source, "sessionID");
  if (!id) return null;
  const time = record(source, "time") ?? {};
  const created = num(time, "created") ?? num(source, "created") ?? 0;
  const updated = num(time, "updated") ?? created;
  const archived = num(time, "archived");
  const location = record(source, "location");
  const directory = str(location, "directory") ?? str(source, "directory") ?? options.directory ?? "";
  const parentID = str(source, "parentID");
  const agent = str(source, "agent");
  const rawTitle = str(source, "title");
  let title = rawTitle && rawTitle.trim() ? rawTitle : `${parentID ? "Child session" : "New session"} - ${new Date(created).toISOString()}`;
  if (parentID && agent && rawTitle && !/\(@[^)]+ subagent\)$/.test(rawTitle)) title = `${rawTitle} (@${agent} subagent)`;
  const model = record(source, "model");
  const tokens = record(source, "tokens");
  const revert = record(source, "revert");
  return omitUndefined({
    id,
    slug: str(source, "slug") ?? id.replace(/^ses_/, "").slice(-12).toLowerCase(),
    projectID: str(source, "projectID") ?? "global",
    directory,
    path: str(source, "subpath") || directory.replace(/^[\\/]+/, ""),
    parentID,
    summary: { additions: 0, deletions: 0, files: 0 },
    cost: num(source, "cost"),
    tokens: tokens ? { input: num(tokens, "input") ?? 0, output: num(tokens, "output") ?? 0, reasoning: num(tokens, "reasoning") ?? 0, cache: { read: num(record(tokens, "cache"), "read") ?? 0, write: num(record(tokens, "cache"), "write") ?? 0 } } : undefined,
    title,
    agent,
    model: model && str(model, "id") && str(model, "providerID") ? omitUndefined({ id: str(model, "id"), providerID: str(model, "providerID"), variant: str(model, "variant") }) : undefined,
    version: options.version,
    metadata: record(source, "metadata"),
    time: omitUndefined({ created, updated, archived }),
    permission: parentID ? permissionRules(source.permissions) : undefined,
    revert: revert && str(revert, "messageID") ? omitUndefined({ messageID: str(revert, "messageID"), partID: str(revert, "partID"), snapshot: str(revert, "snapshot") }) : undefined,
  });
}

/** A 2.x permission request as a 1.x one (`permission` = the 1.x tool/permission name). */
export function v1PermissionRequest(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const id = str(value, "id");
  const sessionID = str(value, "sessionID");
  const action = str(value, "action");
  if (!id || !sessionID || !action) return null;
  const resources = arr(value, "resources").filter((item): item is string => typeof item === "string");
  const save = arr(value, "save").filter((item): item is string => typeof item === "string");
  const source = record(value, "source");
  const messageID = str(source, "messageID");
  const callID = str(source, "id");
  return omitUndefined({
    id,
    sessionID,
    permission: v1ToolName(action),
    patterns: resources,
    metadata: record(value, "metadata") ?? {},
    always: save.length > 0 ? save : resources,
    tool: messageID && callID ? { messageID, callID } : undefined,
  });
}

/** A 2.x permission request in the 1.x engine's own `/api` (PermissionV2Request) shape. */
export function v1PermissionV2Request(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const id = str(value, "id");
  const sessionID = str(value, "sessionID");
  const action = str(value, "action");
  if (!id || !sessionID || !action) return null;
  return omitUndefined({
    id,
    sessionID,
    action: v1ToolName(action),
    resources: arr(value, "resources"),
    save: isRecord(value) && Array.isArray(value.save) ? value.save : undefined,
    metadata: record(value, "metadata"),
    source: record(value, "source") ? omitUndefined({ type: "tool", messageID: str(record(value, "source"), "messageID"), callID: str(record(value, "source"), "id") }) : undefined,
  });
}

export type QuestionMapping = { request: JsonRecord; fields: Array<{ key: string; multiple: boolean; options: Array<{ value: string; label: string }> }> };

/** A 2.x form that asks questions (the question tool's form) as a 1.x question request. */
export function v1QuestionRequest(value: unknown): QuestionMapping | null {
  if (!isRecord(value)) return null;
  const id = str(value, "id");
  const sessionID = str(value, "sessionID");
  if (!id || !sessionID) return null;
  const fields = arr(value, "fields").filter(isRecord);
  if (fields.length === 0) return null;
  const mapped: QuestionMapping["fields"] = [];
  const questions: JsonRecord[] = [];
  for (const field of fields) {
    const key = str(field, "key") ?? str(field, "id") ?? String(mapped.length);
    const type = str(field, "type");
    const options = arr(field, "options").filter(isRecord).map((option) => ({
      value: str(option, "value") ?? str(option, "label") ?? "",
      label: str(option, "label") ?? str(option, "value") ?? "",
      description: str(option, "description") ?? "",
    }));
    mapped.push({ key, multiple: type === "multiselect", options });
    questions.push(omitUndefined({
      question: str(field, "description") ?? str(field, "title") ?? "",
      header: str(field, "title") ?? "",
      options: options.map(({ label, description }) => ({ label, description })),
      multiple: type === "multiselect" || undefined,
      custom: field.custom === true || type === "string" || undefined,
    }));
  }
  const source = record(value, "source") ?? record(record(value, "metadata"), "source");
  const messageID = str(source, "messageID");
  const callID = str(source, "id") ?? str(source, "callID");
  return {
    request: omitUndefined({ id, sessionID, questions, tool: messageID && callID ? { messageID, callID } : undefined }),
    fields: mapped,
  };
}

/** 1.x question answers (labels per question) as a 2.x form answer keyed by field. */
export function v2FormAnswer(mapping: QuestionMapping["fields"], answers: unknown[]): JsonRecord {
  const answer: JsonRecord = {};
  mapping.forEach((field, index) => {
    const raw = answers[index];
    const labels = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : typeof raw === "string" ? [raw] : [];
    const values = labels.map((label) => field.options.find((option) => option.label === label)?.value ?? label);
    answer[field.key] = field.multiple ? values : values[0] ?? "";
  });
  return answer;
}

/** A 2.x agent as a 1.x agent record. */
export function v1Agent(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const name = str(value, "id") ?? str(value, "name");
  if (!name) return null;
  const model = record(value, "model");
  const request = record(value, "request");
  const body = record(request, "body") ?? {};
  const permissions = arr(value, "permissions").filter(isRecord);
  return omitUndefined({
    name,
    description: str(value, "description"),
    mode: str(value, "mode") ?? "all",
    native: value.native === true || undefined,
    hidden: value.hidden === true || undefined,
    color: str(value, "color"),
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    topP: typeof body.top_p === "number" ? body.top_p : undefined,
    permission: permissions.map((rule) => ({ permission: v1ToolName(str(rule, "action") ?? "*"), pattern: str(rule, "resource") ?? "*", action: str(rule, "effect") ?? "ask" })),
    model: model && str(model, "providerID") ? { providerID: str(model, "providerID"), modelID: str(model, "id") ?? str(model, "model") ?? "" } : undefined,
    variant: str(model, "variant"),
    prompt: typeof value.system === "string" ? value.system : undefined,
    options: {},
    steps: num(value, "steps"),
  });
}

/** A 2.x command as a 1.x command record. */
export function v1Command(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const name = str(value, "id") ?? str(value, "name");
  if (!name) return null;
  const model = record(value, "model");
  return omitUndefined({
    name,
    description: str(value, "description"),
    agent: str(value, "agent"),
    model: model && str(model, "providerID") ? `${str(model, "providerID")}/${str(model, "id") ?? str(model, "model") ?? ""}` : str(value, "model"),
    source: str(value, "source") === "mcp" ? "mcp" : str(value, "source") === "skill" ? "skill" : "command",
    template: str(value, "template") ?? "",
    subtask: value.subagent === true || undefined,
    hints: Array.isArray(value.hints) ? value.hints : [],
  });
}

function modelStatus(value: unknown): string {
  return value === "alpha" || value === "beta" || value === "deprecated" ? value : "active";
}

/** A 2.x catalog model as a 1.x provider model. */
export function v1Model(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const id = str(value, "id");
  const providerID = str(value, "providerID");
  if (!id || !providerID) return null;
  const capabilities = record(value, "capabilities") ?? {};
  const input = arr(capabilities, "input").filter((item): item is string => typeof item === "string");
  const output = arr(capabilities, "output").filter((item): item is string => typeof item === "string");
  const cost = arr(value, "cost").filter(isRecord);
  const base = cost.find((tier) => !isRecord(tier.tier)) ?? cost[0];
  const limit = record(value, "limit") ?? {};
  const settings = record(value, "settings") ?? {};
  const variants = arr(value, "variants").filter(isRecord);
  const compatibility = record(value, "compatibility");
  const reasoningField = str(compatibility, "reasoningField");
  return omitUndefined({
    id,
    providerID,
    api: { id: str(value, "modelID") ?? id, url: str(settings, "baseURL") ?? "", npm: str(value, "package") ?? "" },
    name: str(value, "name") ?? id,
    family: str(value, "family"),
    capabilities: {
      temperature: true,
      reasoning: variants.length > 0 || Boolean(reasoningField),
      attachment: input.some((kind) => kind !== "text"),
      toolcall: capabilities.tools !== false,
      input: { text: true, audio: input.includes("audio"), image: input.includes("image"), video: input.includes("video"), pdf: input.includes("pdf") },
      output: { text: true, audio: output.includes("audio"), image: output.includes("image"), video: output.includes("video"), pdf: output.includes("pdf") },
      interleaved: reasoningField ? { field: reasoningField } : false,
    },
    cost: {
      input: num(base, "input") ?? 0,
      output: num(base, "output") ?? 0,
      cache: { read: num(record(base, "cache"), "read") ?? 0, write: num(record(base, "cache"), "write") ?? 0 },
    },
    limit: omitUndefined({ context: num(limit, "context") ?? 0, input: num(limit, "input"), output: num(limit, "output") ?? 0 }),
    status: modelStatus(value.status),
    options: {},
    headers: {},
    release_date: num(record(value, "time"), "released") ? new Date(num(record(value, "time"), "released")!).toISOString().slice(0, 10) : "",
    variants: Object.fromEntries(variants.map((variant) => [str(variant, "id") ?? "", record(variant, "settings") ?? {}]).filter(([key]) => key)),
  });
}

/** The 2.x provider and model catalog as the 1.x `/provider` answer `{all, default, connected}`. */
export function v1ProviderList(providers: unknown[], models: unknown[], defaults: Record<string, string>): JsonRecord {
  const byProvider = new Map<string, JsonRecord>();
  for (const provider of providers) {
    if (!isRecord(provider)) continue;
    const id = str(provider, "id");
    if (!id) continue;
    byProvider.set(id, {
      id,
      name: str(provider, "name") ?? id,
      source: "config",
      env: arr(provider, "env").filter((item) => typeof item === "string"),
      options: {},
      models: {},
    });
  }
  for (const model of models) {
    const mapped = v1Model(model);
    if (!mapped) continue;
    if (isRecord(model) && model.enabled === false) continue;
    const providerID = String(mapped.providerID);
    const provider = byProvider.get(providerID) ?? { id: providerID, name: providerID, source: "config", env: [], options: {}, models: {} };
    (provider.models as JsonRecord)[String(mapped.id)] = mapped;
    byProvider.set(providerID, provider);
  }
  const all = [...byProvider.values()].filter((provider) => Object.keys(provider.models as JsonRecord).length > 0);
  return { all, default: defaults, connected: all.map((provider) => provider.id) };
}

/** A 2.x MCP server entry (`GET /api/mcp`: `{name, status: {status, error?}}`) as the 1.x status map value. */
export function v1McpStatus(value: unknown): JsonRecord {
  const nested = record(value, "status");
  const status = str(nested, "status") ?? str(value, "status") ?? "failed";
  const error = str(nested, "error") ?? str(value, "error");
  switch (status) {
    case "connected":
      return { status: "connected" };
    case "disabled":
      return { status: "disabled" };
    case "needs_auth":
      return { status: "needs_auth" };
    case "needs_client_registration":
      return { status: "needs_client_registration", error: error ?? "" };
    case "pending":
      return { status: "failed", error: "The MCP server is still connecting." };
    default:
      return { status: "failed", error: error ?? status };
  }
}
