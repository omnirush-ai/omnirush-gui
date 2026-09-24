/** @jsxImportSource react */
import { useState } from "react";
import { ClipboardCopy, Download, FolderOpen, LifeBuoy } from "lucide-react";

import { t } from "../../../../i18n";
import { buildDiagnosticsBundleJson } from "../../../../app/lib/diagnostics-bundle";
import { openLogsFolder } from "../../../../app/lib/desktop";
import { downloadTextAsFile } from "../../../../app/lib/download";
import { isElectronRuntime } from "../../../../app/utils";

export type DiagnosticsActionDeps = {
  buildBundle: () => Promise<string>;
  writeClipboard: (text: string) => Promise<void>;
  saveFile: (filename: string, content: string) => void;
  openLogsFolder: () => Promise<{ ok: boolean; error?: string } | undefined | void>;
  now?: () => Date;
};

export type DiagnosticsActionResult = { ok: boolean; message: string };

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return String(error ?? "").trim();
}

function failure(error: unknown): DiagnosticsActionResult {
  const detail = errorText(error);
  const base = t("settings.diagnostics_failed");
  return { ok: false, message: detail ? `${base}: ${detail}` : base };
}

/** File name for an exported bundle, e.g. omnirush-diagnostics-2026-09-24T08-32-30-000Z.json. */
export function diagnosticsExportFileName(date: Date): string {
  return `omnirush-diagnostics-${date.toISOString().replace(/[:.]/g, "-")}.json`;
}

export async function copyDiagnostics(deps: DiagnosticsActionDeps): Promise<DiagnosticsActionResult> {
  try {
    await deps.writeClipboard(await deps.buildBundle());
    return { ok: true, message: t("session.diagnostics_copied") };
  } catch (error) {
    return failure(error);
  }
}

export async function exportDiagnostics(deps: DiagnosticsActionDeps): Promise<DiagnosticsActionResult> {
  try {
    const json = await deps.buildBundle();
    deps.saveFile(diagnosticsExportFileName(deps.now?.() ?? new Date()), json);
    return { ok: true, message: t("session.diagnostics_exported") };
  } catch (error) {
    return failure(error);
  }
}

export async function openDiagnosticsLogsFolder(deps: DiagnosticsActionDeps): Promise<DiagnosticsActionResult> {
  try {
    const result = await deps.openLogsFolder();
    if (result && result.ok === false) {
      const detail = result.error?.trim();
      const base = t("settings.diagnostics_open_logs_failed");
      return { ok: false, message: detail ? `${base}: ${detail}` : base };
    }
    return { ok: true, message: t("settings.diagnostics_open_logs_done") };
  } catch (error) {
    const detail = errorText(error);
    const base = t("settings.diagnostics_open_logs_failed");
    return { ok: false, message: detail ? `${base}: ${detail}` : base };
  }
}

function defaultDeps(buildBundle?: () => Promise<string>): DiagnosticsActionDeps {
  return {
    buildBundle: buildBundle ?? (() => buildDiagnosticsBundleJson()),
    writeClipboard: (text) => navigator.clipboard.writeText(text),
    saveFile: (filename, content) => downloadTextAsFile(filename, content, "application/json"),
    openLogsFolder: () => openLogsFolder(),
  };
}

type DiagnosticsAction = "copy" | "export" | "logs";

export type DiagnosticsSectionProps = {
  /** Builds the sanitized bundle with the caller's route context. */
  buildBundle?: () => Promise<string>;
  /** "Open logs folder" needs the desktop app; defaults to the current runtime. */
  canOpenLogsFolder?: boolean;
  /** Test seam: replaces clipboard, file save and IPC. */
  deps?: DiagnosticsActionDeps;
};

/**
 * Settings > General > Diagnostics. The same sanitized bundle as the
 * command palette's "Copy diagnostics", plus a shortcut to the logs folder
 * that holds omnirush-server.log.
 */
export function DiagnosticsSection(props: DiagnosticsSectionProps) {
  const [busy, setBusy] = useState<DiagnosticsAction | null>(null);
  const [result, setResult] = useState<DiagnosticsActionResult | null>(null);
  const canOpenLogsFolder = props.canOpenLogsFolder ?? isElectronRuntime();

  async function run(action: DiagnosticsAction) {
    const deps = props.deps ?? defaultDeps(props.buildBundle);
    setBusy(action);
    setResult(null);
    try {
      const next = action === "copy"
        ? await copyDiagnostics(deps)
        : action === "export"
          ? await exportDiagnostics(deps)
          : await openDiagnosticsLogsFolder(deps);
      setResult(next);
    } finally {
      setBusy(null);
    }
  }

  const buttonClass = "inline-flex items-center gap-1.5 rounded-lg border border-dls-border px-3 py-2 text-[12px] text-dls-text hover:bg-dls-hover disabled:opacity-50";

  return (
    <div className="space-y-3" data-testid="settings-diagnostics">
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
        {t("settings.diagnostics_section_title")}
      </div>
      <div className="flex items-start gap-4 rounded-2xl border border-dls-border bg-dls-surface p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
          <LifeBuoy size={17} className="text-dls-secondary" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <div className="text-[13px] font-medium text-dls-text">{t("settings.diagnostics_card_title")}</div>
            <div className="text-[11px] text-dls-secondary">{t("settings.diagnostics_card_desc")}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void run("copy")}>
              <ClipboardCopy size={13} />
              {t("session.cmd_diagnostics_copy_title")}
            </button>
            <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void run("export")}>
              <Download size={13} />
              {t("session.cmd_diagnostics_export_title")}
            </button>
            {canOpenLogsFolder ? (
              <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void run("logs")}>
                <FolderOpen size={13} />
                {t("settings.diagnostics_open_logs")}
              </button>
            ) : null}
          </div>
          {result ? (
            <div
              className={`text-[11px] ${result.ok ? "text-dls-secondary" : "text-red-400"}`}
              role="status"
              data-testid="settings-diagnostics-status"
            >
              {result.message}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
