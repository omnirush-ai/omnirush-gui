/** Coding vocabulary sent as a hint with every recording. */
export const DEV_KEYTERMS = [
  "OmniRush",
  "TypeScript",
  "JavaScript",
  "JSON",
  "YAML",
  "OAuth",
  "GitHub",
  "localhost",
  "regex",
  "gRPC",
  "API",
  "CLI",
  "MCP",
  "npm",
  "pnpm",
  "worktree",
  "subagent",
  "async",
  "README",
] as const;

const MAX_TERMS = 50;
const MAX_CHARS = 1024;

/** `feat/voice-mode_v2`, `useVoiceDictation`, `voice-core.ts` → their words. */
export function splitIdentifier(value: string): string[] {
  return value
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word));
}

export type KeytermContext = {
  /** The project folder or repository name. */
  repo?: string | null;
  branch?: string | null;
  /** Recently used file paths or names. */
  files?: readonly string[];
  extra?: readonly string[];
};

/**
 * At most 50 terms and 1024 characters: the dev list, then the repository,
 * branch and file names (whole and split into words), de-duplicated
 * case-insensitively, first occurrence wins.
 */
export function buildKeyterms(context: KeytermContext = {}): string[] {
  const candidates: string[] = [...DEV_KEYTERMS, ...(context.extra ?? [])];
  if (context.repo?.trim()) candidates.push(context.repo.trim(), ...splitIdentifier(context.repo));
  if (context.branch?.trim() && !/^(main|master|HEAD)$/.test(context.branch.trim())) candidates.push(...splitIdentifier(context.branch));
  for (const file of context.files ?? []) {
    const name = file.split(/[\\/]/).pop() ?? "";
    if (!name) continue;
    candidates.push(name, ...splitIdentifier(name));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  let chars = 0;
  for (const raw of candidates) {
    const term = raw.trim();
    const key = term.toLowerCase();
    if (!term || term.length > 64 || seen.has(key)) continue;
    if (out.length >= MAX_TERMS || chars + term.length + 1 > MAX_CHARS) break;
    seen.add(key);
    out.push(term);
    chars += term.length + 1;
  }
  return out;
}

/** Spoken forms of written dev terms. Conservative: only phrases no one says for anything else. */
const SPOKEN_FORMS: ReadonlyArray<[RegExp, string]> = [
  [/\bo(?:h)?[ -]auth\b/gi, "OAuth"],
  [/\bgit[ -]?hub\b/gi, "GitHub"],
  [/\bget[ -]hub\b/gi, "GitHub"],
  [/\btype[ -]script\b/gi, "TypeScript"],
  [/\bjava[ -]script\b/gi, "JavaScript"],
  [/\bnode[ .]?js\b/gi, "Node.js"],
  [/\bnext[ .]?js\b/gi, "Next.js"],
  [/\blocal[ -]host\b/gi, "localhost"],
  [/\bwork[ -]tree(s?)\b/gi, "worktree$1"],
  [/\bsub[ -]agent(s?)\b/gi, "subagent$1"],
  [/\bread[ -]me\b/gi, "README"],
  [/\bp[ -]?npm\b/gi, "pnpm"],
  [/\bomni[ -]rush\b/gi, "OmniRush"],
];

const EXTENSIONS = "ts|tsx|js|jsx|mjs|cjs|py|rs|go|md|json|yaml|yml|toml|css|html|sh|sql|txt";
const DOT_EXTENSION = new RegExp(`\\b([\\p{L}\\p{N}_-]+) dot (${EXTENSIONS})\\b`, "giu");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Light post-correction of a transcript: spoken dev terms to their written
 * form, "auth dot ts" to "auth.ts", and project terms with inner capitals
 * ("omni rush" / "omnirush" → "OmniRush") restored from the keyterms.
 */
export function applyKeyterms(text: string, keyterms: readonly string[] = []): string {
  let out = text;
  for (const [pattern, replacement] of SPOKEN_FORMS) out = out.replace(pattern, replacement);
  out = out.replace(DOT_EXTENSION, (_match, name: string, extension: string) => `${name}.${extension.toLowerCase()}`);
  for (const term of keyterms) {
    // Only terms whose casing carries meaning, never plain words.
    if (term.length < 4 || term === term.toLowerCase() || /[^\p{L}\p{N}]/u.test(term)) continue;
    const words = splitIdentifier(term);
    // The words must spell the whole term ("gRPC" splits to "RPC": skipped).
    if (words.join("") !== term) continue;
    const spoken = words.map(escapeRegExp).join("[ -]?");
    out = out.replace(new RegExp(`\\b${spoken}\\b`, "gi"), term);
  }
  return out;
}
