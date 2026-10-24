// Execution witness of one shell tool call (`context.exec`): the shell the
// engine runs it with, the argv it spawns, the folder it runs in, the
// program the command starts and the machine (OS, architecture, version).
// The engine never reports its shell, so it is chosen here by the engine's
// own rule (core/src/shell.ts `acceptable()`, tool/shell.ts `cmd()`), and
// `shell.how` says which branch of that rule picked it. Identical in the CLI
// and the desktop app.

import nodePath from "node:path";
import { existsSync } from "node:fs";

import { resolveCommand } from "../command-guard.js";

export const EXEC_SCHEMA = "omnirush.exec.v1";

/** Shells the engine refuses from $SHELL (core/src/shell.ts META deny). */
const DENIED = new Set(["fish", "nu"]);
const POWERSHELL = new Set(["powershell", "pwsh"]);

export type ShellChoice = { path: string; name: string; how: "config" | "env_shell" | "pwsh" | "powershell" | "git_bash" | "comspec" | "zsh_default" | "bash_on_path" | "sh_fallback" | "box" };

type Lookup = (command: string) => string | null;

function shellName(file: string, platform: NodeJS.Platform): string {
  const parse = platform === "win32" ? nodePath.win32.parse : nodePath.posix.parse;
  return (platform === "win32" ? parse(file).name : nodePath.posix.basename(file)).toLowerCase();
}

/** The engine's shell for a tool call (`configShell`: the config's `shell`, set for a box run). */
export function engineShell(input: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; configShell?: string | null; which?: Lookup; exists?: (file: string) => boolean }): ShellChoice | null {
  const { platform, env } = input;
  const pathEnv = platform === "win32" ? (env.Path ?? env.PATH) : env.PATH;
  const which: Lookup = input.which ?? ((command) => resolveCommand(command, { platform, pathEnv: pathEnv ?? "" }));
  const exists = input.exists ?? existsSync;
  const isAbs = platform === "win32" ? nodePath.win32.isAbsolute : nodePath.posix.isAbsolute;
  const resolve = (file: string): string | null => (isAbs(file) ? (exists(file) ? file : null) : which(file));
  const pick = (file: string | null | undefined, how: ShellChoice["how"]): ShellChoice | null => {
    if (!file || DENIED.has(shellName(file, platform))) return null;
    const found = resolve(file);
    return found ? { path: found, name: shellName(found, platform), how } : null;
  };
  // A config shell replaces $SHELL (the engine never falls back from one to the other).
  const chosen = input.configShell ? pick(input.configShell, "config") : pick(env.SHELL, "env_shell");
  if (chosen) return chosen;
  if (platform === "win32") {
    const pwsh = which("pwsh");
    if (pwsh) return { path: pwsh, name: "pwsh", how: "pwsh" };
    const powershell = which("powershell");
    if (powershell) return { path: powershell, name: "powershell", how: "powershell" };
    const git = env.OPENCODE_GIT_BASH_PATH || (() => {
      const found = which("git");
      return found ? nodePath.win32.join(found, "..", "..", "bin", "bash.exe") : null;
    })();
    if (git && exists(git)) return { path: git, name: "bash", how: "git_bash" };
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    return { path: comspec, name: shellName(comspec, platform), how: "comspec" };
  }
  if (platform === "darwin") return { path: "/bin/zsh", name: "zsh", how: "zsh_default" };
  const bash = which("bash");
  return bash ? { path: bash, name: "bash", how: "bash_on_path" } : { path: "/bin/sh", name: "sh", how: "sh_fallback" };
}

/** The argv the engine spawns for `command` with `shell` (tool/shell.ts cmd(), Node's `shell` option). */
export function shellArgv(shell: ShellChoice, command: string, platform: NodeJS.Platform): string[] {
  if (platform === "win32" && POWERSHELL.has(shell.name)) return [shell.path, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
  if (platform === "win32" && shell.name === "cmd") return [shell.path, "/d", "/s", "/c", `"${command}"`];
  return [shell.path, "-c", command];
}

/** The program a command line starts: its first word, resolved on PATH when it is not a path (null for builtins and shell syntax). */
export function commandProgram(command: string, platform: NodeJS.Platform, which: Lookup): { word: string; path: string | null } | null {
  const word = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*("([^"]+)"|'([^']+)'|&\s*"([^"]+)"|[^\s;|&()<>]+)/.exec(command);
  const raw = word ? (word[2] ?? word[3] ?? word[4] ?? word[1]) : null;
  if (!raw) return null;
  const isPath = /[\\/]/.test(raw);
  const bare = platform === "win32" ? raw.replace(/\.(?:exe|cmd|bat|com)$/i, "") : raw;
  return { word: raw, path: isPath ? raw : which(bare) };
}
