import { spec } from "@omnirush/testkit";
import { expect } from "vitest";
import { bestPracticesDesktop } from "../worlds/best-practices-desktop.ts";

const test = spec.world(bestPracticesDesktop, {
  needs: { commands: ["bun"], placement: "local", env: ["OMNIRUSH_OPENCODE_BIN", "OMNIRUSH_EVAL_ELECTRON_RESOURCES_PREPARED"] },
  timeout: 240_000,
});

test("Settings > General lets a user turn Best practices off and on and keeps the choice across restart", { timeout: 600_000 }, async ({ world, user, probe, step, evidence }) => {
  await step("the setting starts on and uses plain guide-only help", async () => {
    await user.see({ role: "switch", label: "Best practices" });
    const state = await probe.eventually(() => world.state(), {
      within: 30_000, intervalMs: 250, label: "default enabled Best practices switch",
      until: (value) => value.exists && !value.disabled,
    });
    expect(state.enabled).toBe(true);
    expect(state.help).toContain("Built-in guides");
    expect(state.help).toContain("On by default");
    expect(state.help.toLowerCase()).not.toContain("upload");
    expect(await probe.desktopApi("/runtime-config/best-practices")).toEqual({ status: 200, body: { enabled: true } });
    evidence.recordJsonArtifact("default Best practices UI state", state);
    evidence.recordAssertionEvidence("Settings > General exposes an enabled Best practices switch with accurate guide help", "The visible, enabled switch reported aria-checked=true. The local server agreed. Help described built-in guides and on-by-default behavior without an upload promise or claim.", true);
  });

  await step("turning off saves the choice and shows the actual apply result", async () => {
    await user.click({ role: "switch", label: "Best practices" });
    const state = await probe.eventually(() => world.state(), {
      within: 30_000, intervalMs: 250, label: "saved disabled Best practices switch",
      until: (value) => !value.enabled && !value.disabled && value.status.includes("Best practices off"),
    });
    expect(state.status).toContain("Ready for your next request");
    expect(await probe.desktopApi("/runtime-config/best-practices")).toEqual({ status: 200, body: { enabled: false } });
    expect(await world.canaryUnchanged()).toBe(true);
    evidence.recordJsonArtifact("off Best practices UI state", state);
    evidence.recordAssertionEvidence("The user can turn Best practices off without changing private project bytes", "A real click changed the switch to unchecked. Its status reported off and ready for the next request, GET returned enabled=false, and the private fixture note stayed unchanged.", true);
  });

  await step("a fresh desktop process keeps off, and the user can turn it on again", async () => {
    await world.restart();
    const nextUser = user.on(world.app);
    const nextProbe = probe.on(world.app);
    await nextUser.see({ role: "switch", label: "Best practices" });
    const restarted = await nextProbe.eventually(() => world.state(), {
      within: 30_000, intervalMs: 250, label: "persisted off switch after desktop restart",
      until: (value) => value.exists && !value.disabled,
    });
    expect(restarted.enabled).toBe(false);
    expect(await nextProbe.desktopApi("/runtime-config/best-practices")).toEqual({ status: 200, body: { enabled: false } });
    await nextUser.click({ role: "switch", label: "Best practices" });
    const enabled = await nextProbe.eventually(() => world.state(), {
      within: 30_000, intervalMs: 250, label: "restored enabled Best practices switch",
      until: (value) => value.enabled && !value.disabled && value.status.includes("Best practices on"),
    });
    expect(enabled.status).toContain("Ready for your next request");
    expect(await nextProbe.desktopApi("/runtime-config/best-practices")).toEqual({ status: 200, body: { enabled: true } });
    expect(await world.canaryUnchanged()).toBe(true);
    evidence.recordJsonArtifact("restarted off and restored on UI states", { restarted, enabled });
    evidence.recordAssertionEvidence("The saved choice survives a desktop restart and can be restored in Settings", "A fresh Electron process on the same isolated profile showed off and GET confirmed it. A real click restored on and the applied status, while the private note remained byte-identical.", true);
  });
});
