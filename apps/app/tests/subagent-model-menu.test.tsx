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

const [{ SubagentModelMenu }] = await Promise.all([
  import("../src/react-app/domains/session/surface/composer/subagent-model-menu"),
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
