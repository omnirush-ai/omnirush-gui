import { spec } from "@omnirush/testkit";
import { expect } from "vitest";
import { notificationSounds } from "../worlds/chat.ts";

const test = spec.world(notificationSounds, { timeout: 600_000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Missing sound witness state.");
  return value;
}

function nativeFacts(value: unknown) {
  const state = record(value);
  if (!Array.isArray(state.samples)) throw new Error("Missing native audio samples.");
  return { minimized: state.minimized === true, focused: state.focused === true, audible: state.audible === true,
    samples: state.samples.map((value: unknown) => {
      const sample = record(value);
      return { minimized: sample.minimized === true, focused: sample.focused === true };
    }) };
}

test("soft chimes tell a background user that a task finished or needs input, and respect mute", async ({ world, user, probe, step }) => {
  const output = async () => {
    const state = record(await probe.eval(() => window.__omnirushAudioOutputWitness?.read()));
    return { positiveSamples: Number(state.positiveSamples), backgroundSamples: Number(state.backgroundSamples),
      peak: Number(state.peak), bursts: Number(state.bursts), running: state.running === true };
  };
  const native = async () => nativeFacts(await world.nativeWindow());
  const foreground = async () => {
    await world.nativeWindow("foreground");
    await probe.eventually(native, { within: 10_000, label: "the real app window is restored and focused",
      until: (state) => state.focused && !state.minimized });
    await probe.eventually(() => probe.eval(() => ({ visible: document.visibilityState, focused: document.hasFocus() })), {
      within: 10_000, label: "the app document is truly in the foreground", until: (state) => state.visible === "visible" && state.focused,
    });
  };
  const minimize = async () => {
    await world.nativeWindow("minimize");
    await probe.eventually(native, { within: 10_000, label: "the actual app window is minimized",
      until: (state) => state.minimized && !state.focused });
    expect(await probe.eval(() => document.visibilityState !== "visible" || !document.hasFocus())).toBe(true);
  };
  const settle = () => probe.eventually(native, { within: 10_000, label: "the short chime has stopped", until: (state) => !state.audible });
  const preferences = async () => {
    await foreground();
    await user.click({ role: "button", label: "Settings" });
    await user.click({ text: "Preferences" });
    await user.see({ role: "switch", label: "Soft notification sounds" });
  };
  const open = async (session: { sessionId: string; title: string }) => {
    await foreground();
    if ((await probe.hash()).includes("/settings")) await user.click({ role: "button", label: "Back to app" });
    await user.click({ text: session.title });
    await probe.eventually(() => probe.hash(), { within: 15_000, label: "the sound task conversation opens",
      until: (hash) => hash.includes(`/session/${session.sessionId}`) });
    await user.see("composer", { editable: true });
  };
  const send = async (prompt: string, background: boolean) => {
    await user.type("composer", prompt, { verify: true });
    await user.press("Enter");
    if (background) await minimize();
  };
  const baseline = async () => {
    await settle();
    return { native: (await native()).samples.length, output: await output() };
  };
  const expectSound = async (before: Awaited<ReturnType<typeof baseline>>) => {
    await probe.eventually(native, { within: 15_000, label: "Chromium reports real audible output while minimized",
      until: (state) => state.samples.length > before.native });
    const state = await native();
    expect(state.samples.slice(before.native)).toEqual([{ minimized: true, focused: false }]);
    await probe.eventually(output, { within: 10_000, label: "the native destination receives a mild nonzero audio signal",
      until: (state) => state.positiveSamples > before.output.positiveSamples && state.backgroundSamples > before.output.backgroundSamples });
    const measured = await output();
    expect(measured.running).toBe(true);
    expect(measured.peak).toBeGreaterThan(0.0001);
    expect(measured.peak).toBeLessThanOrEqual(0.05);
    await settle();
  };
  const quiet = async (before: Awaited<ReturnType<typeof baseline>>, duration = 2_000) => {
    const started = Date.now();
    await probe.eventually(async () => {
      expect((await native()).samples).toHaveLength(before.native);
      expect((await output()).bursts).toBe(before.output.bursts);
      return Date.now() - started;
    }, { within: duration + 3_000, label: "the task or pending request produces no extra audio", until: (elapsed) => elapsed >= duration });
  };
  const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/${world.engine === "v2" ? "opencode2/api" : "opencode"}`;
  const pending = async (kind: "question" | "permission", sessionId: string) => {
    const path = kind === "question" ? (world.engine === "v2" ? "/form/request" : "/question")
      : (world.engine === "v2" ? `/session/${sessionId}/permission` : "/permission");
    const result = await probe.desktopApi(`${mount}${path}`);
    expect(result.status).toBe(200);
    const body = world.engine === "v2" ? record(result.body).data : result.body;
    if (!Array.isArray(body)) throw new Error("Missing pending native requests.");
    return body.map(record).filter((item) => item.sessionID === sessionId).map((item) => String(item.id));
  };
  const waitPending = (kind: "question" | "permission", sessionId: string) => probe.eventually(() => pending(kind, sessionId), {
    within: 30_000, label: `the new native ${kind} request is pending`, until: (requests) => requests.length === 1,
  });
  const answerQuestion = async () => {
    await foreground();
    const completedBefore = (await world.mock.agentRequests({ promptMarker: world.question.prompt })).filter((call) => call.kind === "final").length;
    await user.click({ role: "button", label: /^Sound checklist/ });
    await probe.eventually(() => pending("question", world.questionSession.sessionId), { within: 30_000,
      label: "answering settles the native question", until: (requests) => requests.length === 0 });
    await probe.eventually(() => world.mock.agentRequests({ promptMarker: world.question.prompt }), { within: 30_000,
      label: "the answered question task finishes", until: (requests) => requests.filter((call) => call.kind === "final").length > completedBefore });
  };
  const allowPermission = async () => {
    await foreground();
    const completedBefore = (await world.mock.agentRequests({ promptMarker: world.permission.prompt })).filter((call) => call.kind === "final").length;
    await user.click("Allow once");
    await user.see({ text: world.permission.reply }, { timeoutMs: 45_000 });
    await probe.eventually(() => pending("permission", world.permissionSession.sessionId), { within: 30_000,
      label: "the approved request is settled", until: (requests) => requests.length === 0 });
    await probe.eventually(() => world.mock.agentRequests({ promptMarker: world.permission.prompt }), { within: 30_000,
      label: "the approved task finishes", until: (requests) => requests.filter((call) => call.kind === "final").length > completedBefore });
  };

  try {
    await step("sounds start enabled while desktop popups are off", async () => {
      await preferences();
      const defaults = await probe.eval(() => {
        const toggle = document.querySelector<HTMLElement>('[role="switch"][aria-label="Soft notification sounds"]');
        const mode = document.querySelector<HTMLElement>('[aria-label="Notify me"]');
        return { sounds: toggle?.getAttribute("aria-checked"), desktop: mode?.textContent?.trim() };
      });
      expect(defaults).toEqual({ sounds: "true", desktop: "Off" });
      await user.screenshot();
    });

    await step("a finished background task plays one short soft chime", async () => {
      await open(world.backgroundSession);
      const task = world.completed[0];
      if (!task) throw new Error("Missing background completion workload.");
      const before = await baseline();
      await send(task.prompt, true);
      await user.see({ text: task.reply }, { timeoutMs: 45_000 });
      await expectSound(before);
      const after = await baseline();
      await quiet(after);
      expect((await world.mock.agentRequests({ promptMarker: task.prompt })).filter((call) => call.kind === "final")).toHaveLength(1);
    });

    await step("a visible completed task stays silent", async () => {
      await open(world.foregroundSession);
      const task = world.completed[1];
      if (!task) throw new Error("Missing foreground completion workload.");
      const before = await baseline();
      await send(task.prompt, false);
      await user.see({ text: task.reply }, { timeoutMs: 45_000 });
      expect((await native()).focused).toBe(true);
      await quiet(before);
    });

    await step("a real question chimes once and reload does not repeat it", async () => {
      await open(world.questionSession);
      const before = await baseline();
      await send(world.question.prompt, true);
      await user.see({ text: world.question.text }, { timeoutMs: 45_000 });
      const requests = await waitPending("question", world.questionSession.sessionId);
      expect(requests).toHaveLength(1);
      await expectSound(before);
      const after = await baseline();
      // Native sync/poll reads keep the identical request pending without new sound.
      await quiet(after, 3_000);
      expect(await pending("question", world.questionSession.sessionId)).toEqual(requests);
      await user.reload();
      await user.see({ text: world.question.text }, { timeoutMs: 45_000 });
      expect((await native()).minimized).toBe(true);
      expect(await pending("question", world.questionSession.sessionId)).toEqual(requests);
      const restored = await baseline();
      expect(restored.native).toBe(after.native);
      expect(restored.output.bursts).toBe(0);
      await quiet(restored, 3_000);
      await answerQuestion();
    });

    await step("a real permission request plays the attention chime without repeating", async () => {
      await open(world.permissionSession);
      const before = await baseline();
      await send(world.permission.prompt, true);
      await user.see({ text: world.permission.command }, { timeoutMs: 45_000 });
      const requests = await waitPending("permission", world.permissionSession.sessionId);
      expect(requests).toHaveLength(1);
      await expectSound(before);
      await quiet(await baseline(), 3_000);
      expect(await pending("permission", world.permissionSession.sessionId)).toEqual(requests);
      await allowPermission();
      await user.screenshot();
    });

    await step("visible questions and approvals also stay silent", async () => {
      await open(world.questionSession);
      let before = await baseline();
      await send(world.question.prompt, false);
      await user.see({ text: world.question.text }, { timeoutMs: 45_000 });
      expect(await waitPending("question", world.questionSession.sessionId)).toHaveLength(1);
      expect((await native()).focused).toBe(true);
      await quiet(before);
      await answerQuestion();
      await open(world.permissionSession);
      before = await baseline();
      await send(world.permission.prompt, false);
      await user.see("Allow once", { timeoutMs: 45_000 });
      expect(await waitPending("permission", world.permissionSession.sessionId)).toHaveLength(1);
      expect((await native()).focused).toBe(true);
      await quiet(before);
      await allowPermission();
    });

    await step("muting through Preferences persists and silences a background completion", async () => {
      await preferences();
      await user.click({ role: "switch", label: "Soft notification sounds" });
      expect(await probe.eval(() => document.querySelector('[role="switch"][aria-label="Soft notification sounds"]')?.getAttribute("aria-checked"))).toBe("false");
      await user.reload();
      await user.see({ role: "switch", label: "Soft notification sounds" }, { timeoutMs: 45_000 });
      expect(await probe.eval(() => document.querySelector('[role="switch"][aria-label="Soft notification sounds"]')?.getAttribute("aria-checked"))).toBe("false");
      await open(world.mutedSession);
      const task = world.completed[2];
      if (!task) throw new Error("Missing muted completion workload.");
      const before = await baseline();
      await send(task.prompt, true);
      await user.see({ text: task.reply }, { timeoutMs: 45_000 });
      expect((await native()).minimized).toBe(true);
      await quiet(before);
      expect((await world.mock.agentRequests({ promptMarker: task.prompt })).filter((call) => call.kind === "final")).toHaveLength(1);
    });

    await step("muted background questions and approvals stay silent and remain answerable", async () => {
      await open(world.questionSession);
      let before = await baseline();
      await send(world.question.prompt, true);
      await user.see({ text: world.question.text }, { timeoutMs: 45_000 });
      expect(await waitPending("question", world.questionSession.sessionId)).toHaveLength(1);
      expect((await native()).minimized).toBe(true);
      await quiet(before);
      await answerQuestion();
      await open(world.permissionSession);
      before = await baseline();
      await send(world.permission.prompt, true);
      await user.see("Allow once", { timeoutMs: 45_000 });
      expect(await waitPending("permission", world.permissionSession.sessionId)).toHaveLength(1);
      expect((await native()).minimized).toBe(true);
      await quiet(before);
      await allowPermission();
    });
  } finally {
    await world.nativeWindow("foreground");
    world.closeWitness();
  }
});
