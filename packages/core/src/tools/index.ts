import type { TagentConfig, ToolDefinition } from '../types'
import { editFileTool, grepTool, listFilesTool, readFileTool, readFilesTool, writeFileTool } from './fs'
import { bashTool, resolveShell } from './bash'
import { ddgSearchTool, webFetchTool } from './web'
import { todoWriteTool } from './todo'
import { worklogTool } from './worklog'
import { taskTool } from './task'
import { browserTool } from './browser'
import { serveTool } from './serve'
import { testReportTool } from './report'
import { askUserTool } from './ask'
import { bgLogsTool, bgRunTool, bgStopTool } from './bg'
import { memoryTool } from '../memory'
import { loadSkillTool } from '../skills'

const ALL_TOOLS: ToolDefinition[] = [
  readFileTool,
  readFilesTool,
  listFilesTool,
  grepTool,
  writeFileTool,
  editFileTool,
  bashTool,
  webFetchTool,
  ddgSearchTool,
  todoWriteTool,
  worklogTool,
  taskTool,
  memoryTool,
  loadSkillTool,
  browserTool,
  serveTool,
  testReportTool,
  askUserTool,
  bgRunTool,
  bgLogsTool,
  bgStopTool,
]

export interface BuildToolsetOptions {
  readOnly?: boolean
  depth?: number
  config?: TagentConfig
  /** 'plan': investigate/interview only (read + search + subagents + ask).
   *  'test' assembles the QA toolset: run + verify + report, no source writes. */
  mode?: 'build' | 'plan' | 'test'
}

/** The QA toolset — test mode's write-free allowlist (loop-level gate). */
export const TEST_MODE_TOOLS = new Set([
  'read_file', 'read_files', 'list_files', 'grep', 'web_fetch', 'ddg_search',
  'bash', 'browser', 'serve', 'test_report', 'todowrite', 'memory', 'load_skill',
  'ask_user', 'bg_run', 'bg_logs', 'bg_stop',
])

/** read/observe set — plan mode & explore subagents */
const RO_NAMES = new Set([
  'read_file', 'read_files', 'list_files', 'grep', 'web_fetch', 'ddg_search',
  'todowrite', 'memory', 'load_skill', 'ask_user',
])

/**
 * Assemble the toolset for a run.
 * - mode 'plan' / readOnly: investigate & interview (read, search, web, todos,
 *   ask_user); plan mode may also send explore subagents (task)
 * - mode 'test': read/observe + bash + browser + serve + bg + test_report (no writes)
 * - mode 'build': everything that AFFECTS the project — files, shell, browser,
 *   serve, background processes. The QA deliverable (test_report) is not build's
 *   job; MCP/plugin tools arrive separately as extraTools.
 * - depth > 0 (subagents): no nested `task`, no ask_user (that's the primary's job)
 * - disabled tools (bash/browser/serve) are filtered by config flags
 */
export function buildToolset(opts: BuildToolsetOptions = {}): ToolDefinition[] {
  const readOnly = opts.readOnly === true
  const isSubagent = (opts.depth ?? 0) > 0
  const cfg = opts.config
  const test = opts.mode === 'test'
  const plan = opts.mode === 'plan'

  if (test) {
    // QA toolset — the agent RUNS the project and verifies it, but cannot
    // modify source files; the only write is its own report.
    return ALL_TOOLS.filter((t) => {
      if (!TEST_MODE_TOOLS.has(t.name)) return false
      if (cfg && t.name === 'bash' && !cfg.tools.bash) return false
      if (cfg && t.name === 'browser' && !cfg.tools.browser) return false
      if (cfg && t.name === 'serve' && cfg.tools.serve === false) return false
      if (cfg && t.name.startsWith('bg_') && !cfg.tools.bash) return false
      return true
    })
  }

  if (plan || readOnly) {
    // plan mode: investigation & interviewing — plus explore subagents.
    // (generic readOnly — explore subagents — keeps task excluded.)
    const allow = new Set(RO_NAMES)
    if (plan && !isSubagent) allow.add('task')
    return ALL_TOOLS.filter((t) => allow.has(t.name))
  }

  return ALL_TOOLS.filter((t) => {
    // build mode's job is WORKING CODE — the QA report is test mode's deliverable
    if (t.name === 'test_report') return false
    if (isSubagent && t.name === 'task') return false
    // subagents never face the human — asking is the primary agent's job
    if (isSubagent && t.name === 'ask_user') return false
    if (cfg && t.name === 'bash' && !cfg.tools.bash) return false
    if (cfg && t.name === 'browser' && !cfg.tools.browser) return false
    if (cfg && t.name === 'serve' && cfg.tools.serve === false) return false
    if (cfg && t.name.startsWith('bg_') && !cfg.tools.bash) return false
    return true
  })
}

export { worklogTool, worklogPath } from './worklog'
export { resolveShell }
export { detectDevCommand } from './serve'

export { ALL_TOOLS }
