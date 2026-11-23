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
  it("keeps Windows shortcuts across updates and puts back a deleted desktop shortcut on reinstall", async () => {
    const config = await readConfig("electron-builder.base.yml");
    assert.equal(config.nsis.include, "build/installer.nsh");
    assert.equal(config.nsis.createDesktopShortcut, "always");
    const script = await readFile(path.resolve(dirname, "..", "build", "installer.nsh"), "utf8");
    const uninstall = script.slice(script.indexOf("!macro customUnInstall"), script.indexOf("!macroend"));
    assert.match(uninstall, /\$\{ifNot\} \$\{isUpdated\}[\s\S]*Delete "\$1"[\s\S]*\$\{endIf\}/, "an update must not delete the Start menu shortcut");
    const install = script.slice(script.indexOf("!macro customInstall"));
    assert.match(install, /\$\{ifNot\} \$\{FileExists\} "\$newStartMenuLink"[\s\S]*CreateShortCut "\$newStartMenuLink"/);
  });

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

  it("lets macOS ask for the camera and microphone for calls in the built-in browser", async () => {
    const config = await readConfig("electron-builder.base.yml");
    assert.match(config.mac.extendInfo.NSCameraUsageDescription, /camera/);
    assert.match(config.mac.extendInfo.NSMicrophoneUsageDescription, /microphone/);
    const entitlements = await readFile(path.resolve(dirname, "..", "build", "entitlements.mac.plist"), "utf8");
    const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((match) => match[1]);
    assert.ok(keys.includes("com.apple.security.device.camera"));
    assert.ok(keys.includes("com.apple.security.device.audio-input"));
  });

  it("disables the Node debugging and NODE_OPTIONS fuses but keeps run-as-node", async () => {
    const config = await readConfig("electron-builder.base.yml");
    assert.deepEqual(config.electronFuses, {
      runAsNode: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true,
    });
  });

  it("ships only architecture-specific sidecars for every desktop OS", async () => {
    const config = await readConfig("electron-builder.base.yml");
    const cases = [
      ["mac", "opencode2", "opencode2-aarch64-apple-darwin", "opencode2-x86_64-apple-darwin"],
      ["linux", "opencode2", "opencode2-aarch64-unknown-linux-gnu", "opencode2-x86_64-unknown-linux-gnu"],
      ["win", "opencode2.exe", "opencode2-aarch64-pc-windows-msvc.exe", "opencode2-x86_64-pc-windows-msvc.exe"],
    ];
    for (const [platform, genericName, arm64Name, x64Name] of cases) {
      const sidecars = config[platform].extraResources.find((resource) => resource.to === "sidecars");
      assert.ok(sidecars, `${platform} sidecar resource is missing`);
      assert.ok(sidecars.filter.includes(arm64Name), `${platform} arm64 sidecar is missing`);
      assert.ok(sidecars.filter.includes(x64Name), `${platform} x64 sidecar is missing`);
      assert.ok(!sidecars.filter.includes(genericName), `${platform} generic sidecar alias is still packaged`);
    }
  });

  it("keeps the public artifact and protocol unchanged", async () => {
    const config = await readConfig("electron-builder.yml");
    assert.equal(config.extends, "./electron-builder.base.yml");
    assert.equal(config.appId, "ai.omnirush.desktop");
    assert.equal(config.productName, "omnirush");
    assert.equal(config.win.executableName, "OmniRush.ai");
    assert.equal(config.protocols[0].schemes[0], "omnirush");
    assert.equal(config.artifactName, "omnirush-${os}-${arch}-${version}.${ext}");
    // Published package names, so upgrades replace the installed package.
    assert.equal(config.deb.packageName, "omnirush.ai");
    assert.equal(config.rpm.packageName, "OmniRush.ai");
    assert.equal(config.pacman.packageName, "omnirush");
  });

  it("lays out the macOS installer window on a Retina-ready background", async () => {
    const { dmg } = await readConfig("electron-builder.yml");
    const size = async (file) => {
      const png = await readFile(path.resolve(dirname, "..", file));
      return [png.readUInt32BE(16), png.readUInt32BE(20)];
    };
    assert.deepEqual(await size(dmg.background), [dmg.window.width, dmg.window.height]);
    assert.deepEqual(
      await size(dmg.background.replace(/\.png$/, "@2x.png")),
      [dmg.window.width * 2, dmg.window.height * 2],
    );
    assert.deepEqual(
      dmg.contents.map(({ type, path: target }) => [type, target]),
      [["file", undefined], ["link", "/Applications"]],
    );
    assert.ok(dmg.contents[0].x < dmg.contents[1].x);
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
});
