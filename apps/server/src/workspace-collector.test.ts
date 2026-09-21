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
    const result = redactCollectorText("jane@example.com +1 (415) 555-0132 192.0.2.25");
    expect(result.text).not.toContain("jane@example.com");
    expect(result.text).not.toContain("415");
    expect(result.text).not.toContain("192.0.2.25");
    expect(result.count).toBe(3);
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

  test("does not drop trace events recorded while an upload is in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-race-"));
    roots.push(root);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let traceStarted!: () => void;
    const traceObserved = new Promise<void>((resolve) => { traceStarted = resolve; });
    const uploads: Array<Record<string, unknown>> = [];
    const collector = new WorkspaceCollector({
      upload: async (_sessionId, compressed) => {
        const envelope = JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Record<string, unknown>;
        uploads.push(envelope);
        if (envelope.snapshot_type === "trace" && uploads.filter((item) => item.snapshot_type === "trace").length === 1) {
          traceStarted();
          await blocked;
        }
        return Response.json({ ok: true }, { status: 201 });
      },
      fallbackScanMs: 60_000,
    });
    const sessionId = "session-race-1234";
    collector.startSession(sessionId, "workspace-race", root);
    await new Promise((resolve) => setTimeout(resolve, 40));
    collector.recordTrace(sessionId, "first.event");
    collector.flushTrace(sessionId);
    await traceObserved;
    collector.recordTrace(sessionId, "second.event");
    collector.flushTrace(sessionId);
    release();
    await collector.stop();

    const traceEvents = uploads
      .filter((item) => item.snapshot_type === "trace")
      .flatMap((item) => ((item.files as Array<{ content: string }>)[0]?.content ? JSON.parse((item.files as Array<{ content: string }>)[0].content).events : [])) as Array<{ type: string }>;
    expect(traceEvents.map((event) => event.type)).toContain("first.event");
    expect(traceEvents.map((event) => event.type)).toContain("second.event");
  });

  test("keeps oversized traces valid JSON and marks dropped events", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-truncate-"));
    roots.push(root);
    const uploads: Array<Record<string, unknown>> = [];
    const collector = new WorkspaceCollector({
      upload: async (_sessionId, compressed) => {
        uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Record<string, unknown>);
        return Response.json({ ok: true }, { status: 201 });
      },
      fallbackScanMs: 60_000,
    });
    const sessionId = "session-truncate-1234";
    collector.startSession(sessionId, "workspace-truncate", root);
    collector.recordTrace(sessionId, "huge.event", { text: "x".repeat(5 * 1024 * 1024) });
    collector.flushTrace(sessionId);
    await collector.stop();

    const trace = uploads.find((item) => item.snapshot_type === "trace");
    expect(trace).toBeDefined();
    const traceFile = (trace?.files as Array<{ content: string }>)[0];
    const parsed = JSON.parse(traceFile.content) as { trace_truncated: boolean; dropped_event_count: number };
    expect(parsed.trace_truncated).toBe(true);
    expect(parsed.dropped_event_count).toBeGreaterThanOrEqual(1);
  });

  test("persists session segments and message checkpoints across a resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-resume-"));
    const stateDir = await mkdtemp(join(tmpdir(), "omnirush-collector-state-"));
    roots.push(root, stateDir);
    const uploads: Array<Record<string, unknown>> = [];
    const makeCollector = () => new WorkspaceCollector({
      stateDir,
      upload: async (_sessionId, compressed) => {
        uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Record<string, unknown>);
        return Response.json({ ok: true }, { status: 201 });
      },
      fallbackScanMs: 60_000,
    });
    const sessionId = "session-resume-1234";
    const first = makeCollector();
    first.startSession(sessionId, "workspace-resume", root);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await first.setSessionCheckpoint(sessionId, "message-1");
    await first.stop();

    const second = makeCollector();
    second.startSession(sessionId, "workspace-resume", root);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await second.sessionCheckpoint(sessionId)).toMatchObject({ resumed: true, segment: 2, lastMessageId: "message-1" });
    await second.stop();

    const starts = uploads.filter((item) => item.snapshot_type === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ session_segment: 2, session_resumed: true });
    const traceTypes = uploads
      .filter((item) => item.snapshot_type === "trace")
      .flatMap((item) => JSON.parse((item.files as Array<{ content: string }>)[0].content).events.map((event: { type: string }) => event.type));
    expect(traceTypes).toContain("session.resumed");
  });

  test("captures changed files in a bounded journal before the next snapshot", async () => {
    if (process.platform !== "darwin" && process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-changes-"));
    roots.push(root);
    const uploads: Array<Record<string, unknown>> = [];
    const collector = new WorkspaceCollector({
      upload: async (_sessionId, compressed) => {
        uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Record<string, unknown>);
        return Response.json({ ok: true }, { status: 201 });
      },
      changeDebounceMs: 10,
      fallbackScanMs: 60_000,
    });
    const sessionId = "session-changes-1234";
    collector.startSession(sessionId, "workspace-changes", root);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await writeFile(join(root, "created.txt"), "contact jane@example.com");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await collector.stop();

    const change = uploads.find((item) => item.snapshot_type === "change");
    expect(change).toBeDefined();
    const changeFile = (change?.files as Array<{ path: string; content: string }>).find((file) => file.path === "__omnirush__/changes.json");
    expect(changeFile).toBeDefined();
    expect(changeFile?.content).toContain('"path":"created.txt"');
    expect(changeFile?.content).not.toContain("jane@example.com");
  });
});
