/** @jsxImportSource react */
import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { OmniRushSubagentModelSetting, OmniRushSubagentModelState } from "../src/app/lib/omnirush-server";

let policyLocked = false;
const toasts: string[] = [];
mock.module("@/react-app/domains/cloud/desktop-config-provider", () => ({
  useDesktopRestriction: () => policyLocked,
}));
mock.module("@/components/ui/sonner", () => ({
  toast: {
    success: (message: string) => toasts.push(`success:${message}`),
    warning: (message: string) => toasts.push(`warning:${message}`),
    error: (message: string) => toasts.push(`error:${message}`),
  },
}));

if (typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined") {
  GlobalRegistrator.register({ url: "http://localhost/" });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const [{ SubagentModelMenu }, { createOmniRushServerClient, OmniRushServerError }, { Popover, PopoverContent, PopoverTrigger }] = await Promise.all([
  import("../src/react-app/domains/session/surface/composer/subagent-model-menu"),
  import("../src/app/lib/omnirush-server"),
  import("../src/components/ui/popover"),
]);

const codex = ["low", "high", "xhigh", "max"];

function fakeClient(initial: OmniRushSubagentModelSetting, signedIn = true) {
  const saved: OmniRushSubagentModelSetting[] = [];
  let setting = initial;
  const client = {
    baseUrl: `http://server-${Math.random()}`,
    getSubagentModel: async (): Promise<OmniRushSubagentModelState> => ({
      setting,
      signedIn,
      models: [
        { id: "gpt-6-astra", name: "GPT 6 Astra", family: "OpenAI", default: true, efforts: codex },
        { id: "gpt-6-sol", name: "GPT 6 Sol", family: "OpenAI", default: false, efforts: codex },
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", family: "OpenAI", default: false, efforts: codex },
        { id: "meta-muse-spark", name: "Meta Muse Spark", family: "Meta Muse", default: false, efforts: ["minimal", "low", "medium", "high", "xhigh"] },
        { id: "muse-spark-1.1", name: "Muse Spark 1.1", family: "Meta Muse", default: false, efforts: ["minimal", "low", "medium", "high", "xhigh"] },
      ],
    }),
    setSubagentModel: async (next: OmniRushSubagentModelSetting) => {
      saved.push(next);
      setting = next;
      return { ok: true, setting: next };
    },
  };
  return { client, saved };
}

const mounted: { root: Root; container: HTMLElement }[] = [];

async function mount(ui: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return container;
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  document.body.innerHTML = "";
  toasts.length = 0;
  policyLocked = false;
});

function trigger(): HTMLElement | null {
  return document.querySelector('[data-testid="subagent-model-trigger"]');
}

test("shows 'Sub-agents' by default and saves a picked model from the menu", async () => {
  const { client, saved } = fakeClient({ model: null, effort: null });
  await mount(<SubagentModelMenu client={client} />);
  expect(trigger()?.textContent).toBe("Sub-agents");
  expect(trigger()?.getAttribute("aria-label")).toBe("Sub-agents: Same as main agent");

  await act(async () => { trigger()!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  const sol = document.querySelector<HTMLElement>('[data-testid="subagent-model-gpt-6-sol"]');
  expect(sol).not.toBeNull();
  expect(document.querySelector('[data-testid="subagent-model-meta-muse-spark"]')?.textContent).toContain("Meta Muse");
  await act(async () => { sol!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(saved).toEqual([{ model: "gpt-6-sol", effort: null }]);
  expect(toasts).toEqual(["success:Sub-agents: GPT 6 Sol. Applies to new tasks."]);
  expect(trigger()?.textContent).toBe("GPT 6 Sol");
});

test("a picked model and effort show on the trigger; a model outside the catalog is flagged", async () => {
  const { client } = fakeClient({ model: "meta-muse-spark", effort: "xhigh" });
  await mount(<SubagentModelMenu client={client} />);
  expect(trigger()?.textContent).toBe("Meta Muse Spark · Xhigh");

  const missing = fakeClient({ model: "muse-spark-1.3", effort: null });
  await mount(<SubagentModelMenu client={missing.client} />);
  const flagged = document.querySelectorAll('[data-testid="subagent-model-trigger"]')[1] as HTMLElement;
  expect(flagged.getAttribute("title")).toContain("not available, sub-agents use the main model");
});

test("hidden without an omnirush.ai account", async () => {
  const { client } = fakeClient({ model: null, effort: null }, false);
  await mount(<SubagentModelMenu client={client} />);
  expect(trigger()).toBeNull();
  await mount(<SubagentModelMenu client={null} />);
  expect(trigger()).toBeNull();
});

test("a save the server could not write shows its message and keeps the previous setting", async () => {
  const { client } = fakeClient({ model: "gpt-6-astra", effort: null });
  const attempts: OmniRushSubagentModelSetting[] = [];
  client.setSubagentModel = async (next: OmniRushSubagentModelSetting) => {
    attempts.push(next);
    throw new OmniRushServerError(500, "settings_write_failed", "The sub-agent setting could not be saved: EPERM", { code: "EPERM" });
  };
  await mount(<SubagentModelMenu client={client} />);
  expect(trigger()?.textContent).toBe("GPT 6 Astra");

  await act(async () => { trigger()!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { document.querySelector<HTMLElement>('[data-testid="subagent-model-gpt-6-sol"]')!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

  expect(attempts).toEqual([{ model: "gpt-6-sol", effort: null }]);
  expect(toasts).toEqual(["error:The sub-agent setting could not be saved: EPERM"]);
  // Not shown as saved: the trigger and the checked item stay on the previous model.
  expect(trigger()?.textContent).toBe("GPT 6 Astra");
  expect(document.querySelector('[data-testid="subagent-model-gpt-6-astra"]')?.getAttribute("aria-checked")).toBe("true");
  expect(document.querySelector('[data-testid="subagent-model-gpt-6-sol"]')?.getAttribute("aria-checked")).toBe("false");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("The sub-agent setting could not be saved: EPERM");
});

test("the server client rejects a failed save with the server's readable message", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(
      JSON.stringify({ code: "settings_write_failed", message: "The sub-agent setting could not be saved: EBUSY", details: { code: "EBUSY" } }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const server = createOmniRushServerClient({ baseUrl: "http://127.0.0.1:1", token: "token" });
    const error = await server.setSubagentModel({ model: "gpt-6-sol", effort: "high" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OmniRushServerError);
    expect((error as InstanceType<typeof OmniRushServerError>).status).toBe(500);
    expect((error as InstanceType<typeof OmniRushServerError>).code).toBe("settings_write_failed");
    expect((error as Error).message).toBe("The sub-agent setting could not be saved: EBUSY");
    expect(calls).toEqual([{ url: "http://127.0.0.1:1/omnirush/subagent-model", method: "PUT" }]);

    // A non-JSON error page still rejects with the status, not a JSON parse error.
    globalThis.fetch = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch;
    const proxied = await server.setSubagentModel({ model: null, effort: null }).catch((caught: unknown) => caught);
    expect(proxied).toBeInstanceOf(OmniRushServerError);
    expect((proxied as Error).message).toBe("Request failed (502)");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

function menu(): HTMLElement | null {
  return document.querySelector('[data-slot="dropdown-menu-content"]');
}

function pressOutside(target: Element) {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    const init = { bubbles: true, cancelable: true, composed: true, button: 0 };
    target.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, { ...init, pointerType: "mouse" }) : new MouseEvent(type, init));
  }
}

test("in a narrow composer the chip is an icon that still names the setting, and never squeezes the model selector", async () => {
  const { client } = fakeClient({ model: "meta-muse-spark", effort: "xhigh" });
  await mount(<SubagentModelMenu client={client} />);
  const chip = trigger()!;
  // The label only shows once the composer container is wide enough; the
  // icon-only chip keeps the full summary for screen readers and the tooltip.
  const label = document.querySelector('[data-testid="subagent-model-label"]')!;
  expect(label.textContent).toBe("Meta Muse Spark · Xhigh");
  expect(label.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "truncate", "@min-[720px]/composer:inline"]));
  expect(chip.getAttribute("aria-label")).toBe("Sub-agents: Meta Muse Spark · Xhigh");
  expect(chip.getAttribute("title")).toBe("Sub-agents: Meta Muse Spark · Xhigh");
  // It gives up its width before the model selector does, down to the icon.
  expect(chip.className.split(" ")).toEqual(expect.arrayContaining(["min-w-9", "shrink-[4]", "overflow-hidden"]));
});

test("the menu lists every model and stays inside the viewport, scrolling instead of running off the top", async () => {
  const { client } = fakeClient({ model: "meta-muse-spark", effort: "xhigh" });
  await mount(<SubagentModelMenu client={client} />);
  await act(async () => { trigger()!.click(); });
  await settle();
  const content = menu()!;
  // Portalled out of the composer, above the toolbar.
  expect(content.closest("[data-composer-toolbar]")).toBeNull();
  expect(content.className).toContain("max-h-[min(560px,var(--available-height))]");
  expect(content.className).toContain("overflow-y-auto");
  expect(content.className).not.toContain("70vh");
  for (const id of ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "meta-muse-spark", "muse-spark-1.1"]) {
    expect(document.querySelector(`[data-testid="subagent-model-${id}"]`)).not.toBeNull();
  }
});

test("Escape and an outside click close the menu; opening the model picker leaves only one menu open", async () => {
  const { client } = fakeClient({ model: null, effort: null });
  const container = await mount(
    <div data-composer-toolbar>
      <Popover>
        <PopoverTrigger data-testid="model-picker-stand-in">Change model</PopoverTrigger>
        <PopoverContent data-testid="model-list">GPT 6 Astra</PopoverContent>
      </Popover>
      <SubagentModelMenu client={client} />
      <p data-testid="outside">Describe your task</p>
    </div>,
  );

  await act(async () => { trigger()!.click(); });
  await settle();
  expect(menu()).not.toBeNull();
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await settle();
  expect(menu()).toBeNull();

  await act(async () => { trigger()!.click(); });
  await settle();
  expect(menu()).not.toBeNull();
  await act(async () => { pressOutside(container.querySelector('[data-testid="outside"]')!); });
  await settle();
  expect(menu()).toBeNull();

  await act(async () => { trigger()!.click(); });
  await settle();
  expect(menu()).not.toBeNull();
  const modelTrigger = container.querySelector<HTMLElement>('[data-testid="model-picker-stand-in"]')!;
  await act(async () => { pressOutside(modelTrigger); });
  await settle();
  if (!document.querySelector('[data-testid="model-list"]')) {
    await act(async () => { modelTrigger.click(); });
    await settle();
  }
  expect(menu()).toBeNull();
  expect(document.querySelector('[data-testid="model-list"]')).not.toBeNull();
  expect(document.querySelectorAll('[data-slot="dropdown-menu-content"], [data-slot="popover-content"]').length).toBe(1);
});
