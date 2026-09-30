/** Static import: Node builds and compiled Bun binaries carry the same pack. */
import bundle from "./bundled-best-practices.json" with { type: "json" };
import { mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.js";
import { runtimeStorageDir } from "./runtime-db.js";
import type { RuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { OMNIRUSH_AGENT_PROMPT } from "./omnirush-agent-prompt.js";
import { isRecord } from "./workspace-kv-store.js";

export const OMNIRUSH_BEST_PRACTICES = bundle;

export function bestPracticesEnabled(runtime: RuntimeOpencodeConfig): boolean {
  return runtime.bestPractices !== false;
}

/** Separate from runtime `skills/`, whose recursive scan owns the swarm. */
export function omnirushBestPracticesSkillsDir(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "best-practices");
}

type BestPracticesEngineSnapshot = { agents: unknown; skills: unknown };

/** A file write precedes native cache refresh. Only observed readiness is applied. */
export async function waitForBestPracticesReady(input: {
  config: ServerConfig;
  enabled: boolean;
  read: (signal: AbortSignal) => Promise<BestPracticesEngineSnapshot[]>;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 10_000);
  const root = omnirushBestPracticesSkillsDir(input.config);
  const directory = await realpath(root).catch(() => root);
  const prompt = input.enabled ? `${OMNIRUSH_AGENT_PROMPT}\n\n${bundle.systemPrompt}` : OMNIRUSH_AGENT_PROMPT;
  const names = new Set(bundle.skills.map((skill) => skill.name));
  const owns = (location: string): boolean | null => {
    let path = location;
    if (location.startsWith("file:")) {
      try { path = fileURLToPath(location); } catch { return null; }
    }
    if (!isAbsolute(path)) return null;
    const child = relative(directory, path);
    return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  };
  const ready = (snapshot: BestPracticesEngineSnapshot): boolean => {
    if (!Array.isArray(snapshot.agents) || !Array.isArray(snapshot.skills)) return false;
    const agent = snapshot.agents.find((value) => isRecord(value) && value.name === "omnirush");
    if (!isRecord(agent) || agent.prompt !== prompt) return false;
    const owned = new Set<string>();
    const available = new Set<string>();
    for (const skill of snapshot.skills) {
      if (!isRecord(skill) || typeof skill.name !== "string" || !names.has(skill.name)) continue;
      // A matching user-owned guide stays available. Missing ownership data
      // cannot prove that the bundled copy disappeared.
      if (typeof skill.location !== "string" || !skill.location) return false;
      const ownership = owns(skill.location);
      if (ownership === null) return false;
      available.add(skill.name);
      if (ownership) owned.add(skill.name);
    }
    // Project/user guides can override a bundled name. On restores the
    // workflow catalog without taking those guides away from their owner.
    return input.enabled ? available.size === names.size : owned.size === 0;
  };
  while (Date.now() < deadline) {
    try {
      const snapshots = await input.read(AbortSignal.timeout(Math.max(1, deadline - Date.now())));
      if (snapshots.length > 0 && snapshots.every(ready)) return;
    } catch {
      // No raw prompt, skill body, credentials, or project metadata is logged.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(input.intervalMs ?? 100, remaining)));
  }
  throw new Error("Best practices engine readiness was not observed");
}

/** Only bundled bytes are written; no workspace, private inputs, or network. */
export async function writeBestPracticesSkills(config: ServerConfig): Promise<void> {
  const root = omnirushBestPracticesSkillsDir(config);
  await Promise.all(bundle.skills.map(async (skill) => {
    const directory = join(root, skill.name);
    const path = join(directory, "SKILL.md");
    if (await readFile(path, "utf8").catch(() => undefined) === skill.content) return;
    await mkdir(directory, { recursive: true });
    await writeFileAtomic(path, skill.content);
  }));
}

/** Attached engines cache an instance per folder and cannot roll over. */
export class BestPracticesEngineReloads {
  private readonly pending = new Map<string, WorkspaceInfo>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly hooks: {
    isBusy: (workspace: WorkspaceInfo) => Promise<boolean>;
    reload: (workspace: WorkspaceInfo) => Promise<void>;
    isPresent: (workspace: WorkspaceInfo) => boolean;
    retryMs?: number;
  }) {}

  async apply(workspaces: WorkspaceInfo[]): Promise<"applied" | "deferred"> {
    let deferred = false;
    try {
      for (const workspace of workspaces) {
        if (this.stopped) throw new Error("Best practices reloads stopped");
        const busy = await this.hooks.isBusy(workspace);
        if (this.stopped) throw new Error("Best practices reloads stopped");
        if (busy) {
          this.pending.set(workspace.id, workspace);
          deferred = true;
        } else {
          await this.hooks.reload(workspace);
          this.pending.delete(workspace.id);
        }
      }
    } finally {
      this.schedule();
    }
    return deferred ? "deferred" : "applied";
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.pending.clear();
  }

  private schedule(): void {
    if (this.stopped || this.timer || this.pending.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.retry();
    }, this.hooks.retryMs ?? 2_000);
    this.timer.unref();
  }

  private async retry(): Promise<void> {
    for (const [id, workspace] of this.pending) {
      if (this.stopped) return;
      if (!this.hooks.isPresent(workspace)) {
        this.pending.delete(id);
        continue;
      }
      try {
        if (await this.hooks.isBusy(workspace)) continue;
        if (this.stopped) return;
        await this.hooks.reload(workspace);
        this.pending.delete(id);
      } catch {
        // A failed or unreadable engine stays pending. No private details are
        // emitted, and it is never disposed merely because a probe failed.
      }
    }
    this.schedule();
  }
}
