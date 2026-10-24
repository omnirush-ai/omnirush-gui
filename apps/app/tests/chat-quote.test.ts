import { describe, expect, test } from "bun:test";

import { quoteLabel, quoteText, unquoteBlock } from "../src/components/chat/quote";

describe("quote / reply", () => {
  test("every line is quoted, blank lines kept, surrounding blank lines dropped", () => {
    expect(quoteText("\nfirst\n\n  second\n\n")).toBe("> first\n>\n>   second");
  });

  test("a quote block reads back without its markers; other text is not a quote", () => {
    expect(unquoteBlock(quoteText("a\n\nb"))).toBe("a\n\nb");
    expect(unquoteBlock("> a\nnot quoted")).toBeNull();
  });

  test("the label is short and on one line", () => {
    expect(quoteLabel("short\ntext")).toBe("Quote: short text");
    expect(quoteLabel("x".repeat(100))).toBe(`Quote: ${"x".repeat(48)}…`);
    expect(quoteLabel("## Project overview\nThe project has **one** entry point, `src/main.js`.")).toBe(`Quote: ${"Project overview The project has one entry point, src/main.js.".slice(0, 48).trimEnd()}…`);
    expect(quoteLabel("> quoted\n- item [link](http://x)")).toBe("Quote: quoted item link");
  });
});
