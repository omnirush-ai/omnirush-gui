import { expect } from "vitest";
import { eventually, spec } from "@omnirush/testkit";
import { sessionGoals } from "../worlds/session-goals.ts";

const test = spec.world(sessionGoals, { needs: { commands: ["bun"] }, timeout: 240_000 });

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a goal response object.");
  return value;
}

function id(value: unknown): string {
  const session = record(value);
  if (typeof session.id !== "string") throw new Error("Expected an engine session id.");
  return session.id;
}

test("saved chat goals continue, charge uncached tokens, obey controls, and stay in their own chat", { timeout: 600_000 }, async ({ world, step, evidence }) => {
  const path = (sessionId: string) => `/workspace/:workspace/session-goals/${sessionId}`;
  const read = async (sessionId: string) => {
    const result = await world.api("GET", path(sessionId));
    expect(result.status).toBe(200);
    return record(result.body).goal;
  };
  const command = async (sessionId: string, body: Record<string, unknown>) => {
    const result = await world.api("POST", path(sessionId), body);
    expect(result.status, JSON.stringify(result.body)).toBeGreaterThanOrEqual(200);
    expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
    return record(result.body).goal;
  };
  const waitGoal = async (sessionId: string, status: string) => record(await eventually(() => read(sessionId), {
    within: 60_000, until: (value) => value !== null && record(value).status === status,
    label: `chat goal reaches ${status}`,
  }));
  const newSession = async (title: string) => id(await world.engine("POST", "/session", { title }));
  const calls = (model: string) => world.requests.filter((request) => request.model === model);
  const other = await newSession("Other chat");

  await step("one incomplete turn continues and the goal completes after real file work", async () => {
    const session = await newSession("Two goal checkpoints");
    expect(await read(session)).toBeNull();
    await command(session, { action: "set", objective: "Save the first and second proof files", model: world.model("goal-complete") });
    await waitGoal(session, "complete");
    const goal = record(await eventually(() => read(session), {
      within: 15_000, until: (value) => value !== null && record(value).tokensUsed === 250,
      label: "all five completed provider replies are charged once",
    }));
    expect(await world.proof("goal-first.txt")).toBe("first");
    expect(await world.proof("goal-second.txt")).toBe("second");
    expect(goal).toMatchObject({ sessionId: session, objective: "Save the first and second proof files", tokenBudget: null });
    expect(goal.tokensUsed).toBe(250);
    expect(goal.timeUsedSeconds).toBeGreaterThanOrEqual(0);
    expect(calls("goal-complete")).toHaveLength(5);
    expect(calls("goal-complete").every((request) => request.tools.includes("update_goal"))).toBe(true);
    expect(await read(other)).toBeNull();
    evidence.recordAssertionEvidence("Goals continue at an idle boundary and finish with their own proof", "A real managed engine wrote both checkpoint files across two turns, then called update_goal to complete. The unrelated chat has no goal.", true);
  });

  await step("the token limit excludes cached input and counts reasoning once", async () => {
    const session = await newSession("Goal token limit");
    await command(session, { action: "set", objective: "Continue checkpoint work within the chosen limit", tokenBudget: 60, model: world.model("goal-budget") });
    const limited = await waitGoal(session, "budget_limited");
    expect(limited).toMatchObject({ tokenBudget: 60, tokensUsed: 100 });
    expect(calls("goal-budget")).toHaveLength(2);
    const previousId = limited.id;
    const resumed = await command(session, { action: "resume" });
    expect(resumed).toMatchObject({ id: previousId, status: "budget_limited", tokenBudget: 60, tokensUsed: 100 });
    expect(calls("goal-budget")).toHaveLength(2);
    await command(session, { action: "edit", objective: "Continue checkpoint work with a raised limit", tokenBudget: 120 });
    expect(await waitGoal(session, "budget_limited")).toMatchObject({ id: previousId, tokenBudget: 120, tokensUsed: 150 });
    expect(calls("goal-budget")).toHaveLength(3);
    expect(await read(other)).toBeNull();
    evidence.recordAssertionEvidence("A saved token limit uses uncached input and all output exactly once", "Each real provider reply reported 130 input tokens with 100 cached, and 20 output tokens including 5 reasoning. The 60-token goal stopped after two 50-token replies at 100 used. Resume did not reset the limit or usage. Editing the limit to 120 preserved the same goal id and stopped at 150 used.", true);
  });

  await step("pause stops future turns, survives restart, and resumes without replacing the goal", async () => {
    const session = await newSession("Paused goal");
    await command(session, { action: "set", objective: "Finish the held checkpoint", model: world.model("goal-held") });
    await eventually(() => calls("goal-held").length, { within: 30_000, until: (count) => count === 1, label: "initial goal request is held" });
    const paused = await command(session, { action: "pause" });
    expect(paused).toMatchObject({ status: "paused", sessionId: session });
    world.release();
    await eventually(() => world.engine("GET", `/session/${session}/message`), {
      within: 30_000, until: (value) => JSON.stringify(value).includes("One checkpoint is done"), label: "paused turn finishes naturally",
    });
    await eventually(() => read(session), {
      within: 15_000, until: (value) => value !== null && record(value).tokensUsed === 50,
      label: "the paused current turn remains charged",
    });
    await world.restart();
    const persisted = await read(session);
    expect(persisted).toMatchObject({ id: record(paused).id, status: "paused", objective: "Finish the held checkpoint", tokensUsed: 50 });
    expect(calls("goal-held")).toHaveLength(1);
    await command(session, { action: "resume" });
    expect(await waitGoal(session, "complete")).toMatchObject({ id: record(paused).id });
    await eventually(() => calls("goal-held").length, {
      within: 30_000, until: (count) => count >= 3, label: "the current completion turn makes its final provider call",
    });
    expect(calls("goal-held")).toHaveLength(3);
    expect(await command(session, { action: "clear" })).toBeNull();
    expect(await read(session)).toBeNull();
    expect(await read(other)).toBeNull();
    evidence.recordAssertionEvidence("Pause and clear are saved controls for one chat", "Pause took effect while a provider reply was held. The current turn finished without another automatic request. Restart preserved the paused goal and its identity. Resume completed it with the same identity, and clear removed it. The other chat remained unchanged.", true);
  });

  await step("Stop pauses a goal before interrupting and other chat work still runs", async () => {
    const session = await newSession("Stopped goal");
    await command(session, { action: "set", objective: "Finish a checkpoint that the user stops", model: world.model("goal-stop-held") });
    await eventually(() => calls("goal-stop-held").length, { within: 30_000, until: (count) => count === 1, label: "goal is running before Stop" });
    await world.engine("POST", `/session/${session}/abort`, {});
    expect(await waitGoal(session, "paused")).toMatchObject({ objective: "Finish a checkpoint that the user stops" });
    world.release();
    const response = await world.engine("POST", `/session/${other}/message`, {
      model: world.model("goal-unrelated"), parts: [{ type: "text", text: "Check that this other chat still works" }],
    });
    expect(JSON.stringify(response)).toContain("The other chat works.");
    expect(await read(other)).toBeNull();
    expect(calls("goal-stop-held")).toHaveLength(1);
    expect(await read(session)).toMatchObject({ status: "paused" });
    evidence.recordAssertionEvidence("Stopping one goal does not restart it or stop another chat", "The native abort route saved paused before forwarding Stop. After the held reply was released, the goal sent no new request. The other chat produced a normal reply and did not acquire the stopped goal.", true);
  });

  await step("Plan turns do not spend the goal budget and Build selection enables continuation", async () => {
    const session = await newSession("Plan goal");
    const saved = record(await command(session, { action: "set", objective: "Plan a checkpoint before acting", tokenBudget: 60, agent: "plan", model: world.model("goal-plan") }));
    expect(await read(session)).toMatchObject({ status: "active", tokensUsed: 0, timeUsedSeconds: 0 });
    expect(calls("goal-plan")).toHaveLength(0);
    const rejected = await world.api("POST", path(session), { action: "resume" }, false);
    expect(rejected.status).toBe(401);
    expect(calls("goal-plan")).toHaveLength(0);
    await world.engine("POST", `/session/${session}/message`, {
      agent: "plan", model: world.model("goal-plan"), parts: [{ type: "text", text: "Plan the next checkpoint without doing goal work" }],
    });
    expect(calls("goal-plan")).toHaveLength(1);
    expect(await read(session)).toMatchObject({ id: saved.id, status: "active", tokensUsed: 0, timeUsedSeconds: 0 });
    await command(session, { action: "select", goalId: saved.id, agent: "build", model: world.model("goal-plan") });
    expect(await waitGoal(session, "budget_limited")).toMatchObject({ id: saved.id, tokenBudget: 60, tokensUsed: 100 });
    expect(calls("goal-plan")).toHaveLength(3);
    expect(await command(session, { action: "clear" })).toBeNull();
    evidence.recordAssertionEvidence("Plan mode, Build selection, and request authentication are honored", "Saving in Plan launched no work. An unauthenticated resume was rejected. A real manual Plan reply spent no goal tokens or work time. Selecting Build resumed the same active goal and stopped after two charged replies at the saved budget.", true);
  });

  await step("restart reconnects a saved active goal without creating a second goal", async () => {
    const session = await newSession("Recover active goal");
    const saved = record(await command(session, { action: "set", objective: "Finish the checkpoint after restart", model: world.model("goal-recover-held") }));
    await eventually(() => calls("goal-recover-held").length, { within: 30_000, until: (count) => count === 1, label: "active work is held before restart" });
    await world.restart();
    expect(await waitGoal(session, "complete")).toMatchObject({ id: saved.id, objective: "Finish the checkpoint after restart" });
    await eventually(() => calls("goal-recover-held").length, {
      within: 30_000, until: (count) => count >= 3, label: "the recovered completion turn makes its final provider call",
    });
    expect(calls("goal-recover-held")).toHaveLength(3);
    expect(await read(other)).toBeNull();
    evidence.recordAssertionEvidence("Active goal recovery uses the saved identity", "The managed server restarted while the first reply was held. Reading the saved active goal reconciled engine state and admitted one continuation. The same goal completed, and the unrelated chat stayed unchanged.", true);
  });

  await step("late work from a replaced goal cannot spend the new goal budget", async () => {
    const session = await newSession("Replace busy goal");
    const old = record(await command(session, { action: "set", objective: "An older checkpoint", model: world.model("goal-replaced-held") }));
    await eventually(() => calls("goal-replaced-held").length, { within: 30_000, until: (count) => count === 1, label: "old goal provider request is held" });
    const replacement = record(await command(session, { action: "set", objective: "The replacement checkpoint", tokenBudget: 60, model: world.model("goal-replacement-budget") }));
    expect(replacement.id).not.toBe(old.id);
    expect(replacement).toMatchObject({ tokensUsed: 0, tokenBudget: 60 });
    world.release();
    expect(await waitGoal(session, "budget_limited")).toMatchObject({ id: replacement.id, tokensUsed: 100, tokenBudget: 60 });
    expect(calls("goal-replaced-held")).toHaveLength(1);
    expect(calls("goal-replacement-budget")).toHaveLength(2);
    expect(await read(other)).toBeNull();
    evidence.recordAssertionEvidence("Old turn events cannot charge a replacement goal", "The old provider reply arrived after a new objective was saved. The replacement used exactly its two 50-token replies and stopped at 100, with a new identity. The old reply did not spend its budget.", true);
  });

  await step("a new user turn keeps already running work charged to the same goal", async () => {
    const session = await newSession("Steer active goal");
    const saved = record(await command(session, { action: "set", objective: "Complete the checkpoint with the user's next request", tokenBudget: 60, model: world.model("goal-steer-held") }));
    await eventually(() => calls("goal-steer-held").length, { within: 30_000, until: (count) => count === 1, label: "first goal reply is held before user input" });
    await world.engine("POST", `/session/${session}/prompt_async`, {
      agent: "build", model: world.model("goal-steer-held"), parts: [{ type: "text", text: "Use this next user request for the checkpoint" }],
    });
    world.release();
    expect(await waitGoal(session, "budget_limited")).toMatchObject({ id: saved.id, tokenBudget: 60, tokensUsed: 100 });
    expect(calls("goal-steer-held")).toHaveLength(2);
    evidence.recordAssertionEvidence("Same-goal user input preserves earlier token use", "A new user prompt arrived while the first goal reply was held. Both replies counted toward the same saved goal, so its 60-token limit stopped at 100 after two requests.", true);
  });

  await step("queued input holds automatic admission until its preparation is finished", async () => {
    const session = await newSession("Queued user input");
    expect(await command(session, { action: "hold", holding: true })).toBeNull();
    const saved = record(await command(session, { action: "set", objective: "Wait for queued user input before checkpoint work", tokenBudget: 60, model: world.model("goal-queue-budget") }));
    let observations = 0;
    await eventually(async () => {
      expect(await read(session)).toMatchObject({ id: saved.id, status: "active", tokensUsed: 0 });
      expect(calls("goal-queue-budget")).toHaveLength(0);
      return ++observations;
    }, { within: 5_000, intervalMs: 300, until: (count) => count === 4, label: "queued input remains protected beyond the automatic timer" });
    await command(session, { action: "hold", holding: false });
    expect(await waitGoal(session, "budget_limited")).toMatchObject({ id: saved.id, tokensUsed: 100 });
    expect(calls("goal-queue-budget")).toHaveLength(2);
    evidence.recordAssertionEvidence("Queued input has a server-visible admission hold", "A hold was registered before saving the goal. Across four observations spanning the continuation timer, the goal stayed active at zero tokens with no provider calls. Releasing the hold admitted work and preserved the saved goal identity and limit.", true);
  });

  await step("three empty automatic turns stop work and resume starts a fresh audit", async () => {
    const session = await newSession("Stalled goal");
    const saved = record(await command(session, { action: "set", objective: "Make progress on a checkpoint", model: world.model("goal-stall") }));
    expect(await waitGoal(session, "blocked")).toMatchObject({ id: saved.id });
    expect(calls("goal-stall")).toHaveLength(3);
    await command(session, { action: "resume" });
    expect(await waitGoal(session, "blocked")).toMatchObject({ id: saved.id });
    expect(calls("goal-stall")).toHaveLength(6);
    evidence.recordAssertionEvidence("Empty continuations stop after three turns", "Three real empty replies stopped automatic work. Explicit resume retained the saved goal and allowed a fresh three-turn audit before stopping again.", true);
  });

  await step("child work spends the parent budget without adopting the parent objective", async () => {
    const session = await newSession("Delegated goal checkpoint");
    await command(session, { action: "set", objective: "Have a child save its assigned checkpoint", tokenBudget: 500, model: world.model("goal-delegate") });
    await waitGoal(session, "complete");
    expect(await eventually(() => read(session), {
      within: 15_000, until: (value) => value !== null && record(value).tokensUsed === 300,
      label: "all parent and child provider replies are charged once",
    })).toMatchObject({ tokensUsed: 300, tokenBudget: 500 });
    expect(await world.proof("goal-child.txt")).toBe("child");
    const children = await world.engine("GET", `/session/${session}/children`);
    expect(Array.isArray(children)).toBe(true);
    if (!Array.isArray(children)) throw new Error("Expected engine child sessions.");
    expect(children).toHaveLength(1);
    expect(await read(id(children[0]))).toBeNull();
    expect(calls("goal-delegate")).toHaveLength(6);
    expect(calls("goal-delegate")[2]?.body).toContain('\\"goal\\":null');
    expect(await read(other)).toBeNull();
    evidence.recordAssertionEvidence("Child work belongs to its parent goal budget", "A real engine child read no inherited goal and wrote its assigned file. Its three provider replies and the parent's three replies counted once, for 300 tokens. The child and unrelated chat had no saved goal.", true);
  });

  await step("an explicit model request can use the three goal tools", async () => {
    const session = await newSession("Goal tools");
    await world.engine("POST", `/session/${session}/message`, {
      model: world.model("goal-create"), parts: [{ type: "text", text: "Create a goal for saving the requested objective, with a 500 token limit. Check its status and complete it once it is saved." }],
    });
    expect(await waitGoal(session, "complete")).toMatchObject({ objective: "Save an explicitly requested goal", tokenBudget: 500 });
    expect(await eventually(() => read(session), {
      within: 15_000, until: (value) => value !== null && record(value).tokensUsed === 150,
      label: "tool-created goal excludes the reply that created it",
    })).toMatchObject({ tokensUsed: 150 });
    expect(calls("goal-create")).toHaveLength(4);
    for (const tool of ["create_goal", "get_goal", "update_goal"]) expect(calls("goal-create")[0]?.tools).toContain(tool);
    await world.engine("POST", `/session/${session}/message`, {
      model: world.model("goal-unrelated"), parts: [{ type: "text", text: "Answer this new chat request after the goal is complete" }],
    });
    let observations = 0;
    await eventually(async () => {
      expect(await read(session)).toMatchObject({ status: "complete", tokensUsed: 150 });
      return ++observations;
    }, { within: 5_000, intervalMs: 300, until: (count) => count === 4, label: "new work does not charge a completed goal" });
    expect(await read(other)).toBeNull();
    evidence.recordAssertionEvidence("Goal tools work through the real agent engine", "On an explicit user request the engine executed create_goal with a 500-token limit, get_goal, and update_goal complete. Only the three replies after goal creation were charged, for 150 tokens. The stored result matches the requested objective, and the unrelated chat stayed unchanged.", true);
  });
});
