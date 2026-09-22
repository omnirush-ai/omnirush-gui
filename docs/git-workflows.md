# Git and pull requests from the desktop agent

The omnirush.ai desktop agent can work on a git tree from the chat: clone,
branch, create worktrees, commit, push, open and review pull requests with
`gh`. This page describes what runs without asking, what asks once, what
always asks, how the commit identity is chosen, and how to fix `gh`
authentication. It applies to omnirush.ai models and to external providers
alike: the rules live in the engine's permission ruleset and in the
managed-policy plugin, not in the model.

## What works

- Tools on PATH: the engine's bash tool sees `git` and `gh` the way the
  packaged app resolves them. The app parses the macOS login-shell PATH
  (`/usr/libexec/path_helper`) and adds the well-known tool directories
  (`/opt/homebrew/bin`, `/usr/local/bin`, nvm, fnm, volta, pnpm, bun, cargo,
  pyenv, `~/.local/bin`) for the server; the managed-policy plugin applies the
  same list inside the engine, so a dev server started from a bare terminal
  behaves like the packaged app. Sources: `apps/desktop/electron/runtime.mjs`
  and `apps/server/src/opencode-plugins/managed-policy-path.ts` (a test keeps
  the two lists identical).
- Worktrees: the agent prefers `git worktree add ../<repo>-<branch> -b <branch>`
  for parallel branches and removes them when the work lands.
- Conventional commits, `gh pr create` with a title and body, `gh pr
  list/view/status/checks/diff` for review. The agent reports the PR URL.
- Never force-pushes `main`/`master`; force-pushes only a feature branch when
  asked, preferring `--force-with-lease`.

The rules are stated to the agent in its base prompt
(`apps/server/src/omnirush-agent-prompt.ts`, section "Git workflows").

## Approval rules

Every shell command is split into segments (`&&`, `||`, `;`, `|`, newlines,
`$(...)`, subshells, brace groups) and each segment is classified by
`apps/server/src/opencode-plugins/managed-policy-git.ts`. The classification
looks through what precedes or wraps the command: reserved words (`if`, `!`,
`while`, `do`, `time`), privilege and exec wrappers (`sudo`, `env`, `nohup`,
`nice`, `timeout`, `xargs`, `find -exec`) and interpreters that receive a
command line as an argument (`bash -c`, `sh -c`, `zsh -c`, `eval`, `env -S`,
`su -c`). Heredoc bodies, comments and quoted strings are data and are never
classified or rewritten; the `$(...)` substitutions inside an unquoted heredoc
are, because the shell runs them.

| Tier | Examples | Behaviour |
| --- | --- | --- |
| read-only | `git status`, `git log`, `git diff`, `git show`, `git fetch`, `git branch` / `--list` / `-a` / `--show-current`, `git remote -v`, `git worktree list`, `git tag`, `git stash list`, `git config --get`, `gh pr list/view/status/checks/diff`, `gh issue list/view`, `gh repo view`, `gh auth status`, `gh run list/view`, `git --no-pager <read>` | runs without an approval prompt |
| write | `git add`, `git commit`, `git checkout -b`, `git switch`, `git worktree add/remove`, `git push`, `git pull`, `git merge`, `git rebase`, `git tag <name>`, `git config <key> <value>`, `gh pr create/merge/close/edit`, `gh repo clone/create`, `gh api` | asks once per session per command family: choose "Allow for session" and the engine remembers the family (`git commit *`, `gh pr create *`); "Allow once" asks again next time |
| destructive | `git push --force` / `-f` / `--force-with-lease` / `--delete` / `:branch` / `--mirror`, `git reset --hard`, `git clean -f*`, `git branch -D`, `git rebase -i`, `git filter-branch`, `git stash drop/clear`, `git reflog expire`, `git worktree remove --force`, `gh repo delete`, `rm -rf`, `sudo` | always asks, also inside `if`/`for`/`while`/`!`, subshells and substitutions, and behind `bash -c`, `sh -c`, `eval`, `env -S`, `xargs`, `find -exec`, `timeout` or `sudo` |
| interpreter | `bash -c '…'`, `sh -c '…'`, `zsh -c '…'`, `eval …`, `env -S '…'`, `su …` | asks once per session per family (`bash *`, `eval *`), because the engine cannot see the command line inside the argument; a destructive command inside is still marked and always asks |

Unknown `git` and `gh` subcommands are treated as write commands.

How it is wired:

- `legacyExecutionPermissions` (`apps/server/src/managed-policy-rules.ts`)
  injects the `permission.bash` rules into the engine config
  (`omnirush-runtime-config.ts`): `git *`, `gh *` and `sudo *` ask, the
  read-only shapes are allowed again, destructive shapes ask. Organization
  rules from Den (`commands: deny`, `blockedCommands`) are appended last, and
  the engine keeps the last matching rule, so an organization deny always wins.
- The engine remembers "Allow for session" by command family, which would
  otherwise cover `git push --force` once a plain `git push` was approved. The
  managed-policy plugin therefore prefixes every destructive command with
  `OMNIRUSH_DESTRUCTIVE=1` (an ordinary environment assignment). The prompt
  shows the marker, the marked command matches the always-ask rule and never
  the remembered family. The agent is told not to add or remove the marker.
- The engine parses the command line (tree-sitter) and evaluates every
  `command` node it finds, including the ones inside `if`, `for`, `while`,
  `!`, subshells and `$(...)`. The marker is therefore inserted in front of
  the command itself, after any reserved word (`if OMNIRUSH_DESTRUCTIVE=1 git
  push --force; then …`, `! OMNIRUSH_DESTRUCTIVE=1 git push -f`), so the node
  the engine evaluates starts with the marker. For an interpreter the engine
  only sees `bash -c '…'`, so the marker goes in front of the interpreter
  (`OMNIRUSH_DESTRUCTIVE=1 bash -c 'git push --force'`) and the interpreter
  families ask once per session like write commands.
- Heredoc bodies and comments are left untouched: `cat > deploy.sh <<'EOF'`
  followed by `git push --force` on the next line writes exactly that line,
  and `git commit -F - <<EOF` keeps its message.
- Run git from the repository (the bash tool's `workdir`) rather than with
  `git -C <dir>`: the engine's command families are token based, so `git -C`
  forms do not benefit from a previous "Allow for session".

## Commit identity

Git silently invents `user@host` (or refuses) when `user.name` / `user.email`
are unset. Before a commit-creating command (`commit`, `merge`, `rebase`,
`cherry-pick`, `revert`, `am`, `stash`, annotated `tag`, `notes`) the plugin
checks the target repository:

- identity set in the repository or through `GIT_AUTHOR_*` /
  `GIT_COMMITTER_*`: nothing happens;
- identity missing and an omnirush.ai account is connected: the account's
  display name and email are written to that repository only (`git config
  --local`, never `--global`), and the tool output ends with a note the agent
  relays: `[omnirush.ai] omnirush.ai set the commit identity for <repo> to
  <name> <email> ...`;
- identity missing and no account: the command is refused with a message that
  asks the agent to collect a name and email and to set them with `git config
  user.name` / `git config user.email` in the repository.

The check reads the command line in order, so the recovery can be one call:
`git config user.name "…" && git config user.email "…" && git commit -m "…"`
is accepted because both halves are written before the commit runs. `git -c
user.name=… -c user.email=… commit`, a `GIT_AUTHOR_NAME=… GIT_COMMITTER_NAME=…
GIT_AUTHOR_EMAIL=… GIT_COMMITTER_EMAIL=…` prefix and an earlier `export` of
that pair count the same way. Half an identity, an identity written after the
commit or one written to a different repository (`git -C`) is still refused.

Server side this is the `git_identity` action of `/managed-policy/evaluate`
(`apps/server/src/managed-git-identity.ts`). The desktop app supplies the
profile through the account store; a standalone server with
`OMNIRUSH_GATEWAY_URL` / `OMNIRUSH_ACCESS_TOKEN` reads `/device/me` directly.

## Troubleshooting gh

- `gh: command not found` in the agent: install GitHub CLI (`brew install gh`
  on macOS). The engine looks in `/opt/homebrew/bin` and `/usr/local/bin` even
  when the app was launched from the Finder; restart the app after installing.
- `gh auth status` fails or reports "not logged in": run `gh auth login` in a
  terminal (the agent cannot complete the browser flow). Tokens stored in the
  keyring are shared with the agent; `GH_TOKEN` in the environment works too.
- `gh auth status` reports "The token in default is invalid" only inside the
  agent: the agent runs with a HOME that has no login keychain (an isolated
  test HOME, or a service account), so `gh` cannot read the keyring token.
  Put the token in `GH_TOKEN` for that environment (`gh auth token` prints
  it; never paste it into a chat) or run `gh auth login` with
  `GH_CONFIG_DIR` pointing at a config directory the agent can read.
- `gh repo delete` fails with a scope error: the token needs `delete_repo`.
  Run `gh auth refresh -h github.com -s delete_repo` in a terminal.
- `gh repo create --push` or `git push` fails over SSH: `gh config get
  git_protocol` says `ssh` but the agent's environment has no SSH agent. Either
  `gh config set git_protocol https` and `gh auth setup-git`, or make the SSH
  key available to the login session.
- Pushing over HTTPS asks for a password: run `gh auth setup-git` so git uses
  `gh auth git-credential`.
- A write command asks on every call: answer "Allow for session" once per
  command family; "Allow once" is deliberately single-use.
- A command shows `OMNIRUSH_DESTRUCTIVE=1` in the approval prompt: the plugin
  classified it as destructive; approve it only if you meant it. "Allow for
  session" on such a prompt approves the plain family (for example `git push`)
  but destructive variants keep asking.
