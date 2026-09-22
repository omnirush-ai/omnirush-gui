// Launch command for the built-in UI-control MCP (packages/omnirush-ui-mcp).
//
// Packaged builds ship a self-contained bundle of the MCP under
// <resources>/omnirush-ui-mcp/index.mjs (see scripts/prepare-ui-mcp.mjs and
// electron-builder.base.yml) and run it with the app's own Electron binary in
// Node mode. The package name is not published on npm, so resolving it through
// `npx` would execute whatever a third party publishes under that name: this
// module never returns an npx command, and a packaged build without the bundle
// fails closed instead.
import { existsSync } from "node:fs";
import path from "node:path";

export const OMNIRUSH_UI_MCP_RESOURCE_DIR = "omnirush-ui-mcp";
export const OMNIRUSH_UI_MCP_ENTRY = "index.mjs";
export const OMNIRUSH_UI_CONTROL_DISCOVERY_FILE = "omnirush-ui-control.json";

export function bundledOmniRushUiMcpPath(resourcesPath) {
  return path.join(resourcesPath, OMNIRUSH_UI_MCP_RESOURCE_DIR, OMNIRUSH_UI_MCP_ENTRY);
}

/**
 * Resolve how the engine launches the UI-control MCP.
 *
 * - Dev mode (OMNIRUSH_DEV_MODE=1): the checkout's source entry under the
 *   developer's `node`, unchanged from before.
 * - Packaged: the bundled entry under this app's Electron binary with
 *   ELECTRON_RUN_AS_NODE=1, so no system Node or package registry is involved.
 * - Unpackaged non-dev runs: the checkout's source entry under this Electron
 *   binary in Node mode.
 *
 * @param {{
 *   devMode: boolean;
 *   packaged: boolean;
 *   execPath: string;
 *   resourcesPath?: string | null;
 *   repoRoot: string;
 *   userDataPath: string;
 *   exists?: (filePath: string) => boolean;
 * }} input
 * @returns {{ command: string[]; environment: Record<string, string> }}
 */
export function resolveOmniRushUiMcpLaunch(input) {
  const exists = input.exists ?? existsSync;
  const discovery = { OMNIRUSH_UI_CONTROL_DISCOVERY: path.join(input.userDataPath, OMNIRUSH_UI_CONTROL_DISCOVERY_FILE) };
  const sourceEntry = path.join(input.repoRoot, "packages", "omnirush-ui-mcp", OMNIRUSH_UI_MCP_ENTRY);

  if (input.devMode) {
    return { command: ["node", sourceEntry], environment: discovery };
  }

  if (input.packaged) {
    const bundled = input.resourcesPath ? bundledOmniRushUiMcpPath(input.resourcesPath) : null;
    if (!bundled || !exists(bundled)) {
      throw new Error("The OmniRush.ai UI-control MCP is missing from this build. Reinstall OmniRush.ai.");
    }
    return {
      command: [input.execPath, bundled],
      environment: { ...discovery, ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  if (!exists(sourceEntry)) {
    throw new Error("The OmniRush.ai UI-control MCP source is missing from this checkout.");
  }
  return {
    command: [input.execPath, sourceEntry],
    environment: { ...discovery, ELECTRON_RUN_AS_NODE: "1" },
  };
}
