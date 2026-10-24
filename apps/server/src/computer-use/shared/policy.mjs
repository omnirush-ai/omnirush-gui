// Computer use, policy: the server switch (capabilities `computer_use`), the
// person's real-screen opt-in (held by the server per account, set only from
// the web console) and the device's own real-screen setting, the apps the
// agent may never open, and (for the desktop's built-in browser only) which
// actions ask first.
//
// Computer use itself never asks (owner decision 2026-10-21): the agent's own
// display needs no approval at all, and the person's real screen is a
// setting the person turns on once (off by default), then runs with no
// per-session or per-action questions. The real screen needs BOTH the server
// (`real_screen` and `real_screen_opt_in` true for this account, from a read
// made just now) and this device's own setting: the server saying no, or not
// answering, always wins; the device's setting can only keep it off. What stays: the indicator and Stop,
// the deny list and hit-testing, stuck-input release, the server switch.
//
// The same file ships in omnirush-cli (src/computer-use/) and omnirush-gui
// (apps/server/src/computer-use/shared/); PARITY.sha256 lists it in both. No
// imports beyond node: built-ins and ./contract.mjs.

import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

import { normalizeLimits, osName, SERVER_ID } from "./contract.mjs";

export const PERMISSION_MODES = Object.freeze(["careful", "normal", "auto"]);
export const CLIENTS = Object.freeze(["cli", "desktop"]);
export const OFF_MESSAGE = "Computer use is turned off for this account.";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value, limit = 256, max = 200) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.trim() && v.length <= max).map((v) => v.trim()).slice(0, limit) : null;
}

function text(value, limit = 400) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
}

// ------------------------------------------------------------ server switch

/**
 * The `computer_use` block of a /collect/capabilities answer, normalized. A
 * missing or malformed block is off. The server already applied
 * `rollout_percent` (and the account) to `enabled`.
 * Shape: { enabled, clients, os, models, real_screen, real_screen_opt_in,
 * virtual_display, deny_apps, limits, message, ask_send_delete }
 * (null lists: no restriction). `real_screen` (and `real_screen_opt_in`, the
 * same value) is true only when the block says both `real_screen: true` and
 * `real_screen_opt_in: true` (the account opted in from the web console):
 * anything else, a missing key or an older server included, is off.
 */
export function normalizeComputerUse(block) {
  if (!isRecord(block)) return { enabled: false, clients: null, os: null, models: null, real_screen: false, real_screen_opt_in: false, virtual_display: false, deny_apps: [], limits: normalizeLimits(null), message: null, ask_send_delete: false };
  const denyApps = Array.isArray(block.deny_apps)
    ? block.deny_apps.flatMap((item) => {
      if (typeof item === "string" && item.trim()) return [{ match: item.trim().slice(0, 200), reason: null }];
      if (isRecord(item) && typeof item.match === "string" && item.match.trim()) return [{ match: item.match.trim().slice(0, 200), reason: text(item.reason, 300) }];
      return [];
    }).slice(0, 256)
    : [];
  return {
    enabled: block.enabled === true,
    clients: strings(block.clients, 8, 40),
    os: strings(block.os, 8, 40),
    models: strings(block.models, 64, 128),
    real_screen: serverRealScreen(block),
    real_screen_opt_in: serverRealScreen(block),
    virtual_display: block.virtual_display !== false,
    deny_apps: denyApps,
    limits: normalizeLimits(block.limits),
    message: text(block.message),
    // The desktop's built-in browser tool only (actApproval options.sendDelete): only an explicit true turns them on.
    ask_send_delete: block.ask_send_delete === true,
  };
}

const ON = ["1", "on", "true", "yes"];
const OFF = ["0", "off", "false", "no"];

/**
 * Whether computer use is on for this app. In this order: the environment
 * (OMNIRUSH_COMPUTER_USE=1/on or 0/off; tests and support), then the server's
 * block (`block`, as last seen), else off. `client` is "cli" or "desktop". `device`: the person's saved
 * on/off for this device (deviceComputerUse; off wins over the server).
 * Returns the normalized block plus { enabled, source, reason }.
 */
export function computerUseSetting({ env = process.env, block, client, platform = process.platform, device } = {}) {
  const server = normalizeComputerUse(block);
  const asked = String(env?.OMNIRUSH_COMPUTER_USE ?? "").trim().toLowerCase();
  if (OFF.includes(asked)) return { ...server, enabled: false, source: "env", reason: "env" };
  // The person turned it off on this device (/computer off, Settings): no tools, no tips.
  if (!deviceComputerUse(device)) return { ...server, enabled: false, source: "device", reason: "device" };
  // The environment turns computer use on (tests, support), never the person's real screen: that stays the server's.
  if (ON.includes(asked)) return { ...server, enabled: true, virtual_display: true, source: "env", reason: null };
  if (!isRecord(block)) return { ...server, enabled: false, source: "default", reason: "no_switch" };
  // Off: say why when the block shows it (this OS or this app not in the rollout), so people get a plain reason.
  if (!server.enabled) return { ...server, source: "server", reason: server.os && !server.os.includes(osName(platform)) ? "os" : server.clients && client && !server.clients.includes(client) ? "client" : "off", os_name: osName(platform) };
  if (server.clients && client && !server.clients.includes(client)) return { ...server, enabled: false, source: "server", reason: "client" };
  if (server.os && !server.os.includes(osName(platform))) return { ...server, enabled: false, source: "server", reason: "os", os_name: osName(platform) };
  if (!server.real_screen && !server.virtual_display) return { ...server, enabled: false, source: "server", reason: "no_display" };
  return { ...server, source: "server", reason: null };
}

/** Whether the model may use the tools under `setting` (null `models`: every model). */
export function modelAllowed(setting, modelId) {
  if (!setting?.enabled) return false;
  return !Array.isArray(setting.models) || setting.models.includes(String(modelId ?? ""));
}

const OS_LABELS = { macos: "macOS", windows: "Windows", linux: "Linux" };

// ------------------------------------------------------------ this device's switch

/** Computer use on this device until the person turns it off (CLI /computer off, desktop Settings). */
export const COMPUTER_USE_DEFAULT = true;
/** The key both apps save it under, in <state or profile>/computer-use/device.json. */
export const COMPUTER_USE_SETTING = "computerUse";
export const COMPUTER_USE_FILE = "device.json";

/** Whether computer use is on for this device: the person's saved choice, else COMPUTER_USE_DEFAULT. */
export function deviceComputerUse(saved) {
  return typeof saved === "boolean" ? saved : COMPUTER_USE_DEFAULT;
}

/** Why computer use is not available here, in plain words for people; null while it is on. */
export function unavailableMessage(setting) {
  if (!setting || setting.enabled) return null;
  if (setting.reason === "os") return `Computer use is not available on ${OS_LABELS[setting.os_name] ?? "this system"} yet.`;
  if (setting.reason === "client") return "Computer use is not available in this app yet.";
  if (setting.reason === "env") return "Computer use is off on this computer (OMNIRUSH_COMPUTER_USE=0).";
  if (setting.reason === "device") return "Computer use is turned off on this computer.";
  if (setting.reason === "no_switch") return "Computer use is not ready yet: sign in and stay online once so the app can check your account.";
  return setting.message ?? "Computer use is turned off right now.";
}

// Words that ask for something on a screen: a browser, an app, clicks, typing into a window.
const SCREEN_INTENT = /(?:^|[.,;!]\s*|\b(?:and|then|please|to)\s+)(?:double[- ])?click\b|\b(?:my (?:browser|screen|desktop|mouse|computer)|(?:use|open|launch|start) (?:the |a |my )?(?:browser|chrome|firefox|edge|safari|app|application|program)|screenshot|computer use|take over my|fill (?:in|out) (?:the |this )?form)\b/i;

/** Whether a prompt asks for something done on a screen (use my browser, click, open an app). */
export function screenIntent(text) {
  return typeof text === "string" && SCREEN_INTENT.test(text);
}

/** The message people see when computer use is off. */
export function offMessage(setting) {
  return setting?.message ?? OFF_MESSAGE;
}

// ------------------------------------------------------------- real screen

/**
 * Whether the server lets this account use the person's real screen: `real_screen` (the global switch) and
 * `real_screen_opt_in` (the account's own opt-in, set only from the web console) both exactly true. Works on a
 * raw capabilities block and on a normalized one. Anything else (false, missing, malformed, no block) is no.
 */
export function serverRealScreen(block) {
  return isRecord(block) && block.real_screen === true && block.real_screen_opt_in === true;
}

/** Said to the agent when the account has not opted in (or the server turned it off). */
export const REAL_SCREEN_NOT_OPTED_IN_MESSAGE = "Computer use on the person's own screen is turned off for this account right now. Work on your own display instead (app_id \"virtual:main\"). Never try to change it and never ask to.";
/** Said to the agent when the server could not confirm it just now. */
export const REAL_SCREEN_UNVERIFIED_MESSAGE = "The person's screen cannot be used right now: the account's setting could not be confirmed with the server. Work on your own display instead (app_id \"virtual:main\").";

/** The person's real screen is off until the person turns it on (Settings / `omnirush computer real-screen on`).
 * Off by default for privacy; flipping this one value makes it on by default in both apps. */
export const REAL_SCREEN_DEFAULT = false;
/** The key both apps save the person's choice under, in <state or profile>/computer-use/real-screen.json. */
export const REAL_SCREEN_SETTING = "computerUseRealScreen";
export const REAL_SCREEN_FILE = "real-screen.json";
/** OMNIRUSH_COMPUTER_USE_REAL_SCREEN=0 turns it off; =1 turns it on only in builds run from source (tests, support). */
export const REAL_SCREEN_ENV = "OMNIRUSH_COMPUTER_USE_REAL_SCREEN";
export const REAL_SCREEN_OFF_MESSAGE = "Computer use on the person's own screen is off. Work on your own display instead (app_id \"virtual:main\"). Only the person can change this setting; never change it yourself and never ask to.";

/**
 * Engine permission rules for every mode (computer use on or off): the agent can neither run the command that
 * turns the real screen on nor write the person's settings (real-screen.json, and device.json with the device's
 * on/off), so it can never undo the person's choice for the next start. Appended after the mode's own rules (the
 * last match wins); the engine's matcher treats \\ as / (Windows paths match too).
 */
export const REAL_SCREEN_DENY_RULES = Object.freeze({
  bash: Object.freeze({
    "*computer real-screen*": "deny", "*computerUseRealScreen*": "deny", "*OMNIRUSH_COMPUTER_USE_REAL_SCREEN*": "deny", "*computer-use/real-screen.json*": "deny",
    "*computer-use*real-screen.json*": "deny", "*computer-use*device.json*": "deny", "*\"computerUse\"*": "deny", "*computerUse\\\"*": "deny",
  }),
  edit: Object.freeze({ "*computer-use/real-screen.json": "deny", "*computer-use/device.json": "deny" }),
});

/**
 * Whether the person turned the real screen on: the saved setting, else REAL_SCREEN_DEFAULT. The environment can
 * always force it OFF; it can force it ON only in builds run from source (`allowEnvOn`: the CLI's dev builds, an
 * unpackaged desktop app), so a line an agent slips into a shell profile never turns it on in a released app.
 */
export function realScreenOptIn({ env = process.env, saved, allowEnvOn = false } = {}) {
  const asked = String(env?.[REAL_SCREEN_ENV] ?? "").trim().toLowerCase();
  if (["0", "off", "false", "no"].includes(asked)) return false;
  if (allowEnvOn && ["1", "on", "true", "yes"].includes(asked)) return true;
  return typeof saved === "boolean" ? saved : REAL_SCREEN_DEFAULT;
}

/**
 * How a session opens, by display: `virtual` (the agent's own display) always opens with no question;
 * `real` (the person's screen) opens with no question only when the server allows it for this account
 * (`serverRealScreen`), that answer was read from the server just now (`verified` true: a read that failed or
 * was not made is no), and this device's own setting is on (`optIn`); it is refused otherwise (never asked).
 * Acts never ask on either.
 * Returns { open: true, asks: false } or { open: false, asks: false, code, message }.
 */
export function sessionRules({ display, server = {}, optIn = REAL_SCREEN_DEFAULT, verified = false } = {}) {
  if (display === "virtual") return server.virtual_display === false ? { open: false, asks: false, code: "virtual_unavailable", message: "The agent's own display is turned off for this account." } : { open: true, asks: false };
  if (!serverRealScreen(server)) return { open: false, asks: false, code: "real_screen_unavailable", message: REAL_SCREEN_NOT_OPTED_IN_MESSAGE };
  if (verified !== true) return { open: false, asks: false, code: "real_screen_unverified", message: REAL_SCREEN_UNVERIFIED_MESSAGE };
  if (optIn !== true) return { open: false, asks: false, code: "real_screen_off", message: REAL_SCREEN_OFF_MESSAGE };
  return { open: true, asks: false };
}

// ---------------------------------------------------------------- deny list

/**
 * Apps the agent may never open, by category. `match` entries are compared,
 * case-insensitively, with the app's name, executable base name (without
 * .exe/.app) and bundle id; a trailing `*` matches a prefix.
 */
export const DENIED_APPS = Object.freeze({
  self: ["omnirush", "omnirush.ai", "omnirush.ai computer use", "omnirush computer use", "ai.omnirush.*", "com.omnirush.*", "omnirush-*"],
  terminal: [
    "terminal", "com.apple.terminal", "iterm", "iterm2", "com.googlecode.iterm2", "wezterm", "wezterm-gui", "com.github.wez.wezterm", "alacritty", "kitty", "net.kovidgoyal.kitty",
    "hyper", "co.zeit.hyper", "tabby", "org.tabby", "warp", "dev.warp.warp-stable", "ghostty", "com.mitchellh.ghostty", "rio", "foot", "footclient",
    "gnome-terminal", "gnome-terminal-server", "kgx", "gnome-console", "konsole", "xterm", "uxterm", "urxvt", "rxvt", "xfce4-terminal", "tilix", "terminator", "lxterminal", "mate-terminal", "qterminal", "sakura", "st", "terminology", "guake", "yakuake", "tilda", "cool-retro-term",
    "cmd", "powershell", "powershell_ise", "pwsh", "windowsterminal", "wt", "conhost", "openconsole", "mintty", "conemu", "conemu64", "cmder", "fluent terminal", "putty", "kitty_portable",
  ],
  password_manager: [
    "1password", "1password 7", "com.1password.1password", "com.agilebits.onepassword7", "bitwarden", "com.bitwarden.desktop", "keepass", "keepassxc", "org.keepassxc.keepassxc", "keepassx", "lastpass", "dashlane", "enpass", "keeper", "keeper password manager",
    "proton pass", "nordpass", "roboform", "passwords", "com.apple.passwords", "seahorse", "org.gnome.seahorse.application", "kwalletmanager", "kwalletmanager5", "gnome-keyring-daemon", "secrets", "org.gnome.world.secrets", "authy", "authy desktop",
  ],
  credentials: ["keychain access", "com.apple.keychainaccess", "credentialuibroker", "credential manager", "securityagent", "com.apple.securityagent", "coreautha", "com.apple.coreautha", "pinentry*", "polkit-gnome-authentication-agent-1", "polkit-kde-authentication-agent-1", "lxpolkit", "ksshaskpass", "ssh-askpass*"],
  lock_screen: ["loginwindow", "com.apple.loginwindow", "screensaverengine", "com.apple.screensaver.engine", "logonui", "lockapp", "consent", "gnome-screensaver", "xscreensaver", "light-locker", "i3lock", "swaylock", "xsecurelock", "kscreenlocker_greet", "lightdm", "gdm", "sddm"],
});

/** System settings apps: denied when the window shows a security, privacy, account or password pane. */
export const SETTINGS_APPS = Object.freeze(["system settings", "system preferences", "com.apple.systempreferences", "com.apple.settings", "systemsettings", "settings", "control", "control panel", "gnome-control-center", "systemsettings5", "systemsettings", "xfce4-settings-manager", "mmc"]);
export const SECURITY_PANE = /privacy|security|password|passkey|users?\s*(&|and)\s*groups|accounts?|sign[-\s]?in|login|log[-\s]?in|credential|firewall|defender|bitlocker|filevault|keychain|touch id|face id|biometr|lock screen|screen time|parental|family/i;

/** IDEs and editors that host agent terminals: denied when one is an ancestor of the agent. */
export const AGENT_HOSTS = Object.freeze(["code", "code - insiders", "com.microsoft.vscode", "cursor", "com.todesktop.230313mzl4w4u92", "windsurf", "zed", "dev.zed.zed", "idea", "idea64", "pycharm", "pycharm64", "webstorm", "webstorm64", "goland", "goland64", "clion", "clion64", "rider", "rider64", "phpstorm", "phpstorm64", "rubymine", "datagrip", "android studio", "studio64", "fleet", "sublime_text", "nvim-qt", "emacs", "tmux", "screen", "zellij", "sshd", "omnirush"]);

const REASONS = {
  self: "Computer use cannot operate OmniRush itself.",
  terminal: "Computer use cannot operate terminals. Use the shell tool for commands.",
  password_manager: "Computer use cannot open password managers.",
  credentials: "Computer use cannot open keychains, credential stores or sign-in prompts.",
  lock_screen: "Computer use cannot operate the login or lock screen, or security prompts.",
  settings: "Computer use cannot open security, privacy, account or password settings.",
  ancestor: "Computer use cannot operate the app the agent runs in (its terminal, IDE or OmniRush).",
  tty: "Computer use cannot operate the terminal window the agent was started from.",
  secure_input: "Another app has secure keyboard input on (a password field). Finish it, then try again.",
  server: "This app is not available for computer use.",
};

function baseName(value) {
  if (typeof value !== "string" || !value) return "";
  const name = value.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
  return name.replace(/\.(exe|app|appimage|desktop)$/i, "").toLowerCase();
}

/** The lower-case names an app can be matched by: its name, executable base name, bundle id. */
export function appNames(app) {
  const out = new Set();
  if (!isRecord(app)) return out;
  for (const value of [app.name, app.app_name, app.bundle_id]) if (typeof value === "string" && value.trim()) out.add(value.trim().toLowerCase().replace(/\.(exe|app)$/i, ""));
  for (const value of [app.exe, app.executable, app.bundle_or_exe, app.app_id]) {
    const name = baseName(value);
    if (name) out.add(name);
    // "/Applications/Foo.app/Contents/MacOS/Foo": the bundle's name too.
    const bundle = typeof value === "string" ? /([^/\\]+)\.app(?:[/\\]|$)/i.exec(value) : null;
    if (bundle) out.add(bundle[1].toLowerCase());
  }
  return out;
}

function matches(names, pattern) {
  const p = pattern.toLowerCase();
  if (p.endsWith("*")) {
    const prefix = p.slice(0, -1);
    for (const name of names) if (name.startsWith(prefix)) return true;
    return false;
  }
  return names.has(p);
}

function sameProcess(app, other) {
  if (!isRecord(other)) return false;
  if (Number.isSafeInteger(other.pid) && other.pid > 0 && other.pid === app.pid) return true;
  const a = typeof (app.exe ?? app.executable) === "string" ? String(app.exe ?? app.executable) : "";
  const b = typeof other.exe === "string" ? other.exe : "";
  return Boolean(a && b && a === b);
}

/**
 * Why the agent may not open `app` ({ pid, name, exe, bundle_id, title }), or
 * null when it may. `ctx`: ancestors (the agent's ancestor processes,
 * [{ pid, name, exe }]), tty_pids (processes owning the agent's terminal
 * window), self_pids, deny_apps (the server's list), secure_input (macOS).
 * Returns { code: "protected_app", category, reason }.
 */
export function deniedApp(app, ctx = {}) {
  if (!isRecord(app)) return { code: "protected_app", category: "server", reason: REASONS.server };
  const deny = (category, reason = REASONS[category]) => ({ code: "protected_app", category, reason });
  if (ctx.secure_input === true) return deny("secure_input");
  if ((ctx.self_pids ?? []).includes(app.pid)) return deny("self");
  for (const ancestor of ctx.ancestors ?? []) if (sameProcess(app, ancestor)) return deny("ancestor");
  if ((ctx.tty_pids ?? []).includes(app.pid)) return deny("tty");
  const names = appNames(app);
  for (const [category, list] of Object.entries(DENIED_APPS)) if (list.some((pattern) => matches(names, pattern))) return deny(category);
  if (SETTINGS_APPS.some((pattern) => matches(names, pattern)) && SECURITY_PANE.test(String(app.title ?? ""))) return deny("settings");
  for (const entry of ctx.deny_apps ?? []) {
    const match = typeof entry === "string" ? entry : entry?.match;
    if (typeof match === "string" && match && matches(names, match)) return deny("server", (typeof entry === "object" && entry?.reason) || REASONS.server);
  }
  return null;
}

/**
 * The agent's ancestor processes, nearest first ([{ pid, name, exe }]), read
 * from /proc (Linux) or `ps` (macOS). Windows hosts read them natively and
 * pass them in; here the list is empty there.
 */
export function readAncestors({ pid = process.pid, platform = process.platform, limit = 64 } = {}) {
  const out = [];
  try {
    if (platform === "linux") {
      let current = pid;
      for (let i = 0; i < limit && current > 1; i += 1) {
        const stat = readFileSync(`/proc/${current}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        const name = stat.slice(stat.indexOf("(") + 1, close);
        const ppid = Number(stat.slice(close + 2).split(" ")[1]);
        let exe = "";
        try { exe = readlinkSync(`/proc/${current}/exe`); } catch { /* another user's process */ }
        if (current !== pid) out.push({ pid: current, name, exe });
        if (!Number.isSafeInteger(ppid) || ppid <= 0 || ppid === current) break;
        current = ppid;
      }
    } else if (platform === "darwin") {
      const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024 }).split("\n");
      const table = new Map();
      for (const row of rows) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row);
        if (m) table.set(Number(m[1]), { ppid: Number(m[2]), exe: m[3].trim() });
      }
      let current = table.get(pid)?.ppid;
      for (let i = 0; i < limit && current && current > 1; i += 1) {
        const row = table.get(current);
        if (!row) break;
        out.push({ pid: current, name: path.posix.basename(row.exe), exe: row.exe });
        current = row.ppid;
      }
    }
  } catch {
    /* best effort: the deny list and the host's own checks still apply */
  }
  return out;
}

/**
 * True when this process was started from inside an agent (a nested run):
 * OMNIRUSH_AGENT_DEPTH is set, or an ancestor is an omnirush/engine process.
 * Nested runs never get the real screen, only the virtual display.
 */
export function nestedAgent({ env = process.env, ancestors = [] } = {}) {
  const depth = Number(env?.OMNIRUSH_AGENT_DEPTH ?? 0);
  if (Number.isFinite(depth) && depth > 0) return true;
  return ancestors.some((a) => /^(omnirush|opencode|omnirush-engine)(\.exe)?$/i.test(String(a?.name ?? "")) || /[/\\](omnirush|opencode)(-engine)?(\.exe)?$/i.test(String(a?.exe ?? "")));
}

// ------------------------------------------------------- per-action approvals

/**
 * Words in an intent or the text at the target that make an act ask in Normal:
 * paying, buying and ordering (money leaving the person's account).
 */
export const RISKY_WORDS = Object.freeze([
  "pay", "payment", "pay now", "buy", "buy now", "buy again", "purchase", "checkout", "check out", "order", "place order", "order now", "reorder", "1-click",
  "subscribe", "upgrade", "renew", "donate", "tip", "bid", "place bid", "book", "book now", "reserve", "rent", "top up", "top-up", "add funds",
  "send money", "transfer", "wire",
]);
const RISKY_RE = new RegExp(`(^|[^\\p{L}\\p{N}])(${[...RISKY_WORDS].sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu");
const BENIGN = /\b(in\s+order\s+(to|for)|sort\s+order|order\s+by|ordered\s+list|order\s+(history|status|details|number)|track\s+(my\s+|your\s+|the\s+)?order)\b/gi;
// An amount of money with a verb that moves it ("Send $20", "Confirm 500 EUR"): paying too.
const AMOUNT = /[$€£₹¥]\s?\d|\b\d[\d,.]*\s?(usd|eur|gbp|inr|jpy|dollars?|euros?|rupees?|pounds?)\b/i;
const MOVES_MONEY = /\b(send|transfer|give|confirm|complete|submit|request|withdraw|deposit|pay|tip|donate)\b/i;

/** Words that also name everyday work ("the address book", "transfer the file"): they count in on-screen text and page titles, not in the agent's intent. */
const SCREEN_ONLY_WORDS = new Set(["book", "book now", "reserve", "rent", "tip", "bid", "place bid", "upgrade", "renew", "transfer"]);

/**
 * The paying/buying/ordering words found in `value`, lower case ("amount": money with a verb that moves it).
 * `from`: "screen" (on-screen text, page titles; the default) or "intent" (the agent's own words: SCREEN_ONLY_WORDS left out).
 */
export function riskyWords(value, from = "screen") {
  if (typeof value !== "string" || !value) return [];
  const textValue = value.replace(BENIGN, " ");
  const found = new Set();
  const re = new RegExp(RISKY_RE.source, "giu");
  let m;
  while ((m = re.exec(textValue)) !== null) { const word = m[2].toLowerCase().replace(/\s+/g, " "); if (from !== "intent" || !SCREEN_ONLY_WORDS.has(word)) found.add(word); }
  if (AMOUNT.test(textValue) && MOVES_MONEY.test(textValue)) found.add("amount");
  return [...found];
}

/** Window titles (a browser's page title) that say the page takes money: hosts that read no text at the point (X11) ask there. */
const PAYMENT_PAGE = /\b(cart|basket|billing|payment|checkout|check\s*out)\b/i;

/**
 * The narrower send/delete variant, OFF (the owner's decision, 2026-10-21). The server can turn it on without a
 * release (capabilities `computer_use.ask_send_delete: true`, hosts pass it as options.sendDelete): Normal then
 * also asks when the text
 * the OS read at a click/Enter target says Send/Post/Publish/Forward/Reply all or a permanent delete, and on
 * the Shift+Delete and Cmd+Backspace chords. Only OS-read text counts, never the agent's intent.
 */
export const ASK_SEND_DELETE = false;
const SEND_TARGET = /(^|[^\p{L}\p{N}])(send|post|publish|forward|reply\s+all)(?=$|[^\p{L}\p{N}])/iu;
const DELETE_TARGET = /\b(delete\s+(permanently|forever|account)|permanently\s+delete|empty\s+(the\s+)?(trash|bin|recycle\s+bin))\b/i;

/** An intent that says the typed text is a password, code or key (hosts that cannot see secure fields, X11). */
const SECRET_INTENT = /\b(pass(word|code|phrase)s?|pins?|one[-\s]?time\s+(code|password)|otp|2fa|mfa|verification\s+code|security\s+code|secret|api[-\s]?key|access\s+key|token|credentials?|cvv|cvc|card\s+number)\b/i;

const CREDENTIAL_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i,
];

function entropy(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / value.length; h -= p * Math.log2(p); }
  return h;
}

/**
 * True when typed text looks like a credential: a known key/token format, a
 * `password=` style assignment, or one long random-looking word.
 */
export function looksLikeCredential(value) {
  if (typeof value !== "string" || value.length < 8) return false;
  if (CREDENTIAL_PATTERNS.some((re) => re.test(value))) return true;
  const word = value.trim();
  if (/\s/.test(word) || word.length < 20 || word.length > 512) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(word)).length;
  return classes >= 3 && entropy(word) >= 3.8 && !/^https?:\/\//i.test(word) && !/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(word);
}

/**
 * The desktop's built-in browser tool only (computer use never asks; see sessionRules).
 * Whether one browser act asks the person first, by permission mode:
 * - careful: every act asks;
 * - normal: only paying, buying or ordering (the intent, the text at a click
 *   or Enter/Space target, or, where the host reads no text there, a page
 *   title that says so) and typing a password (a secure field, text that
 *   looks like a credential, or an intent that says so); plus an act outside
 *   the approved window, which a session never does (acts go to the approved
 *   window, other apps need their own open consent). With ASK_SEND_DELETE
 *   (or options.sendDelete) also OS-read send/permanent-delete targets, the
 *   Shift+Delete / Cmd+Backspace chords and Enter (or Ctrl/Cmd+Enter) right
 *   after typing in the window;
 * - auto: never.
 * In every mode the open-session consent, the deny list, hit-testing, the
 * indicator and Stop still apply.
 * `input`: { mode, action, intent, target: { text, secure }, window: { id,
 * app_id, title }, approved: { window_id, app_id }, typed_before } (target.text
 * undefined: the host reads no text there; typed_before: the agent's last act
 * in this window typed text). `options`: { sendDelete }.
 * Returns { ask, reasons: [{ code, detail? }] }.
 */
export function actApproval(input = {}, options = {}) {
  const mode = PERMISSION_MODES.includes(input.mode) ? input.mode : "normal";
  if (mode === "auto") return { ask: false, reasons: [] };
  if (mode === "careful") return { ask: true, reasons: [{ code: "careful" }] };
  const sendDelete = options.sendDelete ?? ASK_SEND_DELETE;
  const reasons = [];
  const action = isRecord(input.action) ? input.action : {};
  const target = isRecord(input.target) ? input.target : {};
  const window = isRecord(input.window) ? input.window : null;
  const key = action.type === "key" ? String(action.key ?? "").toLowerCase() : "";
  const mods = new Set(Array.isArray(action.modifiers) ? action.modifiers : []);
  const intentWords = riskyWords(input.intent, "intent");
  if (intentWords.length) reasons.push({ code: "risky_intent", detail: intentWords.join(", ") });
  // Clicks, and Enter or Space on the focused control (no modifiers).
  const presses = ["click", "double_click", "right_click", "drag"].includes(action.type) || ((key === "enter" || key === "space") && mods.size === 0);
  if (presses) {
    const targetWords = riskyWords(target.text);
    if (targetWords.length) reasons.push({ code: "risky_target", detail: targetWords.join(", ") });
    // No text the host could read there (X11): the page title decides whether this may be a payment page.
    else if (typeof target.text !== "string" && action.type !== "drag" && window && (riskyWords(window.title).length || PAYMENT_PAGE.test(String(window.title ?? "")))) reasons.push({ code: "risky_page", detail: String(window.title ?? "").slice(0, 120) });
    if (sendDelete && typeof target.text === "string" && (SEND_TARGET.test(target.text) || DELETE_TARGET.test(target.text))) reasons.push({ code: "send_delete_target", detail: target.text.slice(0, 80) });
  }
  if (sendDelete && action.type === "key" && ((mods.has("shift") && key === "delete") || (mods.has("meta") && (key === "backspace" || key === "delete")))) reasons.push({ code: "delete_chord" });
  // Enter (or Ctrl/Cmd+Enter) right after the agent typed in this window sends a chat message or an e-mail.
  if (sendDelete && key === "enter" && input.typed_before === true && [...mods].every((m) => m === "ctrl" || m === "meta")) reasons.push({ code: "send_after_typing" });
  if (action.type === "type") {
    if (target.secure === true) reasons.push({ code: "secure_field" });
    if (looksLikeCredential(action.text)) reasons.push({ code: "credential_text" });
    else if (target.secure !== true && SECRET_INTENT.test(String(input.intent ?? ""))) reasons.push({ code: "credential_intent" });
  }
  const approved = isRecord(input.approved) ? input.approved : null;
  if (window && approved && ((approved.app_id && window.app_id && approved.app_id !== window.app_id) || (approved.window_id !== undefined && window.id !== undefined && String(approved.window_id) !== String(window.id)))) reasons.push({ code: "other_window" });
  return { ask: reasons.length > 0, reasons };
}

/** People-facing text for an approval reason code. */
export const ASK_REASONS = Object.freeze({
  careful: "Careful mode asks before every action.",
  risky_intent: "The agent says it will pay, buy or order something",
  risky_target: "The target looks like a button that pays, buys or orders",
  risky_page: "The page looks like a checkout or payment page",
  send_delete_target: "The target looks like a button that sends, posts or deletes for good",
  delete_chord: "The shortcut deletes for good.",
  send_after_typing: "It would press Enter right after typing, which may send what was typed.",
  secure_field: "It would type into a password field.",
  credential_text: "The text looks like a password or key.",
  credential_intent: "The agent says it is typing a password, code or key.",
  other_window: "It would act in another window.",
});

/**
 * Shell commands that capture the screen or inject input: they ask in Normal
 * (engine bash permission patterns, appended after the mode's own rules).
 */
export const SCREEN_BASH_RULES = Object.freeze({
  "*screencapture*": "ask",
  "*xdotool*": "ask",
  "*ydotool*": "ask",
  "*xwd *": "ask",
  "*import -window*": "ask",
  "*scrot*": "ask",
  "*gnome-screenshot*": "ask",
  "*spectacle*": "ask",
  "*grim *": "ask",
  "*xte *": "ask",
  "*nircmd*": "ask",
  "*osascript*System Events*": "ask",
  "*SendKeys*": "ask",
  "*SendInput*": "ask",
  "*CopyFromScreen*": "ask",
  "*keybd_event*": "ask",
  "*mouse_event*": "ask",
});

/** Engine permission rules for the tools of the built-in server: computer use never asks, the engine neither. */
export function computerPermissionRules() {
  return { [`${SERVER_ID}_*`]: "allow" };
}

/** Engine permission rules for sub-agents: no computer use in v1 (one lease per app process). */
export function subagentPermissionRules() {
  return { [`${SERVER_ID}_*`]: "deny" };
}
