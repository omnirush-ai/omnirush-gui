/** @jsxImportSource react */
/**
 * A Markdown file rendered in an editor tab, read-only, following the file's text as you type (300 ms; files over
 * 1 MB update when saved). The chat's renderer (sanitised: no raw HTML, no scripts). Links: a relative link opens
 * the file in the editor, `#anchor` scrolls, http(s) opens in the browser, anything else does nothing. Images: a
 * relative one loads from the project; a remote one is not loaded (a placeholder with its address).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type * as MonacoApi from "monaco-editor/editor/editor.api.js";

import type { OmniRushServerClient } from "@/app/lib/omnirush-server";
import { renderMarkdownHtml } from "@/components/markdown/markdown";
import { isImagePath } from "./image-view";
import { findMarkdownAnchor, resolveProjectPath } from "../markdown-anchor";

const LARGE = 1_000_000;
const MAX_IMAGES = 30;

export function MarkdownPreview(props: {
  client: OmniRushServerClient;
  workspaceId: string;
  path: string;
  model: MonacoApi.editor.ITextModel;
  isDirty: () => boolean;
  onOpenFile: (path: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  const [text, setText] = useState(() => props.model.getValue());
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setText(props.model.getValue());
    let timer = 0;
    const subscription = props.model.onDidChangeContent(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (props.model.getValueLength() > LARGE && props.isDirty()) return;
        setText(props.model.getValue());
      }, 300);
    });
    return () => {
      window.clearTimeout(timer);
      subscription.dispose();
    };
  }, [props.model, props.isDirty]);

  // Images are rewritten before the HTML reaches the page (a <template> loads nothing): a remote one becomes a
  // placeholder with its address, a relative one keeps its path in data-src and loads from the project below.
  const html = useMemo(() => {
    const template = document.createElement("template");
    template.innerHTML = renderMarkdownHtml(text, "surface");
    for (const image of Array.from(template.content.querySelectorAll("img"))) {
      const src = image.getAttribute("src") ?? "";
      image.removeAttribute("srcset");
      image.removeAttribute("src");
      // Inline images (data:image/…) load nothing from anywhere: shown as they are.
      if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp)[;,]/i.test(src)) {
        image.setAttribute("src", src);
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) {
        const note = document.createElement("span");
        note.className = "my-2 inline-block rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground";
        note.textContent = `Remote image not loaded: ${src}`;
        note.dataset.editorRemoteImage = src;
        (image.closest("button") ?? image).replaceWith(note);
        continue;
      }
      image.dataset.src = src;
    }
    return { __html: template.innerHTML };
  }, [text]);

  // Project images, read once per path while the preview is open (typing re-renders the HTML, not the images).
  const imageUrls = useRef(new Map<string, Promise<string | null>>());
  useEffect(() => {
    const urls = imageUrls.current;
    return () => {
      for (const url of urls.values()) void url.then((value) => value && URL.revokeObjectURL(value));
      urls.clear();
    };
  }, [props.client, props.workspaceId]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let cancelled = false;
    let loaded = 0;
    for (const image of Array.from(root.querySelectorAll<HTMLImageElement>("img[data-src]"))) {
      const target = resolveProjectPath(props.path, image.dataset.src ?? "");
      if (!target || !isImagePath(target) || loaded >= MAX_IMAGES) continue;
      loaded += 1;
      let url = imageUrls.current.get(target);
      if (!url) {
        url = props.client.editorRaw(props.workspaceId, target).then(
          (result) => URL.createObjectURL(new Blob([result.data], { type: result.contentType ?? "application/octet-stream" })),
          () => {
            // Not cached: the image may appear or be fixed while the preview is open.
            imageUrls.current.delete(target);
            return null;
          },
        );
        imageUrls.current.set(target, url);
      }
      void url.then((value) => {
        if (!cancelled && value) image.src = value;
      });
    }
    return () => {
      cancelled = true;
    };
  }, [html, props.client, props.path, props.workspaceId]);

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) {
      // The chat renderer wraps images in an "expand" button: nothing to expand here.
      if ((event.target as HTMLElement).closest("button[data-omnirush-image-preview]")) event.preventDefault();
      return;
    }
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    const inline = anchor.getAttribute("data-omnirush-inline-code-path");
    if (href.startsWith("#") && href.length > 1) {
      const root = rootRef.current;
      if (root) findMarkdownAnchor(root, href.slice(1))?.scrollIntoView({ block: "start" });
      return;
    }
    if (/^https?:\/\//i.test(href)) {
      props.onOpenExternal(href);
      return;
    }
    const target = resolveProjectPath(props.path, inline ?? href);
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(inline ?? href)) props.onOpenFile(target);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-editor-preview={props.path}>
      <div
        ref={rootRef}
        className="markdown-content mx-auto max-w-3xl select-text px-6 py-5 text-foreground"
        onClick={onClick}
        dangerouslySetInnerHTML={html}
      />
    </div>
  );
}
