import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBrowserSiteGuard, isWorkChatDirectory, rememberedCompany } from "./browser-site-guard.mjs";

function workDir() {
  const root = mkdtempSync(path.join(tmpdir(), "browser-site-guard-"));
  const dir = path.join(root, "work");
  mkdirSync(dir, { recursive: true });
  return { root, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function saveBlock(dir, block) {
  writeFileSync(path.join(dir, "server.json"), JSON.stringify({ block, at: 1 }));
}

test("a Work chat is a chat in an account's Work folder, nothing else", () => {
  const dir = "/data/OmniRush/work";
  assert.equal(isWorkChatDirectory(dir, "/data/OmniRush/work/acc_123"), true);
  assert.equal(isWorkChatDirectory(dir, "/data/OmniRush/work/acc_123/"), true);
  assert.equal(isWorkChatDirectory(dir, "/data/OmniRush/work"), false);
  assert.equal(isWorkChatDirectory(dir, "/data/OmniRush/work/acc_123/notes"), false);
  assert.equal(isWorkChatDirectory(dir, "/data/OmniRush/work/../projects/acc_123"), false);
  assert.equal(isWorkChatDirectory(dir, "/home/me/projects/site"), false);
  assert.equal(isWorkChatDirectory(dir, "/data/OmniRush/work/has space"), false);
  assert.equal(isWorkChatDirectory(dir, undefined), false);
  assert.equal(isWorkChatDirectory("", "/data/OmniRush/work/acc_123"), false);
});

test("a company account is one whose last Work block named a company", () => {
  const { dir, cleanup } = workDir();
  try {
    assert.equal(rememberedCompany(dir), null, "never seen");
    saveBlock(dir, { enabled: true, sources: [] });
    assert.equal(rememberedCompany(dir), null, "Work on, no company");
    saveBlock(dir, { enabled: true, enterprise: { status: "active", org: { id: "org_1", name: " Acme Freight " }, role: "member" } });
    assert.deepEqual(rememberedCompany(dir), { id: "org_1", name: "Acme Freight" });
    saveBlock(dir, { enabled: false, enterprise: { status: "pending" } });
    assert.deepEqual(rememberedCompany(dir), { id: null, name: null }, "a company still waiting counts");
    writeFileSync(path.join(dir, "server.json"), "{not json");
    assert.equal(rememberedCompany(dir), null);
  } finally {
    cleanup();
  }
});

test("Work chats ask before each new site; Code chats of other accounts do not; a company account's chats all ask", () => {
  const { dir, cleanup } = workDir();
  try {
    const guard = createBrowserSiteGuard({ workDir: dir });
    guard.noteSession({ sessionId: "ses_work", directory: path.join(dir, "acc_1") });
    guard.noteSession({ sessionId: "ses_code", directory: "/home/me/projects/site" });
    guard.noteSession({ sessionId: "", directory: path.join(dir, "acc_1") });
    guard.noteSession(null);
    assert.equal(guard.sitesAsk("ses_work"), true);
    assert.equal(guard.sitesAsk("ses_code"), false);
    assert.equal(guard.sitesAsk("ses_unknown"), false);
    // A later request without a folder never turns a Work chat back.
    guard.noteSession({ sessionId: "ses_work" });
    assert.equal(guard.sitesAsk("ses_work"), true);

    saveBlock(dir, { enabled: true, enterprise: { status: "active", org: { id: "org_1", name: "Acme Freight" } } });
    assert.equal(guard.sitesAsk("ses_code"), true);
    assert.equal(guard.sitesAsk("ses_unknown"), true);
    assert.deepEqual(guard.company(), { id: "org_1", name: "Acme Freight" });
  } finally {
    cleanup();
  }
});
