/** @jsxImportSource react */
import { useState } from "react";
import { HardDrive, Search, Trash2 } from "lucide-react";

import { t } from "../../../../i18n";
import { freeUpSpace } from "../../../../app/lib/desktop";
import { isElectronRuntime } from "../../../../app/utils";

export type FreeSpaceItem = { kind: string; path: string; bytes: number; size: string; reason: string; inUse: boolean };
export type FreeSpaceResult = { ok: boolean; skipped: string | null; dryRun: boolean; freedBytes: number; freed: string; items: FreeSpaceItem[] };
export type FreeSpaceDeps = { freeUpSpace: (options: { dryRun: boolean }) => Promise<FreeSpaceResult> };

/** One status line for a result. */
export function freeSpaceMessage(result: FreeSpaceResult): string {
  if (!result.ok) return result.skipped === "update-pending" ? t("settings.free_space_update_pending") : t("settings.free_space_busy");
  const removable = result.items.filter((item) => !item.inUse);
  if (removable.length === 0) return t("settings.free_space_nothing");
  return result.dryRun
    ? t("settings.free_space_found", { size: result.freed, count: String(removable.length) })
    : t("settings.free_space_done", { size: result.freed });
}

export type FreeSpaceSectionProps = {
  /** Shown only in the desktop app; defaults to the current runtime. */
  available?: boolean;
  /** Test seam. */
  deps?: FreeSpaceDeps;
  /** A company account (OmniRush Work): a 12 px label and 13 px text instead of 11 px. */
  work?: boolean;
};

/**
 * Settings > General > Storage: what the app no longer needs (installed
 * update downloads, stopped downloads, old logs, old crash reports, temp files
 * of runs that stopped). "Check" only lists; "Free up space" removes those.
 * Chats, projects, settings and anything not uploaded yet are never touched.
 */
export function FreeSpaceSection(props: FreeSpaceSectionProps) {
  const [busy, setBusy] = useState<"check" | "clean" | null>(null);
  const [result, setResult] = useState<FreeSpaceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const available = props.available ?? isElectronRuntime();
  if (!available) return null;

  async function run(dryRun: boolean) {
    const deps = props.deps ?? { freeUpSpace: (options) => freeUpSpace(options) as Promise<FreeSpaceResult> };
    setBusy(dryRun ? "check" : "clean");
    setError(null);
    try {
      setResult(await deps.freeUpSpace({ dryRun }));
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : String(cause ?? ""));
    } finally {
      setBusy(null);
    }
  }

  const buttonClass = `inline-flex items-center gap-1.5 rounded-lg border border-dls-border px-3 py-2 ${props.work ? "text-[13px]" : "text-[12px]"} text-dls-text hover:bg-dls-hover disabled:opacity-50`;
  const listed = result?.items ?? [];
  const small = props.work ? "text-[13px]" : "text-[11px]";

  return (
    <div className="space-y-3" data-testid="settings-free-space">
      <div className={`${props.work ? "text-[12px]" : "text-[11px]"} font-semibold uppercase tracking-[0.15em] text-dls-secondary`}>
        {t("settings.free_space_section_title")}
      </div>
      <div className="flex items-start gap-4 rounded-2xl border border-dls-border bg-dls-surface p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
          <HardDrive size={17} className="text-dls-secondary" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <div className="text-[13px] font-medium text-dls-text">{t("settings.free_space_card_title")}</div>
            <div className={`${small} text-dls-secondary`}>{t("settings.free_space_card_desc")}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void run(true)}>
              <Search size={13} />
              {t("settings.free_space_check")}
            </button>
            <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void run(false)}>
              <Trash2 size={13} />
              {t("settings.free_space_clean")}
            </button>
          </div>
          {result ? (
            <div className="space-y-1" role="status" data-testid="settings-free-space-status">
              <div className={`${small} text-dls-secondary`}>{freeSpaceMessage(result)}</div>
              {listed.length > 0 ? (
                <ul className={`max-h-40 space-y-0.5 overflow-auto ${props.work ? "text-[12px]" : "text-[11px]"} text-dls-secondary`}>
                  {listed.map((item) => (
                    <li key={item.path} className="truncate" title={item.path}>
                      {item.inUse ? t("settings.free_space_in_use") : item.size} · {item.reason} · {item.path}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {error ? <div className={`${small} text-red-400`} role="status">{t("settings.free_space_failed")}: {error}</div> : null}
        </div>
      </div>
    </div>
  );
}
