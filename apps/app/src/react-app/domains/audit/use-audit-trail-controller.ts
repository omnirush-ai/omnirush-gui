import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { OmniRushServerClient, OmniRushSessionSnapshot, OmniRushAuditEntry } from "@/app/lib/omnirush-server";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { snapshotKey } from "@/react-app/domains/session/sync/session-sync";
import { normalizeWorkspaceAuditEntries } from "./normalize-workspace-audit";
import { createAuditTrailExport, projectSessionAudit } from "./project-session-audit";
import type { AuditTrailRecord } from "./audit-trail-types";

export type AuditTrailControllerOptions = {
  workspaceId: string;
  sessionId: string | null;
  workspacePath?: string;
  client?: OmniRushServerClient | null;
  open: boolean;
};

const EMPTY_SNAPSHOT: OmniRushSessionSnapshot | null = null;

/** Connects the sidebar trail to existing session and workspace caches. */
export function useAuditTrailController(options: AuditTrailControllerOptions) {
  const { workspaceId, sessionId, workspacePath, client, open } = options;
  const [filter, setFilter] = useState<"task" | "workspace">("task");
  const queryClient = getReactQueryClient();
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  useEffect(() => {
    if (!sessionId) return;
    return queryClient.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey;
      if (key[0] === "react-session-snapshot" && key[1] === workspaceId && key[2] === sessionId) setSnapshotVersion((value) => value + 1);
    });
  }, [queryClient, workspaceId, sessionId]);
  const currentSnapshot = sessionId
    ? queryClient.getQueryData<OmniRushSessionSnapshot>(snapshotKey(workspaceId, sessionId)) ?? EMPTY_SNAPSHOT
    : EMPTY_SNAPSHOT;

  const auditQuery = useQuery<{ items: OmniRushAuditEntry[] }>({
    queryKey: ["audit-trail-workspace", workspaceId],
    queryFn: () => client?.listAudit(workspaceId, 50) ?? Promise.resolve({ items: [] }),
    enabled: open && Boolean(client && workspaceId),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const records = useMemo(() => {
    const taskRecords = currentSnapshot && sessionId
      ? projectSessionAudit(currentSnapshot, { workspaceId, sessionId, workspacePath })
      : [];
    const workspaceRecords = normalizeWorkspaceAuditEntries(auditQuery.data?.items ?? [], { workspaceId, workspacePath });
    const merged = filter === "workspace" ? workspaceRecords : filter === "task" ? taskRecords : [...taskRecords, ...workspaceRecords];
    return merged.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)).slice(-20);
    // snapshotVersion makes cache-only updates observable without adding another network request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditQuery.data?.items, filter, sessionId, workspaceId, workspacePath, snapshotVersion]);

  const refresh = useCallback(() => {
    if (!workspaceId) return Promise.resolve();
    return auditQuery.refetch().then(() => undefined);
  }, [auditQuery.refetch, workspaceId]);

  const exportJson = useCallback(() => {
    return JSON.stringify(createAuditTrailExport(records, {
      workspaceId,
      sessionId,
      partialHistory: !currentSnapshot || (currentSnapshot.messages?.length ?? 0) >= 140,
    }), null, 2);
  }, [currentSnapshot, records, sessionId, workspaceId]);

  return {
    records,
    filter,
    setFilter,
    refresh,
    exportJson,
    isLoading: open && auditQuery.isLoading,
    isRefreshing: auditQuery.isFetching,
    error: auditQuery.error instanceof Error ? auditQuery.error.message : auditQuery.error ? "Failed to load audit log." : null,
    partialHistory: !currentSnapshot || (currentSnapshot.messages?.length ?? 0) >= 140,
  };
}
