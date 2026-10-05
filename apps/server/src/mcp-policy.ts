import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";

/** MCP is disabled for every OmniRush.ai process. */
export type McpPolicyMode = "disabled";

export const MCP_DISABLED_MESSAGE =
  "MCP servers are disabled in OmniRush.ai.";

export function resolveMcpPolicyFromEnvironment(_env: NodeJS.ProcessEnv = process.env): McpPolicyMode {
  return "disabled";
}

/** Legacy config values are ignored so an old persisted row cannot re-enable MCP. */
export function mcpPolicyForConfig(_config: Pick<ServerConfig, "mcpPolicy">): McpPolicyMode {
  return "disabled";
}

export function mcpAllowed(_config: Pick<ServerConfig, "mcpPolicy">): boolean {
  return false;
}

export function assertMcpAllowed(config: Pick<ServerConfig, "mcpPolicy">): void {
  if (mcpAllowed(config)) return;
  throw new ApiError(403, "mcp_disabled", MCP_DISABLED_MESSAGE);
}
