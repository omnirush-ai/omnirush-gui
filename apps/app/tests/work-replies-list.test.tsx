/** @jsxImportSource react */
// The Work transcript with suggested replies (design 3.5, judge M4): one streamed token re-renders only the newest group
// (and would re-render every group if the transform made new objects); the row shows only under the newest finished
// answer; copy and quote read the text without the block; a Code chat (no provider, no transform) shows the block as text.
import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { UIMessage } from "ai";

const draft = "Here is the draft to Dana:\n\n> Hi Dana, the new rate starts on 1 December.\n\nShall I send it?";
const block = "<replies>\nSend it\nMake it shorter\nMore formal\n</replies>";
const shorter = "Here is a shorter one:\n\n> Hi Dana, new rate from 1 Dec.\n\nShall I send it?";

// The chat surface passes a stable list (a new one each render would re-render every group through the context).
const NO_IDENTITIES: never[] = [];
const user = (id: string, text: string): UIMessage => ({ id, role: "user", metadata: { opencode: { created: 1_000 } }, parts: [{ type: "text", text }] });
const assistant = (id: string, text: string, state: "streaming" | "done" = "done"): UIMessage => ({
  id,
  role: "assistant",
  metadata: { opencode: { created: 2_000, ...(state === "done" ? { completed: 3_000 } : {}) } },
  parts: [{ type: "text", text, state }],
});

test("Work transcript: memoized groups while streaming, the row under the newest answer, copy and quote without the block, Code untouched", async () => {
  const renders = new Map<string, number>();
  mock.module("@/react-app/shell/dev-profiler", () => ({
    DevProfiler: ({ id, children }: { id: string; children: unknown }) => {
      if (id.startsWith("MessageGroup:")) renders.set(id, (renders.get(id) ?? 0) + 1);
      return children;
    },
    DevProfilerOverlay: () => null,
    useDevProfilerSnapshot: () => ({ zones: [], recent: [], totalCommits: 0, totalActualMs: 0 }),
  }));
  const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
  if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  const [{ MessageList }, { MessageListProvider }, { WorkRepliesContext }, replies, { PlatformProvider, createDefaultPlatform }, { useComposerStateStore }] = await Promise.all([
    import("../src/components/chat/message-list"),
    import("../src/components/chat/message-list-provider"),
    import("../src/react-app/domains/work/ask/reply-row"),
    import("../src/react-app/domains/work/ask/replies"),
    import("../src/react-app/kernel/platform"),
    import("../src/react-app/domains/session/surface/composer-state-store"),
  ]);
  const { NO_SIGNALS } = await import("../src/react-app/domains/work/ask/action-chips");
  const queryClient = new QueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const sent: string[] = [];
  const render = (messages: UIMessage[], status: "streaming" | "ready", work: boolean, raw: UIMessage[] = messages) => act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PlatformProvider value={createDefaultPlatform()}>
          <MessageListProvider
            workspaceId="ws"
            sessionId="ses_work"
            showThinking={false}
            developerMode={false}
            connectorIdentities={NO_IDENTITIES}
            dispatchAction={() => {}}
            setPrompt={() => {}}
            onRevertToUserMessage={() => {}}
            onForkAtMessage={() => {}}
            onEditUserMessage={() => {}}
            onMcpReconnect={() => Promise.reject(new Error("unused"))}
            onMcpReopenAuthorization={() => Promise.resolve()}
            onMcpRetry={() => {}}
          >
            <WorkRepliesContext.Provider value={work ? {
              show: true,
              replies: replies.lastAnswerReplies(raw),
              signals: NO_SIGNALS,
              client: null,
              onSend: (text) => { sent.push(text); },
              onFill: () => {},
            } : null}>
              <MessageList messages={messages} status={status} activityStatus={status === "streaming" ? "responding" : "idle"} />
            </WorkRepliesContext.Provider>
          </MessageListProvider>
        </PlatformProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
  const rows = () => Array.from(container.querySelectorAll("[data-testid='work-replies']"));
  const chips = () => Array.from(container.querySelectorAll<HTMLButtonElement>("[data-testid='work-reply-chips'] [data-suggestion-chip]")).map((chip) => chip.textContent?.trim());
  const transcript = () => Array.from(container.querySelectorAll("[data-message-role='assistant']")).map((el) => el.textContent ?? "").join("\n");
  const groupOf = (messageId: string) => container.querySelector(`[data-message-id='${messageId}']`)?.closest(".group\\/message-group") ?? null;

  try {
    const display = replies.createRepliesDisplay();
    const u1 = user("u1", "Draft a reply to Dana");
    const a1 = assistant("a1", `${draft}\n${block}`);
    const u2 = user("u2", "Make it shorter");
    const a2 = assistant("a2", `${shorter}\n<rep`, "streaming");

    // Streaming: the block's tag still coming in is hidden; no row anywhere (the newest group streams).
    await render(display([u1, a1, u2, a2], true), "streaming", true);
    expect(transcript()).not.toContain("<re");
    expect(transcript()).not.toContain("More formal");
    expect(rows()).toHaveLength(0);
    const a1Renders = renders.get("MessageGroup:a1") ?? 0;
    const a2Renders = renders.get("MessageGroup:a2") ?? 0;
    expect(a1Renders).toBeGreaterThan(0);

    // One more token (a new object for the streaming message only, as the sync layer delivers it).
    const a2Next = assistant("a2", `${shorter}\n<replies>\nSend`, "streaming");
    await render(display([u1, a1, u2, a2Next], true), "streaming", true);
    expect(renders.get("MessageGroup:a1")).toBe(a1Renders);
    expect(renders.get("MessageGroup:a2")).toBeGreaterThan(a2Renders);
    expect(transcript()).not.toContain("<replies");

    // The same token through a transform that makes new objects every time would re-render the older group too.
    const naive = (messages: UIMessage[]) => messages.map((message) => replies.hideRepliesBlock({ ...message }, message === messages.at(-1)));
    const a2Again = assistant("a2", `${shorter}\n<replies>\nSend it`, "streaming");
    await render(naive([u1, a1, u2, a2Again]), "streaming", true);
    expect(renders.get("MessageGroup:a1")).toBeGreaterThan(a1Renders);

    // Done: the row shows once, under the newest answer only, with its replies; the older answer keeps none.
    const a2Done = assistant("a2", `${shorter}\n<replies>\nSend it\nAdd the new rate\n</replies>`);
    // The replies come from the stored text (the chat surface reads them before the transform).
    await render(display([u1, a1, u2, a2Done], false), "ready", true, [u1, a1, u2, a2Done]);
    expect(rows()).toHaveLength(1);
    expect(groupOf("a2")?.contains(rows()[0]!)).toBe(true);
    expect(groupOf("a1")?.contains(rows()[0]!)).toBe(false);
    expect(chips()).toEqual(["Send it", "Add the new rate"]);
    expect(transcript()).not.toContain("<replies");
    await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='work-reply-chips'] [data-suggestion-chip]")!.click());
    expect(sent).toEqual(["Send it"]);

    // Copy and quote read the text the transcript shows.
    const lastGroup = groupOf("a2")!;
    await act(async () => lastGroup.querySelector<HTMLButtonElement>("button[aria-label='Copy message']")?.click());
    expect(copied.at(-1)).toContain("Here is a shorter one");
    expect(copied.at(-1)).not.toContain("replies");
    expect(copied.at(-1)).not.toContain("Add the new rate");
    await act(async () => lastGroup.querySelector<HTMLButtonElement>("[data-testid='quote-reply']")?.click());
    const quoted = useComposerStateStore.getState().sessions.ses_work?.pasteParts ?? [];
    expect(quoted.length).toBe(1);
    expect(quoted[0]!.text).toContain("Shall I send it?");
    expect(quoted[0]!.text).not.toContain("replies");

    // A Code chat: no provider and no transform, so the block renders as the answer's own text (as before) and no row shows.
    await render([u1, a1, u2, a2Done], "ready", false);
    expect(rows()).toHaveLength(0);
    expect(transcript()).toContain("More formal");
    expect(transcript()).toContain("Add the new rate");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useComposerStateStore.setState({ sessions: {} });
    mock.restore();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
