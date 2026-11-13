/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRequire } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";

const workspaceId = "workspace-missing-chat";

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** The error a native read throws for the engine's 404 on a session it does not have. */
function missingSessionError(sessionId: string) {
  return Object.assign(
    new Error(JSON.stringify({ name: "NotFoundError", data: { message: `Session not found: ${sessionId}` } })),
    { status: 404, code: "session_not_found", sessionMissing: true },
  );
}

test("a listed chat the engine does not have is handed back to the shell instead of a dead end", async () => {
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
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  document.open();
  document.write("<!doctype html><html><body></body></html>");
  document.close();
  Object.defineProperty(document, "compatMode", { configurable: true, value: "CSS1Compat" });
  const fetchStub = async () => new Response("{}", { headers: { "content-type": "application/json" } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchStub });
  Object.defineProperty(window, "fetch", { configurable: true, value: fetchStub });

  // Per session: what the snapshot read and the confirming read answer.
  const snapshotError: Record<string, Error> = {};
  const confirmError: Record<string, Error | null> = {};
  mock.module("@/components/model-select", () => ({ ModelSelect: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/workspace-run-mode-menu", () => ({ WorkspaceRunModeMenu: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/full-permissions-toggle", () => ({ FullPermissionsToggle: () => null }));
  mock.module("@/react-app/domains/session/surface/composer/subagent-model-menu", () => ({ SubagentModelMenu: () => null }));
  mock.module("@/app/lib/opencode-session-native", () => ({
    composeNativeSessionSnapshot: async (_endpoint: unknown, sessionId: string) => {
      throw snapshotError[sessionId] ?? new Error("unexpected snapshot read");
    },
    getNativeSession: async (_endpoint: unknown, sessionId: string) => {
      const error = confirmError[sessionId];
      if (error) throw error;
      return { id: sessionId };
    },
    isMissingSessionError: (error: unknown) =>
      error instanceof Error && "sessionMissing" in error && error.sessionMissing === true,
  }));
  const { SessionSurface } = await import("../src/react-app/domains/session/surface/session-surface");
  const { snapshotKey } = await import("../src/react-app/domains/session/sync/session-sync");
  const queryClient = getReactQueryClient();
  queryClient.clear();
  const client = createOmniRushServerClient({ baseUrl: "http://127.0.0.1:1", token: "test-token" });
  const missing: Array<[string, string]> = [];

  const surface = (sessionId: string) => (
    <QueryClientProvider client={queryClient}>
      <LocalProvider>
        <ShellConfigProvider>
          <SessionSurface
            client={client}
            workspaceId={workspaceId}
            workspaceRoot="/tmp/project-missing-chat"
            sessionId={sessionId}
            draftScope="local"
            isControlTarget={false}
            opencodeBaseUrl="http://127.0.0.1:1/opencode"
            omnirushToken="test-token"
            developerMode={false}
            modelLabel="Test model"
            onModelClick={() => {}}
            modelPickerOpen={false}
            selectedModel={{ providerID: "test", modelID: "test-model" }}
            onModelPickerOpenChange={() => {}}
            onModelChange={() => {}}
            onSendDraft={async () => ({ outcome: "accepted" })}
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
            onSessionMissing={(workspace, session) => missing.push([workspace, session])}
          />
        </ShellConfigProvider>
      </LocalProvider>
    </QueryClientProvider>
  );

  const containers: HTMLDivElement[] = [];
  const roots: ReturnType<typeof createRoot>[] = [];
  const mount = async (sessionId: string) => {
    queryClient.setQueryDefaults(snapshotKey(workspaceId, sessionId), { retry: false, retryDelay: 0 });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    containers.push(container);
    roots.push(root);
    await act(async () => root.render(surface(sessionId)));
    return container;
  };
  const settle = () => act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
  });

  try {
    // Gone: the snapshot read and the confirming read both say so.
    snapshotError.ses_gone = missingSessionError("ses_gone");
    confirmError.ses_gone = missingSessionError("ses_gone");
    const gone = await mount("ses_gone");
    await waitFor(() => missing.length > 0, "the shell to be told the chat is missing");
    expect(missing).toEqual([[workspaceId, "ses_gone"]]);
    await waitFor(() => gone.textContent?.includes("no longer available") === true, "the readable notice");
    expect(gone.textContent).not.toContain("NotFoundError");

    // Back by the confirming read (e.g. carried over meanwhile): not dropped.
    snapshotError.ses_back = missingSessionError("ses_back");
    confirmError.ses_back = null;
    await mount("ses_back");
    await waitFor(() => queryClient.getQueryState(snapshotKey(workspaceId, "ses_back"))?.status === "error", "the failed read");
    await settle();

    // Any other failure (engine restarting, bare 404) never drops a chat.
    snapshotError.ses_restarting = Object.assign(new Error("OmniRush request failed"), { status: 503, code: "opencode_engine_unreachable" });
    snapshotError.ses_bare = Object.assign(new Error("404 Not Found"), { status: 404, code: "session_not_found" });
    const restarting = await mount("ses_restarting");
    await mount("ses_bare");
    await waitFor(() => queryClient.getQueryState(snapshotKey(workspaceId, "ses_bare"))?.status === "error", "the bare 404");
    await settle();
    expect(missing).toEqual([[workspaceId, "ses_gone"]]);
    expect(restarting.textContent).not.toContain("no longer available");
  } finally {
    await act(async () => {
      for (const root of roots) root.unmount();
    });
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, history: {} });
    queryClient.clear();
    for (const container of containers) container.remove();
    mock.restore();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
