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
## v__VER__ — Plugin decision hooks: a gatekeeper + a resolver

Two decision hooks join the plugin system — beforeToolCall (a gatekeeper
that runs BEFORE the permission gate) and onResolve (a capability resolver
contract) — plus subagent plugin inheritance and the Taceen scaffolding
(template + capability categories; the model itself is future work).
Drop-in: no config required, plugins stay optional — with no plugins loaded
the emit layer is bypassed entirely and nothing changes.

### Added — beforeToolCall: the gatekeeper before the permission gate

- fires on every tool call with { tool, input, risk, workspaceRoot,
  sessionId }, BEFORE permissions.gate()
- the contract — first block/modify across plugins wins:
  - {action:'allow'} or void → neutral, the call proceeds
  - {action:'block', reason, alternative?} → the call stops: record status
    'denied', output `Blocked by plugin: <reason>` (+ `Alternative: <alt>`
    on its own line) fed back to the agent on the same path as a permission
    denial; the permission gate and the tool run are skipped
  - {action:'modify', input} → the tool input is replaced; the record's
    input is updated too, so the transcript shows what actually ran
- fail-open: a hook that throws is logged and skipped — the call proceeds;
  a broken plugin never blocks the agent
- deviation from the original design snippet, on purpose: the record
  status is 'denied' (an existing ToolCallRecord value), not 'blocked'

### Added — onResolve: the capability resolver (contract now, call-site later)

- fires with { query, workspaceRoot, mode } and answers
  { available: [{type:'tool'|'mcp'|'plugin'|'skill', name, reason?}],
  unavailable?, hint? } — or void for "no answer"
- emitOnResolve merges answers across plugins (first hint wins; null when
  nobody answered)
- there is NO loop call-site yet — deliberate: this is the stable
  integration surface for Taceen (the main-agent/sub-agent wiring lands in
  a follow-up release); the contract + template ship first
- PermissionDecision grows optional reason? / alternative? — unconsumed
  prep for the gatekeeper ↔ permission-gate integration

### Added — subagents inherit plugins + MCP/plugin tools

- AgentLoopOptions.plugins? is new; spawnSubagent forwards plugins AND
  extraTools — spawned subagents (including background subagents, same
  code path) now run the gatekeeper and see the host-injected MCP/plugin
  tools
- e2e: a plugin denial inside a subagent is fed back into the sub
  conversation, and the report still reaches the parent
- host.ts passes the loaded plugins to the primary AgentLoop (one line) —
  without it the gatekeeper would never have fired in real CLI runs

### Added — the Taceen plugin template (prep work — no model yet)

Taceen is a planned small (~30–50 MB) local Python Tool & Capability
Resolver. This release ships the scaffolding it slots into — mock +
subprocess modes, everything fails open:

| File | What |
|---|---|
| `.tagent/plugins/taceen.mjs` | the plugin (mock + subprocess modes) |
| `.tagent/plugins/taceen.json` | config |
| `.tagent/taceen/taceen.py` | JSON-over-stdio skeleton (one line in, one out) |
| `docs/TACEEN.md` | developer doc (EN/ID) |

- config (defaults): enabled `true` · mode `"mock"` · pythonPath `"python3"`
  · taceenScript `.tagent/taceen/taceen.py` · timeoutMs `1500`
- mock mode: file/test/web keywords resolve heuristically to
  read_file / bash / mcp_browser_navigate; any bash command containing
  rm -rf is blocked with an alternative
- switch to subprocess mode with {"mode":"subprocess"} in taceen.json —
  onResolve and beforeToolCall then shell out to python3 with the JSON
  contract above
- the fallback rule (design invariant): any Taceen error or timeout →
  allow. Every hook body is try/catch → undefined; spawn failure, empty
  stdout, unparseable JSON and timeout all collapse to allow. Verified
  live with a 1 ms timeout and the missing-script path — the agent stays
  unblocked in every failure mode

### Added — capability categories (10 categories / 41 capabilities)

- .tagent/taceen/categories.json v1.0 + docs/CATEGORIES.md — the taxonomy
  the future resolver model consumes
- 10 functional cross-kind categories covering 41 capabilities: all 25
  registered tools + the 3 builtin skills + 13 representative MCP
  examples (the live MCP list is per-user config; these are demonstrative)
- two-stage answers: pick ONE category, return only that category's
  capabilities — ~30 tokens per entry, the full catalog under ~1.5k tokens
- docs/CATEGORIES.md records the 8 design answers (exposure, no-match
  fallback, multi-match ranking, MCP naming, skill handling) + 3 worked
  examples

### Tests

- new suite scripts/test-plugin-hooks.ts — 62 checks (hermetic mkdtemp
  roots, 5 consecutive identical runs): e2e block/modify through a real
  AgentLoop, the no-plugins path, subagent inheritance, 12 emit-layer
  units, and the real taceen plugin in mock/subprocess/disabled/
  missing-script modes — including the proof that the plugin fires BEFORE
  the bash blocklist (the /tmp sentinel survived an rm -rf attempt)
- scripts/smoke-plugin-hooks.ts — 8 sanity checks (persisted)
- full battery green, matching the release numbers: switch-mode 52 ·
  subagents 71 · testmode 59 · ask 41 · features 19 · context-loop 30 ·
  browser 32 · v0190 71 · v0220 25 · tui-app ALL PASS · host ALL OK ·
  version exit 0 · cache 38 · skills-router 112; source-site snapshot
  regenerated for this release (125 passed / 2 failed before the regen —
  it predated the loop.ts change)
- tsc: 117 total — 0 new vs the pre-change baseline

### Upgrade note

- drop-in: no config changes required — plugins stay entirely optional;
  with none loaded, the emit layer is bypassed and behavior is unchanged
EOF
)

BODY=${BODY//__VER__/$VERSION}
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — Plugin decision hooks: a gatekeeper + a resolver" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
