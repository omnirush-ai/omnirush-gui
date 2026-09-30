import { expect, mock, test } from "bun:test";
import type { SessionGoalCommand } from "@omnirush/types";
import type { ComposerDraft } from "../src/app/types";

import {
  canAdmitNextQueuedItem,
  assertQueuedSendCurrent,
  claimQueuedSend,
  dispatchQueuedDrain,
  getQueuedDrainState,
  getQueuedSendGeneration,
  INITIAL_QUEUED_DRAIN_STATE,
  nextObservationProbeAt,
  QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS,
  QUEUE_ADMISSION_PROBE_RETRY_MS,
  reduceQueuedDrain,
  resetQueuedDrainForTests,
  subscribeQueuedDrain,
  type QueuedDrainState,
} from "../src/react-app/domains/session/surface/queued-drain-machine";

// The queued-message drain protocol lives entirely in the admission-aware
// machine these tests drive; session-surface.tsx is a thin adapter that maps
// engine status levels and send outcomes onto these events. Each scenario
// asserts both the progress claim and its negative half: what must NOT allow
// the next queued item to be sent.

const t0 = 1_000_000;

test("a goal control releases its queue claim without waiting for a run", () => {
  let state = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "goal-pause" });
  expect(canAdmitNextQueuedItem(state)).toBe(false);
  expect(reduceQueuedDrain(state, { type: "control_completed", itemId: "other" })).toBe(state);
  state = reduceQueuedDrain(state, { type: "control_completed", itemId: "goal-pause" });
  expect(canAdmitNextQueuedItem(state)).toBe(true);
  expect(nextObservationProbeAt(state, null)).toBeNull();
  expect(state.attemptsByItemId).toEqual({});
  expect(state.lastResolution).toEqual({ itemId: "goal-pause", resolution: "completed" });
});

test("an immediate follow-up cannot inherit its interrupted predecessor's busy observation", () => {
  let state = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "old" });
  state = reduceQueuedDrain(state, { type: "busy_observed" });
  state = reduceQueuedDrain(state, { type: "send_result", itemId: "old", outcome: "sent", at: t0 });
  expect(canAdmitNextQueuedItem(reduceQueuedDrain(state, { type: "stop_confirmed" }))).toBe(true);
  state = reduceQueuedDrain(state, { type: "send_started", itemId: "new", steer: true });
  state = reduceQueuedDrain(state, { type: "busy_observed" });
  expect(state.phase).toEqual({ kind: "sending", itemId: "new", busySeen: true });
  state = reduceQueuedDrain(state, { type: "stop_confirmed" });
  expect(state.phase).toEqual({ kind: "sending", itemId: "new", busySeen: false });
  state = reduceQueuedDrain(state, { type: "send_result", itemId: "new", outcome: "sent", at: t0 + 10 });
  expect(state.phase).toEqual({ kind: "awaiting_observation", itemId: "new", admittedAt: t0 + 10 });
  expect(reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: t0 })).toBe(state);
  expect(canAdmitNextQueuedItem(state)).toBe(false);
  state = reduceQueuedDrain(state, { type: "busy_observed" });
  state = reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: t0 + 20 });
  expect(canAdmitNextQueuedItem(state)).toBe(true);
});

function admit(state: QueuedDrainState, itemId: string, at: number): QueuedDrainState {
  const sending = reduceQueuedDrain(state, { type: "send_started", itemId });
  expect(sending.phase).toEqual({ kind: "sending", itemId, busySeen: false });
  return reduceQueuedDrain(sending, { type: "send_result", itemId, outcome: "sent", at });
}

test("a dropped busy event after a successful admission cannot wedge the drain", () => {
  // Admission succeeds, but the engine's busy event never arrives (dropped
  // SSE event). The old boolean edge-wait stayed armed forever here.
  let state = admit(INITIAL_QUEUED_DRAIN_STATE, "item-1", t0);
  expect(state.phase).toEqual({ kind: "awaiting_observation", itemId: "item-1", admittedAt: t0 });
  expect(state.lastResolution).toEqual({ itemId: "item-1", resolution: "admitted_awaiting_observation" });

  // Negative half: while the admission is unobserved, nothing may drain — a
  // stale idle level observed BEFORE the admission must be dropped.
  expect(canAdmitNextQueuedItem(state)).toBe(false);
  const staleIdle = reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: t0 - 1 });
  expect(staleIdle).toBe(state);
  expect(canAdmitNextQueuedItem(staleIdle)).toBe(false);

  // The machine schedules an authoritative observation probe instead of
  // waiting on the missing edge forever.
  expect(nextObservationProbeAt(state, null)).toBe(t0 + QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS);

  // The probe observes an authoritative idle level at/after the admission:
  // the run started and finished between observations. The item completes
  // and the next queued item may be admitted.
  const probedAt = t0 + QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS;
  state = reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: probedAt });
  expect(state.lastResolution).toEqual({ itemId: "item-1", resolution: "completed" });
  expect(canAdmitNextQueuedItem(state)).toBe(true);
});

test("a message accepted by admission whose upstream dispatch fails still releases the queue", () => {
  // The admission call returned accepted, but dispatch never produced a run:
  // no busy level ever exists. Progress must not depend on the busy event.
  let state = admit(INITIAL_QUEUED_DRAIN_STATE, "item-1", t0);

  // No busy is ever observed. The first probe is inconclusive (endpoint
  // briefly unreachable) — retries stay bounded and spaced.
  const firstProbeAt = t0 + QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS;
  expect(nextObservationProbeAt(state, firstProbeAt)).toBe(firstProbeAt + QUEUE_ADMISSION_PROBE_RETRY_MS);

  // The retry probe reads the authoritative level: still idle, at a time
  // after the admission. The admitted-but-never-ran item cannot block the
  // queue: it resolves and the next item drains.
  state = reduceQueuedDrain(state, {
    type: "idle_reconciled",
    observedAt: firstProbeAt + QUEUE_ADMISSION_PROBE_RETRY_MS,
  });
  expect(state.lastResolution).toEqual({ itemId: "item-1", resolution: "completed" });
  expect(canAdmitNextQueuedItem(state)).toBe(true);

  // Only a definite rejection/preflight failure is retryable, and even that
  // requires explicit user action. An uncertain POST uses send_unknown.
  let failing = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "item-2" });
  failing = reduceQueuedDrain(failing, { type: "send_error", itemId: "item-2" });
  expect(failing.phase).toEqual({ kind: "halted", itemId: "item-2", reason: "terminal_failure" });
  expect(failing.lastResolution).toEqual({ itemId: "item-2", resolution: "terminal_failure" });
  // Negative half: a terminal failure never self-heals into a send.
  expect(canAdmitNextQueuedItem(failing)).toBe(false);
  // An explicit user retry — and only that — releases it.
  failing = reduceQueuedDrain(failing, { type: "user_retry" });
  expect(canAdmitNextQueuedItem(failing)).toBe(true);
});

test("unknown admission survives idle, busy, retry, Stop, and remount until the exact message is observed", () => {
  resetQueuedDrainForTests();
  const sessionId = "ses_unknown";
  expect(claimQueuedSend(sessionId, "item-1")).toBe(true);
  dispatchQueuedDrain(sessionId, { type: "send_unknown", itemId: "item-1", messageID: "msg_exact", at: t0 });
  const held = getQueuedDrainState(sessionId);
  const unsubscribe = subscribeQueuedDrain(sessionId, () => {});
  unsubscribe();
  for (const event of [
    { type: "idle_reconciled", observedAt: t0 + 60_000 },
    { type: "busy_observed" },
    { type: "user_retry" },
    { type: "queue_cleared" },
    { type: "admission_observed", itemId: "item-1", messageID: "msg_other", at: t0 + 1 },
    { type: "admission_observed", itemId: "item-other", messageID: "msg_exact", at: t0 + 1 },
  ] satisfies Parameters<typeof dispatchQueuedDrain>[1][]) {
    dispatchQueuedDrain(sessionId, event);
    expect(getQueuedDrainState(sessionId)).toBe(held);
    expect(claimQueuedSend(sessionId, "item-1", true)).toBe(false);
    expect(claimQueuedSend(sessionId, "item-2", true)).toBe(false);
  }
  expect(nextObservationProbeAt(held, null)).toBe(t0 + QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS);
  dispatchQueuedDrain(sessionId, { type: "admission_observed", itemId: "item-1", messageID: "msg_exact", at: t0 + 100_000 });
  expect(canAdmitNextQueuedItem(getQueuedDrainState(sessionId))).toBe(false);
  dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: t0 + 60_000 });
  expect(canAdmitNextQueuedItem(getQueuedDrainState(sessionId))).toBe(false);
  dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: t0 + 110_000 });
  expect(claimQueuedSend(sessionId, "item-2")).toBe(true);
  resetQueuedDrainForTests();
});

test("send now shares the current claim with the idle drain and every split pane", () => {
  resetQueuedDrainForTests();
  const sessionId = "ses_steer";
  expect(claimQueuedSend(sessionId, "item-1")).toBe(true);
  expect(claimQueuedSend(sessionId, "item-1", true)).toBe(false);
  expect(claimQueuedSend(sessionId, "item-2", true)).toBe(false);
  dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "item-1", outcome: "sent", at: t0 });
  expect(claimQueuedSend(sessionId, "item-1", true)).toBe(false);
  dispatchQueuedDrain(sessionId, { type: "busy_observed" });
  expect(claimQueuedSend(sessionId, "item-2", true)).toBe(true);
  expect(claimQueuedSend(sessionId, "item-2")).toBe(false);
  expect(claimQueuedSend(sessionId, "item-3", true)).toBe(false);
  dispatchQueuedDrain(sessionId, { type: "send_error", itemId: "item-2" });
  expect(claimQueuedSend(sessionId, "item-2")).toBe(false);
  expect(claimQueuedSend(sessionId, "item-3", true)).toBe(false);
  // Explicit Send now can retry a definite rejection, never an unknown POST.
  expect(claimQueuedSend(sessionId, "item-2", true)).toBe(true);
  resetQueuedDrainForTests();
});

test("Stop invalidates preflight and late requeue without erasing a possibly admitted POST", () => {
  resetQueuedDrainForTests();
  const sessionId = "ses_stop";
  expect(claimQueuedSend(sessionId, "item-1")).toBe(true);
  const generation = getQueuedSendGeneration(sessionId);
  assertQueuedSendCurrent(sessionId, generation);
  dispatchQueuedDrain(sessionId, { type: "queue_cleared" });
  expect(() => assertQueuedSendCurrent(sessionId, generation)).toThrow("Send cancelled by Stop.");
  expect(getQueuedSendGeneration(sessionId)).not.toBe(generation);
  expect(claimQueuedSend(sessionId, "item-2", true)).toBe(false);
  dispatchQueuedDrain(sessionId, { type: "send_unknown", itemId: "item-1", messageID: "msg_exact", at: t0 });
  expect(getQueuedDrainState(sessionId).phase.kind).toBe("admission_unknown");
  resetQueuedDrainForTests();
});

test("an event-stream disconnect and reconnect during admission is healed by level reconciliation", () => {
  // Busy can render before the send promise resolves; an admission must
  // attach that observation instead of losing it (fast engine, slow HTTP).
  let racing = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "item-1" });
  racing = reduceQueuedDrain(racing, { type: "busy_observed" });
  racing = reduceQueuedDrain(racing, { type: "send_result", itemId: "item-1", outcome: "sent", at: t0 });
  expect(racing.phase).toEqual({ kind: "running", itemId: "item-1" });
  expect(racing.lastResolution).toEqual({ itemId: "item-1", resolution: "admitted_running" });

  // Disconnect during admission: the stream dies right after the send is
  // admitted, so no live busy event ever arrives.
  let state = admit(INITIAL_QUEUED_DRAIN_STATE, "item-1", t0);
  expect(canAdmitNextQueuedItem(state)).toBe(false);

  // Reconnect path A: the reconnect-time status reconciliation reports the
  // session busy — the admission attaches to the running run, and only a
  // LATER observed idle completes it.
  const reconnectBusy = reduceQueuedDrain(state, { type: "busy_observed" });
  expect(reconnectBusy.phase).toEqual({ kind: "running", itemId: "item-1" });
  const finished = reduceQueuedDrain(reconnectBusy, { type: "idle_reconciled", observedAt: t0 + 20_000 });
  expect(finished.lastResolution).toEqual({ itemId: "item-1", resolution: "completed" });
  expect(canAdmitNextQueuedItem(finished)).toBe(true);

  // Reconnect path B: the run already finished while disconnected; the
  // reconciliation reports idle observed after the admission. That level —
  // not a busy edge — releases the item.
  const reconnectIdle = reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: t0 + 20_000 });
  expect(reconnectIdle.lastResolution).toEqual({ itemId: "item-1", resolution: "completed" });
  expect(canAdmitNextQueuedItem(reconnectIdle)).toBe(true);

  // Negative half: an idle captured before the admission (a snapshot fetched
  // pre-send that resolves late) must not release the admission.
  const staleIdle = reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: t0 - 5 });
  expect(staleIdle).toBe(state);
  expect(canAdmitNextQueuedItem(staleIdle)).toBe(false);
});

test("three queued items are admitted exactly once each and in order", () => {
  resetQueuedDrainForTests();
  const sessionId = "ses_fifo";
  const items = ["item-1", "item-2", "item-3"];
  const admitted: string[] = [];

  for (const [index, itemId] of items.entries()) {
    // The drain claims the send slot atomically before sending.
    expect(claimQueuedSend(sessionId, itemId)).toBe(true);
    admitted.push(itemId);

    // Negative half (exactly once): while this item is in flight — through
    // sending, admission, and the run itself — no other surface (for
    // example a split view of the same session) can claim another send.
    const rival = items[index + 1] ?? "item-extra";
    expect(claimQueuedSend(sessionId, rival)).toBe(false);
    dispatchQueuedDrain(sessionId, { type: "send_result", itemId, outcome: "sent", at: t0 + index * 100 });
    expect(claimQueuedSend(sessionId, rival)).toBe(false);
    dispatchQueuedDrain(sessionId, { type: "busy_observed" });
    expect(claimQueuedSend(sessionId, rival)).toBe(false);

    // The run finishes: an observed idle level completes the item.
    dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: t0 + index * 100 + 50 });
  }

  expect(admitted).toEqual(items);
  expect(canAdmitNextQueuedItem(getQueuedDrainState(sessionId))).toBe(true);
  resetQueuedDrainForTests();
});

test("an active admission survives navigating away and back", () => {
  resetQueuedDrainForTests();
  const sessionId = "ses_navigation";

  // The surface mounts, drains the first item, and observes its run start.
  const unsubscribe = subscribeQueuedDrain(sessionId, () => {});
  expect(claimQueuedSend(sessionId, "item-1")).toBe(true);
  dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "item-1", outcome: "sent", at: t0 });
  dispatchQueuedDrain(sessionId, { type: "busy_observed" });

  // Navigate away: the surface unmounts and its subscription is dropped.
  // Component-local refs would die here; the admission must not.
  unsubscribe();

  // Navigate back: a fresh surface reads the same in-flight admission.
  const remounted = getQueuedDrainState(sessionId);
  expect(remounted.phase).toEqual({ kind: "running", itemId: "item-1" });

  // Negative half: the remount briefly renders a fallback idle before any
  // status level is observed. The adapter never emits idle_reconciled for a
  // fallback, and the machine keeps the queue closed until a real level
  // arrives — the next item is not sent into the still-active run.
  expect(canAdmitNextQueuedItem(remounted)).toBe(false);
  expect(claimQueuedSend(sessionId, "item-2")).toBe(false);

  // The run completes and a real observed idle level arrives: the queue
  // reopens and the next item drains in order.
  dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: t0 + 30_000 });
  expect(claimQueuedSend(sessionId, "item-2")).toBe(true);
  resetQueuedDrainForTests();
});

test("blocked and cancelled sends classify as needs_input and rejected without wedging", () => {
  // Blocked by the pre-send gate: the user must act; drain halts loudly.
  let blocked = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "item-1" });
  blocked = reduceQueuedDrain(blocked, { type: "send_result", itemId: "item-1", outcome: "blocked", at: t0 });
  expect(blocked.phase).toEqual({ kind: "halted", itemId: "item-1", reason: "needs_input" });
  expect(blocked.lastResolution).toEqual({ itemId: "item-1", resolution: "needs_input" });
  expect(canAdmitNextQueuedItem(blocked)).toBe(false);
  const retried = reduceQueuedDrain(blocked, { type: "user_retry" });
  expect(canAdmitNextQueuedItem(retried)).toBe(true);

  // Cancelled (submission context changed): the item is rejected and
  // re-queued by the caller; the drain itself stays open.
  let cancelled = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "item-1" });
  cancelled = reduceQueuedDrain(cancelled, { type: "send_result", itemId: "item-1", outcome: "cancelled", at: t0 });
  expect(cancelled.lastResolution).toEqual({ itemId: "item-1", resolution: "rejected" });
  expect(canAdmitNextQueuedItem(cancelled)).toBe(true);

  // Stopping the queue clears a halted drain so the next queueing round
  // starts clean, but never erases a live admission.
  const cleared = reduceQueuedDrain(blocked, { type: "queue_cleared" });
  expect(cleared.phase).toEqual({ kind: "ready" });
  const live = admit(INITIAL_QUEUED_DRAIN_STATE, "item-9", t0);
  const running = reduceQueuedDrain(live, { type: "busy_observed" });
  expect(reduceQueuedDrain(running, { type: "queue_cleared" })).toBe(running);
});

test("the global watcher holds queued input and preflight, refreshes it, and orders release after slow writes", async () => {
  mock.module("@/react-app/domains/session/sync/session-sync", () => ({
    ensureWorkspaceSessionSync: () => () => {},
    trackWorkspaceSessionSync: () => () => {},
  }));
  mock.module("@/app/lib/opencode-session-native", () => ({
    composeNativeSessionSnapshot: async () => ({ status: { type: "busy" } }),
  }));
  const { createOmniRushServerClient } = await import("../src/app/lib/omnirush-server");
  const { startGlobalQueueDrainer, waitForQueuedGoalHold } = await import("../src/react-app/domains/session/sync/global-queue-drainer");
  const { useComposerStateStore } = await import("../src/react-app/domains/session/surface/composer-state-store");
  const { setQueuedSendContext, clearQueuedSendContext } = await import("../src/react-app/domains/session/sync/queued-send-context");
  const writes: { sessionId: string; holding: boolean; at: number }[] = [];
  let slowNext = false;
  let releaseSlow: (() => void) | null = null;
  const client = {
    ...createOmniRushServerClient({ baseUrl: "http://queue-goal-hold.test" }),
    getSessionGoal: async () => { throw new Error("Holds must not read a goal"); },
    commandSessionGoal: async (_workspaceId: string, sessionId: string, command: SessionGoalCommand) => {
      expect(command.action).toBe("hold");
      expect(typeof command.holding).toBe("boolean");
      writes.push({ sessionId, holding: command.holding === true, at: Date.now() });
      if (slowNext && command.holding) {
        slowNext = false;
        await new Promise<void>((resolve) => { releaseSlow = resolve; });
      }
      return { goal: null };
    },
  };
  const context = {
    workspaceId: "workspace-hold", workspaceRoot: "/tmp/queue-hold", opencodeBaseUrl: "http://queue-goal-hold.test/opencode",
    omnirushToken: "test-token", client, agent: null, variant: null, model: null, environmentRuntimeKey: null,
  };
  const draft: ComposerDraft = { mode: "prompt", parts: [{ type: "text", text: "User work goes first" }], text: "User work goes first", attachments: [] };
  const waitForHold = async (predicate: () => boolean, timeoutMs = 1_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the goal hold");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  };
  const forSession = (sessionId: string) => writes.filter((write) => write.sessionId === sessionId);
  resetQueuedDrainForTests();
  useComposerStateStore.setState({ queuedDrafts: {} });
  const stop = startGlobalQueueDrainer();
  try {
    const queued = "hold-queued";
    useComposerStateStore.getState().appendQueuedDraft(queued, draft);
    setQueuedSendContext(queued, context);
    await waitForHold(() => forSession(queued).length === 1);
    expect(forSession(queued)[0]?.holding).toBe(true);
    await waitForHold(() => forSession(queued).length === 2, 6_000);
    expect(forSession(queued).every((write) => write.holding)).toBe(true);
    expect(forSession(queued)[1].at - forSession(queued)[0].at).toBeGreaterThanOrEqual(4_500);
    useComposerStateStore.getState().clearQueuedDrafts(queued);
    await waitForHold(() => forSession(queued).at(-1)?.holding === false);

    const preflight = "hold-preflight";
    expect(claimQueuedSend(preflight, "preflight-message")).toBe(true);
    setQueuedSendContext(preflight, context);
    await waitForQueuedGoalHold(preflight);
    expect(forSession(preflight).map((write) => write.holding)).toEqual([true]);
    dispatchQueuedDrain(preflight, { type: "send_unknown", itemId: "preflight-message", messageID: "unknown-message", at: Date.now() });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(forSession(preflight).map((write) => write.holding)).toEqual([true]);
    dispatchQueuedDrain(preflight, { type: "admission_observed", itemId: "preflight-message", messageID: "unknown-message", at: Date.now() });
    await waitForHold(() => forSession(preflight).at(-1)?.holding === false);

    const slow = "hold-slow";
    slowNext = true;
    useComposerStateStore.getState().appendQueuedDraft(slow, draft);
    setQueuedSendContext(slow, context);
    await waitForHold(() => forSession(slow).length === 1);
    setQueuedSendContext(slow, { ...context, agent: "build" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(forSession(slow).map((write) => write.holding)).toEqual([true]);
    releaseSlow?.();
    await waitForHold(() => forSession(slow).length === 3);
    expect(forSession(slow).map((write) => write.holding)).toEqual([true, false, true]);
    useComposerStateStore.getState().clearQueuedDrafts(slow);
    dispatchQueuedDrain(slow, { type: "queue_cleared" });
    await waitForHold(() => forSession(slow).at(-1)?.holding === false);
    expect(forSession(slow).map((write) => write.holding)).toEqual([true, false, true, false]);

    const stopped = "hold-stopped";
    expect(claimQueuedSend(stopped, "stopped-message")).toBe(true);
    setQueuedSendContext(stopped, context);
    await waitForQueuedGoalHold(stopped);
    dispatchQueuedDrain(stopped, { type: "queue_cleared" });
    await waitForHold(() => forSession(stopped).at(-1)?.holding === false);
    expect(getQueuedDrainState(stopped).phase.kind).toBe("sending");

    const unmounted = "hold-watcher-end";
    useComposerStateStore.getState().appendQueuedDraft(unmounted, draft);
    setQueuedSendContext(unmounted, context);
    await waitForQueuedGoalHold(unmounted);
    stop();
    await waitForHold(() => forSession(unmounted).at(-1)?.holding === false);
    expect(forSession(unmounted).map((write) => write.holding)).toEqual([true, false]);
  } finally {
    releaseSlow?.();
    stop();
    for (const sessionId of ["hold-queued", "hold-preflight", "hold-slow", "hold-stopped", "hold-watcher-end"]) clearQueuedSendContext(sessionId);
    useComposerStateStore.setState({ queuedDrafts: {} });
    resetQueuedDrainForTests();
    mock.restore();
  }
}, 10_000);
