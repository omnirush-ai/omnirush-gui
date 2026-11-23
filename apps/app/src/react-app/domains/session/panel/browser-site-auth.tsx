/** @jsxImportSource react */
// A site in one of the person's own tabs asks for a user name and password (HTTP Basic or NTLM, often an intranet).
// Electron has no prompt of its own, so without this sheet the page just fails. The answer goes to that site through
// the browser and is not kept by the app. Agent tabs never get this sheet (the agent stops and the bar offers the
// person's browser). Work accounts only: the desktop app asks only after the app turns these on.
import { LockKeyhole } from "lucide-react";
import * as React from "react";

import type { BrowserSiteAuthRequest } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";

import { useDefaultBrowserName } from "../../work/browser/use-work-links";
import { getElectronBrowser } from "./utils";

/** The requests waiting, oldest first: the sheet shows one at a time. */
export function useSiteAuthRequests(enabled: boolean) {
  const [queue, setQueue] = React.useState<BrowserSiteAuthRequest[]>([]);
  React.useEffect(() => {
    const browser = getElectronBrowser();
    if (!enabled || !browser?.onAuthRequest) return;
    const offRequest = browser.onAuthRequest((request) => {
      if (!request || typeof request.id !== "string") return;
      setQueue((current) => (current.some((entry) => entry.id === request.id) ? current : [...current, request]));
    });
    const offDone = browser.onAuthDone?.((payload) => setQueue((current) => current.filter((entry) => entry.id !== payload?.id)));
    return () => {
      offRequest?.();
      offDone?.();
    };
  }, [enabled]);
  const answer = React.useCallback((id: string, credentials: { username: string; password: string } | null) => {
    setQueue((current) => current.filter((entry) => entry.id !== id));
    void getElectronBrowser()?.authAnswer?.(id, credentials)?.catch(() => undefined);
  }, []);
  return { request: queue[0] ?? null, answer };
}

export function BrowserSiteAuthSheet({ enabled }: { enabled: boolean }) {
  const { request, answer } = useSiteAuthRequests(enabled);
  if (!request) return null;
  return <SiteAuthDialog key={request.id} request={request} onAnswer={answer} />;
}

export function SiteAuthDialog({ request, onAnswer }: { request: BrowserSiteAuthRequest; onAnswer: (id: string, credentials: { username: string; password: string } | null) => void }) {
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const userId = React.useId();
  const passwordId = React.useId();
  const browser = useDefaultBrowserName() ?? t("work_links.your_browser");
  const cancel = () => onAnswer(request.id, null);
  // Some intranets only sign people in on a browser the company set up: the same page there, this request cancelled.
  const elsewhere = () => {
    cancel();
    if (request.url) void getElectronBrowser()?.openElsewhere?.(request.url, null)?.catch(() => undefined);
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim()) return;
    onAnswer(request.id, { username, password });
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) cancel(); }}>
      <DialogContent className="lg:max-w-[440px]" data-testid="browser-site-auth">
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-6">
          <DialogHeader className="min-w-0">
            <div className="mb-1 flex size-9 items-center justify-center rounded-xl bg-muted">
              <LockKeyhole aria-hidden className="size-4 text-muted-foreground" />
            </div>
            <DialogTitle className="truncate text-[15px] leading-6" title={request.host}>{t("work_links.auth_title", { host: request.host })}</DialogTitle>
            <DialogDescription className="text-[13px] leading-5 text-dls-secondary">{t("work_links.auth_body")}</DialogDescription>
            {request.realm ? (
              <p className="truncate text-[13px] leading-5 text-dls-secondary" title={request.realm} data-testid="browser-site-auth-realm">
                {t("work_links.auth_realm", { realm: request.realm })}
              </p>
            ) : null}
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={userId} className="text-[13px] font-medium">{t("work_links.auth_user")}</label>
              <Input id={userId} autoFocus autoComplete="username" spellCheck={false} maxLength={256} value={username} onChange={(event) => setUsername(event.target.value)} data-testid="browser-site-auth-user" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={passwordId} className="text-[13px] font-medium">{t("work_links.auth_password")}</label>
              <Input id={passwordId} type="password" autoComplete="current-password" maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} data-testid="browser-site-auth-password" />
            </div>
          </div>
          <DialogFooter>
            {request.url ? (
              <Button type="button" variant="ghost" className="sm:me-auto" onClick={elsewhere} data-testid="browser-site-auth-elsewhere">
                {t("work_links.open_in", { browser })}
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={cancel} data-testid="browser-site-auth-cancel">{t("work_links.auth_cancel")}</Button>
            <Button type="submit" disabled={!username.trim()} data-testid="browser-site-auth-submit">{t("work_links.auth_submit")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
