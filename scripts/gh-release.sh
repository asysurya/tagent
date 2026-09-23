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
## v__VER__ — async subagents: background work, 3-lane fallback, /config add/apply

Subagents no longer block. `task {background:true}` returns an id (a1, a2…)
INSTANTLY and the main agent keeps working while the sub runs detached in
the background. Reports flow back on their own — mid-run as injected
messages, or as an auto-resume when the agent already finished. The user
is never asked to babysit.

```
  task {background:true, agent:"test"}
     └─► "BACKGROUND SUBAGENT STARTED — a1 …"   (parent keeps working)

  sub finishes, agent mid-run   ──►  [SUBAGENT REPORT] injected next turn
  sub finishes, agent already done  ──►  agent auto-resumes, continues alone
  both cases: notify "subagent a1 finished — report delivered"
```

### Background subagents

- `task {background:true}` returns immediately with the sub's id — the
  parent loop never waits; fire several, they run in parallel
- report delivery in both directions: live loop → the report is injected
  as a `[SUBAGENT REPORT]` message mid-run; agent already finished → the
  host auto-resumes it in a fresh run — no user confirmation, ever
- multi-sub by design; the parallel limit is yours:
  `subagents.maxParallel` (default 4, cap 16) via `/config subs <n>`
- reports never strand: a no-action turn with a pending report takes one
  more turn; a dead loop's orphan subs are never aborted (stop-block
  checks loop.alive)

### Monitoring — subs everywhere

- agent-side: the `subs` tool — `subs` lists every background sub
  (id, kind, state, elapsed); `subs {id}` re-reads a finished report
- user-side: `/subs` live view in the TUI · `subs:view` RPC in the daemon
  (GUI) — the registry lives on the host, so both see the same truth

### Fallback is per-role now — 3 lanes

- three independent chains: **main** (the legacy `fallback` field) ·
  **subagent** (what task subs walk) · **vision** (the vision tool walks
  its own chain — failover tested end-to-end)
- `/fallback` reworked: `/fallback <main|subagent|vision> add|rm|clear`
  plus the full 3-chain view in one command (aliases: utama/sub/media)
- role overrides surface as lane primaries: a dedicated subagent or vision
  model sits at the head of its own chain

### /config is a template now — add · apply

- **add**: register things — MCP servers, provider+apikey+model, keys
- **apply**: a provider+model you already added → put it to work as the
  model for a role (**main · subagent · vision**) or as a **fallback**
  for any of the three lanes
- the dashboard: `+ add` · `⚡ apply` · `⛓ fallback` · `🤖 subs` (limit +
  view) · keys · sync (status/push/pull)

### Fixes & internals

- race fix: `chatSend`'s finally only clears ITS loop — a background
  deliver landing between runs no longer clears a fresh run's state
- 40 new hermetic checks (`scripts/test-async-subs.ts`): registry ids /
  limit / finish, immediate-return spawn, mid-run injection (the turn-4
  model call SAW the report), late delivery after run end, the subs tool,
  3-lane fallback, vision failover — every suite green
EOF
)

BODY=${BODY//__VER__/$VERSION}
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — async subagents, 3-lane fallback, /config add/apply" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
