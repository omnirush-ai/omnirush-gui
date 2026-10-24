import assert from "node:assert/strict";
import test from "node:test";

import { createHostGate } from "./computer-use-gate.mjs";

test("computer use gate: off during a start makes it stale, a later start is current", () => {
  const gate = createHostGate();
  const first = gate.begin();
  assert.equal(gate.current(first), true);
  gate.revoke(); // turned off while the first start awaits the host
  assert.equal(gate.current(first), false, "the first start must not publish");
  const second = gate.begin();
  assert.equal(gate.current(second), true);
  assert.equal(gate.current(first), false);
});

test("computer use gate: repeated starts after off never revive the old one", () => {
  const gate = createHostGate();
  const taken = [];
  for (let i = 0; i < 5; i += 1) { taken.push(gate.begin()); gate.revoke(); }
  assert.ok(taken.every((g) => !gate.current(g)));
});

test("computer use gate: an older state answer cannot undo a newer one", () => {
  const gate = createHostGate();
  const slowOn = gate.ask(); // sent first, answers late (still on)
  const quickOff = gate.ask(); // sent second, answers first (off)
  assert.equal(gate.fresh(quickOff), true);
  assert.equal(gate.fresh(slowOn), false, "the stale 'on' is dropped");
  const next = gate.ask();
  assert.equal(gate.fresh(next), true);
  assert.equal(gate.fresh(next), true, "the same answer may be applied again");
});

// The host start as computer-use.mjs runs it, with a fake host: off during the delayed start leaves nothing
// published (no host, no listener, no host.json), and the fake's close ran.
test("computer use gate: a delayed start turned off publishes nothing", async () => {
  const gate = createHostGate();
  const published = { host: null, listener: null, hostJson: null };
  const closed = [];
  let allowed = true;
  /** @type {(value: { id: string }) => void} */
  let release = () => {};
  const delayed = new Promise((resolve) => { release = resolve; });
  async function start() {
    const taken = gate.begin();
    const stale = () => !gate.current(taken) || !allowed;
    const created = await delayed;
    if (stale()) { closed.push("host"); return null; }
    const listener = { close: () => closed.push("listener") };
    if (stale()) { listener.close(); closed.push("host"); return null; }
    Object.assign(published, { host: created, listener, hostJson: "written" });
    return created;
  }
  const starts = [start(), start(), start()]; // repeated connections while the first start waits
  allowed = false; gate.revoke(); // the person turns computer use off
  release({ id: "host" });
  assert.deepEqual(await Promise.all(starts), [null, null, null]);
  assert.deepEqual(published, { host: null, listener: null, hostJson: null });
  assert.deepEqual(closed, ["host", "host", "host"]);
});
