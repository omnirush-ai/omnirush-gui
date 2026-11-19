#!/usr/bin/env bash
# Linux check: a Pulse server in a container (PulseAudio 16; wireplumber 0.4.17 exits in a
# bare container, and Chromium talks libpulse to pipewire-pulse the same way), a null sink plays "Them",
# a virtual mic plays "Me", Electron 43 records both. Run on the fat server from this dir.
# Usage: ./run-linux-rig.sh <them.wav> <me.wav> <out-dir> [seconds]
set -euo pipefail
them=$(realpath "$1"); me=$(realpath "$2"); out=$(realpath -m "$3"); secs=${4:-25}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"
docker build -q -t m0audio-rig:1 -f - "$here" >/dev/null <<'EOF'
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    pulseaudio pulseaudio-utils xvfb ca-certificates curl unzip \
    libnss3 libgtk-3-0t64 libgbm1 libasound2t64 libxss1 libxtst6 libatk-bridge2.0-0t64 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libcups2t64 libpango-1.0-0 libcairo2 libpulse0 \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://github.com/electron/electron/releases/download/v43.2.0/electron-v43.2.0-linux-x64.zip -o /tmp/e.zip \
  && mkdir /opt/electron && unzip -q /tmp/e.zip -d /opt/electron && rm /tmp/e.zip
EOF
docker run --rm --name m0audio-run --network none \
  -v "$here":/spike:ro -v "$them":/fx/them.wav:ro -v "$me":/fx/me.wav:ro -v "$out":/out \
  -e SECS="$secs" m0audio-rig:1 bash -c '
set -eu
export XDG_RUNTIME_DIR=/tmp/xdg; mkdir -p -m 700 $XDG_RUNTIME_DIR
pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit -n --load=module-native-protocol-unix --load=module-always-sink 2>/out/pulse-stderr.txt; sleep 1
pactl load-module module-null-sink sink_name=them_out >/dev/null
pactl set-default-sink them_out
pactl load-module module-null-sink sink_name=me_in >/dev/null
pactl load-module module-remap-source master=me_in.monitor source_name=me_mic >/dev/null
pactl set-default-source me_mic
{ pactl info | grep -E "Server Name|Default"; pactl list short sources; } | tee /out/pactl-info.txt
Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 & export DISPLAY=:99; sleep 1
(sleep 4; paplay --device=them_out /fx/them.wav; echo "them paplay exit $?" >>/out/pactl-info.txt) &
(sleep 4; paplay --device=me_in /fx/me.wav; echo "me paplay exit $?" >>/out/pactl-info.txt) &
/opt/electron/electron --no-sandbox --disable-gpu /spike/main.cjs --mode=catap --seconds=$SECS --out=/out --mic 2>/out/electron-stderr.txt
chown -R '"$(id -u):$(id -g)"' /out'
