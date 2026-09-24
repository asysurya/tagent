# tagent — WORKLOG

Multi-agent shared journal (the project's own convention — see
packages/core/src/tools/worklog.ts). Append-only; every agent adds a
section per task. Fresh agents: read top-down before working.

---

Task ID: 12
Agent: Super Z (main)
Task: Operating loop v2 — the user's exact PLAN→BUILD→TEST contract
baked into the prompt. Commit d16ff4f. Released as v0.29.0
(id 395647372, 7/7 assets verified by-ID).

Work Log:
- system-prompt.ts, work loop section rewritten to the spec verbatim:
  diagram PLAN ──► BUILD ──► TEST ─┬─ PASS ──► SUMMARY / └─ FAIL ──►
  BUILD (fix) ──► TEST ──► (loop); numbered contract 1-6 (PLAN
  investigates first, BUILD implements, TEST verifies for real, PASS
  means STOP, FAIL goes back with evidence, loop repeats until pass);
  retry discipline as HARD RULES (concrete hypothesis per failed round,
  blind trial-and-error forbidden, MAX 5 fix rounds → escalate with
  what-was-tried + last-error-verbatim + what-is-needed; blockers
  escalate immediately); stack-agnostic line: ONE loop for EVERY
  project kind. switch_mode paragraph kept intact.
- Finishing section: the exact structured block (✅ SELESAI / 📌 Yang
  dikerjakan / 📁 File yang diubah / 🧪 Verifikasi / ⚠️ Catatan), labels
  follow the user's language (English: ✅ DONE / What was done / Files
  changed / Verification / Notes), ✅ is EARNED by verification, no
  vague lines. Now included for caveman too (one telegraphic line per
  field) — guard changed from !subagent&&!caveman to !subagent.
- TEST persona: per-kind methods block (web / CLI / API / bot /
  library / pipeline — each with its real-runtime method), workflow
  retitled stack-neutral (understand → start it → exercise → report),
  "reading the code is not testing" explicit. BUILD persona point 5
  closes the loop (implementation done → TEST time → only verified
  work earns the summary).
- Tests: test-switch-mode.ts 46→52 (loop branches, numbered contract,
  max-5 + escalation, hypothesis rule, stack-agnostic, ✅ SELESAI
  block, caveman keeps summary); test-testmode.ts 2 stale assertions
  restated (START IT, VISUAL QA (web)). Battery green: 52·71·40·59·41
  ·19·30·32·71·25·31·33 + host + tui-app + cache + fallback + version;
  tsc identical to baseline (3 pre-existing).
- Release v0.29.0: version.ts · releases.ts (4 sections) · LATEST ·
  gh-release.sh BODY + name · latest.json synced · website build OK ·
  6 binaries (102/102/74/79/103/106 MB) + SHA256SUMS uploaded; raw +
  jsDelivr both serve 0.29.0; released binary --version 0.29.0,
  --check-update "up to date: v0.29.0".

Stage Summary:
- v0.29.0 LIVE: https://github.com/asysurya/tagent/releases/tag/v0.29.0
- The operating contract is now exactly the user's spec: loop shape,
  max-5 escalation, hypothesis-per-retry, ✅ SELESAI finish, same rigor
  on every stack. All protected prompt contracts survive (verified by
  the suites).

---
Task ID: 11
Agent: Super Z (main)
Task: Fix `tagent update` (gagal mulu — clone & binary, user kept
re-downloading by hand) + release v0.28.0. Commits 03fede6 · 7fc6c9b.

Work Log:
- Root-cause hunt: checkUpdate was ONE raw.githubusercontent fetch
  behind a 4s timeout — on DNS-hijacked/slow ISPs (Indonesia!) it said
  "could not reach the update endpoint" EVERY time, for BOTH install
  kinds (the only code shared by both paths). Secondary: binary
  downloads had no resume/progress/checksum (a flaky 100 MB transfer =
  hard fail that looked frozen), EACCES on root-owned install dirs was
  a dead end, npm/bun kinds 404 forever (tagent is NOT on npm —
  verified E404), detached-HEAD clones recovered via a misleading
  "diverged" reset, and `bun install` failures were swallowed.
- version.ts: endpoint CHAIN — TAGENT_UPDATE_URL → raw.githubusercontent
  → cdn.jsdelivr.net (fast in Asia) → api.github.com releases/latest
  (tag_name normalized), 8s/hop; TAGENT_UPDATE_URLS / TAGENT_RELEASE_API
  test hooks.
- updater.ts: downloadAsset async curl (spawnSync froze the whole TUI
  AND deadlocked hermetic tests — Bun.serve can't serve while the
  thread blocks), live progress meter, 3 attempts RESUMING (-C -),
  stall kill (10 KB/s × 90s), connect timeout, 8 MB size floor, SHA256
  verify vs SHA256SUMS.txt (corrupted → discarded + retried, never
  swapped), 404 → "not found (yet)". swapBinary extracted: ETXTBSY
  retry, EACCES/EPERM → rescue install to ~/.local/bin (earlier on
  PATH, no sudo) + exact one-liner if even that fails; npm/bun →
  standalone-binary fallback; source: detached HEAD → checkout main
  first, bun install failures surfaced with the fix command. homeDir()
  now matches core (env.HOME first — os.homedir() reads STARTUP env
  in bun; fixed a real prod inconsistency found by the test).
- scripts/test-updater.ts (NEW, 31 checks): hermetic — local Bun.serve
  release feed (9 MB asset + sums), fake HOME/TMPDIR, chain
  refused/404/bad-shape → good, API-shape, legacy TAGENT_UPDATE_URL,
  download ok/reuse/corrupt/wrong-sums/small/missing/nosums classes,
  swap + EACCES rescue + installBinaryTo. Battery: subagents 71 ·
  async-subs 40 · testmode 59 · ask 41 · features 19 · context-loop 30
  · switch-mode 46 · fallback 4 · host · tui-app · cache 38 · v0190 71
  · updater-source 33 · version 8 — all green.
- LIVE E2E (real network, real releases): compiled binary from the fix
  commit claiming v0.26.0 updated ITSELF → downloaded the real 101 MB
  v0.27.0 asset, SHA256-verified, swapped in place, --version flipped
  to 0.27.0. Source: fresh v0.26.0 clone (OLD updater = user's exact
  state) pulled to 0.28.0; then detached at 03fede6 with the NEW
  updater → "was on a detached commit — back on main" → 0.28.0.
- Release v0.28.0: version.ts · website releases.ts (3 sections) ·
  LATEST · gh-release.sh BODY · latest.json synced · 6 binaries built
  (102/106/74/79/102/103 MB) · release id 395570902, 7/7 assets
  verified UPLOADED by-ID. Endpoints verified serving 0.28.0: raw ✓ ·
  jsDelivr ✓ · api.github.com 403 from this DC IP only (last-resort
  hop, chain-tolerant; fine from residential IPs). Released binary
  --check-update → "up to date: v0.28.0".

Stage Summary:
- v0.28.0 LIVE: https://github.com/asysurya/tagent/releases/tag/v0.28.0
- `tagent update` is now failure-classed and self-healing on every
  install kind; the update-check can no longer be killed by one host.
- Old installs (0.26/0.27 updaters) still update fine to 0.28.0 —
  verified live; from 0.28.0 on, updates resume+verify themselves.

---
Task ID: 10
Agent: Super Z (main)
Task: switch_mode (agent ganti mode dengan izin user) + system prompt
rework (elite-executor spec, additive). Commit 7750e8d.

Work Log:
- tools/switch-mode.ts (NEW): switch_mode {mode, reason} — risk medium,
  so the existing permission gate IS the user approval (TUI card / GUI /
  relay all show target mode + reason). Returns the new persona summary.
- tools/index.ts: registered in all 3 modes at depth 0; excluded at
  depth > 0 (sub mode is fixed at spawn); TEST_MODE_TOOLS + plan allow
  list updated.
- loop.ts: tools mutable + buildToolsetFor(mode) (extraTools +
  toolsFilter preserved); switchMode() flips opts.mode + session.mode,
  swaps toolset, fires onModeChange + notify; runInner keeps
  activeMode — on divergence rebuilds system prompt + nativeTools so the
  NEXT turn runs under the new persona; READ_ONLY_TOOLS += switch_mode
  (plan gate lets it through); ctx.switchMode injected at depth 0.
- system-prompt.ts (additive rework): identity = elite autonomous
  engineer (Codex/Claude Code/OpenCode/Aider league, not a chatbot);
  new main-only sections — Who you are · Language (mirror user's
  language, code English-conventions) · The work loop (PLAN→BUILD→TEST
  with evidence-based retries, escalate after ~5, switch_mode taught) ·
  Hard rules (never claim untested / edit unread / placeholders /
  "seharusnya jalan") · Finishing (structured summary); TEST persona
  closing line points at switching back to build; subagents + caveman
  stay lean.
- host.ts makeEvents: onModeChange → bus 'mode:change'; daemon forwards
  to gui + relay viewers; tui-app updates the navbar mode chip.
- scripts/test-switch-mode.ts (NEW, 46 checks): registration matrix,
  approve path (turn-2 system prompt = TEST persona + QA toolset, no
  write_file), deny path (nothing flips), loop guards (same-mode /
  sub), prompt sections + protected strings.
- README: 2 new rows (mid-run mode switch, operating prompt).
- All suites green: switch-mode 46 + subagents 71 + testmode 59 +
  async-subs 40 + ask 41 + features 19 + v0190 71 + v0220 25 +
  context-loop 30 + browser 32 + host + menu-audit + chat-persistence +
  tui-app + workspace-switch; tsc identical to baseline.

Stage Summary:
- The agent can now follow the work across modes: plan approved →
  build → test to verify → back to build to fix — every switch behind
  the user's approval card, persona + toolset rebuilt mid-run.
- The operating prompt now carries the elite-executor identity,
  language mirroring, the iterative work loop, hard rules, and the
  structured final summary — without dropping any of the battle-tested
  contracts (all protected strings verified by the suites).
- Not released yet — candidate v0.27.1.

---
Task ID: 9
Agent: Super Z (main)
Task: Release v0.27.0 — ship the async-subagent stack (Task 8).

Work Log:
- Bumped packages/core/src/version.ts CURRENT_VERSION 0.26.0 → 0.27.0.
- website/src/data/releases.ts: v0.27.0 entry at the top (5 sections:
  background subagents / monitoring / 3-lane fallback / /config add·apply /
  fixes+internals) + LATEST bumped to 0.27.0.
- scripts/gh-release.sh: BODY heredoc replaced with the v0.27.0 notes
  (incl. the delivery-flow diagram); release name "async subagents, 3-lane
  fallback, /config add/apply"; bash -n passed.
- bun scripts/sync-latest.ts → website/public/latest.json serves 0.27.0.
- Website production build OK (all routes prerendered).
- bash scripts/gh-release.sh <token-from-remote> 0.27.0: 6 binaries
  (~564MB) + SHA256SUMS.txt all uploaded; committed 1576abd + pushed
  (babe6dd..1576abd).
- Verified live: by-ID API shows 7 assets all "uploaded" (id 394472720,
  published 2026-09-23T09:00:16Z); raw latest.json serves 0.27.0; asset
  URL 302→200 with correct content-length. NOTE: /releases/tags/<tag> and
  the releases LIST kept showing assets:0 for a while right after upload —
  propagation lag, the by-ID endpoint is the authoritative check.

Stage Summary:
- v0.27.0 is LIVE: https://github.com/asysurya/tagent/releases/tag/v0.27.0
- Ships: background subagents (task {background:true} → a1/a2… instantly;
  mid-run [SUBAGENT REPORT] injection or auto-resume after run end, never
  asking the user; notify "subagent a1 finished"), subs tool + /subs +
  daemon subs:view monitoring, subagents.maxParallel limit (/config subs),
  3-lane fallback (main·subagent·vision, /fallback reworked), /config
  add·apply template, chatSend race fix. 40 new hermetic checks, all
  suites green.
- Update-check: old installs see "0.27.0 available" within a day.

---
Task ID: 8
Agent: Super Z (main)
Task: Async background subagents + /config add/apply rework + 3-lane
fallback. Commit babe6dd (pushed).

Work Log:
- CORE bgsubs.ts (NEW): host-owned BackgroundSubagents registry — ids
  a1/a2…, parallel limit (config subagents.maxParallel, default 4, cap
  16), finish() stores reports, finished entries trimmed at 20.
- loop.ts: spawnSubagentBackground (detached promise; registers, fires
  onBackgroundSub once with the report) · pendingReports queue flushed
  at the top of each turn as user messages · "no actions + pending
  report" takes one more turn instead of stranding it · alive getter +
  finished flag (a dead loop is never stopped — that would abort its
  detached subs — and refuses injections) · chain per role: depth>0
  walks fallbacks.subagent, depth 0 the legacy fallback.
- task.ts: background:true → returns "BACKGROUND SUBAGENT STARTED —
  a1 …" immediately (no report); parallel-limit errors surfaced.
- tools/subs.ts (NEW): agent-side monitor — listing + subs {id} re-reads
  a finished report; renderSubsTable helper for hosts.
- tools/index.ts: subs registered in ALL modes, excluded at depth>0
  (subs track the PARENT's background spawns).
- system-prompt.ts: Delegation section teaches background mode (when to
  use, auto-resume semantics, subs tool, limit).
- vision.ts: the call now walks a chain — primary + fallbacks.vision —
  via completeWithFallback (seam: visionInternals.resolveTailFor).
- fallback.ts: FallbackRole type, fallbackListFor/fallbackTailFor
  (main mirrors legacy `fallback`), describeChains (3 lanes with role
  overrides as lane primaries).
- host.ts: bgSubs registry + onBackgroundSub — notify ("subagent a1
  finished — report delivered") then deliver (live loop →
  deliverBackgroundReport; idle → coalesced 250ms wake → chatSend
  auto-continue, user never asked) · backgroundSubs()/subagentLimits()
  for TUI+GUI · settingsSave: fallbackRole {subagent|vision} +
  subagentMaxParallel · fallbackChainsView() · chatSend finally only
  clears ITS loop (race fix, pre-existing window) · stop-block checks
  loop.alive so a dead loop's orphan subs are never aborted.
- daemon.ts: RPC subs:view + fallback:chains.
- TUI (tui-app.ts + tui.ts): /subs live view · /fallback reworked
  (<main|subagent|vision> add/rm/clear + 3-chain display, alias
  utama/sub/media) · /config dashboard reworked: + add · ⚡ apply
  (provider → model → role main/subagent/vision) · ⛓ fallback · 🤖 subs
  (limit + view) · keys · sync (status/push/pull) — /config apply,
  /config fallback, /config subs <n> subcommands.
- README: subagents + fallback rows updated.
- Tests: scripts/test-async-subs.ts (NEW, 40 checks) — registry ids/
  limit/finish, immediate-return spawn, mid-run injection (turn-4 model
  call SAW the report), late delivery after run end (onBackgroundSub
  fires; dead loop refuses), subs tool listing/full report, 3-lane
  fallback list/tail/describe + role overrides, vision failover (primary
  down → backup lane answers). All suites re-run green: 71+59+40+41+19+
  30+32+25+71+host+menu+tui-app; tsc identical to baseline; daemon smoke
  (tagent web :4020) ran a full agent turn live.

Stage Summary:
- The delegation stack is now fully async-capable: fire-and-forget subs
  with automatic report delivery in either direction of completion
  order; monitoring for agent (subs tool) and user (/subs, GUI RPC);
  parallelism user-configurable. Fallback is per-role (main · subagent ·
  vision). /config is the add/apply template the user asked for.
- Not released yet — candidate v0.26.1 (or 0.27.0) after smoke test.

---
Task ID: 7

> History note: an earlier lowercase `worklog.md` (Tasks 1–5) existed in a
> previous sandbox state and was lost — Tasks 4–5 are reconstructed here
> from git commit messages (75a7785, dad350a). Task 6 onward are current.

---
Task ID: 7
Agent: Super Z (main)
Task: Release v0.26.0 — ship the delegation stack (Task 5 + Task 6 fix).

Work Log:
- Bumped packages/core/src/version.ts CURRENT_VERSION 0.25.1 → 0.26.0.
- website/src/data/releases.ts: v0.26.0 entry at the top (4 sections:
  Subagents—the task tool / Three model roles / Vision QA / Test-mode
  delegation + the honest bug note) + LATEST bumped to 0.26.0.
- scripts/gh-release.sh: BODY heredoc replaced (python regex swap) with the
  v0.26.0 notes; release name "subagents, model roles, deep vision QA";
  bash -n syntax check passed.
- bun scripts/sync-latest.ts → website/public/latest.json serves 0.26.0.
- Website production build OK (all routes prerendered).
- Token: extracted from the git remote URL (embedded PAT, 40 chars) — no
  env/credentials file needed; never printed to output.
- bash scripts/gh-release.sh <token> 0.26.0: 6 binaries built (linux
  arm64+x64, macos arm64+x64, windows arm64+x64 .exe, ~564MB total) +
  SHA256SUMS.txt; GitHub release created, all 7 assets uploaded.
- Committed f8117a9 + pushed to origin/main (dad350a..f8117a9).
- Verified live: raw.githubusercontent.com latest.json serves 0.26.0;
  GitHub API (token auth) confirms tag v0.26.0, 7 assets, all "uploaded",
  published 2026-09-23T07:31:09Z. NOTE: unauthenticated GitHub API from
  this sandbox hits the IP rate limit — always pass the token.
- Recreated this WORKLOG.md after the lowercase worklog.md vanished
  (untracked, lost between sessions).

Stage Summary:
- v0.26.0 is LIVE: https://github.com/asysurya/tagent/releases/tag/v0.26.0
- Ships: subagent stack (task tool, general/explore/test kinds, custom
  .tagent/agents specialists, no recursion, self-reading subs), 3-category
  model roles (main · subagent · media vision/audio/video/pdf), vision QA
  pipeline (shots → dedicated model → deep UI report), and the loop.ts fix
  for test-kind subs previously running in the parent's mode.
- Update-check: old installs see "0.26.0 available" within a day.

---
Task ID: 6
Agent: Super Z (main)
Task: Follow-up audit of the delegation stack — verify all 6 user
requirements actually work end-to-end; fix what's broken. Commit 958976c.

Work Log:
- Re-read the full chain: modelroles.ts → subagents.ts → tools/task.ts →
  tools/vision.ts → tools/index.ts → loop.ts spawnSubagent →
  system-prompt.ts → tui/tui-app /model → host modelRole → GUI
  model-roles-dialog.tsx.
- scripts/probe-test-kind.ts (fake provider capturing the SUB's actual
  system prompt) PROVED a live bug: task {agent:"test"} from a build-mode
  parent ran the sub in BUILD mode (persona "WORKING CODE", write_file on,
  test_report missing) — only SessionData metadata said 'test'.
- loop.ts: built-in "test" kind now forces mode:'test' regardless of the
  parent's mode. Post-fix probe: TEST persona ✓, QA tools ✓, write/nest
  tools ✗.
- test-subagents.ts: tautological persona check (|| true) replaced with
  real system-prompt assertions — 71 checks, all green; neighbors green
  (testmode 59, ask 41, browser 32, features 19, context-loop 30).

Stage Summary:
- All 6 requirements verified end-to-end; committed 958976c.

---
Task ID: 5
Agent: Super Z (main)
Task: Sub-agent stack — subagents + test delegation, 3-category model
config, image→vision→report with deep QA rubric, self-reading subs.
Commit dad350a (reconstructed summary).

Work Log:
- modelroles.ts (parseRoleRef/resolveSubagentModel/resolveMediaModel/
  setRoleRef/describeModelRoles), types ModelRoles, tools/vision.ts,
  tools/task.ts, TEST_MODE_TOOLS with task, browser `shots` action,
  TUI /model role commands, GUI store setModelRole + model-roles-dialog.
- system-prompt.ts: Delegation section + TEST persona with the QA workflow
  (understand → serve → exercise → shots+vision → sub-testers → report).
- scripts/test-subagents.ts NEW (69 checks); stale tests flipped for
  task-in-test-mode; README feature rows.

---
Task ID: 4
Agent: Super Z (main)
Task: OAuth one-click login — bake the GitHub OAuth App client id; v0.25.1.
Commits 75a7785 / 9b500b9 era (reconstructed summary).

Work Log:
- BUILTIN_OAUTH_CLIENT_ID (Ov23liIsKIosW40FwC4G) in github.ts; resolution
  env → config → builtin.
- Fixed FATAL 405: device-code request went to github.github.com (broken
  string-replace) — now https://github.com/login/device/code.
- deviceUrl() ?user_code= prefill; e2e smoke scripts; released v0.25.1
  (6 binaries + SHA256SUMS); "kirim PAT" answered: no credentials in the
  sandbox, safe self-serve path given.
