/** @jsxImportSource react */
// Record viewers (enterprise design 2.5, judge M18 to M20): the mail sanitizer against a known XSS corpus, the frame and
// its CSP, the composer's HTML/Markdown/text, each action's body, undo send, how items open (old server, tabs), the Work
// chat source chips, and every view rendered from a fixture shaped like GET /work/records/detail.
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";

// No page, script or style loads from parsed mail in the test DOM (a real frame's CSP blocks them).
GlobalRegistrator.register({ url: "http://localhost/", settings: { disableIframePageLoading: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true } as never });
afterAll(async () => { await GlobalRegistrator.unregister(); });

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { renderToStaticMarkup } = await import("react-dom/server");
const html = await import("../src/react-app/domains/work/viewer/mail-html");
const records = await import("../src/react-app/domains/work/viewer/records");
const format = await import("../src/react-app/domains/work/viewer/composer-format");
const { COMPOSER_NODES } = await import("../src/react-app/domains/work/viewer/composer");
const { RecordView } = await import("../src/react-app/domains/work/viewer/record-view");
const { ActionArea } = await import("../src/react-app/domains/work/viewer/record-actions");
const { MailFrame } = await import("../src/react-app/domains/work/viewer/html-frame");
const { recordsInOutput, isWorkTool } = await import("../src/react-app/domains/work/viewer/source-chips");
const { openRecordTab, recordTab } = await import("../src/react-app/domains/work/viewer/record-tabs");
const { sendFailure } = await import("../src/react-app/domains/work/viewer/record-panel");
const { groupChat } = await import("../src/react-app/domains/work/viewer/chat-view");
const { guestSummary, localInstant } = await import("../src/react-app/domains/work/viewer/event-view");
const { meetingBody, nextSlot } = await import("../src/react-app/domains/work/viewer/meeting-composer");
const { money } = await import("../src/react-app/domains/work/viewer/finance-view");
const { usePanelTabStore } = await import("../src/react-app/domains/session/panel/panel-tab-store");
const lexical = await import("lexical");
const { $createListItemNode, $createListNode } = await import("@lexical/list");
const { $createLinkNode } = await import("@lexical/link");

type WorkRecord = import("../src/react-app/domains/work/viewer/records").WorkRecord;

const wrap = (node: React.ReactNode) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const noop = () => {};

// ── the mail sanitizer (judge M18) ─────────────────────────────────────────────────────────────────────────────────

const XSS = [
  `<script>alert(1)</script><p>hi</p>`,
  `<img src=x onerror="alert(1)">`,
  `<svg onload="alert(1)"><circle r="1"/></svg>`,
  `<a href="javascript:alert(1)">click</a>`,
  `<a href="JaVaScRiPt:alert(1)">click</a>`,
  `<iframe src="https://evil.test"></iframe>`,
  `<object data="https://evil.test/x.swf"></object><embed src="https://evil.test/x.swf">`,
  `<form action="https://evil.test"><input name="password"><button formaction="https://evil.test">Go</button><textarea></textarea><select><option>1</option></select></form>`,
  `<base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test"><link rel="stylesheet" href="https://evil.test/x.css">`,
  `<div onclick="alert(1)" onmouseover="alert(2)">x</div>`,
  `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>`,
  `<details open ontoggle="alert(1)">x</details>`,
  `<body onload="alert(1)"><p>x</p></body>`,
  `<a href="https://ok.test" target="_top" ping="https://evil.test/p">ok</a>`,
  `<img srcset="https://evil.test/a.png 1x">`,
  `<style>@import url("https://evil.test/a.css"); .x{background:url(https://evil.test/b.png)}</style><p class="x">s</p>`,
];

describe("mail HTML (judge M18)", () => {
  test("a known XSS corpus leaves no script, handler, form, frame, embed, base, meta, link or javascript: link", () => {
    // The pass after DOMPurify holds on its own too (any DOM, any parser quirk).
    const holder = document.createElement("div");
    holder.innerHTML = `<iframe></iframe><a href=" java\tscript:alert(1)" onclick="x">a</a><img src="data:text/html,x"><img src="data:image/png;base64,AAAA">`;
    html.scrubMail(holder);
    expect(holder.innerHTML).toBe(`<a>a</a><img><img src="data:image/png;base64,AAAA">`);
    for (const sample of XSS) {
      const clean = html.sanitizeMailHtml(sample).html.toLowerCase();
      expect(clean).not.toContain("<script");
      expect(clean).not.toMatch(/\son[a-z]+=/);
      expect(clean).not.toContain("javascript:");
      for (const tag of ["form", "input", "button", "textarea", "select", "iframe", "object", "embed", "base", "meta", "link"]) expect(clean).not.toContain(`<${tag}`);
      expect(clean).not.toContain("formaction");
      expect(clean).not.toContain("srcset");
      expect(clean).not.toContain("ping=");
      expect(clean).not.toContain("target=");
      expect(clean).not.toContain("@import");
    }
  });

  test("remote images are held back until shown; cid: images point at the message's own files", () => {
    const raw = `<p>Hi</p><img src="https://track.test/p.gif" width="1"><img src="//cdn.test/logo.png"><img src="cid:logo@x"><table background="https://bg.test/a.png"><tr><td style="background-image:url('https://bg.test/b.png')">x</td></tr></table>`;
    const hidden = html.sanitizeMailHtml(raw);
    expect(hidden.remoteImages).toBe(4);
    expect(hidden.html).not.toMatch(/\ssrc="https:\/\/track/);
    expect(hidden.html).toContain(`data-omr-src="https://track.test/p.gif"`);
    expect(hidden.html).not.toContain("bg.test");
    expect(hidden.cids).toEqual(["logo@x"]);
    expect(hidden.html).toContain(html.BLANK_IMAGE);
    const shown = html.sanitizeMailHtml(raw, { showImages: true, cidUrls: { "logo@x": "blob:http://localhost/1" } });
    expect(shown.html).toContain(`src="https://track.test/p.gif"`);
    expect(shown.html).toContain(`src="https://cdn.test/logo.png"`);
    expect(shown.html).toContain(`src="blob:http://localhost/1"`);
  });

  test("the frame's CSP allows no script or network but data:/blob: images (https: once shown)", () => {
    const doc = html.mailSrcdoc("<p>x</p>", { theme: { dark: false, paper: false } });
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("style-src 'unsafe-inline'");
    expect(doc).toContain("img-src data: blob:;");
    expect(doc).not.toContain("script-src");
    expect(html.mailSrcdoc("<p>x</p>", { showImages: true, theme: { dark: true, paper: true } })).toContain("img-src data: blob: https:;");
    // The frame is same-origin only (sized and its links caught by the app), never with scripts.
    const markup = wrap(<MailFrame html="<p>Hello</p>" sourceId="gmail:1" files={[]} client={null} title="Message" showImages={false} onOpenLink={noop} />);
    expect(markup).toContain(`sandbox="allow-same-origin"`);
    expect(markup).not.toContain("allow-scripts");
  });

  test("the quoted history is marked to fold, and a mail that paints its own colours goes on a light page", () => {
    const gmail = html.sanitizeMailHtml(`<div>New text</div><div class="gmail_quote">On Mon, Ana wrote:<blockquote>old</blockquote></div>`);
    expect(gmail.quoted).toBe(true);
    expect(gmail.html).toContain(`class="gmail_quote omr-q"`);
    const outlook = html.sanitizeMailHtml(`<p>Thanks</p><hr><div id="divRplyFwdMsg">From: Ana</div><div>old body</div>`);
    expect((outlook.html.match(/omr-q/g) ?? []).length).toBe(3);
    expect(html.sanitizeMailHtml(`<p>plain</p>`).styled).toBe(false);
    expect(html.sanitizeMailHtml(`<table bgcolor="#f4f4f4"><tr><td>news</td></tr></table>`).styled).toBe(true);
  });

  test("plain bodies: the quote splits off, links are parts, only http(s) and mailto open", () => {
    const split = html.splitPlainQuote("Sounds good.\n\nOn Mon, Nov 24, 2026 at 10:02 Ana <ana@acme.test> wrote:\n> are we on?\n> thanks");
    expect(split.body).toBe("Sounds good.");
    expect(split.quote).toContain("> are we on?");
    expect(html.linkParts("See https://acme.test/a. Thanks").map((p) => p.href ?? null)).toEqual([null, "https://acme.test/a", null]);
    expect(html.safeHref("javascript:alert(1)")).toBeNull();
    expect(html.safeHref("mailto:ana@acme.test")).toBe("mailto:ana@acme.test");
    expect(html.safeHref("file:///etc/passwd")).toBeNull();
  });
});

// ── the composer (judge M19) ──────────────────────────────────────────────────────────────────────────────────────

describe("composer content (judge M19)", () => {
  const write = (build: () => void) => {
    const editor = lexical.createEditor({ nodes: COMPOSER_NODES, onError: (error) => { throw error; } });
    editor.update(build, { discrete: true });
    return editor.getEditorState().read(() => format.serializeRoot(lexical.$getRoot()));
  };

  test("bold, italic, links and lists become HTML, Markdown and plain text, with no Markdown marks in the text", () => {
    const out = write(() => {
      const root = lexical.$getRoot();
      root.clear();
      const p = lexical.$createParagraphNode();
      p.append(lexical.$createTextNode("Thanks, "), lexical.$createTextNode("44 works").toggleFormat("bold"), lexical.$createTextNode(" for "), lexical.$createTextNode("Tuesday").toggleFormat("italic"));
      const link = $createLinkNode("https://acme.test/slots");
      link.append(lexical.$createTextNode("the sheet"));
      const p2 = lexical.$createParagraphNode().append(lexical.$createTextNode("See "), link);
      const list = $createListNode("bullet");
      list.append($createListItemNode().append(lexical.$createTextNode("Dock 4")), $createListItemNode().append(lexical.$createTextNode("Dock 5")));
      const numbered = $createListNode("number");
      numbered.append($createListItemNode().append(lexical.$createTextNode("Book")), $createListItemNode().append(lexical.$createTextNode("Confirm")));
      root.append(p, p2, list, numbered);
    });
    expect(out.html).toBe(`<div>Thanks, <strong>44 works</strong> for <em>Tuesday</em></div><div>See <a href="https://acme.test/slots">the sheet</a></div><ul><li>Dock 4</li><li>Dock 5</li></ul><ol><li>Book</li><li>Confirm</li></ol>`);
    expect(out.markdown).toBe("Thanks, **44 works** for _Tuesday_\nSee [the sheet](https://acme.test/slots)\n\n- Dock 4\n- Dock 5\n1. Book\n2. Confirm");
    expect(out.text).toBe("Thanks, 44 works for Tuesday\nSee the sheet (https://acme.test/slots)\n\n- Dock 4\n- Dock 5\n1. Book\n2. Confirm");
  });

  test("HTML is escaped, a bad link scheme is plain text, an empty composer is empty", () => {
    const out = write(() => {
      const root = lexical.$getRoot();
      root.clear();
      const link = $createLinkNode("javascript:alert(1)");
      link.append(lexical.$createTextNode("x"));
      root.append(lexical.$createParagraphNode().append(lexical.$createTextNode("<b>1 & 2</b> "), link));
    });
    expect(out.html).toBe("<div>&lt;b&gt;1 &amp; 2&lt;/b&gt; x</div>");
    expect(out.markdown).toBe("<b>1 & 2</b> x");
    const empty = write(() => { lexical.$getRoot().clear(); lexical.$getRoot().append(lexical.$createParagraphNode(), lexical.$createParagraphNode()); });
    expect(empty).toEqual({ html: "", markdown: "", text: "" });
  });
});

// ── what each action sends ────────────────────────────────────────────────────────────────────────────────────────

describe("action bodies (design 3.10)", () => {
  const content = { html: "<div><strong>Yes</strong></div>", markdown: "**Yes**", text: "Yes" };
  test("mail: reply with HTML and text, forward with its subject and the files picked, a draft says its mode", () => {
    expect(records.actionArgs({ action: "reply_all", source: "google", content, mail: { to: ["maria@cold.test"], cc: ["ops@acme.test"], message: "gmail:2" } }))
      .toEqual({ body: "Yes", html: "<div><strong>Yes</strong></div>", to: ["maria@cold.test"], cc: ["ops@acme.test"], message: "gmail:2" });
    expect(records.actionArgs({ action: "forward", source: "google", content, mail: { to: ["fin@acme.test"], subject: "Fwd: Rates", attachments: [0, 2] } }))
      .toEqual({ body: "Yes", html: "<div><strong>Yes</strong></div>", to: ["fin@acme.test"], subject: "Fwd: Rates", attachments: [0, 2] });
    expect(records.actionArgs({ action: "draft", source: "microsoft", content, mail: { to: ["a@b.test"] } }).mode).toBe("reply");
  });
  test("comments send Markdown where the provider reads it (GitHub, Slack), text and HTML elsewhere (Jira, Teams)", () => {
    expect(records.actionArgs({ action: "comment", source: "github", content })).toEqual({ body: "Yes", markdown: "**Yes**", html: "<div><strong>Yes</strong></div>" });
    expect(records.actionArgs({ action: "reply", source: "slack", content }).markdown).toBe("**Yes**");
    expect(records.actionArgs({ action: "comment", source: "jira", content }).markdown).toBeUndefined();
    expect(records.actionArgs({ action: "reply", source: "microsoft", content }).html).toBe("<div><strong>Yes</strong></div>");
  });
  test("events, tasks and stages: their own fields only", () => {
    expect(records.actionArgs({ action: "rsvp", source: "google", response: "maybe", comment: " late " })).toEqual({ response: "maybe", comment: "late" });
    expect(records.actionArgs({ action: "reschedule", source: "google", start: "2026-11-27T09:00:00.000Z", end: "2026-11-27T10:00:00.000Z", timezone: "Asia/Kolkata", video: "meet" }))
      .toEqual({ start: "2026-11-27T09:00:00.000Z", end: "2026-11-27T10:00:00.000Z", timezone: "Asia/Kolkata", video: "meet" });
    expect(records.actionArgs({ action: "cancel", source: "google" })).toEqual({ notify: true });
    expect(records.actionArgs({ action: "task", source: "hubspot", subject: " Call Maria ", due: "2026-11-30", content: { html: "", markdown: "", text: "about slots" } })).toEqual({ subject: "Call Maria", body: "about slots", due: "2026-11-30" });
    expect(records.actionArgs({ action: "stage", source: "hubspot", stage: "contractsent" })).toEqual({ stage: "contractsent" });
  });
  test("reply goes to the sender (or their Reply-To), reply all adds everyone but you, your own mail answers its recipients", () => {
    const me = { email: "ana@acme.test", me: true };
    const m = (from: object, to: object[], cc: object[] = [], reply_to?: object[]) => ({ source_id: "gmail:1", from, to, cc, reply_to, body: { format: "text", content: "" }, attachments: [] }) as never;
    expect(records.defaultRecipients("reply", m({ email: "maria@cold.test" }, [me, { email: "ben@acme.test" }]))).toEqual({ to: ["maria@cold.test"], cc: [] });
    expect(records.defaultRecipients("reply_all", m({ email: "maria@cold.test" }, [me, { email: "ben@acme.test" }], [{ email: "ops@acme.test" }, me]))).toEqual({ to: ["maria@cold.test", "ben@acme.test"], cc: ["ops@acme.test"] });
    expect(records.defaultRecipients("reply", m({ email: "maria@cold.test" }, [me], [], [{ email: "desk@cold.test" }]))).toEqual({ to: ["desk@cold.test"], cc: [] });
    expect(records.defaultRecipients("reply", m(me, [{ email: "maria@cold.test" }]))).toEqual({ to: ["maria@cold.test"], cc: [] });
    expect(records.defaultRecipients("forward", m({ email: "maria@cold.test" }, [me]))).toEqual({ to: [], cc: [] });
    expect(records.parseAddresses("Ana <ANA@acme.test>, ben@acme.test; nope, ben@acme.test")).toEqual(["ana@acme.test", "ben@acme.test"]);
  });
  test("a client action id fits the server's rule", () => {
    expect(records.clientActionId()).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
  });
  test("a refusal reads in words with its fix", () => {
    const err = (code: string, details?: object) => Object.assign(new Error("x"), { status: 403, code, details });
    expect(sendFailure(err("needs_install", { reason: "OmniRush isn't installed on acme in GitHub. Ask an owner of acme to install it.", setup_url: "https://github.com/apps/x/installations/new" }), "github"))
      .toEqual({ text: "OmniRush isn't installed on acme in GitHub. Ask an owner of acme to install it.", fix: "setup", url: "https://github.com/apps/x/installations/new" });
    expect(sendFailure(err("writes_paused"), "google").fix).toBe("settings");
    expect(sendFailure(err("reconnect_required"), "google").fix).toBe("reconnect");
    expect(sendFailure(err("rate_limited", { retry_after: 12 }), "google").text).toContain("12 s");
    expect(sendFailure(err("bad_arguments", { field: "to" }), "google").text).toBe("Check who it goes to.");
  });
});

// ── undo send ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("undo send (judge decision 10)", () => {
  test("5 s by default; a held send runs after its window, Undo drops it and calls back, 0 sends at once", async () => {
    expect(records.useUndoSendStore.getState().delay).toBe(5);
    const ran: string[] = [];
    const undone: string[] = [];
    records.holdSend({ sourceId: "gmail:1", label: "reply", delayMs: 30, run: () => ran.push("a"), onUndo: () => undone.push("a") });
    const b = records.holdSend({ sourceId: "gmail:1", label: "reply", delayMs: 30, run: () => ran.push("b"), onUndo: () => undone.push("b") });
    expect(records.isHeld("gmail:1")).toBe(true);
    expect(records.replaceable("gmail:1")).toBe(false);
    records.cancelHeld(b);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ran).toEqual(["a"]);
    expect(undone).toEqual(["b"]);
    expect(records.isHeld("gmail:1")).toBe(false);
    records.holdSend({ sourceId: "gmail:2", label: "reply", delayMs: 0, run: () => ran.push("c") });
    expect(ran).toEqual(["a", "c"]);
  });
  test("Cmd/Ctrl+Z while a send waits drops the newest one", async () => {
    const ran: string[] = [];
    records.holdSend({ sourceId: "slack:C1:1", label: "message", delayMs: 40, run: () => ran.push("x") });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, metaKey: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(ran).toEqual([]);
  });
  test("a draft is kept until sent, and a record with one is not replaced by the next item opened", () => {
    records.useRecordDrafts.getState().save(records.draftKey("github:acme/app#7", "comment"), { action: "comment", text: "Half written" });
    expect(records.hasDraft("github:acme/app#7")).toBe(true);
    expect(records.replaceable("github:acme/app#7")).toBe(false);
    records.useRecordDrafts.getState().clear(records.draftKey("github:acme/app#7", "comment"));
    expect(records.replaceable("github:acme/app#7")).toBe(true);
  });
});

// ── opening items ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("opening items in the panel", () => {
  test("a row opens in the viewer; Cmd/Ctrl+Enter or an older server opens its link; no id and no link does nothing", () => {
    const opened: unknown[] = [];
    const links: string[] = [];
    const off = records.onOpenRecordRequest((request) => opened.push(request));
    try {
      records.useViewerSupport.setState({ support: "unknown" });
      records.openItem({ sourceId: "gmail:1", url: "https://mail.test/1", list: [{ sourceId: "gmail:1" }, { sourceId: "gmail:2" }] }, (u) => links.push(u));
      expect(opened).toHaveLength(1);
      records.openItem({ sourceId: "gmail:1", url: "https://mail.test/1" }, (u) => links.push(u), { external: true });
      expect(links).toEqual(["https://mail.test/1"]);
      records.useViewerSupport.setState({ support: "no" });
      records.openItem({ sourceId: "gmail:3", url: "https://mail.test/3" }, (u) => links.push(u));
      expect(links).toEqual(["https://mail.test/1", "https://mail.test/3"]);
      expect(opened).toHaveLength(1);
      expect(records.canOpen({})).toBe(false);
    } finally {
      off();
      records.useViewerSupport.setState({ support: "unknown" });
    }
    expect(records.openModifiers({ metaKey: true }, true)).toEqual({ external: true, newTab: false });
    expect(records.openModifiers({ ctrlKey: true, shiftKey: true }, false)).toEqual({ external: true, newTab: true });
  });
  test("an older server is a missing route (404 with no Work code); unknown_record is the server's own answer", () => {
    expect(records.isMissingRoute({ status: 404, code: "Not Found" })).toBe(true);
    expect(records.isMissingRoute({ status: 404, code: "unknown_record" })).toBe(false);
    expect(records.isMissingRoute({ status: 403, code: "connector_off" })).toBe(false);
  });
  test("the next item replaces the record on screen unless it holds a draft; [ and ] step through its list", () => {
    const key = "panel-test";
    usePanelTabStore.getState().clearSession(key);
    const list = [{ sourceId: "gmail:1", title: "One" }, { sourceId: "gmail:2", title: "Two" }, { sourceId: "gmail:3", title: "Three" }];
    openRecordTab(key, { ...list[0]!, list });
    openRecordTab(key, list[1]!);
    let session = usePanelTabStore.getState().sessions[key]!;
    expect(session.tabs.map((tab) => tab.id)).toEqual(["record:gmail:2"]);
    expect(records.neighbour(records.recordList("record:gmail:2"), "gmail:2", 1)?.sourceId).toBe("gmail:3");
    records.useRecordDrafts.getState().save(records.draftKey("gmail:2", "reply"), { action: "reply", text: "Draft" });
    openRecordTab(key, list[2]!);
    session = usePanelTabStore.getState().sessions[key]!;
    expect(session.tabs.map((tab) => tab.id)).toEqual(["record:gmail:2", "record:gmail:3"]);
    openRecordTab(key, { ...list[0]!, newTab: true });
    expect(usePanelTabStore.getState().sessions[key]!.tabs).toHaveLength(3);
    expect(recordTab({ sourceId: "", compose: { kind: "meeting" } })).toMatchObject({ type: "record", label: "New meeting" });
    expect(recordTab({ sourceId: "", compose: { kind: "meeting" } }).id).toMatch(/^record:compose:meeting:/);
    records.useRecordDrafts.getState().clear(records.draftKey("gmail:2", "reply"));
    usePanelTabStore.getState().clearSession(key);
  });
  test("a Work chat's tool answer gives source chips (MCP text or structured content), at most 8, each once", () => {
    const mcp = { content: [{ type: "text", text: JSON.stringify({ hits: [{ source_id: "gmail:1", source: "google", kind: "email", subject: "Pallets" }, { source_id: "slack:C1:2", channel: "slack", text_preview: "Truck late" }, { source_id: "gmail:1", subject: "dup" }] }) }] };
    expect(recordsInOutput(mcp).map((r) => [r.sourceId, r.source, r.title])).toEqual([["gmail:1", "google", "Pallets"], ["slack:C1:2", "slack", "Truck late"]]);
    expect(recordsInOutput(JSON.stringify({ items: Array.from({ length: 12 }, (_, i) => ({ source_id: `jira:${i}`, subject: `T${i}` })) }))).toHaveLength(8);
    expect(recordsInOutput("plain text answer")).toEqual([]);
    expect(isWorkTool("omnirush-work_work_search")).toBe(true);
    expect(isWorkTool("bash")).toBe(false);
  });
});

// ── the views, from detail answers ───────────────────────────────────────────────────────────────────────────────

const base = { writes_paused: false, can_live: true, origin: "stored", links: [], fields: [], comments: [], attachments: [], actors: [] };
const MAIL: WorkRecord = {
  ...base, source_id: "gmail:m3", source: "google", channel: "gmail", kind: "email", view: "mail", subject: "Re: Pallet count for Dec", url: "https://mail.test/m3", occurred_at: "2026-11-23T08:40:00Z",
  people: [{ name: "Maria Ruiz", email: "maria@cold.test" }, { name: "Ben Okafor", email: "ben@acme.test" }, { email: "ana@acme.test", me: true }],
  thread: [
    { source_id: "gmail:m1", from: { name: "Maria Ruiz", email: "maria@cold.test" }, to: [{ email: "ana@acme.test", me: true }], cc: [], at: "2026-11-21T10:02:00Z", snippet: "We counted 44 pallets", body: { format: "text", content: "We counted 44 pallets." }, attachments: [] },
    { source_id: "gmail:m2", from: { name: "Ben Okafor", email: "ben@acme.test" }, to: [{ name: "Maria Ruiz", email: "maria@cold.test" }], cc: [], at: "2026-11-22T09:15:00Z", snippet: "Thanks Maria", body: { format: "text", content: "Thanks Maria" }, attachments: [] },
    { source_id: "gmail:m3", from: { name: "Maria Ruiz", email: "maria@cold.test" }, to: [{ email: "ana@acme.test", me: true }, { name: "Ben Okafor", email: "ben@acme.test" }], cc: [{ email: "ops@acme.test" }], at: "2026-11-23T08:40:00Z", unread: true, body: { format: "html", content: "<p>Final count <b>44</b>.</p><img src='https://track.test/p.gif'>" }, attachments: [{ n: 0, name: "Invoice-JF-0042.pdf", size: 217088, content_type: "application/pdf", available: true }] },
  ],
  actions: [{ id: "reply", label: "Reply" }, { id: "reply_all", label: "Reply all" }, { id: "forward", label: "Forward" }, { id: "draft", label: "Save draft" }],
} as unknown as WorkRecord;

describe("views (design 2.5)", () => {
  test("mail: older messages folded to a line, the newest open in its sandboxed frame with its files; Reply, Reply all, Forward", () => {
    const markup = wrap(<RecordView record={MAIL} onPreview={noop} />);
    expect(markup).toContain(`data-mail-folded="gmail:m1"`);
    expect(markup).toContain(`data-mail-message="gmail:m3"`);
    expect(markup).toContain(`sandbox="allow-same-origin"`);
    expect(markup).toContain("Invoice-JF-0042.pdf");
    expect(markup).toContain("212 KB");
    const bar = wrap(<ActionArea record={MAIL} mode={null} setMode={noop} send={async () => true} onSubmit={noop} onOpenSettings={noop} onOpenLink={noop} onReconnect={noop} />);
    for (const id of ["reply", "reply_all", "forward"]) expect(bar).toContain(`data-action="${id}"`);
  });

  test("a paused account, a GitHub repo without the App, and IMAP each say why, with the fix", () => {
    const paused = wrap(<ActionArea record={{ ...MAIL, writes_paused: true }} mode={null} setMode={noop} send={async () => true} onSubmit={noop} onOpenSettings={noop} onOpenLink={noop} onReconnect={noop} />);
    expect(paused).toContain("Actions are paused. Resume them in Work settings.");
    const github = { ...base, source_id: "github:openfreight/community#3", source: "github", kind: "issue", view: "issue", subject: "Reefer temps", ref: { repo: "openfreight/community", number: 3 },
      actions: [{ id: "comment", label: "Comment", disabled: "needs_install", reason: "OmniRush isn't installed on openfreight in GitHub. Ask an owner of openfreight to install it.", setup_url: "https://github.com/apps/x/installations/new" }] } as unknown as WorkRecord;
    const install = wrap(<ActionArea record={github} mode={null} setMode={noop} send={async () => true} onSubmit={noop} onOpenSettings={noop} onOpenLink={noop} onReconnect={noop} />);
    expect(install).toContain("OmniRush isn&#x27;t installed on openfreight in GitHub.");
    expect(install).toContain("Install on GitHub");
    const imap = { ...base, source_id: "imap:INBOX:42", source: "imap", kind: "email", view: "mail", subject: "Slots", actions: [], read_only: "Reply from your mail app.",
      thread: [{ source_id: "imap:INBOX:42", from: { name: "Maria", email: "maria@cold.test" }, to: [], cc: [], body: { format: "text", content: "Slots?" }, attachments: [] }] } as unknown as WorkRecord;
    const readOnly = wrap(<ActionArea record={imap} mode={null} setMode={noop} send={async () => true} onSubmit={noop} onOpenSettings={noop} onOpenLink={noop} onReconnect={noop} />);
    expect(readOnly).toContain("Reply from your mail app.");
    expect(readOnly).toContain("Copy address");
  });

  test("chat: grouped by day and author, the opened message marked", () => {
    const record = { ...base, source_id: "slack:C1:1700000060.000200", source: "slack", kind: "message", view: "chat", where: "#ops-dock", subject: "#ops-dock",
      thread: [
        { source_id: "slack:C1:1700000000.000100", from: { name: "Ben Okafor", id: "U1" }, at: "2026-11-23T09:12:00Z", text: "Truck 4 is late, ETA 11:30", format: "markdown" },
        { source_id: "slack:C1:1700000060.000200", from: { name: "Ben Okafor", id: "U1" }, at: "2026-11-23T09:13:00Z", text: "**moving** the slot", format: "markdown" },
        { source_id: "slack:C1:1700000120.000300", from: { name: "Maria", id: "U2" }, at: "2026-11-23T09:14:00Z", text: "ok", format: "markdown" },
      ], actions: [{ id: "reply" }, { id: "post" }] } as unknown as WorkRecord;
    const groups = groupChat(record.thread as never, new Date("2026-11-23T12:00:00Z"));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runs.map((run) => run.messages.length)).toEqual([2, 1]);
    const markup = wrap(<RecordView record={record} onPreview={noop} />);
    expect(markup).toContain(`data-opened="true"`);
    expect(markup).toContain("<strong>moving</strong>");
  });

  test("issue and pull request: reference, labels, branches and size, description and comments", () => {
    const record = { ...base, source_id: "github:acme/app#418", source: "github", kind: "pull_request", view: "issue", subject: "Sign-up says paused", ref: { repo: "acme/app", number: 418 },
      labels: ["support"], pull_request: { merged: false, head: { ref: "fix/signup" }, base: { ref: "main" }, changed_files: 3, additions: 40, deletions: 2 },
      body: { format: "markdown", content: "Steps:\n\n1. Open sign-up" }, comments: [{ author: { name: "kiran" }, at: "2026-11-22T10:00:00Z", body: { format: "markdown", content: "Looks **good**" } }],
      actions: [{ id: "comment" }] } as unknown as WorkRecord;
    const markup = wrap(<RecordView record={record} onPreview={noop} />);
    expect(markup).toContain("fix/signup");
    expect(markup).toContain("3 files changed");
    expect(markup).toContain(">support<");
    expect(markup).toContain("<strong>good</strong>");
  });

  test("event: when, Join for Meet, guests and their answers; a guest answers Yes, Maybe or No", () => {
    const record = { ...base, source_id: "calendar:e1", source: "google", channel: "calendar", kind: "event", view: "event", subject: "Product review",
      event: { start: "2026-11-24T09:51:00Z", end: "2026-11-24T10:21:00Z", join: { provider: "meet", url: "https://meet.google.com/abc-defg-hij" }, organizer: { name: "Danish", email: "d@acme.test" }, is_organizer: false, my_response: "none",
        attendees: [{ name: "Ana", email: "ana@acme.test", response: "yes" }, { name: "Ben", email: "ben@acme.test", response: "yes" }, { name: "Cara", response: "maybe" }, { email: "maria@cold.test", response: "none" }],
        counts: { yes: 2, maybe: 1, no: 0, none: 1 } },
      actions: [{ id: "rsvp", label: "Respond" }] } as unknown as WorkRecord;
    expect(guestSummary(record.event!)).toBe("2 yes, 1 maybe, 1 no reply");
    const markup = wrap(<RecordView record={record} onPreview={noop} />);
    expect(markup).toContain("Join Google Meet");
    const actions = wrap(<ActionArea record={record} mode={null} setMode={noop} send={async () => true} onSubmit={noop} onOpenSettings={noop} onOpenLink={noop} onReconnect={noop} />);
    for (const answer of ["yes", "maybe", "no"]) expect(actions).toContain(`data-rsvp="${answer}"`);
    expect(actions).not.toContain("Reschedule");
    expect(localInstant("2026-11-25", "10:00")).toBe(new Date("2026-11-25T10:00:00").toISOString());
    expect(localInstant("2026-11-25", "10")).toBeNull();
  });

  test("ticket, CRM, finance, meeting and code views show their parts; an unknown view is never blank", () => {
    const ticket = wrap(<RecordView record={{ ...base, source_id: "zendesk:ticket:35", source: "zendesk", kind: "ticket", view: "ticket", requester: { name: "Maria Ruiz", email: "maria@cold.test" }, fields: [{ label: "Priority", value: "high" }], body: { format: "text", content: "Where is my truck?" }, comments: [{ author: { name: "Ben" }, body: { format: "text", content: "Checking" }, internal: true }] } as unknown as WorkRecord} onPreview={noop} />);
    expect(ticket).toContain("Where is my truck?");
    expect(ticket).toContain("Internal");
    const crm = wrap(<RecordView record={{ ...base, source_id: "hubspot:deal:301", source: "hubspot", kind: "deal", view: "crm", stage: "contractsent", fields: [{ label: "Amount", value: "24000" }] } as unknown as WorkRecord} onPreview={noop} />);
    expect(crm).toContain("24000");
    const finance = wrap(<RecordView record={{ ...base, source_id: "xero:invoice:1", source: "xero", kind: "invoice", view: "finance", finance: { number: "INV-9", amount: "1200", currency: "EUR", status: "AUTHORISED", lines: [{ description: "Pallets", amount: "1200" }] } } as unknown as WorkRecord} onPreview={noop} />);
    expect(finance).toContain("INV-9");
    expect(finance).toContain(money("1200", "EUR"));
    const meeting = wrap(<RecordView record={{ ...base, source_id: "meetings:1", source: "meetings", kind: "meeting", view: "meeting", meeting: { summary: "Agreed on **44**", segments: [{ start_ms: 724000, speaker: "Ana", text: "Let's lock it" }] } } as unknown as WorkRecord} onPreview={noop} />);
    expect(meeting).toContain("00:12:04");
    const code = wrap(<RecordView record={{ ...base, source_id: "github:commit:abc", source: "github", kind: "commit", view: "code", code: { sha: "abcdef1234567", message: "Fix totals", files: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 }] } } as unknown as WorkRecord} onPreview={noop} />);
    expect(code).toContain("src/a.ts");
    const generic = wrap(<RecordView record={{ ...base, source_id: "hook:1", source: "hook", kind: "row", view: "generic", body: { format: "text", content: "A row" } } as unknown as WorkRecord} onPreview={noop} />);
    expect(generic).toContain("A row");
  });

  test("a new meeting asks for Meet when there are guests; its body is what /work/compose takes", () => {
    const slot = nextSlot(new Date("2026-11-23T10:10:00"));
    expect(slot.start.getMinutes()).toBe(30);
    const body = meetingBody({ connector: "google", title: " Slots call ", date: "2026-11-26", start: "10:00", end: "10:30", attendees: ["maria@cold.test"], video: true, description: "" });
    expect(body).toMatchObject({ kind: "meeting", connector: "google", title: "Slots call", attendees: ["maria@cold.test"], video: "meet", send_invites: true });
    expect(meetingBody({ connector: "microsoft", title: "x", date: "2026-11-26", start: "10:00", end: "10:30", attendees: [], video: true, description: "" })?.video).toBe("teams");
    expect(meetingBody({ connector: "google", title: "x", date: "2026-11-26", start: "11:00", end: "10:30", attendees: [], video: false, description: "" })).toBeNull();
  });

  test("every view and the shortcut map have their words in English and Chinese", () => {
    const en = readFileSync(new URL("../src/i18n/locales/en.ts", import.meta.url), "utf8");
    const zh = readFileSync(new URL("../src/i18n/locales/zh.ts", import.meta.url), "utf8");
    const keys = [...en.matchAll(/"(work\.viewer\.[a-z0-9_]+)"/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(200);
    for (const key of keys) expect(zh).toContain(`"${key}"`);
    // Plain copy: no em or en dashes in the viewer's English.
    for (const line of en.split("\n").filter((l) => l.includes("\"work.viewer."))) expect(line).not.toMatch(/[–—]/);
  });

  test("the side panel has the record tab branch and the four layers reach the server", () => {
    const panel = readFileSync(new URL("../src/react-app/domains/session/panel/side-panel.tsx", import.meta.url), "utf8");
    expect(panel).toContain(`activeTab?.type === "record"`);
    const local = readFileSync(new URL("../../server/src/work/routes.ts", import.meta.url), "utf8");
    for (const path of ["/work/records/detail", "/work/records/attachment", "/work/records/action", "/work/compose"]) expect(local).toContain(`"${path}"`);
  });
});
