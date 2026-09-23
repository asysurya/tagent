/**
 * test-v0190.ts — v0.19.0 feature suite:
 *  - mode toolsets (plan = investigate+interview, test = QA + bg, build = project-affecting)
 *  - loop-level gates: MCP/plugin tools stay available in plan & test mode
 *  - bg_run / bg_logs / bg_stop — real background processes
 *  - agent-set timeouts (bash)
 *  - system-prompt awareness (QA knows its task, knows the bg tools + timeouts)
 */
import fs from 'node:fs'
import {
  AgentLoop,
  PermissionManager,
  buildToolset,
  buildSystemPrompt,
  defaultConfig,
  type ProviderAdapter,
} from '../packages/core/src/index'
import { bgLogsTool, bgRunTool, bgStopTool } from '../packages/core/src/tools/bg'
import { bashTool } from '../packages/core/src/tools/bash'
import type { AgentEvents, SessionData, TagentConfig } from '../packages/core/src/types'

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

const root = fs.mkdtempSync('/tmp/tagent-v0190-')
const cfg: TagentConfig = {
  ...defaultConfig(),
  permissions: { defaultMode: 'allow', tools: {} },
  tools: { bash: true, browser: true, serve: true },
}

const fakeProvider = (replies: string[]): ProviderAdapter => {
  let turn = 0
  return {
    id: 'fake', label: 'fake', supportsNativeTools: false, models: [],
    complete: async () => '',
    completeStream: async () => ({ text: replies[Math.min(turn++, replies.length - 1)] }),
  }
}

const mkSession = (mode: 'build' | 'plan' | 'test'): SessionData => ({
  id: 's-' + mode + Math.random().toString(36).slice(2, 6),
  workspaceId: root, title: 't', model: 'fake', mode,
  createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
})

const fakeMcpTool = {
  name: 'mcp_fake_search',
  description: 'test fake mcp tool',
  risk: 'low' as const,
  params: { q: 'string — query' },
  inputSchema: { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q'] },
  run: async () => 'search results: 3 hits',
}

async function runLoop(mode: 'build' | 'plan' | 'test', actions: string[], extra: any[] = []) {
  const session = mkSession(mode)
  const loop = new AgentLoop({
    session,
    provider: fakeProvider(['acting\n' + actions.join('\n'), 'done text']),
    model: 'fake',
    events: {} as AgentEvents,
    permissions: new PermissionManager(cfg),
    config: cfg,
    mode,
    extraTools: extra as any,
  })
  const summary = await loop.run('go')
  const fed = session.messages.find((m) => m.meta?.toolResults)?.content ?? ''
  return { summary, fed }
}

async function main() {
  console.log('1) toolset composition per mode')
  {
    const build = buildToolset({ config: cfg }).map((t) => t.name)
    const plan = buildToolset({ config: cfg, mode: 'plan' }).map((t) => t.name)
    const test = buildToolset({ config: cfg, mode: 'test' }).map((t) => t.name)

    for (const want of ['write_file', 'edit_file', 'bash', 'serve', 'task', 'worklog', 'browser', 'ask_user', 'bg_run', 'bg_logs', 'bg_stop']) {
      ok(`build has ${want}`, build.includes(want))
    }
    ok('build does NOT ship the QA report tool (test_report is test mode\u2019s deliverable)', !build.includes('test_report'))

    for (const want of ['read_file', 'read_files', 'list_files', 'grep', 'web_fetch', 'ddg_search', 'ask_user', 'task', 'memory', 'load_skill', 'todowrite']) {
      ok(`plan has ${want}`, plan.includes(want))
    }
    for (const banned of ['write_file', 'edit_file', 'bash', 'serve', 'browser', 'worklog', 'bg_run', 'test_report']) {
      ok(`plan excludes ${banned}`, !plan.includes(banned))
    }

    for (const want of ['read_file', 'grep', 'bash', 'browser', 'serve', 'test_report', 'ask_user', 'bg_run', 'bg_logs', 'bg_stop']) {
      ok(`test has ${want}`, test.includes(want))
    }
    for (const banned of ['write_file', 'edit_file', 'worklog']) {
      ok(`test excludes ${banned}`, !test.includes(banned))
    }
    // v0.26: the QA lead MAY spawn sub-testers — task is present for the
    // primary test agent, but depth > 0 (sub-testers) never gets it
    ok('test keeps task for the QA lead', test.includes('task'))
    const testSub = buildToolset({ config: cfg, mode: 'test', depth: 1 }).map((t) => t.name)
    ok('test subagent (depth 1) has no nested task', !testSub.includes('task'))

    const roSub = buildToolset({ config: cfg, readOnly: true, depth: 1 }).map((t) => t.name)
    ok('explore subagent (readOnly) has no task', !roSub.includes('task'))
    const planSub = buildToolset({ config: cfg, mode: 'plan', depth: 1 }).map((t) => t.name)
    ok('plan subagent (depth 1) has no nested task', !planSub.includes('task'))

    const noBash = buildToolset({ config: { ...cfg, tools: { bash: false, browser: true, serve: true } } }).map((t) => t.name)
    ok('bash=false filters bash', !noBash.includes('bash'))
    ok('bash=false filters bg_run too (same shell gate)', !noBash.includes('bg_run') && !noBash.includes('bg_logs'))
  }

  console.log('\n2) loop gates — MCP tools work in plan & test; writes still blocked')
  {
    const write = '```tagent:action\n{"tool":"write_file","input":{"path":"x.txt","content":"no"}}\n```'
    const mcp = '```tagent:action\n{"tool":"mcp_fake_search","input":{"q":"docs"}}\n```'

    const plan = await runLoop('plan', [write, mcp], [fakeMcpTool])
    ok('plan: write_file blocked', plan.fed.includes('not available in plan mode'), plan.fed.slice(0, 200))
    ok('plan: MCP tool ran (external exemption)', plan.fed.includes('search results: 3 hits'), plan.fed.slice(0, 200))

    const test = await runLoop('test', [mcp], [fakeMcpTool])
    ok('test: MCP tool ran (external exemption)', test.fed.includes('search results: 3 hits'), test.fed.slice(0, 200))

    const plug = '```tagent:action\n{"tool":"plugin_fake_tool","input":{}}\n```'
    const planPlug = await runLoop('plan', [plug], [{ ...fakeMcpTool, name: 'plugin_fake_tool' }])
    ok('plan: plugin tool ran (external exemption)', planPlug.fed.includes('search results: 3 hits'))
  }

  console.log('\n3) bg_run / bg_logs / bg_stop — real background processes')
  {
    const ctx = { workspaceRoot: root, sessionId: 'bgtest', depth: 0, config: cfg, events: {} } as any

    const start = await bgRunTool.run({ name: 'ticker', command: 'for i in 1 2 3 4 5 6; do echo "tick $i"; sleep 0.25; done', wait_ms: 400 }, ctx)
    ok('bg_run returns while the process still runs', start.includes('still running'), start)
    ok('bg_run echoes the handle + command', start.includes('name: ticker') && start.includes('command:'))

    const list = await bgLogsTool.run({}, ctx)
    ok('bg_logs (no name) lists the process', list.includes('ticker') && list.includes('running'), list)

    await new Promise((r) => setTimeout(r, 700))
    const logs = await bgLogsTool.run({ name: 'ticker' }, ctx)
    ok('bg_logs (name) shows accumulated output', logs.includes('tick'), logs.slice(0, 200))
    ok('bg_logs reports uptime/output', logs.includes('output lines'), logs.slice(0, 120))

    const stop = await bgStopTool.run({ name: 'ticker' }, ctx)
    ok('bg_stop kills it', stop.includes('Stopped "ticker"'), stop)
    const after = await bgLogsTool.run({ name: 'ticker' }, ctx)
    ok('bg_logs after stop: gone', after.includes('no background process named'), after)

    const dead = await bgRunTool.run({ name: 'instant', command: 'echo dying && exit 7', wait_ms: 1500 }, ctx)
    ok('bg_run detects an early crash with its output', dead.includes('died immediately') && dead.includes('dying'), dead.slice(0, 200))
    await bgStopTool.run({ name: 'instant' }, ctx)

    const gated = await bgRunTool.run({ name: 'x', command: 'true' }, { ...ctx, config: { ...cfg, tools: { ...cfg.tools, bash: false } } })
    ok('bg tools gated when bash is off', gated.includes('disabled'), gated)

    const bad = await bgRunTool.run({ name: 'bad name!', command: 'true' }, ctx)
    ok('bg_run validates the handle', bad.includes('Error:'), bad)
  }

  console.log('\n4) agent-set timeouts (bash)')
  {
    const ctx = { workspaceRoot: root, sessionId: 'tmo', depth: 0, config: cfg, events: {} } as any
    const t0 = Date.now()
    const out = await bashTool.run({ command: 'sleep 5', timeout: 1200 }, ctx)
    const took = Date.now() - t0
    ok('agent-set timeout honored (killed at 1.2s)', out.includes('timeout after 1200ms') && took < 3000, `took=${took}ms`)
    const ok2 = await bashTool.run({ command: 'echo fast', timeout: 5000 }, ctx)
    ok('short command completes within the budget', ok2.includes('fast') && ok2.includes('exit 0'))
  }

  console.log('\n5) system prompt knows the new kit')
  {
    const testPrompt = buildSystemPrompt({ workspaceRoot: root, mode: 'test', tools: [] })
    ok('QA prompt: knows PRD is the spec', testPrompt.includes('PRD.md is the SPEC'))
    ok('QA prompt: knows WORKLOG focus', testPrompt.includes('WORKLOG.md is what the builder'))
    ok('QA prompt: teaches bg_run for non-web processes', testPrompt.includes('bg_run'))
    ok('QA prompt: teaches timeout control', testPrompt.includes('You control your own timeouts'))
    const planPrompt = buildSystemPrompt({ workspaceRoot: root, mode: 'plan', tools: [] })
    ok('plan prompt still read-only contract', planPrompt.includes('REQUIREMENTS'))
  }

  console.log(`\nv0.19.0 tests: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
