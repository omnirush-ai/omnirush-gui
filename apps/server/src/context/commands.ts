// The tool calls of a turn (from the engine's messages) and what a shell
// command does to the file system, by a light parse of the command text:
// the folders it changes into or creates (cd, mkdir, git clone, npm create,
// cargo new, …), the files it writes (redirections, tee, cp/mv targets,
// curl -o, …), the scripts it runs (bash x.sh, python x.py, ./x, source x),
// the paths it names, and the on-the-fly tools it runs (npx, uvx, …).
// Nothing is executed; the parse errs on the side of naming too much (each
// path is checked on disk later).

import { basename, isAbsolute, join, posix, resolve, win32 } from "node:path";

import { packageOfCommand } from "./setup.js";

export type ToolCall = {
  callId: string | null;
  tool: string;
  input: Record<string, unknown>;
  status: string | null;
  start: number | null;
  end: number | null;
  /** The shell command of a shell tool. */
  command: string | null;
  /** The directory the tool ran in (its workdir input), absolute. */
  cwd: string;
};

const SHELL_TOOLS = new Set(["bash", "shell", "sh", "zsh", "run_command", "run_shell_command", "exec", "terminal", "local_shell", "powershell", "cmd"]);
const READ_TOOLS = new Set(["read", "view", "cat", "file_read", "read_file", "open", "read_many_files", "readfile", "grep", "glob", "list", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "multi_edit", "create", "file_write", "write_file", "patch", "apply_patch", "str_replace", "str_replace_editor", "notebook_edit", "notebookedit", "replace"]);
const PATH_KEYS = ["filePath", "file_path", "filepath", "path", "filename", "notebook_path", "absolute_path"];
const MAX_COMMAND_CHARS = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolKind(tool: string): "shell" | "read" | "write" | "other" {
  const name = tool.trim().toLowerCase().split(/[.:/]/).at(-1) ?? "";
  if (SHELL_TOOLS.has(name)) return "shell";
  if (READ_TOOLS.has(name)) return "read";
  if (WRITE_TOOLS.has(name)) return "write";
  return "other";
}

export function expandHome(path: string, home: string | null): string | null {
  if (path === "~" || path === "$HOME" || path === "${HOME}") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return home ? join(home, path.slice(2)) : null;
  // The shell's own spelling of the home folder.
  for (const prefix of ["$HOME/", "${HOME}/"]) if (path.startsWith(prefix)) return home ? join(home, path.slice(prefix.length)) : null;
  if (path.startsWith("~")) return null;
  return path;
}

type Env = Record<string, string | undefined>;
const WINDOWS_PATH_VARS = new Set(["TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA"]);
const WINDOWS_VAR = /\$\{?env:([A-Za-z_]\w*)\}?|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)|%([A-Za-z_]\w*)%/g;
const POSIX_VAR = /\$\{(TMPDIR|HOME)\}|\$(TMPDIR|HOME)(?!\w)/g;

/**
 * A path word as the shell saw it, before it is parsed: the temp and home variables expanded with this
 * session's values (`$X`, `${X}`; on Windows also `%X%` and `$env:X`, any case: TEMP, TMP, TMPDIR,
 * USERPROFILE, HOME, LOCALAPPDATA, APPDATA; elsewhere TMPDIR and HOME), and on Windows Git Bash's
 * `/tmp` (its fstab mounts the user's %TEMP% there) and `/c/...` drive paths in Windows form.
 * A variable without a value stays as written. Quoting is not known here: a single-quoted `$TEMP` expands too.
 */
export function shellPath(word: string, home: string | null, env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") {
    if (!word.includes("$")) return word;
    return word.replace(POSIX_VAR, (match, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare;
      const value = name === "HOME" ? home ?? env.HOME : env.TMPDIR;
      return value || match;
    });
  }
  const get = (name: string): string | undefined => {
    const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
    return key ? env[key] || undefined : undefined;
  };
  // Git Bash sets TMPDIR to TMP and HOME to USERPROFILE when the Windows environment has none.
  const value = (name: string): string | undefined =>
    name === "HOME" ? home ?? get("HOME") ?? get("USERPROFILE") : name === "TMPDIR" ? get("TMPDIR") ?? get("TMP") ?? get("TEMP") : get(name);
  let out = !/[$%]/.test(word) ? word : word.replace(WINDOWS_VAR, (match, ps?: string, braced?: string, bare?: string, cmd?: string) => {
    const name = (ps ?? braced ?? bare ?? cmd ?? "").toUpperCase();
    return (WINDOWS_PATH_VARS.has(name) && value(name)) || match;
  });
  const temp = get("TEMP") ?? get("TMP");
  if (temp && /^\/tmp(?:\/|$)/.test(out)) out = `${temp}${out.slice(4)}`;
  const drive = /^\/([A-Za-z])(\/.*)?$/.exec(out);
  if (drive && drive[2] !== undefined) out = `${drive[1]!.toUpperCase()}:${drive[2]}`;
  return out;
}

/**
 * The tool calls of a turn's messages, in the order they started: 1.x `parts`, or a 2.x engine assistant
 * message's `content` (its tool's time.ran is when it started running, time.completed when it ended).
 */
export function toolCallsOf(messages: unknown, root: string, home: string | null): ToolCall[] {
  const list = Array.isArray(messages) ? messages : isRecord(messages) && Array.isArray(messages.messages) ? messages.messages : [];
  const out: ToolCall[] = [];
  for (const message of list) {
    if (!isRecord(message)) continue;
    const parts = Array.isArray(message.parts) ? message.parts : message.type === "assistant" && Array.isArray(message.content) ? message.content : null;
    if (!parts) continue;
    for (const part of parts) {
      if (!isRecord(part) || part.type !== "tool") continue;
      const tool = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : "";
      if (!tool) continue;
      const state = isRecord(part.state) ? part.state : {};
      const input = isRecord(state.input) ? state.input : isRecord(part.input) ? part.input : {};
      const v2 = isRecord(part.time) ? part.time : {};
      const time = isRecord(state.time) ? state.time : { start: v2.ran ?? v2.created, end: v2.completed };
      const workdir = ["workdir", "cwd", "directory", "working_directory"].map((key) => input[key]).find((value) => typeof value === "string" && value.trim()) as string | undefined;
      const expanded = workdir ? expandHome(workdir.trim(), home) : null;
      const rawCommand = input.command ?? input.cmd ?? input.script;
      const command = typeof rawCommand === "string" ? rawCommand : Array.isArray(rawCommand) && rawCommand.every((item) => typeof item === "string") ? rawCommand.join(" ") : null;
      out.push({
        callId: typeof part.callID === "string" ? part.callID : typeof part.callId === "string" ? part.callId : typeof part.id === "string" ? part.id : null,
        tool,
        input,
        status: typeof state.status === "string" ? state.status : null,
        start: typeof time.start === "number" ? time.start : null,
        end: typeof time.end === "number" ? time.end : null,
        command: toolKind(tool) === "shell" ? command : null,
        cwd: expanded ? resolve(root, expanded) : root,
      });
    }
  }
  return out.map((call, index) => ({ call, index })).sort((a, b) => (a.call.start ?? 0) - (b.call.start ?? 0) || a.index - b.index).map(({ call }) => call);
}

/** File paths a read or write tool names (absolute). */
export function toolPaths(call: ToolCall, home: string | null): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value.trim() || value.includes("\n") || value.length > 4096) return;
    const expanded = expandHome(value.trim(), home);
    if (expanded) out.push(resolve(call.cwd, expanded));
  };
  for (const key of PATH_KEYS) add(call.input[key]);
  if (Array.isArray(call.input.paths)) for (const value of call.input.paths) add(value);
  for (const key of ["patchText", "patch"]) {
    const body = call.input[key];
    if (typeof body === "string") for (const match of body.matchAll(/^\*\*\* (?:(?:Update|Add) File|Move to):[ \t]*(.+)$/gm)) add(match[1]);
  }
  return out;
}

// --- shell parsing --------------------------------------------------------------------

export type Token = { word: string } | { op: string };

/**
 * Words and control/redirection operators; quotes and backslashes honoured; heredoc bodies skipped.
 * On Windows a backslash before a name character is a path separator (`%TEMP%\\a`), not an escape.
 */
export function tokenize(command: string, platform: NodeJS.Platform = process.platform): Token[] {
  const text = command.length > MAX_COMMAND_CHARS ? command.slice(0, MAX_COMMAND_CHARS) : command;
  const tokens: Token[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  const heredocs: string[] = [];
  const end = () => {
    if (started) tokens.push({ word });
    word = "";
    started = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && '"\\$`'.includes(text[i + 1] ?? "")) word += text[++i]!;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && text[i + 1] !== undefined && text[i + 1] !== "\n") {
      word += platform === "win32" && /[\w.%~-]/.test(text[i + 1]!) ? char : text[++i]!;
      started = true;
      continue;
    }
    if (char === "\n") {
      end();
      tokens.push({ op: "\n" });
      // Heredoc bodies: skip lines until each delimiter.
      while (heredocs.length > 0) {
        const delimiter = heredocs.shift()!;
        let next = text.indexOf("\n", i + 1);
        while (true) {
          const line = text.slice(i + 1, next < 0 ? undefined : next);
          i = next < 0 ? text.length : next;
          if (line.trim() === delimiter || next < 0) break;
          next = text.indexOf("\n", i + 1);
        }
      }
      continue;
    }
    if (char === "#" && !started) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i += 1;
      continue;
    }
    if (/\s/.test(char)) {
      end();
      continue;
    }
    const three = text.slice(i, i + 3);
    const two = text.slice(i, i + 2);
    if (two === "<<" && three !== "<<<") {
      end();
      let j = i + 2;
      if (text[j] === "-") j += 1;
      while (text[j] === " ") j += 1;
      const match = /^(['"]?)([\w.-]+)\1/.exec(text.slice(j));
      if (match) {
        heredocs.push(match[2]!);
        i = j + match[0].length - 1;
      } else {
        i += 1;
      }
      tokens.push({ op: "<<" });
      continue;
    }
    const ops = ["&>>", "2>>", "&&", "||", ">>", "2>", "&>", ">|", ";", "|", "&", ">", "<", "(", ")", "`"];
    const op = ops.find((candidate) => text.startsWith(candidate, i));
    if (op && !(op === "2>" && started) && !(op === "2>>" && started)) {
      end();
      if (op === "&" && text[i + 1] === ">") continue;
      tokens.push({ op });
      i += op.length - 1;
      continue;
    }
    word += char;
    started = true;
  }
  end();
  return tokens;
}

const SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")", "`"]);
const REDIRECT_WRITE = new Set([">", ">>", "2>", "2>>", "&>", "&>>", ">|"]);

/** Simple commands: words, the files they redirect into, and the operator before each. */
export function simpleCommands(command: string, platform: NodeJS.Platform = process.platform): Array<{ words: string[]; writes: string[]; reads: string[]; after: string | null }> {
  const out: Array<{ words: string[]; writes: string[]; reads: string[]; after: string | null }> = [];
  let current = { words: [] as string[], writes: [] as string[], reads: [] as string[], after: null as string | null };
  let pending: "write" | "read" | "skip" | null = null;
  for (const token of tokenize(command, platform)) {
    if ("op" in token) {
      if (SEPARATORS.has(token.op)) {
        if (current.words.length || current.writes.length) out.push(current);
        current = { words: [], writes: [], reads: [], after: token.op };
        pending = null;
      } else if (REDIRECT_WRITE.has(token.op)) pending = "write";
      else if (token.op === "<") pending = "read";
      else if (token.op === "<<") pending = null;
      continue;
    }
    if (pending) {
      if (pending === "write" && !/^&\d$|^\/dev\//.test(token.word)) current.writes.push(token.word);
      if (pending === "read" && !token.word.startsWith("/dev/")) current.reads.push(token.word);
      pending = null;
      continue;
    }
    // Leading assignments (FOO=bar cmd) are not the command.
    if (current.words.length === 0 && /^[A-Za-z_][\w]*=/.test(token.word)) continue;
    current.words.push(token.word);
  }
  if (current.words.length || current.writes.length) out.push(current);
  return out;
}

export type FolderVia = "cd" | "mkdir" | "git clone" | "create" | "cargo new" | "init" | "copy" | "extract" | "workdir";
export type CommandEffects = {
  /** Folders the command changes into (`cd`) or creates. */
  folders: Array<{ path: string; via: FolderVia; created: boolean }>;
  /** Files it writes or modifies. */
  writes: string[];
  /** Scripts it runs (interpreted or executed by path). */
  executed: string[];
  /** Every path-like word, resolved (read/used candidates). */
  named: string[];
  /** On-the-fly tools. */
  ephemeral: Array<{ runner: string; package: string; requested: string | null }>;
  /** Python environments it runs, activates or makes (a `bin`/`Scripts` interpreter, pip or activate by path, `-m venv`). */
  pythonEnvs: string[];
  /** It installs or removes Python packages (pip, uv, poetry, pipenv, pdm, conda). */
  pythonInstalls: boolean;
};

const INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "python", "python2", "python3", "node", "nodejs", "ruby", "perl", "php", "tsx", "ts-node", "pwsh", "powershell", "Rscript", "lua", "osascript", "groovy"]);
const VALUE_FLAGS: Record<string, Set<string>> = {
  git: new Set(["-b", "--branch", "--depth", "-o", "--origin", "-c", "--config", "--reference", "--filter", "-j", "--jobs", "--template", "--separate-git-dir", "-u", "--upload-pack", "--shallow-since", "--shallow-exclude"]),
};

function isPathLike(word: string): boolean {
  if (!word || word.length > 4096 || word.includes("://") || /[*?{}$]/.test(word) || word.startsWith("-")) return false;
  return /^(?:\/|~[\\/]|~$|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(word) || word.includes("/") || /^[^\\/=:@]+\.[A-Za-z0-9]{1,12}$/.test(word);
}

/** The folder name `git clone <url>` makes when no directory is given. */
export function cloneDirName(url: string): string | null {
  const trimmed = url.replace(/[\\/]+$/, "").replace(/\.git$/, "");
  const name = trimmed.split(/[\\/:]/).at(-1);
  return name && name !== "." && name !== ".." ? name : null;
}

/**
 * What a shell command does to the file system, resolved against `cwd`
 * (which `cd` moves for the rest of an `&&`/`;` chain). Paths are read the way the session's shell
 * reads them (shellPath: `env` and `platform` are the session's).
 */
export function commandEffects(command: string, cwd: string, home: string | null, env: Env = process.env, platform: NodeJS.Platform = process.platform): CommandEffects {
  const paths = platform === "win32" ? win32 : posix;
  const effects: CommandEffects = { folders: [], writes: [], executed: [], named: [], ephemeral: [], pythonEnvs: [], pythonInstalls: false };
  let dir = cwd;
  const abs = (value: string): string | null => {
    const expanded = expandHome(value, home);
    if (!expanded || expanded.includes("\0")) return null;
    return paths.isAbsolute(expanded) ? paths.resolve(expanded) : paths.resolve(dir, expanded);
  };
  const folder = (value: string | undefined, via: FolderVia, created: boolean) => {
    if (!value || value.startsWith("-")) return;
    const path = abs(value);
    if (path) effects.folders.push({ path, via, created });
  };
  const nonFlags = (words: string[], from: number, valueFlags: Set<string> = new Set()) => {
    const out: string[] = [];
    for (let i = from; i < words.length; i += 1) {
      const word = words[i]!;
      if (word === "--") continue;
      if (word.startsWith("-")) {
        if (valueFlags.has(word)) i += 1;
        continue;
      }
      out.push(word);
    }
    return out;
  };
  for (const parsed of simpleCommands(command, platform)) {
    const expand = (word: string) => shellPath(word, home, env, platform);
    const simple = { ...parsed, words: parsed.words.map(expand), writes: parsed.writes.map(expand), reads: parsed.reads.map(expand) };
    for (const target of simple.writes) {
      const path = abs(target);
      if (path) effects.writes.push(path);
    }
    for (const source of simple.reads) {
      const path = abs(source);
      if (path) effects.named.push(path);
    }
    let words = simple.words;
    // sudo/env/time/nohup/exec prefixes.
    while (words.length > 1 && ["sudo", "env", "time", "nohup", "exec", "command", "nice", "xargs"].includes(words[0]!)) {
      words = words.slice(1);
      while (words.length > 1 && (words[0]!.startsWith("-") || /^[A-Za-z_]\w*=/.test(words[0]!))) words = words.slice(1);
    }
    if (words.length === 0) continue;
    const head = basename(words[0]!).replace(/\.(?:exe|cmd)$/i, "");
    for (const word of words.slice(1)) {
      const value = word.startsWith("-") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
      if (isPathLike(value)) {
        const path = abs(value);
        if (path) effects.named.push(path);
      }
    }
    for (const word of words) {
      const env = /^(.+)[\\/](?:bin|Scripts)[\\/](?:python[\d.]*|pip[\d.]*|activate(?:\.bat|\.ps1|\.fish|\.csh)?)(?:\.exe)?$/i.exec(word)?.[1];
      const path = env ? abs(env) : null;
      if (path) effects.pythonEnvs.push(path);
    }
    const python = /^(?:python[\d.]*|py)$/i.test(head);
    const made = python && words[1] === "-m" && words[2] === "venv" ? nonFlags(words, 3)[0] : head === "virtualenv" ? nonFlags(words, 1)[0] : head === "uv" && words[1] === "venv" ? nonFlags(words, 2)[0] ?? ".venv" : undefined;
    const madePath = made ? abs(made) : null;
    if (madePath) effects.pythonEnvs.push(madePath);
    const pipArgs = /^pip[\d.]*$/i.test(head) ? words.slice(1) : python && words[1] === "-m" && words[2] === "pip" ? words.slice(3) : head === "uv" && words[1] === "pip" ? words.slice(2) : null;
    const sub = words[1] ?? "";
    if ((pipArgs && /^(?:un)?install$/.test(pipArgs.find((word) => !word.startsWith("-")) ?? ""))
      || (head === "uv" && ["add", "remove", "sync"].includes(sub))
      || (["poetry", "pipenv", "pdm"].includes(head) && ["add", "remove", "install", "sync"].includes(sub))
      || (["conda", "mamba", "micromamba"].includes(head) && ["install", "remove", "update"].includes(sub))) effects.pythonInstalls = true;
    const spec = packageOfCommand(words);
    if (spec) {
      const runner = words[0] && ["pnpm", "yarn", "npm", "bun", "pipx", "uv"].includes(head) ? `${head} ${words[1]}` : head;
      effects.ephemeral.push({ runner: runner === "npm exec" ? "npx" : runner === "uv tool" ? "uvx" : runner, package: spec.package, requested: spec.version });
    }
    switch (head) {
      case "cd":
      case "pushd":
      case "Set-Location":
      case "sl": {
        const target = nonFlags(words, 1)[0];
        const path = target ? abs(target) : home;
        if (path) {
          effects.folders.push({ path, via: "cd", created: false });
          dir = path;
        }
        break;
      }
      case "mkdir":
      case "md":
      case "New-Item":
        for (const target of nonFlags(words, 1, new Set(["-m", "--mode", "-ItemType", "-Path"]))) folder(target, "mkdir", true);
        break;
      case "git": {
        const sub = nonFlags(words, 1, new Set(["-C", "-c"]));
        if (sub[0] === "clone") {
          const args = nonFlags(words, words.indexOf("clone") + 1, VALUE_FLAGS.git);
          const target = args[1] ?? (args[0] ? cloneDirName(args[0]) ?? undefined : undefined);
          folder(target, "git clone", true);
        } else if (sub[0] === "init" && sub[1]) folder(sub[1], "init", true);
        break;
      }
      case "npm":
      case "pnpm":
      case "yarn":
      case "bun": {
        const sub = words[1];
        if (sub === "dlx") {
          const args = nonFlags(words, 2);
          if (args[0] && /(?:^|\/)create-/.test(args[0])) folder(args[1], "create", true);
        } else if (sub === "create" || (sub === "init" && words[2] && !words[2].startsWith("-"))) {
          const args = nonFlags(words, 2);
          folder(args[1], "create", true);
        }
        break;
      }
      case "npx":
      case "pnpx":
      case "bunx": {
        const args = nonFlags(words, 1);
        if (args[0] && /(?:^|\/)create-/.test(args[0])) folder(args[1], "create", true);
        break;
      }
      case "cargo":
        if (words[1] === "new" || words[1] === "init") folder(nonFlags(words, 2, new Set(["--name", "--vcs", "--edition"]))[0], "cargo new", true);
        break;
      case "uv":
      case "poetry":
        if (words[1] === "init" || words[1] === "new") folder(nonFlags(words, 2)[0], "init", true);
        break;
      case "rails":
      case "django-admin":
        if (words[1] === "new" || words[1] === "startproject") folder(nonFlags(words, 2)[head === "rails" ? 0 : 1] ?? nonFlags(words, 2)[0], "create", true);
        break;
      case "composer":
        if (words[1] === "create-project") folder(nonFlags(words, 2)[1], "create", true);
        break;
      case "dotnet": {
        const at = words.findIndex((word) => word === "-o" || word === "--output");
        if (words[1] === "new" && at > 0) folder(words[at + 1], "create", true);
        break;
      }
      case "cp":
      case "rsync":
      case "Copy-Item": {
        const args = nonFlags(words, 1, new Set(["-t", "--target-directory", "-e"]));
        const target = args.at(-1);
        if (target && args.length >= 2) {
          const recursive = words.some((word) => /^-[a-zA-Z]*[rRa]/.test(word) || word === "--recursive" || word === "-Recurse") || head === "rsync";
          if (recursive) folder(target, "copy", true);
          else {
            const path = abs(target);
            if (path) effects.writes.push(path);
          }
        }
        break;
      }
      case "mv":
      case "Move-Item": {
        const args = nonFlags(words, 1);
        const path = args.length >= 2 ? abs(args.at(-1)!) : null;
        if (path) effects.writes.push(path);
        break;
      }
      case "tee":
      case "touch":
      case "Out-File":
      case "Set-Content":
        for (const target of nonFlags(words, 1)) {
          const path = abs(target);
          if (path) effects.writes.push(path);
        }
        break;
      case "sed":
      case "perl":
        if (words.some((word) => /^-[a-zA-Z]*i/.test(word))) {
          const target = nonFlags(words, 1, new Set(["-e", "-f"])).at(-1);
          const path = target ? abs(target) : null;
          if (path) effects.writes.push(path);
        }
        break;
      case "curl":
      case "wget": {
        const at = words.findIndex((word) => word === "-o" || word === "--output" || word === "-O" && head === "wget" || word === "--output-document");
        const value = at > 0 ? words[at + 1] : words.find((word) => /^--output(?:-document)?=/.test(word))?.split("=").slice(1).join("=");
        const path = value && value !== "-" ? abs(value) : null;
        if (path) effects.writes.push(path);
        break;
      }
      case "tar": {
        const at = words.findIndex((word) => word === "-C" || word === "--directory");
        if (at > 0 && words.some((word) => /^-?[a-zA-Z]*x/.test(word) || word === "--extract")) folder(words[at + 1], "extract", true);
        break;
      }
      case "unzip": {
        const at = words.indexOf("-d");
        if (at > 0) folder(words[at + 1], "extract", true);
        break;
      }
      case "source":
      case ".": {
        const path = words[1] ? abs(words[1]) : null;
        if (path) effects.executed.push(path);
        break;
      }
      default:
        break;
    }
    // Scripts run by an interpreter or by path.
    if (INTERPRETERS.has(head) || /^python\d+(?:\.\d+)*$/.test(head)) {
      const args = nonFlags(words, 1, new Set(["-m", "-c", "-e", "--eval", "-r", "--require", "-W", "-X", "--import", "--loader"]));
      if (!words.includes("-c") && !words.includes("-m") && !words.includes("-e") && !words.includes("--eval") && args[0]) {
        const path = abs(args[0]);
        if (path) effects.executed.push(path);
      }
    } else if (/[\\/]/.test(words[0]!) && !words[0]!.endsWith("/")) {
      const path = abs(words[0]!);
      if (path) effects.executed.push(path);
    } else if ((head === "deno" || head === "bun") && words[1] === "run" && words[2] && isPathLike(words[2])) {
      const path = abs(words[2]);
      if (path) effects.executed.push(path);
    }
    // Deno npm:/jsr: specifiers and `go run pkg@version` are on-the-fly tools too.
    if (head === "deno") {
      const spec = words.find((word) => /^(?:npm|jsr):/.test(word));
      if (spec) {
        const body = spec.replace(/^(?:npm|jsr):/, "");
        const at = body.lastIndexOf("@");
        effects.ephemeral.push({ runner: "deno run", package: `${spec.startsWith("jsr:") ? "jsr:" : ""}${at > 0 ? body.slice(0, at) : body}`, requested: at > 0 ? body.slice(at + 1).split("/")[0] || null : null });
      }
    }
    if (head === "go" && words[1] === "run") {
      const target = nonFlags(words, 2).find((word) => /^[\w.-]+\.[\w-]+\/[^@\s]+@\S+$/.test(word));
      if (target) {
        const at = target.lastIndexOf("@");
        effects.ephemeral.push({ runner: "go run", package: target.slice(0, at), requested: target.slice(at + 1) });
      }
    }
  }
  return effects;
}
