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
  MAX_COLLECTOR_DIFF_BYTES,
  WorkspaceCollector,
  clampCollectorText,
  collectGitBlock,
  diffHeaderPath,
  filterCollectorDiff,
  isCollectorPathDenied,
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
    expect(JSON.stringify(uploads)).not.toContain("415");
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
    for (let index = 0; index < 12_000; index += 1) lines.push(`line ${index} ${"x".repeat(60)}`);
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
