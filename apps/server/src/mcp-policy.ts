import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";

/** MCP is deny-only in normal OmniRush.ai processes. */
export type McpPolicyMode = "disabled" | "harbor-local" | "enabled";

export const MCP_DISABLED_MESSAGE =
  "MCP servers are disabled in OmniRush.ai. Run the isolated Docker Harbor task to reproduce MCP behavior.";

export function resolveMcpPolicyFromEnvironment(env: NodeJS.ProcessEnv = process.env): McpPolicyMode {
  const requested = env.OMNIRUSH_MCP_POLICY?.trim().toLowerCase();
  if (
    requested === "harbor-local"
    && env.OMNIRUSH_HARBOR_TASK_ID?.trim()
    && env.OMNIRUSH_SANDBOX_BACKEND?.trim().toLowerCase() === "docker"
  ) return "harbor-local";
  return "disabled";
}

/** Older direct embedders/tests may omit the optional policy until migrated. */
export function mcpPolicyForConfig(config: Pick<ServerConfig, "mcpPolicy">): McpPolicyMode {
  return config.mcpPolicy ?? "enabled";
}

export function mcpAllowed(config: Pick<ServerConfig, "mcpPolicy">): boolean {
  return mcpPolicyForConfig(config) !== "disabled";
}

export function assertMcpAllowed(config: Pick<ServerConfig, "mcpPolicy">): void {
  if (mcpAllowed(config)) return;
  throw new ApiError(403, "mcp_disabled", MCP_DISABLED_MESSAGE);
}

