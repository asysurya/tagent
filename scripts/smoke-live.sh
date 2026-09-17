#!/usr/bin/env bash
# One-shot daemon + smoke test (sandbox kills background procs between tool
# calls, so we run daemon and test inside the same invocation).
set -u
cd /home/z/my-project

PORT="${1:-4020}"
LOG=/tmp/tagent-daemon.log

bun packages/cli/src/index.ts web demo-workspace --port "$PORT" --no-open > "$LOG" 2>&1 &
DPID=$!
sleep 5

if ! curl -s --max-time 3 "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; then
  echo "HEALTH FAIL"; tail -5 "$LOG"; kill $DPID 2>/dev/null; exit 1
fi
echo "health: ok"

dpid_stop() {
  # bun may run as parent+child; pattern-kill both so the port is freed
  pkill -f "packages/cli/src/index.ts web demo-workspace --port $PORT" 2>/dev/null
  for i in $(seq 1 20); do
    curl -s --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || break
    sleep 0.5
  done
  sleep 0.5
}

if [ -n "${2:-}" ]; then
  # optional: run test with a simulated newer release
  echo '{"version":"0.3.0","notes":"simulated","url":"https://github.com/asysurya/tagent/releases/tag/v0.3.0"}' > /tmp/fake-latest.json
  echo "--- daemon banner with update warning (simulated v0.3.0) ---"
  dpid_stop
  TAGENT_UPDATE_URL="file:///tmp/fake-latest.json" HOME=/tmp/tagent-warn-home \
    bun packages/cli/src/index.ts web demo-workspace --port "$PORT" --no-open > "$LOG" 2>&1 &
  DPID=$!
  sleep 5
  grep -B2 -A3 "Update available" "$LOG" && echo "(warning shown, session continues — NOT blocked)" || { echo "no warning found in log:"; tail -5 "$LOG"; }
  grep -q "EADDRINUSE" "$LOG" && echo "!! port was still in use — retry needed"
fi

echo "--- RPC smoke ---"
bun scripts/debug-rpc.ts "$PORT" /socket
RESULT=$?

dpid_stop
exit $RESULT
