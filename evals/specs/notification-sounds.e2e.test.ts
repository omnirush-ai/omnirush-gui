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
  if (!Array.isArray(state.focusEvents)) throw new Error("Missing native focus events.");
  return { at: Number(state.at), minimized: state.minimized === true, focused: state.focused === true, audible: state.audible === true,
    samples: state.samples.map((value: unknown) => {
      const sample = record(value);
      return { at: Number(sample.at), minimized: sample.minimized === true, focused: sample.focused === true };
    }),
    focusEvents: state.focusEvents.map((value: unknown) => {
      const event = record(value);
      return { at: Number(event.at), event: String(event.event), minimized: event.minimized === true, focused: event.focused === true };
    }) };
}

test("soft chimes tell a background user that a task finished or needs input, and respect mute", async ({ world, user, probe, step, evidence }) => {
  const prove = (claim: string, facts: unknown) => evidence.recordAssertionEvidence(claim, JSON.stringify(facts), true);
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
  let controlledModelVerified = false;
  const open = async () => {
    await foreground();
    if ((await probe.hash()).includes("/settings")) {
      await user.click({ role: "button", label: "Back to app" });
    }
    await probe.eventually(() => probe.hash(), { within: 15_000, label: "the sound conversation opens",
      until: (hash) => hash.includes(`/session/${world.session.sessionId}`) });
    await user.see("composer", { editable: true });
    if (!controlledModelVerified) {
      await user.see({ text: "Split send model" });
      const selectedModel = await probe.eventually(() => probe.eval(() => [...document.querySelectorAll("button")]
        .map((node) => node.textContent?.trim()).find((text) => text?.startsWith("Split send model"))), {
        within: 15_000, label: "the controlled model is selected for the initial trial",
        until: (text) => text === "Split send model· Split send mock",
      });
      expect(selectedModel).toBe("Split send model· Split send mock");
      prove("The conversation uses the real selected controlled-provider model", { selectedModel, sessionId: world.session.sessionId });
      controlledModelVerified = true;
    }
  };
  const send = async (prompt: string, background: boolean) => {
    if (!background) await foreground();
    await user.type("composer", prompt, { verify: true });
    const focusedStart = await native();
    expect(focusedStart.focused).toBe(true);
    await user.press("Enter");
    if (background) await minimize();
    return focusedStart.focusEvents.length;
  };
  const baseline = async () => {
    await settle();
    const state = await native();
    return { native: state.samples.length, focusEventCount: state.focusEvents.length, output: await output() };
  };
  const expectSound = async (before: Awaited<ReturnType<typeof baseline>>, claim: string) => {
    await probe.eventually(native, { within: 15_000, label: "Chromium reports real audible output while minimized",
      until: (state) => state.samples.length > before.native });
    const state = await native();
    expect(state.samples.slice(before.native).map(({ minimized, focused }) => ({ minimized, focused })))
      .toEqual([{ minimized: true, focused: false }]);
    await probe.eventually(output, { within: 10_000, label: "the native destination receives a mild nonzero audio signal",
      until: (state) => state.positiveSamples > before.output.positiveSamples && state.backgroundSamples > before.output.backgroundSamples });
    const measured = await output();
    expect(measured.running).toBe(true);
    expect(measured.peak).toBeGreaterThan(0.0001);
    expect(measured.peak).toBeLessThanOrEqual(0.05);
    await settle();
    prove(claim, { nativeRisingEdges: state.samples.slice(before.native), output: measured,
      positiveSampleDelta: measured.positiveSamples - before.output.positiveSamples,
      backgroundSampleDelta: measured.backgroundSamples - before.output.backgroundSamples,
      peakScope: "per note forwarding tap", silentAfterward: !(await native()).audible });
  };
  const quiet = async (before: Awaited<ReturnType<typeof baseline>>, claim: string, duration = 2_000, foregroundTrial = false) => {
    const started = Date.now();
    await probe.eventually(async () => {
      expect((await native()).samples).toHaveLength(before.native);
      expect((await output()).bursts).toBe(before.output.bursts);
      return Date.now() - started;
    }, { within: duration + 3_000, label: "the task or pending request produces no extra audio", until: (elapsed) => elapsed >= duration });
    const after = { native: await native(), output: await output() };
    const focusEvents = after.native.focusEvents.slice(before.focusEventCount);
    if (foregroundTrial) {
      expect(after.native.focused).toBe(true);
      expect(after.native.minimized).toBe(false);
      expect(focusEvents.filter((event) => event.event === "blur" || event.event === "minimize")).toEqual([]);
      expect(await probe.eval(() => document.visibilityState === "visible" && document.hasFocus())).toBe(true);
    }
    prove(claim, { durationMs: Date.now() - started, nativeRisingEdgeDelta: after.native.samples.length - before.native,
      outputBurstDelta: after.output.bursts - before.output.bursts, minimized: after.native.minimized, focused: after.native.focused,
      foregroundTrial, focusEvents });
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
    await probe.eventually(() => pending("question", world.session.sessionId), { within: 30_000,
      label: "answering settles the native question", until: (requests) => requests.length === 0 });
    await probe.eventually(() => world.mock.agentRequests({ promptMarker: world.question.prompt }), { within: 30_000,
      label: "the answered question task finishes", until: (requests) => requests.filter((call) => call.kind === "final").length > completedBefore });
    prove("The real question remains answerable and settles after choosing Sound checklist", {
      pending: await pending("question", world.session.sessionId),
      completedDelta: (await world.mock.agentRequests({ promptMarker: world.question.prompt })).filter((call) => call.kind === "final").length - completedBefore,
    });
  };
  const allowPermission = async () => {
    await foreground();
    const completedBefore = (await world.mock.agentRequests({ promptMarker: world.permission.prompt })).filter((call) => call.kind === "final").length;
    await user.click("Allow once");
    await user.see({ text: world.permission.reply }, { timeoutMs: 45_000 });
    await probe.eventually(() => pending("permission", world.session.sessionId), { within: 30_000,
      label: "the approved request is settled", until: (requests) => requests.length === 0 });
    await probe.eventually(() => world.mock.agentRequests({ promptMarker: world.permission.prompt }), { within: 30_000,
      label: "the approved task finishes", until: (requests) => requests.filter((call) => call.kind === "final").length > completedBefore });
    prove("The real permission remains answerable and settles after Allow once", {
      pending: await pending("permission", world.session.sessionId),
      completedDelta: (await world.mock.agentRequests({ promptMarker: world.permission.prompt })).filter((call) => call.kind === "final").length - completedBefore,
    });
  };

  try {
    await step("sounds start enabled while desktop popups are off", async () => {
      await preferences();
      const defaults = await probe.eval(() => {
        const toggle = document.querySelector<HTMLElement>('[role="switch"][aria-label="Soft notification sounds"]');
        const mode = document.querySelector<HTMLElement>('[aria-label="Notify me"]');
        return { sounds: toggle?.getAttribute("aria-checked"), desktop: mode?.querySelector('[data-slot="select-value"]')?.textContent?.trim() };
      });
      await user.screenshot();
      expect(defaults).toEqual({ sounds: "true", desktop: "Off" });
      prove("Soft sounds default on while desktop popups default Off", { ...defaults, engine: world.engine,
        fixtureEnv: { OMNIRUSH_DEV_MODE: "1", OMNIRUSH_SESSION_UPLOAD_OPTIONAL: "1", VITE_OMNIRUSH_ALLOW_OTHER_PROVIDERS: "1" },
        scope: "Session collection is optional for these controlled-provider fixtures; Den login and policy remain active." });
    });

    await step("a finished background task plays one short soft chime", async () => {
      await open();
      const task = world.completed[0];
      if (!task) throw new Error("Missing background completion workload.");
      const before = await baseline();
      await send(task.prompt, true);
      await user.see({ text: task.reply }, { timeoutMs: 45_000 });
      await expectSound(before, "A real background completion plays one mild native chime");
      const after = await baseline();
      await quiet(after, "The completed background task does not repeat its chime");
      const finals = (await world.mock.agentRequests({ promptMarker: task.prompt })).filter((call) => call.kind === "final");
      expect(finals).toHaveLength(1);
      prove("The background completion came from one real mocked provider final response", { finalResponses: finals.length, sessionId: world.session.sessionId });
    });

    await step("a visible completed task stays silent", async () => {
      await open();
      const task = world.completed[1];
      if (!task) throw new Error("Missing foreground completion workload.");
      const before = await baseline();
      before.focusEventCount = await send(task.prompt, false);
      await user.see({ text: task.reply }, { timeoutMs: 45_000 });
      expect((await native()).focused).toBe(true);
      await quiet(before, "A visible real completion stays silent", 2_000, true);
    });

    await step("a real question chimes once and reload does not repeat it", async () => {
      await open();
      const before = await baseline();
      await send(world.question.prompt, true);
      await user.see({ text: world.question.text }, { timeoutMs: 45_000 });
      const requests = await waitPending("question", world.session.sessionId);
      expect(requests).toHaveLength(1);
      await expectSound(before, "A real background question plays one mild native attention chime");
      const after = await baseline();
      // Native sync/poll reads keep the identical request pending without new sound.
      await quiet(after, "The same pending background question does not repeat its chime", 3_000);
      expect(await pending("question", world.session.sessionId)).toEqual(requests);
      await user.reload();
      await user.see({ text: world.question.text }, { timeoutMs: 45_000 });
      expect((await native()).minimized).toBe(true);
      expect(await pending("question", world.session.sessionId)).toEqual(requests);
      const restored = await baseline();
      expect(restored.native).toBe(after.native);
      expect(restored.output.bursts).toBe(0);
      prove("Reload preserves the same native pending question without replaying audio", {
        requestIdsBefore: requests, requestIdsAfter: await pending("question", world.session.sessionId),
        nativeRisingEdgesBefore: after.native, nativeRisingEdgesAfter: restored.native, rendererBurstsAfterReload: restored.output.bursts,
      });
      await quiet(restored, "The restored pending background question stays silent", 3_000);
      await answerQuestion();
    });

    await step("a real permission request plays the attention chime without repeating", async () => {
      await open();
      const before = await baseline();
      await send(world.permission.prompt, true);
      await user.see({ text: world.permission.command }, { timeoutMs: 45_000 });
      const requests = await waitPending("permission", world.session.sessionId);
      expect(requests).toHaveLength(1);
      await expectSound(before, "A real background permission plays one mild native attention chime");
      await quiet(await baseline(), "The same pending background permission does not repeat its chime", 3_000);
      expect(await pending("permission", world.session.sessionId)).toEqual(requests);
      prove("The permission stays pending with the identical native request ID", { requestIds: requests });
      await allowPermission();
      await user.screenshot();
    });

    await step("visible questions and approvals also stay silent", async () => {
      await open();
      let before = await baseline();
      before.focusEventCount = await send(world.question.prompt, false);
      await user.see({ text: world.question.text }, { timeoutMs: 45_000 });
      expect(await waitPending("question", world.session.sessionId)).toHaveLength(1);
      expect((await native()).focused).toBe(true);
      await quiet(before, "A visible real question stays silent", 2_000, true);
      await answerQuestion();
      await open();
      before = await baseline();
      before.focusEventCount = await send(world.permission.prompt, false);
      await user.see("Allow once", { timeoutMs: 45_000 });
      expect(await waitPending("permission", world.session.sessionId)).toHaveLength(1);
      expect((await native()).focused).toBe(true);
      await quiet(before, "A visible real permission stays silent", 2_000, true);
      await allowPermission();
    });

    await step("muting through Preferences persists and silences a background completion", async () => {
      await preferences();
      await user.click({ role: "switch", label: "Soft notification sounds" });
      expect(await probe.eval(() => document.querySelector('[role="switch"][aria-label="Soft notification sounds"]')?.getAttribute("aria-checked"))).toBe("false");
      await user.reload();
      await user.see({ role: "switch", label: "Soft notification sounds" }, { timeoutMs: 45_000 });
      const sounds = await probe.eval(() => document.querySelector('[role="switch"][aria-label="Soft notification sounds"]')?.getAttribute("aria-checked"));
      expect(sounds).toBe("false");
      prove("Muting in Preferences survives a real renderer reload", { sounds });
      await open();
      const task = world.completed[2];
      if (!task) throw new Error("Missing muted completion workload.");
      const before = await baseline();
      await send(task.prompt, true);
      await user.see({ text: task.reply }, { timeoutMs: 45_000 });
      expect((await native()).minimized).toBe(true);
      await quiet(before, "A muted real background completion stays silent");
      const finals = (await world.mock.agentRequests({ promptMarker: task.prompt })).filter((call) => call.kind === "final");
      expect(finals).toHaveLength(1);
      prove("The muted completion still finishes through the real provider path", { finalResponses: finals.length, sessionId: world.session.sessionId });
    });

    await step("muted background questions and approvals stay silent and remain answerable", async () => {
      await open();
      let before = await baseline();
      await send(world.question.prompt, true);
      await user.see({ text: world.question.text }, { timeoutMs: 45_000 });
      expect(await waitPending("question", world.session.sessionId)).toHaveLength(1);
      expect((await native()).minimized).toBe(true);
      await quiet(before, "A muted real background question stays silent");
      await answerQuestion();
      await open();
      before = await baseline();
      await send(world.permission.prompt, true);
      await user.see("Allow once", { timeoutMs: 45_000 });
      expect(await waitPending("permission", world.session.sessionId)).toHaveLength(1);
      expect((await native()).minimized).toBe(true);
      await quiet(before, "A muted real background permission stays silent");
      await allowPermission();
    });
  } catch (error) {
    const state = await Promise.all([native(), output()]).catch(() => null);
    if (state) evidence.recordAssertionEvidence("The sound journey stopped before all claims passed", JSON.stringify({
      error: error instanceof Error ? error.message : String(error), native: state[0], output: state[1],
    }), false);
    await user.screenshot().catch(() => undefined);
    throw error;
  } finally {
    await world.nativeWindow("foreground");
    world.closeWitness();
  }
});
