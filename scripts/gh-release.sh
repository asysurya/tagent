#!/usr/bin/env bash
# Creates the GitHub release for v0.2.0 with the changelog body (from releases.ts).
set -euo pipefail
TOKEN="${1:?usage: $0 <token>}"
BODY=$(cat <<'EOF'
## Phone support, open source, update checker

Runs on Android via UserLAnd (no root), the daemon serves the GUI itself, and Tagent now warns when a newer release exists.

### Mobile (UserLAnd on Android)
- New phone-first layout: bottom tab bar with Chat / Files / Terminal / Memory / Skills
- File editor with back navigation; the same panels as desktop — full parity
- `scripts/setup-ubuntu.sh` detects phones (proot/Android) and adapts: skips heavy Chromium, prints mobile hints
- `docs/USERLAND.md` — complete no-root guide: Play Store → Ubuntu → localhost:4020 in Chrome
- Battery / background / RAM tips + troubleshooting table

### Desktop / daemon
- One process does it all: the daemon now serves the pre-built web GUI (`gui-dist/`) as a static SPA with the websocket at `/socket`
- CLI flags: `--host` (default 127.0.0.1, 0.0.0.0 for LAN), `--port`, `--no-open`, `--gui <dir>`
- Update checker: checks at most once a day, warns on outdated, never blocks — `TAGENT_UPDATE_URL` to override the endpoint
- New fast paths: `tagent --version`, `tagent --check-update`
- `xdg-open` failures no longer spam headless boxes

### Community
- Repository is public (MIT): CONTRIBUTING.md, SECURITY.md
- Website launched: docs, install guides, releases/changelog, downloads per platform

---

**Install / upgrade**
```bash
git clone https://github.com/asysurya/tagent.git
cd tagent && bash scripts/setup-ubuntu.sh
bun packages/cli/src/index.ts ~/my-project
```
EOF
)
curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/asysurya/tagent/releases \
  -d "$(jq -n --arg tag "v0.2.0" --arg name "v0.2.0 — Phone support, open source, update checker" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')" \
  | grep -E '"html_url".*releases|"id".*release' | head -2
