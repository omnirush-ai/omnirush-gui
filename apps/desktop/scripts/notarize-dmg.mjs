#!/usr/bin/env node
/**
 * Notarizes and staples the DMG(s) electron-builder produced, after the app
 * inside was already notarized and stapled by scripts/electron-after-sign.cjs.
 * A stapled DMG passes Gatekeeper offline (`spctl -a -t install`) before the
 * app is even copied out of it.
 *
 * Stapling rewrites the DMG, so its sha512 and size in the update manifest
 * (latest-mac.yml, or a flavor's <channel>-mac.yml) and its .blockmap are
 * regenerated here; scripts/verify-update-manifest.mjs checks them next.
 *
 * Unsigned builds (no Developer ID) are left untouched: the script says why
 * and exits 0, so forks and PR builds keep working.
 *
 * Usage: node scripts/notarize-dmg.mjs [--dist apps/desktop/dist-electron]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const require = createRequire(import.meta.url);
const { notaryCredentialArgs, notarySubmit, stapleAndValidate } = require("./apple-notary.cjs");

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readArg(name, fallback) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function isDeveloperIdSigned(target) {
  const result = spawnSync("codesign", ["--display", "--verbose=2", target], { encoding: "utf8" });
  return /Authority=Developer ID Application/.test(`${result.stdout || ""}${result.stderr || ""}`);
}

function sha512Base64(filePath) {
  return createHash("sha512").update(readFileSync(filePath)).digest("base64");
}

async function rebuildBlockMap(dmgPath) {
  const blockMapPath = `${dmgPath}.blockmap`;
  try {
    const builderRequire = createRequire(require.resolve("electron-builder"));
    const blockmapModule = builderRequire.resolve("app-builder-lib/out/targets/blockmap/blockmap");
    const { buildBlockMap } = builderRequire(blockmapModule);
    const info = await buildBlockMap(dmgPath, "gzip", blockMapPath);
    return { size: info.size, sha512: info.sha512, blockMapSize: info.blockMapSize };
  } catch (error) {
    // The DMG blockmap is not used by the macOS updater (it downloads the zip);
    // a stale one is worse than none, so drop it if it cannot be rebuilt.
    console.warn(`[notarize-dmg] could not rebuild ${path.basename(blockMapPath)} (${error.message}); removing it.`);
    rmSync(blockMapPath, { force: true });
    return { size: statSync(dmgPath).size, sha512: sha512Base64(dmgPath), blockMapSize: undefined };
  }
}

function patchManifests(distDir, dmgName, info) {
  for (const entry of readdirSync(distDir)) {
    if (!/-mac\.yml$/.test(entry)) continue;
    const manifestPath = path.join(distDir, entry);
    const manifest = YAML.parse(readFileSync(manifestPath, "utf8"));
    let changed = false;
    for (const file of Array.isArray(manifest?.files) ? manifest.files : []) {
      if (file?.url !== dmgName) continue;
      file.sha512 = info.sha512;
      file.size = info.size;
      if (info.blockMapSize === undefined) delete file.blockMapSize;
      else file.blockMapSize = info.blockMapSize;
      changed = true;
    }
    if (manifest?.path === dmgName) {
      manifest.sha512 = info.sha512;
      changed = true;
    }
    if (changed) {
      writeFileSync(manifestPath, YAML.stringify(manifest, { lineWidth: 0 }));
      console.log(`[notarize-dmg] updated ${entry} for the stapled ${dmgName}`);
    }
  }
}

async function main() {
  if (process.platform !== "darwin") {
    console.log("[notarize-dmg] skipped: not macOS.");
    return;
  }
  const distDir = path.resolve(readArg("--dist", path.join(desktopRoot, "dist-electron")));
  const dmgs = existsSync(distDir) ? readdirSync(distDir).filter((name) => name.endsWith(".dmg")) : [];
  if (dmgs.length === 0) {
    console.log(`[notarize-dmg] skipped: no .dmg in ${distDir}.`);
    return;
  }
  const credentials = notaryCredentialArgs();
  for (const dmgName of dmgs) {
    const dmgPath = path.join(distDir, dmgName);
    if (!isDeveloperIdSigned(dmgPath)) {
      console.log(`[notarize-dmg] skipped ${dmgName}: not Developer ID signed (no MAC_CSC_LINK secret), so it cannot be notarized.`);
      continue;
    }
    if (!credentials) {
      throw new Error(`${dmgName} is Developer ID signed but no Apple notarization credentials are set.`);
    }
    notarySubmit(dmgPath, credentials);
    await stapleAndValidate(dmgPath);
    patchManifests(distDir, dmgName, await rebuildBlockMap(dmgPath));
  }
}

main().catch((error) => {
  console.error(`[notarize-dmg] ${error.message}`);
  process.exit(1);
});
