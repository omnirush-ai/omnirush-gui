import type { SearchableSession } from "@/react-app/domains/session/search/session-search";

/** Same titles as the shared home view (apps/server/src/workspace/home-view.mjs). */
export const HOME_RECENT_CHATS = 8;

export type HomeWorkspace = {
  id: string;
  name: string;
  /** A parallel task's own workspace: listed on its repository's task board, not here. */
  task: boolean;
};

/** A chat's title for lists: one line, at most 72 characters. */
export function homeChatTitle(title: string | null | undefined): string {
  const text = String(title ?? "").replace(/\s+/g, " ").trim();
  return text.length > 72 ? `${text.slice(0, 69).trimEnd()}…` : text;
}

/** The newest chats across every workspace on this computer. */
export function recentChats(sessions: SearchableSession[], limit = HOME_RECENT_CHATS): SearchableSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
