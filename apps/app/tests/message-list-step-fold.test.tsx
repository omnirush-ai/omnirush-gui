/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { MessageList } from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";

function bashPart(id: string): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: id,
    state: "output-available",
    input: { command: `echo ${id}`, description: "run" },
    output: "ok",
  };
}

function editPart(id: string, filePath: string): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "edit",
    toolCallId: id,
    state: "output-available",
    input: { filePath, oldString: "a", newString: "b" },
    output: "ok",
  };
}

/**
 * Other test files stub `globalThis.window` and can leak it into a shared
 * bun test worker. Static SSR rendering must not see a partial window stub
 * (components probe it for addEventListener), so hide it for the render.
 */
function withoutWindow<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (descriptor?.configurable) {
    Reflect.deleteProperty(globalThis, "window");
  }
  try {
    return run();
  } finally {
    if (descriptor?.configurable) {
      Object.defineProperty(globalThis, "window", descriptor);
    }
  }
}

function renderList(messages: UIMessage[], status: "ready" | "streaming" = "ready") {
  return withoutWindow(() => renderToStaticMarkup(
    <MessageListProvider
      workspaceId="ws"
      sessionId="session"
      showThinking={true}
      developerMode={false}
      displaySuggestions={false}
      providerConnectedCount={1}
      dispatchAction={() => {}}
      setPrompt={() => {}}
      onRevertToUserMessage={() => {}}
      onForkAtMessage={() => {}}
      onEditUserMessage={() => {}}
      onMcpReconnect={() => Promise.reject(new Error("unused"))}
      onMcpReopenAuthorization={() => Promise.resolve()}
      onMcpRetry={() => {}}
    >
      <MessageList messages={messages} status={status} />
    </MessageListProvider>
  ));
}

const userMessage: UIMessage = {
  id: "user-1",
  role: "user",
  metadata: { opencode: { created: 1_000 } },
  parts: [{ type: "text", text: "do the thing", state: "done" }],
};

describe("finished turn step fold (single OpenCode message per turn)", () => {
  test("folds interleaved steps into a 'Worked for …' line and keeps the answer", () => {
    const assistant: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      metadata: { opencode: { created: 1_000, completed: 80_000 } },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "planning the change", state: "done" },
        bashPart("c1"),
        editPart("c2", "/repo/src/a.ts"),
        { type: "text", text: "Now checking the result:", state: "done" },
        bashPart("c3"),
        bashPart("c4"),
        bashPart("c5"),
        { type: "text", text: "Everything passed — the change is in.", state: "done" },
      ],
    };

    const markup = renderList([userMessage, assistant]);

    // 79 seconds of work between created and completed.
    expect(markup).toContain("Worked for 1m 19s");
    // The answer stays visible outside the fold.
    expect(markup).toContain("Everything passed — the change is in.");
  });

  test("a short turn stays inline with one aggregate line", () => {
    const assistant: UIMessage = {
      id: "assistant-2",
      role: "assistant",
      metadata: { opencode: { created: 1_000, completed: 5_000 } },
      parts: [
        { type: "step-start" },
        bashPart("c1"),
        editPart("c2", "/repo/src/a.ts"),
        { type: "text", text: "Done.", state: "done" },
      ],
    };

    const markup = renderList([userMessage, assistant]);

    expect(markup).not.toContain("Worked for");
    // Both calls merge into one aggregate summary line.
    expect(markup).toContain("Edited 1 file, ran command");
    expect(markup).toContain("Done.");
  });

  test("reasoning between calls stays one aggregate line that advertises its thought", () => {
    const assistant: UIMessage = {
      id: "assistant-3",
      role: "assistant",
      metadata: { opencode: { created: 1_000, completed: 4_000 } },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "first", state: "done" },
        bashPart("c1"),
        { type: "reasoning", text: "second", state: "done" },
        bashPart("c2"),
        { type: "text", text: "Done.", state: "done" },
      ],
    };

    const markup = renderList([userMessage, assistant]);

    // No thought/command ladder: the run is ONE aggregate line…
    expect(markup).toContain("Ran 2 commands");
    // …that counts the thought it carries.
    expect(markup).toContain("1 thought");

    // The turn-opening thought still renders as its own line above the run.
    const openingThought = markup.indexOf("Reasoning trace");
    const run = markup.indexOf("Ran 2 commands");
    expect(openingThought).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(openingThought);
  });
});

describe("finished turn fold (the 2.x engine: one assistant message per step)", () => {
  const at = (id: string, created: number, parts: UIMessage["parts"], completed?: number): UIMessage => ({
    id,
    role: "assistant",
    metadata: { opencode: { created, ...(completed ? { completed } : {}) } },
    parts,
  });

  test("progress notes between steps fold with the work; only the final answer stays out", () => {
    const markup = renderList([
      userMessage,
      at("a1", 1_000, [{ type: "step-start" }, bashPart("c1"), bashPart("c2")]),
      at("a2", 20_000, [{ type: "text", text: "Tests pass; checking the GUI next.", state: "done" }]),
      at("a3", 30_000, [{ type: "step-start" }, bashPart("c3"), bashPart("c4"), editPart("c5", "/repo/src/a.ts")]),
      at("a4", 70_000, [{ type: "text", text: "All done: the fix is in.", state: "done" }], 80_000),
    ]);

    // The fold used to stop at the first note, leaving two short runs inline.
    const label = markup.indexOf("Worked for 1m 19s");
    const answer = markup.indexOf("All done: the fix is in.");
    expect(label).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(label);
    // The note is part of the folded work: never between the fold and the answer's own text.
    const note = markup.indexOf("Tests pass; checking the GUI next.");
    expect(note === -1 || note < answer).toBe(true);
  });

  test("finished heading-only reasoning leaves nothing; reasoning with prose keeps its trace", () => {
    const headingOnly = renderList([
      userMessage,
      at("b1", 1_000, [
        { type: "step-start" },
        { type: "reasoning", text: "**Planning the fix**", state: "done" },
        bashPart("c1"),
        { type: "text", text: "Done.", state: "done" },
      ], 4_000),
    ]);
    expect(headingOnly).not.toContain("Planning the fix");
    expect(headingOnly).not.toContain("Reasoning trace");
    expect(headingOnly).toContain("Done.");

    const withProse = renderList([
      userMessage,
      at("b2", 1_000, [
        { type: "step-start" },
        { type: "reasoning", text: "**Planning the fix**\n\nThe cache key misses the tenant id, so two tenants share entries.", state: "done" },
        bashPart("c1"),
        { type: "text", text: "Done.", state: "done" },
      ], 4_000),
    ]);
    expect(withProse).toContain("Reasoning trace");
  });

  test("live heading-only reasoning rides on the Working row, not a trace", () => {
    const markup = renderList([
      userMessage,
      at("c1", 1_000, [
        { type: "step-start" },
        { type: "reasoning", text: "**Reading the failing test**\n**Tracing the cache key**", state: "streaming" },
      ]),
    ], "streaming");
    expect(markup).toContain("· Tracing the cache key");
    expect(markup).not.toContain("Reading the failing test");
    expect(markup).not.toContain("Reasoning trace");
  });
});
