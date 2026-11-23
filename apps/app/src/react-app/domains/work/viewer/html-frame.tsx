/** @jsxImportSource react */
// One HTML mail body in a sandboxed frame (judge M18): `sandbox="allow-same-origin"` with no scripts, a srcdoc with a
// strict CSP, sized from the parent with a ResizeObserver, links caught in the parent (the viewer opens them after
// showing where they go), `cid:` images fetched from the message's attachments as `blob:` URLs, and the quoted history
// folded behind "...". Wide newsletters are scaled to fit the panel.
import { Ellipsis } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { getResolvedThemeMode, subscribeToTheme } from "@/app/theme";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { mailSrcdoc, safeHref, sanitizeMailHtml } from "./mail-html";
import type { RecordClient, RecordFile } from "./records";

export function useDarkTheme(): boolean {
  return useSyncExternalStore(subscribeToTheme, getResolvedThemeMode, getResolvedThemeMode) === "dark";
}

/** The message's inline images (`cid:`), fetched once as `blob:` URLs and let go when the frame goes. */
function useCidUrls(client: RecordClient | null, sourceId: string, cids: string[], files: RecordFile[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const wanted = cids.join("\n");
  useEffect(() => {
    if (!client || !cids.length) return;
    let cancelled = false;
    const made: string[] = [];
    void (async () => {
      const found: Record<string, string> = {};
      for (const cid of cids) {
        const file = files.find((f) => (f.cid ?? "").replace(/^<|>$/g, "") === cid);
        if (!file) continue;
        try {
          const answer = await client.getWorkRecordAttachment(sourceId, file.n);
          if (!/^image\/(?:png|jpeg|gif|webp)/i.test(answer.contentType ?? "")) continue;
          const url = URL.createObjectURL(new Blob([answer.data], { type: answer.contentType ?? "application/octet-stream" }));
          made.push(url);
          found[cid] = url;
        } catch {
          // An inline image that can't be read stays blank.
        }
      }
      if (!cancelled) setUrls(found);
    })();
    return () => {
      cancelled = true;
      for (const url of made) URL.revokeObjectURL(url);
    };
    // `wanted` stands for `cids`; files only matter for those names.
  }, [client, sourceId, wanted]);
  return urls;
}

export function MailFrame(props: {
  html: string;
  sourceId: string;
  files: RecordFile[];
  client: RecordClient | null;
  title: string;
  showImages: boolean;
  onOpenLink: (url: string) => void;
  onRemoteImages?: (count: number) => void;
}) {
  const dark = useDarkTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const [hover, setHover] = useState<string | null>(null);
  const [showQuote, setShowQuote] = useState(false);
  const first = useMemo(() => sanitizeMailHtml(props.html, { showImages: props.showImages }), [props.html, props.showImages]);
  const cidUrls = useCidUrls(props.client, props.sourceId, first.cids, props.files);
  const clean = useMemo(
    () => (Object.keys(cidUrls).length ? sanitizeMailHtml(props.html, { showImages: props.showImages, cidUrls }) : first),
    [cidUrls, first, props.html, props.showImages],
  );
  const paper = dark && clean.styled;
  const srcdoc = useMemo(() => mailSrcdoc(clean.html, { showImages: props.showImages, theme: { dark, paper } }), [clean.html, dark, paper, props.showImages]);
  const onRemote = props.onRemoteImages;
  useEffect(() => { onRemote?.(first.remoteImages); }, [first.remoteImages, onRemote]);

  // The frame's document: size it, fit wide mail, catch links (click, middle click, Enter) and show where they go.
  const fitRef = useRef<() => void>(() => {});
  const showQuoteRef = useRef(showQuote);
  showQuoteRef.current = showQuote;
  const openRef = useRef(props.onOpenLink);
  openRef.current = props.onOpenLink;
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let detach = () => {};
    let width = 0;
    const attach = () => {
      detach();
      const doc = frame.contentDocument;
      const win = doc?.defaultView;
      if (!doc?.body || !win) return;
      doc.body.classList.toggle("omr-show", showQuoteRef.current);
      const fit = () => {
        // The body holds its children's margins (flow-root), so its bottom edge is where the mail ends.
        const box = doc.body.getBoundingClientRect();
        const next = Math.ceil(Math.max(box.bottom + (doc.documentElement.scrollTop || 0), box.height)) + 2;
        setHeight((current) => (Math.abs(current - next) > 1 ? next : current));
      };
      const rescale = () => {
        width = frame.clientWidth;
        doc.body.style.removeProperty("zoom");
        const wide = doc.documentElement.scrollWidth;
        if (width > 0 && wide > width + 4) doc.body.style.setProperty("zoom", String(Math.max(0.55, width / wide)));
        fit();
      };
      fitRef.current = fit;
      rescale();
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => fit());
      observer?.observe(doc.body);
      const outer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { if (Math.abs(frame.clientWidth - width) > 2) rescale(); });
      outer?.observe(frame);
      const images = Array.from(doc.images);
      for (const image of images) image.addEventListener("load", rescale);
      const linkOf = (event: Event) => {
        const target = event.target as Node | null;
        const element = target && target.nodeType === 1 ? (target as Element) : target?.parentElement ?? null;
        return element?.closest("a[href]") ?? null;
      };
      const open = (event: MouseEvent | KeyboardEvent) => {
        if (event.type === "keydown" && (event as KeyboardEvent).key !== "Enter") return;
        const anchor = linkOf(event);
        if (!anchor) return;
        event.preventDefault();
        event.stopPropagation();
        const href = safeHref(anchor.getAttribute("href"));
        if (href) openRef.current(href);
      };
      const over = (event: Event) => setHover(safeHref(linkOf(event)?.getAttribute("href")) ?? null);
      const leave = () => setHover(null);
      doc.addEventListener("click", open, true);
      doc.addEventListener("auxclick", open, true);
      doc.addEventListener("keydown", open, true);
      doc.addEventListener("mouseover", over);
      doc.addEventListener("focusin", over);
      doc.documentElement.addEventListener("mouseleave", leave);
      detach = () => {
        observer?.disconnect();
        outer?.disconnect();
        for (const image of images) image.removeEventListener("load", rescale);
        doc.removeEventListener("click", open, true);
        doc.removeEventListener("auxclick", open, true);
        doc.removeEventListener("keydown", open, true);
        doc.removeEventListener("mouseover", over);
        doc.removeEventListener("focusin", over);
        doc.documentElement.removeEventListener("mouseleave", leave);
        fitRef.current = () => {};
      };
    };
    frame.addEventListener("load", attach);
    if (frame.contentDocument?.readyState === "complete" && frame.contentDocument.body?.childNodes.length) attach();
    return () => {
      frame.removeEventListener("load", attach);
      detach();
    };
  }, [srcdoc]);
  useEffect(() => {
    const body = frameRef.current?.contentDocument?.body;
    if (!body) return;
    body.classList.toggle("omr-show", showQuote);
    fitRef.current();
  }, [showQuote]);

  return (
    <div className="relative" data-mail-frame>
      <div className={cn(paper && "rounded-lg border border-border bg-white px-3 py-3")}>
        <iframe
          ref={frameRef}
          title={props.title}
          // Never with allow-scripts (judge M18): same origin only so the parent can size it and catch its links.
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          srcDoc={srcdoc}
          className="block w-full border-0 bg-transparent"
          style={{ height }}
          data-testid="work-mail-frame"
        />
      </div>
      {clean.quoted ? (
        <button
          type="button"
          onClick={() => setShowQuote(!showQuote)}
          aria-expanded={showQuote}
          aria-label={showQuote ? t("work.viewer.hide_quoted") : t("work.viewer.show_quoted")}
          title={showQuote ? t("work.viewer.hide_quoted") : t("work.viewer.show_quoted")}
          className="mt-1.5 inline-flex h-5 items-center rounded-md border border-border bg-muted/60 px-1.5 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="work-mail-quote-toggle"
        >
          <Ellipsis className="size-3.5" aria-hidden />
        </button>
      ) : null}
      {hover ? (
        <div className="pointer-events-none absolute bottom-1 left-1 z-10 max-w-[85%] truncate rounded-md border border-border bg-popover px-2 py-0.5 font-mono text-[11px] text-popover-foreground shadow-sm" role="status" data-testid="work-mail-link-target">
          {hover}
        </div>
      ) : null}
    </div>
  );
}
