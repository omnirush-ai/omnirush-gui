import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import { createBrowserDownloads, markDownloaded, quarantineValue, safeDownloadName, uniqueDownloadPath, zoneIdentifier } from "./browser-downloads.mjs";

const DIR = path.join("/", "home", "priya", "Downloads");

test("download names are safe on every system and never replace a file", () => {
  assert.equal(safeDownloadName("report.pdf"), "report.pdf");
  assert.equal(safeDownloadName("../../etc/passwd"), "passwd");
  assert.equal(safeDownloadName("..\\..\\Windows\\win.ini"), "win.ini");
  assert.equal(safeDownloadName("a<b>c:d|e?.txt"), "a_b_c_d_e_.txt");
  assert.equal(safeDownloadName(".hidden"), "hidden");
  assert.equal(safeDownloadName("CON.txt"), "download_CON.txt");
  assert.equal(safeDownloadName(""), "download");
  assert.equal(safeDownloadName("x".repeat(400)).length, 180);
  const taken = new Set([path.join(DIR, "report.pdf"), path.join(DIR, "report (1).pdf"), path.join(DIR, "logs.tar.gz")]);
  assert.equal(uniqueDownloadPath(DIR, "report.pdf", (file) => taken.has(file)), path.join(DIR, "report (2).pdf"));
  assert.equal(uniqueDownloadPath(DIR, "logs.tar.gz", (file) => taken.has(file)), path.join(DIR, "logs (1).tar.gz"));
  assert.equal(uniqueDownloadPath(DIR, "new.csv", (file) => taken.has(file)), path.join(DIR, "new.csv"));
});

test("macOS: a download gets the quarantine mark unless the system already set one", async () => {
  const runs = [];
  const run = async (file, args) => {
    runs.push([file, ...args]);
    if (args[0] === "-p") throw new Error("No such xattr: com.apple.quarantine");
    return "";
  };
  const now = Date.UTC(2026, 10, 23, 18);
  assert.deepEqual(await markDownloaded("/Users/p/Downloads/a.dmg", { platform: "darwin", run, now }), { mark: "quarantine", added: true });
  assert.deepEqual(runs[1], ["/usr/bin/xattr", "-w", "com.apple.quarantine", `0081;${Math.floor(now / 1000).toString(16)};OmniRush;`, "/Users/p/Downloads/a.dmg"]);
  assert.match(quarantineValue(now, "Omni;Rush"), /^0081;[0-9a-f]+;Omni Rush;$/);
  const kept = [];
  assert.deepEqual(await markDownloaded("/Users/p/Downloads/b.zip", { platform: "darwin", now, run: async (file, args) => { kept.push(args[0]); return "0083;6560a1b2;Safari;"; } }), { mark: "quarantine", added: false });
  assert.deepEqual(kept, ["-p"], "an existing mark is never rewritten");
});

test("Windows: a download gets a Zone.Identifier for the Internet zone, without user names or passwords", async () => {
  const writes = [];
  const result = await markDownloaded("C:\\Users\\p\\Downloads\\setup.exe", {
    platform: "win32", url: "https://user:secret@files.example.com/setup.exe", referrer: "https://intranet.example/apps",
    read: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    write: async (file, data) => { writes.push([file, data]); },
  });
  assert.deepEqual(result, { mark: "zone", added: true });
  assert.equal(writes[0][0], "C:\\Users\\p\\Downloads\\setup.exe:Zone.Identifier");
  assert.equal(writes[0][1], "[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://intranet.example/apps\r\nHostUrl=https://files.example.com/setup.exe\r\n");
  assert.equal(zoneIdentifier({ url: "blob:https://a.example/123" }), "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:internet\r\n");
  const again = [];
  assert.deepEqual(await markDownloaded("C:\\d\\a.exe", { platform: "win32", read: async () => "[ZoneTransfer]\r\nZoneId=3\r\n", write: async (...args) => { again.push(args); } }), { mark: "zone", added: false });
  assert.equal(again.length, 0);
  assert.deepEqual(await markDownloaded("/home/p/a", { platform: "linux" }), { mark: null, added: false });
});

class FakeItem extends EventEmitter {
  constructor(filename, url, total = 1000) {
    super();
    this.filename = filename;
    this.url = url;
    this.total = total;
    this.received = 0;
    this.savePath = null;
    this.cancelled = false;
  }
  getFilename() { return this.filename; }
  getURL() { return this.url; }
  getTotalBytes() { return this.total; }
  getReceivedBytes() { return this.received; }
  setSavePath(value) { this.savePath = value; }
  cancel() { this.cancelled = true; this.emit("done", {}, "cancelled"); }
}

test("the list: saved to the Downloads folder, marked before it shows as done, the last 5 only", async () => {
  let clock = 1_000;
  const changes = [];
  const marks = [];
  const finished = [];
  const files = new Set([path.join(DIR, "rates.xlsx")]);
  const downloads = createBrowserDownloads({
    downloadsDir: () => DIR,
    platform: "darwin",
    exists: (file) => files.has(file),
    mark: async (file, info) => { marks.push([file, info]); return { mark: "quarantine", added: true }; },
    onChange: (list) => changes.push(list),
    onFinished: (file) => finished.push(file),
    now: () => clock,
  });
  const first = new FakeItem("rates.xlsx", "https://share.example.com/rates.xlsx", 2048);
  const id = downloads.track(first, { referrer: "https://share.example.com/sites/ops" });
  assert.equal(first.savePath, path.join(DIR, "rates (1).xlsx"), "an existing file keeps its name");
  // Two at once with the same name never share a path.
  const twin = new FakeItem("rates.xlsx", "https://share.example.com/rates.xlsx");
  downloads.track(twin);
  assert.equal(twin.savePath, path.join(DIR, "rates (2).xlsx"));
  assert.deepEqual(downloads.list().map((entry) => [entry.filename, entry.state]), [["rates (2).xlsx", "progressing"], ["rates (1).xlsx", "progressing"]]);

  first.received = 1024;
  clock += 1_000;
  first.emit("updated", {}, "progressing");
  assert.equal(changes.at(-1).find((entry) => entry.id === id).receivedBytes, 1024);
  first.received = 2048;
  first.emit("done", {}, "completed");
  assert.equal(downloads.list().find((entry) => entry.id === id).state, "progressing", "not done until it is marked");
  assert.equal(downloads.savedPath(id), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(marks, [[path.join(DIR, "rates (1).xlsx"), { platform: "darwin", url: "https://share.example.com/rates.xlsx", referrer: "https://share.example.com/sites/ops" }]]);
  assert.equal(downloads.list().find((entry) => entry.id === id).state, "completed");
  assert.equal(downloads.savedPath(id), path.join(DIR, "rates (1).xlsx"));
  assert.deepEqual(finished, [path.join(DIR, "rates (1).xlsx")]);
  assert.equal(JSON.stringify(downloads.list()).includes(DIR), false, "the list never carries a folder");

  downloads.cancel(twin.savePath);
  assert.equal(twin.cancelled, false, "cancel takes an id");
  const twinId = downloads.list()[0].id;
  downloads.cancel(twinId);
  assert.equal(downloads.list()[0].state, "cancelled");
  const failed = new FakeItem("big.iso", "https://mirror.example/big.iso", 0);
  downloads.track(failed);
  failed.emit("done", {}, "interrupted");
  assert.equal(downloads.list()[0].state, "failed");

  for (let index = 0; index < 6; index += 1) downloads.track(new FakeItem(`f${index}.txt`, "https://a.example/f"));
  assert.equal(downloads.list().length, 5);
  assert.equal(downloads.list()[0].filename, "f5.txt");
  // Clear browsing data: finished ones go, the ones still running stay.
  assert.deepEqual(downloads.clear().map((entry) => entry.filename), ["f5.txt", "f4.txt", "f3.txt", "f2.txt", "f1.txt"]);
  assert.equal(downloads.savedPath(id), null);
});

test("a mark that fails still finishes the download and says so in the log", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const downloads = createBrowserDownloads({ downloadsDir: () => DIR, platform: "darwin", exists: () => false, mark: async () => { throw new Error("xattr failed"); } });
  const item = new FakeItem("a.pdf", "https://a.example/a.pdf");
  const id = downloads.track(item);
  item.emit("done", {}, "completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(downloads.list()[0].state, "completed");
  assert.equal(downloads.savedPath(id), path.join(DIR, "a.pdf"));
  assert.equal(warn.mock.callCount(), 1);
});
