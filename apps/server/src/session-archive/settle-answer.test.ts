import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { setRedactionPolicy } from "../context/redact-policy.js";
import { FakeArchiveServer } from "./fake-archive-server.js";
import { SessionArchiver } from "./index.js";
import { cleanupTempDirs, tempDir } from "./test-helpers.js";

const execFileAsync = promisify(execFile);
afterEach(async () => {
  setRedactionPolicy("legacy");
  await cleanupTempDirs();
});

async function gitProject(): Promise<string> {
  const root = await tempDir("project");
  const git = (...args: string[]) => execFileAsync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args]);
  await git("init", "-q", "-b", "main");
  await writeFile(join(root, "app.ts"), "export const app = 1;\n");
  await git("add", "app.ts");
  await git("commit", "-q", "-m", "initial");
  return root;
}

function subjectFor(server: FakeArchiveServer, stateDir: string) {
  return new SessionArchiver({ gatewayUrl: server.gatewayUrl, accessToken: server.token, fetch: server.respond, stateDir, retry: { baseMs: 1, maxMs: 2, attempts: 2 } });
}

describe("the capture switch's answer and the first base use the same key response", () => {
  test("a fresh answer: the chat's pin and its base share one key read", async () => {
    const server = new FakeArchiveServer();
    server.policy = { redaction_v3: true };
    const subject = subjectFor(server, await tempDir("state"));
    expect(await subject.settleCapturePolicy()).toBe("client-v3");
    expect(await subject.captureBase("ses_settle_fresh", await gitProject())).toMatchObject({ status: "queued", kind: "base" });
    expect(server.calls.filter((call) => call.path === "archives/key")).toHaveLength(1);
  });

  test("a cached answer: the next chat's pin and base reuse the cached response, no new key read", async () => {
    const server = new FakeArchiveServer();
    server.policy = { redaction_v3: true };
    const subject = subjectFor(server, await tempDir("state"));
    expect(await subject.settleCapturePolicy()).toBe("client-v3");
    await subject.captureBase("ses_settle_first", await gitProject());
    // A second chat: the policy is cached now; its pin and its base must still share one answer.
    expect(await subject.settleCapturePolicy()).toBe("client-v3");
    expect(await subject.captureBase("ses_settle_second", await gitProject())).toMatchObject({ status: "queued", kind: "base" });
    expect(server.calls.filter((call) => call.path === "archives/key")).toHaveLength(1);
  });
});
