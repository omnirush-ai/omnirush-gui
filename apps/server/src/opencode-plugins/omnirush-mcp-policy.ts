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
    // OpenCode 1.x has shipped both config(config) and config(input, output)
    // hook shapes; accept either so the fence survives engine upgrades.
    config: async (input: unknown, output?: { mcp?: unknown; permission?: Record<string, unknown> }) => {
      const target = output && typeof output === "object"
        ? output
        : (input && typeof input === "object" ? input as { mcp?: unknown; permission?: Record<string, unknown> } : null);
      if (!target) return;
      target.mcp = {};
      target.permission = {
        ...(target.permission ?? {}),
        "mcp.*": "deny",
      };
    },
  };
}
