/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionGoal, SessionGoalCommand } from "@omnirush/types";
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
  window.localStorage.setItem("omnirush.shell-config", JSON.stringify({ starterCards: false }));
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
  }));
  const { SessionSurface } = await import("../src/react-app/domains/session/surface/session-surface");
  const { snapshotKey, statusKey } = await import("../src/react-app/domains/session/sync/session-sync");
  const { composerAutoSendScopeKey, markComposerAutoSend } = await import("../src/react-app/domains/session/surface/composer-auto-send");
  const { claimComposerSessionDraftScope } = await import("../src/react-app/domains/session/surface/composer-state-store");
  const { saveSessionDraft, sessionDraftScopeKey, getSessionDraft } = await import("../src/react-app/domains/session/sync/draft-store");
  const queryClient = getReactQueryClient();
  queryClient.clear();
  const key = snapshotKey(workspaceId, sessionId);
  queryClient.setQueryDefaults(key, { retryDelay: 0 });
  queryClient.setQueryData(key, createSnapshot(sessionId));
  let serverGoal: SessionGoal | null = null;
  const goalCommands: SessionGoalCommand[] = [];
  let holdNextGoalCommand = false;
  let releaseGoalCommand: (() => void) | null = null;
  const client = {
    ...createOmniRushServerClient({ baseUrl: "http://127.0.0.1:1", token: "test-token" }),
    getSessionGoal: async () => ({ goal: serverGoal }),
    commandSessionGoal: async (_workspace: string, _session: string, command: SessionGoalCommand) => {
      goalCommands.push(command);
      if (command.action === "set") serverGoal = {
        id: "goal-composer", sessionId, objective: command.objective ?? "", status: "active",
        tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
      };
      if (command.action === "pause" && serverGoal) serverGoal = { ...serverGoal, status: "paused" };
      if (holdNextGoalCommand) {
        holdNextGoalCommand = false;
        await new Promise<void>((resolve) => { releaseGoalCommand = resolve; });
      }
      return { goal: serverGoal };
    },
  };
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
              listCommands={async () => [{ id: "builtin:goal", name: "goal", source: "command", description: "Set a goal and keep working until it is complete." }]}
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

    // The goal may be visible before its command response completes.
    // Completing that response must preserve every newer composer edit.
    holdNextGoalCommand = true;
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "/goal Finish the report"));
    await waitFor(() => editorText() === "/goal Finish the report", "the goal draft");
    await act(async () => runTask()?.click());
    await waitFor(() => goalCommands.length === 1, "held goal command");
    await act(async () => queryClient.setQueryData(["session-goal", client.baseUrl, workspaceId, sessionId], { goal: serverGoal }));
    await waitFor(() => container.querySelector('[data-testid="session-goal"]') !== null, "goal visible before response");
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "/goal PAUSE"));
    await waitFor(() => editorText() === "/goal PAUSE", "the next goal control draft");
    await act(async () => { releaseGoalCommand?.(); });
    await waitFor(() => container.querySelector<HTMLButtonElement>('[data-testid="goal-pause"]')?.disabled === false, "goal command finished");
    expect(composerState()?.draft).toBe("/goal PAUSE");
    expect(editorText()).toBe("/goal PAUSE");

    holdNextGoalCommand = true;
    await act(async () => runTask()?.click());
    await waitFor(() => goalCommands.length === 2, "held pause command");
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "A newer edit"));
    await waitFor(() => editorText() === "A newer edit", "a changed draft while pause is pending");
    await act(async () => useComposerStateStore.getState().setDraft(sessionId, "/goal PAUSE"));
    await waitFor(() => editorText() === "/goal PAUSE", "a newer draft with the same text");
    await act(async () => { releaseGoalCommand?.(); });
    await waitFor(() => container.querySelector('[data-testid="goal-status"]')?.getAttribute("data-goal-status") === "paused", "pause command finished");
    expect(composerState()?.draft).toBe("/goal PAUSE");
    expect(editorText()).toBe("/goal PAUSE");

    serverGoal = null;
    await act(async () => queryClient.setQueryData(["session-goal", client.baseUrl, workspaceId, sessionId], { goal: null }));
    const popupGoal = () => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Set a goal and keep working until it is complete."));
    const press = (key: string) => act(async () => {
      container.querySelector('[data-lexical-editor="true"]')?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    const goalInput = () => document.querySelector<HTMLTextAreaElement>('[data-testid="goal-objective-input"]');
    for (const key of ["Tab", "Enter"]) {
      await act(async () => useComposerStateStore.getState().setDraft(sessionId, "/go"));
      await waitFor(() => popupGoal() !== undefined, "partial goal popup");
      await press(key);
      await waitFor(() => composerState()?.draft === "/goal ", "partial goal selection");
      expect(goalInput()).toBeNull();
    }
    for (const status of ["idle", "busy"]) {
      await act(async () => {
        queryClient.setQueryData(statusKey(workspaceId, sessionId), { type: status });
        useComposerStateStore.getState().setDraft(sessionId, "/goal");
      });
      await waitFor(() => editorText() === "/goal" && popupGoal() !== undefined, "exact goal popup");
      await press("Enter");
      await waitFor(() => goalInput() !== null, `bare goal editor while ${status}`);
      expect(goalInput()?.value).toBe("");
      expect(goalCommands).toHaveLength(2);
      expect(useComposerStateStore.getState().queuedDrafts[sessionId]?.length ?? 0).toBe(0);
      await act(async () => goalInput()?.closest("form")?.querySelector<HTMLButtonElement>('button[type="button"]')?.click());
      await waitFor(() => goalInput() === null, "goal editor closed");
    }
  } finally {
    releaseGoalCommand?.();
    await act(async () => root.unmount());
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, history: {}, pendingMessages: {}, failedDrafts: {} });
    queryClient.clear();
    container.remove();
    mock.restore();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
}, 15_000);

test("active goals follow picker changes without restarting paused goals or reviving a cleared goal", async () => {
  const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
  if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const { createOmniRushServerClient } = await import("../src/app/lib/omnirush-server");
  const { useSessionGoal } = await import("../src/react-app/domains/session/surface/session-goal");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const baseClient = createOmniRushServerClient({ baseUrl: "http://goal-selection.test" });
  const initial: SessionGoal = {
    id: "goal-selection-original", sessionId, objective: "Finish this goal", status: "active",
    tokenBudget: 1_000, tokensUsed: 25, timeUsedSeconds: 10, createdAt: 1, updatedAt: 1,
  };
  let serverGoal: SessionGoal | null = initial;
  const commands: SessionGoalCommand[] = [];
  let holdNextSelect = false;
  let releaseSelect: (() => void) | null = null;
  const client = {
    ...baseClient,
    getSessionGoal: async (_workspace: string, target: string) => ({ goal: target === sessionId ? serverGoal : null }),
    commandSessionGoal: async (_workspace: string, _session: string, command: SessionGoalCommand) => {
      commands.push(command);
      if (command.action === "select" && holdNextSelect) {
        holdNextSelect = false;
        await new Promise<void>((resolve) => { releaseSelect = resolve; });
      }
      if (command.action === "clear") serverGoal = null;
      return { goal: serverGoal };
    },
  };
  const key = ["session-goal", client.baseUrl, workspaceId, sessionId];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Harness(props: { agent: string | null; model: string; variant: string | null; session?: string }) {
    return useSessionGoal({
      client, workspaceId, sessionId: props.session ?? sessionId,
      model: { providerID: "test", modelID: props.model },
      agent: props.agent, variant: props.variant, observedAt: 0,
    }).ui;
  }
  const render = (agent: string | null, model = "first", variant: string | null = null, session = sessionId) => act(async () => {
    root.render(<QueryClientProvider client={queryClient}><Harness agent={agent} model={model} variant={variant} session={session} /></QueryClientProvider>);
  });
  const settle = () => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 30)); });
  try {
    await render(null);
    await waitFor(() => container.querySelector('[data-testid="session-goal"]') !== null, "initial goal");
    expect(commands).toHaveLength(0);

    await render("plan");
    await waitFor(() => commands.length === 1, "Plan selection");
    expect(commands[0]).toMatchObject({ action: "select", goalId: initial.id, agent: "plan", variant: "" });
    await settle();
    expect(commands).toHaveLength(1);

    await render(null, "second", "high");
    await waitFor(() => commands.length === 2, "Build selection");
    expect(commands[1]).toMatchObject({ action: "select", goalId: initial.id, agent: "build", model: { providerID: "test", modelID: "second" }, variant: "high" });
    await render(null, "second", null);
    await waitFor(() => commands.length === 3, "cleared model variant");
    expect(commands[2]?.variant).toBe("");

    serverGoal = { ...initial, status: "paused" };
    await act(async () => queryClient.setQueryData(key, { goal: serverGoal }));
    await render("plan", "third");
    await settle();
    expect(commands).toHaveLength(3);
    expect(container.querySelector('[data-testid="goal-status"]')?.getAttribute("data-goal-status")).toBe("paused");

    serverGoal = { ...initial, id: "goal-selection-new" };
    await act(async () => queryClient.setQueryData(key, { goal: serverGoal }));
    await settle();
    expect(commands).toHaveLength(3);
    holdNextSelect = true;
    await render(null, "third");
    await waitFor(() => commands.length === 4, "held selection mutation");
    expect(commands[3]?.goalId).toBe("goal-selection-new");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="goal-clear"]')?.click());
    await render("plan", "third");
    expect(commands).toHaveLength(4);
    await act(async () => { releaseSelect?.(); });
    await waitFor(() => commands.length === 5 && commands[4]?.action === "clear", "clear follows in-flight selection");
    await waitFor(() => container.querySelector('[data-testid="session-goal"]') === null, "cleared goal stays absent");
    await settle();
    expect(serverGoal).toBeNull();
    expect(commands).toHaveLength(5);
    expect(queryClient.getQueryData(key)).toEqual({ goal: null });

    await render(null, "first", null, "other-session");
    await settle();
    expect(container.querySelector('[data-testid="session-goal"]')).toBeNull();
    expect(commands).toHaveLength(5);
  } finally {
    releaseSelect?.();
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
