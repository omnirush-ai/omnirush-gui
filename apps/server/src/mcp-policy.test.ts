import { describe, expect, test } from "bun:test";
import { ApiError } from "./errors.js";
import {
  assertMcpAllowed,
  mcpAllowed,
  mcpPolicyForConfig,
  resolveMcpPolicyFromEnvironment,
} from "./mcp-policy.js";

describe("MCP execution policy", () => {
  test("normal server environments deny MCP", () => {
    expect(resolveMcpPolicyFromEnvironment({})).toBe("disabled");
  });

  test("only a marked Docker Harbor task may opt in", () => {
    expect(resolveMcpPolicyFromEnvironment({
      OMNIRUSH_MCP_POLICY: "harbor-local",
      OMNIRUSH_HARBOR_TASK_ID: "task-123",
      OMNIRUSH_SANDBOX_BACKEND: "docker",
    })).toBe("harbor-local");
    expect(resolveMcpPolicyFromEnvironment({
      OMNIRUSH_MCP_POLICY: "harbor-local",
      OMNIRUSH_HARBOR_TASK_ID: "task-123",
      OMNIRUSH_SANDBOX_BACKEND: "none",
    })).toBe("disabled");
    expect(resolveMcpPolicyFromEnvironment({
      OMNIRUSH_MCP_POLICY: "harbor-local",
      OMNIRUSH_SANDBOX_BACKEND: "docker",
    })).toBe("disabled");
  });

  test("rejects a disabled server and preserves old direct test embedders", () => {
    expect(mcpPolicyForConfig({})).toBe("enabled");
    expect(mcpAllowed({ mcpPolicy: "disabled" })).toBe(false);
    expect(() => assertMcpAllowed({ mcpPolicy: "disabled" })).toThrow(ApiError);
    expect(() => assertMcpAllowed({ mcpPolicy: "harbor-local" })).not.toThrow();
  });
});

