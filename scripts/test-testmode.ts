/**
 * test-testmode.ts — hermetic tests for agent TEST mode:
 * toolset composition, system prompt, loop-level write gating, and the
 * [IMAGE:] → wire-image plumbing (collectImages + renderMessages + adapters).
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  AgentLoop,
  PermissionManager,
  buildToolset,
  buildSystemPrompt,
  defaultConfig,
  OpenAICompatibleAdapter,
  AnthropicAdapter,
  GoogleAdapter,
  acceptsImages,
  withoutImages,
  type ProviderAdapter,
  type CompletionRequest,
} from '../packages/core/src/index'
import { ALL_TOOLS } from '../packages/core/src/tools'
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

const root = fs.mkdtempSync('/tmp/tagent-testmode-')
const cfg: TagentConfig = {
  ...defaultConfig(),
  permissions: { defaultMode: 'allow', tools: {} },
  tools: { bash: true, browser: true, serve: true },
}

async function main() {
  console.log('1) test toolset composition')
  {
    const tools = buildToolset({ config: cfg, mode: 'test' })
    const names = tools.map((t) => t.name)
    for (const want of ['read_file', 'grep', 'bash', 'browser', 'serve', 'test_report', 'todowrite']) {
      ok(`${want} present`, names.includes(want))
    }
    for (const banned of ['write_file', 'edit_file', 'worklog']) {
      ok(`${banned} excluded`, !names.includes(banned))
    }
    // the QA lead MAY spawn sub-testers — task is intentionally present in
    // test mode for the primary agent, but excluded at depth > 0
    ok('task present for the QA lead (spawn sub-testers)', names.includes('task'))
    const subTools = buildToolset({ config: cfg, mode: 'test', depth: 1 })
    const subNames = subTools.map((t) => t.name)
    ok('task excluded for sub-testers (no nesting)', !subNames.includes('task'))
    ok('ask_user excluded for sub-testers', !subNames.includes('ask_user'))
    ok('sub-tester keeps the QA core (bash/browser/vision)', ['bash', 'browser', 'vision'].every((n) => subNames.includes(n)))
    const disabled = buildToolset({
      config: { ...cfg, tools: { bash: true, browser: false, serve: false } },
      mode: 'test',
    })
    ok('browser=false filters browser', !disabled.map((t) => t.name).includes('browser'))
    ok('serve=false filters serve', !disabled.map((t) => t.name).includes('serve'))
  }

  console.log('\n2) system prompt — TEST mode persona')
  {
    const tools = buildToolset({ config: cfg, mode: 'test' })
    const prompt = buildSystemPrompt({ workspaceRoot: root, mode: 'test', tools })
    ok('identity = QA engineer', prompt.includes('your job is VERIFICATION'))
    ok('workflow present (serve/browser)', prompt.includes('START THE APP') && prompt.includes('EXERCISE'))
    ok('responsive step present', prompt.includes('RESPONSIVENESS'))
    ok('report protocol present', prompt.includes('test_report') && prompt.includes('pass|warn|fail'))
    ok('no worklog protocol in test mode', !prompt.includes('## Progress tracking — todos + worklog'))
    const build = buildSystemPrompt({ workspaceRoot: root, mode: 'build', tools })
    ok('build mode unaffected', build.includes('your job is WORKING CODE'))
  }

  console.log('\n3) loop gating — write_file rejected in test mode')
  {
    const actions: string[] = [
      '```tagent:action\n{"tool":"write_file","input":{"path":"x.txt","content":"no"}}\n```',
      '```tagent:action\n{"tool":"serve","input":{"action":"status"}}\n```',
    ]
    let turn = 0
    const fake: ProviderAdapter = {
      id: 'fake', label: 'fake', supportsNativeTools: false, models: [],
      complete: async () => '',
      completeStream: async () => {
        turn++
        return turn === 1
          ? { text: 'trying actions\n' + actions.join('\n') }
          : { text: 'final report' }
      },
    }
    const session: SessionData = {
      id: 's1', workspaceId: root, title: 't', model: 'fake', mode: 'test',
      createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
    }
    const loop = new AgentLoop({
      session, provider: fake, model: 'fake',
      events: {} as AgentEvents,
      permissions: new PermissionManager(cfg), config: cfg, mode: 'test',
    })
    const summary = await loop.run('test the app')
    const fed = session.messages.find((m) => m.meta?.toolResults)?.content ?? ''
    ok('write_file blocked with mode explanation', fed.includes('not available in test mode'), fed.slice(0, 400))
    ok('serve attempt went through (allowed tool)', fed.includes('### serve'), fed.slice(0, 300))
    ok('run completed', summary.finished === 'complete')
  }

  console.log('\n4) [IMAGE:] marker → wire images (vision model)')
  {
    const png = path.join(root, 'shot.png')
    fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')) // tiny png-ish blob
    let turn = 0
    const fake: ProviderAdapter = {
      id: 'fake', label: 'fake', supportsNativeTools: false, models: [],
      complete: async () => '',
      completeStream: async (req: CompletionRequest) => {
        turn++
        if (turn === 1) {
          return { text: `looking\n\`\`\`tagent:action\n{"tool":"bash","input":{"command":"echo [IMAGE:${png}]"}}\n\`\`\`` }
        }
        // turn 2 — inspect what the loop fed back
        ;(fake as any).saw = JSON.parse(JSON.stringify(req.messages.filter((m) => m.role === 'user').pop()))
        return { text: 'report done' }
      },
    }
    const session: SessionData = {
      id: 's2', workspaceId: root, title: 't', model: 'gpt-4o', mode: 'test',
      createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
    }
    const loop = new AgentLoop({
      session, provider: fake, model: 'gpt-4o', // heuristic: multimodal
      events: {} as AgentEvents,
      permissions: new PermissionManager(cfg), config: cfg, mode: 'test',
    })
    await loop.run('screenshot it')
    const stored = session.messages.find((m) => m.meta?.toolResults && m.meta?.images)
    ok('meta.images stored (path only)', Array.isArray(stored?.meta?.images) && (stored!.meta!.images as string[])[0] === png, JSON.stringify(stored?.meta))
    ok('marker stripped from fed text', !((fake as any).saw?.content ?? '').includes('[IMAGE:'))
    ok('wire image attached (base64)', ((fake as any).saw?.images ?? []).length === 1)
    ok('wire mediaType png', ((fake as any).saw?.images ?? [])[0]?.mediaType === 'image/png')
  }

  console.log('\n5) [IMAGE:] marker → text reference (non-vision model)')
  {
    const png = path.join(root, 'shot2.png')
    fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))
    let turn = 0
    const fake: ProviderAdapter = {
      id: 'fake', label: 'fake', supportsNativeTools: false, models: [],
      complete: async () => '',
      completeStream: async (req: CompletionRequest) => {
        turn++
        if (turn === 1) {
          return { text: `snap\n\`\`\`tagent:action\n{"tool":"bash","input":{"command":"echo [IMAGE:${png}]"}}\n\`\`\`` }
        }
        ;(fake as any).saw = req.messages.filter((m) => m.role === 'user').pop()
        return { text: 'done' }
      },
    }
    const session: SessionData = {
      id: 's3', workspaceId: root, title: 't', model: 'gpt-3.5-turbo', mode: 'test',
      createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
    }
    const loop = new AgentLoop({
      session, provider: fake, model: 'gpt-3.5-turbo', // heuristic: NOT multimodal
      events: {} as AgentEvents,
      permissions: new PermissionManager(cfg), config: cfg, mode: 'test',
    })
    await loop.run('screenshot it')
    const stored = session.messages.find((m) => m.meta?.toolResults && m.meta?.images)
    ok('no meta.images for text-only model', !stored)
    ok('marker became readable reference', ((fake as any).saw?.content ?? '').includes('(screenshot at'), (fake as any).saw?.content?.slice(0, 200))
    ok('no wire images', !((fake as any).saw?.images ?? []).length)
  }

  console.log('\n6) adapter wire formats — image blocks')
  {
    const msgs = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'see this', images: [{ data: 'QUJD', mediaType: 'image/png' }] },
    ]
    const req: CompletionRequest = { messages: msgs, model: 'x' }
    // openai — via a fetch interceptor
    let openaiBody: any
    const oa = new OpenAICompatibleAdapter('t', 't', 'http://127.0.0.1:1', 'k', [])
    const origFetch = globalThis.fetch
    ;(globalThis as any).fetch = async (_u: string, init: any) => {
      openaiBody = JSON.parse(init.body)
      throw new Error('stop here')
    }
    try { await oa.completeStream(req) } catch { /* expected */ }
    ;(globalThis as any).fetch = origFetch
    const om = openaiBody?.messages?.[1] // [0] is the system message
    ok('openai: content is an array', Array.isArray(om?.content))
    ok('openai: text block first', om?.content?.[0]?.type === 'text')
    ok('openai: image_url data URL', om?.content?.[1]?.image_url?.url === 'data:image/png;base64,QUJD')
    ok('openai: system stays a plain string', typeof openaiBody?.messages?.[0]?.content === 'string')

    // anthropic — buildBody is private; intercept the fetch
    let anthBody: any
    const an = new AnthropicAdapter('t', 't', 'k', 'http://127.0.0.1:1')
    ;(globalThis as any).fetch = async (_u: string, init: any) => {
      anthBody = JSON.parse(init.body)
      throw new Error('stop here')
    }
    try { await an.completeStream(req) } catch { /* expected */ }
    ;(globalThis as any).fetch = origFetch
    const am = anthBody?.messages?.[0]
    ok('anthropic: image block BEFORE text', am?.content?.[0]?.type === 'image' && am?.content?.[1]?.type === 'text')
    ok('anthropic: base64 source', am?.content?.[0]?.source?.data === 'QUJD' && am?.content?.[0]?.source?.media_type === 'image/png')

    // google — inlineData part first
    let googBody: any
    const ga = new GoogleAdapter('t', 't', 'k', 'http://127.0.0.1:1')
    ;(globalThis as any).fetch = async (_u: string, init: any) => {
      googBody = JSON.parse(init.body)
      throw new Error('stop here')
    }
    try { await ga.completeStream(req) } catch { /* expected */ }
    ;(globalThis as any).fetch = origFetch
    const gm = googBody?.contents?.[0]
    ok('google: inlineData part first', gm?.parts?.[0]?.inlineData?.mimeType === 'image/png' && gm?.parts?.[0]?.inlineData?.data === 'QUJD')
    ok('google: text part after', gm?.parts?.[1]?.text === 'see this')
  }

  console.log('\n7) acceptsImages heuristics + withoutImages')
  {
    const fakeAdapter: ProviderAdapter = { id: 'f', label: 'f', supportsNativeTools: false, models: [], complete: async () => '', completeStream: async () => ({ text: '' }) }
    ok('gpt-4o → true', acceptsImages(fakeAdapter, 'gpt-4o'))
    ok('claude-sonnet-4-5 → true', acceptsImages(fakeAdapter, 'claude-sonnet-4-5'))
    ok('gemini-2.5-pro → true', acceptsImages(fakeAdapter, 'gemini-2.5-pro'))
    ok('glm-4.7 → true (heuristic glm-4.x)', acceptsImages(fakeAdapter, 'glm-4.7'))
    ok('glm-4v → true', acceptsImages(fakeAdapter, 'glm-4v'))
    ok('phi-3 not caught by o3 substring', !acceptsImages(fakeAdapter, 'phi-3-mini'))
    ok('qwen2.5-vl → true', acceptsImages(fakeAdapter, 'qwen2.5-vl-72b'))
    const seeded: ProviderAdapter = {
      ...fakeAdapter,
      models: [{ id: 'custom-x', label: 'X', provider: 'f', vision: true }],
    }
    ok('seed vision=true wins', acceptsImages(seeded, 'custom-x'))
    const stripped = withoutImages({
      messages: [
        { role: 'user', content: 'see this', images: [{ data: 'QUJD', mediaType: 'image/png' }] },
      ],
      model: 'x',
    })
    ok('withoutImages strips parts', !stripped.messages.some((m) => (m as any).images?.length))
  }

  console.log('\n8) test_report tool writes the artifact')
  {
    const { testReportTool } = await import('../packages/core/src/tools/report')
    const out = await testReportTool.run(
      { verdict: 'warn', markdown: '# body\n\n| feature | result |\n|---|---|\n| login | pass |' },
      { workspaceRoot: root, sessionId: 's', depth: 0, config: cfg, events: {} as AgentEvents, todos: [] },
    )
    ok('report saved line', out.includes('Report saved'), out)
    const main = fs.readFileSync(path.join(root, 'TEST-REPORT.md'), 'utf8')
    ok('TEST-REPORT.md at root', main.includes('Test Report') && main.includes('PASS WITH WARNINGS'))
    ok('body preserved', main.includes('| login | pass |'))
    ok('history copy exists', fs.readdirSync(path.join(root, '.tagent', 'test')).some((f) => f.startsWith('report-')))
    const bad = await testReportTool.run({ verdict: 'nope', markdown: 'x' }, { workspaceRoot: root, sessionId: 's', depth: 0, config: cfg, events: {} as AgentEvents, todos: [] })
    ok('invalid verdict rejected', bad.startsWith('Error:'))
  }

  console.log('\n9) FULL PIPELINE — scripted model, real serve + browser + report')
  {
    // a real static server as the "dev server" target
    const http = await import('node:http')
    const srv = http.createServer((q, s) => {
      s.writeHead(200, { 'content-type': 'text/html' })
      s.end('<!doctype html><html><head><title>Pipe</title></head><body><h1>pipe page</h1></body></html>')
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as { port: number }).port

    // the scripted "model": serve → open → screenshot → report → final
    const script: string[] = [
      '```tagent:action\n{"tool":"serve","input":{"action":"start"}}\n```',
      `go\n\`\`\`tagent:action\n{"tool":"browser","input":{"action":"open","url":"http://127.0.0.1:${port}"}}\n\`\`\``,
      `shoot\n\`\`\`tagent:action\n{"tool":"browser","input":{"action":"screenshot"}}\n\`\`\``,
      '```tagent:action\n{"tool":"test_report","input":{"verdict":"warn","markdown":"## summary\\n\\nlooks fine"}}\n```',
    ]
    let turn = 0
    let sawImageRef = false
    const fake: ProviderAdapter = {
      id: 'fake', label: 'fake', supportsNativeTools: false, models: [],
      complete: async () => '',
      completeStream: async (req: CompletionRequest) => {
        const fed = req.messages.filter((m: any) => m.role === 'user').pop()?.content ?? ''
        if (fed.includes('(screenshot at')) sawImageRef = true
        const i = turn++
        if (i < script.length) return { text: script[i] }
        return { text: 'verification complete — verdict warn' }
      },
    }
    // the workspace needs a runnable "dev command": point serve at our static server
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'pipe', scripts: { dev: `node -e "require('http').createServer((q,s)=>{s.end('ok')}).listen(${port})"` },
    }))

    const session: SessionData = {
      id: 's9', workspaceId: root, title: 't', model: 'fake', mode: 'test',
      createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, messages: [], todos: [],
    }
    const loop = new AgentLoop({
      session, provider: fake, model: 'fake',
      events: {} as AgentEvents,
      permissions: new PermissionManager(cfg), config: cfg, mode: 'test',
    })
    const summary = await loop.run('test it')
    srv.close()
    await (await import('../packages/core/src/tools/serve')).serveTool.run({ action: 'stop' }, {
      workspaceRoot: root, sessionId: 's9', depth: 0, config: cfg, events: {} as AgentEvents, todos: [],
    }).catch(() => undefined)

    ok('pipeline completed', summary.finished === 'complete', JSON.stringify(summary))
    ok('all 4 scripted tools executed', summary.toolCalls >= 4, `toolCalls=${summary.toolCalls}`)
    const report = fs.readFileSync(path.join(root, 'TEST-REPORT.md'), 'utf8')
    ok('report written through the loop', report.includes('looks fine') && report.includes('WARNINGS'))
    const shots = fs.readdirSync(path.join(root, '.tagent', 'test', 'shots'))
    ok('screenshot saved through the loop', shots.some((f) => f.startsWith('shot-')), shots.join(','))
    ok('non-vision model got the screenshot path reference', sawImageRef)
  }
}

main()
  .catch((e) => {
    console.error('FATAL', e)
    process.exitCode = 1
  })
  .finally(() => {
    console.log(`\n${'='.repeat(50)}\nRESULT: ${passed} passed, ${failed} failed`)
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
    process.exit(failed > 0 ? 1 : 0)
  })
