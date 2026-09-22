import { describe, expect, test } from "bun:test";

import {
  isOmniRushUiMcpRegistryCommand,
  isOmniRushUiMcpRegistryEntry,
  withoutOmniRushUiMcpRegistryEntries,
} from "./omnirush-ui-mcp-command.js";

describe("registry launches of omnirush-ui-mcp", () => {
  test("matches every command that resolves the package by name", () => {
    for (const command of [
      ["npx", "-y", "omnirush-ui-mcp"],
      ["npx", "omnirush-ui-mcp"],
      ["npx", "--yes", "omnirush-ui-mcp@latest"],
      ["npx", "-y", "omnirush-ui-mcp@1.0.8", "--flag"],
      ["npx", "--package=omnirush-ui-mcp", "omnirush-ui"],
      ["npx", "-p", "omnirush-ui-mcp", "omnirush-ui"],
      ["/usr/local/bin/npx", "-y", "omnirush-ui-mcp"],
      ["C:\\Program Files\\nodejs\\npx.cmd", "-y", "omnirush-ui-mcp"],
      ["bunx", "omnirush-ui-mcp"],
      ["bun", "x", "omnirush-ui-mcp"],
      ["pnpm", "dlx", "omnirush-ui-mcp"],
      ["pnpx", "omnirush-ui-mcp"],
      ["yarn", "dlx", "omnirush-ui-mcp"],
      ["npm", "exec", "--yes", "--", "omnirush-ui-mcp"],
      ["npx", "-y", "npm:omnirush-ui-mcp"],
      ["npx", "-y", "OMNIRUSH-UI-MCP"],
      ["omnirush-ui-mcp"],
      ["sh", "-c", "npx -y omnirush-ui-mcp"],
      ["bash", "-lc", "cd /tmp && npx -y 'omnirush-ui-mcp'"],
      ["cmd", "/c", "npx", "-y", "omnirush-ui-mcp"],
    ]) {
      expect({ command, match: isOmniRushUiMcpRegistryCommand(command) }).toEqual({ command, match: true });
    }
  });

  test("does not match the bundled launch, a checkout path, or other packages", () => {
    for (const command of [
      [
        "/Applications/OmniRush.ai.app/Contents/MacOS/OmniRush.ai",
        "/Applications/OmniRush.ai.app/Contents/Resources/omnirush-ui-mcp/index.mjs",
      ],
      [
        "C:\\Users\\me\\AppData\\Local\\Programs\\OmniRush.ai\\OmniRush.ai.exe",
        "C:\\Users\\me\\AppData\\Local\\Programs\\OmniRush.ai\\resources\\omnirush-ui-mcp\\index.mjs",
      ],
      ["node", "/Users/me/OmniRush.ai/packages/omnirush-ui-mcp/index.mjs"],
      ["node", "packages/omnirush-ui-mcp"],
      ["npx", "-y", "@modelcontextprotocol/server-everything"],
      ["npx", "-y", "omnirush-ui-mcp-helper"],
      ["npx", "-y", "@acme/omnirush-ui-mcp"],
      [],
    ]) {
      expect({ command, match: isOmniRushUiMcpRegistryCommand(command) }).toEqual({ command, match: false });
    }
    expect(isOmniRushUiMcpRegistryCommand("npx -y omnirush-ui-mcp")).toBe(false);
    expect(isOmniRushUiMcpRegistryCommand(undefined)).toBe(false);
  });

  test("checks entries by command and filters them out of an MCP map", () => {
    const legacy = { type: "local", command: ["npx", "-y", "omnirush-ui-mcp"], enabled: false };
    const safe = { type: "local", command: ["node", "/opt/mcp/index.mjs"] };
    const remote = { type: "remote", url: "https://mcp.example.com/mcp" };
    expect(isOmniRushUiMcpRegistryEntry(legacy)).toBe(true);
    expect(isOmniRushUiMcpRegistryEntry(safe)).toBe(false);
    expect(isOmniRushUiMcpRegistryEntry(remote)).toBe(false);
    expect(isOmniRushUiMcpRegistryEntry(null)).toBe(false);

    const clean = { safe, remote };
    expect(withoutOmniRushUiMcpRegistryEntries(clean)).toBe(clean);
    expect(withoutOmniRushUiMcpRegistryEntries({ "omnirush-ui": legacy, ...clean })).toEqual(clean);
  });
});
