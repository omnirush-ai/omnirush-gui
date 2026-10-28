import { expect, test } from "bun:test";

import { engineV2SpawnEnv } from "../managed-opencode-v2.js";
import { applyStockSwitches, STOCK_SWITCHES, stockMode, stockProviders, stockShellEnv } from "./stock-mode.mjs";

const base = { PATH: "/usr/bin", OMNIRUSH_NO_SYSTEM_CONFIG: "1" };

test("stock mode is on only when asked, and sets the CLI's switches", () => {
  expect(stockMode({})).toBe(false);
  expect(stockMode({ OMNIRUSH_FARM: "0" })).toBe(false);
  for (const value of ["1", "true", " ON ", "yes"]) expect(stockMode({ OMNIRUSH_FARM: value })).toBe(true);
  const off: Record<string, string> = {};
  expect(applyStockSwitches(off)).toBe(false);
  expect(off).toEqual({});
  const on: Record<string, string> = { OMNIRUSH_FARM: "true" };
  expect(applyStockSwitches(on)).toBe(true);
  expect(on).toEqual({ ...STOCK_SWITCHES });
  expect(on.OMNIRUSH_FARM).toBe("1");
  expect(on.OMNIRUSH_INSTALL_LOG).toBe("0");
  expect(on.OMNIRUSH_COMPUTER_USE).toBe("0");
});

test("the engine gets the gateway's GPT 6 Astra only, without our web search option", () => {
  const astra = { id: "gpt-6-astra", name: "GPT 6 Astra", config: { reasoning: true, options: { reasoningEffort: "high", hostedWebSearch: { searchContextSize: "low" } } } };
  const specs = [
    { id: "omnirush", name: "OmniRush", apiKey: "k", models: [astra, { id: "kimi-k3.1-pro", name: "Kimi", config: {} }] },
    { id: "omnirush-claude", name: "Claude", apiKey: "k", models: [{ id: "opus", name: "Opus", config: {} }] },
  ];
  const out = stockProviders(specs);
  expect(out.map((spec) => spec.id)).toEqual(["omnirush"]);
  expect(out[0]!.models.map((model) => model.id)).toEqual(["gpt-6-astra"]);
  expect(out[0]!.models[0]!.config).toEqual({ reasoning: true, options: { reasoningEffort: "high" } });
  expect(astra.config.options.hostedWebSearch).toBeDefined();
  expect(stockProviders([{ ...specs[0]!, models: [specs[0]!.models[1]!] }])).toEqual([]);
});

test("the engine gate lets only the gateway and no MCP server through in stock mode", () => {
  const normal = engineV2SpawnEnv({ ...base }, ["computer"]);
  expect(normal.OMNIRUSH_GATE_PROVIDERS).toBe("omnirush,omnirush-claude");
  expect(normal.OMNIRUSH_GATE_MCP).toContain("computer");
  const stock = engineV2SpawnEnv({ ...base, OMNIRUSH_FARM: "1" }, ["computer"]);
  expect(stock.OMNIRUSH_GATE_PROVIDERS).toBe("omnirush");
  expect(stock.OMNIRUSH_GATE_MCP).toBe("");
});

test("a stock-mode agent shell has stock OpenCode's names, launch PATH and CA file", () => {
  // The names the 3.8.1 desktop gave a stock-mode agent shell (evidence release-381-prep/stock-env), values made up.
  const names = ["AGENT", "AI_AGENT", "HOME", "LANG", "NODE_EXTRA_CA_CERTS", "OMNIRUSH_ACCESS_TOKEN", "OMNIRUSH_FARM",
    "OMNIRUSH_GATE_MCP", "OMNIRUSH_GATE_PROVIDERS", "OMNIRUSH_NO_SYSTEM_CONFIG", "OMNIRUSH_POLICY_TOKEN", "OMNIRUSH_PROVIDER_ALLOW",
    "OMNIRUSH_PROVIDER_LOCK", "OMNIRUSH_PROVIDER_LOCK_MESSAGE", "OMNIRUSH_SERVER_TOKEN", "OMNIRUSH_SERVER_URL",
    "OMNIRUSH_USER_XDG_CONFIG_HOME", "OMNIRUSH_USER_XDG_DATA_HOME", "OMNIRUSH_USER_XDG_STATE_HOME", "OPENCODE", "OPENCODE_CONFIG_DIR",
    "OPENCODE_DB", "OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_PASSWORD",
    "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME", "OPENCODE_SESSION_ID", "OPENCODE_TERMINAL", "PATH", "PWD", "SHLVL", "TERM",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"];
  const shell: Record<string, string | undefined> = Object.fromEntries(names.map((name) => [name, "x"]));
  shell.PATH = "/app/sidecars:/usr/local/sbin:/usr/bin";
  const engine = { OPENCODE_CONFIG_DIR: "/state/config", OMNIRUSH_STOCK_SHELL_ENV: JSON.stringify({ PATH: "/usr/bin" }) };
  stockShellEnv(shell, engine);
  // Stock's names (evidence envn-oc) with the rig's launch LANG; `_` is the shell's own.
  expect(Object.keys(shell).sort()).toEqual(["AGENT", "AI_AGENT", "HOME", "LANG", "OPENCODE", "OPENCODE_CONFIG",
    "OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_SESSION_ID", "OPENCODE_TERMINAL", "PATH", "PWD", "SHLVL", "TERM",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]);
  expect(shell.PATH).toBe("/usr/bin");
  expect(shell.OPENCODE_CONFIG).toBe("/state/config/opencode.json");
  // A CA file the user launched with is theirs; without the desktop's launch record the engine's PATH stays.
  const own: Record<string, string> = { Path: "C:\\app;C:\\Windows", NODE_EXTRA_CA_CERTS: "/app/ca.pem" };
  stockShellEnv(own, { OMNIRUSH_STOCK_SHELL_ENV: JSON.stringify({ PATH: "C:\\Windows", NODE_EXTRA_CA_CERTS: "/me/ca.pem" }) });
  expect(own).toEqual({ Path: "C:\\Windows", NODE_EXTRA_CA_CERTS: "/me/ca.pem" });
  const bare: Record<string, string> = { PATH: "/engine/bin", OMNIRUSH_FARM: "1" };
  expect(stockShellEnv(bare, {})).toEqual({ PATH: "/engine/bin" });
});
