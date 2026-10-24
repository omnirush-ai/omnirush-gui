/** @jsxImportSource react */
/** The Outline section under the Files view: the active file's symbols from its language server. */
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type * as MonacoApi from "monaco-editor/editor/editor.api.js";

import { cn } from "@/lib/utils";
import { useEditorStore } from "./editor-store";
import { documentSymbols, useIsLspActive } from "./lsp";
import { t } from "@/i18n";

// Monaco SymbolKind (0-based): a short mark per kind.
const KIND_MARK: Record<number, { mark: string; className: string }> = {
  4: { mark: "C", className: "text-amber-11" },
  5: { mark: "m", className: "text-violet-11" },
  6: { mark: "p", className: "text-blue-11" },
  8: { mark: "c", className: "text-violet-11" },
  9: { mark: "E", className: "text-amber-11" },
  10: { mark: "I", className: "text-cyan-11" },
  11: { mark: "ƒ", className: "text-violet-11" },
  12: { mark: "v", className: "text-blue-11" },
  13: { mark: "k", className: "text-blue-11" },
  22: { mark: "s", className: "text-amber-11" },
  25: { mark: "T", className: "text-cyan-11" },
};

function SymbolRow(props: { symbol: MonacoApi.languages.DocumentSymbol; depth: number; onReveal: (line: number, column: number) => void }) {
  const [open, setOpen] = useState(props.depth < 1);
  const children = props.symbol.children ?? [];
  const mark = KIND_MARK[props.symbol.kind] ?? { mark: "•", className: "text-muted-foreground" };
  return (
    <>
      <div className="flex items-center gap-1 rounded-md py-0.5 pe-1 hover:bg-muted" style={{ paddingInlineStart: 6 + props.depth * 12 }}>
        {children.length ? (
          <button type="button" aria-label={open ? "Collapse" : "Expand"} onClick={() => setOpen((value) => !value)} className="text-muted-foreground">
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        ) : <span className="w-3" />}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-start"
          onClick={() => props.onReveal(props.symbol.selectionRange.startLineNumber, props.symbol.selectionRange.startColumn)}
          data-editor-outline-symbol={props.symbol.name}
        >
          <span className={cn("w-3 shrink-0 text-center font-mono text-[10.5px]", mark.className)}>{mark.mark}</span>
          <span className="truncate">{props.symbol.name}</span>
          {props.symbol.detail ? <span className="truncate text-[10.5px] text-muted-foreground">{props.symbol.detail}</span> : null}
        </button>
      </div>
      {open ? children.map((child, index) => <SymbolRow key={`${child.name}:${index}`} symbol={child} depth={props.depth + 1} onReveal={props.onReveal} />) : null}
    </>
  );
}

export function OutlineView(props: { model: MonacoApi.editor.ITextModel | null; path: string | null; onReveal: (line: number, column: number) => void }) {
  const [open, setOpen] = useState(true);
  const [symbols, setSymbols] = useState<MonacoApi.languages.DocumentSymbol[] | null>(null);
  const [tick, setTick] = useState(0);
  const active = useIsLspActive(props.path);
  const languageFeatures = useEditorStore((state) => state.languageFeatures);

  useEffect(() => {
    const model = props.model;
    if (!model) return;
    const subscription = model.onDidChangeContent(() => setTick((value) => value + 1));
    return () => subscription.dispose();
  }, [props.model]);

  useEffect(() => {
    let cancelled = false;
    const model = props.model;
    if (!model || !open) {
      setSymbols(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void documentSymbols(model).then((next) => {
        if (!cancelled) setSymbols(next);
      });
    }, tick ? 800 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, props.model, tick, active]);

  return (
    <div className={cn("flex min-h-0 flex-col border-t border-border text-xs", open ? "max-h-[45%]" : "")} data-editor-outline>
      <button type="button" className="flex h-7 shrink-0 items-center gap-1 px-2 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {t("editor.outline")}
        {props.path ? <span className="truncate normal-case tracking-normal">· {props.path.split("/").pop()}</span> : null}
      </button>
      {open ? (
        <div className="min-h-0 overflow-y-auto px-1 pb-2">
          {!props.model ? <p className="px-2 text-muted-foreground">{t("editor.outline_no_file")}</p>
            : !languageFeatures ? <p className="px-2 text-muted-foreground">{t("editor.outline_lang_off")}</p>
            : symbols === null ? <p className="px-2 text-muted-foreground">{active ? t("editor.outline_loading") : t("editor.outline_wait")}</p>
              : symbols.length === 0 ? <p className="px-2 text-muted-foreground">{t("editor.outline_none")}</p>
                : symbols.map((symbol, index) => <SymbolRow key={`${symbol.name}:${index}`} symbol={symbol} depth={0} onReveal={props.onReveal} />)}
        </div>
      ) : null}
    </div>
  );
}
