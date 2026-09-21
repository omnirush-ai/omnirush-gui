import { z } from "zod"

import {
  omnirushAffordanceDescriptorSchema,
  omnirushProviderRefSchema,
} from "./omnirush-affordance.js"
import { omnirushFeatureContributionSchema } from "./omnirush-provider.js"

export const OMNIRUSH_CONTEXT_SCHEMA_VERSION = 1

export const omnirushSessionRefSchema = z.object({
  workspaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  title: z.string().optional(),
})
export type OmniRushSessionRef = z.infer<typeof omnirushSessionRefSchema>

export const omnirushScreenSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    route: z.string(),
    workspaceId: z.string().optional(),
    sessionId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("settings"),
    route: z.string(),
    workspaceId: z.string().optional(),
    panel: z.string(),
  }),
  z.object({
    kind: z.literal("other"),
    route: z.string(),
  }),
])
export type OmniRushScreen = z.infer<typeof omnirushScreenSchema>

export const omnirushConversationLayoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({
    kind: z.literal("single"),
    sessionId: z.string(),
    workspaceId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("split"),
    primarySessionId: z.string(),
    primaryWorkspaceId: z.string().optional(),
    secondarySessionId: z.string(),
    secondaryWorkspaceId: z.string().optional(),
    focused: z.enum(["primary", "secondary"]),
  }),
])
export type OmniRushConversationLayout = z.infer<typeof omnirushConversationLayoutSchema>

export const omnirushPanelTabSchema = z.object({
  id: z.string(),
  kind: z.enum(["browser", "artifact"]),
  label: z.string(),
  url: z.string().optional(),
  status: z.enum(["loading", "ready", "suspending", "suspended", "restoring"]).optional(),
})
export type OmniRushPanelTab = z.infer<typeof omnirushPanelTabSchema>

export const omnirushResourceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  kind: z.enum(["workspace", "session", "screen", "side-panel", "settings"]),
  title: z.string(),
  provider: omnirushProviderRefSchema,
  state: z.record(z.string(), z.unknown()),
})
export type OmniRushResourceDescriptor = z.infer<typeof omnirushResourceDescriptorSchema>

export const omnirushContextSnapshotSchema = z.object({
  schemaVersion: z.literal(OMNIRUSH_CONTEXT_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  capturedAt: z.string(),
  screen: omnirushScreenSchema,
  conversations: z.object({
    tabs: z.array(omnirushSessionRefSchema),
    layout: omnirushConversationLayoutSchema,
    pinnedSessionIds: z.array(z.string()),
  }),
  chrome: z.object({
    sidebarOpen: z.boolean(),
    applicationMenuVisible: z.boolean(),
    rightSidebarExpanded: z.boolean(),
  }),
  execution: z.object({
    queries: z.literal("parallel"),
    commands: z.literal("serialized"),
    busyCommandId: z.string().nullable(),
    busyActor: z.string().nullable(),
  }),
  sidePanel: z.object({
    open: z.boolean(),
    ownerSessionId: z.string().nullable(),
    kind: z.enum(["panel", "extensions"]).nullable(),
    tabs: z.array(omnirushPanelTabSchema),
    activeTabId: z.string().nullable(),
  }),
  resources: z.array(omnirushResourceDescriptorSchema),
  availableAffordances: z.array(omnirushAffordanceDescriptorSchema),
  contributions: z.array(omnirushFeatureContributionSchema),
})
export type OmniRushContextSnapshot = z.infer<typeof omnirushContextSnapshotSchema>
