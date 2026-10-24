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
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { boxHome, boxKey, boxSnapshotsDir, containerName, installShell, listBoxes, mountReplaced, readRecord, resetBox, savedTurns, type BoxLabel, type BoxLog } from "./box.js";
import { LABELS, OPT_IN, REQUIRED_FIRST, backendsFor, driverFor } from "./backends/index.js";
import { limaHome } from "./backends/lima.js";
import type { BoxExec } from "./backends/types.js";
import type { BoxEndpoint } from "./client.js";
import { hostBuilds, hostBuildsNotice, hostBuildThings, hostRules } from "./host-builds.js";
import { detectStack, imageFor, type BoxImage } from "./images.js";
import { portLine } from "./ports.js";
import { writeFileAtomic } from "../atomic-write.js";
import { askedBackend, boxRun, planBox, pullActivityAt, pullLog, pullMarker, pulling, pullInBackground, setupWait, resolveMode, saveBackend, serverBackends, serverDefault, serverLocalBox, serverRequired, shimsDir, type BoxRun, type ProjectBoxMode, type ServerBoxDefault } from "./launch.js";
import { desktopText, hostOnlyProject, requiredLaunch, shadowsApply, shadowsNotice, type RequiredFallback } from "./required.js";
import { cachedWindowsChecks, classifySetup, linuxAllow, resumeWinSetup, saveSetupState, setupState, windowsInstall, windowsRestart, windowsUpdate, type BoxSetup } from "./setup.js";
import type { BoxInstallLogPaths } from "./install-log.js";
import { DESKTOP_PROJECTS_FILE } from "./plugin-lib.js";
import { BUILDATHON_OFFER_NOTICE, buildathonBoxFor, buildathonProjectsFile, LESS_REPRO_NOTICE } from "../buildathon-repro.js";
import { layerSizes, pullProgress, type PullProgress } from "./pull-progress.js";
import { detectRuntime, type BackendAlternative, type DetectOptions, type RuntimeInfo, type RuntimeResult } from "./runtime.js";

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
  /** The server's start for a new chat on each model (local_box.model_start); null from an older server. */
  modelStart: Record<string, { start: "native" | "box"; switchable: boolean }> | null;
  /** The local_box policy revision new chats pin. */
  revision: string | null;
  /** This chat's pin (asked for one chat): where it runs and the revision it started under; null before its first prompt. */
  chatPin: { box: boolean; revision: string | null } | null;
  /** The project's own choice (null: the server's default). */
  mode: ProjectBoxMode;
  serverDefault: ServerBoxDefault;
  /** Whether the project's chats should run in its box. */
  on: boolean;
  /**
   * "host-builds": the server's default would put it in the box, but its folder has this computer's builds (macOS, Windows).
   * "required": the server requires the sandbox for new chats. "host-only": required, but the project only builds on this OS.
   */
  source: "env" | "project" | "server" | "default" | "host-builds" | "buildathon" | "required" | "host-only";
  /** The server offers the box and this project was not offered it yet. */
  offer: boolean;
  state: "off" | "unavailable" | "downloading" | "starting" | "ready" | "failed";
  runtime: { ok: boolean; name: string | null; flavor: string | null; version: string | null; reason: string | null } | null;
  /** What runs the box on this machine: the chosen backend, why, and the others (each with why not). */
  backend: BoxBackendView | null;
  /** The machine's backend setting and the values it takes here. */
  backendSetting: { value: string; source: "env" | "setting" | "auto"; choices: Array<{ id: string; label: string }> };
  image: { ref: string; stack: string; present: boolean | null; downloading: boolean } | null;
  /** How far the image download is (while it downloads, when the runtime's output says). */
  progress: PullProgress | null;
  container: { name: string; exists: boolean; running: boolean } | null;
  /** The server's OS (the card's next step when no backend works). */
  platform: NodeJS.Platform;
  /** One line for the user (why it is off, that it is downloading). */
  notice: string | null;
  error: string | null;
  /**
   * macOS / Windows: the folder has this computer's builds (host-builds.ts). `native`: its chats
   * stay on this computer (only the server's default had it on); else it is on by the user's
   * choice and `notice` warns that rebuilding them in the box replaces them. Null otherwise.
   */
  hostBuilds: { native: boolean; things: string; notice: string } | null;
  /** macOS / Windows, while the project's chats run in the box: the one line that says so (null elsewhere). */
  boxNotice: string | null;
  /**
   * The server requires the sandbox for new chats (local_box.required): the switch and "Off (this
   * computer)" are disabled with `requiredText.optOut`. False with an older server.
   */
  required: boolean;
  requiredText: { line: string; optOut: string; keptOldChat: string } | null;
  /** Required, but the project only builds on this OS (an Xcode project, a WPF app): its chats run here. */
  hostOnly: { things: string[]; notice: string } | null;
  /** Required and not ready: what the sandbox needs on this computer (the setup screen). Null otherwise. */
  setup: (BoxSetup & { line: string | null }) | null;
  /** Asked for one chat (`?session=`): it ran on this computer before the sandbox was required and stays here. */
  chatKept: boolean;
  /** Servers in the box open at the same port on this computer's 127.0.0.1 (Docker/Podman boxes; ports.ts). */
  ports: Array<{ port: number; url: string; line: string }>;
};

/** The setup screen's steps (POST /workspace/:id/box/setup). */
export const BOX_SETUP_ACTIONS = ["linux_allow", "win_install", "win_restart", "win_update", "decline", "check"] as const;
export type BoxSetupAction = (typeof BOX_SETUP_ACTIONS)[number];
export function isBoxSetupAction(value: unknown): value is BoxSetupAction {
  return BOX_SETUP_ACTIONS.some((action) => action === value);
}

/** PUT mode "off" (or the backend "native") while the sandbox is required: refused (409 box_required). */
export class BoxRequiredError extends Error {
  readonly code = "box_required";
  constructor() {
    super(desktopText("opt_out_refused"));
  }
}

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
  // macOS' own VM: first under the required sandbox, else chosen by name only.
  const first = (REQUIRED_FIRST[platform] ?? []).map((id) => ({ id, label: LABELS[id] ?? id }));
  return [{ id: "auto", label: "Automatic" }, ...first, ...backendsFor(platform).map((id) => ({ id, label: LABELS[id] ?? id })), ...optIn, { id: "native", label: "Off (this computer)" }];
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
  /** Whether a running box's project folder was deleted and made again (box.ts mountReplaced; tests replace it). */
  folderReplaced?: (box: { endpoint: BoxEndpoint; croot: string }) => Promise<boolean>;
  /** The OS whose builds count as this computer's (host-builds.ts; tests set it). */
  platform?: NodeJS.Platform;
};

/** `waitingImage`: planned while its image was downloading (planned again as soon as the image is here). */
type Project = { run: BoxRun | null; notice: string | null; planning: Promise<BoxRun | null> | null; nextPlanAt: number; waitingImage: boolean; why?: PlanWhy | null; pull?: { runtime: RuntimeInfo; image: BoxImage } | null; lastRuntime?: RuntimeResult | null };

/** Why the project's last plan has no box (the `box.plan` reason), with the runtime's failure in safe words. */
type PlanWhy = { reason: "no_runtime" | "helpers_missing" | "downloading"; runtime?: { name: string | null; code: string | null } };

/**
 * A chat's `box.plan` trace event (once per chat and app run): where its
 * prompts run and why, as the CLI's `client.launch` `box`. `reason`: box,
 * box_failed, off, offer, host_builds, kept_old_chat, no_runtime,
 * helpers_missing, downloading, planning; `source`: what turned the box on or
 * off (project, server, default, flag, host-builds, chat).
 */
export type BoxPlanOutcome = { native: boolean; source: string | null; reason: string; runtime?: { name: string | null; code: string | null }; required?: true; capable?: boolean; fallback?: RequiredFallback };

/** The backend tried and its failure code (bubblewrap's apparmor, no_bwrap, ...; `timeout`), never its text or a path. */
export function runtimeWhy(runtime: { name?: unknown; code?: unknown; reason?: unknown } | null | undefined): { name: string | null; code: string | null } {
  const code = typeof runtime?.code === "string" && /^[a-z_]{1,32}$/.test(runtime.code) ? runtime.code
    : /did not answer in time/.test(String(runtime?.reason ?? "")) ? "timeout" : null;
  const name = typeof runtime?.name === "string" && /^[a-z-]{1,16}$/.test(runtime.name) ? runtime.name : null;
  return { name, code };
}

/** A project whose image is downloading is planned again at most this often. */
const REPLAN_MS = 15_000;
/** A prompt waits at most this long for its turn's checkpoint. */
const FREEZE_WAIT_MS = 90_000;
/** The full backend check (every backend, for the status card's "others") is reused this long. */
const ALTERNATIVES_MS = 60_000;
/**
 * Required: a prompt waits for its project's box while the first setup makes progress (the
 * download's log moves: the VM's setup lines, the image's bytes) and stops waiting after this
 * long with none (the CLI: a run's no-progress stop counts the setup too).
 */
const REQUIRED_WAIT_MS = 15 * 60_000;
/** ...and at most this long in all, however slow the network (a first macOS VM setup is ~0.7 GB). */
const REQUIRED_SETUP_MAX_MS = 60 * 60_000;
/** How often a waiting prompt looks again. */
const REQUIRED_POLL_MS = 1_000;

export function boxRoot(workspace: BoxWorkspace): string {
  return workspace.directory?.trim() || workspace.path;
}

export class BoxService {
  private readonly projects = new Map<string, Project>();
  private readonly turns = new Map<string, number>();
  /** Each chat's turn number as of its last prompt here (its turns before this run, then one per prompt). */
  private readonly chatTurns = new Map<string, number>();
  /** Per chat, its counts before the prompt beforePrompt last saw (promptCancelled puts them back). */
  private readonly uncommitted = new Map<string, { chatTurns: number | undefined; boxed: boolean; turns: number | undefined }>();
  /** Chats (and their project's key) that ran on this machine before the server's default turned the box on: they stay here. */
  private readonly nativeChats = new Map<string, string>();
  /** Of nativeChats, the ones on a model that runs only on this computer (launch reason native_model). */
  private readonly nativeModelChats = new Set<string>();
  /** Chats sent to their project's box in this run (a failed checkpoint included). */
  private readonly boxedChats = new Set<string>();
  /**
   * Each chat's pin, from its first prompt: whether it runs in the box and the
   * local_box policy revision it started under (model_start). A started chat
   * never moves: a box chat whose project's box is turned off is refused
   * (pinnedBoxGone), a chat that ran here stays here. Kept in chat-pins.json.
   */
  private pins: Map<string, { box: boolean; revision: string | null }> | null = null;
  /** Chats whose box.plan event went out in this run. */
  private readonly outcomeSent = new Set<string>();
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private log: BoxLog;
  private projectsWrite: Promise<void> = Promise.resolve();
  private installLog: BoxInstallLogPaths | null = null;
  private alternatives: { at: number; key: string; list: BackendAlternative[] } | null = null;

  private readonly folderReplaced: NonNullable<BoxServiceOptions["folderReplaced"]>;

  constructor(private readonly options: BoxServiceOptions) {
    this.folderReplaced = options.folderReplaced ?? (({ endpoint, croot }) => mountReplaced({ endpoint }, { croot, readyMs: 1_000 }));
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
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

  /** The server's `required` for this device (box-server.json), its fallback and prefetch. */
  required(): ReturnType<typeof serverRequired> {
    return serverRequired(this.options.stateDir);
  }

  /**
   * The backend detection's inputs: the setting (or OMNIRUSH_BOX_BACKEND) and the server's allowlist.
   * While the sandbox is required, a saved "native" reads as automatic (OMNIRUSH_BOX_BACKEND=native still counts).
   */
  private detectOptions(): Pick<DetectOptions, "asked" | "allow" | "preferShadows" | "required"> {
    const asked = askedBackend({ env: this.env, stateDir: this.options.stateDir });
    const required = this.required().required;
    const backend = asked.source === "setting" && asked.backend === "native" && required ? "auto" : asked.backend;
    // Under required on macOS / Windows the backends that give the box its own build folders (shadows) come first.
    return { asked: backend, allow: serverBackends(this.options.stateDir), ...(required && shadowsApply(this.platform, this.env) ? { preferShadows: true } : {}), ...(required ? { required: true } : {}) };
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
    if (value === "native" && this.required().required) throw new BoxRequiredError();
    const saved = saveBackend(this.options.stateDir, value);
    this.alternatives = null;
    const now = await this.detect({ fresh: true });
    const chosen = now.ok ? now.backend ?? now.name : null;
    for (const project of this.projects.values()) {
      if (project.run && project.run.backend === chosen) continue;
      this.dropRun(project);
      project.notice = null;
      project.nextPlanAt = 0;
    }
    await this.writeProjects();
    void this.ensureAll();
    return saved;
  }

  /**
   * The server's backends allowlist changed (box-server.json): a project whose box runs on a
   * backend it no longer allows is planned again (its chats go on natively until then).
   */
  async serverBackendsChanged(): Promise<void> {
    const allow = serverBackends(this.options.stateDir);
    this.alternatives = null;
    // A plan in flight (started with the old allowlist) settles first.
    await Promise.allSettled([...this.projects.values()].map((project) => project.planning));
    for (const project of this.projects.values()) {
      if (!project.run || !allow || allow.includes(project.run.backend)) continue;
      this.dropRun(project);
      project.notice = null;
      project.nextPlanAt = 0;
    }
    await this.writeProjects();
  }

  private async mode(workspace: BoxWorkspace) {
    const settings = await this.options.readSettings(workspace.id).catch(() => ({ mode: null, offered: false }));
    const server = this.serverDefault();
    const { required } = this.required();
    // A buildathon project (the app lists them): the event's `repro.box` comes before the server's default.
    const buildathon = workspace.workspaceType === "local" ? this.buildathonBox(boxRoot(workspace)) : null;
    const resolved = resolveMode({ env: this.env, project: settings.mode, server, offered: settings.offered, buildathon, required });
    // Required: the folder's builds no longer keep it here (the box keeps its own copies); a project that
    // only builds on this OS (an Xcode project, a WPF app) does.
    if (resolved.source === "required") {
      const hostOnly = workspace.workspaceType === "local" ? this.hostOnly(boxRoot(workspace)) : null;
      if (hostOnly) return { settings, server, ...resolved, on: false, source: "host-only" as const, hostBuilds: null, hostOnly };
      return { settings, server, ...resolved, hostBuilds: null, hostOnly: null };
    }
    const gate = workspace.workspaceType === "local" ? this.hostGate(boxRoot(workspace), resolved) : null;
    // A box already running for the project keeps its chats (builds made since do not move them out).
    const running = this.projects.get(boxKey(boxRoot(workspace)))?.run;
    if (gate?.native && !(running && !running.native)) return { settings, server, ...resolved, on: false, source: "host-builds" as const, offer: false, hostBuilds: gate, hostOnly: null };
    return { settings, server, ...resolved, hostBuilds: gate, hostOnly: null };
  }

  private hostOnly(root: string): { things: string[]; notice: string } | null {
    try {
      return hostOnlyProject(root, { platform: this.platform });
    } catch {
      return null;
    }
  }

  /**
   * macOS / Windows: a project folder with this computer's builds (node_modules,
   * a venv, Mach-O / PE programs; host-builds.ts). Only the server's default
   * putting it in the box: its chats stay here (`native`); the user's own
   * choice (the project's switch, OMNIRUSH_BOX=1): in the box, with a warning.
   * Null on Linux, with the box off, or when the folder has none.
   * OMNIRUSH_BOX_KEEP_NATIVE=off or OMNIRUSH_BOX_HOST_BUILDS=off skips it.
   */
  private buildathonBox(root: string): "on" | "offer" | "off" | null {
    try {
      return buildathonBoxFor(root, buildathonProjectsFile(this.home));
    } catch {
      return null;
    }
  }

  private hostGate(root: string, mode: { on: boolean; source: string }): { native: boolean; things: string; notice: string } | null {
    if (!mode.on || !hostRules(this.platform)) return null;
    if (String(this.env.OMNIRUSH_BOX_KEEP_NATIVE ?? "").trim().toLowerCase() === "off") return null;
    let found;
    try {
      found = hostBuilds(root, { platform: this.platform, stateDir: this.options.stateDir, env: this.env });
    } catch (error) {
      this.log("warn", "host builds check failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
    if (!found.found) return null;
    // Only a default (the server's, or the buildathon's) keeps the folder here; the user's own choice does not.
    const native = mode.source === "server" || mode.source === "buildathon";
    return { native, things: hostBuildThings(found), notice: hostBuildsNotice(native ? "native" : "explicit", { platform: this.platform, result: found }) };
  }

  /**
   * The engine config additions (`shell` and the plugin), or null: only when
   * some local workspace has its box on or the server's default is on or
   * offer, and the helpers for this machine are installed.
   */
  async engineBits(): Promise<{ shell: string; plugin: string } | null> {
    let wanted = this.serverDefault() !== "off" || this.required().required || ["1", "on", "true"].includes(String(this.env.OMNIRUSH_BOX ?? "").trim().toLowerCase());
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
    const project = this.projects.get(key) ?? { run: null, notice: null, planning: null, nextPlanAt: 0, waitingImage: false };
    this.projects.set(key, project);
    if (project.planning) return project.planning;
    project.planning = (async () => {
      const { on, hostBuilds: gate } = await this.mode(workspace);
      if (!on) {
        if (gate?.native && project.notice !== gate.notice) this.log("info", "box: the server's default not applied, the folder has this computer's builds", { key, things: gate.things });
        this.dropRun(project);
        project.notice = gate?.native ? gate.notice : null;
        await this.writeProjects();
        return null;
      }
      if (project.run && !project.run.native) {
        const box = project.run.box;
        // The folder was deleted and made again (a new clone) while its box ran: the box still has the deleted
        // one, where every command fails. Planned again, the box restarts on the new folder (openBox).
        if (!box?.ready || !box.endpoint || !(await this.folderReplaced({ endpoint: box.endpoint, croot: box.croot }).catch(() => false))) return project.run;
        this.log("info", "box folder replaced while it ran: starting it again", { key });
        this.dropRun(project);
        project.nextPlanAt = 0;
      }
      if (Date.now() < project.nextPlanAt) return null;
      const plan = await planBox({ env: this.env, home: this.home, root, log: this.log, shims: shimsDir(this.env), platform: this.platform, stateDir: this.options.stateDir, ...this.detectOptions(), required: this.required().required });
      project.waitingImage = !plan.box && plan.downloading === true;
      project.lastRuntime = plan.box ? null : plan.runtime;
      project.pull = !plan.box && plan.downloading === true && plan.image && plan.runtime?.ok ? { runtime: plan.runtime, image: plan.image } : null;
      project.why = plan.box ? null
        : plan.downloading === true ? { reason: "downloading" }
        : plan.runtime && !plan.runtime.ok ? { reason: "no_runtime", runtime: runtimeWhy(plan.runtime) }
        : { reason: "helpers_missing" };
      if (!plan.box) {
        this.dropRun(project);
        project.notice = plan.notice;
        project.nextPlanAt = Date.now() + REPLAN_MS;
        await this.writeProjects();
        return null;
      }
      project.notice = null;
      project.run?.close();
      project.run = boxRun(plan, {
        log: this.log,
        // Box ports on this computer's 127.0.0.1: only under the required sandbox.
        required: this.required().required,
        pkglog: this.installLog ? { root: this.installLog.root, bin: this.installLog.bin, py: this.installLog.py } : null,
        tmpRoot: join(this.home, "pending"),
        // boxd stopped while the app ran: started again (installs kept), or once why not and what to do.
        onRevive: (event) => {
          if (event.ok) {
            this.log("info", "box started again after it stopped", { key, why: event.why });
            if (project.notice?.startsWith("Sandbox stopped:")) project.notice = null;
          } else {
            project.notice = `Sandbox stopped: ${event.error}.`;
          }
        },
        // A server in the box (its own network) at the same port on this computer's 127.0.0.1: one log line (ports.ts).
        onPort: (event) => { if (event.open) this.log("info", event.line ?? `box port ${event.port} open`, { key, port: event.port }); },
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

  /**
   * A workspace was opened, made active or added: its box is planned now, in
   * the background (a missing image starts downloading, the box starts), so
   * it is ready before the first prompt. Never throws.
   */
  opened(workspace: BoxWorkspace): void {
    if (workspace.workspaceType !== "local") return;
    const project = this.projects.get(boxKey(boxRoot(workspace)));
    if (project && !project.run) project.nextPlanAt = 0;
    // The box starts as soon as its run exists (boxRun); a missing image starts downloading.
    void this.ensure(workspace).then((run) => {
      this.log("info", "box planned for an opened project", { key: boxKey(boxRoot(workspace)), box: Boolean(run && !run.native) });
    }).catch(() => null);
  }

  /**
   * The server asks for images to be fetched ahead (local_box.setup.prefetch):
   * the base image, in the background, next to the stacks the open projects'
   * plans download (ensureAll). Skipped on a metered connection (OMNIRUSH_BOX_METERED=1)
   * and when no backend works. Whether a download started.
   */
  async prefetch(): Promise<boolean> {
    if (!this.required().prefetch || this.env.OMNIRUSH_BOX_METERED === "1") return false;
    const runtime = await this.detect().catch(() => null);
    if (!runtime?.ok) return false;
    const image = imageFor("base", { env: this.env });
    if (pulling(this.home, runtime, image.pull)) return false;
    if (await driverFor(runtime).imagePresent(runtime, image, { home: this.home, env: this.env }).catch(() => null)) return false;
    this.log("info", "box prefetch", { image: image.pull, backend: runtime.backend ?? runtime.name });
    pullInBackground(runtime, image, this.home, { env: this.env, log: this.log });
    return true;
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
    if (mode === "off" && this.required().required) throw new BoxRequiredError();
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

  /** Whether the project's work runs in its box (the same decision as status().on, without probing the runtime). */
  async sandboxOn(workspace: BoxWorkspace): Promise<boolean> {
    if (workspace.workspaceType !== "local") return false;
    return (await this.mode(workspace)).on;
  }

  async status(workspace: BoxWorkspace, { fresh = false, sessionId = null }: { fresh?: boolean; sessionId?: string | null } = {}): Promise<BoxStatus> {
    const { settings, server, on, source, offer, hostBuilds: gate, lessRepro, hostOnly, required } = await this.mode(workspace);
    // The server's "offer": shown once per folder (CLI: the tip, once per folder).
    if (offer && workspace.workspaceType === "local") await this.options.writeSettings(workspace.id, { offered: true }).catch(() => undefined);
    const root = boxRoot(workspace);
    const key = boxKey(root);
    const project = this.projects.get(key);
    const needed = required === true;
    const requiredText = needed ? { line: desktopText("required_line"), optOut: desktopText("opt_out_refused"), keptOldChat: desktopText("kept_old_chat") } : null;
    const chatKept = Boolean(sessionId && this.nativeChats.has(sessionId));
    // How a new chat on each model starts (the server's model_start, with its revision), and this chat's pin.
    const localBox = serverLocalBox(this.options.stateDir);
    const modelStart = localBox?.model_start && typeof localBox.model_start === "object" ? (localBox.model_start as BoxStatus["modelStart"]) : null;
    const revision = typeof localBox?.revision === "string" ? localBox.revision : null;
    const chatPin = sessionId ? this.chatPin(sessionId) : null;
    const base = { mode: settings.mode, serverDefault: server, on, source, offer, error: null, hostBuilds: gate, boxNotice: null, required: needed, requiredText, hostOnly, setup: null, chatKept: chatKept || chatPin?.box === false, ports: [] as BoxStatus["ports"], modelStart, revision, chatPin };
    const backendSetting = { ...askedBackend({ env: this.env, stateDir: this.options.stateDir }), choices: backendChoices() };
    const setting = { value: backendSetting.backend, source: backendSetting.source, choices: backendSetting.choices };
    if (workspace.workspaceType !== "local") return { ...base, on: false, offer: false, state: "off", runtime: null, backend: null, backendSetting: setting, image: null, progress: null, container: null, platform: this.platform, notice: "The sandbox is for folders on this computer." };
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
    // The download finished: plan the project now (not at its next chat), so the card goes on to starting and ready.
    if (on && runtime.ok && project?.waitingImage && !downloading && (present || container?.exists)) {
      project.waitingImage = false;
      project.notice = null;
      project.nextPlanAt = 0;
      void this.ensure(workspace).catch(() => null);
    }
    const marker = runtime.ok ? pullMarker(this.home, runtime, image.pull) : null;
    const progress = downloading && marker && runtime.ok ? pullProgress(pullLog(marker), marker, layerSizes(runtime, image)) : null;
    const record = readRecord(this.home, key);
    const run = project?.run ?? null;
    const state: BoxStatus["state"] = !on ? "off"
      : !runtime.ok ? "unavailable"
      : run && !run.native ? (run.box?.ready ? "ready" : run.box?.state === "failed" ? "failed" : "starting")
      : downloading || (!present && !container?.exists) ? "downloading"
      : project?.notice ? "unavailable" : "starting";
    const setup = needed && on && state !== "ready" ? await this.setupFor(runtime, { fresh }) : null;
    return {
      ...base,
      state,
      runtime: runtimeView,
      backend,
      backendSetting: setting,
      image: { ref: image.pull, stack: image.stack, present, downloading },
      progress,
      container,
      platform: this.platform,
      notice: on ? project?.notice ?? (runtime.ok ? null : `Sandbox off for now: ${runtime.reason}.`)
        : gate?.native ? gate.notice
        : hostOnly ? hostOnly.notice
        : lessRepro ? LESS_REPRO_NOTICE
        : offer && source === "buildathon" ? BUILDATHON_OFFER_NOTICE
        : null,
      error: run?.box?.error ?? (record?.state === "off" || record?.state === "failed" ? record.error || null : null),
      // The box's own build folders in use (required.json texts.desktop.shadows), else the plain macOS/Windows line.
      boxNotice: on && run && !run.native && run.box?.shadows ? shadowsNotice(run.box.currentShadows(), this.platform) ?? hostBuildsNotice("box", { platform: this.platform })
        : on && hostRules(this.platform) ? hostBuildsNotice("box", { platform: this.platform }) : null,
      setup,
      ports: run && !run.native ? (run.forwardedPorts?.() ?? []).map((port) => ({ port, url: `http://127.0.0.1:${port}`, line: portLine(port) })) : [],
    };
  }

  /** What the sandbox needs here before it can run (the setup screen); this PC's checks are read (and cached) for it on Windows. */
  async setupFor(runtime: RuntimeResult | null, { fresh = false }: { fresh?: boolean } = {}): Promise<BoxSetup & { line: string | null }> {
    const checks = this.platform === "win32" && runtime && !runtime.ok ? await cachedWindowsChecks({ fresh }).catch(() => null) : null;
    // macOS: the OmniRush VM picked and not made yet (it sets itself up; the panel shows its progress).
    const macVm = this.platform === "darwin" && Boolean(runtime?.ok && runtime.backend === "lima" && !runtime.installed && !this.limaMade(runtime));
    const setup = classifySetup({ runtime, platform: this.platform, checks, state: setupState(this.home), fallback: this.required().fallback, macVm });
    // The one line (required.json texts.desktop.cannot_run) when the box cannot run here.
    const why = setup.whyText ?? (runtime && !runtime.ok ? runtime.reason.split("\n")[0]!.replace(/\.$/, "") : null);
    return { ...setup, line: setup.need === "cannot_run" && why ? desktopText("cannot_run", { why }) : null };
  }

  /** Whether the OmniRush VM was made since the (cached) probe said it was not: its LIMA_HOME has the instance. */
  private limaMade(runtime: RuntimeResult): boolean {
    if (!runtime.ok || runtime.backend !== "lima") return false;
    try { return existsSync(join(limaHome(this.home, this.env, undefined, runtime.instance), runtime.instance ?? "omnirush-box", "lima.yaml")); } catch { return false; }
  }

  /**
   * App start on Windows after "Set up (one restart)" (the resume marker):
   * `wsl --update` when WSL asks for it, then every project is planned (the
   * distro import and the image download follow). Never throws.
   */
  async resumeSetup(): Promise<boolean> {
    if (this.platform !== "win32" || setupState(this.home).win?.state !== "restart") return false;
    // A slow `wsl --update` goes on in the background (setup.ts RESUME_UPDATE_WAIT_MS) and finishes the same way.
    const ready = async (): Promise<void> => {
      this.alternatives = null;
      await this.detect({ fresh: true }).catch(() => null);
      void this.ensureAll();
      void this.prefetch().catch(() => false);
    };
    const resumed = await resumeWinSetup({ home: this.home, env: this.env, log: (level, message) => this.log(level, message), onReady: () => { this.log("info", "sandbox setup resume", { state: "ready" }); void ready(); } }).catch(() => null);
    this.log("info", "sandbox setup resume", { state: resumed?.state ?? "failed" });
    if (!resumed?.ok) return false;
    await ready();
    return true;
  }


  /**
   * Try again now (the card's retry): a box that failed to start, or a
   * project that went on without it, is planned again; its container and
   * installs stay. The status after a fresh check.
   */
  async retry(workspace: BoxWorkspace): Promise<BoxStatus> {
    const project = this.projects.get(boxKey(boxRoot(workspace)));
    if (project && (project.run?.native || project.run?.box?.state === "failed")) this.dropRun(project);
    if (project) {
      project.notice = null;
      project.nextPlanAt = 0;
    }
    this.alternatives = null;
    // A runtime started or installed meanwhile: the cached answer (a failure is kept 2 minutes) is asked again.
    await Promise.race([this.detect({ fresh: true }), new Promise((resolve) => setTimeout(resolve, 10_000).unref?.())]);
    await this.writeProjects();
    void this.ensure(workspace).catch(() => null);
    return this.status(workspace, { fresh: true });
  }

  /**
   * One setup step (box/setup.ts), then a fresh look: a step that worked has
   * the project planned again (and the images fetched ahead), so the box
   * starts. Only the steps of this OS run; the others are a fresh look.
   */
  async setup(workspace: BoxWorkspace, action: BoxSetupAction): Promise<BoxStatus> {
    const home = this.home;
    const which = this.platform === "win32" ? "win" : this.platform === "linux" ? "linux" : null;
    // The admin steps (pkexec, UAC, a restart) run only where the server requires the sandbox.
    if (!this.required().required && action !== "check") return this.status(workspace, { fresh: true });
    if (action === "linux_allow" && this.platform === "linux") await linuxAllow({ home, env: this.env });
    else if (action === "win_install" && this.platform === "win32") await windowsInstall({ home, env: this.env });
    else if (action === "win_update" && this.platform === "win32") await windowsUpdate({ env: this.env });
    else if (action === "win_restart" && this.platform === "win32") await windowsRestart();
    else if (action === "decline" && which) saveSetupState(home, which, { state: "declined", message: "Set up later; chats run on this computer meanwhile." });
    if (action === "check" && this.platform === "win32") await cachedWindowsChecks({ fresh: true }).catch(() => null);
    if (action === "win_restart") return this.status(workspace);
    const status = await this.retry(workspace);
    if (status.setup?.need === "none") void this.prefetch().catch(() => false);
    return status;
  }

  /** Remove the project's container (installs gone); the next chat starts a fresh one. */
  async reset(workspace: BoxWorkspace): Promise<{ removed: boolean }> {
    const root = boxRoot(workspace);
    const key = boxKey(root);
    const runtime = await this.detect();
    const project = this.projects.get(key);
    if (project) {
      this.dropRun(project);
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
  /**
   * A prompt beforePrompt saw was not dispatched (stopped, refused before the
   * engine): the chat's turn count, its in-the-box mark and turn number go back
   * to what they were, so the next prompt is classified as this one was.
   */
  promptCancelled(sessionId: string): void {
    const before = this.uncommitted.get(sessionId);
    if (!before) return;
    this.uncommitted.delete(sessionId);
    if (before.chatTurns === undefined) this.chatTurns.delete(sessionId);
    else this.chatTurns.set(sessionId, before.chatTurns);
    if (!before.boxed) this.boxedChats.delete(sessionId);
    if (before.turns === undefined) this.turns.delete(sessionId);
    else this.turns.set(sessionId, before.turns);
  }

  async beforePrompt(sessionId: string, workspace: BoxWorkspace, { capture = true, turnsBefore = 0, nativeModel = false, signal }: { capture?: boolean; turnsBefore?: number; nativeModel?: boolean; signal?: AbortSignal } = {}): Promise<BoxCaptureInfo | null> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(sessionId)) return null;
    // A chat on a model that runs only on this computer (model-modes/: Kimi) runs here, exempt from
    // the required sandbox, unless it already ran in the box (a chat's model never changes).
    if (nativeModel && !this.nativeChats.has(sessionId) && !this.boxedChats.has(sessionId) && !this.turns.has(sessionId) && savedTurns(this.snapshotDir(sessionId)) === 0) {
      this.nativeChats.set(sessionId, boxKey(boxRoot(workspace)));
      this.nativeModelChats.add(sessionId);
      await this.writeProjects();
      this.log("info", "box: a chat on a model that runs only on this computer stays here", { sessionId });
    }
    // The chat's own turn number, counted with the box on or off: a chat that ran natively
    // (reopened, or its box turned on mid-chat) has its first checkpoint (turn-1) before a later
    // turn; the checkpoint names it as session_turn (CLI: the same).
    const turnsSoFar = this.chatTurns.get(sessionId) ?? turnsBefore;
    const chatTurn = capture ? turnsSoFar + 1 : 0;
    // What this prompt counts as "the chat has run": undone if it never reaches the engine (promptCancelled).
    this.uncommitted.set(sessionId, { chatTurns: this.chatTurns.get(sessionId), boxed: this.boxedChats.has(sessionId), turns: this.turns.get(sessionId) });
    if (capture) this.chatTurns.set(sessionId, chatTurn);
    // Required: a new chat waits for its project's box (the download, the start) instead of starting here;
    // a chat that already ran on this machine stays here, without waiting.
    const required = workspace.workspaceType === "local" && (await this.mode(workspace).catch(() => null))?.source === "required";
    const oldChat = capture && turnsSoFar > 0 && !this.boxedChats.has(sessionId) && !this.turns.has(sessionId) && savedTurns(this.snapshotDir(sessionId)) === 0;
    if (required && oldChat && !this.nativeChats.has(sessionId)) {
      this.nativeChats.set(sessionId, boxKey(boxRoot(workspace)));
      await this.writeProjects();
      this.log("info", "box: a chat that ran on this machine stays there", { sessionId, turnsBefore, required: true });
    }
    const run = required && !this.nativeChats.has(sessionId) ? await this.waitForBox(workspace, signal) : await this.ensure(workspace).catch(() => null);
    // The send was stopped while it waited: no checkpoint and no pin, the caller does not dispatch it, and the
    // chat counts as not having run this turn (a retry waits for the box again).
    if (signal?.aborted) {
      this.promptCancelled(sessionId);
      return null;
    }
    if (!run || run.native) {
      if (capture) await this.pin(sessionId, false);
      return null;
    }
    // A chat with turns but no checkpoint ran on this machine (reopened, or started in this run before the
    // server's default reached the app, or while the image downloaded): when only the server's default
    // turned the box on, it goes on here (new chats get the box); a project turned on by its user moves it.
    // One pin per chat (2026-10-24): it stays here whoever turned the box on since.
    if (capture && turnsSoFar > 0 && !this.nativeChats.has(sessionId) && !this.boxedChats.has(sessionId) && !this.turns.has(sessionId) && savedTurns(this.snapshotDir(sessionId)) === 0 && !this.chatPin(sessionId)?.box) {
      this.nativeChats.set(sessionId, run.key);
      await this.writeProjects();
      this.log("info", "box: a chat that ran on this machine stays there", { sessionId, turnsBefore });
    }
    if (this.nativeChats.has(sessionId) || !capture) {
      if (capture) await this.pin(sessionId, false);
      return null;
    }
    this.boxedChats.add(sessionId);
    await this.pin(sessionId, true);
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

  /**
   * Required: the project's box, waited for while its image downloads (at
   * most REQUIRED_WAIT_MS; planned again as soon as the download ends). Null
   * when it cannot run here (no backend: the setup screen says why; the
   * chat goes on per the server's required_fallback).
   */
  private async waitForBox(workspace: BoxWorkspace, signal?: AbortSignal): Promise<BoxRun | null> {
    const key = boxKey(boxRoot(workspace));
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    let said = false;
    for (;;) {
      // A stopped send stops waiting at once (its request was given up).
      if (signal?.aborted) return null;
      const run = await this.ensure(workspace).catch(() => null);
      if (run) return run;
      const project = this.projects.get(key);
      if (project?.why?.reason !== "downloading") return null;
      const pull = project.pull;
      const moved = pull ? pullActivityAt(this.home, pull.runtime, pull.image.pull) : null;
      if (moved !== null && moved > lastProgressAt) lastProgressAt = moved;
      const wait = setupWait({ startedAt, lastProgressAt, now: Date.now(), idleMs: REQUIRED_WAIT_MS, maxMs: REQUIRED_SETUP_MAX_MS });
      if (wait.over) {
        this.log("warn", "required sandbox wait over", { reason: wait.over, waitedMs: Date.now() - startedAt });
        return null;
      }
      if (!said && Date.now() - startedAt >= 60_000) {
        said = true;
        this.log("info", "required sandbox: the prompt waits for the first setup", { maxMin: Math.round(REQUIRED_SETUP_MAX_MS / 60_000) });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, REQUIRED_POLL_MS);
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
      });
      if (signal?.aborted) return null;
      if (pull && !pulling(this.home, pull.runtime, pull.image.pull)) project.nextPlanAt = 0;
    }
  }

  /** The chat's box.plan outcome, once per chat and app run (null after that, or for a folder not on this computer). */
  private pinFile(): string {
    return join(this.options.stateDir, "chat-pins.json");
  }

  private loadPins(): Map<string, { box: boolean; revision: string | null }> {
    if (this.pins) return this.pins;
    this.pins = new Map();
    try {
      const value: unknown = JSON.parse(readFileSync(this.pinFile(), "utf8"));
      if (value && typeof value === "object") {
        for (const [id, pin] of Object.entries(value)) {
          if (pin && typeof pin === "object" && typeof (pin as { box?: unknown }).box === "boolean") {
            const revision = (pin as { revision?: unknown }).revision;
            this.pins.set(id, { box: (pin as { box: boolean }).box, revision: typeof revision === "string" ? revision : null });
          }
        }
      }
    } catch { /* none yet */ }
    return this.pins;
  }

  /** A chat's pin ({ box, revision }), or null before its first prompt. */
  chatPin(sessionId: string): { box: boolean; revision: string | null } | null {
    return this.loadPins().get(sessionId) ?? null;
  }

  private async pin(sessionId: string, box: boolean): Promise<void> {
    const pins = this.loadPins();
    if (pins.has(sessionId)) return;
    const revision = serverLocalBox(this.options.stateDir)?.revision;
    pins.set(sessionId, { box, revision: typeof revision === "string" ? revision : null });
    while (pins.size > 4000) pins.delete(pins.keys().next().value!);
    await writeFileAtomic(this.pinFile(), `${JSON.stringify(Object.fromEntries(pins))}\n`).catch(() => undefined);
  }

  /** Whether a chat pinned to the box would run on this computer now (its project's box turned off): its prompt is refused. */
  async pinnedBoxGone(sessionId: string, workspace: BoxWorkspace): Promise<boolean> {
    if (workspace.workspaceType !== "local" || !this.chatPin(sessionId)?.box) return false;
    const mode = await this.mode(workspace).catch(() => null);
    return Boolean(mode && !mode.on);
  }

  async planOutcome(sessionId: string, workspace: BoxWorkspace): Promise<BoxPlanOutcome | null> {
    if (workspace.workspaceType !== "local" || this.outcomeSent.has(sessionId)) return null;
    this.outcomeSent.add(sessionId);
    const mode = await this.mode(workspace).catch(() => null);
    if (!mode) return { native: true, source: null, reason: "plan_failed" };
    const { fallback } = this.required();
    // Required (required.ts requiredLaunch, as the CLI's launch event): whether this machine can run the box and,
    // on this machine, the fallback in force: `native` where it can't (counted in full), the server's
    // required_fallback where the box was turned off (OMNIRUSH_BOX=0) or the setup declined.
    const native = (reason: string, extra: Partial<BoxPlanOutcome> = {}): BoxPlanOutcome => ({ native: true, source: mode.source, reason, ...(mode.required ? requiredLaunch(reason, { native: true, serverFallback: fallback }) : {}), ...extra });
    if (this.nativeChats.has(sessionId)) return this.nativeModelChats.has(sessionId) ? native("native_model", { source: "model" }) : native("kept_old_chat", { source: "chat" });
    if (this.boxedChats.has(sessionId)) return { native: false, source: mode.source, reason: "box", ...(mode.required ? requiredLaunch("box", { native: false }) : {}) };
    if (!mode.on) {
      if (mode.required && mode.source === "env") return native("env_off");
      if (mode.source === "host-only") return native("host_only");
      return native(mode.source === "host-builds" ? "host_builds" : mode.offer ? "offer" : "off");
    }
    const project = this.projects.get(boxKey(boxRoot(workspace)));
    if (project?.run?.native) return native("box_failed");
    if (project?.why) {
      const runtime = project.why.runtime ? { runtime: project.why.runtime } : {};
      if (mode.required && project.why.reason !== "downloading") {
        const setup = await this.setupFor(project.lastRuntime ?? null).catch(() => null);
        // As the CLI: only a step this app can run here (Allow, the WSL setup, the VM) is setup; else it cannot run.
        const fixable = setup && ["linux_allow", "win_install", "win_restart", "win_update", "mac_vm"].includes(setup.need);
        const reason = !fixable || project.why.reason === "helpers_missing" ? "cannot_run" : setup.declined ? "setup_declined" : "setup_needed";
        return native(reason, runtime);
      }
      return native(project.why.reason, runtime);
    }
    // Not planned yet (a plan still running, or waiting for its next try).
    return native("planning");
  }

  /** Whether chats ran in a box during this run (they get a `final` checkpoint at quit). */
  hasChats(): boolean {
    return this.turns.size > 0;
  }

  /** At quit: every chat with checkpoints gets its `final` leaf (bounded); the sessions that got one. */
  /** Let a project's box run go (no more restart requests answered for it). */
  private dropRun(project: Project): void {
    project.run?.close();
    project.run = null;
  }

  /** The app quits: stop watching every project's box for restart requests. */
  close(): void {
    for (const project of this.projects.values()) project.run?.close();
  }

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
