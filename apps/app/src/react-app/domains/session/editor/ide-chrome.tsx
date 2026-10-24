/** @jsxImportSource react */
/**
 * The pieces of the Chat / IDE layouts that sit outside the editor itself:
 * the mode toggle (always top-left of the main pane), the workspace and chat
 * switchers that replace the sessions sidebar in IDE mode, the chat panel
 * button, and the app destinations at the foot of the activity rail.
 */
import type { ReactNode } from "react";
import { Check, ChevronDown, Code2, Folder, MessageSquare, MessageSquareOff, MoreHorizontal, Plus, Settings, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { openWhatsNew, useWhatsNewUnseen } from "../../whats-new/whats-new";
import type { LayoutMode } from "./editor-store";

const isMac = () => typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
export const shortcutLabel = (key: string) => (isMac() ? `⌘⇧${key}` : `Ctrl+Shift+${key}`);

export function LayoutModeToggle(props: { mode: LayoutMode; onChange: (mode: LayoutMode) => void; className?: string }) {
  const option = (mode: LayoutMode, label: string, icon: ReactNode) => {
    const active = props.mode === mode;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={active}
        data-layout-mode-option={mode}
        onClick={() => props.onChange(mode)}
        className={cn(
          "flex h-6 items-center gap-1 rounded-md px-2 text-[12px] transition-colors [&_svg]:size-3.5",
          active
            ? "bg-background font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-border dark:bg-gray-5"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {icon}
        {label}
      </button>
    );
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <div
            role="radiogroup"
            aria-label={t("ide.layout")}
            data-layout-mode={props.mode}
            className={cn("flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5 mac:titlebar-no-drag", props.className)}
          />
        )}
      >
        {option("chat", t("ide.layout_chat"), <MessageSquare />)}
        {option("ide", "IDE", <Code2 />)}
      </TooltipTrigger>
      <TooltipContent>{t("ide.switch_layout")} ({shortcutLabel("Y")})</TooltipContent>
    </Tooltip>
  );
}

export type SwitcherWorkspace = { id: string; name: string };

/** One click to another workspace (it opens in the layout remembered for it). */
export function WorkspaceSwitcher(props: { workspaces: SwitcherWorkspace[]; selectedId: string; onSelect: (id: string) => void }) {
  const current = props.workspaces.find((workspace) => workspace.id === props.selectedId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button variant="ghost" size="sm" className="h-7 min-w-0 max-w-56 gap-1.5 rounded-lg px-2 text-[12.5px] font-medium" data-workspace-switcher aria-label={t("ide.switch_workspace")}>
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{current?.name ?? t("settings.section_workspace")}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        )}
      />
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {props.workspaces.map((workspace) => (
          <DropdownMenuItem key={workspace.id} onClick={() => props.onSelect(workspace.id)} data-workspace-switch-item={workspace.id}>
            <Folder className="size-4" />
            <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
            {workspace.id === props.selectedId ? <Check className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type SwitcherChat = { id: string; title: string; status: "running" | "approval" | "idle" };

function StatusDot(props: { status: SwitcherChat["status"] }) {
  if (props.status === "idle") return null;
  return (
    <span
      aria-label={props.status === "approval" ? t("ide.needs_approval") : t("ide.running")}
      className={cn("size-1.5 shrink-0 rounded-full", props.status === "approval" ? "bg-amber-9" : "animate-pulse bg-primary")}
    />
  );
}

/** This project's chats, in place of the sessions sidebar (IDE mode): the open chat, how many there are, which run. */
export function ChatSwitcher(props: {
  chats: SwitcherChat[];
  selectedId: string | null;
  title: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  newDisabled?: boolean;
}) {
  const running = props.chats.some((chat) => chat.id !== props.selectedId && chat.status !== "idle");
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(
            <Button variant="ghost" size="sm" className="h-7 min-w-0 max-w-64 shrink gap-1.5 rounded-lg px-2 text-[13px] font-medium" data-chat-switcher aria-label={t("ide.switch_chat")}>
              <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{props.title}</span>
              {props.chats.length > 1 ? <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{props.chats.length}</span> : null}
              {running ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-label={t("ide.another_chat_running")} /> : null}
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
          )}
        />
        <DropdownMenuContent align="start" className="max-h-[60vh] w-72 overflow-y-auto">
          <DropdownMenuItem onClick={props.onNew} disabled={props.newDisabled} data-chat-switch-new>
            <Plus className="size-4" />
            {t("ide.new_chat")}
          </DropdownMenuItem>
          {props.chats.length ? <DropdownMenuSeparator /> : null}
          {props.chats.map((chat) => (
            <DropdownMenuItem key={chat.id} onClick={() => props.onOpen(chat.id)} data-chat-switch-item={chat.id}>
              <span className="min-w-0 flex-1 truncate">{chat.title}</span>
              <StatusDot status={chat.status} />
              {chat.id === props.selectedId ? <Check className="size-4" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button variant="ghost" size="icon-sm" aria-label={t("ide.new_chat")} onClick={props.onNew} disabled={props.newDisabled} className="rounded-lg text-muted-foreground">
              <Plus />
            </Button>
          )}
        />
        <TooltipContent>{t("ide.new_chat")}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Shows or hides the chat panel (IDE mode); while hidden it says when the chat needs you. */
export function ChatPanelButton(props: { open: boolean; attention: "approval" | "running" | null; onToggle: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={props.open ? t("session.hide_chat") : t("session.show_chat")}
            aria-pressed={props.open}
            data-chat-panel-toggle
            onClick={props.onToggle}
            className={cn("relative rounded-lg", props.open ? "bg-muted text-foreground" : "text-muted-foreground")}
          >
            {props.open ? <MessageSquareOff /> : <MessageSquare />}
            {!props.open && props.attention ? (
              <span
                className={cn("absolute right-1 top-1 size-2 rounded-full ring-2 ring-background", props.attention === "approval" ? "bg-amber-9" : "animate-pulse bg-primary")}
                data-chat-attention={props.attention}
              />
            ) : null}
          </Button>
        )}
      />
      <TooltipContent>{props.open ? t("session.hide_chat") : t("session.show_chat")} ({shortcutLabel("H")})</TooltipContent>
    </Tooltip>
  );
}

export type RailDestination = { id: string; label: string; icon: ReactNode; badge?: number; onSelect: () => void };

/** The app's destinations the sessions sidebar holds, at the foot of the IDE rail. */
export function RailDestinations(props: { destinations: RailDestination[]; onOpenSettings: () => void }) {
  const badge = props.destinations.reduce((sum, item) => sum + (item.badge ?? 0), 0);
  const whatsNew = isDesktopRuntime();
  const whatsNewUnseen = useWhatsNewUnseen() && whatsNew;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(
            <button
              type="button"
              aria-label={t("ide.rail_more_label")}
              title={t("ide.rail_more_title")}
              data-rail-more
              className="relative flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-[18px]"
            >
              <MoreHorizontal />
              {badge ? (
                <span className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-primary px-1 text-center text-[9px] font-semibold leading-3.5 text-primary-foreground">{badge}</span>
              ) : whatsNewUnseen ? (
                <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" aria-hidden="true" data-rail-whats-new-dot />
              ) : null}
            </button>
          )}
        />
        <DropdownMenuContent side="right" align="end" className="w-60">
          {props.destinations.map((item) => (
            <DropdownMenuItem key={item.id} onClick={item.onSelect} data-rail-destination={item.id}>
              {item.icon}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.badge ? <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{item.badge}</span> : null}
            </DropdownMenuItem>
          ))}
          {whatsNew ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => openWhatsNew("menu")} data-rail-destination="whats-new">
                <Sparkles />
                <span className="min-w-0 flex-1 truncate">
                  {t("whats_new.title")}
                  {whatsNewUnseen ? <span className="sr-only"> ({t("whats_new.unseen")})</span> : null}
                </span>
                {whatsNewUnseen ? <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" /> : null}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={(
            <button
              type="button"
              aria-label={t("settings.tab_general")}
              onClick={props.onOpenSettings}
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-[18px]"
            >
              <Settings />
            </button>
          )}
        />
        <TooltipContent side="right">{t("settings.tab_general")}</TooltipContent>
      </Tooltip>
    </>
  );
}
