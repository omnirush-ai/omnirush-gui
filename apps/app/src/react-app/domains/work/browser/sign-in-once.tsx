/** @jsxImportSource react */
// One row on Browser home: "Sign in once with <Okta, Microsoft or Google>", when the person's imported library shows
// their company signs in there. One sign-in in this browser then opens every app behind it signed in. Worked out on
// this computer from the library (the library never leaves it); dismissed or used, it does not come back.
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { BROWSER_LIBRARY_KEY, getBrowserLibraryBridge, useBrowserLibraryAvailable } from "../../browser-logins/use-browser-library";
import { BrandTile } from "../brand-icon";

export type CompanySignIn = { idp: "okta" | "microsoft" | "google"; name: string; url: string; host: string };

// Okta's own pages, not a company's sign-in page.
const OKTA_SITES = new Set(["www", "login", "help", "developer", "support", "trust", "status", "devforum", "community", "auth"]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The company's sign-in from addresses in the library: its own Okta (acme.okta.com) first, then Microsoft, then Google.
 * Null when none shows.
 */
export function companySignIn(urls: readonly string[]): CompanySignIn | null {
  const hosts = new Set(urls.map(hostOf).filter(Boolean));
  for (const host of hosts) {
    const okta = host.match(/^([a-z0-9-]+)\.(?:okta|oktapreview|okta-emea)\.com$/);
    if (okta && !OKTA_SITES.has(okta[1]!)) return { idp: "okta", name: "Okta", url: `https://${host}/`, host };
  }
  if (hosts.has("login.microsoftonline.com")) return { idp: "microsoft", name: "Microsoft", url: "https://myapps.microsoft.com/", host: "login.microsoftonline.com" };
  if (hosts.has("accounts.google.com")) return { idp: "google", name: "Google", url: "https://accounts.google.com/", host: "accounts.google.com" };
  return null;
}

export const SIGN_IN_ONCE_KEY = "omnirush:work-browser:sign-in-once:v1";

function readDone(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SIGN_IN_ONCE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

function markDone(host: string) {
  try {
    localStorage.setItem(SIGN_IN_ONCE_KEY, JSON.stringify([host, ...readDone().filter((entry) => entry !== host)].slice(0, 20)));
  } catch {
    // Storage unavailable: the row may show again next time.
  }
}

/** Searches the library for the three sign-in hosts (on this computer) and picks the company's. */
export function useCompanySignIn(): CompanySignIn | null {
  const library = useBrowserLibraryAvailable();
  const found = useQuery({
    queryKey: [...BROWSER_LIBRARY_KEY, "sign-in-once"],
    queryFn: async () => {
      const bridge = getBrowserLibraryBridge()!;
      const lists = await Promise.all(["okta.com", "login.microsoftonline.com", "accounts.google.com"].map((query) => bridge.suggest(query).catch(() => [])));
      return companySignIn(lists.flat().map((entry) => entry.url));
    },
    enabled: library,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return found.data ?? null;
}

function OktaMark() {
  return (
    <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background" data-brand-tile="okta">
      <svg viewBox="0 0 24 24" className="size-4"><path fill="#007DC1" d="M12 0C5.389 0 0 5.35 0 12s5.35 12 12 12 12-5.35 12-12S18.611 0 12 0zm0 18c-3.325 0-6-2.675-6-6s2.675-6 6-6 6 2.675 6 6-2.675 6-6 6z" /></svg>
    </span>
  );
}

export function SignInOnceRow(props: { onOpen: (url: string) => void; compact?: boolean }) {
  const found = useCompanySignIn();
  const [done, setDone] = React.useState(readDone);
  if (!found || done.includes(found.host)) return null;
  const finish = () => {
    markDone(found.host);
    setDone(readDone());
  };
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border border-border bg-muted/40", props.compact ? "px-3 py-2.5" : "px-4 py-3")} data-testid="browser-home-sign-in">
      {found.idp === "okta" ? <OktaMark /> : <BrandTile id={found.idp} />}
      <div className="min-w-0 flex-1">
        <p className="text-balance text-[13px] font-medium leading-5 text-foreground">{t("work_links.sign_in_once", { idp: found.name })}</p>
        {props.compact ? null : <p className="text-[13px] leading-5 text-dls-secondary">{t("work_links.sign_in_once_body")}</p>}
      </div>
      <Button variant="outline" size="sm" className="shrink-0 text-[13px]" onClick={() => { finish(); props.onOpen(found.url); }} data-testid="browser-home-sign-in-open">
        {t("work_links.sign_in")}
      </Button>
      <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={t("work_links.dismiss")} title={t("work_links.dismiss")} onClick={finish} data-testid="browser-home-sign-in-dismiss">
        <X />
      </Button>
    </div>
  );
}
