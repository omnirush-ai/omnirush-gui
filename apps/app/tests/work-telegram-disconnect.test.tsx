/** @jsxImportSource react */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The DOM comes before the views: the dialog's portal checks for it when its module loads.
const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TelegramCard } = await import("../src/react-app/domains/work/work-views");

test("Telegram Disconnect asks first: Cancel keeps the login, Disconnect in the dialog ends it", async () => {
  const calls: string[] = [];
  Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", { configurable: true, value: { invokeDesktop: async (name: string) => { calls.push(name); return null; } } });
  const queries = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queries.setQueryData(["omnirush-telegram"], { available: true, step: "signed_in", name: "Sam Rao", via: null, hint: null, channels: false, days: 90 });
  queries.setQueryData(["omnirush-chat-sync"], { telegram: { enabled: true, lastSyncAt: null, lastError: null, failures: 0, running: false } });
  document.body.innerHTML = "<div id=root></div>";
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<QueryClientProvider client={queries}><TelegramCard client={null} /></QueryClientProvider>));
  // The dialog opens and closes on a timer.
  const click = (element: HTMLElement) => act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const disconnect = document.querySelector<HTMLButtonElement>('[aria-label="Disconnect Telegram"]')!;
  const dialogButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")].find((button) => button.textContent === label)!;
  await click(disconnect);
  expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Disconnect Telegram?This computer signs out of Telegram and stops syncing. Chats already synced stay in Work.");
  await click(dialogButton("Cancel"));
  expect(document.querySelector("[role=alertdialog]")).toBeNull();
  expect(calls).not.toContain("workTelegramLogout");
  await click(disconnect);
  await click(dialogButton("Disconnect"));
  expect(calls).toContain("workTelegramLogout");
  await act(async () => root.unmount());
  Reflect.deleteProperty(window, "__OMNIRUSH_ELECTRON__");
});
