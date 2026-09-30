#!/usr/bin/env bash
# Verifies the packaged macOS app and DMG after electron-builder and
# scripts/notarize-dmg.mjs ran.
#
#   verify-macos-signing.sh <dist-electron dir> <signed: true|false>
#
# signed=true (Developer ID + notarization secrets were present): every Mach-O
# file in the bundle must carry a Developer ID signature from the app's team,
# the hardened runtime and a secure timestamp; codesign --deep --strict, spctl
# and stapler must accept the app, the DMG and the app inside the update zip.
#
# signed=false (no secrets, e.g. forks and PR CI): the Developer ID, Gatekeeper
# and notarization checks are skipped with a notice saying why, and only the
# ad-hoc signature's integrity is checked.
#
# Both: the bundled opencode sidecar must start under the hardened runtime
# with the entitlements it was signed with.
set -euo pipefail

dist="${1:?usage: verify-macos-signing.sh <dist-dir> <signed>}"
signed="${2:?usage: verify-macos-signing.sh <dist-dir> <signed>}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

app="$(find "$dist" -maxdepth 2 -type d -name '*.app' | head -n 1)"
if [ -z "$app" ]; then
  echo "No .app under $dist" >&2
  exit 1
fi
dmgs=()
while IFS= read -r -d '' f; do dmgs+=("$f"); done < <(find "$dist" -maxdepth 1 -type f -name '*.dmg' -print0)
zips=()
while IFS= read -r -d '' f; do zips+=("$f"); done < <(find "$dist" -maxdepth 1 -type f -name '*.zip' -print0)

echo "== codesign --verify --deep --strict $app"
codesign --verify --deep --strict --verbose=2 "$app"

machos=()
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q 'Mach-O'; then machos+=("$f"); fi
done < <(find "$app" -type f -print0)
echo "Mach-O files in the bundle: ${#machos[@]}"

sidecar="$app/Contents/Resources/sidecars/opencode"
echo "== opencode sidecar under the hardened runtime"
codesign --display --verbose=2 "$sidecar" 2>&1 | grep -E '^(Authority|TeamIdentifier|CodeDirectory|Timestamp|flags)|runtime' || true
codesign --display --entitlements - --xml "$sidecar" 2>/dev/null | plutil -p - 2>/dev/null || true
"$sidecar" --version

if [ "$signed" != "true" ]; then
  msg="Skipped Developer ID, notarization and Gatekeeper checks: no macOS signing secrets (MAC_CSC_LINK, MAC_CSC_KEY_PASSWORD, APPLE_API_KEY*), so this build is ad-hoc signed. The ad-hoc signature verified and the sidecar runs."
  echo "::notice title=macOS signing verification skipped::$msg"
  echo "### macOS signing: skipped" >> "$summary"
  echo "$msg" >> "$summary"
  exit 0
fi

team="$(codesign --display --verbose=2 "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
echo "== every Mach-O is signed by team $team with the hardened runtime and a timestamp"
failures=0
for f in "${machos[@]}"; do
  info="$(codesign --display --verbose=2 "$f" 2>&1 || true)"
  problems=()
  grep -q '^Authority=Developer ID Application' <<<"$info" || problems+=("not Developer ID signed")
  grep -q "^TeamIdentifier=$team\$" <<<"$info" || problems+=("team is not $team")
  grep -Eq 'flags=.*runtime' <<<"$info" || problems+=("no hardened runtime")
  grep -q '^Timestamp=' <<<"$info" || problems+=("no secure timestamp")
  if [ ${#problems[@]} -gt 0 ]; then
    echo "FAIL ${f#"$app"/}: ${problems[*]}"
    failures=$((failures + 1))
  fi
done
if [ "$failures" -gt 0 ]; then
  echo "$failures Mach-O file(s) are not signed as notarization requires." >&2
  exit 1
fi

echo "== Gatekeeper (spctl) and notarization tickets (stapler)"
spctl -a -vvv -t exec "$app"
xcrun stapler validate "$app"
for dmg in "${dmgs[@]}"; do
  spctl -a -vvv -t open --context context:primary-signature "$dmg"
  # The install policy is meant for .pkg files; report its verdict on the DMG too.
  spctl -a -vvv -t install "$dmg" || echo "::notice::spctl -t install does not assess DMGs on this macOS; the open/primary-signature assessment above passed."
  xcrun stapler validate "$dmg"
done
for zip in "${zips[@]}"; do
  tmp="$(mktemp -d)"
  ditto -x -k "$zip" "$tmp"
  zipped_app="$(find "$tmp" -maxdepth 1 -type d -name '*.app' | head -n 1)"
  codesign --verify --deep --strict "$zipped_app"
  xcrun stapler validate "$zipped_app"
  rm -rf "$tmp"
done

{
  echo "### macOS signing: verified"
  echo "- ${#machos[@]} Mach-O files: Developer ID (team $team), hardened runtime, timestamped"
  echo "- spctl accepted the app and ${#dmgs[@]} DMG(s); stapled tickets validate on the app, DMG(s) and zipped app(s)"
} >> "$summary"
