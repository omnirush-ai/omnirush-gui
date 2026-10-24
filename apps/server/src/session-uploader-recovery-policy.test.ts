import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

const policyOf = (envelope: Record<string, unknown>) =>
  String(((envelope.privacy ?? envelope.privacy_policy) as { redaction_policy?: unknown } | undefined)?.redaction_policy ?? "missing");

/**
 * A chat killed with an unsent trace, whose ledger record is then lost: the next launch knows it only from the
 * server's copy (a server-only recovery). The next launch starts before it read the server's capture switch
 * (process default legacy); `answer` plays the switch's answer (null: no answer).
 */
async function serverOnlyRecovery(answer: "client-v3" | "client-raw" | null) {
  const root = await mkdtemp(join(tmpdir(), "omnirush-recovery-policy-"));
  const stateDir = await mkdtemp(join(tmpdir(), "omnirush-recovery-policy-state-"));
  roots.push(root, stateDir);
  await writeFile(join(root, "app.txt"), "hello\n");
  const envelopes: Array<Record<string, unknown>> = [];
  const upload = async (_sessionId: string, compressed: Uint8Array) => {
    envelopes.push(JSON.parse(zstdDecompressSync(compressed).toString("utf8")));
    return Response.json({ ok: true }, { status: 201 });
  };
  setRedactionPolicy("legacy");
  const crashed = new SessionUploader({ stateDir, upload, fallbackScanMs: 60_000, idleEndMs: 0 });
  const sessionId = "session-recoverypolicy-1234";
  crashed.startSession(sessionId, "workspace-recoverypolicy", root);
  crashed.captureSnapshot(sessionId, "prompt");
  crashed.flushTrace(sessionId, { messages: [] });
  await crashed.idle(sessionId);
  crashed.recordTrace(sessionId, "tool.call", { n: 2 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await rm(join(stateDir, "omnirush-upload-sessions.json"), { force: true });
  const top = Math.max(...envelopes.map((item) => item.sequence as number));
  setRedactionPolicy("legacy"); // the next launch: the switch not read yet
  let asked = 0;
  const next = new SessionUploader({
    stateDir,
    upload,
    fallbackScanMs: 60_000,
    capabilities: async () => ({ schema_versions: [1, 2], canonical_trace: false, idempotency_key: true, integrity: true, integrity_summary: true }),
    sessionIntegrity: async (id) => Response.json({ session_id: id, max_segment: 1, max_sequence: top, segments: [{ segment: 1, sequences: [], gaps: [], max_sequence: top }] }),
    confirm: false,
    settleCapturePolicy: async () => {
      asked += 1;
      if (answer) setRedactionPolicy(answer);
      return answer;
    },
  });
  for (let waited = 0; waited < 4_000 && !envelopes.some((item) => (item.sequence as number) > top); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  await next.stop();
  return { recovered: envelopes.filter((item) => (item.sequence as number) > top), asked };
}

describe("a server-only recovery takes the server's capture switch, never the default", () => {
  test("a v3 answer: the recovered trace goes up as client-v3 (the default was legacy)", async () => {
    const { recovered, asked } = await serverOnlyRecovery("client-v3");
    expect(asked).toBeGreaterThanOrEqual(1);
    expect(recovered.length).toBeGreaterThan(0);
    expect(new Set(recovered.map(policyOf))).toEqual(new Set(["client-v3"]));
  }, 20_000);

  test("a raw answer: a chat that went up before pins stays off raw (client-v3)", async () => {
    const { recovered } = await serverOnlyRecovery("client-raw");
    expect(recovered.length).toBeGreaterThan(0);
    expect(new Set(recovered.map(policyOf))).toEqual(new Set(["client-v3"]));
  }, 20_000);

  test("no answer: nothing goes up (the journal waits for a later start)", async () => {
    const { recovered, asked } = await serverOnlyRecovery(null);
    expect(asked).toBeGreaterThanOrEqual(1);
    expect(recovered).toEqual([]);
  }, 20_000);
});
