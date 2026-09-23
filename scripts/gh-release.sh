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
## v__VER__ — the OAuth App is live: one-click login for everyone

The tagent OAuth App is registered and its client id ships inside every
binary — the **Connect with GitHub** button appears out of the box now:
no `TAGENT_GH_CLIENT_ID`, no config, no token hunting. One click,
**Authorize**, done — the token lands in tagent's credential store
without ever being typed.

```
  GitHub login — web connect

  ✔ browser opened — press Connect with GitHub, then Authorize
  waiting for the browser… Ctrl+C to cancel

  ✔ logged in octocat
  ⚙ config sync — pushed → octocat/tagent-config
```

### One-click login, on by default

- `BUILTIN_OAUTH_CLIENT_ID` is set — every install gets the button,
  `tagent auth --device` works without env vars, the GUI/TUI options
  light up
- client-id resolution is now env (`TAGENT_GH_CLIENT_ID`) → your config
  (`github.clientId`) → the bundled app — your config finally overrides
  the built-in one
- the device page opens with `?user_code=` appended — GitHub doesn't
  send `verification_uri_complete`, so we try the prefill ourselves;
  the page still shows the code big with a copy button as the fallback

### Fixes

- **fatal**: the device-code request went to `github.github.com` (a
  broken string replace) — GitHub answered 405 every time, so the
  v0.25.0 button never worked against real GitHub. Now it hits
  `https://github.com/login/device/code`
- the GUI host had its own client-id resolution (config → env, no
  builtin) — it could disagree with the CLI; both now share
  `getOAuthClientId`

### Still true from v0.25.0

- "Paste a token instead →" stays one click away — the PAT flow never
  blocks you
- device-flow `slow_down` backs off instead of dying; the login server
  lingers ~2s so the browser always shows the ✔ Connected card
- security shape: loopback-only bind, one-time secret URL path, origin
  checks on POST, one-shot after login, `no-store`
EOF
)

BODY=${BODY//__VER__/$VERSION}
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — one-click GitHub login, on by default" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
