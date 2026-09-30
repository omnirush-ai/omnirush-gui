import { z } from "zod";

export const sessionGoalStatusSchema = z.enum([
  "active", "paused", "blocked", "usage_limited", "budget_limited", "complete",
]);

const goalObjectiveSchema = z.string().trim().min(1).refine(
  (objective) => Array.from(objective).length <= 4_000,
  "Goal must have at most 4,000 characters.",
);

export const sessionGoalSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  objective: goalObjectiveSchema,
  status: sessionGoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type SessionGoalStatus = z.infer<typeof sessionGoalStatusSchema>;
export type SessionGoal = z.infer<typeof sessionGoalSchema>;

export const sessionGoalCommandSchema = z.object({
  action: z.enum(["set", "edit", "select", "hold", "pause", "resume", "clear"]),
  goalId: z.string().optional(),
  holding: z.boolean().optional(),
  objective: goalObjectiveSchema.optional(),
  tokenBudget: z.number().int().positive().nullable().optional(),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
  agent: z.string().optional(),
  variant: z.string().optional(),
});

export type SessionGoalCommand = z.infer<typeof sessionGoalCommandSchema>;
