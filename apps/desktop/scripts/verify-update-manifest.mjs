#!/usr/bin/env node
/**
 * Verifies an electron-builder update manifest (latest-mac.yml, latest.yml,
 * latest-linux.yml, or a distribution's <channel>*.yml) against the packaged
 * assets next to it. electron-updater reads that manifest to discover an
 * update, so a release that ships without it, or whose checksums do not match
 * the uploaded installers, silently breaks in-app updates. The release
 * workflow runs this before uploading anything.
 *
 * Usage:
 *   node scripts/verify-update-manifest.mjs --manifest <path> [--dist <dir>] [--version X.Y.Z]
 *
 * `--dist` defaults to the manifest's directory and `--version` to the version
 * in apps/desktop/package.json (stamped by scripts/release/stamp-version.mjs).
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export function readDesktopPackageVersion(rootDir = desktopRoot) {
  return JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
}

/**
 * Every manifest must list the installers the app relies on: Squirrel.Mac
 * needs the zip and the unsigned-build fallback opens the DMG; NSIS installs
 * from the exe; Linux updates replace the AppImage.
 */
export function requiredInstallerExtensions(manifestName) {
  if (/-mac\.yml$/.test(manifestName)) return [".zip", ".dmg"];
  if (/-linux(?:-arm64)?\.yml$/.test(manifestName)) return [".AppImage"];
  return [".exe"];
}

function sha512Base64(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("base64")));
  });
}

function isPlainFileName(value) {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && value === path.basename(value)
    && !value.includes("/")
    && !value.includes("\\")
    && !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

export async function verifyUpdateManifest({
  manifestPath,
  distDir = path.dirname(manifestPath),
  expectedVersion = readDesktopPackageVersion(),
}) {
  const errors = [];
  const manifestName = path.basename(manifestPath);
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: [`Update manifest is missing: ${manifestPath}`], manifest: null };
  }
  let manifest;
  try {
    manifest = YAML.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`Update manifest is not valid YAML: ${error?.message ?? error}`], manifest: null };
  }
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, errors: ["Update manifest is empty."], manifest: null };
  }

  if (String(manifest.version ?? "") !== String(expectedVersion)) {
    errors.push(`Manifest version ${JSON.stringify(manifest.version ?? null)} does not match the packaged version ${expectedVersion}.`);
  }

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length === 0) errors.push("Manifest lists no files.");
  const digests = new Map();
  const listedNames = new Set();
  for (const [index, file] of files.entries()) {
    const label = `files[${index}]`;
    if (!file || typeof file !== "object" || !isPlainFileName(file.url)) {
      errors.push(`${label} must have a plain file name in url.`);
      continue;
    }
    listedNames.add(file.url);
    const filePath = path.join(distDir, file.url);
    if (typeof file.sha512 !== "string" || !BASE64_PATTERN.test(file.sha512) || Buffer.from(file.sha512, "base64").length !== 64) {
      errors.push(`${label} (${file.url}) must carry a base64 sha512.`);
    }
    if (!Number.isInteger(file.size) || file.size <= 0) {
      errors.push(`${label} (${file.url}) must carry a positive integer size.`);
    }
    if (!existsSync(filePath)) {
      errors.push(`${label} (${file.url}) does not exist in ${distDir}.`);
      continue;
    }
    const actualSize = statSync(filePath).size;
    if (Number.isInteger(file.size) && actualSize !== file.size) {
      errors.push(`${label} (${file.url}) size ${file.size} does not match the file on disk (${actualSize}).`);
    }
    const digest = await sha512Base64(filePath);
    digests.set(file.url, digest);
    if (typeof file.sha512 === "string" && digest !== file.sha512) {
      errors.push(`${label} (${file.url}) sha512 does not match the file on disk.`);
    }
  }

  if (!isPlainFileName(manifest.path)) {
    errors.push("Manifest path must be a plain file name.");
  } else {
    const legacyPath = path.join(distDir, manifest.path);
    if (!listedNames.has(manifest.path)) {
      errors.push(`Manifest path ${manifest.path} is not listed under files.`);
    }
    if (!existsSync(legacyPath)) {
      errors.push(`Manifest path ${manifest.path} does not exist in ${distDir}.`);
    } else {
      const digest = digests.get(manifest.path) ?? await sha512Base64(legacyPath);
      if (typeof manifest.sha512 !== "string" || digest !== manifest.sha512) {
        errors.push(`Manifest sha512 does not match ${manifest.path} on disk.`);
      }
    }
  }

  const releaseDate = typeof manifest.releaseDate === "string" ? Date.parse(manifest.releaseDate) : Number.NaN;
  if (!Number.isFinite(releaseDate)) {
    errors.push("Manifest releaseDate must be an ISO-8601 date.");
  }

  for (const extension of requiredInstallerExtensions(manifestName)) {
    if (![...listedNames].some((name) => name.endsWith(extension))) {
      errors.push(`${manifestName} must list a ${extension} asset.`);
    }
  }

  return { ok: errors.length === 0, errors, manifest };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest" || arg === "--dist" || arg === "--version") {
      options[arg.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.manifest) throw new Error("Usage: verify-update-manifest.mjs --manifest <path> [--dist <dir>] [--version X.Y.Z]");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(options.manifest);
  const result = await verifyUpdateManifest({
    manifestPath,
    ...(options.dist ? { distDir: path.resolve(options.dist) } : {}),
    ...(options.version ? { expectedVersion: options.version.replace(/^v/, "") } : {}),
  });
  if (!result.ok) {
    console.error(`Update manifest verification failed for ${manifestPath}:`);
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  const files = (result.manifest.files ?? []).map((file) => file.url);
  console.log(JSON.stringify({ ok: true, manifest: manifestPath, version: result.manifest.version, files }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
