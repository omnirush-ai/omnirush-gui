import { describe, expect, test } from "bun:test";

import {
  assertOpencodeProxyAllowed,
  engineHasSession,
  normalizeOpencodeDirectory,
  proxyOpencodeRequest,
  scopeWorkspaceOpencodeRequest,
} from "./server.js";
import { ApiError } from "./errors.js";
import type { Actor, ServerConfig, TokenScope, WorkspaceInfo } from "./types.js";

const actor = (scope: TokenScope | undefined): Actor => ({ type: "remote", scope });

const PERMISSION_REPLY_PATH = "/opencode/permission/req_123/reply";

describe("assertOpencodeProxyAllowed", () => {
  test("collaborators can reply to permission requests (#1918)", () => {
    // The SPA's only credential is the collaborator-scoped client token
    // (OMNIRUSH_TOKEN); an owner-only gate made every permission dialog
    // un-answerable.
    expect(() =>
      assertOpencodeProxyAllowed(actor("collaborator"), "POST", PERMISSION_REPLY_PATH),
    ).not.toThrow();
  });

  test("owners can reply to permission requests", () => {
    expect(() =>
      assertOpencodeProxyAllowed(actor("owner"), "POST", PERMISSION_REPLY_PATH),
    ).not.toThrow();
  });

  test("viewers cannot send any mutating request", () => {
    expect(() =>
      assertOpencodeProxyAllowed(actor("viewer"), "POST", PERMISSION_REPLY_PATH),
    ).toThrow(ApiError);
    expect(() =>
      assertOpencodeProxyAllowed(actor("viewer"), "POST", "/opencode/session/s1/command"),
    ).toThrow(ApiError);
  });

  test("viewers can still read", () => {
    expect(() =>
      assertOpencodeProxyAllowed(actor("viewer"), "GET", "/opencode/permission"),
    ).not.toThrow();
  });

  test("missing scope defaults to viewer (read-only)", () => {
    expect(() =>
      assertOpencodeProxyAllowed(actor(undefined), "POST", PERMISSION_REPLY_PATH),
    ).toThrow(ApiError);
    expect(() =>
      assertOpencodeProxyAllowed(actor(undefined), "GET", "/opencode/permission"),
    ).not.toThrow();
  });
});

describe("scopeWorkspaceOpencodeRequest", () => {
  test("overwrites caller-controlled directory headers and query parameters", () => {
    const scoped = scopeWorkspaceOpencodeRequest(
      new Headers({ "x-opencode-directory": "/tmp/foreign" }),
      "?directory=%2Ftmp%2Fforeign&roots=true&directory=%2Ftmp%2Fother",
      "/tmp/workspace",
    );

    expect(scoped.headers.get("x-opencode-directory")).toBe("/tmp/workspace");
    expect(new URLSearchParams(scoped.search).getAll("directory")).toEqual(["/tmp/workspace"]);
    expect(new URLSearchParams(scoped.search).get("roots")).toBe("true");
  });

  test("removes caller-controlled directory scope when a workspace has no engine directory", () => {
    const scoped = scopeWorkspaceOpencodeRequest(
      new Headers({ "X-OpenCode-Directory": "/tmp/foreign" }),
      "?directory=%2Ftmp%2Fforeign&limit=10",
      null,
    );

    expect(scoped.headers.has("x-opencode-directory")).toBe(false);
    expect(new URLSearchParams(scoped.search).has("directory")).toBe(false);
    expect(new URLSearchParams(scoped.search).get("limit")).toBe("10");
  });

  test("encodes non-ASCII directory headers while preserving the query value", () => {
    const directory = "/tmp/项目";
    const scoped = scopeWorkspaceOpencodeRequest(new Headers(), "", directory);

    expect(scoped.headers.get("x-opencode-directory")).toBe(encodeURIComponent(directory));
    expect(new URLSearchParams(scoped.search).get("directory")).toBe(directory);
  });
});

describe("normalizeOpencodeDirectory", () => {
  test("removes Windows extended-length prefixes", () => {
    expect(normalizeOpencodeDirectory("\\\\?\\C:\\Users\\agent\\repo", "win32"))
      .toBe("C:\\Users\\agent\\repo");
    expect(normalizeOpencodeDirectory("//?/C:/Users/agent/repo", "win32"))
      .toBe("C:/Users/agent/repo");
  });

  test("leaves paths unchanged on non-Windows platforms", () => {
    expect(normalizeOpencodeDirectory("\\\\?\\C:\\Users\\agent\\repo", "darwin"))
      .toBe("\\\\?\\C:\\Users\\agent\\repo");
  });
});

describe("proxyOpencodeRequest read-only guard", () => {
  const workspace: WorkspaceInfo = {
    id: "ws_ro",
    name: "Read-only workspace",
    path: "/tmp/omnirush-proxy-gate-ro",
    preset: "starter",
    workspaceType: "local",
  };

  const readOnlyConfig: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [workspace],
    authorizedRoots: [workspace.path],
    readOnly: true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };

  const proxy = (method: string) => {
    const proxyPath = "/session";
    const url = new URL(`http://omnirush.invalid/opencode${proxyPath}`);
    return proxyOpencodeRequest({
      config: readOnlyConfig,
      workspace,
      proxyPath,
      url,
      request: new Request(url, { method }),
    });
  };

  test("rejects native proxy writes on a read-only server (parity with the removed ensureWritable wrapper routes)", async () => {
    for (const method of ["POST", "DELETE", "PATCH", "PUT"]) {
      const error = await proxy(method).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect(error instanceof ApiError ? error.code : null).toBe("read_only");
    }
  });

  test("still lets reads through the read-only gate", async () => {
    // No engine is configured, so a read that passes the read-only gate fails
    // later with opencode_unconfigured — proving the gate did not block it.
    const error = await proxy("GET").then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error instanceof ApiError ? error.code : null).toBe("opencode_unconfigured");
  });
});

describe("engineHasSession", () => {
  test("false only when the engine answers 404; a slow or unreachable engine counts as having it", async () => {
    const seen: Array<{ path: string; directory: string | null; authorization: string | null }> = [];
    const engine = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        seen.push({ path: url.pathname, directory: url.searchParams.get("directory"), authorization: request.headers.get("authorization") });
        if (url.pathname === "/session/ses_known_00001") return Response.json({ id: "ses_known_00001" });
        if (url.pathname === "/session/ses_slow_000001") return new Promise<Response>(() => undefined);
        return Response.json({ name: "NotFoundError" }, { status: 404 });
      },
    });
    try {
      const baseUrl = `http://127.0.0.1:${engine.port}`;
      expect(await engineHasSession(baseUrl, "Basic abc", "/work", "ses_known_00001")).toBe(true);
      expect(await engineHasSession(baseUrl, "Basic abc", "/work", "ses_gone_000001")).toBe(false);
      expect(await engineHasSession(baseUrl, null, null, "ses_slow_000001")).toBe(true);
      expect(await engineHasSession("http://127.0.0.1:1", null, null, "ses_down_000001")).toBe(true);
      expect(seen[0]).toEqual({ path: "/session/ses_known_00001", directory: "/work", authorization: "Basic abc" });
    } finally {
      engine.stop(true);
    }
  }, 15_000);
});
