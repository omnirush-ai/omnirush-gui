/** @jsxImportSource react */
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Bell } = await import("lucide-react");
const { SidebarProvider } = await import("../src/components/ui/sidebar");
const { ShellConfigProvider } = await import("../src/react-app/shell/shell-config");
const { NativeAccountFooter, SidebarIconButton } = await import("../src/react-app/domains/session/sidebar/app-sidebar");
const { useAccountStatusStore } = await import("../src/app/lib/quality");
const { useFeedbackStore } = await import("../src/app/lib/in-app-feedback");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("sidebar footer", () => {
  test("profile and Send feedback show text labels; feedback opens the dialog", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<ShellConfigProvider><SidebarProvider><NativeAccountFooter onOpenAccountSettings={() => {}} /></SidebarProvider></ShellConfigProvider>);
      await tick();
    });
    // The mount-time read fails without the desktop bridge; then the account arrives.
    await act(async () => {
      useAccountStatusStore.getState().set({ connected: true, gatewayConfigured: true, displayName: "Ada Lovelace", email: "ada@example.invalid" });
      await tick();
    });

    const profile = host.querySelector<HTMLElement>('[data-testid="native-account-profile"]')!;
    expect(profile.textContent).toContain("Ada Lovelace");
    expect(host.querySelector('[data-testid="native-account-avatar"]')?.textContent).toBe("AL");

    const feedback = host.querySelector<HTMLButtonElement>('[data-testid="sidebar-send-feedback"]')!;
    expect(feedback.textContent).toContain("Send feedback");
    expect(useFeedbackStore.getState().dialog.open).toBe(false);
    await act(async () => feedback.click());
    expect(useFeedbackStore.getState().dialog).toMatchObject({ open: true, trigger: "menu" });

    for (const button of host.querySelectorAll<HTMLElement>('[data-testid="sidebar-footer-tools"] button')) {
      expect(button.getAttribute("aria-label")).toBeTruthy();
      expect(button.getAttribute("data-slot")).toBe("tooltip-trigger");
    }
    await act(async () => root.unmount());
  });

  test("in Work the account line reads at 12 px; outside Work it keeps 10.5 px", async () => {
    const size = async (work: boolean) => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      await act(async () => {
        useAccountStatusStore.getState().set({ connected: true, gatewayConfigured: true, displayName: "Ada Lovelace", email: "ada@example.invalid" });
        root.render(<ShellConfigProvider><SidebarProvider><NativeAccountFooter onOpenAccountSettings={() => {}} work={work} /></SidebarProvider></ShellConfigProvider>);
        await tick();
      });
      const detail = host.querySelector('[data-testid="native-account-detail"]')!.className;
      await act(async () => root.unmount());
      return detail;
    };
    expect(await size(true)).toContain("text-[12px]");
    expect(await size(false)).toContain("text-[10.5px]");
  });

  test("an icon button carries its aria-label and is a tooltip trigger, not a bare title", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<SidebarIconButton icon={Bell} label="Notifications" />));
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Notifications");
    expect(button.getAttribute("data-slot")).toBe("tooltip-trigger");
    expect(button.hasAttribute("title")).toBe(false);
    await act(async () => root.unmount());
  });
});
