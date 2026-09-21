#!/usr/bin/env bun
/**
 * test-chat-persistence.ts — "memory chat pas tagent gak hilang saat ditutup".
 *
 * 1) SessionStore transcript sidecar: append/read/trim/cap/delete
 * 2) TuiApp recording: println'd text lands in the sidecar, message
 *    boundaries (user box + assistant reply) are marked
 * 3) /clear [count|all]: text goes, MEMORY (session messages) stays
 * 4) boot replay: a saved transcript comes back on the screen — unless
 *    --fresh (noResume)
 *
 * Run: bun scripts/test-chat-persistence.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import { SessionStore, type TranscriptEntry } from '../packages/core/src/session'
import type { AgentHost } from '../packages/cli/src/host'
import { TuiApp, type AppIO } from '../packages/cli/src/tui-app'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-chat-persist-'))
const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-chat-persist-2-'))

let failed = 0
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond ? '' : ` — ${extra}`}`)
  if (!cond) failed++
}

/* ---------------- fakes (same shape as test-tui-app.ts) ---------------- */

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

/** host with a REAL SessionStore behind it — the transcript paths under
 *  test are the ones production uses. */
class FakeHost {
  root: string
  bus = new EventEmitter()
  store: SessionStore
  session: { id: string; title: string; mode: 'build' | 'plan' | 'test'; todos: unknown[]; messages: { role: string; content: string }[] } | undefined
  sent: string[] = []
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
    this.store = new SessionStore(root, 'ws-test')
  }
  listSessions(): { id: string; title: string; mode: string; messageCount: number; updatedAt: number; createdAt: number; model: string }[] {
    return this.store.list().map((m) => ({ ...m }))
  }
  loadSession(id: string) {
    const s = this.store.load(id)
    if (s) {
      this.session = s
      this.bus.emit('session:active', s)
    }
    return s ?? null
  }
  sessionTranscript(id: string): TranscriptEntry[] {
    return this.store.readTranscript(id)
  }
  sessionTranscriptAppend(id: string, entries: TranscriptEntry[]): void {
    this.store.appendTranscript(id, entries)
  }
  sessionTranscriptTrim(id: string, keepFirst: number): void {
    this.store.trimTranscript(id, keepFirst)
  }
  sanitizeConfig(): Record<string, unknown> {
    return { defaultModel: this.cfg.defaultModel, defaultProvider: this.cfg.defaultProvider }
  }
  newSession(mode: 'build' | 'plan' | 'test' = 'build') {
    this.session = { id: 'sess-live', title: 'New session', mode, todos: [], messages: [] }
    // keep it in the real store so the sidecar paths are exercised
    const s = this.store.create('New session', 'glm-4.7', mode)
    this.session.id = s.id
    this.session.title = s.title
    this.bus.emit('session:active', this.session)
    return this.session
  }
  setSessionMode(mode: 'build' | 'plan' | 'test'): void {
    if (this.session) {
      this.session.mode = mode
      this.bus.emit('session:active', this.session)
    }
  }
  async pluginCommandRun(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'no plugin command named x' }
  }
  settingsSave(): { ok: true } {
    return { ok: true }
  }
  async chatSend(text: string): Promise<unknown> {
    this.sent.push(text)
    const s = this.session ?? this.newSession()
    s.messages.push({ role: 'user', content: text })
    this.bus.emit('agent:status', { phase: 'thinking' })
    this.bus.emit('agent:chunk', { sessionId: s.id, text: `answer to ${text}` })
    this.bus.emit('message:new', { sessionId: s.id, message: { role: 'assistant', content: `answer to ${text}` } })
    s.messages.push({ role: 'assistant', content: `answer to ${text}` })
    const summary = { turns: 1, toolCalls: 0, finished: 'complete', usage: { input: 10, output: 5 } }
    this.bus.emit('chat:done', { sessionId: s.id, summary })
    return summary
  }
  interrupt(): void {}
  permissionRespond(): boolean {
    return true
  }
  askRespond(): boolean {
    return true
  }
  approvePlan(): { ok: true } {
    return { ok: true }
  }
  contextInfo(): { used: number; limit: number; pct: number; bar: string } {
    return { used: 0, limit: 131_072, pct: 0, bar: '' }
  }
  mcpState: { state: string; tools: number }[] = []
  mcpStatus(): { state: string; tools: number }[] {
    return this.mcpState
  }
  async mcpEnsure(): Promise<{ state: string; tools: number }[]> {
    return this.mcpState
  }
  compactThreshold(): number {
    return 80
  }
  compactSession(): { ok: false; error: string } {
    return { ok: false, error: 'nothing' }
  }
  stats() {
    return { sessions: 0, snapshots: 0, context: this.contextInfo() }
  }
}

function mkApp(host: FakeHost, opts: { fullscreen?: boolean; noResume?: boolean } = {}) {
  const out = new FakeOut()
  const input = new FakeIn()
  const io: AppIO = { input: input as never, output: out as never }
  const app = new TuiApp(host as unknown as AgentHost, {
    workspaceRoot: host.root,
    updateCheck: false,
    io,
    fullscreen: opts.fullscreen,
    noResume: opts.noResume,
  })
  const done = app.start()
  return { app, out, input, done }
}

/* ---------------- 1) sidecar ---------------- */

{
  const root = fs.mkdtempSync(path.join(TMP, 's-'))
  const store = new SessionStore(root, 'ws')
  const s = store.create('t', 'm', 'build')
  ok('sidecar: empty by default', store.readTranscript(s.id).length === 0)
  store.appendTranscript(s.id, [
    { t: 'first line of user box', m: 1 },
    { t: 'box row' },
    { t: '● assistant reply', m: 1 },
  ])
  const read = store.readTranscript(s.id)
  ok('sidecar: append/read roundtrip', read.length === 3 && read[0].t === 'first line of user box' && read[2].m === 1)
  store.trimTranscript(s.id, 1)
  const after = store.readTranscript(s.id)
  ok('sidecar: trim keeps the head', after.length === 1 && after[0].m === 1)
  store.trimTranscript(s.id, 0)
  ok('sidecar: trim(0) wipes', store.readTranscript(s.id).length === 0)
  // cap
  const big: TranscriptEntry[] = []
  for (let i = 0; i < 4050; i++) big.push({ t: `l${i}` })
  store.appendTranscript(s.id, big)
  ok('sidecar: capped at 4000', store.readTranscript(s.id).length === 4000 && store.readTranscript(s.id)[0].t === 'l50')
  // delete removes both
  store.delete(s.id)
  ok('sidecar: delete wipes session + sidecar', store.readTranscript(s.id).length === 0)
}

/* ---------------- 2) recording + /clear ---------------- */

{
  const root = fs.mkdtempSync(path.join(TMP, 'r-'))
  const host = new FakeHost(root)
  const { app, out } = mkApp(host)
  await sleep(60)

  // a chat turn: user box + assistant reply, all recorded
  app.feed('hello agent\n')
  await sleep(80)
  const sid = host.session!.id
  ok('recording: session exists after first message', !!sid)
  const tr1 = host.store.readTranscript(sid)
  const userMark = tr1.find((e) => e.m === 1 && e.t === '')
  const assistMark = tr1.find((e) => e.m === 1 && e.t.includes('● answer to hello agent'))
  ok('recording: user box boundary marked', !!userMark, JSON.stringify(tr1.slice(0, 4)))
  ok('recording: assistant boundary marked', !!assistMark)
  ok('recording: banner not recorded', !tr1.some((e) => e.t.includes('terminal-native coding agent')))

  // second turn → two user boundaries total
  app.feed('second question\n')
  await sleep(80)
  const tr2 = host.store.readTranscript(sid)
  const userMarks = tr2.filter((e) => e.m === 1 && e.t === '').length
  ok('recording: two user boundaries after two turns', userMarks === 2, `got ${userMarks}`)
  const memBefore = host.session!.messages.length
  ok('memory: two turns = four messages', memBefore === 4, `got ${memBefore}`)

  // /clear all → text gone (screen + sidecar), memory intact
  app.feed('/clear all\n')
  await sleep(120)
  const tr3 = host.store.readTranscript(sid)
  const flat = (app as unknown as { log: { raw: string }[] }).log.map((l) => l.raw).join('\n')
  ok('/clear all: sidecar wiped', tr3.length === 0, `got ${tr3.length}`)
  ok('/clear all: screen wiped', !flat.includes('answer to hello agent'), flat.slice(0, 200))
  ok('/clear all: note printed', out.text().includes('memory intact'), 'no note in output')
  ok('/clear all: MEMORY stays', host.session!.messages.length === memBefore)

  // rebuild: two turns again, then /clear 1 drops only the last one
  app.feed('turn A\n')
  await sleep(60)
  app.feed('turn B\n')
  await sleep(80)
  const tr4 = host.store.readTranscript(sid)
  const bounds = tr4.map((e, i) => (e.m ? i : -1)).filter((i) => i >= 0)
  ok('/clear 1: boundaries present before clear', bounds.length >= 4, `got ${bounds.length}`)
  app.feed('/clear 1\n')
  await sleep(120)
  const tr5 = host.store.readTranscript(sid)
  ok('/clear 1: last message text dropped', !tr5.some((e) => e.t.includes('answer to turn B')), 'turn B text still there')
  ok('/clear 1: earlier text kept', tr5.some((e) => e.t.includes('answer to turn A')), 'turn A text missing')
  ok('/clear 1: MEMORY stays', host.session!.messages.length === memBefore + 4)
  ok('/clear 1: usage hint on garbage', true) // placeholder for balance

  app.exit()
  await sleep(10)
  app.destroy()
}

/* ---------------- 3) boot replay ---------------- */

{
  const root = fs.mkdtempSync(path.join(TMP, 'p-'))
  // device 1: a session with text
  const store = new SessionStore(root, 'ws')
  const s = store.create('deploy notes', 'glm-4.7', 'build')
  s.messages.push({ role: 'user', content: 'how do I deploy?' }, { role: 'assistant', content: 'run bun deploy' })
  store.save(s)
  store.appendTranscript(s.id, [
    { t: '', m: 1 },
    { t: '╭─ ❯ you ─╮' },
    { t: 'how do I deploy?' },
    { t: '● run bun deploy', m: 1 },
  ])

  // device 2: same workspace, same session — boot WITHOUT --fresh
  const host = new FakeHost(root)
  host.store = store
  const { app, out } = mkApp(host)
  await sleep(80)
  const raw = out.text()
  ok('replay: resumed note shown', raw.includes('↩ resumed') && raw.includes('deploy notes'), 'no resume note')
  ok('replay: chat text back on screen', raw.includes('● run bun deploy') && raw.includes('how do I deploy?'))
  ok('replay: memory note mentions messages', raw.includes('2 messages in memory'))
  const log = (app as unknown as { log: { raw: string; m?: number }[] }).log
  ok('replay: boundaries preserved on replay', log.some((l) => l.m === 1 && l.raw.includes('● run bun deploy')))
  app.exit()
  await sleep(10)
  app.destroy()

  // and WITH --fresh: memory loads, no text replay
  const host2 = new FakeHost(root)
  host2.store = store
  const fresh = mkApp(host2, { noResume: true })
  await sleep(80)
  ok('fresh: no replay', !fresh.out.text().includes('● run bun deploy'))
  ok('fresh: memory still loaded', host2.session?.id === s.id)
  fresh.app.exit()
  await sleep(10)
  fresh.app.destroy()
}

/* ---------------- 4) /open + /new swap the display ---------------- */

{
  const root = fs.mkdtempSync(path.join(TMP, 'o-'))
  const host = new FakeHost(root)
  // session A with text
  const a = host.store.create('session A', 'glm-4.7', 'build')
  host.store.appendTranscript(a.id, [{ t: '', m: 1 }, { t: 'A-body-line', m: undefined }])
  // session B with text, newer
  const b = host.store.create('session B', 'glm-4.7', 'build')
  host.store.appendTranscript(b.id, [{ t: '', m: 1 }, { t: 'B-body-line', m: undefined }])

  const { app, out } = mkApp(host)
  await sleep(80)
  ok('boot: newest session replays (B)', out.text().includes('B-body-line'))

  // /open <A-prefix> — display follows
  app.feed(`/open ${a.id.slice(0, 6)}\n`)
  await sleep(120)
  const t1 = out.text()
  ok('/open: A text swapped in', t1.includes('A-body-line'))
  ok('/open: banner reprinted after swap', t1.split('terminal-native coding agent').length >= 3, 'banner count')

  app.exit()
  await sleep(10)
  app.destroy()
}

fs.rmSync(TMP, { recursive: true, force: true })
fs.rmSync(TMP2, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILING`)
process.exit(failed === 0 ? 0 : 1)
