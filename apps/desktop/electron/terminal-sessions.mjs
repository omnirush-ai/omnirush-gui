// Shells behind the app's terminal tabs. Every tab is one shell (node-pty)
// owned by the window that opened it and tagged with its workspace, so a
// closed tab, a removed workspace, a reloaded or closed window and the app's
// quit each end exactly their shells, together with whatever the shells
// started: nothing a terminal ran outlives the app.
//
// Ending a shell: on macOS and Linux the shell gets SIGHUP (an interactive
// shell passes it on to its jobs, as when a terminal window closes); the
// processes below it that are still alive after a grace period get SIGTERM,
// then SIGKILL. The process tree is read before the shell ends, since its
// children are re-parented once it exits. On Windows the whole tree is ended
// with `taskkill /T /F` before the ConPTY is closed.
import { execFile } from "node:child_process";
import path from "node:path";

const MIN_COLS = 20;
const MIN_ROWS = 5;
const DEFAULT_GRACE_MS = 1500;

function clampSize(value, min, fallback) {
  return Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback;
}

/**
 * The shells a new tab can start, default first. Windows: PowerShell (7 when
 * installed, then Windows PowerShell) and Command Prompt. macOS and Linux:
 * the user's login shell ($SHELL), then the other common shells installed.
 * macOS starts login shells (-l), as Terminal.app does, so PATH from the
 * user's profile is there for an app launched from the Dock.
 */
export function terminalShells({ platform = process.platform, env = process.env, exists }) {
  if (platform === "win32") {
    const shells = [];
    const pathDirs = String(env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
    const pwsh = pathDirs.map((dir) => path.win32.join(dir, "pwsh.exe")).find((candidate) => exists(candidate));
    if (pwsh) shells.push({ id: "pwsh", label: "PowerShell 7", path: pwsh, args: ["-NoLogo"] });
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
    const windowsPowerShell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    shells.push({ id: "powershell", label: "Windows PowerShell", path: exists(windowsPowerShell) ? windowsPowerShell : "powershell.exe", args: ["-NoLogo"] });
    shells.push({ id: "cmd", label: "Command Prompt", path: env.COMSPEC || env.ComSpec || "cmd.exe", args: [] });
    return shells;
  }
  const loginArgs = (shellPath) => (platform === "darwin" && /(?:^|\/)(?:zsh|bash|fish)$/.test(shellPath) ? ["-l"] : []);
  const preferred = env.SHELL && exists(env.SHELL) ? env.SHELL : platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  const candidates = [preferred, "/bin/zsh", "/bin/bash", "/usr/bin/fish", "/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/bin/sh"];
  const seen = new Set();
  const shells = [];
  for (const candidate of candidates) {
    if (seen.has(candidate) || (candidate !== preferred && !exists(candidate))) continue;
    seen.add(candidate);
    shells.push({ id: path.posix.basename(candidate), label: path.posix.basename(candidate), path: candidate, args: loginArgs(candidate) });
  }
  return shells.filter((shell, index) => shells.findIndex((other) => other.id === shell.id) === index);
}

/** Every process below `rootPid` (children, grandchildren, ...) from a `ps -A -o pid=,ppid=` listing. */
export function descendantsOf(rootPid, listing) {
  const children = new Map();
  for (const line of String(listing).split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out = [];
  const queue = [rootPid];
  while (queue.length) {
    const next = queue.shift();
    for (const child of children.get(next) ?? []) {
      if (child === rootPid || out.includes(child)) continue;
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

function defaultRun(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? "" : String(stdout));
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

/**
 * @param {object} options
 * @param {(file: string, args: string[], options: object) => any} options.spawn node-pty's spawn
 * @param {(cwd: unknown) => Promise<string>} options.resolveCwd
 * @param {() => Array<{ id: string, label: string, path: string, args: string[] }>} options.shells
 * @param {string} [options.platform]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(command: string, args: string[]) => Promise<string>} [options.run]
 * @param {(pid: number) => boolean} [options.isAlive]
 * @param {(pid: number, name: string) => void} [options.sendSignal]
 * @param {number} [options.graceMs]
 * @param {(ms: number) => Promise<unknown>} [options.sleep]
 */
export function createTerminalSessions({
  spawn,
  resolveCwd,
  shells,
  platform = process.platform,
  env = process.env,
  run = defaultRun,
  isAlive = alive,
  sendSignal = signal,
  graceMs = DEFAULT_GRACE_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  /** terminalId -> { process, ownerId, workspaceId, send, ended } */
  const sessions = new Map();
  /** Shells being ended (their grace periods still running): the app's quit waits for them. */
  const ending = new Set();
  let nextId = 1;

  /** Ends one shell and its process tree; resolves once they are gone (or given up on). */
  async function endTree(child) {
    const pid = child.pid;
    if (platform === "win32") {
      if (Number.isInteger(pid)) await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
      try { child.kill(); } catch { /* already gone */ }
      return;
    }
    const tree = Number.isInteger(pid) ? descendantsOf(pid, await run("ps", ["-A", "-o", "pid=,ppid="])) : [];
    try { child.kill("SIGHUP"); } catch { /* already gone */ }
    const remaining = () => [pid, ...tree].filter((each) => Number.isInteger(each) && isAlive(each));
    for (const next of ["SIGTERM", "SIGKILL"]) {
      for (let waited = 0; waited < graceMs && remaining().length; waited += 50) await sleep(50);
      const left = remaining();
      if (!left.length) return;
      for (const each of left) sendSignal(each, next);
    }
  }

  function end(terminalId) {
    const session = sessions.get(terminalId);
    if (!session) return Promise.resolve();
    sessions.delete(terminalId);
    session.ended = true;
    const done = endTree(session.process).catch(() => undefined).finally(() => ending.delete(done));
    ending.add(done);
    return done;
  }

  function owned(ownerId, terminalId) {
    const session = sessions.get(String(terminalId ?? ""));
    return session && session.ownerId === ownerId ? session : null;
  }

  return {
    shells,

    /**
     * @param {{ ownerId: number, workspaceId?: string | null, cwd?: unknown, cols?: number, rows?: number, shellId?: string | null, send: (channel: string, payload: object) => void }} input
     */
    async create({ ownerId, workspaceId = null, cwd, cols, rows, shellId = null, send }) {
      const available = shells();
      const shell = available.find((each) => each.id === shellId) ?? available[0];
      const directory = await resolveCwd(cwd);
      const terminalId = `term_${nextId++}`;
      const child = spawn(shell.path, shell.args, {
        name: "xterm-256color",
        cols: clampSize(cols, MIN_COLS, 80),
        rows: clampSize(rows, MIN_ROWS, 24),
        cwd: directory,
        env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor", OMNIRUSH_TERMINAL: "1" },
        ...(platform === "win32" ? { useConpty: true } : {}),
      });
      const session = { process: child, ownerId, workspaceId: workspaceId ? String(workspaceId) : null, send, ended: false };
      sessions.set(terminalId, session);
      child.onData((data) => {
        if (!session.ended) send("omnirush:terminal:data", { terminalId, data });
      });
      child.onExit(({ exitCode, signal: exitSignal }) => {
        const wasOpen = sessions.get(terminalId) === session;
        if (wasOpen) sessions.delete(terminalId);
        // A shell the user exited (or that crashed) tells its tab; one we ended does not.
        if (wasOpen && !session.ended) send("omnirush:terminal:exit", { terminalId, exitCode, signal: exitSignal });
        session.ended = true;
      });
      return { terminalId, shellId: shell.id, shellLabel: shell.label, cwd: directory };
    },

    write(ownerId, terminalId, data) {
      const session = owned(ownerId, terminalId);
      if (session && typeof data === "string") session.process.write(data);
    },

    resize(ownerId, terminalId, cols, rows) {
      const session = owned(ownerId, terminalId);
      if (!session || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
      try {
        session.process.resize(clampSize(cols, MIN_COLS, 80), clampSize(rows, MIN_ROWS, 24));
      } catch {
        // The shell exited between the check and the resize.
      }
    },

    kill(ownerId, terminalId) {
      return owned(ownerId, terminalId) ? end(String(terminalId)) : Promise.resolve();
    },

    /** Ends every shell of one workspace (the workspace is being removed). */
    killWorkspace(workspaceId, ownerId = null) {
      const id = String(workspaceId ?? "");
      const ids = [...sessions.entries()]
        .filter(([, session]) => session.workspaceId === id && (ownerId === null || session.ownerId === ownerId))
        .map(([terminalId]) => terminalId);
      return Promise.all(ids.map(end)).then(() => ids.length);
    },

    /** Ends every shell a window opened (it closed, crashed or reloaded). */
    killOwner(ownerId) {
      const ids = [...sessions.entries()].filter(([, session]) => session.ownerId === ownerId).map(([terminalId]) => terminalId);
      return Promise.all(ids.map(end)).then(() => ids.length);
    },

    /**
     * Ends every shell (the app is quitting), and waits for shells already
     * being ended (a window that just closed), so the app never exits
     * before a stubborn process got its SIGTERM/SIGKILL.
     */
    killAll() {
      for (const terminalId of [...sessions.keys()]) end(terminalId);
      return Promise.all([...ending]).then(() => undefined);
    },

    /** Live terminal ids of one window. */
    list(ownerId) {
      return [...sessions.entries()].filter(([, session]) => session.ownerId === ownerId).map(([terminalId]) => terminalId);
    },
  };
}
