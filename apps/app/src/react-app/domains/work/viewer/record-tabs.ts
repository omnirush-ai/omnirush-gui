// Record tabs in the side panel: an item opens in place of the record on screen unless that one holds a draft or a send
// waiting out its undo window (then beside it), so the strip does not fill with every item looked at.
import { t } from "@/i18n";

import { usePanelTabStore, type RecordPanelTab } from "../../session/panel/panel-tab-store";
import { NO_SESSION_SIDE_PANEL_KEY } from "../../session/panel/side-panel-session";
import { useUiStateStore } from "../../../shell/ui-state-store";
import { recordList, recordTabId, replaceable, setRecordList, type OpenRecordRequest } from "./records";

export function recordTab(request: OpenRecordRequest): RecordPanelTab {
  const label = request.compose
    ? request.compose.kind === "meeting" ? t("work.viewer.new_meeting") : t("work.viewer.new_mail")
    : request.title?.trim() || t("work.viewer.item");
  return {
    id: recordTabId(request),
    type: "record",
    label: label.length > 80 ? `${label.slice(0, 79)}…` : label,
    sourceId: request.compose ? "" : request.sourceId,
    source: request.compose?.connector ?? request.source ?? null,
    kind: request.compose ? request.compose.kind : request.kind ?? null,
    url: request.url ?? null,
    ...(request.compose ? { compose: request.compose } : {}),
  };
}

/** Opens (or steps to) a record in a panel's strip. Returns the tab. */
export function openRecordTab(panelKey: string, request: OpenRecordRequest): RecordPanelTab {
  const tab = recordTab(request);
  if (request.list) setRecordList(tab.id, request.list);
  const store = usePanelTabStore.getState();
  const session = store.sessions[panelKey];
  const active = session?.tabs.find((entry) => entry.id === session.activeTabId);
  if (!request.newTab && !request.compose && active?.type === "record" && !active.compose && active.id !== tab.id && replaceable(active.sourceId)) {
    // Stepping to a related item keeps the list it came from.
    if (!request.list) setRecordList(tab.id, recordList(active.id));
    store.replaceTab(panelKey, active.id, tab);
  } else {
    store.openTab(panelKey, tab);
  }
  return tab;
}


/** The record open in a panel right now (its row in a list shows as selected), or null. */
export function useOpenRecordId(panelKey: string = NO_SESSION_SIDE_PANEL_KEY): string | null {
  const open = useUiStateStore((state) => state.sidePanelState[panelKey] === "panel");
  const id = usePanelTabStore((state) => {
    const session = state.sessions[panelKey];
    const active = session?.tabs.find((tab) => tab.id === session.activeTabId);
    return active?.type === "record" && !active.compose ? active.sourceId : null;
  });
  return open ? id : null;
}
