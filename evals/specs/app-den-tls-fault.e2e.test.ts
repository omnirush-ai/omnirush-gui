import { expect } from "vitest";
import { spec } from "@omnirush/testkit";
import { appDenTlsFaultWorld } from "../worlds/first-run.ts";

const test = spec.world(appDenTlsFaultWorld, {
  needs: { commands: ["bun"] },
  timeout: 180_000,
});

test("a desktop pointed at a TLS-intercepted Den never claims it is connected, and diagnostics name the interception", async ({ world, user, step }) => {
  await step("The welcome surface offers cloud sign-in without a crash", async () => {
    await user.see("Sign in to OmniRush.ai Cloud");
    await user.notSee({ text: /Something went wrong/ });
    await user.click("Sign in to OmniRush.ai Cloud");
    await user.looks([
      "An OmniRush.ai screen offering to sign in to OmniRush.ai Cloud is visible",
      "No error or 'Something went wrong' crash message is visible yet",
    ]);
  });

  for (const falseSuccess of ["Signed in as", "Synced", "Connected to OmniRush.ai Cloud"]) {
    await user.notSee({ text: new RegExp(falseSuccess) });
  }

  const verdict = await world.diagnose();
  expect(verdict.available, verdict.text).toBe(true);
  expect(verdict.expectationMatched, verdict.text).toBe(true);
});
