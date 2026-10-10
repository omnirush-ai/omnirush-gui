<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./omnirush-logo-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="./omnirush-logo.png" />
    <img src="./omnirush-logo.png" alt="omnirush.ai" width="120" height="120" />
  </picture>

  <h1>omnirush.ai</h1>

  <p><strong>A desktop coding agent with free access to frontier models.</strong></p>

  <p>
    <a href="https://omnirush.ai"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fomnirush.ai%2Fomnirush%2Fpublic%2Fusers-badge&style=for-the-badge&logo=rocket&logoColor=white" alt="Users" /></a>
    <a href="https://github.com/omnirush-ai/omnirush-gui/releases"><img src="https://img.shields.io/github/downloads/omnirush-ai/omnirush-gui/total?style=for-the-badge&color=blue&label=downloads" alt="Downloads" /></a>
    <a href="https://github.com/omnirush-ai/omnirush-gui"><img src="https://visitor-badge.laobi.icu/badge?page_id=omnirush-ai.omnirush-gui&left_text=views&left_color=%23555&right_color=%23f97316" height="28" alt="Views" /></a>
  </p>
  <p>
    <a href="https://github.com/omnirush-ai/omnirush-gui/releases/latest"><img src="https://img.shields.io/github/v/release/omnirush-ai/omnirush-gui?label=latest&color=f97316" alt="Latest release" /></a>
    <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-black?logo=apple" alt="macOS" />
    <img src="https://img.shields.io/badge/Linux-x64%20%7C%20arm64-FCC624?logo=linux&logoColor=black" alt="Linux" />
    <a href="https://github.com/omnirush-ai/omnirush-gui/stargazers"><img src="https://img.shields.io/github/stars/omnirush-ai/omnirush-gui?style=social" alt="Stars" /></a>
  </p>

  <p>
    <a href="https://omnirush.ai/download/mac"><img src="https://img.shields.io/badge/Download%20for%20macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" /></a>
    <a href="https://omnirush.ai/download/linux-appimage"><img src="https://img.shields.io/badge/Download%20for%20Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download for Linux" /></a>
  </p>

  <p><a href="https://omnirush.ai">Website</a> · <a href="https://github.com/omnirush-ai/omnirush-gui/releases">Releases</a> · <a href="https://www.npmjs.com/package/omnirush">CLI</a></p>
</div>

---

omnirush.ai is a desktop app for working with a coding agent on your own
projects. GPT 6 Astra is the default model; GPT 6.1 Sol and the other models in
your account's catalog are available from the model picker.

## Download

Download the latest build from the
[releases page](https://github.com/omnirush-ai/omnirush-gui/releases/latest).
File names include the version, for example `omnirush-mac-arm64-3.0.1.dmg`.

| Platform | File |
| --- | --- |
| macOS, Apple Silicon | `omnirush-mac-arm64-<version>.dmg` (a `.zip` is also attached) |
| Linux x64, Debian/Ubuntu | `omnirush-linux-amd64-<version>.deb` |
| Linux x64, Arch | `omnirush-linux-x64-<version>.pacman` |
| Linux x64, Fedora/RHEL | `omnirush-linux-x86_64-<version>.rpm` |
| Linux x64, other | `omnirush-linux-x86_64-<version>.AppImage` or `omnirush-linux-x64-<version>.tar.gz` |
| Linux arm64, Debian/Ubuntu | `omnirush-linux-arm64-<version>.deb` |
| Linux arm64, Arch | `omnirush-linux-aarch64-<version>.pacman` |
| Linux arm64, Fedora/RHEL | `omnirush-linux-aarch64-<version>.rpm` |
| Linux arm64, other | `omnirush-linux-arm64-<version>.AppImage` or `omnirush-linux-arm64-<version>.tar.gz` |

Each release includes `SHA256SUMS.txt` for verifying downloads. There is no
build for Intel Macs.

## First launch

**macOS.** Builds are not notarized yet. On first open, macOS reports that it
could not verify the app: click **Done**, open **System Settings > Privacy &
Security**, click **Open Anyway** next to omnirush, then **Open**.
Alternatively, run:

```bash
xattr -dr com.apple.quarantine /Applications/omnirush.app
```

When asked to use "omnirush.ai Safe Storage", enter your login password and
choose **Always Allow**. This keychain item only holds the key that encrypts
your sign-in on this Mac.

**Linux.** The `.deb`, `.rpm` and `.pacman` packages install their dependencies. For
the AppImage or tar.gz, install the GTK runtime first:

```bash
sudo apt install libgtk-3-0 libnss3 libatk-bridge2.0-0 libasound2   # libasound2t64 on Ubuntu 24.04
```

Then `chmod +x` the AppImage or unpack the tarball. An error about
`libatk-1.0.so.0` means these packages are missing.

On Linux the app stores your sign-in in the system keyring when one is
available (gnome-keyring, KeePassXC with Secret Service, or KWallet). Without
one, as is common on tiling window managers, it falls back to an owner-only
file in the app's data folder, and **Settings** says so. To choose a store
explicitly, start the app with `--password-store=gnome-libsecret`, `kwallet5`
or `kwallet6`.

## Sign in

Click **Sign in to omnirush.ai** in the sidebar or on the Settings page. Your
browser opens [omnirush.ai/console](https://omnirush.ai/console) with a device
code; approve it and the app is ready. The app does not run prompts until an
account is connected.

## Features

| Feature | Description | Docs |
| --- | --- | --- |
| Models and effort | Choose a model and an effort level (low, high, xhigh, max) per chat. You can also add your own OpenAI, Anthropic or other provider keys. | |
| Skills and MCP servers | Add skills and MCP servers from the Library in Settings. Every model sees the same skills and tools. | [skills-and-mcp.md](docs/skills-and-mcp.md) |
| Git workflows | The agent clones, branches, creates worktrees, commits, pushes, and opens and reviews pull requests with `gh`. Write commands ask once per session; destructive ones always ask. | [git-workflows.md](docs/git-workflows.md) |
| Approvals | The composer's full-permissions toggle switches between asking and allowing every tool call. | [approvals.md](docs/approvals.md) |

## Updating

The app updates itself on macOS and Linux: use **Settings > Updates** or the
**Check for Updates...** menu item.

- **macOS:** the app downloads the new DMG and opens it; drag the app to
  Applications to replace the old copy.
- **Linux:** the AppImage, `.deb`, `.rpm` and `.pacman` installs update in place. The
  tar.gz does not update itself; download new releases manually.

Installs older than 1.0.5 cannot update in-app; download the latest release
once manually. See [docs/updates.md](docs/updates.md) for what the updater
contacts.

## Development

Requirements: Node.js 24, pnpm 11.4 and Bun 1.3.10 or newer.

```bash
pnpm install --frozen-lockfile
pnpm --filter @omnirush/desktop dev      # run the desktop app
pnpm typecheck                           # type-check the app
pnpm --filter @omnirush/desktop test     # desktop tests
```

Releases are built by the **Desktop Release** workflow when a `v*` tag is
pushed. See [docs/RELEASING.md](docs/RELEASING.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).

## Support

- Bugs and feature requests:
  [GitHub issues](https://github.com/omnirush-ai/omnirush-gui/issues)
- Everything else: [info@omnirush.ai](mailto:info@omnirush.ai)
- Security reports: e-mail info@omnirush.ai with the subject "security"
  instead of opening a public issue. See [SECURITY.md](SECURITY.md).

## License

The desktop app is available under the repository's [MIT terms](LICENSE).
Code under `ee/` is governed by its own [license](ee/LICENSE). Third-party
components keep the licenses provided by their owners.
