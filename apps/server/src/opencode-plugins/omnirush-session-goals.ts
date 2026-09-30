import { sessionGoalSchema } from "@omnirush/types/session-goal";
import { z } from "zod";

const contextSchema = z.object({
  goal: sessionGoalSchema.nullable(), goalId: z.string().nullable(), turnId: z.string().nullable(),
  revision: z.number().nullable(), rootSessionId: z.string().nullable(),
  chargeable: z.boolean().default(true),
  userMessageId: z.string().nullable().default(null),
});
type GoalContext = z.infer<typeof contextSchema>;
type ToolContext = { sessionID: string; messageID?: string };
type EngineEvent = { type: string; properties?: Record<string, unknown> };
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

// Only the factory is exported: OpenCode treats every export as a plugin.
export const OmniRushSessionGoals = async (input: { directory: string }) => {
  const contexts = new Map<string, GoalContext>();
  const prompts = new Map<string, GoalContext>();
  const assistants = new Map<string, GoalContext>();
  const assistantParents = new Map<string, string>();
  const reportedActivity = new Set<string>();
  let disposed = false;
  const callback = async (sessionId: string, action: Record<string, unknown>, required = false): Promise<unknown> => {
    const base = process.env.OMNIRUSH_SERVER_URL?.trim().replace(/\/+$/, "");
    const token = process.env.OMNIRUSH_POLICY_TOKEN?.trim();
    if (disposed || !base || !token) {
      if (required) throw new Error("The goal service is unavailable");
      return null;
    }
    try {
      const response = await fetch(`${base}/omnirush/session-goals`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ directory: input.directory, sessionId, ...action }), signal: AbortSignal.timeout(10_000),
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(record(result) && typeof result.message === "string" ? result.message : "The goal request failed");
      return result;
    } catch (error) {
      if (required) throw error;
      return null;
    }
  };
  const parsedContext = (value: unknown): GoalContext | null => {
    const parsed = contextSchema.safeParse(value);
    if (!parsed.success) return null;
    return parsed.data;
  };
  const remember = (map: Map<string, GoalContext>, id: string, context: GoalContext) => {
    map.delete(id); map.set(id, context);
    while (map.size > 4096) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };
  const read = async (sessionId: string, required = false) => parsedContext(await callback(sessionId, { action: "get" }, required));
  return {
    tool: {
      create_goal: {
        description: "Create a session goal only when the user explicitly requests a goal. Optional token_budget is uncached input plus output, including sub-agent work. Omit it unless the user explicitly requests a token budget. Fails while an unfinished goal exists.",
        args: { objective: sessionGoalSchema.shape.objective, token_budget: z.number().int().positive().optional() },
        execute: async (args: { objective: string; token_budget?: number }, context: ToolContext) => {
          const result = parsedContext(await callback(context.sessionID, { action: "create", messageId: context.messageID ?? null, ...args }, true));
          if (result) {
            remember(contexts, context.sessionID, result);
            if (context.messageID) remember(assistants, context.messageID, result);
            const parent = result.userMessageId ?? (context.messageID ? assistantParents.get(context.messageID) : undefined);
            if (parent) remember(prompts, parent, result);
          }
          return JSON.stringify({ goal: result?.goal ?? null });
        },
      },
      get_goal: {
        description: "Read the current session goal, status, token budget, tokens used, and active work time. A sub-agent has no inherited goal; it should complete its own assigned task.",
        args: {},
        execute: async (_args: Record<string, never>, context: ToolContext) => JSON.stringify({ goal: (await read(context.sessionID, true))?.goal ?? null }),
      },
      update_goal: {
        description: "Stop the current session goal. Mark complete only when the objective is achieved and no required work remains. Mark paused only at the user's explicit request, report it and stop. Mark blocked only when the same impasse repeats for three consecutive goal turns and further progress needs user input or an external change. After the user resumes, begin a fresh blocked audit. This tool never resumes goals or changes limits.",
        args: { status: z.enum(["complete", "blocked", "paused"]) },
        execute: async (args: { status: "complete" | "blocked" | "paused" }, context: ToolContext) => {
          const current = (context.messageID ? assistants.get(context.messageID) : undefined) ?? contexts.get(context.sessionID) ?? await read(context.sessionID, true);
          if (!current?.goalId || current.rootSessionId !== context.sessionID) throw new Error("No goal is set for this session");
          const result = parsedContext(await callback(context.sessionID, { action: "update", goalId: current.goalId, ...args }, true));
          return JSON.stringify({ goal: result?.goal ?? null });
        },
      },
    },
    "chat.message": async (event: {
      sessionID: string; messageID?: string; agent?: string; variant?: string;
      model?: { providerID?: string; modelID?: string };
    }, output: { message?: { id?: string } }) => {
      if (!event.sessionID) return;
      const model = event.model?.providerID && event.model.modelID ? { providerID: event.model.providerID, modelID: event.model.modelID } : undefined;
      const messageId = output.message?.id ?? event.messageID ?? null;
      const current = parsedContext(await callback(event.sessionID, {
        action: "prompt", messageId,
        selection: { model, agent: event.agent, variant: event.variant },
      }));
      if (current) {
        remember(contexts, event.sessionID, current);
        if (messageId) remember(prompts, messageId, current);
      }
    },
    "experimental.chat.system.transform": async (event: { sessionID?: string }, output: { system: string[] }) => {
      if (!event.sessionID) return;
      const current = await read(event.sessionID);
      if (!current?.goal) return;
      const goal = current.goal;
      output.system.push(`## Session goal\nThe user set this objective: ${JSON.stringify(goal.objective)}\nStatus: ${goal.status}. Tokens used: ${goal.tokensUsed}. Token budget: ${goal.tokenBudget ?? "none"}. Active work time: ${Math.round(goal.timeUsedSeconds)} seconds.\nWork toward this goal across turns while active. An automatic continuation is not a new user request. Follow any new user request first. Never continue automatically in plan mode, while a permission or question awaits the user, or after a goal stops. Only the user can resume a stopped goal or change its limits. Mark complete with update_goal only after the objective is achieved and no required work remains. Report final token usage for a budgeted goal. Mark blocked only after the same impasse repeats for three consecutive goal turns; reset that audit when the user resumes. Sub-agents work on their assigned parts and do not adopt this goal. Their token use counts toward this goal. Do not create another goal without an explicit user request.`);
    },
    event: async ({ event }: { event: EngineEvent }) => {
      const properties = event.properties ?? {};
      const info = record(properties.info) ? properties.info : null;
      const part = record(properties.part) ? properties.part : null;
      const sessionId = typeof properties.sessionID === "string" ? properties.sessionID
        : typeof info?.sessionID === "string" ? info.sessionID : typeof part?.sessionID === "string" ? part.sessionID : null;
      if (!sessionId || !["session.status", "session.idle", "session.error", "message.updated", "message.part.updated"].includes(event.type)) return;
      // Keep the goal/turn captured when this prompt started. A delayed old
      // event can never charge or continue a replacement goal.
      let current = contexts.get(sessionId);
      if (info?.role === "assistant" && typeof info.id === "string") {
        if (typeof info.parentID === "string") {
          assistantParents.set(info.id, info.parentID);
          while (assistantParents.size > 4096) {
            const oldest = assistantParents.keys().next().value;
            if (oldest === undefined) break;
            assistantParents.delete(oldest);
          }
        }
        current = assistants.get(info.id) ?? (typeof info.parentID === "string" ? prompts.get(info.parentID) : current);
        if (current) remember(assistants, info.id, current);
      }
      if (part && typeof part.messageID === "string") current = assistants.get(part.messageID);
      if (!current?.goalId) return;
      if (event.type === "message.updated" && (!info || info.role !== "assistant" || !record(info.time) || typeof info.time.completed !== "number")) return;
      if (part) {
        if (part.type === "text") {
          if (typeof part.text !== "string" || !part.text.trim()) return;
          const key = `${current.goalId}:${current.turnId}:${part.id}`;
          if (reportedActivity.has(key)) return;
          reportedActivity.add(key);
          while (reportedActivity.size > 8192) {
            const oldest = reportedActivity.values().next().value;
            if (oldest === undefined) break;
            reportedActivity.delete(oldest);
          }
        } else if (part.type === "tool") {
          if (!record(part.state) || !["completed", "error"].includes(String(part.state.status))) return;
        } else if (part.type !== "step-finish") return;
      }
      const forwarded = part ? {
        type: event.type, properties: { sessionID: sessionId, part: {
          id: part.id, sessionID: sessionId, messageID: part.messageID, type: part.type,
          ...(part.type === "step-finish" ? { tokens: part.tokens, reason: part.reason } : {}),
          ...(part.type === "text" && typeof part.text === "string" ? { text: part.text.trim().slice(0, 1) } : {}),
          ...(part.type === "tool" && record(part.state) ? { tool: part.tool, state: { status: part.state.status } } : {}),
        } },
      } : info ? {
        type: event.type, properties: { sessionID: sessionId, info: { id: info.id, role: info.role, time: info.time, tokens: info.tokens, error: info.error } },
      } : event;
      await callback(sessionId, { action: "event", goalId: current.goalId, turnId: current.turnId, chargeable: current.chargeable, event: forwarded });
    },
    dispose: async () => { disposed = true; contexts.clear(); prompts.clear(); assistants.clear(); assistantParents.clear(); reportedActivity.clear(); },
  };
};
