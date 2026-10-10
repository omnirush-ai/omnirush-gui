import assert from "node:assert/strict";
import test from "node:test";

import { TURN_GUARD_BUTTONS, TURN_GUARD_DETAIL, TURN_GUARD_TITLE, createQuitGuard, createTurnGuard } from "./turn-guard.mjs";

function fakeEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

/** A dialog the test answers: `answer(index)`; an abort resolves it with the cancel button, as Electron does. */
function setup() {
  const dialogs = [];
  const guard = createTurnGuard({
    getWindow: () => /** @type {any} */ ("win"),
    showMessageBox: (win, options) => new Promise((resolve) => {
      const dialog = { win, options, answer: (response) => resolve({ response }), aborted: false };
      options.signal?.addEventListener("abort", () => {
        dialog.aborted = true;
        resolve({ response: options.cancelId });
      });
      dialogs.push(dialog);
    }),
  });
  return { guard, dialogs };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("no turn running: quit and close go ahead without asking", () => {
  const { guard, dialogs } = setup();
  const event = fakeEvent();
  assert.equal(guard.guardQuit(event, () => assert.fail("no re-quit")), true);
  assert.equal(guard.guardClose(fakeEvent(), () => assert.fail("no re-close")), true);
  assert.equal(event.prevented, false);
  assert.equal(dialogs.length, 0);
});

test("a turn running: the first quit asks, with Wait for it as the default", async () => {
  const { guard, dialogs } = setup();
  guard.setTurnRunning(true);
  const event = fakeEvent();
  let quits = 0;
  assert.equal(guard.guardQuit(event, () => { quits += 1; }), false);
  assert.equal(event.prevented, true);
  assert.equal(dialogs.length, 1);
  const { options } = dialogs[0];
  assert.equal(options.message, "A turn is still running.");
  assert.equal(options.detail, "Quit now and this session won't count as a Good session ★.");
  assert.deepEqual(options.buttons, ["Wait for it", "Quit anyway"]);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  dialogs[0].answer(0);
  await settle();
  assert.equal(quits, 0, "Wait for it keeps the app open");
});

test("quit, Wait for it, quit again: the second quit quits without asking", async () => {
  const { guard, dialogs } = setup();
  guard.setTurnRunning(true);
  guard.guardQuit(fakeEvent(), () => assert.fail("waited"));
  dialogs[0].answer(0);
  await settle();
  const again = fakeEvent();
  assert.equal(guard.guardQuit(again, () => assert.fail("no dialog")), true);
  assert.equal(again.prevented, false);
  assert.equal(dialogs.length, 1);
});

test("a second quit while the dialog is open quits and closes the dialog", async () => {
  const { guard, dialogs } = setup();
  guard.setTurnRunning(true);
  let proceeded = 0;
  guard.guardClose(fakeEvent(), () => { proceeded += 1; });
  const second = fakeEvent();
  assert.equal(guard.guardQuit(second, () => assert.fail("no second dialog")), true);
  assert.equal(second.prevented, false);
  await settle();
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].aborted, true);
  assert.equal(proceeded, 0, "the first request does not run twice");
});

test("Quit anyway quits; the quit that follows (close → last window → before-quit) is not asked again", async () => {
  const { guard, dialogs } = setup();
  guard.setTurnRunning(true);
  let closes = 0;
  guard.guardClose(fakeEvent(), () => { closes += 1; });
  dialogs[0].answer(1);
  await settle();
  assert.equal(closes, 1);
  assert.equal(guard.guardClose(fakeEvent(), () => assert.fail("asked")), true);
  assert.equal(guard.guardQuit(fakeEvent(), () => assert.fail("asked")), true);
  assert.equal(dialogs.length, 1);
});

test("the turn ending re-arms the guard: an aborted quit leaves later turns guarded", async () => {
  const { guard, dialogs } = setup();
  guard.setTurnRunning(true);
  guard.guardQuit(fakeEvent(), () => undefined);
  dialogs[0].answer(0);
  await settle();
  guard.setTurnRunning(false);
  assert.equal(guard.guardQuit(fakeEvent(), () => assert.fail("idle")), true, "no turn: quits");
  guard.setTurnRunning(true);
  assert.equal(guard.guardQuit(fakeEvent(), () => undefined), false, "the next turn asks again");
  assert.equal(dialogs.length, 2);
});

test("OS shutdown, updater installs and relaunches (allowQuit) never ask", async () => {
  const { guard, dialogs } = setup();
  guard.setTurnRunning(true);
  guard.allowQuit();
  const event = fakeEvent();
  assert.equal(guard.guardQuit(event, () => assert.fail("asked")), true);
  assert.equal(guard.guardClose(fakeEvent(), () => assert.fail("asked")), true);
  assert.equal(event.prevented, false);
  assert.equal(dialogs.length, 0);
});

test("allowQuit while the dialog is open closes it", async () => {
  const { guard, dialogs } = setup();
  guard.setTurnRunning(true);
  guard.guardQuit(fakeEvent(), () => assert.fail("the shutdown quits on its own"));
  guard.allowQuit();
  await settle();
  assert.equal(dialogs[0].aborted, true);
});

test("restoreQuit after an update install that did not start asks again", () => {
  const { guard, dialogs } = setup();
  guard.setTurnRunning(true);
  guard.allowQuit();
  guard.restoreQuit();
  const event = fakeEvent();
  assert.equal(guard.guardQuit(event, () => {}), false);
  assert.equal(event.prevented, true);
  assert.equal(dialogs.length, 1);
});

test("only a strict true marks a turn running", () => {
  const { guard } = setup();
  assert.equal(guard.setTurnRunning("yes"), false);
  assert.equal(guard.setTurnRunning(true), true);
  assert.equal(guard.isTurnRunning(), true);
});

test("createQuitGuard: idle → asking → waiting; any second request quits; turnEnded re-arms", () => {
  const quit = createQuitGuard();
  assert.equal(quit.request({ running: false }), "quit");
  assert.equal(quit.request({ running: true, interactive: false }), "quit");
  assert.equal(quit.request({ running: true, hangup: true }), "quit");
  assert.equal(quit.request({ running: true }), "ask");
  assert.equal(quit.state, "asking");
  assert.equal(quit.request({ running: true }), "quit", "a second request while asking");
  assert.equal(quit.answer(true), "wait");
  assert.equal(quit.state, "waiting");
  assert.equal(quit.request({ running: true }), "quit", "a second request after Wait for it");
  assert.equal(quit.turnEnded(), true);
  assert.equal(quit.state, "idle");
  assert.equal(quit.request({ running: true }), "ask");
  assert.equal(quit.answer(false), "quit");
});

test("constants", () => {
  assert.equal(TURN_GUARD_TITLE, "A turn is still running.");
  assert.match(TURN_GUARD_DETAIL, /Good session ★/);
  assert.deepEqual([...TURN_GUARD_BUTTONS], ["Wait for it", "Quit anyway"]);
});
