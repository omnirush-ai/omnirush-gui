import assert from "node:assert/strict";
import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  KEYCHAIN_SERVICES,
  accountServerLabel,
  classifyRemoteLogout,
  createDesktopOmniRushAccountStore,
  legacyKeychainAllowed,
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
    legacyKeychain: true,
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
    legacyKeychain: true,
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
    legacyKeychain: true,
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

test("only the default production profile imports the legacy keychain account", async () => {
  const signedIn = {
    [KEYCHAIN_SERVICES.gatewayUrl]: "https://omnirush.ai/omnirush/v1",
    [KEYCHAIN_SERVICES.accessToken]: "real-access",
    [KEYCHAIN_SERVICES.refreshToken]: "real-refresh",
  };
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    return new URL(url).pathname.endsWith("/device/logout")
      ? new Response(null, { status: 204 })
      : Response.json({ email: "owner@example.com", status: "active" });
  };

  // A custom profile (an eval, a test, a dev or blank-slate one) on the owner's Mac.
  const keychain = fakeMacKeychain(signedIn);
  const isolated = createDesktopOmniRushAccountStore(await storeOptions({ platform: "darwin", env: {}, execFileImpl: keychain.execFileImpl, fetchImpl }));
  const status = await isolated.status();
  assert.equal(status.connected, false);
  assert.equal(status.gatewayUrl, "https://omnirush.ai/omnirush/v1");
  await isolated.clear();
  assert.deepEqual(keychain.calls, []);
  assert.deepEqual(requests, []);
  assert.equal(keychain.items.size, 3);

  // The default production profile still imports it once.
  const production = createDesktopOmniRushAccountStore(await storeOptions({ platform: "darwin", env: {}, legacyKeychain: true, execFileImpl: keychain.execFileImpl, fetchImpl }));
  assert.equal((await production.status()).connected, true);
  assert.deepEqual(requests, ["https://omnirush.ai/omnirush/device/me"]);
});

test("legacyKeychainAllowed admits the default production profile alone", () => {
  const production = { appIdentifier: "ai.omnirush.desktop", productionAppIdentifier: "ai.omnirush.desktop", blankSlate: false };
  assert.equal(legacyKeychainAllowed({ ...production, env: {} }), true);
  assert.equal(legacyKeychainAllowed({ ...production, env: { OMNIRUSH_ELECTRON_USERDATA: "  " } }), true);
  const refused = {
    "dev identifier": { ...production, appIdentifier: "ai.omnirush.desktop.dev", env: {} },
    "eval identifier": { ...production, appIdentifier: "ai.omnirush.desktop.eval.search", env: {} },
    "blank slate": { ...production, blankSlate: true, env: {} },
    "userData override": { ...production, env: { OMNIRUSH_ELECTRON_USERDATA: "/tmp/eval/electron-userdata" } },
    "identifier override": { ...production, env: { OMNIRUSH_ELECTRON_APP_IDENTIFIER: "ai.omnirush.desktop" } },
    "mock keychain": { ...production, env: { OMNIRUSH_ELECTRON_USE_MOCK_KEYCHAIN: "1" } },
  };
  for (const [label, launch] of Object.entries(refused)) assert.equal(legacyKeychainAllowed(launch), false, label);
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

// The embedded broker shares this store and rotates the same device session
// (its persist() is store.save(), its latest() is store.load()). The server
// retires a refresh token on rotation, so whichever holder spends a token
// the other one already rotated is answered 401.

const SHARED_GATEWAY_URL = "https://gateway.example/omnirush/v1";

/** Fake account server: one live pair; a rotation retires the refresh token it spent. */
function fakeAccountServer() {
  const server = {
    access: "access-1",
    refresh: "refresh-1",
    generation: 1,
    expired: new Set(),
    refreshCalls: [],
    holdProfile: null,
    holdRefresh: null,
    holdLogout: null,
    contendNext: false,
  };
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    const bearer = new Headers(init.headers).get("authorization")?.slice(7) ?? "";
    if (pathname.endsWith("/device/me")) {
      if (server.holdProfile) await server.holdProfile;
      return bearer === server.access && !server.expired.has(bearer)
        ? Response.json({ email: "person@example.com", status: "active" })
        : Response.json({ detail: "device_token_invalid" }, { status: 401 });
    }
    if (pathname.endsWith("/device/refresh")) {
      const token = JSON.parse(init.body).refresh_token;
      server.refreshCalls.push(token);
      // Held before the check, so the other holder can retire the token meanwhile.
      const hold = server.holdRefresh;
      server.holdRefresh = null;
      if (hold) await hold;
      if (server.contendNext) {
        server.contendNext = false;
        return Response.json({ detail: "refresh_token_already_used" }, { status: 409 });
      }
      if (token !== server.refresh) return Response.json({ detail: "refresh_token_invalid_or_expired" }, { status: 401 });
      server.generation += 1;
      server.access = `access-${server.generation}`;
      server.refresh = `refresh-${server.generation}`;
      return Response.json({ access_token: server.access, refresh_token: server.refresh });
    }
    if (pathname.endsWith("/device/logout")) {
      if (server.holdLogout) await server.holdLogout;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request ${pathname}`);
  };
  return { server, fetchImpl };
}

function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve = () => {};
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const tick = (milliseconds = 5) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function connectedStore(fetchImpl, overrides = {}) {
  const options = await storeOptions({ fetchImpl, ...overrides });
  const store = createDesktopOmniRushAccountStore(options);
  await store.save({ gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-1", refreshToken: "refresh-1" });
  return { store, options };
}

/** What the embedded broker does on a 401: rotate through the same server and persist the result. */
async function brokerRotates(store, fetchImpl, current) {
  const response = await fetchImpl(`${SHARED_GATEWAY_URL.replace(/\/v1$/, "")}/device/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: current.refreshToken }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  await store.save({
    gatewayUrl: SHARED_GATEWAY_URL,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    rotation: current.rotation + 1,
  });
}

test("profile check adopts the pair the embedded broker persisted while it was in flight", async () => {
  const { server, fetchImpl } = fakeAccountServer();
  const { store } = await connectedStore(fetchImpl);
  server.expired.add("access-1");
  const profile = deferred();
  server.holdProfile = profile.promise;
  const status = store.status(); // GET /device/me with the expired token is now in flight
  await tick();
  await brokerRotates(store, fetchImpl, { refreshToken: "refresh-1", rotation: 0 }); // 1 -> 2, persisted
  server.holdProfile = null;
  profile.resolve();
  const result = await status; // 401: the closure's refresh-1 is retired and is never spent
  assert.equal(result.connected, true);
  assert.equal(result.email, "person@example.com");
  assert.equal(result.reauthorizationRequired, undefined);
  assert.deepEqual(server.refreshCalls, ["refresh-1"]);
  assert.deepEqual(await store.load(), { gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-2", refreshToken: "refresh-2", rotation: 1 });
});

test("a refresh rejected because the broker rotated first adopts the persisted pair instead of signing out", async () => {
  const { server, fetchImpl } = fakeAccountServer();
  const { store } = await connectedStore(fetchImpl);
  server.expired.add("access-1");
  const refresh = deferred();
  server.holdRefresh = refresh.promise;
  const status = store.status(); // 401 -> POST /device/refresh with refresh-1, held inside the handler
  await tick();
  await brokerRotates(store, fetchImpl, { refreshToken: "refresh-1", rotation: 0 }); // retires refresh-1
  refresh.resolve();
  const result = await status; // the held refresh is answered 401
  assert.equal(result.connected, true);
  assert.equal(result.email, "person@example.com");
  assert.deepEqual(server.refreshCalls, ["refresh-1", "refresh-1"]);
  assert.equal((await store.load()).refreshToken, "refresh-2");
});

test("load() waits for a rotation in flight so the broker reads the settled pair", async () => {
  const { server, fetchImpl } = fakeAccountServer();
  const slowStorage = {
    ...testStorage(),
    encryptStringAsync: async (value) => {
      await tick(20);
      return Buffer.from(value, "utf8");
    },
  };
  const { store } = await connectedStore(fetchImpl, { loadSafeStorage: () => slowStorage });
  server.expired.add("access-1");
  const refresh = deferred();
  server.holdRefresh = refresh.promise;
  const status = store.status();
  await tick();
  const latest = store.load(); // the broker's latest(), asked mid-rotation
  refresh.resolve();
  assert.deepEqual(await latest, { gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-2", refreshToken: "refresh-2", rotation: 1 });
  assert.equal((await status).connected, true);
});

test("a contended refresh (409) leaves the account connected until the other holder's pair lands", async () => {
  const { server, fetchImpl } = fakeAccountServer();
  const { store } = await connectedStore(fetchImpl);
  server.expired.add("access-1");
  server.contendNext = true;
  const unverified = await store.status();
  assert.equal(unverified.connected, true);
  assert.equal(unverified.reauthorizationRequired, undefined);
  assert.equal(unverified.email, null);
  assert.equal((await store.load()).refreshToken, "refresh-1");
  await brokerRotates(store, fetchImpl, { refreshToken: "refresh-1", rotation: 0 });
  const verified = await store.status();
  assert.equal(verified.email, "person@example.com");
  assert.deepEqual(server.refreshCalls, ["refresh-1", "refresh-1"]);
});

test("a reader that races the sign-out cannot resurrect the cleared account", async () => {
  const { server, fetchImpl } = fakeAccountServer();
  const { store, options } = await connectedStore(fetchImpl);
  const logout = deferred();
  server.holdLogout = logout.promise;
  const clearing = store.clear();
  await tick();
  const read = store.load(); // the broker's latest(), asked mid-sign-out
  logout.resolve();
  assert.deepEqual(await clearing, { remoteRevoked: true, reason: "revoked" });
  assert.equal(await read, null);
  assert.equal(await store.load(), null);
  assert.equal((await createDesktopOmniRushAccountStore(options).status()).connected, false);
});

test("a broker persist during a user sign-out is dropped; during a server-driven sign-out it lands", async () => {
  const { server, fetchImpl } = fakeAccountServer();
  const { store } = await connectedStore(fetchImpl);
  const logout = deferred();
  server.holdLogout = logout.promise;
  const clearing = store.clear();
  await tick();
  const dropped = store.save({ gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-2", refreshToken: "refresh-2", rotation: 1 });
  logout.resolve();
  await clearing;
  await dropped;
  assert.equal(await store.load(), null);

  const { store: invalidated } = await connectedStore(fetchImpl);
  const clearingServerDriven = invalidated.clear({ revokeRemote: false });
  const landed = invalidated.save({ gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-2", refreshToken: "refresh-2", rotation: 1 });
  await clearingServerDriven;
  await landed;
  assert.deepEqual(await invalidated.load(), { gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-2", refreshToken: "refresh-2", rotation: 1 });
});

test("a bundle persisted before the rotation counter loads as rotation 0 and counts from there", async () => {
  const { server, fetchImpl } = fakeAccountServer();
  const options = await storeOptions({ fetchImpl });
  await writeFile(options.filePath, JSON.stringify({ gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-1", refreshToken: "refresh-1" }));
  const store = createDesktopOmniRushAccountStore(options);
  assert.deepEqual(await store.load(), { gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-1", refreshToken: "refresh-1", rotation: 0 });
  server.expired.add("access-1");
  assert.equal((await store.status()).email, "person@example.com");
  assert.equal(JSON.parse(await readFile(options.filePath, "utf8")).rotation, 1);
});

// Linux without a usable keyring: the sign-in falls back to an owner-only file.

const FAKE_GATEWAY_URL = "http://127.0.0.1:9/omnirush/v1";

/** A fake safeStorage reporting `backend`; "encrypts" by prefixing so tests can tell sealed bytes apart. */
function linuxStorage(backend, { available = true } = {}) {
  return {
    isAsyncEncryptionAvailable: async () => available,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (value) => Buffer.from(`sealed:${value}`, "utf8"),
    decryptStringAsync: async (value) => {
      const text = value.toString("utf8");
      if (!text.startsWith("sealed:")) throw new Error("not sealed by this keyring");
      return { result: text.slice("sealed:".length), shouldReEncrypt: false };
    },
  };
}

async function fallbackOptions(storage, overrides = {}) {
  const logs = [];
  const options = await storeOptions({
    loadSafeStorage: () => storage,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/device/me")) return Response.json({ email: "person@example.com", status: "active" });
      if (pathname.endsWith("/device/logout")) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${pathname}`);
    },
    log: (message) => logs.push(message),
    ...overrides,
  });
  const fallbackFilePath = path.join(path.dirname(options.filePath), "private-credentials", "account.json");
  return { options: { ...options, fallbackFilePath }, logs };
}

async function exists(filePath) {
  return access(filePath).then(() => true, () => false);
}

const FAKE_CREDENTIALS = { gatewayUrl: FAKE_GATEWAY_URL, accessToken: "fake-access", refreshToken: "fake-refresh" };

test("Linux basic_text: sign-in lands in an owner-only private file instead of failing", async () => {
  let polls = 0;
  const { options, logs } = await fallbackOptions(linuxStorage("basic_text"), {
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/device/authorize")) {
        return Response.json({ device_code: "code", user_code: "ABCD", verification_uri_complete: "https://omnirush.ai/console?code=ABCD", interval: 0, expires_in: 60 });
      }
      if (pathname.endsWith("/device/token")) {
        polls += 1;
        return Response.json({ gateway_url: FAKE_GATEWAY_URL, access_token: "fake-access", refresh_token: "fake-refresh" });
      }
      if (pathname.endsWith("/device/me")) return Response.json({ email: "person@example.com", status: "active" });
      throw new Error(`Unexpected request ${pathname}`);
    },
  });
  const store = createDesktopOmniRushAccountStore(options);
  const result = await store.authorize({ gatewayUrl: undefined, deviceName: "Test Linux", openVerification: async () => undefined });
  assert.equal(result.connected, true);
  assert.equal(polls, 1);

  assert.equal(await exists(options.filePath), false);
  const saved = JSON.parse(await readFile(options.fallbackFilePath, "utf8"));
  assert.equal(saved.credentials.refreshToken, "fake-refresh");
  assert.match(saved.note, /Unencrypted at rest/);
  if (process.platform !== "win32") {
    assert.equal((await stat(options.fallbackFilePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(options.fallbackFilePath))).mode & 0o777, 0o700);
  }
  assert.equal(logs.filter((line) => /unencrypted at rest/.test(line)).length <= 1, true);
  assert.equal(logs.some((line) => line.includes("fake-access") || line.includes("fake-refresh")), false);

  const status = await createDesktopOmniRushAccountStore(options).status();
  assert.equal(status.connected, true);
  assert.equal(status.credentialStorage, "file");
  assert.equal(status.email, "person@example.com");
});

test("Linux without encryption at all also uses the private file", async () => {
  const { options } = await fallbackOptions(linuxStorage("gnome_libsecret", { available: false }));
  const store = createDesktopOmniRushAccountStore(options);
  await store.save(FAKE_CREDENTIALS);
  assert.equal(await exists(options.fallbackFilePath), true);
  assert.equal((await store.status()).credentialStorage, "file");
});

test("Linux with libsecret keeps the encrypted keyring path and no private file", async () => {
  const { options } = await fallbackOptions(linuxStorage("gnome_libsecret"));
  const store = createDesktopOmniRushAccountStore(options);
  await store.save(FAKE_CREDENTIALS);
  assert.match(await readFile(options.filePath, "utf8"), /^sealed:/);
  assert.equal(await exists(options.fallbackFilePath), false);
  const status = await createDesktopOmniRushAccountStore(options).status();
  assert.equal(status.connected, true);
  assert.equal("credentialStorage" in status, false);
});

test("a keyring that appears later receives the sign-in and the private file is deleted", async () => {
  const { options: plain } = await fallbackOptions(linuxStorage("basic_text"));
  await createDesktopOmniRushAccountStore(plain).save(FAKE_CREDENTIALS);
  assert.equal(await exists(plain.fallbackFilePath), true);

  const { options, logs } = await fallbackOptions(linuxStorage("gnome_libsecret"));
  Object.assign(options, { filePath: plain.filePath, fallbackFilePath: plain.fallbackFilePath });
  const status = await createDesktopOmniRushAccountStore(options).status();
  assert.equal(status.connected, true);
  assert.equal("credentialStorage" in status, false);
  assert.equal(await exists(options.fallbackFilePath), false);
  const sealed = await readFile(options.filePath, "utf8");
  assert.match(sealed, /^sealed:/);
  assert.equal(JSON.parse(sealed.slice("sealed:".length)).refreshToken, "fake-refresh");
  assert.equal(logs.some((line) => /into the system keyring/.test(line)), true);

  // The next launch reads the keyring copy.
  assert.equal((await createDesktopOmniRushAccountStore(options).load())?.refreshToken, "fake-refresh");
});

test("a keyring that disappears asks for a new sign-in instead of failing", async () => {
  const { options: sealed } = await fallbackOptions(linuxStorage("gnome_libsecret"));
  await createDesktopOmniRushAccountStore(sealed).save(FAKE_CREDENTIALS);

  const { options } = await fallbackOptions(linuxStorage("basic_text"));
  Object.assign(options, { filePath: sealed.filePath, fallbackFilePath: sealed.fallbackFilePath });
  const status = await createDesktopOmniRushAccountStore(options).status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, true);
  assert.equal(status.credentialStorage, "file");

  // Signing in again works and lands in the private file.
  const store = createDesktopOmniRushAccountStore(options);
  await store.save({ ...FAKE_CREDENTIALS, refreshToken: "fake-refresh-2" });
  assert.equal((await store.status()).connected, true);
  assert.equal(await exists(options.fallbackFilePath), true);
});

test("sign-out deletes the private file and stays signed out", async () => {
  const { options } = await fallbackOptions(linuxStorage("basic_text"));
  const store = createDesktopOmniRushAccountStore(options);
  await store.save(FAKE_CREDENTIALS);
  assert.equal(await exists(options.fallbackFilePath), true);
  assert.deepEqual(await store.clear(), { remoteRevoked: true, reason: "revoked" });
  assert.equal(await exists(options.fallbackFilePath), false);
  const status = await createDesktopOmniRushAccountStore(options).status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, undefined);
});

for (const platform of /** @type {const} */ (["darwin", "win32"])) {
  test(`${platform}: unavailable secure storage still refuses to store the sign-in, with no private file`, async () => {
    const { options } = await fallbackOptions(linuxStorage("unknown", { available: false }), { platform });
    const store = createDesktopOmniRushAccountStore(options);
    await assert.rejects(store.save(FAKE_CREDENTIALS), /Secure desktop credential storage is unavailable/);
    assert.equal(await exists(options.fallbackFilePath), false);
    const status = await store.status();
    assert.equal(status.connected, false);
    assert.equal("credentialStorage" in status, false);
  });

  test(`${platform}: available secure storage is used exactly as before`, async () => {
    const { options } = await fallbackOptions(linuxStorage(platform === "darwin" ? "keychain" : "dpapi"), { platform });
    const store = createDesktopOmniRushAccountStore(options);
    await store.save(FAKE_CREDENTIALS);
    assert.match(await readFile(options.filePath, "utf8"), /^sealed:/);
    assert.equal(await exists(options.fallbackFilePath), false);
    assert.equal("credentialStorage" in await store.status(), false);
  });
}

test("Linux basic_text without a fallback path keeps refusing (no silent plaintext)", async () => {
  const options = await storeOptions({ loadSafeStorage: () => linuxStorage("basic_text") });
  await assert.rejects(
    createDesktopOmniRushAccountStore(options).save(FAKE_CREDENTIALS),
    /Secure desktop credential storage is unavailable/,
  );
});
