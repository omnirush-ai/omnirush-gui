<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./omnirush-logo-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="./omnirush-logo.png" />
    <img src="./omnirush-logo.png" alt="OmniRush.ai" width="128" height="128" />
  </picture>
  <h1>OmniRush.ai</h1>
  <p>A fast, local-first desktop workspace for getting real work done with AI agents.</p>
</div>

## Download

Installers are published on the [latest release page](https://github.com/omnirush-ai/omnirush-gui/releases/latest).

| Platform | Supported builds | Download format |
| --- | --- | --- |
| macOS | Apple Silicon | `.dmg` and `.zip` |
| Windows | x64 | `.exe` installer |
| Linux | x64 | `.deb`, `.AppImage` and `.tar.gz` |

Builds are not notarized or Windows-signed yet, so the first launch needs one confirmation:

- **macOS 15 and later**: the first open shows "Apple could not verify OmniRush.ai.app is free of malware" with only a Done button. Click Done, open System Settings > Privacy & Security, scroll to Security and click **Open Anyway** next to OmniRush.ai.app, then Open. Alternatively, in Terminal: `xattr -dr com.apple.quarantine /Applications/OmniRush.ai.app`.
- **macOS keychain**: when the app asks to use "omnirush.ai Safe Storage" in your keychain, enter your Mac login password and choose Always Allow. That item only holds the key that encrypts your own omnirush.ai sign-in on this Mac; it is asked again when the app binary changes.
- **Windows**: on the SmartScreen dialog choose More info > Run anyway. If setup reports "Extract: error writing to file", the download is incomplete or blocked: download again, compare the hash with `SHA256SUMS.txt`, free disk space, and retry.
- **Linux**: install the `.deb` on Debian/Ubuntu (it pulls in the GTK runtime automatically). The AppImage and tar.gz need that runtime installed first: `sudo apt install libgtk-3-0 libnss3 libatk-bridge2.0-0 libasound2` (Ubuntu 24.04: `libasound2t64`), then `chmod +x` the AppImage or unpack the tar.gz. A missing `libatk-1.0.so.0` means those packages are absent.
- **Updates**: the app checks GitHub releases for new versions; see [docs/updates.md](docs/updates.md) for how checks work and why unsigned macOS builds open the installer instead of updating in place.

## What it does

- Works with files and projects on your computer.
- Includes access to OmniRush's internal model gateway and curated connections for ChatGPT/OpenAI, Anthropic, Google Gemini, and OpenRouter.
- Runs agent tools, browser workflows, reusable skills, and scheduled automations.
- Keeps local desktop work on your device unless you explicitly connect an external service.
- Supports macOS, Windows, and Linux from one codebase.

## Development

Requirements: Node.js 24, pnpm 11.4, and Bun 1.3.10 or newer.

```bash
pnpm install --frozen-lockfile
pnpm dev:electron
```

Useful checks:

```bash
pnpm typecheck
pnpm --filter @omnirush/desktop test:core
pnpm build:ui
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidance and [docs/RELEASING.md](./docs/RELEASING.md) for the release process.

## Security

Please report security issues privately using the instructions in [SECURITY.md](./SECURITY.md).

## License

The desktop application is available under the repository's [MIT terms](./LICENSE). Code under `ee/` is governed by its accompanying enterprise license.
