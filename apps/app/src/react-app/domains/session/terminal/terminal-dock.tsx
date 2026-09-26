/** @jsxImportSource react */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isElectronRuntime } from "../../../../app/utils";
import { desktopTerminalBridge, showTerminalTab, disposeTerminalTab, useTerminalStatusStore } from "./terminal-runtime";
import { useTerminalTabsStore, type TerminalTab } from "./terminal-tabs-store";

type TerminalDockProps = {
  workspaceId: string;
  workspaceRoot: string;
  isRemoteWorkspace: boolean;
  onClose: () => void;
};

const NEW_TAB_HINT = "New terminal (Ctrl+Shift+`)";

export function TerminalDock({ workspaceId, workspaceRoot, isRemoteWorkspace, onClose }: TerminalDockProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bridge = isElectronRuntime() && !isRemoteWorkspace ? desktopTerminalBridge() : null;
  const unavailable = !isElectronRuntime()
    ? "Terminal is available in the desktop app."
    : isRemoteWorkspace
      ? "Remote workspace terminals are not wired yet."
      : bridge
        ? null
        : "Terminal bridge is unavailable.";

  const entry = useTerminalTabsStore((state) => state.byWorkspace[workspaceId]);
  const newTabRequests = useTerminalTabsStore((state) => state.newTabRequests);
  const statuses = useTerminalStatusStore((state) => state.status);
  const [shells, setShells] = useState<Array<{ id: string; label: string }>>([]);
  const [renaming, setRenaming] = useState<string | null>(null);

  const tabs = entry?.tabs ?? [];
  const active = tabs.find((tab) => tab.id === entry?.activeId) ?? null;

  // The workspace's tabs (restored from the last run), and a first tab when it has none.
  useEffect(() => {
    if (unavailable || !workspaceId) return;
    const store = useTerminalTabsStore.getState();
    const current = store.ensure(workspaceId);
    if (!current.tabs.length) {
      store.takeNewTabRequest();
      store.addTab(workspaceId);
    }
  }, [unavailable, workspaceId]);

  // Ctrl+Shift+` asked for a new tab.
  useEffect(() => {
    if (unavailable || !workspaceId || !newTabRequests) return;
    const store = useTerminalTabsStore.getState();
    if (store.takeNewTabRequest()) store.addTab(workspaceId);
  }, [newTabRequests, unavailable, workspaceId]);

  useEffect(() => {
    if (!bridge?.shells) return;
    let cancelled = false;
    void bridge.shells().then((list) => {
      if (!cancelled) setShells(list);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge?.shells]);

  // Shows the active tab; the others keep running out of view.
  const activeId = active?.id ?? null;
  const activeShell = active?.shellId ?? null;
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !bridge || !activeId) return;
    return showTerminalTab({ tabId: activeId, container, bridge, workspaceId, cwd: workspaceRoot, shellId: activeShell, focus: !renaming });
  }, [activeId, bridge?.create, workspaceId, workspaceRoot, activeShell]);

  const addTab = (shellId: string | null = null) => {
    useTerminalTabsStore.getState().addTab(workspaceId, shellId);
  };
  const closeTab = (tab: TerminalTab) => {
    disposeTerminalTab(tab.id, bridge);
    const left = useTerminalTabsStore.getState().closeTab(workspaceId, tab.id);
    if (!left) onClose();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Ctrl+PageUp / Ctrl+PageDown switch tabs while the terminal has focus.
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      useTerminalTabsStore.getState().cycle(workspaceId, event.key === "PageDown" ? 1 : -1);
    }
  };

  const status = activeId ? statuses[activeId] : undefined;

  return (
    <section
      className="flex h-full min-h-0 flex-col border-t border-border bg-[#0b0d12] text-white"
      aria-label="Terminal"
      onKeyDownCapture={onKeyDown}
    >
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-white/10 bg-black/35 px-2 text-xs">
        {unavailable ? (
          <div className="min-w-0 flex-1 truncate px-1 text-white/75">Terminal · {unavailable}</div>
        ) : (
          <>
            <div role="tablist" aria-label="Terminal tabs" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {tabs.map((tab) => (
                <TerminalTabButton
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeId}
                  renaming={renaming === tab.id}
                  exited={statuses[tab.id]?.state === "exited"}
                  onSelect={() => useTerminalTabsStore.getState().setActive(workspaceId, tab.id)}
                  onClose={() => closeTab(tab)}
                  onStartRename={() => setRenaming(tab.id)}
                  onRename={(name) => {
                    useTerminalTabsStore.getState().renameTab(workspaceId, tab.id, name);
                    setRenaming(null);
                  }}
                  onCancelRename={() => setRenaming(null)}
                />
              ))}
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-white/70 hover:bg-white/10 hover:text-white"
                onClick={() => addTab()}
                title={NEW_TAB_HINT}
                aria-label="New terminal"
              >
                <Plus className="size-4" />
              </Button>
              {shells.length > 1 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={(
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="-ml-1 shrink-0 text-white/70 hover:bg-white/10 hover:text-white"
                        aria-label="New terminal with a shell"
                        title="New terminal with…"
                      >
                        <ChevronDown className="size-3.5" />
                      </Button>
                    )}
                  />
                  <DropdownMenuContent className="w-48">
                    {shells.map((shell) => (
                      <DropdownMenuItem key={shell.id} onClick={() => addTab(shell.id)}>
                        <span className="truncate">{shell.label}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
            <div className="hidden max-w-[40%] shrink truncate px-2 text-white/45 md:block" title={status?.text}>
              {status?.text}
            </div>
          </>
        )}
        <Button variant="ghost" size="icon-sm" className="shrink-0 text-white/70 hover:bg-white/10 hover:text-white" onClick={onClose}>
          <X className="size-4" />
          <span className="sr-only">Hide terminal</span>
        </Button>
      </header>
      <div ref={containerRef} className="min-h-0 flex-1 px-2 py-1 [&_.xterm]:h-full" />
    </section>
  );
}

function TerminalTabButton(props: {
  tab: TerminalTab;
  active: boolean;
  renaming: boolean;
  exited: boolean;
  onSelect: () => void;
  onClose: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const [draft, setDraft] = useState(props.tab.name);
  useEffect(() => {
    if (props.renaming) setDraft(props.tab.name);
  }, [props.renaming, props.tab.name]);

  if (props.renaming) {
    return (
      <input
        autoFocus
        aria-label="Terminal name"
        className="h-6 w-32 shrink-0 rounded border border-white/30 bg-black/60 px-1.5 text-xs text-white outline-none"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={() => props.onRename(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") props.onRename(draft);
          if (event.key === "Escape") props.onCancelRename();
          event.stopPropagation();
        }}
      />
    );
  }
  return (
    <div
      role="tab"
      aria-selected={props.active}
      tabIndex={0}
      title={`${props.tab.name} (double-click to rename)`}
      className={`group flex h-6 max-w-44 shrink-0 cursor-default items-center gap-1 rounded pl-2 pr-1 ${props.active ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`}
      onClick={props.onSelect}
      onDoubleClick={props.onStartRename}
      onAuxClick={(event) => {
        if (event.button === 1) props.onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") props.onSelect();
        if (event.key === "F2") props.onStartRename();
      }}
    >
      <span className={`truncate ${props.exited ? "line-through opacity-60" : ""}`}>{props.tab.name}</span>
      <button
        type="button"
        aria-label={`Close ${props.tab.name}`}
        className={`flex size-4 items-center justify-center rounded hover:bg-white/20 ${props.active ? "opacity-80" : "opacity-0 group-hover:opacity-80"}`}
        onClick={(event) => {
          event.stopPropagation();
          props.onClose();
        }}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
