/**
 * TUI GitHub-sync integration test (v0.13, QA pass 14-9) — covers the two
 * pieces A1 left for integration:
 *
 *  1. stats-row sync badge — '⎇ owner/repo' appears only while the project
 *     is linked AND logged in; guests see nothing. The badge is CACHED
 *     (refreshed at boot / after /push), never read per-frame.
 *  2. /push rerouted through core syncProject — the registry-aware path the
 *     daemon's sync:push uses — so a push from the TUI links the project
 *     and stamps lastSyncAt (the legacy host.githubPush never did).
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE core/tui-app load, so
 * the credential store, global config and project registry are fresh. The
 * "GitHub" for the success path is an api.github.com fetch mock plus a
 * local bare git repo reached through a git `insteadOf` rewrite — zero
 * real network, zero real credentials (same world as test-auth-rpc.ts).
 *
 * Run: bun scripts/test-tui-sync.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/* ---------------- hermetic environment (BEFORE core/tui-app import) ---------------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-tui-sync-'))
const HOME = path.join(TMP, 'home')
fs.mkdirSync(HOME, { recursive: true })
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = path.join(TMP, 'gitconfig') // only the insteadOf rewrites

const exec = promisify(execFile)
async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args)
  return stdout.trim()
}

/* ---- world: a workspace with work + a local bare repo standing in for GitHub ---- */
const WS = path.join(TMP, 'ws')
fs.mkdirSync(WS, { recursive: true })
fs.writeFileSync(path.join(WS, 'README.md'), '# tui sync workspace\n')

const FAKE_PAT = 'ghp_tuisync-hermetic-fake-0001'
const GH_DIR = path.join(TMP, 'gh-remote')
fs.mkdirSync(GH_DIR, { recursive: true })
await git('init', '--bare', '-b', 'main', path.join(GH_DIR, 'tagent-ws.git'))
// any https github URL for octocat/ (clean or one-shot-token form) lands in the local bare dir
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL as string, [
  `[url "${GH_DIR}/"]`,
  '\tinsteadOf = https://github.com/octocat/',
  `\tinsteadOf = https://x-access-token:${FAKE_PAT}@github.com/octocat/`,
  '',
].join('\n'))

/* ---- api.github.com answers as octocat from here on (git already goes local) ---- */
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
  if (url.startsWith('https://api.github.com/')) {
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

/* ---------------- harness (same style as test-tui-md.ts) ---------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ANSI_ONLY = /\x1b\[[0-9;?]*[A-Za-z]/g
const stripAnsi = (s: string): string => s.replace(ANSI_ONLY, '')

class FakeOut {
  isTTY = true
  columns = 100
  rows = 30
  chunks: string[] = []
  write(s: string): void {
    this.chunks.push(s)
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
    return {
      defaultModel: 'glm-4.7',
      defaultProvider: 'zai',
      caveman: false,
      worklog: { enabled: true },
      mcpStatus: [],
    }
  }
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

/** private-member accessors (test-only casts) */
type AppInternals = {
  command(raw: string): Promise<void>
  refreshSyncBadge(): void
}
const internals = (app: TuiApp): AppInternals => app as unknown as AppInternals

const framePlain = (app: TuiApp): string => app.lastFrame.map(stripAnsi).join('\n')
const statsRowPlain = (app: TuiApp): string => {
  const row = app.lastFrame.map(stripAnsi).find((r) => r.includes(' · build · ') || r.includes(' · plan · '))
  return row ?? ''
}

async function main(): Promise<void> {
  setAppColor(true)

  /* ---------------- 1. guest boot: stats row, no sync badge ---------------- */
  const host = new FakeHost(WS)
  const io: AppIO = { input: new FakeIn() as never, output: new FakeOut() as never }
  const app = new TuiApp(host as unknown as AgentHost, { workspaceRoot: WS, updateCheck: false, io })
  void app.start()
  await sleep(80)
  app.renderNow()

  const guestStats = statsRowPlain(app)
  assert(guestStats.length > 0, 'stats row renders for a guest', guestStats)
  assert(!guestStats.includes('⎇'), 'guest stats row has no sync badge', guestStats)
  assert(core.listProjects().length === 0, 'registry starts empty')

  /* ---------------- 2. /push while guest → friendly guard ---------------- */
  await internals(app).command('/push')
  await sleep(10)
  app.renderNow()
  const guestPush = framePlain(app)
  assert(guestPush.includes('not logged in'), '/push as guest → "not logged in" guard', guestPush.slice(-400))
  assert(!guestPush.includes('pushing…'), 'guest /push never starts pushing', guestPush.slice(-400))
  assert(core.listProjects().length === 0, 'registry still empty after guest /push')

  /* ---------------- 3. login, then /push goes through syncProject ---------------- */
  core.saveGithubLogin(FAKE_PAT, 'octocat') // exactly what `tagent auth` / the GUI dialog do
  await internals(app).command('/push test: tui sync integration')
  await sleep(10)
  app.renderNow()
  const pushed = framePlain(app)

  assert(pushed.includes('Ensuring repo octocat/tagent-ws'), '/push streams syncProject onLog lines', pushed.slice(-600))
  assert(pushed.includes('✔ pushed to octocat/tagent-ws'), '/push success line names the repo', pushed.slice(-600))
  assert(pushed.includes('https://github.com/octocat/tagent-ws'), '/push prints the repo URL', pushed.slice(-600))

  /* ---------------- 4. registry updated (the whole point of the reroute) ---------------- */
  const projects = core.listProjects()
  assert(projects.length === 1, 'registry has exactly 1 project after /push', projects)
  const p = projects[0]
  assert(p?.repo === 'octocat/tagent-ws', 'registry entry repo matches', p)
  assert(p?.root === path.resolve(WS), 'registry entry root matches the workspace', p)
  assert(typeof p?.lastSyncAt === 'number' && (p?.lastSyncAt ?? 0) > 0, 'registry entry has lastSyncAt', p)

  /* ---------------- 5. the bare "GitHub" really received the commit ---------------- */
  const remoteLog = await git('--git-dir', path.join(GH_DIR, 'tagent-ws.git'), 'log', '--oneline', 'main')
  assert(remoteLog.includes('test: tui sync integration'), 'bare remote received the commit', remoteLog)
  const remoteTokenLeak = await git('--git-dir', path.join(GH_DIR, 'tagent-ws.git'), 'config', '--get', 'remote.origin.url').catch(() => '')
  assert(!remoteTokenLeak.includes(FAKE_PAT), 'no token persisted in any remote config', remoteTokenLeak)

  /* ---------------- 6. the badge lights up (cached refresh after /push) ---------------- */
  const badgeStats = statsRowPlain(app)
  assert(badgeStats.includes('⎇ octocat/tagent-ws'), 'stats row shows the sync badge after /push', badgeStats)
  assert(badgeStats.trimEnd().endsWith('ws'), 'stats row still ends with the workspace name', badgeStats)

  /* ---------------- 7. badge clears on logout (linked but guest → hidden) ---------------- */
  core.logout()
  internals(app).refreshSyncBadge()
  app.renderNow()
  const loggedOutStats = statsRowPlain(app)
  assert(!loggedOutStats.includes('⎇'), 'badge hidden after logout (guest again)', loggedOutStats)
  assert(core.getLinkedProject(WS)?.repo === 'octocat/tagent-ws', 'registry link survives logout (link ≠ auth)')

  /* ---------------- 8. /push after logout → guard again ---------------- */
  await internals(app).command('/push')
  await sleep(10)
  app.renderNow()
  assert(framePlain(app).includes('not logged in'), '/push after logout → guarded again')

  app.exit()
  await sleep(20)
  app.destroy()
}

const watchdog = setTimeout(() => {
  console.error('✗ TEST FAILED: global 120s watchdog')
  process.exit(1)
}, 120_000)

try {
  await main()
} catch (e) {
  console.error('✗ TEST CRASHED:', (e as Error).stack ?? e)
  fails++
} finally {
  clearTimeout(watchdog)
  console.log(fails === 0 ? '\nALL TUI SYNC CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`)
  if (fails === 0) fs.rmSync(TMP, { recursive: true, force: true })
  else console.error(`workdir kept for inspection: ${TMP}`)
  process.exit(fails === 0 ? 0 : 1)
}
