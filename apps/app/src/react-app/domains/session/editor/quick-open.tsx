/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText } from "lucide-react";

import { cn } from "@/lib/utils";
import { rankPaths } from "./quick-open-rank";
import { t } from "@/i18n";

type QuickOpenProps = {
  files: readonly string[];
  recent: readonly string[];
  /** `side`: Cmd/Ctrl+Enter, open in the other editor group. */
  onOpen: (path: string, side?: boolean) => void;
  onClose: () => void;
};

const LIMIT = 60;

/** Cmd/Ctrl+P: type part of a file name, arrows to move, Enter to open (Cmd/Ctrl+Enter: in the other group), Esc to close. */
export function QuickOpen({ files, recent, onOpen, onClose }: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const results = useMemo(() => {
    if (!query.trim()) {
      const known = new Set(files);
      const first = recent.filter((path) => known.has(path));
      const rest = files.filter((path) => !first.includes(path));
      return [...first, ...rest].slice(0, LIMIT);
    }
    return rankPaths(files, query, LIMIT);
  }, [files, recent, query]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div
      className="absolute inset-0 z-30 flex justify-center bg-black/10 pt-14 dark:bg-black/30"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      data-editor-quick-open
    >
      <div className="flex h-fit max-h-[70%] w-[min(560px,92%)] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((value) => Math.min(value + 1, Math.max(0, results.length - 1)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((value) => Math.max(value - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const path = results[index];
              if (path) onOpen(path, event.metaKey || event.ctrlKey);
            }
          }}
          placeholder={t("editor.go_to_file_placeholder")}
          aria-label={t("editor.go_to_file")}
          className="h-11 w-full border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div ref={listRef} role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
          {results.length === 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">No matching files.</p>
          ) : results.map((path, i) => {
            const slash = path.lastIndexOf("/");
            return (
              <button
                key={path}
                type="button"
                role="option"
                aria-selected={i === index}
                data-index={i}
                onMouseEnter={() => setIndex(i)}
                onClick={() => onOpen(path)}
                className={cn(
                  "flex w-full items-center gap-2 px-4 py-1.5 text-start text-[12.5px]",
                  i === index ? "bg-primary/10 text-foreground" : "text-foreground/90",
                )}
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{path.slice(slash + 1)}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{slash > 0 ? path.slice(0, slash) : ""}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
