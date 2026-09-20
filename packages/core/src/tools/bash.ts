import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '../types'
import { trunc } from '../util'

const BLOCKLIST: { re: RegExp; why: string }[] = [
  { re: /\bsudo\b/, why: 'sudo is not allowed' },
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-(\w*)?r(\w*)?f/, why: 'recursive force delete is blocked' },
  { re: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f/, why: 'recursive force delete is blocked' },
  { re: /:\(\)\s*\{.*\}\s*;/, why: 'fork bomb is blocked' },
  { re: /\b(shutdown|reboot|halt|mkfs|fdisk)\b/, why: 'system commands are blocked' },
  { re: /(curl|wget)[^|;]*\|\s*(ba)?sh/, why: 'piping downloads to a shell is blocked' },
  { re: /dd\s+if=/, why: 'dd is blocked' },
  { re: /\/dev\/sd[a-z]/, why: 'raw disk access is blocked' },
]

const MAX_OUTPUT = 32_000
const DEFAULT_TIMEOUT = 60_000
/** ceiling, not a target — the agent decides how long a command may run */
const MAX_TIMEOUT = 3_600_000

/**
 * Resolve the shell to run commands with. On Linux/macOS this is plain
 * `bash`. On Windows we prefer Git for Windows' bash.exe (its `cmd` dir
 * is on PATH but `bin` often is not), so probe the usual install spots.
 */
export function resolveShell(): string {
  if (process.platform !== 'win32') return 'bash'
  const candidates = [
    process.env.TAGENT_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs\\Git\\bin\\bash.exe')
      : undefined,
  ].filter((c): c is string => !!c)
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* ignore */ }
  }
  return 'bash' // last resort: hope something named bash is on PATH
}

const WINDOWS_BASH_HINT =
  'bash was not found. On Windows install Git for Windows (https://git-scm.com/download/win) ' +
  'and restart the terminal, or set TAGENT_BASH to the full path of bash.exe.'

export const bashTool: ToolDefinition = {
  name: 'bash',
  description:
    'Run a shell command in the workspace root (bash -lc). Use for build, test, git, and inspection tasks. Streams stdout+stderr back.',
  risk: 'high',
  params: {
    command: 'string (required) — the shell command',
    timeout: 'number — ms before the command is killed. You control it: default 60000, raise it freely for long builds/tests/installs (up to 3600000)',
  },
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run' },
      timeout: { type: 'number', description: 'ms before the command is killed (default 60000, up to 3600000 for long tasks)' },
    },
    required: ['command'],
  },
  async run(input, ctx) {
    if (!ctx.config.tools.bash) {
      return 'Error: the bash tool is disabled in this environment (enable it in Settings → Tools).'
    }
    const command = String(input.command ?? '')
    if (!command.trim()) return 'Error: command is required'
    for (const b of BLOCKLIST) {
      if (b.re.test(command)) return `Error: command rejected — ${b.why}.`
    }
    // agent-settable — the ceiling only exists so a typo can't hang a run forever
    const timeout = Math.min(Math.max(Number(input.timeout ?? DEFAULT_TIMEOUT) || DEFAULT_TIMEOUT, 1_000), MAX_TIMEOUT)
    return await new Promise<string>((resolve) => {
      const child = spawn(resolveShell(), ['-lc', command], {
        cwd: ctx.workspaceRoot,
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', CI: '1' },
      })
      let out = ''
      let finished = false
      const done = (code: number, signal: string) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        const label = signal ? `killed (${signal})` : `exit ${code}`
        const prefix = out ? '' : '(no output)\n'
        resolve(trunc(`${prefix}${out}\n\n[${label}]`, MAX_OUTPUT))
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* noop */ }
        out += `\n…[timeout after ${timeout}ms — process killed]`
        done(124, 'timeout')
      }, timeout)
      child.stdout.on('data', (d) => {
        if (out.length < MAX_OUTPUT) out += d.toString()
      })
      child.stderr.on('data', (d) => {
        if (out.length < MAX_OUTPUT) out += d.toString()
      })
      child.on('close', (code, signal) => done(code ?? 0, signal ?? ''))
      child.on('error', (err) => {
        if (!finished) {
          finished = true
          clearTimeout(timer)
          const enoent = (err as NodeJS.ErrnoException).code === 'ENOENT'
          resolve(
            enoent && process.platform === 'win32'
              ? `Error: ${WINDOWS_BASH_HINT}`
              : `Error: ${err.message}`,
          )
        }
      })
      ctx.signal?.addEventListener('abort', () => {
        try { child.kill('SIGKILL') } catch { /* noop */ }
      }, { once: true })
    })
  },
}
