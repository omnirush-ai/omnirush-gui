import { afterEach, describe, expect, test } from "bun:test";

import { MCP_QUICK_CONNECT } from "../src/app/constants";
import { createOmniRushServerClient } from "../src/app/lib/omnirush-server";
import { createOmniRushServerStore } from "../src/react-app/domains/connections/omnirush-server-store";
import type { McpDirectoryInfo } from "../src/app/constants";
import { submitMcpEntry } from "../src/react-app/domains/connections/modals/add-mcp-submission";
import type { OmniRushServerStore } from "../src/react-app/domains/connections/omnirush-server-store";
import { createConnectionsStore } from "../src/react-app/domains/connections/store";

const originalWindow = globalThis.window;

function installDesktopWindow() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __OMNIRUSH_ELECTRON__: {} },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("local MCP server recovery", () => {
  test("returns submission feedback when local server recovery never settles", async () => {
    installDesktopWindow();
    let recoveryAttempts = 0;
    const stalledRecovery = new Promise<never>(() => undefined);
    const omnirushServer = {
      getSnapshot: () => ({
        omnirushServerStatus: "disconnected",
        omnirushServerClient: null,
        omnirushServerCapabilities: null,
      }),
      ensureLocalOmniRushServerClient: () => {
        recoveryAttempts += 1;
        return stalledRecovery;
      },
    } as unknown as OmniRushServerStore;
    const store = createConnectionsStore({
      checkDesktopAppRestriction: () => false,
      client: () => null,
      setClient: () => undefined,
      projectDir: () => "/tmp/omnirush-mcp-recovery",
      selectedWorkspaceId: () => "workspace_local",
      selectedWorkspaceRoot: () => "/tmp/omnirush-mcp-recovery",
      workspaceType: () => "local",
      omnirushServer,
      runtimeWorkspaceId: () => null,
      ensureRuntimeWorkspaceId: async () => "workspace_local",
      localOmniRushServerRecoveryTimeoutMs: 10,
      developerMode: () => false,
    });
    const entry: McpDirectoryInfo = {
      name: "Stalled recovery",
      description: "",
      type: "remote",
      url: "https://example.com/mcp",
      oauth: true,
      managedOAuth: true,
    };

    const result = await Promise.race([
      submitMcpEntry(store.connectMcp, entry, "Fallback error"),
      new Promise<"still pending">((resolve) => setTimeout(() => resolve("still pending"), 250)),
    ]);

    expect(recoveryAttempts).toBe(1);
    expect(result).not.toBe("still pending");
    expect(result).not.toBeNull();
    expect(store.getSnapshot().mcpConnectingName).toBeNull();
  });
});

describe("bundled Computer Use setup", () => {
  async function connectWithHelper(command: string[] | null) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __OMNIRUSH_ELECTRON__: { invokeDesktop: async (name: string) => name === "getComputerUseMcpCommand" ? command : null } },
    });
    const server = createOmniRushServerStore({
      startupPreference: () => "server", documentVisible: () => true, developerMode: () => false,
      runtimeWorkspaceId: () => "setup-workspace", activeClient: () => null,
      selectedWorkspaceDisplay: () => ({ id: "setup-workspace", name: "Setup", path: "/tmp/setup", preset: "starter", workspaceType: "local" }),
      restartLocalServer: async () => false, createRemoteWorkspaceFlow: async () => false,
    });
    const saved: Array<Parameters<ReturnType<typeof createOmniRushServerClient>["addMcp"]>[1]> = [];
    const client = {
      ...createOmniRushServerClient({ baseUrl: "http://127.0.0.1:1" }),
      addMcp: async (_workspace: string, payload: Parameters<ReturnType<typeof createOmniRushServerClient>["addMcp"]>[1]) => { saved.push(payload); return { items: [] }; },
      listMcp: async () => ({ items: [] }),
    };
    const getSnapshot: typeof server.getSnapshot = () => ({ ...server.getSnapshot(), omnirushServerStatus: "connected", omnirushServerClient: client });
    const store = createConnectionsStore({
      checkDesktopAppRestriction: () => false, client: () => null, setClient: () => {},
      projectDir: () => "/tmp/setup", selectedWorkspaceId: () => "setup-workspace", selectedWorkspaceRoot: () => "/tmp/setup",
      workspaceType: () => "local", omnirushServer: { ...server, getSnapshot }, runtimeWorkspaceId: () => "setup-workspace", developerMode: () => false,
    });
    const entry = MCP_QUICK_CONNECT.find((entry) => entry.id === "computer-use");
    if (!entry) throw new Error("Computer Use catalog entry missing");
    expect(entry.command).toEqual([]);
    const result = await store.connectMcp(entry);
    return { result, saved };
  }

  test("resolves the desktop helper before validating the empty catalog command", async () => {
    const command = ["/Applications/omnirush.ai.app/Contents/Resources/helpers/omnirush.ai Computer Use.app/Contents/MacOS/ComputerUse", "mcp"];
    const { result, saved } = await connectWithHelper(command);
    expect(result).toEqual({ ok: true });
    expect(saved).toEqual([{ name: "computer-use", config: { type: "local", enabled: true, command } }]);
  });

  test("missing helper returns an actionable error without saving a connection", async () => {
    const { result, saved } = await connectWithHelper(null);
    expect(result).toEqual({ ok: false, error: "Computer Use requires the bundled omnirush.ai helper on macOS." });
    expect(saved).toEqual([]);
  });
});

describe("bundled UI-control setup", () => {
  const bundledCommand = [
    "/Applications/OmniRush.ai.app/Contents/MacOS/OmniRush.ai",
    "/Applications/OmniRush.ai.app/Contents/Resources/omnirush-ui-mcp/index.mjs",
  ];
  const bundledEnvironment = {
    ELECTRON_RUN_AS_NODE: "1",
    OMNIRUSH_UI_CONTROL_DISCOVERY: "/Users/me/Library/Application Support/ai.omnirush.desktop/omnirush-ui-control.json",
  };

  async function connectUiControl(desktop: {
    command?: () => Promise<unknown>;
    environment?: () => Promise<unknown>;
  } | null) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __OMNIRUSH_ELECTRON__: desktop
          ? {
            invokeDesktop: async (name: string) => {
              if (name === "getOmniRushUiMcpCommand") return desktop.command ? desktop.command() : null;
              if (name === "getOmniRushUiMcpEnvironment") return desktop.environment ? desktop.environment() : null;
              return null;
            },
          }
          : {},
      },
    });
    const server = createOmniRushServerStore({
      startupPreference: () => "server", documentVisible: () => true, developerMode: () => false,
      runtimeWorkspaceId: () => "setup-workspace", activeClient: () => null,
      selectedWorkspaceDisplay: () => ({ id: "setup-workspace", name: "Setup", path: "/tmp/setup", preset: "starter", workspaceType: "local" }),
      restartLocalServer: async () => false, createRemoteWorkspaceFlow: async () => false,
    });
    const saved: Array<Parameters<ReturnType<typeof createOmniRushServerClient>["addMcp"]>[1]> = [];
    const client = {
      ...createOmniRushServerClient({ baseUrl: "http://127.0.0.1:1" }),
      addMcp: async (_workspace: string, payload: Parameters<ReturnType<typeof createOmniRushServerClient>["addMcp"]>[1]) => { saved.push(payload); return { items: [] }; },
      listMcp: async () => ({ items: [] }),
    };
    const getSnapshot: typeof server.getSnapshot = () => ({ ...server.getSnapshot(), omnirushServerStatus: "connected", omnirushServerClient: client });
    const store = createConnectionsStore({
      checkDesktopAppRestriction: () => false, client: () => null, setClient: () => {},
      projectDir: () => "/tmp/setup", selectedWorkspaceId: () => "setup-workspace", selectedWorkspaceRoot: () => "/tmp/setup",
      workspaceType: () => "local", omnirushServer: { ...server, getSnapshot }, runtimeWorkspaceId: () => "setup-workspace", developerMode: () => false,
    });
    const entry = MCP_QUICK_CONNECT.find((item) => item.serverName === "omnirush-ui");
    if (!entry) throw new Error("UI-control catalog entry missing");
    const result = await store.connectMcp(entry);
    return { entry, result, saved };
  }

  test("the catalog carries no npx fallback for the unpublished package", () => {
    const entry = MCP_QUICK_CONNECT.find((item) => item.serverName === "omnirush-ui");
    expect(entry?.command).toEqual([]);
    expect(JSON.stringify(MCP_QUICK_CONNECT)).not.toContain("omnirush-ui-mcp");
  });

  test("saves the bundled desktop launch with its Node-mode environment", async () => {
    const { result, saved } = await connectUiControl({
      command: async () => bundledCommand,
      environment: async () => bundledEnvironment,
    });
    expect(result).toEqual({ ok: true });
    expect(saved).toEqual([{
      name: "omnirush-ui",
      config: { type: "local", enabled: true, command: bundledCommand, environment: bundledEnvironment },
    }]);
    expect(JSON.stringify(saved)).not.toContain("npx");
  });

  test("a missing bundle fails without saving an npx command", async () => {
    const { result, saved } = await connectUiControl({
      command: async () => { throw new Error("The OmniRush.ai UI-control MCP is missing from this build. Reinstall OmniRush.ai."); },
      environment: async () => bundledEnvironment,
    });
    expect(result).toEqual({ ok: false, error: "The OmniRush.ai UI-control MCP is missing from this build. Reinstall OmniRush.ai." });
    expect(saved).toEqual([]);
  });

  test("outside the desktop app it fails without saving anything", async () => {
    const { result, saved } = await connectUiControl(null);
    expect(result.ok).toBe(false);
    expect(saved).toEqual([]);
  });

  test("never saves the app binary without ELECTRON_RUN_AS_NODE", async () => {
    const { result, saved } = await connectUiControl({
      command: async () => bundledCommand,
      environment: async () => { throw new Error("bridge unavailable"); },
    });
    expect(result).toEqual({ ok: false, error: "bridge unavailable" });
    expect(saved).toEqual([]);
  });
});
