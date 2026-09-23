/** @jsxImportSource react */
import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { SidebarContextValue } from "../src/react-app/domains/session/sidebar/app-sidebar-provider";

// The app toaster is not mounted here; record what the menu reports instead.
const toasts: string[] = [];
mock.module("@/components/ui/sonner", () => ({
  toast: {
    success: (message: string) => toasts.push(`success:${message}`),
    error: (message: string, options?: { description?: string }) =>
      toasts.push(`error:${message}:${options?.description ?? ""}`),
  },
}));

if (typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined") {
  GlobalRegistrator.register({ url: "http://localhost/" });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const copied: string[] = [];
let clipboardFails = false;
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      if (clipboardFails) throw new Error("clipboard blocked");
      copied.push(text);
    },
  },
});

const [{ SessionContextMenu }, { SidebarContext }] = await Promise.all([
  import("../src/react-app/domains/session/sidebar/app-sidebar"),
  import("../src/react-app/domains/session/sidebar/app-sidebar-provider"),
]);

const noop = () => {};
const sidebarContext: SidebarContextValue = {
  selectedWorkspaceId: "ws-1",
  selectedSessionId: null,
  developerMode: false,
  newTaskDisabled: false,
  connectingWorkspaceId: null,
  workspaceConnectionStateById: {},
  onSelectWorkspace: noop,
  onOpenSession: noop,
  onCreateTaskInWorkspace: noop,
  onCreateSplitTaskInWorkspace: noop,
  onOpenRenameWorkspace: noop,
  onShareWorkspace: noop,
  onRevealWorkspace: noop,
  onRecoverWorkspace: noop,
  onTestWorkspaceConnection: noop,
  onEditWorkspaceConnection: noop,
  onForgetWorkspace: noop,
  expandWorkspace: noop,
  toggleWorkspaceExpanded: noop,
  expandedWorkspaceIds: new Set(),
  sessionNumberShortcutOs: "macos",
  sessionNumberShortcutByTarget: new Map(),
};

const mounted: { root: Root; container: HTMLElement }[] = [];

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  toasts.length = 0;
  copied.length = 0;
  clipboardFails = false;
});

async function waitFor<T>(read: () => T | null, label: string): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function copyFromSessionMenu(sessionId: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(
    <SidebarContext.Provider value={sidebarContext}>
      <SessionContextMenu sessionId={sessionId} workspaceId="ws-1" isPinned={false} isArchived={false}>
        <button type="button" data-testid="session-row">Session row</button>
      </SessionContextMenu>
    </SidebarContext.Provider>,
  ));

  const row = await waitFor(
    () => container.querySelector<HTMLElement>('[data-testid="session-row"]'),
    "the session row",
  );
  await act(async () => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  const item = await waitFor(
    () => document.body.querySelector<HTMLElement>("[data-session-menu-copy-id]"),
    "the Copy session ID menu item",
  );
  expect(item.textContent).toContain("Copy session ID");
  await act(async () => {
    item.click();
  });
  await waitFor(() => (toasts.length > 0 ? toasts : null), "the copy toast");
}

test("the sidebar session menu copies the session ID and confirms with a toast", async () => {
  await copyFromSessionMenu("ses_menu_copy_1");

  expect(copied).toEqual(["ses_menu_copy_1"]);
  expect(toasts).toEqual(["success:Session ID copied"]);
});

test("a blocked clipboard still shows the session ID so it can be copied by hand", async () => {
  clipboardFails = true;
  await copyFromSessionMenu("ses_menu_copy_2");

  expect(copied).toEqual([]);
  expect(toasts).toEqual(["error:Couldn't copy the session ID:ses_menu_copy_2"]);
});
