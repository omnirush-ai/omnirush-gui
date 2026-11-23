/** @jsxImportSource react */
// A Work chat's reference chips through the real chat surface (judge M3, M6): the Work home handoff sends chips only as
// the default question and clears them; a starter sends with the chips; a failed send gives them back; a reply chip's
// send (a chat command) never carries or clears them; editing a sent question brings its chips back; a Code chat never
// shows or sends them.
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRequire } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";

import type { ComposerDraft } from "../src/app/types";
import type { OmniRushSessionSnapshot } from "../src/app/lib/omnirush-server";

const workspaceId = "workspace-work-ask";
const sessionId = "ses_work_ask";
const projectRef = { kind: "project" as const, title: "juniper/ops-dock", source: "github", entityId: "7f3c2a" };
const dealRef = { kind: "deal" as const, title: "Acme renewal", source: "hubspot", sourceId: "hubspot:deal:301", company: "Acme" };

function snapshot(): OmniRushSessionSnapshot {
  const note = "Attached for context (look each item up before you answer):\n- deal \"Acme renewal\"";
  return {
    session: { id: sessionId, slug: sessionId, projectID: "p", directory: "/tmp/work-ask", title: "Work", version: "1", time: { created: 1, updated: 1 } },
    messages: [{
      info: { id: "msg_sent", sessionID: sessionId, role: "user", time: { created: 1 } },
      parts: [
        { id: "msg_sent:0", sessionID: sessionId, messageID: "msg_sent", type: "text", text: note, synthetic: true, metadata: { refs: [dealRef] } },
        { id: "msg_sent:1", sessionID: sessionId, messageID: "msg_sent", type: "text", text: "Where does it stand?" },
      ],
    }],
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

test("Work chat chips: handoff, starters, failed send, reply chips, edit; Code chats never carry them", async () => {
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
  ] = await Promise.all([
    import("../src/app/lib/omnirush-server"),
    import("../src/react-app/domains/connections/cloud-mcp-submit-readiness"),
    import("../src/react-app/domains/session/surface/composer-state-store"),
    import("../src/react-app/infra/query-client"),
    import("../src/react-app/kernel/local-provider"),
    import("../src/react-app/shell/shell-config"),
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
  const render = (workChat: boolean) => act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
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
          />
        </ShellConfigProvider>
      </LocalProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
  const runTask = () => container.querySelector<HTMLButtonElement>('button[aria-label="Run task"]');

  try {
    // The Work home hands over chips only (as startWorkChat does): sent as the default question, then cleared.
    claimComposerSessionDraftScope(sessionId, sessionDraftScopeKey("local", workspaceId, sessionId));
    useComposerStateStore.getState().setRefs(sessionId, [projectRef]);
    markComposerAutoSend(sessionId);
    await render(true);
    await waitFor(() => sent.length === 1, "the handed-off chips to send");
    expect(sent[0]!.text).toBe("Brief me on this");
    expect(refsOf(sent[0]!)).toEqual(["juniper/ops-dock"]);
    await waitFor(() => !composer()?.refs?.length, "the chips to clear after the send");

    // The sent question from history shows its chip above the bubble.
    await waitFor(() => Boolean(container.querySelector('[data-testid="work-ref-message-chips"] [data-ref-chip="r:hubspot:deal:301"]')), "the sent chip");

    // Chips in the composer: the starters show while the text is empty; one sends with the chips and clears them.
    await act(async () => useComposerStateStore.getState().setRefs(sessionId, [dealRef]));
    await waitFor(() => Boolean(container.querySelector('[data-testid="work-ref-chips"]')), "the composer chips");
    expect(container.querySelector('[data-composer-panel] [aria-placeholder]')?.getAttribute("aria-placeholder")).toBe("Ask about Acme renewal, or press Enter for a brief");
    const starters = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="work-ask-starters"] [data-suggestion-chip]'));
    expect(starters().map((button) => button.textContent)).toEqual(["Where does it stand?", "What puts it at risk?", "Draft a follow-up"]);
    // Keys in the row stay in the row: ArrowUp there never recalls the sent history into the empty composer.
    starters()[0]!.focus();
    await act(async () => { starters()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })); });
    expect(composer()?.draft ?? "").toBe("");
    await act(async () => starters()[1]!.click());
    await waitFor(() => sent.length === 2, "the starter to send");
    expect(sent[1]!.text).toBe("What puts it at risk?");
    expect(refsOf(sent[1]!)).toEqual(["Acme renewal"]);
    await waitFor(() => !composer()?.refs?.length && !composer()?.draft, "the starter send to clear the chips");

    // A failed send gives the chips back with the text.
    await act(async () => {
      useComposerStateStore.getState().setRefs(sessionId, [dealRef]);
      useComposerStateStore.getState().setDraft(sessionId, "Draft a reply");
    });
    await waitFor(() => Boolean(container.querySelector('[data-testid="work-ref-chips"]')), "the chips again");
    expect(container.querySelector('[data-testid="work-ask-starters"]')).toBeNull();
    failNext = true;
    await waitFor(() => runTask()?.disabled === false, "the send button");
    await act(async () => runTask()?.click());
    await waitFor(() => composer()?.draft === "Draft a reply" && composer()?.refs?.length === 1, "the failed draft and chips to come back");
    expect(sent).toHaveLength(2);

    // A reply chip's send (a chat command) neither carries nor clears the composer's chips.
    await act(async () => { await useSessionCommandsStore.getState().bridges[sessionId]!.runCommand("Send it"); });
    await waitFor(() => sent.length === 3, "the reply to send");
    expect(sent[2]!.text).toBe("Send it");
    expect(refsOf(sent[2]!)).toEqual([]);
    expect(composer()?.refs?.map((ref) => ref.title)).toEqual(["Acme renewal"]);
    expect(composer()?.draft).toBe("Draft a reply");

    // Editing a sent question puts its text and its chips back in the composer.
    await act(async () => {
      useComposerStateStore.getState().setRefs(sessionId, []);
      useComposerStateStore.getState().setDraft(sessionId, "");
    });
    const edit = () => container.querySelector<HTMLButtonElement>('[data-message-id="msg_sent"] button[aria-label="Edit message"]');
    await waitFor(() => Boolean(edit()), "the edit button");
    await act(async () => edit()!.click());
    await waitFor(() => composer()?.draft === "Where does it stand?" && composer()?.refs?.length === 1, "the edited question and its chip");
    expect(composer()?.refs?.[0]).toMatchObject({ sourceId: "hubspot:deal:301" });

    // A Code chat: chips in the store are neither shown nor sent.
    await act(async () => {
      useComposerStateStore.getState().setRefs(sessionId, [dealRef]);
      useComposerStateStore.getState().setDraft(sessionId, "plain");
      useComposerStateStore.getState().clearRevertTarget(sessionId);
    });
    await render(false);
    await waitFor(() => !container.querySelector('[data-testid="work-ref-chips"]'), "no chips in a Code chat");
    expect(container.querySelector('[data-testid="work-ask-starters"]')).toBeNull();
    await waitFor(() => runTask()?.disabled === false, "the send button");
    await act(async () => runTask()?.click());
    await waitFor(() => sent.length === 4, "the Code send");
    expect(refsOf(sent[3]!)).toEqual([]);
    expect(sent[3]!.text).toBe("plain");
  } finally {
    await act(async () => root.unmount());
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, history: {}, pendingMessages: {}, failedDrafts: {} });
    queryClient.clear();
    container.remove();
    mock.restore();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
