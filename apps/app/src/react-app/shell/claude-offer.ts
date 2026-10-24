// What the app shows of Claude Code for a workspace. While the server does not offer it to this account (status
// `allowed` false: today's servers, the switch off) nothing advertises it: no menu entry, no Claude page. Sessions
// saved earlier stay reachable for export and recovery, under a plain "saved sessions" view.
import { useEffect, useState } from "react";

import { createOmniRushServerClient } from "@/app/lib/omnirush-server";
import { workspaceBootstrap } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { resolveWorkspaceEndpoint, type ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { resolveOmniRushConnection } from "./omnirush-connection";

/** full: offered (new sessions); saved: not offered, saved sessions to export; none: nothing to show. */
export type ClaudeSurface = "full" | "saved" | "none";

export function claudeSurface(allowed: boolean, savedSessions: number): ClaudeSurface {
  if (allowed) return "full";
  return savedSessions > 0 ? "saved" : "none";
}

/** The workspace's server endpoint (the local server on the desktop). */
export async function claudeEndpoint(workspaceId: string | undefined, signal?: AbortSignal): Promise<ResolvedWorkspaceEndpoint> {
  const {normalizedBaseUrl: baseUrl, resolvedToken: token, resolvedHostToken: hostToken} = await resolveOmniRushConnection();
  signal?.throwIfAborted();
  if (!baseUrl) throw new Error("Connect to a workspace server first");
  const local = { baseUrl, token, hostToken };
  const localClient = createOmniRushServerClient(local);
  const workspaces = (await localClient.listWorkspaces()).items;
  signal?.throwIfAborted();
  const workspace = workspaces.find((item) => item.id === workspaceId)
    ?? (isDesktopRuntime() ? (await workspaceBootstrap()).workspaces.find((item) => item.id === workspaceId) : undefined);
  signal?.throwIfAborted();
  if (!workspace) throw new Error("Workspace not found");
  const next = resolveWorkspaceEndpoint(workspace, local);
  if (!next) throw new Error("Workspace server is unavailable");
  // Host authority stays on the local server; the shared resolver supplies
  // the owning remote workspace's own URL and credentials.
  return {...next, client: next.isRemote ? next.client : localClient};
}

type ClaudeConnection = {
  endpoint: (ResolvedWorkspaceEndpoint & {signal: AbortSignal}) | null;
  pending: boolean;
  error: string | null;
};

/** Shared route/menu lifetime: settings publication supersedes old requests. */
export function useClaudeEndpoint(workspaceId: string | undefined): ClaudeConnection {
  const [connection, setConnection] = useState<ClaudeConnection>({endpoint: null, pending: true, error: null});
  useEffect(() => {
    let controller: AbortController;
    const connect = () => {
      controller?.abort();
      controller = new AbortController();
      const {signal} = controller;
      setConnection({endpoint: null, pending: true, error: null});
      void claudeEndpoint(workspaceId, signal).then(endpoint => {
        if (!signal.aborted) setConnection({endpoint: {...endpoint, signal}, pending: false, error: null});
      }, error => {
        if (!signal.aborted) setConnection({endpoint: null, pending: false, error: error instanceof Error ? error.message : "Workspace server is unavailable"});
      });
    };
    const onStorage = (event: StorageEvent) => { if (!event.key || event.key.startsWith("omnirush.server.")) connect(); };
    const onVisible = () => { if (document.visibilityState === "visible") connect(); };
    connect();
    window.addEventListener("omnirush-server-settings-changed", connect);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.removeEventListener("omnirush-server-settings-changed", connect);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [workspaceId]);
  return connection;
}

/** Null until known; a failed or interrupted connection never advertises Claude. */
export function useClaudeSurface(workspaceId: string | undefined): ClaudeSurface | null {
  const {endpoint, pending} = useClaudeEndpoint(workspaceId);
  const [surface, setSurface] = useState<ClaudeSurface | null>(null);
  useEffect(() => {
    setSurface(null);
    if (!endpoint) return;
    let closed = false;
    void (async () => {
      const [status, sessions] = await Promise.all([
        endpoint.client.claude.request<{ allowed: boolean }>(endpoint.workspaceId, "status", undefined, endpoint.signal),
        endpoint.client.claude.request<unknown[]>(endpoint.workspaceId, "sessions", undefined, endpoint.signal),
      ]);
      return claudeSurface(status?.allowed === true, Array.isArray(sessions) ? sessions.length : 0);
    })().then((next) => { if (!closed && !endpoint.signal.aborted) setSurface(next); }, () => { if (!closed && !endpoint.signal.aborted) setSurface("none"); });
    return () => { closed = true; };
  }, [endpoint]);
  return pending ? null : endpoint ? surface : "none";
}
