import fs from 'node:fs'
import path from 'node:path'
import type { SkillMeta, ToolDefinition } from './types'
import { GLOBAL_DIR } from './config'
import { parseFrontMatter, trunc } from './util'

/**
 * Skills = folders containing SKILL.md (front-matter: name, description,
 * usage, tags) plus optional resources. Progressive disclosure, two stages:
 * metadata (name + description + usage + tags) is browsable via search_skills
 * and rendered in the system prompt; the agent loads the full body via
 * load_skill only when it picks one.
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

/** Front-matter tags: "web, cli" or an array → lowercase, trimmed, no empties. */
function normalizeTags(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  return arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
}

/** Usage fallback: the body's first paragraph (leading # headings skipped), ≤200 chars. */
function firstParagraph(body: string): string {
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('#'))) i++
  const para: string[] = []
  while (i < lines.length && lines[i].trim() !== '') {
    para.push(lines[i].trim())
    i++
  }
  return para.join(' ').slice(0, 200).trim()
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
      const { data, body } = parseFrontMatter(raw)
      const usage = String(data.usage ?? '').trim() || firstParagraph(body)
      out.set(data.name || e.name, {
        name: data.name || e.name,
        description: data.description || '(no description)',
        ...(usage ? { usage } : {}),
        tags: normalizeTags(data.tags),
        source,
        path: md,
      })
    } catch { /* not a skill */ }
  }
}

/* --------------------------- mtime cache ------------------------------ */

interface SkillCache {
  key: string // `${root}::${builtinDir}`
  mtimeMs: { builtin: number; global: number; workspace: number }
  skills: SkillMeta[]
}
let _cache: SkillCache | null = null

/**
 * Max mtime of the dir itself and every SKILL.md inside its immediate
 * children — bump any of those and the cache re-scans. Missing dir → -1.
 */
function dirMtime(dir: string): number {
  try {
    let m = fs.statSync(dir).mtimeMs
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      try {
        m = Math.max(m, fs.statSync(path.join(dir, e.name, 'SKILL.md')).mtimeMs)
      } catch { /* child without SKILL.md */ }
    }
    return m
  } catch {
    return -1
  }
}

function sameMtime(a: number, b: number): boolean {
  return a === b
}

/**
 * All installed skills (builtin → global → workspace, later wins), sorted by
 * name. Cached on dir mtimes — a second call is a pure memory read, which is
 * what keeps both search_skills and the auto-router cheap.
 */
export function listSkills(root: string): SkillMeta[] {
  const dirs = skillDirs(root)
  const key = `${root}::${dirs.builtin}`
  const mtimes = {
    builtin: dirMtime(dirs.builtin),
    global: dirMtime(path.join(GLOBAL_DIR, 'skills')),
    workspace: dirMtime(path.join(root, '.tagent', 'skills')),
  }
  if (
    _cache &&
    _cache.key === key &&
    sameMtime(_cache.mtimeMs.builtin, mtimes.builtin) &&
    sameMtime(_cache.mtimeMs.global, mtimes.global) &&
    sameMtime(_cache.mtimeMs.workspace, mtimes.workspace)
  ) {
    return _cache.skills
  }
  const out = new Map<string, SkillMeta>()
  scanDir(dirs.builtin, 'builtin', out)
  scanDir(path.join(GLOBAL_DIR, 'skills'), 'global', out)
  scanDir(path.join(root, '.tagent', 'skills'), 'workspace', out)
  const skills = [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
  _cache = { key, mtimeMs: mtimes, skills }
  return skills
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
    .join('\n') + '\nUse search_skills to browse by keyword/tags, then load_skill with the name to get full instructions.'
}

/* ----------------------- session skill state -------------------------- */

/** A skill whose body is in the agent's context. */
export interface LoadedSkill extends SkillMeta {
  /** the (possibly excerpted) body that was injected into context */
  body: string
}

/** Per-session registry of loaded skills + auto-router flags. */
export interface SessionSkillState {
  /** auto-loaded by the router — score/reason retained for transparency */
  auto: LoadedSkill[]
  /** names the agent loaded itself via load_skill this session */
  manual: string[]
  /** /no-auto-skill — stop auto-loading for the rest of the session */
  routingDisabled: boolean
  /** the initial route happened (first user message) */
  routed: boolean
  /** topic-shift re-routes used (budget: 1) */
  reroutes: number
  /** last user text the router saw (for /reload-skills) */
  lastText: string
}

const _sessionStates = new Map<string, SessionSkillState>()

export function skillState(sessionId: string): SessionSkillState {
  let st = _sessionStates.get(sessionId)
  if (!st) {
    st = { auto: [], manual: [], routingDisabled: false, routed: false, reroutes: 0, lastText: '' }
    _sessionStates.set(sessionId, st)
  }
  return st
}

/** Drop a session's skill state (host cleanup). */
export function clearSkillState(sessionId: string): void {
  _sessionStates.delete(sessionId)
}

/** load_skill succeeded → remember it as a manual load (for /skills). */
export function recordManualSkillLoad(sessionId: string, name: string): void {
  const st = skillState(sessionId)
  if (!st.manual.includes(name)) st.manual.push(name)
}

/** Router picked skills → they become the session's auto-loaded context. */
export function recordAutoSkills(sessionId: string, skills: LoadedSkill[]): void {
  const st = skillState(sessionId)
  for (const s of skills) {
    if (!st.auto.some((x) => x.name === s.name)) st.auto.push(s)
  }
}

/** /unload-skill — remove one skill from the session context (auto or manual). */
export function unloadSessionSkill(sessionId: string, name: string): boolean {
  const st = skillState(sessionId)
  const autoIdx = st.auto.findIndex((s) => s.name.toLowerCase() === name.toLowerCase())
  const manualIdx = st.manual.findIndex((n) => n.toLowerCase() === name.toLowerCase())
  if (autoIdx < 0 && manualIdx < 0) return false
  if (autoIdx >= 0) st.auto.splice(autoIdx, 1)
  if (manualIdx >= 0) st.manual.splice(manualIdx, 1)
  return true
}

/** /no-auto-skill — disable auto-loading for the rest of the session. */
export function disableSessionSkillRouting(sessionId: string): void {
  skillState(sessionId).routingDisabled = true
}

/** The auto-loaded skills for a session (what the system prompt renders). */
export function sessionAutoSkills(sessionId: string): LoadedSkill[] {
  return skillState(sessionId).auto
}

/* --------------------------- tools ------------------------------ */

export const searchSkillsTool: ToolDefinition = {
  name: 'search_skills',
  description:
    'Browse available skills. Returns metadata (name, description, usage, tags, path) only — ' +
    'use this BEFORE load_skill to find the right skill. Cheap & read-only. ' +
    'Pass query to filter by keyword, or omit to list all.',
  risk: 'low',
  params: {
    query: 'string (optional) — keyword filter, case-insensitive, matches name + description + usage',
    tags: 'string[] (optional) — only skills that have ALL these tags',
    limit: 'number (optional, default 20) — max results',
  },
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword filter (case-insensitive, matches name/description/usage)' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (AND — skill must have ALL)' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: [],
  },
  async run(input, ctx) {
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
    const tags = Array.isArray(input.tags)
      ? input.tags.map(String).map((t) => t.toLowerCase().trim()).filter(Boolean)
      : []
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.min(Number(input.limit), 200) : 20

    const all = listSkills(ctx.workspaceRoot)
    const filtered = all.filter((s) => {
      if (query) {
        const hay = `${s.name}\n${s.description}\n${s.usage ?? ''}`.toLowerCase()
        if (!hay.includes(query)) return false
      }
      if (tags.length) {
        const skillTags = new Set((s.tags ?? []).map((t) => t.toLowerCase()))
        if (!tags.every((t) => skillTags.has(t))) return false
      }
      return true
    })

    const skills = filtered.slice(0, limit).map((s) => ({
      name: s.name,
      description: s.description,
      usage: s.usage ?? null,
      tags: s.tags ?? [],
      path: s.path,
    }))

    return JSON.stringify({
      skills,
      total: filtered.length,
      shown: skills.length,
      truncated: filtered.length > limit,
      hint: 'Use load_skill(name) to load a skill\'s full content',
    }, null, 2)
  },
}

export const loadSkillTool: ToolDefinition = {
  name: 'load_skill',
  description:
    'Load a skill\'s full instructions. Skills are reusable playbooks (guides, templates, workflows). Load one right before using it.',
  risk: 'low',
  params: { name: 'string (required) — skill name from search_skills or the list in the system prompt' },
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name from search_skills or the system prompt list' },
    },
    required: ['name'],
  },
  async run(input, ctx) {
    const name = String(input.name ?? '')
    if (!name) return 'Error: name is required'
    const body = loadSkill(ctx.workspaceRoot, name)
    if (!body.startsWith('Error:')) recordManualSkillLoad(ctx.sessionId, name)
    return body
  },
}
