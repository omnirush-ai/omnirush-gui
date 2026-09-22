/**
 * Git and pull-request execution policy shared by the server-side permission
 * rules (omnirush-runtime-config → legacyExecutionPermissions) and the
 * engine-side managed-policy plugin.
 *
 * Three tiers, evaluated per shell segment (the part of a command line
 * between `&&`, `||`, `;`, `|`, newlines and substitutions):
 *
 *   read        status, log, diff, fetch, gh pr list ...  → runs without a prompt
 *   write       commit, push, gh pr create, worktree add … → asks once per
 *               session per command family (the engine remembers "Allow for
 *               session" by command family)
 *   destructive push --force, reset --hard, clean -fd, rm -rf …
 *               → always asks
 *
 * The bundled engine's default ruleset allows every shell command, so the
 * write and destructive tiers are the ones that create prompts; the read tier
 * is spelled out so a stricter user ruleset never turns `git status` into a
 * prompt.
 *
 * The engine walks every `command` node of the parsed command line (also the
 * ones inside `if`, `while`, `!`, subshells and substitutions) and remembers
 * a "for session" approval by command family ("git push *"), which would
 * silently cover `git push --force` after a plain push was approved. The
 * plugin therefore prefixes every destructive command, wherever it sits in
 * the line, with DESTRUCTIVE_MARKER (a harmless environment assignment): the
 * marked text no longer matches the remembered family, matches the always-ask
 * marker rule, and still yields the plain family for the engine's own
 * bookkeeping. Commands hidden behind an interpreter (`bash -c`, `sh -c`,
 * `eval`, `env -S`, `xargs`, `find -exec`) are classified through the
 * interpreter and the marker goes in front of the interpreter.
 *
 * Heredoc bodies, comments and quoted strings are data, not commands: they are
 * never classified or rewritten (an unquoted heredoc still has its `$(...)`
 * substitutions classified, because the shell runs those).
 *
 * Dependency-free on purpose: the plugin bundle must not pull the server or
 * an engine SDK.
 */

export const DESTRUCTIVE_MARKER = "OMNIRUSH_DESTRUCTIVE=1";

export type ShellCommandKind = "read" | "write" | "destructive" | "other";

export interface ShellSegment {
  /** Raw text of the segment, untrimmed, as it appears in the command line. */
  text: string;
  /** Offset of the first non-blank character of the segment in the command line. */
  start: number;
  /**
   * Offset of the command proper: after reserved words such as `if`, `then`,
   * `!` or `time` that may precede it. A marker inserted here stays part of
   * the command the shell (and the engine's parser) sees.
   */
  commandStart: number;
  /** Tokens with quotes removed and leading reserved words dropped; leading assignments and wrappers are kept. */
  tokens: string[];
}

/** Which halves of a commit identity a command supplies or writes. */
export interface IdentityFields {
  name: boolean;
  email: boolean;
}

export interface ClassifiedCommand {
  kind: ShellCommandKind;
  /** Human-readable command family, e.g. "git commit" or "gh pr create"; null for other programs. */
  family: string | null;
  /** Directory git was pointed at with -C (relative to the segment's working directory), if any. */
  gitDirectory: string | null;
  /** The segment records or rewrites commits, so it needs an author identity. */
  createsCommit: boolean;
  /** Identity the command carries for its own commit: `git -c user.name=…` or a `GIT_AUTHOR_NAME=… GIT_COMMITTER_NAME=…` prefix. */
  commitIdentity: IdentityFields;
  /** Identity the command writes for the commands after it: `git config user.name …` or `export GIT_AUTHOR_NAME=…`. */
  identityWrite: (IdentityFields & { scope: "repository" | "global" }) | null;
  /** The segment of the command line the classification belongs to (the interpreter's segment for commands run through `bash -c` and friends). */
  segment: ShellSegment;
}

const SEPARATORS = ["&&", "||", ";;", "|&", ";", "|", "&", "\n", "(", ")", "{", "}", "`", "$("];
/** Reserved words that may precede a command inside a segment without being part of it. */
const RESERVED_PREFIX = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "coproc", "time"]);
const MAX_INTERPRETER_DEPTH = 4;

interface Token {
  text: string;
  /** Offset of the token in the segment text. */
  offset: number;
}

interface PendingHeredoc {
  delimiter: string;
  /** A quoted delimiter (`<<'EOF'`) disables expansion: the body is literal text. */
  quoted: boolean;
  stripTabs: boolean;
}

/**
 * Split a command line into segments at control operators, respecting quotes,
 * comments and heredocs. `offset` shifts the reported positions when the text
 * is a slice of a larger command line.
 */
export function splitShellCommand(command: string, offset = 0): ShellSegment[] {
  const segments: ShellSegment[] = [];
  const stack: Array<'"' | null> = [];
  const heredocs: PendingHeredoc[] = [];
  let quote: "'" | '"' | null = null;
  let start = 0;
  let index = 0;
  const flush = (end: number) => {
    const text = command.slice(start, end);
    const tokens = tokenizeSegment(text);
    let first = 0;
    while (first < tokens.length && RESERVED_PREFIX.has(tokens[first].text)) {
      if (tokens[first].text === "time" && tokens[first + 1]?.text === "-p") first += 1;
      first += 1;
    }
    const rest = tokens.slice(first);
    // A stray closing quote after a substitution tokenizes to one empty token: not a command.
    if (rest.every((token) => token.text.length === 0)) return;
    const leading = text.length - text.trimStart().length;
    segments.push({ text, start: offset + start + leading, commandStart: offset + start + rest[0].offset, tokens: rest.map((token) => token.text) });
  };
  while (index < command.length) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      index += 1;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      index += 2;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (command.startsWith("$(", index)) {
        stack.push('"');
        quote = null;
        flush(index);
        index += 2;
        start = index;
        continue;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "#" && (index === 0 || /[\s;|&(){}`]/.test(command[index - 1]))) {
      // A comment runs to the end of the line; nothing in it executes.
      const newline = command.indexOf("\n", index);
      index = newline < 0 ? command.length : newline;
      continue;
    }
    if (command.startsWith("<<", index) && command[index + 2] !== "<") {
      const heredoc = readHeredocOperator(command, index + 2);
      if (heredoc.delimiter) heredocs.push(heredoc);
      index = heredoc.end;
      continue;
    }
    if (char === "\n" && heredocs.length) {
      // The heredoc bodies start on the next line; they are data, except for
      // the substitutions the shell expands in an unquoted body.
      flush(index);
      let cursor = index + 1;
      for (const heredoc of heredocs.splice(0)) {
        const body = readHeredocBody(command, cursor, heredoc);
        if (!heredoc.quoted) {
          for (const range of substitutionRanges(command.slice(cursor, body.end))) {
            segments.push(...splitShellCommand(command.slice(cursor + range.start, cursor + range.end), offset + cursor + range.start));
          }
        }
        cursor = body.next;
      }
      index = cursor;
      start = index;
      continue;
    }
    if (char === ")" && stack.length) {
      flush(index);
      quote = stack.pop() ?? null;
      index += 1;
      start = index;
      continue;
    }
    if (command.startsWith("$(", index)) {
      stack.push(null);
      flush(index);
      index += 2;
      start = index;
      continue;
    }
    const separator = SEPARATORS.find((candidate) => command.startsWith(candidate, index));
    // `2>&1`, `<&0` and `&>file` are redirections, not background operators.
    const redirection = separator === "&" && (">" === command[index - 1] || "<" === command[index - 1] || command[index + 1] === ">");
    // Braces group commands only as words of their own (`{ cmd; }`); `{}` in
    // xargs and find, `${var}` and `{a,b}` are ordinary text.
    const braceWord = (separator === "{" || separator === "}")
      && (index === 0 || /[\s;|&()]/.test(command[index - 1]))
      && (index + 1 >= command.length || /[\s;|&()]/.test(command[index + 1]));
    if (separator && !redirection && (braceWord || (separator !== "{" && separator !== "}"))) {
      flush(index);
      index += separator.length;
      start = index;
      continue;
    }
    index += 1;
  }
  flush(command.length);
  return segments;
}

/** Parse the delimiter word after `<<`; returns the position after it. */
function readHeredocOperator(command: string, from: number): PendingHeredoc & { end: number } {
  let index = from;
  let stripTabs = false;
  if (command[index] === "-") {
    stripTabs = true;
    index += 1;
  }
  while (command[index] === " " || command[index] === "\t") index += 1;
  let delimiter = "";
  let quoted = false;
  while (index < command.length && !/[\s;&|<>()]/.test(command[index])) {
    const char = command[index];
    if (char === "'" || char === '"') {
      const close = command.indexOf(char, index + 1);
      const end = close < 0 ? command.length : close;
      delimiter += command.slice(index + 1, end);
      quoted = true;
      index = end + 1;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      delimiter += command[index + 1];
      quoted = true;
      index += 2;
      continue;
    }
    delimiter += char;
    index += 1;
  }
  return { delimiter, quoted, stripTabs, end: index };
}

/** Find the end of a heredoc body that starts at `from`: the body end and the position after the terminator line. */
function readHeredocBody(command: string, from: number, heredoc: PendingHeredoc): { end: number; next: number } {
  let cursor = from;
  while (cursor <= command.length) {
    const newline = command.indexOf("\n", cursor);
    const lineEnd = newline < 0 ? command.length : newline;
    const line = command.slice(cursor, lineEnd);
    const compare = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
    if (compare === heredoc.delimiter) return { end: cursor, next: newline < 0 ? command.length : newline + 1 };
    if (newline < 0) break;
    cursor = newline + 1;
  }
  // No terminator: the body runs to the end of the command line.
  return { end: command.length, next: command.length };
}

/** Ranges (relative to `text`) of the `$(...)` and backtick substitutions the shell expands in unquoted heredoc bodies. */
function substitutionRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text.startsWith("$(", index)) {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (text[cursor] === "(") depth += 1;
        else if (text[cursor] === ")") depth -= 1;
        if (depth > 0) cursor += 1;
      }
      ranges.push({ start: index + 2, end: cursor });
      index = cursor + 1;
      continue;
    }
    if (text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      const end = close < 0 ? text.length : close;
      ranges.push({ start: index + 1, end });
      index = end + 1;
      continue;
    }
    index += 1;
  }
  return ranges;
}

function tokenizeSegment(text: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let offset = -1;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      if (text[index + 1] === "\n" && quote === null) {
        // Line continuation.
        index += 1;
        continue;
      }
      if (offset < 0) offset = index;
      current += text[index + 1];
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      if (offset < 0) offset = index;
      continue;
    }
    if (/\s/.test(char)) {
      if (offset >= 0) tokens.push({ text: current, offset });
      current = "";
      offset = -1;
      continue;
    }
    if (char === "#" && offset < 0) break;
    if (offset < 0) offset = index;
    current += char;
  }
  if (offset >= 0) tokens.push({ text: current, offset });
  return tokens;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Programs that run another program given as their arguments. */
const WRAPPERS = new Set(["sudo", "doas", "command", "exec", "env", "nohup", "time", "builtin", "nice", "caffeinate", "timeout", "xargs"]);
const WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-T", "-U"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  caffeinate: new Set(["-t", "-w"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  xargs: new Set(["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "-J", "-R", "-S", "--max-args", "--max-procs", "--max-lines",
    "--max-chars", "--delimiter", "--eof", "--arg-file", "--process-slot-var", "--replace"]),
};

/** Split a segment's tokens into the leading environment assignments and the program with its arguments. */
export function splitProgramTokens(tokens: string[]): { assignments: string[]; program: string[] } {
  const assignments: string[] = [];
  let list = tokens;
  let index = 0;
  let hops = 0;
  while (index < list.length && hops < 16) {
    const token = list[index];
    if (ASSIGNMENT.test(token)) {
      assignments.push(token);
      index += 1;
      continue;
    }
    const wrapper = programName(token);
    if (!WRAPPERS.has(wrapper)) break;
    hops += 1;
    index += 1;
    const valueFlags = WRAPPER_VALUE_FLAGS[wrapper];
    while (index < list.length) {
      const option = list[index];
      if (wrapper === "env" && ASSIGNMENT.test(option)) {
        assignments.push(option);
        index += 1;
        continue;
      }
      if (option === "--") {
        index += 1;
        break;
      }
      if (!option.startsWith("-")) break;
      if (wrapper === "env" && (option === "-S" || option === "--split-string" || option.startsWith("-S") || option.startsWith("--split-string="))) {
        // `env -S 'git push --force'`: the string is split into a command line again.
        const inline = option === "-S" || option === "--split-string" ? null : option.startsWith("-S") ? option.slice(2) : option.slice("--split-string=".length);
        const script = inline ?? list[index + 1] ?? "";
        const split = tokenizeSegment(script).map((entry) => entry.text);
        list = [...list.slice(0, index), ...split, ...list.slice(index + (inline === null ? 2 : 1))];
        continue;
      }
      if (valueFlags?.has(option)) {
        index += 2;
        continue;
      }
      if (wrapper === "xargs" && /^-[InPLsdEaJRS]./.test(option)) {
        // Attached value, e.g. `-I{}` or `-n1`.
        index += 1;
        continue;
      }
      index += 1;
    }
    // `timeout [options] DURATION command …`
    if (wrapper === "timeout" && index < list.length) index += 1;
  }
  return { assignments, program: list.slice(index) };
}

/** Drop leading environment assignments and privilege/exec wrappers. */
export function programTokens(tokens: string[]): string[] {
  return splitProgramTokens(tokens).program;
}

function programName(token: string | undefined): string {
  if (!token) return "";
  const base = token.replaceAll("\\", "/").split("/").pop() ?? "";
  return base.toLowerCase().replace(/\.exe$/, "");
}

function shortFlagHas(token: string, letter: string): boolean {
  return /^-[A-Za-z0-9]+$/.test(token) && token.slice(1).includes(letter);
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

const GIT_OPTIONS_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix",
  "--list-cmds", "--attr-source",
]);

function joinGitDirectory(previous: string | null, next: string): string {
  if (!previous || next.startsWith("/") || /^[A-Za-z]:[\\/]/.test(next)) return next;
  return `${previous.replace(/\/+$/, "")}/${next}`;
}

const GIT_READ = new Set([
  "status", "log", "diff", "show", "fetch", "ls-files", "ls-tree", "ls-remote", "cat-file", "rev-parse", "rev-list",
  "describe", "blame", "annotate", "shortlog", "grep", "count-objects", "check-ignore", "check-attr", "check-ref-format",
  "check-mailmap", "name-rev", "merge-base", "merge-tree", "for-each-ref", "var", "version", "help", "whatchanged",
  "show-ref", "show-branch", "verify-commit", "verify-tag", "diff-tree", "diff-index", "diff-files", "cherry",
  "range-diff", "format-patch", "patch-id", "stripspace", "interpret-trailers", "fsck", "get-tar-commit-id",
]);
const GIT_COMMIT_STOP_FLAGS = ["--abort", "--quit", "--skip"];
const BRANCH_READ_FLAGS = new Set([
  "--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "-vvv", "--verbose", "--show-current", "--merged",
  "--no-merged", "--contains", "--no-contains", "--points-at", "--sort", "--format", "--color", "--no-color", "--column",
  "--no-column", "-i", "--ignore-case", "--abbrev", "--no-abbrev",
]);
const BRANCH_PATTERN_FLAGS = ["--list", "-l", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"];
const CONFIG_READ_FLAGS = [
  "-l", "--list", "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "--show-origin",
  "--show-scope",
];
const CONFIG_WRITE_FLAGS = ["--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section", "--edit", "-e"];
const CONFIG_VALUE_FLAGS = new Set(["-f", "--file", "--blob", "--type", "--default"]);
const CONFIG_READ_SUBCOMMANDS = new Set(["get", "list"]);

type GitVerdict = { kind: ShellCommandKind; createsCommit?: boolean; identityWrite?: ClassifiedCommand["identityWrite"] };

function classifyGitConfig(args: string[]): GitVerdict {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (CONFIG_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) positional.push(arg);
  }
  if (CONFIG_WRITE_FLAGS.some((flag) => hasFlag(args, flag))) return { kind: "write" };
  if (CONFIG_READ_FLAGS.some((flag) => hasFlag(args, flag))) return { kind: "read" };
  const subcommand = positional[0] && CONFIG_READ_SUBCOMMANDS.has(positional[0]) ? positional[0] : positional[0] === "set" ? "set" : null;
  if (subcommand && subcommand !== "set") return { kind: "read" };
  const [key, value] = subcommand === "set" ? positional.slice(1, 3) : positional.slice(0, 2);
  if (value === undefined) return { kind: "read" };
  const scope = hasFlag(args, "--global", "--system", "-f", "--file", "--blob") ? "global" : "repository";
  const identityWrite = key === "user.name" || key === "user.email"
    ? { name: key === "user.name", email: key === "user.email", scope: scope as "repository" | "global" }
    : undefined;
  return { kind: "write", identityWrite };
}

function classifyGit(sub: string | undefined, args: string[]): GitVerdict {
  if (!sub || sub === "--version" || sub === "--help" || sub === "-h") return { kind: "read" };
  const positional = args.filter((arg) => !arg.startsWith("-"));
  switch (sub) {
    case "push": {
      const refspecDelete = args.some((arg) => /^\+/.test(arg) || /^:./.test(arg));
      const forced = args.some((arg) => arg === "--force" || arg.startsWith("--force-with-lease") || arg === "--force-if-includes"
        || arg === "--delete" || arg === "--mirror" || arg === "--prune" || shortFlagHas(arg, "f") || shortFlagHas(arg, "d"));
      return { kind: forced || refspecDelete ? "destructive" : "write" };
    }
    case "reset":
      return { kind: hasFlag(args, "--hard") ? "destructive" : "write" };
    case "clean": {
      if (hasFlag(args, "-n", "--dry-run") || args.some((arg) => shortFlagHas(arg, "n"))) return { kind: "read" };
      const forced = hasFlag(args, "--force") || args.some((arg) => shortFlagHas(arg, "f"));
      return { kind: forced ? "destructive" : "write" };
    }
    case "branch": {
      if (args.some((arg) => arg === "-D" || shortFlagHas(arg, "D"))) return { kind: "destructive" };
      if ((hasFlag(args, "-d", "--delete") || args.some((arg) => shortFlagHas(arg, "d")))
        && (hasFlag(args, "-f", "--force") || args.some((arg) => shortFlagHas(arg, "f")))) return { kind: "destructive" };
      if (args.length === 0) return { kind: "read" };
      const flags = args.filter((arg) => arg.startsWith("-"));
      const readFlags = flags.every((flag) => BRANCH_READ_FLAGS.has(flag.includes("=") ? flag.slice(0, flag.indexOf("=")) : flag)
        || (/^-[alrvi]+$/.test(flag)));
      if (!readFlags) return { kind: "write" };
      if (positional.length === 0) return { kind: "read" };
      return { kind: BRANCH_PATTERN_FLAGS.some((flag) => hasFlag(args, flag)) ? "read" : "write" };
    }
    case "remote": {
      const verb = args[0];
      if (!verb || verb === "-v" || verb === "--verbose" || verb === "show" || verb === "get-url") return { kind: "read" };
      return { kind: "write" };
    }
    case "worktree": {
      const verb = args[0];
      if (!verb || verb === "list") return { kind: "read" };
      if (verb === "remove" && (hasFlag(args, "--force", "-f") || args.some((arg) => shortFlagHas(arg, "f")))) return { kind: "destructive" };
      return { kind: "write" };
    }
    case "tag": {
      const annotated = hasFlag(args, "-a", "--annotate", "-s", "--sign", "-m", "--message", "-F", "--file", "-u", "--local-user")
        || args.some((arg) => /^-[asuF]/.test(arg) || /^-m./.test(arg));
      if (hasFlag(args, "-d", "--delete") || args.some((arg) => shortFlagHas(arg, "d"))) return { kind: "write" };
      if (args.length === 0 || (!annotated && (hasFlag(args, "-l", "--list", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged")
        || args.some((arg) => /^-n\d*$/.test(arg) || shortFlagHas(arg, "l"))))) return { kind: "read" };
      return { kind: "write", createsCommit: annotated };
    }
    case "stash": {
      const verb = args[0];
      if (verb === "list" || verb === "show") return { kind: "read" };
      if (verb === "drop" || verb === "clear") return { kind: "destructive" };
      const records = !verb || verb.startsWith("-") || verb === "push" || verb === "save" || verb === "create";
      return { kind: "write", createsCommit: records };
    }
    case "config":
      return classifyGitConfig(args);
    case "reflog": {
      const verb = args[0];
      if (!verb || verb === "show" || verb.startsWith("-")) return { kind: "read" };
      return { kind: verb === "expire" || verb === "delete" ? "destructive" : "write" };
    }
    case "notes": {
      const verb = args[0];
      if (!verb || verb === "list" || verb === "show" || verb === "get-ref") return { kind: "read" };
      return { kind: "write", createsCommit: true };
    }
    case "submodule": {
      const verb = args[0];
      return { kind: !verb || verb === "status" || verb === "summary" ? "read" : "write" };
    }
    case "symbolic-ref":
      return { kind: positional.length <= 1 ? "read" : "write" };
    case "sparse-checkout":
      return { kind: args[0] === "list" ? "read" : "write" };
    case "lfs": {
      const verb = args[0];
      return { kind: ["ls-files", "status", "env", "version", "logs"].includes(verb ?? "") ? "read" : "write" };
    }
    case "update-ref":
      return { kind: hasFlag(args, "-d") ? "destructive" : "write" };
    case "hash-object":
      return { kind: hasFlag(args, "-w") ? "write" : "read" };
    case "rebase": {
      if (hasFlag(args, "-i", "--interactive") || args.some((arg) => shortFlagHas(arg, "i"))) return { kind: "destructive" };
      return { kind: "write", createsCommit: !GIT_COMMIT_STOP_FLAGS.some((flag) => hasFlag(args, flag)) };
    }
    case "filter-branch":
    case "filter-repo":
      return { kind: "destructive" };
    case "commit":
    case "commit-tree":
      return { kind: "write", createsCommit: true };
    case "merge":
    case "cherry-pick":
    case "revert":
    case "am":
      return { kind: "write", createsCommit: !GIT_COMMIT_STOP_FLAGS.some((flag) => hasFlag(args, flag)) };
    default:
      return { kind: GIT_READ.has(sub) ? "read" : "write" };
  }
}

function classifyGitTokens(tokens: string[]): { verdict: GitVerdict; family: string; gitDirectory: string | null; inline: IdentityFields } {
  let index = 1;
  let gitDirectory: string | null = null;
  const inline: IdentityFields = { name: false, email: false };
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token.startsWith("-") || token === "--") break;
    const equals = token.indexOf("=");
    const name = equals > 0 ? token.slice(0, equals) : token;
    const inlineValue = equals > 0 ? token.slice(equals + 1) : undefined;
    if (GIT_OPTIONS_WITH_VALUE.has(name)) {
      const value = inlineValue ?? tokens[index + 1] ?? "";
      if (name === "-C") gitDirectory = joinGitDirectory(gitDirectory, value);
      if (name === "-c") {
        if (/^user\.name=./.test(value)) inline.name = true;
        if (/^user\.email=./.test(value)) inline.email = true;
      }
      index += inlineValue === undefined ? 2 : 1;
      continue;
    }
    if (/^-C.+/.test(token)) {
      gitDirectory = joinGitDirectory(gitDirectory, token.slice(2));
      index += 1;
      continue;
    }
    index += 1;
  }
  const sub = tokens[index];
  const args = tokens.slice(index + 1);
  const verdict = classifyGit(sub, args);
  const family = sub && !sub.startsWith("-") ? `git ${sub}` : "git";
  return { verdict, family, gitDirectory, inline };
}

const GH_GLOBAL_VALUE_FLAGS = new Set(["-R", "--repo"]);
const GH_READ_VERBS = new Set(["list", "view", "status", "checks", "diff", "watch"]);

function classifyGhTokens(tokens: string[]): { kind: ShellCommandKind; family: string } {
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith("-")) {
    const token = tokens[index];
    if (token === "--version" || token === "--help") return { kind: "read", family: "gh" };
    index += GH_GLOBAL_VALUE_FLAGS.has(token) ? 2 : 1;
  }
  const command = tokens[index];
  const verb = tokens[index + 1];
  const rest = tokens.slice(index + 1);
  const family = command
    ? (verb && !verb.startsWith("-") && command !== "api" ? `gh ${command} ${verb}` : `gh ${command}`)
    : "gh";
  if (!command || ["version", "help", "status", "search"].includes(command)) return { kind: "read", family };
  if (command === "auth") return { kind: verb === "status" ? "read" : "write", family };
  if (command === "api") {
    const method = rest.find((arg, position) => position > 0 && (rest[position - 1] === "-X" || rest[position - 1] === "--method"))
      ?? rest.find((arg) => arg.startsWith("--method="))?.slice("--method=".length);
    const mutating = (method && method.toUpperCase() !== "GET") || rest.some((arg) =>
      ["-f", "-F", "--field", "--raw-field", "--input"].includes(arg) || /^--(?:raw-)?field=/.test(arg) || /^-[fF]./.test(arg));
    return { kind: mutating ? "write" : "read", family };
  }
  if (command === "repo" && verb === "delete") return { kind: "destructive", family };
  if (command === "config") return { kind: verb === "get" || verb === "list" ? "read" : "write", family };
  if (["alias", "extension", "ssh-key", "gpg-key", "cache", "label", "secret", "variable", "ruleset", "attestation"].includes(command)) {
    return { kind: verb === "list" ? "read" : "write", family };
  }
  if (verb && GH_READ_VERBS.has(verb)) return { kind: "read", family };
  return { kind: "write", family };
}

function classifyRm(tokens: string[]): ShellCommandKind {
  const flags = tokens.slice(1).filter((token) => token.startsWith("-"));
  const recursive = flags.some((flag) => flag === "--recursive" || shortFlagHas(flag, "r") || shortFlagHas(flag, "R"));
  const forced = flags.some((flag) => flag === "--force" || shortFlagHas(flag, "f"));
  return recursive && forced ? "destructive" : "other";
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);
const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** The command line an interpreter segment runs, when it is spelled out in the arguments. */
function interpreterScript(program: string, tokens: string[]): { script: string } | { tokens: string[] } | null {
  if (SHELLS.has(program)) {
    let sawCommandFlag = false;
    let index = 1;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token === "--") {
        index += 1;
        break;
      }
      if (token.startsWith("--command=")) return { script: token.slice("--command=".length) };
      if (token === "-o" || token === "+o" || token === "-O" || token === "+O") {
        index += 2;
        continue;
      }
      if (!token.startsWith("-") && !token.startsWith("+")) break;
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(token) || token === "--command") sawCommandFlag = true;
      index += 1;
    }
    return sawCommandFlag && tokens[index] !== undefined ? { script: tokens[index] } : null;
  }
  if (program === "eval") {
    const script = tokens.slice(1).join(" ");
    return script ? { script } : null;
  }
  if (program === "su") {
    const flag = tokens.findIndex((token, position) => position > 0 && (token === "-c" || token === "--command"));
    if (flag > 0 && tokens[flag + 1] !== undefined) return { script: tokens[flag + 1] };
    const inline = tokens.find((token, position) => position > 0 && token.startsWith("--command="));
    return inline ? { script: inline.slice("--command=".length) } : null;
  }
  if (program === "find") {
    const flag = tokens.findIndex((token, position) => position > 0 && FIND_EXEC_FLAGS.has(token));
    if (flag < 0) return null;
    const end = tokens.findIndex((token, position) => position > flag && (token === ";" || token === "+"));
    const inner = tokens.slice(flag + 1, end < 0 ? tokens.length : end);
    return inner.length ? { tokens: inner } : null;
  }
  return null;
}

function identityFromAssignments(assignments: string[]): IdentityFields {
  const names = new Set(assignments.filter((entry) => /^[A-Z_]+=./.test(entry)).map((entry) => entry.slice(0, entry.indexOf("="))));
  return {
    name: names.has("GIT_AUTHOR_NAME") && names.has("GIT_COMMITTER_NAME"),
    email: names.has("GIT_AUTHOR_EMAIL") && names.has("GIT_COMMITTER_EMAIL"),
  };
}

function classifyTokens(segmentTokens: string[], segment: ShellSegment, depth: number): ClassifiedCommand[] {
  const { assignments, program: tokens } = splitProgramTokens(segmentTokens);
  const program = programName(tokens[0]);
  const commitIdentity = identityFromAssignments(assignments);
  const other = (): ClassifiedCommand[] => [{
    kind: "other", family: null, gitDirectory: null, createsCommit: false, commitIdentity, identityWrite: null, segment,
  }];
  if (program === "git") {
    const { verdict, family, gitDirectory, inline } = classifyGitTokens(tokens);
    return [{
      kind: verdict.kind,
      family,
      gitDirectory,
      createsCommit: verdict.createsCommit === true,
      commitIdentity: { name: commitIdentity.name || inline.name, email: commitIdentity.email || inline.email },
      identityWrite: verdict.identityWrite ?? null,
      segment,
    }];
  }
  if (program === "gh") {
    const { kind, family } = classifyGhTokens(tokens);
    return [{ kind, family, gitDirectory: null, createsCommit: false, commitIdentity, identityWrite: null, segment }];
  }
  if (program === "rm") {
    const kind = classifyRm(tokens);
    return [{ kind, family: kind === "destructive" ? "rm -rf" : "rm", gitDirectory: null, createsCommit: false, commitIdentity, identityWrite: null, segment }];
  }
  if (program === "export" || program === "declare" || program === "typeset") {
    const exported = identityFromAssignments(tokens.slice(1).filter((token) => ASSIGNMENT.test(token)));
    const identityWrite = exported.name || exported.email ? { ...exported, scope: "global" as const } : null;
    return [{ kind: "other", family: null, gitDirectory: null, createsCommit: false, commitIdentity, identityWrite, segment }];
  }
  if (depth < MAX_INTERPRETER_DEPTH) {
    const inner = interpreterScript(program, tokens);
    if (inner) {
      const nested = "script" in inner
        ? splitShellCommand(inner.script).flatMap((entry) => classifyTokens(entry.tokens, segment, depth + 1))
        : classifyTokens(inner.tokens, segment, depth + 1);
      const classified = nested.filter((entry) => entry.kind !== "other");
      if (classified.length === 0) return other();
      // A `GIT_*` prefix on the interpreter reaches the inner git the same way.
      return classified.map((entry) => ({
        ...entry,
        commitIdentity: { name: entry.commitIdentity.name || commitIdentity.name, email: entry.commitIdentity.email || commitIdentity.email },
      }));
    }
  }
  return other();
}

/**
 * Classify one segment. Interpreter segments (`bash -c '…'`, `eval …`,
 * `find … -exec …`) yield the classification of the commands they run, each
 * attached to the interpreter's segment.
 */
export function classifySegment(segment: ShellSegment): ClassifiedCommand[] {
  return classifyTokens(segment.tokens, segment, 0);
}

/** Classify every segment of a command line. */
export function classifyShellCommand(command: string): ClassifiedCommand[] {
  return splitShellCommand(command).flatMap(classifySegment);
}

/** Remove any marker the model wrote itself so the plugin stays the only author of it. */
export function stripDestructiveMarkers(command: string): string {
  return command.replace(new RegExp(`(?:^|(?<=\\s))${DESTRUCTIVE_MARKER}\\s+`, "g"), "");
}

/**
 * Prefix every destructive command with the marker. The engine parses the
 * assignment as part of the command, so the permission pattern starts with
 * the marker while the command family ("git push *") stays unchanged. The
 * marker goes after reserved words (`if`, `!`, `time`) and in front of an
 * interpreter that runs the destructive command (`bash -c`, `sudo`).
 */
export function markDestructiveCommands(command: string): { command: string; destructive: ClassifiedCommand[] } {
  const clean = stripDestructiveMarkers(command);
  const classified = classifyShellCommand(clean);
  const destructive = classified.filter((entry) => entry.kind === "destructive");
  if (destructive.length === 0) return { command: clean, destructive };
  const offsets = [...new Set(destructive.map((entry) => entry.segment.commandStart))].sort((left, right) => right - left);
  let result = clean;
  for (const offset of offsets) {
    result = `${result.slice(0, offset)}${DESTRUCTIVE_MARKER} ${result.slice(offset)}`;
  }
  return { command: result, destructive };
}

/** Read-only command shapes the engine may run without asking (pattern syntax: `*` any run, trailing ` *` optional). */
const READ_ONLY_GIT_PATTERNS = [
  "git status *", "git log *", "git diff *", "git show *", "git fetch *", "git remote", "git remote -v", "git remote --verbose",
  "git remote show *", "git remote get-url *", "git worktree list *", "git branch", "git branch --list *", "git branch -l *",
  "git branch -a", "git branch --all", "git branch -r", "git branch --remotes", "git branch -v", "git branch -vv",
  "git branch --verbose", "git branch -av", "git branch -avv", "git branch -ra", "git branch -rv", "git branch --show-current",
  "git branch --merged *", "git branch --no-merged *", "git branch --contains *", "git branch --points-at *", "git tag",
  "git tag -l *", "git tag --list *", "git tag -n*", "git tag --contains *", "git tag --points-at *", "git stash list *",
  "git stash show *", "git config --get *", "git config --get-all *", "git config --get-regexp *", "git config --list *",
  "git config -l *", "git config --show-origin *", "git config user.name", "git config user.email", "git config --local user.name",
  "git config --local user.email", "git rev-parse *", "git rev-list *", "git ls-files *", "git ls-tree *", "git ls-remote *",
  "git cat-file *", "git describe *", "git blame *", "git shortlog *", "git grep *", "git count-objects *", "git check-ignore *",
  "git name-rev *", "git merge-base *", "git for-each-ref *", "git reflog", "git reflog show *", "git show-ref *",
  "git version", "git --version", "git help *", "git --help", "git diff-tree *", "git whatchanged *", "git cherry *",
  "git range-diff *", "git var *", "git submodule status *", "git submodule summary *", "git lfs ls-files *", "git lfs status *",
  "git lfs env", "git notes list *", "git notes show *", "git sparse-checkout list", "git clean -n *", "git clean --dry-run *",
];
const READ_ONLY_GH_PATTERNS = [
  "gh pr list *", "gh pr view *", "gh pr status *", "gh pr checks *", "gh pr diff *", "gh issue list *", "gh issue view *",
  "gh issue status *", "gh repo view *", "gh repo list *", "gh run list *", "gh run view *", "gh run watch *",
  "gh workflow list *", "gh workflow view *", "gh release list *", "gh release view *", "gh auth status *", "gh search *",
  "gh label list *", "gh gist list *", "gh gist view *", "gh config get *", "gh config list *", "gh alias list *",
  "gh extension list *", "gh ssh-key list *", "gh cache list *", "gh status *", "gh version", "gh --version", "gh help *",
  "gh --help",
];
/**
 * Interpreter wrappers hide the real command line from the engine's
 * token-based patterns (`bash -c 'git push'` is a `bash` command to it), so
 * they ask once per session like a write command. Destructive commands inside
 * them are still marked and always ask.
 */
const SHELL_PATH_PREFIXES = ["", "/bin/", "/usr/bin/", "/usr/local/bin/", "/opt/homebrew/bin/"];
const INTERPRETER_PATTERNS = [
  ...SHELL_PATH_PREFIXES.flatMap((prefix) => ["bash", "sh", "zsh", "dash", "ksh"].map((shell) => `${prefix}${shell} -*c *`)),
  "eval *", "env -S *", "env --split-string*", "su *",
];
/** Destructive shapes spelled out for engines running without the plugin. */
const DESTRUCTIVE_PATTERNS = [
  "git push --force*", "git push -f*", "git push * --force*", "git push * -f*", "git push --delete *", "git push -d *",
  "git push * --delete *", "git push * :*", "git push --mirror*", "git push * --mirror*", "git push --prune*", "git push * --prune*",
  "git reset --hard*", "git reset * --hard*", "git clean -*f*", "git clean --force*", "git clean * --force*",
  "git branch -D *", "git branch * -D*", "git branch --delete --force *", "git branch --force --delete *",
  "git rebase -i*", "git rebase --interactive*", "git rebase * -i*", "git rebase * --interactive*", "git filter-branch*",
  "git filter-repo*", "git stash drop*", "git stash clear*", "git reflog expire*", "git reflog delete*",
  "git worktree remove --force*", "git worktree remove -f *", "git worktree remove * --force*", "git worktree remove * -f*",
  "git update-ref -d *", "gh repo delete *", "rm -rf *", "rm -fr *", "rm -Rf *", "rm -fR *", "rm -r -f *", "rm -f -r *",
  "rm -R -f *", "rm -f -R *", "rm --recursive --force *", "rm --force --recursive *", "rm -r --force *", "rm -f --recursive *",
];

/**
 * Engine `permission.bash` rules for git, gh and shell deletions, in
 * evaluation order (the engine picks the last matching rule): every git and
 * gh command asks, the read-only shapes are allowed again, interpreter
 * wrappers ask, destructive shapes and the marker ask.
 */
export function gitWorkflowPermissionRules(): Record<string, "allow" | "ask"> {
  const rules: Record<string, "allow" | "ask"> = { "git *": "ask", "gh *": "ask", "sudo *": "ask" };
  for (const pattern of READ_ONLY_GIT_PATTERNS) {
    rules[pattern] = "allow";
    const rest = pattern.slice("git ".length);
    rules[`git --no-pager ${rest}`] = "allow";
    rules[`git -P ${rest}`] = "allow";
  }
  for (const pattern of READ_ONLY_GH_PATTERNS) rules[pattern] = "allow";
  for (const pattern of INTERPRETER_PATTERNS) rules[pattern] = "ask";
  for (const pattern of DESTRUCTIVE_PATTERNS) rules[pattern] = "ask";
  rules[`${DESTRUCTIVE_MARKER} *`] = "ask";
  return rules;
}
