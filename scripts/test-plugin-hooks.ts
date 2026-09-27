#!/usr/bin/env bun
/**
 * test-plugin-hooks.ts — v0.31 plugin decision hooks (independent verification).
 *
 * PART A — the core hook system (packages/core):
 *   A1  test-gate plugin scaffold → loadPlugins discovery (temp root only)
 *   A2  e2e: bash blocked by beforeToolCall — denied record, fed-back
 *       "### bash (denied)" result, NO side effect on disk
 *   A3  e2e: other tools (read_file) unaffected by the gate
 *   A4  e2e: subagents inherit the gatekeeper — the denial is fed back into
 *       the SUBAGENT conversation and reaches the parent via the task result
 *   A5  e2e: no plugins option → old behavior unchanged (bash executes)
 *   A6  e2e modify path (rewritten command actually runs) + emit-layer units
 *       (block wins / throw→allow / modify / block>modify / onResolve merge,
 *       first-hint, null, throwing resolver)
 *
 * PART B — the Taceen plugin template (the REAL files in this repo):
 *   B1  loadPlugins(repoRoot) → taceen.onResolve direct invocation ([MOCK]
 *       marker log + read_file capability). onResolve has no loop call-site
 *       yet (by design) so direct invocation is the correct check.
 *   B2  e2e with the real taceen plugin: destructive bash blocked, benign
 *       bash allowed
 *   B3  enabled:false — full structure copied to a TEMP root: hooks neutral,
 *       no [MOCK] log, bash runs
 *   B4  subprocess mode (TEMP root): python hint + manual taceen.py validate
 *       + missing-script error path → undefined (allow)
 *
 * All fixtures live in fs.mkdtempSync roots under /tmp — the repo's own
 * .tagent/ is only ever READ, never written.
 *
 * Run: bun scripts/test-plugin-hooks.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  AgentLoop,
  PermissionManager,
  defaultConfig,
  type ProviderAdapter,
  type CompletionRequest,
} from '../packages/core/src/index'
import {
  loadPlugins,
  emitBeforeToolCall,
  emitOnResolve,
  type TagentPlugin,
} from '../packages/core/src/plugins'
import type { AgentEvents, SessionData, TagentConfig, ToolCallRecord } from '../packages/core/src/types'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const REPO_ROOT = path.resolve(import.meta.dir, '..')
const cfg: TagentConfig = {
  ...defaultConfig(),
  permissions: { defaultMode: 'allow', tools: {} },
  tools: { bash: true, browser: true, serve: true },
}

/** a plain fake provider (hermetic — never touches the network) */
function fakeProvider(script: (req: CompletionRequest) => string): ProviderAdapter {
  return {
    id: 'fake', label: 'fake', supportsNativeTools: false, models: [],
    complete: async () => '',
    completeStream: async (req) => ({ text: script(req) }),
  }
}

function mkSession(root: string, id: string): SessionData {
  return {
    id, workspaceId: root, title: `t-${id}`, model: 'fake', mode: 'build',
    createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
  }
}

function toolRecords(session: SessionData): ToolCallRecord[] {
  return session.messages.flatMap((m) => m.toolCalls ?? [])
}

function fedResults(session: SessionData): string {
  return session.messages.filter((m) => m.meta?.toolResults).map((m) => m.content).join('\n')
}

/** in-memory plugin factory (no file involved) for the unit/e2e fixtures */
const mk = (hooks: TagentPlugin['hooks']): TagentPlugin => ({
  name: 'p', version: '1.0.0', description: '', file: '', scope: 'workspace',
  hooks, tools: [], commands: [],
})

/** capture console.log/console.error while fn runs (restores in finally) */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = []
  const errors: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')) }
  try {
    return { result: await fn(), logs, errors }
  } finally {
    console.log = origLog
    console.error = origErr
  }
}

/** copy the real taceen structure into a temp root with a custom taceen.json */
function copyTaceen(root: string, json: object): void {
  fs.mkdirSync(path.join(root, '.tagent', 'plugins'), { recursive: true })
  fs.mkdirSync(path.join(root, '.tagent', 'taceen'), { recursive: true })
  fs.copyFileSync(path.join(REPO_ROOT, '.tagent', 'plugins', 'taceen.mjs'), path.join(root, '.tagent', 'plugins', 'taceen.mjs'))
  fs.copyFileSync(path.join(REPO_ROOT, '.tagent', 'taceen', 'taceen.py'), path.join(root, '.tagent', 'taceen', 'taceen.py'))
  fs.writeFileSync(path.join(root, '.tagent', 'plugins', 'taceen.json'), JSON.stringify(json, null, 2) + '\n')
}

async function main() {
  /* ================= PART A — core hook system ================= */
  console.log('A1) test-gate plugin scaffold + loadPlugins discovery')
  const A_ROOT = fs.mkdtempSync('/tmp/tagent-hooks-a-')
  fs.mkdirSync(path.join(A_ROOT, '.tagent', 'plugins'), { recursive: true })
  fs.writeFileSync(
    path.join(A_ROOT, '.tagent', 'plugins', 'test-gate.mjs'),
    `export const name = 'test-gate'
export const version = '1.0.0'
export const description = 'test gatekeeper: blocks all bash calls'

export const hooks = {
  async beforeToolCall({ tool }) {
    if (tool === 'bash') {
      return { action: 'block', reason: 'test block', alternative: 'use read_file instead' }
    }
    return undefined
  },
  async onResolve() {
    return { available: [{ type: 'tool', name: 'read_file' }] }
  },
}
`,
  )
  const a1plugins = await loadPlugins(A_ROOT)
  const gate = a1plugins.find((p) => p.name === 'test-gate')
  ok('A1 plugin discovered with name "test-gate"', !!gate, JSON.stringify(a1plugins.map((p) => p.name)))
  ok('A1 beforeToolCall hook present', typeof gate?.hooks.beforeToolCall === 'function')
  ok('A1 onResolve hook present', typeof gate?.hooks.onResolve === 'function')
  ok('A1 scope is workspace', gate?.scope === 'workspace', gate?.scope)
  const gateResolve = await gate?.hooks.onResolve?.({ query: 'q', workspaceRoot: A_ROOT, mode: 'build' })
  ok(
    'A1 loaded onResolve answers read_file',
    typeof gateResolve === 'object' && gateResolve !== null && gateResolve.available.some((c) => c.type === 'tool' && c.name === 'read_file'),
    JSON.stringify(gateResolve),
  )

  /* ---------------------------------------------------------- */
  console.log('\nA2) e2e — bash blocked by the plugin gatekeeper')
  {
    let turn = 0
    const provider = fakeProvider(() => {
      turn++
      return turn === 1
        ? 'trying bash\n```tagent:action\n{"tool":"bash","input":{"command":"touch side-effect.txt"}}\n```'
        : 'blocked noted, finishing'
    })
    const session = mkSession(A_ROOT, 'a2')
    const events: AgentEvents = {}
    const loop = new AgentLoop({
      session, provider, model: 'fake', events,
      permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
      plugins: [gate as TagentPlugin],
    })
    const summary = await loop.run('do it')
    const rec = toolRecords(session).find((r) => r.tool === 'bash')
    ok('A2 loop finished complete', summary.finished === 'complete', JSON.stringify(summary))
    ok('A2 bash record exists', !!rec)
    ok('A2 record status "denied"', rec?.status === 'denied', rec?.status)
    ok('A2 output contains "Blocked by plugin: test block"', (rec?.output ?? '').includes('Blocked by plugin: test block'), rec?.output)
    ok('A2 output carries the alternative', (rec?.output ?? '').includes('Alternative: use read_file instead'), rec?.output)
    ok('A2 fed-back result contains "### bash (denied)"', fedResults(session).includes('### bash (denied)'), fedResults(session).slice(0, 200))
    ok('A2 side effect NOT created (gate ran before tool)', !fs.existsSync(path.join(A_ROOT, 'side-effect.txt')))
  }

  /* ---------------------------------------------------------- */
  console.log('\nA3) e2e — other tools (read_file) unaffected by the gate')
  {
    fs.writeFileSync(path.join(A_ROOT, 'a3.txt'), 'A3-CONTENT')
    let turn = 0
    const provider = fakeProvider(() => {
      turn++
      return turn === 1
        ? 'reading\n```tagent:action\n{"tool":"read_file","input":{"path":"a3.txt"}}\n```'
        : 'read ok, done'
    })
    const session = mkSession(A_ROOT, 'a3')
    const events: AgentEvents = {}
    const loop = new AgentLoop({
      session, provider, model: 'fake', events,
      permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
      plugins: [gate as TagentPlugin],
    })
    const summary = await loop.run('read it')
    const rec = toolRecords(session).find((r) => r.tool === 'read_file')
    ok('A3 loop finished complete', summary.finished === 'complete', JSON.stringify(summary))
    ok('A3 read_file status "done"', rec?.status === 'done', rec?.status)
    ok('A3 real content returned', (rec?.output ?? '').includes('A3-CONTENT'), rec?.output)
  }

  /* ---------------------------------------------------------- */
  console.log('\nA4) e2e — subagent inherits the gatekeeper')
  {
    const subs: { start: SessionData[]; end: SessionData[] } = { start: [], end: [] }
    let subSawBlock = false
    let parentTurn = 0
    let subTurn = 0
    const provider = fakeProvider((req) => {
      const system = req.messages[0]?.content ?? ''
      const lastUser = req.messages.filter((m) => m.role === 'user').pop()
      const fed = lastUser?.content ?? ''
      if (system.includes('Tagent subagent')) {
        subTurn++
        if (subTurn === 1) {
          return 'running ls\n```tagent:action\n{"tool":"bash","input":{"command":"ls"}}\n```'
        }
        if (fed.includes('Blocked by plugin: test block')) subSawBlock = true
        return 'SUBREPORT: the bash call was denied — "Blocked by plugin: test block"'
      }
      parentTurn++
      if (parentTurn === 1) {
        return 'delegating\n```tagent:action\n{"tool":"task","input":{"description":"run ls","prompt":"Run ls in this workspace and report what happens.","agent":"general"}}\n```'
      }
      return 'done — sub reported'
    })
    const session = mkSession(A_ROOT, 'a4')
    const events: AgentEvents = {}
    const loop = new AgentLoop({
      session, provider, model: 'fake', events,
      permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
      plugins: [gate as TagentPlugin],
      onSubagentSession: (sub, phase) => subs[phase].push(sub),
    })
    const summary = await loop.run('delegate this')
    const subSession = subs.start[0]
    ok('A4 loop finished complete', summary.finished === 'complete', JSON.stringify(summary))
    ok('A4 subagent session captured', !!subSession)
    const subBash = subSession ? toolRecords(subSession).find((r) => r.tool === 'bash') : undefined
    ok('A4 sub bash record denied by the inherited plugin', subBash?.status === 'denied' && (subBash?.output ?? '').includes('Blocked by plugin: test block'), JSON.stringify(subBash?.status))
    ok('A4 denial fed back into the sub conversation (provider saw it)', subSawBlock)
    ok('A4 sub session holds the blocked TOOL RESULTS', !!subSession && subSession.messages.some((m) => m.meta?.toolResults && m.content.includes('Blocked by plugin: test block')))
    const parentFed = fedResults(session)
    ok('A4 parent task result contains the block (via the report)', parentFed.includes('SUBAGENT REPORT') && parentFed.includes('Blocked by plugin: test block'), parentFed.slice(0, 200))
  }

  /* ---------------------------------------------------------- */
  console.log('\nA5) e2e — no plugins option → old behavior unchanged')
  {
    let turn = 0
    const provider = fakeProvider(() => {
      turn++
      return turn === 1
        ? 'writing\n```tagent:action\n{"tool":"bash","input":{"command":"echo hello-a5 > a5.txt"}}\n```'
        : 'done'
    })
    const session = mkSession(A_ROOT, 'a5')
    const events: AgentEvents = {}
    const loop = new AgentLoop({
      session, provider, model: 'fake', events,
      permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
    })
    const summary = await loop.run('go')
    const rec = toolRecords(session).find((r) => r.tool === 'bash')
    ok('A5 loop finished complete', summary.finished === 'complete', JSON.stringify(summary))
    ok('A5 bash status "done" (executed)', rec?.status === 'done', rec?.status)
    ok('A5 side effect created', fs.existsSync(path.join(A_ROOT, 'a5.txt')))
  }

  /* ---------------------------------------------------------- */
  console.log('\nA6) modify path (e2e) + emit-layer units')
  {
    const modifier = mk({
      beforeToolCall: async ({ tool }) =>
        tool === 'bash' ? { action: 'modify' as const, input: { command: 'echo modified > modified.txt' } } : undefined,
    })
    let turn = 0
    const provider = fakeProvider(() => {
      turn++
      return turn === 1
        ? 'writing\n```tagent:action\n{"tool":"bash","input":{"command":"echo original > modified.txt"}}\n```'
        : 'done'
    })
    const session = mkSession(A_ROOT, 'a6')
    const events: AgentEvents = {}
    const loop = new AgentLoop({
      session, provider, model: 'fake', events,
      permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
      plugins: [modifier],
    })
    const summary = await loop.run('go')
    const rec = toolRecords(session).find((r) => r.tool === 'bash')
    const recInput = (rec?.input ?? {}) as { command?: string }
    ok('A6 loop finished complete', summary.finished === 'complete', JSON.stringify(summary))
    ok('A6 record.input replaced with the modified command', recInput.command === 'echo modified > modified.txt', JSON.stringify(recInput))
    ok('A6 modified command actually ran', fs.existsSync(path.join(A_ROOT, 'modified.txt')) && fs.readFileSync(path.join(A_ROOT, 'modified.txt'), 'utf8').trim() === 'modified', fs.existsSync(path.join(A_ROOT, 'modified.txt')) ? fs.readFileSync(path.join(A_ROOT, 'modified.txt'), 'utf8') : 'missing')
    ok('A6 fed-back result shows the modified input', fedResults(session).includes('echo modified > modified.txt'), fedResults(session).slice(0, 200))

    // emit-layer units (mirror of scripts/smoke-plugin-hooks.ts, asserted)
    const uctx = { tool: 'bash', input: { command: 'ls' }, risk: 'high' as const, workspaceRoot: '/tmp', sessionId: 's1' }
    const blocker = mk({
      beforeToolCall: async () => ({ action: 'block' as const, reason: 'test block', alternative: 'do X instead' }),
    })
    const thrower = mk({ beforeToolCall: async () => { throw new Error('boom') } })
    const neutral = mk({})
    ok('A6 unit: block decision returned', JSON.stringify(await emitBeforeToolCall([blocker], uctx)) === JSON.stringify({ action: 'block', reason: 'test block', alternative: 'do X instead' }))
    ok('A6 unit: no plugins → allow', JSON.stringify(await emitBeforeToolCall([], uctx)) === '{"action":"allow"}')
    const threw = await captureConsole(async () => emitBeforeToolCall([thrower], uctx))
    ok('A6 unit: throwing hook → allow (fails open)', threw.result.action === 'allow')
    ok('A6 unit: throwing hook logged', threw.errors.some((e) => e.includes('beforeToolCall error')))
    ok('A6 unit: void-returning hook → allow', (await emitBeforeToolCall([neutral], uctx)).action === 'allow')
    ok('A6 unit: first block wins over a later modify', (await emitBeforeToolCall([blocker, modifier], uctx)).action === 'block')
    ok('A6 unit: modify alone rewrites the input', JSON.stringify(await emitBeforeToolCall([modifier], uctx)) === JSON.stringify({ action: 'modify', input: { command: 'echo modified > modified.txt' } }))

    const ra = mk({ onResolve: async () => ({ available: [{ type: 'tool' as const, name: 'read_file' }], hint: 'h1' }) })
    const rb = mk({ onResolve: async () => ({ available: [{ type: 'mcp' as const, name: 'mcp_x', reason: 'r' }], unavailable: [{ type: 'mcp', name: 'mcp_y', reason: 'off' }], hint: 'h2' }) })
    const merged = await emitOnResolve([ra, rb], { query: 'file', workspaceRoot: '/tmp', mode: 'build' })
    ok(
      'A6 unit: onResolve merge + first hint wins',
      JSON.stringify(merged) === JSON.stringify({ available: [{ type: 'tool', name: 'read_file' }, { type: 'mcp', name: 'mcp_x', reason: 'r' }], unavailable: [{ type: 'mcp', name: 'mcp_y', reason: 'off' }], hint: 'h1' }),
      JSON.stringify(merged),
    )
    ok('A6 unit: no resolver → null', await emitOnResolve([neutral], { query: 'x', workspaceRoot: '/tmp', mode: 'plan' }) === null)
    const rThrower = mk({ onResolve: async () => { throw new Error('boom') } })
    const merged2 = await emitOnResolve([rThrower, ra], { query: 'file', workspaceRoot: '/tmp', mode: 'build' })
    ok('A6 unit: throwing resolver skipped, other plugin answers', merged2 !== null && merged2.available.length === 1 && merged2.hint === 'h1', JSON.stringify(merged2))
  }

  /* ================= PART B — Taceen plugin template ================= */
  console.log('\nB1) real taceen — loadPlugins(repoRoot) + direct onResolve')
  {
    const b1 = await loadPlugins(REPO_ROOT)
    const taceen = b1.find((p) => p.name === 'taceen')
    ok('B1 taceen plugin loaded from the repo root', !!taceen && taceen.file.startsWith(REPO_ROOT), JSON.stringify(b1.map((p) => p.file)))
    const cap = await captureConsole(async () =>
      taceen?.hooks.onResolve?.({ query: 'read a file', workspaceRoot: REPO_ROOT, mode: 'build' }),
    )
    const r = typeof cap.result === 'object' && cap.result !== null ? cap.result : undefined
    ok('B1 onResolve answered', r !== undefined, JSON.stringify(cap.result))
    ok('B1 available contains {type:"tool",name:"read_file"}', r !== undefined && r.available.some((c) => c.type === 'tool' && c.name === 'read_file'), JSON.stringify(r?.available))
    ok('B1 [MOCK] marker logged', cap.logs.some((l) => l.includes('[MOCK] Taceen resolve: read a file')), cap.logs.join(' | '))
    ok('B1 hint mentions the heuristic resolver', (r?.hint ?? '').includes('[MOCK] heuristic resolver'), r?.hint)
  }

  /* ---------------------------------------------------------- */
  console.log('\nB2) e2e with the real taceen plugin — destructive vs benign bash')
  {
    const b1 = await loadPlugins(REPO_ROOT)
    const taceen = b1.find((p) => p.name === 'taceen')
    if (!taceen) {
      ok('B2 taceen loaded (prereq)', false)
    } else {
      const B2_ROOT = fs.mkdtempSync('/tmp/tagent-hooks-b2-')
      // side-effect sentinel: if the rm -rf ever ran, this dir disappears
      fs.mkdirSync('/tmp/tagent-taceen-test', { recursive: true })
      let turn = 0
      const provider = fakeProvider(() => {
        turn++
        if (turn === 1) return 'destructive\n```tagent:action\n{"tool":"bash","input":{"command":"rm -rf /tmp/tagent-taceen-test"}}\n```'
        if (turn === 2) return 'benign\n```tagent:action\n{"tool":"bash","input":{"command":"echo hello-taceen"}}\n```'
        return 'done'
      })
      const session = mkSession(B2_ROOT, 'b2')
      const events: AgentEvents = {}
      const loop = new AgentLoop({
        session, provider, model: 'fake', events,
        permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
        plugins: [taceen],
      })
      const summary = await loop.run('go')
      const recs = toolRecords(session).filter((r) => r.tool === 'bash')
      ok('B2 loop finished complete', summary.finished === 'complete', JSON.stringify(summary))
      ok('B2 destructive bash denied by the plugin (not the bash blocklist)', recs[0]?.status === 'denied', recs[0] ? `${recs[0].status}: ${recs[0].output}` : 'no record')
      ok('B2 denial reason mentions the [MOCK] destructive guard', (recs[0]?.output ?? '').includes('[MOCK] destructive command detected'), recs[0]?.output)
      ok('B2 /tmp/tagent-taceen-test still exists (rm -rf never ran)', fs.existsSync('/tmp/tagent-taceen-test'))
      ok('B2 benign bash allowed + executed', recs[1]?.status === 'done' && (recs[1]?.output ?? '').includes('hello-taceen'), recs[1] ? `${recs[1].status}: ${recs[1].output}` : 'no record')
      ok('B2 fed-back shows both outcomes', fedResults(session).includes('### bash (denied)') && fedResults(session).includes('### bash (done)'), fedResults(session).slice(0, 300))
    }
  }

  /* ---------------------------------------------------------- */
  console.log('\nB3) enabled:false — temp copy, hooks neutral')
  {
    const B3_ROOT = fs.mkdtempSync('/tmp/tagent-hooks-b3-')
    copyTaceen(B3_ROOT, { enabled: false, mode: 'mock', pythonPath: 'python3', taceenScript: '.tagent/taceen/taceen.py', timeoutMs: 1500 })
    const b3 = await loadPlugins(B3_ROOT)
    const t3 = b3.find((p) => p.file.startsWith(B3_ROOT))
    ok('B3 disabled taceen copy still loads (module loads, hooks go neutral)', !!t3, JSON.stringify(b3.map((p) => p.file)))
    if (t3) {
      const cap = await captureConsole(async () => ({
        resolve: await t3.hooks.onResolve?.({ query: 'read a file', workspaceRoot: B3_ROOT, mode: 'build' }),
        gate: await t3.hooks.beforeToolCall?.({ tool: 'bash', input: { command: 'rm -rf /tmp/never' }, risk: 'high' as const, workspaceRoot: B3_ROOT, sessionId: 'b3' }),
      }))
      ok('B3 onResolve returns undefined', cap.result.resolve === undefined, JSON.stringify(cap.result.resolve))
      ok('B3 beforeToolCall returns undefined (even for rm -rf)', cap.result.gate === undefined, JSON.stringify(cap.result.gate))
      ok('B3 no [MOCK] log', !cap.logs.some((l) => l.includes('[MOCK]')), cap.logs.join(' | '))

      // e2e: bash runs to completion with the disabled plugin attached
      let turn = 0
      const provider = fakeProvider(() => {
        turn++
        return turn === 1
          ? '```tagent:action\n{"tool":"bash","input":{"command":"echo b3-ok > b3.txt"}}\n```'
          : 'done'
      })
      const session = mkSession(B3_ROOT, 'b3e')
      const events: AgentEvents = {}
      const loop = new AgentLoop({
        session, provider, model: 'fake', events,
        permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
        plugins: [t3],
      })
      const summary = await loop.run('go')
      const rec = toolRecords(session).find((r) => r.tool === 'bash')
      ok('B3 e2e bash runs "done" with the disabled plugin', summary.finished === 'complete' && rec?.status === 'done', `${summary.finished}/${rec?.status}`)
      ok('B3 e2e side effect created', fs.existsSync(path.join(B3_ROOT, 'b3.txt')))
    }
  }

  /* ---------------------------------------------------------- */
  console.log('\nB4) subprocess mode — python bridge + manual + error path')
  {
    const B4_ROOT = fs.mkdtempSync('/tmp/tagent-hooks-b4-')
    copyTaceen(B4_ROOT, { enabled: true, mode: 'subprocess', pythonPath: 'python3', taceenScript: '.tagent/taceen/taceen.py', timeoutMs: 1500 })
    const b4 = await loadPlugins(B4_ROOT)
    const t4 = b4.find((p) => p.file.startsWith(B4_ROOT))
    ok('B4 subprocess taceen copy loads', !!t4, JSON.stringify(b4.map((p) => p.file)))
    if (t4) {
      const capResolve = await captureConsole(async () =>
        t4.hooks.onResolve?.({ query: 'read a file', workspaceRoot: B4_ROOT, mode: 'build' }),
      )
      const r4 = typeof capResolve.result === 'object' && capResolve.result !== null ? capResolve.result : undefined
      ok('B4 onResolve hint comes from python', r4 !== undefined && r4.hint === '[python-mock] resolve: read a file', JSON.stringify(capResolve.result))
      const capValidate = await captureConsole(async () =>
        t4.hooks.beforeToolCall?.({ tool: 'bash', input: { command: 'ls' }, risk: 'high' as const, workspaceRoot: B4_ROOT, sessionId: 'b4' }),
      )
      const v4 = typeof capValidate.result === 'object' && capValidate.result !== null ? capValidate.result : undefined
      ok('B4 beforeToolCall validate → {action:"allow"} from python', v4 !== undefined && v4.action === 'allow', JSON.stringify(capValidate.result))

      // manual: the exact spec command against the COPIED python skeleton
      const py = spawnSync('python3', [path.join(B4_ROOT, '.tagent', 'taceen', 'taceen.py')], {
        input: JSON.stringify({ intent: 'validate', tool: 'bash', input: { command: 'ls' } }) + '\n',
        encoding: 'utf8',
        timeout: 10_000,
      })
      ok('B4 manual taceen.py validate → {"action": "allow"}', (py.stdout ?? '').trim() === '{"action": "allow"}', `stdout=${py.stdout} stderr=${py.stderr}`)

      // error path: taceenScript pointing at a nonexistent file → allow + logged
      const B4B_ROOT = fs.mkdtempSync('/tmp/tagent-hooks-b4b-')
      copyTaceen(B4B_ROOT, { enabled: true, mode: 'subprocess', pythonPath: 'python3', taceenScript: '.tagent/taceen/no-such.py', timeoutMs: 1500 })
      const b4b = await loadPlugins(B4B_ROOT)
      const t4b = b4b.find((p) => p.file.startsWith(B4B_ROOT))
      ok('B4 error-path copy loads', !!t4b, JSON.stringify(b4b.map((p) => p.file)))
      if (t4b) {
        const capErr = await captureConsole(async () =>
          t4b.hooks.onResolve?.({ query: 'read a file', workspaceRoot: B4B_ROOT, mode: 'build' }),
        )
        ok('B4 error path: hook returns undefined (allow)', capErr.result === undefined, JSON.stringify(capErr.result))
        ok('B4 error path: console.error mentions the failure', capErr.errors.some((e) => e.includes('[taceen]') && (e.includes('falling back to allow') || e.includes('failed to start'))), capErr.errors.join(' | '))
      }
    }
  }

  console.log('\n' + '='.repeat(50))
  console.log(`RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
  .catch((e) => {
    console.error('FATAL', e)
    process.exit(1)
  })
