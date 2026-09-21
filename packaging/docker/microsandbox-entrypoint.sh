#!/usr/bin/env sh
set -eu

OMNIRUSH_WORKSPACE="${OMNIRUSH_WORKSPACE:-/workspace}"
OMNIRUSH_DATA_DIR="${OMNIRUSH_DATA_DIR:-/data/omnirush-server}"
OMNIRUSH_SIDECAR_DIR="${OMNIRUSH_SIDECAR_DIR:-/data/sidecars}"
OMNIRUSH_PORT="${OMNIRUSH_PORT:-8787}"
OMNIRUSH_TOKEN="${OMNIRUSH_TOKEN:-microsandbox-token}"
OMNIRUSH_HOST_TOKEN="${OMNIRUSH_HOST_TOKEN:-microsandbox-host-token}"
OMNIRUSH_APPROVAL_MODE="${OMNIRUSH_APPROVAL_MODE:-auto}"
OMNIRUSH_CORS_ORIGINS="${OMNIRUSH_CORS_ORIGINS:-*}"
OMNIRUSH_CONNECT_HOST="${OMNIRUSH_CONNECT_HOST:-127.0.0.1}"
OMNIRUSH_EXTENSIONS_PLUGIN_DIR="${OMNIRUSH_EXTENSIONS_PLUGIN_DIR:-/opt/omnirush/opencode-plugins}"
HOME="${HOME:-/root}"
USER="${USER:-root}"
SHELL="${SHELL:-/bin/sh}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

if [ "$HOME" = "/" ]; then
  HOME=/root
  XDG_CONFIG_HOME="$HOME/.config"
  XDG_CACHE_HOME="$HOME/.cache"
  XDG_DATA_HOME="$HOME/.local/share"
  XDG_STATE_HOME="$HOME/.local/state"
fi

export HOME USER SHELL XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME
export OMNIRUSH_DATA_DIR OMNIRUSH_TOKEN OMNIRUSH_HOST_TOKEN OMNIRUSH_EXTENSIONS_PLUGIN_DIR
export OMNIRUSH_MANAGE_OPENCODE=1
export OMNIRUSH_OPENCODE_BIN=/usr/local/bin/opencode

mkdir -p "$OMNIRUSH_WORKSPACE" "$OMNIRUSH_DATA_DIR" "$OMNIRUSH_SIDECAR_DIR"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

printf '%s\n' "Starting OmniRush.ai micro-sandbox"
printf '%s\n' "- workspace: $OMNIRUSH_WORKSPACE"
printf '%s\n' "- home: $HOME"
printf '%s\n' "- omnirush url: http://$OMNIRUSH_CONNECT_HOST:$OMNIRUSH_PORT"
printf '%s\n' "- client token: $OMNIRUSH_TOKEN"
printf '%s\n' "- host token: $OMNIRUSH_HOST_TOKEN"
printf '%s\n' "- health: curl http://$OMNIRUSH_CONNECT_HOST:$OMNIRUSH_PORT/health"
printf '%s\n' "- auth test: curl -H \"Authorization: Bearer $OMNIRUSH_TOKEN\" http://$OMNIRUSH_CONNECT_HOST:$OMNIRUSH_PORT/workspaces"

exec omnirush-server \
  --workspace "$OMNIRUSH_WORKSPACE" \
  --host 0.0.0.0 \
  --port "$OMNIRUSH_PORT" \
  --token "$OMNIRUSH_TOKEN" \
  --host-token "$OMNIRUSH_HOST_TOKEN" \
  --approval "$OMNIRUSH_APPROVAL_MODE" \
  --cors "$OMNIRUSH_CORS_ORIGINS" \
  --verbose
