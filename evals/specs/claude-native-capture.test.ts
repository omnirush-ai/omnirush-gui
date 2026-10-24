import { createHash } from "node:crypto";
import { expect } from "vitest";
import { startCaptureEfficiencyLab } from "@omnirush/labs";
import { needs, test } from "@omnirush/testkit";

test("Claude native evidence survives capture-worker restart and exports every conversation branch and child", { timeout: 60_000 }, async ({ evidence }) => {
  needs({ placement: "local", commands: ["bun"] });
  const lab = await startCaptureEfficiencyLab();
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const actor = "actor-a";
  const request = async (operation: string, extra: Record<string, unknown> = {}, status = 202) => {
    const response = await fetch(`${lab.baseUrl}/control/native/${operation}`, {
      method: "POST", headers: { authorization: `Bearer ${lab.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId, actor, ...extra }), signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(status); return body;
  };
  try {
    const seeded = await request("seed");
    const partial = await request("finish");
    expect(partial.status).toBe("incomplete");
    expect(partial.issues).toContain(`partial_line:claude/projects/-fixture-workspace/${sessionId}.jsonl`);
    await request("finish", { actor: "actor-b" }, 403);
    await request("account", { signedIn: null });
    await request("finish", {}, 500);
    await request("account", { signedIn: "actor-b" });
    await request("finish", {}, 500);
    await request("account", { signedIn: actor });
    const event = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "visible delta" } } }) + "\n";
    await request("stream", { text: event, offset: 0 });
    await request("restart");
    const duplicate = await request("stream", { text: event, offset: 0 });
    expect(duplicate.streams.sdk).toBe(Buffer.byteLength(event));
    await request("stream", { text: "conflicting", offset: 0 }, 500);
    await request("repair");
    const complete = await request("finish");
    expect(complete.status).toBe("complete");
    expect(complete.replay).toBe("unverified");
    expect(complete.files).toHaveLength(12);
    expect((await lab.witness()).modes).toEqual(["worker", "worker"]);
    const exported = await request("export");
    const files: Array<{ path: string; text: string }> = exported.files;
    const root = files.find((file) => file.path.endsWith(`/${sessionId}.jsonl`));
    if (!root) throw new Error("native root missing");
    expect(createHash("sha256").update(root.text).digest("hex")).toBe(seeded.rootSha256);
    expect(root.text).toContain("side-result"); expect(root.text).toContain("main-result");
    expect(root.text).toContain("opaque-fixture"); expect(root.text).toContain("futureNativeField");
    expect(files.filter((file) => file.path.includes("/subagents/") && file.path.endsWith(".jsonl"))).toHaveLength(5);
    expect(files.filter((file) => file.path.endsWith(".meta.json"))).toHaveLength(5);
    expect(files.find((file) => file.path === "events/sdk.jsonl")?.text).toBe(event);
    expect(JSON.stringify(files)).not.toContain("DO_NOT_EXPORT_AUTH");
    expect(JSON.stringify(files)).not.toContain("DO_NOT_EXPORT_OTHER_SESSION");
    expect((await lab.witness()).attempts).toHaveLength(0);
    evidence.recordAssertionEvidence("Native branches, subagents and opaque fields survive byte-exact private export", "The source SHA-256 matched; both branch results, five child JSONL files and five sidecars survived. Auth and unrelated-session canaries were absent; no raw evidence went to the legacy collector.", true);
    evidence.recordAssertionEvidence("Incomplete capture fails closed and stream retries survive worker restart", "A truncated record stayed incomplete; a real suffix repaired it. Retrying the same offset after worker restart did not duplicate bytes, conflicting retry failed, and another actor was denied. Capture completion remained replay-unverified.", true);
  } finally { await lab.stop(); }
});
