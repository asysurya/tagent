#!/usr/bin/env bun
/**
 * test-tui-md.ts — headless unit tests for the v0.13.0 TUI stream/markdown
 * layer (tui-app.ts) that the pty suite cannot drive deterministically:
 *
 *   - assistant stream → markdown rollback: raw onChunk lines are rolled
 *     back and the final message renders exactly once (A2's renderMarkdown,
 *     plus a stub-renderer run that isolates tui-app's own rollback logic)
 *   - rollback guards: an interleaved (non-stream) tool/notify line and a
 *     frozen permission buffer both keep the raw lines and lose nothing
 *   - esc priority chain: text → clear, idle → notice, running → interrupt
 *     (with queued-message drop), and mashed esc-esc-sequences no longer
 *     swallow the arrow that follows them
 *   - scroll mode: arrow keys step ONE line while scrolled up, typing snaps
 *     back to the bottom
 *   - stats row: model · mode · tokens · elapsed · workspace after a run
 *
 * Drives TuiApp with injected fake stdin/stdout (no real TTY needed), the
 * same style as scripts/test-tui-app.ts.
 *
 * Run: bun scripts/test-tui-md.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import type { AgentHost } from '../packages/cli/src/host'
import { TuiApp, setAppColor, type AppIO } from '../packages/cli/src/tui-app'

/* ---------------- helpers ---------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ANSI_ONLY = /(\x1b\[[0-9;:<>?]*[A-Za-z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_ONLY, '')
}
const count = (s: string, needle: string): number => s.split(needle).length - 1

async function waitUntil(fn: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(20)
  }
  return fn()
}

class FakeOut {
  isTTY = true
  columns = 80
  rows = 24
  chunks: string[] = []
  write(s: string): void {
    this.chunks.push(s)
  }
  text(): string {
    return this.chunks.join('')
  }
}

class FakeIn {
  isTTY = true
  isRaw: boolean | undefined
  handlers: ((b: Buffer) => void)[] = []
  setRawMode(m: boolean): void {
    this.isRaw = m
  }
  resume(): void {}
  on(_e: 'data', f: (b: Buffer) => void): void {
    this.handlers.push(f)
  }
  removeListener(_e: 'data', f: (b: Buffer) => void): void {
    this.handlers = this.handlers.filter((h) => h !== f)
  }
}

class FakeHost {
  root: string
  bus = new EventEmitter()
  session: { id: string; title: string; mode: 'build' | 'plan'; todos: unknown[]; messages: unknown[] } | undefined
  sent: { text: string }[] = []
  responded: { id: string; approved: boolean; remember?: string }[] = []
  interrupted = 0
  cfg = {
    version: 1,
    defaultProvider: 'zai',
    defaultModel: 'glm-4.7',
    apiKeys: {} as Record<string, string>,
    customProviders: [] as unknown[],
    permissions: { defaultMode: 'ask', tools: {} },
    tools: { bash: true, browser: true },
    autoCheckpoint: true,
    maxTurns: 30,
    worklog: { enabled: true },
  }

  constructor(root: string) {
    this.root = root
  }

  listSessions(): unknown[] {
    return []
  }
  loadSession(): null {
    return null
  }
  sanitizeConfig(): Record<string, unknown> {
    return {
      defaultModel: this.cfg.defaultModel,
      defaultProvider: this.cfg.defaultProvider,
      caveman: false,
      worklog: { enabled: true },
      mcpStatus: [],
    }
  }
  newSession(mode: 'build' | 'plan' = 'build') {
    this.session = { id: 's1', title: 'test session', mode, todos: [], messages: [] }
    this.bus.emit('session:active', this.session)
    return this.session
  }
  async chatSend(text: string): Promise<unknown> {
    this.sent.push({ text })
    return { turns: 1, toolCalls: 0, finished: 'complete' }
  }
  interrupt(): void {
    this.interrupted += 1
  }
  permissionRespond(id: string, approved: boolean, remember?: string): boolean {
    this.responded.push({ id, approved, remember })
    return true
  }
  contextInfo(): { used: number; limit: number; pct: number; bar: string; estimated: boolean } {
    return { used: 0, limit: 131_072, pct: 0, bar: '0/131k [░░░░░░░░░░] 0%', estimated: true }
  }
  compactThreshold(): number {
    return 80
  }
  stats() {
    return { sessions: 0, snapshots: 0, context: this.contextInfo() }
  }
}

/* ---------------- harness ---------------- */

const tests: { name: string; fn: () => Promise<void> | void }[] = []
const test = (name: string, fn: () => Promise<void> | void) => tests.push({ name, fn })

let tmp = ''

function mkApp(host: FakeHost, opts: { columns?: number; rows?: number } = {}): { app: TuiApp; out: FakeOut } {
  const out = new FakeOut()
  out.columns = opts.columns ?? 80
  out.rows = opts.rows ?? 24
  const input = new FakeIn()
  const io: AppIO = { input: input as never, output: out as never }
  const app = new TuiApp(host as unknown as AgentHost, { workspaceRoot: host.root, updateCheck: false, io })
  void app.start()
  return { app, out }
}

async function started(host: FakeHost, opts: { columns?: number; rows?: number } = {}) {
  const ctx = mkApp(host, opts)
  await sleep(60) // init() + first frame
  return ctx
}

/** private-field accessor casts (test-only) */
type AppInternals = {
  onChunk(t: string): void
  onAssistantMessage(c: string): void
  mdRender: ((text: string, width?: number) => string[]) | undefined
  queued: string[]
  running: boolean
  send(t: string): Promise<void>
}
const internals = (app: TuiApp): AppInternals => app as unknown as AppInternals

const framePlain = (app: TuiApp): string => app.lastFrame.map(stripAnsi).join('\n')
const scrollPlain = (out: FakeOut): string => stripAnsi(out.text())

/* ---------------- tests ---------------- */

test('stream model: raw tail rides the sticky region, final markdown flushes to the scrollback exactly once', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  if (!(await waitUntil(() => internals(app).mdRender !== undefined))) throw new Error('renderMarkdown did not load at boot')
  // cumulative chunks, exactly like the throttled host stream
  host.bus.emit('agent:chunk', { text: 'streamed raw body line one\nstreamed raw body line two\n' })
  await sleep(10)
  app.renderNow()
  if (!framePlain(app).includes('streamed raw body line one')) throw new Error('precondition: raw stream should be visible while streaming')
  host.bus.emit('message:new', { message: { role: 'assistant', content: '# Report title\n\nfinal body line three\n' } })
  await sleep(20)
  app.renderNow()
  const rawCount = count(scrollPlain(out), 'streamed raw body line one')
  const plain = scrollPlain(out)
  if (count(plain, 'Report title') !== 1) throw new Error(`final message rendered ${count(plain, 'Report title')}x — want exactly 1`)
  if (count(plain, 'final body line three') !== 1) throw new Error('final message body missing or duplicated')
  // the message is DONE — further idle redraws must not resurrect the raw
  // stream or duplicate the markdown
  await sleep(60)
  app.renderNow()
  if (count(scrollPlain(out), 'streamed raw body line one') !== rawCount) throw new Error('raw stream still being drawn after the message completed')
  if (count(scrollPlain(out), 'Report title') !== 1) throw new Error('idle redraw duplicated the markdown message')
  // sticky no longer carries the message
  if (framePlain(app).includes('final body line three')) throw new Error('finished message still lingering in the sticky region')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('stream model: stub renderer isolates tui-app’s own flush logic', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  const a = internals(app)
  a.mdRender = (text: string) => text.split('\n').map((l) => `STUB>${l}`)
  a.onChunk('raw chunk alpha\nraw chunk beta\n')
  await sleep(10)
  a.onAssistantMessage('alpha\nbeta')
  await sleep(10)
  app.renderNow()
  const plain = scrollPlain(out)
  if (plain.includes('raw chunk')) throw new Error('stub run: raw lines reached the scrollback')
  if (!plain.includes('STUB>alpha') || !plain.includes('STUB>beta')) throw new Error('stub render output missing')
  if (count(plain, 'STUB>alpha') !== 1) throw new Error('stub render output duplicated')
  a.mdRender = undefined
  app.exit()
  await sleep(10)
  app.destroy()
})

test('stream model: interleaved tool line keeps everything, loses nothing', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  const a = internals(app)
  a.onChunk('part one\n')
  await sleep(10)
  app.println('  tool line interleave') // a tool card / notify line mid-stream
  a.onChunk('part one\npart two\n')
  await sleep(10)
  a.onAssistantMessage('part one\npart two\npart three')
  await sleep(10)
  app.renderNow()
  const plain = scrollPlain(out)
  if (count(plain, 'tool line interleave') !== 1) throw new Error('interleaved line lost or duplicated')
  if (count(plain, 'part one') !== 1) throw new Error(`"part one" appears ${count(plain, 'part one')}x — want exactly 1 (markdown flush)`)
  if (count(plain, 'part two') !== 1) throw new Error('"part two" duplicated or lost')
  if (count(plain, 'part three') !== 1) throw new Error('final tail missing')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('stream model: frozen permission buffer keeps everything, in order', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  const a = internals(app)
  host.bus.emit('permission:request', { id: 'p1', tool: 'bash', input: { command: 'ls' }, risk: 'high' })
  await sleep(20)
  a.onChunk('frozen one\n')
  await sleep(10)
  a.onAssistantMessage('frozen one\nfrozen two')
  await sleep(10)
  app.renderNow()
  if (scrollPlain(out).includes('frozen one')) throw new Error('precondition failed: lines must stay parked while frozen')
  app.feed('y') // allow once → flush
  await sleep(30)
  app.renderNow()
  const plain = scrollPlain(out)
  if (count(plain, 'frozen one') !== 1) throw new Error('frozen stream line lost or duplicated')
  if (count(plain, 'frozen two') !== 1) throw new Error('frozen tail lost or duplicated')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('esc priority: text → clear (no notice), idle → notice', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('typed draft')
  app.feed('\x1b') // esc with text → clear
  await sleep(90) // past the 50ms esc timer
  app.renderNow()
  let plain = framePlain(app)
  if (!plain.includes('Message tagent')) throw new Error('editor not cleared by esc')
  if (plain.includes('nothing to cancel')) throw new Error('esc with text must not show the idle notice')
  app.feed('\x1b') // esc idle → notice
  await sleep(90)
  app.renderNow()
  plain = framePlain(app)
  if (!plain.includes('nothing to cancel')) throw new Error('idle esc notice missing')
  if (host.interrupted !== 0) throw new Error('idle esc must not interrupt')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('esc while running: interrupt + queued messages dropped', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  const a = internals(app)
  let finishRun: (() => void) | undefined
  host.chatSend = async () =>
    new Promise((resolve) => {
      finishRun = () => resolve({ turns: 1, toolCalls: 0, finished: 'aborted' })
    })
  void a.send('first run')
  await sleep(30)
  if (!a.running) throw new Error('precondition: run must be live')
  app.feed('second message\r') // submit while running → queued
  await sleep(20)
  if (a.queued.length !== 1) throw new Error(`precondition: expected 1 queued message, got ${a.queued.length}`)
  app.feed('\x1b') // esc → interrupt
  await sleep(90)
  app.renderNow()
  const plain = scrollPlain(out)
  if (host.interrupted !== 1) throw new Error(`esc should interrupt once, got ${host.interrupted}`)
  if (!plain.includes('interrupting')) throw new Error('interrupting line missing from the scrollback')
  if (!plain.includes('1 queued message dropped')) throw new Error('queued-drop note missing')
  if (a.queued.length !== 0) throw new Error('queued messages were not dropped')
  finishRun?.()
  host.bus.emit('chat:done', { summary: { turns: 1, toolCalls: 0, finished: 'aborted' } })
  await sleep(20)
  app.exit()
  await sleep(10)
  app.destroy()
})

test('mashed esc-esc-arrow: the esc fires (editor cleared) and no bytes get typed', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('draft text') // editor has text — the esc must clear it
  app.feed('\x1b\x1b[A') // mashed: esc esc up-arrow in one burst
  await sleep(90)
  app.renderNow()
  const plain = framePlain(app)
  if (/\[A/.test(plain)) throw new Error('leftover sequence bytes were typed into the UI')
  if (!plain.includes('Message tagent')) throw new Error('the first esc of the mash must clear the editor text')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('up-arrow walks the input history on a single-line editor', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  const a = internals(app)
  // seed history through a real submit
  a.mdRender = undefined
  host.chatSend = async (text: string) => {
    host.sent.push({ text })
    return { turns: 1, toolCalls: 0, finished: 'complete' }
  }
  app.feed('first message\r')
  await sleep(30)
  a.running = false // the stub host never emits chat:done — reset the flag
  app.feed('second message\r')
  await sleep(30)
  if (host.sent.length !== 2) throw new Error(`precondition: 2 sends, got ${host.sent.length}`)
  app.feed('\x1b[A') // up → latest history entry
  app.renderNow()
  if (!app.lastFrame.map(stripAnsi).some((r) => r.includes('second message'))) throw new Error('up-arrow must recall the latest history entry')
  app.feed('\x1b[A') // up again → the first
  app.renderNow()
  if (!app.lastFrame.map(stripAnsi).some((r) => r.includes('first message'))) throw new Error('up-arrow must walk back through history')
  app.feed('\x1b[B') // down → forward again
  app.renderNow()
  if (!app.lastFrame.map(stripAnsi).some((r) => r.includes('second message'))) throw new Error('down-arrow must walk history forward')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('hint row: mode · model · tokens · elapsed after a run', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  host.bus.emit('chat:done', { summary: { turns: 1, toolCalls: 2, finished: 'complete', usage: { input: 1200, output: 45 } } })
  await sleep(20)
  app.renderNow()
  const rows = app.lastFrame.map(stripAnsi)
  const hint = rows.find((r) => r.includes('1.2k↑ 45↓'))
  if (!hint) throw new Error(`hint row with tokens missing — rows: ${rows.filter((r) => r.includes('·')).join(' | ')}`)
  if (!hint.includes('glm-4.7')) throw new Error(`hint row missing model: ${hint}`)
  if (!/\d+s/.test(hint)) throw new Error(`hint row missing elapsed time: ${hint}`)
  // …and it is the LAST sticky row, right under the editor box
  const boxBottom = rows.findIndex((r) => r.startsWith('╰'))
  const hintIdx = rows.indexOf(hint)
  if (hintIdx !== rows.length - 1) throw new Error(`hint row must be the last sticky row: idx=${hintIdx} of ${rows.length - 1}`)
  if (hintIdx <= boxBottom) throw new Error(`hint row must sit under the editor box: box=${boxBottom} hint=${hintIdx}`)
  app.exit()
  await sleep(10)
  app.destroy()
})

test('hint row: context bar replaces token counters once the limit is known', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host, { columns: 120 })
  // a run reports context state: 12.3k of 131k used → the bar renders
  host.bus.emit('context:update', { sessionId: 's1', used: 12_300, limit: 131_072, turn: 2 })
  await sleep(20)
  app.renderNow()
  let rows = app.lastFrame.map(stripAnsi)
  let hint = rows.find((r) => r.includes('12.3k/131.1k'))
  if (!hint) throw new Error(`context bar missing — rows: ${rows.filter((r) => r.includes('·')).join(' | ')}`)
  if (!/\[\u2588+\u2591+\]/.test(hint)) throw new Error(`bar blocks missing: ${hint}`)
  if (!hint.includes('9%')) throw new Error(`percentage missing: ${hint}`)
  if (!hint.includes('glm-4.7')) throw new Error(`model missing: ${hint}`)
  if (hint.includes('↑')) throw new Error(`token counters should be replaced by the bar: ${hint}`)
  // crossing 80% keeps the bar (and marks the offer pending — covered by host tests)
  host.bus.emit('context:update', { sessionId: 's1', used: 110_000, limit: 131_072, turn: 9 })
  await sleep(20)
  app.renderNow()
  rows = app.lastFrame.map(stripAnsi)
  hint = rows.find((r) => r.includes('110k/131.1k'))
  if (!hint) throw new Error(`updated bar missing: ${rows.join(' | ')}`)
  if (!hint.includes('84%')) throw new Error(`84% missing: ${hint}`)
  app.exit()
  await sleep(10)
  app.destroy()
})

/* ---------------- run ---------------- */

setAppColor(true)

async function main(): Promise<void> {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-tui-md-'))

  let failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      console.log(`${t.name}: OK`)
    } catch (e) {
      failed += 1
      console.log(`${t.name}: FAIL — ${(e as Error).message}`)
    }
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch { /* ignore */ }
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILING`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
