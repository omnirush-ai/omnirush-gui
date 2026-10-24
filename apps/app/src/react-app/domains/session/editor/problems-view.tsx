/** @jsxImportSource react */
/**
 * The Problems panel (bottom panel): what the project's language servers
 * report, by file. Scope: the files the servers have opened (yours and the
 * agent's), not a full build. Each problem opens its line; "Fix with agent"
 * hands it to the chat.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, CircleX, Info, RefreshCw, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEditorStore } from "./editor-store";
import { diagnosticCode, problemCounts, useProblemsStore, type LspDiagnostic } from "./lsp";
import { t } from "@/i18n";

const EMPTY: never[] = [];

export function ProblemsView(props: {
  workspaceId: string;
  loading: boolean;
  onOpen: (path: string, line: number, column: number) => void;
  onFix: (path: string, diagnostic: LspDiagnostic) => void;
  onRefresh: () => void;
}) {
  const files = useProblemsStore((state) => state.byWorkspace[props.workspaceId] ?? EMPTY);
  const available = useProblemsStore((state) => state.available);
  const languageFeatures = useEditorStore((state) => state.languageFeatures);
  const setLanguageFeatures = useEditorStore((state) => state.setLanguageFeatures);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [errorsOnly, setErrorsOnly] = useState(false);
  const counts = problemCounts(files);
  const shown = useMemo(() => files.map((file) => ({
    ...file,
    diagnostics: [...file.diagnostics]
      .filter((diagnostic) => !errorsOnly || (diagnostic.severity ?? 1) === 1)
      .sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line),
  })).filter((file) => file.diagnostics.length), [errorsOnly, files]);

  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-editor-problems={counts.errors + counts.warnings}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-muted-foreground">
        <span>{counts.errors} error{counts.errors === 1 ? "" : "s"}, {counts.warnings} warning{counts.warnings === 1 ? "" : "s"}</span>
        <span className="text-[11px]">· files the language servers have open</span>
        <span className="flex-1" />
        <label className="flex items-center gap-1" title="Problems, hover, go to definition, rename and outline from the project's language servers">
          <input type="checkbox" checked={languageFeatures} onChange={(event) => setLanguageFeatures(event.target.checked)} data-editor-language-features />
          {t("settings.editor.language_features")}
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} />
          {t("editor.errors_only")}
        </label>
        <Button variant="ghost" size="icon-xs" aria-label={t("editor.refresh_problems")} onClick={props.onRefresh}>
          <RefreshCw className={cn(props.loading && "animate-spin")} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!languageFeatures ? (
          <p className="px-3 py-2 text-muted-foreground">
            Language features in the editor are off, so no language server starts for the files you open.{" "}
            <button type="button" className="text-foreground underline underline-offset-2" onClick={() => setLanguageFeatures(true)}>Turn on</button>
          </p>
        ) : !available ? (
          <p className="px-3 py-2 text-muted-foreground">This engine build has no editor language features yet; problems show once it updates.</p>
        ) : shown.length === 0 ? (
          <p className="px-3 py-2 text-muted-foreground">No problems in the files the language servers have open. Open a file to check it.</p>
        ) : shown.map((file) => (
          <div key={file.path}>
            <button
              type="button"
              className="flex w-full items-center gap-1 px-2 py-0.5 text-start hover:bg-muted"
              onClick={() => setCollapsed((value) => ({ ...value, [file.path]: !value[file.path] }))}
            >
              {collapsed[file.path] ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
              <span className="font-medium">{file.path.split("/").pop()}</span>
              <span className="truncate text-[10.5px] text-muted-foreground">{file.path}</span>
              <span className="ms-auto rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{file.diagnostics.length}</span>
            </button>
            {collapsed[file.path] ? null : file.diagnostics.map((diagnostic, index) => {
              const severity = diagnostic.severity ?? 1;
              const code = diagnosticCode(diagnostic);
              return (
                <div key={`${index}:${diagnostic.range.start.line}`} className="group flex items-center gap-2 py-0.5 ps-6 pe-2 hover:bg-muted" data-editor-problem>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-start"
                    onClick={() => props.onOpen(file.path, diagnostic.range.start.line + 1, diagnostic.range.start.character + 1)}
                  >
                    {severity === 1 ? <CircleX className="size-3.5 shrink-0 text-red-11" aria-label="Error" />
                      : severity === 2 ? <AlertTriangle className="size-3.5 shrink-0 text-amber-11" aria-label="Warning" />
                        : <Info className="size-3.5 shrink-0 text-blue-11" aria-label="Info" />}
                    <span className="min-w-0 truncate">{diagnostic.message.split("\n")[0]}</span>
                    <span className="shrink-0 text-[10.5px] text-muted-foreground">
                      {diagnostic.source ? `${diagnostic.source}${code ? `(${code})` : ""} · ` : ""}
                      L{diagnostic.range.start.line + 1}:C{diagnostic.range.start.character + 1}
                    </span>
                  </button>
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-5 shrink-0 gap-1 px-1.5 text-[10.5px] opacity-70 group-hover:opacity-100"
                    onClick={() => props.onFix(file.path, diagnostic)}
                    data-editor-problem-fix
                  >
                    <Sparkles className="size-3" /> Fix with agent
                  </Button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
