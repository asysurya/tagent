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

export const LATEST = '0.2.0'

export const RELEASES: Release[] = [
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
