import { getMcpServerName, type McpDirectoryInfo } from "../../../app/constants";
import { CLOUD_MCP_SERVER_NAME } from "./cloud-mcp-user-state";

export function conflictsWithOmniRushConnect(
  entry: Pick<McpDirectoryInfo, "id" | "name" | "serverName" | "managedBy">,
): boolean {
  const serverName = entry.id ?? getMcpServerName({
    ...entry,
    description: "",
    oauth: false,
  });
  const reservedNames = new Set([CLOUD_MCP_SERVER_NAME, "omnirush-ai-cloud"]);
  return entry.managedBy !== "omnirush-connect" && reservedNames.has(serverName);
}
