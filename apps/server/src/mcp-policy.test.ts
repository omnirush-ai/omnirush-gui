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
    expect(resolveMcpPolicyFromEnvironment({
      OMNIRUSH_MCP_POLICY: "enabled",
    })).toBe("disabled");
  });

  test("rejects resolved and legacy explicit policies while preserving bare fixtures", () => {
    expect(mcpPolicyForConfig({})).toBe("enabled");
    expect(mcpPolicyForConfig({ mcpPolicy: "enabled" })).toBe("disabled");
    expect(mcpAllowed({})).toBe(true);
    expect(mcpAllowed({ mcpPolicy: "disabled" })).toBe(false);
    expect(mcpAllowed({ mcpPolicy: "enabled" })).toBe(false);
    expect(() => assertMcpAllowed({ mcpPolicy: "disabled" })).toThrow(ApiError);
    expect(() => assertMcpAllowed({ mcpPolicy: "enabled" })).toThrow(ApiError);
  });
});
