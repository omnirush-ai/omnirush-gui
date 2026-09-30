import { randomUUID } from "node:crypto";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { sessionGoalSchema, type SessionGoal, type SessionGoalCommand } from "@omnirush/types/session-goal";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const selectionSchema = z.object({
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
  agent: z.string().optional(),
  variant: z.string().optional(),
});
type Selection = z.infer<typeof selectionSchema>;
const turnSchema = z.object({
  id: z.string(), userMessageId: z.string().nullable(), automatic: z.boolean(),
  startedAt: z.number(), activity: z.boolean(), failed: z.boolean(),
  successfulTools: z.boolean(), settled: z.boolean(),
  chargeable: z.boolean().default(true),
});
const recordSchema = z.object({
  goal: sessionGoalSchema, selection: selectionSchema, revision: z.number().int(),
  turn: turnSchema.nullable(), emptyTurns: z.number().int(), failedTurns: z.number().int(),
  blockedTurns: z.array(z.string()), messageTokens: z.record(z.string(), z.number()),
  stepMessages: z.record(z.string(), z.boolean()).default({}),
  creationMessageId: z.string().nullable().default(null), creationStepSkipped: z.boolean().default(false),
  pending: z.boolean(),
});
type GoalRecord = z.infer<typeof recordSchema>;
type GoalState = Record<string, GoalRecord>;
export type GoalEngineFactory = (config: ServerConfig, workspace: WorkspaceInfo, options: { sessionId: string }) => ReturnType<typeof createOpencodeClient> | Promise<ReturnType<typeof createOpencodeClient>>;

/** An optional native daemon cannot make an owned managed goal unavailable. */
export async function resolveNativeGoalClient(
  client: ReturnType<typeof createOpencodeClient>, sessionId: string, assertManagedOwned: () => Promise<void>,
): Promise<ReturnType<typeof createOpencodeClient> | null> {
  try {
    const result = await client.session.get({ sessionID: sessionId }, { signal: AbortSignal.timeout(1_500) });
    if (result.data) return client;
    if (result.response?.status === 404) return null;
  } catch {
    // The fallback still requires session ownership, not mere engine health.
  }
  try {
    await assertManagedOwned();
    return null;
  } catch {
    throw new ApiError(502, "opencode_request_failed", "The native engine session is unavailable");
  }
}
export type GoalPromptDispatcher = (workspace: WorkspaceInfo, sessionId: string, body: {
  messageID: string; parts: Array<{ type: "text"; text: string; synthetic: boolean }>;
  model?: { providerID: string; modelID: string }; agent?: string; variant?: string;
}, signal: AbortSignal) => Promise<Response>;
export type GoalContext = {
  goal: SessionGoal | null; goalId: string | null; turnId: string | null; revision: number | null;
  /** A child charges its work to this goal, but never adopts the ancestor's objective. */
  rootSessionId: string | null;
  chargeable: boolean;
  userMessageId: string | null;
};

const store = createWorkspaceKvStore<GoalState>({
  tableName: "session_goals", valueColumn: "state_json",
  parse: (value) => z.record(z.string(), recordSchema).parse(JSON.parse(value)),
  serialize: JSON.stringify,
});

function selectionFrom(value: unknown): Selection {
  if (!isRecord(value)) return {};
  const parsed = selectionSchema.safeParse(value);
  if (!parsed.success) return {};
  return { ...(parsed.data.model ? { model: parsed.data.model } : {}), ...(parsed.data.agent !== undefined ? { agent: parsed.data.agent } : {}), ...(parsed.data.variant !== undefined ? { variant: parsed.data.variant } : {}) };
}

/** OpenCode splits uncached input, cache writes, visible output and reasoning. */
export function goalChargedTokens(value: unknown): number {
  if (!isRecord(value)) return 0;
  const count = (number: unknown) => typeof number === "number" && Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
  const cache = isRecord(value.cache) ? value.cache : {};
  return count(value.input) + count(cache.write) + count(value.output) + count(value.reasoning);
}

function exhausted(record: GoalRecord): boolean {
  return record.goal.tokenBudget !== null && record.goal.tokensUsed >= record.goal.tokenBudget;
}

/** The server owns the durable goal and turn admission; plugins only report engine facts. */
export class SessionGoalService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly admissions = new Map<string, AbortController>();
  private readonly clocks = new Map<string, number>();
  private readonly observed = new Set<string>();
  private readonly holds = new Map<string, number>();
  private readonly trees = new Map<string, Set<string>>();
  private stopped = false;

  constructor(
    private readonly config: ServerConfig,
    private readonly engineFactory: GoalEngineFactory,
    private readonly dispatch: GoalPromptDispatcher,
  ) {}

  private key(workspace: WorkspaceInfo, sessionId: string): string { return `${workspace.id}\0${sessionId}`; }
  private async mutate<T>(workspace: WorkspaceInfo, operation: (state: GoalState) => T | Promise<T>, persist = true): Promise<T> {
    const previous = this.queues.get(workspace.id) ?? Promise.resolve();
    let release = () => {};
    const queued = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => queued, () => queued);
    this.queues.set(workspace.id, current);
    await previous.catch(() => undefined);
    try {
      const state = await store.get(this.config, workspace.id) ?? {};
      const result = await operation(state);
      if (persist) await store.set(this.config, workspace.id, state);
      return result;
    } finally {
      release();
      if (this.queues.get(workspace.id) === current) this.queues.delete(workspace.id);
    }
  }
  private snapshot(record: GoalRecord): SessionGoal {
    const since = this.clocks.get(record.goal.id);
    return { ...record.goal, timeUsedSeconds: record.goal.timeUsedSeconds + (since === undefined ? 0 : Math.max(0, Date.now() - since) / 1_000) };
  }
  private bank(record: GoalRecord, stop = false): void {
    const since = this.clocks.get(record.goal.id);
    if (since === undefined) return;
    const now = Date.now();
    record.goal.timeUsedSeconds += Math.max(0, now - since) / 1_000;
    if (stop) this.clocks.delete(record.goal.id);
    else this.clocks.set(record.goal.id, now);
  }
  private cancelTimer(workspace: WorkspaceInfo, sessionId: string): void {
    const key = this.key(workspace, sessionId);
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }
  private cancel(workspace: WorkspaceInfo, sessionId: string): void {
    const key = this.key(workspace, sessionId);
    this.cancelTimer(workspace, sessionId);
    this.admissions.get(key)?.abort();
    this.admissions.delete(key);
  }
  async read(workspace: WorkspaceInfo, sessionId: string): Promise<SessionGoal | null> {
    const record = (await store.get(this.config, workspace.id))?.[sessionId];
    return record ? this.snapshot(record) : null;
  }
  async context(workspace: WorkspaceInfo, sessionId: string, ancestors: string[]): Promise<GoalContext> {
    const state = await store.get(this.config, workspace.id) ?? {};
    const rootSessionId = [sessionId, ...ancestors].find((id) => Boolean(state[id]));
    const record = rootSessionId ? state[rootSessionId] : undefined;
    return {
      goal: record && rootSessionId === sessionId ? this.snapshot(record) : null,
      goalId: record?.goal.id ?? null, turnId: record?.turn?.id ?? null,
      revision: record?.revision ?? null, rootSessionId: rootSessionId ?? null,
      chargeable: record?.turn?.chargeable ?? true,
      userMessageId: record?.turn?.userMessageId ?? null,
    };
  }
  async command(workspace: WorkspaceInfo, sessionId: string, command: SessionGoalCommand): Promise<SessionGoal | null> {
    if (this.stopped) throw new ApiError(503, "goal_server_stopping", "The goal runner is stopping");
    if (command.action === "hold") {
      if (command.holding === undefined) throw new ApiError(400, "goal_hold_required", "holding is required");
      const holding = command.holding;
      const result = await this.mutate(workspace, (state) => {
        const record = state[sessionId];
        if (command.goalId !== undefined && record?.goal.id !== command.goalId) throw new ApiError(409, "goal_changed", "The goal has changed; read the current goal first");
        const key = this.key(workspace, sessionId);
        this.cancelTimer(workspace, sessionId);
        if (holding) this.holds.set(key, Date.now() + 30_000);
        else this.holds.delete(key);
        const parents: Array<{ sessionId: string; goalId: string }> = [];
        const prefix = `${workspace.id}\0`;
        for (const [treeKey, sessions] of this.trees) {
          if (!treeKey.startsWith(prefix) || !sessions.has(sessionId)) continue;
          const parentId = treeKey.slice(prefix.length);
          const parent = state[parentId];
          if (parentId !== sessionId && parent?.goal.status === "active" && parent.pending) {
            this.cancelTimer(workspace, parentId);
            parents.push({ sessionId: parentId, goalId: parent.goal.id });
          }
        }
        return { goal: record ? this.snapshot(record) : null, pending: record?.pending ?? false, parents };
      }, false);
      if (result.goal?.status === "active" && (holding || result.pending)) this.schedule(workspace, sessionId, result.goal.id, holding ? 30_000 : 400);
      for (const parent of result.parents) this.schedule(workspace, parent.sessionId, parent.goalId, holding ? 30_000 : 400);
      return result.goal;
    }
    const result = await this.mutate(workspace, (state) => {
      let record = state[sessionId];
      if (command.action === "select" && (!record || record.goal.status !== "active" || (command.goalId !== undefined && record.goal.id !== command.goalId))) return record ? this.snapshot(record) : null;
      if (command.action !== "set" && command.action !== "select" && command.goalId !== undefined && record?.goal.id !== command.goalId) throw new ApiError(409, "goal_changed", "The goal has changed; read the current goal first");
      this.cancel(workspace, sessionId);
      if (command.action === "clear") {
        if (record) this.bank(record, true);
        delete state[sessionId];
        return null;
      }
      if (command.action === "set") {
        if (!command.objective) throw new ApiError(400, "goal_objective_required", "A goal objective is required");
        if (record) this.bank(record, true);
        const now = Date.now();
        record = {
          goal: { id: `goal_${randomUUID()}`, sessionId, objective: command.objective, status: "active",
            tokenBudget: command.tokenBudget ?? null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: now, updatedAt: now },
          selection: { ...record?.selection, ...selectionFrom(command) }, revision: 1, turn: null, emptyTurns: 0, failedTurns: 0,
          blockedTurns: [], messageTokens: {}, stepMessages: {}, creationMessageId: null, creationStepSkipped: false, pending: true,
        };
        state[sessionId] = record;
      } else {
        if (!record) throw new ApiError(404, "goal_not_found", "No goal is set for this session");
        this.bank(record);
        record.revision += 1;
        record.selection = { ...record.selection, ...selectionFrom(command) };
        if (command.action === "edit") {
          const wasTerminal = record.goal.status === "complete" || record.goal.status === "budget_limited";
          if (command.objective !== undefined) record.goal.objective = command.objective;
          if (command.tokenBudget !== undefined) record.goal.tokenBudget = command.tokenBudget;
          if (wasTerminal) { record.goal.status = exhausted(record) ? "budget_limited" : "active"; record.pending = record.goal.status === "active"; }
          if (exhausted(record) && record.goal.status !== "complete") record.goal.status = "budget_limited";
        } else if (command.action === "pause") {
          record.goal.status = exhausted(record) ? "budget_limited" : "paused";
          record.pending = false;
        } else if (command.action === "resume") {
          record.goal.status = exhausted(record) ? "budget_limited" : "active";
          record.emptyTurns = 0; record.failedTurns = 0; record.blockedTurns = [];
          record.pending = record.goal.status === "active";
        } else if (command.action === "select") {
          if (record.goal.status === "active" && (!record.turn || record.turn.settled)) record.pending = true;
        }
        record.goal.updatedAt = Date.now();
      }
      if (record.goal.status !== "active") this.bank(record, true);
      this.observed.add(record.goal.id);
      return this.snapshot(record);
    });
    if (result?.status === "active") this.schedule(workspace, sessionId, result.id);
    return result;
  }
  async createFromTool(workspace: WorkspaceInfo, sessionId: string, objective: string, tokenBudget?: number, messageId?: string | null): Promise<SessionGoal> {
    if (this.stopped) throw new ApiError(503, "goal_server_stopping", "The goal runner is stopping");
    const selection = await this.latestSelection(workspace, sessionId);
    const baseline = messageId ? await (await this.engineFactory(this.config, workspace, { sessionId })).session.message({ sessionID: sessionId, messageID: messageId }) : null;
    const goal = await this.mutate(workspace, (state) => {
      const current = state[sessionId];
      if (current && current.goal.status !== "complete") throw new ApiError(409, "goal_unfinished", "Finish or clear the current goal before creating another");
      if (current) this.bank(current, true);
      const now = Date.now();
      const next: GoalRecord = {
        goal: { id: `goal_${randomUUID()}`, sessionId, objective, status: "active", tokenBudget: tokenBudget ?? null,
          tokensUsed: 0, timeUsedSeconds: 0, createdAt: now, updatedAt: now },
        selection, revision: 1,
        turn: { id: randomUUID(), userMessageId: baseline?.data?.info.role === "assistant" ? baseline.data.info.parentID : null, automatic: false, startedAt: now, activity: false, failed: false, successfulTools: false, settled: false, chargeable: selection.agent !== "plan" },
        emptyTurns: 0, failedTurns: 0, blockedTurns: [], messageTokens: {}, stepMessages: {}, creationMessageId: messageId ?? null, creationStepSkipped: false, pending: false,
      };
      for (const part of baseline?.data?.parts ?? []) {
        if (part.type !== "step-finish") continue;
        next.messageTokens[`step:${part.id}`] = goalChargedTokens(part.tokens);
        next.stepMessages[part.messageID] = true;
      }
      state[sessionId] = next;
      this.observed.add(next.goal.id);
      if (next.turn?.chargeable) this.clocks.set(next.goal.id, now);
      return this.snapshot(next);
    });
    this.cancel(workspace, sessionId);
    return goal;
  }
  async updateFromTool(workspace: WorkspaceInfo, sessionId: string, goalId: string, status: "paused" | "blocked" | "complete"): Promise<SessionGoal> {
    if (this.stopped) throw new ApiError(503, "goal_server_stopping", "The goal runner is stopping");
    const result = await this.mutate(workspace, (state) => {
      const record = state[sessionId];
      if (!record || record.goal.id !== goalId) throw new ApiError(409, "goal_changed", "The goal has changed; read the current goal first");
      if (exhausted(record) && status !== "complete") return this.snapshot(record);
      if (status === "blocked" && !record.turn) return null;
      if (status === "blocked" && record.turn) {
        if (!record.blockedTurns.includes(record.turn.id)) record.blockedTurns.push(record.turn.id);
        if (record.blockedTurns.length < 3) return null;
      }
      // The model can stop a goal, never reactivate it or alter its limits.
      this.bank(record, true);
      record.goal.status = status; record.goal.updatedAt = Date.now(); record.pending = false; record.revision += 1;
      return this.snapshot(record);
    });
    if (!result) throw new ApiError(409, "goal_blocked_too_early", "Try to make progress for three goal turns before marking the same impasse blocked");
    this.cancel(workspace, sessionId);
    return result;
  }
  async prompt(workspace: WorkspaceInfo, sessionId: string, messageId: string | null, selection: Selection): Promise<GoalContext> {
    let changed = false;
    let unbound = false;
    await this.mutate(workspace, (state) => {
      const record = state[sessionId];
      if (!record) return;
      this.observed.add(record.goal.id);
      if (messageId && record.turn?.userMessageId === messageId) return;
      if (record.goal.status !== "active" && record.goal.status !== "budget_limited") { unbound = true; return; }
      if (messageId && record.turn && !record.turn.settled && record.turn.userMessageId === null) { record.turn.userMessageId = messageId; return; }
      changed = true;
      record.selection = { ...record.selection, ...selectionFrom(selection) };
      this.bank(record);
      if (record.turn && !record.blockedTurns.includes(record.turn.id)) record.blockedTurns = [];
      record.turn = { id: randomUUID(), userMessageId: messageId, automatic: false, startedAt: Date.now(), activity: false, failed: false, successfulTools: false, settled: false, chargeable: record.selection.agent !== "plan" };
      record.pending = false; record.revision += 1;
      if (record.goal.status === "active" && record.turn.chargeable) this.clocks.set(record.goal.id, Date.now());
      else this.bank(record, true);
    });
    if (changed) this.cancel(workspace, sessionId);
    const current = await this.context(workspace, sessionId, []);
    return unbound ? { ...current, goalId: null, turnId: null, rootSessionId: null, chargeable: false, userMessageId: null } : current;
  }
  /** Called before forwarding user prompts, so a queued idle callback cannot win admission. */
  async userPrompt(workspace: WorkspaceInfo, sessionId: string, body: unknown): Promise<void> {
    if (!await this.read(workspace, sessionId)) return;
    await this.prompt(workspace, sessionId, isRecord(body) && typeof body.messageID === "string" ? body.messageID : null, selectionFrom(body));
  }
  async interrupt(workspace: WorkspaceInfo, sessionId: string): Promise<void> {
    const goal = await this.read(workspace, sessionId);
    if (goal && goal.status !== "complete") await this.command(workspace, sessionId, { action: "pause" });
  }
  async event(workspace: WorkspaceInfo, sessionId: string, rootSessionId: string, goalId: string, turnId: string | null, event: { type: string; properties?: Record<string, unknown> }, chargeable = true): Promise<void> {
    if (this.stopped) return;
    const idle = event.type === "session.idle" || (event.type === "session.status" && isRecord(event.properties?.status) && event.properties.status.type === "idle");
    if ((idle || event.type === "session.error") && sessionId === rootSessionId) {
      // Status events carry no message ID. Check the engine before accepting
      // an old idle/error event against a newly admitted turn.
      const result = await (await this.engineFactory(this.config, workspace, { sessionId })).session.status();
      if (!result.data || (result.data[sessionId] && result.data[sessionId].type !== "idle")) return;
    }
    let schedule = false;
    await this.mutate(workspace, (state) => {
      const record = state[rootSessionId];
      if (!record || record.goal.id !== goalId) return;
      const properties = event.properties ?? {};
      const own = sessionId === rootSessionId;
      const turn = record.turn;
      if (!turn) return;
      const currentTurn = turnId === null || turn.id === turnId;
      this.bank(record);
      if (chargeable && (!currentTurn || turn.chargeable)) this.account(record, event);
      if (!currentTurn) {
        if (exhausted(record) && record.goal.status !== "complete") { record.goal.status = "budget_limited"; record.pending = false; this.bank(record, true); }
        record.goal.updatedAt = Date.now();
        return;
      }
      if (turn.chargeable && chargeable && event.type === "message.updated" && isRecord(properties.info)) {
        const info = properties.info;
        if (info.role === "assistant" && typeof info.id === "string" && isRecord(info.time) && typeof info.time.completed === "number") {
          if (info.error) this.failure(record, info.error);
        }
      } else if (turn.chargeable && chargeable && event.type === "message.part.updated" && isRecord(properties.part)) {
        const part = properties.part;
        if (part.type === "text" && part.messageID !== turn.userMessageId && typeof part.text === "string" && part.text.trim()) turn.activity = true;
        if (part.type === "tool" && isRecord(part.state)) {
          if (part.state.status === "completed" && !["create_goal", "get_goal", "update_goal"].includes(String(part.tool))) { turn.successfulTools = true; turn.activity = true; record.failedTurns = 0; }
          if (part.state.status === "error") turn.failed = true;
        }
      } else if (turn.chargeable && chargeable && event.type === "session.error") {
        this.failure(record, properties.error);
      } else if (own && (event.type === "session.idle" || (event.type === "session.status" && isRecord(properties.status) && properties.status.type === "idle"))) {
        if (turn.settled) return;
        turn.settled = true;
        this.bank(record, true);
        record.emptyTurns = turn.automatic && !turn.activity ? record.emptyTurns + 1 : 0;
        record.failedTurns = turn.failed && !turn.successfulTools ? record.failedTurns + 1 : 0;
        if ((record.emptyTurns >= 3 || record.failedTurns >= 3) && record.goal.status === "active") record.goal.status = "blocked";
        record.pending = record.goal.status === "active";
        schedule = record.pending;
      } else if (own && turn.chargeable && event.type === "session.status" && isRecord(properties.status) && properties.status.type === "busy" && record.goal.status === "active") {
        if (!this.clocks.has(record.goal.id)) this.clocks.set(record.goal.id, Date.now());
      }
      if (exhausted(record) && record.goal.status !== "complete") { record.goal.status = "budget_limited"; record.pending = false; this.bank(record, true); }
      record.goal.updatedAt = Date.now();
    });
    if (schedule) this.schedule(workspace, rootSessionId, goalId);
  }
  private failure(record: GoalRecord, error: unknown): void {
    if (record.goal.status !== "active") return;
    const raw = isRecord(error) ? error : {};
    const data = isRecord(raw.data) ? raw.data : raw;
    const name = typeof raw.name === "string" ? raw.name : "";
    const message = typeof data.message === "string" ? data.message : "";
    if (exhausted(record)) record.goal.status = "budget_limited";
    else if (name === "MessageAbortedError") record.goal.status = "paused";
    else if (data.statusCode === 429 || /quota|usage.limit|insufficient_quota|credit.*exhaust|rate.limit/i.test(message)) record.goal.status = "usage_limited";
    else if (data.isRetryable !== true) record.goal.status = "blocked";
    if (record.turn) record.turn.failed = true;
    if (record.goal.status !== "active") { record.pending = false; this.bank(record, true); }
  }
  private charge(record: GoalRecord, key: string, tokens: unknown): void {
    const previous = record.messageTokens[key] ?? 0;
    const charged = goalChargedTokens(tokens);
    record.goal.tokensUsed += Math.max(0, charged - previous);
    record.messageTokens[key] = Math.max(previous, charged);
  }
  private account(record: GoalRecord, event: { type: string; properties?: Record<string, unknown> }): void {
    const properties = event.properties ?? {};
    const info = properties.info;
    if (event.type === "message.updated" && isRecord(info) && info.role === "assistant" && typeof info.id === "string"
      && isRecord(info.time) && typeof info.time.completed === "number") {
      if (!record.stepMessages[info.id] && info.id !== record.creationMessageId) this.charge(record, `message:${info.id}`, info.tokens);
    }
    const part = properties.part;
    if (event.type !== "message.part.updated" || !isRecord(part) || part.type !== "step-finish"
      || typeof part.id !== "string" || typeof part.messageID !== "string") return;
    // Message summaries contain only the last step. Each finish part owns
    // its usage; a late part replaces its summary fallback once.
    const summaryKey = `message:${part.messageID}`;
    record.goal.tokensUsed -= record.messageTokens[summaryKey] ?? 0;
    delete record.messageTokens[summaryKey];
    record.stepMessages[part.messageID] = true;
    const stepKey = `step:${part.id}`;
    if (part.messageID === record.creationMessageId && !record.creationStepSkipped && record.messageTokens[stepKey] === undefined) {
      record.creationStepSkipped = true; record.messageTokens[stepKey] = goalChargedTokens(part.tokens);
    } else this.charge(record, stepKey, part.tokens);
  }
  private holdDelay(key: string): number {
    const until = this.holds.get(key);
    if (until === undefined) return 0;
    const delay = until - Date.now();
    if (delay > 0) return delay;
    this.holds.delete(key); return 0;
  }
  private treeHoldDelay(workspace: WorkspaceInfo, sessionId: string): number {
    const sessions = this.trees.get(this.key(workspace, sessionId)) ?? new Set([sessionId]);
    return Math.max(0, ...[...sessions].map((id) => this.holdDelay(this.key(workspace, id))));
  }
  /** Reconnect a persisted active goal once its existing engine work settles. */
  async recover(workspace: WorkspaceInfo, sessionId: string): Promise<void> {
    if (this.stopped || this.config.readOnly) return;
    const record = (await store.get(this.config, workspace.id))?.[sessionId];
    if (!record || record.goal.status !== "active" || record.selection.agent === "plan" || this.observed.has(record.goal.id)) return;
    if (!await this.canRun(workspace, sessionId)) return;
    if (this.observed.has(record.goal.id)) return;
    // Claim recovery before any network read. Concurrent polling cannot admit
    // two recovery turns, and normal commands still guard the durable ID.
    this.observed.add(record.goal.id);
    try {
      if (record.turn && !record.turn.settled) {
        const messages = await (await this.engineFactory(this.config, workspace, { sessionId })).session.messages({ sessionID: sessionId });
        if (!messages.data) { this.observed.delete(record.goal.id); return; }
        let current = false;
        for (const message of messages.data) {
          if (message.info.id === record.turn.userMessageId || message.info.id === record.creationMessageId
            || (record.turn.userMessageId === null && message.info.time.created >= record.turn.startedAt)) current = true;
          if (!current || message.info.role !== "assistant") continue;
          const shutdownAbort = message.info.error?.name === "MessageAbortedError";
          for (const part of message.parts) {
            if (!["step-finish", "tool", "text"].includes(part.type)) continue;
            if (shutdownAbort && part.type === "tool" && part.state.status === "error") continue;
            await this.event(workspace, sessionId, sessionId, record.goal.id, record.turn.id, { type: "message.part.updated", properties: { part } });
          }
          // Explicit Stop is persisted as paused before the engine aborts.
          // An active record interrupted by engine shutdown keeps its goal.
          const info = shutdownAbort ? { ...message.info, error: undefined } : message.info;
          await this.event(workspace, sessionId, sessionId, record.goal.id, record.turn.id, { type: "message.updated", properties: { info } });
        }
        await this.event(workspace, sessionId, sessionId, record.goal.id, record.turn.id, { type: "session.idle" });
      } else {
        await this.mutate(workspace, (state) => {
          const latest = state[sessionId];
          if (latest?.goal.id === record.goal.id && latest.goal.status === "active") latest.pending = true;
        });
        this.schedule(workspace, sessionId, record.goal.id);
      }
    } catch (error) {
      this.observed.delete(record.goal.id);
      throw error;
    }
  }
  private schedule(workspace: WorkspaceInfo, sessionId: string, goalId: string, delay = 400): void {
    const key = this.key(workspace, sessionId);
    if (this.stopped || this.config.readOnly || this.timers.has(key)) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.continue(workspace, sessionId, goalId).catch(() => this.schedule(workspace, sessionId, goalId, 2_000));
    }, delay);
    timer.unref?.(); this.timers.set(key, timer);
  }
  private async canRun(workspace: WorkspaceInfo, sessionId: string): Promise<boolean> {
    const client = await this.engineFactory(this.config, workspace, { sessionId });
    const results = await Promise.all([client.session.status(), client.permission.list(), client.question.list()]);
    const [statuses, permissions, questions] = results;
    if (!statuses.data || !permissions.data || !questions.data) return false;
    const sessions = new Set([sessionId]);
    let layer = [sessionId];
    for (let depth = 0; depth < 4 && layer.length; depth += 1) {
      const children = await Promise.all(layer.map((id) => client.session.children({ sessionID: id })));
      if (children.some((result) => result.data === undefined)) return false;
      layer = children.flatMap((result) => result.data ?? []).filter((session) => !sessions.has(session.id)).map((session) => session.id);
      for (const id of layer) sessions.add(id);
    }
    const key = this.key(workspace, sessionId);
    this.trees.delete(key); this.trees.set(key, sessions);
    while (this.trees.size > 512) {
      const oldest = this.trees.keys().next().value;
      if (oldest === undefined) break;
      this.trees.delete(oldest);
    }
    if (this.treeHoldDelay(workspace, sessionId)) return false;
    return [...sessions].every((id) => !statuses.data[id] || statuses.data[id].type === "idle")
      && ![...permissions.data, ...questions.data].some((item) => sessions.has(item.sessionID));
  }
  private async latestSelection(workspace: WorkspaceInfo, sessionId: string): Promise<Selection> {
    const result = await (await this.engineFactory(this.config, workspace, { sessionId })).session.messages({ sessionID: sessionId, limit: 20 });
    for (const message of [...(result.data ?? [])].reverse()) {
      const info: unknown = message.info;
      if (isRecord(info) && info.role === "user") {
        const model = isRecord(info.model) ? info.model : {};
        const variant = typeof info.variant === "string" ? info.variant : typeof model.variant === "string" ? model.variant : undefined;
        return selectionFrom({ ...info, variant });
      }
    }
    return {};
  }
  private async continue(workspace: WorkspaceInfo, sessionId: string, goalId: string): Promise<void> {
    if (this.stopped) return;
    const key = this.key(workspace, sessionId);
    const before = (await store.get(this.config, workspace.id))?.[sessionId];
    if (!before || before.goal.id !== goalId || before.goal.status !== "active" || !before.pending || before.selection.agent === "plan") return;
    const held = this.treeHoldDelay(workspace, sessionId);
    if (held) { this.schedule(workspace, sessionId, goalId, held); return; }
    const revision = before.revision;
    const selection = { ...await this.latestSelection(workspace, sessionId), ...before.selection };
    if (selection.agent === "plan") return;
    if (!await this.canRun(workspace, sessionId)) { this.schedule(workspace, sessionId, goalId, 1_000); return; }
    const admitted = await this.mutate(workspace, (state) => {
      const record = state[sessionId];
      if (this.stopped || !record || record.goal.id !== goalId || record.revision !== revision || record.goal.status !== "active" || !record.pending || record.selection.agent === "plan") return null;
      if (this.treeHoldDelay(workspace, sessionId)) return null;
      if (exhausted(record)) { record.goal.status = "budget_limited"; record.pending = false; return null; }
      record.selection = selection;
      if (record.turn && !record.blockedTurns.includes(record.turn.id)) record.blockedTurns = [];
      const id = `msg_${Date.now().toString(16)}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      record.turn = { id: randomUUID(), userMessageId: id, automatic: true, startedAt: Date.now(), activity: false, failed: false, successfulTools: false, settled: false, chargeable: true };
      record.pending = false; record.revision += 1;
      this.clocks.set(goalId, Date.now());
      const controller = new AbortController();
      this.admissions.set(key, controller);
      return { ...record.selection, messageID: id, turnId: record.turn.id, controller };
    });
    if (!admitted || this.stopped) {
      const held = this.treeHoldDelay(workspace, sessionId);
      if (held) this.schedule(workspace, sessionId, goalId, held);
      return;
    }
    const controller = admitted.controller;
    if (controller.signal.aborted) return;
    try {
      const response = await this.dispatch(workspace, sessionId, {
        messageID: admitted.messageID, model: admitted.model, agent: admitted.agent, variant: admitted.variant,
        parts: [{ type: "text", synthetic: true, text: "Continue working toward the active session goal. Check it with get_goal. Finish all required work before calling update_goal with status complete. Use the current goal budget and stop status." }],
      }, controller.signal);
      if (!response.ok) {
        await this.event(workspace, sessionId, sessionId, goalId, admitted.turnId, {
          type: "session.error", properties: { error: { name: "APIError", data: { statusCode: response.status, isRetryable: response.status >= 500, message: "Goal prompt could not start" } } },
        });
        await this.event(workspace, sessionId, sessionId, goalId, admitted.turnId, { type: "session.idle" });
      }
      await response.body?.cancel();
    } catch (error) {
      if (!controller.signal.aborted) {
        await this.event(workspace, sessionId, sessionId, goalId, admitted.turnId, { type: "session.error", properties: { error: { name: "APIError", data: { isRetryable: true } } } });
        await this.event(workspace, sessionId, sessionId, goalId, admitted.turnId, { type: "session.idle" });
      }
    } finally {
      if (this.admissions.get(key) === controller) this.admissions.delete(key);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.admissions.values()) controller.abort();
    this.admissions.clear();
    this.holds.clear();
    this.trees.clear();
    if (!this.config.readOnly) for (const workspace of this.config.workspaces) await this.mutate(workspace, (state) => { for (const record of Object.values(state)) this.bank(record, true); });
    this.clocks.clear();
  }
}
