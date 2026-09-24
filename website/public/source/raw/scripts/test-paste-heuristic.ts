#!/usr/bin/env bun
/**
 * test-paste-heuristic.ts — the no-bracketed-paste fallback (v0.22.1).
 *
 * v0.22.0 made bare enter SUBMIT and modified enters newline. Bracketed
 * paste (2004) already keeps pasted newlines as newlines, but terminals
 * WITHOUT bracketed-paste support send a pasted multi-line blob as raw
 * keystrokes — one bare \r per line — which would submit the composer
 * once per line. The raw-paste heuristic (detectRawPaste in tui-app.ts)
 * recognizes that burst and reroutes it into the editor as text.
 *
 * Every case here feeds keys WITHOUT \x1b[200~ markers (the raw path).
 *
 * Run: bun scripts/test-paste-heuristic.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import type { AgentHost } from '../packages/cli/src/host'
import { TuiApp, type AppIO } from '../packages/cli/src/tui-app'

/* ---------------- helpers (same shape as test-tui-app.ts) ---------------- */

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

class FakeHost {
  root: string
  bus = new EventEmitter()
  session: { id: string; title: string; mode: 'build' | 'plan'; todos: unknown[]; messages: unknown[] } | undefined
  sent: { text: string }[] = []
  interrupted = 0
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
    return { ok: true, config: this.sanitizeConfig() }
  }
  async providersRefresh(): Promise<{ ok: boolean; updated: string[]; failed: string[] }> {
    return { ok: true, updated: [], failed: [] }
  }
  async chatSend(text: string): Promise<unknown> {
    this.sent.push({ text })
    const s = this.session ?? this.newSession()
    const summary = { turns: 1, toolCalls: 1, finished: 'complete', usage: { input: 120, output: 45 } }
    this.bus.emit('chat:done', { sessionId: s.id, summary })
    return summary
  }
  interrupt(): void {
    this.interrupted += 1
  }
  permissionRespond(): boolean {
    return true
  }
  askRespond(): boolean {
    return true
  }
  approvePlan(): { ok: boolean } {
    return { ok: true }
  }
  contextInfo() {
    return { used: 0, limit: 131_072, pct: 0, bar: '0/131k [░░░░░░░░░░] 0%', estimated: true }
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
    return { ok: false, error: 'nothing to compact' }
  }
  stats() {
    return { sessions: 0, snapshots: 0, context: this.contextInfo() }
  }
}

/* ---------------- harness ---------------- */

const tests: { name: string; fn: () => Promise<void> | void }[] = []
const test = (name: string, fn: () => Promise<void> | void) => tests.push({ name, fn })

let tmp = ''

async function started(host: FakeHost) {
  const out = new FakeOut()
  const input = new FakeIn()
  const io: AppIO = { input: input as never, output: out as never }
  const app = new TuiApp(host as unknown as AgentHost, { workspaceRoot: host.root, updateCheck: false, io })
  const done = app.start()
  await sleep(60) // let init() + the first frame land
  return { app, out, done }
}

const end = async (app: TuiApp) => {
  app.exit()
  await sleep(10)
  app.destroy()
}

/* ---------------- tests ---------------- */

test('raw CRLF paste (no 200~ markers): newlines land, never submits', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('const a = 1\r\nconst b = 2\r\nconst c = 3')
  await sleep(10)
  if (host.sent.length !== 0) throw new Error('raw multi-line paste must NOT auto-submit')
  const text = app.editor.text
  if (text !== 'const a = 1\nconst b = 2\nconst c = 3') throw new Error(`CRLF paste content wrong: ${JSON.stringify(text)}`)
  await end(app)
})

test('raw CR-only paste (old-mac / odd terminals): one newline per line', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('line one\rline two\rline three')
  await sleep(10)
  if (host.sent.length !== 0) throw new Error('CR paste must NOT submit')
  const text = app.editor.text
  if (text !== 'line one\nline two\nline three') throw new Error(`CR paste content wrong: ${JSON.stringify(text)}`)
  await end(app)
})

test('raw LF-only paste: newlines land (\\n is ctrl+enter, never a submit)', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('x\ny\nz')
  await sleep(10)
  if (host.sent.length !== 0) throw new Error('LF paste must NOT submit')
  if (app.editor.text !== 'x\ny\nz') throw new Error(`LF paste content wrong: ${JSON.stringify(app.editor.text)}`)
  await end(app)
})

test('CRLF pairs collapse to ONE newline — blank lines survive', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('para1\r\n\r\npara2')
  await sleep(10)
  if (host.sent.length !== 0) throw new Error('blank-line paste must NOT submit')
  if (app.editor.text !== 'para1\n\npara2') throw new Error(`blank line lost: ${JSON.stringify(app.editor.text)}`)
  await end(app)
})

test('LF blank lines survive too', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('para1\n\npara2')
  await sleep(10)
  if (app.editor.text !== 'para1\n\npara2') throw new Error(`LF blank line lost: ${JSON.stringify(app.editor.text)}`)
  await end(app)
})

test('trailing newline of a raw paste is dropped (copy artifact)', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('alpha\r\nbeta\r\n')
  await sleep(10)
  if (host.sent.length !== 0) throw new Error('trailing-newline paste must NOT submit')
  if (app.editor.text !== 'alpha\nbeta') throw new Error(`trailing newline handling wrong: ${JSON.stringify(app.editor.text)}`)
  await end(app)
})

test('typed enter still submits (enter is the LAST key of its chunk)', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('ping the agent\r')
  await sleep(30)
  if (host.sent.length !== 1 || host.sent[0].text !== 'ping the agent') throw new Error(`typed enter must submit: ${JSON.stringify(host.sent)}`)
  await end(app)
})

test('a lone \\r chunk after typed text still submits', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('hello')
  app.feed('\r')
  await sleep(30)
  if (host.sent.length !== 1 || host.sent[0].text !== 'hello') throw new Error(`lone enter must submit: ${JSON.stringify(host.sent)}`)
  await end(app)
})

test('alt+enter mid-chunk is a newline, not a paste', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('a\x1b\rb')
  await sleep(10)
  if (host.sent.length !== 0) throw new Error('alt+enter must NOT submit')
  if (app.editor.text !== 'a\nb') throw new Error(`alt+enter chunk wrong: ${JSON.stringify(app.editor.text)}`)
  await end(app)
})

test('kitty shift+enter mid-chunk is a newline, not a paste', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('a\x1b[13;2ub')
  await sleep(10)
  if (host.sent.length !== 0) throw new Error('kitty shift+enter must NOT submit')
  if (app.editor.text !== 'a\nb') throw new Error(`kitty chunk wrong: ${JSON.stringify(app.editor.text)}`)
  await end(app)
})

test('pasted CSI garbage (copied terminal colors) drops out of the text', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('\x1b[31mred\rtext\x1b[0m')
  await sleep(10)
  if (host.sent.length !== 0) throw new Error('CSI-laden paste must NOT submit')
  if (app.editor.text !== 'red\ntext') throw new Error(`CSI stripping wrong: ${JSON.stringify(app.editor.text)}`)
  await end(app)
})

test('tabs inside a raw paste survive', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('a\tb\rc')
  await sleep(10)
  if (app.editor.text !== 'a\tb\nc') throw new Error(`tab handling wrong: ${JSON.stringify(app.editor.text)}`)
  await end(app)
})

test('typed prefix chunk + raw paste chunk merge in the editor', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('hello ')
  app.feed('world\r\nand more')
  await sleep(10)
  if (host.sent.length !== 0) throw new Error('mixed typed+paste must NOT submit')
  if (app.editor.text !== 'hello world\nand more') throw new Error(`merge wrong: ${JSON.stringify(app.editor.text)}`)
  await end(app)
})

test('paste finishing with a typed bare enter submits the whole thing', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('line one\r\nline two')
  app.feed('\r')
  await sleep(30)
  if (host.sent.length !== 1 || host.sent[0].text !== 'line one\nline two') throw new Error(`paste+enter must submit once: ${JSON.stringify(host.sent)}`)
  await end(app)
})

test('single-line paste without any newline just types out (no heuristic needed)', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('just text, no newline at all')
  await sleep(10)
  if (host.sent.length !== 0) throw new Error('no-newline chunk must not submit by itself')
  if (app.editor.text !== 'just text, no newline at all') throw new Error(`plain text wrong: ${JSON.stringify(app.editor.text)}`)
  await end(app)
})

test('split ESC residue + next chunk: alt+enter across two feeds still a newline', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('a\x1b') // dangling ESC waits for its next byte
  app.feed('\rb')
  await sleep(10)
  if (host.sent.length !== 0) throw new Error('split alt+enter must NOT submit')
  if (app.editor.text !== 'a\nb') throw new Error(`split alt+enter wrong: ${JSON.stringify(app.editor.text)}`)
  await end(app)
})

test('big real-world paste: code with tabs + CRLF + trailing newline', async () => {
  const host = new FakeHost(tmp)
  const { app } = await started(host)
  app.feed('function main() {\r\n\tconst x = 1;\r\n\treturn x;\r\n}\r\n')
  await sleep(10)
  if (host.sent.length !== 0) throw new Error('code paste must NOT submit')
  const want = 'function main() {\n\tconst x = 1;\n\treturn x;\n}'
  if (app.editor.text !== want) throw new Error(`code paste wrong: ${JSON.stringify(app.editor.text)}`)
  await end(app)
})

/* ---------------- runner ---------------- */

async function main(): Promise<void> {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-paste-test-'))
  fs.writeFileSync(path.join(tmp, 'alpha.txt'), 'alpha')

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
