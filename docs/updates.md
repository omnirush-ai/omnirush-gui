# Desktop updates

How the omnirush.ai desktop app finds, downloads, and installs new versions, and what a release must contain for that to work.

## How a check works

The Updates page (Settings > Updates) and the "Check for Updates..." menu item call the Electron main process (`apps/desktop/electron/updater.mjs`), which drives [electron-updater](https://www.electron.build/auto-update) with the generic provider:

1. The updater fetches the update manifest for this platform from the feed directory (below) and compares its `version` with the installed version.
2. "Download" fetches the file the manifest lists for the running platform and architecture and verifies its `sha512` against the manifest.
3. "Install" applies it. On Windows (NSIS) and Linux (AppImage) the installer runs in place; on macOS the behaviour depends on the app's code signature (see below).

With "Check automatically" enabled the page checks every 15 minutes while the app is focused; "Download automatically" downloads as soon as an update is found. On a public install the check contacts only `github.com`: omnirush.ai has no hosted Den control plane, so no organization release inventory or policy is consulted unless a Den base URL was configured explicitly (`desktop-bootstrap.json`, a connect link, or Settings > Advanced).

Failures are shown verbatim on the page, minus the `Error invoking remote method '...':` prefix Electron adds to IPC failures.

## Feed URLs

| Channel | Feed directory | Manifest read by the app |
| --- | --- | --- |
| Stable (the only public channel) | `https://github.com/omnirush-ai/omnirush-gui/releases/latest/download` | `latest-mac.yml`, `latest.yml` (Windows), `latest-linux.yml` |
| Targeted recovery/rollback | `https://github.com/omnirush-ai/omnirush-gui/releases/download/v<version>` | same names |

There is no public Alpha feed. A persisted or requested "alpha" channel is normalized back to "stable" and the channel selector stays hidden. A custom distribution can enable an Alpha channel by shipping an https feed directory in its electron-builder `extraMetadata` as `omnirushAlphaUpdateFeedUrl` (development runs may set `OMNIRUSH_DESKTOP_ALPHA_UPDATE_FEED_URL`); the Cloud and Enterprise flavors keep their parallel `cloud*.yml` / `enterprise*.yml` manifests on the stable feed.

## What a release must contain

For each platform the release needs the installers **and** the electron-builder update manifest next to them, all uploaded to the same GitHub release:

| Platform | Installers | Manifest |
| --- | --- | --- |
| macOS Apple Silicon | `omnirush-mac-arm64-<version>.zip` (+`.blockmap`), `omnirush-mac-arm64-<version>.dmg` (+`.blockmap`) | `latest-mac.yml` |
| Windows x64 | `omnirush-win-x64-<version>.exe` (+`.blockmap`) | `latest.yml` |
| Linux x64 | `omnirush-linux-x86_64-<version>.AppImage`, `omnirush-linux-x64-<version>.tar.gz` | `latest-linux.yml` |

The manifest is the file electron-updater reads; a release without it makes every installed app report a 404 when checking for updates (this is what happened to v1.0.2 through v1.0.4). electron-builder writes the manifest into `apps/desktop/dist-electron/` whenever a `publish` block is configured, even with `--publish never`; the release workflow verifies it with `apps/desktop/scripts/verify-update-manifest.mjs` (version, listed files, sizes, sha512 checksums, and the required installer types) and fails the job if it is missing or inconsistent, then uploads it together with the installers.

To check a local package:

```bash
pnpm --filter @omnirush/desktop package:electron
node apps/desktop/scripts/verify-update-manifest.mjs --manifest apps/desktop/dist-electron/latest-mac.yml
```

## macOS: why the DMG opens instead of an in-place install

Squirrel.Mac, which electron-updater uses to swap the app bundle on macOS, only installs an update whose code signature validates against the running app. Community builds are ad-hoc signed (no Apple Developer ID; see `apps/desktop/scripts/electron-after-sign.cjs`), so that validation always fails and an in-place install would silently do nothing.

The app therefore checks its own signature once at startup (`codesign -dv --verbose=2` on the bundle). When the bundle is not Developer ID signed the Updates page reports install mode `manual-dmg`:

- "Download" fetches `omnirush-mac-arm64-<version>.dmg` from the same feed directory and verifies the `sha512` listed in `latest-mac.yml`.
- "Open installer" opens the verified DMG, shows "Installer opened. Drag omnirush.ai to Applications, replace the old copy, then reopen it." and quits the app after a short delay.

Once releases are signed with a Developer ID (and notarized), the same code path detects the signature and uses the normal Squirrel in-place install and restart. Windows and Linux installs are in place regardless of signing.

## Publishing a release

Releases are built by the **Desktop Release** workflow (`.github/workflows/release-desktop.yml`) from a semantic-version tag:

```bash
git tag -a v1.0.5 -m "OmniRush.ai v1.0.5"
git push origin v1.0.5
```

The workflow creates a draft release, stamps the version into the package manifests, builds each platform, verifies and uploads the installers and update manifests, generates `SHA256SUMS.txt`, and publishes the release as the latest one. Installed apps pick it up on their next check. See `docs/RELEASING.md` for rebuilding an existing tag and local packaging.
