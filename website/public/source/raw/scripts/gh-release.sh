#!/usr/bin/env bash
# Creates the GitHub release for the current version, cross-compiles the
# single-file binaries and uploads them (plus SHA256SUMS) as release assets.
#
# Usage: scripts/gh-release.sh <token> [version] [--no-build]
#   token    GitHub PAT with repo scope
#   version  defaults to the version in packages/core/src/version.ts
#   --no-build  skip compilation (use existing dist/tagent-v<version>/ binaries)
set -euo pipefail
cd "$(dirname "$0")/.."
TOKEN=""
VERSION_ARG=""
NO_BUILD=0
for a in "$@"; do
  case "$a" in
    --no-build) NO_BUILD=1 ;;
    --*) ;;
    *) if [ -z "$TOKEN" ]; then TOKEN="$a"; else VERSION_ARG="$a"; fi ;;
  esac
done
REPO="asysurya/tagent"
VERSION="${VERSION_ARG:-$(grep -oP "(?<=CURRENT_VERSION = ')[0-9][0-9a-zA-Z.]*" packages/core/src/version.ts)}"
if [ -z "${TOKEN:-}" ]; then echo "usage: $0 <token> [version] [--no-build]" >&2; exit 1; fi
if [ -z "${VERSION:-}" ]; then echo "[release] cannot determine version" >&2; exit 1; fi
OUT="dist/tagent-v$VERSION"

echo "[release] tagent v$VERSION → $OUT"

# ---------------------------------------------------------------- 1. build --
if [ "$NO_BUILD" -eq 1 ]; then
  echo "[release] --no-build: using existing binaries in $OUT"
  ls -lh "$OUT"
else
  bash scripts/build-binaries.sh "$VERSION"
fi

# ---------------------------------------------------------- 2. the release --
BODY=$(cat <<'EOF'
## v__VER__ — skill discovery: search_skills + auto-router

Skills now come with a two-stage protocol and a proactive layer that
loads the right playbook before you even ask for it.

### search_skills — browse before you load

- new tool: browse skill METADATA (name, description, usage, tags) by
  keyword query, tags (AND), and limit — read-only, risk:low, every mode
- two-stage progressive disclosure: FIRST search_skills to find the
  right skill, THEN load_skill(name) for the full body — no more guessing
  names from the prompt list or loading skills one by one to peek
- mtime-cached listing: re-scans only when a skills dir / SKILL.md
  actually changed; cached calls are well under a millisecond

### The skill auto-router

- before the first turn, the router matches the task to skills:
  · workspace signals (score 0.9): package.json deps (next/react → web,
    discord.js/telegraf → bot, express/fastify/hono → API), Dockerfile,
    tsconfig.json, app/ or src/pages, .py density, PRD.md hints
  · task keywords (0.5–0.7): matched against skill tags + descriptions
- matched skills auto-load into context (max 3, bodies capped ~8k chars
  each); below-threshold or empty matches load NOTHING — no speculation
- one topic-shift re-route per session keeps a mid-session "now build
  a CLI instead" covered; a re-route that finds nothing new burns no
  budget

### Transparency + control

- the TUI shows: 🎯 Auto-loaded skills + the match reasons; WORKLOG.md
  gets the [auto-router] entry; the system prompt carries the list
  (name, score, reason) plus the bodies
- slash commands: /skills (loaded, [auto]/[manual] badges; all =
  installed) · /reload-skills · /no-auto-skill · /unload-skill <name>
- config: skills.autoRoute (default true) · autoRouteMax (3) ·
  autoRouteThreshold (0.5)

### SKILL.md metadata

- front-matter now understands usage: and tags: (comma-separated);
  usage falls back to the body's first paragraph, tags to []
- the shipped skills (web-app-builder, code-review, bug-hunter) carry
  usage + tags

### Verification

- new suite scripts/test-skills-router.ts — 73 checks: registration +
  mode gating, query/tags/limit filters, two-stage flow, cache timing +
  invalidation, router scenarios (web/bot/CLI), scoring caps +
  thresholds, config disable, topic shift, slash-command logic, prompt
  rendering, 50-skill routing perf (<100ms), and a full AgentLoop
  end-to-end with a fake provider (notice fires, body rides the prompt,
  search_skills executes through the permission gate)
- battery re-run green: switch-mode 52 · subagents 71 · testmode 59 ·
  ask 41 · features 19 · context-loop 30 · browser 32 · v0190 71 ·
  v0220 25 · tui-app · host · version
- tsc: no new errors (one pre-existing fixed); website build clean
EOF
)

BODY=${BODY//__VER__/$VERSION}
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — skill discovery: search_skills + auto-router" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

ID=$(echo "$RELEASE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id') or '')")
URL=$(echo "$RELEASE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('html_url') or json.load(sys.stdin).get('message'))")
echo "[release] $URL"
if [ -z "$ID" ]; then echo "$RELEASE_JSON" >&2; exit 1; fi

# ----------------------------------------------------------- 3. the assets --
# list already-uploaded assets → make re-runs idempotent
ASSETS_JSON=$(curl -s -H "Authorization: token $TOKEN" "https://api.github.com/repos/$REPO/releases/$ID/assets")
have_asset() {
  echo "$ASSETS_JSON" | python3 -c "import json,sys; print('\n'.join(a['name'] for a in json.load(sys.stdin)))" | grep -qx "$1"
}
shopt -s nullglob
for f in "$OUT"/tagent-v* "$OUT"/SHA256SUMS.txt; do
  name=$(basename "$f")
  if have_asset "$name"; then
    echo "[release] $name already uploaded — skipping"
    continue
  fi
  size=$(du -h "$f" | cut -f1)
  echo "[release] uploading $name ($size) …"
  curl -s -X POST \
    -H "Authorization: token $TOKEN" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" \
    "https://uploads.github.com/repos/$REPO/releases/$ID/assets?name=$name" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print('  → ' + (d.get('browser_download_url') or d.get('message')))"
done

echo "[release] done — $URL"
