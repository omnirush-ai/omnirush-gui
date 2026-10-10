import { afterEach, describe, expect, test } from "bun:test";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import constants from "../../../constants.json" with { type: "json" };
import { BUNDLED_ENGINE_VERSION, BUNDLED_HARNESS, engineBuildVersion, engineVersionOf, opencodeHarness } from "./engine-identity.js";
import { SessionUploader, clientLaunchData } from "./session-uploader.js";

/** Schema 1/2 trace uploads carry their events only in files[0] (__omnirush__/trace.json): read them back as `trace`. */
function withTraceEvents<T>(envelope: T): T {
  const record = envelope as Record<string, unknown>;
  if (record.trace !== undefined || !Array.isArray(record.files)) return envelope;
  const file = (record.files as Array<{ path?: string; content?: string }>).find((item) => item.path === "__omnirush__/trace.json");
  if (!file?.content) return envelope;
  return { ...record, trace: (JSON.parse(file.content) as { events?: unknown[] }).events ?? [] } as T;
}


type Envelope = {
  snapshot_type: string;
  environment: Record<string, unknown>;
  trace?: Array<{ type: string; data?: Record<string, unknown> }>;
};

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function engineRelease(): Promise<{ tag: string; version: string }> {
  const path = resolve(import.meta.dir, "../../desktop/scripts/engine-release.json");
  return JSON.parse(await readFile(path, "utf8")) as { tag: string; version: string };
}

function expectHarness(value: unknown): void {
  expect(value).toEqual({
    name: "opencode",
    engine: "omnirush-opencode",
    version: BUNDLED_HARNESS.version,
    build_tag: BUNDLED_HARNESS.build_tag,
  });
  const harness = value as Record<string, unknown>;
  for (const key of ["name", "engine", "version", "build_tag"]) {
    expect(typeof harness[key]).toBe("string");
    expect((harness[key] as string).length).toBeGreaterThan(0);
  }
}

describe("engine identity", () => {
  test("names the engine release the build bundles", async () => {
    const release = await engineRelease();
    // constants.json and engine-release.json name the same engine build.
    expect((constants as { engineReleaseTag?: string }).engineReleaseTag).toBe(release.tag);
    expect(constants.opencodeVersion.replace(/^v/, "")).toBe(release.version);
    expect(BUNDLED_HARNESS.build_tag).toBe(release.tag);
    expect(BUNDLED_HARNESS.version.startsWith(release.version)).toBe(true);
    expect(BUNDLED_HARNESS.version).toBe(release.tag.replace(/^engine-/, ""));
    expect(BUNDLED_ENGINE_VERSION).toBe(`opencode/${BUNDLED_HARNESS.version}`);
  });

  test("derives version and engine_version from a release tag", () => {
    expect(engineBuildVersion("engine-1.18.32-r2", "v1.18.32")).toBe("1.18.32-r2");
    expect(engineBuildVersion("", "v1.18.32")).toBe("1.18.32");
    const harness = opencodeHarness("engine-1.18.32-r2", "v1.18.32");
    expect(harness).toEqual({ name: "opencode", engine: "omnirush-opencode", version: "1.18.32-r2", build_tag: "engine-1.18.32-r2" });
    expect(engineVersionOf(harness)).toBe("opencode/1.18.32-r2");
    // Never empty, even without a tag or version.
    const bare = opencodeHarness("", "");
    expect(bare.version.length).toBeGreaterThan(0);
    expect(bare.build_tag.length).toBeGreaterThan(0);
  });

  test("the client.launch data names the harness", () => {
    const data = clientLaunchData();
    expect(data.mode).toBe("app");
    expect(data.engine).toBe("opencode");
    expect(data.engine_version).toBe(BUNDLED_ENGINE_VERSION);
    expectHarness(data.harness);
  });
});

describe("every upload names its engine", () => {
  async function run(options: { appVersion?: string; engineVersion?: string }): Promise<Envelope[]> {
    const root = await mkdtemp(join(tmpdir(), "omnirush-engine-identity-"));
    roots.push(root);
    await writeFile(join(root, "app.ts"), "export const answer = 42;\n");
    const uploads: Envelope[] = [];
    const sessionUploader = new SessionUploader({
      upload: async (_sessionId, compressed) => {
        uploads.push(withTraceEvents(JSON.parse(zstdDecompressSync(compressed).toString("utf8"))) as Envelope);
        return Response.json({ ok: true }, { status: 201 });
      },
      fallbackScanMs: 60_000,
      ...options,
    });
    const sessionId = "session-engine-identity-1";
    sessionUploader.startSession(sessionId, "workspace-engine", root);
    await sessionUploader.idle(sessionId);
    sessionUploader.recordTrace(sessionId, "engine.request", { path: "app.ts" });
    sessionUploader.recordTrace(sessionId, "session.idle", {});
    sessionUploader.flushTrace(sessionId);
    await sessionUploader.idle(sessionId);
    await sessionUploader.stop();
    return uploads;
  }

  test("start, trace and end uploads carry engine_version, harness and app_version", async () => {
    const uploads = await run({ appVersion: "3.4.0", engineVersion: BUNDLED_ENGINE_VERSION });
    expect(uploads.map((item) => item.snapshot_type)).toEqual(["start", "trace", "end"]);
    for (const envelope of uploads) {
      expect(envelope.environment.engine_version).toBe(BUNDLED_ENGINE_VERSION);
      expect(envelope.environment.app_version).toBe("3.4.0");
      expectHarness(envelope.environment.harness);
    }
  });

  test("the fields are never null, even when the host passes no versions", async () => {
    const uploads = await run({});
    expect(uploads.length).toBeGreaterThan(0);
    for (const envelope of uploads) {
      expect(envelope.environment.engine_version).toBe(BUNDLED_ENGINE_VERSION);
      expect(typeof envelope.environment.app_version).toBe("string");
      expect((envelope.environment.app_version as string).length).toBeGreaterThan(0);
      expectHarness(envelope.environment.harness);
    }
  });

  test("the session's trace starts with one client.launch event", async () => {
    const uploads = await run({ appVersion: "3.4.0", engineVersion: BUNDLED_ENGINE_VERSION });
    const events = uploads.filter((item) => item.snapshot_type === "trace").flatMap((item) => item.trace ?? []);
    expect(events.map((event) => event.type)).toEqual(["client.launch", "engine.request", "session.idle"]);
    const launch = events[0]!.data!;
    expect(launch.engine).toBe("opencode");
    expect(launch.engine_version).toBe(BUNDLED_ENGINE_VERSION);
    expectHarness(launch.harness);
  });
});
