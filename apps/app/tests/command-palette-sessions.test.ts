import { describe, expect, test } from "bun:test";

import { t } from "../src/i18n";
import type { SessionOption } from "../src/react-app/shell/command-palette";
import { rankPaletteItems, type PaletteItem } from "../src/react-app/shell/command-palette-search";
import {
  buildCommandPaletteSplitSessions,
  buildCopySessionIdPaletteItem,
} from "../src/react-app/shell/command-palette-sessions";

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
  test("shows the focused session's ID and copies it", () => {
    const copied: string[] = [];
    const item = buildCopySessionIdPaletteItem("ses_selected_1", (sessionId) => copied.push(sessionId));

    expect(item?.title).toBe("Session ID");
    expect(item?.detail).toBe("ses_selected_1");
    expect(item?.meta).toBe("Copy");
    item?.action();
    expect(copied).toEqual(["ses_selected_1"]);
  });

  test("is not offered until a session is focused", () => {
    for (const focused of [null, undefined, "", "   "]) {
      expect(buildCopySessionIdPaletteItem(focused, () => {})).toBeNull();
    }
  });

  test("leaves copy, debug, report and share queries to the diagnostics items", () => {
    // Mirrors the diagnostics items in session-route.tsx.
    const diagnostics: PaletteItem[] = [
      {
        id: "diagnostics.copy",
        title: t("session.cmd_diagnostics_copy_title"),
        detail: t("session.cmd_diagnostics_copy_detail"),
        searchText: "logs share diagnostics debug support bundle troubleshoot copy report issue",
        action: () => {},
      },
      {
        id: "diagnostics.export",
        title: t("session.cmd_diagnostics_export_title"),
        detail: t("session.cmd_diagnostics_export_detail"),
        searchText: "logs export diagnostics debug support bundle save file json download",
        action: () => {},
      },
    ];
    const ranked = (sessionId: string, query: string, recentIds: string[] = []) => {
      const copySessionId = buildCopySessionIdPaletteItem(sessionId, () => {});
      return rankPaletteItems(query, copySessionId ? [copySessionId, ...diagnostics] : diagnostics, recentIds)
        .flatMap((group) => group.items.map((item) => item.id));
    };
    const sessionId = "ses_5e0a1b2c3d4eAbCdEfGhIjKlMn";

    expect(ranked(sessionId, "copy")).toEqual(["diagnostics.copy", "session.copy-id"]);
    expect(ranked(sessionId, "debug")).toEqual(["diagnostics.export", "diagnostics.copy"]);
    expect(ranked(sessionId, "report")).toEqual(["diagnostics.copy", "diagnostics.export"]);
    expect(ranked(sessionId, "report issue")).toEqual(["diagnostics.copy", "diagnostics.export"]);
    expect(ranked(sessionId, "share")).toEqual(["diagnostics.copy"]);
    for (const query of ["session id", "copy session id", "copy id"]) {
      expect(ranked(sessionId, query)[0]).toBe("session.copy-id");
    }

    // A recent use does not change that, nor does an ID that spells out the
    // query words: the ID only matches on the detail line.
    for (const query of ["copy", "debug", "report", "report issue", "share"]) {
      expect(ranked(sessionId, query, ["session.copy-id"])).toEqual(ranked(sessionId, query));
      const ids = ranked("ses_copy_debug_report_issue_share", query, ["session.copy-id"]);
      expect(ids[0]?.startsWith("diagnostics.")).toBe(true);
      expect(ids.indexOf("diagnostics.copy")).toBeLessThan(ids.indexOf("session.copy-id"));
    }
  });
});
