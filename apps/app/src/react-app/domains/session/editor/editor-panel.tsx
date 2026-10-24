/** @jsxImportSource react */
/**
 * The desktop editor beside the chat: file tree, tabs, Monaco, the agent's
 * changes for review (accept/reject per hunk), a git panel, quick open and
 * the integrated terminal. Loaded lazily (editor-entry.tsx) so the chat
 * never pays for Monaco until the editor is opened.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleDot,
  FileCode2,
  FileDiff,
  Files,
  GitBranch,
  GitCommitHorizontal,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  CircleX,
  AlertTriangle,
  SquareTerminal,
  Undo2,
  X,
  Columns2,
  Eye,
} from "lucide-react";

import type { Client } from "@/app/types";
import type * as MonacoApi from "monaco-editor/editor/editor.api.js";
import type { OmniRushEditorGitFile, OmniRushEditorGitStatus, OmniRushServerClient } from "@/app/lib/omnirush-server";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { onFilesRewound } from "@/app/lib/files-rewound";
import { editorDocuments, type EditorDocuments, type FileDoc } from "./editor-models";
import { editorWorkspaceState, tabId, useEditorStore, type EditorSideView, type EditorTab, type ReviewScope } from "./editor-store";
import { EditorSurface, type SurfaceDoc } from "./editor-surface";
import { acceptHunk, hunkCounts, rejectHunk, type LineHunk } from "./hunk-ops";
import { languageForPath, setupMonaco, type Monaco } from "./monaco";
import { QuickOpen } from "./quick-open";
import { SearchView } from "./search-view";
import { ProblemsView } from "./problems-view";
import { OutlineView } from "./outline-view";
import { codeChipText, lineLabel, sendToChat } from "./chat-context";
import {
  activateLsp,
  activateLspForModel,
  clearLanguageFeatures,
  documentSymbols,
  installLanguageFeatures,
  problemCounts,
  refreshAllDiagnostics,
  refreshFileDiagnostics,
  setLanguageContext,
  setLspSessionBusy,
  symbolPath,
  useIsLspActive,
  useProblemsStore,
  type LspDiagnostic,
} from "./lsp";
import type { AgentAction, SurfaceHandle } from "./editor-surface";
import { baselinesForTurns, turnFileChange, type TurnFileChange } from "./review";
import "./editor.css";
import { AUTO_SAVE_DELAY_MS, useEditorSettings } from "./editor-settings";
import { GitGutter } from "./git-gutter";
import { Group2Editor } from "./group2-editor";
import { ImageView, isImagePath } from "./image-view";
import { MarkdownPreview } from "./markdown-preview";
import { openDesktopUrl } from "@/app/lib/desktop";
import { useGroupRef } from "react-resizable-panels";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** What the main group shows: a text file or diff (Monaco), a Markdown preview, or an image. */
type PanelSurface = SurfaceDoc | { kind: "preview"; key: string; doc: FileDoc } | { kind: "image"; key: string; path: string };
/** Each editor group needs this much width; below twice this the split folds away. */
const MIN_GROUP_PX = 320;
const isMarkdownPath = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

/** How long a file stays the active one before its language features start. */
const LSP_DWELL_MS = 2500;

export type EditorPanelProps = {
  client: OmniRushServerClient;
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string | null;
  sessionBusy: boolean;
  /** Some chat's agent is working (the language servers are shared by every chat): no unsaved text goes to them. */
  agentBusy: boolean;
  opencodeClient: Client | null;
  terminal: ReactNode | null;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  /** IDE layout slots: the header's left (mode toggle, workspace switch) and right (chat panel button), and the rail's foot (app destinations). */
  headerStart?: ReactNode;
  headerEnd?: ReactNode;
  railFoot?: ReactNode;
};

const MAX_REVIEW_FILES = 60;
const MAX_REVIEW_TURNS = 30;
const EMPTY_FILES: string[] = [];

type ReviewFile = TurnFileChange & {
  /** The file before the reviewed turns; null when the turns created it; undefined when it could not be worked out. */
  baseline: string | null | undefined;
  /** The file on disk when the review loaded (null: not there), for files without an open document. */
  current: string | null;
};

type ReviewData = { key: string; turns: number; files: ReviewFile[] };

/** The engine's per-turn changes for the chat, oldest first, with each file's text before them. */
async function loadAgentChanges(input: {
  opencodeClient: Client;
  sessionId: string;
  directory: string;
  scope: ReviewScope;
  docs: EditorDocuments;
  workspaceRoot: string;
}): Promise<ReviewData> {
  const { opencodeClient, sessionId, directory, scope, docs } = input;
  const messagesResult = await opencodeClient.session.messages({ sessionID: sessionId, directory });
  if (messagesResult.error) throw new Error("Could not load this chat's changes. Try Refresh changes.");
  const messages = (messagesResult.data ?? []) as Array<{ info: { id: string; role: string } }>;
  const userIds = messages.filter((message) => message.info.role === "user").map((message) => message.info.id);
  const root = input.workspaceRoot.replace(/[/\\]+$/, "").replace(/\\/g, "/");
  const relativeChange = (change: TurnFileChange): TurnFileChange | null => {
    let path = change.path;
    if (root && path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
    if (/^([A-Za-z]:)?\//.test(path) || path.split("/").includes("..")) return null;
    return { ...change, path };
  };
  const turns: TurnFileChange[][] = [];
  const turnIds: string[] = [];
  // Newest first until the scope is filled: the last turn that changed files, or every turn of the chat.
  for (const id of [...userIds].reverse().slice(0, MAX_REVIEW_TURNS)) {
    const result = await opencodeClient.session.diff({ sessionID: sessionId, messageID: id, directory });
    if (result.error) throw new Error("Could not load this turn's file changes. Try Refresh changes.");
    const changes = ((result.data ?? []) as unknown[])
      .map(turnFileChange)
      .filter((change): change is TurnFileChange => change !== null)
      .map(relativeChange)
      .filter((change): change is TurnFileChange => change !== null);
    if (changes.length === 0) continue;
    turns.unshift(changes);
    turnIds.unshift(id);
    if (scope === "turn") break;
  }
  const paths = [...new Set(turns.flat().map((change) => change.path))].slice(0, MAX_REVIEW_FILES);
  // "Before" is worked out from the text on disk, never from an open buffer (it may hold unsaved
  // edits, or the text from before the turn until it refreshes).
  const current = new Map<string, string | null>();
  const unreadable = new Set<string>();
  await Promise.all(paths.map(async (path) => {
    try {
      const file = await docs.client.editorReadFile(docs.workspaceId, path);
      if (file.content === null) unreadable.add(path);
      else current.set(path, file.content);
    } catch (error) {
      if ((error as { status?: number }).status === 404) current.set(path, null);
      else unreadable.add(path);
    }
  }));
  await docs.refresh(paths.filter((path) => docs.get(path)));
  const baselines = baselinesForTurns(turns, (path) => current.get(path) ?? null);
  // Binary or very large files are listed without a review diff.
  for (const path of unreadable) baselines.set(path, undefined);
  const merged = new Map<string, ReviewFile>();
  for (const turn of turns) {
    for (const change of turn) {
      if (!paths.includes(change.path)) continue;
      const previous = merged.get(change.path);
      const status = previous?.status === "added" && change.status !== "deleted" ? "added" : change.status;
      merged.set(change.path, {
        ...change,
        status,
        additions: (previous?.additions ?? 0) + change.additions,
        deletions: (previous?.deletions ?? 0) + change.deletions,
        baseline: baselines.get(change.path),
        current: current.get(change.path) ?? null,
      });
    }
  }
  return { key: `${sessionId}:${scope}:${turnIds.join(",")}`, turns: turns.length, files: [...merged.values()] };
}

const REVIEWED_KEY = "omnirush:editor:reviewed:v1";
const MAX_REVIEWED = 500;

function textHash(text: string): string {
  // FNV-1a, 32 bit, with the length: enough to tell "the text that was reviewed" from an edit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}.${hash.toString(36)}`;
}

function readReviewed(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(REVIEWED_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function isReviewed(reviewKey: string, path: string, text: string): boolean {
  return readReviewed()[`${reviewKey}|${path}`] === textHash(text);
}

function markReviewed(reviewKey: string, path: string, text: string): void {
  const all = readReviewed();
  const key = `${reviewKey}|${path}`;
  const hash = textHash(text);
  if (all[key] === hash) return;
  delete all[key];
  all[key] = hash;
  const keys = Object.keys(all);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_REVIEWED))) delete all[old];
  try {
    localStorage.setItem(REVIEWED_KEY, JSON.stringify(all));
  } catch {
    // Storage full: the review just shows again after a restart.
  }
}

function gitBadge(file: OmniRushEditorGitFile, staged: boolean): string {
  const letter = staged ? file.index : file.worktree;
  return letter === "?" ? "U" : letter;
}

function treeGitStatus(status: OmniRushEditorGitStatus | undefined) {
  if (!status?.repo) return [];
  return status.files.map((file) => {
    const letter = file.worktree !== " " ? file.worktree : file.index;
    const kind = letter === "?" ? "untracked" : letter === "A" ? "added" : letter === "D" ? "deleted" : letter === "R" ? "renamed" : "modified";
    return { path: file.path, status: kind as "untracked" | "added" | "deleted" | "renamed" | "modified" };
  });
}

const TREE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 11%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 6%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

function FilesView(props: {
  files: string[];
  truncated: boolean;
  git: OmniRushEditorGitStatus | undefined;
  selected: string | null;
  loading: boolean;
  error: boolean;
  onOpen: (path: string) => void;
  onRefresh: () => void;
}) {
  const onOpenRef = useRef(props.onOpen);
  onOpenRef.current = props.onOpen;
  const fileSet = useMemo(() => new Set(props.files), [props.files]);
  const fileSetRef = useRef(fileSet);
  fileSetRef.current = fileSet;
  // Selecting the shown file in the tree (below) is not the user opening it (a preview tab shows the same path).
  const programmatic = useRef(false);
  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    onSelectionChange: (paths) => {
      if (programmatic.current) return;
      const path = paths.at(-1);
      if (path && fileSetRef.current.has(path)) onOpenRef.current(path);
    },
    paths: [],
    search: false,
    unsafeCSS: TREE_CSS,
  });
  const search = useFileTreeSearch(model);
  useEffect(() => {
    model.resetPaths(props.files);
  }, [model, props.files]);
  useEffect(() => {
    model.setGitStatus(treeGitStatus(props.git));
  }, [model, props.git, props.files]);
  useEffect(() => {
    if (!props.selected) return;
    const item = model.getItem(props.selected);
    if (!item) return;
    programmatic.current = true;
    try {
      for (const path of model.getSelectedPaths()) if (path !== props.selected) model.getItem(path)?.deselect();
      item.select();
    } finally {
      programmatic.current = false;
    }
  }, [model, props.files, props.selected]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-editor-files={props.files.length}>
      <div className="flex h-9 shrink-0 items-center gap-1 px-1.5">
        <InputGroup className="h-7 min-w-0 flex-1 bg-background">
          <InputGroupAddon align="inline-start"><Search /></InputGroupAddon>
          <InputGroupInput
            aria-label="Filter files"
            placeholder="Filter files"
            value={search.value}
            onChange={(event) => {
              const value = event.target.value;
              if (value.trim()) search.setValue(value);
              else search.close();
            }}
          />
        </InputGroup>
        <Button variant="ghost" size="icon-xs" aria-label="Refresh files" onClick={props.onRefresh}>
          <RefreshCw className={cn(props.loading && "animate-spin")} />
        </Button>
      </div>
      {props.error ? (
        <p className="p-3 text-xs text-destructive">Could not list this folder.</p>
      ) : (
        <FileTree
          model={model}
          aria-label="Project files"
          className="min-h-0 flex-1 overflow-hidden"
          style={{ ["--trees-fg-override" as string]: "var(--foreground)" }}
        />
      )}
      {props.truncated ? (
        <p className="border-t border-border px-2 py-1 text-[10px] text-muted-foreground">Showing the first 200,000 files.</p>
      ) : null}
    </div>
  );
}

function ChangesView(props: {
  data: ReviewData | undefined;
  loading: boolean;
  error: string | null;
  scope: ReviewScope;
  available: boolean;
  pending: (file: ReviewFile) => boolean;
  selected: string | null;
  onScope: (scope: ReviewScope) => void;
  onOpen: (file: ReviewFile) => void;
  onAcceptAll: (files: ReviewFile[]) => void;
  onRejectAll: (files: ReviewFile[]) => void;
  onRefresh: () => void;
}) {
  const files = props.data?.files ?? [];
  const pending = files.filter((file) => file.baseline !== undefined && props.pending(file));
  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-editor-changes={files.length}>
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <div className="flex rounded-lg bg-muted p-0.5">
          {(["turn", "chat"] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              onClick={() => props.onScope(scope)}
              className={cn("whitespace-nowrap rounded-md px-1.5 py-0.5", props.scope === scope ? "bg-background text-foreground shadow-sm" : "text-muted-foreground")}
            >
              {scope === "turn" ? "Last turn" : "All turns"}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <Button variant="ghost" size="icon-xs" aria-label="Refresh changes" onClick={props.onRefresh}>
          <RefreshCw className={cn(props.loading && "animate-spin")} />
        </Button>
      </div>
      {!props.available ? (
        <p className="px-3 py-2 text-muted-foreground">Open a chat to review the agent's changes.</p>
      ) : props.error ? (
        <p className="px-3 py-2 text-destructive">{props.error}</p>
      ) : props.loading && !props.data ? (
        <p className="px-3 py-2 text-muted-foreground">Loading changes…</p>
      ) : files.length === 0 ? (
        <p className="px-3 py-2 text-muted-foreground">The agent has not changed any files in this chat yet.</p>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-1">
            {files.map((file) => {
              const isPending = file.baseline !== undefined && props.pending(file);
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => props.onOpen(file)}
                  data-editor-change={file.path}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-muted",
                    props.selected === file.path && "bg-muted",
                  )}
                  title={file.baseline === undefined ? "Changed again since the agent's turn: shown without a review diff" : file.path}
                >
                  {isPending ? <CircleDot className="size-3 shrink-0 text-link" /> : <Check className="size-3 shrink-0 text-muted-foreground" />}
                  <span className={cn("min-w-0 flex-1 truncate", !isPending && "text-muted-foreground")}>
                    {file.path.split("/").pop()}
                    <span className="ms-1.5 text-[10.5px] text-muted-foreground">{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-red-600 dark:text-red-400">−{file.deletions}</span>
                </button>
              );
            })}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 border-t border-border p-2">
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-muted-foreground">{pending.length ? `${pending.length} left` : "Done"}</span>
            <Button size="xs" disabled={pending.length === 0} onClick={() => props.onAcceptAll(pending)}>Accept all</Button>
            <Button size="xs" variant="outline" disabled={pending.length === 0} onClick={() => props.onRejectAll(pending)}>Reject all</Button>
          </div>
        </>
      )}
    </div>
  );
}

function GitView(props: {
  status: OmniRushEditorGitStatus | undefined;
  loading: boolean;
  error: string | null;
  busy: boolean;
  selected: string | null;
  onOpen: (file: OmniRushEditorGitFile, staged: boolean) => void;
  onStage: (paths: string[], stage: boolean) => void;
  onCommit: (message: string) => Promise<boolean>;
  onRefresh: () => void;
}) {
  const [message, setMessage] = useState("");
  const status = props.status;
  const staged = status?.files.filter((file) => file.index !== " " && file.index !== "?") ?? [];
  const unstaged = status?.files.filter((file) => file.worktree !== " ") ?? [];
  const commit = async () => {
    if (!message.trim() || staged.length === 0) return;
    if (await props.onCommit(message)) setMessage("");
  };
  const row = (file: OmniRushEditorGitFile, isStaged: boolean) => (
    <div
      key={`${isStaged ? "s" : "u"}:${file.path}`}
      className={cn("group flex items-center gap-1.5 rounded-md px-2 py-0.5 hover:bg-muted", props.selected === file.path && "bg-muted")}
      data-editor-git-file={file.path}
      data-editor-git-staged={isStaged ? "1" : "0"}
    >
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-start" onClick={() => props.onOpen(file, isStaged)}>
        <span className="min-w-0 truncate">{file.path.split("/").pop()}</span>
        <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}</span>
      </button>
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-60 group-hover:opacity-100"
              aria-label={isStaged ? `Unstage ${file.path}` : `Stage ${file.path}`}
              disabled={props.busy}
              onClick={() => props.onStage(isStaged && file.from ? [file.path, file.from] : [file.path], !isStaged)}
            >
              {isStaged ? <Minus /> : <Plus />}
            </Button>
          )}
        />
        <TooltipContent>{isStaged ? "Unstage" : "Stage"}</TooltipContent>
      </Tooltip>
      <span className={cn(
        "w-3 shrink-0 text-center font-mono text-[10.5px]",
        gitBadge(file, isStaged) === "U" || gitBadge(file, isStaged) === "A" ? "text-emerald-600 dark:text-emerald-400" : gitBadge(file, isStaged) === "D" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400",
      )}>
        {gitBadge(file, isStaged)}
      </span>
    </div>
  );
  if (props.error) return <p className="p-3 text-xs text-destructive">{props.error}</p>;
  if (!status) return <p className="p-3 text-xs text-muted-foreground">{props.loading ? "Reading git status…" : ""}</p>;
  if (!status.repo) return <p className="p-3 text-xs text-muted-foreground">This folder is not a git repository.</p>;
  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-editor-git>
      <div className="flex h-9 shrink-0 items-center gap-1.5 px-2">
        <GitBranch className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium" data-editor-branch>{status.branch ?? "detached HEAD"}</span>
        {status.ahead || status.behind ? <span className="text-muted-foreground">↑{status.ahead} ↓{status.behind}</span> : null}
        <Button variant="ghost" size="icon-xs" aria-label="Refresh git status" onClick={props.onRefresh}>
          <RefreshCw className={cn(props.loading && "animate-spin")} />
        </Button>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 px-2 pb-2">
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void commit();
            }
          }}
          placeholder={staged.length ? "Commit message (Cmd/Ctrl+Enter)" : "Stage changes to commit"}
          aria-label="Commit message"
          rows={2}
          className="w-full resize-none rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button size="xs" disabled={props.busy || staged.length === 0 || !message.trim()} onClick={() => void commit()}>
          <GitCommitHorizontal /> Commit {staged.length ? `${staged.length} file${staged.length === 1 ? "" : "s"}` : ""}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        <div className="flex items-center px-2 pt-1 pb-0.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
          <span className="flex-1">Staged ({staged.length})</span>
          {staged.length ? <button type="button" className="hover:text-foreground" onClick={() => props.onStage(staged.flatMap((file) => (file.from ? [file.path, file.from] : [file.path])), false)}>Unstage all</button> : null}
        </div>
        {staged.map((file) => row(file, true))}
        <div className="flex items-center px-2 pt-2 pb-0.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
          <span className="flex-1">Changes ({unstaged.length})</span>
          {unstaged.length ? <button type="button" className="hover:text-foreground" onClick={() => props.onStage(unstaged.map((file) => file.path), true)}>Stage all</button> : null}
        </div>
        {unstaged.map((file) => row(file, false))}
        {staged.length === 0 && unstaged.length === 0 ? <p className="px-2 py-1 text-muted-foreground">No changes.</p> : null}
      </div>
    </div>
  );
}

/**
 * A file with unsaved changes changed on disk (an undo, the agent, another
 * program): Reload (the disk text) is the first choice; Overwrite writes
 * the editor's text over it.
 */
function showConflict(path: string, input: { reload: () => void; overwrite: () => void; reason: "save" | "undo" }) {
  const message = input.reason === "undo"
    ? `${path} changed on disk (undo or redo). Your unsaved changes are still in the editor.`
    : `${path} changed on disk since you opened it.`;
  toast.warning(message, {
    id: `editor-conflict:${path}`,
    duration: 20_000,
    action: { label: "Reload", onClick: input.reload },
    cancel: { label: "Overwrite", onClick: input.overwrite },
  });
}

export default function EditorPanel(props: EditorPanelProps) {
  const { client, workspaceId, workspaceRoot, sessionId, sessionBusy, agentBusy, opencodeClient } = props;
  const monaco = useMemo<Monaco>(() => setupMonaco(), []);
  const docs = useMemo(() => editorDocuments(monaco, client, workspaceId), [monaco, client, workspaceId]);
  const queryClient = useQueryClient();
  const state = useEditorStore((store) => editorWorkspaceState(store, workspaceId));
  const dirty = useEditorStore((store) => store.dirty[workspaceId]);
  const quickOpen = useEditorStore((store) => store.quickOpen);
  const reviewScope = useEditorStore((store) => store.reviewScope);
  const sideOpen = useEditorStore((store) => store.sideOpen);
  const activeTab = state.tabs.find((tab) => tab.id === state.activeId) ?? null;
  const [surface, setSurface] = useState<PanelSurface | null>(null);
  const surfaceHandle = useRef<SurfaceHandle | null>(null);
  const [surfaceReady, setSurfaceReady] = useState(false);
  const pendingReveal = useRef<{ path: string; line: number; column: number; endColumn?: number } | null>(null);
  const [searchFocus, setSearchFocus] = useState(0);
  const [problemsLoading, setProblemsLoading] = useState(false);
  const [breadcrumbSymbols, setBreadcrumbSymbols] = useState<string[]>([]);
  const problemsOpen = useEditorStore((store) => store.problemsOpen);
  const bottomTab = useEditorStore((store) => store.bottomTab);
  const problemFiles = useProblemsStore((store) => store.byWorkspace[workspaceId]);
  const problemTotals = problemCounts(problemFiles ?? []);
  const [tabError, setTabError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(null);
  const [hunks, setHunks] = useState<LineHunk[]>([]);
  const [navigate, setNavigate] = useState<{ direction: 1 | -1; nonce: number } | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [reviewTick, setReviewTick] = useState(0);
  // Bumped after open documents were read again (a file may have been deleted under its tab).
  const [docsTick, setDocsTick] = useState(0);
  const recentRef = useRef<string[]>([]);

  // ── data ───────────────────────────────────────────────────────────────
  const treeQuery = useQuery({
    queryKey: ["editor-tree", workspaceId] as const,
    queryFn: () => client.editorTree(workspaceId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const gitQuery = useQuery({
    queryKey: ["editor-git", workspaceId] as const,
    queryFn: () => client.editorGitStatus(workspaceId),
    staleTime: 3_000,
    refetchOnWindowFocus: true,
    refetchInterval: state.view === "git" ? 10_000 : false,
  });
  const changesQuery = useQuery({
    queryKey: ["editor-changes", workspaceId, sessionId, reviewScope] as const,
    queryFn: () => loadAgentChanges({ opencodeClient: opencodeClient!, sessionId: sessionId!, directory: workspaceRoot, scope: reviewScope, docs, workspaceRoot }),
    enabled: Boolean(opencodeClient && sessionId && !sessionBusy),
    // Edits can finish while IDE mode is closed; that mount never observes the busy-to-idle transition.
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const review = changesQuery.data;
  const reviewFiles = review?.files ?? [];
  const files = treeQuery.data?.files ?? EMPTY_FILES;

  // A turn ended: the agent may have changed files.
  const wasBusy = useRef(sessionBusy);
  useEffect(() => {
    if (wasBusy.current && !sessionBusy) {
      void docs.refresh().then(() => setDocsTick((value) => value + 1));
      void refreshAllDiagnostics();
      void queryClient.invalidateQueries({ queryKey: ["editor-tree", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["editor-git", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["editor-changes", workspaceId] });
    }
    wasBusy.current = sessionBusy;
  }, [docs, queryClient, sessionBusy, workspaceId]);

  // An undo or redo changed files: open files without unsaved changes take the disk text; one with
  // unsaved changes is flagged and Reload is offered first (an Overwrite would take the undo back).
  useEffect(() => {
    docs.shown += 1;
    const unsubscribe = onFilesRewound(() => {
      void docs.refreshAfterRewind().then((conflicts) => {
        setDocsTick((value) => value + 1);
        for (const path of conflicts) {
          showConflict(path, {
            reload: () => void docs.revert(path).then(() => setDocsTick((value) => value + 1)),
            overwrite: () => void docs.save(path, { sessionId, source: "editor", force: true }).then((result) => {
              if (!result.ok) toast.error(result.message);
              void queryClient.invalidateQueries({ queryKey: ["editor-git", workspaceId] });
            }),
            reason: "undo",
          });
        }
      }).catch(() => undefined);
      void queryClient.invalidateQueries({ queryKey: ["editor-tree", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["editor-git", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["editor-changes", workspaceId] });
    });
    return () => {
      docs.shown -= 1;
      unsubscribe();
    };
  }, [docs, queryClient, sessionId, workspaceId]);

  // Back in the window: files may have changed outside the app.
  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      // At most every 5 s: switching windows quickly must not re-read every open file each time.
      if (Date.now() - last < 5_000) return;
      last = Date.now();
      void docs.refresh().then(() => setDocsTick((value) => value + 1));
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [docs]);

  // ── review state ───────────────────────────────────────────────────────
  const reviewKey = review?.key ?? null;
  // Older reviews' "before" models and documents nobody shows are let go when a new review loads.
  const recentReviewKeys = useRef<string[]>([]);
  useEffect(() => {
    if (!reviewKey) return;
    recentReviewKeys.current = [reviewKey, ...recentReviewKeys.current.filter((key) => key !== reviewKey)].slice(0, 2);
    docs.disposeReviewModels(new Set(recentReviewKeys.current));
    const keep = new Set<string>([
      ...useEditorStore.getState().byWorkspace[workspaceId]?.tabs.map((tab) => tab.path) ?? [],
      // The split editor's second group shows documents too.
      ...useEditorStore.getState().byWorkspace[workspaceId]?.group2?.tabs.map((tab) => tab.path) ?? [],
      ...(review?.files.map((file) => file.path) ?? []),
    ]);
    docs.evict(keep);
  }, [docs, review, reviewKey, workspaceId]);
  const baselineModel = useCallback((file: ReviewFile) => {
    // Created once per review (key + path): accepting a hunk edits it, and a refetch must not undo that.
    const uri = docs.uri(`review/${reviewKey}/${file.path}`, "omnirush-base");
    const existing = monaco.editor.getModel(uri);
    if (existing) return existing;
    // A file fully reviewed before a restart stays reviewed while its text is the one that was reviewed.
    const current = docs.get(file.path)?.model.getValue() ?? file.current;
    const reviewed = current !== null && reviewKey !== null && isReviewed(reviewKey, file.path, current);
    return monaco.editor.createModel(reviewed ? current : file.baseline ?? "", languageForPath(file.path), uri);
  }, [docs, monaco, reviewKey]);
  const modifiedFor = useCallback((file: ReviewFile): FileDoc => {
    return docs.get(file.path) ?? docs.openMissing(file.path);
  }, [docs]);
  /** The file's document, read from disk first when it is not open yet (an agent deletion: an empty one). */
  const loadModified = useCallback(async (file: ReviewFile): Promise<FileDoc | null> => {
    const existing = docs.get(file.path);
    if (existing) return existing;
    if (file.current === null) return docs.openMissing(file.path);
    const opened = await docs.open(file.path);
    if (opened.ok) return opened.doc;
    toast.error(opened.message);
    return null;
  }, [docs]);
  /** The file's text now: its document when open, else the disk text the review loaded with. */
  const textNow = useCallback((file: ReviewFile) => docs.get(file.path)?.model.getValue() ?? file.current ?? "", [docs]);
  const isPending = useCallback((file: ReviewFile) => {
    if (file.baseline === undefined) return false;
    const base = baselineModel(file).getValue();
    return base !== textNow(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baselineModel, textNow, reviewTick]);

  // Remembers files whose review is finished (before === now), so a restart does not ask again.
  useEffect(() => {
    if (!reviewKey) return;
    for (const file of reviewFiles) {
      if (file.baseline === undefined) continue;
      const uri = docs.uri(`review/${reviewKey}/${file.path}`, "omnirush-base");
      const base = monaco.editor.getModel(uri)?.getValue();
      const now = docs.get(file.path)?.model.getValue() ?? file.current ?? "";
      if (base !== undefined && base === now) markReviewed(reviewKey, file.path, now);
    }
  }, [docs, monaco, reviewFiles, reviewKey, reviewTick]);

  const reportReview = useCallback((path: string, decision: "accept" | "reject", counts: { added: number; removed: number }, scope: "hunk" | "file") => {
    if (!sessionId) return;
    void client.editorReview(workspaceId, { sessionId, path, decision, scope, ...counts }).catch(() => undefined);
  }, [client, sessionId, workspaceId]);

  const writeReviewed = useCallback(async (file: ReviewFile, doc: FileDoc) => {
    // A file the agent created that is empty after rejecting goes away again.
    const result = file.baseline === null && doc.model.getValue() === ""
      ? await docs.remove(file.path, { sessionId, source: "review" })
      : await docs.save(file.path, { sessionId, source: "review" });
    if (!result.ok) toast.error(result.message);
    void queryClient.invalidateQueries({ queryKey: ["editor-git", workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ["editor-tree", workspaceId] });
  }, [docs, queryClient, sessionId, workspaceId]);

  const setLines = (model: import("monaco-editor/editor/editor.api.js").editor.ITextModel, lines: string[], undoable: boolean) => {
    const text = lines.join(model.getEOL());
    if (undoable) model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    else model.setValue(text);
  };

  const acceptOne = useCallback((file: ReviewFile, hunk: LineHunk) => {
    const base = baselineModel(file);
    const doc = modifiedFor(file);
    setLines(base, acceptHunk(base.getLinesContent(), doc.model.getLinesContent(), hunk), false);
    reportReview(file.path, "accept", hunkCounts(hunk), "hunk");
    setReviewTick((value) => value + 1);
    return true;
  }, [baselineModel, modifiedFor, reportReview]);

  /** Rejecting writes the file: not while the agent works on it, and not over the user's unsaved edits. */
  const canReject = useCallback((doc: FileDoc) => {
    if (sessionBusy) {
      toast("Wait for the agent's turn to finish before rejecting changes.");
      return false;
    }
    if (docs.isDirty(doc)) {
      toast(`${doc.path} has unsaved edits: save or discard them first.`);
      return false;
    }
    return true;
  }, [docs, sessionBusy]);

  const rejectOne = useCallback((file: ReviewFile, hunk: LineHunk) => {
    const base = baselineModel(file);
    const doc = modifiedFor(file);
    if (!canReject(doc)) return false;
    setLines(doc.model, rejectHunk(base.getLinesContent(), doc.model.getLinesContent(), hunk), true);
    reportReview(file.path, "reject", hunkCounts(hunk), "hunk");
    setReviewTick((value) => value + 1);
    void writeReviewed(file, doc);
    return true;
  }, [baselineModel, canReject, modifiedFor, reportReview, writeReviewed]);

  const acceptFiles = useCallback(async (list: ReviewFile[]) => {
    for (const file of list) {
      const doc = await loadModified(file);
      if (!doc) return;
      const base = baselineModel(file);
      base.setValue(doc.model.getValue());
      reportReview(file.path, "accept", { added: file.additions, removed: file.deletions }, "file");
    }
    setReviewTick((value) => value + 1);
  }, [baselineModel, loadModified, reportReview]);

  const rejectFiles = useCallback(async (list: ReviewFile[]) => {
    for (const file of list) {
      const doc = await loadModified(file);
      if (!doc || !canReject(doc)) return;
      doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: baselineModel(file).getValue() }], () => null);
      reportReview(file.path, "reject", { added: file.additions, removed: file.deletions }, "file");
      await writeReviewed(file, doc);
    }
    setReviewTick((value) => value + 1);
  }, [baselineModel, canReject, loadModified, reportReview, writeReviewed]);

  const reviewFilesRef = useRef(reviewFiles);
  reviewFilesRef.current = reviewFiles;
  const acceptRef = useRef(acceptOne);
  acceptRef.current = acceptOne;
  const rejectRef = useRef(rejectOne);
  rejectRef.current = rejectOne;

  // ── tabs ───────────────────────────────────────────────────────────────
  const openFile = useCallback((path: string) => {
    useEditorStore.getState().openTab(workspaceId, { id: tabId({ kind: "file", path }), kind: "file", path });
    recentRef.current = [path, ...recentRef.current.filter((item) => item !== path)].slice(0, 30);
  }, [workspaceId]);
  /** Opens a file and puts the cursor at a 1-based position (search results, problems, go to definition). */
  const openAt = useCallback((path: string, line: number, column: number, endColumn?: number) => {
    pendingReveal.current = { path, line, column, endColumn };
    openFile(path);
    const current = useEditorStore.getState().byWorkspace[workspaceId];
    const active = current?.tabs.find((tab) => tab.id === current.activeId);
    if (active?.path === path && surfaceHandle.current) {
      surfaceHandle.current.reveal(line, column, endColumn);
      pendingReveal.current = null;
    }
  }, [openFile, workspaceId]);

  const handoff = useCallback((instruction: string, chips: { label: string; text: string }[]) => {
    const result = sendToChat(sessionId, instruction, chips);
    if (!result.ok) toast(result.reason);
  }, [sessionId]);

  const fixWithAgent = useCallback((path: string, diagnostic: LspDiagnostic) => {
    const doc = docs.get(path);
    const line = diagnostic.range.start.line + 1;
    const from = Math.max(1, line - 3);
    const to = doc ? Math.min(doc.model.getLineCount(), diagnostic.range.end.line + 4) : line;
    const code = doc ? doc.model.getValueInRange({ startLineNumber: from, startColumn: 1, endLineNumber: to, endColumn: doc.model.getLineMaxColumn(to) }) : "";
    const where = `L${line}:C${diagnostic.range.start.character + 1}`;
    const source = diagnostic.source ? `${diagnostic.source}${diagnostic.code !== undefined ? ` ${typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code}` : ""}: ` : "";
    handoff("Fix this problem:", [{
      label: `${path.split("/").pop()} ${where} · ${diagnostic.message.split("\n")[0]!.slice(0, 50)}`,
      text: `${path} ${where}: ${source}${diagnostic.message}${code ? `\n${codeChipText(path, from, to, doc ? languageForPath(path) : "", code)}` : ""}`,
    }]);
  }, [docs, handoff]);

  const agentAction = useCallback((action: AgentAction, editor: import("monaco-editor/editor/editor.api.js").editor.ICodeEditor) => {
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection || model.uri.scheme !== "omnirush-file") return;
    const path = model.uri.path.replace(/^\//, "");
    let range = selection;
    if (selection.isEmpty()) {
      // No selection: the line under the cursor.
      const line = selection.startLineNumber;
      range = new monaco.Selection(line, 1, line, model.getLineMaxColumn(line));
    }
    const code = model.getValueInRange(range);
    const chip = {
      label: `${lineLabel(path, range.startLineNumber, range.endLineNumber)} · selection`,
      text: codeChipText(path, range.startLineNumber, range.endLineNumber, model.getLanguageId(), code),
    };
    const instruction = action === "explain" ? "Explain what this code does and why."
      : action === "refactor" ? "Refactor this code: "
        : action === "tests" ? "Write tests for this code with the project's test setup, and run them."
          : "";
    handoff(instruction, [chip]);
  }, [handoff, monaco]);

  // The language features act on this workspace while the editor shows it.
  useEffect(() => {
    installLanguageFeatures(monaco);
    setLanguageContext({ monaco, client, workspaceId, workspaceRoot, docs, openAt: (path, line, column) => openAt(path, line, column), fixWithAgent });
    setProblemsLoading(true);
    void refreshAllDiagnostics().finally(() => setProblemsLoading(false));
    return () => setLanguageContext(null);
  }, [client, docs, fixWithAgent, monaco, openAt, workspaceId, workspaceRoot]);

  const openReview = useCallback((file: ReviewFile) => {
    if (file.baseline === undefined) {
      openFile(file.path);
      return;
    }
    useEditorStore.getState().openTab(workspaceId, { id: tabId({ kind: "review", path: file.path }), kind: "review", path: file.path });
  }, [openFile, workspaceId]);
  const openGit = useCallback((file: OmniRushEditorGitFile, staged: boolean) => {
    const ref = staged ? "HEAD" : "index";
    useEditorStore.getState().openTab(workspaceId, { id: tabId({ kind: "git", path: file.path, ref }), kind: "git", path: file.path, ref });
  }, [workspaceId]);

  const closeTab = useCallback((tab: EditorTab) => {
    const doc = tab.kind === "file" ? docs.get(tab.path) : null;
    if (doc && docs.isDirty(doc) && !window.confirm(`${tab.path} has unsaved changes. Close it anyway? The changes stay until you reopen the file.`)) return;
    useEditorStore.getState().closeTab(workspaceId, tab.id);
  }, [docs, workspaceId]);

  // The active tab's document.
  useEffect(() => {
    let cancelled = false;
    setTabError(null);
    if (!activeTab) {
      setSurface(null);
      return;
    }
    const key = `${workspaceId}|${activeTab.id}`;
    void (async () => {
      if (activeTab.kind === "file" && isImagePath(activeTab.path)) {
        setSurface({ kind: "image", key, path: activeTab.path });
        return;
      }
      if (activeTab.kind === "file" || activeTab.kind === "preview") {
        const opened = await docs.open(activeTab.path);
        if (cancelled) return;
        if (!opened.ok) {
          setSurface(null);
          setTabError(opened.message);
          return;
        }
        if (opened.doc.missing && !docs.isDirty(opened.doc)) {
          setSurface(null);
          setTabError("This file was deleted.");
          return;
        }
        setSurface({ kind: activeTab.kind, key, doc: opened.doc });
        return;
      }
      if (activeTab.kind === "review") {
        const file = reviewFiles.find((item) => item.path === activeTab.path);
        if (!file || file.baseline === undefined) {
          if (!changesQuery.isFetching && review) {
            setSurface(null);
            setTabError("This change is no longer in the review. Open the file from the Files view.");
          }
          return;
        }
        const opened = file.status === "deleted" ? null : await docs.open(file.path);
        if (cancelled) return;
        const doc = opened && opened.ok ? opened.doc : docs.openMissing(file.path);
        const path = file.path;
        // Through refs: the bars outlive this render, and must act on the newest review data.
        const current = () => reviewFilesRef.current.find((item) => item.path === path) ?? file;
        setSurface({
          kind: "diff",
          key: `${key}:${reviewKey}`,
          original: baselineModel(file),
          modified: doc.model,
          review: { onAccept: (hunk) => acceptRef.current(current(), hunk), onReject: (hunk) => rejectRef.current(current(), hunk) },
        });
        return;
      }
      if (activeTab.kind !== "git") return;
      // Git: the file against HEAD (staged view) or the index (working-tree view).
      const [original, opened] = await Promise.all([
        client.editorGitOriginal(workspaceId, activeTab.path, activeTab.ref).catch(() => null),
        docs.open(activeTab.path),
      ]);
      if (cancelled) return;
      if (original?.binary || original?.tooLarge) {
        setSurface(null);
        setTabError("This file cannot be shown as a text diff.");
        return;
      }
      const base = docs.baseline(`git-${activeTab.ref}`, activeTab.path, original?.content ?? "");
      const doc = opened.ok ? opened.doc : docs.openMissing(activeTab.path);
      setSurface({ kind: "diff", key, original: base, modified: doc.model });
    })();
    return () => {
      cancelled = true;
    };
    // reviewFiles changes identity per fetch; the key carries what matters.
  }, [activeTab, docs, client, workspaceId, reviewKey, changesQuery.isFetching, docsTick]);

  useEffect(() => {
    const reveal = pendingReveal.current;
    if (!reveal || !surface || !activeTab || activeTab.path !== reveal.path) return;
    pendingReveal.current = null;
    requestAnimationFrame(() => surfaceHandle.current?.reveal(reveal.line, reveal.column, reveal.endColumn));
  }, [activeTab, surface]);

  // Language features start for a file once it has been the active file for a moment, or when it is edited
  // (a file only glanced at from search, quick open or Problems starts no language server).
  const languageFeatures = useEditorStore((state) => state.languageFeatures);
  const activeFilePath = surface?.kind === "file" ? surface.doc.path : null;
  const lspActive = useIsLspActive(activeFilePath);
  useEffect(() => {
    setLspSessionBusy(agentBusy);
  }, [agentBusy]);
  useEffect(() => {
    if (!languageFeatures) clearLanguageFeatures();
  }, [languageFeatures]);
  useEffect(() => {
    if (!surface || surface.kind !== "file" || !languageFeatures || lspActive) return;
    const path = surface.doc.path;
    const timer = window.setTimeout(() => activateLsp(path), LSP_DWELL_MS);
    // A typed edit starts them at once; the text loading or reloading from disk does not (the document is clean
    // again right after a reload, so the check waits a microtask).
    const doc = surface.doc;
    const subscription = doc.model.onDidChangeContent(() => {
      queueMicrotask(() => {
        if (docs.isDirty(doc)) activateLsp(path);
      });
    });
    return () => {
      window.clearTimeout(timer);
      subscription.dispose();
    };
  }, [docs, surface, languageFeatures, lspActive]);

  // The active file's problems: when its language features start and after edits (its unsaved text is checked).
  useEffect(() => {
    if (!surface || surface.kind !== "file" || !lspActive) return;
    const doc = surface.doc;
    void refreshFileDiagnostics(doc.path);
    let timer = 0;
    const subscription = doc.model.onDidChangeContent(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refreshFileDiagnostics(doc.path), 1200);
    });
    return () => {
      window.clearTimeout(timer);
      subscription.dispose();
    };
  }, [surface, lspActive, agentBusy]);

  // The git gutter for the file shown (git-gutter.ts): HEAD texts are read again when git's state changes.
  const gutter = useMemo(() => new GitGutter(client, workspaceId), [client, workspaceId]);
  const gitFiles = gitQuery.data?.repo ? gitQuery.data.files : null;
  useEffect(() => {
    gutter.reset();
  }, [gutter, gitQuery.dataUpdatedAt]);
  useEffect(() => {
    if (!surfaceReady || !surface || surface.kind !== "file" || !gitFiles) return;
    const editor = surfaceHandle.current?.codeEditor();
    if (!editor) return;
    const doc = surface.doc;
    const changedInGit = gitFiles.some((file) => file.path === doc.path);
    return gutter.attach(editor, doc.model, doc.path, changedInGit, () => docs.isDirty(doc));
  }, [docs, gitFiles, gutter, surface, surfaceReady]);

  // Breadcrumbs: the symbols around the cursor.
  useEffect(() => {
    if (!surface || surface.kind !== "file" || !cursor) {
      setBreadcrumbSymbols([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void documentSymbols(surface.doc.model).then((symbols) => {
        if (!cancelled) setBreadcrumbSymbols(symbolPath(symbols ?? [], cursor.line, cursor.column).map((symbol) => symbol.name));
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cursor, surface, lspActive]);

  // ── save ───────────────────────────────────────────────────────────────
  /** No formatter for these extensions in this project: said once. */
  const noFormatterNoted = useRef(new Set<string>());
  /**
   * Format on save: the project's own formatter on the buffer's text, applied as one undoable edit before writing.
   * A formatter that fails or takes longer than 3 s never blocks the save: the file is saved as it is.
   */
  /** The trust prompt for running a project's formatter ("Run `<command>` from this project …?"). */
  const [formatPrompt, setFormatPrompt] = useState<{ formatter: string; command: string; sandbox: boolean; answer: (choice: "once" | "always" | "never" | null) => void } | null>(null);
  const askFormatTrust = (formatter: string, command: string, sandbox: boolean) =>
    new Promise<"once" | "always" | "never" | null>((resolve) => {
      setFormatPrompt({ formatter, command, sandbox, answer: (choice) => {
        setFormatPrompt(null);
        resolve(choice);
      } });
    });
  const formatBeforeSave = useCallback(async (path: string, trigger: "manual" | "focus") => {
    const doc = docs.get(path);
    if (!doc) return;
    const model = doc.model;
    const version = model.getAlternativeVersionId();
    const extension = path.includes(".") ? path.slice(path.lastIndexOf(".")) : path;
    try {
      let outcome = await client.editorFormat(workspaceId, path, model.getValue());
      if (outcome.formatter !== null && "trust" in outcome && outcome.trust === "ask") {
        // The project's formatter is the project's code: it runs only after the person says so, and never from an
        // automatic save (that saves the file as it is and says how to choose).
        if (trigger !== "manual") {
          if (!noFormatterNoted.current.has(`trust:${extension}`)) {
            noFormatterNoted.current.add(`trust:${extension}`);
            toast(`Saved without formatting: ${outcome.formatter} has not been allowed for this project yet. Save with ${/Mac/i.test(navigator.platform) ? "⌘S" : "Ctrl+S"} to choose.`);
          }
          return;
        }
        const choice = await askFormatTrust(outcome.formatter, outcome.command, outcome.sandbox);
        if (!choice) return;
        outcome = await client.editorFormat(workspaceId, path, model.getValue(), { trust: choice, hash: outcome.hash });
        if ("trust" in outcome && outcome.trust === "ask") {
          toast("The formatter's settings changed while you chose; saved as is. Save again to see the new command.");
          return;
        }
      }
      if (outcome.formatter === null) {
        if (!noFormatterNoted.current.has(extension)) {
          noFormatterNoted.current.add(extension);
          toast(`No formatter set up for ${extension} files in this project; saved as is.`);
        }
        return;
      }
      if (!("text" in outcome) || typeof outcome.text !== "string") return;
      // Typed while the formatter ran: that text wins, unformatted. Line endings alone are no change.
      const lf = (text: string) => text.replace(/\r\n/g, "\n");
      if (model.getAlternativeVersionId() !== version || lf(outcome.text) === lf(model.getValue())) return;
      model.pushStackElement();
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: outcome.text }], () => null);
      model.pushStackElement();
      toast(`Formatted with ${outcome.formatter}${outcome.sandbox ? " (in the sandbox)" : ""}`, { duration: 1500 });
    } catch (error) {
      toast(`Couldn't format this file; it was saved as is.${error instanceof Error && error.message ? ` ${error.message}` : ""}`);
    }
  }, [client, docs, workspaceId]);

  /**
   * Saves one file. `manual` (Cmd/Ctrl+S, Save) and `focus` (auto save when focus leaves) also run the project's
   * formatter when Format on save is on; `delay` (auto save after a delay) never formats. A file that changed on
   * disk since it was loaded is never overwritten by an automatic save: it shows the Reload / Keep mine choice.
   */
  const saveFile = useCallback(async (path: string, trigger: "manual" | "delay" | "focus", options: { force?: boolean } = {}) => {
    const doc = docs.get(path);
    if (!doc) return;
    if (trigger !== "manual" && (doc.conflict || !docs.isDirty(doc))) return;
    if (useEditorSettings.getState().formatOnSave && trigger !== "delay") await formatBeforeSave(path, trigger);
    const result = await docs.save(path, { sessionId, source: "editor", force: options.force });
    if (result.ok) {
      void refreshFileDiagnostics(path);
      void queryClient.invalidateQueries({ queryKey: ["editor-git", workspaceId] });
      if (!files.includes(path)) void queryClient.invalidateQueries({ queryKey: ["editor-tree", workspaceId] });
      return;
    }
    if (result.conflict) {
      doc.conflict = true;
      showConflict(path, { reload: () => void docs.revert(path), overwrite: () => void saveFile(path, "manual", { force: true }), reason: "save" });
      return;
    }
    toast.error(result.message);
  }, [docs, files, formatBeforeSave, queryClient, sessionId, workspaceId]);

  const save = useCallback(async (options: { force?: boolean } = {}) => {
    if (!activeTab) return;
    await saveFile(activeTab.path, "manual", options);
  }, [activeTab, saveFile]);

  // Auto save. After a delay: a second after the last edit of a file, held while any chat's agent works (saved when
  // the turn ends). When focus leaves: the editor or the window losing focus. Both skip files in conflict.
  const autoSave = useEditorSettings((state) => state.autoSave);
  const autoSaveTimers = useRef(new Map<string, number>());
  const heldForAgent = useRef(new Set<string>());
  const agentBusyRef = useRef(agentBusy);
  useEffect(() => {
    agentBusyRef.current = agentBusy;
    if (agentBusy || !heldForAgent.current.size) return;
    const held = [...heldForAgent.current];
    heldForAgent.current.clear();
    for (const path of held) void saveFile(path, "delay");
  }, [agentBusy, saveFile]);
  useEffect(() => {
    if (autoSave !== "onFocusChange") return;
    const saveDirty = () => {
      for (const path of Object.keys(useEditorStore.getState().dirty[workspaceId] ?? {})) void saveFile(path, "focus");
    };
    const onBlur = () => saveDirty();
    window.addEventListener("blur", onBlur);
    window.addEventListener("omnirush:editor-blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("omnirush:editor-blur", onBlur);
    };
  }, [autoSave, saveFile, workspaceId]);
  useEffect(() => () => {
    for (const timer of autoSaveTimers.current.values()) window.clearTimeout(timer);
  }, []);

  // ── git ────────────────────────────────────────────────────────────────
  const stage = useCallback(async (paths: string[], doStage: boolean) => {
    setGitBusy(true);
    try {
      const status = await client.editorGitStage(workspaceId, paths, doStage);
      queryClient.setQueryData(["editor-git", workspaceId], status);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Git failed.");
    } finally {
      setGitBusy(false);
    }
  }, [client, queryClient, workspaceId]);
  const commit = useCallback(async (message: string) => {
    setGitBusy(true);
    try {
      const result = await client.editorGitCommit(workspaceId, message);
      queryClient.setQueryData(["editor-git", workspaceId], result.status);
      toast.success(`Committed ${result.commit}`);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Commit failed.");
      return false;
    } finally {
      setGitBusy(false);
    }
  }, [client, queryClient, workspaceId]);

  // ── second editor group (split editor) ────────────────────────────────
  const group2 = state.group2 ?? null;
  const group2Tab = group2?.tabs.find((tab) => tab.id === group2.activeId) ?? null;
  const focusedGroup = useEditorStore((store) => store.focusedGroup);
  const [group2Doc, setGroup2Doc] = useState<FileDoc | null>(null);
  const [group2Error, setGroup2Error] = useState<string | null>(null);
  const group2EditorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | null>(null);
  const [group2Ready, setGroup2Ready] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setGroup2Error(null);
    if (!group2Tab || (group2Tab.kind !== "file" && group2Tab.kind !== "preview") || isImagePath(group2Tab.path)) {
      setGroup2Doc(null);
      return;
    }
    void docs.open(group2Tab.path).then((opened) => {
      if (cancelled) return;
      if (!opened.ok) {
        setGroup2Doc(null);
        setGroup2Error(opened.message);
        return;
      }
      setGroup2Doc(opened.doc);
    });
    return () => {
      cancelled = true;
    };
  }, [docs, group2Tab, docsTick]);
  // The git gutter in group 2 too.
  useEffect(() => {
    const editor = group2EditorRef.current;
    if (!group2Ready || !editor || !group2Doc || group2Tab?.kind !== "file" || !gitFiles) return;
    const changedInGit = gitFiles.some((file) => file.path === group2Doc.path);
    return gutter.attach(editor, group2Doc.model, group2Doc.path, changedInGit, () => docs.isDirty(group2Doc));
  }, [docs, gitFiles, group2Doc, group2Ready, group2Tab, gutter]);

  // The editor area's width: two groups need room, else the split folds into one group (tabs and unsaved text kept).
  const editorAreaRef = useRef<HTMLDivElement | null>(null);
  const [editorWidth, setEditorWidth] = useState(0);
  useEffect(() => {
    const element = editorAreaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setEditorWidth(Math.round(entry?.contentRect.width ?? 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const splitAllowed = editorWidth === 0 || editorWidth >= MIN_GROUP_PX * 2;
  // Folds only when the width stays too small (not on one reading while panels settle or a sidebar animates).
  useEffect(() => {
    if (!group2 || splitAllowed) return;
    const timer = window.setTimeout(() => {
      useEditorStore.getState().foldGroup2(workspaceId);
      toast("The window got too narrow for two editor groups, so they were joined. Split again when it is wider.");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [group2, splitAllowed, workspaceId]);
  const splitGroupRef = useGroupRef();

  const focusGroup = useCallback((group: 1 | 2) => {
    useEditorStore.getState().setFocusedGroup(group);
    const editor = group === 2 ? group2EditorRef.current : surfaceHandle.current?.activeEditor();
    window.setTimeout(() => editor?.focus(), 0);
  }, []);

  /** Cmd/Ctrl+\: the current file in the other group (a new group on the right when there is one group). */
  const splitEditor = useCallback(() => {
    const store = useEditorStore.getState();
    if (!splitAllowed) {
      toast("Widen the window or hide the file tree to split the editor.");
      return;
    }
    if (store.focusedGroup === 2 && group2Tab) {
      store.openTab(workspaceId, group2Tab);
      focusGroup(1);
      return;
    }
    if (!activeTab || (activeTab.kind !== "file" && activeTab.kind !== "preview")) {
      toast("Open a file to split the editor.");
      return;
    }
    store.openTab2(workspaceId, { ...activeTab });
    focusGroup(2);
  }, [activeTab, focusGroup, group2Tab, splitAllowed, workspaceId]);

  /** Markdown preview: in the other group (`side`) or in the focused group. */
  const openPreview = useCallback((where: "side" | "here") => {
    const store = useEditorStore.getState();
    const source = store.focusedGroup === 2 ? group2Tab : activeTab;
    if (!source || !isMarkdownPath(source.path)) {
      toast("Open a Markdown file to preview it.");
      return;
    }
    const tab: EditorTab = { id: tabId({ kind: "preview", path: source.path }), kind: "preview", path: source.path };
    const inGroup2 = (store.focusedGroup === 2) === (where === "here");
    if (inGroup2 && !splitAllowed && !group2) {
      store.openTab(workspaceId, tab);
      return;
    }
    if (inGroup2) store.openTab2(workspaceId, tab);
    else {
      store.openTab(workspaceId, tab);
      store.setFocusedGroup(1);
    }
  }, [activeTab, group2, group2Tab, splitAllowed, workspaceId]);

  const moveToOtherGroup = useCallback((tab: EditorTab, from: 1 | 2, keepOpen: boolean) => {
    const store = useEditorStore.getState();
    if (from === 1) {
      if (!splitAllowed) {
        toast("Widen the window or hide the file tree to split the editor.");
        return;
      }
      store.openTab2(workspaceId, { ...tab });
      if (!keepOpen) store.closeTab(workspaceId, tab.id);
    } else {
      store.openTab(workspaceId, { ...tab });
      store.setFocusedGroup(1);
      if (!keepOpen) store.closeTab2(workspaceId, tab.id);
    }
  }, [splitAllowed, workspaceId]);

  // The files shown in either group (typing happens there).
  const shownDocs = useMemo(() => {
    const list: FileDoc[] = [];
    if (surface?.kind === "file") list.push(surface.doc);
    if (group2Doc && state.group2 && !list.includes(group2Doc)) list.push(group2Doc);
    return list;
  }, [group2Doc, state.group2, surface]);
  useEffect(() => {
    if (autoSave !== "afterDelay" || !shownDocs.length) return;
    const subscriptions = shownDocs.map((doc) => doc.model.onDidChangeContent(() => {
      const timers = autoSaveTimers.current;
      window.clearTimeout(timers.get(doc.path));
      timers.set(doc.path, window.setTimeout(() => {
        timers.delete(doc.path);
        if (agentBusyRef.current) heldForAgent.current.add(doc.path);
        else void saveFile(doc.path, "delay");
      }, AUTO_SAVE_DELAY_MS));
    }));
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [autoSave, saveFile, shownDocs]);

  // Commands from the app's shortcuts and palette (use-shell-shortcuts.ts, session-route.tsx).
  useEffect(() => {
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (command === "search") {
        useEditorStore.getState().setView(workspaceId, "search");
        setSearchFocus((value) => value + 1);
      } else if (command === "problems") {
        useEditorStore.getState().setProblemsOpen(true);
        void refreshAllDiagnostics();
      } else if (command === "quick-open") {
        useEditorStore.getState().setQuickOpen(true);
      } else if (command === "symbol") {
        const editor = surfaceHandle.current?.activeEditor();
        const model = editor?.getModel();
        if (model) activateLspForModel(model);
        editor?.focus();
        editor?.trigger("palette", "editor.action.quickOutline", null);
      } else if (command === "outline") {
        useEditorStore.getState().setView(workspaceId, "files");
      } else if (command === "split") {
        splitEditor();
      } else if (command === "preview-side") {
        openPreview("side");
      } else if (command === "preview-here") {
        openPreview("here");
      } else if (command === "focus-other-group") {
        if (useEditorStore.getState().byWorkspace[workspaceId]?.group2) focusGroup(useEditorStore.getState().focusedGroup === 1 ? 2 : 1);
      }
    };
    window.addEventListener("omnirush:editor-command", onCommand);
    return () => window.removeEventListener("omnirush:editor-command", onCommand);
  }, [focusGroup, openPreview, splitEditor, workspaceId]);

  // ── keys ───────────────────────────────────────────────────────────────
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = /Mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      // Cmd/Ctrl+S outside Monaco (tab strip, tree) still saves the active file.
      const inMonaco = event.target instanceof Element && Boolean(event.target.closest(".monaco-editor"));
      if (key === "s" && !event.shiftKey && !inMonaco && panelRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [save]);

  useEffect(() => {
    if (!state.activeId) return;
    panelRef.current?.querySelector(`[data-editor-tab="${CSS.escape(state.activeId)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.activeId]);

  const activePath = activeTab?.path ?? null;
  const activeDirty = activeTab && dirty?.[activeTab.path];
  const activeDoc = activePath ? docs.get(activePath) : null;
  const pendingCount = reviewFiles.filter((file) => isPending(file)).length;
  const branch = gitQuery.data?.repo ? gitQuery.data.branch : null;
  const setView = (view: EditorSideView) => {
    if (state.view === view && sideOpen) useEditorStore.getState().setSideOpen(false);
    else useEditorStore.getState().setView(workspaceId, view);
  };

  const side = (
    <div className="flex h-full min-h-0 flex-col border-e border-border bg-muted/20">
      {state.view === "search" ? (
        <SearchView
          client={client}
          workspaceId={workspaceId}
          docs={docs}
          sessionId={sessionId}
          focusNonce={searchFocus}
          onOpen={openAt}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ["editor-git", workspaceId] })}
        />
      ) : state.view === "files" ? (
        <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
        <FilesView
          files={files}
          truncated={Boolean(treeQuery.data?.truncated)}
          git={gitQuery.data}
          selected={activePath}
          loading={treeQuery.isFetching}
          error={treeQuery.isError}
          onOpen={(path) => {
            // In the group that has the keyboard, like VS Code.
            const store = useEditorStore.getState();
            if (store.focusedGroup === 2 && store.byWorkspace[workspaceId]?.group2) store.openTab2(workspaceId, { id: tabId({ kind: "file", path }), kind: "file", path });
            else openFile(path);
          }}
          onRefresh={() => void treeQuery.refetch()}
        />
        </div>
        <OutlineView
          model={surface?.kind === "file" ? surface.doc.model : null}
          path={surface?.kind === "file" ? surface.doc.path : null}
          onReveal={(line, column) => surfaceHandle.current?.reveal(line, column)}
        />
        </div>
      ) : state.view === "changes" ? (
        <ChangesView
          data={review}
          loading={changesQuery.isFetching}
          error={changesQuery.isError ? (changesQuery.error instanceof Error ? changesQuery.error.message : "Could not load the agent's changes.") : null}
          scope={reviewScope}
          available={Boolean(opencodeClient && sessionId)}
          pending={isPending}
          selected={activeTab?.kind === "review" ? activeTab.path : null}
          onScope={(scope) => useEditorStore.getState().setReviewScope(scope)}
          onOpen={openReview}
          onAcceptAll={(list) => void acceptFiles(list)}
          onRejectAll={(list) => void rejectFiles(list)}
          onRefresh={() => void changesQuery.refetch()}
        />
      ) : (
        <GitView
          status={gitQuery.data}
          loading={gitQuery.isFetching}
          error={gitQuery.isError ? (gitQuery.error instanceof Error ? gitQuery.error.message : "Could not read git status.") : null}
          busy={gitBusy}
          selected={activeTab?.kind === "git" ? activeTab.path : null}
          onOpen={openGit}
          onStage={(paths, doStage) => void stage(paths, doStage)}
          onCommit={commit}
          onRefresh={() => void gitQuery.refetch()}
        />
      )}
    </div>
  );

  const mac = /Mac/i.test(navigator.platform);
  /** A group takes the keyboard when used, except through the split / preview buttons: those act on the focused one. */
  const focusFrom = (event: React.SyntheticEvent, group: 1 | 2) => {
    if ((event.target as HTMLElement).closest("[data-editor-tools]")) return;
    useEditorStore.getState().setFocusedGroup(group);
  };
  const renderTab = (tab: EditorTab, group: 1 | 2, active: boolean) => {
    const name = tab.path.split("/").pop() ?? tab.path;
    const isDirty = (tab.kind === "file") && dirty?.[tab.path];
    const focused = group === focusedGroup;
    const close = () => (group === 1 ? closeTab(tab) : useEditorStore.getState().closeTab2(workspaceId, tab.id));
    const canMove = tab.kind === "file" || tab.kind === "preview";
    return (
      <ContextMenu key={tab.id}>
        <ContextMenuTrigger className="flex shrink-0">
          <div
            role="tab"
            aria-selected={active}
            title={tab.path}
            data-editor-tab={tab.id}
            data-editor-tab-group={group}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                close();
              }
            }}
            className={cn(
              "group flex max-w-48 shrink-0 cursor-pointer items-center gap-1.5 border-e border-border ps-3 pe-1.5 text-xs",
              active
                ? cn("bg-background text-foreground", focused || !group2 ? "shadow-[inset_0_-2px_0_var(--primary)]" : "shadow-[inset_0_-2px_0_var(--border)]")
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => (group === 1 ? useEditorStore.getState().selectTab(workspaceId, tab.id) : useEditorStore.getState().selectTab2(workspaceId, tab.id))}
          >
            {tab.kind === "review" ? <CircleDot className="size-3 shrink-0 text-link" /> : tab.kind === "git" ? <GitBranch className="size-3 shrink-0" /> : tab.kind === "preview" ? <Eye className="size-3 shrink-0" /> : null}
            <span className="truncate">{tab.kind === "preview" ? `Preview ${name}` : name}{tab.kind === "git" ? ` (${tab.ref === "HEAD" ? "staged" : "working"})` : ""}</span>
            <button
              type="button"
              aria-label={`Close ${name}`}
              onClick={(event) => {
                event.stopPropagation();
                close();
              }}
              className="flex size-4 items-center justify-center rounded hover:bg-muted"
            >
              {isDirty ? <span className="size-2 rounded-full bg-foreground group-hover:hidden" /> : null}
              <X className={cn("size-3", isDirty && "hidden group-hover:block")} />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={!canMove} onClick={() => moveToOtherGroup(tab, group, false)}>Move to other group</ContextMenuItem>
          <ContextMenuItem disabled={!canMove} onClick={() => moveToOtherGroup(tab, group, true)}>Open in other group</ContextMenuItem>
          {isMarkdownPath(tab.path) && tab.kind === "file" ? (
            <ContextMenuItem onClick={() => openPreview("side")}>Open preview to the side</ContextMenuItem>
          ) : null}
          <ContextMenuItem onClick={close}>Close</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const focusedTab = focusedGroup === 2 ? group2Tab : activeTab;
  const tabTools = (
    <div className="ms-auto flex shrink-0 items-center gap-0.5 px-1" data-editor-tools>
      {focusedTab && focusedTab.kind === "file" && isMarkdownPath(focusedTab.path) ? (
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Open preview to the side" onClick={() => openPreview("side")} data-editor-preview-button><Eye /></Button>} />
          <TooltipContent>Open preview to the side ({mac ? "⌘⇧V" : "Ctrl+Shift+V"})</TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Split editor"
              aria-disabled={!splitAllowed}
              className={cn(!splitAllowed && "opacity-50")}
              onClick={splitEditor}
              data-editor-split
            >
              <Columns2 />
            </Button>
          )}
        />
        <TooltipContent>{splitAllowed ? `Split editor (${mac ? "⌘\\" : "Ctrl+\\"})` : "Widen the window or hide the file tree to split"}</TooltipContent>
      </Tooltip>
    </div>
  );

  const group1 = (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      data-editor-group="1"
      onFocusCapture={(event) => focusFrom(event, 1)}
      onPointerDownCapture={(event) => focusFrom(event, 1)}
    >
      <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border [scrollbar-width:none]" role="tablist" data-editor-tabs>
        {state.tabs.map((tab) => renderTab(tab, 1, tab.id === state.activeId))}
        {!group2 ? tabTools : null}
      </div>
      {activeTab?.kind === "review" ? (
        <div className="flex h-8 shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-border bg-primary/5 px-3 text-xs" data-editor-review-bar>
          <span className="min-w-0 truncate font-medium">{hunks.length ? `${hunks.length} to review` : "All reviewed"}</span>
          <span className="flex-1" />
          <Button variant="ghost" size="xs" disabled={!hunks.length} onClick={() => setNavigate({ direction: -1, nonce: Date.now() })}><ChevronUp /> Prev</Button>
          <Button variant="ghost" size="xs" disabled={!hunks.length} onClick={() => setNavigate({ direction: 1, nonce: Date.now() })}><ChevronDown /> Next</Button>
        </div>
      ) : activePath ? (
        <div className="flex h-6 shrink-0 items-center gap-1 border-b border-border px-3 text-[11px] text-muted-foreground" data-editor-breadcrumb>
          {activePath.split("/").map((part, index, parts) => (
            <span key={`${index}:${part}`} className={cn("shrink-0", index === parts.length - 1 && !breadcrumbSymbols.length && "text-foreground")}>
              {part}{index < parts.length - 1 ? <span className="mx-1 opacity-60">›</span> : null}
            </span>
          ))}
          {breadcrumbSymbols.map((name, index) => (
            <span key={`symbol:${index}:${name}`} className={cn("min-w-0 truncate", index === breadcrumbSymbols.length - 1 && "text-foreground")} data-editor-breadcrumb-symbol>
              <span className="mx-1 opacity-60">›</span>{name}
            </span>
          ))}
          {activeDoc?.conflict ? (
            <button type="button" className="ms-auto flex items-center gap-1 text-amber-600 hover:underline dark:text-amber-400" onClick={() => void docs.revert(activePath)}>
              <Undo2 className="size-3" /> Changed on disk: reload
            </button>
          ) : null}
        </div>
      ) : null}
      {tabError ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">{tabError}</div>
      ) : null}
      <div className={cn("flex min-h-0 flex-1 flex-col", tabError && "hidden")}>
        {state.tabs.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground" data-editor-empty>
            <FileCode2 className="size-8 opacity-40" />
            <p>Open a file from the tree, or press <kbd className="rounded border border-border px-1 text-xs">{/Mac/i.test(navigator.platform) ? "⌘" : "Ctrl"} P</kbd> to find one.</p>
            {pendingCount ? (
              <Button size="sm" variant="outline" onClick={() => useEditorStore.getState().setView(workspaceId, "changes")}>Review {pendingCount} changed file{pendingCount === 1 ? "" : "s"}</Button>
            ) : null}
          </div>
        ) : null}
        <div className={cn("flex min-h-0 flex-1", state.tabs.length === 0 && "hidden")}>
          <div className={cn("flex min-h-0 min-w-0 flex-1", (surface?.kind === "preview" || surface?.kind === "image") && "hidden")}>
          <EditorSurface
            monaco={monaco}
            surface={surface && (surface.kind === "file" || surface.kind === "diff") ? surface : null}
            onSave={() => void save()}
            onCursor={setCursor}
            onHunks={setHunks}
            navigate={navigate}
            onAgentAction={agentAction}
            onReady={(handle) => {
              surfaceHandle.current = handle;
              setSurfaceReady(Boolean(handle));
            }}
          />
          </div>
          {surface?.kind === "preview" ? (
            <MarkdownPreview
              client={client}
              workspaceId={workspaceId}
              path={surface.doc.path}
              model={surface.doc.model}
              isDirty={() => docs.isDirty(surface.doc)}
              onOpenFile={openFile}
              onOpenExternal={(url) => void openDesktopUrl(url).catch(() => toast.error("Could not open the link."))}
            />
          ) : null}
          {surface?.kind === "image" ? <ImageView client={client} workspaceId={workspaceId} path={surface.path} /> : null}
        </div>
      </div>
    </div>
  );

  const group2View = group2 ? (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      data-editor-group="2"
      onFocusCapture={(event) => focusFrom(event, 2)}
      onPointerDownCapture={(event) => focusFrom(event, 2)}
    >
      <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border [scrollbar-width:none]" role="tablist" aria-label="Second editor group" data-editor-tabs-2>
        {group2.tabs.map((tab) => renderTab(tab, 2, tab.id === group2.activeId))}
        {tabTools}
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                variant="ghost"
                size="icon-xs"
                className="my-auto me-1 shrink-0"
                aria-label="Close group"
                onClick={() => {
                  for (const tab of group2.tabs) useEditorStore.getState().closeTab2(workspaceId, tab.id);
                }}
                data-editor-close-group
              >
                <X />
              </Button>
            )}
          />
          <TooltipContent>Close group (its tabs close; unsaved text stays until you reopen the file)</TooltipContent>
        </Tooltip>
      </div>
      {group2Error ? <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">{group2Error}</div> : null}
      <div className={cn("flex min-h-0 flex-1", (group2Error || group2Tab?.kind !== "file" || isImagePath(group2Tab.path)) && "hidden")}>
        <Group2Editor
          monaco={monaco}
          model={group2Tab?.kind === "file" && group2Doc?.path === group2Tab.path ? group2Doc.model : null}
          onSave={() => {
            if (group2Tab) void saveFile(group2Tab.path, "manual");
          }}
          onFocus={() => useEditorStore.getState().setFocusedGroup(2)}
          onAgentAction={agentAction}
          onReady={(editor) => {
            group2EditorRef.current = editor;
            setGroup2Ready(Boolean(editor));
            // Just split (Cmd/Ctrl+\): the new group takes the keyboard.
            if (editor && useEditorStore.getState().focusedGroup === 2) window.setTimeout(() => editor.focus(), 0);
          }}
        />
      </div>
      {group2Tab?.kind === "preview" && group2Doc && group2Doc.path === group2Tab.path ? (
        <MarkdownPreview
          client={client}
          workspaceId={workspaceId}
          path={group2Doc.path}
          model={group2Doc.model}
          isDirty={() => docs.isDirty(group2Doc)}
          onOpenFile={(path) => useEditorStore.getState().openTab2(workspaceId, { id: tabId({ kind: "file", path }), kind: "file", path })}
          onOpenExternal={(url) => void openDesktopUrl(url).catch(() => toast.error("Could not open the link."))}
        />
      ) : null}
      {group2Tab?.kind === "file" && isImagePath(group2Tab.path) ? <ImageView client={client} workspaceId={workspaceId} path={group2Tab.path} /> : null}
    </div>
  ) : null;

  const main = (
    <div className="flex h-full min-h-0 min-w-0 flex-col" ref={editorAreaRef}>
      <div className="flex min-h-0 flex-1">
        {/* Always a panel group, so splitting adds group 2 beside group 1 without rebuilding group 1's editor. */}
        <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0" groupRef={splitGroupRef}>
          <ResizablePanel id="editor-group-1" minSize={`${MIN_GROUP_PX}px`} className="min-h-0 min-w-0">{group1}</ResizablePanel>
          {group2View && splitAllowed ? (
            <>
              <ResizableHandle
                aria-label="Resize editor groups (double-click: equal widths)"
                onDoubleClick={() => splitGroupRef.current?.setLayout({ "editor-group-1": 50, "editor-group-2": 50 })}
              />
              <ResizablePanel id="editor-group-2" minSize={`${MIN_GROUP_PX}px`} className="min-h-0 min-w-0">{group2View}</ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </div>
      <div className="flex h-6 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-border px-3 text-[11px] text-muted-foreground" data-editor-status>
        {branch ? <span className="flex min-w-0 items-center gap-1 truncate"><GitBranch className="size-3 shrink-0" />{branch}</span> : null}
        {gitQuery.data?.repo ? <span className="shrink-0">{gitQuery.data.files.length} changed</span> : null}
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded px-1 hover:bg-muted hover:text-foreground"
          onClick={() => useEditorStore.getState().setProblemsOpen(!(problemsOpen && bottomTab === "problems"))}
          aria-label={`Problems: ${problemTotals.errors} errors, ${problemTotals.warnings} warnings`}
          title="Problems"
          data-editor-problem-counts
        >
          <CircleX className="size-3" />{problemTotals.errors}
          <AlertTriangle className="size-3" />{problemTotals.warnings}
        </button>
        <span className="flex-1" />
        {cursor && activeTab ? <span className="shrink-0 max-[1100px]:hidden">Ln {cursor.line}, Col {cursor.column}</span> : null}
        {activePath ? <span className="shrink-0 max-[1250px]:hidden">{surface?.kind === "image" ? `Image (${activePath.slice(activePath.lastIndexOf(".") + 1).toUpperCase()})` : surface?.kind === "preview" ? "Markdown preview" : languageForPath(activePath)}</span> : null}
        {activeTab?.kind === "file" && surface?.kind !== "image" ? <span className="shrink-0" data-editor-saved={activeDirty ? "0" : "1"}>{activeDirty ? "Unsaved" : "Saved"}</span> : null}
      </div>
    </div>
  );

  const railItem = (view: EditorSideView, label: string, icon: ReactNode, shortcut: string | null, badge?: number) => {
    const active = state.view === view && sideOpen;
    return (
      <Tooltip>
        <TooltipTrigger
          render={(
            <button
              type="button"
              onClick={() => setView(view)}
              data-editor-view={view}
              aria-label={label}
              aria-pressed={active}
              className={cn(
                "relative flex size-9 items-center justify-center rounded-lg transition-colors [&_svg]:size-[18px]",
                active ? "bg-primary/10 text-link" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {icon}
              {badge ? (
                <span className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-primary px-1 text-center text-[9px] font-semibold leading-3.5 text-primary-foreground">
                  {badge > 99 ? "99+" : badge}
                </span>
              ) : null}
            </button>
          )}
        />
        <TooltipContent side="right">{label}{shortcut ? ` (${shortcut})` : ""}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <div ref={panelRef} className="relative flex h-full min-h-0 bg-background" data-editor-panel data-editor-layout="ide">
      {/* The activity rail: the side views, quick open, and the app's own destinations at its foot. */}
      <nav aria-label="Editor views" className="flex w-12 shrink-0 flex-col items-center gap-1 border-e border-border py-2 mac:pt-10" data-editor-rail-views>
        {railItem("files", "Files", <Files />, mac ? "⌘⇧E" : "Ctrl+Shift+E")}
        {railItem("changes", "Agent changes", <FileDiff />, null, pendingCount)}
        {railItem("git", "Git", <GitBranch />, null, gitQuery.data?.repo ? gitQuery.data.files.length : undefined)}
        {railItem("search", "Search in files", <Search />, mac ? "⌘⇧F" : "Ctrl+Shift+F")}
        <span className="flex-1" />
        {props.railFoot}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2 max-lg:h-12 mac:titlebar-drag mac:ps-6 [&_button]:mac:titlebar-no-drag" data-editor-header>
        {props.headerStart}
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button variant="ghost" size="icon-sm" aria-label="Go to file" onClick={() => useEditorStore.getState().setQuickOpen(true)}>
                <FileCode2 />
              </Button>
            )}
          />
          <TooltipContent>Go to file ({mac ? "⌘P" : "Ctrl+P"})</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button variant="ghost" size="icon-sm" aria-label={sideOpen ? "Hide side bar" : "Show side bar"} onClick={() => useEditorStore.getState().setSideOpen(!sideOpen)}>
                {sideOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
              </Button>
            )}
          />
          <TooltipContent>{sideOpen ? "Hide side bar" : "Show side bar"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={props.terminalOpen ? "Hide terminal" : "Show terminal"}
                aria-pressed={props.terminalOpen}
                className={cn(props.terminalOpen && "bg-muted text-foreground")}
                onClick={props.onToggleTerminal}
              >
                <SquareTerminal />
              </Button>
            )}
          />
          <TooltipContent>Terminal ({mac ? "⌘J" : "Ctrl+J"})</TooltipContent>
        </Tooltip>
        {props.headerEnd}
      </div>
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel minSize="160px" className="min-h-0">
          <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0">
            {sideOpen ? (
              <>
                <ResizablePanel defaultSize="230px" minSize="160px" maxSize="50%" groupResizeBehavior="preserve-pixel-size" className="min-h-0">
                  {side}
                </ResizablePanel>
                <ResizableHandle />
              </>
            ) : null}
            <ResizablePanel minSize="240px" className="min-h-0 min-w-0">
              {main}
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        {(props.terminalOpen && props.terminal) || problemsOpen ? (
          // The bottom panel: Problems and the terminal, as tabs.
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize="220px" minSize="120px" maxSize="70%" className="min-h-0" data-editor-bottom-panel>
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-2 text-xs" role="tablist">
                  {[
                    { id: "problems" as const, label: `Problems${problemTotals.errors + problemTotals.warnings ? ` ${problemTotals.errors + problemTotals.warnings}` : ""}` },
                    { id: "terminal" as const, label: "Terminal" },
                  ].map((item) => {
                    const front = item.id === "problems" ? problemsOpen && (bottomTab === "problems" || !props.terminalOpen) : props.terminalOpen && (bottomTab === "terminal" || !problemsOpen);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={front}
                        data-editor-bottom-tab={item.id}
                        onClick={() => {
                          if (item.id === "problems") useEditorStore.getState().setProblemsOpen(true);
                          else {
                            if (!props.terminalOpen) props.onToggleTerminal();
                            useEditorStore.getState().setBottomTab("terminal");
                          }
                        }}
                        className={cn("rounded-md px-2 py-0.5", front ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                  <span className="flex-1" />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Close panel"
                    onClick={() => {
                      useEditorStore.getState().setProblemsOpen(false);
                      if (props.terminalOpen) props.onToggleTerminal();
                    }}
                  >
                    <X />
                  </Button>
                </div>
                <div className="min-h-0 flex-1">
                  {problemsOpen && (bottomTab === "problems" || !props.terminalOpen) ? (
                    <ProblemsView
                      workspaceId={workspaceId}
                      loading={problemsLoading}
                      onOpen={(path, line, column) => openAt(path, line, column)}
                      onFix={fixWithAgent}
                      onRefresh={() => {
                        setProblemsLoading(true);
                        void refreshAllDiagnostics().finally(() => setProblemsLoading(false));
                      }}
                    />
                  ) : props.terminal}
                </div>
              </div>
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
      </div>
      <Dialog open={Boolean(formatPrompt)} onOpenChange={(open) => !open && formatPrompt?.answer(null)}>
        <DialogContent className="max-w-lg" data-editor-format-trust>
          <DialogHeader>
            <DialogTitle>Run this project's formatter?</DialogTitle>
            <DialogDescription>
              Format on save would run {formatPrompt?.formatter} from this project{formatPrompt?.sandbox ? ", in the project's sandbox" : " on this computer"}. It is the
              project's own code (and its settings and plugins), so only allow it for projects you trust.
            </DialogDescription>
          </DialogHeader>
          <code className="block break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs" data-editor-format-command>{formatPrompt?.command}</code>
          <p className="text-xs text-muted-foreground">You are asked again if the formatter or its settings change.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => formatPrompt?.answer("never")}>No</Button>
            <Button variant="outline" onClick={() => formatPrompt?.answer("once")}>Allow once</Button>
            <Button onClick={() => formatPrompt?.answer("always")}>Always for this project</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {quickOpen ? (
        <QuickOpen
          files={files}
          recent={recentRef.current}
          onOpen={(path, side) => {
            useEditorStore.getState().setQuickOpen(false);
            const store = useEditorStore.getState();
            const inGroup2 = side ? splitAllowed : store.focusedGroup === 2 && Boolean(store.byWorkspace[workspaceId]?.group2);
            if (inGroup2) store.openTab2(workspaceId, { id: tabId({ kind: "file", path }), kind: "file", path });
            else openFile(path);
          }}
          onClose={() => useEditorStore.getState().setQuickOpen(false)}
        />
      ) : null}
    </div>
  );
}
