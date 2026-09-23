import { expect } from "vitest";
import type { Target } from "@omnirush/cdp";
import { spec } from "@omnirush/testkit";
import { paletteSessionActions } from "../worlds/chat.ts";

const test = spec.world(paletteSessionActions);
const shortcut = process.platform === "darwin" ? "Meta+K" : "Control+K";
const paletteInput = { placeholder: "Search actions, settings, and sessions…" };
const paletteFooter = { text: "Arrow keys to navigate" };

test("the command palette pins, renames and copies the ID of the open session", async ({ world, user, probe, step }) => {
  const sessionId = world.session.sessionId;
  const renamedTitle = "Renamed from the palette";
  const copySessionIdMenuItem: Target = { role: "menuitem", label: "Copy session ID" };
  const sessionIdCopied: Target = { text: "Session ID copied" };
  const highlightedItem = async (title: string) => {
    const dom = await probe.eventually(() => probe.dom("[data-command-palette-item][data-highlighted]"), {
      within: 5_000,
      label: `${title} is the highlighted palette item`,
      until: (value) => value.elements[0]?.text.startsWith(title) === true,
    });
    return dom.elements[0]?.text;
  };
  const waitForPaletteClose = () => probe.eventually(() => probe.has("Arrow keys to navigate"), {
    within: 15_000,
    label: "command palette closes",
    until: (open) => !open,
  });

  await step("the palette offers Pin session for the open session", async () => {
    await user.notSee({ text: "Pinned" });
    await user.press(shortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, "pin", { replace: true });
    await user.see({ role: "option", label: /^Pin session/ });
    await user.notSee({ role: "option", label: /^Unpin session/ });
    await user.screenshot();
  });

  await step("choosing it pins the session", async () => {
    await user.press("Enter");
    await probe.eventually(() => probe.has("Arrow keys to navigate"), {
      within: 15_000,
      label: "command palette footer disappears after pinning",
      until: (open) => !open,
    });
    await user.see({ text: "Pinned" });
    await user.see({ text: world.session.title });
    await user.press(shortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, "pin", { replace: true });
    await user.see({ role: "option", label: /^Unpin session/ });
    await user.notSee({ role: "option", label: /^Pin session/ });
    await user.screenshot();
    await user.press("Escape");
    await probe.eventually(() => probe.has("Arrow keys to navigate"), {
      within: 15_000,
      label: "command palette footer disappears after Escape",
      until: (open) => !open,
    });
    await user.notSee(paletteFooter);
  });

  await step("Rename session… opens the rename dialog", async () => {
    await user.press(shortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, "rename", { replace: true });
    await user.see({ role: "option", label: /^Rename session/ });
    await user.press("Enter");
    await user.see({ text: "Rename session" });
    await user.see({ label: "Session name" });
    await user.screenshot();
  });

  await step("saving a new name updates the sidebar", async () => {
    await user.type({ label: "Session name" }, "Renamed from the palette", { replace: true });
    await user.click({ role: "button", label: "Save" });
    await probe.eventually(() => probe.has("Renamed from the palette"), {
      within: 15_000,
      label: "renamed session appears in the sidebar",
    });
    await user.see({ text: "Renamed from the palette" });
    await probe.eventually(() => probe.has(world.session.title), {
      within: 15_000,
      label: "previous session title disappears",
      until: (has) => !has,
    });
    await user.notSee({ text: world.session.title });
    await user.screenshot();
  });

  await step("the sidebar menu copies the session ID", async () => {
    await user.rightClick({ text: renamedTitle });
    await user.click(copySessionIdMenuItem);
    await user.see(sessionIdCopied);
    expect(await world.readClipboard()).toBe(sessionId);
    await user.screenshot();
  });

  await step("copy still leads to Copy diagnostics, which carries the session ID", async () => {
    await probe.eventually(() => probe.has("Session ID copied"), {
      within: 15_000,
      label: "the sidebar copy toast disappears",
      until: (shown) => !shown,
    });
    await user.press(shortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, "copy", { replace: true });
    await user.see({ role: "option", label: /^Session ID/ });
    expect(await highlightedItem("Copy diagnostics")).toMatch(/^Copy diagnostics/);
    await user.screenshot();
    await user.press("Enter");
    await user.see({ text: /^Diagnostics copied/ });
    const bundle: unknown = JSON.parse(await world.readClipboard());
    expect(bundle).toMatchObject({ session: { id: sessionId, workspaceId: world.workspace.workspaceId } });
    await waitForPaletteClose();
  });

  await step("the palette's Session ID item copies the open session's ID", async () => {
    await user.press(shortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, "session id", { replace: true });
    await user.see({ text: sessionId });
    expect(await highlightedItem("Session ID")).toMatch(/^Session ID/);
    await user.screenshot();
    await user.press("Enter");
    await user.see(sessionIdCopied);
    expect(await world.readClipboard()).toBe(sessionId);
    await waitForPaletteClose();
  });

  await step("a blocked clipboard keeps the ID on screen, selected in one click", async () => {
    await world.blockClipboardWrites();
    await user.rightClick({ text: renamedTitle });
    await user.click(copySessionIdMenuItem);
    await user.see({ text: "Couldn't copy the session ID" });
    await user.see({ text: sessionId });
    // Outlast sonner's 4 s default lifetime with the pointer away from the toast.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await user.see({ text: sessionId });
    await user.click({ text: sessionId });
    expect(await world.selectedText()).toBe(sessionId);
    await user.screenshot();
  });
});
