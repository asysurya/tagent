#!/usr/bin/env bash
# Creates the GitHub release for the current version with its changelog body.
# Usage: scripts/gh-release.sh <token> [version]
set -euo pipefail
TOKEN="${1:?usage: $0 <token> [version]}"
VERSION="${2:-0.4.0}"

BODY=$(cat <<EOF
## Terminal-first: full TUI, tagent start, share links, timelines

The TUI is now the primary interface — a complete terminal UI with every feature the web GUI has. Same engine, same sessions, same permissions, on desktop and on a phone.

### Terminal-first
- New full TUI (\`tagent start\`): streaming tokens, tool lines, live todo lists, subagent activity, inline permission prompts
- Pure stdin/stdout — identical on desktop, SSH and Android (Termux/UserLAnd)
- Shared AgentHost: the terminal and browser tabs attach to the same agent and stay in sync

### Commands
- \`tagent start [path]\` — the TUI (primary); \`--web-gui\` also serves the browser GUI
- \`tagent web [path]\` — daemon + web GUI only, for phone / remote use
- \`tagent run [path] "prompt"\` — one-shot agent run (\`--json\` for structured output)
- \`tagent auth\` — GitHub login wizard (device flow or PAT)
- \`tagent config get/set/list\` · \`tagent sessions\` · \`tagent share\` · \`tagent doctor\`
- Web GUI on/off: \`tagent config set webGui on\` (global) — \`tagent start\` stays TUI-only by default

### Worklog + todos
- The agent plans multi-step work as a live todo list, then journals each completed step to WORKLOG.md
- Resuming older work: the agent reads WORKLOG.md first and picks up where it left off
- GUI: Log tab + Settings → Agent. TUI: \`/todos\`, \`/log\`, \`/worklog\`

### Caveman mode 🦴
- Omni-route style token saver: terse replies, compact system prompt, one-line tool docs, tighter tool-output budgets
- Toggle: top-bar bone icon, \`/caveman\` in the TUI, or \`tagent config set caveman on\`

### Share links
- Export any session as a standalone read-only HTML file (self-contained, collapsible tool calls)
- Served at \`/share/<id>.html\` — sidebar share button, \`/share\` in the TUI, \`tagent share <id>\` from the shell

### Multi-agent timelines
- Subagent runs are persisted as real sessions (parentId metadata) — they survive restarts
- New Timeline tab in the GUI panel; \`/timeline\` in the TUI

### Under the hood
- AgentHost refactor: one brain shared by TUI and daemon
- GitHub device flow wired end-to-end (CLI wizard + GUI button)
- PermissionManager honors permissions.defaultMode; permission requests carry real risk levels
- Session titles auto-derive from the first message

---

**Install / upgrade**
\`\`\`bash
git clone https://github.com/asysurya/tagent.git
cd tagent && bash scripts/setup-ubuntu.sh
bun link            # makes the \`tagent\` command available
tagent start ~/my-project
\`\`\`
EOF
)

curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/asysurya/tagent/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — Terminal-first: full TUI, tagent start, share links, timelines" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('release:', d.get('html_url') or d.get('message'))"
