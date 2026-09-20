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
]

export interface BuildToolsetOptions {
  readOnly?: boolean
  depth?: number
  config?: TagentConfig
  /** 'test' assembles the QA toolset: read + bash + browser + serve + report, no file writes */
  mode?: 'build' | 'plan' | 'test'
}

/** The QA toolset — test mode's write-free allowlist (loop-level gate). */
export const TEST_MODE_TOOLS = new Set([
  'read_file', 'read_files', 'list_files', 'grep', 'web_fetch', 'ddg_search',
  'bash', 'browser', 'serve', 'test_report', 'todowrite', 'memory', 'load_skill',
])

/**
 * Assemble the toolset for a run.
 * - readOnly (plan mode / explore subagents): read/observe tools only
 * - mode 'test': read/observe + bash + browser + serve + test_report (NO write/edit)
 * - depth > 0 (subagents): no nested `task`
 * - disabled tools (bash/browser/serve) are filtered by config flags
 */
export function buildToolset(opts: BuildToolsetOptions = {}): ToolDefinition[] {
  const readOnly = opts.readOnly === true
  const isSubagent = (opts.depth ?? 0) > 0
  const cfg = opts.config
  const test = opts.mode === 'test'

  if (test) {
    // QA toolset — the agent RUNS the project and verifies it, but cannot
    // modify source files; the only write is its own report.
    return ALL_TOOLS.filter((t) => {
      if (!TEST_MODE_TOOLS.has(t.name)) return false
      if (cfg && t.name === 'bash' && !cfg.tools.bash) return false
      if (cfg && t.name === 'browser' && !cfg.tools.browser) return false
      if (cfg && t.name === 'serve' && cfg.tools.serve === false) return false
      return true
    })
  }

  return ALL_TOOLS.filter((t) => {
    if (readOnly) {
      const RO = new Set([
        'read_file', 'read_files', 'list_files', 'grep', 'web_fetch', 'ddg_search',
        'todowrite', 'memory', 'load_skill',
      ])
      return RO.has(t.name)
    }
    if (isSubagent && t.name === 'task') return false
    if (cfg && t.name === 'bash' && !cfg.tools.bash) return false
    if (cfg && t.name === 'browser' && !cfg.tools.browser) return false
    if (cfg && t.name === 'serve' && cfg.tools.serve === false) return false
    return true
  })
}

export { worklogTool, worklogPath } from './worklog'
export { resolveShell }
export { detectDevCommand } from './serve'

export { ALL_TOOLS }
