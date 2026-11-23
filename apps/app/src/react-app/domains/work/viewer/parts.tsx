/** @jsxImportSource react */
// Pieces every record view uses: the viewer context (client, how links and records open), avatars, Markdown and plain
// text with their links caught, field grids, attachment chips with an in-panel preview, and the related records.
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, File, FileImage, FileText, Loader2, Paperclip } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { PdfPreview } from "@/react-app/domains/session/artifacts/preview";
import { MarkdownBlock } from "@/react-app/domains/session/surface/markdown";

import { BrandTile } from "../brand-icon";
import { linkParts, safeHref, splitPlainQuote } from "./mail-html";
import {
  fieldValue, fileSize, initials, personName, shortWhen, sourceMark, stateLabel, tint,
  type RecordClient, type RecordField, type RecordFile, type RecordLink, type RecordPerson, type RecordRef,
} from "./records";

export type ViewerContextValue = {
  client: RecordClient | null;
  /** A web link: the in-app browser (the URL shows in its address bar), else the system browser. */
  openLink: (url: string) => void;
  /** Another record, in this panel. */
  openRecord: (ref: RecordRef) => void;
  /** A new mail to this address (mailto: links). */
  composeTo: (address: string) => void;
};
export const ViewerContext = createContext<ViewerContextValue>({ client: null, openLink: () => {}, openRecord: () => {}, composeTo: () => {} });
export const useViewer = () => useContext(ViewerContext);

/** Opens a link the way the viewer does: mailto in a new mail, the web in the browser. */
export function useLinkOpener() {
  const viewer = useViewer();
  return (href: string) => {
    const safe = safeHref(href);
    if (!safe) return;
    if (/^mailto:/i.test(safe)) {
      const address = decodeURIComponent(safe.slice(7).split("?")[0] ?? "");
      if (address) viewer.composeTo(address);
      return;
    }
    viewer.openLink(safe);
  };
}

export function Avatar(props: { person: RecordPerson | null | undefined; size?: "sm" | "md" }) {
  const small = props.size === "sm";
  return (
    <span
      aria-hidden
      className={cn("flex shrink-0 select-none items-center justify-center rounded-full font-semibold", small ? "size-6 text-[12px]" : "size-8 text-[12px]", tint(props.person))}
    >
      {initials(props.person)}
    </span>
  );
}

/** Markdown from a source (an issue, a comment, a Slack message): rendered and sanitized by the app's renderer, links
 *  opened by the viewer instead of the window. */
export function RecordMarkdown(props: { text: string; className?: string; compact?: boolean }) {
  const open = useLinkOpener();
  if (!props.text.trim()) return null;
  return (
    <div
      className={cn("min-w-0 text-[13px] leading-[1.6] [&_.markdown-content]:text-[13px] [&_.markdown-content_img]:max-w-full [&_.markdown-content_img]:rounded-md [&_.markdown-content_h1]:text-[15px] [&_.markdown-content_h2]:text-[14px] [&_.markdown-content_h3]:text-[13px] [&_.markdown-content_h1]:font-semibold [&_.markdown-content_h2]:font-semibold [&_.markdown-content_h3]:font-semibold [&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0", props.compact && "[&_.markdown-content>*]:my-0 [&_.markdown-content_p]:my-0", props.className)}
      onClickCapture={(event) => {
        const anchor = (event.target as Element | null)?.closest?.("a[href]");
        if (!anchor) return;
        event.preventDefault();
        event.stopPropagation();
        open(anchor.getAttribute("href") ?? "");
      }}
    >
      <MarkdownBlock text={props.text} />
    </div>
  );
}

function Linked(props: { text: string }) {
  const open = useLinkOpener();
  return (
    <>
      {linkParts(props.text).map((part, index) => part.href ? (
        <a
          key={index}
          href={part.href}
          onClick={(event) => { event.preventDefault(); open(part.href!); }}
          className="text-link underline-offset-2 hover:underline"
        >
          {part.text}
        </a>
      ) : <span key={index}>{part.text}</span>)}
    </>
  );
}

/** A plain text body: links clickable, the quoted history folded behind "...". */
export function PlainText(props: { text: string; fold?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const { body, quote } = props.fold === false ? { body: props.text, quote: "" } : splitPlainQuote(props.text);
  return (
    <div className={cn("min-w-0 whitespace-pre-wrap break-words text-[13px] leading-[1.6] text-foreground", props.className)}>
      <Linked text={body} />
      {quote ? (
        <>
          <div>
            <button
              type="button"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              aria-label={open ? t("work.viewer.hide_quoted") : t("work.viewer.show_quoted")}
              className="mt-1.5 inline-flex h-5 items-center rounded-md border border-border bg-muted/60 px-1.5 text-[12px] leading-none text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              •••
            </button>
          </div>
          {open ? <div className="mt-2 border-s-2 border-border ps-3 text-muted-foreground"><Linked text={quote} /></div> : null}
        </>
      ) : null}
    </div>
  );
}

/** A body in its format: Markdown, plain text, or HTML shown as text (HTML mail has its own frame). */
export function Body(props: { body: { format: string; content: string } | null | undefined; fold?: boolean }) {
  if (!props.body?.content?.trim()) return null;
  if (props.body.format === "markdown") return <RecordMarkdown text={props.body.content} />;
  return <PlainText text={props.body.content} fold={props.fold} />;
}

export function SectionTitle(props: { children: ReactNode; count?: number; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 pb-2">
      <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
        {props.children}
        {props.count != null ? <span className="rounded-full bg-muted px-1.5 text-[12px] font-medium normal-case tracking-normal">{props.count}</span> : null}
      </h3>
      {props.action}
    </div>
  );
}

/** Label and value pairs, two columns where they fit. */
export function FieldGrid(props: { fields: RecordField[] | null | undefined; className?: string }) {
  const fields = (props.fields ?? []).filter((f) => f.label && f.value);
  if (!fields.length) return null;
  return (
    <dl className={cn("grid grid-cols-[minmax(84px,max-content)_1fr] gap-x-4 gap-y-1.5 text-[13px] leading-5", props.className)} data-testid="work-viewer-fields">
      {fields.map((field, index) => (
        <div key={`${field.label}:${index}`} className="contents">
          <dt className="truncate text-muted-foreground">{field.label}</dt>
          <dd className="min-w-0 break-words text-foreground"><Linked text={fieldValue(field.label, field.value)} /></dd>
        </div>
      ))}
    </dl>
  );
}

/** A status-like value as a quiet pill: the words in the foreground colour (4.5:1 in light and dark), the tone on a
 *  small dot and the border, as the shell's StatusPill. */
export function Pill(props: { children: ReactNode; tone?: "neutral" | "green" | "amber" | "red" | "blue" | "purple"; className?: string; state?: boolean }) {
  const toneId = props.tone ?? "neutral";
  const border = { neutral: "border-border", green: "border-green-6", amber: "border-amber-6", red: "border-red-6", blue: "border-blue-6", purple: "border-purple-6" }[toneId];
  const dot = { neutral: "bg-muted-foreground/60", green: "bg-green-9", amber: "bg-amber-9", red: "bg-red-9", blue: "bg-blue-9", purple: "bg-purple-9" }[toneId];
  // A state word reads the same whatever case the source sends ("AUTHORISED", "open"); labels keep their own.
  const children = props.state && typeof props.children === "string" ? stateLabel(props.children) : props.children;
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border bg-background px-2 text-[12px] font-medium leading-none text-foreground", border, props.className)} data-tone={toneId}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      {children}
    </span>
  );
}
/** A tone for a status word (open, closed, merged, paid, overdue ...). */
export function statusTone(value: string | null | undefined): "neutral" | "green" | "amber" | "red" | "blue" | "purple" {
  const word = (value ?? "").toLowerCase();
  if (/merged/.test(word)) return "purple";
  if (/(open|active|new|to ?do|in progress|pending|negotiat|draft|sent|unpaid|authori)/.test(word)) return /draft/.test(word) ? "neutral" : "green";
  if (/(overdue|fail|error|declin|lost|cancel|void|urgent|high|blocked)/.test(word)) return "red";
  if (/(paid|done|closed|resolved|won|complete|success|deliver)/.test(word)) return "blue";
  if (/(hold|wait|maybe|tentative|review)/.test(word)) return "amber";
  return "neutral";
}

const isImage = (type: string | null | undefined) => /^image\/(?:png|jpeg|gif|webp)/i.test(type ?? "");
const isPdf = (type: string | null | undefined) => /^application\/pdf/i.test(type ?? "");
const isText = (type: string | null | undefined) => /^text\/plain/i.test(type ?? "");

function FileIcon(props: { type?: string | null; className?: string }) {
  const Icon = isImage(props.type) ? FileImage : isPdf(props.type) || isText(props.type) ? FileText : File;
  return <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", props.className)} />;
}

/** The files of a message or record as chips; a click previews images, PDFs and text in the panel, others download. */
export function AttachmentChips(props: { sourceId: string; files: RecordFile[] | null | undefined; onPreview: (file: RecordFile, sourceId: string) => void }) {
  const files = (props.files ?? []).filter((f) => !f.inline);
  if (!files.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={t("work.viewer.attachments")} data-testid="work-viewer-attachments">
      {files.map((file) => (
        <li key={file.n}>
          <button
            type="button"
            onClick={() => props.onPreview(file, props.sourceId)}
            disabled={file.available === false && Boolean(file.skipped)}
            title={file.available === false && file.skipped ? t("work.viewer.file_not_kept") : file.name}
            className="flex h-8 max-w-[240px] items-center gap-2 rounded-lg border border-border bg-background px-2.5 text-[12px] text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            data-attachment={file.n}
          >
            <FileIcon type={file.content_type} />
            <span className="min-w-0 truncate">{file.name}</span>
            {file.size ? <span className="shrink-0 text-muted-foreground">{fileSize(file.size)}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Saves bytes as a file. */
export function saveBytes(data: ArrayBuffer, name: string, type: string | null) {
  const url = URL.createObjectURL(new Blob([data], { type: type ?? "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name || "file";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

/** One attachment over the record: an image, a PDF or text, with Save and Back (Esc). */
export function AttachmentPreview(props: { file: RecordFile; sourceId: string; onClose: () => void }) {
  const { client } = useViewer();
  const answer = useQuery({
    queryKey: ["omnirush-work-attachment", client?.baseUrl ?? "default", props.sourceId, props.file.n],
    queryFn: () => client!.getWorkRecordAttachment(props.sourceId, props.file.n),
    enabled: Boolean(client),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const type = answer.data?.contentType ?? props.file.content_type ?? null;
  const url = useMemo(() => (answer.data && (isImage(type) || isPdf(type)) ? URL.createObjectURL(new Blob([answer.data.data], { type: type ?? undefined })) : null), [answer.data, type]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const text = useMemo(() => (answer.data && isText(type) ? new TextDecoder().decode(answer.data.data).slice(0, 200_000) : null), [answer.data, type]);
  const previewable = isImage(type) || isPdf(type) || isText(type);
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background" role="dialog" aria-label={props.file.name} data-testid="work-attachment-preview">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
        <Button variant="ghost" size="icon-sm" onClick={props.onClose} aria-label={t("common.back")}><ArrowLeft /></Button>
        <FileIcon type={type} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{props.file.name}</span>
        {props.file.size ? <span className="shrink-0 text-[12px] text-muted-foreground">{fileSize(props.file.size)}</span> : null}
        <Button variant="outline" size="sm" disabled={!answer.data} onClick={() => answer.data && saveBytes(answer.data.data, answer.data.filename ?? props.file.name, type)}>
          <Download className="size-3.5" />{t("work.viewer.save")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
        {answer.isLoading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="size-5 animate-spin" aria-label={t("work.viewer.loading")} /></div>
        ) : answer.isError ? (
          <p className="p-6 text-center text-[13px] text-muted-foreground">{t("work.viewer.file_unreadable")}</p>
        ) : !previewable ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <Paperclip className="size-6 text-muted-foreground" aria-hidden />
            <p className="max-w-[280px] text-[13px] text-muted-foreground">{t("work.viewer.no_preview")}</p>
          </div>
        ) : isImage(type) && url ? (
          <div className="flex min-h-full items-center justify-center p-4"><img src={url} alt={props.file.name} className="max-h-full max-w-full rounded-md border border-border bg-background object-contain" /></div>
        ) : isPdf(type) && url ? (
          // Chromium's own PDF viewer (as the docs preview uses it): a sandboxed frame would show a blank page.
          <PdfPreview url={url} title={props.file.name} />
        ) : text != null ? (
          <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-5 text-foreground">{text}</pre>
        ) : null}
      </div>
    </div>
  );
}

/** The records this one is linked to (mail about a deal, the call with a contact): each opens in this panel. The first
 *  five show, then "Show N more". */
export function RelatedList(props: { links: RecordLink[] | null | undefined }) {
  const { openRecord } = useViewer();
  const [all, setAll] = useState(false);
  const links = props.links ?? [];
  if (!links.length) return null;
  const shown = all ? links : links.slice(0, 5);
  return (
    <section aria-label={t("work.viewer.related")} data-testid="work-viewer-related">
      <SectionTitle count={links.length}>{t("work.viewer.related")}</SectionTitle>
      <ul className="flex flex-col overflow-hidden rounded-xl border border-border">
        {shown.map((link) => (
          <li key={link.source_id} className="border-b border-border last:border-b-0">
            <button
              type="button"
              onClick={() => openRecord({ sourceId: link.source_id, source: link.source, kind: link.kind, title: link.subject })}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-start outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <BrandTile id={sourceMark(link)} size="chip" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{link.subject?.trim() || link.kind.replace(/_/g, " ")}</span>
              <span className="shrink-0 text-[12px] text-muted-foreground">{shortWhen(link.occurred_at)}</span>
            </button>
          </li>
        ))}
      </ul>
      {links.length > shown.length ? (
        <button type="button" onClick={() => setAll(true)} className="mt-2 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:underline" data-testid="work-viewer-related-more">
          {t("work.viewer.show_more", { count: links.length - shown.length })}
        </button>
      ) : null}
    </section>
  );
}

/** The panel's loading state: title bar and three blocks (static under reduced motion: the skeleton's pulse is
 *  motion-safe). */
export function RecordSkeleton() {
  const still = "motion-reduce:animate-none";
  return (
    <div className="flex flex-col gap-5 p-4" aria-busy="true" aria-label={t("work.viewer.loading")} data-testid="work-viewer-loading">
      <div className="flex items-center gap-2"><Skeleton className={cn("size-5 rounded-md", still)} /><Skeleton className={cn("h-3 w-32 rounded-md", still)} /></div>
      <Skeleton className={cn("h-5 w-4/5 rounded-md", still)} />
      <Skeleton className={cn("h-3 w-1/2 rounded-md", still)} />
      <div className="flex flex-col gap-2 pt-2"><Skeleton className={cn("h-3 w-full rounded-md", still)} /><Skeleton className={cn("h-3 w-11/12 rounded-md", still)} /><Skeleton className={cn("h-3 w-3/4 rounded-md", still)} /></div>
      <Skeleton className={cn("h-24 w-full rounded-xl", still)} />
      <Skeleton className={cn("h-16 w-full rounded-xl", still)} />
    </div>
  );
}

/** "Ana Ortiz" with the address on hover and for copying. */
export function PersonName(props: { person: RecordPerson | null | undefined; className?: string }) {
  const name = personName(props.person);
  const email = props.person?.email ?? undefined;
  return <span className={cn("truncate", props.className)} title={email && email !== name ? email : undefined}>{name || email || t("work.viewer.someone")}</span>;
}
