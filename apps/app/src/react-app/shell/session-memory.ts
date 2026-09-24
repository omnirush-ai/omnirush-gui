/**
 * Thin localStorage wrapper for the React shell's "remember what the user had
 * open" behavior. Keys mirror those the Solid app used so users don't lose
 * their spot when switching between shells during the port.
 */

const ACTIVE_WORKSPACE_KEY = "omnirush.react.activeWorkspace";
const SESSION_BY_WORKSPACE_KEY = "omnirush.react.sessionByWorkspace";
const WORKSPACE_ORDER_KEY = "omnirush.react.workspaceOrder";
const WORKSPACE_PROJECT_DIMENSION_KEY = "omnirush.react.workspaceProjectDimension";
const WORKSPACE_SESSION_LIST_KEY = "omnirush.react.workspaceSessionList";
const WORKSPACE_SESSION_LIST_MAX_WORKSPACES = 20;
const WORKSPACE_SESSION_LIST_MAX_SESSIONS = 100;

function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null || value === "") {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage errors (quota, privacy modes, etc.)
  }
}

export function readActiveWorkspaceId(): string | null {
  const value = safeGet(ACTIVE_WORKSPACE_KEY);
  return value?.trim() || null;
}

export function writeActiveWorkspaceId(id: string | null): void {
  safeSet(ACTIVE_WORKSPACE_KEY, id?.trim() || null);
}

export function readWorkspaceOrderIds(): string[] {
  const raw = safeGet(WORKSPACE_ORDER_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      const trimmed = typeof value === "string" ? value.trim() : "";
      return trimmed ? [trimmed] : [];
    });
  } catch {
    return [];
  }
}

export function writeWorkspaceOrderIds(ids: string[]): void {
  const normalized = ids.flatMap((id) => {
    const trimmed = id.trim();
    return trimmed ? [trimmed] : [];
  });
  safeSet(WORKSPACE_ORDER_KEY, normalized.length ? JSON.stringify(normalized) : null);
}

type SessionByWorkspace = Record<string, string>;
export type WorkspaceProjectDimension = {
  label: string;
};

function readSessionByWorkspaceMap(): SessionByWorkspace {
  const raw = safeGet(SESSION_BY_WORKSPACE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const result: SessionByWorkspace = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof key === "string" && typeof value === "string") {
          result[key] = value;
        }
      }
      return result;
    }
  } catch {
    // ignore malformed payload
  }
  return {};
}

export function readLastSessionFor(workspaceId: string): string | null {
  const id = workspaceId?.trim();
  if (!id) return null;
  return readSessionByWorkspaceMap()[id] ?? null;
}

export function writeLastSessionFor(workspaceId: string, sessionId: string | null): void {
  const wsId = workspaceId?.trim();
  if (!wsId) return;
  const map = readSessionByWorkspaceMap();
  const normalized = sessionId?.trim() || "";
  if (!normalized) {
    if (!(wsId in map)) return;
    delete map[wsId];
  } else {
    if (map[wsId] === normalized) return;
    map[wsId] = normalized;
  }
  safeSet(SESSION_BY_WORKSPACE_KEY, Object.keys(map).length ? JSON.stringify(map) : null);
}

function readWorkspaceProjectDimensionMap(): Record<string, WorkspaceProjectDimension> {
  const raw = safeGet(WORKSPACE_PROJECT_DIMENSION_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, WorkspaceProjectDimension> = {};
    for (const [workspaceId, value] of Object.entries(parsed)) {
      if (!workspaceId.trim() || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label.trim() : "";
      if (!label) continue;
      result[workspaceId] = {
        label,
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function readWorkspaceProjectDimension(workspaceId: string | null | undefined): WorkspaceProjectDimension | null {
  const wsId = workspaceId?.trim();
  if (!wsId) return null;
  return readWorkspaceProjectDimensionMap()[wsId] ?? null;
}

export function writeWorkspaceProjectDimension(
  workspaceId: string | null | undefined,
  dimension: WorkspaceProjectDimension | null,
): void {
  const wsId = workspaceId?.trim();
  if (!wsId) return;
  const map = readWorkspaceProjectDimensionMap();
  const label = dimension?.label.trim() ?? "";
  if (!label) {
    delete map[wsId];
  } else {
    map[wsId] = {
      label,
    };
  }
  safeSet(WORKSPACE_PROJECT_DIMENSION_KEY, Object.keys(map).length ? JSON.stringify(map) : null);
}

/**
 * The sidebar fields of a session, kept so a workspace whose session list
 * cannot be loaded (engine starting, built-in server restarting) still shows
 * its last known tasks instead of "No tasks yet". Heavy fields (diffs,
 * permissions, metadata) are dropped.
 */
export type CachedWorkspaceSession = {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  version: string;
  time: { created: number; updated: number; archived?: number };
};

type WorkspaceSessionListCache = Record<string, { savedAt: number; sessions: CachedWorkspaceSession[] }>;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toCachedWorkspaceSession(value: unknown): CachedWorkspaceSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;
  const time = record.time && typeof record.time === "object" ? record.time as Record<string, unknown> : {};
  const archived = finiteNumber(time.archived);
  const parentID = typeof record.parentID === "string" && record.parentID ? record.parentID : undefined;
  return {
    id,
    slug: typeof record.slug === "string" ? record.slug : "",
    projectID: typeof record.projectID === "string" ? record.projectID : "",
    directory: typeof record.directory === "string" ? record.directory : "",
    ...(parentID ? { parentID } : {}),
    title: typeof record.title === "string" ? record.title : "",
    version: typeof record.version === "string" ? record.version : "",
    time: {
      created: finiteNumber(time.created) ?? 0,
      updated: finiteNumber(time.updated) ?? finiteNumber(time.created) ?? 0,
      ...(archived !== undefined ? { archived } : {}),
    },
  };
}

function readWorkspaceSessionListCache(): WorkspaceSessionListCache {
  const raw = safeGet(WORKSPACE_SESSION_LIST_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: WorkspaceSessionListCache = {};
    for (const [workspaceId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!workspaceId.trim() || !entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (!Array.isArray(record.sessions)) continue;
      result[workspaceId] = {
        savedAt: finiteNumber(record.savedAt) ?? 0,
        sessions: record.sessions.flatMap((session) => {
          const cached = toCachedWorkspaceSession(session);
          return cached ? [cached] : [];
        }),
      };
    }
    return result;
  } catch {
    return {};
  }
}

function writeWorkspaceSessionListCache(cache: WorkspaceSessionListCache): void {
  const entries = Object.entries(cache)
    .sort(([, a], [, b]) => b.savedAt - a.savedAt)
    .slice(0, WORKSPACE_SESSION_LIST_MAX_WORKSPACES);
  safeSet(WORKSPACE_SESSION_LIST_KEY, entries.length ? JSON.stringify(Object.fromEntries(entries)) : null);
}

/** Last successfully loaded session list for a workspace, or null when none was saved. */
export function readCachedWorkspaceSessions(workspaceId: string | null | undefined): CachedWorkspaceSession[] | null {
  const wsId = workspaceId?.trim();
  if (!wsId) return null;
  return readWorkspaceSessionListCache()[wsId]?.sessions ?? null;
}

export function writeCachedWorkspaceSessions(
  workspaceId: string | null | undefined,
  sessions: readonly unknown[],
  now: number = Date.now(),
): void {
  const wsId = workspaceId?.trim();
  if (!wsId) return;
  const cache = readWorkspaceSessionListCache();
  cache[wsId] = {
    savedAt: now,
    sessions: sessions.slice(0, WORKSPACE_SESSION_LIST_MAX_SESSIONS).flatMap((session) => {
      const cached = toCachedWorkspaceSession(session);
      return cached ? [cached] : [];
    }),
  };
  writeWorkspaceSessionListCache(cache);
}

export function forgetWorkspaceMemory(workspaceId: string): void {
  const wsId = workspaceId?.trim();
  if (!wsId) return;
  const sessionListCache = readWorkspaceSessionListCache();
  if (wsId in sessionListCache) {
    delete sessionListCache[wsId];
    writeWorkspaceSessionListCache(sessionListCache);
  }
  const map = readSessionByWorkspaceMap();
  if (wsId in map) {
    delete map[wsId];
    safeSet(SESSION_BY_WORKSPACE_KEY, Object.keys(map).length ? JSON.stringify(map) : null);
  }
  const dimensionMap = readWorkspaceProjectDimensionMap();
  if (wsId in dimensionMap) {
    delete dimensionMap[wsId];
    safeSet(WORKSPACE_PROJECT_DIMENSION_KEY, Object.keys(dimensionMap).length ? JSON.stringify(dimensionMap) : null);
  }
  const active = readActiveWorkspaceId();
  if (active === wsId) writeActiveWorkspaceId(null);
  const workspaceOrderIds = readWorkspaceOrderIds();
  if (workspaceOrderIds.includes(wsId)) {
    writeWorkspaceOrderIds(workspaceOrderIds.filter((id) => id !== wsId));
  }
}
