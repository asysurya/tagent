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
## v__VER__ — the update that fixes updates; switch_mode; elite-executor prompt

`tagent update` never dead-ends again — every install kind recovers, every
failure prints the exact next command.

```
  version check: raw.githubusercontent → jsDelivr CDN → GitHub API
                 (one flaky host can't kill the check anymore)

  binary:  ↘ live progress meter
           ↘ interrupted? RESUME from where it stopped (3 attempts)
           ↘ SHA256-verified against the release's SHA256SUMS
           ↘ root-owned /usr/local/bin? rescued to ~/.local/bin — no sudo
  npm/bun: package 404s (tagent isn't on npm) → standalone binary fallback
  source:  detached HEAD recovered · bun-install failures reported
```

### tagent update — bulletproof by default

- the check walks a chain: TAGENT_UPDATE_URL → raw.githubusercontent.com
  → cdn.jsdelivr.net (fast in Asia, rarely blocked) → the GitHub releases
  API — 8s per hop, "could not reach the update endpoint" is gone
- binary downloads: live curl progress, 3 attempts resuming the partial
  file (`-C -`), stall detection (10 KB/s for 90s kills a hang), an 8 MB
  size floor, and SHA256 verification before anything is swapped in
- EACCES/EPERM on the swap (root-owned install dir) → the new binary is
  installed to `~/.local/bin` (usually EARLIER on PATH — takes over on
  the next launch, no sudo); worst case the one-line fix is printed
- a crashed run's verified download is reused, not re-fetched; downloads
  are async — the TUI no longer freezes during a 100 MB update
- npm/bun installs fall back to the standalone binary instead of a
  permanent 404; source installs surface `bun install` failures with the
  recovery command instead of printing "updated" over a broken tree

### switch_mode — PLAN → BUILD → TEST in one conversation

- the agent flips its own mode mid-run, but every flip is permission-
  gated: you see the target mode + reason, nothing changes until you
  approve; deny → "Permission denied" fed back, nothing changes
- approval swaps persona + toolset for the following turns, persists
  session.mode, fires mode:change → TUI navbar chip, GUI, relay viewers
- the loop it unlocks: plan approved → build; done → test; bugs → build
- primary agent only — subagents' modes stay fixed at spawn

### The operating prompt — elite-executor spec

- identity: autonomous engineer in the Codex / Claude Code / OpenCode /
  Aider league — end-to-end executor, not a chatbot
- language: ALWAYS mirror the user's language; code stays English-
  convention; to-the-point engineer tone
- explicit work loop: understand → plan → build → test with evidence;
  escalate after ~5 blind retries; switch_mode taught as the phase gate
- hard rules: never claim an untested pass, never edit unread files, no
  placeholders, no "should work"
- structured finishing summary: done · files · verification · notes · next
- additive rework — all protected prompt contracts survive

### Verification

- new hermetic suites: test-updater.ts (31 checks — endpoint chain,
  checksum refuse/corrupt/missing classes, EACCES rescue, swap),
  test-switch-mode.ts (46 checks)
- full battery green: subagents 71 · async-subs 40 · testmode 59 ·
  ask 41 · features 19 · context-loop 30 · v0190 71 · host · tui-app…
- live E2E: a compiled 0.26.0 binary updated itself against a real
  release — 101 MB asset downloaded, SHA256-verified, swapped in place,
  `--version` flipped to the new version
EOF
)

BODY=${BODY//__VER__/$VERSION}
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — the update that fixes updates; switch_mode; elite-executor prompt" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
