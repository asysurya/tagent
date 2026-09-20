/**
 * RPC smoke test for the v0.13 auth/sync daemon surface:
 *   auth:status / auth:login / auth:logout
 *   sync:status / sync:push / sync:link / sync:refuse / sync:unlink
 *   projects:list
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the daemon (and core)
 * loads, so the credential store, global config and project registry are all
 * fresh — no real credentials are touched. The "GitHub" for the success path
 * is (a) a fetch mock for api.github.com and (b) a local bare git repo reached
 * through a git `insteadOf` rewrite, so the push itself is offline too.
 * The one real network call is the negative login test (a fake PAT must get
 * a clean 401/network error ack, never a hang) — with a short timeout.
 *
 * Run: bun scripts/test-auth-rpc.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/* ---- hermetic environment (MUST be set before daemon/core is imported) ---- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tagent-auth-rpc-'))
const HOME = path.join(TMP, 'home')
fs.mkdirSync(HOME, { recursive: true })
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = path.join(TMP, 'gitconfig') // contains only insteadOf

const exec = promisify(execFile)
async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args)
  return stdout.trim()
}

let fails = 0
function assert(cond: boolean, label: string, extra?: unknown) {
  console.log(cond ? '✓' : '✗', label)
  if (!cond) {
    fails++
    if (extra !== undefined) console.log('   →', JSON.stringify(extra))
  }
}

/* ---- world: a workspace with work + a local bare repo standing in for GitHub ---- */
const WS = path.join(TMP, 'ws')
fs.mkdirSync(WS, { recursive: true })
fs.writeFileSync(path.join(WS, 'README.md'), '# smoke workspace\n')

const FAKE_PAT = 'ghp_SmokeTestFakePat0000000000000000'
const GH_DIR = path.join(TMP, 'gh-remote')
fs.mkdirSync(GH_DIR, { recursive: true })
await git('init', '--bare', path.join(GH_DIR, 'tagent-ws.git'))
// any https github URL for octocat/ (clean or one-shot-token form) lands in the local bare dir
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL as string, [
  `[url "${GH_DIR}/"]`,
  '\tinsteadOf = https://github.com/octocat/',
  `\tinsteadOf = https://x-access-token:${FAKE_PAT}@github.com/octocat/`,
  '',
].join('\n'))

/* ---- watchdog: a hung RPC fails the smoke, never the CI runner ---- */
const watchdog = setTimeout(() => {
  console.error('✗ SMOKE FAILED: global 120s watchdog — an RPC hung')
  process.exit(1)
}, 120_000)

/* ---- boot the daemon in-process, then a real socket.io client against it ---- */
const { createDaemon } = await import('../packages/cli/src/daemon')
const handle = await createDaemon({ port: 0, workspaceRoot: WS, quiet: true })
const addr = handle.server.address() as { port: number }
const { io } = await import('socket.io-client')
const socket = io(`http://127.0.0.1:${addr.port}`, { path: '/socket', transports: ['websocket'] })

function rpc<T>(event: string, payload?: unknown, ms = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} timed out after ${ms}ms`)), ms)
    socket.emit(event, payload, (res: T) => { clearTimeout(t); resolve(res) })
  })
}

type Ack = Record<string, unknown>

async function main() {
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', resolve)
    socket.on('connect_error', reject)
  })
  console.log('✓ connected to daemon (workspace: %s)\n', WS)

  /* ------------------------------ guest phase ------------------------------ */
  const st0 = await rpc<Ack>('auth:status')
  assert(st0.ok === true && st0.guest === true && st0.login === undefined, 'auth:status → guest, no login', st0)

  const ss0 = await rpc<Ack>('sync:status')
  assert(ss0.ok === true && ss0.linked === false && ss0.guest === true, 'sync:status → not linked, guest', ss0)

  const pl0 = await rpc<Ack>('projects:list')
  assert(pl0.ok === true && Array.isArray(pl0.projects) && (pl0.projects as unknown[]).length === 0, 'projects:list → empty registry', pl0)

  const push0 = await rpc<Ack>('sync:push', { message: 'should fail' })
  assert(push0.ok === false && push0.error === 'not logged in', 'sync:push while guest → { ok:false, error:"not logged in" }', push0)

  const link0 = await rpc<Ack>('sync:link', {})
  assert(link0.ok === false && link0.error === 'not logged in', 'sync:link (no repo) while guest → not logged in', link0)

  // negative login: obviously-fake PAT against the REAL api.github.com.
  // Must come back as a clean { ok:false } (401 or a network error) — never a hang.
  const bad = await rpc<Ack>('auth:login', { pat: 'ghp_DefinitelyNotARealToken1234567890' }, 20000)
  assert(bad.ok === false && typeof bad.error === 'string' && (bad.error as string).length > 0, 'auth:login with fake PAT → graceful { ok:false } (no credential saved)', bad)
  const stillGuest = await rpc<Ack>('auth:status')
  assert(stillGuest.guest === true, 'still guest after failed login', stillGuest)

  /* ----------------------- mocked-GitHub success path ----------------------- */
  // api.github.com answers as octocat from here on (the git side already goes
  // to the local bare repo via insteadOf)
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

  const login1 = await rpc<Ack>('auth:login', { pat: FAKE_PAT }, 20000)
  assert(login1.ok === true && login1.login === 'octocat' && login1.promptLink === true,
    'auth:login (valid) → { ok, login, promptLink:true } — workspace has work, not linked, not refused', login1)

  const st1 = await rpc<Ack>('auth:status')
  assert(st1.ok === true && st1.guest === false && st1.login === 'octocat', 'auth:status → logged in as octocat', st1)

  const ss1 = await rpc<Ack>('sync:status')
  assert(ss1.ok === true && ss1.guest === false && ss1.login === 'octocat' && ss1.linked === false,
    'sync:status → logged in, still not linked', ss1)

  const push1 = await rpc<Ack>('sync:push', { message: 'smoke: initial upload from tagent' }, 60000)
  assert(push1.ok === true && push1.repo === 'octocat/tagent-ws' &&
    typeof push1.url === 'string' && typeof push1.lastSyncAt === 'number' && (push1.lastSyncAt as number) > 0,
    'sync:push → committed + pushed (registry auto-link), url + lastSyncAt returned', push1)

  const ss2 = await rpc<Ack>('sync:status')
  assert(ss2.ok === true && ss2.linked === true && ss2.repo === 'octocat/tagent-ws' &&
    typeof ss2.lastSyncAt === 'number', 'sync:status after push → linked with lastSyncAt', ss2)

  const pl1 = await rpc<Ack>('projects:list')
  const projects1 = (pl1.projects as Array<Record<string, unknown>>) ?? []
  assert(pl1.ok === true && projects1.length === 1 &&
    projects1[0]?.repo === 'octocat/tagent-ws' && projects1[0]?.root === path.resolve(WS),
    'projects:list → 1 project matching the pushed workspace', pl1)

  const login2 = await rpc<Ack>('auth:login', { pat: FAKE_PAT }, 20000)
  assert(login2.ok === true && login2.promptLink === false,
    'auth:login again → promptLink:false (already linked — the prompt fires once)', login2)

  /* ---------------------- refuse / unlink / manual link ---------------------- */
  const unlink1 = await rpc<Ack>('sync:unlink')
  assert(unlink1.ok === true, 'sync:unlink → registry link removed', unlink1)
  const ss3 = await rpc<Ack>('sync:status')
  assert(ss3.linked === false, 'sync:status after unlink → not linked', ss3)

  const login3 = await rpc<Ack>('auth:login', { pat: FAKE_PAT }, 20000)
  assert(login3.ok === true && login3.promptLink === true,
    'auth:login after unlink → promptLink:true again (not refused yet)', login3)

  const refuse1 = await rpc<Ack>('sync:refuse')
  assert(refuse1.ok === true, 'sync:refuse → "Jangan untuk proyek ini" recorded', refuse1)
  const login4 = await rpc<Ack>('auth:login', { pat: FAKE_PAT }, 20000)
  assert(login4.ok === true && login4.promptLink === false,
    'auth:login after refuse → promptLink:false (never asked again)', login4)

  const link1 = await rpc<Ack>('sync:link', { repo: 'octocat/manual-link' }, 20000)
  assert(link1.ok === true && link1.repo === 'octocat/manual-link',
    'sync:link { repo } → linked without network (explicit repo)', link1)
  const ss4 = await rpc<Ack>('sync:status')
  assert(ss4.linked === true && ss4.repo === 'octocat/manual-link',
    'sync:status after manual link → linked (refusal cleared by linking)', ss4)

  /* ------------------------------ logout phase ------------------------------ */
  const lo = await rpc<Ack>('auth:logout')
  assert(lo.ok === true, 'auth:logout → ok', lo)
  const st2 = await rpc<Ack>('auth:status')
  assert(st2.ok === true && st2.guest === true && st2.login === undefined, 'auth:status after logout → guest again', st2)
  const push2 = await rpc<Ack>('sync:push', {})
  assert(push2.ok === false && push2.error === 'not logged in', 'sync:push after logout → not logged in', push2)
  // the registry link survives logout (linking is about the repo, not the auth)
  const ss5 = await rpc<Ack>('sync:status')
  assert(ss5.linked === true && ss5.guest === true, 'sync:status after logout → linked repo kept, guest', ss5)
}

try {
  await main()
} catch (e) {
  console.error('✗ SMOKE FAILED:', (e as Error).message)
  fails++
} finally {
  socket.disconnect()
  await new Promise((r) => setTimeout(r, 300)) // let the websocket teardown land
  // the daemon's close can stall on lingering sockets — never let it hang the smoke
  await Promise.race([
    handle.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 5000)),
  ])
  clearTimeout(watchdog)
  console.log(fails === 0 ? '\nALL AUTH/SYNC RPC CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`)
  if (fails === 0) fs.rmSync(TMP, { recursive: true, force: true })
  else console.error(`workdir kept for inspection: ${TMP}`)
  process.exit(fails === 0 ? 0 : 1)
}
