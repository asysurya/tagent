import type { ToolDefinition } from '../types'

/**
 * The `subs` tool — live view of BACKGROUND subagents (task background:true).
 * The host owns the registry (it outlives runs), so this works mid-run AND
 * between runs: the agent can check what is still running, what finished
 * while it worked, and re-read any finished report by id.
 */
export const subsTool: ToolDefinition = {
  name: 'subs',
  description:
    'Live status of background subagents (spawned with task background:true). ' +
    'Lists id (a1, a2…), description, kind, status, elapsed; a finished entry shows its report tail. ' +
    'Pass id to re-read one full report. Reports are ALSO delivered automatically as [SUBAGENT REPORT] messages — this tool is for checking progress on demand.',
  risk: 'low',
  params: {
    id: 'string — one subagent id (a1) to show its full report; omit to list all',
  },
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Subagent id (e.g. a1) — show its full report' },
    },
  },
  async run(input, ctx) {
    const reg = ctx.backgroundSubs
    if (!reg) return 'No background subagents in this context (foreground task tool only).'
    const list = reg.list()

    const id = String(input.id ?? '').trim()
    if (id) {
      const one = list.find((s) => s.id === id)
      if (!one) {
        const known = list.map((s) => s.id).join(', ') || 'none yet'
        return `No background subagent "${id}" — known: ${known}`
      }
      if (one.status === 'running') {
        const secs = Math.round((Date.now() - one.startedAt) / 1000)
        return `BACKGROUND SUBAGENT ${one.id} — "${one.description}" (kind: ${one.kind})\nstatus: running · ${secs}s elapsed — the report arrives as a [SUBAGENT REPORT ${one.id}] message when it finishes.`
      }
      return (
        `BACKGROUND SUBAGENT ${one.id} — "${one.description}" (kind: ${one.kind})\n` +
        `status: ${one.status}${one.finishedAt ? ` · finished ${Math.round((Date.now() - one.finishedAt) / 1000)}s ago` : ''}\n\n` +
        `${one.report ?? '(no report stored)'}`
      )
    }

    if (!list.length) {
      return (
        'No background subagents yet — spawn one with task {"background": true, "description": "...", "prompt": "..."}. ' +
        'It runs while you keep working and its report arrives automatically.'
      )
    }
    const running = list.filter((s) => s.status === 'running').length
    const lines = list
      .slice()
      .reverse() // newest first
      .map((s) => {
        const t =
          s.status === 'running'
            ? `${Math.round((Date.now() - s.startedAt) / 1000)}s, running`
            : `${Math.round(((s.finishedAt ?? s.startedAt) - s.startedAt) / 1000)}s, ${s.status}`
        const tail =
          s.status === 'running' ? '' : ` — ${(s.report ?? '').split('\n')[0].slice(0, 120)}`
        return `${s.id} [${s.status}] "${s.description}" (${s.kind}, ${t})${tail}`
      })
    return (
      `BACKGROUND SUBAGENTS — ${running} running / ${list.length} total\n` +
      lines.join('\n') +
      `\nFull report of one: subs {"id": "a1"}`
    )
  },
}

/** helper for hosts rendering /subs — one line per sub */
export function renderSubsTable(subs: { id: string; description: string; kind: string; status: string; startedAt: number; finishedAt?: number; report?: string }[]): string[] {
  if (!subs.length) return ['no background subagents — spawn with task background:true']
  const out: string[] = []
  for (const s of subs.slice().reverse()) {
    const dur =
      s.status === 'running'
        ? `${Math.round((Date.now() - s.startedAt) / 1000)}s…`
        : `${Math.round(((s.finishedAt ?? s.startedAt) - s.startedAt) / 1000)}s`
    out.push(`${s.id} · ${s.status.padEnd(7)} · ${dur.padStart(6)} · ${s.description} [${s.kind}]`)
  }
  return out
}
