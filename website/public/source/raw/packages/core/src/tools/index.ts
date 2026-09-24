import type { TagentConfig, ToolDefinition } from '../types'
import { editFileTool, grepTool, listFilesTool, readFileTool, readFilesTool, writeFileTool } from './fs'
import { bashTool, resolveShell } from './bash'
import { ddgSearchTool, webFetchTool } from './web'
import { todoWriteTool } from './todo'
import { worklogTool } from './worklog'
import { taskTool } from './task'
import { subsTool } from './subs'
import { browserTool } from './browser'
import { visionTool } from './vision'
import { serveTool } from './serve'
import { testReportTool } from './report'
import { askUserTool } from './ask'
import { switchModeTool } from './switch-mode'
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
  subsTool,
  memoryTool,
  loadSkillTool,
  browserTool,
  visionTool,
  serveTool,
  testReportTool,
  askUserTool,
  switchModeTool,
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

/** The QA toolset — test mode's write-free allowlist (loop-level gate).
 *  `task` is in: the QA lead may spawn subagents (they get this same toolset,
 *  minus nesting); `vision` routes screenshots to the media model. */
export const TEST_MODE_TOOLS = new Set([
  'read_file', 'read_files', 'list_files', 'grep', 'web_fetch', 'ddg_search',
  'bash', 'browser', 'vision', 'serve', 'test_report', 'task', 'todowrite', 'memory', 'load_skill',
  'ask_user', 'bg_run', 'bg_logs', 'bg_stop', 'subs', 'switch_mode',
])

/** read/observe set — plan mode & explore subagents */
const RO_NAMES = new Set([
  'read_file', 'read_files', 'list_files', 'grep', 'web_fetch', 'ddg_search',
  'vision', 'todowrite', 'memory', 'load_skill', 'ask_user', 'subs',
])

/**
 * Assemble the toolset for a run.
 * - mode 'plan' / readOnly: investigate & interview (read, search, web, todos,
 *   ask_user); plan mode may also send explore subagents (task)
 * - mode 'test': read/observe + bash + browser + vision + serve + bg +
 *   test_report + task (sub-testers) — no source writes
 * - mode 'build': everything that AFFECTS the project — files, shell, browser,
 *   serve, background processes. The QA deliverable (test_report) is not build's
 *   job; MCP/plugin tools arrive separately as extraTools.
 * - depth > 0 (subagents): no nested `task`, no ask_user (that's the primary's job)
 *   and no switch_mode — a sub's mode is fixed at spawn
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
    // modify source files; the only write is its own report. The QA lead may
    // delegate: `task` spawns sub-testers (nested spawning is depth-gated in
    // the task tool itself); sub-testers never face the human.
    return ALL_TOOLS.filter((t) => {
      if (!TEST_MODE_TOOLS.has(t.name)) return false
      if (isSubagent && (t.name === 'task' || t.name === 'ask_user')) return false
      if (isSubagent && t.name === 'subs') return false // subs track the PARENT's background spawns
      if (isSubagent && t.name === 'switch_mode') return false // a sub's mode is fixed at spawn
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
    if (!isSubagent) allow.add('switch_mode') // the loop's mode escape hatch
    return ALL_TOOLS.filter((t) => allow.has(t.name))
  }

  return ALL_TOOLS.filter((t) => {
    // build mode's job is WORKING CODE — the QA report is test mode's deliverable
    if (t.name === 'test_report') return false
    if (isSubagent && t.name === 'task') return false
    if (isSubagent && t.name === 'subs') return false // subs track the PARENT's background spawns
    // subagents never face the human — asking is the primary agent's job
    if (isSubagent && t.name === 'ask_user') return false
    if (isSubagent && t.name === 'switch_mode') return false // a sub's mode is fixed at spawn
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
