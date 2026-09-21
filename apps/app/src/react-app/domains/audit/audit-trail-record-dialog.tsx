import * as React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AuditTrailRecord } from "./audit-trail-types";

function formatValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "Not reported";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return "Unavailable"; }
}

export function AuditTrailRecordDialog({ record, onClose }: { record: AuditTrailRecord | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(record)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        {record ? (
          <>
            <DialogHeader><DialogTitle>{record.title}</DialogTitle></DialogHeader>
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">{record.summary}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <dt className="text-muted-foreground">Status</dt><dd className="capitalize">{record.status}</dd>
                <dt className="text-muted-foreground">Time</dt><dd>{new Date(record.timestamp).toLocaleString()}</dd>
                {record.kind === "tool" ? <><dt className="text-muted-foreground">Tool</dt><dd>{record.toolName}</dd><dt className="text-muted-foreground">Input / output</dt><dd><details><summary className="cursor-pointer text-xs text-muted-foreground">Show redacted payloads</summary><div className="mt-1 space-y-1"><pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{formatValue(record.input)}</pre><pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{formatValue(record.output)}</pre></div></details></dd></> : null}
                {record.kind === "assistant" ? <><dt className="text-muted-foreground">Model</dt><dd>{record.model ?? "Not reported"}</dd><dt className="text-muted-foreground">Usage</dt><dd>{record.usage ? formatValue(record.usage) : "Not reported"}</dd></> : null}
                {record.kind === "artifact" ? <><dt className="text-muted-foreground">Artifact</dt><dd>{record.path}</dd></> : null}
                {record.kind === "workspace" ? <><dt className="text-muted-foreground">Action</dt><dd>{record.action}</dd><dt className="text-muted-foreground">Target</dt><dd>{record.target}</dd><dt className="text-muted-foreground">Actor</dt><dd>{record.actor}</dd>{record.details ? <><dt className="text-muted-foreground">Details</dt><dd><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{formatValue(record.details)}</pre></dd></> : null}</> : null}
                {record.kind === "error" ? <><dt className="text-muted-foreground">Error</dt><dd>{record.error}</dd></> : null}
              </dl>
              {record.redacted ? <p className="text-xs text-muted-foreground">Some sensitive values were redacted.</p> : null}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
