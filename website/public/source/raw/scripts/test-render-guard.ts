#!/usr/bin/env bun
/**
 * test-render-guard.ts — v0.31.1 TUI render integrity.
 *
 * The reported glitch: "box tool call tiba-tiba jadi kayak navbar — dibawah
 * box tool ada respon stream ai, tapi boxnya diem, ke scroll". Root causes
 * found and fixed:
 *
 *  1. FOREIGN WRITES — a plugin's console.error (or any stray write) between
 *     frames shifts the sticky region's anchor; the next cursor-up + \x1b[J
 *     lands below the previous frame's top and its leftovers stay frozen.
 *     Fix: installIoGuard() — foreign writes are queued as transcript lines.
 *  2. RESIZE — the terminal reflows on SIGWINCH; stickyDrawn no longer points
 *     at the frame's first row. Fix: onResize drops width caches, erases the
 *     old sticky zone generously and re-anchors from the bottom.
 *  3. flatLines() used to set `flushed = log.length` — lines printed while
 *     the history viewer was open never reached the scrollback. Fix: only
 *     renderNow's write loop advances the cursor.
 *  4. streamTailRows cached the markdown render by LENGTH only — a width
 *     change reused stale wraps. Fix: the cache is keyed by len + width.
 *
 * Run: bun scripts/test-render-guard.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import type { AgentHost } from '../packages/cli/src/host'
import { TuiApp, type AppIO } from '../packages/cli/src/tui-app'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

/** minimal host surface TuiApp needs at boot + the v0.31.1 additions */
class FakeHost {
  root: string
  bus = new EventEmitter()
  session: { id: string; title: string; mode: 'build'; todos: unknown[]; messages: unknown[] } | undefined
  sent: { text: string }[] = []
  saved: Record<string, unknown>[] = []
  cfg = { defaultModel: 'glm-4.7', defaultProvider: 'zai', caveman: false, worklog: { enabled: true } }
  perf = { ramGb: 8, source: 'user' as const, tuiLogLines: 2500, subagentParallelDefault: 3, webCacheMax: 96, compactThresholdChars: 120_000 }

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
      performance: this.perf,
    }
  }
  memProfile() {
    return this.perf
  }
  subagentLimits() {
    return { maxParallel: this.perf.subagentParallelDefault, running: 0 }
  }
  newSession() {
    this.session = { id: 's1', title: 'test', mode: 'build', todos: [], messages: [] }
    return this.session
  }
  settingsSave(patch: Record<string, unknown>): { ok: true; config: unknown } {
    this.saved.push(patch)
    const ramGb = patch.ramGb as number | undefined
    if (typeof ramGb === 'number') {
      const tier = ramGb <= 4
        ? { tuiLogLines: 1500, subagentParallelDefault: 2, webCacheMax: 48, compactThresholdChars: 100_000 }
        : ramGb <= 8
          ? { tuiLogLines: 2500, subagentParallelDefault: 3, webCacheMax: 96, compactThresholdChars: 120_000 }
          : { tuiLogLines: 4000, subagentParallelDefault: 4, webCacheMax: 128, compactThresholdChars: 150_000 }
      this.perf = { ...this.perf, ramGb, source: 'user', ...tier }
    }
    return { ok: true, config: this.sanitizeConfig() }
  }
  interrupt(): void {}
  contextInfo() {
    return { used: 0, limit: 131_072, pct: 0, bar: '', estimated: true }
  }
  stats() {
    return { sessions: 0, snapshots: 0, context: this.contextInfo() }
  }
  mcpState: { state: string; tools: number }[] = []
  mcpStatus() {
    return this.mcpState
  }
  async mcpEnsure() {
    return this.mcpState
  }
}

let pass = 0, fail = 0
// reporting MUST bypass the patched console — the guard swallows console.log
// while an app is alive (that is literally its job), so test output rides the
// raw stream captured at module load, before any app exists
const rawOut = process.stdout.write.bind(process.stdout)
const say = (s: string) => {
  rawOut(s + '\n')
}
const ok = (name: string, cond: boolean, extra?: string) => {
  cond ? pass++ : fail++
  say(`${cond ? '✔' : '✗'} ${name}${!cond && extra ? ` — ${extra}` : ''}`)
}
const section = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn()
  } catch (e) {
    fail++
    say(`✗ SECTION THREW — ${name}: ${(e as Error).stack ?? (e as Error).message}`)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-render-guard-'))

async function mk(opts: { columns?: number; rows?: number } = {}) {
  const host = new FakeHost(tmp)
  const out = new FakeOut()
  out.columns = opts.columns ?? 80
  out.rows = opts.rows ?? 24
  const input = new FakeIn()
  const io: AppIO = { input: input as never, output: out as never }
  const app = new TuiApp(host as unknown as AgentHost, { workspaceRoot: tmp, updateCheck: false, io })
  const done = app.start()
  await sleep(60) // init + first frame
  return { app, out, input, host, done }
}

console.log('1) foreign writes are queued as transcript lines, never raw')
await section('foreign-write interception', async () => {
  const { app, out } = await mk()
  app.renderNow()
  const chunksBefore = out.chunks.length
  // the exact failure path from the field report: a plugin hook error
  console.error('[taceen] plugin "taceen" beforeToolCall error: boom')
  ok('the foreign write never reached the raw stream', out.chunks.length === chunksBefore)
  const log = (app as unknown as { log: { raw: string }[] }).log
  ok('…it landed in the transcript queue', log.some((e) => e.raw.includes('[taceen] plugin "taceen" beforeToolCall error: boom')))
  app.renderNow()
  ok('…and the NEXT frame flushed it into the scrollback (inside the frame write)', out.text().includes('[taceen] plugin "taceen" beforeToolCall error: boom'))
  ok('flushed exactly once', out.text().split('beforeToolCall error: boom').length === 2)
  app.exit()
  await sleep(10)
  app.destroy()
})

console.log('\n2) the sticky math survives a foreign write (frame follows, nothing frozen)')
await section('sticky math', async () => {
  const { app, out } = await mk()
  app.renderNow()
  const drawn = (app as unknown as { stickyDrawn: number }).stickyDrawn
  ok('a frame is on screen', drawn > 0)
  console.warn('stray library warning line') // foreign
  console.log('another stray line') // foreign
  app.renderNow()
  const t = out.text()
  // the foreign lines ride INSIDE frame writes (as transcript flush rows,
  // \r\x1b[2K-prefixed), never as bare writes — and the erase still starts
  // at the frame's own first row
  ok('both stray lines became transcript rows', t.includes('stray library warning line') && t.includes('another stray line'))
  const drawn2 = (app as unknown as { stickyDrawn: number }).stickyDrawn
  ok('stickyDrawn tracks the new frame (cursor-up math intact)', drawn2 > 0)
  app.exit()
  await sleep(10)
  app.destroy()
})

console.log('\n3) resize — re-anchor, drop width caches, repaint at the new width')
await section('resize re-anchor', async () => {
  const { app, out } = await mk({ columns: 100, rows: 24 })
  app.renderNow()
  const a = app as unknown as {
    stickyDrawn: number
    log: { raw: string; wrapped?: string[] }[]
    flatCache: { upto: number; lines: string[] }
    io: { output: FakeOut }
    onResize: () => void
  }
  // seed a wrapped cache + flat cache
  a.log.push({ raw: 'seed line that is long enough to wrap around at narrow widths yes really' })
  ;(app as unknown as { flatLines: () => string[] }).flatLines()
  ok('wrapped cache warm before resize', a.log.some((e) => e.wrapped !== undefined) && a.flatCache.lines.length > 0)
  const drawnBefore = a.stickyDrawn
  out.columns = 40 // SIGWINCH
  a.onResize()
  ok('stickyDrawn reset — the next frame cannot trust the old geometry', a.stickyDrawn === 0)
  ok('wrapped caches dropped', a.log.every((e) => e.wrapped === undefined))
  ok('flat cache dropped', a.flatCache.upto === 0 && a.flatCache.lines.length === 0)
  ok('the old sticky zone was erased (re-anchor escape written)', /\x1b\[\d+;1H/.test(out.text()))
  app.renderNow()
  ok('the new frame painted at the new width', (app as unknown as { lastFrame: string[] }).lastFrame.length > 0)
  ok('stickyDrawn re-anchored by the new frame', (app as unknown as { stickyDrawn: number }).stickyDrawn > 0)
  ok('re-anchored erase did not fire from row 0 (frame row math is clamped)', !/\x1b\[0;1H/.test(out.text()))
  app.exit()
  await sleep(10)
  app.destroy()
})

console.log('\n4) flatLines no longer swallows pending lines while viewing')
await section('flatLines fix', async () => {
  const { app, out } = await mk()
  app.renderNow()
  // open the inline history viewer (pgup path)
  const a = app as unknown as { scrollBy: (d: number) => void; viewing: boolean; flushed: number; log: unknown[] }
  a.scrollBy(-5)
  ok('viewer opened', a.viewing === true)
  const before = out.text().length
  ;(app as unknown as { println: (s: string) => void }).println('a line printed while the user is scrolled up')
  app.renderNow()
  ok('the line reached the scrollback even with the viewer open (the v0.31.1 fix)', out.text().length > before && out.text().includes('a line printed while the user is scrolled up'))
  const count1 = out.text().split('a line printed while the user is scrolled up').length - 1
  // while the viewer is open the line may show TWICE (scrollback + the
  // viewer's window rendering it) — what matters is that it IS in the
  // scrollback at all (the pre-fix behavior was: never flushed, then gone)
  ok('flushed into the scrollback while viewing (count1 ≥ 1)', count1 >= 1, String(count1))
  a.scrollBy(9999) // back to live
  app.renderNow()
  const count2 = out.text().split('a line printed while the user is scrolled up').length - 1
  const lastChunk = out.chunks[out.chunks.length - 1] ?? ''
  // a raw-append fake cannot model \x1b[J erasure — the no-duplicate proof is
  // that closing the viewer APPENDED no new copy (count stopped growing) and
  // the final frame itself no longer renders the line (it was erased, not
  // re-emitted; a real terminal shows exactly one copy in the scrollback)
  ok('viewer closed: no new copy appended, the final frame dropped it', count2 === count1 && !lastChunk.includes('a line printed while the user is scrolled up'), `count1=${count1} count2=${count2}`)
  app.exit()
  await sleep(10)
  app.destroy()
})

console.log('\n5) stream tail cache is keyed by width too')
await section('stream cache width key', async () => {
  const { app } = await mk()
  const a = app as unknown as {
    streamText: string
    statusKind: string
    streamCache: { len: number; w: number; lines: string[] } | undefined
    streamTailRows: (w: number, h: number) => string[]
  }
  a.statusKind = 'stream'
  a.streamText = 'word '.repeat(30)
  a.streamTailRows(80, 8)
  const w80 = a.streamCache?.w
  a.streamTailRows(40, 8)
  // streamTailRows narrows the width by the 2-col margin (76 / 36 here)
  ok('cache rebuilt at the new width (not reused from len)', w80 === 76 && a.streamCache?.w === 36, `w80=${w80} w40=${a.streamCache?.w}`)
  app.exit()
  await sleep(10)
  app.destroy()
})

console.log('\n6) transcript retention follows the RAM profile')
await section('log cap from profile', async () => {
  const { app } = await mk() // FakeHost perf.tuiLogLines = 2500
  const a = app as unknown as { println: (s: string) => void; log: unknown[] }
  for (let i = 0; i < 2600; i++) a.println(`line ${i}`)
  ok('log capped at the profile cap (2500), not the old hard 4000', a.log.length === 2500, String(a.log.length))
  app.exit()
  await sleep(10)
  app.destroy()
})

console.log('\n7) /config ram — set + show')
await section('/config ram', async () => {
  const { app, host, out } = await mk()
  const a = app as unknown as { configRamFlow: (rest: string) => Promise<void> }
  await a.configRamFlow('4')
  app.renderNow() // flush the confirmation lines into the fake stream
  ok('settingsSave got {ramGb: 4}', host.saved.some((p) => p.ramGb === 4))
  ok('confirmation printed with the 4 GB knobs', out.text().includes('RAM profile') && out.text().includes('1500'))
  await a.configRamFlow('auto')
  ok('/config ram auto → ramGb 0 (follow the machine)', host.saved.some((p) => p.ramGb === 0))
  app.exit()
  await sleep(10)
  app.destroy()
})

console.log('\n8) destroy restores console + the stream')
await section('guard restore', async () => {
  const beforeLog = console.log
  const beforeError = console.error
  const { app, out } = await mk()
  const patched = console.log !== beforeLog || console.error !== beforeError
  ok('console patched while the app is live', patched)
  app.exit()
  await sleep(10)
  app.destroy()
  ok('console restored after destroy', console.log === beforeLog && console.error === beforeError)
  const chunksAtDestroy = out.chunks.length
  console.error('after destroy this goes wherever it went before')
  ok('post-destroy writes are NOT intercepted', out.chunks.length === chunksAtDestroy)
})

fs.rmSync(tmp, { recursive: true, force: true })
say(`\nRESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
