import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { localRoutingSettingsSchema, localWorkflowInputSchema, localModelRefSchema, localRouteCategorySchema } from "@omnirush/types/local-workflows";
import { ApiError } from "../errors.js";
import { recordAudit } from "../audit.js";
import { LocalWorkflowService, type LocalWorkflowPromptDispatcher } from "../local-workflows.js";
import type { Actor, ServerConfig, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

export interface RegisterLocalWorkflowRoutesOptions {
  routes: Route[]; config: ServerConfig; jsonResponse: JsonResponse; readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void; requireClientScope: (ctx: RequestContext, required: "collaborator") => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  resolveWorkspaceWithoutBootstrap: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo, options?: { sessionId?: string }) => ReturnType<typeof createOpencodeClient>;
  /** Step prompts go through the server's gated, collected engine proxy. */
  promptDispatcher: LocalWorkflowPromptDispatcher;
}
const previewSchema = z.object({
  prompt: z.string().trim().min(1).max(16000),
  category: z.union([localRouteCategorySchema, z.literal("auto")]).optional(),
  model: localModelRefSchema.nullable().optional(),
});
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, "invalid_payload", result.error.issues[0]?.message ?? "Invalid workflow request");
  return result.data;
}
export function registerLocalWorkflowRoutes(options: RegisterLocalWorkflowRoutesOptions): LocalWorkflowService {
  const service = new LocalWorkflowService(options.config, options.createWorkspaceOpencodeClient, options.promptDispatcher); service.start();
  const { routes, config, jsonResponse, readJsonBody, ensureWritable, requireClientScope, resolveWorkspace, resolveWorkspaceWithoutBootstrap } = options;
  const writableWorkspace = async (ctx: RequestContext) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    return resolveWorkspace(config, ctx.params.id);
  };
  addRoute(routes, "GET", "/workspace/:id/local-workflows", "client", async (ctx) => {
    return jsonResponse(await service.snapshot(await resolveWorkspaceWithoutBootstrap(config, ctx.params.id)));
  });
  addRoute(routes, "PUT", "/workspace/:id/local-workflows/routing", "client", async (ctx) => {
    const workspace = await writableWorkspace(ctx);
    const routing = parse(localRoutingSettingsSchema, await readJsonBody(ctx.request));
    const result = await service.saveRouting(workspace, routing);
    await audit(workspace, "local_workflow.routing.updated", workspace.id, "Updated workflow model routing", ctx.actor, { enabled: result.enabled, defaultModel: result.defaultModel, categories: result.categories });
    return jsonResponse(result);
  });
  addRoute(routes, "POST", "/workspace/:id/local-workflows/route", "client", async (ctx) => {
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const body = parse(previewSchema, await readJsonBody(ctx.request));
    return jsonResponse(await service.route(workspace, body.prompt, body.category, body.model));
  });
  addRoute(routes, "POST", "/workspace/:id/local-workflows", "client", async (ctx) => {
    const workspace = await writableWorkspace(ctx);
    const workflow = await service.upsert(workspace, parse(localWorkflowInputSchema, await readJsonBody(ctx.request)));
    await audit(workspace, "local_workflow.created", workflow.id, "Created workflow", ctx.actor, { name: workflow.name, enabled: workflow.enabled, intervalMinutes: workflow.intervalMinutes, stepCount: workflow.steps.length });
    return jsonResponse(workflow, 201);
  });
  addRoute(routes, "PATCH", "/workspace/:id/local-workflows/:workflowId", "client", async (ctx) => {
    const workspace = await writableWorkspace(ctx);
    const state = await service.snapshot(workspace);
    const current = state.workflows.find((item) => item.id === ctx.params.workflowId);
    if (!current) throw new ApiError(404, "workflow_not_found", "Workflow not found");
    const body = parse(z.record(z.string(), z.unknown()), await readJsonBody(ctx.request));
    const workflow = await service.upsert(workspace, parse(localWorkflowInputSchema, { ...current, ...body }), ctx.params.workflowId);
    await audit(workspace, "local_workflow.updated", workflow.id, workflow.enabled ? "Updated workflow schedule/settings" : "Updated workflow; schedule paused", ctx.actor, { name: workflow.name, enabled: workflow.enabled, intervalMinutes: workflow.intervalMinutes, nextRunAt: workflow.nextRunAt, stepCount: workflow.steps.length });
    return jsonResponse(workflow);
  });
  addRoute(routes, "DELETE", "/workspace/:id/local-workflows/:workflowId", "client", async (ctx) => {
    const workspace = await writableWorkspace(ctx);
    await service.remove(workspace, ctx.params.workflowId);
    await audit(workspace, "local_workflow.deleted", ctx.params.workflowId, "Deleted workflow", ctx.actor, { workflowId: ctx.params.workflowId });
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "POST", "/workspace/:id/local-workflows/:workflowId/run", "client", async (ctx) => {
    const workspace = await writableWorkspace(ctx);
    return jsonResponse(await service.run(workspace, ctx.params.workflowId, "manual", ctx.actor), 202);
  });
  addRoute(routes, "POST", "/workspace/:id/local-workflows/runs/:runId/cancel", "client", async (ctx) => {
    return jsonResponse(await service.cancel(await writableWorkspace(ctx), ctx.params.runId));
  });
  addRoute(routes, "GET", "/workspace/:id/local-workflows/runs/:runId", "client", async (ctx) => {
    return jsonResponse(await service.getRun(await resolveWorkspaceWithoutBootstrap(config, ctx.params.id), ctx.params.runId));
  });
  return service;
}
async function audit(workspace: WorkspaceInfo, action: string, target: string, summary: string, actor: Actor = { type: "host" }, details?: Record<string, unknown>): Promise<void> {
  await recordAudit(workspace.path, { id: `audit_${randomUUID()}`, workspaceId: workspace.id, actor, action, target, summary, timestamp: Date.now(), ...(details ? { details } : {}) });
}
