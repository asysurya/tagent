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
  /** caveman mode: compact tool docs + ultra-terse output style */
  caveman?: boolean
  /** worklog protocol: todos + WORKLOG.md journal */
  worklog?: boolean
}): string {
  const { workspaceRoot, mode, tools } = opts
  const caveman = opts.caveman === true
  // journaling writes a file — never instruct it in read-only plan mode
  const worklog = opts.worklog === true && mode !== 'plan'

  const toolDocs = caveman
    ? tools
        .map((t) => `- ${t.name}(${Object.keys(t.params).join(', ')}): ${firstSentence(t.description)}`)
        .join('\n')
    : tools
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

  lines.push(`
## Economy — turn & token discipline (HARD RULES)
Tokens and turns cost real money and time. Spend them like a miser:
1. KNOWN PATH → read it yourself. NEVER spawn a task subagent just to read/view a file you can name. Subagents are for BROAD searches (target unknown, many files) or isolated drafting — nothing else.
2. 2+ known paths → ONE read_files call. Batching reads into a single turn is the default, not the exception.
3. Re-reading an unchanged file wastes a turn — read_file answers "[cached] UNCHANGED" when the bytes already sit in your context. Trust it and move on; use force only for a real need.
4. Narrow your searches: grep with path + glob beats re-reading files; list_files a subdirectory beats walking the whole tree.
5. Ask for exactly what you need: pass limit to read_file when only part of a file matters.
6. Batch independent actions (reads, greps) in the same reply — never serialize work that can run in parallel.
7. Users may attach files as @path mentions — that content is already in the conversation; do not read those files again.`)

  if (worklog) {
    lines.push(`
## Progress tracking — todos + worklog${caveman ? ' (mandatory)' : ''}
1. Before multi-step work: call todowrite with the full plan as short items. Update statuses as you go.
2. After each completed step: call worklog with a 1-2 line entry (what + why). One call per step — never batch a whole run into one entry.
3. Resuming older work: read WORKLOG.md first, continue where it left off.`)
  } else if (!opts.subagent) {
    lines.push(`
## Progress tracking — todos
Multi-step work should be tracked with todowrite so the user can follow along live.`)
  }

  if (caveman) {
    lines.push(`
## CAVEMAN MODE — token saving is ON
Write the tersest useful output. Hard rules:
- No greetings, no filler, no "I will now…", no restating the task back.
- Lead-ins before action blocks: max 6 words, or none.
- Prose: telegraphic. Facts only. No decoration, no headers unless listing >3 items.
- Final summaries: max 5 bullets, one line each.
- Terse ≠ vague: never drop required tool inputs, real errors, or asked-for detail.`)
  }

  if (mode === 'plan') {
    lines.push(`
## Mode: PLAN
You are in read-only planning mode. You may use read-only tools (read_file, read_files, list_files, grep, ddg_search, web_fetch, task, todowrite, memory, load_skill) to investigate, but you must NOT modify files or run state-changing commands. Produce a clear implementation plan and wait for the user to switch to build mode.`)
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

  if (!caveman) {
    lines.push(`
## Style
- Be direct and technical; use markdown.
- When you finish a multi-step change, summarize what changed and what to verify.
- If something fails, show the error briefly and your fix.`)
  } else {
    lines.push(`
## Style
- Terse. Technical. No ceremony.`)
  }

  return lines.join('\n')
}

/** First sentence of a tool description, capped — used for caveman tool docs. */
function firstSentence(s: string): string {
  const m = s.split(/(?<=[.!?])\s/)[0] ?? s
  return m.length > 90 ? `${m.slice(0, 87)}…` : m
}
