import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { createProjectArchive } from "./project-archive.js";
import { FakeArchiveServer, slowPartTwo } from "./session-archive/fake-archive-server.js";
import { ARCHIVE_STATE_DIRECTORY } from "./session-archive/index.js";
import { cleanupTempDirs, tempDir } from "./session-archive/test-helpers.js";
import type { ServerConfig } from "./types.js";

const execFileAsync = promisify(execFile);

afterEach(cleanupTempDirs);

function serverConfig(stateDir: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    configPath: join(stateDir, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "json",
    logRequests: false,
  };
}

/** The gateway broker's archive hook in front of the fake archive API, recording what it was asked. */
function broker(server: FakeArchiveServer) {
  const paths: string[] = [];
  return {
    paths,
    enabled: true,
    archiveRequest: (path: string, init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal }) => {
      paths.push(`${init.method} ${path}`);
      return server.respond(`https://api.omnirush.test/omnirush/${path}`, {
        method: init.method,
        headers: { authorization: `Bearer ${server.token}` },
        ...(init.body === undefined ? {} : { body: init.body }),
      });
    },
    refreshAccessToken: async () => null,
  };
}

async function gitProject(): Promise<string> {
  const root = await tempDir("project");
  await writeFile(join(root, "README.md"), "# project\n");
  for (const args of [["init", "-q"], ["add", "README.md"], ["commit", "-q", "-m", "initial"]]) {
    await execFileAsync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args]);
  }
  return root;
}

const rootSession = { session: async () => ({ id: "ses_project_0001" }), messages: async () => [] };

describe("createProjectArchive", () => {
  test("with an account, archives go through the gateway broker's device session into the collector state dir", async () => {
    const server = new FakeArchiveServer();
    const gateway = broker(server);
    const stateDir = await tempDir("state");
    const root = await gitProject();
    const archive = createProjectArchive({ config: serverConfig(stateDir), gatewayBroker: gateway, collectorEnabled: true, log: () => undefined, env: {}, fetch: server.respond });
    archive.start();
    archive.sessionStarted({ sessionId: "ses_project_0001", root, engine: rootSession });
    await archive.settled();
    await archive.stop();

    expect(server.objects().map((object) => [object.request.session_id, object.request.kind, object.request.turn])).toEqual([["ses_project_0001", "base", 0]]);
    expect(gateway.paths.slice(0, 2)).toEqual(["GET archives/key", "POST archives"]);
    expect(await readdir(join(stateDir, ARCHIVE_STATE_DIRECTORY))).toContain("sessions");
  });

  test("sign-out aborts the part PUT in flight within a second and aborts the upload through the broker before the queue goes", async () => {
    const server = new FakeArchiveServer();
    server.partSize = 256;
    const gateway = broker(server);
    const stateDir = await tempDir("state");
    const root = await gitProject();
    const slow = slowPartTwo(server);
    const archive = createProjectArchive({ config: serverConfig(stateDir), gatewayBroker: gateway, collectorEnabled: true, log: () => undefined, env: {}, fetch: slow.fetch });
    archive.start();
    archive.sessionStarted({ sessionId: "ses_project_0001", root, engine: rootSession });
    await slow.started;

    slow.markCommand();
    await archive.signOut();
    expect(Date.now() - slow.commandAt).toBeLessThan(1_000);
    expect(slow.puts).toEqual([{ part: 2, bytes: 256, abortedAfterMs: expect.any(Number), completed: false }]);
    expect(slow.puts[0]!.abortedAfterMs!).toBeLessThan(1_000);
    const [archiveId] = [...server.archives.keys()];
    expect(gateway.paths.filter((path) => path.startsWith(`POST archives/${archiveId}/`))).toEqual([`POST archives/${archiveId}/abort`]);
    expect(server.archives.get(archiveId!)!.status).toBe("aborted");
    await archive.settled();
    expect(await readdir(stateDir)).not.toContain(ARCHIVE_STATE_DIRECTORY);
    expect(slow.puts).toHaveLength(1);
  });

  test("OMNIRUSH_ARCHIVE_ENABLED=0 clears what a previous run left, without any network, and archives nothing", async () => {
    const server = new FakeArchiveServer();
    const gateway = broker(server);
    const stateDir = await tempDir("state");
    const root = await gitProject();
    // A previous run's queued archive.
    await mkdir(join(stateDir, ARCHIVE_STATE_DIRECTORY, "pending"), { recursive: true });
    await writeFile(join(stateDir, ARCHIVE_STATE_DIRECTORY, "pending", "leftover.orseal"), "sealed");
    const fetched: string[] = [];
    const archive = createProjectArchive({
      config: serverConfig(stateDir),
      gatewayBroker: gateway,
      collectorEnabled: true,
      log: () => undefined,
      env: { OMNIRUSH_ARCHIVE_ENABLED: "0", OMNIRUSH_GATEWAY_URL: server.gatewayUrl, OMNIRUSH_ACCESS_TOKEN: server.token },
      fetch: async (input, init) => {
        fetched.push(input);
        return server.respond(input, init);
      },
    });
    archive.start();
    archive.sessionStarted({ sessionId: "ses_project_0001", root, engine: rootSession });
    await archive.settled();

    expect(await readdir(stateDir)).not.toContain(ARCHIVE_STATE_DIRECTORY);
    expect(gateway.paths).toEqual([]);
    expect(fetched).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  test("signed out (no collector account): the same clearing, nothing archived", async () => {
    const server = new FakeArchiveServer();
    const gateway = { ...broker(server), enabled: false };
    const stateDir = await tempDir("state");
    await mkdir(join(stateDir, ARCHIVE_STATE_DIRECTORY, "queue"), { recursive: true });
    const archive = createProjectArchive({ config: serverConfig(stateDir), gatewayBroker: gateway, collectorEnabled: false, log: () => undefined, env: {} });
    archive.start();
    archive.sessionStarted({ sessionId: "ses_project_0001", root: await gitProject(), engine: rootSession });
    await archive.settled();
    expect(await readdir(stateDir)).not.toContain(ARCHIVE_STATE_DIRECTORY);
    expect(gateway.paths).toEqual([]);
  });
});
