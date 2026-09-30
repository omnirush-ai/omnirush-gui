import { expect } from "vitest";
import { spec } from "@omnirush/testkit";
import { sessionGoalsDesktop } from "../worlds/session-goals.ts";

const test = spec.world(sessionGoalsDesktop, { timeout: 420_000 });

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a goal response object.");
  return value;
}

test("slash goals remain visible after reload and their controls work while a chat is busy", { timeout: 600_000 }, async ({ world, user, probe, agent, step, evidence }) => {
  const path = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/session-goals/${world.session.sessionId}`;
  const goal = async () => {
    const response = await probe.desktopApi(path);
    expect(response.status, `Goal read failed: ${JSON.stringify(response.body)}`).toBe(200);
    return record(response.body).goal;
  };
  const send = async (text: string) => {
    try {
      await user.type("composer", text, { replace: true, verify: true });
    } catch (error) {
      await user.screenshot();
      throw error;
    }
    await user.press("Enter");
  };
  const status = async (expected: string) => {
    await probe.eventually(goal, { within: 30_000, until: (value) => value !== null && record(value).status === expected,
      label: `goal API and visible panel reach ${expected}` });
    await user.see({ testId: "session-goal" });
    await probe.eventually(() => probe.eval(() => document.querySelector('[data-testid="goal-status"]')?.getAttribute("data-goal-status")), {
      within: 15_000, until: (value) => value === expected, label: `visible goal status is ${expected}`,
    });
  };
  const calls = () => world.requests.filter((request) => request.model === "goal-held");

  await step("the built-in slash menu starts a goal and busy Enter can pause it", async () => {
    await user.screenshot();
    await user.type("composer", "/go", { replace: true, verify: true });
    await user.see({ text: "Set a goal and keep working until it is complete." });
    await send("/goal Finish the held checkpoint");
    await user.screenshot();
    await status("active");
    await user.notSee({ text: /Continue working toward the active session goal/ });
    await user.see({ testId: "goal-objective", text: "Finish the held checkpoint" });
    await probe.eventually(() => calls().length, { within: 30_000, until: (count) => count === 1, label: "real provider turn is held" });
    await send("/goal PAUSE");
    await status("paused");
    await user.screenshot();
    expect(calls()).toHaveLength(1);
    evidence.recordAssertionEvidence("The slash goal control bypasses the busy chat queue", "The built-in menu exposed goal, the real provider was held during an active turn, and Enter on /goal PAUSE immediately saved paused without another model request.", true);
  });

  const saved = record(await goal());
  await step("reload and edit preserve the goal identity and usage", async () => {
    await user.reload();
    await status("paused");
    await user.notSee({ text: /Continue working toward the active session goal/ });
    expect(await goal()).toMatchObject({ id: saved.id, objective: saved.objective, tokensUsed: saved.tokensUsed });
    await send("/goal edit");
    await user.see({ testId: "goal-objective-input" });
    expect(await probe.eval(() => {
      const input = document.querySelector('[data-testid="goal-objective-input"]');
      return input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : null;
    })).toBe("Finish the held checkpoint");
    await user.type({ testId: "goal-objective-input" }, "Finish the held checkpoint with clear proof", { replace: true, verify: true });
    await user.type({ testId: "goal-budget-input" }, "1000", { replace: true, verify: true });
    await user.click({ testId: "goal-save" });
    await status("paused");
    expect(await goal()).toMatchObject({ id: saved.id, tokensUsed: saved.tokensUsed, tokenBudget: 1_000, objective: "Finish the held checkpoint with clear proof" });
    await user.screenshot();
    expect(calls()).toHaveLength(1);
    evidence.recordAssertionEvidence("Reload and goal editing keep saved state", "The paused objective stayed visible after reload. The editor was prefilled. Saving changed the objective and explicit token limit while retaining identity, usage, and paused status, with no new provider call.", true);
  });

  await step("replacing unfinished work requires a visible choice and Cancel keeps it", async () => {
    await send("/goal Replace the saved checkpoint goal");
    await user.see({ role: "button", label: "Replace goal" });
    expect(await goal()).toMatchObject({ id: saved.id, status: "paused" });
    await user.click({ role: "button", label: "Cancel" });
    expect(await goal()).toMatchObject({ id: saved.id, objective: "Finish the held checkpoint with clear proof" });
    expect(calls()).toHaveLength(1);
    evidence.recordAssertionEvidence("Replacing an unfinished goal requires a user choice", "A second objective opened Replace goal and Cancel. Cancel kept the original goal and launched no work.", true);
  });

  await step("other chats have their own goal state and resume reaches completion", async () => {
    world.release();
    await user.see({ text: "One checkpoint is done. The goal still needs work." }, { timeoutMs: 30_000 });
    const other = await agent.createSession("Other goal chat");
    await user.notSee({ testId: "session-goal" });
    const otherResult = await probe.desktopApi(`/workspace/${encodeURIComponent(world.workspace.workspaceId)}/session-goals/${other}`);
    expect(otherResult.status).toBe(200);
    expect(record(otherResult.body).goal).toBeNull();
    await agent.run("session.open", { sessionId: world.session.sessionId });
    await status("paused");
    await send("/goal RESUME");
    await status("complete");
    expect(await goal()).toMatchObject({ id: saved.id, tokenBudget: 1_000 });
    await probe.eventually(() => calls().length, { within: 30_000, until: (count) => count >= 3, label: "the current completion turn makes its final provider call" });
    expect(calls()).toHaveLength(3);
    await send("/goal clear");
    await probe.eventually(goal, { within: 15_000, until: (value) => value === null, label: "clear removes the current goal" });
    await user.notSee({ testId: "session-goal" });
    evidence.recordAssertionEvidence("Goal state is chat scoped and resume and clear work", "The other chat had no goal panel or API state. Returning restored the paused goal. Resume kept its identity and reached complete through the goal tool. Clear removed the saved goal and panel.", true);
  });

  await step("the goal editor accepts an explicit token limit and shows its stop state", async () => {
    await send("/goal");
    try {
      await user.see({ testId: "goal-objective-input" });
    } catch (error) {
      await user.screenshot();
      throw error;
    }
    await user.type({ testId: "goal-objective-input" }, "Do checkpoint work within the chosen token limit", { replace: true, verify: true });
    await user.type({ testId: "goal-budget-input" }, "40", { replace: true, verify: true });
    await user.click({ testId: "goal-save" });
    await status("budget_limited");
    expect(await goal()).toMatchObject({ tokenBudget: 40, tokensUsed: 50 });
    await user.see({ testId: "goal-token-usage" });
    expect(calls()).toHaveLength(4);
    await user.screenshot();
    await user.click({ testId: "goal-clear" });
    await probe.eventually(goal, { within: 15_000, until: (value) => value === null, label: "the clear button removes a limited goal" });
    await user.notSee({ testId: "session-goal" });
    evidence.recordAssertionEvidence("The editor exposes a token limit and the saved stop state", "Creating through bare /goal with a 40-token limit sent one 50-token reply. The panel showed budget_limited and usage. Clear removed it with no further provider request.", true);
  });
});
