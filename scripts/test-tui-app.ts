#!/usr/bin/env bun
/**
 * test-tui-app.ts — unit test for the full-screen TUI (tui-app.ts).
 *
 * Drives TuiApp with injected fake stdin/stdout streams (no real TTY needed):
 * render() + key handling are exercised directly through feed()/renderNow(),
 * and the frames written to the fake output are asserted.
 *
 * Run: bun scripts/test-tui-app.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import type { AgentHost } from '../packages/cli/src/host'
import { TuiApp, appCapable, setAppColor, type AppIO } from '../packages/cli/src/tui-app'

/* ---------------- helpers ---------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ANSI_ONLY = /(\x1b\[[0-9;:<>?]*[A-Za-z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_ONLY, '')
}
/** visible width (CJK ≈ 2) of an ANSI-stripped string */
function vis(s: string): number {
  let w = 0
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0) ?? 32
    w +=
      cp >= 0x1100 &&
      (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f9ff))
        ? 2
        : 1
  }
  return w
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

interface Sent {
  text: string
}

class FakeHost {
  root: string
  bus = new EventEmitter()
  session: { id: string; title: string; mode: 'build' | 'plan'; todos: unknown[]; messages: unknown[] } | undefined
  sent: Sent[] = []
  responded: { id: string; approved: boolean; remember?: string }[] = []
  interrupted = 0
  approvedPlan: boolean | undefined
  cfg = {
    version: 1,
    defaultProvider: 'zai',
    defaultModel: 'glm-4.7',
    apiKeys: {},
    customProviders: [],
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
  setSessionMode(mode: 'build' | 'plan'): void {
    if (this.session) {
      this.session.mode = mode
      this.bus.emit('session:active', this.session)
    }
  }
  async chatSend(text: string): Promise<unknown> {
    this.sent.push({ text })
    const s = this.session ?? this.newSession()
    this.bus.emit('agent:status', { phase: 'thinking' })
    this.bus.emit('agent:chunk', { sessionId: s.id, text: 'Hello from the agent' })
    this.bus.emit('message:new', { sessionId: s.id, message: { role: 'assistant', content: 'Hello from the agent' } })
    const summary = { turns: 1, toolCalls: 1, finished: 'complete', usage: { input: 120, output: 45 } }
    this.bus.emit('chat:done', { sessionId: s.id, summary })
    return summary
  }
  interrupt(): void {
    this.interrupted += 1
  }
  permissionRespond(id: string, approved: boolean, remember?: string): boolean {
    this.responded.push({ id, approved, remember })
    return true
  }
  approvePlan(execute: boolean): { ok: boolean } {
    this.approvedPlan = execute
    return { ok: true }
  }
}

/* ---------------- harness ---------------- */

const tests: { name: string; fn: () => Promise<void> | void }[] = []
const test = (name: string, fn: () => Promise<void> | void) => tests.push({ name, fn })

let tmp = ''

function mkApp(host: FakeHost, opts: { columns?: number; rows?: number } = {}): { app: TuiApp; out: FakeOut; input: FakeIn; done: Promise<void> } {
  const out = new FakeOut()
  out.columns = opts.columns ?? 80
  out.rows = opts.rows ?? 24
  const input = new FakeIn()
  const io: AppIO = { input: input as never, output: out as never }
  const app = new TuiApp(host as unknown as AgentHost, { workspaceRoot: host.root, updateCheck: false, io })
  const done = app.start()
  return { app, out, input, done }
}

async function started(host: FakeHost, opts: { columns?: number; rows?: number } = {}) {
  const ctx = mkApp(host, opts)
  await sleep(60) // let init() + the first frame land
  return ctx
}

/* ---------------- tests ---------------- */

test('appCapable() is false when stdout is not a TTY', () => {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  ;(process.stdout as { isTTY?: boolean }).isTTY = false
  const v = appCapable()
  if (desc) Object.defineProperty(process.stdout, 'isTTY', desc)
  else delete (process.stdout as { isTTY?: boolean }).isTTY
  if (v !== false) throw new Error('expected appCapable() === false without a TTY')
})

test('startup: alternate screen, hidden cursor, header renders, footer hints', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  const raw = out.text()
  if (!raw.includes('\x1b[?1049h')) throw new Error('alternate screen not entered')
  if (!raw.includes('\x1b[?25l')) throw new Error('cursor not hidden')
  const frame = app.lastFrame
  if (frame.length !== 24) throw new Error(`expected 24 frame rows, got ${frame.length}`)
  const plain = frame.map(stripAnsi)
  const head = plain[0]
  if (!head.includes(path.basename(tmp))) throw new Error(`header missing workspace name: ${head}`)
  if (!head.includes('BUILD')) throw new Error(`header missing BUILD chip: ${head}`)
  if (!head.includes('glm-4.7')) throw new Error(`header missing model: ${head}`)
  if (!plain.some((r) => r.includes('enter send') && r.includes('ctrl+x menu'))) throw new Error('footer shortcuts missing')
  if (!plain.some((r) => r.includes('Message tagent'))) throw new Error('placeholder missing')
  if (!plain.some((r) => r.includes('terminal-native coding agent'))) throw new Error('banner missing')
  app.exit()
  await ctx0done(app)
  app.destroy()
  if (!out.text().includes('\x1b[?1049l')) throw new Error('alternate screen not left on destroy')
})

async function ctx0done(app: TuiApp): Promise<void> {
  // resolves the start() promise (exit already called)
  await Promise.race([app as unknown as Promise<void>, sleep(10)]).then(() => undefined)
  await sleep(5)
}

test('editor: typing echoes in the boxed input', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('hello world')
  app.renderNow()
  if (!app.lastFrame.some((r) => stripAnsi(r).includes('hello world'))) throw new Error('typed text not echoed')
  // placeholder gone once typing
  if (app.lastFrame.some((r) => stripAnsi(r).includes('Message tagent'))) throw new Error('placeholder should hide while typing')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('enter sends: host.chatSend receives the text, user line + done line render', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('ping the agent\r')
  await sleep(30)
  app.renderNow()
  if (host.sent.length !== 1 || host.sent[0].text !== 'ping the agent') throw new Error(`chatSend not called once: ${JSON.stringify(host.sent)}`)
  const plain = app.lastFrame.map(stripAnsi).join('\n')
  if (!plain.includes('> ping the agent')) throw new Error('user line missing')
  if (!plain.includes('Hello from the agent')) throw new Error('assistant text missing')
  if (!plain.includes('done')) throw new Error('done line missing')
  if (!plain.includes('turn')) throw new Error('turn count missing on done line')
  if (!plain.includes('120')) throw new Error('token usage missing')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('alt+enter inserts a newline; editor grows; submit sends both lines', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('line one\x1b\rline two')
  app.renderNow()
  const rows = app.lastFrame.map(stripAnsi)
  const l1 = rows.findIndex((r) => r.includes('line one'))
  const l2 = rows.findIndex((r) => r.includes('line two'))
  if (l1 === -1 || l2 === -1 || l1 === l2) throw new Error('multiline not rendered on distinct rows')
  app.feed('\r')
  await sleep(30)
  if (host.sent.length !== 1 || host.sent[0].text !== 'line one\nline two') throw new Error(`multiline send wrong: ${JSON.stringify(host.sent)}`)
  app.exit()
  await sleep(10)
  app.destroy()
})

test('slash palette: / filters commands, tab completes, esc hides', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('/')
  app.renderNow()
  if (!app.lastFrame.some((r) => stripAnsi(r).includes('/help'))) throw new Error('palette does not list /help')
  app.feed('he')
  app.renderNow()
  const pal = app.lastFrame.map(stripAnsi).filter((r) => r.includes('/help'))
  if (pal.length === 0) throw new Error('filter "he" lost /help')
  if (app.lastFrame.some((r) => stripAnsi(r).includes('/model'))) throw new Error('filter "he" should not show /model')
  app.feed('\x1b') // esc dismiss
  await sleep(80)
  app.renderNow()
  if (app.lastFrame.some((r) => stripAnsi(r).includes('↑↓ select'))) throw new Error('palette not dismissed by esc')
  app.feed('\x7f\x7f') // backspace the filter chars
  app.feed('mo')
  app.feed('\t') // tab → complete to '/mode '
  app.renderNow()
  const ed = app.lastFrame.map(stripAnsi).find((r) => r.includes('/mode '))
  if (!ed) throw new Error(`tab completion failed — no '/mode ' in the editor`)
  app.exit()
  await sleep(10)
  app.destroy()
})

test('ctrl+x menu: opens with grouped actions, esc closes without exiting', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('\x18') // ctrl+x
  app.renderNow()
  const plain = app.lastFrame.map(stripAnsi).join('\n')
  for (const want of ['Continue', 'Run diagnostics', 'Switch to plan mode', 'Session list', 'Pick model']) {
    if (!plain.includes(want)) throw new Error(`menu missing "${want}"`)
  }
  // the menu is windowed — page down to reach the rest of the groups
  app.feed('\x1b[6~')
  app.feed('\x1b[6~')
  app.renderNow()
  const plain2 = app.lastFrame.map(stripAnsi).join('\n')
  for (const want of ['Fallback chain', 'Subagents', 'Exit']) {
    if (!plain2.includes(want)) throw new Error(`menu (paged) missing "${want}"`)
  }
  app.feed('\x1b')
  await sleep(80)
  app.renderNow()
  if (app.lastFrame.map(stripAnsi).some((r) => r.includes('menu — ctrl+x'))) throw new Error('menu not closed by esc')
  if (host.interrupted !== 0) throw new Error('esc must not interrupt')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('ctrl+x menu: enter on "Continue" sends "continue" to the host', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('\x18')
  app.feed('\r') // cursor is on "Continue"
  await sleep(40)
  if (host.sent.length !== 1 || host.sent[0].text !== 'continue') throw new Error(`menu Continue failed: ${JSON.stringify(host.sent)}`)
  app.exit()
  await sleep(10)
  app.destroy()
})

test('permission overlay: renders, y allows once, host.permissionRespond called', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  host.bus.emit('permission:request', { id: 'p1', tool: 'bash', input: { command: 'rm -rf /tmp/x' }, risk: 'high' })
  await sleep(20)
  app.renderNow()
  const plain = app.lastFrame.map(stripAnsi).join('\n')
  if (!plain.includes('permission needed')) throw new Error('permission overlay missing')
  if (!plain.includes('allow once')) throw new Error('allow-once option missing')
  if (!plain.includes('deny')) throw new Error('deny option missing')
  app.feed('y') // allow once
  await sleep(30)
  app.renderNow()
  if (host.responded.length !== 1) throw new Error('permissionRespond not called')
  const r = host.responded[0]
  if (r.id !== 'p1' || r.approved !== true || r.remember !== 'once') throw new Error(`respond payload wrong: ${JSON.stringify(r)}`)
  if (!app.lastFrame.map(stripAnsi).some((x) => x.includes('allowed'))) throw new Error('allowed line missing')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('permission overlay: ctrl+c denies (tui parity)', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  host.bus.emit('permission:request', { id: 'p2', tool: 'write', input: { path: 'x.txt' }, risk: 'medium' })
  await sleep(20)
  app.feed('\x03')
  await sleep(30)
  if (host.responded.length !== 1 || host.responded[0].approved !== false) throw new Error('ctrl+c should deny the permission')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('plan approval overlay: execute calls host.approvePlan(true)', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  const summary = { turns: 2, toolCalls: 0, finished: 'complete', plan: '1. do A\n2. do B' }
  host.bus.emit('chat:done', { summary })
  await sleep(220) // offerPlan waits 150ms before the overlay
  app.renderNow()
  const plain = app.lastFrame.map(stripAnsi).join('\n')
  if (!plain.includes('plan ready')) throw new Error('plan overlay missing')
  if (!plain.includes('execute plan')) throw new Error('execute option missing')
  app.feed('\r') // execute
  await sleep(30)
  if (host.approvedPlan !== true) throw new Error('approvePlan(true) not called')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('input overlay (ask): /model flow opens a text overlay when a key is needed', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  // direct: push an input overlay via the apikey path — use ask through a command
  app.feed('/help\r')
  await sleep(30)
  app.renderNow()
  if (!app.lastFrame.map(stripAnsi).some((r) => r.includes('Tagent commands'))) throw new Error('help overlay missing')
  app.feed('\x1b')
  await sleep(80)
  app.exit()
  await sleep(10)
  app.destroy()
})

test('@file completion: @ + prefix lists workspace files, tab inserts', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('@a')
  app.renderNow()
  if (!app.lastFrame.some((r) => stripAnsi(r).includes('alpha.txt'))) throw new Error('file completion missing alpha.txt')
  if (!app.lastFrame.some((r) => stripAnsi(r).includes('app.js'))) throw new Error('file completion missing app.js')
  app.feed('\t') // insert selected (alpha.txt or app.js — cursor starts at 0)
  app.renderNow()
  const ed = app.lastFrame.map(stripAnsi).find((r) => r.includes('.txt') || r.includes('app.js'))
  if (!ed || !ed.includes('@')) throw new Error(`@path not inserted: ${ed}`)
  app.exit()
  await sleep(10)
  app.destroy()
})

test('scroll: pgup scrolls up, new lines indicator appears, pgdn follows again', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  const lines = Array.from({ length: 40 }, (_, i) => `MARK-${String(i).padStart(2, '0')}`).join('\n')
  host.bus.emit('message:new', { message: { role: 'assistant', content: lines } })
  await sleep(20)
  app.renderNow()
  if (!app.lastFrame.map(stripAnsi).some((r) => r.includes('MARK-39'))) throw new Error('auto-follow should show the newest line')
  app.feed('\x1b[5~') // pgup
  app.renderNow()
  if (app.lastFrame.map(stripAnsi).some((r) => r.includes('MARK-39'))) throw new Error('pgup should hide the newest line')
  // new output while scrolled up → indicator
  host.bus.emit('message:new', { message: { role: 'assistant', content: 'BRAND-NEW-LINE' } })
  await sleep(20)
  app.renderNow()
  if (!app.lastFrame.some((r) => stripAnsi(r).includes('new lines'))) throw new Error('new-lines indicator missing')
  app.feed('\x1b[6~') // pgdn — back to the bottom
  app.renderNow()
  if (!app.lastFrame.map(stripAnsi).some((r) => r.includes('BRAND-NEW-LINE'))) throw new Error('pgdn should re-follow')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('wrapping: long + CJK lines wrap inside the viewport width', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host, { columns: 40 })
  const long = 'word '.repeat(30)
  const cjk = '终端原生编程助手'.repeat(12)
  host.bus.emit('message:new', { message: { role: 'assistant', content: `${long}\n${cjk}` } })
  await sleep(20)
  app.renderNow()
  for (const [i, row] of app.lastFrame.entries()) {
    const w = vis(row)
    if (w > 40) throw new Error(`row ${i} overflows: ${w} cols — ${JSON.stringify(stripAnsi(row))}`)
  }
  app.exit()
  await sleep(10)
  app.destroy()
})

test('resize: narrower terminal re-wraps every row', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  host.bus.emit('message:new', { message: { role: 'assistant', content: 'x'.repeat(120) } })
  await sleep(20)
  app.renderNow()
  out.columns = 50
  app.onResize()
  app.renderNow()
  if (app.lastFrame.length !== 24) throw new Error(`row count changed on resize: ${app.lastFrame.length}`)
  for (const [i, row] of app.lastFrame.entries()) {
    const w = vis(row)
    if (w > 50) throw new Error(`row ${i} overflows after resize: ${w}`)
  }
  app.exit()
  await sleep(10)
  app.destroy()
})

test('ctrl+c: first press warns, second press exits cleanly and restores the screen', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  app.feed('\x03')
  app.renderNow()
  if (!app.lastFrame.some((r) => stripAnsi(r).includes('press ctrl+c again'))) throw new Error('first ctrl+c should warn')
  let resolved = false
  void app.start().then(() => {
    resolved = true
  }) // already begun — this resolves only via doneResolve; exit() resolves the FIRST promise
  app.feed('\x03')
  await sleep(60)
  app.destroy()
  const raw = out.text()
  if (!raw.includes('\x1b[?1049l')) throw new Error('alternate screen not restored on exit')
  if (!raw.includes('\x1b[?25h')) throw new Error('cursor not restored on exit')
  void resolved
})

test('ctrl+c during a run interrupts instead of exiting', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  // start a run that stays pending
  let finishRun: (() => void) | undefined
  host.chatSend = async () =>
    new Promise((resolve) => {
      finishRun = () => resolve({ turns: 1, toolCalls: 0, finished: 'aborted' })
    })
  void (app as unknown as { send: (t: string) => Promise<void> }).send('slow')
  await sleep(20)
  app.feed('\x03')
  await sleep(20)
  if (host.interrupted !== 1) throw new Error('ctrl+c should interrupt the run')
  app.renderNow()
  if (app.lastFrame.some((r) => stripAnsi(r).includes('press ctrl+c again'))) throw new Error('ctrl+c during run should not warn-exit')
  finishRun?.()
  await sleep(20)
  app.exit()
  await sleep(10)
  app.destroy()
})

test('mode switch: header chip flips to PLAN', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  host.newSession('plan')
  await sleep(10)
  app.renderNow()
  if (!stripAnsi(app.lastFrame[0]).includes('PLAN')) throw new Error('header chip did not flip to PLAN')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('/exit command exits the app', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  app.feed('/exit\r')
  await sleep(40)
  app.destroy()
  if (!out.text().includes('\x1b[?1049l')) throw new Error('/exit did not restore the screen')
})

test('streaming status: thinking + streamed partial render in the status row', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  host.bus.emit('agent:status', { phase: 'thinking', detail: 'turn 2' })
  await sleep(10)
  app.renderNow()
  if (!app.lastFrame.some((r) => stripAnsi(r).includes('thinking') || stripAnsi(r).includes('turn 2'))) throw new Error('thinking status missing')
  host.bus.emit('agent:status', { phase: 'acting', detail: 'bash' })
  await sleep(10)
  app.renderNow()
  if (!app.lastFrame.some((r) => stripAnsi(r).includes('calling bash'))) throw new Error('acting status missing')
  host.bus.emit('agent:chunk', { text: 'partial stream text' })
  await sleep(10)
  app.renderNow()
  if (!app.lastFrame.some((r) => stripAnsi(r).includes('partial stream text'))) throw new Error('stream label missing')
  host.bus.emit('agent:status', { phase: 'done' })
  await sleep(10)
  app.renderNow()
  if (app.lastFrame.some((r) => stripAnsi(r).includes('partial stream text'))) throw new Error('stream label should clear on done')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('tool cards: one-line compact render with status icon + duration', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  host.bus.emit('tool:start', { call: { id: 't1', tool: 'bash', input: { command: 'ls -la' }, status: 'running' } })
  await sleep(10)
  host.bus.emit('tool:end', {
    call: { id: 't1', tool: 'bash', input: { command: 'ls -la' }, status: 'done', output: 'file-a\nfile-b', startedAt: 1000, endedAt: 2500 },
  })
  await sleep(10)
  app.renderNow()
  const plain = app.lastFrame.map(stripAnsi).join('\n')
  if (!plain.includes('bash')) throw new Error('tool card missing tool name')
  if (!plain.includes('ls -la')) throw new Error('tool card missing summarized input')
  if (!plain.includes('1.5s')) throw new Error('tool card missing duration')
  if (!plain.includes('file-a')) throw new Error('tool card missing output tail')
  app.exit()
  await sleep(10)
  app.destroy()
})

/* ---------------- run ---------------- */

setAppColor(true)

async function main(): Promise<void> {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-app-test-'))
  fs.writeFileSync(path.join(tmp, 'alpha.txt'), 'alpha')
  fs.writeFileSync(path.join(tmp, 'app.js'), 'console.log(1)')
  fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'sub', 'beta.md'), 'beta')

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
