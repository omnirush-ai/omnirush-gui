// Both engine generations call this same OmniRush.ai boundary before side effects.
// This module has no engine SDK dependency so it can be loaded by either build.
import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import { DEFAULT_APPROVAL_MODE, parseApprovalMode, type ApprovalMode } from "../approval-mode.js";
import type { ManagedPolicyAction } from "../managed-policy-rules.js";
import { classifyShellCommand, markDestructiveCommands, type ClassifiedCommand, type IdentityFields } from "../git-command-policy.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }

export interface ManagedToolContext {
  /** Engine instance directory; the bash tool resolves `workdir` against it. */
  directory?: string;
  callID?: string;
  sessionID?: string;
}

export async function checkManagedTool(tool: string, raw: unknown, context: ManagedToolContext = {}): Promise<void> {
  const input = record(raw);
  let action: ManagedPolicyAction | undefined;
  if (tool === "bash" || tool === "shell") action = "shell";
  else if (["write", "edit", "apply_patch", "patch"].includes(tool)) action = "file_write";
  else if (tool === "webfetch" || tool === "websearch") action = tool;
  else if (tool === "browser_navigate" || tool === "browser_open") action = "browser";
  else if (tool === "omnirush_execute") {
    if (input.id === "browser.open_url") {
      await check("browser", record(input.args));
      return;
    }
    if (typeof input.id === "string" && /^(?:plugin|skill|mcp)\.(?:install|add|update|remove)/.test(input.id)) action = "extensions";
  }
  // Even read-only tools synchronize policy, so unknown identities cannot keep
  // running with a previous member's loaded configuration.
  const verdict = await check(action ?? "sync", input);
  // The organization policy saw the command as written; the git workflow
  // rules then rewrite it in place (the engine reads the same args object).
  if (action === "shell") await prepareShellCommand(input, context, { approvalMode: verdict.approvalMode });
}

export interface PolicyVerdict {
  /** Approval mode the server resolved (environment, then setting, then guarded) at the time of this call. */
  approvalMode: ApprovalMode;
}

export async function check(action: ManagedPolicyAction, input: Record<string, unknown>): Promise<PolicyVerdict> {
  const base = process.env.OMNIRUSH_SERVER_URL;
  const token = process.env.OMNIRUSH_POLICY_TOKEN;
  if (!base || !token) throw new Error("OmniRush.ai policy service is unavailable.");
  const response = await fetch(`${base}/managed-policy/evaluate`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, input }), signal: AbortSignal.timeout(15_000),
  });
  const payload = record(await response.json().catch(() => undefined));
  if (!response.ok) {
    throw new Error(typeof payload.message === "string" ? payload.message : "Your organization blocked this action.");
  }
  // A server that predates approval modes answers without one: guarded.
  return { approvalMode: parseApprovalMode(payload.approvalMode) ?? DEFAULT_APPROVAL_MODE };
}

// ---------------------------------------------------------------------------
// Git workflow rules applied inside the engine
// ---------------------------------------------------------------------------

/** Notes to append to a shell tool result, keyed by the engine call id. */
const shellNotes = new Map<string, string>();
const MAX_NOTES = 256;

export interface GitIdentityProbe {
  repository: boolean;
  name: string | null;
  email: string | null;
}

export type GitIdentityReader = (directory: string) => Promise<GitIdentityProbe>;

async function runGit(args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync("git", args, { timeout: GIT_TIMEOUT_MS, encoding: "utf8", maxBuffer: 1024 * 1024 });
    return { stdout, code: 0 };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string };
    return { stdout: typeof failure.stdout === "string" ? failure.stdout : "", code: typeof failure.code === "number" ? failure.code : -1 };
  }
}

export async function readGitIdentity(directory: string): Promise<GitIdentityProbe> {
  const inside = await runGit(["-C", directory, "rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return { repository: false, name: null, email: null };
  const name = await runGit(["-C", directory, "config", "--get", "user.name"]);
  const email = await runGit(["-C", directory, "config", "--get", "user.email"]);
  return {
    repository: true,
    name: name.code === 0 && name.stdout.trim() ? name.stdout.trim() : null,
    email: email.code === 0 && email.stdout.trim() ? email.stdout.trim() : null,
  };
}

/** Identity halves the environment supplies to git (author and committer variables both set). */
function environmentIdentity(env: NodeJS.ProcessEnv): IdentityFields {
  const set = (key: string) => Boolean(env[key]?.trim());
  return {
    name: set("GIT_AUTHOR_NAME") && set("GIT_COMMITTER_NAME"),
    email: set("GIT_AUTHOR_EMAIL") && set("GIT_COMMITTER_EMAIL"),
  };
}

export interface PrepareShellOptions {
  readIdentity?: GitIdentityReader;
  ensureIdentity?: (directory: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** Full mode leaves the command untouched and never refuses a commit; default guarded. */
  approvalMode?: ApprovalMode;
}

/** Repositories the command records commits in, resolved against the tool's working directory. */
export function commitRepositories(classified: ClassifiedCommand[], cwd: string): string[] {
  const directories = classified
    .filter((entry) => entry.createsCommit)
    .map((entry) => resolve(cwd, entry.gitDirectory ?? "."));
  return directories.filter((directory, index) => directories.indexOf(directory) === index);
}

/**
 * Apply the git workflow rules to a bash tool call: mark destructive segments
 * so they always ask, and make sure commit-creating segments run with an
 * identity (defaulted from the omnirush.ai account for that repository, or
 * refused with a message the agent can act on).
 *
 * The command line is read in order: `git config user.name … && git commit`
 * supplies the identity before the commit runs, as does `git -c user.name=…`,
 * an exported `GIT_AUTHOR_*` / `GIT_COMMITTER_*` pair or the process
 * environment, so the recovery the refusal message asks for is never refused
 * again.
 *
 * In full approval mode nothing asks, so the destructive marker is not
 * written and a missing identity never refuses the command: the account
 * identity is still applied to the repository when one is connected, and the
 * commit runs with whatever git has otherwise.
 */
export async function prepareShellCommand(
  input: Record<string, unknown>,
  context: ManagedToolContext = {},
  options: PrepareShellOptions = {},
): Promise<void> {
  if (typeof input.command !== "string") return;
  const full = options.approvalMode === "full";
  const command = full ? input.command : markDestructiveCommands(input.command).command;
  if (command !== input.command) input.command = command;
  const classified = classifyShellCommand(command);
  const base = context.directory && isAbsolute(context.directory) ? context.directory : process.cwd();
  const workdir = typeof input.workdir === "string" && input.workdir.trim() ? input.workdir.trim() : ".";
  const cwd = resolve(base, workdir);
  const readIdentity = options.readIdentity ?? readGitIdentity;
  const ensureIdentity = options.ensureIdentity ?? ((directory: string) => check("git_identity", { directory }));
  const fromEnvironment = environmentIdentity(options.env ?? process.env);
  const notes: string[] = [];
  /** Identity halves written by earlier segments, per repository (or "*" for global scope). */
  const written = new Map<string, IdentityFields>();
  const settled = new Set<string>();
  for (const entry of classified) {
    const directory = resolve(cwd, entry.gitDirectory ?? ".");
    if (entry.identityWrite) {
      const key = entry.identityWrite.scope === "global" ? "*" : directory;
      const current = written.get(key) ?? { name: false, email: false };
      written.set(key, { name: current.name || entry.identityWrite.name, email: current.email || entry.identityWrite.email });
    }
    if (!entry.createsCommit || settled.has(directory)) continue;
    const supplied = (field: keyof IdentityFields) =>
      fromEnvironment[field] || entry.commitIdentity[field] || written.get(directory)?.[field] === true || written.get("*")?.[field] === true;
    const before = await readIdentity(directory);
    if (!before.repository || ((before.name || supplied("name")) && (before.email || supplied("email")))) {
      settled.add(directory);
      continue;
    }
    // The server applies the account identity to this repository or refuses
    // with the message that explains what to ask the user.
    try {
      await ensureIdentity(directory);
    } catch (error) {
      if (!full) throw error;
      settled.add(directory);
      continue;
    }
    const after = await readIdentity(directory);
    if (!after.name || !after.email) {
      if (!full) {
        throw new Error("Git identity is not configured for this repository (user.name and user.email are unset). "
          + 'Ask the user which name and email to commit with, then run: git config user.name "<name>" && git config user.email "<email>" (never --global).');
      }
      settled.add(directory);
      continue;
    }
    settled.add(directory);
    notes.push(`omnirush.ai set the commit identity for ${directory} to ${after.name} <${after.email}> from the connected omnirush.ai account `
      + "(repository-local, never global). Tell the user; they can change it with git config user.name / git config user.email.");
  }
  if (notes.length && context.callID) rememberShellNote(context.callID, notes.join("\n"));
}

export function rememberShellNote(callID: string, note: string): void {
  if (shellNotes.size >= MAX_NOTES) {
    const oldest = shellNotes.keys().next().value;
    if (oldest !== undefined) shellNotes.delete(oldest);
  }
  shellNotes.set(callID, note);
}

/** Append and forget the note recorded for a call; returns the (possibly unchanged) output. */
export function annotateShellOutput(callID: string | undefined, output: string): string {
  if (!callID) return output;
  const note = shellNotes.get(callID);
  if (!note) return output;
  shellNotes.delete(callID);
  return `${output}\n\n[omnirush.ai] ${note}`;
}
