# tagent — WORKLOG

Multi-agent shared journal (the project's own convention — see
packages/core/src/tools/worklog.ts). Append-only; every agent adds a
section per task. Fresh agents: read top-down before working.

---

Task ID: 16
Agent: Super Z (main)
Task: search_skills tool + skill auto-router (v0.30.0) — two-stage
progressive disclosure + proactive skill loading.

Work Log:
- packages/core/src/types.ts: SkillMeta += usage?/tags?/matchScore?/
  matchReason? (all optional — backward compatible); TagentConfig +=
  skills { autoRoute, autoRouteMax, autoRouteThreshold }.
- packages/core/src/skills.ts: scanDir parses front-matter usage: +
  tags: (comma-separated; usage falls back to the body's first
  paragraph, tags to []); mtime cache in listSkills (key root+dirs,
  dirMtime = max dir + every child SKILL.md); session registry
  (auto/manual loaded lists, routing flags) + helpers; NEW
  searchSkillsTool (query/tags/limit, read-only); loadSkillTool records
  manual loads; fixed pre-existing '../types' import (tsc).
- packages/core/src/skill-router.ts (NEW): routeSkills — rule hits
  (package.json deps: next/react/discord.js/telegraf/express-family;
  Dockerfile/tsconfig.json; app/·src/pages·src/api; .py density; PRD.md
  hints) score 0.9, keyword groups score 0.5–0.7 capped, threshold
  filter + score sort + max slice; maybeAutoRouteSkills (loop hook —
  initial route + 1 topic-shift re-route by token-overlap <20%, budget
  only burns when something loads); rerunSkillRouter (/reload-skills);
  capAutoBody (8k, paragraph boundary); 🎯 notice + [auto-router]
  WORKLOG entry via worklogTool.
- packages/core/src/loop.ts: one maybeAutoRouteSkills call per run
  (primary agent only) + autoSkills passed to the system prompt +
  'search_skills' in READ_ONLY_TOOLS (plan-mode gate).
- packages/core/src/system-prompt.ts: "How to use skills — two-stage
  progressive disclosure" + "Auto-loaded skills" section
  (renderAutoLoadedSkillsBlock: list + bodies).
- packages/core/src/tools/index.ts: searchSkillsTool registered in
  ALL_TOOLS (before load_skill) + TEST_MODE_TOOLS + RO_NAMES.
- packages/cli/src/tui-app.ts + tui.ts: /skills (loaded with
  [auto]/[manual] badges; all = installed) · /reload-skills ·
  /no-auto-skill · /unload-skill — full parity both TUIs, palette +
  help rows updated.
- builtin-skills/*: usage + tags front-matter on the three shipped
  skills. README.md: Skills feature row + two-stage/auto-router
  section. docs/USERLAND.md is a phone-setup guide (no skill docs →
  docs/ section skipped per spec).
- Release: version.ts 0.30.0, releases.ts + LATEST, gh-release.sh BODY,
  sync-latest, source snapshot regen (332 files · 70,027 lines), website
  build clean; test-source-site.ts hardened (version + loop.ts line
  count now read dynamically, 127 checks green).

Stage Summary:
- scripts/test-skills-router.ts NEW — 73 checks ALL GREEN (stable 5x):
  registration/mode gating, output shape, query/tags/limit, two-stage
  flow + token economy, cache <50ms + invalidation, router J/K/L
  scenarios, scoring + threshold/max, config disable (M), topic shift
  (S), slash logic N/O/P, transparency (Q: 🎯 + WORKLOG), prompt
  rendering, perf (R: 0.26ms/50 skills), AgentLoop end-to-end (fake
  provider: notice fires, body rides the prompt, search_skills executes
  through the permission gate).
- Battery green: switch-mode 52 · subagents 71 · testmode 59 · ask 41 ·
  features 19 · context-loop 30 · browser 32 · v0190 71 · v0220 25 ·
  tui-app · host · version · cache · source-site 127. tsc: 106 vs 107
  baseline (1 pre-existing fixed, 0 new).

---

Task ID: 15
Agent: Super Z (main)
Task: The /source/ls API — queryable per-folder listings over the snapshot
(`ls` for the codebase over HTTP). Website-only (no CLI change).

Work Log:
- Endpoints (Next.js App Router, `src/app/source/ls/**`, all thin
  force-dynamic adapters over one shared handler):
  · GET /source/ls?path=&recursive=&depth=&all=&detail=&layer= — list one
    folder flat, or a nested tree when recursive=true (depth = levels of
    entries visible below path, default 1, max 8; at the cut, dir nodes
    carry a children COUNT instead of the array).
  · GET /source/ls/find?q=&layer=&limit= — name-first ranked search over
    files AND folders (limit default 50, max 200, truncated flag).
  · GET /source/ls/stat?path=<file> — one file: size, lines, language,
    lastModified, the JSDoc-header summary, raw/json/dir URLs. Dirs are
    rejected with a 400 pointing at /ls.
  · GET /source/ls/quickref — the curated where-is-what map (25 entries:
    system prompt, agentic loop, updater, model roles, …), validated
    against the snapshot at request time; stale entries are reported,
    never silently dropped.
- Every endpoint speaks JSON by default and plain text (`tree`-style
  glyphs, `ls`-readable) with `Accept: text/plain` or `?format=text`.
  Headers: content-type, `cache-control: public, max-age=600,
  s-maxage=3600`, `vary: Accept`.
- The engine: website/src/lib/source-ls.ts — framework-free, imports the
  generated SOURCE_SNAPSHOT module (byte-identical to index.json), builds
  ONE in-memory index per instance: no filesystem access, no per-request
  rescans, `snapshot: { version, generatedAt }` in every response is the
  build stamp. Layer filter (core/cli/gui/website/native/scripts) prunes
  listings AND aggregates. `all=true` surfaces the never-included dir
  list (node_modules, .git, dist, build, .next, gui-dist, …).
- Security: paths are only ever looked up in the in-memory tree — there
  is no filesystem to traverse. `.`/`..` segments, backslashes, NUL and
  control chars are rejected 400 outright; unknown paths are 404.
- Generator extended (gen-source-snapshot.ts): every file's metadata now
  carries `lastModified` (one-pass `git log --no-merges --name-only
  --date=short` map, mtime fallback for uncommitted/fixture files) and
  `summary` (first meaningful line of the leading block/line comment,
  first md heading, sh/py `#` comment, py docstring). Added to
  index.json files[], json/<path>.json wrappers, and the page module
  (SourceFileMeta grew lastModified?/summary?).
- Docs: the /source welcome panel lists all 11 endpoints (the 4 /ls ones
  first) with a new /ls curl block (flat, recursive, plain-text, find,
  quickref via jq); website/README.md documents params + examples and
  the no-fs/no-rescan design. docs/ has no API doc (USERLAND.md is an
  Android how-to), so website/README.md is the canonical reference.
- Tests: test-source-site.ts 70 → 127 checks (generator: summary +
  lastModified on the fixture; engine: flat/recursive/depth-cut shape,
  detail, layers, find ranking/limit/layer, stat, quickref freshness,
  6 traversal rejections + /etc/passwd 404 + "engine never touches fs"
  source check, depth cap, plain text, 9 end-to-end HTTP cases, route
  adapters). All green.
- Verified live (next start :3100): all 5 user verification cases plus
  detail/layer/all/quickref/stat/find, text formats, headers; tsc: website
  clean, root = 107-error pre-existing baseline exactly (no new errors);
  next build 12 routes (4 new ƒ dynamic); agent-browser: welcome panel
  shows the /ls API + curl examples, zero console errors.
- website/package.json 0.12.0 → 0.13.0. Snapshot regenerated (329 files
  · 7,197 symbols · 48 dir listings). Live on Vercel (commit 2952386):
  all 5 verification cases + quickref/stat confirmed against production.

Stage Summary:
- /source/ls is live: `ls`, `find`, `stat`, and `quickref` over the
  codebase — JSON for agents, plain-text trees for humans, one in-memory
  index, zero filesystem access, traversal-proof by construction.

---
Task ID: 14
Agent: Super Z (main)
Task: The dir API — list directories over HTTP on the /source snapshot.
Website-only (no CLI change). Plus: unblinded the tsc checker.

Work Log:
- scripts/gen-source-snapshot.ts now also emits the directory API:
  public/source/dir.json (root listing), public/source/dir/<path>.json
  (one per directory — 44), and public/source/tree.json (whole tree in
  one shot). Shape: { version, path, dirUrl, parent:{path,dirUrl}|null,
  children[] } — file children carry bytes/lines/language/rawUrl/jsonUrl,
  dir children carry files/dirs/lines aggregates + their own dirUrl, so
  an agent can walk root → deeper → back up → read files with ZERO
  client state. Aggregates verified against index.json (packages/core:
  53 files / 12,594 lines, exact).
- tests: test-source-site.ts 54 → 70 checks (dir.json shape, parent
  chain, aggregates, tree.json, real-output spot checks). test-ask.ts
  still 41/41, tsc clean for every file this task touched.
- UI: the /source welcome panel now documents all 7 endpoints (tree.json
  + dir.json + dir/<path>.json first) with copy chips, plus a
  walk-the-tree curl example. page.tsx description mentions dir
  listings. next.config.ts pins Content-Type on the dir endpoints.
  website/README.md documents the walkable-FS design.
- THE TSC BLINDNESS (found + fixed): commit 49c96ad introduced a parse
  error in scripts/test-ask.ts — `=> ({...})` + newline + `{` block,
  no semicolon. Valid ES (Node/Bun accept it) but tsc's parser rejects
  it — and ONE parse error anywhere makes tsc report ONLY syntax errors,
  skipping the entire semantic pass. Every "tsc clean" since that commit
  (including Task 13's) was measured blind. Fix: the missing semicolon.
  True state revealed: 358 semantic errors.
- Cleanup of the revealed state, scoped to what this task owns:
  · root tsconfig now excludes `website/` — the site is a self-contained
    app with its own tsconfig/build; checking it under the root config
    produced ~208 phantom errors (raw .ts snapshot copies + `@/*` paths
    pointing at the GUI src). Matches the Task 13 rationale that raw
    copies must never be type-checked; extends it to the root config.
  · root tsconfig now loads `types: [node, react, react-dom, bun-types]`
    — the repo RUNS on Bun and packages/{core,cli}/tsconfig.json
    already did exactly this; the root config was the outlier (~38
    `import.meta.dir` / `Bun` phantom errors gone).
  · type fixes in files this task touched: buildTree `let cur: TreeNode`,
    test-source-site annotation, test-ask res/seen narrowing.
- HONEST BASELINE for the next session: `bunx tsc --noEmit` (clean
  tsbuildinfo) = 107 errors, ALL pre-existing in agent-era code outside
  website/ (test-paste-heuristic 26, smoke-discovery 7, tui tests,
  mini-services/tagent-daemon 4, packages/cli tui.ts 3, loop.ts import
  of PermissionManager 2, skills 2, settings-dialog 1, ...). None were
  introduced by this task; all were hidden by the parse-error blindness.
  Triage them as a separate task.
- Verified: gen + 70/70 tests, ask 41/41, tsc (0 errors in website/ +
  snapshot scripts), website build (9 routes), live server: dir.json
  200 application/json, nested listing + parent chain, tree.json
  matches index counts, 404 for missing dirs, raw still text/plain,
  agent-browser: welcome panel shows the 7 endpoints, tree expands,
  file loads, zero console errors.
- website/package.json 0.11.0 → 0.12.0.

Stage Summary:
- The /source API is now a walkable file system: dir.json →
  dirUrl/rawUrl/jsonUrl traversal, tree.json one-shot, 44 listings.
- tsc can see again — do not reintroduce parse errors, and re-check the
  107-error honest baseline before blaming new work.

---
Task ID: 13
Agent: Super Z (main)
Task: /source — a source-code browser page on the website + a static
API so agents can fetch the codebase. Website-only (no CLI change).

Work Log:
- scripts/gen-source-snapshot.ts (NEW): walks the repo (packages/*/src,
  GUI src/, website/src, scripts/, native/, docs/, demo-workspace/,
  mini-services/, builtin-skills/, root files), filters node_modules ·
  lockfiles · .env* · binaries (NUL byte) · >512 KB · generated/ ·
  .tagent/, and writes: public/source/raw/<path> (verbatim),
  public/source/json/<path>.json ({path,content,language,lines,bytes,
  rawUrl}), index.json (manifest: files + tree + counts + excluded-notes),
  symbols.json (6.9k symbols — TS/Go/Py decls, sh funcs, md headings),
  and src/data/source-snapshot.ts (the page module: tree + stats, no
  content). Env hooks TAGENT_SNAPSHOT_ROOT/OUT/VERSION make it hermetic.
  323 files · 67k lines · 2.7 MB source.
- The page: app/source/page.tsx (server, prerendered stats header) +
  components/source/source-browser.tsx (orchestrator: ?file= deep
  links, fetch state machine loading/ok/error/notfound, search with
  lazily-loaded symbol index + grouped results, mobile drawer,
  keyboard '/' focus · Esc) · file-tree.tsx (collapsible tree,
  auto-expand to selection) · code-view.tsx (line numbers, #L<n>
  anchors, copy, raw/json links, 1500-line render cap). Welcome panel
  documents the agent API with copy chips + curl examples.
- highlight.ts (NEW, dependency-free): one alternation regex per
  family (ts/js, json, md, sh, css, html, go, py) walked once → tokens
  → lines; classes map to the site palette (zinc/orange/emerald).
  Website stays a 4-dependency project.
- Wiring: nav "Source" (desktop layout + MobileNav + footer Product),
  landing hero "Source" + CTA "Browse the source" (new IconCode).
  next.config.ts: Content-Type overrides — /source/raw/* is forced
  text/plain (the MIME table maps .ts → video/mp2t!), /source/json/*
  application/json. website/tsconfig.json now excludes public/ (the
  raw .ts copies must never be type-checked).
- scripts/test-source-site.ts (NEW, 54 checks): hermetic fixture
  (binary/lockfile/.env/oversize/generated/node_modules filters,
  byte-identical raw + json wrapper, symbols, idempotent re-run) ·
  real-output checks (index==module, raw==repo file, nav links, ts
  exclude, agent-API docs on the page) · tokenizer sanity.
- Verified: tsc clean · 54/54 · next build (9 routes, /source
  prerendered) · served + curl (content-types, 404s, index/raw/json/
  symbols bodies) · agent-browser end-to-end: tree navigation, code
  loads with highlighting, symbol search "switchmode" →
  switch-mode.ts#L14 anchor lands on the exact line, mobile drawer,
  zero console errors. Desktop + mobile screenshots captured.
- website/package.json 0.10.0 → 0.11.0; README documents the page,
  the endpoints, the regen command, and the two gotchas.

Stage Summary:
- /source is live on push (Vercel auto-deploy): humans browse the
  codebase (tree · search · highlighting · anchors); agents fetch it
  (index.json · raw/<path> · json/<path>.json · symbols.json).
- The snapshot is committed like latest.json — regenerate with
  `bun scripts/gen-source-snapshot.ts` after source changes.

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

---

Task ID: 17 (audit)
Agent: Super Z (main) — INDEPENDENT AUDIT
Task: Audit v0.30.0 (search_skills + skill auto-router) — verify claims
with evidence, hunt edge cases, skeptic bias. No fixes applied (per rules).

Work Log:
- Verified: version 0.30.0 (CLI run, version.ts, latest.json via raw GH +
  jsDelivr, GH release page + 6 binary assets + SHA256SUMS); tag v0.30.0 →
  bc08f73 on remote (local tags stop at v0.27.0 — not fetched, cosmetic).
- Test suite: 73/73 green, 6 consecutive runs stable. Battery re-run:
  ALL numbers match the claim (52/71/59/41/19/30/32/71/25/ALL/OK/38/127).
- Snapshot at release commit: 332 files · 70,027 lines (exact match);
  /source/ls/find?q=skill-router serves skill-router.ts (360 lines) live
  on Vercel. quickref (25 entries) has NO skill-router entry — gap.
- tsc: measured 113 errors at release state (124 at HEAD incl. 11 from my
  audit scripts). The new scripts/test-skills-router.ts itself contributes
  7 type errors → claim "106, 0 new" undercounts; release ships 7 new tsc
  errors (runtime unaffected — bun does not typecheck).
- FINDING X (high): topic-shift re-route is a NO-OP in any workspace with
  a rule signal (package.json/Dockerfile/tsconfig present). Root cause:
  RouteContext.existingLoaded is declared+passed but NEVER READ by
  routeSkills; dedup runs AFTER the top-max slice → the slice is all
  rule-hit (0.9) already-loaded skills → filtered to [] → null. The
  shipped topic-shift test fixture has NO rule signals → the common case
  is untested. Repro: scripts/audit-v030-followup.ts (FINDING X section).
- FINDING (medium): NO aggregate token cap. Keyword-only workspace:
  3 initial + 3 re-route = 6 skills × ~8k = 48,420 chars ≈ 12.1k tokens
  in the system prompt every turn; manual load_skill (24k cap each)
  stacks on top.
- FINDING (medium): KEYWORD_GROUPS use unanchored includes() → 'ci' ⊂
  decide/social, 'test' ⊂ latest, 'rest' ⊂ restart fire spurious 0.5
  (= threshold) loads in ANY workspace.
- FINDING (low): "fix itu" (2-token follow-up, 0 overlap) counts as a
  topic shift → loads bug skill + burns the 1 re-route budget.
- FINDING (low): /reload-skills (rerunSkillRouter) bypasses config
  skills.autoRoute:false (maybeAutoRouteSkills respects it) — asymmetric.
- FINDING (low): auto-router bypasses the permission system (load_skill:
  deny does not stop body injection; audit trail = WORKLOG + notice only);
  permission-denial text says "denied by the user" even for config denies.
- FINDING (low): mtime cache blind to backdated/same-ms edits (deterministic
  repro via utimesSync); /reload-skills does not bust the cache either.
- FINDING (info): with the 3 shipped builtins, bug/test-ish tasks load 2+
  skills (code-review is tagged 'test' → pulled into test tasks).
  search_skills input leniency: limit<=0 → default 20 (not 0), non-array
  tags silently ignored.
- Hygiene: release commit ships an empty .tagent session file
  (966251f3wibx.json, created during release work) + scripts/smoke-skills.ts
  unmentioned in WORKLOG; scope = 2 features + test hardening + import fix
  + release infra in ONE commit; no rollback documentation anywhere.

Stage Summary:
- Audit scripts persisted: scripts/audit-v030-edge.ts (28 checks),
  scripts/audit-v030-followup.ts (finding verification). No code changes
  to the product — awaiting user instructions per audit rules.
- Verdict: release functional + claims mostly verified; 1 high-severity
  router defect (re-route no-op under rule signals), 2 medium leaks (no
  total cap; substring keywords), tsc claim inaccurate. Recommend v0.30.1
  hotfix for FINDING X + word-boundary matching.

---
Task ID: 1
Agent: explore (Explore subagent)
Task: Read-only map of skill-router.ts + test-skills-router.ts + config.ts for hotfix v0.30.1
Work Log:
- Read WORKLOG.md Task 16 (v0.30.0 release) + Task 17 (audit: FINDING X
  high, 2 medium, several low) for context on the 3 hotfix bugs.
- Read packages/core/src/skill-router.ts (359 lines), scripts/test-skills-router.ts
  (327 lines), packages/core/src/config.ts (165 lines) fully; plus
  skills.ts (search_skills filter + session registry + 24k manual cap),
  system-prompt.ts (renderAutoLoadedSkillsBlock), loop.ts (router hook +
  autoSkills injection), types.ts (RouteContext/skills config/SessionData),
  util.ts (trunc/deepMerge).
- Grepped for search_skills implementation, token caps (8000/8192/token/
  estimate), existingLoaded/recentHistory/lastText readers, routeSkills
  callers (production: only loadRoutedSkills).
- Ran `bunx tsc --noEmit 2>&1 | rg 'test-skills-router'` (7 errors) and
  `| rg -c 'error TS'` (124 total); per-file breakdown captured.
Stage Summary:
- Signatures: routeSkills(ctx: RouteContext, opts?: {max?: number;
  threshold?: number}): RoutedSkill[] (skill-router.ts:147-150);
  RouteContext { userMessage: string; workspaceRoot: string;
  recentHistory?: string[]; existingLoaded?: string[] } (:20-27);
  maybeAutoRouteSkills(call: AutoRouteCall): string | null (:280);
  rerunSkillRouter(call: Omit<AutoRouteCall,'priorUserMessages'>): string
  | null (:304); capAutoBody(body: string, max = 8_000): string (:266).
- BUG-1 confirmed: existingLoaded declared (:26) + passed (:319) but NEVER
  read inside routeSkills (grep: only 2 occurrences in src). Slice
  (:221-224, `.slice(0, max)`) runs BEFORE dedup (loadRoutedSkills :325
  `.filter((r) => !already.has(r.name))`) — dedup runs AFTER the slice →
  in rule-signal workspaces the top-max are 0.9 rule hits already loaded →
  filtered to [] → topic-shift re-route is a no-op. recentHistory (:24) is
  also dead; st.lastText (skills.ts:177) written 3x, never read.
- BUG-3 confirmed: keyword detection = substring includes, no word
  boundaries — skill-router.ts:162 `scanText.includes(w)` over scanText =
  userMessage + PRD.md(≤8k) lowercased (:157). 'ci'⊂decide/social,
  'test'⊂latest, 'rest'⊂restart → spurious 0.5 (=threshold) loads. Skill
  side: tagHit = exact Set.has on normalized frontmatter tags (:184);
  textHit = substring over name+description+usage (:169,:185). search_skills
  query filter lives in skills.ts:262-272 — hay = name+description+usage
  (tags NOT in the query haystack), `!hay.includes(query)` → false.
- BUG-2 confirmed: per-skill caps only — capAutoBody 8k chars (auto,
  skill-router.ts:266-271) + trunc(body, 24_000) for manual load_skill
  (skills.ts:145). NO total/aggregate cap: recordAutoSkills (skills.ts:203)
  appends unbounded; renderAutoLoadedSkillsBlock (system-prompt.ts:359-369)
  renders every body into the system prompt via loop.ts:257.
- Config: types.ts:457-465 skills?{autoRoute?: boolean; autoRouteMax?:
  number; autoRouteThreshold?: number}; defaults config.ts:52
  {autoRoute: true, autoRouteMax: 3, autoRouteThreshold: 0.5}; inline
  fallbacks skill-router.ts:322-323 + routeSkills :153-154. NO validation/
  clamping — loadConfig = defaults←global←workspace←extra via deepMerge
  (raw JSON passthrough); autoRouteMax unclamped; string "false" for
  autoRoute fails the `=== false` gate (:283) and routing stays ON.
- tsc: 124 total errors at HEAD. test-skills-router.ts contributes 7, all
  in section 13 (e2e): (295,39) TS2339 _req.messages on never (fake
  provider `completeStream: async (_req: never)`); (308,5) TS2322 session
  literal not assignable to SessionData (mode widened to string vs
  AgentMode union; messages/todos inferred never[]); (319,53/74/104) +
  (321,25/77) TS2339 role/meta/content on never.
- Harness: custom ok() pass/fail counter (exit code via process.exit);
  fixtures = mkdtemp temp dirs + inline SKILL.md writers; TAGENT_SKILLS_DIR
  redirected to a temp builtin dir; freshRoot() per scenario; direct
  routeSkills/maybeAutoRouteSkills calls; run via `bun scripts/test-skills-router.ts`.
- Other findings (report only): rerunSkillRouter ignores autoRoute:false;
  /unload-skill + /reload-skills resurrects the skill (already-set recomputed);
  matchedWords pushes all group words → reason may cite non-matching words;
  search_skills limit≤0 → default 20, non-array tags silently ignored;
  existsAt(root,'app') fires web/frontend rule for any app/ dir; mtime cache
  blind to same-ms/backdated edits and /reload-skills doesn't bust it.

---
Task ID: 2-a
Agent: general-purpose (Subagent A)
Task: FIX 4 — 7 tsc errors in scripts/test-skills-router.ts
Work Log:
- BEFORE: `bunx tsc --noEmit 2>&1 | rg 'test-skills-router'` → 7 errors, all in
  section 13 (e2e through the real AgentLoop):
  (295,39) TS2339 'messages' on never; (308,5) TS2322 session literal not
  assignable to SessionData (mode widened to string vs AgentMode; messages/
  todos inferred never[]); (319,53/74/104) + (321,25/77) TS2339 role/meta/
  content on never. Total repo-wide: 124 errors.
- Read the real types: types.ts (ChatMessage :8, TodoItem :30, SessionData
  :52, AgentMode :57), providers/index.ts (CompletionRequest :28, wire
  WireMessage :44, CompletionResult :51, ProviderAdapter :59 — complete(req):
  Promise<string>, completeStream(req): Promise<CompletionResult>), loop.ts
  AgentLoopOptions :104 (session: SessionData, provider: ProviderAdapter,
  mode: AgentMode); index.ts `export * from './types'` + provider type re-exports.
- Fixes (scripts/test-skills-router.ts ONLY — types only, zero runtime change):
  1) Added top-level type-only imports (erased at runtime — no effect on the
     TAGENT_SKILLS_DIR setup or the dynamic imports):
     `import type { SessionData } from '../packages/core/src/types'` and
     `import type { CompletionRequest, ProviderAdapter } from '../packages/core/src/providers'`.
  2) Fake provider: `const fake = {...} as never` with
     `completeStream: async (_req: never)` → `const fake: ProviderAdapter`
     with `completeStream: async (_req: CompletionRequest)`; dropped the
     `as { role: string; content: string }[]` cast on the wireCalls push
     (WireMessage[] is already assignable to the declared element type).
     Fixes 295,39.
  3) Session fixture: `const session = {...}` (untyped → mode widens to
     string, messages/todos infer never[]) → `const session: SessionData = {...}`
     — contextual typing gives mode: AgentMode ('build' literal checks),
     messages: ChatMessage[], todos: TodoItem[]. Fixes 308,5 + the five
     TS2339 cascades at 319/321 (session.messages.find now iterates
     ChatMessage, so m.role/m.meta/m.content and toolResult?.content type).
- No `as any` / @ts-ignore / @ts-expect-error / tsconfig changes; no logic
  touched; other sections of the file untouched.
- AFTER: `rg 'test-skills-router'` on tsc output → EMPTY (0 errors);
  total 124 → 117 (exactly -7; remaining 117 all live in OTHER files —
  test-paste-heuristic 26, audit-v030-followup 9, smoke-discovery 7,
  packages/core/src/* 6 [primary agent's domain], etc. — out of my scope).
- Runtime: `bun scripts/test-skills-router.ts` — BEFORE: "ALL GREEN — 73
  passed, 0 failed" exit 0; AFTER (identical): "ALL GREEN — 73 passed,
  0 failed" exit 0 (73 ok lines, 0 FAIL lines).
Stage Summary:
- test-skills-router.ts tsc errors: 7 → 0 (repo total 124 → 117, all
  remaining in other files, untouched per scope). Test still ALL GREEN
  73/73 — behavior identical, types-only change. No anomalies; nothing
  left unfixed within my file scope.

---
Task ID: 2
Agent: Super Z (main) — PRIMARY FIXES v0.30.1
Task: Hotfix v0.30.1 — FIX 1/2/3 (BUG-1, BUG-3, BUG-2) sequential in
skill-router.ts + skills.ts + util.ts + types.ts + config.ts

Work Log:
- FIX 1 (BUG-1, critical — topic-shift re-route no-op): routeSkills() now
  reads ctx.existingLoaded (case-insensitive set — manual load_skill records
  the user-typed name) and filters already-loaded skills BEFORE the top-max
  slice. Previously existingLoaded was declared+passed but never read and the
  dedup ran after the slice → rule-signal workspaces (package.json present,
  the common case) re-routed to [] → null. [skill-router.ts:221-232]
- FIX 2 (BUG-3, high — substring keyword false positives): new shared
  keywordInText() + escapeRegExp() in util.ts — word-boundary, case-
  insensitive, multi-word = per-word AND; regex `(?:^|[^\w])kw(?![\w])`
  (no lookbehind → portable). Applied to the router's keyword detection
  [skill-router.ts:162-166] and search_skills' query filter
  [skills.ts:262-267]; tool param/schema descriptions updated to
  "whole-word match". Frontmatter tag matching untouched (exact Set.has).
- FIX 3 (BUG-2, medium — no total token cap): new config
  skills.autoRouteMaxTokens (default 15000 — types.ts, config.ts defaults,
  inline `?? 15_000` fallback in loadRoutedSkills). Budget = existing
  st.auto bodies + new candidates; estimate = ceil(chars/4) (the audit's
  methodology). Over budget → lowest-score additions truncated first
  (routed is score-desc → loaded.pop()), each logged exactly:
  `[auto-router] Truncated: <name> (score <score>) — total cap hit`
  (console.log). Top-1 skill always survives. Manual load_skill (24k cap)
  NOT affected. [skill-router.ts:347-360]
- Evidence (scripts/repro-hotfix-0301.ts — persisted, run before AND after):
  BEFORE: [1b] routed=fake-api,fake-bot,fake-web (existingLoaded ignored);
  [1d] e2e re-route=null NO-OP, session unchanged; [3a] fake-devops loaded
  from 'ci'⊂"decide"; [3b] fake-api from 'test'⊂"latest"; [2a] 8 skills,
  16144 tokens, no cap, no log.
  AFTER: [1b] routed=fake-cli; [1d] "🎯 Auto-loaded skills: fake-cli" (4
  skills in session); [3a]/[3b] (none); [3c]/[3d] genuine matches intact;
  [2a] log "Truncated: web-07 (score 0.5) — total cap hit" + 7 skills,
  14126 tokens ≤ 15000.
- Regression: bun scripts/test-skills-router.ts → ALL GREEN 73/73.
- tsc: 117 before primary fixes (= 106 pre-existing release baseline + 11
  audit scripts, post Task 2-a) and 117 after — 0 new errors; the new
  scripts/repro-hotfix-0301.ts is type-clean.

Stage Summary:
- All 3 bugs fixed in place, minimal diffs, no new features beyond the
  specified config knob (skills.autoRouteMaxTokens).
- Scope notes: (1) the "tsc baseline 106" target is unreachable at HEAD —
  117 = 106 pre-existing + 11 from audit scripts (audit-v030-edge/followup,
  out of hotfix scope). (2) audit-v030-edge.ts false-positive probes will
  now print FAIL — expected (the bugs are gone); that script always exits 0
  (historical probe, not a gating suite). (3) 'fix itu' still counts as a
  topic shift and loads the bug skill — audit finding 2.2A (low), NOT in
  hotfix scope.
- Ready for Subagent B (regression tests A-E) + Subagent C (changelog).

---
Task ID: 3-b
Agent: general-purpose (Subagent C — docs)
Task: Changelog v0.30.1 + release notes prep (text only)
Work Log:
- Read WORKLOG entries 16 (v0.30.0 release), 17 (audit), 1 (explore),
  2-a (tsc fix) and 2 (primary fixes with BEFORE/AFTER evidence) as the
  source of truth; read website/src/data/releases.ts (Release interface,
  0.30.0 entry style, unreleased mechanism per the file header) and
  website/public/latest.json. No CHANGELOG.md exists at repo root — the
  changelog text is a paste-ready draft.
- Cross-verified every fix claim against the code: config.ts:52
  (autoRouteMaxTokens: 15_000), skill-router.ts:355-362 (cap ?? 15_000,
  ceil(chars/4), exact "[auto-router] Truncated: <name> (score <score>) —
  total cap hit" log, loop stops at loaded.length > 1), skill-router.ts
  :233-238 (case-insensitive existingLoaded exclusion BEFORE the
  top-max slice), util.ts:39 keywordInText shared by skill-router.ts:168
  (router) + skills.ts:266 (search_skills query filter; tags stay exact).
- Drafted the three deliverables with all numbers tied to Task 2/2-a
  evidence: 15000 default, chars/4 estimate, 16144→14126 ≤ 15000 with the
  Truncated log, re-route null → "🎯 Auto-loaded skills: fake-cli", 73/73
  green before AND after, tsc 124→117 (= 106 pre-existing release
  baseline + 11 audit scripts, out of scope), ~12.1k worst-measured
  tokens/turn. The Tests bullet is count-free on purpose — Subagent B's
  regression section (Task ID 3) lands in parallel.
- TEXT PREP ONLY: created exactly one file (download/release-notes-v0.30.1.md)
  + this WORKLOG entry. No edits to releases.ts, latest.json, version.ts,
  scripts/ or packages/; no git commit/tag/push, no gh-release.sh,
  sync-latest.ts or any release script run.
Stage Summary:
- Deliverable 1 — CHANGELOG entry (## v0.30.1 — Hotfix: Fixed BUG-1
  critical / BUG-3 high / BUG-2 medium / N1, Added skills.autoRouteMaxTokens,
  count-free Tests bullet).
- Deliverable 2 — ready-to-paste releases.ts Release object (version
  0.30.1, date 2026-09-26, one-paragraph summary, 4 sections, unreleased:
  true, no stable) with paste-time instructions (top of RELEASES array,
  keep LATEST = 0.30.0 until cut).
- Deliverable 3 — short GH-release body (broken → changed → drop-in-patch
  upgrade note, optional knob mentioned).
- All three live in download/release-notes-v0.30.1.md (clearly separated
  sections + an accuracy checklist mapping every number to WORKLOG Task 2).
  Release registry untouched — paste at cut time per the releases.ts header.
---
Task ID: 3-a
Agent: general-purpose (Subagent B — tests)
Task: Regression tests A–E + independent verification of v0.30.1
Work Log:
- Read WORKLOG Tasks 16/17/1/2-a/2 + current state of skill-router.ts,
  skills.ts, util.ts (keywordInText), config.ts, types.ts, repro script.
- scripts/test-skills-router.ts ONLY (allowed file): added regression
  sections 14–19, 39 new ok()s — A/BUG-1 (9): routeSkills with
  existingLoaded [fake-web] + "bikin CLI parser" → fake-cli not [] and
  not fake-web; stronger e2e FINDING X setup (package.json next+
  discord.js+express → three 0.9 rule skills) then topic shift via
  maybeAutoRouteSkills → notice + sessionAutoSkills gain fake-cli (4
  skills, fake-web exactly once). B/BUG-3 (5): new fixture
  fake-devops ('Deploy with docker and CI pipelines.', 'devops,
  docker') → "decide the color scheme" = [] ("ci" must not fire),
  "latest version" = no fake-api, "bikin CI pipeline" → fake-devops,
  "latest test result" → fake-api. C/BUG-2 (15): 6 cap-* skills with
  ~8k bodies (≈2018 tokens each post-8k-cap) — C1 default cap: 3 load,
  6054 ≤ 15000, 0 truncation logs; C2 cap 3000 (console.log captured
  via monkey-patch, restored in finally): exactly 2 lines matching
  "[auto-router] Truncated: <name> (score <score>) — total cap hit",
  survivor = highest-score cap-w1 (0.6), 2018 ≤ 3000; C3 accumulation
  (cap 10000): initial 3 skills (6054 tok) then topic-shift re-route
  adds only cap-c1 (2 truncated), final 4 skills 8072 ≤ 10000.
  D (4): "bikin web blog" → "fix itu" — no duplicates, fake-web
  exactly once, re-route only adds NEW skills; 2.2A documented as-is
  (loads fake-bug, out of scope). E (3): autoRouteMaxTokens 100 +
  load_skill(fake-cli) → full 5435-char body, no excerpt marker, no
  Truncated log. F (3): search "pip" → 0, "pipelines" → fake-devops,
  "WEB" → fake-web.
- Expected test adjustments from the new fixture: section 2/3 total
  assertions 6 → 7 (skills array, total/shown, q.total < 7, l.total
  === 7). ctx() helper gained an optional config param (default CFG)
  for E — existing call sites unchanged.
- Independent verification (all commands run myself, raw output):
  bun scripts/test-skills-router.ts → ALL GREEN — 112 passed, 0 failed
  (73 + 39); 5 consecutive runs → "ALL GREEN — 112 passed, 0 failed"
  ×5. bunx tsc --noEmit | rg -c 'error TS' → 117 (= pre-edit baseline;
  106 release + 11 audit scripts — "≤106" unreachable without
  out-of-scope edits); rg 'test-skills-router' on tsc output → 0
  errors; no `as any`/`@ts-ignore` (rg clean). Battery: switch-mode 52,
  subagents 71, testmode 59, ask 41, features 19, context-loop 30,
  browser 32, v0190 71, v0220 25, tui-app ALL PASS, host ALL OK,
  version exit 0 (✓ checks, no counter), cache 38, source-site 127 —
  all match the v0.30.0 release numbers.
- repro-hotfix-0301.ts AFTER: [1b] routed=fake-cli; [1d] "🎯 Auto-loaded
  skills: fake-cli", session fake-api,fake-bot,fake-web,fake-cli;
  [3a]/[3b] (none); [3c] fake-devops; [3d] fake-api; [2a] 7 skills,
  14126 tokens ≤ 15000 + "Truncated: web-07 (score 0.5)" log.
- audit-v030-edge.ts: "FAILURES — 28 passed, 4 failed, 33 notes",
  exit 0. Flips verified against pre-hotfix code via a throwaway git
  worktree at HEAD 28d62fa (removed after): FAIL→ok 2.1 "session
  accumulated 6 auto skills" (BUG-1 fixed); ok→FAIL 2.10 "'test'
  substring inside laTEST" (BUG-3 fixed — false positive gone). 2.1
  "NO TOTAL CAP" fails pre AND post for different reasons (pre: BUG-1
  collateral, re-route no-op'd → 24210 chars; post: 6 skills ≈ 6379
  tokens < 15000 cap, nothing to truncate — cap path itself proven by
  repro [2a] + section 16). 2.8 "two keyword groups → 0.6" and 2.10
  "'ci' inside serviCE" fail pre AND post — PRE-EXISTING probe
  miscalibrations, NOT hotfix regressions: fake-qa never matched a
  second group on that message ('api' not in its tags/name/description/
  usage), and "service" does not actually contain the substring 'ci'
  (real 'ci' hits were decide/social per Task 17).
- Findings: NO new bugs. All three hotfix fixes hold under every
  probe. Known out-of-scope 2.2A ("fix itu" topic-shift) confirmed
  still present and documented in section 17.
Stage Summary:
- 39 tests added (sections 14–19); suite 73 → 112, ALL GREEN, 5×
  stable. tsc 117 total / 0 in the test file (zero new errors).
  Full battery matches v0.30.0 release numbers. Repro + audit confirm
  BUG-1/2/3 fixed. No new bugs; two pre-existing audit-probe
  miscalibrations (2.8, 2.10-ci) documented — historical script, out
  of scope.

---
Task ID: 4
Agent: Super Z (main) — VERSION BUMP + RELEASE PREP v0.30.1
Task: Finalize hotfix v0.30.1 — version bump, releases.ts entry, snapshot
regen, final verification.

Work Log:
- packages/core/src/version.ts: CURRENT_VERSION 0.30.0 → 0.30.1.
  `bun packages/cli/src/index.ts --version` → 0.30.1.
- website/src/data/releases.ts: added the 0.30.1 entry (unreleased: true) at
  the top per the repo's documented pre-release convention; LATEST stays
  '0.30.0' so latest.json + download buttons keep pointing at the shipped
  release until the cut. sync-latest.ts intentionally NOT run — it throws
  while RELEASES[0].version ≠ LATEST (that is its designed guard).
- Snapshot regenerated (bun scripts/gen-source-snapshot.ts):
  v0.30.1 · 336 files · 48 dirs · 71405 lines (release state was 332 ·
  70,027; the +4 = audit-v030-edge.ts, audit-v030-followup.ts,
  demo-skills-report.ts from post-release commits, repro-hotfix-0301.ts).
- Post-bump verification: test-version all ✓ (0.30.1 current vs latest.json
  0.30.0 → not outdated); test-source-site 127/127 (snapshot version ===
  CURRENT_VERSION); test-skills-router 112/112; tsc total 117 (unchanged
  through the whole hotfix).
- Release NOT executed (per rules): no commit, no tag, no push, no gh
  release. Ready-state for the cut upon approval: bump LATEST to 0.30.1 +
  remove the unreleased flag → bun scripts/sync-latest.ts → git commit +
  tag v0.30.1 + push → scripts/build-binaries.sh + scripts/gh-release.sh
  with the body from download/release-notes-v0.30.1.md.

Stage Summary:
- Hotfix v0.30.1 complete in the working tree: 4 fixes (BUG-1, BUG-2, BUG-3,
  N1), 39 regression tests (112/112 green), full 14-suite battery green,
  tsc 124 → 117, before/after repro persisted at
  scripts/repro-hotfix-0301.ts. Awaiting user approval to commit + release.
---
Task ID: 5
Agent: Super Z (main) — RELEASE CUT v0.30.1
Task: Execute the approved cut sequence for v0.30.1.

Work Log:
- Pre-flight: hotfix state confirmed at HEAD 4142c6a (fixes + 112/112 tests
  + version bump + pre-cut snapshot), tree clean, branch main.
- download/ had been wiped between sessions (gitignored) — release notes
  body reconstructed verbatim from releases.ts 0.30.1 entry + Tasks 2/3-a
  evidence, saved to download/release-notes-v0.30.1.md (Subagent C's 3
  deliverables mirrored).
- scripts/gh-release.sh: BODY + release name swapped to the v0.30.1 hotfix
  story (same pattern as every previous release).
- releases.ts: LATEST 0.30.0 → 0.30.1; unreleased flag removed from the
  0.30.1 entry (interface + doc comments untouched).
- bun scripts/sync-latest.ts → latest.json 0.30.1 (guard passed).
- Commit a38cee7 + tag v0.30.1, pushed (main a9a189a..a38cee7).
- scripts/build-binaries.sh → 6/6 binaries + SHA256SUMS.txt (dist/tagent-v0.30.1/).
- scripts/gh-release.sh <token> 0.30.1 --no-build → release live, 7 assets
  uploaded (6 binaries + SHA256SUMS.txt).
- Snapshot regenerated post-cut: v0.30.1 · 336 files · 48 dirs · 71441 lines
  (registry flip reflected in raw copies); commit 1d1f940, pushed.
- Verification (all raw outputs in the session):
  bun packages/cli/src/index.ts --version → 0.30.1
  bun packages/cli/src/index.ts --check-update → "up to date: v0.30.1" exit 0
  dist/tagent-v0.30.1-linux-x64 --version → 0.30.1; --check-update → up to date
  raw.githubusercontent latest.json → 0.30.1; jsDelivr latest.json → 0.30.1
  GitHub API (auth): tag v0.30.1, name "v0.30.1 — Hotfix: the re-route that
  never fired, whole-word keywords, a token budget", 7 assets, body correct
  test-source-site.ts → 127 passed, 0 failed; test-skills-router.ts → ALL
  GREEN 112 passed, 0 failed
Stage Summary:
- v0.30.1 fully shipped: commit a38cee7 (cut) + 1d1f940 (snapshot), tag
  v0.30.1, release live with 7 assets, both update endpoints serving 0.30.1,
  CLI + binary self-report 0.30.1 and consider themselves up to date.
---
Task ID: 6
Agent: Explore (read-only)
Task: Map plugins/loop/permissions/tools/skills for Taceen prep work
Work Log:
- Read WORKLOG entries for Tasks 3-a, 4, 5 (v0.30.1 hotfix + release cut).
- Read in full: packages/core/src/plugins.ts, permissions.ts, tools/index.ts,
  skills.ts, types.ts, loop.ts, subagents.ts; mcp.ts key sections (naming,
  toolDefinitions, timeouts); packages/cli/src/host.ts (plugin wiring,
  chatSend AgentLoop construction, workspaceId); config.ts (GLOBAL_DIR,
  config layering).
- Grepped codebase for emitPluginEvent/loadPlugins/pluginToolDefinitions/
  pluginMeta call sites (packages + scripts + mini-services) — only
  packages/cli/src/host.ts emits events (onSessionStart, onAgentDone).
- Grepped onToolCall/onToolResult/onUserMessage hook names — plugin hooks
  onToolCall/onToolResult/onUserMessage are NEVER invoked anywhere (dead).
- Extracted every tool name + risk + description from tools/*, memory.ts,
  skills.ts; ALL_TOOLS order verified in tools/index.ts.
- Read builtin-skills/*/SKILL.md frontmatter (3 skills + tags).
- Read scripts/test-subagents.ts (full), test-skills-router.ts (setup +
  e2e section), test-plugins-v2.ts — test-isolation patterns captured.
- Verified workspaceId === resolved workspace root path (host.ts:149-150;
  loop.ts:172 uses session.workspaceId as ToolContext.workspaceRoot).
- NO files modified except this WORKLOG append.
Stage Summary:
- PluginHooks has 5 hooks (onSessionStart/onUserMessage/onToolCall/
  onToolResult/onAgentDone), all (ctx: Record<string,unknown>) =>
  void|Promise<void>; hooks object passed through AS-IS (no whitelist);
  loaded async from <root>/.tagent/plugins + ~/.tagent/plugins *.m?js with
  per-file try/catch; PLUGIN_API_VERSION 2.0.0.
- emitPluginEvent fires ONLY onSessionStart + onAgentDone, both from
  host.ts chatSend; onToolCall/onToolResult/onUserMessage are dead code —
  loop.ts has zero plugin awareness.
- loop.ts: for..of allActions; record created status 'running', onToolStart
  fires, permissions.gate() at loop.ts:497; denied path sets status 'denied'
  + fixed output string, falls through to common tail (onToolEnd + results
  push), NO continue; statuses: running|done|error|denied.
- spawnSubagent (loop.ts:631) passes session/provider/model/events/
  permissions(shared parent manager)/config+maxTurns/mode/depth/readOnly/
  signal/onSubagentSession/agentPrompt+toolsFilter — NO extraTools, NO
  plugins: subagents never see MCP/plugin tools today.
- AgentLoopOptions has extraTools (yes) but NO plugins field; ToolContext
  workspaceRoot = session.workspaceId (the root path).
- PermissionDecision = { approved: boolean; remember?: 'once'|'session'|
  'always' }; gate() order: session-deny → session-allow → tool rule (exact,
  mcp_<server> prefix, mcp catch-all; plugin_<name> prefix, plugin
  catch-all) → defaultMode → onPermission → headless allow.
- MCP tools named mcp_<server>_<tool> (slug, ≤60 chars), risk hardcoded
  'medium', injected as extraTools in host.ts:393 alongside
  pluginToolDefinitions; config from cfg.mcp.servers (stdio).
- 25 registered tools (6 low-risk read/fs+web, high: bash/browser/serve/
  bg_run; medium: write_file/edit_file/task/switch_mode/bg_stop); 3
  builtin skills (bug-hunter, code-review, web-app-builder).
- Tests isolate via mkdtemp roots + TAGENT_SKILLS_DIR env (set BEFORE
  dynamic import) + fake ProviderAdapter {completeStream: script} +
  PermissionManager(defaultConfig with defaultMode allow) + raw
  AgentLoop construction.
---
Task ID: 8-a
Agent: general-purpose (Subagent B — Taceen plugin template)
Task: PART B — taceen.mjs + taceen.json + taceen.py + docs/TACEEN.md
Work Log:
- Created the Taceen plugin TEMPLATE (skeleton + mock only — the real
  ~30-50MB model is future work). Exactly 4 files, nothing else touched:
  .tagent/plugins/taceen.mjs (plain ESM, node: builtins only), .tagent/
  plugins/taceen.json (config, byte-identical to spec), .tagent/taceen/
  taceen.py (JSON-over-stdio skeleton, byte-identical to spec),
  docs/TACEEN.md (162-line developer doc, EN/ID).
- Plugin exports name/version/description + hooks { onResolve,
  beforeToolCall } targeting the NEW v0.31 hook contract (no
  tools/commands contributed). Every hook body wrapped in try/catch →
  console.error + undefined (FALLBACK-TO-ALLOW invariant); subprocess
  helper never throws (spawn error / empty stdout / bad JSON / timeout
  all collapse to null → undefined → allow).
- Config read once at module level from taceen.json BESIDE the plugin
  file (import.meta.url → fileURLToPath — query-safe against the
  loader's ?t= cache-buster, verified live). Missing file → silent
  defaults; broken JSON → defaults + one warning (both verified).
- mockResolve: case-insensitive accumulate heuristic — 'file'→read_file,
  'test'→bash, 'web'→mcp_browser_navigate; always returns the '[MOCK]
  heuristic resolver' hint; '[MOCK] Taceen resolve:' log line is the
  spec'd marker. mockValidate: bash+rm -rf → block with alternative;
  else undefined.
- KEY FIX during verification: spec's "root = dirname(dirname(
  pluginFile))" is off by one — the plugin lives at <root>/.tagent/
  plugins/taceen.mjs so the workspace root needs THREE dirname hops;
  with two, python exited code 2 (script path <root>/.tagent/.tagent/
  taceen/taceen.py) and the fallback-to-allow fired exactly as designed
  (observed live). Fixed to dirname x3 + documented the decision +
  fixed the stale prose comment after the initial run.
- Subprocess bridge: one JSON line in / one JSON line out per request;
  stdin EPIPE swallowed (child may die early); close handler no-ops if
  the timeout already settled (single clean timeout log).
Stage Summary:
- Files (4, all verified): .tagent/plugins/taceen.mjs (234 lines),
  .tagent/plugins/taceen.json, .tagent/taceen/taceen.py (23 lines),
  docs/TACEEN.md (162 lines). Config final state: enabled:true,
  mode:"mock" (restored + cat-proven after every temporary toggle).
- bun -e dynamic-import checks (fresh process each, final code): 1a
  name/version/description ✓; 1b 'read a file' → [MOCK] log +
  read_file + hint ✓; 1c bash rm -rf → block '[MOCK] destructive
  command detected (rm -rf)' + alternative ✓; 1d read_file →
  undefined ✓; 1e 'bikin web app' → mcp_browser_navigate entry ✓;
  accumulation 'test the web file thing' → all 3 entries ✓.
- Python stdio: resolve → [python-mock] hint JSON ✓; validate ls →
  {"action": "allow"} ✓; 'not json' → error JSON, exit 0 ✓.
- Subprocess mode e2e: onResolve returns '[python-mock] resolve: read
  a file' hint from taceen.py ✓; beforeToolCall ls → allow ✓; restored
  to mock + cat ✓. Disabled: both hooks → undefined, no [MOCK] log ✓;
  restored + cat ✓. Timeout 1ms → '[taceen] subprocess timeout after
  1ms — falling back to allow' + hook returns undefined (agent
  unblocked) ✓ — the critical invariant proven live.
- Cache-busting import (?t=…) works; taceen.json diff vs spec =
  byte-identical. NOTE: .tagent/taceen/categories.json appeared
  mid-run — that is Part C's file (parallel agent), not mine, no
  conflict. Next: core wiring of beforeToolCall/onResolve (primary
  agent, packages/core) can consume this template as-is.
---
Task ID: 8-b
Agent: general-purpose (Subagent C — capability categories)
Task: PART C — docs/CATEGORIES.md + .tagent/taceen/categories.json
Work Log:
- Read WORKLOG Task 6 (explore) + verified inventory read-only against
  packages/core/src/tools/index.ts (ALL_TOOLS, 25 tools), mcp.ts
  (toolName: mcp_<slug(server)>_<slug(tool)>, ≤60 chars, hash suffix),
  builtin-skills/*/SKILL.md frontmatter (3 skills + tags).
- Designed the Taceen capability category structure (Model A2: functional,
  cross-kind — one category holds tools + MCP + skills).
- Created .tagent/taceen/categories.json (v1.0): 10 categories, 41
  capabilities (25 tools + 3 skills + 13 representative MCP examples with
  "s": filesystem/fetch/brave-search/browser/github/sqlite/postgres).
  Categories: filesystem(9, subcats read_ops/write_ops), web_research(4),
  web_ui(6: browser+vision+web-app-builder+browser MCP), execution(4),
  quality_assurance(4: serve+test_report+bug-hunter+code-review),
  delegation(3: task/subs/switch_mode), workflow(3: todowrite/worklog/
  ask_user), knowledge(3: memory/search_skills/load_skill), data(2,
  MCP-only), repo_collab(3, MCP-only).
- Convention: capabilities ALWAYS live in subcategories; ≥8 capabilities →
  meaningful partition, below → single "general" subcategory (uniform
  parser shape). Mode gating deliberately NOT encoded (stays in
  buildToolset); MCP entries marked as examples in docs.
- Created docs/CATEGORIES.md: category table + why (coverage/balance/no
  overlap), subcategory policy, {type,n,d,s} spec + token budget (~30
  tokens/entry), the 8 design answers (exposure=static versioned JSON +
  regenerate-on-startup/MCP-config-change with live-registry fallback;
  no-match=hint+flattened list+search_skills delegate; multi-match=rank by
  keyword score, smaller category tie-break; MCP=server-slug convention
  table + runtime "extensions" catch-all for unknown servers; skills=static
  entries + search_skills as live long-tail), 3 worked examples,
  maintenance/versioning.
- Verification: VALID_JSON; 41 capabilities (30-50 ok); 10 categories (≤10
  ok); every (type,n,s) triple unique; all 25 tools + 3 skills present; 13
  MCP entries all have "s" and names ≤60 chars; docs/CATEGORIES.md = 300
  lines. Files written: only the 2 in scope + this append.
Stage Summary:
- Deliverables: docs/CATEGORIES.md (300 lines) + .tagent/taceen/categories.json
  (41 capabilities / 10 categories, v1.0) — both verified. Design answers for
  exposure/fallback/MCP/skill handling documented for the Taceen implementer
  (taceen.py, parallel Task 8-a).
---
Task ID: 7
Agent: Super Z (main) — PART A: plugin hook system
Task: A1-A5 — decision hooks (beforeToolCall gatekeeper + onResolve resolver)
+ loop wiring + subagent inheritance + PermissionDecision extension.

Work Log:
- plugins.ts A1: PluginHooks extended with beforeToolCall (block/modify/allow,
  typed ctx: tool/input/risk/workspaceRoot/sessionId) + onResolve (available/
  unavailable/hint, ctx: query/workspaceRoot/mode). Header doc updated.
  Backward-compat: both optional; the 5 observability hooks untouched.
- plugins.ts A2: emitBeforeToolCall (first block/modify wins, throw→logged+
  skipped = fails open) + emitOnResolve (merge across plugins, first hint
  wins, null when no plugin answered). emitPluginEvent narrowed to the 5
  observability hook names (keyof PluginHooks became unsound once the typed
  ctx hooks landed — that was the one tsc regression, fixed same commit).
- loop.ts A3: in the action loop, BEFORE the permission gate —
  pluginDecision = plugins?.length ? await emitBeforeToolCall(...) : allow;
  block → record.status 'denied' + output "Blocked by plugin: <reason>\n
  Alternative: <alt>" and the permission gate + tool.run are SKIPPED (falls
  to the common tail: onToolEnd + results.push, same as a permission denial);
  modify → action.input replaced (+ record.input updated for transparency).
  Deviation from spec snippet: status 'denied' (valid ToolCallRecord value),
  not 'blocked' — keeps the union type sound.
- loop.ts A4: AgentLoopOptions.plugins?: TagentPlugin[] added;
  spawnSubagent() now passes ...(plugins) + ...(extraTools) → subagents
  inherit the gatekeeper AND the host-injected MCP/plugin tools (background
  subagents go through spawnSubagent too — one change covers both).
- host.ts (1-line, necessary deviation from the file list): the primary
  AgentLoop construction now passes `plugins` — without it the gatekeeper
  would never fire in real CLI runs (plugins were loaded in chatSend but
  only their TOOLS were forwarded).
- types.ts A5: PermissionDecision + reason? + alternative? (optional,
  unconsumed yet — prep for gatekeeper/permission integration).
- Verification: bunx tsc --noEmit = 117 total = exact pre-change baseline
  (stash-compared error lists: 0 new; transient 3-error regression caught
  and fixed: keyof clash + 2× TS2454 definite-assignment false positives on
  the flag-wrapper variant — restructured to a plain if/else which TS proves).
  scripts/smoke-plugin-hooks.ts (persisted): 8/8 — block wins, empty→allow,
  throw→allow, modify, block>modify ordering, resolve merge + first-hint,
  null, throwing-resolver skip. test-plugins-v2 green; test-subagents 71/71.
Stage Summary:
- PART A done: the hook system + wiring + inheritance, tsc 117 (0 new),
  affected suites green. PART B (8-a) + PART C (8-b) landed in parallel
  (taceen template 4 files; categories 10 cats/41 capabilities). Next:
  independent test subagent (Task 9) → docs (Task 10) → release prep.
---
Task ID: 9
Agent: general-purpose (independent TEST subagent — verify hooks+plugin+categories)
Task: Independent verification of PART A (plugin hook system) + PART B (Taceen
plugin template) + PART C (capability categories); one new permanent file
scripts/test-plugin-hooks.ts; report, never fix.
Work Log:
- Read WORKLOG Tasks 6/7/8-a/8-b (the last-appended entries), loop.ts gate
  section (499-545), plugins.ts (emitBeforeToolCall/emitOnResolve), host.ts
  plugin wiring, taceen.mjs/.json/.py, test-subagents.ts +
  smoke-plugin-hooks.ts + test-plugins-v2.ts patterns.
- Created scripts/test-plugin-hooks.ts (hermetic, mkdtemp roots only — the
  repo's .tagent/ is only ever read): A1 test-gate scaffold + loadPlugins;
  A2 e2e block (denied record + "### bash (denied)" fed back + no side
  effect); A3 read_file unaffected; A4 subagent inheritance (denial fed
  back into the sub conversation, report reaches parent); A5 no-plugins
  old behavior; A6 modify e2e (rewritten command runs, record.input
  replaced) + 12 emit-layer units (block/modify ordering, throw→allow,
  void→allow, resolve merge/first-hint/null/throwing-resolver).
- PART B in the same suite: B1 real taceen loadPlugins(repoRoot) direct
  onResolve ([MOCK] marker + read_file); B2 e2e rm -rf → denied "[MOCK]
  destructive command detected" (plugin fires BEFORE the bash blocklist —
  /tmp/tagent-taceen-test sentinel survived), benign echo → done; B3
  enabled:false temp copy → hooks undefined, no [MOCK], bash done; B4
  subprocess temp copy → python hint "[python-mock] resolve: read a file",
  validate → {action:"allow"} (in-suite spawnSync + raw repo-file echo |
  python3), missing-script error path → undefined + logged "falling back
  to allow".
- RESULT: 62 passed, 0 failed (5 consecutive identical runs).
- PART C (raw commands): categories.json VALID via json.tool; 41
  capabilities / 41 unique (type,n,s) / 0 duplicates / 10 categories; all
  25 ALL_TOOLS present, no extras; docs/CATEGORIES.md has the category
  table (10 rows + totals), 8 numbered design answers (### (1)..(8)),
  3 worked examples (A/B/C).
- F1 battery: switch-mode 52, subagents 71, testmode 59, ask 41,
  features 19, context-loop 30, browser 32, v0190 71, v0220 25, tui-app
  ALL PASS, host ALL OK, version exit 0, cache 38, skills-router 112 —
  all match. DEVIATION: test-source-site = 125 passed, 2 FAILED (expected
  127, exit 1): "raw loop.ts byte-identical" + "json wrapper for loop.ts"
  — the committed website/public/source snapshot predates PART A's loop.ts
  changes (76-line diff = the plugin gatekeeper block). Stale snapshot,
  needs regeneration at release prep — REPORTED, not fixed (out of scope).
- F3: bunx tsc --noEmit → 117 'error TS' = exact baseline; 0 errors
  mention test-plugin-hooks (my file adds none; no as-any/@ts-ignore).
- No repo file modified by me (git: only scripts/test-plugin-hooks.ts
  added + this WORKLOG append); repo .tagent/plugins/ still holds only
  taceen.{mjs,json} (enabled:true, mode:mock verified).
Stage Summary:
- PART A/B/C all verified green (62/0 + raw C checks). One true finding:
  source-site snapshot is stale vs the modified loop.ts (2 failing
  assertions, exit 1) — regenerate before the v0.31 release. Suite is
  deterministic (5× identical) and isolated (mkdtemp only).
Task ID: 10
Agent: general-purpose (docs subagent — release-notes PREP, TEXT ONLY)
Task: v0.31.0 release text (changelog + releases.ts object + GH release
body) — prepared only, NOT cut; no versions bumped, no registry touched.
Work Log:
- Read WORKLOG Tasks 6/7/8-a/8-b/9 (appended today — the source of truth),
  then cross-checked every claim against the live code:
  packages/core/src/plugins.ts (hook signatures, L64-92),
  loop.ts (gatekeeper block, L500-522), types.ts (PermissionDecision),
  host wiring context, scripts/gh-release.sh (BODY heredoc + __VER__
  substitution + the hardcoded --arg name), website/src/data/releases.ts
  (Release interface, header unreleased-convention, 0.30.1/0.30.0 voice),
  docs/TACEEN.md (full), docs/CATEGORIES.md, .tagent/plugins/taceen.json,
  .tagent/taceen/taceen.py, test-plugin-hooks.ts (RESULT line),
  smoke-plugin-hooks.ts (8 checks, one per numbered case).
- Created download/ + wrote download/release-notes-v0.31.0.md (the ONLY
  repo file besides this append): D1 changelog entry (Added/Fixed/Tests,
  the Fixed section framed honestly — emitPluginEvent keyof narrowing +
  the taceen dirname off-by-one were same-change fixes, never shipped);
  D2 paste-ready releases.ts object (version 0.31.0, date 2026-09-27,
  5 sections, unreleased: true, NO stable field, paste-at-top
  instructions per the releases.ts header: LATEST stays '0.30.1' until
  the cut, then flip + remove flag + run sync-latest.ts); D3 GH release
  body in gh-release.sh heredoc format (## v__VER__ title, gatekeeper /
  resolver / subagent-inheritance / Taceen-template-with-config-table /
  categories / Tests / Upgrade-note sections, plus a paste note that
  the --arg name title must also be updated); ACCURACY CHECKLIST — a
  31-row table mapping every number/claim to its WORKLOG task + line
  range, with 3 flagged rows (see below).
- Validated D2 by extracting the fenced block and parsing it with bun
  (fields + section count + the literal \n in the blocked-output string
  all check out; braces/quotes balanced).
- Numbers cross-verified against the worklog: 62/0 (5x identical), smoke
  8/8, battery 52/71/59/41/19/30/32/71/25 + tui-app/host/version/38/112,
  source-site 125+2 (expected 127 after snapshot regen), tsc 117 / 0 new,
  10 categories / 41 capabilities (25 tools + 3 skills + 13 MCP examples).
- Flagged in the checklist (not invented, honestly marked): the tsc
  split "106 release + 11 audit" comes from the v0.30.1 release notes,
  not the worklog (worklog only confirms 117 total / 0 new) —
  TODO-verify at cut; "onResolve has no loop call-site yet" + "full
  catalog < ~1.5k tokens" are doc-sourced (TACEEN.md / CATEGORIES.md,
  authored in Tasks 8-a/8-b), consistent with Task 7's wiring; found ONE
  factual discrepancy: taceen.mjs is 235 lines on disk vs "234" in
  Task 8-a — line count NOT cited in any deliverable.
- NO release actions taken: version.ts untouched, releases.ts untouched,
  LATEST still '0.30.1', no sync-latest run, no tags, no registry writes.
Stage Summary:
- Release text READY at download/release-notes-v0.31.0.md — three
  deliverables + accuracy checklist, every number worklog-sourced (3
  flagged rows documented above). Next (release-cut agent): regenerate
  the source-site snapshot (expected 127), paste D2 at the top of
  RELEASES (keep LATEST until the cut), swap the gh-release.sh BODY +
  --arg name, bump version.ts, flip LATEST -> '0.31.0', remove
  unreleased, run bun scripts/sync-latest.ts, tag v0.31.0.
---
Task ID: 11
Agent: Super Z (main) — RELEASE PREP v0.31.0 (pre-cut state, NO release)
Task: version bump + releases.ts entry + gh-release BODY + snapshot regen + final verification.

Work Log:
- version.ts: CURRENT_VERSION 0.30.1 → 0.31.0 (bun packages/cli/src/index.ts --version → 0.31.0).
- releases.ts: pasted docs subagent Deliverable 2 (Task 10) at the top of RELEASES
  (version 0.31.0, date 2026-09-27, 5 sections, unreleased: true); LATEST stays
  '0.30.1' per the file's pre-release convention. latest.json untouched.
- gh-release.sh: BODY + --arg name swapped to the v0.31.0 story (Deliverable 3).
- Snapshot regenerated: v0.31.0 · 340 files · 48 dirs · 73037 lines (v0.30.1 was
  336 · 71441; +4 = TACEEN.md, CATEGORIES.md, smoke-plugin-hooks.ts,
  test-plugin-hooks.ts).
- BUG FOUND + 1-line fix (documented deviation from "report, don't fix"):
  test-source-site 'text: ls — tree glyphs + line counts' failed 126/127 after
  the regen — renderLsText formats counts via toLocaleString ("1,006") but the
  check regex expected the bare number; latent assumption (loop.ts < 1000
  lines) broken by PART A growing it to 1006. Direct consequence of this
  release's own change + blocks F1 → fixed by stripping commas before the
  match (commented). Snapshot data was never wrong (byte-identical checks pass).
- Docs checklist TODO #26 resolved: scripts/audit-v030* = 11 tsc errors (rg
  count) — the v0.30.1 "106 + 11" split holds; the pasted notes quote only
  "117 total, 0 new".
- Post-bump verification (raw): test-version ✓ (0.31.0 vs latest.json 0.30.1 →
  not outdated); test-source-site 127/0; test-plugin-hooks 62/62;
  test-skills-router 112/112; bunx tsc 117.
- Committed LOCALLY ONLY (no push / tag / gh-release — awaiting approval).
Stage Summary:
- v0.31.0 complete + committed locally: PART A hooks, PART B template, PART C
  categories, 62-check suite + 8-check smoke, battery green (source-site 127
  post-fix), tsc 117/0-new, snapshot v0.31.0. Cut sequence ready on approval:
  flip LATEST → 0.31.0 + drop unreleased → sync-latest.ts → commit+tag v0.31.0
  + push → build-binaries.sh → gh-release.sh.
