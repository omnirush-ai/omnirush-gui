import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { setRedactionPolicy } from "./context/redact-policy.js";
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

/**
 * A new chat on an app that has not read the server's capture switch yet (process default legacy). `answers`
 * plays the archiver's /archives/key probe: each call takes the next entry; null is an outage (no answer).
 */
async function newChat(answers: Array<"client-v3" | "client-raw" | "legacy" | null | "hang">, opts: { stateDir?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "omnirush-policy-settle-"));
  roots.push(root);
  await writeFile(join(root, "app.txt"), "hello\n");
  setRedactionPolicy("legacy");
  const uploads: Array<Record<string, unknown>> = [];
  let calls = 0;
  const uploader = new SessionUploader({
    ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
    upload: async (_sessionId, compressed) => {
      uploads.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")));
      return Response.json({ ok: true }, { status: 201 });
    },
    settleCapturePolicy: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (answer === "hang") return new Promise<string | null>(() => {});
      if (answer) setRedactionPolicy(answer);
      return answer ?? null;
    },
    changeDebounceMs: 10,
    fallbackScanMs: 60_000,
  });
  return { uploader, uploads, calls: () => calls, root };
}

describe("a new chat pins only the server's answer to its capture switch", () => {
  test("v3 server: the pin (what the strict bind sends) is client-v3, and every upload agrees", async () => {
    const { uploader, uploads, root } = await newChat(["client-v3"]);
    uploader.startSession("ses-settle-v3", "ws", root);
    expect(await uploader.settledPolicy("ses-settle-v3")).toBe("client-v3");
    uploader.recordTrace("ses-settle-v3", "tool.call", { name: "x" });
    uploader.flushTrace("ses-settle-v3");
    await uploader.stop();
    expect(uploads.length).toBeGreaterThan(0);
    expect(new Set(envelopePolicies(uploads))).toEqual(new Set(["client-v3"]));
  });

  test("raw server (prod today): the pin is client-raw, and every upload agrees", async () => {
    const { uploader, uploads, root } = await newChat(["client-raw"]);
    uploader.startSession("ses-settle-raw", "ws", root);
    expect(await uploader.settledPolicy("ses-settle-raw")).toBe("client-raw");
    uploader.recordTrace("ses-settle-raw", "tool.call", { name: "x" });
    uploader.flushTrace("ses-settle-raw");
    await uploader.stop();
    expect(new Set(envelopePolicies(uploads))).toEqual(new Set(["client-raw"]));
  });

  test("a confirmed legacy answer (the server turned neither on) is a pin, unlike no answer", async () => {
    const { uploader, root } = await newChat(["legacy"]);
    uploader.startSession("ses-settle-legacy", "ws", root);
    expect(await uploader.settledPolicy("ses-settle-legacy")).toBe("legacy");
    await uploader.stop();
  });

  test("no answer: unresolved, so no pin (a strict bind refuses), nothing uploaded, no pin kept in the ledger", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "omnirush-policy-settle-state-"));
    roots.push(stateDir);
    const { uploader, uploads, root } = await newChat(["hang"], { stateDir });
    uploader.startSession("ses-settle-hang", "ws", root);
    uploader.recordTrace("ses-settle-hang", "tool.call", { name: "x" });
    uploader.flushTrace("ses-settle-hang");
    expect(await uploader.settledPolicy("ses-settle-hang", 200)).toBeNull();
    await uploader.stop();
    expect(uploads).toEqual([]);
    const ledger = await readFile(join(stateDir, "omnirush-sessions.json"), "utf8").catch(() => "");
    expect(ledger).not.toMatch(/"ses-settle-hang"[^}]*redactionPolicy/);
  }, 20_000);

  test("an outage, then an answer: the chat waits, then pins the answer; nothing went up under a guess", async () => {
    const { uploader, uploads, calls, root } = await newChat([null, "client-v3"]);
    uploader.startSession("ses-settle-late", "ws", root);
    uploader.recordTrace("ses-settle-late", "tool.call", { name: "x" });
    uploader.flushTrace("ses-settle-late");
    expect(await uploader.settledPolicy("ses-settle-late", 10_000)).toBe("client-v3");
    expect(calls()).toBeGreaterThanOrEqual(2);
    await uploader.stop();
    expect(uploads.length).toBeGreaterThan(0);
    expect(new Set(envelopePolicies(uploads))).toEqual(new Set(["client-v3"]));
  }, 20_000);
});
