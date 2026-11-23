/** @jsxImportSource react */
// The buildathon promo for accounts that are not enrolled (contract "Promo for
// non-participants"): a slim top banner until dismissed, and a one-time card on
// the home screen. Both come from the server's `promo` block, are keyed by its
// id, and are gone after its end time. The CTA joins in the app when the promo
// allows it, else opens the event page.

import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Loader2, Rocket, X } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

import { omnirushBuildathonJoin, openDesktopUrl } from "../../../app/lib/desktop";
import {
  promoActive,
  readPromoIds,
  rememberPromoId,
  useBuildathonStore,
  type BuildathonPromo,
} from "../../../app/lib/buildathon";
import { BANNER_HEIGHT_PX, bannerShiftStyle } from "../../shell/update-gate";
import posterThumb from "./buildathon-poster-thumb.webp";
import { useEnterpriseFlags } from "../work/enterprise-mode";

/** The event poster's colours (omnirush.ai/buildathon). */
const BLUE = "#3A2DF5";
const LIME = "#D8FC38";
const INK = "#0B0630";

/** The server clock (the promo answer's offset), re-read every `intervalMs`. */
function useServerNow(intervalMs: number): number {
  const offsetMs = useBuildathonStore((store) => store.offsetMs);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now + offsetMs;
}

/** The promo to show now, or null (none, dismissed under its id, or past its end). */
export function useActivePromo(): BuildathonPromo | null {
  const promo = useBuildathonStore((store) => store.promo);
  const seenVersion = useBuildathonStore((store) => store.seenVersion);
  const now = useServerNow(30_000);
  // Events are the consumer app's: a company account (OmniRush Work) never sees the promo.
  const enterprise = useEnterpriseFlags().on;
  // seenVersion: re-read the dismissed ids after a dismissal.
  void seenVersion;
  return !enterprise && promoActive(promo, now, readPromoIds("dismissed")) ? promo : null;
}

export function dismissPromo(id: string): void {
  rememberPromoId("dismissed", id);
  useBuildathonStore.getState().bumpSeen();
}

let joining = false;

/**
 * The CTA. Open joining: the join page in the browser (it links GitHub),
 * then the app re-reads often until the account is enrolled and switches to
 * the participant UI ("You're in"). Without a join page: join in the app.
 * Otherwise: the event page.
 */
export async function runPromoCta(promo: BuildathonPromo, setBusy?: (busy: boolean) => void): Promise<void> {
  if (promo.join && promo.joinUrl) {
    await openDesktopUrl(promo.joinUrl).catch(() => undefined);
    useBuildathonStore.getState().startJoinWatch();
    toast.info("Finish joining in your browser", {
      description: "Link your GitHub account there. The app switches over as soon as you're in.",
      duration: 15_000,
    });
    return;
  }
  if (!promo.join) {
    if (promo.ctaUrl) await openDesktopUrl(promo.ctaUrl).catch(() => undefined);
    return;
  }
  if (joining) return;
  joining = true;
  setBusy?.(true);
  try {
    const result = await omnirushBuildathonJoin().catch(() => ({ ok: false as const, error: "Could not join right now. Try again in a moment." }));
    if (result.ok) {
      // The layer greets the new participant ("You're in") and opens My Buildathon.
      useBuildathonStore.getState().setStatus(result.status);
      return;
    }
    const pageUrl = promo.ctaUrl;
    toast.error(result.error, pageUrl
      ? { action: { label: "Open event page", onClick: () => void openDesktopUrl(pageUrl).catch(() => undefined) } }
      : undefined);
  } finally {
    joining = false;
    setBusy?.(false);
  }
}

function CtaButton(props: { promo: BuildathonPromo; size: "xs" | "sm"; testId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void runPromoCta(props.promo, setBusy)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full font-semibold transition-[filter] hover:brightness-95 disabled:opacity-70 mac:titlebar-no-drag",
        props.size === "xs" ? "h-6 px-2.5 text-[11.5px]" : "h-8 px-3.5 text-[12.5px]",
      )}
      style={{ backgroundColor: LIME, color: INK }}
      data-testid={props.testId}
      data-join={props.promo.join ? "true" : "false"}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
      {busy ? "Joining…" : props.promo.ctaLabel}
      {busy ? null : <ArrowRight className="size-3.5" />}
    </button>
  );
}

/** Whether the app is waiting for a join finished in the browser. */
function useJoinWatching(): boolean {
  const until = useBuildathonStore((store) => store.joinWatchUntil);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= Date.now()) return;
    setNow(Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), until - Date.now() + 50);
    return () => window.clearTimeout(timer);
  }, [until]);
  return until > now;
}

/** The slim top banner (the update banner's place and height, the poster's colours). */
export function BuildathonPromoBanner(props: { promo: BuildathonPromo }) {
  const { promo } = props;
  const watching = useJoinWatching();
  return (
    <div
      role="region"
      aria-label={promo.title}
      data-testid="buildathon-promo-banner"
      className="fixed inset-x-0 top-0 z-[70] flex items-center justify-center gap-3 border-b border-black/20 px-10 text-[12px] font-medium text-white mac:titlebar-drag mac:ps-20"
      style={{ height: BANNER_HEIGHT_PX, backgroundColor: BLUE }}
    >
      <Rocket className="size-3.5 shrink-0" style={{ color: LIME }} aria-hidden="true" />
      <span className="shrink-0 font-extrabold uppercase tracking-[0.04em]">{promo.title}</span>
      {watching ? (
        <span className="truncate text-white/80" data-testid="buildathon-promo-waiting">Finish joining in your browser; this updates by itself.</span>
      ) : promo.text ? <span className="hidden truncate text-white/80 md:inline">{promo.text}</span> : null}
      <CtaButton promo={promo} size="xs" testId="buildathon-promo-banner-cta" />
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => dismissPromo(promo.id)}
        className="absolute right-2 inline-flex size-6 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white mac:titlebar-no-drag"
        data-testid="buildathon-promo-dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** The banner over the app while a promo is on; the app shifts below it like the other top banners. */
export function BuildathonPromoGate({ children }: { children: ReactNode }) {
  const promo = useActivePromo();
  return (
    <>
      {promo ? <BuildathonPromoBanner promo={promo} /> : null}
      <div data-buildathon-promo-shifted={promo ? "" : undefined} style={bannerShiftStyle(Boolean(promo))}>
        {children}
      </div>
    </>
  );
}

/** The promo id whose home card this run shows (the card is shown in one run only). */
let cardThisRun: string | null = null;

/** Whether the home card shows: the first run that sees this promo id keeps it for the run. */
function useOneTimeCard(promo: BuildathonPromo | null): boolean {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!promo || cardThisRun === promo.id) return;
    if (readPromoIds("card").has(promo.id)) return;
    cardThisRun = promo.id;
    rememberPromoId("card", promo.id);
    rerender((value) => value + 1);
  }, [promo]);
  return Boolean(promo && cardThisRun === promo.id);
}

/** Test hook: forget which card this run showed. */
export function resetPromoCardRun(): void {
  cardThisRun = null;
}

/** The one-time home-screen card: poster, title, text, CTA. */
export function BuildathonPromoCard() {
  const promo = useActivePromo();
  const show = useOneTimeCard(promo);
  if (!promo || !show) return null;
  return (
    <div
      className="relative flex overflow-hidden rounded-2xl border border-black/10 text-white shadow-[var(--dls-card-shadow)]"
      style={{ backgroundColor: BLUE }}
      data-testid="buildathon-promo-card"
    >
      <img
        src={posterThumb}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="w-[104px] shrink-0 object-cover object-top"
      />
      <div className="min-w-0 flex-1 space-y-1.5 p-4 pe-9">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em]" style={{ color: LIME }}>Online · Solo</div>
        <div className="text-[17px] font-extrabold uppercase leading-tight tracking-[-0.01em]">{promo.title}</div>
        {promo.text ? <div className="text-[12.5px] leading-snug text-white/85">{promo.text}</div> : null}
        <div className="flex items-center gap-2 pt-1">
          <CtaButton promo={promo} size="sm" testId="buildathon-promo-card-cta" />
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => dismissPromo(promo.id)}
        className="absolute right-2 top-2 inline-flex size-6 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white"
        data-testid="buildathon-promo-card-dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
