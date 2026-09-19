import fs from 'node:fs'
import path from 'node:path'
import type { ToolContext, ToolDefinition } from '../types'
import { jailPath, relPath, trunc, uid } from '../util'
import { bumpStat } from '../cache'

/**
 * Subagents via the `task` tool.
 * The parent loop injects `spawnSubagent` into the tool context (dependency
 * injection keeps tools/loop decoupled). Subagents run with their own budget,
 * isolated context, and a restricted toolset (`explore` = read-only).
 *
 * FAST PATH — "otak hemat": a subagent whose whole job is reading 1-4 known
 * files is pure waste (spawn a loop, re-read, summarize back). We detect
 * trivial read prompts and serve the files directly, saving the entire
 * subagent turn budget.
 */

/** prompt shapes that are pure direct reads: "read src/a.ts", "show package.json and tsconfig.json" */
const FAST_READ_RE = /^(?:please\s+|bisakah\s+|bisa\s+)?(?:baca(?:kan|lah)?|tampilkan|read|show|open|cat|view)\s+(?:the\s+|file\s+|files\s+|berkas\s+)?(.+?)\s*[.?!]?$/i

/** tokens allowed in the "what to read" part — paths only, no prose verbs */
function extractReadTargets(rest: string): string[] | null {
  const toks = rest
    .split(/\s*(?:,|\band\b|\bdan\b)\s*|\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter(Boolean)
  if (toks.length < 1 || toks.length > 4) return null
  const targets: string[] = []
  for (const t of toks) {
    // must look like a path (dot or slash) and contain no prose characters
    if (!/^[~./@\\\w][\w./@\\-]*$/.test(t)) return null
    if (!/[./]/.test(t)) return null
    targets.push(t)
  }
  return targets
}

/** Satisfy a trivial read prompt directly. Returns null when it's not trivial. */
function tryFastRead(prompt: string, ctx: ToolContext): string | null {
  const p = prompt.trim()
  if (p.length > 200) return null
  const m = p.match(FAST_READ_RE)
  if (!m) return null
  const targets = extractReadTargets(m[1])
  if (!targets) return null

  const sections: string[] = []
  let served = 0
  for (const t of targets) {
    let abs: string
    try {
      abs = jailPath(ctx.workspaceRoot, t)
    } catch {
      return null // outside workspace — let the subagent handle it
    }
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
      if (!st.isFile()) return null
      if (st.size > 120_000) return null // big file → a summary from a subagent is actually useful
    } catch {
      return null // not found — normal subagent flow reports it better
    }
    const raw = fs.readFileSync(abs, 'utf8')
    sections.push(`===== ${relPath(ctx.workspaceRoot, abs)} (${st.size} bytes) =====\n${trunc(raw, 120_000)}`)
    served++
  }
  if (!served) return null
  bumpStat('fastPathReads', served)
  return (
    `[fast-path] The prompt was a direct read of known file(s) — served WITHOUT spawning a subagent ` +
    `(saved ~${served + 1} subagent turns). Next time read known files yourself with read_file / read_files.\n\n` +
    sections.join('\n\n')
  )
}

export const taskTool: ToolDefinition = {
  name: 'task',
  description:
    'Spawn a subagent for a self-contained subtask and get its report. ONLY for broad searches (unknown location, many files) or isolated drafting/review work. NEVER for reading files whose paths you already know — use read_file / read_files directly (a full subagent for one read wastes tokens and turns). The subagent CANNOT see your conversation. agent: "general" (default), "explore" (read-only), or a custom specialist name from the "Custom subagents" list in your system prompt (persona/tool whitelist/model come from its definition).',
  risk: 'medium',
  params: {
    description: 'string (required) — short label, e.g. "find all API routes"',
    prompt: 'string (required) — complete, self-contained instructions for the subagent',
    agent: 'string — "general" (default), "explore" (read-only), or a custom subagent name',
    max_turns: 'number — turn budget (default 10)',
  },
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short label, e.g. "find all API routes"' },
      prompt: { type: 'string', description: 'Complete, self-contained instructions for the subagent' },
      agent: { type: 'string', description: 'general | explore | custom subagent name from the system prompt' },
      max_turns: { type: 'number', description: 'Turn budget (default 10)' },
    },
    required: ['description', 'prompt'],
  },
  async run(input, ctx) {
    if (!ctx.spawnSubagent) return 'Error: subagents unavailable in this context.'
    if (ctx.depth >= 1) {
      return 'Error: nested subagents are not allowed (depth limit 1). Do the work yourself instead.'
    }
    const description = String(input.description ?? 'subtask').slice(0, 120)
    const prompt = String(input.prompt ?? '').slice(0, 16_000)
    if (!prompt) return 'Error: prompt is required'

    // economy fast-path: plain "read X" prompts never need a subagent
    const fast = tryFastRead(prompt, ctx)
    if (fast) return fast

    const agent = String(input.agent ?? 'general') || 'general'
    const maxTurns = Math.min(Number(input.max_turns ?? 10), 25)
    ctx.events.onSubagent?.({
      id: uid(),
      parentId: ctx.sessionId,
      description,
      status: 'running',
      turns: 0,
    })
    try {
      const report = await ctx.spawnSubagent(description, prompt, agent, maxTurns)
      ctx.events.onSubagent?.({
        id: uid(),
        parentId: ctx.sessionId,
        description,
        status: 'done',
        turns: maxTurns,
        report: trunc(report, 500),
      })
      return `SUBAGENT REPORT — ${description}\n\n${trunc(report, 12_000)}`
    } catch (e) {
      ctx.events.onSubagent?.({
        id: uid(),
        parentId: ctx.sessionId,
        description,
        status: 'error',
        turns: 0,
        report: (e as Error).message,
      })
      return `Subagent error: ${(e as Error).message}`
    }
  },
}
