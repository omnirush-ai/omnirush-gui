/** @jsxImportSource react */
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { AlertTriangle, FileArchive, FileText, Folder, FolderUp, Loader2, Terminal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "../../../../i18n";
import {
  classifyDrop,
  formatUploadBytes,
  groupSkillFiles,
  readSkillFromDroppedFolder,
  readSkillFromFileList,
  readSkillFromZipFile,
  SKILL_UPLOAD_LIMITS,
  SkillUploadError,
  type SkillBundleInstallResult,
  type SkillBundlePreview,
  type SkillUploadFile,
  type SkillUploadSource,
} from "../../../../app/lib/skill-upload";
import { electronLocalPathForFile, pickDirectory, readSkillFolder } from "../../../../app/lib/desktop";
import { isDesktopRuntime } from "../../../../app/lib/runtime-env";
import { TextInput } from "../../../design-system/text-input";

/**
 * "Upload folder or .zip" half of the workspace Add skill modal. A pick or a
 * drop is read into relative paths + bytes, the local server previews it with
 * the same checks the install runs, and the user sees every file (and any name
 * collision) before anything is written.
 */

export type SkillUploadPaneProps = {
  disabled?: boolean;
  onPreview: (payload: { files: SkillUploadFile[]; name?: string }) => Promise<SkillBundlePreview>;
  onInstall: (payload: { files: SkillUploadFile[]; name?: string; onConflict?: "fail" | "replace" }) => Promise<SkillBundleInstallResult>;
  onInstalled: (result: SkillBundleInstallResult) => void;
  onBusyChange?: (busy: boolean) => void;
};

function label(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

function errorText(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : t("common.something_went_wrong");
}

/** Reads a local folder through the desktop (links refused there), else null. */
async function readDesktopFolder(path: string): Promise<SkillUploadSource> {
  const result = await readSkillFolder(path);
  return { kind: "folder", label: result.name, files: result.files, skipped: result.skipped };
}

export function SkillUploadPane(props: SkillUploadPaneProps) {
  const folderInput = useRef<HTMLInputElement | null>(null);
  const zipInput = useRef<HTMLInputElement | null>(null);
  const [source, setSource] = useState<SkillUploadSource | null>(null);
  const [preview, setPreview] = useState<SkillBundlePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorPaths, setErrorPaths] = useState<string[]>([]);
  const [working, setWorking] = useState<null | "reading" | "checking" | "installing">(null);
  const [dragging, setDragging] = useState(false);
  const [resolution, setResolution] = useState<"replace" | "rename">("rename");
  const [rename, setRename] = useState("");

  const busy = working !== null || props.disabled === true;
  const setBusy = (next: typeof working) => {
    setWorking(next);
    props.onBusyChange?.(next !== null);
  };

  const reset = () => {
    setSource(null);
    setPreview(null);
    setError(null);
    setErrorPaths([]);
    setRename("");
  };

  const fail = (cause: unknown) => {
    setError(errorText(cause));
    const details = (cause as { details?: { paths?: unknown } } | null)?.details;
    const message = errorText(cause);
    const paths = Array.isArray(details?.paths) ? details.paths.map(String).slice(0, 20) : [];
    // The server names up to ten paths in the message itself; list them only when it did not.
    setErrorPaths(paths.every((path) => message.includes(path)) ? [] : paths);
  };

  const load = async (read: () => Promise<SkillUploadSource | null>) => {
    if (busy) return;
    reset();
    setBusy("reading");
    try {
      const next = await read();
      if (!next) return;
      if (!next.files.length) throw new SkillUploadError(label("extensions.skill_upload_empty", "Nothing to upload: the folder is empty (after skipping system files)."));
      setSource(next);
      setBusy("checking");
      const checked = await props.onPreview({ files: next.files });
      setPreview(checked);
      setResolution(checked.conflict?.replaceable ? "replace" : "rename");
      setRename(checked.conflict ? `${checked.name}-2`.slice(0, 64) : "");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  };

  const chooseFolder = () => {
    if (isDesktopRuntime()) {
      void load(async () => {
        const picked = await pickDirectory({ title: label("extensions.skill_upload_pick_folder", "Choose a skill folder") });
        const path = typeof picked === "string" ? picked : Array.isArray(picked) ? picked[0] : null;
        return path ? readDesktopFolder(path) : null;
      });
      return;
    }
    folderInput.current?.click();
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    let dropped: ReturnType<typeof classifyDrop>;
    try {
      dropped = classifyDrop(event.dataTransfer);
    } catch (cause) {
      fail(cause);
      return;
    }
    if (!dropped) return;
    const drop = dropped;
    void load(async () => {
      if (drop.kind === "zip") return readSkillFromZipFile(drop.file);
      if (drop.kind === "folder") {
        const local = drop.file ? electronLocalPathForFile(drop.file) : null;
        return local ? readDesktopFolder(local) : readSkillFromDroppedFolder(drop.entry);
      }
      return readSkillFromFileList(drop.files);
    });
  };

  const install = async () => {
    if (!source || !preview || busy) return;
    const conflict = preview.conflict;
    const name = conflict && resolution === "rename" ? rename.trim() : undefined;
    if (conflict && resolution === "rename" && !name) {
      setError(label("extensions.skill_upload_rename_required", "Enter a new name for the skill."));
      return;
    }
    setError(null);
    setErrorPaths([]);
    setBusy("installing");
    try {
      const result = await props.onInstall({
        files: source.files,
        ...(name ? { name } : {}),
        onConflict: conflict && resolution === "replace" ? "replace" : "fail",
      });
      props.onInstalled(result);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  };

  const hiddenInputs = (
    <>
      <input
        ref={(node) => {
          folderInput.current = node;
          // React does not type the directory-picker attributes.
          node?.setAttribute("webkitdirectory", "");
          node?.setAttribute("directory", "");
        }}
        type="file"
        multiple
        className="hidden"
        data-testid="skill-upload-folder-input"
        onChange={(event) => {
          const files = event.currentTarget.files;
          if (files?.length) void load(() => readSkillFromFileList(Array.from(files)));
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={zipInput}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="hidden"
        data-testid="skill-upload-zip-input"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void load(() => readSkillFromZipFile(file));
          event.currentTarget.value = "";
        }}
      />
    </>
  );

  const errorBox = error ? (
    <div role="alert" className="rounded-xl border border-red-7/40 bg-red-3/40 px-3 py-2 text-sm text-red-11" data-testid="skill-upload-error">
      <p>{error}</p>
      {errorPaths.length ? (
        <ul className="mt-1 list-disc pl-5 font-mono text-xs">
          {errorPaths.map((path) => <li key={path}>{path}</li>)}
        </ul>
      ) : null}
    </div>
  ) : null;

  if (source && preview) {
    const conflict = preview.conflict;
    const groups = groupSkillFiles(preview.files);
    return (
      <div className="flex flex-col gap-4" data-testid="skill-upload-preview">
        {hiddenInputs}
        <div className="flex items-start justify-between gap-3 rounded-xl bg-dls-hover/60 px-4 py-3">
          <div className="min-w-0">
            <div className="font-mono text-sm font-semibold text-dls-text" data-testid="skill-upload-name">{preview.name}</div>
            <p className="mt-0.5 line-clamp-3 text-xs text-dls-secondary">{preview.description}</p>
            <p className="mt-1.5 text-[11px] text-dls-secondary">
              {source.kind === "zip" ? <FileArchive size={11} className="mr-1 inline" /> : <Folder size={11} className="mr-1 inline" />}
              {source.label}
              {" · "}
              {preview.files.length} {preview.files.length === 1 ? "file" : "files"}
              {" · "}
              {formatUploadBytes(preview.totalBytes)}
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" type="button" aria-label={label("extensions.skill_upload_clear", "Choose something else")} disabled={busy} onClick={reset}>
            <X size={14} />
          </Button>
        </div>

        <div className="max-h-64 overflow-y-auto rounded-xl border border-dls-border" data-testid="skill-upload-files">
          {groups.map((group) => (
            <div key={group.folder || "."}>
              {group.folder ? (
                <div className="flex items-center gap-1.5 border-b border-dls-border bg-dls-hover/40 px-3 py-1.5 font-mono text-[11px] text-dls-secondary">
                  <Folder size={12} /> {group.folder}/
                </div>
              ) : null}
              {group.files.map((file) => (
                <div key={file.path} className="flex items-center gap-2 border-b border-dls-border px-3 py-1.5 last:border-b-0">
                  {file.executable ? <Terminal size={12} className="shrink-0 text-dls-secondary" /> : <FileText size={12} className="shrink-0 text-dls-secondary" />}
                  <span className={`min-w-0 flex-1 truncate font-mono text-xs ${group.folder ? "pl-3" : ""}`}>{file.path.slice(group.folder ? group.folder.length + 1 : 0)}</span>
                  {file.executable ? <span className="rounded bg-dls-hover px-1.5 py-0.5 text-[10px] text-dls-secondary">exec</span> : null}
                  <span className="shrink-0 text-[11px] tabular-nums text-dls-secondary">{formatUploadBytes(file.size)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        {preview.strippedRoot || preview.skipped.length || source.skipped.length ? (
          <p className="text-[11px] text-dls-secondary">
            {preview.strippedRoot ? `SKILL.md was found inside “${preview.strippedRoot}/”; its contents become the skill folder. ` : ""}
            {preview.skipped.length + source.skipped.length > 0
              ? `Skipped ${preview.skipped.length + source.skipped.length} system ${preview.skipped.length + source.skipped.length === 1 ? "entry" : "entries"} (${[...source.skipped, ...preview.skipped].slice(0, 4).join(", ")}${preview.skipped.length + source.skipped.length > 4 ? ", …" : ""}).`
              : ""}
          </p>
        ) : null}

        {conflict ? (
          <div className="flex flex-col gap-2 rounded-xl border border-amber-7/40 bg-amber-3/30 px-4 py-3" data-testid="skill-upload-conflict">
            <p className="flex items-center gap-1.5 text-sm font-medium text-dls-text">
              <AlertTriangle size={14} className="text-amber-11" />
              {conflict.replaceable
                ? `A skill named “${conflict.name}” already exists in this workspace.`
                : `A skill named “${conflict.name}” is already installed ${conflict.scope === "global" ? "globally" : "in another skills folder"}.`}
            </p>
            <p className="break-all font-mono text-[11px] text-dls-secondary">{conflict.path}</p>
            {conflict.replaceable ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="skill-conflict" checked={resolution === "replace"} disabled={busy} onChange={() => setResolution("replace")} />
                {label("extensions.skill_upload_replace", "Replace it (its files are removed)")}
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="skill-conflict" checked={resolution === "rename"} disabled={busy} onChange={() => setResolution("rename")} />
              {label("extensions.skill_upload_rename", "Install under a new name")}
            </label>
            {resolution === "rename" ? (
              <TextInput
                aria-label={label("extensions.skill_upload_rename", "Install under a new name")}
                value={rename}
                disabled={busy}
                placeholder="new-skill-name"
                className="rounded-xl border-transparent bg-dls-hover shadow-none"
                onChange={(event) => setRename(event.currentTarget.value)}
              />
            ) : null}
          </div>
        ) : null}

        {errorBox}

        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" disabled={busy} onClick={reset}>
            {label("extensions.skill_upload_back", "Choose another")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => void install()} data-testid="skill-upload-install">
            {working === "installing" ? <Loader2 size={16} className="animate-spin" /> : null}
            {conflict && resolution === "replace"
              ? label("extensions.skill_upload_replace_submit", "Replace skill")
              : label("extensions.skill_upload_install", "Install skill")}
          </Button>
        </div>
      </div>
    );
  }

  let status: ReactNode = null;
  if (working === "reading") status = label("extensions.skill_upload_reading", "Reading files…");
  if (working === "checking") status = label("extensions.skill_upload_checking", "Checking the skill…");

  return (
    <div className="flex flex-col gap-3" data-testid="skill-upload-pane">
      {hiddenInputs}
      <div
        role="region"
        aria-label={label("extensions.skill_upload_drop", "Drop a skill folder or .zip")}
        data-testid="skill-upload-dropzone"
        onDragOver={(event) => {
          event.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${
          dragging ? "border-foreground/50 bg-dls-hover" : "border-dls-border bg-dls-hover/40"
        }`}
      >
        {working ? <Loader2 size={22} className="animate-spin text-dls-secondary" /> : <FolderUp size={22} className="text-dls-secondary" />}
        <div>
          <p className="text-sm font-medium text-dls-text">
            {status ?? label("extensions.skill_upload_drop", "Drop a skill folder or .zip here")}
          </p>
          <p className="mt-1 text-xs text-dls-secondary">
            {label(
              "extensions.skill_upload_hint",
              "A folder with SKILL.md at its root, plus any scripts/, references/ or assets/ it uses.",
            )}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" size="sm" type="button" disabled={busy} onClick={chooseFolder} data-testid="skill-upload-choose-folder">
            <Folder size={14} /> {label("extensions.skill_upload_choose_folder", "Choose folder")}
          </Button>
          <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => zipInput.current?.click()} data-testid="skill-upload-choose-zip">
            <FileArchive size={14} /> {label("extensions.skill_upload_choose_zip", "Choose .zip")}
          </Button>
        </div>
        <p className="text-[11px] text-dls-secondary">
          {`Up to ${SKILL_UPLOAD_LIMITS.maxFiles} files, ${formatUploadBytes(SKILL_UPLOAD_LIMITS.maxFileBytes)} per file, ${formatUploadBytes(SKILL_UPLOAD_LIMITS.maxTotalBytes)} in total. No links or credential files (.env, keys, certificates).`}
        </p>
      </div>
      {errorBox}
    </div>
  );
}
