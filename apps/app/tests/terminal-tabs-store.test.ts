import { beforeEach, describe, expect, test } from "bun:test";

import { TERMINAL_TABS_STORAGE_KEY, useTerminalTabsStore } from "../src/react-app/domains/session/terminal/terminal-tabs-store";
import { isNewTerminalShortcut } from "../src/react-app/shell/use-shell-shortcuts";
import { removeRouteWorkspace } from "../src/react-app/shell/route-workspaces";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

const memory = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { value: memory, configurable: true });

const store = () => useTerminalTabsStore.getState();
const names = (workspaceId: string) => store().ensure(workspaceId).tabs.map((tab) => tab.name);
/** A new app run: nothing loaded yet, only what was saved. */
const restart = () => useTerminalTabsStore.setState({ byWorkspace: {}, newTabRequests: 0 });

beforeEach(() => {
  memory.data.clear();
  restart();
});

describe("terminal tabs", () => {
  test("each workspace has its own tabs: new, switch, rename, close", () => {
    const one = store().addTab("ws_a");
    const two = store().addTab("ws_a", "cmd");
    store().addTab("ws_b");
    expect(names("ws_a")).toEqual(["Terminal 1", "Terminal 2"]);
    expect(names("ws_b")).toEqual(["Terminal 1"]);
    expect(store().ensure("ws_a").activeId).toBe(two.id);
    expect(store().ensure("ws_a").tabs[1].shellId).toBe("cmd");

    store().setActive("ws_a", one.id);
    expect(store().ensure("ws_a").activeId).toBe(one.id);
    store().cycle("ws_a", 1);
    expect(store().ensure("ws_a").activeId).toBe(two.id);
    store().cycle("ws_a", 1);
    expect(store().ensure("ws_a").activeId).toBe(one.id);

    store().renameTab("ws_a", one.id, "  dev   server  ");
    expect(names("ws_a")).toEqual(["dev server", "Terminal 2"]);
    store().renameTab("ws_a", one.id, "   ");
    expect(names("ws_a")).toEqual(["dev server", "Terminal 2"]);

    // Closing the active tab activates its neighbour; the next new tab keeps counting.
    expect(store().closeTab("ws_a", one.id)).toBe(1);
    expect(store().ensure("ws_a").activeId).toBe(two.id);
    store().addTab("ws_a");
    expect(names("ws_a")).toEqual(["Terminal 2", "Terminal 3"]);
    // Once every tab is closed, numbering starts over.
    for (const tab of store().ensure("ws_a").tabs) store().closeTab("ws_a", tab.id);
    expect(store().ensure("ws_a").activeId).toBeNull();
    store().addTab("ws_a");
    expect(names("ws_a")).toEqual(["Terminal 1"]);
    expect(names("ws_b")).toEqual(["Terminal 1"]);
  });

  test("tab names, shells and the active tab come back after a restart; other workspaces keep theirs", () => {
    const first = store().addTab("ws_a");
    store().addTab("ws_a", "pwsh");
    store().renameTab("ws_a", first.id, "server");
    store().setActive("ws_a", first.id);
    store().addTab("ws_b");

    restart();
    // Touching one workspace saves it without dropping the other's saved tabs.
    store().addTab("ws_b");
    restart();
    const a = store().ensure("ws_a");
    expect(a.tabs.map((tab) => [tab.name, tab.shellId])).toEqual([["server", null], ["Terminal 2", "pwsh"]]);
    expect(a.activeId).toBe(a.tabs[0].id);
    expect(names("ws_b")).toEqual(["Terminal 1", "Terminal 2"]);
    store().addTab("ws_a");
    expect(names("ws_a")).toEqual(["server", "Terminal 2", "Terminal 3"]);
  });

  test("a removed workspace's tabs are forgotten, saved ones too", () => {
    store().addTab("ws_a");
    store().addTab("ws_b");
    restart();
    // ws_a was never loaded in this run.
    expect(store().forgetWorkspace("ws_a")).toHaveLength(1);
    restart();
    expect(names("ws_a")).toEqual([]);
    expect(names("ws_b")).toEqual(["Terminal 1"]);
    expect(Object.keys(JSON.parse(memory.getItem(TERMINAL_TABS_STORAGE_KEY) ?? "{}"))).toEqual(["ws_b"]);
  });

  test("broken saved data is ignored", () => {
    memory.setItem(TERMINAL_TABS_STORAGE_KEY, "{not json");
    expect(names("ws_a")).toEqual([]);
    memory.setItem(TERMINAL_TABS_STORAGE_KEY, JSON.stringify({ ws_a: { tabs: [{ name: 5 }, { name: "ok", shellId: 3 }], active: 9 } }));
    restart();
    const a = store().ensure("ws_a");
    expect(a.tabs.map((tab) => [tab.name, tab.shellId])).toEqual([["ok", null]]);
    expect(a.activeId).toBe(a.tabs[0].id);
  });

  test("the new-terminal shortcut is Ctrl+Shift+` and queues one tab per press", () => {
    const key = { ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: "Backquote" };
    expect(isNewTerminalShortcut(key)).toBe(true);
    expect(isNewTerminalShortcut({ ...key, shiftKey: false })).toBe(false);
    expect(isNewTerminalShortcut({ ...key, metaKey: true })).toBe(false);
    expect(isNewTerminalShortcut({ ...key, code: "KeyT" })).toBe(false);
    store().requestNewTab();
    expect(store().takeNewTabRequest()).toBe(true);
    expect(store().takeNewTabRequest()).toBe(false);
  });

  test("removing a workspace ends its terminals before the server removes the folder", async () => {
    const order: string[] = [];
    await removeRouteWorkspace({
      workspaceId: "ws_1",
      closeTerminals: async (id) => { order.push(`terminals ${id}`); },
      deleteFromServer: async (id) => { order.push(`server ${id}`); },
      forgetOnDesktop: async (id) => { order.push(`desktop ${id}`); },
    });
    expect(order).toEqual(["terminals ws_1", "server ws_1", "desktop ws_1"]);
  });
});
