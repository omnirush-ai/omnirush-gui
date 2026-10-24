import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { defaultRedactionPolicy, setRedactionPolicy } from "./context/redact-policy.js";
import { SessionUploader } from "./session-uploader.js";

const roots: string[] = [];
afterEach(async () => {
  setRedactionPolicy("legacy");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The policy every envelope of the run says it was captured under. */
function envelopePolicies(uploads: Array<Record<string, unknown>>): string[] {
  return uploads.map((envelope) => {
    const privacy = (envelope.privacy ?? envelope.privacy_policy) as { redaction_policy?: unknown } | undefined;
    return String(privacy?.redaction_policy ?? "missing");
  });
}

async function newChat(serverSays: "client-v3" | "client-raw", settleDelayMs: number) {
  const root = await mkdtemp(join(tmpdir(), "omnirush-policy-settle-"));
  roots.push(root);
  await writeFile(join(root, "app.txt"), "hello\n");
  setRedactionPolicy("legacy"); // the app just started: the server's switch not read yet
  const uploads: Array<Record<string, unknown>> = [];
  let probes = 0;
  const uploader = new SessionUploader({
    upload: async (_sessionId, compressed) => {
      uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")));
      return Response.json({ ok: true }, { status: 201 });
    },
    // The archiver's /archives/key probe: the server's switch arrives after a while.
    settleCapturePolicy: async () => {
      probes += 1;
      await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
      setRedactionPolicy(serverSays);
    },
    changeDebounceMs: 10,
    fallbackScanMs: 60_000,
  });
  const sessionId = `ses-settle-${serverSays}`;
  uploader.startSession(sessionId, "ws", root);
  const pinned = await uploader.settledPolicy(sessionId);
  uploader.recordTrace(sessionId, "tool.call", { name: "x" });
  uploader.flushTrace(sessionId);
  await uploader.stop();
  return { pinned, uploads, probes };
}

describe("a new chat pins the server's capture switch, not the pre-probe default", () => {
  test("v3 server: the pin (what the strict bind sends) is client-v3, and every upload agrees", async () => {
    const { pinned, uploads, probes } = await newChat("client-v3", 50);
    expect(probes).toBe(1);
    expect(pinned).toBe("client-v3");
    expect(uploads.length).toBeGreaterThan(0);
    expect(new Set(envelopePolicies(uploads))).toEqual(new Set(["client-v3"]));
  });

  test("raw server (prod today): the pin is client-raw, and every upload agrees", async () => {
    const { pinned, uploads } = await newChat("client-raw", 50);
    expect(pinned).toBe("client-raw");
    expect(new Set(envelopePolicies(uploads))).toEqual(new Set(["client-raw"]));
  });

  test("a switch that never answers holds the chat at most POLICY_SETTLE_MS, then the known default", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-policy-settle-"));
    roots.push(root);
    setRedactionPolicy("legacy");
    const uploader = new SessionUploader({
      upload: async () => Response.json({ ok: true }, { status: 201 }),
      settleCapturePolicy: () => new Promise<void>(() => {}),
      changeDebounceMs: 10,
      fallbackScanMs: 60_000,
    });
    const started = Date.now();
    uploader.startSession("ses-settle-hang", "ws", root);
    const pinned = await uploader.settledPolicy("ses-settle-hang");
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(pinned).toBe(defaultRedactionPolicy());
    await uploader.stop();
  }, 15_000);
});
