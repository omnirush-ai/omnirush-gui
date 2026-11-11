// The sealed native archive is synced through a handle that may write: on Windows a read-only handle's sync fails with
// EPERM, so every Claude turn's transcript stayed pending there.
import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";

import { uploadNativeBundle, type NativeArchiveDriver } from "./upload.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("the sealed native archive is synced through a writable handle", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "claude-upload-")); dirs.push(root);
  const native = path.join(root, "native"), body = Buffer.from("{\"type\":\"user\"}\n");
  mkdirSync(path.join(native, "__omnirush__"), { recursive: true });
  writeFileSync(path.join(native, "session.jsonl"), body);
  const binding = { sessionId: "ses_1", bindingId: "bind_1", contractHash: "a".repeat(64), engineVersion: "claude-code/2.0.0" };
  writeFileSync(path.join(native, "__omnirush__", "manifest.json"), JSON.stringify({
    schema: "omnirush.claude.native.v1", session_id: binding.sessionId, root_session_id: binding.sessionId, binding_id: binding.bindingId,
    contract_hash: binding.contractHash, harness: "claude-code", engine_version: binding.engineVersion, payload: "claude_native",
    files: [{ path: "session.jsonl", size: body.length, sha256: createHash("sha256").update(body).digest("hex") }],
  }));
  const driver: NativeArchiveDriver = {
    fetchKey: async () => ({ status: "ok", key: { kid: "k1", publicKey: Buffer.alloc(32), alg: "test" } }),
    upload: async () => ({ status: "uploaded" }),
    tarHeader: () => Buffer.alloc(512),
    sealer: () => {
      const digest = createHash("sha256"); let size = 0;
      return Object.assign(new Transform({ transform(chunk: Buffer, _e, done) { size += chunk.length; digest.update(chunk); done(null, chunk); } }),
        { kid: "k1", result: () => ({ size, sha256: digest.digest("hex") }) });
    },
  };
  const opened = spyOn(fsp, "open");
  try {
    const receipt = await uploadNativeBundle({
      ...binding, owner: "acct", turn: 0, nativeDirectory: native, stateDirectory: path.join(root, "state"), driver,
      capabilities: { schema: 1, native: { enabled: true, max_bytes: 1 << 20 }, checkpoint: { enabled: false, max_bytes: 1, retention_days: null } },
    });
    expect(receipt.native.status).toBe("uploaded");
    const sealedOpens = opened.mock.calls.filter(([file]) => String(file).endsWith(".orseal.tmp"));
    expect(sealedOpens.map(([, flags]) => flags)).toEqual(["r+"]);
  } finally { opened.mockRestore(); }
});
