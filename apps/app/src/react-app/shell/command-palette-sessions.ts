import { getDisplaySessionTitle } from "@/app/lib/session-title";
import { t } from "@/i18n";

import type { SessionOption } from "./command-palette";
import type { PaletteItem } from "./command-palette-search";
import type { RouteSession, RouteWorkspace } from "./route-workspaces";

export type CommandPaletteSessionRef = {
  workspaceId: string;
  sessionId: string;
};

export function buildCommandPaletteSplitSessions(
  sessions: SessionOption[],
  current: CommandPaletteSessionRef | null | undefined,
) {
  if (!current) return [];
  return sessions.filter((session) => (
    session.workspaceId !== current.workspaceId || session.sessionId !== current.sessionId
  ));
}

/** Stays listed without a session so people can find it, but only runs with one. */
export function buildCopySessionIdPaletteItem(
  selectedSessionId: string | null | undefined,
  copy: (sessionId: string) => void,
): PaletteItem {
  const sessionId = selectedSessionId?.trim();
  return {
    id: "session.copy-id",
    title: t("session_management.copy_session_id"),
    detail: sessionId || t("session_management.copy_session_id_unavailable"),
    searchText: "copy session id identifier share support report issue debug",
    disabled: !sessionId,
    action: () => {
      if (sessionId) copy(sessionId);
    },
  };
}

export function buildCommandPaletteSessions(
  workspaces: RouteWorkspace[],
  sessionsByWorkspaceId: Record<string, RouteSession[]>,
  selectedWorkspaceId: string,
) {
  const options: SessionOption[] = [];

  for (const workspace of workspaces) {
    const workspaceTitle =
      workspace.displayName?.trim() ||
      workspace.name?.trim() ||
      workspace.path?.trim() ||
      t("session.workspace_fallback");

    for (const session of sessionsByWorkspaceId[workspace.id] ?? []) {
      const sessionId = session.id.trim();
      if (!sessionId) continue;
      const title = getDisplaySessionTitle(session.title ?? "");
      const updatedAt = session.time.updated ?? session.time.created;
      options.push({
        workspaceId: workspace.id,
        sessionId,
        title,
        workspaceTitle,
        updatedAt,
        searchText: `${title} ${workspaceTitle}`.toLowerCase(),
        isActive: workspace.id === selectedWorkspaceId,
      });
    }
  }

  return options.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}
