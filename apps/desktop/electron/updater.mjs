import { readFile, mkdir, open, rename, writeFile, rm } from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cacheVerifiedRecoveryArtifact,
  compatibleRecoveryReleases,
  compareStableVersions,
  parseRecoveryManifest,
  readCachedRecoveryArtifact,
  readRecoveryState,
  recordHealthyVersion,
  recoveryManifestName,
  recoveryVersionMarkers,
  selectRecoveryArtifact,
  stableVersion,
  verifyCachedRecoveryArtifact,
} from "./recovery.mjs";
import {
  canReplaceInPlace,
  fileExists,
  isAuthorizationCancelled,
  isOnReadOnlyVolume,
  isTranslocatedBundle,
  launchMacSwap,
  linuxAppImagePath,
  linuxInstallCommand,
  linuxPackageType,
  macBundleFromPath,
  packageExtension,
  relaunchAppImageAfterExit,
  replaceAppImage,
  stageMacBundle,
} from "./self-install.mjs";

const ELECTRON_UPDATER_CHANNEL_FILENAME = "electron-updater-channel.v1.json";
// Where a manually installed update (macOS DMG) is staged before it is opened.
const INSTALLER_CACHE_DIRECTORY = "app-update-installer";

// In dev mode, app.getVersion() returns the Electron framework version
// (e.g. "35.7.5") instead of the OmniRush.ai app version. Read from
// package.json so the UI always shows the correct version.
const __updater_dirname = path.dirname(fileURLToPath(import.meta.url));
let _cachedAppVersion = null;
function resolveAppVersion(app) {
  if (_cachedAppVersion) return _cachedAppVersion;
  const electronVersion = app.getVersion();
  // If packaged, app.getVersion() is correct (set by electron-builder).
  if (app.isPackaged) {
    _cachedAppVersion = electronVersion;
    return electronVersion;
  }
  // In dev, read from package.json.
  try {
    const pkgPath = path.resolve(__updater_dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    _cachedAppVersion = pkg.version || electronVersion;
  } catch {
    _cachedAppVersion = electronVersion;
  }
  return _cachedAppVersion;
}

// The public distribution reads `latest*.yml` from the latest GitHub release.
// There is no public Alpha feed: the Alpha channel exists only when a
// distribution ships its own feed directory (see updaterFeedOptions).
export const STABLE_UPDATER_FEED_URL = "https://github.com/omnirush-ai/omnirush-gui/releases/latest/download";

/**
 * Feed selection shared by every updater IPC handler. `manifestChannel` picks
 * the manifest name electron-updater reads (`latest` for the public build,
 * the distribution flavor otherwise) and `alphaFeedUrl` is the only thing that
 * can enable the Alpha channel. Without it a persisted or requested "alpha"
 * normalizes back to stable instead of probing a feed that does not exist.
 */
export function updaterFeedOptions({
  manifestChannel = "latest",
  alphaFeedUrl = null,
  devFeedUrl = null,
} = {}) {
  const normalizedAlphaFeedUrl = typeof alphaFeedUrl === "string" ? alphaFeedUrl.trim().replace(/\/+$/, "") : "";
  return Object.freeze({
    manifestChannel,
    alphaFeedUrl: manifestChannel === "latest" && normalizedAlphaFeedUrl ? normalizedAlphaFeedUrl : null,
    stableFeedUrl: loopbackDevFeedUrl(devFeedUrl) ?? STABLE_UPDATER_FEED_URL,
  });
}

/**
 * OMNIRUSH_UPDATER_DEV_FEED_URL lets a local update rig serve latest*.yml to a
 * packaged build. Only a loopback http(s) URL is honored, so the variable can
 * never point a real install at a remote feed.
 */
export function loopbackDevFeedUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
  return url.toString().replace(/\/+$/, "");
}

function alphaChannelSupported(feedOptions) {
  return feedOptions.alphaFeedUrl !== null;
}

export function normalizeElectronUpdaterChannel(value, feedOptions = updaterFeedOptions()) {
  if (value === "alpha" && alphaChannelSupported(feedOptions)) return "alpha";
  return "stable";
}

function electronUpdaterChannelPath(app) {
  return path.join(app.getPath("userData"), ELECTRON_UPDATER_CHANNEL_FILENAME);
}

async function readElectronUpdaterChannel(app, feedOptions) {
  try {
    const raw = await readFile(electronUpdaterChannelPath(app), "utf8");
    const parsed = JSON.parse(raw);
    return normalizeElectronUpdaterChannel(parsed?.channel, feedOptions);
  } catch {
    return "stable";
  }
}

async function writeElectronUpdaterChannel(app, channel, feedOptions) {
  const normalized = normalizeElectronUpdaterChannel(channel, feedOptions);
  const outputPath = electronUpdaterChannelPath(app);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({ channel: normalized, writtenAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  return normalized;
}

export function electronUpdaterFeedUrl(channel, feedOptions = updaterFeedOptions()) {
  return normalizeElectronUpdaterChannel(channel, feedOptions) === "alpha"
    ? feedOptions.alphaFeedUrl
    : feedOptions.stableFeedUrl;
}

function normalizeStableTargetVersion(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : null;
}

function parseComparableVersion(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^v/i, "");
  if (!normalized) return null;

  const [versionCore] = normalized.split("+", 1);
  if (!versionCore) return null;

  const [releasePart, prereleasePart = ""] = versionCore.split("-", 2);
  const release = releasePart.split(".").map((segment) => Number(segment));
  if (!release.length || release.some((segment) => !Number.isInteger(segment) || segment < 0)) {
    return null;
  }

  const prerelease = prereleasePart
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

  return { release, prerelease };
}

function comparePrereleaseIdentifiers(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;

  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const leftNumeric = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumeric = /^\d+$/.test(rightPart) ? Number(rightPart) : null;

    if (leftNumeric !== null && rightNumeric !== null) {
      if (leftNumeric !== rightNumeric) return leftNumeric < rightNumeric ? -1 : 1;
      continue;
    }

    if (leftNumeric !== null) return -1;
    if (rightNumeric !== null) return 1;

    const comparison = leftPart.localeCompare(rightPart);
    if (comparison !== 0) return comparison < 0 ? -1 : 1;
  }

  return 0;
}

function compareVersions(left, right) {
  const parsedLeft = parseComparableVersion(left);
  const parsedRight = parseComparableVersion(right);
  if (!parsedLeft || !parsedRight) return null;

  const count = Math.max(parsedLeft.release.length, parsedRight.release.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = parsedLeft.release[index] ?? 0;
    const rightPart = parsedRight.release[index] ?? 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }

  return comparePrereleaseIdentifiers(parsedLeft.prerelease, parsedRight.prerelease);
}

function isVersionNewer(candidate, current) {
  const comparison = compareVersions(candidate, current);
  return comparison === null ? candidate !== current : comparison > 0;
}

export function targetedStableUpdaterFeed(currentVersion, targetVersion, allowOlder = false) {
  const normalizedTarget = normalizeStableTargetVersion(targetVersion);
  if (!normalizedTarget) {
    throw new Error("Target update version must use the stable x.y.z format.");
  }
  const comparison = compareVersions(normalizedTarget, currentVersion);
  if (comparison === null) {
    throw new Error("Installed version could not be validated for a targeted update.");
  }
  if (comparison === 0 || (!allowOlder && comparison < 0)) {
    throw new Error(allowOlder
      ? "Recovery target version must differ from the installed version."
      : "Target update version must be newer than the installed version.");
  }
  return `https://github.com/omnirush-ai/omnirush-gui/releases/download/v${normalizedTarget}`;
}

function updaterChannelState(app, channel, targetVersion, feedOptions) {
  const normalized = normalizeElectronUpdaterChannel(channel, feedOptions);
  const currentVersion = resolveAppVersion(app);
  return {
    channel: normalized,
    feedUrl: targetVersion
      ? targetedStableUpdaterFeed(currentVersion, targetVersion)
      : electronUpdaterFeedUrl(normalized, feedOptions),
    currentVersion,
    alphaChannelSupported: alphaChannelSupported(feedOptions),
  };
}

async function applyElectronUpdaterFeed(
  app,
  updater,
  targetVersion,
  feedOptions,
  allowOlder = false,
  channelOverride,
) {
  const channel = channelOverride === undefined
    ? await readElectronUpdaterChannel(app, feedOptions)
    : normalizeElectronUpdaterChannel(channelOverride, feedOptions);
  if (targetVersion && channel !== "stable") {
    throw new Error("Version-specific update feeds are supported only on the stable channel.");
  }
  const currentVersion = resolveAppVersion(app);
  const state = targetVersion
    ? {
        channel,
        feedUrl: targetedStableUpdaterFeed(currentVersion, targetVersion, allowOlder),
        currentVersion,
        alphaChannelSupported: alphaChannelSupported(feedOptions),
      }
    : updaterChannelState(app, channel, null, feedOptions);
  updater.allowPrerelease = state.channel === "alpha";
  // Moving from alpha back to stable can be a semver downgrade; still show
  // the latest stable so users can return to the stable channel deliberately.
  updater.allowDowngrade = state.channel === "stable" && (!targetVersion || allowOlder);
  // Select the manifest through the generic provider's own `channel` option
  // rather than AppUpdater#channel: that setter is a no-op unless the instance
  // was constructed with a channel, which would silently leave a custom
  // distribution reading latest*.yml and updating itself into the public app.
  // Public builds pass no channel and keep the provider's `latest` default.
  if (updater?.setFeedURL) {
    updater.setFeedURL({
      provider: "generic",
      url: state.feedUrl,
      ...(feedOptions.manifestChannel !== "latest" ? { channel: feedOptions.manifestChannel } : {}),
    });
  }
  return state;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function runDefaults(args) {
  return new Promise((resolve) => {
    execFile("/usr/bin/defaults", args, (error) => {
      // Best-effort: a failure here just means we fall back to Squirrel's
      // default move-based install. Never block the update on it.
      if (error) console.warn("[updater] defaults write failed", error?.message ?? error);
      resolve(undefined);
    });
  });
}

// Squirrel.Mac's `ShipIt` helper (which swaps the .app on macOS) reads its
// options from this NSUserDefaults domain.
const SHIP_IT_DEFAULTS_DOMAIN = "ai.omnirush.desktop.ShipIt";

// Squirrel.Mac defaults to moving the *entire* app bundle through a temp
// directory. On repeat installs that move can leave the staged bundle missing,
// producing:
//   "Failed to copy bundle … no such file or directory"
//   "Too many attempts to install, aborting update"
// and silently relaunching the OLD app (so the in-app version looks updated
// while the on-disk renderer stays stale). Enabling DirectContentsWrite makes
// ShipIt write file contents in place instead of moving whole bundles, which
// avoids the ENOENT abort.
async function enableSquirrelDirectContentsWrite(
  shipItDefaultsDomain = SHIP_IT_DEFAULTS_DOMAIN,
) {
  if (process.platform !== "darwin") return;
  await runDefaults(["write", shipItDefaultsDomain, "SquirrelMacEnableDirectContentsWrite", "-bool", "YES"]);
}

// Path of the ShipIt cache that, when stuck, keeps aborting future installs.
// Exported for tests.
export function staleUpdaterStatePaths(app, shipItDefaultsDomain = SHIP_IT_DEFAULTS_DOMAIN) {
  if (process.platform !== "darwin") return [];
  const home = app.getPath("home");
  return [path.join(home, "Library", "Caches", shipItDefaultsDomain)];
}

// Remove a previously-failed, half-applied update so the next attempt starts
// from a clean slate. A stuck `ShipIt` state (after "Too many attempts to
// install, aborting update") can otherwise keep aborting future installs.
async function cleanStaleUpdaterState(app, shipItDefaultsDomain) {
  for (const target of staleUpdaterStatePaths(app, shipItDefaultsDomain)) {
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      console.warn("[updater] failed to clean stale state", target, error?.message ?? error);
    }
  }
}

// ---------------------------------------------------------------------------
// macOS code-signature detection.
//
// Squirrel.Mac only swaps in an update whose code signature validates against
// the running app. Community builds are ad-hoc signed (no Developer ID), so an
// in-place install is guaranteed to fail there; those builds download the DMG
// and open it for a manual drag-to-Applications install instead.
// ---------------------------------------------------------------------------

export function macAppBundlePath(execPath) {
  const value = typeof execPath === "string" ? execPath : "";
  const marker = ".app/Contents/";
  const index = value.indexOf(marker);
  return index === -1 ? null : value.slice(0, index + ".app".length);
}

export function developerIdSignatureFromCodesignOutput(output) {
  const text = String(output ?? "");
  if (!text.trim()) return false;
  if (/Signature=adhoc/.test(text)) return false;
  return /Authority=Developer ID Application/.test(text);
}

/**
 * Resolves true only when the bundle that owns `execPath` carries a Developer
 * ID signature. Any spawn failure, unexpected output, or a path outside an
 * .app bundle counts as ad-hoc: treating an unknown signature as swappable
 * would only trade a clear manual install for a silent Squirrel failure.
 *
 * @param {string} [execPath]
 * @param {Function} [run] execFile-compatible spawner, injectable for tests.
 */
export function detectDeveloperIdSignature(execPath = process.execPath, run = execFile) {
  const bundlePath = macAppBundlePath(execPath);
  if (!bundlePath) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      run(
        "/usr/bin/codesign",
        ["-dv", "--verbose=2", bundlePath],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            resolve(false);
            return;
          }
          resolve(developerIdSignatureFromCodesignOutput(`${stdout ?? ""}\n${stderr ?? ""}`));
        },
      );
    } catch {
      resolve(false);
    }
  });
}

function installerAssetArch(arch) {
  return arch === "x64" ? "x64" : "arm64";
}

/**
 * The directory a manifest's relative file names resolve against. The public
 * feed is `releases/latest/download`, which follows whichever release is
 * latest at download time; the assets are read from the release the manifest
 * names instead, so a release published mid-download cannot swap the file
 * out from under the checksum.
 */
export function releaseAssetDirectory(feedUrl, version) {
  const base = typeof feedUrl === "string" ? feedUrl.replace(/\/+$/, "") : "";
  if (base === STABLE_UPDATER_FEED_URL && typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) {
    return `https://github.com/omnirush-ai/omnirush-gui/releases/download/v${version}`;
  }
  return base;
}

/**
 * Picks the file the update manifest lists with `extension` (and, for macOS,
 * this architecture) and resolves it like electron-updater resolves its own
 * download. Returns null when the manifest has no matching file or no
 * checksum to verify it with. Only https is accepted, except from the
 * loopback feed of a local update rig.
 */
export function selectReleaseAsset(info, feedUrl, { extension, arch = null }) {
  const files = Array.isArray(info?.files) ? info.files : [];
  const assetArch = arch ? `-${installerAssetArch(arch)}-` : "";
  const candidate = files.find((file) =>
    typeof file?.url === "string"
    && file.url.endsWith(extension)
    && (!assetArch || file.url.includes(assetArch))
    && typeof file.sha512 === "string"
    && file.sha512.trim(),
  );
  if (!candidate || typeof feedUrl !== "string" || !feedUrl) return null;
  let url;
  try {
    url = new URL(candidate.url, `${releaseAssetDirectory(feedUrl, info?.version)}/`);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" || loopbackDevFeedUrl(feedUrl) !== null;
  if (!secure || url.origin !== new URL(feedUrl).origin) return null;
  const size = Number(candidate.size);
  return {
    version: typeof info?.version === "string" ? info.version : null,
    url: url.toString(),
    sha512: candidate.sha512.trim(),
    size: Number.isInteger(size) && size > 0 ? size : null,
    fileName: path.basename(url.pathname),
  };
}

/** The DMG for this architecture (macOS builds that cannot replace themselves). */
export function selectManualInstallerArtifact(info, feedUrl, arch) {
  return selectReleaseAsset(info, feedUrl, { extension: ".dmg", arch });
}

async function fileMatchesSha512(filePath, expected) {
  return new Promise((resolve) => {
    const hash = createHash("sha512");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", () => resolve(false));
    stream.on("end", () => resolve(hash.digest("base64") === expected));
  });
}

// electron-updater wiring. Packaged-only; dev builds skip this so the
// updater doesn't try to probe a non-existent release channel.
export function preventPendingUpdaterInstall(updater) {
  if (updater) updater.autoInstallOnAppQuit = false;
}

export function registerUpdaterIpc({
  app,
  ipcMain,
  // Called before the updater quits or restarts the app (the turn guard lets it through).
  allowQuit = () => {},
  getMainWindow,
  loadAutoUpdater = () => import("electron-updater"),
  manifestChannel = "latest",
  alphaFeedUrl = null,
  shipItDefaultsDomain = SHIP_IT_DEFAULTS_DOMAIN,
  electronNet = null,
  shell = null,
  distribution = "public",
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  execPath = process.execPath,
  isDeveloperIdSigned = () => detectDeveloperIdSignature(execPath),
  quitDelayMs = 1500,
  // Bounds on the feed re-check that runs right before an install, and on the
  // whole quit-time refresh (check plus any newer download).
  installCheckTimeoutMs = 15_000,
  quitUpdateTimeoutMs = 120_000,
  // Quits anyway if the updater never quits the app after a quit-time install.
  quitInstallFallbackMs = 30_000,
  // Self-install (self-install.mjs): the running bundle or AppImage, and the
  // seams tests replace.
  getAppPath = () => app.getAppPath(),
  resourcesPath = process.resourcesPath,
  pid = process.pid,
  canReplace = canReplaceInPlace,
  stageMacUpdate = stageMacBundle,
  startMacSwap = launchMacSwap,
  installAppImage = replaceAppImage,
  relaunchAppImage = relaunchAppImageAfterExit,
  restartDelayMs = 300,
  // Re-arms the quit guard when an install that was let through did not start.
  restoreQuitGuard = () => {},
  // Electron's own autoUpdater: it emits before-quit-for-update once an
  // in-place install is accepted and the app starts closing.
  nativeUpdater = null,
  // How long an in-place install may take to start quitting the app (Squirrel
  // copies and verifies the whole bundle first) before the user is told.
  installStartTimeoutMs = 120_000,
  // macOS: Squirrel cannot update an app on a read-only volume (the DMG, App
  // Translocation); the user is offered a move to /Applications instead.
  showMessageBox = null,
  isReadOnlyVolume = isOnReadOnlyVolume,
  isInApplicationsFolder = () => (typeof app.isInApplicationsFolder === "function" ? app.isInApplicationsFolder() : true),
  moveToApplicationsFolder = () => app.moveToApplicationsFolder(),
}) {
  const quitApp = () => {
    allowQuit();
    app.quit();
  };
  const feedOptions = updaterFeedOptions({
    manifestChannel,
    alphaFeedUrl,
    devFeedUrl: env.OMNIRUSH_UPDATER_DEV_FEED_URL,
  });
  let autoUpdaterInstance = null;
  let autoUpdaterLoadPromise = null;
  let installModePromise = null;
  let checkedUpdateVersion = null;
  let checkedUpdateTargetVersion = null;
  let checkedUpdateChannel = null;
  let checkedInstallerArtifact = null;
  let downloadedInstallerPath = null;
  // mac-swap: the extracted, verified bundle waiting for the swap helper.
  let stagedMacBundle = null;
  // appimage: electron-updater's verified download of the new AppImage.
  let downloadedAppImagePath = null;
  // What the self-install modes replace, and the Linux package kind.
  let installTarget = null;
  let packageKind = null;
  let updateDownloaded = false;
  // The version and channel of the staged download. The feed can move past it
  // before it installs, so every install re-checks against the feed first.
  let downloadedUpdateVersion = null;
  let downloadedUpdateChannel = null;
  let installTriggered = false;
  let quitInstallInProgress = false;
  let recoveryReleases = [];
  const recoveryWitness = { installRequests: [], openedArtifactUrls: [], quitRequested: false };
  let updaterOperationQueue = Promise.resolve();

  function queueUpdaterOperation(operation) {
    const result = updaterOperationQueue.then(operation, operation);
    updaterOperationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function sendToRenderer(channel, data) {
    try {
      const win = typeof getMainWindow === "function" ? getMainWindow() : null;
      if (win?.webContents && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    } catch {
      // Window may be closed; swallow send failures.
    }
  }

  // "in-place": electron-updater swaps the app (Squirrel.Mac, NSIS).
  // "mac-swap": a macOS app without a Developer ID signature, which Squirrel
  //   refuses; the release zip is swapped in by self-install.mjs.
  // "appimage": the AppImage file is replaced and the app relaunched.
  // "package": a .deb/.rpm/.pacman install (or an AppImage in a folder this
  //   user cannot write); the package is downloaded and the user runs the
  //   install command the app shows.
  // "manual-dmg": a macOS app that cannot be replaced (App Translocation);
  //   the DMG is downloaded and opened.
  function resolveInstallMode() {
    if (!installModePromise) {
      installModePromise = (async () => {
        if (!app.isPackaged) return "in-place";
        if (platform === "darwin") {
          try {
            if (await isDeveloperIdSigned()) return "in-place";
          } catch {
            // An unknown signature is treated as ad hoc.
          }
          let bundle = null;
          try {
            bundle = macBundleFromPath(getAppPath()) ?? macAppBundlePath(execPath);
          } catch {
            bundle = macAppBundlePath(execPath);
          }
          if (!bundle || isTranslocatedBundle(bundle)) return "manual-dmg";
          installTarget = bundle;
          return "mac-swap";
        }
        if (platform === "linux") {
          const appImage = linuxAppImagePath(env);
          if (appImage) {
            installTarget = appImage;
            if (await canReplace(appImage)) return "appimage";
            packageKind = "appimage";
            return "package";
          }
          packageKind = await linuxPackageType(resourcesPath);
          return "package";
        }
        return "in-place";
      })();
    }
    return installModePromise;
  }

  /** What the renderer is told: every mode that restarts into the update is "in-place". */
  function publicInstallMode(mode) {
    return mode === "mac-swap" || mode === "appimage" ? "in-place" : mode;
  }

  async function describeInstall() {
    const mode = await resolveInstallMode();
    return {
      installMode: publicInstallMode(mode),
      ...(mode === "package" ? { packageKind } : {}),
    };
  }

  async function describeChannelState(channel, targetVersion = null) {
    return {
      ...updaterChannelState(app, channel, targetVersion, feedOptions),
      ...(await describeInstall()),
    };
  }

  function appDisplayName() {
    try {
      return (typeof app.getName === "function" && app.getName()) || "OmniRush.ai";
    } catch {
      return "OmniRush.ai";
    }
  }

  function runningMacBundle() {
    try {
      return macBundleFromPath(getAppPath()) ?? macAppBundlePath(execPath);
    } catch {
      return macAppBundlePath(execPath);
    }
  }

  /**
   * macOS: the running bundle when it sits where Squirrel.Mac cannot update
   * it (the mounted DMG, an App Translocation mount), else null.
   */
  async function macBundleBlockingUpdate() {
    if (platform !== "darwin" || !app.isPackaged) return null;
    const bundle = runningMacBundle();
    if (!bundle) return null;
    try {
      if (isInApplicationsFolder()) return null;
    } catch {
      // Unknown: judge by the location alone.
    }
    if (isTranslocatedBundle(bundle) || (await isReadOnlyVolume(bundle))) return bundle;
    return null;
  }

  function moveNeededReason() {
    const name = appDisplayName();
    return `${name} is running from the disk image or the Downloads folder, where it cannot update itself. Quit ${name}, drag it into Applications, open it from there and update again, or download the new version from the download page.`;
  }

  /**
   * Offers to move the app into /Applications. Electron copies it there,
   * quits this copy and reopens the moved one, which can then update.
   * OMNIRUSH_UPDATER_MOVE_ANSWER=move|cancel answers without the dialog
   * (unattended update rigs).
   */
  async function offerMoveToApplications({ atLaunch = false } = {}) {
    const name = appDisplayName();
    const preset = typeof env.OMNIRUSH_UPDATER_MOVE_ANSWER === "string" ? env.OMNIRUSH_UPDATER_MOVE_ANSWER.trim() : "";
    let move = false;
    if (preset === "move" || preset === "cancel") {
      move = preset === "move";
    } else if (typeof showMessageBox === "function") {
      try {
        const { response } = await showMessageBox({
          type: "info",
          message: atLaunch ? `Move ${name} to Applications?` : `Move ${name} to Applications to update`,
          detail: `${name} is running from the disk image or the Downloads folder, where it cannot update itself. Move it to Applications and it reopens from there${atLaunch ? "." : ". Then choose Restart to update again."}`,
          buttons: ["Move to Applications", atLaunch ? "Not Now" : "Cancel"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        move = response === 0;
      } catch {
        move = false;
      }
    }
    const notMoved = (detail = "") => ({
      ok: false,
      fallback: "move-to-applications",
      reason: `${detail}${moveNeededReason()}`,
    });
    if (!move) return notMoved();
    allowQuit();
    try {
      if (!moveToApplicationsFolder()) {
        restoreQuitGuard();
        return notMoved();
      }
    } catch (error) {
      restoreQuitGuard();
      return notMoved(`${name} could not be moved to Applications: ${String(error?.message ?? error)}. `);
    }
    // Electron quits by itself after the move; make sure this copy goes.
    setTimeout(() => quitApp(), restartDelayMs);
    return { ok: true, mode: "moving" };
  }

  function installFailureReason(error) {
    const message = String(error?.message ?? error ?? "unknown error").replace(/^Error:\s*/, "");
    if (/read-only volume/i.test(message)) return moveNeededReason();
    return `The update could not be installed: ${message}`;
  }

  /**
   * Starts an electron-updater install and resolves only once it is under
   * way (the app starts quitting) or has failed. Squirrel.Mac reports a
   * refused update (read-only volume, signature mismatch) through the
   * updater's error event after quitAndInstall returned; answering before
   * that left the renderer on "Restarting…" with nothing happening.
   */
  function startInPlaceInstall(updater) {
    return new Promise((resolve) => {
      const cleanups = [];
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        for (const cleanup of cleanups) {
          try {
            cleanup();
          } catch {
            // Already detached.
          }
        }
        resolve(result);
      };
      const listen = (emitter, name, handler) => {
        if (typeof emitter?.on !== "function") return;
        emitter.on(name, handler);
        const off = emitter.removeListener ?? emitter.off;
        if (typeof off === "function") cleanups.push(() => off.call(emitter, name, handler));
      };
      const started = () => settle({ ok: true, mode: "in-place" });
      listen(updater, "error", (error) => settle({ ok: false, reason: installFailureReason(error) }));
      listen(app, "before-quit", started);
      listen(nativeUpdater, "before-quit-for-update", started);
      const timer = setTimeout(() => settle({
        ok: false,
        reason: `The update did not start within ${Math.round(installStartTimeoutMs / 1000)} seconds. Quit ${appDisplayName()} and open it again to finish the update, or download the new version from the download page.`,
      }), installStartTimeoutMs);
      cleanups.push(() => clearTimeout(timer));
      try {
        updater.quitAndInstall(false, true);
      } catch (error) {
        settle({ ok: false, reason: installFailureReason(error) });
      }
    });
  }

  /** The file a self-install mode downloads itself, from the manifest just read. */
  function selfInstallAsset(info, feedUrl, installMode) {
    switch (installMode) {
      case "manual-dmg":
        return selectManualInstallerArtifact(info, feedUrl, arch);
      case "mac-swap":
        return selectReleaseAsset(info, feedUrl, { extension: ".zip", arch });
      case "package": {
        const extension = packageExtension(packageKind);
        return extension ? selectReleaseAsset(info, feedUrl, { extension }) : null;
      }
      default:
        return null;
    }
  }

  function clearDownloadedUpdate() {
    updateDownloaded = false;
    downloadedInstallerPath = null;
    downloadedAppImagePath = null;
    if (stagedMacBundle) {
      void rm(path.dirname(stagedMacBundle), { recursive: true, force: true }).catch(() => undefined);
      stagedMacBundle = null;
    }
    downloadedUpdateVersion = null;
    downloadedUpdateChannel = null;
  }

  function clearCheckedUpdate() {
    checkedUpdateVersion = null;
    checkedUpdateTargetVersion = null;
    checkedUpdateChannel = null;
    checkedInstallerArtifact = null;
  }

  function recordCheckedUpdate(info, channelState, targetVersion, installMode) {
    const currentVersion = resolveAppVersion(app);
    const available = Boolean(info?.version && isVersionNewer(info.version, currentVersion));
    checkedUpdateVersion = available ? info.version : null;
    checkedUpdateTargetVersion = available ? targetVersion : null;
    checkedUpdateChannel = available ? channelState.channel : null;
    checkedInstallerArtifact = available ? selfInstallAsset(info, channelState.feedUrl, installMode) : null;
    return available;
  }

  async function ensureAutoUpdater() {
    if (!app.isPackaged) return null;
    if (!autoUpdaterLoadPromise) {
      autoUpdaterLoadPromise = (async () => {
        try {
          const mod = await loadAutoUpdater();
          autoUpdaterInstance = mod.autoUpdater ?? mod.default?.autoUpdater ?? null;
          if (autoUpdaterInstance) {
            autoUpdaterInstance.autoDownload = false;
            // Nothing installs behind the updater's back: electron-updater's own
            // quit hook (and Squirrel.Mac, which stages at download time when
            // this is true) would install whatever was downloaded first, even
            // after a newer release was published. Quit and restart both go
            // through ensureNewestDownloaded(), which re-checks the feed first.
            autoUpdaterInstance.autoInstallOnAppQuit = false;
            // Differential (blockmap) downloads reconstruct the update zip from the
            // installed app + a diff. On macOS that reconstructed bundle is what
            // feeds Squirrel's fragile move-based install, and is a common trigger
            // for the "Failed to copy bundle … no such file" abort. Download the
            // full zip instead — alpha builds are swapped wholesale anyway.
            autoUpdaterInstance.disableDifferentialDownload = true;
            // Make Squirrel.Mac write contents in place rather than moving whole
            // bundles (see enableSquirrelDirectContentsWrite for why).
            await enableSquirrelDirectContentsWrite(shipItDefaultsDomain);
            autoUpdaterInstance.on("error", (err) => {
              // Do not invalidate a staged download on arbitrary updater errors.
              // A later transient check failure does not delete the downloaded
              // update; quitAndInstall reports a descriptive failure if it is gone.
              console.warn("[updater] error", err);
              // A failed quit-time install must not leave the app running.
              if (quitInstallInProgress) quitApp();
            });
            autoUpdaterInstance.on("update-downloaded", (info) => {
              updateDownloaded = true;
              if (typeof info?.version === "string") downloadedUpdateVersion = info.version;
              if (typeof info?.downloadedFile === "string") downloadedAppImagePath = info.downloadedFile;
            });
            // Forward download progress to the renderer so the UI can show
            // incremental bytes instead of staying stuck at 0.
            autoUpdaterInstance.on("download-progress", (info) => {
              sendToRenderer("omnirush:updater:download-progress", {
                bytesPerSecond: info.bytesPerSecond ?? 0,
                percent: info.percent ?? 0,
                transferred: info.transferred ?? 0,
                total: info.total ?? 0,
                delta: info.delta ?? 0,
              });
            });
            await applyElectronUpdaterFeed(app, autoUpdaterInstance, null, feedOptions);
          }
        } catch (error) {
          console.warn("[updater] electron-updater not available", error);
          autoUpdaterInstance = null;
        }
        return autoUpdaterInstance;
      })();
    }
    return autoUpdaterLoadPromise;
  }

  /**
   * Downloads the manifest-listed installer with a streaming sha512 check and
   * the same progress events electron-updater emits, so the Updates page shows
   * one download experience regardless of install mode.
   */
  async function downloadManualInstaller(artifact, { directory = null } = {}) {
    if (!electronNet?.fetch) throw new Error("Installer downloads are unavailable in this package.");
    // The cache folder is ours to empty; a user folder (Downloads) is not.
    const target = directory ?? path.join(app.getPath("userData"), INSTALLER_CACHE_DIRECTORY);
    const destination = path.join(target, artifact.fileName);
    if (directory && (await fileMatchesSha512(destination, artifact.sha512))) return destination;
    const response = await electronNet.fetch(artifact.url, {
      headers: { Accept: "application/octet-stream, */*" },
    });
    if (!response.ok) throw new Error(`Installer download failed with HTTP ${response.status}.`);
    if (!directory) await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    const partialPath = `${destination}.part`;
    const headerLength = Number(response.headers?.get?.("content-length"));
    const total = artifact.size ?? (Number.isInteger(headerLength) && headerLength > 0 ? headerLength : 0);
    const hash = createHash("sha512");
    const startedAt = Date.now();
    let transferred = 0;
    const reportProgress = (delta) => {
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      sendToRenderer("omnirush:updater:download-progress", {
        bytesPerSecond: Math.round(transferred / elapsedSeconds),
        percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
        transferred,
        total,
        delta,
      });
    };
    const handle = await open(partialPath, "w");
    try {
      const reader = typeof response.body?.getReader === "function" ? response.body.getReader() : null;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          hash.update(chunk);
          await handle.write(chunk);
          transferred += chunk.length;
          reportProgress(chunk.length);
        }
      } else {
        const bytes = Buffer.from(await response.arrayBuffer());
        hash.update(bytes);
        await handle.write(bytes);
        transferred = bytes.length;
        reportProgress(bytes.length);
      }
    } finally {
      await handle.close();
    }
    if (hash.digest("base64") !== artifact.sha512) {
      await rm(partialPath, { force: true });
      throw new Error("The downloaded installer checksum did not match the release manifest.");
    }
    if (artifact.size !== null && transferred !== artifact.size) {
      await rm(partialPath, { force: true });
      throw new Error("The downloaded installer size did not match the release manifest.");
    }
    await rename(partialPath, destination);
    return destination;
  }

  async function resolveRecoveryArtifact(version) {
    if (!electronNet?.fetch) return null;
    try {
      const manifestUrl = `https://github.com/omnirush-ai/omnirush-gui/releases/download/v${version}/${recoveryManifestName(platform, arch, distribution)}`;
      const response = await electronNet.fetch(manifestUrl, { headers: { Accept: "text/yaml, text/plain, */*" } });
      if (!response.ok) return null;
      return selectRecoveryArtifact(parseRecoveryManifest(await response.text()), {
        version,
        platform,
        arch,
        distribution,
      });
    } catch {
      return null;
    }
  }

  async function cacheCurrentHealthyRelease() {
    if (!electronNet?.fetch) return null;
    const currentVersion = stableVersion(resolveAppVersion(app));
    if (!currentVersion) return null;
    const state = await readRecoveryState(app, distribution);
    if (state.currentVersion !== currentVersion) return null;
    const existing = await readCachedRecoveryArtifact(app, { platform, arch, distribution });
    if (existing?.artifact.version === currentVersion) return existing;
    const artifact = await resolveRecoveryArtifact(currentVersion);
    if (!artifact) return null;
    const filePath = await cacheVerifiedRecoveryArtifact({
      app,
      artifact,
      fetchArtifact: (url) => electronNet.fetch(url),
    });
    return { artifact, filePath };
  }

  function evalRecoveryReleases() {
    if (typeof env.OMNIRUSH_EVAL_RECOVERY_RELEASES === "string") {
      try {
        const target = String(env.OMNIRUSH_EVAL_RECOVERY_TARGET ?? "").split("-");
        const targetPlatform = target[0];
        const targetArch = target[1];
        const targetDistribution = target.slice(2).join("-");
        const raw = JSON.parse(env.OMNIRUSH_EVAL_RECOVERY_RELEASES);
        const stable = Array.isArray(raw) ? raw.filter((release) =>
          stableVersion(release?.version)
          && release?.channel === "stable"
          && release?.artifact?.platform === targetPlatform
          && release?.artifact?.arch === targetArch
          && release?.artifact?.distribution === targetDistribution
          && typeof release?.artifact?.url === "string",
        ) : [];
        return stable.map((release, index) => ({
          id: release.version,
          version: release.version,
          marking: index === 0 ? "current" : index === 1 ? "previous" : null,
          artifact: release.artifact,
          cachedFilePath: null,
          eval: true,
        }));
      } catch {
        return [];
      }
    }
    if (typeof env.OMNIRUSH_EVAL_RECOVERY_CANDIDATES === "string") {
      try {
        const raw = JSON.parse(env.OMNIRUSH_EVAL_RECOVERY_CANDIDATES);
        return Array.isArray(raw) ? raw.filter((candidate) =>
          candidate?.verified === true
          && stableVersion(candidate?.version)
          && typeof candidate?.artifactUrl === "string",
        ).map((candidate) => ({
          id: candidate.version,
          version: candidate.version,
          marking: "previous",
          artifact: { platform, arch, distribution, url: candidate.artifactUrl },
          cachedFilePath: null,
          eval: true,
        })) : [];
      } catch {
        return [];
      }
    }
    return null;
  }

  ipcMain.handle("omnirush:recovery:recordHealthy", async () => {
    if (!app.isPackaged) return null;
    return recordHealthyVersion(app, distribution, resolveAppVersion(app));
  });

  ipcMain.handle("omnirush:recovery:list", async (_event, policy = {}) => {
    const evalReleases = evalRecoveryReleases();
    if (evalReleases) {
      recoveryReleases = evalReleases;
      return {
        ok: true,
        releases: recoveryReleases.map(({ id, version, marking }) => ({ id, version, marking })),
      };
    }
    const state = await readRecoveryState(app, distribution);
    const installedVersion = resolveAppVersion(app);
    const markers = recoveryVersionMarkers(installedVersion, state);
    const cached = await readCachedRecoveryArtifact(app, { platform, arch, distribution });
    const catalogVersions = Array.isArray(policy?.versions) ? policy.versions : [];
    const localOnly = catalogVersions.length === 0;
    recoveryReleases = await compatibleRecoveryReleases({
      versions: [
        ...catalogVersions,
        installedVersion,
        ...(state.currentVersion ? [state.currentVersion] : []),
        ...(state.previousVersion ? [state.previousVersion] : []),
        ...(cached ? [cached.artifact.version] : []),
      ],
      currentVersion: markers.currentVersion,
      previousVersion: markers.previousVersion,
      minimumVersion: policy?.minimumVersion,
      allowedVersions: policy?.allowedVersions,
      resolveArtifact: async (version) =>
        cached?.artifact.version === version
          ? { ...cached.artifact, cachedFilePath: cached.filePath }
          : localOnly ? null : resolveRecoveryArtifact(version),
    });
    return {
      ok: true,
      releases: recoveryReleases.map(({ id, version, marking }) => ({ id, version, marking })),
    };
  });

  async function useRecoveryRelease(rawId) {
    const id = stableVersion(rawId);
    const release = id ? recoveryReleases.find((candidate) => candidate.id === id) : null;
    if (!release) return { ok: false, reason: "That recovery version is no longer available. Retry the release list." };
    if (release.eval) {
      if (env.OMNIRUSH_EVAL_RECOVERY_CANDIDATES) {
        recoveryWitness.installRequests.push({ version: release.version, artifactUrl: release.artifact.url });
      } else {
        recoveryWitness.openedArtifactUrls.push(release.artifact.url);
      }
      return { ok: true, action: "eval" };
    }
    if (compareStableVersions(release.version, resolveAppVersion(app)) === 0) {
      return { ok: false, reason: "That version is already installed." };
    }
    if (release.cachedFilePath) {
      if (!(await verifyCachedRecoveryArtifact(release.cachedFilePath, release.artifact))) {
        return { ok: false, reason: "The cached recovery installer could not be verified. Retry while online." };
      }
      if (!shell?.openPath) return { ok: false, reason: "This package cannot open the recovery installer." };
      const openError = await shell.openPath(release.cachedFilePath);
      if (openError) return { ok: false, reason: openError };
      return {
        ok: true,
        action: "installer",
        message: "The verified installer is open. Follow the operating system steps to finish.",
      };
    }
    const freshArtifact = await resolveRecoveryArtifact(release.version);
    if (!freshArtifact || freshArtifact.url !== release.artifact.url || freshArtifact.sha512 !== release.artifact.sha512) {
      return { ok: false, reason: "This installer could not be verified. Refresh the list and try again." };
    }
    const currentVersion = resolveAppVersion(app);
    const updater = await ensureAutoUpdater();
    // An ad-hoc signed macOS app cannot be swapped by Squirrel, so recovery
    // there opens the verified installer exactly like a manual update.
    const recoveryMode = await resolveInstallMode();
    if (updater && app.isPackaged && (recoveryMode === "in-place" || recoveryMode === "appimage")) {
      try {
        await applyElectronUpdaterFeed(app, updater, release.version, feedOptions, true);
        const result = await updater.checkForUpdates();
        if (compareVersions(result?.updateInfo?.version ?? "", release.version) !== 0) {
          throw new Error("Recovery manifest resolved to a different version.");
        }
        if (compareStableVersions(release.version, currentVersion) === null) {
          throw new Error("Installed version could not be validated.");
        }
        updater.autoInstallOnAppQuit = true;
        await updater.downloadUpdate();
        installTriggered = true;
        allowQuit();
        updater.quitAndInstall(false, true);
        return { ok: true, action: "install" };
      } catch (error) {
        preventPendingUpdaterInstall(updater);
        return { ok: false, reason: String(error?.message ?? error) };
      }
    }
    if (!electronNet?.fetch || !shell?.openPath) return { ok: false, reason: "Automatic recovery is unavailable on this package." };
    try {
      const filePath = await cacheVerifiedRecoveryArtifact({
        app,
        artifact: freshArtifact,
        fetchArtifact: (url) => electronNet.fetch(url),
      });
      if (!(await verifyCachedRecoveryArtifact(filePath, freshArtifact))) {
        return { ok: false, reason: "The downloaded recovery installer could not be verified." };
      }
      const openError = await shell.openPath(filePath);
      if (openError) return { ok: false, reason: openError };
      return { ok: true, action: "installer", message: "The verified installer is open. Follow the operating system steps to finish." };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  ipcMain.handle("omnirush:recovery:use", async (_event, id) =>
    queueUpdaterOperation(() => useRecoveryRelease(id)));
  ipcMain.handle("omnirush:recovery:restorePrevious", async () => {
    return queueUpdaterOperation(() => {
      const previous = recoveryReleases.find((release) => release.marking === "previous");
      return previous ? useRecoveryRelease(previous.id) : { ok: false, reason: "No verified previous version is available." };
    });
  });
  ipcMain.handle("omnirush:recovery:evalSnapshot", async () => ({
    candidates: recoveryReleases,
    releases: recoveryReleases,
    ...recoveryWitness,
  }));

  ipcMain.handle("omnirush:updater:getChannel", async () => queueUpdaterOperation(async () => {
    const channel = await readElectronUpdaterChannel(app, feedOptions);
    return describeChannelState(channel);
  }));

  ipcMain.handle("omnirush:updater:setChannel", async (_event, rawChannel) => queueUpdaterOperation(async () => {
    const channel = await writeElectronUpdaterChannel(app, rawChannel, feedOptions);
    clearCheckedUpdate();
    clearDownloadedUpdate();
    const installMode = await resolveInstallMode();
    const updater = await ensureAutoUpdater();
    if (updater) {
      // A channel change invalidates any previously downloaded update. This
      // also prevents an Alpha build from installing automatically on quit
      // after an organization policy moves the desktop back to Stable.
      preventPendingUpdaterInstall(updater);
      const state = await applyElectronUpdaterFeed(app, updater, null, feedOptions, false, channel);
      return { ...state, ...(await describeInstall()) };
    }
    return describeChannelState(channel);
  }));

  ipcMain.handle("omnirush:updater:check", async (_event, rawChannel, rawTargetVersion) => queueUpdaterOperation(async () => {
    // A check selects a feed for this operation only. The persisted preference
    // belongs exclusively to setChannel so a stale check cannot undo a choice.
    const channel = rawChannel === undefined
      ? await readElectronUpdaterChannel(app, feedOptions)
      : normalizeElectronUpdaterChannel(rawChannel, feedOptions);
    const installMode = await resolveInstallMode();
    const updater = await ensureAutoUpdater();
    try {
      const targetVersion = rawTargetVersion === undefined
        ? null
        : normalizeStableTargetVersion(rawTargetVersion);
      if (rawTargetVersion !== undefined && !targetVersion) {
        throw new Error("Target update version must use the stable x.y.z format.");
      }
      const channelState = updater
        ? { ...(await applyElectronUpdaterFeed(app, updater, targetVersion, feedOptions, false, channel)), ...(await describeInstall()) }
        : await describeChannelState(channel, targetVersion);
      if (!updater) return { available: false, reason: "unavailable", ...channelState };

      const result = await updater.checkForUpdates();
      const info = result?.updateInfo ?? null;
      const currentVersion = resolveAppVersion(app);
      if (targetVersion && compareVersions(info?.version ?? "", targetVersion) !== 0) {
        throw new Error(`Target update manifest did not resolve to v${targetVersion}.`);
      }
      const available = recordCheckedUpdate(info, channelState, targetVersion, installMode);
      if (!available) clearDownloadedUpdate();
      return {
        available,
        currentVersion,
        latestVersion: targetVersion ?? info?.version ?? null,
        releaseDate: info?.releaseDate ?? null,
        releaseNotes: info?.releaseNotes ?? null,
        ...channelState,
      };
    } catch (error) {
      clearCheckedUpdate();
      // A transient failed check must not invalidate an already-downloaded update.
      return {
        available: false,
        reason: String(error?.message ?? error),
        ...await describeChannelState(channel),
      };
    }
  }));

  ipcMain.handle("omnirush:updater:download", async () => queueUpdaterOperation(async () => {
    const updater = await ensureAutoUpdater();
    if (!updater) return { ok: false, reason: "unavailable" };
    const installMode = await resolveInstallMode();
    try {
      const channelState = await applyElectronUpdaterFeed(
        app,
        updater,
        checkedUpdateTargetVersion,
        feedOptions,
        false,
        checkedUpdateChannel ?? undefined,
      );
      const currentVersion = resolveAppVersion(app);
      if (!checkedUpdateVersion || !isVersionNewer(checkedUpdateVersion, currentVersion)) {
        const result = await updater.checkForUpdates();
        const info = result?.updateInfo ?? null;
        if (
          checkedUpdateTargetVersion &&
          compareVersions(info?.version ?? "", checkedUpdateTargetVersion) !== 0
        ) {
          throw new Error(`Target update manifest did not resolve to v${checkedUpdateTargetVersion}.`);
        }
        recordCheckedUpdate(info, channelState, checkedUpdateTargetVersion, installMode);
      }
      if (!checkedUpdateVersion) {
        return { ok: false, reason: "No update available." };
      }
      await cacheCurrentHealthyRelease().catch((error) => {
        console.warn("[updater] could not cache the current healthy installer", error);
      });
      await downloadCheckedUpdate(updater, installMode);
      return { ok: true, mode: publicInstallMode(installMode), ...downloadedPackageDetails(installMode) };
    } catch (error) {
      clearDownloadedUpdate();
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }));

  /** Downloads; ~/Downloads where the desktop names no download folder (Electron then answers home). */
  async function packageDownloadDirectory() {
    const downloads = app.getPath("downloads");
    if (downloads !== app.getPath("home")) return downloads;
    const fallback = path.join(downloads, "Downloads");
    return (await fileExists(fallback)) ? fallback : downloads;
  }

  /** The downloaded package and its install command (package mode only). */
  function downloadedPackageDetails(installMode) {
    if (installMode !== "package") return {};
    return {
      packageKind,
      path: downloadedInstallerPath,
      command: downloadedInstallerPath
        ? linuxInstallCommand(packageKind, downloadedInstallerPath, packageKind === "appimage" ? installTarget : null)
        : null,
    };
  }

  /** Downloads the version the last successful check recorded. */
  async function downloadCheckedUpdate(updater, installMode) {
    const version = checkedUpdateVersion;
    if (installMode === "manual-dmg" || installMode === "mac-swap" || installMode === "package") {
      // Squirrel.Mac refuses an ad-hoc signed app and a package manager owns
      // a .deb/.rpm/.pacman install, so the file the manifest lists is
      // fetched directly: plain HTTPS plus the manifest's sha512.
      if (!checkedInstallerArtifact || checkedInstallerArtifact.version !== version) {
        throw new Error(installMode === "package"
          ? "The release manifest does not list a package for this installation."
          : "The release manifest does not list a macOS installer for this update.");
      }
      if (installMode === "package") {
        downloadedInstallerPath = await downloadManualInstaller(checkedInstallerArtifact, {
          directory: await packageDownloadDirectory(),
        });
      } else {
        downloadedInstallerPath = await downloadManualInstaller(checkedInstallerArtifact);
      }
      if (installMode === "mac-swap") {
        if (stagedMacBundle) {
          await rm(path.dirname(stagedMacBundle), { recursive: true, force: true }).catch(() => undefined);
          stagedMacBundle = null;
        }
        // Extracted next to nothing it could clobber; verified to be this
        // app at the expected version before the restart button appears.
        const staged = await stageMacUpdate({
          zipPath: downloadedInstallerPath,
          version,
          currentBundle: installTarget,
        });
        stagedMacBundle = staged.bundle;
        await rm(downloadedInstallerPath, { force: true }).catch(() => undefined);
      }
    } else {
      // Clear any stuck ShipIt state from a prior aborted install so this
      // download applies cleanly.
      await cleanStaleUpdaterState(app, shipItDefaultsDomain);
      preventPendingUpdaterInstall(updater);
      await updater.downloadUpdate();
    }
    updateDownloaded = true;
    downloadedUpdateVersion = version;
    downloadedUpdateChannel = checkedUpdateChannel;
  }

  /**
   * Re-reads the feed right before an install. A staged download can be
   * several releases behind the feed (it was fetched at launch, the app stayed
   * open while more releases shipped), and installing it would only make the
   * next launch find the next release. When the feed has moved on, the newest
   * release is downloaded now so a single restart lands on it.
   *
   * Resolves { ok: true } when the staged download is the version to install.
   * An unreachable feed keeps the staged download: it is the newest release
   * this app knows of. A newer release that cannot be downloaded never falls
   * back to the stale one.
   */
  async function ensureNewestDownloaded(updater, installMode) {
    // A Den-selected target is the exact version the organization allows.
    if (checkedUpdateTargetVersion) return { ok: true };
    let info;
    let channelState;
    try {
      channelState = {
        ...(await applyElectronUpdaterFeed(
          app,
          updater,
          null,
          feedOptions,
          false,
          downloadedUpdateChannel ?? undefined,
        )),
        installMode,
      };
      const result = await withTimeout(updater.checkForUpdates(), installCheckTimeoutMs, "The update check");
      info = result?.updateInfo ?? null;
    } catch (error) {
      console.warn("[updater] pre-install check failed; installing the staged update", error?.message ?? error);
      return { ok: true };
    }
    if (!info?.version || !isVersionNewer(info.version, resolveAppVersion(app))) {
      // The feed no longer offers an update (the release was pulled).
      clearCheckedUpdate();
      clearDownloadedUpdate();
      return { ok: false, reason: "update-not-downloaded" };
    }
    if (downloadedUpdateVersion && compareVersions(info.version, downloadedUpdateVersion) === 0) {
      return { ok: true };
    }
    console.info(`[updater] feed moved from v${downloadedUpdateVersion ?? "?"} to v${info.version}; downloading it before install`);
    recordCheckedUpdate(info, channelState, null, installMode);
    try {
      await downloadCheckedUpdate(updater, installMode);
      return { ok: true };
    } catch (error) {
      clearDownloadedUpdate();
      return {
        ok: false,
        reason: `Version ${info.version} is available but could not be downloaded: ${String(error?.message ?? error)}`,
      };
    }
  }

  /**
   * Called from the app's before-quit teardown. Re-checks the feed while
   * services stop and resolves to a function that installs the newest release
   * and quits, or to null when nothing should install (no staged download, a
   * restart already installed it, or a newer release could not be fetched in
   * time: the stale download is then skipped and the next launch updates).
   * Never rejects.
   */
  async function prepareInstallOnQuit() {
    try {
      const updater = autoUpdaterInstance;
      if (!updater || !updateDownloaded || installTriggered) return null;
      const installMode = await resolveInstallMode();
      if (installMode !== "in-place" && installMode !== "appimage" && installMode !== "mac-swap") return null;
      // Quitting never asks for a password: an /Applications this user cannot
      // write waits for "Restart to update".
      if (installMode === "mac-swap" && !(await canReplace(installTarget))) return null;
      // Squirrel would refuse it (DMG, App Translocation); the next launch asks to move.
      if (installMode === "in-place" && (await macBundleBlockingUpdate())) return null;
      const newest = await withTimeout(
        queueUpdaterOperation(() => ensureNewestDownloaded(updater, installMode)),
        quitUpdateTimeoutMs,
        "The quit-time update refresh",
      );
      if (!newest.ok || !updateDownloaded || installTriggered) return null;
      if (installMode === "appimage" || installMode === "mac-swap") {
        return () => {
          installTriggered = true;
          void selfInstall(installMode, { relaunch: false })
            .catch((error) => console.warn("[updater] install on quit failed", error?.message ?? error))
            .finally(() => quitApp());
        };
      }
      return () => {
        installTriggered = true;
        quitInstallInProgress = true;
        // Quit means quit: install silently without relaunching.
        updater.autoRunAppAfterInstall = false;
        setTimeout(() => quitApp(), quitInstallFallbackMs);
        try {
          allowQuit();
          updater.quitAndInstall(true, false);
        } catch (error) {
          console.warn("[updater] install on quit failed", error?.message ?? error);
          quitApp();
        }
      };
    } catch (error) {
      console.warn("[updater] could not prepare the update for quit", error?.message ?? error);
      return null;
    }
  }

  /**
   * mac-swap and appimage installs. Starts the swap (or replaces the
   * AppImage) and, with `relaunch`, arranges for the new version to open
   * once this process exits. Throws when nothing was changed.
   */
  async function selfInstall(installMode, { relaunch }) {
    if (installMode === "mac-swap") {
      if (!stagedMacBundle || !(await fileExists(stagedMacBundle))) throw new Error("update-not-downloaded");
      const writable = await canReplace(installTarget);
      await startMacSwap({
        stagedBundle: stagedMacBundle,
        targetBundle: installTarget,
        pid,
        relaunch,
        writable,
        logPath: path.join(app.getPath("logs"), "update-install.log"),
      });
      // The helper owns the staged bundle now.
      stagedMacBundle = null;
      return;
    }
    const source = downloadedAppImagePath ?? autoUpdaterInstance?.installerPath ?? null;
    if (!source || !(await fileExists(source))) throw new Error("update-not-downloaded");
    await installAppImage({ source, target: installTarget });
    downloadedAppImagePath = null;
    if (relaunch) {
      // Started outside the AppImage and only once this process has exited,
      // so the new copy never meets this instance's single-instance lock.
      relaunchAppImage({
        appImage: installTarget,
        pid,
        args: process.argv.slice(1),
        env,
        logPath: path.join(app.getPath("logs"), "update-install.log"),
      });
    }
  }

  // Package installs: show the downloaded package (the path is the one this
  // process downloaded, never one the renderer names).
  ipcMain.handle("omnirush:updater:showDownloaded", async () => {
    if (!downloadedInstallerPath || !shell?.showItemInFolder) return { ok: false };
    shell.showItemInFolder(downloadedInstallerPath);
    return { ok: true };
  });

  ipcMain.handle("omnirush:updater:installAndRestart", async () => queueUpdaterOperation(async () => {
    if (!updateDownloaded) return { ok: false, reason: "update-not-downloaded" };
    const updater = await ensureAutoUpdater();
    if (!updater) return { ok: false, reason: "unavailable" };
    const installMode = await resolveInstallMode();
    const newest = await ensureNewestDownloaded(updater, installMode);
    if (!newest.ok) return newest;
    if (installMode === "package") {
      // Nothing to restart into: the package manager installs it.
      return { ok: true, mode: "package", ...downloadedPackageDetails(installMode) };
    }
    if (installMode === "mac-swap" || installMode === "appimage") {
      try {
        await selfInstall(installMode, { relaunch: true });
      } catch (error) {
        const message = String(error?.message ?? error);
        if (message === "update-not-downloaded") {
          clearDownloadedUpdate();
          return { ok: false, reason: "update-not-downloaded" };
        }
        if (installMode === "mac-swap") {
          // Only here does the app send the user to the download page.
          return {
            ok: false,
            fallback: "download-page",
            reason: isAuthorizationCancelled(error)
              ? `Updating needs an administrator to replace ${path.basename(installTarget ?? "the app")} in ${path.dirname(installTarget ?? "/Applications")}, and the request was cancelled. Download the new version and drag it into that folder instead.`
              : `The update could not replace ${path.basename(installTarget ?? "the app")}: ${message}. Download the new version and drag it into ${path.dirname(installTarget ?? "/Applications")} instead.`,
          };
        }
        return { ok: false, reason: `The update could not replace the AppImage: ${message}` };
      }
      installTriggered = true;
      // Let the renderer show "Restarting…" before the window goes away.
      setTimeout(() => quitApp(), restartDelayMs);
      return { ok: true, mode: "in-place" };
    }
    if (installMode === "manual-dmg") {
      if (!downloadedInstallerPath || !checkedInstallerArtifact) {
        return { ok: false, reason: "update-not-downloaded" };
      }
      if (!shell?.openPath) return { ok: false, reason: "This package cannot open the downloaded installer." };
      try {
        if (!(await fileMatchesSha512(downloadedInstallerPath, checkedInstallerArtifact.sha512))) {
          clearDownloadedUpdate();
          return { ok: false, reason: "The downloaded installer could not be verified. Download it again." };
        }
        const openError = await shell.openPath(downloadedInstallerPath);
        if (openError) return { ok: false, reason: openError };
        // Let the renderer show its instructions and Finder mount the image
        // before this copy quits; the user replaces it from the DMG.
        setTimeout(() => quitApp(), quitDelayMs);
        return { ok: true, mode: "manual-dmg", path: downloadedInstallerPath };
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error) };
      }
    }
    if (await macBundleBlockingUpdate()) return offerMoveToApplications();
    // Re-assert the in-place-write default right before the swap; the ShipIt
    // defaults domain may have been wiped when stale state was cleaned.
    await enableSquirrelDirectContentsWrite(shipItDefaultsDomain);
    installTriggered = true;
    // An update install is never held up by the running-turn question.
    allowQuit();
    const started = await startInPlaceInstall(updater);
    if (!started.ok) {
      installTriggered = false;
      restoreQuitGuard();
      console.warn("[updater] install did not start", started.reason);
    }
    return started;
  }));

  /**
   * At launch (macOS): an app that runs from the DMG or a translocated copy
   * can never update itself, so offer the move to /Applications right away.
   */
  async function offerMoveAtLaunch() {
    try {
      if (!(await macBundleBlockingUpdate())) return { offered: false };
      return { offered: true, ...(await offerMoveToApplications({ atLaunch: true })) };
    } catch (error) {
      console.warn("[updater] move check failed", error?.message ?? error);
      return { offered: false };
    }
  }

  return { ensureAutoUpdater, prepareInstallOnQuit, offerMoveAtLaunch };
}
