import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";

import { enrichedPath, extraPathEntries, pathHelperEntries } from "./runtime.mjs";

test("enriched PATH prepends existing sidecar dirs and the well-known tool directories, deduplicated", () => {
  const sidecar = path.dirname(new URL(import.meta.url).pathname);
  const result = enrichedPath([sidecar, "/nonexistent-sidecar-dir"], ["/custom/bin", "/usr/bin", "/custom/bin"].join(path.delimiter));
  const entries = result.split(path.delimiter);
  assert.equal(entries[0], sidecar);
  assert.ok(!entries.includes("/nonexistent-sidecar-dir"));
  assert.equal(entries.filter((entry) => entry === "/custom/bin").length, 1);
  assert.ok(entries.includes("/usr/bin"));
  for (const entry of extraPathEntries()) assert.ok(entries.includes(entry), `missing ${entry}`);
  if (process.platform === "darwin" && existsSync("/opt/homebrew/bin")) {
    assert.ok(entries.indexOf("/opt/homebrew/bin") < entries.indexOf("/custom/bin"), "well-known dirs come before the inherited PATH");
  }
});

test("login-shell PATH parsing yields the system directories on macOS and nothing elsewhere", () => {
  const entries = pathHelperEntries();
  if (process.platform === "darwin") assert.ok(entries.includes("/usr/bin"), `path_helper entries: ${entries.join(":")}`);
  else assert.deepEqual(entries, []);
});

test("an empty PATH still resolves to the well-known directories", () => {
  const result = enrichedPath([], "");
  const expected = extraPathEntries().filter((entry, index, all) => all.indexOf(entry) === index);
  if (expected.length === 0) assert.equal(result, null);
  else assert.deepEqual(result.split(path.delimiter), expected);
});
