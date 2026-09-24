/**
 * test-mcp-call-timeout.ts — per-CALL budget via the `__timeout_ms` param
 * (v0.21.0 refinement of req #10 "agent sets tool call timeouts").
 *
 * The agent may now pass `__timeout_ms` on ANY mcp_* call:
 *   - budget clamps into [1s, 1h]
 *   - the param is STRIPPED before the payload reaches the server
 *   - TAGENT_MCP_CALL_TIMEOUT_MS env stays as the global default
 *
 * Fake server (JSON-RPC over stdio): tools/call for `slowping` echoes its
 * arguments back after a 3s delay — long enough to blow a short budget.
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

const srv = path.join(os.tmpdir(), `tagent-mcp-callto-${Date.now()}.ts`)
fs.writeFileSync(srv, [
  `import readline from 'node:readline'`,
  `const line = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\\n')`,
  `const rl = readline.createInterface({ input: process.stdin })`,
  `rl.on('line', (raw: string) => {`,
  `  let msg: { id?: number; method?: string; params?: any }`,
  `  try { msg = JSON.parse(raw) } catch { return }`,
  `  if (typeof msg.id !== 'number') return`,
  `  if (msg.method === 'initialize') { line({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'fake', version: '9' } } }); return }`,
  `  if (msg.method === 'tools/list') { line({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'slowping', description: 'echoes args after 3s' }] } }); return }`,
  `  if (msg.method === 'tools/call') {`,
  `    const args = JSON.stringify(msg.params?.arguments ?? {})`,
  `    setTimeout(() => line({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo ' + args }] } }), 3000)`,
  `    return`,
  `  }`,
  `  line({ jsonrpc: '2.0', id: msg.id, result: {} })`,
  `})`,
  `setInterval(() => {}, 1 << 30) // stay alive`,
  '',
].join('\n'))

console.log(`fake MCP server: ${srv}\n`)

const mgr = new McpManager({
  servers: { echo: { command: process.execPath, args: [srv] } },
})
await mgr.ensureStarted()
const [st] = mgr.status()
ok(st.state === 'ready' && st.tools === 1, 'server ready with 1 tool', JSON.stringify(st))

/* 1 — the surfaced tool advertises __timeout_ms in both docs + schema */
const defs = mgr.toolDefinitions()
const def = defs.find((d) => d.name === 'mcp_echo_slowping')
ok(!!def, 'mcp_echo_slowping surfaced')
ok(!!def && '__timeout_ms' in def.params, 'system-prompt params advertise __timeout_ms')
const props = ((def?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {}) as Record<string, unknown>
ok(props.__timeout_ms !== undefined && (props.__timeout_ms as { type?: string }).type === 'number',
  'inputSchema carries __timeout_ms as number')

/* 2 — short budget via __timeout_ms → tools/call times out at ~1.5s */
{
  const t0 = Date.now()
  let err = ''
  try { await def!.run({ __timeout_ms: 1500 }, { sessionId: 't' } as never) } catch (e) { err = (e as Error).message }
  const took = Date.now() - t0
  ok(/timed out after 1.5s/.test(err), 'times out reporting the per-call budget (1.5s)', err)
  ok(took >= 1400 && took < 2900, `cut short well before the 3s response (${took}ms)`)
}

/* 3 — generous budget via __timeout_ms → succeeds + param is STRIPPED */
{
  const t0 = Date.now()
  const out = await def!.run({ __timeout_ms: 20_000, q: 'hello' }, { sessionId: 't' } as never)
  const took = Date.now() - t0
  ok(/^echo /.test(out) && out.includes('"q"'), 'response arrived with the real args', out)
  ok(!out.includes('__timeout_ms'), '__timeout_ms stripped from the server payload', out)
  ok(took >= 2900, 'waited for the slow 3s response', `${took}ms`)
}

/* 4 — clamp: value under 1s clamps UP to the 1s floor */
{
  let err = ''
  try { await def!.run({ __timeout_ms: 1 }, { sessionId: 't' } as never) } catch (e) { err = (e as Error).message }
  ok(/timed out after 1s/.test(err), 'value under 1s clamps UP to 1s', err)
}
mgr.close()

/* 5 — TAGENT_MCP_CALL_TIMEOUT_MS env default still applies when the agent
 *     passes no param. The constant is fixed at import → verify in a child
 *     process with the env set BEFORE import. */
{
  const runner = path.join(os.tmpdir(), `tagent-mcp-callto-run-${Date.now()}.ts`)
  fs.writeFileSync(runner, [
    `import { McpManager } from ${JSON.stringify(path.resolve('packages/core/src/mcp'))}`,
    `const mgr = new McpManager({ servers: { echo: { command: process.execPath, args: [${JSON.stringify(srv)}] } } })`,
    `await mgr.ensureStarted()`,
    `try {`,
    `  await mgr.toolDefinitions()[0].run({}, { sessionId: 't' } as never)`,
    `  console.log('NO-TIMEOUT')`,
    `} catch (e) { console.log((e as Error).message) }`,
    `mgr.close()`,
  ].join('\n'))
  const proc = Bun.spawnSync([process.execPath, runner], {
    env: { ...process.env, TAGENT_MCP_CALL_TIMEOUT_MS: '1500' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const out = proc.stdout.toString().trim()
  ok(/timed out after 1.5s/.test(out), 'env default applies without the param (child proc)', out)
}

/* ---------------- report ---------------- */
console.log(`\nmcp-call-timeout tests: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
