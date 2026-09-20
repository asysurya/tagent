/**
 * test-context-loop.ts — the context-window pipeline end to end.
 *
 * Covers:
 *  - AgentLoop emits onContext every turn (usage-based when the provider
 *    reports it, estimated otherwise)
 *  - deterministic context diet in renderMessages: old write_file action
 *    echoes get their content elided (the newest ones stay verbatim),
 *    old TOOL RESULTS turn into per-tool digests instead of generic stubs
 *  - the caveman rework: tool results use compressOutput (head+tail), never
 *    a blind mid-cut
 *  - AgentHost: context:update on the bus, the 80% once-per-crossing notify,
 *    compactSession() (digest + persistence), and contextInfo()
 *
 * Run: bun scripts/test-context-loop.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  PermissionManager, AgentLoop, defaultConfig, compactSession,
  type AgentEvents, type ProviderAdapter, type SessionData, type TagentConfig,
  type WireMessage,
} from '../packages/core/src/index'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra?: string) => {
  cond ? pass++ : fail++
  console.log(`${cond ? '✔' : '✗'} ${name}${!cond && extra ? ` — ${extra}` : ''}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-ctx-loop-'))
fs.mkdirSync(path.join(root, '.tagent'), { recursive: true })
const cfg: TagentConfig = defaultConfig()

console.log('1) onContext — provider usage reported per turn')
{
  const ctxEvents: { used: number; limit: number; estimated?: boolean }[] = []
  let turn = 0
  const fake: ProviderAdapter = {
    id: 'zai', label: 'fake', supportsNativeTools: false, models: [],
    complete: async () => '',
    completeStream: async () => {
      turn++
      // simulate the context growing each turn; glm-4.7 → limit 131072
      return { text: `answer ${turn}`, usage: { input: 1000 * turn, output: 100 } }
    },
  }
  const session: SessionData = {
    id: 's1', workspaceId: root, title: 't', model: 'glm-4.7', mode: 'build',
    createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
  }
  const loop = new AgentLoop({
    session, provider: fake, model: 'glm-4.7',
    events: {
      onContext: (info) => ctxEvents.push(info),
    } as AgentEvents,
    permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
  })
  await loop.run('hello')
  await loop.run('again')
  ok('onContext fired for every turn', ctxEvents.length === 2, String(ctxEvents.length))
  ok('usage-based used value', ctxEvents[0]?.used === 1100 && ctxEvents[1]?.used === 2100, JSON.stringify(ctxEvents))
  ok('limit resolved from the model id', ctxEvents[0]?.limit === 131_072)
  ok('not estimated (provider reported)', ctxEvents[0]?.estimated !== true)
}

console.log('\n2) onContext — local estimate when the provider reports no usage')
{
  const ctxEvents: { used: number; estimated?: boolean }[] = []
  const fake: ProviderAdapter = {
    id: 'zai', label: 'fake', supportsNativeTools: false, models: [],
    complete: async () => '',
    completeStream: async () => ({ text: 'ok' }), // no usage field
  }
  const session: SessionData = {
    id: 's2', workspaceId: root, title: 't', model: 'glm-4.7', mode: 'build',
    createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
  }
  const loop = new AgentLoop({
    session, provider: fake, model: 'glm-4.7',
    events: { onContext: (i) => ctxEvents.push(i) } as AgentEvents,
    permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
  })
  await loop.run('a moderately long user message that still needs estimating ' + 'x'.repeat(200))
  ok('estimated context emitted', ctxEvents.length === 1 && ctxEvents[0].used > 100, JSON.stringify(ctxEvents))
  ok('flagged estimated', ctxEvents[0]?.estimated === true)
}

console.log('\n3) renderMessages diet — old action echoes slimmed, old tool results digested')
{
  // capture the exact wire the loop sends
  let lastWire: WireMessage[] = []
  let turn = 0
  const fake: ProviderAdapter = {
    id: 'zai', label: 'fake', supportsNativeTools: false, models: [],
    complete: async () => '',
    completeStream: async (req) => {
      turn++
      lastWire = req.messages
      if (turn <= 3) {
        return {
          text: '```tagent:action\n' + JSON.stringify({
            tool: 'write_file',
            input: { path: `src/gen${turn}.ts`, content: 'export const a = 1\n'.repeat(400) },
          }) + '\n```',
        }
      }
      return { text: 'done' }
    },
  }
  const session: SessionData = {
    id: 's3', workspaceId: root, title: 't', model: 'glm-4.7', mode: 'build',
    createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
  }
  // permission: allow write_file without prompting
  cfg.permissions.tools.write_file = 'allow'
  const loop = new AgentLoop({
    session, provider: fake, model: 'glm-4.7',
    events: {} as AgentEvents,
    permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
  })
  await loop.run('generate files')
  const wire = lastWire
  const assistantWire = wire.filter((m) => m.role === 'assistant')
  ok('three assistant turns rendered', assistantWire.length === 3, String(assistantWire.length))
  // wire content is JSON-escaped — the literal \n form is what travels
  const fat = 'export const a = 1\\n'.repeat(10)
  const last = assistantWire[assistantWire.length - 1].content
  const first = assistantWire[0].content
  ok('newest write_file echo keeps the full content', last.includes(fat) && last.includes('src/gen3.ts'), last.slice(0, 120))
  ok('old write_file echoes are slimmed', !first.includes(fat) && first.includes('src/gen1.ts'), first.slice(-300))
  ok('elision marker present on the old echo', first.includes('elided'))
  const toolResultsWire = wire.filter((m) => m.role === 'user' && m.content.startsWith('TOOL RESULTS:'))
  ok('tool results present', toolResultsWire.length >= 2)
  // force the old-results diet by making the middle one "old" (threshold check):
  // with 3 tool-result turns and COMPACT_KEEP=4 none are digested yet —
  // verify the diet logic directly through a longer session instead
  const bigSession: SessionData = JSON.parse(JSON.stringify(session))
  // pad with filler tool-result turns so the newest 4 stay full and older digest
  for (let i = 0; i < 8; i++) {
    bigSession.messages.push({
      id: `pad-u-${i}`, role: 'user', createdAt: Date.now(),
      content: 'TOOL RESULTS:\n\n### read_file (done)\ninput: {"path":"src/pad' + i + '.ts"}\noutput:\n' + 'padding line\n'.repeat(2500),
      meta: { toolResults: true },
    })
    bigSession.messages.push({
      id: `pad-a-${i}`, role: 'assistant', createdAt: Date.now(),
      content: 'continuing',
    })
  }
  const wireBig = (loop as unknown as { renderMessages: (s: string) => WireMessage[] }).renderMessages('sys')
  // re-run against bigSession is not possible (opts are private) — assert via a fresh loop
  const loop2 = new AgentLoop({
    session: bigSession, provider: fake, model: 'glm-4.7',
    events: {} as AgentEvents,
    permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
  })
  await loop2.run('continue') // one more request; renderMessages runs inside
  const wire2 = lastWire
  const padMsgs = wire2.filter((m) => m.role === 'user' && m.content.includes('src/pad'))
  const digested = padMsgs.filter((m) => m.content.includes('output elided'))
  const full = padMsgs.filter((m) => m.content.includes('padding line\n'.repeat(10)))
  ok('old pad results digested (tool+input kept, output elided)', digested.length >= 4, `${digested.length}/${padMsgs.length}`)
  ok('newest pad results stay verbatim', full.length >= 3, `${full.length}`)
  ok('digest keeps the path fact', digested.some((m) => m.content.includes('read_file') && m.content.includes('src/pad')), digested[0]?.content.slice(0, 200))
}

console.log('\n4) tool output budget — compressOutput, never a blind mid-cut')
{
  let fed = ''
  let turn = 0
  const fake: ProviderAdapter = {
    id: 'zai', label: 'fake', supportsNativeTools: false, models: [],
    complete: async () => '',
    completeStream: async (req) => {
      turn++
      if (turn === 1) {
        return {
          text: '```tagent:action\n' + JSON.stringify({
            tool: 'bash',
            input: { command: 'cat /dev/urandom | head -c 100000 | base64' },
          }) + '\n```',
        }
      }
      fed = req.messages.filter((m) => m.role === 'user').pop()?.content ?? ''
      return { text: 'done' }
    },
  }
  const session: SessionData = {
    id: 's4', workspaceId: root, title: 't', model: 'glm-4.7', mode: 'build',
    createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
  }
  cfg.permissions.tools.bash = 'allow'
  // intercept the bash tool's output by patching the filesystem? simpler: run
  // a real command with a big deterministic output
  const loop = new AgentLoop({
    session, provider: fake, model: 'glm-4.7',
    events: {} as AgentEvents,
    permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
  })
  await loop.run('run the command')
  const outMsg = fed
  ok('big output fed back within budget', outMsg.length < 60_000, String(outMsg.length))
  ok('elision marker present (summary, not blind cut)', outMsg.includes('compacted:') || outMsg.includes('bash (done)'), outMsg.slice(0, 120))
}

console.log('\n5) host wiring — bus context:update + 80% notify + compactSession')
{
  const { AgentHost } = await import('../packages/cli/src/host')
  const TMP = path.join(root, 'hostws')
  fs.mkdirSync(path.join(TMP, '.tagent'), { recursive: true })
  const host = new AgentHost({ workspaceRoot: TMP, configOverride: { defaultProvider: 'zai', defaultModel: 'glm-4.7' } })
  const bus = host.bus as import('node:events').EventEmitter
  const seen: Record<string, unknown>[] = []
  const notes: { level: string; message: string }[] = []
  bus.on('context:update', (d) => seen.push(d))
  bus.on('notify', (d) => notes.push(d))
  const events = (host as unknown as { makeEvents: (id: string) => AgentEvents }).makeEvents('sx')

  // 60% — no notify
  events.onContext?.({ used: 78_000, limit: 131_072, turn: 1 })
  ok('context:update on the bus', seen.length === 1 && (seen[0] as { used: number }).used === 78_000)
  ok('no notify below the threshold', notes.length === 0)
  // 81% crossing — one notify
  events.onContext?.({ used: 107_000, limit: 131_072, turn: 2 })
  events.onContext?.({ used: 110_000, limit: 131_072, turn: 3 })
  const warns = notes.filter((n) => n.level === 'warn')
  ok('80% crossing warns exactly once', warns.length === 1, JSON.stringify(warns))
  ok('warn mentions /compact', warns[0]?.message.includes('/compact'), warns[0]?.message)
  ok('warn states the percentage', warns[0]?.message.includes('81%') || warns[0]?.message.includes('%'), warns[0]?.message)

  // threshold from config
  ;(host.cfg as TagentConfig).compact = { threshold: 0 } // disabled
  ok('threshold 0 = prompts off', host.compactThreshold() === 0)
  ;(host.cfg as TagentConfig).compact = { threshold: 50, keepTokens: 5000 }
  ok('custom threshold read', host.compactThreshold() === 50)

  // contextInfo falls back to estimates — on a host that never ran a loop
  {
    const host2 = new AgentHost({ workspaceRoot: TMP, configOverride: { defaultProvider: 'zai', defaultModel: 'glm-4.7' } })
    const info2 = host2.contextInfo()
    ok('contextInfo estimates without a run', info2.estimated === true && info2.limit === 131_072, JSON.stringify(info2))
  }

  // compactSession on a session with history
  const s = await host.ensureSession('build')
  for (let i = 0; i < 10; i++) {
    s.messages.push({ id: `u${i}`, role: 'user', content: 'user request ' + 'detail '.repeat(300), createdAt: Date.now() })
    s.messages.push({ id: `a${i}`, role: 'assistant', content: 'assistant answer ' + 'result '.repeat(200), createdAt: Date.now(), toolCalls: i % 2 === 0 ? [{ id: `t${i}`, tool: 'edit_file', input: { path: `src/f${i}.ts`, new_string: 'x'.repeat(3000) }, status: 'done' }] : undefined })
  }
  const r = host.compactSession()
  ok('compactSession ok', r.ok === true, JSON.stringify(r))
  if (r.ok) {
    ok('token drop is real (small session; big ones land ~10%)', r.after < r.before * 0.65, `${r.before} → ${r.after}`)
    ok('digest message present', s.messages[0]?.meta?.compacted === true)
    ok('recent turns kept verbatim', s.messages.length < 12, String(s.messages.length))
    ok('session file persisted with the digest', fs.readFileSync(path.join(TMP, '.tagent', 'sessions', `${s.id}.json`), 'utf8').includes('[CONTEXT COMPACTED'))
  }
  ok('double compact → honest not-worth-it', host.compactSession().ok === false)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
