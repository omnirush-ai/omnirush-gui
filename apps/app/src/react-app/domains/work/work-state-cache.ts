// The Work state the app already holds (one answer per server, ["omnirush-work-state", <server>]), for components with
// no Work client: the browser, its home, the link router and the import screens. One subscription on the query cache
// that listens to that key only, and change notices that wait for the current render to finish, so reading it never
// updates another component while React draws (the "Cannot update a component while rendering" warning) and other
// queries never make it read again.
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import type { OmniRushWorkState } from "@/app/lib/omnirush-server";

export const WORK_STATE_QUERY_ROOT = "omnirush-work-state";

/** The first Work state with Work on that the app holds, or null. The same object until it changes. */
export function cachedWorkState(queryClient: QueryClient): OmniRushWorkState | null {
  return queryClient.getQueriesData<OmniRushWorkState>({ queryKey: [WORK_STATE_QUERY_ROOT] }).find(([, data]) => data?.enabled === true)?.[1] ?? null;
}

/** Calls `notify` after a Work state answer is added, changed or removed (never for another query). */
export function subscribeWorkState(queryClient: QueryClient, notify: () => void): () => void {
  let queued = false;
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] !== WORK_STATE_QUERY_ROOT) return;
    if (event.type !== "added" && event.type !== "removed" && event.type !== "updated") return;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      notify();
    });
  });
}

/** The Work state from the cache, read again only when it changes. */
export function useCachedWorkState(): OmniRushWorkState | null {
  const queryClient = useQueryClient();
  const subscribe = useCallback((notify: () => void) => subscribeWorkState(queryClient, notify), [queryClient]);
  const snapshot = useCallback(() => cachedWorkState(queryClient), [queryClient]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
