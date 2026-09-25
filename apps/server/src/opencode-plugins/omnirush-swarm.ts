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
 * Sub-agent model and effort: every prompt of a sub-agent session (any
 * layer) is resolved against the app's sub-agent setting by the OmniRush.ai
 * server (POST /omnirush/subagent-model/resolve, omnirush-subagent-model.ts)
 * before the engine saves it, so the sub-agent runs on, and its messages
 * record, the picked model and effort. The main session keeps its own. When
 * the picked model cannot be used the server answers with the main model,
 * and the plugin notes that on the sub-agent session's title and in the task
 * result; its model requests carry the main model for the gateway broker to
 * fall back to if the gateway refuses the picked one mid-task. Without the
 * server (or with the setting untouched) prompts stay exactly as the engine
 * made them.
 *
 * Session parents come from `session.created` / `session.updated` events,
 * falling back to one engine read per unknown session. Everything is kept in
 * bounded maps; nothing is persisted.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  OMNIRUSH_SUBAGENT_DEPTH,
  SUBAGENT_FALLBACK_EFFORT_HEADER,
  SUBAGENT_FALLBACK_MODEL_HEADER,
  SUBAGENT_ROOT_SESSION_HEADER,
  OMNIRUSH_SWARM_FILE,
  OMNIRUSH_SWARM_MAX_PER_TURN,
  OMNIRUSH_SWARM_MAX_RUNNING,
  omnirushSwarmSubagentNote,
} from "../omnirush-swarm.js";

type SessionInfo = { id?: unknown; parentID?: unknown; title?: unknown };
type EngineEvent = { type?: string; properties?: Record<string, unknown> };
type SwarmClient = {
  session?: {
    get?: (input: { path: { id: string } }) => Promise<{ data?: SessionInfo } | undefined>;
    update?: (input: { path: { id: string }; body: { title: string } }) => Promise<unknown>;
  };
};
type ModelChoice = { providerID: string; modelID: string; variant?: string | null };
/** The prompt's user message as the engine is about to save it. */
type PromptMessage = { model?: { providerID?: unknown; modelID?: unknown; variant?: unknown } };
type Resolution = {
  model?: { providerID: string; modelID: string };
  variant?: string | null;
  fallback?: { requested: string; requestedName: string; used: string; usedName: string; reason: string };
  gatewayFallback?: { model: string; effort: string | null };
};
type Override = { model: string; fallbackModel: string | null; fallbackEffort: string | null; root: string };
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
const RESOLVE_TIMEOUT_MS = 5_000;
const MAX_TITLE_CHARS = 240;

function serverBase(): string | null {
  const base = String(process.env.OMNIRUSH_SERVER_URL || "").trim().replace(/\/+$/, "");
  return base || null;
}

function serverToken(): string | null {
  const token = String(process.env.OMNIRUSH_POLICY_TOKEN || process.env.OMNIRUSH_SERVER_TOKEN || "").trim();
  return token || null;
}

async function serverJson(path: string, body?: unknown): Promise<unknown> {
  const base = serverBase();
  const token = serverToken();
  if (!base || !token) return null;
  try {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

function modelChoice(value: unknown): ModelChoice | null {
  if (!record(value)) return null;
  const providerID = typeof value.providerID === "string" ? value.providerID : "";
  const modelID = typeof value.modelID === "string" ? value.modelID : "";
  if (!providerID || !modelID) return null;
  return { providerID, modelID, variant: typeof value.variant === "string" && value.variant ? value.variant : null };
}

function resolution(value: unknown): Resolution | null {
  if (!record(value) || !record(value.model)) return null;
  const model = modelChoice(value.model);
  if (!model) return null;
  const result: Resolution = {
    model: { providerID: model.providerID, modelID: model.modelID },
    variant: typeof value.variant === "string" && value.variant ? value.variant : null,
  };
  const fallback = value.fallback;
  if (record(fallback) && typeof fallback.requested === "string" && typeof fallback.used === "string") {
    result.fallback = {
      requested: fallback.requested,
      requestedName: typeof fallback.requestedName === "string" ? fallback.requestedName : fallback.requested,
      used: fallback.used,
      usedName: typeof fallback.usedName === "string" ? fallback.usedName : fallback.used,
      reason: typeof fallback.reason === "string" ? fallback.reason : "unavailable",
    };
  }
  const gateway = value.gatewayFallback;
  if (record(gateway) && typeof gateway.model === "string" && gateway.model) {
    result.gatewayFallback = { model: gateway.model, effort: typeof gateway.effort === "string" && gateway.effort ? gateway.effort : null };
  }
  return result;
}

function fallbackNote(fallback: { requestedName: string; usedName: string; reason: string }): string {
  const why = fallback.reason === "not_in_catalog"
    ? "is not available to this account"
    : fallback.reason === "signed_out"
      ? "needs an omnirush.ai account"
      : "was refused by omnirush.ai";
  return `ran on ${fallback.usedName}: ${fallback.requestedName} ${why}`;
}

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
  /** Main session id -> the model and effort of its latest prompt (the sub-agents' fallback). */
  const mainModels = new Map<string, ModelChoice>();
  /** Sub-agent session id -> the picked model it runs on and the main model to fall back to. */
  const overrides = new Map<string, Override>();
  /** Sub-agent session id -> the model it really runs on and why it is not the picked one. */
  const notes = new Map<string, { model: ModelChoice; fallback: Resolution["fallback"] | null; at: number }>();
  /** Sub-agent sessions whose title already carries the fallback note. */
  const titled = new Set<string>();

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

  /** Appends the fallback note to a sub-agent session's title, once. */
  const noteOnTitle = async (sessionId: string, note: string) => {
    if (titled.has(sessionId)) return;
    titled.add(sessionId);
    if (titled.size > MAX_TRACKED_SESSIONS) titled.delete(titled.values().next().value as string);
    try {
      const current = await input?.client?.session?.get?.({ path: { id: sessionId } });
      const title = typeof current?.data?.title === "string" ? current.data.title : "";
      if (title.includes(note)) return;
      const next = (title ? `${title} · ${note}` : note).slice(0, MAX_TITLE_CHARS);
      await input?.client?.session?.update?.({ path: { id: sessionId }, body: { title: next } });
    } catch {
      // Best effort: the task result carries the note too.
    }
  };

  /** Puts the sub-agent setting's model and effort on a sub-agent prompt before the engine saves it. */
  const chooseSubagentModel = async (sessionId: string, message: PromptMessage | undefined, fallbackModel: ModelChoice | null) => {
    if (!message || !serverBase() || !serverToken()) return;
    const inherited = modelChoice(message.model) ?? fallbackModel;
    if (!inherited) return;
    const { root } = await locate(sessionId);
    const answer = resolution(await serverJson("/omnirush/subagent-model/resolve", {
      sessionId,
      rootSessionId: root,
      inherited,
      main: mainModels.get(root) ?? null,
    }));
    if (!answer?.model) {
      overrides.delete(sessionId);
      return;
    }
    const chosen: { providerID: string; modelID: string; variant?: string } = {
      providerID: answer.model.providerID,
      modelID: answer.model.modelID,
      ...(answer.variant ? { variant: answer.variant } : {}),
    };
    message.model = chosen;
    remember(notes, sessionId, { model: { ...chosen, variant: answer.variant ?? null }, fallback: answer.fallback ?? null, at: Date.now() }, MAX_TRACKED_SESSIONS);
    if (answer.gatewayFallback) {
      remember(overrides, sessionId, {
        model: answer.model.modelID,
        fallbackModel: answer.gatewayFallback.model,
        fallbackEffort: answer.gatewayFallback.effort,
        root,
      }, MAX_TRACKED_SESSIONS);
    } else {
      overrides.delete(sessionId);
    }
    if (answer.fallback) await noteOnTitle(sessionId, fallbackNote(answer.fallback));
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
            mainModels.delete(properties.info.id);
            overrides.delete(properties.info.id);
            notes.delete(properties.info.id);
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

    // A prompt to a main session opens a new turn: its start budget refills,
    // and its model and effort become its sub-agents' fallback. A prompt to
    // a sub-agent session gets the sub-agent model and effort.
    "chat.message": async (
      message: { sessionID: string; model?: { providerID?: string; modelID?: string }; variant?: string },
      output?: { message?: PromptMessage },
    ) => {
      if (typeof message?.sessionID !== "string") return;
      const inputModel = modelChoice({ ...message.model, variant: message.variant });
      if ((await parentOf(message.sessionID)) !== null) {
        await chooseSubagentModel(message.sessionID, output?.message, inputModel);
        return;
      }
      const tree = trees.get(message.sessionID);
      if (tree) tree.started = 0;
      const main = modelChoice(output?.message?.model) ?? inputModel;
      if (main) remember(mainModels, message.sessionID, main, MAX_TRACKED_TREES);
    },

    // A sub-agent on a picked model names the main model for the gateway
    // broker's fallback (the broker consumes these headers).
    "chat.headers": async (
      request: { sessionID?: string; model?: { id?: string; providerID?: string } },
      output: { headers: Record<string, string> },
    ) => {
      if (typeof request?.sessionID !== "string" || !output?.headers) return;
      const override = overrides.get(request.sessionID);
      if (!override?.fallbackModel || request.model?.providerID !== "omnirush" || request.model.id !== override.model) return;
      output.headers[SUBAGENT_FALLBACK_MODEL_HEADER] = override.fallbackModel;
      if (override.fallbackEffort) output.headers[SUBAGENT_FALLBACK_EFFORT_HEADER] = override.fallbackEffort;
      output.headers[SUBAGENT_ROOT_SESSION_HEADER] = override.root;
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

    // A finished task names the model its sub-agent ran on, and says so in
    // the result when that is the main model instead of the picked one.
    "tool.execute.after": async (call: { tool: string; callID: string }, output?: { output?: unknown; metadata?: unknown }) => {
      if (call?.tool !== "task") return;
      finish(call.callID);
      const metadata = record(output?.metadata) ? output.metadata : null;
      const child = metadata && typeof metadata.sessionId === "string" ? metadata.sessionId : null;
      if (!child || !metadata) return;
      const note = notes.get(child);
      if (!note) return;
      metadata.model = { providerID: note.model.providerID, modelID: note.model.modelID };
      if (note.model.variant) metadata.variant = note.model.variant;
      let fallback: { requested: string; requestedName: string; used: string; usedName: string; reason: string } | null = note.fallback ?? null;
      if (!fallback && overrides.has(child)) {
        const answer = await serverJson(`/omnirush/subagent-model/fallbacks?session=${encodeURIComponent(child)}`);
        // Only this run's fallbacks: a resumed task keeps its session and its earlier ones.
        const events = record(answer) && Array.isArray(answer.fallbacks)
          ? answer.fallbacks.filter(record).filter((event) => typeof event.at !== "number" || event.at >= note.at - 1_000)
          : [];
        const last = events.at(-1);
        if (last && typeof last.requested_model === "string" && typeof last.used_model === "string") {
          fallback = {
            requested: last.requested_model,
            requestedName: typeof last.requested_name === "string" ? last.requested_name : last.requested_model,
            used: last.used_model,
            usedName: typeof last.used_name === "string" ? last.used_name : last.used_model,
            reason: "refused",
          };
          metadata.model = { providerID: "omnirush", modelID: last.used_model };
          await noteOnTitle(child, fallbackNote(fallback));
        }
      }
      if (!fallback) return;
      metadata.omnirushModelFallback = { requested: fallback.requested, used: fallback.used, reason: fallback.reason };
      if (typeof output?.output === "string") {
        output.output = `${output.output}\n\n(omnirush.ai: this sub-agent ${fallbackNote(fallback)}.)`;
      }
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
