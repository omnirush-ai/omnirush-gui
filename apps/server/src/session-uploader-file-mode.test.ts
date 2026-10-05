import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filterUploadDiff, redactDiffByFile, redactUploadJson } from "./session-uploader.js";

// The scrubber's file-aware trace pass: code that file tools write, replace,
// patch or read, and each file's hunk of a diff, is scrubbed with the mode its
// file's path selects, as the file's snapshot is; everything else in the trace
// stays CONFIG. The cases in __fixtures__/scrub-file-mode.json are shared byte
// for byte with the CLI (test/fixtures/scrub-file-mode.json) and the backend
// (tests/omnirush/fixtures/scrub_file_mode.json), so the three scrubbers give
// the same output.
type Case = { name: string; kind: "trace" | "git_diff"; input: unknown; expected: unknown };
const cases = JSON.parse(readFileSync(join(import.meta.dir, "__fixtures__", "scrub-file-mode.json"), "utf8")) as Case[];

const plain = (value: unknown): any => JSON.parse(JSON.stringify(value));
const scrubTrace = (document: unknown): any => plain(redactUploadJson(document, { fileAware: true }).value);
const TS1 = "export async function f(token:string){await fetch(u)}";
const TS2 = "const g = async(token:string)=>{}\nfunction a(token:string){await b}";

function toolEvent(tool: string, state: Record<string, unknown>) {
  return { schema_version: 1, events: [{ type: "turn.messages", data: { messages: [{ info: { role: "assistant" }, parts: [{ type: "tool", tool, state }] }] } }] };
}
const stateOf = (document: any): any => document.events[0].data.messages[0].parts[0].state;

describe("scrub parity fixture", () => {
  for (const entry of cases) {
    test(entry.name, () => {
      const actual = entry.kind === "trace" ? scrubTrace(entry.input) : filterUploadDiff(entry.input as string).diff;
      expect(actual).toEqual(entry.expected);
    });
  }
});

describe("file-aware trace scrub", () => {
  test("a .ts edit/write keeps both code examples intact, real or escaped newlines", () => {
    const edit = stateOf(scrubTrace(toolEvent("edit", { input: { filePath: "/w/src/a.ts", oldString: TS1, newString: TS2 } })));
    expect(edit.input.oldString).toBe(TS1);
    expect(edit.input.newString).toBe(TS2);
    const escaped = JSON.stringify([{ oldText: "x", newText: TS2 }]);
    expect(escaped).toContain("\\nfunction");
    const patch = stateOf(scrubTrace(toolEvent("edit", { input: { path: "src/a.ts", edits: escaped } })));
    expect(patch.input.edits).toBe(escaped);
    const write = stateOf(scrubTrace(toolEvent("write", { input: { filePath: "src/b.tsx", content: `${TS1}\n${TS2}` } })));
    expect(write.input.content).toBe(`${TS1}\n${TS2}`);
  });

  test("the same code in a bash command, a pathless write or other JSON stays CONFIG", () => {
    const bash = stateOf(scrubTrace(toolEvent("bash", { input: { command: TS1 }, output: TS2 })));
    expect(bash.input.command).toBe("export async function f(token:[REDACTED] fetch(u)}");
    expect(bash.output).toBe("const g = async(token:[REDACTED]\nfunction a(token:[REDACTED] b}");
    expect(stateOf(scrubTrace(toolEvent("write", { input: { content: TS1 } }))).input.content).toContain("[REDACTED]");
    const legacy = plain(redactUploadJson(toolEvent("write", { input: { filePath: "a.ts", content: TS1 } })).value);
    expect(stateOf(legacy).input.content).toContain("[REDACTED]");
  });

  test("real secrets are still removed from file tool content in every mode", () => {
    expect(stateOf(scrubTrace(toolEvent("write", { input: { filePath: ".env", content: "API_TOKEN=abcdefgh123" } }))).input.content).toBe("API_TOKEN=[REDACTED]");
    expect(stateOf(scrubTrace(toolEvent("write", { input: { filePath: "src/k.ts", content: 'const k = "sk-proj-AAAAAAAAAAAAAAAAAAAA"' } }))).input.content)
      .toBe('const k = "[REDACTED]"');
    for (const shape of [
      "ghp_AAAAAAAAAAAAAAAAAAAAAAAA",
      "AKIAABCDEFGHIJKLMNOP",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
      "Authorization: Bearer abcDEF1234567890xyzQ",
      "postgres://user:hunter2pass@db.example.com/app",
      "mail jane.doe@acme-mail.io",
    ]) {
      const state = stateOf(scrubTrace(toolEvent("edit", { input: { filePath: "src/x.py", oldString: "a", newString: shape } })));
      expect(state.input.newString).not.toBe(shape);
      expect(state.input.newString).toMatch(/\[REDACTED(?:_PII)?\]/);
    }
  });

  test("a diff with a .ts hunk and a .env hunk scrubs each with its own mode", () => {
    const diff = `Index: src/a.ts\n--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n+${TS1}\nIndex: .env\n--- .env\n+++ .env\n@@ -0,0 +1 @@\n+API_TOKEN=abcdefgh123\n+${TS1}\n`;
    expect(redactDiffByFile(diff, null)).toBe(
      `Index: src/a.ts\n--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n+${TS1}\nIndex: .env\n--- .env\n+++ .env\n@@ -0,0 +1 @@\n+API_TOKEN=[REDACTED]\n+export async function f(token:[REDACTED] fetch(u)}\n`,
    );
    expect(redactDiffByFile(`+${TS1}\n`, "a.ts")).toBe(`+${TS1}\n`);
    expect(redactDiffByFile(`+${TS1}\n`, null)).toContain("[REDACTED]");
    expect(filterUploadDiff("diff --git a/.env b/.env\n+API_TOKEN=abcdefgh123\n").diff).toBeNull();
  });
});
