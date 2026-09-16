import { spawn } from 'node:child_process'
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

export const bashTool: ToolDefinition = {
  name: 'bash',
  description:
    'Run a shell command in the workspace root (bash -lc). Use for build, test, git, and inspection tasks. Streams stdout+stderr back.',
  risk: 'high',
  params: {
    command: 'string (required) — the shell command',
    timeout: 'number — ms before the command is killed (default 60000)',
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
    const timeout = Math.min(Number(input.timeout ?? DEFAULT_TIMEOUT), 300_000)
    return await new Promise<string>((resolve) => {
      const child = spawn('bash', ['-lc', command], {
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
        if (!finished) { finished = true; clearTimeout(timer); resolve(`Error: ${err.message}`) }
      })
      ctx.signal?.addEventListener('abort', () => {
        try { child.kill('SIGKILL') } catch { /* noop */ }
      }, { once: true })
    })
  },
}
