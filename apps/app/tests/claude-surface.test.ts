import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const registered = typeof globalThis.document === "undefined";
if (registered) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });

test("claudeSurface: off with nothing saved shows nothing; off with saved sessions keeps them; on is the full page", async () => {
  const { claudeSurface } = await import("../src/react-app/shell/claude-offer");
  expect(claudeSurface(false, 0)).toBe("none");
  expect(claudeSurface(false, 2)).toBe("saved");
  expect(claudeSurface(true, 0)).toBe("full");
});
