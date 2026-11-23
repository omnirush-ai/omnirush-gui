// The Work replies block (design 3.5, judge M4): parsed only at the end, hidden everywhere, never flickering in while it
// streams, and the transcript transform keeps every unchanged message's object.
import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { cleanReply, createRepliesDisplay, hideRepliesBlock, lastAnswerReplies, splitReplies } from "../src/react-app/domains/work/ask/replies";

const draft = "Here is the draft to Dana:\n\n> Hi Dana, thanks for the quick reply. The new rate starts on 1 December.\n\nShall I send it?";
const block = "<replies>\nSend it\nMake it shorter\nMore formal\n</replies>";

const assistant = (id: string, text: string, extra: UIMessage["parts"] = []): UIMessage => ({
  id,
  role: "assistant",
  metadata: { opencode: { created: 1_000, completed: 2_000 } },
  parts: [...extra, { type: "text", text, state: "done" }],
});
const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

describe("splitReplies", () => {
  test("a block at the end: hidden, its lines become the replies", () => {
    expect(splitReplies(`${draft}\n${block}`)).toEqual({ body: draft, replies: ["Send it", "Make it shorter", "More formal"] });
    expect(splitReplies(`${draft}\n\n${block}\n\n`)).toEqual({ body: draft, replies: ["Send it", "Make it shorter", "More formal"] });
  });

  test("no block: the text as it is, no replies", () => {
    expect(splitReplies(draft)).toEqual({ body: draft, replies: [] });
    expect(splitReplies("a < b and c > d")).toEqual({ body: "a < b and c > d", replies: [] });
  });

  test("bullets, numbers and quotes are stripped; ending punctuation goes; caps, links and duplicates are dropped", () => {
    const text = [
      "Pick one.",
      "<replies>",
      "- Book Tue 3 pm.",
      "2) \"Book Wed 10 am\"",
      "* book tue 3 pm",
      "See https://cal.example/slot",
      "This line is far too long to be a reply anyone would tap on as a chip in the app",
      "",
      "“Ask Maria first”",
      "Fourth one",
      "</replies>",
    ].join("\n");
    expect(splitReplies(text)).toEqual({ body: "Pick one.", replies: ["Book Tue 3 pm", "Book Wed 10 am", "Ask Maria first"] });
    expect(cleanReply("  •  Send it!  ")).toBe("Send it");
    expect(cleanReply("Can you shorten it?")).toBe("Can you shorten it?");
    expect(cleanReply("www.example.com")).toBeNull();
    expect(cleanReply("<b>Send</b>")).toBeNull();
    expect(cleanReply("   ")).toBeNull();
  });

  test("a block that is not at the end is hidden but gives no replies", () => {
    const text = `Before\n${block}\nAfter the block.`;
    expect(splitReplies(text)).toEqual({ body: "Before\nAfter the block.", replies: [] });
  });

  test("only the last block counts; an earlier one is hidden too", () => {
    const text = `One\n<replies>\nOld\n</replies>\nTwo\n<replies>\nNew\n</replies>`;
    expect(splitReplies(text)).toEqual({ body: "One\nTwo", replies: ["New"] });
  });

  test("tags on the same line, a missing closing tag, upper case", () => {
    expect(splitReplies("Shall I send it? <replies>Send it\nNot yet</replies>")).toEqual({ body: "Shall I send it?", replies: ["Send it", "Not yet"] });
    expect(splitReplies("Shall I send it?\n<REPLIES>\nSend it\nNot yet")).toEqual({ body: "Shall I send it?", replies: ["Send it", "Not yet"] });
  });

  test("an empty block gives no replies", () => {
    expect(splitReplies("Done.\n<replies>\n</replies>")).toEqual({ body: "Done.", replies: [] });
    expect(splitReplies("Done.\n<replies>\n- \n\n</replies>")).toEqual({ body: "Done.", replies: [] });
  });

  test("code fences and inline code are text: never a block", () => {
    const fenced = "Use this form:\n```\n<replies>\nSend it\n</replies>\n```";
    expect(splitReplies(fenced)).toEqual({ body: fenced, replies: [] });
    const inline = "Write `<replies>` then a line each.";
    expect(splitReplies(inline)).toEqual({ body: inline, replies: [] });
    // A real block after a fence still counts.
    expect(splitReplies(`${fenced}\n<replies>\nLooks good\n</replies>`)).toEqual({ body: fenced, replies: ["Looks good"] });
  });

  test("Chinese replies", () => {
    expect(splitReplies("草稿如下。要发送吗？\n<replies>\n发送\n写短一点。\n更正式一些\n</replies>")).toEqual({ body: "草稿如下。要发送吗？", replies: ["发送", "写短一点", "更正式一些"] });
  });

  test("while streaming: a block coming in is hidden from its tag, and so is a tag still being typed", () => {
    for (const partial of ["<", "<r", "<re", "<repl", "<replies", "<replies>", "<replies>\nSen", "<replies>\nSend it\n</rep"]) {
      expect(splitReplies(`${draft}\n${partial}`, { streaming: true }).body).toBe(draft);
    }
    // On the same line as the text.
    expect(splitReplies("Shall I send it? <rep", { streaming: true }).body).toBe("Shall I send it?");
    // Not a tag: kept once more text shows it is something else, and never hidden once the message is done.
    expect(splitReplies("x <b", { streaming: true }).body).toBe("x <b");
    expect(splitReplies(`${draft}\n<re`).body).toBe(`${draft}\n<re`);
  });
});

describe("the transcript transform", () => {
  test("strips every assistant text part; user text and the message object stay when nothing changes", () => {
    const plain = assistant("a1", "No block here.");
    expect(hideRepliesBlock(plain)).toBe(plain);
    const asked = user("u1", `Quote: ${block}`);
    expect(hideRepliesBlock(asked)).toBe(asked);
    const reply = assistant("a2", `${draft}\n${block}`);
    const shown = hideRepliesBlock(reply);
    expect(shown).not.toBe(reply);
    expect(shown.parts.at(-1)).toMatchObject({ type: "text", text: draft });
    expect(shown.metadata).toBe(reply.metadata);
  });

  test("memoized per message: one streamed token gives a new object for the last message only", () => {
    const display = createRepliesDisplay();
    const first = assistant("a1", `${draft}\n${block}`);
    const question = user("u2", "Make it shorter");
    const streaming1 = assistant("a2", "Here is a shorter one:\n> Hi Dana, the new rate starts 1 Dec.\n<rep");
    const out1 = display([user("u1", "Draft a reply"), first, question, streaming1], true);
    expect(out1[3]!.parts.at(-1)).toMatchObject({ text: "Here is a shorter one:\n> Hi Dana, the new rate starts 1 Dec." });
    // The next token: a new object for the streaming message only (as the sync layer delivers it).
    const streaming2 = { ...streaming1, parts: [{ type: "text" as const, text: `${(streaming1.parts[0] as { text: string }).text}lies>\nSend` }] };
    const inputs = [out1, display([user("u1", "Draft a reply"), first, question, streaming2], true)];
    expect(inputs[1]![1]).toBe(inputs[0]![1]);
    expect(inputs[1]![3]).not.toBe(inputs[0]![3]);
    expect(inputs[1]![3]!.parts.at(-1)).toMatchObject({ text: "Here is a shorter one:\n> Hi Dana, the new rate starts 1 Dec." });
    // Same list again: every object kept.
    const again = display([user("u1", "Draft a reply"), first, question, streaming2], true);
    again.forEach((message, index) => { if (message.role === "assistant") expect(message).toBe(inputs[1]![index]!); });
  });
});

describe("lastAnswerReplies", () => {
  test("from the newest answer's last text part only", () => {
    expect(lastAnswerReplies([user("u1", "x"), assistant("a1", `${draft}\n${block}`)])).toEqual(["Send it", "Make it shorter", "More formal"]);
    // An earlier turn's replies never show.
    expect(lastAnswerReplies([assistant("a1", `${draft}\n${block}`), user("u2", "Send it")])).toEqual([]);
    expect(lastAnswerReplies([])).toEqual([]);
  });

  test("none when a tool call follows the block (the turn went on)", () => {
    const message: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: `${draft}\n${block}` },
        { type: "dynamic-tool", toolName: "omnirush-work_gmail_send", toolCallId: "c1", state: "input-available", input: {} },
      ],
    };
    expect(lastAnswerReplies([message])).toEqual([]);
  });
});
