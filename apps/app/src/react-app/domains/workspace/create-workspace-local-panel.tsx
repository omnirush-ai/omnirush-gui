/** @jsxImportSource react */
import {
  ChartNoAxesColumnIncreasing,
  Check,
  FolderPlus,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { t } from "../../../i18n";
import {
  modalBodyClass,
  pillSecondaryClass,
  sectionBodyClass,
  sectionTitleClass,
  surfaceCardClass,
} from "./modal-styles";

export type CreateWorkspaceLocalPanelProps = {
  selectedFolder: string | null;
  hasSelectedFolder: boolean;
  pickingFolder: boolean;
  onPickFolder: () => void;
  projectLabel: string;
  onProjectLabelInput: (value: string) => void;
  showProjectLabel: boolean;
  submitting: boolean;
  localError: string | null;
  onClose: () => void;
  onSubmit: () => void;
  confirmLabel?: string;
};

export function CreateWorkspaceLocalPanel(
  props: CreateWorkspaceLocalPanelProps,
) {
  const hasProjectLabel = props.projectLabel.trim().length > 0;

  return (
    <>
      <div
        className={`${modalBodyClass} transition-opacity duration-300 ${props.submitting ? "pointer-events-none opacity-40" : "opacity-100"}`}
      >
        <div className="space-y-4">
          <div className={surfaceCardClass}>
            <div className={sectionTitleClass}>
              {t("welcome.folder_title")}
            </div>
            <div className={`${sectionBodyClass} mt-2`}>
              {t("welcome.folder_explanation")}
            </div>
            <ul className="mt-3 space-y-1.5 pl-1">
              <li className="flex items-start gap-2 text-[13px] text-dls-secondary">
                <Check size={14} className="mt-0.5 shrink-0 text-emerald-10" />
                {t("welcome.folder_read")}
              </li>
              <li className="flex items-start gap-2 text-[13px] text-dls-secondary">
                <Check size={14} className="mt-0.5 shrink-0 text-emerald-10" />
                {t("welcome.folder_write")}
              </li>
              <li className="flex items-start gap-2 text-[13px] text-dls-secondary">
                <Check size={14} className="mt-0.5 shrink-0 text-emerald-10" />
                {t("welcome.folder_anything")}
              </li>
            </ul>
            <div className="mt-2 text-[12px] text-dls-secondary italic">
              {t("welcome.folder_drop_hint")}
            </div>

            <div className="mt-4 rounded-[20px] border border-dls-border bg-dls-hover px-4 py-3">
              {props.hasSelectedFolder ? (
                <span className="block truncate font-mono text-[12px] text-dls-text">
                  {props.selectedFolder}
                </span>
              ) : (
                <span className="text-[14px] text-dls-secondary">
                  No folder selected yet.
                </span>
              )}
            </div>

            {props.showProjectLabel ? (
              <Accordion
                multiple
                defaultValue={hasProjectLabel ? ["analytics"] : []}
                className="mt-4 overflow-hidden rounded-[20px] border-dls-border bg-dls-hover/60 shadow-none before:hidden"
              >
                <AccordionItem value="analytics" className="border-b-0">
                  <AccordionTrigger className="items-center px-4 py-4 hover:no-underline focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.18)]">
                    <span className="flex min-w-0 flex-1 items-start gap-3">
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-surface text-dls-text">
                        <ChartNoAxesColumnIncreasing size={17} className="shrink-0 text-current" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[14px] font-semibold text-dls-text">
                          Want more analytics?
                        </span>
                        <span className="mt-1 block text-[12px] leading-5 text-dls-secondary">
                          Add a project name to group this workspace's sessions in Analytics.
                        </span>
                      </span>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-3 px-4 pb-4">
                    <div>
                      <label className="text-[13px] font-medium text-dls-text">
                        Project name <span className="text-dls-secondary">(optional)</span>
                      </label>
                      <input
                        type="text"
                        value={props.projectLabel}
                        onChange={(event) => props.onProjectLabelInput(event.currentTarget.value)}
                        placeholder="Billing API"
                        disabled={props.submitting}
                        className="mt-2 w-full rounded-[20px] border border-dls-border bg-dls-surface px-4 py-3 text-[14px] text-dls-text outline-none placeholder:text-dls-secondary transition-colors focus:border-dls-accent disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            ) : null}
            <div className="mt-4">
              <button
                type="button"
                onClick={props.onPickFolder}
                disabled={props.pickingFolder || props.submitting}
                className={pillSecondaryClass}
              >
                {props.pickingFolder ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <FolderPlus size={14} />
                )}
                {props.hasSelectedFolder
                  ? t("dashboard.change")
                  : "Select folder"}
              </button>
            </div>
          </div>

        </div>
      </div>

    <DialogFooter className="flex-col gap-3">
        {props.localError ? (
          <div className="mb-3 whitespace-pre-line rounded-[20px] border border-red-7/20 bg-red-1/40 px-4 py-3 text-[13px] text-red-11">
            {props.localError}
          </div>
        ) : null}

        <div className="flex justify-end gap-3">
          <DialogClose
            disabled={props.submitting}
            render={<Button variant="outline" disabled={props.submitting} />}
          >
            {t("common.cancel")}
          </DialogClose>
          <Button
            type="button"
            onClick={() => void props.onSubmit()}
            disabled={!props.selectedFolder || props.submitting}
            title={
              !props.selectedFolder
                ? t("dashboard.choose_folder_continue")
                : undefined
            }
          >
            {props.submitting ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={16} className="animate-spin" />
                Creating…
              </span>
            ) : (
              (props.confirmLabel ??
                t("dashboard.create_workspace_confirm"))
            )}
          </Button>
        </div>
    </DialogFooter>
    </>
  );
}
