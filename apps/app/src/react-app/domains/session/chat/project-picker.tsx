/** @jsxImportSource react */
import { ChevronDown, Folder, FolderOpen, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";

export type ProjectPickerWorkspace = { id: string; name: string; path: string | null };

export type ProjectPickerProps = {
  workspaces: readonly ProjectPickerWorkspace[];
  selectedId: string | null;
  onSelect: (workspaceId: string) => void;
  /** Picks a folder on disk and makes it the workspace; null where folders cannot be opened. */
  onOpenFolder: (() => Promise<void>) | null;
};

/**
 * The folder a new task works in, picked above the composer: the workspaces
 * the person has, and "Open folder…" to add one. Without it people stay in
 * the starter folder and ask the agent to go find their project, so the
 * agent searches their home folder and works outside the workspace.
 */
export function ProjectPicker(props: ProjectPickerProps) {
  const [opening, setOpening] = useState(false);
  const selected = props.workspaces.find((workspace) => workspace.id === props.selectedId) ?? null;
  const openFolder = props.onOpenFolder;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="project-picker-trigger"
        aria-label={t("workspace_list.project_picker", { name: selected?.name ?? t("workspace_list.choose_project") })}
        title={selected?.path ?? undefined}
        disabled={opening}
        className="mb-2 inline-flex h-8 max-w-full items-center gap-1.5 rounded-md px-2 text-sm text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12"
      >
        {opening ? <LoaderCircle className="size-4 shrink-0 animate-spin" /> : <Folder className="size-4 shrink-0" />}
        <span className="truncate">{selected?.name ?? t("workspace_list.choose_project")}</span>
        <ChevronDown className="size-3.5 shrink-0 text-gray-10" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" sideOffset={4} className="w-[min(320px,calc(100vw-32px))] p-1">
        <DropdownMenuRadioGroup value={props.selectedId ?? ""}>
          {props.workspaces.map((workspace) => (
            <DropdownMenuRadioItem
              key={workspace.id}
              value={workspace.id}
              data-testid={`project-picker-option-${workspace.id}`}
              title={workspace.path ?? undefined}
              onClick={() => {
                if (workspace.id !== props.selectedId) props.onSelect(workspace.id);
              }}
            >
              <span className="truncate">{workspace.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {openFolder ? (
          <>
            {props.workspaces.length ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              data-testid="project-picker-open-folder"
              disabled={opening}
              onClick={() => {
                setOpening(true);
                void openFolder().finally(() => setOpening(false));
              }}
            >
              <FolderOpen className="size-4" />
              {t("workspace_list.open_folder")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
