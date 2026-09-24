import { afterEach, describe, expect, test } from "bun:test";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client";

import { resolveRequestTimeoutMs, SESSION_READ_REQUEST_TIMEOUT_MS, type FieldsResult } from "../src/app/lib/opencode";
import {
  composeNativeSessionSnapshot,
  deleteNativeSession,
  getNativeSession,
  unwrapNativeSessionResult,
  type NativeSessionOperations,
} from "../src/app/lib/opencode-session-native";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import {
  classifyRouteSessionReadError,
  listRouteSessions,
  loadRouteSessionWithRetry,
  readRouteSessionsWithRetry,
  ROUTE_SESSION_RETRY_DELAYS_MS,
  sessionListRecoveryDelayMs,
  sessionsAfterListFailure,
  toSessionGroups,
  type RouteSession,
  type RouteSessionListTransport,
  type RouteWorkspace,
} from "../src/react-app/shell/route-workspaces";
import {
  forgetWorkspaceMemory,
  readCachedWorkspaceSessions,
  writeCachedWorkspaceSessions,
} from "../src/react-app/shell/session-memory";
import { isWorkspaceTaskListUnavailable } from "../src/react-app/domains/session/sidebar/utils";

const nativeEndpoint = {
  opencodeBaseUrl: "http://127.0.0.1:4096/workspace/ws_local/opencode",
  token: "local-token",
};

const session = {
  id: "ses_1",
  slug: "one",
  projectID: "project",
  directory: "/work/taskforge",
  title: "Build the parser",
  version: "1",
  time: { created: 1, updated: 2 },
} as Session;

/** The SDK's result when fetch itself rejected: no HTTP response at all. */
function transportFailure(error: unknown): FieldsResult<never> {
  return { error, request: new Request(nativeEndpoint.opencodeBaseUrl), response: undefined };
}

function httpFailure(error: unknown, status: number): FieldsResult<never> {
  return { error, request: new Request(nativeEndpoint.opencodeBaseUrl), response: new Response(null, { status }) };
}

function ok<T>(data: T): FieldsResult<T> {
  return { data, request: new Request(nativeEndpoint.opencodeBaseUrl), response: new Response(null, { status: 200 }) };
}

function operations(overrides: Partial<NativeSessionOperations> = {}): NativeSessionOperations {
  return {
    get: async () => ok(session),
    messages: async () => ok([]),
    todo: async () => ok([]),
    status: async () => ok<Record<string, SessionStatus>>({}),
    delete: async () => ok(true),
    ...overrides,
  };
}

describe("native session reads without an HTTP response", () => {
  test("a refused connection keeps the original error and stays retryable", async () => {
    const refused = new TypeError("Failed to fetch");
    const read = getNativeSession(nativeEndpoint, session.id, undefined, {
      createOperations: () => operations({ get: async () => transportFailure(refused) }),
    });
    const error = await read.catch((caught: unknown) => caught);
    expect(error).toBe(refused);
    expect(classifyRouteSessionReadError(error)).toBe("retryable");
  });

  test("a transport timeout keeps the original error and stays retryable", async () => {
    const timedOut = new Error("Request timed out.");
    const error = await getNativeSession(nativeEndpoint, session.id, undefined, {
      createOperations: () => operations({ get: async () => transportFailure(timedOut) }),
    }).catch((caught: unknown) => caught);
    expect(error).toBe(timedOut);
    expect(classifyRouteSessionReadError(error)).toBe("retryable");
  });

  test("a 404 is still tagged as a missing session", async () => {
    const error = await getNativeSession(nativeEndpoint, session.id, undefined, {
      createOperations: () => operations({ get: async () => httpFailure({ name: "NotFoundError" }, 404) }),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 404, code: "session_not_found" });
    expect(classifyRouteSessionReadError(error)).toBe("not-found");
  });

  test("a non-Error failure without a response never throws a TypeError", () => {
    let caught: unknown;
    try {
      unwrapNativeSessionResult(transportFailure({ message: "engine gone" }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe(JSON.stringify({ message: "engine gone" }));
    expect(caught).not.toHaveProperty("status");
  });

  test("snapshot and delete surface the transport error, not a TypeError", async () => {
    const refused = new TypeError("Failed to fetch");
    await expect(composeNativeSessionSnapshot(nativeEndpoint, session.id, undefined, {
      createOperations: () => operations({ status: async () => transportFailure(refused) }),
    })).rejects.toBe(refused);
    await expect(deleteNativeSession(nativeEndpoint, session.id, undefined, {
      createOperations: () => operations({ delete: async () => transportFailure(refused) }),
    })).rejects.toBe(refused);
  });
});

describe("sidebar session list without an HTTP response", () => {
  const endpoint = resolveWorkspaceEndpoint({ id: "ws_7a33db60cd66", workspaceType: "local" }, {
    baseUrl: "http://127.0.0.1:4096",
    token: "local-token",
  });
  if (!endpoint) throw new Error("Expected a local endpoint");

  const failingTransport = (error: unknown): RouteSessionListTransport => async () => ({
    error,
    request: new Request(`${endpoint.opencodeBaseUrl}/session?limit=200`),
    response: undefined,
  });

  test("refused and timed-out list calls reject with the original, retryable error", async () => {
    for (const original of [new TypeError("Failed to fetch"), new Error("Request timed out.")]) {
      const error = await listRouteSessions(endpoint, failingTransport(original)).catch((caught: unknown) => caught);
      expect(error).toBe(original);
      expect(classifyRouteSessionReadError(error)).toBe("retryable");
    }
  });

  test("an HTTP failure keeps its status and code", async () => {
    const error = await listRouteSessions(endpoint, async () => ({
      error: { code: "opencode_engine_unreachable", message: "engine starting" },
      request: new Request(`${endpoint.opencodeBaseUrl}/session?limit=200`),
      response: new Response(null, { status: 503 }),
    })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 503, code: "opencode_engine_unreachable" });
    expect(classifyRouteSessionReadError(error)).toBe("retryable");

    const notFound = await listRouteSessions(endpoint, async () => ({
      error: { name: "NotFoundError" },
      request: new Request(`${endpoint.opencodeBaseUrl}/session?limit=200`),
      response: new Response(null, { status: 404 }),
    })).catch((caught: unknown) => caught);
    expect(notFound).toMatchObject({ status: 404 });
  });

  test("the retry loop recovers after the built-in server comes back", async () => {
    let calls = 0;
    const waits: number[] = [];
    const sessions = await readRouteSessionsWithRetry({
      load: () => listRouteSessions(endpoint, async (input) => {
        calls += 1;
        if (calls < 3) {
          return {
            error: new TypeError("Failed to fetch"),
            request: new Request(`${input.endpoint.opencodeBaseUrl}/session?limit=200`),
            response: undefined,
          };
        }
        return {
          data: [session as RouteSession],
          request: new Request(`${input.endpoint.opencodeBaseUrl}/session?limit=200`),
          response: Response.json([session]),
        };
      }),
      retryDelaysMs: [250, 750, 1_500],
      wait: async (delayMs) => { waits.push(delayMs); },
    });
    expect(sessions.map((item) => item.id)).toEqual([session.id]);
    expect(waits).toEqual([250, 750]);
  });
});

describe("routed session hydration", () => {
  test("transient failures keep retrying past the old six-attempt limit", async () => {
    let calls = 0;
    const waits: number[] = [];
    const outcome = await loadRouteSessionWithRetry({
      isCancelled: () => false,
      wait: async (delayMs) => { waits.push(delayMs); },
      load: () => {
        calls += 1;
        return getNativeSession(nativeEndpoint, session.id, undefined, {
          createOperations: () => operations({
            get: async () => calls <= 8
              ? transportFailure(calls % 2 ? new TypeError("Failed to fetch") : new Error("Request timed out."))
              : ok(session),
          }),
        });
      },
    });
    expect(outcome).toEqual({ status: "loaded", value: session });
    expect(calls).toBe(9);
    const last = ROUTE_SESSION_RETRY_DELAYS_MS[ROUTE_SESSION_RETRY_DELAYS_MS.length - 1];
    expect(waits).toEqual([...ROUTE_SESSION_RETRY_DELAYS_MS, last, last]);
  });

  test("a missing session resolves at once as not found", async () => {
    const waits: number[] = [];
    const outcome = await loadRouteSessionWithRetry({
      isCancelled: () => false,
      wait: async (delayMs) => { waits.push(delayMs); },
      load: () => getNativeSession(nativeEndpoint, session.id, undefined, {
        createOperations: () => operations({ get: async () => httpFailure({ name: "NotFoundError" }, 404) }),
      }),
    });
    expect(outcome.status).toBe("not-found");
    expect(waits).toEqual([]);
  });

  test("a terminal error resolves at once with its message", async () => {
    const outcome = await loadRouteSessionWithRetry({
      isCancelled: () => false,
      wait: async () => { throw new Error("must not wait"); },
      load: () => getNativeSession(nativeEndpoint, session.id, undefined, {
        createOperations: () => operations({ get: async () => httpFailure("Unauthorized", 401) }),
      }),
    });
    expect(outcome).toMatchObject({ status: "error", message: "Unauthorized" });
  });

  test("stops when the route no longer wants the session", async () => {
    let cancelled = false;
    let calls = 0;
    const outcome = await loadRouteSessionWithRetry({
      isCancelled: () => cancelled,
      wait: async () => { cancelled = true; },
      load: async () => {
        calls += 1;
        throw new TypeError("Failed to fetch");
      },
    });
    expect(outcome).toEqual({ status: "cancelled" });
    expect(calls).toBe(1);
  });

  test("an explicit attempt bound still ends in an error", async () => {
    const outcome = await loadRouteSessionWithRetry({
      isCancelled: () => false,
      maxAttempts: 2,
      wait: async () => undefined,
      load: async () => { throw new Error("Request timed out."); },
    });
    expect(outcome).toMatchObject({ status: "error", message: "Request timed out." });
  });
});

describe("session read timeouts", () => {
  const base = "http://127.0.0.1:4096/workspace/ws_1/opencode";

  test("session list and get reads get the longer bounded budget", () => {
    expect(SESSION_READ_REQUEST_TIMEOUT_MS).toBeGreaterThan(10_000);
    expect(SESSION_READ_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    expect(resolveRequestTimeoutMs(new Request(`${base}/session?limit=200`), 10_000)).toBe(SESSION_READ_REQUEST_TIMEOUT_MS);
    expect(resolveRequestTimeoutMs(new Request(`${base}/session/ses_1`), 10_000)).toBe(SESSION_READ_REQUEST_TIMEOUT_MS);
    expect(resolveRequestTimeoutMs(`${base}/session`, 10_000)).toBe(SESSION_READ_REQUEST_TIMEOUT_MS);
    expect(resolveRequestTimeoutMs(new Request("http://127.0.0.1:4096/workspace/ws_1/opencode2/api/session"), 10_000))
      .toBe(SESSION_READ_REQUEST_TIMEOUT_MS);
  });

  test("status polls, writes, message reads and streams keep their own budgets", () => {
    expect(resolveRequestTimeoutMs(new Request(`${base}/session/status`), 10_000)).toBe(10_000);
    expect(resolveRequestTimeoutMs(new Request(`${base}/session/ses_1/message?limit=140`), 10_000)).toBe(10_000);
    expect(resolveRequestTimeoutMs(new Request(`${base}/session`, { method: "POST" }), 10_000)).toBe(10_000);
    expect(resolveRequestTimeoutMs(`${base}/session/ses_1`, 10_000, { method: "DELETE" })).toBe(10_000);
    expect(resolveRequestTimeoutMs(new Request(`${base}/session`), 0)).toBe(0);
  });
});

describe("failed session lists in the sidebar", () => {
  const workspace = { id: "ws_taskforge", displayNameResolved: "taskforge" } as RouteWorkspace;
  const cached = [{ id: "ses_a" }, { id: "ses_b" }];

  test("a failed load keeps a listed workspace's sessions", () => {
    expect(sessionsAfterListFailure({ current: [{ id: "ses_a" }], cached, currentIsListed: true }))
      .toEqual([{ id: "ses_a" }]);
  });

  test("an unlisted workspace falls back to the saved list, keeping sessions already present", () => {
    expect(sessionsAfterListFailure({ current: undefined, cached, currentIsListed: false })).toEqual(cached);
    expect(sessionsAfterListFailure({ current: [{ id: "ses_new" }, { id: "ses_b" }], cached, currentIsListed: false }))
      .toEqual([{ id: "ses_new" }, { id: "ses_b" }, { id: "ses_a" }]);
    expect(sessionsAfterListFailure({ current: [], cached: null, currentIsListed: true })).toEqual([]);
  });

  test("a failed empty group shows the retry row, never 'No tasks yet'", () => {
    const [failed] = toSessionGroups([workspace], {}, {}, new Set(), { [workspace.id]: "Request timed out." });
    expect(failed).toMatchObject({ status: "ready", sessions: [], listError: "Request timed out." });
    expect(isWorkspaceTaskListUnavailable(failed!)).toBe(true);

    const [loading] = toSessionGroups([workspace], {}, {}, new Set([workspace.id]), { [workspace.id]: "Failed to fetch" });
    expect(isWorkspaceTaskListUnavailable(loading!)).toBe(false);

    const [empty] = toSessionGroups([workspace], {}, {}, new Set());
    expect(empty?.listError).toBeNull();
    expect(isWorkspaceTaskListUnavailable(empty!)).toBe(false);
  });

  test("automatic reloads back off and keep going at the last delay", () => {
    const delays = [0, 1, 2, 3, 4, 5, 50].map(sessionListRecoveryDelayMs);
    expect(delays).toEqual([5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000]);
  });
});

describe("saved session lists", () => {
  const originalWindow = globalThis.window;

  function installStorage() {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => { values.set(key, value); },
          removeItem: (key: string) => { values.delete(key); },
        },
      },
    });
    return values;
  }

  afterEach(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  });

  test("survive a restart with only the sidebar fields", () => {
    const values = installStorage();
    writeCachedWorkspaceSessions("ws_taskforge", [
      {
        ...session,
        parentID: "ses_parent",
        time: { created: 1, updated: 2, archived: 3 },
        summary: { additions: 1, deletions: 0, files: 1, diffs: [{ file: "a.ts", before: "x", after: "y" }] },
        permission: [{ permission: "edit", pattern: "*", action: "allow" }],
      },
      { title: "no id" },
    ], 100);
    const stored = [...values.values()].join("");
    expect(stored).not.toContain("diffs");
    expect(stored).not.toContain("permission");
    expect(readCachedWorkspaceSessions("ws_taskforge")).toEqual([{
      id: "ses_1",
      slug: "one",
      projectID: "project",
      directory: "/work/taskforge",
      parentID: "ses_parent",
      title: "Build the parser",
      version: "1",
      time: { created: 1, updated: 2, archived: 3 },
    }]);
    expect(readCachedWorkspaceSessions("ws_other")).toBeNull();
  });

  test("are dropped when the workspace is forgotten and tolerate bad storage", () => {
    const values = installStorage();
    writeCachedWorkspaceSessions("ws_taskforge", [session]);
    forgetWorkspaceMemory("ws_taskforge");
    expect(readCachedWorkspaceSessions("ws_taskforge")).toBeNull();
    values.set("omnirush.react.workspaceSessionList", "{not json");
    expect(readCachedWorkspaceSessions("ws_taskforge")).toBeNull();
  });
});
