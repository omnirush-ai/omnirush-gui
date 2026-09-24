import { describe, expect, test } from "bun:test";

import { OmniRushServerError } from "../src/app/lib/omnirush-server";
import { reloadEngineWithDesktopFallback } from "../src/react-app/shell/engine-reload-escalation";

function unreachableError() {
  return new OmniRushServerError(503, "opencode_engine_unreachable", "engine unreachable");
}

function unconfiguredError() {
  return new OmniRushServerError(400, "opencode_unconfigured", "engine unconfigured");
}

type Harness = {
  reloadCalls: number;
  restartCalls: number;
  client: { reloadEngine: (workspaceId: string) => Promise<void> };
  options: {
    retryDelayMs: number;
    restartEngine: () => Promise<void>;
    isDesktop: () => boolean;
  };
};

function makeHarness(reloadResults: Array<Error | null>, isDesktop = true): Harness {
  const harness: Harness = {
    reloadCalls: 0,
    restartCalls: 0,
    client: {
      reloadEngine: async () => {
        const result = reloadResults[harness.reloadCalls];
        harness.reloadCalls += 1;
        if (result) throw result;
      },
    },
    options: {
      retryDelayMs: 1,
      restartEngine: async () => {
        harness.restartCalls += 1;
      },
      isDesktop: () => isDesktop,
    },
  };
  return harness;
}

describe("reloadEngineWithDesktopFallback", () => {
  test("a successful reload never restarts", async () => {
    const harness = makeHarness([null]);
    const result = await reloadEngineWithDesktopFallback(harness.client, "ws", harness.options);
    expect(result.restartedEngine).toBe(false);
    expect(harness.reloadCalls).toBe(1);
    expect(harness.restartCalls).toBe(0);
  });

  test("a transient unreachable engine recovers on the retry without a restart", async () => {
    const harness = makeHarness([unreachableError(), null]);
    const result = await reloadEngineWithDesktopFallback(harness.client, "ws", harness.options);
    expect(result.restartedEngine).toBe(false);
    expect(harness.reloadCalls).toBe(2);
    expect(harness.restartCalls).toBe(0);
  });

  test("a persistently unreachable engine escalates to a restart", async () => {
    const harness = makeHarness([unreachableError(), unreachableError()]);
    const result = await reloadEngineWithDesktopFallback(harness.client, "ws", harness.options);
    expect(result.restartedEngine).toBe(true);
    expect(harness.reloadCalls).toBe(2);
    expect(harness.restartCalls).toBe(1);
  });

  test("an engine that is still starting (unconfigured) recovers on the retry without a restart", async () => {
    const harness = makeHarness([unconfiguredError(), null]);
    const result = await reloadEngineWithDesktopFallback(harness.client, "ws", harness.options);
    expect(result.restartedEngine).toBe(false);
    expect(harness.reloadCalls).toBe(2);
    expect(harness.restartCalls).toBe(0);
  });

  test("a persistently unconfigured engine escalates to a restart after one retry", async () => {
    const harness = makeHarness([unconfiguredError(), unconfiguredError()]);
    const result = await reloadEngineWithDesktopFallback(harness.client, "ws", harness.options);
    expect(result.restartedEngine).toBe(true);
    expect(harness.reloadCalls).toBe(2);
    expect(harness.restartCalls).toBe(1);
  });

  test("a restart the desktop deferred because sessions are running is not reported as a restart", async () => {
    const harness = makeHarness([unreachableError(), unreachableError()]);
    const result = await reloadEngineWithDesktopFallback(harness.client, "ws", {
      ...harness.options,
      restartEngine: async () => {
        harness.restartCalls += 1;
        return { running: true, restartDeferred: true, busySessions: 3 };
      },
    });
    expect(result.restartedEngine).toBe(false);
    expect(harness.restartCalls).toBe(1);
  });

  test("an aborted fetch is transport noise, never a restart", async () => {
    const harness = makeHarness([new DOMException("aborted", "AbortError")]);
    await expect(reloadEngineWithDesktopFallback(harness.client, "ws", harness.options)).rejects.toThrow("aborted");
    expect(harness.restartCalls).toBe(0);
  });

  test("an aborted retry surfaces instead of restarting", async () => {
    const harness = makeHarness([unreachableError(), new DOMException("aborted", "AbortError")]);
    await expect(reloadEngineWithDesktopFallback(harness.client, "ws", harness.options)).rejects.toThrow("aborted");
    expect(harness.reloadCalls).toBe(2);
    expect(harness.restartCalls).toBe(0);
  });

  test("a non-restartable retry failure surfaces to the caller", async () => {
    const retryFailure = new OmniRushServerError(502, "opencode_reload_failed", "dispose failed");
    const harness = makeHarness([unreachableError(), retryFailure]);
    await expect(reloadEngineWithDesktopFallback(harness.client, "ws", harness.options)).rejects.toBe(retryFailure);
    expect(harness.restartCalls).toBe(0);
  });

  test("non-desktop runtimes never restart", async () => {
    const error = unreachableError();
    const harness = makeHarness([error], false);
    await expect(reloadEngineWithDesktopFallback(harness.client, "ws", harness.options)).rejects.toBe(error);
    expect(harness.reloadCalls).toBe(1);
    expect(harness.restartCalls).toBe(0);
  });

  test("reload timeouts surface instead of restarting mid-teardown", async () => {
    const timeout = new OmniRushServerError(504, "opencode_reload_timeout", "dispose still tearing down");
    const harness = makeHarness([timeout]);
    await expect(reloadEngineWithDesktopFallback(harness.client, "ws", harness.options)).rejects.toBe(timeout);
    expect(harness.restartCalls).toBe(0);
  });
});
