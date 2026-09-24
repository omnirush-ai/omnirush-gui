import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createOpenLogsFolderHandler, resolveDesktopLogsDir } from "./logs-folder.mjs";

const USER_DATA = path.resolve("/tmp/omnirush-test-user-data");
const trustedEvent = { trusted: true };

function harness(overrides = {}) {
  const calls = { ensured: [], opened: [] };
  const handler = createOpenLogsFolderHandler({
    getUserDataPath: () => USER_DATA,
    isTrustedSender: (event) => event?.trusted === true,
    ensureDir: async (dir) => { calls.ensured.push(dir); },
    openPath: async (dir) => { calls.opened.push(dir); return ""; },
    ...overrides,
  });
  return { handler, calls };
}

describe("resolveDesktopLogsDir", () => {
  it("is the logs folder inside userData", () => {
    assert.equal(resolveDesktopLogsDir(USER_DATA), path.join(USER_DATA, "logs"));
  });

  it("refuses an empty or relative userData path", () => {
    assert.throws(() => resolveDesktopLogsDir(""));
    assert.throws(() => resolveDesktopLogsDir("relative/dir"));
    assert.throws(() => resolveDesktopLogsDir(undefined));
  });
});

describe("openLogsFolder IPC handler", () => {
  it("creates and opens <userData>/logs", async () => {
    const { handler, calls } = harness();
    assert.deepEqual(await handler(trustedEvent), { ok: true });
    assert.deepEqual(calls.ensured, [path.join(USER_DATA, "logs")]);
    assert.deepEqual(calls.opened, [path.join(USER_DATA, "logs")]);
  });

  it("ignores any path the renderer sends", async () => {
    const { handler, calls } = harness();
    await handler(trustedEvent, "/etc", "C:\\Windows\\System32", { path: "/" });
    assert.deepEqual(calls.opened, [path.join(USER_DATA, "logs")]);
  });

  it("rejects callers other than the main window without touching the disk", async () => {
    const { handler, calls } = harness();
    const result = await handler({ trusted: false });
    assert.equal(result.ok, false);
    assert.match(result.error, /main window/);
    assert.deepEqual(calls.ensured, []);
    assert.deepEqual(calls.opened, []);
  });

  it("reports the shell's error string", async () => {
    const { handler } = harness({ openPath: async () => "No application is associated" });
    assert.deepEqual(await handler(trustedEvent), { ok: false, error: "No application is associated" });
  });

  it("reports a folder that cannot be created and does not open anything", async () => {
    const opened = [];
    const { handler } = harness({
      ensureDir: async () => { throw new Error("EACCES"); },
      openPath: async (dir) => { opened.push(dir); return ""; },
    });
    assert.deepEqual(await handler(trustedEvent), { ok: false, error: "EACCES" });
    assert.deepEqual(opened, []);
  });
});

describe("main process wiring", () => {
  const mainSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8");

  it("registers openLogsFolder so that only the IPC event reaches the handler", () => {
    assert.match(mainSource, /^  "openLogsFolder": async \(event\) => \{\n      return openLogsFolder\(event\);\n  \},$/m);
  });

  it("guards on the main window's top frame and the fixed userData path", () => {
    const start = mainSource.indexOf("const openLogsFolder = createOpenLogsFolderHandler({");
    assert.notEqual(start, -1);
    const block = mainSource.slice(start, mainSource.indexOf("});", start));
    assert.match(block, /getUserDataPath: \(\) => app\.getPath\("userData"\)/);
    assert.match(block, /event\?\.sender === mainWindow\.webContents/);
    assert.match(block, /event\?\.senderFrame === mainWindow\.webContents\.mainFrame/);
  });
});
