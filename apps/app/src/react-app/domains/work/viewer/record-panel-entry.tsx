/** @jsxImportSource react */
// The side panel's way into the record viewer: the tab's mark, and the viewer itself loaded when a record first opens
// (the editor and views stay out of the start-up bundle).
import { CalendarPlus, Mail } from "lucide-react";
import { lazy, Suspense, type ComponentProps } from "react";

import type { RecordPanelTab } from "../../session/panel/panel-tab-store";
import { ConnectorIcon } from "../brand-icon";
import { RecordSkeleton } from "./parts";

const Panel = lazy(() => import("./record-panel").then((module) => ({ default: module.RecordPanel })));

export function RecordPanel(props: ComponentProps<typeof Panel>) {
  return (
    <Suspense fallback={<RecordSkeleton />}>
      <Panel {...props} />
    </Suspense>
  );
}

export function RecordTabIcon(props: { tab: RecordPanelTab }) {
  if (props.tab.compose) return props.tab.compose.kind === "meeting" ? <CalendarPlus /> : <Mail />;
  return <ConnectorIcon id={props.tab.mark ?? props.tab.source ?? "generic"} className="size-3.5" />;
}
