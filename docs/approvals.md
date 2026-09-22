# Approval modes

The engine asks before some tool calls. The omnirush.ai desktop app has two
approval modes:

| Mode | What asks |
| --- | --- |
| `guarded` (default) | The git and pull-request rules from [git-workflows.md](git-workflows.md): write commands ask once per session per command family, destructive commands always ask. Everything else follows the engine's own defaults (for example editing files outside authorized folders). |
| `full` | Nothing asks. The injected engine config sets `permission.bash` to a single `"*": "allow"` rule (no git ask rules, no `OMNIRUSH_DESTRUCTIVE` marker rule), `permission.read` to a single `"*": "allow"` rule (the engine asks before reading `.env` files by default; the later catch-all wins) and `edit`, `webfetch`, `websearch`, `doom_loop` and `external_directory` to `allow`. |

Organization rules from Den (`commands: deny`, `blockedCommands`, approved
browser origins) are still appended after those rules in both modes. The
engine keeps the last matching rule, so an organization deny always wins;
only the "ask" rules are dropped in full mode.

## Switching in the app

Two controls, one setting: the "Full permissions" switch beside the model
selector in the chat composer (the new-task composer and the session
composer) and Settings > General > Approvals > "Full permissions". They share
the loaded mode, so a change in either shows in the other at once. Toggling
either:

1. persists the setting in the global runtime config row
   (`approvals.mode`, `PUT /runtime-config/approvals`);
2. rewrites the injected engine config file
   (`~/.config/omnirush/runtime-opencode-config.json`);
3. triggers a manual engine reload, the same call Settings "Reload" makes, so
   the rules apply within seconds. The status reads "Full permissions on.
   Engine reloaded.", "Guarded mode. Engine reloaded." or the error to act
   on: Settings shows it under the switch, the composer shows it as a toast.
   Both controls stay disabled until the reload finishes.

Both controls reflect the current mode on load. While full mode is on the
composer switch is filled in the accent colour, so it is obvious that nothing
will ask for approval. While `OMNIRUSH_APPROVALS` forces the mode both are
disabled: Settings shows "Set by environment", the composer says so in a
tooltip. When the organization policy disables changing app settings the
composer switch is disabled as well and its tooltip says why.

## Forcing the mode from the environment

`OMNIRUSH_APPROVALS=full` or `OMNIRUSH_APPROVALS=guarded` in the environment
of the server process wins over the persisted setting. The value is
case-insensitive; anything else is ignored and the setting (or the default)
applies.

- Desktop app: the embedded server runs inside the Electron process and reads
  the app's environment, so launch the app from a shell with the variable
  set. On macOS a Finder or Dock launch has no shell environment; start the
  binary directly:

  ```sh
  OMNIRUSH_APPROVALS=full "/Applications/OmniRush.ai.app/Contents/MacOS/OmniRush.ai"
  ```

  On Linux run the AppImage or installed binary the same way; on Windows set
  the variable in the shell that starts the executable.
- Development: `OMNIRUSH_APPROVALS=full pnpm dev`, and
  `OMNIRUSH_APPROVALS=full pnpm world up dev-headless --detach` for the
  headless web world.
- Standalone server: set the variable for the `omnirush-server` process.

The Settings > Environment tab cannot set it: `OMNIRUSH_*` keys in the user
environment file are reserved and dropped.

## How the mode reaches the engine

- `apps/server/src/approval-mode.ts` resolves the mode: environment, then
  setting, then `guarded`.
- `legacyExecutionPermissions` (`apps/server/src/managed-policy-rules.ts`)
  renders the permission block for that mode into the injected engine config
  (`apps/server/src/omnirush-runtime-config.ts`). The engine re-reads the file
  on reload.
- The managed-policy engine plugin does not read the environment. Every
  `POST /managed-policy/evaluate` answer carries `approvalMode`, so the plugin
  applies the mode the server resolved for that very tool call. In full mode
  it skips the destructive-marker rewrite and the commit-identity refusal; it
  still sets the repository-local identity from the connected omnirush.ai
  account when the repository has none, and says so in the tool output.

## API

| Action | Request |
| --- | --- |
| Read the mode | `GET /runtime-config/approvals` -> `{ mode, source, setting }` (`source`: `environment`, `settings` or `default`) |
| Set the mode | `PUT /runtime-config/approvals` `{ mode: "guarded" \| "full" }` (client token, collaborator scope; refused when the organization disables changing settings) |
| Engine plugin evaluation | `POST /managed-policy/evaluate` -> `{ allowed: true, approvalMode }` |
