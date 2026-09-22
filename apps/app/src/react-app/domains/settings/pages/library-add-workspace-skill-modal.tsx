/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "../../../../i18n";
import { TextInput } from "../../../design-system/text-input";

/**
 * Local workspace skill authoring.
 *
 * The Library "Add skill" flow otherwise only exists for omnirush.ai Cloud
 * organizations (Den). A desktop user signed in with an omnirush.ai account
 * still needs a way to add a skill the engine can load, so this modal writes
 * `.opencode/skills/<name>/SKILL.md` through the local server
 * (`POST /workspace/:id/skills`), which validates, audits, and emits the reload
 * event the engine needs.
 */

/** Mirrors the server: kebab-case, 1-64 chars (validators.ts validateSkillName). */
export const WORKSPACE_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const WORKSPACE_SKILL_NAME_MAX_LENGTH = 64;
/** Mirrors the server: 1-1024 chars (validators.ts validateDescription). */
export const WORKSPACE_SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export type WorkspaceSkillDraft = {
  name: string;
  description: string;
  content: string;
};

export type WorkspaceSkillDraftError =
  | "name_required"
  | "name_invalid"
  | "description_required"
  | "description_too_long"
  | "content_required";

/** Validate a draft the same way the server will, so errors show before the request. */
export function validateWorkspaceSkillDraft(draft: WorkspaceSkillDraft): WorkspaceSkillDraftError | null {
  const name = draft.name.trim();
  if (!name) return "name_required";
  if (name.length > WORKSPACE_SKILL_NAME_MAX_LENGTH || !WORKSPACE_SKILL_NAME_PATTERN.test(name)) return "name_invalid";
  const description = draft.description.trim();
  if (!description) return "description_required";
  if (description.length > WORKSPACE_SKILL_DESCRIPTION_MAX_LENGTH) return "description_too_long";
  if (!draft.content.trim()) return "content_required";
  return null;
}

/** Suggested kebab-case name from free text ("Release Notes" -> "release-notes"). */
export function suggestWorkspaceSkillName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, WORKSPACE_SKILL_NAME_MAX_LENGTH);
}

/**
 * Whether Library should offer local workspace skill authoring. Cloud-signed-in
 * members keep the Den authoring modal; everyone else gets the workspace file
 * path when the server can write skills and policy allows local extensions.
 */
export function workspaceSkillAddAvailable(input: {
  cloudSignedIn: boolean;
  allowManageExtensions: boolean;
  canCreateWorkspaceSkill: boolean;
}): boolean {
  if (input.cloudSignedIn) return false;
  if (!input.allowManageExtensions) return false;
  return input.canCreateWorkspaceSkill;
}

function label(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

export function workspaceSkillDraftErrorMessage(error: WorkspaceSkillDraftError): string {
  switch (error) {
    case "name_required":
      return t("extensions.add_name_required");
    case "name_invalid":
      return t("extensions.add_skill_name_invalid");
    case "description_required":
      return t("extensions.add_description_required");
    case "description_too_long":
      return label(
        "extensions.add_skill_description_too_long",
        `Description must be ${WORKSPACE_SKILL_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
      );
    case "content_required":
      return t("extensions.add_instructions_required");
  }
}

/** Fill well only, matching the Den authoring modal. */
const fieldClass = [
  "rounded-xl border-transparent bg-dls-hover shadow-none ring-0",
  "before:hidden before:shadow-none",
  "focus:border-transparent focus:ring-0",
  "focus-visible:border-transparent focus-visible:ring-0",
].join(" ");

export type LibraryAddWorkspaceSkillModalProps = {
  open: boolean;
  /** Workspace root shown in the hint so the user knows where the file lands. */
  workspaceRoot?: string;
  busy?: boolean;
  onClose: () => void;
  /** Rejects with a message when the server refuses the skill. */
  onCreate: (draft: WorkspaceSkillDraft) => Promise<void>;
  /** Called after a successful create with the final skill name. */
  onCreated?: (name: string) => void;
};

export function LibraryAddWorkspaceSkillModal(props: LibraryAddWorkspaceSkillModalProps) {
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setName("");
    setNameTouched(false);
    setDescription("");
    setContent("");
    setError(null);
    setSubmitting(false);
  }, [props.open]);

  const handleClose = () => {
    if (submitting) return;
    props.onClose();
  };

  const handleSubmit = async () => {
    if (submitting) return;
    const draft: WorkspaceSkillDraft = {
      name: name.trim(),
      description: description.trim(),
      content,
    };
    const draftError = validateWorkspaceSkillDraft(draft);
    if (draftError) {
      setError(workspaceSkillDraftErrorMessage(draftError));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await props.onCreate(draft);
      props.onCreated?.(draft.name);
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("common.something_went_wrong"));
    } finally {
      setSubmitting(false);
    }
  };

  const location = props.workspaceRoot?.trim()
    ? `${props.workspaceRoot.trim()}/.opencode/skills/${name.trim() || "<name>"}/SKILL.md`
    : `.opencode/skills/${name.trim() || "<name>"}/SKILL.md`;

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent
        className="max-h-[min(92dvh,880px)] overflow-y-auto lg:max-w-2xl"
        data-testid="library-add-workspace-skill-modal"
      >
        <DialogHeader>
          <DialogTitle className="text-2xl font-semibold tracking-[-0.03em]">
            {t("extensions.create_skill_title")}
          </DialogTitle>
          <DialogDescription>
            {label(
              "extensions.create_workspace_skill_hint",
              "Saved to this workspace's .opencode/skills folder. The engine loads it for every session in this workspace after a reload.",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <TextInput
            label={t("extensions.add_name_label")}
            hint={t("extensions.add_name_hint_skill")}
            placeholder="e.g. release-notes"
            value={name}
            autoFocus
            disabled={submitting}
            className={fieldClass}
            onChange={(event) => {
              setNameTouched(true);
              setName(event.currentTarget.value);
            }}
            onBlur={() => {
              if (nameTouched && name && !WORKSPACE_SKILL_NAME_PATTERN.test(name)) {
                setName(suggestWorkspaceSkillName(name));
              }
            }}
          />
          <TextInput
            label={t("extensions.add_description_label")}
            hint={t("extensions.add_skill_description_hint")}
            placeholder={t("extensions.add_skill_description_placeholder")}
            value={description}
            disabled={submitting}
            className={fieldClass}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-dls-text">{t("extensions.add_skill_body_label")}</span>
            <p className="mb-2 text-xs text-dls-secondary">{t("extensions.add_skill_body_hint")}</p>
            <Textarea
              rows={14}
              className={`min-h-56 font-mono leading-6 ${fieldClass}`}
              placeholder={t("extensions.add_skill_body_placeholder")}
              value={content}
              disabled={submitting}
              onChange={(event) => setContent(event.currentTarget.value)}
            />
          </label>
          <p className="break-all font-mono text-[11px] text-dls-secondary" data-testid="workspace-skill-location">
            {location}
          </p>
          {error ? (
            <p role="alert" className="text-sm text-red-11">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button type="submit" disabled={submitting || props.busy}>
              {submitting ? <Loader2 size={16} className="animate-spin" /> : null}
              {t("extensions.create_skill_submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
