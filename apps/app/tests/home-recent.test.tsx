/** @jsxImportSource react */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { ComposerAttachment } from "../src/app/types";
import type { SearchableSession } from "../src/react-app/domains/session/search/session-search";

const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => {
  mock.restore();
  if (registered) await GlobalRegistrator.unregister();
});

// The start screen's composer stands in as a send button that keeps how the hero's submit settled.
let settled: Promise<unknown> | null = null;
mock.module("../src/react-app/domains/session/chat/new-task-composer", () => ({
  NewTaskComposer: (props: { onRunTask: (prompt: string, attachments: ComposerAttachment[]) => void | Promise<void> }) => (
    <button type="button" data-testid="composer" onClick={() => { settled = Promise.resolve(props.onRunTask("Fix it", [])).catch((error) => error); }} />
  ),
}));
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({ useCheckDesktopRestriction: () => () => false }));
mock.module("../src/react-app/domains/buildathon/buildathon-promo", () => ({ BuildathonPromoCard: () => null }));
mock.module("../src/react-app/domains/placements/placements", () => ({ PlacementHomeCard: () => null }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { HomeContinue } = await import("../src/react-app/domains/session/home/home-recent");
const { SessionEmptyHero } = await import("../src/react-app/domains/session/chat/session-empty-hero");
const { homeChatTitle, recentChats } = await import("../src/react-app/domains/session/home/home-view-model");

const now = Date.now();
const sessions: SearchableSession[] = [
  { workspaceId: "ws_app", sessionId: "ses_a1", title: "Fix the login redirect", workspaceTitle: "app", updatedAt: now - 60_000 },
  { workspaceId: "ws_site", sessionId: "ses_s1", title: "New session", workspaceTitle: "site", updatedAt: now - 120_000 },
  { workspaceId: "ws_site", sessionId: "ses_s2", title: "New session - 2026-10-19T10:00:00.000Z", workspaceTitle: "site", updatedAt: now - 180_000 },
  { workspaceId: "ws_app", sessionId: "ses_a0", title: "Older chat", workspaceTitle: "app", updatedAt: now - 3_600_000 },
  { workspaceId: "ws_task", sessionId: "ses_t1", title: "Add a greeting", workspaceTitle: "app › add-a-greeting-ab12", updatedAt: now - 30_000 },
];
const workspaces = [
  { id: "ws_app", name: "app", task: false },
  { id: "ws_site", name: "site", task: false },
  { id: "ws_task", name: "app › add-a-greeting-ab12", task: true },
];

describe("home view model", () => {
  test("recent chats are newest first across workspaces", () => {
    expect(recentChats(sessions).map((s) => s.sessionId)).toEqual(["ses_t1", "ses_a1", "ses_s1", "ses_s2", "ses_a0"]);
  });

  test("titles are one line of at most 72 characters", () => {
    expect(homeChatTitle("  Fix   it ")).toBe("Fix it");
    expect(homeChatTitle("x".repeat(80))).toBe(`${"x".repeat(69)}…`);
  });
});

describe("start screen row", () => {
  test("a quiet row: at most three recent chats to continue (task copies and untitled chats left out) and the chat search", async () => {
    const opened: string[] = [];
    let searched = 0;
    document.body.innerHTML = "<div id=root></div>";
    const root = createRoot(document.getElementById("root")!);
    await act(async () => {
      root.render(<HomeContinue context={{ sessions, workspaces, onOpenSession: (w, s) => opened.push(`${w}/${s}`), onOpenSearch: () => { searched += 1; } }} />);
    });
    // One line: no section headers, project cards or long lists on the start screen.
    expect(document.querySelector("[data-testid=home-continue]")!.className).not.toContain("flex-wrap");
    expect(document.querySelector("h3")).toBeNull();
    expect(document.querySelector("[data-testid=home-project]")).toBeNull();
    const chats = [...document.querySelectorAll<HTMLButtonElement>("[data-testid=home-chat]")];
    expect(chats.map((c) => c.textContent)).toEqual([
      expect.stringContaining("Fix the login redirect"),
      expect.stringContaining("Older chat"),
    ]);
    expect(chats[0]!.textContent).toContain("app");
    expect(chats[0]!.getAttribute("aria-label")).toBe("Continue Fix the login redirect in app");
    await act(async () => { chats[1]!.click(); });
    expect(opened).toEqual(["ws_app/ses_a0"]);
    await act(async () => { document.querySelector<HTMLButtonElement>("[data-testid=home-search]")!.click(); });
    expect(searched).toBe(1);
    await act(async () => root.unmount());
  });

  test("before the first chat the row is not shown at all (the hero stays as it was)", async () => {
    document.body.innerHTML = "<div id=root></div>";
    const root = createRoot(document.getElementById("root")!);
    await act(async () => {
      root.render(<HomeContinue context={{ sessions: [], workspaces, onOpenSession: () => undefined, onOpenSearch: () => undefined }} />);
    });
    expect(document.querySelector("[data-testid=home-continue]")).toBeNull();
    await act(async () => root.unmount());
  });
});

describe("start screen layout", () => {
  test("greeting and composer front and center with Continue under them; a send glides the composer to the chat's width", async () => {
    let creation = Promise.withResolvers<void>();
    document.body.innerHTML = "<div id=root></div>";
    const root = createRoot(document.getElementById("root")!);
    await act(async () => {
      root.render(<SessionEmptyHero providerCount={1} home={{ sessions, workspaces, onOpenSession: () => undefined }} onRunTask={() => creation.promise} />);
    });
    const column = () => document.querySelector<HTMLElement>("[data-testid=home-column]")!;
    const continueRow = () => document.querySelector("[data-testid=home-continue]");
    const send = () => document.querySelector<HTMLButtonElement>("[data-testid=composer]")!.click();

    // Greeting and composer share the 640 column; the Continue line follows it, in a 640 column of its own.
    expect(column().className).toContain("max-w-[640px]");
    expect(column().querySelector("h2")).not.toBeNull();
    expect(column().querySelector("[data-testid=composer]")).not.toBeNull();
    expect(continueRow()!.closest(".max-w-\\[640px\\]")).not.toBeNull();
    expect(column().compareDocumentPosition(continueRow()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Sending: the column takes the chat composer's width and the Continue line steps aside.
    await act(async () => send());
    expect(column().className).toContain("max-w-[800px]");
    expect(continueRow()).toBeNull();

    // A failed start brings the home back and still hands the error to the composer.
    await act(async () => {
      creation.reject(new Error("engine restarting"));
      await settled;
    });
    expect(await settled).toBeInstanceOf(Error);
    expect(column().className).toContain("max-w-[640px]");
    expect(continueRow()).not.toBeNull();

    // A start that opened its chat leaves the composer in the chat's place.
    creation = Promise.withResolvers<void>();
    await act(async () => send());
    await act(async () => {
      creation.resolve();
      await settled;
    });
    expect(column().className).toContain("max-w-[800px]");
    await act(async () => root.unmount());
  });
});
