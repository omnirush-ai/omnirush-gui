import { describe, expect, test } from "bun:test";

import {
  buildCommandPaletteSplitSessions,
  buildCopySessionIdPaletteItem,
} from "../src/react-app/shell/command-palette-sessions";
import type { SessionOption } from "../src/react-app/shell/command-palette";

const sessions: SessionOption[] = [
  {
    workspaceId: "workspace-a",
    sessionId: "session-a",
    title: "Current",
    workspaceTitle: "Workspace A",
    updatedAt: 3,
    searchText: "current workspace a",
    isActive: true,
  },
  {
    workspaceId: "workspace-a",
    sessionId: "session-b",
    title: "Same workspace",
    workspaceTitle: "Workspace A",
    updatedAt: 2,
    searchText: "same workspace a",
    isActive: true,
  },
  {
    workspaceId: "workspace-b",
    sessionId: "session-a",
    title: "Same ID, other workspace",
    workspaceTitle: "Workspace B",
    updatedAt: 1,
    searchText: "same id workspace b",
    isActive: false,
  },
];

describe("command palette split sessions", () => {
  test("offers same-workspace and cross-workspace sessions but not the current session", () => {
    const options = buildCommandPaletteSplitSessions(sessions, {
      workspaceId: "workspace-a",
      sessionId: "session-a",
    });

    expect(options.map((option) => `${option.workspaceId}/${option.sessionId}`)).toEqual([
      "workspace-a/session-b",
      "workspace-b/session-a",
    ]);
    expect(options.some((option) => option.workspaceTitle === "Workspace B")).toBe(true);
    expect(options.some((option) => option.workspaceId === "workspace-a" && option.sessionId === "session-a")).toBe(false);
  });
});

describe("command palette Copy session ID", () => {
  test("is enabled with the selected session and copies its ID", () => {
    const copied: string[] = [];
    const item = buildCopySessionIdPaletteItem("ses_selected_1", (sessionId) => copied.push(sessionId));

    expect(item.title).toBe("Copy session ID");
    expect(item.disabled).toBe(false);
    expect(item.detail).toBe("ses_selected_1");
    item.action();
    expect(copied).toEqual(["ses_selected_1"]);
  });

  test("stays listed but disabled until a session is selected", () => {
    for (const selected of [null, undefined, "", "   "]) {
      const copied: string[] = [];
      const item = buildCopySessionIdPaletteItem(selected, (sessionId) => copied.push(sessionId));

      expect(item.id).toBe("session.copy-id");
      expect(item.disabled).toBe(true);
      expect(item.detail).toBe("Open a session to copy its ID");
      item.action();
      expect(copied).toEqual([]);
    }
  });
});
