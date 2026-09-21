import { z } from "zod"

export const OMNIRUSH_CLOUD_MCP_CONNECTION_ACTION_VERSION = 1 as const
export const OMNIRUSH_CLOUD_MCP_CONNECTION_ACTION_KIND = "connection_action" as const
export const OMNIRUSH_CLOUD_MCP_CONNECTION_ACTION_SOURCE = "omnirush-cloud" as const

export const omnirushCloudMcpConnectionActionSchema = z.object({
  version: z.literal(OMNIRUSH_CLOUD_MCP_CONNECTION_ACTION_VERSION),
  kind: z.literal(OMNIRUSH_CLOUD_MCP_CONNECTION_ACTION_KIND),
  source: z.literal(OMNIRUSH_CLOUD_MCP_CONNECTION_ACTION_SOURCE),
  connectionId: z.string().min(1),
  connectionName: z.string().min(1),
  authType: z.enum(["oauth", "apikey", "none"]),
  credentialMode: z.enum(["shared", "per_member"]),
  state: z.enum(["needs_connection", "reauth_required", "provider_error"]),
  actor: z.enum([
    "member",
    "organization_admin",
    "provider_admin",
    "network_admin",
    "omnirush",
  ]),
  action: z.object({
    type: z.enum([
      "connect",
      "reconnect",
      "update_credentials",
      "inspect_connection",
      "fix_provider",
      "fix_network",
      "contact_omnirush",
    ]),
    surface: z.enum([
      "omnirush_your_connections",
      "omnirush_organization_connections",
      "provider_admin_console",
      "network_infrastructure",
      "omnirush_support",
    ]),
    retry: z.literal("search_capabilities"),
  }),
})

/**
 * The only connection action that chat may execute directly. Shared OAuth,
 * API-key, provider-admin, and support actions remain descriptive because the
 * current member may not own the credential or have permission to repair it.
 */
export const omnirushCloudMcpInlineReconnectSchema = omnirushCloudMcpConnectionActionSchema.extend({
  authType: z.literal("oauth"),
  credentialMode: z.literal("per_member"),
  state: z.literal("reauth_required"),
  actor: z.literal("member"),
  action: z.object({
    type: z.literal("reconnect"),
    surface: z.literal("omnirush_your_connections"),
    retry: z.literal("search_capabilities"),
  }),
})

export type OmniRushCloudMcpConnectionAction = z.infer<typeof omnirushCloudMcpConnectionActionSchema>
export type OmniRushCloudMcpInlineReconnect = z.infer<typeof omnirushCloudMcpInlineReconnectSchema>
