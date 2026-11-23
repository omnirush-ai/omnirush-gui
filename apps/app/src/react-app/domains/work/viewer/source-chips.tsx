/** @jsxImportSource react */
// The records a Work tool answered with (work_search, work_context, work_today, work_read, a connector's search), as
// chips under its line in a Work chat (design 2.5, A22): a click opens the record in this chat's side panel.
import { BrandTile } from "../brand-icon";
import { t } from "@/i18n";

import { requestOpenRecord, sourceLabel, sourceMark, type RecordRef } from "./records";
import { WORK_TOOL_PREFIX } from "../work-mode";

const MAX = 8;

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Records with a `source_id` anywhere in a tool's answer (an MCP result's text or structured content), newest first as
 *  the tool listed them, at most 8. */
export function recordsInOutput(output: unknown): RecordRef[] {
  const found = new Map<string, RecordRef>();
  const visit = (value: unknown, depth: number) => {
    if (found.size >= MAX || depth > 8 || value == null) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth); return; }
    if (typeof value === "string") { if (depth <= 6) visit(parse(value), depth + 1); return; }
    if (typeof value !== "object") return;
    const entry = value as Record<string, unknown>;
    const id = typeof entry.source_id === "string" ? entry.source_id : null;
    if (id && id.length <= 512 && !found.has(id)) {
      const title = [entry.subject, entry.title, entry.name, entry.text_preview].find((v): v is string => typeof v === "string" && Boolean(v.trim()));
      const source = typeof entry.source === "string" ? entry.source : typeof entry.channel === "string" ? entry.channel : id.split(":")[0] ?? null;
      found.set(id, { sourceId: id, source, kind: typeof entry.kind === "string" ? entry.kind : null, title: title?.trim().slice(0, 120) ?? null, url: typeof entry.url === "string" ? entry.url : null });
    }
    for (const [key, child] of Object.entries(entry)) {
      if (key === "source_ids" || key === "actors") continue;
      if (typeof child === "object" || (key === "text" && typeof child === "string")) visit(child, depth + 1);
    }
  };
  visit(output, 0);
  return [...found.values()];
}

export const isWorkTool = (name: string | undefined | null) => Boolean(name && name.startsWith(WORK_TOOL_PREFIX));

export function WorkSourceChips(props: { output: unknown }) {
  const records = recordsInOutput(props.output);
  if (!records.length) return null;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label={t("work.viewer.sources")} data-testid="work-source-chips">
      {records.map((record) => (
        <li key={record.sourceId}>
          <button
            type="button"
            onClick={() => requestOpenRecord({ ...record, list: records })}
            title={record.title ?? record.sourceId}
            className="flex h-7 max-w-[260px] items-center gap-1.5 rounded-full border border-border bg-background ps-1 pe-2.5 text-[12px] text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
            data-source-chip={record.sourceId}
          >
            <BrandTile id={sourceMark({ source: record.source, kind: record.kind })} size="chip" className="rounded-full" />
            <span className="min-w-0 truncate">{record.title || [sourceLabel({ source: record.source ?? "", kind: record.kind }), record.kind?.replace(/_/g, " ")].filter(Boolean).join(" · ")}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
