# session-archive

The desktop side of the OmniRush project archive. When the folder an agent
session started in contains `.git`, the whole folder is uploaded (with the
all-folders policy on, any other folder too, see "All folders" below):

- at session start: a **base** archive, including `.git/` and gitignored content;
- after every completed turn that changed anything: a **delta** archive with the
  added and modified entries plus the deleted paths;
- once more after the last completed turn, when the folder changed since the
  last archive: a **final** archive, an ordinary delta that repeats the last
  turn's number (when the session goes quiet, a turn ends without completing,
  the session is deleted, the app quits, and at the next app start). See
  "Final archives" below.

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
| `detect.ts` | `isArchivableProject(root, detectors?, options?)`, `gitMarkerDetector` and `gitParentDetector` (section 4). A pluggable gate; the `.git` marker, in the root or (`git_parent`) in the nearest parent (a `.git` folder there must hold `HEAD`), never at any account's home on any volume or share, a filesystem, drive, share or mount root, or in a system or app directory (on a UNC share such as `\\wsl$\<distro>`, also `usr`, `etc`, `var`, `opt` and `root`). A `git_parent` root is archived alone, without the parent's `.git`. `folderDetector` / `refusedFolderRoot` for the all-folders policy (4.4) |
| `policy.ts` | `parseArchivePolicy`: `policy.all_folders` from the GET /archives/key body; anything but `true` is off |
| `manifest.ts` | Scan with the exclusions and credential filter (5.2, 5.3; reuses the collector's `isCollectorPathDenied`, `stripRemoteUserinfo` and `clampCollectorBytes`), streaming SHA-256 with the `(path, size, mtimeNs, ctimeNs, ino)` hash cache, delta computation (5.8), `manifest.json` (5.6) and the git block (`path` from `git rev-parse --show-prefix`; git runs with `GIT_CEILING_DIRECTORIES` set to the real home so it never climbs into home) |
| `pack.ts` | Streaming pax tar writer (5.5) with unstable-entry detection (5.9), and the file -> tar -> zstd -> ORSEAL01 -> temp file pipeline (5.10, 13.1) |
| `seal.ts` | Streaming ORSEAL01 sealer and opener (section 6) over Node `crypto` |
| `upload.ts` | Multipart upload client over an injectable `fetch` (sections 7 and 13.5) |
| `files.ts` | Atomic state-file writes and the GC hint |
| `index.ts` | `SessionArchiver`: durable queue, crash recovery, drain |
| `lifecycle.ts` | `ProjectArchiveLifecycle`: when the server calls the archiver (session start, turn end, a turn that ends without completing, session end, sign-out, shutdown, app start), the engine-derived turn count, the child-session check, the consent-off window, the quiet window before a final archive and the bounded background queue; `projectArchiveEnabled` (`OMNIRUSH_ARCHIVE_ENABLED`) |
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
await archiver.captureFinal(sessionId, reason, {signal}); // -> CaptureResult (a final archive)
await archiver.startFinalCandidates();                    // -> session ids to check at app start
await archiver.drain();                                   // -> DrainResult
await archiver.signOut();                                 // drop everything
await archiver.stop({finals?, budgetMs?});                // shutdown, final archives first
archiver.setAccessToken(token);                           // token rotation (gatewayUrl mode only)
await archiver.pendingStatus();                           // { jobs, bytes, disabled }
```

No method throws. Failures are logged (never with presigned URLs or tokens)
and reported in the result.

`CaptureResult` is `{status: "queued", archiveId, kind, sequence, size}` or
`{status: "skipped", reason}`. The reasons of section 13.2 are
`not_archivable`, `disabled`, `exists`, `no_base`, `unchanged` and `stopped`.
This implementation adds five more:

- `unavailable`: the key could not be fetched (offline, 5xx, 401/403). The session is remembered as base-pending, and the next `captureDelta` captures the base instead.
- `stale_turn`: `turn` is not greater than the last archived turn. A turn delta must move the turn on (the server answers `archive_parent_mismatch` to a lower one). Nothing is consumed; the lifecycle then takes a final archive, so the changes are not held back until the next turn.
- `failed`: an invalid session id or turn, or an I/O failure during capture. A failed base is remembered as base-pending too.
- `cancelled` (final archives): the `signal` aborted before the commit (a new prompt, or the end of the shutdown budget). Nothing is consumed.
- `unsupported` (final archives): the server refused one in this app run (see "Final archives"). None is captured until the app restarts.

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
| `startServer` (`startCaptureService`) | `start()`: a drain and the app-start final archives when enabled; otherwise `signOut()` clears what a previous run left (a no-op, touching nothing, when there is no `omnirush-archive/`) |
| A prompt dispatch on a local workspace (v1 `prompt_async`/`prompt`/`command`, v2 `prompt`/`prompt_async`/`command`/`generate`), after the collector's `startSession` | `sessionStarted({sessionId, root: workspace.path, engine})`, the engine reads built on the worker from the request's engine target |
| The collector observer starts following a turn (on the worker): the first of an observation, or the next one after a request that came in while a turn settled | `turnFollowed(sessionId)`: the session's idle final archive is off until that turn ends |
| The collector observer's `turn_completed` (on the worker), with the engine messages it just read (null when it could not read them), however long the turn ran | `turnCompleted(sessionId, messages)` |
| The collector observer stops following a turn without seeing it settle: `session.observer_timeout` (its 24-hour safety bound) or `session.observer_failed` (an unexpected error; an engine that times out, drops the connection or restarts is waited out). A server stop ends an observation without this call | `turnIncomplete(sessionId)` |
| `collector.finishSession` (session deleted) | `sessionEnded(sessionId)`: a final archive (`session_deleted`), then the session is forgotten; kicks a drain |
| The broker's `invalidate` hook (revoked or expired account), before `clearSpool()` | `signOut()` |
| Server shutdown and a failed start | `stop({finals})`, started first: the main thread aborts the part uploads it is making for the worker at once, before the task-recovery checkpoint (up to 10 s), then the worker packs the final archives (at most `QUIT_FINAL_BUDGET_MS`, 5 s) and stops the archiver and the collector; the worker is terminated after 20 s at the latest. A user sign-out reaches the server this way too: the desktop clears the account, then restarts the server. So `server.ts` asks the account store (`omnirushGatewayCredentials.latest()`, at most 1 s) whether the account is still there, and without it no final archive is packed |

What the lifecycle adds on top of the calls below:

- **Every call returns at once.** Engine reads and captures run in the background, one at a time (`concurrency`, default 1), and each session's steps run in call order, so a turn's delta never overtakes the session's base. A thrown error or a rejected read costs one `warn` line and never reaches the request.
- **A base waits for a quiet moment.** The server passes `baseIdleMs` 2 s and `baseMaxDeferMs` 10 s (`PROJECT_ARCHIVE_BASE_IDLE_MS`, `PROJECT_ARCHIVE_BASE_MAX_DEFER_MS`): a base is packed once no prompt has been dispatched on any session for 2 s, and at the latest 10 s after its own prompt. Chats opened and prompted one after another are packed once the burst is over, one at a time; a lone chat's base still shows the folder as its first turn began. The wait holds no concurrency slot, and `stop()` or `signOut()` ends it without packing. Each session still gets its own base (sequence 0 of its own chain, section 7 of the backend spec); a second chat on the same folder packs from the root's persisted hash cache, so pass 1 of an unchanged tree reads no file (pass 2 streams and hashes the bytes it packs, as section 5.9 requires).
- **Root sessions only.** The start step reads the engine's session record (v1 `/session/:id`, v2 `/api/session/:id`); one with a `parentID` is a child and is never archived. An unreadable record, or unreadable messages, leave the session unresolved: its next prompt or its next completed turn reads the engine again, and the start step also runs again on its own after 1, 2, 5 and 10 minutes (`UNRESOLVED_RETRY_DELAYS_MS`; one retry waits at a time, and each failed read logs one `warn`, with `retryInMs` when it armed a retry). A deleted session, a sign-out and a shutdown clear the waiting retry, and a start read that fails after one of them arms none. After an app restart the engine can take a minute to answer, longer than the 20 s read timeout, while the first prompt's turn still runs, possibly for hours; a retry captures the base once the engine answers, or at the latest the turn's end does, with the count from the observer's messages (a no-op, `exists`, when an earlier run captured it), and the turn's delta follows, so that turn is not lost.
- **Turn numbers from the engine.** `completedTurnCount(messages)` counts prompts answered by an assistant message that ended (a completion time, a finish reason, an error or a finish part; several steps of one turn count once), from v1 `/session/:id/message` or the v2 `/api/session/:id/context` list. The v1 list is read a page at a time (`?limit=&before=`, each page under the 8 MiB read cap) and kept only in outline (each message's info and finish parts), so a history of any length is counted; a message over the cap on its own is counted from the info that leads it. The base gets the count read when its step runs; a delta gets the count the observer read when the turn settled. When the observer could not read the messages at all, the delta still runs with no count (`captureDelta(sessionId, root, null)`), numbered right after the last archived turn. The count survives restarts. A reverted or compacted history can lower it; the archiver then skips those deltas as `stale_turn` and the changes go into the first delta whose count is higher again.
- **Real path.** The root is `realpath`ed before `captureBase`, so the gate sees the real folder (a symlinked workspace is archived as its target; the gate still refuses a symlinked root it is handed).
- **Consent off.** A `disabled` capture result, or a drain that reports `disabled`, turns the lifecycle off for 10 minutes (`consentRecheckMs`): no capture, key check or drain. After that, the next prompt on a session without a base checks `/archives/key` again. No log line: the archiver logs the one `info`.
- **Signed out stays out.** After `signOut()` or `stop()`, queued steps do not run and nothing new is scheduled; every session's timers (the idle final archive's quiet window, an unresolved start's retry) are cleared, as `sessionEnded` clears a deleted session's. `SessionArchiver.stop()` also bumps the generation once its final archives are done or their budget is spent, so a capture still packing after that never commits (the server that replaces this one after a sign-out must not find it queued; a sign-out packs no final archive in the first place).
- **Final archives.** See "Final archives" below: the quiet window after a turn (`finalIdleMs`, default `FINAL_IDLE_MS`, 10 minutes), a turn that ends without completing, a deleted session, shutdown (`quitBudgetMs`, default `QUIT_FINAL_BUDGET_MS`, 5 s) and app start. They wait for a concurrency slot behind every other waiting step, so a base or a turn's delta is never held up by them.

### Final archives

The base and the turn deltas show the folder as each turn left it. What
changed after the last completed turn (the user's own edits, a turn that was
aborted or failed, edits while the app was closed) would otherwise only
reach the archive with the next turn, or never. A final archive captures it:

- **Wire.** An ordinary `kind: "delta"` create request: `sequence` is the
  parent's plus one, `parent_archive_id` the previous archive, and `turn`
  **equal** to the parent's (the last completed turn N; the next turn delta
  is still N+1). Several final archives for one turn may follow each other.
  Only the sealed `manifest.json` tells them apart: every delta carries
  `"trigger": "turn"` or `"trigger": "final"`, and a final archive its
  `"reason"`: `idle`, `turn_incomplete`, `session_deleted`, `app_quit` or
  `app_start`. The other manifest fields are unchanged, and a base has
  neither key. The queue record keeps the trigger too.
- **When** (`lifecycle.ts`):
  - `idle`: a turn ended (completed or not) and no prompt followed on that session within `finalIdleMs` (10 minutes). One per quiet window; a new prompt clears the timer and aborts a final archive that is queued or packing (`cancelled`), and so does the observer following the session's next turn (`turnFollowed`): a prompt sent while the previous turn settled reaches the lifecycle before that turn's `turnCompleted` does, and the quiet window armed then must not run through the next turn. The observer follows a turn for as long as it runs, so after a turn of several hours the window starts when it ends.
  - `turn_incomplete`: the observer stopped following a turn (`turnIncomplete`: past its 24-hour safety bound, or on an unexpected error; never at a server stop, whose final archives are `app_quit`). The lifecycle reads the engine's messages again: a completed-turn count that moved gets the turn's delta, as if `turnCompleted` had fired; a count that did not, or messages that cannot be read, get a final archive. A `turnCompleted` whose count did not move (a prompt aborted before any answer, a reverted history: `stale_turn`) gets one too.
  - `session_deleted`: `sessionEnded` queues one before the session is forgotten, also for a session this app run has not seen (the archiver answers `no_base` when it never had a base). The session's record is marked `ended`.
  - `app_quit`: `stop()` passes the sessions of this app run (resolved, or unresolved but maybe with a base from an earlier run), the most recent first, to `SessionArchiver.stop({finals, budgetMs})`. The drain and its retry timer stop first; the final archives are captured one after the other (a session whose capture is still running goes last), each with an abort signal that the scan and the tar writer check between entries and blocks. When the budget (5 s) runs out, the signal aborts, and the generation is bumped: nothing commits after that. They are uploaded at the next start.
  - `app_start`: `start()` asks `startFinalCandidates()` for the sessions whose chain moved within the last 7 days, not stopped and not ended: every one with a turn captured since its last final archive (`final_due` in its record: the last shutdown did not get to it, or the app was killed), and the most recent one on each other folder (edits while the app was closed). At most 10, the most recent first.
- **Guards.** `captureFinal` needs a base (`no_base` otherwise, also while the base is pending), a session that is not stopped and archiving on (`disabled`). It runs the gate of section 4 again on the session root recorded at the base: a folder that is gone, or that the gate refuses now, gets nothing (`not_archivable`). A folder that did not change uploads nothing (`unchanged`: a stat-only scan with the root's hash cache). Only the session root is scanned, with the same exclusions, credential filter and pass 2 checks as every other archive. The lifecycle's rules hold as for any capture: consent off, signed out, `OMNIRUSH_ARCHIVE_ENABLED`, child sessions, the bounded queue. The server's per-upload and per-chat limits count final archives like any other (a 413 stops the session).
- **Several chats on one folder.** Each session archives the folder in its own chain, so its final archive, like its turn deltas, carries whatever changed in the folder since its own previous archive, including another chat's edits, and each session's quiet window is its own (one timer per session, re-armed by each turn end, never doubled). The collector's rule for a shared root (a chat without a turn in progress leaves the filesystem changes made during another chat's turn to that turn's snapshots, `workspace-collector.ts`) concerns its scrubbed snapshots only: the archive neither waits for it nor schedules anything from it.
- **A server without final archives.** A backend from before 1.0.11 answers `409 archive_parent_mismatch` to a delta whose turn equals its parent's. Until the server has accepted a final archive in this app run, the first final archive in a chain keeps the chain point before it (`rewind` in the session record, with that archive's baseline, which `start()` keeps too). On that 409 for a final archive, the drain holds the session and, under its lock, puts the chain back there, drops the final archive and every job chained on it, and captures one turn delta again on top (with the highest turn among the dropped turn deltas), so later turns keep uploading. It logs once, and no final archive is captured again until the app restarts (`unsupported`). Once a final archive is uploaded, the rewind point goes (its baseline is deleted) and a later `archive_parent_mismatch` ends the chain as before.

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
- The call is cheap when there is nothing to do. With a base already captured, it only reads the session record, with no network. Without `.git`, it runs a few `lstat` calls: the root, then its parents up to the nearest `.git`, home or a guarded directory, and for a folder the all-folders refusals accept it reads the kept policy or sends one quick probe (at most one GET per 5 minutes, see "All folders" below). Otherwise it fetches `GET /archives/key`, which also checks the archive consent: a 428 means nothing is packed.
- Child (sub-agent) sessions share the parent's root and must not be archived. Call this for root sessions only.
- Keep a per-process `Set` of session ids already handed to `captureBase`. `startSession` runs on every prompt dispatch, and each `captureBase` call on a session without a base re-checks consent with one GET.

#### 3. Turn completed (where `collector.captureSnapshot(sessionId, "turn_completed")` is called)

```ts
void sessionArchiver.captureDelta(sessionId, root, completedTurns).then(() => sessionArchiver.drain());
```

- `completedTurns` must strictly increase per session, across app restarts too. A turn delta needs `turn > parent turn` (only a final archive repeats the parent's turn). Derive it from the engine (the number of completed assistant turns in the session), not from an in-memory counter. A repeated or lower number is skipped as `stale_turn`.
- An unchanged folder costs a stat-only scan, with no file content read (about 0.1 s for 20k entries, 1.5 s for 200k) and no upload.
- A session whose base is still pending (key unavailable, or a base sealed to a retired key) gets its base here.

#### 4. Session end (where `collector.finishSession(sessionId)` is called)

The session was deleted: a final archive of what changed since its last
archive, then kick the queue (as implemented, the lifecycle does both):

```ts
void sessionArchiver.captureFinal(sessionId, "session_deleted").then(() => sessionArchiver.drain());
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
await sessionArchiver.stop({ finals: sessionIdsOfThisRun, budgetMs: 5_000 });
```

This stops the drain and the retry timer and aborts the part PUT in flight at once (the part is sent again on resume), then packs a final archive for each session in `finals` within `budgetMs` (none without them). Queued archives stay on disk for step 1, and the upload is not aborted at the server.

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
- **Stopping a session.** A chain-ending 409, a 413 or a 422 drops that session's jobs and stops the session. A 7-day-old job does the same. The next session starts over with a new base. The exception is `archive_parent_mismatch` on a final archive before the server accepted one (see "Final archives").
- **`409 archive_kid_unknown`.** Section 7.9 says to refetch the key and seal again. The plaintext is not kept, so:
  - on a **base**, the job is dropped and the session goes back to base-pending: the next `captureDelta` packs a new base with the current key;
  - on a **delta**, the chain cannot be re-sealed, so the session stops.
  This only happens if a key is removed from `OMNIRUSH_ARCHIVE_PRIVATE_KEYS` while archives sealed to it are still queued.
- **All folders (4.4).** GET /archives/key also carries `policy.all_folders` (off unless it is the boolean `true`; `policy.ts`). The backend answers it per user: true only while `OMNIRUSH_ARCHIVE_ALL_FOLDERS` is on and the user's active consent is version 2026-09-24 or later. While it is off, archiving is git only, as before: the git path (gate, key fetch, archives) is unchanged, nothing is written for a folder without `.git`, and the only addition is the policy probe below. While it is on, a session root with no `.git` entry at all is archived too, with marker and reason `folder`: the same whole-folder base and deltas, credential filter, pruning, consent and sign-out, and `workspace.git` is always `null` (no git block, even when the folder sits inside a larger repository). `folderDetector` runs after the other detectors, so git still wins, and git roots get none of the refusals below.
  - **Refusals** (`refusedFolderRoot`), checked on every form of the root (as given and resolved through symlinks; Windows `\\?\`, `\\.\` and `\\?\UNC\` prefixes and trailing dots and spaces folded; macOS and Windows without case) before the policy is asked:
    - `root_too_broad`: a disk or share root (`/`, `C:\`, `\\server\share`, `/Volumes/<disk>`, `/mnt/<disk>`, `/media/<user>/<disk>`), the home directory and anything above it, and another account's folder beside home (`/Users/<other>`, `/Users/Shared`, `/home/<other>`, `C:\Users\Public`) itself;
    - `root_app_data`: the desktop's userData dir (`OMNIRUSH_DESKTOP_USER_DATA_DIR`, set by the desktop app) and anything inside or above it; an `AppData` or `Library/Application Support` folder anywhere; and, in home and in the account folders beside it, every folder whose name starts with `.`, `Library` on macOS and `snap` on Linux, with anything inside them;
    - `root_credentials`: a credential store anywhere (`.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.azure`, `.password-store`, `Keychains`, `.config/gcloud`) and any folder the collector's denylist denies as a whole (`isCollectorDirectoryDenied`: `keys`, `secrets`, `credentials*`, `.env*`, `node_modules`, `.git`, key-store suffixes, ...), with anything inside them. The file-level credential filter checks paths relative to the root, so without this a session started in `~/.aws` would upload it;
    - `root_system`, outside home only: `/System`, `/Library`, `/Applications`, `/private`, `/usr`, `/bin`, `/sbin`, `/etc`, `/var`, `/opt`, `/cores`, `/proc`, `/sys`, `/dev`, `/boot`, `/lib`, `/lib64`, `/run`, `/root`, `/snap`, `/nix`; `Windows`, `Windows.old`, `Program Files`, `Program Files (x86)`, `ProgramData`, `$Recycle.Bin`, `System Volume Information`, `Recovery` and `PerfLogs` on any drive; with anything inside them.
  - **The policy probe.** Only a root that passes every refusal asks for the policy (`allFoldersPolicy`). The answer is kept in memory with the key for `POLICY_TTL_MS` (5 minutes); every full key fetch (a git base, a delta without a key) refreshes it, a 428 or 503 keeps it as off, and sign-out forgets it. Without a kept answer the archiver sends one probe (`ArchiveUploader.probeKey`): a single GET /archives/key within 5 s, no backoff, no bearer refresh on a 401 (through the broker, `archiveRequest(..., { refresh: false })`), shared by the sessions that start meanwhile. Any failure (network, timeout, 401, 5xx, 428, 503, 404, a bad key) counts as off, is kept as off for the same 5 minutes, and never disables archiving or touches the queue. So with the policy off a folder session costs at most one GET per 5 minutes, even during an outage, and a flip on omnirush.ai reaches a running app within 5 minutes with no release.
  - **Key and consent.** A folder base reuses the key from the probe it just made. With a kept answer it fetches the key in full, like a git base (consent check, retries); if that response says the policy is now off, nothing is archived. A folder session's deltas pause (`not_archivable`) while the policy is off and catch up on the first delta after it is on again. The server also refuses `folder` archives from a user whose policy is off (`422 archive_marker_not_allowed`), which stops such a session.
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
  - a multi-MiB `writeSealedArchive` round trip checked with the `zstd` CLI, and a stopped writer rejecting.
- `manifest.test.ts`: UTF-8 byte order; the credential filter; the exclusions (credential, FIFO, app state, `__omnirush__`, unreadable, non-UTF-8); the hash cache; a stopped scan reading nothing; delta for add, modify (content and mode), delete, rename, file to dir, dir to file and symlink retarget; unstable re-send; `.git` changes; manifest JSON, with a delta's `trigger` and a final archive's `reason`; the git block and its `path`; `git status` never rewriting `.git/index`.
- `detect.test.ts`: a `.git` dir; a gitfile; no `.git`; an invalid gitfile; a `.git` symlink; home, `/` and app dirs refused; `root_not_directory`; detector plug-ins; `git_parent` (nearest parent wins, a `.git` folder without `HEAD` there qualifies nothing, root `.git` preferred, dotfiles home, system dirs, posix and `path.win32` walks including `/Volumes/<disk>` homes and WSL shares); the all-folders gate: policy off and on, git first, every refusal on macOS, Linux and Windows paths, credential and app-data folders anywhere and in other accounts, Windows device, long and trailing-dot paths, and credential folders on disk and through a link refused without asking the policy.
- `upload.test.ts` (in-process fake API and S3):
  - the happy path;
  - resume after a failed part;
  - a part S3 already holds;
  - an expired URL (403);
  - 428 and 503;
  - the key route's policy: only `all_folders: true` turns it on, and the key works either way;
  - the policy probe: one attempt with no backoff and no refresh for 502, 500, 503, 429, 401 and a network error; `refresh: false` through the request hook;
  - a 401 with a refresh, and a failed refresh;
  - NoSuchUpload leading to a re-create;
  - `archive_not_uploading` at complete;
  - `archive_parts_invalid`;
  - replay, chain conflicts and an unknown kid;
  - backoff;
  - the broker request hook.
- `lifecycle.test.ts` (fake archiver and engine, plus runs on the real archiver): the turn count on v1 and v2 message shapes; the feature flag; one base per root session per app run at the real path; child sessions ignored; deltas numbered from the engine and ordered after the base, and after the last archived turn when the messages could not be read; restart resume; a session whose start could not read the engine resolved at its next completed turn (its delta kept, also on the real archiver across an app restart), and a child resolved that way still ignored; an unreadable start retried after 1, 2, 5 and 10 minutes, one retry at a time, and never once archiving stopped; signed-out start clearing; sign-out stopping queued steps; 428 off until the recheck; failures contained. Final archives: one idle final per quiet window, a new prompt cancelling a pending or packing one, and so does a turn the observer follows (also when that turn's prompt came before the previous turn's end); a deleted session, a sign-out and a shutdown clearing both the idle final and the start retry, and a start read that fails after them arming no retry; a turn that ends without completing (delta when the engine's count moved, final otherwise or when the engine cannot be read, and a completed turn whose count did not move); a deleted session (child never); shutdown passing this run's sessions most recent first with the budget, and nothing without a budget, with consent off or with the account gone; app-start finals queued behind other steps; on the real archiver, the idle, quit and app-start finals of one session with the next turn's delta after them.
- `../project-archive.test.ts`: archives go through the broker's `archiveRequest` into `<state dir>/omnirush-archive/`; `OMNIRUSH_ARCHIVE_ENABLED=0` and a signed-out start clear leftovers without any network; a sign-out aborts a slow part PUT within a second and aborts the upload through the broker.
- `../capture-client.test.ts`: stopping the capture worker packs a final archive, and none when the account is gone.
- `../collector-observer.test.ts` ("with the project archive", the real lifecycle on a recording archiver, the observer on a fake clock): a turn of three hours, past the old one-hour cap, gets its delta and then the idle final; a turn still busy at the 24-hour safety bound gets `turnIncomplete` (its delta, the engine's count having moved) and then the idle final; a prompt sent while a turn settles keeps the idle final off while its own turn runs. On a fake archive: `turnFollowed`, then `turnCompleted` or `turnIncomplete` once per turn, including a turn after a completed one that fails, and nothing more at a server stop.
- `../omnirush-gateway-broker.test.ts`: `archiveRequest` URL, bearer, 401 refresh and path allowlist.
- `../workspace-collector.server.e2e.test.ts` ("project archive wiring"): through the real proxy and observer, one base then a delta numbered 2 after a changed turn; a turn whose status the engine stops answering is waited out (no `session.observer_failed`) and still gets its delta, numbered from the engine; a history past the 8 MiB read cap (one message over it alone) still gets its base, its turns' transcripts and deltas, and a turn whose messages cannot be read still gets its snapshot and delta; 428 checked once with the chat unaffected; the flag off sends nothing.
- `index.test.ts`:
  - the whole folder: `.git/` and gitignored `node_modules/` and `dist/` present, `.env` and `id_rsa` absent unless `archiveIncludeCredentialFiles`; the base then a delta, each decrypted and checked;
  - no delta when nothing changed, `stale_turn` and `exists`;
  - no `.git`: not archived with the policy off, absent or not a boolean (only the key read); with it on, archived whole with binaries and ignored-looking files, credentials left out, then a delta; home, userData and a system dir refused without a request; sessions in `~/.gnupg`, `~/.aws/sso/cache`, `~/.docker`, `~/.ssh`, `~/.kube`, `~/.config/gh`, `~/Library/Keychains`, Chrome's profile, `AppData` and a `secrets` folder refused without a request; a git project still archived as git; the policy off with the API failing (502, 401, 428, 503, network): one probe per burst, no sleep, no refresh, nothing written or disabled, and the next git session unchanged; the answer kept for `POLICY_TTL_MS`, turned on and off on the server, deltas pausing and catching up, forgotten at sign-out; a folder inside a larger repository sent with `workspace.git: null`;
  - consent off at the key route and during a drain;
  - app restart resuming a half-uploaded archive;
  - a crashed commit discarded;
  - a chain conflict and an unknown kid;
  - sign-out, and a slow part PUT aborted within a second of `signOut()` (the upload aborted with the credentials still held, nothing completed or sent afterwards) and of `stop()` (the job kept, resumed by the next start);
  - the app's state dir under the root pruned;
  - final archives: none without a base or when unchanged; the equal-turn wire values (sequence, parent, turn), chained finals, `trigger` and `reason` in the manifest; a server without final archives (`strictTurns`): one refused create, the chain put back, the turn delta queued behind the final captured again, later turns uploaded, one log line; shutdown finals within the budget, a hanging one cut at it and captured at the next start; the app-start candidates (a final due, the most recent session per folder; not deleted or older than 7 days); a deleted session whose folder is gone.
