/** The presentation contract for the V1, non-tamper-evident activity trail. */
export type AuditRecordStatus = "running" | "completed" | "failed" | "waiting" | "cancelled";

export type AuditTokenUsage = {
  input?: number;
  output?: number;
  reasoning?: number;
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type AuditRecordBase = {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  timestamp: number;
  status: AuditRecordStatus;
  title: string;
  summary: string;
  /** True when one or more fields were replaced or bounded by the redactor. */
  redacted?: boolean;
};

export type AuditUserRecord = AuditRecordBase & {
  kind: "user";
  messageId: string;
  prompt?: string;
};

export type AuditAssistantRecord = AuditRecordBase & {
  kind: "assistant";
  messageId: string;
  provider?: string;
  model?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  cost?: number;
  usage?: AuditTokenUsage;
  reasoning?: { used: boolean; durationMs?: number; tokens?: number };
  error?: string;
};

export type AuditToolRecord = AuditRecordBase & {
  kind: "tool";
  messageId: string;
  callId: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
};

export type AuditArtifactRecord = AuditRecordBase & {
  kind: "artifact";
  messageId: string;
  path: string;
  fileType?: string;
  sourceToolCallId?: string;
};

export type AuditApprovalRecord = AuditRecordBase & {
  kind: "approval";
  requestId: string;
  requestedAction: string;
  outcome?: string;
};

export type AuditErrorRecord = AuditRecordBase & {
  kind: "error";
  code?: string;
  error: string;
};

export type AuditWorkspaceRecord = AuditRecordBase & {
  kind: "workspace";
  auditId: string;
  actor: "remote" | "host" | string;
  action: string;
  target: string;
  details?: Record<string, unknown>;
};

export type AuditTrailRecord =
  | AuditUserRecord
  | AuditAssistantRecord
  | AuditToolRecord
  | AuditArtifactRecord
  | AuditApprovalRecord
  | AuditErrorRecord
  | AuditWorkspaceRecord;

export type AuditTrailRecordKind = AuditTrailRecord["kind"];
