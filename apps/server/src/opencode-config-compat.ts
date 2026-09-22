/**
 * Pre-flight compatibility check for user-owned OpenCode config files.
 *
 * The bundled engine (OpenCode V1, pinned in constants.json) lowers V2-style
 * config on load (packages/opencode/src/config/v2-compat.ts). Most V2 keys
 * degrade to a "configuration compatibility diagnostic" warning, but a
 * `permissions` key — top-level, or under `agent`/`agents`/`mode.<name>` — is
 * fatal since 1.18.32: the engine throws ConfigInvalidError. In the global
 * config that aborts `opencode serve` at boot (exit 1); in a workspace config
 * every instance-scoped route for that directory answers 400 ConfigInvalidError.
 *
 * This module mirrors that one fatal rule so the server can name the file and
 * the offending keys before the engine is spawned, and translates the engine's
 * ConfigInvalidError response body into an actionable API error instead of a
 * generic opencode_request_failed.
 */
import { join } from "node:path";
import { globalOpencodeConfigDir, workspaceOpencodeConfigCandidates } from "@omnirush/paths";
import { readJsoncFile } from "./jsonc.js";

export const OPENCODE_V2_PERMISSIONS_MESSAGE =
  'V2 permissions are not supported by OpenCode V1. Use V1 "permission" rules or run opencode2.';

export const OPENCODE_CONFIG_COMPAT_HINT =
  'Rename "permissions" to "permission" (OpenCode V1 rules) or remove it, then restart OmniRush.ai.';

export type OpencodeConfigCompatScope = "global" | "workspace";

export type OpencodeConfigCompatIssue = { path: string[]; message: string };

export type OpencodeConfigCompatFinding = {
  /** "global" files abort the engine at boot; "workspace" files break that directory's instance. */
  scope: OpencodeConfigCompatScope;
  file: string;
  issues: OpencodeConfigCompatIssue[];
};

export type OpencodeConfigErrorBody = {
  name: string;
  file: string | null;
  message: string;
  issues: OpencodeConfigCompatIssue[];
};

type CompatLogger = {
  log: (level: "warn" | "error", message: string, attributes?: Record<string, unknown>) => void;
};

/** Engine error names the HTTP error middleware answers with status 400 and `{ name, data }`. */
const OPENCODE_CONFIG_ERROR_NAMES = new Set([
  "ConfigInvalidError",
  "ConfigJsonError",
  "ConfigFrontmatterError",
  "ConfigDirectoryTypoError",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Mirror of the engine's fatal rule in ConfigV2Compat.lower: a `permissions`
 * key at the top level or directly under any `agents`/`agent`/`mode` entry.
 * Key presence is what the engine checks, so the value is irrelevant.
 */
export function findUnsupportedV2PermissionPaths(config: unknown): string[][] {
  if (!isRecord(config)) return [];
  const paths: string[][] = [];
  if (Object.hasOwn(config, "permissions")) paths.push(["permissions"]);
  for (const key of ["agents", "agent", "mode"]) {
    const agents = config[key];
    if (!isRecord(agents)) continue;
    for (const [name, agent] of Object.entries(agents)) {
      if (isRecord(agent) && Object.hasOwn(agent, "permissions")) paths.push([key, name, "permissions"]);
    }
  }
  return paths;
}

/** Files the engine merges into its global config at boot, in load order. */
export function globalOpencodeConfigFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = globalOpencodeConfigDir({ env });
  return ["config.json", "opencode.json", "opencode.jsonc"].map((name) => join(dir, name));
}

/** Files the engine merges into a workspace instance's config. */
export function workspaceOpencodeConfigFiles(workspaceRoot: string): string[] {
  return workspaceOpencodeConfigCandidates(workspaceRoot);
}

export async function inspectOpencodeConfigFile(
  scope: OpencodeConfigCompatScope,
  file: string,
): Promise<OpencodeConfigCompatFinding | null> {
  let data: unknown;
  try {
    // Unreadable or malformed files are the engine's own (pre-existing)
    // ConfigJsonError; this check only covers the rule introduced by 1.18.32.
    const result = await readJsoncFile<unknown>(file, null, { allowInvalid: true });
    if (result.missing || result.invalid) return null;
    data = result.data;
  } catch {
    return null;
  }
  const paths = findUnsupportedV2PermissionPaths(data);
  if (paths.length === 0) return null;
  return {
    scope,
    file,
    issues: paths.map((path) => ({ path, message: OPENCODE_V2_PERMISSIONS_MESSAGE })),
  };
}

export async function diagnoseOpencodeConfigCompat(input: {
  workspaceRoots?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<OpencodeConfigCompatFinding[]> {
  const env = input.env ?? process.env;
  const targets: Array<{ scope: OpencodeConfigCompatScope; file: string }> = [
    ...globalOpencodeConfigFiles(env).map((file) => ({ scope: "global" as const, file })),
  ];
  const seenRoots = new Set<string>();
  for (const root of input.workspaceRoots ?? []) {
    const trimmed = root.trim();
    if (!trimmed || seenRoots.has(trimmed)) continue;
    seenRoots.add(trimmed);
    for (const file of workspaceOpencodeConfigFiles(trimmed)) targets.push({ scope: "workspace", file });
  }
  const findings = await Promise.all(targets.map(({ scope, file }) => inspectOpencodeConfigFile(scope, file)));
  return findings.filter((finding): finding is OpencodeConfigCompatFinding => finding !== null);
}

function formatIssues(issues: OpencodeConfigCompatIssue[]): string {
  return issues.map((issue) => `${issue.message} (${issue.path.join(".")})`).join("; ");
}

/** Same wording the engine prints when it refuses the file, plus the OmniRush.ai fix. */
export function formatOpencodeConfigCompatFinding(finding: OpencodeConfigCompatFinding): string {
  return `Configuration is invalid at ${finding.file}: ${formatIssues(finding.issues)}`;
}

export function opencodeConfigCompatLogAttributes(finding: OpencodeConfigCompatFinding): Record<string, unknown> {
  return {
    "opencode.config.scope": finding.scope,
    "opencode.config.file": finding.file,
    "opencode.config.issues": finding.issues.map((issue) => issue.path.join(".")).join(","),
    "opencode.config.message": OPENCODE_V2_PERMISSIONS_MESSAGE,
  };
}

export class OpencodeConfigCompatError extends Error {
  readonly code = "opencode_config_invalid";
  readonly findings: OpencodeConfigCompatFinding[];

  constructor(findings: OpencodeConfigCompatFinding[]) {
    super([
      "OpenCode cannot start with the current global configuration.",
      ...findings.map(formatOpencodeConfigCompatFinding),
      OPENCODE_CONFIG_COMPAT_HINT,
    ].join("\n"));
    this.name = "OpencodeConfigCompatError";
    this.findings = findings;
  }
}

/**
 * Run before spawning the managed engine. Global findings throw (the engine
 * would exit at boot anyway, with the same message buried in its stderr);
 * workspace findings only log, because the engine boots and other workspaces
 * keep working — that workspace's routes surface opencode_config_invalid.
 */
export async function assertOpencodeConfigCompat(input: {
  workspaceRoots?: string[];
  env?: NodeJS.ProcessEnv;
  logger?: CompatLogger;
}): Promise<OpencodeConfigCompatFinding[]> {
  const findings = await diagnoseOpencodeConfigCompat(input);
  const fatal = findings.filter((finding) => finding.scope === "global");
  for (const finding of findings) {
    input.logger?.log(
      finding.scope === "global" ? "error" : "warn",
      finding.scope === "global"
        ? "OpenCode global configuration uses V2 permissions; the bundled engine refuses to start."
        : "OpenCode workspace configuration uses V2 permissions; the engine will reject that workspace.",
      opencodeConfigCompatLogAttributes(finding),
    );
  }
  if (fatal.length > 0) throw new OpencodeConfigCompatError(fatal);
  return findings;
}

/**
 * Parse the body of an engine config error (`{ name: "ConfigInvalidError",
 * data: { path, issues?, message? } }`, HTTP 400) into an actionable message.
 * Returns null for anything else so callers keep their generic mapping.
 */
export function parseOpencodeConfigErrorBody(body: unknown): OpencodeConfigErrorBody | null {
  if (!isRecord(body) || typeof body.name !== "string" || !OPENCODE_CONFIG_ERROR_NAMES.has(body.name)) return null;
  const data = isRecord(body.data) ? body.data : {};
  const file = typeof data.path === "string" && data.path && data.path !== "config" ? data.path : null;
  const detail = typeof data.message === "string" ? data.message.trim() : "";
  const issues: OpencodeConfigCompatIssue[] = Array.isArray(data.issues)
    ? data.issues.flatMap((issue) => {
        if (!isRecord(issue) || typeof issue.message !== "string") return [];
        const path = Array.isArray(issue.path) ? issue.path.filter((segment): segment is string => typeof segment === "string") : [];
        return [{ path, message: issue.message }];
      })
    : [];
  const parts = [detail, formatIssues(issues)].filter(Boolean);
  const message = `OpenCode configuration is invalid${file ? ` at ${file}` : ""}${parts.length ? `: ${parts.join("; ")}` : ""}`;
  return { name: body.name, file, message, issues };
}
