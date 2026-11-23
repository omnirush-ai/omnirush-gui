import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { clearBrowsingData, clearConfirmOptions, createBrowserAccountGuard, signOutWithBrowserGuard } from "./browser-account-guard.mjs";

/** A browser session with a cookie jar, site storage and a cache, like Electron's. */
function fakeSession(cookies = []) {
  const jar = cookies.map((cookie) => ({ path: "/", secure: true, ...cookie }));
  const calls = [];
  return {
    jar,
    calls,
    storage: { local: 3, indexedDb: 2 },
    async clearStorageData(options) {
      calls.push(["clearStorageData", options ?? null]);
      // Chromium clears cookies here too; one written meanwhile survives the pass.
      jar.splice(0, jar.length, ...jar.filter((cookie) => cookie.late));
      this.storage = { local: 0, indexedDb: 0 };
    },
    async clearCache() { calls.push(["clearCache"]); },
    async clearAuthCache() { calls.push(["clearAuthCache"]); },
    cookies: {
      async get() { return jar.map((cookie) => ({ ...cookie })); },
      async remove(url, name) {
        calls.push(["remove", url, name]);
        const at = jar.findIndex((cookie) => cookie.name === name && url.includes(cookie.domain.replace(/^\./, "")));
        if (at >= 0) jar.splice(at, 1);
      },
      async flushStore() { calls.push(["flushStore"]); },
    },
  };
}

/**
 * @param {{ account?: string | null, company?: { id: string | null, name: string | null } | null, choice?: "clear" | "keep",
 *   cookies?: Array<{ domain: string, name: string }> }} [options]
 */
function rig({ account = "acc_a", company = { id: "org_1", name: "Acme Freight" }, choice = "clear", cookies = undefined } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "browser-account-guard-"));
  const ownerPath = path.join(dir, "browser-owner.json");
  const session = fakeSession(cookies ?? [
    { domain: ".tms.acme.example", name: "sid" },
    { domain: "app.crm.example", name: "auth" },
    { domain: ".okta.example", name: "okta_session" },
  ]);
  /** @type {{ account: string | null, company: { id: string | null, name: string | null } | null, choice: "clear" | "keep", asked: unknown[], cleared: number }} */
  const state = { account, company, choice, asked: [], cleared: 0 };
  const guard = createBrowserAccountGuard({
    ownerPath,
    accountId: async () => state.account,
    company: () => state.company,
    confirm: async (request) => { state.asked.push(request); return state.choice; },
    clearBrowser: async () => { state.cleared += 1; return { cookies: await clearBrowsingData(session) }; },
    now: () => 1_700_000_000_000,
  });
  const owner = () => (existsSync(ownerPath) ? JSON.parse(readFileSync(ownerPath, "utf8")) : null);
  return { guard, session, state, owner, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("clearing the browser leaves no cookies, no site storage and an empty cache", async () => {
  const session = fakeSession([
    { domain: ".tms.acme.example", name: "sid" },
    { domain: "app.crm.example", name: "auth", secure: false },
    { domain: ".late.example", name: "written_while_clearing", late: true },
  ]);
  assert.equal(await clearBrowsingData(session), 0);
  assert.equal(session.jar.length, 0);
  assert.deepEqual(session.storage, { local: 0, indexedDb: 0 });
  assert.deepEqual(session.calls.map(([name]) => name), ["clearStorageData", "clearCache", "clearAuthCache", "remove", "flushStore"]);
  // Every kind of storage, not a chosen list.
  assert.equal(session.calls[0][1], null);
  assert.deepEqual(session.calls[3].slice(1), ["https://late.example/", "written_while_clearing"]);
});

test("signing out of a company account asks, and Clear leaves 0 cookies", async () => {
  const { guard, session, state, owner, cleanup } = rig();
  try {
    const result = await guard.beforeSignOut({ language: "en" });
    assert.deepEqual(result, { asked: true, cleared: true, cookies: 0 });
    assert.equal(session.jar.length, 0);
    assert.deepEqual(state.asked, [{ reason: "sign_out", company: "Acme Freight", language: "en" }]);
    assert.equal(owner(), null);
  } finally {
    cleanup();
  }
});

test("Keep browser sign-ins leaves everything, and the next account to sign in is asked", async () => {
  const { guard, session, state, owner, cleanup } = rig({ choice: "keep" });
  try {
    assert.deepEqual(await guard.beforeSignOut(), { asked: true, cleared: false });
    assert.equal(session.jar.length, 3);
    assert.equal(state.cleared, 0);
    assert.deepEqual(owner(), { accountId: "acc_a", company: { id: "org_1", name: "Acme Freight" }, at: 1_700_000_000_000 });

    // The same person signs back in: nothing to ask.
    assert.deepEqual(await guard.afterSignIn(), { asked: false, cleared: false });
    assert.equal(state.asked.length, 1);

    // Someone else signs in: asked, with the company named.
    state.account = "acc_b";
    state.company = null;
    state.choice = "clear";
    const switched = await guard.afterSignIn({ language: "zh" });
    assert.deepEqual(switched, { asked: true, cleared: true, cookies: 0 });
    assert.deepEqual(state.asked.at(-1), { reason: "switch", company: "Acme Freight", language: "zh" });
    assert.equal(session.jar.length, 0);
    assert.equal(owner(), null);
  } finally {
    cleanup();
  }
});

test("a consumer account signs out with no question and nothing cleared", async () => {
  const { guard, session, state, cleanup } = rig({ company: null });
  try {
    assert.deepEqual(await guard.beforeSignOut(), { asked: false, cleared: false });
    assert.deepEqual(await guard.afterSignIn(), { asked: false, cleared: false });
    await guard.noteAccount();
    assert.equal(state.asked.length, 0);
    assert.equal(session.jar.length, 3);
  } finally {
    cleanup();
  }
});

test("a company account that ended without a sign-out in the app is still noticed when another account signs in", async () => {
  const { guard, session, state, owner, cleanup } = rig();
  try {
    await guard.noteAccount();
    assert.equal(owner().accountId, "acc_a");
    // The server revoked the session; a different account signs in.
    state.account = "acc_b";
    state.company = null;
    await guard.noteAccount();
    assert.equal(owner().accountId, "acc_a", "another account's record stays until the question");
    state.choice = "keep";
    assert.deepEqual(await guard.afterSignIn(), { asked: true, cleared: false });
    assert.equal(session.jar.length, 3);
    // Kept for this account: not asked again.
    assert.equal(owner(), null);
    assert.deepEqual(await guard.afterSignIn(), { asked: false, cleared: false });
    assert.equal(state.asked.length, 1);
  } finally {
    cleanup();
  }
});

test("a failed clear keeps the record, so the next account is asked again", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "browser-account-guard-"));
  try {
    let account = "acc_a";
    const guard = createBrowserAccountGuard({
      ownerPath: path.join(dir, "browser-owner.json"),
      accountId: async () => account,
      company: () => ({ id: "org_1", name: "Acme Freight" }),
      confirm: async () => "clear",
      clearBrowser: async () => { throw new Error("session unavailable"); },
    });
    await assert.rejects(guard.beforeSignOut(), /session unavailable/);
    assert.equal((await guard.owner()).accountId, "acc_a");
    account = "acc_b";
    await assert.rejects(guard.afterSignIn(), /session unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one question at a time", async () => {
  const { guard, state, cleanup } = rig();
  try {
    const [first, second] = await Promise.all([guard.beforeSignOut(), guard.beforeSignOut()]);
    assert.equal(first.cleared, true);
    // The second sign-out found the browser already cleared but still a company account: asked once more, harmless.
    assert.equal(second.asked, true);
    assert.equal(state.asked.length, 2);
  } finally {
    cleanup();
  }
});

test("the confirm: Clear first and default (Escape too), then Keep; English and Chinese", () => {
  const en = clearConfirmOptions("sign_out", { company: "Acme Freight", language: "en" });
  assert.deepEqual(en.buttons, ["Clear and sign out", "Keep browser sign-ins"]);
  assert.equal(en.defaultId, 0);
  assert.equal(en.cancelId, 0);
  assert.equal(en.message, "Clear Acme Freight's sign-ins from this computer?");
  assert.match(en.detail, /Keep them only on a computer that is yours\./);
  const switched = clearConfirmOptions("switch", { company: null, language: "en" });
  assert.equal(switched.message, "The browser still has your company's sign-ins.");
  assert.deepEqual(switched.buttons, ["Clear browser", "Keep browser sign-ins"]);
  const zh = clearConfirmOptions("sign_out", { company: "Acme Freight", language: "zh" });
  assert.deepEqual(zh.buttons, ["清除并退出", "保留浏览器登录信息"]);
  assert.equal(zh.message, "要从这台电脑清除 Acme Freight 的登录信息吗？");
  assert.equal(clearConfirmOptions("switch", { language: "zh" }).message, "浏览器中仍有公司的登录信息。");
  assert.equal(clearConfirmOptions("switch", { language: "zh-CN" }).buttons[1], "保留浏览器登录信息");
  assert.equal(clearConfirmOptions("switch", { language: "fr" }).buttons[1], "Keep browser sign-ins");
  // Plain copy: no em or en dashes.
  for (const options of [en, switched, zh]) assert.doesNotMatch(JSON.stringify(options), /[–—]/);
});

test("a cleared browser is announced before the account signs out, even when signing out then fails", async () => {
  const { guard, state, cleanup } = rig();
  try {
    /** @type {string[]} */
    const steps = [];
    await assert.rejects(signOutWithBrowserGuard({
      beforeSignOut: () => guard.beforeSignOut(),
      notify: (cleared) => steps.push(`notify:${cleared}`),
      signOut: async () => {
        steps.push("sign out");
        throw new Error("account store could not be cleared");
      },
    }), /could not be cleared/);
    assert.equal(state.cleared, 1);
    // The window heard "cleared" first, so its restore list and saved tabs went even though signing out failed.
    assert.deepEqual(steps, ["notify:true", "sign out", "notify:false"]);
  } finally {
    cleanup();
  }
});

test("a kept or personal browser is not announced as cleared; the window still hears the sign-out", async () => {
  for (const options of [{ choice: /** @type {const} */ ("keep") }, { company: null }]) {
    const { guard, cleanup } = rig(options);
    try {
      /** @type {boolean[]} */
      const heard = [];
      const result = await signOutWithBrowserGuard({ beforeSignOut: () => guard.beforeSignOut(), notify: (cleared) => heard.push(cleared), signOut: async () => "signed out" });
      assert.equal(result, "signed out");
      assert.deepEqual(heard, [false]);
    } finally {
      cleanup();
    }
  }
});

test("a guard that fails to answer still signs out (not cleared)", async () => {
  /** @type {boolean[]} */
  const heard = [];
  const result = await signOutWithBrowserGuard({ beforeSignOut: async () => { throw new Error("dialog gone"); }, notify: (cleared) => heard.push(cleared), signOut: async () => 7 });
  assert.equal(result, 7);
  assert.deepEqual(heard, [false]);
});
