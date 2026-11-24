/** @jsxImportSource react */
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";

const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => {
  delete (window as { __OMNIRUSH_ELECTRON__?: unknown }).__OMNIRUSH_ELECTRON__;
  if (registered) await GlobalRegistrator.unregister();
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter, Route, Routes } = await import("react-router");
const { WorkSignInChoice, WorkSignInListener } = await import("../src/react-app/domains/work/work-signin");
const { useWorkModeStore, useWorkSignInRequest } = await import("../src/react-app/domains/work/work-mode");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
type Call = { command: string; args: unknown[] };

function desktop(connect: () => Promise<unknown>) {
  const calls: Call[] = [];
  (window as { __OMNIRUSH_ELECTRON__?: unknown }).__OMNIRUSH_ELECTRON__ = {
    invokeDesktop: async (command: string, ...args: unknown[]) => {
      calls.push({ command, args });
      if (command === "omnirushAccountConnect") return connect();
      if (command === "omnirushAccountStatus") return { connected: true, gatewayConfigured: true, email: "owner@atlas.example" };
      return null;
    },
  };
  return calls;
}

async function mount(node: ReactNode) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById("root")!);
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queries}>
        <MemoryRouter initialEntries={["/session"]}>
          <Routes>
            <Route path="/session" element={node} />
            <Route path="/work" element={<div data-testid="work-home">Work</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await tick();
  });
  return root;
}

describe("desktop Work sign-in entry point", () => {
  test("the web build shows no choice (it has the welcome page)", async () => {
    delete (window as { __OMNIRUSH_ELECTRON__?: unknown }).__OMNIRUSH_ELECTRON__;
    const root = await mount(<WorkSignInChoice />);
    expect(document.querySelector('[data-testid="work-signin-choice"]')).toBeNull();
    await act(async () => root.unmount());
  });

  test("Sign in to OmniRush Work starts the company sign-in and lands in Work", async () => {
    const calls = desktop(async () => ({ connected: true }));
    useWorkModeStore.getState().setMode("code");
    const root = await mount(<WorkSignInChoice />);
    const button = document.querySelector<HTMLButtonElement>('[data-testid="work-signin-choice"]')!;
    expect(button.textContent).toBe("Sign in to OmniRush Work");
    await act(async () => { button.click(); await tick(); await tick(); });
    const connect = calls.find((call) => call.command === "omnirushAccountConnect");
    expect(connect?.args[0]).toEqual({ surface: "work" });
    expect(useWorkModeStore.getState().mode).toBe("work");
    expect(document.querySelector('[data-testid="work-home"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  test("a sign-in that does not finish says what to do next", async () => {
    desktop(async () => { throw new Error("denied"); });
    const root = await mount(<WorkSignInChoice />);
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="work-signin-choice"]')!.click(); await tick(); await tick(); });
    expect(document.querySelector('[data-testid="work-signin-error"]')?.textContent).toBe("Sign-in didn't finish. Try again.");
    expect(document.querySelector('[data-testid="work-home"]')).toBeNull();
    await act(async () => root.unmount());
  });

  test("omnirush://work/signin starts it on the desktop too", async () => {
    const calls = desktop(async () => ({ connected: true }));
    const root = await mount(<WorkSignInListener />);
    await act(async () => { useWorkSignInRequest.getState().setRequested(true); await tick(); await tick(); });
    expect(calls.some((call) => call.command === "omnirushAccountConnect" && JSON.stringify(call.args[0]) === '{"surface":"work"}')).toBe(true);
    expect(useWorkSignInRequest.getState().requested).toBe(false);
    expect(document.querySelector('[data-testid="work-home"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  test("the choice sits next to every desktop sign-in, and the listener is mounted app-wide", () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source("../src/react-app/domains/session/sidebar/account-status-menu.tsx")).toContain("<WorkSignInChoice />");
    expect(source("../src/react-app/domains/settings/pages/general-view.tsx")).toMatch(/!account\.connected \? <WorkSignInChoice/);
    expect(source("../src/react-app/shell/app-root.tsx")).toContain("<WorkSignInListener />");
  });
});
