/**
 * Files used: the files a shell command reads, writes, runs or imports,
 * from its text alone. The command is split into simple commands at the
 * control operators (`;`, `&&`, `||`, `|`, `&`, newlines, `$(...)`); a `cd`
 * moves the folder the following ones resolve against; redirections are
 * writes (`>`, `>>`, `&>`, `2>`) or reads (`<`); then each command word is
 * looked up:
 *
 *   - readers (`cat`, `head`, `jq`, `diff`, ...) read their path arguments;
 *     pattern-first tools (`grep`, `rg`, `sed`, `awk`) read every path
 *     argument after the pattern (`-f` script files too), `sed -i` writes;
 *   - `cp`/`mv`/`install`/`rsync` read their sources and write the target,
 *     `tee`/`touch`/`truncate` write;
 *   - interpreters (`python`, `node`, `bash`, `ruby`, ...) run their script
 *     (`exec`), read the path arguments after it, and `-c`/`-e` code and
 *     heredoc bodies give the quoted paths they name (`open('x', 'w')` is a
 *     write); `source`/`.` and `./script` run a file; `node -r ./x` reads;
 *   - build and test tools read the config files they always load
 *     (`package.json`, `tsconfig.json`, `pytest.ini`, `Makefile`, ...) and
 *     the ones named with `-f`/`-c`/`--config`/`-r`;
 *   - every `git` command reads the user's git config (`~/.gitconfig`,
 *     `~/.config/git/config`: `implicit`, so one that is not there is not
 *     listed); `git config` keys and values are never paths (`--file x`
 *     is, and a write to `--global` writes `~/.gitconfig`, to the repository
 *     `.git/config`); other git commands name files only after `--`.
 *
 * Any other path-looking word counts as a read. Candidates are absolute;
 * whether each is a file is checked later. Nothing here touches the disk.
 * Identical in the CLI and the desktop app.
 */
import { join, posix, win32 } from "node:path";

import { shellPath } from "../context/commands.js";

export type ShellUseOp = "read" | "write" | "exec";
/** `implicit`: the program reads it without naming it (a config it always loads): not listed when it is not there. */
export type ShellUse = { path: string; op: ShellUseOp; implicit?: true };

const MAX_COMMAND_CHARS = 256 * 1024;
const MAX_PATH_CHARS = 4_096;
const MAX_USES = 512;

type Token = { word: string } | { op: string };

const isWord = (token: Token | undefined): token is { word: string } => token !== undefined && "word" in token;

/**
 * Shell tokens: words (quotes and escapes resolved) and operators. Heredoc
 * bodies come back as a `heredoc` operator followed by one word holding the
 * body. A word holding `$` or a backtick substitution keeps it as text. On Windows a backslash before a
 * name character is a path separator (`%TEMP%\\a`), not an escape.
 */
export function shellTokens(command: string, platform: NodeJS.Platform = process.platform): Token[] {
  const text = command.length > MAX_COMMAND_CHARS ? command.slice(0, MAX_COMMAND_CHARS) : command;
  const tokens: Token[] = [];
  const heredocs: Array<{ delimiter: string; strip: boolean }> = [];
  let word = "";
  let started = false;
  const end = () => {
    if (started) tokens.push({ word });
    word = "";
    started = false;
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "'") {
      const close = text.indexOf("'", index + 1);
      word += close < 0 ? text.slice(index + 1) : text.slice(index + 1, close);
      started = true;
      index = close < 0 ? text.length : close + 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\" && index + 1 < text.length && '"\\$`'.includes(text[index + 1]!)) index += 1;
        word += text[index]!;
        index += 1;
      }
      index += 1;
      started = true;
      continue;
    }
    if (char === "\\" && next !== undefined) {
      if (platform === "win32" && /[\w.%~-]/.test(next)) {
        word += char;
        started = true;
        index += 1;
        continue;
      }
      if (next !== "\n") {
        word += next;
        started = true;
      }
      index += 2;
      continue;
    }
    if (char === "#" && !started) {
      // A comment runs to the end of the line.
      const newline = text.indexOf("\n", index);
      index = newline < 0 ? text.length : newline;
      continue;
    }
    if (char === "$" && next === "(") {
      end();
      tokens.push({ op: "(" });
      index += 2;
      continue;
    }
    if (char === "`") {
      end();
      tokens.push({ op: ";" });
      index += 1;
      continue;
    }
    if (char === "\n") {
      end();
      tokens.push({ op: ";" });
      index += 1;
      // Heredoc bodies start on the line after their operator.
      while (heredocs.length > 0) {
        const { delimiter, strip } = heredocs.shift()!;
        const body: string[] = [];
        while (index < text.length) {
          const newline = text.indexOf("\n", index);
          const line = newline < 0 ? text.slice(index) : text.slice(index, newline);
          index = newline < 0 ? text.length : newline + 1;
          if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
          body.push(line);
        }
        tokens.push({ op: "heredoc" }, { word: body.join("\n") });
      }
      continue;
    }
    if (/\s/.test(char)) {
      end();
      index += 1;
      continue;
    }
    if (char === "<" && next === "<" && text[index + 2] !== "<") {
      // `<<EOF`, `<<-EOF`, `<<'EOF'`, `<< "EOF"`.
      end();
      let at = index + 2;
      const strip = text[at] === "-";
      if (strip) at += 1;
      while (text[at] === " " || text[at] === "\t") at += 1;
      const match = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(text.slice(at));
      if (match) {
        heredocs.push({ delimiter: match[2]!, strip });
        index = at + match[0].length;
      } else index += 2;
      continue;
    }
    // Redirections, with an optional fd in front (`2>`, `&>`, `>>`, `>|`, `<`, `<<<`).
    const redirect = /^(?:[0-9]*>>|[0-9]*>\||&>>|&>|[0-9]*>&?|<<<|[0-9]*<)/.exec(started && /^[0-9]+$/.test(word) ? `${word}${text.slice(index)}` : text.slice(index));
    if ((char === ">" || char === "<" || (char === "&" && next === ">")) && redirect) {
      const fdPrefix = started && /^[0-9]+$/.test(word) ? word.length : 0;
      if (fdPrefix) {
        word = "";
        started = false;
      } else end();
      const op = redirect[0].slice(fdPrefix);
      tokens.push({ op: op.replace(/^[0-9]+/, "") });
      index += op.length;
      continue;
    }
    if (char === "&" && next === "&") {
      end();
      tokens.push({ op: "&&" });
      index += 2;
      continue;
    }
    if (char === "|" && next === "|") {
      end();
      tokens.push({ op: "||" });
      index += 2;
      continue;
    }
    if (";|&()".includes(char)) {
      end();
      tokens.push({ op: char === "|" || char === "&" ? ";" : char });
      index += 1;
      continue;
    }
    word += char;
    started = true;
    index += 1;
  }
  end();
  return tokens;
}

const READERS = new Set([
  "cat", "head", "tail", "less", "more", "wc", "sort", "uniq", "cut", "nl", "tac", "od", "xxd", "hexdump", "strings", "file", "stat",
  "md5sum", "sha1sum", "sha256sum", "sha512sum", "shasum", "b2sum", "cksum", "base64", "jq", "yq", "column", "diff", "cmp", "comm",
  "paste", "join", "bat", "batcat", "iconv", "zcat", "gzcat", "bzcat", "xzcat", "zstdcat", "csvlook", "csvcut", "csvstat", "fold", "fmt",
  "expand", "unexpand", "rev", "split", "readlink", "realpath", "dos2unix", "unix2dos", "pdftotext", "identify", "exiftool", "sqlite3",
  "xmllint", "tidy", "mdcat", "glow", "view", "vim", "vi", "nano", "emacs", "code", "open", "xdg-open", "pandoc", "unzip", "gunzip", "7z",
]);
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "gawk", "mawk", "nawk"]);
const COPIERS = new Set(["cp", "mv", "install", "rsync", "scp", "ln"]);
const WRITERS = new Set(["tee", "touch", "truncate"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "ash"]);
const INTERPRETERS = new Set([
  "python", "python2", "python3", "py", "pypy", "pypy3", "node", "nodejs", "bun", "deno", "ts-node", "tsx", "ruby", "perl", "php",
  "rscript", "julia", "lua", "luajit", "groovy", "kotlin", "scala", "swift", "elixir", "erl", "racket", "guile", "tclsh", "osascript",
  "pwsh", "powershell", "jshell", "java",
]);
/** Words that run the command after them (with their own options skipped). */
const WRAPPERS = new Set(["sudo", "env", "time", "nice", "nohup", "timeout", "exec", "command", "builtin", "stdbuf", "xargs", "caffeinate", "ionice", "taskset", "chronic", "unbuffer", "watch", "strace", "ltrace", "valgrind", "gdb", "lldb", "uv", "poetry", "pipenv", "pdm", "hatch", "rye", "conda", "mamba", "micromamba", "dotenv", "direnv", "npx", "bunx", "pnpx"]);
/** Wrappers that take a sub-command word before the command they run (`uv run x`, `poetry run x`, `conda run -n e x`). */
const RUN_WORDS = new Set(["run", "exec"]);
/** Options of a wrapper that take a value (skipped with it). */
const WRAPPER_VALUE_OPTIONS = new Set(["-u", "-g", "-n", "-p", "-C", "-k", "-s", "-o", "-e", "--name", "--prefix", "--env-file", "-I", "-L", "-P", "-d", "-a", "--with", "--python", "--package", "-w"]);
/** Config files a tool always reads from the folder it runs in. */
const TOOL_CONFIGS: Record<string, string[]> = {
  npm: ["package.json", "package-lock.json", ".npmrc"],
  pnpm: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"],
  yarn: ["package.json", "yarn.lock", ".yarnrc.yml", ".yarnrc"],
  bun: ["package.json", "bun.lock", "bunfig.toml"],
  npx: ["package.json"],
  tsc: ["tsconfig.json"],
  vite: ["vite.config.ts", "vite.config.js", "vite.config.mjs", "package.json"],
  next: ["next.config.js", "next.config.mjs", "next.config.ts", "package.json"],
  jest: ["jest.config.js", "jest.config.ts", "package.json"],
  vitest: ["vitest.config.ts", "vitest.config.js", "vite.config.ts", "package.json"],
  eslint: ["eslint.config.js", "eslint.config.mjs", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc"],
  prettier: [".prettierrc", ".prettierrc.json", "prettier.config.js"],
  pytest: ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini", "conftest.py"],
  tox: ["tox.ini", "pyproject.toml"],
  mypy: ["mypy.ini", "pyproject.toml", "setup.cfg"],
  ruff: ["ruff.toml", ".ruff.toml", "pyproject.toml"],
  black: ["pyproject.toml"],
  flake8: [".flake8", "setup.cfg", "tox.ini"],
  pylint: [".pylintrc", "pylintrc", "pyproject.toml"],
  pip: ["requirements.txt", "pyproject.toml", "setup.py", "setup.cfg"],
  pip3: ["requirements.txt", "pyproject.toml", "setup.py", "setup.cfg"],
  poetry: ["pyproject.toml", "poetry.lock"],
  uv: ["pyproject.toml", "uv.lock"],
  make: ["Makefile", "makefile", "GNUmakefile"],
  cargo: ["Cargo.toml", "Cargo.lock"],
  go: ["go.mod", "go.sum"],
  docker: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
  "docker-compose": ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
  composer: ["composer.json", "composer.lock"],
  bundle: ["Gemfile", "Gemfile.lock"],
  rake: ["Rakefile"],
  gradle: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
  mvn: ["pom.xml"],
  cmake: ["CMakeLists.txt"],
  terraform: ["main.tf"],
  alembic: ["alembic.ini"],
  manage: [],
};
/** The user's git config files, which every git command loads (home scope: allowlisted, scrubbed). */
const GIT_HOME_CONFIGS = ["~/.gitconfig", "~/.config/git/config"];
/** git's global options that take a value (`-c key=value`, `--git-dir x`). */
const GIT_VALUE_OPTIONS = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
/** `git config` options that change the file. */
const GIT_CONFIG_WRITES = new Set(["--unset", "--unset-all", "--add", "--replace-all", "--rename-section", "--remove-section", "--edit", "-e"]);
/** `git config` options that take a value (`--type bool`, `--default x`). */
const GIT_CONFIG_VALUE_OPTIONS = new Set(["--type", "--default", "--blob", "--comment", "--value"]);
/** Options naming a file the tool reads (`-f Makefile`, `--config x`, `-r requirements.txt`). */
const FILE_OPTIONS = new Set(["-f", "--file", "-c", "--config", "--config-file", "--rcfile", "-r", "--requirement", "--constraint", "-p", "--project", "--env-file", "--settings", "-C"]);
const FILE_OPTION_TOOLS = new Set(["make", "docker", "docker-compose", "awk", "gawk", "pip", "pip3", "pytest", "tsc", "eslint", "prettier", "jest", "vitest", "mypy", "ruff", "pylint", "flake8", "black", "uv", "terraform", "alembic", "gradle", "mvn", "cmake", "helm", "kubectl", "ansible-playbook"]);
/** Options of an interpreter that take a value before the script. */
const INTERPRETER_VALUE_OPTIONS = new Set(["-W", "-X", "--import", "--loader", "--experimental-loader", "--conditions", "-C", "--inspect-port", "--max-old-space-size", "-I", "--title", "--env-file"]);
const NODE_IMPORT_OPTIONS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);

function cleanPathWord(word: string): string | null {
  if (!word || word.length > MAX_PATH_CHARS || word.includes("\0") || word.includes("\n")) return null;
  if (word.includes("://") || /[$`*?{}[\]]/.test(word)) return null;
  if (word === "-" || word === "--" || word === "." || word === ".." || word.startsWith("/dev/")) return null;
  // An option's value (`head -n 5`, `cut -f 1,2`), not a file.
  if (/^[+-]?[0-9][0-9,.:kKmMgG]*$/.test(word)) return null;
  return word.replace(/[,;:]+$/, "") || null;
}

/** A word that looks like a path: `/abs`, `~/x`, `./x`, `../x`, `dir/file`, `file.ext`. */
export function looksLikePath(word: string): boolean {
  if (!word || word.startsWith("-") || word.includes("=") && !word.includes("/")) return false;
  return /^(?:\/|~\/|\.{1,2}\/|[A-Za-z]:[\\/])/.test(word) || (word.includes("/") && !/^[a-z][a-z0-9+.-]*:/i.test(word)) || /^[^/\\\s]+\.[A-Za-z0-9]{1,12}$/.test(word);
}

/** Quoted paths a piece of code names (a `-c` script, a heredoc body), with `open(x, 'w')` as a write. */
export function codePathUses(code: string): Array<{ word: string; op: ShellUseOp }> {
  const out: Array<{ word: string; op: ShellUseOp }> = [];
  const text = code.length > MAX_COMMAND_CHARS ? code.slice(0, MAX_COMMAND_CHARS) : code;
  const writes = new Set<string>();
  for (const match of text.matchAll(/open\(\s*(?:r|f|b)?(['"])([^'"\n]{1,4096})\1\s*,\s*(?:mode\s*=\s*)?(['"])([^'"]*)\3/g)) {
    if (/[wax+]/.test(match[4]!)) writes.add(match[2]!);
  }
  for (const match of text.matchAll(/(?:writeFileSync|writeFile|appendFileSync|createWriteStream|write_text|write_bytes|to_csv|to_json|to_parquet|savefig|save|imwrite|screenshot)\(\s*(?:path\s*=\s*)?(?:Path\()?(['"`])([^'"`\n]{1,4096})\1/g)) writes.add(match[2]!);
  for (const match of text.matchAll(/(['"`])([^'"`\n]{1,4096})\1/g)) {
    const word = match[2]!;
    if (!looksLikePath(word) || /\s/.test(word) && !word.startsWith("/")) continue;
    out.push({ word, op: writes.has(word) ? "write" : "read" });
  }
  return out;
}

function baseName(word: string): string {
  const name = word.split(/[\\/]/).at(-1) ?? word;
  return name.toLowerCase().replace(/\.exe$/, "");
}

function interpreterName(word: string): string | null {
  const name = baseName(word);
  if (INTERPRETERS.has(name)) return name;
  if (/^python[0-9.]*$/.test(name)) return "python";
  if (/^pypy[0-9.]*$/.test(name)) return "python";
  if (/^node[0-9]*$/.test(name)) return "node";
  if (/^ruby[0-9.]*$/.test(name)) return "ruby";
  if (/^php[0-9.]*$/.test(name)) return "php";
  return null;
}

/**
 * The files a shell command uses, absolute (see the module comment). Its words are read the way the
 * session's shell reads them (context/commands.ts shellPath: `env` and `platform` are the session's). Never throws.
 */
export function shellCommandUses(command: string, cwd: string, home: string | null = null, env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): ShellUse[] {
  const { isAbsolute, resolve } = platform === "win32" ? win32 : posix;
  const out: ShellUse[] = [];
  const seen = new Set<string>();
  try {
    let dir = cwd;
    const add = (raw: string | undefined, op: ShellUseOp, at = dir, implicit = false) => {
      if (out.length >= MAX_USES || raw === undefined) return;
      const word = cleanPathWord(raw);
      if (!word) return;
      let path: string;
      if (word === "~" || word.startsWith("~/")) {
        if (!home) return;
        path = join(home, word.slice(2));
      } else if (word.startsWith("~")) return;
      else path = isAbsolute(word) ? resolve(word) : resolve(at, word);
      const key = `${op}\0${path}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(implicit ? { path, op, implicit: true } : { path, op });
    };
    const tokens = shellTokens(command, platform).map((token, index, all) => {
      const before = all[index - 1];
      return isWord(token) && !(before && "op" in before && before.op === "heredoc") ? { word: shellPath(token.word, home, env, platform) } : token;
    });
    // Simple commands between control operators.
    const commands: Array<{ words: string[]; redirects: Array<{ op: string; word: string }>; heredoc: string | null; separator: string | null }> = [];
    let current: (typeof commands)[number] = { words: [], redirects: [], heredoc: null, separator: null };
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (isWord(token)) {
        current.words.push(token.word);
        continue;
      }
      const op = token.op;
      if (op === "heredoc") {
        const body = tokens[index + 1];
        if (isWord(body)) {
          // The body belongs to the command that opened it (the last one with words).
          const owner = current.words.length > 0 ? current : [...commands].reverse().find((item) => item.words.length > 0) ?? current;
          owner.heredoc = owner.heredoc === null ? body.word : `${owner.heredoc}\n${body.word}`;
          index += 1;
        }
        continue;
      }
      if (/^(?:>>|>\||&>>|&>|>|>&|<|<<<)$/.test(op)) {
        const target = tokens[index + 1];
        if (isWord(target)) {
          current.redirects.push({ op, word: target.word });
          index += 1;
        }
        continue;
      }
      current.separator = op;
      commands.push(current);
      current = { words: [], redirects: [], heredoc: null, separator: null };
    }
    commands.push(current);

    for (const item of commands) {
      const commandDir = dir;
      for (const redirect of item.redirects) {
        if (redirect.op === "<") add(redirect.word, "read", commandDir);
        else if (redirect.op === "<<<") continue;
        else if (redirect.op === ">&" && /^[0-9-]+$/.test(redirect.word)) continue;
        else add(redirect.word, "write", commandDir);
      }
      const words = item.words.slice();
      // Leading assignments (FOO=1 cmd) and wrappers.
      while (words.length > 0) {
        const first = words[0]!;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
          words.shift();
          continue;
        }
        const name = baseName(first);
        if (!WRAPPERS.has(name)) break;
        words.shift();
        if (name === "timeout" && words[0] && /^[0-9.]+[smhd]?$/.test(words[0])) words.shift();
        while (words.length > 0 && words[0]!.startsWith("-")) {
          const option = words.shift()!;
          if (WRAPPER_VALUE_OPTIONS.has(option) && words.length > 0) words.shift();
        }
        if (words[0] && RUN_WORDS.has(words[0]) && ["uv", "poetry", "pipenv", "pdm", "hatch", "rye", "conda", "mamba", "micromamba"].includes(name)) {
          words.shift();
          while (words.length > 0 && words[0]!.startsWith("-")) {
            const option = words.shift()!;
            if (WRAPPER_VALUE_OPTIONS.has(option) && words.length > 0) words.shift();
          }
        }
        // `npx foo`: a package, not a path; its own configs below.
        if (["npx", "bunx", "pnpx"].includes(name)) {
          add("package.json", "read", commandDir);
          break;
        }
      }
      if (words.length === 0) {
        if (item.heredoc) for (const use of codePathUses(item.heredoc)) add(use.word, use.op, commandDir);
        continue;
      }
      const head = words[0]!;
      const name = baseName(head);
      const args = words.slice(1);
      const operands = (list: string[]) => {
        const result: string[] = [];
        let options = true;
        for (const word of list) {
          if (options && word === "--") {
            options = false;
            continue;
          }
          if (options && word.startsWith("-") && word.length > 1) {
            const equals = word.indexOf("=");
            if (equals > 0 && looksLikePath(word.slice(equals + 1))) add(word.slice(equals + 1), "read", commandDir);
            continue;
          }
          result.push(word);
        }
        return result;
      };

      if (name === "cd" || name === "pushd") {
        const target = args.find((word) => !word.startsWith("-"));
        if (target && (target === "." || target === ".." || cleanPathWord(target))) {
          const expanded = target === "~" || target.startsWith("~/") ? (home ? join(home, target.slice(2)) : null) : target;
          if (expanded) dir = resolve(commandDir, expanded);
        } else if (!target && home) dir = home;
        continue;
      }
      if (name === "source" || name === ".") {
        add(args[0], "exec", commandDir);
        continue;
      }
      if (/^(?:\.{1,2}\/|\/|~\/)/.test(head) && !interpreterName(head) && !SHELLS.has(name)) {
        // `./run.sh x.csv`: the program itself, then its path arguments.
        add(head, "exec", commandDir);
        for (const word of operands(args)) if (looksLikePath(word)) add(word, "read", commandDir);
        continue;
      }
      if (SHELLS.has(name)) {
        const c = args.indexOf("-c");
        if (c >= 0 && args[c + 1] !== undefined) {
          for (const use of shellCommandUses(args[c + 1]!, commandDir, home, env, platform)) {
            const key = `${use.op}\0${use.path}`;
            if (!seen.has(key) && out.length < MAX_USES) {
              seen.add(key);
              out.push(use);
            }
          }
          continue;
        }
        const rest = operands(args);
        if (rest[0]) add(rest[0], "exec", commandDir);
        for (const word of rest.slice(1)) if (looksLikePath(word)) add(word, "read", commandDir);
        if (item.heredoc && !rest[0]) for (const use of shellCommandUses(item.heredoc, commandDir, home, env, platform)) add(use.path, use.op, commandDir);
        continue;
      }
      const interpreter = interpreterName(head);
      if (interpreter) {
        let script: string | null = null;
        let code: string | null = null;
        let module = false;
        const rest: string[] = [];
        for (let index = 0; index < args.length; index += 1) {
          const word = args[index]!;
          if (script !== null || code !== null || module) {
            rest.push(word);
            continue;
          }
          if (word === "-c" || word === "-e" || word === "-p" || word === "--eval" || word === "--print" || word === "-r" && interpreter === "ruby") {
            code = args[index + 1] ?? "";
            index += 1;
            continue;
          }
          if (word === "-m") {
            module = true;
            index += 1;
            continue;
          }
          if (interpreter === "node" && NODE_IMPORT_OPTIONS.has(word)) {
            const value = args[index + 1];
            if (value && /^(?:\.{1,2}\/|\/)/.test(value)) add(value, "read", commandDir);
            index += 1;
            continue;
          }
          if (word.startsWith("-")) {
            if (INTERPRETER_VALUE_OPTIONS.has(word)) index += 1;
            continue;
          }
          if (interpreter === "deno" && (word === "run" || word === "test" || word === "task")) continue;
          if (interpreter === "bun" && (word === "run" || word === "test" || word === "x")) {
            if (word !== "run") break;
            continue;
          }
          if (interpreter === "java" && word === "-jar") continue;
          script = word;
        }
        if (code !== null) for (const use of codePathUses(code)) add(use.word, use.op, commandDir);
        if (script !== null && script !== "-") {
          if (looksLikePath(script) || interpreter === "python" || interpreter === "node") add(script, "exec", commandDir);
        } else if (item.heredoc) for (const use of codePathUses(item.heredoc)) add(use.word, use.op, commandDir);
        for (const word of operands(rest)) if (looksLikePath(word)) add(word, "read", commandDir);
        if (interpreter === "bun") for (const file of TOOL_CONFIGS.bun!) add(file, "read", commandDir);
        continue;
      }
      if (PATTERN_FIRST.has(name)) {
        const isSed = name === "sed";
        const isAwk = /awk$/.test(name);
        let patternGiven = false;
        let inPlace = false;
        const files: string[] = [];
        for (let index = 0; index < args.length; index += 1) {
          const word = args[index]!;
          if (word === "-e" || word === "--regexp" || word === "--expression") {
            patternGiven = true;
            index += 1;
            continue;
          }
          if (word === "-f" || word === "--file") {
            add(args[index + 1], "read", commandDir);
            patternGiven = true;
            index += 1;
            continue;
          }
          if (isSed && (word === "-i" || word.startsWith("-i") || word === "--in-place" || /^-[a-zA-Z]*i/.test(word))) inPlace = true;
          if (word.startsWith("-") && word.length > 1) {
            if (["-A", "-B", "-C", "-m", "-g", "--glob", "-t", "--type", "-v", "-F", "-d", "--max-count", "-j"].includes(word) && !isAwk && name !== "sed" && word !== "-v" && word !== "-F") index += 1;
            else if (isAwk && (word === "-v" || word === "-F")) index += 1;
            continue;
          }
          if (!patternGiven) {
            patternGiven = true;
            continue;
          }
          files.push(word);
        }
        for (const word of files) add(word, isSed && inPlace ? "write" : "read", commandDir);
        continue;
      }
      if (COPIERS.has(name)) {
        const rest = operands(args).filter((word) => !word.includes(":") || /^[A-Za-z]:[\\/]/.test(word) || word.startsWith("/"));
        if (name === "ln") continue;
        const target = rest.at(-1);
        for (const word of rest.slice(0, -1)) add(word, "read", commandDir);
        if (target && rest.length > 1) add(target, "write", commandDir);
        continue;
      }
      if (WRITERS.has(name)) {
        for (const word of operands(args)) add(word, "write", commandDir);
        continue;
      }
      if (name === "git") {
        // The user's git config, which every git command loads.
        for (const file of GIT_HOME_CONFIGS) add(file, "read", commandDir, true);
        let at = commandDir;
        let index = 0;
        // Global options before the sub-command (`-C dir`, `-c key=value`, `--git-dir=x`).
        while (index < args.length && args[index]!.startsWith("-")) {
          const option = args[index]!;
          if (option === "-C" && args[index + 1] !== undefined) {
            const target = args[index + 1]!;
            const expanded = target === "~" || target.startsWith("~/") ? (home ? join(home, target.slice(2)) : null) : target;
            if (expanded) at = resolve(at, expanded);
            index += 2;
            continue;
          }
          index += GIT_VALUE_OPTIONS.has(option) ? 2 : 1;
        }
        const sub = args[index];
        const rest = args.slice(index + 1);
        if (sub === "config") {
          // Keys and values are not paths; only `--file`/`-f` names one, and a write goes to its file.
          let file: string | null = null;
          let scope: "global" | "system" | "local" = "local";
          let write = false;
          const positional: string[] = [];
          for (let at2 = 0; at2 < rest.length; at2 += 1) {
            const word = rest[at2]!;
            if (word === "-f" || word === "--file") {
              file = rest[at2 + 1] ?? null;
              at2 += 1;
            } else if (word.startsWith("--file=")) file = word.slice("--file=".length);
            else if (word === "--global") scope = "global";
            else if (word === "--system") scope = "system";
            else if (GIT_CONFIG_WRITES.has(word) || GIT_CONFIG_WRITES.has(word.split("=")[0]!)) write = true;
            else if (GIT_CONFIG_VALUE_OPTIONS.has(word)) at2 += 1;
            else if (!word.startsWith("-")) positional.push(word);
          }
          // `git config set|unset ...` (git 2.46+), or `git config <key> <value>`.
          if (positional[0] === "set" || positional[0] === "unset" || positional[0] === "rename-section" || positional[0] === "remove-section") write = true;
          else if (positional[0] !== "get" && positional[0] !== "list" && positional.length >= 2) write = true;
          if (file) add(file, write ? "write" : "read", at);
          else if (write && scope === "global") add("~/.gitconfig", "write", at);
          else if (write && scope === "local") add(".git/config", "write", at);
          continue;
        }
        // Other sub-commands: only explicit pathspecs after `--`.
        const separator = rest.indexOf("--");
        if (separator >= 0) for (const word of rest.slice(separator + 1)) if (looksLikePath(word)) add(word, "read", at);
        continue;
      }
      if (name === "tar") {
        const mode = args.find((word) => /^-?[a-zA-Z]*[ctxru][a-zA-Z]*$/.test(word)) ?? "";
        const fIndex = args.findIndex((word) => word === "-f" || word === "--file" || /^-?[a-zA-Z]*f$/.test(word));
        const archive = fIndex >= 0 ? args[fIndex + 1] : undefined;
        if (archive) add(archive, /c/.test(mode) ? "write" : "read", commandDir);
        if (/c/.test(mode)) for (const word of operands(args).filter((word) => word !== archive && word !== mode)) if (looksLikePath(word)) add(word, "read", commandDir);
        continue;
      }
      if (READERS.has(name)) {
        for (const word of operands(args)) add(word, "read", commandDir);
        continue;
      }
      if (["gcc", "g++", "cc", "c++", "clang", "clang++", "javac", "rustc", "nvcc", "gfortran"].includes(name)) {
        for (let index = 0; index < args.length; index += 1) {
          const word = args[index]!;
          if (word === "-o") {
            add(args[index + 1], "write", commandDir);
            index += 1;
          } else if (word === "-include" || word === "-imacros") {
            add(args[index + 1], "read", commandDir);
            index += 1;
          } else if (["-I", "-L", "-isystem", "-D", "-U", "-l", "-cp", "-classpath", "-d", "-x", "-MF"].includes(word)) index += 1;
          else if (!word.startsWith("-") && looksLikePath(word)) add(word, "read", commandDir);
        }
        continue;
      }
      // Build, test and package tools: the configs they load and the files their options name.
      const configs = TOOL_CONFIGS[name] ?? (name === "docker" ? TOOL_CONFIGS.docker : undefined);
      if (configs) for (const file of configs) add(file, "read", commandDir);
      if (name === "docker" && args[0] === "compose") for (const file of TOOL_CONFIGS["docker-compose"]!) add(file, "read", commandDir);
      if (FILE_OPTION_TOOLS.has(name) || configs) {
        for (let index = 0; index < args.length; index += 1) {
          const word = args[index]!;
          if (FILE_OPTIONS.has(word) && args[index + 1] !== undefined && looksLikePath(args[index + 1]!)) {
            add(args[index + 1], "read", commandDir);
            index += 1;
          }
        }
      }
      // `python manage.py`-style tools are covered above; anything else: its path-looking words.
      for (const word of operands(args)) if (looksLikePath(word)) add(word, "read", commandDir);
      if (item.heredoc) for (const use of codePathUses(item.heredoc)) add(use.word, use.op, commandDir);
    }
  } catch {
    // Best effort: what was found so far.
  }
  return out;
}
