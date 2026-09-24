/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DiagnosticsSection,
  copyDiagnostics,
  diagnosticsExportFileName,
  exportDiagnostics,
  openDiagnosticsLogsFolder,
  type DiagnosticsActionDeps,
} from "../src/react-app/domains/settings/pages/diagnostics-section";

function fakeDeps(overrides: Partial<DiagnosticsActionDeps> = {}) {
  const calls = { clipboard: [] as string[], saved: [] as Array<{ filename: string; content: string }>, logs: 0 };
  const deps: DiagnosticsActionDeps = {
    buildBundle: async () => '{"app":{"version":"1.1.1"}}',
    writeClipboard: async (text) => { calls.clipboard.push(text); },
    saveFile: (filename, content) => { calls.saved.push({ filename, content }); },
    openLogsFolder: async () => { calls.logs += 1; return { ok: true }; },
    now: () => new Date("2026-09-24T08:32:30.000Z"),
    ...overrides,
  };
  return { deps, calls };
}

describe("settings diagnostics section", () => {
  test("renders copy, export and open-logs actions in the desktop app", () => {
    const markup = renderToStaticMarkup(<DiagnosticsSection canOpenLogsFolder deps={fakeDeps().deps} />);
    expect(markup).toContain("Diagnostics");
    expect(markup).toContain("Copy diagnostics");
    expect(markup).toContain("Export diagnostics");
    expect(markup).toContain("Open logs folder");
    expect(markup).toContain("omnirush-server.log");
  });

  test("hides the logs folder button outside the desktop app", () => {
    const markup = renderToStaticMarkup(<DiagnosticsSection canOpenLogsFolder={false} deps={fakeDeps().deps} />);
    expect(markup).toContain("Copy diagnostics");
    expect(markup).toContain("Export diagnostics");
    expect(markup).not.toContain("Open logs folder");
  });

  test("copies the sanitized bundle to the clipboard", async () => {
    const { deps, calls } = fakeDeps();
    const result = await copyDiagnostics(deps);
    expect(result.ok).toBe(true);
    expect(calls.clipboard).toEqual(['{"app":{"version":"1.1.1"}}']);
  });

  test("exports the same bundle as a timestamped JSON file", async () => {
    const { deps, calls } = fakeDeps();
    const result = await exportDiagnostics(deps);
    expect(result.ok).toBe(true);
    expect(calls.saved).toEqual([
      { filename: "omnirush-diagnostics-2026-09-24T08-32-30-000Z.json", content: '{"app":{"version":"1.1.1"}}' },
    ]);
    expect(diagnosticsExportFileName(new Date("2026-01-02T03:04:05.006Z"))).toBe(
      "omnirush-diagnostics-2026-01-02T03-04-05-006Z.json",
    );
  });

  test("reports a bundle failure instead of throwing", async () => {
    const { deps, calls } = fakeDeps({ buildBundle: async () => { throw new Error("bridge unavailable"); } });
    const copied = await copyDiagnostics(deps);
    const exported = await exportDiagnostics(deps);
    expect(copied.ok).toBe(false);
    expect(copied.message).toContain("bridge unavailable");
    expect(exported.ok).toBe(false);
    expect(calls.clipboard).toEqual([]);
    expect(calls.saved).toEqual([]);
  });

  test("opens the logs folder through the desktop bridge and surfaces its error", async () => {
    const ok = fakeDeps();
    expect((await openDiagnosticsLogsFolder(ok.deps)).ok).toBe(true);
    expect(ok.calls.logs).toBe(1);

    const refused = fakeDeps({ openLogsFolder: async () => ({ ok: false, error: "Only the main window can open the logs folder." }) });
    const result = await openDiagnosticsLogsFolder(refused.deps);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Only the main window");

    const missingBridge = fakeDeps({ openLogsFolder: async () => { throw new Error("Electron desktop helper is unavailable: openLogsFolder"); } });
    expect((await openDiagnosticsLogsFolder(missingBridge.deps)).ok).toBe(false);
  });
});
