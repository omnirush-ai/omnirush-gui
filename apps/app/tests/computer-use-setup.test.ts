import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { SCREEN_INTENT, screenIntent } from "../src/react-app/domains/session/surface/computer-use/setup";

const POLICY = readFileSync(path.join(import.meta.dir, "../../server/src/computer-use/shared/policy.mjs"), "utf8");

describe("computer use setup", () => {
  test("mirrors the shared policy's screen words", () => {
    expect(POLICY).toContain(`const SCREEN_INTENT = ${SCREEN_INTENT.toString()};`);
  });

  test("defaults: computer use on, the person's own screen off", async () => {
    const policy = await import("../../server/src/computer-use/shared/policy.mjs");
    expect(policy.deviceComputerUse(undefined)).toBe(true);
    expect(policy.deviceComputerUse(false)).toBe(false);
    expect(policy.realScreenOptIn({ env: {} })).toBe(false);
    const off = policy.computerUseSetting({ env: {}, block: { enabled: true }, client: "desktop", platform: "linux", device: false });
    expect([off.enabled, off.reason, policy.unavailableMessage(off)]).toEqual([false, "device", "Computer use is turned off on this computer."]);
  });

  test("a draft that asks for the screen shows the hint; code words do not", () => {
    for (const text of ["use my browser to book a table", "click Submit", "open the app and log in", "then click Save"]) expect(screenIntent(text)).toBe(true);
    for (const text of ["fix the failing test", "add a click handler to the button", "clickhouse migration"]) expect(screenIntent(text)).toBe(false);
  });
});
