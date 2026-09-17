#!/usr/bin/env bash
# Creates the GitHub release for the current version with its changelog body.
# Usage: scripts/gh-release.sh <token> [version]
set -euo pipefail
TOKEN="${1:?usage: $0 <token> [version]}"
VERSION="${2:-0.3.0}"

BODY=$(cat <<EOF
## Streaming, native tool-calling, workspace switcher

Tokens stream live into the chat, providers can call tools natively (with automatic fallback), and you can switch workspaces from the GUI without restarting the daemon.

### Streaming
- Real token streaming (SSE) for OpenAI-compatible, Anthropic, Gemini and the built-in Z.ai provider — text appears as it is generated
- Throttled, idempotent stream events (full-text-so-far) — smooth on phones, no desync on reconnect
- The markdown action protocol never leaks raw JSON into the chat while streaming

### Native tool-calling
- OpenAI, Anthropic, Gemini and custom providers receive real function schemas (12/12 tools documented)
- Models can call tools through the native API; permission gates and checkpoints apply exactly as before
- Automatic fallback: endpoints that reject tools silently revert to the markdown protocol
- Config flag: \`nativeTools\` (default on) — the markdown protocol always remains available

### Workspace switcher
- New dropdown in the top bar: current workspace, recent list, and "Open folder…" by path
- Switching rebinds the daemon live — sessions, files, memory and skills reload without a restart
- Recent workspaces are remembered globally (~/.tagent/workspaces.json, capped at 12)

### MEGA cloud sync
- Settings → Integrations: enable MEGA, set email + password, then "Sync memory ↑" / "Restore ↓"
- End-to-end encrypted backup of AGENTS.md drafts + memory facts across devices (needs \`bun add megajs\`)

### Under the hood
- E2E test suite: real-LLM chat through the daemon (scripts/e2e-chat.ts) and workspace-switch RPC tests
- Removed a leftover scaffold API route that broke static export builds

---

**Install / upgrade**
\`\`\`bash
git clone https://github.com/asysurya/tagent.git
cd tagent && bash scripts/setup-ubuntu.sh
bun packages/cli/src/index.ts ~/my-project
\`\`\`
EOF
)

curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/asysurya/tagent/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — Streaming, native tool-calling, workspace switcher" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('release:', d.get('html_url') or d.get('message'))"
