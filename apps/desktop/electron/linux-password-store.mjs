import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Upper bound on the startup D-Bus probe; it runs before `ready`. */
export const PASSWORD_STORE_PROBE_TIMEOUT_MS = 300;

const SECRET_SERVICE_NAME = "org.freedesktop.secrets";
const KWALLET6_NAME = "org.kde.kwalletd6";
const KWALLET5_NAME = "org.kde.kwalletd5";

// Desktops Chromium recognizes (base::nix::GetDesktopEnvironment), matched
// loosely so that any desktop Chromium might recognize keeps its own choice:
// those get gnome-libsecret or KWallet without help, and overriding them
// could strand secrets an existing install sealed with another backend.
const KNOWN_XDG_DESKTOPS = ["unity", "deepin", "gnome", "x-cinnamon", "cinnamon", "kde", "plasma", "pantheon", "xfce", "ukui", "lxqt", "mate"];
const KNOWN_DESKTOP_SESSIONS = ["deepin", "gnome", "mate", "kde", "plasma", "xfce", "xubuntu", "ukui", "cinnamon", "pantheon", "lxqt", "unity"];

/**
 * Whether Chromium picks the insecure basic_text store on its own: it does
 * so when it cannot name the desktop environment (Hyprland, sway, i3 and
 * other window managers), even when a keyring runs on the session bus.
 * @param {NodeJS.ProcessEnv} env
 */
export function chromiumPicksBasicText(env) {
  const current = (env.XDG_CURRENT_DESKTOP ?? "").split(":").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (current.some((value) => KNOWN_XDG_DESKTOPS.some((known) => value.includes(known)))) return false;
  const session = (env.DESKTOP_SESSION ?? "").trim().toLowerCase();
  if (session && KNOWN_DESKTOP_SESSIONS.some((known) => session.includes(known))) return false;
  return !env.GNOME_DESKTOP_SESSION_ID && !env.KDE_FULL_SESSION;
}

/**
 * Names on the session bus, or null when the bus or both probe tools are
 * unavailable. Never autolaunches a bus: without DBUS_SESSION_BUS_ADDRESS
 * only the systemd user bus socket is tried.
 * @param {{ env: NodeJS.ProcessEnv, timeoutMs: number, runCommand?: (file: string, args: string[], options: object) => Promise<{ stdout: string | Buffer }> }} options
 * @returns {Promise<Set<string> | null>}
 */
export async function listSessionBusNames({ env, timeoutMs, runCommand = execFileAsync }) {
  const runtimeBus = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "bus") : null;
  const address = env.DBUS_SESSION_BUS_ADDRESS?.trim()
    || (runtimeBus && existsSync(runtimeBus) ? `unix:path=${runtimeBus}` : "");
  if (!address) return null;
  const deadline = Date.now() + timeoutMs;
  /** @type {Array<[string, string[]]>} */
  const probes = [
    ["dbus-send", ["--session", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.ListNames"]],
    ["busctl", ["--user", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ListNames"]],
  ];
  for (const [file, args] of probes) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const { stdout } = await runCommand(file, args, {
        env: { ...env, DBUS_SESSION_BUS_ADDRESS: address },
        timeout: remaining,
        killSignal: "SIGKILL",
        maxBuffer: 256 * 1024,
      });
      return new Set(String(stdout).split(/[\s"]+/).filter(Boolean));
    } catch {
      // Tool missing, bus unreachable or too slow: try the next one.
    }
  }
  return null;
}

/**
 * The --password-store value to start Chromium with on Linux, or null to
 * leave Chromium's own choice. Only overrides the case where Chromium would
 * fall back to basic_text while a Secret Service provider (gnome-keyring,
 * KeePassXC, ...) or KWallet is reachable on the session bus.
 * @param {{
 *   platform?: NodeJS.Platform,
 *   env?: NodeJS.ProcessEnv,
 *   userChoseStore: boolean,
 *   listBusNames?: (options: { env: NodeJS.ProcessEnv, timeoutMs: number }) => Promise<Set<string> | null>,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ store: "gnome-libsecret" | "kwallet6" | "kwallet5" | null, reason: string }>}
 */
export async function selectLinuxPasswordStore({
  platform = process.platform,
  env = process.env,
  userChoseStore,
  listBusNames = listSessionBusNames,
  timeoutMs = PASSWORD_STORE_PROBE_TIMEOUT_MS,
}) {
  if (platform !== "linux") return { store: null, reason: "not Linux" };
  if (userChoseStore) return { store: null, reason: "--password-store given" };
  if (!chromiumPicksBasicText(env)) return { store: null, reason: "Chromium default for this desktop" };
  const names = await listBusNames({ env, timeoutMs }).catch(() => null);
  if (names?.has(SECRET_SERVICE_NAME)) return { store: "gnome-libsecret", reason: `${SECRET_SERVICE_NAME} on the session bus` };
  if (names?.has(KWALLET6_NAME)) return { store: "kwallet6", reason: `${KWALLET6_NAME} on the session bus` };
  if (names?.has(KWALLET5_NAME)) return { store: "kwallet5", reason: `${KWALLET5_NAME} on the session bus` };
  return { store: null, reason: names ? "no keyring on the session bus" : "session bus not reachable" };
}

/**
 * Start Chromium with a real keyring when one is reachable. Must run before
 * `ready` and before anything touches safeStorage. Logs the outcome once.
 * @param {{
 *   app: { commandLine: Pick<import("electron").CommandLine, "hasSwitch" | "appendSwitch"> },
 *   platform?: NodeJS.Platform,
 *   env?: NodeJS.ProcessEnv,
 *   argv?: string[],
 *   listBusNames?: (options: { env: NodeJS.ProcessEnv, timeoutMs: number }) => Promise<Set<string> | null>,
 *   log?: (message: string) => void,
 * }} options
 */
export async function applyLinuxPasswordStore({
  app,
  platform = process.platform,
  env = process.env,
  argv = process.argv,
  listBusNames,
  log = (message) => console.log(message),
}) {
  if (platform !== "linux") return null;
  const userChoseStore = app.commandLine.hasSwitch("password-store")
    || argv.some((arg) => arg === "--password-store" || arg.startsWith("--password-store="));
  const { store, reason } = await selectLinuxPasswordStore({ platform, env, userChoseStore, listBusNames });
  if (store) app.commandLine.appendSwitch("password-store", store);
  log(`[omnirush] Linux password store: ${store ?? "unchanged"} (${reason})`);
  return store;
}
