/** @jsxImportSource react */
// Code (a commit, a pipeline, a repository; design 2.5): the message and files of a commit, a pipeline's state, a
// repository's details and README.
import { Copy } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";

import { Body, FieldGrid, Pill, SectionTitle, statusTone } from "./parts";
import { shortWhen, type WorkRecord } from "./records";

const STATUS: Record<string, string> = { added: "A", modified: "M", removed: "D", renamed: "R" };

export function CodeView(props: { record: WorkRecord }) {
  const code = props.record.code ?? {};
  const files = code.files ?? [];
  const copy = (value: string) => { void navigator.clipboard?.writeText(value); toast.success(t("work.viewer.copied")); };
  return (
    <div className="flex flex-col gap-5 px-4 py-4" data-testid="work-code-view">
      {code.sha ? (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
          <button type="button" onClick={() => copy(code.sha!)} className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("work.viewer.copy_sha")}>
            {code.sha.slice(0, 10)}<Copy className="size-3" aria-hidden />
          </button>
          {code.author ? <span>{code.author}</span> : null}
          {code.committed_at ? <span>{shortWhen(code.committed_at)}</span> : null}
          {code.status ? <Pill state tone={statusTone(code.status)}>{code.status}</Pill> : null}
          {code.ref ? <span className="font-mono">{code.ref}</span> : null}
        </div>
      ) : code.status ? <div className="flex items-center gap-2"><Pill state tone={statusTone(code.status)}>{code.status}</Pill>{code.ref ? <span className="font-mono text-[12px] text-muted-foreground">{code.ref}</span> : null}</div> : null}
      {code.message?.trim() ? <pre className="whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/30 px-3 py-2.5 font-mono text-[12px] leading-5 text-foreground">{code.message}</pre> : null}
      <FieldGrid fields={props.record.fields} />
      {files.length ? (
        <section aria-label={t("work.viewer.files")}>
          <SectionTitle count={files.length}>{t("work.viewer.files")}</SectionTitle>
          <ul className="flex flex-col overflow-hidden rounded-xl border border-border font-mono text-[12px]">
            {files.map((file, index) => (
              <li key={`${file.path}-${index}`} className="flex items-center gap-2 border-b border-border px-3 py-1.5 last:border-b-0">
                <span className="w-3 shrink-0 text-muted-foreground" title={file.status ?? undefined}>{STATUS[file.status ?? ""] ?? "M"}</span>
                <span className="min-w-0 flex-1 truncate text-foreground" title={file.path ?? undefined}>{file.path}</span>
                {file.additions != null ? <span className="text-green-11">+{file.additions}</span> : null}
                {file.deletions != null ? <span className="text-red-11">-{file.deletions}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {!code.message && props.record.body?.content?.trim() ? <Body body={props.record.body} fold={false} /> : null}
    </div>
  );
}
