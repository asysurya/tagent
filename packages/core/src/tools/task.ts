import type { ToolDefinition } from '../types'
import { trunc, uid } from '../util'

/**
 * Subagents via the `task` tool.
 * The parent loop injects `spawnSubagent` into the tool context (dependency
 * injection keeps tools/loop decoupled). Subagents run with their own budget,
 * isolated context, and a restricted toolset (`explore` = read-only).
 */
export const taskTool: ToolDefinition = {
  name: 'task',
  description:
    'Spawn a subagent for a self-contained subtask and get its report. Great for searching a large codebase, reviewing files, or drafting something in isolation. The subagent CANNOT see your conversation.',
  risk: 'medium',
  params: {
    description: 'string (required) — short label, e.g. "find all API routes"',
    prompt: 'string (required) — complete, self-contained instructions for the subagent',
    agent: 'string — "general" (default) or "explore" (read-only)',
    max_turns: 'number — turn budget (default 10)',
  },
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short label, e.g. "find all API routes"' },
      prompt: { type: 'string', description: 'Complete, self-contained instructions for the subagent' },
      agent: { type: 'string', enum: ['general', 'explore'], description: 'Subagent kind (default general; explore is read-only)' },
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
    const agent = input.agent === 'explore' ? 'explore' : 'general'
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
