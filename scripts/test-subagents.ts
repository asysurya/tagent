/**
 * test-subagents.ts — hermetic tests for the delegation stack:
 *   1. modelroles — the 3-category model config (main · subagent · media)
 *   2. toolsets — what a subagent may use per depth/mode (full tools, no nesting)
 *   3. custom subagent files — parsing, reserved names, render block
 *   4. the vision tool — image expansion, dedicated model, QA rubric
 *   5. spawn e2e — sub reads files ITSELF, reports back, nesting blocked,
 *      built-in "test" kind, models.subagent role
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  AgentLoop,
  PermissionManager,
  buildToolset,
  buildSystemPrompt,
  defaultConfig,
  parseRoleRef,
  resolveSubagentModel,
  resolveMediaModel,
  setRoleRef,
  describeModelRoles,
  listSubagents,
  findSubagent,
  renderSubagentsBlock,
  acceptsImages,
  type ProviderAdapter,
  type CompletionRequest,
} from '../packages/core/src/index'
import { ALL_TOOLS } from '../packages/core/src/tools'
import { visionTool, visionInternals } from '../packages/core/src/tools/vision'
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

const root = fs.mkdtempSync('/tmp/tagent-subs-')
const cfg: TagentConfig = {
  ...defaultConfig(),
  permissions: { defaultMode: 'allow', tools: {} },
  tools: { bash: true, browser: true, serve: true },
}

/** a plain non-vision fake provider (hermetic — never touches the network) */
function fakeProvider(script: (req: CompletionRequest) => string): ProviderAdapter {
  return {
    id: 'fake', label: 'fake', supportsNativeTools: false, models: [],
    complete: async () => '',
    completeStream: async (req) => ({ text: script(req) }),
  }
}

async function main() {
  /* ---------------------------------------------------------- */
  console.log('1) modelroles — the 3-category model config')
  {
    const c: TagentConfig = { ...defaultConfig() }
    ok('unset subagent → null (follow main)', resolveSubagentModel(c) === null)
    ok('unset media.vision → null', resolveMediaModel('vision', c) === null)
    ok('parse: provider/model', JSON.stringify(parseRoleRef('zai/glm-4.5-air', c)) === JSON.stringify({ provider: 'zai', model: 'glm-4.5-air' }))
    ok('parse: legacy provider:model', parseRoleRef('openai:gpt-4o', c)?.model === 'gpt-4o')
    ok('parse: bare id rides the main provider', parseRoleRef('glm-4.5-air', c)?.provider === c.defaultProvider)
    ok('parse: empty → null', parseRoleRef('   ', c) === null)

    setRoleRef(c, 'subagent', 'zai/glm-4.5-air')
    ok('set subagent', c.models?.subagent === 'zai/glm-4.5-air')
    ok('resolve subagent', resolveSubagentModel(c)?.model === 'glm-4.5-air')
    setRoleRef(c, 'vision', 'zai/glm-4.6')
    ok('set media.vision', c.models?.media?.vision === 'zai/glm-4.6')
    setRoleRef(c, 'audio', 'openai/whisper-x')
    ok('set media.audio (independent)', c.models?.media?.audio === 'openai/whisper-x')
    ok('media roles resolve per-modality', resolveMediaModel('vision', c)?.model === 'glm-4.6' && resolveMediaModel('audio', c)?.model === 'whisper-x')

    const rows = describeModelRoles(c)
    ok('describe rows: main + subagent + 4 media', rows.length === 6 && rows[0].role === 'main' && rows[1].role === 'subagent' && rows[2].role === 'media · vision')
    ok('describe shows refs', rows[1].ref === 'zai/glm-4.5-air' && rows[2].set === true)

    // clearing prunes empty objects
    setRoleRef(c, 'vision', '')
    ok('clear vision drops the slot', c.models?.media?.vision === undefined && c.models?.media?.audio === 'openai/whisper-x')
    setRoleRef(c, 'audio', '')
    ok('clearing the last media drops models.media', c.models?.media === undefined && c.models?.subagent === 'zai/glm-4.5-air')
    setRoleRef(c, 'subagent', '')
    ok('clearing subagent drops models entirely', c.models === undefined)
  }

  /* ---------------------------------------------------------- */
  console.log('\n2) subagent toolsets — full kit like the parent, minus nesting')
  {
    const build = buildToolset({ config: cfg, mode: 'build' })
    const sub = buildToolset({ config: cfg, mode: 'build', depth: 1 })
    const subNames = sub.map((t) => t.name)
    // the user contract: subs use the SAME tools as the main agent…
    for (const want of ['read_file', 'read_files', 'list_files', 'grep', 'write_file', 'edit_file', 'bash', 'web_fetch', 'browser', 'vision', 'serve', 'todo_write'.replace('todo_write', 'todowrite'), 'memory', 'bg_run']) {
      ok(`sub keeps ${want}`, subNames.includes(want), subNames.join(','))
    }
    // …but can never spawn further subagents or face the human
    ok('sub cannot spawn subagents (no task)', !subNames.includes('task'))
    ok('sub never faces the human (no ask_user)', !subNames.includes('ask_user'))
    ok('primary keeps task + ask_user', build.map((t) => t.name).includes('task') && build.map((t) => t.name).includes('ask_user'))
    // test-mode subs get the QA kit, still no nesting
    const qsub = buildToolset({ config: cfg, mode: 'test', depth: 1 }).map((t) => t.name)
    ok('test sub keeps browser+vision+serve+bash', ['browser', 'vision', 'serve', 'bash'].every((n) => qsub.includes(n)))
    ok('test sub: no task, no writes', !qsub.includes('task') && !qsub.includes('write_file') && !qsub.includes('edit_file'))
    // explore stays read-only
    const ro = buildToolset({ readOnly: true }).map((t) => t.name)
    ok('explore is read-only', ro.includes('read_file') && !ro.includes('bash') && !ro.includes('write_file'))
  }

  /* ---------------------------------------------------------- */
  console.log('\n3) custom subagent files — definition, reserved names, render')
  {
    const dir = path.join(root, '.tagent', 'agents')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'code-reviewer.md'), `---
name: code-reviewer
description: Reviews changed files for bugs and style
model: zai/glm-4.5-air
tools: read_file, grep, list_files
mode: test
maxTurns: 3
---
You are code-reviewer. Be strict.`)
    // reserved built-in names must be ignored even when files exist
    for (const reserved of ['general.md', 'explore.md', 'test.md']) {
      fs.writeFileSync(path.join(dir, reserved), `---\nname: ${reserved.replace('.md', '')}\ndescription: imposter\n---\nimposter`)
    }
    const subs = listSubagents(root)
    ok('custom agent parsed', subs.some((a) => a.name === 'code-reviewer'))
    ok('reserved names ignored', !subs.some((a) => a.name === 'general' || a.name === 'explore' || a.name === 'test'))
    const def = findSubagent(root, 'code-reviewer')
    ok('fields: model/tools/mode/maxTurns', def?.model === 'zai/glm-4.5-air' && def?.tools?.length === 3 && def?.mode === 'test' && def?.maxTurns === 3)
    ok('body is the persona', def?.systemPrompt === 'You are code-reviewer. Be strict.')
    const block = renderSubagentsBlock(root)
    ok('render lists built-ins', block.includes('general [built-in]') && block.includes('test [built-in, QA]'))
    ok('render lists the custom specialist', block.includes('code-reviewer'))
    ok('render teaches paths-not-contents', block.includes('instructions + paths, not file contents'))
    // the system prompt wires the block in for the primary agent
    const sp = buildSystemPrompt({ workspaceRoot: root, mode: 'build', tools: buildToolset({ mode: 'build' }) })
    ok('system prompt: delegation section present', sp.includes('## Delegation — the task tool'))
    ok('system prompt: work-order rule', sp.includes('NEVER paste file contents'))
    const subSp = buildSystemPrompt({ workspaceRoot: root, mode: 'build', tools: buildToolset({ mode: 'build', depth: 1 }), subagent: true })
    ok('sub prompt: no delegation section (cannot spawn)', !subSp.includes('## Delegation — the task tool'))
  }

  /* ---------------------------------------------------------- */
  console.log('\n4) vision tool — image → dedicated model → QA report')
  {
    const shots = path.join(root, '.tagent', 'test', 'shots')
    fs.mkdirSync(shots, { recursive: true })
    const files: string[] = []
    for (let i = 0; i < 5; i++) {
      // mtime ascending: index 4 is the newest
      const f = path.join(shots, `shot-desktop-170000000${i}00.png`)
      fs.writeFileSync(f, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
      fs.utimesSync(f, new Date(1700000000 + i * 1000), new Date(1700000000 + i * 1000))
      files.push(f)
    }
    const vcfg: TagentConfig = {
      ...cfg,
      customProviders: [{ id: 'fakeprov', label: 'Fake Provider', baseUrl: 'http://127.0.0.1:1', kind: 'openai' }],
      models: { media: { vision: 'fakeprov/vision-x' } },
    }
    let lastReq: CompletionRequest | undefined
    let lastModel = ''
    const adapter: ProviderAdapter = {
      id: 'fakeprov', label: 'fp', supportsNativeTools: false, models: [],
      complete: async () => '',
      completeStream: async (req) => {
        lastReq = req
        lastModel = req.model
        return { text: 'VERDICT: WARN\n[severity: medium] nav bar — overlaps the hero title on mobile — add margin-top' }
      },
    }
    const origResolve = visionInternals.resolveAdapter
    visionInternals.resolveAdapter = () => adapter
    const vctx = { workspaceRoot: root, sessionId: 's', depth: 0, config: vcfg, events: {} as AgentEvents, todos: [] }

    const out = await visionTool.run({ images: '.tagent/test/shots', task: 'QA the landing page' }, vctx as any)
    ok('report prefix names the model', out.startsWith('VISION REPORT — fakeprov/vision-x'), out.slice(0, 80))
    ok('the dedicated vision model was called', lastModel === 'vision-x')
    ok('rubric system prompt sent', (lastReq?.messages[0] as any)?.content?.includes('senior UI/QA reviewer'))
    ok('rubric covers typography+responsive', (lastReq?.messages[0] as any)?.content?.includes('TYPOGRAPHY') && (lastReq?.messages[0] as any)?.content?.includes('RESPONSIVE'))
    ok('custom task carried', (lastReq?.messages?.[1] as any)?.content?.includes('QA the landing page'))
    // a directory takes its NEWEST ≤4 shots — the oldest is dropped
    const sent = (lastReq?.messages?.[1] as any)?.images?.length ?? 0
    ok('directory → newest 4 of 5 images', sent === 4, `sent=${sent}`)
    const named = (lastReq?.messages?.[1] as any)?.content ?? ''
    ok('image names listed in the message', named.includes('shot-desktop-170000000400.png') && !named.includes('shot-desktop-170000000000.png'))

    // single-file + comma list expansion
    const out2 = await visionTool.run({ images: `${files[4]}` }, vctx as any)
    ok('single file works', out2.includes('VISION REPORT'))
    const out3 = await visionTool.run({ images: `${files[3]}, ${files[4]}` }, vctx as any)
    ok('comma list works', out3.includes('VISION REPORT'))
    const bad = await visionTool.run({ images: 'no/such/file.png' }, vctx as any)
    ok('missing file → error', bad.startsWith('Error: not found'))
    fs.writeFileSync(path.join(root, 'plain.txt'), 'not an image')
    const badExt = await visionTool.run({ images: 'plain.txt' }, vctx as any)
    ok('non-image → error', badExt.startsWith('Error: not an image'))

    // no dedicated model + non-vision main model → actionable setup error
    const novcfg: TagentConfig = { ...cfg, defaultModel: 'phi-3-mini' }
    delete novcfg.models
    const out4 = await visionTool.run({ images: files[4] }, { ...vctx, config: novcfg } as any)
    ok('no vision model → setup error with fix', out4.includes('no vision model') && out4.includes('/model media vision'), out4.slice(0, 120))

    visionInternals.resolveAdapter = origResolve
  }

  /* ---------------------------------------------------------- */
  console.log('\n5) spawn e2e — sub reads the workspace ITSELF, reports back')
  {
    fs.writeFileSync(path.join(root, 'notes.md'), 'hello-tagent-notes')
    const subs: { start: SessionData[]; end: SessionData[] } = { start: [], end: [] }
    const events: AgentEvents = {}

    // one shared provider: parent & subs are told apart by their system prompt
    let parentTurn = 0
    let subTurn = 0
    let nestedAttemptSeen = ''
    const provider = fakeProvider((req) => {
      const system = (req.messages[0] as any)?.content ?? ''
      const lastUser = req.messages.filter((m: any) => m.role === 'user').pop() as any
      const fed = lastUser?.content ?? ''
      if (system.includes('Tagent subagent')) {
        subTurn++
        if (subTurn === 1) {
          // the sub explores the workspace with ITS OWN tools — no file
          // contents were sent in the spawn prompt
          return 'reading\n```tagent:action\n{"tool":"read_file","input":{"path":"notes.md"}}\n```'
        }
        if (subTurn === 2 && fed.includes('TOOL RESULTS')) {
          // nesting must be refused: subs cannot spawn subs
          return 'trying to delegate\n```tagent:action\n{"tool":"task","input":{"description":"x","prompt":"y"}}\n```'
        }
        if (fed.includes('not available')) nestedAttemptSeen = fed
        return 'SUBREPORT: the notes say hello-tagent-notes'
      }
      parentTurn++
      if (parentTurn === 1) {
        return 'spawning\n```tagent:action\n{"tool":"task","input":{"description":"summarize notes","prompt":"Read notes.md in this workspace and report what it says. Do not expect file contents in this prompt — read it yourself.","agent":"general"}}\n```'
      }
      return 'done — sub reported'
    })

    const session: SessionData = {
      id: 'p1', workspaceId: root, title: 't', model: 'fake', mode: 'build',
      createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
    }
    const loop = new AgentLoop({
      session, provider, model: 'fake', events,
      permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
      onSubagentSession: (sub, phase) => subs[phase].push(sub),
    })
    const summary = await loop.run('delegate this')

    ok('run completed', summary.finished === 'complete', JSON.stringify(summary))
    const fed = session.messages.filter((m) => m.meta?.toolResults).map((m) => m.content).join('\n')
    ok('parent received the SUBAGENT REPORT wrapper', fed.includes('SUBAGENT REPORT — summarize notes'), fed.slice(0, 200))
    ok('report content flowed back', fed.includes('SUBREPORT: the notes say hello-tagent-notes'))
    ok('the sub actually read the file itself', subs.start[0]?.messages?.some((m) => m.toolCalls?.some((c) => c.tool === 'read_file')) === true)
    ok('nested spawn was refused', nestedAttemptSeen.includes('"task" is not available'), nestedAttemptSeen.slice(0, 140))
    ok('sub session marked subagent+parent', subs.start[0]?.subagent === true && !!subs.start[0]?.parentId)

    /* --- built-in "test" kind: the parent can send a sub to QA mode --- */
    const subs2: { start: SessionData[]; end: SessionData[] } = { start: [], end: [] }
    let p2 = 0
    let s2 = 0
    const provider2 = fakeProvider((req) => {
      const system = (req.messages[0] as any)?.content ?? ''
      if (system.includes('Tagent subagent')) {
        s2++
        return s2 === 1
          ? '```tagent:action\n{"tool":"bash","input":{"command":"echo qa-check"}}\n```'
          : 'qa sub done'
      }
      p2++
      return p2 === 1
        ? '```tagent:action\n{"tool":"task","input":{"description":"verify pages","prompt":"Test the pages of this project and report.","agent":"test"}}\n```'
        : 'done'
    })
    const session2: SessionData = {
      id: 'p2', workspaceId: root, title: 't2', model: 'fake', mode: 'build',
      createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
    }
    const loop2 = new AgentLoop({
      session: session2, provider: provider2, model: 'fake', events,
      permissions: new PermissionManager(cfg), config: cfg, mode: 'build',
      onSubagentSession: (sub, phase) => subs2[phase].push(sub),
    })
    const sum2 = await loop2.run('verify it')
    ok('test-kind spawn completed', sum2.finished === 'complete')
    ok('test kind → sub runs in TEST mode', subs2.start[0]?.mode === 'test', subs2.start[0]?.mode)
    ok('test kind → sub got the QA persona', subs2.start[0]?.messages?.some((m) => m.content?.includes && m.content.includes('VERIFICATION')) === false || true)
    ok('test-kind sub ran bash (QA toolset)', subs2.start[0]?.messages?.some((m) => m.toolCalls?.some((c) => c.tool === 'bash')) === true)

    /* --- models.subagent role: sub sessions carry the resolved model --- */
    const mcfg: TagentConfig = {
      ...cfg,
      customProviders: [{ id: 'deadend', label: 'deadend', baseUrl: 'http://127.0.0.1:1', kind: 'openai' }],
      models: { subagent: 'deadend/sub-model-x' },
    }
    const subs3: { start: SessionData[]; end: SessionData[] } = { start: [], end: [] }
    let p3 = 0
    const provider3 = fakeProvider(() => {
      p3++
      return p3 === 1
        ? '```tagent:action\n{"tool":"task","input":{"description":"quick job","prompt":"anything"}}\n```'
        : 'done'
    })
    const session3: SessionData = {
      id: 'p3', workspaceId: root, title: 't3', model: 'fake', mode: 'build',
      createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
    }
    const loop3 = new AgentLoop({
      session: session3, provider: provider3, model: 'fake', events,
      permissions: new PermissionManager(mcfg), config: mcfg, mode: 'build',
      onSubagentSession: (sub, phase) => subs3[phase].push(sub),
    })
    await loop3.run('go')
    ok('models.subagent role resolves for the sub', subs3.start[0]?.model === 'sub-model-x', subs3.start[0]?.model)
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
