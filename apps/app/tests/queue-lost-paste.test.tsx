/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRequire } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionStatus } from "@opencode-ai/sdk/v2/client";

import type { OmniRushSessionSnapshot } from "../src/app/lib/omnirush-server";
import type { ComposerDraft } from "../src/app/types";
import type { CloudMcpSubmissionResult } from "../src/react-app/domains/connections/cloud-mcp-submit-readiness";

const workspaceId = "workspace-queue-lost-paste";
const sessionId = "session-queue-lost-paste";

function createSnapshot(status: SessionStatus, updated: number): OmniRushSessionSnapshot {
  return {
    session: {
      id: sessionId,
      slug: sessionId,
      projectID: "project-queue-steer",
      directory: "/tmp/project-queue-steer",
      title: "Queue and steer",
      version: "1",
      time: { created: 1, updated },
    },
    messages: [{
      info: {
        id: "existing-user-message", sessionID: sessionId, role: "user", time: { created: 1 },
        agent: "build", model: { providerID: "test", modelID: "test-model" },
      },
      parts: [{ id: "existing-user-part", sessionID: sessionId, messageID: "existing-user-message", type: "text", text: "Keep this session mounted." }],
    }],
    todos: [],
    status,
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

// A draft whose pasted text or quote was lost (a bare placeholder, e.g. saved by an older version) never reaches
// the model as the token: Queue refuses it, the automatic drain holds at it, and Send now refuses it.
test("a lost paste placeholder is never queued, drained or sent now", async () => {
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
  let acceptedMessageId: string | null = null;
  const acceptanceRequests: Request[] = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.includes(`/session/${sessionId}/message/`)) {
      acceptanceRequests.push(request);
      return acceptedMessageId
        ? Response.json({ info: { id: acceptedMessageId, sessionID: sessionId, role: "user" }, parts: [] })
        : new Response(null, { status: 404 });
    }
    return Response.json({});
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchStub });
  Object.defineProperty(window, "fetch", { configurable: true, value: fetchStub });
  window.localStorage.setItem("omnirush.shell-config", JSON.stringify({ starterCards: false }));
  let fetchedSnapshot = createSnapshot({ type: "busy" }, 1);
  mock.module("@/components/model-select", () => ({ ModelSelect: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/workspace-run-mode-menu", () => ({ WorkspaceRunModeMenu: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/full-permissions-toggle", () => ({ FullPermissionsToggle: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/subagent-model-menu", () => ({ SubagentModelMenu: () => null }));
  mock.module("@/app/lib/opencode-session-native", () => ({
    composeNativeSessionSnapshot: async () => fetchedSnapshot,
    isMissingSessionError: () => false,
  }));
  const { SessionSurface } = await import("../src/react-app/domains/session/surface/session-surface");
  const { snapshotKey, statusKey, transcriptKey } = await import("../src/react-app/domains/session/sync/session-sync");
  const { resetQueuedDrainForTests } = await import("../src/react-app/domains/session/surface/queued-drain-machine");
  const queryClient = getReactQueryClient();
  queryClient.clear();
  queryClient.setQueryData(snapshotKey(workspaceId, sessionId), createSnapshot({ type: "busy" }, 1));
  queryClient.setQueryData(transcriptKey(workspaceId, sessionId), [{
    id: "existing-user-message",
    role: "user",
    parts: [{ type: "text", text: "Keep this session mounted." }],
  }]);
  const client = createOmniRushServerClient({ baseUrl: "http://127.0.0.1:1", token: "test-token" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
    const sentDrafts: ComposerDraft[] = [];

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <LocalProvider>
            <ShellConfigProvider>
              <SessionSurface
                client={client}
                workspaceId={workspaceId}
                workspaceRoot="/tmp/project-queue-steer"
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
                onSendDraft={async (value) => {
                  sentDrafts.push(value);
                  return { outcome: "accepted" };
                }}
                cloudMcpSubmissionState={IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE}
                onOpenConnect={() => {}}
                onDraftChange={() => {}}
                attachmentsEnabled={false}
                attachmentsDisabledReason="Not needed in this test"
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
      );
    });
    await waitFor(
      () => container.querySelector('[contenteditable="true"][data-lexical-editor="true"]') !== null,
      "the Lexical editor",
    );
    const editor = container.querySelector<HTMLElement>('[contenteditable="true"][data-lexical-editor="true"]');
    if (!editor) throw new Error("Expected the Lexical editor");
    editor.focus();
    expect(document.activeElement).toBe(editor);

    const typeDraft = async (text: string) => {
      await act(async () => useComposerStateStore.getState().setDraft(sessionId, text));
      await waitFor(() => editor.textContent === text, `the draft "${text}" to reach Lexical`);
    };
    // Enter as Lexical sees it: with the caret at the end of the draft (happy-dom sets no selection on focus).
    const lexical = require("lexical") as typeof import("lexical");
    const lexicalEditor = (editor as HTMLElement & { __lexicalEditor?: import("lexical").LexicalEditor }).__lexicalEditor;
    if (!lexicalEditor) throw new Error("Expected the Lexical editor instance");
    const press = async (init: KeyboardEventInit) => {
      await act(async () => {
        lexicalEditor.update(() => {
          lexical.$getRoot().selectEnd();
          lexicalEditor.dispatchCommand(lexical.KEY_ENTER_COMMAND, new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init }));
        }, { discrete: true });
      });
    };

    const legacy = "See [pasted text Quote: words from an old draft]";
    const draftOf = (text: string): ComposerDraft => ({ mode: "prompt", parts: [{ type: "text", text }], attachments: [], text, resolvedText: text });

    // Busy: Enter (Queue) refuses it and the composer keeps it.
    await typeDraft(legacy);
    await press({});
    expect(useComposerStateStore.getState().queuedDrafts[sessionId] ?? []).toHaveLength(0);
    expect(sentDrafts).toHaveLength(0);
    expect(editor.textContent).toBe(legacy);
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, ""));

    // Queued by an older version: the lost one first, a good one after it.
    await act(async () => {
      useComposerStateStore.getState().appendQueuedDraft(sessionId, draftOf(legacy));
      useComposerStateStore.getState().appendQueuedDraft(sessionId, draftOf("A fine follow-up"));
    });

    // Idle: the automatic drain holds at the lost item; nothing is sent.
    await act(async () => {
      fetchedSnapshot = createSnapshot({ type: "idle" }, 2);
      queryClient.setQueryData(snapshotKey(workspaceId, sessionId), createSnapshot({ type: "idle" }, 2));
      queryClient.setQueryData(statusKey(workspaceId, sessionId), { type: "idle" });
    });
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 800)); });
    expect(sentDrafts).toHaveLength(0);
    expect(useComposerStateStore.getState().queuedDrafts[sessionId]?.map((item) => item.draft.text)).toEqual([legacy, "A fine follow-up"]);

    // Send now on the lost item: refused, it stays queued.
    await waitFor(() => container.querySelectorAll('button[aria-label="Send now"]').length > 0 || document.querySelectorAll('button[aria-label="Send now"]').length > 0, "the queued item's Send now");
    const sendNow = (container.querySelector('button[aria-label="Send now"]') ?? document.querySelector('button[aria-label="Send now"]')) as HTMLButtonElement;
    await act(async () => { sendNow.click(); await new Promise<void>((resolve) => setTimeout(resolve, 200)); });
    expect(sentDrafts).toHaveLength(0);
    expect(useComposerStateStore.getState().queuedDrafts[sessionId]?.[0]?.draft.text).toBe(legacy);
    expect(acceptedMessageId).toBeNull();
  } finally {
    await act(async () => root.unmount());
    resetQueuedDrainForTests();
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, history: {}, pendingMessages: {}, failedDrafts: {} });
    queryClient.clear();
    container.remove();
    mock.restore();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
