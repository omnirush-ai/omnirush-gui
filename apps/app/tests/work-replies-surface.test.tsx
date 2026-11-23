/** @jsxImportSource react */
// Suggested replies through the real chat surface (design 3.5, judge M3, M8): the row shows under the newest answer of
// a Work chat; a reply chip sends at once as a chat command and leaves the composer (text and chips) alone; the pencil
// fills the composer after any text already there; chips attached to the composer hide the row and show their
// questions, and removing them brings it back; a pending question hides it; a Code chat shows the block as text.
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRequire } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";

import type { ComposerDraft } from "../src/app/types";
import type { OmniRushSessionSnapshot } from "../src/app/lib/omnirush-server";

const workspaceId = "workspace-work-replies";
const sessionId = "ses_work_replies";
const dealRef = { kind: "deal" as const, title: "Acme renewal", source: "hubspot", sourceId: "hubspot:deal:301", company: "Acme" };
const answer = "Here is the draft to Dana:\n\n> Hi Dana, the new rate starts on 1 December.\n\nShall I send it?\n<replies>\nSend it\nMake it shorter\n</replies>";

function snapshot(): OmniRushSessionSnapshot {
  return {
    session: { id: sessionId, slug: sessionId, projectID: "p", directory: "/tmp/work-replies", title: "Work", version: "1", time: { created: 1, updated: 3 } },
    messages: [
      {
        info: { id: "msg_ask", sessionID: sessionId, role: "user", time: { created: 1 } },
        parts: [{ id: "msg_ask:0", sessionID: sessionId, messageID: "msg_ask", type: "text", text: "Draft a reply to Dana" }],
      },
      {
        info: { id: "msg_answer", sessionID: sessionId, role: "assistant", parentID: "msg_ask", time: { created: 2, completed: 3 }, modelID: "test-model", providerID: "test", mode: "build", agent: "build", path: { cwd: "/tmp/work-replies", root: "/tmp/work-replies" }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: [{ id: "msg_answer:0", sessionID: sessionId, messageID: "msg_answer", type: "text", text: answer, time: { start: 2, end: 3 } }],
      },
    ],
    todos: [],
    status: { type: "idle" },
  } as never;
}

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 10)); });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("Work chat replies: under the newest answer; a click sends, the pencil fills; chips in the composer, a question or a Code chat hide them", async () => {
  const require = createRequire(import.meta.url);
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
  const [
    { createOmniRushServerClient },
    { IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE },
    { useComposerStateStore },
    { getReactQueryClient },
    { LocalProvider },
    { ShellConfigProvider },
    { PlatformProvider, createDefaultPlatform },
  ] = await Promise.all([
    import("../src/app/lib/omnirush-server"),
    import("../src/react-app/domains/connections/cloud-mcp-submit-readiness"),
    import("../src/react-app/domains/session/surface/composer-state-store"),
    import("../src/react-app/infra/query-client"),
    import("../src/react-app/kernel/local-provider"),
    import("../src/react-app/shell/shell-config"),
    import("../src/react-app/kernel/platform"),
  ]);
  const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
  if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  document.open();
  document.write("<!doctype html><html><body></body></html>");
  document.close();
  Object.defineProperty(document, "compatMode", { configurable: true, value: "CSS1Compat" });
  // Work lists answer empty lists; everything else an empty object.
  const fetchStub = async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    return new Response(/\/work\/(connectors|tools)(\?|$)/.test(url) ? "[]" : "{}", { headers: { "content-type": "application/json" } });
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchStub });
  Object.defineProperty(window, "fetch", { configurable: true, value: fetchStub });
  mock.module("@/components/model-select", () => ({ ModelSelect: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/workspace-run-mode-menu", () => ({ WorkspaceRunModeMenu: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/full-permissions-toggle", () => ({ FullPermissionsToggle: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/subagent-model-menu", () => ({ SubagentModelMenu: () => null }));
  mock.module("@/app/lib/opencode-session-native", () => ({
    composeNativeSessionSnapshot: async () => snapshot(),
    isMissingSessionError: () => false,
  }));
  const { SessionSurface } = await import("../src/react-app/domains/session/surface/session-surface");
  const { snapshotKey } = await import("../src/react-app/domains/session/sync/session-sync");
  const { markComposerAutoSend } = await import("../src/react-app/domains/session/surface/composer-auto-send");
  const { claimComposerSessionDraftScope } = await import("../src/react-app/domains/session/surface/composer-state-store");
  const { sessionDraftScopeKey } = await import("../src/react-app/domains/session/sync/draft-store");
  const { useSessionCommandsStore } = await import("../src/react-app/domains/session/commands/session-commands-store");
  const queryClient = getReactQueryClient();
  queryClient.clear();
  const key = snapshotKey(workspaceId, sessionId);
  queryClient.setQueryDefaults(key, { retryDelay: 0 });
  queryClient.setQueryData(key, snapshot());
  const client = createOmniRushServerClient({ baseUrl: "http://127.0.0.1:1", token: "test-token" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const sent: ComposerDraft[] = [];
  let failNext = false;

  const composer = () => useComposerStateStore.getState().sessions[sessionId];
  const refsOf = (draft: ComposerDraft) => draft.parts.flatMap((part) => (part.type === "ref" ? [part.ref.title] : []));
  const render = (workChat: boolean, extra: Record<string, unknown> = {}) => act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
      <PlatformProvider value={createDefaultPlatform()}>
      <LocalProvider>
        <ShellConfigProvider>
          <SessionSurface
            client={client}
            workspaceId={workspaceId}
            workspaceRoot="/tmp/work-ask"
            sessionId={sessionId}
            draftScope="local"
            isControlTarget={false}
            opencodeBaseUrl="http://127.0.0.1:1/opencode"
            omnirushToken="test-token"
            developerMode
            modelLabel="Test model"
            onModelClick={() => {}}
            modelPickerOpen={false}
            selectedModel={{ providerID: "test", modelID: "test-model" }}
            onModelPickerOpenChange={() => {}}
            onModelChange={() => {}}
            onSendDraft={async (draft, _sessionId, onPrepared) => {
              onPrepared?.();
              if (failNext) {
                failNext = false;
                throw new Error("send failed");
              }
              sent.push(draft);
              return { outcome: "accepted" };
            }}
            cloudMcpSubmissionState={IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE}
            onOpenConnect={() => {}}
            onDraftChange={() => {}}
            attachmentsEnabled
            attachmentsDisabledReason={null}
            modelVariantLabel="Default"
            modelVariant={null}
            onModelVariantChange={() => {}}
            agentLabel="Work"
            selectedAgent={null}
            listAgents={async () => []}
            onSelectAgent={() => {}}
            listCommands={async () => []}
            recentFiles={[]}
            searchFiles={async () => []}
            isRemoteWorkspace={false}
            isSandboxWorkspace={false}
            providerConnectedCount={1}
            workChat={workChat}
            {...extra}
          />
        </ShellConfigProvider>
      </LocalProvider>
      </PlatformProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
  const runTask = () => container.querySelector<HTMLButtonElement>('button[aria-label="Run task"]');

  const replyChips = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="work-reply-chips"] [data-suggestion-chip]'));
  const transcript = () => Array.from(container.querySelectorAll("[data-message-role='assistant']")).map((el) => el.textContent ?? "").join("\n");
  void runTask;
  void refsOf;

  try {
    claimComposerSessionDraftScope(sessionId, sessionDraftScopeKey("local", workspaceId, sessionId));
    await render(true);
    await waitFor(() => replyChips().length === 2, "the reply chips");
    expect(replyChips().map((chip) => chip.textContent?.trim())).toEqual(["Send it", "Make it shorter"]);
    expect(transcript()).toContain("Shall I send it?");
    expect(transcript()).not.toContain("replies");
    expect(transcript()).not.toContain("Make it shorter");

    // The pencil fills the composer after the text already there, and sends nothing.
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "Also,"));
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[data-testid="work-reply-chips"] [data-suggestion-edit]')[1]!.click());
    await waitFor(() => composer()?.draft === "Also, Make it shorter", "the filled reply");
    expect(sent).toHaveLength(0);

    // Chips attached to the composer: the row hides and their questions show; removing them brings the row back.
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, ""));
    await act(async () => useComposerStateStore.getState().setRefs(sessionId, [dealRef]));
    await waitFor(() => Boolean(container.querySelector('[data-testid="work-ask-starters"]')), "the starters");
    expect(container.querySelector('[data-testid="work-replies"]')).toBeNull();
    await act(async () => useComposerStateStore.getState().setRefs(sessionId, []));
    await waitFor(() => replyChips().length === 2, "the row back");
    expect(container.querySelector('[data-testid="work-ask-starters"]')).toBeNull();

    // A pending question (or approval) is the answer: no chips.
    await render(true, { activeQuestion: { id: "que_1", sessionID: sessionId, questions: [{ question: "Which Dana?", header: "Dana", options: [{ label: "Dana Ruiz", description: "" }] }], receivedAt: 1 } });
    await waitFor(() => !container.querySelector('[data-testid="work-replies"]'), "no row while a question waits");
    await render(true);
    await waitFor(() => replyChips().length === 2, "the row after the question");

    // A click sends the reply at once as a chat command; the composer's text and chips are left alone.
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "Also, Make it shorter"));
    await act(async () => replyChips()[0]!.click());
    await waitFor(() => sent.length === 1, "the reply to send");
    expect(sent[0]!.text).toBe("Send it");
    expect(refsOf(sent[0]!)).toEqual([]);
    expect(composer()?.draft).toBe("Also, Make it shorter");

    // A Code chat: the block is text and no row shows.
    await render(false);
    await waitFor(() => !container.querySelector('[data-testid="work-replies"]'), "no row in a Code chat");
    expect(transcript()).toContain("Make it shorter");
  } finally {
    await act(async () => root.unmount());
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, history: {}, pendingMessages: {}, failedDrafts: {} });
    queryClient.clear();
    container.remove();
    mock.restore();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
