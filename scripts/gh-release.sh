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
## v__VER__ — Navbar machine stats & a context bar for every provider

Two navbar upgrades: the TUI title row now shows live machine stats
(CPU %, system RAM %, tagent's own RSS — sampled every 2 s), and the
context bar works for EVERY provider. Unknown models / custom providers
used to resolve a context window of 0 — which hid the bar entirely; the
display now falls back to an assumed 128k window, marked so you always
know what's real and what's estimated.

### Added — machine stats in the navbar

- new perf-stats.ts — PerfSampler: cpu % (delta between os.cpus()
  snapshots), system RAM % (freemem/totalmem), tagent's own RSS; a 2 s
  unref'd interval, O(1) get(), and a sample older than 15 s is
  recomputed on read (a suspended laptop no longer shows frozen numbers)
- the stats ride the title row's free dash space (roundBox titleRight,
  shown at boxW>=58): "🖥 12% · 💾 62% · 210M" — the border row stays
  EXACTLY boxW wide, hard-truncated both sides, never wrapped (the
  v0.31.1 sticky-math lesson applied from the start)
- numbers stay quiet by default — they only take color at cpu>=70% or
  RAM>=80% (the bar that matters when the machine is choking)

### Added — a context bar for every provider

- the gap, proven: modelContextWindow("custom", "mystery-model-v9")
  resolved 0 — custom providers and unlisted models showed NO context
  bar at all, while the loop already emitted estimated usage every turn
- new ASSUMED_CONTEXT_WINDOW = 128_000 (core/context.ts): the display
  falls back to it when the catalog, the registry and
  TAGENT_CONTEXT_WINDOW all miss — marked "~128k"; estimated usage is
  marked "~" too ("~12.3k/~128k [█░] 10%")
- precedence unchanged: TAGENT_CONTEXT_WINDOW and every real
  catalog/registry value always beat the assumption — a known model
  never gets a "~" it didn't earn

### Fixed — the bar survives (priority + hot-path)

- hint-row priority fit: a long custom model id shrinks first (down to
  4 cols) instead of crowding the context bar out of the row
- navbar footer ladder: segments shrink or drop in the order ws →
  model → -dev → -mcp → -ws → -model before the bar ever does — mode ·
  bar · clock survive at every width (verified live at 50 cols)
- host.contextInfo() gains a 500 ms cache — the estimated-usage path
  walked every session message and read zai-models.json per frame (a
  per-render hot path; a perf fix as much as a feature)

### /stats & tests

- /stats grows a machine row (cpu · ram · rss · uptime) plus the
  "(window assumed 128k)" / "(used estimated)" markers, so the numbers
  in the navbar are explainable
- new scripts/test-perf-stats.ts — 37 checks: sampler lifecycle
  (start/stop/stale-recompute), roundBox exact-width invariants,
  bar markers, the gap proof, the host fallback chain (unknown → assumed
  128k · glm → 131072 · env wins · fromLoop usage with no window), live
  TUI frames at 80/120/50 cols
- regression battery green: render-guard 27 · memory-profile 24 ·
  glitch-proof.py live-pty 6/6 (the render guard holds with the new
  navbar); tsc 117 = baseline, 0 new; PTY suite 10/11 — the one fail
  ("model list view") is pre-existing on a clean stash, recorded known

### Upgrade note

- drop-in: nothing to configure — the stats appear at boxW>=58, the
  context bar appears for every provider; if you know the real window
  of an unlisted model, TAGENT_CONTEXT_WINDOW=<tokens> beats the
  assumption
EOF
)

BODY=${BODY//__VER__/$VERSION}
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — Navbar machine stats & a context bar for every provider" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

ID=$(echo "$RELEASE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id') or '')")
URL=$(echo "$RELEASE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('html_url') or json.load(sys.stdin).get('message'))")
echo "[release] $URL"
if [ -z "$ID" ]; then
  # a re-run after a partial cut 422s with "already_exists" — adopt the
  # existing release and finish the missing assets instead of dying
  # (found live at the v0.31.1 cut: the upload loop is idempotent, the
  # release creation was not)
  RELEASE_JSON=$(curl -s -H "Authorization: token $TOKEN" "https://api.github.com/repos/$REPO/releases/tags/v$VERSION")
  ID=$(echo "$RELEASE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id') or '')")
  if [ -n "$ID" ]; then
    echo "[release] v$VERSION already exists (id $ID) — adopting it, uploading missing assets only"
  else
    echo "$RELEASE_JSON" >&2
    exit 1
  fi
fi

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
