<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./omnirush-logo-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="./omnirush-logo.png" />
    <img src="./omnirush-logo.png" alt="omnirush.ai" width="128" height="128" />
  </picture>
  <h1>omnirush.ai</h1>
  <p>An AI coding agent for your desktop. GPT 6 Astra and GPT-5.6 Sol are free with an omnirush.ai account. In return, the app uploads your chat sessions and workspace snapshots to omnirush.ai under your account, with secrets and personal identifiers redacted.</p>
</div>

## Download

Every build is on the [latest release](https://github.com/omnirush-ai/omnirush-gui/releases/latest). File names carry the version number, for example `omnirush-mac-arm64-1.0.8.dmg`.

| Platform | File to download | Notes |
| --- | --- | --- |
| macOS, Apple Silicon | [`omnirush-mac-arm64-<version>.dmg`](https://github.com/omnirush-ai/omnirush-gui/releases/latest) | A `.zip` of the same app is also attached. No Intel build. |
| Windows x64 | [`omnirush-win-x64-<version>.exe`](https://github.com/omnirush-ai/omnirush-gui/releases/latest) | NSIS installer. |
| Linux x64 (Debian, Ubuntu) | [`omnirush-linux-amd64-<version>.deb`](https://github.com/omnirush-ai/omnirush-gui/releases/latest) | Installs the GTK runtime it needs. |
| Linux x64 (other) | [`omnirush-linux-x86_64-<version>.AppImage`](https://github.com/omnirush-ai/omnirush-gui/releases/latest) or [`omnirush-linux-x64-<version>.tar.gz`](https://github.com/omnirush-ai/omnirush-gui/releases/latest) | Needs the GTK runtime installed first (see below). |

Each release also has `SHA256SUMS.txt` for checking a download.

## First launch

Builds are not notarized (macOS) or code-signed (Windows) yet, so the operating system asks for one confirmation the first time.

| OS | What to do |
| --- | --- |
| macOS 15 and later | The first open says "Apple could not verify OmniRush.ai.app is free of malware". Click **Done**, open **System Settings > Privacy & Security**, scroll to **Security**, click **Open Anyway** next to OmniRush.ai.app, then **Open**. Or run `xattr -dr com.apple.quarantine /Applications/OmniRush.ai.app` in Terminal. |
| macOS keychain | When the app asks to use "omnirush.ai Safe Storage", enter your Mac login password and choose **Always Allow**. That item only holds the key that encrypts your omnirush.ai sign-in on this Mac; macOS asks again after the app binary changes. |
| Windows | On the SmartScreen dialog choose **More info > Run anyway**. If setup reports "Extract: error writing to file", the download is incomplete or blocked: download it again, compare its hash with `SHA256SUMS.txt`, free some disk space, and retry. |
| Linux | Prefer the `.deb` on Debian and Ubuntu. For the AppImage or tar.gz, install the runtime first: `sudo apt install libgtk-3-0 libnss3 libatk-bridge2.0-0 libasound2` (on Ubuntu 24.04 use `libasound2t64`), then `chmod +x` the AppImage or unpack the tar.gz. An error about `libatk-1.0.so.0` means those packages are missing. |

## Sign in

Click **Sign in to omnirush.ai** in the sidebar (or on the main Settings page). Your browser opens [omnirush.ai/console](https://omnirush.ai/console) with a device code; approve it there and the app is ready.

Signing in is also your consent to the data collection described below. The app does not run prompts until an omnirush.ai account is connected.

## What is collected and how it is protected

While you are signed in, the app uploads the following to omnirush.ai, linked to your account:

- session traces: your prompts, the model's replies, and tool calls, for every model you use in the app;
- snapshots of the workspace the chat runs in: file contents, the file list, and git metadata and diffs.

Before anything leaves your machine:

- some paths are never uploaded: `.git`, `node_modules`, `.env*`, `.ssh`, `.aws`, `.gnupg`, `.npmrc`, `.pypirc`, `id_rsa` and `id_ed25519`, key and certificate files (`.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`), `.docker/config.json`, and any file or folder whose name has the word credential(s), secret(s) or private key(s) in it (`secrets.ts`, `aws-credentials.json`, `private_key.txt`);
- other files whose path contains a credential word (key, token, password, wallet, seed, mnemonic and similar) are dropped too, unless they have a source, config or docs extension such as `.ts`, `.py`, `.json`, `.yml`, `.toml`, `.md` or `.txt`. Those files (for example `tokens.json` or `api-keys.md`) are uploaded with the secret values inside them redacted;
- secret values (API keys, passwords, bearer tokens, private keys, URL passwords) are replaced with `[REDACTED]`, and personal identifiers such as e-mail addresses with `[REDACTED_PII]`. Redaction works on patterns, so a secret that does not look like one (a short plain word, for example) is uploaded as written;
- the omnirush.ai backend applies the same rules again on its side.

The exact rules are in [docs/workspace-collector-privacy.md](docs/workspace-collector-privacy.md). What the updater contacts is described in [docs/updates.md](docs/updates.md).

## Updating

From version 1.0.5 on, the app updates itself: **Settings > Updates** or the **Check for Updates...** menu item. On macOS the unsigned build downloads the new DMG and opens it; drag omnirush.ai to Applications to replace the old copy. Windows and the Linux AppImage install updates in place. The Linux tar.gz does not update itself; download the new release by hand.

Installs older than 1.0.5 cannot update in-app. Download the latest release once by hand; later versions then update in-app.

## Features

| Feature | What you get | More |
| --- | --- | --- |
| Models and effort | Pick GPT 6 Astra or GPT-5.6 Sol and an effort level (low, high, xhigh, max) per chat. You can also add your own OpenAI, Anthropic, or other provider keys. | |
| Skills and MCP servers | Add skills and MCP servers from the Library in Settings; every model sees the same skills and tools. | [docs/skills-and-mcp.md](docs/skills-and-mcp.md) |
| Git workflows | The agent clones, branches, creates worktrees, commits, pushes, and opens and reviews pull requests with `gh`. Write commands ask once per session, destructive ones always ask. | [docs/git-workflows.md](docs/git-workflows.md) |
| Approvals | The composer's full-permissions toggle switches from asking to allowing every tool call. | [docs/approvals.md](docs/approvals.md) |

## Build from source

Requirements: Node.js 24, pnpm 11.4, and Bun 1.3.10 or newer.

```bash
pnpm install --frozen-lockfile
pnpm --filter @omnirush/desktop dev
```

Useful checks:

```bash
pnpm typecheck
pnpm --filter @omnirush/desktop test
```

Releases are built by the **Desktop Release** GitHub workflow when a `v*` tag is pushed (for example `git tag -a v1.0.9 -m "omnirush.ai v1.0.9" && git push origin v1.0.9`). See [docs/RELEASING.md](docs/RELEASING.md) and [docs/updates.md](docs/updates.md#publishing-a-release). Contribution guidelines are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Support

- Questions, bugs, and feature requests: [GitHub issues](https://github.com/omnirush-ai/omnirush-gui/issues).
- Everything else: [info@omnirush.ai](mailto:info@omnirush.ai).
- Security reports: e-mail info@omnirush.ai with the subject "security" instead of opening a public issue. See [SECURITY.md](SECURITY.md).

## License

The desktop app is available under the repository's [MIT terms](LICENSE). Code under `ee/` is governed by its own [license](ee/LICENSE).
