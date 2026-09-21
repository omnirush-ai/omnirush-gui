import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { omnirushServerDataDir } from "@omnirush/paths";
import type { LocalAvailableModel, LocalModelRef, LocalRouteCategory, LocalRouteDecision, LocalRoutingSettings, LocalWorkflow, LocalWorkflowInput, LocalWorkflowRun, LocalWorkflowRunStep, LocalWorkflowState, LocalWorkflowsSnapshot } from "@omnirush/types/local-workflows";
import { localWorkflowInputSchema, localWorkflowStateSchema } from "@omnirush/types/local-workflows";
import { ApiError } from "./errors.js";
import { recordAudit } from "./audit.js";
import type { Actor, ServerConfig, WorkspaceInfo } from "./types.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

type Engine = ReturnType<typeof createOpencodeClient>;
type EngineFactory = (config: ServerConfig, workspace: WorkspaceInfo, options?: { sessionId?: string }) => Engine;
type ActiveRun = {
  runId: string; workflowId: string; workspace: WorkspaceInfo;
  controller: AbortController; actor: Actor; sessionId?: string;
  stoppedAs?: "cancelled" | "interrupted"; done: Promise<void>;
};
type SafeRecord = Record<string, unknown>;
const categories: LocalRouteCategory[] = ["general", "coding", "writing", "analysis"];
const emptyState = (): LocalWorkflowState => ({ schemaVersion: 1, routing: { enabled: true, defaultModel: null, categories: {} }, workflows: [], runs: [] });
const isRecord = (value: unknown): value is SafeRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const redact = (value: string) => value.replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
  .replace(/\b[a-f0-9]{32}\.[A-Za-z0-9]{12,}\b/gi, "[REDACTED]")
  .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
  .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
const safeError = (error: unknown): string => {
  if (error instanceof Error) return redact(error.message).slice(0, 1000);
  if (isRecord(error) && isRecord(error.data) && typeof error.data.message === "string") return redact(error.data.message).slice(0, 1000);
  if (isRecord(error) && typeof error.message === "string") return redact(error.message).slice(0, 1000);
  return "The engine request failed. Open the task for details.";
};
function modelKey(model: LocalModelRef): string { return `${model.providerID}\0${model.modelID}`; }

export class LocalWorkflowService {
  private readonly cache = new Map<string, LocalWorkflowState>();
  private readonly loading = new Map<string, Promise<LocalWorkflowState>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly modelCache = new Map<string, { at: number; value: { models: LocalAvailableModel[]; error: string | null } }>();
  private scheduler: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private ticking = false;
  constructor(private readonly config: ServerConfig, private readonly engineFactory: EngineFactory) {}

  start(): void {
    if (this.config.readOnly || this.stopped || this.scheduler) return;
    this.scheduler = setInterval(() => { void this.tick(); }, 10_000);
    this.scheduler.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = undefined;
    const active = [...this.active.values()];
    for (const run of active) {
      run.stoppedAs = "interrupted";
      run.controller.abort(new Error("Local server stopped during this run"));
    }
    await Promise.all(active.map(async (run) => { await this.abortSession(run); await run.done; }));
  }
  private writable(): void {
    if (this.config.readOnly) throw new ApiError(403, "read_only", "Server is read-only");
    if (this.stopped) throw new ApiError(503, "workflow_server_stopping", "Local workflow server is stopping");
  }
  private path(workspace: WorkspaceInfo): string {
    const key = createHash("sha256").update(`${this.config.configPath ?? "local"}\0${workspace.id}\0${workspace.path}`).digest("hex");
    return join(omnirushServerDataDir(), "local-workflows", `${key}.json`);
  }
  private load(workspace: WorkspaceInfo): Promise<LocalWorkflowState> {
    const cached = this.cache.get(workspace.id); if (cached) return Promise.resolve(cached);
    const pending = this.loading.get(workspace.id); if (pending) return pending;
    const promise = this.readState(workspace).finally(() => this.loading.delete(workspace.id));
    this.loading.set(workspace.id, promise);
    return promise;
  }
  private async readState(workspace: WorkspaceInfo): Promise<LocalWorkflowState> {
    let state = emptyState();
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path(workspace), "utf8"));
      state = localWorkflowStateSchema.parse(parsed);
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) throw new ApiError(500, "workflow_state_invalid", "Saved workflow state could not be read");
    }
    const interrupted = state.runs.filter((run) => run.status === "running");
    for (const run of interrupted) this.markFinished(run, "interrupted", "Server restarted while this run was active");
    if (interrupted.length && !this.config.readOnly) {
      await this.persist(workspace, state);
      for (const run of interrupted) await this.audit(workspace, "run.interrupted", run.id, "Workflow run interrupted by server restart");
    }
    this.cache.set(workspace.id, state); return state;
  }
  private async persist(workspace: WorkspaceInfo, state: LocalWorkflowState): Promise<void> {
    const path = this.path(workspace); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 }); await rename(temporary, path);
  }
  private async mutate<T>(workspace: WorkspaceInfo, fn: (state: LocalWorkflowState) => T): Promise<T> {
    const prior = this.queues.get(workspace.id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(async () => {
      const state = structuredClone(await this.load(workspace));
      const result = fn(state);
      await this.persist(workspace, state);
      this.cache.set(workspace.id, state);
      return structuredClone(result);
    });
    this.queues.set(workspace.id, next.then(() => undefined, () => undefined)); return next;
  }
  private async models(workspace: WorkspaceInfo, fresh = false): Promise<{ models: LocalAvailableModel[]; error: string | null }> {
    const cached = this.modelCache.get(workspace.id);
    if (!fresh && cached && Date.now() - cached.at < 15_000) return cached.value;
    try {
      const result = await this.engineFactory(this.config, workspace).provider.list({}, { signal: AbortSignal.timeout(10_000) });
      if (result.error || !result.data) throw new Error("Model catalog unavailable");
      const all = result.data.all;
      const connected = new Set(result.data.connected); const output: LocalAvailableModel[] = [];
      for (const provider of all) if (connected.has(provider.id)) for (const [modelID, model] of Object.entries(provider.models ?? {})) output.push({ providerID: provider.id, modelID, name: typeof model.name === "string" ? model.name : modelID, providerName: provider.name });
      const value = { models: output.sort((a, b) => `${a.providerName}${a.modelID}`.localeCompare(`${b.providerName}${b.modelID}`)), error: null };
      this.modelCache.set(workspace.id, { at: Date.now(), value });
      return value;
    } catch { const value = { models: [], error: "Connected models are temporarily unavailable" }; this.modelCache.set(workspace.id, { at: Date.now(), value }); return value; }
  }
  async snapshot(workspace: WorkspaceInfo): Promise<LocalWorkflowsSnapshot> {
    const state = await this.load(workspace); const catalog = await this.models(workspace);
    return {
      routing: structuredClone(state.routing), workflows: structuredClone(state.workflows), runs: structuredClone(state.runs),
      models: catalog.models, modelsError: catalog.error,
      scheduler: { active: Boolean(this.scheduler), description: this.config.readOnly ? "Schedules are disabled on this read-only server." : "Schedules run while the local OmniRush.ai server is running (minimum interval: 1 minute). Runs stop after 10 minutes." },
    };
  }
  async route(workspace: WorkspaceInfo, prompt: string, category?: LocalRouteCategory | "auto", explicit?: LocalModelRef | null): Promise<LocalRouteDecision> {
    const state = await this.load(workspace);
    const catalog = await this.models(workspace, true);
    const inferred: LocalRouteCategory = category && category !== "auto" ? category : /\b(code|coding|bug|implement|typescript|function|api)\b/i.test(prompt) ? "coding" : /\b(write|writing|draft|email|copy)\b/i.test(prompt) ? "writing" : /\b(analysis|analy[sz]e|compare|research|why)\b/i.test(prompt) ? "analysis" : "general";
    const model = explicit ?? (state.routing.enabled ? state.routing.categories[inferred] ?? state.routing.defaultModel : state.routing.defaultModel);
    if (!model) throw new ApiError(400, "no_model_configured", "Configure a default or category model first");
    if (!catalog.models.some((item) => modelKey(item) === modelKey(model))) throw new ApiError(400, "model_unavailable", "The selected model is not connected in this workspace");
    return { category: inferred, model, source: explicit ? "step" : state.routing.enabled && state.routing.categories[inferred] ? "category" : "default", reason: explicit ? "Explicit workflow step model" : state.routing.enabled && state.routing.categories[inferred] ? `Matched ${inferred} category` : "Workspace default model" };
  }
  async saveRouting(workspace: WorkspaceInfo, routing: LocalRoutingSettings): Promise<LocalRoutingSettings> {
    this.writable();
    const catalog = await this.models(workspace, true); const available = new Set(catalog.models.map(modelKey));
    if (routing.defaultModel && !available.has(modelKey(routing.defaultModel))) throw new ApiError(400, "model_unavailable", "The selected default model is not connected");
    for (const category of categories) { const model = routing.categories[category]; if (model && !available.has(modelKey(model))) throw new ApiError(400, "model_unavailable", `The selected ${category} model is not connected`); }
    return this.mutate(workspace, (state) => { state.routing = routing; return state.routing; });
  }
  async upsert(workspace: WorkspaceInfo, input: LocalWorkflowInput, id?: string): Promise<LocalWorkflow> {
    this.writable();
    const parsed = localWorkflowInputSchema.safeParse(input); const now = Date.now();
    if (!parsed.success) throw new ApiError(400, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid workflow");
    if (parsed.data.enabled && parsed.data.intervalMinutes === null) throw new ApiError(400, "invalid_payload", "Set an interval before enabling the workflow schedule");
    return this.mutate(workspace, (state) => {
      const existing = id ? state.workflows.find((workflow) => workflow.id === id) : undefined;
      if (id && !existing) throw new ApiError(404, "workflow_not_found", "Workflow not found");
      if (!existing && state.workflows.length >= 50) throw new ApiError(400, "workflow_limit", "A workspace can contain at most 50 workflows");
      const workflow: LocalWorkflow = { ...parsed.data, id: existing?.id ?? `wf_${randomUUID()}`, nextRunAt: parsed.data.enabled && parsed.data.intervalMinutes ? now + parsed.data.intervalMinutes * 60_000 : null, createdAt: existing?.createdAt ?? now, updatedAt: now };
      state.workflows = existing ? state.workflows.map((item) => item.id === workflow.id ? workflow : item) : [workflow, ...state.workflows];
      return workflow;
    });
  }
  async remove(workspace: WorkspaceInfo, id: string): Promise<void> {
    this.writable();
    await this.mutate(workspace, (state) => {
      if (this.active.get(workspace.id)?.workflowId === id) throw new ApiError(409, "workflow_run_active", "Cancel this workflow's active run before deleting it");
      if (!state.workflows.some((workflow) => workflow.id === id)) throw new ApiError(404, "workflow_not_found", "Workflow not found");
      state.workflows = state.workflows.filter((workflow) => workflow.id !== id);
    });
  }
  async run(workspace: WorkspaceInfo, workflowId: string, trigger: "manual" | "schedule" = "manual", actor: Actor = { type: "host" }): Promise<LocalWorkflowRun> {
    this.writable();
    const workflow = (await this.load(workspace)).workflows.find((item) => item.id === workflowId);
    this.writable();
    if (!workflow) throw new ApiError(404, "workflow_not_found", "Workflow not found");
    if (trigger === "schedule" && (!workflow.enabled || !workflow.intervalMinutes)) throw new ApiError(409, "workflow_paused", "Workflow schedule is paused");
    if (this.active.has(workspace.id)) throw new ApiError(409, "workflow_run_active", "Another workflow run is already active for this workspace");
    const run: LocalWorkflowRun = {
      id: `run_${randomUUID()}`, workflowId, workflowName: workflow.name, status: "running", trigger,
      startedAt: Date.now(), finishedAt: null, error: null,
      steps: workflow.steps.map((step) => ({ stepId: step.id, name: step.name, status: "pending", sessionId: null, decision: null, output: "", error: null, startedAt: null, finishedAt: null })),
    };
    const completion = Promise.withResolvers<void>();
    const active: ActiveRun = { runId: run.id, workflowId, workspace, controller: new AbortController(), actor, done: completion.promise };
    // Reserve before awaiting persistence so concurrent requests cannot both enter.
    this.active.set(workspace.id, active);
    try {
      await this.mutate(workspace, (state) => { state.runs = [run, ...state.runs].slice(0, 100); });
      await this.audit(workspace, "run.started", run.id, `Workflow run started (${trigger})`, actor, { workflowId, workflowName: workflow.name, trigger, stepCount: workflow.steps.length });
      void this.execute(workspace, structuredClone(workflow), run, active).catch(() => undefined).finally(completion.resolve);
      return structuredClone(run);
    } catch (error) {
      await this.finish(workspace, run.id, active.stoppedAs ?? "failed", safeError(error), actor).catch(() => undefined);
      if (this.active.get(workspace.id) === active) this.active.delete(workspace.id);
      completion.resolve();
      throw error;
    }
  }

  private checkActive(active: ActiveRun): void {
    if (this.active.get(active.workspace.id) !== active) throw new Error("Workflow run is no longer active");
    active.controller.signal.throwIfAborted();
    this.writable();
  }

  private async updateStep(workspace: WorkspaceInfo, runId: string, index: number, patch: Partial<LocalWorkflowRunStep>): Promise<void> {
    await this.mutate(workspace, (state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (run?.status === "running") run.steps[index] = { ...run.steps[index], ...patch };
    });
  }

  private async execute(workspace: WorkspaceInfo, workflow: LocalWorkflow, run: LocalWorkflowRun, active: ActiveRun): Promise<void> {
    let previous = "";
    const timer = setTimeout(() => active.controller.abort(new Error("Workflow exceeded its 10-minute time limit")), 10 * 60_000);
    timer.unref();
    try {
      for (const [index, step] of workflow.steps.entries()) {
        this.checkActive(active);
        await this.updateStep(workspace, run.id, index, { status: "running", startedAt: Date.now() });
        const decision = await this.route(workspace, step.prompt, step.category, step.model);
        this.checkActive(active);
        await managedDesktopPolicy(this.config).assert("sync");
        await managedDesktopPolicy(this.config).assert("model", { ...decision.model });
        this.checkActive(active);
        await this.updateStep(workspace, run.id, index, { decision });
        const created = await this.engineFactory(this.config, workspace).session.create({
          title: `Workflow: ${workflow.name} / ${step.name}`,
          model: { providerID: decision.model.providerID, id: decision.model.modelID },
        }, { signal: AbortSignal.any([active.controller.signal, AbortSignal.timeout(10_000)]) });
        if (created.error || !created.data) throw new Error(safeError(created.error));
        const sessionId = created.data.id;
        active.sessionId = sessionId;
        await this.updateStep(workspace, run.id, index, { sessionId });
        this.checkActive(active);
        const prompt = step.prompt.includes("{{previous}}") ? step.prompt.replaceAll("{{previous}}", () => previous)
          : previous ? `${step.prompt}\n\nPrevious step output:\n${previous}` : step.prompt;
        const response = await this.engineFactory(this.config, workspace, { sessionId }).session.prompt({
          sessionID: sessionId, model: decision.model, parts: [{ type: "text", text: prompt }],
        }, { signal: active.controller.signal });
        this.checkActive(active);
        if (response.error || !response.data) throw new Error(safeError(response.error));
        if (response.data.info.error) throw new Error(safeError(response.data.info.error));
        const text = response.data.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
        if (!text) throw new Error("The model returned no text. Open the task to inspect its tool activity.");
        const output = redact(text).slice(0, 16_000);
        previous = output;
        await this.updateStep(workspace, run.id, index, { status: "completed", output, finishedAt: Date.now() });
        active.sessionId = undefined;
      }
      this.checkActive(active);
      await this.finish(workspace, run.id, "completed", null, active.actor);
    } catch (error) {
      const message = safeError(active.controller.signal.reason ?? error);
      // A dropped HTTP connection need not stop the engine's underlying task.
      // Abort the owned session on every failure before releasing its reservation.
      if (!active.controller.signal.aborted) active.controller.abort(error);
      await this.finish(workspace, run.id, active.stoppedAs ?? "failed", message, active.actor);
    } finally {
      clearTimeout(timer);
      if (active.controller.signal.aborted) await this.abortSession(active);
      if (this.active.get(workspace.id) === active) this.active.delete(workspace.id);
    }
  }

  private markFinished(run: LocalWorkflowRun, status: LocalWorkflowRun["status"], error: string | null): void {
    run.status = status;
    run.error = error;
    run.finishedAt = Date.now();
    for (const step of run.steps) {
      if (step.status === "running") {
        step.status = status === "cancelled" ? "cancelled" : "failed";
        step.error = error;
        step.finishedAt = run.finishedAt;
      } else if (step.status === "pending") {
        step.status = "cancelled";
        step.finishedAt = run.finishedAt;
      }
    }
  }

  private async finish(workspace: WorkspaceInfo, runId: string, status: LocalWorkflowRun["status"], error: string | null, actor: Actor): Promise<void> {
    const changed = await this.mutate(workspace, (state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run || run.status !== "running") return false;
      this.markFinished(run, status, error);
      return true;
    });
    if (changed) {
      const run = await this.getRun(workspace, runId).catch(() => null);
      await this.audit(workspace, `run.${status}`, runId, `Workflow run ${status}`, actor, run ? {
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        trigger: run.trigger,
        status: run.status,
        error: run.error,
        steps: run.steps.map((step) => ({ id: step.stepId, name: step.name, status: step.status, sessionId: step.sessionId, model: step.decision?.model ?? null })),
      } : undefined);
    }
  }

  private async abortSession(active: ActiveRun): Promise<void> {
    const sessionId = active.sessionId;
    if (!sessionId) return;
    try {
      await this.engineFactory(this.config, active.workspace, { sessionId }).session.abort({ sessionID: sessionId }, { signal: AbortSignal.timeout(5000) });
    } catch { /* Keep the terminal run status if its engine is unavailable. */ }
  }

  async cancel(workspace: WorkspaceInfo, runId: string): Promise<LocalWorkflowRun> {
    this.writable();
    const active = this.active.get(workspace.id);
    if (!active || active.runId !== runId) throw new ApiError(404, "run_not_active", "Run is not active");
    active.stoppedAs = "cancelled";
    active.controller.abort(new Error("Cancelled by user"));
    await this.finish(workspace, runId, "cancelled", "Cancelled by user", active.actor);
    await this.abortSession(active);
    return this.getRun(workspace, runId);
  }

  async getRun(workspace: WorkspaceInfo, id: string): Promise<LocalWorkflowRun> {
    const run = (await this.load(workspace)).runs.find((item) => item.id === id);
    if (!run) throw new ApiError(404, "run_not_found", "Run not found");
    return structuredClone(run);
  }

  private async tick(): Promise<void> {
    if (this.config.readOnly || this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      for (const workspace of this.config.workspaces) {
        if (this.stopped || this.active.has(workspace.id)) continue;
        const state = await this.load(workspace);
        const now = Date.now();
        const due = state.workflows.find((workflow) => workflow.enabled && workflow.intervalMinutes && workflow.nextRunAt && workflow.nextRunAt <= now);
        if (!due) continue;
        await this.mutate(workspace, (current) => {
          const item = current.workflows.find((workflow) => workflow.id === due.id);
          if (item?.enabled && item.intervalMinutes) item.nextRunAt = now + item.intervalMinutes * 60_000;
        });
        try { await this.run(workspace, due.id, "schedule"); }
        catch { await this.audit(workspace, "schedule.failed", due.id, "Scheduled workflow could not start"); }
      }
    } catch { /* Corrupt state remains visible as a snapshot error; never overwrite it. */ }
    finally { this.ticking = false; }
  }

  private async audit(workspace: WorkspaceInfo, action: string, target: string, summary: string, actor: Actor = { type: "host" }, details?: Record<string, unknown>): Promise<void> {
    await recordAudit(workspace.path, {
      id: `audit_${randomUUID()}`, workspaceId: workspace.id, actor, action: `local_workflow.${action}`,
      target, summary, timestamp: Date.now(), ...(details ? { details } : {}),
    });
  }
}
