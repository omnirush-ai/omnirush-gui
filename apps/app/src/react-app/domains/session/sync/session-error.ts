import type { UIMessage } from "ai";

import { safeStringify } from "../../../../app/utils";
import { normalizeErrorText } from "../../../../lib/error-text";

export type OpencodeSessionErrorKind = "aborted" | "provider-timeout" | "provider-incomplete" | "free-model-limit" | "disk-full" | "database-error" | "folder-not-writable" | "generic";

/**
 * omnirush.ai's stable error object (`error.omnirush` of the gateway's JSON
 * error body or stream `error` frame): what the user hit, independent of the
 * message text. Absent on an older backend and on errors relayed from
 * upstream.
 */
export type OmniRushErrorDetails = {
  code: string;
  scope?: string;
  resets_at?: string;
  /** false: the same request cannot succeed before the user acts or the allowance resets. */
  retry?: boolean;
  retry_after?: number;
  /** Whose usage limit it is: `company` for an OmniRush Work company account (domains/work/company-limit.ts). */
  owner?: string;
};

export type OpencodeSessionErrorPresentation = {
  kind: OpencodeSessionErrorKind;
  title: string;
  description: string | null;
  technicalDetails: string;
  recoveryPrompt: string | null;
  /** A page that fixes the error, opened in the browser (omnirush.ai's console for an account out of tokens). */
  action?: { label: string; link: string } | null;
  /** The gateway's `error.omnirush`, when the error carried one. */
  omnirush?: OmniRushErrorDetails | null;
  /** The answer said `x-should-retry: false`: the same request is refused again. */
  noRetry?: boolean;
};

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** A well-formed `error.omnirush` (only its known fields), or null. */
export function omnirushErrorDetails(value: unknown): OmniRushErrorDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const code = typeof source.code === "string" ? source.code.trim() : "";
  if (!code) return null;
  const details: OmniRushErrorDetails = { code };
  if (typeof source.scope === "string" && source.scope.trim()) details.scope = source.scope.trim();
  if (typeof source.resets_at === "string" && source.resets_at.trim()) details.resets_at = source.resets_at.trim();
  if (typeof source.retry === "boolean") details.retry = source.retry;
  if (typeof source.retry_after === "number" && Number.isFinite(source.retry_after)) details.retry_after = source.retry_after;
  if (typeof source.owner === "string" && source.owner.trim()) details.owner = source.owner.trim();
  return details;
}

/** Whether an engine API error's response headers say `x-should-retry: false`. */
function sessionSaysNoRetry(error: unknown): boolean {
  for (const record of [error, recordValue(error, "data"), recordValue(recordValue(error, "cause"), "data")]) {
    const headers = recordValue(record, "responseHeaders");
    if (!headers || typeof headers !== "object") continue;
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (name.toLowerCase() === "x-should-retry" && String(value).trim().toLowerCase() === "false") return true;
    }
  }
  return false;
}

/**
 * The `error.omnirush` an engine session error carries: in the gateway's
 * response body (`data.responseBody`, the JSON of an HTTP error or of a
 * stream's `error` frame), or a raw frame the engine kept as the message.
 */
function sessionOmniRushDetails(error: unknown): OmniRushErrorDetails | null {
  if (!error || typeof error !== "object") return null;
  const data = recordValue(error, "data");
  const cause = recordValue(error, "cause");
  for (const record of [error, data, cause, recordValue(cause, "data")]) {
    for (const key of ["responseBody", "body", "message"]) {
      const payload = parsedJson(recordValue(record, key));
      const nested = recordValue(payload, "error");
      // A stream frame's object rides in its `param` (the engine keeps only type, code, message and param).
      const found = omnirushErrorDetails(recordValue(nested, "omnirush"))
        ?? omnirushErrorDetails(recordValue(payload, "omnirush"))
        ?? omnirushErrorDetails(recordValue(parsedJson(recordValue(nested, "param")), "omnirush"));
      if (found) return found;
    }
  }
  return null;
}

/**
 * An omnirush.ai error that ends with its console page ("… earn tokens every
 * day: https://omnirush.ai/console/account"): the sentence without the link,
 * and the link as the card's "Open console" button.
 */
function consoleLinkAction(message: string | null): { text: string; action: { label: string; link: string } } | null {
  const [, text, link] = (message && /^(omnirush\.ai: [\s\S]+?):\s*(https?:\/\/\S+\/console\/account)\s*$/.exec(message)) || [];
  return text && link ? { text: `${text}.`, action: { label: "Open console", link } } : null;
}

export const interruptedTaskRecoveryPrompt = [
  "Continue the interrupted task from the current state.",
  "First inspect the conversation and workspace to verify which actions already completed.",
  "Preserve completed work, do not repeat side effects, and finish only what remains.",
].join(" ");

function recordValue(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function firstStringValue(records: unknown[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = recordValue(record, key);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function firstNumberValue(records: unknown[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = recordValue(record, key);
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return null;
}

function defaultErrorMessage(name: string | null, fallback: string) {
  if (name === "ProviderAuthError") return "Provider authentication failed";
  if (name === "MessageOutputLengthError") return "The model reached its output limit before finishing";
  if (name === "StructuredOutputError") return "The model could not produce valid structured output";
  if (name === "ContextOverflowError") return "The conversation is too large for the model context window";
  if (name === "MessageAbortedError") return "The message was interrupted";
  return fallback;
}

function sessionErrorKind(
  name: string | null,
  message: string | null,
  code: string | null,
  responseBody: string | null,
): OpencodeSessionErrorKind {
  const searchable = [name, message, code, responseBody].filter(Boolean).join(" ");
  if (/\b(?:ENOSPC|EDQUOT|SQLITE_FULL)\b|no space left on device|database or disk is full|disk quota exceeded/i.test(searchable)) {
    return "disk-full";
  }
  if (/\bSqlError\b|\bSQLITE_(?:IOERR|CANTOPEN|CORRUPT)\b/i.test(searchable)) {
    return "database-error";
  }
  if (
    name === "MessageAbortedError" ||
    code === "ABORT_ERR" ||
    /\b(?:message\s+)?abort(?:ed)?\b/i.test(searchable)
  ) {
    return "aborted";
  }
  if (
    name === "ProviderHeaderTimeoutError" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    /(?:response\s+)?headers?.{0,20}(?:timed?\s*out|timeout)/i.test(searchable)
  ) {
    return "provider-timeout";
  }
  if (/upstream_(?:incomplete|interrupted|malformed_stream|malformed_response|timeout)/.test(searchable)) return "provider-incomplete";
  if (responseBody?.includes("FreeUsageLimitError") || message?.includes("FreeUsageLimitError")) {
    return "free-model-limit";
  }
  return "generic";
}

function errorTitle(kind: OpencodeSessionErrorKind, fallback: string) {
  if (kind === "disk-full") return "Storage error reported";
  if (kind === "database-error") return "omnirush.ai couldn’t access its saved data";
  if (kind === "aborted") return "Task interrupted";
  if (kind === "provider-timeout") return "Provider did not respond in time";
  if (kind === "provider-incomplete") return "The model response was interrupted";
  if (kind === "free-model-limit") return "The free starter model is busy right now";
  return fallback;
}

function errorDescription(kind: OpencodeSessionErrorKind) {
  if (kind === "disk-full") {
    return "A storage limit was reported by the task runtime or a connected service. This does not necessarily mean your computer is full. Check the affected service or workspace before freeing local disk space.";
  }
  if (kind === "database-error") {
    return "Try again. If this keeps happening, check the available disk space on the device running this task and restart omnirush.ai. For a cloud workspace, contact its administrator.";
  }
  if (kind === "aborted") {
    return "omnirush.ai stopped before the task finished. Output and files already produced are kept.";
  }
  if (kind === "provider-timeout") {
    return "The provider connection timed out before a response began. Output and files already produced are kept.";
  }
  if (kind === "provider-incomplete") return "The response may contain partial text or incomplete tool calls. Review them before continuing.";
  if (kind === "free-model-limit") {
    return "Too many people are using the free model at once. Wait a few minutes and try again, or connect your own model provider in Settings → AI Providers to keep working.";
  }
  return null;
}

function errorRecoveryPrompt(kind: OpencodeSessionErrorKind) {
  return kind === "aborted" || kind === "provider-timeout" || kind === "provider-incomplete"
    ? interruptedTaskRecoveryPrompt
    : null;
}

function withAttachmentRecoveryHint(text: string) {
  if (!text.includes("file part media type") || !text.includes("not supported")) return text;
  return `${text}\nAn attached file in this conversation uses a format the model can't read. Revert the conversation to before the attachment was sent, or start a new session.`;
}

function withOpenAiTokenRefreshHint(text: string) {
  if (!/Token refresh failed:\s*401/i.test(text)) return text;
  return "OpenAI couldn’t renew the ChatGPT sign-in for this worker. Retry once. If it happens again, reconnect OpenAI under Connect providers → OpenAI → ChatGPT Pro/Plus.";
}

function normalizeSessionError(text: string) {
  return normalizeErrorText(withOpenAiTokenRefreshHint(withAttachmentRecoveryHint(text)), { cap: 500 }).display;
}

function sessionErrorFields(error: unknown, fallback: string) {
  if (typeof error === "string") {
    return {
      name: null,
      message: error.trim() || fallback,
      status: null,
      provider: null,
      code: null,
      retries: null,
      responseBody: null,
    };
  }
  if (!error || typeof error !== "object") {
    return {
      name: null,
      message: fallback,
      status: null,
      provider: null,
      code: null,
      retries: null,
      responseBody: null,
    };
  }

  const data = recordValue(error, "data");
  const cause = recordValue(error, "cause");
  const causeData = recordValue(cause, "data");
  const records = [error, data, cause, causeData].filter(Boolean);
  return {
    name: firstStringValue(records, ["name", "type"]),
    message: firstStringValue(records, ["message", "detail", "reason", "error"]),
    status: firstNumberValue(records, ["statusCode", "status"]),
    provider: firstStringValue(records, ["providerID", "providerId", "provider"]),
    code: firstStringValue(records, ["code", "errorCode"]),
    retries: firstNumberValue(records, ["retries", "retryCount"]),
    responseBody: firstStringValue(records, ["responseBody", "body", "response"]),
  };
}

function technicalErrorDetails(error: unknown, fallback: string, fields: ReturnType<typeof sessionErrorFields>) {
  const lines: string[] = [];
  if (fields.name) lines.push(`Error type: ${fields.name}`);
  if (fields.message) lines.push(`Message: ${fields.message}`);
  if (fields.status !== null) lines.push(`Status: ${fields.status}`);
  if (fields.provider) lines.push(`Provider: ${fields.provider}`);
  if (fields.code) lines.push(`Code: ${fields.code}`);
  if (fields.retries !== null) lines.push(`Retries: ${fields.retries}`);
  if (fields.responseBody && fields.responseBody !== fields.message) {
    lines.push(`Response: ${normalizeErrorText(fields.responseBody, { cap: 500 }).display}`);
  }
  if (lines.length > 0) {
    return normalizeErrorText(lines.join("\n"), { cap: 1_500 }).display;
  }

  const serialized = safeStringify(error);
  return normalizeErrorText(serialized && serialized !== "{}" ? serialized : fallback, { cap: 1_500 }).display;
}

/** The server's refusal of a prompt in a folder the engine cannot write to (apps/server/src/folder-write-check.ts). */
export type FolderWriteError = { reason: string; message: string; hint: string | null };

export function folderWriteError(error: unknown): FolderWriteError | null {
  let value: unknown = error instanceof Error ? error.message : error;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{") || !text.includes("workspace_not_writable")) return null;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  const records = [value, recordValue(value, "data")];
  const source = records.find((record) => recordValue(record, "error") === "workspace_not_writable");
  const message = recordValue(source, "message");
  if (!source || typeof message !== "string" || !message.trim()) return null;
  const reason = recordValue(source, "reason");
  const hint = recordValue(source, "hint");
  return { reason: typeof reason === "string" ? reason : "unknown", message: message.trim(), hint: typeof hint === "string" && hint.trim() ? hint.trim() : null };
}

export function presentOpencodeSessionError(error: unknown, fallback = "Session failed"): OpencodeSessionErrorPresentation {
  const folder = folderWriteError(error);
  if (folder) {
    return {
      kind: "folder-not-writable",
      title: folder.message,
      description: folder.hint,
      technicalDetails: `Reason: ${folder.reason}`,
      recoveryPrompt: null,
    };
  }
  const fields = sessionErrorFields(error, fallback);
  const kind = sessionErrorKind(fields.name, fields.message, fields.code, fields.responseBody);
  const consoleLink = consoleLinkAction(fields.message);
  const omnirush = sessionOmniRushDetails(error);
  // The engine's provider lock text reads as it is, without an error class name before it.
  const message = fields.message?.replace(/^[A-Za-z]+Error: (?=OmniRush models are unavailable)/, "");
  const fallbackTitle = normalizeSessionError(consoleLink?.text ?? message ?? defaultErrorMessage(fields.name, fallback));
  return {
    kind,
    title: errorTitle(kind, fallbackTitle),
    description: errorDescription(kind),
    technicalDetails: technicalErrorDetails(error, fallback, fields),
    recoveryPrompt: errorRecoveryPrompt(kind),
    ...(consoleLink ? { action: consoleLink.action } : {}),
    ...(omnirush ? { omnirush } : {}),
    ...(sessionSaysNoRetry(error) ? { noRetry: true } : {}),
  };
}

export function describeOpencodeSessionError(error: unknown, fallback = "Session failed") {
  const presentation = presentOpencodeSessionError(error, fallback);
  return presentation.description
    ? `${presentation.title}\n${presentation.description}`
    : presentation.title;
}

export function sessionErrorPresentationFromUIMessage(message: UIMessage): OpencodeSessionErrorPresentation | null {
  const part = message.parts.find((candidate) => candidate.type === "text");
  if (!part || part.type !== "text") return null;
  const metadata = part.providerMetadata?.opencode;
  if (!metadata || typeof metadata !== "object") return null;
  const sessionError = "sessionError" in metadata
    ? (metadata as { sessionError?: unknown }).sessionError
    : null;
  if (!sessionError || typeof sessionError !== "object") return null;
  const candidate = sessionError as Partial<OpencodeSessionErrorPresentation>;
  if (
    typeof candidate.kind !== "string" ||
    typeof candidate.title !== "string" ||
    !(typeof candidate.description === "string" || candidate.description === null) ||
    typeof candidate.technicalDetails !== "string" ||
    !(typeof candidate.recoveryPrompt === "string" || candidate.recoveryPrompt === null)
  ) {
    return null;
  }
  return candidate as OpencodeSessionErrorPresentation;
}
