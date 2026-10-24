/** @jsxImportSource react */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";

const registered = typeof globalThis.document === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });

// The pure rule, without the module's app imports (they read window at load).
const claudeSurface = (allowed: boolean, saved: number) => (allowed ? "full" : saved > 0 ? "saved" : "none");


let status = { allowed: false, sandboxReady: true };
let sessions: unknown[] = [];
// Stable, as the real boot state is (a new function each render would re-run the route's effects forever).
const bootState = { markRouteReady: () => {} };
mock.module("../src/react-app/shell/boot-state", () => ({ useBootState: () => bootState }));
const connection = {
  pending: false,
  endpoint: {
    signal: new AbortController().signal,
    workspaceId: "ws",
    client: { claude: { request: async (_ws: string, route: string) => (route === "status" ? status : route === "sessions" ? sessions : []) } },
  },
};
mock.module("../src/react-app/shell/claude-offer", () => ({
  claudeSurface,
  useClaudeEndpoint: () => connection,
}));

async function renderRoute(): Promise<string> {
  const { ClaudeRoute } = await import("../src/react-app/shell/claude-route");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={["/workspace/ws/claude"]}><Routes><Route path="/workspace/:workspaceId/claude" element={<ClaudeRoute />} /></Routes></MemoryRouter>);
  });
  for (let i = 0; i < 50 && container.querySelector("[aria-busy]"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const text = container.textContent ?? "";
  await act(async () => root.unmount());
  container.remove();
  return text;
}

describe("the /claude route", () => {
  const T = 60_000;
  test("off and nothing saved: no Claude content, only 'not available'", async () => {
    status = { allowed: false, sandboxReady: true }; sessions = [];
    const text = await renderRoute();
    expect(text).toContain("This page is not available.");
    expect(text).not.toMatch(/claude|opus|pilot|selected accounts/i);
  }, T);

  test("off with a saved session: a plain saved-sessions view, no new-session control, no advertising", async () => {
    status = { allowed: false, sandboxReady: true };
    sessions = [{ id: "s1", createdAt: "2026-10-24T00:00:00Z", model: "m", capture: "ok", replay: "ok", issues: [], turns: [] }];
    const text = await renderRoute();
    expect(text).toContain("Saved sessions");
    expect(text).not.toMatch(/New Claude session|selected accounts|Opus|pilot/i);
  }, T);

  test("on: the Claude Code page with its new-session control", async () => {
    status = { allowed: true, sandboxReady: true }; sessions = [];
    const text = await renderRoute();
    expect(text).toContain("Claude Code");
    expect(text).toContain("New Claude session");
  }, T);
});

test("native Claude save sends host authority and aborts the same registered transfer", async () => {
  const {createOmniRushServerClient} = await import("../src/app/lib/omnirush-server");
  const controller = new AbortController();
  const commands: Array<{command: string; input: unknown}> = [];
  let refuseExport = false;
  let rejectDownload: (error: Error) => void = () => { throw new Error("Download was not started"); };
  const pending = new Promise((_resolve, reject) => { rejectDownload = reject; });
  const previous = Object.getOwnPropertyDescriptor(window, "__OMNIRUSH_ELECTRON__");
  Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", {configurable: true, value: {
    invokeDesktop(command: string, input: unknown) {
      commands.push({command, input});
      if (command === "__downloadClaudeArchive") return refuseExport
        ? Promise.resolve({status: 409, statusText: "Conflict", headers: [], path: null, bytes: 0, body: JSON.stringify({message: "Another process is using this session or its operation owner is unknown"})})
        : pending;
      if (command === "__cancelTransfer") { rejectDownload(new DOMException("Cancelled", "AbortError")); return Promise.resolve(true); }
      throw new Error(`Unexpected native operation: ${command}`);
    },
  }});
  try {
    const client = createOmniRushServerClient({baseUrl: "http://127.0.0.1:39876", token: "fixture-client", hostToken: "fixture-current-host"});
    const downloading = client.claude.saveExport("ws", "00000000-0000-4000-8000-000000000001", controller.signal);
    const outcome = downloading.then(() => "completed", error => error.name);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({command: "__downloadClaudeArchive", input: {
      transferId: expect.any(String), headers: {Authorization: "Bearer fixture-client", "X-OmniRush-Host-Token": "fixture-current-host"},
      url: "http://127.0.0.1:39876/workspace/ws/claude/sessions/00000000-0000-4000-8000-000000000001/export",
    }});
    controller.abort();
    expect(await outcome).toBe("AbortError");
    expect(commands).toHaveLength(2);
    expect(commands[1].command).toBe("__cancelTransfer");
    expect(commands[0].input).toMatchObject({transferId: commands[1].input});
    await expect(client.claude.saveExport("ws", "same-session", controller.signal)).rejects.toMatchObject({name: "AbortError"});
    expect(commands).toHaveLength(2);
    refuseExport = true;
    await expect(client.claude.saveExport("ws", "locked-session")).rejects.toThrow("Another process is using this session or its operation owner is unknown");
  } finally {
    if (previous) Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", previous);
    else Reflect.deleteProperty(window, "__OMNIRUSH_ELECTRON__");
  }
}, 5000);
