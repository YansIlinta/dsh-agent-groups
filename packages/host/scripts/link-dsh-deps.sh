#!/usr/bin/env bash
# Link the exact DSH packages from the local dsh installation into this
# package's node_modules so dev/build/test resolve the SAME versions the
# running `dsh web` uses. In production the profile's healed module fallback
# supplies these; this script no-ops when no local dsh installation exists.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NPM_GLOBAL_ROOT="${NPM_GLOBAL_ROOT:-}"
if [ -z "$NPM_GLOBAL_ROOT" ]; then
  NPM_GLOBAL_ROOT="$(node -p "require('node:child_process').execSync('npm root -g').toString().trim()")" 2>/dev/null || true
fi
CANDIDATE="${NPM_GLOBAL_ROOT:-}/@deepseek-ai/dsh/node_modules/@deepseek-ai"
if [ ! -d "$CANDIDATE" ]; then
  echo "[agent-groups] no local dsh installation at $CANDIDATE; skipping dev links"
  exit 0
fi

mkdir -p "$PKG_DIR/node_modules/@deepseek-ai"
for p in cordis dsh-tools dsh-llm dsh-session dsh-agent dsh-host-webserver dsh-storage dsh-storage-domain dsh-system-prompt dsh-agent-presets dsh-brand dsh-subagent dsh-commands dsh-persona; do
  if [ -e "$CANDIDATE/$p" ]; then
    ln -sfn "$CANDIDATE/$p" "$PKG_DIR/node_modules/@deepseek-ai/$p"
  fi
done
# zod used by the domain spec must be the single runtime instance (zod v4)
DASH_ROOT="$(dirname "$(dirname "$CANDIDATE")")"  # dsh package dir
if [ -e "$DASH_ROOT/node_modules/zod" ]; then
  rm -rf "$PKG_DIR/node_modules/zod"
  ln -sfn "$DASH_ROOT/node_modules/zod" "$PKG_DIR/node_modules/zod"
fi
echo "[agent-groups] dev links ready under $PKG_DIR/node_modules/@deepseek-ai"
