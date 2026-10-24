import { describe, expect, test } from "bun:test";

import { patchLines, splitRows } from "../src/react-app/domains/session/commands/changes";

describe("splitRows", () => {
  test("pairs removals with the additions after them and keeps context on both sides", () => {
    const patch = ["@@ -1,4 +1,4 @@", " a", "-b", "-c", "+B", " d", "+e", ""].join("\n");
    const rows = splitRows(patchLines(patch));
    const view = rows.map((row) =>
      row.kind === "line" ? `${row.left?.text ?? "_"}|${row.right?.text ?? "_"}` : `${row.kind}`);
    expect(view).toEqual(["hunk", "a|a", "b|B", "c|_", "d|d", "_|e"]);
    const paired = rows[2];
    expect(paired?.kind === "line" && paired.left?.oldLine).toBe(2);
    expect(paired?.kind === "line" && paired.right?.newLine).toBe(2);
  });

  test("an addition before a removal starts a new pair", () => {
    const rows = splitRows(patchLines(["@@ -1,1 +1,1 @@", "+x", "-y"].join("\n")));
    expect(rows.slice(1).map((row) => row.kind === "line" && `${row.left?.text ?? "_"}|${row.right?.text ?? "_"}`)).toEqual(["_|x", "y|_"]);
  });
});
