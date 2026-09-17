#!/usr/bin/env bash
# Creates the GitHub release for the current version with its changelog body.
# Usage: scripts/gh-release.sh <token> [version]
set -euo pipefail
TOKEN="${1:?usage: $0 <token> [version]}"
VERSION="${2:-0.5.0}"

BODY=$(cat <<'EOF'
## Relay mode: share a live session over the network
The last roadmap item is done — you can now share any session with another person **while it happens**. A read-only viewer page streams messages, tool calls, todos and subagent activity in real time, from any device with a browser.

### Relay mode
- `tagent relay [sessionId] [path]` — share a session live; prints the viewer URL and serves it until you stop it
- The viewer page is self-contained: history on open, then live streaming tokens, tool lines and todos — mobile-friendly, auto-reconnecting, with a LIVE indicator
- Unguessable per-session codes; revoke at any time (`tagent relay stop <code>`) — revoked viewers disconnect instantly
- `--host 0.0.0.0` prints LAN URLs for your phone or teammates; by default it stays on localhost (pair with an SSH tunnel for remote)

### Everywhere (desktop = phone = browser)
- TUI: `/relay` starts sharing the current session — it spins up a local endpoint on demand, no flags needed
- TUI: `/relay list` and `/relay stop <code>` manage live relays
- GUI: the RadioTower button on any session starts a live share; the sidebar lists active relays with watcher counts, copy and end buttons
- Relays persist in `.tagent/relays.json` and survive restarts, until you revoke them

### Security model
- Viewer sockets are read-only by construction: no RPC handlers are registered for them
- Events are session-filtered server-side: a viewer never sees other sessions or permission prompts
- One live relay per session — re-sharing returns the same code, revoking ends it for everyone

### Under the hood
- The websocket now always lives at `/socket` (with or without the GUI bundle) — one canonical endpoint for viewers and clients
- Normal clients receive broadcasts through a `gui` room; relay viewers get per-session filtered events
- New test suites: `scripts/test-relay.ts` (27 checks — auth, filtering, read-only enforcement, revoke) and a TUI pty test for `/relay`

---

**Install / upgrade**
```bash
git clone https://github.com/asysurya/tagent.git
cd tagent && bash scripts/setup-ubuntu.sh
bun link            # makes the `tagent` command available
tagent start ~/my-project
```
EOF
)

curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/asysurya/tagent/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — Relay mode: share a live session over the network" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('release:', d.get('html_url') or d.get('message'))"
