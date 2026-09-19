# tagent-native — Tagent for Windows 7+ (including 32-bit)

The full Tagent (TUI, web GUI, MCP, plugins) runs on the Bun runtime, which
needs Windows 10+ 64-bit. **tagent-native** is the companion for old machines:
a single static binary written in Go 1.21 (the last toolchain supporting
Windows 7/8), including **32-bit x86** builds.

- `tagent-native-windows-386.exe` — Windows 7/8/10/11, 32-bit
- `tagent-native-windows-amd64.exe` — Windows 10/11, 64-bit
- `tagent-native-linux-amd64` / `-arm64` — Linux
- macOS users: run the main Tagent binaries

## What it does

- OpenAI-compatible chat with **function calling** (tools)
- Tools: `read_file`, `write_file`, `edit_file`, `list_files`, `bash`
  (workspace-jailed — paths cannot escape the workspace root)
- Interactive REPL (one task per line) and one-shot `tagent-native run "task"`
- **Ordered provider fallback chain** — same as the full Tagent, configured in
  the same `~/.tagent/config.json`

## What it does NOT have (use the full Tagent for these)

TUI menus, web GUI, MCP servers, plugins, skills, checkpoints, the smart
cache, plan mode — this is the minimal core for machines that cannot run Bun.

## Config

Same file as the full Tagent: `~/.tagent/config.json` (on Windows:
`%USERPROFILE%\.tagent\config.json`). Minimal example with a 3-key
OpenRouter stack plus a Groq backup:

```json
{
  "defaultProvider": "zai",
  "defaultModel": "glm-4.7",
  "apiKeys": { "zai": "sk-..." },
  "fallback": [
    { "provider": "openrouter", "model": "anthropic/claude-sonnet-4", "apiKey": "sk-or-v1-KEY1" },
    { "provider": "openrouter", "model": "anthropic/claude-sonnet-4", "apiKey": "sk-or-v1-KEY2" },
    { "provider": "openrouter", "model": "openai/gpt-4o-mini",        "apiKey": "sk-or-v1-KEY3" },
    { "provider": "groq",        "model": "llama-3.3-70b-versatile" }
  ]
}
```

A per-entry `apiKey` overrides the stored key for that position — that is how
the same provider can appear multiple times under different accounts. Entries
try top → bottom; a provider error fails over to the next one automatically.

Built-in provider ids: `zai`, `openrouter`, `groq`, `openai`. Anything else
(any OpenAI-compatible endpoint) goes through `customProviders`:

```json
"customProviders": [
  { "id": "mylocal", "label": "Local llama", "baseUrl": "http://127.0.0.1:8000/v1", "models": ["llama3"] }
]
```

## Network notes

`TAGENT_TLS_SKIP=1` disables certificate verification — for networks with
broken TLS interception (captive portals, some proxies). Use only on networks
you control.

## Build

```bash
bash native/build.sh              # all targets (needs go 1.21 on PATH)
bash native/build.sh windows      # windows-386 + windows-amd64
```

Binaries land in `native/dist/` with `SHA256SUMS.txt`.

## Verify

```bash
./dist/tagent-native-linux-amd64 version
./dist/tagent-native-linux-amd64 selftest    # exercises every tool offline
```
