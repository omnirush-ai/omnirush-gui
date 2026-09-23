import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import {
  createSessionObservers,
  observeCollectedSession,
  projectArchiveEngineReads,
  type EngineTarget,
  type ObservedCollector,
  type ObserverTiming,
  type SessionObservers,
} from "./collector-observer.js";
import type { CaptureResult, DrainResult, FinalReason } from "./session-archive/index.js";
import { ProjectArchiveLifecycle, type ProjectArchiver } from "./session-archive/lifecycle.js";
import { WorkspaceCollector, type CollectorChildSession } from "./workspace-collector.js";

/**
 * The turn observer against a fake engine, on a fake clock: a turn is
 * followed for as long as it runs (hours of it pass without real waiting), an
 * engine that does not answer is waited out, and messages a turn could not
 * flush go out with the next settled one, over several flushes when needed.
 */

const SESSION = "ses_observed_0001";
const HOUR = 60 * 60_000;
const MIB = 1024 * 1024;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

type EngineMessage = { info: Record<string, unknown>; parts: unknown[] };

function message(id: string, role: "user" | "assistant", text = `${role} ${id}`): EngineMessage {
  return {
    info: {
      id,
      sessionID: SESSION,
      role,
      time: role === "assistant" ? { created: 1, completed: 2 } : { created: 1 },
      ...(role === "assistant" ? { providerID: "omnirush", modelID: "gpt-6-astra", mode: "build" } : {}),
    },
    parts: [{ id: `${id}_part`, messageID: id, sessionID: SESSION, type: "text", text }],
  };
}

/** A long answer: `mib` MiB of agent output. */
function longAnswer(id: string, mib: number): EngineMessage {
  return message(id, "assistant", "agent output line\n".repeat(Math.floor((mib * MIB) / 18)));
}

/** The engine's message paging (`?limit=&before=`): the newest `limit` messages before the cursor, oldest first. */
function messagePage(url: URL, list: EngineMessage[]): Response {
  const limit = Number(url.searchParams.get("limit") ?? 0);
  if (!limit) return Response.json(list);
  const end = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : list.length;
  const start = Math.max(0, end - limit);
  return Response.json(list.slice(start, end), start > 0 ? { headers: { "X-Next-Cursor": String(start) } } : {});
}

/** A fake v1 engine holding one session: its status, its messages, and hooks on its reads. */
function startEngine() {
  const control = {
    status: (): string => "idle",
    messages: [] as EngineMessage[],
    /** Real milliseconds the next status reads take to answer, one entry per read. */
    statusDelaysMs: [] as number[],
    statusReads: 0,
    /** Runs once a page of messages was read. */
    onMessagesRead: null as (() => void) | null,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/session/status") {
        control.statusReads += 1;
        const delay = control.statusDelaysMs.shift();
        if (delay) await Bun.sleep(delay);
        const type = control.status();
        return Response.json(type === "idle" ? {} : { [SESSION]: { type } });
      }
      if (url.pathname === `/session/${SESSION}/message`) {
        const page = messagePage(url, control.messages);
        control.onMessagesRead?.();
        return page;
      }
      if (url.pathname === `/session/${SESSION}/children`) return Response.json([]);
      if (url.pathname === `/session/${SESSION}`) return Response.json({ id: SESSION });
      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  const target: EngineTarget = { baseUrl: `http://127.0.0.1:${server.port}`, headers: [["authorization", "Basic ZW5naW5l"]], search: "", engine: "v1" };
  return { control, server, target };
}

/**
 * A clock that only moves when the observer waits: each wait passes at once,
 * adds its length to the time and runs whatever was scheduled up to then.
 */
function fakeClock() {
  const start = Date.parse("2026-09-23T07:34:00.000Z");
  let now = start;
  const scheduled: Array<{ at: number; run: () => void }> = [];
  const waits: number[] = [];
  const timing: Partial<ObserverTiming> = {
    now: () => now,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason;
      waits.push(ms);
      now += ms;
      for (const task of scheduled.filter((entry) => entry.at <= now)) {
        scheduled.splice(scheduled.indexOf(task), 1);
        task.run();
      }
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      if (signal.aborted) throw signal.reason;
    },
  };
  return {
    timing,
    waits,
    elapsed: () => now - start,
    /** Runs `run` once the clock reaches `offsetMs` past its start. */
    at: (offsetMs: number, run: () => void) => { scheduled.push({ at: start + offsetMs, run }); },
  };
}

type Entry =
  | { kind: "trace"; type: string; data?: unknown }
  | { kind: "snapshot"; trigger: string }
  | { kind: "flush"; final?: unknown };

/** Records what the observer hands the collector, in order. */
class FakeCollector implements ObservedCollector {
  readonly enabled = true;
  checkpoint: string | undefined;
  readonly entries: Entry[] = [];

  async sessionCheckpoint(): Promise<{ resumed: boolean; lastMessageId?: string }> {
    return { resumed: false, ...(this.checkpoint ? { lastMessageId: this.checkpoint } : {}) };
  }

  async setSessionCheckpoint(_sessionId: string, messageId: string): Promise<void> {
    this.checkpoint = messageId;
  }

  recordTrace(_sessionId: string, type: string, data?: unknown): void {
    this.entries.push({ kind: "trace", type, ...(data === undefined ? {} : { data }) });
  }

  recordSessionModel(): void {}

  async childCheckpoints(): Promise<Record<string, string>> {
    return {};
  }

  async childSessionIds(): Promise<string[]> {
    return [];
  }

  recordChildSession(_sessionId: string, _child: CollectorChildSession): void {}

  captureSnapshot(_sessionId: string, trigger: "prompt" | "turn_completed"): void {
    this.entries.push({ kind: "snapshot", trigger });
  }

  flushTrace(_sessionId: string, finalTrace?: unknown): void {
    this.entries.push({ kind: "flush", ...(finalTrace === undefined ? {} : { final: finalTrace }) });
  }

  /** The entries as short labels: trace types, `snapshot:<trigger>`, `flush` and `flush:turn` (with the turn's messages). */
  labels(): string[] {
    return this.entries.map((entry) => {
      if (entry.kind === "trace") return entry.type;
      if (entry.kind === "snapshot") return `snapshot:${entry.trigger}`;
      return entry.final === undefined ? "flush" : "flush:turn";
    });
  }

  trace(type: string): unknown[] {
    return this.entries.flatMap((entry) => (entry.kind === "trace" && entry.type === type ? [entry.data] : []));
  }

  /** The message ids each turn.completed flush carried. */
  turnMessageIds(): string[][] {
    return this.entries.flatMap((entry) => (entry.kind === "flush" && entry.final !== undefined
      ? [((entry.final as { messages: EngineMessage[] }).messages).map((each) => String(each.info.id))]
      : []));
  }
}

/** What the observer tells the project archive: the messages of each completed turn, and every call in order. */
function fakeArchive() {
  const turns: Array<unknown[] | null> = [];
  const calls: Array<"followed" | "completed" | "incomplete"> = [];
  return {
    turns,
    calls,
    turnFollowed: () => { calls.push("followed"); },
    turnCompleted: (_sessionId: string, messages: unknown) => {
      turns.push(messages as unknown[] | null);
      calls.push("completed");
    },
    turnIncomplete: () => { calls.push("incomplete"); },
  };
}

type ObservedArchive = Parameters<typeof observeCollectedSession>[0]["archive"];

function observe(input: { collector: ObservedCollector; archive: ObservedArchive; observers: SessionObservers; target: EngineTarget; timing: Partial<ObserverTiming> }) {
  return observeCollectedSession({ ...input, sessionId: SESSION });
}

/** A project archiver that records what the real lifecycle asks of it (bases and deltas numbered like the real one). */
class RecordingArchiver implements ProjectArchiver {
  readonly calls: string[] = [];
  private lastTurn = -1;

  async captureBase(sessionId: string, root: string, turn = 0): Promise<CaptureResult> {
    this.calls.push(`base ${sessionId} ${root} ${turn}`);
    this.lastTurn = turn;
    return { status: "queued", archiveId: "archive-base", kind: "base", sequence: 0, size: 1 };
  }

  async captureDelta(sessionId: string, root: string, turn: number | null): Promise<CaptureResult> {
    this.calls.push(`delta ${sessionId} ${root} ${turn}`);
    const next = turn ?? this.lastTurn + 1;
    if (next <= this.lastTurn) return { status: "skipped", reason: "stale_turn" };
    this.lastTurn = next;
    return { status: "queued", archiveId: `archive-delta-${next}`, kind: "delta", sequence: next, size: 1 };
  }

  async captureFinal(sessionId: string, reason: FinalReason): Promise<CaptureResult> {
    this.calls.push(`final ${sessionId} ${reason}`);
    return { status: "queued", archiveId: `archive-final-${this.calls.length}`, kind: "delta", sequence: this.calls.length, size: 1 };
  }

  async startFinalCandidates(): Promise<string[]> {
    return [];
  }

  async drain(): Promise<DrainResult> {
    return { uploaded: 0, pending: 0, dropped: 0, blocked: null, disabled: false };
  }

  async signOut(): Promise<void> {}

  async stop(): Promise<void> {}
}

/** The real project archive lifecycle on a recording archiver, a session of the fake engine started on a fresh folder. */
async function archivedSession(engine: ReturnType<typeof startEngine>, finalIdleMs: number) {
  const folder = await mkdtemp(join(tmpdir(), "omnirush-observer-archive-"));
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  const root = await realpath(folder);
  const archiver = new RecordingArchiver();
  const archive = new ProjectArchiveLifecycle({ archiver, enabled: true, log: () => undefined, finalIdleMs });
  cleanups.push(() => archive.stop({ finals: false }));
  archive.sessionStarted({ sessionId: SESSION, root, engine: projectArchiveEngineReads(engine.target, SESSION) });
  await archive.settled();
  return { root, archiver, archive };
}

describe("collector observer", () => {
  test("a turn busy for three hours, past the old one-hour cap, gets its messages, snapshot and archive delta, with status reads easing off", async () => {
    const clock = fakeClock();
    const engine = startEngine();
    const collector = new FakeCollector();
    const archive = fakeArchive();
    engine.control.messages = [message("msg_user_0001", "user", "Work on issue 42")];
    engine.control.status = () => (clock.elapsed() < 3 * HOUR ? "busy" : "idle");
    clock.at(3 * HOUR, () => engine.control.messages.push(message("msg_assistant_0001", "assistant", "Fixed issue 42")));

    await observe({ collector, archive, observers: createSessionObservers(), target: engine.target, timing: clock.timing });

    expect(collector.labels()).not.toContain("session.observer_timeout");
    expect(collector.labels()).not.toContain("session.observer_failed");
    expect(collector.labels()).toEqual(["session.idle", "snapshot:turn_completed", "flush:turn"]);
    expect(collector.turnMessageIds()).toEqual([["msg_user_0001", "msg_assistant_0001"]]);
    expect(collector.checkpoint).toBe("msg_assistant_0001");
    expect(archive.turns).toHaveLength(1);
    expect(archive.turns[0]).toHaveLength(2);
    // A settled turn, however long, is a completed one for the project archive.
    expect(archive.calls).toEqual(["followed", "completed"]);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(3 * HOUR);
    // A read a second for the first two minutes, then less often, at most every 10 s:
    // about 1,250 reads over three hours instead of 10,800.
    expect(clock.waits.slice(0, 120).every((ms) => ms === 1_000)).toBe(true);
    expect(Math.max(...clock.waits)).toBe(10_000);
    expect(engine.control.statusReads).toBeLessThan(1_300);
  });

  test("a status read that times out twice, then answers, does not end the observation", async () => {
    const clock = fakeClock();
    const engine = startEngine();
    const collector = new FakeCollector();
    const archive = fakeArchive();
    engine.control.messages = [message("msg_user_0001", "user"), message("msg_assistant_0001", "assistant")];
    engine.control.status = () => (clock.elapsed() < 5 * 60_000 ? "busy" : "idle");
    // The engine is busy with a large session: its first two status answers take longer than a status read waits.
    engine.control.statusDelaysMs = [400, 400];

    await observe({ collector, archive, observers: createSessionObservers(), target: engine.target, timing: { ...clock.timing, statusTimeoutMs: 50 } });

    expect(collector.labels()).toEqual(["session.idle", "snapshot:turn_completed", "flush:turn"]);
    expect(collector.turnMessageIds()).toEqual([["msg_user_0001", "msg_assistant_0001"]]);
    expect(archive.calls).toEqual(["followed", "completed"]);
    // The failed reads backed off (1 s, then 2 s) before the next one.
    expect(clock.waits.slice(0, 3)).toEqual([1_000, 1_000, 2_000]);
  });

  test("an engine restarting mid-turn is waited out and noted once past a minute; a request that finds the session followed points it at the new engine", async () => {
    const clock = fakeClock();
    const before = startEngine();
    const after = startEngine();
    const collector = new FakeCollector();
    const archive = fakeArchive();
    const observers = createSessionObservers();
    before.control.messages = [message("msg_user_0001", "user")];
    before.control.status = () => "busy";
    after.control.messages = [message("msg_user_0001", "user"), message("msg_assistant_0001", "assistant")];
    after.control.status = () => (clock.elapsed() < 40 * 60_000 ? "busy" : "idle");
    // Twenty minutes in, the engine goes away; five minutes later a request reaches the restarted one.
    clock.at(20 * 60_000, () => void before.server.stop(true));
    let rejoined: Promise<void> | null = null;
    clock.at(25 * 60_000, () => {
      rejoined = observe({ collector, archive, observers, target: after.target, timing: clock.timing });
    });

    const observation = observe({ collector, archive, observers, target: before.target, timing: clock.timing });
    await observation;

    expect(rejoined as Promise<void> | null).toBe(observation);
    expect(collector.labels()).toEqual([
      "session.engine_unavailable",
      "session.engine_recovered",
      "session.idle",
      "snapshot:turn_completed",
      "flush:turn",
    ]);
    const [unavailable] = collector.trace("session.engine_unavailable") as Array<{ error: string; failures: number }>;
    expect(unavailable?.failures).toBeGreaterThan(1);
    const [recovered] = collector.trace("session.engine_recovered") as Array<{ unavailable_ms: number }>;
    expect(recovered?.unavailable_ms).toBeGreaterThanOrEqual(4 * 60_000);
    expect(collector.turnMessageIds()).toEqual([["msg_user_0001", "msg_assistant_0001"]]);
    expect(archive.turns).toHaveLength(1);
    // Waiting out the engine is not an incomplete turn, and the request that rejoined followed no turn of its own.
    expect(archive.calls).toEqual(["followed", "completed"]);
    expect(observers.sessions.size).toBe(0);
  });

  test("a prompt sent while the turn settles is followed as a turn of its own", async () => {
    const clock = fakeClock();
    const engine = startEngine();
    const collector = new FakeCollector();
    const archive = fakeArchive();
    const observers = createSessionObservers();
    engine.control.messages = [message("msg_user_0001", "user"), message("msg_assistant_0001", "assistant")];
    let busyUntil = 2 * 60_000;
    engine.control.status = () => (clock.elapsed() < busyUntil ? "busy" : "idle");
    // The next prompt reaches the engine right as the settled turn's messages are read.
    engine.control.onMessagesRead = () => {
      engine.control.onMessagesRead = null;
      busyUntil = clock.elapsed() + 5 * 60_000;
      engine.control.messages.push(message("msg_user_0002", "user"), message("msg_assistant_0002", "assistant"));
      void observe({ collector, archive, observers, target: engine.target, timing: clock.timing });
    };

    await observe({ collector, archive, observers, target: engine.target, timing: clock.timing });

    expect(collector.labels()).toEqual([
      "session.idle", "snapshot:turn_completed", "flush:turn",
      "session.idle", "snapshot:turn_completed", "flush:turn",
    ]);
    expect(collector.turnMessageIds()).toEqual([
      ["msg_user_0001", "msg_assistant_0001"],
      ["msg_user_0002", "msg_assistant_0002"],
    ]);
    expect(archive.turns.map((turn) => turn?.length)).toEqual([2, 4]);
    // The second turn is announced before it is followed: the idle final archive the first one armed is off.
    expect(archive.calls).toEqual(["followed", "completed", "followed", "completed"]);
  });

  test("the server stopping mid-turn ends the observation quietly and leaves the checkpoint where it was", async () => {
    const clock = fakeClock();
    const engine = startEngine();
    const collector = new FakeCollector();
    collector.checkpoint = "msg_assistant_0000";
    const observers = createSessionObservers();
    engine.control.status = () => "busy";
    clock.at(2 * HOUR, () => observers.controller.abort());
    const archive = fakeArchive();
    await observe({ collector, archive, observers, target: engine.target, timing: clock.timing });
    expect(collector.entries).toEqual([]);
    expect(collector.checkpoint).toBe("msg_assistant_0000");
    // A quit is no incomplete turn: the project archive's stop() packs its final archives.
    expect(archive.calls).toEqual(["followed"]);
  });

  test("an unexpected error ends the observation with the turn's snapshot and trace, and the project archive hears once that the turn did not complete", async () => {
    const clock = fakeClock();
    const engine = startEngine();
    const archive = fakeArchive();
    const observers = createSessionObservers();
    // A collector that fails on the second turn's idle event, before that turn's snapshot.
    let idles = 0;
    const collector = new (class extends FakeCollector {
      override recordTrace(sessionId: string, type: string, data?: unknown): void {
        if (type === "session.idle" && ++idles === 2) throw new Error("the collector failed");
        super.recordTrace(sessionId, type, data);
      }
    })();
    engine.control.messages = [message("msg_user_0001", "user"), message("msg_assistant_0001", "assistant")];
    let busyUntil = 2 * 60_000;
    engine.control.status = () => (clock.elapsed() < busyUntil ? "busy" : "idle");
    engine.control.onMessagesRead = () => {
      engine.control.onMessagesRead = null;
      busyUntil = clock.elapsed() + 5 * 60_000;
      engine.control.messages.push(message("msg_user_0002", "user"), message("msg_assistant_0002", "assistant"));
      void observe({ collector, archive, observers, target: engine.target, timing: clock.timing });
    };

    await observe({ collector, archive, observers, target: engine.target, timing: clock.timing });

    expect(collector.labels()).toEqual([
      "session.idle", "snapshot:turn_completed", "flush:turn",
      "session.observer_failed", "snapshot:turn_completed", "flush",
    ]);
    // The first turn completed; the second, which failed, is incomplete, and neither is told twice.
    expect(archive.calls).toEqual(["followed", "completed", "followed", "incomplete"]);
    expect(observers.sessions.size).toBe(0);
  });
});

describe("collector observer with the project archive", () => {
  const user = (id: string) => message(`msg_user_${id}`, "user");
  const answer = (id: string) => message(`msg_assistant_${id}`, "assistant");

  test("a turn that runs past the old one-hour cap and then settles gets its delta, and the idle final archive once the session stays quiet", async () => {
    const clock = fakeClock();
    const engine = startEngine();
    engine.control.messages = [user("0001")];
    const { root, archiver, archive } = await archivedSession(engine, 100);
    expect(archiver.calls).toEqual([`base ${SESSION} ${root} 0`]);
    engine.control.status = () => (clock.elapsed() < 3 * HOUR ? "busy" : "idle");
    clock.at(3 * HOUR, () => engine.control.messages.push(answer("0001")));

    const collector = new FakeCollector();
    await observe({ collector, archive, observers: createSessionObservers(), target: engine.target, timing: clock.timing });
    await archive.settled();

    expect(clock.elapsed()).toBeGreaterThanOrEqual(3 * HOUR);
    expect(collector.labels()).toEqual(["session.idle", "snapshot:turn_completed", "flush:turn"]);
    expect(archiver.calls).toEqual([`base ${SESSION} ${root} 0`, `delta ${SESSION} ${root} 1`]);
    // No prompt follows: the quiet window after the turn ends in a final archive of the folder.
    await Bun.sleep(250);
    await archive.settled();
    expect(archiver.calls).toEqual([`base ${SESSION} ${root} 0`, `delta ${SESSION} ${root} 1`, `final ${SESSION} idle`]);
  });

  test("a turn still busy at the 24-hour safety bound gets its delta when the engine's count moved, then the idle final archive", async () => {
    const clock = fakeClock();
    const engine = startEngine();
    engine.control.messages = [user("0001")];
    const { root, archiver, archive } = await archivedSession(engine, 100);
    // The answer ends five hours in, but the engine never reports the session idle again.
    engine.control.status = () => "busy";
    clock.at(5 * HOUR, () => engine.control.messages.push(answer("0001")));

    const collector = new FakeCollector();
    await observe({ collector, archive, observers: createSessionObservers(), target: engine.target, timing: clock.timing });
    await archive.settled();

    expect(clock.elapsed()).toBeGreaterThanOrEqual(24 * HOUR);
    expect(collector.labels()).toEqual(["session.observer_timeout", "snapshot:turn_completed", "flush"]);
    // turnIncomplete read the engine's count again: it moved, so the turn gets its delta.
    expect(archiver.calls).toEqual([`base ${SESSION} ${root} 0`, `delta ${SESSION} ${root} 1`]);
    await Bun.sleep(250);
    await archive.settled();
    expect(archiver.calls).toEqual([`base ${SESSION} ${root} 0`, `delta ${SESSION} ${root} 1`, `final ${SESSION} idle`]);
  }, 60_000);

  test("a prompt sent while a turn settles keeps the idle final archive off while its own turn runs", async () => {
    const clock = fakeClock();
    const engine = startEngine();
    engine.control.messages = [user("0001")];
    const { root, archiver, archive } = await archivedSession(engine, 100);
    const collector = new FakeCollector();
    const observers = createSessionObservers();
    let busyUntil = 2 * 60_000;
    engine.control.status = () => (clock.elapsed() < busyUntil ? "busy" : "idle");
    clock.at(busyUntil, () => engine.control.messages.push(answer("0001")));
    // The next prompt reaches the server while turn 1's messages are read: its session start
    // reaches the archive before turn 1's end does.
    engine.control.onMessagesRead = () => {
      engine.control.onMessagesRead = null;
      busyUntil = clock.elapsed() + 30 * 60_000;
      engine.control.messages.push(user("0002"));
      clock.at(busyUntil, () => engine.control.messages.push(answer("0002")));
      archive.sessionStarted({ sessionId: SESSION, root, engine: projectArchiveEngineReads(engine.target, SESSION) });
      void observe({ collector, archive, observers, target: engine.target, timing: clock.timing });
      // Turn 2's first status answer takes longer than the quiet window.
      engine.control.statusDelaysMs = [300];
    };

    await observe({ collector, archive, observers, target: engine.target, timing: clock.timing });
    await archive.settled();

    expect(collector.turnMessageIds()).toEqual([["msg_user_0001", "msg_assistant_0001"], ["msg_user_0002", "msg_assistant_0002"]]);
    // No idle final archive while turn 2 ran, only after it.
    expect(archiver.calls).toEqual([`base ${SESSION} ${root} 0`, `delta ${SESSION} ${root} 1`, `delta ${SESSION} ${root} 2`]);
    await Bun.sleep(250);
    await archive.settled();
    expect(archiver.calls).toEqual([
      `base ${SESSION} ${root} 0`,
      `delta ${SESSION} ${root} 1`,
      `delta ${SESSION} ${root} 2`,
      `final ${SESSION} idle`,
    ]);
  });
});

describe("collector observer with the collector", () => {
  type Envelope = {
    snapshot_type: string;
    files: Array<{ path: string; content: string }>;
    trace?: Array<{ type: string; data?: Record<string, unknown> }>;
  };

  test("a turn left unsettled past the safety bound leaves its messages to the next settled turn, which sends them over several traces and counts what exceeds the backlog", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-observer-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "app.txt"), "hello\n");
    const uploads: Envelope[] = [];
    const collector = new WorkspaceCollector({
      upload: async (_sessionId, compressed) => {
        uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Envelope);
        return Response.json({ ok: true }, { status: 201 });
      },
      changeDebounceMs: 60_000,
      fallbackScanMs: 60_000,
    });
    cleanups.push(() => collector.stop());
    collector.startSession(SESSION, "workspace-observer", root);
    const engine = startEngine();
    const archive = fakeArchive();
    const observers = createSessionObservers();
    const traces = () => uploads.filter((upload) => upload.snapshot_type === "trace");
    const events = (envelope: Envelope | undefined) => envelope?.trace ?? [];
    const document = (envelope: Envelope) => JSON.parse(envelope.files[0]!.content) as { trace_truncated: boolean; dropped_event_count: number };
    const ids = (list: unknown) => (list as EngineMessage[]).map((each) => String(each.info.id));
    let clock = fakeClock();
    /** One observation on a fresh clock, with the engine busy for `busyMs` (Infinity: throughout). */
    const turn = async (busyMs: number, maxTurnMs?: number) => {
      clock = fakeClock();
      const current = clock;
      engine.control.status = () => (current.elapsed() < busyMs ? "busy" : "idle");
      await observe({ collector, archive, observers, target: engine.target, timing: { ...current.timing, ...(maxTurnMs ? { maxTurnMs } : {}) } });
      await collector.idle(SESSION);
    };

    // Turn 1 settles normally: the checkpoint is its answer.
    engine.control.messages = [message("msg_user_0001", "user"), message("msg_assistant_0001", "assistant")];
    await turn(60_000);
    expect((await collector.sessionCheckpoint(SESSION)).lastMessageId).toBe("msg_assistant_0001");

    // Turn 2 is still running when the observer's safety bound (two hours here) runs out.
    engine.control.messages.push(message("msg_user_0002", "user", "Continue"));
    for (let index = 1; index <= 8; index += 1) engine.control.messages.push(longAnswer(`msg_long_${String(index).padStart(4, "0")}`, 3));
    await turn(Infinity, 2 * HOUR);
    const timedOut = traces().at(-1)!;
    expect(events(timedOut).map((event) => event.type)).toContain("session.observer_timeout");
    expect(events(timedOut).map((event) => event.type)).not.toContain("turn.completed");
    expect(events(timedOut).filter((event) => event.type === "collector.trigger").map((event) => event.data?.trigger)).toEqual(["turn_completed"]);
    expect(archive.turns).toHaveLength(1);
    // The project archive hears the turn ended without completing (its delta, or a final archive).
    expect(archive.calls).toEqual(["followed", "completed", "followed", "incomplete"]);
    // Its messages were not sent, so the checkpoint did not move.
    expect((await collector.sessionCheckpoint(SESSION)).lastMessageId).toBe("msg_assistant_0001");

    // Turn 3 ("continue") settles: 24 MiB of turn 2 plus its own messages go out in four traces of at most 8 MiB of messages.
    const sent = traces().length;
    engine.control.messages.push(message("msg_user_0003", "user", "continue"), message("msg_assistant_0003", "assistant"));
    await turn(3 * 60_000);
    const backlog = traces().slice(sent);
    expect(backlog).toHaveLength(4);
    const parts = backlog.slice(0, 3).map((envelope) => events(envelope).find((event) => event.type === "turn.messages")?.data);
    expect(parts.map((part) => [part?.part, part?.parts])).toEqual([[1, 4], [2, 4], [3, 4]]);
    const completed = events(backlog[3]).find((event) => event.type === "turn.completed")?.data;
    expect([...parts.flatMap((part) => ids(part?.messages)), ...ids(completed?.messages)]).toEqual([
      "msg_user_0002",
      ...Array.from({ length: 8 }, (_, index) => `msg_long_${String(index + 1).padStart(4, "0")}`),
      "msg_user_0003",
      "msg_assistant_0003",
    ]);
    for (const envelope of backlog) {
      expect(document(envelope)).toMatchObject({ trace_truncated: false, dropped_event_count: 0 });
      expect(events(envelope).map((event) => event.type)).not.toContain("session.messages_omitted");
    }
    expect((await collector.sessionCheckpoint(SESSION)).lastMessageId).toBe("msg_assistant_0003");
    // The archive delta counts every completed turn the engine holds.
    expect(archive.turns.at(-1)).toHaveLength(13);

    // A backlog past 32 MiB keeps the newest messages and counts the rest, as a single turn did before.
    const beforeOmission = traces().length;
    engine.control.messages.push(message("msg_user_0004", "user"));
    for (let index = 1; index <= 12; index += 1) engine.control.messages.push(longAnswer(`msg_huge_${String(index).padStart(4, "0")}`, 3));
    await turn(60_000);
    const omitted = traces().slice(beforeOmission);
    expect(omitted.flatMap((envelope) => events(envelope)).filter((event) => event.type === "session.messages_omitted").map((event) => event.data))
      .toEqual([{ count: 3 }]);
    const kept = omitted.flatMap((envelope) => events(envelope))
      .filter((event) => event.type === "turn.messages" || event.type === "turn.completed")
      .flatMap((event) => ids(event.data?.messages));
    expect(kept).toEqual(Array.from({ length: 10 }, (_, index) => `msg_huge_${String(index + 3).padStart(4, "0")}`));
    for (const envelope of omitted) expect(document(envelope)).toMatchObject({ trace_truncated: false, dropped_event_count: 0 });
  }, 60_000);
});
