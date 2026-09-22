import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";

import {
  COLLECTOR_SCHEMA_VERSION,
  MAX_COLLECTOR_ATTACHMENT_TEXT_BYTES,
  MAX_COLLECTOR_DIFF_BYTES,
  MAX_COLLECTOR_FILE_BYTES,
  MAX_COLLECTOR_FILES,
  MAX_COLLECTOR_SESSION_BYTES,
  MAX_COLLECTOR_TRACE_BYTES,
  MAX_COLLECTOR_TRACE_EVENTS,
  MAX_COLLECTOR_WEB_VISIT_TEXT_BYTES,
  WorkspaceCollector,
  clampCollectorBytes,
  clampCollectorText,
  collectGitBlock,
  diffHeaderPath,
  filterCollectorDiff,
  isCollectableWebUrl,
  isCollectorPathDenied,
  redactCollectorContent,
  redactCollectorJson,
  redactCollectorJsonText,
  redactCollectorText,
  stripRemoteUserinfo,
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
    expect(MAX_COLLECTOR_SESSION_BYTES).toBe(512 * 1024 * 1024);
    expect(MAX_COLLECTOR_DIFF_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_COLLECTOR_FILES).toBe(50_000);
    expect(MAX_COLLECTOR_WEB_VISIT_TEXT_BYTES).toBe(64 * 1024);
    expect(MAX_COLLECTOR_ATTACHMENT_TEXT_BYTES).toBe(256 * 1024);
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
    expect(redactCollectorText(`# aws profile\n${AWS_SECRET}`).text).toBe("# aws profile\n[REDACTED]");
    expect(redactCollectorText(`${AWS_SECRET}\n\nsecret: yes`).text).toBe("[REDACTED]\n\nsecret: yes");
    expect(redactCollectorText(AWS_SECRET).text).toBe(AWS_SECRET);
    expect(redactCollectorText(AWS_SECRET, { context: "AWS master secret.txt" }).text).toBe("[REDACTED]");
    // Not mixed case (a git sha), or not exactly 40 characters: left alone.
    expect(redactCollectorText("aws sha 0123456789abcdef0123456789abcdef01234567").text).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(redactCollectorText(`aws ${AWS_SECRET}extra`).text).toContain(AWS_SECRET);
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
    ];
    for (const line of lines) {
      const started = performance.now();
      redactCollectorText(line);
      expect(performance.now() - started).toBeLessThan(2_000);
    }
  }, 30_000);
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
