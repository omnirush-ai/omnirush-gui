/** @jsxImportSource react */
import { useRef } from "react";
import type * as React from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { MarkdownBlock } from "../surface/markdown";
import { findMarkdownAnchor, resolveProjectPath } from "../markdown-anchor";

interface PreviewLoadingProps extends React.ComponentProps<"div"> {}

export function PreviewLoading({ className, ...props }: PreviewLoadingProps) {
  return (
    <div className={cn("flex h-full items-center justify-center text-muted-foreground", className)} {...props}>
      <Loader2 className="size-4 animate-spin" />
    </div>
  );
}

interface PreviewErrorProps extends React.ComponentProps<"div"> {
  message: string;
}

export function PreviewError({ message, className, ...props }: PreviewErrorProps) {
  return <div className={cn("p-4 text-sm text-muted-foreground", className)} {...props}>{message}</div>;
}

interface PlainTextProps extends React.ComponentProps<"pre"> {
  content: string;
}

export function PlainText({ content, className, ...props }: PlainTextProps) {
  return <pre className={cn("h-full overflow-auto p-4 text-xs leading-5 text-foreground whitespace-pre-wrap", className)} {...props}>{content}</pre>;
}

interface MarkdownPreviewProps extends React.ComponentProps<"div"> {
  content: string;
  mermaidSource?: boolean;
  path?: string;
  onOpenFile?: (path: string) => void;
}

function mermaidSourceMarkdown(content: string) {
  let longestBacktickRun = 2;
  let currentBacktickRun = 0;
  for (const character of content) {
    currentBacktickRun = character === "`" ? currentBacktickRun + 1 : 0;
    if (currentBacktickRun > longestBacktickRun) longestBacktickRun = currentBacktickRun;
  }
  const fence = "`".repeat(longestBacktickRun + 1);
  return `${fence}mermaid\n${content}\n${fence}`;
}

export function MarkdownPreview({ content, mermaidSource = false, path, onOpenFile, className, ...props }: MarkdownPreviewProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest("a");
    if (!anchor) return;

    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("#") && href.length > 1) {
      event.preventDefault();
      const root = rootRef.current;
      if (root) findMarkdownAnchor(root, href.slice(1))?.scrollIntoView({ block: "start" });
      return;
    }

    if (path && onOpenFile && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      const target = resolveProjectPath(path, href);
      if (target) {
        event.preventDefault();
        onOpenFile(target);
      }
    }
  };

  return (
    <div ref={rootRef} onClick={onClick} data-omnirush-markdown-preview="" data-omnirush-mermaid-artifact={mermaidSource ? "" : undefined} className={cn("h-full overflow-auto p-4", className)} {...props}>
      <MarkdownBlock text={mermaidSource ? mermaidSourceMarkdown(content) : content} />
    </div>
  );
}

interface TextHTMLPreviewProps {
  type: "text";
  title: string;
  content: string;
}

interface BinaryHTMLPreviewProps {
  type: "binary";
  title: string;
  url: string;
}

type HTMLPreviewProps = { className?: string } & (TextHTMLPreviewProps | BinaryHTMLPreviewProps);

export function HTMLPreview({ className, ...props }: HTMLPreviewProps) {
  // Keep artifact scripts in an opaque origin so they cannot access the app or its desktop bridge.
  if (props.type === "text") {
    return <iframe srcDoc={props.content} title={props.title} className={cn("h-full w-full border-0", className)} sandbox="allow-scripts" />;
  }

  return <iframe src={props.url} title={props.title} className={cn("h-full w-full border-0", className)} sandbox="allow-scripts" />;
}

interface PdfPreviewProps {
  url: string;
  title: string;
  className?: string;
}

export function PdfPreview({ url, title, className }: PdfPreviewProps) {
  // Chromium's built-in PDF viewer (enabled via webPreferences.plugins) renders
  // reliably through <embed>; <object>/sandboxed <iframe> show a blank frame.
  // The blob URL comes from a trusted workspace file.
  return <embed src={url} type="application/pdf" title={title} className={cn("h-full w-full border-0", className)} />;
}

interface ImagePreviewProps extends React.ComponentProps<"div"> {
  src: string;
  alt: string;
}

export function ImagePreview({ src, alt, className, ...props }: ImagePreviewProps) {
  return (
    <div className={cn("flex h-full items-center justify-center overflow-auto bg-muted/30 p-3", className)} {...props}>
      <img src={src} alt={alt} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

interface PreviewUnavailableProps extends React.ComponentProps<"div"> {}

export function PreviewUnavailable({ className, ...props }: PreviewUnavailableProps) {
  return <div className={cn("p-4 text-sm text-muted-foreground", className)} {...props}>Preview unavailable. Open externally to view this file.</div>;
}
