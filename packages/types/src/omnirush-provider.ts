import { z } from "zod"

import {
  omnirushAffordanceDescriptorSchema,
  omnirushProviderRefSchema,
} from "./omnirush-affordance.js"

export const omnirushGuidanceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: omnirushProviderRefSchema,
  loading: z.enum(["eager", "catalog", "on-demand"]),
})
export type OmniRushGuidanceDescriptor = z.infer<typeof omnirushGuidanceDescriptorSchema>

export const omnirushFeatureContributionSchema = z.object({
  featureId: z.string().trim().min(1),
  provider: omnirushProviderRefSchema,
  affordances: z.array(omnirushAffordanceDescriptorSchema),
  guidance: z.array(omnirushGuidanceDescriptorSchema),
})
export type OmniRushFeatureContribution = z.infer<typeof omnirushFeatureContributionSchema>

export const omnirushProviderCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  contributions: z.array(omnirushFeatureContributionSchema),
})
export type OmniRushProviderCatalog = z.infer<typeof omnirushProviderCatalogSchema>

export const omnirushCapabilityResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    data: z.unknown(),
    additionalContext: z.array(z.string()).optional(),
  }),
  z.object({
    status: z.literal("guidance"),
    instructions: z.array(z.string()),
  }),
  z.object({
    status: z.literal("requires-user-action"),
    message: z.string(),
    action: z.string().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    retryable: z.boolean(),
  }),
])
export type OmniRushCapabilityResult = z.infer<typeof omnirushCapabilityResultSchema>
