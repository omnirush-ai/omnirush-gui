// Client rules v3 ("client-v3"): what the uploader removes on the device once
// the server turns them on (`policy.redaction_v3` in GET /archives/key).
// Credentials only, at high precision, the variable name always kept; personal
// data (e-mail, phone, SSN, IPv4) is left to the server's export pass, and
// opaque data (encrypted reasoning, signatures, base64 blobs, `data:` URIs) is
// never touched. Until the server says so the uploader keeps its old rules.
//
// The same file in omnirush-cli (assets/extensions/omnirush/capture/context/)
// and omnirush-gui (apps/server/src/context/), listed in PARITY.sha256; the
// backend runs the same vectors (redact-vectors.json) against its port
// (omnirush/credential_rules.py).

export const CLIENT_V3 = "client-v3";
export type RedactionPolicy = "legacy" | typeof CLIENT_V3;

// One switch per process, kept on globalThis so every copy of this module
// (a bundle, a loader without a module cache) reads the same answer.
const STATE = Symbol.for("omnirush.redactionPolicy");
type PolicyHolder = { [STATE]?: RedactionPolicy };

/** Switches the uploader's rules; anything but `client-v3` is the old rule set. */
export function setRedactionPolicy(policy: string | null | undefined): void {
  (globalThis as PolicyHolder)[STATE] = policy === CLIENT_V3 ? CLIENT_V3 : "legacy";
}

export function redactionPolicy(): RedactionPolicy {
  return (globalThis as PolicyHolder)[STATE] === CLIENT_V3 ? CLIENT_V3 : "legacy";
}

export function redactionV3(): boolean {
  return redactionPolicy() === CLIENT_V3;
}

const REDACTED = "[REDACTED]";

/** JSON keys whose string values are opaque provider data, never scanned. */
const OPAQUE_KEYS = new Set([
  "reasoningencryptedcontent", "reasoning_encrypted_content", "encrypted_content", "encryptedcontent",
  "signature", "thinkingsignature", "thinking_signature", "redacted_thinking", "redactedthinking",
]);

export function isOpaqueKey(key: string | undefined): boolean {
  return key !== undefined && OPAQUE_KEYS.has(key.toLowerCase());
}

// A run of base64 or base64url characters this long with no break is a blob
// (encrypted content, an image, a signature), not a credential.
const OPAQUE_RUN = /[A-Za-z0-9+/_-]{200,}={0,2}/g;
const DATA_URI = /data:[A-Za-z0-9.+/-]*(?:;[A-Za-z0-9.+=-]+)*,[A-Za-z0-9+/=%._~-]*/g;

/** A whole string that is a `data:` URI or one base64 blob. */
export function isOpaqueString(value: string): boolean {
  if (value.startsWith("data:") && /^data:[A-Za-z0-9.+/-]*(?:;[A-Za-z0-9.+=-]+)*,/.test(value)) return true;
  return value.length >= 200 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(value);
}

function opaqueSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (text.length < 200 && !text.includes("data:")) return spans;
  for (const pattern of [OPAQUE_RUN, DATA_URI]) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      spans.push([match.index, match.index + match[0].length]);
    }
  }
  return spans;
}

/** A match lies inside an opaque span (and is not the whole span: a long token on its own still counts). */
function insideOpaque(spans: Array<[number, number]>, start: number, end: number): boolean {
  return spans.some(([from, to]) => start >= from && end <= to && !(start === from && end === to));
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  const length = [...value].length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Code and template characters: a value holding one is an expression
// (`response.data?.[KEY]`, `{apiKey}`, `settings.KEY)`), never a literal.
const CODE_CHARS = /[\s[\]{}()<>`\\]|\?[.[]|\$[{(]/;
const CONSTANT_NAME = /^[A-Z]+(?:_[A-Z0-9]+)*$/;
const DOTTED_NAME = /^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)+$/;

/**
 * A generated-looking literal: 12+ characters with no code or template
 * characters, letters and digits both (or 20+ characters with both cases
 * about equally), 3.0+ bits per character, and not a constant's name
 * (`OPENAI_API_KEY`) or a dotted name (`settings.token`). Words joined by
 * dashes (`dev-password`) are not generated.
 */
export function looksRandom(value: string): boolean {
  if (value.length < 12 || CODE_CHARS.test(value) || CONSTANT_NAME.test(value) || DOTTED_NAME.test(value)) return false;
  const digits = /[0-9]/.test(value);
  const upper = value.replace(/[^A-Z]/g, "").length;
  const lower = value.replace(/[^a-z]/g, "").length;
  // Without digits, only a long run whose case is balanced like random
  // text (a camelCase name is mostly lower case).
  const balanced = value.length >= 20 && upper >= 0.3 * (upper + lower) && lower >= 0.3 * (upper + lower);
  if (!((upper + lower > 0 && digits) || balanced)) return false;
  return shannonEntropy(value) >= 3.0;
}

function charClass(char: string): string | undefined {
  return /[0-9]/.test(char) ? "d" : /[A-Z]/.test(char) ? "u" : /[a-z]/.test(char) ? "l" : undefined;
}

/**
 * An unquoted value with a name's shape that is still generated
 * (`client-secret=Xk7pQ2vR...` in a `.properties` file): 16+ characters,
 * no dot, two classes, 3.5+ bits per character, and the class changes
 * between neighbours (digit, upper, lower; a capital starting a word does
 * not count) at 30%+ of them. Names change class only between words.
 */
export function looksRandomName(value: string): boolean {
  if (value.length < 16 || value.includes(".")) return false;
  const classes = Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/[0-9]/.test(value));
  if (classes < 2 || shannonEntropy(value) < 3.5) return false;
  let pairs = 0;
  let changes = 0;
  for (let index = 1; index < value.length; index += 1) {
    const before = charClass(value[index - 1]!);
    const after = charClass(value[index]!);
    if (before === undefined || after === undefined) continue;
    pairs += 1;
    if (before !== after && !(before === "u" && after === "l")) changes += 1;
  }
  return pairs > 0 && changes >= 0.3 * pairs;
}

/**
 * Credential files: any non-placeholder value of a secret-named key there is
 * a credential. `.env*` except examples and templates, `.npmrc`, `.pypirc`,
 * `.netrc`, `.pgpass`, `.git-credentials`, `credentials` (`.aws/credentials`),
 * kubeconfig.
 */
export function isCredentialFile(path: string | undefined): boolean {
  if (!path) return false;
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  if (name.startsWith(".env")) return !/(?:example|sample|template|dist|defaults?)$/.test(name);
  return [".npmrc", ".pypirc", ".netrc", "_netrc", ".pgpass", ".git-credentials", "credentials", "kubeconfig", "config.kube"].includes(name)
    || name.endsWith(".kubeconfig");
}

// --- secret-named assignments ----------------------------------------------

// Python's `\s`, so a value ends where the backend's does.
const WS = String.raw`\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const KEYWORD = String.raw`secret|passw(?:or)?d|pwd|token|credential|auth|(?:api|access|private|client|session|signing|master|encryption)[_.:-]?key`;
const ASSIGNMENT_BODY = String.raw`(\\?["']?)((?=[\w.-]{0,63}?(?:${KEYWORD}))[A-Za-z_-][\w.-]{0,63})\1[ \t]*[=:][ \t]*`
  + String.raw`(?:"((?:[^"${WS}\\]|\\[^${WS}]){8,})"`
  + String.raw`|'((?:[^'${WS}\\]|\\[^${WS}]){8,})'`
  + String.raw`|\\"((?:[^"${WS}\\]|\\[^"${WS}]){8,})\\"`
  // An unquoted value ends at an escaped line break or tab (`KEY=value\n+NEXT=...`).
  + String.raw`|((?:[^${WS}"',;&\\]|\\[^${WS}nrt]){8,}))`;
const CONFIG_ASSIGNMENT = new RegExp(String.raw`(?:(?<![\w.\\-])|(?<=\\[nrt]))` + ASSIGNMENT_BODY, "gi");
// In code the name follows a space, an opening bracket, a quote, `+`, `#` or
// a sigil (`$password = '...'` in PHP, Perl, PowerShell).
const SOURCE_ASSIGNMENT = new RegExp(String.raw`(?:(?<![^${WS}\x80-\uffff{,("'\x60+#$])|(?<=\\[nrt]))` + ASSIGNMENT_BODY, "gi");

const SECRET_SEGMENTS = new Set([
  "secret", "secrets", "password", "passwords", "passwd", "pwd", "token", "credential", "credentials",
  "auth", "authorization", "authtoken", "authkey", "apikey", "pgpassword",
]);
const SECRET_PAIRS: Array<[string, string]> = [
  ["api", "key"], ["access", "key"], ["secret", "key"], ["private", "key"], ["client", "key"], ["client", "secret"],
  ["session", "key"], ["signing", "key"], ["master", "key"], ["encryption", "key"],
];
const EXCLUDED_LAST = new Set([
  "length", "ttl", "seconds", "count", "size", "url", "path", "name", "id", "header",
  "file", "filename", "dir", "mode", "method", "role", "owner", "type", "kind", "enabled", "estimate", "hash", "digest", "at",
  "config", "client", "prefix", "suffix", "format", "scheme", "provider", "status", "state", "label", "description", "title",
  "class", "field", "fields", "list", "names", "version", "timeout", "limit", "max", "min", "interval", "retries", "port",
  "in", "out", "percent", "pct", "ms", "secs", "minutes", "hours", "days", "expires", "expiry", "expiration", "bytes", "len",
  "width", "height", "offset", "index", "idx", "pos", "total", "sum", "avg", "ratio", "rate", "threshold", "weight", "score",
  "encryption", "algorithm", "algo", "cipher", "strategy", "policy", "source", "target", "origin", "backend", "engine", "driver",
  "handler", "callback", "event", "action", "reason", "message", "error", "envelope", "ref", "reference", "link", "pointer", "alias",
]);

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_.:-]+/)
    .filter(Boolean);
}

/** Whether a key names a secret (`auth_token`, `APIKey`, `client_secret`; not `author`, `token_url`, `accessKeyId`). */
export function isSecretKey(key: string): boolean {
  const segments = keySegments(key);
  const last = segments.at(-1);
  if (last === undefined || EXCLUDED_LAST.has(last)) return false;
  return segments.some((segment, index) => SECRET_SEGMENTS.has(segment)
    || SECRET_PAIRS.some(([first, second]) => segment === `${first}${second}` || (segment === first && segments[index + 1] === second)));
}

const PLACEHOLDER_MARKERS = new Set([
  "your", "yours", "here", "fake", "dummy", "example", "sample", "placeholder", "changeme", "replaceme", "replace", "insert",
  "todo", "fixme", "tbd", "mock", "demo", "redacted", "notreal", "test", "testing",
]);
const PLACEHOLDER_WORDS = new Set([
  "my", "the", "a", "an", "not", "real", "is", "goes", "go", "put", "enter", "set", "this", "to", "with", "of", "for", "in", "me",
  "change", "secret", "secrets", "token", "tokens", "key", "keys", "api", "apikey", "password", "passwd", "pass", "pwd", "value",
  "access", "auth", "private", "client", "id", "string", "foo", "bar", "baz", "qux", "abc", "xyz", "default", "dev", "local",
]);
const REPEATED_CHAR = /^(.)\1*$/su;

/** `your-token-here`, `changeme`, `xxxxxxxx`, `YOUR_API_KEY`: never a secret. */
export function isPlaceholder(value: string): boolean {
  const segments = keySegments(value);
  if (segments.length === 0) return false;
  let marked = false;
  for (const segment of segments) {
    if (PLACEHOLDER_MARKERS.has(segment) || ([...segment].length >= 3 && REPEATED_CHAR.test(segment))) marked = true;
    else if (PLACEHOLDER_WORDS.has(segment) || (/^[0-9]+$/.test(segment) && (segment.length <= 4 || "0123456789".includes(segment)))) continue;
    else return false;
  }
  return marked;
}

/** A variable or an expression, never a literal: `$VAR`, `${...}`, `$(...)`, `%VAR%`, `process.env.X`, `os.environ[...]`, `getenv(`. */
export function isReference(value: string): boolean {
  return /^\$[A-Za-z_]\w*$/.test(value) || value.includes("${") || value.includes("$(") || /^%[A-Za-z_]\w*%$/.test(value)
    || /(?:^|\W)(?:process\.env|import\.meta\.env|os\.environ|getenv\(|ENV\[|env\()/.test(value)
    || /^(?:process|os|env|self|this|config|settings|secrets|vars|inputs)\./.test(value)
    || /\{\{[^}]*\}\}|\{%[^%]*%\}/.test(value);
}

const PATH_VALUE = /^(?:\/|\.\/|\.\.\/|~\/|[A-Za-z]:[\\/])/;
const IDENTIFIER_VALUE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

export type ValueContext = { mode?: "source" | "config"; quoted?: boolean; credentialFile?: boolean };

/**
 * The value of a secret-named key is removed when it is a literal that looks
 * generated (12+ characters, two classes, 3.0+ bits), carries a known token,
 * or sits in a credential file. Never a reference, a placeholder, a path or
 * an earlier marker; in source code only a quoted literal.
 */
export function isSecretValue(value: string, context: ValueContext = {}): boolean {
  if (value.length < 8 || new RegExp(`[${WS}]`).test(value) || value.startsWith("[REDACTED")) return false;
  if (isReference(value) || isPlaceholder(value)) return false;
  if (value.startsWith("<") && value.endsWith(">")) return false;
  if (PATH_VALUE.test(value) || (value.includes("/") && !/\d/.test(value))) return false;
  if (containsKnownToken(value)) return true;
  if (value.includes("(")) return false;
  if (context.credentialFile) return true;
  if (context.mode === "source" && !context.quoted) return false;
  if (!context.quoted && IDENTIFIER_VALUE.test(value)) return looksRandomName(value);
  return looksRandom(value);
}

// --- known token shapes ----------------------------------------------------

/** Start of a token: never inside a word or on an escape's letter; right after `\n`/`\r`/`\t` escapes still counts. */
function token(source: string, flags = "g"): RegExp {
  return new RegExp(String.raw`(?:(?<![A-Za-z0-9_\\])|(?<=\\[nrt]))(?:${source})`, flags);
}

type TokenRule = { name: string; gate: string | RegExp; pattern: RegExp; check?: (match: string) => boolean; keep?: number };

function jwtHeader(match: string): boolean {
  try {
    const header = JSON.parse(Buffer.from(match.slice(0, match.indexOf(".")), "base64url").toString("utf8")) as unknown;
    return typeof header === "object" && header !== null && !Array.isArray(header) && "alg" in header;
  } catch {
    return false;
  }
}

const TOKEN_RULES: TokenRule[] = [
  { name: "aws_access_key_id", gate: /AKIA|ASIA/, pattern: token(String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])`), check: (m) => !m.endsWith("EXAMPLE") },
  { name: "github_token", gate: /gh[pousr]_/, pattern: token(String.raw`gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])`) },
  { name: "github_pat", gate: "github_pat_", pattern: token(String.raw`github_pat_[A-Za-z0-9_]{60,}`) },
  { name: "gitlab_token", gate: "glpat-", pattern: token(String.raw`glpat-[A-Za-z0-9_-]{20,}`) },
  { name: "slack_token", gate: /xox[abprs]-/, pattern: token(String.raw`xox[abprs]-[A-Za-z0-9-]{10,}`) },
  { name: "slack_webhook", gate: "hooks.slack.com", pattern: /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/)([A-Za-z0-9]{20,})/g, keep: 1 },
  { name: "discord_webhook", gate: "/api/webhooks/", pattern: /(https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)([A-Za-z0-9_-]{50,})/g, keep: 1 },
  { name: "google_api_key", gate: "AIza", pattern: token(String.raw`AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])`) },
  { name: "stripe_key", gate: /[sr]k_live_/, pattern: token(String.raw`[sr]k_live_[A-Za-z0-9]{16,}`) },
  { name: "stripe_webhook", gate: "whsec_", pattern: token(String.raw`whsec_[A-Za-z0-9+/=]{24,}`) },
  { name: "anthropic_key", gate: "sk-ant-", pattern: token(String.raw`sk-ant-(?:api|admin)\d\d-[A-Za-z0-9_-]{32,}`) },
  { name: "openai_key", gate: "sk-", pattern: token(String.raw`sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|sk-[A-Za-z0-9]{48}(?![A-Za-z0-9])`), check: (m) => shannonEntropy(m) >= 3.5 },
  { name: "npm_token", gate: "npm_", pattern: token(String.raw`npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])`) },
  { name: "pypi_token", gate: "pypi-AgE", pattern: token(String.raw`pypi-AgE[A-Za-z0-9_-]{50,}`) },
  { name: "huggingface_token", gate: "hf_", pattern: token(String.raw`hf_[A-Za-z0-9]{34,}(?![A-Za-z0-9])`) },
  { name: "sendgrid_key", gate: "SG.", pattern: token(String.raw`SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])`) },
  { name: "jwt", gate: "eyJ", pattern: token(String.raw`eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`), check: jwtHeader },
  { name: "discord_token", gate: /[MN][\w-]{23,}\./, pattern: token(String.raw`[MN][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}`), check: (m) => shannonEntropy(m) >= 3.5 },
];

function gateOpen(gate: string | RegExp, text: string): boolean {
  return typeof gate === "string" ? text.includes(gate) : gate.test(text);
}

/** Whether a value holds one known credential token (its whole shape and checks). */
export function containsKnownToken(value: string): boolean {
  for (const rule of TOKEN_RULES) {
    if (!gateOpen(rule.gate, value)) continue;
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(value); match; match = rule.pattern.exec(value)) {
      const secret = rule.keep ? match[rule.keep + 1]! : match[0];
      if (!rule.check || rule.check(secret)) return true;
    }
  }
  return false;
}

// --- the text pass ---------------------------------------------------------

export type CredentialOptions = {
  /** The file path or JSON key the text belongs to. */
  context?: string;
  /** Source code (quoted literals only) or config/trace text. */
  mode?: "source" | "config";
  /** The enclosing JSON object names an AWS key. */
  awsContext?: boolean;
  /** What a removed value is written as; `[REDACTED]` by default. */
  replacement?: string;
};

type Tally = { count: number; rules: Record<string, number> };

function note(tally: Tally, rule: string): void {
  tally.count += 1;
  tally.rules[rule] = (tally.rules[rule] ?? 0) + 1;
}

const PRIVATE_KEY = /(?<!\\)(-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----)([\s\S]*?)(-----END \2-----)/g;

function redactPrivateKeys(text: string, hidden: string, tally: Tally): string {
  PRIVATE_KEY.lastIndex = 0;
  return text.replace(PRIVATE_KEY, (match: string, begin: string, _kind: string, body: string, end: string) => {
    const plain = body.replace(/\\[nrt]/g, " ");
    if (plain.includes("...") || plain.includes("…") || plain.replace(/[^A-Za-z0-9+/=]/g, "").length < 64) return match;
    const lead = /^(?:\s|\\[nr])*/.exec(body)![0];
    const trail = /(?:\s|\\[nr])*$/.exec(body)![0];
    note(tally, "private_key");
    return `${begin}${lead}${hidden}${trail}${end}`;
  });
}

const URL_PASSWORD = new RegExp(
  String.raw`(?:(?<![A-Za-z0-9_\\])|(?<=\\[nrt]))([a-z][a-z0-9+.-]{0,31}://)((?:[^${WS}/@:\\]|\\[^${WS}])*):((?:[^${WS}/@\\]|\\[^${WS}])+)@`,
  "gi",
);
const URL_PASSWORD_PLACEHOLDERS = new Set(["password", "pass", "passwd", "pwd", "secret", "changeme", "xxx", "***", "<password>", "[redacted]"]);

function urlPasswordPlaceholder(password: string): boolean {
  const lowered = password.toLowerCase();
  return URL_PASSWORD_PLACEHOLDERS.has(lowered) || lowered.startsWith("[redacted") || isReference(password) || /^<[^>]*>$/.test(password)
    || /^\*+$/.test(password) || isPlaceholder(password);
}

function redactUrlPasswords(text: string, hidden: string, tally: Tally, spans: Array<[number, number]>): string {
  URL_PASSWORD.lastIndex = 0;
  return text.replace(URL_PASSWORD, (match: string, scheme: string, user: string, password: string, offset: number) => {
    if (insideOpaque(spans, offset, offset + match.length) || urlPasswordPlaceholder(password)) return match;
    note(tally, "url_password");
    return `${scheme}${user}:${hidden}@`;
  });
}

const MAX_ASSIGNMENT_DEPTH = 4;

/** Shell scripts: there an unquoted `NAME=value` is a literal, never an expression. */
export function isShellFile(path: string | undefined): boolean {
  return path !== undefined && /\.(?:sh|bash|zsh|ksh)$/i.test(path);
}

// A query parameter that carries a one-time credential although its name ends
// in a word the key rules skip (`?token_hash=` in Supabase sign-in links).
const QUERY_SECRET_KEYS = new Set(["token hash"]);

type AssignmentContext = { mode: "source" | "config"; credentialFile: boolean; shellFile: boolean };

function redactAssignments(
  text: string, hidden: string, tally: Tally, context: AssignmentContext, spans: Array<[number, number]>, depth = 0,
): string {
  const { mode, credentialFile, shellFile } = context;
  // A fresh expression per call: the pass recurses into values while the outer replace is still running.
  const pattern = new RegExp(mode === "source" ? SOURCE_ASSIGNMENT : CONFIG_ASSIGNMENT);
  return text.replace(pattern, (match: string, _quote: string, key: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, escapedQuoted: string | undefined, bare: string | undefined, offset: number) => {
    if (depth === 0 && insideOpaque(spans, offset, offset + match.length)) return match;
    const value = doubleQuoted ?? singleQuoted ?? escapedQuoted ?? bare ?? "";
    const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : escapedQuoted !== undefined ? '\\"' : "";
    const prefix = match.slice(0, match.length - value.length - quote.length * 2);
    // A URL query value (`?name=value&`) and a shell `NAME=value` are literals like a quoted one.
    const query = bare !== undefined && offset > 0 && (text[offset - 1] === "?" || text[offset - 1] === "&");
    const shellLiteral = shellFile && bare !== undefined && prefix === `${key}=` && !/[$`]/.test(value);
    const secretKey = isSecretKey(key) || (query && QUERY_SECRET_KEYS.has(keySegments(key).join(" ")));
    if (secretKey && isSecretValue(value, { mode: query || shellLiteral ? "config" : mode, quoted: bare === undefined || query || shellLiteral, credentialFile })) {
      note(tally, "secret_assignment");
      return `${prefix}${quote}${hidden}${quote}`;
    }
    if (depth >= MAX_ASSIGNMENT_DEPTH) return match;
    return `${prefix}${quote}${redactAssignments(value, hidden, tally, context, [], depth + 1)}${quote}`;
  });
}

const ASSIGNMENT_GATE = /secret|passw|pwd|token|credential|auth|key/i;

// A label on its own line and the value alone on the next one (notes,
// READMEs, `.txt` and `.properties` files): `API_KEY:` then `abc123...`, one
// blank line between them allowed. The whole value line must be one token;
// it is judged like any other value. Line by line, so a label right under
// another empty label is still read.
// Python's `\s` without the line break, so both ports split values alike.
const HS = String.raw`\t\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const LABEL_LINE = new RegExp(String.raw`^([${HS}]*[-*#>]*[${HS}]*[*_\x60"']*)([A-Za-z_][\w.-]{0,63})([*_\x60"']*[${HS}]*[:=][${HS}]*[*_\x60"']*)$`);
const VALUE_LINE = new RegExp(String.raw`^([${HS}]*)([\x60"']?)([^${WS}\x60"']{12,})\2([${HS}]*)$`);
const BLANK_LINE = new RegExp(String.raw`^[${HS}]*$`);

function redactNextLineValues(text: string, hidden: string, tally: Tally, credentialFile: boolean, spans: Array<[number, number]>): string {
  const lines = text.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  let changed = false;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const label = LABEL_LINE.exec(lines[index]!);
    if (!label || !isSecretKey(label[2]!)) continue;
    let target = index + 1;
    if (BLANK_LINE.test(lines[target]!) && target + 1 < lines.length) target += 1;
    const found = VALUE_LINE.exec(lines[target]!);
    if (!found) continue;
    const value = found[3]!;
    // The next line is an assignment of its own (`API_KEY=` left empty above `OTHER=value`).
    if (/^[A-Za-z_][\w.-]*[:=]/.test(value)) continue;
    if (insideOpaque(spans, starts[index]!, starts[target]! + lines[target]!.length)) continue;
    if (!isSecretValue(value, { mode: "config", quoted: true, credentialFile })) continue;
    note(tally, "secret_assignment");
    lines[target] = `${found[1]!}${found[2]!}${hidden}${found[2]!}${found[4]!}`;
    changed = true;
  }
  return changed ? lines.join("\n") : text;
}

const AWS_ID = /(?:AKIA|ASIA)[0-9A-Z]{16}/;
const AWS_CONTEXT = /(?:AKIA|ASIA)[0-9A-Z]{16}|aws[_ .-]?secret[_ .-]?access[_ .-]?key/i;
const AWS_SECRET = token(String.raw`[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])`);

function redactAwsSecrets(text: string, hidden: string, tally: Tally, nearContext: boolean, spans: Array<[number, number]>): string {
  if (!nearContext && !AWS_CONTEXT.test(text)) return text;
  if (!/[A-Za-z0-9/+]{40}/.test(text)) return text;
  const lines = text.split("\n");
  const context = lines.map((line) => AWS_CONTEXT.test(line));
  let offset = 0;
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const start = offset;
    offset += line.length + 1;
    if (line.length < 40) continue;
    let near = nearContext;
    for (let other = Math.max(0, index - 3); !near && other <= Math.min(lines.length - 1, index + 3); other += 1) near = context[other]!;
    if (!near) continue;
    AWS_SECRET.lastIndex = 0;
    lines[index] = line.replace(AWS_SECRET, (candidate: string, at: number) => {
      if (!/[a-z]/.test(candidate) || !/[A-Z]/.test(candidate) || !/\d/.test(candidate) || AWS_ID.test(candidate)) return candidate;
      if (insideOpaque(spans, start + at, start + at + candidate.length) || shannonEntropy(candidate) < 3.5) return candidate;
      note(tally, "aws_secret");
      changed = true;
      return hidden;
    });
  }
  return changed ? lines.join("\n") : text;
}

function redactTokens(text: string, hidden: string, tally: Tally, spans: Array<[number, number]>): string {
  for (const rule of TOKEN_RULES) {
    if (!gateOpen(rule.gate, text)) continue;
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      const offset = args.find((arg, index) => index > 0 && typeof arg === "number") as number;
      const secret = rule.keep ? args[rule.keep + 1] as string : match;
      if (rule.check && !rule.check(secret)) return match;
      if (insideOpaque(spans, offset, offset + match.length)) return match;
      note(tally, rule.name);
      return rule.keep ? `${args[rule.keep] as string}${hidden}` : hidden;
    });
  }
  return text;
}

const AUTH_HEADER = /(?<![A-Za-z0-9_])((?:Bearer|Basic)[ \t]+)([A-Za-z0-9_.~+/=-]{16,})/gi;

function authSecret(token: string): boolean {
  if (shannonEntropy(token) < 3.0 || isPlaceholder(token)) return false;
  if (/\d/.test(token)) return true;
  return token.length >= 20 && /[a-z]/.test(token) && /[A-Z]/.test(token) && !IDENTIFIER_VALUE.test(token);
}

function redactAuthHeaders(text: string, hidden: string, tally: Tally, spans: Array<[number, number]>): string {
  AUTH_HEADER.lastIndex = 0;
  return text.replace(AUTH_HEADER, (match: string, prefix: string, value: string, offset: number) => {
    if (!authSecret(value) || insideOpaque(spans, offset, offset + match.length)) return match;
    note(tally, "auth_header");
    return `${prefix}${hidden}`;
  });
}

/**
 * Removes credentials from free text (a trace string, a file, a diff), the
 * name always kept: private key bodies, URL passwords, secret-named values
 * that look generated (any value in a credential file), AWS secrets beside
 * their key id, known token shapes and `Bearer`/`Basic` values. Nothing
 * inside a `data:` URI or a base64 blob is touched.
 */
export function redactCredentials(input: string, options: CredentialOptions = {}): { text: string; count: number; rules: Record<string, number> } {
  const tally: Tally = { count: 0, rules: {} };
  if (!input) return { text: input, count: 0, rules: tally.rules };
  const hidden = options.replacement ?? REDACTED;
  const credentialFile = isCredentialFile(options.context);
  let text = input.includes("-----BEGIN ") ? redactPrivateKeys(input, hidden, tally) : input;
  if (text.includes("://")) text = redactUrlPasswords(text, hidden, tally, opaqueSpans(text));
  if (ASSIGNMENT_GATE.test(text)) {
    text = redactAssignments(text, hidden, tally, { mode: options.mode ?? "config", credentialFile, shellFile: isShellFile(options.context) }, opaqueSpans(text));
    if (text.includes("\n") && options.mode !== "source") text = redactNextLineValues(text, hidden, tally, credentialFile, opaqueSpans(text));
  }
  const nearAws = options.awsContext === true || (options.context !== undefined && AWS_CONTEXT.test(options.context));
  text = redactAwsSecrets(text, hidden, tally, nearAws, opaqueSpans(text));
  text = redactTokens(text, hidden, tally, opaqueSpans(text));
  if (/bearer|basic/i.test(text)) text = redactAuthHeaders(text, hidden, tally, opaqueSpans(text));
  return { text, count: tally.count, rules: tally.rules };
}
