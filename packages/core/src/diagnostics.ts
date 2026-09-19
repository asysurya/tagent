import { spawn } from 'node:child_process'
import type { TagentConfig } from './types'
import { resolveShell } from './tools/bash'

/**
 * Auto-diagnostics — a quality loop around file edits.
 *
 * When `diagnostics.command` is configured (e.g. "tsc --noEmit",
 * "npm run lint"), the agent loop runs it ONCE per turn in which files were
 * edited and feeds the output back to the model, so it self-corrects before
 * declaring the task done — the same feedback loop Claude Code gets from
 * its linter integration.
 */

export const DIAGNOSTICS_DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT = 6_000

export interface DiagnosticsResult {
  ok: boolean
  command: string
  output: string
  ms: number
  timedOut: boolean
}

/** Effective command (trimmed), or undefined when diagnostics are off. */
export function diagnosticsCommand(cfg: TagentConfig): string | undefined {
  const cmd = (cfg.diagnostics?.command ?? '').trim()
  return cmd ? cmd : undefined
}

/** Run the diagnostics command in the workspace. Never throws. */
export function runDiagnostics(root: string, cfg: TagentConfig): Promise<DiagnosticsResult | undefined> {
  const command = diagnosticsCommand(cfg)
  if (!command) return Promise.resolve(undefined)
  const timeoutMs = Math.max(5_000, Math.min(Number(cfg.diagnostics?.timeoutMs) || DIAGNOSTICS_DEFAULT_TIMEOUT_MS, 180_000))
  const started = Date.now()

  return new Promise((resolve) => {
    // bash -lc gives us pipes, &&-chains and env setup just like the bash tool
    const shell = resolveShell()
    const child = spawn(shell, ['-lc', command], {
      cwd: root,
      env: { ...process.env, TAGENT_DIAGNOSTICS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let timedOut = false
    const append = (b: Buffer) => {
      if (out.length < MAX_OUTPUT) out += b.toString('utf8')
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const finish = (code: number | null) => {
      clearTimeout(timer)
      resolve({
        ok: code === 0 && !timedOut,
        command,
        output: out.trim().slice(0, MAX_OUTPUT),
        ms: Date.now() - started,
        timedOut,
      })
    }
    child.on('close', (code) => finish(code))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        command,
        output: `could not run "${command}": ${e.message}`,
        ms: Date.now() - started,
        timedOut: false,
      })
    })
  })
}

/** The block appended to TOOL RESULTS after an edit turn. */
export function renderDiagnosticsBlock(r: DiagnosticsResult): string {
  const head = r.timedOut
    ? `### diagnostics (TIMED OUT after ${(r.ms / 1000).toFixed(1)}s — command: ${r.command})`
    : r.ok
      ? `### diagnostics (pass · ${r.command} · ${(r.ms / 1000).toFixed(1)}s)`
      : `### diagnostics (FAIL — fix these errors before finishing)`
  const body = r.output ? r.output : r.ok ? '(no output)' : '(no output — non-zero exit)'
  const tail = r.timedOut
    ? '\nThe diagnostics command timed out. Continue, but tell the user the check did not complete.'
    : r.ok
      ? ''
      : '\nFix the reported issues now (edit the files), then verify again. Do not declare the task done while diagnostics fail.'
  return `${head}\n${body}${tail}`
}
