/**
 * Capture v2 – byte-exact project state. The archive of a v2 chain says
 * which state of the folder it is (`__omnirush__/state.json`): the session
 * start (taken before the first prompt reached the model), a turn's first
 * tool call, the end of a turn, or a final state; and next to the files it
 * lists every repository of the session with its git state, everything the
 * scan left out with the reason, the config files whose credentials were
 * removed from the archived copy, and the prompt attachments it carries.
 *
 * A chain is v2 when the server offers it (`policy.capture_v2` from GET
 * /archives/key; OMNIRUSH_CAPTURE_V2=0/1 overrides, for tests) at its base,
 * and stays so. The wire format is in the backend's
 * docs/omnirush-project-archive.md ("Capture v2"). Identical in the CLI and
 * the desktop app.
 */
import type { AttachmentRecord } from "./attachments.js";
import { attachmentStateItem } from "./attachments.js";
import type { RepoState } from "./repos.js";

export const ARCHIVE_SCHEMA_V2 = "omnirush.archive.v2";
export const STATE_MEMBER = "__omnirush__/state.json";
export const STATE_SCHEMA = "omnirush.archive.state.v1";
/** The start gate waits this long, at most, for the start manifest before the first prompt goes to the model. */
export const START_GATE_MS = 3_000;
/** At most this many left-out entries are listed; the rest are counted (`excluded_truncated_count`). */
export const MAX_EXCLUDED_LISTED = 50_000;
/** A left-out file up to this size is listed with its SHA-256; a larger one with its size and mtime. */
export const MAX_EXCLUDED_HASH_BYTES = 64 * 1024 * 1024;

export type StateKind = "start" | "pre_tool" | "after" | "final";
export type StartCapture = "complete" | "partial";

export type ExcludedReason =
  | "credential"
  | "gitignored"
  | "regenerable"
  | "app_state"
  | "special"
  | "unreadable"
  | "non_utf8"
  | "reserved"
  | "too_large"
  /** A touched-files chain: a file of the folder the agent never touched (listed, not archived). */
  | "not_archived_touched_scope";

export type ExcludedItem = { path: string; type: "file" | "dir" | "symlink"; reason: ExcludedReason; size?: number; sha256?: string; mtime?: number };

/** The scan's left-out entries, by path (the first reason wins), at most MAX_EXCLUDED_LISTED. */
export class ExcludedList {
  private readonly items = new Map<string, ExcludedItem>();
  private dropped = 0;

  add(item: ExcludedItem): void {
    if (this.items.has(item.path)) {
      const known = this.items.get(item.path)!;
      if (item.sha256 && !known.sha256) this.items.set(item.path, { ...known, ...(item.size !== undefined ? { size: item.size } : {}), sha256: item.sha256 });
      return;
    }
    if (this.items.size >= MAX_EXCLUDED_LISTED) {
      this.dropped += 1;
      return;
    }
    this.items.set(item.path, item);
  }

  delete(path: string): void {
    this.items.delete(path);
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  /** How many entries were left out of the listing past MAX_EXCLUDED_LISTED. */
  get truncatedCount(): number {
    return this.dropped;
  }

  has(path: string): boolean {
    return this.items.has(path);
  }

  list(): ExcludedItem[] {
    return [...this.items.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }
}

/** OMNIRUSH_CAPTURE_V2: "1"/"true"/"on" forces v2 on, "0"/"false"/"off" off; anything else follows the server. */
export function captureV2Override(env: NodeJS.ProcessEnv = process.env): boolean | null {
  const value = (env.OMNIRUSH_CAPTURE_V2 ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(value)) return true;
  if (["0", "false", "off", "no"].includes(value)) return false;
  return null;
}

export type StateDocumentInput = {
  archiveId: string;
  kind: StateKind;
  turn: number;
  reason?: string;
  startCapture?: StartCapture;
  startCaptureMs?: number;
  repos: readonly RepoState[];
  excluded: ExcludedList;
  scrubbed: readonly string[];
  attachments: readonly AttachmentRecord[];
};

/** `__omnirush__/state.json` of a v2 archive. */
export function stateDocument(input: StateDocumentInput): Buffer {
  return Buffer.from(JSON.stringify({
    schema: STATE_SCHEMA,
    archive_id: input.archiveId,
    // `reason` only on a final state (backend spec 19.3).
    state: { kind: input.kind, turn: input.turn, ...(input.kind === "final" && input.reason ? { reason: input.reason } : {}) },
    ...(input.startCapture ? { start_capture: input.startCapture, start_capture_ms: input.startCaptureMs ?? 0 } : {}),
    repos: input.repos,
    excluded: input.excluded.list(),
    excluded_truncated: input.excluded.truncated,
    excluded_truncated_count: input.excluded.truncatedCount,
    scrubbed: [...input.scrubbed].sort(),
    attachments: input.attachments.map(attachmentStateItem),
  }), "utf8");
}
