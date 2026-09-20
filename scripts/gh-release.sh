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
## v__VER__ — context window bar + deterministic memory compaction

The context window is now a first-class citizen: a live opencode-style usage
bar under the chat input, a 80% compact prompt, and a `/compact` that
summarizes old turns with **zero AI calls** — nothing invented, everything
copied from the transcript. Updates also became bulletproof: stuck merges
self-recover and `~/.tagent` is snapshotted before every update.

### The context bar

```
build · glm-4.7 · 12.3k/131.1k [██████░░░░] 9% · 14m
```

- live every turn — provider token usage when the API reports it, a local
  CJK-aware estimate otherwise; color-coded green / yellow / red at 60% / 80%
- model windows resolve from `~/.tagent/zai-models.json` (new `contextWindow`
  field per model), provider seeds, or id heuristics — `TAGENT_CONTEXT_WINDOW`
  overrides everything
- `/stats` and the boot banner show it too

### `/compact` — ringkas memory, tanpa AI

- at **80%** (configurable: `compact.threshold`) the run ends with a one-key
  y/N prompt; `/compact [keep-tokens]` any time, also in the ctrl+x menu
- old turns become ONE structured digest — who asked what, which tools ran on
  which paths, statuses, decisions — while the newest ~10k tokens stay
  verbatim. A 100k-token history lands near 10k
- **deterministic local code, no AI call, nothing generated** — every digest
  line is copied from the transcript, so nothing can be hallucinated and the
  compaction itself costs zero tokens (it must never spend your model to save
  your tokens)
- `@file` attachment bodies drop out of old turns (files live on disk);
  re-compaction folds the prior digest in, history never duplicates

### Caveman mode, reworked — summarize, never blind-cut

- big tool outputs become **head+tail digests** with explicit
  `…[compacted: N chars elided]…` markers instead of a silent mid-cut — the
  model always knows exactly what it did not see
- repeated lines collapse (`(×N)`), pretty JSON minifies losslessly
- old `write_file`/`edit_file` echoes are slimmed to path + preview — whole
  file contents stopped being re-sent forever (the newest 2 turns stay full)
- old tool results become per-tool digests (tool + input + status); caveman
  starts dieting at 80k instead of 150k

### Updates — never blocks, never loses data

- a **stuck conflicted merge** ("bun.lock: needs merge" / "you have unmerged
  files" — the state that killed both `git stash` and `git pull`) now
  self-recovers: the in-progress operation is aborted, the index cleared,
  your files kept
- a diverged branch no longer blocks the update: fetch + reset to the upstream
  tip, with the reflog recovery path printed
- `~/.tagent` (auth, MCP, config, models, memory) is snapshotted into
  `~/.tagent/backups/update-<timestamp>/` before EVERY update and verified +
  restored after — the 5 newest snapshots are kept

---

## Single-file binaries: download, run, done

One self-contained executable per platform — like the Node.js/Python
downloads. No runtime, no install, no clone: grab the file for your OS,
run it, and both the TUI and the browser GUI just work (the web GUI is
embedded inside the binary and self-extracts on first run).

| File | Platform |
| --- | --- |
| `tagent-v__VER__-windows-x64.exe` | Windows 10+ (64-bit) |
| `tagent-v__VER__-windows-arm64.exe` | Windows 10+ on ARM |
| `tagent-v__VER__-linux-x64` | Linux (glibc, 64-bit) |
| `tagent-v__VER__-linux-arm64` | Linux ARM64 (incl. Raspberry Pi 5) |
| `tagent-v__VER__-macos-x64` | macOS Intel |
| `tagent-v__VER__-macos-arm64` | macOS Apple silicon |

| `SHA256SUMS.txt` | checksums for everything above |

Also linked from the website's [download page](https://tagent-website.vercel.app/download),
which auto-detects your platform.

### Native Windows — no WSL needed
- The builds run the full stack natively: TUI, daemon, web GUI, relay, the 40-provider catalog
- The bash tool uses Git for Windows' bash.exe (auto-detected, override with `TAGENT_BASH`); `tagent doctor` tells you if it's missing
- Home/config/sessions live in the real Windows user profile (`~/.tagent` via USERPROFILE)
- Windows 10+ 64-bit is required (Windows 7/8 and 32-bit are no longer covered)

**Install / upgrade**

```bash
# Linux / macOS
chmod +x tagent-v__VER__-linux-x64 && ./tagent-v__VER__-linux-x64 doctor
# Windows (PowerShell) — the .exe runs as-is
.\tagent-v__VER__-windows-x64.exe doctor
```

**Verify a download**

```bash
sha256sum --check SHA256SUMS.txt   # certutil -hashfile <file> SHA256 on Windows
```
EOF
)
BODY=${BODY//__VER__/$VERSION}
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — context window bar + deterministic memory compaction" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
