/**
 * OmniRush.ai Swarm Plugin
 *
 * The injected engine config lets sub-agents delegate again
 * (`subagent_depth`, see omnirush-swarm.ts). The engine itself runs any
 * number of task calls at once, so this plugin bounds the fan-out of one
 * main session's sub-agent tree:
 *
 *   - at most OMNIRUSH_SWARM_MAX_RUNNING sub-agents of the tree run at once;
 *   - at most OMNIRUSH_SWARM_MAX_PER_TURN start during one main-session turn.
 *
 * A task call over a limit fails before it creates a session, with a message
 * telling the model to do the work itself. It also reminds sub-agent
 * sessions of the `swarm.md` board while that file exists, so every layer
 * reads and updates it.
 *
 * Session parents come from `session.created` / `session.updated` events,
 * falling back to one engine read per unknown session. Everything is kept in
 * bounded maps; nothing is persisted.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  OMNIRUSH_SUBAGENT_DEPTH,
  OMNIRUSH_SWARM_FILE,
  OMNIRUSH_SWARM_MAX_PER_TURN,
  OMNIRUSH_SWARM_MAX_RUNNING,
  omnirushSwarmSubagentNote,
} from "../omnirush-swarm.js";

type SessionInfo = { id?: unknown; parentID?: unknown };
type EngineEvent = { type?: string; properties?: Record<string, unknown> };
type SwarmClient = {
  session?: { get?: (input: { path: { id: string } }) => Promise<{ data?: SessionInfo } | undefined> };
};
type Tree = {
  /** Running task calls: call id -> start time. */
  running: Map<string, number>;
  /** Task calls started in the current main-session turn. */
  started: number;
};

const MAX_TRACKED_SESSIONS = 4096;
const MAX_TRACKED_TREES = 512;
/** A task call never reported finished stops counting as running after this long. */
const STALE_RUNNING_MS = 3 * 60 * 60_000;
const MAX_PARENT_HOPS = 32;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

// Only export the factory: the engine treats every export as a plugin.
export const OmniRushSwarm = async (input?: { client?: SwarmClient; directory?: string }) => {
  /** Session id -> parent id (null for a main session). */
  const parents = new Map<string, string | null>();
  /** Main session id -> its sub-agent tree. */
  const trees = new Map<string, Tree>();
  /** Task call id -> main session id, to find the tree when the call ends. */
  const calls = new Map<string, string>();

  const learn = (info: unknown) => {
    if (!record(info) || typeof info.id !== "string" || !info.id) return;
    const parent = typeof info.parentID === "string" && info.parentID ? info.parentID : null;
    remember(parents, info.id, parent, MAX_TRACKED_SESSIONS);
  };

  const parentOf = async (sessionId: string): Promise<string | null> => {
    const known = parents.get(sessionId);
    if (known !== undefined) return known;
    try {
      const response = await input?.client?.session?.get?.({ path: { id: sessionId } });
      const parent = typeof response?.data?.parentID === "string" && response.data.parentID ? response.data.parentID : null;
      remember(parents, sessionId, parent, MAX_TRACKED_SESSIONS);
      return parent;
    } catch {
      // Unknown: counted as a main session, never cached, so a later read can fix it.
      return null;
    }
  };

  /** The main session above `sessionId` and how many sub-agent layers down it is. */
  const locate = async (sessionId: string): Promise<{ root: string; depth: number }> => {
    let root = sessionId;
    let depth = 0;
    const seen = new Set([sessionId]);
    for (let hop = 0; hop < MAX_PARENT_HOPS; hop += 1) {
      const parent = await parentOf(root);
      if (!parent || seen.has(parent)) break;
      seen.add(parent);
      root = parent;
      depth += 1;
    }
    return { root, depth };
  };

  const treeOf = (root: string): Tree => {
    const existing = trees.get(root);
    if (existing) return existing;
    const tree: Tree = { running: new Map(), started: 0 };
    remember(trees, root, tree, MAX_TRACKED_TREES);
    return tree;
  };

  const finish = (callId: unknown) => {
    if (typeof callId !== "string") return;
    const root = calls.get(callId);
    if (root === undefined) return;
    calls.delete(callId);
    trees.get(root)?.running.delete(callId);
  };

  return {
    event: async ({ event }: { event: EngineEvent }) => {
      const properties = record(event?.properties) ? event.properties : {};
      switch (event?.type) {
        case "session.created":
        case "session.updated":
          learn(properties.info);
          return;
        case "session.deleted":
          if (record(properties.info) && typeof properties.info.id === "string") {
            parents.delete(properties.info.id);
            trees.delete(properties.info.id);
          }
          return;
        case "message.part.updated": {
          const part = properties.part;
          if (!record(part) || part.type !== "tool" || part.tool !== "task") return;
          const status = record(part.state) ? part.state.status : undefined;
          if (status === "completed" || status === "error") finish(part.callID);
          return;
        }
        case "session.status": {
          // A main session that went idle has no running sub-agents left.
          const status = record(properties.status) ? properties.status.type : undefined;
          if (status !== "idle" || typeof properties.sessionID !== "string") return;
          const tree = trees.get(properties.sessionID);
          if (!tree) return;
          for (const callId of tree.running.keys()) calls.delete(callId);
          tree.running.clear();
          return;
        }
      }
    },

    // A prompt to a main session opens a new turn: its start budget refills.
    "chat.message": async (message: { sessionID: string }) => {
      if (typeof message?.sessionID !== "string") return;
      if ((await parentOf(message.sessionID)) !== null) return;
      const tree = trees.get(message.sessionID);
      if (tree) tree.started = 0;
    },

    "tool.execute.before": async (call: { tool: string; sessionID: string; callID: string }) => {
      if (call?.tool !== "task" || typeof call.sessionID !== "string") return;
      const { root } = await locate(call.sessionID);
      const tree = treeOf(root);
      const now = Date.now();
      for (const [callId, startedAt] of tree.running) {
        if (now - startedAt > STALE_RUNNING_MS) {
          tree.running.delete(callId);
          calls.delete(callId);
        }
      }
      if (tree.running.size >= OMNIRUSH_SWARM_MAX_RUNNING) {
        throw new Error(
          `Sub-agent limit reached: ${OMNIRUSH_SWARM_MAX_RUNNING} sub-agents of this session are already running. `
          + "Do not retry this call now: do this part yourself, or wait until a running sub-agent has finished.",
        );
      }
      if (tree.started >= OMNIRUSH_SWARM_MAX_PER_TURN) {
        throw new Error(
          `Sub-agent limit reached: this turn already started ${OMNIRUSH_SWARM_MAX_PER_TURN} sub-agents. `
          + "Do not retry: do the remaining work yourself.",
        );
      }
      tree.started += 1;
      if (typeof call.callID === "string" && call.callID) {
        tree.running.set(call.callID, now);
        remember(calls, call.callID, root, MAX_TRACKED_SESSIONS);
      }
    },

    "tool.execute.after": async (call: { tool: string; callID: string }) => {
      if (call?.tool === "task") finish(call.callID);
    },

    "experimental.chat.system.transform": async (request: { sessionID?: string }, output: { system: string[] }) => {
      const directory = input?.directory;
      if (!directory || typeof request?.sessionID !== "string" || !Array.isArray(output?.system)) return;
      if ((await parentOf(request.sessionID)) === null) return;
      if (!existsSync(join(directory, OMNIRUSH_SWARM_FILE))) return;
      const { depth } = await locate(request.sessionID);
      output.system.push(omnirushSwarmSubagentNote(Math.min(Math.max(depth, 1), OMNIRUSH_SUBAGENT_DEPTH)));
    },
  };
};
