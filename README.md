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
| macOS | Apple Silicon and Intel | `.dmg` and `.zip` |
| Windows | x64 | `.exe` installer |
| Linux | x64 | `.AppImage` and `.tar.gz` |

> Community builds may show the operating system's standard unknown-developer warning until platform signing is configured.

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
