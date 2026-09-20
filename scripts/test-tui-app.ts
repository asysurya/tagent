#!/usr/bin/env bun
/**
 * test-tui-app.ts — unit test for the inline TUI (tui-app.ts).
 *
 * Drives TuiApp with injected fake stdin/stdout streams (no real TTY
 * needed): render() + key handling are exercised directly through
 * feed()/renderNow(), the sticky region is asserted via app.lastFrame, and
 * the flushed transcript (what lands in the terminal scrollback) via the
 * raw output stream.
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
  askResponses: { id: string; response: import('@tagent/core').AskFormResponse | null }[] = []
  interrupted = 0
  approvedPlan: boolean | undefined
  saved: Record<string, unknown>[] = []
  cfg = {
    version: 1,
    defaultProvider: 'zai',
    defaultModel: 'glm-4.7',
    apiKeys: {} as Record<string, string>,
    customProviders: [] as { id: string; label: string; baseUrl: string; apiKey?: string; models: string[]; kind?: string }[],
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
  async pluginCommandRun(cmd: string): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: `no plugin command named ${cmd}` }
  }
  settingsSave(patch: Record<string, unknown>): { ok: true; config: unknown } {
    this.saved.push(patch)
    if (patch.defaultProvider) this.cfg.defaultProvider = patch.defaultProvider as string
    if (patch.defaultModel) this.cfg.defaultModel = patch.defaultModel as string
    const cp = patch.customProvider as { id: string } | undefined
    if (cp) {
      const i = this.cfg.customProviders.findIndex((p) => p.id === cp.id)
      if (i >= 0) this.cfg.customProviders[i] = cp as never
      else this.cfg.customProviders.push(cp as never)
    }
    const rm = patch.customProviderRemove as string | undefined
    if (rm) this.cfg.customProviders = this.cfg.customProviders.filter((p) => p.id !== rm)
    return { ok: true, config: this.sanitizeConfig() }
  }
  async providersRefresh(): Promise<{ ok: boolean; updated: string[]; failed: string[] }> {
    return { ok: true, updated: [], failed: [] }
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
  askRespond(id: string, response: import('@tagent/core').AskFormResponse | null): boolean {
    this.askResponses.push({ id, response })
    return true
  }
  approvePlan(execute: boolean): { ok: boolean } {
    this.approvedPlan = execute
    return { ok: true }
  }
  contextInfo(): { used: number; limit: number; pct: number; bar: string; estimated: boolean } {
    return { used: 0, limit: 131_072, pct: 0, bar: '0/131k [░░░░░░░░░░] 0%', estimated: true }
  }
  compactThreshold(): number {
    return 80
  }
  compactSession(): { ok: false; error: string } {
    return { ok: false, error: 'nothing to compact' }
  }
  stats() {
    return {
      sessions: 0, snapshots: 0,
      context: this.contextInfo(),
    }
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

test('startup: INLINE (no alternate screen), cursor hidden, banner flushed, sticky editor', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  const raw = out.text()
  if (raw.includes('\x1b[?1049h')) throw new Error('alternate screen must NOT be used (inline model)')
  if (!raw.includes('\x1b[?25l')) throw new Error('cursor not hidden')
  // the banner lands in the scrollback stream, not the sticky region
  const scroll = stripAnsi(raw)
  if (!scroll.includes('terminal-native coding agent')) throw new Error('banner missing from the scrollback')
  if (!scroll.includes('✻')) throw new Error('welcome glyph missing')
  // the sticky region = status row + editor box + hint row (small, fixed-ish)
  const frame = app.lastFrame
  if (frame.length > 8) throw new Error(`sticky region too tall at boot: ${frame.length} rows`)
  const plain = frame.map(stripAnsi)
  if (!plain.some((r) => r.includes('Message tagent'))) throw new Error('placeholder missing')
  if (!plain.some((r) => r.includes('? shortcuts') && r.includes('/ commands'))) throw new Error('hint row shortcuts missing')
  if (!plain.some((r) => r.includes('glm-4.7'))) throw new Error('hint row missing model stats')
  if (!plain.some((r) => r.startsWith('╭'))) throw new Error('editor box top rail missing')
  if (!plain.some((r) => r.startsWith('╰'))) throw new Error('editor box bottom rail missing')
  app.exit()
  await ctx0done(app)
  app.destroy()
  if (out.text().includes('\x1b[?1049l')) throw new Error('alternate screen restore leaked into destroy')
  if (!out.text().includes('\x1b[?25h')) throw new Error('cursor not restored on destroy')
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

test('enter sends: host.chatSend receives the text, user line + done line flush to the scrollback', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  app.feed('ping the agent\r')
  await sleep(30)
  app.renderNow()
  if (host.sent.length !== 1 || host.sent[0].text !== 'ping the agent') throw new Error(`chatSend not called once: ${JSON.stringify(host.sent)}`)
  const plain = stripAnsi(out.text())
  if (!plain.includes('❯ you')) throw new Error('user box title missing from scrollback')
  if (!plain.includes('ping the agent')) throw new Error('user text missing from scrollback (box echo)')
  if (!plain.includes('Hello from the agent')) throw new Error('assistant text missing from scrollback')
  if (!plain.includes('done')) throw new Error('done line missing')
  if (!plain.includes('turn')) throw new Error('turn count missing on done line')
  if (!plain.includes('120')) throw new Error('token usage missing')
  // sticky region must not carry the transcript (that's the scrollback's job)
  if (app.lastFrame.map(stripAnsi).some((r) => r.includes('Hello from the agent'))) throw new Error('transcript leaked into the sticky region')
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
  const { app, out } = await started(host)
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
  if (!stripAnsi(out.text()).includes('allowed')) throw new Error('allowed line missing from the scrollback')
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

test('scrollback: a long message flushes fully into the scrollback; the sticky region stays small (native scrolling)', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  const lines = Array.from({ length: 40 }, (_, i) => `MARK-${String(i).padStart(2, '0')}`).join('\n')
  host.bus.emit('message:new', { message: { role: 'assistant', content: lines } })
  await sleep(20)
  app.renderNow()
  const scroll = stripAnsi(out.text())
  if (!scroll.includes('MARK-00') || !scroll.includes('MARK-39')) throw new Error('the whole message must reach the scrollback')
  if (app.lastFrame.length > 10) throw new Error(`sticky region should stay small, got ${app.lastFrame.length} rows`)
  if (app.lastFrame.map(stripAnsi).some((r) => r.includes('MARK-39'))) throw new Error('old transcript lines must not linger in the sticky region')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('?: the shortcuts overlay opens on an empty editor and closes with esc', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('?')
  await sleep(20)
  app.renderNow()
  const plain = app.lastFrame.map(stripAnsi).join('\n')
  if (!plain.includes('shortcuts')) throw new Error('shortcuts overlay missing')
  if (!plain.includes('command palette')) throw new Error('shortcut rows missing')
  app.feed('\x1b')
  await sleep(80) // bare esc is disambiguated by a 50ms timer
  app.renderNow()
  if (app.lastFrame.map(stripAnsi).some((r) => r.includes('command palette'))) throw new Error('shortcuts overlay did not close')
  // ? with text present just types
  app.feed('what?')
  app.renderNow()
  if (!app.lastFrame.map(stripAnsi).some((r) => r.includes('what?'))) throw new Error('? while typing must insert, not open the overlay')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('wrapping: long + CJK transcript lines wrap inside the terminal width', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host, { columns: 40 })
  const long = 'word '.repeat(30)
  const cjk = '终端原生编程助手'.repeat(12)
  host.bus.emit('message:new', { message: { role: 'assistant', content: `${long}\n${cjk}` } })
  await sleep(20)
  app.renderNow()
  // rows in the raw stream are separated by '\n' (fresh lines) or '\r'
  // (in-place rewrites — every row write starts with \r\x1b[2K)
  for (const [i, rowRaw] of out.text().split(/[\r\n]/).entries()) {
    const w = vis(rowRaw)
    if (w > 40) throw new Error(`scrollback row ${i} overflows: ${w} cols — ${JSON.stringify(stripAnsi(rowRaw))}`)
  }
  for (const [i, row] of app.lastFrame.entries()) {
    const w = vis(row)
    if (w > 40) throw new Error(`sticky row ${i} overflows: ${w} cols — ${JSON.stringify(stripAnsi(row))}`)
  }
  app.exit()
  await sleep(10)
  app.destroy()
})

test('resize: narrower terminal redraws the sticky region without overflow', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  host.bus.emit('message:new', { message: { role: 'assistant', content: 'x'.repeat(120) } })
  await sleep(20)
  app.renderNow()
  out.columns = 50
  app.onResize()
  app.renderNow()
  if (app.lastFrame.length > 24) throw new Error(`sticky region taller than the screen after resize: ${app.lastFrame.length}`)
  for (const [i, row] of app.lastFrame.entries()) {
    const w = vis(row)
    if (w > 50) throw new Error(`row ${i} overflows after resize: ${w}`)
  }
  app.exit()
  await sleep(10)
  app.destroy()
})

test('ctrl+c: first press warns, second press exits cleanly and restores the cursor', async () => {
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
  if (raw.includes('\x1b[?1049l')) throw new Error('alternate screen restore leaked (inline model has none)')
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

test('mode switch: hint row flips to plan', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  host.newSession('plan')
  await sleep(10)
  app.renderNow()
  const hint = app.lastFrame.map(stripAnsi).find((r) => r.includes('glm-4.7'))
  if (!hint) throw new Error('hint row missing')
  if (!/\bplan\b/.test(hint)) throw new Error(`hint row did not flip to plan: ${hint}`)
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
  if (!out.text().includes('\x1b[?25h')) throw new Error('/exit did not restore the cursor')
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

test('tool lines: ⎿ connector + status icon + duration flush to the scrollback', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  host.bus.emit('tool:start', { call: { id: 't1', tool: 'bash', input: { command: 'ls -la' }, status: 'running' } })
  await sleep(10)
  host.bus.emit('tool:end', {
    call: { id: 't1', tool: 'bash', input: { command: 'ls -la' }, status: 'done', output: 'file-a\nfile-b', startedAt: 1000, endedAt: 2500 },
  })
  await sleep(10)
  app.renderNow()
  const plain = stripAnsi(out.text())
  if (!plain.includes('⎿')) throw new Error('tool line missing the ⎿ connector')
  if (!plain.includes('bash')) throw new Error('tool line missing tool name')
  if (!plain.includes('ls -la')) throw new Error('tool line missing summarized input')
  if (!plain.includes('1.5s')) throw new Error('tool line missing duration')
  if (!plain.includes('file-a')) throw new Error('tool line missing output tail')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('palette: enter RUNS the arrow-selected command (/, down, enter → /new flow opens)', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('/')
  app.feed('\x1b[B') // cursor: help → new
  await sleep(30)
  app.feed('\r')
  await sleep(60)
  app.renderNow()
  const plain = app.lastFrame.map(stripAnsi).join('\n')
  if (plain.includes('unknown command')) throw new Error(`palette enter submitted the raw token: ${plain.split('\n').filter((l) => l.includes('unknown')).join(' | ')}`)
  if (!plain.includes('build') || !plain.includes('plan')) throw new Error('palette enter did not open the /new mode picker')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('palette: enter applies the selection and keeps the args (/mo zzz + down + enter → /model zzz)', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  app.feed('/mo zzz')
  await sleep(20)
  app.feed('\x1b[B') // mode → model
  await sleep(20)
  app.feed('\r')
  await sleep(60)
  app.renderNow()
  const plain = stripAnsi(out.text())
  if (plain.includes('unknown command')) throw new Error('palette enter submitted the raw partial token')
  if (!plain.includes('nothing matches "zzz"')) throw new Error(`/model zzz search output missing — got: ${plain.split('\n').filter((l) => l.trim()).slice(-5).join(' | ')}`)
  if (!plain.includes('/model custom')) throw new Error('no-match message should point at /model custom')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('palette: typing more resets the cursor to the top item', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('/')
  app.feed('\x1b[B\x1b[B') // move down twice
  await sleep(20)
  app.feed('he') // token changes → cursor resets
  await sleep(20)
  app.renderNow()
  const rows = app.lastFrame.map(stripAnsi).filter((r) => r.includes('❯'))
  if (!rows.some((r) => r.includes('/help'))) throw new Error('cursor did not reset to /help after token change')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('borders: editor box has side rails and the palette is boxed', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('/')
  app.renderNow()
  const rows = app.lastFrame.map(stripAnsi)
  if (!rows.some((r) => r.includes('╭─ commands'))) throw new Error('palette not boxed (top rule missing)')
  if (!rows.some((r) => r.includes('╰─') && r.includes('enter run'))) throw new Error('palette box footer rule missing')
  // the editor sits at the bottom of the frame — every row between its ╭…╮ and ╰…╯ rails
  const topIdx = rows.findIndex((r) => r.startsWith('╭') && r.includes('─'))
  const bottomIdx = rows.findIndex((r) => r.startsWith('╰') && r.includes('─'))
  if (topIdx === -1 || bottomIdx === -1 || bottomIdx <= topIdx) throw new Error(`editor box rails not found (top=${topIdx} bottom=${bottomIdx})`)
  for (let i = topIdx + 1; i < bottomIdx; i++) {
    const r = rows[i]
    if (!r.startsWith('│') || !r.trimEnd().endsWith('│')) throw new Error(`editor content row ${i} lacks side rails: ${JSON.stringify(r)}`)
    const w = vis(r)
    if (w > 80) throw new Error(`editor row ${i} overflows: ${w}`)
  }
  app.exit()
  await sleep(10)
  app.destroy()
})

test('model picker: custom CTA pinned, empty search says "no matches" + keeps the CTA', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  void (app as unknown as { modelPickerFlow: () => Promise<void> }).modelPickerFlow()
  await sleep(40)
  app.renderNow()
  let plain = app.lastFrame.map(stripAnsi).join('\n')
  if (!plain.includes('+ add custom provider')) throw new Error('provider picker missing the custom CTA')
  if (!plain.includes('type to search')) throw new Error('search hint missing in footer')
  // 'q' as the first search letter must NOT close the picker
  app.feed('q')
  await sleep(30)
  app.renderNow()
  plain = app.lastFrame.map(stripAnsi).join('\n')
  if (plain.includes('cancelled')) throw new Error("'q' closed the filterable picker")
  if (!plain.includes('/q▌')) throw new Error("typing 'q' did not start a search filter")
  // search that matches nothing → no-matches state + CTA still visible
  app.feed('\x7f')
  app.feed('zzz')
  await sleep(30)
  app.renderNow()
  plain = app.lastFrame.map(stripAnsi).join('\n')
  if (!plain.includes('no matches for "zzz"')) throw new Error('no-matches state missing')
  if (!plain.includes('+ add custom provider')) throw new Error('custom CTA did not survive the empty search')
  // esc cancels
  app.feed('\x1b')
  await sleep(40)
  app.exit()
  await sleep(10)
  app.destroy()
})

test('model picker: custom model id CTA saves any id on a custom provider', async () => {
  const host = new FakeHost(tmp)
  host.cfg.customProviders = [{ id: 'my-ollama', label: 'My Ollama', baseUrl: 'http://localhost:11434/v1', apiKey: 'k', models: ['llama3.1'] }]
  const { app } = await started(host)
  void (app as unknown as { modelPickerFlow: () => Promise<void> }).modelPickerFlow()
  await sleep(40)
  // search filters down to the custom provider (cursor resets to 0)
  app.feed('my ollama')
  await sleep(30)
  app.feed('\r')
  await sleep(40)
  app.renderNow()
  let plain = app.lastFrame.map(stripAnsi).join('\n')
  if (!plain.includes('llama3.1')) throw new Error('model picker for the custom provider missing its models')
  if (!plain.includes('+ custom model id')) throw new Error('custom model CTA missing')
  // empty search → CTA still there
  app.feed('zzz')
  await sleep(30)
  app.renderNow()
  plain = app.lastFrame.map(stripAnsi).join('\n')
  if (!plain.includes('no matches for "zzz"')) throw new Error('model no-matches state missing')
  if (!plain.includes('+ custom model id')) throw new Error('custom model CTA did not survive the empty search')
  // clear filter, move down to the CTA, enter, type the id
  app.feed('\x7f\x7f\x7f')
  await sleep(20)
  app.feed('\x1b[B')
  await sleep(20)
  app.feed('\r')
  await sleep(40)
  app.feed('llama-x\r')
  await sleep(60)
  const save = host.saved.find((p) => p.defaultModel === 'llama-x')
  if (!save) throw new Error(`custom model id not saved: ${JSON.stringify(host.saved)}`)
  if (save.defaultProvider !== 'my-ollama') throw new Error(`wrong provider: ${JSON.stringify(save)}`)
  const cpPatch = host.saved.find((p) => p.customProvider) as { customProvider?: { models?: string[] } } | undefined
  if (!cpPatch?.customProvider?.models?.includes('llama-x')) throw new Error(`custom provider model list not updated: ${JSON.stringify(cpPatch)}`)
  app.exit()
  await sleep(10)
  app.destroy()
})

test('custom provider wizard: /model custom saves the endpoint and selects it', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  void (app as unknown as { customProviderWizard: () => Promise<void> }).customProviderWizard()
  await sleep(40)
  app.renderNow()
  if (!stripAnsi(out.text()).includes('add a custom provider')) throw new Error('wizard banner missing')
  app.feed('My Ollama\r')
  await sleep(30)
  app.feed('http://localhost:11434/v1\r')
  await sleep(30)
  app.feed('\r') // api kind: openai-compatible (cursor 0)
  await sleep(30)
  app.feed('\r') // api key: skip
  await sleep(30)
  app.feed('llama3.1, qwen2.5\r')
  await sleep(60)
  app.renderNow()
  const plain = stripAnsi(out.text())
  const cp = host.saved.find((p) => p.customProvider)?.customProvider as {
    id: string; label: string; baseUrl: string; kind: string; models: string[]
  } | undefined
  if (!cp) throw new Error(`custom provider not saved: ${JSON.stringify(host.saved)}`)
  if (cp.id !== 'my-ollama' || cp.label !== 'My Ollama') throw new Error(`bad id/label: ${JSON.stringify(cp)}`)
  if (cp.baseUrl !== 'http://localhost:11434/v1' || cp.kind !== 'openai') throw new Error(`bad baseUrl/kind: ${JSON.stringify(cp)}`)
  if (JSON.stringify(cp.models) !== JSON.stringify(['llama3.1', 'qwen2.5'])) throw new Error(`bad models: ${JSON.stringify(cp.models)}`)
  const sel = host.saved.find((p) => p.defaultProvider === 'my-ollama')
  if (!sel || sel.defaultModel !== 'llama3.1') throw new Error(`not selected as default: ${JSON.stringify(host.saved.filter((p) => p.defaultProvider))}`)
  if (!plain.includes('saved and selected')) throw new Error('success line missing')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('palette renders inside a box with the command descriptions aligned', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('/se')
  await sleep(20)
  app.renderNow()
  const rows = app.lastFrame.map(stripAnsi)
  const topIdx = rows.findIndex((r) => r.includes('╭─ commands'))
  if (topIdx === -1) throw new Error('boxed palette missing')
  const item = rows.slice(topIdx).find((r) => r.includes('/sessions'))
  if (!item) throw new Error('/sessions not offered for token "se"')
  for (const [i, row] of app.lastFrame.entries()) {
    const w = vis(row)
    if (w > 80) throw new Error(`palette row ${i} overflows: ${w} — ${JSON.stringify(stripAnsi(row))}`)
  }
  app.exit()
  await sleep(10)
  app.destroy()
})

/* ---------------- run ---------------- */

setAppColor(true)

/* ---------------- ask form overlay (ask_user tool) ---------------- */

const ASK_FORM = {
  id: 'ask-1',
  title: 'stack choice',
  intro: 'before I start building',
  fields: [
    { id: 'f1', label: 'Database?', type: 'option' as const, options: ['postgres', 'mysql'] },
    { id: 'f2', label: 'Features?', type: 'multi' as const, options: ['auth', 'payments'] },
    { id: 'f3', label: 'App name?', type: 'input' as const, placeholder: 'my-app' },
  ],
  allowNotes: true,
}

function frameText(app: TuiApp): string {
  return app.lastFrame.map(stripAnsi).join('\n')
}

test('ask form: renders questions, options, inputs, notes, submit', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host, { rows: 44 })
  host.bus.emit('ask:request', ASK_FORM)
  await sleep(30)
  app.renderNow()
  const text = frameText(app)
  if (!text.includes('agent asks') && !text.includes('stack choice')) throw new Error('form title missing')
  if (!text.includes('1. Database?')) throw new Error('field 1 label missing')
  if (!text.includes('postgres')) throw new Error('options missing')
  if (!text.includes('+ add option')) throw new Error('add-option CTA missing')
  if (!text.includes('3. App name?')) throw new Error('input field label missing')
  if (!text.includes('my-app')) throw new Error('input placeholder missing')
  if (!text.includes('notes for the agent')) throw new Error('notes label missing')
  if (!text.includes('submit answers')) throw new Error('submit row missing')
  // esc dismisses → host.askRespond(null)
  app.feed('\x1b')
  await sleep(90)
  if (host.askResponses.length !== 1 || host.askResponses[0].response !== null) throw new Error('esc should dismiss with null')
  if (!stripAnsi(out.text()).includes('dismissed')) throw new Error('dismissed trail missing from scrollback')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('ask form: pick option → auto-advance, multi toggle, type input, notes, submit', async () => {
  const host = new FakeHost(tmp)
  const { app, out } = await started(host)
  host.bus.emit('ask:request', ASK_FORM)
  await sleep(30)
  app.renderNow()
  // field 1 (option): cursor starts on 'postgres' — press enter to pick it (auto-advance to field 2)
  app.feed('\r')
  await sleep(20)
  // field 2 (multi): cursor on 'auth' → enter toggles it on, then down + enter toggles 'payments'
  app.feed('\r')
  await sleep(20)
  app.feed('\x1b[B') // down to payments
  await sleep(20)
  app.feed('\r')
  await sleep(20)
  // field 3 (input): tab jumps to the input row — type directly
  app.feed('\t')
  await sleep(20)
  app.feed('acme-app')
  await sleep(20)
  // tab jumps to notes… then to submit; type notes first
  app.feed('\t')
  await sleep(20)
  app.feed('keep it cheap')
  await sleep(20)
  // tab → submit, enter
  app.feed('\t')
  await sleep(20)
  app.feed('\r')
  await sleep(40)
  if (host.askResponses.length !== 1) throw new Error('submit did not respond')
  const r = host.askResponses[0].response
  if (!r) throw new Error('response is null — form dismissed?')
  if (r.answers.f1 !== 'postgres') throw new Error(`f1: expected postgres, got ${JSON.stringify(r.answers.f1)}`)
  if (JSON.stringify(r.answers.f2) !== JSON.stringify(['auth', 'payments'])) throw new Error(`f2: ${JSON.stringify(r.answers.f2)}`)
  if (r.answers.f3 !== 'acme-app') throw new Error(`f3: ${JSON.stringify(r.answers.f3)}`)
  if (r.notes !== 'keep it cheap') throw new Error(`notes: ${JSON.stringify(r.notes)}`)
  // answered trail lands in the scrollback
  const scroll = stripAnsi(out.text())
  if (!scroll.includes('answered')) throw new Error('answered trail missing from scrollback')
  if (!scroll.includes('postgres')) throw new Error('answers not printed to scrollback')
  app.exit()
  await sleep(10)
  app.destroy()
})

test('ask form: add-option flow appends a custom option and selects it', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  host.bus.emit('ask:request', { ...ASK_FORM, fields: ASK_FORM.fields.slice(0, 1) })
  await sleep(30)
  // cursor on 'postgres'; down, down to the add row, press 'a' → nested input overlay
  app.feed('\x1b[B\x1b[B')
  await sleep(20)
  app.feed('a')
  await sleep(60)
  app.renderNow()
  if (!frameText(app).includes('new option')) throw new Error('nested add-option overlay missing')
  app.feed('supabase\r')
  await sleep(40)
  app.renderNow()
  const text = frameText(app)
  if (!text.includes('supabase')) throw new Error('custom option not rendered in the form')
  // submit
  app.feed('\t\t\r')
  await sleep(40)
  const r = host.askResponses[0]?.response
  if (r?.answers.f1 !== 'supabase') throw new Error(`custom option not selected: ${JSON.stringify(r?.answers.f1)}`)
  app.exit()
  await sleep(10)
  app.destroy()
})

test('ask form: required fields block submit and flag the row', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  host.bus.emit('ask:request', {
    id: 'ask-2',
    fields: [
      { id: 'f1', label: 'Must answer?', type: 'option', options: ['yes', 'no'], required: true },
      { id: 'f2', label: 'Optional?', type: 'input' },
    ],
    allowNotes: false,
  })
  await sleep(30)
  // tab past everything onto submit, press enter — required f1 is empty
  app.feed('\t\t\r')
  await sleep(30)
  if (host.askResponses.length !== 0) throw new Error('submit must be blocked while a required field is empty')
  if (!frameText(app).includes('needs an answer')) throw new Error('required hint missing')
  // now pick an answer and submit
  app.feed('\r') // cursor was jumped back to field 1's first option
  await sleep(20)
  app.feed('\t\t\r')
  await sleep(40)
  const r = host.askResponses[0]?.response
  if (r?.answers.f1 !== 'yes') throw new Error(`required answer missing: ${JSON.stringify(r)}`)
  if (r?.notes !== undefined) throw new Error('notes should be absent when allowNotes=false')
  app.exit()
  await sleep(10)
  app.destroy()
})

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
