import type { OmniRushSessionSnapshot } from "@/app/lib/omnirush-server";
import type { AuditArtifactRecord, AuditAssistantRecord, AuditErrorRecord, AuditTokenUsage, AuditToolRecord, AuditTrailRecord, AuditUserRecord } from "./audit-trail-types";
import { redactAuditText, redactAuditValue, redactAuditValueWithMetadata } from "./redact-audit-value";

type AnyRecord = Record<string, unknown>;

export type ProjectSessionAuditOptions = {
  workspaceId?: string;
  sessionId?: string | null;
  workspacePath?: string;
  environmentValues?: readonly string[];
};

function asRecord(value: unknown): AnyRecord { return value && typeof value === "object" ? value as AnyRecord : {}; }
function textFromParts(parts: unknown[]): string {
  return parts.filter((part) => asRecord(part).type === "text" && typeof asRecord(part).text === "string")
    .map((part) => String(asRecord(part).text)).join(" ").trim();
}
function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function timestamp(value: unknown, fallback = 0): number {
  return numberOrUndefined(value) ?? fallback;
}
function duration(start?: number, end?: number): number | undefined {
  return start !== undefined && end !== undefined && end >= start ? end - start : undefined;
}
function usageOf(info: AnyRecord): AuditTokenUsage | undefined {
  const raw = asRecord(info.tokens ?? info.usage);
  const usage: AuditTokenUsage = {};
  const fields: Array<[keyof AuditTokenUsage, string[]]> = [
    ["input", ["input", "inputTokens"]], ["output", ["output", "outputTokens"]],
    ["reasoning", ["reasoning", "reasoningTokens"]], ["total", ["total", "totalTokens"]],
    ["cacheRead", ["cacheRead", "cache_read"]], ["cacheWrite", ["cacheWrite", "cache_write"]],
  ];
  for (const [target, names] of fields) {
    const found = names.map((name) => numberOrUndefined(raw[name])).find((item): item is number => item !== undefined);
    if (found !== undefined) usage[target] = found;
  }
  return Object.keys(usage).length ? usage : undefined;
}
function modelOf(info: AnyRecord): { provider?: string; model?: string } {
  const model = asRecord(info.model);
  const provider = typeof model.providerID === "string" ? model.providerID : typeof model.provider === "string" ? model.provider : undefined;
  const name = typeof model.modelID === "string" ? model.modelID : typeof model.id === "string" ? model.id : undefined;
  return { ...(provider ? { provider } : {}), ...(name ? { model: name } : {}) };
}
function toolTime(part: AnyRecord): { start?: number; end?: number } {
  const state = asRecord(part.state);
  const time = asRecord(state.time ?? part.time);
  return {
    start: numberOrUndefined(time.start ?? time.created),
    end: numberOrUndefined(time.end ?? time.completed),
  };
}
function toolStatus(part: AnyRecord, snapshotBusy: boolean): AuditToolRecord["status"] {
  const status = asRecord(part.state).status;
  if (status === "error" || status === "failed") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "completed" || status === "success") return "completed";
  return snapshotBusy ? "running" : "running";
}
function artifactPath(part: AnyRecord): string | null {
  const candidate = part.filename ?? part.path ?? (typeof part.url === "string" && part.url.startsWith("file://") ? part.url.slice(7) : undefined);
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}
function reasoningOf(parts: unknown[]): AuditAssistantRecord["reasoning"] {
  const reasoning = parts.filter((part) => asRecord(part).type === "reasoning").map(asRecord);
  if (!reasoning.length) return undefined;
  const starts = reasoning.map((part) => numberOrUndefined(asRecord(part.time).start ?? asRecord(part.time).created)).filter((item): item is number => item !== undefined);
  const ends = reasoning.map((part) => numberOrUndefined(asRecord(part.time).end ?? asRecord(part.time).completed)).filter((item): item is number => item !== undefined);
  const tokens = reasoning.map((part) => numberOrUndefined(part.tokens)).filter((item): item is number => item !== undefined).reduce((sum, item) => sum + item, 0);
  const start = starts.length ? Math.min(...starts) : undefined;
  const end = ends.length ? Math.max(...ends) : undefined;
  return { used: true, ...(duration(start, end) === undefined ? {} : { durationMs: duration(start, end) }), ...(tokens ? { tokens } : {}) };
}
function displayPath(path: string, workspacePath?: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (!workspacePath) return normalized.startsWith("/") ? normalized.split("/").pop() || normalized : normalized;
  const root = workspacePath.replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return normalized.slice(root.length + 1);
  if (normalized === ".." || normalized.startsWith("../")) return normalized.split("/").pop() || normalized;
  return normalized.split("/").pop() || normalized;
}

/** Purely projects the currently available OpenCode snapshot; it does no I/O. */
export function projectSessionAudit(snapshot: OmniRushSessionSnapshot, options: ProjectSessionAuditOptions | string = {}): AuditTrailRecord[] {
  const opts = typeof options === "string" ? { workspaceId: options } : options;
  const source = asRecord(snapshot);
  const session = asRecord(source.session);
  const sessionId = opts.sessionId ?? (typeof session.id === "string" ? session.id : null);
  const workspaceId = opts.workspaceId ?? (typeof session.workspaceID === "string" ? session.workspaceID : typeof session.workspaceId === "string" ? session.workspaceId : "");
  const snapshotBusy = asRecord(source.status).type === "busy";
  const records: AuditTrailRecord[] = [];
  const messages = Array.isArray(source.messages) ? source.messages : [];
  messages.forEach((entry, sourceIndex) => {
    const item = asRecord(entry); const info = asRecord(item.info); const parts = Array.isArray(item.parts) ? item.parts : [];
    const messageId = typeof info.id === "string" ? info.id : `message-${sourceIndex}`;
    const created = timestamp(asRecord(info.time).created, sourceIndex);
    const completed = numberOrUndefined(asRecord(info.time).completed);
    const role = info.role;
    const summary = textFromParts(parts) || (role === "assistant" ? "Assistant response" : "Prompt submitted");
    const summaryRedaction = redactAuditValueWithMetadata(summary, { environmentValues: opts.environmentValues });
    const safeSummary = String(summaryRedaction.value);
    if (role === "user") {
      records.push({ kind: "user", id: `message:${messageId}`, workspaceId, sessionId, timestamp: created, status: "completed", title: "Prompt submitted", summary: safeSummary, prompt: safeSummary, messageId, ...(summaryRedaction.redacted ? { redacted: true } : {}) } satisfies AuditUserRecord);
    }
    if (role === "assistant") {
      const error = info.error !== undefined ? redactAuditText(info.error, { environmentValues: opts.environmentValues }) : undefined;
      const status: AuditAssistantRecord["status"] = error ? "failed" : info.finish === "cancelled" || info.finish === "canceled" ? "cancelled" : completed === undefined ? (snapshotBusy ? "running" : "completed") : "completed";
      const model = modelOf(info); const redaction = summaryRedaction.redacted || Boolean(error);
      const reasoning = reasoningOf(parts);
      const assistant: AuditAssistantRecord = { kind: "assistant", id: `message:${messageId}`, workspaceId, sessionId, timestamp: created, status, title: model.model ? `${model.model} ${status === "completed" ? "completed" : status}` : "Assistant response", summary: safeSummary, messageId, ...model, startedAt: created, ...(completed === undefined ? {} : { completedAt: completed, durationMs: duration(created, completed) }), ...(info.cost !== undefined && typeof info.cost === "number" ? { cost: info.cost } : {}), ...(usageOf(info) ? { usage: usageOf(info) } : {}), ...(reasoning ? { reasoning } : {}), ...(error ? { error } : {}), ...(redaction ? { redacted: true } : {}) };
      records.push(assistant);
      const errorObject = asRecord(info.error);
      if (error) records.push({ kind: "error", id: `error:${messageId}`, workspaceId, sessionId, timestamp: completed ?? created, status: "failed", title: "Assistant task failed", summary: error, error, ...(typeof errorObject.name === "string" ? { code: errorObject.name } : {}) } satisfies AuditErrorRecord);
    }
    parts.forEach((rawPart, partIndex) => {
      const part = asRecord(rawPart);
      if (part.type === "tool") {
        const state = asRecord(part.state); const callId = typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : `part-${partIndex}`;
        const times = toolTime(part); const status = toolStatus(part, snapshotBusy); const toolName = typeof part.tool === "string" ? part.tool : "tool";
        const input = redactAuditValueWithMetadata(state.input, { environmentValues: opts.environmentValues });
        const output = redactAuditValueWithMetadata(state.output, { environmentValues: opts.environmentValues });
        const error = state.error === undefined ? undefined : redactAuditText(state.error, { environmentValues: opts.environmentValues });
        const title = `${toolName} ${status === "completed" ? "completed" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "running"}`;
        records.push({ kind: "tool", id: `tool:${callId}`, workspaceId, sessionId, timestamp: times.start ?? created, status, title, summary: title, messageId, callId, toolName, ...(state.input !== undefined ? { input: input.value } : {}), ...(state.output !== undefined ? { output: output.value } : {}), ...(error ? { error } : {}), ...(times.start !== undefined ? { startedAt: times.start } : {}), ...(times.end !== undefined ? { completedAt: times.end, durationMs: duration(times.start, times.end) } : {}), ...(input.redacted || output.redacted ? { redacted: true } : {}) } satisfies AuditToolRecord);
      }
      if (part.type === "file" || part.type === "attachment") {
        const rawPath = artifactPath(part); if (!rawPath) return;
        const path = displayPath(rawPath, opts.workspacePath);
        const name = path.split(/[\\/]/).pop() || path;
        records.push({ kind: "artifact", id: `artifact:${messageId}:${path}`, workspaceId, sessionId, timestamp: created, status: "completed", title: `Created ${name}`, summary: path, messageId, path, ...(typeof part.mime === "string" ? { fileType: part.mime } : {}) } satisfies AuditArtifactRecord);
      }
    });
  });
  const byId = new Map<string, AuditTrailRecord>();
  for (const record of records) {
    const previous = byId.get(record.id);
    if (!previous) { byId.set(record.id, record); continue; }
    // A live snapshot can contain an earlier pending part and a later result
    // for the same call. Keep the terminal result while retaining its stable ID.
    if (record.kind === "tool" && previous.kind === "tool") {
      const rank = (status: AuditToolRecord["status"]) => status === "running" ? 0 : status === "waiting" ? 1 : 2;
      if (rank(record.status) >= rank(previous.status)) byId.set(record.id, record);
    }
  }
  const order = new Map<string, number>();
  records.forEach((record, index) => { if (!order.has(record.id)) order.set(record.id, index); });
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || a.id.localeCompare(b.id));
}

export const projectSessionAuditTrail = projectSessionAudit;

export type AuditTrailExport = {
  schemaVersion: 1;
  scope: { workspaceId: string; sessionId: string | null };
  generatedAt: number;
  partialHistory: boolean;
  records: AuditTrailRecord[];
};

/** Stable JSON export of the currently projected (and already redacted) data. */
export function createAuditTrailExport(records: readonly AuditTrailRecord[], scope: { workspaceId: string; sessionId?: string | null; generatedAt?: number; partialHistory?: boolean }): AuditTrailExport {
  return {
    schemaVersion: 1,
    scope: { workspaceId: scope.workspaceId, sessionId: scope.sessionId ?? null },
    generatedAt: scope.generatedAt ?? Date.now(),
    partialHistory: scope.partialHistory ?? true,
    records: records.map((record) => redactAuditValue(record) as AuditTrailRecord),
  };
}

export function serializeAuditTrailExport(records: readonly AuditTrailRecord[], scope: { workspaceId: string; sessionId?: string | null; generatedAt?: number; partialHistory?: boolean }): string {
  return JSON.stringify(createAuditTrailExport(records, scope));
}
