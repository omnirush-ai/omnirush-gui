/** @jsxImportSource react */
// Import from another browser: pick a browser found on this computer (with its own profile names), see what it can
// bring before anything is copied (bookmarks, recent history, the sites it is signed in to), import with live
// progress, and a plain done state. Saved passwords, cards and extensions are never read.
import type { ImportBrowser, ImportableSite } from "@omnirush/browser-logins";
import { useQuery } from "@tanstack/react-query";
import {
  Bookmark,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  History,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  BrowserImportInspection,
  BrowserImportKind,
  BrowserImportPart,
  BrowserImportResult,
  BrowserImportSignIns,
  BrowserImportSources,
  BrowserImportStep,
} from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { BrowserTile } from "./browser-marks";
import {
  browserLibraryKeys,
  getBrowserLibraryBridge,
  offerBrowser,
  useBrowserImportSources,
  useInvalidateBrowserLibrary,
} from "./use-browser-library";

type Group = BrowserImportSources["browsers"][number];
type RowStatus = "waiting" | "running" | BrowserImportStep;
type Choices = { bookmarks: boolean; history: boolean; signIns: boolean; keepInStep: boolean; sites: Set<string> };

const fmt = (count: number) => count.toLocaleString();

/** Why a part could not be read, in words. `browser` is the short name ("Chrome"). */
export function importFailureText(reason: string, browser: string): string {
  switch (reason) {
    case "busy":
      return t("browser_import.fail_busy", { browser });
    case "key_denied":
      return t("browser_import.fail_key_denied", { browser });
    case "key_unavailable":
      return t("browser_import.fail_key_unavailable", { browser });
    case "unsupported_encryption":
    case "windows_locked":
      return t("browser_import.signins_windows_locked", { browser });
    case "windows_unsupported":
      return t("browser_import.signins_windows_unsupported", { browser });
    case "policy_off":
      return t("browser_import.signins_policy_off");
    case "expired":
      return t("browser_import.fail_expired");
    case "cancelled":
      return t("browser_import.fail_cancelled");
    case "full_disk_access":
      return t("browser_import.fail_access");
    case "missing":
      return t("browser_import.fail_missing", { browser });
    default:
      return t("browser_import.fail_generic");
  }
}

/** One sentence for the done screen: "312 bookmarks, 4,210 pages and 31 sign-ins". Empty parts are left out. */
export function importSummary(result: BrowserImportResult): string {
  const parts: string[] = [];
  if (result.bookmarks?.state === "done") parts.push(t("browser_import.count_bookmarks", { count: result.bookmarks.count, n: fmt(result.bookmarks.count) }));
  if (result.history?.state === "done") parts.push(t("browser_import.count_pages", { count: result.history.count, n: fmt(result.history.count) }));
  if (result.signIns?.state === "done") parts.push(t("browser_import.count_signins", { count: result.signIns.count, n: fmt(result.signIns.count) }));
  if (parts.length === 0) return t("browser_import.nothing_imported");
  if (parts.length === 1) return parts[0]!;
  return t("browser_import.list_and", { list: parts.slice(0, -1).join(", "), last: parts[parts.length - 1]! });
}

function initialChoices(inspection: BrowserImportInspection): Choices {
  const sites = inspection.signIns.state === "ready" ? inspection.signIns.sites.filter((site) => site.preselected).map((site) => site.site) : [];
  return {
    bookmarks: inspection.bookmarks.state === "ready",
    history: inspection.history.state === "ready",
    signIns: sites.length > 0,
    keepInStep: false,
    sites: new Set(sites),
  };
}

/** Arrow keys move through a radio group, as the platform's own radio buttons do. */
function moveInRadioGroup(event: KeyboardEvent<HTMLElement>, ids: string[], current: string | null, select: (id: string) => void) {
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (step === 0 || ids.length === 0) return;
  event.preventDefault();
  const index = Math.max(0, ids.indexOf(current ?? ""));
  const next = ids[(index + step + ids.length) % ids.length]!;
  select(next);
  const group = event.currentTarget;
  requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-radio-id="${CSS.escape(next)}"]`)?.focus());
}

export type BrowserImportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Start on this browser (the one the offer named). */
  initialBrowser?: ImportBrowser | null;
  onImported?: (result: BrowserImportResult) => void;
};

export function BrowserImportDialog({ open, onOpenChange, initialBrowser = null, onImported }: BrowserImportDialogProps) {
  const sources = useBrowserImportSources(open);
  const invalidate = useInvalidateBrowserLibrary();
  const browsers = useMemo(() => sources.data?.browsers ?? [], [sources.data]);
  const [browser, setBrowser] = useState<ImportBrowser | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [stage, setStage] = useState<"choose" | "importing" | "done">("choose");
  const [progress, setProgress] = useState<Partial<Record<BrowserImportKind, RowStatus>>>({});
  const [result, setResult] = useState<BrowserImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [sitesOpen, setSitesOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStage("choose");
    setProgress({});
    setResult(null);
    setError(null);
    setBrowser(null);
    setProfileId(null);
    setSitesOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open || browser !== null || browsers.length === 0) return;
    const first = browsers.find((entry) => entry.browser === initialBrowser) ?? offerBrowser(sources.data) ?? browsers[0]!;
    setBrowser(first.browser);
    setProfileId(first.profiles[0]?.id ?? null);
  }, [browser, browsers, initialBrowser, open, sources.data]);

  const group = browsers.find((entry) => entry.browser === browser) ?? null;
  const needsAccess = group?.access === "full_disk_access";
  const inspection = useQuery<BrowserImportInspection>({
    queryKey: browserLibraryKeys.inspect(profileId ?? ""),
    queryFn: () => getBrowserLibraryBridge()!.inspect({ sourceId: profileId! }),
    enabled: open && profileId !== null && !needsAccess && stage === "choose" && getBrowserLibraryBridge() !== null,
    // The sign-in list carries a one-use preview; never serve an old one.
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    setChoices(inspection.data ? initialChoices(inspection.data) : null);
    setSitesOpen(false);
  }, [inspection.data]);

  const chooseBrowser = useCallback((id: string) => {
    const next = browsers.find((entry) => entry.browser === id);
    if (!next) return;
    setBrowser(next.browser);
    setProfileId(next.profiles[0]?.id ?? null);
    setError(null);
  }, [browsers]);

  const chooseProfile = useCallback((id: string) => {
    setProfileId(id);
    setError(null);
  }, []);

  const short = group?.short ?? "";
  const data = inspection.data ?? null;
  const signIns = data?.signIns ?? null;
  const readySites = signIns?.state === "ready" ? signIns.sites : [];
  const selectedSites = choices?.sites ?? new Set<string>();
  const willImportSignIns = Boolean(choices?.signIns && signIns?.state === "ready" && selectedSites.size > 0);
  const canImport = stage === "choose" && Boolean(choices && (choices.bookmarks || choices.history || willImportSignIns));

  const runImport = useCallback(async () => {
    const bridge = getBrowserLibraryBridge();
    if (!bridge || !data || !choices || !profileId) return;
    const plan: Partial<Record<BrowserImportKind, RowStatus>> = {};
    if (choices.bookmarks) plan.bookmarks = "waiting";
    if (choices.history) plan.history = "waiting";
    if (willImportSignIns) plan.signIns = "waiting";
    setProgress(plan);
    setStage("importing");
    setError(null);
    const stop = bridge.onProgress((update) => {
      setProgress((current) => ({ ...current, [update.kind]: update.state === "running" ? "running" : update }));
    });
    try {
      const outcome = await bridge.import({
        sourceId: profileId,
        bookmarks: choices.bookmarks,
        history: choices.history,
        signIns: willImportSignIns && signIns?.state === "ready"
          ? { previewId: signIns.previewId, sites: [...selectedSites], keepInStep: choices.keepInStep }
          : null,
      });
      setResult(outcome);
      setStage("done");
      void invalidate();
      onImported?.(outcome);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
      setStage("choose");
    } finally {
      stop();
    }
  }, [choices, data, invalidate, onImported, profileId, selectedSites, signIns, willImportSignIns]);

  const toggleSite = useCallback((site: string, checked: boolean) => {
    setChoices((current) => {
      if (!current) return current;
      const sites = new Set(current.sites);
      if (checked) sites.add(site);
      else sites.delete(site);
      return { ...current, sites, signIns: sites.size > 0 ? true : current.signIns };
    });
  }, []);

  const setAllSites = useCallback((on: boolean) => {
    setChoices((current) => (current ? { ...current, sites: new Set(on ? readySites.map((site) => site.site) : []), signIns: on } : current));
  }, [readySites]);

  const statusFor = (kind: BrowserImportKind): RowStatus | null => (stage === "choose" ? null : progress[kind] ?? null);
  const nothingHere = data && data.bookmarks.state === "empty" && data.history.state === "empty" && (data.signIns.state === "empty" || data.signIns.state === "unavailable");

  return (
    <Dialog open={open} onOpenChange={(next) => { if (stage !== "importing") onOpenChange(next); }}>
      <DialogContent className="gap-5 lg:max-w-[560px]" data-testid="browser-import-dialog" showCloseButton={stage !== "importing"}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[17px] tracking-[-0.01em]">
            {stage === "done" && result ? (
              <>
                <CircleCheck aria-hidden className="size-[18px] text-green-11" />
                {t("browser_import.done_title", { browser: short })}
              </>
            ) : t("browser_import.title")}
          </DialogTitle>
          <DialogDescription>
            {stage === "done" && result ? importSummary(result) : t("browser_import.subtitle")}
          </DialogDescription>
        </DialogHeader>

        {sources.isLoading ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-9 w-2/3 rounded-lg" />
            <Skeleton className="h-36 w-full rounded-xl" />
          </div>
        ) : browsers.length === 0 ? (
          <div className="rounded-xl border border-border px-4 py-6 text-center" data-testid="browser-import-none">
            <p className="text-[13px] font-medium text-foreground">{t("browser_import.none_title")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("browser_import.none_body")}</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-4">
            {stage === "choose" ? (
              <div className="flex flex-col gap-2.5">
                <p className="text-xs font-medium text-muted-foreground" id="browser-import-from">{t("browser_import.from")}</p>
                <div
                  role="radiogroup"
                  aria-labelledby="browser-import-from"
                  className="flex flex-wrap gap-2"
                  onKeyDown={(event) => moveInRadioGroup(event, browsers.map((entry) => entry.browser), browser, chooseBrowser)}
                >
                  {browsers.map((entry) => {
                    const checked = entry.browser === browser;
                    return (
                      <button
                        key={entry.browser}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        tabIndex={checked ? 0 : -1}
                        data-radio-id={entry.browser}
                        data-testid={`browser-import-browser-${entry.browser}`}
                        onClick={() => chooseBrowser(entry.browser)}
                        className={cn(
                          "inline-flex h-10 items-center gap-2 rounded-xl border bg-background pe-3 ps-1.5 text-[13px] font-medium text-foreground transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          checked ? "border-foreground/25 bg-muted shadow-[inset_0_0_0_1px] shadow-foreground/10" : "border-border hover:bg-muted/60",
                        )}
                      >
                        <BrowserTile browser={entry.browser} size="row" />
                        {entry.short}
                      </button>
                    );
                  })}
                </div>
                {group && group.profiles.length > 1 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="me-1 text-xs text-muted-foreground" id="browser-import-profile">{t("browser_import.profile")}</span>
                    <div
                      role="radiogroup"
                      aria-labelledby="browser-import-profile"
                      className="flex flex-wrap gap-1.5"
                      onKeyDown={(event) => moveInRadioGroup(event, group.profiles.map((profile) => profile.id), profileId, chooseProfile)}
                    >
                      {group.profiles.map((profile) => {
                        const checked = profile.id === profileId;
                        return (
                          <button
                            key={profile.id}
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            tabIndex={checked ? 0 : -1}
                            data-radio-id={profile.id}
                            data-testid={`browser-import-profile-${profile.id}`}
                            onClick={() => chooseProfile(profile.id)}
                            className={cn(
                              "h-7 max-w-[14rem] truncate rounded-lg border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              checked ? "border-foreground/25 bg-muted font-medium text-foreground" : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                            )}
                          >
                            {profile.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {needsAccess && stage === "choose" ? (
              <FullDiskAccessSteps onCheckAgain={() => void sources.refetch()} />
            ) : (
              <div className="flex flex-col gap-2">
                {stage === "choose" ? <p className="text-xs font-medium text-muted-foreground">{t("browser_import.what")}</p> : null}
                {inspection.isLoading || (!data && !inspection.isError) ? (
                  <div className="overflow-hidden rounded-xl border border-border" aria-busy="true" data-testid="browser-import-counting">
                    {[0, 1, 2].map((index) => (
                      <div key={index} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                        <Skeleton className="size-4 rounded-[5px]" />
                        <Skeleton className="size-7 rounded-lg" />
                        <div className="flex flex-1 flex-col gap-1.5">
                          <Skeleton className="h-3 w-24" />
                          <Skeleton className="h-2.5 w-40" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : inspection.isError ? (
                  <p className="rounded-xl border border-border px-4 py-3 text-xs text-muted-foreground" role="alert">
                    {t("browser_import.fail_generic")}
                  </p>
                ) : data && choices ? (
                  nothingHere && stage === "choose" ? (
                    <p className="rounded-xl border border-border px-4 py-5 text-center text-xs text-muted-foreground">{t("browser_import.nothing_here")}</p>
                  ) : (
                    <ul className="overflow-hidden rounded-xl border border-border" aria-label={t("browser_import.what")}>
                      <PartRow
                        kind="bookmarks"
                        icon={<Bookmark />}
                        title={t("browser_import.bookmarks")}
                        part={data.bookmarks}
                        browser={short}
                        detail={t("browser_import.bookmarks_detail", { browser: short })}
                        checked={choices.bookmarks}
                        onCheckedChange={(value) => setChoices({ ...choices, bookmarks: value })}
                        status={statusFor("bookmarks")}
                        stage={stage}
                      />
                      <PartRow
                        kind="history"
                        icon={<History />}
                        title={t("browser_import.history")}
                        part={data.history}
                        browser={short}
                        detail={t("browser_import.history_detail", { days: data.history.state === "ready" || data.history.state === "empty" ? data.history.days ?? 90 : 90 })}
                        countLabel={(count) => t("browser_import.count_pages", { count, n: fmt(count) })}
                        checked={choices.history}
                        onCheckedChange={(value) => setChoices({ ...choices, history: value })}
                        status={statusFor("history")}
                        stage={stage}
                      />
                      <SignInsRow
                        signIns={data.signIns}
                        browser={short}
                        checked={choices.signIns}
                        selected={selectedSites}
                        onCheckedChange={(value) => {
                          setChoices({ ...choices, signIns: value, sites: value && selectedSites.size === 0 ? new Set(readySites.filter((site) => site.preselected).map((site) => site.site)) : selectedSites });
                          if (value && readySites.every((site) => !site.preselected)) setSitesOpen(true);
                        }}
                        sitesOpen={sitesOpen}
                        onToggleSites={() => setSitesOpen((value) => !value)}
                        onToggleSite={toggleSite}
                        onSelectAll={setAllSites}
                        status={statusFor("signIns")}
                        stage={stage}
                      />
                      {stage === "choose" && signIns?.state === "ready" && choices.signIns ? (
                        <li className="flex items-start gap-3 border-t border-border bg-muted/30 px-4 py-3">
                          <RefreshCw aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                          <label className="min-w-0 flex-1 cursor-pointer" htmlFor="browser-import-keep">
                            <span className="block text-[13px] font-medium text-foreground">{t("browser_import.keep_title", { browser: short })}</span>
                            <span className="block text-xs text-muted-foreground">{t("browser_import.keep_detail", { browser: short })}</span>
                          </label>
                          <Switch
                            id="browser-import-keep"
                            size="sm"
                            className="mt-0.5"
                            checked={choices.keepInStep}
                            onCheckedChange={(value) => setChoices({ ...choices, keepInStep: value === true })}
                            data-testid="browser-import-keep"
                          />
                        </li>
                      ) : null}
                    </ul>
                  )
                ) : null}
              </div>
            )}

            {error ? (
              <p className="flex items-start gap-2 rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11" role="alert">
                <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                {error}
              </p>
            ) : null}

            {stage !== "done" ? (
              <div className="flex items-start gap-2.5 text-xs text-muted-foreground" data-testid="browser-import-privacy">
                <Lock aria-hidden className="mt-px size-3.5 shrink-0" />
                <p>
                  <span className="text-foreground/80">{t("browser_import.stays_here")}</span>{" "}
                  {t("browser_import.never_imported")}
                </p>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter className="items-center">
          {stage === "done" ? (
            <Button onClick={() => onOpenChange(false)} data-testid="browser-import-done" autoFocus>
              {t("browser_import.done")}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={stage === "importing"}>
                {t("browser_import.cancel")}
              </Button>
              <Button onClick={() => void runImport()} disabled={!canImport || needsAccess} data-testid="browser-import-submit">
                {stage === "importing" ? (
                  <>
                    <Loader2 aria-hidden className="animate-spin" />
                    {t("browser_import.importing")}
                  </>
                ) : (
                  t("browser_import.import")
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusIcon({ status }: { status: RowStatus }) {
  if (status === "waiting") return <span aria-hidden className="mx-auto size-1.5 rounded-full bg-muted-foreground/40" />;
  if (status === "running") return <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground" />;
  if (status.state === "done") return <Check aria-hidden className="size-4 text-green-11" />;
  return <CircleAlert aria-hidden className="size-4 text-amber-11" />;
}

function statusLine(status: RowStatus, doneText: (count: number) => string, browser: string): string {
  if (status === "waiting") return t("browser_import.waiting");
  if (status === "running") return t("browser_import.working");
  if (status.state === "done") return doneText(status.count);
  return importFailureText(status.reason, browser);
}

function RowFrame(props: {
  kind: BrowserImportKind;
  icon: ReactNode;
  title: string;
  lead: ReactNode;
  meta: ReactNode;
  trailing?: ReactNode;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="border-b border-border last:border-b-0" data-testid={`browser-import-row-${props.kind}`}>
      <div className={cn("flex items-center gap-3 px-4 py-3", props.disabled && "opacity-60")}>
        <span className="flex w-4 shrink-0 justify-center">{props.lead}</span>
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground [&_svg]:size-3.5">
          {props.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-5 text-foreground">{props.title}</p>
          <div className="text-xs leading-4 text-muted-foreground">{props.meta}</div>
        </div>
        {props.trailing ? <div className="shrink-0 text-xs tabular-nums text-muted-foreground">{props.trailing}</div> : null}
      </div>
      {props.children}
    </li>
  );
}

function PartRow(props: {
  kind: "bookmarks" | "history";
  icon: ReactNode;
  title: string;
  part: BrowserImportPart;
  browser: string;
  detail: string;
  countLabel?: (count: number) => string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  status: RowStatus | null;
  stage: "choose" | "importing" | "done";
}) {
  const id = `browser-import-${props.kind}`;
  const label = props.countLabel ?? ((count: number) => t("browser_import.count_bookmarks", { count, n: fmt(count) }));
  if (props.stage !== "choose") {
    if (!props.status) return null;
    return (
      <RowFrame kind={props.kind} icon={props.icon} title={props.title} lead={<StatusIcon status={props.status} />} meta={statusLine(props.status, label, props.browser)} />
    );
  }
  const { part } = props;
  const ready = part.state === "ready";
  const meta = part.state === "ready"
    ? props.detail
    : part.state === "empty"
      ? t("browser_import.none_in_profile")
      : importFailureText(part.reason, props.browser);
  return (
    <RowFrame
      kind={props.kind}
      icon={props.icon}
      title={props.title}
      disabled={!ready}
      lead={<Checkbox id={id} checked={ready && props.checked} disabled={!ready} onCheckedChange={(value) => props.onCheckedChange(value === true)} aria-label={props.title} />}
      meta={<label htmlFor={id}>{meta}</label>}
      trailing={props.part.state === "ready" ? label(props.part.count) : null}
    />
  );
}

function siteUse(lastUsedAt: number | null): string | null {
  if (lastUsedAt === null) return null;
  const days = Math.max(0, Math.floor((Date.now() / 1000 - lastUsedAt) / 86_400));
  if (days === 0) return t("browser_import.used_today");
  if (days === 1) return t("browser_import.used_yesterday");
  return t("browser_import.used_days", { count: days, n: fmt(days) });
}

function SignInsRow(props: {
  signIns: BrowserImportSignIns;
  browser: string;
  checked: boolean;
  selected: Set<string>;
  onCheckedChange: (checked: boolean) => void;
  sitesOpen: boolean;
  onToggleSites: () => void;
  onToggleSite: (site: string, checked: boolean) => void;
  onSelectAll: (on: boolean) => void;
  status: RowStatus | null;
  stage: "choose" | "importing" | "done";
}) {
  const icon = <KeyRound />;
  const title = t("browser_import.signins");
  const doneText = (count: number) => t("browser_import.count_signins", { count, n: fmt(count) });
  if (props.stage !== "choose") {
    if (!props.status) return null;
    const done = props.status !== "waiting" && props.status !== "running" && props.status.state === "done" ? props.status : null;
    return (
      <RowFrame
        kind="signIns"
        icon={icon}
        title={title}
        lead={<StatusIcon status={props.status} />}
        meta={done?.keepInStep ? `${doneText(done.count)}. ${t("browser_import.kept_in_step", { browser: props.browser })}` : statusLine(props.status, doneText, props.browser)}
      />
    );
  }
  const { signIns } = props;
  if (signIns.state !== "ready") {
    const meta = signIns.state === "empty"
      ? t("browser_import.signins_none")
      : importFailureText(signIns.reason, props.browser);
    return (
      <RowFrame
        kind="signIns"
        icon={icon}
        title={title}
        disabled
        lead={signIns.state === "unavailable" ? <Lock aria-hidden className="size-3.5 text-muted-foreground" /> : <Checkbox disabled checked={false} aria-label={title} />}
        meta={meta}
      />
    );
  }
  const total = signIns.sites.length;
  const ordinary = signIns.sites.filter((site) => site.category === "ordinary");
  const sensitive = signIns.sites.filter((site) => site.category !== "ordinary");
  return (
    <RowFrame
      kind="signIns"
      icon={icon}
      title={title}
      lead={<Checkbox id="browser-import-signins" checked={props.checked} onCheckedChange={(value) => props.onCheckedChange(value === true)} aria-label={title} data-testid="browser-import-signins" />}
      meta={(
        <span className="flex flex-wrap items-center gap-x-1.5">
          <label htmlFor="browser-import-signins">{t("browser_import.signins_detail")}</label>
          <button
            type="button"
            className="inline-flex items-center gap-0.5 rounded font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={props.sitesOpen}
            aria-controls="browser-import-sites"
            onClick={props.onToggleSites}
            data-testid="browser-import-review-sites"
          >
            {t("browser_import.review_sites")}
            <ChevronDown aria-hidden className={cn("size-3 transition-transform duration-150 motion-reduce:transition-none", props.sitesOpen && "rotate-180")} />
          </button>
        </span>
      )}
      trailing={props.checked ? t("browser_import.sites_of", { n: fmt(props.selected.size), total: fmt(total) }) : t("browser_import.count_sites", { count: total, n: fmt(total) })}
    >
      {props.sitesOpen ? (
        <div id="browser-import-sites" className="border-t border-border bg-muted/20 px-4 py-3" data-testid="browser-import-sites">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{t("browser_import.sites_hint")}</p>
            <div className="flex shrink-0 gap-1">
              <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => props.onSelectAll(true)}>{t("browser_import.select_all")}</Button>
              <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => props.onSelectAll(false)}>{t("browser_import.select_none")}</Button>
            </div>
          </div>
          <div className="max-h-52 overflow-y-auto pe-1">
            <SiteList sites={ordinary} selected={props.selected} onToggle={props.onToggleSite} />
            {sensitive.length > 0 ? (
              <>
                <p className="mb-1.5 mt-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <ShieldCheck aria-hidden className="size-3.5" />
                  {t("browser_import.sensitive_title")}
                </p>
                <SiteList sites={sensitive} selected={props.selected} onToggle={props.onToggleSite} />
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </RowFrame>
  );
}

function SiteList({ sites, selected, onToggle }: { sites: ImportableSite[]; selected: Set<string>; onToggle: (site: string, checked: boolean) => void }) {
  if (sites.length === 0) return null;
  return (
    <ul className="flex flex-col" aria-label={t("browser_import.sites")}>
      {sites.map((site) => {
        const use = siteUse(site.lastUsedAt);
        const id = `browser-import-site-${site.site}`;
        return (
          <li key={site.site} className="flex items-start gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-muted/60">
            <Checkbox
              id={id}
              className="mt-0.5"
              checked={selected.has(site.site)}
              onCheckedChange={(value) => onToggle(site.site, value === true)}
              data-testid={id}
            />
            <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
              <span className="block truncate text-[13px] text-foreground">{site.site}</span>
              {site.reason ? <span className="block text-xs text-muted-foreground">{site.reason}</span> : use ? <span className="block text-xs text-muted-foreground">{use}</span> : null}
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function FullDiskAccessSteps({ onCheckAgain }: { onCheckAgain: () => void }) {
  const [opened, setOpened] = useState(false);
  const checkRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="rounded-xl border border-border px-4 py-4" data-testid="browser-import-access">
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
          <Lock className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">{t("browser_import.access_title")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("browser_import.access_body")}</p>
          <ol className="mt-3 flex flex-col gap-1.5 text-xs text-foreground/90">
            {[t("browser_import.access_step1"), t("browser_import.access_step2"), t("browser_import.access_step3")].map((step, index) => (
              <li key={step} className="flex gap-2">
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium tabular-nums text-muted-foreground">{index + 1}</span>
                {step}
              </li>
            ))}
          </ol>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void getBrowserLibraryBridge()?.openFullDiskAccess();
                setOpened(true);
                requestAnimationFrame(() => checkRef.current?.focus());
              }}
              data-testid="browser-import-open-access"
            >
              {t("browser_import.access_open")}
            </Button>
            <Button ref={checkRef} size="sm" variant={opened ? "default" : "ghost"} onClick={onCheckAgain}>
              {t("browser_import.access_check")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
