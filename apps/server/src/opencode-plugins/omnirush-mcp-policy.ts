/**
 * Engine-side MCP fence.  The HTTP/UI checks are useful for normal clients,
 * but an OpenCode config can also come from a workspace file or a direct
 * engine request.  This hook removes those servers before the model sees
 * them, unless the server process explicitly belongs to an isolated Harbor
 * Docker task.
 */
function harborMcpTask(): boolean {
  return process.env.OMNIRUSH_MCP_POLICY?.trim().toLowerCase() === "harbor-local"
    && Boolean(process.env.OMNIRUSH_HARBOR_TASK_ID?.trim())
    && process.env.OMNIRUSH_SANDBOX_BACKEND?.trim().toLowerCase() === "docker";
}

export default async function omnirushMcpPolicy() {
  if (harborMcpTask()) return {};
  return {
    config: async (_input: unknown, output: { mcp?: unknown; permission?: Record<string, unknown> }) => {
      output.mcp = {};
      output.permission = {
        ...(output.permission ?? {}),
        "mcp.*": "deny",
      };
    },
  };
}

