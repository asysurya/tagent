import fs from 'node:fs'
import path from 'node:path'
import type { AgentEvents, SkillMeta, TagentConfig } from './types'
import { loadSkill, listSkills, skillState, recordAutoSkills, type LoadedSkill } from './skills'
import { worklogTool } from './tools/worklog'

/**
 * Skill auto-router — proactive skill loading.
 *
 * Before the first turn of a session (and once on a detected topic shift),
 * the router inspects the workspace (package.json deps, files, folders) and
 * the user's message, matches them against skill tags/descriptions, and
 * auto-loads the top skills into context. Rule hits score 0.9, keyword hits
 * 0.5–0.7; below-threshold or empty matches load nothing (no speculation).
 *
 * The user stays in control: /skills lists what is loaded, /unload-skill
 * removes one, /no-auto-skill disables auto-loading, /reload-skills re-runs.
 */

export interface RouteContext {
  userMessage: string
  workspaceRoot: string
  /** prior user messages (max ~5) — context for the router */
  recentHistory?: string[]
  /** skill names already in context — the router skips re-loading these */
  existingLoaded?: string[]
}

export interface RoutedSkill extends SkillMeta {
  matchScore: number // 0..1
  matchReason: string // "rule:next-detected" / "keyword:blog+website" / …
  matchSource: 'rule' | 'keyword'
}

/* ------------------------------------------------------------------ */
/* keyword → tag groups (message words that boost a domain)            */
/* ------------------------------------------------------------------ */

const KEYWORD_GROUPS: { words: string[]; tags: string[] }[] = [
  { words: ['blog', 'website', 'web app', 'landing', 'frontend', 'dashboard', 'web'], tags: ['web', 'frontend'] },
  { words: ['bot', 'discord', 'telegram', 'slack', 'whatsapp'], tags: ['bot', 'discord', 'telegram'] },
  { words: ['cli', 'command line', 'command-line', 'argparse', 'commander', 'terminal tool'], tags: ['cli'] },
  { words: ['api', 'endpoint', 'server', 'rest', 'graphql', 'backend'], tags: ['backend', 'api'] },
  { words: ['pdf', 'docx', 'excel', 'spreadsheet', 'document', 'word'], tags: ['document', 'pdf', 'docx', 'excel'] },
  { words: ['test', 'testing', 'qa', 'verify', 'verification'], tags: ['test', 'qa'] },
  { words: ['review', 'refactor', 'code review', 'clean up'], tags: ['review', 'quality'] },
  { words: ['bug', 'debug', 'broken', 'crash', 'stack trace', 'fix'], tags: ['debug', 'bug'] },
  { words: ['deploy', 'docker', 'devops', 'ci', 'pipeline', 'kubernetes'], tags: ['devops', 'docker'] },
  { words: ['python', 'pypi'], tags: ['python'] },
  { words: ['typescript', 'tsconfig'], tags: ['typescript'] },
]

/* ------------------------------------------------------------------ */
/* rule-based matching — workspace signals                              */
/* ------------------------------------------------------------------ */

interface RuleHit {
  tags: string[]
  reason: string
}

function readJsonSafe(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** dep present in package.json dependencies or devDependencies */
function hasDep(pkgFile: string, dep: string): boolean {
  const pkg = readJsonSafe(pkgFile)
  if (!pkg) return false
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[key]
    if (deps && typeof deps === 'object' && dep in (deps as Record<string, unknown>)) return true
  }
  return false
}

function existsAt(root: string, ...rel: string[]): boolean {
  return fs.existsSync(path.join(root, ...rel))
}

/** Count files with an extension in root/src/app (bounded, non-recursive). */
function countExt(root: string, ext: string): number {
  let n = 0
  for (const dir of [root, path.join(root, 'src'), path.join(root, 'app')]) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith(ext)) n++
      }
    } catch { /* dir absent */ }
  }
  return n
}

function workspaceRuleHits(root: string): RuleHit[] {
  const hits: RuleHit[] = []
  const pkg = path.join(root, 'package.json')

  // package.json dependencies
  if (fs.existsSync(pkg)) {
    if (hasDep(pkg, 'next')) hits.push({ tags: ['web', 'frontend'], reason: 'rule:next-detected' })
    else if (hasDep(pkg, 'react')) hits.push({ tags: ['web', 'frontend'], reason: 'rule:react-detected' })
    else if (hasDep(pkg, 'vue') || hasDep(pkg, 'svelte')) hits.push({ tags: ['web', 'frontend'], reason: 'rule:spa-framework-detected' })
    if (hasDep(pkg, 'discord.js')) hits.push({ tags: ['bot', 'discord'], reason: 'rule:discord.js-detected' })
    if (hasDep(pkg, 'telegraf') || hasDep(pkg, 'grammy')) hits.push({ tags: ['bot', 'telegram'], reason: 'rule:telegram-bot-detected' })
    if (hasDep(pkg, 'express') || hasDep(pkg, 'fastify') || hasDep(pkg, 'hono') || hasDep(pkg, '@nestjs/core')) {
      hits.push({ tags: ['backend', 'api'], reason: 'rule:api-framework-detected' })
    }
  }

  // file existence
  if (existsAt(root, 'Dockerfile')) hits.push({ tags: ['devops', 'docker'], reason: 'rule:dockerfile-present' })
  if (existsAt(root, 'tsconfig.json')) hits.push({ tags: ['typescript'], reason: 'rule:typescript-project' })

  // folder structure
  if (existsAt(root, 'src', 'pages') || existsAt(root, 'app')) hits.push({ tags: ['web', 'frontend'], reason: 'rule:app-router-layout' })
  if (existsAt(root, 'src', 'api') || existsAt(root, 'src', 'server')) hits.push({ tags: ['backend', 'api'], reason: 'rule:server-folders' })

  // language fingerprint (bounded scan)
  if (countExt(root, '.py') >= 3) hits.push({ tags: ['python'], reason: 'rule:python-codebase' })
  if (countExt(root, '.go') >= 3) hits.push({ tags: ['go'], reason: 'rule:go-codebase' })

  return hits
}

/** PRD.md content (≤8k) — domain hints for keyword matching. */
function prdText(root: string): string {
  try {
    return fs.readFileSync(path.join(root, 'PRD.md'), 'utf8').slice(0, 8_000)
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ */
/* the router                                                          */
/* ------------------------------------------------------------------ */

/**
 * Match skills to a task context. Rule hits (workspace signals) score 0.9;
 * keyword hits score 0.5 + 0.1 per extra group (cap 0.7). Below-threshold
 * scores are dropped, the rest sorted (score desc, name asc) and capped.
 */
export function routeSkills(ctx: RouteContext, opts?: {
  max?: number
  threshold?: number
}): RoutedSkill[] {
  const skills = listSkills(ctx.workspaceRoot)
  if (!skills.length) return []
  const max = opts?.max ?? 3
  const threshold = opts?.threshold ?? 0.5

  const ruleHits = workspaceRuleHits(ctx.workspaceRoot)
  const scanText = `${ctx.userMessage}\n${prdText(ctx.workspaceRoot)}`.toLowerCase()

  // detect which keyword groups fired (and with which words)
  const keywordHits: { words: string[]; tags: string[] }[] = []
  for (const g of KEYWORD_GROUPS) {
    const words = g.words.filter((w) => scanText.includes(w))
    if (words.length) keywordHits.push({ words, tags: g.tags })
  }

  const scored = new Map<string, RoutedSkill>()
  for (const s of skills) {
    const skillTags = new Set(s.tags ?? [])
    const skillText = `${s.name}\n${s.description}\n${s.usage ?? ''}`.toLowerCase()

    // (1) rule-based — workspace signals beat message wording
    let rule: RuleHit | undefined
    for (const h of ruleHits) {
      if (h.tags.some((t) => skillTags.has(t))) {
        rule = h
        break
      }
    }

    // (2) keyword-based — tags OR direct text overlap
    const matchedWords: string[] = []
    let groups = 0
    for (const h of keywordHits) {
      const tagHit = h.tags.some((t) => skillTags.has(t))
      const textHit = h.words.some((w) => skillText.includes(w))
      if (tagHit || textHit) {
        groups++
        matchedWords.push(...h.words)
      }
    }

    let score = 0
    let reason = ''
    let source: 'rule' | 'keyword' = 'keyword'
    if (rule) {
      score = 0.9
      reason = rule.reason
      source = 'rule'
    }
    if (groups > 0) {
      const kScore = Math.min(0.5 + 0.1 * (groups - 1), 0.7)
      if (kScore > score) {
        score = kScore
        reason = `keyword:${[...new Set(matchedWords)].slice(0, 4).join('+')}`
        source = 'keyword'
      } else if (rule) {
        // rule won, but note the keyword corroboration
        reason = `${reason},${[...new Set(matchedWords)].slice(0, 2).join('+')}`
      }
    }
    if (score <= 0) continue

    scored.set(s.name, {
      ...s,
      matchScore: Math.round(score * 100) / 100,
      matchReason: reason,
      matchSource: source,
    })
  }

  return [...scored.values()]
    .filter((s) => s.matchScore >= threshold)
    .sort((a, b) => b.matchScore! - a.matchScore! || a.name.localeCompare(b.name))
    .slice(0, max)
}

/* ------------------------------------------------------------------ */
/* loop integration                                                     */
/* ------------------------------------------------------------------ */

export interface AutoRouteCall {
  sessionId: string
  workspaceRoot: string
  userText: string
  /** prior real user messages (topic-shift detection + router context) */
  priorUserMessages: string[]
  config: TagentConfig
  events?: AgentEvents
}

/** Token overlap heuristic — <20% shared tokens vs the last messages = new topic. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'this', 'that',
  'dan', 'yang', 'untuk', 'dengan', 'di', 'ke', 'ini', 'itu', 'saya', 'aku', 'kita', 'we', 'i',
  'make', 'create', 'build', 'add', 'bikin', 'buat', 'tambah', 'please', 'tolong', 'sekarang', 'now',
])
function topicTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  )
}
function isTopicShift(newText: string, priorTexts: string[]): boolean {
  const fresh = topicTokens(newText)
  if (!fresh.size) return false
  const prior = topicTokens(priorTexts.slice(-3).join(' '))
  if (!prior.size) return true
  let shared = 0
  for (const w of fresh) if (prior.has(w)) shared++
  return shared / fresh.size < 0.2
}

/** Cap an auto-loaded body at ~8k chars, cutting at a paragraph boundary. */
export function capAutoBody(body: string, max = 8_000): string {
  if (body.length <= max) return body
  const cut = body.lastIndexOf('\n\n', max)
  const head = cut > max * 0.5 ? body.slice(0, cut) : body.slice(0, max)
  return `${head}\n\n(skill auto-loaded as an excerpt — load_skill returns the full text)`
}

/**
 * The loop's hook — runs before the first turn of every primary-agent run:
 * session start (initial route) or a detected topic shift (1 re-route max).
 * Loads the matched skill bodies into the session's context registry, logs
 * the worklog entry, and returns the transparency notice for the host to
 * display (null when nothing was loaded).
 */
export function maybeAutoRouteSkills(call: AutoRouteCall): string | null {
  const st = skillState(call.sessionId)
  if (st.routingDisabled) return null
  if (call.config.skills?.autoRoute === false) return null

  if (st.routed) {
    // one topic-shift re-route per session, manual /reload-skills aside
    if (st.reroutes >= 1) return null
    if (!isTopicShift(call.userText, call.priorUserMessages)) return null
    st.lastText = call.userText
    // the budget only counts re-routes that actually loaded something — a
    // detected "shift" that maps to no new skill burns nothing
    const note = loadRoutedSkills(call)
    if (note) st.reroutes++
    return note
  }
  st.routed = true
  st.lastText = call.userText

  return loadRoutedSkills(call)
}

/** /reload-skills — explicit re-route, ignores the session disable flag
 *  (it is a manual action; automatic routing stays off if disabled). */
export function rerunSkillRouter(call: Omit<AutoRouteCall, 'priorUserMessages'>): string | null {
  const st = skillState(call.sessionId)
  st.lastText = call.userText
  if (!st.routed) st.routed = true
  return loadRoutedSkills(call)
}

/** shared loader: route → load bodies → record → worklog → notice */
function loadRoutedSkills(call: AutoRouteCall | Omit<AutoRouteCall, 'priorUserMessages'>): string | null {
  const st = skillState(call.sessionId)
  const already = new Set([...st.auto.map((s) => s.name), ...st.manual])
  const routed = routeSkills(
    {
      userMessage: call.userText,
      workspaceRoot: call.workspaceRoot,
      existingLoaded: [...already],
    },
    {
      max: call.config.skills?.autoRouteMax ?? 3,
      threshold: call.config.skills?.autoRouteThreshold ?? 0.5,
    },
  ).filter((r) => !already.has(r.name))
  if (!routed.length) return null

  const loaded: LoadedSkill[] = []
  for (const r of routed) {
    const body = loadSkill(call.workspaceRoot, r.name)
    if (body.startsWith('Error:')) continue
    loaded.push({ ...r, body: capAutoBody(body) })
  }
  if (!loaded.length) return null
  recordAutoSkills(call.sessionId, loaded)

  // transparency — the worklog journal gets the same story
  const reasons = loaded.map((s) => `${s.name} (score ${s.matchScore}, ${s.matchReason})`).join(', ')
  if (call.config.worklog?.enabled !== false) {
    void worklogTool.run(
      { entry: `[auto-router] Auto-loaded: ${reasons}` },
      {
        workspaceRoot: call.workspaceRoot,
        sessionId: call.sessionId,
        depth: 0,
        config: call.config,
        events: {},
        todos: [],
      },
    )
  }

  const taskPreview = call.userText.replace(/\s+/g, ' ').slice(0, 60)
  return [
    `🎯 Auto-loaded skills: ${loaded.map((s) => s.name).join(', ')}`,
    `   (matched: user task "${taskPreview}" — ${reasons})`,
    `   /skills lists them · /no-auto-skill disables · /unload-skill <name> removes`,
  ].join('\n')
}
