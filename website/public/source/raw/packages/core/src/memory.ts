import fs from 'node:fs'
import path from 'node:path'
import type { MemoryFact, ToolDefinition } from '../types'
import { GLOBAL_DIR } from './config'
import { ensureDir, trunc, uid } from './util'

export function globalAgentsPath(): string {
  return path.join(GLOBAL_DIR, 'AGENTS.md')
}

export function workspaceAgentsPath(root: string): string {
  return path.join(root, 'AGENTS.md')
}

export function factsPath(root: string): string {
  return path.join(root, '.tagent', 'memory.json')
}

export function readAgents(root: string): { global: string; workspace: string } {
  let global = ''
  let workspace = ''
  try { global = fs.readFileSync(globalAgentsPath(), 'utf8').trim() } catch { /* empty */ }
  try { workspace = fs.readFileSync(workspaceAgentsPath(root), 'utf8').trim() } catch { /* empty */ }
  return { global, workspace }
}

export function saveAgents(
  root: string,
  which: 'global' | 'workspace',
  content: string,
): void {
  const target = which === 'global' ? globalAgentsPath() : workspaceAgentsPath(root)
  ensureDir(path.dirname(target))
  fs.writeFileSync(target, content, 'utf8')
}

export function listFacts(root: string): MemoryFact[] {
  try {
    const data = JSON.parse(fs.readFileSync(factsPath(root), 'utf8'))
    return Array.isArray(data.facts) ? data.facts : []
  } catch {
    return []
  }
}

export function saveFact(root: string, text: string, tags?: string[]): MemoryFact {
  const facts = listFacts(root)
  const fact: MemoryFact = { id: uid(), text: text.trim(), tags, createdAt: Date.now() }
  facts.push(fact)
  ensureDir(path.dirname(factsPath(root)))
  fs.writeFileSync(factsPath(root), JSON.stringify({ facts }, null, 2))
  return fact
}

export function deleteFact(root: string, id: string): boolean {
  const facts = listFacts(root)
  const next = facts.filter((f) => f.id !== id)
  if (next.length === facts.length) return false
  fs.writeFileSync(factsPath(root), JSON.stringify({ facts: next }, null, 2))
  return true
}

/** Render memory block for the system prompt. */
export function renderMemoryBlock(root: string): string {
  const { global, workspace } = readAgents(root)
  const facts = listFacts(root).slice(-20)
  const parts: string[] = []
  if (global) parts.push(`## Global AGENTS.md\n${trunc(global, 4000)}`)
  if (workspace) parts.push(`## Workspace AGENTS.md\n${trunc(workspace, 4000)}`)
  if (facts.length) {
    parts.push(
      '## Remembered facts\n' + facts.map((f) => `- ${f.text}`).join('\n'),
    )
  }
  return parts.length
    ? parts.join('\n\n')
    : '(no memory yet — use the `memory` tool to save durable notes, and AGENTS.md files for instructions)'
}

/* ---------------------------- memory tool ---------------------------- */

export const memoryTool: ToolDefinition = {
  name: 'memory',
  description:
    'Persistent memory across sessions. `save` a durable fact (preferences, decisions, project conventions), `list` facts, or `delete` by id.',
  risk: 'low',
  params: {
    action: 'string (required) — "save" | "list" | "delete"',
    text: 'string — the fact to save (for save)',
    id: 'string — fact id (for delete)',
    tags: 'string[] — optional tags',
  },
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['save', 'list', 'delete'] },
      text: { type: 'string', description: 'The fact to save (for save)' },
      id: { type: 'string', description: 'Fact id (for delete)' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
    },
    required: ['action'],
  },
  async run(input, ctx) {
    const action = String(input.action ?? 'list')
    if (action === 'save') {
      const text = String(input.text ?? '').trim()
      if (!text) return 'Error: text is required for save'
      const fact = saveFact(ctx.workspaceRoot, text, Array.isArray(input.tags) ? input.tags.map(String) : undefined)
      return `Saved fact ${fact.id}: "${trunc(fact.text, 200)}"`
    }
    if (action === 'delete') {
      const ok = deleteFact(ctx.workspaceRoot, String(input.id ?? ''))
      return ok ? 'Fact deleted.' : 'Fact id not found.'
    }
    const facts = listFacts(ctx.workspaceRoot)
    if (!facts.length) return 'No facts saved yet.'
    return facts.map((f) => `${f.id} — ${f.text}${f.tags?.length ? ` [${f.tags.join(', ')}]` : ''}`).join('\n')
  },
}
