import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDesktopOmniRushAccountStore } from "./omnirush-account.mjs";

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
