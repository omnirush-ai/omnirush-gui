import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const dirname = path.dirname(fileURLToPath(import.meta.url));

async function readConfig(name) {
  return YAML.parse(await readFile(path.resolve(dirname, "..", name), "utf8"));
}

describe("Electron distribution configs", () => {
  it("uses a stable Linux desktop identity and ships integration icons", async () => {
    const packageMetadata = JSON.parse(
      await readFile(path.resolve(dirname, "..", "package.json"), "utf8"),
    );
    const config = await readConfig("electron-builder.base.yml");
    assert.equal(packageMetadata.desktopName, "ai.omnirush.desktop");
    assert.equal(config.npmRebuild, false);
    assert.deepEqual(config.files.at(-1), {
      from: ".electron-runtime/node_modules",
      to: "node_modules",
    });
    assert.equal(config.linux.syncDesktopName, true);
    assert.equal(config.linux.icon, "resources/icons/linux");
    assert.deepEqual(config.linux.extraResources[0], {
      from: "resources/icons/linux",
      to: "icons/linux",
      filter: ["*.png"],
    });
  });

  it("keeps the public artifact and protocol unchanged", async () => {
    const config = await readConfig("electron-builder.yml");
    assert.equal(config.extends, "./electron-builder.base.yml");
    assert.equal(config.appId, "ai.omnirush.desktop");
    assert.equal(config.productName, "OmniRush.ai");
    assert.equal(config.protocols[0].schemes[0], "omnirush");
    assert.equal(config.artifactName, "omnirush-${os}-${arch}-${version}.${ext}");
  });

  it("defines an enterprise flavor with the standard app identity and release provider", async () => {
    const config = await readConfig("electron-builder.enterprise.yml");
    assert.equal(config.extends, "./electron-builder.base.yml");
    assert.equal(config.appId, "ai.omnirush.desktop");
    assert.equal(config.productName, "OmniRush.ai Enterprise");
    assert.equal(config.extraMetadata.omnirushDistribution, "enterprise");
    assert.equal(config.protocols[0].schemes[0], "omnirush");
    assert.equal(config.publish[0].provider, "github");
    assert.equal(config.publish[0].owner, "omnirush-ai");
    assert.equal(config.publish[0].repo, "omnirush-gui");
    assert.equal(config.publish[0].channel, "enterprise");
    assert.equal(
      config.artifactName,
      "omnirush-enterprise-${os}-${arch}-${version}.${ext}",
    );
  });

  it("defines a Cloud flavor with its own artifacts and updater channel", async () => {
    const config = await readConfig("electron-builder.cloud.yml");
    assert.equal(config.extends, "./electron-builder.base.yml");
    assert.equal(config.appId, "ai.omnirush.desktop");
    assert.equal(config.productName, "OmniRush.ai Cloud");
    assert.equal(config.extraMetadata.omnirushDistribution, "cloud");
    assert.equal(config.protocols[0].schemes[0], "omnirush");
    assert.equal(config.publish[0].channel, "cloud");
    assert.equal(
      config.artifactName,
      "omnirush-cloud-${os}-${arch}-${version}.${ext}",
    );
  });

  it("signs with the hardened runtime and keeps the main app's entitlements minimal", async () => {
    const config = await readConfig("electron-builder.base.yml");
    assert.equal(config.mac.hardenedRuntime, true);
    assert.equal(config.mac.notarize, false, "notarization runs in scripts/electron-after-sign.cjs");
    assert.equal(config.mac.entitlements, "build/entitlements.mac.plist");
    assert.equal(config.mac.entitlementsInherit, "build/entitlements.mac.inherit.plist");
    const keys = (text) => [...text.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]).sort();
    const main = await readFile(path.resolve(dirname, "..", config.mac.entitlements), "utf8");
    const inherit = await readFile(path.resolve(dirname, "..", config.mac.entitlementsInherit), "utf8");
    // codesign's entitlements parser (AMFIUnserializeXML) rejects XML comments.
    assert.doesNotMatch(main, /<!--/);
    assert.doesNotMatch(inherit, /<!--/);
    assert.deepEqual(keys(main), ["com.apple.security.cs.allow-jit", "com.apple.security.device.audio-input"]);
    assert.deepEqual(keys(inherit), [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.device.audio-input",
    ]);
  });

  it("signs every Windows binary with SHA-256 and an RFC 3161 timestamp", async () => {
    const config = await readConfig("electron-builder.base.yml");
    assert.deepEqual(config.win.signExts, [
      ".dll",
      ".node",
      "!versions.json-x86_64-pc-windows-msvc.exe",
      "!versions.json-aarch64-pc-windows-msvc.exe",
    ]);
    assert.deepEqual(config.win.signtoolOptions.signingHashAlgorithms, ["sha256"]);
    assert.match(config.win.signtoolOptions.rfc3161TimeStampServer, /^http:\/\/timestamp\./);
    assert.equal(config.win.verifyUpdateCodeSignature, true);
    assert.equal(config.nsis.perMachine, false);
    assert.equal(config.copyright, "Copyright © OmniRush.ai");
  });
});

