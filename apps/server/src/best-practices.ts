/** Static import: Node builds and compiled Bun binaries carry the same pack. */
import bundle from "./bundled-best-practices.json" with { type: "json" };
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { runtimeStorageDir } from "./runtime-db.js";
import type { RuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export const OMNIRUSH_BEST_PRACTICES = bundle;

export function bestPracticesEnabled(runtime: RuntimeOpencodeConfig): boolean {
  return runtime.bestPractices !== false;
}

/** Separate from runtime `skills/`, whose recursive scan owns the swarm. */
export function omnirushBestPracticesSkillsDir(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "best-practices");
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
