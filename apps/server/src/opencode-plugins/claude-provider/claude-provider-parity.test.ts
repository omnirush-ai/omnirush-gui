// The Claude Code engine provider is the same pair of files in omnirush-cli
// (assets/claude-provider/) and here; PARITY.sha256 lists their hashes in both
// repositories, so a change in one shows up here until it is ported.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("CLI/desktop parity: Claude Code provider", () => {
  test("claude-provider/PARITY.sha256 matches its files", () => {
    const rows = readFileSync(path.join(import.meta.dir, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
    expect(rows.map((row) => row.split(/\s+/)[1])).toEqual(["index.js", "map.js"]);
    for (const row of rows) {
      const [hash, name] = row.split(/\s+/);
      const actual = createHash("sha256").update(readFileSync(path.join(import.meta.dir, name ?? ""))).digest("hex");
      expect(`${name} ${actual}`).toBe(`${name} ${hash}`);
    }
  });
});
