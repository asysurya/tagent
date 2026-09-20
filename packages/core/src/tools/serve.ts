import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '../types'
import { ensureDir, trunc } from '../util'
import { resolveShell } from './bash'

/**
 * Background dev-server manager — the "run the project" half of test mode.
 *
 * The agent starts the project's dev server (auto-detected from package.json
 * scripts, or an explicit command), waits until the port answers, and then
 * drives it with the browser tool. One server per session; `serve stop` (or
 * session abort) kills the whole process tree.
 */

interface ServeState {
  command: string
  child: ChildProcess
  pid: number
  port?: number
  url?: string
  startedAt: number
  ready: boolean
  /** rolling output ring (last ~16KB) */
  log: string
  exited?: { code: number | null; signal: string | null; at: number }
}

/** sessionId → running server (the daemon hosts many sessions) */
const SERVERS = new Map<string, ServeState>()

const LOG_CAP = 16_000
const DEFAULT_READY_TIMEOUT = 90_000

const URL_PORT_RE = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/
const PORT_WORD_RE = /\bport[ :=]+(\d{2,5})\b/i

export const serveTool: ToolDefinition = {
  name: 'serve',
  description:
    'Start the project in the background and wait until it is reachable — the first step of any test run. ' +
    'Auto-detects the dev command from package.json scripts (dev > start > serve, package manager from the lockfile); ' +
    'pass a custom command for anything else. Actions: start | stop | status | logs.',
  risk: 'high',
  params: {
    action: 'string (required) — "start" | "stop" | "status" | "logs"',
    command: 'string — explicit command to run (default: detected from package.json)',
    port: 'number — expected port (default: parsed from server output)',
    timeout: 'number — ms to wait for the server to answer (default 90000)',
  },
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop', 'status', 'logs'], description: 'Serve action' },
      command: { type: 'string', description: 'Explicit dev-server command (default: auto-detect)' },
      port: { type: 'number', description: 'Expected port number' },
      timeout: { type: 'number', description: 'Ready-wait timeout in ms (default 90000)' },
    },
    required: ['action'],
  },
  async run(input, ctx) {
    if (ctx.config.tools.serve === false) {
      return 'Error: the serve tool is disabled (enable it in Settings → Tools).'
    }
    const action = String(input.action ?? '')
    try {
      switch (action) {
        case 'start':
          return await startServer(input, ctx)
        case 'stop':
          return await stopServer(ctx.sessionId)
        case 'status':
          return serverStatus(ctx.sessionId)
        case 'logs': {
          const st = SERVERS.get(ctx.sessionId)
          if (!st) return 'No server running for this session. serve start first.'
          return `command: ${st.command}\n${st.exited ? `EXITED ${st.exited.code ?? ''}${st.exited.signal ?? ''} at ${new Date(st.exited.at).toISOString()}` : 'running'}\n\n${trunc(st.log, 8_000)}`
        }
        default:
          return `Error: unknown action "${action}" — use start | stop | status | logs`
      }
    } catch (e) {
      return `Serve error: ${(e as Error).message}`
    }
  },
}

/* ------------------------------------------------------------------ */
/* start                                                                */
/* ------------------------------------------------------------------ */

async function startServer(input: Record<string, unknown>, ctx: Parameters<ToolDefinition['run']>[1]): Promise<string> {
  const root = ctx.workspaceRoot
  const explicitPort = Number(input.port ?? 0) || undefined
  const command = String(input.command ?? '') || detectDevCommand(root)

  if (!command) {
    return [
      'Error: no dev command detected.',
      'There is no package.json with a dev/start/serve script in this workspace.',
      'Pass an explicit command, e.g. {"action":"start","command":"python3 -m http.server 8000"} or "npx serve -l 8000".',
    ].join('\n')
  }

  // one server per session — restarting replaces it
  const existing = SERVERS.get(ctx.sessionId)
  if (existing) await stopServer(ctx.sessionId)

  const shell = resolveShell()
  const child = spawn(shell, ['-lc', command], {
    cwd: root,
    detached: process.platform !== 'win32', // own process group → kill the tree
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TERM: 'dumb',
      NO_COLOR: '1',
      // an explicit port becomes the PORT env — many dev servers honor it
      ...(explicitPort ? { PORT: String(explicitPort) } : {}),
    },
  })
  const st: ServeState = {
    command,
    child,
    pid: child.pid ?? -1,
    port: explicitPort,
    startedAt: Date.now(),
    ready: false,
    log: '',
  }
  SERVERS.set(ctx.sessionId, st)

  const append = (d: Buffer) => {
    if (st.log.length < LOG_CAP * 2) {
      st.log += d.toString()
      if (st.log.length > LOG_CAP) st.log = st.log.slice(-LOG_CAP)
    }
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.on('exit', (code, signal) => {
    st.exited = { code, signal, at: Date.now() }
  })
  // session abort → kill the server (best-effort, once)
  ctx.signal?.addEventListener('abort', () => {
    void stopServer(ctx.sessionId)
  }, { once: true })
  // daemon shutdown hygiene — never leak dev servers past our process
  registerExitHook()

  const timeout = Math.min(Number(input.timeout ?? DEFAULT_READY_TIMEOUT), 300_000)

  // 1) the port may be user-provided or parsed from server output
  const port = await waitForPort(st, timeout)
  if (!port) {
    const died = st.exited ? `The command EXITED (code ${st.exited.code ?? st.exited.signal}) — probably wrong command or missing dependencies.` : `No port appeared in the output within ${(timeout / 1000) | 0}s.`
    return `Error: could not detect the server port. ${died}\n\nLast output:\n${trunc(st.log, 3_000)}`
  }
  st.port = port

  // 2) wait until the port actually answers HTTP
  const url = `http://127.0.0.1:${port}`
  const ready = await waitUntilReachable(url, timeout)
  st.ready = ready
  if (!ready) {
    return `Warning: ${url} did not answer within ${(timeout / 1000) | 0}s.\nTry browser open anyway — the app may still be compiling. Recent output:\n${trunc(st.log, 3_000)}`
  }

  const rel = path.relative(root, root)
  const elapsed = ((Date.now() - st.startedAt) / 1000).toFixed(1)
  return [
    `Server ready in ${elapsed}s${rel ? '' : ''}`,
    `url: ${url}`,
    `command: ${command}`,
    `stop with: {"tool":"serve","input":{"action":"stop"}}`,
    st.log ? `\nstartup output:\n${trunc(st.log.split('\n').slice(-15).join('\n'), 1_500)}` : '',
  ].filter(Boolean).join('\n')
}

/**
 * Resolve the port: explicit → parsed from output. Also handles servers that
 * die instantly (bad command).
 */
async function waitForPort(st: ServeState, timeout: number): Promise<number | undefined> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (st.exited) return undefined
    if (st.port) {
      // verify it actually matches a URL the server printed, then continue to HTTP poll
      return st.port
    }
    for (const re of [URL_PORT_RE, PORT_WORD_RE]) {
      const m = st.log.match(re)
      if (m) {
        const p = Number(m[1])
        if (p > 0 && p < 65_536) return p
      }
    }
    await sleep(250)
  }
  return undefined
}

async function waitUntilReachable(url: string, timeout: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      // any HTTP answer counts — dev servers return 200/304 even while compiling
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      res.body?.cancel().catch(() => undefined)
      return true
    } catch {
      await sleep(300)
    }
  }
  return false
}

/* ------------------------------------------------------------------ */
/* stop / status                                                        */
/* ------------------------------------------------------------------ */

async function stopServer(sessionId: string): Promise<string> {
  const st = SERVERS.get(sessionId)
  if (!st) return 'No server running for this session.'
  SERVERS.delete(sessionId)
  killTree(st)
  const gone = await waitForExit(st, 5_000)
  return gone ? 'Server stopped.' : 'Server stop signal sent (process may take a moment to die).'
}

function serverStatus(sessionId: string): string {
  const st = SERVERS.get(sessionId)
  if (!st) return 'No server for this session. serve start will boot the project.'
  const uptime = ((Date.now() - st.startedAt) / 1000) | 0
  if (st.exited) {
    return `command: ${st.command}\nEXITED (code ${st.exited.code ?? ''}${st.exited.signal ?? ''}) after ${uptime}s\n\n${trunc(st.log, 2_000)}`
  }
  return [
    `running (pid ${st.pid}, ${uptime}s)`,
    `command: ${st.command}`,
    st.url ? `url: ${st.url}` : st.port ? `port: ${st.port}` : 'port: (not detected yet)',
    `ready: ${st.ready ? 'yes' : 'not confirmed'}`,
  ].join('\n')
}

/* ------------------------------------------------------------------ */
/* detection + process-tree kill                                        */
/* ------------------------------------------------------------------ */

/** package.json scripts → shell command, package manager aware. */
export function detectDevCommand(root: string): string | undefined {
  let pkg: any
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {
    // no package.json — static site? python http.server is a decent default on POSIX
    if (fs.existsSync(path.join(root, 'index.html')) && process.platform !== 'win32') {
      return 'python3 -m http.server 8000'
    }
    return undefined
  }
  const scripts = pkg?.scripts ?? {}
  const scriptName = ['dev', 'start', 'serve'].find((s) => typeof scripts[s] === 'string' && scripts[s])
  if (!scriptName) {
    if (fs.existsSync(path.join(root, 'index.html')) && process.platform !== 'win32') {
      return 'python3 -m http.server 8000'
    }
    return undefined
  }
  const pm = detectPackageManager(root)
  return `${pm} run ${scriptName}`
}

function detectPackageManager(root: string): string {
  if (fs.existsSync(path.join(root, 'bun.lock')) || fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun'
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/** Kill the process group on POSIX, the tree on Windows. */
function killTree(st: ServeState): void {
  try {
    if (process.platform === 'win32') {
      if (st.pid > 0) spawn('taskkill', ['/pid', String(st.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      if (st.pid > 0) process.kill(-st.pid, 'SIGTERM') // negative → group
    }
  } catch {
    try { st.child.kill('SIGTERM') } catch { /* already gone */ }
  }
}

async function waitForExit(st: ServeState, ms: number): Promise<boolean> {
  const t0 = Date.now()
  while (!st.exited && Date.now() - t0 < ms) await sleep(150)
  if (!st.exited) {
    // escalate
    try {
      if (process.platform === 'win32') {
        if (st.pid > 0) spawn('taskkill', ['/pid', String(st.pid), '/T', '/F'], { stdio: 'ignore' })
      } else if (st.pid > 0) process.kill(-st.pid, 'SIGKILL')
    } catch { /* already gone */ }
    return false
  }
  return true
}

/* ------------------------------------------------------------------ */

let _exitHooked = false
function registerExitHook(): void {
  if (_exitHooked) return
  _exitHooked = true
  process.on('exit', () => {
    for (const st of SERVERS.values()) killTree(st)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
