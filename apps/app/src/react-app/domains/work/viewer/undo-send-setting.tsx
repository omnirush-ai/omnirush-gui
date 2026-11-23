/** @jsxImportSource react */
// Settings > Work: how long a send from the record viewer waits before it goes (Undo in that time). Off, 5, 10 or 20 s;
// 5 s by default (judge decision 10). Kept on this computer.
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "@/react-app/domains/settings/settings-layout";

import { useWorkState, type WorkClient } from "../work-mode";
import { UNDO_SEND_CHOICES, useUndoSendStore } from "./records";

export function WorkUndoSendSetting(props: { client: WorkClient | null }) {
  const state = useWorkState(props.client);
  const delay = useUndoSendStore((s) => s.delay);
  const setDelay = useUndoSendStore((s) => s.setDelay);
  if (!state.data?.enabled) return null;
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{t("work.viewer.undo_send_title")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>{t("work.viewer.undo_send_body")}</LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <div role="radiogroup" aria-label={t("work.viewer.undo_send_title")} data-testid="work-undo-send" className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
            {UNDO_SEND_CHOICES.map((value) => (
              <button key={value} type="button" role="radio" aria-checked={delay === value} data-undo-send={value} onClick={() => setDelay(value)}
                className={cn("h-7 rounded-md px-3 text-[12px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  delay === value ? "bg-background font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-border dark:bg-gray-5" : "text-muted-foreground hover:text-foreground")}>
                {value === 0 ? t("work.viewer.undo_send_off") : t("work.viewer.seconds", { count: value })}
              </button>
            ))}
          </div>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
    </LayoutSectionItem>
  );
}
