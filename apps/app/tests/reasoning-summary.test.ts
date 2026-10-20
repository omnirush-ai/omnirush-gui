import { describe, expect, test } from "bun:test";

import { latestReasoningHeading, reasoningIsShown, reasoningSummaryParts } from "../src/components/chat/reasoning-block";

describe("reasoning summary parts", () => {
  test("splits whole-line bold headings from the prose", () => {
    expect(reasoningSummaryParts("**Planning the fix**\n\nThe key misses the tenant id.")).toEqual({
      headings: ["Planning the fix"],
      body: "The key misses the tenant id.",
    });
  });

  test("heading-only summaries (the Codex backend's, some with an empty placeholder) have no body", () => {
    expect(reasoningSummaryParts("**Deriving perfect squares concisely**")).toEqual({ headings: ["Deriving perfect squares concisely"], body: "" });
    expect(reasoningSummaryParts("**Title Goes Here** <!-- -->")).toEqual({ headings: ["Title Goes Here"], body: "" });
    expect(reasoningSummaryParts("**First step**\n**Second step**\n<!-- -->\n")).toEqual({ headings: ["First step", "Second step"], body: "" });
  });

  test("bold words inside prose are prose, not headings", () => {
    expect(reasoningSummaryParts("Check **only** the cache.").body).toBe("Check **only** the cache.");
  });

  test("only reasoning with prose is shown", () => {
    expect(reasoningIsShown("**Planning**")).toBe(false);
    expect(reasoningIsShown("plain thought")).toBe(true);
    expect(reasoningIsShown("")).toBe(false);
  });

  test("the live heading is the run's latest one, never one from before the last user message", () => {
    const reasoning = (text: string) => ({ type: "reasoning", text });
    expect(latestReasoningHeading([
      { role: "user", parts: [{ type: "text", text: "go" }] },
      { role: "assistant", parts: [reasoning("**Reading the test**"), { type: "text", text: "note" }] },
      { role: "assistant", parts: [reasoning("**Tracing the key**\n**Checking the cache**"), { type: "dynamic-tool" }] },
    ])).toBe("Checking the cache");
    expect(latestReasoningHeading([
      { role: "assistant", parts: [reasoning("**Old turn**")] },
      { role: "user", parts: [{ type: "text", text: "next" }] },
      { role: "assistant", parts: [reasoning("plain prose only")] },
    ])).toBeNull();
  });
});
