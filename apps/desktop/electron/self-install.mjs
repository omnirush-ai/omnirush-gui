// Installs a downloaded update where electron-updater cannot, or cannot do it
// safely:
//
//  - macOS builds without a Developer ID signature: Squirrel.Mac refuses to
//    swap them. The release zip is downloaded and checked against the
//    manifest's sha512, extracted next to the old app, and a small detached
//    helper swaps the .app bundle once this process has exited, clears the
//    quarantine flag and opens the new bundle.
//  - Linux AppImage: the downloaded AppImage is renamed over the running one
//    (the running copy keeps its open inode) and the app relaunches through
//    Electron's relauncher, which waits for this process to exit. That keeps
//    the file name, so desktop entries and shortcuts stay valid.
//  - Linux .deb/.rpm/.pacman: the package manager owns the files, so the
//    package is downloaded and the user gets the command to install it.
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** The .app bundle that contains `appPath` (app.getAppPath() or process.execPath). */
export function macBundleFromPath(appPath) {
  const value = typeof appPath === "string" ? appPath : "";
  const marker = ".app/Contents/";
  const index = value.indexOf(marker);
  return index === -1 ? null : value.slice(0, index + ".app".length);
}

/**
 * Gatekeeper runs a quarantined app opened from Downloads from a read-only
 * random mount (App Translocation). Replacing that copy would change nothing.
 */
export function isTranslocatedBundle(bundlePath) {
  return typeof bundlePath === "string" && bundlePath.includes("/AppTranslocation/");
}

/**
 * Whether the bundle sits on a read-only volume: the mounted DMG, or the
 * read-only mount App Translocation runs a quarantined app from. Squirrel.Mac
 * refuses to update from either ("Cannot update while running on a read-only
 * volume"). A folder this user merely cannot write (a standard user's
 * /Applications) is not read-only: ShipIt asks for an administrator there.
 */
export async function isOnReadOnlyVolume(bundlePath, check = access) {
  if (typeof bundlePath !== "string" || !bundlePath) return false;
  try {
    await check(path.dirname(bundlePath), fsConstants.W_OK);
    return false;
  } catch (error) {
    return error?.code === "EROFS";
  }
}

export async function isWritable(target) {
  try {
    await access(target, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether this user can rename `target` (a file or a bundle) inside its folder. */
export async function canReplaceInPlace(target) {
  return (await isWritable(path.dirname(target))) && (await isWritable(target));
}

/** The running AppImage from $APPIMAGE, or null outside an AppImage. */
export function linuxAppImagePath(env = process.env) {
  const value = typeof env?.APPIMAGE === "string" ? env.APPIMAGE.trim() : "";
  return value && path.isAbsolute(value) ? path.resolve(value) : null;
}

/** electron-builder writes resources/package-type for deb, rpm and pacman builds. */
export async function linuxPackageType(resourcesPath, read = readFile) {
  if (!resourcesPath) return null;
  try {
    const value = String(await read(path.join(resourcesPath, "package-type"), "utf8")).trim();
    return value === "deb" || value === "rpm" || value === "pacman" ? value : null;
  } catch {
    return null;
  }
}

const PACKAGE_EXTENSIONS = { deb: ".deb", rpm: ".rpm", pacman: ".pacman", appimage: ".AppImage" };

export function packageExtension(kind) {
  return PACKAGE_EXTENSIONS[kind] ?? null;
}

export function shellQuote(value) {
  const text = String(value);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that installs a downloaded Linux package. `target` is the
 * AppImage to replace when its folder needs root (an AppImage in /opt).
 */
export function linuxInstallCommand(kind, filePath, target = null) {
  const file = shellQuote(filePath);
  switch (kind) {
    case "deb":
      return `sudo apt install ${file}`;
    case "rpm":
      return `sudo dnf install ${file}`;
    case "pacman":
      return `sudo pacman -U ${file}`;
    case "appimage":
      return target ? `sudo install -m 755 ${file} ${shellQuote(target)}` : null;
    default:
      return null;
  }
}

/**
 * Replaces the AppImage at `target` with `source`. The copy lands next to the
 * target first and is renamed over it, so the running AppImage (mounted from
 * the old inode) keeps working and a failed copy never leaves a broken file.
 */
export async function replaceAppImage({ source, target }) {
  if (!source || !target) throw new Error("No downloaded AppImage to install.");
  const staged = `${target}.update-${process.pid}`;
  try {
    await copyFile(source, staged);
    await chmod(staged, 0o755);
    await rename(staged, target);
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined);
    throw error;
  }
  await rm(source, { force: true }).catch(() => undefined);
  return target;
}

/**
 * The environment for a process started outside this AppImage: without the
 * runtime's variables and anything pointing into its mount, which is gone
 * once this process exits.
 */
/** @param {Record<string, string | undefined>} [env] */
export function environmentOutsideAppImage(env = process.env) {
  const appDir = typeof env.APPDIR === "string" && env.APPDIR ? env.APPDIR : null;
  /** @type {Record<string, string | undefined>} */
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    // The CDP port this copy chose: the new one probes for a free port again.
    if (["APPDIR", "APPIMAGE", "ARGV0", "OWD", "OMNIRUSH_ELECTRON_REMOTE_DEBUG_PORT"].includes(key)) continue;
    if (appDir && typeof value === "string" && value.includes(appDir)) {
      // PATH-like lists keep their other entries.
      const rest = value.split(":").filter((entry) => entry && !entry.includes(appDir));
      if (rest.length) clean[key] = rest.join(":");
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

/**
 * Reopens `appImage` once process `pid` has exited. A small shell outside
 * the AppImage waits, so neither the single-instance lock nor the runtime
 * unmounting this copy can stop the new one (Electron's own relauncher runs
 * from inside the mount that goes away).
 *
 * @param {{
 *   appImage: string,
 *   pid?: number,
 *   runtimePid?: number,
 *   args?: string[],
 *   env?: Record<string, string | undefined>,
 *   logPath?: string | null,
 *   spawnProcess?: (command: string, args: string[], options: import("node:child_process").SpawnOptions) => { unref?: () => void },
 * }} options
 */
export function relaunchAppImageAfterExit({
  appImage,
  pid = process.pid,
  runtimePid = process.ppid,
  args = [],
  env = process.env,
  logPath = null,
  spawnProcess = spawn,
}) {
  const bash = existsSync("/bin/bash");
  const script = [
    // Descriptors inherited from this app (the AppImage runtime's keep-alive
    // pipe, listening sockets) would keep the old copy mounted and its ports
    // taken for as long as the new one runs: close all but stdio.
    ...(bash ? ['for fd in /proc/$$/fd/*; do n=${fd##*/}; case "$n" in 0|1|2) ;; *) eval "exec $n>&-" 2>/dev/null ;; esac; done'] : []),
    'pid="$1"; runtime="$2"; shift 2',
    'echo "$(date) waiting for $pid to exit, then opening $1"',
    'i=0; while kill -0 "$pid" 2>/dev/null; do i=$((i + 1)); [ "$i" -gt 1200 ] && { echo "the app did not exit"; exit 1; }; sleep 0.25; done',
    // The AppImage runtime unmounts the old copy and exits; give it a moment.
    'i=0; while [ "$runtime" -gt 1 ] && kill -0 "$runtime" 2>/dev/null && [ "$i" -lt 40 ]; do i=$((i + 1)); sleep 0.25; done',
    "sleep 0.5",
    'exec "$@"',
  ].join("\n");
  /** @type {"ignore" | number} */
  let output = "ignore";
  if (logPath) {
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      output = openSync(logPath, "a");
    } catch {
      output = "ignore";
    }
  }
  // Never inside the old mount: a cwd there would keep it mounted.
  const appDir = typeof env.APPDIR === "string" && env.APPDIR ? env.APPDIR : null;
  const cwd = typeof env.OWD === "string" && env.OWD && (!appDir || !env.OWD.startsWith(appDir)) && existsSync(env.OWD)
    ? env.OWD
    : os.homedir();
  const child = spawnProcess(bash ? "/bin/bash" : "/bin/sh", ["-c", script, "sh", String(pid), String(runtimePid ?? 0), appImage, ...args], {
    detached: true,
    cwd,
    stdio: ["ignore", output, output],
    env: /** @type {NodeJS.ProcessEnv} */ (environmentOutsideAppImage(env)),
  });
  if (typeof output === "number") closeSync(output);
  child.unref?.();
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(String(stdout ?? "").trim());
    });
  });
}

async function plistValue(bundle, key, exec = run) {
  return exec("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path.join(bundle, "Contents", "Info.plist")]);
}

/**
 * Extracts the verified release zip into a fresh folder and returns the .app
 * in it, after checking it is the expected version of the same app.
 */
export async function stageMacBundle({ zipPath, version, currentBundle, stagingRoot = os.tmpdir(), exec = run }) {
  const directory = await mkdtemp(path.join(stagingRoot, "omnirush-update-"));
  try {
    // ditto keeps the symlinks, modes and extended attributes an .app needs.
    await exec("/usr/bin/ditto", ["-x", "-k", zipPath, directory]);
    const entries = await readdir(directory);
    const bundleName = entries.find((name) => name.endsWith(".app"));
    if (!bundleName) throw new Error("The update zip has no app in it.");
    const bundle = path.join(directory, bundleName);
    const stagedVersion = await plistValue(bundle, "CFBundleShortVersionString", exec);
    if (version && stagedVersion !== version) {
      throw new Error(`The update zip holds version ${stagedVersion}, not ${version}.`);
    }
    if (currentBundle) {
      const [stagedId, currentId] = await Promise.all([
        plistValue(bundle, "CFBundleIdentifier", exec),
        plistValue(currentBundle, "CFBundleIdentifier", exec).catch(() => null),
      ]);
      if (currentId && stagedId !== currentId) throw new Error("The update zip holds a different app.");
    }
    await exec("/usr/bin/xattr", ["-dr", "com.apple.quarantine", bundle]).catch(() => undefined);
    return { directory, bundle, version: stagedVersion };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The detached helper: waits for the app to exit, moves the old bundle aside,
 * moves the new one in (rolling back if that fails), clears quarantine and
 * opens it. Arguments: pid, new bundle, target bundle, relaunch (1/0), and,
 * when it runs as root, the uid and user name to reopen the app as.
 */
export const MAC_SWAP_SCRIPT = `#!/bin/sh
pid="$1"; new="$2"; target="$3"; relaunch="$4"; uid="$5"; user="$6"
echo "$(date) swap $new -> $target (pid $pid)"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 1200 ]; then echo "the app did not exit; update skipped"; rm -rf "$(dirname "$new")"; exit 1; fi
  sleep 0.25
done
reopen() {
  [ "$relaunch" = 1 ] || return 0
  if [ -n "$uid" ]; then /bin/launchctl asuser "$uid" /usr/bin/sudo -u "$user" /usr/bin/open "$1"
  else /usr/bin/open "$1"; fi
}
backup="$target.previous-$$"
if ! mv "$target" "$backup"; then echo "could not move the old app aside"; reopen "$target"; exit 1; fi
if ! mv "$new" "$target"; then
  echo "could not move the new app in; restoring"
  rm -rf "$target"; mv "$backup" "$target"; reopen "$target"; exit 1
fi
if [ -n "$uid" ]; then chown -R "$(stat -f '%u:%g' "$backup")" "$target" 2>/dev/null || true; fi
/usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
rm -rf "$backup" "$(dirname "$new")"
echo "$(date) installed $(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$target/Contents/Info.plist" 2>/dev/null)"
reopen "$target"
`;

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Starts the swap helper. Where this user can replace the bundle it runs
 * detached as the user; otherwise (an /Applications this user cannot write)
 * macOS asks for an administrator, and the helper runs as root and reopens
 * the app as the user. Resolves when the helper is running; rejects when it
 * could not start, including a cancelled password prompt.
 */
export async function launchMacSwap({
  stagedBundle,
  targetBundle,
  pid = process.pid,
  relaunch = true,
  logPath,
  writable,
  uid = process.getuid?.() ?? 0,
  user = os.userInfo().username,
  spawnDetached = defaultSpawnDetached,
  exec = run,
}) {
  const scriptPath = path.join(path.dirname(stagedBundle), "..", `omnirush-swap-${pid}.sh`);
  await writeFile(scriptPath, MAC_SWAP_SCRIPT, { mode: 0o755 });
  if (logPath) await mkdir(path.dirname(logPath), { recursive: true }).catch(() => undefined);
  const log = logPath ?? "/dev/null";
  if (writable) {
    spawnDetached("/bin/sh", [scriptPath, String(pid), stagedBundle, targetBundle, relaunch ? "1" : "0"], log);
    return { elevated: false };
  }
  const command = ["/bin/sh", scriptPath, String(pid), stagedBundle, targetBundle, relaunch ? "1" : "0", String(uid), user]
    .map(shellQuote)
    .join(" ");
  const script = `do shell script ${appleScriptString(`${command} >> ${shellQuote(log)} 2>&1 &`)} with prompt ${appleScriptString("OmniRush.ai needs permission to replace itself with the new version.")} with administrator privileges`;
  await exec("/usr/bin/osascript", ["-e", script]);
  return { elevated: true };
}

function defaultSpawnDetached(command, args, logPath) {
  const child = spawn("/bin/sh", ["-c", `exec "$@" >> ${shellQuote(logPath)} 2>&1`, "sh", command, ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/** "User canceled" from osascript (-128): the password prompt was dismissed. */
export function isAuthorizationCancelled(error) {
  const text = `${error?.message ?? ""} ${error?.stderr ?? ""}`;
  return /-128|User cancel+ed/i.test(text);
}

export async function fileExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
