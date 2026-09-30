import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { normalizeAsarEntryPath } = require("../scripts/electron-after-pack.cjs");

describe("after-pack asar entry paths", () => {
  it("normalizes Windows separators", () => {
    assert.equal(
      normalizeAsarEntryPath("\\node_modules\\@hono\\node-server\\package.json", "\\"),
      "/node_modules/@hono/node-server/package.json",
    );
  });

  it("leaves POSIX separators unchanged", () => {
    assert.equal(
      normalizeAsarEntryPath("/node_modules/@hono/node-server/package.json", "/"),
      "/node_modules/@hono/node-server/package.json",
    );
  });

  it("normalizes nested node_modules paths", () => {
    assert.equal(
      normalizeAsarEntryPath("\\node_modules\\a\\node_modules\\b\\package.json", "\\"),
      "/node_modules/a/node_modules/b/package.json",
    );
  });
});

describe("after-pack prunes cross-platform better-sqlite3 prebuilds", () => {
  const { prunePrebuildsForTarget } = require("../scripts/electron-after-pack.cjs");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const ALL = [
    "darwin-x64.node", "darwin-arm64.node", "linux-x64.node", "linux-arm64.node",
    "linuxmusl-x64.node", "linuxmusl-arm64.node", "win32-x64.node", "win32-arm64.node",
  ];

  function seed() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prune-prebuilds-"));
    const prebuilds = path.join(root, "resources", "app.asar.unpacked", "node_modules", "better-sqlite3", "prebuilds");
    fs.mkdirSync(prebuilds, { recursive: true });
    for (const name of ALL) fs.writeFileSync(path.join(prebuilds, name), "x");
    return { root, prebuilds };
  }

  const remaining = (dir) => fs.readdirSync(dir).sort();

  it("keeps only win32 prebuilds on a Windows build", () => {
    const { root, prebuilds } = seed();
    prunePrebuildsForTarget({ electronPlatformName: "win32", appOutDir: root });
    assert.deepEqual(remaining(prebuilds), ["win32-arm64.node", "win32-x64.node"]);
    fs.rmSync(root, { recursive: true, force: true });
  });


  it("keeps linux and linuxmusl prebuilds on a Linux build", () => {
    const { root, prebuilds } = seed();
    prunePrebuildsForTarget({ electronPlatformName: "linux", appOutDir: root });
    assert.deepEqual(remaining(prebuilds), ["linux-arm64.node", "linux-x64.node", "linuxmusl-arm64.node", "linuxmusl-x64.node"]);
    fs.rmSync(root, { recursive: true, force: true });
  });
})
