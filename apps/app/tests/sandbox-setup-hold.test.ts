import { describe, expect, test } from "bun:test";

import { sandboxSetupHolds } from "../src/react-app/domains/settings/linux-sandbox";

describe("sandbox setup hold", () => {
  test("holds while the box is on and downloading or starting, whatever turned it on", () => {
    expect(sandboxSetupHolds({ on: true, state: "downloading" })).toBe(true);
    expect(sandboxSetupHolds({ on: true, state: "starting" })).toBe(true);
    // Turned on by the user (the offer level), not required.
    expect(sandboxSetupHolds({ on: true, required: false, state: "downloading" } as never)).toBe(true);
  });

  test("no hold once ready, failed or off", () => {
    expect(sandboxSetupHolds({ on: true, state: "ready" })).toBe(false);
    expect(sandboxSetupHolds({ on: true, state: "failed" })).toBe(false);
    expect(sandboxSetupHolds({ on: false, state: "downloading" })).toBe(false);
    expect(sandboxSetupHolds(null)).toBe(false);
  });
});
