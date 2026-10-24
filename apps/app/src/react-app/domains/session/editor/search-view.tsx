/** @jsxImportSource react */
/**
 * Search in files (Cmd/Ctrl+Shift+F in the IDE layout): text or regex, case,
 * whole word, files to include/exclude, results by file. Replace previews the
 * change on each match; replacing a match, a file or everything edits the open
 * documents (one undo step per file) and saves them like a user's own save.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronRight, Regex, Replace, ReplaceAll, WholeWord, X } from "lucide-react";

import type { OmniRushEditorSearchResult, OmniRushServerClient } from "@/app/lib/omnirush-server";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import type { EditorDocuments } from "./editor-models";
import { t } from "@/i18n";

type Flags = { regex: boolean; caseSensitive: boolean; wholeWord: boolean };

function matcher(query: string, flags: Flags): RegExp | null {
  if (!query) return null;
  const source = flags.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(flags.wholeWord ? `\\b(?:${source})\\b` : source, flags.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

/** A sticky copy of the search: it matches exactly at `lastIndex`, with the whole line as context (\b, lookarounds). */
function stickyMatcher(query: string, flags: Flags): RegExp | null {
  const re = matcher(query, flags);
  return re ? new RegExp(re.source, `${re.flags.replace("g", "")}y`) : null;
}

/**
 * The text that replaces the match at [start, end) of `line` ($1… groups in regex mode), or null when the
 * search no longer matches exactly there.
 */
export function replacementAt(line: string, start: number, end: number, replace: string, sticky: RegExp | null, regex: boolean): string | null {
  if (!sticky) return null;
  sticky.lastIndex = start;
  const found = sticky.exec(line);
  if (!found || found[0].length !== end - start) return null;
  if (!regex) return replace;
  sticky.lastIndex = start;
  const replaced = line.replace(sticky, replace);
  return replaced.slice(start, replaced.length - (line.length - end));
}

type Target = { path: string; line: number; start: number; end: number };

export function SearchView(props: {
  client: OmniRushServerClient;
  workspaceId: string;
  docs: EditorDocuments;
  sessionId: string | null;
  focusNonce: number;
  onOpen: (path: string, line: number, column: number, endColumn: number) => void;
  onSaved: () => void;
}) {
  const [query, setQuery] = useState("");
  const [replace, setReplace] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [flags, setFlags] = useState<Flags>({ regex: false, caseSensitive: false, wholeWord: false });
  const [result, setResult] = useState<OmniRushEditorSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rerun, setRerun] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, true>>({});
  const [dismissed, setDismissed] = useState<Record<string, true>>({});
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Next frame: the shortcut's keydown is still reaching the editor, which would take focus back.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.focusNonce]);

  // Search as you type (debounced); a new search cancels the one running.
  useEffect(() => {
    abortRef.current?.abort();
    setError(null);
    if (!query.trim()) {
      setResult(null);
      return;
    }
    if (flags.regex && !matcher(query, flags)) {
      setError("Not a valid regular expression.");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = window.setTimeout(() => {
      setBusy(true);
      props.client.editorSearch(props.workspaceId, {
        query,
        ...flags,
        include: include.split(",").map((item) => item.trim()).filter(Boolean),
        exclude: exclude.split(",").map((item) => item.trim()).filter(Boolean),
      }, controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setResult(next);
          setDismissed({});
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Search failed.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [exclude, flags, include, props.client, props.workspaceId, query, rerun]);

  const visible = useMemo(() => (result?.files ?? []).map((file) => ({
    path: file.path,
    matches: file.matches.filter((match, index) => !dismissed[`${file.path}:${index}`]).map((match) => ({ ...match, key: `${file.path}:${file.matches.indexOf(match)}` })),
  })).filter((file) => file.matches.length && !dismissed[file.path]), [dismissed, result]);
  const total = visible.reduce((sum, file) => sum + file.matches.length, 0);
  const previewMatcher = useMemo(() => stickyMatcher(query, flags), [flags, query]);

  /** Replaces the given matches: in each file's document (open or loaded now), one undo step per file, then saved. */
  const apply = async (targets: Target[]) => {
    const byFile = new Map<string, Target[]>();
    for (const target of targets) byFile.set(target.path, [...(byFile.get(target.path) ?? []), target]);
    let changed = 0;
    let failed = 0;
    let leftUnsaved = 0;
    const sticky = stickyMatcher(query, flags);
    for (const [path, list] of byFile) {
      const opened = await props.docs.open(path);
      if (!opened.ok) {
        failed += list.length;
        continue;
      }
      const model = opened.doc.model;
      // A file with unsaved changes of yours is edited but not saved (saving would also save your changes).
      const wasDirty = props.docs.isDirty(opened.doc);
      const edits: { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string }[] = [];
      for (const target of list) {
        if (target.line > model.getLineCount()) continue;
        // The file may have changed since the search: only a match that is still there is replaced.
        const text = replacementAt(model.getLineContent(target.line), target.start, target.end, replace, sticky, flags.regex);
        if (text === null) {
          failed += 1;
          continue;
        }
        edits.push({
          range: { startLineNumber: target.line, startColumn: target.start + 1, endLineNumber: target.line, endColumn: target.end + 1 },
          text,
        });
      }
      if (!edits.length) continue;
      model.pushEditOperations([], edits, () => null);
      if (wasDirty) {
        changed += edits.length;
        leftUnsaved += 1;
        continue;
      }
      const saved = await props.docs.save(path, { sessionId: props.sessionId, source: "editor" });
      if (saved.ok) changed += edits.length;
      else {
        failed += edits.length;
        toast.error(`${path}: ${saved.message}`);
      }
    }
    if (changed) {
      const unsaved = leftUnsaved ? ` ${leftUnsaved} file${leftUnsaved === 1 ? "" : "s"} with your unsaved changes ${leftUnsaved === 1 ? "was" : "were"} left unsaved.` : "";
      toast.success(`Replaced ${changed} match${changed === 1 ? "" : "es"}${failed ? `; ${failed} skipped` : ""}.${unsaved}`);
    }
    else if (failed) toast.error("Nothing replaced: the files changed since the search. Search again.");
    props.onSaved();
    setRerun((value) => value + 1);
  };

  const absoluteTarget = (path: string, match: { line: number; start: number; end: number; textOffset: number }): Target => ({
    path,
    line: match.line,
    start: match.start + match.textOffset,
    end: match.end + match.textOffset,
  });

  const replaceAll = () => {
    if (!total) return;
    setConfirming(true);
  };
  const confirmReplaceAll = () => {
    setConfirming(false);
    void apply(visible.flatMap((file) => file.matches.map((match) => absoluteTarget(file.path, match))));
  };

  const toggle = (key: keyof Flags, label: string, icon: React.ReactNode, shortcut: string) => (
    <button
      type="button"
      title={`${label} (${shortcut})`}
      aria-label={label}
      aria-pressed={flags[key]}
      onClick={() => setFlags((value) => ({ ...value, [key]: !value[key] }))}
      className={cn("flex size-5 items-center justify-center rounded [&_svg]:size-3.5", flags[key] ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}
    >
      {icon}
    </button>
  );
  const mac = /Mac/i.test(navigator.platform);

  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-editor-search>
      <ConfirmModal
        open={confirming}
        title={t("editor.replace_all_confirm")}
        message={`Replace ${total} match${total === 1 ? "" : "es"} in ${visible.length} file${visible.length === 1 ? "" : "s"} with "${replace}"? The files are saved; each one can be undone in the editor.`}
        confirmLabel={t("editor.replace_all")}
        cancelLabel="Cancel"
        onConfirm={confirmReplaceAll}
        onCancel={() => setConfirming(false)}
      />
      <div className="flex shrink-0 flex-col gap-1 p-2">
        <div className="flex items-start gap-1">
          <button
            type="button"
            aria-label={showReplace ? t("editor.hide_replace") : t("editor.show_replace")}
            onClick={() => setShowReplace((value) => !value)}
            className="mt-1 text-muted-foreground hover:text-foreground"
          >
            {showReplace ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex h-7 items-center gap-0.5 rounded-md border border-border bg-background pe-1 focus-within:ring-1 focus-within:ring-ring">
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
                aria-label={t("editor.search_in_files")}
                className="min-w-0 flex-1 bg-transparent px-2 outline-none placeholder:text-muted-foreground"
                onKeyDown={(event) => {
                  if (event.altKey && event.key.toLowerCase() === "c") setFlags((value) => ({ ...value, caseSensitive: !value.caseSensitive }));
                  if (event.altKey && event.key.toLowerCase() === "w") setFlags((value) => ({ ...value, wholeWord: !value.wholeWord }));
                  if (event.altKey && event.key.toLowerCase() === "r") setFlags((value) => ({ ...value, regex: !value.regex }));
                }}
              />
              {toggle("caseSensitive", t("editor.match_case"), <CaseSensitive />, mac ? "⌥C" : "Alt+C")}
              {toggle("wholeWord", t("editor.whole_word"), <WholeWord />, mac ? "⌥W" : "Alt+W")}
              {toggle("regex", t("editor.regex"), <Regex />, mac ? "⌥R" : "Alt+R")}
            </div>
            {showReplace ? (
              <div className="flex items-center gap-1">
                <input
                  value={replace}
                  onChange={(event) => setReplace(event.target.value)}
                  placeholder="Replace"
                  aria-label={t("editor.replace_with")}
                  className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <Button variant="ghost" size="icon-xs" aria-label={t("editor.replace_all")} title={t("editor.replace_all")} disabled={!total} onClick={replaceAll}>
                  <ReplaceAll />
                </Button>
              </div>
            ) : null}
          </div>
        </div>
        <button type="button" className="self-end text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setShowFilters((value) => !value)}>
          {showFilters ? t("editor.hide_file_filters") : t("editor.file_filters")}
        </button>
        {showFilters ? (
          <>
            <input value={include} onChange={(event) => setInclude(event.target.value)} placeholder="Files to include, e.g. src/**, *.ts" aria-label="Files to include" className="h-7 rounded-md border border-border bg-background px-2 outline-none" />
            <input value={exclude} onChange={(event) => setExclude(event.target.value)} placeholder="Files to exclude, e.g. **/*.test.ts" aria-label="Files to exclude" className="h-7 rounded-md border border-border bg-background px-2 outline-none" />
          </>
        ) : null}
        <p className="px-1 text-[11px] text-muted-foreground" data-editor-search-summary>
          {error ? <span className="text-destructive">{error}</span>
            : busy ? "Searching…"
              : result ? `${total} result${total === 1 ? "" : "s"} in ${visible.length} file${visible.length === 1 ? "" : "s"}${result.truncated ? " (first results only: narrow the search)" : ""}${result.timedOut ? " (stopped after 20 s)" : ""}${result.engine === "none" ? " (search needs ripgrep or a git repository)" : ""}`
                : ""}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2" role="tree" aria-label="Search results">
        {visible.map((file) => (
          <div key={file.path} role="treeitem" aria-expanded={!collapsed[file.path]} data-editor-search-file={file.path}>
            <div className="group flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-muted">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-start" onClick={() => setCollapsed((value) => {
                const next = { ...value };
                if (next[file.path]) delete next[file.path];
                else next[file.path] = true;
                return next;
              })}>
                {collapsed[file.path] ? <ChevronRight className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
                <span className="truncate font-medium">{file.path.split("/").pop()}</span>
                <span className="truncate text-[10.5px] text-muted-foreground">{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}</span>
              </button>
              <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground group-hover:hidden">{file.matches.length}</span>
              {showReplace ? (
                <button type="button" title="Replace in this file" aria-label={`Replace in ${file.path}`} className="hidden text-muted-foreground hover:text-foreground group-hover:block" onClick={() => void apply(file.matches.map((match) => absoluteTarget(file.path, match)))}>
                  <ReplaceAll className="size-3.5" />
                </button>
              ) : null}
              <button type="button" title="Dismiss" aria-label={`Dismiss ${file.path}`} className="hidden text-muted-foreground hover:text-foreground group-hover:block" onClick={() => setDismissed((value) => ({ ...value, [file.path]: true }))}>
                <X className="size-3.5" />
              </button>
            </div>
            {collapsed[file.path] ? null : file.matches.map((match) => {
              const before = match.text.slice(0, match.start);
              const hit = match.text.slice(match.start, match.end);
              const after = match.text.slice(match.end);
              return (
                <div key={match.key} className="group flex items-center gap-1 rounded-md py-0.5 ps-5 pe-1 hover:bg-muted" data-editor-search-match>
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-start font-mono text-[11.5px]"
                    title={`Line ${match.line}`}
                    onClick={() => props.onOpen(file.path, match.line, match.start + match.textOffset + 1, match.end + match.textOffset + 1)}
                  >
                    <span className="text-muted-foreground">{before.trimStart().slice(-40)}</span>
                    {showReplace && replace !== undefined ? (
                      <>
                        <span className="bg-red-3 text-red-11 line-through dark:bg-red-5/40">{hit}</span>
                        <span className="bg-green-3 text-green-11 dark:bg-green-5/40">{replacementAt(match.text, match.start, match.end, replace, previewMatcher, flags.regex) ?? replace}</span>
                      </>
                    ) : (
                      <span className="rounded-sm bg-amber-4 text-foreground dark:bg-amber-6/60">{hit}</span>
                    )}
                    <span className="text-muted-foreground">{after.slice(0, 80)}</span>
                  </button>
                  {showReplace ? (
                    <button type="button" title="Replace" aria-label="Replace this match" className="hidden text-muted-foreground hover:text-foreground group-hover:block" onClick={() => void apply([absoluteTarget(file.path, match)])}>
                      <Replace className="size-3.5" />
                    </button>
                  ) : null}
                  <button type="button" title="Dismiss" aria-label="Dismiss this match" className="hidden text-muted-foreground hover:text-foreground group-hover:block" onClick={() => setDismissed((value) => ({ ...value, [match.key]: true }))}>
                    <X className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
