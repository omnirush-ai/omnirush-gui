// Sign-ins the built-in browser cannot finish, and the way out of each, so a Work tab is never a dead end:
// Google's "this browser may not be secure" page, Microsoft sign-ins that need a managed device, passkeys that never
// answer, and sites that ask for a user name and password (HTTP Basic or NTLM). Pure rules and a small per-tab
// watcher; browser-panel.mjs wires them to tabs. Everything stays on this computer: the page check reads a yes or no
// in a world of our own, and nothing about the page or the sign-in is sent anywhere.

/** The content preload installs the passkey guard only in tabs created with this argument (Work accounts). */
export const PASSKEY_GUARD_ARG = "--omnirush-passkey-guard";
/** A passkey request that has not answered by then is aborted, and the tab shows the way out. */
export const PASSKEY_TIMEOUT_MS = 30_000;
/** The isolated world the sign-in page check runs in (Ask uses 1031). */
export const SIGN_IN_CHECK_WORLD_ID = 1032;

const GOOGLE_ACCOUNTS = "accounts.google.com";
const MICROSOFT_LOGIN = new Set(["login.microsoftonline.com", "login.microsoft.com", "login.windows.net"]);
// Microsoft Entra conditional access: the device must be compliant (53000) or joined to the company (53001). Only Edge
// (or Chrome with Microsoft's extension) can prove that; this app cannot.
const MICROSOFT_DEVICE_CODES = new Set(["53000", "53001"]);
// Hosts that only sign people in. A blocked sign-in hands off the app the person was going to, never these.
const SIGN_IN_HOSTS = [GOOGLE_ACCOUNTS, ...MICROSOFT_LOGIN, "login.live.com", "okta.com", "oktapreview.com", "okta-emea.com", "onelogin.com", "duosecurity.com"];

/** @typedef {"google" | "microsoft_device" | "passkey" | "site_auth"} BlockedSignInKind */
/** @typedef {{ kind: BlockedSignInKind, url: string, host: string | null, browser: { id: string | null, name: string | null } }} BlockedSignIn */

function parse(url) {
  try {
    const parsed = new URL(String(url ?? ""));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
}

function hostOf(url) {
  return parse(url)?.hostname.toLowerCase() ?? "";
}

export function isSignInHost(host) {
  const name = String(host ?? "").toLowerCase();
  return SIGN_IN_HOSTS.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/** The address the person was going to, without www. ("tms.acme.com"); null for a sign-in host or no address. */
export function appHost(url) {
  const host = hostOf(url).replace(/^www\./, "");
  return host && !isSignInHost(host) ? host : null;
}

/**
 * A blocked sign-in the address alone shows: Google's rejected page, or a Microsoft device error handed back to the
 * app in the address (`error_description=AADSTS53000...`).
 * @returns {BlockedSignInKind | null}
 */
export function blockedSignInFromUrl(url) {
  const parsed = parse(url);
  if (!parsed) return null;
  if (parsed.hostname.toLowerCase() === GOOGLE_ACCOUNTS && /^\/(?:v3\/)?signin\/rejected(?:\/|$)/.test(parsed.pathname)) return "google";
  // Entra hands the error back to the app's address (query or fragment) when it cannot show its own page.
  for (const params of [parsed.searchParams, new URLSearchParams(parsed.hash.replace(/^#/, ""))]) {
    if (/AADSTS5300[01]\b/i.test(params.get("error_description") ?? "") || /\b5300[01]\b/.test(params.get("error_codes") ?? "")) return "microsoft_device";
  }
  return null;
}

/** Whether the page itself needs a look (its address does not say): Google's and Microsoft's sign-in pages only. */
export function needsPageCheck(url) {
  const host = hostOf(url);
  return host === GOOGLE_ACCOUNTS || MICROSOFT_LOGIN.has(host);
}

/**
 * Runs in the page's isolated world and answers yes or no, never the page's text: Google's "may not be secure" notice,
 * and the Microsoft error code on the page.
 */
export const SIGN_IN_PAGE_CHECK = `(() => {
  const text = String(document.body ? document.body.innerText : "").slice(0, 20000);
  const match = text.match(/(?:AADSTS|Error Code:?\\s*)(5300[01])\\b/i);
  return { insecure: /This browser or app may not be secure/i.test(text), code: match ? match[1] : null };
})()`;

/** @returns {BlockedSignInKind | null} */
export function blockedSignInFromPage(url, page) {
  const host = hostOf(url);
  if (!page || typeof page !== "object") return null;
  if (host === GOOGLE_ACCOUNTS && page.insecure === true) return "google";
  if (MICROSOFT_LOGIN.has(host) && typeof page.code === "string" && MICROSOFT_DEVICE_CODES.has(page.code)) return "microsoft_device";
  return null;
}

/**
 * Where "Open in <browser>" goes: the app the person was signing in to (Google's `continue`, else the last page in the
 * tab that was not a sign-in page), else the page itself. Passkeys and site sign-ins hand off the page they are on.
 */
export function handOffUrl(kind, currentUrl, lastAppUrl) {
  if (kind === "google") {
    const next = parse(parse(currentUrl)?.searchParams.get("continue") ?? "");
    if (next?.protocol === "https:" && !isSignInHost(next.hostname)) return next.href;
  }
  if ((kind === "google" || kind === "microsoft_device") && parse(lastAppUrl)) return String(lastAppUrl);
  return parse(currentUrl) ? String(currentUrl) : null;
}

/**
 * The browser the bar names: Microsoft Edge for a Microsoft device rule when it is installed (only it can prove the
 * device), else the person's default browser by name (null: "your browser").
 */
export function handOffBrowser(kind, installed, defaultName) {
  if (kind === "microsoft_device") {
    const edge = (installed ?? []).find((browser) => browser?.id === "edge");
    if (edge) return { id: "edge", name: String(edge.name || "Microsoft Edge") };
  }
  const name = typeof defaultName === "string" ? defaultName.trim().replace(/\.app$/i, "") : "";
  return { id: null, name: name && name.length <= 40 && !/omnirush/i.test(name) ? name : null };
}

/** The bar's state for a tab, or null when there is nowhere to hand off to. */
export function blockedSignIn(kind, currentUrl, lastAppUrl, browser) {
  const url = handOffUrl(kind, currentUrl, lastAppUrl);
  if (!url) return null;
  return { kind, url, host: appHost(url), browser: { id: browser?.id ?? null, name: browser?.name ?? null } };
}

/** A site's sign-in request as the sheet shows it: the host asking, its own words (short), the scheme. */
export function siteAuthRequest(id, tabId, details, authInfo) {
  const realm = typeof authInfo?.realm === "string" ? authInfo.realm.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) : "";
  const parsed = parse(details?.url);
  return {
    id,
    tabId,
    host: String(authInfo?.host || parsed?.hostname || "").slice(0, 253),
    realm,
    scheme: String(authInfo?.scheme || "basic").toLowerCase().slice(0, 20),
    url: parsed ? parsed.href : null,
  };
}

/** What the sheet sent back: a user name and password to give the site, or null to cancel. */
export function siteAuthAnswer(answer) {
  if (!answer || typeof answer !== "object") return null;
  const { username, password } = answer;
  if (typeof username !== "string" || typeof password !== "string") return null;
  if (!username || username.length > 256 || password.length > 1024) return null;
  return { username, password };
}

/**
 * Watches a tab for a blocked sign-in. `isOn()`: Work accounts only, so everyone else's browser is unchanged.
 * `chooseBrowser(kind)` resolves the browser to name; `publish()` sends the tab state.
 */
export function watchSignIns(tab, { isOn, chooseBrowser, publish, checkPage }) {
  const contents = tab.view.webContents;
  // `exact`: the page must still be the one that was checked. A site's sign-in request comes before its page commits,
  // so it names its own address instead.
  const mark = async (kind, url, exact = true) => {
    let browser = { id: null, name: null };
    try { browser = await chooseBrowser(kind); } catch { /* name it "your browser" */ }
    if (contents.isDestroyed?.() || (exact && contents.getURL() !== url)) return;
    const next = blockedSignIn(kind, url, tab.lastAppUrl ?? null, browser);
    if (!next) return;
    tab.blockedSignIn = next;
    publish();
  };
  const clear = () => {
    if (!tab.blockedSignIn) return;
    tab.blockedSignIn = null;
    publish();
  };
  contents.on("did-navigate", (_event, url) => {
    if (appHost(url) && !blockedSignInFromUrl(url)) tab.lastAppUrl = String(url);
    if (!isOn()) return;
    const kind = blockedSignInFromUrl(url);
    if (kind) void mark(kind, String(url));
    // A site's sign-in bar stays on that site's own pages (its 401 page commits after the request is cancelled).
    else if (tab.blockedSignIn && (tab.blockedSignIn.kind !== "site_auth" || appHost(url) !== tab.blockedSignIn.host)) clear();
  });
  contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    // A passkey bar belongs to the page that asked; leaving it takes the bar away.
    if (isMainFrame && !isInPlace && tab.blockedSignIn?.kind === "passkey") clear();
  });
  contents.on("did-stop-loading", () => {
    const url = contents.getURL();
    if (!isOn() || !needsPageCheck(url) || tab.blockedSignIn) return;
    void Promise.resolve()
      .then(() => checkPage(contents))
      .then((page) => {
        const kind = blockedSignInFromPage(url, page);
        if (kind) return mark(kind, url);
      })
      .catch(() => undefined);
  });
  return {
    passkeyTimedOut() {
      if (!isOn()) return;
      void mark("passkey", contents.getURL());
    },
    siteAuthBlocked(url) {
      if (!isOn()) return;
      void mark("site_auth", String(url || contents.getURL()), false);
    },
    clear,
  };
}
