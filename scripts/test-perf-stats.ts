#!/usr/bin/env bun
/**
 * test-perf-stats.ts — v0.31.2 navbar machine stats + context stats for
 * every provider.
 *
 * Covers:
 *  - PerfSampler: sane sample fields, interval updates, stop() freezes,
 *    stale recompute, fmtUptime
 *  - roundBox titleRight: exact row width (the sticky-math invariant — a
 *    wrapped border row would break the v0.31.1 render guard), truncation
 *    on narrow boxes, absent when not passed
 *  - renderContextBar marks: estUsed/estLimit `~` markers, plain bar
 *    unchanged, empty on unknown limit (backwards compat)
 *  - ASSUMED_CONTEXT_WINDOW export + modelContextWindow gap proof (unknown
 *    model id → 0 — the reason the assumed fallback exists)
 *  - AgentHost.contextInfo: unknown model → assumed 128k window (bar carries
 *    ~128k), known model → real window, env override wins, fromLoop usage
 *    beats estimation, 500ms cache identity
 *  - TUI: the navbar renders the 🖥 segment on wide terminals (58+) and
 *    drops it on narrow ones; the ctx bar with `~` markers lands in both
 *    the navbar footer and the hint row for EVERY provider
 *
 * Run: bun scripts/test-perf-stats.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

// isolate the GLOBAL config before @tagent/core loads (homeDir() reads HOME)
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-perf-home-'))
process.env.HOME = TMP_HOME

const core = await import('../packages/core/src/index')
const {
  renderContextBar, modelContextWindow, ASSUMED_CONTEXT_WINDOW, contextPct,
} = core
const { PerfSampler, fmtUptime } = await import('../packages/cli/src/perf-stats')
const { roundBox, vw } = await import('../packages/cli/src/ui')
const { AgentHost } = await import('../packages/cli/src/host')
const tui = await import('../packages/cli/src/tui-app')
const { TuiApp } = tui
type AppIO = import('../packages/cli/src/tui-app').AppIO
type HostT = import('../packages/cli/src/host').AgentHost

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra?: string) => {
  cond ? pass++ : fail++
  console.log(`${cond ? '✔' : '✗'} ${name}` + (!cond && extra ? ' — ' + extra : ''))
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ---------------- A. PerfSampler ---------------- */

console.log('1) PerfSampler — sample fields, interval, stop, staleness')
{
  const s = new PerfSampler()
  const early = s.get() // before start(): the zero sample, never throws
  ok('get() before start() returns a sane zero sample', early.cpuPct === 0 && early.ramTotalGb >= 0 && early.at > 0)
  s.start(50)
  const a = s.get()
  ok('sample fields sane after start()', a.cpuPct >= 0 && a.cpuPct <= 100 && a.ramPct >= 0 && a.ramPct <= 100, JSON.stringify(a))
  ok('ram total > 0 and rss > 0 on a real machine', a.ramTotalGb > 0 && a.rssMb > 0, JSON.stringify(a))
  ok('uptime advances with the process', a.uptimeS >= 0)
  await sleep(160)
  const b = s.get()
  ok('interval keeps sampling (at advanced)', b.at > a.at, `${a.at} → ${b.at}`)
  s.stop()
  const frozen = s.get().at
  await sleep(120)
  ok('stop() freezes the sample (at unchanged)', s.get().at === frozen)
  // staleness: force the timestamp 60s back → get() recomputes
  ;(s as unknown as { last: { at: number } }).last.at -= 60_000
  const fresh = s.get()
  ok('a stale sample is recomputed on read (laptop-suspend case)', fresh.at > frozen, `${fresh.at} > ${frozen}`)
  s.stop()
}
ok('fmtUptime: 0s / 42s / 13m / 2h 13m',
  fmtUptime(0) === '0s' && fmtUptime(42) === '42s' && fmtUptime(800) === '13m' && fmtUptime(7992) === '2h 13m',
  `${fmtUptime(0)}/${fmtUptime(42)}/${fmtUptime(800)}/${fmtUptime(7992)}`)

/* ---------------- B. roundBox titleRight ---------------- */

console.log('\n2) roundBox titleRight — exact widths (the sticky-math invariant)')
{
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
  const box = roundBox({ title: '✻ Tagent · 💬 hi', rows: [], width: 60, titleRight: '🖥 12% · 💾 62% · 210M' })
  const top = box[0] ?? ''
  ok('title row is EXACTLY the box width (no wrap → sticky math safe)', vw(top) === 60, `vw=${vw(top)}`)
  ok('titleRight rides the top border', strip(top).includes('12%') && strip(top).includes('62%'), strip(top))
  ok('title still on the left', strip(top).includes('Tagent') && strip(top).includes('hi'))
  // absurd: a titleRight wider than the box — must clamp, never wrap
  const squeeze = roundBox({ title: 'hello', rows: [], width: 24, titleRight: 'x'.repeat(80) })
  ok('oversized titleRight is clamped to the exact width', vw(squeeze[0] ?? '') === 24, `vw=${vw(squeeze[0] ?? '')}`)
  // no titleRight → the classic layout
  const plain = roundBox({ title: 'just a title', rows: [], width: 40 })
  ok('no titleRight keeps the classic single-label top border', vw(plain[0] ?? '') === 40 && strip(plain[0] ?? '').includes('just a title'))
  // long title + titleRight: both truncate to fit exactly
  const both = roundBox({ title: 'a very long session title that will not fit at all here', rows: [], width: 50, titleRight: '🖥 99% · 💾 99% · 999M' })
  ok('long title + titleRight still exact width', vw(both[0] ?? '') === 50, `vw=${vw(both[0] ?? '')}`)
  ok('titleRight survives when the title truncates', strip(both[0] ?? '').includes('99%'), strip(both[0] ?? ''))
}

/* ---------------- C. renderContextBar marks ---------------- */

console.log('\n3) renderContextBar — estimate markers (`~`) for every provider')
{
  const plain = renderContextBar(12_345, 131_072, 10)
  ok('plain bar unchanged: 12.3k/131.1k … 9%', plain.startsWith('12.3k/131.1k [') && plain.endsWith('9%'), plain)
  const estUsed = renderContextBar(12_345, 131_072, 10, { estUsed: true })
  ok('estUsed marks the USED side: ~12.3k/131.1k', estUsed.startsWith('~12.3k/131.1k [') && !estUsed.includes('/~'), estUsed)
  const estLimit = renderContextBar(12_345, 128_000, 10, { estLimit: true })
  ok('estLimit marks the LIMIT side: 12.3k/~128k', estLimit.startsWith('12.3k/~128k ['), estLimit)
  const both = renderContextBar(12_345, 128_000, 10, { estUsed: true, estLimit: true })
  ok('both markers can coexist: ~12.3k/~128k', both.startsWith('~12.3k/~128k [') && both.endsWith('10%'), both)
  ok('unknown limit still renders empty (backwards compat)', renderContextBar(5, 0) === '')
  ok('pct helper unchanged', contextPct(131_072, 131_072) === 100 && contextPct(10, 0) === 0)
  ok('ASSUMED_CONTEXT_WINDOW ships as 128k', ASSUMED_CONTEXT_WINDOW === 128_000)
  // the gap this whole feature exists for: an unlisted model id knows nothing
  ok('gap proof: an unknown model id resolves to 0 (no window) — the assumed fallback exists for exactly this',
    modelContextWindow('custom', 'mystery-model-v9') === 0, String(modelContextWindow('custom', 'mystery-model-v9')))
  ok('known ids still resolve (glm-4 heuristics / gpt-4o)', modelContextWindow('openai', 'gpt-4o') === 128_000 && modelContextWindow('custom', 'glm-4-x') === 131_072)
}

/* ---------------- D. AgentHost.contextInfo — every provider ---------------- */

console.log('\n4) AgentHost.contextInfo — the bar works for every provider')
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-perf-host-'))
  fs.mkdirSync(path.join(TMP, '.tagent'), { recursive: true })
  // a custom provider with an unlisted model — yesterday: no bar at all
  fs.writeFileSync(path.join(TMP, '.tagent', 'config.json'), JSON.stringify({
    defaultProvider: 'custom', defaultModel: 'mystery-model-v9',
  }))
  const host = new AgentHost({ workspaceRoot: TMP })
  const ci = host.contextInfo()
  ok('unknown model → ASSUMED window 128k', ci.limit === ASSUMED_CONTEXT_WINDOW && ci.assumed === true, JSON.stringify({ limit: ci.limit, assumed: ci.assumed }))
  ok('bar renders WITH the ~ marker on the limit', ci.bar.startsWith('0/~128k') || ci.bar.includes('/~128k'), ci.bar)
  ok('no provider usage yet → used is estimated (~ on the used side)', ci.estimated === true && ci.bar.startsWith('~'), ci.bar)
  const again = host.contextInfo()
  ok('contextInfo is cached (same object within 500ms)', again === ci)
  // env override wins over the assumption — and over the catalog
  process.env.TAGENT_CONTEXT_WINDOW = '65_000'.replace('_', '')
  const envCi = host.contextInfo()
  await sleep(550) // let the cache expire so the env is re-read
  const envCi2 = host.contextInfo()
  ok('TAGENT_CONTEXT_WINDOW beats the assumed fallback (env wins)', envCi2.limit === 65000 && envCi2.assumed === false, JSON.stringify({ limit: envCi2.limit, assumed: envCi2.assumed }))
  void envCi
  delete process.env.TAGENT_CONTEXT_WINDOW
  await sleep(550)
  // fromLoop: the loop reported usage (limit 0 — provider silent on window)
  const host3 = new AgentHost({ workspaceRoot: TMP })
  ;(host3 as unknown as { lastContext: unknown }).lastContext = { used: 5_000, limit: 0, turn: 1 }
  const ci3 = host3.contextInfo()
  ok('loop usage (5k) with no window → assumed limit, real used, ~ only on the limit',
    ci3.used === 5_000 && ci3.limit === ASSUMED_CONTEXT_WINDOW && ci3.assumed === true && ci3.estimated === false && ci3.bar.startsWith('5k/~128k'),
    ci3.bar)
  // known model: the real window, no assumption
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-perf-host2-'))
  fs.mkdirSync(path.join(TMP2, '.tagent'), { recursive: true })
  fs.writeFileSync(path.join(TMP2, '.tagent', 'config.json'), JSON.stringify({
    defaultProvider: 'openai', defaultModel: 'gpt-4o',
  }))
  const host4 = new AgentHost({ workspaceRoot: TMP2 })
  const ci4 = host4.contextInfo()
  ok('known model (gpt-4o) → real window 128k, not assumed', ci4.limit === 128_000 && ci4.assumed === false, JSON.stringify({ limit: ci4.limit, assumed: ci4.assumed }))
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(TMP2, { recursive: true, force: true })
}

/* ---------------- E. TUI render — navbar + hint row ---------------- */

class FakeOut {
  isTTY = true
  columns = 80
  rows = 24
  chunks: string[] = []
  write(s: string): void { this.chunks.push(s) }
  text(): string { return this.chunks.join('') }
}
class FakeIn {
  isTTY = true
  isRaw: boolean | undefined
  handlers: ((b: Buffer) => void)[] = []
  setRawMode(m: boolean): void { this.isRaw = m }
  resume(): void {}
  on(_e: 'data', f: (b: Buffer) => void): void { this.handlers.push(f) }
  removeListener(_e: 'data', f: (b: Buffer) => void): void { this.handlers = this.handlers.filter((h) => h !== f) }
}
class FakeHost {
  root: string
  bus = new EventEmitter()
  session: { id: string; title: string; mode: 'build'; todos: unknown[]; messages: unknown[] } | undefined
  cfg = { defaultModel: 'mystery-model-v9', defaultProvider: 'custom' }
  ctx: { used: number; limit: number; pct: number; bar: string; estimated: boolean; assumed: boolean }
  constructor(root: string) {
    this.root = root
    this.ctx = { used: 12_345, limit: 128_000, pct: 10, bar: '~12.3k/~128k [█░░░░░░░░░] 10%', estimated: true, assumed: true }
  }
  listSessions(): unknown[] { return [] }
  loadSession(): null { return null }
  sanitizeConfig(): Record<string, unknown> { return { ...this.cfg } }
  contextInfo() { return this.ctx }
  stats() { return { sessions: 0, snapshots: 0, context: this.ctx } }
  mcpStatus(): { state: string; tools: number }[] { return [] }
  async mcpEnsure(): Promise<{ state: string; tools: number }[]> { return [] }
  interrupt(): void {}
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

async function bootFrame(columns: number): Promise<{ text: string }> {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-perf-tui-'))
  const host = new FakeHost(TMP)
  const out = new FakeOut()
  out.columns = columns
  const input = new FakeIn()
  const io: AppIO = { input: input as never, output: out as never }
  const app = new TuiApp(host as unknown as HostT, { workspaceRoot: TMP, updateCheck: false, io })
  void app.start()
  await sleep(80) // let init() + the first frame land
  app.destroy()
  fs.rmSync(TMP, { recursive: true, force: true })
  return { text: out.text() }
}

console.log('\n5) TUI — the navbar machine stats + the everywhere context bar')
{
  const wide = await bootFrame(80)
  const plain = stripAnsi(wide.text)
  ok('wide terminal (80 → box 78): the 🖥 perf segment rides the navbar', plain.includes('🖥'), plain.slice(0, 200))
  ok('perf segment carries cpu · ram · rss', /🖥\s*\d+%/.test(plain) && plain.includes('💾'), plain.split('\n')[0] ?? '')
  ok('assumed ctx bar in the navbar footer: ~…/~128k', plain.includes('/~128k'), plain.slice(0, 400))
  const roomy = await bootFrame(120)
  const roomyPlain = stripAnsi(roomy.text)
  ok('roomy terminal (120): the bar reaches BOTH the navbar footer and the hint row',
    (roomyPlain.match(/~128k/g) ?? []).length >= 2, `${(roomyPlain.match(/~128k/g) ?? []).length} occurrences`)
  const narrow = await bootFrame(50)
  const narrowPlain = stripAnsi(narrow.text)
  ok('narrow terminal (50 → box 48): the perf segment is dropped, no wrap', !narrowPlain.includes('🖥'), narrowPlain.slice(0, 160))
  ok('narrow STILL shows the ctx bar (footer priority ladder: mode · bar · clock)', narrowPlain.includes('~128k'), narrowPlain.slice(0, 400))
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
fs.rmSync(TMP_HOME, { recursive: true, force: true })
if (fail > 0) process.exit(1)
