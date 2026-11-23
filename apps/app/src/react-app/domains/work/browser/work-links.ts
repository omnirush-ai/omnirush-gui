// Where a Work link opens. "Open" on Today, Search, Deals and Knowledge, and a record's Open, go to a tab in the Work
// side panel (Expand moves it to the Work browser). These stay in the person's own browser: connect, reconnect and
// sign-in (OAuth) pages, the portal and onboarding (their pages pass the system opener, never this one), Cmd or Ctrl
// click, meeting links (calls are not ready here yet), sites the person set to always open elsewhere, and every link
// when "Open links from Work in" is set to their browser or the company set it so. Everything here is kept on this
// computer; nothing about links or sites is sent anywhere.

/** How a Work page asks for a link: `external` is a Cmd or Ctrl click (the system browser, always). */
export type OpenWorkLinkOptions = { external?: boolean };
export type OpenWorkLink = (url: string, options?: OpenWorkLinkOptions) => void;

/** Meeting hosts open in the person's browser until calls (camera, microphone, screen share) work here. */
export const MEETING_HOSTS = ["meet.google.com", "zoom.us", "teams.microsoft.com", "teams.live.com", "webex.com"] as const;

/**
 * Google-hosted links open beside Work while Google's direct sign-in works in this browser. If the release check on
 * real machines finds it refused, this turns false and they open in the person's browser instead.
 */
export const GOOGLE_LINKS_IN_APP = true;
const GOOGLE_HOSTS = ["google.com"];

export type ElsewhereHost = { host: string; browserId: string | null; browserName: string | null };

export type WorkLinkTarget = { kind: "panel" } | { kind: "system" } | { kind: "elsewhere"; browserId: string };

export type WorkLinkPolicy = {
  /** The company's default for where Work links open (true: in OmniRush). */
  inApp: boolean;
  /** People cannot change it. */
  locked: boolean;
  /** Who set it, for "Set by <company>". */
  orgName: string | null;
};

export const DEFAULT_LINK_POLICY: WorkLinkPolicy = { inApp: true, locked: false, orgName: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The company's link setting from the Work state's `browser` block (the `work.browser` capability: `links_in_app`,
 * `links_locked`, `org_name`). Work off, no block or an older server: the defaults (in OmniRush, the person chooses).
 */
export function workLinkPolicy(state: unknown): WorkLinkPolicy {
  if (!isRecord(state) || state.enabled !== true || !isRecord(state.browser)) return DEFAULT_LINK_POLICY;
  const block = state.browser;
  const orgName = typeof block.org_name === "string" && block.org_name.trim() ? block.org_name.trim().slice(0, 200) : null;
  return { inApp: block.links_in_app !== false, locked: block.links_locked === true, orgName };
}

/** Where Work links open: the company's choice when it locked it, else the person's own, else the company's default. */
export function linksInApp(policy: WorkLinkPolicy, choice: boolean | null): boolean {
  return policy.locked || choice === null ? policy.inApp : choice;
}

/** The host of a web address, lower case and without www. (null for anything that is not http or https). */
export function linkHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

const under = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

export function isMeetingHost(host: string): boolean {
  return MEETING_HOSTS.some((suffix) => under(host, suffix));
}

/** Where one Work link goes. */
export function workLinkTarget(url: string, context: { inApp: boolean; external?: boolean; elsewhere: readonly ElsewhereHost[]; googleInApp?: boolean }): WorkLinkTarget {
  const host = linkHost(url);
  if (!host || context.external) return { kind: "system" };
  const pinned = context.elsewhere.find((entry) => entry.host === host);
  if (pinned) return pinned.browserId ? { kind: "elsewhere", browserId: pinned.browserId } : { kind: "system" };
  if (isMeetingHost(host) || !context.inApp) return { kind: "system" };
  if (!(context.googleInApp ?? GOOGLE_LINKS_IN_APP) && GOOGLE_HOSTS.some((suffix) => under(host, suffix))) return { kind: "system" };
  return { kind: "panel" };
}

// ---------------------------------------------------------------- the person's choices, kept on this computer

/** "Open links from Work in": "app" (OmniRush) or "system" (their browser); absent until they choose. */
export const WORK_LINKS_CHOICE_KEY = "omnirush:work-browser:links:v1";
/** Sites set to "Always open <host> there" from the blocked sign-in bar. */
export const WORK_LINKS_ELSEWHERE_KEY = "omnirush:work-browser:elsewhere:v1";
const ELSEWHERE_LIMIT = 200;
/** Sent on this window when either changes (other windows get the storage event). */
export const WORK_LINKS_CHANGED_EVENT = "omnirush:work-links-changed";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function changed() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(WORK_LINKS_CHANGED_EVENT));
}

export function readLinksChoice(store: Store | null = storage()): boolean | null {
  try {
    const value = store?.getItem(WORK_LINKS_CHOICE_KEY);
    return value === "app" ? true : value === "system" ? false : null;
  } catch {
    return null;
  }
}

export function writeLinksChoice(inApp: boolean, store: Store | null = storage()) {
  try {
    store?.setItem(WORK_LINKS_CHOICE_KEY, inApp ? "app" : "system");
  } catch {
    // Storage unavailable: the company's default stays.
  }
  changed();
}

export function readElsewhereHosts(store: Store | null = storage()): ElsewhereHost[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(WORK_LINKS_ELSEWHERE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: ElsewhereHost[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry) || typeof entry.host !== "string") continue;
      const host = entry.host.toLowerCase().replace(/^www\./, "").slice(0, 253);
      if (!host || seen.has(host) || !/^[a-z0-9.-]+$/.test(host)) continue;
      seen.add(host);
      out.push({
        host,
        browserId: typeof entry.browserId === "string" && /^[a-z]{2,16}$/.test(entry.browserId) ? entry.browserId : null,
        browserName: typeof entry.browserName === "string" ? entry.browserName.slice(0, 40) : null,
      });
      if (out.length === ELSEWHERE_LIMIT) break;
    }
    return out;
  } catch {
    return [];
  }
}

function writeElsewhere(hosts: ElsewhereHost[], store: Store | null) {
  try {
    if (hosts.length === 0) store?.removeItem(WORK_LINKS_ELSEWHERE_KEY);
    else store?.setItem(WORK_LINKS_ELSEWHERE_KEY, JSON.stringify(hosts.slice(0, ELSEWHERE_LIMIT)));
  } catch {
    // Storage full or unavailable: the site keeps opening here.
  }
  changed();
}

/** "Always open <host> there": newest first, one entry per host. */
export function addElsewhereHost(entry: ElsewhereHost, store: Store | null = storage()) {
  const host = entry.host.toLowerCase().replace(/^www\./, "");
  writeElsewhere([{ ...entry, host }, ...readElsewhereHosts(store).filter((item) => item.host !== host)], store);
}

export function removeElsewhereHost(host: string, store: Store | null = storage()) {
  writeElsewhere(readElsewhereHosts(store).filter((item) => item.host !== host), store);
}

