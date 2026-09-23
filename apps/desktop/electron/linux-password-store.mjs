import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Upper bound on the startup D-Bus probe; it runs before `ready`. */
export const PASSWORD_STORE_PROBE_TIMEOUT_MS = 300;

/** Where the store that sealed each keyring-encrypted file is recorded, in userData. */
export const PASSWORD_STORE_RECORD_FILE = "linux-password-store.json";
/** Keyring-sealed files in userData whose store is kept sticky, most important first. */
export const KEYRING_SEALED_FILES = ["omnirush-account.bin", "local-managed-mcp-vault-key.bin"];

const SECRET_SERVICE_NAME = "org.freedesktop.secrets";
const KWALLET6_NAME = "org.kde.kwalletd6";
const KWALLET5_NAME = "org.kde.kwalletd5";
const KEYRING_NAMES = /** @type {const} */ ([
  [SECRET_SERVICE_NAME, "gnome-libsecret"],
  [KWALLET6_NAME, "kwallet6"],
  [KWALLET5_NAME, "kwallet5"],
]);
/** safeStorage.getSelectedStorageBackend() values and the --password-store value that selects each. */
const BACKEND_TO_SWITCH = { gnome_libsecret: "gnome-libsecret", kwallet: "kwallet", kwallet5: "kwallet5", kwallet6: "kwallet6" };
const STICKY_STORES = new Set(Object.values(BACKEND_TO_SWITCH));

// Mirrors Chromium's base::nix::GetDesktopEnvironment plus the backend it
// maps each desktop to (os_crypt SelectBackend): these desktops get
// gnome-libsecret or KWallet without help. XDG_CURRENT_DESKTOP entries are
// compared exactly, as Chromium does; LXQt and a MATE named only there map
// to basic_text in Chromium, so they are left out. Anything KDE-like stays
// matched loosely: overriding a KWallet desktop could strand its secrets.
const KNOWN_XDG_DESKTOPS = new Set(["unity", "deepin", "gnome", "x-cinnamon", "pantheon", "xfce", "ukui"]);
const KNOWN_DESKTOP_SESSIONS = new Set(["deepin", "gnome", "mate", "ukui", "xubuntu"]);
const KDE_LIKE = /kde|plasma/;

/**
 * Whether Chromium picks the insecure basic_text store on its own: it does
 * so when it cannot name the desktop environment (Hyprland, sway, i3 and
 * other window managers), even when a keyring runs on the session bus.
 * @param {NodeJS.ProcessEnv} env
 */
export function chromiumPicksBasicText(env) {
  const current = (env.XDG_CURRENT_DESKTOP ?? "").split(":").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (current.some((value) => KNOWN_XDG_DESKTOPS.has(value) || KDE_LIKE.test(value))) return false;
  const session = (env.DESKTOP_SESSION ?? "").trim().toLowerCase();
  if (session && (KNOWN_DESKTOP_SESSIONS.has(session) || session.includes("xfce") || KDE_LIKE.test(session))) return false;
  return !env.GNOME_DESKTOP_SESSION_ID && !env.KDE_FULL_SESSION;
}

/** @param {string | Buffer} stdout */
function parseNames(stdout) {
  return new Set(String(stdout).split(/[\s"]+/).filter(Boolean));
}

/**
 * Names on the session bus: those running now and those D-Bus starts on
 * demand (gnome-keyring on Arch is usually activatable, not yet running, at
 * login on a window manager; libsecret inside Chromium starts it). Null when
 * the bus or both probe tools are unavailable. Never autolaunches a bus:
 * without DBUS_SESSION_BUS_ADDRESS only the systemd user bus socket is tried.
 * @param {{ env: NodeJS.ProcessEnv, timeoutMs: number, runCommand?: (file: string, args: string[], options: object) => Promise<{ stdout: string | Buffer }> }} options
 * @returns {Promise<{ running: Set<string>, activatable: Set<string> } | null>}
 */
export async function listSessionBusNames({ env, timeoutMs, runCommand = execFileAsync }) {
  const runtimeBus = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "bus") : null;
  const address = env.DBUS_SESSION_BUS_ADDRESS?.trim()
    || (runtimeBus && existsSync(runtimeBus) ? `unix:path=${runtimeBus}` : "");
  if (!address) return null;
  const deadline = Date.now() + timeoutMs;
  /** @type {Array<[string, (method: string) => string[]]>} */
  const probes = [
    ["dbus-send", (method) => ["--session", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", `org.freedesktop.DBus.${method}`]],
    ["busctl", (method) => ["--user", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", method]],
  ];
  for (const [file, argsFor] of probes) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const options = {
      env: { ...env, DBUS_SESSION_BUS_ADDRESS: address },
      timeout: remaining,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
    };
    // Both calls share the remaining budget and run side by side.
    const [running, activatable] = await Promise.allSettled([
      runCommand(file, argsFor("ListNames"), options),
      runCommand(file, argsFor("ListActivatableNames"), options),
    ]);
    if (running.status !== "fulfilled" && activatable.status !== "fulfilled") continue; // Tool missing, bus unreachable or too slow.
    return {
      running: running.status === "fulfilled" ? parseNames(running.value.stdout) : new Set(),
      activatable: activatable.status === "fulfilled" ? parseNames(activatable.value.stdout) : new Set(),
    };
  }
  return null;
}

/**
 * The --password-store value recorded for a keyring-sealed file that still
 * exists in userData, or null. Keeps later launches on the store that sealed
 * the sign-in even when the probe misses the keyring.
 * @param {string | null | undefined} userDataPath
 * @param {{ exists?: (filePath: string) => boolean, readText?: (filePath: string) => string }} [io]
 * @returns {{ store: string, file: string } | null}
 */
export function recordedLinuxPasswordStore(userDataPath, { exists = existsSync, readText = (filePath) => readFileSync(filePath, "utf8") } = {}) {
  if (!userDataPath) return null;
  let record;
  try {
    record = JSON.parse(readText(path.join(userDataPath, PASSWORD_STORE_RECORD_FILE)))?.stores;
  } catch {
    return null;
  }
  if (!record || typeof record !== "object") return null;
  for (const file of KEYRING_SEALED_FILES) {
    const store = record[file];
    if (typeof store === "string" && STICKY_STORES.has(store) && exists(path.join(userDataPath, file))) return { store, file };
  }
  return null;
}

/**
 * Record which store sealed `fileName` (safeStorage.getSelectedStorageBackend()).
 * Linux only; basic_text and unknown backends are not recorded.
 * @param {{ userDataPath: string, fileName: string, backend: string }} options
 * @returns {Promise<boolean>} whether the record changed
 */
export async function recordLinuxPasswordStore({ userDataPath, fileName, backend }) {
  const store = BACKEND_TO_SWITCH[/** @type {keyof typeof BACKEND_TO_SWITCH} */ (backend)];
  if (!store) return false;
  const recordPath = path.join(userDataPath, PASSWORD_STORE_RECORD_FILE);
  /** @type {Record<string, string>} */
  let stores = {};
  try {
    const parsed = JSON.parse(await readFile(recordPath, "utf8"))?.stores;
    if (parsed && typeof parsed === "object") stores = parsed;
  } catch {
    // Missing or unreadable: start a new record.
  }
  if (stores[fileName] === store) return false;
  stores = { ...stores, [fileName]: store };
  await mkdir(userDataPath, { recursive: true });
  const temporary = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ stores }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, recordPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return true;
}

/**
 * The --password-store value to start Chromium with on Linux, or null to
 * leave Chromium's own choice. A store recorded for a sealed file that still
 * exists wins; otherwise only overrides the case where Chromium would fall
 * back to basic_text while a Secret Service provider (gnome-keyring,
 * KeePassXC, ...) or KWallet is running or D-Bus activatable.
 * @param {{
 *   platform?: NodeJS.Platform,
 *   env?: NodeJS.ProcessEnv,
 *   userChoseStore: boolean,
 *   recorded?: { store: string, file: string } | null,
 *   listBusNames?: (options: { env: NodeJS.ProcessEnv, timeoutMs: number }) => Promise<{ running: Set<string>, activatable: Set<string> } | null>,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ store: string | null, reason: string }>}
 */
export async function selectLinuxPasswordStore({
  platform = process.platform,
  env = process.env,
  userChoseStore,
  recorded = null,
  listBusNames = listSessionBusNames,
  timeoutMs = PASSWORD_STORE_PROBE_TIMEOUT_MS,
}) {
  if (platform !== "linux") return { store: null, reason: "not Linux" };
  if (userChoseStore) return { store: null, reason: "--password-store given" };
  if (recorded) return { store: recorded.store, reason: `${recorded.file} is sealed with it` };
  if (!chromiumPicksBasicText(env)) return { store: null, reason: "Chromium default for this desktop" };
  const names = await listBusNames({ env, timeoutMs }).catch(() => null);
  if (!names) return { store: null, reason: "session bus not reachable" };
  // A running keyring first, then one D-Bus starts on demand.
  for (const [set, state] of /** @type {const} */ ([[names.running, "running"], [names.activatable, "activatable"]])) {
    for (const [name, store] of KEYRING_NAMES) {
      if (set?.has(name)) return { store, reason: `${name} ${state} on the session bus` };
    }
  }
  return { store: null, reason: "no keyring on the session bus" };
}

/**
 * Start Chromium with a real keyring when one is reachable. Must run before
 * `ready` and before anything touches safeStorage. Logs the outcome once.
 * @param {{
 *   app: { commandLine: Pick<import("electron").CommandLine, "hasSwitch" | "appendSwitch"> },
 *   platform?: NodeJS.Platform,
 *   env?: NodeJS.ProcessEnv,
 *   argv?: string[],
 *   userDataPath?: string | null,
 *   readRecorded?: (userDataPath: string | null | undefined) => { store: string, file: string } | null,
 *   listBusNames?: (options: { env: NodeJS.ProcessEnv, timeoutMs: number }) => Promise<{ running: Set<string>, activatable: Set<string> } | null>,
 *   log?: (message: string) => void,
 * }} options
 */
export async function applyLinuxPasswordStore({
  app,
  platform = process.platform,
  env = process.env,
  argv = process.argv,
  userDataPath = null,
  readRecorded = recordedLinuxPasswordStore,
  listBusNames,
  log = (message) => console.log(message),
}) {
  if (platform !== "linux") return null;
  const userChoseStore = app.commandLine.hasSwitch("password-store")
    || argv.some((arg) => arg === "--password-store" || arg.startsWith("--password-store="));
  const recorded = userChoseStore ? null : readRecorded(userDataPath);
  const { store, reason } = await selectLinuxPasswordStore({ platform, env, userChoseStore, recorded, listBusNames });
  if (store) app.commandLine.appendSwitch("password-store", store);
  log(`[omnirush] Linux password store: ${store ?? "unchanged"} (${reason})`);
  return store;
}
