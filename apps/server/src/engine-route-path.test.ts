import { describe, expect, test } from "bun:test";

import { decodeEngineRouteParam, decodeEngineRoutePath } from "./engine-route-path.js";

/**
 * The expectations mirror the bundled engine (opencode 1.18.18, Hono router)
 * probed directly: GET /sessio%6E/status answers like /session/status,
 * /session%2Fstatus does not, and /session/ses%2541/message looks up "ses%41".
 */
describe("decodeEngineRoutePath", () => {
  test("leaves a plain path untouched", () => {
    expect(decodeEngineRoutePath("/session/ses_root/prompt_async")).toBe("/session/ses_root/prompt_async");
    expect(decodeEngineRoutePath("/")).toBe("/");
  });

  test("decodes unreserved escapes the router decodes before matching", () => {
    expect(decodeEngineRoutePath("/session/ses_root/prompt%5Fasync")).toBe("/session/ses_root/prompt_async");
    expect(decodeEngineRoutePath("/session/ses_root/promp%74")).toBe("/session/ses_root/prompt");
    expect(decodeEngineRoutePath("/sessio%6E/ses_root/comman%64")).toBe("/session/ses_root/command");
    expect(decodeEngineRoutePath("/%73%65%73%73%69%6F%6E/ses_root/prompt_async")).toBe("/session/ses_root/prompt_async");
  });

  test("keeps reserved escapes, so an encoded slash never splits a segment", () => {
    expect(decodeEngineRoutePath("/session%2Fstatus")).toBe("/session%2Fstatus");
    expect(decodeEngineRoutePath("/session/ses%2Froot/prompt_async")).toBe("/session/ses%2Froot/prompt_async");
    expect(decodeEngineRoutePath("/session/ses_root/prompt%3Fasync")).toBe("/session/ses_root/prompt%3Fasync");
  });

  test("keeps a literal percent encoded for the parameter decoder", () => {
    expect(decodeEngineRoutePath("/session/ses%2541/message")).toBe("/session/ses%2541/message");
    expect(decodeEngineRoutePath("/session/ses%25/message")).toBe("/session/ses%25/message");
  });

  test("decodes what it can around a malformed sequence and never throws", () => {
    expect(decodeEngineRoutePath("/session/ses%E0/prompt%5Fasync")).toBe("/session/ses%E0/prompt_async");
    expect(decodeEngineRoutePath("/session/ses%ZZ/prompt_async")).toBe("/session/ses%ZZ/prompt_async");
    expect(decodeEngineRoutePath("/session/ses_root/prompt_async%")).toBe("/session/ses_root/prompt_async%");
  });
});

describe("decodeEngineRouteParam", () => {
  test("reads a parameter the way the engine does", () => {
    expect(decodeEngineRouteParam("ses_root")).toBe("ses_root");
    expect(decodeEngineRouteParam("ses%5Froot")).toBe("ses_root");
    expect(decodeEngineRouteParam("ses%2Froot")).toBe("ses/root");
    expect(decodeEngineRouteParam("ses%2541")).toBe("ses%41");
  });

  test("returns null for a malformed identifier", () => {
    expect(decodeEngineRouteParam("ses%E0")).toBeNull();
    expect(decodeEngineRouteParam("ses%")).toBeNull();
  });
});
