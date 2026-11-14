import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { openExternalUrl } from "./open-external.mjs";

describe("openExternalUrl", () => {
  it("reports success when shell.openExternal resolves", async () => {
    let openedUrl = "";
    const result = await openExternalUrl("https://example.com", {
      env: {},
      openExternal: async (url) => {
        openedUrl = url;
      },
      platform: "linux",
      timeoutMs: 20,
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(openedUrl, "https://example.com");
  });

  it("attempts rundll32 fallback on Windows after shell.openExternal rejects", async () => {
    let spawnCall = null;
    let unrefCalled = false;

    const result = await openExternalUrl("https://example.com", {
      env: {},
      openExternal: async () => {
        throw new Error("association broken");
      },
      platform: "win32",
      spawnProcess: (command, args, options) => {
        spawnCall = { command, args, options };
        return {
          unref() {
            unrefCalled = true;
          },
        };
      },
      timeoutMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "association broken");
    assert.deepEqual(spawnCall, {
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", "https://example.com"],
      options: { detached: true, stdio: "ignore" },
    });
    assert.equal(unrefCalled, true);
  });

  it("does not attempt rundll32 fallback off Windows after shell.openExternal rejects", async () => {
    let spawnCalled = false;

    const result = await openExternalUrl("https://example.com", {
      env: {},
      openExternal: async () => {
        throw new Error("blocked");
      },
      platform: "darwin",
      spawnProcess: () => {
        spawnCalled = true;
        return { unref() {} };
      },
      timeoutMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "blocked");
    assert.equal(spawnCalled, false);
  });

  it("times out if shell.openExternal never settles", async () => {
    const result = await openExternalUrl("https://example.com", {
      env: {},
      openExternal: () => new Promise(() => {}),
      platform: "linux",
      timeoutMs: 1,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "timed out after 1ms");
  });

  it("simulates failure without calling shell.openExternal", async () => {
    let opened = false;
    let spawnCalled = false;

    const result = await openExternalUrl("https://example.com", {
      env: { OMNIRUSH_SIMULATE_OPEN_EXTERNAL_FAILURE: "1" },
      openExternal: async () => {
        opened = true;
      },
      platform: "win32",
      spawnProcess: () => {
        spawnCalled = true;
        return { unref() {} };
      },
      timeoutMs: 20,
    });

    assert.deepEqual(result, { ok: false, error: "simulated failure" });
    assert.equal(opened, false);
    assert.equal(spawnCalled, false);
  });

  it("refuses schemes that are not web links or settings panes", async () => {
    const refused = [
      "file:///C:/Windows/System32/calc.exe",
      "ms-msdt:/id PCWDiagnostic",
      "search-ms:query=x",
      "smb://host/share",
      "javascript:alert(1)",
      "C:\\Windows\\System32\\calc.exe",
      "",
    ];
    for (const url of refused) {
      let opened = false;
      let spawnCalled = false;
      const result = await openExternalUrl(url, {
        env: {},
        openExternal: async () => {
          opened = true;
        },
        platform: "win32",
        spawnProcess: () => {
          spawnCalled = true;
          return { unref() {} };
        },
        timeoutMs: 20,
      });

      assert.equal(result.ok, false, url);
      assert.equal(opened, false, url);
      assert.equal(spawnCalled, false, url);
    }
  });

  it("opens mailto links and the microphone settings panes", async () => {
    const allowed = [
      "mailto:info@example.com",
      "ms-settings:privacy-microphone",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    ];
    for (const url of allowed) {
      let openedUrl = "";
      const result = await openExternalUrl(url, {
        env: {},
        openExternal: async (target) => {
          openedUrl = target;
        },
        platform: "linux",
        timeoutMs: 20,
      });

      assert.deepEqual(result, { ok: true }, url);
      assert.equal(openedUrl, url);
    }
  });

  it("keeps non-web links away from the rundll32 fallback", async () => {
    let spawnCalled = false;
    const result = await openExternalUrl("mailto:info@example.com", {
      env: {},
      openExternal: async () => {
        throw new Error("no mail client");
      },
      platform: "win32",
      spawnProcess: () => {
        spawnCalled = true;
        return { unref() {} };
      },
      timeoutMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(spawnCalled, false);
  });
});
