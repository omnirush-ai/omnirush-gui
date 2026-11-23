/** @jsxImportSource react */
// Enterprise mode's UI pieces: the whole window while a company account's company is not active yet (pending review),
// was not approved, or is paused (no Work, no Code, only what is happening, the admin portal and Sign out); and the
// wrapper that keeps consumer-only surfaces (rewards, events, placements) away from company accounts.
import { ArrowUpRight, LogOut, RotateCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";

import { useEnterpriseFlags, type EnterpriseMode } from "./enterprise-mode";

/** Renders its children for everyone but a company account. */
export function ConsumerOnly(props: { children: ReactNode }) {
  return useEnterpriseFlags().on ? null : <>{props.children}</>;
}

export function enterpriseWaitingCopy(mode: Pick<EnterpriseMode, "status" | "orgName">, email: string | null): { title: string; body: string } {
  const name = mode.orgName?.trim() || t("work.setup.your_company");
  if (mode.status === "denied") return { title: t("work.ent.denied_title", { name }), body: t("work.ent.denied_body") };
  if (mode.status === "suspended") return { title: t("work.ent.suspended_title", { name }), body: t("work.ent.suspended_body") };
  if (!mode.orgName) return { title: t("work.ent.no_company_title"), body: t("work.ent.no_company_body") };
  return { title: t("work.ent.pending_title", { name }), body: email ? t("work.ent.pending_body", { email }) : t("work.ent.pending_body_plain") };
}

export function EnterpriseWaiting(props: {
  mode: EnterpriseMode;
  email: string | null;
  openLink: (url: string) => void;
  onCheckAgain: () => Promise<unknown>;
  onSignOut: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<"check" | "out" | null>(null);
  const copy = enterpriseWaitingCopy(props.mode, props.email);
  const run = async (kind: "check" | "out", action: () => Promise<unknown>) => {
    setBusy(kind);
    try { await action(); } finally { setBusy(null); }
  };
  return (
    <div className="relative flex h-dvh w-full flex-col bg-background text-foreground" data-testid="work-enterprise-waiting" data-status={props.mode.status ?? "none"}>
      <div className="flex h-12 shrink-0 items-center justify-between px-4 mac:ps-20 mac:titlebar-drag">
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <img src={resolveExtensionIconSrc("/omnirush-mark.png")} alt="" className="size-4 dark:invert" />
          {t("work.ent.product")}
        </span>
        <Button variant="ghost" size="sm" className="mac:titlebar-no-drag" disabled={busy !== null} onClick={() => void run("out", props.onSignOut)} data-testid="work-enterprise-sign-out">
          <LogOut className="size-4" />{t("den.sign_out")}
        </Button>
      </div>
      <div className="flex flex-1 items-center justify-center px-6 pb-16">
        <div className="flex w-full max-w-[440px] flex-col gap-5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
          <div className="space-y-2">
            {props.mode.orgName ? (
              <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2.5 text-[12px] text-muted-foreground" data-testid="work-enterprise-status">
                <span aria-hidden className={props.mode.status === "pending" ? "size-1.5 rounded-full bg-amber-9 motion-safe:animate-pulse" : "size-1.5 rounded-full bg-red-9"} />
                {props.mode.status === "denied" ? t("work.ent.status_denied") : props.mode.status === "suspended" ? t("work.ent.status_suspended") : t("work.ent.status_pending")}
              </span>
            ) : null}
            <h1 className="text-balance text-[22px] font-semibold leading-[28px] tracking-[-0.02em]">{copy.title}</h1>
            <p className="text-[13px] leading-5 text-muted-foreground">{copy.body}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {props.mode.portalUrl ? (
              <Button onClick={() => props.openLink(props.mode.portalUrl!)} data-testid="work-enterprise-portal">
                {t("work.ent.open_portal")}<ArrowUpRight className="size-4" />
              </Button>
            ) : null}
            <Button variant="outline" disabled={busy !== null} onClick={() => void run("check", props.onCheckAgain)} data-testid="work-enterprise-check">
              <RotateCw className={busy === "check" ? "size-4 motion-safe:animate-spin" : "size-4"} />{t("work.ent.check_again")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
