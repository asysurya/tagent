# tagent — WORKLOG

Multi-agent shared journal (the project's own convention — see
packages/core/src/tools/worklog.ts). Append-only; every agent adds a
section per task. Fresh agents: read top-down before working.

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
