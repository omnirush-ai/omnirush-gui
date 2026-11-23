/** @jsxImportSource react */
// The record's body by its `view` (design 2.5's table; records.view_of on the server). An unknown view shows its fields
// and text, never a blank panel.
import { ChatView } from "./chat-view";
import { CodeView } from "./code-view";
import { CrmView, TicketView } from "./crm-view";
import { DocView } from "./doc-view";
import { EventView } from "./event-view";
import { FinanceView } from "./finance-view";
import { IssueView } from "./issue-view";
import { MailView } from "./mail-view";
import { MeetingView } from "./meeting-view";
import { Body, FieldGrid } from "./parts";
import type { MailMessage, RecordFile, WorkRecord } from "./records";

export function RecordView(props: { record: WorkRecord; onPreview: (file: RecordFile, sourceId: string) => void; onReplyTo?: (message: MailMessage) => void }) {
  const { record, onPreview } = props;
  switch (record.view) {
    case "mail": return <MailView record={record} onPreview={onPreview} onReplyTo={props.onReplyTo} />;
    case "chat": return <ChatView record={record} onPreview={onPreview} />;
    case "issue": return <IssueView record={record} onPreview={onPreview} />;
    case "doc": return <DocView record={record} onPreview={onPreview} />;
    case "event": return <EventView record={record} />;
    case "crm": return <CrmView record={record} onPreview={onPreview} />;
    case "ticket": return <TicketView record={record} onPreview={onPreview} />;
    case "finance": return <FinanceView record={record} />;
    case "meeting": return <MeetingView record={record} />;
    case "code": return <CodeView record={record} />;
    default:
      return (
        <div className="flex flex-col gap-5 px-4 py-4" data-testid="work-generic-view">
          <FieldGrid fields={record.fields} />
          <Body body={record.body} />
        </div>
      );
  }
}
