/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { MessageList } from "../src/components/chat/message-list";
import { ReasoningBlock } from "../src/components/chat/reasoning-block";
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

  test("a short finished turn folds too, as in Codex", () => {
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

    expect(markup).toContain("Worked for 4s");
    // Its calls are folded away; the answer stays.
    expect(markup).not.toContain("Edited 1 file, ran command");
    expect(markup).toContain("Done.");
  });

  test("the turn-opening thought and the calls after it fold with the turn", () => {
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

    // The aggregate line itself (one line, its thought counted) is covered in
    // tool-aggregate-group.test.tsx; here it folds with the rest of the work.
    expect(markup).toContain("Worked for 3s");
    expect(markup).not.toContain("Ran 2 commands");
    expect(markup).not.toContain("Reasoning trace");
    expect(markup).toContain("Done.");
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

  test("a live turn keeps only its latest note under the header; the calls after it fold", () => {
    const runningPytest: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "c9",
      state: "input-available",
      input: { command: "python -m pytest -q", description: "run tests" },
    };
    const markup = renderList([
      userMessage,
      at("l1", 1_000, [{ type: "step-start" }, bashPart("c1")]),
      at("l2", 5_000, [{ type: "text", text: "Progress 6/7: the project declares Python 3.10+.", state: "done" }]),
      at("l3", 6_000, [{ type: "step-start" }, runningPytest]),
    ], "streaming");
    const header = markup.indexOf("Working 0s");
    const note = markup.indexOf("Progress 6/7");
    expect(header).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(header);
    // The running command is work: folded under the header, so no tool row follows the note.
    expect(markup.slice(note)).not.toContain("data-tool-aggregate");
    expect(markup).not.toContain("python -m pytest -q");
  });

  test("a live note's own calls after its text fold too (one message: note, then a call)", () => {
    const runningGrep: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "c10",
      state: "input-available",
      input: { command: "grep -rn TODO tinydb", description: "find todos" },
    };
    const markup = renderList([
      userMessage,
      at("m1", 1_000, [{ type: "step-start" }, bashPart("c1")]),
      at("m2", 5_000, [
        { type: "step-start" },
        { type: "text", text: "Progress 3/7: scanning for TODO comments next.", state: "done" },
        runningGrep,
      ]),
    ], "streaming");
    const note = markup.indexOf("Progress 3/7");
    expect(note).toBeGreaterThan(markup.indexOf("Working 0s"));
    expect(markup.slice(note)).not.toContain("data-tool-aggregate");
  });

  test("finished heading-only reasoning leaves nothing; reasoning with prose keeps its trace", () => {
    const block = (text: string) => withoutWindow(() => renderToStaticMarkup(<ReasoningBlock text={text} isStreaming={false} />));
    expect(block("**Planning the fix**")).toBe("");
    expect(block("**Planning the fix**\n\nThe cache key misses the tenant id.")).toContain("Reasoning trace");

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
  });

  test("live heading-only reasoning rides on the turn's Working header, not a trace", () => {
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
