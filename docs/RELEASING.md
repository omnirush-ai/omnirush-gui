# Releasing OmniRush.ai

Desktop releases are built by GitHub Actions for macOS, Windows, and Linux. A semantic-version tag is the release source of truth; committed package versions remain `0.0.0-dev` and are stamped only inside the build jobs.

## Publish a release

1. Make sure `main` is clean, pushed, and passing its required checks.
2. Create and push a semantic-version tag:

   ```bash
   git tag -a v1.0.0 -m "OmniRush.ai v1.0.0"
   git push origin v1.0.0
   ```

3. Watch the **Desktop Release** workflow. It creates a draft release, builds each platform independently, uploads the installers, generates `SHA256SUMS.txt`, and publishes only after every build succeeds.

The workflow publishes:

- macOS Apple Silicon: DMG and ZIP
- macOS Intel: DMG and ZIP
- Windows x64: NSIS EXE installer
- Linux x64: AppImage and compressed tarball

## Rebuild an existing tag

Run **Desktop Release** manually in GitHub Actions and provide the existing tag. Assets are replaced by filename, allowing a failed build to be repaired without creating another release.

## Local packaging

Build on the target operating system when possible:

```bash
pnpm install --frozen-lockfile
node scripts/release/stamp-version.mjs --version 1.0.0
pnpm --filter @omnirush/desktop build:electron
pnpm --dir apps/desktop exec electron-builder --config electron-builder.yml --publish never
```

Local version stamping changes package manifests temporarily. Restore those files before committing; release versions belong to tags, not source files.

## Signing

The public workflow produces community builds without requiring private signing credentials. Configure Apple notarization and Windows code signing before presenting installers as verified publisher builds.
