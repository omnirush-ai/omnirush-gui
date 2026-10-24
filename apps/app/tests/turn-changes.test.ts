import { describe, expect, test } from "bun:test";

import { mergeTurnChanges, type ChangedFile } from "../src/react-app/domains/session/commands/changes";
import { turnUserMessageIds } from "../src/react-app/domains/session/commands/turn-messages";

const user = (id: string, parts: unknown[]) => ({ info: { id, role: "user" }, parts });
const assistant = (id: string) => ({ info: { id, role: "assistant" }, parts: [] });
const prompt = (id: string, text: string) => user(id, [{ type: "text", text }]);
const compaction = (id: string) => user(id, [{ type: "compaction" }]);
const resume = (id: string) => user(id, [{ type: "text", text: "Continue", synthetic: true, metadata: { compaction_continue: true } }]);

// Turn A: edits, a mid-turn compaction, more edits. Turn B after it.
const chat = [
  prompt("u1", "fix the parser"), assistant("a1"),
  compaction("u2"), assistant("a2"),
  resume("u3"), assistant("a3"),
  prompt("u4", "now the tests"), assistant("a4"),
];

describe("turnUserMessageIds", () => {
  test("a turn split by a compaction covers its prompt, the compaction and the continue, not the next turn", () => {
    expect(turnUserMessageIds(chat, "u1")).toEqual(["u1", "u2", "u3"]);
    // Opened from the reply after the continue: the same turn.
    expect(turnUserMessageIds(chat, "u3")).toEqual(["u1", "u2", "u3"]);
    expect(turnUserMessageIds(chat, "u4")).toEqual(["u4"]);
  });

  test("a prompt the engine replayed after a compaction belongs to the turn it repeats", () => {
    const replayed = [prompt("p1", "build it"), assistant("x1"), compaction("c1"), assistant("x2"), prompt("p2", "build it"), assistant("x3"), prompt("p3", "next")];
    expect(turnUserMessageIds(replayed, "p2")).toEqual(["p1", "c1", "p2"]);
    expect(turnUserMessageIds(replayed, "p3")).toEqual(["p3"]);
  });

  test("an unknown anchor gives nothing", () => {
    expect(turnUserMessageIds(chat, "a1")).toEqual([]);
    expect(turnUserMessageIds(chat, "nope")).toEqual([]);
  });
});

describe("mergeTurnChanges", () => {
  const file = (path: string, patch: string, additions: number, deletions: number, status: ChangedFile["status"] = "modified"): ChangedFile => ({ path, patch, additions, deletions, status });

  test("edits before and after the compaction both show, each file once", () => {
    const before = [file("src/parser.ts", "@@ -1 +1 @@\n-a\n+b", 1, 1), file("src/new.ts", "@@ -0,0 +1 @@\n+x", 1, 0, "added")];
    const after = [file("src/parser.ts", "@@ -5 +5 @@\n-c\n+d", 1, 1), file("README.md", "@@ -1 +1 @@\n-r\n+R", 1, 1)];
    const merged = mergeTurnChanges([before, [], after]);
    expect(merged.map((f) => f.path)).toEqual(["README.md", "src/new.ts", "src/parser.ts"]);
    const parser = merged.find((f) => f.path === "src/parser.ts");
    expect(parser?.patch).toBe("@@ -1 +1 @@\n-a\n+b\n@@ -5 +5 @@\n-c\n+d");
    expect([parser?.additions, parser?.deletions]).toEqual([2, 2]);
    expect(merged.find((f) => f.path === "src/new.ts")?.status).toBe("added");
  });

  test("added then deleted in one turn reads as modified; deleted last is deleted", () => {
    expect(mergeTurnChanges([[file("a", "p1", 1, 0, "added")], [file("a", "p2", 0, 1, "deleted")]])[0]?.status).toBe("modified");
    expect(mergeTurnChanges([[file("b", "p1", 1, 1)], [file("b", "p2", 0, 3, "deleted")]])[0]?.status).toBe("deleted");
  });
});
