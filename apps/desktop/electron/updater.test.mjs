import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  detectDeveloperIdSignature,
  loopbackDevFeedUrl,
  developerIdSignatureFromCodesignOutput,
  electronUpdaterFeedUrl,
  macAppBundlePath,
  normalizeElectronUpdaterChannel,
  preventPendingUpdaterInstall,
  registerUpdaterIpc,
  selectManualInstallerArtifact,
  staleUpdaterStatePaths,
  targetedStableUpdaterFeed,
  updaterFeedOptions,
} from "./updater.mjs";
import {
  cacheVerifiedRecoveryArtifact,
  compatibleRecoveryReleases,
  parseRecoveryManifest,
  readCachedRecoveryArtifact,
  readRecoveryState,
  recordHealthyVersion,
  recoveryManifestName,
  recoveryVersionMarkers,
  selectRecoveryArtifact,
} from "./recovery.mjs";

const fakeApp = { getPath: (key) => (key === "home" ? "/Users/test" : `/Users/test/${key}`) };
const STABLE_FEED = "https://github.com/omnirush-ai/omnirush-gui/releases/latest/download";
const ALPHA_FEED = "https://updates.example.com/alpha";

// Unpackaged builds resolve their version from package.json, so release bumps
// must not require touching this test.
const desktopVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

let isolatedUpdaterImportId = 0;

function fakeUpdaterHarness({ version, files }) {
  // Several listeners per event, like an EventEmitter; `listeners.get(name)`
  // fires them all (undefined while none is registered).
  const registered = new Map();
  const listeners = {
    get: (name) => (registered.get(name)?.size
      ? (...args) => { for (const fn of [...registered.get(name)]) fn(...args); }
      : undefined),
  };
  // The app's own events: a real install quits the app (before-quit).
  const appEvents = new EventEmitter();
  const calls = [];
  const feeds = [];
  const downloadFeeds = [];
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    disableDifferentialDownload: false,
    allowPrerelease: false,
    allowDowngrade: false,
    on: (name, fn) => {
      if (!registered.has(name)) registered.set(name, new Set());
      registered.get(name).add(fn);
    },
    removeListener: (name, fn) => registered.get(name)?.delete(fn),
    setFeedURL: (feed) => feeds.push(feed),
    checkForUpdates: async () => ({ updateInfo: { version, ...(files ? { files } : {}) } }),
    downloadUpdate: async () => {
      calls.push("download");
      downloadFeeds.push(feeds.at(-1));
    },
    quitAndInstall: () => {
      calls.push("quitAndInstall");
      appEvents.emit("before-quit");
    },
  };
  return { updater, listeners, appEvents, calls, feeds, downloadFeeds };
}

async function registerFakeUpdaterIpc({ version, files = undefined, ...options }) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "omnirush-updater-test-"));
  const handlers = new Map();
  const harness = fakeUpdaterHarness({ version, files });
  const sent = [];
  isolatedUpdaterImportId += 1;
  const updaterModuleUrl = new URL(
    `./updater.mjs?updater-lifecycle=${isolatedUpdaterImportId}`,
    import.meta.url,
  );
  const { registerUpdaterIpc: registerIsolatedUpdaterIpc } = await import(
    updaterModuleUrl.href
  );
  const app = {
    isPackaged: true,
    getVersion: () => "0.17.0",
    getPath: (key) => path.join(tempDir, key),
    quit: () => harness.calls.push("quit"),
    on: (name, fn) => harness.appEvents.on(name, fn),
    removeListener: (name, fn) => harness.appEvents.removeListener(name, fn),
  };
  const registered = registerIsolatedUpdaterIpc({
    app,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getMainWindow: () => ({
      webContents: { send: (channel, data) => sent.push({ channel, data }) },
      isDestroyed: () => false,
    }),
    loadAutoUpdater: async () => ({ autoUpdater: harness.updater }),
    // The default harness models a Developer ID signed app (or Windows):
    // in-place installs through electron-updater.
    isDeveloperIdSigned: async () => true,
    platform: "win32",
    ...options,
  });
  return { tempDir, handlers, sent, app, ...registered, ...harness };
}

describe("staleUpdaterStatePaths", () => {
  it("targets the ShipIt cache on macOS", { skip: process.platform !== "darwin" }, () => {
    assert.deepEqual(staleUpdaterStatePaths(fakeApp), [
      "/Users/test/Library/Caches/ai.omnirush.desktop.ShipIt",
    ]);
  });

  it("is a no-op off macOS", { skip: process.platform === "darwin" }, () => {
    assert.deepEqual(staleUpdaterStatePaths(fakeApp), []);
  });
});

describe("update feeds", () => {
  it("has no public Alpha feed: alpha normalizes to stable unless a distribution ships a feed", () => {
    const publicFeed = updaterFeedOptions();
    assert.equal(publicFeed.alphaFeedUrl, null);
    assert.equal(normalizeElectronUpdaterChannel("alpha", publicFeed), "stable");
    assert.equal(normalizeElectronUpdaterChannel("stable", publicFeed), "stable");
    assert.equal(electronUpdaterFeedUrl("alpha", publicFeed), STABLE_FEED);

    const distributionFeed = updaterFeedOptions({ alphaFeedUrl: `${ALPHA_FEED}/` });
    assert.equal(distributionFeed.alphaFeedUrl, ALPHA_FEED);
    assert.equal(normalizeElectronUpdaterChannel("alpha", distributionFeed), "alpha");
    assert.equal(electronUpdaterFeedUrl("alpha", distributionFeed), ALPHA_FEED);
    assert.equal(electronUpdaterFeedUrl("stable", distributionFeed), STABLE_FEED);
  });

  it("never enables Alpha for parallel manifest channels", () => {
    const enterprise = updaterFeedOptions({ manifestChannel: "enterprise", alphaFeedUrl: ALPHA_FEED });
    assert.equal(enterprise.alphaFeedUrl, null);
    assert.equal(normalizeElectronUpdaterChannel("alpha", enterprise), "stable");
  });
});

describe("targetedStableUpdaterFeed", () => {
  it("builds a fixed GitHub release feed from a strict stable version", () => {
    assert.equal(
      targetedStableUpdaterFeed("0.17.22", "0.17.23"),
      "https://github.com/omnirush-ai/omnirush-gui/releases/download/v0.17.23",
    );
  });

  it("rejects arbitrary URLs and prerelease targets", () => {
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.22", "https://example.test/latest.yml"),
      /stable x\.y\.z format/,
    );
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.22", "0.17.23-alpha.1"),
      /stable x\.y\.z format/,
    );
  });

  it("rejects equal and older targets", () => {
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.23", "0.17.23"),
      /newer than the installed version/,
    );
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.23", "0.17.22"),
      /newer than the installed version/,
    );
  });

  it("allows only an explicit exact recovery downgrade", () => {
    assert.equal(
      targetedStableUpdaterFeed("0.17.23", "0.17.22", true),
      "https://github.com/omnirush-ai/omnirush-gui/releases/download/v0.17.22",
    );
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.23", "0.17.23", true),
      /must differ/,
    );
  });

  it("fails closed when the installed version cannot be compared", () => {
    assert.throws(
      () => targetedStableUpdaterFeed("unknown", "0.17.23"),
      /could not be validated/,
    );
  });
});

describe("recovery metadata and candidates", () => {
  it("marks the installed version current and the last healthy version previous after a failed update boot", () => {
    assert.deepEqual(recoveryVersionMarkers("2.0.0", {
      currentVersion: "1.9.0",
      previousVersion: "1.8.0",
    }), {
      currentVersion: "2.0.0",
      previousVersion: "1.9.0",
    });
  });

  it("keeps the prior healthy version previous after the installed version boots successfully", () => {
    assert.deepEqual(recoveryVersionMarkers("2.0.0", {
      currentVersion: "2.0.0",
      previousVersion: "1.9.0",
    }), {
      currentVersion: "2.0.0",
      previousVersion: "1.9.0",
    });
  });

  it("atomically preserves the immediately prior healthy version", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "omnirush-recovery-state-"));
    const app = { getPath: () => userData };
    try {
      await recordHealthyVersion(app, "public", "1.2.3");
      await recordHealthyVersion(app, "public", "1.2.4");
      await recordHealthyVersion(app, "public", "1.2.4");
      assert.deepEqual(await readRecoveryState(app, "public"), {
        currentVersion: "1.2.4",
        previousVersion: "1.2.3",
      });
      assert.match(await readFile(path.join(userData, "app-recovery.v1.json"), "utf8"), /"previousVersion": "1\.2\.3"/);
      assert.deepEqual(await readRecoveryState(app, "cloud"), {
        currentVersion: null,
        previousVersion: null,
      });
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("filters strict stable versions by minimum and fresh organization policy", async () => {
    const releases = await compatibleRecoveryReleases({
      versions: ["2.4.0", "2.3.1", "2.3.0-beta.1", "2.2.9", "https://invalid"],
      currentVersion: "2.4.0",
      previousVersion: "2.3.1",
      minimumVersion: "2.3.0",
      allowedVersions: ["2.4.0", "2.3.1"],
      resolveArtifact: async (version) => ({ url: `verified:${version}` }),
    });
    assert.deepEqual(releases.map(({ version, marking }) => ({ version, marking })), [
      { version: "2.4.0", marking: "current" },
      { version: "2.3.1", marking: "previous" },
    ]);
  });

  it("accepts only the exact platform, architecture, distribution release artifact", () => {
    const files = [
      { url: "omnirush-mac-x64-1.2.3.dmg", sha512: "wrong-arch" },
      { url: "https://tampered.invalid/omnirush-mac-arm64-1.2.3.dmg", sha512: "tampered" },
      { url: "omnirush-mac-arm64-1.2.3.dmg", sha512: "verified" },
    ];
    assert.deepEqual(selectRecoveryArtifact(files, {
      version: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      distribution: "public",
    }), {
      version: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      distribution: "public",
      url: "https://github.com/omnirush-ai/omnirush-gui/releases/download/v1.2.3/omnirush-mac-arm64-1.2.3.dmg",
      sha512: "verified",
    });
    assert.equal(selectRecoveryArtifact(files, {
      version: "1.2.3-beta.1",
      platform: "darwin",
      arch: "arm64",
      distribution: "public",
    }), null);
  });

  it("accepts each artifact flavor only for its matching distribution", () => {
    const artifacts = {
      public: "omnirush-mac-arm64-1.2.3.dmg",
      cloud: "omnirush-cloud-mac-arm64-1.2.3.dmg",
      enterprise: "omnirush-enterprise-mac-arm64-1.2.3.dmg",
    };
    for (const [distribution, fileName] of Object.entries(artifacts)) {
      const files = [{ url: fileName, sha512: `${distribution}-checksum` }];
      assert.equal(selectRecoveryArtifact(files, {
        version: "1.2.3", platform: "darwin", arch: "arm64", distribution,
      })?.url, `https://github.com/omnirush-ai/omnirush-gui/releases/download/v1.2.3/${fileName}`);
      for (const otherDistribution of Object.keys(artifacts).filter((flavor) => flavor !== distribution)) {
        assert.equal(selectRecoveryArtifact(files, {
          version: "1.2.3", platform: "darwin", arch: "arm64", distribution: otherDistribution,
        }), null);
      }
    }
  });

  it("parses representative builder manifests and selects published installer extensions", () => {
    const files = parseRecoveryManifest(`version: 1.2.3
files:
  - url: omnirush-mac-arm64-1.2.3.dmg
    sha512: mac-checksum
    size: 100
  - url: omnirush-cloud-win-x64-1.2.3.exe
    sha512: win-checksum
  - url: omnirush-enterprise-linux-x86_64-1.2.3.AppImage
    sha512: linux-checksum
path: omnirush-mac-arm64-1.2.3.zip
sha512: updater-zip-checksum
releaseDate: '2026-08-11T00:00:00.000Z'
`);
    assert.equal(selectRecoveryArtifact(files, {
      version: "1.2.3", platform: "darwin", arch: "arm64", distribution: "public",
    })?.url.endsWith(".dmg"), true);
    assert.equal(selectRecoveryArtifact(files, {
      version: "1.2.3", platform: "win32", arch: "x64", distribution: "cloud",
    })?.url.endsWith(".exe"), true);
    assert.equal(selectRecoveryArtifact(files, {
      version: "1.2.3", platform: "linux", arch: "x64", distribution: "enterprise",
    })?.url.endsWith(".AppImage"), true);
    assert.equal(recoveryManifestName("darwin", "arm64", "public"), "latest-mac.yml");
    assert.equal(recoveryManifestName("win32", "x64", "cloud"), "cloud.yml");
    assert.equal(recoveryManifestName("linux", "arm64", "enterprise"), "enterprise-linux-arm64.yml");
  });

  it("rejects a checksum mismatch without producing a cached installer", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "omnirush-recovery-checksum-"));
    try {
      await assert.rejects(
        cacheVerifiedRecoveryArtifact({
          app: { getPath: () => userData },
          artifact: { url: "https://github.com/omnirush-ai/omnirush-gui/releases/download/v1.2.3/omnirush.dmg", sha512: "invalid" },
          fetchArtifact: async () => new Response("tampered"),
        }),
        /checksum did not match/,
      );
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("preserves a valid rollback cache across network and checksum replacement failures", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "omnirush-recovery-cache-preserve-"));
    const app = { getPath: () => userData };
    const bytes = Buffer.from("known-good");
    const artifact = {
      version: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      distribution: "public",
      url: "https://github.com/omnirush-ai/omnirush-gui/releases/download/v1.2.3/omnirush-mac-arm64-1.2.3.dmg",
      sha512: createHash("sha512").update(bytes).digest("base64"),
    };
    try {
      await cacheVerifiedRecoveryArtifact({
        app,
        artifact,
        fetchArtifact: async () => new Response(bytes),
      });
      await assert.rejects(cacheVerifiedRecoveryArtifact({
        app,
        artifact: { ...artifact, version: "1.2.4", url: artifact.url.replace("1.2.3", "1.2.4") },
        fetchArtifact: async () => { throw new Error("offline"); },
      }), /offline/);
      await assert.rejects(cacheVerifiedRecoveryArtifact({
        app,
        artifact: { ...artifact, version: "1.2.4", url: artifact.url.replace("1.2.3", "1.2.4") },
        fetchArtifact: async () => new Response("tampered"),
      }), /checksum did not match/);
      assert.equal((await readCachedRecoveryArtifact(app, {
        platform: "darwin", arch: "arm64", distribution: "public",
      }))?.artifact.version, "1.2.3");
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("rejects cached metadata with a modified URL or wrong installer filename", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "omnirush-recovery-cache-identity-"));
    const app = { getPath: () => userData };
    const bytes = Buffer.from("known-good-identity");
    const artifact = {
      version: "0.18.18",
      platform: "darwin",
      arch: "arm64",
      distribution: "public",
      url: "https://github.com/omnirush-ai/omnirush-gui/releases/download/v0.18.18/omnirush-mac-arm64-0.18.18.dmg",
      sha512: createHash("sha512").update(bytes).digest("base64"),
    };
    const expected = { platform: "darwin", arch: "arm64", distribution: "public" };
    try {
      await cacheVerifiedRecoveryArtifact({ app, artifact, fetchArtifact: async () => new Response(bytes) });
      const metadataPath = path.join(userData, "app-recovery-cache", "metadata.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      await writeFile(metadataPath, JSON.stringify({ ...metadata, url: "https://tampered.invalid/OmniRush.ai.dmg" }), "utf8");
      assert.equal(await readCachedRecoveryArtifact(app, expected), null);
      await writeFile(metadataPath, JSON.stringify({ ...metadata, fileName: "OmniRush.ai.dmg" }), "utf8");
      assert.equal(await readCachedRecoveryArtifact(app, expected), null);
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("discovers and opens a reverified cached healthy installer while offline", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "omnirush-recovery-offline-"));
    const quitCalls = [];
    const app = {
      isPackaged: true,
      getVersion: () => "2.0.0",
      getPath: () => userData,
      quit: () => quitCalls.push("quit"),
    };
    const bytes = Buffer.from("offline-known-good");
    const artifact = {
      version: "1.9.0",
      platform: "darwin",
      arch: "arm64",
      distribution: "public",
      url: "https://github.com/omnirush-ai/omnirush-gui/releases/download/v1.9.0/omnirush-mac-arm64-1.9.0.dmg",
      sha512: createHash("sha512").update(bytes).digest("base64"),
    };
    const handlers = new Map();
    const opened = [];
    const networkCalls = [];
    let openError = "installer blocked";
    try {
      await recordHealthyVersion(app, "public", "1.9.0");
      await cacheVerifiedRecoveryArtifact({ app, artifact, fetchArtifact: async () => new Response(bytes) });
      isolatedUpdaterImportId += 1;
      const isolated = await import(`./updater.mjs?offline-recovery=${isolatedUpdaterImportId}`);
      isolated.registerUpdaterIpc({
        app,
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        getMainWindow: () => null,
        electronNet: { fetch: async () => { networkCalls.push("fetch"); throw new Error("offline"); } },
        shell: { openPath: async (filePath) => { opened.push(filePath); return openError; } },
        platform: "darwin",
        arch: "arm64",
        distribution: "public",
        isDeveloperIdSigned: async () => true,
      });
      const listed = await handlers.get("omnirush:recovery:list")(null, {
        versions: [], minimumVersion: "0.0.0",
      });
      assert.deepEqual(listed.releases, [{ id: "1.9.0", version: "1.9.0", marking: "previous" }]);
      assert.deepEqual(networkCalls, []);
      assert.deepEqual(await handlers.get("omnirush:recovery:use")(null, "1.9.0"), {
        ok: false,
        reason: "installer blocked",
      });
      assert.deepEqual(quitCalls, []);
      openError = "";
      assert.deepEqual(await handlers.get("omnirush:recovery:use")(null, "1.9.0"), {
        ok: true,
        action: "installer",
        message: "The verified installer is open. Follow the operating system steps to finish.",
      });
      assert.equal(opened.length, 2);
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("rejects a candidate whose fresh manifest changes without any destructive action", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "omnirush-recovery-fresh-mismatch-"));
    const handlers = new Map();
    const destructiveCalls = [];
    let candidateFetches = 0;
    const manifest = (checksum) => `version: 1.9.0\nfiles:\n  - url: omnirush-mac-arm64-1.9.0.dmg\n    sha512: ${checksum}\n`;
    try {
      isolatedUpdaterImportId += 1;
      const isolated = await import(`./updater.mjs?fresh-mismatch=${isolatedUpdaterImportId}`);
      isolated.registerUpdaterIpc({
        app: {
          isPackaged: true,
          getVersion: () => "2.0.0",
          getPath: () => userData,
          quit: () => destructiveCalls.push("quit"),
        },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        getMainWindow: () => null,
        electronNet: { fetch: async (url) => {
          if (!url.includes("/v1.9.0/")) return new Response("missing", { status: 404 });
          candidateFetches += 1;
          return new Response(manifest(candidateFetches === 1 ? "first-checksum" : "changed-checksum"));
        } },
        shell: { openPath: async () => { destructiveCalls.push("open"); return ""; } },
        platform: "darwin",
        arch: "arm64",
        distribution: "public",
        isDeveloperIdSigned: async () => true,
      });
      const listed = await handlers.get("omnirush:recovery:list")(null, {
        versions: ["1.9.0"], minimumVersion: "0.0.0",
      });
      assert.deepEqual(listed.releases, [{ id: "1.9.0", version: "1.9.0", marking: null }]);
      const result = await handlers.get("omnirush:recovery:use")(null, "1.9.0");
      assert.equal(result.ok, false);
      assert.match(result.reason, /could not be verified/);
      assert.deepEqual(destructiveCalls, []);
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("does not download, install, or quit for an unverified renderer selection", async () => {
    const handlers = new Map();
    const destructiveCalls = [];
    registerUpdaterIpc({
      app: {
        isPackaged: true,
        getVersion: () => "1.2.3",
        getPath: () => os.tmpdir(),
        quit: () => destructiveCalls.push("quit"),
      },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      getMainWindow: () => null,
      electronNet: { fetch: async () => {
        destructiveCalls.push("download");
        return new Response("unexpected");
      } },
      shell: { openPath: async () => {
        destructiveCalls.push("open");
        return "";
      } },
      env: {
        OMNIRUSH_EVAL_RECOVERY_CANDIDATES: JSON.stringify([
          { version: "1.2.2", verified: false, artifactUrl: "https://tampered.invalid/omnirush.dmg" },
        ]),
      },
      isDeveloperIdSigned: async () => true,
    });
    await handlers.get("omnirush:recovery:list")(null, {});
    assert.equal((await handlers.get("omnirush:recovery:use")(null, "1.2.2")).ok, false);
    assert.deepEqual(destructiveCalls, []);
  });
});

describe("installAndRestart", () => {
  it("refuses to invoke the installer before an update is downloaded", async () => {
    const handlers = new Map();
    registerUpdaterIpc({
      app: { isPackaged: false },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      getMainWindow: () => null,
    });

    const install = handlers.get("omnirush:updater:installAndRestart");
    assert.equal(typeof install, "function");
    assert.deepEqual(await install(), {
      ok: false,
      reason: "update-not-downloaded",
    });
  });
});

describe("downloaded update lifecycle", () => {
  it("a transient failed check does not invalidate a downloaded update", async () => {
    const { tempDir, handlers, updater, calls } = await registerFakeUpdaterIpc({
      version: "0.17.1",
    });
    try {
      const check = handlers.get("omnirush:updater:check");
      const download = handlers.get("omnirush:updater:download");
      const install = handlers.get("omnirush:updater:installAndRestart");
      assert.equal(typeof check, "function");
      assert.equal(typeof download, "function");
      assert.equal(typeof install, "function");

      const checked = await check(null, "stable");
      assert.equal(checked.available, true);
      assert.equal(checked.installMode, "in-place");
      assert.equal(checked.alphaChannelSupported, false);
      assert.deepEqual(await download(), { ok: true, mode: "in-place" });
      assert.equal(updater.autoInstallOnAppQuit, false, "only installNewest may install the staged download");
      assert.deepEqual(calls, ["download"], "downloading must not quit the app");
      updater.checkForUpdates = async () => {
        throw new Error("network flake");
      };
      const failedCheck = await check(null, "stable");
      assert.equal(failedCheck.available, false);
      assert.match(failedCheck.reason, /network flake/);
      assert.deepEqual(await install(), { ok: true, mode: "in-place" });
      assert.deepEqual(calls, ["download", "quitAndInstall"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("an updater error event does not invalidate a downloaded update", async () => {
    const { tempDir, handlers, listeners, calls } = await registerFakeUpdaterIpc({
      version: "0.17.1",
    });
    try {
      const check = handlers.get("omnirush:updater:check");
      const download = handlers.get("omnirush:updater:download");
      const install = handlers.get("omnirush:updater:installAndRestart");
      assert.equal(typeof check, "function");
      assert.equal(typeof download, "function");
      assert.equal(typeof install, "function");

      assert.equal((await check(null, "stable")).available, true);
      assert.deepEqual(await download(), { ok: true, mode: "in-place" });
      const onError = listeners.get("error");
      assert.equal(typeof onError, "function");
      onError(new Error("network flake"));
      assert.deepEqual(await install(), { ok: true, mode: "in-place" });
      assert.deepEqual(calls, ["download", "quitAndInstall"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("a successful check reporting no update still blocks install", async () => {
    const { tempDir, handlers, updater } = await registerFakeUpdaterIpc({
      version: "0.17.1",
    });
    try {
      const check = handlers.get("omnirush:updater:check");
      const download = handlers.get("omnirush:updater:download");
      const install = handlers.get("omnirush:updater:installAndRestart");
      assert.equal(typeof check, "function");
      assert.equal(typeof download, "function");
      assert.equal(typeof install, "function");

      assert.equal((await check(null, "stable")).available, true);
      assert.deepEqual(await download(), { ok: true, mode: "in-place" });
      updater.checkForUpdates = async () => ({
        updateInfo: { version: "0.17.0" },
      });
      const currentCheck = await check(null, "stable");
      assert.equal(currentCheck.available, false);
      assert.deepEqual(await install(), {
        ok: false,
        reason: "update-not-downloaded",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("macOS code signature detection", () => {
  it("derives the bundle path from the running executable", () => {
    assert.equal(
      macAppBundlePath("/Applications/OmniRush.ai.app/Contents/MacOS/OmniRush.ai"),
      "/Applications/OmniRush.ai.app",
    );
    assert.equal(macAppBundlePath("/usr/local/bin/node"), null);
    assert.equal(macAppBundlePath(undefined), null);
  });

  it("accepts only a Developer ID signature", () => {
    assert.equal(developerIdSignatureFromCodesignOutput(
      "Identifier=ai.omnirush.desktop\nAuthority=Developer ID Application: OmniRush (TEAMID)\nAuthority=Developer ID Certification Authority",
    ), true);
    assert.equal(developerIdSignatureFromCodesignOutput(
      "Identifier=ai.omnirush.desktop\nSignature=adhoc\nAuthority=Developer ID Application: forged",
    ), false);
    assert.equal(developerIdSignatureFromCodesignOutput("Identifier=ai.omnirush.desktop\nSignature=adhoc"), false);
    assert.equal(developerIdSignatureFromCodesignOutput("Identifier=ai.omnirush.desktop"), false);
    assert.equal(developerIdSignatureFromCodesignOutput(""), false);
  });

  it("treats spawn failures and non-bundle executables as ad-hoc", async () => {
    const execPath = "/Applications/OmniRush.ai.app/Contents/MacOS/OmniRush.ai";
    const failing = (_command, _args, _options, callback) => callback(new Error("spawn failed"), "", "");
    assert.equal(await detectDeveloperIdSignature(execPath, failing), false);

    const invocations = [];
    const signed = (command, args, _options, callback) => {
      invocations.push([command, ...args]);
      callback(null, "", "Authority=Developer ID Application: OmniRush (TEAMID)\n");
    };
    assert.equal(await detectDeveloperIdSignature(execPath, signed), true);
    assert.deepEqual(invocations, [["/usr/bin/codesign", "-dv", "--verbose=2", "/Applications/OmniRush.ai.app"]]);
    assert.equal(await detectDeveloperIdSignature("/usr/local/bin/node", signed), false);
  });
});

const RELEASE_123 = "https://github.com/omnirush-ai/omnirush-gui/releases/download/v1.2.3";

describe("manual installer artifacts", () => {
  const files = [
    { url: "omnirush-mac-arm64-1.2.3.zip", sha512: "zip-checksum", size: 10 },
    { url: "omnirush-mac-arm64-1.2.3.dmg", sha512: "arm64-checksum", size: 20 },
    { url: "omnirush-mac-x64-1.2.3.dmg", sha512: "x64-checksum", size: 30 },
  ];

  it("selects the DMG for the running architecture relative to the feed directory", () => {
    assert.deepEqual(selectManualInstallerArtifact({ version: "1.2.3", files }, STABLE_FEED, "arm64"), {
      version: "1.2.3",
      // From the release the manifest names, not whatever is latest at download time.
      url: `${RELEASE_123}/omnirush-mac-arm64-1.2.3.dmg`,
      sha512: "arm64-checksum",
      size: 20,
      fileName: "omnirush-mac-arm64-1.2.3.dmg",
    });
    assert.equal(selectManualInstallerArtifact({ version: "1.2.3", files }, STABLE_FEED, "x64")?.sha512, "x64-checksum");
  });

  it("rejects manifests without a checksummed DMG or with a foreign download origin", () => {
    assert.equal(selectManualInstallerArtifact({ version: "1.2.3", files: [files[0]] }, STABLE_FEED, "arm64"), null);
    assert.equal(selectManualInstallerArtifact({
      version: "1.2.3",
      files: [{ url: "omnirush-mac-arm64-1.2.3.dmg", sha512: "", size: 20 }],
    }, STABLE_FEED, "arm64"), null);
    assert.equal(selectManualInstallerArtifact({
      version: "1.2.3",
      files: [{ url: "https://tampered.invalid/omnirush-mac-arm64-1.2.3.dmg", sha512: "x", size: 20 }],
    }, STABLE_FEED, "arm64"), null);
  });
});

describe("macOS manual installer fallback", () => {
  const manualInstallerHarness = async ({ bytes, sha512 = createHash("sha512").update(bytes).digest("base64"), ...options }) => {
    const fetched = [];
    const opened = [];
    const harness = await registerFakeUpdaterIpc({
      version: "0.17.1",
      files: [
        { url: "omnirush-mac-arm64-0.17.1.zip", sha512: "zip-checksum", size: 1 },
        { url: "omnirush-mac-arm64-0.17.1.dmg", sha512, size: bytes.length },
      ],
      platform: "darwin",
      arch: "arm64",
      isDeveloperIdSigned: async () => false,
      // Gatekeeper runs a quarantined app opened from Downloads from a
      // read-only translocated copy: replacing that would change nothing.
      getAppPath: () => "/private/var/folders/x/T/AppTranslocation/ABCD/d/OmniRush.ai.app/Contents/Resources/app.asar",
      electronNet: { fetch: async (url) => {
        fetched.push(url);
        return new Response(bytes);
      } },
      shell: { openPath: async (filePath) => {
        opened.push(filePath);
        return "";
      } },
      quitDelayMs: 0,
      ...options,
    });
    return { ...harness, fetched, opened };
  };

  it("downloads the manifest DMG and opens it instead of invoking Squirrel on an ad-hoc signed app", async () => {
    const bytes = Buffer.from("dmg-bytes-for-manual-install");
    const { tempDir, handlers, calls, sent, fetched, opened } = await manualInstallerHarness({ bytes });
    try {
      const check = handlers.get("omnirush:updater:check");
      const download = handlers.get("omnirush:updater:download");
      const install = handlers.get("omnirush:updater:installAndRestart");
      const getChannel = handlers.get("omnirush:updater:getChannel");

      assert.equal((await getChannel()).installMode, "manual-dmg");
      const checked = await check(null, "stable");
      assert.equal(checked.available, true);
      assert.equal(checked.installMode, "manual-dmg");

      assert.deepEqual(await download(), { ok: true, mode: "manual-dmg" });
      assert.deepEqual(fetched, ["https://github.com/omnirush-ai/omnirush-gui/releases/download/v0.17.1/omnirush-mac-arm64-0.17.1.dmg"]);
      assert.deepEqual(calls, [], "electron-updater's zip download must not run");
      const progress = sent.filter((event) => event.channel === "omnirush:updater:download-progress");
      assert.equal(progress.at(-1)?.data.transferred, bytes.length);
      assert.equal(progress.at(-1)?.data.total, bytes.length);
      assert.equal(progress.at(-1)?.data.percent, 100);

      const installed = await install();
      const expectedPath = path.join(tempDir, "userData", "app-update-installer", "omnirush-mac-arm64-0.17.1.dmg");
      assert.deepEqual(installed, { ok: true, mode: "manual-dmg", path: expectedPath });
      assert.deepEqual(opened, [expectedPath]);
      assert.deepEqual(readFileSync(expectedPath), bytes);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(calls, ["quit"], "quitAndInstall must never run for an ad-hoc signed app");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects an installer whose checksum does not match the manifest", async () => {
    const bytes = Buffer.from("tampered-dmg");
    const { tempDir, handlers, calls, opened } = await manualInstallerHarness({ bytes, sha512: "expected-checksum" });
    try {
      const check = handlers.get("omnirush:updater:check");
      const download = handlers.get("omnirush:updater:download");
      const install = handlers.get("omnirush:updater:installAndRestart");

      assert.equal((await check(null, "stable")).available, true);
      const result = await download();
      assert.equal(result.ok, false);
      assert.match(result.reason, /checksum did not match/);
      assert.deepEqual(await install(), { ok: false, reason: "update-not-downloaded" });
      assert.deepEqual(opened, []);
      assert.deepEqual(calls, []);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails the download when the manifest lists no DMG for this architecture", async () => {
    const bytes = Buffer.from("x64-only");
    const { tempDir, handlers, fetched } = await manualInstallerHarness({ bytes, arch: "x64" });
    try {
      const check = handlers.get("omnirush:updater:check");
      const download = handlers.get("omnirush:updater:download");
      assert.equal((await check(null, "stable")).available, true);
      const result = await download();
      assert.equal(result.ok, false);
      assert.match(result.reason, /does not list a macOS installer/);
      assert.deepEqual(fetched, []);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the Squirrel path for Developer ID signed macOS apps and other platforms", async () => {
    for (const options of [
      { platform: "darwin", arch: "arm64", isDeveloperIdSigned: async () => true },
      { platform: "win32", arch: "x64", isDeveloperIdSigned: async () => { throw new Error("not consulted"); } },
    ]) {
      const { tempDir, handlers, calls } = await registerFakeUpdaterIpc({ version: "0.17.1", ...options });
      try {
        const check = handlers.get("omnirush:updater:check");
        const download = handlers.get("omnirush:updater:download");
        const install = handlers.get("omnirush:updater:installAndRestart");
        assert.equal((await check(null, "stable")).installMode, "in-place");
        assert.deepEqual(await download(), { ok: true, mode: "in-place" });
        assert.deepEqual(await install(), { ok: true, mode: "in-place" });
        assert.deepEqual(calls, ["download", "quitAndInstall"]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });
});

describe("release channel changes", () => {
  it("prevents a previously downloaded update from installing on quit", () => {
    const updater = { autoInstallOnAppQuit: true };

    preventPendingUpdaterInstall(updater);
    assert.equal(updater.autoInstallOnAppQuit, false);
  });

  it("pins enterprise builds to their parallel stable manifest channel", async () => {
    const handlers = new Map();
    const userData = await mkdtemp(path.join(os.tmpdir(), "omnirush-enterprise-updater-"));
    try {
      registerUpdaterIpc({
        app: {
          isPackaged: false,
          getVersion: () => desktopVersion,
          getPath: () => userData,
        },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        getMainWindow: () => null,
        manifestChannel: "enterprise",
        alphaFeedUrl: ALPHA_FEED,
      });

      const setChannel = handlers.get("omnirush:updater:setChannel");
      assert.equal(typeof setChannel, "function");
      assert.deepEqual(await setChannel(null, "alpha"), {
        channel: "stable",
        feedUrl: STABLE_FEED,
        currentVersion: desktopVersion,
        alphaChannelSupported: false,
        installMode: "in-place",
      });
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  it("normalizes a persisted or requested alpha channel to stable on the public distribution", async () => {
    const { tempDir, handlers, feeds } = await registerFakeUpdaterIpc({ version: "0.18.0" });
    try {
      const channelPath = path.join(tempDir, "userData", "electron-updater-channel.v1.json");
      await mkdir(path.dirname(channelPath), { recursive: true });
      await writeFile(channelPath, JSON.stringify({ channel: "alpha" }), "utf8");

      const check = handlers.get("omnirush:updater:check");
      const setChannel = handlers.get("omnirush:updater:setChannel");
      const getChannel = handlers.get("omnirush:updater:getChannel");

      const persisted = await getChannel();
      assert.equal(persisted.channel, "stable");
      assert.equal(persisted.feedUrl, STABLE_FEED);
      assert.equal(persisted.alphaChannelSupported, false);

      const requested = await check(null, "alpha");
      assert.equal(requested.channel, "stable");
      assert.equal(requested.feedUrl, STABLE_FEED);
      assert.equal(feeds.at(-1)?.url, STABLE_FEED);
      assert.ok(feeds.every((feed) => feed.url === STABLE_FEED), "no feed may point at an Alpha release");

      const selected = await setChannel(null, "alpha");
      assert.equal(selected.channel, "stable");
      assert.equal(JSON.parse(await readFile(channelPath, "utf8")).channel, "stable");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not let a check overwrite the selected channel", async () => {
    const { tempDir, handlers } = await registerFakeUpdaterIpc({
      version: "0.18.0",
      alphaFeedUrl: ALPHA_FEED,
    });
    try {
      const check = handlers.get("omnirush:updater:check");
      const setChannel = handlers.get("omnirush:updater:setChannel");
      const getChannel = handlers.get("omnirush:updater:getChannel");

      const selected = await setChannel(null, "alpha");
      assert.equal(selected.channel, "alpha");
      assert.equal(selected.alphaChannelSupported, true);
      assert.equal((await check(null, "stable")).channel, "stable");
      assert.equal((await getChannel()).channel, "alpha");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("downloads from the channel used by the successful check", async () => {
    const { tempDir, handlers, downloadFeeds } = await registerFakeUpdaterIpc({
      version: "0.18.0-alpha.1",
      alphaFeedUrl: ALPHA_FEED,
    });
    try {
      const check = handlers.get("omnirush:updater:check");
      const download = handlers.get("omnirush:updater:download");

      assert.equal((await check(null, "alpha")).channel, "alpha");
      assert.deepEqual(await download(), { ok: true, mode: "in-place" });
      assert.equal(downloadFeeds.at(-1)?.url, ALPHA_FEED);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps Alpha selected when a Stable check is already in flight", async () => {
    const { tempDir, handlers, updater, feeds } = await registerFakeUpdaterIpc({
      version: "0.18.0",
      alphaFeedUrl: ALPHA_FEED,
    });
    /** @type {{ finish: null | (() => void) }} */
    const stableCheckControl = { finish: null };
    const stableCheckStarted = new Promise((resolve) => {
      updater.checkForUpdates = () => new Promise((finish) => {
        stableCheckControl.finish = () => finish({ updateInfo: { version: "0.18.0" } });
        resolve();
        updater.checkForUpdates = async () => ({ updateInfo: { version: "0.18.0-alpha.1" } });
      });
    });
    try {
      const check = handlers.get("omnirush:updater:check");
      const setChannel = handlers.get("omnirush:updater:setChannel");
      const getChannel = handlers.get("omnirush:updater:getChannel");

      const stableCheck = check(null, "stable");
      await stableCheckStarted;
      const alphaSelection = setChannel(null, "alpha");
      const alphaCheck = check(null, "alpha");
      const finishStableCheck = stableCheckControl.finish;
      if (!finishStableCheck) throw new Error("Stable update check did not start.");
      finishStableCheck();

      assert.equal((await stableCheck).channel, "stable");
      assert.equal((await alphaSelection).channel, "alpha");
      assert.equal((await alphaCheck).channel, "alpha");
      assert.equal((await getChannel()).channel, "alpha");
      assert.equal(
        JSON.parse(await readFile(
          path.join(tempDir, "userData", "electron-updater-channel.v1.json"),
          "utf8",
        )).channel,
        "alpha",
      );
      assert.equal(feeds.at(-1)?.url, ALPHA_FEED);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// A mutable feed: tests publish releases while an older download is staged.
async function publishingFeedHarness(options = {}) {
  const harness = await registerFakeUpdaterIpc({ version: "2.2.1", ...options });
  harness.app.getVersion = () => "2.2.0";
  const feed = { version: "2.2.1", failDownloadOf: null, failCheck: false };
  const downloaded = [];
  const installs = [];
  let lastChecked = null;
  harness.updater.checkForUpdates = async () => {
    if (feed.failCheck) throw new Error("feed unreachable");
    lastChecked = feed.version;
    return { updateInfo: { version: feed.version } };
  };
  harness.updater.downloadUpdate = async () => {
    if (lastChecked === feed.failDownloadOf) throw new Error(`HTTP 503 for ${lastChecked}`);
    downloaded.push(lastChecked);
  };
  harness.updater.quitAndInstall = (isSilent, isForceRunAfter) => {
    installs.push({ version: downloaded.at(-1), isSilent, isForceRunAfter });
    harness.appEvents.emit("before-quit");
  };
  return { ...harness, feed, downloaded, installs };
}

describe("installing the newest published release", () => {
  it("downloads 2.2.3 and installs it when 2.2.1 is staged and 2.2.3 was published since", async () => {
    const { tempDir, handlers, feed, downloaded, installs, updater } = await publishingFeedHarness();
    try {
      assert.equal((await handlers.get("omnirush:updater:check")(null, "stable")).latestVersion, "2.2.1");
      assert.deepEqual(await handlers.get("omnirush:updater:download")(), { ok: true, mode: "in-place" });
      assert.equal(updater.autoInstallOnAppQuit, false, "the staged 2.2.1 must not install behind the updater's back");
      feed.version = "2.2.3";
      assert.deepEqual(await handlers.get("omnirush:updater:installAndRestart")(), { ok: true, mode: "in-place" });
      assert.deepEqual(downloaded, ["2.2.1", "2.2.3"]);
      assert.deepEqual(installs, [{ version: "2.2.3", isSilent: false, isForceRunAfter: true }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("installs the staged download without re-downloading when it is still the newest", async () => {
    const { tempDir, handlers, downloaded, installs } = await publishingFeedHarness();
    try {
      await handlers.get("omnirush:updater:check")(null, "stable");
      await handlers.get("omnirush:updater:download")();
      assert.deepEqual(await handlers.get("omnirush:updater:installAndRestart")(), { ok: true, mode: "in-place" });
      assert.deepEqual(downloaded, ["2.2.1"]);
      assert.deepEqual(installs.map((install) => install.version), ["2.2.1"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports no update and installs nothing when the feed has nothing newer", async () => {
    const { tempDir, handlers, feed, downloaded, installs } = await publishingFeedHarness();
    try {
      feed.version = "2.2.0";
      const checked = await handlers.get("omnirush:updater:check")(null, "stable");
      assert.equal(checked.available, false);
      assert.deepEqual(await handlers.get("omnirush:updater:download")(), { ok: false, reason: "No update available." });
      assert.deepEqual(await handlers.get("omnirush:updater:installAndRestart")(), { ok: false, reason: "update-not-downloaded" });
      assert.deepEqual(downloaded, []);
      assert.deepEqual(installs, []);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("never falls back to the stale download when the newer one fails to download", async () => {
    const { tempDir, handlers, feed, downloaded, installs } = await publishingFeedHarness();
    try {
      await handlers.get("omnirush:updater:check")(null, "stable");
      await handlers.get("omnirush:updater:download")();
      feed.version = "2.2.3";
      feed.failDownloadOf = "2.2.3";
      const failed = await handlers.get("omnirush:updater:installAndRestart")();
      assert.equal(failed.ok, false);
      assert.match(failed.reason, /2\.2\.3 is available but could not be downloaded: HTTP 503/);
      assert.deepEqual(installs, [], "2.2.1 must not install once 2.2.3 is on the feed");
      // The renderer's retry path: nothing staged, so it re-checks and downloads again.
      assert.deepEqual(await handlers.get("omnirush:updater:installAndRestart")(), { ok: false, reason: "update-not-downloaded" });
      feed.failDownloadOf = null;
      assert.equal((await handlers.get("omnirush:updater:check")(null, "stable")).latestVersion, "2.2.3");
      assert.deepEqual(await handlers.get("omnirush:updater:download")(), { ok: true, mode: "in-place" });
      assert.deepEqual(await handlers.get("omnirush:updater:installAndRestart")(), { ok: true, mode: "in-place" });
      assert.deepEqual(downloaded, ["2.2.1", "2.2.3"]);
      assert.deepEqual(installs.map((install) => install.version), ["2.2.3"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("installs the staged download when the feed cannot be reached", async () => {
    const { tempDir, handlers, feed, installs } = await publishingFeedHarness();
    try {
      await handlers.get("omnirush:updater:check")(null, "stable");
      await handlers.get("omnirush:updater:download")();
      feed.failCheck = true;
      assert.deepEqual(await handlers.get("omnirush:updater:installAndRestart")(), { ok: true, mode: "in-place" });
      assert.deepEqual(installs.map((install) => install.version), ["2.2.1"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("a periodic check replaces the staged download with the newer release", async () => {
    const { tempDir, handlers, feed, downloaded, installs } = await publishingFeedHarness();
    try {
      await handlers.get("omnirush:updater:check")(null, "stable");
      await handlers.get("omnirush:updater:download")();
      feed.version = "2.2.2";
      assert.equal((await handlers.get("omnirush:updater:check")(null, "stable")).latestVersion, "2.2.2");
      await handlers.get("omnirush:updater:download")();
      assert.deepEqual(await handlers.get("omnirush:updater:installAndRestart")(), { ok: true, mode: "in-place" });
      assert.deepEqual(downloaded, ["2.2.1", "2.2.2"]);
      assert.deepEqual(installs.map((install) => install.version), ["2.2.2"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("on quit, re-checks the feed and silently installs the newest release", async () => {
    const { tempDir, handlers, feed, downloaded, installs, updater, prepareInstallOnQuit } = await publishingFeedHarness({
      quitInstallFallbackMs: 0,
    });
    try {
      assert.equal(await prepareInstallOnQuit(), null, "nothing staged: plain quit");
      await handlers.get("omnirush:updater:check")(null, "stable");
      await handlers.get("omnirush:updater:download")();
      feed.version = "2.2.3";
      const installAndQuit = await prepareInstallOnQuit();
      assert.equal(typeof installAndQuit, "function");
      installAndQuit();
      assert.deepEqual(downloaded, ["2.2.1", "2.2.3"]);
      assert.deepEqual(installs, [{ version: "2.2.3", isSilent: true, isForceRunAfter: false }]);
      assert.equal(updater.autoRunAppAfterInstall, false);
      assert.equal(await prepareInstallOnQuit(), null, "an install already started");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("on quit, skips the stale download when the newer release cannot be fetched", async () => {
    const { tempDir, handlers, feed, installs, prepareInstallOnQuit } = await publishingFeedHarness();
    try {
      await handlers.get("omnirush:updater:check")(null, "stable");
      await handlers.get("omnirush:updater:download")();
      feed.version = "2.2.3";
      feed.failDownloadOf = "2.2.3";
      assert.equal(await prepareInstallOnQuit(), null);
      assert.deepEqual(installs, []);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("on quit, gives up on a slow feed instead of holding the app open", async () => {
    const { tempDir, handlers, updater, installs, prepareInstallOnQuit } = await publishingFeedHarness({
      quitUpdateTimeoutMs: 20,
      installCheckTimeoutMs: 20,
    });
    try {
      await handlers.get("omnirush:updater:check")(null, "stable");
      await handlers.get("omnirush:updater:download")();
      updater.checkForUpdates = () => new Promise(() => {});
      assert.equal(await prepareInstallOnQuit(), null);
      assert.deepEqual(installs, []);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("dev update feed override", () => {
  it("honors only loopback URLs", () => {
    assert.equal(loopbackDevFeedUrl("http://127.0.0.1:8765/feed/"), "http://127.0.0.1:8765/feed");
    assert.equal(loopbackDevFeedUrl("http://localhost:8765"), "http://localhost:8765");
    assert.equal(loopbackDevFeedUrl("https://updates.example.com/feed"), null);
    assert.equal(loopbackDevFeedUrl("file:///tmp/feed"), null);
    assert.equal(loopbackDevFeedUrl(undefined), null);
    assert.equal(updaterFeedOptions({ devFeedUrl: "http://127.0.0.1:1/f" }).stableFeedUrl, "http://127.0.0.1:1/f");
    assert.equal(updaterFeedOptions({ devFeedUrl: "https://evil.example/f" }).stableFeedUrl, STABLE_FEED);
  });
});

const RELEASE_0171 = "https://github.com/omnirush-ai/omnirush-gui/releases/download/v0.17.1";
const sha512Of = (bytes) => createHash("sha512").update(bytes).digest("base64");
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe("macOS self-install without a Developer ID signature", () => {
  const BUNDLE = "/Users/test/Applications/OmniRush.ai.app";
  const macSwapHarness = async ({ writable = true, swap = null } = {}) => {
    const zip = Buffer.from("zip-bytes-of-0.17.1");
    const fetched = [];
    const staged = [];
    const swaps = [];
    const harness = await registerFakeUpdaterIpc({
      version: "0.17.1",
      files: [
        { url: "omnirush-mac-arm64-0.17.1.zip", sha512: sha512Of(zip), size: zip.length },
        { url: "omnirush-mac-arm64-0.17.1.dmg", sha512: "dmg-checksum", size: 1 },
      ],
      platform: "darwin",
      arch: "arm64",
      isDeveloperIdSigned: async () => false,
      getAppPath: () => `${BUNDLE}/Contents/Resources/app.asar`,
      electronNet: { fetch: async (url) => {
        fetched.push(url);
        return new Response(zip);
      } },
      canReplace: async () => writable,
      stageMacUpdate: async ({ zipPath, version, currentBundle }) => {
        staged.push({ bytes: readFileSync(zipPath), version, currentBundle });
        const directory = await mkdtemp(path.join(os.tmpdir(), "omnirush-staged-"));
        await mkdir(path.join(directory, "OmniRush.ai.app"));
        return { directory, bundle: path.join(directory, "OmniRush.ai.app"), version };
      },
      startMacSwap: async (request) => {
        swaps.push(request);
        if (swap) await swap(request);
        return { elevated: !request.writable };
      },
      restartDelayMs: 0,
    });
    return { ...harness, zip, fetched, staged, swaps };
  };

  it("downloads the release zip, stages it and swaps the bundle on restart", async () => {
    const { tempDir, handlers, calls, fetched, staged, swaps, zip } = await macSwapHarness();
    try {
      assert.equal((await handlers.get("omnirush:updater:getChannel")()).installMode, "in-place");
      assert.equal((await handlers.get("omnirush:updater:check")(null, "stable")).available, true);
      assert.deepEqual(await handlers.get("omnirush:updater:download")(), { ok: true, mode: "in-place" });
      assert.deepEqual(fetched, [`${RELEASE_0171}/omnirush-mac-arm64-0.17.1.zip`]);
      assert.deepEqual(staged, [{ bytes: zip, version: "0.17.1", currentBundle: BUNDLE }]);
      assert.deepEqual(calls, [], "Squirrel never runs for an ad-hoc signed app");

      assert.deepEqual(await handlers.get("omnirush:updater:installAndRestart")(), { ok: true, mode: "in-place" });
      assert.equal(swaps.length, 1);
      assert.equal(swaps[0].targetBundle, BUNDLE);
      assert.equal(swaps[0].writable, true);
      assert.equal(swaps[0].relaunch, true);
      assert.match(swaps[0].stagedBundle, /OmniRush\.ai\.app$/);
      await settle();
      assert.deepEqual(calls, ["quit"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("asks for an administrator where the folder is not writable, and falls back to the download page only when that is cancelled", async () => {
    const { tempDir, handlers, calls, swaps } = await macSwapHarness({
      writable: false,
      swap: async () => {
        const error = new Error("Command failed: osascript\n0:12: execution error: User canceled. (-128)");
        throw error;
      },
    });
    try {
      await handlers.get("omnirush:updater:check")(null, "stable");
      await handlers.get("omnirush:updater:download")();
      const result = await handlers.get("omnirush:updater:installAndRestart")();
      assert.equal(result.ok, false);
      assert.equal(result.fallback, "download-page");
      assert.match(result.reason, /administrator/);
      assert.match(result.reason, /cancelled/);
      assert.equal(swaps[0].writable, false);
      await settle();
      assert.deepEqual(calls, [], "the app stays open when nothing was replaced");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("installs on quit without relaunching, and never prompts for a password at quit", async () => {
    for (const writable of [true, false]) {
      const { tempDir, handlers, swaps, prepareInstallOnQuit } = await macSwapHarness({ writable });
      try {
        await handlers.get("omnirush:updater:check")(null, "stable");
        await handlers.get("omnirush:updater:download")();
        const installAndQuit = await prepareInstallOnQuit();
        if (!writable) {
          assert.equal(installAndQuit, null);
          continue;
        }
        installAndQuit();
        await settle();
        assert.equal(swaps.length, 1);
        assert.equal(swaps[0].relaunch, false);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });
});

describe("the swap helper script", { skip: process.platform === "win32" }, () => {
  it("waits for the app to exit, swaps the bundle and cleans up", async () => {
    const { MAC_SWAP_SCRIPT } = await import("./self-install.mjs");
    const { spawn, execFile } = await import("node:child_process");
    const root = await mkdtemp(path.join(os.tmpdir(), "omnirush-swap-"));
    try {
      const target = path.join(root, "Applications", "OmniRush.ai.app");
      const staging = path.join(root, "staging");
      const staged = path.join(staging, "OmniRush.ai.app");
      await mkdir(path.join(target, "Contents"), { recursive: true });
      await writeFile(path.join(target, "Contents", "version"), "old");
      await mkdir(path.join(staged, "Contents"), { recursive: true });
      await writeFile(path.join(staged, "Contents", "version"), "new");
      const script = path.join(root, "swap.sh");
      await writeFile(script, MAC_SWAP_SCRIPT, { mode: 0o755 });
      const app = spawn("sleep", ["0.6"]);
      const startedAt = Date.now();
      // Async, so this process reaps the exited "app" (a zombie still answers kill -0).
      await new Promise((resolve, reject) => {
        execFile("/bin/sh", [script, String(app.pid), staged, target, "0"], (error) => (error ? reject(error) : resolve()));
      });
      assert.ok(Date.now() - startedAt >= 400, "the swap waited for the app to exit");
      assert.equal(await readFile(path.join(target, "Contents", "version"), "utf8"), "new");
      assert.equal(existsSync(staging), false, "the staging folder is removed");
      const leftovers = readdirSync(path.dirname(target));
      assert.deepEqual(leftovers, ["OmniRush.ai.app"], "no backup bundle is left behind");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Linux AppImage self-install", () => {
  const appImageHarness = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omnirush-appimage-"));
    const appImage = path.join(root, "Apps", "omnirush-linux-x86_64-0.17.0.AppImage");
    await mkdir(path.dirname(appImage), { recursive: true });
    await writeFile(appImage, "old-appimage", { mode: 0o755 });
    const cache = path.join(root, "cache", "pending");
    await mkdir(cache, { recursive: true });
    const relaunches = [];
    const harness = await registerFakeUpdaterIpc({
      version: "0.17.1",
      platform: "linux",
      arch: "x64",
      env: { APPIMAGE: appImage },
      restartDelayMs: 0,
      relaunchAppImage: (options) => relaunches.push(options),
    });
    harness.updater.downloadUpdate = async () => {
      harness.calls.push("download");
      const downloadedFile = path.join(cache, "omnirush-linux-x86_64-0.17.1.AppImage");
      await writeFile(downloadedFile, "new-appimage");
      harness.listeners.get("update-downloaded")({ version: "0.17.1", downloadedFile });
    };
    return { ...harness, root, appImage, relaunches };
  };

  it("replaces the AppImage file in place and relaunches it once this process exits", async () => {
    const { tempDir, root, handlers, calls, appImage, relaunches } = await appImageHarness();
    try {
      assert.equal((await handlers.get("omnirush:updater:check")(null, "stable")).installMode, "in-place");
      assert.deepEqual(await handlers.get("omnirush:updater:download")(), { ok: true, mode: "in-place" });
      assert.deepEqual(await handlers.get("omnirush:updater:installAndRestart")(), { ok: true, mode: "in-place" });
      assert.equal(await readFile(appImage, "utf8"), "new-appimage", "same path, new contents");
      assert.equal(statSync(appImage).mode & 0o777, 0o755);
      assert.deepEqual(readdirSync(path.dirname(appImage)), [path.basename(appImage)]);
      assert.equal(relaunches.length, 1);
      assert.equal(relaunches[0].appImage, appImage);
      await settle();
      assert.deepEqual(calls, ["download", "quit"], "electron-updater's quitAndInstall is not used");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces the AppImage on quit without relaunching", async () => {
    const { tempDir, root, handlers, calls, appImage, relaunches, prepareInstallOnQuit } = await appImageHarness();
    try {
      await handlers.get("omnirush:updater:check")(null, "stable");
      await handlers.get("omnirush:updater:download")();
      (await prepareInstallOnQuit())();
      await settle();
      assert.equal(await readFile(appImage, "utf8"), "new-appimage");
      assert.deepEqual(relaunches, []);
      assert.deepEqual(calls, ["download", "quit"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Linux package installs", () => {
  it("downloads the .deb to Downloads and gives the install command instead of restarting", async () => {
    const deb = Buffer.from("deb-bytes");
    const resources = await mkdtemp(path.join(os.tmpdir(), "omnirush-resources-"));
    await writeFile(path.join(resources, "package-type"), "deb\n");
    const fetched = [];
    const { tempDir, handlers, calls } = await registerFakeUpdaterIpc({
      version: "0.17.1",
      files: [
        { url: "omnirush-linux-x86_64-0.17.1.AppImage", sha512: "appimage", size: 1 },
        { url: "omnirush-linux-amd64-0.17.1.deb", sha512: sha512Of(deb), size: deb.length },
        { url: "omnirush-linux-x86_64-0.17.1.rpm", sha512: "rpm", size: 1 },
      ],
      platform: "linux",
      arch: "x64",
      env: {},
      resourcesPath: resources,
      electronNet: { fetch: async (url) => {
        fetched.push(url);
        return new Response(deb);
      } },
    });
    try {
      const checked = await handlers.get("omnirush:updater:check")(null, "stable");
      assert.equal(checked.installMode, "package");
      assert.equal(checked.packageKind, "deb");
      const expectedPath = path.join(tempDir, "downloads", "omnirush-linux-amd64-0.17.1.deb");
      const downloaded = await handlers.get("omnirush:updater:download")();
      assert.deepEqual(downloaded, {
        ok: true,
        mode: "package",
        packageKind: "deb",
        path: expectedPath,
        command: `sudo apt install ${expectedPath}`,
      });
      assert.deepEqual(fetched, [`${RELEASE_0171}/omnirush-linux-amd64-0.17.1.deb`]);
      assert.deepEqual(readFileSync(expectedPath), deb);
      const installed = await handlers.get("omnirush:updater:installAndRestart")();
      assert.equal(installed.ok, true);
      assert.equal(installed.mode, "package");
      await settle();
      assert.deepEqual(calls, [], "nothing quits and electron-updater installs nothing");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(resources, { recursive: true, force: true });
    }
  });

  it("reopens the AppImage from outside its mount once the old process exits", async () => {
    const { relaunchAppImageAfterExit, environmentOutsideAppImage } = await import("./self-install.mjs");
    const spawned = [];
    relaunchAppImageAfterExit({
      appImage: "/home/a/Apps/omnirush.AppImage",
      pid: 4242,
      runtimePid: 4241,
      args: ["--no-sandbox"],
      env: {
        APPDIR: "/tmp/.mount_abc",
        APPIMAGE: "/home/a/Apps/omnirush.AppImage",
        LD_LIBRARY_PATH: "/tmp/.mount_abc/usr/lib",
        PATH: "/tmp/.mount_abc:/usr/local/bin:/usr/bin",
        HOME: "/home/a",
        DISPLAY: ":0",
        OMNIRUSH_ELECTRON_REMOTE_DEBUG_PORT: "9223",
      },
      spawnProcess: (command, args, options) => {
        spawned.push({ command, args, options });
        return { unref() {} };
      },
    });
    assert.match(spawned[0].command, /^\/bin\/(ba)?sh$/);
    assert.deepEqual(spawned[0].args.slice(3), ["4242", "4241", "/home/a/Apps/omnirush.AppImage", "--no-sandbox"]);
    assert.equal(spawned[0].options.detached, true);
    // Nothing points into the old mount, which is gone once the app exits.
    assert.deepEqual(spawned[0].options.env, { PATH: "/usr/local/bin:/usr/bin", HOME: "/home/a", DISPLAY: ":0" });
    assert.deepEqual(environmentOutsideAppImage({ PATH: "/usr/bin" }), { PATH: "/usr/bin" });
  });

  it("names the command for each package kind", async () => {
    const { linuxInstallCommand, shellQuote } = await import("./self-install.mjs");
    assert.equal(linuxInstallCommand("deb", "/home/a/Downloads/x.deb"), "sudo apt install /home/a/Downloads/x.deb");
    assert.equal(linuxInstallCommand("rpm", "/home/a/Downloads/x.rpm"), "sudo dnf install /home/a/Downloads/x.rpm");
    assert.equal(linuxInstallCommand("pacman", "/home/a/Downloads/x.pacman"), "sudo pacman -U /home/a/Downloads/x.pacman");
    assert.equal(
      linuxInstallCommand("appimage", "/home/a/Downloads/x.AppImage", "/opt/OmniRush/omnirush.AppImage"),
      "sudo install -m 755 /home/a/Downloads/x.AppImage /opt/OmniRush/omnirush.AppImage",
    );
    assert.equal(linuxInstallCommand(null, "/x"), null);
    assert.equal(shellQuote("/home/o'neil/My Downloads/x.deb"), "'/home/o'\\''neil/My Downloads/x.deb'");
  });
});

describe("restart to update finishes or says why", () => {
  const READ_ONLY = "Cannot update while running on a read-only volume. The application is on a read-only volume. Please move the application and try again.";

  async function stagedInPlace(options = {}) {
    const order = [];
    const registered = await registerFakeUpdaterIpc({
      version: "3.3.3",
      allowQuit: () => order.push("allowQuit"),
      restoreQuitGuard: () => order.push("restoreQuitGuard"),
      ...options,
    });
    assert.equal((await registered.handlers.get("omnirush:updater:check")(null, "stable")).available, true);
    assert.deepEqual(await registered.handlers.get("omnirush:updater:download")(), { ok: true, mode: "in-place" });
    return { ...registered, order };
  }

  it("lets the install through the quit guard before it quits the app", async () => {
    const { tempDir, handlers, updater, order, calls } = await stagedInPlace();
    try {
      const original = updater.quitAndInstall;
      updater.quitAndInstall = (...args) => {
        order.push("quitAndInstall");
        original(...args);
      };
      assert.deepEqual(await handlers.get("omnirush:updater:installAndRestart")(), { ok: true, mode: "in-place" });
      assert.deepEqual(order, ["allowQuit", "quitAndInstall"]);
      assert.deepEqual(calls, ["download", "quitAndInstall"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports an error Squirrel raises after quitAndInstall instead of answering ok", async () => {
    const { tempDir, handlers, updater, listeners, appEvents, order } = await stagedInPlace();
    try {
      let attempts = 0;
      updater.quitAndInstall = () => {
        attempts += 1;
        // Squirrel.Mac answers asynchronously through the updater's error event.
        setTimeout(() => listeners.get("error")(new Error("Code signature at URL did not pass validation")), 5);
      };
      const result = await handlers.get("omnirush:updater:installAndRestart")();
      assert.equal(result.ok, false);
      assert.match(result.reason, /could not be installed: Code signature at URL did not pass validation/);
      assert.deepEqual(order, ["allowQuit", "restoreQuitGuard"], "a failed install re-arms the quit guard");
      // The staged download stays and installTriggered is reset: the button retries.
      updater.quitAndInstall = () => {
        attempts += 1;
        appEvents.emit("before-quit");
      };
      assert.deepEqual(await handlers.get("omnirush:updater:installAndRestart")(), { ok: true, mode: "in-place" });
      assert.equal(attempts, 2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("explains a read-only volume refusal as a move to Applications", async () => {
    const { tempDir, handlers, updater, listeners } = await stagedInPlace();
    try {
      updater.quitAndInstall = () => setTimeout(() => listeners.get("error")(new Error(READ_ONLY)), 5);
      const result = await handlers.get("omnirush:updater:installAndRestart")();
      assert.equal(result.ok, false);
      assert.match(result.reason, /drag it into Applications, open it from there and update again, or download the new version/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("answers ok when Electron's updater announces before-quit-for-update", async () => {
    const nativeUpdater = new EventEmitter();
    const { tempDir, handlers, updater } = await stagedInPlace({ nativeUpdater });
    try {
      updater.quitAndInstall = () => setTimeout(() => nativeUpdater.emit("before-quit-for-update"), 5);
      assert.deepEqual(await handlers.get("omnirush:updater:installAndRestart")(), { ok: true, mode: "in-place" });
      assert.equal(nativeUpdater.listenerCount("before-quit-for-update"), 0, "listeners are removed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("gives up with a message when the install never starts", async () => {
    const { tempDir, handlers, updater, order } = await stagedInPlace({ installStartTimeoutMs: 30 });
    try {
      updater.quitAndInstall = () => {};
      const result = await handlers.get("omnirush:updater:installAndRestart")();
      assert.equal(result.ok, false);
      assert.match(result.reason, /did not start within 0 seconds\. Quit .* and open it again to finish the update, or download the new version/);
      assert.deepEqual(order, ["allowQuit", "restoreQuitGuard"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports a synchronous quitAndInstall throw", async () => {
    const { tempDir, handlers, updater } = await stagedInPlace();
    try {
      updater.quitAndInstall = () => {
        throw new Error("No update filepath provided, can't quit and install");
      };
      const result = await handlers.get("omnirush:updater:installAndRestart")();
      assert.equal(result.ok, false);
      assert.match(result.reason, /No update filepath provided/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("macOS app outside Applications", () => {
  const DMG_BUNDLE = "/Volumes/OmniRush.ai 3.3.2-arm64/OmniRush.ai.app";
  const TRANSLOCATED = "/private/var/folders/xy/T/AppTranslocation/0A1B/d/OmniRush.ai.app";

  async function stagedMac({ bundle = DMG_BUNDLE, readOnly = true, inApplications = false, answer = 1, move = () => true, ...options } = {}) {
    const order = [];
    const dialogs = [];
    const registered = await registerFakeUpdaterIpc({
      version: "3.3.3",
      platform: "darwin",
      isDeveloperIdSigned: async () => true,
      getAppPath: () => `${bundle}/Contents/Resources/app.asar`,
      execPath: `${bundle}/Contents/MacOS/OmniRush.ai`,
      isReadOnlyVolume: async () => readOnly,
      isInApplicationsFolder: () => inApplications,
      moveToApplicationsFolder: () => {
        order.push("move");
        return move();
      },
      showMessageBox: async (options) => {
        dialogs.push(options);
        return { response: answer };
      },
      allowQuit: () => order.push("allowQuit"),
      restoreQuitGuard: () => order.push("restoreQuitGuard"),
      restartDelayMs: 1,
      ...options,
    });
    registered.app.quit = () => order.push("quit");
    assert.equal((await registered.handlers.get("omnirush:updater:check")(null, "stable")).installMode, "in-place");
    assert.deepEqual(await registered.handlers.get("omnirush:updater:download")(), { ok: true, mode: "in-place" });
    return { ...registered, order, dialogs };
  }

  it("from the DMG: asks to move instead of handing Squirrel an update it refuses", async () => {
    const { tempDir, handlers, calls, order, dialogs } = await stagedMac({ answer: 1 });
    try {
      const result = await handlers.get("omnirush:updater:installAndRestart")();
      assert.equal(result.ok, false);
      assert.equal(result.fallback, "move-to-applications");
      assert.match(result.reason, /disk image or the Downloads folder/);
      assert.equal(dialogs.length, 1);
      assert.deepEqual(dialogs[0].buttons, ["Move to Applications", "Cancel"]);
      assert.deepEqual(calls, ["download"], "quitAndInstall never runs from a read-only volume");
      assert.deepEqual(order, []);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("from the DMG: Move to Applications moves the app and quits this copy", async () => {
    const { tempDir, handlers, calls, order } = await stagedMac({ answer: 0 });
    try {
      assert.deepEqual(await handlers.get("omnirush:updater:installAndRestart")(), { ok: true, mode: "moving" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(order, ["allowQuit", "move", "allowQuit", "quit"]);
      assert.deepEqual(calls, ["download"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("a failed move says why and re-arms the quit guard", async () => {
    const { tempDir, handlers, order } = await stagedMac({
      answer: 0,
      move: () => {
        throw new Error("Failed to copy bundle");
      },
    });
    try {
      const result = await handlers.get("omnirush:updater:installAndRestart")();
      assert.equal(result.ok, false);
      assert.match(result.reason, /could not be moved to Applications: Failed to copy bundle/);
      assert.deepEqual(order, ["allowQuit", "move", "restoreQuitGuard"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("App Translocation counts as outside Applications even when the check cannot see a read-only volume", async () => {
    const { tempDir, handlers, calls } = await stagedMac({ bundle: TRANSLOCATED, readOnly: false, answer: 1 });
    try {
      const result = await handlers.get("omnirush:updater:installAndRestart")();
      assert.equal(result.fallback, "move-to-applications");
      assert.deepEqual(calls, ["download"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("in Applications (or any writable folder) installs in place", async () => {
    for (const setup of [
      { bundle: "/Applications/OmniRush.ai.app", readOnly: false, inApplications: true },
      { bundle: "/Users/test/Apps/OmniRush.ai.app", readOnly: false, inApplications: false },
    ]) {
      const { tempDir, handlers, calls, dialogs } = await stagedMac(setup);
      try {
        assert.deepEqual(await handlers.get("omnirush:updater:installAndRestart")(), { ok: true, mode: "in-place" });
        assert.deepEqual(calls, ["download", "quitAndInstall"]);
        assert.equal(dialogs.length, 0);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("asks at launch only when the app cannot update where it is", async () => {
    const blocked = await stagedMac({ answer: 1 });
    const fine = await stagedMac({ bundle: "/Applications/OmniRush.ai.app", readOnly: false, inApplications: true });
    try {
      const asked = await blocked.offerMoveAtLaunch();
      assert.equal(asked.offered, true);
      assert.equal(asked.ok, false);
      assert.deepEqual(blocked.dialogs[0].buttons, ["Move to Applications", "Not Now"]);
      assert.deepEqual(await fine.offerMoveAtLaunch(), { offered: false });
      assert.equal(fine.dialogs.length, 0);
    } finally {
      await rm(blocked.tempDir, { recursive: true, force: true });
      await rm(fine.tempDir, { recursive: true, force: true });
    }
  });

  it("OMNIRUSH_UPDATER_MOVE_ANSWER answers without a dialog", async () => {
    const { tempDir, offerMoveAtLaunch, dialogs, order } = await stagedMac({ env: { OMNIRUSH_UPDATER_MOVE_ANSWER: "move" } });
    try {
      assert.deepEqual(await offerMoveAtLaunch(), { offered: true, ok: true, mode: "moving" });
      assert.equal(dialogs.length, 0);
      assert.ok(order.includes("move"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("quitting from the DMG installs nothing (Squirrel would refuse it)", async () => {
    const { tempDir, prepareInstallOnQuit } = await stagedMac();
    try {
      assert.equal(await prepareInstallOnQuit(), null);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("read-only volume detection", async () => {
  const { isOnReadOnlyVolume } = await import("./self-install.mjs");
  const failing = (code) => async () => {
    const error = new Error(code);
    error.code = code;
    throw error;
  };
  it("EROFS on the bundle's folder is a read-only volume", async () => {
    assert.equal(await isOnReadOnlyVolume("/Volumes/X/OmniRush.ai.app", failing("EROFS")), true);
  });
  it("a folder this user cannot write is not", async () => {
    assert.equal(await isOnReadOnlyVolume("/Applications/OmniRush.ai.app", failing("EACCES")), false);
    assert.equal(await isOnReadOnlyVolume("/Applications/OmniRush.ai.app", async () => undefined), false);
    assert.equal(await isOnReadOnlyVolume(null), false);
  });
});
