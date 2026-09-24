/**
 * test-async-subs.ts — hermetic tests for the background-subagent stack +
 * the 3-lane fallback config:
 *   1. BackgroundSubagents registry — ids a1/a2…, parallel limit, finish
 *   2. task {background:true} — returns immediately with the id
 *   3. mid-run delivery — the report lands as [SUBAGENT REPORT] in the SAME run
 *   4. late delivery — sub finishes AFTER the run: onBackgroundSub fires,
 *      the dead loop refuses injections (host wakes a fresh run instead)
 *   5. the subs tool — listing + one full report
 *   6. fallback lanes — fallbackListFor / fallbackTailFor / describeChains
 *   7. vision failover — primary fails → fallbacks.vision entry answers
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  AgentLoop,
  PermissionManager,
  defaultConfig,
  BackgroundSubagents,
  fallbackListFor,
  fallbackTailFor,
  describeChains,
  type ProviderAdapter,
  type CompletionRequest,
  type TagentConfig,
  type BgSubInfo,
} from '../packages/core/src/index'
import { subsTool } from '../packages/core/src/tools/subs'
import { visionTool, visionInternals } from '../packages/core/src/tools/vision'
import { completeWithFallback } from '../packages/core/src/fallback'
import type { AgentEvents, SessionData } from '../packages/core/src/types'

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

const root = fs.mkdtempSync('/tmp/tagent-async-')
const cfg: TagentConfig = {
  ...defaultConfig(),
  permissions: { defaultMode: 'allow', tools: {} },
  tools: { bash: true, browser: true, serve: true },
}

function fakeProvider(script: (req: CompletionRequest) => Promise<string> | string): ProviderAdapter {
  return {
    id: 'fake', label: 'fake', supportsNativeTools: false, models: [],
    complete: async () => ({ text: '' }),
    completeStream: async (req) => ({ text: await script(req) }),
  }
}

async function main() {
  /* --------------------------------------------------------------- */
  console.log('1) registry — ids, limit, finish')
  {
    const reg = new BackgroundSubagents(() => 2)
    const a = reg.register('scan codebase', 'general')
    const b = reg.register('draft docs', 'general')
    const c = reg.register('third job', 'general')
    ok('ids sequential a1/a2', 'id' in a && a.id === 'a1' && 'id' in b && b.id === 'a2')
    ok('parallel limit enforced (2/2)', 'error' in c && c.error.includes('parallel limit'), JSON.stringify(c))
    ok('running count 2', reg.runningCount === 2)
    const done = reg.finish('a1', 'done', 'SCAN REPORT: found 12 files')
    ok('finish returns stored entry', done?.status === 'done' && done?.report === 'SCAN REPORT: found 12 files')
    ok('running drops to 1', reg.runningCount === 1)
    const d = reg.register('slot freed', 'explore')
    ok('slot freed after finish', 'id' in d && d.id === 'a3')
    const lst = reg.list()
    ok('list carries statuses', lst.some((s) => s.id === 'a1' && s.status === 'done') && lst.some((s) => s.id === 'a3' && s.status === 'running'))
    reg.finish('a2', 'error', 'Error: boom')
    reg.finish('a3', 'done', 'ok')
    ok('error status stored', reg.get('a2')?.status === 'error')
    // default limit
    const reg2 = new BackgroundSubagents(() => undefined as unknown as number)
    ok('missing config → default limit 4', reg2.limit === 4)
  }

  /* --------------------------------------------------------------- */
  console.log('\n2-3) task background:true — immediate id, mid-run report delivery')
  {
    const reg = new BackgroundSubagents(() => 4)
    const events: AgentEvents = {}
    let releaseSub!: () => void
    const subGate = new Promise<void>((r) => { releaseSub = r })
    let subFinished!: () => void
    const subFinishedP = new Promise<void>((r) => { subFinished = r })
    const delivered: BgSubInfo[] = []

    let pTurn = 0
    let lastUserSeen = ''
    let loop!: AgentLoop
    const provider = fakeProvider(async (req) => {
      const system = String((req.messages[0] as { content?: unknown })?.content ?? '')
      if (system.includes('Tagent subagent')) {
        await subGate // the sub "works" until released
        return 'SUBREPORT: the scan found 12 files and 2 todos'
      }
      pTurn++
      lastUserSeen = req.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n---\n')
      if (pTurn === 1) {
        return 'spawning\n```tagent:action\n{"tool":"task","input":{"description":"scan codebase","prompt":"Scan the workspace structure broadly and report.","agent":"general","background":true}}\n```'
      }
      if (pTurn === 2) {
        ok('spawn returned IMMEDIATELY (no report in tool result)', lastUserSeen.includes('BACKGROUND SUBAGENT STARTED') && !lastUserSeen.includes('SUBREPORT'), lastUserSeen.slice(0, 300))
        ok('the id a1 is in the tool result', lastUserSeen.includes('a1'))
        return 'checking status\n```tagent:action\n{"tool":"subs","input":{}}\n```'
      }
      if (pTurn === 3) {
        ok('subs tool listed a1 as running', lastUserSeen.includes('a1') && lastUserSeen.includes('running'), lastUserSeen.slice(0, 400))
        // release the sub now; its report should be injected before turn 4
        releaseSub()
        await subFinishedP
        return 'keep working\n```tagent:action\n{"tool":"read_file","input":{"path":"notes.md"}}\n```'
      }
      if (pTurn === 4) {
        return 'done — report digested'
      }
      return 'done — report digested'
    })

    fs.writeFileSync(path.join(root, 'notes.md'), 'x')
    const session: SessionData = {
      id: 'p1', workspaceId: root, title: 't', model: 'fake', mode: 'build',
      createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
    }
    loop = new AgentLoop({
      session, provider, model: 'fake', events,
      permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
      backgroundSubs: reg,
      onBackgroundSub: (info) => {
        delivered.push(info)
        subFinished()
        // host behavior: inject into the live loop
        loop.deliverBackgroundReport(
          `[SUBAGENT REPORT — ${info.id} · "${info.description}" · ${info.status}]\n\n${info.report}\n\nContinue — no user confirmation needed.`,
        )
      },
    })
    const summary = await loop.run('delegate in background please')
    ok('run completed', summary.finished === 'complete', JSON.stringify(summary))
    ok('the parent kept working across 4+ turns (never blocked)', pTurn >= 4, `turns=${pTurn}`)
    ok('turn-4 model call SAW the injected report', lastUserSeen.includes('[SUBAGENT REPORT — a1'), lastUserSeen.slice(0, 200))
    ok('the report text reached the model', lastUserSeen.includes('SUBREPORT: the scan found 12 files'))
    ok('session carries the report message', session.messages.some((m) => m.role === 'user' && m.content.includes('[SUBAGENT REPORT — a1')))
    ok('onBackgroundSub fired once with the report', delivered.length === 1 && delivered[0]?.id === 'a1' && delivered[0]?.status === 'done')
    ok('registry entry done + report stored', reg.get('a1')?.status === 'done' && reg.get('a1')?.report?.includes('12 files'))
    ok('loop is dead after run (alive=false)', loop.alive === false)
    ok('dead loop refuses injections', loop.deliverBackgroundReport('late') === false)
  }

  /* --------------------------------------------------------------- */
  console.log('\n4) late delivery — sub outlives the run')
  {
    const reg = new BackgroundSubagents(() => 4)
    const events: AgentEvents = {}
    let releaseSub!: () => void
    const subGate = new Promise<void>((r) => { releaseSub = r })
    let subFinished!: () => void
    const subFinishedP = new Promise<void>((r) => { subFinished = r })
    const fired: BgSubInfo[] = []

    let pTurn = 0
    const provider = fakeProvider(async (req) => {
      const system = String((req.messages[0] as { content?: unknown })?.content ?? '')
      if (system.includes('Tagent subagent')) {
        await subGate
        return 'LATE REPORT: job done'
      }
      pTurn++
      if (pTurn === 1) {
        return '```tagent:action\n{"tool":"task","input":{"description":"long job","prompt":"Do a long deep scan of everything and report.","agent":"general","background":true}}\n```'
      }
      return 'done for now — the sub reports later'
    })
    const session: SessionData = {
      id: 'p2', workspaceId: root, title: 't2', model: 'fake', mode: 'build',
      createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
    }
    const loop = new AgentLoop({
      session, provider, model: 'fake', events,
      permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
      backgroundSubs: reg,
      onBackgroundSub: (info) => {
        fired.push(info)
        subFinished()
        // host: loop dead → wake path (here we just record the refusal)
        loop.deliverBackgroundReport('x')
      },
    })
    const summary = await loop.run('kick off and finish')
    ok('parent finished BEFORE the sub (2 turns)', summary.finished === 'complete' && pTurn === 2)
    releaseSub()
    await subFinishedP
    ok('sub finished after the run → onBackgroundSub still fired', fired.length === 1 && fired[0]?.status === 'done' && fired[0]?.report?.includes('LATE REPORT'))
    ok('registry kept the late report (host /subs can show it)', reg.get('a1')?.report?.includes('LATE REPORT') === true)
  }

  /* --------------------------------------------------------------- */
  console.log('\n5) subs tool — listing + full report')
  {
    const reg = new BackgroundSubagents(() => 4)
    const a = reg.register('scan codebase', 'general')
    reg.finish(a.id, 'done', 'SUBREPORT line one\nline two with detail')
    reg.register('still running job', 'test')
    const ctx = {
      workspaceRoot: root, sessionId: 's1', depth: 0, config: cfg,
      events: {}, todos: [], backgroundSubs: reg,
    }
    const listing = await subsTool.run({}, ctx as never)
    ok('listing shows both subs', listing.includes('a1') && listing.includes('running') && listing.includes('still running job'))
    const one = await subsTool.run({ id: 'a1' }, ctx as never)
    ok('one(id) shows the full report', one.includes('SUBREPORT line one') && one.includes('line two with detail'))
    const none = await subsTool.run({ id: 'zz' }, ctx as never)
    ok('unknown id → helpful error', none.includes('No background subagent'))
  }

  /* --------------------------------------------------------------- */
  console.log('\n6) fallback lanes — listFor / tailFor / describeChains')
  {
    const fcfg: TagentConfig = {
      ...cfg,
      fallback: [{ provider: 'zai', model: 'glm-4.6', enabled: true }],
      fallbacks: {
        subagent: [{ provider: 'zai', model: 'glm-4.5-air', enabled: true }],
        vision: [{ provider: 'zai', model: 'glm-4.6', enabled: false }],
      },
    }
    ok('main mirrors the legacy list', fallbackListFor(fcfg, 'main').length === 1 && fallbackListFor(fcfg, 'main')[0]?.model === 'glm-4.6')
    ok('subagent lane is separate', fallbackListFor(fcfg, 'subagent')[0]?.model === 'glm-4.5-air')
    ok('vision lane is separate', fallbackListFor(fcfg, 'vision')[0]?.enabled === false)
    const subTail = fallbackTailFor(fcfg, 'subagent')
    ok('tail resolves subagent lane (1 entry)', subTail.length === 1 && subTail[0]?.model === 'glm-4.5-air')
    ok('disabled entries are skipped', fallbackTailFor(fcfg, 'vision').length === 0)
    ok('main tail from legacy', fallbackTailFor(fcfg, 'main').length === 1)
    const chains = describeChains(fcfg)
    ok('describeChains: 3 lanes', !!chains.main?.length && !!chains.subagent?.length && !!chains.vision?.length)
    ok('lane primaries present', chains.main[0]?.primary === true && chains.subagent[0]?.primary === true)
    // with role overrides the lane primary reflects them
    const rcfg: TagentConfig = { ...fcfg, models: { subagent: 'zai/glm-4.5-air', media: { vision: 'zai/glm-4.6' } } }
    const rchains = describeChains(rcfg)
    ok('subagent lane primary = the role override', rchains.subagent[0]?.model === 'glm-4.5-air')
    ok('vision lane primary = the role override', rchains.vision[0]?.model === 'glm-4.6')
  }

  /* --------------------------------------------------------------- */
  console.log('\n7) vision failover — fallbacks.vision answers when the primary dies')
  {
    // restore seams after
    const origAdapter = visionInternals.resolveAdapter
    const origTail = visionInternals.resolveTailFor
    const shots = path.join(root, '.tagent', 'test', 'shots')
    fs.mkdirSync(shots, { recursive: true })
    fs.writeFileSync(path.join(shots, 'shot-x.png'), Buffer.from('89504e470d0a1a0a', 'hex'))

    let called: string[] = []
    const failAdapter = {
      id: 'failprov', label: 'fp', supportsNativeTools: false, models: [],
      complete: async () => ({ text: '' }),
      completeStream: async () => { throw new Error('primary down') },
    } as unknown as ProviderAdapter
    const backupAdapter = {
      id: 'backupprov', label: 'bp', supportsNativeTools: false, models: [],
      complete: async () => ({ text: '' }),
      completeStream: async (req: CompletionRequest) => {
        called.push(String(req.model))
        return { text: 'BACKUP VISION: layout ok, typography weak at 11px' }
      },
    } as unknown as ProviderAdapter

    visionInternals.resolveAdapter = () => failAdapter
    visionInternals.resolveTailFor = () => [{ adapter: backupAdapter, model: 'vision-backup-x', label: 'backup lane' }]

    const vcfg: TagentConfig = { ...cfg, models: { media: { vision: 'failprov/vision-x' } } }
    const ctx = {
      workspaceRoot: root, sessionId: 's2', depth: 0, config: vcfg,
      events: {}, todos: [],
    }
    const out = await visionTool.run({ images: shots }, ctx as never)
    ok('failover produced a report', out.startsWith('VISION REPORT'), out.slice(0, 120))
    ok('the backup lane answered', called.length === 1 && called[0] === 'vision-backup-x', JSON.stringify(called))
    ok('the report text flows', out.includes('BACKUP VISION'))
    visionInternals.resolveAdapter = origAdapter
    visionInternals.resolveTailFor = origTail
    void completeWithFallback // keep the import referenced
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
