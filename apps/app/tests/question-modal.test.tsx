import { describe, expect, test } from "bun:test";
import type { QuestionInfo } from "@opencode-ai/sdk/v2/client";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { QuestionPanel } from "../src/react-app/domains/session/modals/question-modal";

function renderQuestion(question: QuestionInfo) {
  return renderToStaticMarkup(
    React.createElement(QuestionPanel, {
      questions: [question],
      busy: false,
      onReply: () => {},
    }),
  );
}

describe("QuestionPanel", () => {
  test("a question in an inactive pane preserves focus when the pane is activated", async () => {
    if (typeof document === "undefined") GlobalRegistrator.register();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    const container = document.createElement("div");
    const composer = document.createElement("input");
    document.body.append(composer, container);
    composer.focus();
    const root = createRoot(container);
    const questions: QuestionInfo[] = [{
      header: "Choice", question: "Pick one", options: [{ label: "Yes", description: "Proceed" }],
    }];
    const render = async (autoFocus: boolean) => act(async () => root.render(React.createElement(QuestionPanel, {
      questions, busy: false, autoFocus, onReply: () => {},
    })));
    try {
      await render(false);
      expect(document.activeElement).toBe(composer);
      await render(true);
      expect(document.activeElement).toBe(composer);
      await render(false);
      const customInput = container.querySelector("input");
      await act(async () => customInput?.focus());
      await render(true);
      expect(document.activeElement).toBe(customInput);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      composer.remove();
    }
  });

  test("two fast Enter presses answer only the current question and pending replies are cancelled on unmount", async () => {
    if (typeof document === "undefined") GlobalRegistrator.register();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const replies: string[][][] = [];
    const questions: QuestionInfo[] = ["First", "Second", "Third"].map((header) => ({
      header, question: "Pick one", options: [{ label: header, description: "Use this" }],
    }));
    try {
      await act(async () => root.render(React.createElement(QuestionPanel, { questions, busy: false, onReply: (answers) => replies.push(answers) })));
      await act(async () => {
        for (let i = 0; i < 2; i += 1) {
          document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        }
        await new Promise((resolve) => setTimeout(resolve, 170));
      });
      expect(container.textContent).toContain("Second");
      expect(container.textContent).not.toContain("Third");
      expect(replies).toEqual([]);
      await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
    await new Promise((resolve) => setTimeout(resolve, 170));
    expect(replies).toEqual([]);
  });

  test("keyboard focus wraps, Enter answers each question, and busy blocks replies", async () => {
    if (typeof document === "undefined") GlobalRegistrator.register();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const replies: string[][][] = [];
    const questions: QuestionInfo[] = [
      { header: "First", question: "Pick one", options: [{ label: "Yes", description: "Proceed" }, { label: "No", description: "Stop" }] },
      { header: "Second", question: "Pick again", options: [{ label: "Later", description: "Wait" }] },
    ];
    const render = async (busy: boolean) => {
      await act(async () => { root.render(React.createElement(QuestionPanel, { questions, busy, onReply: (answers) => replies.push(answers) })); });
    };
    const press = async (key: string, init: KeyboardEventInit = {}) => {
      await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
        await new Promise((resolve) => setTimeout(resolve, 170));
      });
    };
    try {
      await render(false);
      const buttons = container.querySelectorAll("button");
      expect(document.activeElement).toBe(buttons[0]);
      await press("ArrowUp");
      expect(document.activeElement).toBe(buttons[1]);
      await press("ArrowDown");
      expect(document.activeElement).toBe(buttons[0]);
      await press("ArrowDown");
      expect(document.activeElement).toBe(buttons[1]);
      await press("Enter", { repeat: true });
      await press("Enter", { isComposing: true });
      expect(container.textContent).toContain("First");
      await press("Enter");
      expect(container.textContent).toContain("Second");
      expect(document.activeElement?.textContent).toContain("Later");
      await render(true);
      await press("Enter");
      expect(replies).toEqual([]);
      await render(false);
      await press("Enter");
      expect(replies).toEqual([[ ["No"], ["Later"] ]]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("Enter toggles multiple choices and custom input keeps its arrow keys", async () => {
    if (typeof document === "undefined") GlobalRegistrator.register();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const replies: string[][][] = [];
    try {
      await act(async () => root.render(React.createElement(QuestionPanel, {
        questions: [{ header: "Choices", question: "Pick several", multiple: true, options: [{ label: "One", description: "First" }, { label: "Two", description: "Second" }] }],
        busy: false,
        onReply: (answers) => replies.push(answers),
      })));
      const press = async (key: string) => act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
      await press("Enter");
      await press("ArrowDown");
      await press("Enter");
      expect(replies).toEqual([]);
      const input = container.querySelector("input");
      await act(async () => input?.focus());
      await press("ArrowUp");
      expect(document.activeElement).toBe(input);
      const submit = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Submit"));
      await act(async () => submit?.click());
      expect(replies).toEqual([[["One", "Two"]]]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("shows custom answer input when custom is omitted", () => {
    const html = renderQuestion({
      header: "Choice",
      question: "Pick one",
      options: [{ label: "Yes", description: "Proceed" }],
    });

    expect(html).toContain("Or type a custom answer");
    expect(html).toContain("Type your answer here...");
  });

  test("hides custom answer input when custom is false", () => {
    const html = renderQuestion({
      header: "Choice",
      question: "Pick one",
      options: [{ label: "Yes", description: "Proceed" }],
      custom: false,
    });

    expect(html).not.toContain("Or type a custom answer");
    expect(html).not.toContain("Type your answer here...");
  });
});
