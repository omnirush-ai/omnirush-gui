/** @jsxImportSource react */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { formatRelativeTime } from "@/app/utils";
import { t } from "@/i18n";
import type { SearchableSession } from "@/react-app/domains/session/search/session-search";
import { homeChatTitle, recentChats, type HomeWorkspace } from "./home-view-model";

/** How many recent chats the start screen offers to continue. */
export const HOME_CONTINUE_CHATS = 3;

/** What the start screen needs; every read is of chats already on this computer. */
export type HomeViewContext = {
  sessions: SearchableSession[];
  workspaces: HomeWorkspace[];
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  /** Opens the app's chat search (the same dialog as Cmd/Ctrl+Shift+F). */
  onOpenSearch?: () => void;
};

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
}

function searchShortcut(): string {
  return isMacPlatform() ? "⇧⌘F" : "Ctrl+Shift+F";
}

/**
 * One quiet line under the composer: "Continue" with the latest chats as
 * text-like pills (chat · project) on the left, the chat search on the right.
 * Never wraps: a pill that does not fit whole is left out. The projects live
 * in the sidebar, past chats in the search.
 */
export function HomeContinue({ context }: { context: HomeViewContext }) {
  const chats = useMemo(() => {
    const tasks = new Set(context.workspaces.filter((workspace) => workspace.task).map((workspace) => workspace.id));
    return recentChats(context.sessions.filter((session) => !tasks.has(session.workspaceId)), HOME_CONTINUE_CHATS);
  }, [context.sessions, context.workspaces]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [fits, setFits] = useState(HOME_CONTINUE_CHATS);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const available = list.clientWidth;
      const pills = [...list.querySelectorAll<HTMLElement>("[data-pill]")];
      let used = 0;
      let count = 0;
      for (const pill of pills) {
        used += pill.scrollWidth + (count ? 2 : 0);
        if (available > 0 && used > available) break;
        count += 1;
      }
      setFits(available > 0 ? count : pills.length);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [chats]);

  if (!chats.length) return null;

  return (
    <nav aria-label={t("home.recent_chats")} className="-mt-2 flex h-6 items-center gap-2 pb-1 text-[12px] text-muted-foreground" data-testid="home-continue">
      <span className="shrink-0">{t("home.continue")}</span>
      <div ref={listRef} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
        {chats.map((session, index) => {
          const title = homeChatTitle(session.title);
          return (
            <button
              key={`${session.workspaceId}/${session.sessionId}`}
              type="button"
              data-pill=""
              className={`group inline-flex h-6 max-w-[180px] shrink-0 items-center gap-1 rounded-md px-2 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none ${index < fits ? "" : "invisible absolute"}`}
              onClick={() => context.onOpenSession(session.workspaceId, session.sessionId)}
              title={`${title} \u2014 ${session.workspaceTitle} \u00b7 ${formatRelativeTime(session.updatedAt)}`}
              aria-label={t("home.continue_chat", { title, workspace: session.workspaceTitle })}
              aria-hidden={index < fits ? undefined : true}
              tabIndex={index < fits ? undefined : -1}
              data-testid="home-chat"
            >
              <span className="max-w-[112px] truncate group-hover:text-foreground">{title}</span>
              <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
              <span className="shrink-0">{session.workspaceTitle}</span>
            </button>
          );
        })}
      </div>
      {context.onOpenSearch ? (
        <button
          type="button"
          className="-mr-2 inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none"
          onClick={context.onOpenSearch}
          aria-label={t("home.search_chats", { shortcut: searchShortcut() })}
          title={t("home.search_chats", { shortcut: searchShortcut() })}
          data-testid="home-search"
        >
          <Search className="size-3" aria-hidden="true" />
          <span>{t("home.search")}</span>
          {/* The short Mac hint only: Ctrl+Shift+F would take a pill's room (it shows on hover). */}
          {isMacPlatform() ? <span className="ml-1.5 text-[11px] opacity-60">⇧⌘F</span> : null}
        </button>
      ) : null}
    </nav>
  );
}
