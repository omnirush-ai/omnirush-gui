/** @jsxImportSource react */
// CRM records (HubSpot, Salesforce, Pipedrive; Intercom contacts) and support tickets (Zendesk, Intercom, Front,
// Freshdesk, Salesforce cases; design 2.5): the stage or status, the key fields, the conversation with internal notes
// marked, and the timeline of linked mail, calls and notes.
import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { money } from "./finance-view";
import { CommentList } from "./issue-view";
import { AttachmentChips, Body, FieldGrid, PersonName, SectionTitle } from "./parts";
import type { RecordField, RecordFile, WorkRecord } from "./records";

// CRM property names as people say them; the rest lose their vendor prefix and underscores.
const PROPERTY_NAMES: Record<string, string> = {
  firstname: "First name", lastname: "Last name", dealname: "Deal name", dealstage: "Deal stage", closedate: "Close date",
  createdate: "Created", lastmodifieddate: "Last modified", object_id: "Record id", jobtitle: "Job title", lifecyclestage: "Lifecycle stage",
};
function propertyName(key: string): string {
  const bare = key.trim().replace(/^hs_/i, "").toLowerCase();
  return PROPERTY_NAMES[bare] ?? bare.replace(/[_.]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** A text that is only "key: value" lines (a CRM record's properties as the sync kept them), as fields; else null. */
export function propertyLines(text: string | null | undefined): RecordField[] | null {
  const lines = (text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) return null;
  const pairs = lines.map((line) => line.match(/^([A-Za-z][\w .-]{0,40}):\s+(.+)$/));
  if (pairs.filter(Boolean).length / lines.length < 0.6) return null;
  return pairs.filter((m): m is RegExpMatchArray => Boolean(m)).map((m) => ({ label: propertyName(m[1]!), value: m[2]! }));
}

function AllProperties(props: { fields: RecordField[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label={t("work.viewer.all_properties")}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-1 text-[12px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:underline" data-testid="work-viewer-properties">
        <ChevronRight className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
        {t("work.viewer.all_properties")}
      </button>
      {open ? <FieldGrid fields={props.fields} className="mt-2" /> : null}
    </section>
  );
}

const MONEY_LABEL = /^(amount|value|deal value|balance|total|price|revenue|annual revenue)$/i;

/** A deal's money fields with their currency ("$48,000.00"), from its Currency field or the synced
 *  `deal_currency_code`; the Currency field itself then goes. Without a known currency the fields stay as they are. */
export function crmFields(fields: RecordField[] | undefined, properties: RecordField[] | null): RecordField[] {
  const list = fields ?? [];
  const named = list.find((field) => /^currency$/i.test(field.label.trim()))?.value
    ?? properties?.find((field) => /^(deal currency code|currency)$/i.test(field.label.trim()))?.value
    ?? "";
  const currency = named.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return list;
  return list
    .filter((field) => !/^currency$/i.test(field.label.trim()))
    .map((field) => (MONEY_LABEL.test(field.label.trim()) ? { ...field, value: money(field.value, currency) || field.value } : field));
}

export function CrmView(props: { record: WorkRecord; onPreview: (file: RecordFile, sourceId: string) => void }) {
  const record = props.record;
  const properties = propertyLines(record.body?.content);
  return (
    <div className="flex flex-col gap-5 px-4 py-4" data-testid="work-crm-view">
      <FieldGrid fields={crmFields(record.fields, properties)} />
      {properties ? <AllProperties fields={properties} /> : record.body?.content?.trim() ? (
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
