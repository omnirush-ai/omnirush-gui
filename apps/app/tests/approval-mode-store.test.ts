import { describe, expect, test } from "bun:test";

import { approvalModeKey, loadApprovalMode, markApprovalChange, useApprovalModeStore } from "../src/react-app/domains/settings/approval-mode";

type Approvals = { mode: "guarded" | "full"; source: "environment" | "settings" | "default"; setting: "guarded" | "full" | null };

const full: Approvals = { mode: "full", source: "settings", setting: "full" };
const guarded: Approvals = { mode: "guarded", source: "default", setting: null };

describe("approval mode store", () => {
  test("a load that started before a change cannot overwrite the new mode", async () => {
    let release: (value: Approvals) => void = () => {};
    const held = new Promise<Approvals>((resolve) => { release = resolve; });
    const client = {
      baseUrl: "http://127.0.0.1:65530",
      getRuntimeApprovals: () => held,
      setRuntimeApprovals: async () => full,
      reloadEngine: async () => ({}),
    } as never;
    const key = approvalModeKey(client);
    const pendingLoad = loadApprovalMode(client);

    // The change starts and completes while the old load is still in flight.
    markApprovalChange(key);
    const { patch } = useApprovalModeStore.getState();
    patch(key, { busy: true, status: "Turning full permissions on…" });
    patch(key, { approvals: full, busy: false, status: "Full permissions on. Engine reloaded." });

    release(guarded);
    await pendingLoad;
    expect(useApprovalModeStore.getState().byServer[key]?.approvals?.mode).toBe("full");
  });

  test("a fresh load after the change still applies", async () => {
    const client = {
      baseUrl: "http://127.0.0.1:65531",
      getRuntimeApprovals: async () => guarded,
      setRuntimeApprovals: async () => full,
      reloadEngine: async () => ({}),
    } as never;
    const key = approvalModeKey(client);
    markApprovalChange(key);
    await loadApprovalMode(client);
    expect(useApprovalModeStore.getState().byServer[key]?.approvals?.mode).toBe("guarded");
  });
});
