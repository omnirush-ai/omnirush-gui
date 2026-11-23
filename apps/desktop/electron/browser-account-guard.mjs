// Company sign-ins stay with the company account. The built-in browser keeps
// one set of sign-ins per computer (persist:omnirush-browser), and #432 can
// copy sign-ins from the user's other browsers into it. When someone signs out
// of a company account, or another account signs in after one, the app asks
// first and then clears the browser: sign-ins and site data, the cache, open
// and restored tabs, and site permissions. "Keep browser sign-ins" leaves
// everything, for a computer that is the user's own.
//
// <userData>/browser-owner.json remembers the company account whose sign-ins
// the browser holds ({ accountId, company: { id, name } }), so a sign-in under
// another account is noticed even when the first one ended without a sign-out
// in the app (a session the server revoked). Ids and the company name only.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const COPY = {
  en: {
    signOut: {
      title: "Sign out",
      message: (company) => `Clear ${company ?? "your company"}'s sign-ins from this computer?`,
      detail: "Signing out clears your sign-ins in the OmniRush browser, its open tabs and site permissions. Keep them only on a computer that is yours.",
      clear: "Clear and sign out",
    },
    switch: {
      title: "Browser sign-ins",
      message: (company) => `The browser still has ${company ?? "your company"}'s sign-ins.`,
      detail: "Clear them, with the open tabs and site permissions, before you continue with this account. Keep them only on a computer that is yours.",
      clear: "Clear browser",
    },
    keep: "Keep browser sign-ins",
  },
  zh: {
    signOut: {
      title: "退出登录",
      message: (company) => `要从这台电脑清除${company ? ` ${company} ` : "公司"}的登录信息吗？`,
      detail: "退出登录会清除 OmniRush 浏览器中的登录信息、打开的标签页和网站权限。只有在你自己的电脑上才建议保留。",
      clear: "清除并退出",
    },
    switch: {
      title: "浏览器登录信息",
      message: (company) => `浏览器中仍有${company ? ` ${company} ` : "公司"}的登录信息。`,
      detail: "继续使用这个账户前，请清除这些登录信息以及打开的标签页和网站权限。只有在你自己的电脑上才建议保留。",
      clear: "清除浏览器",
    },
    keep: "保留浏览器登录信息",
  },
};

/**
 * The native confirm's options: the clear button first (the default, and what
 * Escape picks), then Keep.
 * @param {"sign_out" | "switch"} reason
 * @param {{ company?: string | null, language?: string | null }} [options]
 */
export function clearConfirmOptions(reason, { company = null, language = null } = {}) {
  const copy = String(language ?? "").toLowerCase().startsWith("zh") ? COPY.zh : COPY.en;
  const text = reason === "switch" ? copy.switch : copy.signOut;
  return {
    type: /** @type {"question"} */ ("question"),
    title: text.title,
    message: text.message(company),
    detail: text.detail,
    buttons: [text.clear, copy.keep],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/**
 * Clear one Electron session: cookies and every kind of site storage, the HTTP
 * cache and remembered site passwords for HTTP sign-in. Resolves to the number
 * of cookies left (0 unless a removal failed).
 * @param {{
 *   clearStorageData: (options?: object) => Promise<void>,
 *   clearCache: () => Promise<void>,
 *   clearAuthCache?: () => Promise<void>,
 *   cookies: { get: (filter: object) => Promise<Array<{ domain?: string, path?: string, name: string, secure?: boolean }>>, remove: (url: string, name: string) => Promise<void>, flushStore?: () => Promise<void> },
 * }} browserSession
 */
export async function clearBrowsingData(browserSession) {
  await browserSession.clearStorageData();
  await browserSession.clearCache();
  await browserSession.clearAuthCache?.();
  // A cookie written while storage was cleared: removed one by one.
  for (const cookie of await browserSession.cookies.get({})) {
    const host = String(cookie.domain ?? "").replace(/^\./, "");
    await browserSession.cookies.remove(`${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`, cookie.name).catch(() => undefined);
  }
  await browserSession.cookies.flushStore?.();
  return (await browserSession.cookies.get({})).length;
}

/**
 * @param {{
 *   ownerPath: string,
 *   accountId: () => Promise<string | null>,
 *   company: () => { id: string | null, name: string | null } | null,
 *   confirm: (request: { reason: "sign_out" | "switch", company: string | null, language: string | null }) => Promise<"clear" | "keep">,
 *   clearBrowser: () => Promise<{ cookies: number }>,
 *   now?: () => number,
 * }} options
 */
export function createBrowserAccountGuard({ ownerPath, accountId, company, confirm, clearBrowser, now = Date.now }) {
  let deciding = null;

  async function readOwner() {
    try {
      const saved = JSON.parse(await readFile(ownerPath, "utf8"));
      if (!isRecord(saved) || typeof saved.accountId !== "string" || !saved.accountId) return null;
      const org = isRecord(saved.company) ? saved.company : {};
      return {
        accountId: saved.accountId,
        company: { id: typeof org.id === "string" ? org.id : null, name: typeof org.name === "string" && org.name ? org.name : null },
      };
    } catch {
      return null;
    }
  }

  async function writeOwner(owner) {
    if (!owner) {
      await rm(ownerPath, { force: true });
      return;
    }
    await mkdir(path.dirname(ownerPath), { recursive: true });
    const temp = `${ownerPath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ ...owner, at: now() }), { mode: 0o600 });
    await rename(temp, ownerPath);
  }

  /** One question at a time: a second caller waits for the first answer. */
  function once(work) {
    const run = (deciding ?? Promise.resolve()).then(work);
    const settled = run.then(() => undefined, () => undefined);
    deciding = settled;
    void settled.then(() => { if (deciding === settled) deciding = null; });
    return run;
  }

  async function decide(reason, owner, language) {
    const choice = await confirm({ reason, company: owner.company?.name ?? null, language: language ?? null });
    if (choice === "keep") return { asked: true, cleared: false };
    let cookies;
    try {
      ({ cookies } = await clearBrowser());
    } catch (error) {
      // Not cleared: the next account to sign in is asked again.
      if (owner.accountId) await writeOwner(owner).catch(() => undefined);
      throw error;
    }
    await writeOwner(null);
    return { asked: true, cleared: true, cookies };
  }

  /**
   * Remember the signed-in company account as the browser's owner. Asks
   * nothing; another account's record stays until afterSignIn decides.
   */
  async function noteAccount() {
    const org = company();
    if (!org) return;
    const id = await accountId().catch(() => null);
    if (!id) return;
    const owner = await readOwner();
    if (owner && owner.accountId !== id) return;
    if (owner && owner.company.id === org.id && owner.company.name === org.name) return;
    await writeOwner({ accountId: id, company: org });
  }

  /**
   * Before the app signs out: a company account asks to clear the browser or
   * keep it. Keep remembers the owner, so the next account to sign in is asked.
   * @param {{ language?: string | null }} [options]
   */
  function beforeSignOut({ language = null } = {}) {
    return once(async () => {
      const id = await accountId().catch(() => null);
      const owner = await readOwner();
      const org = company();
      const current = org ? { accountId: id ?? owner?.accountId ?? null, company: org } : owner && id && owner.accountId === id ? owner : null;
      if (!current) return { asked: false, cleared: false };
      const result = await decide("sign_out", current, language);
      if (!result.cleared && current.accountId) await writeOwner(current);
      return result;
    });
  }

  /**
   * After an account signs in: when the browser holds another account's
   * company sign-ins, ask to clear them or keep them for this account.
   * @param {{ language?: string | null }} [options]
   */
  function afterSignIn({ language = null } = {}) {
    return once(async () => {
      const owner = await readOwner();
      if (!owner) return { asked: false, cleared: false };
      const id = await accountId().catch(() => null);
      if (!id || id === owner.accountId) return { asked: false, cleared: false };
      const result = await decide("switch", owner, language);
      // Kept: the sign-ins now go with this account (noteAccount records it once it shows as a company account).
      if (!result.cleared) await writeOwner(null);
      return result;
    });
  }

  return { noteAccount, beforeSignOut, afterSignIn, owner: readOwner };
}
