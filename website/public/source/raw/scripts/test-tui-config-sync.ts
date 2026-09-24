/**
 * TUI config-sync integration test (v0.24) — the /config cockpit + the boot
 * pass ("kalo reponya diapus tagent bakal ngecek terus dan kasih warn setiap
 * tagent start"):
 *
 *  1. logged-in boot with NO config repo yet → the lazy bootstrap creates it
 *     (mocked api.github.com + local bare repo through git insteadOf)
 *  2. /config status → repo + health OK
 *  3. repo deleted (mock flips to 404) → the next boot WARNS
 *  4. /config push → recreates the repo, warning path resolves
 *
 * Hermetic: HOME redirected before core/tui-app load; zero real network
 * (same world as test-tui-sync.ts).
 *
 * Run: bun scripts/test-tui-config-sync.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/* ---------------- hermetic environment (BEFORE core/tui-app import) ---------------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-tui-cfg-'))
const HOME = path.join(TMP, 'home')
fs.mkdirSync(HOME, { recursive: true })
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = path.join(TMP, 'gitconfig')

const exec = promisify(execFile)
async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args)
  return stdout.trim()
}

/* ---- world: workspace + local bare repo standing in for GitHub ---- */
const WS = path.join(TMP, 'ws')
fs.mkdirSync(WS, { recursive: true })
fs.writeFileSync(path.join(WS, 'README.md'), '# cfg sync workspace\n')

const FAKE_PAT = 'ghp_tuicfg-hermetic-fake-0001'
const GH_DIR = path.join(TMP, 'gh-remote')
fs.mkdirSync(GH_DIR, { recursive: true })
await git('init', '--bare', '-b', 'main', path.join(GH_DIR, 'tagent-config.git'))
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL as string, [
  `[url "${GH_DIR}/"]`,
  '\tinsteadOf = https://github.com/octocat/',
  `\tinsteadOf = https://x-access-token:${FAKE_PAT}@github.com/octocat/`,
  '',
].join('\n'))

/* ---- api.github.com mock: 200 octocat everywhere; the repo can "vanish" ---- */
let repoExists = true
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
  if (url.startsWith('https://api.github.com/')) {
    if (url.includes('/repos/octocat/tagent-config')) {
      if (!repoExists && (init?.method ?? 'GET') === 'GET') {
        return new Response('{"message":"Not Found"}', { status: 404, headers: { 'content-type': 'application/json' } })
      }
      if (!repoExists && (init?.method ?? '') === 'DELETE') {
        return new Response('', { status: 204 })
      }
      return new Response(JSON.stringify({ full_name: 'octocat/tagent-config', private: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/user/repos')) {
      // the create call — flips the world back to "exists"
      repoExists = true
      return new Response(JSON.stringify({ full_name: 'octocat/tagent-config', private: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ login: 'octocat' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return realFetch(input, init)
}) as typeof fetch

/* ---- imports AFTER the env is pinned (type-only imports are erased at runtime) ---- */
import type { AppIO } from '../packages/cli/src/tui-app'
const { TuiApp, setAppColor } = await import('../packages/cli/src/tui-app')
const core = await import('../packages/core/src/index')
import type { AgentHost } from '../packages/cli/src/host'

/* ---------------- harness (same style as test-tui-sync.ts) ---------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ANSI_ONLY = /\x1b\[[0-9;?]*[A-Za-z]/g
const stripAnsi = (s: string): string => s.replace(ANSI_ONLY, '')

class FakeOut {
  isTTY = true
  columns = 110
  rows = 34
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
  session: { id: string; title: string; mode: 'build' | 'plan' } | undefined
  cfg: Record<string, unknown> = {
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
    return { defaultModel: 'glm-4.7', defaultProvider: 'zai', caveman: false, worklog: { enabled: true } }
  }
  mcpState: { state: string; tools: number }[] = []
  mcpStatus(): { state: string; tools: number }[] {
    return this.mcpState
  }
  async mcpEnsure(): Promise<{ state: string; tools: number }[]> {
    return this.mcpState
  }
  contextInfo(): { used: number; limit: number; pct: number; bar: string } {
    return { used: 0, limit: 131_072, pct: 0, bar: '' }
  }
  compactThreshold(): number {
    return 80
  }
  compactSession(): { ok: false; error: string } {
    return { ok: false, error: 'nothing to compact' }
  }
  sessionTranscript(): { t: string; m?: number }[] {
    return []
  }
  sessionTranscriptAppend(): void {}
  sessionTranscriptTrim(): void {}
  interrupt(): void {}
}

let fails = 0
function assert(cond: boolean, label: string, extra?: unknown) {
  console.log(cond ? '✓' : '✗', label)
  if (!cond) {
    fails++
    if (extra !== undefined) console.log('   →', JSON.stringify(extra))
  }
}

type AppInternals = {
  command(raw: string): Promise<void>
}
const internals = (app: TuiApp): AppInternals => app as unknown as AppInternals

async function bootApp(): Promise<{ app: TuiApp; out: FakeOut }> {
  const host = new FakeHost(WS)
  const out = new FakeOut()
  const io: AppIO = { input: new FakeIn() as never, output: out as never }
  const app = new TuiApp(host as unknown as AgentHost, { workspaceRoot: WS, updateCheck: false, io })
  void app.start()
  await sleep(6000) // let the boot config pass (fetch + git) settle
  app.renderNow()
  return { app, out }
}

async function main(): Promise<void> {
  setAppColor(true)

  /* ---------------- 0. login state, no config repo yet ---------------- */
  core.saveGithubLogin(FAKE_PAT, 'octocat')
  assert(!fs.existsSync(path.join(HOME, '.tagent', 'config-sync.json')), 'no config-sync state yet')

  /* ---------------- 1. logged-in boot → lazy bootstrap ---------------- */
  const a = await bootApp()
  const seenA = stripAnsi(a.out.text())
  const st1 = core.readConfigSyncState()
  assert(st1.repo === 'octocat/tagent-config', 'boot bootstrapped the config repo', st1)
  assert(typeof st1.lastPushAt === 'number', 'boot pushed the config', st1)
  assert(fs.existsSync(path.join(HOME, '.tagent', 'config-repo', 'vault.json')), 'vault.json exists in the checkout')
  assert(seenA.includes('config repo') || seenA.includes('config sync'), 'boot printed the config repo feedback', seenA.slice(-500))
  const vaultRaw = fs.readFileSync(path.join(HOME, '.tagent', 'config-repo', 'vault.json'), 'utf8')
  assert(!vaultRaw.includes(FAKE_PAT), 'vault never contains the GitHub token')
  a.app.destroy()

  /* ---------------- 2. /config status → repo + health ---------------- */
  const b = await bootApp()
  await internals(b.app).command('/config status')
  await sleep(300)
  b.app.renderNow()
  const seenB = stripAnsi(b.out.text())
  assert(seenB.includes('global — status'), '/config status renders the card', seenB.slice(-600))
  assert(seenB.includes('octocat/tagent-config'), 'card names the repo', seenB.slice(-600))
  assert(seenB.includes('repo exists'), 'health check says exists', seenB.slice(-600))
  b.app.destroy()

  /* ---------------- 3. repo deleted → next boot warns ---------------- */
  repoExists = false
  const c = await bootApp()
  await sleep(1500)
  c.app.renderNow()
  const seenC = stripAnsi(c.out.text())
  assert(seenC.includes('deleted on GitHub'), 'boot WARNS about the deleted repo', seenC.slice(-700))
  assert(seenC.includes('/config push'), 'warning points at the fix', seenC.slice(-700))
  assert(/recreates/i.test(seenC), 'warning explains the recreate', seenC.slice(-700))
  c.app.destroy()

  /* ---------------- 4. /config push → recreates + resolves ---------------- */
  const d = await bootApp()
  await internals(d.app).command('/config push')
  await sleep(800)
  d.app.renderNow()
  const seenD = stripAnsi(d.out.text())
  assert(seenD.includes('octocat/tagent-config'), '/config push recreates the repo', seenD.slice(-700))
  const st4 = core.readConfigSyncState()
  assert(typeof st4.lastPushAt === 'number' && st4.repo === 'octocat/tagent-config', 'state healthy after recreate', st4)
  d.app.destroy()

  console.log(fails === 0 ? '\nTUI CONFIG SYNC: ALL GREEN' : `\n${fails} FAILURES`)
  process.exit(fails === 0 ? 0 : 1)
}

void main()
