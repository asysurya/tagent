import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '../types'

/** The agent-maintained progress journal lives at the workspace root. */
export function worklogPath(root: string): string {
  return path.join(root, 'WORKLOG.md')
}

function today(): { date: string; time: string } {
  const now = new Date()
  return { date: now.toISOString().slice(0, 10), time: now.toTimeString().slice(0, 5) }
}

/**
 * Append a timestamped entry to WORKLOG.md — the durable progress journal.
 * Entries are grouped under a per-day heading; repeated calls just append.
 * Resuming work later = read WORKLOG.md first, continue where it stopped.
 */
export const worklogTool: ToolDefinition = {
  name: 'worklog',
  description:
    'Append a short timestamped entry to WORKLOG.md — the workspace progress journal. Call it once per completed step (what was done, and why). When resuming older work, read WORKLOG.md first and pick up where it left off.',
  risk: 'low',
  params: {
    entry: 'string (required) — 1-2 lines, past tense, concrete ("fixed null check in parseUser()")',
    title: 'string (optional) — short heading for this entry ("fix auth bug")',
  },
  inputSchema: {
    type: 'object',
    properties: {
      entry: { type: 'string', description: 'The log entry (markdown, 1-2 lines)' },
      title: { type: 'string', description: 'Optional short heading shown next to the time' },
    },
    required: ['entry'],
  },
  async run(input, ctx) {
    const entry = String(input.entry ?? '').trim()
    if (!entry) return 'Error: entry is required'
    const title = String(input.title ?? '').trim().slice(0, 80)
    const file = worklogPath(ctx.workspaceRoot)
    const { date, time } = today()

    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      text = '# Worklog\n' // fresh journal
    }

    const heading = `## ${date}`
    const line = title
      ? `- **${time} — ${title}** ${entry}`
      : `- **${time}** ${entry}`

    if (!text.includes(heading)) {
      // new day — append a fresh date section
      text = `${text.trimEnd()}\n\n${heading}\n\n${line}\n`
    } else {
      text = `${text.trimEnd()}\n${line}\n`
    }

    fs.writeFileSync(file, text)
    ctx.events.onFilesChanged?.(['WORKLOG.md'])
    return `Logged to WORKLOG.md (${date} ${time}): ${entry.slice(0, 120)}`
  },
}
