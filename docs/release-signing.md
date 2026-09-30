# Release signing, notarization and AV hygiene

From 3.0.0 on, macOS builds are Developer ID signed and notarized, and Windows builds are Authenticode signed, so Gatekeeper, SmartScreen and Defender treat them as coming from a known publisher. Everything is driven by GitHub Actions secrets. No certificate, key or password is committed or printed in a log.

- `.github/workflows/release-desktop.yml` (tag `v*`) signs, verifies, scans and publishes.
- `.github/workflows/build-electron-desktop.yml` (manual dispatch) runs the same steps and uploads workflow artifacts. It never publishes.
- `apps/desktop/scripts/signing-plan.mjs` decides, for each platform, between signed and unsigned based on which secrets are set. It prints the secret names that are set, never their values.

## Without secrets (forks, PR CI, local builds)

Builds stay unsigned, as before 3.0.0: the macOS app is ad-hoc signed and not notarized, and nothing on Windows is signed. The verify steps still run. They report "skipped" with the reason in the log and the job summary, and the job passes.

A partial set of secrets is an error, because it means a secret is missing. For example, a Developer ID certificate without notarization credentials would produce an app that Gatekeeper rejects anyway.

The release workflow runs `signing-plan.mjs --enforce`. For a tag whose major version is 3 or higher, it fails when macOS or Windows would be unsigned. It does this twice:

- in the `prepare` job, before the draft release is created;
- in each build job.

So a 3.x release is never published unsigned by accident. Tags below 3.0.0 still build unsigned.

## GitHub secrets

Add these under **Settings > Secrets and variables > Actions > Repository secrets** of `omnirush-ai/omnirush-gui`.

### macOS (Apple Developer Program, organization or individual team, 99 USD/year)

| Secret | Value | Where it comes from |
| --- | --- | --- |
| `MAC_CSC_LINK` | base64 of a `.p12` holding the **Developer ID Application** certificate and its private key (`base64 -i cert.p12 \| pbcopy`) | Only the Account Holder can create it. Go to developer.apple.com > Certificates > + > Developer ID Application (G2 Sub-CA) and upload a CSR made in Keychain Access. Install the downloaded certificate, then in Keychain Access > My Certificates export the certificate together with its key as `.p12`, with a password. |
| `MAC_CSC_KEY_PASSWORD` | the password of that `.p12` | Set by you when exporting. |
| `APPLE_API_KEY` | the text of `AuthKey_<KEYID>.p8`, or its base64 | App Store Connect > Users and Access > Integrations > App Store Connect API > Team Keys > + (access: Developer). The key can be downloaded only once. |
| `APPLE_API_KEY_ID` | the 10-character key ID | The same page, "Key ID" column. |
| `APPLE_API_ISSUER` | the issuer UUID | The same page, "Issuer ID" above the table. |

Instead of the three `APPLE_API_*` secrets you can use an Apple ID:

| Secret | Value |
| --- | --- |
| `APPLE_ID` | the Apple ID e-mail |
| `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password from appleid.apple.com > Sign-In and Security |
| `APPLE_TEAM_ID` | the 10-character Team ID (developer.apple.com > Membership) |

The API key is preferred: it is not tied to a person and has no 2FA prompts.

### Windows: Azure Trusted Signing (recommended)

Azure Trusted Signing (being renamed Azure Artifact Signing) is a Microsoft-managed signing service. The Basic tier is about 10 USD/month. The certificate chains to Microsoft's own roots, and the publisher name stays the same across Microsoft's short-lived certificate renewals, so SmartScreen reputation carries over from release to release.

Eligibility is limited. Public trust (identity validation):

- organizations: must be registered in the USA, Canada, the EU or the UK, with a verifiable history of three years or more;
- individual developers: USA and Canada only (as of 2026).

Check the current list before relying on it. If omnirush.ai does not qualify, use the PFX route below with a certificate vendor.

| Secret | Value | Where it comes from |
| --- | --- | --- |
| `AZURE_TENANT_ID` | Microsoft Entra tenant ID | Azure portal > Microsoft Entra ID > Overview. |
| `AZURE_CLIENT_ID` | app registration (service principal) client ID | Entra ID > App registrations > New registration. Then, on the Trusted Signing account > Access control (IAM), give it the role **Trusted Signing Certificate Profile Signer**. |
| `AZURE_CLIENT_SECRET` | a client secret of that app registration | App registration > Certificates & secrets > New client secret. It expires, so note the renewal date. |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | the account's regional endpoint, for example `https://eus.codesigning.azure.net/` | Trusted Signing account > Overview > Account URI. |
| `AZURE_TRUSTED_SIGNING_ACCOUNT` | the Trusted Signing account name | The name you created it with. |
| `AZURE_TRUSTED_SIGNING_PROFILE` | the certificate profile name (type **Public Trust**) | Trusted Signing account > Certificate profiles, created after identity validation completes. |
| `WIN_PUBLISHER_NAME` | the exact subject CN of the certificate profile, i.e. the validated legal name (for example `OmniRush Technologies Ltd`) | Certificate profile > the "CN=" of its subject. electron-updater compares it with the signer of every update installer, so it must match exactly and must never change. |

### Windows: a PFX from a certificate vendor (alternative)

| Secret | Value |
| --- | --- |
| `WIN_CSC_LINK` | base64 of a `.pfx` holding an OV or EV code-signing certificate and its key |
| `WIN_CSC_KEY_PASSWORD` | its password |
| `WIN_PUBLISHER_NAME` | optional. When empty, the certificate's CN is used. |

Since June 2023, CAs issue code-signing keys only on hardware tokens or cloud HSMs, so a new certificate cannot normally be exported as a `.pfx`. This route is for an existing exportable certificate. A cloud-HSM certificate (DigiCert KeyLocker, SSL.com eSigner, Certum SimplySign) would need a custom `win.signtoolOptions.sign` hook calling the vendor's tool. That hook is not written yet.

When both the Azure and the PFX secrets are complete, Azure Trusted Signing is used.

Timestamps: signtool uses `http://timestamp.digicert.com` (RFC 3161, SHA-256), and Trusted Signing uses `http://timestamp.acs.microsoft.com`. Signatures therefore stay valid after the certificate expires.

## What is signed

### macOS

electron-builder (`@electron/osx-sign`) signs every Mach-O file in the bundle, then the bundle itself. It uses the same Developer ID, the hardened runtime and a secure timestamp. This covers:

- the Electron framework and helpers;
- the opencode engine sidecar (`Contents/Resources/sidecars/opencode*`);
- node-pty's `spawn-helper` and `pty.node`, and `better-sqlite3.node` (in `app.asar.unpacked`);
- the Computer Use helper app (`Contents/Resources/helpers/`).

Bun itself is not shipped. The opencode binary is compiled with Bun and signed like any other executable.

`scripts/electron-after-sign.cjs` then notarizes the app with `notarytool --wait` and staples the ticket to the `.app`, before the update zip is made. `scripts/notarize-dmg.mjs` then does three things:

1. notarizes the DMG;
2. staples its ticket;
3. rewrites the DMG's `sha512` and size in `latest-mac.yml` and rebuilds its `.blockmap`, because stapling changes the file.

### macOS entitlements

There are two files. Keep them minimal.

`apps/desktop/build/entitlements.mac.plist` applies to the main executable only:

| Entitlement | Why |
| --- | --- |
| `com.apple.security.cs.allow-jit` | V8 in the main process, and in `ELECTRON_RUN_AS_NODE` children of the same binary such as the bundled UI-control MCP, writes JIT code to `MAP_JIT` memory. |
| `com.apple.security.device.audio-input` | Voice input records from the microphone when the user allows it. The hardened runtime blocks audio input without this entitlement. `NSMicrophoneUsageDescription` is set in `electron-builder.base.yml`. |

The main executable does not get `disable-library-validation`: every framework and addon it loads is signed by the same team.

`apps/desktop/build/entitlements.mac.inherit.plist` applies to the Electron helpers, the opencode sidecar, spawn-helper and the Computer Use helper:

| Entitlement | Why |
| --- | --- |
| `com.apple.security.cs.allow-jit` | V8 in the renderer and utility helpers, and JavaScriptCore in the Bun-compiled sidecar. |
| `com.apple.security.cs.allow-unsigned-executable-memory` | The Bun runtime in the sidecar maps writable and executable memory outside `MAP_JIT`. Bun's own documentation lists this entitlement for signed `bun build --compile` executables. |
| `com.apple.security.cs.disable-library-validation` | The sidecar unpacks the native addons embedded in its Bun executable to a temporary directory and `dlopen()`s them. Those files carry their upstream signature, not our Team ID. |
| `com.apple.security.device.audio-input` | Chromium records audio in its audio service, which runs in an Electron helper process. |

These entitlements are not granted: `allow-dyld-environment-variables`, `disable-executable-page-protection`, camera, and Apple Events or automation.

An unsigned build is ad-hoc signed with the inherit set. Ad-hoc code has no Team ID, so library validation has to be off for it to load its own frameworks.

### Windows

electron-builder signs, with SHA-256 and a timestamp:

- `OmniRush.ai.exe`;
- the NSIS installer and its uninstaller;
- `elevate.exe`;
- every `.exe` copied as an extra resource: the opencode sidecar, both `opencode.exe` and `opencode-x86_64-pc-windows-msvc.exe`;
- every `.exe`, `.dll` and `.node` in the app root and in `app.asar.unpacked`: the Electron DLLs, node-pty's `conpty.dll`, `OpenConsole.exe`, `winpty-agent.exe` and `pty.node`, and `better_sqlite3.node`. This is set by `win.signExts: [.dll, .node]`.

The version-info resources read:

| Field | Value |
| --- | --- |
| CompanyName | OmniRush.ai (package.json `author`) |
| ProductName | OmniRush.ai |
| FileDescription | OmniRush.ai |
| LegalCopyright | Copyright © OmniRush.ai |

The opencode sidecar keeps the version info that its upstream Bun build gives it. Editing the resources of a Bun-compiled executable could break the payload it carries.

The installer is a one-click, per-user NSIS installer. It installs to `%LOCALAPPDATA%\Programs\OmniRush.ai`, needs no elevation, and `build/installer.nsh` only removes the organization shortcut on uninstall. The `appId` is `ai.omnirush.desktop` in every flavor. The publisher name comes from `WIN_PUBLISHER_NAME`, or from the certificate's CN, and is written into `app-update.yml`, so `verifyUpdateCodeSignature` checks each update installer against it.

## Verification in CI

- **macOS** (`scripts/verify-macos-signing.sh`)
  - `codesign --verify --deep --strict` on the app.
  - The opencode sidecar must start (`--version`) under the hardened runtime with its entitlements. This check runs for unsigned builds too.
  - When signed:
    - every Mach-O file must carry `Authority=Developer ID Application` from the app's team, the `runtime` flag and a `Timestamp`;
    - `spctl -a -vvv -t exec` on the app;
    - `spctl -a -vvv -t open --context context:primary-signature` on the DMG (`spctl -t install` is also run and reported; that policy is meant for `.pkg` files);
    - `xcrun stapler validate` on the app, the DMG and the app inside the update zip.
- **Windows** (`scripts/verify-windows-signing.ps1`)
  - The version info of the app exe and the installer must name OmniRush.ai.
  - When signed:
    - `signtool verify /pa /v` on the installer, the app exe and the sidecar, and `/pa` on every `.exe`/`.dll`/`.node` in `win-unpacked`, each with a timestamp;
    - a silent per-user install, then verification of the installed exe and the uninstaller, then an uninstall.
- **Defender** (`scripts/defender-scan.ps1`): `Update-MpSignature`, then `Start-MpScan -ScanType CustomScan` and `MpCmdRun -Scan -ScanType 3 -DisableRemediation` on the installer and on `win-unpacked`. Detections recorded since the scan began are listed, and the job fails on any of them.
- **Windows signing rehearsal** (build workflow only): signs a full build with a self-signed certificate made on the runner, trusted only on that runner. It then runs the same verification, checks that the signed sidecar still starts, and runs the Defender scan. This exercises the signing path without any real secret.

## AV and reputation hygiene (audit for 3.0.0)

- **PowerShell in shipped code.**
  - The Windows shortcut repair (`apps/desktop/electron/main.mjs`) used `-ExecutionPolicy Bypass` with a base64 payload spliced into a hidden command. It now runs a fixed command, and the values are passed through environment variables.
  - The remaining PowerShell uses are:
    - `system-ca.mjs`, which reads the Windows certificate stores (no Bypass, no encoded command, no download);
    - the user's own terminal tabs.
  - There are no `IEX`/`Invoke-Expression`, `DownloadString`, `Net.WebClient`, `-EncodedCommand` or `-WindowStyle Hidden` anywhere in the app or the installer.
  - `-ExecutionPolicy Bypass` and `-EncodedCommand` appear only in dev and support scripts that are not shipped (`scripts/support`, `apps/server/scripts/atomic-write-windows-check.ts`, `.opencode/skills`).
  - `docs/support/enterprise-network-doctor.md` tells users to paste an `Invoke-WebRequest` + Bypass one-liner. That is documentation, not shipped code, but it should become a signed downloadable script.
- **Runtime downloads.**
  - The opencode sidecar is fetched at build time from the npm registry and checked against the registry's sha512 integrity. At runtime the app uses only the bundled copy.
  - The engine's self-update is now disabled (`OPENCODE_DISABLE_AUTOUPDATE=1`).
  - Two opt-in paths still fetch code at runtime:
    - the experimental engine 2.x preview (`apps/server/src/opencode-v2-binary.ts`: an npm tarball pinned by sha512, cached and executed only when the user turns the preview on);
    - opencode plugins that a user adds to their own opencode config by npm name, which the engine installs.
  - The guided `npm install -g` engine install is user-initiated and disabled on Windows.
- **Updates.** electron-updater downloads from the GitHub release and checks the manifest's sha512. On Windows it also checks the installer's publisher once the app is signed. On macOS, Squirrel checks the code signature against the running app.
  - A 2.x app is ad-hoc signed, so it installs 3.0.0 through the manual DMG path.
  - From 3.0.0 on, macOS updates install in place, since `updater.mjs` detects the Developer ID.

## Microsoft submission kit

Run `scripts/release/submission-kit.sh v3.0.0`. It:

- downloads the release assets and checks them against `SHA256SUMS.txt`;
- prints every SHA-256;
- shows the installer's Authenticode signer, if `osslsigncode` is installed;
- writes `SUBMISSION.md` with the exact answers for https://www.microsoft.com/en-us/wdsi/filesubmission and what to do about SmartScreen's "unrecognized app" prompt.

Submitting needs a Microsoft account and is done by hand.
