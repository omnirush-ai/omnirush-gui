/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRequire } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { OmniRushSessionSnapshot } from "../src/app/lib/omnirush-server";

const workspaceId = "workspace-composer-clears";
const sessionId = "session-composer-clears";

function createSnapshot(targetSessionId: string): OmniRushSessionSnapshot {
  return {
    session: {
      id: targetSessionId,
      slug: targetSessionId,
      projectID: "project-composer-snapshot-error",
      directory: "/tmp/project-composer-snapshot-error",
      title: "Composer snapshot error",
      version: "1",
      time: { created: 1, updated: 1 },
    },
    messages: [],
    todos: [],
    status: { type: "idle" },
  };
}

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("a new-session send clears the handed-off text and attachment chips, later sends clear, and a failed send keeps the draft", async () => {
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
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  document.open();
  document.write("<!doctype html><html><body></body></html>");
  document.close();
  Object.defineProperty(document, "compatMode", { configurable: true, value: "CSS1Compat" });
  const fetchStub = async () => new Response("{}", { headers: { "content-type": "application/json" } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchStub });
  Object.defineProperty(window, "fetch", { configurable: true, value: fetchStub });
  mock.module("@/components/model-select", () => ({ ModelSelect: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/workspace-run-mode-menu", () => ({
    WorkspaceRunModeMenu: () => null,
  }));
  mock.module("@/react-app/domains/session/surface/composer/full-permissions-toggle", () => ({
    FullPermissionsToggle: () => null,
  }));
  mock.module("@/react-app/domains/session/surface/composer/subagent-model-menu", () => ({
    SubagentModelMenu: () => null,
  }));
  mock.module("@/app/lib/opencode-session-native", () => ({
    composeNativeSessionSnapshot: async () => createSnapshot(sessionId),
    isMissingSessionError: () => false,
  }));
  const { SessionSurface } = await import("../src/react-app/domains/session/surface/session-surface");
  const { snapshotKey } = await import("../src/react-app/domains/session/sync/session-sync");
  const { composerAutoSendScopeKey, markComposerAutoSend } = await import("../src/react-app/domains/session/surface/composer-auto-send");
  const { claimComposerSessionDraftScope } = await import("../src/react-app/domains/session/surface/composer-state-store");
  const { saveSessionDraft, sessionDraftScopeKey, getSessionDraft } = await import("../src/react-app/domains/session/sync/draft-store");
  const queryClient = getReactQueryClient();
  queryClient.clear();
  const key = snapshotKey(workspaceId, sessionId);
  queryClient.setQueryDefaults(key, { retryDelay: 0 });
  queryClient.setQueryData(key, createSnapshot(sessionId));
  const client = createOmniRushServerClient({ baseUrl: "http://127.0.0.1:1", token: "test-token" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const opencodeBaseUrl = "http://127.0.0.1:1/opencode";
  const sent: string[] = [];
  let failNext = false;

  // Mirror the route's new-task handoff: the created session's composer is
  // seeded with the continuation (which still holds the submitted text and
  // image chip) and the submitted snapshot is marked for auto-send.
  const image = {
    id: "att-1",
    name: "shot.png",
    mimeType: "image/png",
    size: 4,
    kind: "image" as const,
    file: new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" }),
  };
  const submitted = {
    draft: "hi[attachment att-1]",
    attachments: [image],
    mentions: {},
    pasteParts: [],
    revertMessageId: null,
  };
  saveSessionDraft("local", workspaceId, sessionId, { text: "hi", mode: "prompt" });
  claimComposerSessionDraftScope(sessionId, sessionDraftScopeKey("local", workspaceId, sessionId));
  useComposerStateStore.setState((state) => ({
    sessions: { ...state.sessions, [sessionId]: { ...submitted, attachments: [...submitted.attachments] } },
  }));
  markComposerAutoSend(sessionId, {
    scopeKey: composerAutoSendScopeKey({ draftScope: "local", opencodeBaseUrl, workspaceId, sessionId }),
    composer: submitted,
  });

  const editorText = () => container.querySelector('[data-lexical-editor="true"]')?.textContent ?? "";
  const composerState = () => useComposerStateStore.getState().sessions[sessionId];

  try {
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <LocalProvider>
          <ShellConfigProvider>
            <SessionSurface
              client={client}
              workspaceId={workspaceId}
              workspaceRoot="/tmp/project-composer-clears"
              sessionId={sessionId}
              draftScope="local"
              isControlTarget={false}
              opencodeBaseUrl={opencodeBaseUrl}
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
                sent.push(draft.text);
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
              agentLabel="OmniRush.ai"
              selectedAgent={null}
              listAgents={async () => []}
              onSelectAgent={() => {}}
              listCommands={async () => []}
              recentFiles={[]}
              searchFiles={async () => []}
              isRemoteWorkspace
              isSandboxWorkspace={false}
              providerConnectedCount={1}
            />
          </ShellConfigProvider>
        </LocalProvider>
      </QueryClientProvider>,
    ));

    await waitFor(() => sent.length === 1, "the handed-off first message to send");
    await waitFor(() => !composerState()?.draft && !composerState()?.attachments.length, "the composer to clear");
    await waitFor(() => editorText().trim() === "", "the editor to empty");
    expect(container.querySelector("[data-attachment-id]")).toBeNull();
    expect(getSessionDraft("local", workspaceId, sessionId)).toBeNull();

    // A follow-up in the same (now existing) session clears as well.
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "second"));
    await waitFor(() => editorText() === "second", "the follow-up draft to reach Lexical");
    const runTask = () => container.querySelector<HTMLButtonElement>('button[aria-label="Run task"]');
    await waitFor(() => runTask()?.disabled === false, "the send button");
    await act(async () => runTask()?.click());
    await waitFor(() => sent.length === 2, "the follow-up to send");
    expect(sent[1]).toBe("second");
    await waitFor(() => !composerState()?.draft && editorText().trim() === "", "the follow-up to clear");

    // A failed send keeps the draft.
    failNext = true;
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "will fail"));
    await waitFor(() => runTask()?.disabled === false, "the send button");
    await act(async () => runTask()?.click());
    await waitFor(() => composerState()?.draft === "will fail", "the failed draft to be restored");
    expect(sent.length).toBe(2);
  } finally {
    await act(async () => root.unmount());
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, history: {}, pendingMessages: {}, failedDrafts: {} });
    queryClient.clear();
    container.remove();
    mock.restore();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
