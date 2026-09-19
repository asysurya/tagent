#!/usr/bin/env bash
# Visual check: worklog panel, Agent settings tab, caveman toggle (v0.4.0).
set -u
cd /home/z/my-project
PORT="${1:-4023}"

pkill -f "packages/cli/src/index.ts web demo-workspace --port $PORT" 2>/dev/null
sleep 1

bun packages/cli/src/index.ts web demo-workspace --port "$PORT" --no-open > /tmp/tagent-gui-test.log 2>&1 &
sleep 4

agent-browser open "http://127.0.0.1:$PORT/" >/dev/null 2>&1
agent-browser wait --load networkidle >/dev/null 2>&1
echo "landing: $(agent-browser get title 2>/dev/null | tail -1)"

# 1. Log tab in the right panel
agent-browser find text "Log" click >/dev/null 2>&1
sleep 1
agent-browser screenshot download/gui-worklog-panel.png >/dev/null 2>&1
agent-browser snapshot -c 2>/dev/null | grep -i "worklog\|fix render loop" | head -4

# 2. Settings → Agent tab
agent-browser find role button click --name "Settings" >/dev/null 2>&1
sleep 1
agent-browser find text "Agent" click >/dev/null 2>&1
sleep 1
agent-browser screenshot download/gui-agent-settings.png >/dev/null 2>&1
agent-browser snapshot -c 2>/dev/null | grep -i "caveman\|worklog + todos\|turn budget" | head -5

# 3. flip the caveman toggle on
agent-browser find role switch click >/dev/null 2>&1
sleep 1
agent-browser screenshot download/gui-caveman-on.png >/dev/null 2>&1
agent-browser snapshot -c 2>/dev/null | grep -i "me talk short" | head -2

# 4. /caveman via chat + topbar bone state
agent-browser press Escape >/dev/null 2>&1
agent-browser screenshot download/gui-topbar-bone.png >/dev/null 2>&1

agent-browser close >/dev/null 2>&1
pkill -f "packages/cli/src/index.ts web demo-workspace --port $PORT" 2>/dev/null
echo "done"
