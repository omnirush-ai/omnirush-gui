import { spec } from "@omnirush/testkit";
import { expect } from "vitest";
import { notificationSounds } from "../worlds/chat.ts";

const test = spec.world(notificationSounds, { timeout: 600_000 });

test("keyboard question options wrap and Enter submits the focused answer", async ({ world, user, probe, step, evidence }) => {
  const focus = () => probe.eval(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.trim() }));
  try {
    await world.nativeWindow("foreground");
    await probe.eventually(() => probe.eval(() => document.hasFocus()), {
      within: 10_000, label: "the real app document has keyboard focus", until: focused => focused,
    });
    await step("ask a real question through the task composer", async () => {
      await user.type("composer", world.question.prompt, { verify: true });
      await user.press("Enter");
      await user.see({ text: world.question.text }, { timeoutMs: 45_000 });
      await user.see({ placeholder: "Type your answer here..." });
    });
    await step("Up and Down wrap focus and Enter selects the focused option", async () => {
      await user.click({ placeholder: "Type your answer here..." });
      await user.press("Shift+Tab");
      const last = await focus();
      expect(last).toMatchObject({ tag: "BUTTON", text: expect.stringContaining("Sound outline") });
      await user.press("ArrowDown");
      const wrappedDown = await focus();
      expect(wrappedDown).toMatchObject({ tag: "BUTTON", text: expect.stringContaining("Sound checklist") });
      await user.press("ArrowUp");
      const wrappedUp = await focus();
      expect(wrappedUp).toMatchObject({ tag: "BUTTON", text: expect.stringContaining("Sound outline") });
      await user.press("Enter");
      const reply = await probe.eventually(() => probe.eval(() => {
        const messages = [...document.querySelectorAll<HTMLElement>('[data-message-role="assistant"]')];
        return messages.at(-1)?.innerText ?? "";
      }), { within: 45_000, label: "the native question returns the keyboard-selected answer to the agent",
        until: text => text.includes("Sound outline") && !text.includes("Sound checklist"),
      });
      await user.notSee({ placeholder: "Type your answer here..." });
      evidence.recordAssertionEvidence("ArrowDown and ArrowUp wrap real option focus; Enter submits Sound outline and resumes the agent",
        JSON.stringify({ last, wrappedDown, wrappedUp, reply }), true);
    });
  } finally {
    world.closeWitness();
  }
});
