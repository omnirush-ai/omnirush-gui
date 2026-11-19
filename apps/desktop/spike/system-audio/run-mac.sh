#!/bin/bash
# macOS check. Builds M0Audio.app from stock Electron 43.2.0 (ad hoc signed, hardened runtime,
# the app's own entitlements), plays a fixture through the speakers and records "Them".
# Usage (in ~/m0audio on the Mac, with main.cjs/page.html/package.json/entitlements.mac.plist/them.wav):
#   ./run-mac.sh <catap|sck|screen> <seconds> [nokey]
# "nokey" drops NSAudioCaptureUsageDescription (Electron's default Info.plist ships one; we delete it).
# A permission prompt appears on the Mac's screen the first time; someone on the screen must click Allow.
set -euo pipefail
mode=$1; secs=$2; nokey=${3:-}
cd "$(dirname "$0")"
here=$PWD
if [ ! -d Electron.app ]; then
  curl -fsSL -o electron.zip https://github.com/electron/electron/releases/download/v43.2.0/electron-v43.2.0-darwin-arm64.zip
  ditto -x -k electron.zip . && rm electron.zip
fi
id=ai.omnirush.m0audio${nokey:+.nokey}
app="$here/M0Audio${nokey:+NoKey}.app"
rm -rf "$app" && cp -R Electron.app "$app"
pl="$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $id" -c "Set :CFBundleName M0Audio" -c "Set :CFBundleDisplayName M0Audio" "$pl"
if [ -n "$nokey" ]; then
  /usr/libexec/PlistBuddy -c "Delete :NSAudioCaptureUsageDescription" "$pl"
else
  /usr/libexec/PlistBuddy -c "Set :NSAudioCaptureUsageDescription OmniRush records the other people in your call so it can write your meeting notes." "$pl"
fi
mkdir -p "$app/Contents/Resources/app"
cp main.cjs page.html package.json "$app/Contents/Resources/app/"
codesign --force --deep --options runtime --entitlements entitlements.mac.plist --sign - "$app" 2>/dev/null
out="$here/out-$mode${nokey:+-nokey}"
rm -rf "$out" && mkdir -p "$out"
/usr/libexec/PlistBuddy -c "Print :NSAudioCaptureUsageDescription" "$pl" >"$out/plist-key.txt" 2>&1 || true
/usr/bin/log stream --style compact --predicate 'process == "tccd" OR process == "UserNotificationCenter" OR process == "universalAccessAuthWarn"' >"$out/tcc.log" 2>&1 &
logpid=$!
# Them: the fixture on a loop through the default output, for the whole run.
( end=$((SECONDS + secs + 70)); while [ $SECONDS -lt $end ]; do afplay -v 0.3 them.wav; done ) &
playpid=$!
open -n -W --stdout "$out/stdout.txt" --stderr "$out/stderr.txt" "$app" --args --mode="$mode" --seconds="$secs" --out="$out" || true
pkill -P $playpid afplay 2>/dev/null || true; kill $playpid 2>/dev/null || true
sleep 2; kill $logpid 2>/dev/null || true
pkill -f "$app/Contents/MacOS" 2>/dev/null || true
grep -E 'event' "$out/levels.jsonl" | cut -c1-300 || true
echo "them rmsDb: $(grep '"stream":"them"' "$out/levels.jsonl" | sed -E 's/.*rmsDb":([-0-9.]+).*/\1/' | paste -sd' ' -)"
grep -i -E "AudioCapture|ScreenCapture|Microphone|AUTHREQ_RESULT|prompt" "$out/tcc.log" | grep -i -E "m0audio|AUTHREQ_RESULT|prompt" | cut -c1-260 | head -30 || true
