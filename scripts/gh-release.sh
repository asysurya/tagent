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
## v__VER__ — Config sync: one private repo, every device

Log in once and tagent now creates a private `tagent-config` repo that
carries your WHOLE global config — providers, api keys, MCP servers,
models, permissions, theme — sealed with AES-256-GCM and identical on
every device. `/config` is the new cockpit (push · pull · add mcp ·
add provider · keys), providers can hold SEVERAL named api keys, and
`tagent start` warns every boot if the repo gets deleted on GitHub.

```
\u2699 config sync \u2014 pushed \u2192 octocat/tagent-config
\u2570\u2500 \U0001F916 build \u00b7 \U0001F4C2 tagent-proyek \u00b7 glm-4.7 \u00b7 \U0001F50C 2\u2713 31 \u00b7 4m \u2500\u256f
```

### The config repo — auto-created on auth

- `tagent auth` (terminal, TUI /auth, web GUI) ensures a PRIVATE
  login/tagent-config repo and pushes the global config into it —
  the GitHub token never leaves the device's credential store
- the vault carries everything: default provider/model, api keys,
  the keychain, custom providers, MCP servers, permissions, fallback
  chain, theme, caveman, compact, cache, diagnostics
- pull = remote wins per key; push = local wins; conflicts abort
  with "nothing was lost" — a defaults-only device can never
  clobber a richer remote (every bootstrap pulls first)

### /config — the global cockpit

- `/config push` \u00b7 `/config pull` \u2014 explicit whole-config sync;
  `/config status` shows repo health (exists / deleted / offline),
  last push & pull, key counts per provider
- `/config add mcp` \u2014 global servers (every project, hot-loads in the
  current one too); `/config add provider`; `/config use <prov>/<model>`
  sets the global default
- `/config keys` \u2014 the multi-key manager: \u25cf active / \u25cb idle,
  switch, remove, or stack a key into the fallback chain

### Multi-key everywhere

- several named keys per provider ("work", "backup", "free tier");
  the ACTIVE one stays apiKeys[provider] so every resolution path
  works untouched
- `/model` asks which key to use when a provider has several;
  `/apikey` registers every key into the keychain (first = "main")
- the keychain rides the config repo AND the project vault, so it
  shows up on every device

### Boot health + doctor

- every `tagent start`: repo deleted \u2192 yellow banner (until
  /config push recreates it); remote moved \u2192 pulled + applied;
  local moved \u2192 pushed \u2014 devices converge with zero clicks
- offline stays silent, the next start checks again; existing
  installs bootstrap the repo lazily after upgrading
- `tagent doctor` reports the config repo + the keychain
EOF
)

BODY=${BODY//__VER__/$VERSION}
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — Config sync: one private repo, every device" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
