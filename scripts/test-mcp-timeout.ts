/**
 * test-mcp-timeout.ts — hermetic MCP initialize-timeout behavior.
 *
 * Live report from the owner (Codespace): all four npx-based MCP servers
 * timed out at the old 25s default — npx cold-start downloads on a fresh
 * Codespace easily blow past that. v0.16.1 raises the default to 60s and
 * makes it overridable via TAGENT_MCP_INIT_TIMEOUT_MS.
 *
 * Uses a fake MCP server (plain script that speaks JSON-RPC over stdio) —
 * no npx, no network:
 *   1. slow server (answers initialize after 2.5s) + 1s override → clean
 *      "timed out after 1s" error, never a hang
 *   2. same server, restart with a 30s budget → handshake completes
 *   3. instant server, default budget → ready, tools visible
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { McpManager } from '../packages/core/src/mcp'

let pass = 0
let fail = 0
function ok(cond: boolean, label: string, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`) }
}

// fake server: answers each JSON-RPC request from stdin; the FIRST response
// (initialize) is delayed by <ms> to simulate a slow npx cold-start
const srv = path.join(os.tmpdir(), `tagent-mcp-fake-${Date.now()}.ts`)
fs.writeFileSync(srv, [
  `import readline from 'node:readline'`,
  `const delay = Number(process.argv[2] ?? '0')`,
  `const line = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\\n')`,
  `let first = true`,
  `const rl = readline.createInterface({ input: process.stdin })`,
  `rl.on('line', (raw: string) => {`,
  `  let msg: { id?: number; method?: string }`,
  `  try { msg = JSON.parse(raw) } catch { return }`,
  `  if (typeof msg.id !== 'number') return`,
  `  const respond = () => {`,
  `    if (msg.method === 'initialize') line({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'fake', version: '9' } } })`,
  `    else if (msg.method === 'tools/list') line({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'pings' }] } })`,
  `    else line({ jsonrpc: '2.0', id: msg.id, result: {} })`,
  `  }`,
  `  if (first && delay) { first = false; setTimeout(respond, delay) } else respond()`,
  `})`,
  `setInterval(() => {}, 1 << 30) // stay alive`,
  '',
].join('\n'))

const BUDGET = '1000'
process.env.TAGENT_MCP_INIT_TIMEOUT_MS = BUDGET

console.log(`fake MCP server: ${srv}\n`)

/* ---------------- 1: slow server + 1s budget → timed out ---------------- */
console.log('1 — slow server (2.5s handshake) with a 1s budget:')
const t0 = Date.now()
const mgr = new McpManager({
  servers: { slow: { command: process.execPath, args: [srv, '2500'] } },
})
await mgr.ensureStarted()
const [st1] = mgr.status()
const took = Date.now() - t0
ok(st1.state === 'error', 'state = error', JSON.stringify(st1))
ok(/timed out after 1s/.test(st1.error ?? ''), 'error says "timed out after 1s"', st1.error)
ok(took < 2400, `gave up in ~1s (${took}ms), not the full 2.5s`)
ok(mgr.toolDefinitions().length === 0, 'a failed server contributes no tools')

/* ---------------- 2: restart with a real budget → recovers ---------------- */
console.log('\n2 — same server restarted with a 30s budget:')
process.env.TAGENT_MCP_INIT_TIMEOUT_MS = '30000'
await mgr.restart('slow')
const [st2] = mgr.status()
ok(st2.state === 'ready', 'state = ready after restart', JSON.stringify(st2))
ok(st2.tools === 1, 'tools/list surfaced the tool', JSON.stringify(st2))
ok(mgr.toolDefinitions().map((d) => d.name).includes('mcp_slow_ping'), 'tool is callable as mcp_slow_ping')
mgr.close()

/* ---------------- 3: default budget, instant server → ready ---------------- */
console.log('\n3 — instant server, budget unset (default 60s):')
delete process.env.TAGENT_MCP_INIT_TIMEOUT_MS
const mgr2 = new McpManager({
  servers: { fast: { command: process.execPath, args: [srv, '0'] } },
})
await mgr2.ensureStarted()
const [st3] = mgr2.status()
ok(st3.state === 'ready', 'state = ready', JSON.stringify(st3))
ok(st3.tools === 1, '1 tool', JSON.stringify(st3))
mgr2.close()

/* ---------------- report ---------------- */
console.log(`\nmcp-timeout tests: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
