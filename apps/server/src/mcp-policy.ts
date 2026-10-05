import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";

/** MCP is disabled for resolved OmniRush.ai server configs. */
export type McpPolicyMode = "disabled" | "enabled";

export const MCP_DISABLED_MESSAGE =
  "MCP servers are disabled in OmniRush.ai.";

export function resolveMcpPolicyFromEnvironment(_env: NodeJS.ProcessEnv = process.env): McpPolicyMode {
  return "disabled";
}

/**
 * A missing field is retained for old in-memory embedders and test fixtures.
 * Persisted or resolved values are fail-closed, so an old explicit value
 * cannot re-enable MCP after a restart.
 */
export function mcpPolicyForConfig(config: Pick<ServerConfig, "mcpPolicy">): McpPolicyMode {
  return Object.prototype.hasOwnProperty.call(config, "mcpPolicy") ? "disabled" : "enabled";
}

export function mcpAllowed(config: Pick<ServerConfig, "mcpPolicy">): boolean {
  return !Object.prototype.hasOwnProperty.call(config, "mcpPolicy");
}

export function assertMcpAllowed(config: Pick<ServerConfig, "mcpPolicy">): void {
  if (mcpAllowed(config)) return;
  throw new ApiError(403, "mcp_disabled", MCP_DISABLED_MESSAGE);
}
