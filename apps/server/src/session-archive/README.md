# session-archive

The desktop side of the OmniRush project archive. When the folder an agent
session started in contains `.git`, the whole folder is uploaded:

- at session start: a **base** archive, including `.git/` and gitignored content;
- after every completed turn that changed anything: a **delta** archive with the
  added and modified entries plus the deleted paths.

Each archive is a pax tar, compressed with zstd and sealed with ORSEAL01 to the
omnirush.ai archive key. It is queued durably under the collector state dir and
uploaded straight to S3 through presigned multipart URLs.

The normative specification is `docs/omnirush-project-archive.md` in the
backend repository (subscription-manager). Section numbers below refer to it.
The shared seal vectors are in `__fixtures__/orseal_vectors.json`, identical in
both repositories.

**Status: wired.** The embedded server drives it through `lifecycle.ts`
(`ProjectArchiveLifecycle`), built by `../project-archive.ts`
(`createProjectArchive`). See "Wiring" below for the hooks in `server.ts`.
The user-facing description is `docs/project-archive.md`.

## Files

| File | Responsibility |
| --- | --- |
| `detect.ts` | `isArchivableProject(root, detectors?, options?)` and `gitMarkerDetector` (section 4). A pluggable gate; only the `.git` marker is enabled |
| `manifest.ts` | Scan with the exclusions and credential filter (5.2, 5.3; reuses the collector's `isCollectorPathDenied`, `stripRemoteUserinfo` and `clampCollectorBytes`), streaming SHA-256 with the `(path, size, mtimeNs, ctimeNs, ino)` hash cache, delta computation (5.8), `manifest.json` (5.6) and the git block |
| `pack.ts` | Streaming pax tar writer (5.5) with unstable-entry detection (5.9), and the file -> tar -> zstd -> ORSEAL01 -> temp file pipeline (5.10, 13.1) |
| `seal.ts` | Streaming ORSEAL01 sealer and opener (section 6) over Node `crypto` |
| `upload.ts` | Multipart upload client over an injectable `fetch` (sections 7 and 13.5) |
| `files.ts` | Atomic state-file writes and the GC hint |
| `index.ts` | `SessionArchiver`: durable queue, crash recovery, drain |
| `lifecycle.ts` | `ProjectArchiveLifecycle`: when the server calls the archiver (session start, turn end, session end, sign-out, shutdown), the engine-derived turn count, the child-session check, the consent-off window and the bounded background queue; `projectArchiveEnabled` (`OMNIRUSH_ARCHIVE_ENABLED`) |
| `fake-archive-server.ts`, `test-helpers.ts` | Test support only |

## API

```ts
import { SessionArchiver } from "./session-archive/index.js";

const archiver = new SessionArchiver({
  stateDir,                          // the collector state dir; files go to <stateDir>/omnirush-archive/
  request,                           // authenticated API calls (see "Authentication" below), or:
  gatewayUrl, accessToken,           //   the gateway URL plus a bearer,
  refreshAccessToken,                //   and the collector's refresh hook
  excludedDirs,                      // app data/temp dirs to prune when they sit under a project root
  archiveIncludeCredentialFiles,     // default false
  log,
});

await archiver.start();                                   // crash recovery; idempotent
await archiver.captureBase(sessionId, root, turn?);       // -> CaptureResult
await archiver.captureDelta(sessionId, root, turn);       // -> CaptureResult
await archiver.drain();                                   // -> DrainResult
await archiver.signOut();                                 // drop everything
await archiver.stop();                                    // shutdown
archiver.setAccessToken(token);                           // token rotation (gatewayUrl mode only)
await archiver.pendingStatus();                           // { jobs, bytes, disabled }
```

No method throws. Failures are logged (never with presigned URLs or tokens)
and reported in the result.

`CaptureResult` is `{status: "queued", archiveId, kind, sequence, size}` or
`{status: "skipped", reason}`. The reasons of section 13.2 are
`not_archivable`, `disabled`, `exists`, `no_base`, `unchanged` and `stopped`.
This implementation adds three more:

- `unavailable`: the key could not be fetched (offline, 5xx, 401/403). The session is remembered as base-pending, and the next `captureDelta` captures the base instead.
- `stale_turn`: `turn` is not greater than the last archived turn. The server would reject it (`archive_parent_mismatch`). Nothing is consumed, and the changes go into the next delta.
- `failed`: an invalid session id or turn, or an I/O failure during capture. A failed base is remembered as base-pending too.

`DrainResult` is `{uploaded, pending, dropped, blocked, disabled}`.
`blocked` is the reason the drain stopped with the queue kept (401 after a
refresh, or 403). `disabled` means a 428 or `503 archive_disabled` turned
archiving off.

## Wiring

### As implemented

`../project-archive.ts` works out one archiver per server
(`projectArchiveSettings`): the collector's state dir
(`runtimeStorageDir(config)`), the gateway broker's `archiveRequest` and
`refreshAccessToken` (or, without a broker, the collector's
`OMNIRUSH_GATEWAY_URL` + `OMNIRUSH_ACCESS_TOKEN`), and the app's config, data
and OpenCode data/cache dirs as `excludedDirs`. The archiver is wrapped in a
`ProjectArchiveLifecycle`, which is enabled when the collector has an account
and `OMNIRUSH_ARCHIVE_ENABLED` is not `0`/`false`/`no`/`off`.

The lifecycle, its `SessionArchiver` and the workspace collector run
together in `../capture-host.ts`, which `server.ts` starts on a worker thread
(`../capture-client.ts`, `../capture-worker.ts`): scanning, hashing, tar,
zstd and sealing never run on the server's main event loop, which in the
desktop app is the Electron main process. The worker asks the main thread
for the broker's `archiveRequest` and `refreshAccessToken` and for the S3
part PUTs (external egress goes through the embedding runtime's network
stack), each as one message with its body transferred, and cancels them the
same way. Where no worker can start (`OMNIRUSH_CAPTURE_WORKER=0`, or a
runtime that cannot load the worker module, such as the single-file CLI
binary) the same host runs in-process. `server.ts` keeps the capture service
in `captureServicesByServer` and calls:

| Server hook | Lifecycle call |
| --- | --- |
| `startServer` (`startCaptureService`) | `start()`: a drain when enabled; otherwise `signOut()` clears what a previous run left (a no-op, touching nothing, when there is no `omnirush-archive/`) |
| A prompt dispatch on a local workspace (v1 `prompt_async`/`prompt`/`command`, v2 `prompt`/`prompt_async`/`command`/`generate`), after the collector's `startSession` | `sessionStarted({sessionId, root: workspace.path, engine})`, the engine reads built on the worker from the request's engine target |
| The collector observer's `turn_completed` (on the worker), with the engine messages it just read (null when it could not read them) | `turnCompleted(sessionId, messages)` |
| `collector.finishSession` (session deleted) | `sessionEnded(sessionId)`: forgets the session, kicks a drain |
| The broker's `invalidate` hook (revoked or expired account), before `clearSpool()` | `signOut()` |
| Server shutdown and a failed start | `stop()`, started first: the main thread aborts the part uploads it is making for the worker at once, before the task-recovery checkpoint (up to 10 s), then the worker stops the archiver and the collector; the worker is terminated after 20 s at the latest. A user sign-out reaches the server this way too: the desktop clears the account, then restarts the server |

What the lifecycle adds on top of the calls below:

- **Every call returns at once.** Engine reads and captures run in the background, one at a time (`concurrency`, default 1), and each session's steps run in call order, so a turn's delta never overtakes the session's base. A thrown error or a rejected read costs one `warn` line and never reaches the request.
- **A base waits for a quiet moment.** The server passes `baseIdleMs` 2 s and `baseMaxDeferMs` 10 s (`PROJECT_ARCHIVE_BASE_IDLE_MS`, `PROJECT_ARCHIVE_BASE_MAX_DEFER_MS`): a base is packed once no prompt has been dispatched on any session for 2 s, and at the latest 10 s after its own prompt. Chats opened and prompted one after another are packed once the burst is over, one at a time; a lone chat's base still shows the folder as its first turn began. The wait holds no concurrency slot, and `stop()` or `signOut()` ends it without packing. Each session still gets its own base (sequence 0 of its own chain, section 7 of the backend spec); a second chat on the same folder packs from the root's persisted hash cache, so pass 1 of an unchanged tree reads no file (pass 2 streams and hashes the bytes it packs, as section 5.9 requires).
- **Root sessions only.** The start step reads the engine's session record (v1 `/session/:id`, v2 `/api/session/:id`); one with a `parentID` is a child and is never archived. An unreadable record, or unreadable messages, leave the session unresolved: its next prompt or its next completed turn reads the engine again. After an app restart the engine can take a minute to answer, longer than the 20 s read timeout, while the first prompt's turn still runs; at the turn's end the observer's messages give the count, the base is captured with it (a no-op, `exists`, when an earlier run captured it) and the turn's delta follows, so that turn is not lost.
- **Turn numbers from the engine.** `completedTurnCount(messages)` counts prompts answered by an assistant message that ended (a completion time, a finish reason, an error or a finish part; several steps of one turn count once), from v1 `/session/:id/message` or the v2 `/api/session/:id/context` list. The v1 list is read a page at a time (`?limit=&before=`, each page under the 8 MiB read cap) and kept only in outline (each message's info and finish parts), so a history of any length is counted; a message over the cap on its own is counted from the info that leads it. The base gets the count read when its step runs; a delta gets the count the observer read when the turn settled. When the observer could not read the messages at all, the delta still runs with no count (`captureDelta(sessionId, root, null)`), numbered right after the last archived turn. The count survives restarts. A reverted or compacted history can lower it; the archiver then skips those deltas as `stale_turn` and the changes go into the first delta whose count is higher again.
- **Real path.** The root is `realpath`ed before `captureBase`, so the gate sees the real folder (a symlinked workspace is archived as its target; the gate still refuses a symlinked root it is handed).
- **Consent off.** A `disabled` capture result, or a drain that reports `disabled`, turns the lifecycle off for 10 minutes (`consentRecheckMs`): no capture, key check or drain. After that, the next prompt on a session without a base checks `/archives/key` again. No log line: the archiver logs the one `info`.
- **Signed out stays out.** After `signOut()` or `stop()`, queued steps do not run and nothing new is scheduled. `SessionArchiver.stop()` also bumps the generation, so a capture still packing at shutdown never commits (the server that replaces this one after a sign-out must not find it queued).

The contract the lifecycle follows is the original wiring note below.

### What to call, and when

All calls are fire-and-forget from the request path. A base capture of a big
project takes seconds (about 2 s for 500 MiB and 20k files, about 18 s for
200k files), so never `await` it while a user request is waiting.

Captures for one session are serialized inside the archiver. Captures for
different sessions may run concurrently.

#### 1. App start (server startup, next to `new WorkspaceCollector(...)` in `server.ts`)

Construct one archiver per server, with the same state dir as the collector:

```ts
const sessionArchiver = new SessionArchiver({
  stateDir: runtimeStorageDir(config),
  ...(gatewayBroker.enabled ? {
    request: (path, init) => gatewayBroker.archiveRequest(path, init),   // new broker method, see below
    refreshAccessToken: () => gatewayBroker.refreshAccessToken(),
  } : {}),
  excludedDirs: [/* the app's data, cache and temp directories */],
  log: (level, message, attributes) => logger.log(level, message, attributes),
});
void sessionArchiver.start().then(() => sessionArchiver.drain());
```

`start()` then `drain()` resumes uploads left over from the last run. Recovery:

- `tmp/` is emptied;
- a capture that crashed before its commit is discarded;
- orphaned sealed files are removed;
- jobs older than 7 days are dropped (S3's lifecycle rule has aborted their multipart uploads) and their sessions stop;
- half-uploaded archives continue from the persisted part list.

A job that exhausted its retries waits between drains (1 min, doubling, capped
at 1 h). An unref'd timer drains again when the earliest one is due.

#### 2. Session start (where `collector.startSession(sessionId, workspaceId, root)` is called)

Call once per root session per app run, the first time a prompt is
dispatched for that session id:

```ts
void sessionArchiver.captureBase(sessionId, root, completedTurns).then(() => sessionArchiver.drain());
```

- `root` is the folder the agent started in (`input.workspace.path`), as a real path: the gate `lstat`s it and refuses a symlinked root. The home directory, a filesystem root and the app's own directories are always refused.
- `completedTurns` is 0 for a new session. For a resumed session, it is the number of turns the session has already completed.
- The call is cheap when there is nothing to do. With a base already captured, it only reads the session record, with no network. Without `.git`, it runs two `lstat` calls. Otherwise it fetches `GET /archives/key`, which also checks the archive consent: a 428 means nothing is packed.
- Child (sub-agent) sessions share the parent's root and must not be archived. Call this for root sessions only.
- Keep a per-process `Set` of session ids already handed to `captureBase`. `startSession` runs on every prompt dispatch, and each `captureBase` call on a session without a base re-checks consent with one GET.

#### 3. Turn completed (where `collector.captureSnapshot(sessionId, "turn_completed")` is called)

```ts
void sessionArchiver.captureDelta(sessionId, root, completedTurns).then(() => sessionArchiver.drain());
```

- `completedTurns` must strictly increase per session, across app restarts too. The server requires `turn > parent turn`. Derive it from the engine (the number of completed assistant turns in the session), not from an in-memory counter. A repeated or lower number is skipped as `stale_turn`.
- An unchanged folder costs a stat-only scan, with no file content read (about 0.1 s for 20k entries, 1.5 s for 200k) and no upload.
- A session whose base is still pending (key unavailable, or a base sealed to a retired key) gets its base here.

#### 4. Session end (where `collector.finishSession(sessionId)` is called)

No capture: the last completed turn's delta already covers the folder, and
changes from an aborted turn go into the next delta if the session resumes.
Keep the session state for resumption. Only kick the queue:

```ts
void sessionArchiver.drain();
```

#### 5. Sign-out (the broker's `invalidate` hook, next to `workspaceCollector.clearSpool()`)

```ts
await sessionArchiver.signOut();
```

It first aborts the part PUT in flight (the drain's `AbortController` cancels
the fetch, and no more of the sealed file is read), then, while it still holds
the credentials, sends `POST /archives/{id}/abort` for every upload the queue
has started (best effort, 5 s cap; the server's maintenance aborts leftovers
after 24 h). Call it **before** the credentials are dropped. In the broker's
`invalidate` hook the device session is already gone, so the abort cannot be
authenticated there; and the desktop's user sign-out clears (revokes) the
account before it restarts the server, which then only sees `stop()` (see
step 6). Bytes a part PUT already handed to the operating system before the
abort still reach S3; only the abort of the multipart upload discards them. It deletes every queued
archive, baseline, hash cache and session record, so nothing is ever uploaded
later under another account. After the next sign-in the archiver starts clean.
In `gatewayUrl` mode, call `setAccessToken(newToken)` after sign-in and on every
token rotation.

#### 6. App shutdown (where `workspaceCollector.stop()` is called)

```ts
await sessionArchiver.stop();
```

This stops the drain and the retry timer and aborts the part PUT in flight at once (the part is sent again on resume). Queued archives stay on disk for step 1, and the upload is not aborted at the server.

#### Authentication

Archive routes authenticate like `POST /omnirush/collect`: a device bearer,
the sign-in gate and consent. The gateway broker owns the device session and
exposes, next to `collect(sessionId, body)` and `refreshAccessToken()`:

```ts
archiveRequest(path: string, init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal }): Promise<Response>
```

It sends to `<gateway root>/<path>` (`path` is `archives/key`, `archives`,
`archives/<id>/parts`, `archives/<id>/complete`, `archives/<id>/abort`). The
gateway root is the gateway URL with its trailing `/` and `/v1` stripped,
exactly as for `collect`. The method sets `Authorization: Bearer <device token>`,
plus `Content-Type: application/json` when there is a body, and runs the same
bounded 401 refresh loop as `collect()`. Any other path answers 404 without a
request.

Alternatively, pass `gatewayUrl` + `accessToken` and keep them current with
`setAccessToken`.

S3 part PUTs never carry the bearer. They go through `fetch` (default
`externalFetch`) to the presigned URL exactly as received. The body is the
part read into one buffer from the sealed file (1 MiB reads, stopping at an
abort), so every runtime sets `Content-Length`. A file-backed `Blob` slice is
not used: Electron's `net.fetch` collects a streamed body with one
`Buffer.concat` per 64 KiB chunk before sending it, which for the default
64 MiB part took 2.6 s against 0.1 s for one buffer (measured with Electron 43
against a loopback sink).

## Behaviour notes

- **Consent.** A 428, or a `503 archive_disabled`, from any route turns archiving off without error. Every queued archive is dropped (consent belongs to the user), sessions that lost a queued archive stop, and captures skip as `disabled` until a later `captureBase` finds the key route open again. A server without the routes (404 on `/archives/key`) counts as disabled.
- **Stopping a session.** A chain-ending 409, a 413 or a 422 drops that session's jobs and stops the session. A 7-day-old job does the same. The next session starts over with a new base.
- **`409 archive_kid_unknown`.** Section 7.9 says to refetch the key and seal again. The plaintext is not kept, so:
  - on a **base**, the job is dropped and the session goes back to base-pending: the next `captureDelta` packs a new base with the current key;
  - on a **delta**, the chain cannot be re-sealed, so the session stops.
  This only happens if a key is removed from `OMNIRUSH_ARCHIVE_PRIVATE_KEYS` while archives sealed to it are still queued.
- **Part order.** Parts are uploaded one at a time, in order, streamed from the sealed file. The spec allows up to 4 in parallel; that is a possible later optimisation.
- **Pass 2 never reads outside the root.** Node has no `openat`, so pass 2 cannot pin a directory handle. Instead it `lstat`s each directory once, parents first, when the walk enters it. If a directory is no longer a real directory (for example it was swapped for a symlink by `npm link` or a tool), nothing below it is read. Each file is opened with `O_NOFOLLOW | O_NONBLOCK | O_NOCTTY`, so a FIFO swapped in never blocks the capture. The handle's `fstat` must show a regular file with the `st_dev` and `st_ino` that pass 1 `lstat`ed, which catches a swap made after the directory check. Otherwise the member is zero-filled at its manifest size and listed in `unstable.json`, and the next delta sends it again. A changed size or mtime on the same inode still copies the bytes (5.9). This adds about 3% to pass 2 on a 56k-entry tree.
- **Memory.** Pass 2 streams through a pool of four 1 MiB tar blocks, recycled once zstd has consumed them. The sealer holds one 1 MiB chunk, and the sink awaits each file write. The manifest is serialised on the fly: once to learn its size, once while it is written. Short-lived zstd and AES-GCM output buffers are the remaining churn. An upload holds the part it is sending (the server's part size, 64 MiB by default). In Bun, a full GC is requested every 64 MiB, every 10k files and around each capture (about 2 ms each at these heap sizes); elsewhere this is a no-op.

## Measurements (Apple Silicon laptop SSD, Bun 1.4.2)

| Workload | Wall time | Peak RSS growth |
| --- | --- | --- |
| pack + seal, 523 MiB synthetic tree (20,459 entries: 320 MiB random `.blend`-like files, 100 MiB text, 20k small files), sealed to 399 MiB | 2.0–2.4 s (pass 1 about 0.5 s, pass 2 about 1.6 s) | 116–133 MiB |
| full `captureBase` of the same tree (gate, key, git block, pack, seal, state files) | 2.1–2.2 s | 124–131 MiB |
| `captureDelta` right after, nothing changed | 0.12 s | overall 129–133 MiB |
| `captureBase`, 203k entries (node_modules-like, 200k small files) | 18–19 s | 344–357 MiB |
| `captureDelta`, 203k entries, nothing changed (spec target: under 5 s) | 1.3–1.6 s | — |

Memory beyond the bounded stream buffers grows with the entry count: scan
entries, the hash cache and the baseline, about 375 bytes per entry live.

## Tests

```sh
cd apps/server && bun --conditions=development test src/session-archive
```

- `seal.test.ts`:
  - every positive vector reproduces `sealed_hex` / `sealed_sha256` byte for byte through the test-only `testOnlyFixedSecrets` injection, whether sealed whole or streamed;
  - every negative vector fails with its exact `expect_error`;
  - a multi-MiB streamed round trip.
- `pack.test.ts`:
  - round trips through the system `tar` and Python `tarfile` in stream mode (`r|`), with long paths, unicode names, long and unicode symlink targets, empty directories and modes;
  - member order and the manifest first;
  - an `unstable.json` member when files change between the passes;
  - a directory swapped for a symlink to an outside folder, before pass 2 and while pass 2 is inside it: zero-filled, nothing from outside in the tar; a file swapped for a FIFO does not block;
  - pax header edge cases;
  - a multi-MiB `writeSealedArchive` round trip checked with the `zstd` CLI.
- `manifest.test.ts`: UTF-8 byte order; the credential filter; the exclusions (credential, FIFO, app state, `__omnirush__`, unreadable, non-UTF-8); the hash cache; delta for add, modify (content and mode), delete, rename, file to dir, dir to file and symlink retarget; unstable re-send; `.git` changes; manifest JSON; the git block; `git status` never rewriting `.git/index`.
- `detect.test.ts`: a `.git` dir; a gitfile; no `.git`; an invalid gitfile; a `.git` symlink; home, `/` and app dirs refused; `root_not_directory`; detector plug-ins.
- `upload.test.ts` (in-process fake API and S3):
  - the happy path;
  - resume after a failed part;
  - a part S3 already holds;
  - an expired URL (403);
  - 428 and 503;
  - a 401 with a refresh, and a failed refresh;
  - NoSuchUpload leading to a re-create;
  - `archive_not_uploading` at complete;
  - `archive_parts_invalid`;
  - replay, chain conflicts and an unknown kid;
  - backoff;
  - the broker request hook.
- `lifecycle.test.ts` (fake archiver and engine, plus one run on the real archiver): the turn count on v1 and v2 message shapes; the feature flag; one base per root session per app run at the real path; child sessions ignored; deltas numbered from the engine and ordered after the base, and after the last archived turn when the messages could not be read; restart resume; a session whose start could not read the engine resolved at its next completed turn (its delta kept, also on the real archiver across an app restart), and a child resolved that way still ignored; signed-out start clearing; sign-out stopping queued steps; 428 off until the recheck; failures contained.
- `../project-archive.test.ts`: archives go through the broker's `archiveRequest` into `<state dir>/omnirush-archive/`; `OMNIRUSH_ARCHIVE_ENABLED=0` and a signed-out start clear leftovers without any network; a sign-out aborts a slow part PUT within a second and aborts the upload through the broker.
- `../omnirush-gateway-broker.test.ts`: `archiveRequest` URL, bearer, 401 refresh and path allowlist.
- `../workspace-collector.server.e2e.test.ts` ("project archive wiring"): through the real proxy and observer, one base then a delta numbered 2 after a changed turn; a history past the 8 MiB read cap (one message over it alone) still gets its base, its turns' transcripts and deltas, and a turn whose messages cannot be read still gets its snapshot and delta; 428 checked once with the chat unaffected; the flag off sends nothing.
- `index.test.ts`:
  - the whole folder: `.git/` and gitignored `node_modules/` and `dist/` present, `.env` and `id_rsa` absent unless `archiveIncludeCredentialFiles`; the base then a delta, each decrypted and checked;
  - no delta when nothing changed, `stale_turn` and `exists`;
  - no `.git`;
  - consent off at the key route and during a drain;
  - app restart resuming a half-uploaded archive;
  - a crashed commit discarded;
  - a chain conflict and an unknown kid;
  - sign-out, and a slow part PUT aborted within a second of `signOut()` (the upload aborted with the credentials still held, nothing completed or sent afterwards) and of `stop()` (the job kept, resumed by the next start);
  - the app's state dir under the root pruned.
