/** @jsxImportSource react */
import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { OmniRushApprovalMode, OmniRushRuntimeApprovals } from "../src/app/lib/omnirush-server";
import type { ApprovalsClient } from "../src/react-app/domains/settings/approval-mode";

// The composer switch reads the organization policy through the desktop-config
// provider and reports through the app toaster; neither is mounted here.
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

const [
  { FullPermissionsToggle, FULL_PERMISSIONS_OFF_HINT, FULL_PERMISSIONS_POLICY_LOCK },
  { useApprovalMode, useApprovalModeStore },
  { ApprovalsCard },
  { TooltipProvider },
] = await Promise.all([
  import("../src/react-app/domains/session/surface/composer/full-permissions-toggle"),
  import("../src/react-app/domains/settings/approval-mode"),
  import("../src/react-app/domains/settings/pages/general-view"),
  import("../src/components/ui/tooltip"),
]);

function fakeClient(
  baseUrl: string,
  initial: OmniRushRuntimeApprovals,
  options: { reloadError?: Error; setError?: Error; holdSet?: boolean } = {},
) {
  const calls: string[] = [];
  let gets = 0;
  let approvals = initial;
  let release: (() => void) | null = null;
  const client: ApprovalsClient = {
    baseUrl,
    getRuntimeApprovals: async () => {
      gets += 1;
      return approvals;
    },
    setRuntimeApprovals: async (mode: OmniRushApprovalMode) => {
      calls.push(`set:${mode}`);
      if (options.holdSet) await new Promise<void>((resolve) => { release = resolve; });
      if (options.setError) throw options.setError;
      approvals = { mode, source: "settings", setting: mode };
      return { ...approvals, ok: true, changed: true };
    },
    reloadEngine: async (workspaceId: string) => {
      calls.push(`reload:${workspaceId}`);
      if (options.reloadError) throw options.reloadError;
      return { ok: true };
    },
  };
  return { client, calls, gets: () => gets, release: () => release?.() };
}

const mounted: { root: Root; container: HTMLElement }[] = [];

async function mount(ui: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(<TooltipProvider delay={0}>{ui}</TooltipProvider>));
  return container;
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  toasts.length = 0;
  policyLocked = false;
  useApprovalModeStore.setState({ byServer: {} });
});

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

function toggleIn(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[data-testid="full-permissions-toggle"]');
  if (!button) throw new Error("the Full permissions switch is not rendered");
  return button;
}

async function click(button: HTMLElement) {
  await act(async () => {
    button.click();
  });
}

const guardedByDefault: OmniRushRuntimeApprovals = { mode: "guarded", source: "default", setting: null };

test("shows the current mode on load and reads as active while full permissions are on", async () => {
  const guarded = fakeClient("http://guarded.test", guardedByDefault);
  const container = await mount(<FullPermissionsToggle client={guarded.client} workspaceId="ws_1" />);
  await waitFor(() => toggleIn(container).getAttribute("aria-disabled") === null, "the guarded mode to load");
  const off = toggleIn(container);
  expect(off.getAttribute("role")).toBe("switch");
  expect(off.getAttribute("aria-checked")).toBe("false");
  expect(off.textContent).toContain("Full permissions");
  expect(off.dataset.state).toBe("off");
  expect(off.dataset.lockReason).toBeUndefined();
  expect(off.className).not.toContain("--dls-accent");

  const full = fakeClient("http://full.test", { mode: "full", source: "settings", setting: "full" });
  const active = await mount(<FullPermissionsToggle client={full.client} workspaceId="ws_1" />);
  await waitFor(() => toggleIn(active).getAttribute("aria-checked") === "true", "the full mode to load");
  expect(toggleIn(active).dataset.state).toBe("on");
  expect(toggleIn(active).getAttribute("aria-disabled")).toBeNull();
  expect(toggleIn(active).className).toContain("bg-[var(--dls-accent)]");

  // Nothing renders without a server client.
  const none = await mount(<FullPermissionsToggle client={null} workspaceId="ws_1" />);
  expect(none.querySelector('[data-testid="full-permissions-toggle"]')).toBeNull();
});

test("is disabled with a tooltip while the environment or the organisation forces the mode", async () => {
  const env = fakeClient("http://env.test", { mode: "full", source: "environment", setting: "guarded" });
  const container = await mount(<FullPermissionsToggle client={env.client} workspaceId="ws_1" />);
  await waitFor(() => toggleIn(container).getAttribute("aria-checked") === "true", "the environment mode to load");
  const button = toggleIn(container);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.dataset.lockReason).toBe("Set by environment (OMNIRUSH_APPROVALS=full); change it where the app is launched.");
  await click(button);
  expect(env.calls).toEqual([]);
  expect(toasts).toEqual([]);

  await act(async () => {
    button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    button.dispatchEvent(new MouseEvent("mouseenter"));
  });
  await waitFor(
    () => document.querySelector('[data-slot="tooltip-content"]')?.textContent?.includes("Set by environment (OMNIRUSH_APPROVALS=full)") === true,
    "the environment tooltip",
  );

  policyLocked = true;
  const guarded = fakeClient("http://policy.test", guardedByDefault);
  const locked = await mount(<FullPermissionsToggle client={guarded.client} workspaceId="ws_1" />);
  await waitFor(() => toggleIn(locked).dataset.lockReason === FULL_PERMISSIONS_POLICY_LOCK, "the policy lock");
  expect(toggleIn(locked).getAttribute("aria-disabled")).toBe("true");
  await click(toggleIn(locked));
  expect(guarded.calls).toEqual([]);
});

test("clicking persists the mode, reloads the engine and stays disabled while the reload is in flight", async () => {
  const held = fakeClient("http://toggle.test", guardedByDefault, { holdSet: true });
  const container = await mount(<FullPermissionsToggle client={held.client} workspaceId="ws_1" />);
  await waitFor(() => toggleIn(container).getAttribute("aria-disabled") === null, "the guarded mode to load");

  await click(toggleIn(container));
  await waitFor(() => toggleIn(container).getAttribute("aria-busy") === "true", "the in-flight state");
  expect(toggleIn(container).getAttribute("aria-disabled")).toBe("true");
  expect(held.calls).toEqual(["set:full"]);
  // A second click while in flight is ignored.
  await click(toggleIn(container));
  expect(held.calls).toEqual(["set:full"]);

  await act(async () => held.release());
  await waitFor(() => toggleIn(container).getAttribute("aria-checked") === "true", "the full mode");
  expect(held.calls).toEqual(["set:full", "reload:ws_1"]);
  expect(toggleIn(container).getAttribute("aria-busy")).toBeNull();
  expect(toggleIn(container).getAttribute("aria-disabled")).toBeNull();
  expect(toasts).toEqual(["success:Full permissions on. Engine reloaded."]);

  await click(toggleIn(container));
  await act(async () => held.release());
  await waitFor(() => toggleIn(container).getAttribute("aria-checked") === "false", "the guarded mode again");
  expect(held.calls.slice(2)).toEqual(["set:guarded", "reload:ws_1"]);
  expect(toasts[1]).toBe("success:Guarded mode. Engine reloaded.");
});

test("reports a failed reload or a refused change without losing the switch", async () => {
  const reloadFails = fakeClient("http://reload-fails.test", guardedByDefault, { reloadError: new Error("engine busy") });
  const container = await mount(<FullPermissionsToggle client={reloadFails.client} workspaceId="ws_1" />);
  await waitFor(() => toggleIn(container).getAttribute("aria-disabled") === null, "the guarded mode to load");
  await click(toggleIn(container));
  await waitFor(() => toggleIn(container).getAttribute("aria-checked") === "true", "the saved full mode");
  expect(toasts).toEqual(["warning:Full permissions on. Engine reload failed: engine busy Use Reload in Settings to apply it."]);

  const refused = fakeClient("http://refused.test", guardedByDefault, { setError: new Error("settings are locked") });
  const other = await mount(<FullPermissionsToggle client={refused.client} workspaceId="ws_1" />);
  await waitFor(() => toggleIn(other).getAttribute("aria-disabled") === null, "the second guarded mode to load");
  await click(toggleIn(other));
  await waitFor(() => toasts.length === 2, "the error toast");
  expect(toasts[1]).toBe("error:settings are locked");
  expect(toggleIn(other).getAttribute("aria-checked")).toBe("false");
  expect(toggleIn(other).getAttribute("aria-disabled")).toBeNull();
  expect(refused.calls).toEqual(["set:full"]);
});

/** The Settings card exactly as GeneralSettingsView wires it. */
function SettingsCard(props: { client: ApprovalsClient }) {
  const mode = useApprovalMode(props.client, "ws_1");
  return (
    <ApprovalsCard
      approvals={mode.approvals}
      busy={mode.busy}
      status={mode.status}
      onToggle={(enabled) => void mode.setFullPermissions(enabled)}
    />
  );
}

test("shares its state with the Settings card, so a change in either shows in the other", async () => {
  const shared = fakeClient("http://shared.test", guardedByDefault);
  const container = await mount(
    <>
      <FullPermissionsToggle client={shared.client} workspaceId="ws_1" />
      <SettingsCard client={shared.client} />
    </>,
  );
  const cardSwitch = () => {
    const element = container.querySelector<HTMLButtonElement>('[role="switch"][data-slot="switch"]');
    if (!element) throw new Error("the Settings switch is not rendered");
    return element;
  };
  await waitFor(() => toggleIn(container).getAttribute("aria-disabled") === null, "the shared load");
  expect(shared.gets()).toBe(1);
  expect(cardSwitch().getAttribute("aria-checked")).toBe("false");

  await click(toggleIn(container));
  await waitFor(() => cardSwitch().getAttribute("aria-checked") === "true", "the card to follow the composer");
  expect(container.querySelector('[data-testid="approvals-status"]')?.textContent).toBe("Full permissions on. Engine reloaded.");
  expect(toasts).toEqual(["success:Full permissions on. Engine reloaded."]);

  await click(cardSwitch());
  await waitFor(() => toggleIn(container).getAttribute("aria-checked") === "false", "the composer to follow the card");
  expect(shared.calls).toEqual(["set:full", "reload:ws_1", "set:guarded", "reload:ws_1"]);
  // Settings changes report inline, not through the composer toast.
  expect(toasts).toHaveLength(1);
  expect(toggleIn(container).dataset.lockReason).toBeUndefined();
  expect(FULL_PERMISSIONS_OFF_HINT).toContain("Guarded mode");
});
