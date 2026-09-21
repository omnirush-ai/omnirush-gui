import type { OmniRushAuditEntry } from "@/app/lib/omnirush-server";
import type { AuditTrailRecord, AuditWorkspaceRecord } from "./audit-trail-types";
import { redactAuditText, redactAuditValueWithMetadata } from "./redact-audit-value";

export type NormalizeWorkspaceAuditOptions = {
  workspaceId?: string;
  workspacePath?: string;
  sessionId?: string | null;
  environmentValues?: readonly string[];
};

function normalizeSlashes(value: string): string { return value.replaceAll("\\", "/"); }
function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}
function relativeTarget(target: string, workspacePath?: string): string {
  const normalized = normalizeSlashes(target.trim());
  if (!workspacePath) return normalized.startsWith("/") ? normalized.split("/").pop() || normalized : normalized;
  const root = normalizeSlashes(workspacePath.trim()).replace(/\/+$/, "");
  const lower = normalized.toLowerCase(); const lowerRoot = root.toLowerCase();
  if (lower === lowerRoot) return ".";
  if (lower.startsWith(`${lowerRoot}/`)) return normalized.slice(root.length + 1);
  if (normalized === ".." || normalized.startsWith("../")) return normalized.split("/").pop() || normalized;
  return normalized.split("/").pop() || normalized;
}

export function normalizeWorkspaceAuditEntry(entry: OmniRushAuditEntry, options: NormalizeWorkspaceAuditOptions | string = {}): AuditWorkspaceRecord {
  const opts = typeof options === "string" ? { workspacePath: options } : options;
  const workspaceId = opts.workspaceId ?? entry.workspaceId;
  const target = relativeTarget(typeof entry.target === "string" ? entry.target : "", opts.workspacePath);
  const summary = redactAuditText(entry.summary, { environmentValues: opts.environmentValues });
  const targetRedaction = redactAuditValueWithMetadata(target, { environmentValues: opts.environmentValues });
  const detailsRedaction = entry.details ? redactAuditValueWithMetadata(entry.details, { environmentValues: opts.environmentValues }) : null;
  const safeDetails = detailsRedaction ? recordValue(detailsRedaction.value) : undefined;
  const actor = entry.actor?.type ?? "host";
  return {
    kind: "workspace",
    id: `workspace:${entry.id}`,
    auditId: entry.id,
    workspaceId,
    sessionId: opts.sessionId ?? null,
    timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : 0,
    status: "completed",
    title: entry.action || "Workspace activity",
    summary,
    actor,
    action: entry.action,
    target: String(targetRedaction.value),
    ...(safeDetails ? { details: safeDetails } : {}),
    ...(summary !== entry.summary || targetRedaction.redacted || detailsRedaction?.redacted ? { redacted: true } : {}),
  };
}

export function normalizeWorkspaceAuditEntries(entries: readonly OmniRushAuditEntry[], options: NormalizeWorkspaceAuditOptions | string = {}): AuditTrailRecord[] {
  const seen = new Set<string>();
  const records = entries.map((entry) => normalizeWorkspaceAuditEntry(entry, options)).filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id); return true;
  });
  const order = new Map(records.map((record, index) => [record.id, index]));
  return records.sort((a, b) => a.timestamp - b.timestamp || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || a.id.localeCompare(b.id));
}

export const normalizeWorkspaceAudit = normalizeWorkspaceAuditEntries;
