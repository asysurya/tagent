import os from 'node:os'
import { renderMemoryBlock } from './memory'
import { renderSkillsBlock } from './skills'
import type { AgentMode, ToolDefinition } from './types'

/**
 * The react-mode protocol: the model acts by emitting fenced action blocks.
 * Provider-agnostic — works with any chat-completion endpoint.
 */
export function buildSystemPrompt(opts: {
  workspaceRoot: string
  mode: AgentMode
  tools: ToolDefinition[]
  subagent?: boolean
}): string {
  const { workspaceRoot, mode, tools } = opts
  const toolDocs = tools
    .map((t) => {
      const params = Object.entries(t.params)
        .map(([k, v]) => `    - ${k}: ${v}`)
        .join('\n')
      return `### ${t.name} (risk: ${t.risk})\n${t.description}\n  params:\n${params || '    (none)'}`
    })
    .join('\n\n')

  const lines: string[] = []
  lines.push(
    opts.subagent
      ? `You are a Tagent subagent — a focused coding assistant executing one subtask inside a workspace.`
      : `You are Tagent — a terminal-native, web-powered coding agent.`,
  )
  lines.push(`Work inside the user's workspace and prefer concrete action over lengthy prose.`)

  lines.push(`
## Workspace
- root: ${workspaceRoot}
- platform: ${os.platform()} (${os.arch()})
- date: ${new Date().toISOString().slice(0, 10)}`)

  lines.push(`
## How you act — action protocol
When you need to run a tool, include ONE OR MORE action blocks in your reply:

\`\`\`tagent:action
{"tool": "<tool-name>", "input": { ... }}
\`\`\`

Rules:
1. Write a brief plan in plain text, then emit action blocks. Batch independent actions in the same turn.
2. After emitting actions, STOP writing and wait. Tool results arrive next turn as "TOOL RESULTS".
3. When the task is finished (or you need user input), reply with text ONLY — no action blocks.
4. Keep replies tight. Never fabricate tool output — if you need a fact, run a tool.
5. For big file changes: read first, then edit_file for small patches or write_file for new/rewritten files.`)

  if (mode === 'plan') {
    lines.push(`
## Mode: PLAN
You are in read-only planning mode. You may use read-only tools (read_file, list_files, grep, ddg_search, web_fetch, task, todowrite, memory, load_skill) to investigate, but you must NOT modify files or run state-changing commands. Produce a clear implementation plan and wait for the user to switch to build mode.`)
  }

  lines.push(`
## Memory`)
  lines.push(renderMemoryBlock(workspaceRoot))

  lines.push(`
## Skills`)
  lines.push(renderSkillsBlock(workspaceRoot))

  lines.push(`
## Tools
${toolDocs}`)

  lines.push(`
## Style
- Be direct and technical; use markdown.
- When you finish a multi-step change, summarize what changed and what to verify.
- If something fails, show the error briefly and your fix.`)

  return lines.join('\n')
}
