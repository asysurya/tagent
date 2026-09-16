import fs from 'node:fs'
import path from 'node:path'
import type { SkillMeta, ToolDefinition } from '../types'
import { GLOBAL_DIR } from './config'
import { parseFrontMatter, trunc } from './util'

/**
 * Skills = folders containing SKILL.md (front-matter: name, description) plus
 * optional resources. Progressive disclosure: only name+description go into the
 * system prompt; the agent loads the full body via load_skill when needed.
 *
 * Sources (later wins): builtin → global (~/.tagent/skills) → workspace (.tagent/skills)
 */

export interface SkillDirs {
  builtin: string
  root: string
}

export function skillDirs(root: string): SkillDirs {
  return {
    builtin: process.env.TAGENT_SKILLS_DIR || path.join(GLOBAL_DIR, 'builtin-skills'),
    root,
  }
}

function scanDir(dir: string, source: SkillMeta['source'], out: Map<string, SkillMeta>): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const md = path.join(dir, e.name, 'SKILL.md')
    try {
      const raw = fs.readFileSync(md, 'utf8')
      const { data } = parseFrontMatter(raw)
      out.set(data.name || e.name, {
        name: data.name || e.name,
        description: data.description || '(no description)',
        source,
        path: md,
      })
    } catch { /* not a skill */ }
  }
}

export function listSkills(root: string): SkillMeta[] {
  const out = new Map<string, SkillMeta>()
  const dirs = skillDirs(root)
  scanDir(dirs.builtin, 'builtin', out)
  scanDir(path.join(GLOBAL_DIR, 'skills'), 'global', out)
  scanDir(path.join(root, '.tagent', 'skills'), 'workspace', out)
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function loadSkill(root: string, name: string): string {
  const skills = listSkills(root)
  const skill = skills.find((s) => s.name === name || s.name.toLowerCase() === name.toLowerCase())
  if (!skill) {
    return `Error: skill "${name}" not found. Available: ${skills.map((s) => s.name).join(', ') || '(none)'}`
  }
  const raw = fs.readFileSync(skill.path, 'utf8')
  const { body } = parseFrontMatter(raw)
  return trunc(body, 24_000)
}

export function renderSkillsBlock(root: string): string {
  const skills = listSkills(root)
  if (!skills.length) return '(no skills installed)'
  return skills
    .map((s) => `- ${s.name} [${s.source}]: ${s.description}`)
    .join('\n') + '\nUse load_skill with the skill name to get full instructions.'
}

/* --------------------------- load_skill tool --------------------------- */

export const loadSkillTool: ToolDefinition = {
  name: 'load_skill',
  description:
    'Load a skill\'s full instructions. Skills are reusable playbooks (guides, templates, workflows). Load one right before using it.',
  risk: 'low',
  params: { name: 'string (required) — skill name from the list in the system prompt' },
  async run(input, ctx) {
    const name = String(input.name ?? '')
    if (!name) return 'Error: name is required'
    return loadSkill(ctx.workspaceRoot, name)
  },
}
