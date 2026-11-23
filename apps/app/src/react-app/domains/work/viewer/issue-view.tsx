/** @jsxImportSource react */
// Issues, pull requests and tasks (GitHub, GitLab, Jira, Linear, Asana, Trello, ClickUp, monday.com, Airtable; design
// 2.5): the reference and state, labels, a pull request's branches and size, the fields, the description and the
// comments. Comment timelines are shared with tickets and docs.
import { GitMerge, GitPullRequest } from "lucide-react";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { AttachmentChips, Avatar, Body, FieldGrid, PersonName, Pill, SectionTitle } from "./parts";
import { shortWhen, type RecordComment, type RecordFile, type RecordPullRequest, type WorkRecord } from "./records";

export function CommentList(props: { comments: RecordComment[] | null | undefined; title?: string; empty?: string }) {
  const comments = props.comments ?? [];
  return (
    <section aria-label={props.title ?? t("work.viewer.comments")} data-testid="work-viewer-comments">
      <SectionTitle count={comments.length || undefined}>{props.title ?? t("work.viewer.comments")}</SectionTitle>
      {!comments.length ? (
        props.empty ? <p className="text-[13px] text-muted-foreground">{props.empty}</p> : null
      ) : (
        <ol className="flex flex-col">
          {comments.map((comment, index) => (
            <li key={comment.source_id ?? index} className={cn("relative flex gap-2.5 pb-4 last:pb-0", comment.reply && "ps-8")}>
              {index < comments.length - 1 ? <span aria-hidden className={cn("absolute bottom-0 top-8 w-px bg-border", comment.reply ? "left-[2.75rem]" : "left-3")} /> : null}
              <Avatar person={comment.author} size="sm" />
              <div className={cn("min-w-0 flex-1", comment.internal && "rounded-lg border border-amber-6/60 bg-amber-2 px-2.5 py-2 dark:bg-amber-3/40")}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <PersonName person={comment.author} className="text-[13px] font-semibold text-foreground" />
                  {comment.internal ? <Pill tone="amber">{t("work.viewer.internal")}</Pill> : null}
                  <span className="text-[12px] text-muted-foreground">{shortWhen(comment.at)}</span>
                </div>
                <div className="mt-0.5"><Body body={comment.body} fold={false} /></div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function branch(value: RecordPullRequest["head"]): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.ref || value.label || "";
}

/** "omnirush-ai/omnirush-gui #418" or a key, for the panel's source line. */
export function issueRef(record: WorkRecord): string {
  if (record.ref?.repo && record.ref.number != null) return `${record.ref.repo} #${record.ref.number}`;
  return record.ref?.key ?? "";
}
/** The record's state word (Open, Merged, In progress ...). */
export function issueState(record: WorkRecord): string | null {
  if (record.pull_request?.merged) return t("work.viewer.merged");
  if (record.pull_request?.draft) return t("work.viewer.draft");
  const state = record.state as Record<string, unknown> | null | undefined;
  const fromState = typeof state?.status === "string" ? state.status : typeof state?.state === "string" ? state.state : null;
  const fromField = record.fields?.find((f) => /^(status|state)$/i.test(f.label))?.value ?? null;
  const value = fromState ?? fromField;
  return value ? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ") : null;
}

export function IssueView(props: { record: WorkRecord; onPreview: (file: RecordFile, sourceId: string) => void }) {
  const record = props.record;
  const pr = record.pull_request;
  const author = (record.actors ?? []).find((a) => a.role === "from" || a.role === "author" || a.role === "creator") ?? null;
  const fields = (record.fields ?? []).filter((f) => !/^(status|state)$/i.test(f.label));
  return (
    <div className="flex flex-col gap-5 px-4 py-4" data-testid="work-issue-view">
      {author || record.labels?.length ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px] text-muted-foreground">
          {author ? <span>{t("work.viewer.opened_by", { name: author.name || author.email || "", when: shortWhen(record.occurred_at) })}</span> : null}
          {(record.labels ?? []).map((label) => <Pill key={label}>{label}</Pill>)}
        </div>
      ) : null}
      {pr && (branch(pr.head) || pr.changed_files != null) ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[12px]" data-testid="work-pr-summary">
          {pr.merged ? <GitMerge className="size-3.5 text-purple-11" aria-hidden /> : <GitPullRequest className="size-3.5 text-green-11" aria-hidden />}
          {branch(pr.head) ? <span className="font-mono text-foreground">{branch(pr.head)} <span className="text-muted-foreground">→</span> {branch(pr.base)}</span> : null}
          {pr.changed_files != null ? <span className="text-muted-foreground">{t("work.viewer.files_changed", { count: pr.changed_files })}</span> : null}
          {pr.additions != null ? <span className="font-mono text-green-11">+{pr.additions}</span> : null}
          {pr.deletions != null ? <span className="font-mono text-red-11">-{pr.deletions}</span> : null}
        </div>
      ) : null}
      {fields.length ? <FieldGrid fields={fields} /> : null}
      {record.body?.content?.trim() ? (
        <section aria-label={t("work.viewer.description")}>
          <SectionTitle>{t("work.viewer.description")}</SectionTitle>
          <Body body={record.body} fold={false} />
        </section>
      ) : null}
      {record.attachments?.length ? <AttachmentChips sourceId={record.source_id} files={record.attachments} onPreview={props.onPreview} /> : null}
      <CommentList comments={record.comments} empty={record.actions?.length ? t("work.viewer.no_comments") : undefined} />
    </div>
  );
}

