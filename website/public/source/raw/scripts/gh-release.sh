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
## v__VER__ — Hotfix: the re-route that never fired, whole-word keywords, a token budget

Three fixes from the v0.30.0 audit, shipped as a drop-in patch — no config
changes required.

### Fixed — the topic-shift re-route was a silent no-op

- root cause: RouteContext.existingLoaded was declared and passed but never
  read, and the already-loaded dedup ran AFTER the top-max slice — so in
  any workspace with a rule signal (package.json, Dockerfile, tsconfig.json
  — the common case) the top-N were always the already-loaded 0.9 rule
  hits, filtered to [] and the re-route returned null
- already-loaded skills are now excluded BEFORE the slice (case-insensitive
  — manual load_skill records the user-typed name), so a mid-session "now
  build a CLI instead" genuinely loads the new skill
- evidence: the end-to-end repro went from re-route = null (session
  unchanged) to "🎯 Auto-loaded skills: fake-cli" with the new skill live
  in the session

### Fixed — keywords match words, not fragments

- before: unanchored substring includes() — "ci" matched "decide"/"social",
  "test" matched "latest", firing spurious 0.5 (= threshold) skill loads
  in ANY workspace
- now: word-boundary matching, case-insensitive; a multi-word keyword
  needs every word (per-word AND); the regex avoids lookbehind so it stays
  portable
- one shared helper (keywordInText in util.ts) backs the router's keyword
  detection AND search_skills' query filter — the two can no longer
  disagree; frontmatter tag matching stays exact

### Added — a total token budget

- new config skills.autoRouteMaxTokens (default 15000): a session-wide
  cap over auto-loaded skill bodies — the already-loaded ones plus the new
  candidates, estimated at ceil(chars/4)
- over budget → the lowest-score additions are truncated first; each is
  announced with the exact log line
  [auto-router] Truncated: <name> (score <score>) — total cap hit
- the top-scoring skill always survives, and manual load_skill (24k
  per-skill cap) is NOT affected
- evidence: the repro's worst case went from 16144 uncapped tokens to
  14126 ≤ 15000 with the truncation log; pre-fix, the audit measured ~12.1k
  tokens/turn of skill bodies riding the system prompt, unbounded across
  re-routes

### Tests

- scripts/test-skills-router.ts: 73 → 112 checks (39 new regression checks
  covering the re-route under rule signals, word-boundary matching, the
  total token cap + truncation log, short-follow-up no-duplicate-loads,
  manual load_skill uncapped, and search_skills word-boundary); 5
  consecutive runs green
- full battery re-run green, matching the v0.30.0 release numbers; tsc
  total 124 → 117 (zero errors in the test file; the remaining 117 =
  106 pre-existing release baseline + 11 audit scripts, out of scope)

### Upgrade note

- drop-in patch: no config changes required — the new knob is optional;
  set skills.autoRouteMaxTokens only if you want a tighter or looser budget
EOF
)

BODY=${BODY//__VER__/$VERSION}
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — Hotfix: the re-route that never fired, whole-word keywords, a token budget" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
