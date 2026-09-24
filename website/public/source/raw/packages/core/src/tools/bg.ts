import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { ToolDefinition } from '../types'
import { trunc } from '../util'
import { resolveShell } from './bash'

/**
 * Background process tools — the "keep it running while I work" half of
 * long-running work.
 *
 * bash BLOCKS until the command finishes; serve is web-server-shaped.
 * bg_run spawns ANY long command (dev server, file watcher, npm install on
 * a slow link, a soak-test loop) in its own process group and returns
 * immediately; bg_logs checks on it later; bg_stop cleans it up.
 *
 * Processes survive across runs (that is the point) — they are killed by
 * bg_stop or when tagent itself exits.
 */

interface BgState {
  name: string
  command: string
  child: ChildProcess
  pid: number
  startedAt: number
  /** rolling output ring (last ~32KB) */
  log: string
  /** total output lines ever — a cheap "is it still doing things" signal */
  lines: number
  exited?: { code: number | null; signal: string | null; at: number }
}

/** `${sessionId}:${name}` → state (the daemon hosts many sessions) */
const PROCS = new Map<string, BgState>()

const LOG_CAP = 32_000
/** early-crash detection window — how long bg_run waits before declaring success */
const DEFAULT_WAIT_MS = 2_000
const MAX_WAIT_MS = 30_000

const key = (sessionId: string, name: string) => `${sessionId}:${name}`

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

function statusLine(st: BgState): string {
  if (st.exited) {
    const why = st.exited.signal ?? (st.exited.code === null ? 'unknown' : `code ${st.exited.code}`)
    return `exited (${why}) after ${((st.exited.at - st.startedAt) / 1000) | 0}s`
  }
  const up = ((Date.now() - st.startedAt) / 1000) | 0
  return `running (pid ${st.pid}, ${up}s, ${st.lines} output lines)`
}

/** Kill the process group on POSIX, the tree on Windows. */
function killTree(st: BgState): void {
  try {
    if (process.platform === 'win32') {
      if (st.pid > 0) spawn('taskkill', ['/pid', String(st.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      if (st.pid > 0) process.kill(-st.pid, 'SIGTERM') // negative → the whole group
    }
  } catch {
    try { st.child.kill('SIGTERM') } catch { /* already gone */ }
  }
}

async function waitDead(st: BgState, ms: number): Promise<boolean> {
  const t0 = Date.now()
  while (!st.exited && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 150))
  if (st.exited) return true
  try {
    if (process.platform === 'win32') {
      if (st.pid > 0) spawn('taskkill', ['/pid', String(st.pid), '/T', '/F'], { stdio: 'ignore' })
    } else if (st.pid > 0) {
      process.kill(-st.pid, 'SIGKILL')
    }
  } catch { /* already gone */ }
  return false
}

let _exitHooked = false
function registerExitHook(): void {
  if (_exitHooked) return
  _exitHooked = true
  process.on('exit', () => {
    for (const st of PROCS.values()) killTree(st)
  })
}

function spawnProc(name: string, command: string, ctx: Parameters<ToolDefinition['run']>[1]): BgState {
  const cwd = path.resolve(ctx.workspaceRoot)
  const child = spawn(resolveShell(), ['-lc', command], {
    cwd,
    detached: process.platform !== 'win32', // own process group → clean tree kill
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
  })
  const st: BgState = { name, command, child, pid: child.pid ?? -1, startedAt: Date.now(), log: '', lines: 0 }
  const append = (d: Buffer) => {
    if (st.log.length < LOG_CAP * 2) {
      st.log += d.toString()
      if (st.log.length > LOG_CAP) st.log = st.log.slice(-LOG_CAP)
      st.lines += d.toString().split('\n').length - 1
    }
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.on('exit', (code, signal) => {
    st.exited = { code, signal, at: Date.now() }
  })
  PROCS.set(key(ctx.sessionId, name), st)
  registerExitHook()
  return st
}

/* ------------------------------------------------------------------ */
/* the tools                                                            */
/* ------------------------------------------------------------------ */

const shellGated = (ctx: Parameters<ToolDefinition['run']>[1]): string | undefined =>
  ctx.config.tools.bash === false
    ? 'Error: background processes are disabled in this environment (the bash tool is off — enable it in Settings → Tools).'
    : undefined

export const bgRunTool: ToolDefinition = {
  name: 'bg_run',
  description:
    'Start a LONG-RUNNING command in the background and return immediately — dev servers, watchers, installs, soak loops. ' +
    'It keeps running across turns while you work; check on it with bg_logs, stop it with bg_stop. ' +
    'Unlike bash this never blocks on completion — use bash for quick commands, bg_run for anything that must stay alive while you verify other things.',
  risk: 'high',
  params: {
    name: 'string (required) — short handle for later bg_logs / bg_stop calls (e.g. "dev")',
    command: 'string (required) — the shell command to run in the background',
    cwd: 'string — working directory (default: workspace root)',
    wait_ms: 'number — early-crash window in ms (default 2000): if the command dies this fast, its output is returned immediately',
  },
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short handle for later checks' },
      command: { type: 'string', description: 'Shell command to run in the background' },
      cwd: { type: 'string', description: 'Working directory (default: workspace root)' },
      wait_ms: { type: 'number', description: 'Early-crash detection window in ms (default 2000)' },
    },
    required: ['name', 'command'],
  },
  async run(input, ctx) {
    const gate = shellGated(ctx)
    if (gate) return gate
    const name = String(input.name ?? '').trim()
    const command = String(input.command ?? '')
    if (!name) return 'Error: name is required — pick a short handle like "dev" or "watcher".'
    if (!command.trim()) return 'Error: command is required.'
    if (!/^[\w .-]{1,32}$/.test(name)) {
      return 'Error: name must be 1-32 chars of letters/digits/dots/dashes/spaces/underscores.'
    }
    // same name → replace (stop the old one first)
    const old = PROCS.get(key(ctx.sessionId, name))
    if (old) {
      killTree(old)
      await waitDead(old, 3_000)
    }
    const waitMs = Math.min(Math.max(Number(input.wait_ms ?? DEFAULT_WAIT_MS) || 0, 0), MAX_WAIT_MS)

    let st: BgState
    try {
      st = spawnProc(name, command, ctx)
    } catch (e) {
      return `Error: could not spawn the command — ${(e as Error).message}`
    }

    if (waitMs > 0) {
      const t0 = Date.now()
      while (!st.exited && Date.now() - t0 < waitMs) await new Promise((r) => setTimeout(r, 100))
    }

    const head = [
      `name: ${name}`,
      `command: ${command}`,
      statusLine(st),
      st.exited ? '' : '— still running in the background. bg_logs {"name":' + JSON.stringify(name) + '} to check on it, bg_stop to end it.',
    ]
    if (st.exited) {
      head.push('', 'It died immediately — output:', trunc(st.log || '(no output)', 3_000))
    } else if (st.log.trim()) {
      head.push('', 'first output:', trunc(st.log.split('\n').slice(0, 10).join('\n'), 1_500))
    }
    return head.filter((l) => l !== undefined).join('\n')
  },
}

export const bgLogsTool: ToolDefinition = {
  name: 'bg_logs',
  description:
    'Check on background processes. Without a name: lists every process this session started (status + uptime). ' +
    'With a name: full status plus the tail of its output. Poll it after actions that should have produced output — ' +
    'the line count growing between checks means the process is alive and working.',
  risk: 'low',
  params: {
    name: 'string — the handle given to bg_run (omit to list all)',
    lines: 'number — how many output lines to show (default 40)',
  },
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Process handle from bg_run (omit to list all)' },
      lines: { type: 'number', description: 'Tail length in lines (default 40)' },
    },
  },
  async run(input, ctx) {
    const gate = shellGated(ctx)
    if (gate) return gate
    const name = String(input.name ?? '').trim()
    if (!name) {
      const mine = [...PROCS.entries()].filter(([k]) => k.startsWith(`${ctx.sessionId}:`))
      if (mine.length === 0) return 'No background processes in this session. Start one with bg_run.'
      return mine
        .map(([, st]) => `- ${st.name}: ${statusLine(st)} — ${st.command}`)
        .join('\n')
    }
    const st = PROCS.get(key(ctx.sessionId, name))
    if (!st) {
      const alive = [...PROCS.keys()].filter((k) => k.startsWith(`${ctx.sessionId}:`)).map((k) => k.split(':').slice(1).join(':'))
      return `Error: no background process named "${name}".${alive.length ? ` This session has: ${alive.join(', ')}.` : ' This session has none.'}`
    }
    const n = Math.min(Math.max(Number(input.lines ?? 40) || 1, 1), 400)
    const tail = st.log.split('\n').slice(-n).join('\n').trimEnd()
    return [
      `name: ${st.name}`,
      `command: ${st.command}`,
      statusLine(st),
      '',
      tail || '(no output yet)',
    ].join('\n')
  },
}

export const bgStopTool: ToolDefinition = {
  name: 'bg_stop',
  description:
    'Stop a background process started with bg_run (kills the whole process tree). ' +
    'Returns the process status before the stop — check bg_logs first if you need the final output.',
  risk: 'medium',
  params: {
    name: 'string (required) — the handle given to bg_run',
  },
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Process handle from bg_run' } },
    required: ['name'],
  },
  async run(input, ctx) {
    const gate = shellGated(ctx)
    if (gate) return gate
    const name = String(input.name ?? '').trim()
    if (!name) return 'Error: name is required.'
    const k = key(ctx.sessionId, name)
    const st = PROCS.get(k)
    if (!st) return `Error: no background process named "${name}".`
    const was = statusLine(st)
    const finalLog = st.log.split('\n').slice(-20).join('\n').trimEnd()
    killTree(st)
    const dead = await waitDead(st, 5_000)
    PROCS.delete(k)
    return [
      `Stopped "${name}" — it was: ${was}`,
      dead ? '(process tree confirmed dead)' : '(SIGKILL sent — tree may take a moment)',
      finalLog ? `\nlast output:\n${finalLog}` : '',
    ].filter(Boolean).join('\n')
  },
}

/* ------------------------------------------------------------------ */

/** test hook — the internal registry (never used by the agent) */
export const _bgRegistry = PROCS
