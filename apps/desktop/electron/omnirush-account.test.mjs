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
  assert.deepEqual(requests, [
    "/omnirush/device/authorize",
    "/omnirush/device/token",
    "/omnirush/device/token",
  ]);
  assert.equal((await store.status()).connected, true);
  assert.match(await readFile(options.filePath, "utf8"), /access-token/);

  const restored = createDesktopOmniRushAccountStore(options);
  assert.equal((await restored.status()).connected, true);
});

test("sign out prevents legacy credentials from being imported again", async () => {
  const options = await storeOptions({
    env: {
      OMNIRUSH_DEV_MODE: "1",
      OMNIRUSH_GATEWAY_URL: "http://localhost:8090/omnirush/v1",
      OMNIRUSH_ACCESS_TOKEN: "legacy-access",
      OMNIRUSH_REFRESH_TOKEN: "legacy-refresh",
    },
  });
  const store = createDesktopOmniRushAccountStore(options);
  assert.equal((await store.status()).connected, true);
  await store.clear();
  const restarted = createDesktopOmniRushAccountStore(options);
  assert.equal((await restarted.status()).connected, false);
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
