#!/usr/bin/env bun
/**
 * test-theme.ts — v0.23.0 TUI maximalization: themes, tool boxes, banner
 * boxes, live-markdown streaming, digit hotkeys, tap zones, and the
 * no-overflow guarantee on narrow terminals.
 *
 * HOME is pointed at a temp dir BEFORE any import of @tagent/core so the
 * theme persistence assertions never touch a real ~/.tagent.
 *
 * Run: bun scripts/test-theme.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-home-'))
process.env.HOME = HOME
// this test asserts REAL ANSI output — a NO_COLOR shell must not silence it
// (the app's gate reads the env directly, not just the setAppColor flag)
delete process.env.NO_COLOR
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-ws-'))

/* imports AFTER HOME redirect — GLOBAL_DIR is an import-time const */
const appmod = await import('../packages/cli/src/tui-app')
const { setAppColor, TuiApp } = appmod
type AppIO = appmod.AppIO
const theme = await import('../packages/cli/src/theme')
const { setTheme, activeTheme, THEMES } = theme
setAppColor(true)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ANSI_ONLY = /(\x1b\[[0-9;:<>?]*[A-Za-z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/g
const stripAnsi = (s: string): string => s.replace(ANSI_ONLY, '').replace(/\r/g, '')
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
  columns: number
  rows: number
  chunks: string[] = []
  constructor(columns = 80, rows = 30) {
    this.columns = columns
    this.rows = rows
  }
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

function mkHost(): any {
  return {
    root: tmp,
    bus: new EventEmitter(),
    session: undefined as any,
    sent: [] as string[],
    cfg: {},
    listSessions: () => [],
    loadSession: () => null,
    newSession(mode = 'build') {
      this.session = { id: 's1', title: 'theme test', mode, todos: [], messages: [] }
      this.bus.emit('session:active', this.session)
      return this.session
    },
    setSessionMode(mode: string) {
      if (this.session) {
        this.session.mode = mode
        this.bus.emit('session:active', this.session)
      }
    },
    sanitizeConfig: () => ({ defaultModel: 'glm-4.7' }),
    mcpStatus: () => [],
    mcpEnsure: async () => [],
    contextInfo: () => ({ used: 0, limit: 131_072, pct: 0, bar: '' }),
    askRespond: () => true,
    permissionRespond: () => true,
    interrupt() {},
    settingsSave() {},
    compactThreshold: () => 80,
    compactSession: () => ({ ok: false, error: 'nothing' }),
    sessionTranscriptAppend: () => {},
    sessionTranscript: () => [],
    async chatSend(text: string) {
      this.sent.push(text)
      const s = this.session ?? this.newSession()
      this.bus.emit('agent:status', { phase: 'thinking' })
      this.bus.emit('agent:chunk', { sessionId: s.id, text: 'Hello from the agent' })
      this.bus.emit('message:new', { sessionId: s.id, message: { role: 'assistant', content: 'Hello from the agent' } })
      this.bus.emit('chat:done', { sessionId: s.id, summary: { turns: 1, toolCalls: 1, finished: 'complete', usage: { input: 120, output: 45 } } })
      return {}
    },
  }
}

function mkApp(host: any, opts: { columns?: number; rows?: number; fullscreen?: boolean } = {}) {
  const out = new FakeOut(opts.columns ?? 80, opts.rows ?? 30)
  const io: AppIO = { input: new FakeIn() as never, output: out as never }
  const app = new TuiApp(host, { workspaceRoot: tmp, io, updateCheck: false, fullscreen: opts.fullscreen === true })
  return { app, out }
}

async function started(host: any, opts: { columns?: number; rows?: number; fullscreen?: boolean } = {}) {
  const ctx = mkApp(host, opts)
  await ctx.app.init()
  await sleep(40)
  return ctx
}

const results: string[] = []
function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push(`OK   ${name}`)
      console.log(`OK   ${name}`)
    })
    .catch((e) => {
      results.push(`FAIL ${name} — ${(e as Error).message}`)
      console.error(`FAIL ${name} — ${(e as Error).message}`)
    })
}

const cleanup: (() => void)[] = []
process.on('exit', () => for_cleanup())
function for_cleanup() {
  for (const c of cleanup) {
    try {
      c()
    } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* 1. the theme module itself                                          */
/* ------------------------------------------------------------------ */

await test('theme module: six themes, setTheme round-trip, unknown stays put', () => {
  if (THEMES.length < 6) throw new Error(`expected 6 themes, got ${THEMES.length}`)
  const names = THEMES.map((t) => t.name)
  for (const want of ['dark', 'light', 'tokyo-night', 'dracula', 'nord', 'gruvbox']) {
    if (!names.includes(want)) throw new Error(`missing theme ${want}`)
  }
  const before = activeTheme().name
  if (setTheme('nope-theme') !== false) throw new Error('unknown theme must return false')
  if (activeTheme().name !== before) throw new Error('unknown theme must not switch')
  for (const t of THEMES) {
    if (!setTheme(t.name)) throw new Error(`setTheme(${t.name}) failed`)
    if (activeTheme().name !== t.name) throw new Error(`activeTheme is ${activeTheme().name} after switching to ${t.name}`)
  }
  setTheme('dark') // restore
})

await test('theme module: dark is byte-identical to the classic palette', () => {
  setTheme('dark')
  if (theme.themeSgr('red') !== '31') throw new Error('dark red must stay SGR 31')
  if (theme.themeSgr('cyan') !== '36') throw new Error('dark cyan must stay SGR 36')
  if (theme.themeSgr('orange') !== '38;5;208') throw new Error('dark orange must stay tomato 38;5;208')
})

/* ------------------------------------------------------------------ */
/* 2. boot applies the SAVED theme                                     */
/* ------------------------------------------------------------------ */

await test('boot: theme from the global config paints the first frame', async () => {
  fs.mkdirSync(path.join(HOME, '.tagent'), { recursive: true })
  fs.writeFileSync(path.join(HOME, '.tagent', 'config.json'), JSON.stringify({ theme: 'tokyo-night' }))
  const host = mkHost()
  const { app, out } = await started(host)
  if (activeTheme().name !== 'tokyo-night') throw new Error(`expected tokyo-night, got ${activeTheme().name}`)
  // tokyo-night orange = 38;5;215 — the navbar's ✻ rides it
  if (!out.text().includes('\x1b[38;5;215m')) throw new Error('frame missing tokyo-night accents')
  app.exit()
  await sleep(10)
  app.destroy()
  fs.rmSync(path.join(HOME, '.tagent', 'config.json'))
})

/* ------------------------------------------------------------------ */
/* 3. /theme switches LIVE + persists                                  */
/* ------------------------------------------------------------------ */

await test('/theme <name>: live switch + saved to the global config', async () => {
  fs.rmSync(path.join(HOME, '.tagent', 'config.json'), { force: true })
  setTheme('dark')
  const host = mkHost()
  const { app, out } = await started(host)
  app.feed('/theme dracula\r')
  await sleep(120)
  if (activeTheme().name !== 'dracula') throw new Error(`expected dracula, got ${activeTheme().name}`)
  const plain = stripAnsi(out.text())
  if (!plain.includes('theme → Dracula')) throw new Error('confirmation line missing')
  const saved = JSON.parse(fs.readFileSync(path.join(HOME, '.tagent', 'config.json'), 'utf8'))
  if (saved.theme !== 'dracula') throw new Error(`config saved theme=${saved.theme}`)
  // dracula accent 38;5;213 paints the next frame (selection highlights)
  app.feed('/mode\r')
  await sleep(60)
  const frame = app.lastFrame.map(stripAnsi).join('\n')
  if (!frame.includes('plan')) throw new Error('mode picker did not open')
  const rawFrame = app.lastFrame.join('\n')
  if (!rawFrame.includes('\x1b[38;5;213m')) throw new Error('dracula accent missing from the overlay frame')
  app.feed('\x1b') // close picker
  await sleep(40)
  app.exit()
  await sleep(10)
  app.destroy()
})

await test('/theme bogus: lists the real names', async () => {
  const host = mkHost()
  const { app, out } = await started(host)
  app.feed('/theme rainbow\r')
  await sleep(120)
  const plain = stripAnsi(out.text())
  if (!plain.includes('no theme "rainbow"')) throw new Error('error line missing')
  if (!plain.includes('tokyo-night')) throw new Error('available names not listed')
  if (activeTheme().name === 'rainbow') throw new Error('theme must not switch')
  app.exit()
  await sleep(10)
  app.destroy()
})

/* ------------------------------------------------------------------ */
/* 4. tool boxes carry their category color                            */
/* ------------------------------------------------------------------ */

await test('tool boxes: bash tomato, mcp red, read blue — rails in the category color', async () => {
  // dark assumes a clean slate — earlier tests may have saved another theme
  fs.rmSync(path.join(HOME, '.tagent', 'config.json'), { force: true })
  setTheme('dark')
  const host = mkHost()
  const { app, out } = await started(host)
  const cases: [string, Record<string, unknown>, string][] = [
    ['bash', { command: 'ls -la' }, '\x1b[38;5;208m'], // tomato
    ['mcp_ddg_search', { query: 'cats' }, '\x1b[31m'], // red
    ['read_file', { path: 'src/a.ts' }, '\x1b[34m'], // blue
    ['write_file', { path: 'src/b.ts', content: 'x' }, '\x1b[32m'], // green
    ['grep', { pattern: 'TODO' }, '\x1b[35m'], // magenta
  ]
  for (const [tool, input] of cases) {
    host.bus.emit('tool:start', { call: { id: 'c-' + tool, tool, input, status: 'running' } })
    await sleep(10)
    host.bus.emit('tool:end', { call: { id: 'c-' + tool, tool, input, status: 'done', output: 'ok line', startedAt: 1, endedAt: 1501 } })
    await sleep(10)
  }
  app.renderNow()
  const raw = out.text()
  for (const [tool, input, code] of cases) {
    if (!raw.includes(code)) throw new Error(`${tool}: box border missing color ${code}`)
  }
  const plain = stripAnsi(out.text())
  if (!plain.includes('╭─ 💻 bash')) throw new Error('bash box title rail missing')
  if (!plain.includes('╭─ 🔍 mcp_ddg_search')) throw new Error('mcp box title rail missing')
  if (!plain.includes('q: cats') && !plain.includes('cats')) throw new Error('mcp box input summary missing')
  // every tool box closes: each titled top rail is followed (within the box
  // body) by a closing ╰ rail — sticky redraws repeat rows, so walk forward
  const lines = plain.split('\n')
  for (const [tool] of cases) {
    const topIdx = lines.findIndex((l) => l.includes('╭─ ') && l.includes(tool))
    if (topIdx < 0) throw new Error(`${tool}: titled top rail not found`)
    const closeIdx = lines.findIndex((l, i) => i > topIdx && l.startsWith('╰'))
    if (closeIdx < 0 || closeIdx > topIdx + 5) throw new Error(`${tool}: box did not close within 5 rows (closed at ${closeIdx})`)
  }
  app.exit()
  await sleep(10)
  app.destroy()
})

/* ------------------------------------------------------------------ */
/* 5. banner boxes for run stats                                       */
/* ------------------------------------------------------------------ */

await test('done stats: the run verdict rides a two-line banner box', async () => {
  const host = mkHost()
  host.newSession()
  const { app, out } = await started(host)
  host.bus.emit('agent:status', { phase: 'thinking' })
  host.bus.emit('chat:done', { summary: { turns: 3, toolCalls: 7, finished: 'complete', usage: { input: 900, output: 400 } } })
  await sleep(60)
  app.renderNow()
  const plain = stripAnsi(out.text())
  if (!plain.includes('✔ done')) throw new Error('verdict missing')
  if (!plain.includes('3 turns · 7 tool calls')) throw new Error('stats missing')
  const lines = plain.split('\n')
  const vi = lines.findIndex((l) => l.includes('✔ done'))
  if (vi < 0 || !/^╰─ 3 turns/.test(lines[vi + 1] ?? '')) throw new Error('stats must ride the bottom rail of the banner box')
  app.exit()
  await sleep(10)
  app.destroy()
})

/* ------------------------------------------------------------------ */
/* 6. streaming renders MARKDOWN live                                 */
/* ------------------------------------------------------------------ */

await test('streaming: the tail renders markdown live — headings, no raw hashes, fences as boxes', async () => {
  const host = mkHost()
  host.newSession()
  const { app } = await started(host)
  host.bus.emit('agent:status', { phase: 'thinking' })
  host.bus.emit('agent:chunk', { text: 'Before the fence.\n\n```js\nconst a = 1\n' })
  await sleep(80)
  app.renderNow()
  const frame = app.lastFrame.map(stripAnsi).join('\n')
  if (!frame.includes('Before the fence.')) throw new Error('stream text missing')
  if (frame.includes('#')) throw new Error('raw markdown must not show while streaming (hashes leaked)')
  if (!frame.includes('╭─[js]')) throw new Error('unclosed fence must render as a code box while streaming')
  if (!frame.includes('│ const a = 1')) throw new Error('code body missing from the live fence box')
  host.bus.emit('agent:chunk', { text: 'Before the fence.\n\n```js\nconst a = 1\n```\n\n## Section\n' })
  await sleep(80)
  app.renderNow()
  const frame2 = app.lastFrame.map(stripAnsi).join('\n')
  if (frame2.includes('##')) throw new Error('raw heading marker leaked while streaming')
  if (!frame2.includes('Section')) throw new Error('heading text missing')
  host.bus.emit('message:new', { message: { role: 'assistant', content: 'Before the fence.\n\n```js\nconst a = 1\n```\n\n## Section\n' } })
  await sleep(60)
  app.exit()
  await sleep(10)
  app.destroy()
})

/* ------------------------------------------------------------------ */
/* 7. digit hotkeys (1-9) — the mobile pick                            */
/* ------------------------------------------------------------------ */

await test('digit hotkey: pressing 2 in the /mode picker selects plan directly', async () => {
  const host = mkHost()
  host.newSession('build')
  const { app, out } = await started(host)
  app.feed('/mode\r')
  await sleep(60)
  const frame = app.lastFrame.map(stripAnsi).join('\n')
  if (!frame.includes('1 build')) throw new Error('number badges missing from the picker')
  if (!frame.includes('2 plan')) throw new Error('plan badge missing')
  app.feed('2')
  await sleep(80)
  if (host.session.mode !== 'plan') throw new Error(`digit 2 must select plan, mode=${host.session.mode}`)
  const plain = stripAnsi(out.text())
  if (!plain.includes('mode: plan')) throw new Error('mode banner missing after digit pick')
  app.exit()
  await sleep(10)
  app.destroy()
})

await test('digit hotkeys: filterable lists keep digits for typing (qwen-style searches)', async () => {
  const host = mkHost()
  host.newSession('build')
  const { app } = await started(host)
  // the sessions picker is filterable when long; simulate via a direct pick:
  // type digits into the /model picker (filterable) — they must reach the filter
  app.feed('/model\r')
  await sleep(60)
  app.feed('4')
  await sleep(40)
  const frame = app.lastFrame.map(stripAnsi).join('\n')
  if (!frame.includes('/4')) throw new Error('digit must type into the filter of a filterable picker')
  app.feed('\x1b')
  await sleep(40)
  app.exit()
  await sleep(10)
  app.destroy()
})

/* ------------------------------------------------------------------ */
/* 8. tap zones (fullscreen + SGR mouse)                                */
/* ------------------------------------------------------------------ */

await test('tap: an SGR click on a menu row selects it (fullscreen)', async () => {
  const host = mkHost()
  host.newSession('build')
  const { app } = await started(host, { fullscreen: true, rows: 30 })
  app.feed('/mode\r')
  await sleep(60)
  app.renderNow()
  const idx = app.lastFrame.findIndex((r) => stripAnsi(r).includes('read-only'))
  if (idx < 0) throw new Error('plan row not found in the fullscreen frame')
  const y = idx + 1 // SGR rows are 1-based
  app.feed(`\x1b[<0;6;${y}M`)
  await sleep(80)
  if (host.session.mode !== 'plan') throw new Error(`tap must select plan, mode=${host.session.mode}`)
  app.exit()
  await sleep(10)
  app.destroy()
})

await test('tap: clicks outside every zone are a no-op (fullscreen)', async () => {
  const host = mkHost()
  host.newSession('build')
  const { app } = await started(host, { fullscreen: true, rows: 30 })
  app.feed('/mode\r')
  await sleep(60)
  app.feed('\x1b[<0;3;2M') // the navbar — no zone there
  await sleep(60)
  if (host.session.mode !== 'build') throw new Error('a stray tap must not change anything')
  const stillOpen = app.lastFrame.map(stripAnsi).join('\n')
  if (!stillOpen.includes('read-only')) throw new Error('picker must stay open after a stray tap')
  app.feed('\x1b')
  await sleep(40)
  app.exit()
  await sleep(10)
  app.destroy()
})

/* ------------------------------------------------------------------ */
/* 9. the no-overflow guarantee on narrow terminals                     */
/* ------------------------------------------------------------------ */

await test('narrow terminal: every frame row fits the width — no soft-wrap collisions', async () => {
  const host = mkHost()
  host.newSession()
  const { app } = await started(host, { columns: 22, rows: 24 })
  host.bus.emit('agent:status', { phase: 'thinking' })
  host.bus.emit('agent:chunk', { text: 'a fairly long streaming line that would wrap several times over the tiny width' })
  await sleep(80)
  app.feed('quite a long line of typed text as well which would wrap')
  await sleep(60)
  app.renderNow()
  for (const r of app.lastFrame) {
    if (vis(r) > 22) throw new Error(`frame row exceeds width: ${vis(r)} > 22 — "${stripAnsi(r).slice(0, 30)}"`)
  }
  app.exit()
  await sleep(10)
  app.destroy()
})

await test('narrow terminal: the navbar never forces a wider box (responsive floor)', async () => {
  const host = mkHost()
  const { app } = await started(host, { columns: 20, rows: 20 })
  const nav = app.lastFrame[0] ?? ''
  if (vis(nav) > 20) throw new Error(`navbar row wider than the terminal: ${vis(nav)}`)
  if (app.lastFrame.length > 20) throw new Error(`frame taller than the terminal: ${app.lastFrame.length}`)
  app.exit()
  await sleep(10)
  app.destroy()
})

/* ------------------------------------------------------------------ */

const fails = results.filter((r) => r.startsWith('FAIL'))
console.log(fails.length === 0 ? '\nALL PASS' : `\n${fails.length} FAILING`)
for (const f of fails) console.error(f)
process.exit(fails.length === 0 ? 0 : 1)
