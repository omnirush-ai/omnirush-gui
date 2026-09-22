/**
 * `omnirush-ui-mcp` is not a package OmniRush.ai publishes on npm, yet desktop
 * releases 1.0.0 to 1.0.8 configured the built-in UI-control MCP as
 * `npx -y omnirush-ui-mcp`. Whoever registers that name gets code execution
 * on every host that resolves it from a registry. The desktop now bundles the
 * MCP and launches it by absolute path, so no legitimate command names the
 * package: any command that does is refused on write and never delivered to
 * the engine.
 *
 * Kept free of other server imports so validators, the runtime config store,
 * and the engine config builder can all share it without import cycles.
 */

/**
 * A bare package reference: `omnirush-ui-mcp`, `omnirush-ui-mcp@<version|tag>`,
 * `npm:omnirush-ui-mcp`, or `--package=omnirush-ui-mcp`. A path to the
 * bundled file (`.../omnirush-ui-mcp/index.mjs`) never matches.
 */
const PACKAGE_REFERENCE = /^(?:--package=|-p=)?(?:npm:)?omnirush-ui-mcp(?:@\S*)?$/i;

/** Shell word and statement separators, so `sh -c "npx -y omnirush-ui-mcp"` is caught too. */
const TOKEN_SEPARATORS = /[\s"'`;&|()<>]+/;

export const OMNIRUSH_UI_MCP_REGISTRY_COMMAND_MESSAGE =
  "omnirush-ui-mcp is not published on npm and cannot be launched through npx, bunx, pnpm dlx or another package runner. "
  + "Connect UI control from Settings > Extensions in the omnirush.ai desktop app, which runs the copy bundled with the app.";

/**
 * True when a local MCP command resolves `omnirush-ui-mcp` by package name
 * (npx, bunx, pnpm dlx, yarn dlx, npm exec, bun x, a PATH lookup of a global
 * install, or any of these inside a shell string) rather than running the
 * bundled file by path.
 */
export function isOmniRushUiMcpRegistryCommand(command: unknown): boolean {
  if (!Array.isArray(command)) return false;
  return command.some((part) =>
    typeof part === "string"
    && part.split(TOKEN_SEPARATORS).some((token) => PACKAGE_REFERENCE.test(token))
  );
}

/** True for an MCP entry whose `command` is a registry launch of `omnirush-ui-mcp`. */
export function isOmniRushUiMcpRegistryEntry(entry: unknown): boolean {
  return typeof entry === "object"
    && entry !== null
    && !Array.isArray(entry)
    && isOmniRushUiMcpRegistryCommand((entry as Record<string, unknown>).command);
}

/** Drops registry launches of `omnirush-ui-mcp` from an MCP map; returns the same map when there are none. */
export function withoutOmniRushUiMcpRegistryEntries<T>(mcp: Record<string, T>): Record<string, T> {
  const blocked = Object.keys(mcp).filter((name) => isOmniRushUiMcpRegistryEntry(mcp[name]));
  if (blocked.length === 0) return mcp;
  return Object.fromEntries(Object.entries(mcp).filter(([name]) => !blocked.includes(name)));
}
