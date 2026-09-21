import * as React from "react";
import { Download, RefreshCw, X, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AuditTrailRecord } from "./audit-trail-types";
import { AuditTrailRecordDialog } from "./audit-trail-record-dialog";
import { useAuditTrailController, type AuditTrailControllerOptions } from "./use-audit-trail-controller";

function iconFor(kind: AuditTrailRecord["kind"]) { return kind === "error" ? "!" : kind === "tool" ? "◆" : kind === "workspace" ? "◌" : "•"; }
function relativeTime(timestamp: number) { const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`; }

export function AuditTrailMiniPanel(props: AuditTrailControllerOptions & { onClose: () => void }) {
  const controller = useAuditTrailController(props);
  const [selected, setSelected] = React.useState<AuditTrailRecord | null>(null);
  const exportRecords = () => {
    const blob = new Blob([controller.exportJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "audit-trail.json"; anchor.click(); URL.revokeObjectURL(url);
  };
  return (
    <div data-testid="audit-trail-panel" className="mx-2 mb-2 overflow-hidden rounded-lg border border-sidebar-border bg-sidebar-accent/30">
      <div className="flex items-center gap-2 border-b border-sidebar-border px-2 py-1.5"><ShieldCheck className="size-3.5" /><span className="text-xs font-medium">Audit trail</span><span className="text-[11px] text-muted-foreground">{controller.records.length}</span><span className="ml-auto flex gap-0.5"><Button size="icon-xs" variant="ghost" aria-label="Refresh audit trail" onClick={() => void controller.refresh()}><RefreshCw className={cn("size-3", controller.isRefreshing && "animate-spin")} /></Button><Button size="icon-xs" variant="ghost" aria-label="Export audit trail" onClick={exportRecords}><Download className="size-3" /></Button><Button size="icon-xs" variant="ghost" aria-label="Close audit trail" onClick={props.onClose}><X className="size-3" /></Button></span></div>
      <div className="flex items-center gap-1 px-2 py-1"><button type="button" className={cn("rounded px-1.5 py-0.5 text-[11px]", controller.filter === "task" ? "bg-background" : "text-muted-foreground")} onClick={() => controller.setFilter("task")}>Task</button><button type="button" className={cn("rounded px-1.5 py-0.5 text-[11px]", controller.filter === "workspace" ? "bg-background" : "text-muted-foreground")} onClick={() => controller.setFilter("workspace")}>Workspace</button></div>
      <div className="max-h-[280px] overflow-y-auto px-1 pb-1">
        {!props.sessionId && controller.filter === "task" ? <p className="px-2 py-4 text-center text-xs text-muted-foreground">Select a task to view its activity.</p> : controller.isLoading ? <p className="px-2 py-4 text-center text-xs text-muted-foreground">Loading audit trail…</p> : controller.error ? <p className="px-2 py-4 text-center text-xs text-destructive">{controller.error}</p> : controller.records.length === 0 ? <p className="px-2 py-4 text-center text-xs text-muted-foreground">No audit events yet.</p> : controller.records.map((record) => <button key={record.id} type="button" data-testid={`audit-record-${record.kind}`} onClick={() => setSelected(record)} className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-sidebar-accent"><span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-[10px]", record.status === "failed" ? "bg-destructive/20 text-destructive" : "bg-muted text-muted-foreground")}>{iconFor(record.kind)}</span><span className="min-w-0 flex-1"><span className="block truncate font-medium">{record.title}</span><span className="block truncate text-[11px] text-muted-foreground">{record.summary}</span></span><span className="shrink-0 text-right text-[10px] text-muted-foreground"><span className="block">{relativeTime(record.timestamp)}</span><span className="block">{new Date(record.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></span></button>)}
      </div>
      {controller.partialHistory ? <p className="px-2 pb-1 text-[10px] text-muted-foreground">Showing available history.</p> : null}
      <AuditTrailRecordDialog record={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
