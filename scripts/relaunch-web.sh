#!/usr/bin/env bash
# Restart the local dsh web server (127.0.0.1:8080) so the profile patch and
# installed Agent Groups plugin take effect.
set -euo pipefail
export PATH="$(dirname "$(command -v node)"):$PATH"

echo "[agent-groups] stopping dsh web…"
pkill -f 'dsh we[b]' 2>/dev/null || echo "[agent-groups] no existing dsh web process"
for i in $(seq 1 20); do
  if ! pgrep -f 'dsh we[b]' > /dev/null; then break; fi
  sleep 0.25
done

if [ -f "$HOME/start-dsh.sh" ]; then
  bash "$HOME/start-dsh.sh"
else
  mkdir -p "$HOME/dsh-workspace"
  # 注意：dsh 安全设计禁止 --host 0.0.0.0（公网暴露 RCE），只监听 127.0.0.1
  (cd "$HOME/dsh-workspace" && nohup dsh web --port 8080 > "$HOME/dsh-web.log" 2>&1 < /dev/null &)
fi

echo "[agent-groups] web starting — watch $HOME/dsh-web.log for the 'DSH Agent Groups' banner"
