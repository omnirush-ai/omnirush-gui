#!/usr/bin/env bash
# Checks a built macOS disk image on a Mac runner:
#  - prints the app's name keys, designated requirement and the names macOS shows;
#  - opens the installer window in Finder, prints its layout and saves a
#    screenshot of it in Light and Dark Mode to <out-dir>;
#  - installs the latest published release, then lets that release's own
#    Squirrel ShipIt install this build over it (the in-app update path), and
#    checks the result is one app, updated in place and still valid.
# Usage: scripts/release/check-macos-installer.sh <dist-dir> <out-dir>
set -euo pipefail

dist=$1
out=$2
mkdir -p "$out"
dmg=$(ls "$dist"/*.dmg | head -n 1)
app=$(find "$dist" -maxdepth 2 -name '*.app' -type d | head -n 1)
# ShipIt only accepts canonical paths, and the temp dir sits under the /var symlink.
work=$(cd "$(mktemp -d)" && pwd -P)

plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null || echo "(unset)"; }
finder_name() { osascript -e "tell application \"Finder\" to get displayed name of (POSIX file \"$1\" as alias)"; }

echo "== app bundle: $(basename "$app")"
for key in CFBundleName CFBundleDisplayName CFBundleExecutable CFBundleIdentifier CFBundleShortVersionString; do
  echo "$key=$(plist "$app" "$key")"
done
codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => /designated requirement: /p'

echo "== installer window"
mount=$(hdiutil attach -nobrowse -noverify -noautoopen "$dmg" | grep -o '/Volumes/.*$' | tail -n 1)
volume=$(basename "$mount")
echo "volume: $volume"
ls -la "$mount"
mounted_app="$mount/$(basename "$app")"
mdimport "$mounted_app" >/dev/null 2>&1 || true
echo "mdls: $(mdls -name kMDItemDisplayName -raw "$mounted_app" 2>&1)"
echo "Finder shows: $(finder_name "$mounted_app")"

cat > "$work/window.swift" <<'SWIFT'
import CoreGraphics
import Foundation
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for window in list where (window[kCGWindowOwnerName as String] as? String) == "Finder"
  && (window[kCGWindowName as String] as? String) == CommandLine.arguments[1] {
  print(window[kCGWindowNumber as String]!)
  break
}
SWIFT
swiftc -O -o "$work/window" "$work/window.swift"

shoot() {
  osascript -e "tell application \"System Events\" to tell appearance preferences to set dark mode to $1"
  osascript -e "tell application \"Finder\" to open (POSIX file \"$mount\" as alias)" -e 'tell application "Finder" to activate' >/dev/null
  sleep 4
  local id
  id=$("$work/window" "$volume")
  if [ -n "$id" ]; then screencapture -x -o -l "$id" "$out/$2"; else screencapture -x "$out/$2"; fi
  echo "saved $out/$2"
}
shoot false installer-light.png
osascript <<APPLESCRIPT
tell application "Finder"
  set w to container window of disk "$volume"
  set o to icon view options of w
  set AppleScript's text item delimiters to ", "
  log "bounds: " & ((bounds of w) as text)
  log "toolbar visible: " & (toolbar visible of w) & ", statusbar visible: " & (statusbar visible of w)
  log "icon size: " & (icon size of o)
  try
    log "background: " & (name of (background picture of o as alias))
  end try
end tell
APPLESCRIPT
# Icon positions and the background, as stored in the image's .DS_Store.
python3 -m pip install --quiet --break-system-packages ds_store mac_alias 2>/dev/null \
  || python3 -m pip install --quiet ds_store mac_alias
python3 - "$mount/.DS_Store" <<'PYTHON'
import sys
from ds_store import DSStore
from mac_alias import Alias
with DSStore.open(sys.argv[1], "r") as store:
    for entry in store:
        if entry.code == b"Iloc":
            print(f"{entry.filename}: icon at {entry.value}")
        elif entry.code == b"bwsp":
            print("window:", {k: entry.value[k] for k in ("WindowBounds", "ShowToolbar", "ShowStatusBar", "ShowSidebar")})
        elif entry.code == b"icvp":
            view = entry.value
            background = Alias.from_bytes(view["backgroundImageAlias"]).target.filename if "backgroundImageAlias" in view else None
            print(f"icon view: iconSize={view.get('iconSize')} backgroundType={view.get('backgroundType')} background={background}")
PYTHON
shoot true installer-dark.png
osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to false'
osascript -e "tell application \"Finder\" to close every window" >/dev/null 2>&1 || true
hdiutil detach -quiet "$mount" || hdiutil detach -force "$mount"

echo "== in-place update from the latest release"
latest=$(curl -fsSL https://github.com/omnirush-ai/omnirush-gui/releases/latest/download/latest-mac.yml | awk '/^version:/ { print $2 }')
curl -fsSL -o "$work/latest.zip" "https://github.com/omnirush-ai/omnirush-gui/releases/download/v$latest/omnirush-mac-arm64-$latest.zip"
applications="$work/Applications"
mkdir -p "$applications" "$work/update" "$work/shipit"
ditto -x -k "$work/latest.zip" "$applications"
installed=$(ls -d "$applications"/*.app)
echo "installed v$latest as $(basename "$installed") (executable $(plist "$installed" CFBundleExecutable))"
ditto "$app" "$work/update/$(basename "$app")"
# What Squirrel.Mac decides before it writes the request (SQRLUpdater.m).
rename=false
[ "$(plist "$installed" CFBundleExecutable)" = "$(basename "$installed" .app)" ] && rename=true
cat > "$work/shipit/ShipItState.plist" <<JSON
{"updateBundleURL":"file://$work/update/$(basename "$app")/","targetBundleURL":"file://$installed/","bundleIdentifier":"$(plist "$app" CFBundleIdentifier)","launchAfterInstallation":false,"useUpdateBundleName":$rename}
JSON
perl -e 'alarm shift; exec @ARGV' 600 \
  "$installed/Contents/Frameworks/Squirrel.framework/Resources/ShipIt" "$(plist "$app" CFBundleIdentifier).ShipIt" "$work/shipit/ShipItState.plist"
apps=("$applications"/*.app)
echo "after update: ${apps[*]##*/}"
[ "${#apps[@]}" -eq 1 ] || { echo "expected one app after the update" >&2; exit 1; }
updated=${apps[0]}
[ "$(plist "$updated" CFBundleShortVersionString)" = "$(plist "$app" CFBundleShortVersionString)" ] || { echo "the update did not install" >&2; exit 1; }
codesign --verify --deep --strict "$updated"
echo "updated: $(basename "$updated") v$(plist "$updated" CFBundleShortVersionString), CFBundleName=$(plist "$updated" CFBundleName)"
echo "Finder shows: $(finder_name "$updated")"
rm -rf "$work"
