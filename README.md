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
| 🧭 **Plan → PRD → build** | Plan mode INTERVIEWS you until requirements are detailed, then approval writes `PRD.md` and auto-switches to build; build mode checks for a PRD first and offers plan mode when missing |
| 🛟 **Provider fallback** | Ordered multi-key failover chain — stack the same provider under different keys (1. openrouter/keyA/modelX · 2. openrouter/keyB/modelX · 3. groq…) with automatic mid-run failover (`/fallback`, Settings in the GUI) |
| 👥 **Custom subagents** | `.tagent/agents/*.md` — persona, tool whitelist, model override, turn budget; spawn via `{"agent": "code-reviewer"}` (`/agents`) |
| 🩺 **Auto-diagnostics** | Arm a gate like `/diag "tsc --noEmit"` — runs after edit turns and feeds failures back so the agent self-corrects before saying "done" |
| ⚡ **Smart cache** | The token economist — unchanged-file re-reads return a tiny stub, `read_files` batches known paths into one turn, "read X" subagent prompts get fast-pathed, `@path` mentions attach files inline, old tool outputs auto-compact, and repeated fetches/searches hit a TTL cache (`tagent cache` to inspect) |
| 🔐 **Credentials store** | Secrets live in `~/.tagent/credentials.json` (chmod 600), separate from the shareable config — resolution order: credentials → config → env |
| 🧩 **MCP servers** | Any stdio [Model Context Protocol](https://modelcontextprotocol.io) server — Context7, filesystem, memory, sequential-thinking or your own. Tools appear as `mcp_<server>_<tool>`, same permission gates (`/mcp` in the TUI, Settings → MCP in the GUI) |
| 🔌 **Multi-provider** | 40-provider catalog (OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, Qwen, Kimi, Zhipu, OpenRouter, …) + custom endpoints — BYOK or env vars. Anthropic prompt caching on by default; live token usage in the TUI done-line |
| 🧩 **Plugins v2** | Hook into the loop AND contribute custom agent tools (`plugin_<name>_<tool>`) and slash commands — hot-reloading `.mjs` files |
| 🖥️ **App TUI** | Claude Code-style inline terminal app: the transcript lives in your terminal's own scrollback (scroll with mouse wheel / touch / shift+pgup), a rounded editor box + hint row redraw at the bottom, slash-command palette with tab completion, `@file` mentions, `?` shortcuts, `ctrl+x` quick-action menu (`--classic` for the readline TUI) |
| 🎛️ **Classic TUI** | Arrow-key menus everywhere — model picker with type-to-filter, session browser, permission prompts, y/N confirms — like opencode |
| ⬆️ **Self-update** | Checks for releases on startup and offers an arrow-key y/N update — binary installs swap in place (`tagent update` too). Source installs auto-recover a stuck merge/conflict state, auto-stash local changes, never block on divergence, and snapshot `~/.tagent` (auth · MCP · config) before every update |
| 🔐 **Permissions** | Per-tool ask/allow/deny, remember once/session/always — every write asks first |
| 💾 **Checkpoints** | Auto-snapshot before writes; one-click `/undo` |
| 🧠 **Memory** | `AGENTS.md` (global + workspace) + durable facts, injected into every system prompt |
| 📚 **Skills** | `SKILL.md` playbooks with progressive disclosure (name+description in prompt, full body on demand) |
| 🌐 **Web tools** | `web_fetch`, `ddg_search` (no API key), `browser` (Playwright — full e2e signal: click/type/screenshot/audit) |
| 🧪 **Test mode** | `tagent test` — QA agent: serves the project, clicks through it with a real browser, screenshots + audits responsive/typography/contrast, writes `TEST-REPORT.md` (vision models see the screenshots) |
| 📊 **Context window** | Live usage bar under the chat input (`12.3k/131.1k [██████░░░░] 9%`, color-coded, opencode-style) tracks the model's window every turn; at 80% you get a one-key prompt to compact |
| ✨ **Real TUI libraries** | The interface is built on string-width · figures · cli-boxes · picocolors · wrap-ansi: rounded cards (`╭─ ❯ you ─╮`), emoji tool icons with aligned columns, full box markdown tables (`╭┬╮ ├┼┤ ╰┴╯`), and width that counts CJK/emoji/combining marks correctly — the lines finally RATA (v0.18.0) |
| 🔼 **Multi-line input** | Enter inserts a newline, shift/alt/ctrl+enter sends; bracketed paste — multi-line pastes land as text, never an Enter-submit per line (v0.19.0) |
| 🔺 **Background processes** | `bg_run` / `bg_logs` / `bg_stop` — the agent spawns long-running commands (dev servers, watchers, soak tests) in their own process group, keeps working, polls the output, and kills the tree when done (v0.19.0) |
| 🧰 **Mode toolsets** | build = project-affecting tools, plan = investigate + interview (with explore subagents), test = QA — and MCP/plugin tools stay available in every mode (v0.19.0) |
| ⏱️ **Agent-set timeouts** | bash/serve budgets go up to 60 minutes, `TAGENT_MCP_CALL_TIMEOUT_MS` for slow MCP tools — the agent decides how long to wait (v0.19.0) |
| 🧹 **Deterministic compaction** | `/compact` summarizes old turns into a structured digest (a 100k-token history lands ≈10k) — 100% local code, NO AI call, nothing invented: facts, paths, tool outcomes and decisions are copied, never generated. Re-compaction folds the prior digest in |
| 📝 **AI ask forms** | `ask_user` tool — the agent interviews you through interactive forms: option / multi-option / input fields, add your own options, optional notes box; answers flow back into the run (TUI overlay · GUI dialog · headless-safe) |
| 🛠 **Z.ai models config** | The built-in provider's model list is data: edit `~/.tagent/zai-models.json` (or `<workspace>/.tagent/zai-models.json`) to add/relabel/flag models — no release wait |
| 🗄️ **Storage adapters** | Local today, MEGA.nz (E2E-encrypted snapshots & memory) implemented as an experimental adapter |
| 🐙 **GitHub** | PAT, web-connect or device-flow auth (`tagent auth`) → auto private repo + one-click workspace push · multi-device safe (fetch+rebase before push) |
| 📋 **Worklog + todos** | Live todo list + timestamped WORKLOG.md journal the agent keeps as it works |
| 🦴 **Caveman mode** | Token saver that SUMMARIZES instead of truncating: big tool outputs become head+tail digests with explicit elision markers, repeated lines collapse (`×N`), JSON gets minified, old write_file echoes are slimmed to path+preview, replies go terse — no information silently lost |
| 🔗 **Share links** | Export any session as a standalone read-only HTML file |
| 📡 **Relay mode** | Share a session LIVE over the network — a read-only viewer page that streams messages, tool calls and todos as they happen |
| 🕸️ **Timelines** | Subagent runs persist as sessions — inspect the multi-agent timeline after the fact |
| 🗑️ **Self-uninstall** | `tagent uninstall` removes the command, `~/.tagent` data, the source repo and/or the binary — each behind its own confirmation |
| 👤 **Guest-first** | Works fully offline & local; accounts are optional |

## Install

Grab the file for your platform from [releases](https://github.com/asysurya/tagent/releases/latest)
(or the website's [download page](https://tagent-website.vercel.app/download), which auto-detects it)
and run it. No runtime, no clone, no setup — the web GUI is embedded in the file
and self-extracts on first launch:

```bash
# linux / macOS
chmod +x tagent-v0.9.0-linux-x64
./tagent-v0.9.0-linux-x64 start ~/my-project
```

| File | Platform |
| --- | --- |
| `tagent-v0.9.0-windows-x64.exe` | Windows 10+ · 64-bit |
| `tagent-v0.9.0-windows-arm64.exe` | Windows 10+ · ARM64 |
| `tagent-v0.9.0-linux-x64` | Linux x86-64 (glibc) |
| `tagent-v0.9.0-linux-arm64` | Linux ARM64 (Pi 5, ARM servers) |
| `tagent-v0.9.0-macos-x64` | macOS Intel |
| `tagent-v0.9.0-macos-arm64` | macOS Apple silicon |

Verify downloads against `SHA256SUMS.txt` (`sha256sum --check` ·
`certutil -hashfile <file> SHA256` on Windows). Windows needs
[Git for Windows](https://git-scm.com/download/win) for the bash tool
(`tagent doctor` checks it). Binaries are rebuilt the same way as the releases:
`bash scripts/build-binaries.sh`.

## Uninstall

`tagent uninstall` removes the `tagent` command, the `~/.tagent` data (config,
credentials, caches) and — each behind its own confirmation — the source repo
and/or the downloaded binary. It works the same from a binary install without
the repo; per-workspace `.tagent/` folders in your projects are left alone.

## Quick start — from source (Ubuntu / Debian / WSL2)

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
tagent test [path]         # TEST MODE — the QA agent (serve + browse + report)
           --url http://…  # verify an already-running app instead
tagent auth                # GitHub login wizard (web connect / PAT)
           --web           # browser page login — no typing in the terminal
tagent sync [message]      # project → GitHub (commit + push, multi-device safe)
tagent clone <repo|name>   # restore a project on this machine — then `tagent start`
tagent projects            # linked projects — name, repo, last sync
tagent whoami · logout     # guest/login check · remove the local token
tagent config list|get|set # settings from the shell (-g = global)
tagent sessions [path]     # list a workspace's sessions
tagent share [id] [path]   # export a session as standalone HTML
tagent relay [id] [path]   # share a session LIVE (read-only viewer page)
           --port --host   # --host 0.0.0.0 exposes it on your LAN
tagent relay list|stop     # manage live relays
tagent doctor [path]       # environment sanity check
tagent version · --check-update · help
```

Inside the TUI everything is a slash command — `/help` lists them all (sessions,
model switching, caveman, worklog, share, relay, timeline, permissions, files,
grep, auth, push, checkpoints, memory, skills…). Plain text talks to the agent.

### 🧪 Test mode — the QA agent

`tagent test` (or `/test` in the TUI, or the Test button in the GUI) turns the
agent into a QA engineer for the project in the workspace:

1. **serve** — auto-detects the dev command (`package.json` scripts, package
   manager from the lockfile) and boots it in the background, then waits for
   the port to answer. Pass `--url` (or `/test <url>`) to test an app that is
   already running.
2. **browser** — drives a real Chromium via Playwright: opens pages, clicks
   buttons, fills inputs, submits forms. Every interaction returns the new page
   state (ARIA snapshot) plus any console/network errors — the agent SEES the
   result of what it did.
3. **responsiveness + visuals** — screenshots at mobile (390×844), tablet
   (768×1024) and desktop (1280×800), plus a deterministic audit: horizontal
   overflow (with the offending elements), typography map and <12px text, tap
   targets <24px, images without alt, missing viewport meta, WCAG contrast
   sampling.
4. **vision** — screenshots are attached to the model's context when the
   current model accepts image input (GPT-4o/5, Claude, Gemini, GLM-4V, Qwen-VL,
   …), so the agent can JUDGE the UI, not just measure it. Text-only models get
   the DOM audit instead.
5. **report** — one `test_report` call writes `TEST-REPORT.md` at the workspace
   root (verdict pass / warn / fail, feature checklist with evidence, issues
   with repro steps, per-viewport findings) plus a timestamped copy under
   `.tagent/test/`.

Test mode is read-only for source files — it verifies, build mode fixes. The
only write it can do is its own report. Requires Playwright (one-time, in your
project): `bun add playwright && bunx playwright install chromium`.

### 📡 Relay mode — share a session live

Share what the agent is doing with a teammate (or your phone) while it happens.
The viewer gets a read-only page with the history plus everything live:
streaming tokens, tool calls, todos. Revoke at any time.

```bash
tagent relay ~/my-project            # share the newest session, prints the URL
tagent relay --host 0.0.0.0          # LAN urls for phone/teammates
tagent relay list ~/my-project       # active relays
tagent relay stop <code>             # end it — viewers disconnect instantly
```

In the TUI: `/relay` (starts a local endpoint on demand), `/relay list`,
`/relay stop <code>`. In the GUI: the RadioTower button on a session, and the
"live shares" list in the sidebar. Codes are unguessable, relays persist until
revoked, and viewer sockets are read-only by construction.

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
`web_fetch` · `ddg_search` · `task` (subagents) · `todowrite` · `memory` · `load_skill` · `browser` (optional Playwright) ·
`serve` + `test_report` (test mode) · `ask_user` (interview forms) ·
`mcp_<server>_<tool>` (every connected MCP server) · `plugin_<name>_<tool>` (every loaded plugin)

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

## Providers

**40 providers out of the box, custom endpoints for everything else** — opencode-style.

Keys resolve from config first, then environment variables — `export OPENAI_API_KEY=…`
just works. Model refs are `provider/model` everywhere:

```sh
tagent models                          # browse the catalog — ready + needs-key
tagent models --refresh                # live discovery: GET /models per provider
tagent config set model groq/llama-3.3-70b-versatile   # provider + model in one go
# TUI: /model <search> · /model groq/llama-3.3-70b-versatile · /model refresh
```

Built-in catalog (id → key env var): **openai** (OPENAI_API_KEY) · **anthropic**
(ANTHROPIC_API_KEY) · **google** (GEMINI_API_KEY) · **openrouter** · **groq** ·
**xai** (Grok) · **deepseek** · **mistral** · **perplexity** · **cohere** · **ai21** ·
**together** · **fireworks** · **cerebras** · **deepinfra** · **nebius** · **novita** ·
**hyperbolic** · **baseten** · **featherless** · **nvidia** · **turing** · **qwen**
(DashScope) · **moonshot** (Kimi) · **zhipu** (GLM, open.bigmodel.cn) · **zai-api**
(api.z.ai) · **siliconflow** · **volcengine** (Doubao) · **byteplus** · **ovh** ·
**scaleway** · **github-models** (GITHUB_TOKEN) · **vercel-ai-gateway** · **glama** ·
**aihubmix** · local runtimes **ollama** · **lmstudio** · **vllm** · **llamacpp** (no key).

**Custom providers** (Settings → Providers → Add custom, or config) cover anything
else — any OpenAI-compatible endpoint (vLLM, llama.cpp, LiteLLM, OneAPI, Azure's
`…/openai/v1`), Anthropic-compatible proxies and Google-compatible gateways:

```jsonc
"customProviders": [{
  "id": "my-gateway",
  "label": "My Gateway",
  "kind": "openai",                    // or "anthropic" / "google"
  "baseUrl": "https://my-gateway.example.com/v1",
  "apiKey": "optional — empty for local servers",
  "models": ["my-model"]               // seed list — refresh discovers the rest
}]
```

Live model discovery (`GET /models`) fills every pickable list — GUI button, TUI
`/model refresh`, CLI `tagent models --refresh`, plus a background warm-up when the
daemon starts. Results are cached in `~/.tagent/models.json`.

### The built-in Z.ai provider — models as a config file

The zero-config **zai** provider (default in sandbox/z.ai environments — no key
needed) reads its model list from data, not code. The shipped catalog lives at
`packages/core/src/data/zai-models.json`; you can override or extend it **without
touching the binary**:

```jsonc
// ~/.tagent/zai-models.json            (global)
// <workspace>/.tagent/zai-models.json  (per project — wins over global)
{
  "models": [
    { "id": "glm-4.7", "label": "GLM-4.7 (default)", "vision": true },
    { "id": "glm-my-finetune", "label": "My finetune" }   // new ids append
  ]
  // "replace": true  ← use ONLY these models, drop the built-ins
}
```

Same-id entries replace the built-ins in place, new ids append, `vision: true`
enables screenshot verification in test mode, and the file never needs to wait
for a tagent release — a new model is one JSON edit away.

## Ask forms — `ask_user`

When a decision materially changes the work, the agent **asks, not guesses** —
through an interactive form, not a wall of text:

- **option** — single choice (radio) · **multi** — pick any (checkboxes) ·
  **input** — free text
- option/multi fields always offer **+ add your own option** — your custom
  answer becomes a first-class choice
- every form carries an optional **notes** box under the fields for anything
  else worth saying
- one `ask_user` call batches up to 6 questions — one round-trip instead of
  a chat interrogation

Surfaces: the inline TUI renders the form as an interactive overlay (↑↓ move ·
space/enter pick · `a` add option · tab next field · esc cancels), the web GUI
shows a proper dialog (radio buttons, checkboxes, textareas), the classic TUI
asks sequentially, and headless runs (pipes, subagents) get an honest
"no interactive user" answer so the model proceeds with stated assumptions
instead of hanging. Plan mode's interview step uses it by default.

## Context window — the usage bar + deterministic compaction

The hint row under the chat input always shows how much of the model's context
window the session eats, opencode-style:

```
build · glm-4.7 · 12.3k/131.1k [██████░░░░] 9% · 14m
```

- the percentage is **live** — every turn reports either the provider's real
  token usage or a local CJK-aware estimate
- the bar is color-coded: green < 60% · yellow 60–80% · red ≥ 80%
- model windows resolve from the catalog (`~/.tagent/zai-models.json` carries a
  `contextWindow` field per model), the provider seeds, id heuristics — or set
  `TAGENT_CONTEXT_WINDOW=<tokens>` to override

### `/compact` — ringkas memory, tanpa AI

When the bar crosses **80%** (configurable), you get a one-key prompt to
compact; `/compact [keep-tokens]` works any time. Compaction summarizes old
turns into ONE structured digest message while the most recent turns stay
verbatim — a 100k-token history typically lands near 10k.

The whole thing is **deterministic local code — no AI call, ever**:

- every digest line is *copied* from the transcript (who asked what, which
  tools ran on which paths, statuses, decisions) — nothing is generated, so
  nothing can be hallucinated
- `@file` attachment bodies drop out of old turns (the files are on disk —
  re-read when the exact bytes matter)
- re-compaction folds the prior digest into the new one — history never
  duplicates
- the compaction itself costs zero tokens: it must never spend the user's
  model to save the user's tokens

Related diet that runs automatically on every request: old `write_file` /
`edit_file` action echoes are slimmed to path + preview (whole-file contents
stopped being re-sent forever), and old tool results become per-tool digests.
Thresholds tighten further in caveman mode.

```jsonc
// .tagent/config.json
"compact": { "threshold": 80, "keepTokens": 10000 }  // threshold 0 = never prompt
```

## MCP servers — Model Context Protocol

Tagent speaks MCP over stdio — connect any server and its tools become agent-callable
natives (named `mcp_<server>_<tool>`), going through the same permission gates as
the built-ins.

```sh
# interactive manager (status, templates, custom, toggle, remove)
#   in the TUI: /mcp        · in the GUI: Settings → MCP

# or edit .tagent/config.json directly:
```

```jsonc
"mcp": { "servers": {
  "context7":   { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
  "memory":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },
  "my-server":  { "command": "node", "args": ["./my-mcp.js"], "env": { "API_KEY": "…" }, "enabled": true }
}}
```

Permissions: `/allow mcp_<server>` (per server), `mcp` (catch-all), or the default ask.
`tagent doctor` starts every configured server and reports per-server health.

The first `npx`/`uvx` run downloads the server package, so the initialize budget
is a generous 60s — raise it with `TAGENT_MCP_INIT_TIMEOUT_MS=<millis>` on slow
links (a fresh Codespace can easily spend 30–50s per server on cold start).

## Plugins — tools, commands, hooks

Drop a `.mjs` file into `.tagent/plugins/` (workspace) or `~/.tagent/plugins/` (global) —
it hot-reloads every turn. Scaffold one with `/plugins` in the TUI or Settings → Plugins:

```js
export const name = 'my-plugin'
export const version = '1.0.0'

// custom agent tool — callable as plugin_my-plugin_weather
export const tools = [{
  name: 'weather',
  description: 'get the weather for a city',
  risk: 'low',
  params: { city: 'string — city name' },
  async run({ city }) { return `sunny in ${city}` },
}]

// custom slash command — /hello-world <args>
export const commands = [{
  name: 'hello-world',
  async run({ args }) { return 'hi ' + args },
}]

// lifecycle hooks (optional)
export const hooks = {
  onToolCall({ tool, input }) { /* audit log, … */ },
  onAgentDone({ summary }) { /* notify, … */ },
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
- [x] Relay mode — share a session with another person over the network (v0.5.0)
- [x] Provider catalog — 40 providers, env-var keys, custom endpoints, live model discovery (v0.6.0)
- [x] Single-file binaries — download, run, done; embedded web GUI (v0.7.0)
- [x] MCP servers — Model Context Protocol over stdio, same permission gates (v0.8.0)
- [x] Plugins v2 — custom tools + slash commands, hot-reload (v0.8.0)
- [x] Interactive TUI — arrow-key menus, type-to-filter model picker (v0.8.0)
- [x] Self-update — y/N prompt on startup, in-place binary swap (v0.8.0)
- [x] Context window — live usage bar under the chat input, 80% compact prompt (v0.17.0)
- [x] Deterministic compaction — `/compact` summarizes old turns with zero AI calls (v0.17.0)
- [x] Update never blocks / never loses data — conflict-state recovery + `~/.tagent` snapshots (v0.17.0)
- [x] Real TUI libraries — string-width/figures/cli-boxes/picocolors/wrap-ansi; rounded cards, emoji tool icons, box tables, aligned everything (v0.18.0)
- [x] Background processes — bg_run/bg_logs/bg_stop, the agent runs and watches long commands (v0.19.0)
- [x] Multi-line input — enter=newline, shift+enter=send, paste-safe; mode toolsets; agent-set timeouts (v0.19.0)

Ideas for the next versions (unordered, unpromised):

- [ ] Relay viewer participation — let a trusted viewer send messages to the agent
- [ ] Remote relay — broker page for sharing across networks without an SSH tunnel
- [ ] Auth for LAN daemons — token-gated GUI/RPC when bound to 0.0.0.0

## Releases & versioning

Versioning is semver-ish; every release is a git tag + a GitHub release, and the
changelog lives in [`website/src/data/releases.ts`](website/src/data/releases.ts)
(single source of truth for the site, the CLI update check and the release notes).

```bash
tagent version            # running version
tagent update             # check + self-update (y/N) — binary, npm, bun or source
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
