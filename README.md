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

## Quick start

```bash
# 1. install deps (bun ≥ 1.3 recommended)
bun install

# 2. start the daemon on any folder
bun packages/cli/src/index.ts ~/my-project
# → opens http://localhost:4020 with the GUI

# …or run the sandbox-style daemon on :3001 (used with the bundled Next.js GUI)
bun mini-services/tagent-daemon

# 3. run the GUI in dev (separate terminal)
bun run dev
```

The GUI talks to the daemon over websockets. In the sandbox it goes through the
gateway (`?XTransformPort=3001`); locally the daemon serves everything itself.

## Repository layout

```
packages/core     the engine — loop, tools, providers, permissions,
                  sessions, checkpoints, memory, skills, storage, plugins
packages/cli      the daemon (http + socket.io) and the `tagent` bin
src/              the web GUI (Next.js 16, App Router, client-side)
mini-services/    sandbox harness that boots the daemon on :3001
builtin-skills/   shipped skills (web-app-builder, code-review, bug-hunter)
demo-workspace/   a tiny vanilla-JS todo app with planted bugs — try the agent on it
scripts/          smoke tests (bun scripts/smoke-daemon.ts)
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

## License

MIT
