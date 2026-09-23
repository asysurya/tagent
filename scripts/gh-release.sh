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
## v__VER__ — the delegation stack: subagents, model roles, deep vision QA

Subagents are real now. The main agent can hand whole subtasks — or an
entire QA pass — to a focused sub-agent that runs in the same workspace,
reads files itself, and reports back. No recursion, no pasted file
contents: the prompt is a work order, not a data dump.

```
  task: verify pages
  ├─ kind "test" → read-only QA sub (serve + browser + vision)
  ├─ reads PRD.md / the workspace itself
  ├─ shots desktop+tablet+mobile → .tagent/test/shots
  └─ vision model → typography / responsive / contrast / a11y report
```

### Subagents — the task tool

- built-in kinds: **general** (full toolset like yours, minus spawning),
  **explore** (read-only recon), **test** (the QA kit — serve + browser +
  vision, read-only)
- subs run in YOUR workspace with the same file tools — they read whatever
  they need themselves, so prompts carry instructions + paths, never file
  contents
- no recursion: subs cannot spawn further subs, never face the user
- custom specialists: drop a markdown file in `.tagent/agents/` (or
  `~/.tagent/agents/`) — front-matter for model, tools whitelist, mode
  (build | plan | test), maxTurns; the body is its persona
- economy fast-path: plain "read file X" prompts never spawn a sub at all

### Three model roles, set independently

- `models.subagent` — what task-tool subagents run on
- `models.media.vision / .audio / .video / .pdf` — the analysis models;
  the vision tool routes screenshots to `media.vision`
- TUI: `/model subagent|vision|audio|video|pdf <provider/model>` ·
  `off` → follow main · interactive `/model` role picker
- GUI: a Model-roles dialog in the model dropdown

### Vision QA — image → model → report

- browser `shots` captures desktop + tablet + mobile in one call into
  `.tagent/test/shots`; pass the directory, a file, or a comma list to the
  vision tool (a directory takes its newest 4)
- the dedicated vision model returns a structured review: functionality,
  layout & alignment, typography scale, responsive comparison across
  viewports, color & contrast, accessibility — then a PASS/WARN/FAIL
  verdict with severity-tagged issues and suggested fixes
- no dedicated model? the main model is used when it accepts images —
  otherwise a setup error points at `/model media vision`

### Fixes

- **task {agent:"test"} ran the sub in the parent's mode** — a build-mode
  parent got a QA sub with a "your job is WORKING CODE" persona and
  write_file/edit_file available; only the session metadata said "test".
  The built-in test kind now genuinely runs read-only with the
  VERIFICATION persona and the full QA toolset (test_report, browser,
  vision, serve, bash, bg). The test suite's persona check was a tautology
  (`|| true`) and never caught it — the assertions now read the sub's
  actual system prompt (71 checks)
EOF
)

BODY=${BODY//__VER__/$VERSION}
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — subagents, model roles, deep vision QA" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
