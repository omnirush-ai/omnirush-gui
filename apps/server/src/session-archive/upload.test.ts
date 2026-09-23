import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { FakeArchiveServer } from "./fake-archive-server.js";
import { cleanupTempDirs, tempDir, testKeys } from "./test-helpers.js";
import { ArchiveUploader, resolveArchiveApiRoot, type ArchiveUploadJob, type ArchiveUploaderOptions } from "./upload.js";

afterEach(cleanupTempDirs);

const FAST_RETRY = { baseMs: 1, maxMs: 2, attempts: 3 };

async function sealedJob(bytes = randomBytes(4 * 1024 + 100), overrides: Partial<ArchiveUploadJob["request"]> = {}) {
  const dir = await tempDir("upload");
  const sealedPath = join(dir, "archive.orseal");
  await writeFile(sealedPath, bytes);
  const job: ArchiveUploadJob = {
    request: {
      archive_id: randomUUID(),
      session_id: "ses_upload_test",
      kind: "base",
      sequence: 0,
      turn: 0,
      parent_archive_id: null,
      size: bytes.length,
      sha256: "0".repeat(64),
      kid: testKeys.kid,
      content: "tar+zstd",
      marker: ".git",
      ...overrides,
    },
    sealedPath,
    upload: null,
    recreates: 0,
  };
  const persisted: string[] = [];
  const persist = async () => {
    persisted.push(JSON.stringify(job.upload));
  };
  return { job, bytes, persist, persisted };
}

function uploader(server: FakeArchiveServer, options: Partial<ArchiveUploaderOptions> = {}) {
  return new ArchiveUploader({ gatewayUrl: server.gatewayUrl, accessToken: server.token, fetch: server.respond, retry: FAST_RETRY, ...options });
}

describe("archive upload client", () => {
  test("the API root is derived like the collect URL", () => {
    expect(resolveArchiveApiRoot("https://api.omnirush.ai/omnirush/v1/")).toBe("https://api.omnirush.ai/omnirush");
    expect(resolveArchiveApiRoot("https://api.omnirush.ai/omnirush")).toBe("https://api.omnirush.ai/omnirush");
    expect(resolveArchiveApiRoot("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080");
    expect(resolveArchiveApiRoot("http://api.omnirush.ai/v1")).toBeNull();
    expect(resolveArchiveApiRoot(undefined)).toBeNull();
  });

  test("happy path: create, PUT every part from the file, complete", async () => {
    const server = new FakeArchiveServer();
    const { job, bytes, persist } = await sealedJob();
    const outcome = await uploader(server).upload(job, persist);
    expect(outcome).toEqual({ status: "uploaded" });
    const [archive] = server.objects();
    expect(archive!.object!.equals(bytes)).toBe(true);
    expect(server.puts.map((put) => put.partNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(server.callPaths()).toEqual(["POST archives 201", `POST archives/${job.request.archive_id}/complete 200`]);
    expect(Object.keys(job.upload!.etags)).toHaveLength(5);
  });

  test("the key route: kid checked against the public key; 428 and 503 turn archiving off", async () => {
    const server = new FakeArchiveServer();
    const client = uploader(server);
    const key = await client.fetchKey();
    expect(key.status).toBe("ok");
    if (key.status === "ok") expect(key.key.publicKey.equals(testKeys.publicKey)).toBe(true);
    server.gate = { status: 428, detail: "archive_consent_required" };
    expect(await client.fetchKey()).toEqual({ status: "disabled", code: "archive_consent_required" });
    server.gate = { status: 503, detail: "archive_disabled" };
    expect(await client.fetchKey()).toEqual({ status: "disabled", code: "archive_disabled" });
    // A 503 that is not archive_disabled is an outage, retried and then left for later.
    server.gate = { status: 503, detail: "maintenance" };
    expect((await client.fetchKey()).status).toBe("unavailable");
  });

  test("the key route's policy: all_folders and touched_files each only when it is the boolean true; anything else is off and the key still works", async () => {
    const server = new FakeArchiveServer();
    const client = uploader(server);
    const cases: Array<[unknown, boolean, boolean]> = [
      [{ all_folders: true }, true, false],
      [{ all_folders: true, other: "ignored" }, true, false],
      [{ touched_files: true }, false, true],
      [{ all_folders: true, touched_files: true }, true, true],
      [{ all_folders: false, touched_files: true }, false, true],
      [undefined, false, false],
      [null, false, false],
      [{}, false, false],
      [{ all_folders: false }, false, false],
      [{ all_folders: "true", touched_files: "true" }, false, false],
      [{ all_folders: 1, touched_files: 1 }, false, false],
      [{ all_folders: null, touched_files: null }, false, false],
      [[true], false, false],
      ["all_folders", false, false],
      ["touched_files", false, false],
    ];
    for (const [policy, allFolders, touchedFiles] of cases) {
      server.policy = policy;
      const fetched = await client.fetchKey();
      expect({ policy, status: fetched.status, policy_read: fetched.status === "ok" ? fetched.policy : null }).toEqual({ policy, status: "ok", policy_read: { allFolders, touchedFiles } });
    }
  });

  test("a create the server refuses for its marker (422 archive_marker_not_allowed) stops the session once; any other 422 stays archive_request_invalid", async () => {
    const server = new FakeArchiveServer();
    const client = uploader(server);
    for (const marker of ["touched", "folder"]) {
      const { job, persist } = await sealedJob(randomBytes(512), { marker });
      expect(await client.upload(job, persist)).toEqual({ status: "stop_session", code: "archive_marker_not_allowed" });
    }
    expect(server.calls.filter((call) => call.path === "archives").map((call) => call.status)).toEqual([422, 422]);
    server.policy = { touched_files: true };
    const { job, persist } = await sealedJob(randomBytes(512), { marker: "touched" });
    expect(await client.upload(job, persist)).toEqual({ status: "uploaded" });
    const invalid = await sealedJob(randomBytes(512), { kind: "base", sequence: 3 });
    expect(await client.upload(invalid.job, invalid.persist)).toEqual({ status: "stop_session", code: "archive_request_invalid" });
  });

  test("the policy probe is one GET: no backoff and no bearer refresh, whatever the failure", async () => {
    const failures: Array<[string, Response | "network"]> = [
      ["502", new Response("bad gateway", { status: 502 })],
      ["500", Response.json({ detail: "internal" }, { status: 500 })],
      ["503 maintenance", Response.json({ detail: "maintenance" }, { status: 503 })],
      ["429", Response.json({ detail: "slow_down" }, { status: 429 })],
      ["401", Response.json({ detail: "invalid_token" }, { status: 401 })],
      ["network", "network"],
    ];
    for (const [name, failure] of failures) {
      const server = new FakeArchiveServer();
      let attempts = 0;
      server.apiHook = ({ path }) => {
        if (path !== "archives/key") return undefined;
        attempts += 1;
        return failure === "network" ? "network" : failure.clone();
      };
      const sleeps: number[] = [];
      const refreshes: string[] = [];
      const client = uploader(server, {
        retry: { baseMs: 1_000, maxMs: 300_000, attempts: 8, sleep: async (ms) => void sleeps.push(ms) },
        refreshAccessToken: async () => (refreshes.push("refresh"), server.token),
      });
      const probed = await client.probeKey();
      expect({ name, status: probed.status, attempts, sleeps, refreshes }).toEqual({ name, status: "unavailable", attempts: 1, sleeps: [], refreshes: [] });
      // The full fetch, used for the key once a folder is known to be archived, still retries and refreshes.
      attempts = 0;
      await client.fetchKey();
      expect({ name, fullAttempts: attempts > 1 }).toEqual({ name, fullAttempts: true });
    }
  });

  test("the policy probe reads the key and the policy like fetchKey; 428, 503 and 404 answer disabled", async () => {
    const server = new FakeArchiveServer();
    const client = uploader(server);
    server.policy = { all_folders: true };
    const probed = await client.probeKey();
    expect(probed.status === "ok" && probed.policy.allFolders && probed.key.kid).toBe(testKeys.kid);
    server.policy = undefined;
    const off = await client.probeKey();
    expect(off.status === "ok" && off.policy.allFolders).toBe(false);
    server.gate = { status: 428, detail: "archive_consent_required" };
    expect(await client.probeKey()).toEqual({ status: "disabled", code: "archive_consent_required" });
    server.gate = { status: 503, detail: "archive_disabled" };
    expect(await client.probeKey()).toEqual({ status: "disabled", code: "archive_disabled" });
    server.gate = { status: 404, detail: "not_found" };
    expect(await client.probeKey()).toEqual({ status: "disabled", code: "archive_routes_missing" });
    expect(server.calls).toHaveLength(5);
  });

  test("through the request hook, the probe asks for no refresh and a short timeout; every other call keeps the refresh", async () => {
    const server = new FakeArchiveServer();
    const seen: Array<{ path: string; refresh: unknown; signal: boolean }> = [];
    const client = new ArchiveUploader({
      fetch: server.respond,
      retry: FAST_RETRY,
      request: (path, init) => {
        seen.push({ path, refresh: "refresh" in init ? init.refresh : "absent", signal: init.signal instanceof AbortSignal });
        return server.respond(`https://api.omnirush.test/omnirush/${path}`, { method: init.method, headers: { authorization: `Bearer ${server.token}` } });
      },
    });
    expect((await client.probeKey()).status).toBe("ok");
    expect((await client.fetchKey()).status).toBe("ok");
    expect(seen).toEqual([
      { path: "archives/key", refresh: false, signal: true },
      { path: "archives/key", refresh: "absent", signal: true },
    ]);
    // A probe that does not answer within POLICY_PROBE_TIMEOUT_MS is abandoned: an aborted signal ends it at once.
    const hanging = new ArchiveUploader({
      fetch: server.respond,
      request: (_path, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")))),
    });
    const controller = new AbortController();
    const pending = hanging.probeKey(controller.signal);
    controller.abort();
    expect((await pending).status).toBe("unavailable");
  });

  test("428 and 503 archive_disabled on create turn archiving off without an error", async () => {
    for (const gate of [{ status: 428, detail: "archive_consent_required" }, { status: 503, detail: "archive_disabled" }]) {
      const server = new FakeArchiveServer();
      server.gate = gate;
      const { job, persist } = await sealedJob();
      expect(await uploader(server).upload(job, persist)).toEqual({ status: "disabled", code: gate.detail });
      expect(server.puts).toHaveLength(0);
      expect(server.calls).toHaveLength(1);
    }
  });

  test("resume after a failed part: the failed part is sent again and the others are skipped", async () => {
    const server = new FakeArchiveServer();
    let failing = true;
    server.putHook = ({ partNumber }) => (failing && partNumber === 3 ? "network" : undefined);
    const { job, bytes, persist, persisted } = await sealedJob();
    const first = await uploader(server).upload(job, persist);
    expect(first.status).toBe("retry_later");
    // Parts 1 and 2 made it and were persisted before the failure.
    expect(Object.keys(job.upload!.etags).sort()).toEqual(["1", "2"]);
    expect(persisted.length).toBeGreaterThanOrEqual(3);
    // The app restarts from the persisted record: one /parts call, then only the missing parts.
    const restored: ArchiveUploadJob = JSON.parse(JSON.stringify(job));
    failing = false;
    server.puts.length = 0;
    const second = await uploader(server).upload(restored, persist);
    expect(second).toEqual({ status: "uploaded" });
    expect(server.puts.map((put) => put.partNumber)).toEqual([3, 4, 5]);
    expect(server.objects()[0]!.object!.equals(bytes)).toBe(true);
    expect(server.callPaths().filter((call) => call.includes("/parts"))).toEqual([`POST archives/${job.request.archive_id}/parts 200`]);
  });

  test("a part S3 already holds (answer lost before it was persisted) is not sent again", async () => {
    const server = new FakeArchiveServer();
    const { job, bytes, persist } = await sealedJob();
    let crash = true;
    const client = uploader(server);
    // Parts 1 and 2 go up, part 3 fails; then "crash" as if part 2's etag had never been persisted.
    server.putHook = ({ partNumber }) => (crash && partNumber === 3 ? "network" : undefined);
    expect((await client.upload(job, persist)).status).toBe("retry_later");
    delete job.upload!.etags["2"];
    crash = false;
    server.puts.length = 0;
    expect(await client.upload(job, persist)).toEqual({ status: "uploaded" });
    expect(server.puts.map((put) => put.partNumber)).toEqual([3, 4, 5]);
    expect(server.objects()[0]!.object!.equals(bytes)).toBe(true);
  });

  test("an expired presigned URL (403) is refreshed through /parts and retried", async () => {
    const server = new FakeArchiveServer();
    const { job, bytes, persist } = await sealedJob();
    server.putHook = ({ partNumber, attempt }) => {
      if (partNumber === 2 && attempt === 1) server.expireUrls();
      return undefined;
    };
    expect(await uploader(server).upload(job, persist)).toEqual({ status: "uploaded" });
    expect(server.puts.map((put) => `${put.partNumber}:${put.status}`)).toEqual(["1:200", "2:403", "2:200", "3:200", "4:200", "5:200"]);
    expect(server.callPaths()).toContain(`POST archives/${job.request.archive_id}/parts 200`);
    expect(server.objects()[0]!.object!.equals(bytes)).toBe(true);
  });

  test("401: the bearer is refreshed once and the call retried; a failed refresh blocks the drain", async () => {
    const server = new FakeArchiveServer();
    server.token = "token-2";
    const { job, persist } = await sealedJob();
    let refreshes = 0;
    const client = uploader(server, {
      accessToken: "token-1",
      refreshAccessToken: async () => {
        refreshes += 1;
        return "token-2";
      },
    });
    expect(await client.upload(job, persist)).toEqual({ status: "uploaded" });
    expect(refreshes).toBe(1);
    expect(server.callPaths()[0]).toBe("POST archives 401");

    const other = new FakeArchiveServer();
    other.token = "rotated";
    const second = await sealedJob();
    const stuck = uploader(other, { accessToken: "stale", refreshAccessToken: async () => null });
    expect(await stuck.upload(second.job, second.persist)).toEqual({ status: "blocked", reason: "unauthorized" });
  });

  test("NoSuchUpload on a part: /parts answers archive_not_uploading and the upload is re-created", async () => {
    const server = new FakeArchiveServer();
    const { job, bytes, persist } = await sealedJob();
    let forgotten = false;
    server.putHook = ({ archiveId, partNumber }) => {
      if (partNumber === 3 && !forgotten) {
        forgotten = true;
        server.forgetUpload(archiveId);
      }
      return undefined;
    };
    expect(await uploader(server).upload(job, persist)).toEqual({ status: "uploaded" });
    const paths = server.callPaths();
    expect(paths).toEqual([
      "POST archives 201",
      `POST archives/${job.request.archive_id}/parts 409`,
      "POST archives 201",
      `POST archives/${job.request.archive_id}/complete 200`,
    ]);
    // The restarted upload sends every part again.
    expect(server.puts.filter((put) => put.status === 200).map((put) => put.partNumber)).toEqual([1, 2, 1, 2, 3, 4, 5]);
    expect(server.objects()[0]!.object!.equals(bytes)).toBe(true);
  });

  test("archive_not_uploading at complete re-creates with the same body", async () => {
    const server = new FakeArchiveServer();
    const { job, bytes, persist } = await sealedJob();
    let aborted = false;
    server.apiHook = ({ path }) => {
      if (path.endsWith("/complete") && !aborted) {
        aborted = true;
        server.forgetUpload(job.request.archive_id);
      }
      return undefined;
    };
    expect(await uploader(server).upload(job, persist)).toEqual({ status: "uploaded" });
    expect(server.callPaths()).toEqual([
      "POST archives 201",
      `POST archives/${job.request.archive_id}/complete 409`,
      "POST archives 201",
      `POST archives/${job.request.archive_id}/complete 200`,
    ]);
    expect(server.objects()[0]!.object!.equals(bytes)).toBe(true);
  });

  test("archive_parts_invalid at complete relists and re-uploads what S3 lacks", async () => {
    const server = new FakeArchiveServer();
    const { job, bytes, persist } = await sealedJob();
    let dropped = false;
    server.apiHook = ({ path }) => {
      if (path.endsWith("/complete") && !dropped) {
        dropped = true;
        server.archives.get(job.request.archive_id)!.parts!.delete(4);
      }
      return undefined;
    };
    expect(await uploader(server).upload(job, persist)).toEqual({ status: "uploaded" });
    expect(server.puts.map((put) => put.partNumber)).toEqual([1, 2, 3, 4, 5, 4]);
    expect(server.objects()[0]!.object!.equals(bytes)).toBe(true);
  });

  test("a replayed create of an uploaded archive is done; chain-ending conflicts stop the session; an unknown kid asks for a new seal", async () => {
    const server = new FakeArchiveServer();
    const { job, persist } = await sealedJob();
    const client = uploader(server);
    expect(await client.upload(job, persist)).toEqual({ status: "uploaded" });
    const replay: ArchiveUploadJob = { ...job, upload: null };
    expect(await client.upload(replay, persist)).toEqual({ status: "uploaded" });

    const conflict = await sealedJob(undefined, { archive_id: randomUUID() });
    expect(await client.upload(conflict.job, conflict.persist)).toEqual({ status: "stop_session", code: "archive_sequence_conflict" });

    const orphan = await sealedJob(undefined, { kind: "delta", sequence: 1, turn: 1, parent_archive_id: randomUUID(), session_id: "ses_other_1" });
    expect(await client.upload(orphan.job, orphan.persist)).toEqual({ status: "stop_session", code: "archive_parent_mismatch" });

    const rekey = await sealedJob(undefined, { kid: "0123456789abcdef", session_id: "ses_other_2" });
    expect(await client.upload(rekey.job, rekey.persist)).toEqual({ status: "rekey", code: "archive_kid_unknown" });
  });

  test("network errors and 5xx back off and are left for a later drain; 502 recovers", async () => {
    const server = new FakeArchiveServer();
    const { job, persist } = await sealedJob();
    let failures = 0;
    server.apiHook = ({ path }) => {
      if (path === "archives" && failures < 2) {
        failures += 1;
        return failures === 1 ? "network" : new Response(JSON.stringify({ detail: "archive_storage_error" }), { status: 502 });
      }
      return undefined;
    };
    const slept: number[] = [];
    const client = uploader(server, { retry: { ...FAST_RETRY, sleep: async (ms) => void slept.push(ms) } });
    expect(await client.upload(job, persist)).toEqual({ status: "uploaded" });
    expect(slept).toHaveLength(2);

    const down = new FakeArchiveServer();
    down.apiHook = () => "network";
    const second = await sealedJob();
    expect((await uploader(down).upload(second.job, second.persist)).status).toBe("retry_later");
  });

  test("an API request hook replaces the bearer handling (the gateway broker path)", async () => {
    const server = new FakeArchiveServer();
    const { job, persist } = await sealedJob();
    const seen: string[] = [];
    const client = new ArchiveUploader({
      fetch: server.respond,
      retry: FAST_RETRY,
      request: (path, init) => {
        seen.push(`${init.method} ${path}`);
        return server.respond(`https://api.omnirush.test/omnirush/${path}`, { method: init.method, body: init.body, headers: { Authorization: `Bearer ${server.token}` } });
      },
    });
    expect(client.configured).toBe(true);
    expect(await client.upload(job, persist)).toEqual({ status: "uploaded" });
    expect(seen).toEqual(["POST archives", `POST archives/${job.request.archive_id}/complete`]);
  });
});
