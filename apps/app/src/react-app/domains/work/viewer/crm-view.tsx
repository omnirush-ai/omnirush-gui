/** @jsxImportSource react */
// CRM records (HubSpot, Salesforce, Pipedrive; Intercom contacts) and support tickets (Zendesk, Intercom, Front,
// Freshdesk, Salesforce cases; design 2.5): the stage or status, the key fields, the conversation with internal notes
// marked, and the timeline of linked mail, calls and notes.
import { t } from "@/i18n";

import { CommentList } from "./issue-view";
import { AttachmentChips, Body, FieldGrid, PersonName, SectionTitle } from "./parts";
import type { RecordFile, WorkRecord } from "./records";

export function CrmView(props: { record: WorkRecord; onPreview: (file: RecordFile, sourceId: string) => void }) {
  const record = props.record;
  return (
    <div className="flex flex-col gap-5 px-4 py-4" data-testid="work-crm-view">
      <FieldGrid fields={record.fields} />
      {record.body?.content?.trim() ? (
        <section aria-label={t("work.viewer.notes")}>
          <SectionTitle>{t("work.viewer.notes")}</SectionTitle>
          <Body body={record.body} />
        </section>
      ) : null}
      {record.attachments?.length ? <AttachmentChips sourceId={record.source_id} files={record.attachments} onPreview={props.onPreview} /> : null}
    </div>
  );
}

export function TicketView(props: { record: WorkRecord; onPreview: (file: RecordFile, sourceId: string) => void }) {
  const record = props.record;
  const fields = (record.fields ?? []).filter((f) => !/^(status|state)$/i.test(f.label));
  return (
    <div className="flex flex-col gap-5 px-4 py-4" data-testid="work-ticket-view">
      {record.requester ? (
        <p className="text-[13px] text-muted-foreground">{t("work.viewer.requester")} <PersonName person={record.requester} className="font-medium text-foreground" />{record.requester.email && record.requester.name ? <span className="ms-1">{record.requester.email}</span> : null}</p>
      ) : null}
      <FieldGrid fields={fields} />
      {record.body?.content?.trim() ? (
        <section aria-label={t("work.viewer.request")}>
          <SectionTitle>{t("work.viewer.request")}</SectionTitle>
          <div className="rounded-xl border border-border bg-muted/20 px-3.5 py-3"><Body body={record.body} /></div>
        </section>
      ) : null}
      {record.attachments?.length ? <AttachmentChips sourceId={record.source_id} files={record.attachments} onPreview={props.onPreview} /> : null}
      <CommentList comments={record.comments} title={t("work.viewer.conversation")} empty={record.actions?.length ? t("work.viewer.no_replies_yet") : undefined} />
    </div>
  );
}
