#!/usr/bin/env bash
# Serve daemon + screenshot the new GUI bits in one invocation.
set -u
cd /home/z/my-project
PORT="${1:-4021}"

pkill -f "packages/cli/src/index.ts demo-workspace --port $PORT" 2>/dev/null
sleep 1

bun packages/cli/src/index.ts demo-workspace --port "$PORT" --no-open > /tmp/tagent-gui-test.log 2>&1 &
sleep 4

agent-browser open "http://127.0.0.1:$PORT/" >/dev/null 2>&1
agent-browser wait --load networkidle >/dev/null 2>&1
agent-browser screenshot /tmp/gui-new-landing.png >/dev/null 2>&1
echo "landing: $(agent-browser get title 2>/dev/null | tail -1)"

# open the workspace switcher dropdown
agent-browser find role button click --name "demo-workspace" >/dev/null 2>&1
sleep 1
agent-browser screenshot /tmp/gui-switcher.png >/dev/null 2>&1
agent-browser snapshot -c 2>/dev/null | grep -A3 -i "workspace" | head -8
agent-browser press Escape >/dev/null 2>&1

# open settings → integrations (MEGA panel)
agent-browser find role button click --name "Settings" >/dev/null 2>&1 || true
sleep 1
agent-browser find text "Integrations" click >/dev/null 2>&1 || true
sleep 1
agent-browser screenshot /tmp/gui-mega.png >/dev/null 2>&1
agent-browser snapshot -c 2>/dev/null | grep -i "mega\|cloud" | head -4

agent-browser close >/dev/null 2>&1
pkill -f "packages/cli/src/index.ts demo-workspace --port $PORT" 2>/dev/null
echo "done"
