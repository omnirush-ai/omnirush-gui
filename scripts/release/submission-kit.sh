#!/usr/bin/env bash
# Microsoft Security Intelligence submission kit for a desktop release.
#
#   scripts/release/submission-kit.sh v3.0.0 [out-dir]
#
# Downloads the release's Windows installer (and every other omnirush-* asset
# plus SHA256SUMS.txt) with the GitHub CLI, checks them against SHA256SUMS.txt,
# prints each file's SHA-256, shows the Authenticode signer and timestamp of
# the installer when osslsigncode is installed, and writes SUBMISSION.md in
# the output directory: the exact form answers to paste into
# https://www.microsoft.com/en-us/wdsi/filesubmission. Submitting needs a
# Microsoft account and is done by hand; this script never uploads anything.
#
# Needs: gh (authenticated for omnirush-ai/omnirush-gui), sha256sum or
# shasum; optional: osslsigncode (apt install osslsigncode / brew install
# osslsigncode) to print the signature.
set -euo pipefail

tag="${1:?usage: submission-kit.sh <tag, e.g. v3.0.0> [out-dir]}"
out="${2:-omnirush-submission-$tag}"
repo="${OMNIRUSH_RELEASE_REPO:-omnirush-ai/omnirush-gui}"
version="${tag#v}"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

mkdir -p "$out"
echo "Downloading $repo $tag assets into $out ..."
gh release download "$tag" --repo "$repo" --dir "$out" --pattern 'omnirush-*' --pattern 'SHA256SUMS.txt' --clobber

cd "$out"
if [ -f SHA256SUMS.txt ]; then
  echo "== Checking against SHA256SUMS.txt"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --check --ignore-missing SHA256SUMS.txt
  else
    shasum -a 256 --check --ignore-missing SHA256SUMS.txt
  fi
else
  echo "warning: the release has no SHA256SUMS.txt" >&2
fi

echo "== SHA-256"
printf '%-64s  %s\n' "SHA-256" "file"
for f in omnirush-*; do
  [ -f "$f" ] || continue
  printf '%-64s  %s\n' "$(sha256 "$f")" "$f"
done

installer="$(ls omnirush-win-*.exe 2>/dev/null | grep -v '\.blockmap$' | head -n 1 || true)"
if [ -z "$installer" ]; then
  echo "No Windows installer (omnirush-win-*.exe) in $tag." >&2
  exit 1
fi
installer_sha="$(sha256 "$installer")"
installer_size="$(wc -c < "$installer" | tr -d ' ')"

signature="(osslsigncode not installed; on Windows run: signtool verify /pa /v $installer, or check Properties > Digital Signatures)"
if command -v osslsigncode >/dev/null 2>&1; then
  echo "== Authenticode signature of $installer"
  if signature="$(osslsigncode verify -in "$installer" 2>&1)"; then
    echo "$signature" | grep -E 'Subject:|Issuer:|Timestamp|Signature verification|Message digest' || echo "$signature"
  else
    echo "$signature"
    echo "warning: $installer does not verify as signed; do not submit an unsigned 3.x build." >&2
  fi
  signature="$(echo "$signature" | grep -E 'Subject:|Timestamp time|Signature verification' | head -n 4)"
fi

cat > SUBMISSION.md <<EOF
# Microsoft Security Intelligence submission: OmniRush.ai $tag

File to upload: \`$installer\` ($installer_size bytes)
SHA-256: \`$installer_sha\`
Download URL: https://github.com/$repo/releases/download/$tag/$installer
Signature:
\`\`\`
$signature
\`\`\`

## Steps (Sam, signed in with a Microsoft account)

1. Open https://www.microsoft.com/en-us/wdsi/filesubmission and sign in.
2. Choose **Software developer** ("I'm a software developer submitting my own software").
3. Product: **Microsoft Defender Antivirus (Windows 10/11)** for a Defender
   detection or a pre-release check. Use **Microsoft Defender SmartScreen**
   instead only if SmartScreen *blocks* the file (a red "blocked" or
   "unsafe" verdict), not for the grey "unrecognized app" prompt (see below).
4. Company name: OmniRush.ai. Contact e-mail: info@omnirush.ai.
5. Upload \`$installer\` as is (it is well under the upload limit; do not zip it).
6. "What do you believe this file is?": **Incorrectly detected as malware/malicious**
   (the developer option; there is no separate "pre-release" choice).
7. Detection name: the name Defender showed, for example from
   \`Get-MpThreatDetection\` or Windows Security > Protection history. For a
   proactive pre-release submission with no detection, write "None; pre-release
   submission of a new signed version".
8. Additional information (paste):

   > OmniRush.ai $version desktop app installer (Electron, NSIS, per-user install
   > to %LOCALAPPDATA%\\Programs). Signed by the publisher shown above with an
   > RFC 3161 timestamp; every bundled .exe/.dll/.node is signed by the same
   > publisher. The app bundles the open-source opencode engine
   > (resources\\sidecars\\opencode.exe) and does not download or run other
   > executables. Source: https://github.com/$repo . Release: https://github.com/$repo/releases/tag/$tag .
   > SHA-256 $installer_sha .

9. Submit and keep the submission ID. Results usually arrive by e-mail within
   a few days; a cleared file is fixed in the next Defender definition update
   (check with \`Update-MpSignature\` and a rescan).

## If a detection names a file inside the app

Unpack the installer (7-Zip opens it: \`\$PLUGINSDIR\\app-64.7z\`), find the
named file and submit it the same way, with its own SHA-256.

## SmartScreen "Windows protected your PC / unrecognized app"

This is reputation, not a detection. Microsoft does not clear it by
submission; it goes away as signed downloads of files carrying the same
signing identity accumulate without complaints. Things that help:

- Always sign with the same identity (Azure Trusted Signing keeps the
  publisher name stable across certificate renewals).
- Publish through the GitHub release URL only, so downloads concentrate on
  one file per version, and avoid re-uploading changed files under the same name.
- EV certificates no longer skip the reputation phase (Microsoft removed that
  in 2024); an EV or Trusted Signing identity still builds reputation faster
  than a new OV one.
- Until reputation builds, users click **More info > Run anyway**; the dialog
  shows the verified publisher name once the build is signed.
EOF

echo
echo "Wrote $out/SUBMISSION.md. Upload $installer (SHA-256 $installer_sha) at https://www.microsoft.com/en-us/wdsi/filesubmission"
