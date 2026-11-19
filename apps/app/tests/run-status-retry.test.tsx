/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";

test("a retry shows its reason once: the card above the composer keeps the title and Stop, the chat's retry card has the reason", async () => {
  const require = createRequire(import.meta.url);
  // Bun's isolated test loader cycles Lexical's ESM entries; use their real CJS entries before the app imports the editor.
  for (const moduleId of [
    "lexical",
    "@lexical/react/LexicalComposer.js",
    "@lexical/react/LexicalPlainTextPlugin.js",
    "@lexical/react/LexicalContentEditable.js",
    "@lexical/react/LexicalErrorBoundary.js",
    "@lexical/react/LexicalOnChangePlugin.js",
    "@lexical/react/LexicalHistoryPlugin.js",
    "@lexical/react/LexicalComposerContext.js",
  ]) {
    const moduleExports = require(moduleId);
    mock.module(moduleId, () => moduleExports);
  }
  const { SessionRunStatus } = await import("../src/react-app/domains/session/surface/session-surface");
  const noop = () => {};
  const base = { activityStatus: "thinking" as const, busy: true, preparing: false, sending: false, acceptanceUnknown: false, queuedCount: 0, onCheckAcceptance: noop, onStop: noop };
  const retry = renderToStaticMarkup(<SessionRunStatus {...base} retrying />);
  expect(retry).toContain("Retrying the request");
  expect(retry).toContain(">Stop<");
  expect(retry.match(/<p /g)?.length).toBe(1);
  // Routine work shows no card; a question the agent waits on keeps its detail line.
  expect(renderToStaticMarkup(<SessionRunStatus {...base} />)).toBe("");
  expect(renderToStaticMarkup(<SessionRunStatus {...base} activityStatus="waiting" />).match(/<p /g)?.length).toBe(2);
});
