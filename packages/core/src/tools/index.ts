import type { TagentConfig, ToolDefinition } from '../types'
import { editFileTool, grepTool, listFilesTool, readFileTool, writeFileTool } from './fs'
import { bashTool, resolveShell } from './bash'
import { ddgSearchTool, webFetchTool } from './web'
import { todoWriteTool } from './todo'
import { worklogTool } from './worklog'
import { taskTool } from './task'
import { browserTool } from './browser'
import { memoryTool } from '../memory'
import { loadSkillTool } from '../skills'

const ALL_TOOLS: ToolDefinition[] = [
  readFileTool,
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
]

export interface BuildToolsetOptions {
  readOnly?: boolean
  depth?: number
  config?: TagentConfig
}

/**
 * Assemble the toolset for a run.
 * - readOnly (plan mode / explore subagents): read/observe tools only
 * - depth > 0 (subagents): no nested `task`
 * - disabled tools (bash/browser) are filtered by config flags
 */
export function buildToolset(opts: BuildToolsetOptions = {}): ToolDefinition[] {
  const readOnly = opts.readOnly === true
  const isSubagent = (opts.depth ?? 0) > 0
  const cfg = opts.config

  return ALL_TOOLS.filter((t) => {
    if (readOnly) {
      const RO = new Set([
        'read_file', 'list_files', 'grep', 'web_fetch', 'ddg_search',
        'todowrite', 'memory', 'load_skill',
      ])
      return RO.has(t.name)
    }
    if (isSubagent && t.name === 'task') return false
    if (cfg && t.name === 'bash' && !cfg.tools.bash) return false
    if (cfg && t.name === 'browser' && !cfg.tools.browser) return false
    if (cfg && t.name === 'worklog' && cfg.worklog?.enabled === false) return false
    return true
  })
}

export { worklogTool, worklogPath } from './worklog'
export { resolveShell }

export { ALL_TOOLS }
