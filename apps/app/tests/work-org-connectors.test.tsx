/** @jsxImportSource react */
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { ReactNode } from "react";

import type { OmniRushWorkConnector, OmniRushWorkMembers, OmniRushWorkOrgConnectors } from "../src/app/lib/omnirush-server";

// The DOM comes before the views: the dialog's portal checks for it when its module loads.
const registered = typeof globalThis.window === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => {
  if (registered) await GlobalRegistrator.unregister();
});

const toasts: string[] = [];
mock.module("@/components/ui/sonner", () => ({
  toast: {
    success: (message: string) => toasts.push(`success:${message}`),
    warning: (message: string) => toasts.push(`warning:${message}`),
    error: (message: string) => toasts.push(`error:${message}`),
  },
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { OmniRushServerError } = await import("../src/app/lib/omnirush-server");
const { localSourcesOff, workConnectorsKey, workMembersKey, workOrgConnectorsKey, workRoleLabel } = await import("../src/react-app/domains/work/work-mode");
const { nextShown, WorkOrganizationPage } = await import("../src/react-app/domains/work/work-org");
const { localChatError, WorkConnectorsPage } = await import("../src/react-app/domains/work/work-views");

const org = { id: "org_1", name: "Acme Bakery" };
const members: OmniRushWorkMembers = {
  org, you_role: "owner", invites: [],
  members: [
    { user_id: "u1", email: "owner@acme-bakery.test", role: "owner", you: true },
    { user_id: "u2", email: "dana@acme-bakery.test", role: "admin" },
    { user_id: "u3", email: "jo@acme-bakery.test", role: "member" },
  ],
};
/** The owner's view: Notion is on the company's list but not offered right now (switched off for everyone). */
const managed = (): OmniRushWorkOrgConnectors => ({
  org, role: "owner", can_manage: true, connectors: [{ id: "google", label: "Google" }], shown: ["google", "notion"], staff_limited: false, members: 3,
  allowed: [
    { id: "google", label: "Google", shown: true, members_connected: 3 },
    { id: "slack", label: "Slack", shown: false, members_connected: 1 },
    { id: "linear", label: "Linear", shown: false, members_connected: 0 },
  ],
});
const row = (over: Partial<OmniRushWorkConnector>): OmniRushWorkConnector => ({ id: "google", label: "Google", status: "disconnected", last_sync_at: null, records: 0, sync_enabled: false, ...over });

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  toasts.length = 0;
  Reflect.deleteProperty(window, "__OMNIRUSH_ELECTRON__");
});

async function render(node: ReactNode, queries: InstanceType<typeof QueryClient>) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<QueryClientProvider client={queries}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>));
  unmount = () => act(async () => root.unmount());
}
// A click, then a moment for the mutation and the dialog's timers.
const click = (element: Element | null | undefined) => act(async () => {
  if (!element) throw new Error("nothing to click");
  (element as HTMLElement).click();
  await new Promise((resolve) => setTimeout(resolve, 30));
});
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
const dialog = () => document.querySelector("[role=alertdialog]");

test("a switch saves the company's list; turning off one people use asks first; the owner makes and removes admins", async () => {
  const patched: unknown[] = [];
  const roles: [string, string][] = [];
  let view = managed();
  const client = {
    baseUrl: "http://org-connectors.test",
    listWorkMembers: async () => members,
    getWorkOrgConnectors: async () => view,
    setWorkOrgConnectors: async (shown: string[] | null) => {
      patched.push(shown);
      view = { ...view, shown, allowed: view.allowed!.map((item) => ({ ...item, shown: shown === null || shown.includes(item.id) })) };
      return view;
    },
    setWorkMemberRole: async (userId: string, role: string) => {
      roles.push([userId, role]);
      return { ok: true, role };
    },
  } as never;
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queries.setQueryData(workMembersKey(client), members);
  queries.setQueryData(workOrgConnectorsKey(client), view);
  await render(<WorkOrganizationPage client={client} openLink={() => undefined} onBack={() => undefined} />, queries);

  // On: saved at once, with Notion (on the list, not offered now) kept.
  await click(byLabel("Show Slack to your team"));
  expect(dialog()).toBeNull();
  expect(patched).toEqual([["google", "slack", "notion"]]);
  expect(document.querySelector('[data-org-connector="slack"]')?.getAttribute("data-shown")).toBe("true");

  // Off, with people connected: the dialog first; Cancel saves nothing.
  await click(byLabel("Show Google to your team"));
  expect(dialog()?.textContent).toContain("Turn off Google for your team?");
  expect(dialog()?.textContent).toContain("3 people connected it.");
  await click(button("Cancel", dialog()!));
  expect(dialog()).toBeNull();
  expect(patched).toHaveLength(1);
  await click(byLabel("Show Google to your team"));
  await click(button("Turn off", dialog()!));
  expect(patched).toEqual([["google", "slack", "notion"], ["slack", "notion"]]);
  expect(document.querySelector('[data-org-connector="google"]')?.getAttribute("data-shown")).toBe("false");

  // Off, with nobody connected: no dialog.
  await click(byLabel("Show Linear to your team"));
  await click(byLabel("Show Linear to your team"));
  expect(dialog()).toBeNull();
  expect(patched.at(-2)).toEqual(["slack", "linear", "notion"]);
  expect(patched.at(-1)).toEqual(["slack", "notion"]);

  // Make admin and Remove admin send the role.
  const memberRow = (id: string) => document.querySelector(`[data-work-member="${id}"]`)!;
  await click(button("Make admin", memberRow("u3")));
  await click(button("Remove admin", memberRow("u2")));
  expect(roles).toEqual([["u3", "admin"], ["u2", "member"]]);
  expect(toasts).toContain("success:jo@acme-bakery.test is now an admin");
  expect(toasts).toContain("success:dana@acme-bakery.test is a member again");
});

test("the saved list: null stays all until the first switch off; a list keeps ids not offered now, unless staff limits it", () => {
  const all = { ...managed(), shown: null, allowed: managed().allowed!.map((item) => ({ ...item, shown: true })) };
  expect(nextShown(all, "slack", false)).toEqual(["google", "linear"]);
  expect(nextShown(all, "slack", true)).toBeNull();
  // Every switch on again keeps the list (no null that would bring back ones the company turned off).
  const listed = { ...managed(), shown: ["google", "slack", "notion"], allowed: managed().allowed!.map((item) => ({ ...item, shown: item.id !== "linear" })) };
  expect(nextShown(listed, "linear", true)).toEqual(["google", "slack", "linear", "notion"]);
  expect(nextShown({ ...listed, staff_limited: true }, "linear", true)).toEqual(["google", "slack", "linear"]);
  expect(nextShown({ ...listed, staff_limited: true }, "google", false)).toEqual(["slack"]);
});

test("WhatsApp the company turned off leaves the import and the Mac card; an older server keeps both", async () => {
  // The Mac desktop app: the WhatsApp and iMessage cards sync on their own there.
  Object.defineProperty(window, "__OMNIRUSH_ELECTRON__", { configurable: true, value: { invokeDesktop: async () => null } });
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  // The paused row exactly as the server sends it: no `mode`.
  const paused = row({ id: "whatsapp", label: "WhatsApp", status: "paused_by_admin", paused_by: "org", records: 52, sync_enabled: true, last_sync_at: "2026-11-20T10:00:00Z" });
  const memberView: OmniRushWorkOrgConnectors = { org, role: "member", can_manage: false, connectors: [{ id: "google", label: "Google" }] };
  const page = async (rows: OmniRushWorkConnector[], view: OmniRushWorkOrgConnectors | Error, onOpenOrganization?: () => void) => {
    await unmount?.();
    const client = {
      baseUrl: "http://org-connectors.test",
      listWorkConnectors: async () => rows,
      listWorkImports: async () => [],
      getWorkCoverage: async () => { throw new OmniRushServerError(404, "request_failed", "Not Found"); },
      getWorkOrgConnectors: async () => { if (view instanceof Error) throw view; return view; },
      getIMessageCount: async () => ({ records: 0 }),
      getWhatsAppLocalCount: async () => ({ records: 0 }),
    } as never;
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queries.setQueryData(workConnectorsKey(client), rows);
    queries.setQueryData(["omnirush-chat-sync"], {
      whatsapp: { enabled: true, lastSyncAt: null, lastError: "connector_off", failures: 3, running: false },
      imessage: { enabled: true, lastSyncAt: null, lastError: null, failures: 0, running: false },
    });
    await render(<WorkConnectorsPage client={client} openLink={() => undefined} onOpenOrganization={onOpenOrganization} />, queries);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    return document.body.innerHTML;
  };

  // A member with a WhatsApp connection: the paused row with only Disconnect, and no Import or Mac sync for it.
  const member = await page([row({ id: "google", status: "connected" }), paused], memberView);
  expect(member).toContain('data-work-connector="whatsapp" data-status="paused_by_admin"');
  expect(member).toContain("Turned off by your company admin");
  expect(byLabel("Disconnect WhatsApp")).not.toBeNull();
  expect(member).not.toContain('data-work-import="whatsapp"');
  expect(byLabel("Import a WhatsApp chat")).toBeNull();
  expect(member).toContain('data-work-import="telegram"');
  expect(member).not.toContain('data-testid="work-whatsapp-card"');
  expect(member).toContain('data-testid="work-imessage-card"');
  expect(member).not.toContain("Sync failed");

  // Never connected: off by the company's list alone, so nothing for WhatsApp at all.
  const listOnly = await page([row({ id: "google", status: "connected" })], memberView);
  expect(listOnly).not.toContain('data-work-import="whatsapp"');
  expect(listOnly).not.toContain('data-testid="work-whatsapp-card"');

  // An older server (no list, no paused rows): the import and the Mac card as before.
  const old = await page([row({ id: "google", status: "connected" }), row({ id: "whatsapp", label: "WhatsApp", mode: "import" })], new OmniRushServerError(404, "request_failed", "Not Found"));
  expect(old).toContain('data-work-import="whatsapp"');
  expect(byLabel("Import a WhatsApp chat")).not.toBeNull();
  expect(old).toContain('data-testid="work-whatsapp-card"');
  // No company: the server lists everything it offers, so nothing is off.
  const solo = await page([row({ id: "google", status: "connected" })], { org: null, role: null, can_manage: false, connectors: [] });
  expect(solo).toContain('data-work-import="whatsapp"');
  expect(solo).toContain('data-testid="work-whatsapp-card"');

  // The owner (or an admin) reads it as their own team's switch, with the way to Organization.
  const opened: string[] = [];
  const owner = await page([row({ id: "google", status: "connected" }), paused], { ...managed(), connectors: [{ id: "google", label: "Google" }] }, () => opened.push("organization"));
  expect(owner).toContain("Turned off for your team.");
  expect(owner).not.toContain("Turned off by your company admin");
  await click(document.querySelector('[data-testid="work-connector-paused-manage"]'));
  expect(opened).toEqual(["organization"]);
  Reflect.deleteProperty(navigator, "platform");
});

test("which local sources are off, the sync card's words for the company's refusal, and roles in words", () => {
  const paused = row({ id: "whatsapp", status: "paused_by_admin", paused_by: "org" });
  const listed = { org, connectors: [{ id: "whatsapp", label: "WhatsApp" }] };
  expect(localSourcesOff([paused], listed)).toEqual(["whatsapp"]);
  expect(localSourcesOff([], { org, connectors: [] })).toEqual(["whatsapp"]);
  expect(localSourcesOff([], listed)).toEqual([]);
  expect(localSourcesOff([row({ id: "whatsapp", mode: "import" })], undefined)).toEqual([]);
  expect(localSourcesOff(undefined, { org: null, connectors: [] })).toEqual([]);
  expect(localChatError("whatsapp", "connector_off", 4)).toBe("Turned off by your company admin");
  expect(localChatError("whatsapp", "connector_not_allowed", 1)).toBe("Not available for your company right now");
  expect(workRoleLabel("admin")).toBe("Admin");
  expect(workRoleLabel("owner")).toBe("Owner");
  expect(workRoleLabel("member")).toBe("Member");
});
