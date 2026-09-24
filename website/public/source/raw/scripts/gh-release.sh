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
## v__VER__ — operating loop v2: PLAN · BUILD · TEST, verified finishes

The agent's operating contract is now a strict loop with teeth — same shape
for every project kind (web, CLI, bot, API, library, pipeline).

```
  PLAN ──► BUILD ──► TEST ──┬── PASS ──► ✅ SELESAI summary to the user
                           └── FAIL ──► BUILD (fix) ──► TEST ──► (loop)

  every failed round NEEDS a concrete hypothesis (why + what changes)
  blind trial-and-error is FORBIDDEN
  5 failed fix rounds → STOP, escalate: what was tried · the last error
                            verbatim · what is needed
```

### The work loop — PLAN · BUILD · TEST

- PLAN investigates the request AND the repo before writing the steps
  (PRD.md is the approved spec); BUILD implements step by step; TEST
  verifies for real — "should work" is not a result
- PASS means STOP: the final summary is delivered and the agent never
  keeps iterating on finished work
- hard cap: max 5 fix rounds, then escalation with the full story; real
  blockers (credentials, product decisions) escalate immediately

### The structured finish — ✅ SELESAI

Every finished task closes with the exact block (labels follow the
user's language):

```
✅ SELESAI
📌 Yang dikerjakan: what was done — the short story
📁 File yang diubah: every path touched + one-line why
🧪 Verifikasi: what you actually ran and the result — commands, counts
⚠️ Catatan: known gaps, follow-ups — or "-"
```

- the ✅ is EARNED by verification — untested work must say so under ⚠️
  instead of being claimed
- caveman mode keeps the structure, one telegraphic line per field

### TEST mode — same rigor on every stack

- per-kind methods baked into the QA persona: web (serve + browser +
  shots/vision) · CLI (real commands, exit codes, stdout/stderr, edge
  cases) · API (curl, status codes, payloads, auth) · bot (real channel,
  replies + side effects) · library (test suite, build, public API) ·
  pipeline (real sample data, output verified end-to-end)
- workflow restated stack-neutral: understand → start it → exercise →
  report — the web path stays the fully-detailed reference
- "reading the code is not testing" is now explicit

### Verification

- switch-mode suite extended to 52 checks (loop branches, numbered
  contract, max-5 + escalation, hypothesis rule, stack-agnostic,
  ✅ SELESAI block, caveman variant); testmode assertions restated (59)
- full battery green: subagents 71 · async-subs 40 · testmode 59 ·
  ask 41 · features 19 · context-loop 30 · browser 32 · v0190 71 ·
  v0220 25 · updater 31 · updater-source 33 · host · tui-app · cache
- additive again — every protected prompt contract survives (mode
  personas, MCP, ask_user, delegation, PRD/QA, switch_mode gate)
EOF
)

BODY=${BODY//__VER__/$VERSION}
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — operating loop v2: PLAN · BUILD · TEST, verified finishes" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
