/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";
import { FilePlus, FileText, Folder, FolderPlus, Link2, Loader2, Pencil, Terminal, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { t } from "../../../../i18n";
import {
  formatUploadBytes,
  groupSkillFiles,
  readSkillFromFileList,
  type SkillFileTree,
  type SkillUploadFile,
} from "../../../../app/lib/skill-upload";

/**
 * Files of an installed workspace skill, shown in its detail view: the
 * SKILL.md editor (saved through the regular skill upsert, which leaves helper
 * files alone) and the helper files, which can be added (into the root or a
 * folder such as scripts/) and removed. The local server applies the same
 * path, credential and size rules as a fresh upload.
 */

export type SkillFilesPanelProps = {
  name: string;
  listFiles: (name: string) => Promise<SkillFileTree>;
  updateFiles: (name: string, payload: { add?: SkillUploadFile[]; remove?: string[] }) => Promise<SkillFileTree>;
  /** Current SKILL.md text (as the detail view loaded it). */
  content: string | null;
  saveContent: (input: { name: string; content: string }) => Promise<void>;
  onContentSaved?: (content: string) => void;
};

function label(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

const TARGET_FOLDERS = ["", "scripts", "references", "assets"] as const;

/** Places picked files under a target folder ("" = the skill root). */
export function placeSkillFiles(files: SkillUploadFile[], folder: string): SkillUploadFile[] {
  const prefix = folder.trim().replace(/^\/+|\/+$/g, "");
  return files.map((file) => ({ ...file, path: prefix ? `${prefix}/${file.path}` : file.path }));
}

export function SkillFilesPanel(props: SkillFilesPanelProps) {
  const [tree, setTree] = useState<SkillFileTree | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [target, setTarget] = useState<string>("scripts");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const filesInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);

  const { listFiles, name } = props;
  const refresh = useCallback(async () => {
    try {
      setTree(await listFiles(name));
      setHidden(false);
    } catch (cause) {
      // Global, plugin and Connect skills are not editable here.
      if ((cause as { status?: number } | null)?.status === 404) setHidden(true);
      else setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [listFiles, name]);

  useEffect(() => {
    setTree(null);
    setEditing(false);
    setError(null);
    void refresh();
  }, [refresh]);

  if (hidden) return null;

  const run = async (action: () => Promise<void>) => {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      const paths = (cause as { details?: { paths?: unknown } } | null)?.details?.paths;
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(Array.isArray(paths) && paths.length && !message.includes(String(paths[0])) ? `${message}: ${paths.join(", ")}` : message);
    } finally {
      setWorking(false);
    }
  };

  const addFrom = (list: FileList | null) => {
    if (!list?.length) return;
    const files = Array.from(list);
    void run(async () => {
      const read = await readSkillFromFileList(files);
      if (read.kind === "zip") throw new Error(label("extensions.skill_files_zip", "To install a .zip, use Add skill > Upload folder or .zip."));
      setTree(await props.updateFiles(props.name, { add: placeSkillFiles(read.files, target) }));
    });
  };

  const groups = tree ? groupSkillFiles(tree.files) : [];
  const helperCount = tree ? tree.files.filter((file) => file.path !== "SKILL.md").length : 0;

  return (
    <Card variant="outline" size="sm" className="overflow-hidden py-0" data-testid="skill-files-panel">
      <input
        ref={filesInput}
        type="file"
        multiple
        className="hidden"
        data-testid="skill-files-add-input"
        onChange={(event) => {
          addFrom(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={(node) => {
          folderInput.current = node;
          node?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          addFrom(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="text-sm font-semibold text-card-foreground">
          {label("extensions.skill_files_title", "Skill files")}
          {tree ? <span className="ml-2 text-xs font-normal text-muted-foreground">{helperCount} helper {helperCount === 1 ? "file" : "files"}</span> : null}
        </div>
        {working ? <Loader2 size={14} className="animate-spin text-muted-foreground" /> : null}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
          <Textarea
            rows={14}
            className="min-h-56 font-mono text-xs leading-5"
            value={draft}
            disabled={working}
            data-testid="skill-md-editor"
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" type="button" disabled={working} onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              type="button"
              disabled={working || !draft.trim()}
              data-testid="skill-md-save"
              onClick={() => void run(async () => {
                await props.saveContent({ name: props.name, content: draft });
                props.onContentSaved?.(draft);
                setEditing(false);
                setTree(await props.listFiles(props.name));
              })}
            >
              {label("extensions.skill_md_save", "Save SKILL.md")}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="max-h-72 overflow-y-auto">
        {!tree ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t("common.loading") === "common.loading" ? "Loading…" : t("common.loading")}</p>
        ) : groups.map((group) => (
          <div key={group.folder || "."}>
            {group.folder ? (
              <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-4 py-1.5 font-mono text-[11px] text-muted-foreground">
                <Folder size={12} /> {group.folder}/
              </div>
            ) : null}
            {group.files.map((file) => {
              const isSkillMd = file.path === "SKILL.md";
              return (
                <div key={file.path} className="group flex items-center gap-2 border-b border-border px-4 py-1.5" data-testid="skill-file-row">
                  {file.kind === "symlink" ? <Link2 size={12} className="text-amber-11" /> : file.executable ? <Terminal size={12} className="text-muted-foreground" /> : <FileText size={12} className="text-muted-foreground" />}
                  <span className={`min-w-0 flex-1 truncate font-mono text-xs ${group.folder ? "pl-3" : ""}`} title={file.path}>
                    {file.path.slice(group.folder ? group.folder.length + 1 : 0)}
                    {file.kind === "symlink" ? <span className="ml-2 text-[10px] text-amber-11">link (not uploaded by the desktop)</span> : null}
                  </span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">{formatUploadBytes(file.size)}</span>
                  {isSkillMd ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      type="button"
                      disabled={working || props.content === null}
                      data-testid="skill-md-edit"
                      onClick={() => {
                        setDraft(props.content ?? "");
                        setEditing(true);
                      }}
                    >
                      <Pencil size={12} /> {label("extensions.skill_md_edit", "Edit")}
                    </Button>
                  ) : confirmRemove === file.path ? (
                    <span className="flex items-center gap-1">
                      <Button
                        variant="destructive"
                        size="xs"
                        type="button"
                        disabled={working}
                        data-testid="skill-file-remove-confirm"
                        onClick={() => void run(async () => {
                          setTree(await props.updateFiles(props.name, { remove: [file.path] }));
                          setConfirmRemove(null);
                        })}
                      >
                        {label("extensions.skill_file_remove_confirm", "Remove")}
                      </Button>
                      <Button variant="ghost" size="xs" type="button" onClick={() => setConfirmRemove(null)}>
                        {t("common.cancel")}
                      </Button>
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      type="button"
                      aria-label={`Remove ${file.path}`}
                      disabled={working}
                      data-testid="skill-file-remove"
                      onClick={() => setConfirmRemove(file.path)}
                    >
                      <Trash2 size={12} />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {label("extensions.skill_files_into", "Add into")}
          <select
            className="rounded-md border border-border bg-transparent px-1.5 py-1 font-mono text-xs text-foreground"
            value={target}
            disabled={working}
            data-testid="skill-files-target"
            onChange={(event) => setTarget(event.currentTarget.value)}
          >
            {TARGET_FOLDERS.map((folder) => (
              <option key={folder || "root"} value={folder}>{folder ? `${folder}/` : "skill root"}</option>
            ))}
          </select>
        </label>
        <Button variant="outline" size="sm" type="button" disabled={working || !tree} onClick={() => filesInput.current?.click()} data-testid="skill-files-add">
          <FilePlus size={13} /> {label("extensions.skill_files_add", "Add files")}
        </Button>
        <Button variant="outline" size="sm" type="button" disabled={working || !tree} onClick={() => folderInput.current?.click()}>
          <FolderPlus size={13} /> {label("extensions.skill_files_add_folder", "Add folder")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="border-t border-border px-4 py-2 text-xs text-red-11" data-testid="skill-files-error">{error}</p>
      ) : null}
    </Card>
  );
}
