import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_COLLECTOR_ATTACHMENT_TEXT_BYTES, isCollectorPathDenied, type CollectorAttachment } from "./workspace-collector.js";

/**
 * Turns the file parts of an engine prompt into collector "attachment" events:
 * identity (name, mime, size, sha256) for every file, plus extracted text for
 * text-like documents. Bytes come from the part's inline data URL or, for
 * files the app copied into the workspace, from a file URL inside the
 * workspace root; anything else is left alone. Redaction and the text cap are
 * applied by the collector when the event is recorded.
 */

const MAX_ATTACHMENTS_PER_PROMPT = 32;
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 16 * 1024 * 1024;
const MAX_PDF_PAGES = 200;
const GENERIC_MIME = "application/octet-stream";

const TEXT_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-typescript",
  "application/x-sh",
  "application/x-shellscript",
  "application/sql",
  "application/csv",
  "application/x-ndjson",
  "application/rtf",
  "application/x-httpd-php",
  "application/graphql",
  "message/rfc822",
]);

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "mdx", "rst", "adoc", "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg",
  "conf", "xml", "html", "htm", "svg", "css", "scss", "less", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go", "rs",
  "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "fish", "ps1", "sql", "graphql", "gql",
  "log", "diff", "patch", "env.example", "tex", "bib", "r", "lua", "pl", "scala", "clj", "ex", "exs", "erl", "hs", "vue", "svelte",
]);

const PDF_MIMES = new Set(["application/pdf", "application/x-pdf"]);

type FilePartSource = {
  name: string;
  mime: string;
  url: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedMime(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().split(";")[0]?.trim() ?? "" : "";
}

function mimeOfDataUrl(url: string): string {
  const match = /^data:([^;,]+)/i.exec(url);
  return match ? normalizedMime(match[1]) : "";
}

function extensionOf(name: string): string {
  const lower = basename(name).toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot > 0 ? lower.slice(dot + 1) : "";
}

function isPdfLike(mime: string, name: string, bytes: Buffer): boolean {
  if (PDF_MIMES.has(mime)) return true;
  if (mime !== "" && mime !== GENERIC_MIME) return false;
  return extensionOf(name) === "pdf" || bytes.subarray(0, 1024).toString("latin1").includes("%PDF-");
}

function isTextLike(mime: string, name: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (TEXT_MIMES.has(mime) || mime.endsWith("+json") || mime.endsWith("+xml") || mime.endsWith("+yaml")) return true;
  if (mime !== "" && mime !== GENERIC_MIME) return false;
  return TEXT_EXTENSIONS.has(extensionOf(name));
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8_192);
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

function promptParts(payload: unknown): unknown[] {
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.parts)) return payload.parts;
  // v2 prompt bodies nest the parts under the message.
  if (isRecord(payload.message) && Array.isArray(payload.message.parts)) return payload.message.parts;
  return [];
}

function fileSourceOf(part: unknown): FilePartSource | null {
  if (!isRecord(part) || part.type !== "file") return null;
  const url = typeof part.url === "string" ? part.url.trim() : "";
  if (!url) return null;
  const mime = normalizedMime(part.mime ?? part.mediaType ?? part.mimeType) || mimeOfDataUrl(url) || GENERIC_MIME;
  let name = typeof part.filename === "string" && part.filename.trim()
    ? part.filename.trim()
    : typeof part.name === "string" && part.name.trim() ? part.name.trim() : "";
  if (!name && url.startsWith("file:")) {
    try {
      name = basename(fileURLToPath(url));
    } catch {
      name = "";
    }
  }
  return { name: name || "attachment", mime, url };
}

/** File parts of a prompt body, in order. */
export function promptFileParts(payload: unknown): FilePartSource[] {
  return promptParts(payload).flatMap((part) => {
    const source = fileSourceOf(part);
    return source ? [source] : [];
  }).slice(0, MAX_ATTACHMENTS_PER_PROMPT);
}

function dataUrlBytes(url: string): Buffer | null {
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (payload.length > MAX_ATTACHMENT_BYTES * 2) return null;
  try {
    if (/;base64$/i.test(header)) return Buffer.from(payload, "base64");
    return Buffer.from(decodeURIComponent(payload), "utf8");
  } catch {
    return null;
  }
}

async function workspaceFileBytes(url: string, workspaceRoot: string | null): Promise<Buffer | null> {
  if (!workspaceRoot) return null;
  let absolute: string;
  try {
    absolute = resolve(fileURLToPath(url));
  } catch {
    return null;
  }
  const root = resolve(workspaceRoot);
  const relativePath = absolute.startsWith(`${root}/`) || absolute.startsWith(`${root}\\`) ? absolute.slice(root.length + 1) : null;
  if (!relativePath || isCollectorPathDenied(relativePath.replaceAll("\\", "/"))) return null;
  try {
    const file = await lstat(absolute);
    if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_ATTACHMENT_BYTES) return null;
    return await readFile(absolute);
  } catch {
    return null;
  }
}

type ExtractedText = { text: string | null; truncated: boolean };

async function pdfText(bytes: Buffer): Promise<ExtractedText> {
  if (bytes.length > MAX_PDF_BYTES) return { text: null, truncated: false };
  try {
    const { withPdfDocument } = await import("./pdf-attachments/pdfium.js");
    return await withPdfDocument(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), async (document) => {
      const pages: string[] = [];
      let total = 0;
      let truncated = document.info.pageCount > MAX_PDF_PAGES;
      const limit = Math.min(document.info.pageCount, MAX_PDF_PAGES);
      for (let page = 1; page <= limit; page += 1) {
        const text = document.pageText(page);
        pages.push(`--- page ${page} ---\n${text}`);
        total += Buffer.byteLength(text);
        // The collector caps the event text; pages past the cap never leave the parser.
        if (total > MAX_COLLECTOR_ATTACHMENT_TEXT_BYTES) {
          truncated = truncated || page < limit;
          break;
        }
      }
      return { text: pages.join("\n"), truncated };
    });
  } catch {
    return { text: null, truncated: false };
  }
}

async function attachmentText(source: FilePartSource, bytes: Buffer): Promise<ExtractedText> {
  if (isPdfLike(source.mime, source.name, bytes)) return pdfText(bytes);
  if (!isTextLike(source.mime, source.name) || looksBinary(bytes)) return { text: null, truncated: false };
  // Only the part the collector can keep is decoded; the rest never leaves the buffer.
  const limit = MAX_COLLECTOR_ATTACHMENT_TEXT_BYTES + 4;
  return { text: bytes.subarray(0, limit).toString("utf8"), truncated: bytes.length > limit };
}

/**
 * Reads every file attached to the prompt and describes it for the collector.
 * Files are read from their inline data or from inside the workspace root
 * only; unreadable or out-of-scope parts are skipped rather than guessed at.
 */
export async function collectPromptAttachments(payload: unknown, workspaceRoot: string | null): Promise<CollectorAttachment[]> {
  const attachments: CollectorAttachment[] = [];
  for (const source of promptFileParts(payload)) {
    const bytes = source.url.startsWith("data:")
      ? dataUrlBytes(source.url)
      : source.url.startsWith("file:") ? await workspaceFileBytes(source.url, workspaceRoot) : null;
    if (!bytes || bytes.length > MAX_ATTACHMENT_BYTES) continue;
    const extracted = await attachmentText(source, bytes);
    attachments.push({
      name: source.name,
      mime: source.mime,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text: extracted.text,
      textTruncated: extracted.truncated,
    });
  }
  return attachments;
}

/**
 * The prompt body as it is recorded in the "engine.request" trace event:
 * inline attachment payloads are replaced by a marker, since the attachment
 * itself is described by its own event and never belongs in the request log.
 */
export function promptBodyForTrace(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const strip = (parts: unknown[]) => parts.map((part) => {
    if (!isRecord(part) || part.type !== "file" || typeof part.url !== "string" || !part.url.startsWith("data:")) return part;
    const mime = mimeOfDataUrl(part.url) || GENERIC_MIME;
    return { ...part, url: `data:${mime};omitted`, omitted_url_chars: part.url.length };
  });
  if (Array.isArray(payload.parts)) return { ...payload, parts: strip(payload.parts) };
  if (isRecord(payload.message) && Array.isArray(payload.message.parts)) {
    return { ...payload, message: { ...payload.message, parts: strip(payload.message.parts) } };
  }
  return payload;
}
