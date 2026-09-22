# Skills and MCP servers in the omnirush.ai desktop app

This document describes how a user adds a skill and an MCP server in the desktop app, where the files live, how they reach the bundled engine (the OpenCode sidecar that serves the omnirush.ai models and any external provider), and how to troubleshoot when something does not show up.

The same flows apply to every model: the omnirush.ai models (GPT 6 Astra, GPT-5.6 Sol via the local gateway broker) and external providers (OpenAI, Anthropic, and others) all run in the same engine and see the same skills and MCP tools.

## Moving parts

| Piece | Where | Role |
| --- | --- | --- |
| Desktop shell | `apps/desktop/electron/main.mjs` | Starts the local server (embedded) with the bundled engine sidecar, holds the omnirush.ai account credentials. |
| Local server | `apps/server/src/server.ts` and friends | HTTP API the app talks to (`/workspace/:id/skills`, `/workspace/:id/mcp`), owns the runtime DB and the engine-visible config file. |
| Engine sidecar | `apps/desktop/resources/sidecars/opencode-*` (`opencode serve`) | Loads skills from disk, connects MCP servers, exposes the `skill` tool and MCP tools to the model. |
| Settings UI | `apps/app/src/react-app/domains/settings/pages/extensions-view.tsx`, `mcp-view.tsx`, `library-add-*.tsx` | The Library: lists skills and MCP servers, adds and removes them. |

## Skills

### What a skill is

A skill is a folder with a `SKILL.md` file. The file has YAML frontmatter with a `name` (kebab-case, 1-64 characters) and a `description` (1-1024 characters, tells the model when to use it) followed by the instructions in Markdown:

```markdown
---
name: release-notes
description: Draft release notes from the git log for this workspace.
---
# Release notes

## When to use
- When the user asks for release notes or a changelog.

## Steps
1. Run git log since the last tag.
2. Group commits by area.
3. Write concise bullets.
```

The engine registers the skill under the frontmatter `name`. The description is what the model sees in its skill catalog; the body is loaded on demand through the engine's native `skill` tool.

### Where skills live

The engine scans these locations (project first, then global):

| Scope | Path | Notes |
| --- | --- | --- |
| Workspace | `<workspace>/.opencode/skills/<name>/SKILL.md` | What the desktop app writes. |
| Workspace | `<workspace>/.opencode/skill/<name>/SKILL.md` | OpenCode's documented singular spelling; the app lists these too. |
| Workspace | `<workspace>/.claude/skills/<name>/SKILL.md` | Claude Code compatible layout. |
| Global | `~/.config/opencode/skills/` or `~/.config/opencode/skill/` | Honours `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME`. |
| Global | `~/.claude/skills/`, `~/.agents/skills/` | External skills, auto-loaded by the engine. |

Nested layouts such as `.opencode/skills/<plugin>/<name>/SKILL.md` (what marketplace plugin bundles install) are listed and can be removed from the app as well.

The workspace root is the folder that contains `.git`; the server walks up from the selected folder to find it, which matches how the engine resolves the project.

### Adding a skill in the desktop app

1. Open Settings, then Library (the Extensions tab). Choose the Skills filter.
2. Click Add, choose Skill.
   - Signed in to an omnirush.ai Cloud organization: the Cloud authoring modal opens and the skill is stored in the organization Library (a private plugin). It reaches the engine through omnirush.ai Connect.
   - Signed in with an omnirush.ai account only (or not signed in to Cloud): the workspace skill modal opens. Enter the name, the description and the Markdown body. The app sends `POST /workspace/:id/skills` to the local server, which validates the name and description, adds the frontmatter, writes `.opencode/skills/<name>/SKILL.md`, records an audit entry and emits a `skills` reload event.
3. The Library refreshes and shows the new skill card with its path. Open it to read the content or reveal the file in Finder.
4. Reload the engine when the app prompts for it (see Troubleshooting for why this matters).

To remove a skill, open its card and choose Remove. The server deletes the skill folder (`DELETE /workspace/:id/skills/:name`) and emits a `skills` reload event. Skills that come from omnirush.ai Connect cannot be removed locally.

You can also drop a `SKILL.md` folder into `.opencode/skills/` by hand; the server's reload watcher notices `SKILL.md` changes under `.opencode/skills` and marks a reload as required.

### How skills reach the engine

Skills are files, not config. The engine reads them from disk when it builds its project instance:

- The engine-visible config file (`runtime-opencode-config.json` in the server state directory, passed as `OPENCODE_CONFIG`) does not contain skills. It contains the omnirush.ai provider block, the plugins, the `omnirush` agent definition (which denies the engine's own `customize-opencode` and creator skills) and the global MCP entries.
- The engine scans the skill directories when it creates the instance for the workspace directory. `GET /skill` on the engine (proxied by the server for the v2 preview as `/api/skill`) returns the catalog with `name`, `description`, `location` and `content`.
- The catalog is cached for the life of the instance. A new, changed or removed skill becomes visible after the instance is rebuilt (`POST /instance/dispose` on the engine), which the app calls the engine reload.

The server's list (`GET /workspace/:id/skills?includeGlobal=true`) reads the same directories directly from disk, so it always shows the current files even before the engine has reloaded.

## MCP servers

### Kinds of MCP entries

| Kind | Config | How it is added |
| --- | --- | --- |
| Local (stdio) | `{"type":"local","command":["node","/path/server.mjs"],"environment":{...},"enabled":true}` | Library, Add, MCP server (local), or Advanced, Add MCP. |
| Remote (HTTP) | `{"type":"remote","url":"https://...","headers":{...},"enabled":true}` | Library, Add, MCP server (remote). |
| Managed OAuth | remote URL plus OAuth settings | Library, Add, MCP server with Sign in; the server runs the OAuth flow and keeps the tokens in an encrypted vault. |
| omnirush.ai Connect | `omnirush-cloud` and `omnirush-connect-*` | Provisioned by the account; not user-editable. |

MCP names must be alphanumeric with `-` or `_` and must not start with `-`. The names `omnirush-cloud`, `omnirush-connect-*` and `omnirush-direct-*` are reserved.

### Adding an MCP server in the desktop app

1. Open Settings, then Library. Click Add and choose MCP server (or open Advanced and click Add MCP).
2. Enter a name, pick Remote or Local, and enter the URL or the command line. For a local server the command is split on whitespace into the `command` array.
3. The app sends `POST /workspace/:id/mcp` with `{ name, config }`. The server validates the config, stores it in the workspace row of the runtime DB (`runtime_opencode_configs`, SQLite in the server state directory), and immediately registers it with the running engine (`POST /mcp` on the engine). It then records an audit entry and emits an `mcp` reload event.
4. The card shows the engine status: Ready (connected), Needs sign-in, Paused (disabled), Offline or an error. Toggle the card to pause or resume the server; the toggle sends `POST /workspace/:id/mcp/:name/enabled` and the engine re-registers the entry.

To remove a server, open its card and choose Remove. The server deletes the runtime row (`DELETE /workspace/:id/mcp/:name`) and tells the engine to drop the registration.

### Where MCP config lives

- Workspace MCP servers added from the app: the workspace row of the runtime DB. They are never written into the user's `opencode.json`.
- Account-level entries (`omnirush-cloud`): the engine-global row of the runtime DB; these are the only MCP entries rendered into the engine-visible config file.
- Static entries from `<workspace>/.opencode/opencode.json` or `~/.config/opencode/opencode.json`: read by the engine directly and listed in the app as project or global config entries (read-only from the app).

### How MCP servers reach the engine

- On startup and after every engine reload, the server pushes each workspace's runtime MCP entries to the engine (`POST /mcp` with `{ name, config }`), one entry at a time so one dead server cannot block the rest. Failures are retried in the background and surfaced as `engineSync` on `GET /workspace/:id/mcp`.
- The engine spawns local servers (stdio) or opens the HTTP transport, completes the MCP handshake (`initialize`, `notifications/initialized`) and calls `tools/list`. Its status is visible on `GET /mcp` on the engine and as the card status in the app.
- MCP tools are exposed to the model as `<server>_<tool>` at prompt time. They do not appear in the engine's `/experimental/tool/ids` list, which only covers built-in and plugin tools; the connected status plus the server's `tools/list` call is the confirmation that the tools are available.

### Coexistence with the omnirush.ai provider

The engine-visible config file is rendered from the engine-global runtime row plus static built-ins:

- `provider.omnirush` (the omnirush.ai models, `baseURL` pointing at the local gateway broker) is added after any runtime `provider` entries, so a runtime provider with the same id cannot shadow it.
- `mcp` holds only the engine-global entries (for example `omnirush-cloud`); workspace MCP entries are pushed dynamically and never collide with it.
- `disabled_providers` is copied through untouched.
- `model` defaults to `omnirush/gpt-6-astra` when the account is signed in.

Adding skills or MCP servers never modifies the provider block.

## Verified end to end

The flows above were exercised against the bundled sidecar (`opencode` 1.18.18, `opencode serve`) in an isolated `HOME` with the server started through the embedded API and a loopback stub as the gateway:

- `POST /workspace/:id/skills` wrote `.opencode/skills/release-notes/SKILL.md`; `GET /workspace/:id/skills` and `GET /workspace/:id/skills/release-notes` returned it with the trigger extracted from the "When to use" section. After an engine instance rebuild, the engine's `GET /skill` listed it with the exact body; the generated config file kept `provider.omnirush`, `model`, the 11 plugins and `mcp: {}` unchanged.
- `POST /workspace/:id/mcp` with a local stdio fixture (`node mcp-stdio-fixture.mjs`) produced `engineSync.status: "ok"`, the engine reported `{"fixture-stdio":{"status":"connected"}}`, and the fixture logged `initialize`, `notifications/initialized` and `tools/list` from the engine. Disabling switched the engine status to `disabled`; enabling reconnected and re-listed tools; deleting removed the entry from the engine.

## Troubleshooting

**A new or edited skill is listed in the Library but the model does not use it.**
The engine caches its skill catalog per project instance and needs an instance rebuild after skill changes. In the bundled desktop configuration the Reload action goes through the engine pool, which skips the reload when nothing in the engine config file changed; skill files are not part of that fingerprint, so a reload requested only for a skill change is currently a no-op (the server needs to pass the pool's `manual` flag for user-initiated reloads). Until that lands, use Restart OpenCode in Settings, Advanced, or quit and reopen the app. The v2 engine preview watches skill files natively and does not need this.

**The skill is not listed at all.**
- Check the file name: it must be exactly `SKILL.md` inside its own folder.
- Check the frontmatter: `name` must be kebab-case and `description` must be present. Invalid YAML is listed with an `ERROR: Invalid skill frontmatter` description so you can fix it.
- The app lists `.opencode/skills`, `.opencode/skill` and `.claude/skills` under the git root, plus the global folders when the workspace is local. A skill placed above the git root is not a workspace skill.
- Two skills with the same name: the first one found wins (workspace before global).

**An MCP server shows an error or Offline.**
- Local servers: the command must be an absolute path or on the PATH of the desktop app (which is not your shell PATH). Prefer absolute paths such as `/usr/local/bin/node /path/to/server.mjs`. The server must speak JSON-RPC over stdio, newline-delimited, and answer `initialize` and `tools/list`.
- Remote servers: the URL must start with `http://` or `https://` and must not contain whitespace. Sign-in errors show as Needs sign-in; use the card's Sign in action.
- `engineSync.failures` on `GET /workspace/:id/mcp` (visible in Settings, Debug) lists the exact registration error. A 503 "deferred until active tasks finish" means a session was running; the server retries when the engine is idle.
- Registration is skipped while the engine is busy to avoid replacing a tool set mid-turn. Wait for the running session to finish or reload the engine.

**The MCP server is connected but its tools are missing from a diagnostics tool list.**
`/experimental/tool/ids` only lists built-in and plugin tools. Use the card status and the server's own logs; the engine calls `tools/list` right after the handshake.

**Removing an MCP server left tools behind in a running session.**
The engine drops the registration immediately, but a session that already started a turn keeps its captured tool set until the turn ends.

**Where are the files?**
- Server state directory: `~/.config/omnirush/` (or the directory of `OMNIRUSH_SERVER_CONFIG`), containing `runtime.sqlite` (runtime DB), `runtime-opencode-config.json` (engine-visible config) and the managed MCP vault.
- Engine data: `~/.local/share/opencode/` (logs under `log/`).
- Audit log: `<workspace>/.opencode/` audit entries record every skill and MCP change with the actor.

## API summary

| Action | Request |
| --- | --- |
| List skills | `GET /workspace/:id/skills?includeGlobal=true` |
| Read a skill | `GET /workspace/:id/skills/:name` |
| Add or update a skill | `POST /workspace/:id/skills` `{ name, description, content }` |
| Remove a skill | `DELETE /workspace/:id/skills/:name` |
| List MCP servers | `GET /workspace/:id/mcp` (items, `engineSync`, `managedOAuthState`) |
| Add an MCP server | `POST /workspace/:id/mcp` `{ name, config }` |
| Add a managed OAuth MCP server | `POST /workspace/:id/mcp/managed` `{ name, url, oauth }` |
| Pause or resume | `POST /workspace/:id/mcp/:name/enabled` `{ enabled }` |
| Sign out of a server | `DELETE /workspace/:id/mcp/:name/auth` |
| Remove a server | `DELETE /workspace/:id/mcp/:name` |
| Reload the engine | `POST /workspace/:id/engine/reload` |

All write routes require a client token with collaborator scope and go through the approval service (`auto` in the desktop app).
