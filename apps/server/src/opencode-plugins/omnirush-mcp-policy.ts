/**
 * Engine-side MCP fence.  The HTTP/UI checks are useful for normal clients,
 * but an OpenCode config can also come from a workspace file or a direct
 * engine request.  This hook removes those servers before the model sees
 * them for every server process, including locally configured engines.
 */
export default async function omnirushMcpPolicy() {
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
