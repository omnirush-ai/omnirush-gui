import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { FakeArchiveServer } from "./fake-archive-server.js";
import { SessionArchiver, type CaptureResult, type DrainResult } from "./index.js";
import {
  completedTurnCount,
  projectArchiveEnabled,
  ProjectArchiveLifecycle,
  type ArchiveEngineReads,
  type ProjectArchiver,
} from "./lifecycle.js";
import { cleanupTempDirs, manifestOf, openArchive, tempDir } from "./test-helpers.js";

const execFileAsync = promisify(execFile);

afterEach(cleanupTempDirs);

const queued = (kind: "base" | "delta", sequence = 0): CaptureResult => ({ status: "queued", archiveId: `archive-${kind}-${sequence}`, kind, sequence, size: 1 });
const skipped = (reason: Extract<CaptureResult, { status: "skipped" }>["reason"]): CaptureResult => ({ status: "skipped", reason });
const drained: DrainResult = { uploaded: 0, pending: 0, dropped: 0, blocked: null, disabled: false };

/** Records every call; each result can be swapped per test. */
class FakeArchiver implements ProjectArchiver {
  readonly calls: string[] = [];
  base: (sessionId: string, turn: number) => Promise<CaptureResult> = async () => queued("base");
  delta: (sessionId: string, turn: number) => Promise<CaptureResult> = async (_sessionId, turn) => queued("delta", turn);
  drainResult: () => Promise<DrainResult> = async () => drained;

  async captureBase(sessionId: string, root: string, turn = 0): Promise<CaptureResult> {
    this.calls.push(`base ${sessionId} ${root} ${turn}`);
    return this.base(sessionId, turn);
  }

  async captureDelta(sessionId: string, root: string, turn: number): Promise<CaptureResult> {
    this.calls.push(`delta ${sessionId} ${root} ${turn}`);
    return this.delta(sessionId, turn);
  }

  async drain(): Promise<DrainResult> {
    this.calls.push("drain");
    return this.drainResult();
  }

  async signOut(): Promise<void> {
    this.calls.push("signOut");
  }

  async stop(): Promise<void> {
    this.calls.push("stop");
  }

  captures(): string[] {
    return this.calls.filter((call) => call.startsWith("base") || call.startsWith("delta"));
  }
}

type Message = { info: Record<string, unknown>; parts: unknown[] };

/** A v1 engine message list: `completed` answered prompts, then optionally one still running. */
function messages(completed: number, running = false): Message[] {
  const list: Message[] = [];
  for (let turn = 1; turn <= completed + (running ? 1 : 0); turn += 1) {
    list.push({ info: { id: `user_${turn}`, role: "user", time: { created: turn } }, parts: [] });
    if (turn <= completed) list.push({ info: { id: `assistant_${turn}`, role: "assistant", time: { created: turn, completed: turn + 1 } }, parts: [] });
  }
  return list;
}

/** Engine reads for one session, counting how often each route is read. */
function engine(input: { parentID?: string; messages?: () => unknown; session?: () => unknown } = {}) {
  const reads = { session: 0, messages: 0 };
  const reader: ArchiveEngineReads = {
    session: async () => {
      reads.session += 1;
      return input.session ? input.session() : { id: "ses_root_0001", ...(input.parentID ? { parentID: input.parentID } : {}) };
    },
    messages: async () => {
      reads.messages += 1;
      return input.messages ? input.messages() : [];
    },
  };
  return { reader, reads };
}

function lifecycle(archiver: ProjectArchiver, options: { enabled?: boolean; now?: () => number; concurrency?: number } = {}) {
  const logs: Array<{ level: string; message: string; attributes?: Record<string, unknown> }> = [];
  const subject = new ProjectArchiveLifecycle({
    archiver,
    enabled: options.enabled ?? true,
    log: (level, message, attributes) => logs.push({ level, message, ...(attributes ? { attributes } : {}) }),
    consentRecheckMs: 60_000,
    ...(options.now ? { now: options.now } : {}),
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
  });
  return { subject, logs };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("completedTurnCount", () => {
  test("counts prompts answered by an assistant message that ended, v1 and v2 shapes", () => {
    expect(completedTurnCount(messages(0))).toBe(0);
    expect(completedTurnCount(messages(3))).toBe(3);
    // The running turn is not complete yet.
    expect(completedTurnCount(messages(2, true))).toBe(2);
    // Several assistant steps of one turn count once; a finish part or an error also ends a turn.
    expect(completedTurnCount([
      { info: { role: "user" } },
      { info: { role: "assistant", finish: "tool-calls" } },
      { info: { role: "assistant", time: { completed: 5 } } },
      { info: { role: "user" } },
      { info: { role: "assistant" }, parts: [{ type: "step-finish" }] },
      { info: { role: "user" } },
      { info: { role: "assistant", error: { name: "MessageAbortedError" } } },
    ])).toBe(3);
    // v2 context entries carry the role as `type`.
    expect(completedTurnCount([
      { id: "u1", type: "user" },
      { id: "a1", type: "assistant", time: { created: 1, completed: 2 } },
      { id: "c1", type: "compaction" },
      { id: "u2", type: "user" },
      { id: "a2", type: "assistant", content: [{ type: "text" }] },
    ])).toBe(1);
    expect(completedTurnCount(null)).toBeNull();
    expect(completedTurnCount({ status: 500, unavailable: true })).toBeNull();
  });
});

describe("projectArchiveEnabled", () => {
  test("is on by default and off only when OMNIRUSH_ARCHIVE_ENABLED says so", () => {
    expect(projectArchiveEnabled({})).toBe(true);
    expect(projectArchiveEnabled({ OMNIRUSH_ARCHIVE_ENABLED: "1" })).toBe(true);
    expect(projectArchiveEnabled({ OMNIRUSH_ARCHIVE_ENABLED: "" })).toBe(true);
    for (const off of ["0", "false", "FALSE", " no ", "off"]) expect(projectArchiveEnabled({ OMNIRUSH_ARCHIVE_ENABLED: off })).toBe(false);
  });
});

describe("ProjectArchiveLifecycle", () => {
  test("app start resumes the queue; a root session gets one base per app run at its real path and completed turns", async () => {
    const archiver = new FakeArchiver();
    const { subject, logs } = lifecycle(archiver);
    subject.start();
    await subject.settled();
    expect(archiver.calls).toEqual(["drain"]);

    const real = await tempDir("root");
    const link = join(await tempDir("links"), "project");
    await symlink(real, link);
    const reads = engine({ messages: () => messages(2, true) });
    subject.sessionStarted({ sessionId: "ses_root_0001", root: link, engine: reads.reader });
    // Every prompt dispatch calls this; only the first one reaches the archiver.
    subject.sessionStarted({ sessionId: "ses_root_0001", root: link, engine: reads.reader });
    await subject.settled();
    subject.sessionStarted({ sessionId: "ses_root_0001", root: link, engine: reads.reader });
    await subject.settled();

    expect(archiver.captures()).toEqual([`base ses_root_0001 ${real} 2`]);
    expect(reads.reads).toEqual({ session: 1, messages: 1 });
    // A queued base is uploaded right away.
    expect(archiver.calls.slice(1)).toEqual([`base ses_root_0001 ${real} 2`, "drain"]);
    expect(logs).toEqual([]);
  });

  test("child (sub-agent) sessions are never archived", async () => {
    const archiver = new FakeArchiver();
    const { subject } = lifecycle(archiver);
    const root = await tempDir("root");
    const child = engine({ parentID: "ses_root_0001", messages: () => messages(1) });
    subject.sessionStarted({ sessionId: "ses_child_0001", root, engine: child.reader });
    await subject.settled();
    subject.turnCompleted("ses_child_0001", messages(1));
    subject.sessionStarted({ sessionId: "ses_child_0001", root, engine: child.reader });
    await subject.settled();

    // v2 session records nest the fields under `info`.
    const v2Child = engine({ session: () => ({ info: { id: "ses_child_0002", parentID: "ses_root_0001" } }) });
    subject.sessionStarted({ sessionId: "ses_child_0002", root, engine: v2Child.reader });
    await subject.settled();

    expect(archiver.captures()).toEqual([]);
    // Known to be a child: the engine is not asked again, and its messages are never read.
    expect(child.reads).toEqual({ session: 1, messages: 0 });
  });

  test("delta turn numbers come from the engine's completed turns, in order after the base", async () => {
    const archiver = new FakeArchiver();
    const { subject } = lifecycle(archiver);
    const root = await tempDir("root");
    const baseGate = deferred<CaptureResult>();
    archiver.base = () => baseGate.promise;
    subject.sessionStarted({ sessionId: "ses_turns_0001", root, engine: engine({ messages: () => messages(0, true) }).reader });
    // The turn ends while the base is still packing: its delta waits for the base.
    subject.turnCompleted("ses_turns_0001", messages(1));
    subject.turnCompleted("ses_turns_0001", messages(2));
    // Unreadable messages: no delta (the next one carries the changes).
    subject.turnCompleted("ses_turns_0001", { status: 503, unavailable: true });
    // Unknown sessions (never started in this app run) are left alone.
    subject.turnCompleted("ses_unknown_0001", messages(4));
    baseGate.resolve(queued("base"));
    await subject.settled();

    expect(archiver.captures()).toEqual([
      `base ses_turns_0001 ${root} 0`,
      `delta ses_turns_0001 ${root} 1`,
      `delta ses_turns_0001 ${root} 2`,
    ]);
  });

  test("after a restart, a resumed session continues from the engine's turn count", async () => {
    const archiver = new FakeArchiver();
    const root = await tempDir("root");
    // The first app run archived turns 0 to 3 of this session; the archiver's state says so.
    archiver.base = async () => skipped("exists");
    const { subject } = lifecycle(archiver);
    subject.start();
    subject.sessionStarted({ sessionId: "ses_resumed_0001", root, engine: engine({ messages: () => messages(3, true) }).reader });
    subject.turnCompleted("ses_resumed_0001", messages(4));
    await subject.settled();
    expect(archiver.calls).toEqual(["drain", `base ses_resumed_0001 ${root} 3`, `delta ses_resumed_0001 ${root} 4`, "drain"]);
  });

  test("without an account (or with archiving turned off) start clears what a previous run left and nothing is captured", async () => {
    const archiver = new FakeArchiver();
    const { subject } = lifecycle(archiver, { enabled: false });
    subject.start();
    const root = await tempDir("root");
    subject.sessionStarted({ sessionId: "ses_signed_out_01", root, engine: engine().reader });
    subject.turnCompleted("ses_signed_out_01", messages(1));
    subject.sessionEnded("ses_signed_out_01");
    await subject.settled();
    expect(archiver.calls).toEqual(["signOut"]);
  });

  test("sign-out stops the archiver: queued steps never run and nothing is captured or uploaded afterwards", async () => {
    const archiver = new FakeArchiver();
    const { subject } = lifecycle(archiver);
    const root = await tempDir("root");
    const first = deferred<CaptureResult>();
    archiver.base = (sessionId) => (sessionId === "ses_first_0001" ? first.promise : Promise.resolve(queued("base")));
    subject.sessionStarted({ sessionId: "ses_first_0001", root, engine: engine().reader });
    // One capture at a time: the second session waits behind the first.
    subject.sessionStarted({ sessionId: "ses_second_001", root, engine: engine().reader });
    await Bun.sleep(5);
    expect(archiver.captures()).toEqual([`base ses_first_0001 ${root} 0`]);

    await subject.signOut();
    first.resolve(queued("base"));
    subject.sessionStarted({ sessionId: "ses_third_0001", root, engine: engine().reader });
    subject.turnCompleted("ses_first_0001", messages(1));
    subject.sessionEnded("ses_first_0001");
    await subject.settled();
    expect(archiver.calls).toEqual([`base ses_first_0001 ${root} 0`, "signOut"]);
  });

  test("428 (archive consent missing) turns archiving off quietly until the consent recheck", async () => {
    let now = 1_000;
    const archiver = new FakeArchiver();
    const { subject, logs } = lifecycle(archiver, { now: () => now });
    const root = await tempDir("root");
    archiver.base = async () => skipped("disabled");
    subject.sessionStarted({ sessionId: "ses_consent_001", root, engine: engine().reader });
    await subject.settled();
    // Off: no capture, no consent check and no upload for any session.
    subject.sessionStarted({ sessionId: "ses_consent_001", root, engine: engine().reader });
    subject.sessionStarted({ sessionId: "ses_consent_002", root, engine: engine().reader });
    subject.turnCompleted("ses_consent_001", messages(1));
    subject.sessionEnded("ses_consent_003");
    await subject.settled();
    expect(archiver.calls).toEqual([`base ses_consent_001 ${root} 0`]);

    // Past the recheck time the session's next prompt checks consent again, which is now given.
    now += 60_001;
    archiver.base = async () => queued("base");
    subject.sessionStarted({ sessionId: "ses_consent_001", root, engine: engine({ messages: () => messages(1, true) }).reader });
    await subject.settled();
    expect(archiver.calls.slice(1)).toEqual([`base ses_consent_001 ${root} 1`, "drain"]);

    // Consent withdrawn while uploading: the drain turns archiving off the same way.
    archiver.drainResult = async () => ({ ...drained, dropped: 1, disabled: true });
    subject.turnCompleted("ses_consent_001", messages(2));
    await subject.settled();
    subject.turnCompleted("ses_consent_001", messages(3));
    subject.sessionStarted({ sessionId: "ses_consent_004", root, engine: engine().reader });
    await subject.settled();
    expect(archiver.calls.slice(3)).toEqual([`delta ses_consent_001 ${root} 2`, "drain"]);
    expect(logs).toEqual([]);
  });

  test("failures never reach the caller: one warn line each, and archiving carries on", async () => {
    const archiver = new FakeArchiver();
    const { subject, logs } = lifecycle(archiver);
    const root = await tempDir("root");
    archiver.base = async (sessionId) => {
      if (sessionId === "ses_throws_0001") throw new Error("disk full");
      return queued("base");
    };
    archiver.drainResult = async () => { throw new Error("drain exploded"); };
    subject.sessionStarted({ sessionId: "ses_throws_0001", root, engine: engine().reader });
    // The engine could not be read: skipped now, tried again on the next prompt.
    let engineUp = false;
    const flaky = engine({ session: () => { if (!engineUp) throw new Error("ECONNREFUSED"); return { id: "ses_flaky_00001" }; } });
    subject.sessionStarted({ sessionId: "ses_flaky_00001", root, engine: flaky.reader });
    // A root that no longer exists is not archivable; nothing to warn about.
    subject.sessionStarted({ sessionId: "ses_gone_000001", root: join(root, "missing"), engine: engine().reader });
    await subject.settled();
    expect(archiver.captures()).toEqual([`base ses_throws_0001 ${root} 0`]);
    expect(logs.map((log) => [log.level, log.message, log.attributes?.step ?? log.attributes?.reason])).toEqual([
      ["warn", "OmniRush project archive step failed", "base"],
      ["warn", "OmniRush project archive could not read the engine for a session; its next prompt or turn tries again", "the engine session could not be read"],
    ]);

    engineUp = true;
    subject.sessionStarted({ sessionId: "ses_flaky_00001", root, engine: flaky.reader });
    await subject.settled();
    expect(archiver.captures().at(-1)).toBe(`base ses_flaky_00001 ${root} 0`);
    expect(logs.at(-1)).toMatchObject({ level: "warn", message: "OmniRush project archive step failed", attributes: { step: "drain", error: "Error: drain exploded" } });
    // Resolved once: later prompts do not read the engine again.
    subject.sessionStarted({ sessionId: "ses_flaky_00001", root, engine: flaky.reader });
    await subject.settled();
    expect(flaky.reads).toEqual({ session: 2, messages: 1 });
  });

  test("after a restart the engine can still be starting: the session is resolved when its turn completes, and the turn's delta is not lost", async () => {
    const archiver = new FakeArchiver();
    const { subject, logs } = lifecycle(archiver);
    const root = await tempDir("root");
    // The previous app run archived the base and turns 1 to 7.
    archiver.base = async () => skipped("exists");
    let engineUp = false;
    const slow = engine({
      session: () => {
        if (!engineUp) throw new Error("TimeoutError: the engine did not answer");
        return { id: "ses_restart_0001" };
      },
      messages: () => messages(7, true),
    });
    subject.start();
    subject.sessionStarted({ sessionId: "ses_restart_0001", root, engine: slow.reader });
    await subject.settled();
    expect(archiver.captures()).toEqual([]);
    expect(logs.map((log) => log.attributes?.reason)).toEqual(["the engine session could not be read"]);

    // The engine came up and ran turn 8; the observer read its messages.
    engineUp = true;
    subject.turnCompleted("ses_restart_0001", messages(8));
    await subject.settled();
    expect(archiver.captures()).toEqual([`base ses_restart_0001 ${root} 8`, `delta ses_restart_0001 ${root} 8`]);
    // The observer's messages give the count: the message list is not read again.
    expect(slow.reads).toEqual({ session: 2, messages: 0 });

    // Resolved: the next turn is an ordinary delta, with no engine read.
    subject.turnCompleted("ses_restart_0001", messages(9));
    subject.sessionStarted({ sessionId: "ses_restart_0001", root, engine: slow.reader });
    await subject.settled();
    expect(archiver.captures().slice(2)).toEqual([`delta ses_restart_0001 ${root} 9`]);
    expect(slow.reads).toEqual({ session: 2, messages: 0 });
  });

  test("a session still unreadable when its turn completes stays pending; a child resolved at turn end is never archived", async () => {
    const archiver = new FakeArchiver();
    const { subject, logs } = lifecycle(archiver);
    const root = await tempDir("root");
    let engineUp = false;
    const down = engine({ session: () => { if (!engineUp) throw new Error("ECONNREFUSED"); return { id: "ses_down_000001" }; } });
    subject.sessionStarted({ sessionId: "ses_down_000001", root, engine: down.reader });
    subject.turnCompleted("ses_down_000001", messages(1));
    await subject.settled();
    expect(archiver.captures()).toEqual([]);
    expect(logs).toHaveLength(2);
    // The changes are not lost: the first turn that can resolve the session captures the folder.
    engineUp = true;
    subject.turnCompleted("ses_down_000001", messages(2));
    await subject.settled();
    expect(archiver.captures()).toEqual([`base ses_down_000001 ${root} 2`, `delta ses_down_000001 ${root} 2`]);

    let childUp = false;
    const child = engine({ session: () => { if (!childUp) throw new Error("ECONNREFUSED"); return { id: "ses_child_0003", parentID: "ses_down_000001" }; } });
    subject.sessionStarted({ sessionId: "ses_child_0003", root, engine: child.reader });
    await subject.settled();
    childUp = true;
    subject.turnCompleted("ses_child_0003", messages(1));
    subject.turnCompleted("ses_child_0003", messages(2));
    await subject.settled();
    expect(archiver.captures()).toHaveLength(2);
    expect(child.reads).toEqual({ session: 2, messages: 0 });
  });

  test("with the real archiver: base at session start, a delta per changed turn, and the next app run resumes the upload", async () => {
    const server = new FakeArchiveServer();
    const root = await tempDir("project");
    const git = (...args: string[]) => execFileAsync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args]);
    await git("init", "-q", "-b", "main");
    await writeFile(join(root, "app.ts"), "export const app = 1;\n");
    await git("add", "app.ts");
    await git("commit", "-q", "-m", "initial");
    const state = await tempDir("state");
    const archiverFor = (now?: () => Date) => new SessionArchiver({
      gatewayUrl: server.gatewayUrl,
      accessToken: server.token,
      fetch: server.respond,
      stateDir: state,
      retry: { baseMs: 1, maxMs: 2, attempts: 2 },
      ...(now ? { now } : {}),
    });

    const first = lifecycle(archiverFor());
    first.subject.start();
    first.subject.sessionStarted({ sessionId: "ses_real_000001", root, engine: engine({ messages: () => messages(0, true) }).reader });
    await first.subject.settled();
    // Nothing changed during turn 1: no delta.
    first.subject.turnCompleted("ses_real_000001", messages(1));
    await first.subject.settled();
    expect(server.objects().map((archive) => [archive.request.kind, archive.request.turn])).toEqual([["base", 0]]);

    // Turn 2 changes the folder, but S3 is unreachable until the app restarts.
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/feature.ts"), "export const feature = true;\n");
    server.putHook = () => "network";
    first.subject.turnCompleted("ses_real_000001", messages(2));
    await first.subject.settled();
    await first.subject.stop();
    expect(server.objects()).toHaveLength(1);

    // The next app run, after the failed job's backoff.
    server.putHook = null;
    const later = new Date(Date.now() + 2 * 60_000);
    const second = lifecycle(archiverFor(() => later));
    second.subject.start();
    await second.subject.settled();
    const archives = server.objects();
    expect(archives.map((archive) => [archive.request.kind, archive.request.sequence, archive.request.turn])).toEqual([["base", 0, 0], ["delta", 1, 2]]);
    const delta = await openArchive(archives[1]!.object!);
    expect(delta.map((member) => member.name)).toContain("src/feature.ts");
    expect(manifestOf(delta)).toMatchObject({ kind: "delta", turn: 2 });
    expect([...first.logs, ...second.logs].filter((log) => log.level === "warn" && !log.message.includes("deferred"))).toEqual([]);
  });

  test("with the real archiver: after an app restart whose engine is still starting, the first turn's change is archived with its turn", async () => {
    const server = new FakeArchiveServer();
    const root = await tempDir("project");
    const git = (...args: string[]) => execFileAsync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args]);
    await git("init", "-q", "-b", "main");
    await writeFile(join(root, "app.ts"), "export const app = 1;\n");
    await git("add", "app.ts");
    await git("commit", "-q", "-m", "initial");
    const state = await tempDir("state");
    const archiverFor = () => new SessionArchiver({ gatewayUrl: server.gatewayUrl, accessToken: server.token, fetch: server.respond, stateDir: state, retry: { baseMs: 1, maxMs: 2, attempts: 2 } });

    const first = lifecycle(archiverFor());
    first.subject.start();
    first.subject.sessionStarted({ sessionId: "ses_restarted_01", root, engine: engine({ messages: () => messages(0, true) }).reader });
    await first.subject.settled();
    await writeFile(join(root, "after.txt"), "after restart\n");
    first.subject.turnCompleted("ses_restarted_01", messages(1));
    await first.subject.settled();
    await first.subject.stop();

    // The next app run: the engine does not answer the session start's reads.
    const second = lifecycle(archiverFor());
    second.subject.start();
    let engineUp = false;
    const reads = engine({
      session: () => {
        if (!engineUp) throw new Error("TimeoutError: the engine did not answer");
        return { id: "ses_restarted_01" };
      },
      messages: () => messages(1, true),
    });
    second.subject.sessionStarted({ sessionId: "ses_restarted_01", root, engine: reads.reader });
    await second.subject.settled();
    engineUp = true;
    await writeFile(join(root, "after.txt"), "after restart 2\n");
    second.subject.turnCompleted("ses_restarted_01", messages(2));
    await second.subject.settled();

    const archives = server.objects();
    expect(archives.map((archive) => [archive.request.kind, archive.request.sequence, archive.request.turn])).toEqual([["base", 0, 0], ["delta", 1, 1], ["delta", 2, 2]]);
    const latest = await openArchive(archives[2]!.object!);
    expect(latest.find((member) => member.name === "after.txt")!.content.toString()).toBe("after restart 2\n");
    expect(manifestOf(latest)).toMatchObject({ kind: "delta", turn: 2 });
  });
});

describe("ProjectArchiveLifecycle base quiet period", () => {
  const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

  function deferring(archiver: ProjectArchiver, baseIdleMs: number, baseMaxDeferMs: number) {
    return new ProjectArchiveLifecycle({ archiver, enabled: true, log: () => undefined, consentRecheckMs: 60_000, baseIdleMs, baseMaxDeferMs });
  }

  test("bases wait until no prompt has been dispatched for baseIdleMs", async () => {
    const archiver = new FakeArchiver();
    const packedAt = new Map<string, number>();
    archiver.base = async (sessionId) => {
      packedAt.set(sessionId, Date.now());
      return queued("base");
    };
    const subject = deferring(archiver, 300, 5_000);
    const [first, second] = [await tempDir("first"), await tempDir("second")];
    subject.sessionStarted({ sessionId: "ses_first_00001", root: first, engine: engine().reader });
    await sleep(200);
    const lastPromptAt = Date.now();
    subject.sessionStarted({ sessionId: "ses_second_0001", root: second, engine: engine().reader });
    await sleep(200);
    // The first prompt is 400 ms old, but the second only 200 ms: nothing packed yet.
    expect(archiver.captures()).toEqual([]);
    await subject.settled();
    expect(archiver.captures().map((call) => call.split(" ")[1]).sort()).toEqual(["ses_first_00001", "ses_second_0001"]);
    for (const at of packedAt.values()) expect(at - lastPromptAt).toBeGreaterThanOrEqual(290);
  });

  test("a steady stream of prompts delays a base by at most baseMaxDeferMs", async () => {
    const archiver = new FakeArchiver();
    let packedAt = 0;
    archiver.base = async () => {
      packedAt = Date.now();
      return queued("base");
    };
    const subject = deferring(archiver, 200, 600);
    const startedAt = Date.now();
    subject.sessionStarted({ sessionId: "ses_busy_000001", root: await tempDir("busy"), engine: engine().reader });
    const other = await tempDir("other");
    for (let prompt = 0; prompt < 10 && packedAt === 0; prompt += 1) {
      await sleep(100);
      subject.sessionStarted({ sessionId: "ses_other_00001", root: other, engine: engine().reader });
    }
    await subject.settled();
    expect(packedAt - startedAt).toBeGreaterThanOrEqual(590);
    expect(packedAt - startedAt).toBeLessThan(1_000);
  });

  test("stop and sign-out end the wait without packing", async () => {
    for (const end of ["stop", "signOut"] as const) {
      const archiver = new FakeArchiver();
      const subject = deferring(archiver, 60_000, 120_000);
      subject.sessionStarted({ sessionId: "ses_waiting_0001", root: await tempDir("waiting"), engine: engine().reader });
      await sleep(50);
      const endedAt = Date.now();
      await subject[end]();
      await subject.settled();
      expect(Date.now() - endedAt).toBeLessThan(1_000);
      expect(archiver.captures()).toEqual([]);
    }
  });
});
