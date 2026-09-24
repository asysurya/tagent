/**
 * Release data — the single source of truth for the website changelog and
 * for website/public/latest.json (which the Tagent CLI update check reads).
 *
 * Keep newest first. After editing, run `bun scripts/sync-latest.ts` to
 * regenerate public/latest.json, and tag the repo: `git tag vX.Y.Z`.
 *
 * Preparing a release BEFORE it is cut: add the entry at the top with
 * `unreleased: true` and keep LATEST pointing at the shipped version — the
 * site lists the entry as "upcoming" and never links to assets or tags that
 * do not exist yet. At release time: bump LATEST to the new version, remove
 * the `unreleased` flag, then run `bun scripts/sync-latest.ts`.
 */
export interface Release {
  version: string
  date: string
  title: string
  /** one-liner shown in cards / update warnings */
  summary: string
  /** markdown-ish bullet groups */
  sections: { name: string; items: string[] }[]
  /** first version considered "stable enough" for the download page */
  stable?: boolean
  /** entry exists but the release has not been cut yet — renders as "upcoming",
   *  no asset/tag links until the flag is removed at release time */
  unreleased?: boolean
}

/** The version the download buttons point at — bumped at release time, in
 *  lockstep with removing `unreleased` from the newest entry (see header). */
export const LATEST = '0.29.0'

export const RELEASES: Release[] = [
  {
    version: '0.29.0',
    date: '2026-09-24',
    title: 'Operating loop v2 — PLAN · BUILD · TEST, verified finishes',
    summary:
      'The agent\u2019s operating contract is now a strict loop: PLAN → BUILD → TEST — PASS delivers the structured ✅ SELESAI summary, FAIL goes back to BUILD with the evidence, and the loop repeats until the verification passes. Retry discipline has teeth: every failed round must carry a concrete hypothesis, blind trial-and-error is forbidden, and after 5 fix rounds the agent stops and escalates with the full story. The same loop — and the same rigor — now applies to every project kind: web, CLI, bot, API, library, pipeline.',
    stable: true,
    sections: [
      {
        name: 'The work loop — PLAN · BUILD · TEST',
        items: [
          'the loop, exactly: PLAN ──► BUILD ──► TEST ─┬─ PASS ──► summary to the user (done) · └─ FAIL ──► BUILD (fix) ──► TEST ──► (loop) — the task is NOT done until the verification passes',
          'numbered contract: PLAN investigates the request AND the repo before writing the steps (PRD.md is the approved spec); BUILD implements step by step; TEST verifies for real — "should work" is not a result',
          'retry discipline is a HARD RULE: every failed round MUST carry a concrete hypothesis — why it failed and what changes because of it; blind trial-and-error is forbidden',
          'hard cap of 5 fix rounds: still failing → STOP and escalate to the user with what was tried, the last error verbatim, and what is needed; real blockers (credentials, product decisions) escalate immediately',
          'PASS means STOP: the agent delivers the final summary and never keeps iterating on finished work',
        ],
      },
      {
        name: 'The structured finish — ✅ SELESAI',
        items: [
          'every finished task closes with the exact block: ✅ SELESAI · 📌 Yang dikerjakan · 📁 File yang diubah · 🧪 Verifikasi · ⚠️ Catatan',
          'the ✅ is EARNED by verification — untested work must say so under ⚠️ instead of being claimed',
          'labels follow the user\u2019s language (English: ✅ DONE / What was done / Files changed / Verification / Notes); caveman mode keeps the structure at one telegraphic line per field',
          'no more vague "done" replies: commands and counts on every line — no "various files", no "works fine"',
        ],
      },
      {
        name: 'TEST mode — same rigor on every stack',
        items: [
          'the QA persona now teaches per-kind methods: web (serve + browser flows + shots/vision) · CLI (real commands, exit codes, stdout/stderr, edge cases) · API (curl, status codes, payloads, error handling, auth) · bot (real channel or simulator, replies + side effects) · library (test suite, build, import, public API) · pipeline (real sample data, output verified end-to-end)',
          'the workflow is restated stack-neutral — understand → start it → exercise → report — with the web path kept as the fully-detailed reference',
          '"reading the code is not testing" is now explicit in the persona',
        ],
      },
      {
        name: 'Fixes + internals',
        items: [
          'build persona closes the loop: "implementation done → TEST time — run the checks, exercise what you built, fix what fails; only verified work earns the Finishing summary"',
          '6 new loop-contract checks + the caveman-summary check (switch-mode suite: 52 green); testmode assertions restated for the renamed workflow steps (59 green); full battery re-run green',
          'additive again: every protected contract survives (mode personas, MCP, ask_user, delegation, PRD/QA, switch_mode approval gate)',
        ],
      },
    ],
  },
  {
    version: '0.28.0',
    date: '2026-09-24',
    title: 'The update that fixes updates — switch_mode, elite-executor prompt',
    summary:
      '`tagent update` never dead-ends again. The version check walks a chain of four endpoints (raw GitHub → jsDelivr CDN → the GitHub API), binary downloads resume where they stopped and verify their SHA256 before swapping, a root-owned install directory is rescued into ~/.local/bin without sudo, and every failure prints the exact next command. Also: switch_mode — the agent moves PLAN → BUILD → TEST inside one conversation, each flip behind your approval — and the operating prompt is upgraded to the elite-executor spec (identity, language mirroring, the work loop, hard rules, structured finishing summary).',
    stable: true,
    sections: [
      {
        name: 'tagent update — bulletproof by default',
        items: [
          'version check: a chain answers instead of one flaky host — TAGENT_UPDATE_URL → raw.githubusercontent.com → cdn.jsdelivr.net (fast in Asia, rarely blocked) → the GitHub releases API (tag_name normalized), 8s per hop',
          'binary downloads show live progress (curl meter), survive interrupted transfers: up to 3 attempts RESUMING the partial file (-C -), stall detection (10 KB/s for 90s kills a hung transfer), connect timeout, and an 8 MB size floor',
          'every downloaded binary is verified against the release\u2019s SHA256SUMS.txt before it touches disk as your tagent — a corrupted transfer is discarded and retried, never swapped in',
          'the swap handles ETXTBSY (running binary, brief retry) and rescues EACCES/EPERM (root-owned /usr/local/bin) by installing to ~/.local/bin — usually EARLIER on PATH, so the new binary takes over on the next launch with no sudo; if even that fails, the one-line fix is printed',
          'npm/bun installs can no longer dead-end: tagent is not published on npm (a global install only ever came from a git URL), so after the package-manager failure the updater falls back to the standalone binary in ~/.local/bin and tells you which old copy to remove',
          'source installs recover a detached HEAD (checked-out tag/commit) by returning to the default branch before pulling, and a failed `bun install` is now reported with the exact recovery command instead of silently printing "updated"',
          'downloads run async — a 100 MB update no longer freezes the TUI/daemon; a leftover verified download from a crashed run is reused, not re-fetched',
        ],
      },
      {
        name: 'switch_mode — the full loop in one conversation',
        items: [
          'the agent can flip its own operating mode mid-run — build ↔ plan ↔ test — but every flip is a permission-gated tool call: you see the target mode and the reason, nothing changes until you approve',
          'on approval the loop swaps the persona and toolset for the FOLLOWING turns, persists session.mode, and fires mode:change through the host bus — TUI navbar chip, GUI and relay viewers all follow',
          'the loop it unlocks: plan approved → switch to build; implementation done → switch to test and verify; test found bugs → switch back to build and fix',
          'primary agent only (depth 0) — subagents keep their mode fixed at spawn; deny → "Permission denied" is fed back and nothing changes',
        ],
      },
      {
        name: 'The operating prompt — elite-executor spec',
        items: [
          'identity: an autonomous engineer in the Codex / Claude Code / OpenCode / Aider league — an end-to-end executor (plan → code → test → iterate), not a chatbot; production-grade output on any project',
          'language: ALWAYS mirror the user\u2019s language in replies; code, comments and commits stay English-convention; to-the-point engineer tone, no filler',
          'the work loop is explicit: understand → plan → build → test with evidence, escalate after ~5 blind retries, never guess silently; switch_mode is taught as the way to move between phases',
          'hard rules with teeth: never claim a test passed without running it, never edit a file you haven\u2019t read, no placeholder TODOs, no syntax-broken code, no "should work" claims',
          'finishing ceremony: every session ends with a structured summary — what was done, files touched, how it was verified, notes, and the next step',
          'additive rework — every protected contract from the old prompt survives (mode personas, MCP, ask_user, delegation, PRD/QA workflows); 46 new switch_mode checks, 31 new updater checks, full battery green',
        ],
      },
    ],
  },
  {
    version: '0.27.0',
    date: '2026-09-23',
    title: 'Async subagents — background work, 3-lane fallback, /config add/apply',
    summary:
      'Subagents no longer block. task {background:true} returns an id (a1, a2…) instantly and the main agent keeps working while the sub runs detached — reports flow back on their own: mid-run they arrive as injected [SUBAGENT REPORT] messages, and if the agent already finished, it auto-resumes in a fresh run and continues without ever asking the user. Monitoring is first-class: the subs tool for the agent, /subs for the user. Fallback becomes three independent lanes (main · subagent · vision), and /config turns into the add/apply template: register a provider+model once, then apply it as the model for main/subagent/vision — or as the fallback for any of those three.',
    stable: true,
    sections: [
      {
        name: 'Background subagents — fire and forget',
        items: [
          'task {background:true} returns "BACKGROUND SUBAGENT STARTED — a1 …" immediately — the parent loop never waits, so the agent keeps solving while subs chew on side quests in parallel',
          'report delivery in both orders: sub finishes while the agent is mid-run → the report is injected as a [SUBAGENT REPORT] user message at the top of the next turn; agent finished first → the host auto-resumes it in a fresh run that starts from the report — no user confirmation, ever',
          'a text notify lands for the user every time a sub delivers: "subagent a1 finished — report delivered"',
          'multi-sub by design — fire a1, a2, a3…; the parallel limit is yours: subagents.maxParallel (default 4, hard cap 16) via /config subs <n>',
          'reports never strand: a no-action turn with a pending report takes one more turn instead of dying quietly, and stopping the agent never aborts its orphan subs (a dead loop refuses injections but its detached subs finish and are delivered on resume)',
        ],
      },
      {
        name: 'Monitoring — subs everywhere',
        items: [
          'agent-side: the new subs tool — subs lists every background sub (id, kind, state, elapsed), subs {id} re-reads a finished report in full',
          'user-side: /subs live view in the TUI · subs:view RPC for the daemon/GUI — the registry is host-owned, so TUI and GUI always see the same truth (ids a1/a2…, states, finished reports trimmed at 20)',
          'the Delegation section of the system prompt now teaches the agent when to go background, the auto-resume semantics, and how to poll with subs',
        ],
      },
      {
        name: 'Fallback, per-role — three lanes',
        items: [
          'three independent chains: main (the legacy fallback field, unchanged) · subagent (what task-tool subs walk) · vision (the vision tool walks its own chain — failover covered by tests end-to-end)',
          '/fallback reworked: /fallback <main|subagent|vision> add|rm|clear plus the full 3-chain view in one command — Indonesian aliases utama/sub/media kept working',
          'role overrides become lane primaries: set a dedicated subagent or vision model and it sits at the head of its own chain, with your fallback list behind it',
        ],
      },
      {
        name: '/config — the add · apply template',
        items: [
          'add: register things once — MCP servers, a provider (with its apikey and default model), keys',
          'apply: a provider+model you already added, put to work — as the model for a role (main · subagent · vision) or as a fallback for any of the three lanes',
          'the dashboard: + add · ⚡ apply · ⛓ fallback · 🤖 subs (limit + live view) · keys · sync (status/push/pull) — /config apply, /config fallback, /config subs <n> subcommands included',
        ],
      },
      {
        name: 'Fixes & internals',
        items: [
          'race fix: chatSend\'s finally only clears ITS loop — a background deliver landing in the window between runs no longer clears a fresh run\'s state (a pre-existing window, now closed)',
          '40 new hermetic checks in scripts/test-async-subs.ts: registry ids/limit/finish, immediate-return spawn, mid-run injection (the turn-4 model call SAW the report), late delivery after run end, the subs tool, 3-lane fallback, vision failover — every suite re-run green',
        ],
      },
    ],
  },
  {
    version: '0.26.0',
    date: '2026-09-23',
    title: 'The delegation stack — subagents, model roles, deep vision QA',
    summary:
      'Subagents are real: the main agent can hand whole subtasks — or an entire QA pass — to a focused sub-agent that runs in the same workspace, reads files itself, and reports back. Models split into three categories (main · subagent · media) so your coding model, your sub-agent model, and your vision model are chosen independently. And test mode goes deep: screenshots flow to the dedicated vision model, which returns a real UI review — typography, responsiveness, contrast, accessibility — not just "does it load".',
    stable: true,
    sections: [
      {
        name: 'Subagents — the task tool',
        items: [
          'built-in kinds: "general" (full toolset like yours, minus spawning) · "explore" (read-only recon) · "test" (the QA kit — serve + browser + vision, read-only)',
          'subs run in YOUR workspace with the same file tools — they read whatever they need themselves, so prompts carry instructions + paths, never pasted file contents',
          'no recursion: a subagent cannot spawn further subagents and never faces the user (ask_user stays the primary agent\u2019s job)',
          'custom specialists: drop a markdown file in .tagent/agents/ (or ~/.tagent/agents/) — front-matter for model, tools whitelist, mode (build | plan | test), maxTurns; the body is its persona',
          'a fast-path economy layer: plain "read file X" prompts never spawn a subagent at all — the files are served directly',
        ],
      },
      {
        name: 'Three model roles, set independently',
        items: [
          'models.subagent — what task-tool subagents run on (unset = the main model, as before)',
          'models.media.vision / .audio / .video / .pdf — the analysis models; the vision tool routes screenshots to media.vision',
          'set them from the TUI: /model subagent|vision|audio|video|pdf <provider/model> · off → follow main · or pick interactively with /model',
          'the GUI gets a Model-roles dialog in the model dropdown — subagent + all four media slots, with per-role model pickers',
        ],
      },
      {
        name: 'Vision QA — image → model → report',
        items: [
          'browser shots (action "shots" captures desktop + tablet + mobile in one call) land in .tagent/test/shots — pass the directory, a single file, or a comma list to the vision tool (a directory takes its newest 4)',
          'the dedicated vision model returns a structured review: functionality, layout & alignment, typography scale, responsive comparison across viewports, color & contrast, accessibility quick-pass, then a PASS/WARN/FAIL verdict with severity-tagged issues and suggested fixes',
          'no dedicated model? the main model is used when it accepts images — otherwise a setup error points at /model media vision',
        ],
      },
      {
        name: 'Test-mode delegation (fixed on the way out)',
        items: [
          'the main agent delegates verification mid-build: task {"agent":"test"} spawns a QA sub that genuinely runs read-only with the VERIFICATION persona and the full QA toolset (test_report, browser, vision, serve, bash, bg)',
          'fix: that same spawn used to run the sub in the parent\u2019s mode — a build-mode parent got a sub with a "your job is WORKING CODE" persona and write_file/edit_file available, while only the session metadata said test; the test suite\u2019s persona check was a tautology (|| true) and never caught it. Both fixed — the assertions now read the sub\u2019s actual system prompt',
          'test-mode QA leads can fan out sub-testers too: several pages/flows, each with a self-contained scope, merged into one report',
        ],
      },
    ],
  },
  {
    version: '0.25.1',
    date: '2026-09-23',
    title: 'The OAuth App is live — one-click login for everyone',
    summary:
      'The tagent OAuth App is registered, and its client id ships inside every binary: the "Connect with GitHub" button now appears out of the box — no TAGENT_GH_CLIENT_ID, no config, no token hunting. Along the way a fatal bug surfaced: the device-code request went to github.github.com (a bad string replace), so v0.25.0\u2019s flow never actually reached GitHub. That is fixed, the device page now opens with ?user_code= prefill where possible, and client-id resolution is now env → config → bundled — your own github.clientId finally overrides the built-in one.',
    stable: true,
    sections: [
      {
        name: 'One-click login, on by default',
        items: [
          'BUILTIN_OAUTH_CLIENT_ID is set — every install gets the Connect with GitHub button, tagent auth --device works without env vars, and the GUI/TUI device-flow options light up',
          'client-id resolution is now env (TAGENT_GH_CLIENT_ID) → your config (github.clientId) → the bundled app — previously the baked id would have shadowed your config',
          'the device page opens with ?user_code=<code> appended — GitHub doesn\u2019t send verification_uri_complete, so we try the query-param prefill ourselves; the page still shows the code big with a copy button as the fallback',
        ],
      },
      {
        name: 'Fixes',
        items: [
          'device flow was hitting https://github.github.com/login/device/code (a broken template replace: \u2018https://api.github.com\u2019 \u2192 \u2018https://github\u2019) — GitHub answered 405 every time, so the v0.25.0 button never worked against real GitHub (tests used a mock, which is why it slipped through); the endpoint is now the correct https://github.com/login/device/code',
          'host.ts had its own client-id resolution with the opposite precedence (config → env, no builtin) — the GUI could disagree with the CLI; both now share getOAuthClientId',
        ],
      },
    ],
  },
  {
    version: '0.25.0',
    date: '2026-09-23',
    title: 'OAuth login — one button, no token hunting',
    summary:
      'The web-connect page gets a "Connect with GitHub" button: click it, GitHub opens with the code pre-filled, press Authorize, done — no creating tokens, no copy-pasting scopes. It is the GitHub OAuth device flow (needs a registered OAuth App id via TAGENT_GH_CLIENT_ID or config github.clientId; without one the page stays the classic paste-a-PAT form). "Paste a token instead" stays one click away, tagent auth --device prints the one-click link too, slow_down no longer kills the poll loop, and the login server lingers 2s after success so the browser always shows the ✔ Connected card.',
    stable: true,
    sections: [
      {
        name: 'One-click OAuth (device flow, zero secrets shipped)',
        items: [
          'the button appears when a client id is configured: TAGENT_GH_CLIENT_ID env, config github.clientId, or the id baked into the release (BUILTIN_OAUTH_CLIENT_ID — empty until the tagent OAuth App exists, then every install gets the button by default)',
          'click → 302 to github.com/login/device/<code>?user_code=… → the CLI polls GitHub on its own clock until you authorize (or deny); the code shows on the page with a copy button if GitHub didn\u2019t open — UserLAnd/Termux friendly',
          '"Paste a token instead →" keeps the classic PAT flow one click away even with OAuth on; without a client id the page renders exactly the old paste-first form',
          'tagent auth --device prints the one-click link too (verification_uri_complete) — GitHub opens with the code pre-filled instead of typing ABCD-1234',
        ],
      },
      {
        name: 'Fixes riding along',
        items: [
          'device-flow slow_down no longer kills the poll loop — GitHub\u2019s back-off is honored (was a fatal error); the poll is now a per-round-trip API (pollDeviceTokenOnce) the web page drives at its own cadence',
          'the login server lingers ~2s after success so the browser\u2019s final poll gets "status: ok" and shows the ✔ Connected card — previously the page could hit a dead port at the exact moment of success',
          'security shape unchanged: loopback-only bind, one-time secret URL path, origin checks on POST, one-shot after login, no-store',
        ],
      },
      {
        name: 'Setup (one-time, ship the button to every user)',
        items: [
          'GitHub requires a registered OAuth App: create one at github.com/settings/developers (any name, homepage = the tagent site, callback URL = anything — device flow ignores it)',
          'then set TAGENT_GH_CLIENT_ID or tagent config github.clientId for yourself — or bake the id into BUILTIN_OAUTH_CLIENT_ID in packages/core/src/github.ts and release: every install gets the button by default',
        ],
      },
    ],
  },
  {
    version: '0.24.0',
    date: '2026-09-23',
    title: 'Config sync — one repo, every device',
    summary:
      'Logging in now auto-creates a private tagent-config repo that carries your WHOLE global config — providers, api keys, models, MCP servers, permissions, theme — encrypted, identical on every device. /config is the new cockpit: add mcp/providers/keys, push and pull the config, and manage the new multi-key keychain (several named API keys per provider — pick the active one in /model, or stack them into the fallback chain). `tagent start` checks the repo every boot and warns if it was deleted on GitHub; /config push recreates it. The project vault now travels the keychain too.',
    stable: true,
    sections: [
      {
        name: 'The config repo — auth auto-creates it',
        items: [
          'tagent auth (terminal, TUI /auth, web GUI) now ensures a PRIVATE login/tagent-config repo right after login and pushes the global config into it — AES-256-GCM sealed vault.json, token never leaves the device',
          'the vault carries the WHOLE config: default provider/model, api keys, the keychain, custom providers, MCP servers, permissions, fallback chain, theme, caveman, compact, cache, diagnostics… (device-local paths and the GitHub token never travel)',
          'a defaults-only device can never clobber a richer remote: every bootstrap pulls first and pushes the union — pull = remote wins per key, push = local wins, conflicts abort with "nothing was lost"',
        ],
      },
      {
        name: '/config — the global cockpit',
        items: [
          '/config dashboard: repo health, push/pull, named keys, add mcp (global — every project, hot-loads here too), add provider, set the global default model',
          '/config push · /config pull — explicit sync of the whole config; /config status shows repo health (exists / deleted / offline), last push & pull, key counts per provider',
          '/config add key <provider> — name your keys ("work", "backup", "free tier"); /config keys lists them with ● active / ○ idle, switches the active one, removes, or stacks one into the fallback chain',
        ],
      },
      {
        name: 'Multi-key everywhere',
        items: [
          'the keychain lives in the GLOBAL config → the config repo carries it to every device; the ACTIVE key stays apiKeys[provider], so every existing resolution path works untouched',
          '/model now asks which key to use when a provider has several — pick once, it feeds every request (the choice also lands in the workspace so it is effective immediately)',
          '/apikey registers each key into the keychain (first = "main", later ones ask for a label); /fallback stacking uses keychain keys for key-level failover',
        ],
      },
      {
        name: 'Boot health + doctor',
        items: [
          'every `tagent start` checks the config repo: deleted on GitHub → a yellow banner every single boot until /config push recreates it; remote moved → pulled and applied automatically; local moved → pushed — devices converge with zero clicks',
          'offline / not logged in → silence, next start checks again ("ngecek terus"); existing installs bootstrap the repo lazily on the first start after upgrading',
          'tagent doctor reports the config repo (exists / deleted / not set up) and the keychain (named keys across providers)',
        ],
      },
    ],
  },
  {
    version: '0.23.1',
    date: '2026-09-22',
    title: 'Chips — background badges on tool titles & reports',
    summary:
      'Tool titles, status pills and report headers get a background: every tool box now opens with a filled chip (💻 bash on tomato, 🔌 MCP on red…), the run verdict and result rows ride status pills (✔ done on green, ✗ error on red), and every report — MCP servers, repo sync, skills, memory, checkpoints — opens with a themed header chip plus per-line state chips. Each of the six themes ships its own hand-tuned badge table (saturated chips with white text, or pastel neon with near-black), switched live by /theme like everything else. `tagent doctor` got the same treatment.',
    stable: true,
    sections: [
      {
        name: 'Chips — text on a filled background',
        items: [
          'tool-call titles ride a bg chip: ╭─[💻 bash]──… with the icon + name on the category color — bash tomato, MCP red, reads blue, writes green, search magenta, web cyan, ask yellow',
          'result rows ride status pills — ✔ done on green, ✗ error on red, ⊘ denied on yellow — next to duration and the output tail',
          'banner boxes (run verdicts, auto-sync pushes/pulls) carry the chip too: ✔ done / ⎇ auto-sync ride a filled pill in the top rail',
        ],
      },
      {
        name: 'Reports with chip headers',
        items: [
          '/mcp list opens with a 🔌 MCP chip and every server state rides its own chip — ready ✓ green, error red, connecting yellow, off dim — with names still aligned',
          '/repo status opens with a ⎇ sync chip, the history log chips each round (pushed green · pulled cyan · error red), and /push / sync report ↑ pushed / ✗ pills',
          '/skills, /memory and /checkpoints open with 🎯 / 🧠 / 💾 header chips + counts; permission verdicts, compaction, notify errors and the chat-error line all ride pills — one vocabulary everywhere',
        ],
      },
      {
        name: 'Per-theme badge tables',
        items: [
          'each theme ships nine hand-tuned badge pairs (red/green/yellow/blue/magenta/cyan/orange/dim/accent): dark uses the classic Unix combos (white on red/blue, black on green/yellow/cyan), tokyo-night & dracula go pastel neon with near-black text, nord & gruvbox use their strong colors, light keeps dark chips with white text',
          '/theme recolors chips on the next frame like every other surface; NO_COLOR and non-TTY degrade to plain text with identical widths — layout never shifts',
          'tagent doctor, sync, clone and auth outputs ride the same chip look on the CLI side (42/30 classic pairs that read on both dark and paper-white terminals)',
        ],
      },
    ],
  },
  {
    version: '0.23.0',
    date: '2026-09-22',
    title: 'TUI maximalization — themes, tool boxes, taps',
    summary:
      'The transcript gets the design it deserved. Every tool call rides a rounded box in its category color (bash tomato, MCP red, reads blue…), run stats and sync pushes ride two-line banner boxes, and the AI reply renders as live markdown while it streams — no more raw ## and ** on screen. Six themes ship (dark, light, Tokyo Night, Dracula, Nord, Gruvbox) switched live via /theme, menus grew number badges — press 1-9 or tap the row on touch terminals — and the input box no longer collides with the reply on narrow screens.',
    stable: true,
    sections: [
      {
        name: 'Themes — /theme [name]',
        items: [
          'six built-in themes: dark (default, byte-identical to the old palette), light, tokyo-night, dracula, nord, gruvbox — 256-color SGR so every terminal renders them, NO_COLOR still wins',
          '/theme switches LIVE: navbar, editor, tool boxes, banners and markdown recolor on the very next frame — and the pick is saved to the global config (~/.tagent), reapplied at boot',
          'markdown body follows the theme — headings, list markers, code chips and fence labels re-hue per palette (light themes get dark-leaning shades that read on white)',
        ],
      },
      {
        name: 'Tool-call boxes',
        items: [
          'every tool call rides a rounded box: icon + tool name in the title rail, the summarized input as the body, and the result row closing it — drawn open at tool:start, closed at tool:end (the transcript stays append-only)',
          'the border carries the tool\u0027s category color: bash tomato, MCP red, reads blue, writes green, search magenta, web cyan, ask yellow — tools read at a glance while scrolling',
          'the result row shows status + duration + the first line of output (✔ done · 1.2s — …)',
        ],
      },
      {
        name: 'System banner boxes',
        items: [
          'run verdicts ride a two-line banner box: ✔ done / ■ stopped / ✗ error in the top rail, the stats (turns · tool calls · seconds · tokens) in the bottom rail',
          'auto-sync pushes and pulls get the same frame — non-chat output now stands apart from chat without reading the fine print',
        ],
      },
      {
        name: 'Live markdown streaming',
        items: [
          'while the model streams, the tail renders with the SAME renderer as the final flush — headings, lists, bold and links appear styled, not as raw markers',
          'a streaming code block renders as a code box: an unclosed fence is auto-closed mid-stream so partial code shows as code',
          'the rendered tail is cached by length (chunks only append) so live re-rendering stays cheap',
        ],
      },
      {
        name: 'Mobile-friendly menus',
        items: [
          'number badges: non-searchable lists pick directly with 1-9 — the ctrl+x menu, mode picker, theme picker; permission prompts take 1-4 alongside y/a/s/n. One tap, no arrow dance',
          'touch support in fullscreen: menu rows, permission options, ask-form options and submit, the /-palette and @-file completion all respond to a tap (SGR mouse reporting)',
          'the ctrl+x menu dropped type-to-filter — digits and taps are the path on phones (searchable pickers like the model list still filter)',
        ],
      },
      {
        name: 'Rendering fixes',
        items: [
          'input-box / reply collisions fixed on narrow terminals: every sticky row is hard-truncated to the terminal width and the navbar\u0027s hard 34-column floor went responsive — the sticky-region geometry can no longer break and paint the editor over the transcript',
          'stale tap zones can no longer double-fire a menu action after a re-render',
        ],
      },
    ],
  },
  {
    version: '0.22.3',
    date: '2026-09-22',
    title: 'MCP failures that say why — in plain language',
    summary:
      'v0.22.2 taught doctor to capture stderr, but a node crash still summarized as "} | Node.js v24.20.0" — the banner, not the disease. The summarizer now picks the actual diagnosis (the Error: headline plus its code), names a full disk plainly instead of quoting the package manager\u0027s multi-line essay, and attaches one actionable hint per known cause (disk full → free space; MODULE_NOT_FOUND via npx → clear the npx cache). Doctor also grew a disk-space check, so the #1 environmental killer of MCP servers is caught before the symptoms.',
    stable: true,
    sections: [
      {
        name: 'MCP: reasons a human can read',
        items: [
          'a node-style crash no longer surfaces "} | Node.js v24.20.0" — the `Error: Cannot find module \u0027zod\u0027` headline and its `code: \u0027MODULE_NOT_FOUND\u0027` are named, stack frames and version banners are dropped',
          'ENOSPC ("No space left on device (os error 28)") is named plainly and flagged as a full disk; the package manager\u0027s hint essay is dropped',
          'stderr tail raised from 1.5KB to 2.5KB so long node stacks no longer push the headline out of the window',
        ],
      },
      {
        name: 'MCP: one actionable hint per known cause',
        items: [
          'disk full → "free disk space (npm cache clean --force · bun pm cache rm · docker system prune), then /mcp reload"',
          'MODULE_NOT_FOUND launched via npx/bunx → "broken npx cache (common after a full disk) — rm -rf ~/.npm/_npx, then /mcp reload"',
          'network, permissions, port-in-use and connection-refused causes each map to their one fixing move; unknown causes show the raw reason only',
          'hints appear in doctor, /mcp list and the /mcp menu',
        ],
      },
      {
        name: 'Doctor: disk-space check',
        items: [
          'new check right after the global dir: free bytes on the home filesystem (statfs, `df -k` fallback) — the disk npx/uvx install servers onto',
          'under 256 MB free it fails with cleanup commands; under 1 GB it warns — before you spend minutes wondering why every server exits (code 1)',
        ],
      },
    ],
  },
  {
    version: '0.22.2',
    date: '2026-09-22',
    title: 'MCP failures that say why — and a navbar that says where',
    summary:
      'A dead MCP server used to report nothing but "error — server exited (code 1)": the reason it died (npm network error, old Node, missing launcher) was thrown away because stderr was never read. The full story is now captured and surfaced — doctor and /mcp name the disease, a missing npx transparently falls back to bunx on bun machines (same npm packages), and calls made after a death explain themselves. The navbar also grew a workspace segment, so the facts row reads build · 📂 my-project · model.',
    stable: true,
    sections: [
      {
        name: 'MCP: the failure says why',
        items: [
          'server stderr is captured — the exit error carries the last lines of it, so "code 1" becomes "code 1: npm ERR! code ENOTFOUND"',
          'a missing launcher is named: "cannot start \u0027npx\u0027 — not found on PATH", with install advice instead of a bare exit code',
          'doctor and the /mcp menu show up to 160 chars of the reason (was 60); calls after a death include it too',
        ],
      },
      {
        name: 'MCP: npx → bunx fallback',
        items: [
          'binary installs ship no Node.js — a configured npx may simply not exist. When bun is installed, tagent transparently launches the server with bunx (runs the very same npm packages)',
          'the fallback appears as a note in /mcp and doctor ("npx not on PATH — using bunx") instead of three dead servers',
          'custom absolute-path launchers and non-npx commands are untouched',
        ],
      },
      {
        name: 'Navbar: workspace segment',
        items: [
          'the facts row now reads 🤖 build · 📂 my-project · glm-4.7 · 🔌 2✓ 31 — you always know which folder the agent is working in',
          'truncated to 18 cells so long folder names never push the model or MCP status off the bar',
        ],
      },
    ],
  },
  {
    version: '0.22.1',
    date: '2026-09-21',
    title: 'Pastes that paste — in every terminal',
    summary:
      'v0.22.0 made bare enter send, which exposed a corner: in terminals without bracketed-paste support, a pasted multi-line blob arrived as raw keystrokes and the first line\u2019s newline submitted the composer. The raw-paste heuristic now recognizes that burst and reroutes it into the editor as text — newlines land as newlines, CRLF pairs collapse, blank lines survive, a trailing copy-newline drops, and pasted terminal escape garbage never reaches the composer. Typed input is untouched: a bare enter at the end of its own keystroke burst still sends.',
    stable: true,
    sections: [
      {
        name: 'Raw-paste fallback (no bracketed paste needed)',
        items: [
          'terminals that ignore the bracketed-paste mode (older conhost, some SSH/IDE consoles) send pastes as one burst of raw keys with a bare carriage-return at each line end — that burst is now detected and inserted as text instead of parsed as keys',
          'CRLF, CR-only, and LF-only pastes all land with their line structure intact; a CRLF pair becomes one newline and blank lines survive',
          'a single trailing newline (the select-copy artifact) is dropped, same as bracketed pastes',
          'pasted CSI/escape bytes — the coloring codes that ride along when you copy terminal output — are stripped so control garbage never lands in the composer',
        ],
      },
      {
        name: 'Typing stays typing',
        items: [
          'a bare enter as the last key of its burst still submits — fast typists and coalesced chunks included',
          'modified enters are never mistaken for pastes: alt+enter, kitty shift/ctrl+enter keep inserting newlines mid-chunk',
          'menus, dialogs, the ask-form notes box: paste lands in whichever editor owns input, same as before',
        ],
      },
    ],
  },
  {
    version: '0.22.0',
    date: '2026-09-21',
    title: 'The agent that asks properly — and enter that sends',
    summary:
      'Three directives reshape how the agent works in every mode: questions always go through the ask_user form instead of a plain-text question that stalls the run, connected MCP tools are used on the agent\u2019s own initiative, and build mode carries a professional quality bar — "build a blog" means Blogger/Ghost-level work, never one bare HTML file unless you explicitly asked for simple. The input keys are back to the natural convention: enter sends, shift/alt/ctrl+enter makes a newline.',
    stable: true,
    sections: [
      {
        name: 'Directive: ask through the form',
        items: [
          'whenever something material is unknown, the agent calls ask_user — the interactive form with options and input fields — never a plain-text question ending the turn',
          'works in every mode, any time mid-run; the form waits for the answer and the structured reply flows straight back into the work',
          'the action protocol itself now points mid-run questions to ask_user instead of "reply with text only"',
        ],
      },
      {
        name: 'Directive: MCP tools used unprompted',
        items: [
          'when MCP servers are connected, the prompt lists them and teaches auto-detecting each tool from its [mcp:<server>] prefix and description',
          'docs lookups, web reading, knowledge graphs — the agent reaches for them the moment they fit, in every mode',
        ],
      },
      {
        name: 'Directive: professional quality bar',
        items: [
          'the default is professional-grade, production-quality work — simplifying only when you explicitly ask for simple/minimal/quick/prototype',
          '"build a blog" means a real polished product on the level of Blogger/Ghost — theme and layout system, navigation, post pages, search, tags, RSS, SEO meta, responsive down to mobile — NOT one bare HTML file',
          'no placeholders where real work belongs: no TODO stubs, no lorem ipsum where real copy is expected',
        ],
      },
      {
        name: 'Keys: enter sends again',
        items: [
          'bare enter SUBMITS — chat muscle memory everywhere; shift+enter (also alt/ctrl+enter) inserts a newline for long messages',
          'menus and dialogs keep enter=accept; the ask-form notes box follows the same swap (bare enter newlines, modified moves on)',
          'bracketed paste unchanged — multi-line pastes still land as text, never an Enter-submit per line',
        ],
      },
    ],
  },
  {
    version: '0.21.0',
    date: '2026-09-21',
    title: 'The chat that survives the exit — and the devices that show up',
    summary:
      'Closing tagent no longer closes the conversation: boot replays the last chat under the banner, and /clear [count|all] wipes only the text on screen while the agent\u2019s memory stays. Every running sync engine heartbeats into the repo, so the navbar shows when another device is online; /repo status grows a per-project sync history. The agent can now budget each MCP call itself with __timeout_ms, and same-millisecond sessions no longer confuse the boot-resume picker.',
    stable: true,
    sections: [
      {
        name: 'New: chat memory across restarts',
        items: [
          'each session keeps a transcript sidecar (.tagent/sessions/<id>.transcript.json) — the rendered chat text exactly as you read it, ANSI included',
          'boot replays the newest session\u2019s text right under the banner ("the chat is simply back, like tagent was never closed"); tagent start --fresh boots empty instead',
          '/open and /new swap the display to the switched session — wipe, fresh banner, that session\u2019s text replayed',
        ],
      },
      {
        name: '/clear [count|all] — text only, memory stays',
        items: [
          'clears the screen AND the native scrollback AND the saved transcript; the session\u2019s messages (the agent\u2019s memory) are untouched — /clear 2 removes the last 2 rendered chat messages, /clear all wipes the text, /clear alone asks what you meant',
          'memory/text separation is explicit: messages are what the agent knows, the sidecar is what you were reading',
        ],
      },
      {
        name: 'New: device presence',
        items: [
          'every running sync engine heartbeats into the committed .tagent-sync/presence.json (every 45s, entries pruned by TTL) — presence travels with the repo like any other file',
          'the navbar and hint row show "◉ <device> online" while another device is fresh — close the lid, the badge fades within a minute',
        ],
      },
      {
        name: '/repo status — the full picture',
        items: [
          'link state · engine (interval, last round, ahead/behind) · devices with heartbeats · vault shares — one card',
          'per-project sync history, newest first: auto ticks and manual syncs land in .tagent/sync-history.json (when, direction, files, commit)',
        ],
      },
      {
        name: 'Agent-budgeted MCP calls',
        items: [
          'every mcp_* tool accepts __timeout_ms (1000–3600000, clamped): slow scrapers and pipeline tools get the budget they need per call, no env dance',
          'the param is stripped before the payload reaches the server; TAGENT_MCP_CALL_TIMEOUT_MS stays the global default',
        ],
      },
      {
        name: 'Fixed',
        items: [
          'sessions born in the same millisecond (scripted flows, fast /new) tied in the boot-resume sort and readdir order decided which chat came back — session timestamps are now strictly increasing per store',
        ],
      },
    ],
  },
  {
    version: '0.20.0',
    date: '2026-09-21',
    title: 'Projects that sync themselves — and settings that travel encrypted',
    summary:
      'Linked projects now push and pull automatically every few seconds while tagent runs, so every device stays converged. Config, API keys, providers, MCP servers and memory can ride along inside an AES-256-GCM encrypted vault that lives in the repo — only devices holding the passphrase can read it. /repo is the sync cockpit, tagent projects manages every linked project (sync · edit · clone · delete), the ESC key no longer eats the first letter typed after it, and the input box is pinned to the bottom edge of the screen.',
    stable: true,
    sections: [
      {
        name: 'New: auto-sync (5–15s, per project)',
        items: [
          'SyncEngine pushes and pulls linked projects on a timer while tagent runs — dirty tree commits & pushes; a clean tree fast-forwards when another device moved; conflicts are rebased, never lost',
          'the interval is per project (5s–1h, default 15s) and lives in .tagent-sync/ inside the repo — every device agrees; /repo interval changes travel with the project',
          'auto-sync only engages for projects you already linked and stays quiet offline — a fresh folder is never surprise-uploaded',
          'the hint row shows the live engine: ⎇ owner/repo ⇅15s ↑sha — pushes, pulls and errors each get one transcript line',
        ],
      },
      {
        name: 'New: encrypted settings vault (/repo)',
        items: [
          'choose what rides along: API keys, custom providers, MCP servers, saved memory — sealed with AES-256-GCM (scrypt key), so the repo can be public-read without leaking secrets',
          'the passphrase lives per device in ~/.tagent/credentials.json — set it via /repo passphrase (rotating re-seals the vault so other devices pick it up), and a fresh clone applies the vault automatically on boot',
          'first run with nothing set generates a strong passphrase and shows it once — save it, other devices need it to unlock',
        ],
      },
      {
        name: 'New: tagent projects — the manager',
        items: [
          'interactive cockpit over every linked project: sync now, edit (repo name, auto-sync, interval, vault shares, passphrase), clone to another folder, unlink this device, or delete the GitHub repo (double confirm, needs a delete_repo PAT)',
          'scriptable too: tagent projects list | sync <name> | rm <name>; tagent clone with no argument now opens a picker of your repos',
        ],
      },
      {
        name: 'Menu audit — options that used to error when selected',
        items: [
          'ESC followed by another key was swallowed as an "unknown escape sequence" — menus appeared not to close and the first letter typed after ESC was eaten. Both now resolve cleanly',
          'slash commands and ctrl+x menu actions catch their own errors: a broken option prints one red line instead of an unhandled rejection',
          '/exit force-exits after cleanup — a live sync-engine timer can never leave a restored-but-hung process',
          'new test-menu-audit walks all 44 commands and the whole menu grid after every change',
        ],
      },
      {
        name: 'The editor sits at the bottom',
        items: [
          'fullscreen pads the transcript viewport to the full screen height — the input box is pinned to the bottom edge, the navbar\u2019s mirror image, instead of floating mid-screen on short transcripts',
        ],
      },
    ],
  },
  {
    version: '0.19.0',
    date: '2026-09-20',
    title: 'Background tools, modes that know their job, and a true multi-line input',
    summary:
      'The agent can now run long processes in the background and check on them while it keeps working (bg_run / bg_logs / bg_stop). Build/plan/test modes each ship exactly the tools their job needs — plan and test keep MCP. The input editor is genuinely multi-line: Enter inserts a newline, shift+enter sends, and multi-line pastes land as text instead of an Enter-submit per line. The agent also sets its own tool timeouts, provider errors read like errors, and markdown code renders as chips.',
    stable: true,
    sections: [
      {
        name: 'New: background processes (bg_run · bg_logs · bg_stop)',
        items: [
          'bg_run spawns any long-running command in its own process group and returns immediately — dev servers, file watchers, soak tests, slow installs keep running across turns while the agent works',
          'bg_logs polls the process: status, uptime, output line count, and the tail — a growing line count between checks is the "still working" signal; bg_stop kills the whole tree',
          'one handle per name per session, early-crash detection returns the output when a command dies instantly, and everything is killed on exit — no leaked processes',
        ],
      },
      {
        name: 'Modes that know their job',
        items: [
          'build mode ships only project-affecting tools — the QA report (test_report) is test mode\u2019s deliverable, not the builder\u2019s',
          'plan mode: investigate + interview — read/search/web/ask_user plus explore subagents (task is back in plan)',
          'test mode (QA) knows the workflow: PRD.md is the spec, WORKLOG.md is what actually shipped; it teaches bg_run for non-web processes and how to budget its own timeouts',
          'MCP and plugin tools stay available in plan AND test mode (the permission gate still asks the human for every risky call)',
        ],
      },
      {
        name: 'Multi-line input, paste that behaves',
        items: [
          'Enter inserts a newline; shift+enter (also alt/ctrl+enter) submits — kitty keyboards report shift+enter natively, legacy terminals can always use alt+enter',
          'bracketed paste mode: multi-line pastes land as text in the editor — never an Enter-submit per line; pastes route into whatever editor owns focus (main editor, dialogs, ask-form fields), and a single trailing newline is dropped',
          'the editor box grows to 8 rows with cursor-following scroll, and its placeholder teaches the new keys',
        ],
      },
      {
        name: 'Agent-set timeouts + readable errors',
        items: [
          'bash timeout ceiling 5min → 60min, serve ready-wait likewise — the agent budgets long builds/installs itself instead of watching them die at the default',
          'TAGENT_MCP_CALL_TIMEOUT_MS env for MCP tool calls (default 2min) — scrapers and pipeline tools are slow by nature',
          'provider HTTP errors render for humans: an OpenRouter 402 now reads "add credits at …" instead of a triple raw-JSON dump (prettyHttpError covers OpenAI/Anthropic/Google shapes too)',
        ],
      },
      {
        name: 'Also',
        items: [
          'markdown: inline `code` renders as a padded chip (dark bg + light gold), fenced blocks get a cyan [lang] tag and the correct ╮ top corner',
          'banner and user cards clamp to the transcript width — the hard 44-column floor wrapped box rails mid-line on narrow terminals (odd widths, split panes, phone terms)',
          'the history viewer renders inside the inline app too, and arrow keys scroll it while it is open; the boot MCP handshake with its retry-once logic lands in the sticky navbar',
          'full test battery green: v0.19.0 suite 70/70, tui-app ALL, markdown 95/95, testmode 56, app-pty 42/42 (rewritten for the fullscreen default)',
        ],
      },
    ],
  },
  {
    version: '0.18.0',
    date: '2026-09-20',
    title: 'The glow-up: real TUI libraries — boxes, emoji, lines that finally align',
    summary:
      'The TUI is now built on real terminal libraries (string-width, figures, cli-boxes, picocolors, wrap-ansi) instead of hand-rolled width math. Boot banner and user messages are rounded cards (╭─╮), tool lines carry emoji icons with aligned columns, markdown tables draw as full box tables, and every width now counts CJK, emoji and combining marks correctly — the "garis gak rata" era is over.',
    stable: true,
    sections: [
      {
        name: 'New: shared UI kit (ui.ts)',
        items: [
          'backed by string-width + strip-ansi: true Unicode display width — CJK extension blocks (U+3400, U+20000+), emoji presentation (✅ ⚡ …), ZWJ families and combining marks all count correctly (the old hand-rolled table missed whole ranges, which is why columns used to wobble)',
          'figures for cross-platform symbols (✔ ✘ ❯ ↑↓) with automatic ASCII fallback on legacy terminals; cli-boxes for the ╭─╮ ╰─╯ round border preset; picocolors for color; wrap-ansi for hard word wrap',
          'one kit, four consumers: the inline TUI, the classic TUI, the markdown renderer and the select menus all measure with the same functions now',
        ],
      },
      {
        name: 'The glow-up',
        items: [
          'boot banner is a rounded card with an emoji row per fact (📂 workspace · 🤖 model · 🔌 mcp · 🌐 web gui) and a value column that is ALWAYS aligned — the old hardcoded-space padding was off by one column on two rows',
          'your messages echo as opencode-style rounded cards (╭─ ❯ you ──╮) — CJK and emoji in the text can no longer break the right rail',
          'tool lines get emoji icons (📖 read · 💻 bash · 🔍 search · 🌐 fetch · 💬 ask · 🧠 memory · 🤖 subagent …) and a fixed tool-name column, so durations and summaries line up vertically; results keep the ⎿ connector with ✓/✗ status',
          'markdown pipe tables render as full box tables (╭─┬─╮ ├──┼──┤ ╰─┴─╯) with l/c/r alignment preserved',
          'assistant messages get Claude Code\u2019s orange ● bullet; the status row gained a moon-phase spinner (🌑🌒🌓) with 🤔/⚡/🌊 phase emoji',
          '/help, /keys, /tools, /models, /mcp, /sessions menus pad with true width — emoji or CJK in names no longer shear the columns',
        ],
      },
      {
        name: 'Also',
        items: [
          'tagent v0.17.0 is out: context window bar + deterministic /compact + bulletproof update (stuck merges self-recover, ~/.tagent snapshotted before every update)',
          'full test coverage for the kit: 46 ui-kit unit tests plus the whole regression battery re-run green (tui-app, tui-md, markdown 95, compact 49, context-loop 30, ask 38, cache 38, features, select, host, PTY suites)',
        ],
      },
    ],
  },
  {
    version: '0.17.0',
    date: '2026-09-20',
    title: 'Context window bar + deterministic memory compaction',
    summary:
      'The opencode-style context bar under the chat input (12.3k/131.1k [██████░░░░] 9%) shows how much of the model\u2019s window your session eats — and at 80% you get a one-key prompt to compact. /compact summarizes old turns into a structured digest with ZERO AI calls: nothing invented, everything copied from the transcript. Updates also became bulletproof: stuck merge states self-recover, divergence never blocks, and ~/.tagent (auth · MCP · config) is snapshotted before every update.',
    stable: true,
    sections: [
      {
        name: 'Context window — the usage bar',
        items: [
          'live bar under the chat input, updated every turn: provider token usage when the API reports it, a local CJK-aware estimate otherwise',
          'color-coded: green under 60%, yellow 60–80%, red at 80%+ — /stats and the boot banner show it too',
          'model windows resolve from the editable zai-models.json (new contextWindow field per model), provider seeds and id heuristics; TAGENT_CONTEXT_WINDOW=<tokens> overrides everything',
        ],
      },
      {
        name: 'Compaction — ringkas memory, tanpa AI',
        items: [
          'at 80% (configurable via compact.threshold) the run ends with a one-key y/N prompt; /compact [keep-tokens] any time, also in the ctrl+x menu and the classic TUI',
          'old turns become ONE structured digest — who asked what, which tools ran on which paths, statuses, decisions — while the most recent ~10k tokens stay verbatim; a 100k-token history lands near 10k',
          '100% deterministic local code: no AI call, nothing generated, nothing hallucinated — every digest line is copied from the transcript, so prompt quality survives (the trail stays auditable)',
          'compaction costs zero tokens by design — it must never spend your model to save your tokens',
          '@file attachment bodies drop out of old turns (files live on disk, re-read when bytes matter); re-compaction folds the prior digest in, history never duplicates',
        ],
      },
      {
        name: 'Caveman mode, reworked — summarize, never blind-cut',
        items: [
          'big tool outputs become head+tail digests with explicit "…[compacted: N chars elided]…" markers instead of a silent mid-cut — the model always knows exactly what it did not see',
          'repeated lines collapse ("(×N)"), pretty JSON gets losslessly minified, 3+ blank lines collapse',
          'old write_file/edit_file action echoes are slimmed to path + preview — whole-file contents stopped being re-sent to the model on every turn forever (the newest 2 turns keep full inputs)',
          'old tool results become per-tool digests (tool + key input + status) instead of a generic placeholder; caveman mode starts dieting at 80k instead of 150k',
        ],
      },
      {
        name: 'Updates — never blocks, never loses data',
        items: [
          'stuck conflicted merge ("bun.lock: needs merge" / "you have unmerged files" — the state that killed both git stash and git pull) is auto-recovered: the in-progress operation is aborted, the index cleared, your files kept',
          'a diverged branch (local commits) no longer blocks the update: fetch + hard reset to the upstream tip, with the reflog recovery path printed',
          '~/.tagent (config, credentials/auth, models, MCP, workspace registry, memory instructions) is snapshotted into ~/.tagent/backups/update-<timestamp>/ before EVERY update and verified+restored after — the 5 newest snapshots are kept',
        ],
      },
    ],
  },
  {
    version: '0.16.1',
    date: '2026-09-20',
    title: 'Update fixes: dirty checkouts, doctor, MCP cold starts',
    summary:
      'The update that never blocks on local changes: source installs auto-stash a dirty checkout before pulling. doctor no longer false-flags a connected GitHub account, and MCP servers get a 60s cold-start budget.',
    stable: true,
    sections: [
      {
        name: 'Fixes',
        items: [
          'tagent update no longer dies with "Your local changes … would be overwritten by merge" — the checkout is auto-stashed (recoverable, labelled "tagent update v…") before the pull, and the output tells you where the stash lives and how to restore it',
          'doctor reported "✗ github: connected as <user>" on perfectly healthy installs — the token moved to ~/.tagent/credentials.json in the auth rework but the check still read config.json; it reads the credential store now (config = legacy fallback)',
          'MCP initialize budget 25s → 60s: npx/uvx cold starts (a fresh Codespace, CI boxes) easily blew the old limit and every server showed as timed out — override with TAGENT_MCP_INIT_TIMEOUT_MS=<millis>',
          'doctor explains a timed-out MCP server: first run downloads the package via npx, retry once warm — or raise the budget',
        ],
      },
    ],
  },
  {
    version: '0.16.0',
    date: '2026-09-20',
    title: 'AI ask forms + Z.ai models as a config file',
    summary:
      'The agent can now ask you questions through interactive forms (ask_user): option, multi-option and input fields, add-your-own options, an optional notes box — plan-mode interviews become one form instead of a chat interrogation. And the built-in Z.ai provider\u2019s model list moved from code to a config file you can edit: ~/.tagent/zai-models.json.',
    stable: true,
    sections: [
      {
        name: 'ask_user — the interview form',
        items: [
          'three field kinds: option (single choice, radio), multi (multiple choice, checkboxes) and input (free text) — batch up to 6 questions in one call, one round-trip',
          'option/multi fields always offer "+ add your own option" — your custom answer becomes a first-class choice, selected like any other',
          'every form carries an optional notes textarea under the fields for anything else worth saying',
          'the inline TUI renders the form as an interactive overlay: ↑↓ move · space/enter pick · a add option · tab next field · esc cancel — required fields block submit and jump back to you',
          'the web GUI gets a matching dialog (radio pills, checkboxes, textareas, add-option inline input); the classic TUI asks sequentially with arrow-key menus',
          'plan mode\u2019s INTERVIEW step now uses the form by default; build and test modes can use it too (one form instead of a wall of text)',
          'headless-safe: pipes and subagents get an honest "no interactive user" answer, so the model proceeds with stated assumptions instead of hanging; a dismissed form says so explicitly',
          'answers are formatted back to the model verbatim (with the notes) — plus a one-line trail lands in the transcript so the answers are in your scrollback',
        ],
      },
      {
        name: 'Z.ai models as a config file',
        items: [
          'the built-in provider\u2019s model catalog moved from hardcoded arrays to packages/core/src/data/zai-models.json — data, not code',
          'override or extend it without touching the binary: ~/.tagent/zai-models.json (global) or <workspace>/.tagent/zai-models.json (per project)',
          'same-id entries replace the built-ins in place, new ids append, "replace": true swaps the whole list — a new model is one JSON edit away, no release wait',
          'per-model "vision" flag now works end-to-end: the Z.ai adapter maps image parts to the SDK\u2019s content blocks, so GLM-4.7/4.6/4.5V actually receive the screenshots in test mode (the seed flags say the truth now)',
          'the model id is passed through to the SDK on every call — harmless where the endpoint ignores it, forward-compatible when it starts honoring it',
        ],
      },
      {
        name: 'Fixes under the hood',
        items: [
          'gh-release.sh had lost its header (token/version parsing + --no-build) in the 0.15.0 body rewrite — restored',
          'the ask_user tool is allow-listed by default (risk: low) — no permission double-prompt for the privilege of being asked a question',
          'subagents never see the form tool (filtered from their toolset + a runtime guard) — only the primary agent faces the human',
        ],
      },
    ],
  },
  {
    version: '0.15.0',
    date: '2026-09-20',
    title: 'Agent test mode — `tagent test`: the QA agent',
    summary:
      'A third agent mode joins build and plan: TEST. `tagent test` (or `/test` in the TUI, or the Test button in the GUI) turns the agent into a QA engineer for your project — it boots the app itself, clicks through it with a real browser, checks responsiveness and typography, and writes TEST-REPORT.md with a pass/warn/fail verdict. Screenshots are attached to the model\u2019s context when the model can see images, so the agent JUDGES the UI instead of guessing. Also fixes a real bug in the old browser tool (it could never launch a page at all).',
    stable: true,
    sections: [
      {
        name: 'The QA pipeline',
        items: [
          'serve (new tool) — auto-detects the dev command from package.json (dev > start > serve, package manager from the lockfile; a bare index.html falls back to a static server), runs it in the background, waits for the port to answer, and cleans it up when the session ends — restart, status and logs included',
          'browser (rebuilt) — drives real Chromium via Playwright: open pages, click buttons, fill inputs, submit forms; every interaction returns the new page state as an ARIA snapshot plus any console/network errors, so the agent sees WHAT its click did',
          'responsiveness — viewport switching to mobile (390×844), tablet (768×1024) and desktop (1280×800) with screenshots at each size',
          'deterministic UI audit — horizontal overflow (with the offending elements named), typography map with <12px text, skipped heading levels, tap targets <24px on mobile, images without alt, missing viewport meta, WCAG contrast sampling',
          'vision — screenshots ride along in the model\u2019s context when the model accepts image input (GPT-4o/5, Claude, Gemini, GLM-4V, Qwen-VL…); text-only models get the audit data and readable screenshot paths instead',
          'test_report — the one write test mode can do: TEST-REPORT.md at the workspace root (verdict, feature checklist with evidence, reproducible issues, per-viewport findings) plus a timestamped copy under .tagent/test/',
        ],
      },
      {
        name: 'How you use it',
        items: [
          '`tagent test` boots the TUI straight into QA mode; the agent serves the project and tests everything it can reach',
          '`tagent test --url http://localhost:3000` (or `/test http://localhost:3000`) verifies an already-running app — no serve step',
          'one-time setup per project: `bun add playwright && bunx playwright install chromium` (the tool says exactly this when it\u2019s missing)',
          'test mode is read-only for source files — it verifies and reports; switch to build mode to fix what it found, the report is written for that hand-off',
        ],
      },
      {
        name: 'Fixes under the hood',
        items: [
          'the old browser tool stored its page handle as a never-awaited promise — `page.goto` was literally undefined; the state is now awaited once and every action works (found by actually running it)',
          'multi-image context discipline: max 4 screenshots on the 2 newest tool-result messages, base64 read at request time (sessions store only paths), oversized images degrade to text references',
          'Z.ai adapter retries 429 rate-limits with backoff (8s, 16s) instead of dying mid-run',
          'fallback chain strips image parts per-adapter, so failover to a text-only model survives',
          'browser tool default flips to ON (it was dead weight before — now the error message IS the install instruction; risk high + permission ask still gate every action)',
        ],
      },
    ],
  },
  {
    version: '0.14.0',
    date: '2026-09-20',
    title: 'TUI rebuilt Claude Code-style, web-connect login, multi-device sync',
    summary:
      'The TUI is rebuilt on the Claude Code / opencode model: an INLINE app — no alternate screen — so the transcript lives in your terminal\u2019s own scrollback and scrolling works everywhere (mouse wheel, touch on a phone, shift+pgup, tmux copy mode). A small sticky region redraws at the bottom: live stream tail, status, the rounded editor box, and a hint row with model · tokens · ⎇ repo. Plus: `tagent auth` gets web connect (login in the browser, nothing typed in the terminal), and `tagent sync` becomes multi-device safe (fetch + rebase before push). The Go native edition is retired — the main binaries are the only build now.',
    stable: true,
    sections: [
      {
        name: 'The new TUI',
        items: [
          'INLINE rendering (Claude Code\u2019s model, Ink-style): completed lines flow into the terminal scrollback and are never redrawn — native scrolling works on every device, including Termux/UserLAnd where there is no PageUp',
          'the old full-screen alt-buffer app is gone: it killed native scrollback, which is exactly why scrolling broke — the docs of Claude Code\u2019s own fullscreen experiment say the same',
          'a small sticky region redraws in place at the bottom: live message tail while streaming → status row (spinner · elapsed · esc to interrupt) → rounded editor box → hint row (? shortcuts · / commands · @ files + model · tokens · ⎇ repo)',
          'Claude Code visual language: ✻ banner, bold ❯ user echo, ● assistant bullets, ⎿ tree connectors for tool lines and results',
          'streaming stays in the sticky region while the message arrives; the final markdown render is flushed into the scrollback exactly once — no raw-stream flicker, no duplicated lines',
          '`?` on an empty editor opens the shortcuts overlay (Claude Code parity); ↑/↓ walk the input history; esc still interrupts / clears; ctrl+x menu unchanged',
          'fixed a real history bug: ↑ recalled the same entry forever because setText reset the cursor — history navigation now walks properly',
        ],
      },
      {
        name: 'Web connect',
        items: [
          '`tagent auth` in a terminal shows a picker — Web connect (recommended) or paste the PAT right there; `tagent auth --web` goes straight to the browser flow',
          'the flow: a tiny HTTP server binds 127.0.0.1, the browser opens on a one-time secret URL, you create a token (repo scope pre-selected via the link) and paste it on the page — the CLI validates it against the GitHub API and prints the login',
          'no typing in the terminal at all; nothing is sent anywhere except the GitHub API itself, and the server dies right after the login',
          'headless boxes / UserLAnd / Termux: no opener? the URL is printed — on UserLAnd the phone browser reaches it (proot shares 127.0.0.1 with Android)',
        ],
      },
      {
        name: 'Multi-device sync',
        items: [
          'editing a project from several devices converges: `tagent sync` fetches and rebases the remote\u2019s main BEFORE pushing, so the second device\u2019s sync no longer dies with a raw git "fetch first" rejection',
          'edits to different files — or different regions of the same file — merge automatically, and the history stays linear (rebase, no merge commits)',
          'both devices change the same lines? the sync stops with a clear "nothing was lost" error, leaves the repo clean, and names the exact recovery: `git pull --rebase`, resolve, `tagent sync` again',
          'a sync with no local changes doubles as a pull — the other device\u2019s new files simply appear',
          'two devices pushing at the same moment: the push that loses the race re-integrates the winner and retries instead of failing',
        ],
      },
      {
        name: 'Native edition retired',
        items: [
          'the Go port (tagent-native-*) is removed: the release ships the six Bun-compiled binaries only, so there is one engine, one feature set and one set of release notes',
          'it had fallen behind the main CLI (no MCP, plugins, relay, subagents or web GUI) and the same machines can run the full binary\u2019s Linux static sibling or the source install',
          'the repo loses native/ (~4.5k lines of Go) and the Go 1.21 toolchain pin — everything builds from the single TypeScript codebase',
        ],
      },
      {
        name: 'Security shape',
        items: [
          'loopback-only bind (never 0.0.0.0), random port, one-time 128-bit secret in the URL path — a drive-by page on some website can\u2019t hit an endpoint it can\u2019t name',
          'Origin/Referer checked on submit (same host only); the page is served no-store; the endpoint is one-shot and refuses everything after a successful login',
          'the token lands in ~/.tagent/credentials.json exactly like the paste flow (chmod 600, never in config.json or your repos)',
        ],
      },
      {
        name: 'Under the hood',
        items: [
          'packages/cli/src/tui-app.ts render core rewritten: cursor-up + erase-to-end sticky rewrite, wrap-once-at-flush transcript lines, stream tail riding the sticky region — 29 unit tests + 11 PTY checks re-verified',
          'packages/cli/src/web-auth.ts — a UI-free module (injectable validator) so the whole flow is testable hermetically over real HTTP: routing, CSRF gates, retry, one-shot teardown, timeout',
          'fixed a latent bug from 0.13.x: every sync cycled `git remote remove/add origin`, which silently deleted the clone\u2019s upstream tracking — `git pull` stopped working in any project that had synced once',
          '29 hermetic multi-device tests in scripts/test-sync-conflict.ts — divergent devices, region merges, conflicts + the full manual-recovery path, a simulated simultaneous push (pre-push hook racing the sync), and token hygiene (FETCH_HEAD scrubbed, token never on disk)',
          '19 hermetic tests in scripts/test-web-auth.ts + the auth/sync RPC suites re-run green',
        ],
      },
    ],
  },
  {
    version: '0.13.1',
    date: '2026-09-20',
    title: 'Updater honesty fix — source installs update the checkout that runs',
    summary:
      '`tagent update` on a source install now updates the checkout that actually provides the running code (resolved through wrappers and symlinks), verifies the new version afterwards, warns when PATH resolves tagent elsewhere, and uses the hoisted linker on UserLAnd/proot. Before this fix, running the update from any other directory could pull the wrong repo and still print "source updated".',
    stable: true,
    sections: [
      {
        name: 'Fixes',
        items: [
          'source installs: the updater walks up from the running entry file (through symlinks — bun link, ~/.local/bin wrappers) to the tagent checkout and pulls THAT, never whatever repo happens to be the current directory',
          'after pulling, the new version is read back and printed — a branch that lags main or a stale second install can no longer fake a successful update',
          'when `which tagent` points somewhere else than the updated checkout, a warning names both paths',
          'UserLAnd / proot: `bun install --linker=hoisted` is used during updates (socket.io fails to load without it)',
          'not near a tagent checkout? the updater says so and prints the manual fix instead of touching the repo you are standing in',
        ],
      },
    ],
  },
  {
    version: '0.13.0',
    date: '2026-09-20',
    title: 'GitHub login & project sync, markdown in the terminal, TUI polish',
    summary:
      'Log in with GitHub — guests keep working locally, nothing requires an account — and tagent offers to sync the current project to a private repo; tagent clone continues it on any device. Assistant replies now render real markdown in the TUI: headings, code blocks, lists, tables. Plus a persistent stats bar under the input, ESC to stop a running agent, and arrow-key transcript scrolling.',
    stable: true,
    sections: [
      {
        name: 'GitHub login & project sync',
        items: [
          'tagent auth logs you in — PAT walkthrough by default, --device for the GitHub device flow, or pipe the token when non-interactive; the token lands in ~/.tagent/credentials.json (chmod 600), never in config.json',
          'Guest-first: every feature stays local without an account. After login, tagent asks once per project — "sync this workspace to GitHub?" with Sync now / Later / Not this project (answers are remembered)',
          'tagent sync [message] snapshots the workspace (commit + push) into a private repo; the token is used one-shot and never written into .git/config',
          'tagent projects lists linked projects — name, repo, last sync, ▸ marks the current one; tagent clone <owner/name|name> restores any of them on this machine and prints the next steps',
          'tagent whoami reports guest/login status; tagent logout removes only the local token — the GitHub side is never touched',
          '/push inside the TUI goes through the same sync engine — the project registry stays truthful no matter which surface you push from',
          'Web GUI: matching login and sync dialogs wired to new daemon RPC events (auth:*, sync:*, projects:*) — any client can drive the same flow',
        ],
      },
      {
        name: 'Markdown in the TUI',
        items: [
          'Assistant replies render real markdown in the terminal — bold colored headings, **bold**, *italic*, `inline code`',
          'Fenced code blocks draw a dim left rail with a language label; nested lists indent; > quotes and --- rules render',
          'Pipe tables render best-effort and links degrade to "text (url)" — all width-aware, double-width CJK glyphs included',
        ],
      },
      {
        name: 'TUI polish',
        items: [
          'Persistent stats bar under the chat input: model · mode · tokens · time · workspace — always visible while you type; a dim ⎇ owner/repo badge appears once the project is synced',
          'ESC stops a running agent — model calls and bash tools cancel mid-flight, the conversation stays usable',
          'Arrow keys scroll the transcript without touching input history (while scrolled up, ↑/↓ move one line; pgup/pgdn a page as before)',
        ],
      },
      {
        name: 'Under the hood',
        items: [
          'Core sync engine: project registry (~/.tagent/projects.json), link/refuse state, guest→login flow, restore/clone — 57 offline hermetic tests',
          'CLI update flow hardened: the source-install updater now verifies the git remote before ever running git pull',
          'GUI state slice for auth & sync (guest · login · linkedRepo · lastSyncAt) with login/sync/projects methods',
          'Website: responsive & tidy audit pass — mobile hamburger nav, scrollable download tables, focus rings, refreshed docs',
        ],
      },
    ],
  },
  {
    version: '0.12.0',
    date: '2026-09-20',
    title: 'The TUI polish pass — palette Enter works, custom providers in-terminal, cleaner borders',
    summary:
      'The app TUI gets the fixes that matter: pressing Enter on a highlighted slash command now RUNS it (the palette used to silently submit the raw "/" you typed), every box gained proper side rails, the slash palette and @file completion render in real framed boxes, and typing a search that finds nothing now points you at the custom-provider wizard instead of a dead end. New: /model custom adds any OpenAI-compatible, Anthropic or Google endpoint right from the terminal — ollama, lm studio, openrouter, self-hosted gateways.',
    stable: true,
    sections: [
      {
        name: 'Fixed — the things that were in the way',
        items: [
          'Slash palette Enter: selecting a command with the arrow keys and hitting Enter now runs the highlighted command and keeps any arguments you already typed (/mo zzz + ↓ + enter → /model zzz). Previously the selection was never applied and Enter submitted the raw "/" — the palette "did nothing"',
          'Palette cursor resets to the top when you keep typing after moving through the list',
          "Typing 'q' no longer instantly closes a searchable picker — it is a search letter like any other (quick-quit stays for non-searchable menus)",
          'Editor box borders: content rows now carry the left/right │ rails that match the top and bottom rules — no more open-sided box',
          'The slash palette and @file completion render inside proper framed boxes with title and footer rules, aligned columns and a scroll indicator',
        ],
      },
      {
        name: 'Custom providers — /model custom',
        items: [
          'Interactive wizard: label, base url, api kind (OpenAI-compatible · Anthropic · Google), optional api key, model ids — saved and selected in one pass',
          'The provider picker leads with "+ add custom provider…" and the model picker ends with "+ custom model id…" for endpoints whose list is missing or wrong',
          'Both CTAs stay pinned while you search, and an empty search shows "no matches for \\"xyz\\" — nothing built in matches, a custom one probably will" with the CTA one enter away',
          'Custom model ids are remembered per custom provider, so the picker learns them',
          'Same wizard in the classic readline TUI (tagent start --classic), including the keep-pinned CTAs and the no-matches state',
        ],
      },
      {
        name: 'Also in this release',
        items: [
          '31 automated app-TUI tests (up from 22) covering palette Enter behavior, border rails, pinned CTAs, empty-search states and the full custom-provider wizard',
          'Pre-existing test marker bug fixed in the select PTY harness (expected Python-style True for a JS boolean)',
        ],
      },
    ],
  },
  {
    version: '0.11.0',
    date: '2026-09-20',
    title: 'tagent-native gets the app TUI — the Windows 7 build stops looking like 1995',
    summary:
      'The native Go build for Windows 7/8/32-bit machines now opens the same opencode-style full-screen app as the main CLI: header bar, boxed editor with a real cursor, transcript scrollback, ctrl+x menu, slash palette, colors via the Windows Console API (no ANSI needed — genuine conhost-safe), esc-to-interrupt and multi-turn conversations with token counting. The main CLI is unchanged underneath this release.',
    stable: true,
    sections: [
      {
        name: 'Native app TUI (tagent-native)',
        items: [
          'Full-screen takeover painted through the classic Windows Console API — SetConsoleTextAttribute + WriteConsoleW + ReadConsoleInputW — so it works on a genuine Windows 7 conhost that has no ANSI support at all',
          'Same layout language as the main CLI: header (workspace · NATIVE chip · model · chain), scrollable transcript, status row with spinner, boxed multi-line editor with reverse-video cursor, shortcut footer',
          'ctrl+x menu and a / command palette: switch model (saved straight into ~/.tagent/config.json), view the fallback chain, diagnostics, clear, help, exit',
          'esc interrupts the running task through Go context cancellation — HTTP calls and bash commands stop, and the conversation stays usable',
          'Multi-turn conversations (context kept between tasks), token usage in the header, up/down history recall, pgup/pgdn scrollback with a new-lines indicator',
          'CJK-aware word wrapping, terminal resize support, and automatic fallback to a plain line-mode REPL when stdin/stdout is not a terminal',
          'Win7-safe glyph set: square box corners and an ASCII spinner — no braille or rounded corners that Lucida Console cannot render',
        ],
      },
      {
        name: 'Also in this release',
        items: [
          'tagent-native diag subcommand for quick terminal-free checks',
          'Zero new dependencies: still a single static ~10–15 MB binary, Go stdlib only',
        ],
      },
    ],
  },
  {
    version: '0.10.0',
    date: '2026-09-19',
    title: 'The app TUI — full-screen, shortcut-driven, opencode-style — plus tagent uninstall',
    summary:
      'tagent start now opens a real full-screen terminal application: alternate screen, boxed input editor, scrollable transcript, slash-command palette with tab completion, @file mentions, and a ctrl+x quick-action menu so you rarely type. Falls back to the classic readline TUI on tiny terminals or with --classic. tagent uninstall removes everything — command, ~/.tagent data, the repo and/or the binary — each behind its own confirmation.',
    stable: true,
    sections: [
      {
        name: 'App TUI — a terminal application, not a scrolling log',
        items: [
          'Full-screen takeover (alternate screen buffer): header bar with workspace · mode chip · model · session, boxed input editor, status ticker, and a shortcut footer',
          'ctrl+x quick-action menu: Continue, Explain last change, Run diagnostics, Summarize session, switch mode, new session, pick model, undo checkpoint, skills/subagents/fallback/MCP/plugins — arrow keys over typing',
          'Slash-command palette: type / to browse every command with descriptions, filter as you type, tab to complete',
          '@file mentions: type @ to list workspace files, tab to insert — the file rides along into the next message',
          'Input editor with cursor movement, history (↑/↓), alt+enter newline, ctrl+u/ctrl+w line editing',
          'Permission prompts and plan approvals render as bordered overlays (arrow keys + enter); tool calls render as compact one-line cards with status and duration',
          'Scrollable transcript: pgup/pgdn with a new-lines indicator; word-wrapping (CJK-aware) survives terminal resize',
          'Ctrl+C interrupts a run; pressed twice it exits cleanly and always restores your terminal — even on crashes',
          'Non-TTY pipes and terminals under 12 rows fall back to the classic readline TUI automatically; --classic forces it',
        ],
      },
      {
        name: 'tagent uninstall — remove everything, to the roots',
        items: [
          'Enumerates what it found first: the tagent command, ~/.tagent (config, credentials, caches), the bun link registration, the source repo, the downloaded binary',
          'One arrow-key confirmation for the data; the repo and the binary each ask separately (even with --yes) — they may contain your work',
          'Reports per-workspace .tagent/ folders it deliberately does NOT touch, with a find one-liner to locate them',
        ],
      },
      {
        name: 'Fixes',
        items: [
          'Source installs under proot/UserLAnd: bun --linker=hoisted + post-install verification with automatic self-healing retry (the “Cannot find package socket.io” trap)',
          'Scripts and bin/tagent are committed with their executable bit — git pull no longer breaks the command with “Permission denied”',
        ],
      },
    ],
  },
  {
    version: '0.9.0',
    date: '2026-09-19',
    title: 'Plan mode interviews + PRD flow, provider fallback chain, custom subagents, auto-diagnostics, Windows 7/32-bit native port',
    summary:
      'Plan mode now interviews you until requirements are detailed, then approval writes PRD.md and auto-switches to build. Stack a multi-key provider fallback chain (same provider, different keys — ordered). Custom subagents as .tagent/agents/*.md. Auto-diagnostics feeds lint/tsc errors back to the agent. tagent-native: a Go port for Windows 7+ including 32-bit machines — the download page now auto-offers it to 32-bit/Windows-7 visitors. The web GUI renames and organizes sessions.',
    stable: true,
    sections: [
      {
        name: 'Plan mode — interview → plan → PRD → build',
        items: [
          'The plan agent INTERVIEWS you: it asks focused questions when requirements are ambiguous instead of guessing — asking is the job',
          'A delivered plan triggers an arrow-key approval prompt (TUI) / dialog (web GUI)',
          'Approve = writes PRD.md, switches the session to build mode, and starts implementing automatically',
          'Build mode checks for PRD.md on the first task: missing → the agent asks "continue without a PRD, or switch to plan mode first?"',
          'Build agent is instructed to read PRD.md first and implement it faithfully',
        ],
      },
      {
        name: 'Provider fallback — ordered multi-key failover',
        items: [
          'Configure an ordered chain: 1. openrouter (key A, model X) · 2. openrouter (key B, model X) · 3. openrouter (key C, model Y) · 4. groq (key A) …',
          'A per-entry apiKey overrides the stored key — stack the SAME provider under many accounts freely',
          'Provider errors (network, 401/429/5xx) fail over mid-conversation, transparently, with a notice',
          'Manage in the web GUI Settings (reorder ↑/↓) or /fallback add|rm|clear in the TUI',
        ],
      },
      {
        name: 'Custom subagents — .tagent/agents/*.md',
        items: [
          'Define specialists with persona, tool whitelist, model override (provider/model), plan/build mode, and turn budget — front-matter + markdown body',
          'Spawn via the task tool: {"agent": "code-reviewer"} — workspace agents override global (~/.tagent/agents) by name',
          '/agents lists them, /agents new <name> scaffolds one from the template',
        ],
      },
      {
        name: 'Auto-diagnostics — the quality gate',
        items: [
          'Arm it with /diag "tsc --noEmit" (or npm run lint) — it runs once per turn where files were edited',
          'Failures are fed back to the model with a fix-before-finishing instruction — a self-correcting loop',
          '/diag test runs it on demand; runs in the background — tool output never renders as user chat',
        ],
      },
      {
        name: 'Web GUI — session management',
        items: [
          'Rename any session from the sidebar — the new title follows it everywhere: TUI /open, HTML exports, relay viewers',
          'Organize your history without leaving the browser — name sessions by what they actually do instead of "new session" archaeology',
          'One session store, many surfaces: the GUI, the TUI and the CLI all see renames immediately',
        ],
      },
      {
        name: 'Windows 7+ / 32-bit native port — tagent-native',
        items: [
          'Single static Go 1.21 binary (the last toolchain supporting Win7/8): windows-386 PE32, windows-amd64, linux amd64/arm64',
          'OpenAI-compatible function calling, workspace-jailed read/write/edit/list/bash tools, interactive REPL + one-shot run',
          'Same ~/.tagent/config.json — including the fallback chain; per-entry keys stack identically',
          'TAGENT_TLS_SKIP=1 escape hatch for networks with broken TLS interception',
        ],
      },
      {
        name: 'Fixes',
        items: [
          'Web GUI: double user message after send (optimistic id vs server id) — replaced in place, not duplicated',
          'Web GUI: internal TOOL RESULTS blobs no longer render as user chat bubbles (live + reload + hello paths)',
          'Web GUI: chat:send no longer times out at 30s for long runs; failures surface instead of hanging',
          'Server: session-scoped events were stamped with whatever session was loaded at emit time — now pinned to the run\u2019s session',
          'ddg_search/web_fetch: certificate verification errors now auto-retry with relaxed TLS once, with a clear hint if the network is the problem',
        ],
      },
    ],
  },

  {
    version: '0.8.0',
    date: '2026-09-19',
    title: 'Smart cache + token economist, MCP, plugins, interactive TUI, self-update',
    summary:
      'The token economist arrives: unchanged-file re-reads return a stub, read_files batches known paths into one turn, "read X" subagents are fast-pathed, and @path mentions attach files inline. Plus: MCP servers, plugins with tools & commands, opencode-style arrow-key menus, and self-update on startup.',
    stable: true,
    sections: [
      {
        name: 'Smart cache — the token economist',
        items: [
          'File-state cache: re-reading an UNCHANGED file returns a tiny "already in your context" stub instead of resending the whole file — writes/edits invalidate instantly, stamps persist per workspace in .tagent/file-state.json',
          'read_files: batch up to 12 known paths in ONE call — the default way to read, not the exception',
          'task fast-path: a subagent asked to just "read src/a.ts" serves the file directly — the whole subagent turn budget is never spent',
          '@path mentions: type @src/app/page.tsx in chat and the file rides along inline — zero tool turns, and the agent is told not to re-read it',
          'Context diet: old tool results auto-compact to stubs past 150k chars (newest 4 stay full), so long sessions stay cheap',
          'Web TTL cache (10 min default): repeated web_fetch / ddg_search calls skip the network entirely',
          'Anthropic prompt caching on by default (system block cache_control) — the big static prefix bills at ~10%; OpenAI/Gemini cached-token accounting included',
          'Live token usage: in/out (+ cache-hit) tokens per turn on the TUI ticker and done-line, in every LoopSummary',
          'tagent cache shows file-state, discovered models and credentials at a glance; tagent cache clear wipes them (--all resets everything)',
          'GUI: Settings → Agent gained a Smart cache card with both toggles; system prompt got hard Economy rules so the model itself spends turns like a miser',
        ],
      },
      {
        name: 'Credentials store',
        items: [
          'Secrets now live in ~/.tagent/credentials.json — chmod 600, separate from the shareable config.json',
          'Resolution order everywhere: credentials.json → config.json → environment variable',
          'tagent cache lists stored secrets masked (ghp_AB••••YZ) — values never print',
        ],
      },
      {
        name: 'MCP — Model Context Protocol',
        items: [
          'Connect any stdio MCP server (npx/uvx/binary): Context7, filesystem, memory, sequential-thinking or your own — tools appear to the agent as mcp_<server>_<tool>',
          'Full JSON-RPC handshake over stdio with per-server isolation — one broken server never blocks the rest',
          'Every MCP tool goes through the same permission gates: /allow mcp_<server>, mcp catch-all, or per-tool rules',
          'TUI: /mcp opens an interactive manager — status, one-click templates, custom servers, enable/disable, remove',
          'GUI: Settings → MCP — the same templates plus a custom-server form, live connection state and tool counts',
          'tagent doctor now starts every configured MCP server and reports per-server health',
        ],
      },
      {
        name: 'Plugins v2 — tools, commands, hooks',
        items: [
          'Plugins export tools: agent-callable functions named plugin_<plugin>_<tool> with full schemas, risk levels and permission rules',
          'Plugins export commands: custom slash commands (/hello-world …) that run with workspace context',
          'Hooks keep working (onSessionStart, onUserMessage, onToolCall, onToolResult, onAgentDone) — all optional, all isolated',
          'Plugins hot-reload every turn — edit the .mjs file and just keep working',
          'TUI: /plugins manager + scaffold; GUI: Settings → Plugins with one-click scaffolding into .tagent/plugins/',
        ],
      },
      {
        name: 'Interactive TUI — arrow keys everywhere',
        items: [
          '/model with no argument opens the picker: provider list (key status, type-to-filter) → model list — locked providers offer to add a key on the spot',
          'Permissions are now an arrow-key menu: allow once · always · this session · deny',
          '/new and /mode pick build/plan interactively; /open without an id browses sessions with fuzzy filter',
          '/apikey browses key-needing providers; the GitHub login wizard is a menu too',
          'Ctrl+C inside a menu cancels it — never exits the app',
        ],
      },
      {
        name: 'Self-update',
        items: [
          'On startup the TUI checks for a newer release (cached daily) and offers an arrow-key y/N update prompt',
          'tagent update does the same from the shell',
          'Binary installs download the matching release asset and swap it in place (POSIX) or park the new exe next to the old one (Windows)',
          'npm -g / bun -g installs run the global upgrade; source checkouts git pull + bun install',
        ],
      },
      {
        name: 'Website & GUI',
        items: [
          'New logo — the terminal prompt (chevron + blinking cursor) on an orange tile; favicon included',
          'Real vector icons across the website (no unicode-emoji roulette), MCP and plugins feature cards, new TUI/GUI comparison section',
          'Web GUI Settings gained MCP and Plugins tabs; hello payload now reports MCP status and installed plugins',
          'Update notes for the banner highlight: /mcp · /plugins · /update are new',
        ],
      },
    ],
  },
  {
    version: '0.7.0',
    date: '2026-09-19',
    title: 'Single-file binaries: download, run, done — like Node.js/Python',
    summary:
      'Tagent now ships as one self-contained executable per platform — Windows x64/ARM64, Linux x64/ARM64, macOS Intel/Apple silicon. The web GUI is embedded inside the binary. Download it, run it, that is the whole install.',
    stable: true,
    sections: [
      {
        name: 'Single-file binaries',
        items: [
          'Six cross-compiled targets on every release: windows-x64.exe, windows-arm64.exe, linux-x64, linux-arm64, macos-x64, macos-arm64 — plus SHA256SUMS',
          'Like the Node.js/Python downloads: grab the file, run it — no Bun install, no clone, no setup script; the website download page auto-detects your platform',
          'The full web GUI (gui-dist) is embedded in the executable and self-extracts to ~/.tagent/gui-cache/ on first launch — tagent web works out of the box',
        ],
      },
      {
        name: 'Native Windows — no WSL needed',
        items: [
          'The Windows builds run the whole stack natively: TUI, daemon, web GUI, relay, the 40-provider catalog',
          'The bash tool auto-detects Git for Windows bash.exe (override with TAGENT_BASH); tagent doctor probes it and tells you exactly what is missing',
          '~/.tagent now resolves to the real Windows profile via USERPROFILE — config, sessions and model caches land in the right place',
          'Opening the browser uses the cmd start builtin — no more POSIX-only command -v guards on the Windows path',
        ],
      },
      {
        name: 'Under the hood',
        items: [
          'scripts/build-binaries.sh: gui-dist → base64 manifest → bun build --compile per target (playwright stays external — the browser tool degrades gracefully)',
          'scripts/gh-release.sh now builds the binaries, creates the release and uploads every asset with checksums in one shot',
          'A gui-dist folder next to the binary (or in the cwd) still takes precedence over the embedded bundle — power users can swap the GUI without rebuilding',
        ],
      },
    ],
  },
  {
    version: '0.6.0',
    date: '2026-09-18',
    title: 'Providers, opencode-style: 40-provider catalog, custom endpoints, live model discovery',
    summary:
      'Every provider you can think of, one command away — OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, Qwen, Kimi, Zhipu, OpenRouter and ~28 more, plus custom endpoints for anything else. Keys from config or env vars, provider/model refs like groq/llama-3.3-70b-versatile, and live model discovery that fills every picker.',
    stable: true,
    sections: [
      {
        name: 'The catalog',
        items: [
          '40 built-in providers: OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, xAI (Grok), DeepSeek, Mistral, Perplexity, Cohere, AI21, Together, Fireworks, Cerebras, DeepInfra, Nebius, Novita, Hyperbolic, Baseten, Featherless, NVIDIA NIM, Turing, Vercel AI Gateway, Glama, AIHubMix, GitHub Models',
          'APAC: Qwen (DashScope), Moonshot (Kimi), Zhipu (GLM / open.bigmodel.cn), Z.ai API (api.z.ai), SiliconFlow, Volcengine Ark (Doubao), BytePlus ModelArk — Europe: OVHcloud, Scaleway',
          'Local runtimes with zero keys: Ollama, LM Studio, vLLM, llama.cpp — and the built-in Z.ai adapter stays the zero-config default',
          'Keys resolve from config first, then environment variables — export OPENAI_API_KEY=… (or ANTHROPIC_API_KEY, GROQ_API_KEY, …) and it just works',
        ],
      },
      {
        name: 'Live model discovery',
        items: [
          'Refresh hits GET /models on every provider that has a key (OpenAI-compatible, Anthropic and Google wire formats) and caches the result in ~/.tagent/models.json',
          'Discovery filters noise (embeddings, image/audio models) and merges with curated seeds — every picker shows the provider\'s real model list',
          'GUI: "Refresh models" button in provider settings; TUI: /model refresh; CLI: tagent models --refresh — plus a background warm-up when the daemon starts',
        ],
      },
      {
        name: 'provider/model everywhere',
        items: [
          'tagent config set model groq/llama-3.3-70b-versatile sets provider + model in one go; unknown providers are rejected with a pointer to tagent models',
          'tagent models — a browsable catalog (ready vs needs-key, env var hints); tagent doctor now summarizes the catalog instead of spamming 40 lines',
          'TUI /model: fuzzy search across providers and models, provider/model refs, refresh; the model dropdown in the GUI is searchable too',
        ],
      },
      {
        name: 'Custom endpoints',
        items: [
          'Settings → Providers → Add custom: any OpenAI-compatible endpoint (vLLM, llama.cpp, LiteLLM, OneAPI, Azure …/openai/v1), plus Anthropic-compatible and Google-compatible kinds',
          'Custom providers get the same treatment as built-ins: key storage, live discovery, model picking, and safe removal (defaults fall back cleanly)',
          'The GUI provider tab was rebuilt: search across providers and models, Ready/Catalog sections, per-provider env-var hints, and a +N more expander for long model lists',
        ],
      },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-09-18',
    title: 'Relay mode: share a live session over the network',
    summary:
      'Share any session with another person in real time — a read-only viewer page at /relay/<code> that streams messages, tool calls and todos as they happen. tagent relay on the CLI, /relay in the TUI, one click in the GUI.',
    stable: true,
    sections: [
      {
        name: 'Relay mode',
        items: [
          '`tagent relay [sessionId] [path]` — share a session live: prints the viewer URL and serves it until you stop it',
          'The viewer page is a self-contained read-only window: history on open, then live streaming tokens, tool lines, todos and subagent activity as they happen',
          'Unguessable per-session codes, revocable at any time (`tagent relay stop <code>`, `/relay stop` in the TUI, or the sidebar in the GUI) — revoked viewers are disconnected instantly',
          'Over the network: `--host 0.0.0.0` prints LAN URLs for your phone/teammates; without it the relay stays on localhost (pair with an SSH tunnel for remote)',
        ],
      },
      {
        name: 'Everywhere',
        items: [
          'TUI: `/relay` starts sharing the current session (spins up a local endpoint on demand), `/relay list` and `/relay stop <code>` manage it',
          'GUI: the RadioTower button on any session starts a live share; the sidebar lists active relays with watcher counts, copy and end buttons',
          'Relays survive restarts — they persist in `.tagent/relays.json` until revoked',
          'Viewer sockets are read-only by construction: no RPC handlers, no permission requests, session-filtered events only',
        ],
      },
      {
        name: 'Under the hood',
        items: [
          'The websocket now always lives at `/socket` (with or without the GUI bundle) — one canonical endpoint for viewers and clients',
          'Normal clients get broadcasts through a `gui` room; relay viewers get per-session filtered events and never see other sessions or permission prompts',
          'One live relay per session: re-sharing returns the same code, revoking ends it for everyone',
        ],
      },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-09-17',
    title: 'Terminal-first: full TUI, tagent start, share links, timelines',
    summary:
      'The TUI is now the primary interface — a complete terminal UI with every feature the web GUI has. New command surface (tagent start/web/run/auth/config), share links, subagent timelines, worklog + todos, and caveman mode.',
    stable: true,
    sections: [
      {
        name: 'Terminal-first',
        items: [
          'New full TUI (`tagent start`): streaming tokens, tool lines, live todo lists, subagent activity, inline permission prompts — pure stdin/stdout, identical on desktop, SSH and a phone (Termux/UserLAnd)',
          'Zero desktop/mobile feature split: every capability is a slash command in the TUI and a panel in the browser — same engine, same sessions, same permissions',
          'Shared AgentHost architecture: the terminal and any browser tabs attach to the same agent, stay in sync, and can even answer each other\u2019s permission requests',
        ],
      },
      {
        name: 'Commands',
        items: [
          '`tagent start [path]` — the TUI (primary). `--web-gui` also serves the browser GUI on this run',
          '`tagent web [path]` — daemon + web GUI only, for phone/remote use',
          '`tagent run [path] "prompt"` — one-shot agent for scripting (`--json` for structured output)',
          '`tagent auth` — GitHub login wizard (device flow or PAT); `tagent config get/set/list`, `tagent sessions`, `tagent share`, `tagent doctor`, `tagent --check-update`',
          'Web GUI on/off: `tagent config set webGui on` (global) or Settings → Agent in the GUI — `tagent start` stays TUI-only by default',
        ],
      },
      {
        name: 'Worklog + todos',
        items: [
          'The agent plans multi-step work as a live todo list you can watch progress on (GUI sidebar / TUI inline)',
          'After each completed step it appends a timestamped entry to WORKLOG.md — a durable journal a future session reads to pick up where it left off',
          'New Log tab in the GUI panel + `/todos`, `/log` commands in the TUI; toggle in Settings → Agent or `/worklog`',
        ],
      },
      {
        name: 'Caveman mode',
        items: [
          'Token saver inspired by omni-route: ultra-terse replies (telegraphic, max 5-bullet summaries), compact system prompt, one-line tool docs, tighter tool-output budgets',
          'Toggle from the top bar bone icon, `/caveman` in the TUI, or `tagent config set caveman on`',
          'Same tools, same safety — strictly fewer tokens in and out',
        ],
      },
      {
        name: 'Share links',
        items: [
          'Export any session as a standalone read-only HTML file (self-contained, dark theme, collapsible tool calls)',
          'Served by the daemon at /share/<id>.html — share button in the session sidebar, `/share` in the TUI, `tagent share <id>` from the shell',
        ],
      },
      {
        name: 'Multi-agent timelines',
        items: [
          'Subagent runs (task tool) are now persisted as real sessions with parentId metadata — they survive restarts',
          'New Timeline tab in the GUI panel shows every subagent run of the active session, live and historical; `/timeline` in the TUI',
        ],
      },
      {
        name: 'Under the hood',
        items: [
          'AgentHost refactor: one brain shared by TUI and daemon — no duplicated session/permission logic',
          'GitHub device-flow wired end-to-end (CLI wizard + GUI button) using the existing core functions',
          'PermissionManager honors permissions.defaultMode (previously dead config) and requests now carry real risk levels',
          'Session titles auto-derive from the first message',
          'E2E suite extended: caveman round-trip, worklog assertions, host API tests, TUI pipe-mode tests',
        ],
      },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-09-17',
    title: 'Streaming, native tool-calling, workspace switcher',
    summary:
      'Tokens stream live into the chat, providers can call tools natively (with automatic fallback), and you can switch workspaces from the GUI without restarting the daemon.',
    stable: true,
    sections: [
      {
        name: 'Streaming',
        items: [
          'Real token streaming (SSE) for OpenAI-compatible, Anthropic, Gemini and the built-in Z.ai provider — text appears as it is generated',
          'Throttled, idempotent stream events (full-text-so-far) — smooth on phones, no desync on reconnect',
          'The markdown action protocol never leaks raw JSON into the chat while streaming',
        ],
      },
      {
        name: 'Native tool-calling',
        items: [
          'OpenAI, Anthropic, Gemini and custom providers receive real function schemas (12/12 tools documented)',
          'Models can call tools through the native API; permission gates and checkpoints apply exactly as before',
          'Automatic fallback: endpoints that reject tools (older Ollama models, proxies) silently revert to the markdown protocol',
          'Config flag: nativeTools (default on) — the markdown protocol always remains available',
        ],
      },
      {
        name: 'Workspace switcher',
        items: [
          'New dropdown in the top bar: current workspace, recent list, and “Open folder…” by path',
          'Switching rebinds the daemon live — sessions, files, memory and skills reload without a restart',
          'Recent workspaces are remembered globally (~/.tagent/workspaces.json, capped at 12)',
        ],
      },
      {
        name: 'MEGA cloud sync',
        items: [
          'Settings → Integrations: enable MEGA, set email + password, then “Sync memory ↑” / “Restore ↓”',
          'End-to-end encrypted backup of AGENTS.md drafts + memory facts across devices (needs bun add megajs)',
        ],
      },
      {
        name: 'Under the hood',
        items: [
          'E2E test suite: real-LLM chat through the daemon (scripts/e2e-chat.ts) and workspace-switch RPC tests',
          'Removed a leftover scaffold API route that broke static export builds',
        ],
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-09-17',
    title: 'Phone support, open source, update checker',
    summary:
      'Runs on Android via UserLAnd (no root), the daemon serves the GUI itself, and Tagent now warns when a newer release exists.',
    stable: true,
    sections: [
      {
        name: 'Mobile (UserLAnd on Android)',
        items: [
          'New phone-first layout: bottom tab bar with Chat / Files / Terminal / Memory / Skills',
          'File editor with back navigation; the same panels as desktop — full parity',
          'scripts/setup-ubuntu.sh detects phones (proot/Android) and adapts: skips heavy Chromium, prints mobile hints',
          'docs/USERLAND.md — complete no-root guide: Play Store → Ubuntu → localhost:4020 in Chrome',
          'Battery / background / RAM tips + troubleshooting table',
        ],
      },
      {
        name: 'Desktop / daemon',
        items: [
          'One process does it all: the daemon now serves the pre-built web GUI (gui-dist/) as a static SPA with the websocket at /socket',
          'CLI flags: --host (default 127.0.0.1, 0.0.0.0 for LAN), --port, --no-open, --gui <dir>',
          'Update checker: checks at most once a day, warns on outdated, never blocks — TAGENT_UPDATE_URL to override the endpoint',
          'New fast paths: tagent --version, tagent --check-update',
          'xdg-open failures no longer spam headless boxes',
        ],
      },
      {
        name: 'Community',
        items: [
          'Repository is public (MIT): CONTRIBUTING.md (dev loop, conventions), SECURITY.md (threat model, private reporting)',
          'Website launched: docs, install guides, releases/changelog, downloads per platform',
        ],
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-09-16',
    title: 'First public cut — the engine, GUI, and the loop',
    summary:
      'Agent loop with action protocol, permissions, checkpoints, subagents, skills, memory, plugins, multi-provider BYOK, GitHub push, and the web GUI.',
    sections: [
      {
        name: 'Engine (packages/core)',
        items: [
          'Agentic loop: prompt → model → tool actions → results → repeat, with max-turns, interrupt & steer',
          'Tools: read_file, list_files, grep, write_file, edit_file, bash (blocklist-guarded), web_fetch, ddg_search, task (subagents), todowrite, memory, load_skill, browser (optional Playwright)',
          'Permission manager: per-tool ask/allow/deny with once/session/always',
          'Auto checkpoints before writes + one-click undo',
          'Memory: AGENTS.md (global + workspace) + durable facts injected into every prompt',
          'Skills: SKILL.md playbooks with progressive disclosure',
          'Providers: Z.ai, OpenAI, Anthropic, Google, OpenRouter, Groq, Ollama + any OpenAI-compatible endpoint (BYOK)',
          'GitHub: PAT/device-flow auth, private repo bootstrap, workspace push',
          'Storage adapters: local + experimental MEGA.nz (E2E-encrypted)',
          'Plugin API v1: custom tools, slash commands, lifecycle hooks',
        ],
      },
      {
        name: 'GUI (web)',
        items: [
          'Chat with streaming tool cards and permission dialogs',
          'File tree + editor, diff view, in-browser terminal',
          'Sessions sidebar, model picker, settings, command palette (⌘K)',
          'Demo workspace with planted bugs to try the agent on',
        ],
      },
    ],
  },
]
