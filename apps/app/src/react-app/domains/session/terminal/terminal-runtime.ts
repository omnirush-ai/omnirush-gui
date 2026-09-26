// The live side of terminal tabs: one xterm and (once the tab is first shown)
// one desktop shell per tab, kept for the whole app run so hiding the dock
// or switching workspaces never loses a shell or its scrollback. The dock
// only moves a tab's xterm element in and out of view.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { create } from "zustand";
import { useTerminalTabsStore } from "./terminal-tabs-store";

export type TerminalBridge = {
  create: (options: { cwd: string; cols: number; rows: number; workspaceId?: string; shellId?: string | null }) => Promise<{ terminalId: string; shellLabel?: string; cwd?: string }>;
  write: (terminalId: string, data: string) => Promise<void>;
  resize: (terminalId: string, cols: number, rows: number) => Promise<void>;
  kill: (terminalId: string) => Promise<void>;
  onData: (callback: (payload: { terminalId: string; data: string }) => void) => () => void;
  onExit: (callback: (payload: { terminalId: string; exitCode: number | null; signal?: number }) => void) => () => void;
  killWorkspace?: (workspaceId: string) => Promise<void>;
  shells?: () => Promise<Array<{ id: string; label: string }>>;
};

export type TerminalTabStatus = { state: "idle" | "starting" | "running" | "exited" | "error"; text: string };

type Live = {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  opened: boolean;
  terminalId: string | null;
  exited: boolean;
  starting: boolean;
  disposed: boolean;
  options: { workspaceId: string; cwd: string; shellId: string | null };
};

/** Per-tab status line for the dock. */
export const useTerminalStatusStore = create<{ status: Record<string, TerminalTabStatus> }>(() => ({ status: {} }));

function setStatus(tabId: string, status: TerminalTabStatus | null) {
  const next = { ...useTerminalStatusStore.getState().status };
  if (status) next[tabId] = status;
  else delete next[tabId];
  useTerminalStatusStore.setState({ status: next });
}

const live = new Map<string, Live>();
const byTerminalId = new Map<string, string>();
let bridgeListeners: { onData: TerminalBridge["onData"]; off: () => void } | null = null;

function listen(bridge: TerminalBridge) {
  if (bridgeListeners?.onData === bridge.onData) return;
  bridgeListeners?.off();
  const offData = bridge.onData(({ terminalId, data }) => {
    const tabId = byTerminalId.get(terminalId);
    if (tabId) live.get(tabId)?.term.write(data);
  });
  const offExit = bridge.onExit(({ terminalId, exitCode }) => {
    const tabId = byTerminalId.get(terminalId);
    byTerminalId.delete(terminalId);
    const entry = tabId ? live.get(tabId) : undefined;
    if (!tabId || !entry) return;
    entry.terminalId = null;
    entry.exited = true;
    entry.term.write(`\r\n\x1b[2m[Process exited${exitCode === null ? "" : ` with code ${exitCode}`}. Press Enter to start a new shell.]\x1b[0m\r\n`);
    setStatus(tabId, { state: "exited", text: `Exited${exitCode === null ? "" : ` (${exitCode})`}` });
  });
  bridgeListeners = { onData: bridge.onData, off: () => { offData(); offExit(); } };
}

function makeLive(tabId: string, bridge: TerminalBridge, options: Live["options"]): Live {
  const host = document.createElement("div");
  host.className = "h-full w-full";
  host.dataset.terminalTab = tabId;
  const term = new Terminal({
    cursorBlink: true,
    convertEol: true,
    scrollback: 5000,
    fontFamily: "'SFMono-Regular', 'Cascadia Code', 'Liberation Mono', Menlo, monospace",
    fontSize: 12,
    theme: {
      background: "#0b0d12",
      foreground: "#d7dde8",
      cursor: "#ffffff",
      selectionBackground: "#334155",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const entry: Live = { term, fit, host, opened: false, terminalId: null, exited: false, starting: false, disposed: false, options };
  term.onData((data) => {
    if (entry.terminalId) {
      void bridge.write(entry.terminalId, data);
      return;
    }
    if (entry.exited && (data === "\r" || data === "\n")) {
      entry.exited = false;
      term.clear();
      void start(tabId, bridge);
    }
  });
  live.set(tabId, entry);
  return entry;
}

async function start(tabId: string, bridge: TerminalBridge) {
  const entry = live.get(tabId);
  if (!entry || entry.starting || entry.terminalId || entry.disposed) return;
  entry.starting = true;
  setStatus(tabId, { state: "starting", text: "Starting…" });
  try {
    const { terminalId, shellLabel, cwd } = await bridge.create({
      cwd: entry.options.cwd,
      cols: entry.term.cols,
      rows: entry.term.rows,
      workspaceId: entry.options.workspaceId,
      shellId: entry.options.shellId,
    });
    if (entry.disposed) {
      void bridge.kill(terminalId);
      return;
    }
    entry.terminalId = terminalId;
    byTerminalId.set(terminalId, tabId);
    setStatus(tabId, { state: "running", text: [shellLabel, cwd ?? entry.options.cwd].filter(Boolean).join(" · ") });
    fitTab(tabId, bridge);
  } catch (error) {
    setStatus(tabId, { state: "error", text: error instanceof Error ? error.message : "Could not start the terminal." });
  } finally {
    entry.starting = false;
  }
}

function fitTab(tabId: string, bridge: TerminalBridge) {
  const entry = live.get(tabId);
  if (!entry?.opened || !entry.host.isConnected) return;
  try {
    entry.fit.fit();
  } catch {
    return;
  }
  if (entry.terminalId) void bridge.resize(entry.terminalId, entry.term.cols, entry.term.rows);
}

/**
 * Shows a tab in `container`: creates its xterm on first use and starts its
 * shell (lazily, only for a tab someone looks at). Returns the detach
 * function, which keeps the shell and scrollback for the next show.
 */
export function showTerminalTab(input: {
  tabId: string;
  container: HTMLElement;
  bridge: TerminalBridge;
  workspaceId: string;
  cwd: string;
  shellId: string | null;
  focus?: boolean;
}): () => void {
  const { tabId, container, bridge } = input;
  listen(bridge);
  const entry = live.get(tabId) ?? makeLive(tabId, bridge, { workspaceId: input.workspaceId, cwd: input.cwd, shellId: input.shellId });
  container.appendChild(entry.host);
  if (!entry.opened) {
    entry.term.open(entry.host);
    entry.opened = true;
  }
  fitTab(tabId, bridge);
  if (!entry.terminalId && !entry.exited) void start(tabId, bridge);
  if (input.focus !== false) entry.term.focus();
  const observer = new ResizeObserver(() => fitTab(tabId, bridge));
  observer.observe(container);
  return () => {
    observer.disconnect();
    if (entry.host.parentElement === container) container.removeChild(entry.host);
  };
}

/** Ends a tab's shell and drops its xterm. */
export function disposeTerminalTab(tabId: string, bridge: TerminalBridge | null) {
  const entry = live.get(tabId);
  live.delete(tabId);
  setStatus(tabId, null);
  if (!entry) return;
  entry.disposed = true;
  if (entry.terminalId) {
    byTerminalId.delete(entry.terminalId);
    void bridge?.kill(entry.terminalId);
  }
  entry.host.remove();
  entry.term.dispose();
}

/** Ends every shell of a workspace (it is being removed), including tabs never shown. */
export async function disposeWorkspaceTerminals(workspaceId: string, tabIds: string[], bridge: TerminalBridge | null) {
  for (const tabId of tabIds) disposeTerminalTab(tabId, bridge);
  for (const [tabId, entry] of live) {
    if (entry.options.workspaceId === workspaceId) disposeTerminalTab(tabId, bridge);
  }
  await bridge?.killWorkspace?.(workspaceId);
}

/** Whether a tab has a running shell (for tests and the dock). */
export function terminalTabRunning(tabId: string) {
  return Boolean(live.get(tabId)?.terminalId);
}

/** The desktop's terminal bridge, or null outside the desktop app (or an older preload). */
export function desktopTerminalBridge(): TerminalBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.__OMNIRUSH_ELECTRON__?.terminal;
  if (!bridge?.create || !bridge.write || !bridge.resize || !bridge.kill || !bridge.onData || !bridge.onExit) return null;
  return {
    create: bridge.create,
    write: bridge.write,
    resize: bridge.resize,
    kill: bridge.kill,
    onData: bridge.onData,
    onExit: bridge.onExit,
    ...(bridge.killWorkspace ? { killWorkspace: bridge.killWorkspace } : {}),
    ...(bridge.shells ? { shells: bridge.shells } : {}),
  };
}

/** A workspace is being removed: its tabs are forgotten and every shell it had ends. */
export async function closeWorkspaceTerminals(workspaceId: string) {
  const tabIds = useTerminalTabsStore.getState().forgetWorkspace(workspaceId);
  await disposeWorkspaceTerminals(workspaceId, tabIds, desktopTerminalBridge());
}
