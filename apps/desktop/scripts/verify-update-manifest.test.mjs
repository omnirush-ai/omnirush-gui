import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { requiredInstallerExtensions, verifyUpdateManifest } from "./verify-update-manifest.mjs";

const scriptPath = fileURLToPath(new URL("./verify-update-manifest.mjs", import.meta.url));

function sha512(bytes) {
  return createHash("sha512").update(bytes).digest("base64");
}

async function writeFixture({ version = "1.2.3", manifestName = "latest-mac.yml", mutate = (manifest) => manifest } = {}) {
  const distDir = await mkdtemp(path.join(os.tmpdir(), "omnirush-update-manifest-"));
  const zipBytes = Buffer.from(`zip-${version}`);
  const dmgBytes = Buffer.from(`dmg-${version}-payload`);
  const zipName = `omnirush-mac-arm64-${version}.zip`;
  const dmgName = `omnirush-mac-arm64-${version}.dmg`;
  await writeFile(path.join(distDir, zipName), zipBytes);
  await writeFile(path.join(distDir, dmgName), dmgBytes);
  const manifest = mutate({
    version,
    files: [
      { url: zipName, sha512: sha512(zipBytes), size: zipBytes.length },
      { url: dmgName, sha512: sha512(dmgBytes), size: dmgBytes.length },
    ],
    path: zipName,
    sha512: sha512(zipBytes),
    releaseDate: "2026-09-22T16:14:09.051Z",
  });
  const manifestPath = path.join(distDir, manifestName);
  const lines = [
    `version: ${manifest.version}`,
    "files:",
    ...manifest.files.flatMap((file) => [
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
    ]),
    `path: ${manifest.path}`,
    `sha512: ${manifest.sha512}`,
    `releaseDate: '${manifest.releaseDate}'`,
    "",
  ];
  await writeFile(manifestPath, lines.join("\n"), "utf8");
  return { distDir, manifestPath, zipName, dmgName };
}

describe("verifyUpdateManifest", () => {
  it("accepts a manifest whose entries match the packaged assets", async () => {
    const { distDir, manifestPath } = await writeFixture();
    try {
      const result = await verifyUpdateManifest({ manifestPath, expectedVersion: "1.2.3" });
      assert.deepEqual(result.errors, []);
      assert.equal(result.ok, true);
      assert.equal(result.manifest.version, "1.2.3");
    } finally {
      await rm(distDir, { recursive: true, force: true });
    }
  });

  it("rejects a version that differs from the packaged version", async () => {
    const { distDir, manifestPath } = await writeFixture();
    try {
      const result = await verifyUpdateManifest({ manifestPath, expectedVersion: "1.2.4" });
      assert.equal(result.ok, false);
      assert.match(result.errors.join("\n"), /version "1\.2\.3" does not match the packaged version 1\.2\.4/);
    } finally {
      await rm(distDir, { recursive: true, force: true });
    }
  });

  it("rejects checksum, size, and missing-file mismatches", async () => {
    const { distDir, manifestPath, dmgName, zipName } = await writeFixture({
      mutate: (manifest) => ({
        ...manifest,
        files: [
          { ...manifest.files[0], size: manifest.files[0].size + 1 },
          { ...manifest.files[1], sha512: sha512(Buffer.from("tampered")) },
          { url: "omnirush-mac-x64-1.2.3.dmg", sha512: sha512(Buffer.from("missing")), size: 7 },
        ],
      }),
    });
    try {
      const result = await verifyUpdateManifest({ manifestPath, expectedVersion: "1.2.3" });
      assert.equal(result.ok, false);
      const text = result.errors.join("\n");
      assert.match(text, new RegExp(`${zipName}\\) size \\d+ does not match`));
      assert.match(text, new RegExp(`${dmgName}\\) sha512 does not match`));
      assert.match(text, /omnirush-mac-x64-1\.2\.3\.dmg\) does not exist/);
    } finally {
      await rm(distDir, { recursive: true, force: true });
    }
  });

  it("requires the legacy path entry to be listed and to match its checksum", async () => {
    const { distDir, manifestPath } = await writeFixture({
      mutate: (manifest) => ({ ...manifest, path: "omnirush-mac-arm64-9.9.9.zip", sha512: "AAAA" }),
    });
    try {
      const result = await verifyUpdateManifest({ manifestPath, expectedVersion: "1.2.3" });
      assert.equal(result.ok, false);
      const text = result.errors.join("\n");
      assert.match(text, /is not listed under files/);
      assert.match(text, /does not exist/);
    } finally {
      await rm(distDir, { recursive: true, force: true });
    }
  });

  it("requires the installers each platform relies on", async () => {
    assert.deepEqual(requiredInstallerExtensions("latest-mac.yml"), [".zip", ".dmg"]);
    assert.deepEqual(requiredInstallerExtensions("cloud-mac.yml"), [".zip", ".dmg"]);
    assert.deepEqual(requiredInstallerExtensions("latest.yml"), [".exe"]);
    assert.deepEqual(requiredInstallerExtensions("enterprise.yml"), [".exe"]);
    assert.deepEqual(requiredInstallerExtensions("latest-linux.yml"), [".AppImage"]);
    assert.deepEqual(requiredInstallerExtensions("latest-linux-arm64.yml"), [".AppImage"]);

    const { distDir, manifestPath } = await writeFixture({
      manifestName: "latest-linux.yml",
    });
    try {
      const result = await verifyUpdateManifest({ manifestPath, expectedVersion: "1.2.3" });
      assert.equal(result.ok, false);
      assert.match(result.errors.join("\n"), /latest-linux\.yml must list a \.AppImage asset/);
    } finally {
      await rm(distDir, { recursive: true, force: true });
    }
  });

  it("rejects url entries that are not plain file names", async () => {
    const { distDir, manifestPath } = await writeFixture({
      mutate: (manifest) => ({
        ...manifest,
        files: [manifest.files[0], { ...manifest.files[1], url: "https://tampered.invalid/omnirush-mac-arm64-1.2.3.dmg" }],
      }),
    });
    try {
      const result = await verifyUpdateManifest({ manifestPath, expectedVersion: "1.2.3" });
      assert.equal(result.ok, false);
      assert.match(result.errors.join("\n"), /files\[1\] must have a plain file name/);
    } finally {
      await rm(distDir, { recursive: true, force: true });
    }
  });

  it("fails the command when the manifest is missing", async () => {
    const distDir = await mkdtemp(path.join(os.tmpdir(), "omnirush-update-manifest-missing-"));
    try {
      const { code, stderr } = await new Promise((resolve) => {
        execFile(process.execPath, [scriptPath, "--manifest", path.join(distDir, "latest-mac.yml"), "--version", "1.2.3"], (error, stdout, stderrOutput) => {
          resolve({ code: error?.code ?? 0, stdout, stderr: stderrOutput });
        });
      });
      assert.equal(code, 1);
      assert.match(stderr, /Update manifest is missing/);
    } finally {
      await rm(distDir, { recursive: true, force: true });
    }
  });

  it("verifies through the command line with an explicit version", async () => {
    const { distDir, manifestPath } = await writeFixture();
    try {
      const { code, stdout } = await new Promise((resolve) => {
        execFile(process.execPath, [scriptPath, "--manifest", manifestPath, "--version", "v1.2.3"], (error, stdoutOutput, stderr) => {
          resolve({ code: error?.code ?? 0, stdout: stdoutOutput, stderr });
        });
      });
      assert.equal(code, 0);
      assert.equal(JSON.parse(stdout).ok, true);
    } finally {
      await rm(distDir, { recursive: true, force: true });
    }
  });
});
