<div align="center">

# ⚡ Tagent

**Terminal-native coding agent with a web GUI.**

Loop · Subagents · Skills · Memory · Permissions · Checkpoints · Plugins · Multi-provider BYOK · GitHub & MEGA sync

</div>

---

Tagent is an open agent platform in the spirit of [opencode](https://opencode.ai): a real
coding agent engine that runs on **your machine** via a CLI daemon, controlled from a
beautiful **web interface** in the browser — the best of both worlds.

```
┌─ Browser GUI (Next.js) ─────────────────┐
│  chat · tool cards · permissions ·      │
│  files & editor · terminal · memory ·   │
│  skills · model picker (BYOK)           │
└─────────────┬───────────────────────────┘
              │ websocket
┌─ CLI daemon (Node/Bun) ─▼────────────────┐
│  agent loop · tools · subagents          │
│  sessions · checkpoints · permissions    │
│  plugins · storage adapters              │
└──────────────────────────────────────────┘
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
| 🐙 **GitHub** | PAT or device-flow auth → auto private repo + one-click workspace push |
| 🖥️ **Terminal in GUI** | Run shell commands in the workspace, see output |
| 👤 **Guest-first** | Works fully offline & local; accounts are optional |

## Quick start (Ubuntu / Debian / WSL2)

The daemon is self-contained: it serves the built web GUI itself, so there is
no separate frontend process to run.

```bash
# 0. get the repo
git clone https://github.com/asysurya/tagent.git && cd tagent

# 1. one-shot setup: bun + dependencies (GUI bundle ships in the repo)
bash scripts/setup-ubuntu.sh
#   optional extras:  bash scripts/setup-ubuntu.sh --with-browser

# 2. start the agent on any folder
bun packages/cli/src/index.ts ~/my-project
# → http://localhost:4020  (GUI + agent in ONE process)
```

No `node_modules` surgery, no native compilation, no Next.js toolchain needed at
runtime — the static GUI (`gui-dist/`) is committed so plain `bun install` is
enough. Requirements: Ubuntu 20.04+ (or any Debian-based x64/arm64), `git`, and
`curl`; `sudo` is only used if bun or git are missing.

### Options

```bash
bun packages/cli/src/index.ts <folder>  # workspace to open (default: cwd)
                    --port 4020         # daemon port
                    --host 127.0.0.1    # bind address (0.0.0.0 = LAN)
                    --no-open           # don't launch the browser
                    --gui <dir>         # custom GUI bundle directory
```

### 📱 Run it on your phone (Android, no root)

Tagent runs on a phone under [UserLAnd Ubuntu](https://userland.tech) — proot,
no root — and the GUI is a mobile-tabbed layout served to your phone browser:

```bash
# inside the UserLAnd Ubuntu session:
sudo apt-get install -y git curl
git clone https://github.com/asysurya/tagent.git && cd tagent
bash scripts/setup-ubuntu.sh
bun packages/cli/src/index.ts ~/my-project --no-open
```

Then open **http://localhost:4020** in Chrome on the same phone. Full guide:
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
packages/cli      the daemon (http + socket.io) and the `tagent` bin — serves
                  the built GUI statically, one process total
src/              the web GUI (Next.js 16, App Router, client-side)
gui-dist/         committed static export of the GUI (served by the daemon)
mini-services/    sandbox harness that boots the daemon on :3001
builtin-skills/   shipped skills (web-app-builder, code-review, bug-hunter)
demo-workspace/   a tiny vanilla-JS todo app with planted bugs — try the agent on it
scripts/         setup-ubuntu.sh + smoke tests (bun scripts/debug-rpc.ts 4020 /socket)
docs/             USERLAND.md — run Tagent on an Android phone (no root)
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

- [ ] MEGA sync UI (adapter exists in `packages/core/src/storage`)
- [ ] GitHub OAuth device-flow setup wizard (core code ready — needs an OAuth app client id)
- [ ] Native tool-calling mode for OpenAI/Anthropic/Google (react-mode works today on all providers)
- [ ] Streaming tokens (event protocol supports it; providers currently return per-turn)
- [ ] Workspace switcher for multiple concurrent workspaces
- [ ] Share links, relay mode

## Contributing & license

MIT — see [LICENSE](LICENSE). PRs welcome: [CONTRIBUTING.md](CONTRIBUTING.md)
explains the dev loop and conventions. Found something exploitable?
[SECURITY.md](SECURITY.md) — please report privately, not in public issues.
