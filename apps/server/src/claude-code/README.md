# Claude native evidence

The CLI and dedicated GUI Claude route use this shared native runtime. The
pinned official Agent SDK launches Claude Code inside Docker. This path does
not use the existing OpenCode conversation engine. Backend enablement remains
separate from local implementation and verification.

`NativeCapture` preserves the original root JSONL, every discovered child JSONL
and its metadata, and uncoalesced transport/hook journals. It never reconstructs
native records from OmniRush display messages or walks only a selected parent
chain. Unknown fields and opaque thinking signatures remain in private evidence.
Thinking text is the model's exposed summary, not hidden chain-of-thought.

The source must be a session-scoped persistent `CLAUDE_CONFIG_DIR`. Only the
requested UUID and its `subagents` files are read. Authentication files, other
sessions and symlinks are excluded. The private store is mode 0700 with 0600
files, content-addressed 1 MiB chunks and atomic fsynced manifests. Originals
have no redaction pass and must not enter the legacy scrubbed collector.

The caller awaits `captureClaude(context, action)` through `CaptureService`.
Stream actions carry byte offsets; duplicate retries must match the stored
bytes. Gaps, conflicting retries, missing acknowledgements, owner changes and
integrity failures reject. The runner must stop on rejection. A worker restart
can retry the same offset. A scan reconciles native files after a restart and
before finalization. Partial lines remain exact evidence and block completion;
replacement/truncation retains the previous generation. Unchanged files are
not reread; obsolete append-prefix chunks are pruned after manifest durability.

`finish` requires a stopped producer and successful terminal result. It checks
root presence, JSON validity, partial lines, unmatched tool calls and child
transcripts referenced by native launch results or supplied by the runner.
`complete` means the captured evidence passed these checks; `replay` remains
`unverified`. The caller must establish whole-process-tree termination and
perform environment/checkpoint and replay checks separately.

`exportTo` produces a private directory with `claude/`, `events/`, optional
`history/`, and `native-manifest.json`. Original bytes are hash-verified during
export. Do not claim a redacted derivative is byte-exact or resumable. Export
only behind the session's single-writer barrier.

The canonical source is this directory. Copy and check the CLI consumer with:

```sh
node scripts/sync-claude-capture.mjs /path/to/omnirush-cli
node scripts/sync-claude-capture.mjs /path/to/omnirush-cli --check
pnpm evals:pr specs/claude-native-capture.test.ts
```

`runtime.ts` records an immutable model/harness/image/capture contract and
brokers only that model, including SDK children. `access.ts` validates the
backend's session/model/contract binding and keeps short-lived tokens in host
memory. Unknown or conflicting provider identity blocks continuation; old
captures remain exportable without claiming retroactive model isolation.

The native manifest includes a versioned QC summary: human-prompt candidates,
synthetic events, compaction, tool/results, child transcripts, exposed thinking
and opaque blocks. Counts never replace original bytes. `verify.py` binds replay
to the exact ZIP and independently checks the contract and model journal.
Exact replay, soft differences, tools-ran and unverified outcomes stay distinct.
Missing actual shell argv/exit evidence prevents a strict shell replay claim.

See `docs/claude-native-pilot.md` for the product path, backend dependencies and
verification commands. Production enablement requires backend token/capture
adoption, usage matching, packaged OS validation and the native conversion lane.
