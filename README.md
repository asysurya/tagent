<div align="center">

# ⚡ Tagent

**Terminal-native coding agent — the TUI is the interface, the web GUI is the companion.**

Loop · Subagents · Skills · Memory · Permissions · Checkpoints · Plugins · Multi-provider BYOK · GitHub & MEGA sync

</div>

---

Tagent is an open agent platform: a real coding agent engine that runs on **your
machine**, driven primarily from the **terminal** (a full TUI — every feature,
on desktop and on a phone), with an optional **web GUI** served by the same
process when you want a browser. Same engine, same sessions, same permissions.

> 🌐 **Website (docs · install · releases · downloads):** the `website/` workspace in this
> repo deploys to Vercel (root directory = `website`).
>
> 🔄 **Update-aware:** the CLI checks for newer releases at most once a day and prints a
> warning when stale — it never blocks. `tagent version` · `tagent --check-update`

```
┌─ TUI (primary — stdin/stdout) ──┐   ┌─ Web GUI (companion) ────────┐
│  chat · tools · todos · perms   │   │  chat · files · editor ·     │
│  sessions · share · auth ·      │◀──┤  timeline · memory · skills  │
│  settings — full parity         │   │  (tagent start --web-gui or  │
└─────────────┬───────────────────┘   │   tagent web, phone-ready)   │
              │ direct calls           └──────────────┬───────────────┘
┌─ AgentHost (shared brain) ──▼───────────────────────▼─────────────┐
│  agent loop · tools · subagents · sessions · checkpoints ·         │
│  permissions · plugins · storage adapters                         │
└────────────────────────────────────────────────────────────────────┘
```

## Features

| | |
|---|---|
| 🔁 **Agentic loop** | Prompt → model → tool actions → results → repeat, with max-turns, interrupt & steer |
| 🤖 **Subagents** | `task` tool spawns isolated agents (read-only `explore` or `general`) with their own budget |
| 🔐 **Permissions** | Per-tool ask/allow/deny, remember once/session/always — every write asks first |
| 💾 **Checkpoints** | Auto-snapshot before writes; one-click `/undo` |
| 🧠 **Memory** | `AGENTS.md` (global + workspace) + durable facts, injected into every system prompt |
| 📚 **Skills** | `SKILL.md` playbooks with progressive disclosure (name+description in prompt, full body on demand) |
| 🔌 **Multi-provider** | Z.ai built-in, OpenAI, Anthropic, Google, OpenRouter, Groq, Ollama + any OpenAI-compatible endpoint (BYOK) |
| 🧩 **Plugins** | Hook into session start, tool calls, results, agent done |
| 🌐 **Web tools** | `web_fetch`, `ddg_search` (no API key), `browser` (Playwright-based e2e signal — optional) |
| 🗄️ **Storage adapters** | Local today, MEGA.nz (E2E-encrypted snapshots & memory) implemented as an experimental adapter |
| 🐙 **GitHub** | PAT or device-flow auth (`tagent auth`) → auto private repo + one-click workspace push |
| 📋 **Worklog + todos** | Live todo list + timestamped WORKLOG.md journal the agent keeps as it works |
| 🦴 **Caveman mode** | Omni-route style token saver — terse replies, compact prompts, tighter budgets |
| 🔗 **Share links** | Export any session as a standalone read-only HTML file |
| 🕸️ **Timelines** | Subagent runs persist as sessions — inspect the multi-agent timeline after the fact |
| 🖥️ **Terminal in GUI** | Run shell commands in the workspace, see output |
| 👤 **Guest-first** | Works fully offline & local; accounts are optional |

## Quick start (Ubuntu / Debian / WSL2)

One process total; the setup script puts the real `tagent` command on your PATH.

```bash
# 0. get the repo
git clone https://github.com/asysurya/tagent.git && cd tagent

# 1. one-shot setup: bun + dependencies + the `tagent` command
bash scripts/setup-ubuntu.sh
#   optional extras:  bash scripts/setup-ubuntu.sh --with-browser

# 2. start the TUI on any folder (primary interface)
tagent start ~/my-project

# …want the browser too? one of these:
tagent start --web-gui      # TUI + web GUI in this run
tagent config set webGui on # …or make it the default
```

Manual install of the command (if you skipped the setup script):

```bash
sudo ln -sf "$(pwd)/bin/tagent" /usr/local/bin/tagent   # or ~/.local/bin
```

No `node_modules` surgery, no native compilation, no Next.js toolchain needed at
runtime — the static GUI (`gui-dist/`) is committed so plain `bun install` is
enough. Requirements: Ubuntu 20.04+ (or any Debian-based x64/arm64), `git`, and
`curl`; `sudo` is only used if bun or git are missing.

### Command surface

```bash
tagent                     # same as `tagent start` (TUI)
tagent start [path]        # the TUI — primary interface
           --web-gui       # also serve the browser GUI this run
           --no-web-gui    # skip the GUI even if config enables it
           --port --host --no-open --gui <dir>
tagent web [path]          # daemon + web GUI only (no TUI) — phone/remote
tagent run [path] "msg"    # one-shot run, prints the result (--json too)
tagent auth                # GitHub login wizard (device flow / PAT)
tagent config list|get|set # settings from the shell (-g = global)
tagent sessions [path]     # list a workspace's sessions
tagent share [id] [path]   # export a session as standalone HTML
tagent doctor [path]       # environment sanity check
tagent version · --check-update · help
```

Inside the TUI everything is a slash command — `/help` lists them all (sessions,
model switching, caveman, worklog, share, timeline, permissions, files, grep,
auth, push, checkpoints, memory, skills…). Plain text talks to the agent.

### 📱 Run it on your phone (Android, no root)

Tagent runs on a phone under [UserLAnd Ubuntu](https://userland.tech) — proot,
no root — with **zero feature difference** from desktop: the same TUI in the
phone terminal, and the same mobile-tabbed GUI in the phone browser.

```bash
# inside the UserLAnd Ubuntu session:
sudo apt-get install -y git curl
git clone https://github.com/asysurya/tagent.git && cd tagent
bash scripts/setup-ubuntu.sh   # also links ~/.local/bin/tagent

tagent start ~/my-project           # full TUI, right in the terminal
tagent web ~/my-project --no-open    # …or serve the GUI to your phone browser
```

Then open **http://localhost:4020** in Chrome on the same phone for the GUI, or
keep working in the terminal — your choice, same agent. Full guide:
[docs/USERLAND.md](docs/USERLAND.md).

### Development / sandbox mode

```bash
bun install
bun run build:gui     # rebuild the static GUI → gui-dist/
bun mini-services/tagent-daemon   # daemon on :3001 (sandbox harness)
bun run dev          # Next dev server on :3000 (GUI development)
```

The GUI talks to the daemon over websockets at `/socket` (same origin). In the
sandbox it goes through the gateway (`?XTransformPort=3001`) instead.

## Repository layout

```
packages/core     the engine — loop, tools, providers, permissions,
                  sessions, checkpoints, memory, skills, storage, plugins
packages/cli      the `tagent` bin — AgentHost (shared brain) + the TUI
                  (tui.ts) + the daemon (http + socket.io) serving the GUI
src/              the web GUI (Next.js 16, App Router, client-side)
gui-dist/         committed static export of the GUI (served by the daemon)
mini-services/    sandbox harness that boots the daemon on :3001
builtin-skills/   shipped skills (web-app-builder, code-review, bug-hunter)
demo-workspace/   a tiny vanilla-JS todo app with planted bugs — try the agent on it
scripts/         setup-ubuntu.sh, sync-latest.ts, smoke tests, gh-release.sh
docs/             USERLAND.md — run Tagent on an Android phone (no root)
website/          the docs/release website (Next.js → deploy to Vercel)
```

## The action protocol

Tagent is provider-agnostic: any chat-completion endpoint works. The model acts by
emitting fenced action blocks:

````
```tagent:action
{"tool": "edit_file", "input": {"path": "app.js", "old": "…", "new": "…"}}
```
````

Tool results are fed back as `TOOL RESULTS` on the next turn. A reply without
action blocks ends the run. See `packages/core/src/system-prompt.ts`.

## Tools

`read_file` · `list_files` · `grep` · `write_file` · `edit_file` · `bash` (blocklist-guarded) ·
`web_fetch` · `ddg_search` · `task` (subagents) · `todowrite` · `memory` · `load_skill` · `browser` (optional Playwright)

All file tools are **jailed to the workspace root** — traversal outside is rejected.

## Configuration

Workspace-local `.tagent/config.json` (gitignored) over `~/.tagent/config.json`:

```jsonc
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5",
  "apiKeys": { "openai": "sk-…" },        // BYOK — never committed
  "permissions": { "tools": { "bash": "ask", "write_file": "ask" } },
  "tools": { "bash": true, "browser": false },
  "github": { "token": "ghp_…", "repo": "my-workspace" },
  "maxTurns": 40
}
```

## Roadmap

- [x] Streaming tokens — SSE for OpenAI-compatible, Anthropic, Gemini, Z.ai (v0.3.0)
- [x] Native tool-calling with automatic fallback to the markdown protocol (v0.3.0)
- [x] Workspace switcher in the GUI, no daemon restart (v0.3.0)
- [x] MEGA cloud sync UI — E2E-encrypted memory backup (v0.3.0)
- [x] Full TUI — every GUI feature in the terminal, desktop + phone parity (v0.4.0)
- [x] Worklog + todos — the agent journals its progress (v0.4.0)
- [x] Caveman mode — omni-route style token saver with a toggle (v0.4.0)
- [x] GitHub OAuth device flow — `tagent auth` + GUI button (v0.4.0)
- [x] Share links — standalone HTML session exports (v0.4.0)
- [x] Multi-agent timelines (v0.4.0)
- [ ] Relay mode — share a session with another person over the network

## Releases & versioning

Versioning is semver-ish; every release is a git tag + a GitHub release, and the
changelog lives in [`website/src/data/releases.ts`](website/src/data/releases.ts)
(single source of truth for the site, the CLI update check and the release notes).

```bash
tagent version            # running version
tagent --check-update     # force an update check (exit 2 when outdated)
# endpoint override for self-hosted mirrors:
export TAGENT_UPDATE_URL=https://your-host/latest.json
```

Cutting a release: bump versions → update `releases.ts` → `bun scripts/sync-latest.ts`
→ commit → `git tag vX.Y.Z && git push --tags` → `bash scripts/gh-release.sh <token>`.

## Contributing & license

MIT — see [LICENSE](LICENSE). PRs welcome: [CONTRIBUTING.md](CONTRIBUTING.md)
explains the dev loop and conventions. Found something exploitable?
[SECURITY.md](SECURITY.md) — please report privately, not in public issues.
