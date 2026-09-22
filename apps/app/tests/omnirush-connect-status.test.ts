import { describe, expect, test } from "bun:test";

import {
  omniRushConnectAttentionTitle,
  resolveOmniRushConnectStateSummary,
  resolveOmniRushConnectStatus,
} from "../src/react-app/domains/connections/omnirush-connect-status";
import type { SessionCloudMcpMaintenanceState } from "../src/react-app/domains/connections/use-session-mcp-maintenance";

function maintenance(
  status: SessionCloudMcpMaintenanceState["status"],
): SessionCloudMcpMaintenanceState {
  return {
    status,
    issue: status === "failed"
      ? {
          code: "cloud_mcp_unavailable",
          stage: "engine_delivery",
          retryable: false,
          recommendedAction: "Run diagnostics",
          message: "Connected service tools could not be verified.",
        }
      : null,
    attempt: status === "retrying" ? 2 : 1,
    maxAttempts: 3,
  };
}

describe("omnirush.ai Connect status", () => {
  test("distinguishes missing, disabled, and unreadable Connect state", () => {
    expect(resolveOmniRushConnectStateSummary("missing", false)).toEqual({
      status: "not_configured",
      statusLabel: "Not configured",
      tone: "neutral",
      stageLabel: "Connect setup is not finished",
      recommendedAction: "Sign in to omnirush.ai Cloud to finish setup.",
    });
    expect(resolveOmniRushConnectStateSummary("available", false)).toEqual({
      status: "disabled",
      statusLabel: "Disabled",
      tone: "neutral",
      stageLabel: "Disabled by organization policy",
      recommendedAction: "Ask an organization admin to enable Connect.",
    });
    for (const status of ["invalid", "unreadable"] satisfies Array<"invalid" | "unreadable">) {
      expect(resolveOmniRushConnectStateSummary(status, false)).toEqual({
        status: "unavailable",
        statusLabel: "Needs attention",
        tone: "error",
        stageLabel: "Connect settings are unavailable",
        recommendedAction: "Restart omnirush.ai. If this continues, run diagnostics.",
      });
    }
  });

  test("labels the diagnosed message as one possible issue for native tooltips", () => {
    expect(omniRushConnectAttentionTitle("Connected service tools could not be verified."))
      .toBe("One possible issue: Connected service tools could not be verified.");
  });

  test("is hidden while signed out", () => {
    expect(resolveOmniRushConnectStatus(false, maintenance("ready"))).toBeNull();
  });

  test("shows the verified Cloud connection while workspace maintenance is idle", () => {
    expect(resolveOmniRushConnectStatus(true, undefined)).toEqual({
      state: "ready",
      label: "Ready",
      description: "Signed in to omnirush.ai Cloud. Connected service tools will be checked when a workspace is active.",
    });
    expect(resolveOmniRushConnectStatus(true, maintenance("idle"))).toMatchObject({
      state: "ready",
      label: "Ready",
    });
  });

  test("maps the active lifecycle to checking, ready, and needs attention", () => {
    expect(resolveOmniRushConnectStatus(true, maintenance("checking"))).toMatchObject({
      state: "checking",
      label: "Checking",
    });
    expect(resolveOmniRushConnectStatus(true, maintenance("retrying"))).toMatchObject({
      state: "checking",
      description: "Restoring connected service tools (2/3).",
    });
    expect(resolveOmniRushConnectStatus(true, maintenance("ready"))).toMatchObject({
      state: "ready",
      label: "Ready",
    });
    expect(resolveOmniRushConnectStatus(true, maintenance("failed"))).toEqual({
      state: "needs_attention",
      label: "Needs attention",
      description: "Connected service tools could not be verified.",
    });
    expect(resolveOmniRushConnectStatus(true, maintenance("skipped"))).toMatchObject({
      state: "needs_attention",
      label: "Needs attention",
    });
  });
});
