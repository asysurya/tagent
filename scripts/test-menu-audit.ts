#!/usr/bin/env bun
/**
 * test-menu-audit.ts — walk EVERY interactive menu + slash command and
 * assert none of them crashes the app ("bbrp opsi di berbagai menu/command
 * yang error pas diselect").
 *
 * Drives TuiApp through a FakeHost with injected IO (no real TTY): every
 * slash command runs once with no args, then the ctrl+x main menu is
 * walked item by item (open → select → esc back). The pass condition is
 * brutal but simple: the app stays alive (sentinel /help renders) and
 * zero unhandled rejections surface.
 *
 * Run: bun scripts/test-menu-audit.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import type { AgentHost } from '../packages/cli/src/host'
import { TuiApp, type AppIO } from '../packages/cli/src/tui-app'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ANSI_ONLY = /(\x1b\[[0-9;:<>?]*[A-Za-z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/g
const stripAnsi = (s: string) => s.replace(ANSI_ONLY, '')

class FakeOut {
  isTTY = true
  columns = 100
  rows = 30
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
  private handlers: ((b: Buffer) => void)[] = []
  on(_e: 'data', f: (b: Buffer) => void): this {
    this.handlers.push(f)
    return this
  }
  removeListener(_e: 'data', f: (b: Buffer) => void): this {
    this.handlers = this.handlers.filter((h) => h !== f)
    return this
  }
  resume(): this {
    return this
  }
  setRawMode(): this {
    return this
  }
  emit(s: string): void {
    for (const h of this.handlers) h(Buffer.from(s, 'utf8'))
  }
}

/** the full host surface the menus touch — every method returns a benign
 *  value; what we audit is the TUI code paths, not the host logic */
class FakeHost {
  root: string
  bus = new EventEmitter()
  session: { id: string; title: string; mode: 'build' | 'plan' | 'test'; todos: unknown[]; messages: unknown[] } | undefined
  sent: string[] = []
  cfg: Record<string, unknown> = {
    version: 1,
    defaultProvider: 'zai',
    defaultModel: 'glm-4.7',
    apiKeys: {},
    customProviders: [],
    permissions: { defaultMode: 'ask', tools: { bash: 'ask' } },
    tools: { bash: true, browser: true },
    github: {},
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
  newSession(mode: 'build' | 'plan' | 'test' = 'build') {
    this.session = { id: 's1', title: 'test session', mode, todos: [], messages: [] }
    this.bus.emit('session:active', this.session)
    return this.session
  }
  setSessionMode(mode: 'build' | 'plan' | 'test'): void {
    if (this.session) {
      this.session.mode = mode
      this.bus.emit('session:active', this.session)
    }
  }
  settingsSave(): { ok: true; config: unknown } {
    return { ok: true, config: this.sanitizeConfig() }
  }
  async providersRefresh(): Promise<{ ok: boolean; updated: string[]; failed: string[] }> {
    return { ok: true, updated: [], failed: [] }
  }
  async chatSend(text: string): Promise<unknown> {
    this.sent.push(text)
    return { turns: 1, toolCalls: 0, finished: 'complete', usage: { input: 1, output: 1 } }
  }
  interrupt(): void {}
  contextInfo(): { used: number; limit: number; pct: number; bar: string; estimated: boolean } {
    return { used: 0, limit: 131_072, pct: 0, bar: '', estimated: true }
  }
  mcpStatus(): { state: string; tools: number }[] {
    return []
  }
  async mcpEnsure(): Promise<{ state: string; tools: number }[]> {
    return []
  }
  mcpTemplates(): { name: string; label: string; command: string; args: string[]; note: string }[] {
    return [{ name: 'memory', label: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], note: 'x' }]
  }
  async mcpSave(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async mcpRemove(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async mcpToggle(): Promise<{ ok: boolean; enabled?: boolean }> {
    return { ok: true, enabled: false }
  }
  subagentsView(): { agents: { name: string; source: string; mode: string; maxTurns: number; description: string; tools?: string[]; model?: string }[] } {
    return { agents: [] }
  }
  fallbackChainView(): { chain: { label: string; model: string; primary?: boolean }[] } {
    return { chain: [] }
  }
  pluginsList(): unknown[] {
    return []
  }
  pluginScaffold(): { ok: boolean; error?: string } {
    return { ok: true }
  }
  async pluginCommandRun(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'none' }
  }
  async diagnosticsRun(): Promise<{ ok: boolean; ms: number; output?: string; timedOut?: boolean }> {
    return { ok: true, ms: 10, output: '' }
  }
  skillRead(): { content: string } {
    return { content: '# a skill\nline' }
  }
  undoCheckpoint(): { ok: boolean; checkpoint: { reason?: string } | null } {
    return { ok: false, checkpoint: null }
  }
  compactThreshold(): number {
    return 80
  }
  compactSession(): { ok: boolean; error?: string } {
    return { ok: false, error: 'nothing' }
  }
  memoryGet(): { facts: { id: string; text: string; createdAt: number }[]; agents: { global: string; workspace: string } } {
    return { facts: [], agents: { global: '', workspace: '' } }
  }
  memorySaveFact(): { ok: boolean } {
    return { ok: true }
  }
  memoryDeleteFact(): { ok: boolean } {
    return { ok: true }
  }
  async terminalExec(): Promise<string> {
    return ''
  }
  filesList(): { name: string; children: [] } {
    return { name: '.', children: [] }
  }
  fileRead(): { content: string } {
    return { content: 'x' }
  }
  stats() {
    return { sessions: 0, snapshots: 0, context: this.contextInfo() }
  }
  share(): { ok: false; error: string } {
    return { ok: false, error: 'no session' }
  }
  relayCreate(): { ok: false; error: string } {
    return { ok: false, error: 'no session' }
  }
  relayList(): [] {
    return []
  }
  relayRevoke(): { ok: boolean } {
    return { ok: true }
  }
  timeline(): [] {
    return []
  }
  setWebGui(): void {}
}

/* ---------------- harness ---------------- */

let unhandled = 0
process.on('unhandledRejection', () => {
  unhandled++
})

const ESC = '\x1b'
const ENTER = '\r'
const DOWN = '\x1b[B'
const UP = '\x1b[A'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-menu-'))
// isolated HOME so /repo & friends don't touch the real ~/.tagent
process.env.HOME = tmp

const host = new FakeHost(tmp)
const out = new FakeOut()
const input = new FakeIn()
const io: AppIO = { input: input as never, output: out as never }
const app = new TuiApp(host as unknown as AgentHost, { workspaceRoot: tmp, updateCheck: false, io, fullscreen: true })
const done = app.start()

async function alive(tag: string): Promise<boolean> {
  // 1. close whatever overlay the previous step left open (esc alone —
  //    never a stray key), 2. prove the app still responds by running a
  //    fresh command that opens a fresh overlay, checked while it's open
  app.feed(ESC)
  await sleep(80)
  out.chunks.length = 0
  app.feed('/help\r')
  await sleep(200)
  const frame = stripAnsi((app.lastFrame ?? []).join('\n'))
  const ok = frame.includes('Tagent commands')
  if (!ok) console.log(`      [${tag}] app NOT responsive — frame head: ${frame.slice(0, 120).replace(/\n/g, ' | ')}`)
  return ok
}

let failures = 0
const ok = (name: string, cond: boolean) => {
  if (!cond) failures++
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`)
}

/** run a slash command, close whatever it opened, assert the app lives */
async function runCommand(cmd: string): Promise<void> {
  out.chunks.length = 0
  app.feed(cmd + ENTER)
  await sleep(220)
  for (let i = 0; i < 4; i++) {
    app.feed(ESC)
    await sleep(60)
  }
  const good = await alive(cmd)
  ok(`/​${cmd.slice(1)} — no crash`, good)
}

/* ---------------- 1. every slash command ---------------- */

const SKIP = new Set([
  '/exit', // quits by design
  '/update', // network call — covered elsewhere
  '/stop', // interrupts nothing; still safe but no overlay — keep, actually fine
])

const commands = [
  '/help', '/new', '/sessions', '/open', '/delete', '/share', '/relay', '/timeline',
  '/mode', '/test', '/model', '/caveman', '/compact', '/worklog', '/webgui', '/todos',
  '/log', '/maxturns', '/agents', '/diag', '/fallback', '/apikey', '/mcp', '/plugins',
  '/permissions', '/allow', '/ask', '/deny', '/files', '/read', '/grep', '/sh',
  '/auth', '/push', '/repo', '/checkpoints', '/undo', '/memory', '/skills', '/skill',
  '/stats', '/settings', '/stop', '/clear',
]

for (const cmd of commands) {
  if (SKIP.has(cmd)) continue
  await runCommand(cmd)
}

/* ---------------- 2. ctrl+x main menu, item by item ---------------- */

// 20 items + scroll — walk 24 slots (enough to cover them all with maxVisible 12)
const SLOTS = 24
let menuOk = 0
for (let i = 0; i < SLOTS; i++) {
  console.log(`      · menu slot ${i}…`)
  app.feed('\x18') // ctrl+x
  await sleep(140)
  for (let d = 0; d < i; d++) {
    app.feed(DOWN)
    await sleep(25)
  }
  app.feed(ENTER)
  await sleep(200)
  for (let e = 0; e < 5; e++) {
    app.feed(ESC)
    await sleep(60)
  }
  if (await alive(`menu #${i}`)) menuOk++
}
ok(`ctrl+x menu walk — ${menuOk}/${SLOTS} slots kept the app alive`, menuOk === SLOTS)

/* ---------------- 3. /repo interactive flows ---------------- */

// /repo opens the settings screen (list overlay) — toggle a vault flag,
// change nothing else, esc out
out.chunks.length = 0
app.feed('/repo\r')
await sleep(200)
// items: auto · interval · 4 vault toggles · passphrase · sync now · done (order may vary)
app.feed(DOWN) // → interval
await sleep(50)
app.feed(DOWN) // → api keys toggle
await sleep(50)
app.feed(ENTER) // toggle api keys off
await sleep(200)
app.feed(ESC)
await sleep(100)
app.feed(ESC)
await sleep(100)
const repoAlive = await alive('/repo toggles')
ok('/repo settings screen — toggle + esc, no crash', repoAlive)

/* ---------------- 4. pinned bottom editor (fullscreen) ---------------- */

const frame = (app.lastFrame ?? []).join('\n')
const rows = frame.split('\n')
ok(`fullscreen frame fills the screen (${rows.length}/30 rows)`, rows.length >= 29)
const editorIdx = rows.findIndex((r) => stripAnsi(r).includes('❯') || /send|shift\+enter|▏|cursor/i.test(stripAnsi(r)))
ok('editor present in frame', editorIdx >= 0)

/* ---------------- verdict ---------------- */

ok('zero unhandled rejections', unhandled === 0)

app.exit() // public api — the walk may have already run /exit through a menu
await Promise.race([done.catch(() => undefined), sleep(1500)])
await sleep(100)

console.log(unhandled === 0 && failures === 0 ? '\nMENU AUDIT: ALL GREEN' : `\nMENU AUDIT: ${failures} FAILURES · ${unhandled} unhandled rejections`)
process.exit(failures === 0 && unhandled === 0 ? 0 : 1)
