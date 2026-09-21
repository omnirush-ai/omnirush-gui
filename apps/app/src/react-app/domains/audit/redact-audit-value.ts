const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const SENSITIVE_KEY = /(authorization|cookie|api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|secret|credential|private[-_]?key)/i;
const SECRET_VALUE = /(?:bearer\s+[a-z0-9._~+/=-]{8,}|(?:sk|rk|gh[pousr]|xox[baprs])-[-_a-z0-9]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [^-]+ PRIVATE KEY-----)/i;
const SENSITIVE_QUERY = /^(authorization|token|access_token|refresh_token|api_key|apikey|password|secret|credential)$/i;

export type RedactAuditValueOptions = {
  maxDepth?: number;
  maxStringLength?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
  environmentValues?: readonly string[];
};

export type RedactedAuditValue = {
  value: unknown;
  redacted: boolean;
};

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function isEnvironmentValue(value: string, values: readonly string[]): boolean {
  return values.some((candidate) => candidate.length > 0 && candidate === value);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key)) {
        url.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? url.toString() : value;
  } catch {
    return value;
  }
}

function walk(value: unknown, options: Required<RedactAuditValueOptions>, depth: number, seen: WeakSet<object>): RedactedAuditValue {
  if (depth > options.maxDepth) return { value: TRUNCATED, redacted: true };
  if (typeof value === "string") {
    if (isEnvironmentValue(value, options.environmentValues) || SECRET_VALUE.test(value)) return { value: REDACTED, redacted: true };
    const url = redactUrl(value);
    if (url !== value) return { value: url, redacted: true };
    if (value.length > options.maxStringLength) return { value: `${value.slice(0, options.maxStringLength)}${TRUNCATED}`, redacted: true };
    return { value, redacted: false };
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return { value, redacted: false };
  if (typeof value === "bigint") return { value: String(value), redacted: false };
  if (typeof value === "object" && seen.has(value)) return { value: TRUNCATED, redacted: true };
  if (typeof value === "object") seen.add(value);
  if (Array.isArray(value)) {
    let redacted = value.length > options.maxArrayLength;
    const result = value.slice(0, options.maxArrayLength).map((item) => {
      const next = walk(item, options, depth + 1, seen); redacted ||= next.redacted; return next.value;
    });
    if (value.length > options.maxArrayLength) result.push(TRUNCATED);
    return { value: result, redacted };
  }
  if (typeof value === "object") {
    let redacted = false;
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, item] of entries.slice(0, options.maxObjectKeys)) {
      if (isSensitiveKey(key)) { result[key] = REDACTED; redacted = true; continue; }
      const next = walk(item, options, depth + 1, seen); result[key] = next.value; redacted ||= next.redacted;
    }
    if (entries.length > options.maxObjectKeys) { result.__truncated__ = TRUNCATED; redacted = true; }
    return { value: result, redacted };
  }
  return { value: String(value), redacted: true };
}

/** Redact and bound arbitrary OpenCode input/output before rendering or export. */
export function redactAuditValue(value: unknown, options: RedactAuditValueOptions = {}): unknown {
  return walk(value, {
    maxDepth: options.maxDepth ?? 6,
    maxStringLength: options.maxStringLength ?? 4_096,
    maxArrayLength: options.maxArrayLength ?? 64,
    maxObjectKeys: options.maxObjectKeys ?? 64,
    environmentValues: options.environmentValues ?? [],
  }, 0, new WeakSet()).value;
}

export function redactAuditValueWithMetadata(value: unknown, options: RedactAuditValueOptions = {}): RedactedAuditValue {
  return walk(value, {
    maxDepth: options.maxDepth ?? 6,
    maxStringLength: options.maxStringLength ?? 4_096,
    maxArrayLength: options.maxArrayLength ?? 64,
    maxObjectKeys: options.maxObjectKeys ?? 64,
    environmentValues: options.environmentValues ?? [],
  }, 0, new WeakSet());
}

export function redactAuditText(value: unknown, options?: RedactAuditValueOptions): string {
  const redacted = redactAuditValue(value, options);
  return typeof redacted === "string" ? redacted : JSON.stringify(redacted);
}

export { REDACTED as AUDIT_REDACTED_VALUE };
