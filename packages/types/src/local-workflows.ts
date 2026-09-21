import { z } from "zod";

export const localRouteCategorySchema = z.enum(["general", "coding", "writing", "analysis"]);
export type LocalRouteCategory = z.infer<typeof localRouteCategorySchema>;
export const localModelRefSchema = z.object({
  providerID: z.string().trim().min(1).max(160),
  modelID: z.string().trim().min(1).max(240),
});
export type LocalModelRef = z.infer<typeof localModelRefSchema>;
export type LocalAvailableModel = LocalModelRef & { name: string; providerName: string };

export const localRoutingSettingsSchema = z.object({
  enabled: z.boolean(),
  defaultModel: localModelRefSchema.nullable(),
  categories: z.object({
    general: localModelRefSchema.optional(),
    coding: localModelRefSchema.optional(),
    writing: localModelRefSchema.optional(),
    analysis: localModelRefSchema.optional(),
  }),
});
export type LocalRoutingSettings = z.infer<typeof localRoutingSettingsSchema>;
export const localRouteDecisionSchema = z.object({
  category: localRouteCategorySchema,
  model: localModelRefSchema,
  source: z.enum(["step", "category", "default"]),
  reason: z.string(),
});
export type LocalRouteDecision = z.infer<typeof localRouteDecisionSchema>;

export const localWorkflowStepSchema = z.object({
  id: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(16000),
  category: z.union([localRouteCategorySchema, z.literal("auto")]),
  model: localModelRefSchema.nullable(),
});
export type LocalWorkflowStep = z.infer<typeof localWorkflowStepSchema>;
export const localWorkflowInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  enabled: z.boolean().default(false),
  intervalMinutes: z.number().int().min(1).max(43200).nullable().default(null),
  steps: z.array(localWorkflowStepSchema).min(1).max(8).refine(
    (steps) => new Set(steps.map((step) => step.id)).size === steps.length,
    "Step IDs must be unique",
  ),
});
export type LocalWorkflowInput = z.infer<typeof localWorkflowInputSchema>;
export const localWorkflowSchema = localWorkflowInputSchema.extend({
  id: z.string(),
  nextRunAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type LocalWorkflow = z.infer<typeof localWorkflowSchema>;
export const localWorkflowRunStepSchema = z.object({
  stepId: z.string(),
  name: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  sessionId: z.string().nullable(),
  decision: localRouteDecisionSchema.nullable(),
  output: z.string(),
  error: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});
export type LocalWorkflowRunStep = z.infer<typeof localWorkflowRunStepSchema>;
export const localWorkflowRunSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  status: z.enum(["running", "completed", "failed", "cancelled", "interrupted"]),
  trigger: z.enum(["manual", "schedule"]),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  error: z.string().nullable(),
  steps: z.array(localWorkflowRunStepSchema),
});
export type LocalWorkflowRun = z.infer<typeof localWorkflowRunSchema>;
export const localWorkflowStateSchema = z.object({
  schemaVersion: z.literal(1),
  routing: localRoutingSettingsSchema,
  workflows: z.array(localWorkflowSchema).max(50),
  runs: z.array(localWorkflowRunSchema).max(100),
});
export type LocalWorkflowState = z.infer<typeof localWorkflowStateSchema>;
export interface LocalWorkflowsSnapshot {
  routing: LocalRoutingSettings;
  workflows: LocalWorkflow[];
  runs: LocalWorkflowRun[];
  models: LocalAvailableModel[];
  modelsError: string | null;
  scheduler: { active: boolean; description: string };
}
