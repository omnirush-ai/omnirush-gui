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

  test("rejects disabled servers and ignores legacy re-enable values", () => {
    expect(mcpPolicyForConfig({})).toBe("disabled");
    expect(mcpAllowed({ mcpPolicy: "disabled" })).toBe(false);
    expect(() => assertMcpAllowed({ mcpPolicy: "disabled" })).toThrow(ApiError);
  });
});
