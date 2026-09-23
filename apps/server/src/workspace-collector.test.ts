import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";

import {
  COLLECTOR_SCHEMA_VERSION,
  MAX_COLLECTOR_ATTACHMENT_TEXT_BYTES,
  MAX_COLLECTOR_DIFF_BYTES,
  MAX_COLLECTOR_FILE_BYTES,
  MAX_COLLECTOR_FILES,
  MAX_COLLECTOR_TRACE_BYTES,
  MAX_COLLECTOR_TRACE_EVENTS,
  MAX_COLLECTOR_WEB_VISIT_TEXT_BYTES,
  WorkspaceCollector,
  mapBounded,
  clampCollectorBytes,
  clampCollectorText,
  collectGitBlock,
  diffHeaderPath,
  filterCollectorDiff,
  isCollectableWebUrl,
  isCollectorPathDenied,
  isPathLikeKey,
  isSecretAssignmentKey,
  isSecretAssignmentValue,
  redactCollectorContent,
  redactCollectorJson,
  redactCollectorJsonText,
  redactCollectorText,
  redactModeForPath,
  stripRemoteUserinfo,
  workspaceRelativePath,
} from "./workspace-collector.js";

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
    collector.recordTrace(sessionId, "huge.event", { text: "x".repeat(MAX_COLLECTOR_TRACE_BYTES + 1024 * 1024) });
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
    await collector.idle(sessionId);
    await writeFile(join(root, "created.txt"), "contact jane@example.com");
    collector.recordTrace(sessionId, "file.read", { path: "created.txt" });
    collector.flushTrace(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await collector.stop();

    const change = uploads.find((item) => item.snapshot_type === "change");
    expect(change).toBeDefined();
    const changeFile = (change?.files as Array<{ path: string; content: string }>).find((file) => file.path === "__omnirush__/changes.json");
    expect(changeFile).toBeDefined();
    expect(changeFile?.content).toContain('"path":"created.txt"');
    expect(changeFile?.content).not.toContain("jane@example.com");
  });

  test("records a privacy manifest and touched paths without uploading denied files", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-manifest-"));
    roots.push(root);
    await writeFile(join(root, "touched.ts"), "export const ok = true;");
    await writeFile(join(root, ".env.local"), "SECRET=do-not-upload");
    const uploads: Array<Record<string, unknown>> = [];
    const collector = new WorkspaceCollector({
      upload: async (_sessionId, compressed) => {
        uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Record<string, unknown>);
        return Response.json({ ok: true }, { status: 201 });
      },
      fallbackScanMs: 60_000,
    });
    const sessionId = "session-manifest-1234";
    collector.startSession(sessionId, "workspace-manifest", root);
    collector.recordTrace(sessionId, "file.read", { path: "touched.ts" });
    collector.flushTrace(sessionId);
    await collector.stop();
    const start = uploads.find((item) => item.snapshot_type === "start");
    const workspaceFile = (start?.files as Array<{ path: string; content: string }>).find((file) => file.path === "__omnirush__/workspace.json");
    expect(workspaceFile?.content).toContain('"capture_policy":"consented_workspace_session"');
    expect(workspaceFile?.content).toContain('"touched_paths":["touched.ts"]');
    expect(JSON.stringify(uploads)).not.toContain("do-not-upload");
  });

  test("keeps paths outside the workspace root out of capture: parents, other Windows drives and UNC shares", async () => {
    // Windows: path.relative returns a path on another drive as it is, which a `../` check let through.
    const windowsRoot = "C:\\Users\\dev\\omnirush.ai";
    for (const outside of [
      "D:\\data\\file.csv",
      "D:/data/file.csv",
      "d:\\data\\file.csv",
      "D:file.csv",
      "\\\\server\\share\\file.csv",
      "C:\\Users\\dev\\other\\file.csv",
      "C:\\Users\\dev\\omnirush.ai-other\\file.csv",
      "..\\file.csv",
      "src\\..\\..\\file.csv",
      windowsRoot,
    ]) {
      expect([outside, workspaceRelativePath(windowsRoot, outside, win32)]).toEqual([outside, null]);
    }
    expect(workspaceRelativePath(windowsRoot, "C:\\Users\\dev\\omnirush.ai\\src\\app.ts", win32)).toBe("src/app.ts");
    expect(workspaceRelativePath(windowsRoot, "c:\\users\\dev\\omnirush.ai\\src\\app.ts", win32)).toBe("src/app.ts");
    expect(workspaceRelativePath(windowsRoot, "src/app.ts", win32)).toBe("src/app.ts");
    // POSIX.
    for (const outside of ["/etc/hosts", "../ws-other/file.csv", "..", "/home/dev/ws"]) {
      expect([outside, workspaceRelativePath("/home/dev/ws", outside, posix)]).toEqual([outside, null]);
    }
    expect(workspaceRelativePath("/home/dev/ws", "/home/dev/ws/..notes.md", posix)).toBe("..notes.md");
    expect(workspaceRelativePath("/home/dev/ws", "src/app.ts", posix)).toBe("src/app.ts");

    // Through the collector: a tool naming a file outside the root reads nothing of it.
    const base = await mkdtemp(join(tmpdir(), "omnirush-collector-outside-"));
    roots.push(base);
    const root = join(base, "workspace");
    await mkdir(root);
    await writeFile(join(base, "outside.csv"), "OUTSIDE_FILE_MARKER");
    await writeFile(join(root, "inside.txt"), "inside");
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 10, fallbackScanMs: 60_000 });
    const sessionId = "session-outside-1234";
    collector.startSession(sessionId, "workspace-outside", root);
    await collector.idle(sessionId);
    collector.recordTrace(sessionId, "file.read", { path: join(base, "outside.csv") });
    collector.recordTrace(sessionId, "file.read", { path: "../outside.csv" });
    collector.recordTrace(sessionId, "file.read", { path: "inside.txt" });
    collector.flushTrace(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await collector.stop();
    expect(uploads.at(-1)?.touched_paths).toEqual(["inside.txt"]);
    const files = uploads.flatMap((envelope) => envelope.files);
    expect(files.some((file) => file.content.includes("OUTSIDE_FILE_MARKER"))).toBe(false);
    expect(files.filter((file) => file.path === "__omnirush__/changes.json").map((file) => file.content).join()).not.toContain("outside.csv");
  });

  test("reports every path the session touches inside the root to the project archive, denied names too, and none outside", async () => {
    const base = await mkdtemp(join(tmpdir(), "omnirush-collector-touched-"));
    roots.push(base);
    const root = join(base, "workspace");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(base, "outside.csv"), "OUTSIDE");
    await writeFile(join(root, "docs/brief.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2]));
    const touched: Array<[string, string]> = [];
    const { upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 10, fallbackScanMs: 60_000, onPathTouched: (sessionId, path) => touched.push([sessionId, path]) });
    const sessionId = "session-touched-1234";
    collector.startSession(sessionId, "workspace-touched", root);
    await collector.idle(sessionId);
    // The agent reads a PDF (absolute path, in a tool input), names a file outside, and a credential file.
    collector.recordTrace(sessionId, "tool.read", { input: { filePath: join(root, "docs/brief.pdf") } });
    collector.recordTrace(sessionId, "tool.read", { path: join(base, "outside.csv") });
    collector.recordTrace(sessionId, "tool.read", { path: "../outside.csv" });
    collector.recordTrace(sessionId, "tool.read", { path: ".env" });
    // A command writes a binary: the watcher sees it land.
    await writeFile(join(root, "render.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
    const deadline = Date.now() + 10_000;
    while (!touched.some(([, path]) => path === "render.png") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    await collector.stop();
    const paths = new Set(touched.map(([, path]) => path));
    expect(touched.every(([id]) => id === sessionId)).toBe(true);
    for (const path of ["docs/brief.pdf", ".env", "render.png"]) expect(paths.has(path)).toBe(true);
    expect([...paths].filter((path) => path.includes("outside") || path.startsWith("..") || path.startsWith("/"))).toEqual([]);
  });

  test("reports only what the session touches when its start snapshot was refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-touched-refused-"));
    roots.push(root);
    await mkdir(join(root, "private"));
    await writeFile(join(root, "private/ledger.csv"), "untouched\n");
    await writeFile(join(root, "private/scan.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2]));
    await writeFile(join(root, "notes.md"), "untouched\n");
    // macOS delivers writes made just before a watch starts to the new watcher: these files predate the session.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const touched: string[] = [];
    const types: string[] = [];
    // The backend refuses the start snapshot (a 400 is never spooled), so no manifest is accepted.
    const upload = async (_sessionId: string, compressed: Uint8Array) => {
      const type = (JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as { snapshot_type: string }).snapshot_type;
      types.push(type);
      return type === "start" ? Response.json({ error: "bad_request" }, { status: 400 }) : Response.json({ ok: true }, { status: 201 });
    };
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 10, fallbackScanMs: 60_000, onPathTouched: (_sessionId, path) => touched.push(path) });
    const sessionId = "session-touched-refused-1";
    collector.startSession(sessionId, "workspace-touched-refused", root);
    await collector.idle(sessionId);
    collector.captureSnapshot(sessionId, "prompt");
    await writeFile(join(root, "result.txt"), "the agent's output\n");
    const deadline = Date.now() + 10_000;
    while (!touched.includes("result.txt") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    await collector.stop();
    expect(types[0]).toBe("start");
    // Later captures scanned the whole tree with no accepted baseline.
    expect(types).toContain("end");
    expect(touched).toContain("result.txt");
    expect([...new Set(touched)].filter((path) => path !== "result.txt")).toEqual([]);
  });
});

// --- collector envelope v2 ---------------------------------------------------

type Envelope = Record<string, unknown> & {
  files: Array<{ path: string; content: string; sha256: string }>;
  manifest: Array<{ path: string; sha256: string; size: number }>;
  workspace: { root_name: string; git: Record<string, unknown> | null };
  environment: Record<string, unknown>;
  privacy: Record<string, unknown>;
  touched_paths: string[];
  trace?: Array<{ type: string; data?: Record<string, unknown> }>;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function makeUploads() {
  const uploads: Envelope[] = [];
  const upload = async (_sessionId: string, compressed: Uint8Array) => {
    uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Envelope);
    return Response.json({ ok: true }, { status: 201 });
  };
  return { uploads, upload };
}

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, "-c", "commit.gpgsign=false", "-c", "user.name=Dev", "-c", "user.email=dev@example.com", ...args]);
  return String(stdout).trim();
}

describe("workspace collector envelope v2", () => {
  test("uploads a v2 envelope with trigger, environment, manifest, hashed files and privacy fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-v2-"));
    roots.push(root);
    await writeFile(join(root, "app.ts"), "export const answer = 42;\n");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "note.md"), "call me at +1 (415) 555-0132\n");
    await writeFile(join(root, ".env"), "TOKEN=nope\n");
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, fallbackScanMs: 60_000, appVersion: "1.2.3", engineVersion: "9.9.9" });
    const sessionId = "session-v2-envelope-1";
    collector.startSession(sessionId, "workspace-v2", root);
    collector.recordTrace(sessionId, "file.read", { path: "app.ts" });
    collector.flushTrace(sessionId);
    await collector.stop();

    expect(uploads.map((item) => [item.snapshot_type, item.trigger])).toEqual([
      ["start", "session_start"],
      ["trace", "trace_flush"],
      ["end", "session_end"],
    ]);
    for (const envelope of uploads) {
      expect(envelope.schema_version).toBe(COLLECTOR_SCHEMA_VERSION);
      expect(typeof envelope.captured_at).toBe("string");
      expect(Number.isNaN(Date.parse(envelope.captured_at as string))).toBe(false);
      expect(envelope.workspace.root_name).toBe(basename(root));
      expect(envelope.environment).toMatchObject({
        os: process.platform,
        arch: process.arch,
        app_version: "1.2.3",
        engine_version: "9.9.9",
      });
      for (const key of ["os_version", "node_version", "shell", "locale", "timezone", "git_version"]) {
        expect(key in envelope.environment).toBe(true);
      }
      expect(envelope.privacy).toMatchObject({ capture_policy: "consented_workspace_session", git_internals_excluded: true, environment_variables_excluded: true });
      expect(envelope.touched_paths).toEqual(["app.ts"]);
      for (const file of envelope.files) expect(file.sha256).toBe(sha256(file.content));
    }
    const start = uploads[0]!;
    expect(start.workspace.git).toBeNull();
    expect(start.manifest.map((entry) => entry.path).sort()).toEqual(["app.ts", "nested/note.md"]);
    for (const entry of start.manifest) {
      const file = start.files.find((candidate) => candidate.path === entry.path);
      expect(file).toBeDefined();
      expect(file?.sha256).toBe(entry.sha256);
      expect(entry.size).toBe(Buffer.byteLength(file!.content));
    }
    // Hashes and timestamps can legitimately contain "415"; the number itself must be gone.
    expect(JSON.stringify(uploads)).not.toContain("(415)");
    expect(JSON.stringify(uploads)).not.toContain("555-0132");
    expect(JSON.stringify(uploads)).not.toContain("TOKEN=nope");
    const trace = uploads[1]!;
    expect(Array.isArray(trace.trace)).toBe(true);
    expect(trace.trace?.map((event) => event.type)).toContain("file.read");
    expect(trace.manifest).toEqual([]);
  });

  test("summarises a git repository without shipping internals or remote credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-git-"));
    roots.push(root);
    await git(root, "init", "-q");
    await git(root, "remote", "add", "origin", "https://oauth2:ghp_secrettoken123456@github.com/acme/widgets.git");
    await git(root, "remote", "add", "mirror", "git@github.com:acme/widgets-mirror.git");
    await writeFile(join(root, "app.txt"), "line one\n");
    await writeFile(join(root, "credentials.json"), '{"password":"hunter2-committed"}\n');
    await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 4]));
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "initial commit by jane@example.com");
    await writeFile(join(root, "app.txt"), "line one\nline two added\n");
    await writeFile(join(root, "credentials.json"), '{"password":"hunter2-modified"}\n');
    await writeFile(join(root, "blob.bin"), Buffer.from([0, 9, 9, 9, 9, 9]));
    await writeFile(join(root, ".env.local"), "TOKEN=abcdef123456\n");
    await writeFile(join(root, "staged.txt"), "staged content\n");
    await git(root, "add", "staged.txt");
    const head = await git(root, "rev-parse", "HEAD");
    const branch = await git(root, "branch", "--show-current");

    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, fallbackScanMs: 60_000 });
    const sessionId = "session-v2-git-1";
    collector.startSession(sessionId, "workspace-git", root);
    await collector.stop();

    const start = uploads.find((item) => item.snapshot_type === "start")!;
    const gitBlock = start.workspace.git as {
      commit: string; branch: string; dirty: boolean; upstream: string | null; ahead: number | null; behind: number | null;
      remotes: Array<{ name: string; url: string }>; recent_commits: Array<{ sha: string; at: string; subject: string }>;
      status: Array<{ code: string; path: string }>; diff: string; diff_truncated: boolean;
    };
    expect(gitBlock.commit).toBe(head);
    expect(gitBlock.branch).toBe(branch);
    expect(gitBlock.dirty).toBe(true);
    expect(gitBlock.upstream).toBeNull();
    expect(gitBlock.ahead).toBeNull();
    expect(gitBlock.behind).toBeNull();
    expect([...gitBlock.remotes].sort((left, right) => left.name.localeCompare(right.name))).toEqual([
      { name: "mirror", url: "github.com:acme/widgets-mirror.git" },
      { name: "origin", url: "https://github.com/acme/widgets.git" },
    ]);
    expect(gitBlock.recent_commits).toHaveLength(1);
    expect(gitBlock.recent_commits[0]).toMatchObject({ sha: head, subject: "initial commit by [REDACTED_PII]" });
    expect(Number.isNaN(Date.parse(gitBlock.recent_commits[0]!.at))).toBe(false);
    const statusPaths = gitBlock.status.map((entry) => entry.path);
    expect(gitBlock.status).toContainEqual({ code: " M", path: "app.txt" });
    expect(gitBlock.status).toContainEqual({ code: "A ", path: "staged.txt" });
    expect(statusPaths).not.toContain("credentials.json");
    expect(statusPaths).not.toContain(".env.local");
    expect(gitBlock.diff).toContain("+line two added");
    expect(gitBlock.diff).toContain("+staged content");
    expect(gitBlock.diff).not.toContain("credentials.json");
    expect(gitBlock.diff).not.toContain("blob.bin");
    expect(gitBlock.diff).not.toContain("Binary files");
    expect(gitBlock.diff_truncated).toBe(false);
    expect(start.manifest.map((entry) => entry.path).sort()).toEqual(["app.txt", "staged.txt"]);
    const serialized = JSON.stringify(uploads);
    for (const forbidden of ["ghp_secrettoken123456", "oauth2:", "hunter2", "abcdef123456", "jane@example.com", ".git/"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("caps the git diff and flags truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-bigdiff-"));
    roots.push(root);
    await git(root, "init", "-q");
    await writeFile(join(root, "big.txt"), "seed\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "seed");
    const lines: string[] = [];
    for (let index = 0; index < 40_000; index += 1) lines.push(`line ${index} ${"x".repeat(60)}`);
    await writeFile(join(root, "big.txt"), `${lines.join("\n")}\n`);

    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, fallbackScanMs: 60_000 });
    collector.startSession("session-v2-bigdiff-1", "workspace-bigdiff", root);
    await collector.stop();

    const gitBlock = uploads[0]!.workspace.git as { diff: string; diff_truncated: boolean };
    expect(gitBlock.diff_truncated).toBe(true);
    expect(Buffer.byteLength(gitBlock.diff)).toBeLessThanOrEqual(MAX_COLLECTOR_DIFF_BYTES);
    expect(gitBlock.diff).toContain("+line 0 ");
  });

  test("scopes the git block to a workspace nested inside a larger repository", async () => {
    const repo = await mkdtemp(join(tmpdir(), "omnirush-collector-nested-"));
    roots.push(repo);
    await git(repo, "init", "-q");
    await mkdir(join(repo, "pkg-a"));
    await mkdir(join(repo, "pkg-b"));
    await writeFile(join(repo, "pkg-a", "a.txt"), "a1\n");
    await writeFile(join(repo, "pkg-b", "b.txt"), "b1\n");
    await writeFile(join(repo, ".netrc"), "machine example.com login jane password hunter2-netrc\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "initial");
    await writeFile(join(repo, "pkg-b", "b.txt"), "b1\nOUTSIDE-COMMIT\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "OUTSIDE-COMMIT touches pkg-b only");
    await writeFile(join(repo, "pkg-a", "a.txt"), "a1\na2 INSIDE-CHANGE\n");
    await writeFile(join(repo, "pkg-a", "new.txt"), "untracked\n");
    await writeFile(join(repo, "pkg-b", "b.txt"), "b2 OUTSIDE-CHANGE\n");
    await writeFile(join(repo, ".netrc"), "machine example.com login jane password hunter2-CHANGED\n");
    const head = await git(repo, "rev-parse", "HEAD");

    // A monorepo package: only its own subtree, with workspace-relative paths
    // that line up with the manifest.
    const block = (await collectGitBlock(join(repo, "pkg-a")))!;
    expect(block).not.toBeNull();
    expect(block.commit).toBe(head);
    expect(block.dirty).toBe(true);
    expect([...block.status].sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      { code: " M", path: "a.txt" },
      { code: "??", path: "new.txt" },
    ]);
    expect(block.diff).toContain("diff --git a/a.txt b/a.txt");
    expect(block.diff).toContain("+a2 INSIDE-CHANGE");
    expect(block.recent_commits.map((commit) => commit.subject)).toEqual(["initial"]);
    const serialized = JSON.stringify(block);
    for (const forbidden of ["OUTSIDE", "pkg-a/", "pkg-b", ".netrc", "hunter2"]) {
      expect(serialized).not.toContain(forbidden);
    }

    // A plain project folder under a repository root (a home directory kept
    // in a dotfiles repo): nothing beyond the folder itself is described.
    await mkdir(join(repo, "projects", "foo"), { recursive: true });
    await writeFile(join(repo, "projects", "foo", "notes.txt"), "hello\n");
    const nested = (await collectGitBlock(join(repo, "projects", "foo")))!;
    expect(nested).not.toBeNull();
    expect(nested.diff).toBeNull();
    expect(nested.diff_truncated).toBe(false);
    expect(nested.dirty).toBe(false);
    expect(nested.recent_commits).toEqual([]);
    for (const entry of nested.status) {
      expect(entry.code).toBe("??");
      expect(entry.path.startsWith("notes.txt") || entry.path === "./").toBe(true);
    }
    const nestedSerialized = JSON.stringify(nested);
    for (const forbidden of ["OUTSIDE", "projects", "pkg-", ".netrc", "hunter2"]) {
      expect(nestedSerialized).not.toContain(forbidden);
    }
  });

  test("clamps git metadata to the collector's field limits after redaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-limits-"));
    roots.push(root);
    await git(root, "init", "-q");
    await git(root, "checkout", "-q", "-b", `feature/${Array.from({ length: 6 }, () => "x".repeat(100)).join("/")}`);
    await git(root, "remote", "add", "origin", `https://example.com/${"r".repeat(2_100)}.git`);
    await writeFile(join(root, "a.txt"), "a\n");
    await git(root, "add", "-A");
    // 980 characters before redaction; every short address becomes the longer
    // [REDACTED_PII] marker, so only the post-redaction length breaks the cap.
    await git(root, "commit", "-q", "-m", "a@b.io ".repeat(140).trim());

    const block = (await collectGitBlock(root))!;
    expect(block).not.toBeNull();
    expect(block.recent_commits).toHaveLength(1);
    const subject = block.recent_commits[0]!.subject;
    expect(subject).not.toContain("a@b.io");
    expect(subject.startsWith("[REDACTED_PII]")).toBe(true);
    expect(Array.from(subject)).toHaveLength(1_024);
    expect(Array.from(block.branch!)).toHaveLength(512);
    expect(block.branch!.startsWith("feature/")).toBe(true);
    expect(block.remotes).toHaveLength(1);
    expect(Array.from(block.remotes[0]!.url)).toHaveLength(2_048);
    expect(block.remotes[0]!.url.startsWith("https://example.com/")).toBe(true);
  });

  test("captures prompt and turn_completed snapshots only when the workspace changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-triggers-"));
    roots.push(root);
    await writeFile(join(root, "a.txt"), "alpha\n");
    await writeFile(join(root, "b.txt"), "beta\n");
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    const sessionId = "session-v2-triggers-1";
    collector.startSession(sessionId, "workspace-triggers", root);
    collector.captureSnapshot(sessionId, "prompt");
    await collector.idle(sessionId);
    expect(uploads.map((item) => item.snapshot_type)).toEqual(["start"]);

    await writeFile(join(root, "a.txt"), "alpha changed\n");
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    expect(uploads.map((item) => [item.snapshot_type, item.trigger])).toEqual([["start", "session_start"], ["change", "turn_completed"]]);
    const change = uploads[1]!;
    const changedPaths = change.files.map((file) => file.path).filter((path) => !path.startsWith("__omnirush__/"));
    expect(changedPaths).toEqual(["a.txt"]);
    expect(change.files.find((file) => file.path === "a.txt")?.sha256).toBe(sha256("alpha changed\n"));
    expect(change.manifest.map((entry) => entry.path).sort()).toEqual(["a.txt", "b.txt"]);
    expect(change.manifest.find((entry) => entry.path === "a.txt")?.sha256).toBe(sha256("alpha changed\n"));
    expect(change.manifest.find((entry) => entry.path === "b.txt")?.sha256).toBe(sha256("beta\n"));

    collector.captureSnapshot(sessionId, "prompt");
    await collector.idle(sessionId);
    collector.flushTrace(sessionId);
    await collector.stop();
    const triggers = uploads
      .filter((item) => item.snapshot_type === "trace")
      .flatMap((item) => item.trace ?? [])
      .filter((event) => event.type === "collector.trigger")
      .map((event) => event.data);
    expect(triggers).toEqual([
      { trigger: "prompt", captured: false },
      { trigger: "turn_completed", captured: true },
      { trigger: "prompt", captured: false },
    ]);
    const end = uploads.find((item) => item.snapshot_type === "end")!;
    expect(end.files.map((file) => file.path).filter((path) => !path.startsWith("__omnirush__/"))).toEqual([]);
  });
});

describe("workspace collector durable retry", () => {
  test("spools failed uploads to disk with a failure ledger and delivers them once the gateway recovers", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-spool-"));
    const stateDir = await mkdtemp(join(tmpdir(), "omnirush-collector-spool-state-"));
    roots.push(root, stateDir);
    await writeFile(join(root, "app.txt"), "hello\n");
    const uploads: Envelope[] = [];
    let healthy = false;
    const warnings: string[] = [];
    const collector = new WorkspaceCollector({
      stateDir,
      upload: async (_sessionId, compressed) => {
        if (!healthy) return Response.json({ error: "unavailable" }, { status: 503 });
        uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Envelope);
        return Response.json({ ok: true }, { status: 201 });
      },
      log: (level, message) => { if (level === "warn") warnings.push(message); },
      fallbackScanMs: 60_000,
      uploadRetryDelayMs: 1,
      retryBaseMs: 60_000,
    });
    const sessionId = "session-spool-1234";
    collector.startSession(sessionId, "workspace-spool", root);
    await collector.idle(sessionId);

    expect(uploads).toHaveLength(0);
    expect(await collector.spoolStatus()).toMatchObject({ entries: 1 });
    expect(warnings).toContain("OmniRush collection artifact spooled for retry");
    const spoolDir = join(stateDir, "omnirush-collector-spool");
    const names = (await readdir(spoolDir)).sort();
    expect(names.some((name) => name.endsWith(".json"))).toBe(true);
    expect(names.some((name) => name.endsWith(".zst"))).toBe(true);
    if (process.platform !== "win32") {
      for (const name of names) expect((await stat(join(spoolDir, name))).mode & 0o777).toBe(0o600);
      expect((await stat(spoolDir)).mode & 0o777).toBe(0o700);
    }
    const ledger = JSON.parse(await readFile(join(stateDir, "omnirush-collector-sessions.json"), "utf8")) as { sessions: Record<string, Record<string, unknown>> };
    expect(ledger.sessions[sessionId]).toMatchObject({ failureCount: 1, nextSequence: 1 });
    expect(typeof ledger.sessions[sessionId]?.lastFailureAt).toBe("string");
    expect(await collector.sessionDeliveryStatus(sessionId)).toMatchObject({ failureCount: 1, lastSuccessAt: null });

    healthy = true;
    expect(await collector.drainSpool()).toEqual({ delivered: 1, pending: 0 });
    expect(uploads.map((item) => [item.snapshot_type, item.trigger, item.sequence])).toEqual([["start", "session_start", 1]]);
    expect(await collector.spoolStatus()).toEqual({ entries: 0, bytes: 0 });
    await collector.stop();
    expect(uploads.map((item) => [item.snapshot_type, item.sequence])).toEqual([["start", 1], ["end", 2]]);
    expect(await collector.spoolStatus()).toEqual({ entries: 0, bytes: 0 });
    const settled = JSON.parse(await readFile(join(stateDir, "omnirush-collector-sessions.json"), "utf8")) as { sessions: Record<string, Record<string, unknown>> };
    expect(typeof settled.sessions[sessionId]?.lastSuccessAt).toBe("string");
    expect(settled.sessions[sessionId]).toMatchObject({ failureCount: 1 });
  });

  test("retries spooled uploads with backoff on the next collector start", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-respool-"));
    const stateDir = await mkdtemp(join(tmpdir(), "omnirush-collector-respool-state-"));
    roots.push(root, stateDir);
    await writeFile(join(root, "app.txt"), "hello\n");
    const sessionId = "session-respool-1234";
    const first = new WorkspaceCollector({
      stateDir,
      upload: async () => { throw new Error("network down"); },
      fallbackScanMs: 60_000,
      uploadRetryDelayMs: 1,
      retryBaseMs: 60_000,
    });
    first.startSession(sessionId, "workspace-respool", root);
    await first.stop();
    expect(await first.spoolStatus()).toMatchObject({ entries: 2 });

    const { uploads, upload } = makeUploads();
    const second = new WorkspaceCollector({ stateDir, upload, fallbackScanMs: 60_000, retryBaseMs: 10, retryMaxMs: 20 });
    for (let attempt = 0; attempt < 100 && uploads.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(uploads.map((item) => [item.snapshot_type, item.trigger, item.sequence])).toEqual([["start", "session_start", 1], ["end", "session_end", 2]]);
    expect(await second.spoolStatus()).toEqual({ entries: 0, bytes: 0 });
    await second.stop();
  });

  test("bounds the spool, drops permanently rejected uploads and clears on request", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-spoolcap-"));
    const stateDir = await mkdtemp(join(tmpdir(), "omnirush-collector-spoolcap-state-"));
    roots.push(root, stateDir);
    await writeFile(join(root, "app.txt"), "v0\n");
    let status = 503;
    const collector = new WorkspaceCollector({
      stateDir,
      upload: async () => Response.json({ error: "nope" }, { status }),
      fallbackScanMs: 60_000,
      changeDebounceMs: 60_000,
      uploadRetryDelayMs: 1,
      retryBaseMs: 60_000,
      spoolMaxEntries: 2,
    });
    const sessionId = "session-spoolcap-1234";
    collector.startSession(sessionId, "workspace-spoolcap", root);
    await collector.idle(sessionId);
    for (let version = 1; version <= 3; version += 1) {
      await writeFile(join(root, "app.txt"), `v${version}\n`);
      collector.captureSnapshot(sessionId, "turn_completed");
      await collector.idle(sessionId);
    }
    expect(await collector.spoolStatus()).toMatchObject({ entries: 2 });
    const spoolDir = join(stateDir, "omnirush-collector-spool");
    const sequences = (await Promise.all((await readdir(spoolDir)).filter((name) => name.endsWith(".json"))
      .map(async (name) => (JSON.parse(await readFile(join(spoolDir, name), "utf8")) as { sequence: number }).sequence))).sort();
    expect(sequences).toEqual([3, 4]);

    status = 400;
    await writeFile(join(root, "app.txt"), "v4\n");
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    expect(await collector.spoolStatus()).toMatchObject({ entries: 2 });
    expect(await collector.sessionDeliveryStatus(sessionId)).toMatchObject({ failureCount: 5 });

    await collector.clearSpool();
    expect(await collector.spoolStatus()).toEqual({ entries: 0, bytes: 0 });
    await collector.stop();
  });
});

describe("workspace collector git helpers", () => {
  test("clamps text by code points without splitting surrogate pairs", () => {
    expect(clampCollectorText("abc", 5)).toBe("abc");
    expect(clampCollectorText("abcdef", 3)).toBe("abc");
    const faces = "\u{1F600}".repeat(4);
    expect(clampCollectorText(faces, 4)).toBe(faces);
    expect(clampCollectorText(faces, 3)).toBe("\u{1F600}".repeat(3));
    expect(Array.from(clampCollectorText("y".repeat(2_000), 1_024))).toHaveLength(1_024);
  });

  test("strips userinfo from scheme and scp-like remotes", () => {
    expect(stripRemoteUserinfo("https://user:pass@example.com/org/repo.git")).toBe("https://example.com/org/repo.git");
    expect(stripRemoteUserinfo("ssh://git@example.com:2222/org/repo.git")).toBe("ssh://example.com:2222/org/repo.git");
    expect(stripRemoteUserinfo("git@example.com:org/repo.git")).toBe("example.com:org/repo.git");
    expect(stripRemoteUserinfo("https://example.com/org/repo.git")).toBe("https://example.com/org/repo.git");
    expect(stripRemoteUserinfo("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });

  test("parses plain and quoted diff headers", () => {
    expect(diffHeaderPath("diff --git a/src/app.ts b/src/app.ts")).toBe("src/app.ts");
    expect(diffHeaderPath("diff --git a/with space.txt b/with space.txt")).toBe("with space.txt");
    expect(diffHeaderPath('diff --git "a/caf\\303\\251 \\"x\\".txt" "b/caf\\303\\251 \\"x\\".txt"')).toBe('café "x".txt');
    expect(diffHeaderPath("diff --git a/one.txt b/two.txt")).toBeNull();
    expect(diffHeaderPath("not a header")).toBeNull();
  });

  test("filters denied and binary diff sections and redacts the rest", () => {
    const raw = [
      "diff --git a/app.ts b/app.ts",
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -1 +1 @@",
      "-const key = 'old';",
      "+const key = 'sk-1234567890abcdefghijklmnop';",
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1 +1 @@",
      "+PASSWORD=super-secret-value",
      "diff --git a/blob.bin b/blob.bin",
      "Binary files a/blob.bin and b/blob.bin differ",
      "diff --git a/keys/service.json b/keys/service.json",
      "+{\"private\":true}",
      "",
    ].join("\n");
    const result = filterCollectorDiff(raw);
    expect(result.truncated).toBe(false);
    expect(result.diff).toContain("diff --git a/app.ts b/app.ts");
    expect(result.diff).toContain("[REDACTED]");
    expect(result.diff).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(result.diff).not.toContain(".env");
    expect(result.diff).not.toContain("super-secret-value");
    expect(result.diff).not.toContain("blob.bin");
    expect(result.diff).not.toContain("keys/service.json");
    expect(filterCollectorDiff("")).toEqual({ diff: null, truncated: false });
    expect(filterCollectorDiff("diff --git a/x b/x\n+ok\n", true).truncated).toBe(true);
  });
});

// --- collector trace additions (contract v2) --------------------------------

function traceEvents(uploads: Envelope[]): Array<{ type: string; data?: Record<string, unknown> }> {
  return uploads.filter((item) => item.snapshot_type === "trace").flatMap((item) => item.trace ?? []);
}

describe("workspace collector trace additions", () => {
  test("raises the caps to the contract values", () => {
    expect(MAX_COLLECTOR_FILE_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_COLLECTOR_DIFF_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_COLLECTOR_FILES).toBe(50_000);
    expect(MAX_COLLECTOR_WEB_VISIT_TEXT_BYTES).toBe(64 * 1024);
    expect(MAX_COLLECTOR_ATTACHMENT_TEXT_BYTES).toBe(256 * 1024);
  });

  test("keeps uploading every snapshot of a session that has already sent more than 512 MiB", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-nocap-"));
    const stateDir = await mkdtemp(join(tmpdir(), "omnirush-collector-nocap-state-"));
    roots.push(root, stateDir);
    await writeFile(join(root, "app.txt"), "v0\n");
    const sessionId = "session-nocap-1234";
    // The session ledger stands in for the running total of a long session:
    // it says 600 MiB were already accepted (past the 512 MiB per-session cap
    // the collector used to stop at) without any of that data being written.
    const sentBefore = 600 * 1024 * 1024;
    await writeFile(join(stateDir, "omnirush-collector-sessions.json"), JSON.stringify({
      version: 1,
      sessions: { [sessionId]: { segment: 1, nextSequence: 40, sentBytes: sentBefore, lastSeenAt: new Date().toISOString() } },
    }));
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ stateDir, upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    collector.startSession(sessionId, "workspace-nocap", root);
    await collector.idle(sessionId);
    await writeFile(join(root, "app.txt"), "v1\n");
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    collector.recordTrace(sessionId, "file.read", { path: "app.txt" });
    collector.flushTrace(sessionId);
    await collector.stop();

    // Sequence 41 onwards: the seeded total was loaded, and nothing was held back.
    expect(uploads.map((item) => [item.snapshot_type, item.trigger, item.sequence])).toEqual([
      ["start", "resume", 41],
      ["change", "turn_completed", 42],
      ["trace", "trace_flush", 43],
      ["end", "session_end", 44],
    ]);
    expect(uploads[0]!.files.find((file) => file.path === "app.txt")?.content).toBe("v0\n");
    expect(uploads[1]!.files.find((file) => file.path === "app.txt")?.content).toBe("v1\n");
    expect(traceEvents(uploads).some((event) => event.type === "file.read")).toBe(true);
    for (const envelope of uploads) expect(envelope.privacy).not.toHaveProperty("max_session_bytes");
    const metadata = JSON.parse(uploads[0]!.files.find((file) => file.path === "__omnirush__/workspace.json")!.content) as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("max_session_bytes");
    // The running total is still counted, for diagnostics only.
    const ledger = JSON.parse(await readFile(join(stateDir, "omnirush-collector-sessions.json"), "utf8")) as { sessions: Record<string, { sentBytes: number }> };
    expect(ledger.sessions[sessionId]!.sentBytes).toBeGreaterThan(sentBefore);
  });

  test("records the turn model and child sessions with checkpoints that survive a resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-children-"));
    const stateDir = await mkdtemp(join(tmpdir(), "omnirush-collector-children-state-"));
    roots.push(root, stateDir);
    await writeFile(join(root, "app.txt"), "hello\n");
    const { uploads, upload } = makeUploads();
    const makeCollector = () => new WorkspaceCollector({ stateDir, upload, fallbackScanMs: 60_000 });
    const sessionId = "session-children-1234";

    const first = makeCollector();
    first.startSession(sessionId, "workspace-children", root);
    await first.idle(sessionId);
    expect(uploads.map((item) => item.snapshot_type)).toEqual(["start"]);
    expect(uploads[0]!.session).toEqual({ provider_id: null, model_id: null, variant: null, child_session_ids: [] });
    first.recordSessionModel(sessionId, { provider_id: "anthropic", model_id: "claude-sonnet-4-5", variant: "high", agent: "build" });
    first.recordChildSession(sessionId, {
      childSessionId: "ses_child_1",
      parentSessionId: sessionId,
      title: "Subtask",
      agent: "explore",
      messages: [{ info: { id: "cmsg_1", role: "user", sessionID: "ses_child_1" }, parts: [{ type: "text", text: "find jane@example.com" }] }],
      lastMessageId: "cmsg_1",
    });
    first.recordChildSession(sessionId, {
      childSessionId: "ses_grandchild_1",
      parentSessionId: "ses_child_1",
      title: null,
      agent: null,
      messages: [],
      lastMessageId: null,
    });
    first.flushTrace(sessionId);
    await first.idle(sessionId);
    expect(await first.childCheckpoints(sessionId)).toEqual({ ses_child_1: "cmsg_1" });
    expect(await first.childSessionIds(sessionId)).toEqual(["ses_child_1", "ses_grandchild_1"]);
    await first.stop();

    expect(uploads.map((item) => item.snapshot_type)).toEqual(["start", "trace", "end"]);
    const events = traceEvents(uploads);
    expect(events.find((event) => event.type === "session.model")?.data).toEqual({
      provider_id: "anthropic", model_id: "claude-sonnet-4-5", variant: "high", agent: "build",
    });
    const children = events.filter((event) => event.type === "session.child");
    expect(children.map((event) => [event.data?.child_session_id, event.data?.parent_session_id, event.data?.title, event.data?.agent])).toEqual([
      ["ses_child_1", sessionId, "Subtask", "explore"],
      ["ses_grandchild_1", "ses_child_1", null, null],
    ]);
    expect(JSON.stringify(children[0]?.data?.messages)).toContain("cmsg_1");
    expect(JSON.stringify(children)).not.toContain("jane@example.com");
    const end = uploads.at(-1)!;
    expect(end.session).toEqual({
      provider_id: "anthropic", model_id: "claude-sonnet-4-5", variant: "high", child_session_ids: ["ses_child_1", "ses_grandchild_1"],
    });

    // A resumed session starts from the persisted checkpoints and reports the
    // last known model and children on its very first upload.
    const second = makeCollector();
    second.startSession(sessionId, "workspace-children", root);
    await second.idle(sessionId);
    expect(await second.childCheckpoints(sessionId)).toEqual({ ses_child_1: "cmsg_1" });
    expect(await second.childSessionIds(sessionId)).toEqual(["ses_child_1", "ses_grandchild_1"]);
    const resumedStart = uploads.find((item) => item.snapshot_type === "start" && item.session_segment === 2)!;
    expect(resumedStart.session).toEqual({
      provider_id: "anthropic", model_id: "claude-sonnet-4-5", variant: "high", child_session_ids: ["ses_child_1", "ses_grandchild_1"],
    });
    await second.stop();
  });

  test("keeps only the newest 5,000 events across every push site", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-cap-"));
    roots.push(root);
    await writeFile(join(root, "app.txt"), "hello\n");
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, fallbackScanMs: 60_000 });
    const sessionId = "session-cap-1234";
    collector.startSession(sessionId, "workspace-cap", root);
    await collector.idle(sessionId);
    expect(MAX_COLLECTOR_TRACE_EVENTS).toBe(5_000);
    // Fill the trace, then push one event through each of the newer sites:
    // every one of them displaces the oldest event instead of growing the trace.
    for (let index = 0; index < MAX_COLLECTOR_TRACE_EVENTS; index += 1) collector.recordTrace(sessionId, "filler", { index });
    collector.recordSessionModel(sessionId, { provider_id: "anthropic", model_id: "claude-sonnet-4-5", variant: null, agent: null });
    collector.recordChildSession(sessionId, { childSessionId: "ses_child_cap", parentSessionId: sessionId, title: null, agent: null, messages: [], lastMessageId: null });
    expect(collector.recordWebVisit(sessionId, { url: "https://example.com/page", title: "Page", text: "text" })).toBe(true);
    collector.recordAttachment(sessionId, { name: "note.txt", mime: "text/plain", bytes: 4, sha256: "0".repeat(64), text: "note", textTruncated: false });
    collector.flushTrace(sessionId);
    await collector.stop();

    const events = traceEvents(uploads);
    expect(events).toHaveLength(MAX_COLLECTOR_TRACE_EVENTS);
    expect(events.slice(-4).map((event) => event.type)).toEqual(["session.model", "session.child", "web.visit", "attachment"]);
    // The four oldest filler events (indices 0-3) were dropped; the newest filler survives.
    expect(events[0]?.data).toEqual({ index: 4 });
    expect(events.filter((event) => event.type === "filler")).toHaveLength(MAX_COLLECTOR_TRACE_EVENTS - 4);
  }, 20_000);

  test("traces browser visits with redacted, capped text and never local pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-web-"));
    roots.push(root);
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, fallbackScanMs: 60_000 });
    const sessionId = "session-web-1234";
    collector.startSession(sessionId, "workspace-web", root);
    const text = `Contact jane@example.com about AKIA1234567890123456 ${"page text ".repeat(20_000)}`;
    expect(collector.recordWebVisit(sessionId, { url: "https://user:pw@example.com/docs?q=1#top", title: "Docs jane@example.com", text })).toBe(true);
    expect(collector.recordWebVisit(sessionId, { url: "https://example.org/short", title: null, text: "brief" })).toBe(true);
    for (const url of ["file:///etc/passwd", "data:text/html,<p>hi</p>", "chrome://settings", "http://localhost:3000/app", "http://127.0.0.1:8080/", "https://[::1]/", "ftp://example.com/x"]) {
      expect(collector.recordWebVisit(sessionId, { url, title: "local", text: "secret local page" })).toBe(false);
    }
    collector.flushTrace(sessionId);
    await collector.stop();

    const visits = traceEvents(uploads).filter((event) => event.type === "web.visit");
    expect(visits).toHaveLength(2);
    const [long, short] = visits;
    expect(long?.data?.url).toBe("https://example.com/docs?q=1#top");
    expect(long?.data?.title).toBe("Docs [REDACTED_PII]");
    expect(long?.data?.text_truncated).toBe(true);
    expect(Buffer.byteLength(String(long?.data?.text))).toBeLessThanOrEqual(MAX_COLLECTOR_WEB_VISIT_TEXT_BYTES);
    expect(String(long?.data?.text)).not.toContain("jane@example.com");
    expect(String(long?.data?.text)).not.toContain("AKIA1234567890123456");
    expect(short?.data).toEqual({ url: "https://example.org/short", title: null, text: "brief", text_truncated: false });
    expect(JSON.stringify(uploads)).not.toContain("secret local page");
    expect(JSON.stringify(uploads)).not.toContain("user:pw@");
  });

  test("traces prompt attachments with redacted, capped text", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-attachments-"));
    roots.push(root);
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, fallbackScanMs: 60_000 });
    const sessionId = "session-attachment-1234";
    collector.startSession(sessionId, "workspace-attachment", root);
    const text = `OPENAI_API_KEY=sk-1234567890abcdefghijklmnop\n${"notes ".repeat(60_000)}`;
    collector.recordAttachment(sessionId, { name: "../notes jane@example.com report.txt", mime: "text/plain", bytes: Buffer.byteLength(text), sha256: sha256(text), text });
    collector.recordAttachment(sessionId, { name: "photo.png", mime: "image/png", bytes: 12, sha256: sha256("png"), text: null });
    collector.flushTrace(sessionId);
    await collector.stop();

    const attachments = traceEvents(uploads).filter((event) => event.type === "attachment");
    expect(attachments).toHaveLength(2);
    const [note, photo] = attachments;
    expect(note?.data?.name).toBe("notes [REDACTED_PII] report.txt");
    expect(note?.data?.mime).toBe("text/plain");
    expect(note?.data?.bytes).toBe(Buffer.byteLength(text));
    expect(note?.data?.sha256).toBe(sha256(text));
    expect(note?.data?.text_truncated).toBe(true);
    expect(Buffer.byteLength(String(note?.data?.text))).toBeLessThanOrEqual(MAX_COLLECTOR_ATTACHMENT_TEXT_BYTES);
    expect(String(note?.data?.text)).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(String(note?.data?.text)).toContain("[REDACTED]");
    expect(photo?.data).toEqual({ name: "photo.png", mime: "image/png", bytes: 12, sha256: sha256("png"), text: null, text_truncated: false });
  });

  test("emits artifact events for untracked outputs a turn creates or modifies", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-artifacts-"));
    roots.push(root);
    await git(root, "init", "-q");
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await writeFile(join(root, "tracked.txt"), "tracked\n");
    await writeFile(join(root, "stale.txt"), "already there\n");
    await git(root, "add", ".gitignore", "tracked.txt");
    await git(root, "commit", "-q", "-m", "init");
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    const sessionId = "session-artifacts-1234";
    collector.startSession(sessionId, "workspace-artifacts", root);
    collector.captureSnapshot(sessionId, "prompt");
    await collector.idle(sessionId);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(root, "tracked.txt"), "tracked, edited\n");
    await mkdir(join(root, "out"));
    await writeFile(join(root, "out", "report.bin"), Buffer.from([0, 1, 2, 3, 255]));
    await writeFile(join(root, "notes.md"), "generated notes\n");
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, "ignored", "cache.txt"), "ignored output\n");
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    collector.flushTrace(sessionId);
    await collector.stop();

    const artifacts = traceEvents(uploads).filter((event) => event.type === "artifact").map((event) => event.data);
    expect(artifacts.map((artifact) => artifact?.path).sort()).toEqual(["notes.md", "out/report.bin"]);
    expect(artifacts.find((artifact) => artifact?.path === "out/report.bin")).toEqual({
      path: "out/report.bin",
      sha256: createHash("sha256").update(Buffer.from([0, 1, 2, 3, 255])).digest("hex"),
      bytes: 5,
    });
    expect(artifacts.find((artifact) => artifact?.path === "notes.md")).toEqual({ path: "notes.md", sha256: sha256("generated notes\n"), bytes: 16 });
    expect(JSON.stringify(uploads)).not.toContain("ignored output");
    const change = uploads.find((item) => item.snapshot_type === "change" && item.trigger === "turn_completed");
    expect(change?.files.map((file) => file.path)).toContain("tracked.txt");
    expect(change?.touched_paths).toEqual(expect.arrayContaining(["notes.md", "out/report.bin"]));
  });

  test("clamps by bytes without splitting code points and classifies web urls", () => {
    expect(clampCollectorBytes("abc", 10)).toEqual({ text: "abc", truncated: false });
    expect(clampCollectorBytes("a😀b", 4)).toEqual({ text: "a", truncated: true });
    expect(clampCollectorBytes("a😀b", 5)).toEqual({ text: "a😀", truncated: true });
    expect(isCollectableWebUrl("https://example.com/")).toBe(true);
    expect(isCollectableWebUrl("http://example.com:8080/path")).toBe(true);
    for (const url of ["file:///tmp/a", "data:text/plain,a", "chrome://version", "about:blank", "http://localhost/", "http://app.localhost/", "http://127.0.0.1/", "http://[::1]/", "not a url"]) {
      expect(isCollectableWebUrl(url)).toBe(false);
    }
  });
});

// --- collector secret rails --------------------------------------------------

const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
// Token samples are assembled at runtime so the source never contains a
// contiguous token shape (GitHub push protection scans committed blobs).
const sample = (prefix: string, ...rest: string[]) => prefix + rest.join("");
const GITHUB_TOKEN = sample("ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123");

describe("workspace collector secret rails", () => {
  test("drops the incident file by name and counts it in the privacy manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-incident-"));
    roots.push(root);
    await git(root, "init", "-q");
    await writeFile(join(root, "AWS master key"), `aws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = ${AWS_SECRET}\n`);
    await writeFile(join(root, "app.ts"), "export const ok = true;\n");
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, fallbackScanMs: 60_000 });
    const sessionId = "session-incident-1";
    collector.startSession(sessionId, "workspace-incident", root);
    collector.recordTrace(sessionId, "file.read", { path: "AWS master key" });
    await collector.stop();

    const start = uploads.find((item) => item.snapshot_type === "start")!;
    expect(start.files.map((file) => file.path).sort()).toEqual(["__omnirush__/workspace.json", "app.ts"]);
    expect(start.manifest.map((entry) => entry.path)).toEqual(["app.ts"]);
    expect(start.privacy.denied_file_count).toBe(1);
    expect(start.files.find((file) => file.path === "__omnirush__/workspace.json")?.content).toContain('"denied_file_count":1');
    // The denied name never reaches the snapshot, manifest or touched paths
    // (the raw tool argument in the trace event is the agent's own input).
    for (const envelope of uploads) {
      expect(envelope.touched_paths).toEqual([]);
      expect(envelope.files.map((file) => file.path)).not.toContain("AWS master key");
      expect(envelope.manifest.map((entry) => entry.path)).not.toContain("AWS master key");
    }
    const serialized = JSON.stringify(uploads);
    expect(serialized).not.toContain(AWS_SECRET);
    expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("denies credential-named paths unless they carry a source or docs extension", () => {
    for (const path of [
      "AWS master key", "tokens/prod.csv", "backup/wallet.dat", "my-wallet", "seed.csv", "kubeconfig", "id_rsa.pub", "notes/passwords",
      ".aws/config", ".gnupg/pubring.kbx", ".docker/config.json", "team/mnemonic", "prod secret", "api_key", ".netrc", "passwd",
    ]) {
      expect(isCollectorPathDenied(path)).toBe(true);
    }
    for (const path of [
      "src/token/refresh.ts", "design-tokens/colors.ts", "prisma/seed/users.ts", "seed.sql", "password-reset.tsx", "keys.md",
      "AWS master key.txt", "kubeconfig.yaml", "keyboard.ts", "hotkey.json", ".docker/daemon.json", "src/app.ts",
    ]) {
      expect(isCollectorPathDenied(path)).toBe(false);
    }
    // The pre-existing rules stay stricter than the extension carve-out.
    for (const path of ["credentials.json", "secrets.ts", "secrets/config.yml", "keys/service.json", "server.key", ".env.production", "private-key.md"]) {
      expect(isCollectorPathDenied(path)).toBe(true);
    }
  });

  test("redacts every secret-named assignment form once and leaves obvious non-secrets alone", () => {
    const secrets: Array<[string, string]> = [
      [`aws_secret_access_key = ${AWS_SECRET}`, "aws_secret_access_key = [REDACTED]"],
      ["password: hunter2hunter2", "password: [REDACTED]"],
      ["client_secret: 'abcdefghijkl'", "client_secret: '[REDACTED]'"],
      ['"token": "abcdefghijkl"', '"token": "[REDACTED]"'],
      ['{"apiKey":"abcdefghijkl","x":1}', '{"apiKey":"[REDACTED]","x":1}'],
      ["DB_PASSWD=hunter2abc", "DB_PASSWD=[REDACTED]"],
      ['export API_KEY="abcdefghijkl"', 'export API_KEY="[REDACTED]"'],
      ["mysql --password=hunter2abc -u root", "mysql --password=[REDACTED] -u root"],
      ['const apiKey = "abcdefghijkl";', 'const apiKey = "[REDACTED]";'],
      ["PRIVATE_KEY = abcdefghijkl", "PRIVATE_KEY = [REDACTED]"],
      ["access_key: abcdefghijkl", "access_key: [REDACTED]"],
      ["pwd=abcdefghijkl", "pwd=[REDACTED]"],
      ["auth: abcdefghijkl", "auth: [REDACTED]"],
      ["credentials = abcdefghijkl", "credentials = [REDACTED]"],
      ["session_key: abcdefghijkl", "session_key: [REDACTED]"],
      ["signing_key = abcdefghijkl", "signing_key = [REDACTED]"],
      ["masterKey: abcdefghijkl", "masterKey: [REDACTED]"],
      ["encryption_key = abcdefghijkl", "encryption_key = [REDACTED]"],
      ["apikey: abcdefghijkl", "apikey: [REDACTED]"],
      ["githubToken = abcdefghijkl", "githubToken = [REDACTED]"],
      ["db.password: abcdefghijkl,", "db.password: [REDACTED],"],
      ["  - password=abc12345 # note", "  - password=[REDACTED] # note"],
      ["auth_token = abcdefgh1234", "auth_token = [REDACTED]"],
      ["basic-auth: abcdefghijkl", "basic-auth: [REDACTED]"],
      ["AUTH=abcdefghijkl", "AUTH=[REDACTED]"],
      ["authorization: abcdefghijkl", "authorization: [REDACTED]"],
      ["oauth_client_secret = abcdefghijkl", "oauth_client_secret = [REDACTED]"],
      ["HTTPSecret = abcdefghijkl", "HTTPSecret = [REDACTED]"],
      ["APIKey: abcdefghijkl", "APIKey: [REDACTED]"],
      ["accessKey: abcdefghijkl", "accessKey: [REDACTED]"],
      ["token2 = abcdefghijkl", "token2 = [REDACTED]"],
    ];
    for (const [input, expected] of secrets) {
      expect(redactCollectorText(input)).toEqual({ text: expected, count: 1 });
    }
    const preserved = [
      "token_length = abcdefghij", "token_ttl = abcdefghij", "auth_seconds = abcdefghij", "token_count = abcdefghij",
      "secret_size = abcdefghij", "token_url = https://example.com/oauth/token", "secret_path = /var/run/secrets/x",
      "secret_name = github-token-secret", "session_id = abcdefghij12", "auth_header = X-Auth-Token", "api-key-name: primary-key",
      "token = getToken()", "password = process.env.PASSWORD", 'secret = os.environ["X"]', "token = env.TOKEN",
      "password: ${PASSWORD}", "token=$(cat token.txt)", "password = abc123", "token: short", "auth: 12345678",
      "const password = passwordInput.value.trim()", "token: true",
      // Keyword families match whole key segments, never a substring of an ordinary word.
      "author: Johnathan", "authors = Johnathan", "authored_by: Johnathan", "oauth_client_id = abcdefghijkl",
      "tokenizer_class = BertTokenizer", "tokenize: whitespace", "keyboard_layout = qwerty-intl", "keywords = abcdefghijkl",
      "pwdir = /home/user/project", "accessKeyId = abcdefghijkl", 'eos_token: "<|endoftext|>"',
    ];
    for (const input of preserved) expect(redactCollectorText(input)).toEqual({ text: input, count: 0 });
  });

  test("leaves a real package.json and a tokenizer config byte-identical", () => {
    const packageJson = [
      "{",
      '  "name": "@acme/widgets",',
      '  "version": "1.2.3",',
      '  "description": "Token helpers for the Acme auth flow",',
      '  "author": "sindresorhus",',
      '  "keywords": ["token", "auth", "password", "keyboard"],',
      '  "scripts": { "test": "bun test", "tokenize": "node scripts/tokenize.js" },',
      '  "dependencies": { "jsonwebtoken": "^9.0.2", "keyboardjs": "2.7.0" },',
      '  "authorship": "community-maintained"',
      "}",
      "",
    ].join("\n");
    expect(redactCollectorContent("package.json", packageJson)).toBe(packageJson);
    expect(redactCollectorText(packageJson)).toEqual({ text: packageJson, count: 0 });
    const tokenizerConfig = '{"tokenizer_class": "LlamaTokenizer", "bos_token": "<s>", "eos_token": "<|endoftext|>", "add_bos_token": true, "model_max_length": 4096, "clean_up_tokenization_spaces": false}';
    expect(redactCollectorContent("tokenizer_config.json", tokenizerConfig)).toBe(tokenizerConfig);
    expect(redactCollectorText(tokenizerConfig)).toEqual({ text: tokenizerConfig, count: 0 });
    expect(redactCollectorText("tokenizer_class = LlamaTokenizer\nauth_token = abcdefgh1234\n"))
      .toEqual({ text: "tokenizer_class = LlamaTokenizer\nauth_token = [REDACTED]\n", count: 1 });
  });

  test("redacts provider token shapes", () => {
    const shapes: Array<[string, string]> = [
      [GITHUB_TOKEN, GITHUB_TOKEN],
      [sample("gho_", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123"), "gho_"],
      [sample("ghu_", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123"), "ghu_"],
      [sample("ghs_", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123"), "ghs_"],
      [sample("ghr_", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123"), "ghr_"],
      [sample("github_pat_", "11ABCDEFG0abcdefghijklmn_", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTU"), "github_pat_"],
      [sample("xoxb-", "1234567890-", "1234567890123-", "AbCdEfGhIjKlMnOpQrStUvWx"), "xoxb-"],
      [sample("xoxp-", "1234567890-", "1234567890123-", "AbCdEfGhIjKlMnOpQrStUvWx"), "xoxp-"],
      [sample("AIza", "SyA1234567890abcdefghijklmnopqrstuvw"), "AIza"],
      [sample("sk_live_", "abcdefghijklmnopqrstuvwx"), "sk_live_"],
      [sample("sk_test_", "abcdefghijklmnopqrstuvwx"), "sk_test_"],
      [sample("sk-proj-", "abcdefghijklmnopqrstuvwxyz0123"), "sk-proj-"],
      [sample("sk-ant-", "api03-abcdefghijklmnopqrstuvwxyz0123-abc"), "sk-ant-"],
      [["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join("."), "eyJ"],
      [["MTIzNDU2Nzg5MDEyMzQ1Njc4OTAx", "GhIjKl", "abcdefghijklmnopqrstuvwxyz0123456"].join("."), "MTIz"],
      ["Bearer abcdefghijklmnopqrstuvwxyz0123", "abcdefghijklmnopqrstuvwxyz0123"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXk"],
      ["-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQdGBF\n-----END PGP PRIVATE KEY BLOCK-----", "lQdGBF"],
    ];
    for (const [shape, marker] of shapes) {
      const result = redactCollectorText(`value: ${shape} tail`);
      expect(result.text).not.toContain(marker);
      expect(result.text).toContain("[REDACTED] tail");
      expect(result.count).toBe(1);
    }
    expect(redactCollectorText(`git clone https://oauth2:${GITHUB_TOKEN}@github.com/acme/widgets.git`))
      .toEqual({ text: "git clone https://[REDACTED]@github.com/acme/widgets.git", count: 1 });
    expect(redactCollectorText("DATABASE_URL=postgres://admin:s3cret@db.internal:5432/app"))
      .toEqual({ text: "DATABASE_URL=postgres://[REDACTED]@db.internal:5432/app", count: 1 });
    expect(redactCollectorText("Authorization: Bearer <token>").count).toBe(0);
  });

  test("redacts AWS secret access keys only near an access key id or an aws/secret name", () => {
    expect(redactCollectorText(`AccessKeyId,SecretAccessKey\nAKIAIOSFODNN7EXAMPLE,${AWS_SECRET}\n`).text).toBe("AccessKeyId,SecretAccessKey\n[REDACTED],[REDACTED]\n");
    expect(redactCollectorText(`id: AKIAIOSFODNN7EXAMPLE\n\n\n${AWS_SECRET}`).text).toBe("id: [REDACTED]\n\n\n[REDACTED]");
    expect(redactCollectorText(`id: AKIAIOSFODNN7EXAMPLE\n\n\n\n${AWS_SECRET}`).text).toBe(`id: [REDACTED]\n\n\n\n${AWS_SECRET}`);
    expect(redactCollectorText(`# aws profile\n# region eu-west-1\n${AWS_SECRET}`).text).toBe("# aws profile\n# region eu-west-1\n[REDACTED]");
    expect(redactCollectorText(`${AWS_SECRET}\n\nsecret: yes`).text).toBe("[REDACTED]\n\nsecret: yes");
    expect(redactCollectorText(AWS_SECRET).text).toBe(AWS_SECRET);
    expect(redactCollectorText(`\n\n${AWS_SECRET}`, { context: "AWS master secret.txt" }).text).toBe("\n\n[REDACTED]");
    // The proximity pass needs three or more lines (two line breaks); a
    // shorter document relies on the assignment rule or its JSON key.
    expect(redactCollectorText(`# aws profile\n${AWS_SECRET}`).text).toBe(`# aws profile\n${AWS_SECRET}`);
    expect(redactCollectorText(AWS_SECRET, { context: "AWS master secret.txt" }).text).toBe(AWS_SECRET);
    expect(redactCollectorContent("creds.json", `{"aws_secret_access_key":"${AWS_SECRET}"}`)).toBe('{"aws_secret_access_key":"[REDACTED]"}');
    expect(redactCollectorContent("creds.json", `{"Credentials":{"AccessKeyId":"AKIAIOSFODNN7EXAMPLE","SecretAccessKey":"${AWS_SECRET}"}}`))
      .toBe('{"Credentials":{"AccessKeyId":"[REDACTED]","SecretAccessKey":"[REDACTED]"}}');
    expect(redactCollectorContent("creds.env", `AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=${AWS_SECRET}\n`))
      .toBe("AWS_ACCESS_KEY_ID=[REDACTED]\nAWS_SECRET_ACCESS_KEY=[REDACTED]\n");
    // Not mixed case (a git sha), or not exactly 40 characters: left alone.
    expect(redactCollectorText("aws sha 0123456789abcdef0123456789abcdef01234567").text).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(redactCollectorText(`aws ${AWS_SECRET}extra`).text).toContain(AWS_SECRET);
  });

  test("selects the value rule mode from the file extension", () => {
    for (const path of ["src/app.js", "lib/x.cjs", "x.mjs", "a/b.ts", "c.tsx", "d.jsx", "e.py", "f.go", "g.rs", "h.java", "i.kt", "j.c", "k.cc", "l.cpp",
      "m.h", "n.hpp", "o.rb", "p.php", "q.swift", "r.cs", "s.scala", "t.sh", "u.bash", "v.zsh", "w.ps1", "x.lua", "y.dart", "z.vue", "aa.svelte", "bundle.js.map", "UPPER.JS"]) {
      expect(redactModeForPath(path)).toBe("source");
    }
    for (const path of [".env", ".env.local", "settings.ini", "app.cfg", "nginx.conf", "ci.yml", "compose.yaml", "Cargo.toml", "package.json",
      "app.properties", "notes.txt", "README.md", "Makefile", "Dockerfile", ".bashrc", "archive.tar.gz", "src/token/prod.env"]) {
      expect(redactModeForPath(path)).toBe("config");
    }
  });

  test("value rule v2 leaves source-code assignments byte-identical and still redacts literal secrets", () => {
    // Every false positive sampled from a v1.0.5 production upload, in the file type it came from.
    const sampled: Array<[string, string]> = [
      ["derived.js", "derived.token_estimate = estimate;"],
      ["middleware.js", "const auth = req.headers.authorization || '';"],
      ["app.js", "authMethod: 'github-app'"],
      ["client.js", "token: config.token"],
      ["metrics.yml", "credentials_file: /run/secrets/prod_metrics_token"],
      ["pipeline.yml", "token_role: 'pipeline'"],
      ["pipeline.yml", "token_owner: 'sample-owner'"],
      ["oauth.js", "const githubOAuthConfig = githubOAuthEnabled"],
      ["fixtures.js", "META_MUSE_API_KEY: 'synthetic'"],
      ["heartbeat.py", "credential_hash: server.heartbeat_token_hash"],
      ["atlas.js", "CONTRACT_POOL_ATLAS_READ_TOKEN_FILE: tokenFile"],
      ["request.js", "Authorization: Bearer test-token"],
      // The same lines survive CONFIG mode too, except the quoted 'synthetic' literal.
      ["config.yml", "token: config.token"],
      ["heartbeat.yml", "credential_hash: server.heartbeat_token_hash"],
      ["atlas.yml", "CONTRACT_POOL_ATLAS_READ_TOKEN_FILE: tokenFile"],
      ["request.txt", "Authorization: Bearer test-token"],
      ["middleware.diff", "+const auth = req.headers.authorization || '';"],
      // SOURCE mode: unquoted identifiers are references, paths are paths, short digitless literals are labels.
      ["a.py", "token = someLongCamelCaseIdentifier2"],
      ["a.py", "password = hunter2abc"],
      ["settings.py", "AUTH_TIMEOUT = 30000000"],
      ["a.py", "password = settings.DATABASE_PASSWORD_1"],
      ["a.ts", 'const secret = "/etc/ssl/private/key1.pem";'],
      ["a.ts", 'const secret = "./secrets/key1.pem";'],
      ["a.ts", 'const secret = "../keys/key1.pem";'],
      ["a.ts", 'const secret = "~/.aws/credentials1";'],
      ["a.ts", 'const secret = "C:/Users/me/token1.txt";'],
      ["a.go", 'password := "secrets/db/primary"'],
      ["a.rb", 'password = "abcdefghijklmnopqrstuvwxyz"'],
      ["a.rb", 'password = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"'],
      ["a.rb", 'token = "abc${FOO}def12"'],
      ["a.rb", 'token = "<your-token-1>"'],
      ["a.rb", "token = getToken(12345678)"],
      ["a.sh", 'TOKEN="$(cat token1.txt)"'],
    ];
    for (const [path, text] of sampled) expect(redactCollectorContent(path, text)).toBe(text);
    expect(redactCollectorText("+const auth = req.headers.authorization || '';", { context: "middleware.js" })).toEqual({ text: "+const auth = req.headers.authorization || '';", count: 0 });
    expect(filterCollectorDiff("diff --git a/m.js b/m.js\n+const auth = req.headers.authorization || '';\n").diff)
      .toBe("diff --git a/m.js b/m.js\n+const auth = req.headers.authorization || '';\n");

    const secrets: Array<[string, string, string]> = [
      ["app.js", `const apiKey = "${sample("sk_live_", "abcdefghijklmnopqrstuvwx")}"`, 'const apiKey = "[REDACTED]"'],
      ["settings.py", 'password = "hunter2abc"', 'password = "[REDACTED]"'],
      ["settings.py", 'token = "Abcdefghijklmnopqrstuvwxyz1234"', 'token = "[REDACTED]"'],
      ["settings.py", 'password = "12345678"', 'password = "[REDACTED]"'],
      ["settings.py", 'auth = "AbCdEfGhIjKlMnOpQrStUv"', 'auth = "[REDACTED]"'],
      ["settings.py", "SECRET = Ab1/Cd2+Ef3=", "SECRET = [REDACTED]"],
      ["ci.yml", `token: ${GITHUB_TOKEN}`, "token: [REDACTED]"],
      ["config.yml", 'api_key: "abcdef1234567890"', 'api_key: "[REDACTED]"'],
      ["config.yml", "password: changeme1", "password: [REDACTED]"],
      ["config.yml", "META_MUSE_API_KEY: 'synthetic'", "META_MUSE_API_KEY: '[REDACTED]'"],
      ["config.yml", 'token: "config.token"', 'token: "[REDACTED]"'],
      ["config.yml", "token: config-token", "token: [REDACTED]"],
      ["request.http", "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", "Authorization: Bearer [REDACTED]"],
      ["request.js", "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", "Authorization: Bearer [REDACTED]"],
    ];
    for (const [path, text, expected] of secrets) {
      expect(redactCollectorContent(path, text)).toBe(expected);
      expect(redactCollectorText(text, { mode: redactModeForPath(path) }).count).toBe(1);
    }
    // Excluded last segments never name a secret, in either mode.
    for (const last of ["file", "filename", "dir", "mode", "method", "role", "owner", "type", "kind", "enabled", "estimate", "hash", "digest", "at",
      "config", "client", "prefix", "suffix", "format", "scheme", "provider", "status", "state", "label", "description", "title", "class", "field",
      "fields", "list", "names", "version", "timeout", "limit", "max", "min", "interval", "retries", "port"]) {
      const line = `token_${last}: abcdefgh1234`;
      expect(redactCollectorContent("x.yml", line)).toBe(line);
      expect(redactCollectorContent("x.py", line)).toBe(line);
    }
  });

  test("redacts a Bearer token only when it looks like a credential", () => {
    const kept = [
      "Authorization: Bearer test-token",
      "Authorization: Bearer yourAccessTokenGoesHere",
      "Authorization: Bearer your_access_token.goes.here",
      "Authorization: Bearer ${ACCESS_TOKEN_GOES_HERE}",
      "Authorization: Bearer <your-access-token-here>",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "Authorization: Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    ];
    for (const line of kept) expect(redactCollectorText(line)).toEqual({ text: line, count: 0 });
    const redacted = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
      "Authorization: Bearer a8f3b2c9d4e5f6a7b8c9d0e1",
      "Authorization: Bearer Your-Access-Token-Goes-Here",
      "Authorization: Bearer AbCdEfGhIjKlMnOpQrStUv/wx+yz==",
    ];
    for (const line of redacted) expect(redactCollectorText(line)).toEqual({ text: "Authorization: Bearer [REDACTED]", count: 1 });
    expect(redactCollectorText("authorization: bearer abcdefghijklmnopqrstuvwxyz0123")).toEqual({ text: "authorization: bearer [REDACTED]", count: 1 });
  });

  test("keeps a source file named after a token but redacts the literal inside it", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-source-"));
    roots.push(root);
    await mkdir(join(root, "src", "token"), { recursive: true });
    await writeFile(join(root, "src", "token", "github-token.ts"), `export const token = "${GITHUB_TOKEN}";\nexport const aws = "${AWS_SECRET}";\n`);
    await writeFile(join(root, "src", "token", "prod.env"), `GITHUB_TOKEN=${GITHUB_TOKEN}\n`);
    await writeFile(join(root, "README.md"), `Deploy with\n\n    export CLIENT_SECRET=${GITHUB_TOKEN}\n`);
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, fallbackScanMs: 60_000 });
    collector.startSession("session-source-1", "workspace-source", root);
    await collector.stop();

    const start = uploads.find((item) => item.snapshot_type === "start")!;
    expect(start.manifest.map((entry) => entry.path).sort()).toEqual(["README.md", "src/token/github-token.ts"]);
    expect(start.files.find((file) => file.path === "src/token/github-token.ts")?.content)
      .toBe('export const token = "[REDACTED]";\nexport const aws = "[REDACTED]";\n');
    expect(start.files.find((file) => file.path === "README.md")?.content).toBe("Deploy with\n\n    export CLIENT_SECRET=[REDACTED]\n");
    expect(start.privacy.denied_file_count).toBe(1);
    const serialized = JSON.stringify(uploads);
    expect(serialized).not.toContain(GITHUB_TOKEN);
    expect(serialized).not.toContain(AWS_SECRET);
  });

  test("scrubs the trace and .json files as JSON so escapes survive redaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-json-"));
    roots.push(root);
    await writeFile(join(root, "config.json"), '{\n  "note": "{\\"password\\":\\"hunter2abc\\"}",\n  "nested": {"apiKey": "abcdefghijkl", "author": "Jane <jane@example.com>"}\n}\n');
    await writeFile(join(root, "settings.json"), '// JSON with comments falls back to text scrubbing\n{"password": "hunter2abc"}\n');
    await writeFile(join(root, "data.json"), '{"a": 1.0, "b": [1, 2]}');
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, fallbackScanMs: 60_000 });
    const sessionId = "session-json-1";
    collector.startSession(sessionId, "workspace-json", root);
    collector.recordTrace(sessionId, "message", { text: 'line one\n@app.function(gpu="h100")\nx@example.com', token: GITHUB_TOKEN });
    collector.flushTrace(sessionId);
    await collector.stop();

    const trace = uploads.find((item) => item.snapshot_type === "trace")!;
    const parsed = JSON.parse(trace.files[0]!.content) as { events: Array<{ type: string; data?: Record<string, unknown> }> };
    const expected = { text: 'line one\n@app.function(gpu="h100")\n[REDACTED_PII]', token: "[REDACTED]" };
    expect(parsed.events.find((event) => event.type === "message")?.data).toEqual(expected);
    expect(trace.trace?.find((event) => event.type === "message")?.data).toEqual(expected);

    const start = uploads.find((item) => item.snapshot_type === "start")!;
    const content = (path: string) => start.files.find((file) => file.path === path)!.content;
    expect(JSON.parse(content("config.json"))).toEqual({
      note: '{"password":"[REDACTED]"}',
      nested: { apiKey: "[REDACTED]", author: "Jane <[REDACTED_PII]>" },
    });
    expect(content("config.json").startsWith('{\n  "note"')).toBe(true);
    expect(content("config.json").endsWith("\n")).toBe(true);
    expect(content("settings.json")).toBe('// JSON with comments falls back to text scrubbing\n{"password": "[REDACTED]"}\n');
    expect(content("data.json")).toBe('{"a": 1.0, "b": [1, 2]}');
    expect(start.manifest.find((entry) => entry.path === "config.json")?.sha256).toBe(sha256(content("config.json")));
    expect(JSON.stringify(uploads)).not.toContain("hunter2abc");
  });

  test("never leaves a dangling backslash when scrubbing escaped text", () => {
    const raw = JSON.stringify({ text: `line one\n@app.function(gpu="h100")\nx@example.com\njane@example.com\tAKIAIOSFODNN7EXAMPLE\nTOKEN=${GITHUB_TOKEN}` });
    const result = redactCollectorText(raw);
    expect(JSON.parse(result.text)).toEqual({ text: 'line one\n@app.function(gpu="h100")\n[REDACTED_PII]\n[REDACTED_PII]\t[REDACTED]\nTOKEN=[REDACTED]' });
    expect(result.count).toBe(4);
    expect(redactCollectorText("password=\"abcdefgh\\\"more\"").text).toBe("password=\"[REDACTED]\"");
    // JSON carried inside a string of a non-JSON file keeps its escapes.
    const embedded = JSON.stringify({ text: JSON.stringify({ password: "hunter2abc", user: "jane" }) });
    expect(JSON.parse(redactCollectorText(embedded).text)).toEqual({ text: '{"password":"[REDACTED]","user":"jane"}' });
    expect(redactCollectorText('log: {\\"token\\":\\"abcdefghijkl\\"} done').text).toBe('log: {\\"token\\":\\"[REDACTED]\\"} done');
    expect(redactCollectorJsonText('{"a":{"toJSON":1},"secret":"abcdefghijkl","n":1e3}')).toBe('{"a":{"toJSON":1},"secret":"[REDACTED]","n":1000}');
    expect(redactCollectorJsonText("not json")).toBeNull();
    // "secrets" is a family word, the plural "tokens" deliberately is not (tokenizer configs).
    expect(redactCollectorJson({ at: new Date(0), secrets: ["abcdefghijkl", "short"], tokens: ["abcdefghijkl"], "jane@example.com": 1 }))
      .toEqual({ value: { at: "1970-01-01T00:00:00.000Z", secrets: ["[REDACTED]", "short"], tokens: ["abcdefghijkl"], "[REDACTED_PII]": 1 }, count: 2 });
    expect(redactCollectorContent("nested/x.JSON", '{"password":"hunter2abc"}')).toBe('{"password":"[REDACTED]"}');
    expect(redactCollectorContent("x.txt", '{"password":"hunter2abc"}')).toBe('{"password":"[REDACTED]"}');
  });

  test("scrubs diff hunks of JSON files as text", () => {
    const raw = ["diff --git a/config.json b/config.json", "--- a/config.json", "+++ b/config.json", "@@ -1 +1 @@", '+  "password": "hunter2abc",', ""].join("\n");
    const result = filterCollectorDiff(raw);
    expect(result.diff).toContain('+  "password": "[REDACTED]",');
    expect(result.diff).not.toContain("hunter2abc");
  });

  test("redacts assignments and e-mails on whichever line they sit, never across a line break", () => {
    // Both rules are applied only to lines holding their keyword or "@"; the
    // result must equal a whole-text pass, line endings and escapes included.
    expect(redactCollectorContent("notes.txt", "first line\npassword=hunter2hunter2\r\nlast")).toBe("first line\npassword=[REDACTED]\r\nlast");
    expect(redactCollectorContent("notes.txt", "a@b\njane@example.com\n@x\nx@y.io")).toBe("a@b\n[REDACTED_PII]\n@x\n[REDACTED_PII]");
    expect(redactCollectorContent("notes.txt", "jane@\nexample.com and key\n=abcdefgh12")).toBe("jane@\nexample.com and key\n=abcdefgh12");
    expect(redactCollectorContent("run.sh", "echo done \\\nexport API_KEY=abc123def456\nTOKEN='S3cretValue99'"))
      .toBe("echo done \\\nexport API_KEY=abc123def456\nTOKEN='[REDACTED]'");
    expect(redactCollectorContent("app.ts", "const keyName = config.token;\nconst apiKey = \"sk-proj-abcdefghijklmnop1234\";\n// contact: dev@example.com"))
      .toBe("const keyName = config.token;\nconst apiKey = \"[REDACTED]\";\n// contact: [REDACTED_PII]");
    expect(redactCollectorContent("data.json", "{\n  \"note\": \"line\\npassword=hunter2hunter2\",\n  \"author\": \"jane@example.com\"\n}\n"))
      .toBe("{\n  \"note\": \"line\\npassword=[REDACTED]\",\n  \"author\": \"[REDACTED_PII]\"\n}\n");
  });

  test("scrubs a 1 MiB line in bounded time", () => {
    const mebibyte = 1024 * 1024;
    const lines = [
      "x".repeat(mebibyte),
      "ABCDabcd0123/+".repeat(mebibyte / 14),
      "token=a ".repeat(mebibyte / 8),
      "Bearer ".repeat(mebibyte / 7),
      "eyJaaaaaaaaaaaa.".repeat(mebibyte / 16),
      "a.".repeat(mebibyte / 2),
      "a-".repeat(mebibyte / 2),
      "https://".repeat(mebibyte / 8),
      "Ma.".repeat(mebibyte / 3),
      "\\n".repeat(mebibyte / 2),
      `secret: ${"A1b".repeat(mebibyte / 3)}`,
      `secret: ${"a.".repeat(mebibyte / 2)}`,
      `secret: ${"a.".repeat(mebibyte / 2)}/`,
      `secret: ${"Ab/".repeat(mebibyte / 3)}`,
      `secret: "${"a1.".repeat(mebibyte / 3)}"`,
      `Bearer ${"aB".repeat(mebibyte / 2)}`,
      `Bearer ${"a.".repeat(mebibyte / 2)}`,
    ];
    for (const line of lines) {
      for (const mode of ["config", "source"] as const) {
        const started = performance.now();
        redactCollectorText(line, { mode });
        expect(performance.now() - started).toBeLessThan(2_000);
      }
    }
  }, 60_000);
});

// --- scrubber parity: the backend's second-sample refinements ---------------
// Ported from the backend's tests/omnirush/test_collector.py (46ee95e) with the
// same inputs and expected outputs; each test names the backend test it mirrors.

// The excluded last segments added after the second production sample.
const EXCLUDED_LAST_SEGMENTS_ADDED = [
  "in", "out", "percent", "pct", "ms", "secs", "minutes", "hours", "days", "expires", "expiry", "expiration", "bytes", "len", "width",
  "height", "offset", "index", "idx", "pos", "total", "sum", "avg", "ratio", "rate", "threshold", "weight", "score", "encryption",
  "algorithm", "algo", "cipher", "strategy", "policy", "source", "target", "origin", "backend", "engine", "driver", "handler",
  "callback", "event", "action", "reason", "message", "error", "envelope", "ref", "reference", "link", "pointer", "alias",
];

// Lines from the second production sample, each in the file type it came from.
const SAMPLE2_TS = [
  "const client = { client_token: stagedClient?.plaintext || null };",
  "const apiKey = account?.managementKey || account?.apiKey;",
  "const job = { secret_envelope: params[8] };",
  "const pattern = /token=[0-9a-f]{16}/;",
  "const cacheKey = 'pipeline-token:session:trial-123';",
  "const grant = { refresh_token_expires_in: 15897600 };",
  "const proxy = { provider_credential_ref: 'iproyal:claude-in-001' };",
  "",
].join("\n");
const SAMPLE2_SH = "psql -c \"ALTER SYSTEM SET password_encryption='scram-sha-256'\"\n";
const SAMPLE2_CONF = "password_encryption = 'scram-sha-256'\n";
const SAMPLE2_YML = "proxies:\n  - provider_credential_ref: 'iproyal:claude-in-001'\n    refresh_token_expires_in: 15897600\n";
const SAMPLE2_HASHES = `{"src/admin_auth.py": "${"3f2a9c1e".repeat(8)}", "src\\\\win\\\\auth.py": "${"b7d80e1f".repeat(8)}", "auth.py": "${"5c6d7e8f".repeat(8)}"}`;
const SAMPLE2_FIXTURES = "LIVE_DSN = 'postgres://live@host:6432/db'\nSESSION_DSN = 'postgres://session@host/db'\n";
const PATCH = [
  "diff --git a/app/settings.py b/app/settings.py",
  "--- a/app/settings.py",
  "+++ b/app/settings.py",
  "@@ -1,2 +1,3 @@",
  " import config",
  "+token = config.token",
  "-password = None",
  '+password = "hunter2abc"',
  "",
].join("\n");

describe("workspace collector scrubber parity: second-sample refinements", () => {
  test("secret-named keys follow the segment rule (test_secret_key_rule_qualifies / _does_not_qualify)", () => {
    for (const key of ["auth_token", "basic-auth", "AUTH", "authorization", "oauth_client_secret", "APIKey", "accessKey", "HTTPSecret", "token2",
      "secrets", "client.secret", "x-api-key"]) {
      expect(isSecretAssignmentKey(key)).toBe(true);
    }
    for (const key of [
      "author", "authors", "authored_by", "oauth_client_id", "tokenizer_class", "tokenize", "keyboard_layout", "keywords", "pwdir",
      "accessKeyId", "token_url", "tokens", "additional_special_tokens", "key", "",
      // The excluded last segments added with value rule v2.
      "derived.token_estimate", "authMethod", "token_role", "token_owner", "credentials_file", "credential_hash", "githubOAuthConfig",
      "CONTRACT_POOL_ATLAS_READ_TOKEN_FILE", "AUTH_TIMEOUT", "token_filename", "token_dir", "auth_mode", "token_type", "auth_kind",
      "auth_enabled", "secret_digest", "token_expires_at", "auth_client", "api_key_prefix", "token_suffix", "token_format", "auth_scheme",
      "auth_provider", "token_status", "auth_state", "auth_label", "secret_description", "token_title", "auth_class", "password_field",
      "token_fields", "token_list", "secret_names", "token_version", "token_limit", "auth_max", "secret_min", "auth_interval",
      "token_retries", "auth_port",
      // The second production sample.
      "refresh_token_expires_in", "password_encryption", "provider_credential_ref", "secret_envelope",
    ]) {
      expect(isSecretAssignmentKey(key)).toBe(false);
    }
  });

  test("the added excluded last segments exclude a key only as its last segment (test_second_sample_excluded_last_segments)", () => {
    for (const word of EXCLUDED_LAST_SEGMENTS_ADDED) {
      const capitalized = word[0]!.toUpperCase() + word.slice(1);
      expect(isSecretAssignmentKey(`token_${word}`)).toBe(false);
      expect(isSecretAssignmentKey(`auth${capitalized}`)).toBe(false);
      expect(isSecretAssignmentKey(`client.secret.${word}`)).toBe(false);
      expect(isSecretAssignmentKey(`${word}_token`)).toBe(true);
      // The same through the text rule, in both modes.
      for (const mode of ["config", "source"] as const) {
        expect(redactCollectorText(`token_${word} = "abcdefgh1234"`, { mode }).count).toBe(0);
        expect(redactCollectorText(`${word}_token = "abcdefgh1234"`, { mode })).toEqual({ text: `${word}_token = "[REDACTED]"`, count: 1 });
      }
    }
  });

  test("auth_code and *_plaintext stay secret-named (test_auth_code_and_plaintext_keys_stay_secret_named)", () => {
    const text = 'auth_code = "abcdefgh1234"\npassword_plaintext = "hunter2abc"\n# TOKEN = "abcdefgh1234"\n';
    const result = redactCollectorText(text, { context: "app.py", mode: "source" });
    expect(result.text).not.toContain("abcdefgh1234");
    expect(result.text).not.toContain("hunter2abc");
    expect(result.count).toBe(3);
    expect(isSecretAssignmentKey("auth_code")).toBe(true);
    expect(isSecretAssignmentKey("password_plaintext")).toBe(true);
  });

  test("path-like JSON keys (test_path_like_keys_follow_the_desktop_rule)", () => {
    const cases: Array<[string, boolean]> = [
      ["src/admin_auth.py", true], ["src\\admin_auth.py", true], ["admin_auth.py", true], ["auth.json", true], ["token.a1b2c", true],
      ["C:\\x", true], ["auth_token", false], ["db.password", false], ["client.secret", false], ["auth.pyproject", false], ["token", false],
      ["", false],
    ];
    for (const [key, expected] of cases) expect(isPathLikeKey(key)).toBe(expected);
    // Python's `$` also matches before one trailing newline; the desktop mirrors it.
    expect(isPathLikeKey("auth.py\n")).toBe(true);
    expect(isPathLikeKey("auth.py\n\n")).toBe(false);
  });

  test("the scrub mode follows the file extension (test_scrub_mode_follows_the_file_extension)", () => {
    for (const extension of ["js", "cjs", "mjs", "ts", "tsx", "jsx", "py", "go", "rs", "java", "kt", "c", "cc", "cpp", "h", "hpp", "rb", "php",
      "swift", "cs", "scala", "sh", "bash", "zsh", "ps1", "lua", "dart", "vue", "svelte", "map", "patch", "diff"]) {
      expect(redactModeForPath(`src/file.${extension}`)).toBe("source");
      expect(redactModeForPath(`src/FILE.${extension.toUpperCase()}`)).toBe("source");
    }
    expect(redactModeForPath("dist/bundle.js.map")).toBe("source");
    for (const path of [".env", ".env.local", ".bashrc", "Makefile", "Dockerfile", "index.", "a.tar.gz", "config.yml", "config.yaml", "pyproject.toml",
      "package.json", "setup.cfg", "app.ini", "nginx.conf", "app.properties", "notes.txt", "README.md", "infra/main.tf", "build.gradle.kts",
      "schema.sql", "index.html", "__omnirush__/trace.jsonl"]) {
      expect(redactModeForPath(path)).toBe("config");
    }
  });

  test("source value rule (test_source_value_rule_redacts_quoted_literals / _skips_references_paths_and_words)", () => {
    for (const value of ["hunter2abc", "Abcdefghijklmnopqrstuvwxyz1234", "AbcdefghijklmnopqrsT", "12345678", "sk-testsecret123456789", AWS_SECRET]) {
      expect(isSecretAssignmentValue(value, "source", true)).toBe(true);
    }
    const skipped: Array<[string, boolean]> = [
      // No digit and under 20 characters of mixed case: a plain word.
      ["synthetic", true], ["github-app", true], ["sample-owner", true], ["abcdefghijklmnopqrstuvwxyz", true], ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", true],
      ["AbcdefghijklmnopqrS", true],
      // Unquoted identifier or member-expression syntax is a reference, whatever digits it holds.
      ["estimate", false], ["githubOAuthEnabled", false], ["req.headers.authorization", false], ["config.token2", false], ["$scope.token1", false],
      ["hunter2abc", false], ["Abcdefghijklmnopqrstuvwxyz1234", false],
      // Filesystem paths.
      ["/run/secrets/prod_metrics_token", true], ["./fixtures/token1", true], ["../keys/token1", true], ["~/.aws/credentials1", true],
      ["C:\\Users\\me\\token1", true], ["D:/keys/token1", true], ["https://example.com/oauth/token", true],
      // Code expressions, placeholders, earlier redactions, too short.
      ["getToken()", false], ["${TOKEN}", false], ["abc${X}def123", true], ["$(cat token.txt)", false], ["process.env.TOKEN1", false],
      ["os.environ1", false], ["env.TOKEN1", false], ["<your-token1>", true], ["[REDACTED]", true], ["abc 12345678", true], ["short1", true],
      // Unquoted and not a token shape (a character outside `[A-Za-z0-9_./+=~-]`): code.
      ["stagedClient?.plaintext", false], ["account?.managementKey", false], ["params[8]", false], ["[0-9a-f]{16}", false],
      ["session:trial-123", false], ["a|b-1234567", false], ["abc-1234!", false], ["x*y-1234567", false], ["<abc-1234", false],
      ["`abc-1234`", false],
    ];
    for (const [value, quoted] of skipped) expect(isSecretAssignmentValue(value, "source", quoted)).toBe(false);
  });

  test("unquoted source values that are token shapes still qualify (test_source_value_rule_keeps_unquoted_token_shapes)", () => {
    for (const value of ["abc-123-def", "YWJjZGVmZ2hpams=", "a/b+c~12345", "12345678", AWS_SECRET]) {
      expect(isSecretAssignmentValue(value, "source", false)).toBe(true);
      expect(isSecretAssignmentValue(value, "source", true)).toBe(true);
    }
    // The token shape gates unquoted values only: a quoted literal of 20+ mixed-case characters goes whatever it holds.
    expect(isSecretAssignmentValue("stagedClient?.plaintext", "source", true)).toBe(true);
  });

  test("a source key must follow a delimiter (test_source_key_must_follow_a_delimiter)", () => {
    const cases: Array<[string, string | null]> = [
      // A key after `/`, `:`, `[`, `?`, `&`, `=` or `|` is not an assignment in source...
      ["key = 'cache/token:abc-123-def'", null],
      ["key = 'a:token=abc-123-def'", null],
      ['x = "[token=abc-123-def, y]"', null],
      ['url = "https://x/?token=abc-123-def&auth=abc-123-def"', null],
      ['x = "a=token=abc-123-def"', null],
      ['x = "a|token=abc-123-def"', null],
      // ...but one that starts the text or follows whitespace, `{`, `,`, `(`, a quote, a `+` diff marker or an escaped line break is.
      ['token = "abc-123-def"', 'token = "[REDACTED]"'],
      ["\ttoken = abc-123-def", "\ttoken = [REDACTED]"],
      ['{token: "abc-123-def"}', '{token: "[REDACTED]"}'],
      ['{a: 1,token: "abc-123-def"}', '{a: 1,token: "[REDACTED]"}'],
      ['f(token="abc-123-def")', 'f(token="[REDACTED]")'],
      ['{"token": "abc-123-def"}', '{"token": "[REDACTED]"}'],
      ["{'token': 'abc-123-def'}", "{'token': '[REDACTED]'}"],
      ['`token="abc-123-def"`', '`token="[REDACTED]"`'],
      ['+token = "abc-123-def"', '+token = "[REDACTED]"'],
      ["\\ntoken=abc-123-def", "\\ntoken=[REDACTED]"],
      // A dotted key still starts at its first segment.
      ['this.token = "hunter2abc"', 'this.token = "[REDACTED]"'],
    ];
    for (const [sample, expected] of cases) {
      expect(redactCollectorText(sample, { mode: "source" })).toEqual(expected === null ? { text: sample, count: 0 } : { text: expected, count: 1 });
    }
    // Config mode keeps the word-start guard: `?token=` in a query string and `#TOKEN=` on a commented-out line still count there.
    expect(redactCollectorText("https://x/?token=abc-123-def")).toEqual({ text: "https://x/?token=[REDACTED]", count: 1 });
    expect(redactCollectorText("#TOKEN=abc-123-def")).toEqual({ text: "#TOKEN=[REDACTED]", count: 1 });
  });

  test("limit-style keys are excluded in both modes (test_limit_style_keys_are_excluded_in_both_modes)", () => {
    for (const sample of [
      "AUTH_TIMEOUT = 30000000", "auth_timeout: 30000000", "TOKEN_LIMIT = 10000000", "token_max = 12345678", "secret_min = abcdefgh",
      "auth_interval = 60000000", "token_retries: 10000000", "AUTH_PORT = 80808080", "refresh_token_expires_in: 15897600",
      "password_encryption='scram-sha-256'", "provider_credential_ref: 'iproyal:claude-in-001'", "secret_envelope: params[8]",
      "token_expires_in = 15897600", "secret_algorithm = 'aes-256-gcm'", 'auth_callback = "https://x/cb?state=abc12345"',
    ]) {
      expect(redactCollectorText(sample, { mode: "source" })).toEqual({ text: sample, count: 0 });
      expect(redactCollectorText(sample, { mode: "config" })).toEqual({ text: sample, count: 0 });
    }
  });

  test("the second production sample comes back byte-identical (test_second_production_sample_is_byte_identical)", () => {
    const files: Array<[string, string]> = [
      ["src/client.ts", SAMPLE2_TS],
      ["scripts/pg.sh", SAMPLE2_SH],
      ["db/postgresql.conf", SAMPLE2_CONF],
      ["config/proxies.yml", SAMPLE2_YML],
      ["build/source-hashes.json", SAMPLE2_HASHES],
      ["tests/fixtures.py", SAMPLE2_FIXTURES],
    ];
    for (const [path, content] of files) expect(redactCollectorContent(path, content)).toBe(content);
    for (const sample of [SAMPLE2_TS, SAMPLE2_SH, SAMPLE2_FIXTURES]) expect(redactCollectorText(sample, { mode: "source" })).toEqual({ text: sample, count: 0 });
    for (const sample of [SAMPLE2_CONF, SAMPLE2_YML]) expect(redactCollectorText(sample)).toEqual({ text: sample, count: 0 });
    // The text rule is not the JSON rail: a YAML key that ends like a filename is still a key.
    expect(redactCollectorText("admin_auth.py: abcdefgh1234")).toEqual({ text: "admin_auth.py: [REDACTED]", count: 1 });
  });

  test("the second sample's true positives still go (test_second_sample_true_positives_still_go)", () => {
    // A path-like key leaves its value to the provider shapes; a bare user
    // stays but `user:pass` goes; a .patch file is source, so `config.token`
    // is a reference and `"hunter2abc"` a literal.
    expect(redactCollectorContent("build/source-hashes.json", `{"src/x.py": "${GITHUB_TOKEN}"}`)).toBe('{"src/x.py":"[REDACTED]"}');
    expect(redactCollectorJson({ "src/x.py": GITHUB_TOKEN })).toEqual({ value: { "src/x.py": "[REDACTED]" }, count: 1 });
    expect(redactCollectorContent("tests/fixtures.py", "LIVE_DSN = 'postgres://live:secret@host/db'\n")).toBe("LIVE_DSN = 'postgres://[REDACTED]@host/db'\n");
    expect(redactCollectorText("LIVE_DSN = 'postgres://live:secret@host/db'\n", { context: "tests/fixtures.py", mode: "source" }).count).toBe(1);
    expect(redactCollectorContent("fix.patch", PATCH)).toBe(PATCH.replace('"hunter2abc"', '"[REDACTED]"'));
    expect(redactCollectorText(PATCH, { context: "fix.patch", mode: redactModeForPath("fix.patch") }).count).toBe(1);
    // The envelope's git diff stays config, where a bare `hunter2abc` is a
    // literal; the same line in a .patch file is a name.
    expect(filterCollectorDiff("diff --git a/app/settings.py b/app/settings.py\n+password = hunter2abc\n").diff)
      .toBe("diff --git a/app/settings.py b/app/settings.py\n+password = [REDACTED]\n");
    expect(redactCollectorText("+password = hunter2abc", { mode: redactModeForPath("fix.patch") })).toEqual({ text: "+password = hunter2abc", count: 0 });
  });

  test("URL userinfo is redacted only with a password (test_url_userinfo_is_redacted_whole)", () => {
    expect(redactCollectorText(`git clone https://oauth2:${GITHUB_TOKEN}@github.com/acme/widgets.git`))
      .toEqual({ text: "git clone https://[REDACTED]@github.com/acme/widgets.git", count: 1 });
    expect(redactCollectorText("DATABASE_URL=postgres://admin:s3cret@db.internal:5432/app"))
      .toEqual({ text: "DATABASE_URL=postgres://[REDACTED]@db.internal:5432/app", count: 1 });
    expect(redactCollectorText("Authorization: Bearer <token>")).toEqual({ text: "Authorization: Bearer <token>", count: 0 });
    // Only `user:pass@` is userinfo worth redacting; a bare user stays.
    for (const sample of ["postgres://live@host:6432/db", "postgres://session@host/db", "DATABASE_URL=postgres://live@host:6432/db"]) {
      expect(redactCollectorText(sample)).toEqual({ text: sample, count: 0 });
      expect(redactCollectorText(sample, { mode: "source" })).toEqual({ text: sample, count: 0 });
    }
    expect(redactCollectorText("postgres://live:secret@host/db")).toEqual({ text: "postgres://[REDACTED]@host/db", count: 1 });
  });

  test("the assignment rule reads whitespace as Python does, and a source key may follow any non-ASCII character", () => {
    // U+0085 and U+001C-U+001F are whitespace to the backend's `\s`: a value
    // ends there and a key may start after one, on both sides.
    expect(redactCollectorText("token=abc-123-def\u0085tail", { mode: "source" })).toEqual({ text: "token=[REDACTED]\u0085tail", count: 1 });
    expect(redactCollectorText("x = 1\u001ctoken = abc-123-def", { mode: "source" })).toEqual({ text: "x = 1\u001ctoken = [REDACTED]", count: 1 });
    // U+FEFF is not whitespace to Python: a quoted value may hold one.
    expect(redactCollectorText('"token": "abc\ufeff12345"')).toEqual({ text: '"token": "[REDACTED]"', count: 1 });
    // The backend's source guard does not count U+FEFF as whitespace; the
    // desktop does, so the first line of a BOM-prefixed file is still scrubbed
    // here (the desktop is the stricter side).
    expect(redactCollectorContent("settings.py", '\ufeffpassword = "hunter2abc"\n')).toBe('\ufeffpassword = "[REDACTED]"\n');
    // The backend's `\w` is Unicode, so its key spans `café_token`; the
    // desktop's key starts after the `é`, with the same result.
    expect(redactCollectorText("café_token = 'hunter2abc'", { mode: "source" })).toEqual({ text: "café_token = '[REDACTED]'", count: 1 });
    // Where the backend finds no key at all (`ü` is a word character to it), the desktop still redacts.
    expect(redactCollectorText("ütoken = 'hunter2abc'", { mode: "source" })).toEqual({ text: "ütoken = '[REDACTED]'", count: 1 });
  });

  test("URL userinfo with an empty user and a password is redacted too (stricter than the backend at 46ee95e)", () => {
    // Redis's own AUTH form; the assignment rule cannot catch it (`REDIS_URL` ends in `url`).
    expect(redactCollectorContent("config/app.env", "REDIS_URL=redis://:p4ssw0rd@cache:6379/0\n")).toBe("REDIS_URL=redis://[REDACTED]@cache:6379/0\n");
    expect(redactCollectorContent("app.py", 'url = "rediss://:hunter2abc@cache:6380/0"\n')).toBe('url = "rediss://[REDACTED]@cache:6380/0"\n');
    expect(redactCollectorContent("broker.yml", "broker: amqp://:s3cretpw@mq:5672//\n")).toBe("broker: amqp://[REDACTED]@mq:5672//\n");
    // No password, no redaction: a bare user, an empty userinfo or none at all.
    for (const sample of ["postgres://live@host/db", "redis://@cache:6379/0", "redis://cache:6379/0", "http://[::1]:8080/x"]) {
      expect(redactCollectorText(sample)).toEqual({ text: sample, count: 0 });
    }
  });

  test("JSON files keep the AWS proximity rule: the raw-text pass and the container rail (test_json_files_keep_the_aws_secret_proximity_rule)", () => {
    // ECS task definitions, k8s env lists and Postman environments: the key
    // naming the secret is a sibling value, not the value's own key.
    const taskDefinition = JSON.stringify({
      containerDefinitions: [{
        environment: [
          { name: "AWS_ACCESS_KEY_ID", value: "AKIAIOSFODNN7EXAMPLE" },
          { name: "AWS_SECRET_ACCESS_KEY", value: AWS_SECRET },
        ],
      }],
    }, null, 2);
    const files: Record<string, string> = {
      "taskdef.json": taskDefinition,
      "taskdef.txt": taskDefinition,
      "taskdef.yaml": taskDefinition,
      "postman.json": `{"values": [{"key": "aws_secret", "value": "${AWS_SECRET}"}]}`,
      // The secret's own object names nothing: the id two lines above vouches for it, as in a text file.
      "pairs.json": `[\n  {"id": "AKIAIOSFODNN7EXAMPLE"},\n  {"k": "${AWS_SECRET}"}\n]\n`,
      // Escaped slashes break the run in the raw text; the sibling `name` is the context once parsed.
      "escaped.json": `{"name":"AWS_SECRET_ACCESS_KEY","value":"${AWS_SECRET.replaceAll("/", "\\/")}"}`,
      // Nothing near names an AWS key: a 40-character run is data.
      "plain.json": `{"hash": "${AWS_SECRET}"}`,
    };
    const out = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, redactCollectorContent(path, content)]));
    for (const [path, content] of Object.entries(out)) {
      JSON.parse(content);
      expect(content.includes(AWS_SECRET)).toBe(path === "plain.json");
    }
    expect(JSON.parse(out["taskdef.json"]!)).toEqual(JSON.parse(out["taskdef.txt"]!));
    expect(JSON.parse(out["taskdef.json"]!).containerDefinitions[0].environment).toEqual([
      { name: "AWS_ACCESS_KEY_ID", value: "[REDACTED]" },
      { name: "AWS_SECRET_ACCESS_KEY", value: "[REDACTED]" },
    ]);
    expect(JSON.parse(out["postman.json"]!)).toEqual({ values: [{ key: "aws_secret", value: "[REDACTED]" }] });
    expect(JSON.parse(out["pairs.json"]!)).toEqual([{ id: "[REDACTED]" }, { k: "[REDACTED]" }]);
    expect(JSON.parse(out["escaped.json"]!)).toEqual({ name: "AWS_SECRET_ACCESS_KEY", value: "[REDACTED]" });
    expect(out["plain.json"]).toBe(files["plain.json"]);
    // Keys whose last segment the second sample excluded lose the key rule, not the container rail.
    expect(redactCollectorContent("a.json", `{"secret_envelope": "${AWS_SECRET}"}`)).toBe('{"secret_envelope":"[REDACTED]"}');
    expect(redactCollectorContent("a.json", `{"aws_secret_ref": "${AWS_SECRET}"}`)).toBe('{"aws_secret_ref":"[REDACTED]"}');
    expect(redactCollectorContent("a.json", `{\n  "db": {\n    "secret_alias": "${AWS_SECRET}"\n  }\n}`))
      .toBe('{\n  "db": {\n    "secret_alias": "[REDACTED]"\n  }\n}');
    expect(redactCollectorContent("a.json", `{"src/secret.py": "${AWS_SECRET}"}`)).toBe('{"src/secret.py":"[REDACTED]"}');
  });

  test("trace AWS secrets need their key or a container naming AWS (test_trace_artifact_aws_secrets_need_key_or_container_context)", async () => {
    const document = {
      events: [
        { type: "tool.call", data: { note: "id AKIAIOSFODNN7EXAMPLE" } },
        { type: "tool.call", data: { note: AWS_SECRET } },
        { type: "tool.call", data: { aws_secret: AWS_SECRET } },
        { type: "tool.call", data: { name: "AWS_SECRET_ACCESS_KEY", value: AWS_SECRET } },
      ],
    };
    const { value, count } = redactCollectorJson(document);
    expect(JSON.parse(JSON.stringify(value)).events.map((event: { data: unknown }) => event.data)).toEqual([
      { note: "id [REDACTED]" },
      { note: AWS_SECRET },
      { aws_secret: "[REDACTED]" },
      { name: "AWS_SECRET_ACCESS_KEY", value: "[REDACTED]" },
    ]);
    expect(count).toBe(3);

    // The uploaded trace document gets the same rail.
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-trace-aws-"));
    roots.push(root);
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    const sessionId = "session-trace-aws-1234";
    collector.startSession(sessionId, "workspace-trace-aws", root);
    await collector.idle(sessionId);
    collector.recordTrace(sessionId, "tool.call", { name: "AWS_SECRET_ACCESS_KEY", value: AWS_SECRET });
    collector.flushTrace(sessionId);
    await collector.stop();
    expect(JSON.stringify(uploads)).not.toContain(AWS_SECRET);
    const trace = uploads.find((item) => item.snapshot_type === "trace")!;
    expect(trace.trace?.find((event) => event.type === "tool.call")?.data).toEqual({ name: "AWS_SECRET_ACCESS_KEY", value: "[REDACTED]" });
  });

  test("JSON repeated keys are kept and scrubbed (test_json_repeated_keys_are_kept_and_scrubbed)", () => {
    const deep = `{"a": 1, "a": ${"[".repeat(600)}${"]".repeat(600)}}`;
    const cases: Array<[string, string]> = [
      ['{"a": "x@example.com", "a": "clean"}', '{"a":"[REDACTED_PII]","a":"clean"}'],
      [`{"a": "${GITHUB_TOKEN}", "a": "clean"}`, '{"a":"[REDACTED]","a":"clean"}'],
      ['{"password": "hunter2abc", "password": "x"}', '{"password":"[REDACTED]","password":"x"}'],
      [
        '{"list": [{"k": "hunter2abc", "k": 1, "password": "hunter2abc"}], "n": 1.5, "t": true, "z": null, "u": "\\u00e9 \\"q\\""}',
        '{"list":[{"k":"hunter2abc","k":1,"password":"[REDACTED]"}],"n":1.5,"t":true,"z":null,"u":"é \\"q\\""}',
      ],
      // Nothing to redact: byte-identical, repeated key and all.
      ['{"a": "clean", "a": "cleaner"}', '{"a": "clean", "a": "cleaner"}'],
      // Too deep for the structural scrub: the text scrub instead.
      [deep, deep],
      // A shadowed provider token, with nothing else to redact.
      [`{"token": "${GITHUB_TOKEN}", "token": ""}`, '{"token":"[REDACTED]","token":""}'],
    ];
    for (const [input, expected] of cases) {
      const output = redactCollectorContent("a.json", input);
      expect(output).toBe(expected);
      JSON.parse(output);
    }
    // An indented document keeps its indentation, every pair and its empty containers.
    expect(redactCollectorContent("a.json", '{\n  "x": {"password": "hunter2abc", "password": "y"},\n  "e": [],\n  "o": {}\n}\n'))
      .toBe('{\n  "x": {\n    "password": "[REDACTED]",\n    "password": "y"\n  },\n  "e": [],\n  "o": {}\n}\n');
    // A `__proto__` key stays an ordinary member.
    expect(redactCollectorContent("a.json", '{"__proto__": {"password": "hunter2abc"}}')).toBe('{"__proto__":{"password":"[REDACTED]"}}');
  });

  test("a .patch file is scrubbed as source while the envelope's git diff stays config", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-patch-"));
    roots.push(root);
    await git(root, "init", "-q");
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "app", "settings.py"), "import config\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "initial");
    await writeFile(join(root, "app", "settings.py"), "import config\npassword = hunter2abc\n");
    await writeFile(join(root, "fix.patch"), PATCH);
    await writeFile(join(root, "notes.diff"), "+password = hunter2abc\n");
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, fallbackScanMs: 60_000 });
    collector.startSession("session-patch-1", "workspace-patch", root);
    await collector.stop();

    const start = uploads.find((item) => item.snapshot_type === "start")!;
    const content = (path: string) => start.files.find((file) => file.path === path)?.content;
    // Workspace files: .py, .patch and .diff are source, so a bare name stays and a quoted literal goes.
    expect(content("app/settings.py")).toBe("import config\npassword = hunter2abc\n");
    expect(content("fix.patch")).toBe(PATCH.replace('"hunter2abc"', '"[REDACTED]"'));
    expect(content("notes.diff")).toBe("+password = hunter2abc\n");
    // The envelope's git diff is config: the same bare value is a literal there.
    const gitBlock = start.workspace.git as { diff: string };
    expect(gitBlock.diff).toContain("+password = [REDACTED]");
    expect(gitBlock.diff).not.toContain("hunter2abc");
  });
});

// --- gateway auth: stale device tokens ---------------------------------------

describe("workspace collector gateway auth", () => {
  type Warning = { message: string; attributes?: Record<string, unknown> };

  async function authHarness(respond: (attempt: number) => Response, refresh?: () => Promise<string | null>) {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-auth-"));
    const stateDir = await mkdtemp(join(tmpdir(), "omnirush-collector-auth-state-"));
    roots.push(root, stateDir);
    await writeFile(join(root, "app.txt"), "hello\n");
    const uploads: Envelope[] = [];
    const warnings: Warning[] = [];
    const counters = { attempts: 0, refreshes: 0 };
    const collector = new WorkspaceCollector({
      stateDir,
      upload: async (_sessionId, compressed) => {
        counters.attempts += 1;
        const response = respond(counters.attempts);
        if (response.ok) uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Envelope);
        return response;
      },
      ...(refresh
        ? {
            refreshAccessToken: async () => {
              counters.refreshes += 1;
              return refresh();
            },
          }
        : {}),
      log: (level, message, attributes) => { if (level === "warn") warnings.push({ message, attributes }); },
      fallbackScanMs: 60_000,
      uploadRetryDelayMs: 1,
      retryBaseMs: 60_000,
    });
    const sessionId = "session-auth-1234";
    collector.startSession(sessionId, "workspace-auth", root);
    await collector.idle(sessionId);
    const rejected = warnings.filter((warning) => warning.message === "OmniRush collection upload rejected as unauthorized");
    return { collector, sessionId, uploads, warnings, rejected, counters };
  }

  const unauthorized = (status: number, body: unknown = { error: "token_expired" }) => Response.json(body, { status });
  const created = () => Response.json({ ok: true }, { status: 201 });

  test("refreshes the access token after a 401 and retries the upload once", async () => {
    const { collector, sessionId, uploads, rejected, counters } = await authHarness(
      (attempt) => (attempt === 1 ? unauthorized(401) : created()),
      async () => "fresh-token",
    );
    expect(counters).toEqual({ attempts: 2, refreshes: 1 });
    expect(uploads.map((item) => [item.snapshot_type, item.sequence])).toEqual([["start", 1]]);
    expect(await collector.spoolStatus()).toEqual({ entries: 0, bytes: 0 });
    expect(await collector.sessionDeliveryStatus(sessionId)).toMatchObject({ failureCount: 0 });
    expect(rejected).toEqual([{ message: "OmniRush collection upload rejected as unauthorized", attributes: { sessionId, status: 401, refreshed: true } }]);
    await collector.stop();
  });

  test("sends the refreshed bearer when retrying over the collect endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-auth-fetch-"));
    roots.push(root);
    await writeFile(join(root, "app.txt"), "hello\n");
    const bearers: string[] = [];
    const collector = new WorkspaceCollector({
      gatewayUrl: "https://gateway.example.test/v1",
      accessToken: "stale-token",
      fetch: async (_input: string, init?: RequestInit) => {
        bearers.push(String(new Headers(init?.headers).get("authorization")));
        return bearers.length === 1 ? unauthorized(401) : created();
      },
      refreshAccessToken: async () => "fresh-token",
      fallbackScanMs: 60_000,
      uploadRetryDelayMs: 1,
    });
    const sessionId = "session-auth-fetch-1234";
    collector.startSession(sessionId, "workspace-auth", root);
    await collector.idle(sessionId);
    expect(bearers).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
    await collector.stop();
    expect(bearers.at(-1)).toBe("Bearer fresh-token");
  });

  test("spools the upload when the gateway still rejects the refreshed token", async () => {
    const { collector, sessionId, uploads, warnings, rejected, counters } = await authHarness(() => unauthorized(401), async () => "fresh-token");
    expect(counters).toEqual({ attempts: 2, refreshes: 1 });
    expect(uploads).toHaveLength(0);
    expect(await collector.spoolStatus()).toMatchObject({ entries: 1 });
    expect(await collector.sessionDeliveryStatus(sessionId)).toMatchObject({ failureCount: 1, lastSuccessAt: null });
    expect(rejected).toHaveLength(1);
    expect(warnings.map((warning) => warning.message)).toContain("OmniRush collection artifact spooled for retry");
    await collector.stop();
  });

  test("spools the upload when the token refresh fails", async () => {
    const { collector, sessionId, uploads, rejected, counters } = await authHarness(
      (attempt) => (attempt === 1 ? unauthorized(401) : created()),
      async () => { throw new Error("refresh endpoint unavailable"); },
    );
    expect(counters).toEqual({ attempts: 1, refreshes: 1 });
    expect(uploads).toHaveLength(0);
    expect(await collector.spoolStatus()).toMatchObject({ entries: 1 });
    expect(rejected).toEqual([{
      message: "OmniRush collection upload rejected as unauthorized",
      attributes: { sessionId, status: 401, refreshed: false, refreshError: "refresh endpoint unavailable" },
    }]);
    await collector.stop();
  });

  test("spools the upload when no token refresh is available", async () => {
    const { collector, uploads, rejected, counters } = await authHarness((attempt) => (attempt === 1 ? unauthorized(401) : created()));
    expect(counters).toEqual({ attempts: 1, refreshes: 0 });
    expect(uploads).toHaveLength(0);
    expect(await collector.spoolStatus()).toMatchObject({ entries: 1 });
    expect(rejected[0]?.attributes).toMatchObject({ status: 401, refreshed: false });
    await collector.stop();
  });

  test("drops the upload without a refresh or spool entry when the account is signed out", async () => {
    for (const status of [403, 401]) {
      const { collector, sessionId, uploads, warnings, rejected, counters } = await authHarness(
        () => unauthorized(status, { error: "omnirush_account_required" }),
        async () => "fresh-token",
      );
      expect(counters).toEqual({ attempts: 1, refreshes: 0 });
      expect(uploads).toHaveLength(0);
      expect(rejected).toHaveLength(0);
      expect(await collector.spoolStatus()).toEqual({ entries: 0, bytes: 0 });
      expect(await collector.sessionDeliveryStatus(sessionId)).toMatchObject({ failureCount: 1, lastSuccessAt: null });
      const failed = warnings.find((warning) => warning.message === "OmniRush collection operation failed");
      expect(failed?.attributes).toMatchObject({ error: `collector upload failed with status ${status} (omnirush_account_required)` });
      await collector.stop();
    }
  });
});

// --- snapshot cap ------------------------------------------------------------

describe("workspace collector snapshot cap", () => {
  const KIB = 1024;
  const CAP = 3 * 1024 * 1024; // leaves 1 MiB for content once the 2 MiB wrapper margin is reserved
  const NAMES = Array.from({ length: 20 }, (_, index) => `file-${String(index).padStart(2, "0")}.txt`);

  /** Twenty files growing by 8 KiB each, 1.6 MiB in all: more than CAP leaves for content. */
  async function largeWorkspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-cap-"));
    roots.push(root);
    const line = "alpha beta gamma delta\n";
    await Promise.all(NAMES.map((name, index) => writeFile(join(root, name), line.repeat(Math.ceil(((index + 1) * 8 * KIB) / line.length)))));
    return root;
  }

  async function capture(root: string, options: { snapshotMaxBytes?: number; touched?: string[] }) {
    const uploads: Envelope[] = [];
    const rawBytes: number[] = [];
    const warnings: string[] = [];
    const collector = new WorkspaceCollector({
      upload: async (_sessionId, compressed) => {
        const buffer = zstdDecompressSync(compressed);
        rawBytes.push(buffer.length);
        uploads.push(JSON.parse(buffer.toString("utf8")) as Envelope);
        return Response.json({ ok: true }, { status: 201 });
      },
      log: (level, message) => { if (level === "warn") warnings.push(message); },
      fallbackScanMs: 60_000,
      ...(options.snapshotMaxBytes ? { snapshotMaxBytes: options.snapshotMaxBytes } : {}),
    });
    const sessionId = "session-cap-1234";
    collector.startSession(sessionId, "workspace-cap", root);
    for (const path of options.touched ?? []) collector.recordTrace(sessionId, "file.read", { path });
    collector.flushTrace(sessionId);
    await collector.stop();
    const start = uploads.find((item) => item.snapshot_type === "start")!;
    const startBytes = rawBytes[uploads.indexOf(start)]!;
    const sent = start.files.map((file) => file.path).filter((path) => !path.startsWith("__omnirush__/"));
    const manifestPaths = start.manifest.map((entry) => entry.path);
    const size = (path: string) => start.manifest.find((entry) => entry.path === path)!.size;
    const notes = uploads
      .filter((item) => item.snapshot_type === "trace")
      .flatMap((item) => item.trace ?? [])
      .filter((event) => event.type === "collector.snapshot_cap");
    return { start, startBytes, sent, manifestPaths, size, notes, warnings };
  }

  test("keeps touched files and the smallest others when a snapshot would exceed the cap", async () => {
    const root = await largeWorkspace();
    const touched = ["file-19.txt", "file-17.txt"];
    const { start, startBytes, sent, manifestPaths, size, notes, warnings } = await capture(root, { snapshotMaxBytes: CAP, touched });
    expect(startBytes).toBeLessThan(CAP);
    expect([...manifestPaths].sort()).toEqual(NAMES);
    for (const path of touched) expect(sent).toContain(path);
    const omitted = NAMES.filter((path) => !sent.includes(path));
    expect(omitted.length).toBeGreaterThan(0);
    expect(sent.length).toBeGreaterThan(touched.length);
    // Untouched content survives smallest first: nothing sent outranks anything omitted.
    const untouchedSent = sent.filter((path) => !touched.includes(path));
    expect(Math.max(...untouchedSent.map(size))).toBeLessThan(Math.min(...omitted.map(size)));
    // files[] keeps the listing order the manifest uses.
    expect(sent).toEqual(manifestPaths.filter((path) => sent.includes(path)));
    expect(start.privacy).toMatchObject({
      files_truncated: true,
      snapshot_cap_omitted_count: omitted.length,
      snapshot_cap_omitted_bytes: omitted.reduce((sum, path) => sum + size(path), 0),
    });
    expect(warnings.filter((message) => message === "OmniRush collection snapshot trimmed to the snapshot cap")).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ data: { snapshot_type: "start", trigger: "session_start", omitted_count: omitted.length } });
    expect(notes[0]?.data?.budget_bytes).toBeLessThan(CAP);
  });

  test("keeps the smallest touched files when the touched files alone exceed the cap", async () => {
    const root = await largeWorkspace();
    const { startBytes, sent, size, start } = await capture(root, { snapshotMaxBytes: CAP, touched: NAMES });
    expect(startBytes).toBeLessThan(CAP);
    const omitted = NAMES.filter((path) => !sent.includes(path));
    expect(omitted.length).toBeGreaterThan(0);
    expect(sent.length).toBeGreaterThan(0);
    expect(Math.max(...sent.map(size))).toBeLessThan(Math.min(...omitted.map(size)));
    expect(start.privacy).toMatchObject({ snapshot_cap_omitted_count: omitted.length });
  });

  test("leaves a snapshot under the cap unchanged", async () => {
    const root = await largeWorkspace();
    const { start, sent, manifestPaths, notes, warnings } = await capture(root, { touched: ["file-19.txt"] });
    expect(sent).toEqual(manifestPaths);
    expect([...sent].sort()).toEqual(NAMES);
    expect(start.privacy).toMatchObject({ files_truncated: false, snapshot_cap_omitted_count: 0, snapshot_cap_omitted_bytes: 0 });
    expect(notes).toHaveLength(0);
    expect(warnings).not.toContain("OmniRush collection snapshot trimmed to the snapshot cap");
  });
});

// --- incremental snapshots, watcher discipline and memory --------------------

describe("workspace collector incremental snapshots", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A git workspace with tracked sources, a dependency tree and gitignored build output. */
  async function workspace(prefix: string, sourceFiles = 30): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `omnirush-collector-${prefix}-`));
    roots.push(root);
    await git(root, "init", "-q");
    await writeFile(join(root, ".gitignore"), "dist/\nnode_modules/\n");
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    for (let index = 0; index < sourceFiles; index += 1) {
      await writeFile(join(root, "src", index % 2 ? "lib" : "", `f${String(index).padStart(2, "0")}.txt`), `source file ${index}\n`);
    }
    await writeFile(join(root, "README.md"), "# readme\n");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await writeFile(join(root, "dist", "bundle.js"), "bundled\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "init");
    return root;
  }

  const contentPaths = (envelope: Envelope) => envelope.files.map((file) => file.path).filter((path) => !path.startsWith("__omnirush__/"));
  const changes = (uploads: Envelope[]) => uploads.filter((item) => item.snapshot_type === "change");
  const triggerEvents = (uploads: Envelope[]) => uploads
    .filter((item) => item.snapshot_type === "trace")
    .flatMap((item) => item.trace ?? [])
    .filter((event) => event.type === "collector.trigger")
    .map((event) => event.data);

  test("mapBounded keeps at most `limit` operations in flight and returns results in order", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, index) => index);
    const results = await mapBounded(items, 8, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(1 + (item % 3));
      inFlight -= 1;
      return item * 2;
    });
    expect(results).toEqual(items.map((item) => item * 2));
    expect(peak).toBe(8);
    expect(await mapBounded([1, 2], 8, async (item) => item)).toEqual([1, 2]);
    expect(await mapBounded([], 8, async (item: number) => item)).toEqual([]);
  });

  test("a change snapshot reads only the changed file and reuses digests across sessions on one root", async () => {
    const root = await workspace("cache");
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    const first = "session-cache-first-1";
    collector.startSession(first, "workspace-cache", root);
    await collector.idle(first);
    const afterStart = { ...collector.metrics };
    expect(afterStart.fullScans).toBe(1);
    expect(afterStart.fileReads).toBeGreaterThanOrEqual(31);

    await writeFile(join(root, "src", "f06.txt"), "source file 6, edited\n");
    collector.captureSnapshot(first, "turn_completed");
    await collector.idle(first);
    const afterChange = { ...collector.metrics };
    const change = changes(uploads)[0]!;
    expect(contentPaths(change)).toEqual(["src/f06.txt"]);
    expect(change.files_scope).toBe("changed");
    expect(change.changed_paths).toEqual(["src/f06.txt"]);
    expect(change.manifest).toHaveLength(32);
    expect(change.manifest.find((entry) => entry.path === "src/f06.txt")?.sha256).toBe(sha256("source file 6, edited\n"));
    // One dirty-path scan: the journal read, the scan read and the upload read of that one file, no listing pass.
    expect(afterChange.fullScans).toBe(1);
    expect(afterChange.dirtyScans).toBe(1);
    expect(afterChange.fileReads - afterStart.fileReads).toBeLessThanOrEqual(3);
    expect(afterChange.fileStats - afterStart.fileStats).toBeLessThanOrEqual(3);

    // A second chat on the same workspace starts from the shared cache: a stat per file, no reads.
    const second = "session-cache-second-1";
    collector.startSession(second, "workspace-cache", root);
    await collector.idle(second);
    const afterSecond = { ...collector.metrics };
    expect(afterSecond.fullScans).toBe(2);
    const secondStart = uploads.find((item) => item.snapshot_type === "start" && item.session_id === second)!;
    expect(secondStart.files_scope).toBe("full");
    expect(contentPaths(secondStart)).toHaveLength(32);
    // The scan read nothing; the only reads are the upload pass sending each
    // file as it is on disk, verified by digest, without the regex pipeline.
    expect(afterSecond.fileReads - afterChange.fileReads).toBe(32);
    expect(afterSecond.fileRedactions - afterChange.fileRedactions).toBe(0);
    expect(collector.cacheStatus()).toEqual({ roots: 1, entries: 32 });
    await collector.stop();
    expect(collector.cacheStatus()).toEqual({ roots: 0, entries: 0 });
  });

  test("skips a milestone capture outright when nothing is dirty, and rescans after a new directory appears", async () => {
    const root = await workspace("dirty", 10);
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    const sessionId = "session-dirty-1234";
    collector.startSession(sessionId, "workspace-dirty", root);
    await collector.idle(sessionId);
    expect(collector.sessionDiagnostics(sessionId)).toMatchObject({ watchMode: "watching", dirtyPaths: 0, dirtyOverflow: false });
    const before = { ...collector.metrics };
    collector.captureSnapshot(sessionId, "turn_completed");
    collector.captureSnapshot(sessionId, "prompt");
    await collector.idle(sessionId);
    const after = { ...collector.metrics };
    expect(after.capturesSkipped - before.capturesSkipped).toBe(2);
    expect(after.fileStats - before.fileStats).toBe(0);
    expect(after.fullScans + after.dirtyScans).toBe(before.fullScans + before.dirtyScans);
    expect(changes(uploads)).toHaveLength(0);

    // Files inside a directory that appears whole arrive without events of
    // their own: the rename of the directory taints the dirty set and the next
    // capture rescans the tree.
    await mkdir(join(root, "feature"));
    await writeFile(join(root, "feature", "new.txt"), "brand new\n");
    await sleep(150);
    expect(collector.sessionDiagnostics(sessionId)?.dirtyOverflow).toBe(true);
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    expect(collector.metrics.fullScans).toBe(before.fullScans + 1);
    expect(contentPaths(changes(uploads)[0]!)).toEqual(["feature/new.txt"]);
    expect(collector.sessionDiagnostics(sessionId)?.watchedPaths).toContain("feature");
    collector.flushTrace(sessionId);
    await collector.stop();
    expect(triggerEvents(uploads)).toEqual([
      { trigger: "turn_completed", captured: false },
      { trigger: "prompt", captured: false },
      { trigger: "turn_completed", captured: true },
    ]);
  });

  test("watches only directories with eligible files, batches ignore checks and polls past the watched-files cap", async () => {
    const root = await workspace("watch", 6);
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 10, fallbackScanMs: 60_000 });
    const sessionId = "session-watch-1234";
    collector.startSession(sessionId, "workspace-watch", root);
    await collector.idle(sessionId);
    expect(collector.sessionDiagnostics(sessionId)?.watchedPaths.sort()).toEqual([".", "src"]);
    const before = { ...collector.metrics };
    // Churn in the dependency tree and in gitignored output never reaches a callback.
    for (let index = 0; index < 200; index += 1) {
      await writeFile(join(root, "node_modules", "pkg", `churn-${index}.js`), `// ${index}\n`);
      await writeFile(join(root, "dist", `chunk-${index}.js`), `// ${index}\n`);
    }
    await sleep(250);
    await collector.idle(sessionId);
    expect(collector.metrics.watchEvents - before.watchEvents).toBe(0);
    expect(collector.metrics.ignoreCheckSpawns - before.ignoreCheckSpawns).toBe(0);
    expect(changes(uploads)).toHaveLength(0);
    await collector.stop();
    expect(JSON.stringify(uploads)).not.toContain("churn-");
    expect(JSON.stringify(uploads)).not.toContain("chunk-");

    // New files are put to git's ignore rules in one spawn per burst, not one
    // per file (the production debounce is 2 s).
    const batched = makeUploads();
    const batcher = new WorkspaceCollector({ upload: batched.upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    const batchedId = "session-batched-1234";
    batcher.startSession(batchedId, "workspace-batched", root);
    await batcher.idle(batchedId);
    await writeFile(join(root, ".gitignore"), "dist/\nnode_modules/\n*.log\n");
    await sleep(120);
    const beforeBurst = batcher.metrics.ignoreCheckSpawns;
    for (let index = 0; index < 20; index += 1) await writeFile(join(root, `scratch-${index}.log`), `log ${index}\n`);
    await writeFile(join(root, "kept.txt"), "kept\n");
    await sleep(150);
    batcher.captureSnapshot(batchedId, "turn_completed");
    await batcher.idle(batchedId);
    // One spawn for the burst (two if it straddles a batch window), and one
    // fresh answer for everything the snapshot is about to carry.
    expect(batcher.metrics.ignoreCheckSpawns - beforeBurst).toBeLessThanOrEqual(3);
    const batchedChange = changes(batched.uploads).at(-1)!;
    expect(contentPaths(batchedChange)).toContain("kept.txt");
    expect(batchedChange.manifest.map((entry) => entry.path)).not.toContain("scratch-0.log");
    await batcher.stop();
    expect(JSON.stringify(batched.uploads)).not.toContain("scratch-");

    // Past the cap the tree is polled: no watchers, and a milestone rescans it.
    const polled = makeUploads();
    const poller = new WorkspaceCollector({ upload: polled.upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000, maxWatchedFiles: 3 });
    const polledId = "session-polled-1234";
    poller.startSession(polledId, "workspace-polled", root);
    await poller.idle(polledId);
    expect(poller.sessionDiagnostics(polledId)).toMatchObject({ watchMode: "polling", watchedPaths: [], dirtyOverflow: true });
    await writeFile(join(root, "src", "f01.txt"), "source file 1, polled edit\n");
    poller.captureSnapshot(polledId, "turn_completed");
    await poller.idle(polledId);
    expect(poller.metrics.fullScans).toBe(2);
    expect(contentPaths(changes(polled.uploads)[0]!)).toEqual(["src/f01.txt"]);
    await poller.stop();
  });

  test("labels snapshot scope and re-sends changes the gateway never accepted", async () => {
    const root = await workspace("scope", 4);
    const stateDir = await mkdtemp(join(tmpdir(), "omnirush-collector-scope-state-"));
    roots.push(stateDir);
    let status = 201;
    const uploads: Envelope[] = [];
    const collector = new WorkspaceCollector({
      stateDir,
      upload: async (_sessionId, compressed) => {
        if (status !== 201) return Response.json({ error: "rejected" }, { status });
        uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Envelope);
        return Response.json({ ok: true }, { status: 201 });
      },
      changeDebounceMs: 60_000,
      fallbackScanMs: 60_000,
    });
    const sessionId = "session-scope-1234";
    collector.startSession(sessionId, "workspace-scope", root);
    await collector.idle(sessionId);
    expect(uploads[0]).toMatchObject({ snapshot_type: "start", files_scope: "full" });
    expect(uploads[0]).not.toHaveProperty("changed_paths");

    await writeFile(join(root, "src", "f00.txt"), "rejected edit\n");
    status = 400;
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    expect(changes(uploads)).toHaveLength(0);
    status = 201;
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    const resent = changes(uploads)[0]!;
    expect(contentPaths(resent)).toEqual(["src/f00.txt"]);
    expect(resent.changed_paths).toEqual(["src/f00.txt"]);
    expect(resent.files_scope).toBe("changed");

    collector.flushTrace(sessionId);
    await collector.stop();
    const end = uploads.find((item) => item.snapshot_type === "end")!;
    expect(end.files_scope).toBe("changed");
    expect(end.changed_paths).toEqual([]);
    expect(uploads.find((item) => item.snapshot_type === "trace")?.files_scope).toBe("full");
    // Envelopes are streamed through a temp file that never outlives the upload.
    expect((await readdir(join(stateDir, "omnirush-collector-tmp")).catch(() => [])).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(collector.sessionDiagnostics(sessionId)).toBeNull();
  });

  test("spaces filesystem-driven change snapshots by the minimum interval while milestones capture at once", async () => {
    const root = await workspace("interval", 4);
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 10, fallbackScanMs: 60_000, minChangeIntervalMs: 500 });
    const sessionId = "session-interval-1234";
    collector.startSession(sessionId, "workspace-interval", root);
    await collector.idle(sessionId);
    await writeFile(join(root, "src", "f00.txt"), "first burst\n");
    await sleep(120);
    await collector.idle(sessionId);
    expect(changes(uploads)).toHaveLength(1);
    const firstAt = Date.parse(changes(uploads)[0]!.captured_at as string);
    // Two edits inside the window merge into one deferred snapshot.
    await writeFile(join(root, "src", "f01.txt"), "second burst a\n");
    await sleep(60);
    await writeFile(join(root, "src", "f02.txt"), "second burst b\n");
    await sleep(120);
    await collector.idle(sessionId);
    expect(changes(uploads)).toHaveLength(1);
    expect(collector.metrics.capturesDeferred).toBeGreaterThanOrEqual(1);
    await sleep(500);
    await collector.idle(sessionId);
    expect(changes(uploads)).toHaveLength(2);
    expect(contentPaths(changes(uploads)[1]!).sort()).toEqual(["src/f01.txt", "src/f02.txt"]);
    expect(Date.parse(changes(uploads)[1]!.captured_at as string) - firstAt).toBeGreaterThanOrEqual(450);
    // A turn milestone inside the window is not held back.
    await writeFile(join(root, "src", "f03.txt"), "milestone edit\n");
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    expect(changes(uploads)).toHaveLength(3);
    expect(contentPaths(changes(uploads)[2]!)).toEqual(["src/f03.txt"]);
    await collector.stop();
  });

  test("neither watches nor rescans a rebuilt gitignored directory, and rescans once .gitignore changes", async () => {
    const root = await workspace("ignored", 6);
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    const sessionId = "session-ignored-1234";
    collector.startSession(sessionId, "workspace-ignored", root);
    await collector.idle(sessionId);
    const before = { ...collector.metrics };
    // A build that wipes and recreates its gitignored output directory.
    await rm(join(root, "dist"), { recursive: true, force: true });
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "bundle.js"), "rebuilt\n");
    await sleep(200);
    expect(collector.sessionDiagnostics(sessionId)).toMatchObject({ dirtyOverflow: false });
    expect(collector.sessionDiagnostics(sessionId)?.watchedPaths).not.toContain("dist");
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    expect(collector.metrics.fullScans).toBe(before.fullScans);
    expect(changes(uploads)).toHaveLength(0);

    // An untracked log goes out; a new ignore rule then hides it, and the
    // edit to .gitignore makes the next capture rescan the tree under it.
    await writeFile(join(root, "notes.log"), "scratch notes\n");
    await sleep(150);
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    expect(changes(uploads).at(-1)!.manifest.map((entry) => entry.path)).toContain("notes.log");
    await writeFile(join(root, ".gitignore"), "dist/\nnode_modules/\n*.log\n");
    await sleep(150);
    expect(collector.sessionDiagnostics(sessionId)?.dirtyOverflow).toBe(true);
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    const last = changes(uploads).at(-1)!;
    expect(collector.metrics.fullScans).toBe(before.fullScans + 1);
    expect(last.manifest.map((entry) => entry.path)).not.toContain("notes.log");
    expect(last.changed_paths).toEqual([".gitignore"]);
    await collector.stop();
  });

  test("drops the files of a directory moved out of the workspace without rescanning the tree", async () => {
    const root = await workspace("moved", 10);
    const outside = await mkdtemp(join(tmpdir(), "omnirush-collector-moved-out-"));
    roots.push(outside);
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    const sessionId = "session-moved-1234";
    collector.startSession(sessionId, "workspace-moved", root);
    await collector.idle(sessionId);
    const before = { ...collector.metrics };
    // One event for the directory, none for the five files inside it.
    await rename(join(root, "src", "lib"), join(outside, "lib"));
    await sleep(200);
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    const change = changes(uploads)[0]!;
    const paths = change.manifest.map((entry) => entry.path);
    expect(paths.filter((path) => path.startsWith("src/lib/"))).toEqual([]);
    expect(paths).toContain("src/f00.txt");
    expect(collector.metrics.fullScans).toBe(before.fullScans);
    expect(collector.metrics.dirtyScans).toBe(before.dirtyScans + 1);
    await collector.stop();
  });

  test("polls a workspace with more top-level directories than it watches", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-wide-"));
    roots.push(root);
    for (let index = 0; index < 65; index += 1) {
      await mkdir(join(root, `dir${index}`));
      await writeFile(join(root, `dir${index}`, "a.txt"), `file ${index}\n`);
    }
    const { upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    const sessionId = "session-wide-1234";
    collector.startSession(sessionId, "workspace-wide", root);
    await collector.idle(sessionId);
    expect(collector.sessionDiagnostics(sessionId)).toMatchObject({ watchMode: "polling", watchedPaths: [], dirtyOverflow: true });
    await collector.stop();
  });

  test("keeps a file larger than the change journal out of it, and still snapshots the file", async () => {
    const root = await workspace("journal", 4);
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    const sessionId = "session-journal-1234";
    collector.startSession(sessionId, "workspace-journal", root);
    await collector.idle(sessionId);
    await writeFile(join(root, "src", "small.txt"), "small edit\n");
    await writeFile(join(root, "src", "large.txt"), "large log line\n".repeat(70_000));
    await sleep(200);
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    const change = changes(uploads)[0]!;
    expect(contentPaths(change).sort()).toEqual(["src/large.txt", "src/small.txt"]);
    const journal = change.files.find((file) => file.path === "__omnirush__/changes.json")!;
    expect(journal.content).toContain('"path":"src/small.txt"');
    expect(journal.content).not.toContain("src/large.txt");
    await collector.stop();
  });

  test("runs one reconcile pass per interval for every session on a root, and it finds what no watcher reported", async () => {
    const root = await workspace("reconcile", 4);
    // Every watcher slot is taken, so assets/, which held no file at the start, gets none.
    await fillWatchSlots(root);
    await mkdir(join(root, "assets"));
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 10, fallbackScanMs: 300, minChangeIntervalMs: 0 });
    const sessions = ["session-reconcile-a1", "session-reconcile-b1"];
    for (const sessionId of sessions) collector.startSession(sessionId, "workspace-reconcile", root);
    for (const sessionId of sessions) await collector.idle(sessionId);
    expect(collector.sessionDiagnostics(sessions[0]!)).toMatchObject({ watchMode: "watching" });
    expect(collector.sessionDiagnostics(sessions[0]!)?.watchedPaths).toHaveLength(65);
    expect(collector.sessionDiagnostics(sessions[0]!)?.watchedPaths).not.toContain("assets");
    const before = collector.metrics.reconciles;
    await writeFile(join(root, "assets", "found.txt"), "found by the reconcile pass\n");
    await sleep(1_000);
    for (const sessionId of sessions) await collector.idle(sessionId);
    const passes = collector.metrics.reconciles - before;
    // About three passes in a second at a 300 ms interval; per-session passes would make six.
    expect(passes).toBeGreaterThanOrEqual(1);
    expect(passes).toBeLessThanOrEqual(4);
    for (const sessionId of sessions) {
      const change = changes(uploads).find((item) => item.session_id === sessionId);
      expect(change && contentPaths(change)).toEqual(["assets/found.txt"]);
    }
    await collector.stop();
  });

  test("two chats on one folder: only the one running a turn uploads the edits made meanwhile, and each still captures its own milestones", async () => {
    const root = await workspace("shared", 4);
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 10, fallbackScanMs: 150, minChangeIntervalMs: 0 });
    const working = "session-shared-working-1";
    const idle = "session-shared-idle-0001";
    const both = [working, idle];
    for (const sessionId of both) collector.startSession(sessionId, "workspace-shared", root);
    for (const sessionId of both) await collector.idle(sessionId);
    const settle = async () => {
      // Past the debounce and several reconcile passes.
      await sleep(600);
      for (const sessionId of both) await collector.idle(sessionId);
    };
    const changesOf = (sessionId: string) => changes(uploads)
      .filter((item) => item.session_id === sessionId)
      .map((item) => [item.trigger, contentPaths(item).sort()]);
    // Whichever of the watcher and the reconcile pass saw the edit first.
    const edit = expect.stringMatching(/^(?:fs_change|periodic)$/);

    collector.captureSnapshot(working, "prompt");
    await collector.idle(working);
    await writeFile(join(root, "src", "f00.txt"), "the agent's edit\n");
    await settle();
    expect(changesOf(working)).toEqual([[edit, ["src/f00.txt"]]]);
    expect(changesOf(idle)).toEqual([]);
    expect(collector.metrics.capturesHeld).toBeGreaterThan(0);

    // The turn ends: the other chat still leaves that turn's edits alone, reconcile passes included.
    collector.captureSnapshot(working, "turn_completed");
    await settle();
    expect(changesOf(idle)).toEqual([]);

    // An edit between turns is uploaded once, by the chat that ran the last turn.
    await writeFile(join(root, "README.md"), "# edited by hand\n");
    await settle();
    expect(changesOf(working).at(-1)).toEqual([edit, ["README.md"]]);
    expect(changesOf(idle)).toEqual([]);

    // The other chat's own prompt carries what it has not sent yet; while it
    // runs its turn, the first chat holds back in turn.
    collector.captureSnapshot(idle, "prompt");
    await collector.idle(idle);
    expect(changesOf(idle)).toEqual([["prompt", ["README.md", "src/f00.txt"]]]);
    const sentByWorking = changesOf(working).length;
    await writeFile(join(root, "src", "f02.txt"), "the other agent's edit\n");
    await settle();
    expect(changesOf(idle).at(-1)).toEqual([edit, ["src/f02.txt"]]);
    expect(changesOf(working)).toHaveLength(sentByWorking);
    collector.captureSnapshot(idle, "turn_completed");
    await collector.idle(idle);
    for (const sessionId of both) collector.flushTrace(sessionId);
    await collector.stop();
    for (const sessionId of both) {
      const milestones = uploads
        .filter((item) => item.snapshot_type === "trace" && item.session_id === sessionId)
        .flatMap((item) => item.trace ?? [])
        .filter((event) => event.type === "collector.trigger")
        .map((event) => event.data?.trigger);
      expect(milestones).toEqual(["prompt", "turn_completed"]);
    }
  });

  test("keeps gitignored files out of change snapshots and the journal in a workspace git does not manage", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-nogit-"));
    roots.push(root);
    await writeFile(join(root, ".gitignore"), "*.log\nbuild/\n");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.txt"), "a\n");
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    const sessionId = "session-nogit-1234";
    collector.startSession(sessionId, "workspace-nogit", root);
    await collector.idle(sessionId);
    // git answers nothing here: the watcher-reported paths go through the
    // .gitignore files the listing walker applies.
    await writeFile(join(root, "src", "debug.log"), "debug output\n");
    await mkdir(join(root, "build"));
    await writeFile(join(root, "build", "out.txt"), "build output\n");
    await writeFile(join(root, "src", "b.txt"), "b\n");
    await sleep(200);
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    const change = changes(uploads)[0]!;
    expect(contentPaths(change)).toEqual(["src/b.txt"]);
    expect(change.manifest.map((entry) => entry.path).sort()).toEqual([".gitignore", "src/a.txt", "src/b.txt"]);
    await collector.stop();
    expect(JSON.stringify(uploads)).not.toContain("debug.log");
    expect(JSON.stringify(uploads)).not.toContain("out.txt");
  });

  /** src/ plus 63 more top-level directories with files: every watcher slot taken. */
  async function fillWatchSlots(root: string): Promise<void> {
    for (let index = 0; index < 63; index += 1) {
      const directory = join(root, `d${String(index).padStart(2, "0")}`);
      await mkdir(directory);
      await writeFile(join(directory, "a.txt"), `file ${index}\n`);
    }
  }

  test("watches the top-level directories the listing did not name, unless git ignores or the denylist names them", async () => {
    const root = await workspace("unlisted", 4);
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", ".env"), "API=1\n"); // denied, so config/ lists nothing
    await mkdir(join(root, "scripts")); // empty
    await mkdir(join(root, "secrets")); // a denied name
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 10, fallbackScanMs: 60_000, minChangeIntervalMs: 0 });
    const sessionId = "session-unlisted-1234";
    collector.startSession(sessionId, "workspace-unlisted", root);
    await collector.idle(sessionId);
    // Not dist/ (gitignored), node_modules/, secrets/ or .git/ (denied).
    expect(collector.sessionDiagnostics(sessionId)?.watchedPaths.sort()).toEqual([".", "config", "scripts", "src"]);
    // Another editor writes next to the denied file: the watcher sees it at once.
    await writeFile(join(root, "config", "app.yml"), "mode: production\n");
    await sleep(300);
    await collector.idle(sessionId);
    const change = changes(uploads)[0]!;
    expect(change.trigger).toBe("fs_change");
    expect(contentPaths(change)).toEqual(["config/app.yml"]);
    await collector.stop();
    expect(JSON.stringify(uploads)).not.toContain("API=1");
  });

  test("a turn's writes where no watcher reaches still land in that turn's change snapshot", async () => {
    const root = await workspace("unwatched", 4);
    await fillWatchSlots(root);
    await mkdir(join(root, "assets"));
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    const sessionId = "session-unwatched-1234";
    collector.startSession(sessionId, "workspace-unwatched", root);
    await collector.idle(sessionId);
    expect(collector.sessionDiagnostics(sessionId)?.watchedPaths).not.toContain("assets");
    collector.captureSnapshot(sessionId, "prompt");
    await collector.idle(sessionId);
    // A bash tool writes it; no trace event names it and no watcher covers assets/.
    await mkdir(join(root, "assets", "db"));
    await writeFile(join(root, "assets", "db", "migrate.sh"), "#!/bin/sh\necho migrate\n");
    await sleep(200);
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    // The end-of-turn artifact scan marks it dirty for the turn's own snapshot.
    expect(contentPaths(changes(uploads)[0]!)).toEqual(["assets/db/migrate.sh"]);
    collector.flushTrace(sessionId);
    await collector.stop();
    expect(triggerEvents(uploads)).toEqual([
      { trigger: "prompt", captured: false },
      { trigger: "turn_completed", captured: true },
    ]);
  });

  test.skipIf(process.platform === "win32")("a path git refuses to answer for (beyond a symlinked directory) neither changes the ignore answer for its batch nor gets read", async () => {
    const base = await mkdtemp(join(tmpdir(), "omnirush-collector-symlink-"));
    roots.push(base);
    const root = join(base, "repo");
    const outside = join(base, "shared-lib");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(outside);
    await git(root, "init", "-q");
    await appendFile(join(root, ".git", "info", "exclude"), "private-notes.txt\n");
    await writeFile(join(root, "src", "app.ts"), "export const app = 1;\n");
    await writeFile(join(outside, "util.ts"), "export const OUTSIDE_WORKSPACE = true;\n");
    // A symlinked shared package: `git check-ignore linked/util.ts` exits 128.
    await symlink("../shared-lib", join(root, "linked"));
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "init");
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    const sessionId = "session-symlink-1234";
    collector.startSession(sessionId, "workspace-symlink", root);
    await collector.idle(sessionId);
    // In one ignore batch: a note git ignores only through .git/info/exclude,
    // the agent's traced read through the symlinked package, and a real edit.
    await writeFile(join(root, "private-notes.txt"), "PRIVATE: salary negotiation notes\n");
    collector.recordTrace(sessionId, "tool.read", { filePath: "linked/util.ts" });
    await writeFile(join(root, "src", "app.ts"), "export const app = 2;\n");
    await sleep(200);
    collector.captureSnapshot(sessionId, "turn_completed");
    await collector.idle(sessionId);
    const change = changes(uploads)[0]!;
    expect(contentPaths(change)).toEqual(["src/app.ts"]);
    expect(change.manifest.map((entry) => entry.path)).toEqual(["src/app.ts"]);
    expect(change.files.find((file) => file.path === "__omnirush__/changes.json")?.content).toContain('"path":"src/app.ts"');
    await collector.stop();
    const all = JSON.stringify(uploads);
    expect(all).not.toContain("salary negotiation");
    expect(all).not.toContain("OUTSIDE_WORKSPACE");
  });

  test("a listed file the user then ignores leaves the manifest, files[] and the journal, through .gitignore or .git/info/exclude", async () => {
    for (const via of ["gitignore", "exclude"] as const) {
      const root = await workspace(`newly-ignored-${via}`, 4);
      await writeFile(join(root, "notes.txt"), "scratch v1\n"); // untracked, not ignored yet
      const { uploads, upload } = makeUploads();
      const collector = new WorkspaceCollector({ upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
      const sessionId = `session-newly-ignored-${via}`;
      collector.startSession(sessionId, "workspace-newly-ignored", root);
      await collector.idle(sessionId);
      expect(uploads[0]!.manifest.map((entry) => entry.path)).toContain("notes.txt");
      // An edit while it is still collected: git's "not ignored" is now cached.
      await writeFile(join(root, "notes.txt"), "scratch v1b\n");
      await sleep(200);
      collector.captureSnapshot(sessionId, "turn_completed");
      await collector.idle(sessionId);
      expect(contentPaths(changes(uploads)[0]!)).toEqual(["notes.txt"]);
      // The user hides it from git (.git/info/exclude raises no event), then writes something private into it.
      if (via === "gitignore") await writeFile(join(root, ".gitignore"), "dist/\nnode_modules/\nnotes.txt\n");
      else await appendFile(join(root, ".git", "info", "exclude"), "notes.txt\n");
      await sleep(150);
      await writeFile(join(root, "notes.txt"), "PRIVATE: do not share v2\n");
      await sleep(200);
      collector.captureSnapshot(sessionId, "turn_completed");
      await collector.idle(sessionId);
      const change = changes(uploads)[1]!;
      expect(change.manifest.map((entry) => entry.path)).not.toContain("notes.txt");
      expect(contentPaths(change)).not.toContain("notes.txt");
      await collector.stop();
      expect(JSON.stringify(uploads)).not.toContain("do not share v2");
    }
  });

  test("a resumed session's start snapshot carries every file again, even when its earlier start never reached the backend", async () => {
    const root = await workspace("resume-full", 4);
    const stateDir = await mkdtemp(join(tmpdir(), "omnirush-collector-resume-full-state-"));
    roots.push(stateDir);
    const sessionId = "session-resume-full-1";
    // Offline: the start snapshot is only spooled, and sign-out then deletes the spool.
    const offline = new WorkspaceCollector({
      stateDir,
      upload: async () => new Response("unavailable", { status: 503 }),
      uploadRetryDelayMs: 1,
      retryBaseMs: 60_000,
      retryMaxMs: 60_000,
      changeDebounceMs: 60_000,
      fallbackScanMs: 60_000,
    });
    offline.startSession(sessionId, "workspace-resume-full", root);
    await offline.idle(sessionId);
    await offline.stop();
    await offline.clearSpool();

    await writeFile(join(root, "src", "f00.txt"), "source file 0, edited while the app was closed\n");
    const { uploads, upload } = makeUploads();
    for (let run = 0; run < 2; run += 1) {
      const collector = new WorkspaceCollector({ stateDir, upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
      collector.startSession(sessionId, "workspace-resume-full", root);
      await collector.idle(sessionId);
      await collector.stop();
    }
    const starts = uploads.filter((item) => item.snapshot_type === "start");
    expect(starts.map((item) => [item.trigger, item.session_segment, item.files_scope, contentPaths(item).length])).toEqual([
      ["resume", 2, "full", 6],
      ["resume", 3, "full", 6],
    ]);
    expect(starts.every((item) => item.changed_paths === undefined)).toBe(true);
  });

  test("a new chat on a captured workspace sends scrubbed files from the redacted-text cache, not the scrubber", async () => {
    const root = await workspace("texts", 4);
    await writeFile(join(root, "src", "contact.txt"), "mail jane@example.com about it\n");
    await writeFile(join(root, "src", "config.yml"), "password: hunter2hunter2\n");
    const { uploads, upload } = makeUploads();
    const collector = new WorkspaceCollector({ upload, changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    const start = (id: string) => uploads.find((item) => item.snapshot_type === "start" && item.session_id === id)!;
    const content = (envelope: Envelope, path: string) => envelope.files.find((file) => file.path === path)?.content;

    collector.startSession("session-texts-first-1", "workspace-texts", root);
    await collector.idle("session-texts-first-1");
    // The scan scrubbed each file once; the upload pass reused that text for the two files the scrubber changed.
    expect(collector.metrics.redactedTextHits).toBe(2);
    const before = { ...collector.metrics };
    collector.startSession("session-texts-second", "workspace-texts", root);
    await collector.idle("session-texts-second");
    expect(collector.metrics.fileRedactions - before.fileRedactions).toBe(0);
    expect(collector.metrics.redactedTextHits - before.redactedTextHits).toBe(2);
    const first = start("session-texts-first-1");
    const second = start("session-texts-second");
    expect(content(second, "src/contact.txt")).toBe("mail [REDACTED_PII] about it\n");
    expect(content(second, "src/config.yml")).toBe("password: [REDACTED]\n");
    expect(second.files.filter((file) => !file.path.startsWith("__omnirush__/"))).toEqual(first.files.filter((file) => !file.path.startsWith("__omnirush__/")));
    expect(second.manifest).toEqual(first.manifest);

    // New bytes are scrubbed again, never served from the text of the old ones.
    await writeFile(join(root, "src", "contact.txt"), "mail joe@example.com instead of jane\n");
    const edited = { ...collector.metrics };
    collector.startSession("session-texts-third1", "workspace-texts", root);
    await collector.idle("session-texts-third1");
    expect(content(start("session-texts-third1"), "src/contact.txt")).toBe("mail [REDACTED_PII] instead of jane\n");
    expect(collector.metrics.fileRedactions - edited.fileRedactions).toBeGreaterThanOrEqual(1);
    await collector.stop();
  });

  test("snapshots a 60 MiB workspace with peak RSS growth under 120 MB", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-collector-memory-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    // Pseudo-random words so the content neither compresses away nor trips the scrubber.
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
    const filler = (seed: number, bytes: number): string => {
      let out = "";
      let value = seed;
      while (out.length < bytes) {
        value = (value * 1103515245 + 12345) % 2147483648;
        out += `${words[value % words.length]} ${value.toString(36)}${value % 7 === 0 ? "\n" : " "}`;
      }
      return out.slice(0, bytes);
    };
    let total = 0;
    for (let index = 0; index < 8; index += 1) {
      const text = filler(index + 1, 3 * 1024 * 1024);
      total += text.length;
      await writeFile(join(root, "src", `large-${index}.txt`), text);
    }
    for (let index = 0; index < 280; index += 1) {
      const text = filler(100 + index, 128 * 1024);
      total += text.length;
      await writeFile(join(root, "src", `small-${String(index).padStart(3, "0")}.txt`), text);
    }
    // Just under what the 64 MiB snapshot cap leaves for content.
    expect(total).toBeGreaterThanOrEqual(58 * 1024 * 1024);

    const compressedEnvelopes: Uint8Array[] = [];
    const collector = new WorkspaceCollector({
      upload: async (_sessionId, compressed) => {
        compressedEnvelopes.push(compressed);
        return Response.json({ ok: true }, { status: 201 });
      },
      changeDebounceMs: 60_000,
      fallbackScanMs: 60_000,
    });
    const gc = (globalThis as { gc?: () => void }).gc ?? (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc?.bind(null, true);
    gc?.();
    await sleep(50);
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
    const sessionId = "session-memory-1234";
    collector.startSession(sessionId, "workspace-memory", root);
    await collector.idle(sessionId);
    peak = Math.max(peak, process.memoryUsage().rss);
    clearInterval(sampler);
    await collector.stop();

    const growthMB = (peak - baseline) / (1024 * 1024);
    expect(growthMB).toBeLessThan(120);
    const start = JSON.parse(zstdDecompressSync(compressedEnvelopes[0]!).toString("utf8")) as Envelope;
    expect(start.snapshot_type).toBe("start");
    expect(start.files.reduce((sum, file) => sum + file.content.length, 0)).toBeGreaterThanOrEqual(58 * 1024 * 1024);
    expect(start.privacy).toMatchObject({ files_truncated: false });
  }, 60_000);
});
