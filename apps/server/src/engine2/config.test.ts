import { describe, expect, test } from "bun:test";

import { buildEngine2Config, v2Mcp, v2Package, v2Permissions } from "./config.js";

/** Shaped like buildOmniRushRuntimeConfigObjectFromSnapshot's output (omnirush-runtime-config.ts). */
const runtime = {
  model: "omnirush/gpt-6-astra",
  enabled_providers: ["lpr_1", "omnirush"],
  permission: { bash: { "*": "ask", "git status*": "allow" }, edit: "allow", external_directory: { "/tmp/*": "allow" } },
  skills: { paths: ["/rt/skills"] },
  default_agent: "omnirush",
  subagent_depth: 3,
  agent: {
    omnirush: {
      description: "omnirush.ai default agent",
      mode: "primary",
      temperature: 0.2,
      prompt: "You are omnirush.",
      permission: { bash: { "*": "ask" }, skill: { "get-started": "deny" }, swarm_board: "deny" },
    },
    general: { permission: { task: "allow", skill: { "omnirush-swarm": "deny" } } },
  },
  plugin: ["/app/opencode-plugins/managed-policy.js"],
  mcp: {
    "omnirush-cloud": { type: "remote", url: "https://mcp.example/mcp", headers: { authorization: "Bearer x" }, enabled: true },
    local: { type: "local", command: ["node", "server.js"], environment: { A: "1" }, enabled: false, timeout: 5000 },
  },
  provider: {
    omnirush: {
      npm: "@ai-sdk/openai",
      name: "omnirush.ai",
      env: ["OMNIRUSH_ACCESS_TOKEN"],
      options: { baseURL: "http://127.0.0.1:9/omnirush-gateway/v1" },
      models: {
        "gpt-6-astra": {
          name: "GPT-6 Astra",
          tool_call: true,
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 400000, output: 128000 },
          variants: { high: { reasoning_effort: "high" }, low: { reasoning_effort: "low", disabled: true } },
        },
      },
    },
    lpr_1: { npm: "@ai-sdk/openai-compatible", name: "Mine", options: { baseURL: "https://llm.example/v1", headers: { "x-a": "1" } }, models: { m: {} } },
  },
};

describe("the 1.x runtime config as the 2.x engine config", () => {
  const config = buildEngine2Config({ v1: runtime, apiKeys: { lpr_1: "sk-live" }, plugins: ["/rt/engine2/omnirush-plugin"] });

  test("providers use the engine's native packages; delivered keys become settings", () => {
    expect(config.providers).toEqual({
      omnirush: {
        name: "omnirush.ai",
        env: ["OMNIRUSH_ACCESS_TOKEN"],
        package: "@opencode/ai/providers/openai",
        settings: { baseURL: "http://127.0.0.1:9/omnirush-gateway/v1" },
        models: {
          "gpt-6-astra": {
            name: "GPT-6 Astra",
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            variants: [{ id: "high", settings: { reasoning_effort: "high" } }],
            limit: { context: 400000, output: 128000 },
          },
        },
      },
      lpr_1: {
        name: "Mine",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "https://llm.example/v1", apiKey: "sk-live" },
        headers: { "x-a": "1" },
        models: { m: {} },
      },
    });
  });

  test("agents, permissions, depth, skills and plugins keep their meaning", () => {
    expect(config.model).toBe("omnirush/gpt-6-astra");
    expect(config.default_agent).toBe("omnirush");
    expect(config.experimental).toEqual({
      subagent_depth: 3,
      policies: [
        { action: "provider.use", resource: "*", effect: "deny" },
        { action: "provider.use", resource: "lpr_1", effect: "allow" },
        { action: "provider.use", resource: "omnirush", effect: "allow" },
      ],
    });
    expect(config.skills).toEqual(["/rt/skills"]);
    expect(config.plugins).toEqual(["/rt/engine2/omnirush-plugin"]);
    expect(config.permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "/tmp/*", effect: "allow" },
      { action: "execute", resource: "*", effect: "deny" },
    ]);
    expect(config.agents).toEqual({
      omnirush: {
        request: { body: { temperature: 0.2 } },
        system: "You are omnirush.",
        description: "omnirush.ai default agent",
        mode: "primary",
        permissions: [
          { action: "shell", resource: "*", effect: "ask" },
          { action: "skill", resource: "get-started", effect: "deny" },
          { action: "swarm_board", resource: "*", effect: "deny" },
        ],
      },
      general: {
        permissions: [
          { action: "subagent", resource: "*", effect: "allow" },
          { action: "skill", resource: "omnirush-swarm", effect: "deny" },
        ],
      },
    });
  });

  test("MCP servers keep direct tools (no code mode)", () => {
    expect(config.mcp).toEqual({
      servers: {
        "omnirush-cloud": { type: "remote", url: "https://mcp.example/mcp", headers: { authorization: "Bearer x" }, disabled: false, codemode: false },
        local: { type: "local", command: ["node", "server.js"], environment: { A: "1" }, disabled: true, timeout: { catalog: 5000, execution: 5000 }, codemode: false },
      },
    });
    expect(v2Mcp({ type: "remote", url: "https://x", oauth: { clientId: "c" } })).toEqual({ type: "remote", url: "https://x", oauth: { client_id: "c" }, codemode: false });
  });

  test("disabled policy never renders MCP servers", () => {
    expect(buildEngine2Config({ v1: runtime, mcpAllowed: false }).mcp).toBeUndefined();
  });

  test("packages and permission names", () => {
    expect(v2Package("@ai-sdk/anthropic")).toBe("@opencode/ai/providers/anthropic");
    expect(v2Package("@opencode-ai/ai/providers/openai")).toBe("@opencode/ai/providers/openai");
    expect(v2Package("some-provider")).toBe("aisdk:some-provider");
    expect(v2Permissions({ task: "deny", write: "ask" }, { webfetch: false })).toEqual([
      { action: "webfetch", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "ask" },
    ]);
  });
});
