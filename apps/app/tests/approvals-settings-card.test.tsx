import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { OmniRushApprovalMode, OmniRushRuntimeApprovals } from "../src/app/lib/omnirush-server";
import {
  FULL_PERMISSIONS_HELP,
  applyFullPermissions,
  type ApprovalsClient,
} from "../src/react-app/domains/settings/approval-mode";
import { ApprovalsCard, BestPracticesCard } from "../src/react-app/domains/settings/pages/general-view";
import { BEST_PRACTICES_HELP, bestPracticesChangeMessage } from "../src/react-app/domains/settings/best-practices";

function fakeClient(options: { reloadError?: Error } = {}) {
  const calls: string[] = [];
  let approvals: OmniRushRuntimeApprovals = { mode: "guarded", source: "default", setting: null };
  const client: ApprovalsClient = {
    getRuntimeApprovals: async () => approvals,
    setRuntimeApprovals: async (mode: OmniRushApprovalMode) => {
      calls.push(`set:${mode}`);
      approvals = { mode, source: "settings", setting: mode };
      return { ...approvals, ok: true, changed: true };
    },
    reloadEngine: async (workspaceId: string) => {
      calls.push(`reload:${workspaceId}`);
      if (options.reloadError) throw options.reloadError;
      return { ok: true };
    },
  };
  return { client, calls };
}

/** The Base UI switch root: `aria-checked` carries the mode, `aria-disabled` the locked state. */
function switchMarkup(markup: string): string {
  const match = markup.match(/<[a-z]+[^>]*role="switch"[^>]*>/);
  if (!match) throw new Error(`no switch in ${markup}`);
  return match[0];
}

describe("approvals settings card", () => {
  test("shows the switch with its helper text and reflects the current mode", () => {
    const markup = renderToStaticMarkup(
      <ApprovalsCard approvals={{ mode: "full", source: "settings", setting: "full" }} busy={false} status="" onToggle={() => {}} />,
    );
    expect(markup).toContain("Approvals");
    expect(markup).toContain("Full permissions");
    expect(markup).toContain(FULL_PERMISSIONS_HELP);
    expect(switchMarkup(markup)).toContain('aria-checked="true"');
    expect(switchMarkup(markup)).not.toContain('aria-disabled="true"');
    expect(markup).not.toContain("Set by environment");

    const off = renderToStaticMarkup(
      <ApprovalsCard approvals={{ mode: "guarded", source: "default", setting: null }} busy={false} status="Guarded mode. Engine reloaded." onToggle={() => {}} />,
    );
    expect(switchMarkup(off)).toContain('aria-checked="false"');
    expect(off).toContain("Guarded mode. Engine reloaded.");
  });

  test("disables the switch and says so while the environment forces the mode", () => {
    const markup = renderToStaticMarkup(
      <ApprovalsCard approvals={{ mode: "full", source: "environment", setting: "guarded" }} busy={false} status="" onToggle={() => {}} />,
    );
    expect(switchMarkup(markup)).toContain('aria-checked="true"');
    expect(switchMarkup(markup)).toContain('aria-disabled="true"');
    expect(markup).toContain("Set by environment (OMNIRUSH_APPROVALS=full)");
    // Nothing is claimed before the server has answered.
    const loading = renderToStaticMarkup(<ApprovalsCard approvals={null} busy={false} status="" onToggle={() => {}} />);
    expect(switchMarkup(loading)).toContain('aria-disabled="true"');
  });

  test("toggling persists the mode, then reloads the workspace engine", async () => {
    const { client, calls } = fakeClient();
    const on = await applyFullPermissions(client, "ws_1", true);
    expect(calls).toEqual(["set:full", "reload:ws_1"]);
    expect(on.approvals).toEqual({ mode: "full", source: "settings", setting: "full" });
    expect(on.status).toBe("Full permissions on. Engine reloaded.");
    expect(on.tone).toBe("success");

    const off = await applyFullPermissions(client, "ws_1", false);
    expect(calls.slice(2)).toEqual(["set:guarded", "reload:ws_1"]);
    expect(off.status).toBe("Guarded mode. Engine reloaded.");
    expect(off.tone).toBe("success");
    expect(await client.getRuntimeApprovals()).toEqual({ mode: "guarded", source: "settings", setting: "guarded" });
  });

  test("keeps the saved setting and explains when the reload fails or no workspace is active", async () => {
    const failing = fakeClient({ reloadError: new Error("engine busy") });
    const result = await applyFullPermissions(failing.client, "ws_1", true);
    expect(failing.calls).toEqual(["set:full", "reload:ws_1"]);
    expect(result.approvals.mode).toBe("full");
    expect(result.status).toBe("Full permissions on. Engine reload failed: engine busy Use Reload in Settings to apply it.");
    expect(result.tone).toBe("warning");

    const idle = fakeClient();
    const saved = await applyFullPermissions(idle.client, null, true);
    expect(idle.calls).toEqual(["set:full"]);
    expect(saved.status).toBe("Full permissions on. Reload the engine to apply it.");
    expect(saved.tone).toBe("warning");
  });
});

describe("best practices settings card", () => {
  test("labels the switch, describes only guides, and waits for the server choice", () => {
    const on = renderToStaticMarkup(<BestPracticesCard enabled={true} busy={false} status="" onToggle={() => {}} />);
    expect(on).toContain(BEST_PRACTICES_HELP);
    expect(switchMarkup(on)).toContain('aria-label="Best practices"');
    expect(switchMarkup(on)).toContain('aria-describedby="best-practices-help"');
    expect(switchMarkup(on)).toContain('aria-checked="true"');
    expect(on.toLowerCase()).not.toContain("upload");
    const loading = renderToStaticMarkup(<BestPracticesCard enabled={null} busy={false} status="" onToggle={() => {}} />);
    expect(switchMarkup(loading)).toContain('aria-disabled="true"');
    const off = renderToStaticMarkup(<BestPracticesCard enabled={false} busy={true} status="Saving best practices…" onToggle={() => {}} />);
    expect(switchMarkup(off)).toContain('aria-checked="false"');
    expect(switchMarkup(off)).toContain('aria-disabled="true"');
    expect(off).toContain('role="status"');
  });

  test("distinguishes applied, deferred, failed, and not started choices", () => {
    const result = { ok: true, changed: true, enabled: false };
    expect(bestPracticesChangeMessage({ ...result, engine: { status: "applied" } })).toBe("Best practices off. Ready for your next request.");
    expect(bestPracticesChangeMessage({ ...result, engine: { status: "deferred" } })).toBe("Best practices off saved. This change waits until the engine is idle.");
    expect(bestPracticesChangeMessage({ ...result, engine: { status: "failed" } })).toBe("Best practices off saved. Engine reload failed. Use Reload in Settings to apply it.");
    expect(bestPracticesChangeMessage({ ...result, engine: { status: "unconfigured" } })).toBe("Best practices off saved. The choice will apply when the engine starts.");
  });
});
