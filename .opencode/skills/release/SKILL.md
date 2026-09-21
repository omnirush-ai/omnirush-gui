---
name: release
description: Cut, rebuild, or verify an OmniRush.ai desktop release for macOS, Windows, and Linux.
---

# OmniRush.ai desktop releases

The `Desktop Release` workflow builds download-ready macOS, Windows, and Linux applications from a semantic-version tag. Versions live in tags; package files keep their development placeholders.

## Cut a release

```bash
pnpm release:cut
pnpm release:cut minor
pnpm release:cut --version 1.0.0
pnpm release:cut:watch
```

The command requires a clean, fully pushed `main` branch. It creates an annotated tag and pushes only that tag. The workflow creates a draft GitHub release, uploads every installer, generates checksums, and publishes only when all platform builds pass.

## Rebuild an existing release

```bash
gh workflow run "Desktop Release" --repo omnirush-ai/omnirush-gui -f tag=vX.Y.Z
```

## Verify

```bash
gh run list --repo omnirush-ai/omnirush-gui --workflow "Desktop Release" --limit 3
gh release view vX.Y.Z --repo omnirush-ai/omnirush-gui --json isDraft,assets
```

Expected downloads include macOS ARM64 and x64 DMGs, a Windows x64 installer, Linux x64 AppImage and tarball builds, plus `SHA256SUMS.txt`.

See `docs/RELEASING.md` for the complete maintainer flow.
