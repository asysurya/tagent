import fs from 'node:fs'
import path from 'node:path'
import type { AgentMode } from './types'
import { GLOBAL_DIR } from './config'
import { parseFrontMatter } from './util'

/**
 * Custom subagents — user-defined specialist agents as markdown files.
 *
 *   .tagent/agents/<name>.md   (workspace, wins)
 *   ~/.tagent/agents/<name>.md (global, shared across projects)
 *
 * Front-matter fields:
 *   name:        display + spawn name (defaults to the file stem)
 *   description: when the primary agent should delegate to it
 *   model:       model override — "provider/model" or a bare model id
 *   tools:       comma-separated tool whitelist (omit = inherit all)
 *   mode:        build (default) | plan (read-only) | test (QA toolset)
 *   maxTurns:    turn budget for one spawn (default 10)
 *
 * The file body is the subagent's system prompt (persona + instructions).
 */

export interface SubagentDef {
  name: string
  description: string
  /** "provider/model" (cross-provider) or bare model id (same provider) */
  model?: string
  /** tool-name whitelist — undefined inherits the full toolset */
  tools?: string[]
  mode: AgentMode
  maxTurns: number
  systemPrompt: string
  source: 'workspace' | 'global'
  path: string
}

export function subagentDirs(root: string): { workspace: string; global: string } {
  return {
    workspace: path.join(root, '.tagent', 'agents'),
    global: path.join(GLOBAL_DIR, 'agents'),
  }
}

function scanDir(dir: string, source: 'workspace' | 'global', out: Map<string, SubagentDef>): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const file = path.join(dir, e.name)
    try {
      const raw = fs.readFileSync(file, 'utf8')
      const { data, body } = parseFrontMatter(raw)
      const name = (data.name || e.name.replace(/\.md$/, '')).toLowerCase().replace(/\s+/g, '-')
      if (!name || name === 'general' || name === 'explore' || name === 'test') continue // reserved (built-in kinds)
      const tools = data.tools
        ? data.tools.split(',').map((t) => t.trim()).filter(Boolean)
        : undefined
      out.set(name, {
        name,
        description: data.description || '(no description)',
        ...(data.model ? { model: data.model } : {}),
        ...(tools && tools.length ? { tools } : {}),
        mode: data.mode === 'plan' ? 'plan' : data.mode === 'test' ? 'test' : 'build',
        maxTurns: Math.max(1, Math.min(Number(data.maxTurns) || 10, 40)),
        systemPrompt: body.trim() || 'You are a focused Tagent subagent.',
        source,
        path: file,
      })
    } catch { /* unreadable — skip */ }
  }
}

/** All custom subagents (global ← workspace overrides by name), sorted by name. */
export function listSubagents(root: string): SubagentDef[] {
  const out = new Map<string, SubagentDef>()
  const dirs = subagentDirs(root)
  scanDir(dirs.global, 'global', out)
  scanDir(dirs.workspace, 'workspace', out)
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function findSubagent(root: string, name: string): SubagentDef | undefined {
  const n = name.toLowerCase()
  return listSubagents(root).find((a) => a.name === n)
}

/** System-prompt block: teaches the primary agent which specialists exist. */
export function renderSubagentsBlock(root: string): string {
  const subs = listSubagents(root)
  const builtins =
    '- general [built-in]: full toolset like yours (minus task/ask_user) — broad searches, isolated drafting, parallel work\n' +
    '- explore [built-in, read-only]: safe reconnaissance — map an unknown codebase, find where things live\n' +
    '- test [built-in, QA]: serve + browser + vision testing of the current project — read-only, ends with findings'
  if (!subs.length) return `${builtins}\nSpawn with the task tool: {"agent": "<name>"}.`
  return (
    builtins +
    '\n' +
    subs.map((a) => `- ${a.name}${a.model ? ` [model: ${a.model}]` : ''}${a.mode !== 'build' ? ` [mode: ${a.mode}]` : ''}: ${a.description}`).join('\n') +
    '\nSpawn with the task tool: {"agent": "<name>"}. The subagent cannot see your conversation and runs in this same workspace — pass instructions + paths, not file contents.'
  )
}

/** A ready-to-edit starter file for `tagent agents new` / the /agents TUI view. */
export const SUBAGENT_TEMPLATE = `---
name: my-specialist
description: One line — when should the primary agent delegate to this specialist?
model: provider/model-id   # optional, e.g. zai/glm-4.7
tools: read_file, grep, list_files   # optional whitelist; omit to inherit all
mode: build                # build | plan (read-only) | test (QA)
maxTurns: 10               # turn budget per spawn
---

You are my-specialist.

Write the persona and working rules for this subagent here.
- What it should always do first
- What it must never do
- How to format its final report (the only thing the caller sees)
`
