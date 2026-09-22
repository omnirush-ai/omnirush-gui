import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  KEYCHAIN_SERVICES,
  accountServerLabel,
  classifyRemoteLogout,
  createDesktopOmniRushAccountStore,
} from "./omnirush-account.mjs";

function testStorage() {
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptStringAsync: async (value) => Buffer.from(value, "utf8"),
    decryptStringAsync: async (value) => ({ result: value.toString("utf8"), shouldReEncrypt: false }),
  };
}

async function storeOptions(overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omnirush-account-"));
  return {
    filePath: path.join(directory, "account.bin"),
    loadSafeStorage: () => testStorage(),
    platform: /** @type {NodeJS.Platform} */ ("linux"),
    env: { OMNIRUSH_DEV_MODE: "1" },
    sleep: async () => undefined,
    // The macOS keychain tool must never run for a non-darwin store.
    execFileImpl: async (file, args) => {
      throw new Error(`unexpected ${file} ${args.join(" ")}`);
    },
    ...overrides,
  };
}

test("device authorization polls, encrypts, and restores the account", async () => {
  const requests = [];
  let polls = 0;
  const options = await storeOptions({
    fetchImpl: async (url) => {
      requests.push(new URL(url).pathname);
      if (String(url).endsWith("/device/me")) {
        return Response.json({
          email: "person@example.com",
          status: "active",
          usage: { token_limit: 100000, used_tokens: 1234, remaining_tokens: 98766 },
        });
      }
      if (String(url).endsWith("/device/authorize")) {
        return Response.json({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri_complete: "http://localhost:5175/console?code=ABCD-EFGH",
          interval: 0,
          expires_in: 60,
        });
      }
      polls += 1;
      if (polls === 1) return Response.json({ detail: "authorization_pending" }, { status: 428 });
      return Response.json({
        gateway_url: "http://localhost:8090/omnirush/v1",
        access_token: "access-token",
        refresh_token: "refresh-token",
      });
    },
  });
  const opened = [];
  const store = createDesktopOmniRushAccountStore(options);
  const result = await store.authorize({
    gatewayUrl: undefined,
    deviceName: "Test Mac",
    openVerification: async (url) => { opened.push(url); },
  });
  assert.deepEqual(result, { connected: true, userCode: "ABCD-EFGH" });
  assert.deepEqual(opened, ["http://localhost:5175/console?code=ABCD-EFGH"]);
  const status = await store.status();
  assert.equal(status.connected, true);
  assert.equal(status.displayName, "Person");
  assert.match(await readFile(options.filePath, "utf8"), /access-token/);

  const restored = createDesktopOmniRushAccountStore(options);
  assert.equal((await restored.status()).connected, true);
  assert.deepEqual(requests, [
    "/omnirush/device/authorize",
    "/omnirush/device/token",
    "/omnirush/device/token",
    "/omnirush/device/me",
    "/omnirush/device/me",
  ]);
});

async function authorizeOrigin(env) {
  const requested = [];
  const options = await storeOptions({
    env,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return Response.json({ detail: "unavailable" }, { status: 503 });
    },
  });
  const store = createDesktopOmniRushAccountStore(options);
  await assert.rejects(store.authorize({ gatewayUrl: undefined, deviceName: "Test Mac", openVerification: async () => undefined }));
  assert.equal(requested.length, 1);
  return requested[0];
}

test("defaults the account service to omnirush.ai, even in development mode", async () => {
  assert.equal(await authorizeOrigin({}), "https://omnirush.ai/omnirush/device/authorize");
  assert.equal(await authorizeOrigin({ OMNIRUSH_DEV_MODE: "1" }), "https://omnirush.ai/omnirush/device/authorize");
  assert.equal(await authorizeOrigin({ OMNIRUSH_LOCAL_API: "1" }), "https://omnirush.ai/omnirush/device/authorize");
});

test("selects the local API only with OMNIRUSH_DEV_MODE=1 and OMNIRUSH_LOCAL_API=1", async () => {
  assert.equal(
    await authorizeOrigin({ OMNIRUSH_DEV_MODE: "1", OMNIRUSH_LOCAL_API: "1" }),
    "http://localhost:8090/omnirush/device/authorize",
  );
});

test("an explicit OMNIRUSH_GATEWAY_URL always wins", async () => {
  assert.equal(
    await authorizeOrigin({ OMNIRUSH_GATEWAY_URL: "https://staging.example/omnirush/v1" }),
    "https://staging.example/omnirush/device/authorize",
  );
  assert.equal(
    await authorizeOrigin({ OMNIRUSH_DEV_MODE: "1", OMNIRUSH_LOCAL_API: "1", OMNIRUSH_GATEWAY_URL: "https://staging.example/omnirush/v1" }),
    "https://staging.example/omnirush/device/authorize",
  );
});

test("profile lookup refreshes an expired device credential and persists the rotation", async () => {
  const options = await storeOptions({
    env: {
      OMNIRUSH_DEV_MODE: "1",
      OMNIRUSH_GATEWAY_URL: "http://localhost:8090/omnirush/v1",
      OMNIRUSH_ACCESS_TOKEN: "expired-access",
      OMNIRUSH_REFRESH_TOKEN: "current-refresh",
    },
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/device/me")) {
        const authorization = new Headers(init.headers).get("authorization");
        if (authorization === "Bearer expired-access") {
          return Response.json({ detail: "device_token_invalid" }, { status: 401 });
        }
        assert.equal(authorization, "Bearer rotated-access");
        return Response.json({
          email: "person@example.com",
          status: "active",
          usage: { token_limit: 100000, used_tokens: 12, remaining_tokens: 99988 },
        });
      }
      if (pathname.endsWith("/device/refresh")) {
        assert.deepEqual(JSON.parse(init.body), { refresh_token: "current-refresh" });
        return Response.json({
          gateway_url: "http://localhost:8090/omnirush/v1",
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
        });
      }
      throw new Error(`Unexpected request ${pathname}`);
    },
  });

  const store = createDesktopOmniRushAccountStore(options);
  const status = await store.status();
  assert.equal(status.connected, true);
  assert.equal(status.email, "person@example.com");
  assert.equal(status.displayName, "Person");
  assert.equal(status.usage.remainingTokens, 99988);
  assert.match(await readFile(options.filePath, "utf8"), /rotated-refresh/);
});

test("sign out prevents legacy credentials from being imported again", async () => {
  let logoutBody = null;
  const options = await storeOptions({
    env: {
      OMNIRUSH_DEV_MODE: "1",
      OMNIRUSH_GATEWAY_URL: "http://localhost:8090/omnirush/v1",
      OMNIRUSH_ACCESS_TOKEN: "legacy-access",
      OMNIRUSH_REFRESH_TOKEN: "legacy-refresh",
    },
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/device/me")) {
        return Response.json({
          email: "person@example.com",
          status: "active",
          usage: { token_limit: 100000, used_tokens: 0, remaining_tokens: 100000 },
        });
      }
      if (pathname.endsWith("/device/logout")) {
        logoutBody = JSON.parse(init.body);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });
  const store = createDesktopOmniRushAccountStore(options);
  assert.equal((await store.status()).connected, true);
  const result = await store.clear();
  assert.equal(result.remoteRevoked, true);
  assert.deepEqual(logoutBody, { refresh_token: "legacy-refresh" });
  const restarted = createDesktopOmniRushAccountStore(options);
  assert.equal((await restarted.status()).connected, false);
});

test("sign out clears the local account when remote revocation is unavailable", async () => {
  const options = await storeOptions({
    env: {
      OMNIRUSH_DEV_MODE: "1",
      OMNIRUSH_GATEWAY_URL: "http://localhost:8090/omnirush/v1",
      OMNIRUSH_ACCESS_TOKEN: "legacy-access",
      OMNIRUSH_REFRESH_TOKEN: "legacy-refresh",
    },
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith("/device/logout")) throw new Error("offline");
      return Response.json({ email: "person@example.com", status: "active" });
    },
  });
  const store = createDesktopOmniRushAccountStore(options);
  assert.equal((await store.status()).connected, true);
  const result = await store.clear();
  assert.equal(result.remoteRevoked, false);
  assert.equal((await createDesktopOmniRushAccountStore(options).status()).connected, false);
});

test("marks an irrecoverably expired device session as signed out", async () => {
  const options = await storeOptions({
    env: {
      OMNIRUSH_DEV_MODE: "1",
      OMNIRUSH_GATEWAY_URL: "http://localhost:8090/omnirush/v1",
      OMNIRUSH_ACCESS_TOKEN: "expired-access",
      OMNIRUSH_REFRESH_TOKEN: "expired-refresh",
    },
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/device/me") || pathname.endsWith("/device/refresh")) {
        return Response.json({ detail: "device_token_invalid" }, { status: 401 });
      }
      throw new Error(`Unexpected request ${pathname}`);
    },
  });

  const status = await createDesktopOmniRushAccountStore(options).status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, true);
});

test("rejects an insecure non-loopback account endpoint", async () => {
  let requested = false;
  const options = await storeOptions({
    fetchImpl: async () => {
      requested = true;
      return Response.json({});
    },
  });
  const store = createDesktopOmniRushAccountStore(options);
  await assert.rejects(
    store.authorize({
      gatewayUrl: "http://example.com/omnirush/v1",
      deviceName: "Test Mac",
      openVerification: async () => undefined,
    }),
    /not configured/,
  );
  assert.equal(requested, false);
});

const LEGACY_ENV = {
  OMNIRUSH_DEV_MODE: "1",
  OMNIRUSH_GATEWAY_URL: "http://localhost:8090/omnirush/v1",
  OMNIRUSH_ACCESS_TOKEN: "legacy-access",
  OMNIRUSH_REFRESH_TOKEN: "legacy-refresh",
};

async function signOutWith(logoutResponse) {
  const options = await storeOptions({
    env: LEGACY_ENV,
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith("/device/logout")) return logoutResponse();
      return Response.json({ email: "person@example.com", status: "active" });
    },
  });
  const store = createDesktopOmniRushAccountStore(options);
  assert.equal((await store.status()).connected, true);
  const result = await store.clear();
  // Whatever the server said, the local account is gone and stays gone.
  assert.equal((await createDesktopOmniRushAccountStore(options).status()).connected, false);
  return result;
}

test("sign out reports which remote revocation outcome happened", async () => {
  assert.deepEqual(await signOutWith(() => new Response(null, { status: 204 })), { remoteRevoked: true, reason: "revoked" });
  assert.deepEqual(await signOutWith(() => Response.json({ ok: true }, { status: 200 })), { remoteRevoked: true, reason: "revoked" });
  assert.deepEqual(
    await signOutWith(() => Response.json({ detail: "device_token_invalid" }, { status: 401 })),
    { remoteRevoked: true, reason: "already_revoked" },
  );
  assert.deepEqual(
    await signOutWith(() => Response.json({ detail: "device_session_revoked" }, { status: 403 })),
    { remoteRevoked: true, reason: "already_revoked" },
  );
  // A 404 that names the session comes from a server that knows the route.
  assert.deepEqual(
    await signOutWith(() => Response.json({ detail: "device_session_not_found" }, { status: 404 })),
    { remoteRevoked: true, reason: "already_revoked" },
  );
  // FastAPI's default 404 body and a proxy's HTML page mean the route is missing.
  assert.deepEqual(
    await signOutWith(() => Response.json({ detail: "Not Found" }, { status: 404 })),
    { remoteRevoked: false, reason: "endpoint_missing" },
  );
  assert.deepEqual(
    await signOutWith(() => new Response("<html><body>404</body></html>", { status: 404, headers: { "content-type": "text/html" } })),
    { remoteRevoked: false, reason: "endpoint_missing" },
  );
  assert.deepEqual(
    await signOutWith(() => Response.json({ detail: "Method Not Allowed" }, { status: 405 })),
    { remoteRevoked: false, reason: "endpoint_missing" },
  );
  assert.deepEqual(
    await signOutWith(() => Response.json({ detail: "maintenance" }, { status: 503 })),
    { remoteRevoked: false, reason: "unreachable" },
  );
  assert.deepEqual(
    await signOutWith(() => Response.json({ detail: [{ msg: "field required" }] }, { status: 422 })),
    { remoteRevoked: false, reason: "unreachable" },
  );
  assert.deepEqual(
    await signOutWith(() => { throw new Error("offline"); }),
    { remoteRevoked: false, reason: "unreachable" },
  );
});

test("classifyRemoteLogout covers the status matrix without a response body", () => {
  assert.deepEqual(classifyRemoteLogout(204), { remoteRevoked: true, reason: "revoked" });
  assert.deepEqual(classifyRemoteLogout(401), { remoteRevoked: true, reason: "already_revoked" });
  assert.deepEqual(classifyRemoteLogout(404), { remoteRevoked: false, reason: "endpoint_missing" });
  assert.deepEqual(classifyRemoteLogout(404, "not found."), { remoteRevoked: false, reason: "endpoint_missing" });
  assert.deepEqual(classifyRemoteLogout(404, "device_session_not_found"), { remoteRevoked: true, reason: "already_revoked" });
  assert.deepEqual(classifyRemoteLogout(501), { remoteRevoked: false, reason: "endpoint_missing" });
  assert.deepEqual(classifyRemoteLogout(500), { remoteRevoked: false, reason: "unreachable" });
  assert.deepEqual(classifyRemoteLogout(429), { remoteRevoked: false, reason: "unreachable" });
});

test("server-driven invalidation reports an already revoked session without a logout call", async () => {
  let logoutCalls = 0;
  const options = await storeOptions({
    env: LEGACY_ENV,
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith("/device/logout")) logoutCalls += 1;
      return Response.json({ email: "person@example.com", status: "active" });
    },
  });
  const store = createDesktopOmniRushAccountStore(options);
  assert.equal((await store.status()).connected, true);
  assert.deepEqual(await store.clear({ revokeRemote: false }), { remoteRevoked: true, reason: "already_revoked" });
  assert.equal(logoutCalls, 0);
  assert.equal((await createDesktopOmniRushAccountStore(options).status()).connected, false);
});

function fakeMacKeychain(initial) {
  const items = new Map(Object.entries(initial));
  const calls = [];
  const execFileImpl = async (file, args) => {
    assert.equal(file, "/usr/bin/security");
    calls.push(args);
    const service = args[args.indexOf("-s") + 1];
    if (args[0] === "find-generic-password") {
      if (items.has(service)) return { stdout: `${items.get(service)}\n`, stderr: "" };
    } else if (args[0] === "delete-generic-password") {
      if (items.delete(service)) return { stdout: "", stderr: "" };
    } else {
      throw new Error(`unexpected security ${args.join(" ")}`);
    }
    throw Object.assign(new Error("The specified item could not be found in the keychain."), { code: 44 });
  };
  return { items, calls, execFileImpl };
}

test("sign out on macOS forgets the keychain gateway URL so the next sign-in uses the default server", async () => {
  const keychain = fakeMacKeychain({ [KEYCHAIN_SERVICES.gatewayUrl]: "https://staging.example/omnirush/v1" });
  const logoutRequests = [];
  const options = await storeOptions({
    platform: "darwin",
    execFileImpl: keychain.execFileImpl,
    env: { OMNIRUSH_DEV_MODE: "1", OMNIRUSH_ACCESS_TOKEN: "legacy-access", OMNIRUSH_REFRESH_TOKEN: "legacy-refresh" },
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith("/device/logout")) {
        logoutRequests.push(String(url));
        return new Response(null, { status: 204 });
      }
      return Response.json({ email: "person@example.com", status: "active" });
    },
  });

  const store = createDesktopOmniRushAccountStore(options);
  const before = await store.status();
  assert.equal(before.connected, true);
  assert.equal(before.gatewayUrl, "https://staging.example/omnirush/v1");
  assert.equal(before.gatewayHost, "staging.example");

  assert.deepEqual(await store.clear(), { remoteRevoked: true, reason: "revoked" });
  assert.deepEqual(logoutRequests, ["https://staging.example/omnirush/device/logout"]);
  const deletes = keychain.calls.filter((args) => args[0] === "delete-generic-password");
  assert.deepEqual(deletes, [["delete-generic-password", "-s", KEYCHAIN_SERVICES.gatewayUrl], ["delete-generic-password", "-s", KEYCHAIN_SERVICES.gatewayUrl]]);
  assert.equal(keychain.items.has(KEYCHAIN_SERVICES.gatewayUrl), false);

  const after = await createDesktopOmniRushAccountStore(options).status();
  assert.equal(after.connected, false);
  assert.equal(after.gatewayUrl, "https://omnirush.ai/omnirush/v1");
  assert.equal(after.gatewayHost, "omnirush.ai");
});

test("sign out removes every duplicate keychain gateway URL item", async () => {
  let copies = 3;
  const calls = [];
  const options = await storeOptions({
    platform: "darwin",
    execFileImpl: async (_file, args) => {
      calls.push(args);
      if (args[0] === "find-generic-password") throw new Error("not found");
      if (copies > 0) {
        copies -= 1;
        return { stdout: "", stderr: "" };
      }
      throw new Error("not found");
    },
    env: LEGACY_ENV,
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  const store = createDesktopOmniRushAccountStore(options);
  await store.status();
  await store.clear();
  assert.equal(calls.filter((args) => args[0] === "delete-generic-password").length, 4);
  assert.equal(copies, 0);
});

test("server-driven invalidation keeps the keychain gateway URL", async () => {
  const keychain = fakeMacKeychain({ [KEYCHAIN_SERVICES.gatewayUrl]: "https://staging.example/omnirush/v1" });
  const options = await storeOptions({
    platform: "darwin",
    execFileImpl: keychain.execFileImpl,
    env: { OMNIRUSH_DEV_MODE: "1", OMNIRUSH_ACCESS_TOKEN: "expired-access", OMNIRUSH_REFRESH_TOKEN: "expired-refresh" },
    fetchImpl: async () => Response.json({ detail: "device_token_invalid" }, { status: 401 }),
  });
  const status = await createDesktopOmniRushAccountStore(options).status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, true);
  assert.equal(status.gatewayHost, "staging.example");
  assert.equal(keychain.calls.some((args) => args[0] === "delete-generic-password"), false);
  assert.equal(keychain.items.get(KEYCHAIN_SERVICES.gatewayUrl), "https://staging.example/omnirush/v1");
});

test("status names the account server the app is connected to", async () => {
  const publicStore = createDesktopOmniRushAccountStore(await storeOptions({ env: {} }));
  assert.deepEqual(await publicStore.status(), {
    connected: false,
    gatewayConfigured: true,
    gatewayUrl: "https://omnirush.ai/omnirush/v1",
    gatewayHost: "omnirush.ai",
  });

  const localStore = createDesktopOmniRushAccountStore(await storeOptions({ env: { OMNIRUSH_DEV_MODE: "1", OMNIRUSH_LOCAL_API: "1" } }));
  const local = await localStore.status();
  assert.equal(local.gatewayUrl, "http://localhost:8090/omnirush/v1");
  assert.equal(local.gatewayHost, "localhost:8090 (local API)");

  const connectedStore = createDesktopOmniRushAccountStore(await storeOptions({
    env: { ...LEGACY_ENV, OMNIRUSH_GATEWAY_URL: "https://api.example:8443/omnirush/v1" },
    fetchImpl: async () => Response.json({ email: "person@example.com", status: "active" }),
  }));
  const connected = await connectedStore.status();
  assert.equal(connected.connected, true);
  assert.equal(connected.gatewayUrl, "https://api.example:8443/omnirush/v1");
  assert.equal(connected.gatewayHost, "api.example:8443");
});

test("accountServerLabel marks loopback servers as the local API", () => {
  assert.equal(accountServerLabel("https://omnirush.ai/omnirush/v1"), "omnirush.ai");
  assert.equal(accountServerLabel("https://omnirush.ai:443/omnirush/v1/"), "omnirush.ai");
  assert.equal(accountServerLabel("https://api.example:8443/omnirush/v1"), "api.example:8443");
  assert.equal(accountServerLabel("http://localhost:8090/omnirush/v1"), "localhost:8090 (local API)");
  assert.equal(accountServerLabel("http://127.0.0.1:8090/omnirush/v1"), "127.0.0.1:8090 (local API)");
  assert.equal(accountServerLabel("http://example.com/omnirush/v1"), null);
  assert.equal(accountServerLabel(""), null);
  assert.equal(accountServerLabel(null), null);
});
