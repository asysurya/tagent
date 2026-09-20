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
export const LATEST = '0.14.0'

export const RELEASES: Release[] = [
  {
    version: '0.14.0',
    date: '2026-09-20',
    title: 'GitHub login via web connect — the browser, not the terminal',
    summary:
      '`tagent auth` in a terminal now offers web connect: a one-time page opens in your browser (loopback only, one-time secret URL), you create a GitHub token with the repo scope pre-selected and paste it there — the terminal handles the rest. Works on UserLAnd/Termux too, where the printed URL opens in the phone\u2019s own browser. The paste and device flows stay; scripted pipes are unchanged.',
    stable: true,
    sections: [
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
          'packages/cli/src/web-auth.ts — a UI-free module (injectable validator) so the whole flow is testable hermetically over real HTTP: routing, CSRF gates, retry, one-shot teardown, timeout',
          '19 hermetic tests in scripts/test-web-auth.ts + the auth/sync RPC suites re-run green',
          'teardown choreography: close() stops new connections at once; lingering keep-alives are swept 2s later so a parked browser socket can never hold the CLI process hostage',
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
