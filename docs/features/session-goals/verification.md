# Goal verification

This feature is for the desktop chat. It has not been released. The separate
Pi-based `omnirush-cli` needs its own port.

The PR's sticky `test-evidence` comment contains the results, assertion records,
and reproduction commands for the tested head commit. Local test records live
under `evals/results/test-runs/` and are not checked into the repository.

## Product checks

The 12-step server journey runs real managed OpenCode engines against a test
provider. It verifies file work across turns, cache-excluding token accounting,
budget exhaustion, pause, Stop, durable restart, Plan mode, replacement and late
events, steering, queued-work admission, stalled-work recovery, child-agent
billing, and all three goal tools.

The five-step desktop journey runs the native desktop engine. It checks slash
input and busy Enter, visible status, hidden internal prompts before and after
reload, the editor, replacement Cancel, separate chats, resume and completion,
and a visible budget stop.

The [paused panel](./goal-panel.png) and [token-limit panel](./goal-token-limit.png)
show the implementation during its original local desktop verification. See the
PR evidence for screenshots from the final PR head.

Focused source checks cover native message adaptation, goal admission, engine
ownership, queue holds, and preserving a newer draft. App and server type checks
also run. Broader repository checks can report existing issues outside these
paths; any remaining gaps are stated on the PR.

## Reproduce

Run from the repository root:

```sh
pnpm --filter @omnirush/types build
pnpm --filter omnirush-server build
OMNIRUSH_EVAL_ENGINE=v2 pnpm evals:pr specs/session-goals.test.ts
pnpm evals:pr specs/session-goals.test.ts
OMNIRUSH_EVAL_ENGINE=v2 pnpm evals:e2e session-goals
```

Set `OMNIRUSH_OPENCODE_BIN` to select a managed v1 binary. Set
`OMNIRUSH_OPENCODE2_BIN` to select a native v2 binary. Test placement remains
automatic.

The desktop fixture allows a five-minute source-build wait on a busy host.
Its assertions retain their normal limits. Set
`OMNIRUSH_ELECTRON_SKIP_WORKSPACE_BUILD=1` only when the server and headless
thread outputs match the current source. The default desktop launch builds
these packages. `OMNIRUSH_EVAL_ELECTRON_RESOURCES_PREPARED=1` and
`OMNIRUSH_ELECTRON_SKIP_NATIVE_REBUILD=1` similarly require prepared sidecars
and native modules. The frontend always loads the current source through Vite.

The test provider reports 130 input tokens with 100 cached reads and 20 output
tokens, including 5 reasoning tokens. Each reply must therefore charge 50
tokens. Engines use temporary workspaces and profiles.
