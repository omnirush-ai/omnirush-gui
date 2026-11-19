import type {
  FilePart,
  Model,
  Part,
  PermissionRequest,
  PermissionV2Request,
  Provider,
  ProviderListResponse,
  QuestionRequest,
  ReasoningPart,
  Session,
  SessionStatus,
  TextPart,
  ToolPart,
  MessageAbortedError,
  UnknownError,
} from "@opencode-ai/sdk/v2/client";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { gatewayErrorMessage, unknownGatewayErrorMessage } from "@omnirush/types/gateway-errors";

import { createClient, createDesktopFetch, type FieldsResult } from "./opencode";
import { isInternalModelProvider } from "./provider-catalog";
import { isDesktopRuntime, isStockMode } from "./runtime-env";
import type { OpencodeEvent } from "../types";
import { normalizeDirectoryPath } from "../utils";

type RequestOptions = {
  signal?: AbortSignal;
  throwOnError?: boolean;
};

type DirectoryParameters = {
  directory?: string;
  workspace?: string;
};

type SessionParameters = DirectoryParameters & {
  sessionID: string;
};

type ModelBinding = {
  providerID: string;
  modelID?: string;
  id?: string;
};

type PromptPart = {
  type?: unknown;
  text?: unknown;
};

type PromptParameters = SessionParameters & {
  model?: { providerID: string; modelID: string };
  parts?: PromptPart[];
  messageID?: string;
  agent?: string;
  noReply?: boolean;
  tools?: Record<string, boolean>;
  system?: string;
  variant?: string;
  reasoning_effort?: string;
};

type SessionCreateParameters = DirectoryParameters & {
  model?: ModelBinding;
  title?: string;
};

type SessionUpdateParameters = SessionParameters & {
  title?: string;
  time?: { archived?: number };
};


type PermissionReply = "once" | "always" | "reject";

type PermissionReplyParameters = DirectoryParameters & {
  requestID: string;
  reply?: PermissionReply;
  message?: string;
};

type PermissionRespondParameters = DirectoryParameters & {
  sessionID: string;
  permissionID: string;
  response?: PermissionReply;
};

type V2PermissionReplyParameters = {
  sessionID: string;
  requestID: string;
  reply?: PermissionReply;
  message?: string;
};

type V2QuestionField = {
  key: string;
  multiple: boolean;
  options: { value: string; label: string; description: string }[];
};

function mapV2Question(value: unknown): { request: QuestionRequest; fields: V2QuestionField[] } | null {
  if (!isRecord(value) || readString(value.metadata, "kind") !== "question") return null;
  const id = readString(value, "id");
  const sessionID = readString(value, "sessionID");
  if (!id || !sessionID || !Array.isArray(value.fields) || value.fields.length === 0) return null;
  const fields: V2QuestionField[] = [];
  const questions: QuestionRequest["questions"] = [];
  for (const field of value.fields) {
    const key = readString(field, "key");
    const type = readString(field, "type");
    if (!isRecord(field) || !key || (type !== "string" && type !== "multiselect")) return null;
    const options = Array.isArray(field.options) ? field.options.flatMap((option) => {
      const label = readString(option, "label");
      const value = readString(option, "value");
      return label !== undefined && value !== undefined
        ? [{ label, value, description: readString(option, "description") ?? "" }] : [];
    }) : [];
    fields.push({ key, multiple: type === "multiselect", options });
    questions.push({
      header: readString(field, "title") ?? "",
      question: readString(field, "description") ?? readString(field, "title") ?? "",
      options: options.map(({ label, description }) => ({ label, description })),
      multiple: type === "multiselect",
      custom: field.custom !== false,
    });
  }
  const source = readRecord(value.metadata, "tool");
  const messageID = readString(source, "messageID");
  const callID = readString(source, "id");
  return { request: { id, sessionID, questions, ...(messageID && callID ? { tool: { messageID, callID } } : {}) }, fields };
}

type V2MessageRole = "user" | "assistant" | "system";

export type V2MappedMessage = {
  info: {
    id: string;
    sessionID: string;
    role: V2MessageRole;
    time: {
      created: number;
      completed?: number;
    };
    error?: UnknownError | MessageAbortedError;
  };
  parts: Part[];
};

type TextStream = {
  sessionID: string;
  messageID: string;
  partID: string;
  ordinal: number;
  text: string;
  start: number;
};

type ToolStream = {
  sessionID: string;
  messageID: string;
  partID: string;
  callID: string;
  tool: string;
  raw: string;
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
  start?: number;
};

export type V2EventTranslationState = {
  streams: Map<string, TextStream>;
  tools: Map<string, ToolStream>;
  latestStreamKeyBySession: Map<string, string>;
  nextOrdinalByMessage: Map<string, number>;
  unknownTypes: Set<string>;
};

type TransportResult = {
  payload: unknown;
  request: Request;
  response: Response;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function responseData(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value;
}

/** 2.x `GET /api/mcp` ({data: [{name, status: {status, error}}]}) as the 1.x status map, by server name. */
export function v2McpStatusMap(payload: unknown): Record<string, { status: string; error?: string }> {
  const out: Record<string, { status: string; error?: string }> = {};
  for (const entry of responseItems(payload)) {
    if (!isRecord(entry) || typeof entry.name !== "string" || !isRecord(entry.status) || typeof entry.status.status !== "string") continue;
    out[entry.name] = { status: entry.status.status, ...(typeof entry.status.error === "string" ? { error: entry.status.error } : {}) };
  }
  return out;
}

function responseItems(value: unknown): unknown[] {
  const data = responseData(value);
  return Array.isArray(data) ? data : [];
}

function eventProperties(value: Record<string, unknown>): Record<string, unknown> {
  const data = readRecord(value, "data");
  if (data) return data;
  const properties = readRecord(value, "properties");
  return properties ?? value;
}

function readSessionID(value: Record<string, unknown>): string {
  return readString(value, "sessionID") ?? readString(value, "sessionId") ?? "";
}

function readMessageID(value: Record<string, unknown>): string {
  return readString(value, "assistantMessageID") ?? readString(value, "messageID") ?? readString(value, "messageId") ?? "";
}

export function mapV2Session(value: unknown, directory: string | undefined, eventCreated?: number): Session | null {
  const data = responseData(value);
  if (!isRecord(data)) return null;
  const source = readRecord(data, "info") ?? data;
  const id = readString(source, "id") ?? readString(source, "sessionID");
  if (!id) return null;
  const time = readRecord(source, "time");
  const location = readRecord(source, "location");
  const created = readNumber(time, "created") ?? readNumber(source, "created") ?? eventCreated ?? 0;
  const updated = readNumber(time, "updated") ?? readNumber(source, "updated") ?? created;
  const archived = readNumber(time, "archived");
  const parentID = readString(source, "parentID");
  const revert = readRecord(source, "revert");
  const revertMessageID = readString(revert, "messageID");
  const mapped: Session = {
    id,
    slug: readString(source, "slug") ?? id,
    projectID: readString(source, "projectID") ?? "v2",
    directory: readString(source, "directory") ?? readString(location, "directory") ?? directory ?? "",
    // Keep native untitled sessions eligible for compatibility title recovery.
    title: readString(source, "title") || `New session - ${new Date(created).toISOString()}`,
    version: readString(source, "version") ?? "v2",
    time: {
      created,
      updated,
      ...(archived === undefined ? {} : { archived }),
    },
    ...(parentID ? { parentID } : {}),
    ...(revertMessageID ? { revert: {
      messageID: revertMessageID,
      ...(readString(revert, "partID") ? { partID: readString(revert, "partID") } : {}),
      ...(readString(revert, "snapshot") ? { snapshot: readString(revert, "snapshot") } : {}),
    } } : {}),
  };
  return mapped;
}

function messageRole(value: Record<string, unknown>): V2MessageRole {
  const raw = readString(value, "role") ?? readString(value, "type");
  if (raw === "user") return "user";
  // Turn-end markers and context switches carry no visible conversation.
  if (raw === "system" || raw === "synthetic" || raw === "compaction" || raw === "idle" || raw?.endsWith("-switched")) return "system";
  return "assistant";
}

function parseToolInput(value: unknown, tool?: string): Record<string, unknown> {
  if (isRecord(value)) {
    // Display-only aliases for the v1 tool cards; native fields stay as sent.
    if (tool === "subagent" && typeof value.agent === "string") return { subagent_type: value.agent, ...value };
    if ((tool === "read" || tool === "edit" || tool === "write") && typeof value.path === "string") return { filePath: value.path, ...value };
    if (tool === "skill" && typeof value.id === "string") return { name: value.id, ...value };
    return value;
  }
  if (typeof value !== "string" || value === "") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parseToolInput(parsed, tool) : {};
  } catch {
    return {};
  }
}

function compatibleToolName(tool: string): string {
  return tool === "shell" ? "bash" : tool === "subagent" ? "task" : tool === "patch" ? "apply_patch" : tool;
}

function toolMetadata(tool: string, metadata: Record<string, unknown>): Record<string, unknown> {
  return tool === "subagent" && typeof metadata.sessionID === "string"
    ? { sessionId: metadata.sessionID, ...metadata }
    : metadata;
}

function toolAttachments(
  content: unknown,
  callID: string,
  messageID: string,
  sessionID: string,
): { attachments?: FilePart[] } {
  if (!Array.isArray(content)) return {};
  const attachments: FilePart[] = [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== "file") continue;
    const url = readString(item, "uri");
    const mime = readString(item, "mime");
    if (url === undefined || mime === undefined) continue;
    const filename = readString(item, "name");
    attachments.push({
      id: `${callID}:file:${attachments.length}`,
      messageID,
      sessionID,
      type: "file",
      url,
      mime,
      ...(filename === undefined ? {} : { filename }),
    });
  }
  return attachments.length > 0 ? { attachments } : {};
}

function toolPartMetadata(tool: string): Pick<ToolPart, "metadata"> {
  // Adapter provenance stays separate from metadata returned by the tool.
  return tool === "execute" ? { metadata: { omnirushV2CodeMode: true } } : {};
}

function toolOutput(value: unknown, result?: unknown): string {
  if (Array.isArray(value)) {
    const text = value.flatMap((item) => {
      if (!isRecord(item) || readString(item, "type") !== "text") return [];
      const content = readString(item, "text");
      return content === undefined ? [] : [content];
    });
    if (text.length > 0) return text.join("\n");
  }
  if (typeof result === "string") return result;
  if (result === undefined) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function mapV2ToolPart(
  value: Record<string, unknown>,
  messageID: string,
  sessionID: string,
  messageCreated: number,
): ToolPart | null {
  const callID = readString(value, "callID") ?? readString(value, "id");
  const sourceTool = readString(value, "tool") ?? readString(value, "name");
  const state = readRecord(value, "state");
  const status = readString(state, "status");
  if (!callID || !sourceTool || !state) return null;
  const tool = compatibleToolName(sourceTool);
  const input = parseToolInput(state.input, sourceTool);
  const time = readRecord(value, "time");
  const created = readNumber(time, "created") ?? messageCreated;
  const start = readNumber(time, "ran") ?? created;
  const end = readNumber(time, "completed") ?? start;
  const title = readString(state, "title") ?? tool;
  const metadata = toolMetadata(sourceTool, readRecord(state, "metadata") ?? {});
  const base: Omit<ToolPart, "state"> = {
    id: callID,
    messageID,
    sessionID,
    type: "tool",
    callID,
    tool,
    ...toolPartMetadata(sourceTool),
  };

  if (status === "pending" || status === "streaming") {
    const raw = typeof state.input === "string" ? state.input : "";
    return { ...base, state: { status: "pending", input, raw } };
  }
  if (status === "running") {
    return { ...base, state: { status, input, title, metadata, time: { start } } };
  }
  if (status === "completed") {
    return {
      ...base,
      state: {
        status,
        input,
        output: toolOutput(state.content, state.result),
        ...toolAttachments(state.content, callID, messageID, sessionID),
        title,
        metadata,
        time: { start, end },
      },
    };
  }
  if (status === "error") {
    return {
      ...base,
      state: {
        status,
        input,
        error: errorMessage(state.error ?? state.result),
        metadata,
        time: { start, end },
      },
    };
  }
  return null;
}

function mapV2MessageParts(
  value: Record<string, unknown>,
  messageID: string,
  sessionID: string,
  messageCreated: number,
): Part[] {
  if (readString(value, "type") === "shell") {
    const part = mapV2ToolPart({
      id: readString(value, "shellID") ?? messageID,
      name: "shell",
      state: {
        status: readString(value, "status") === "running" ? "running" : "completed",
        input: { command: readString(value, "command") ?? "" },
        result: readString(readRecord(value, "output"), "output") ?? "",
      },
    }, messageID, sessionID, messageCreated);
    return part ? [part] : [];
  }
  if (Array.isArray(value.content)) {
    const ordinals = { text: 0, reasoning: 0 };
    return value.content.flatMap<Part>((entry) => {
      if (!isRecord(entry)) return [];
      const kind = readString(entry, "type");
      if (kind === "text" || kind === "reasoning") {
        const ordinal = ordinals[kind]++;
        const text = readString(entry, "text");
        const time = readRecord(entry, "time");
        const end = readNumber(time, "completed");
        return text === undefined ? [] : [{
          id: textPartID(messageID, kind, ordinal),
          messageID,
          sessionID,
          text,
          ...(kind === "reasoning" ? {
            type: kind,
            time: {
              start: readNumber(time, "created") ?? messageCreated,
              ...(end === undefined ? {} : { end }),
            },
          } : { type: kind }),
        }];
      }
      if (readString(entry, "type") === "tool") {
        const part = mapV2ToolPart(entry, messageID, sessionID, messageCreated);
        return part ? [part] : [];
      }
      return [];
    });
  }
  const text = readString(value, "text");
  return text === undefined ? [] : [{
    id: `${messageID}:0`,
    messageID,
    sessionID,
    type: "text",
    text,
  }];
}

function mapV2Message(value: unknown, sessionID: string): V2MappedMessage | null {
  if (!isRecord(value)) return null;
  // Native instruction/catalog updates belong to the model context, not the
  // visible conversation. Filter by role so identical user text is preserved.
  if (messageRole(value) === "system") return null;
  const id = readString(value, "id") ?? readString(value, "messageID");
  if (!id) return null;
  const time = readRecord(value, "time");
  const created = readNumber(time, "created") ?? readNumber(value, "timestamp") ?? 0;
  const completed = readNumber(time, "completed");
  const resolvedSessionID = readString(value, "sessionID") ?? sessionID;
  const parts = mapV2MessageParts(value, id, resolvedSessionID, created);
  const role = messageRole(value);
  const error = readRecord(value, "error");
  return {
    info: {
      id,
      sessionID: resolvedSessionID,
      role,
      time: {
        created,
        ...(completed === undefined ? {} : { completed }),
      },
      // A step the person stopped is the 1.x MessageAbortedError (stopped, never retried: good-session.ts).
      ...(role === "assistant" && error
        ? { error: { name: readString(error, "type") === "aborted" ? "MessageAbortedError" : "UnknownError", data: modelErrorData(error, readString(readRecord(value, "model"), "providerID")) } }
        : {}),
    },
    parts,
  };
}

function mapV2Permission(value: unknown): PermissionV2Request | null {
  if (!isRecord(value)) return null;
  const id = readString(value, "id");
  const sessionID = readSessionID(value);
  const action = readString(value, "action");
  if (!id || !sessionID || !action || !Array.isArray(value.resources)) return null;
  const save = Array.isArray(value.save) ? stringArray(value.save) : undefined;
  const rawMetadata = readRecord(value, "metadata");
  const message = readString(value, "message");
  const metadata = rawMetadata || message
    ? { ...(rawMetadata ?? {}), ...(message ? { message } : {}) }
    : undefined;
  const rawSource = readRecord(value, "source");
  const sourceMessageID = readString(rawSource, "messageID");
  const sourceCallID = readString(rawSource, "callID") ?? readString(rawSource, "id");
  const source: PermissionV2Request["source"] = readString(rawSource, "type") === "tool" && sourceMessageID && sourceCallID
    ? { type: "tool", messageID: sourceMessageID, callID: sourceCallID }
    : undefined;
  return {
    id,
    sessionID,
    action,
    resources: stringArray(value.resources),
    ...(save ? { save } : {}),
    ...(metadata ? { metadata } : {}),
    ...(source ? { source } : {}),
  };
}

function mapV2PermissionToLegacy(permission: PermissionV2Request): PermissionRequest {
  return {
    id: permission.id,
    sessionID: permission.sessionID,
    permission: permission.action,
    patterns: permission.resources,
    metadata: { ...(permission.metadata ?? {}), action: permission.action },
    always: permission.save ?? [],
    ...(permission.source
      ? { tool: { messageID: permission.source.messageID, callID: permission.source.callID } }
      : {}),
  };
}

function modelStatus(value: unknown): Model["status"] {
  return value === "alpha" || value === "beta" || value === "deprecated" || value === "active"
    ? value
    : "active";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mapV2Model(value: unknown): Model | null {
  if (!isRecord(value)) return null;
  const id = readString(value, "id");
  const providerID = readString(value, "providerID");
  if (!id || !providerID) return null;
  const rawApi = readRecord(value, "api");
  const rawCapabilities = readRecord(value, "capabilities");
  const rawLimit = readRecord(value, "limit");
  const rawTime = readRecord(value, "time");
  const rawCosts = value.cost;
  const firstCost = Array.isArray(rawCosts) && rawCosts.length > 0 && isRecord(rawCosts[0])
    ? rawCosts[0]
    : isRecord(rawCosts)
      ? rawCosts
      : null;
  const rawCacheCost = readRecord(firstCost, "cache");
  const inputCapabilities = stringArray(rawCapabilities?.input);
  const outputCapabilities = stringArray(rawCapabilities?.output);
  const toolcall = rawCapabilities?.tools === true;
  const released = readNumber(rawTime, "released");
  // 2.x lists a model's efforts as [{id, settings}]; the 1.x picker reads {id: settings}.
  const variants = Object.fromEntries((Array.isArray(value.variants) ? value.variants : []).flatMap((variant) => {
    const variantID = readString(variant, "id");
    return variantID ? [[variantID, readRecord(variant, "settings") ?? {}]] : [];
  }));
  return {
    id,
    providerID,
    api: {
      id: readString(rawApi, "id") ?? id,
      url: readString(rawApi, "url") ?? "",
      npm: readString(rawApi, "npm") ?? readString(rawApi, "package") ?? "",
    },
    name: readString(value, "name") ?? id,
    capabilities: {
      temperature: false,
      reasoning: Object.keys(variants).length > 0 || outputCapabilities.includes("reasoning"),
      attachment: inputCapabilities.some((kind) => kind !== "text"),
      toolcall,
      input: {
        text: inputCapabilities.length === 0 || inputCapabilities.includes("text"),
        audio: inputCapabilities.includes("audio"),
        image: inputCapabilities.includes("image"),
        video: inputCapabilities.includes("video"),
        pdf: inputCapabilities.includes("pdf"),
      },
      output: {
        text: outputCapabilities.length === 0 || outputCapabilities.includes("text"),
        audio: outputCapabilities.includes("audio"),
        image: outputCapabilities.includes("image"),
        video: outputCapabilities.includes("video"),
        pdf: outputCapabilities.includes("pdf"),
      },
      interleaved: false,
    },
    cost: {
      input: readNumber(firstCost, "input") ?? 0,
      output: readNumber(firstCost, "output") ?? 0,
      cache: {
        read: readNumber(rawCacheCost, "read") ?? 0,
        write: readNumber(rawCacheCost, "write") ?? 0,
      },
    },
    limit: {
      context: readNumber(rawLimit, "context") ?? 0,
      output: readNumber(rawLimit, "output") ?? 0,
      ...(readNumber(rawLimit, "input") === undefined ? {} : { input: readNumber(rawLimit, "input") }),
    },
    status: modelStatus(value.status),
    options: {},
    headers: {},
    release_date: released === undefined ? "" : new Date(released).toISOString(),
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
  };
}

function mapDefaultModels(value: unknown): Record<string, string> {
  const data = responseData(value);
  const defaults: Record<string, string> = {};
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!isRecord(item)) continue;
      const providerID = readString(item, "providerID");
      const modelID = readString(item, "modelID") ?? readString(item, "id");
      if (providerID && modelID) defaults[providerID] = modelID;
    }
    return defaults;
  }
  if (!isRecord(data)) return defaults;
  const providerID = readString(data, "providerID");
  const modelID = readString(data, "modelID") ?? readString(data, "id");
  if (providerID && modelID) defaults[providerID] = modelID;
  for (const [key, item] of Object.entries(data)) {
    if (typeof item === "string") defaults[key] = item;
  }
  return defaults;
}

/** The provider's HTTP status of a 2.x error, as the 1.x `statusCode` (good-session.ts reads it for auto retry). */
function errorStatus(value: unknown): { statusCode?: number } {
  const status = isRecord(value) ? readNumber(value, "status") ?? readNumber(readRecord(value, "error"), "status") : undefined;
  return status === undefined ? {} : { statusCode: status };
}

/** A code engine v2 keeps as an error's whole message that the shared table does not know yet (`some_new_code`). */
const GATEWAY_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/**
 * A model request's 2.x error as the 1.x error data: a bare gateway code
 * (`maintenance`, `no_channel_available`) reads as the broker's copy for it, an
 * unknown snake_case one as a plain line naming it, and stays the `code`. A
 * message on another provider (the person's own key) keeps its error as sent.
 */
function modelErrorData(value: unknown, providerID?: string): { message: string; code?: string; statusCode?: number } {
  const message = errorMessage(value);
  const readable = providerID && !isInternalModelProvider(providerID)
    ? null
    : gatewayErrorMessage(message) ?? (GATEWAY_CODE.test(message) ? unknownGatewayErrorMessage(message) : null);
  return readable ? { message: readable, code: message, ...errorStatus(value) } : { message, ...errorStatus(value) };
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const direct = readString(value, "message");
    if (direct) return direct;
    if ("error" in value) return errorMessage(value.error);
  }
  try {
    return JSON.stringify(value) || "OmniRush v2 execution failed.";
  } catch {
    return "OmniRush v2 execution failed.";
  }
}

function textPartID(messageID: string, kind: "text" | "reasoning", ordinal: number): string {
  return kind === "text" ? `${messageID}:${ordinal}` : `${messageID}:reasoning:${ordinal}`;
}

function streamKey(
  properties: Record<string, unknown>,
  sessionID: string,
  messageID: string,
  kind: "text" | "reasoning",
): string {
  const explicit = readString(properties, `${kind}ID`) ?? readString(properties, `${kind}Id`);
  if (explicit !== undefined) return JSON.stringify([sessionID, kind, "id", explicit]);
  const ordinal = readNumber(properties, "ordinal");
  return JSON.stringify([sessionID, kind, messageID, ordinal]);
}

function resolveTextStream(
  properties: Record<string, unknown>,
  state: V2EventTranslationState,
  kind: "text" | "reasoning",
): TextStream | null {
  const sessionID = readSessionID(properties);
  const messageID = readMessageID(properties);
  const hasMessageID = "assistantMessageID" in properties || "messageID" in properties || "messageId" in properties;
  const explicitKey = streamKey(properties, sessionID, messageID, kind);
  const byExplicitKey = state.streams.get(explicitKey);
  if (byExplicitKey) {
    if (hasMessageID && byExplicitKey.messageID !== messageID) return null;
    if ("ordinal" in properties && byExplicitKey.ordinal !== properties.ordinal) return null;
    return byExplicitKey;
  }
  // Only identity-free legacy fragments may use the latest stream of this kind.
  if (hasMessageID || "ordinal" in properties || `${kind}ID` in properties || `${kind}Id` in properties) return null;
  const latestKey = sessionID ? state.latestStreamKeyBySession.get(JSON.stringify([sessionID, kind])) : undefined;
  if (latestKey) return state.streams.get(latestKey) ?? null;
  return null;
}

function readToolCallID(value: Record<string, unknown>): string {
  return readString(value, "callID") ?? readString(value, "id") ?? "";
}

function toolStreamKey(sessionID: string, callID: string): string {
  return `${sessionID}:${callID}`;
}

function resolveToolStream(
  properties: Record<string, unknown>,
  state: V2EventTranslationState,
): ToolStream | null {
  const sessionID = readSessionID(properties);
  const callID = readToolCallID(properties);
  if (!sessionID || !callID) return null;
  return state.tools.get(toolStreamKey(sessionID, callID)) ?? null;
}

function toolEventTimestamp(value: Record<string, unknown>, properties: Record<string, unknown>): number {
  return readNumber(properties, "timestamp") ?? readNumber(value, "created") ?? Date.now();
}

function pendingToolPart(stream: ToolStream): ToolPart {
  return {
    id: stream.partID,
    messageID: stream.messageID,
    sessionID: stream.sessionID,
    type: "tool",
    callID: stream.callID,
    tool: compatibleToolName(stream.tool),
    ...toolPartMetadata(stream.tool),
    state: {
      status: "pending",
      input: stream.input,
      raw: stream.raw,
    },
  };
}

function runningToolPart(stream: ToolStream, start: number): ToolPart {
  return {
    id: stream.partID,
    messageID: stream.messageID,
    sessionID: stream.sessionID,
    type: "tool",
    callID: stream.callID,
    tool: compatibleToolName(stream.tool),
    ...toolPartMetadata(stream.tool),
    state: {
      status: "running",
      input: stream.input,
      title: compatibleToolName(stream.tool),
      metadata: toolMetadata(stream.tool, stream.metadata),
      time: { start },
    },
  };
}

function completedToolPart(
  stream: ToolStream,
  properties: Record<string, unknown>,
  end: number,
): ToolPart {
  return {
    id: stream.partID,
    messageID: stream.messageID,
    sessionID: stream.sessionID,
    type: "tool",
    callID: stream.callID,
    tool: compatibleToolName(stream.tool),
    ...toolPartMetadata(stream.tool),
    state: {
      status: "completed",
      input: stream.input,
      output: toolOutput(properties.content, properties.result),
      ...toolAttachments(properties.content, stream.callID, stream.messageID, stream.sessionID),
      title: compatibleToolName(stream.tool),
      metadata: toolMetadata(stream.tool, stream.metadata),
      time: { start: stream.start ?? end, end },
    },
  };
}

function failedToolPart(
  stream: ToolStream,
  properties: Record<string, unknown>,
  end: number,
): ToolPart {
  return {
    id: stream.partID,
    messageID: stream.messageID,
    sessionID: stream.sessionID,
    type: "tool",
    callID: stream.callID,
    tool: compatibleToolName(stream.tool),
    ...toolPartMetadata(stream.tool),
    state: {
      status: "error",
      input: stream.input,
      error: errorMessage(properties.error ?? properties.result),
      metadata: toolMetadata(stream.tool, stream.metadata),
      time: { start: stream.start ?? end, end },
    },
  };
}

export function createV2EventTranslationState(): V2EventTranslationState {
  return {
    streams: new Map(),
    tools: new Map(),
    latestStreamKeyBySession: new Map(),
    nextOrdinalByMessage: new Map(),
    unknownTypes: new Set(),
  };
}

export function translateV2Event(
  value: unknown,
  state: V2EventTranslationState,
): OpencodeEvent[] | null {
  if (!isRecord(value)) return null;
  const type = readString(value, "type");
  if (!type) return null;
  const properties = eventProperties(value);
  const sessionID = readSessionID(properties);

  if (type === "session.inbox.enqueued") {
    const messageID = readString(properties, "inboxID");
    const item = readRecord(properties, "item");
    const payload = readRecord(item, "payload");
    if (!sessionID || !messageID || readString(item, "type") !== "user" || !payload) return null;
    // The inbox ID becomes the persisted user-message ID on delivery. Using
    // it here lets the live row reconcile with history without duplicating it.
    const message = mapV2Message({
      ...payload,
      id: messageID,
      type: "user",
      time: { created: readNumber(value, "created") ?? readNumber(properties, "timestamp") ?? Date.now() },
    }, sessionID);
    if (!message) return null;
    return [
      { type: "message.updated", properties: { info: message.info } },
      ...message.parts.map((part): OpencodeEvent => ({ type: "message.part.updated", properties: { part } })),
    ];
  }

  if (type === "session.inbox.cancelled") {
    const messageID = readString(properties, "inboxID");
    return sessionID && messageID
      ? [{ type: "message.removed", properties: { sessionID, messageID } }]
      : null;
  }

  if (type.startsWith("session.execution.")) {
    if (!sessionID) return null;
    return [{ type, properties: {
      ...properties, sequence: readNumber(value.durable, "seq"),
      ...(type === "session.execution.failed" ? {
        error: { name: "UnknownError", data: modelErrorData(properties.error) },
      } : {}),
    } }];
  }

  if (type === "session.retry.scheduled") {
    const attempt = readNumber(properties, "attempt");
    const next = readNumber(properties, "at");
    if (!sessionID || attempt === undefined || next === undefined) return null;
    return [{ type: "session.status", properties: {
      sessionID,
      sequence: readNumber(value.durable, "seq"),
      status: { type: "retry", attempt, message: modelErrorData(properties.error).message, next },
    } }];
  }

  if (type === "session.step.started") {
    return sessionID ? [{ type: "session.execution.progress", properties: {
      sessionID, sequence: readNumber(value.durable, "seq"),
    } }] : null;
  }

  const kind = type.startsWith("session.reasoning.") || type.startsWith("session.next.reasoning.") ? "reasoning" : "text";
  if (type === `session.${kind}.started` || type === `session.next.${kind}.started`) {
    const messageID = readMessageID(properties);
    if (!sessionID || !messageID) return null;
    const key = streamKey(properties, sessionID, messageID, kind);
    const counterKey = JSON.stringify([sessionID, messageID, kind]);
    const candidate = state.streams.get(key);
    const existing = candidate?.messageID === messageID ? candidate : undefined;
    const ordinal = readNumber(properties, "ordinal")
      ?? existing?.ordinal
      ?? state.nextOrdinalByMessage.get(counterKey)
      ?? 0;
    const stream = existing ?? {
      sessionID,
      messageID,
      partID: textPartID(messageID, kind, ordinal),
      ordinal,
      text: "",
      start: toolEventTimestamp(value, properties),
    };
    state.streams.set(key, stream);
    state.latestStreamKeyBySession.set(JSON.stringify([sessionID, kind]), key);
    if (!existing) {
      state.nextOrdinalByMessage.set(counterKey, Math.max(state.nextOrdinalByMessage.get(counterKey) ?? 0, ordinal + 1));
    }
    const part: TextPart | ReasoningPart = {
      id: stream.partID,
      messageID,
      sessionID,
      text: stream.text,
      ...(kind === "reasoning" ? { type: kind, time: { start: stream.start } } : { type: kind }),
    };
    return [
      {
        type: "message.updated",
        properties: {
          info: {
            id: messageID,
            sessionID,
            role: "assistant",
            time: { created: stream.start },
          },
        },
      },
      { type: "message.part.updated", properties: { part } },
    ];
  }

  if (type === `session.${kind}.delta` || type === `session.next.${kind}.delta`) {
    const stream = resolveTextStream(properties, state, kind);
    const delta = readString(properties, "delta");
    if (!stream || delta === undefined) return null;
    stream.text += delta;
    return [{
      type: "message.part.delta",
      properties: {
        sessionID: stream.sessionID,
        messageID: stream.messageID,
        partID: stream.partID,
        field: "text",
        delta,
      },
    }];
  }

  if (type === `session.${kind}.ended` || type === `session.next.${kind}.ended`) {
    const stream = resolveTextStream(properties, state, kind);
    if (!stream) return null;
    const fullText = readString(properties, "text");
    if (fullText !== undefined) stream.text = fullText;
    const part: TextPart | ReasoningPart = {
      id: stream.partID,
      messageID: stream.messageID,
      sessionID: stream.sessionID,
      text: stream.text,
      ...(kind === "reasoning" ? {
        type: kind,
        time: { start: stream.start, end: toolEventTimestamp(value, properties) },
      } : { type: kind }),
    };
    return [{ type: "message.part.updated", properties: { part } }];
  }

  if (type === "session.tool.input.started" || type === "session.next.tool.input.started") {
    const messageID = readMessageID(properties);
    const callID = readToolCallID(properties);
    const sourceTool = readString(properties, "name") ?? readString(properties, "tool");
    if (!sessionID || !messageID || !callID || !sourceTool) return null;
    const key = toolStreamKey(sessionID, callID);
    const existing = state.tools.get(key);
    const stream = existing ?? {
      sessionID,
      messageID,
      partID: callID,
      callID,
      tool: sourceTool,
      raw: "",
      input: {},
      metadata: {},
    };
    state.tools.set(key, stream);
    return [
      {
        type: "message.updated",
        properties: {
          info: {
            id: messageID,
            sessionID,
            role: "assistant",
            time: { created: toolEventTimestamp(value, properties) },
          },
        },
      },
      { type: "message.part.updated", properties: { part: pendingToolPart(stream) } },
    ];
  }

  if (type === "session.tool.input.delta" || type === "session.next.tool.input.delta") {
    const stream = resolveToolStream(properties, state);
    const delta = readString(properties, "delta");
    if (!stream || delta === undefined) return null;
    stream.raw += delta;
    stream.input = parseToolInput(stream.raw, stream.tool);
    return [{ type: "message.part.updated", properties: { part: pendingToolPart(stream) } }];
  }

  if (type === "session.tool.input.ended" || type === "session.next.tool.input.ended") {
    const stream = resolveToolStream(properties, state);
    const text = readString(properties, "text");
    if (!stream || text === undefined) return null;
    stream.raw = text;
    stream.input = parseToolInput(text, stream.tool);
    return [{ type: "message.part.updated", properties: { part: pendingToolPart(stream) } }];
  }

  if (type === "session.tool.called" || type === "session.next.tool.called") {
    const stream = resolveToolStream(properties, state);
    if (!stream) return null;
    stream.input = parseToolInput(properties.input, stream.tool);
    stream.start = toolEventTimestamp(value, properties);
    return [{
      type: "message.part.updated",
      properties: { part: runningToolPart(stream, stream.start) },
    }];
  }

  if (type === "session.tool.progress" || type === "session.next.tool.progress") {
    const stream = resolveToolStream(properties, state);
    if (!stream) return null;
    stream.metadata = readRecord(properties, "metadata") ?? readRecord(properties, "structured") ?? stream.metadata;
    const start = stream.start ?? toolEventTimestamp(value, properties);
    stream.start = start;
    return [{
      type: "message.part.updated",
      properties: { part: runningToolPart(stream, start) },
    }];
  }

  if (type === "session.tool.success" || type === "session.next.tool.success") {
    const stream = resolveToolStream(properties, state);
    if (!stream) return null;
    stream.metadata = readRecord(properties, "metadata") ?? readRecord(properties, "structured") ?? stream.metadata;
    const part = completedToolPart(stream, properties, toolEventTimestamp(value, properties));
    return [{ type: "message.part.updated", properties: { part } }];
  }

  if (type === "session.tool.failed" || type === "session.next.tool.failed") {
    const stream = resolveToolStream(properties, state);
    if (!stream) return null;
    stream.metadata = readRecord(properties, "metadata") ?? stream.metadata;
    const part = failedToolPart(stream, properties, toolEventTimestamp(value, properties));
    return [{ type: "message.part.updated", properties: { part } }];
  }

  if (type === "permission.asked" || type === "permission.v2.asked") {
    const permission = mapV2Permission(properties);
    return permission ? [{ type: "permission.asked", properties: permission }] : null;
  }

  if (type === "form.created") {
    const question = mapV2Question(properties.form);
    return question ? [{ type: "question.asked", properties: question.request }] : null;
  }

  if (type === "form.replied" || type === "form.cancelled") {
    const requestID = readString(properties, "id");
    if (!sessionID || !requestID) return null;
    return [{ type: type === "form.replied" ? "question.replied" : "question.rejected", properties: { sessionID, requestID } }];
  }

  if (type === "permission.replied" || type === "permission.v2.replied") {
    const requestID = readString(properties, "requestID");
    const reply = readString(properties, "decision") ?? readString(properties, "reply");
    if (!sessionID || !requestID || (reply !== "once" && reply !== "always" && reply !== "reject")) return null;
    return [{ type: "permission.replied", properties: { sessionID, requestID, reply } }];
  }

  if (type === "session.status") {
    if (!sessionID || !isRecord(properties.status)) return null;
    return [{ type: "session.status", properties: { sessionID, status: properties.status } }];
  }

  if (type === "session.idle") {
    return sessionID ? [{ type: "session.idle", properties: { sessionID } }] : null;
  }

  if (type === "session.created") {
    const info = mapV2Session(
      properties,
      readString(readRecord(value, "location") ?? {}, "directory"),
      readNumber(value, "created"),
    );
    if (!info) return null;
    return [{
      type: "session.created",
      properties: { info },
    }];
  }

  if (type === "session.renamed") {
    const title = readString(properties, "title");
    if (!sessionID || title === undefined) return null;
    return [{ type: "session.updated", properties: { info: { id: sessionID, title } } }];
  }

  if (type === "session.revert.staged" || type === "session.revert.cleared" || type === "session.revert.committed") {
    const messageID = type === "session.revert.staged" ? readString(readRecord(properties, "revert"), "messageID") : undefined;
    if (!sessionID) return null;
    // A session.updated without a cursor clears it, matching a cleared or committed revert.
    return [{ type: "session.updated", properties: { info: { id: sessionID, ...(messageID ? { revert: { messageID } } : {}) } } }];
  }

  if (type === "session.deleted") {
    const info = mapV2Session(properties, readString(readRecord(value, "location") ?? {}, "directory"));
    const deletedSessionID = sessionID || info?.id || "";
    if (!deletedSessionID) return null;
    return [{
      type: "session.deleted",
      properties: { sessionID: deletedSessionID, ...(info ? { info } : {}) },
    }];
  }

  if (!state.unknownTypes.has(type)) {
    state.unknownTypes.add(type);
    console.debug(`[opencode-v2] skipping unsupported event type: ${type}`);
  }
  return null;
}

function translateV2Events(
  response: Response,
  signal: AbortSignal | undefined,
  fetchSession: (sessionID: string, signal: AbortSignal) => Promise<Session | null>,
  directory?: string,
): AsyncGenerator<OpencodeEvent> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const state = createV2EventTranslationState();
  const discoveredForks = new Set<string>();
  const lookups = new Map<string, AbortController>();
  const discoveries: Session[] = [];
  const reads: ({ chunk: ReadableStreamReadResult<Uint8Array> } | { error: unknown })[] = [];
  let reading = false;
  let ended = !reader;
  let stopped = false;
  let wake: (() => void) | undefined;
  const notify = () => { wake?.(); wake = undefined; };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener("abort", stop);
    for (const lookup of lookups.values()) lookup.abort();
    lookups.clear();
    discoveries.length = 0;
    reads.length = 0;
    void reader?.cancel().catch(() => {});
    reader?.releaseLock();
    notify();
  };
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();

  const discover = async (sessionID: string, eventDirectory: string | undefined) => {
    const lookup = new AbortController();
    lookups.set(sessionID, lookup);
    const timeout = setTimeout(() => lookup.abort(), 2_000);
    let onAbort = () => {};
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      lookup.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      // IPC may ignore cancellation; bound discovery without holding up SSE.
      const info = await Promise.race([fetchSession(sessionID, lookup.signal), aborted]);
      if (lookup.signal.aborted || !info || info.id !== sessionID || !info.directory) return;
      if (eventDirectory && normalizeDirectoryPath(info.directory) !== normalizeDirectoryPath(eventDirectory)) return;
      discoveredForks.add(sessionID);
      discoveries.push(info);
    } catch {
      // A later replay can retry deleted sessions and unavailable lookups.
    } finally {
      clearTimeout(timeout);
      lookup.signal.removeEventListener("abort", onAbort);
      lookups.delete(sessionID);
      notify();
    }
  };

  let buffer = "";
  const stream = (async function* (): AsyncGenerator<OpencodeEvent> {
    try {
      while (!stopped) {
        const discovery = discoveries.shift();
        if (discovery) { yield { type: "session.created", properties: { info: discovery } }; continue; }
        const read = reads.shift();
        if (!read) {
          if (ended && lookups.size === 0) break;
          if (!ended && !reading && reader) {
            reading = true;
            // One handler per read and one replaceable waiter, not a race that
            // keeps attaching listeners to a held lookup on every SSE chunk.
            void reader.read().then(
              (chunk) => { if (!stopped) reads.push({ chunk }); notify(); },
              (error: unknown) => { if (!stopped) reads.push({ error }); notify(); },
            );
          }
          await new Promise<void>((resolve) => { wake = resolve; });
          continue;
        }
        reading = false;
        if ("error" in read) throw read.error;
        const { chunk } = read;
        if (chunk.done) { ended = true; continue; }
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (stopped) return;
          if (!line.startsWith("data:")) continue;
          const text = line.slice("data:".length).trim();
          if (!text) continue;
          let event: unknown;
          try {
            event = JSON.parse(text);
            if (typeof event === "string") event = JSON.parse(event);
          } catch {
            continue;
          }
          const eventDirectory = isRecord(event) ? readString(readRecord(event, "location") ?? {}, "directory") : undefined;
          if (directory && (!eventDirectory || normalizeDirectoryPath(directory) !== normalizeDirectoryPath(eventDirectory))) continue;
          if (isRecord(event) && event.type === "session.forked") {
            const sessionID = readSessionID(eventProperties(event));
            if (!sessionID || discoveredForks.has(sessionID) || lookups.has(sessionID)) continue;
            // Fork events contain ancestry, not a session. In particular their
            // parentID must not turn the new root conversation into a task child.
            void discover(sessionID, eventDirectory);
            continue;
          }
          const translated = translateV2Event(event, state);
          if (!translated) continue;
          for (const item of translated) {
            if (stopped) return;
            if (item.type === "session.deleted") {
              const sessionID = readString(item.properties, "sessionID");
              if (sessionID) {
                lookups.get(sessionID)?.abort();
                // Neither a completed lookup nor a stale fork replay may
                // recreate a session after its deletion has been emitted.
                discoveredForks.add(sessionID);
                const index = discoveries.findIndex((info) => info.id === sessionID);
                if (index !== -1) discoveries.splice(index, 1);
              }
            }
            yield item;
          }
        }
      }
    } finally {
      stop();
    }
  })();
  // Async-generator return normally queues behind next(), which may be waiting
  // on a quiet SSE connection. Cancel first so it can enter its finally block.
  const returnStream = stream.return.bind(stream);
  stream.return = (value) => { stop(); return returnStream(value); };
  return stream;
}

function createWebFetch(auth: { token?: string }): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (auth.token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${auth.token}`);
    }
    if (input instanceof Request) {
      return globalThis.fetch(new Request(input, { headers }), init);
    }
    return globalThis.fetch(input, { ...init, headers });
  };
}

function createV2Fetch(auth: { token?: string }): typeof globalThis.fetch {
  return isDesktopRuntime()
    ? createDesktopFetch({ mode: "omnirush", token: auth.token })
    : createWebFetch(auth);
}

async function readPayload(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function successfulResult<T>(transport: TransportResult, data: T): FieldsResult<T> {
  return { data, request: transport.request, response: transport.response };
}

function failedResult<T>(transport: TransportResult): FieldsResult<T> {
  return {
    error: transport.payload ?? { name: "OpenCodeV2RequestFailed" },
    request: transport.request,
    response: transport.response,
  };
}

function localResult<T>(baseUrl: string, path: string, data: T): FieldsResult<T> {
  return {
    data,
    request: new Request(`${baseUrl}${path}`),
    response: new Response(null, { status: 200 }),
  };
}

function unsupportedResult<T>(baseUrl: string, operation: string, message?: string): FieldsResult<T> {
  return {
    error: { name: "UnsupportedInV2Preview", operation, ...(message ? { message } : {}) },
    request: new Request(`${baseUrl}/unsupported/${encodeURIComponent(operation)}`),
    response: new Response(null, { status: 501, statusText: "Unsupported in OmniRush v2 preview" }),
  };
}

export function isOpencodeV2BaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).pathname.replace(/\/+$/, "").endsWith("/opencode2");
  } catch {
    return baseUrl.replace(/\/+$/, "").endsWith("/opencode2");
  }
}

const v2Clients = new WeakSet<ReturnType<typeof createClient>>();

export function isOpencodeV2Client(client: ReturnType<typeof createClient>): boolean {
  return v2Clients.has(client);
}

export function createClientV2(
  opencode2BaseUrl: string,
  directory: string | undefined,
  auth: { token?: string },
): ReturnType<typeof createClient> {
  const baseUrl = opencode2BaseUrl.replace(/\/+$/, "");
  const fetchImpl = createV2Fetch(auth);
  // Only the facade's shape: every 1.x call the adapter does not port fails
  // here, locally, instead of reaching a 2.x engine that has no 1.x routes.
  const compatibilityClient: ReturnType<typeof createClient> = createOpencodeClient({
    baseUrl,
    fetch: async (input) => Response.json({
      name: "UnsupportedInV2",
      message: `Not available on the OpenCode 2.x engine: ${(input instanceof Request ? input.url : String(input)).slice(baseUrl.length).split("?")[0]}`,
    }, { status: 501 }),
  });
  const permissionSessionByRequestID = new Map<string, string>();
  const questionFormsByID = new Map<string, NonNullable<ReturnType<typeof mapV2Question>>>();

  const request = async (
    method: string,
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TransportResult> => {
    const headers = new Headers();
    if (auth.token) headers.set("Authorization", `Bearer ${auth.token}`);
    if (body) headers.set("Content-Type", "application/json");
    const transportRequest = new Request(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    const response = await fetchImpl(transportRequest);
    return { payload: await readPayload(response), request: transportRequest, response };
  };

  const listSessionPermissions = async (
    parameters: SessionParameters,
    options?: RequestOptions,
  ): Promise<FieldsResult<{ data: PermissionV2Request[] }>> => {
    const result = await request(
      "GET",
      `/api/session/${encodeURIComponent(parameters.sessionID)}/permission`,
      undefined,
      options?.signal,
    );
    if (!result.response.ok) return failedResult(result);
    const data = responseItems(result.payload).flatMap((item) => {
      const permission = mapV2Permission(item);
      if (!permission) return [];
      permissionSessionByRequestID.set(permission.id, permission.sessionID);
      return [permission];
    });
    return successfulResult(result, { data });
  };

  const replySessionPermission = async (
    parameters: V2PermissionReplyParameters,
    options?: RequestOptions,
  ): Promise<FieldsResult<void>> => {
    const result = await request(
      "POST",
      `/api/session/${encodeURIComponent(parameters.sessionID)}/permission/${encodeURIComponent(parameters.requestID)}/reply`,
      {
        decision: parameters.reply ?? "once",
        ...(parameters.message ? { message: parameters.message } : {}),
      },
      options?.signal,
    );
    if (!result.response.ok) return failedResult(result);
    permissionSessionByRequestID.delete(parameters.requestID);
    return successfulResult(result, undefined);
  };

  const listPermissions = async (
    _parameters: DirectoryParameters = {},
    options?: RequestOptions,
  ): Promise<FieldsResult<PermissionRequest[]>> => {
    const sessionsResult = await request("GET", "/api/session", undefined, options?.signal);
    if (!sessionsResult.response.ok) return failedResult(sessionsResult);
    const sessionIDs = responseItems(sessionsResult.payload).flatMap((item) => {
      const sessionID = readString(item, "id") ?? readString(item, "sessionID");
      return sessionID ? [sessionID] : [];
    });
    const permissions: PermissionRequest[] = [];
    for (const sessionID of sessionIDs) {
      const result = await listSessionPermissions({ sessionID }, options);
      if (result.data === undefined) {
        return { error: result.error, request: result.request, response: result.response };
      }
      permissions.push(...result.data.data.map(mapV2PermissionToLegacy));
    }
    return successfulResult(sessionsResult, permissions);
  };

  const replyPermission = async (
    parameters: PermissionReplyParameters,
    options?: RequestOptions,
  ): Promise<FieldsResult<boolean>> => {
    const sessionID = permissionSessionByRequestID.get(parameters.requestID);
    if (!sessionID) {
      return {
        error: { name: "PermissionSessionUnknown", requestID: parameters.requestID },
        request: new Request(`${baseUrl}/api/session/permission/${encodeURIComponent(parameters.requestID)}/reply`),
        response: new Response(null, { status: 404 }),
      };
    }
    const result = await replySessionPermission({
      sessionID,
      requestID: parameters.requestID,
      reply: parameters.reply,
      message: parameters.message,
    }, options);
    if (result.error !== undefined || !result.response) {
      return { error: result.error, request: result.request, response: result.response };
    }
    // No error means fetch completed, so the response is present.
    return { data: true, request: result.request, response: result.response as Response };
  };

  const respondPermission = async (
    parameters: PermissionRespondParameters,
    options?: RequestOptions,
  ): Promise<FieldsResult<boolean>> => {
    const result = await replySessionPermission({
      sessionID: parameters.sessionID,
      requestID: parameters.permissionID,
      reply: parameters.response,
    }, options);
    if (result.error !== undefined || !result.response) {
      return { error: result.error, request: result.request, response: result.response };
    }
    // No error means fetch completed, so the response is present.
    return { data: true, request: result.request, response: result.response as Response };
  };

  const listQuestions = async (
    _parameters: DirectoryParameters = {}, options?: RequestOptions,
  ): Promise<FieldsResult<QuestionRequest[]>> => {
    const result = await request("GET", "/api/form", undefined, options?.signal);
    if (!result.response.ok) return failedResult(result);
    const questions = responseItems(result.payload).flatMap((item) => {
      const question = mapV2Question(item);
      if (!question) return [];
      questionFormsByID.set(question.request.id, question);
      return [question.request];
    });
    return successfulResult(result, questions);
  };

  const settleQuestion = async (
    parameters: DirectoryParameters & { requestID: string; answers?: string[][] },
    options?: RequestOptions,
  ): Promise<FieldsResult<boolean>> => {
    // SSE and interaction clients have separate lifetimes. A question received
    // live must also be answerable without having appeared in the initial list.
    if (!questionFormsByID.has(parameters.requestID)) {
      const listed = await listQuestions(parameters, options);
      if (listed.data === undefined) return { error: listed.error, request: listed.request, response: listed.response };
    }
    const question = questionFormsByID.get(parameters.requestID);
    if (!question) return {
      error: { name: "QuestionNotFound", requestID: parameters.requestID },
      request: new Request(`${baseUrl}/api/form`),
      response: new Response(null, { status: 404 }),
    };
    const answer = parameters.answers ? Object.fromEntries(question.fields.map((field, index) => {
      const values = (parameters.answers?.[index] ?? []).map((label) =>
        field.options.find((option) => option.label === label)?.value ?? label);
      return [field.key, field.multiple ? values : values[0] ?? ""];
    })) : undefined;
    const formPath = `/api/session/${encodeURIComponent(question.request.sessionID)}/form/${encodeURIComponent(parameters.requestID)}`;
    const result = answer
      ? await request("POST", `${formPath}/reply`, { answer }, options?.signal)
      : await request("DELETE", formPath, undefined, options?.signal);
    if (!result.response.ok) return failedResult(result);
    questionFormsByID.delete(parameters.requestID);
    return successfulResult(result, true);
  };

  const getSession = async (
    parameters: SessionParameters,
    options?: RequestOptions,
  ): Promise<FieldsResult<Session>> => {
    const result = await request("GET", `/api/session/${encodeURIComponent(parameters.sessionID)}`, undefined, options?.signal);
    if (!result.response.ok) return failedResult(result);
    const session = mapV2Session(result.payload, directory);
    if (session) return successfulResult(result, session);
    return failedResult({ ...result, payload: { name: "InvalidV2SessionResponse" } });
  };

  // The picked effort rides on the model (2.x `model.variant`); without one the engine runs the model's default.
  const selectModel = (sessionID: string, model: { providerID: string; modelID: string }, variant: string | undefined, options?: RequestOptions) =>
    request("POST", `/api/session/${encodeURIComponent(sessionID)}/model`,
      { model: { providerID: model.providerID, id: model.modelID, ...(variant ? { variant } : {}) } }, options?.signal);

  // 2.x mutations answer 204 or a non-session payload; v1 callers expect the session.
  const thenSession = async (result: TransportResult, sessionID: string, options?: RequestOptions) =>
    result.response.ok ? getSession({ sessionID }, options) : failedResult<Session>(result);

  const createSession = async (
    parameters: SessionCreateParameters = {},
    options?: RequestOptions,
  ): Promise<FieldsResult<Session>> => {
    const modelID = parameters.model?.id ?? parameters.model?.modelID;
    const model = parameters.model && modelID
      ? { providerID: parameters.model.providerID, id: modelID }
      : undefined;
    // v2 binds a session's location through the create BODY; the query-param
    // location middleware does not apply to session.create (verified against
    // the running engine: query-only creates land in the engine cwd project).
    const location = parameters.directory ?? directory;
    const result = await request("POST", "/api/session", {
      ...(model ? { model } : {}),
      ...(parameters.title === undefined ? {} : { title: parameters.title }),
      ...(location ? { location: { directory: location } } : {}),
    }, options?.signal);
    if (!result.response.ok) return failedResult(result);
    const session = mapV2Session(result.payload, directory);
    if (session) return successfulResult(result, session);
    return failedResult({ ...result, payload: { name: "InvalidV2SessionResponse" } });
  };

  const session = {
    list: async (
      parameters: DirectoryParameters & { limit?: number } = {},
      options?: RequestOptions,
    ): Promise<FieldsResult<Session[]>> => {
      const query = new URLSearchParams();
      if (parameters.limit !== undefined) query.set("limit", String(parameters.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      const result = await request("GET", `/api/session${suffix}`, undefined, options?.signal);
      if (!result.response.ok) return failedResult(result);
      const data = responseItems(result.payload).flatMap((item) => {
        const mapped = mapV2Session(item, directory);
        return mapped ? [mapped] : [];
      });
      return successfulResult(result, data);
    },
    create: createSession,
    get: getSession,
    messages: async (
      parameters: SessionParameters & { limit?: number; before?: string },
      options?: RequestOptions,
    ): Promise<FieldsResult<V2MappedMessage[]>> => {
      // 2.x pages newest first with a default page size; v1 callers expect
      // the latest `limit` (or all) messages oldest first.
      const path = `/api/session/${encodeURIComponent(parameters.sessionID)}/message`;
      // The limit counts visible messages, not hidden turn markers.
      const limit = parameters.limit ?? Infinity;
      const data: V2MappedMessage[] = [];
      let cursor: string | undefined;
      let result: TransportResult;
      // Newest first: a turn's idle marker comes before its answers. One saying "interrupted" (the person's
      // Stop) marks the turn's last answer stopped when the answer itself carries no error.
      let interrupted = false;
      for (;;) {
        const pageSize = Math.min(200, limit - data.length);
        const query = new URLSearchParams({ limit: String(pageSize), ...(cursor ? { cursor } : { order: "desc" }) });
        result = await request("GET", `${path}?${query.toString()}`, undefined, options?.signal);
        if (!result.response.ok) return failedResult(result);
        const page = responseItems(result.payload);
        for (const item of page) {
          if (isRecord(item) && readString(item, "type") === "idle") interrupted = readString(item, "outcome") === "interrupted";
          const mapped = mapV2Message(item, parameters.sessionID);
          if (!mapped) continue;
          if (mapped.info.role === "user") interrupted = false;
          if (mapped.info.role === "assistant" && interrupted) {
            interrupted = false;
            if (!("error" in mapped.info)) mapped.info = { ...mapped.info, error: { name: "MessageAbortedError", data: { message: "Interrupted" } } };
          }
          if (data.length < limit) data.push(mapped);
        }
        cursor = readString(readRecord(result.payload, "cursor"), "next");
        if (page.length < pageSize || data.length >= limit || !cursor) break;
      }
      return successfulResult(result, data.reverse());
    },
    todo: async (parameters: SessionParameters): Promise<FieldsResult<never[]>> =>
      localResult(baseUrl, `/api/session/${encodeURIComponent(parameters.sessionID)}/todo`, []),
    status: async (
      _parameters: DirectoryParameters = {},
      options?: RequestOptions,
    ): Promise<FieldsResult<Record<string, SessionStatus>>> => {
      const result = await request("GET", "/api/session/active", undefined, options?.signal);
      if (!result.response.ok) return failedResult(result);
      const data = responseData(result.payload);
      if (!isRecord(data)) return failedResult({ ...result, payload: { name: "InvalidV2SessionActiveResponse" } });
      const statuses: Record<string, SessionStatus> = {};
      for (const [sessionID, active] of Object.entries(data)) {
        if (readString(active, "type") === "running") statuses[sessionID] = { type: "busy" };
      }
      return successfulResult(result, statuses);
    },
    promptAsync: async (
      parameters: PromptParameters,
      options?: RequestOptions,
    ): Promise<FieldsResult<Record<string, never>>> => {
      if (!parameters.model) {
        return {
          error: { name: "ModelRequiredInV2Preview" },
          request: new Request(`${baseUrl}/api/session/${encodeURIComponent(parameters.sessionID)}/model`),
          response: new Response(null, { status: 400 }),
        };
      }
      const modelResult = await selectModel(parameters.sessionID, parameters.model, parameters.variant, options);
      if (!modelResult.response.ok) return failedResult(modelResult);
      // Stock mode: no context of ours, the engine's own system prompt only.
      if (parameters.system !== undefined && !isStockMode()) {
        const instructions = await request("PUT",
          `/api/experimental/session/${encodeURIComponent(parameters.sessionID)}/instructions/entries/omnirush-context`,
          { value: parameters.system }, options?.signal);
        if (!instructions.response.ok) return failedResult(instructions);
      }
      const text = (parameters.parts ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => typeof part.text === "string" ? part.text : "")
        .join("");
      // Attachments go as the engine's files (a data: or file: URI each); the server turns office files into text.
      const files = (parameters.parts ?? []).flatMap((part) => {
        const file = part as { type?: string; url?: unknown; filename?: unknown };
        return file.type === "file" && typeof file.url === "string" && file.url
          ? [{ uri: file.url, name: typeof file.filename === "string" && file.filename ? file.filename : "attachment" }]
          : [];
      });
      const promptResult = await request(
        "POST",
        `/api/session/${encodeURIComponent(parameters.sessionID)}/prompt`,
        // The UI's id becomes the saved user message, so an uncertain send can be checked by id.
        { text, ...(files.length ? { files } : {}), ...(parameters.messageID?.startsWith("msg_") ? { id: parameters.messageID } : {}) },
        options?.signal,
      );
      return promptResult.response.ok ? successfulResult(promptResult, {}) : failedResult(promptResult);
    },
    abort: async (
      parameters: SessionParameters,
      options?: RequestOptions,
    ): Promise<FieldsResult<boolean>> => {
      const result = await request(
        "POST",
        `/api/session/${encodeURIComponent(parameters.sessionID)}/interrupt`,
        {},
        options?.signal,
      );
      if (!result.response.ok) return failedResult(result);
      const data = responseData(result.payload);
      if (!isRecord(data) || typeof data.interrupted !== "boolean") {
        return failedResult({ ...result, payload: { name: "InvalidV2InterruptResponse" } });
      }
      return successfulResult(result, data.interrupted);
    },
    update: async (
      parameters: SessionUpdateParameters,
      options?: RequestOptions,
    ): Promise<FieldsResult<Session>> => {
      // Archiving is the app's own flag (the server keeps it; it never reaches the engine): `archived` on the
      // same PATCH, a time to archive, 0 or null to unarchive.
      const archived = parameters.time?.archived;
      if (!parameters.title && archived === undefined) return getSession(parameters, options);
      const result = await request(
        "PATCH",
        `/api/session/${encodeURIComponent(parameters.sessionID)}`,
        { ...(parameters.title ? { title: parameters.title } : {}), ...(archived === undefined ? {} : { archived: archived || null }) },
        options?.signal,
      );
      return result.response.ok ? getSession(parameters, options) : failedResult(result);
    },
    delete: async (
      parameters: SessionParameters,
      options?: RequestOptions,
    ): Promise<FieldsResult<boolean>> => {
      const result = await request(
        "DELETE",
        `/api/session/${encodeURIComponent(parameters.sessionID)}`,
        undefined,
        options?.signal,
      );
      return result.response.ok ? successfulResult(result, true) : failedResult(result);
    },
    diff: async (parameters: SessionParameters & { messageID?: string }, options?: RequestOptions) => {
      const query = parameters.messageID ? `?from=${encodeURIComponent(parameters.messageID)}` : "";
      const result = await request("GET", `/api/session/${encodeURIComponent(parameters.sessionID)}/diff${query}`, undefined, options?.signal);
      return result.response.ok ? successfulResult(result, responseItems(result.payload)) : failedResult(result);
    },
    message: async (parameters: SessionParameters & { messageID: string }, options?: RequestOptions) => {
      const result = await request("GET",
        `/api/session/${encodeURIComponent(parameters.sessionID)}/message/${encodeURIComponent(parameters.messageID)}`, undefined, options?.signal);
      if (!result.response.ok) return failedResult(result);
      const mapped = mapV2Message(responseData(result.payload), parameters.sessionID);
      return mapped ? successfulResult(result, mapped) : failedResult({ ...result, payload: { name: "InvalidV2MessageResponse" } });
    },
    fork: async (
      parameters: SessionParameters & { messageID?: string },
      options?: RequestOptions,
    ): Promise<FieldsResult<Session>> => {
      // v1 forks copy the messages before messageID; 2.x calls that boundary `before`.
      const result = await request("POST", `/api/session/${encodeURIComponent(parameters.sessionID)}/fork`,
        parameters.messageID ? { before: parameters.messageID } : {}, options?.signal);
      if (!result.response.ok) return failedResult(result);
      const forked = mapV2Session(result.payload, directory);
      return forked ? successfulResult(result, forked) : failedResult({ ...result, payload: { name: "InvalidV2SessionResponse" } });
    },
    // Staging restores files and hides the turns; the next prompt commits it
    // and unrevert drops it, which is the v1 soft-revert contract. An explicit
    // commit would make the revert permanent at once.
    revert: async (
      parameters: SessionParameters & { messageID: string; partID?: string },
      options?: RequestOptions,
    ): Promise<FieldsResult<Session>> => thenSession(await request("POST",
      `/api/session/${encodeURIComponent(parameters.sessionID)}/revert/stage`,
      { messageID: parameters.messageID }, options?.signal), parameters.sessionID, options),
    unrevert: async (parameters: SessionParameters, options?: RequestOptions): Promise<FieldsResult<Session>> =>
      thenSession(await request("DELETE", `/api/session/${encodeURIComponent(parameters.sessionID)}/revert`,
        undefined, options?.signal), parameters.sessionID, options),
    summarize: async (parameters: SessionParameters, options?: RequestOptions): Promise<FieldsResult<boolean>> => {
      const result = await request("POST", `/api/session/${encodeURIComponent(parameters.sessionID)}/compact`, {}, options?.signal);
      return result.response.ok ? successfulResult(result, true) : failedResult(result);
    },
    shell: async (
      parameters: SessionParameters & { command: string },
      options?: RequestOptions,
    ): Promise<FieldsResult<Record<string, never>>> => {
      const result = await request("POST", `/api/session/${encodeURIComponent(parameters.sessionID)}/shell`,
        { command: parameters.command }, options?.signal);
      return result.response.ok ? successfulResult(result, {}) : failedResult(result);
    },
    command: async (
      parameters: SessionParameters & { command: string; arguments?: string; model?: string; variant?: string },
      options?: RequestOptions,
    ): Promise<FieldsResult<Record<string, never>>> => {
      // v1 passes "provider/model"; 2.x commands run on the session model.
      const slash = parameters.model?.indexOf("/") ?? -1;
      if (parameters.model && slash > 0) {
        const modelResult = await selectModel(parameters.sessionID,
          { providerID: parameters.model.slice(0, slash), modelID: parameters.model.slice(slash + 1) }, parameters.variant, options);
        if (!modelResult.response.ok) return failedResult(modelResult);
      }
      const result = await request("POST", `/api/session/${encodeURIComponent(parameters.sessionID)}/command`,
        { name: parameters.command, text: parameters.arguments ?? "" }, options?.signal);
      return result.response.ok ? successfulResult(result, {}) : failedResult(result);
    },
  };

  const adapter = {
    global: {
      health: async (options?: RequestOptions): Promise<FieldsResult<{ healthy: boolean; version: string }>> => {
        const result = await request("GET", "/api/info", undefined, options?.signal);
        if (!result.response.ok) return failedResult(result);
        return successfulResult(result, { healthy: true, version: readString(result.payload, "version") ?? "v2" });
      },
    },
    session,
    config: {
      get: async (): Promise<FieldsResult<Record<string, never>>> => localResult(baseUrl, "/api/config", {}),
    },
    provider: {
      auth: async () => localResult(baseUrl, "/api/provider/auth", {}),
      list: async (
        _parameters: DirectoryParameters = {},
        options?: RequestOptions,
      ): Promise<FieldsResult<ProviderListResponse>> => {
        const modelsResult = await request("GET", "/api/model", undefined, options?.signal);
        if (!modelsResult.response.ok) return failedResult(modelsResult);
        const [defaultsResult, providersResult] = await Promise.all([
          request("GET", "/api/model/default", undefined, options?.signal),
          request("GET", "/api/provider", undefined, options?.signal),
        ]);
        const providerNames = new Map<string, string>();
        if (providersResult.response.ok) {
          for (const provider of responseItems(providersResult.payload)) {
            if (!isRecord(provider)) continue;
            const id = readString(provider, "id");
            const name = readString(provider, "name");
            if (id && name) providerNames.set(id, name);
          }
        }
        const models = responseItems(modelsResult.payload).flatMap((item) => {
          const mapped = mapV2Model(item);
          return mapped ? [mapped] : [];
        });
        const providersByID = new Map<string, Provider>();
        for (const model of models) {
          const current = providersByID.get(model.providerID);
          if (current) {
            current.models[model.id] = model;
            continue;
          }
          providersByID.set(model.providerID, {
            id: model.providerID,
            name: providerNames.get(model.providerID) ?? model.providerID,
            source: "config",
            env: [],
            options: {},
            models: { [model.id]: model },
          });
        }
        const all = [...providersByID.values()];
        return successfulResult(modelsResult, {
          all,
          connected: all.map((provider) => provider.id),
          default: defaultsResult.response.ok ? mapDefaultModels(defaultsResult.payload) : {},
        });
      },
    },
    app: {
      agents: async (_parameters?: DirectoryParameters, options?: RequestOptions) => {
        const result = await request("GET", "/api/agent", undefined, options?.signal);
        if (!result.response.ok) return failedResult(result);
        // `name` is the 1.x identifier the UI selects by; 2.x calls it `id`.
        return successfulResult(result, responseItems(result.payload).flatMap((item) => {
          const id = readString(item, "id");
          const mode = readString(item, "mode");
          if (!id || (mode !== "primary" && mode !== "subagent" && mode !== "all")) return [];
          const model = readRecord(item, "model");
          const providerID = readString(model, "providerID");
          const modelID = readString(model, "id");
          const description = readString(item, "description");
          return [{
            name: id, mode, hidden: isRecord(item) && item.hidden === true,
            permission: [], options: {},
            ...(description ? { description } : {}),
            ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
          }];
        }));
      },
    },
    command: {
      list: async (_parameters?: DirectoryParameters, options?: RequestOptions) => {
        const result = await request("GET", "/api/command", undefined, options?.signal);
        if (!result.response.ok) return failedResult(result);
        return successfulResult(result, responseItems(result.payload).flatMap((item) => {
          const name = readString(item, "name");
          const description = readString(item, "description");
          return name ? [{ name, template: "", hints: [], ...(description ? { description } : {}) }] : [];
        }));
      },
    },
    permission: {
      list: listPermissions,
      reply: replyPermission,
      respond: respondPermission,
    },
    question: {
      list: listQuestions,
      reply: settleQuestion,
      reject: (parameters: DirectoryParameters & { requestID: string }, options?: RequestOptions) => settleQuestion(parameters, options),
    },
    v2: {
      session: {
        permission: {
          list: listSessionPermissions,
          reply: replySessionPermission,
        },
      },
    },
    find: {
      files: async (
        parameters: DirectoryParameters & { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number },
        options?: RequestOptions,
      ): Promise<FieldsResult<string[]>> => {
        const query = new URLSearchParams({ query: parameters.query });
        const type = parameters.type ?? (parameters.dirs === "false" ? "file" : undefined);
        if (type) query.set("type", type);
        if (parameters.limit !== undefined) query.set("limit", String(parameters.limit));
        const result = await request("GET", `/api/fs/find?${query.toString()}`, undefined, options?.signal);
        if (!result.response.ok) return failedResult(result);
        // Directories end with a slash, as in 1.x; the folder itself ("/") is not a result.
        return successfulResult(result, responseItems(result.payload).flatMap((item) => {
          const path = readString(item, "path")?.replace(/\/+$/, "");
          return path ? [readString(item, "type") === "directory" ? `${path}/` : path] : [];
        }));
      },
    },
    vcs: {
      get: async (_parameters?: DirectoryParameters, options?: RequestOptions) => {
        const result = await request("GET", "/api/vcs", undefined, options?.signal);
        if (!result.response.ok) return failedResult(result);
        const branch = readRecord(responseData(result.payload), "branch");
        const current = readString(branch, "current");
        const defaultBranch = readString(branch, "default");
        return successfulResult(result, {
          ...(current ? { branch: current } : {}),
          ...(defaultBranch ? { default_branch: defaultBranch } : {}),
        });
      },
      diff: async (parameters: DirectoryParameters & { mode?: string }, options?: RequestOptions) => {
        // 1.x "git" is the uncommitted tree; 2.x calls it "working".
        const mode = !parameters.mode || parameters.mode === "git" ? "working" : parameters.mode;
        const result = await request("GET", `/api/vcs/diff?mode=${encodeURIComponent(mode)}`, undefined, options?.signal);
        return result.response.ok ? successfulResult(result, responseItems(result.payload)) : failedResult(result);
      },
    },
    project: {
      list: async (_parameters?: DirectoryParameters, options?: RequestOptions) => {
        const result = await request("GET", "/api/project", undefined, options?.signal);
        if (!result.response.ok) return failedResult(result);
        return successfulResult(result, responseItems(result.payload).flatMap((item) => {
          const id = readString(item, "id");
          const worktree = readString(item, "canonical");
          return id && worktree && isRecord(item) ? [{ ...item, id, worktree }] : [];
        }));
      },
      current: async (_parameters?: DirectoryParameters, options?: RequestOptions) => {
        const result = await request("GET", "/api/location", undefined, options?.signal);
        if (!result.response.ok) return failedResult(result);
        const project = readRecord(result.payload, "project");
        const id = readString(project, "id");
        const worktree = readString(project, "canonical");
        return id && worktree
          ? successfulResult(result, { id, worktree, time: { created: 0 }, sandboxes: [] })
          : failedResult({ ...result, payload: { name: "InvalidV2LocationResponse" } });
      },
    },
    path: {
      get: async (_parameters?: DirectoryParameters, options?: RequestOptions) => {
        const result = await request("GET", "/api/location", undefined, options?.signal);
        if (!result.response.ok) return failedResult(result);
        const current = readString(result.payload, "directory") ?? "";
        const worktree = readString(readRecord(result.payload, "project"), "canonical") ?? current;
        // 2.x has no home/state/config paths for clients.
        return successfulResult(result, { home: "", state: "", config: "", worktree, directory: current });
      },
    },
    // No language-server status in 2.x and no client-side provider sign-in (the server owns providers).
    lsp: {
      status: async () => localResult(baseUrl, "/api/lsp", []),
    },
    mcp: {
      status: async (_parameters?: DirectoryParameters, options?: RequestOptions): Promise<FieldsResult<Record<string, { status: string; error?: string }>>> => {
        const result = await request("GET", "/api/mcp", undefined, options?.signal);
        return result.response.ok ? successfulResult(result, v2McpStatusMap(result.payload)) : failedResult(result);
      },
    },
    event: {
      subscribe: async (
        _parameters?: DirectoryParameters,
        options?: RequestOptions,
      ): Promise<{ stream: AsyncGenerator<OpencodeEvent> }> => {
        const headers = new Headers({ Accept: "text/event-stream" });
        if (auth.token) headers.set("Authorization", `Bearer ${auth.token}`);
        const eventRequest = new Request(`${baseUrl}/api/event`, {
          headers,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        const response = await fetchImpl(eventRequest);
        if (!response.ok) {
          const error = new Error(errorMessage(await readPayload(response)));
          Object.assign(error, { status: response.status, response });
          throw error;
        }
        return {
          stream: translateV2Events(response, options?.signal, async (sessionID, signal) => {
            const result = await request("GET", `/api/session/${encodeURIComponent(sessionID)}`, undefined, signal);
            return result.response.ok ? mapV2Session(result.payload, undefined) : null;
          }, directory),
        };
      },
    },
  };

  Object.assign(compatibilityClient.global, adapter.global);
  Object.assign(compatibilityClient.session, adapter.session);
  Object.assign(compatibilityClient.config, adapter.config);
  Object.assign(compatibilityClient.provider, adapter.provider);
  Object.assign(compatibilityClient.app, adapter.app);
  Object.assign(compatibilityClient.command, adapter.command);
  Object.assign(compatibilityClient.permission, adapter.permission);
  Object.assign(compatibilityClient.question, adapter.question);
  Object.assign(compatibilityClient.v2.session.permission, adapter.v2.session.permission);
  Object.assign(compatibilityClient.find, adapter.find);
  Object.assign(compatibilityClient.vcs, adapter.vcs);
  Object.assign(compatibilityClient.project, adapter.project);
  Object.assign(compatibilityClient.path, adapter.path);
  Object.assign(compatibilityClient.lsp, adapter.lsp);
  Object.assign(compatibilityClient.mcp, adapter.mcp);
  Object.assign(compatibilityClient.event, adapter.event);
  v2Clients.add(compatibilityClient);
  return compatibilityClient;
}

export type OpencodeV2Client = ReturnType<typeof createClientV2>;
