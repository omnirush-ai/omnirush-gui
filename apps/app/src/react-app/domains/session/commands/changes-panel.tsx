/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Columns2, FileDiff, ListChecks, RefreshCw, Rows3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { unwrap } from "@/app/lib/opencode";
import { cn } from "@/lib/utils";
import type { OmniRushSessionSnapshot } from "@/app/lib/omnirush-server";
import { snapshotKey, statusKey } from "@/react-app/domains/session/sync/session-sync";
import {
  CHANGES_EMPTY,
  CHANGES_SOURCE_LABEL,
  changeTotals,
  mergeTurnChanges,
  normalizeChanges,
  MAX_DIFF_LINES,
  patchLineCount,
  patchLines,
  splitRows,
  type ChangedFile,
  type ChangesSource,
  type PatchLine,
} from "./changes";
import { useSessionCommandBridge, useSessionCommandsStore } from "./session-commands-store";
import { latestUserMessageId, useCachedQueryData, useOpencodeClient, type SessionCommandTarget } from "./use-session-commands";
import { turnUserMessageIds } from "./turn-messages";

const SOURCES: ChangesSource[] = ["chat", "turn", "tree"];

const STATUS_BADGE: Record<ChangedFile["status"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
};

type DiffLayout = "unified" | "split";
const LAYOUT_KEY = "omnirush.changes.layout";

function readLayout(): DiffLayout {
  try {
    return window.localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

const SIDE_TONE: Record<PatchLine["kind"], string | false> = {
  add: "bg-green-3/40 text-green-11",
  del: "bg-red-3/40 text-red-11",
  hunk: false,
  context: false,
  meta: false,
};

/** One side of a side-by-side row; an empty side is shaded so a pure addition or removal reads at a glance. */
function SplitCell({ line, side }: { line: PatchLine | null; side: "old" | "new" }) {
  if (!line) return <div className="min-w-0 bg-muted/40" />;
  const number = side === "old" ? line.oldLine : line.newLine;
  return (
    <div className={cn("flex min-w-0", SIDE_TONE[line.kind])}>
      <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/70">{number ?? ""}</span>
      <span className="w-3 shrink-0 select-none">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}</span>
      <span className="min-w-0 whitespace-pre-wrap break-all pr-3">{line.text || " "}</span>
    </div>
  );
}

function SplitLines({ lines }: { lines: readonly PatchLine[] }) {
  const rows = useMemo(() => splitRows(lines), [lines]);
  return (
    <>
      {rows.map((row, index) =>
        row.kind === "line" ? (
          <div key={index} className="grid grid-cols-2 divide-x divide-border/60">
            <SplitCell line={row.left} side="old" />
            <SplitCell line={row.right} side="new" />
          </div>
        ) : (
          <div key={index} className={cn("px-3 whitespace-pre", row.kind === "hunk" ? "bg-blue-2/40 text-blue-11" : "text-muted-foreground")}>{row.text}</div>
        ),
      )}
    </>
  );
}

function DiffBody({ patch, layout }: { patch: string; layout: DiffLayout }) {
  const [showAll, setShowAll] = useState(false);
  const all = useMemo(() => patchLines(patch), [patch]);
  const lines = useMemo(() => (showAll ? all : all.slice(0, MAX_DIFF_LINES)), [all, showAll]);
  if (!lines.length) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">No line changes to show (a binary file, or only its mode changed).</div>;
  }
  return (
    <div className="max-h-[60vh] overflow-auto border-t border-border font-mono text-[11.5px] leading-[1.55]" data-testid="changes-diff" data-layout={layout}>
      {layout === "split" ? <SplitLines lines={lines} /> : lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            "flex min-w-max",
            line.kind === "add" && "bg-green-3/40 text-green-11",
            line.kind === "del" && "bg-red-3/40 text-red-11",
            line.kind === "hunk" && "bg-blue-2/40 text-blue-11",
            line.kind === "meta" && "text-muted-foreground",
          )}
        >
          <span className="w-10 shrink-0 select-none pr-1 text-right text-muted-foreground/70">{line.oldLine ?? ""}</span>
          <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/70">{line.newLine ?? ""}</span>
          <span className="w-3 shrink-0 select-none">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}</span>
          <span className="whitespace-pre pr-4">{line.kind === "hunk" ? line.text : line.text || " "}</span>
        </div>
      ))}
      {lines.length < all.length ? (
        <div className="sticky left-0 px-3 py-2">
          <Button size="sm" variant="secondary" data-testid="changes-show-all" onClick={() => setShowAll(true)}>
            Show all {all.length.toLocaleString("en-US")} lines
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FileRow({ file, defaultOpen, layout }: { file: ChangedFile; defaultOpen: boolean; layout: DiffLayout }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background/60" data-testid="changes-file" data-path={file.path}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-muted/60"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold",
            file.status === "added" && "bg-green-4 text-green-11",
            file.status === "deleted" && "bg-red-4 text-red-11",
            file.status === "modified" && "bg-amber-4 text-warning",
          )}
          title={file.status}
        >
          {STATUS_BADGE[file.status]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>{file.path}</span>
        <span className="shrink-0 font-mono text-[11.5px] text-green-11">+{file.additions}</span>
        <span className="shrink-0 font-mono text-[11.5px] text-red-11">-{file.deletions}</span>
      </button>
      {open ? <DiffBody patch={file.patch} layout={layout} /> : null}
    </div>
  );
}

/**
 * The Changes panel: the files this chat changed (or its last turn, or the
 * whole working tree), with +/- counts and each file's diff, and a Review
 * button that asks the agent to review them in the chat.
 */
/** Side by side needs room for two columns of code: on a narrow window the diff is unified (and no toggle shows). */
const SPLIT_MEDIA_QUERY = "(min-width: 800px)";
function useSplitFits(): boolean {
  const [fits, setFits] = useState(() => (typeof window === "undefined" ? true : window.matchMedia(SPLIT_MEDIA_QUERY).matches));
  useEffect(() => {
    const query = window.matchMedia(SPLIT_MEDIA_QUERY);
    const onChange = () => setFits(query.matches);
    query.addEventListener("change", onChange);
    onChange();
    return () => query.removeEventListener("change", onChange);
  }, []);
  return fits;
}

export function ChangesPanel(props: SessionCommandTarget) {
  const openFor = useSessionCommandsStore((state) => state.changesOpenFor);
  const closeChanges = useSessionCommandsStore((state) => state.closeChanges);
  const turnId = useSessionCommandsStore((state) => state.changesTurn);
  const [chosen, setLayout] = useState<DiffLayout>(readLayout);
  const splitFits = useSplitFits();
  const layout: DiffLayout = splitFits ? chosen : "unified";
  const open = openFor === props.sessionId;
  const chooseLayout = (next: DiffLayout) => {
    setLayout(next);
    try {
      window.localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // Not remembered; the choice still applies now.
    }
  };
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) closeChanges(); }}>
      <SheetContent
        side="right"
        className={cn(
          "gap-0",
          layout === "split" ? "w-[min(1280px,96vw)] data-[side=right]:sm:max-w-[1280px]" : "w-[min(720px,92vw)] data-[side=right]:sm:max-w-[720px]",
        )}
        data-testid="changes-panel"
      >
        {open ? <ChangesBody key={turnId ?? "last"} {...props} turnId={turnId} layout={layout} onLayout={splitFits ? chooseLayout : null} onClose={closeChanges} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function ChangesBody(props: SessionCommandTarget & {
  turnId: string | null;
  layout: DiffLayout;
  /** Null: no choice (the window is too narrow for side by side). */
  onLayout: ((layout: DiffLayout) => void) | null;
  onClose: () => void;
}) {
  const client = useOpencodeClient(props);
  const bridge = useSessionCommandBridge(props.sessionId);
  // Opened from a reply's "Changes in this turn": that turn first.
  const [source, setSource] = useState<ChangesSource>(props.turnId ? "turn" : "chat");
  const snapshot = useCachedQueryData<OmniRushSessionSnapshot>(snapshotKey(props.workspaceId, props.sessionId));
  const status = useCachedQueryData<{ type: string }>(statusKey(props.workspaceId, props.sessionId));
  const lastUserId = props.turnId ?? latestUserMessageId(snapshot?.session.id === props.sessionId ? snapshot : null);
  const revertId = snapshot?.session.revert?.messageID ?? null;
  const running = (status?.type ?? "idle") !== "idle";
  // The whole turn: the person's prompt and the user messages a compaction added in it (turn-messages.ts).
  const turnIds = useMemo(() => {
    if (!lastUserId) return [];
    const ids = turnUserMessageIds(snapshot?.session.id === props.sessionId ? snapshot.messages : [], lastUserId);
    return ids.length ? ids : [lastUserId];
  }, [snapshot, props.sessionId, lastUserId]);

  const query = useQuery({
    queryKey: ["session-commands-changes", props.workspaceId, props.sessionId, source, source === "turn" ? turnIds.join(",") : null, revertId],
    queryFn: async () => {
      if (source === "tree") {
        return normalizeChanges(unwrap(await client.vcs.diff({ mode: "git", directory: props.workspaceRoot || undefined })));
      }
      if (source === "turn") {
        if (!lastUserId) return [];
        const parts = await Promise.all(turnIds.map(async (messageID) =>
          normalizeChanges(unwrap(await client.session.diff({ sessionID: props.sessionId, messageID })))));
        return mergeTurnChanges(parts);
      }
      return normalizeChanges(unwrap(await client.session.diff({ sessionID: props.sessionId })));
    },
    staleTime: 2_000,
    retry: false,
  });

  // A turn that ends changes what this lists.
  const { refetch } = query;
  useEffect(() => {
    if (!running) void refetch();
  }, [running, refetch]);

  const files = query.data ?? [];
  const totals = changeTotals(files);
  const reviewDisabled = !bridge || bridge.busy || running;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader className="gap-3 border-b border-border p-4 pr-14">
        <div className="flex items-center gap-2">
          <FileDiff className="size-4 text-muted-foreground" />
          <SheetTitle>Changes</SheetTitle>
          <span className="text-xs text-muted-foreground" data-testid="changes-totals">
            {query.isSuccess
              ? `${totals.files} ${totals.files === 1 ? "file" : "files"} · +${totals.additions} -${totals.deletions}`
              : ""}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh"
              title="Refresh"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={cn("size-3.5", query.isFetching && "animate-spin")} />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid="changes-review"
              disabled={reviewDisabled}
              title={running ? "Wait for the agent to finish first" : "Ask the agent to review the project's uncommitted changes (the whole working tree)"}
              onClick={() => {
                if (!bridge) return;
                void bridge.runCommand("/review");
                props.onClose();
              }}
            >
              <ListChecks className="size-3.5" />
              Review
            </Button>
          </div>
        </div>
        <SheetDescription className="sr-only">The files this chat changed and their diffs.</SheetDescription>
        <div className="flex flex-wrap items-center gap-2">
        <div className="flex w-fit items-center gap-0.5 rounded-lg bg-muted p-0.5" role="tablist" aria-label="Changes source">
          {SOURCES.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={source === item}
              data-testid={`changes-source-${item}`}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                source === item && "bg-background text-foreground shadow-sm",
              )}
              onClick={() => setSource(item)}
            >
              {item === "turn" && props.turnId ? "This turn" : CHANGES_SOURCE_LABEL[item]}
            </button>
          ))}
        </div>
        {props.onLayout ? <div className="ml-auto flex w-fit items-center gap-0.5 rounded-lg bg-muted p-0.5" role="radiogroup" aria-label="Diff layout">
          {([["unified", Rows3, "Unified"], ["split", Columns2, "Side by side"]] as const).map(([value, Icon, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={props.layout === value}
              data-testid={`changes-layout-${value}`}
              className={cn(
                "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                props.layout === value && "bg-background text-foreground shadow-sm",
              )}
              onClick={() => props.onLayout?.(value)}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div> : null}
        </div>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {query.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading changes…</div>
        ) : query.isError ? (
          <div className="text-sm text-muted-foreground" data-testid="changes-error">
            {source === "tree"
              ? "The working tree's changes could not be read (is this folder a git repository?)."
              : "The changes could not be read."}
          </div>
        ) : files.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-testid="changes-empty">
            {source === "turn" && props.turnId ? "This turn changed no files." : CHANGES_EMPTY[source]}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {files.map((file) => (
              <FileRow key={`${source}:${file.path}`} file={file} layout={props.layout} defaultOpen={files.length <= 3 && patchLineCount(file.patch) <= MAX_DIFF_LINES} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
