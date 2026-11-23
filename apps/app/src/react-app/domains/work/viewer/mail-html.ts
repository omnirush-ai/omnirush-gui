// HTML mail, made safe to show (judge M18): DOMPurify with forms, frames, embeds and scripts removed and no event
// handlers, remote images held back until asked for, `cid:` images pointed at the message's own attachments, the quoted
// history marked so it folds, and a srcdoc with a CSP that allows no script, no network but `data:`/`blob:` images
// (and `https:` images once shown). The frame is `sandbox="allow-same-origin"` only (never with `allow-scripts`).
import DOMPurify from "dompurify";

/** Never kept, whatever the mail says (judge M18 plus the frame tags DOMPurify keeps by default). */
export const MAIL_FORBID_TAGS = ["form", "input", "button", "textarea", "select", "option", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "meta", "link", "script", "portal"];
export const MAIL_FORBID_ATTR = ["formaction", "action", "srcset", "ping", "target", "autofocus", "contenteditable"];

/** A 1 px transparent GIF: where a held-back or not-yet-loaded image was, so the layout keeps its size. */
export const BLANK_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const REMOTE = /^\s*(?:https?:)?\/\//i;
const CSS_URL = /url\(\s*(['"]?)\s*((?:https?:)?\/\/[^'")]+)\1\s*\)/gi;
/** The quoted history's start in the clients people use (Gmail, Outlook, Apple Mail, Yahoo, Thunderbird). */
const QUOTE_START = ".gmail_quote, blockquote[type='cite'], #divRplyFwdMsg, #appendonsend, .yahoo_quoted, div[name='messageReplySection'], .moz-cite-prefix, #reply-intro";

export type SanitizedMail = {
  html: string;
  /** Images from the network the mail asks for (held back until "Show images"). */
  remoteImages: number;
  /** `cid:` names the mail shows inline. */
  cids: string[];
  /** The quoted history is marked `.omr-q` and folds behind "...". */
  quoted: boolean;
  /** The mail paints its own colours (a newsletter): shown on a light page in dark mode too. */
  styled: boolean;
};

const UNSAFE_URL = /^(?:javascript|vbscript|data|file|blob):/i;
const URL_ATTRS = ["href", "src", "xlink:href", "action", "formaction", "background", "poster", "data", "cite", "longdesc", "lowsrc", "dynsrc"];

/** A second pass after DOMPurify (it does the work; this holds whatever DOM it ran in): no forbidden element, no
 *  handler attribute, no script-like URL anywhere. */
export function scrubMail(root: DocumentFragment | Element) {
  for (const node of Array.from(root.querySelectorAll(MAIL_FORBID_TAGS.join(",")))) node.remove();
  for (const element of Array.from(root.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || MAIL_FORBID_ATTR.includes(name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (URL_ATTRS.includes(name)) {
        // Browsers ignore whitespace and control characters inside a scheme ("java\tscript:").
        const value = attribute.value.replace(/[\u0000-\u0020\u007f-\u009f]+/g, "");
        const image = element.tagName === "IMG" && name === "src" && /^(?:data:image\/(?:png|jpeg|gif|webp);|blob:)/i.test(value);
        if (UNSAFE_URL.test(value) && !image) element.removeAttribute(attribute.name);
      }
    }
  }
}

let hooked = false;
function hook() {
  if (hooked || typeof DOMPurify.addHook !== "function") return;
  hooked = true;
  DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    // Belt and braces: no on* attribute, whatever DOMPurify's list says.
    if (/^on/i.test(data.attrName)) data.keepAttr = false;
  });
}

/** The mail's HTML, cleaned. `cidUrls` maps a Content-ID (without `<>`) to a `blob:` URL once fetched; `showImages`
 *  lets remote images load (the CSP then allows `https:`). */
export function sanitizeMailHtml(raw: string, options: { showImages?: boolean; cidUrls?: Record<string, string> } = {}): SanitizedMail {
  if (typeof DOMPurify.sanitize !== "function") return { html: "", remoteImages: 0, cids: [], quoted: false, styled: false };
  hook();
  // One wrapper around the mail, taken off after: whatever DOM DOMPurify runs in, the mail's own first element is kept.
  const cleaned = DOMPurify.sanitize(`<div id="omr-root">${raw}</div>`, {
    WHOLE_DOCUMENT: false,
    FORCE_BODY: true,
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: MAIL_FORBID_TAGS,
    FORBID_ATTR: MAIL_FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ["bgcolor", "background", "align", "valign", "cellpadding", "cellspacing", "border", "width", "height", "color", "face", "size"],
  }) as DocumentFragment;
  const wrapper = cleaned.firstElementChild;
  let fragment = cleaned;
  if (wrapper && wrapper.id === "omr-root" && cleaned.childNodes.length === 1) {
    fragment = wrapper.ownerDocument.createDocumentFragment();
    while (wrapper.firstChild) fragment.appendChild(wrapper.firstChild);
  }
  scrubMail(fragment);
  let remoteImages = 0;
  const cids = new Set<string>();
  const cidUrls = options.cidUrls ?? {};
  const show = Boolean(options.showImages);

  for (const img of Array.from(fragment.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    if (/^cid:/i.test(src)) {
      const name = src.slice(4).replace(/^<|>$/g, "").trim();
      cids.add(name);
      img.setAttribute("src", cidUrls[name] ?? BLANK_IMAGE);
    } else if (REMOTE.test(src)) {
      remoteImages += 1;
      if (!show) {
        img.setAttribute("data-omr-src", src);
        img.setAttribute("src", BLANK_IMAGE);
      } else if (src.startsWith("//")) {
        img.setAttribute("src", `https:${src}`);
      }
    } else if (src && !/^(?:data:image\/|blob:)/i.test(src)) {
      img.setAttribute("src", BLANK_IMAGE);
    }
  }
  for (const node of Array.from(fragment.querySelectorAll("[background]"))) {
    const value = node.getAttribute("background") ?? "";
    if (REMOTE.test(value)) {
      remoteImages += 1;
      if (!show) node.removeAttribute("background");
    } else if (!/^(?:data:image\/|blob:)/i.test(value)) node.removeAttribute("background");
  }
  const scrubCss = (css: string) => css.replace(CSS_URL, (whole) => {
    remoteImages += 1;
    return show ? whole : "none";
  });
  for (const node of Array.from(fragment.querySelectorAll("[style]"))) {
    const style = node.getAttribute("style") ?? "";
    if (/url\(/i.test(style)) node.setAttribute("style", scrubCss(style));
  }
  for (const node of Array.from(fragment.querySelectorAll("style"))) {
    // No imports (the CSP blocks them too) and no remote backgrounds until images are shown.
    node.textContent = scrubCss((node.textContent ?? "").replace(/@import[^;]+;?/gi, ""));
  }
  // Links: never followed in the frame (the viewer opens them), never named targets.
  for (const anchor of Array.from(fragment.querySelectorAll("a"))) {
    anchor.removeAttribute("target");
    anchor.setAttribute("rel", "noreferrer noopener");
  }

  let quoted = false;
  const start = fragment.querySelector(QUOTE_START);
  if (start) {
    quoted = true;
    let node: Element | null = start;
    // An Outlook reply has a rule just before the header block: fold it too.
    const before = start.previousElementSibling;
    if (before && before.tagName === "HR") before.classList.add("omr-q");
    while (node) {
      node.classList.add("omr-q");
      node = node.nextElementSibling;
    }
  }

  const holder = fragment.ownerDocument.createElement("div");
  holder.appendChild(fragment);
  const html = holder.innerHTML;
  const styled = /\sbgcolor=|background(?:-color)?\s*:\s*(?!transparent|none|inherit|initial)[^;"']+|(?:^|[\s;"'])color\s*:\s*(?!inherit|initial)/i.test(html);
  return { html, remoteImages, cids: [...cids], quoted, styled };
}

export type FrameTheme = { dark: boolean; paper: boolean };
/** The frame's document: the CSP, base type and the folding rule around the cleaned HTML. */
export function mailSrcdoc(html: string, options: { showImages?: boolean; theme: FrameTheme }): string {
  const images = options.showImages ? "data: blob: https:" : "data: blob:";
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${images}; font-src data:; media-src 'none'; form-action 'none'`;
  const light = !options.theme.dark || options.theme.paper;
  const fg = light ? "#1f2328" : "#e8e8ea";
  const muted = light ? "#59636e" : "#a1a1aa";
  const link = light ? "#0b57d0" : "#8ab4f8";
  const rule = light ? "#d1d9e0" : "#3f3f46";
  const bg = options.theme.paper ? "#ffffff" : "transparent";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="${light ? "light" : "dark"}"><style>`
    + `html,body{margin:0;padding:0;background:${bg};}`
    + `body{color:${fg};font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;overflow-wrap:anywhere;word-break:break-word;-webkit-font-smoothing:antialiased;}`
    + `body>*:first-child{margin-top:0}body>*:last-child{margin-bottom:0}`
    + `a{color:${link};}img{max-width:100%;height:auto;}table{max-width:100%;}pre{white-space:pre-wrap;}`
    + `blockquote{margin:0 0 0 2px;padding-left:12px;border-left:2px solid ${rule};color:${muted};}`
    + `.omr-q{display:none !important;}body.omr-show .omr-q{display:revert !important;}`
    + `</style></head><body>${html}</body></html>`;
}

// ── plain text mail ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A plain text body split into what is new and the quoted history ("On ... wrote:" and the `>` lines after it). */
export function splitPlainQuote(text: string): { body: string; quote: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cut = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const intro = /^On .{4,200}wrote:\s*$/.test(line) || /^-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}/i.test(line) || /^From: .+$/.test(line) && /^(?:Sent|Date): /.test(lines[i + 1] ?? "");
    if (intro || (/^>/.test(line) && lines.slice(i).every((rest) => /^>/.test(rest) || !rest.trim()))) {
      cut = i;
      break;
    }
  }
  if (cut <= 0) return { body: text, quote: "" };
  return { body: lines.slice(0, cut).join("\n").trimEnd(), quote: lines.slice(cut).join("\n") };
}

const LINK = /\b(?:https?:\/\/|mailto:)[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
/** Text and links of a plain body, for rendering as nodes (never as HTML). */
export function linkParts(text: string): { text: string; href?: string }[] {
  const out: { text: string; href?: string }[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: match[0], href: match[0] });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Only these open from a record: the web and mail. */
export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const value = href.trim();
  if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) return value;
  return null;
}
