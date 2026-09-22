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
## v__VER__ — OAuth login: one button, no token hunting

`tagent auth --web` gets a **Connect with GitHub** button. Click it,
GitHub opens with the code pre-filled, press **Authorize**, done —
no creating tokens, no copy-pasting, no scopes to remember. The token
arrives in tagent's credential store without ever being typed.

```
  GitHub login — web connect

  ✔ browser opened — press Connect with GitHub, then Authorize
  waiting for the browser… Ctrl+C to cancel

  ✔ logged in octocat
  ⚙ config sync — pushed → octocat/tagent-config
```

### One-click OAuth (device flow, zero secrets shipped)

- the button appears when a GitHub OAuth App client id is configured:
  `TAGENT_GH_CLIENT_ID`, config `github.clientId`, or the id baked
  into the release — until then the page is the classic paste-a-PAT
  form, unchanged
- "Paste a token instead →" stays one click away even with OAuth on;
  the old flow never blocks you
- `tagent auth --device` now prints the one-click link too — GitHub
  opens with the code pre-filled instead of typing ABCD-1234
- `tagent auth` (picker) advertises "press Authorize on GitHub, done"
  when OAuth is live

### The flow under the button

- click → 302 to github.com/login/device/<code>?user_code=… → the
  CLI polls GitHub on its own clock until you authorize (or deny)
- the code shows on the page (with a copy button) if GitHub didn't
  open — UserLAnd/Termux friendly, same as before
- ✔ Connected card + the terminal continues into the v0.24 config
  bootstrap (private tagent-config repo, whole config sync)

### Fixes riding along

- device-flow `slow_down` no longer kills the poll loop — GitHub's
  back-off is honored now (was: fatal error)
- the login server lingers ~2s after success so the browser always
  gets its final "status: ok" poll and shows the ✔ card (was: the
  page could hit a dead port at the exact moment of success)
- security shape unchanged: loopback-only bind, one-time secret URL
  path, origin checks on POST, one-shot after login, `no-store`

### Setup (one-time, ship the button to every user)

GitHub requires a registered OAuth App for the flow. Create one at
github.com/settings/developers (any name, homepage = the tagent site,
callback = anything — device flow ignores it), then put the client id
in `TAGENT_GH_CLIENT_ID` or `tagent config github.clientId` — or bake
it into `BUILTIN_OAUTH_CLIENT_ID` in packages/core/src/github.ts and
every install gets the button by default.
EOF
)

BODY=${BODY//__VER__/$VERSION}
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — OAuth login: one button, no token hunting" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
