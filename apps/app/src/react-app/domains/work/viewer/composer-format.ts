// What the viewer composer holds, written three ways (judge M19): clean HTML for mail and providers that keep it, Markdown
// for the ones that read it (GitHub, GitLab, Linear, Trello, Slack, Discord), and plain text for the rest and for the
// mail's text part. Only the nodes the composer makes: paragraphs, bold/italic/strikethrough/underline/code text, links,
// line breaks, bulleted and numbered lists (nested).
import { $isLinkNode } from "@lexical/link";
import { $isListItemNode, $isListNode, type ListNode } from "@lexical/list";
import { $isElementNode, $isLineBreakNode, $isTextNode, type ElementNode, type LexicalNode, type TextNode } from "lexical";

import type { ComposerContent } from "./records";

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const LINKABLE = /^(?:https?:\/\/|mailto:)/i;

type Out = { html: string; md: string; text: string };
const join = (parts: Out[]): Out => ({ html: parts.map((p) => p.html).join(""), md: parts.map((p) => p.md).join(""), text: parts.map((p) => p.text).join("") });

function wrapMd(value: string, mark: string): string {
  if (!value.trim()) return value;
  const lead = value.match(/^\s*/)![0];
  const tail = value.match(/\s*$/)![0];
  return `${lead}${mark}${value.trim()}${mark}${tail}`;
}

function textOut(node: TextNode): Out {
  const raw = node.getTextContent();
  let html = escapeHtml(raw);
  let md = raw;
  if (node.hasFormat("code")) {
    html = `<code>${html}</code>`;
    md = raw.includes("`") ? `\`\` ${raw} \`\`` : wrapMd(raw, "`");
    return { html, md, text: raw };
  }
  if (node.hasFormat("bold")) { html = `<strong>${html}</strong>`; md = wrapMd(md, "**"); }
  if (node.hasFormat("italic")) { html = `<em>${html}</em>`; md = wrapMd(md, "_"); }
  if (node.hasFormat("strikethrough")) { html = `<s>${html}</s>`; md = wrapMd(md, "~~"); }
  if (node.hasFormat("underline")) html = `<u>${html}</u>`;
  return { html, md, text: raw };
}

function inline(node: LexicalNode): Out {
  if ($isTextNode(node)) return textOut(node);
  if ($isLineBreakNode(node)) return { html: "<br>", md: "\n", text: "\n" };
  if ($isLinkNode(node)) {
    const inner = join(node.getChildren().map(inline));
    const url = node.getURL();
    if (!LINKABLE.test(url)) return inner;
    const same = inner.text.trim() === url || !inner.text.trim();
    return {
      html: `<a href="${escapeHtml(url)}">${same ? escapeHtml(url) : inner.html}</a>`,
      md: same ? url : `[${inner.md}](${url})`,
      text: same ? url : `${inner.text} (${url})`,
    };
  }
  if ($isElementNode(node)) return join(node.getChildren().map(inline));
  return { html: escapeHtml(node.getTextContent()), md: node.getTextContent(), text: node.getTextContent() };
}

function list(node: ListNode, depth: number): { html: string; lines: { md: string; text: string }[] } {
  const ordered = node.getListType() === "number";
  const tag = ordered ? "ol" : "ul";
  const lines: { md: string; text: string }[] = [];
  let html = `<${tag}>`;
  let n = node.getStart?.() ?? 1;
  for (const item of node.getChildren()) {
    if (!$isListItemNode(item)) continue;
    const own = item.getChildren().filter((child) => !$isListNode(child));
    const nested = item.getChildren().filter((child): child is ListNode => $isListNode(child));
    // An item that only holds a nested list is Lexical's way of indenting: no bullet of its own.
    const content = join(own.map(inline));
    const indent = "  ".repeat(depth) + (ordered && depth ? " " : "");
    const marker = ordered ? `${n}.` : "-";
    let inner = "";
    if (own.length) {
      lines.push({ md: `${indent}${marker} ${content.md}`, text: `${indent}${marker} ${content.text}` });
      inner = content.html;
      n += 1;
    }
    for (const sub of nested) {
      const child = list(sub, depth + 1);
      inner += child.html;
      lines.push(...child.lines);
    }
    html += `<li>${inner}</li>`;
  }
  html += `</${tag}>`;
  return { html, lines };
}

/** The root's blocks as HTML, Markdown and plain text. Call inside `editorState.read` or `editor.update`. */
export function serializeRoot(root: ElementNode): ComposerContent {
  const html: string[] = [];
  const md: string[] = [];
  const text: string[] = [];
  let lastWasList = false;
  for (const block of root.getChildren()) {
    if ($isListNode(block)) {
      const out = list(block, 0);
      if (md.length && md[md.length - 1] !== "" && !lastWasList) { md.push(""); text.push(""); }
      html.push(out.html);
      for (const line of out.lines) { md.push(line.md); text.push(line.text); }
      lastWasList = true;
      continue;
    }
    if (lastWasList && md.length) { md.push(""); text.push(""); }
    lastWasList = false;
    const out = $isElementNode(block) ? join(block.getChildren().map(inline)) : inline(block);
    html.push(out.text.length ? `<div>${out.html}</div>` : "<div><br></div>");
    md.push(out.md);
    text.push(out.text);
  }
  // No trailing blank lines; an empty composer is empty.
  while (text.length && !text[text.length - 1]!.trim()) { text.pop(); md.pop(); }
  while (html.length && html[html.length - 1] === "<div><br></div>") html.pop();
  const plain = text.join("\n");
  return { html: plain.trim() ? html.join("") : "", markdown: md.join("\n"), text: plain };
}
