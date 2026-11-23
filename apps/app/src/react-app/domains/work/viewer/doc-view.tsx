/** @jsxImportSource react */
// Docs, pages and files (Notion, Confluence, Drive, OneDrive and SharePoint, Dropbox, Box, Figma, a repository file;
// design 2.5): where it lives, who owns it, the text the sync kept (Markdown where the source has it), the file itself
// when one was kept, and comments (Figma, Box).
import { t } from "@/i18n";

import { CommentList } from "./issue-view";
import { AttachmentChips, Body, FieldGrid, SectionTitle } from "./parts";
import type { RecordFile, WorkRecord } from "./records";

export function DocView(props: { record: WorkRecord; onPreview: (file: RecordFile, sourceId: string) => void }) {
  const record = props.record;
  const path = record.path?.trim();
  return (
    <div className="flex flex-col gap-5 px-4 py-4" data-testid="work-doc-view">
      {path ? <p className="truncate font-mono text-[12px] text-muted-foreground" title={path}>{path}</p> : null}
      <FieldGrid fields={record.fields} />
      {record.attachments?.length ? <AttachmentChips sourceId={record.source_id} files={record.attachments} onPreview={props.onPreview} /> : null}
      {record.body?.content?.trim() ? (
        <section aria-label={t("work.viewer.content")}>
          <SectionTitle>{t("work.viewer.content")}</SectionTitle>
          <div className="rounded-xl border border-border bg-background px-4 py-3"><Body body={record.body} fold={false} /></div>
        </section>
      ) : (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">{t("work.viewer.doc_no_text")}</p>
      )}
      {record.comments?.length || record.actions?.some((a) => a.id === "comment") ? <CommentList comments={record.comments} /> : null}
    </div>
  );
}
