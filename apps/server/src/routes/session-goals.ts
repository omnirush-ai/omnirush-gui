import { sessionGoalCommandSchema, sessionGoalSchema } from "@omnirush/types/session-goal";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { managedDesktopPolicy } from "../managed-desktop-policy.js";
import { SessionGoalService, type GoalEngineFactory, type GoalPromptDispatcher } from "../session-goals.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

const selectionSchema = sessionGoalCommandSchema.pick({ model: true, agent: true, variant: true });
const callbackSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get") }),
  z.object({ action: z.literal("create"), objective: sessionGoalSchema.shape.objective, token_budget: z.number().int().positive().optional(), messageId: z.string().nullable().optional() }),
  z.object({ action: z.literal("update"), goalId: z.string(), status: z.enum(["complete", "blocked", "paused"]) }),
  z.object({ action: z.literal("prompt"), messageId: z.string().nullable(), selection: selectionSchema }),
  z.object({ action: z.literal("event"), goalId: z.string(), turnId: z.string().nullable(), chargeable: z.boolean().default(true), event: z.object({ type: z.string(), properties: z.record(z.string(), z.unknown()).optional() }) }),
]);
const envelopeSchema = z.object({ directory: z.string().min(1), sessionId: z.string().min(1) });

interface Options {
  routes: Route[]; config: ServerConfig;
  jsonResponse: (value: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  resolveWorkspaceWithoutBootstrap: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  createWorkspaceOpencodeClient: GoalEngineFactory;
  assertSessionOwned: (config: ServerConfig, workspace: WorkspaceInfo, sessionId: string) => Promise<void>;
  sameDirectory: (left: string, right: string) => boolean;
  promptDispatcher: GoalPromptDispatcher;
  assertPromptAllowed: (workspace: WorkspaceInfo) => void;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid goal request");
  return parsed.data;
}

export function registerSessionGoalRoutes(options: Options): SessionGoalService {
  const { config, routes, jsonResponse, ensureWritable, readJsonBody } = options;
  const service = new SessionGoalService(config, options.createWorkspaceOpencodeClient, options.promptDispatcher);
  const ownSession = async (workspace: WorkspaceInfo, sessionId: string) => {
    await options.assertSessionOwned(config, workspace, sessionId);
    const result = await (await options.createWorkspaceOpencodeClient(config, workspace, { sessionId })).session.get({ sessionID: sessionId });
    if (!result.data) throw new ApiError(404, "session_not_found", "Session not found");
    return result.data;
  };
  const ancestry = async (workspace: WorkspaceInfo, sessionId: string): Promise<string[]> => {
    const parents: string[] = [];
    let session = await ownSession(workspace, sessionId);
    for (let hop = 0; session.parentID && hop < 8; hop += 1) {
      if (session.parentID === sessionId || parents.includes(session.parentID)) break;
      parents.push(session.parentID);
      session = await ownSession(workspace, session.parentID);
    }
    return parents;
  };
  addRoute(routes, "GET", "/workspace/:id/session-goals/:sessionId", "client", async (ctx) => {
    const workspace = await options.resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    await ownSession(workspace, ctx.params.sessionId);
    await service.recover(workspace, ctx.params.sessionId);
    return jsonResponse({ goal: await service.read(workspace, ctx.params.sessionId) });
  });
  addRoute(routes, "POST", "/workspace/:id/session-goals/:sessionId", "client", async (ctx) => {
    ensureWritable(config); options.requireClientScope(ctx, "collaborator");
    const workspace = await options.resolveWorkspace(config, ctx.params.id);
    const session = await ownSession(workspace, ctx.params.sessionId);
    const command = parse(sessionGoalCommandSchema, await readJsonBody(ctx.request));
    if (session.parentID && command.action !== "hold") throw new ApiError(409, "goal_subagent_session", "Set a goal on the main session");
    // A goal needs a capturable engine turn; do this before changing durable state.
    if (command.action === "set" || command.action === "resume") options.assertPromptAllowed(workspace);
    return jsonResponse({ goal: await service.command(workspace, ctx.params.sessionId, command) });
  });
  addRoute(routes, "POST", "/omnirush/session-goals", "policy", async (ctx) => {
    // Unlike legacy policy routes, this callback is for engine plugins only.
    if (!managedDesktopPolicy(config).authenticatesEvaluation(ctx.request)) throw new ApiError(403, "goal_policy_token_required", "An engine policy token is required");
    const body = await readJsonBody(ctx.request);
    const envelope = parse(envelopeSchema, body);
    const callback = parse(callbackSchema, body);
    const configured = config.workspaces.find((workspace) => options.sameDirectory(workspace.directory?.trim() || workspace.path, envelope.directory));
    if (!configured?.id) throw new ApiError(404, "workspace_not_found", "Workspace not found");
    const workspace = await options.resolveWorkspaceWithoutBootstrap(config, configured.id);
    const parents = await ancestry(workspace, envelope.sessionId);
    const context = await service.context(workspace, envelope.sessionId, parents);
    if (callback.action === "get") return jsonResponse(context);
    ensureWritable(config);
    if (callback.action === "prompt") {
      if (parents.length) {
        const parentGoal = context.rootSessionId ? await service.read(workspace, context.rootSessionId) : null;
        if (!parentGoal || (parentGoal.status !== "active" && parentGoal.status !== "budget_limited")) {
          return jsonResponse({ ...context, goalId: null, turnId: null, rootSessionId: null, chargeable: false, userMessageId: null });
        }
        return jsonResponse({ ...context, chargeable: context.chargeable && callback.selection.agent !== "plan" });
      }
      if (!context.goalId) return jsonResponse(context);
      return jsonResponse(await service.prompt(workspace, envelope.sessionId, callback.messageId, callback.selection));
    }
    if (callback.action === "event") {
      if (context.rootSessionId && context.goalId === callback.goalId) await service.event(workspace, envelope.sessionId, context.rootSessionId, callback.goalId, callback.turnId, callback.event, callback.chargeable);
      return jsonResponse({ ok: true });
    }
    if (parents.length) throw new ApiError(409, "goal_subagent_session", "A sub-agent works on its assigned task and cannot set or stop its parent's goal");
    if (callback.action === "create") {
      await service.createFromTool(workspace, envelope.sessionId, callback.objective, callback.token_budget, callback.messageId);
    } else {
      await service.updateFromTool(workspace, envelope.sessionId, callback.goalId, callback.status);
    }
    return jsonResponse(await service.context(workspace, envelope.sessionId, []));
  });
  return service;
}
