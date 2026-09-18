/**
 * Release data — the single source of truth for the website changelog and
 * for website/public/latest.json (which the Tagent CLI update check reads).
 *
 * Keep newest first. After editing, run `bun scripts/sync-latest.ts` to
 * regenerate public/latest.json, and tag the repo: `git tag vX.Y.Z`.
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
}

export const LATEST = '0.6.0'

export const RELEASES: Release[] = [
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
