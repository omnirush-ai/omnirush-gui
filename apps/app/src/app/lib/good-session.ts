// "Good session ★": the live checklist and the don't-quit-mid-turn guard.
//
// A Good session is one the server's strict check passes (omnirush-backend:
// session_repro.py REASONS and WorkSize.floor, the Session QC V2 gate, Session
// QC V3's blocking checks and quality_rewards.STRICT_SPINS_TEXT). The rules
// below mirror the parts of that check a turn can see as it runs. They never
// show a check as passed where the server's check fails; the filled ★ comes
// only from the server's verdict, after upload.
//
//   code     WorkSize.floor's code part: 2+ project code files and 30+ lines
//            changed, or 5+ files and 150+ lines (session_qc.is_code_path,
//            session_repro._written_lines)
//   ran      a build or test run (session_qc.BUILD_TEST, WorkSize.test_runs)
//   project  the work stays inside the project folder (V3 outside_path,
//            home_folder, shell writes outside it), with no personal or
//            outside service (V3 remote_service, local_database, remote_git,
//            docker, public_web, private_web, external_browser,
//            local_service) and no machine-specific program (V3
//            host_only_program)
//   finished the last turn finished (V3 unrecorded_turn, V2 `finished`)
//   windows  not native Windows (V3 windows_host); WSL is fine. Left out
//            while the server counts native Windows: `windows_counts` in the
//            account's quality block (/device/me, GET /me/quality); the
//            desktop then passes `nativeWindows: false` (`windowsNotCounted`)
//
// Sub-agents and many turns are not required.
//
// The rules (everything from "Code files" to "The don't-quit-mid-turn guard")
// are the same, line for line, as the CLI's
// assets/extensions/omnirush/good-session-lib.js; only the types differ. The
// desktop's own part is `messageFacts` (the transcript as tool calls).

import type { UIMessage } from "ai";
import type { OmniRushSessionStatus } from "@omnirush/types/desktop-ipc";

export const GOOD_SESSION_LABEL = "Good session ★";
/** All local checks pass; the server decides after upload. */
export const GOOD_SESSION_ON_TRACK = "On track for a Good session ★ (final check after upload)";

/** The four steps the rewards panel and the checklist's link show. */
export const GOOD_SESSION_GUIDE: readonly string[] = Object.freeze([
  "Work inside your project folder.",
  "Build or change real code.",
  "Run it or its tests.",
  "Let the last turn finish.",
]);
export const GOOD_SESSION_WSL_TIP = "On Windows? Use WSL.";
export const GOOD_SESSION_GUIDE_LINK = "How to make a Good session";

/** The console's WSL guide (omnirush-console app/console/wsl, lib/wsl-guide). */
export const WSL_GUIDE_URL = "https://omnirush.ai/console/wsl";
export const WSL_BANNER_TEXT = "Sessions from native Windows don't count as Good sessions. Switch to WSL";

export const TURN_GUARD_TITLE = "A turn is still running.";
export const TURN_GUARD_DETAIL = `Quit now and this session won't count as a ${GOOD_SESSION_LABEL}.`;
export const TURN_GUARD_MESSAGE = `${TURN_GUARD_TITLE} ${TURN_GUARD_DETAIL}`;
/** Keeps the app open and lets the running turn finish. */
export const TURN_GUARD_WAIT = "Finish it";
export const TURN_GUARD_QUIT = "Quit anyway";

export const NUDGE_TITLE = `Not a ${GOOD_SESSION_LABEL} yet`;

/** The finish guard (M4b): no turn runs, but the last one needs finishing. */
export type FinishGuardKind = "awaiting" | "cut";
export const FINISH_GUARD_TITLE = "This session is one step from counting.";
export const FINISH_GUARD_DETAIL: Readonly<Record<FinishGuardKind, string>> = Object.freeze({
  awaiting: "The agent asked you a question. Answer it (or tell it to go ahead) and let the turn finish, or this session won't pass the quality check.",
  cut: "The last turn stopped before it finished. Send \"continue\" and let it finish, or this session won't pass the quality check.",
});
export const FINISH_GUARD_FINISH = "Finish it";
export const FINISH_GUARD_QUIT = "Quit anyway";
/** What "Finish it" puts in the composer (editable, not sent). */
export const FINISH_GUARD_PROMPT: Readonly<Record<FinishGuardKind, string>> = Object.freeze({
  awaiting: "Go ahead.",
  cut: "Continue and finish the task.",
});
/** The desktop's "Finish it" ({ sessionId, kind }), from the native dialog (turn-guard.mjs) or the in-app one. */
export const FINISH_GUARD_EVENT = "omnirush:finish-guard:finish";

/**
 * Server texts that still say "replay-ready ★" (older servers): users read
 * "Good session ★" everywhere.
 */
export function goodSessionWording(text: string): string;
export function goodSessionWording(text: string | null | undefined): string | null | undefined;
export function goodSessionWording(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  return String(text)
    .replace(/\breplay[- ]ready ★ sessions\b/gi, "Good sessions ★")
    .replace(/\breplay[- ]ready ★ session\b/gi, "Good session ★")
    .replace(/\breplay[- ]ready ★/gi, GOOD_SESSION_LABEL)
    .replace(/★ ?replay[- ]ready sessions\b/gi, "★ Good sessions")
    .replace(/\breplay[- ]ready sessions\b/gi, "Good sessions")
    .replace(/\breplay[- ]ready session\b/gi, "Good session")
    .replace(/\breplay[- ]ready\b/gi, "Good session");
}

// --- Code files (session_qc.is_code_path) -----------------------------------

const NON_CODE_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".rst", ".adoc", ".org", ".rtf", ".doc", ".docx", ".pdf",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tif", ".tiff", ".avif", ".heic",
  ".ttf", ".otf", ".woff", ".woff2", ".eot", ".mp3", ".wav", ".mp4", ".mov", ".log", ".csv",
  ".tsv", ".jsonl", ".xlsx", ".pptx", ".sqlite", ".sqlite3", ".db", ".bin", ".zip", ".tar",
  ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".whl",
]);
const INTERNAL_DIRS = [
  "__agent__/", ".omnirush/", ".opencode/", ".pi/", ".godot/", ".git/", "node_modules/", ".venv/",
  "venv/", "__pycache__/", ".idea/", ".vscode/", ".next/", ".nuxt/", ".svelte-kit/", ".turbo/",
  ".cache/", ".parcel-cache/", "coverage/", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/",
  ".gradle/", "cmake-build-",
];
const BUILD_OUTPUT_DIRS = new Set(["dist", "build", "out", "target"]);
const SOURCE_DIRS = new Set(["src", "app", "lib", "main", "java", "kotlin"]);
const GENERATED_FILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "packages.lock.json", "pnpm-lock.yaml", "go.sum"]);
const GENERATED_SUFFIXES = [
  ".lock", ".lockb", ".tsbuildinfo", ".sst", ".map", ".min.js", ".min.css", ".pyc", ".pyo", ".o",
  ".obj", ".a", ".class", ".jar", ".so", ".dll", ".dylib", ".exe", ".wasm",
];
const CODE_FILENAMES = new Set([
  "dockerfile", "containerfile", "makefile", "gnumakefile", "justfile", "gemfile", "rakefile",
  "podfile", "brewfile", "jenkinsfile", "procfile", "vagrantfile", "build", "workspace",
  "cmakelists.txt", "package.json", "cargo.toml", "go.mod", "pyproject.toml",
]);
const REQUIREMENTS_FILE = /^requirements[\w.-]*\.(txt|in)$/;
const SCRIPT_DIRS = new Set(["bin", "scripts"]);
const AGENT_NOTES = new Set(["swarm.md", "plan.json", "readme"]);
const SCRATCH_PREFIXES = ["/tmp/", "/var/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", "/dev/"];
const WINDOWS_SCRATCH = /^[a-z]:\/windows\/temp\/|\/appdata\/local\/temp\//;
const WINDOWS_DRIVE = /^[a-z]:\//;

function normPath(value: unknown): string {
  let norm = String(value).replace(/\\/g, "/").toLowerCase();
  while (norm.startsWith("./")) norm = norm.slice(2);
  return norm;
}

function isScratch(norm: string): boolean {
  return SCRATCH_PREFIXES.some((prefix) => norm.startsWith(prefix)) || WINDOWS_SCRATCH.test(norm);
}

function notProject(norm: string): boolean {
  if (isScratch(norm)) return true;
  if (INTERNAL_DIRS.some((dir) => norm.startsWith(dir) || norm.includes(`/${dir}`))) return true;
  const folders = norm.split("/").slice(0, -1);
  const absolute = norm.startsWith("/") || norm.startsWith("~/") || WINDOWS_DRIVE.test(norm);
  return folders.some((folder, index) => BUILD_OUTPUT_DIRS.has(folder)
    && ((!absolute && index === 0) || (absolute && index > 0 && !SOURCE_DIRS.has(folders[index - 1] ?? ""))));
}

/** Whether a changed file counts as project code (session_qc.is_code_path). */
export function isCodePath(value: unknown): boolean {
  const norm = normPath(String(value ?? "").trim());
  if (!norm || notProject(norm)) return false;
  const folders = norm.split("/").slice(0, -1);
  const name = norm.slice(norm.lastIndexOf("/") + 1);
  if (!name) return false;
  if (GENERATED_FILES.has(name) || GENERATED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
  if (CODE_FILENAMES.has(name) || REQUIREMENTS_FILE.test(name)) return true;
  if (folders.at(-1) === "requirements" && name.endsWith(".txt")) return true;
  if (AGENT_NOTES.has(name)) return false;
  if (!name.includes(".")) return folders.some((folder) => SCRIPT_DIRS.has(folder));
  return !NON_CODE_EXTENSIONS.has(name.slice(name.lastIndexOf(".")));
}

/** WorkSize.floor's code part: files and lines (the build/test part is the `ran` check). */
export const FLOOR_FILES = 2;
export const FLOOR_LINES = 30;
export const FLOOR_ALONE_FILES = 5;
export const FLOOR_ALONE_LINES = 150;

/** Lines an edit put in (session_repro._written_lines; apply_patch: its added lines). */
export function writtenLines(input: unknown): number {
  const value = record(input);
  for (const key of ["content", "newString", "new_string", "new_str", "newText", "new_text"]) {
    if (typeof value[key] === "string") return (value[key] as string).split("\n").length;
  }
  if (Array.isArray(value.edits)) {
    return value.edits.reduce((total: number, edit: unknown) => total + writtenLines(edit), 0);
  }
  const patch = str(value.patchText) || str(value.patch) || str(value.input);
  return patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
}

// --- Commands (session_qc.BUILD_TEST, session_qc_v2._runs, V3) ----------------

/** A build, a test run or a linter/type check (session_qc.BUILD_TEST): what WorkSize.test_runs counts. */
const BUILD_TEST = new RegExp(
  String.raw`^(pytest|unittest|tox|nox|npm (run )?(test|build|lint)|`
  + String.raw`yarn (test|build)|pnpm (test|build)|bun test|jest|vitest|mocha|`
  + String.raw`go (test|build|vet)|cargo (test|build|check|clippy)|make\b|cmake|`
  + String.raw`mvn|gradle|dotnet (test|build)|tsc\b|eslint|ruff|mypy|flake8|`
  + String.raw`black --check|gcc|g\+\+|clang|javac|rustc|`
  + String.raw`python3? -m (pytest|unittest|py_compile)|node --test|php(unit)?|`
  + String.raw`rspec)`,
  "i",
);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
const WRAPPERS = new Set(["sudo", "time", "nice", "env", "exec", "command", "timeout", "npx", "bunx", "pnpx", "uv", "poetry", "run"]);

/** The commands of a shell line, each as its words (V2 `_split`/`_words`). */
export function commandSegments(command: unknown): string[][] {
  return String(command ?? "")
    .split(/\n|&&|\|\||;|\||\(|\)|`|\$\(|&/)
    .map((segment) => {
      const words = segment.trim().split(/\s+/).filter(Boolean);
      while (words.length) {
        const first = words[0]!;
        if (ENV_ASSIGN.test(first)) { words.shift(); continue; }
        if (WRAPPERS.has(first)) {
          words.shift();
          while (/^-/.test(words[0] ?? "")) words.shift();
          if (first === "timeout" && /^\d/.test(words[0] ?? "")) words.shift();
          continue;
        }
        break;
      }
      return words;
    })
    .filter((words) => words.length > 0);
}

/** Whether a shell line builds or tests (session_qc.BUILD_TEST, the only runs WorkSize counts). */
export function ranSomething(command: unknown): boolean {
  return commandSegments(command).some((words) => BUILD_TEST.test(words.join(" ")));
}

const REMOTE_PROGRAMS = new Set([
  "gh", "glab", "ssh", "scp", "sftp", "aws", "gcloud", "az", "vercel", "netlify", "firebase",
  "supabase", "wrangler", "flyctl", "fly", "heroku", "railway", "kubectl", "helm", "terraform",
  "doctl", "ngrok", "cloudflared", "gsutil", "eas",
]);
/** Programs only the user's machine has (V3 HOST_PROGRAMS, plus the desktop openers). */
const HOST_PROGRAMS = new Set([
  "osascript", "xcodebuild", "xcrun", "sips", "qlmanage", "pbcopy", "pbpaste", "defaults", "launchctl",
  "safaridriver", "system_profiler", "ioreg", "diskutil", "powershell", "powershell.exe", "pwsh", "cmd",
  "cmd.exe", "wsl", "wsl.exe", "adb", "fastboot", "nvidia-smi", "systemctl", "journalctl", "networksetup",
  "java_home", "nix", "nix-shell", "nix-build", "nix-env", "flutter", "dart", "swift", "swiftc",
  "open", "xdg-open", "start", "explorer.exe", "notify-send", "xclip", "xsel",
]);
const DB_CLIENTS = new Set(["psql", "pgcli", "mysql", "mariadb", "mycli", "mongosh", "mongo", "redis-cli"]);
const DOCKER_PROGRAMS = new Set(["docker", "docker-compose", "podman"]);
const FETCHERS = new Set(["curl", "wget", "http", "https", "httpie", "xh", "aria2c", "fetch"]);
const PROBE_ARGS = new Set(["--help", "--version", "--dry-run", "--dryrun", "-h", "-v"]);
const GIT_REMOTE = /\bgit\s+(-C\s+\S+\s+)?(clone|fetch|pull|push|ls-remote)\b/;
const DB_SETUP = /createdb|create\s+database|initdb|\bmigrate\b|db:migrate|db\s+push|alembic\s+upgrade|drizzle-kit\s+(push|migrate)|\bseed\b|db:seed/i;
const QUOTED = /'[^']*'|"[^"]*"/g;
const URL_ARG = /^['"]?(https?:\/\/[^\s'"]+|(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/[^\s'"]*)?)/i;
/** A server on this machine (V3 LOCAL_URL). */
const LOCAL_URL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w.-]+\.localhost)(:\d+)?(\/|$|\?|#)|^(file|about|data):/i;
/** A command that starts a local server, so later calls to localhost reach it (V3 SERVER_START). */
const SERVER_START = new RegExp(
  String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview|watch)\b|`
  + String.raw`\bnpx\s+(vite(?!\s+build)|serve|http-server|live-server|nodemon)\b|`
  + String.raw`\bvite(\s+(dev|serve|preview)\b|\s+--|\s*$)|`
  + String.raw`\b(nodemon|live-server|http-server)\s|\bnext\s+(dev|start)\b|`
  + String.raw`\bpython3?\s+-m\s+(http\.server|uvicorn|flask|streamlit|gunicorn)\b|`
  + String.raw`\b(uvicorn|gunicorn|hypercorn|daphne)\s|\bflask\s+run\b|`
  + String.raw`manage\.py\s+runserver|\brails\s+s(erver)?\b|\bphp\s+-S\b|`
  + String.raw`\bstreamlit\s+run\b|\b(go|cargo)\s+run\b|\bdeno\s+(run|task)\b|`
  + String.raw`\b(hugo|jekyll)\s+serve|\bexpo\s+start\b|\bwrangler\s+dev\b|`
  + String.raw`\b(vercel|netlify)\s+dev\b|\bollama\s+serve\b|\bredis-server\b|`
  + String.raw`\bmongod\b|\bpg_ctl\s+start\b|\bdocker(-compose|\s+compose)?\s+(up|run)\b|`
  + String.raw`\bnode\s+\S*(server|app|index|main)\S*\.(c|m)?[jt]s\b`,
  "i",
);

/** Whether a shell line starts a local server (V3 SERVER_START). */
export function startsServer(command: unknown): boolean {
  return SERVER_START.test(String(command ?? ""));
}

/** The web addresses a shell line fetches with curl, wget and the like. */
export function fetchedUrls(command: unknown): string[] {
  const urls: string[] = [];
  for (const words of commandSegments(command)) {
    const program = (words[0] ?? "").replace(/^.*\//, "").toLowerCase();
    if (!FETCHERS.has(program)) continue;
    for (const word of words.slice(1)) {
      const match = URL_ARG.exec(word);
      if (match) urls.push(match[1]!);
    }
  }
  return urls;
}

/**
 * What takes a shell line outside the project (V3 remote_service,
 * local_database, remote_git, docker, public_web, host_only_program), as a
 * short name, or null. Calls to this machine (`curl localhost:3000`) are
 * judged by the checklist, which knows whether the session started a server.
 */
export function personalService(command: unknown, { dbBuilt = false }: { dbBuilt?: boolean } = {}): string | null {
  const bare = String(command ?? "").replace(QUOTED, " ");
  if (GIT_REMOTE.test(bare)) return "a remote git repository";
  for (const words of commandSegments(bare)) {
    const program = (words[0] ?? "").replace(/^.*\//, "").toLowerCase();
    if (words.slice(1).some((word) => PROBE_ARGS.has(word))) continue;
    if (REMOTE_PROGRAMS.has(program)) return program;
    if (DOCKER_PROGRAMS.has(program)) return "docker";
    if (DB_CLIENTS.has(program) && !dbBuilt) return program;
    if (HOST_PROGRAMS.has(program)) return `${program}, a program only your machine has`;
  }
  const remote = fetchedUrls(command).find((url) => !LOCAL_URL.test(url));
  if (remote) return `the web (${remote.slice(0, 60)})`;
  return null;
}

/** The files a shell line writes or removes: redirects, tee, cp/mv targets, rm/mkdir/touch arguments. */
export function shellWrites(command: unknown): string[] {
  const text = String(command ?? "");
  const out: string[] = [];
  for (const match of text.matchAll(/(?:^|[^<>&\d])\d?>>?\s*(['"]?)([^\s'";&|<>)]+)\1/g)) {
    if (!match[2]!.startsWith("&")) out.push(match[2]!);
  }
  for (const words of commandSegments(text.replace(/\d?>>?\s*\S+/g, " "))) {
    const program = (words[0] ?? "").replace(/^.*\//, "").toLowerCase();
    const args = words.slice(1).filter((word) => !word.startsWith("-")).map((word) => word.replace(/^['"]|['"]$/g, ""));
    if (program === "tee" || program === "rm" || program === "rmdir" || program === "mkdir" || program === "touch" || program === "chmod") {
      out.push(...(program === "chmod" ? args.slice(1) : args));
    } else if ((program === "cp" || program === "mv" || program === "ln" || program === "install" || program === "rsync") && args.length >= 2) {
      out.push(args.at(-1)!);
      if (program === "mv") out.push(...args.slice(0, -1));
    }
  }
  return out;
}

// --- Folders ---------------------------------------------------------------

const HOME_FOLDER = /^(\/home\/[^/]+|\/users\/[^/]+|\/root|[a-z]:\/users\/[^/]+|~)\/?$/;
const HOME_PREFIX = /^(\/home\/[^/]+|\/users\/[^/]+|\/root|[a-z]:\/users\/[^/]+)(\/|$)/;

function folderKey(value: unknown): string {
  return normPath(String(value ?? "").trim()).replace(/\/+$/, "");
}

/** The project folder is the home folder itself (V3 home_folder). */
export function isHomeFolder(root: unknown): boolean {
  return HOME_FOLDER.test(folderKey(root));
}

function isAbsolute(norm: string): boolean {
  return norm.startsWith("/") || norm.startsWith("~") || norm.startsWith("$home") || WINDOWS_DRIVE.test(norm);
}

function resolveDots(value: string): string {
  const out: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "..") {
      if (out.length > 1) out.pop();
    } else if (segment !== "." && (segment || out.length === 0)) {
      out.push(segment);
    }
  }
  return out.join("/");
}

function homeSplit(norm: string): { home: string; rest: string } | null {
  const tilde = /^(~|\$home|\$\{home\})(\/|$)/.exec(norm);
  if (tilde) return { home: "~", rest: norm.replace(/^(~|\$home|\$\{home\})(\/|$)/, "") };
  const match = HOME_PREFIX.exec(norm);
  return match ? { home: match[1], rest: norm.slice(match[1].length + 1) } : null;
}

/** Whether a path the agent changed or worked in is outside the project folder (scratch folders are fine). */
export function outsideProject(file: unknown, root: unknown): boolean {
  let norm = folderKey(file);
  const base = folderKey(root);
  if (!norm || !base) return false;
  const baseSplit = homeSplit(base);
  const normSplit = homeSplit(norm);
  if (baseSplit && normSplit && (baseSplit.home === "~" || normSplit.home === "~" || baseSplit.home === normSplit.home)) {
    // Both sides sit under the same home folder (`~/...` matches its absolute form):
    // expand the home prefix again so dot segments and scratch paths use the
    // same rules as ordinary absolute paths.
    const home = baseSplit.home === "~" ? normSplit.home : baseSplit.home;
    norm = resolveDots(`${home}/${normSplit.rest}`);
    const resolvedBase = resolveDots(`${home}/${baseSplit.rest}`);
    if (isScratch(`${norm}/`)) return false;
    return norm !== resolvedBase && !norm.startsWith(`${resolvedBase}/`);
  }
  if (/^(~|\$home|\$\{home\})(\/|$)/.test(norm)) {
    // `~/x`: under the home folder the project folder sits in, when it sits in one.
    const home = HOME_PREFIX.exec(base)?.[1];
    if (!home) return true;
    norm = norm.replace(/^(~|\$home|\$\{home\})/, home);
  }
  if (!isAbsolute(norm)) {
    // Relative to the project folder: only `..` can leave it.
    if (!norm.split("/").includes("..")) return false;
    norm = resolveDots(`${base}/${norm}`);
  } else {
    norm = resolveDots(norm);
  }
  if (isScratch(`${norm}/`)) return false;
  return norm !== base && !norm.startsWith(`${base}/`);
}

// --- Tool calls -------------------------------------------------------------------

const EDIT_TOOLS = new Set([
  "edit", "write", "patch", "multiedit", "apply_patch", "str_replace", "str_replace_editor", "create", "notebookedit",
]);
const SHELL_TOOLS = new Set(["bash", "shell", "run", "exec", "terminal", "execute", "bash_output"]);
const WEB_TOOLS = new Set(["webfetch", "web_fetch", "websearch", "web_search"]);
const BROWSER_TOOL = /^browser_|^(playwright|puppeteer|chrome)[_-]/;
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

/** A call the engine or the user refused, so nothing ran (bad arguments, an unknown tool, a denied permission). */
const NOT_RUN = /invalid arguments|no tool named|unknown tool|tool .{0,40}not (found|available)|permission .{0,20}(denied|rejected)|user (rejected|denied|dismissed)/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export type ToolCall = { tool: string; input: Record<string, unknown>; failed: boolean; notRun: boolean; unfinished: boolean };

/**
 * One tool call, from either engine: { tool, input, failed, errorText,
 * unfinished }. `failed`: the call ended in an error; `errorText`: what the
 * error said (a refusal counts for nothing); `unfinished`: it never ended.
 */
export function toolCall({ tool, input, failed = false, errorText = "", unfinished = false }: {
  tool?: unknown; input?: unknown; failed?: boolean; errorText?: unknown; unfinished?: boolean;
} = {}): ToolCall {
  const isFailed = Boolean(failed);
  return {
    tool: String(tool ?? "").toLowerCase().replace(/^.*[.:]/, ""),
    input: record(input),
    failed: isFailed,
    notRun: isFailed && NOT_RUN.test(str(errorText)),
    unfinished: Boolean(unfinished),
  };
}

/** The files an edit tool changed: its path field, or the files its patch names. */
export function editedPaths(input: unknown): string[] {
  const value = record(input);
  const direct = str(value.filePath) || str(value.file_path) || str(value.path) || str(value.file) || str(value.target_file);
  if (direct) return [direct];
  const patch = str(value.patchText) || str(value.patch) || str(value.input);
  const paths: string[] = [];
  for (const match of patch.matchAll(PATCH_FILE)) {
    const file = (match[1] ?? match[2] ?? "").trim();
    if (file) paths.push(file);
  }
  return paths;
}

function shellCommand(input: Record<string, unknown>): string {
  const command = input.command ?? input.cmd ?? input.script;
  if (Array.isArray(command)) return command.filter((word) => typeof word === "string").join(" ");
  return str(command);
}

function shellFolders(command: string, input: Record<string, unknown>): string[] {
  const folders = [str(input.workdir), str(input.cwd), str(input.directory)].filter(Boolean);
  for (const words of commandSegments(command.replace(QUOTED, (quoted) => quoted.slice(1, -1).replace(/\s/g, "\u0000")))) {
    if ((words[0] === "cd" || words[0] === "pushd") && words[1]) folders.push(words[1].replace(/\u0000/g, " "));
  }
  return folders;
}

function toolUrl(input: Record<string, unknown>): string {
  return str(input.url) || str(input.href) || str(input.uri);
}

// --- The checklist -----------------------------------------------------------

export type GoodSessionCheckId = "code" | "ran" | "project" | "finished" | "windows";
/** "warn" comes from the server only. */
export type GoodSessionCheckState = "pass" | "fail" | "warn" | "pending";

export type GoodSessionCheck = {
  /** A GoodSessionCheckId locally; the server's ids may grow. */
  id: string;
  state: GoodSessionCheckState;
  /** "code changed", "ran/tested", "in project", "finish your turn". */
  label: string;
  /** Why it fails, or what to do next. */
  hint: string;
};

/** "incomplete": a check fails or the turn runs; "on-track": every local check passes; "good": the server says so. */
export type GoodSessionVerdict = "incomplete" | "on-track" | "good";

export type GoodSessionChecklist = {
  checks: GoodSessionCheck[];
  verdict: GoodSessionVerdict;
  /** Every local check passes (the server still decides). */
  onTrack: boolean;
  /** The checks that still fail, without the running turn. */
  missing: GoodSessionCheck[];
  /** "Good session: code changed ✓ · ran/tested ✗ · in project ✓ · finish your turn". */
  text: string;
  /** The work as WorkSize counts it. */
  work: { codeFiles: number; lines: number; testRuns: number };
};

export type GoodSessionInput = {
  /** toolCall()s, oldest first. */
  calls?: readonly ToolCall[];
  /** The project folder the session runs in. */
  workspaceRoot?: string;
  /** A turn is running (busy, retrying, waiting on a question or a permission). */
  turnRunning?: boolean;
  /**
   * "pass": the last turn ended on an answer (no error, no unfinished tool,
   * text after the last tool call, a good finish reason); "awaiting": that
   * answer asks the user something; "cut": anything else.
   */
  lastTurn?: LastTurn;
  /** Native Windows (not WSL). */
  nativeWindows?: boolean;
  /** Remote workspaces do not necessarily have a local project folder. */
  isRemoteWorkspace?: boolean;
  /** The server checked this session after upload and it is a Good session ★. */
  serverGood?: boolean;
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The checklist for a session, from its tool calls. */
export function goodSessionChecklist({
  calls = [], workspaceRoot = "", turnRunning = false, lastTurn = "cut", nativeWindows = false, isRemoteWorkspace = false, serverGood = false,
}: GoodSessionInput = {}): GoodSessionChecklist {
  const codeFiles = new Map<string, number>();
  let testRuns = 0;
  let outside: string | null = null;
  let service: string | null = null;
  let serverStarted = false;
  let localUnstarted: string | null = null;
  const home = String(workspaceRoot).trim() ? isHomeFolder(workspaceRoot) : false;
  const unknownRoot = !folderKey(workspaceRoot);
  const dbBuilt = calls.some((call) => SHELL_TOOLS.has(call.tool) && DB_SETUP.test(shellCommand(call.input)));
  const local = (url: string) => {
    if (!serverStarted) localUnstarted ??= url;
  };

  for (const call of calls) {
    if (call.notRun) continue;
    if (EDIT_TOOLS.has(call.tool)) {
      const files = editedPaths(call.input);
      for (const file of files) {
        if (outsideProject(file, workspaceRoot)) {
          outside ??= file;
          continue;
        }
        if (!call.failed && isCodePath(file)) {
          const key = folderKey(file);
          codeFiles.set(key, (codeFiles.get(key) ?? 0) + (files.length === 1 ? writtenLines(call.input) : 0));
        }
      }
      if (!call.failed && files.length > 1) {
        // A patch over several files: its added lines go to the first code file.
        const first = files.map(folderKey).find((key) => codeFiles.has(key));
        if (first) codeFiles.set(first, (codeFiles.get(first) ?? 0) + writtenLines(call.input));
      }
    } else if (SHELL_TOOLS.has(call.tool)) {
      const command = shellCommand(call.input);
      if (!command) continue;
      if (ranSomething(command)) testRuns += 1;
      service ??= personalService(command, { dbBuilt });
      for (const url of fetchedUrls(command)) if (LOCAL_URL.test(url)) local(url);
      if (startsServer(command)) serverStarted = true;
      for (const folder of [...shellFolders(command, call.input), ...shellWrites(command)]) {
        if (outsideProject(folder, workspaceRoot)) outside ??= folder;
      }
    } else if (WEB_TOOLS.has(call.tool) || BROWSER_TOOL.test(call.tool)) {
      const url = toolUrl(call.input);
      if (url && LOCAL_URL.test(url)) local(url);
      else if (url || WEB_TOOLS.has(call.tool)) service ??= `the web (${(url || call.tool).slice(0, 60)})`;
    }
  }

  const fileCount = codeFiles.size;
  const lines = [...codeFiles.values()].reduce((total, count) => total + count, 0);
  const code = (fileCount >= FLOOR_FILES && lines >= FLOOR_LINES) || (fileCount >= FLOOR_ALONE_FILES && lines >= FLOOR_ALONE_LINES);
  const codeShort = fileCount < FLOOR_FILES
    ? ` (${fileCount} of ${FLOOR_FILES} files)`
    : lines < FLOOR_LINES ? ` (${lines} of ${FLOOR_LINES} lines)` : "";
  const finished = turnRunning ? "pending" : lastTurn;
  const noRoot = !isRemoteWorkspace && unknownRoot && calls.some((call) => !call.notRun);
  const checks: GoodSessionCheck[] = [
    {
      id: "code",
      state: code ? "pass" : "fail",
      label: `code changed${code ? "" : codeShort}`,
      hint: code
        ? `${plural(fileCount, "code file")} and ${plural(lines, "line")} changed.`
        : fileCount === 0
          ? "Build or change real code in the project."
          : `Build or change more real code: ${FLOOR_FILES}+ code files and ${FLOOR_LINES}+ lines.`,
    },
    {
      id: "ran",
      state: testRuns > 0 ? "pass" : "fail",
      label: "ran/tested",
      hint: testRuns > 0 ? "The agent ran a build or the tests." : "Ask the agent to build it or run its tests.",
    },
    {
      id: "project",
      state: home || noRoot || outside || service || localUnstarted ? "fail" : "pass",
      label: "in project",
      hint: home
        ? "The session runs in your home folder: open a project folder instead."
        : noRoot
          ? "No project folder open: open a project folder instead."
          : outside
          ? `Work outside the project folder: ${outside}`
          : service
            ? `Uses ${service}: keep the work inside the project.`
            : localUnstarted
              ? `Calls ${localUnstarted} without starting that server in the session: start it in the session.`
              : "The work stays inside the project folder.",
    },
    {
      id: "finished",
      state: finished === "pending" || finished === "pass" ? finished : "fail",
      label: finished === "pending"
        ? "finish your turn"
        : finished === "pass" ? "turn finished" : finished === "awaiting" ? "answer the agent" : "last turn cut off",
      hint: finished === "pending"
        ? "Let the turn finish: quitting or stopping now cuts it off."
        : finished === "pass"
          ? "The last turn finished."
          : finished === "awaiting"
            ? "The agent asked you a question: answer it (or tell it to go ahead) and let the turn finish."
            : "The last turn stopped before it finished: send a follow-up and let it finish.",
    },
  ];
  if (nativeWindows) {
    checks.push({ id: "windows", state: "fail", label: "native Windows", hint: "Sessions from native Windows don't count: use WSL." });
  }
  const missing = checks.filter((check) => check.state === "fail");
  const onTrack = checks.every((check) => check.state === "pass");
  const verdict: GoodSessionVerdict = onTrack ? (serverGood ? "good" : "on-track") : "incomplete";
  return { checks, verdict, onTrack, missing, text: checklistText(checks, verdict), work: { codeFiles: fileCount, lines, testRuns } };
}

function mark(check: GoodSessionCheck): string {
  if (check.state === "pending") return check.label;
  return `${check.label} ${check.state === "pass" ? "✓" : check.state === "warn" ? "!" : "✗"}`;
}

/** The checklist's heading: the filled ★ only on the server's word. */
export function checklistHeading(verdict: GoodSessionVerdict): string {
  return verdict === "good" ? GOOD_SESSION_LABEL : verdict === "on-track" ? GOOD_SESSION_ON_TRACK : "Good session";
}

/** "Good session: code changed ✓ · ran/tested ✗ · in project ✓ · finish your turn". */
export function checklistText(checks: readonly GoodSessionCheck[], verdict: GoodSessionVerdict = "incomplete"): string {
  return `${checklistHeading(verdict)}: ${checks.map(mark).join(" · ")}`;
}

/** The one gentle nudge after a turn ends with something missing, or null. */
export function goodSessionNudge(checklist: Pick<GoodSessionChecklist, "missing"> | null | undefined): { title: string; body: string } | null {
  const missing = checklist?.missing ?? [];
  if (!missing.length) return null;
  return { title: NUDGE_TITLE, body: missing.map((check) => check.hint).join(" ") };
}

/** When to nudge: once per session, on the turn that just ended (running → not running), and only when something is missing. */
export function shouldNudge({ wasRunning, running, checklist, alreadyNudged }: {
  wasRunning: boolean; running: boolean; checklist: Pick<GoodSessionChecklist, "missing"> | null | undefined; alreadyNudged: boolean;
}): boolean {
  return Boolean(wasRunning && !running && !alreadyNudged && (checklist?.missing?.length ?? 0) > 0);
}

// --- The don't-quit-mid-turn guard and the finish guard ---------------------------

export type QuitGuard = {
  readonly state: "idle" | "asking" | "waiting";
  request(input?: { running?: boolean; interactive?: boolean; hangup?: boolean; finish?: string | null }): "quit" | "ask" | "finish";
  answer(wait: boolean): "wait" | "quit";
  askedAbout(finish: string): boolean;
  turnEnded(): boolean;
};

/**
 * `request({ running, interactive, hangup, finish })` answers "quit" (go
 * ahead), "ask" (a turn runs: TURN_GUARD_MESSAGE with "Wait for it" / "Quit
 * anyway") or "finish" (`finish`, a "<session>:<state>" key: the finish
 * guard's "Finish it" / "Quit anyway"). The first quit request while a turn
 * runs asks; a second one, whatever the answer, quits. Each finish key asks
 * once, ever. `answer(wait)` takes the user's choice; `turnEnded()` re-arms
 * the running-turn question for the next turn and says whether the user was
 * waiting. Headless runs and a closed terminal (hangup) never ask.
 */
export function createQuitGuard(): QuitGuard {
  let state: "idle" | "asking" | "waiting" = "idle";
  let askingFinish = false;
  const asked = new Set<string>();
  return {
    get state() {
      return state;
    },
    request({ running = false, interactive = true, hangup = false, finish = null } = {}) {
      if (!interactive || hangup) return "quit";
      if (running) {
        if (state === "idle") {
          state = "asking";
          askingFinish = false;
          return "ask";
        }
        return "quit";
      }
      if (finish && state !== "asking" && !asked.has(finish)) {
        asked.add(finish);
        state = "asking";
        askingFinish = true;
        return "finish";
      }
      return "quit";
    },
    answer(wait) {
      if (state !== "asking") return wait ? "wait" : "quit";
      if (askingFinish) {
        // Asked once for this state: the next request quits, and a new turn asks as usual.
        askingFinish = false;
        state = "idle";
        return wait ? "wait" : "quit";
      }
      if (wait) {
        state = "waiting";
        return "wait";
      }
      return "quit";
    },
    askedAbout(finish) {
      return asked.has(finish);
    },
    turnEnded() {
      const was = state;
      state = "idle";
      askingFinish = false;
      return was === "waiting" || was === "asking";
    },
  };
}

// --- How the last turn ended (session_qc._completion) ------------------------------

/** An answer that asks the user something (session_qc.AWAITING_USER, on the last 400 characters). */
const AWAITING_USER = /(would you like|do you want|should i|shall i|let me know|which (one|option)|can you (confirm|clarify|provide)|please (confirm|clarify|provide))[^.]*\?\s*$/i;
const MENU_ITEM = /^[ \t]*(?:\*\*)?\(?\d{1,2}[.)]/;
const MENU_ITEM_MORE = /^(?:[ \t]+\S|[ \t]*[-*+] )/;
const MENU_CHOICE = /\b(options?|pick|choose|which one|which of|prefer|should i)\b/i;
/** Finish reasons of a turn that did not finish (session_qc.BAD_FINISH). */
export const BAD_FINISH: ReadonlySet<string> = new Set(["length", "error", "tool-calls", "content-filter", "abort", "aborted"]);

/**
 * Whether an answer ends on a numbered list for the user to choose from
 * (session_qc._ends_on_menu): the list is the answer's last block, and the
 * line that leads into it is a question or asks the user to choose, or its
 * last line asks which option. A summary of what was done is not a menu.
 */
export function endsOnMenu(text: string): boolean {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim());
  let index = lines.length - 1;
  let items = 0;
  while (index >= 0 && (MENU_ITEM.test(lines[index]!) || MENU_ITEM_MORE.test(lines[index]!))) {
    if (MENU_ITEM.test(lines[index]!)) items += 1;
    index -= 1;
  }
  if (items < 2) return false;
  const lead = index >= 0 ? lines[index]!.trim() : "";
  const last = lines.at(-1)!.trim();
  return lead.endsWith("?")
    || (lead.endsWith(":") && MENU_CHOICE.test(lead))
    || (last.endsWith("?") && MENU_CHOICE.test(last));
}

/** Whether a final answer waits on the user: a question (AWAITING_USER) or a menu. */
export function awaitsUser(text: string): boolean {
  const tail = text.trim().slice(-600);
  return AWAITING_USER.test(tail.slice(-400)) || endsOnMenu(tail);
}

export type LastTurn = "pass" | "cut" | "awaiting";
/**
 * How the last turn ended. "stopped" (the Stop button, or the app closed
 * mid-turn) and "gateway" (an omnirush.ai gateway error) are excused: the
 * checklist still reads "last turn cut off", but the finish guard stays out
 * of it. "none": no answer in the last turn yet.
 */
export type LastTurnEnd = LastTurn | "stopped" | "gateway" | "none";

/** What the checklist's `finished` shows for an ending. */
export function lastTurnOf(ended: LastTurnEnd): LastTurn {
  return ended === "pass" || ended === "awaiting" ? ended : "cut";
}

// --- The desktop's transcript -------------------------------------------------

function sessionErrorOf(message: UIMessage): Record<string, unknown> | null {
  for (const part of message.parts) {
    const metadata = record((part as { providerMetadata?: unknown }).providerMetadata);
    const opencode = record(metadata.opencode);
    if (opencode.sessionError !== undefined) return record(opencode.sessionError);
  }
  return null;
}

/**
 * The gateway refusing on purpose: out of tokens for the day, the Windows
 * cut-off, the session cap, an app update required. Its messages start with
 * "omnirush.ai: " (and usually end on a console link); retrying cannot help.
 */
const REFUSAL = /(^|Message: )omnirush\.ai:|daily_grant_exhausted|windows_cutoff|session_quality_cap|update_required|client update required/im;

/**
 * How a turn that ended on an error ended. The engine's MessageAbortedError
 * is the Stop button; an APIError is the gateway (session_qc._interruption).
 * `retryable`: a gateway or stream error worth one automatic "continue"
 * (never a stop or a refusal).
 */
function errorEnding(error: Record<string, unknown>): { ended: LastTurnEnd; retryable: boolean } {
  if (error.kind === "aborted") return { ended: "stopped", retryable: false };
  const refusal = REFUSAL.test(`${str(error.title)}\n${str(error.technicalDetails)}`) || Boolean(str(record(error.action).link));
  if (/^Error type: APIError$/m.test(str(error.technicalDetails))) return { ended: "gateway", retryable: !refusal };
  return { ended: "cut", retryable: !refusal && (error.kind === "provider-timeout" || error.kind === "provider-incomplete") };
}

function messageCalls(message: UIMessage): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const part of message.parts) {
    const value = part as unknown as Record<string, unknown>;
    let tool = "";
    if (part.type === "dynamic-tool") tool = str(value.toolName);
    else if (part.type.startsWith("tool-")) tool = part.type.slice(5);
    else continue;
    calls.push(toolCall({
      tool,
      input: value.input,
      failed: value.state === "output-error",
      errorText: value.errorText,
      unfinished: value.state === "input-streaming" || value.state === "input-available",
    }));
  }
  return calls;
}

function messageOpencode(message: UIMessage): Record<string, unknown> {
  return record(record(message.metadata).opencode);
}

/** How the last turn (the messages after the last prompt) ended (session_qc._completion). */
type TurnEnding = { ended: LastTurnEnd; endedAt: number | null; retryable: boolean };

function lastTurnEnd(messages: readonly UIMessage[]): TurnEnding {
  let start = messages.length;
  while (start > 0 && messages[start - 1]!.role !== "user") start -= 1;
  const turn = messages.slice(start).filter((message) => message.role === "assistant");
  const last = turn.at(-1);
  if (!last) return { ended: "none", endedAt: null, retryable: false };
  const completed = messageOpencode(last).completed;
  const endedAt = typeof completed === "number" ? completed : null;
  const error = sessionErrorOf(last);
  if (error) return { ...errorEnding(error), endedAt };
  let finalText = "";
  let afterLastTool = true;
  let unfinished = false;
  let finish = "";
  for (const message of turn) {
    const reason = messageOpencode(message).finish;
    if (typeof reason === "string" && reason) finish = reason;
    for (const part of message.parts) {
      const value = part as unknown as Record<string, unknown>;
      if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
        afterLastTool = false;
        finalText = "";
        if (value.state === "input-streaming" || value.state === "input-available") unfinished = true;
      } else if (part.type === "text" && str(value.text).trim()) {
        afterLastTool = true;
        finalText = str(value.text);
      }
    }
  }
  const reason = finish.toLowerCase();
  if (unfinished || BAD_FINISH.has(reason) || !finalText.trim() || !afterLastTool) {
    // A tool chain cut mid-call, or a stream that ended on an error or between tool calls.
    return { ended: "cut", endedAt, retryable: unfinished || reason === "tool-calls" || reason === "error" };
  }
  return { ended: awaitsUser(finalText) ? "awaiting" : "pass", endedAt, retryable: false };
}

/**
 * The desktop transcript as the checklist reads it: { calls, lastTurn } (the
 * CLI's sessionFacts), plus how the last turn ended (`ended`), when
 * (`endedAt`, ms; null when unknown) and whether one automatic "continue"
 * could help (`retryable`), for the finish guard and the auto-retry.
 */
export function messageFacts(messages: readonly UIMessage[]): { calls: ToolCall[]; lastTurn: LastTurn } & TurnEnding {
  const calls: ToolCall[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    calls.push(...messageCalls(message));
  }
  const ending = lastTurnEnd(messages);
  return { calls, lastTurn: lastTurnOf(ending.ended), ...ending };
}

// --- The server's checklist (GET /me/sessions/{id}/status) ---------------------------

export type GoodSessionTone = "amber" | "red";

/** The checklist the bar shows, with the server's own words when it answered. */
export type ShownChecklist = GoodSessionChecklist & {
  source: "server" | "local";
  /** The server's headline, or null. */
  message: string | null;
  messageTone: GoodSessionTone | null;
  /** The server's reasons, in order. */
  reasons: string[];
  /** The escalation line (warn → surcharge → cap), or null. */
  dock: { tone: GoodSessionTone; message: string; link: string | null } | null;
};

function localShown(local: GoodSessionChecklist): ShownChecklist {
  return { ...local, source: "local", message: null, messageTone: null, reasons: [], dock: null };
}

/** Whether the server block is missing or says nothing yet: the local checklist shows then, exactly as without it. */
export function serverStatusUsable(status: OmniRushSessionStatus | null | undefined): status is OmniRushSessionStatus {
  if (!status) return false;
  return !(status.status === "unknown" && status.checklist.length === 0);
}

/**
 * The bar's checklist: the server's `checklist[]`, `message`, `reasons` and
 * `dock` when it answered for this session; otherwise the local checklist,
 * unchanged. An answer with no checklist items keeps the local items under
 * the server's message. The filled ★ comes from the server's `usable`
 * verdict (or, without a server block, from /me/quality's client grade).
 */
export function shownChecklist({ local, server, sessionId, serverGood = false }: {
  local: GoodSessionChecklist;
  server: OmniRushSessionStatus | null | undefined;
  sessionId: string;
  serverGood?: boolean;
}): ShownChecklist {
  if (!serverStatusUsable(server) || server.sessionId !== sessionId) {
    if (!serverGood || !local.onTrack) return localShown(local);
    return localShown({ ...local, verdict: "good", text: checklistText(local.checks, "good") });
  }
  const checks: GoodSessionCheck[] = server.checklist.length
    ? server.checklist.map((item) => ({ id: item.id, state: item.state, label: goodSessionWording(item.label), hint: goodSessionWording(item.hint) }))
    : local.checks;
  const onTrack = checks.every((check) => check.state === "pass");
  const verdict: GoodSessionVerdict = server.verdict?.state === "usable" ? "good" : onTrack ? "on-track" : "incomplete";
  const dock = server.dock;
  const dockTone: GoodSessionTone = dock && (dock.stage === "surcharge" || dock.stage === "cap" || dock.capped || server.status === "failing") ? "red" : "amber";
  return {
    checks,
    verdict,
    onTrack,
    missing: checks.filter((check) => check.state === "fail"),
    text: checklistText(checks, verdict),
    work: local.work,
    source: "server",
    message: server.message ? goodSessionWording(server.message) : null,
    messageTone: server.status === "failing" ? "red" : server.status === "at_risk" ? "amber" : null,
    reasons: server.reasons.map((reason) => reason.message),
    dock: dock?.message && (dock.stage !== "none" || dock.capped)
      ? { tone: dockTone, message: dock.message, link: dock.link }
      : null,
  };
}

/** Milliseconds to the next status read: the server's `poll_seconds`, at least 30 s; 60 s when it named none. */
export function sessionStatusPollMs(status: Pick<OmniRushSessionStatus, "pollSeconds"> | null | undefined): number {
  const seconds = status?.pollSeconds;
  return Math.max(30, typeof seconds === "number" && seconds > 0 ? seconds : 60) * 1000;
}

/**
 * Whether quitting should ask the finish guard, and with which words. Arms
 * when no turn runs and the last turn was cut off or waits on the user; an
 * excused ending (stopped, gateway error) never arms. The server arms it
 * too when its `finished` item is the one step left (fail or pending, every
 * other item passing or warning) and it judged after the last turn ended.
 */
export function finishGuardKind({ turnRunning, ended, endedAt = null, server = null }: {
  turnRunning: boolean;
  ended: LastTurnEnd;
  endedAt?: number | null;
  server?: OmniRushSessionStatus | null;
}): FinishGuardKind | null {
  if (turnRunning || ended === "stopped" || ended === "gateway" || ended === "none") return null;
  // The server's kill switch (`client.finish_guard: false`).
  if (serverStatusUsable(server) && server.client?.finishGuard === false) return null;
  if (ended === "awaiting" || ended === "cut") return ended;
  if (!serverStatusUsable(server)) return null;
  const finished = server.checklist.find((item) => item.id === "finished");
  if (!finished || (finished.state !== "fail" && finished.state !== "pending")) return null;
  if (!server.checklist.every((item) => item === finished || item.state === "pass" || item.state === "warn")) return null;
  // The local transcript says it finished: only a verdict newer than that turn overrides it.
  const judgedAt = server.evaluatedAt ? Date.parse(server.evaluatedAt) : Number.NaN;
  if (endedAt === null || !Number.isFinite(judgedAt) || judgedAt < endedAt) return null;
  return /\b(question|answer|reply|waiting)\b/i.test(`${finished.label} ${finished.hint}`) ? "awaiting" : "cut";
}

/**
 * The message to send on its own after a turn ended on a gateway, stream or
 * tool-chain error, or null. Only when the server turned it on for this
 * session (`client.auto_retry`; never offline), at most `max` times in a
 * row, never after the user pressed Stop and never on a refusal.
 */
export function autoRetryMessage({ turnRunning, ended, retryable, userStopped, retriesInARow, server }: {
  turnRunning: boolean;
  ended: LastTurnEnd;
  retryable: boolean;
  userStopped: boolean;
  retriesInARow: number;
  server: OmniRushSessionStatus | null | undefined;
}): string | null {
  const retry = server?.client?.autoRetry;
  if (!retry?.enabled || !retry.message || retriesInARow >= retry.max) return null;
  if (turnRunning || userStopped || !retryable || (ended !== "cut" && ended !== "gateway")) return null;
  return retry.message;
}

/** The `depth` item's hint for the one-time "one more turn" nudge, or null (off: `client.one_more_turn: false`). */
export function oneMoreTurnHint(server: OmniRushSessionStatus | null | undefined): string | null {
  if (!serverStatusUsable(server) || server.client?.oneMoreTurn === false) return null;
  const depth = server.checklist.find((item) => item.id === "depth");
  if (!depth || (depth.state !== "warn" && depth.state !== "fail") || !depth.hint) return null;
  return goodSessionWording(depth.hint);
}

/** The key the guard asks once for: one session, one state. */
export function finishGuardKey(sessionId: string, kind: FinishGuardKind): string {
  return `${sessionId}:${kind}`;
}

/** Whether ending or deleting a session is about a session whose turn runs. */
export function leavingRunningTurn(input: { action: "close" | "quit" | "switch" | "delete"; turnRunning: boolean; targetSessionId?: string | null; currentSessionId?: string | null }): boolean {
  if (!input.turnRunning) return false;
  // Viewing another session does not end this one. Only explicit termination
  // actions should warn about cutting off its last turn.
  if (input.action === "switch") return false;
  return true;
}

// --- Native Windows ------------------------------------------------------------

export const WSL_BANNER_DISMISSED_KEY = "omnirush.goodSession.wslBannerDismissedDay.v1";

/** The local day ("2026-10-06"): a dismissed banner comes back the next day. */
export function localDay(now: Date | number = Date.now()): string {
  const at = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * Native Windows the server does not count (`windowsCounts`: its
 * `windows_counts`, absent or false on older servers): the checklist's
 * `windows` check and the WSL banner show only then.
 */
export function windowsNotCounted(input: { nativeWindows: boolean; windowsCounts?: boolean }): boolean {
  return input.nativeWindows && input.windowsCounts !== true;
}

export function showWslBanner(input: { nativeWindows: boolean; windowsCounts?: boolean; dismissedDay: string | null; now?: Date }): boolean {
  return windowsNotCounted(input) && input.dismissedDay !== localDay(input.now);
}
