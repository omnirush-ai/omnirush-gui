/**
 * The desktop's Linux sandbox ("box", ported from the CLI: see launch.ts):
 * one per server, for every local workspace whose box is on. It keeps
 *
 * - the per-workspace choice in the workspace's OmniRush settings
 *   (`localBox: { mode: "on" | "off", offered }`; no mode: the server's
 *   default from /collect/capabilities -> local_box.default);
 * - the engine bits (the shell, named bash, and the box plugin) that go
 *   into the one engine config when any workspace may use a box;
 * - <box home>/desktop-projects.json, the projects the plugin routes to
 *   their box (everything else runs natively through the same shell);
 * - each project's run: the per-turn checkpoints and the label its chats'
 *   uploads carry;
 * - the machine's backend setting (`auto`, one backend id, or `native`) in
 *   <state>/box.json, and the server's allowlist of backends
 *   (local_box.backends, remembered in <state>/box-server.json).
 *
 * Nothing here blocks opening a project: probes are bounded, a missing image
 * downloads in the background, a box that cannot start leaves its project
 * on this machine.
 *
 * Not to be confused with the OpenWork worker sandbox (`sandboxBackend`).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { boxHome, boxKey, boxSnapshotsDir, containerName, installShell, listBoxes, readRecord, resetBox, savedTurns, type BoxLabel, type BoxLog } from "./box.js";
import { LABELS, OPT_IN, backendsFor, driverFor } from "./backends/index.js";
import type { BoxExec } from "./backends/types.js";
import { detectStack, imageFor } from "./images.js";
import { askedBackend, boxRun, planBox, pulling, pullInBackground, resolveMode, saveBackend, serverBackends, serverDefault, shimsDir, type BoxRun, type ProjectBoxMode, type ServerBoxDefault } from "./launch.js";
import type { BoxInstallLogPaths } from "./install-log.js";
import { DESKTOP_PROJECTS_FILE } from "./plugin-lib.js";
import { detectRuntime, type BackendAlternative, type DetectOptions, type RuntimeResult } from "./runtime.js";

/** What the capture side needs of a chat's box (plain data: it crosses to the capture worker). */
export type BoxCaptureInfo = {
  key: string;
  root: string;
  croot: string;
  container: string;
  runtimeBin: string;
  /** Arguments before the runtime's own (`-e docker` for a WSL engine). */
  runtimeArgs: string[];
  /** The backend id (backends/index.ts). */
  backend: string;
  /** How files-used reads the box when it is not `docker exec` (bubblewrap, Apple container, the WSL distro). */
  exec: BoxExec | null;
  /** environment.sandbox of the chat's uploads. */
  label: BoxLabel;
};

export type BoxWorkspace = { id: string; path: string; directory?: string; workspaceType: string };

export type BoxStatus = {
  /** The project's own choice (null: the server's default). */
  mode: ProjectBoxMode;
  serverDefault: ServerBoxDefault;
  /** Whether the project's chats should run in its box. */
  on: boolean;
  source: "env" | "project" | "server" | "default";
  /** The server offers the box and this project was not offered it yet. */
  offer: boolean;
  state: "off" | "unavailable" | "downloading" | "starting" | "ready" | "failed";
  runtime: { ok: boolean; name: string | null; flavor: string | null; version: string | null; reason: string | null } | null;
  /** What runs the box on this machine: the chosen backend, why, and the others (each with why not). */
  backend: BoxBackendView | null;
  /** The machine's backend setting and the values it takes here. */
  backendSetting: { value: string; source: "env" | "setting" | "auto"; choices: Array<{ id: string; label: string }> };
  image: { ref: string; stack: string; present: boolean | null; downloading: boolean } | null;
  container: { name: string; exists: boolean; running: boolean } | null;
  /** One line for the user (why it is off, that it is downloading). */
  notice: string | null;
  error: string | null;
};

export type BoxBackendView = {
  /** The chosen backend's id (null when none works here). */
  id: string | null;
  label: string | null;
  version: string | null;
  flavor: string | null;
  /** Why this one (the ranked order, the setting, the server's allowlist), or why none. */
  why: string | null;
  /** Every backend tried here: id, whether it works, one line why not. Empty until the first full check. */
  alternatives: Array<{ id: string; label: string; ok: boolean; reason: string | null }>;
  /** The server limits the backends (local_box.backends). */
  allowed: string[] | null;
};

/** The backend choices of a platform: auto, the ranked ids there, the opt-in ones, native. */
export function backendChoices(platform: NodeJS.Platform = process.platform): Array<{ id: string; label: string }> {
  const optIn = (OPT_IN[platform] ?? []).map((id) => ({ id, label: `${LABELS[id] ?? id} (opt-in)` }));
  return [{ id: "auto", label: "Automatic" }, ...backendsFor(platform).map((id) => ({ id, label: LABELS[id] ?? id })), ...optIn, { id: "native", label: "Off (this computer)" }];
}

export type BoxServiceOptions = {
  /** The capture state dir: the server default is remembered here, snapshots go under sandbox/snapshots. */
  stateDir: string;
  readSettings: (workspaceId: string) => Promise<{ mode: ProjectBoxMode; offered: boolean }>;
  writeSettings: (workspaceId: string, update: { mode?: ProjectBoxMode; offered?: boolean }) => Promise<void>;
  workspaces: () => BoxWorkspace[];
  /** The engine plugin file (opencode-plugins/omnirush-box). */
  pluginPath: () => string;
  log?: BoxLog;
  env?: NodeJS.ProcessEnv;
};

type Project = { run: BoxRun | null; notice: string | null; planning: Promise<BoxRun | null> | null; nextPlanAt: number };

/** A project whose image is downloading is planned again at most this often. */
const REPLAN_MS = 15_000;
/** A prompt waits at most this long for its turn's checkpoint. */
const FREEZE_WAIT_MS = 90_000;
/** The full backend check (every backend, for the status card's "others") is reused this long. */
const ALTERNATIVES_MS = 60_000;

export function boxRoot(workspace: BoxWorkspace): string {
  return workspace.directory?.trim() || workspace.path;
}

export class BoxService {
  private readonly projects = new Map<string, Project>();
  private readonly turns = new Map<string, number>();
  /** Each chat's turn number as of its last prompt here (its turns before this run, then one per prompt). */
  private readonly chatTurns = new Map<string, number>();
  /** Chats (and their project's key) that ran on this machine before the server's default turned the box on: they stay here. */
  private readonly nativeChats = new Map<string, string>();
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private log: BoxLog;
  private projectsWrite: Promise<void> = Promise.resolve();
  private installLog: BoxInstallLogPaths | null = null;
  private alternatives: { at: number; key: string; list: BackendAlternative[] } | null = null;

  constructor(private readonly options: BoxServiceOptions) {
    this.env = options.env ?? process.env;
    this.home = boxHome(this.env);
    this.log = options.log ?? (() => {});
  }

  /**
   * The install log of box chats (install-log.ts): new boxes mount its
   * folder and put its wrappers on PATH; the plugin points their calls at its
   * raw folder. Set at server start, before any box is planned.
   */
  useInstallLog(paths: BoxInstallLogPaths | null): void {
    this.installLog = paths;
  }

  /** Logs go here from now on (the server's logger, once it exists). */
  useLog(log: BoxLog): void {
    this.log = log;
  }

  get snapshotsDir(): string {
    return boxSnapshotsDir(this.options.stateDir);
  }

  serverDefault(): ServerBoxDefault {
    return serverDefault(this.options.stateDir);
  }

  /** The backend detection's inputs: the setting (or OMNIRUSH_BOX_BACKEND) and the server's allowlist. */
  private detectOptions(): Pick<DetectOptions, "asked" | "allow"> {
    return { asked: askedBackend({ env: this.env, stateDir: this.options.stateDir }).backend, allow: serverBackends(this.options.stateDir) };
  }

  private detect(extra: DetectOptions = {}): Promise<RuntimeResult> {
    return detectRuntime({ boxHome: this.home, env: this.env, ...this.detectOptions(), ...extra });
  }

  /**
   * Save the machine's backend ("auto", one backend id, "native"). Projects
   * are planned again with it (a running box keeps going until its project
   * is planned again). Throws for an unknown value.
   */
  async setBackend(value: unknown): Promise<string> {
    const saved = saveBackend(this.options.stateDir, value);
    this.alternatives = null;
    const now = await this.detect({ fresh: true });
    const chosen = now.ok ? now.backend ?? now.name : null;
    for (const project of this.projects.values()) {
      if (project.run && project.run.backend === chosen) continue;
      project.run = null;
      project.notice = null;
      project.nextPlanAt = 0;
    }
    await this.writeProjects();
    void this.ensureAll();
    return saved;
  }

  private async mode(workspace: BoxWorkspace) {
    const settings = await this.options.readSettings(workspace.id).catch(() => ({ mode: null, offered: false }));
    const server = this.serverDefault();
    return { settings, server, ...resolveMode({ env: this.env, project: settings.mode, server, offered: settings.offered }) };
  }

  /**
   * The engine config additions (`shell` and the plugin), or null: only when
   * some local workspace has its box on or the server's default is on or
   * offer, and the helpers for this machine are installed.
   */
  async engineBits(): Promise<{ shell: string; plugin: string } | null> {
    let wanted = this.serverDefault() !== "off" || ["1", "on", "true"].includes(String(this.env.OMNIRUSH_BOX ?? "").trim().toLowerCase());
    for (const workspace of this.options.workspaces()) {
      if (wanted) break;
      if (workspace.workspaceType !== "local") continue;
      wanted = (await this.mode(workspace)).on;
    }
    if (!wanted) return null;
    try {
      return { shell: installShell(this.home, { env: this.env }), plugin: this.options.pluginPath() };
    } catch (error) {
      this.log("info", "box engine bits unavailable", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /**
   * The project's run when its box is on and can start (planned once, in
   * the background; a downloading image is looked at again later), else null.
   */
  ensure(workspace: BoxWorkspace): Promise<BoxRun | null> {
    if (workspace.workspaceType !== "local") return Promise.resolve(null);
    const root = boxRoot(workspace);
    const key = boxKey(root);
    const project = this.projects.get(key) ?? { run: null, notice: null, planning: null, nextPlanAt: 0 };
    this.projects.set(key, project);
    if (project.planning) return project.planning;
    project.planning = (async () => {
      const { on } = await this.mode(workspace);
      if (!on) {
        project.run = null;
        project.notice = null;
        await this.writeProjects();
        return null;
      }
      if (project.run && !project.run.native) return project.run;
      if (Date.now() < project.nextPlanAt) return null;
      const plan = await planBox({ env: this.env, home: this.home, root, log: this.log, shims: shimsDir(this.env), ...this.detectOptions() });
      if (!plan.box) {
        project.run = null;
        project.notice = plan.notice;
        project.nextPlanAt = Date.now() + REPLAN_MS;
        await this.writeProjects();
        return null;
      }
      project.notice = null;
      project.run = boxRun(plan, {
        log: this.log,
        pkglog: this.installLog ? { root: this.installLog.root, bin: this.installLog.bin, py: this.installLog.py } : null,
        tmpRoot: join(this.home, "pending"),
        onNative: (reason) => {
          project.notice = `Sandbox off for now: ${reason}.`;
          project.nextPlanAt = Date.now() + REPLAN_MS;
          void this.writeProjects();
        },
      });
      await this.writeProjects();
      return project.run;
    })().finally(() => {
      project.planning = null;
    });
    return project.planning;
  }

  /** Plans every local workspace whose box is on (server start, a changed default); never throws. */
  async ensureAll(): Promise<void> {
    await Promise.allSettled(this.options.workspaces().map((workspace) => this.ensure(workspace)));
  }

  /** The projects the plugin routes to their box: on, planned, not gone native. */
  private writeProjects(): Promise<void> {
    const keys = [...this.projects.entries()].filter(([, project]) => project.run && !project.run.native).map(([key]) => key).sort();
    const file = join(this.home, DESKTOP_PROJECTS_FILE);
    const write = async () => {
      const content = `${JSON.stringify({ keys, ...(this.installLog ? { pkglog_dir: this.installLog.raw } : {}), ...(this.nativeChats.size ? { native_chats: [...this.nativeChats.keys()].sort() } : {}), updated: Date.now() })}\n`;
      await mkdir(this.home, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, content, { mode: 0o600 });
      await rename(tmp, file);
    };
    this.projectsWrite = this.projectsWrite.then(write, write).catch((error) => {
      this.log("warn", "box projects file not written", { error: error instanceof Error ? error.message : String(error) });
    });
    return this.projectsWrite;
  }

  /** The keys the plugin reads now (tests). */
  async listedProjects(): Promise<string[]> {
    await this.projectsWrite;
    try {
      const value = JSON.parse(await readFile(join(this.home, DESKTOP_PROJECTS_FILE), "utf8"));
      return Array.isArray(value?.keys) ? value.keys : [];
    } catch {
      return [];
    }
  }

  async setMode(workspace: BoxWorkspace, mode: ProjectBoxMode): Promise<BoxStatus> {
    await this.options.writeSettings(workspace.id, { mode, offered: true });
    const key = boxKey(boxRoot(workspace));
    // Turned on by the user: the project's chats that stayed on this machine move to the box too.
    if (mode === "on" && [...this.nativeChats.values()].includes(key)) {
      for (const [sessionId, chatKey] of this.nativeChats) if (chatKey === key) this.nativeChats.delete(sessionId);
      await this.writeProjects();
    }
    const project = this.projects.get(key);
    if (project) project.nextPlanAt = 0;
    // Planned in the background: a missing image starts downloading now.
    void this.ensure(workspace).catch(() => null);
    return this.status(workspace);
  }

  async status(workspace: BoxWorkspace, { fresh = false }: { fresh?: boolean } = {}): Promise<BoxStatus> {
    const { settings, server, on, source, offer } = await this.mode(workspace);
    // The server's "offer": shown once per folder (CLI: the tip, once per folder).
    if (offer && workspace.workspaceType === "local") await this.options.writeSettings(workspace.id, { offered: true }).catch(() => undefined);
    const root = boxRoot(workspace);
    const key = boxKey(root);
    const project = this.projects.get(key);
    const base = { mode: settings.mode, serverDefault: server, on, source, offer, error: null };
    const backendSetting = { ...askedBackend({ env: this.env, stateDir: this.options.stateDir }), choices: backendChoices() };
    const setting = { value: backendSetting.backend, source: backendSetting.source, choices: backendSetting.choices };
    if (workspace.workspaceType !== "local") return { ...base, on: false, offer: false, state: "off", runtime: null, backend: null, backendSetting: setting, image: null, container: null, notice: "The sandbox is for folders on this computer." };
    // The full check (every backend) on a fresh look or once a minute; the cached choice otherwise.
    const { asked, allow } = this.detectOptions();
    const altKey = JSON.stringify([asked, allow]);
    const full = fresh || !this.alternatives || this.alternatives.key !== altKey || Date.now() - this.alternatives.at > ALTERNATIVES_MS;
    const timeout = full ? 10_000 : 4_000;
    const runtime = await Promise.race([
      this.detect(full ? { all: true } : {}),
      new Promise<RuntimeResult>((resolve) => setTimeout(() => resolve({ ok: false, reason: "the sandbox backend did not answer in time" }), timeout)),
    ]);
    if (full && runtime.alternatives) this.alternatives = { at: Date.now(), key: altKey, list: runtime.alternatives };
    const alternatives = (runtime.alternatives ?? this.alternatives?.list ?? []).map((alt) => ({ id: alt.backend, label: LABELS[alt.backend] ?? alt.backend, ok: alt.ok, reason: alt.reason ? alt.reason.split("\n")[0]!.slice(0, 300) : null }));
    const runtimeView = runtime.ok
      ? { ok: true, name: runtime.name, flavor: runtime.flavor, version: runtime.version, reason: null }
      : { ok: false, name: null, flavor: null, version: null, reason: runtime.reason };
    const backendId = runtime.ok ? runtime.backend ?? runtime.name : null;
    const backend: BoxBackendView = {
      id: backendId,
      label: backendId ? LABELS[backendId] ?? backendId : null,
      version: runtime.ok ? runtime.version || null : null,
      flavor: runtime.ok ? runtime.flavor || null : null,
      why: runtime.ok ? runtime.why ?? null : runtime.reason,
      alternatives,
      allowed: allow ?? null,
    };
    const image = imageFor(detectStack(root), { env: this.env });
    const name = containerName(key, this.env);
    let present: boolean | null = null;
    let container: BoxStatus["container"] = null;
    if (runtime.ok) {
      present = Boolean(await driverFor(runtime).imagePresent(runtime, image, { home: this.home, env: this.env }).catch(() => null));
      const mine = (await listBoxes(runtime, { env: this.env, home: this.home }).catch(() => [])).find((box) => box.key === key);
      container = { name, exists: Boolean(mine), running: Boolean(mine?.running) };
    }
    const downloading = runtime.ok && pulling(this.home, runtime, image.pull);
    const record = readRecord(this.home, key);
    const run = project?.run ?? null;
    const state: BoxStatus["state"] = !on ? "off"
      : !runtime.ok ? "unavailable"
      : run && !run.native ? (run.box?.ready ? "ready" : run.box?.state === "failed" ? "failed" : "starting")
      : downloading || (!present && !container?.exists) ? "downloading"
      : project?.notice ? "unavailable" : "starting";
    return {
      ...base,
      state,
      runtime: runtimeView,
      backend,
      backendSetting: setting,
      image: { ref: image.pull, stack: image.stack, present, downloading },
      container,
      notice: on ? project?.notice ?? (runtime.ok ? null : `Sandbox off for now: ${runtime.reason}.`) : null,
      error: run?.box?.error ?? (record?.state === "off" || record?.state === "failed" ? record.error || null : null),
    };
  }

  /** Remove the project's container (installs gone); the next chat starts a fresh one. */
  async reset(workspace: BoxWorkspace): Promise<{ removed: boolean }> {
    const root = boxRoot(workspace);
    const key = boxKey(root);
    const runtime = await this.detect();
    const project = this.projects.get(key);
    if (project) {
      project.run = null;
      project.nextPlanAt = 0;
    }
    await this.writeProjects();
    if (!runtime.ok) return { removed: false };
    const result = await resetBox(runtime, root, { env: this.env, home: this.home });
    void this.ensure(workspace).catch(() => null);
    return { removed: result.removed };
  }

  /** Download the project's image now (the toggle turned on with no image here). */
  async pull(workspace: BoxWorkspace): Promise<boolean> {
    const runtime = await this.detect();
    if (!runtime.ok) return false;
    const image = imageFor(detectStack(boxRoot(workspace)), { env: this.env });
    if (await driverFor(runtime).imagePresent(runtime, image, { home: this.home, env: this.env })) return false;
    pullInBackground(runtime, image, this.home, { env: this.env, log: this.log });
    return true;
  }

  private snapshotDir(sessionId: string): string {
    return join(this.snapshotsDir, sessionId);
  }

  /**
   * A prompt of `sessionId` is about to reach the engine: the turn's
   * checkpoint (what the box changed since the chat's previous one) is
   * taken and saved where the project archive reads it, and the chat's box
   * label returned for its uploads. Null when the chat runs natively. Never
   * throws; waits at most FREEZE_WAIT_MS.
   */
  async beforePrompt(sessionId: string, workspace: BoxWorkspace, { capture = true, turnsBefore = 0 }: { capture?: boolean; turnsBefore?: number } = {}): Promise<BoxCaptureInfo | null> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(sessionId)) return null;
    // The chat's own turn number, counted with the box on or off: a chat that ran natively
    // (reopened, or its box turned on mid-chat) has its first checkpoint (turn-1) before a later
    // turn; the checkpoint names it as session_turn (CLI: the same).
    const reopened = capture && !this.chatTurns.has(sessionId) && turnsBefore > 0;
    const chatTurn = capture ? (this.chatTurns.get(sessionId) ?? turnsBefore) + 1 : 0;
    if (capture) this.chatTurns.set(sessionId, chatTurn);
    const run = await this.ensure(workspace).catch(() => null);
    if (!run || run.native) return null;
    // A reopened chat with turns but no checkpoint ran on this machine: when only the server's default
    // turned the box on, it goes on here (new chats get the box); a project turned on by its user moves it.
    if (reopened && !this.turns.has(sessionId) && savedTurns(this.snapshotDir(sessionId)) === 0 && (await this.mode(workspace)).source === "server") {
      this.nativeChats.set(sessionId, run.key);
      await this.writeProjects();
      this.log("info", "box: a chat that ran on this machine stays there", { sessionId, turnsBefore });
    }
    if (this.nativeChats.has(sessionId) || !capture) return null;
    const turn = (this.turns.get(sessionId) ?? savedTurns(this.snapshotDir(sessionId))) + 1;
    const started = Date.now();
    try {
      const frozen = await Promise.race([
        run.freeze(`turn-${turn}`, { sessionId, turn, sessionTurn: chatTurn, chain: this.snapshotDir(sessionId) }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), FREEZE_WAIT_MS)),
      ]);
      if (frozen) {
        const saved = await frozen.save(this.snapshotDir(sessionId));
        this.turns.set(sessionId, turn);
        run.setTurn(turn);
        this.log("info", "box checkpoint saved", { sessionId, turn, sessionTurn: chatTurn, changed: saved.changed, bytes: saved.bytes, ms: Date.now() - started });
      }
    } catch (error) {
      this.log("warn", "box checkpoint failed", { sessionId, turn, error: error instanceof Error ? error.message : String(error) });
    }
    const label = run.label(sessionId);
    const box = run.box;
    if (!label || !box) return null;
    return { key: run.key, root: run.root, croot: box.croot, container: box.container, runtimeBin: run.runtimeBin, runtimeArgs: run.runtimeArgs, backend: run.backend, exec: run.exec, label };
  }

  /** Whether chats ran in a box during this run (they get a `final` checkpoint at quit). */
  hasChats(): boolean {
    return this.turns.size > 0;
  }

  /** At quit: every chat with checkpoints gets its `final` leaf (bounded); the sessions that got one. */
  async finals({ budgetMs = 20_000 }: { budgetMs?: number } = {}): Promise<string[]> {
    const done: string[] = [];
    const work = (async () => {
      for (const sessionId of this.turns.keys()) {
        const run = [...this.projects.values()].map((project) => project.run).find((candidate) => candidate?.label(sessionId));
        if (!run) continue;
        try {
          const frozen = await run.freeze("final", { sessionId, chain: this.snapshotDir(sessionId) });
          if (frozen) {
            await frozen.save(this.snapshotDir(sessionId));
            done.push(sessionId);
          }
        } catch (error) {
          this.log("warn", "box final checkpoint failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    })();
    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, budgetMs).unref?.())]);
    return done;
  }
}
