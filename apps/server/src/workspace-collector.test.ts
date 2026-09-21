import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";

import { WorkspaceCollector, isCollectorPathDenied, redactCollectorText } from "./workspace-collector.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace collector privacy", () => {
  test("denies repository internals and credential files", () => {
    for (const path of [".git/config", ".env.local", "node_modules/pkg/index.js", ".ssh/config", "keys/service.json", "cert.pem"]) {
      expect(isCollectorPathDenied(path)).toBe(true);
    }
    expect(isCollectorPathDenied("src/app.ts")).toBe(false);
  });

  test("redacts private keys and provider-style secrets before upload", () => {
    const result = redactCollectorText([
      "AWS_ACCESS_KEY_ID=AKIA1234567890123456",
      "OPENAI_API_KEY=sk-1234567890abcdefghijklmnop",
      "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----",
    ].join("\n"));
    expect(result.text).not.toContain("AKIA1234567890123456");
    expect(result.text).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(result.text).not.toContain("private\n");
    expect(result.count).toBeGreaterThanOrEqual(3);
  });

  test("scrubs common personal identifiers before upload", () => {
    const result = redactCollectorText("jane@example.com +1 (415) 555-0132");
    expect(result.text).not.toContain("jane@example.com");
    expect(result.text).not.toContain("415");
    expect(result.count).toBe(2);
  });

  test("uploads correlated start, trace, and end artifacts without ignored or binary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-"));
    roots.push(root);
    await execFileAsync("git", ["init", "-q", root]);
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", ".gitignore"), "ignored-nested.txt\n");
    await writeFile(join(root, "app.txt"), "hello sk-1234567890abcdefghijklmnop\n");
    await writeFile(join(root, "ignored.txt"), "do not upload\n");
    await writeFile(join(root, ".env.local"), "PASSWORD=secret-value\n");
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, "nested", "ignored-nested.txt"), "do not upload\n");

    const uploads: Array<{ sessionId: string; envelope: Record<string, unknown> }> = [];
    const collector = new WorkspaceCollector({
      upload: async (sessionId, compressed) => {
        uploads.push({
          sessionId,
          envelope: JSON.parse(zstdDecompressSync(compressed).toString("utf8")),
        });
        return Response.json({ ok: true }, { status: 201 });
      },
      changeDebounceMs: 10,
      fallbackScanMs: 60_000,
    });
    const sessionId = "session-test-1234";
    collector.startSession(sessionId, "workspace-test", root);
    collector.recordTrace(sessionId, "tool.call", { token: "sk-1234567890abcdefghijklmnop" });
    collector.flushTrace(sessionId);
    await collector.stop();

    expect(uploads.map((upload) => upload.envelope.snapshot_type)).toEqual(["start", "trace", "end"]);
    expect(uploads.every((upload) => upload.sessionId === sessionId)).toBe(true);
    const paths = uploads.flatMap((upload) => (upload.envelope.files as Array<{ path: string }>).map((file) => file.path));
    expect(paths).toContain("app.txt");
    expect(paths).not.toContain("ignored.txt");
    expect(paths).not.toContain("nested/ignored-nested.txt");
    expect(paths).not.toContain(".env.local");
    expect(paths).not.toContain("binary.dat");
    expect(JSON.stringify(uploads)).not.toContain("sk-1234567890abcdefghijklmnop");
  });
});
