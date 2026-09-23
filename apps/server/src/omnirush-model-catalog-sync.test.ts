import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backendCatalogBody } from "./__fixtures__/omnirush-model-catalog.js";
import {
  builtinOmniRushModelCatalog,
  omnirushModelCatalogPath,
  readOmniRushModelCatalog,
  sanitizeOmniRushModelCatalog,
  writeOmniRushModelCatalog,
} from "./omnirush-model-catalog.js";
import { OmniRushModelCatalogSync, startOmniRushModelCatalogSync } from "./omnirush-model-catalog-sync.js";
import {
  keepOmniRushRuntimeConfigFileFresh,
  omnirushRuntimeConfigFilePath,
  writeOmniRushRuntimeConfigFile,
} from "./omnirush-runtime-config.js";
import { writeGlobalRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const cleanups: Array<() => void> = [];
let previousDb: string | undefined;

afterEach(async () => {
  while (cleanups.length) cleanups.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.OMNIRUSH_RUNTIME_DB;
  else process.env.OMNIRUSH_RUNTIME_DB = previousDb;
});

/** A signed-in desktop server: the engine config carries the omnirush provider. */
async function setup(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "omnirush-model-catalog-sync-"));
  roots.push(root);
  previousDb = process.env.OMNIRUSH_RUNTIME_DB;
  process.env.OMNIRUSH_RUNTIME_DB = join(root, "runtime.sqlite");
  return {
    host: "127.0.0.1",
    port: 48123,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    omnirushEngineToken: "engine-token",
    omnirushGatewayCredentials: {
      gatewayUrl: "https://api.example.test/omnirush/v1",
      accessToken: "device-access-token",
      refreshToken: "device-refresh-token",
    },
  };
}

async function engineModelIds(config: ServerConfig): Promise<string[]> {
  const parsed = JSON.parse(await readFile(omnirushRuntimeConfigFilePath(config), "utf8")) as {
    provider: { omnirush: { models: Record<string, unknown> } };
  };
  return Object.keys(parsed.provider.omnirush.models).sort();
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000, poll?: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await poll?.();
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await poll?.();
  }
}

type SyncRecord = {
  /** The engine's model ids (sorted) at each reload. */
  reloads: string[][];
  fetches: number;
  logs: string[];
};

/**
 * A sync whose reload records the engine's model list at reload time, as the
 * engine pool would read it from the runtime config file.
 */
function harness(config: ServerConfig, options: {
  respond: () => Promise<Response>;
  engineBusy?: () => Promise<boolean>;
  reloadFails?: () => boolean;
}): SyncRecord & { sync: OmniRushModelCatalogSync } {
  const record: SyncRecord = { reloads: [], fetches: 0, logs: [] };
  const sync = new OmniRushModelCatalogSync({
    config,
    fetchCatalog: () => {
      record.fetches += 1;
      return options.respond();
    },
    reloadEngine: async () => {
      if (options.reloadFails?.()) throw new Error("engine reload failed");
      record.reloads.push(await engineModelIds(config));
    },
    engineBusy: options.engineBusy,
    log: (level, message) => record.logs.push(`${level}: ${message}`),
    reloadRetryMs: 10,
  });
  cleanups.push(() => sync.stop());
  return Object.assign(record, { sync });
}

const MUSE_IDS = ["gpt-6-astra", "gpt-5.6-sol", "meta-muse-spark", "muse-spark-1.1", "muse-spark-1.3"];
/** The engine config file is written with sorted keys. */
const MUSE_ENGINE_IDS = [...MUSE_IDS].sort();
const BUILTIN_ENGINE_IDS = ["gpt-5.6-sol", "gpt-6-astra"];

describe("omnirush model catalog sync", () => {
  test("a changed catalog is stored and ALWAYS reloads the engine, even when the config file already moved on", async () => {
    const config = await setup();
    await writeOmniRushRuntimeConfigFile(config);
    expect(await engineModelIds(config)).toEqual(BUILTIN_ENGINE_IDS);
    cleanups.push(keepOmniRushRuntimeConfigFileFresh(config));
    const race: { changed?: boolean } = {};
    const state = harness(config, {
      respond: async () => Response.json(backendCatalogBody()),
      // The race from the design critique: an unrelated ENGINE_GLOBAL write
      // lands between the cache write and the sync's own config write, so the
      // file already holds the new catalog and the sync's write reports
      // changed=false. The engine must still reload.
      engineBusy: async () => {
        await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
          ...current,
          mcp: { docs: { type: "remote", url: "https://mcp.example.test/mcp", enabled: false } },
        }));
        race.changed = (await writeOmniRushRuntimeConfigFile(config)).changed;
        return false;
      },
    });

    expect(await state.sync.run()).toBe("applied");
    expect(race.changed).toBe(false);
    expect((await readOmniRushModelCatalog(config)).map((model) => model.id)).toEqual(MUSE_IDS);
    expect(state.reloads).toEqual([MUSE_ENGINE_IDS]);
  });

  test("an unchanged catalog neither rewrites the cache nor reloads", async () => {
    const config = await setup();
    const catalog = sanitizeOmniRushModelCatalog(backendCatalogBody())!;
    await writeOmniRushModelCatalog(config, catalog);
    const written = (await stat(omnirushModelCatalogPath(config))).mtimeMs;
    const state = harness(config, { respond: async () => Response.json(backendCatalogBody()) });

    expect(await state.sync.run()).toBe("unchanged");
    expect(await state.sync.run()).toBe("unchanged");
    expect(state.reloads).toEqual([]);
    expect((await stat(omnirushModelCatalogPath(config))).mtimeMs).toBe(written);
  });

  test("an account without Muse keeps the built-ins and never reloads on first sync", async () => {
    const config = await setup();
    const body = backendCatalogBody();
    const state = harness(config, { respond: async () => Response.json({ ...body, data: body.data.slice(0, 2) }) });

    expect(await state.sync.run()).toBe("unchanged");
    expect(state.reloads).toEqual([]);
    expect(await readOmniRushModelCatalog(config)).toEqual(builtinOmniRushModelCatalog());
  });

  test("Muse turned off for the account drops it from the engine with one reload", async () => {
    const config = await setup();
    await writeOmniRushModelCatalog(config, sanitizeOmniRushModelCatalog(backendCatalogBody())!);
    const body = backendCatalogBody();
    const state = harness(config, { respond: async () => Response.json({ ...body, data: body.data.slice(0, 2) }) });

    expect(await state.sync.run()).toBe("applied");
    expect(state.reloads).toEqual([BUILTIN_ENGINE_IDS]);
  });

  test("a busy engine defers the reload until it idles, then reloads exactly once", async () => {
    const config = await setup();
    let busy = true;
    let busyChecks = 0;
    const state = harness(config, {
      respond: async () => Response.json(backendCatalogBody()),
      engineBusy: async () => {
        busyChecks += 1;
        return busy;
      },
    });

    expect(await state.sync.run()).toBe("applied");
    expect(state.reloads).toEqual([]);
    await waitFor(() => busyChecks >= 3);
    expect(state.reloads).toEqual([]);
    busy = false;
    await waitFor(() => state.reloads.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.reloads).toEqual([MUSE_ENGINE_IDS]);
    // The catalog was stored when it arrived: the next pass has nothing to do.
    expect(await state.sync.run()).toBe("unchanged");
    expect(state.reloads).toHaveLength(1);
  });

  test("a failed reload is retried until it lands", async () => {
    const config = await setup();
    let failures = 2;
    const state = harness(config, {
      respond: async () => Response.json(backendCatalogBody()),
      reloadFails: () => failures-- > 0,
    });

    expect(await state.sync.run()).toBe("applied");
    await waitFor(() => state.reloads.length > 0);
    expect(state.reloads).toEqual([MUSE_ENGINE_IDS]);
    expect(state.logs.filter((line) => line.includes("reload failed"))).toHaveLength(2);
  });

  test("a failed fetch or an unusable body keeps the last good catalog", async () => {
    const config = await setup();
    const good = sanitizeOmniRushModelCatalog(backendCatalogBody())!;
    await writeOmniRushModelCatalog(config, good);
    const answers: Array<() => Promise<Response>> = [
      async () => Response.json({ detail: "grant_check_unavailable" }, { status: 503 }),
      async () => Response.json({ error: "omnirush_account_required" }, { status: 401 }),
      async () => { throw new TypeError("fetch failed"); },
      async () => new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } }),
      async () => Response.json({ object: "list", data: [] }),
      async () => Response.json({ object: "list", data: [{ id: "../escape", npm: "evil-sdk" }] }),
    ];
    for (const respond of answers) {
      const state = harness(config, { respond });
      expect(await state.sync.run()).toBe("failed");
      expect(state.reloads).toEqual([]);
      expect(await readOmniRushModelCatalog(config)).toEqual(good);
    }
  });

  test("the timer runs a first pass after the initial delay and then on the interval until stopped", async () => {
    const config = await setup();
    let fetches = 0;
    const reloads: number[] = [];
    const sync = new OmniRushModelCatalogSync({
      config,
      fetchCatalog: async () => {
        fetches += 1;
        return Response.json(backendCatalogBody());
      },
      reloadEngine: async () => { reloads.push(fetches); },
      initialDelayMs: 5,
      intervalMs: 20,
    });
    cleanups.push(() => sync.stop());
    sync.start();
    await waitFor(() => fetches >= 3);
    sync.stop();
    const stoppedAt = fetches;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fetches).toBe(stoppedAt);
    expect(reloads).toEqual([1]);
  });
});

describe("startOmniRushModelCatalogSync", () => {
  test("signed out: never fetches and drops the stored catalog, so the next account starts from the built-ins", async () => {
    const config = await setup();
    await writeOmniRushModelCatalog(config, sanitizeOmniRushModelCatalog(backendCatalogBody())!);
    let fetches = 0;
    const handle = startOmniRushModelCatalogSync({
      config,
      broker: { enabled: false, modelCatalog: async () => { fetches += 1; return Response.json(backendCatalogBody()); } },
      reloadEngine: async () => undefined,
    });
    cleanups.push(() => handle.stop());
    let stored = true;
    await waitFor(() => !stored, 2_000, async () => {
      stored = await stat(omnirushModelCatalogPath(config)).then(() => true, () => false);
    });
    expect(fetches).toBe(0);
    expect(await readOmniRushModelCatalog(config)).toEqual(builtinOmniRushModelCatalog());
  });
});
