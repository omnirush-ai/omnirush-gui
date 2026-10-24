/** @jsxImportSource react */
import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const toasts: string[] = [];
mock.module("@/components/ui/sonner", () => ({ toast: (message: string) => toasts.push(message) }));

if (typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined") {
  GlobalRegistrator.register({ url: "http://localhost/" });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const { SandboxStatusChip, PINNED_CHAT_TOGGLE_NOTE } = await import("../src/react-app/domains/session/surface/composer/sandbox-status-chip");

// Backend #505 at level "offer": the box is off until the person turns it on; per-model starts.
function fakeClient(chatPin: { box: boolean; revision: string | null } | null = null) {
  const modes: Array<string | null> = [];
  const box = {
    mode: null, serverDefault: "offer", on: false, source: "server", offer: true, error: null, state: "off",
    modelStart: { "gpt-6-astra": { start: "native", switchable: true }, "kimi-k3.1-pro": { start: "native", switchable: false } },
    revision: "lb1:5050a1b2c3d4", chatPin,
  };
  const client = {
    getWorkspaceBox: async () => box,
    setWorkspaceBox: async (_id: string, mode: "on" | "off" | null) => { modes.push(mode); return { ...box, on: mode === "on" }; },
    setWorkspaceBoxBackend: async () => box,
    resetWorkspaceBox: async () => box,
    retryWorkspaceBox: async () => box,
  };
  return { client: client as never, modes };
}

const mounted: { root: Root; container: HTMLElement }[] = [];
async function mount(ui: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(ui));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return container;
}
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  toasts.length = 0;
});

test("a model the server says cannot be switched shows no sandbox toggle; a switchable one shows the offer (off by default)", async () => {
  const kimi = await mount(<SandboxStatusChip client={fakeClient().client} workspaceId="ws" model="kimi-k3.1-pro" />);
  expect(kimi.querySelector('[data-testid="sandbox-offer-accept"]')).toBeNull();
  expect(kimi.textContent).toBe("");
  const astra = await mount(<SandboxStatusChip client={fakeClient().client} workspaceId="ws" model="gpt-6-astra" />);
  expect(astra.querySelector('[data-testid="sandbox-offer-accept"]')?.textContent).toContain("Use sandbox");
});

test("turning the sandbox on in a started chat applies to new chats; this chat keeps where it started", async () => {
  const { client, modes } = fakeClient({ box: false, revision: "lb1:5050a1b2c3d4" });
  const container = await mount(<SandboxStatusChip client={client} workspaceId="ws" sessionId="ses_started" model="gpt-6-astra" />);
  await act(async () => { container.querySelector<HTMLElement>('[data-testid="sandbox-offer-accept"]')!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(modes).toEqual(["on"]);
  expect(toasts).toEqual([PINNED_CHAT_TOGGLE_NOTE]);
});
