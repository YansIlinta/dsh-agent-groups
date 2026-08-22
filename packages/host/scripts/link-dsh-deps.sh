#!/usr/bin/env bash
# Link the exact DSH packages from the local dsh installation into this
# package's node_modules so dev/build/test resolve the SAME versions the
# running `dsh web` uses. In production the profile's healed module fallback
# supplies these; this script no-ops when no local dsh installation exists.
#
# Layouts handled:
#   nested  — dsh installed under nvm/pnpm stores:
#             <global>/ @deepseek-ai/dsh/node_modules/@deepseek-ai/cordis
#   flat    — dsh installed with plain `npm i -g`:
#             <global>/ @deepseek-ai/cordis  (deps hoisted to the global root)
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NPM_GLOBAL_ROOT="${NPM_GLOBAL_ROOT:-}"
if [ -z "$NPM_GLOBAL_ROOT" ]; then
  NPM_GLOBAL_ROOT="$(node -p "require('node:child_process').execSync('npm root -g').toString().trim()")" 2>/dev/null || true
fi
GLOBAL_ROOT="${NPM_GLOBAL_ROOT:-}"

CANDIDATE=""
for c in "$GLOBAL_ROOT/@deepseek-ai/dsh/node_modules/@deepseek-ai" "$GLOBAL_ROOT/@deepseek-ai"; do
  if [ -d "$c/cordis" ]; then
    CANDIDATE="$c"
    break
  fi
done
if [ -z "$CANDIDATE" ]; then
  echo "[agent-groups] no local dsh installation (checked $GLOBAL_ROOT); skipping dev links"
  exit 0
fi

mkdir -p "$PKG_DIR/node_modules/@deepseek-ai"
for p in cordis dsh-tools dsh-llm dsh-session dsh-agent dsh-host-webserver dsh-storage dsh-storage-domain dsh-system-prompt dsh-agent-presets dsh-brand dsh-subagent dsh-commands dsh-persona; do
  if [ -e "$CANDIDATE/$p" ]; then
    ln -sfn "$CANDIDATE/$p" "$PKG_DIR/node_modules/@deepseek-ai/$p"
  fi
done
# zod used by the domain spec must be the single runtime instance (zod v4)
ZOD=""
for z in "$CANDIDATE/../zod" "$GLOBAL_ROOT/zod" "$GLOBAL_ROOT/@deepseek-ai/dsh/node_modules/zod"; do
  if [ -e "$z/package.json" ]; then
    ZOD="$z"
    break
  fi
done
if [ -n "$ZOD" ]; then
  rm -rf "$PKG_DIR/node_modules/zod"
  ln -sfn "$ZOD" "$PKG_DIR/node_modules/zod"
fi
echo "[agent-groups] dev links ready under $PKG_DIR/node_modules/@deepseek-ai (from $CANDIDATE)"