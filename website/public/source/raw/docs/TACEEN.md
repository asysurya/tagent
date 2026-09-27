# Taceen — Tool & Capability Resolver

Status: **PREP WORK (skeleton + mock)**. This document describes the Taceen
plugin template as wired into this repo. The "real" Taceen model does not
exist yet — everything here is the scaffolding it will slot into.

- Plugin: `.tagent/plugins/taceen.mjs` (config: `.tagent/plugins/taceen.json`)
- Mock model: `.tagent/taceen/taceen.py` (JSON over stdin/stdout skeleton)
- Categories feed (Part C, future): `.tagent/taceen/categories.json`

---

## 1. What is Taceen? / Apa itu Taceen?

Taceen is a small **Tool & Capability Resolver** — a compact Python model
(~30–50 MB) that answers two questions for the agent:

1. **"Which tool / MCP / plugin / skill can do X?"** — instead of stuffing
   every tool description wholesale into the system prompt, tagent asks
   Taceen on demand. This saves context window: tool descriptions stop
   riding the system prompt; the agent only sees the capabilities relevant
   to the current intent.
2. **"Should this tool call be allowed / modified?"** — a gatekeeper that
   can block or rewrite risky calls before they reach the permission layer.

Taceen berjalan sebagai proses Python kecil yang berbicara JSON lewat
stdin/stdout — bukan LLM penuh, cukup model kecil untuk resolusi kategori
dan validasi pola berbahaya.

## 2. How it hooks into tagent

The plugin uses the **NEW plugin API introduced in tagent v0.31**:

- `hooks.beforeToolCall({ tool, input, risk, workspaceRoot, sessionId })`
  — gatekeeper, runs **pre-permission** (before the tool executes). May
  return nothing/`{action:'allow'}` (neutral), `{action:'block', reason,
  alternative?}` (reason/alternative are fed back to the agent), or
  `{action:'modify', input}` (replaces the tool input). First block/modify
  across plugins wins. A hook that throws is logged and skipped (fails OPEN).
- `hooks.onResolve({ query, workspaceRoot, mode })` — resolver. May return
  `{ available: [{type:'tool'|'mcp'|'plugin'|'skill', name, reason?}],
  unavailable?, hint? }` or `undefined` for "no answer".
  `risk` is `'low'|'medium'|'high'`; `mode` is `'plan'|'build'|'test'`.

The plugin itself is loaded by the standard tagent plugin loader from
`<workspace-root>/.tagent/plugins/*.mjs` (project) or `~/.tagent/plugins/*.mjs`
(global) — a plain ESM module exporting `name`, `version`, `description?`,
`hooks`. It contributes **no** tools or commands.

> **Note:** as of this repo state, `onResolve` has **no loop call-site yet**
> in `packages/core` — the main-agent/sub-agent integration that will query
> it is future work. This is deliberate prep: the plugin + stdio contract
> land first, the core wiring lands in the v0.31+ releases.

## 3. The stdio JSON contract (two intents)

One process per request: tagent spawns `python3 taceen.py`, writes ONE JSON
line to stdin, closes stdin, reads ONE JSON line from stdout.

### `resolve` — "which capability fits this query?"

Request:
```json
{"intent":"resolve","query":"read a file","workspaceRoot":"/path","mode":"build"}
```
Response:
```json
{"available":[{"type":"tool","name":"read_file","reason":"filesystem read"}],
 "unavailable":[{"type":"mcp","name":"figma","reason":"not connected"}],
 "hint":"optional free-text guidance"}
```

### `validate` — "is this tool call allowed?"

Request:
```json
{"intent":"validate","tool":"bash","input":{"command":"rm -rf /"},
 "risk":"high","workspaceRoot":"/path","sessionId":"s1"}
```
Response (one of):
```json
{"action":"allow"}
{"action":"block","reason":"destructive command","alternative":"list files first"}
{"action":"modify","input":{"command":"ls -la"}}
```

## 4. Config reference — `.tagent/plugins/taceen.json`

Read once at plugin import (missing file → defaults; broken JSON → defaults +
one console warning; unknown keys are kept but ignored).

| Field           | Type    | Default                       | Meaning                                                        |
|-----------------|---------|-------------------------------|----------------------------------------------------------------|
| `enabled`       | bool    | `true`                        | Master switch. `false` → both hooks return `undefined` instantly. |
| `mode`          | string  | `"mock"`                      | `"mock"` (pure-JS heuristics) or `"subprocess"` (spawn Python).   |
| `pythonPath`    | string  | `"python3"`                   | Interpreter used to run the script.                           |
| `taceenScript`  | string  | `".tagent/taceen/taceen.py"`  | Script path, resolved against the workspace root derived from the plugin's own location (`<root>/.tagent/plugins/..`). |
| `timeoutMs`     | number  | `1500`                        | Subprocess timeout; on expiry the child is killed and the call is allowed. |

### Disable / enable

```json
{"enabled": false}
```
Both hooks short-circuit to `undefined` (no log lines, no subprocess).

### Switch mock → subprocess

```json
{"mode": "subprocess"}
```
Now `onResolve`/`beforeToolCall` shell out to `python3 .tagent/taceen/taceen.py`
with the JSON contract above. In mock mode the plugin instead uses built-in
heuristics: `file`/`test`/`web` keywords → `read_file`/`bash`/`mcp_browser_navigate`
entries, and any `bash` command containing `rm -rf` is blocked with a hint.

## 5. Replacing the mock with the real model

The mock is a stand-in; the real Taceen will be a ~30–50 MB Python model.
Two supported swap paths — **the JSON-over-stdio contract must not change**:

1. **Swap the file**: overwrite `.tagent/taceen/taceen.py` with the real model
   (keep the one-line-JSON-in / one-line-JSON-out protocol).
2. **Point elsewhere**: set `taceenScript` in `taceen.json` to the real model's
   path (absolute or workspace-relative).

Keep `taceen.json` either way. The real model will also consume
`.tagent/taceen/categories.json` (maintained by Part C of this prep work) as
its capability taxonomy — which tools/MCPs/skills exist and what they cover.

## 6. The fallback rule (design invariant)

**Any Taceen error or timeout → ALLOW.** Taceen must never block the agent
because of its own bugs:

- every hook body is wrapped in `try/catch` → `console.error` + `return undefined`;
- the subprocess helper never throws: spawn failure, empty output, unparseable
  JSON, and timeout all collapse to `null` → normalized to `undefined` (= allow);
- only a deliberate, well-formed `{action:'block'}` from the resolver/model
  blocks anything.

So: python3 missing? Agent runs fine. Model segfaults? Agent runs fine.
Config file corrupt? Defaults, agent runs fine.

## 7. Troubleshooting

| Symptom | Check |
|---------|-------|
| `python3` not found | `which python3`; set `pythonPath` to an absolute interpreter path. |
| `[taceen] subprocess timeout after 1500ms` | The model is too slow — raise `timeoutMs` (each request pays process startup). |
| `[taceen] subprocess returned unparseable JSON` | The script printed non-JSON (or extra lines) on stdout — keep stdout strictly one JSON line; logs belong on stderr. |
| Plugin not loading | Must be `.tagent/plugins/taceen.mjs` (project) or `~/.tagent/plugins/taceen.mjs` (global), valid ESM, exporting `name` and `hooks`; a plugin that throws on import is skipped with a console error. |
| Nothing happens, no logs | `enabled` is `false`, or you are still in `mock` mode (mock logs `[MOCK] Taceen resolve: …` only on `onResolve`). |

**Seeing it work** — the console lines are the markers:

- `[MOCK] Taceen resolve: <query>` — mock resolver fired.
- `[python-mock] resolve: <query>` (in the returned `hint`) — the subprocess
  path round-tripped through `taceen.py`.
- `[taceen] …` — warnings: config problems, subprocess failures, timeouts.
- `[MOCK] destructive command detected (rm -rf)` — the mock gatekeeper
  blocked a `bash` call containing `rm -rf`.
