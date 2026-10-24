# Native Claude Code pilot

The CLI and GUI use the same pinned Claude Agent SDK runtime. The SDK launches
Claude Code inside a Docker container; OpenCode is not involved in this path.
The initial project is copied into `/workspace`. The controller, shell tools,
subagents, dependencies, home directory and native transcripts all live inside
the container. Edits remain in that session's copy and are included in its ZIP.

## Run

Prerequisites: Docker Engine or Docker Desktop, an OmniRush device login, and an
active selected-account Claude access. The backend must advertise
`collect/capabilities.claude_code.enabled`, the matching SDK package pin and a nonempty
model catalog containing the pilot model, and provide the session-token and
capture routes described below. There is no personal subscription fallback.

In the GUI, open a workspace's actions and choose **Claude Code pilot**. Confirm
private capture, create a session and send a prompt. Select an existing session
to continue it, including after restarting the app. **Stop**, **Recover evidence**,
**Verify restore**, **Download private ZIP**, and **Upload private session** are
available on the same page. A native save dialog streams desktop ZIP downloads
to disk; browser mode downloads through the browser.

The matching CLI release exposes:

```sh
omnirush claude run --workspace ./project --capture-consent --prompt 'Implement the change and run tests'
omnirush claude continue --session UUID --prompt 'Add coverage for edge cases'
omnirush claude verify --session UUID --command 'node --test'
omnirush claude export --session UUID --output session.zip
omnirush claude upload --session UUID
omnirush claude recover --session UUID
```

Omit `--prompt` for interactive CLI input. `list` and `inspect --session UUID`
show local sessions. Ctrl-C stops an active CLI turn and retains partial evidence.
The older `claude-pilot` command is a diagnostic harness, not this product path.

## Sandbox startup barrier

The native Claude path is box-only independently of `local_box.required`.
`ClaudeRuntime.create()` awaits image preparation, container creation and the
initial checkpoint before publishing a session. The GUI cannot send its first
prompt until that session exists; the CLI also awaits creation before starting
the turn. Every turn awaits container startup before invoking the SDK, and a
concurrent send is refused while that operation is active.

These routes do not use the existing-harness `BoxService.waitForBox` path.
Unified-composer integration must dispatch Opus through this native runtime and
retain its startup barrier, including under `offer`; it must never fall back to
host execution while a sandbox is preparing. A delayed-startup server check is
separate from GUI proof of the setup banner and pending-send presentation.

## Evidence and reproducibility

- Exact native root and child JSONL, metadata, every conversation branch, and
  previous generations after rewrites are retained. Request-cache blobs remain
  byte-exact but are not counted as new tool executions.
- Exposed thinking summaries and opaque signatures remain in the private
  native data. Hidden model reasoning is not exposed or reconstructed.
- SDK events are durable before they are acknowledged. Hooks record tool and
  subagent lifecycles, compaction, stops and failures. Read-time hashes allow
  verification when Claude returns a cached “file unchanged” response.
- The container stops before each checkpoint. Exact before/after image IDs are
  recorded for every turn. Shared Docker layers are stored once in a multi-image
  archive; the archive SHA-256 is checked before restoration.
- Native completeness requires a stopped successful producer, valid complete
  JSONL, matching calls/results, and all expected child transcripts and stops.
  Interrupted, truncated or missing evidence remains incomplete.
- A completed container removed by local cleanup is reconstructed from its saved
  image on resume. A missing interrupted container cannot be reconstructed from
  a later state; its incomplete evidence stays available for review.

The ZIP includes `session.json`, `native-manifest.json`, `claude/`, `events/`,
`diagnostics/`, `images/`, and `verify.py`. Saved images contain the project,
git state, executable modes, installed dependencies and files outside
`/workspace`. Export reads saved evidence without contacting Docker or requiring
an account connection; it does not copy a possibly running container's mutable
workspace. A proven-dead operation owner can be recovered for export, while
live or unknown owners keep the session locked. Native JSONL is authoritative;
SDK events are a transport mirror.
Do not add their token/tool counts together.

**Capture complete**, **environment restored**, **upload received**, and
**recorded-tool replay verified** are separate claims. The GUI restore action
runs a chosen command against the final saved image with networking disabled.
It does not label the session reproducible just because Docker can start it.

On an isolated conversion worker with the reviewed `omniconv` verifier installed:

```sh
python3 verify.py session.zip --out new-private-report-directory
# Optional additional after-state comparison outside the project:
python3 verify.py session.zip --out another-report --check-path /absolute/path
```

The included adapter verifies native evidence and image hashes, derives calls
from native assistant/user records and execution hooks, restores each turn's
before image, runs the existing `omniconv.verify` replay engine without network
access, and compares project bytes, modes and symlinks to the after image. It
includes all child calls and checks cached reads against their pre-tool hashes.
Reports bind the exact ZIP SHA-256 and size, session, manifest, derived calls,
verifier and adapter fingerprints. Strict replay is separate from soft replay;
missing actual shell invocation/exit witnesses cannot earn a strict verdict. Unsupported calls,
missing witnesses, side-effect skips and incomplete evidence are not silently
accepted. Model inference is not rerun. These private reports do not authorize
distribution; masking, quality admission and delivery review remain separate.

The pinned SDK can strip an Agent request's `model` before emitting hooks when
the session forces one model. The adapter accepts only this independently
corroborated transform, preserves both requested and effective inputs, and
marks it soft. Other unexplained input differences still fail. Reports identify
the external adapter and the adapter embedded in the immutable ZIP separately.
Filesystem qualification applies only to the listed paths. A complete saved
home directory can restore correctly while recorded-tool replay differs in
Claude's own journals, which tool execution does not regenerate; those
differences remain visible in an extended-scope report.

This is a native-format ingress adapter. The existing Astra/OpenCode
`export_to_raw.py` and production autofeed do not automatically understand this
ZIP; route it through `verify.py` on a separate native pilot lane. Keep the
original JSONL instead of relabelling it as OpenCode data.

The converter's `native_archive.read` accepts the decrypted native archive tree
or checkpoint ZIP. Supply `session_id`, `binding_id`, `contract_hash`,
`manifest_sha256` and `engine_version` from the authenticated archive row. It
verifies every member and original transcript generation, then produces an
explicitly derived view with record provenance. Conflicting generations,
unknown ancestry or missing ingress require review. Successful parsing does
not establish model purity or replay.

The backend worker entry point `native_archive_qc.build_native_timeline`
connects that verified input to the existing QC view. It requires the trusted
identity fields and refuses incomplete or ambiguous input. Leading compaction
context is preserved without adding a human turn. Deployment must refresh the
vendored converter from the integrated native changes and shared compaction
PR; local source overlays used during validation are not an upstream release
pin. Archive decryption, worker scheduling and production admission remain
backend integration steps.

## Backend and boundaries

`POST /device/claude-token` creates or refreshes the canonical immutable
session binding. Its request names session, project hash, exact catalog model,
capture-contract SHA and actual client version. The broker validates the echoed
session, root, model, contract and exact upstream model, including the initial
grant. A grant mapping Opus to another model is refused before inference. Short-lived `orc_`
tokens stay in host memory, coalesced across parallel requests and refreshed
before expiry. The sandbox receives only a disposable local broker credential;
completed turns revoke their live backend tokens. The retired pilot raw-key
endpoint is never used. Every inference remains subject to backend access and
allowance checks. Backend budget snapshots are shown only when supplied;
missing or null balances remain explicitly unknown. The refresh interval must
be at least one second and no greater than the token lifetime. Mint request
latency counts against that lifetime; cached grants refresh before expiry.
Neutral quota scope, bucket, reset and token-limit headers reach the SDK;
unrelated provider headers remain private.

The host broker forwards to the mint's `base_url` with the current `orc_` token
as `x-api-key`, plus the bound session, actual client version and box headers.
It preserves Claude Code's own User-Agent, `x-app` and beta headers. This path
refreshes credentials at the host broker for every request; the direct-to-relay
`apiKeyHelper` recipe is not needed for this brokered SDK path. Neither a Packy
key nor the former supplied test key is accepted by the device-grant consumer.
Server-side account key routing (#514) and allowance pools (#513) need no
provider credential in either client. Claude remains unavailable while the
backend disables it or returns an empty catalog.

The SDK pilot requires `claude_code.sdk = {package, version, integrity}` to
match the SDK package in its frozen pnpm lock. Missing or mismatched metadata
disables admission. The lock also verifies the Linux platform packages during
installation. The separate direct-install `version`/`npm_integrity` fields
describe the Claude Code npm package and cannot attest this SDK bundle.
Backend deployment and configuration of the additive SDK capability remain
enablement gates; no live-install test is claimed while Claude is disabled.

The root, helpers, subagents and compaction use the session's model. Managed
settings and the broker reject model overrides. Provider-reported identities
are retained separately from requested identities. Response bytes are held until
the provider identifies the pinned model; missing identity stops the SDK before
it receives a tool call and blocks continuation. A mismatch invalidates isolation.
The replay admission check also rejects an upstream binding to another model.
This proves the managed
inference path only: the initial project is user-supplied and network-enabled
development tools could reach other services. The capture contract records
those limits, not a claim that every byte was created by one model.

 No host home directory, credentials, project mount or Docker socket
is mounted. The container runs as a non-root user with dropped capabilities,
resource limits and no-new-privileges. Docker isolation is intended for a
farmer's own development machine or an isolated worker, not a hostile shared
production host.

Private upload reuses the project archive protocol: client-side ORSEAL01 sealing,
then direct presigned multipart uploads. Device credentials are used only for
archive API calls, never sent to object storage. Two independent payloads share
the session binding: `claude_native` (original traces, histories, hooks, contract
and QC in tar+zstd) and `claude_checkpoint` (the exact replay ZIP). Both contain
`__omnirush__/manifest.json`, binding every member's path, size and SHA-256.
Receipts retain plaintext and sealed hashes. Upload retries reuse durable sealed
jobs and archive IDs; local originals remain available on every failure.

The backend advertises independent payload switches/caps. Checkpoints default
off until storage is approved; native traces can still upload and count toward
capture matching. The UI explicitly reports native-only, pending or complete
receipt status. Receipt means received, never replay-verified. Legacy captures
without a backend binding remain locally exportable. The old pilot chunk routes
are reference code only and are not the production integration.

Pilot limits: Docker is required; ZIP32 bundles are under 4 GiB; native
transcripts are capped at 256 MiB per file and 1 GiB per scan. Full snapshots can
contain private project configuration and secrets supplied in the project.
Upload and download are explicit, and raw bundles must stay private. There is
no model-provider fallback. Existing provider selection and retry policy stay
owned by the internal proxy.

## Verification and rollout

```sh
pnpm evals:e2e claude-native
pnpm evals:pr specs/claude-native-capture.test.ts
pnpm --filter omnirush-server typecheck
pnpm --filter @omnirush/app typecheck
pnpm --filter @omnirush/types build
pnpm --filter @omnirush/app build
node --test apps/desktop/electron/binary-transfer.test.mjs
node scripts/sync-claude-capture.mjs /path/to/omnirush-cli --check
```

The journey supports browser and packaged Electron modes. It uses the real
product server, Docker, the pinned SDK and five
real SDK subagents; its account and inference services are deterministic test
fixtures. It covers three resumed turns, page reload, host isolation, native
thinking/children/hooks, cached-read witnesses, restore, browser export,
desktop streaming transfer, upload recovery, access rejection and long-chat
layout. Packaged mode uses the embedded Node server, Electron preload and a native save
dialog. A development-variant executable test is separate from validating a
signed release installer. The current verification report states which mode
actually ran.

Ship the backend device/capture endpoints first, then CLI and GUI together,
with selected-account gating. Before widening access, validate the hosted
backend and real private object storage, package/sign the desktop releases,
and connect the native pilot queue to the conversion worker. Repository tests
and a Launchpad inference smoke do not establish those deployment checks.
