import { z } from "zod"

export const OMNIRUSH_AFFORDANCE_SCHEMA_VERSION = 1

export const omnirushAffordanceKindSchema = z.enum(["query", "command", "guidance"])
export type OmniRushAffordanceKind = z.infer<typeof omnirushAffordanceKindSchema>

export const omnirushProviderKindSchema = z.enum(["builtin", "extension", "mcp", "connect"])
export type OmniRushProviderKind = z.infer<typeof omnirushProviderKindSchema>

export const omnirushProviderRefSchema = z.object({
  id: z.string().trim().min(1),
  kind: omnirushProviderKindSchema,
})
export type OmniRushProviderRef = z.infer<typeof omnirushProviderRefSchema>

export const omnirushAffordanceArgumentSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(["string", "number", "boolean", "object", "array", "unknown"]),
  required: z.boolean(),
  description: z.string().trim().min(1).optional(),
})
export type OmniRushAffordanceArgument = z.infer<typeof omnirushAffordanceArgumentSchema>

export const omnirushAffordanceEffectsSchema = z.object({
  data: z.enum(["none", "read", "write"]),
  ui: z.enum(["none", "focus", "navigate", "layout", "dialog"]),
  external: z.boolean(),
})
export type OmniRushAffordanceEffects = z.infer<typeof omnirushAffordanceEffectsSchema>

export const omnirushAffordanceAvailabilitySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(1).optional(),
})
export type OmniRushAffordanceAvailability = z.infer<typeof omnirushAffordanceAvailabilitySchema>

export const omnirushAffordanceExecutorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("omnirush") }),
  z.object({
    kind: z.literal("tool"),
    tool: z.string().trim().min(1),
  }),
])
export type OmniRushAffordanceExecutor = z.infer<typeof omnirushAffordanceExecutorSchema>

export const omnirushAffordanceDescriptorSchema = z.object({
  id: z.string().trim().min(1),
  kind: omnirushAffordanceKindSchema,
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: omnirushProviderRefSchema,
  arguments: z.array(omnirushAffordanceArgumentSchema),
  effects: omnirushAffordanceEffectsSchema,
  confirmation: z.enum(["never", "destructive", "always"]),
  availability: omnirushAffordanceAvailabilitySchema,
  executor: omnirushAffordanceExecutorSchema,
})
export type OmniRushAffordanceDescriptor = z.infer<typeof omnirushAffordanceDescriptorSchema>

/**
 * Where a request came from: the conversation (session) whose agent issued
 * it. Set by the OmniRush.ai bridge, never by the agent, so UI commands such as
 * opening a browser tab can act for the requesting conversation instead of
 * whichever one happens to be on screen.
 */
export const omnirushAffordanceOriginSchema = z.object({
  sessionId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1).optional(),
})
export type OmniRushAffordanceOrigin = z.infer<typeof omnirushAffordanceOriginSchema>

export const omnirushAffordanceRequestSchema = z.object({
  id: z.string().trim().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  actor: z.string().trim().min(1).optional(),
  origin: omnirushAffordanceOriginSchema.optional(),
})
export type OmniRushAffordanceRequest = z.infer<typeof omnirushAffordanceRequestSchema>

const omnirushAffordanceSuccessSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  result: z.unknown().optional(),
  revision: z.number().int().nonnegative().optional(),
  effects: omnirushAffordanceEffectsSchema,
})

const omnirushAffordanceFailureSchema = z.object({
  ok: z.literal(false),
  id: z.string(),
  error: z.string(),
  code: z.enum(["unavailable", "invalid-args", "conflict", "failed"]),
  revision: z.number().int().nonnegative().optional(),
})

export const omnirushAffordanceResultSchema = z.discriminatedUnion("ok", [
  omnirushAffordanceSuccessSchema,
  omnirushAffordanceFailureSchema,
])
export type OmniRushAffordanceResult = z.infer<typeof omnirushAffordanceResultSchema>
