// Terminal tabs per workspace. The tab list (names, shells, which one is
// active) lives here for the whole app run and is saved to localStorage, so
// a restart brings the same tabs back; their shells start again only when a
// tab is first shown. The shells themselves live in terminal-runtime.ts.
import { create } from "zustand";

export type TerminalTab = {
  id: string;
  name: string;
  /** The shell the tab started with (the desktop's shell list id); null = default. */
  shellId: string | null;
};

export type WorkspaceTerminalTabs = {
  tabs: TerminalTab[];
  activeId: string | null;
  /** Number for the next default tab name ("Terminal 3"). */
  nextNumber: number;
};

type SavedTabs = Record<string, { tabs: Array<{ name: string; shellId: string | null }>; active: number }>;

export const TERMINAL_TABS_STORAGE_KEY = "omnirush.terminal-tabs.v1";
const MAX_NAME_CHARS = 60;

let tabCounter = 0;
const newTabId = () => `tab_${Date.now().toString(36)}_${(tabCounter += 1)}`;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readSaved(): SavedTabs {
  let parsed: unknown = null;
  try {
    const raw = storage()?.getItem(TERMINAL_TABS_STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return {};
  }
  const saved: SavedTabs = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return saved;
  for (const [workspaceId, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || !Array.isArray(value.tabs)) continue;
    const tabs = value.tabs.flatMap((tab: unknown) => {
      if (!tab || typeof tab !== "object" || !("name" in tab) || typeof tab.name !== "string") return [];
      return [{ name: tab.name, shellId: "shellId" in tab && typeof tab.shellId === "string" ? tab.shellId : null }];
    });
    if (tabs.length) saved[workspaceId] = { tabs, active: "active" in value && typeof value.active === "number" ? value.active : 0 };
  }
  return saved;
}

/** Saves the loaded workspaces' tabs over the saved ones; workspaces not loaded this run keep theirs. */
function writeSaved(byWorkspace: Record<string, WorkspaceTerminalTabs>, forget?: string) {
  const saved = readSaved();
  if (forget) delete saved[forget];
  for (const [workspaceId, entry] of Object.entries(byWorkspace)) {
    if (!entry.tabs.length) {
      delete saved[workspaceId];
      continue;
    }
    saved[workspaceId] = {
      tabs: entry.tabs.map(({ name, shellId }) => ({ name, shellId })),
      active: Math.max(0, entry.tabs.findIndex((tab) => tab.id === entry.activeId)),
    };
  }
  try {
    storage()?.setItem(TERMINAL_TABS_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Private mode or a full quota: tabs still work for this run.
  }
}

/** The saved tabs of one workspace, as fresh tab entries (no shell yet). */
function restore(workspaceId: string): WorkspaceTerminalTabs | null {
  const saved = readSaved()[workspaceId];
  if (!saved) return null;
  const tabs = saved.tabs.map((tab) => ({ id: newTabId(), name: cleanName(tab.name) || "Terminal", shellId: tab.shellId }));
  const active = tabs[Math.min(Math.max(0, Math.floor(saved.active)), tabs.length - 1)];
  const numbers = tabs.map((tab) => /^Terminal (\d+)$/.exec(tab.name)?.[1]).filter(Boolean).map(Number);
  return { tabs, activeId: active.id, nextNumber: Math.max(tabs.length, ...numbers) + 1 };
}

export function cleanName(name: string) {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
}

type TerminalTabsState = {
  byWorkspace: Record<string, WorkspaceTerminalTabs>;
  /** Pending "new tab" requests from the keyboard shortcut, consumed by the open dock. */
  newTabRequests: number;
  /** The workspace's tabs, restored from the last run on first use. */
  ensure: (workspaceId: string) => WorkspaceTerminalTabs;
  addTab: (workspaceId: string, shellId?: string | null) => TerminalTab;
  /** Removes a tab; returns the tabs left in that workspace. */
  closeTab: (workspaceId: string, tabId: string) => number;
  renameTab: (workspaceId: string, tabId: string, name: string) => void;
  setActive: (workspaceId: string, tabId: string) => void;
  /** Moves the active tab by `step` (wrapping). */
  cycle: (workspaceId: string, step: number) => void;
  /** Forgets a removed workspace's tabs; returns their ids. */
  forgetWorkspace: (workspaceId: string) => string[];
  requestNewTab: () => void;
  takeNewTabRequest: () => boolean;
};

const empty = (): WorkspaceTerminalTabs => ({ tabs: [], activeId: null, nextNumber: 1 });

export const useTerminalTabsStore = create<TerminalTabsState>((set, get) => {
  const update = (workspaceId: string, next: WorkspaceTerminalTabs) => {
    const byWorkspace = { ...get().byWorkspace, [workspaceId]: next };
    set({ byWorkspace });
    writeSaved(byWorkspace);
  };
  const current = (workspaceId: string) => get().ensure(workspaceId);

  return {
    byWorkspace: {},
    newTabRequests: 0,

    ensure(workspaceId) {
      const known = get().byWorkspace[workspaceId];
      if (known) return known;
      const entry = restore(workspaceId) ?? empty();
      set({ byWorkspace: { ...get().byWorkspace, [workspaceId]: entry } });
      return entry;
    },

    addTab(workspaceId, shellId = null) {
      const entry = current(workspaceId);
      const tab = { id: newTabId(), name: `Terminal ${entry.nextNumber}`, shellId };
      update(workspaceId, { tabs: [...entry.tabs, tab], activeId: tab.id, nextNumber: entry.nextNumber + 1 });
      return tab;
    },

    closeTab(workspaceId, tabId) {
      const entry = current(workspaceId);
      const index = entry.tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return entry.tabs.length;
      const tabs = entry.tabs.filter((tab) => tab.id !== tabId);
      const activeId = entry.activeId !== tabId ? entry.activeId : (tabs[Math.min(index, tabs.length - 1)]?.id ?? null);
      // Numbering starts over once every tab is closed.
      update(workspaceId, { tabs, activeId, nextNumber: tabs.length ? entry.nextNumber : 1 });
      return tabs.length;
    },

    renameTab(workspaceId, tabId, name) {
      const entry = current(workspaceId);
      const clean = cleanName(name);
      if (!clean) return;
      update(workspaceId, { ...entry, tabs: entry.tabs.map((tab) => (tab.id === tabId ? { ...tab, name: clean } : tab)) });
    },

    setActive(workspaceId, tabId) {
      const entry = current(workspaceId);
      if (entry.activeId === tabId || !entry.tabs.some((tab) => tab.id === tabId)) return;
      update(workspaceId, { ...entry, activeId: tabId });
    },

    cycle(workspaceId, step) {
      const entry = current(workspaceId);
      if (entry.tabs.length < 2) return;
      const index = entry.tabs.findIndex((tab) => tab.id === entry.activeId);
      const next = entry.tabs[(index + step + entry.tabs.length) % entry.tabs.length];
      update(workspaceId, { ...entry, activeId: next.id });
    },

    forgetWorkspace(workspaceId) {
      const entry = get().byWorkspace[workspaceId] ?? restore(workspaceId);
      const byWorkspace = { ...get().byWorkspace };
      delete byWorkspace[workspaceId];
      set({ byWorkspace });
      writeSaved(byWorkspace, workspaceId);
      return entry?.tabs.map((tab) => tab.id) ?? [];
    },

    requestNewTab() {
      set({ newTabRequests: get().newTabRequests + 1 });
    },

    takeNewTabRequest() {
      if (!get().newTabRequests) return false;
      set({ newTabRequests: get().newTabRequests - 1 });
      return true;
    },
  };
});
