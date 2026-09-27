/**
 * Smoke — v0.31 plugin decision hooks (beforeToolCall gatekeeper + onResolve
 * resolver). Fast sanity check of the emit layer before the full test
 * subagent run; the comprehensive suite lives in test-plugin-hooks.ts.
 *
 * Run: bun scripts/smoke-plugin-hooks.ts
 */
import { emitBeforeToolCall, emitOnResolve, type TagentPlugin } from '../packages/core/src/plugins'

const mk = (hooks: TagentPlugin['hooks']): TagentPlugin => ({
  name: 'p', version: '1.0.0', description: '', file: '', scope: 'workspace',
  hooks, tools: [], commands: [],
})

const ctx = { tool: 'bash', input: { command: 'ls' }, risk: 'high' as const, workspaceRoot: '/tmp', sessionId: 's1' }

// 1. block wins
const blocker = mk({ beforeToolCall: async () => ({ action: 'block' as const, reason: 'test block', alternative: 'do X instead' }) })
console.log('1 block        :', JSON.stringify(await emitBeforeToolCall([blocker], ctx)))

// 2. no plugins → allow
console.log('2 allow        :', JSON.stringify(await emitBeforeToolCall([], ctx)))

// 3. throwing hook → fails open (allow)
const thrower = mk({ beforeToolCall: async () => { throw new Error('boom') } })
console.log('3 throw→allow  :', JSON.stringify(await emitBeforeToolCall([thrower], ctx)))

// 4. modify rewrites input
const modifier = mk({ beforeToolCall: async () => ({ action: 'modify' as const, input: { command: 'ls -la' } }) })
console.log('4 modify       :', JSON.stringify(await emitBeforeToolCall([modifier], ctx)))

// 5. first block wins over a later modify
console.log('5 block>modify :', JSON.stringify(await emitBeforeToolCall([blocker, modifier], ctx)))

// 6. onResolve merge across plugins + first hint wins
const a = mk({ onResolve: async () => ({ available: [{ type: 'tool', name: 'read_file' }], hint: 'h1' }) })
const b = mk({ onResolve: async () => ({ available: [{ type: 'mcp', name: 'mcp_x', reason: 'r' }], unavailable: [{ type: 'mcp', name: 'mcp_y', reason: 'off' }], hint: 'h2' }) })
console.log('6 resolve merge:', JSON.stringify(await emitOnResolve([a, b], { query: 'file', workspaceRoot: '/tmp', mode: 'build' })))

// 7. no resolver → null
console.log('7 resolve null :', JSON.stringify(await emitOnResolve([mk({})], { query: 'x', workspaceRoot: '/tmp', mode: 'plan' })))

// 8. throwing resolver → skipped, other plugin still answers
const rThrower = mk({ onResolve: async () => { throw new Error('boom') } })
console.log('8 resolve throw:', JSON.stringify(await emitOnResolve([rThrower, a], { query: 'file', workspaceRoot: '/tmp', mode: 'build' })))
