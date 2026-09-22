import { describe, expect, test } from "bun:test";

import type { OmniRushServerClient } from "../src/app/lib/omnirush-server";
import {
  buildOmniRushEnvSystemContext,
  buildOmniRushSessionSystemContext,
  clearOmniRushEnvSystemContextCache,
} from "../src/react-app/domains/session/sync/env-context";

function client(keys: string[], calls: { count: number }): OmniRushServerClient {
  return {
    baseUrl: "http://127.0.0.1:3000",
    listUserEnvKeys: async () => {
      calls.count += 1;
      return { keys };
    },
  } as OmniRushServerClient;
}

describe("buildOmniRushEnvSystemContext", () => {
  test("lists configured key names without inventing secret values", async () => {
    clearOmniRushEnvSystemContextCache();
    const calls = { count: 0 };
    const context = await buildOmniRushEnvSystemContext(
      client(["NBA_LIVE_KEY", "bad-key", "ANTHROPIC_API_KEY", "NBA_LIVE_KEY"], calls),
      {
        cacheKey: "session-a",
        readPendingChanges: () => false,
      },
    );

    expect(context).toContain("- ANTHROPIC_API_KEY");
    expect(context).toContain("- NBA_LIVE_KEY");
    expect(context).not.toContain("bad-key");
    expect(context).not.toContain("sk-ant-secret");
    expect(calls.count).toBe(1);
  });

  test("caches key context per session", async () => {
    clearOmniRushEnvSystemContextCache();
    const calls = { count: 0 };
    const server = client(["OPENROUTER_API_KEY"], calls);

    await buildOmniRushEnvSystemContext(server, {
      cacheKey: "session-a",
      readPendingChanges: () => false,
    });
    await buildOmniRushEnvSystemContext(server, {
      cacheKey: "session-a",
      readPendingChanges: () => false,
    });
    await buildOmniRushEnvSystemContext(server, {
      cacheKey: "session-b",
      readPendingChanges: () => false,
    });

    expect(calls.count).toBe(2);
  });

  test("does not truncate long key lists", async () => {
    clearOmniRushEnvSystemContextCache();
    const calls = { count: 0 };
    const keys = Array.from({ length: 90 }, (_, index) => `KEY_${index}`);
    const context = await buildOmniRushEnvSystemContext(client(keys, calls), {
      cacheKey: "session-a",
      readPendingChanges: () => false,
    });

    expect(context).toContain("- KEY_0");
    expect(context).toContain("- KEY_89");
    expect(context).not.toContain("and 10 more");
  });

  test("skips context while environment changes are pending", async () => {
    clearOmniRushEnvSystemContextCache();
    const calls = { count: 0 };
    const context = await buildOmniRushEnvSystemContext(client(["ANTHROPIC_API_KEY"], calls), {
      cacheKey: "session-a",
      readPendingChanges: () => true,
    });

    expect(context).toBeUndefined();
    expect(calls.count).toBe(0);
  });
});

describe("buildOmniRushSessionSystemContext", () => {
  test("always carries the user's time zone context and appends env keys when present", async () => {
    clearOmniRushEnvSystemContextCache();
    const calls = { count: 0 };
    const context = await buildOmniRushSessionSystemContext(client(["ANTHROPIC_API_KEY"], calls), {
      cacheKey: "session-a",
      readPendingChanges: () => false,
    });

    const [runtime, env] = context.split("\n\n");
    expect(runtime.startsWith("User context:\n- Time zone: ")).toBe(true);
    expect(runtime).toContain(`- Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone} (UTC`);
    expect(runtime).toContain("- Today's date in that time zone: ");
    expect(runtime).toContain("Resolve \"today\", \"tomorrow\", \"this week\"");
    expect(env).toContain("omnirush.ai environment variables configured:");
    expect(env).toContain("- ANTHROPIC_API_KEY");
  });

  test("still returns the user context when there are no env keys, no client, or pending changes", async () => {
    clearOmniRushEnvSystemContextCache();
    const calls = { count: 0 };

    const noKeys = await buildOmniRushSessionSystemContext(client([], calls), { cacheKey: "s1", readPendingChanges: () => false });
    const noClient = await buildOmniRushSessionSystemContext(null, { cacheKey: "s2", readPendingChanges: () => false });
    const pending = await buildOmniRushSessionSystemContext(client(["KEY"], calls), { cacheKey: "s3", readPendingChanges: () => true });

    for (const context of [noKeys, noClient, pending]) {
      expect(context.startsWith("User context:")).toBe(true);
      expect(context).not.toContain("omnirush.ai environment variables configured:");
      expect(context).not.toContain("- KEY");
    }
  });
});
