/**
 * test-switch-mode.ts — hermetic tests for the user-approved mode switch
 * (switch_mode tool + mid-run persona/toolset rebuild) and the system
 * prompt rework (identity / language / work loop / hard rules / summary):
 *   1. toolset composition — switch_mode in every mode at depth 0,
 *      never at depth > 0
 *   2. approve path — build → test: permission request shape, session
 *      mode flip, turn-2 system prompt carries the TEST persona + QA
 *      toolset (and write tools gone)
 *   3. deny path — nothing flips, turn-2 prompt stays BUILD
 *   4. loop.switchMode guards — same-mode / subagent errors
 *   5. system prompt rework — new sections present for the main agent,
 *      absent for subagents + caveman, protected strings intact
 */
import fs from 'node:fs'
import {
  AgentLoop,
  PermissionManager,
  defaultConfig,
  buildToolset,
  isReadOnlyTool,
  type ProviderAdapter,
  type CompletionRequest,
  type TagentConfig,
} from '../packages/core/src/index'
import { buildSystemPrompt } from '../packages/core/src/system-prompt'
import type { AgentEvents, AgentMode, PermissionRequest, SessionData } from '../packages/core/src/types'

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

const root = fs.mkdtempSync('/tmp/tagent-switch-')
const cfg: TagentConfig = {
  ...defaultConfig(),
  permissions: { defaultMode: 'ask', tools: {} },
  tools: { bash: true, browser: true, serve: true },
}

function fakeProvider(script: (req: CompletionRequest) => Promise<string> | string): ProviderAdapter {
  return {
    id: 'fake', label: 'fake', supportsNativeTools: false, models: [],
    complete: async () => ({ text: '' }),
    completeStream: async (req) => ({ text: await script(req) }),
  }
}

function mkSession(mode: AgentMode): SessionData {
  return {
    id: 's-' + Math.random().toString(36).slice(2, 8), workspaceId: root, title: 't',
    model: 'fake', mode, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0,
    messages: [], todos: [],
  }
}

async function main() {
  /* --------------------------------------------------------------- */
  console.log('1) toolset — switch_mode registration')
  {
    for (const mode of ['build', 'plan', 'test'] as AgentMode[]) {
      const tools = buildToolset({ config: cfg, mode })
      ok(`${mode}: switch_mode present at depth 0`, tools.some((t) => t.name === 'switch_mode'))
      const sub = buildToolset({ config: cfg, mode, depth: 1 })
      ok(`${mode}: switch_mode NOT present for subagents`, !sub.some((t) => t.name === 'switch_mode'))
    }
    ok('switch_mode counts as read-only (plan gate lets it through)', isReadOnlyTool('switch_mode'))
  }

  /* --------------------------------------------------------------- */
  console.log('\n2) approve path — build → test mid-run')
  {
    const session = mkSession('build')
    const perms: PermissionRequest[] = []
    const modeEvents: AgentMode[] = []
    const notes: string[] = []
    const events: AgentEvents = {
      onPermission: async (req) => {
        perms.push(req)
        return { approved: true }
      },
      onModeChange: (m) => modeEvents.push(m),
      onNotify: (_lvl, msg) => notes.push(msg),
    }
    let turn = 0
    let lastUserSeen = ''
    let lastSystem = ''
    const provider = fakeProvider((req) => {
      const system = String((req.messages[0] as { content?: unknown })?.content ?? '')
      if (system.includes('Tagent subagent')) return 'sub report'
      turn++
      lastSystem = system
      lastUserSeen = req.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n---\n')
      if (turn === 1) {
        return 'built it — now verify\n```tagent:action\n{"tool":"switch_mode","input":{"mode":"test","reason":"implementation done, running the QA pass"}}\n```'
      }
      return 'verifying under the QA persona now'
    })
    const loop = new AgentLoop({ session, provider, model: 'fake', events, permissions: new PermissionManager(cfg), config: cfg, mode: 'build' })
    const summary = await loop.run('build then test it')

    ok('run completed', summary.finished === 'complete', JSON.stringify(summary))
    ok('permission asked exactly once', perms.length === 1)
    ok('request: tool switch_mode, risk medium', perms[0]?.tool === 'switch_mode' && perms[0]?.risk === 'medium')
    ok('request carries the target mode + reason', (perms[0]?.input as { mode?: string })?.mode === 'test' && String((perms[0]?.input as { reason?: string })?.reason ?? '').includes('QA pass'))
    ok('tool result confirmed the switch', lastUserSeen.includes('MODE SWITCHED') && lastUserSeen.includes('TEST'), lastUserSeen.slice(0, 200))
    ok('session.mode flipped to test', session.mode === 'test')
    ok('onModeChange fired with test', modeEvents.length === 1 && modeEvents[0] === 'test')
    ok('notify mentioned the switch', notes.some((n) => n.includes('mode switched to test')))
    ok('turn-2 system prompt = TEST persona', lastSystem.includes('Mode: TEST') && !lastSystem.includes('Mode: BUILD'))
    ok('turn-2 toolset gained the QA deliverable', lastSystem.includes('### test_report'))
    ok('turn-2 toolset dropped write_file', !lastSystem.includes('### write_file'))
    ok('turn-2 still offers switch_mode', lastSystem.includes('### switch_mode'))
    ok('toolset object itself was swapped', loop.tools.some((t) => t.name === 'test_report') && !loop.tools.some((t) => t.name === 'write_file'))
  }

  /* --------------------------------------------------------------- */
  console.log('\n3) deny path — nothing flips')
  {
    const session = mkSession('build')
    const modeEvents: AgentMode[] = []
    const events: AgentEvents = {
      onPermission: async () => ({ approved: false }),
      onModeChange: (m) => modeEvents.push(m),
    }
    let turn = 0
    let lastUserSeen = ''
    let lastSystem = ''
    const provider = fakeProvider((req) => {
      const system = String((req.messages[0] as { content?: unknown })?.content ?? '')
      if (system.includes('Tagent subagent')) return 'sub report'
      turn++
      lastSystem = system
      lastUserSeen = req.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n---\n')
      if (turn === 1) {
        return '```tagent:action\n{"tool":"switch_mode","input":{"mode":"plan","reason":"want to re-plan"}}\n```'
      }
      return 'staying in build then'
    })
    const loop = new AgentLoop({ session, provider, model: 'fake', events, permissions: new PermissionManager(cfg), config: cfg, mode: 'build' })
    await loop.run('try switching')
    ok('denial fed back to the model', lastUserSeen.includes('Permission denied'))
    ok('session.mode stays build', session.mode === 'build')
    ok('onModeChange never fired', modeEvents.length === 0)
    ok('turn-2 system stays BUILD persona', lastSystem.includes('Mode: BUILD'))
    ok('turn-2 toolset keeps write_file', lastSystem.includes('### write_file'))
  }

  /* --------------------------------------------------------------- */
  console.log('\n4) loop.switchMode guards')
  {
    const session = mkSession('build')
    const events: AgentEvents = {}
    const provider = fakeProvider(() => 'ok')
    const loop = new AgentLoop({ session, provider, model: 'fake', events, permissions: new PermissionManager(cfg), config: cfg, mode: 'build' })
    ok('same mode → error', 'error' in loop.switchMode('build', 'no-op') && loop.switchMode('build', 'x').error?.includes('already'))
    ok('unknown mode → error', 'error' in loop.switchMode('hack' as AgentMode, 'x'))
    const subSession = mkSession('build')
    const subLoop = new AgentLoop({ session: subSession, provider, model: 'fake', events, permissions: new PermissionManager(cfg), config: cfg, mode: 'build', depth: 1, readOnly: true })
    ok('subagent loop refuses to switch', 'error' in subLoop.switchMode('test', 'sub tries'))
    ok('sub toolset never offers switch_mode', !subLoop.tools.some((t) => t.name === 'switch_mode'))
  }

  /* --------------------------------------------------------------- */
  console.log('\n5) system prompt rework — sections + protected strings')
  {
    const tools = buildToolset({ config: cfg, mode: 'build' })
    const p = buildSystemPrompt({ workspaceRoot: root, mode: 'build', tools })
    ok('identity: elite autonomous engineer', p.includes('elite autonomous engineer') && p.includes('not a chatbot'))
    ok('section: Who you are', p.includes('## Who you are'))
    ok('section: Language (mirror the user)', p.includes('## Language') && p.includes('ALWAYS answer in the user\'s language'))
    ok('section: The work loop', p.includes('## The work loop') && p.includes('PLAN ──► BUILD ──► TEST'))
    ok('work loop: PASS branch → summary, FAIL branch → fix loop',
      p.includes('PASS ──► SUMMARY to the user') && p.includes('FAIL ──► BUILD (fix) ──► TEST ──► (loop)'))
    ok('work loop: numbered PLAN/BUILD/TEST contract',
      p.includes('1. PLAN —') && p.includes('2. BUILD —') && p.includes('3. TEST —') && p.includes('The BUILD → TEST loop repeats until the verification passes'))
    ok('work loop: max 5 rounds + escalation contract',
      p.includes('Max 5 fix rounds') && p.includes('escalate to the user') && p.includes('what you tried, the last error verbatim'))
    ok('work loop: concrete hypothesis, no blind retries',
      p.includes('concrete hypothesis') && p.includes('Blind trial-and-error is forbidden'))
    ok('work loop: stack-agnostic (web, CLI, bot, API…)',
      p.includes('EVERY project kind') && p.includes('CLI tool') && p.includes('bot') && p.includes('API'))
    ok('work loop teaches switch_mode + user approval', p.includes('switch_mode') && p.includes('approve or deny'))
    ok('section: Hard rules', p.includes('## Hard rules — never') && p.includes('Never edit a file you have not read'))
    ok('section: Finishing (structured summary)',
      p.includes('## Finishing — the final summary') && p.includes('✅ SELESAI') &&
      p.includes('📌 Yang dikerjakan') && p.includes('📁 File yang diubah') &&
      p.includes('🧪 Verifikasi') && p.includes('⚠️ Catatan'))
    ok('build persona intact', p.includes('Mode: BUILD') && p.includes('your job is WORKING CODE'))
    ok('ask_user contract intact', p.includes('## Asking the user — the ask_user tool, every time'))
    ok('build prompt still free of the QA deliverable literal', !p.includes('test_report'))

    const t = buildSystemPrompt({ workspaceRoot: root, mode: 'test', tools: buildToolset({ config: cfg, mode: 'test' }) })
    ok('test persona intact', t.includes('Mode: TEST') && t.includes('your job is VERIFICATION'))
    ok('test persona stack-agnostic (per-kind methods)',
      t.includes('EVERY project kind') && t.includes('CLI tool') && t.includes('API/service') &&
      t.includes('reading the code is not testing'))
    ok('test closing line points at switch_mode', t.includes('back to build (switch_mode)'))

    const pl = buildSystemPrompt({ workspaceRoot: root, mode: 'plan', tools: buildToolset({ config: cfg, mode: 'plan' }) })
    ok('plan persona intact', pl.includes('Mode: PLAN') && pl.includes('REQUIREMENTS'))

    const sub = buildSystemPrompt({ workspaceRoot: root, mode: 'build', tools: buildToolset({ config: cfg, mode: 'build', depth: 1 }), subagent: true })
    ok('sub keeps the lean identity', sub.includes('Tagent subagent'))
    ok('sub does NOT get Who you are / Language / work loop / hard rules / finishing',
      !sub.includes('## Who you are') && !sub.includes('## Language') && !sub.includes('## The work loop') && !sub.includes('## Hard rules') && !sub.includes('## Finishing'))

    const cav = buildSystemPrompt({ workspaceRoot: root, mode: 'build', tools, caveman: true })
    ok('caveman keeps the structured summary (terse variant)',
      cav.includes('## Finishing') && cav.includes('✅ SELESAI') && cav.includes('one line per field'))
    ok('caveman keeps the hard rules', cav.includes('## Hard rules'))
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
