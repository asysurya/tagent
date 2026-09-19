#!/usr/bin/env bash
# Serve daemon + screenshot the v0.4.0 GUI bits (timeline tab, agent settings,
# share button) in one invocation.
set -u
cd /home/z/my-project
PORT="${1:-4022}"

pkill -f "packages/cli/src/index.ts web demo-workspace --port $PORT" 2>/dev/null
sleep 1

bun packages/cli/src/index.ts web demo-workspace --port "$PORT" --no-open > /tmp/tagent-gui-v04.log 2>&1 &
sleep 4

agent-browser open "http://127.0.0.1:$PORT/" >/dev/null 2>&1
agent-browser wait --load networkidle >/dev/null 2>&1
agent-browser screenshot download/gui-v04-landing.png >/dev/null 2>&1

# right panel → Timeline tab
agent-browser find text "Timeline" click >/dev/null 2>&1 || true
sleep 1
agent-browser screenshot download/gui-v04-timeline.png >/dev/null 2>&1
agent-browser snapshot -c 2>/dev/null | grep -i "timeline\|subagent" | head -4

# settings → Agent tab (worklog, caveman, webGui toggle)
agent-browser find role button click --name "Settings" >/dev/null 2>&1 || true
sleep 1
agent-browser find text "Agent" click >/dev/null 2>&1 || true
sleep 1
agent-browser screenshot download/gui-v04-agent-settings.png >/dev/null 2>&1
agent-browser snapshot -c 2>/dev/null | grep -i "worklog\|caveman\|web gui" | head -6

# integrations — device flow button
agent-browser find text "Integrations" click >/dev/null 2>&1 || true
sleep 1
agent-browser screenshot download/gui-v04-integrations.png >/dev/null 2>&1
agent-browser snapshot -c 2>/dev/null | grep -i "device\|browser (device" | head -3

# close settings, check sidebar (session rows with share on hover)
agent-browser press Escape >/dev/null 2>&1
sleep 0.5
agent-browser screenshot download/gui-v04-sidebar.png >/dev/null 2>&1

# share link over HTTP
SID=$(ls demo-workspace/.tagent/shares/ 2>/dev/null | head -1 | sed 's/\.html$//')
if [ -n "$SID" ]; then
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/share/$SID.html")
  echo "share http: $CODE"
fi

agent-browser close >/dev/null 2>&1
pkill -f "packages/cli/src/index.ts web demo-workspace --port $PORT" 2>/dev/null
echo "done"
