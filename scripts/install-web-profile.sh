#!/usr/bin/env bash
# Install DSH Agent Groups into the local DeepSeek Harness web profile:
#   1. build the host package and dashboard if needed
#   2. copy @dsh-agent-groups/host into the profile's resolvable module tree
#   3. install the group-leader / group-member agent presets
#   4. insert the host plugin row into the web profile's cordis patch layer
# Reversible: remove the inserted `agent-groups` row and the copied dirs.
set -euo pipefail
export PATH="$(dirname "$(command -v node)"):$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_PKG="$ROOT/packages/host"
PROFILES_PKG="$ROOT/packages/profiles"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
WEB_PROFILE="$DSH_HOME/profiles/web"
PROFILE_MODULES="$DSH_HOME/profiles/node_modules"
PRESETS_DIR="$DSH_HOME/.agent-presets"

echo "[agent-groups] DSH_HOME=$DSH_HOME"

# 1. Builds ---------------------------------------------------------------
node "$ROOT/scripts/build-native-client.mjs"
if [ ! -d "$HOST_PKG/lib" ]; then
  echo "[agent-groups] building host…"
  (cd "$HOST_PKG" && npm run build)
fi

# 2. Host package into profile module tree --------------------------------
mkdir -p "$PROFILE_MODULES/@dsh-agent-groups" "$WEB_PROFILE/node_modules/@dsh-agent-groups"
for dest in "$PROFILE_MODULES/@dsh-agent-groups/host" "$WEB_PROFILE/node_modules/@dsh-agent-groups/host"; do
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -R "$HOST_PKG/package.json" "$HOST_PKG/lib" "$dest/"
done
echo "[agent-groups] host package copied to $PROFILE_MODULES/@dsh-agent-groups/host"

# 3. Agent presets ----------------------------------------------------------
mkdir -p "$PRESETS_DIR"
rm -rf "$PRESETS_DIR/group-leader" "$PRESETS_DIR/group-member"
cp -R "$PROFILES_PKG/presets/group-leader" "$PROFILES_PKG/presets/group-member" "$PRESETS_DIR/"
echo "[agent-groups] presets installed under $PRESETS_DIR"

# 4. Profile patch ----------------------------------------------------------
node "$ROOT/scripts/patch-profile.mjs" "$WEB_PROFILE/cordis.patch.yml" agent-groups '@dsh-agent-groups/host'

echo
echo "[agent-groups] install complete. Presets: Team Lead (group-leader) / Group Member (group-member)."
echo "[agent-groups] Restart the web server (npm run relaunch-web) to mount the plugin."
