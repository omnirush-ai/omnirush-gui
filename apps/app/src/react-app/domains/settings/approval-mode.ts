// Shared approval-mode state. The Settings > General "Approvals" card and the
// composer's "Full permissions" switch both read it through useApprovalMode,
// so they show the same mode and a change in either updates the other at once.
// State is keyed by server (client.baseUrl): the mode is a server-wide setting,
// not a workspace one, and a remote workspace talks to a different server.
import { useCallback, useEffect } from "react";
import { create } from "zustand";

import type { OmniRushRuntimeApprovals, OmniRushServerClient } from "@/app/lib/omnirush-server";
import { reloadEngineWithDesktopFallback } from "@/react-app/shell/engine-reload-escalation";

export type ApprovalsClient = Pick<OmniRushServerClient, "getRuntimeApprovals" | "setRuntimeApprovals" | "reloadEngine"> & {
  /** Keys the shared state; clients without one share a single entry. */
  baseUrl?: string;
};

export const FULL_PERMISSIONS_HELP = "Runs every command and edits files without asking. Organisation policies still apply.";

/** Shown while OMNIRUSH_APPROVALS in the launch environment forces the mode. */
export function approvalsEnvironmentHint(approvals: OmniRushRuntimeApprovals): string | null {
  if (approvals.source !== "environment") return null;
  return `Set by environment (OMNIRUSH_APPROVALS=${approvals.mode}); change it where the app is launched.`;
}

export type FullPermissionsOutcome = {
  approvals: OmniRushRuntimeApprovals;
  status: string;
  /** "success" once the engine reloaded; "warning" when the setting is saved but the engine still needs a reload. */
  tone: "success" | "warning";
};

/**
 * Persist the approval mode, then reload the engine the way Settings "Reload"
 * does (a manual reload bypasses the fingerprint guard) so the new permission
 * rules apply within seconds. A failed reload keeps the saved setting and says
 * what to do next.
 */
export async function applyFullPermissions(
  client: ApprovalsClient,
  workspaceId: string | null,
  enabled: boolean,
): Promise<FullPermissionsOutcome> {
  const { mode, source, setting } = await client.setRuntimeApprovals(enabled ? "full" : "guarded");
  const approvals: OmniRushRuntimeApprovals = { mode, source, setting };
  const label = mode === "full" ? "Full permissions on." : "Guarded mode.";
  if (!workspaceId) return { approvals, status: `${label} Reload the engine to apply it.`, tone: "warning" };
  try {
    await reloadEngineWithDesktopFallback(client, workspaceId);
    return { approvals, status: `${label} Engine reloaded.`, tone: "success" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { approvals, status: `${label} Engine reload failed: ${reason} Use Reload in Settings to apply it.`, tone: "warning" };
  }
}

export type ApprovalModeEntry = {
  /** Null until the server has answered (or while the load keeps failing). */
  approvals: OmniRushRuntimeApprovals | null;
  /** True while a change persists and the engine reloads. */
  busy: boolean;
  /** The last load or change result, or the error to act on. */
  status: string;
};

const EMPTY_ENTRY: ApprovalModeEntry = { approvals: null, busy: false, status: "" };

type ApprovalModeStore = {
  byServer: Record<string, ApprovalModeEntry>;
  patch: (key: string, patch: Partial<ApprovalModeEntry>) => void;
};

export const useApprovalModeStore = create<ApprovalModeStore>((set) => ({
  byServer: {},
  patch: (key, patch) =>
    set((state) => ({
      byServer: { ...state.byServer, [key]: { ...(state.byServer[key] ?? EMPTY_ENTRY), ...patch } },
    })),
}));

export function approvalModeKey(client: ApprovalsClient): string {
  return client.baseUrl?.trim() || "default";
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const inflightLoads = new Map<string, Promise<void>>();
// Bumped whenever a change starts so a load that began before the change
// cannot overwrite the new mode with the value it fetched earlier.
const changeSequence = new Map<string, number>();

/** Record that a change is starting so earlier in-flight loads are ignored. */
export function markApprovalChange(key: string): void {
  changeSequence.set(key, (changeSequence.get(key) ?? 0) + 1);
}

/** Fetch the mode; components mounting at the same time share one request. */
export function loadApprovalMode(client: ApprovalsClient): Promise<void> {
  const key = approvalModeKey(client);
  const pending = inflightLoads.get(key);
  if (pending) return pending;
  const { patch } = useApprovalModeStore.getState();
  const startedAt = changeSequence.get(key) ?? 0;
  const task = client.getRuntimeApprovals()
    .then((approvals) => {
      const stale = (changeSequence.get(key) ?? 0) !== startedAt || useApprovalModeStore.getState().byServer[key]?.busy;
      if (!stale) patch(key, { approvals });
    })
    .catch((error: unknown) => patch(key, { status: messageOf(error, "The approval mode could not be loaded.") }))
    .finally(() => {
      inflightLoads.delete(key);
    });
  inflightLoads.set(key, task);
  return task;
}

export type ApprovalModeChange = {
  approvals: OmniRushRuntimeApprovals | null;
  status: string;
  tone: "success" | "warning" | "error";
};

/**
 * The approval mode of the server behind `client`, loaded on mount, and the
 * action that changes it. `workspaceId` names the engine to reload afterwards;
 * without one the setting is saved and the status asks for a reload.
 */
export function useApprovalMode(client: ApprovalsClient | null, workspaceId: string | null) {
  const key = client ? approvalModeKey(client) : null;
  const entry = useApprovalModeStore((state) => (key ? state.byServer[key] : undefined)) ?? EMPTY_ENTRY;

  useEffect(() => {
    if (!client) return;
    void loadApprovalMode(client);
  }, [client]);

  const setFullPermissions = useCallback(async (enabled: boolean): Promise<ApprovalModeChange | null> => {
    if (!client || !key) return null;
    const { patch } = useApprovalModeStore.getState();
    markApprovalChange(key);
    patch(key, { busy: true, status: enabled ? "Turning full permissions on…" : "Switching to guarded mode…" });
    try {
      const outcome = await applyFullPermissions(client, workspaceId, enabled);
      patch(key, { approvals: outcome.approvals, busy: false, status: outcome.status });
      return outcome;
    } catch (error) {
      const status = messageOf(error, "The approval mode could not be saved.");
      patch(key, { busy: false, status });
      return { approvals: useApprovalModeStore.getState().byServer[key]?.approvals ?? null, status, tone: "error" };
    }
  }, [client, key, workspaceId]);

  return { approvals: entry.approvals, busy: entry.busy, status: entry.status, setFullPermissions };
}
